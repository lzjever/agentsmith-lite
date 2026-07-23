use std::{
    env,
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};

const OUTPUT_CHANNEL_CAPACITY: usize = 16;
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(5);
const POST_EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(50);

#[derive(Deserialize)]
struct ExecuteRequest {
    op: String,
    mode: ExecutionMode,
    command: String,
    cwd: String,
    interactive_stdio: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExecutionMode {
    Tool,
    Terminal,
}

#[derive(Deserialize)]
struct ControlRequest {
    op: String,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    rows: Option<u16>,
    #[serde(default)]
    cols: Option<u16>,
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
    Resize { rows: u16, cols: u16 },
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
            Ok(stream) => {
                thread::spawn(|| {
                    let _ = handle_connection(stream);
                });
            }
            Err(error) => eprintln!("bash executor accept failed: {error}"),
        }
    }
}

fn parse_listen(args: impl Iterator<Item = String>) -> Result<SocketAddr, String> {
    let args = args.collect::<Vec<_>>();
    if args.len() != 2 || args[0] != "--listen" {
        return Err("usage: bash-executor --listen 127.0.0.1:3110".to_owned());
    }
    let addr = args[1]
        .parse::<SocketAddr>()
        .map_err(|error| format!("invalid listen address: {error}"))?;
    if !addr.ip().is_loopback() {
        return Err("bash executor listen address must be loopback-only".to_owned());
    }
    Ok(addr)
}

fn handle_connection(stream: TcpStream) -> io::Result<()> {
    let shutdown = ConnectionShutdown(stream.try_clone()?);
    let result = handle_connection_inner(stream);
    drop(shutdown);
    result
}

fn handle_connection_inner(stream: TcpStream) -> io::Result<()> {
    let reader_stream = stream.try_clone()?;
    let writer = Arc::new(Mutex::new(stream));
    let mut reader = BufReader::new(reader_stream);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    let request: ExecuteRequest = match serde_json::from_str::<ExecuteRequest>(line.trim_end()) {
        Ok(request) if request.op == "execute" => request,
        Ok(_) => {
            write_event(
                &writer,
                &ErrorEvent {
                    op: "error",
                    message: "first executor frame must be execute",
                },
            )?;
            return Ok(());
        }
        Err(_) => {
            write_event(
                &writer,
                &ErrorEvent {
                    op: "error",
                    message: "invalid executor request",
                },
            )?;
            return Ok(());
        }
    };
    let (control_tx, control_rx) = mpsc::channel();
    thread::spawn(move || read_controls(reader, control_tx));
    match request.mode {
        ExecutionMode::Tool => handle_tool(request, writer, control_rx),
        ExecutionMode::Terminal => handle_terminal(request, writer, control_rx),
    }
}

fn handle_tool(
    request: ExecuteRequest,
    writer: Arc<Mutex<TcpStream>>,
    control_rx: mpsc::Receiver<Control>,
) -> io::Result<()> {
    let mut command = Command::new("bash");
    command
        .arg("-lc")
        .arg(request.command)
        .current_dir(request.cwd)
        .stdin(if request.interactive_stdio {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    inherit_safe_environment(&mut command);

    let mut child = ToolChildGuard::spawn(command)?;
    let mut input = child.child_mut().stdin.take();
    let stdout = child
        .child_mut()
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("failed to capture tool stdout"))?;
    let stderr = child
        .child_mut()
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("failed to capture tool stderr"))?;
    let (output_tx, output_rx) = mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
    spawn_output_reader(stdout, output_tx.clone());
    spawn_output_reader(stderr, output_tx.clone());
    drop(output_tx);

    loop {
        let mut made_progress = false;
        while let Ok(chunk) = output_rx.try_recv() {
            made_progress = true;
            write_output_event(&writer, chunk)?;
        }
        match control_rx.try_recv() {
            Ok(Control::Stdin(bytes)) => {
                if let Some(input) = input.as_mut() {
                    input.write_all(&bytes)?;
                    input.flush()?;
                }
            }
            Ok(Control::Cancel)
            | Ok(Control::Disconnected)
            | Ok(Control::Resize { .. })
            | Err(mpsc::TryRecvError::Disconnected) => child.kill_group(),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if let Some(status) = child.try_wait()? {
            drain_output_after_exit(&writer, &output_rx, &mut child)?;
            write_event(
                &writer,
                &CompletedEvent {
                    op: "completed",
                    exit_code: status.code(),
                },
            )?;
            return Ok(());
        }
        if !made_progress {
            thread::sleep(WAIT_POLL_INTERVAL);
        }
    }
}

fn handle_terminal(
    request: ExecuteRequest,
    writer: Arc<Mutex<TcpStream>>,
    control_rx: mpsc::Receiver<Control>,
) -> io::Result<()> {
    let pty = native_pty_system();
    let pair = match pty.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(error) => {
            write_event(
                &writer,
                &ErrorEvent {
                    op: "error",
                    message: "failed to allocate terminal",
                },
            )?;
            return Err(io::Error::other(error));
        }
    };
    let mut command = CommandBuilder::new("bash");
    command.arg("-lc");
    command.arg(request.command);
    command.cwd(request.cwd);
    command.env_clear();
    for (key, value) in env::vars_os() {
        if key == "PATH" || key == "HOME" || key == "TERM" || key == "LANG" || key == "LC_ALL" {
            command.env(key, value);
        }
    }
    command.env(
        "TERM",
        env::var_os("TERM").unwrap_or_else(|| "xterm-256color".into()),
    );
    let child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => {
            write_event(
                &writer,
                &ErrorEvent {
                    op: "error",
                    message: "failed to spawn bash",
                },
            )?;
            return Err(io::Error::other(error));
        }
    };
    let mut child = PtyChildGuard::new(child);
    drop(pair.slave);
    let terminal_input = Mutex::new(pair.master.take_writer().map_err(io::Error::other)?);
    let (output_tx, output_rx) = mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
    spawn_output_reader(
        pair.master.try_clone_reader().map_err(io::Error::other)?,
        output_tx.clone(),
    );
    drop(output_tx);

    loop {
        while let Ok(chunk) = output_rx.try_recv() {
            write_output_event(&writer, chunk)?;
        }
        match control_rx.try_recv() {
            Ok(Control::Stdin(bytes)) => {
                let mut input = terminal_input
                    .lock()
                    .map_err(|_| io::Error::other("terminal input lock poisoned"))?;
                input.write_all(&bytes)?;
                input.flush()?;
            }
            Ok(Control::Resize { rows, cols }) => {
                pair.master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(io::Error::other)?;
            }
            Ok(Control::Cancel)
            | Ok(Control::Disconnected)
            | Err(mpsc::TryRecvError::Disconnected) => {
                child.kill_group();
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if let Some(status) = child.try_wait()? {
            let deadline = Instant::now() + POST_EXIT_DRAIN_TIMEOUT;
            while Instant::now() < deadline {
                match output_rx.recv_timeout(WAIT_POLL_INTERVAL) {
                    Ok(chunk) => write_output_event(&writer, chunk)?,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
            write_event(
                &writer,
                &CompletedEvent {
                    op: "completed",
                    exit_code: Some(status.exit_code() as i32),
                },
            )?;
            return Ok(());
        }
        thread::sleep(WAIT_POLL_INTERVAL);
    }
}

struct ConnectionShutdown(TcpStream);

impl Drop for ConnectionShutdown {
    fn drop(&mut self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

struct ToolChildGuard {
    child: Child,
    process_group_id: u32,
    armed: bool,
    kill_sent: bool,
    #[cfg(test)]
    kill_attempts: Arc<std::sync::atomic::AtomicUsize>,
}

impl ToolChildGuard {
    fn spawn(mut command: Command) -> io::Result<Self> {
        #[cfg(unix)]
        command.process_group(0);
        let child = command.spawn()?;
        let process_group_id = child.id();
        Ok(Self {
            child,
            process_group_id,
            armed: true,
            kill_sent: false,
            #[cfg(test)]
            kill_attempts: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        })
    }

    fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    fn kill_group(&mut self) {
        if !self.armed || self.kill_sent {
            return;
        }
        self.kill_sent = true;
        #[cfg(test)]
        self.kill_attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        kill_process_group(self.process_group_id);
        let _ = self.child.kill();
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    fn finish(&mut self) {
        self.disarm();
    }

    #[cfg(test)]
    fn kill_attempts(&self) -> Arc<std::sync::atomic::AtomicUsize> {
        self.kill_attempts.clone()
    }

    fn terminate_and_reap(&mut self) {
        if !self.armed {
            return;
        }
        self.kill_group();
        let _ = self.child.wait();
        self.disarm();
    }
}

impl Drop for ToolChildGuard {
    fn drop(&mut self) {
        self.terminate_and_reap();
    }
}

struct PtyChildGuard {
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl PtyChildGuard {
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        Self { child }
    }

    fn try_wait(&mut self) -> io::Result<Option<portable_pty::ExitStatus>> {
        self.child.try_wait().map_err(io::Error::other)
    }

    fn kill_group(&mut self) {
        kill_child(&mut self.child);
    }
}

impl Drop for PtyChildGuard {
    fn drop(&mut self) {
        self.kill_group();
        let _ = self.child.wait();
    }
}

fn inherit_safe_environment(command: &mut Command) {
    for (key, value) in env::vars_os() {
        if key == "PATH" || key == "HOME" || key == "TERM" || key == "LANG" || key == "LC_ALL" {
            command.env(key, value);
        }
    }
}

fn write_output_event(writer: &Arc<Mutex<TcpStream>>, chunk: Vec<u8>) -> io::Result<()> {
    write_event(
        writer,
        &OutputEvent {
            op: "output",
            data: BASE64.encode(chunk),
        },
    )
}

fn drain_output_after_exit(
    writer: &Arc<Mutex<TcpStream>>,
    output_rx: &mpsc::Receiver<Vec<u8>>,
    child: &mut ToolChildGuard,
) -> io::Result<()> {
    let deadline = Instant::now() + POST_EXIT_DRAIN_TIMEOUT;
    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let remaining = deadline.saturating_duration_since(now);
        match output_rx.recv_timeout(remaining.min(WAIT_POLL_INTERVAL)) {
            Ok(chunk) => write_output_event(writer, chunk)?,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                child.finish();
                return Ok(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }

    child.kill_group();
    while let Ok(chunk) = output_rx.recv() {
        write_output_event(writer, chunk)?;
    }
    child.finish();
    Ok(())
}

fn read_controls(mut reader: BufReader<TcpStream>, sender: mpsc::Sender<Control>) {
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => {
                let _ = sender.send(Control::Disconnected);
                return;
            }
            Ok(_) => match serde_json::from_str::<ControlRequest>(line.trim_end()) {
                Ok(request) if request.op == "stdin" => {
                    match request.data.and_then(|data| BASE64.decode(data).ok()) {
                        Some(bytes) => {
                            let _ = sender.send(Control::Stdin(bytes));
                        }
                        None => {
                            let _ = sender.send(Control::Cancel);
                        }
                    }
                }
                Ok(request) if request.op == "resize" => match (request.rows, request.cols) {
                    (Some(rows), Some(cols)) if rows > 0 && cols > 0 => {
                        let _ = sender.send(Control::Resize { rows, cols });
                    }
                    _ => {
                        let _ = sender.send(Control::Cancel);
                    }
                },
                Ok(request) if request.op == "cancel" => {
                    let _ = sender.send(Control::Cancel);
                }
                _ => {
                    let _ = sender.send(Control::Cancel);
                }
            },
        }
    }
}

fn spawn_output_reader(mut reader: impl Read + Send + 'static, sender: mpsc::SyncSender<Vec<u8>>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(read) => {
                    if sender.send(buffer[..read].to_vec()).is_err() {
                        return;
                    }
                }
            }
        }
    });
}

fn write_event<T: Serialize>(writer: &Arc<Mutex<TcpStream>>, event: &T) -> io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("executor writer lock poisoned"))?;
    serde_json::to_writer(&mut *writer, event).map_err(io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn kill_child(child: &mut Box<dyn portable_pty::Child + Send + Sync>) {
    #[cfg(unix)]
    if let Some(pid) = child.process_id() {
        if unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) } == 0 {
            return;
        }
    }

    let _ = child.kill();
}

fn kill_process_group(process_group_id: u32) {
    #[cfg(unix)]
    unsafe {
        let _ = libc::kill(-(process_group_id as libc::pid_t), libc::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        drain_output_after_exit, handle_connection, parse_listen, spawn_output_reader,
        ToolChildGuard, OUTPUT_CHANNEL_CAPACITY, WAIT_POLL_INTERVAL,
    };
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use std::fs;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    fn unique_marker_path() -> std::path::PathBuf {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "agentsmith-bash-executor-{}-{}.marker",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
    }

    fn run_post_exit_case(command_text: &str) -> (Vec<u8>, usize, Duration) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let client = TcpStream::connect(addr).expect("client should connect");
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("client read timeout should set");
        let (server, _) = listener.accept().expect("server should accept");
        let writer = std::sync::Arc::new(std::sync::Mutex::new(server));

        let mut command = std::process::Command::new("bash");
        command
            .arg("-lc")
            .arg(command_text)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = ToolChildGuard::spawn(command).expect("tool process should spawn");
        let kill_attempts = child.kill_attempts();
        let stdout = child
            .child_mut()
            .stdout
            .take()
            .expect("stdout should be piped");
        let stderr = child
            .child_mut()
            .stderr
            .take()
            .expect("stderr should be piped");
        let (output_tx, output_rx) = std::sync::mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
        spawn_output_reader(stdout, output_tx.clone());
        spawn_output_reader(stderr, output_tx.clone());
        drop(output_tx);

        while child
            .try_wait()
            .expect("leader status should be readable")
            .is_none()
        {
            thread::sleep(WAIT_POLL_INTERVAL);
        }
        let drain_started = Instant::now();
        drain_output_after_exit(&writer, &output_rx, &mut child)
            .expect("post-exit output should drain");
        let drain_elapsed = drain_started.elapsed();
        drop(child);
        drop(writer);

        let mut output = Vec::new();
        let mut reader = BufReader::new(client);
        loop {
            let mut line = String::new();
            if reader
                .read_line(&mut line)
                .expect("output event should read")
                == 0
            {
                break;
            }
            let event = serde_json::from_str::<serde_json::Value>(line.trim_end())
                .expect("output event should be JSON");
            if event["op"] == "output" {
                output.extend(
                    BASE64
                        .decode(event["data"].as_str().expect("output data"))
                        .expect("output should be base64"),
                );
            }
        }
        (output, kill_attempts.load(Ordering::SeqCst), drain_elapsed)
    }

    #[test]
    fn accepts_only_loopback_listen_addresses() {
        assert_eq!(
            parse_listen(["--listen".to_owned(), "127.0.0.1:3110".to_owned()].into_iter())
                .expect("loopback address should parse")
                .to_string(),
            "127.0.0.1:3110"
        );
        assert!(
            parse_listen(["--listen".to_owned(), "0.0.0.0:3110".to_owned()].into_iter()).is_err()
        );
    }

    #[test]
    fn tool_mode_uses_pipes_and_returns_output_and_completion() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            handle_connection(stream).expect("executor connection should succeed");
        });
        let mut stream = TcpStream::connect(addr).expect("client should connect");
        writeln!(stream, r#"{{"op":"execute","mode":"tool","command":"if [ -t 1 ]; then printf tty; else printf pipe; fi","cwd":".","interactive_stdio":false}}"#)
            .expect("execute request should write");
        let mut reader = BufReader::new(stream);
        let mut output = String::new();
        reader
            .read_line(&mut output)
            .expect("output event should read");
        let mut completed = String::new();
        reader
            .read_line(&mut completed)
            .expect("completion event should read");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(output.trim_end())
                .expect("output event should be JSON")["data"],
            "cGlwZQ=="
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(completed.trim_end())
                .expect("completion event should be JSON")["exit_code"],
            0
        );
        server.join().expect("executor server should finish");
    }

    #[test]
    fn cancel_terminates_the_entire_tool_process_group() {
        let marker_path = unique_marker_path();
        let _ = fs::remove_file(&marker_path);
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            handle_connection(stream).expect("executor connection should succeed");
        });
        let mut stream = TcpStream::connect(addr).expect("client should connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout should set");
        let command = format!("sleep 3; touch {}", shell_quote(&marker_path));
        let execute = serde_json::json!({
            "op": "execute",
            "mode": "tool",
            "command": command,
            "cwd": ".",
            "interactive_stdio": false,
        });
        writeln!(stream, "{execute}").expect("execute request should write");

        thread::sleep(Duration::from_millis(100));
        let mut reader = BufReader::new(stream.try_clone().expect("client stream should clone"));
        let cancel_started = Instant::now();
        writeln!(stream, r#"{{"op":"cancel"}}"#).expect("cancel request should write");
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .expect("completion event should read");
            if line.is_empty() {
                break;
            }
            let event = serde_json::from_str::<serde_json::Value>(line.trim_end())
                .expect("completion event should be JSON");
            if event["op"] == "completed" {
                break;
            }
        }
        assert!(
            cancel_started.elapsed() < Duration::from_secs(1),
            "cancel should complete promptly"
        );
        server.join().expect("executor server should finish");

        thread::sleep(Duration::from_millis(3200));
        assert!(
            !marker_path.exists(),
            "cancelled descendant must not write its delayed marker"
        );
        let _ = fs::remove_file(marker_path);
    }

    #[test]
    fn provides_an_interactive_pty_shell() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            handle_connection(stream).expect("executor connection should succeed");
        });
        let mut stream = TcpStream::connect(addr).expect("client should connect");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .expect("read timeout should set");
        writeln!(
            stream,
            r#"{{"op":"execute","mode":"terminal","command":"exec bash -il","cwd":".","interactive_stdio":true}}"#
        )
        .expect("execute request should write");
        writeln!(stream, r#"{{"op":"resize","rows":31,"cols":97}}"#)
            .expect("resize request should write");
        let input = BASE64.encode("printf PTY_READY; exit\n");
        writeln!(stream, "{{\"op\":\"stdin\",\"data\":\"{input}\"}}")
            .expect("stdin request should write");

        let mut reader = BufReader::new(stream);
        let mut output = Vec::new();
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .expect("terminal event should read");
            let event = serde_json::from_str::<serde_json::Value>(line.trim_end())
                .expect("terminal event should be JSON");
            if event["op"] == "output" {
                output.extend(
                    BASE64
                        .decode(event["data"].as_str().expect("output data"))
                        .expect("output should be base64"),
                );
            }
            if event["op"] == "completed" {
                break;
            }
        }
        assert!(String::from_utf8_lossy(&output).contains("PTY_READY"));
        let mut eof = String::new();
        assert_eq!(
            reader
                .read_line(&mut eof)
                .expect("terminal connection should close after completion"),
            0
        );
        server.join().expect("server should finish");
    }

    #[test]
    fn output_over_sixteen_mib_completes_without_sidecar_termination() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            handle_connection(stream).expect("executor connection should succeed");
        });
        let mut stream = TcpStream::connect(addr).expect("client should connect");
        writeln!(stream, r#"{{"op":"execute","mode":"tool","command":"head -c 16777217 /dev/zero","cwd":".","interactive_stdio":false}}"#)
            .expect("execute request should write");
        let mut reader = BufReader::new(stream);
        let mut output_bytes = 0_usize;
        let completed;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("event should read");
            let event = serde_json::from_str::<serde_json::Value>(line.trim_end())
                .expect("event should be JSON");
            if event["op"] == "output" {
                output_bytes += BASE64
                    .decode(event["data"].as_str().expect("output data"))
                    .expect("output should be base64")
                    .len();
            }
            if event["op"] == "completed" {
                completed = event;
                break;
            }
        }
        assert_eq!(output_bytes, 16 * 1024 * 1024 + 1);
        assert_eq!(completed["exit_code"], 0);
        server.join().expect("executor server should finish");
    }

    #[test]
    fn client_disconnect_kills_and_reaps_the_command_group() {
        let marker_path = unique_marker_path();
        let _ = fs::remove_file(&marker_path);
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            let _ = handle_connection(stream);
        });
        let mut stream = TcpStream::connect(addr).expect("client should connect");
        let command = format!(
            "(sleep 2; touch {}) & while :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done",
            shell_quote(&marker_path)
        );
        writeln!(
            stream,
            "{}",
            serde_json::json!({
                "op": "execute",
                "mode": "tool",
                "command": command,
                "cwd": ".",
                "interactive_stdio": false,
            })
        )
        .expect("execute request should write");
        let mut reader = BufReader::new(stream);
        let mut first = String::new();
        reader
            .read_line(&mut first)
            .expect("first output event should read");
        drop(reader);
        server
            .join()
            .expect("executor handler should return after disconnect");

        thread::sleep(Duration::from_millis(2300));
        assert!(
            !marker_path.exists(),
            "disconnected command descendants must be killed"
        );
        let _ = fs::remove_file(marker_path);
    }

    #[test]
    fn dropping_tool_child_guard_kills_and_reaps_the_process_group() {
        let marker_path = unique_marker_path();
        let _ = fs::remove_file(&marker_path);
        let mut command = std::process::Command::new("bash");
        command
            .arg("-lc")
            .arg(format!("sleep 2; touch {}", shell_quote(&marker_path)))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());

        let guard = ToolChildGuard::spawn(command).expect("tool process should spawn");
        drop(guard);
        thread::sleep(Duration::from_millis(2300));
        assert!(
            !marker_path.exists(),
            "an early handler return must kill command descendants"
        );
        let _ = fs::remove_file(marker_path);
    }

    #[test]
    fn normal_tool_exit_disarms_without_killing_the_process_group() {
        let (output, kill_attempts, _) = run_post_exit_case("printf normal");

        assert_eq!(output, b"normal");
        assert_eq!(kill_attempts, 0);
    }

    #[test]
    fn short_lived_descendant_output_drains_before_group_cleanup() {
        let (output, kill_attempts, elapsed) = run_post_exit_case("(sleep 0.02; printf late) &");

        assert_eq!(output, b"late");
        assert_eq!(kill_attempts, 0);
        assert!(elapsed < Duration::from_millis(200));
    }

    #[test]
    fn long_lived_descendant_is_killed_once_after_post_exit_drain_window() {
        let marker_path = unique_marker_path();
        let _ = fs::remove_file(&marker_path);
        let command = format!("(sleep 2; touch {}) &", shell_quote(&marker_path));

        let (_, kill_attempts, elapsed) = run_post_exit_case(&command);

        assert_eq!(kill_attempts, 1);
        assert!(elapsed >= super::POST_EXIT_DRAIN_TIMEOUT);
        assert!(elapsed < Duration::from_secs(1));
        thread::sleep(Duration::from_millis(2200));
        assert!(
            !marker_path.exists(),
            "long-lived descendant must be cleaned up after the drain window"
        );
        let _ = fs::remove_file(marker_path);
    }
}
