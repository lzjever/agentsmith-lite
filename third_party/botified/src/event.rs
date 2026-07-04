use std::collections::VecDeque;
use std::fmt;
use std::str::FromStr;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::timeline::TimelineActiveProjection;

pub const DEFAULT_EVENT_LOG_CAPACITY: usize = 1024;
const REDACTED: &str = "[redacted]";
const MAX_EVENT_DATA_STRING: usize = 64;
const MAX_EVENT_STRING_CHARS: usize = 4096;
const MAX_EVENT_ARRAY_ITEMS: usize = 64;
const MAX_EVENT_OBJECT_ENTRIES: usize = 64;
const TRUNCATED: &str = "...[truncated]";
const GLOBAL_CURSOR_PREFIX: &str = "evt_";
const MESSAGE_CURSOR_PREFIX: &str = "msg_";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventCursor {
    Global { instance: String, seq: u64 },
    Message { seq: u64, message_id: String },
}

impl EventCursor {
    pub fn from_seq(seq: u64) -> Self {
        Self::global_unchecked(default_process_instance(), seq)
    }

    pub fn for_instance(
        instance: impl Into<String>,
        seq: u64,
    ) -> Result<Self, EventCursorParseError> {
        let instance = instance.into();
        validate_timeline_instance(&instance)?;
        Ok(Self::global_unchecked(instance, seq))
    }

    pub fn for_message(seq: u64, message_id: impl Into<String>) -> Self {
        Self::Message {
            seq,
            message_id: message_id.into(),
        }
    }

    pub fn stream_start() -> Self {
        Self::from_seq(0)
    }

    pub fn parse(value: &str) -> Result<Self, EventCursorParseError> {
        value.parse()
    }

    pub fn parse_timeline(value: &str) -> Result<Self, EventCursorParseError> {
        parse_timeline_cursor(value)
    }

    pub fn seq(&self) -> u64 {
        match self {
            Self::Global { seq, .. } | Self::Message { seq, .. } => *seq,
        }
    }

    pub fn instance(&self) -> Option<&str> {
        match self {
            Self::Global { instance, .. } => Some(instance),
            Self::Message { .. } => None,
        }
    }

    pub fn message_id(&self) -> Option<&str> {
        match self {
            Self::Global { .. } => None,
            Self::Message { message_id, .. } => Some(message_id),
        }
    }

    pub fn is_timeline(&self) -> bool {
        match self {
            Self::Global { instance, .. } => validate_timeline_instance(instance).is_ok(),
            Self::Message { .. } => false,
        }
    }

    fn global_unchecked(instance: impl Into<String>, seq: u64) -> Self {
        Self::Global {
            instance: instance.into(),
            seq,
        }
    }
}

impl fmt::Display for EventCursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Global { instance, seq } => {
                write!(f, "{GLOBAL_CURSOR_PREFIX}{instance}_{seq}")
            }
            Self::Message { seq, message_id } => {
                write!(
                    f,
                    "{MESSAGE_CURSOR_PREFIX}{seq}_{}",
                    hex_encode(message_id.as_bytes())
                )
            }
        }
    }
}

impl FromStr for EventCursor {
    type Err = EventCursorParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.starts_with(GLOBAL_CURSOR_PREFIX) {
            return parse_timeline_cursor(value);
        }

        if let Some(message) = value.strip_prefix(MESSAGE_CURSOR_PREFIX) {
            let Some((seq, encoded_message_id)) = message.split_once('_') else {
                return Err(EventCursorParseError);
            };
            let seq = seq.parse().map_err(|_| EventCursorParseError)?;
            let message_id = String::from_utf8(hex_decode(encoded_message_id)?)
                .map_err(|_| EventCursorParseError)?;
            return Ok(Self::for_message(seq, message_id));
        }

        Err(EventCursorParseError)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventCursorParseError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventReadError {
    StaleCursor,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EventReadWindow {
    pub events: Vec<ServiceEvent>,
    pub next_cursor: EventCursor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServiceEvent {
    pub seq: u64,
    pub time: String,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub data: Value,
}

impl ServiceEvent {
    pub fn new(
        seq: u64,
        event_type: impl Into<String>,
        session: Option<&str>,
        turn_id: Option<&str>,
        data: Value,
    ) -> Self {
        Self {
            seq,
            time: timestamp_now(),
            event_type: event_type.into(),
            session: session.map(ToOwned::to_owned),
            turn_id: turn_id.map(ToOwned::to_owned),
            data: redact_event_data(data),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EventLog {
    process_instance: String,
    capacity: usize,
    next_seq: u64,
    events: VecDeque<ServiceEvent>,
    timeline_active: TimelineActiveProjection,
}

impl Default for EventLog {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_EVENT_LOG_CAPACITY)
    }
}

impl EventLog {
    pub fn with_capacity(capacity: usize) -> Self {
        Self::with_process_instance(default_process_instance(), capacity)
            .expect("default process instance should be a valid timeline cursor instance")
    }

    pub fn with_process_instance(
        process_instance: impl Into<String>,
        capacity: usize,
    ) -> Result<Self, EventCursorParseError> {
        let process_instance = process_instance.into();
        validate_timeline_instance(&process_instance)?;
        Ok(Self {
            process_instance,
            capacity: capacity.max(1),
            next_seq: 1,
            events: VecDeque::new(),
            timeline_active: TimelineActiveProjection::default(),
        })
    }

    pub fn process_instance(&self) -> &str {
        &self.process_instance
    }

    pub fn append(
        &mut self,
        event_type: impl Into<String>,
        session: Option<&str>,
        turn_id: Option<&str>,
        data: Value,
    ) -> ServiceEvent {
        let event = ServiceEvent::new(self.next_seq, event_type, session, turn_id, data);
        self.next_seq += 1;
        self.append_committed(event.clone());
        event
    }

    pub fn append_committed(&mut self, event: ServiceEvent) {
        self.next_seq = self.next_seq.max(event.seq.saturating_add(1));
        self.timeline_active
            .apply_event_with_cancelled_subagent_limit(&event, self.capacity);

        if self.events.len() == self.capacity {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }

    pub fn active_timeline_items(&self) -> Vec<Value> {
        self.timeline_active
            .items()
            .into_iter()
            .map(|item| serde_json::to_value(item).expect("timeline active item should serialize"))
            .collect()
    }

    pub fn read_after(&self, after_seq: u64) -> Vec<ServiceEvent> {
        let Some(earliest) = self.events.front().map(|event| event.seq) else {
            return Vec::new();
        };

        let mut events = Vec::new();
        if after_seq.saturating_add(1) < earliest {
            events.push(ServiceEvent::new(
                earliest.saturating_sub(1),
                "event.gap",
                None,
                None,
                json!({
                    "requested_seq": after_seq,
                    "earliest_seq": earliest
                }),
            ));
        }

        events.extend(
            self.events
                .iter()
                .filter(|event| event.seq > after_seq)
                .cloned(),
        );
        events
    }

    pub fn read_after_cursor(
        &self,
        cursor: EventCursor,
    ) -> Result<Vec<ServiceEvent>, EventReadError> {
        Ok(self.read_window_after_cursor(cursor)?.events)
    }

    pub fn read_window_after_cursor(
        &self,
        cursor: EventCursor,
    ) -> Result<EventReadWindow, EventReadError> {
        let cursor_seq = match cursor {
            EventCursor::Global { instance, seq } if instance == self.process_instance => seq,
            EventCursor::Global { .. } | EventCursor::Message { .. } => {
                return Err(EventReadError::StaleCursor);
            }
        };
        let latest_seq = self.events.back().map(|event| event.seq).unwrap_or(0);
        if cursor_seq > latest_seq {
            return Err(EventReadError::StaleCursor);
        }
        let cutoff_cursor = self.cursor_for_seq(latest_seq);

        if let Some(earliest) = self.events.front().map(|event| event.seq) {
            if cursor_seq.saturating_add(1) < earliest {
                return Err(EventReadError::StaleCursor);
            }
        }

        let events = self
            .events
            .iter()
            .filter(|event| event.seq > cursor_seq && event.seq <= latest_seq)
            .cloned()
            .collect();

        Ok(EventReadWindow {
            events,
            next_cursor: cutoff_cursor,
        })
    }

    pub fn current_cursor(&self) -> EventCursor {
        self.cursor_for_seq(self.events.back().map(|event| event.seq).unwrap_or(0))
    }

    fn cursor_for_seq(&self, seq: u64) -> EventCursor {
        EventCursor::global_unchecked(self.process_instance.clone(), seq)
    }
}

fn parse_timeline_cursor(value: &str) -> Result<EventCursor, EventCursorParseError> {
    let Some(cursor) = value.strip_prefix(GLOBAL_CURSOR_PREFIX) else {
        return Err(EventCursorParseError);
    };
    let Some((instance, seq)) = cursor.split_once('_') else {
        return Err(EventCursorParseError);
    };
    validate_timeline_instance(instance)?;
    if seq.is_empty() || !seq.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(EventCursorParseError);
    }
    let seq = seq.parse().map_err(|_| EventCursorParseError)?;
    Ok(EventCursor::global_unchecked(instance, seq))
}

fn validate_timeline_instance(instance: &str) -> Result<(), EventCursorParseError> {
    if instance.is_empty() || !instance.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(EventCursorParseError);
    }
    Ok(())
}

fn default_process_instance() -> String {
    static INSTANCE: OnceLock<String> = OnceLock::new();
    INSTANCE.get_or_init(generate_process_instance).clone()
}

fn generate_process_instance() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("p{timestamp:x}{:x}", std::process::id())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn hex_decode(value: &str) -> Result<Vec<u8>, EventCursorParseError> {
    if value.is_empty() || !value.len().is_multiple_of(2) {
        return Err(EventCursorParseError);
    }

    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = hex_value(pair[0])?;
            let low = hex_value(pair[1])?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn hex_value(byte: u8) -> Result<u8, EventCursorParseError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(EventCursorParseError),
    }
}

pub fn redact_event_data(value: Value) -> Value {
    match value {
        Value::Array(items) => {
            let original_len = items.len();
            let mut redacted = items
                .into_iter()
                .take(MAX_EVENT_ARRAY_ITEMS)
                .map(redact_event_data)
                .collect::<Vec<_>>();
            if original_len > MAX_EVENT_ARRAY_ITEMS {
                redacted.push(json!({
                    "_truncated": {
                        "omitted_items": original_len - MAX_EVENT_ARRAY_ITEMS
                    }
                }));
            }
            Value::Array(redacted)
        }
        Value::Object(object) => {
            let image_payload = is_image_payload(&object);
            Value::Object(redact_object(object, image_payload))
        }
        Value::String(text) => Value::String(bound_event_string(text)),
        other => other,
    }
}

fn redact_object(object: Map<String, Value>, image_payload: bool) -> Map<String, Value> {
    let original_len = object.len();
    let mut redacted = object
        .into_iter()
        .take(MAX_EVENT_OBJECT_ENTRIES)
        .map(|(key, value)| {
            let redacted = if should_redact_key(&key, &value, image_payload) {
                Value::String(REDACTED.to_owned())
            } else {
                redact_event_data(value)
            };
            (key, redacted)
        })
        .collect::<Map<_, _>>();
    if original_len > MAX_EVENT_OBJECT_ENTRIES {
        redacted.insert(
            "_truncated".to_owned(),
            json!({
                "omitted_entries": original_len - MAX_EVENT_OBJECT_ENTRIES
            }),
        );
    }
    redacted
}

fn should_redact_key(key: &str, value: &Value, image_payload: bool) -> bool {
    let normalized = key.to_ascii_lowercase();
    if [
        "api_key",
        "service_key",
        "authorization",
        "token",
        "secret",
        "password",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
    {
        return true;
    }

    if normalized.contains("base64") {
        return true;
    }

    if image_payload && normalized == "data" {
        return true;
    }

    normalized == "data"
        && value
            .as_str()
            .is_some_and(|text| text.len() > MAX_EVENT_DATA_STRING)
}

fn bound_event_string(text: String) -> String {
    if text.chars().count() <= MAX_EVENT_STRING_CHARS {
        return text;
    }

    let mut bounded = text
        .chars()
        .take(MAX_EVENT_STRING_CHARS)
        .collect::<String>();
    bounded.push_str(TRUNCATED);
    bounded
}

fn is_image_payload(object: &Map<String, Value>) -> bool {
    object
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|value| value == "image_base64")
        || object
            .get("mime_type")
            .and_then(Value::as_str)
            .is_some_and(|value| value.to_ascii_lowercase().starts_with("image/"))
}

fn timestamp_now() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("unix:{}", duration.as_secs())
}
