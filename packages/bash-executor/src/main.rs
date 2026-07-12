use std::{
    env,
    io::{self, BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};

const OUTPUT_CHANNEL_CAPACITY: usize = 16;
const MAX_COMMAND_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
struct ExecuteRequest {
    op: String,
    command: String,
    cwd: String,
    interactive_stdio: bool,
}

#[derive(Deserialize)]
struct ControlRequest {
    op: String,
    #[serde(default)]
    data: Option<String>,
}

#[derive(Serialize)]
struct OutputEvent {
    op: &'static str,
    data: String,
}

#[derive(Serialize)]
struct CompletedEvent {
    op: &'static str,
    exit_code: Option<i32>,
}

#[derive(Serialize)]
struct ErrorEvent<'a> {
    op: &'static str,
    message: &'a str,
}

enum Control {
    Stdin(Vec<u8>),
    Cancel,
    Disconnected,
}

fn main() {
    let listen = match parse_listen(env::args().skip(1)) {
        Ok(addr) => addr,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let listener = match TcpListener::bind(listen) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("failed to bind bash executor at {listen}: {error}");
            std::process::exit(2);
        }
    };
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => { thread::spawn(|| { let _ = handle_connection(stream); }); }
            Err(error) => eprintln!("bash executor accept failed: {error}"),
        }
    }
}

fn parse_listen(args: impl Iterator<Item = String>) -> Result<SocketAddr, String> {
    let args = args.collect::<Vec<_>>();
    if args.len() != 2 || args[0] != "--listen" {
        return Err("usage: bash-executor --listen 127.0.0.1:3110".to_owned());
    }
    let addr = args[1].parse::<SocketAddr>().map_err(|error| format!("invalid listen address: {error}"))?;
    if !addr.ip().is_loopback() { return Err("bash executor listen address must be loopback-only".to_owned()); }
    Ok(addr)
}

fn handle_connection(stream: TcpStream) -> io::Result<()> {
    handle_connection_with_output_limit(stream, MAX_COMMAND_OUTPUT_BYTES)
}

fn handle_connection_with_output_limit(stream: TcpStream, output_limit: usize) -> io::Result<()> {
    let reader_stream = stream.try_clone()?;
    let writer = Arc::new(Mutex::new(stream));
    let mut reader = BufReader::new(reader_stream);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 { return Ok(()); }
    let request: ExecuteRequest = match serde_json::from_str::<ExecuteRequest>(line.trim_end()) {
        Ok(request) if request.op == "execute" => request,
        Ok(_) => { write_event(&writer, &ErrorEvent { op: "error", message: "first executor frame must be execute" })?; return Ok(()); }
        Err(_) => { write_event(&writer, &ErrorEvent { op: "error", message: "invalid executor request" })?; return Ok(()); }
    };
    let (control_tx, control_rx) = mpsc::channel();
    thread::spawn(move || read_controls(reader, control_tx));

    let mut child = Command::new("bash");
    child.arg("-lc").arg(format!("exec 2>&1\n{}", request.command)).current_dir(request.cwd)
        .stdin(if request.interactive_stdio { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped()).env_clear();
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; child.process_group(0); }
    for (key, value) in env::vars_os() {
        if key == "PATH" || key == "HOME" || key == "TERM" || key == "LANG" || key == "LC_ALL" { child.env(key, value); }
    }
    let mut child = match child.spawn() {
        Ok(child) => child,
        Err(error) => { write_event(&writer, &ErrorEvent { op: "error", message: "failed to spawn bash" })?; return Err(error); }
    };
    let stdin = child.stdin.take().map(Mutex::new);
    let (output_tx, output_rx) = mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
    if let Some(stdout) = child.stdout.take() { spawn_output_reader(stdout, output_tx.clone()); }
    if let Some(stderr) = child.stderr.take() { spawn_output_reader(stderr, output_tx.clone()); }
    drop(output_tx);

    let mut cancel = false;
    let mut output_bytes = 0_usize;
    let mut output_limit_exceeded = false;
    loop {
        while let Ok(chunk) = output_rx.try_recv() {
            output_bytes = output_bytes.saturating_add(chunk.len());
            if output_bytes > output_limit {
                if !output_limit_exceeded {
                    output_limit_exceeded = true;
                    cancel = true;
                    kill_child(&mut child);
                    let message = format!("command output exceeded cumulative limit of {output_limit} bytes");
                    write_event(&writer, &ErrorEvent {
                        op: "error",
                        message: &message,
                    })?;
                }
                continue;
            }
            write_event(&writer, &OutputEvent { op: "output", data: BASE64.encode(chunk) })?;
        }
        if !cancel {
            match control_rx.try_recv() {
                Ok(Control::Stdin(bytes)) => {
                    if let Some(stdin) = &stdin { let mut stdin = stdin.lock().map_err(|_| io::Error::other("bash stdin lock poisoned"))?; stdin.write_all(&bytes)?; stdin.flush()?; }
                }
                Ok(Control::Cancel) | Ok(Control::Disconnected) => { cancel = true; kill_child(&mut child); }
                Err(mpsc::TryRecvError::Disconnected) => { cancel = true; kill_child(&mut child); }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if let Some(status) = child.try_wait()? {
            while let Ok(chunk) = output_rx.recv_timeout(std::time::Duration::from_millis(10)) {
                output_bytes = output_bytes.saturating_add(chunk.len());
                if output_bytes <= output_limit {
                    write_event(&writer, &OutputEvent { op: "output", data: BASE64.encode(chunk) })?;
                } else if !output_limit_exceeded {
                    output_limit_exceeded = true;
                    kill_child(&mut child);
                    let message = format!("command output exceeded cumulative limit of {output_limit} bytes");
                    write_event(&writer, &ErrorEvent {
                        op: "error",
                        message: &message,
                    })?;
                }
            }
            write_event(&writer, &CompletedEvent {
                op: "completed",
                exit_code: if output_limit_exceeded { None } else { status.code() },
            })?;
            break;
        }
        thread::sleep(std::time::Duration::from_millis(5));
    }
    Ok(())
}

fn read_controls(mut reader: BufReader<TcpStream>, sender: mpsc::Sender<Control>) {
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => { let _ = sender.send(Control::Disconnected); return; }
            Ok(_) => match serde_json::from_str::<ControlRequest>(line.trim_end()) {
                Ok(request) if request.op == "stdin" => match request.data.and_then(|data| BASE64.decode(data).ok()) { Some(bytes) => { let _ = sender.send(Control::Stdin(bytes)); }, None => { let _ = sender.send(Control::Cancel); } },
                Ok(request) if request.op == "cancel" => { let _ = sender.send(Control::Cancel); }
                _ => { let _ = sender.send(Control::Cancel); }
            }
        }
    }
}

fn spawn_output_reader(mut reader: impl Read + Send + 'static, sender: mpsc::SyncSender<Vec<u8>>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(read) => if sender.send(buffer[..read].to_vec()).is_err() { return; },
            }
        }
    });
}

fn write_event<T: Serialize>(writer: &Arc<Mutex<TcpStream>>, event: &T) -> io::Result<()> {
    let mut writer = writer.lock().map_err(|_| io::Error::other("executor writer lock poisoned"))?;
    serde_json::to_writer(&mut *writer, event).map_err(io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn kill_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    { unsafe extern "C" { fn kill(pid: i32, sig: i32) -> i32; } unsafe { kill(-(child.id() as i32), 9); } }
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::{handle_connection, handle_connection_with_output_limit, parse_listen};
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    #[test]
    fn accepts_only_loopback_listen_addresses() {
        assert_eq!(
            parse_listen(["--listen".to_owned(), "127.0.0.1:3110".to_owned()].into_iter())
                .expect("loopback address should parse")
                .to_string(),
            "127.0.0.1:3110"
        );
        assert!(parse_listen(["--listen".to_owned(), "0.0.0.0:3110".to_owned()].into_iter()).is_err());
    }

    #[test]
    fn executes_ndjson_request_and_returns_output_and_completion() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            handle_connection(stream).expect("executor connection should succeed");
        });
        let mut stream = TcpStream::connect(addr).expect("client should connect");
        writeln!(stream, r#"{{"op":"execute","command":"printf sidecar-output","cwd":".","interactive_stdio":false}}"#)
            .expect("execute request should write");
        let mut reader = BufReader::new(stream);
        let mut output = String::new();
        reader.read_line(&mut output).expect("output event should read");
        let mut completed = String::new();
        reader.read_line(&mut completed).expect("completion event should read");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(output.trim_end()).expect("output event should be JSON")["data"],
            "c2lkZWNhci1vdXRwdXQ="
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(completed.trim_end()).expect("completion event should be JSON")["exit_code"],
            0
        );
        server.join().expect("executor server should finish");
    }

    #[test]
    fn terminates_commands_that_exceed_the_cumulative_output_limit() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            handle_connection_with_output_limit(stream, 16).expect("executor connection should succeed");
        });
        let mut stream = TcpStream::connect(addr).expect("client should connect");
        writeln!(stream, r#"{{"op":"execute","command":"printf 12345678901234567; sleep 30","cwd":".","interactive_stdio":false}}"#)
            .expect("execute request should write");
        let mut reader = BufReader::new(stream);
        let mut events = Vec::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("event should read");
            let event = serde_json::from_str::<serde_json::Value>(line.trim_end()).expect("event should be JSON");
            let completed = event["op"] == "completed";
            events.push(event);
            if completed { break; }
        }
        assert!(events.iter().any(|event| {
            event["op"] == "error"
                && event["message"] == "command output exceeded cumulative limit of 16 bytes"
        }));
        assert_eq!(events.last().expect("completion event")["op"], "completed");
        assert_eq!(events.last().expect("completion event")["exit_code"], serde_json::Value::Null);
        server.join().expect("executor server should finish");
    }
}
