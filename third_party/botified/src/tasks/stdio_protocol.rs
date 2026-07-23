use std::{
    io,
    sync::Arc,
    time::{Duration, SystemTime},
};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::fd::{AsRawFd, OwnedFd};
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
use std::os::fd::{FromRawFd, IntoRawFd};

use serde::Serialize;
use serde_json::{json, Value};

use crate::agent_loop::InputUrgency;
use crate::formatting::{bounded_chars, system_time_rfc3339};
use crate::registry::{RegistryQuery, RegistrySetRequest, RegistryTtl};

use super::{TASK_REQUEST_DIAGNOSTIC_CHARS, TASK_REQUEST_FIELD_CHARS, TASK_REQUEST_TEXT_CHARS};

pub const DEFAULT_BOTIFIED_FRAME_BYTES: usize = 64 * 1024;
pub const TASK_STDIN_FRAME_SAFETY_CEILING: usize = 4 * 1024;

const BOTIFIED_OPEN: &[u8] = b"<botified>";
const BOTIFIED_CLOSE: &[u8] = b"</botified>";
const BOTIFIED_CLOSE_LINE: &[u8] = b"</botified>\n";
pub(super) const MIN_TASK_STDIN_FRAME_BYTES: usize =
    b"<botified>{\"op\":\"x\",\"id\":\"x\"}</botified>\n".len();

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRegistryDeleteFrame {
    pub id: Option<String>,
    pub topic: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskObserveDelivery {
    FinalText,
    StreamText,
}

impl TaskObserveDelivery {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FinalText => "final_text",
            Self::StreamText => "stream_text",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskObserveSource {
    User,
    Assistant,
}

impl TaskObserveSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskObserveConfig {
    pub delivery: TaskObserveDelivery,
    pub min_batch_chars: Option<u16>,
}

impl TaskObserveConfig {
    pub const fn final_text() -> Self {
        Self {
            delivery: TaskObserveDelivery::FinalText,
            min_batch_chars: None,
        }
    }

    pub fn stream_text(min_batch_chars: u16) -> Result<Self, String> {
        if !(1..=4096).contains(&min_batch_chars) {
            return Err("min_batch_chars must be in 1..=4096".to_owned());
        }
        Ok(Self {
            delivery: TaskObserveDelivery::StreamText,
            min_batch_chars: Some(min_batch_chars),
        })
    }

    fn validate(self) -> Result<(), String> {
        match (self.delivery, self.min_batch_chars) {
            (TaskObserveDelivery::FinalText, None) => Ok(()),
            (TaskObserveDelivery::StreamText, Some(1..=4096)) => Ok(()),
            (TaskObserveDelivery::FinalText, Some(_)) => {
                Err("final_text does not accept min_batch_chars".to_owned())
            }
            (TaskObserveDelivery::StreamText, _) => {
                Err("stream_text requires min_batch_chars in 1..=4096".to_owned())
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskObserveRequestAction {
    Enable(TaskObserveConfig),
    Disable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskObserveRequestFrame {
    pub id: String,
    pub action: TaskObserveRequestAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskObserveException {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl TaskObserveException {
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: bounded_chars(&code.into(), TASK_REQUEST_FIELD_CHARS),
            message: bounded_chars(&message.into(), TASK_REQUEST_DIAGNOSTIC_CHARS),
            retryable,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskObserveRequestRejectedFrame {
    pub id: String,
    pub exception: TaskObserveException,
}

#[derive(Debug, Clone, Copy)]
pub struct TaskObserveTextMetadata<'a> {
    pub delivery: TaskObserveDelivery,
    pub source: TaskObserveSource,
    pub timestamp: SystemTime,
    pub message_id: Option<&'a str>,
    pub provider_request_id: Option<&'a str>,
    pub cycle_id: Option<&'a str>,
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
    RegistryDelete(TaskRegistryDeleteFrame),
    ObserveRequest(TaskObserveRequestFrame),
    ObserveRequestRejected(TaskObserveRequestRejectedFrame),
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
    state: BotifiedFrameScannerState,
    physical_line: PhysicalLineState,
    pending_cr: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BotifiedFrameScannerState {
    Scanning,
    DiscardingOversizedFrame,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PhysicalLineState {
    Empty,
    ProtocolOnly,
    Plain,
}

impl BotifiedFrameScanner {
    pub fn new(max_frame_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_bytes,
            state: BotifiedFrameScannerState::Scanning,
            physical_line: PhysicalLineState::Empty,
            pending_cr: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> BotifiedFrameScan {
        self.buffer.extend_from_slice(chunk);
        let mut scan = BotifiedFrameScan::default();

        loop {
            if self.state == BotifiedFrameScannerState::DiscardingOversizedFrame {
                let boundary = first_frame_boundary(&self.buffer);
                let nested_start = find_bytes(&self.buffer, BOTIFIED_OPEN);
                if let Some(nested_start) = nested_start {
                    if boundary.is_none_or(|boundary| nested_start < boundary.start) {
                        self.mark_protocol(&mut scan.plain_output);
                        self.buffer.drain(..nested_start);
                        self.state = BotifiedFrameScannerState::Scanning;
                        continue;
                    }
                }
                let Some(boundary) = boundary else {
                    let keep = botified_close_prefix_suffix_len(&self.buffer)
                        .max(botified_open_prefix_suffix_len(&self.buffer))
                        .max(usize::from(self.buffer.last() == Some(&b'\r')));
                    let discard = self.buffer.len().saturating_sub(keep);
                    self.buffer.drain(..discard);
                    break;
                };
                self.consume_protocol_boundary(boundary, &mut scan.plain_output);
                self.state = BotifiedFrameScannerState::Scanning;
                continue;
            }

            let Some(start) = find_bytes(&self.buffer, BOTIFIED_OPEN) else {
                let keep = botified_open_prefix_suffix_len(&self.buffer);
                let emit = self.buffer.len().saturating_sub(keep);
                if emit > 0 {
                    let plain = self.buffer[..emit].to_vec();
                    self.buffer.drain(..emit);
                    self.emit_plain(&plain, &mut scan.plain_output);
                }
                break;
            };
            if start > 0 {
                let plain = self.buffer[..start].to_vec();
                self.buffer.drain(..start);
                self.emit_plain(&plain, &mut scan.plain_output);
            }

            let content_start = BOTIFIED_OPEN.len();
            let boundary = first_frame_boundary(&self.buffer[content_start..])
                .map(|boundary| boundary.offset(content_start));
            let nested_start = find_bytes(&self.buffer[content_start..], BOTIFIED_OPEN)
                .map(|relative| content_start + relative);

            let Some(boundary) = boundary else {
                let possible_close =
                    botified_close_prefix_suffix_len(&self.buffer[content_start..]);
                let possible_crlf = usize::from(self.buffer.last() == Some(&b'\r'));
                let definite_content_end = self
                    .buffer
                    .len()
                    .saturating_sub(possible_close.max(possible_crlf));

                if let Some(nested_start) = nested_start {
                    let event =
                        if nested_start.saturating_sub(content_start) <= self.max_frame_bytes {
                            malformed_frame_resync_diagnostic()
                        } else {
                            frame_too_large_diagnostic()
                        };
                    self.mark_protocol(&mut scan.plain_output);
                    self.buffer.drain(..nested_start);
                    scan.events.push(event);
                    continue;
                }
                if definite_content_end.saturating_sub(content_start) > self.max_frame_bytes {
                    self.mark_protocol(&mut scan.plain_output);
                    self.state = BotifiedFrameScannerState::DiscardingOversizedFrame;
                    scan.events.push(frame_too_large_diagnostic());
                    let keep = botified_close_prefix_suffix_len(&self.buffer)
                        .max(botified_open_prefix_suffix_len(&self.buffer))
                        .max(possible_crlf);
                    let discard = self.buffer.len().saturating_sub(keep);
                    self.buffer.drain(..discard);
                    continue;
                }
                break;
            };

            if boundary.start.saturating_sub(content_start) > self.max_frame_bytes {
                if let Some(nested_start) = nested_start {
                    if nested_start < boundary.start {
                        let event =
                            if nested_start.saturating_sub(content_start) <= self.max_frame_bytes {
                                malformed_frame_resync_diagnostic()
                            } else {
                                frame_too_large_diagnostic()
                            };
                        self.mark_protocol(&mut scan.plain_output);
                        self.buffer.drain(..nested_start);
                        scan.events.push(event);
                        continue;
                    }
                }
                self.consume_protocol_boundary(boundary, &mut scan.plain_output);
                scan.events.push(frame_too_large_diagnostic());
                continue;
            }

            if boundary.kind == BotifiedFrameBoundaryKind::Newline {
                if let Some(nested_start) = nested_start {
                    if nested_start < boundary.start {
                        self.mark_protocol(&mut scan.plain_output);
                        self.buffer.drain(..nested_start);
                        scan.events.push(malformed_frame_resync_diagnostic());
                        continue;
                    }
                }
                self.consume_protocol_boundary(boundary, &mut scan.plain_output);
                scan.events.push(incomplete_frame_diagnostic(
                    "discarded incomplete botified frame at newline",
                ));
                continue;
            }

            let content_end = boundary.start;
            let payload = self.buffer[content_start..content_end].to_vec();
            let parsed = parse_botified_frame(&payload);
            if is_malformed_frame_event(&parsed) {
                if let Some(relative_nested_start) = find_bytes(&payload, BOTIFIED_OPEN) {
                    let nested_start = content_start + relative_nested_start;
                    self.mark_protocol(&mut scan.plain_output);
                    self.buffer.drain(..nested_start);
                    scan.events.push(malformed_frame_resync_diagnostic());
                    continue;
                }
            }
            self.buffer.drain(..boundary.end);
            self.mark_protocol(&mut scan.plain_output);
            scan.events.push(parsed);
        }

        scan
    }

    pub fn finish(&mut self) -> BotifiedFrameScan {
        let mut scan = BotifiedFrameScan::default();
        if self.state == BotifiedFrameScannerState::DiscardingOversizedFrame {
            self.buffer.clear();
            self.state = BotifiedFrameScannerState::Scanning;
            return scan;
        }
        if self.buffer.is_empty() {
            self.flush_pending_cr(&mut scan.plain_output);
            return scan;
        }

        if let Some(start) = find_bytes(&self.buffer, BOTIFIED_OPEN) {
            if start > 0 {
                let plain = self.buffer[..start].to_vec();
                self.emit_plain(&plain, &mut scan.plain_output);
            }
            self.buffer.clear();
            self.mark_protocol(&mut scan.plain_output);
            scan.events.push(incomplete_frame_diagnostic(
                "discarded incomplete botified frame at EOF",
            ));
            return scan;
        }

        let plain = std::mem::take(&mut self.buffer);
        self.emit_plain(&plain, &mut scan.plain_output);
        self.flush_pending_cr(&mut scan.plain_output);
        scan
    }

    fn consume_protocol_boundary(
        &mut self,
        boundary: BotifiedFrameBoundary,
        plain_output: &mut Vec<u8>,
    ) {
        let line_ending = (boundary.kind == BotifiedFrameBoundaryKind::Newline)
            .then(|| self.buffer[boundary.start..boundary.end].to_vec());
        self.buffer.drain(..boundary.end);
        self.mark_protocol(plain_output);
        if let Some(line_ending) = line_ending {
            self.emit_plain(&line_ending, plain_output);
        }
    }

    fn mark_protocol(&mut self, plain_output: &mut Vec<u8>) {
        self.flush_pending_cr(plain_output);
        if self.physical_line != PhysicalLineState::Plain {
            self.physical_line = PhysicalLineState::ProtocolOnly;
        }
    }

    fn emit_plain(&mut self, bytes: &[u8], plain_output: &mut Vec<u8>) {
        for &byte in bytes {
            if self.pending_cr {
                self.pending_cr = false;
                if byte == b'\n' {
                    self.emit_line_ending(b"\r\n", plain_output);
                    continue;
                }
                plain_output.push(b'\r');
                self.physical_line = PhysicalLineState::Plain;
            }

            match byte {
                b'\r' => self.pending_cr = true,
                b'\n' => self.emit_line_ending(b"\n", plain_output),
                _ => {
                    plain_output.push(byte);
                    self.physical_line = PhysicalLineState::Plain;
                }
            }
        }
    }

    fn emit_line_ending(&mut self, line_ending: &[u8], plain_output: &mut Vec<u8>) {
        if self.physical_line != PhysicalLineState::ProtocolOnly {
            plain_output.extend_from_slice(line_ending);
        }
        self.physical_line = PhysicalLineState::Empty;
    }

    fn flush_pending_cr(&mut self, plain_output: &mut Vec<u8>) {
        if self.pending_cr {
            plain_output.push(b'\r');
            self.pending_cr = false;
            self.physical_line = PhysicalLineState::Plain;
        }
    }
}

impl Default for BotifiedFrameScanner {
    fn default() -> Self {
        Self::new(DEFAULT_BOTIFIED_FRAME_BYTES)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BotifiedFrameBoundaryKind {
    Close,
    Newline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BotifiedFrameBoundary {
    kind: BotifiedFrameBoundaryKind,
    start: usize,
    end: usize,
}

impl BotifiedFrameBoundary {
    fn offset(self, offset: usize) -> Self {
        Self {
            start: self.start + offset,
            end: self.end + offset,
            ..self
        }
    }
}

fn first_frame_boundary(value: &[u8]) -> Option<BotifiedFrameBoundary> {
    let close = find_bytes(value, BOTIFIED_CLOSE).map(|start| BotifiedFrameBoundary {
        kind: BotifiedFrameBoundaryKind::Close,
        start,
        end: start + BOTIFIED_CLOSE.len(),
    });
    let newline = value.iter().position(|byte| *byte == b'\n').map(|lf| {
        let start = lf.saturating_sub(usize::from(lf > 0 && value[lf - 1] == b'\r'));
        BotifiedFrameBoundary {
            kind: BotifiedFrameBoundaryKind::Newline,
            start,
            end: lf + 1,
        }
    });

    match (close, newline) {
        (Some(close), Some(newline)) if newline.start < close.start => Some(newline),
        (Some(close), _) => Some(close),
        (None, newline) => newline,
    }
}

fn frame_too_large_diagnostic() -> BotifiedFrameEvent {
    BotifiedFrameEvent::ProtocolDiagnostic(TaskFrameDiagnostic {
        op: None,
        code: "frame_too_large",
        message: "botified frame exceeded size limit".to_owned(),
        request_id: None,
    })
}

fn incomplete_frame_diagnostic(message: &str) -> BotifiedFrameEvent {
    BotifiedFrameEvent::ProtocolDiagnostic(TaskFrameDiagnostic {
        op: None,
        code: "incomplete_frame",
        message: message.to_owned(),
        request_id: None,
    })
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
        "registry_delete" => parse_registry_delete_frame(object),
        "observe_request" => parse_observe_request_frame(object),
        _ => protocol_frame_diagnostic(
            Some(op),
            "unsupported_op",
            "botified stdout frame op is not supported",
            None,
        ),
    }
}

fn parse_observe_request_frame(object: &serde_json::Map<String, Value>) -> BotifiedFrameEvent {
    let id = match observe_request_id(object) {
        Ok(id) => id,
        Err(event) => return *event,
    };

    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "op" | "id" | "enabled" | "delivery" | "min_batch_chars"
        ) {
            return rejected_observe_request(
                id,
                "unknown_field",
                format!("unsupported observe_request field: {key}"),
            );
        }
    }

    let enabled = match object.get("enabled") {
        None => true,
        Some(Value::Bool(enabled)) => *enabled,
        Some(_) => {
            return rejected_observe_request(
                id,
                "invalid_enabled",
                "observe_request enabled must be a boolean",
            );
        }
    };

    if !enabled {
        if object.contains_key("delivery") || object.contains_key("min_batch_chars") {
            return rejected_observe_request(
                id,
                "irrelevant_field",
                "disabled observe_request cannot include delivery or min_batch_chars",
            );
        }
        return BotifiedFrameEvent::ObserveRequest(TaskObserveRequestFrame {
            id,
            action: TaskObserveRequestAction::Disable,
        });
    }

    let delivery = match object.get("delivery") {
        Some(Value::String(value)) if value == "final_text" => TaskObserveDelivery::FinalText,
        Some(Value::String(value)) if value == "stream_text" => TaskObserveDelivery::StreamText,
        _ => {
            return rejected_observe_request(
                id,
                "invalid_delivery",
                "enabled observe_request delivery must be \"final_text\" or \"stream_text\"",
            );
        }
    };
    let config = match delivery {
        TaskObserveDelivery::FinalText => {
            if object.contains_key("min_batch_chars") {
                return rejected_observe_request(
                    id,
                    "irrelevant_field",
                    "final_text observe_request cannot include min_batch_chars",
                );
            }
            TaskObserveConfig::final_text()
        }
        TaskObserveDelivery::StreamText => {
            let batch = match object.get("min_batch_chars") {
                None => 1,
                Some(Value::Number(value)) => match value.as_u64() {
                    Some(value @ 1..=4096) => value as u16,
                    _ => {
                        return rejected_observe_request(
                            id,
                            "invalid_min_batch_chars",
                            "stream_text min_batch_chars must be a JSON integer in 1..=4096",
                        );
                    }
                },
                Some(_) => {
                    return rejected_observe_request(
                        id,
                        "invalid_min_batch_chars",
                        "stream_text min_batch_chars must be a JSON integer in 1..=4096",
                    );
                }
            };
            TaskObserveConfig::stream_text(batch)
                .expect("parser range check should produce a valid stream config")
        }
    };
    BotifiedFrameEvent::ObserveRequest(TaskObserveRequestFrame {
        id,
        action: TaskObserveRequestAction::Enable(config),
    })
}

fn observe_request_id(
    object: &serde_json::Map<String, Value>,
) -> Result<String, Box<BotifiedFrameEvent>> {
    let Some(id) = object.get("id").and_then(Value::as_str) else {
        return Err(Box::new(protocol_frame_diagnostic(
            Some("observe_request"),
            "invalid_request_id",
            "observe_request id must be a non-empty frame id token",
            None,
        )));
    };
    if !is_task_frame_id_token(id) || id.chars().count() > TASK_REQUEST_FIELD_CHARS {
        return Err(Box::new(protocol_frame_diagnostic(
            Some("observe_request"),
            "invalid_request_id",
            "observe_request id must be a bounded ASCII frame id token",
            None,
        )));
    }
    Ok(id.to_owned())
}

fn rejected_observe_request(
    id: String,
    code: impl Into<String>,
    message: impl Into<String>,
) -> BotifiedFrameEvent {
    BotifiedFrameEvent::ObserveRequestRejected(TaskObserveRequestRejectedFrame {
        id,
        exception: TaskObserveException::new(code, message, false),
    })
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
        Some(Value::Null) => RegistryTtl::Null,
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

fn parse_registry_delete_frame(object: &serde_json::Map<String, Value>) -> BotifiedFrameEvent {
    let op = "registry_delete";
    let id = match optional_registry_frame_id(object, op) {
        Ok(id) => id,
        Err(event) => return *event,
    };
    if let Err(event) =
        reject_unknown_botified_fields(object, &["op", "id", "topic"], op, id.as_deref())
    {
        return *event;
    }
    let Some(topic) = object.get("topic").and_then(Value::as_str) else {
        return registry_frame_diagnostic(
            Some(op),
            "invalid_topic",
            "registry_delete topic must be a string",
            id,
        );
    };

    BotifiedFrameEvent::RegistryDelete(TaskRegistryDeleteFrame {
        id,
        topic: topic.to_owned(),
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

fn botified_close_prefix_suffix_len(value: &[u8]) -> usize {
    let max = value.len().min(BOTIFIED_CLOSE.len() - 1);
    (1..=max)
        .rev()
        .find(|len| value[value.len() - len..] == BOTIFIED_CLOSE[..*len])
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStdinFrameKind {
    Reply,
    Send,
    Registry,
    ObserveResult,
    Observe,
}

impl TaskStdinFrameKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reply => "reply",
            Self::Send => "send",
            Self::Registry => "registry",
            Self::ObserveResult => "observe_result",
            Self::Observe => "observe",
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

pub fn validate_task_stdin_frame(
    kind: TaskStdinFrameKind,
    bytes: &[u8],
    frame_cap: usize,
) -> Result<(), String> {
    if !bytes.starts_with(BOTIFIED_OPEN) || !bytes.ends_with(BOTIFIED_CLOSE_LINE) {
        return Err(format!(
            "{} stdin frame is not a complete botified frame",
            kind.as_str()
        ));
    }
    if bytes.len() > frame_cap {
        return Err(format!(
            "{} stdin frame exceeds control frame byte limit: {} > {} bytes",
            kind.as_str(),
            bytes.len(),
            frame_cap
        ));
    }
    Ok(())
}

pub fn try_write_task_stdin_frame(
    writer: &dyn TaskStdinWriter,
    kind: TaskStdinFrameKind,
    bytes: &[u8],
) -> Result<TaskStdinWriteSuccess, String> {
    let frame_cap = writer.atomic_frame_cap();
    validate_task_stdin_frame(kind, bytes, frame_cap)?;
    writer.try_write_frame(bytes)
}

pub trait TaskStdinWriter: Send + Sync {
    fn atomic_frame_cap(&self) -> usize;

    fn try_write_frame(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String>;
}

pub trait InteractiveStdioBridge: Send + Sync {
    fn register_stdin_writer(&self, writer: Arc<dyn TaskStdinWriter>) -> Result<(), String>;

    fn handle_frame_events(&self, events: Vec<BotifiedFrameEvent>);
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[derive(Debug)]
pub struct SharedTaskStdinWriter {
    fd: OwnedFd,
    atomic_frame_cap: usize,
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[derive(Debug)]
pub struct SharedTaskStdinWriter;

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl SharedTaskStdinWriter {
    #[cfg(test)]
    pub(crate) fn new_managed_pipe<W>(writer: W) -> Result<Self, String>
    where
        W: IntoRawFd,
    {
        let raw_fd = writer.into_raw_fd();
        // SAFETY: ownership of the descriptor was transferred by IntoRawFd.
        let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        // SAFETY: fd is owned and remains valid for this call.
        let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
        if flags < 0 {
            return Err(format!(
                "managed stdin is unsupported: failed to read writer flags: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: fd is owned and F_SETFL receives flags read from the same descriptor.
        let set_result =
            unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) };
        if set_result < 0 {
            return Err(format!(
                "managed stdin is unsupported: failed to set writer nonblocking: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: fpathconf reads a property from the same valid descriptor.
        let pipe_buf = unsafe { libc::fpathconf(fd.as_raw_fd(), libc::_PC_PIPE_BUF) };
        let atomic_frame_cap = managed_pipe_atomic_frame_cap(pipe_buf)?;
        Ok(Self {
            fd,
            atomic_frame_cap,
        })
    }

    pub fn atomic_frame_cap(&self) -> usize {
        self.atomic_frame_cap
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl TaskStdinWriter for SharedTaskStdinWriter {
    fn atomic_frame_cap(&self) -> usize {
        self.atomic_frame_cap
    }

    fn try_write_frame(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        if bytes.len() > self.atomic_frame_cap {
            return Err(format!(
                "stdin frame exceeds atomic write limit: {} > {} bytes",
                bytes.len(),
                self.atomic_frame_cap
            ));
        }
        try_write_nonblocking_stdin(self.fd.as_raw_fd(), bytes)
    }
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
pub(super) fn managed_pipe_atomic_frame_cap(
    reported_pipe_buf: libc::c_long,
) -> Result<usize, String> {
    if reported_pipe_buf <= 0 {
        return Err(format!(
            "managed stdin is unsupported: _PC_PIPE_BUF reported non-positive value {reported_pipe_buf}"
        ));
    }
    let atomic_frame_cap = usize::try_from(reported_pipe_buf)
        .map_err(|_| {
            format!(
                "managed stdin is unsupported: _PC_PIPE_BUF value {reported_pipe_buf} does not fit usize"
            )
        })?
        .min(TASK_STDIN_FRAME_SAFETY_CEILING);
    if atomic_frame_cap < MIN_TASK_STDIN_FRAME_BYTES {
        return Err(format!(
            "managed stdin is unsupported: atomic frame cap {atomic_frame_cap} cannot hold minimum protocol metadata ({MIN_TASK_STDIN_FRAME_BYTES} bytes)"
        ));
    }
    Ok(atomic_frame_cap)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn try_write_nonblocking_stdin(
    fd: std::os::fd::RawFd,
    bytes: &[u8],
) -> Result<TaskStdinWriteSuccess, String> {
    loop {
        let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if written >= 0 {
            let written = usize::try_from(written).unwrap_or(0);
            return if written == 0 {
                Err("zero-byte nonblocking stdin write".to_owned())
            } else if written == bytes.len() {
                Ok(TaskStdinWriteSuccess::delivered())
            } else {
                Err(format!(
                    "short nonblocking stdin write: {written}/{} bytes",
                    bytes.len()
                ))
            };
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if error.kind() == io::ErrorKind::WouldBlock {
            return Err("stdin writer would block".to_owned());
        }
        return Err(error.to_string());
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

pub fn task_observe_result_enabled_frame(
    request_id: &str,
    config: TaskObserveConfig,
    frame_cap: usize,
) -> Result<String, String> {
    validate_observe_id("observe_result request", request_id)?;
    config.validate()?;
    let mut payload = serde_json::Map::new();
    payload.insert("op".to_owned(), json!("observe_result"));
    payload.insert("id".to_owned(), json!(request_id));
    payload.insert("ok".to_owned(), json!(true));
    payload.insert("observing".to_owned(), json!(true));
    payload.insert("delivery".to_owned(), json!(config.delivery.as_str()));
    if let Some(min_batch_chars) = config.min_batch_chars {
        payload.insert("min_batch_chars".to_owned(), json!(min_batch_chars));
    }
    serialize_task_stdin_payload(TaskStdinFrameKind::ObserveResult, payload, frame_cap)
}

pub fn task_observe_result_disabled_frame(
    request_id: &str,
    frame_cap: usize,
) -> Result<String, String> {
    validate_observe_id("observe_result request", request_id)?;
    serialize_task_stdin_payload(
        TaskStdinFrameKind::ObserveResult,
        json!({
            "op": "observe_result",
            "id": request_id,
            "ok": true,
            "observing": false,
        }),
        frame_cap,
    )
}

pub fn task_observe_result_failure_frame(
    request_id: &str,
    code: &str,
    message: &str,
    retryable: bool,
    frame_cap: usize,
) -> Result<String, String> {
    validate_observe_id("observe_result request", request_id)?;
    serialize_task_stdin_payload(
        TaskStdinFrameKind::ObserveResult,
        json!({
            "op": "observe_result",
            "id": request_id,
            "ok": false,
            "exception": TaskObserveException::new(code, message, retryable),
        }),
        frame_cap,
    )
}

pub fn task_observe_text_frames(
    observation_id: &str,
    metadata: TaskObserveTextMetadata<'_>,
    text: &str,
    frame_cap: usize,
) -> Result<Vec<String>, String> {
    validate_observe_id("observation", observation_id)?;
    validate_observe_text_metadata(metadata)?;
    let timestamp = system_time_rfc3339(metadata.timestamp);

    let mut frames = Vec::new();
    let mut offset = 0;
    let mut chunk_index = 0usize;
    loop {
        let remaining = &text[offset..];
        let final_frame = observe_text_frame_value(
            observation_id,
            metadata,
            &timestamp,
            remaining,
            chunk_index,
            true,
        );
        if let Ok(frame) =
            serialize_task_stdin_payload(TaskStdinFrameKind::Observe, final_frame, frame_cap)
        {
            frames.push(frame);
            return Ok(frames);
        }

        let boundaries: Vec<usize> = remaining
            .char_indices()
            .map(|(index, _)| index)
            .skip(1)
            .collect();
        let mut low = 0usize;
        let mut high = boundaries.len();
        let mut best = None;
        while low < high {
            let middle = low + (high - low) / 2;
            let end = boundaries[middle];
            let candidate = observe_text_frame_value(
                observation_id,
                metadata,
                &timestamp,
                &remaining[..end],
                chunk_index,
                false,
            );
            if serialize_task_stdin_payload(TaskStdinFrameKind::Observe, candidate, frame_cap)
                .is_ok()
            {
                best = Some(end);
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        let Some(end) = best else {
            return Err(format!(
                "observe text metadata cannot fit atomic frame cap {frame_cap}"
            ));
        };
        let frame = serialize_task_stdin_payload(
            TaskStdinFrameKind::Observe,
            observe_text_frame_value(
                observation_id,
                metadata,
                &timestamp,
                &remaining[..end],
                chunk_index,
                false,
            ),
            frame_cap,
        )?;
        frames.push(frame);
        offset += end;
        chunk_index += 1;
    }
}

pub fn task_observe_done_frame(
    observation_id: &str,
    timestamp: SystemTime,
    provider_request_id: &str,
    cycle_id: Option<&str>,
    frame_cap: usize,
) -> Result<String, String> {
    task_observe_terminal_frame(
        observation_id,
        timestamp,
        provider_request_id,
        cycle_id,
        "done",
        None,
        frame_cap,
    )
}

pub fn task_observe_error_frame(
    observation_id: &str,
    timestamp: SystemTime,
    provider_request_id: &str,
    cycle_id: Option<&str>,
    exception: TaskObserveException,
    frame_cap: usize,
) -> Result<String, String> {
    let exception =
        TaskObserveException::new(exception.code, exception.message, exception.retryable);
    task_observe_terminal_frame(
        observation_id,
        timestamp,
        provider_request_id,
        cycle_id,
        "error",
        Some(exception),
        frame_cap,
    )
}

fn task_observe_terminal_frame(
    observation_id: &str,
    timestamp: SystemTime,
    provider_request_id: &str,
    cycle_id: Option<&str>,
    event: &'static str,
    exception: Option<TaskObserveException>,
    frame_cap: usize,
) -> Result<String, String> {
    validate_observe_id("observation", observation_id)?;
    validate_observe_id("provider_request_id", provider_request_id)?;
    validate_optional_observe_id("cycle_id", cycle_id)?;
    let timestamp = system_time_rfc3339(timestamp);
    let mut payload = serde_json::Map::new();
    payload.insert("op".to_owned(), json!("observe"));
    payload.insert("id".to_owned(), json!(observation_id));
    payload.insert("delivery".to_owned(), json!("stream_text"));
    payload.insert("source".to_owned(), json!("assistant"));
    payload.insert("event".to_owned(), json!(event));
    payload.insert("timestamp".to_owned(), json!(timestamp));
    payload.insert("provider_request_id".to_owned(), json!(provider_request_id));
    if let Some(cycle_id) = cycle_id {
        payload.insert("cycle_id".to_owned(), json!(cycle_id));
    }
    if let Some(exception) = exception {
        payload.insert("exception".to_owned(), json!(exception));
    }
    serialize_task_stdin_payload(TaskStdinFrameKind::Observe, payload, frame_cap)
}

fn validate_observe_text_metadata(metadata: TaskObserveTextMetadata<'_>) -> Result<(), String> {
    validate_optional_observe_id("message_id", metadata.message_id)?;
    validate_optional_observe_id("provider_request_id", metadata.provider_request_id)?;
    validate_optional_observe_id("cycle_id", metadata.cycle_id)?;
    match (metadata.delivery, metadata.source) {
        (TaskObserveDelivery::FinalText, _) => {
            if metadata.provider_request_id.is_some() {
                return Err("final_text forbids provider_request_id".to_owned());
            }
        }
        (TaskObserveDelivery::StreamText, TaskObserveSource::User) => {
            if metadata.provider_request_id.is_some() {
                return Err("stream_text user text forbids provider_request_id".to_owned());
            }
        }
        (TaskObserveDelivery::StreamText, TaskObserveSource::Assistant) => {
            if metadata.provider_request_id.is_none() {
                return Err("stream_text assistant text requires provider_request_id".to_owned());
            }
            if metadata.message_id.is_some() {
                return Err("stream_text assistant text forbids message_id".to_owned());
            }
        }
    }
    Ok(())
}

fn observe_text_frame_value(
    observation_id: &str,
    metadata: TaskObserveTextMetadata<'_>,
    timestamp: &str,
    text: &str,
    chunk_index: usize,
    is_last_chunk: bool,
) -> Value {
    let mut payload = serde_json::Map::new();
    payload.insert("op".to_owned(), json!("observe"));
    payload.insert("id".to_owned(), json!(observation_id));
    payload.insert("delivery".to_owned(), json!(metadata.delivery.as_str()));
    payload.insert("source".to_owned(), json!(metadata.source.as_str()));
    payload.insert("event".to_owned(), json!("text"));
    payload.insert("text".to_owned(), json!(text));
    payload.insert("chunk_index".to_owned(), json!(chunk_index));
    payload.insert("is_last_chunk".to_owned(), json!(is_last_chunk));
    payload.insert("timestamp".to_owned(), json!(timestamp));
    if let Some(message_id) = metadata.message_id {
        payload.insert("message_id".to_owned(), json!(message_id));
    }
    if let Some(provider_request_id) = metadata.provider_request_id {
        payload.insert("provider_request_id".to_owned(), json!(provider_request_id));
    }
    if let Some(cycle_id) = metadata.cycle_id {
        payload.insert("cycle_id".to_owned(), json!(cycle_id));
    }
    Value::Object(payload)
}

fn validate_observe_id(label: &str, value: &str) -> Result<(), String> {
    if !is_task_frame_id_token(value) || value.chars().count() > TASK_REQUEST_FIELD_CHARS {
        return Err(format!("{label} must be a bounded ASCII frame id token"));
    }
    Ok(())
}

pub(crate) fn representable_observe_message_id(value: Option<&str>) -> Option<&str> {
    value.filter(|value| validate_observe_id("message_id", value).is_ok())
}

fn validate_optional_observe_id(label: &str, value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value {
        validate_observe_id(label, value)?;
    }
    Ok(())
}

fn serialize_task_stdin_payload(
    kind: TaskStdinFrameKind,
    payload: impl Serialize,
    frame_cap: usize,
) -> Result<String, String> {
    let payload = serde_json::to_string(&payload)
        .map_err(|error| format!("{} frame serialization failed: {error}", kind.as_str()))?;
    let frame = format!("<botified>{payload}</botified>\n");
    validate_task_stdin_frame(kind, frame.as_bytes(), frame_cap)?;
    Ok(frame)
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
