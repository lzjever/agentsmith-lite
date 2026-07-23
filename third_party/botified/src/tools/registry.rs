use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::formatting::bounded_chars;
use crate::registry::{
    RegistryDeleteAck, RegistryError, RegistryHistoryResult, RegistryItem, RegistryQuery,
    RegistryQueryResult, RegistrySetAck, RegistrySetRequest, RegistryStore, RegistryTtl,
    RegistryWriterKind,
};
use crate::tools::{Tool, ToolError, ToolExecutionContext, ToolSpec};
use crate::types::{ToolCall, ToolResult};

pub const REGISTRY_SET_TOOL_NAME: &str = "registry_set";
pub const REGISTRY_DELETE_TOOL_NAME: &str = "registry_delete";
pub const REGISTRY_GET_TOOL_NAME: &str = "registry_get";
pub const REGISTRY_HISTORY_TOOL_NAME: &str = "registry_history";
const REGISTRY_TOOL_ERROR_MESSAGE_CHARS: usize = 256;
const REGISTRY_TOOL_FIELD_CHARS: usize = 64;

pub fn registry_tools_for_writer(
    store: RegistryStore,
    writer_kind: RegistryWriterKind,
    origin: impl Into<String>,
) -> Vec<Arc<dyn Tool>> {
    let origin = origin.into();
    vec![
        Arc::new(RegistrySetTool::new(
            store.clone(),
            writer_kind,
            origin.clone(),
        )),
        Arc::new(RegistryDeleteTool::new(store.clone(), writer_kind, origin)),
        Arc::new(RegistryGetTool::new(store.clone())),
        Arc::new(RegistryHistoryTool::new(store)),
    ]
}

pub fn is_registry_tool_name(name: &str) -> bool {
    matches!(
        name,
        REGISTRY_SET_TOOL_NAME
            | REGISTRY_DELETE_TOOL_NAME
            | REGISTRY_GET_TOOL_NAME
            | REGISTRY_HISTORY_TOOL_NAME
    )
}

pub struct RegistryDeleteTool {
    store: RegistryStore,
    writer_kind: RegistryWriterKind,
    origin: String,
}

impl RegistryDeleteTool {
    pub fn new(store: RegistryStore, writer_kind: RegistryWriterKind, origin: String) -> Self {
        Self {
            store,
            writer_kind,
            origin,
        }
    }
}

#[async_trait]
impl Tool for RegistryDeleteTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            REGISTRY_DELETE_TOOL_NAME,
            "Delete the exact current registry topic. Deleting a missing or expired topic is a no-op.",
            json!({
                "type": "object",
                "required": ["topic"],
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": "Exact dot-separated topic; wildcards and patterns are not supported."
                    }
                },
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
        let max_response_bytes = self.store.config().max_response_bytes;
        let topic = match parse_delete_arguments(&call, max_response_bytes) {
            Ok(topic) => topic,
            Err(result) => return Ok(result),
        };
        match self
            .store
            .delete(self.writer_kind, self.origin.clone(), topic)
        {
            Ok(ack) => Ok(registry_delete_success(call, ack, max_response_bytes)),
            Err(error) => Ok(registry_store_error(call, error, max_response_bytes)),
        }
    }
}

pub struct RegistrySetTool {
    store: RegistryStore,
    writer_kind: RegistryWriterKind,
    origin: String,
}

impl RegistrySetTool {
    pub fn new(store: RegistryStore, writer_kind: RegistryWriterKind, origin: String) -> Self {
        Self {
            store,
            writer_kind,
            origin,
        }
    }
}

#[async_trait]
impl Tool for RegistrySetTool {
    fn spec(&self) -> ToolSpec {
        let default_ttl_secs = self.store.config().default_ttl.as_secs_f64();
        let history_retention_secs = self.store.config().history_retention.as_secs_f64();
        ToolSpec::new(
            REGISTRY_SET_TOOL_NAME,
            "Write a short-term registry state value for a topic.",
            json!({
                "type": "object",
                "required": ["topic", "value"],
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": "Dot-separated topic segments; wildcards are not supported."
                    },
                    "value": {},
                    "ttl_secs": {
                        "type": ["number", "null"],
                        "exclusiveMinimum": 0,
                        "description": format!(
                            "TTL in seconds: omit for the configured default ({default_ttl_secs}s), provide a positive number, or use null to keep the value until deletion, overwrite, or restart. Current TTL is independent of the {history_retention_secs}s history retention window. Expired values are not returned by registry_get."
                        )
                    },
                    "freq_hz": { "type": "number" },
                    "source": { "type": "string" }
                },
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
        let max_response_bytes = self.store.config().max_response_bytes;
        let request = match parse_set_arguments(&call, max_response_bytes) {
            Ok(request) => request,
            Err(result) => return Ok(result),
        };
        match self
            .store
            .set(self.writer_kind, self.origin.clone(), request)
        {
            Ok(ack) => Ok(registry_set_success(call, ack, max_response_bytes)),
            Err(error) => Ok(registry_store_error(call, error, max_response_bytes)),
        }
    }
}

pub struct RegistryGetTool {
    store: RegistryStore,
}

impl RegistryGetTool {
    pub fn new(store: RegistryStore) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for RegistryGetTool {
    fn spec(&self) -> ToolSpec {
        let config = self.store.config();
        ToolSpec::new(
            REGISTRY_GET_TOOL_NAME,
            "Read current, unexpired registry state for a topic pattern. Results may be truncated by limit or response budget.",
            json!({
                "type": "object",
                "required": ["topic"],
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": topic_pattern_description()
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": config.max_query_limit,
                        "default": config.default_query_limit,
                        "description": query_limit_description(config.default_query_limit, config.max_query_limit)
                    }
                },
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
        let max_response_bytes = self.store.config().max_response_bytes;
        let query = match parse_get_arguments(&call, max_response_bytes) {
            Ok(query) => query,
            Err(result) => return Ok(result),
        };
        match self.store.get(query) {
            Ok(result) => Ok(registry_get_success(call, result, max_response_bytes)),
            Err(error) => Ok(registry_store_error(call, error, max_response_bytes)),
        }
    }
}

pub struct RegistryHistoryTool {
    store: RegistryStore,
}

impl RegistryHistoryTool {
    pub fn new(store: RegistryStore) -> Self {
        Self { store }
    }
}

#[async_trait]
impl Tool for RegistryHistoryTool {
    fn spec(&self) -> ToolSpec {
        let config = self.store.config();
        ToolSpec::new(
            REGISTRY_HISTORY_TOOL_NAME,
            "Read recent registry history samples for a topic pattern. Results may be truncated by limit or response budget.",
            json!({
                "type": "object",
                "required": ["topic", "since_secs"],
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": topic_pattern_description()
                    },
                    "since_secs": {
                        "type": "number",
                        "exclusiveMinimum": 0,
                        "description": format!(
                            "Positive lookback window in seconds; the effective lookback is capped by the configured retention ({}s).",
                            config.history_retention.as_secs_f64()
                        )
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": config.max_query_limit,
                        "default": config.default_query_limit,
                        "description": query_limit_description(config.default_query_limit, config.max_query_limit)
                    }
                },
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
        let max_response_bytes = self.store.config().max_response_bytes;
        let query = match parse_history_arguments(&call, max_response_bytes) {
            Ok(query) => query,
            Err(result) => return Ok(result),
        };
        match self.store.history(query) {
            Ok(result) => Ok(registry_history_success(call, result, max_response_bytes)),
            Err(error) => Ok(registry_store_error(call, error, max_response_bytes)),
        }
    }
}

fn query_limit_description(default: usize, max: usize) -> String {
    format!(
        "Maximum items to return; defaults to {default}, maximum {max}. Values outside 1..={max} return an error."
    )
}

fn topic_pattern_description() -> &'static str {
    "Dot-separated topic pattern; * matches one segment. ** is allowed only as the final segment and matches zero or more remaining segments, including the base topic itself."
}

fn parse_set_arguments(
    call: &ToolCall,
    max_response_bytes: usize,
) -> Result<RegistrySetRequest, ToolResult> {
    reject_unknown_arguments(
        call,
        &["topic", "value", "ttl_secs", "freq_hz", "source"],
        max_response_bytes,
    )?;
    let topic = required_string(call, "topic", max_response_bytes)?;
    if !call
        .arguments
        .as_object()
        .is_some_and(|object| object.contains_key("value"))
    {
        return Err(invalid_registry_argument(
            call,
            "value",
            "value is required",
            max_response_bytes,
        ));
    }
    let value = call.arguments["value"].clone();
    let source =
        optional_string(call, "source", max_response_bytes)?.unwrap_or_else(|| "agent".to_owned());
    let mut request = RegistrySetRequest::new(topic, value, source);
    if let Some(ttl) = optional_ttl(call, max_response_bytes)? {
        request = request.with_ttl(ttl);
    }
    if let Some(freq_hz) = optional_f64(call, "freq_hz", max_response_bytes)? {
        request = request.with_freq_hz(freq_hz);
    }
    Ok(request)
}

fn parse_get_arguments(
    call: &ToolCall,
    max_response_bytes: usize,
) -> Result<RegistryQuery, ToolResult> {
    reject_unknown_arguments(call, &["topic", "limit"], max_response_bytes)?;
    let topic = required_string(call, "topic", max_response_bytes)?;
    let mut query = RegistryQuery::new(topic);
    if let Some(limit) = optional_usize(call, "limit", max_response_bytes)? {
        query = query.with_limit(limit);
    }
    Ok(query)
}

fn parse_delete_arguments(
    call: &ToolCall,
    max_response_bytes: usize,
) -> Result<String, ToolResult> {
    reject_unknown_arguments(call, &["topic"], max_response_bytes)?;
    required_string(call, "topic", max_response_bytes)
}

fn parse_history_arguments(
    call: &ToolCall,
    max_response_bytes: usize,
) -> Result<RegistryQuery, ToolResult> {
    reject_unknown_arguments(call, &["topic", "since_secs", "limit"], max_response_bytes)?;
    let topic = required_string(call, "topic", max_response_bytes)?;
    let since_secs = required_f64(call, "since_secs", max_response_bytes)?;
    let mut query = RegistryQuery::history(topic, since_secs);
    if let Some(limit) = optional_usize(call, "limit", max_response_bytes)? {
        query = query.with_limit(limit);
    }
    Ok(query)
}

fn reject_unknown_arguments(
    call: &ToolCall,
    allowed: &[&str],
    max_response_bytes: usize,
) -> Result<(), ToolResult> {
    let Some(object) = call.arguments.as_object() else {
        return Err(invalid_registry_argument(
            call,
            "arguments",
            "arguments must be an object",
            max_response_bytes,
        ));
    };
    let allowed = allowed.iter().copied().collect::<HashSet<_>>();
    if let Some(key) = object.keys().find(|key| !allowed.contains(key.as_str())) {
        let field = sanitized_registry_field(key);
        let message = if field == "unknown" {
            "unknown argument".to_owned()
        } else {
            format!("unknown argument: {field}")
        };
        return Err(invalid_registry_argument(
            call,
            &field,
            &message,
            max_response_bytes,
        ));
    }
    Ok(())
}

fn required_string(
    call: &ToolCall,
    field: &str,
    max_response_bytes: usize,
) -> Result<String, ToolResult> {
    call.arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            invalid_registry_argument(
                call,
                field,
                &format!("{field} is required"),
                max_response_bytes,
            )
        })
}

fn optional_string(
    call: &ToolCall,
    field: &str,
    max_response_bytes: usize,
) -> Result<Option<String>, ToolResult> {
    let Some(value) = call.arguments.get(field) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| {
            invalid_registry_argument(
                call,
                field,
                &format!("{field} must be a string"),
                max_response_bytes,
            )
        })
}

fn required_f64(
    call: &ToolCall,
    field: &str,
    max_response_bytes: usize,
) -> Result<f64, ToolResult> {
    call.arguments
        .get(field)
        .and_then(Value::as_f64)
        .ok_or_else(|| {
            invalid_registry_argument(
                call,
                field,
                &format!("{field} must be a number"),
                max_response_bytes,
            )
        })
}

fn optional_f64(
    call: &ToolCall,
    field: &str,
    max_response_bytes: usize,
) -> Result<Option<f64>, ToolResult> {
    let Some(value) = call.arguments.get(field) else {
        return Ok(None);
    };
    value.as_f64().map(Some).ok_or_else(|| {
        invalid_registry_argument(
            call,
            field,
            &format!("{field} must be a number"),
            max_response_bytes,
        )
    })
}

fn optional_usize(
    call: &ToolCall,
    field: &str,
    max_response_bytes: usize,
) -> Result<Option<usize>, ToolResult> {
    let Some(value) = call.arguments.get(field) else {
        return Ok(None);
    };
    let Some(raw) = value.as_u64() else {
        return Err(invalid_registry_argument(
            call,
            field,
            &format!("{field} must be an integer"),
            max_response_bytes,
        ));
    };
    usize::try_from(raw).map(Some).map_err(|_| {
        invalid_registry_argument(
            call,
            field,
            &format!("{field} is too large"),
            max_response_bytes,
        )
    })
}

fn optional_ttl(
    call: &ToolCall,
    max_response_bytes: usize,
) -> Result<Option<RegistryTtl>, ToolResult> {
    let Some(value) = call.arguments.get("ttl_secs") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(Some(RegistryTtl::Null));
    }
    value
        .as_f64()
        .map(|seconds| Some(RegistryTtl::Seconds(seconds)))
        .ok_or_else(|| {
            invalid_registry_argument(
                call,
                "ttl_secs",
                "ttl_secs must be a number",
                max_response_bytes,
            )
        })
}

fn invalid_registry_argument(
    call: &ToolCall,
    field: &str,
    message: &str,
    max_response_bytes: usize,
) -> ToolResult {
    registry_tool_error(
        call.id.clone(),
        call.name.clone(),
        message,
        json!({
            "kind": "invalid_registry_arguments",
            "field": sanitized_registry_field(field)
        }),
        max_response_bytes,
    )
}

fn registry_store_error(
    call: ToolCall,
    error: RegistryError,
    max_response_bytes: usize,
) -> ToolResult {
    registry_tool_error(
        call.id,
        call.name,
        error.to_string(),
        json!({
            "kind": "registry_error",
            "code": error.code(),
            "retryable": false
        }),
        max_response_bytes,
    )
}

fn registry_tool_error(
    tool_call_id: String,
    tool_name: String,
    message: impl Into<String>,
    details: Value,
    max_response_bytes: usize,
) -> ToolResult {
    let text = bounded_utf8_bytes(
        &bounded_chars(
            &message.into(),
            REGISTRY_TOOL_ERROR_MESSAGE_CHARS.min(max_response_bytes),
        ),
        max_response_bytes,
    );
    let details = bounded_error_details(details, max_response_bytes);
    ToolResult::error(tool_call_id, tool_name, text, details)
}

fn bounded_error_details(details: Value, max_response_bytes: usize) -> Value {
    if details.to_string().len() <= max_response_bytes {
        return details;
    }

    let kind = details
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("registry_error")
        .to_owned();
    let field = details
        .get("field")
        .and_then(Value::as_str)
        .map(sanitized_registry_field);
    let code = details.get("code").cloned();

    let mut compact = json!({
        "kind": kind,
        "truncated": true,
        "truncated_reason": "response_bytes"
    });
    if let Some(field) = field {
        compact["field"] = json!(field);
    }
    if let Some(code) = code {
        compact["code"] = code;
    }
    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    if let Some(object) = compact.as_object_mut() {
        object.remove("field");
        object.remove("code");
    }
    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    json!({
        "kind": "registry_error",
        "truncated": true
    })
}

fn sanitized_registry_field(field: &str) -> String {
    if !field.is_empty()
        && field.len() <= REGISTRY_TOOL_FIELD_CHARS
        && field
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        field.to_owned()
    } else {
        "unknown".to_owned()
    }
}

fn bounded_utf8_bytes(value: &str, max_bytes: usize) -> String {
    let mut output = String::new();
    for ch in value.chars() {
        if output.len().saturating_add(ch.len_utf8()) > max_bytes {
            break;
        }
        output.push(ch);
    }
    output
}

fn registry_set_success(
    call: ToolCall,
    ack: RegistrySetAck,
    max_response_bytes: usize,
) -> ToolResult {
    let details = json!({
        "kind": "registry_set",
        "topic": ack.topic,
        "source": ack.source,
        "writer_kind": ack.writer_kind.as_str(),
        "origin": ack.origin,
        "seq": ack.seq,
        "freq_hz": ack.freq_hz,
        "updated_at": crate::formatting::system_time_rfc3339(ack.updated_at),
        "expires_at": ack.expires_at.map(crate::formatting::system_time_rfc3339),
        "ttl_secs": ack.ttl.map(duration_secs),
    });
    bounded_success(call, details, max_response_bytes, TruncateSide::Back)
}

fn registry_delete_success(
    call: ToolCall,
    ack: RegistryDeleteAck,
    max_response_bytes: usize,
) -> ToolResult {
    let details = json!({
        "kind": "registry_delete",
        "topic": ack.topic,
        "deleted": ack.deleted,
        "seq": ack.seq,
        "server_time": crate::formatting::system_time_rfc3339(ack.server_time),
    });
    bounded_success(call, details, max_response_bytes, TruncateSide::Back)
}

fn registry_get_success(
    call: ToolCall,
    result: RegistryQueryResult<RegistryItem>,
    max_response_bytes: usize,
) -> ToolResult {
    let server_time = result.server_time;
    let items = result
        .items
        .iter()
        .map(|item| current_item_json(item, server_time))
        .collect::<Vec<_>>();
    let details = json!({
        "kind": "registry_get",
        "server_time": crate::formatting::system_time_rfc3339(server_time),
        "items": items,
        "matched_count": result.matched_count,
        "returned_count": result.returned_count,
        "truncated": result.truncated,
        "truncated_reason": result.truncated_reason,
    });
    bounded_success(call, details, max_response_bytes, TruncateSide::Back)
}

fn registry_history_success(
    call: ToolCall,
    result: RegistryHistoryResult,
    max_response_bytes: usize,
) -> ToolResult {
    let server_time = result.server_time;
    let items = result
        .items
        .iter()
        .map(history_item_json)
        .collect::<Vec<_>>();
    let details = json!({
        "kind": "registry_history",
        "server_time": crate::formatting::system_time_rfc3339(server_time),
        "items": items,
        "oldest_seq": result.oldest_seq,
        "newest_seq": result.newest_seq,
        "matched_count": result.matched_count,
        "returned_count": result.returned_count,
        "truncated": result.truncated,
        "truncated_reason": result.truncated_reason,
    });
    bounded_success(call, details, max_response_bytes, TruncateSide::Front)
}

fn current_item_json(item: &RegistryItem, server_time: SystemTime) -> Value {
    let age_secs = duration_between(server_time, item.updated_at);
    let expires_in_secs = item
        .expires_at
        .map(|expires_at| duration_between(expires_at, server_time));
    let mut value = history_item_json(item);
    if let Value::Object(object) = &mut value {
        object.insert("age_secs".to_owned(), json!(age_secs));
        object.insert("expires_in_secs".to_owned(), json!(expires_in_secs));
    }
    value
}

fn history_item_json(item: &RegistryItem) -> Value {
    json!({
        "topic": &item.topic,
        "value": &item.value,
        "source": &item.source,
        "writer_kind": item.writer_kind.as_str(),
        "origin": &item.origin,
        "seq": item.seq,
        "freq_hz": item.freq_hz,
        "updated_at": crate::formatting::system_time_rfc3339(item.updated_at),
        "expires_at": item.expires_at.map(crate::formatting::system_time_rfc3339),
        "ttl_secs": item.ttl.map(duration_secs),
    })
}

#[derive(Debug, Clone, Copy)]
enum TruncateSide {
    Front,
    Back,
}

fn bounded_success(
    call: ToolCall,
    mut details: Value,
    max_response_bytes: usize,
    side: TruncateSide,
) -> ToolResult {
    let kind = details["kind"]
        .as_str()
        .unwrap_or("registry_result")
        .to_owned();
    details = enforce_response_budget(details, &kind, max_response_bytes, side);
    let text = details.to_string();
    ToolResult::success(call.id, call.name, text).with_details(details)
}

fn enforce_response_budget(
    mut details: Value,
    kind: &str,
    max_response_bytes: usize,
    side: TruncateSide,
) -> Value {
    while details.to_string().len() > max_response_bytes {
        let Some(items) = details.get_mut("items").and_then(Value::as_array_mut) else {
            break;
        };
        if items.is_empty() {
            break;
        }
        match side {
            TruncateSide::Front => {
                items.remove(0);
            }
            TruncateSide::Back => {
                items.pop();
            }
        }
        let returned_count = items.len();
        if let Value::Object(object) = &mut details {
            object.insert("returned_count".to_owned(), json!(returned_count));
            object.insert("truncated".to_owned(), json!(true));
            object.insert("truncated_reason".to_owned(), json!("response_bytes"));
            if returned_count == 0 {
                object.insert("oldest_seq".to_owned(), Value::Null);
                object.insert("newest_seq".to_owned(), Value::Null);
            }
        }
    }

    if details.to_string().len() <= max_response_bytes {
        return details;
    }

    compact_success_details(details, kind, max_response_bytes)
}

fn compact_success_details(details: Value, kind: &str, max_response_bytes: usize) -> Value {
    let mut compact = if details.get("items").is_some() {
        let mut compact = json!({
            "kind": kind,
            "items": [],
            "matched_count": details["matched_count"].as_u64().unwrap_or(0),
            "returned_count": 0,
            "truncated": true,
            "truncated_reason": "response_bytes"
        });
        if details.get("oldest_seq").is_some() {
            compact["oldest_seq"] = Value::Null;
        }
        if details.get("newest_seq").is_some() {
            compact["newest_seq"] = Value::Null;
        }
        compact
    } else {
        let mut compact = json!({
            "kind": kind,
            "truncated": true,
            "truncated_reason": "response_bytes"
        });
        if let Some(seq) = details.get("seq") {
            compact["seq"] = seq.clone();
        }
        if let Some(writer_kind) = details.get("writer_kind") {
            compact["writer_kind"] = writer_kind.clone();
        }
        compact
    };

    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    if let Some(object) = compact.as_object_mut() {
        object.remove("writer_kind");
        object.remove("seq");
        object.remove("matched_count");
        object.remove("truncated_reason");
    }
    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    json!({
        "kind": kind,
        "truncated": true
    })
}

fn duration_secs(duration: Duration) -> f64 {
    duration.as_secs_f64()
}

fn duration_between(later: SystemTime, earlier: SystemTime) -> f64 {
    later
        .duration_since(earlier)
        .unwrap_or_default()
        .as_secs_f64()
}
