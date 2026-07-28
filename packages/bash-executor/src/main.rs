use std::{
    env,
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};

const FIRST_FRAME_TIMEOUT: Duration = Duration::from_millis(750);
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(5);
const POST_EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(50);
const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_STDIN_BYTES: usize = 64 * 1024;
const OUTPUT_CHANNEL_CAPACITY: usize = 16;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenRequest {
    op: String,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
enum ControlRequest {
    Stdin { data: String },
    Resize { rows: u16, cols: u16 },
    Cancel,
}

#[derive(Serialize)]
struct SimpleEvent {
    op: &'static str,
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
    Invalid,
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
    let occupied = Arc::new(AtomicBool::new(false));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let occupied = occupied.clone();
                thread::spawn(move || {
                    let _ = handle_connection(stream, occupied);
                });
            }
            Err(error) => eprintln!("bash executor accept failed: {error}"),
        }
    }
}

fn parse_listen(args: impl Iterator<Item = String>) -> Result<SocketAddr, String> {
    let args = args.collect::<Vec<_>>();
    if args.len() != 2 || args[0] != "--listen" {
        return Err("usage: bash-executor --listen 0.0.0.0:3110".to_owned());
    }
    args[1]
        .parse::<SocketAddr>()
        .map_err(|error| format!("invalid listen address: {error}"))
}

fn handle_connection(stream: TcpStream, occupied: Arc<AtomicBool>) -> io::Result<()> {
    let shutdown = ConnectionShutdown(stream.try_clone()?);
    let mut reader = BufReader::new(stream.try_clone()?);
    let first = match read_frame_until(&mut reader, Some(Instant::now() + FIRST_FRAME_TIMEOUT)) {
        Ok(Some(frame)) => frame,
        Ok(None) => return Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ) =>
        {
            write_error(&stream, "terminal open frame timed out")?;
            return Ok(());
        }
        Err(error) if error.kind() == io::ErrorKind::InvalidData => {
            write_error(&stream, "invalid terminal open frame")?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let request = match serde_json::from_slice::<OpenRequest>(&first) {
        Ok(request) if request.op == "open" => request,
        _ => {
            write_error(&stream, "first terminal frame must be open")?;
            return Ok(());
        }
    };
    let _ = request;
    if occupied
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        write_error(&stream, "terminal is already open")?;
        return Ok(());
    }
    let _occupancy = OccupancyGuard(occupied);
    stream.set_read_timeout(None)?;
    let writer = Arc::new(Mutex::new(stream));
    let (control_tx, control_rx) = mpsc::channel();
    thread::spawn(move || read_controls(reader, control_tx));
    let result = handle_terminal(writer, control_rx);
    drop(shutdown);
    result
}

fn handle_terminal(
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
    command.arg("-il");
    command.env_clear();
    inherit_safe_environment(&mut command);
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
    let mut terminal_input = pair.master.take_writer().map_err(io::Error::other)?;
    let (output_tx, output_rx) = mpsc::sync_channel(OUTPUT_CHANNEL_CAPACITY);
    spawn_output_reader(
        pair.master.try_clone_reader().map_err(io::Error::other)?,
        output_tx.clone(),
    );
    drop(output_tx);
    write_event(&writer, &SimpleEvent { op: "ready" })?;

    loop {
        while let Ok(chunk) = output_rx.try_recv() {
            write_output_event(&writer, chunk)?;
        }
        match control_rx.try_recv() {
            Ok(Control::Stdin(bytes)) => {
                terminal_input.write_all(&bytes)?;
                terminal_input.flush()?;
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
            Ok(Control::Invalid) => {
                child.kill_group();
                write_event(
                    &writer,
                    &ErrorEvent {
                        op: "error",
                        message: "invalid terminal control frame",
                    },
                )?;
            }
            Ok(Control::Cancel)
            | Ok(Control::Disconnected)
            | Err(mpsc::TryRecvError::Disconnected) => child.kill_group(),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if let Some(status) = child.try_wait()? {
            child.disarm();
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

fn read_controls(mut reader: BufReader<TcpStream>, sender: mpsc::Sender<Control>) {
    loop {
        let control = match read_frame(&mut reader) {
            Ok(Some(frame)) => parse_control(&frame),
            Ok(None) | Err(_) => Control::Disconnected,
        };
        let terminal = matches!(control, Control::Disconnected);
        if sender.send(control).is_err() || terminal {
            return;
        }
    }
}

fn parse_control(frame: &[u8]) -> Control {
    match serde_json::from_slice::<ControlRequest>(frame) {
        Ok(ControlRequest::Stdin { data }) => match BASE64.decode(data) {
            Ok(bytes) if bytes.len() <= MAX_STDIN_BYTES => Control::Stdin(bytes),
            _ => Control::Invalid,
        },
        Ok(ControlRequest::Resize { rows, cols }) if rows > 0 && cols > 0 => {
            Control::Resize { rows, cols }
        }
        Ok(ControlRequest::Cancel) => Control::Cancel,
        _ => Control::Invalid,
    }
}

fn read_frame(reader: &mut BufReader<TcpStream>) -> io::Result<Option<Vec<u8>>> {
    read_frame_until(reader, None)
}

fn read_frame_until(
    reader: &mut BufReader<TcpStream>,
    deadline: Option<Instant>,
) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        if let Some(deadline) = deadline {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::TimedOut, "terminal frame deadline elapsed")
                })?;
            reader.get_ref().set_read_timeout(Some(remaining))?;
        }
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unterminated terminal frame",
                ))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        if frame.len() + take > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "terminal frame exceeds limit",
            ));
        }
        frame.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            frame.pop();
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            return Ok(Some(frame));
        }
    }
}

fn inherit_safe_environment(command: &mut CommandBuilder) {
    for (key, value) in env::vars_os() {
        let allowed = key == "PATH"
            || key == "HOME"
            || key == "LANG"
            || key.to_string_lossy().starts_with("LC_");
        if allowed {
            command.env(key, value);
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

fn write_output_event(writer: &Arc<Mutex<TcpStream>>, chunk: Vec<u8>) -> io::Result<()> {
    write_event(
        writer,
        &OutputEvent {
            op: "output",
            data: BASE64.encode(chunk),
        },
    )
}

fn write_error(stream: &TcpStream, message: &str) -> io::Result<()> {
    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    write_event(
        &writer,
        &ErrorEvent {
            op: "error",
            message,
        },
    )
}

fn write_event<T: Serialize>(writer: &Arc<Mutex<TcpStream>>, event: &T) -> io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("executor writer lock poisoned"))?;
    serde_json::to_writer(&mut *writer, event).map_err(io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

struct ConnectionShutdown(TcpStream);

impl Drop for ConnectionShutdown {
    fn drop(&mut self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

struct OccupancyGuard(Arc<AtomicBool>);

impl Drop for OccupancyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct PtyChildGuard {
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    kill_sent: bool,
}

impl PtyChildGuard {
    fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        Self {
            child: Some(child),
            kill_sent: false,
        }
    }

    fn try_wait(&mut self) -> io::Result<Option<portable_pty::ExitStatus>> {
        self.child
            .as_mut()
            .expect("PTY child guard must be armed while polling")
            .try_wait()
            .map_err(io::Error::other)
    }

    fn disarm(&mut self) {
        self.child.take();
    }

    fn kill_group(&mut self) {
        if self.kill_sent || self.child.is_none() {
            return;
        }
        self.kill_sent = true;
        #[cfg(unix)]
        if let Some(pid) = self.child.as_ref().and_then(|child| child.process_id()) {
            kill_terminal_process_tree(pid);
        }
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
        }
    }
}

impl Drop for PtyChildGuard {
    fn drop(&mut self) {
        self.kill_group();
        if let Some(child) = self.child.as_mut() {
            let _ = child.wait();
        }
    }
}

#[cfg(target_os = "linux")]
fn kill_terminal_process_tree(root_pid: u32) {
    unsafe {
        let _ = libc::kill(root_pid as libc::pid_t, libc::SIGSTOP);
    }
    let mut descendants = linux_descendant_pids(root_pid);
    for pid in &descendants {
        unsafe {
            let _ = libc::kill(*pid as libc::pid_t, libc::SIGSTOP);
        }
    }
    for pid in linux_descendant_pids(root_pid) {
        if !descendants.contains(&pid) {
            descendants.push(pid);
        }
    }
    for pid in descendants.into_iter().rev() {
        unsafe {
            let _ = libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            let _ = libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
    unsafe {
        let _ = libc::kill(-(root_pid as libc::pid_t), libc::SIGKILL);
        let _ = libc::kill(root_pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(target_os = "linux")]
fn linux_descendant_pids(root_pid: u32) -> Vec<u32> {
    let mut parent_by_pid = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(status) = std::fs::read_to_string(entry.path().join("status")) else {
            continue;
        };
        let parent = status
            .lines()
            .find_map(|line| line.strip_prefix("PPid:"))
            .and_then(|value| value.trim().parse::<u32>().ok());
        if let Some(parent) = parent {
            parent_by_pid.push((pid, parent));
        }
    }
    let mut descendants = Vec::new();
    let mut parents = vec![root_pid];
    while let Some(parent) = parents.pop() {
        for (pid, candidate_parent) in &parent_by_pid {
            if *candidate_parent == parent && !descendants.contains(pid) {
                descendants.push(*pid);
                parents.push(*pid);
            }
        }
    }
    descendants
}

#[cfg(all(unix, not(target_os = "linux")))]
fn kill_terminal_process_tree(root_pid: u32) {
    unsafe {
        let _ = libc::kill(-(root_pid as libc::pid_t), libc::SIGKILL);
        let _ = libc::kill(root_pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        handle_connection, inherit_safe_environment, parse_listen, PtyChildGuard,
        FIRST_FRAME_TIMEOUT,
    };
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use portable_pty::{Child, ChildKiller, CommandBuilder, ExitStatus};
    use std::{
        env, fs,
        io::{self, BufRead, BufReader, Write},
        net::{TcpListener, TcpStream},
        path::Path,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        },
        thread,
        time::{Duration, Instant},
    };

    fn connection_pair(
        occupied: Arc<AtomicBool>,
    ) -> (TcpStream, thread::JoinHandle<io::Result<()>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let client = TcpStream::connect(addr).expect("client should connect");
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout should set");
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("client should connect");
            handle_connection(stream, occupied)
        });
        (client, server)
    }

    fn read_json(reader: &mut BufReader<TcpStream>) -> serde_json::Value {
        let mut line = String::new();
        reader.read_line(&mut line).expect("event should read");
        assert!(!line.is_empty(), "connection closed before event");
        serde_json::from_str(line.trim_end()).expect("event should be JSON")
    }

    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
    }

    #[test]
    fn accepts_manifest_wide_listen_address() {
        assert_eq!(
            parse_listen(["--listen".to_owned(), "0.0.0.0:3110".to_owned()].into_iter())
                .expect("pod-wide address should parse")
                .to_string(),
            "0.0.0.0:3110"
        );
    }

    #[test]
    fn readiness_connect_does_not_occupy_the_terminal() {
        let occupied = Arc::new(AtomicBool::new(false));
        let (probe, probe_server) = connection_pair(occupied.clone());
        drop(probe);
        probe_server
            .join()
            .expect("probe handler should join")
            .expect("probe handler should succeed");

        let (mut client, server) = connection_pair(occupied);
        writeln!(client, r#"{{"op":"open"}}"#).expect("open should write");
        let mut reader = BufReader::new(client);
        assert_eq!(read_json(&mut reader), serde_json::json!({"op":"ready"}));
        drop(reader);
        server.join().expect("handler should join").ok();
    }

    #[test]
    fn first_frame_has_a_short_timeout_without_occupying() {
        let occupied = Arc::new(AtomicBool::new(false));
        let (client, server) = connection_pair(occupied.clone());
        let started = Instant::now();
        let mut reader = BufReader::new(client);
        assert_eq!(read_json(&mut reader)["op"], "error");
        assert!(started.elapsed() >= FIRST_FRAME_TIMEOUT);
        assert!(started.elapsed() < Duration::from_secs(2));
        server
            .join()
            .expect("handler should join")
            .expect("handler should succeed");
        assert!(!occupied.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn first_frame_deadline_is_absolute_during_a_slow_drip() {
        let occupied = Arc::new(AtomicBool::new(false));
        let (mut client, server) = connection_pair(occupied.clone());
        let started = Instant::now();
        let reader_stream = client.try_clone().expect("stream should clone");
        for _ in 0..3 {
            client.write_all(b" ").expect("drip byte should write");
            client.flush().expect("drip byte should flush");
            thread::sleep(Duration::from_millis(300));
        }
        let _ = writeln!(client, r#"{{"op":"open"}}"#);
        let event = read_json(&mut BufReader::new(reader_stream));
        assert_eq!(event["op"], "error");
        assert!(
            started.elapsed() < FIRST_FRAME_TIMEOUT + Duration::from_millis(500),
            "slow input extended the absolute first-frame deadline"
        );
        server
            .join()
            .expect("handler should join")
            .expect("handler should succeed");
        assert!(!occupied.load(Ordering::Acquire));
    }

    #[test]
    fn valid_open_is_exclusive_and_shell_is_fixed() {
        let occupied = Arc::new(AtomicBool::new(false));
        let (mut first, first_server) = connection_pair(occupied.clone());
        writeln!(first, r#"{{"op":"open"}}"#).expect("open should write");
        let mut first_reader =
            BufReader::new(first.try_clone().expect("first stream should clone"));
        assert_eq!(
            read_json(&mut first_reader),
            serde_json::json!({"op":"ready"})
        );

        let (mut second, second_server) = connection_pair(occupied);
        writeln!(second, r#"{{"op":"open"}}"#).expect("second open should write");
        let mut second_reader = BufReader::new(second);
        assert_eq!(read_json(&mut second_reader)["op"], "error");
        second_server
            .join()
            .expect("second handler should join")
            .expect("second handler should succeed");

        let input = BASE64.encode("printf FIXED_SHELL_READY; exit\n");
        writeln!(first, "{{\"op\":\"stdin\",\"data\":\"{input}\"}}").expect("stdin should write");
        let mut output = Vec::new();
        loop {
            let event = read_json(&mut first_reader);
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
        assert!(String::from_utf8_lossy(&output).contains("FIXED_SHELL_READY"));
        first_server
            .join()
            .expect("first handler should join")
            .expect("first handler should succeed");
    }

    #[test]
    fn rejects_client_controlled_open_fields_and_invalid_controls() {
        let occupied = Arc::new(AtomicBool::new(false));
        let (mut invalid_open, invalid_server) = connection_pair(occupied.clone());
        writeln!(
            invalid_open,
            r#"{{"op":"open","command":"id","cwd":"/","mode":"tool"}}"#
        )
        .expect("invalid open should write");
        let mut invalid_reader = BufReader::new(invalid_open);
        assert_eq!(read_json(&mut invalid_reader)["op"], "error");
        invalid_server
            .join()
            .expect("invalid handler should join")
            .expect("invalid handler should succeed");

        let (mut client, server) = connection_pair(occupied);
        writeln!(client, r#"{{"op":"open"}}"#).expect("open should write");
        let mut reader = BufReader::new(client.try_clone().expect("stream should clone"));
        assert_eq!(read_json(&mut reader)["op"], "ready");
        writeln!(client, r#"{{"op":"resize","rows":0,"cols":80}}"#)
            .expect("invalid resize should write");
        assert_eq!(read_json(&mut reader)["op"], "error");
        drop(client);
        drop(reader);
        server.join().expect("handler should join").ok();
    }

    #[test]
    fn disconnect_kills_the_terminal_process_group() {
        let marker = std::env::temp_dir().join(format!(
            "agentsmith-terminal-disconnect-{}.marker",
            std::process::id()
        ));
        let _ = fs::remove_file(&marker);
        let occupied = Arc::new(AtomicBool::new(false));
        let (mut client, server) = connection_pair(occupied);
        writeln!(client, r#"{{"op":"open"}}"#).expect("open should write");
        let mut reader = BufReader::new(client.try_clone().expect("stream should clone"));
        assert_eq!(read_json(&mut reader)["op"], "ready");
        let command = format!(
            "(sleep 1; touch {}) & while :; do sleep 1; done\n",
            shell_quote(&marker)
        );
        let input = BASE64.encode(command);
        writeln!(client, "{{\"op\":\"stdin\",\"data\":\"{input}\"}}").expect("stdin should write");
        thread::sleep(Duration::from_millis(100));
        drop(reader);
        drop(client);
        server.join().expect("handler should join").ok();
        thread::sleep(Duration::from_millis(1100));
        assert!(
            !marker.exists(),
            "a terminal descendant survived its client disconnect"
        );
        let _ = fs::remove_file(marker);
    }

    #[test]
    fn cancel_kills_terminal_descendants() {
        let marker = std::env::temp_dir().join(format!(
            "agentsmith-terminal-cancel-{}.marker",
            std::process::id()
        ));
        let _ = fs::remove_file(&marker);
        let occupied = Arc::new(AtomicBool::new(false));
        let (mut client, server) = connection_pair(occupied);
        writeln!(client, r#"{{"op":"open"}}"#).expect("open should write");
        let mut reader = BufReader::new(client.try_clone().expect("stream should clone"));
        assert_eq!(read_json(&mut reader)["op"], "ready");
        let command = format!(
            "(sleep 1; touch {}) & while :; do sleep 1; done\n",
            shell_quote(&marker)
        );
        let input = BASE64.encode(command);
        writeln!(client, "{{\"op\":\"stdin\",\"data\":\"{input}\"}}").expect("stdin should write");
        thread::sleep(Duration::from_millis(100));
        writeln!(client, r#"{{"op":"cancel"}}"#).expect("cancel should write");
        while read_json(&mut reader)["op"] != "completed" {}
        server
            .join()
            .expect("handler should join")
            .expect("handler should succeed");
        thread::sleep(Duration::from_millis(1100));
        assert!(
            !marker.exists(),
            "a terminal descendant survived an explicit cancel"
        );
        let _ = fs::remove_file(marker);
    }

    #[test]
    fn safe_environment_filter_excludes_product_secrets() {
        const SECRET_KEY: &str = "AGENTSMITH_EXECUTOR_FILTER_TEST_SECRET";
        env::set_var(SECRET_KEY, "must-not-leak");
        let mut command = CommandBuilder::new("bash");
        command.env_clear();
        inherit_safe_environment(&mut command);
        assert_eq!(command.get_env(SECRET_KEY), None);
        for key in ["PATH", "HOME", "LANG"] {
            assert_eq!(command.get_env(key), env::var_os(key).as_deref());
        }
        env::remove_var(SECRET_KEY);
    }

    #[derive(Debug)]
    struct FakeChild {
        kills: Arc<AtomicUsize>,
        waits: Arc<AtomicUsize>,
    }

    impl ChildKiller for FakeChild {
        fn kill(&mut self) -> io::Result<()> {
            self.kills.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(FakeKiller(self.kills.clone()))
        }
    }

    impl Child for FakeChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Ok(Some(ExitStatus::with_exit_code(0)))
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            self.waits.fetch_add(1, Ordering::AcqRel);
            Ok(ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            None
        }
    }

    #[derive(Debug)]
    struct FakeKiller(Arc<AtomicUsize>);

    impl ChildKiller for FakeKiller {
        fn kill(&mut self) -> io::Result<()> {
            self.0.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Self(self.0.clone()))
        }
    }

    #[test]
    fn normal_reaped_exit_disarms_child_guard_without_kill_or_wait() {
        let kills = Arc::new(AtomicUsize::new(0));
        let waits = Arc::new(AtomicUsize::new(0));
        let mut guard = PtyChildGuard::new(Box::new(FakeChild {
            kills: kills.clone(),
            waits: waits.clone(),
        }));
        assert!(guard.try_wait().expect("wait should succeed").is_some());
        guard.disarm();
        drop(guard);
        assert_eq!(kills.load(Ordering::Acquire), 0);
        assert_eq!(waits.load(Ordering::Acquire), 0);
    }
}
