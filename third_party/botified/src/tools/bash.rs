use std::{
    io::{self, BufRead, BufReader, Write},
    net::{SocketAddr, TcpStream},
    process::ExitStatus,
    sync::{mpsc::{self, SyncSender, TrySendError}, Arc},
    thread,
    time::{Duration, Instant},
};

#[cfg(test)]
use std::{env, ffi::OsStr, io::Read, os::raw::c_int, process::{Command, Stdio}};

#[cfg(all(test, unix))]
use std::os::fd::AsRawFd;
#[cfg(all(test, unix))]
use std::os::unix::process::CommandExt;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::tasks::{BotifiedFrameScanner, TaskStdinWriteSuccess, TaskStdinWriter};
#[cfg(test)]
use crate::tasks::SharedTaskStdinWriter;
use crate::types::{ToolCall, ToolResult};

use super::{
    Tool, ToolError, ToolExecutionContext, ToolOutputSink, ToolOutputSnapshot, ToolSpec,
    ToolTimeout,
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_BYTES: usize = 60 * 1024;
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(10);
#[cfg(test)]
const POST_EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(50);

#[cfg(all(test, unix))]
const SIGKILL: c_int = 9;
#[cfg(all(test, unix))]
const F_GETFL: c_int = 3;
#[cfg(all(test, unix))]
const F_SETFL: c_int = 4;
#[cfg(all(test, any(target_os = "android", target_os = "linux")))]
const O_NONBLOCK: c_int = 0o4000;
#[cfg(all(test, any(
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "ios",
    target_os = "macos",
    target_os = "netbsd",
    target_os = "openbsd"
)))]
const O_NONBLOCK: c_int = 0x0004;

#[cfg(all(test, unix))]
unsafe extern "C" {
    fn kill(pid: c_int, sig: c_int) -> c_int;
    fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
}

#[derive(Debug, Clone)]
pub struct BashTool {
    default_timeout: Duration,
    max_output_bytes: usize,
    executor_addr: SocketAddr,
}

impl BashTool {
    pub fn new() -> Self {
        Self {
            default_timeout: DEFAULT_TIMEOUT,
            max_output_bytes: MAX_OUTPUT_BYTES,
            executor_addr: "127.0.0.1:3110".parse().expect("default executor address must parse"),
        }
    }

    pub fn with_default_timeout(mut self, timeout: Duration) -> Self {
        self.default_timeout = timeout;
        self
    }

    pub fn with_executor_addr(mut self, addr: &str) -> Result<Self, String> {
        let executor_addr = addr.parse::<SocketAddr>().map_err(|error| format!("invalid bash executor address: {error}"))?;
        if !executor_addr.ip().is_loopback() {
            return Err("bash executor address must be loopback-only".to_owned());
        }
        self.executor_addr = executor_addr;
        Ok(self)
    }
}

impl Default for BashTool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BashArguments {
    command: String,
    #[serde(default)]
    timeout_secs: Option<Value>,
    #[serde(default, rename = "detach_after_secs")]
    _detach_after_secs: Option<f64>,
    #[serde(default)]
    _interactive_stdio: bool,
}

#[derive(Debug)]
struct OutputAccumulator {
    bytes: Vec<u8>,
    truncated: bool,
    dropped_bytes: usize,
}

#[derive(Debug)]
struct BashOutcome {
    status: Option<ExitStatus>,
    output: OutputAccumulator,
    output_snapshot: Option<ToolOutputSnapshot>,
    timed_out: bool,
    cancelled: bool,
}

impl OutputAccumulator {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(max_bytes.min(8192)),
            truncated: false,
            dropped_bytes: 0,
        }
    }

    fn push(&mut self, chunk: &[u8], max_bytes: usize) {
        if chunk.is_empty() || max_bytes == 0 {
            return;
        }

        if chunk.len() >= max_bytes {
            self.dropped_bytes += self.bytes.len() + chunk.len() - max_bytes;
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&chunk[chunk.len() - max_bytes..]);
            self.truncated = true;
            return;
        }

        let overflow = self.bytes.len() + chunk.len();
        if overflow > max_bytes {
            let remove = overflow - max_bytes;
            self.bytes.drain(..remove);
            self.dropped_bytes += remove;
            self.truncated = true;
        }

        self.bytes.extend_from_slice(chunk);
    }
}

#[cfg(test)]
struct PipeReader<R> {
    reader: R,
    closed: bool,
}

#[cfg(test)]
enum PipeRead {
    Chunk(Vec<u8>),
    NoProgress,
    Closed,
}

#[cfg(test)]
type TailUpdateObserver = Arc<dyn Fn(&[u8]) + Send + Sync>;

#[cfg(test)]
impl<R> PipeReader<R>
where
    R: PipeNonblocking + Read,
{
    fn new(reader: R) -> Result<Self, ToolError> {
        reader.set_nonblocking()?;
        Ok(Self {
            reader,
            closed: false,
        })
    }

    fn read_once(&mut self) -> Result<PipeRead, ToolError> {
        if self.closed {
            return Ok(PipeRead::Closed);
        }

        let mut buffer = [0_u8; 8192];
        match self.reader.read(&mut buffer) {
            Ok(0) => {
                self.closed = true;
                Ok(PipeRead::Closed)
            }
            Ok(read) => Ok(PipeRead::Chunk(buffer[..read].to_vec())),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                Ok(PipeRead::NoProgress)
            }
            Err(error) => Err(ToolError::execution_failed(format!(
                "failed to read bash output: {error}"
            ))),
        }
    }
}

#[cfg(test)]
struct OutputPump<R> {
    output_pipe: PipeReader<R>,
    output: OutputAccumulator,
    max_output_bytes: usize,
    output_sink: Option<Arc<dyn ToolOutputSink>>,
    interactive_stdio: Option<Arc<dyn crate::tasks::InteractiveStdioBridge>>,
    scanner: Option<BotifiedFrameScanner>,
    #[cfg(test)]
    tail_update_observer: Option<TailUpdateObserver>,
}

#[cfg(test)]
struct OutputPumpOutput {
    output: OutputAccumulator,
    output_snapshot: Option<ToolOutputSnapshot>,
}

#[cfg(test)]
impl<R> OutputPump<R>
where
    R: PipeNonblocking + Read,
{
    fn new(
        reader: R,
        max_output_bytes: usize,
        output_sink: Option<Arc<dyn ToolOutputSink>>,
        interactive_stdio: Option<Arc<dyn crate::tasks::InteractiveStdioBridge>>,
    ) -> Result<Self, ToolError> {
        let scanner = interactive_stdio
            .as_ref()
            .map(|_| BotifiedFrameScanner::default());
        Ok(Self {
            output_pipe: PipeReader::new(reader)?,
            output: OutputAccumulator::new(max_output_bytes),
            max_output_bytes,
            output_sink,
            interactive_stdio,
            scanner,
            #[cfg(test)]
            tail_update_observer: None,
        })
    }

    fn drain_available(&mut self) -> Result<bool, ToolError> {
        match self.output_pipe.read_once()? {
            PipeRead::Chunk(chunk) => {
                self.fan_out_chunk(&chunk)?;
                Ok(true)
            }
            PipeRead::NoProgress | PipeRead::Closed => Ok(false),
        }
    }

    #[cfg(test)]
    fn drain_until(&mut self, deadline: Instant) -> Result<(), ToolError> {
        while !self.is_closed() && Instant::now() < deadline {
            if !self.drain_available()? {
                thread::sleep(Duration::from_millis(1));
            }
        }
        Ok(())
    }

    fn is_closed(&self) -> bool {
        self.output_pipe.closed
    }

    fn complete(mut self) -> Result<OutputPumpOutput, ToolError> {
        if let Some(scanner) = self.scanner.as_mut() {
            let scan = scanner.finish();
            self.fan_out_scan(scan)?;
        }
        let output_snapshot = match self.output_sink {
            Some(sink) => Some(sink.complete()?),
            None => None,
        };
        Ok(OutputPumpOutput {
            output: self.output,
            output_snapshot,
        })
    }

    fn fan_out_chunk(&mut self, chunk: &[u8]) -> Result<(), ToolError> {
        if let Some(scanner) = self.scanner.as_mut() {
            let scan = scanner.push(chunk);
            return self.fan_out_scan(scan);
        }
        self.fan_out_plain_output(chunk)?;
        Ok(())
    }

    fn fan_out_scan(&mut self, scan: crate::tasks::BotifiedFrameScan) -> Result<(), ToolError> {
        if !scan.plain_output.is_empty() {
            self.fan_out_plain_output(&scan.plain_output)?;
        }
        if !scan.events.is_empty() {
            if let Some(bridge) = self.interactive_stdio.as_ref() {
                bridge.handle_frame_events(scan.events);
            }
        }
        Ok(())
    }

    fn fan_out_plain_output(&mut self, chunk: &[u8]) -> Result<(), ToolError> {
        if let Some(sink) = self.output_sink.as_ref() {
            sink.record(chunk)?;
        }
        self.output.push(chunk, self.max_output_bytes);
        #[cfg(test)]
        if let Some(observer) = self.tail_update_observer.as_ref() {
            observer(chunk);
        }
        Ok(())
    }

    #[cfg(test)]
    fn set_tail_update_observer_for_test(&mut self, observer: Option<TailUpdateObserver>) {
        self.tail_update_observer = observer;
    }
}

#[async_trait]
impl Tool for BashTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "bash",
            "Run a command with bash -lc in the agent working directory.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Command to execute with bash -lc."
                    },
                    "timeout_secs": {
                        "type": ["number", "integer", "null"],
                        "description": "Optional execution timeout in seconds. Omit to use the finite server default; use null for no automatic deadline."
                    },
                    "detach_after_secs": {
                        "type": ["number", "integer"],
                        "description": "Optional delay in seconds before detaching execution into a background task. Use 0 to detach immediately. Detached tasks return an immediate task ack and later deliver a final callback."
                    },
                    "interactive_stdio": {
                        "type": "boolean",
                        "description": "Structured ask/tell/registry/reply/send/observe stdio for Botified-managed bash tasks. Defaults to true when Botified can run bash as a background task; set false only when stdout should be treated as raw log text. Plain stdout is log output; complete <botified> stdout frames are filtered from task output. Task stdin frames are short bounded control frames, not a data channel. To ask the agent, print <botified>{\"op\":\"ask\",\"id\":\"a1\",\"message\":\"...\",\"expect\":\"yes/no\"}</botified> and read a <botified>{\"op\":\"reply\",...}</botified> line from stdin. To notify without a reply, print <botified>{\"op\":\"tell\",\"id\":\"t1\",\"message\":\"...\"}</botified>. A managed task may publish current state with <botified>{\"op\":\"registry_set\",...}</botified> or read a low-frequency snapshot with <botified>{\"op\":\"registry_get\",...}</botified>; registry_get returns registry_snapshot or registry_error on stdin. The task may receive <botified>{\"op\":\"send\",...}</botified> lines from task_send and, after task_observe authorization, read-only <botified>{\"op\":\"observe\",...}</botified> notifications."
                    }
                },
                "required": ["command"]
            }),
        )
    }

    async fn execute(
        &self,
        call: ToolCall,
        context: ToolExecutionContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        let arguments: BashArguments = serde_json::from_value(call.arguments).map_err(|error| {
            ToolError::execution_failed(format!("invalid bash arguments: {error}"))
        })?;
        let timeout = timeout_from_context_or_arguments(
            context.timeout,
            arguments.timeout_secs.as_ref(),
            self.default_timeout,
        )?;
        let max_output_bytes = self.max_output_bytes;
        let command = arguments.command;
        let cwd = context.cwd;
        let output_sink = context.output_sink;
        let interactive_stdio = context.interactive_stdio;
        let executor_addr = self.executor_addr;

        if cancel.is_cancelled() {
            let outcome = cancelled_bash_outcome(output_sink)?;
            return Ok(format_tool_result(
                call.id,
                call.name,
                outcome,
                max_output_bytes,
            ));
        }

        let outcome = tokio::task::spawn_blocking(move || {
            run_executor_bash_command(
                &command,
                &cwd,
                timeout,
                max_output_bytes,
                output_sink,
                interactive_stdio,
                cancel,
                executor_addr,
            )
        })
        .await
        .map_err(|error| ToolError::execution_failed(format!("bash worker failed: {error}")))??;

        Ok(format_tool_result(
            call.id,
            call.name,
            outcome,
            max_output_bytes,
        ))
    }
}

fn timeout_from_arguments(
    timeout_secs: Option<&Value>,
    default_timeout: Duration,
) -> Result<Option<Duration>, ToolError> {
    match timeout_secs {
        None => Ok(Some(default_timeout)),
        Some(value) if value.is_null() => Ok(None),
        Some(value) => {
            let Some(seconds) = value.as_f64() else {
                return Err(ToolError::execution_failed(
                    "timeout_secs must be a number or null",
                ));
            };
            if seconds.is_finite() && seconds > 0.0 {
                Ok(Some(Duration::from_secs_f64(seconds)))
            } else {
                Err(ToolError::execution_failed(format!(
                    "timeout_secs must be a positive finite number, got {seconds}"
                )))
            }
        }
    }
}

fn timeout_from_context_or_arguments(
    context_timeout: ToolTimeout,
    timeout_secs: Option<&Value>,
    default_timeout: Duration,
) -> Result<Option<Duration>, ToolError> {
    match context_timeout {
        ToolTimeout::Default => timeout_from_arguments(timeout_secs, default_timeout),
        ToolTimeout::Deadline(timeout) if !timeout.is_zero() => Ok(Some(timeout)),
        ToolTimeout::Deadline(_) => Err(ToolError::execution_failed(
            "context timeout must be greater than 0",
        )),
        ToolTimeout::NoDeadline => Ok(None),
    }
}

#[derive(Serialize)]
struct ExecutorExecuteRequest<'a> {
    op: &'static str,
    command: &'a str,
    cwd: &'a str,
    interactive_stdio: bool,
}

#[derive(Serialize)]
struct ExecutorControlRequest {
    op: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
}

#[derive(Deserialize)]
struct ExecutorEvent {
    op: String,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    message: Option<String>,
}

struct ExecutorStdinWriter {
    sender: SyncSender<ExecutorControlRequest>,
}

impl ExecutorStdinWriter {
    fn frame(bytes: &[u8]) -> ExecutorControlRequest {
        ExecutorControlRequest {
            op: "stdin",
            data: Some(BASE64.encode(bytes)),
        }
    }

    fn write_frame(&self, bytes: &[u8]) -> Result<(), String> {
        self.sender.send(Self::frame(bytes)).map_err(|_| "bash executor stdin is closed".to_owned())
    }

    fn try_write_frame(&self, bytes: &[u8]) -> Result<(), String> {
        match self.sender.try_send(Self::frame(bytes)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err("bash executor stdin writer is busy".to_owned()),
            Err(TrySendError::Disconnected(_)) => Err("bash executor stdin is closed".to_owned()),
        }
    }
}

impl TaskStdinWriter for ExecutorStdinWriter {
    fn write_stdin(&self, bytes: &[u8]) -> Result<(), String> {
        self.write_frame(bytes)
    }

    fn supports_priority_stdin(&self) -> bool {
        true
    }

    fn try_write_priority_stdin(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        self.try_write_frame(bytes)?;
        Ok(TaskStdinWriteSuccess::delivered())
    }

    fn supports_observer_stdin(&self) -> bool {
        true
    }

    fn try_write_observer_stdin(&self, bytes: &[u8]) -> Result<(), String> {
        self.try_write_frame(bytes)
    }
}

fn write_ndjson<T: Serialize>(stream: &mut TcpStream, value: &T) -> io::Result<()> {
    serde_json::to_writer(&mut *stream, value).map_err(io::Error::other)?;
    stream.write_all(b"\n")?;
    stream.flush()
}

fn run_executor_bash_command(
    command: &str,
    cwd: &str,
    timeout: Option<Duration>,
    max_output_bytes: usize,
    output_sink: Option<Arc<dyn ToolOutputSink>>,
    interactive_stdio: Option<Arc<dyn crate::tasks::InteractiveStdioBridge>>,
    cancel: CancellationToken,
    executor_addr: SocketAddr,
) -> Result<BashOutcome, ToolError> {
    if cancel.is_cancelled() {
        return cancelled_bash_outcome(output_sink);
    }
    let mut stream = TcpStream::connect_timeout(&executor_addr, Duration::from_secs(2)).map_err(|error| {
        ToolError::execution_failed(format!("failed to connect to bash executor: {error}"))
    })?;
    stream.set_read_timeout(Some(WAIT_POLL_INTERVAL)).map_err(|error| {
        ToolError::execution_failed(format!("failed to configure bash executor connection: {error}"))
    })?;
    write_ndjson(&mut stream, &ExecutorExecuteRequest {
        op: "execute",
        command,
        cwd,
        interactive_stdio: interactive_stdio.is_some(),
    }).map_err(|error| ToolError::execution_failed(format!("failed to start bash executor request: {error}")))?;

    let mut control_stream = stream.try_clone().map_err(|error| ToolError::execution_failed(format!("failed to clone bash executor connection: {error}")))?;
    let (control_sender, control_receiver) = mpsc::sync_channel(32);
    thread::spawn(move || {
        while let Ok(control) = control_receiver.recv() {
            if write_ndjson(&mut control_stream, &control).is_err() {
                return;
            }
        }
    });
    let writer = Arc::new(ExecutorStdinWriter { sender: control_sender.clone() });
    if let Some(bridge) = interactive_stdio.as_ref() {
        bridge.register_stdin_writer(writer.clone());
    }
    let mut reader = BufReader::new(stream);
    let mut output = OutputAccumulator::new(max_output_bytes);
    let mut scanner = interactive_stdio.as_ref().map(|_| BotifiedFrameScanner::default());
    let started = Instant::now();
    let mut cancelled = false;
    let mut timed_out = false;
    let mut cancel_sent = false;
    let mut status = None;

    loop {
        if !cancel_sent && (cancel.is_cancelled() || timeout.is_some_and(|limit| started.elapsed() >= limit)) {
            cancelled = cancel.is_cancelled();
            timed_out = !cancelled;
            control_sender.send(ExecutorControlRequest { op: "cancel", data: None })
                .map_err(|_| ToolError::execution_failed("bash executor stdin is closed"))?;
            cancel_sent = true;
        }
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let event: ExecutorEvent = serde_json::from_str(line.trim_end()).map_err(|error| ToolError::execution_failed(format!("invalid bash executor response: {error}")))?;
                match event.op.as_str() {
                    "output" => {
                        let encoded = event.data.ok_or_else(|| ToolError::execution_failed("bash executor output missing data"))?;
                        let chunk = BASE64.decode(encoded).map_err(|error| ToolError::execution_failed(format!("invalid bash executor output: {error}")))?;
                        fan_out_executor_chunk(&chunk, &mut output, max_output_bytes, output_sink.as_ref(), scanner.as_mut(), interactive_stdio.as_ref())?;
                    }
                    "completed" => { status = event.exit_code.map(exit_status_from_code).transpose()?; break; }
                    "error" => return Err(ToolError::execution_failed(event.message.unwrap_or_else(|| "bash executor failed".to_owned()))),
                    other => return Err(ToolError::execution_failed(format!("unknown bash executor response: {other}"))),
                }
            }
            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
            Err(error) => return Err(ToolError::execution_failed(format!("failed to read bash executor response: {error}"))),
        }
    }
    if let Some(scanner) = scanner.as_mut() {
        let scan = scanner.finish();
        fan_out_executor_scan(scan, &mut output, max_output_bytes, output_sink.as_ref(), interactive_stdio.as_ref())?;
    }
    let output_snapshot = output_sink.map(|sink| sink.complete()).transpose()?;
    Ok(BashOutcome { status, output, output_snapshot, timed_out, cancelled })
}

fn exit_status_from_code(code: i32) -> Result<ExitStatus, ToolError> {
    #[cfg(unix)]
    { Ok(std::os::unix::process::ExitStatusExt::from_raw(code << 8)) }
    #[cfg(not(unix))]
    { let _ = code; Err(ToolError::execution_failed("bash executor exit status is unsupported on this platform")) }
}

fn fan_out_executor_chunk(
    chunk: &[u8], output: &mut OutputAccumulator, max_output_bytes: usize,
    output_sink: Option<&Arc<dyn ToolOutputSink>>, scanner: Option<&mut BotifiedFrameScanner>,
    interactive_stdio: Option<&Arc<dyn crate::tasks::InteractiveStdioBridge>>,
) -> Result<(), ToolError> {
    if let Some(scanner) = scanner {
        return fan_out_executor_scan(scanner.push(chunk), output, max_output_bytes, output_sink, interactive_stdio);
    }
    fan_out_executor_plain(chunk, output, max_output_bytes, output_sink)
}

fn fan_out_executor_scan(
    scan: crate::tasks::BotifiedFrameScan, output: &mut OutputAccumulator, max_output_bytes: usize,
    output_sink: Option<&Arc<dyn ToolOutputSink>>, interactive_stdio: Option<&Arc<dyn crate::tasks::InteractiveStdioBridge>>,
) -> Result<(), ToolError> {
    if !scan.plain_output.is_empty() { fan_out_executor_plain(&scan.plain_output, output, max_output_bytes, output_sink)?; }
    if !scan.events.is_empty() { if let Some(bridge) = interactive_stdio { bridge.handle_frame_events(scan.events); } }
    Ok(())
}

fn fan_out_executor_plain(chunk: &[u8], output: &mut OutputAccumulator, max_output_bytes: usize, output_sink: Option<&Arc<dyn ToolOutputSink>>) -> Result<(), ToolError> {
    if let Some(sink) = output_sink { sink.record(chunk)?; }
    output.push(chunk, max_output_bytes);
    Ok(())
}

#[cfg(test)]
fn run_bash_command(
    command: &str,
    cwd: &str,
    timeout: Option<Duration>,
    max_output_bytes: usize,
    output_sink: Option<Arc<dyn ToolOutputSink>>,
    interactive_stdio: Option<Arc<dyn crate::tasks::InteractiveStdioBridge>>,
    cancel: CancellationToken,
) -> Result<BashOutcome, ToolError> {
    if cancel.is_cancelled() {
        return cancelled_bash_outcome(output_sink);
    }

    let mut child = Command::new("bash");
    let redirected_command = format!("{}\nexec 2>&1\n{command}", secret_env_cleanup_script());
    child
        .arg("-lc")
        .arg(redirected_command)
        .current_dir(cwd)
        .stdin(if interactive_stdio.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();

    #[cfg(unix)]
    child.process_group(0);

    for (key, value) in env::vars_os() {
        if should_inherit_env_key(&key) {
            child.env(key, value);
        }
    }

    if cancel.is_cancelled() {
        return cancelled_bash_outcome(output_sink);
    }

    let mut child = child
        .spawn()
        .map_err(|error| ToolError::execution_failed(format!("failed to spawn bash: {error}")))?;

    let output_pipe = child
        .stdout
        .take()
        .ok_or_else(|| ToolError::execution_failed("failed to capture bash stdout"))?;
    let startup_stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| ToolError::execution_failed("failed to capture bash stderr"))?;
    if let Some(bridge) = interactive_stdio.as_ref() {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ToolError::execution_failed("failed to capture bash stdin"))?;
        #[cfg(target_os = "linux")]
        bridge.register_stdin_writer(Arc::new(SharedTaskStdinWriter::new_verified_pipe(stdin)));
        #[cfg(not(target_os = "linux"))]
        bridge.register_stdin_writer(Arc::new(SharedTaskStdinWriter::new(stdin)));
    }

    let mut output_pump = OutputPump::new(
        output_pipe,
        max_output_bytes,
        output_sink,
        interactive_stdio,
    )?;
    let mut startup_stderr = PipeReader::new(startup_stderr_pipe)?;

    let started = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;

    let status = loop {
        let mut made_progress = output_pump.drain_available()?;
        made_progress |= drain_startup_stderr_available(&mut startup_stderr, &mut output_pump)?;

        if cancel.is_cancelled() {
            cancelled = true;
            kill_child(&mut child);
            break child.wait().ok();
        }

        if timeout.is_some_and(|timeout| started.elapsed() >= timeout) {
            timed_out = true;
            kill_child(&mut child);
            break child.wait().ok();
        }

        match child.try_wait().map_err(|error| {
            ToolError::execution_failed(format!("failed to wait for bash: {error}"))
        })? {
            Some(exit_status) => {
                break Some(exit_status);
            }
            None if made_progress => {}
            None => thread::sleep(WAIT_POLL_INTERVAL),
        }
    };

    drain_bash_pipes_until(
        &mut output_pump,
        &mut startup_stderr,
        Instant::now() + POST_EXIT_DRAIN_TIMEOUT,
    )?;

    if !output_pump.is_closed() || !startup_stderr.closed {
        kill_process_group(child.id());
        drain_bash_pipes_until(
            &mut output_pump,
            &mut startup_stderr,
            Instant::now() + POST_EXIT_DRAIN_TIMEOUT,
        )?;
    }
    let OutputPumpOutput {
        output,
        output_snapshot,
    } = output_pump.complete()?;

    Ok(BashOutcome {
        status,
        output,
        output_snapshot,
        timed_out,
        cancelled,
    })
}

#[cfg(test)]
fn drain_startup_stderr_available<R, S>(
    startup_stderr: &mut PipeReader<S>,
    output_pump: &mut OutputPump<R>,
) -> Result<bool, ToolError>
where
    R: PipeNonblocking + Read,
    S: PipeNonblocking + Read,
{
    match startup_stderr.read_once()? {
        PipeRead::Chunk(chunk) => {
            output_pump.fan_out_chunk(&chunk)?;
            Ok(true)
        }
        PipeRead::NoProgress | PipeRead::Closed => Ok(false),
    }
}

#[cfg(test)]
fn drain_bash_pipes_until<R, S>(
    output_pump: &mut OutputPump<R>,
    startup_stderr: &mut PipeReader<S>,
    deadline: Instant,
) -> Result<(), ToolError>
where
    R: PipeNonblocking + Read,
    S: PipeNonblocking + Read,
{
    while Instant::now() < deadline && (!output_pump.is_closed() || !startup_stderr.closed) {
        let mut made_progress = output_pump.drain_available()?;
        made_progress |= drain_startup_stderr_available(startup_stderr, output_pump)?;
        if !made_progress {
            thread::sleep(Duration::from_millis(1));
        }
    }

    Ok(())
}

#[cfg(test)]
trait PipeNonblocking {
    fn set_nonblocking(&self) -> Result<(), ToolError>;
}

#[cfg(all(test, unix))]
impl<T> PipeNonblocking for T
where
    T: AsRawFd,
{
    fn set_nonblocking(&self) -> Result<(), ToolError> {
        let fd = self.as_raw_fd();
        // SAFETY: fcntl is called with a valid pipe fd owned by ChildStdout/ChildStderr.
        let flags = unsafe { fcntl(fd, F_GETFL) };
        if flags < 0 {
            return Err(ToolError::execution_failed(
                "failed to read bash pipe flags",
            ));
        }

        // SAFETY: fcntl updates the valid pipe fd flags to include O_NONBLOCK.
        let result = unsafe { fcntl(fd, F_SETFL, flags | O_NONBLOCK) };
        if result < 0 {
            return Err(ToolError::execution_failed(
                "failed to set bash pipe nonblocking",
            ));
        }

        Ok(())
    }
}

#[cfg(all(test, not(unix)))]
impl<T> PipeNonblocking for T {
    fn set_nonblocking(&self) -> Result<(), ToolError> {
        Ok(())
    }
}

#[cfg(test)]
fn kill_child(child: &mut std::process::Child) {
    kill_process_group(child.id());
    let _ = child.kill();
}

#[cfg(test)]
fn kill_process_group(child_id: u32) {
    #[cfg(all(test, unix))]
    {
        let process_group_id = -(child_id as c_int);
        // SAFETY: kill(2) is called with the child process group id created above.
        // Errors are ignored because cancellation and timeout are best-effort.
        unsafe {
            kill(process_group_id, SIGKILL);
        }
    }
}

fn format_tool_result(
    tool_call_id: String,
    tool_name: String,
    outcome: BashOutcome,
    max_output_bytes: usize,
) -> ToolResult {
    let exit_code = outcome.status.and_then(|status| status.code());
    let aggregated_output = String::from_utf8_lossy(&outcome.output.bytes).to_string();
    let mut text = String::new();

    if outcome.cancelled {
        text.push_str("status: cancelled\n");
    } else if outcome.timed_out {
        text.push_str("status: timed out\n");
    } else {
        text.push_str("status: completed\n");
    }

    match exit_code {
        Some(code) => text.push_str(&format!("exit code: {code}\n")),
        None => text.push_str("exit code: unavailable\n"),
    }

    if outcome.output.truncated {
        text.push_str(&format!(
            "[botified output truncated; showing last {max_output_bytes} bytes, dropped {} bytes]\n",
            outcome.output.dropped_bytes
        ));
    }

    if let Some(snapshot) = outcome.output_snapshot.as_ref() {
        if let Some(path) = snapshot.artifact_path.as_ref() {
            text.push_str(&format!("output_artifact_path: {}\n", path.display()));
        }
        text.push_str(&format!("output_live: {}\n", snapshot.output_live));
        text.push_str(&format!("output_complete: {}\n", snapshot.output_complete));
        text.push_str(&format!("output_bytes: {}\n", snapshot.output_bytes));
        text.push_str(&format!(
            "output_artifact_truncated: {}\n",
            snapshot.output_artifact_truncated
        ));
        text.push_str(&format!(
            "output_dropped_bytes: {}\n",
            snapshot.output_dropped_bytes
        ));
    }

    if !aggregated_output.is_empty() {
        text.push_str("output:\n");
        text.push_str(&aggregated_output);
        if !aggregated_output.ends_with('\n') {
            text.push('\n');
        }
    }

    let truncated = outcome.output.truncated;
    let mut details = json!({
        "exit_code": exit_code,
        "timed_out": outcome.timed_out,
        "cancelled": outcome.cancelled,
        "truncated": truncated,
        "aggregated_output": aggregated_output
    });
    if let Some(snapshot) = outcome.output_snapshot {
        details["output_artifact_path"] = snapshot
            .artifact_path
            .as_ref()
            .map(|path| json!(path.display().to_string()))
            .unwrap_or(Value::Null);
        details["output_live"] = json!(snapshot.output_live);
        details["output_complete"] = json!(snapshot.output_complete);
        details["output_bytes"] = json!(snapshot.output_bytes);
        details["output_tail"] = json!(snapshot.tail);
        details["output_tail_truncated"] = json!(snapshot.output_tail_truncated);
        details["output_artifact_truncated"] = json!(snapshot.output_artifact_truncated);
        details["output_dropped_bytes"] = json!(snapshot.output_dropped_bytes);
    }
    let is_error =
        outcome.cancelled || outcome.timed_out || exit_code.map(|code| code != 0).unwrap_or(true);

    if is_error {
        ToolResult::error(tool_call_id, tool_name, text, details)
    } else {
        let mut result = ToolResult::success(tool_call_id, tool_name, text);
        result.details = details;
        result
    }
}

fn cancelled_bash_outcome(
    output_sink: Option<Arc<dyn ToolOutputSink>>,
) -> Result<BashOutcome, ToolError> {
    let output_snapshot = match output_sink {
        Some(sink) => Some(sink.complete()?),
        None => None,
    };
    Ok(BashOutcome {
        status: None,
        output: OutputAccumulator::new(0),
        output_snapshot,
        timed_out: false,
        cancelled: true,
    })
}

#[cfg(test)]
fn is_secret_env_key(key: &OsStr) -> bool {
    let key = key.to_string_lossy().to_ascii_uppercase();
    key == "AUTHORIZATION"
        || key == "GITHUB_PAT"
        || key == "MYSQL_PWD"
        || key.contains("_AUTH")
        || key.contains("ACCESS_KEY")
        || key == "BOTIFIED_SERVICE_KEY"
        || key.contains("API_KEY")
        || key.contains("TOKEN")
        || key.contains("SECRET")
        || key.contains("PASSWORD")
}

#[cfg(test)]
fn secret_env_cleanup_script() -> &'static str {
    r#"botified_clear_secret_env() {
    local key botified_had_nocasematch
    shopt -q nocasematch
    botified_had_nocasematch=$?
    shopt -s nocasematch
    while IFS= read -r key; do
        case "$key" in
            authorization|github_pat|mysql_pwd|botified_service_key|*_auth*|*access_key*|*api_key*|*token*|*secret*|*password*) unset "$key" 2>/dev/null || true ;;
        esac
    done < <(compgen -v)
    if [ "$botified_had_nocasematch" -ne 0 ]; then
        shopt -u nocasematch
    fi
}
botified_clear_secret_env
unset -f botified_clear_secret_env"#
}

#[cfg(test)]
fn is_bash_exported_function_env_key(key: &OsStr) -> bool {
    key.to_string_lossy().starts_with("BASH_FUNC_")
}

#[cfg(test)]
fn should_inherit_env_key(key: &OsStr) -> bool {
    !is_secret_env_key(key) && !is_bash_exported_function_env_key(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::VecDeque;
    use std::ffi::OsString;
    use std::fs;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::process;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::tasks::{BotifiedFrameEvent, InteractiveStdioBridge, TaskStdinWriter};

    enum FakeRead {
        Chunk(Vec<u8>),
        Eof,
    }

    struct FakeReader {
        reads: VecDeque<FakeRead>,
        would_block_forever: bool,
    }

    impl FakeReader {
        fn chunks<I, B>(chunks: I) -> Self
        where
            I: IntoIterator<Item = B>,
            B: AsRef<[u8]>,
        {
            Self {
                reads: chunks
                    .into_iter()
                    .map(|chunk| FakeRead::Chunk(chunk.as_ref().to_vec()))
                    .chain(std::iter::once(FakeRead::Eof))
                    .collect(),
                would_block_forever: false,
            }
        }

        fn would_block_forever() -> Self {
            Self {
                reads: VecDeque::new(),
                would_block_forever: true,
            }
        }
    }

    impl Read for FakeReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            match self.reads.pop_front() {
                Some(FakeRead::Chunk(chunk)) => {
                    let len = chunk.len().min(buffer.len());
                    buffer[..len].copy_from_slice(&chunk[..len]);
                    Ok(len)
                }
                Some(FakeRead::Eof) => Ok(0),
                None if self.would_block_forever => {
                    Err(io::Error::new(io::ErrorKind::WouldBlock, "would block"))
                }
                None => Ok(0),
            }
        }
    }

    impl PipeNonblocking for FakeReader {
        fn set_nonblocking(&self) -> Result<(), ToolError> {
            Ok(())
        }
    }

    #[derive(Clone)]
    struct RecordingSink {
        log: Arc<Mutex<Vec<String>>>,
        bytes: Arc<Mutex<Vec<u8>>>,
        fail_record: bool,
    }

    impl RecordingSink {
        fn new(log: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                log,
                bytes: Arc::new(Mutex::new(Vec::new())),
                fail_record: false,
            }
        }

        fn failing(log: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                log,
                bytes: Arc::new(Mutex::new(Vec::new())),
                fail_record: true,
            }
        }

        fn bytes(&self) -> Vec<u8> {
            self.bytes
                .lock()
                .expect("sink bytes mutex poisoned")
                .clone()
        }

        fn snapshot_from_bytes(&self, complete: bool) -> ToolOutputSnapshot {
            let bytes = self.bytes();
            ToolOutputSnapshot {
                tail: String::from_utf8_lossy(&bytes).to_string(),
                output_bytes: bytes.len() as u64,
                output_live: !complete,
                output_complete: complete,
                output_last_updated_at: None,
                artifact_path: None::<PathBuf>,
                output_tail_truncated: false,
                output_artifact_truncated: false,
                output_dropped_bytes: 0,
            }
        }
    }

    impl ToolOutputSink for RecordingSink {
        fn record(&self, bytes: &[u8]) -> Result<ToolOutputSnapshot, ToolError> {
            self.log
                .lock()
                .expect("shared log mutex poisoned")
                .push(format!("sink:{}", String::from_utf8_lossy(bytes)));
            if self.fail_record {
                return Err(ToolError::execution_failed("sink failed"));
            }
            self.bytes
                .lock()
                .expect("sink bytes mutex poisoned")
                .extend_from_slice(bytes);
            Ok(self.snapshot_from_bytes(false))
        }

        fn complete(&self) -> Result<ToolOutputSnapshot, ToolError> {
            Ok(self.snapshot_from_bytes(true))
        }

        fn snapshot(&self) -> ToolOutputSnapshot {
            self.snapshot_from_bytes(false)
        }
    }

    struct RecordingBridge {
        log: Arc<Mutex<Vec<String>>>,
    }

    impl InteractiveStdioBridge for RecordingBridge {
        fn register_stdin_writer(&self, _writer: Arc<dyn TaskStdinWriter>) {}

        fn handle_frame_events(&self, events: Vec<BotifiedFrameEvent>) {
            let mut log = self.log.lock().expect("shared log mutex poisoned");
            for event in events {
                match event {
                    BotifiedFrameEvent::Ask(frame) => {
                        log.push(format!("frame:{}", frame.id));
                    }
                    BotifiedFrameEvent::Tell(frame) => {
                        log.push(format!("tell:{}", frame.id));
                    }
                    BotifiedFrameEvent::Diagnostic(diagnostic) => {
                        log.push(format!("diagnostic:{}", diagnostic.code));
                    }
                    BotifiedFrameEvent::ProtocolDiagnostic(diagnostic) => {
                        log.push(format!("protocol_diagnostic:{}", diagnostic.code));
                    }
                    BotifiedFrameEvent::RegistryDiagnostic(diagnostic) => {
                        log.push(format!("registry_diagnostic:{}", diagnostic.code));
                    }
                    BotifiedFrameEvent::RegistrySet(frame) => {
                        log.push(format!(
                            "registry_set:{}",
                            frame.id.as_deref().unwrap_or("none")
                        ));
                    }
                    BotifiedFrameEvent::RegistryGet(frame) => {
                        log.push(format!("registry_get:{}", frame.id));
                    }
                }
            }
        }
    }

    static BASH_ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct EnvRestore {
        values: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvRestore {
        fn capture(keys: &[&'static str]) -> Self {
            Self {
                values: keys.iter().map(|key| (*key, env::var_os(key))).collect(),
            }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (key, value) in &self.values {
                match value {
                    Some(value) => env::set_var(key, value),
                    None => env::remove_var(key),
                }
            }
        }
    }

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos();
            let path = env::temp_dir().join(format!("botified-{label}-{}-{nanos}", process::id()));
            fs::create_dir_all(&path).expect("temp dir should be created");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn should_inherit_env_key_filters_secrets_and_bash_exported_functions() {
        assert!(!should_inherit_env_key(OsStr::new("OPENAI_API_KEY")));
        assert!(!should_inherit_env_key(OsStr::new("CUSTOM_TOKEN")));
        assert!(!should_inherit_env_key(OsStr::new("BASH_FUNC__longopt%%")));
        assert!(!should_inherit_env_key(OsStr::new("BASH_FUNC_echo%%")));
        assert!(should_inherit_env_key(OsStr::new("BOTIFIED_SAFE_VISIBLE")));
        assert!(should_inherit_env_key(OsStr::new("NOT_BASH_FUNC_echo%%")));
    }

    #[test]
    fn secret_env_cleanup_script_clears_shell_runtime_secrets() {
        let script = format!(
            "\
DEEPSEEK_API_KEY=profile-deepseek-secret
export QWEN_API_KEY=profile-qwen-secret
export BOTIFIED_SAFE_VISIBLE=profile-visible
{}
env | sort
printf 'deepseek:%s\\n' \"${{DEEPSEEK_API_KEY-unset}}\"
printf 'qwen:%s\\n' \"${{QWEN_API_KEY-unset}}\"
",
            secret_env_cleanup_script()
        );
        let output = std::process::Command::new("bash")
            .env_remove("BASH_ENV")
            .arg("-c")
            .arg(script)
            .output()
            .expect("bash command should run");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(output.status.success(), "stdout={stdout}\nstderr={stderr}");
        assert!(!stdout.contains("DEEPSEEK_API_KEY"), "{stdout}");
        assert!(!stdout.contains("QWEN_API_KEY"), "{stdout}");
        assert!(!stdout.contains("profile-deepseek-secret"), "{stdout}");
        assert!(!stdout.contains("profile-qwen-secret"), "{stdout}");
        assert!(stdout.contains("BOTIFIED_SAFE_VISIBLE=profile-visible"));
        assert!(stdout.contains("deepseek:unset"), "{stdout}");
        assert!(stdout.contains("qwen:unset"), "{stdout}");
    }

    #[test]
    fn run_bash_command_ignores_exported_bash_function_environment() {
        let _guard = BASH_ENV_TEST_LOCK
            .lock()
            .expect("bash env test mutex poisoned");
        let key = "BASH_FUNC_echo%%";
        let _restore = EnvRestore::capture(&[key]);
        env::set_var(key, "() { return 2; }");

        let outcome = run_bash_command(
            "echo ok",
            ".",
            Some(Duration::from_secs(2)),
            1024,
            None,
            None,
            CancellationToken::new(),
        )
        .expect("bash command should run");

        assert_eq!(outcome.status.and_then(|status| status.code()), Some(0));
        assert_eq!(String::from_utf8_lossy(&outcome.output.bytes), "ok\n");
        assert!(!outcome.timed_out);
        assert!(!outcome.cancelled);
    }

    #[test]
    fn run_bash_command_captures_startup_stderr_from_bash_env() {
        let _guard = BASH_ENV_TEST_LOCK
            .lock()
            .expect("bash env test mutex poisoned");
        let temp_dir = TempDir::new("bash-startup-stderr");
        let bash_env_path = temp_dir.path.join("bash_env.sh");
        fs::write(&bash_env_path, "printf 'startup stderr\\n' >&2\nexit 2\n")
            .expect("BASH_ENV file should be written");
        let _restore = EnvRestore::capture(&["BASH_ENV"]);
        env::set_var("BASH_ENV", &bash_env_path);
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(RecordingSink::new(log));
        let sink_probe = sink.clone();

        let outcome = run_bash_command(
            "printf 'script stderr\\n' >&2\nprintf 'script stdout\\n'",
            ".",
            Some(Duration::from_secs(2)),
            4096,
            Some(sink),
            None,
            CancellationToken::new(),
        )
        .expect("bash command should run");

        assert_eq!(outcome.status.and_then(|status| status.code()), Some(2));
        let output = String::from_utf8_lossy(&outcome.output.bytes).to_string();
        assert!(output.contains("startup stderr\n"), "{output:?}");
        assert!(!output.contains("script stdout"), "{output:?}");
        let sink_output = String::from_utf8_lossy(&sink_probe.bytes()).to_string();
        assert!(sink_output.contains("startup stderr\n"), "{sink_output:?}");

        let result = format_tool_result("call_1".to_owned(), "bash".to_owned(), outcome, 4096);
        let aggregated_output = result.details["aggregated_output"]
            .as_str()
            .expect("aggregated output should be present");
        assert!(
            aggregated_output.contains("startup stderr\n"),
            "{aggregated_output:?}"
        );
    }

    #[test]
    fn run_bash_command_drains_large_startup_stderr_without_deadlock() {
        let _guard = BASH_ENV_TEST_LOCK
            .lock()
            .expect("bash env test mutex poisoned");
        let temp_dir = TempDir::new("bash-large-startup-stderr");
        let payload_path = temp_dir.path.join("startup_stderr.txt");
        let payload_size = 1024 * 1024;
        let mut payload = vec![b'x'; payload_size];
        payload.extend_from_slice(b"\nstartup stderr done\n");
        fs::write(&payload_path, &payload).expect("startup stderr payload should be written");
        let bash_env_path = temp_dir.path.join("bash_env.sh");
        fs::write(
            &bash_env_path,
            format!(
                "cat '{}' >&2\nexit 2\n",
                payload_path.to_string_lossy().replace('\'', "'\\''")
            ),
        )
        .expect("BASH_ENV file should be written");
        let _restore = EnvRestore::capture(&["BASH_ENV"]);
        env::set_var("BASH_ENV", &bash_env_path);

        let outcome = run_bash_command(
            "printf 'script should not run\\n'",
            ".",
            Some(Duration::from_secs(2)),
            payload_size + 4096,
            None,
            None,
            CancellationToken::new(),
        )
        .expect("bash command should run");

        assert!(!outcome.timed_out);
        assert!(!outcome.cancelled);
        assert_eq!(outcome.status.and_then(|status| status.code()), Some(2));
        assert!(
            outcome.output.bytes.len() >= payload_size,
            "captured {} bytes",
            outcome.output.bytes.len()
        );
        let output = String::from_utf8_lossy(&outcome.output.bytes);
        assert!(output.contains("startup stderr done\n"), "{output:?}");
        assert!(!output.contains("script should not run"), "{output:?}");
    }

    #[test]
    fn output_pump_fans_out_chunk_to_sink_frames_and_tail_in_order() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(RecordingSink::new(log.clone()));
        let bridge = Arc::new(RecordingBridge { log: log.clone() });
        let mut pump = OutputPump::new(
            FakeReader::chunks([
                b"before <botified>{\"op\":\"ask\",\"id\":\"q1\"".as_slice(),
                b",\"message\":\"Need?\",\"expect\":\"yes/no\"}</botified> after".as_slice(),
            ]),
            1024,
            Some(sink),
            Some(bridge),
        )
        .expect("pump should initialize");
        pump.set_tail_update_observer_for_test(Some({
            let log = log.clone();
            Arc::new(move |chunk| {
                log.lock()
                    .expect("shared log mutex poisoned")
                    .push(format!("tail:{}", String::from_utf8_lossy(chunk)));
            })
        }));

        assert!(pump.drain_available().expect("first chunk should drain"));
        assert!(pump.drain_available().expect("second chunk should drain"));

        assert_eq!(
            log.lock().expect("shared log mutex poisoned").as_slice(),
            &[
                "sink:before ",
                "tail:before ",
                "sink: after",
                "tail: after",
                "frame:q1",
            ]
        );
        assert_eq!(
            String::from_utf8_lossy(&pump.complete().expect("complete").output.bytes),
            "before  after"
        );
    }

    #[test]
    fn output_pump_drain_until_deadline_is_bounded_when_pipe_stays_open_without_progress() {
        let mut pump = OutputPump::new(FakeReader::would_block_forever(), 1024, None, None)
            .expect("pump should initialize");
        let started = Instant::now();

        pump.drain_until(Instant::now() + Duration::from_millis(5))
            .expect("deadline drain should return");

        assert!(started.elapsed() < Duration::from_millis(200));
        assert!(!pump.is_closed());
    }

    #[test]
    fn output_pump_sink_error_preserves_current_short_circuit_semantics() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(RecordingSink::failing(log.clone()));
        let bridge = Arc::new(RecordingBridge { log: log.clone() });
        let mut pump = OutputPump::new(
            FakeReader::chunks([
                b"log <botified>{\"op\":\"ask\",\"id\":\"q1\",\"message\":\"Need?\"}</botified>",
            ]),
            1024,
            Some(sink),
            Some(bridge),
        )
        .expect("pump should initialize");
        pump.set_tail_update_observer_for_test(Some({
            let log = log.clone();
            Arc::new(move |chunk| {
                log.lock()
                    .expect("shared log mutex poisoned")
                    .push(format!("tail:{}", String::from_utf8_lossy(chunk)));
            })
        }));

        let error = pump
            .drain_available()
            .expect_err("sink failure should short-circuit");

        assert!(error.to_string().contains("sink failed"));
        assert_eq!(
            log.lock().expect("shared log mutex poisoned").as_slice(),
            &["sink:log "]
        );
        assert!(pump.complete().expect("complete").output.bytes.is_empty());
    }

    #[test]
    fn output_pump_dispatches_frame_only_chunk_without_sink_write() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(RecordingSink::failing(log.clone()));
        let bridge = Arc::new(RecordingBridge { log: log.clone() });
        let mut pump = OutputPump::new(
            FakeReader::chunks([
                b"<botified>{\"op\":\"tell\",\"id\":\"t1\",\"message\":\"ready\"}</botified>",
            ]),
            1024,
            Some(sink),
            Some(bridge),
        )
        .expect("pump should initialize");

        assert!(pump
            .drain_available()
            .expect("frame-only chunk should drain"));

        assert_eq!(
            log.lock().expect("shared log mutex poisoned").as_slice(),
            &["tell:t1"]
        );
        assert!(pump.complete().expect("complete").output.bytes.is_empty());
    }

    #[test]
    fn sync_interactive_bash_result_filters_protocol_frames_from_aggregated_output() {
        let _guard = BASH_ENV_TEST_LOCK
            .lock()
            .expect("bash env test mutex poisoned");
        let _restore = EnvRestore::capture(&["BASH_ENV"]);
        env::remove_var("BASH_ENV");
        let log = Arc::new(Mutex::new(Vec::new()));
        let bridge = Arc::new(RecordingBridge { log: log.clone() });
        let outcome = run_bash_command(
            r#"printf 'alpha '; printf '<botified>{"op":"send","id":"echoed","message":"raw"}</botified>'; printf ' omega\n'"#,
            ".",
            Some(Duration::from_secs(2)),
            4096,
            None,
            Some(bridge),
            CancellationToken::new(),
        )
        .expect("bash command should run");

        let result = format_tool_result("call_1".to_owned(), "bash".to_owned(), outcome, 4096);
        let aggregated_output = result.details["aggregated_output"]
            .as_str()
            .expect("aggregated output should be present");
        assert_eq!(aggregated_output, "alpha  omega\n");
        assert!(result.text.contains("output:\nalpha  omega\n"));
        assert!(!result.text.contains("<botified>"), "{}", result.text);
        assert!(!result.text.contains(r#""op":"send""#), "{}", result.text);
        assert!(
            !aggregated_output.contains("<botified>"),
            "{aggregated_output}"
        );
        assert!(
            !aggregated_output.contains(r#""op":"send""#),
            "{aggregated_output}"
        );
        assert!(
            log.lock()
                .expect("shared log mutex poisoned")
                .iter()
                .any(|entry| entry == "protocol_diagnostic:unsupported_op"),
            "echoed stdin frame should be filtered as an unsupported stdout frame"
        );
    }

    #[test]
    fn executor_protocol_preserves_output_and_uses_loopback_ndjson() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("executor should connect");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("stream should clone"))
                .read_line(&mut request)
                .expect("execute request should read");
            let request: Value = serde_json::from_str(request.trim_end()).expect("execute request should be JSON");
            assert_eq!(request["op"], "execute");
            assert_eq!(request["command"], "printf ignored");
            assert_eq!(request["interactive_stdio"], false);
            writeln!(stream, r#"{{"op":"output","data":"c2lkZWNhciBvdXRwdXQK"}}"#).expect("output should write");
            writeln!(stream, r#"{{"op":"completed","exit_code":0}}"#).expect("completion should write");
        });

        let outcome = run_executor_bash_command(
            "printf ignored", ".", Some(Duration::from_secs(1)), 4096, None, None,
            CancellationToken::new(), addr,
        ).expect("executor command should complete");
        server.join().expect("executor server should finish");
        let result = format_tool_result("call_1".to_owned(), "bash".to_owned(), outcome, 4096);
        assert_eq!(result.details["aggregated_output"], "sidecar output\n");
        assert!(result.text.contains("status: completed\nexit code: 0\n"));
    }

    #[test]
    fn output_pump_tail_truncation_does_not_truncate_sink_bytes() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::new(RecordingSink::new(log));
        let sink_probe = sink.clone();
        let mut pump = OutputPump::new(FakeReader::chunks([b"abcdef"]), 3, Some(sink), None)
            .expect("pump should initialize");

        assert!(pump.drain_available().expect("chunk should drain"));
        let output = pump.complete().expect("complete").output;

        assert_eq!(sink_probe.bytes(), b"abcdef");
        assert_eq!(output.bytes, b"def");
        assert!(output.truncated);
        assert_eq!(output.dropped_bytes, 3);
    }
}
