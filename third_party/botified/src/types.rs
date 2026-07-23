use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const DEFAULT_TOOL_RESULT_TEXT_TAIL_BYTES: usize = 8 * 1024;
const TOOL_RESULT_DETAIL_STRING_MAX_BYTES: usize = 2 * 1024;
const TOOL_RESULT_DETAILS_MAX_JSON_BYTES: usize = 64 * 1024;
const TOOL_RESULT_DETAILS_MAX_ARRAY_ITEMS: usize = 64;
const TOOL_RESULT_DETAILS_FALLBACK_ARRAY_ITEMS: usize = 8;
const TOOL_RESULT_DETAILS_MAX_OBJECT_KEYS: usize = 128;

use crate::files::FileSource;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    ImageUrl {
        url: String,
    },
    ImageBase64 {
        mime_type: String,
        data: String,
    },
    File {
        binding: MessageFileBinding,
    },
    Skill {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arguments: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageFileBinding {
    pub message_id: String,
    pub input_id: String,
    pub content_index: usize,
    pub file_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub source: FileSource,
    pub description: Option<String>,
    pub agent_path: Option<String>,
    pub available: bool,
    pub unavailable_reason: Option<String>,
}

impl MessageFileBinding {
    #[allow(clippy::too_many_arguments)]
    pub fn available(
        message_id: impl Into<String>,
        input_id: impl Into<String>,
        content_index: usize,
        file_id: impl Into<String>,
        filename: impl Into<String>,
        mime_type: impl Into<String>,
        size_bytes: u64,
        sha256: impl Into<String>,
        source: FileSource,
        description: Option<String>,
        agent_path: Option<String>,
    ) -> Self {
        Self {
            message_id: message_id.into(),
            input_id: input_id.into(),
            content_index,
            file_id: file_id.into(),
            filename: filename.into(),
            mime_type: mime_type.into(),
            size_bytes,
            sha256: sha256.into(),
            source,
            description,
            agent_path,
            available: true,
            unavailable_reason: None,
        }
    }

    pub fn unavailable(mut self, reason: impl Into<String>) -> Self {
        self.available = false;
        self.unavailable_reason = Some(reason.into());
        self.agent_path = None;
        self
    }
}

impl ContentPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    pub fn image_url(url: impl Into<String>) -> Self {
        Self::ImageUrl { url: url.into() }
    }

    pub fn image_base64(mime_type: impl Into<String>, data: impl Into<String>) -> Self {
        Self::ImageBase64 {
            mime_type: mime_type.into(),
            data: data.into(),
        }
    }

    pub fn file(binding: MessageFileBinding) -> Self {
        Self::File { binding }
    }

    pub fn skill(
        name: Option<impl Into<String>>,
        path: Option<impl Into<String>>,
        arguments: Option<impl Into<String>>,
    ) -> Self {
        Self::Skill {
            name: name.map(Into::into),
            path: path.map(Into::into),
            arguments: arguments.map(Into::into),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_arguments: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments_error: Option<String>,
}

impl ToolCall {
    pub fn new(id: impl Into<String>, name: impl Into<String>, arguments: Value) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            arguments,
            raw_arguments: None,
            arguments_error: None,
        }
    }

    pub fn invalid_arguments(
        id: impl Into<String>,
        name: impl Into<String>,
        raw_arguments: impl Into<String>,
        arguments_error: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            arguments: Value::Null,
            raw_arguments: Some(raw_arguments.into()),
            arguments_error: Some(arguments_error.into()),
        }
    }

    pub fn has_invalid_arguments(&self) -> bool {
        self.arguments_error.is_some()
    }

    pub fn arguments_json_string(&self) -> String {
        self.raw_arguments
            .clone()
            .unwrap_or_else(|| self.arguments.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantMessageReplay {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

impl AssistantMessageReplay {
    pub fn reasoning_content(reasoning_content: impl Into<String>) -> Self {
        Self {
            reasoning_content: Some(reasoning_content.into()),
        }
    }

    pub fn is_empty(&self) -> bool {
        match self.reasoning_content.as_deref() {
            Some(reasoning_content) => reasoning_content.is_empty(),
            None => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub tool_name: String,
    pub text: String,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub terminate: bool,
    #[serde(default)]
    pub details: Value,
}

impl ToolResult {
    pub fn success(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            text: text.into(),
            is_error: false,
            terminate: false,
            details: Value::Null,
        }
    }

    pub fn error(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        text: impl Into<String>,
        details: Value,
    ) -> Self {
        Self {
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            text: text.into(),
            is_error: true,
            terminate: false,
            details,
        }
    }

    pub fn with_terminate(mut self) -> Self {
        self.terminate = true;
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    pub fn bounded_for_transcript(&self) -> Self {
        let mut result = self.clone();
        result.details = bounded_tool_result_details(&result.details);
        result.text = bounded_tool_result_text_for_transcript(&result.text, &result.details);
        result
    }

    pub fn bounded_text_for_model(&self) -> String {
        let details = bounded_tool_result_details(&self.details);
        bounded_tool_result_text_for_transcript(&self.text, &details)
    }
}

pub fn bounded_tool_result_text(text: &str) -> String {
    bounded_text_tail_with_notice(text, DEFAULT_TOOL_RESULT_TEXT_TAIL_BYTES)
}

fn bounded_tool_result_text_for_transcript(text: &str, details: &Value) -> String {
    let trimmed = text.trim_start();
    if matches!(trimmed.as_bytes().first(), Some(b'{') | Some(b'[')) {
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            return bounded_tool_result_details(&value).to_string();
        }
    }
    if let Some(text) = structured_output_tail_text(details, DEFAULT_TOOL_RESULT_TEXT_TAIL_BYTES) {
        return text;
    }
    bounded_tool_result_text(text)
}

pub fn bounded_text_tail_with_notice(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    if max_bytes == 0 {
        return format!(
            "[botified tool result truncated; omitted {} bytes]",
            text.len()
        );
    }
    let tail = utf8_tail(text, max_bytes);
    format!(
        "[botified tool result truncated; showing last {} bytes, omitted {} bytes]\n{}",
        tail.len(),
        text.len().saturating_sub(tail.len()),
        tail
    )
}

pub fn bounded_text_tail(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    utf8_tail(text, max_bytes).to_owned()
}

fn utf8_tail(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len().saturating_sub(max_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

fn bounded_tool_result_details(details: &Value) -> Value {
    let bounded = bounded_detail_value(details, None, 0);
    let json_len = bounded.to_string().len();
    if json_len <= TOOL_RESULT_DETAILS_MAX_JSON_BYTES {
        return bounded;
    }

    let fallback = structured_detail_fallback(details, TOOL_RESULT_DETAILS_FALLBACK_ARRAY_ITEMS);
    if fallback.to_string().len() <= TOOL_RESULT_DETAILS_MAX_JSON_BYTES {
        return fallback;
    }
    structured_detail_fallback(details, 0)
}

fn bounded_detail_value(value: &Value, key: Option<&str>, depth: usize) -> Value {
    if depth >= 8 {
        return Value::String("[botified detail omitted; max depth exceeded]".to_owned());
    }

    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(text) => bounded_detail_string(key, text),
        Value::Array(values) => {
            let mut bounded = values
                .iter()
                .take(TOOL_RESULT_DETAILS_MAX_ARRAY_ITEMS)
                .map(|value| bounded_detail_value(value, None, depth + 1))
                .collect::<Vec<_>>();
            if values.len() > bounded.len() {
                bounded.push(json!({
                    "bounded": true,
                    "omitted_items": values.len() - bounded.len()
                }));
            }
            Value::Array(bounded)
        }
        Value::Object(object) => {
            let mut bounded = Map::new();
            for key in structured_detail_priority_keys() {
                if let Some(value) = object.get(key) {
                    if key != "aggregated_output" {
                        bounded.insert(
                            key.to_owned(),
                            bounded_detail_value(value, Some(key), depth + 1),
                        );
                    }
                }
            }
            for (key, value) in object.iter() {
                if bounded.len() >= TOOL_RESULT_DETAILS_MAX_OBJECT_KEYS {
                    break;
                }
                if key == "aggregated_output" {
                    continue;
                }
                if bounded.contains_key(key) {
                    continue;
                }
                bounded.insert(
                    key.clone(),
                    bounded_detail_value(value, Some(key.as_str()), depth + 1),
                );
            }
            if object.len() > bounded.len() {
                bounded.insert(
                    "_omitted_keys".to_owned(),
                    json!(object.len().saturating_sub(bounded.len())),
                );
            }
            Value::Object(bounded)
        }
    }
}

// Tool results are bounded before they enter the transcript, but many built-in
// tools return structured JSON that the model must still understand. Keep these
// groups small and semantic: new large text fields should normally be represented
// as an `output_tail` plus an artifact path, not added here as another full dump.
const STRUCTURED_DETAIL_CORE_KEYS: &[&str] = &[
    "kind",
    "total",
    "omitted",
    "returned_count",
    "truncated",
    "truncated_reason",
    "error",
];

const STRUCTURED_DETAIL_REGISTRY_KEYS: &[&str] =
    &["matched_count", "server_time", "oldest_seq", "newest_seq"];

const STRUCTURED_DETAIL_TASK_KEYS: &[&str] = &[
    "tasks",
    "items",
    "task",
    "task_id",
    "state",
    "status",
    "output_tail",
    "output_bytes",
    "output_dropped_bytes",
    "output_artifact_path",
    "output_artifact_truncated",
    "output_live",
    "output_complete",
    "callback_delivery",
    "callback_failure_reason",
    "cancelled_task_ids",
];

const STRUCTURED_DETAIL_SUBAGENT_KEYS: &[&str] = &[
    "subagents",
    "subagent_id",
    "name",
    "purpose",
    "lifecycle",
    "run_state",
    "status_summary",
    "latest_result",
    "latest_error",
    "queued_message_count",
    "queued_messages",
    "owned_task_count",
    "owned_task_ids",
    "owned_task_ids_omitted",
    "owned_task_ids_truncated",
    "callback_count",
    "pending_callback_count",
    "failed_callback_count",
    "callbacks",
    "callbacks_omitted",
    "callbacks_truncated",
    "latest_callback",
    "tail",
    "tail_truncated",
];

const STRUCTURED_DETAIL_PRIORITY_KEY_GROUPS: &[&[&str]] = &[
    STRUCTURED_DETAIL_CORE_KEYS,
    STRUCTURED_DETAIL_REGISTRY_KEYS,
    STRUCTURED_DETAIL_TASK_KEYS,
    STRUCTURED_DETAIL_SUBAGENT_KEYS,
];

fn structured_detail_priority_keys() -> impl Iterator<Item = &'static str> {
    STRUCTURED_DETAIL_PRIORITY_KEY_GROUPS
        .iter()
        .flat_map(|group| group.iter().copied())
}

fn structured_detail_fallback(details: &Value, array_items: usize) -> Value {
    let mut fallback = Map::new();
    match details {
        Value::Object(object) => {
            for key in structured_detail_priority_keys() {
                if let Some(value) = object.get(key) {
                    fallback.insert(
                        key.to_owned(),
                        fallback_detail_value(value, Some(key), array_items, 0),
                    );
                }
            }
            fallback.insert("bounded".to_owned(), Value::Bool(true));
            fallback.insert(
                "omitted_reason".to_owned(),
                Value::String("tool_result_details_too_large".to_owned()),
            );
            fallback.insert(
                "original_json_bytes".to_owned(),
                json!(details.to_string().len()),
            );
            Value::Object(fallback)
        }
        Value::Array(values) => {
            fallback.insert(
                "items".to_owned(),
                fallback_detail_value(details, Some("items"), array_items, 0),
            );
            fallback.insert("total".to_owned(), json!(values.len()));
            fallback.insert(
                "omitted".to_owned(),
                json!(values.len().saturating_sub(array_items.min(values.len()))),
            );
            fallback.insert("bounded".to_owned(), Value::Bool(true));
            fallback.insert(
                "omitted_reason".to_owned(),
                Value::String("tool_result_details_too_large".to_owned()),
            );
            fallback.insert(
                "original_json_bytes".to_owned(),
                json!(details.to_string().len()),
            );
            Value::Object(fallback)
        }
        _ => {
            fallback.insert(
                "value".to_owned(),
                fallback_detail_value(details, None, 0, 0),
            );
            fallback.insert("bounded".to_owned(), Value::Bool(true));
            fallback.insert(
                "omitted_reason".to_owned(),
                Value::String("tool_result_details_too_large".to_owned()),
            );
            fallback.insert(
                "original_json_bytes".to_owned(),
                json!(details.to_string().len()),
            );
            Value::Object(fallback)
        }
    }
}

fn fallback_detail_value(
    value: &Value,
    key: Option<&str>,
    array_items: usize,
    depth: usize,
) -> Value {
    if depth >= 4 {
        return Value::String("[botified detail omitted; max depth exceeded]".to_owned());
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(text) => bounded_detail_string(key, text),
        Value::Array(values) => {
            let keep = array_items.min(values.len());
            let mut bounded = values
                .iter()
                .take(keep)
                .map(|value| fallback_detail_value(value, None, array_items, depth + 1))
                .collect::<Vec<_>>();
            if values.len() > keep {
                bounded.push(json!({
                    "bounded": true,
                    "omitted_items": values.len() - keep
                }));
            }
            Value::Array(bounded)
        }
        Value::Object(object) => {
            let mut bounded = Map::new();
            for key in structured_detail_priority_keys() {
                if let Some(value) = object.get(key) {
                    bounded.insert(
                        key.to_owned(),
                        fallback_detail_value(value, Some(key), array_items, depth + 1),
                    );
                }
            }
            for (key, value) in object.iter() {
                if bounded.len() >= 24 {
                    break;
                }
                if key == "aggregated_output" || bounded.contains_key(key) {
                    continue;
                }
                bounded.insert(
                    key.clone(),
                    fallback_detail_value(value, Some(key.as_str()), array_items, depth + 1),
                );
            }
            if object.len() > bounded.len() {
                bounded.insert(
                    "_omitted_keys".to_owned(),
                    json!(object.len().saturating_sub(bounded.len())),
                );
            }
            Value::Object(bounded)
        }
    }
}

fn structured_output_tail_text(details: &Value, max_bytes: usize) -> Option<String> {
    let object = details.as_object()?;
    let output_tail = object.get("output_tail").and_then(Value::as_str)?;
    let mut lines = Vec::new();
    if let Some(tool_name) = object.get("tool_name").and_then(Value::as_str) {
        lines.push(format!("tool: {}", tool_name.replace('\n', "\\n")));
    }
    if let Some(status) = output_status(object) {
        lines.push(format!("status: {status}"));
    }
    for key in [
        "task_id",
        "state",
        "exit_code",
        "detach_after_secs",
        "timeout_secs",
        "forced_termination_at",
        "timed_out",
        "cancelled",
        "truncated",
        "background_task_detached",
        "output_artifact_path",
        "output_live",
        "output_complete",
        "output_bytes",
        "output_tail_truncated",
        "output_artifact_truncated",
        "output_dropped_bytes",
    ] {
        if let Some(value) = object.get(key) {
            lines.push(format!("{key}: {}", single_line_detail_value(value)));
        }
    }
    lines.push("output_tail:".to_owned());
    let mut text = lines.join("\n");
    text.push('\n');
    if text.len() >= max_bytes {
        while text.len() > max_bytes {
            text.pop();
        }
        return Some(text);
    }
    let available = max_bytes - text.len();
    text.push_str(utf8_tail(output_tail, available));
    Some(text)
}

fn output_status(object: &Map<String, Value>) -> Option<String> {
    if let Some(status) = object
        .get("status")
        .or_else(|| object.get("state"))
        .and_then(Value::as_str)
    {
        return Some(status.replace('\n', "\\n"));
    }
    if object
        .get("cancelled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some("cancelled".to_owned());
    }
    if object
        .get("timed_out")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some("timed_out".to_owned());
    }
    match object.get("exit_code") {
        Some(Value::Number(number)) if number.as_i64() == Some(0) => Some("completed".to_owned()),
        Some(Value::Number(_)) => Some("failed".to_owned()),
        _ => None,
    }
}

fn single_line_detail_value(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.replace('\n', "\\n"),
        Value::Array(_) | Value::Object(_) => value.to_string().replace('\n', "\\n"),
    }
}

fn bounded_detail_string(key: Option<&str>, text: &str) -> Value {
    if matches!(key, Some("output_tail" | "tail")) {
        return Value::String(bounded_text_tail(text, DEFAULT_TOOL_RESULT_TEXT_TAIL_BYTES));
    }
    if text.len() <= TOOL_RESULT_DETAIL_STRING_MAX_BYTES {
        return Value::String(text.to_owned());
    }
    Value::String(format!("[botified detail omitted; {} bytes]", text.len()))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    User {
        content: Vec<ContentPart>,
    },
    Assistant {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolCall>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assistant_replay: Option<AssistantMessageReplay>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_reason: Option<StopReason>,
    },
    ToolResult(ToolResult),
}

impl Message {
    pub fn user(content: Vec<ContentPart>) -> Self {
        Self::User { content }
    }

    pub fn assistant_text(text: impl Into<String>) -> Self {
        Self::Assistant {
            content: Some(text.into()),
            tool_calls: Vec::new(),
            assistant_replay: None,
            usage: None,
            stop_reason: Some(StopReason::EndTurn),
        }
    }

    pub fn assistant_tool_calls(tool_calls: Vec<ToolCall>) -> Self {
        Self::Assistant {
            content: None,
            tool_calls,
            assistant_replay: None,
            usage: None,
            stop_reason: Some(StopReason::ToolCalls),
        }
    }

    pub fn assistant_tool_calls_with_replay(
        tool_calls: Vec<ToolCall>,
        assistant_replay: AssistantMessageReplay,
    ) -> Self {
        Self::Assistant {
            content: None,
            tool_calls,
            assistant_replay: Some(assistant_replay),
            usage: None,
            stop_reason: Some(StopReason::ToolCalls),
        }
    }

    pub fn tool_result(result: ToolResult) -> Self {
        Self::ToolResult(result)
    }

    pub fn is_valid_assistant_for_provider_replay(&self) -> bool {
        match self {
            Self::Assistant {
                content,
                tool_calls,
                ..
            } => assistant_payload_is_valid(content.as_deref(), tool_calls),
            Self::User { .. } | Self::ToolResult(_) => true,
        }
    }
}

pub fn assistant_payload_is_valid(content: Option<&str>, tool_calls: &[ToolCall]) -> bool {
    content.is_some_and(|content| !content.trim().is_empty()) || !tool_calls.is_empty()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    #[serde(default)]
    pub reasoning_output_tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    ToolCalls,
    ToolTerminated,
    ProviderStop,
}

impl StopReason {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::EndTurn => "end_turn",
            Self::ToolCalls => "tool_calls",
            Self::ToolTerminated => "tool_terminated",
            Self::ProviderStop => "provider_stop",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextRole {
    System,
    Developer,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelInput {
    Context { role: ContextRole, content: String },
    Message { message: Message },
}

impl ModelInput {
    pub fn context(role: ContextRole, content: impl Into<String>) -> Self {
        Self::Context {
            role,
            content: content.into(),
        }
    }

    pub fn message(message: Message) -> Self {
        Self::Message { message }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use super::StopReason;

    #[test]
    fn stop_reason_as_str_matches_serde_wire_names() {
        for (reason, expected) in [
            (StopReason::EndTurn, "end_turn"),
            (StopReason::ToolCalls, "tool_calls"),
            (StopReason::ToolTerminated, "tool_terminated"),
            (StopReason::ProviderStop, "provider_stop"),
        ] {
            assert_eq!(reason.as_str(), expected);
            assert_eq!(
                serde_json::to_value(reason).expect("stop reason should serialize"),
                serde_json::json!(expected)
            );
        }
    }
}
