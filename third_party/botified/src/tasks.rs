use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, TryLockError,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "linux")]
use std::os::{fd::AsRawFd, raw::c_int};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::agent_loop::InputUrgency;
use crate::path_utils::{lexical_absolute, lexical_normalize};
use crate::registry::{RegistryQuery, RegistrySetRequest, RegistryTtl};
use crate::tools::{Tool, ToolError, ToolExecutionContext, ToolOutputSink, ToolSpec};
use crate::types::{ContentPart, ToolCall, ToolResult};

const DEFAULT_OUTPUT_TAIL_LIMIT: usize = 60 * 1024;
const DEFAULT_MAX_RETAINED_TASKS: usize = 128;
const DEFAULT_TASK_RETENTION_SECS: u64 = 86_400;
const TASK_LIST_MAX_TASKS: usize = 64;
const TASK_LIST_ARGUMENT_CHARS: usize = 512;
const TASK_LIST_OUTPUT_TAIL_CHARS: usize = 2048;
const TASK_CANCEL_ARGUMENT_CHARS: usize = 512;
const TASK_CANCEL_OUTPUT_TAIL_CHARS: usize = 2048;
const TASK_CALLBACK_PAYLOAD_TEXT_CHARS: usize = 16 * 1024;
const TASK_CALLBACK_FAILURE_REASON_CHARS: usize = 512;
const TASK_REQUEST_FIELD_CHARS: usize = 2048;
const TASK_REQUEST_TEXT_CHARS: usize = 8 * 1024;
const TASK_REQUEST_DIAGNOSTIC_CHARS: usize = 512;
const DEFAULT_MAX_PENDING_REQUESTS_PER_TASK: usize = 16;
const DEFAULT_MAX_PENDING_REQUESTS_GLOBAL: usize = 64;
const DEFAULT_TASK_REQUEST_DEADLINE_SECS: u64 = 300;
const TASK_REQUEST_ARGUMENT_SUMMARY_CHARS: usize = 512;
pub const DEFAULT_BOTIFIED_FRAME_BYTES: usize = 64 * 1024;
// Linux PIPE_BUF is 4096 bytes; service-to-task stdin control frames stay within it.
pub const TASK_STDIN_CONTROL_FRAME_BYTES: usize = 4 * 1024;
pub const TASK_STDIN_OBSERVE_FRAME_BYTES: usize = TASK_STDIN_CONTROL_FRAME_BYTES;
#[cfg(target_os = "linux")]
pub const OBSERVER_STDIN_ATOMIC_WRITE_BYTES: usize = TASK_STDIN_OBSERVE_FRAME_BYTES;

pub const TASK_LIST_TOOL_NAME: &str = "task_list";
pub const TASK_CANCEL_TOOL_NAME: &str = "task_cancel";
pub const TASK_REPLY_TOOL_NAME: &str = "task_reply";
pub const TASK_SEND_TOOL_NAME: &str = "task_send";
pub const TASK_OBSERVE_TOOL_NAME: &str = "task_observe";

#[cfg(target_os = "linux")]
const F_GETFL: c_int = 3;
#[cfg(target_os = "linux")]
const F_SETFL: c_int = 4;
#[cfg(target_os = "linux")]
const O_NONBLOCK: c_int = 0o4000;

#[cfg(target_os = "linux")]
unsafe extern "C" {
    fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
}

const BOTIFIED_OPEN: &[u8] = b"<botified>";
const BOTIFIED_CLOSE: &[u8] = b"</botified>";
const BOTIFIED_CLOSE_LINE: &[u8] = b"</botified>\n";

static NEXT_TASK_ID_SUFFIX: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskOutputPolicy {
    pub data_dir: PathBuf,
    pub callback_output_tail_bytes: usize,
    pub max_task_output_bytes: usize,
}

impl TaskOutputPolicy {
    pub fn new(
        data_dir: impl Into<PathBuf>,
        callback_output_tail_bytes: usize,
        max_task_output_bytes: usize,
    ) -> Self {
        Self {
            data_dir: data_dir.into(),
            callback_output_tail_bytes,
            max_task_output_bytes,
        }
    }
}

impl Default for TaskOutputPolicy {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from(".botified").join("state"),
            callback_output_tail_bytes: DEFAULT_OUTPUT_TAIL_LIMIT,
            max_task_output_bytes: 16 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Running,
    Completed,
    Failed,
    TimedOut,
    Cancelling,
    Cancelled,
    Lost,
}

impl TaskState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::TimedOut | Self::Cancelled | Self::Lost
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallbackDelivery {
    NotReady,
    Pending,
    Enqueued,
    Delivered,
    Failed,
}

impl CallbackDelivery {
    pub fn requires_retention(self) -> bool {
        matches!(self, Self::Pending | Self::Enqueued | Self::Failed)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskOwner {
    #[default]
    Main,
    Subagent {
        subagent_id: String,
    },
}

impl TaskOwner {
    pub fn subagent(subagent_id: impl Into<String>) -> Self {
        Self::Subagent {
            subagent_id: subagent_id.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct NewBackgroundTask {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments_summary: String,
    pub owner: TaskOwner,
    pub detached_at: Option<SystemTime>,
    pub timeout_at: Option<SystemTime>,
    pub artifact_path: Option<PathBuf>,
    pub cancel_token: CancellationToken,
}

impl NewBackgroundTask {
    pub fn new(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        arguments_summary: impl Into<String>,
    ) -> Self {
        Self {
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            arguments_summary: arguments_summary.into(),
            owner: TaskOwner::default(),
            detached_at: None,
            timeout_at: None,
            artifact_path: None,
            cancel_token: CancellationToken::new(),
        }
    }

    pub fn with_owner(mut self, owner: TaskOwner) -> Self {
        self.owner = owner;
        self
    }

    pub fn with_detached_at(mut self, detached_at: SystemTime) -> Self {
        self.detached_at = Some(detached_at);
        self
    }

    pub fn with_timeout_at(mut self, timeout_at: SystemTime) -> Self {
        self.timeout_at = Some(timeout_at);
        self
    }

    pub fn with_artifact_path(mut self, artifact_path: impl Into<PathBuf>) -> Self {
        self.artifact_path = Some(artifact_path.into());
        self
    }

    pub fn with_cancel_token(mut self, cancel_token: CancellationToken) -> Self {
        self.cancel_token = cancel_token;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskOutputUpdate {
    bytes: Vec<u8>,
    output_bytes_delta: u64,
    output_dropped_bytes_delta: u64,
    output_artifact_truncated: bool,
}

impl TaskOutputUpdate {
    pub fn bytes(bytes: impl AsRef<[u8]>) -> Self {
        let bytes = bytes.as_ref().to_vec();
        let output_bytes_delta = bytes.len() as u64;
        Self {
            bytes,
            output_bytes_delta,
            output_dropped_bytes_delta: 0,
            output_artifact_truncated: false,
        }
    }

    pub fn artifact_progress(
        bytes: impl AsRef<[u8]>,
        output_bytes_delta: u64,
        output_dropped_bytes_delta: u64,
        output_artifact_truncated: bool,
    ) -> Self {
        Self {
            bytes: bytes.as_ref().to_vec(),
            output_bytes_delta,
            output_dropped_bytes_delta,
            output_artifact_truncated,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskOutputSnapshot {
    pub tail: String,
    pub output_bytes: u64,
    pub output_live: bool,
    pub output_complete: bool,
    pub output_last_updated_at: Option<SystemTime>,
    pub artifact_path: Option<PathBuf>,
    pub output_tail_truncated: bool,
    pub output_artifact_truncated: bool,
    pub output_dropped_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskCallbackPayloadSnapshot {
    pub task_id: String,
    pub message_id: String,
    pub content: Vec<ContentPart>,
}

#[derive(Debug, Clone)]
pub struct TaskSnapshot {
    pub task_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments_summary: String,
    pub owner: TaskOwner,
    pub state: TaskState,
    pub started_at: SystemTime,
    pub detached_at: Option<SystemTime>,
    pub timeout_at: Option<SystemTime>,
    pub completed_at: Option<SystemTime>,
    pub callback_delivery: CallbackDelivery,
    pub callback_payload: Option<TaskCallbackPayloadSnapshot>,
    pub callback_failure_reason: Option<String>,
    pub output: TaskOutputSnapshot,
    pub artifact_path: Option<PathBuf>,
    pub cancel_token: CancellationToken,
    pub requests: Vec<TaskRequestSnapshot>,
}

impl TaskSnapshot {
    pub fn requires_callback_retention(&self) -> bool {
        self.callback_delivery.requires_retention()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRequestState {
    Pending,
    Replied,
    Written,
    WriteFailed,
    Expired,
    Rejected,
    TaskTerminal,
}

impl TaskRequestState {
    pub fn is_pending(self) -> bool {
        matches!(self, Self::Pending)
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Pending | Self::Replied)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskRequestSnapshot {
    pub task_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments_summary: String,
    pub owner: TaskOwner,
    pub sender: String,
    pub request_id: String,
    pub request: String,
    pub expect: Option<String>,
    pub urgency: InputUrgency,
    pub state: TaskRequestState,
    pub requested_at: SystemTime,
    pub deadline_at: SystemTime,
    pub requested_timeout: Option<Duration>,
    pub effective_timeout: Duration,
    pub completed_at: Option<SystemTime>,
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRequestFrame {
    pub id: String,
    pub request: String,
    pub expect: Option<String>,
    pub timeout: Option<Duration>,
    pub urgency: InputUrgency,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskTellFrame {
    pub id: String,
    pub message: String,
    pub urgency: InputUrgency,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskRegistrySetFrame {
    pub id: Option<String>,
    pub topic: String,
    pub value: Value,
    pub source: Option<String>,
    pub ttl: RegistryTtl,
    pub freq_hz: Option<f64>,
}

impl TaskRegistrySetFrame {
    pub fn into_request(self, default_source: impl Into<String>) -> RegistrySetRequest {
        let source = self.source.unwrap_or_else(|| default_source.into());
        let mut request = RegistrySetRequest::new(self.topic, self.value, source);
        if self.ttl != RegistryTtl::Default {
            request = request.with_ttl(self.ttl);
        }
        if let Some(freq_hz) = self.freq_hz {
            request = request.with_freq_hz(freq_hz);
        }
        request
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRegistryGetFrame {
    pub id: String,
    pub topic: String,
    pub limit: Option<usize>,
}

impl TaskRegistryGetFrame {
    pub fn query(&self) -> RegistryQuery {
        let mut query = RegistryQuery::new(self.topic.clone());
        if let Some(limit) = self.limit {
            query = query.with_limit(limit);
        }
        query
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskFrameDiagnostic {
    pub op: Option<String>,
    pub code: &'static str,
    pub message: String,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BotifiedFrameEvent {
    Ask(TaskRequestFrame),
    Tell(TaskTellFrame),
    RegistrySet(TaskRegistrySetFrame),
    RegistryGet(TaskRegistryGetFrame),
    Diagnostic(TaskFrameDiagnostic),
    ProtocolDiagnostic(TaskFrameDiagnostic),
    RegistryDiagnostic(TaskFrameDiagnostic),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BotifiedFrameScan {
    pub events: Vec<BotifiedFrameEvent>,
    pub plain_output: Vec<u8>,
}

impl std::ops::Deref for BotifiedFrameScan {
    type Target = Vec<BotifiedFrameEvent>;

    fn deref(&self) -> &Self::Target {
        &self.events
    }
}

#[derive(Debug, Clone)]
pub struct BotifiedFrameScanner {
    buffer: Vec<u8>,
    max_frame_bytes: usize,
}

impl BotifiedFrameScanner {
    pub fn new(max_frame_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_bytes,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> BotifiedFrameScan {
        self.buffer.extend_from_slice(chunk);
        let mut scan = BotifiedFrameScan::default();

        loop {
            let Some(start) = find_bytes(&self.buffer, BOTIFIED_OPEN) else {
                let keep = botified_open_prefix_suffix_len(&self.buffer);
                let emit = self.buffer.len().saturating_sub(keep);
                if emit > 0 {
                    scan.plain_output.extend_from_slice(&self.buffer[..emit]);
                    self.buffer.drain(..emit);
                }
                break;
            };
            if start > 0 {
                scan.plain_output.extend_from_slice(&self.buffer[..start]);
                self.buffer.drain(..start);
            }

            let content_start = BOTIFIED_OPEN.len();
            let Some(relative_end) = find_bytes(&self.buffer[content_start..], BOTIFIED_CLOSE)
            else {
                if let Some(relative_nested_start) =
                    find_bytes(&self.buffer[content_start..], BOTIFIED_OPEN)
                {
                    let nested_start = content_start + relative_nested_start;
                    self.buffer.drain(..nested_start);
                    scan.events.push(malformed_frame_resync_diagnostic());
                    continue;
                }
                if self.buffer.len() > self.max_frame_bytes {
                    self.buffer.clear();
                    scan.events.push(BotifiedFrameEvent::ProtocolDiagnostic(
                        TaskFrameDiagnostic {
                            op: None,
                            code: "frame_too_large",
                            message: "botified frame exceeded size limit".to_owned(),
                            request_id: None,
                        },
                    ));
                }
                break;
            };
            let content_end = content_start + relative_end;
            if content_end.saturating_sub(content_start) > self.max_frame_bytes {
                if let Some(relative_nested_start) =
                    find_bytes(&self.buffer[content_start..content_end], BOTIFIED_OPEN)
                {
                    let nested_start = content_start + relative_nested_start;
                    self.buffer.drain(..nested_start);
                    scan.events.push(malformed_frame_resync_diagnostic());
                    continue;
                }
                self.buffer.drain(..content_end + BOTIFIED_CLOSE.len());
                scan.events.push(BotifiedFrameEvent::ProtocolDiagnostic(
                    TaskFrameDiagnostic {
                        op: None,
                        code: "frame_too_large",
                        message: "botified frame exceeded size limit".to_owned(),
                        request_id: None,
                    },
                ));
                continue;
            }

            let payload = self.buffer[content_start..content_end].to_vec();
            let parsed = parse_botified_frame(&payload);
            if is_malformed_frame_event(&parsed) {
                if let Some(relative_nested_start) = find_bytes(&payload, BOTIFIED_OPEN) {
                    let nested_start = content_start + relative_nested_start;
                    self.buffer.drain(..nested_start);
                    scan.events.push(malformed_frame_resync_diagnostic());
                    continue;
                }
            }
            self.buffer.drain(..content_end + BOTIFIED_CLOSE.len());
            scan.events.push(parsed);
        }

        scan
    }

    pub fn finish(&mut self) -> BotifiedFrameScan {
        let mut scan = BotifiedFrameScan::default();
        if self.buffer.is_empty() {
            return scan;
        }

        if let Some(start) = find_bytes(&self.buffer, BOTIFIED_OPEN) {
            if start > 0 {
                scan.plain_output.extend_from_slice(&self.buffer[..start]);
            }
            self.buffer.clear();
            scan.events.push(BotifiedFrameEvent::ProtocolDiagnostic(
                TaskFrameDiagnostic {
                    op: None,
                    code: "incomplete_frame",
                    message: "discarded incomplete botified frame at EOF".to_owned(),
                    request_id: None,
                },
            ));
            return scan;
        }

        scan.plain_output.extend_from_slice(&self.buffer);
        self.buffer.clear();
        scan
    }
}

impl Default for BotifiedFrameScanner {
    fn default() -> Self {
        Self::new(DEFAULT_BOTIFIED_FRAME_BYTES)
    }
}

fn parse_botified_frame(payload: &[u8]) -> BotifiedFrameEvent {
    let value: Value = match serde_json::from_slice(payload) {
        Ok(value) => value,
        Err(error) => {
            return protocol_frame_diagnostic(
                None,
                "malformed_frame",
                bounded_chars(
                    &format!("invalid botified frame JSON: {error}"),
                    TASK_REQUEST_DIAGNOSTIC_CHARS,
                ),
                None,
            );
        }
    };
    let Some(object) = value.as_object() else {
        return protocol_frame_diagnostic(
            None,
            "malformed_frame",
            "botified frame must be a JSON object",
            None,
        );
    };
    let Some(op) = object.get("op").and_then(Value::as_str) else {
        return protocol_frame_diagnostic(
            None,
            "invalid_op",
            "botified frame op must be a string",
            None,
        );
    };

    match op {
        "ask" | "tell" => parse_task_interaction_frame(op, object),
        "registry_set" => parse_registry_set_frame(object),
        "registry_get" => parse_registry_get_frame(object),
        _ => protocol_frame_diagnostic(
            Some(op),
            "unsupported_op",
            "botified stdout frame op is not supported",
            None,
        ),
    }
}

fn parse_task_interaction_frame(
    op: &str,
    object: &serde_json::Map<String, Value>,
) -> BotifiedFrameEvent {
    let op = op.to_owned();

    let Some(id) = object.get("id").and_then(Value::as_str) else {
        return frame_diagnostic(
            Some(&op),
            "invalid_request_id",
            "botified frame id must be a non-empty string",
            None,
        );
    };
    if !is_task_frame_id_token(id) {
        return frame_diagnostic(
            Some(&op),
            "invalid_request_id",
            "botified frame id must be an ASCII token using letters, digits, '.', '_', ':', or '-'",
            None,
        );
    }
    if id.chars().count() > TASK_REQUEST_FIELD_CHARS {
        return frame_diagnostic(
            Some(&op),
            "id_too_large",
            "botified frame id exceeded size limit",
            None,
        );
    }
    let id = id.to_owned();

    for key in object.keys() {
        let allowed = match op.as_str() {
            "ask" => matches!(
                key.as_str(),
                "op" | "id" | "message" | "expect" | "timeout_secs" | "urgency"
            ),
            "tell" => matches!(key.as_str(), "op" | "id" | "message" | "urgency"),
            _ => false,
        };
        if !allowed {
            return frame_diagnostic(
                Some(&op),
                "unknown_field",
                bounded_chars(
                    &format!("unsupported botified frame field: {key}"),
                    TASK_REQUEST_DIAGNOSTIC_CHARS,
                ),
                Some(id),
            );
        }
    }

    let Some(message) = object.get("message").and_then(Value::as_str) else {
        return frame_diagnostic(
            Some(&op),
            "invalid_message",
            format!("botified {op} message must be a string"),
            Some(id),
        );
    };
    if message.chars().count() > TASK_REQUEST_TEXT_CHARS {
        return frame_diagnostic(
            Some(&op),
            "message_too_large",
            format!("botified {op} message exceeded size limit"),
            Some(id),
        );
    }
    let urgency = match object.get("urgency") {
        Some(Value::String(value)) => match InputUrgency::parse(value) {
            Some(urgency) => urgency,
            None => {
                return frame_diagnostic(
                    Some(&op),
                    "invalid_urgency",
                    "botified frame urgency must be \"normal\" or \"urgent\"",
                    Some(id),
                );
            }
        },
        Some(_) => {
            return frame_diagnostic(
                Some(&op),
                "invalid_urgency",
                "botified frame urgency must be \"normal\" or \"urgent\"",
                Some(id),
            );
        }
        None => InputUrgency::Normal,
    };

    if op == "tell" {
        return BotifiedFrameEvent::Tell(TaskTellFrame {
            id,
            message: message.to_owned(),
            urgency,
        });
    }

    let expect = match object.get("expect").and_then(Value::as_str) {
        Some(value) if value.chars().count() > TASK_REQUEST_FIELD_CHARS => {
            return frame_diagnostic(
                Some(&op),
                "expect_too_large",
                "botified frame expect exceeded size limit",
                Some(id),
            );
        }
        Some(value) => Some(value.to_owned()),
        None => None,
    };
    let timeout = match object.get("timeout_secs") {
        Some(value) => match value.as_f64() {
            Some(seconds) if seconds.is_finite() && seconds > 0.0 => {
                match Duration::try_from_secs_f64(seconds) {
                    Ok(duration) if !duration.is_zero() => Some(duration),
                    Ok(_) | Err(_) => {
                        return frame_diagnostic(
                            Some(&op),
                            "invalid_timeout_secs",
                            "botified frame timeout_secs must be a positive finite number",
                            Some(id),
                        );
                    }
                }
            }
            _ => {
                return frame_diagnostic(
                    Some(&op),
                    "invalid_timeout_secs",
                    "botified frame timeout_secs must be a positive finite number",
                    Some(id),
                );
            }
        },
        None => None,
    };

    BotifiedFrameEvent::Ask(TaskRequestFrame {
        id,
        request: message.to_owned(),
        expect,
        timeout,
        urgency,
    })
}

fn parse_registry_set_frame(object: &serde_json::Map<String, Value>) -> BotifiedFrameEvent {
    let op = "registry_set";
    let id = match optional_registry_frame_id(object, op) {
        Ok(id) => id,
        Err(event) => return *event,
    };
    if let Err(event) = reject_unknown_botified_fields(
        object,
        &[
            "op", "id", "topic", "value", "source", "ttl_secs", "freq_hz",
        ],
        op,
        id.as_deref(),
    ) {
        return *event;
    }
    let Some(topic) = object.get("topic").and_then(Value::as_str) else {
        return registry_frame_diagnostic(
            Some(op),
            "invalid_topic",
            "registry_set topic must be a string",
            id,
        );
    };
    let Some(value) = object.get("value") else {
        return registry_frame_diagnostic(
            Some(op),
            "invalid_value",
            "registry_set value is required",
            id,
        );
    };
    let source = match object.get("source") {
        Some(Value::String(source)) if !source.trim().is_empty() => Some(source.clone()),
        Some(Value::String(_)) => {
            return registry_frame_diagnostic(
                Some(op),
                "invalid_source",
                "registry_set source must be non-empty",
                id,
            );
        }
        Some(_) => {
            return registry_frame_diagnostic(
                Some(op),
                "invalid_source",
                "registry_set source must be a string",
                id,
            );
        }
        None => None,
    };
    let ttl = match object.get("ttl_secs") {
        Some(Value::Null) => {
            return registry_frame_diagnostic(
                Some(op),
                "invalid_ttl",
                "registry_set ttl_secs must be a positive finite number",
                id,
            );
        }
        Some(value) => match value.as_f64() {
            Some(seconds) if seconds.is_finite() && seconds > 0.0 => RegistryTtl::Seconds(seconds),
            Some(_) => {
                return registry_frame_diagnostic(
                    Some(op),
                    "invalid_ttl",
                    "registry_set ttl_secs must be a positive finite number",
                    id,
                );
            }
            None => {
                return registry_frame_diagnostic(
                    Some(op),
                    "invalid_ttl",
                    "registry_set ttl_secs must be a number",
                    id,
                );
            }
        },
        None => RegistryTtl::Default,
    };
    let freq_hz = match object.get("freq_hz") {
        Some(value) => match value.as_f64() {
            Some(freq_hz) if freq_hz.is_finite() && freq_hz >= 0.0 => Some(freq_hz),
            Some(_) => {
                return registry_frame_diagnostic(
                    Some(op),
                    "invalid_frequency",
                    "registry_set freq_hz must be finite and greater than or equal to zero",
                    id,
                );
            }
            None => {
                return registry_frame_diagnostic(
                    Some(op),
                    "invalid_frequency",
                    "registry_set freq_hz must be a number",
                    id,
                );
            }
        },
        None => None,
    };

    BotifiedFrameEvent::RegistrySet(TaskRegistrySetFrame {
        id,
        topic: topic.to_owned(),
        value: value.clone(),
        source,
        ttl,
        freq_hz,
    })
}

fn parse_registry_get_frame(object: &serde_json::Map<String, Value>) -> BotifiedFrameEvent {
    let op = "registry_get";
    let id = match required_registry_frame_id(object, op) {
        Ok(id) => id,
        Err(event) => return *event,
    };
    if let Err(event) =
        reject_unknown_botified_fields(object, &["op", "id", "topic", "limit"], op, Some(&id))
    {
        return *event;
    }
    let Some(topic) = object.get("topic").and_then(Value::as_str) else {
        return registry_frame_diagnostic(
            Some(op),
            "invalid_topic",
            "registry_get topic must be a string",
            Some(id),
        );
    };
    let limit = match object.get("limit") {
        Some(value) => {
            let Some(raw) = value.as_u64() else {
                return registry_frame_diagnostic(
                    Some(op),
                    "invalid_limit",
                    "registry_get limit must be an integer",
                    Some(id),
                );
            };
            if raw == 0 {
                return registry_frame_diagnostic(
                    Some(op),
                    "invalid_limit",
                    "registry_get limit must be a positive integer",
                    Some(id),
                );
            }
            match usize::try_from(raw) {
                Ok(limit) => Some(limit),
                Err(_) => {
                    return registry_frame_diagnostic(
                        Some(op),
                        "invalid_limit",
                        "registry_get limit is too large",
                        Some(id),
                    );
                }
            }
        }
        None => None,
    };

    BotifiedFrameEvent::RegistryGet(TaskRegistryGetFrame {
        id,
        topic: topic.to_owned(),
        limit,
    })
}

fn frame_diagnostic(
    op: Option<&str>,
    code: &'static str,
    message: impl Into<String>,
    request_id: Option<String>,
) -> BotifiedFrameEvent {
    BotifiedFrameEvent::Diagnostic(TaskFrameDiagnostic {
        op: op.map(ToOwned::to_owned),
        code,
        message: bounded_chars(&message.into(), TASK_REQUEST_DIAGNOSTIC_CHARS),
        request_id,
    })
}

fn protocol_frame_diagnostic(
    op: Option<&str>,
    code: &'static str,
    message: impl Into<String>,
    request_id: Option<String>,
) -> BotifiedFrameEvent {
    BotifiedFrameEvent::ProtocolDiagnostic(TaskFrameDiagnostic {
        op: op.map(ToOwned::to_owned),
        code,
        message: bounded_chars(&message.into(), TASK_REQUEST_DIAGNOSTIC_CHARS),
        request_id,
    })
}

fn registry_frame_diagnostic(
    op: Option<&str>,
    code: &'static str,
    message: impl Into<String>,
    request_id: Option<String>,
) -> BotifiedFrameEvent {
    BotifiedFrameEvent::RegistryDiagnostic(TaskFrameDiagnostic {
        op: op.map(ToOwned::to_owned),
        code,
        message: bounded_chars(&message.into(), TASK_REQUEST_DIAGNOSTIC_CHARS),
        request_id,
    })
}

fn optional_registry_frame_id(
    object: &serde_json::Map<String, Value>,
    op: &'static str,
) -> Result<Option<String>, Box<BotifiedFrameEvent>> {
    let Some(value) = object.get("id") else {
        return Ok(None);
    };
    let Some(id) = value.as_str() else {
        return Err(Box::new(registry_frame_diagnostic(
            Some(op),
            "invalid_request_id",
            "botified frame id must be a non-empty string",
            None,
        )));
    };
    validate_registry_frame_id(op, id).map(Some)
}

fn required_registry_frame_id(
    object: &serde_json::Map<String, Value>,
    op: &'static str,
) -> Result<String, Box<BotifiedFrameEvent>> {
    let Some(id) = optional_registry_frame_id(object, op)? else {
        return Err(Box::new(registry_frame_diagnostic(
            Some(op),
            "invalid_request_id",
            "botified frame id must be a non-empty string",
            None,
        )));
    };
    Ok(id)
}

fn validate_registry_frame_id(
    op: &'static str,
    id: &str,
) -> Result<String, Box<BotifiedFrameEvent>> {
    if !is_task_frame_id_token(id) {
        return Err(Box::new(registry_frame_diagnostic(
            Some(op),
            "invalid_request_id",
            "botified frame id must be an ASCII token using letters, digits, '.', '_', ':', or '-'",
            None,
        )));
    }
    if id.chars().count() > TASK_REQUEST_FIELD_CHARS {
        return Err(Box::new(registry_frame_diagnostic(
            Some(op),
            "id_too_large",
            "botified frame id exceeded size limit",
            None,
        )));
    }
    Ok(id.to_owned())
}

fn reject_unknown_botified_fields(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    op: &str,
    request_id: Option<&str>,
) -> Result<(), Box<BotifiedFrameEvent>> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(Box::new(registry_frame_diagnostic(
                Some(op),
                "unknown_field",
                bounded_chars(
                    &format!("unsupported botified frame field: {key}"),
                    TASK_REQUEST_DIAGNOSTIC_CHARS,
                ),
                request_id.map(ToOwned::to_owned),
            )));
        }
    }
    Ok(())
}

fn is_malformed_frame_event(event: &BotifiedFrameEvent) -> bool {
    matches!(
        event,
        BotifiedFrameEvent::Diagnostic(diagnostic)
            | BotifiedFrameEvent::ProtocolDiagnostic(diagnostic)
            | BotifiedFrameEvent::RegistryDiagnostic(diagnostic)
            if diagnostic.code == "malformed_frame"
    )
}

fn malformed_frame_resync_diagnostic() -> BotifiedFrameEvent {
    BotifiedFrameEvent::ProtocolDiagnostic(TaskFrameDiagnostic {
        op: None,
        code: "malformed_frame",
        message: "discarded malformed botified frame before nested open tag".to_owned(),
        request_id: None,
    })
}

fn is_task_frame_id_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn botified_open_prefix_suffix_len(value: &[u8]) -> usize {
    let max = value.len().min(BOTIFIED_OPEN.len() - 1);
    (1..=max)
        .rev()
        .find(|len| value[value.len() - len..] == BOTIFIED_OPEN[..*len])
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStdinFrameKind {
    Reply,
    Send,
    Registry,
    Observe,
}

impl TaskStdinFrameKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::Send => "send",
            Self::Registry => "registry",
            Self::Observe => "observe",
        }
    }

    fn byte_cap(self) -> usize {
        match self {
            Self::Reply | Self::Send | Self::Registry => TASK_STDIN_CONTROL_FRAME_BYTES,
            Self::Observe => TASK_STDIN_OBSERVE_FRAME_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskStdinWriteSuccess {
    pub diagnostic: Option<String>,
}

impl TaskStdinWriteSuccess {
    pub fn delivered() -> Self {
        Self { diagnostic: None }
    }

    pub fn delivered_with_diagnostic(diagnostic: impl Into<String>) -> Self {
        Self {
            diagnostic: Some(diagnostic.into()),
        }
    }
}

pub fn validate_task_stdin_frame(kind: TaskStdinFrameKind, bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(BOTIFIED_OPEN) || !bytes.ends_with(BOTIFIED_CLOSE_LINE) {
        return Err(format!(
            "{} stdin frame is not a complete botified frame",
            kind.as_str()
        ));
    }
    let cap = kind.byte_cap();
    if bytes.len() > cap {
        return Err(format!(
            "{} stdin frame exceeds control frame byte limit: {} > {} bytes",
            kind.as_str(),
            bytes.len(),
            cap
        ));
    }
    Ok(())
}

pub fn try_write_task_stdin_frame(
    writer: &dyn TaskStdinWriter,
    kind: TaskStdinFrameKind,
    bytes: &[u8],
) -> Result<TaskStdinWriteSuccess, String> {
    validate_task_stdin_frame(kind, bytes)?;
    match kind {
        TaskStdinFrameKind::Observe => writer
            .try_write_observer_stdin(bytes)
            .map(|_| TaskStdinWriteSuccess::delivered()),
        TaskStdinFrameKind::Reply | TaskStdinFrameKind::Send | TaskStdinFrameKind::Registry => {
            writer.try_write_priority_stdin(bytes)
        }
    }
}

pub trait TaskStdinWriter: Send + Sync {
    fn write_stdin(&self, bytes: &[u8]) -> Result<(), String>;

    fn supports_priority_stdin(&self) -> bool {
        false
    }

    fn try_write_priority_stdin(&self, _bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        Err("priority stdin writes are unsupported".to_owned())
    }

    fn supports_observer_stdin(&self) -> bool {
        false
    }

    fn try_write_observer_stdin(&self, _bytes: &[u8]) -> Result<(), String> {
        Err("low-priority observe stdin writes are unsupported".to_owned())
    }
}

pub trait InteractiveStdioBridge: Send + Sync {
    fn register_stdin_writer(&self, writer: Arc<dyn TaskStdinWriter>);

    fn handle_frame_events(&self, events: Vec<BotifiedFrameEvent>);
}

#[derive(Debug)]
pub struct SharedTaskStdinWriter<W> {
    writer: Mutex<W>,
    verified_try_write: bool,
}

impl<W> SharedTaskStdinWriter<W> {
    pub fn new(writer: W) -> Self {
        Self {
            writer: Mutex::new(writer),
            verified_try_write: false,
        }
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn new_verified_pipe(writer: W) -> Self {
        Self {
            writer: Mutex::new(writer),
            verified_try_write: true,
        }
    }
}

#[cfg(target_os = "linux")]
impl<W> TaskStdinWriter for SharedTaskStdinWriter<W>
where
    W: Write + Send + AsRawFd,
{
    fn write_stdin(&self, bytes: &[u8]) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "stdin writer lock poisoned".to_owned())?;
        writer
            .write_all(bytes)
            .and_then(|_| writer.flush())
            .map_err(|error| error.to_string())
    }

    fn supports_priority_stdin(&self) -> bool {
        self.verified_try_write
    }

    fn try_write_priority_stdin(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        if !self.verified_try_write {
            return Err("priority stdin writes are unsupported for unverified writer".to_owned());
        }
        if bytes.len() > TASK_STDIN_CONTROL_FRAME_BYTES {
            return Err(format!(
                "priority stdin frame exceeds atomic write limit: {} > {} bytes",
                bytes.len(),
                TASK_STDIN_CONTROL_FRAME_BYTES
            ));
        }
        let mut writer = match self.writer.try_lock() {
            Ok(writer) => writer,
            Err(TryLockError::WouldBlock) => {
                return Err("stdin writer is busy with another stdin write".to_owned());
            }
            Err(TryLockError::Poisoned(_)) => return Err("stdin writer lock poisoned".to_owned()),
        };
        try_write_nonblocking_stdin(&mut *writer, bytes)
    }

    fn supports_observer_stdin(&self) -> bool {
        self.verified_try_write
    }

    fn try_write_observer_stdin(&self, bytes: &[u8]) -> Result<(), String> {
        if !self.verified_try_write {
            return Err(
                "low-priority observe stdin writes are unsupported for unverified writer"
                    .to_owned(),
            );
        }
        if bytes.len() > TASK_STDIN_OBSERVE_FRAME_BYTES {
            return Err(format!(
                "observe stdin frame exceeds low-priority atomic write limit: {} > {} bytes",
                bytes.len(),
                TASK_STDIN_OBSERVE_FRAME_BYTES
            ));
        }
        // Observer delivery is best-effort; busy priority stdin fails closed so reply/send keep the writer.
        let mut writer = match self.writer.try_lock() {
            Ok(writer) => writer,
            Err(TryLockError::WouldBlock) => {
                return Err("stdin writer is busy with priority input".to_owned());
            }
            Err(TryLockError::Poisoned(_)) => return Err("stdin writer lock poisoned".to_owned()),
        };
        try_write_nonblocking_stdin(&mut *writer, bytes).map(|_| ())
    }
}

#[cfg(not(target_os = "linux"))]
impl<W> TaskStdinWriter for SharedTaskStdinWriter<W>
where
    W: Write + Send,
{
    fn write_stdin(&self, bytes: &[u8]) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "stdin writer lock poisoned".to_owned())?;
        writer
            .write_all(bytes)
            .and_then(|_| writer.flush())
            .map_err(|error| error.to_string())
    }

    fn supports_observer_stdin(&self) -> bool {
        false
    }

    fn try_write_observer_stdin(&self, _bytes: &[u8]) -> Result<(), String> {
        Err("low-priority observe stdin writes are unsupported on this platform".to_owned())
    }
}

#[cfg(target_os = "linux")]
fn try_write_nonblocking_stdin<W>(
    writer: &mut W,
    bytes: &[u8],
) -> Result<TaskStdinWriteSuccess, String>
where
    W: Write + AsRawFd,
{
    let fd = writer.as_raw_fd();
    // SAFETY: fcntl is called with a valid stdin pipe fd owned by the writer.
    let flags = unsafe { fcntl(fd, F_GETFL) };
    if flags < 0 {
        return Err(format!(
            "failed to read stdin writer flags: {}",
            io::Error::last_os_error()
        ));
    }
    // SAFETY: fcntl updates the valid pipe fd flags while the shared writer mutex is held.
    let set_result = unsafe { fcntl(fd, F_SETFL, flags | O_NONBLOCK) };
    if set_result < 0 {
        return Err(format!(
            "failed to set stdin writer nonblocking: {}",
            io::Error::last_os_error()
        ));
    }

    let write_result = loop {
        match writer.write(bytes) {
            Ok(written) if written == bytes.len() => break Ok(TaskStdinWriteSuccess::delivered()),
            Ok(written) => {
                break Err(format!(
                    "short nonblocking stdin write: {written}/{} bytes",
                    bytes.len()
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                // A full pipe also fails closed instead of waiting behind priority reply/send traffic.
                break Err("stdin writer would block".to_owned());
            }
            Err(error) => break Err(error.to_string()),
        }
    };

    // SAFETY: restore the flags read from the same valid fd before releasing the mutex.
    let restore_result = unsafe { fcntl(fd, F_SETFL, flags) };
    if restore_result < 0 {
        let restore_error = format!(
            "failed to restore stdin writer flags: {}",
            io::Error::last_os_error()
        );
        return match write_result {
            Ok(_) => Ok(TaskStdinWriteSuccess::delivered_with_diagnostic(
                restore_error,
            )),
            Err(error) => Err(format!("{error}; {restore_error}")),
        };
    }

    write_result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct SyncFallbackRecordingWriter {
        sync_called: Arc<std::sync::atomic::AtomicBool>,
    }

    impl TaskStdinWriter for SyncFallbackRecordingWriter {
        fn write_stdin(&self, _bytes: &[u8]) -> Result<(), String> {
            self.sync_called
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn default_try_write_capabilities_are_unsupported_without_sync_fallback() {
        let writer = SyncFallbackRecordingWriter::default();
        let frame = b"<botified>{\"op\":\"send\",\"id\":\"s1\",\"message\":\"hello\"}</botified>\n";

        let priority_error = writer
            .try_write_priority_stdin(frame)
            .expect_err("priority try-write should be explicitly unsupported by default");
        assert!(priority_error.contains("unsupported"), "{priority_error}");

        let observer_error = writer
            .try_write_observer_stdin(frame)
            .expect_err("observer try-write should be explicitly unsupported by default");
        assert!(observer_error.contains("unsupported"), "{observer_error}");

        assert!(
            !writer.sync_called.load(std::sync::atomic::Ordering::SeqCst),
            "try-write defaults must not fall back to synchronous write_stdin"
        );
    }

    #[cfg(target_os = "linux")]
    mod linux_shared_stdin_writer {
        use super::*;
        use std::fs::File;
        use std::io::Read;
        use std::os::fd::{FromRawFd, RawFd};
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Condvar,
        };
        use std::time::{Duration, Instant};

        unsafe extern "C" {
            fn pipe(fds: *mut c_int) -> c_int;
        }

        struct BlockingRecordingWriter {
            fd: File,
            state: Arc<BlockingRecordingState>,
        }

        struct BlockingRecordingState {
            started: Mutex<bool>,
            release: Condvar,
            released: AtomicBool,
            bytes: Mutex<Vec<u8>>,
        }

        impl BlockingRecordingState {
            fn new() -> Arc<Self> {
                Arc::new(Self {
                    started: Mutex::new(false),
                    release: Condvar::new(),
                    released: AtomicBool::new(false),
                    bytes: Mutex::new(Vec::new()),
                })
            }

            fn wait_until_started(&self) {
                let mut started = self.started.lock().expect("started mutex poisoned");
                while !*started {
                    started = self
                        .release
                        .wait(started)
                        .expect("started condvar wait failed");
                }
            }

            fn release(&self) {
                self.released.store(true, Ordering::SeqCst);
                self.release.notify_all();
            }

            fn bytes(&self) -> Vec<u8> {
                self.bytes.lock().expect("bytes mutex poisoned").clone()
            }
        }

        impl Write for BlockingRecordingWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                {
                    let mut started = self.state.started.lock().expect("started mutex poisoned");
                    *started = true;
                    self.state.release.notify_all();
                }
                let mut started = self.state.started.lock().expect("started mutex poisoned");
                while !self.state.released.load(Ordering::SeqCst) {
                    started = self
                        .state
                        .release
                        .wait(started)
                        .expect("release condvar wait failed");
                }
                self.state
                    .bytes
                    .lock()
                    .expect("bytes mutex poisoned")
                    .extend_from_slice(bytes);
                Ok(bytes.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        impl AsRawFd for BlockingRecordingWriter {
            fn as_raw_fd(&self) -> RawFd {
                self.fd.as_raw_fd()
            }
        }

        fn pipe_files() -> (File, File) {
            let mut fds = [-1; 2];
            // SAFETY: pipe writes two valid fds into the provided array on success.
            let result = unsafe { pipe(fds.as_mut_ptr()) };
            assert_eq!(
                result,
                0,
                "pipe should succeed: {}",
                io::Error::last_os_error()
            );
            // SAFETY: pipe returned owned file descriptors.
            let read = unsafe { File::from_raw_fd(fds[0]) };
            // SAFETY: pipe returned owned file descriptors.
            let write = unsafe { File::from_raw_fd(fds[1]) };
            (read, write)
        }

        fn set_nonblocking(file: &File) {
            let fd = file.as_raw_fd();
            // SAFETY: fcntl is called with a valid fd.
            let flags = unsafe { fcntl(fd, F_GETFL) };
            assert!(
                flags >= 0,
                "F_GETFL should succeed: {}",
                io::Error::last_os_error()
            );
            // SAFETY: fcntl updates flags for the same valid fd.
            let result = unsafe { fcntl(fd, F_SETFL, flags | O_NONBLOCK) };
            assert_eq!(
                result,
                0,
                "F_SETFL should succeed: {}",
                io::Error::last_os_error()
            );
        }

        #[test]
        fn unverified_shared_writer_does_not_advertise_try_write_for_arbitrary_fd() {
            let writer =
                SharedTaskStdinWriter::new(File::open("/dev/null").expect("open /dev/null"));
            assert!(!writer.supports_priority_stdin());
            assert!(!writer.supports_observer_stdin());

            let priority_error = writer
                .try_write_priority_stdin(
                    b"<botified>{\"op\":\"send\",\"id\":\"s1\",\"message\":\"hello\"}</botified>\n",
                )
                .expect_err("unverified writer should not support priority try-write");
            assert!(priority_error.contains("unsupported"), "{priority_error}");

            let observer_error = writer
                .try_write_observer_stdin(b"<botified>{\"op\":\"observe\"}</botified>\n")
                .expect_err("unverified writer should not support observer try-write");
            assert!(observer_error.contains("unsupported"), "{observer_error}");
        }

        #[test]
        fn observer_try_write_returns_busy_without_waiting_or_partial_write() {
            let state = BlockingRecordingState::new();
            let fd = File::open("/dev/null").expect("open /dev/null");
            let writer = Arc::new(SharedTaskStdinWriter::new_verified_pipe(
                BlockingRecordingWriter {
                    fd,
                    state: state.clone(),
                },
            ));
            assert!(writer.supports_observer_stdin());
            let priority_writer = writer.clone();
            let priority = std::thread::spawn(move || priority_writer.write_stdin(b"priority\n"));
            state.wait_until_started();

            let started = Instant::now();
            let error = writer
                .try_write_observer_stdin(b"<botified>{\"op\":\"observe\"}</botified>\n")
                .expect_err("observe write should fail while priority write owns the lock");
            let elapsed = started.elapsed();
            assert!(
                elapsed < Duration::from_millis(100),
                "observe try write waited for {elapsed:?}"
            );
            assert!(
                error.contains("busy"),
                "busy error should be explicit, got {error}"
            );
            assert_eq!(
                state.bytes(),
                b"",
                "observe write must not write partial bytes"
            );

            state.release();
            priority
                .join()
                .expect("priority thread should not panic")
                .expect("priority write should remain reliable");
            assert_eq!(state.bytes(), b"priority\n");
        }

        #[test]
        fn priority_try_write_returns_busy_without_waiting_or_partial_write() {
            let state = BlockingRecordingState::new();
            let fd = File::open("/dev/null").expect("open /dev/null");
            let writer = Arc::new(SharedTaskStdinWriter::new_verified_pipe(
                BlockingRecordingWriter {
                    fd,
                    state: state.clone(),
                },
            ));
            assert!(writer.supports_priority_stdin());
            let sync_writer = writer.clone();
            let sync_write = std::thread::spawn(move || sync_writer.write_stdin(b"priority\n"));
            state.wait_until_started();

            let started = Instant::now();
            let error = writer
                .try_write_priority_stdin(
                    b"<botified>{\"op\":\"send\",\"id\":\"s1\",\"message\":\"hello\"}</botified>\n",
                )
                .expect_err("priority try-write should fail while the writer lock is busy");
            let elapsed = started.elapsed();
            assert!(
                elapsed < Duration::from_millis(100),
                "priority try-write waited for {elapsed:?}"
            );
            assert!(
                error.contains("busy"),
                "busy error should be explicit, got {error}"
            );
            assert_eq!(
                state.bytes(),
                b"",
                "failed priority try-write must not write partial bytes"
            );

            state.release();
            sync_write
                .join()
                .expect("sync writer thread should not panic")
                .expect("sync write should complete after release");
            assert_eq!(state.bytes(), b"priority\n");
        }

        #[test]
        fn observer_try_write_to_full_pipe_fails_without_partial_bytes() {
            let (mut read, write) = pipe_files();
            let writer = SharedTaskStdinWriter::new_verified_pipe(write);
            let fill = vec![b'x'; OBSERVER_STDIN_ATOMIC_WRITE_BYTES];
            let observe = vec![b'o'; OBSERVER_STDIN_ATOMIC_WRITE_BYTES];
            let mut filled = 0usize;

            loop {
                match writer.try_write_observer_stdin(&fill) {
                    Ok(()) => filled += fill.len(),
                    Err(error) if error.contains("would block") => break,
                    Err(error) => panic!("unexpected fill error: {error}"),
                }
            }
            assert!(filled > 0, "pipe should accept at least one atomic write");

            let error = writer
                .try_write_observer_stdin(&observe)
                .expect_err("full pipe should reject the whole observer write");
            assert!(
                error.contains("would block"),
                "full pipe should report would block, got {error}"
            );

            let mut drained = vec![0u8; filled];
            read.read_exact(&mut drained)
                .expect("read back filled pipe bytes");
            assert!(
                drained.iter().all(|byte| *byte == b'x'),
                "observer bytes must not appear after a failed atomic write"
            );
            set_nonblocking(&read);
            let mut extra = [0u8; 1];
            let error = read
                .read(&mut extra)
                .expect_err("pipe should contain no trailing partial observer byte");
            assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        }

        #[test]
        fn priority_try_write_to_full_pipe_fails_without_partial_bytes() {
            let (mut read, write) = pipe_files();
            let writer = SharedTaskStdinWriter::new_verified_pipe(write);
            let fill = vec![b'x'; TASK_STDIN_CONTROL_FRAME_BYTES];
            let priority = vec![b'p'; TASK_STDIN_CONTROL_FRAME_BYTES];
            let mut filled = 0usize;

            loop {
                match writer.try_write_priority_stdin(&fill) {
                    Ok(_) => filled += fill.len(),
                    Err(error) if error.contains("would block") => break,
                    Err(error) => panic!("unexpected fill error: {error}"),
                }
            }
            assert!(filled > 0, "pipe should accept at least one atomic write");

            let error = writer
                .try_write_priority_stdin(&priority)
                .expect_err("full pipe should reject the whole priority write");
            assert!(
                error.contains("would block"),
                "full pipe should report would block, got {error}"
            );

            let mut drained = vec![0u8; filled];
            read.read_exact(&mut drained)
                .expect("read back filled pipe bytes");
            assert!(
                drained.iter().all(|byte| *byte == b'x'),
                "priority bytes must not appear after a failed atomic write"
            );
            set_nonblocking(&read);
            let mut extra = [0u8; 1];
            let error = read
                .read(&mut extra)
                .expect_err("pipe should contain no trailing partial priority byte");
            assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        }

        struct ShortWriteWriter {
            fd: File,
        }

        impl Write for ShortWriteWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                Ok(bytes.len().saturating_sub(1))
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        impl AsRawFd for ShortWriteWriter {
            fn as_raw_fd(&self) -> RawFd {
                self.fd.as_raw_fd()
            }
        }

        #[test]
        fn priority_try_write_short_write_fails() {
            let writer = SharedTaskStdinWriter::new_verified_pipe(ShortWriteWriter {
                fd: File::open("/dev/null").expect("open /dev/null"),
            });
            let error = writer
                .try_write_priority_stdin(
                    b"<botified>{\"op\":\"send\",\"id\":\"s1\",\"message\":\"hello\"}</botified>\n",
                )
                .expect_err("short write should fail");
            assert!(error.contains("short"), "{error}");
        }

        struct CloseBeforeRestoreWriter {
            fd: Option<File>,
        }

        impl Write for CloseBeforeRestoreWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                let mut fd = self.fd.take().expect("fd should still be open");
                let written = fd.write(bytes)?;
                drop(fd);
                Ok(written)
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        impl AsRawFd for CloseBeforeRestoreWriter {
            fn as_raw_fd(&self) -> RawFd {
                self.fd
                    .as_ref()
                    .expect("fd should still be open")
                    .as_raw_fd()
            }
        }

        #[test]
        fn priority_try_write_restore_failure_is_delivered_with_diagnostic() {
            let (mut read, write) = pipe_files();
            let writer = SharedTaskStdinWriter::new_verified_pipe(CloseBeforeRestoreWriter {
                fd: Some(write),
            });
            let frame =
                b"<botified>{\"op\":\"send\",\"id\":\"s1\",\"message\":\"hello\"}</botified>\n";

            let delivered = writer
                .try_write_priority_stdin(frame)
                .expect("complete write should remain delivered when flag restore fails");
            let diagnostic = delivered
                .diagnostic
                .expect("restore failure should be returned as a diagnostic");
            assert!(diagnostic.contains("restore"), "{diagnostic}");

            let mut drained = vec![0u8; frame.len()];
            read.read_exact(&mut drained)
                .expect("delivered frame should be readable");
            assert_eq!(drained, frame);
        }
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn shared_observer_try_write_is_unsupported_off_linux() {
        let writer = SharedTaskStdinWriter::new(Vec::<u8>::new());
        assert!(!writer.supports_observer_stdin());
        let error = writer
            .try_write_observer_stdin(b"<botified>{\"op\":\"observe\"}</botified>\n")
            .expect_err("low-priority observer writes should be unsupported off Linux");
        assert!(error.contains("unsupported"), "{error}");
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskRequestAdmission {
    Accepted(TaskRequestSnapshot),
    Duplicate(TaskRequestSnapshot),
    Rejected(TaskRequestSnapshot),
    TaskMissing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskReplyStatus {
    Written,
    Failed,
    UnknownTask,
    UnknownRequest,
    AlreadyResolved,
    Expired,
    TaskTerminal,
    ResponseTooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskStdinIntentKind {
    Response,
    Exception { code: &'static str },
    Send,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskStdinIntent {
    pub task_id: String,
    pub request_id: String,
    pub frame: String,
    pub kind: TaskStdinIntentKind,
}

impl TaskStdinIntent {
    pub fn response(task_id: &str, request_id: &str, response: &str) -> Self {
        Self {
            task_id: task_id.to_owned(),
            request_id: request_id.to_owned(),
            frame: task_response_frame(request_id, response, false),
            kind: TaskStdinIntentKind::Response,
        }
    }

    pub fn exception(task_id: &str, request_id: &str, code: &'static str, message: &str) -> Self {
        Self {
            task_id: task_id.to_owned(),
            request_id: request_id.to_owned(),
            frame: task_exception_frame(request_id, code, message),
            kind: TaskStdinIntentKind::Exception { code },
        }
    }

    pub fn send(task_id: &str, send_id: &str, message: &str) -> Self {
        Self {
            task_id: task_id.to_owned(),
            request_id: send_id.to_owned(),
            frame: task_send_frame(send_id, message),
            kind: TaskStdinIntentKind::Send,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskReplyPlan {
    ReadyToWrite {
        snapshot: TaskRequestSnapshot,
        stdin_intents: Vec<TaskStdinIntent>,
    },
    Finished(TaskReplyOutcome),
}

impl TaskReplyPlan {
    fn ready(snapshot: TaskRequestSnapshot, intent: TaskStdinIntent) -> Self {
        Self::ReadyToWrite {
            snapshot,
            stdin_intents: vec![intent],
        }
    }

    fn finished(outcome: TaskReplyOutcome) -> Self {
        Self::Finished(outcome)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskReplyOutcome {
    pub status: TaskReplyStatus,
    pub snapshot: Option<TaskRequestSnapshot>,
    pub task_id: Option<String>,
    pub request_id: Option<String>,
    pub message: String,
    pub effects: Vec<TaskRequestEffect>,
}

impl TaskReplyOutcome {
    fn new(
        status: TaskReplyStatus,
        snapshot: Option<TaskRequestSnapshot>,
        message: impl Into<String>,
    ) -> Self {
        let task_id = snapshot.as_ref().map(|snapshot| snapshot.task_id.clone());
        let request_id = snapshot
            .as_ref()
            .map(|snapshot| snapshot.request_id.clone());
        Self {
            status,
            snapshot,
            task_id,
            request_id,
            message: message.into(),
            effects: Vec::new(),
        }
    }

    fn with_request_ids(mut self, task_id: &str, request_id: &str) -> Self {
        if self.task_id.is_none() {
            self.task_id = Some(task_id.to_owned());
        }
        if self.request_id.is_none() {
            self.request_id = Some(request_id.to_owned());
        }
        self
    }

    fn with_effect(mut self, effect: TaskRequestEffect) -> Self {
        self.effects.push(effect);
        self
    }

    pub fn ok(&self) -> bool {
        matches!(self.status, TaskReplyStatus::Written)
    }

    pub fn rejected(task_id: &str, request_id: &str, message: impl Into<String>) -> Self {
        Self::new(TaskReplyStatus::Failed, None, message).with_request_ids(task_id, request_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRequestResolution {
    pub snapshot: TaskRequestSnapshot,
    pub effects: Vec<TaskRequestEffect>,
}

impl TaskRequestResolution {
    fn new(snapshot: TaskRequestSnapshot, effects: Vec<TaskRequestEffect>) -> Self {
        Self { snapshot, effects }
    }
}

#[derive(Debug, Clone)]
pub struct TaskFinalization {
    pub snapshot: TaskSnapshot,
    pub pending_request_effects: Vec<TaskRequestEffect>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRequestEffect {
    pub event_type: &'static str,
    pub snapshot: TaskRequestSnapshot,
    pub stdin_intents: Vec<TaskStdinIntent>,
}

fn expired_task_request_effect(snapshot: TaskRequestSnapshot) -> TaskRequestEffect {
    let intent = TaskStdinIntent::exception(
        &snapshot.task_id,
        &snapshot.request_id,
        "ask_expired",
        "task ask expired",
    );
    TaskRequestEffect {
        event_type: "task_ask.expired",
        snapshot,
        stdin_intents: vec![intent],
    }
}

fn terminal_task_request_effect(
    snapshot: TaskRequestSnapshot,
    message: impl Into<String>,
) -> TaskRequestEffect {
    let message = message.into();
    let intent = TaskStdinIntent::exception(
        &snapshot.task_id,
        &snapshot.request_id,
        "task_terminal",
        &message,
    );
    TaskRequestEffect {
        event_type: "task_ask.rejected",
        snapshot,
        stdin_intents: vec![intent],
    }
}

fn rejected_task_request_effect(
    snapshot: TaskRequestSnapshot,
    code: &'static str,
    message: &str,
) -> TaskRequestEffect {
    let intent = TaskStdinIntent::exception(&snapshot.task_id, &snapshot.request_id, code, message);
    TaskRequestEffect {
        event_type: "task_ask.rejected",
        snapshot,
        stdin_intents: vec![intent],
    }
}

#[derive(Debug)]
pub struct BackgroundTaskManager {
    inner: Mutex<BackgroundTaskManagerInner>,
    output_tail_limit: usize,
    max_retained_tasks: usize,
    task_retention: Duration,
    task_request_deadline: Duration,
}

impl BackgroundTaskManager {
    pub fn new() -> Self {
        Self::with_output_tail_limit(DEFAULT_OUTPUT_TAIL_LIMIT)
    }

    pub fn with_output_tail_limit(output_tail_limit: usize) -> Self {
        Self::with_limits(
            output_tail_limit,
            DEFAULT_MAX_RETAINED_TASKS,
            Duration::from_secs(DEFAULT_TASK_RETENTION_SECS),
        )
    }

    pub fn with_limits(
        output_tail_limit: usize,
        max_retained_tasks: usize,
        task_retention: Duration,
    ) -> Self {
        Self::with_limits_and_task_request_deadline(
            output_tail_limit,
            max_retained_tasks,
            task_retention,
            Duration::from_secs(DEFAULT_TASK_REQUEST_DEADLINE_SECS),
        )
    }

    pub fn with_limits_and_task_request_deadline(
        output_tail_limit: usize,
        max_retained_tasks: usize,
        task_retention: Duration,
        task_request_deadline: Duration,
    ) -> Self {
        Self {
            inner: Mutex::new(BackgroundTaskManagerInner::default()),
            output_tail_limit,
            max_retained_tasks,
            task_retention,
            task_request_deadline,
        }
    }

    pub fn allocate_task_id(&self) -> String {
        new_task_id(SystemTime::now())
    }

    pub fn start_task(&self, task: NewBackgroundTask) -> TaskSnapshot {
        let now = SystemTime::now();
        let task_id = new_task_id(now);
        self.start_task_with_id(task_id, task)
    }

    pub fn start_task_with_id(
        &self,
        task_id: impl Into<String>,
        task: NewBackgroundTask,
    ) -> TaskSnapshot {
        let now = SystemTime::now();
        let task_id = task_id.into();
        let record = TaskRecord::new(task_id.clone(), task, now);

        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        inner.tasks.insert(task_id.clone(), record);
        inner.prune(self.max_retained_tasks, self.task_retention, now);
        let snapshot = inner
            .tasks
            .get(&task_id)
            .expect("inserted task should exist")
            .snapshot();
        inner.retain_live_stdin_writers();
        snapshot
    }

    pub fn list(&self) -> Vec<TaskSnapshot> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .values()
            .map(TaskRecord::snapshot)
            .collect()
    }

    pub fn list_by_owner(&self, owner: &TaskOwner) -> Vec<TaskSnapshot> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .values()
            .filter(|record| &record.owner == owner)
            .map(TaskRecord::snapshot)
            .collect()
    }

    pub fn running_or_cancelling_count(&self) -> usize {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .values()
            .filter(|record| matches!(record.state, TaskState::Running | TaskState::Cancelling))
            .count()
    }

    pub fn pending_request_count(&self) -> usize {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .values()
            .map(TaskRecord::pending_request_count)
            .sum()
    }

    pub fn prune(&self, now: SystemTime) -> usize {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .prune(self.max_retained_tasks, self.task_retention, now)
    }

    pub fn get(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .get(task_id)
            .map(TaskRecord::snapshot)
    }

    pub fn get_by_owner(&self, owner: &TaskOwner, task_id: &str) -> Option<TaskSnapshot> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .get(task_id)
            .filter(|record| &record.owner == owner)
            .map(TaskRecord::snapshot)
    }

    pub fn register_stdin_writer(
        &self,
        task_id: &str,
        writer: Arc<dyn TaskStdinWriter>,
    ) -> Option<TaskSnapshot> {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let snapshot = inner.tasks.get(task_id)?.snapshot();
        inner.stdin_writers.insert(task_id.to_owned(), writer);
        Some(snapshot)
    }

    pub fn accept_task_request(
        &self,
        task_id: &str,
        frame: TaskRequestFrame,
    ) -> TaskRequestAdmission {
        let now = SystemTime::now();
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let global_pending = inner
            .tasks
            .values()
            .map(TaskRecord::pending_request_count)
            .sum::<usize>();
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return TaskRequestAdmission::TaskMissing;
        };
        if let Some(existing) = record.requests.get(&frame.id) {
            let metadata = record.request_metadata();
            return TaskRequestAdmission::Duplicate(existing.snapshot(&metadata));
        }

        let mut state = TaskRequestState::Pending;
        let mut failure_reason = None;
        if record.state.is_terminal() {
            state = TaskRequestState::TaskTerminal;
            failure_reason = Some("task is terminal".to_owned());
        } else if record.pending_request_count() >= DEFAULT_MAX_PENDING_REQUESTS_PER_TASK {
            state = TaskRequestState::Rejected;
            failure_reason = Some("task ask pending limit reached".to_owned());
        } else if global_pending >= DEFAULT_MAX_PENDING_REQUESTS_GLOBAL {
            state = TaskRequestState::Rejected;
            failure_reason = Some("global task ask pending limit reached".to_owned());
        }

        let requested_timeout = frame.timeout;
        let effective_timeout = requested_timeout
            .unwrap_or(self.task_request_deadline)
            .min(self.task_request_deadline);
        let request = TaskRequestRecord {
            request_id: frame.id,
            request: frame.request,
            expect: frame.expect,
            urgency: frame.urgency,
            state,
            requested_at: now,
            deadline_at: now + effective_timeout,
            requested_timeout,
            effective_timeout,
            completed_at: state.is_terminal().then_some(now),
            failure_reason,
            stale_skipped: false,
        };
        let request_id = request.request_id.clone();
        record.requests.insert(request_id.clone(), request);
        let metadata = record.request_metadata();
        let snapshot = record
            .requests
            .get(&request_id)
            .expect("inserted request should exist")
            .snapshot(&metadata);
        if snapshot.state == TaskRequestState::Pending {
            TaskRequestAdmission::Accepted(snapshot)
        } else {
            TaskRequestAdmission::Rejected(snapshot)
        }
    }

    pub fn reject_task_request(
        &self,
        task_id: &str,
        request_id: &str,
        exception_code: &'static str,
        reason: impl Into<String>,
    ) -> Option<TaskRequestResolution> {
        let reason = bounded_chars(&reason.into(), TASK_REQUEST_DIAGNOSTIC_CHARS);
        let now = SystemTime::now();
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let record = inner.tasks.get_mut(task_id)?;
        let metadata = record.request_metadata();
        let request = record.requests.get_mut(request_id)?;
        if request.state != TaskRequestState::Pending {
            return None;
        }
        request.state = TaskRequestState::Rejected;
        request.completed_at = Some(now);
        request.failure_reason = Some(reason.clone());
        let snapshot = request.snapshot(&metadata);
        Some(TaskRequestResolution::new(
            snapshot.clone(),
            vec![rejected_task_request_effect(
                snapshot,
                exception_code,
                &reason,
            )],
        ))
    }

    pub fn expire_pending_requests_for_task(
        &self,
        task_id: &str,
        now: SystemTime,
    ) -> Vec<TaskRequestResolution> {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return Vec::new();
        };
        let metadata = record.request_metadata();
        record
            .requests
            .values_mut()
            .filter_map(|request| {
                if request.state == TaskRequestState::Pending && request.deadline_at <= now {
                    request.state = TaskRequestState::Expired;
                    request.completed_at = Some(now);
                    request.failure_reason = Some("task ask expired".to_owned());
                    let snapshot = request.snapshot(&metadata);
                    return Some(TaskRequestResolution::new(
                        snapshot.clone(),
                        vec![expired_task_request_effect(snapshot)],
                    ));
                }
                None
            })
            .collect()
    }

    pub fn prepare_task_reply(
        &self,
        task_id: &str,
        request_id: &str,
        response: &str,
    ) -> TaskReplyPlan {
        self.prepare_task_reply_for_owner(None, task_id, request_id, response)
    }

    pub fn prepare_task_reply_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
        request_id: &str,
        response: &str,
    ) -> TaskReplyPlan {
        self.prepare_task_reply_for_owner(Some(owner), task_id, request_id, response)
    }

    fn prepare_task_reply_for_owner(
        &self,
        owner: Option<&TaskOwner>,
        task_id: &str,
        request_id: &str,
        response: &str,
    ) -> TaskReplyPlan {
        let response_intent = TaskStdinIntent::response(task_id, request_id, response);
        if let Err(error) =
            validate_task_stdin_frame(TaskStdinFrameKind::Reply, response_intent.frame.as_bytes())
        {
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(TaskReplyStatus::ResponseTooLarge, None, error)
                    .with_request_ids(task_id, request_id),
            );
        }

        let now = SystemTime::now();
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(
                    TaskReplyStatus::UnknownTask,
                    None,
                    format!("unknown task: {task_id}"),
                )
                .with_request_ids(task_id, request_id),
            );
        };
        if !owner.is_none_or(|owner| &record.owner == owner) {
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(
                    TaskReplyStatus::UnknownTask,
                    None,
                    format!("unknown task: {task_id}"),
                )
                .with_request_ids(task_id, request_id),
            );
        }
        let metadata = record.request_metadata();
        let task_is_terminal = record.state.is_terminal();
        let Some(request) = record.requests.get_mut(request_id) else {
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(
                    TaskReplyStatus::UnknownRequest,
                    None,
                    format!("unknown task ask: {request_id}"),
                )
                .with_request_ids(task_id, request_id),
            );
        };
        if request.state != TaskRequestState::Pending {
            let snapshot = request.snapshot(&metadata);
            if request.state == TaskRequestState::Expired && request.deadline_at <= now {
                return TaskReplyPlan::finished(TaskReplyOutcome::new(
                    TaskReplyStatus::Expired,
                    Some(snapshot),
                    "task ask expired",
                ));
            }
            return TaskReplyPlan::finished(TaskReplyOutcome::new(
                TaskReplyStatus::AlreadyResolved,
                Some(snapshot),
                "task ask was already resolved",
            ));
        }
        if task_is_terminal {
            request.state = TaskRequestState::TaskTerminal;
            request.completed_at = Some(now);
            request.failure_reason = Some("task is terminal".to_owned());
            let snapshot = request.snapshot(&metadata);
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(
                    TaskReplyStatus::TaskTerminal,
                    Some(snapshot.clone()),
                    "task is terminal",
                )
                .with_effect(terminal_task_request_effect(snapshot, "task is terminal")),
            );
        }
        if request.deadline_at <= now {
            request.state = TaskRequestState::Expired;
            request.completed_at = Some(now);
            request.failure_reason = Some("task ask expired".to_owned());
            let snapshot = request.snapshot(&metadata);
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(
                    TaskReplyStatus::Expired,
                    Some(snapshot.clone()),
                    "task ask expired",
                )
                .with_effect(expired_task_request_effect(snapshot)),
            );
        }
        request.state = TaskRequestState::Replied;
        let snapshot = request.snapshot(&metadata);
        TaskReplyPlan::ready(snapshot, response_intent)
    }

    pub fn complete_prepared_task_reply(
        &self,
        task_id: &str,
        request_id: &str,
        write_result: Result<(), String>,
    ) -> TaskReplyOutcome {
        self.complete_prepared_task_reply_for_owner(None, task_id, request_id, write_result)
    }

    pub fn complete_prepared_task_reply_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
        request_id: &str,
        write_result: Result<(), String>,
    ) -> TaskReplyOutcome {
        self.complete_prepared_task_reply_for_owner(Some(owner), task_id, request_id, write_result)
    }

    fn complete_prepared_task_reply_for_owner(
        &self,
        owner: Option<&TaskOwner>,
        task_id: &str,
        request_id: &str,
        write_result: Result<(), String>,
    ) -> TaskReplyOutcome {
        let now = SystemTime::now();
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return TaskReplyOutcome::new(TaskReplyStatus::UnknownTask, None, "unknown task")
                .with_request_ids(task_id, request_id);
        };
        if !owner.is_none_or(|owner| &record.owner == owner) {
            return TaskReplyOutcome::new(TaskReplyStatus::UnknownTask, None, "unknown task")
                .with_request_ids(task_id, request_id);
        }
        let metadata = record.request_metadata();
        let Some(request) = record.requests.get_mut(request_id) else {
            return TaskReplyOutcome::new(TaskReplyStatus::UnknownRequest, None, "unknown request")
                .with_request_ids(task_id, request_id);
        };
        if request.state != TaskRequestState::Replied {
            return TaskReplyOutcome::new(
                TaskReplyStatus::AlreadyResolved,
                Some(request.snapshot(&metadata)),
                "task ask was already resolved",
            );
        }
        match write_result {
            Ok(()) => {
                request.state = TaskRequestState::Written;
                request.completed_at = Some(now);
                request.failure_reason = None;
                TaskReplyOutcome::new(
                    TaskReplyStatus::Written,
                    Some(request.snapshot(&metadata)),
                    "task reply written",
                )
            }
            Err(error) => {
                let reason = bounded_chars(&error, TASK_REQUEST_DIAGNOSTIC_CHARS);
                request.state = TaskRequestState::WriteFailed;
                request.completed_at = Some(now);
                request.failure_reason = Some(reason.clone());
                TaskReplyOutcome::new(
                    TaskReplyStatus::Failed,
                    Some(request.snapshot(&metadata)),
                    reason,
                )
            }
        }
    }

    pub(crate) fn mark_task_request_stale_skipped(&self, task_id: &str, request_id: &str) -> bool {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return false;
        };
        let Some(request) = record.requests.get_mut(request_id) else {
            return false;
        };
        request.stale_skipped = true;
        true
    }

    pub(crate) fn stdin_writer(&self, task_id: &str) -> Option<Arc<dyn TaskStdinWriter>> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .stdin_writers
            .get(task_id)
            .cloned()
    }

    pub(crate) fn release_stdin_writer(&self, task_id: &str) {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .stdin_writers
            .remove(task_id);
    }

    pub fn finish_task(
        &self,
        task_id: &str,
        state: TaskState,
        pending_request_reason: impl Into<String>,
    ) -> Option<TaskFinalization> {
        self.finish_task_if_owner(None, task_id, state, pending_request_reason, false)
    }

    pub(crate) fn cancel_and_fail_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
        pending_request_reason: impl Into<String>,
    ) -> Option<TaskFinalization> {
        self.finish_task_if_owner(
            Some(owner),
            task_id,
            TaskState::Failed,
            pending_request_reason,
            true,
        )
    }

    fn finish_task_if_owner(
        &self,
        owner: Option<&TaskOwner>,
        task_id: &str,
        state: TaskState,
        pending_request_reason: impl Into<String>,
        cancel: bool,
    ) -> Option<TaskFinalization> {
        let reason = bounded_chars(
            &pending_request_reason.into(),
            TASK_REQUEST_DIAGNOSTIC_CHARS,
        );
        let now = SystemTime::now();
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let record = inner.tasks.get_mut(task_id)?;
        if !owner.is_none_or(|owner| &record.owner == owner) {
            return None;
        }
        if cancel {
            record.cancel_token.cancel();
        }
        record.output.output_live = false;
        record.output.output_complete = true;
        let metadata = record.request_metadata();
        let pending_request_effects = record
            .requests
            .values_mut()
            .filter_map(|request| {
                if request.state == TaskRequestState::Pending {
                    request.state = TaskRequestState::TaskTerminal;
                    request.completed_at = Some(now);
                    request.failure_reason = Some(reason.clone());
                    let snapshot = request.snapshot(&metadata);
                    return Some(terminal_task_request_effect(snapshot, reason.clone()));
                }
                None
            })
            .collect();
        record.set_state(state, now);
        let snapshot = record.snapshot();
        Some(TaskFinalization {
            snapshot,
            pending_request_effects,
        })
    }

    pub fn cancel(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task(task_id, |record| {
            if !record.state.is_terminal() {
                record.state = TaskState::Cancelling;
                record.cancel_token.cancel();
            }
        })
    }

    pub fn cancel_by_owner(&self, owner: &TaskOwner, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task_if(task_id, |record| {
            if &record.owner != owner {
                return false;
            }
            if !record.state.is_terminal() {
                record.state = TaskState::Cancelling;
                record.cancel_token.cancel();
            }
            true
        })
    }

    pub fn discard_unstarted_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
    ) -> Option<TaskSnapshot> {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        if !inner
            .tasks
            .get(task_id)
            .is_some_and(|record| &record.owner == owner)
        {
            return None;
        }
        let record = inner.tasks.remove(task_id)?;
        record.cancel_token.cancel();
        inner.stdin_writers.remove(task_id);
        Some(record.snapshot())
    }

    pub fn cancel_all_by_owner(&self, owner: &TaskOwner) -> Vec<TaskSnapshot> {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let mut snapshots = Vec::new();
        for record in inner.tasks.values_mut() {
            if &record.owner != owner || record.state.is_terminal() {
                continue;
            }
            record.state = TaskState::Cancelling;
            record.cancel_token.cancel();
            snapshots.push(record.snapshot());
        }
        inner.prune(
            self.max_retained_tasks,
            self.task_retention,
            SystemTime::now(),
        );
        snapshots
    }

    pub fn cancel_all(&self) -> Vec<TaskSnapshot> {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let mut snapshots = Vec::new();
        for record in inner.tasks.values_mut() {
            if record.state.is_terminal() {
                continue;
            }
            record.state = TaskState::Cancelling;
            record.cancel_token.cancel();
            snapshots.push(record.snapshot());
        }
        inner.prune(
            self.max_retained_tasks,
            self.task_retention,
            SystemTime::now(),
        );
        snapshots
    }

    pub fn set_callback_delivery(
        &self,
        task_id: &str,
        delivery: CallbackDelivery,
    ) -> Option<TaskSnapshot> {
        self.mutate_task(task_id, |record| {
            record.callback_delivery = delivery;
        })
    }

    pub fn set_callback_pending(
        &self,
        task_id: &str,
        message_id: impl Into<String>,
        content: Vec<ContentPart>,
    ) -> Option<TaskSnapshot> {
        let message_id = message_id.into();
        self.mutate_task(task_id, |record| {
            record.callback_delivery = CallbackDelivery::Pending;
            record.callback_payload = Some(TaskCallbackPayloadRecord::new(
                record.task_id.clone(),
                message_id,
                content,
            ));
            record.callback_failure_reason = None;
        })
    }

    pub(crate) fn clear_callback_pending_if_payload(
        &self,
        task_id: &str,
        message_id: &str,
    ) -> Option<TaskSnapshot> {
        self.mutate_task_if(task_id, |record| {
            if record.callback_delivery != CallbackDelivery::Pending {
                return false;
            }
            if record
                .callback_payload
                .as_ref()
                .is_none_or(|payload| payload.message_id != message_id)
            {
                return false;
            }
            record.callback_delivery = CallbackDelivery::NotReady;
            record.callback_payload = None;
            record.callback_failure_reason = None;
            true
        })
    }

    pub fn set_callback_enqueued(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task(task_id, |record| {
            record.callback_delivery = CallbackDelivery::Enqueued;
            record.callback_failure_reason = None;
        })
    }

    pub fn set_callback_enqueued_if_pending(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task_if(task_id, |record| {
            if record.callback_delivery != CallbackDelivery::Pending {
                return false;
            }
            record.callback_delivery = CallbackDelivery::Enqueued;
            record.callback_failure_reason = None;
            true
        })
    }

    pub(crate) fn restore_callback_pending_if_enqueued(
        &self,
        task_id: &str,
        message_id: &str,
    ) -> Option<TaskSnapshot> {
        self.mutate_task_if(task_id, |record| {
            if record.callback_delivery != CallbackDelivery::Enqueued {
                return false;
            }
            if record
                .callback_payload
                .as_ref()
                .is_none_or(|payload| payload.message_id != message_id)
            {
                return false;
            }
            record.callback_delivery = CallbackDelivery::Pending;
            record.callback_failure_reason = None;
            true
        })
    }

    pub fn set_callback_delivered_by_input_id(
        &self,
        callback_input_id: &str,
    ) -> Option<TaskSnapshot> {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let snapshot = {
            let record = inner.tasks.values_mut().find(|record| {
                record
                    .callback_payload
                    .as_ref()
                    .is_some_and(|payload| payload.message_id == callback_input_id)
            })?;
            record.callback_delivery = CallbackDelivery::Delivered;
            record.callback_failure_reason = None;
            record.snapshot()
        };
        inner.prune(
            self.max_retained_tasks,
            self.task_retention,
            SystemTime::now(),
        );
        Some(snapshot)
    }

    pub(crate) fn callback_delivered_snapshot_by_input_id(
        &self,
        callback_input_id: &str,
    ) -> Option<TaskSnapshot> {
        let inner = self.inner.lock().expect("task manager lock poisoned");
        let record = inner.tasks.values().find(|record| {
            record
                .callback_payload
                .as_ref()
                .is_some_and(|payload| payload.message_id == callback_input_id)
        })?;
        let mut snapshot = record.snapshot();
        snapshot.callback_delivery = CallbackDelivery::Delivered;
        snapshot.callback_failure_reason = None;
        Some(snapshot)
    }

    pub fn set_callback_failed(
        &self,
        task_id: &str,
        reason: impl Into<String>,
    ) -> Option<TaskSnapshot> {
        let reason = bounded_chars(&reason.into(), TASK_CALLBACK_FAILURE_REASON_CHARS);
        self.mutate_task(task_id, |record| {
            record.callback_delivery = CallbackDelivery::Failed;
            record.callback_failure_reason = Some(reason);
        })
    }

    pub fn set_callback_failed_if_pending(
        &self,
        task_id: &str,
        reason: impl Into<String>,
    ) -> Option<TaskSnapshot> {
        let reason = bounded_chars(&reason.into(), TASK_CALLBACK_FAILURE_REASON_CHARS);
        self.mutate_task_if(task_id, |record| {
            if record.callback_delivery != CallbackDelivery::Pending {
                return false;
            }
            record.callback_delivery = CallbackDelivery::Failed;
            record.callback_failure_reason = Some(reason);
            true
        })
    }

    pub(crate) fn restore_callback_pending_if_failed(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task_if(task_id, |record| {
            if record.callback_delivery != CallbackDelivery::Failed {
                return false;
            }
            record.callback_delivery = CallbackDelivery::Pending;
            record.callback_failure_reason = None;
            true
        })
    }

    pub fn pending_callbacks(&self) -> Vec<TaskCallbackPayloadSnapshot> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .values()
            .filter(|record| record.callback_delivery == CallbackDelivery::Pending)
            .filter_map(|record| {
                record
                    .callback_payload
                    .as_ref()
                    .map(|payload| payload.snapshot())
            })
            .collect()
    }

    pub fn should_retain_for_callback(&self, task_id: &str) -> Option<bool> {
        self.get(task_id)
            .map(|snapshot| snapshot.requires_callback_retention())
    }

    pub fn update_output(&self, task_id: &str, update: TaskOutputUpdate) -> Option<TaskSnapshot> {
        let now = SystemTime::now();
        let tail_limit = self.output_tail_limit;
        self.mutate_task(task_id, |record| {
            record.output.push_update(
                &update.bytes,
                update.output_bytes_delta,
                update.output_dropped_bytes_delta,
                update.output_artifact_truncated,
                tail_limit,
                now,
            );
        })
    }

    pub fn complete_output(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task(task_id, |record| {
            record.output.output_live = false;
            record.output.output_complete = true;
        })
    }

    pub fn set_output_snapshot(
        &self,
        task_id: &str,
        snapshot: TaskOutputSnapshot,
    ) -> Option<TaskSnapshot> {
        self.mutate_task(task_id, |record| {
            record.output = TaskOutputRecord::from_snapshot(snapshot.clone());
            record.artifact_path = snapshot.artifact_path;
        })
    }

    pub fn set_artifact_path(
        &self,
        task_id: &str,
        artifact_path: impl Into<PathBuf>,
    ) -> Option<TaskSnapshot> {
        let artifact_path = artifact_path.into();
        self.mutate_task(task_id, |record| {
            record.artifact_path = Some(artifact_path.clone());
            record.output.artifact_path = Some(artifact_path);
        })
    }

    fn mutate_task(
        &self,
        task_id: &str,
        mutate: impl FnOnce(&mut TaskRecord),
    ) -> Option<TaskSnapshot> {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let record = inner.tasks.get_mut(task_id)?;
        mutate(record);
        let snapshot = record.snapshot();
        inner.prune(
            self.max_retained_tasks,
            self.task_retention,
            SystemTime::now(),
        );
        Some(snapshot)
    }

    fn mutate_task_if(
        &self,
        task_id: &str,
        mutate: impl FnOnce(&mut TaskRecord) -> bool,
    ) -> Option<TaskSnapshot> {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let record = inner.tasks.get_mut(task_id)?;
        if !mutate(record) {
            return None;
        }
        let snapshot = record.snapshot();
        inner.prune(
            self.max_retained_tasks,
            self.task_retention,
            SystemTime::now(),
        );
        Some(snapshot)
    }
}

impl Default for BackgroundTaskManager {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
struct BackgroundTaskManagerInner {
    tasks: BTreeMap<String, TaskRecord>,
    stdin_writers: HashMap<String, Arc<dyn TaskStdinWriter>>,
}

impl std::fmt::Debug for BackgroundTaskManagerInner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BackgroundTaskManagerInner")
            .field("tasks", &self.tasks)
            .field("stdin_writers", &self.stdin_writers.len())
            .finish()
    }
}

impl BackgroundTaskManagerInner {
    fn prune(
        &mut self,
        max_retained_tasks: usize,
        task_retention: Duration,
        now: SystemTime,
    ) -> usize {
        let mut removable = self
            .tasks
            .values()
            .filter(|record| record.is_prunable_at(now, task_retention))
            .map(|record| record.task_id.clone())
            .collect::<Vec<_>>();
        let mut removed = 0;

        for task_id in removable.iter() {
            if self.tasks.remove(task_id).is_some() {
                removed += 1;
            }
        }

        removable = self
            .tasks
            .values()
            .filter(|record| record.is_prunable())
            .map(|record| record.task_id.clone())
            .collect();
        while self.tasks.len() > max_retained_tasks {
            let Some(task_id) = removable.first().cloned() else {
                break;
            };
            removable.remove(0);
            if self.tasks.remove(&task_id).is_some() {
                removed += 1;
            }
        }

        self.retain_live_stdin_writers();
        removed
    }

    fn retain_live_stdin_writers(&mut self) {
        self.stdin_writers.retain(|task_id, _| {
            self.tasks
                .get(task_id)
                .is_some_and(|record| !record.state.is_terminal())
        });
    }
}

#[derive(Debug)]
struct TaskRecord {
    task_id: String,
    tool_call_id: String,
    tool_name: String,
    arguments_summary: String,
    owner: TaskOwner,
    state: TaskState,
    started_at: SystemTime,
    detached_at: Option<SystemTime>,
    timeout_at: Option<SystemTime>,
    completed_at: Option<SystemTime>,
    callback_delivery: CallbackDelivery,
    callback_payload: Option<TaskCallbackPayloadRecord>,
    callback_failure_reason: Option<String>,
    output: TaskOutputRecord,
    artifact_path: Option<PathBuf>,
    cancel_token: CancellationToken,
    requests: BTreeMap<String, TaskRequestRecord>,
}

impl TaskRecord {
    fn new(task_id: String, task: NewBackgroundTask, started_at: SystemTime) -> Self {
        Self {
            task_id,
            tool_call_id: task.tool_call_id,
            tool_name: task.tool_name,
            arguments_summary: task.arguments_summary,
            owner: task.owner,
            state: TaskState::Running,
            started_at,
            detached_at: task.detached_at,
            timeout_at: task.timeout_at,
            completed_at: None,
            callback_delivery: CallbackDelivery::NotReady,
            callback_payload: None,
            callback_failure_reason: None,
            output: TaskOutputRecord::new(task.artifact_path.clone()),
            artifact_path: task.artifact_path,
            cancel_token: task.cancel_token,
            requests: BTreeMap::new(),
        }
    }

    fn set_state(&mut self, state: TaskState, now: SystemTime) {
        if self.state.is_terminal() {
            return;
        }

        self.state = state;
        if state.is_terminal() {
            self.completed_at = Some(now);
        }
    }

    fn is_prunable(&self) -> bool {
        self.state.is_terminal() && self.callback_delivery == CallbackDelivery::Delivered
    }

    fn is_prunable_at(&self, now: SystemTime, task_retention: Duration) -> bool {
        self.is_prunable()
            && self
                .completed_at
                .and_then(|completed_at| now.duration_since(completed_at).ok())
                .is_some_and(|age| age >= task_retention)
    }

    fn snapshot(&self) -> TaskSnapshot {
        let request_metadata = self.request_metadata();
        TaskSnapshot {
            task_id: self.task_id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            tool_name: self.tool_name.clone(),
            arguments_summary: self.arguments_summary.clone(),
            owner: self.owner.clone(),
            state: self.state,
            started_at: self.started_at,
            detached_at: self.detached_at,
            timeout_at: self.timeout_at,
            completed_at: self.completed_at,
            callback_delivery: self.callback_delivery,
            callback_payload: self
                .callback_payload
                .as_ref()
                .map(TaskCallbackPayloadRecord::snapshot),
            callback_failure_reason: self.callback_failure_reason.clone(),
            output: self.output.snapshot(),
            artifact_path: self.artifact_path.clone(),
            cancel_token: self.cancel_token.clone(),
            requests: self
                .requests
                .values()
                .map(|request| request.snapshot(&request_metadata))
                .collect(),
        }
    }

    fn request_metadata(&self) -> TaskRequestMetadata {
        let arguments_summary =
            bounded_chars(&self.arguments_summary, TASK_REQUEST_ARGUMENT_SUMMARY_CHARS);
        TaskRequestMetadata {
            task_id: self.task_id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            tool_name: self.tool_name.clone(),
            owner: self.owner.clone(),
            sender: task_request_sender(&self.tool_name, &arguments_summary),
            arguments_summary,
        }
    }

    fn pending_request_count(&self) -> usize {
        self.requests
            .values()
            .filter(|request| request.state == TaskRequestState::Pending)
            .count()
    }
}

#[derive(Debug, Clone)]
struct TaskRequestRecord {
    request_id: String,
    request: String,
    expect: Option<String>,
    urgency: InputUrgency,
    state: TaskRequestState,
    requested_at: SystemTime,
    deadline_at: SystemTime,
    requested_timeout: Option<Duration>,
    effective_timeout: Duration,
    completed_at: Option<SystemTime>,
    failure_reason: Option<String>,
    stale_skipped: bool,
}

impl TaskRequestRecord {
    fn snapshot(&self, metadata: &TaskRequestMetadata) -> TaskRequestSnapshot {
        TaskRequestSnapshot {
            task_id: metadata.task_id.clone(),
            tool_call_id: metadata.tool_call_id.clone(),
            tool_name: metadata.tool_name.clone(),
            arguments_summary: metadata.arguments_summary.clone(),
            owner: metadata.owner.clone(),
            sender: metadata.sender.clone(),
            request_id: self.request_id.clone(),
            request: self.request.clone(),
            expect: self.expect.clone(),
            urgency: self.urgency,
            state: self.state,
            requested_at: self.requested_at,
            deadline_at: self.deadline_at,
            requested_timeout: self.requested_timeout,
            effective_timeout: self.effective_timeout,
            completed_at: self.completed_at,
            failure_reason: self.failure_reason.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct TaskRequestMetadata {
    task_id: String,
    tool_call_id: String,
    tool_name: String,
    owner: TaskOwner,
    arguments_summary: String,
    sender: String,
}

fn task_request_sender(tool_name: &str, arguments_summary: &str) -> String {
    if arguments_summary.trim().is_empty() {
        tool_name.to_owned()
    } else {
        format!("{tool_name}: {arguments_summary}")
    }
}

#[derive(Debug, Clone)]
struct TaskCallbackPayloadRecord {
    task_id: String,
    message_id: String,
    content: Vec<ContentPart>,
}

impl TaskCallbackPayloadRecord {
    fn new(task_id: String, message_id: String, content: Vec<ContentPart>) -> Self {
        Self {
            task_id,
            message_id,
            content: bounded_content_parts(content, TASK_CALLBACK_PAYLOAD_TEXT_CHARS),
        }
    }

    fn snapshot(&self) -> TaskCallbackPayloadSnapshot {
        TaskCallbackPayloadSnapshot {
            task_id: self.task_id.clone(),
            message_id: self.message_id.clone(),
            content: self.content.clone(),
        }
    }
}

#[derive(Debug)]
struct TaskOutputRecord {
    tail: Vec<u8>,
    output_bytes: u64,
    output_live: bool,
    output_complete: bool,
    output_last_updated_at: Option<SystemTime>,
    artifact_path: Option<PathBuf>,
    output_tail_truncated: bool,
    output_artifact_truncated: bool,
    output_dropped_bytes: u64,
}

impl TaskOutputRecord {
    fn new(artifact_path: Option<PathBuf>) -> Self {
        Self {
            tail: Vec::new(),
            output_bytes: 0,
            output_live: true,
            output_complete: false,
            output_last_updated_at: None,
            artifact_path,
            output_tail_truncated: false,
            output_artifact_truncated: false,
            output_dropped_bytes: 0,
        }
    }

    fn push_update(
        &mut self,
        bytes: &[u8],
        output_bytes_delta: u64,
        output_dropped_bytes_delta: u64,
        output_artifact_truncated: bool,
        tail_limit: usize,
        updated_at: SystemTime,
    ) {
        self.output_bytes = self.output_bytes.saturating_add(output_bytes_delta);
        self.output_dropped_bytes = self
            .output_dropped_bytes
            .saturating_add(output_dropped_bytes_delta);
        self.output_artifact_truncated |= output_artifact_truncated;
        self.output_last_updated_at = Some(updated_at);

        if bytes.is_empty() {
            return;
        }

        if tail_limit == 0 {
            self.output_tail_truncated = true;
            self.tail.clear();
            return;
        }

        if bytes.len() >= tail_limit {
            self.output_tail_truncated = true;
            self.tail.clear();
            self.tail
                .extend_from_slice(&bytes[bytes.len() - tail_limit..]);
            return;
        }

        let overflow = self.tail.len() + bytes.len();
        if overflow > tail_limit {
            let remove = overflow - tail_limit;
            self.tail.drain(..remove);
            self.output_tail_truncated = true;
        }

        self.tail.extend_from_slice(bytes);
    }

    fn from_snapshot(snapshot: TaskOutputSnapshot) -> Self {
        Self {
            tail: snapshot.tail.into_bytes(),
            output_bytes: snapshot.output_bytes,
            output_live: snapshot.output_live,
            output_complete: snapshot.output_complete,
            output_last_updated_at: snapshot.output_last_updated_at,
            artifact_path: snapshot.artifact_path,
            output_tail_truncated: snapshot.output_tail_truncated,
            output_artifact_truncated: snapshot.output_artifact_truncated,
            output_dropped_bytes: snapshot.output_dropped_bytes,
        }
    }

    fn snapshot(&self) -> TaskOutputSnapshot {
        TaskOutputSnapshot {
            tail: String::from_utf8_lossy(&self.tail).into_owned(),
            output_bytes: self.output_bytes,
            output_live: self.output_live,
            output_complete: self.output_complete,
            output_last_updated_at: self.output_last_updated_at,
            artifact_path: self.artifact_path.clone(),
            output_tail_truncated: self.output_tail_truncated,
            output_artifact_truncated: self.output_artifact_truncated,
            output_dropped_bytes: self.output_dropped_bytes,
        }
    }
}

fn new_task_id(now: SystemTime) -> String {
    let seconds = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let timestamp = utc_timestamp_fragment(seconds);
    let suffix = NEXT_TASK_ID_SUFFIX.fetch_add(1, Ordering::Relaxed);
    format!("t_{timestamp}_{suffix:06x}")
}

fn utc_timestamp_fragment(seconds_since_unix_epoch: u64) -> String {
    let days = (seconds_since_unix_epoch / 86_400) as i64;
    let seconds_of_day = seconds_since_unix_epoch % 86_400;
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    let (year, month, day) = civil_from_days(days);

    format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z")
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_piece = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_piece + 2) / 5 + 1;
    let month = month_piece + if month_piece < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };

    (year as i32, month as u32, day as u32)
}

#[derive(Debug, Clone)]
pub struct TaskListTool {
    manager: std::sync::Arc<BackgroundTaskManager>,
    owner: TaskOwner,
}

impl TaskListTool {
    pub fn new(manager: std::sync::Arc<BackgroundTaskManager>) -> Self {
        Self::new_for_owner(manager, TaskOwner::Main)
    }

    pub fn new_for_owner(manager: std::sync::Arc<BackgroundTaskManager>, owner: TaskOwner) -> Self {
        Self { manager, owner }
    }
}

#[async_trait]
impl Tool for TaskListTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_LIST_TOOL_NAME,
            "List active and recent in-process background tasks with bounded metadata.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        )
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        let details = task_list_summary(self.manager.list_by_owner(&self.owner));
        Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
    }
}

#[derive(Debug, Clone)]
pub struct TaskCancelTool {
    manager: std::sync::Arc<BackgroundTaskManager>,
}

impl TaskCancelTool {
    pub fn new(manager: std::sync::Arc<BackgroundTaskManager>) -> Self {
        Self { manager }
    }
}

#[async_trait]
impl Tool for TaskCancelTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_CANCEL_TOOL_NAME,
            "Request cancellation of a running in-process background task by task_id.",
            json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The task_id returned by a detached task or task_list."
                    }
                },
                "required": ["task_id"],
                "additionalProperties": false
            }),
        )
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        let Some(task_id) = call.arguments.get("task_id").and_then(Value::as_str) else {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                "task_id is required",
                json!({"kind": "invalid_task_cancel_arguments", "field": "task_id"}),
            ));
        };
        let Some(snapshot) = self.manager.cancel(task_id) else {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                format!("task not found: {task_id}"),
                json!({"kind": "task_not_found", "task_id": task_id}),
            ));
        };

        let details = task_cancel_result_summary(&snapshot);
        Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
    }
}

pub fn is_builtin_task_tool(name: &str) -> bool {
    matches!(
        name,
        TASK_LIST_TOOL_NAME
            | TASK_CANCEL_TOOL_NAME
            | TASK_REPLY_TOOL_NAME
            | TASK_SEND_TOOL_NAME
            | TASK_OBSERVE_TOOL_NAME
            | "subagent_spawn"
            | "subagent_send"
            | "subagent_read"
            | "subagent_list"
            | "subagent_cancel"
    )
}

pub fn task_list_summary(snapshots: Vec<TaskSnapshot>) -> Value {
    let total = snapshots.len();
    let tasks = snapshots
        .into_iter()
        .take(TASK_LIST_MAX_TASKS)
        .map(task_summary)
        .collect::<Vec<_>>();
    let omitted = total.saturating_sub(tasks.len());
    json!({
        "kind": "task_list",
        "tasks": tasks,
        "total": total,
        "omitted": omitted
    })
}

pub fn task_detail_summary(snapshot: TaskSnapshot) -> Value {
    let task_id = snapshot.task_id.clone();
    let state = state_name(snapshot.state);
    json!({
        "kind": "task_detail",
        "task_id": task_id,
        "state": state,
        "task": task_summary(snapshot)
    })
}

pub fn task_cancel_result_summary(snapshot: &TaskSnapshot) -> Value {
    json!({
        "kind": "task_cancel",
        "task": task_cancel_summary(snapshot),
        "task_id": snapshot.task_id,
        "state": state_name(snapshot.state)
    })
}

trait ToolResultDetailsExt {
    fn with_details(self, details: Value) -> Self;
}

impl ToolResultDetailsExt for ToolResult {
    fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}

fn task_summary(snapshot: TaskSnapshot) -> Value {
    json!({
        "task_id": snapshot.task_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "state": state_name(snapshot.state),
        "arguments_summary": bounded_chars(&snapshot.arguments_summary, TASK_LIST_ARGUMENT_CHARS),
        "timeout_secs": task_timeout_secs(&snapshot),
        "timeout_at": snapshot.timeout_at.map(system_time_rfc3339),
        "forced_termination_at": snapshot.timeout_at.map(system_time_rfc3339),
        "output_tail": bounded_chars(&snapshot.output.tail, TASK_LIST_OUTPUT_TAIL_CHARS),
        "output_bytes": snapshot.output.output_bytes,
        "output_tail_truncated": snapshot.output.output_tail_truncated,
        "output_artifact_path": snapshot.output.artifact_path.as_ref().map(|path| path.display().to_string()),
        "output_artifact_truncated": snapshot.output.output_artifact_truncated,
        "output_dropped_bytes": snapshot.output.output_dropped_bytes,
        "output_live": snapshot.output.output_live,
        "output_complete": snapshot.output.output_complete,
        "callback_delivery": callback_delivery_name(snapshot.callback_delivery),
        "callback_failure_reason": snapshot.callback_failure_reason,
    })
}

fn task_cancel_summary(snapshot: &TaskSnapshot) -> Value {
    json!({
        "task_id": snapshot.task_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "state": state_name(snapshot.state),
        "arguments_summary": bounded_chars(&snapshot.arguments_summary, TASK_CANCEL_ARGUMENT_CHARS),
        "timeout_secs": task_timeout_secs(snapshot),
        "timeout_at": snapshot.timeout_at.map(system_time_rfc3339),
        "forced_termination_at": snapshot.timeout_at.map(system_time_rfc3339),
        "output_tail": bounded_chars(&snapshot.output.tail, TASK_CANCEL_OUTPUT_TAIL_CHARS),
        "output_bytes": snapshot.output.output_bytes,
        "output_tail_truncated": snapshot.output.output_tail_truncated,
        "output_artifact_path": snapshot.output.artifact_path.as_ref().map(|path| path.display().to_string()),
        "output_artifact_truncated": snapshot.output.output_artifact_truncated,
        "output_dropped_bytes": snapshot.output.output_dropped_bytes,
    })
}

fn task_timeout_secs(snapshot: &TaskSnapshot) -> Option<f64> {
    let timeout_at = snapshot.timeout_at?;
    let started = snapshot.detached_at.unwrap_or(snapshot.started_at);
    timeout_at
        .duration_since(started)
        .ok()
        .map(|duration| duration.as_secs_f64())
}

fn bounded_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn system_time_rfc3339(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = duration.as_secs();
    let nanos = duration.subsec_nanos();
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    if nanos == 0 {
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
    } else {
        let millis = nanos / 1_000_000;
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
    }
}

pub fn task_response_frame(request_id: &str, value: &str, exception: bool) -> String {
    let payload = if exception {
        serde_json::to_string(&TaskExceptionResponsePayload {
            op: "reply",
            id: bounded_chars(request_id, TASK_REQUEST_FIELD_CHARS),
            exception: TaskExceptionPayload {
                code: "task_exception".to_owned(),
                message: value.to_owned(),
                retryable: false,
            },
        })
        .expect("task response payload should serialize")
    } else {
        serde_json::to_string(&TaskResponsePayload {
            op: "reply",
            id: bounded_chars(request_id, TASK_REQUEST_FIELD_CHARS),
            message: value.to_owned(),
        })
        .expect("task response payload should serialize")
    };
    format!("<botified>{payload}</botified>\n",)
}

pub fn task_exception_frame(request_id: &str, code: &str, message: &str) -> String {
    let payload = TaskExceptionResponsePayload {
        op: "reply",
        id: bounded_chars(request_id, TASK_REQUEST_FIELD_CHARS),
        exception: TaskExceptionPayload {
            code: bounded_chars(code, TASK_REQUEST_FIELD_CHARS),
            message: bounded_chars(message, TASK_REQUEST_DIAGNOSTIC_CHARS),
            retryable: false,
        },
    };
    format!(
        "<botified>{}</botified>\n",
        serde_json::to_string(&payload).expect("task response payload should serialize")
    )
}

pub fn task_send_frame(send_id: &str, message: &str) -> String {
    let payload = TaskResponsePayload {
        op: "send",
        id: bounded_chars(send_id, TASK_REQUEST_FIELD_CHARS),
        message: message.to_owned(),
    };
    format!(
        "<botified>{}</botified>\n",
        serde_json::to_string(&payload).expect("task send payload should serialize")
    )
}

#[derive(Serialize)]
struct TaskResponsePayload {
    op: &'static str,
    id: String,
    message: String,
}

#[derive(Serialize)]
struct TaskExceptionResponsePayload {
    op: &'static str,
    id: String,
    exception: TaskExceptionPayload,
}

#[derive(Serialize)]
struct TaskExceptionPayload {
    code: String,
    message: String,
    retryable: bool,
}

fn bounded_content_parts(content: Vec<ContentPart>, max_chars: usize) -> Vec<ContentPart> {
    content
        .into_iter()
        .map(|part| match part {
            ContentPart::Text { text } => ContentPart::text(bounded_chars(&text, max_chars)),
            ContentPart::ImageUrl { url } => ContentPart::image_url(bounded_chars(&url, max_chars)),
            ContentPart::ImageBase64 { mime_type, data } => {
                ContentPart::image_base64(mime_type, bounded_chars(&data, max_chars))
            }
            ContentPart::File { binding } => ContentPart::File { binding },
            ContentPart::Skill {
                name,
                path,
                arguments,
            } => ContentPart::Skill {
                name: name.map(|value| bounded_chars(&value, max_chars)),
                path: path.map(|value| bounded_chars(&value, max_chars)),
                arguments: arguments.map(|value| bounded_chars(&value, max_chars)),
            },
        })
        .collect()
}

fn state_name(state: TaskState) -> &'static str {
    match state {
        TaskState::Running => "running",
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::TimedOut => "timed_out",
        TaskState::Cancelling => "cancelling",
        TaskState::Cancelled => "cancelled",
        TaskState::Lost => "lost",
    }
}

fn callback_delivery_name(delivery: CallbackDelivery) -> &'static str {
    match delivery {
        CallbackDelivery::NotReady => "not_ready",
        CallbackDelivery::Pending => "pending",
        CallbackDelivery::Enqueued => "queued",
        CallbackDelivery::Delivered => "delivered",
        CallbackDelivery::Failed => "failed",
    }
}

#[derive(Debug)]
pub struct BoundedTaskOutputSink {
    task_id: String,
    manager: Option<Arc<BackgroundTaskManager>>,
    inner: Mutex<BoundedTaskOutputSinkInner>,
}

#[derive(Debug)]
struct BoundedTaskOutputSinkInner {
    file: File,
    output: TaskOutputRecord,
    output_tail_limit: usize,
    max_task_output_bytes: usize,
}

impl BoundedTaskOutputSink {
    pub fn create(
        policy: &TaskOutputPolicy,
        cwd: impl AsRef<Path>,
        task_id: impl Into<String>,
        manager: Option<Arc<BackgroundTaskManager>>,
    ) -> Result<Arc<Self>, ToolError> {
        let task_id = task_id.into();
        let (physical_path, visible_path) =
            task_output_paths(&policy.data_dir, cwd.as_ref(), &task_id);
        if let Some(parent) = physical_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                ToolError::execution_failed(format!(
                    "failed to create task output directory {}: {error}",
                    parent.display()
                ))
            })?;
        }
        let file = File::create(&physical_path).map_err(|error| {
            ToolError::execution_failed(format!(
                "failed to create task output artifact {}: {error}",
                physical_path.display()
            ))
        })?;
        Ok(Arc::new(Self {
            task_id,
            manager,
            inner: Mutex::new(BoundedTaskOutputSinkInner {
                file,
                output: TaskOutputRecord::new(Some(visible_path)),
                output_tail_limit: policy.callback_output_tail_bytes,
                max_task_output_bytes: policy.max_task_output_bytes,
            }),
        }))
    }

    pub fn artifact_path(&self) -> Option<PathBuf> {
        self.snapshot().artifact_path
    }

    pub fn sync_to_task_record(&self) {
        if let Some(manager) = self.manager.as_ref() {
            let snapshot = self.task_snapshot();
            manager.set_output_snapshot(&self.task_id, snapshot);
        }
    }

    fn task_snapshot(&self) -> TaskOutputSnapshot {
        let inner = self.inner.lock().expect("task output sink lock poisoned");
        inner.output.snapshot()
    }
}

impl ToolOutputSink for BoundedTaskOutputSink {
    fn record(&self, bytes: &[u8]) -> Result<crate::tools::ToolOutputSnapshot, ToolError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| ToolError::execution_failed("task output sink lock poisoned"))?;
        let retained = inner.output.output_bytes as usize;
        let remaining = inner.max_task_output_bytes.saturating_sub(retained);
        let writable = remaining.min(bytes.len());
        if writable > 0 {
            inner.file.write_all(&bytes[..writable]).map_err(|error| {
                ToolError::execution_failed(format!(
                    "failed to write task output artifact: {error}"
                ))
            })?;
            inner.file.flush().map_err(|error| {
                ToolError::execution_failed(format!(
                    "failed to flush task output artifact: {error}"
                ))
            })?;
        }
        let dropped = bytes.len().saturating_sub(writable);
        let truncated = dropped > 0;
        let now = SystemTime::now();
        let output_tail_limit = inner.output_tail_limit;
        inner.output.push_update(
            bytes,
            writable as u64,
            dropped as u64,
            truncated,
            output_tail_limit,
            now,
        );
        let snapshot = inner.output.snapshot();
        drop(inner);
        if let Some(manager) = self.manager.as_ref() {
            manager.update_output(
                &self.task_id,
                TaskOutputUpdate::artifact_progress(
                    bytes,
                    writable as u64,
                    dropped as u64,
                    truncated,
                ),
            );
        }
        Ok(tool_output_snapshot(snapshot))
    }

    fn complete(&self) -> Result<crate::tools::ToolOutputSnapshot, ToolError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| ToolError::execution_failed("task output sink lock poisoned"))?;
        inner.output.output_live = false;
        inner.output.output_complete = true;
        inner.file.flush().map_err(|error| {
            ToolError::execution_failed(format!("failed to flush task output artifact: {error}"))
        })?;
        let snapshot = inner.output.snapshot();
        drop(inner);
        if let Some(manager) = self.manager.as_ref() {
            manager.set_output_snapshot(&self.task_id, snapshot.clone());
        }
        Ok(tool_output_snapshot(snapshot))
    }

    fn snapshot(&self) -> crate::tools::ToolOutputSnapshot {
        let inner = self.inner.lock().expect("task output sink lock poisoned");
        tool_output_snapshot(inner.output.snapshot())
    }
}

fn tool_output_snapshot(snapshot: TaskOutputSnapshot) -> crate::tools::ToolOutputSnapshot {
    crate::tools::ToolOutputSnapshot {
        tail: snapshot.tail,
        output_bytes: snapshot.output_bytes,
        output_live: snapshot.output_live,
        output_complete: snapshot.output_complete,
        output_last_updated_at: snapshot.output_last_updated_at,
        artifact_path: snapshot.artifact_path,
        output_tail_truncated: snapshot.output_tail_truncated,
        output_artifact_truncated: snapshot.output_artifact_truncated,
        output_dropped_bytes: snapshot.output_dropped_bytes,
    }
}

fn task_output_paths(data_dir: &Path, cwd: &Path, task_id: &str) -> (PathBuf, PathBuf) {
    let safe_task_id = artifact_task_component(task_id);
    let cwd = lexical_absolute(cwd, Path::new("."));
    let data_dir = lexical_absolute(data_dir, &cwd);
    let physical_path =
        lexical_normalize(&data_dir.join("tasks").join(safe_task_id).join("output.log"));
    let visible_path = if data_dir.starts_with(&cwd) {
        physical_path
            .strip_prefix(&cwd)
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| physical_path.clone())
    } else {
        physical_path.clone()
    };
    (physical_path, visible_path)
}

fn artifact_task_component(task_id: &str) -> String {
    task_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}
