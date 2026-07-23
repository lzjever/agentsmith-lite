use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

use crate::formatting::bounded_chars;
use crate::registry::{RegistryItem, RegistryQueryResult};

pub const DEFAULT_STDIO_REGISTRY_RESPONSE_BYTES: usize = 4 * 1024;
pub const MIN_STDIO_REGISTRY_RESPONSE_BYTES: usize = 160;

const BOTIFIED_FRAME_OVERHEAD_BYTES: usize = "<botified></botified>\n".len();
const REGISTRY_ERROR_MESSAGE_CHARS: usize = 256;

pub fn stdio_registry_response_cap(max_response_bytes: usize) -> usize {
    max_response_bytes.clamp(
        MIN_STDIO_REGISTRY_RESPONSE_BYTES,
        DEFAULT_STDIO_REGISTRY_RESPONSE_BYTES,
    )
}

pub fn registry_snapshot_stdio_frame(
    id: &str,
    result: RegistryQueryResult<RegistryItem>,
    max_frame_bytes: usize,
) -> String {
    let max_frame_bytes = stdio_registry_response_cap(max_frame_bytes);
    wrap_botified_frame(registry_snapshot_stdio_body(
        id,
        result,
        body_cap(max_frame_bytes),
    ))
}

pub fn registry_error_stdio_frame(
    id: &str,
    code: &str,
    message: &str,
    max_frame_bytes: usize,
) -> String {
    let max_frame_bytes = stdio_registry_response_cap(max_frame_bytes);
    let body = json!({
        "op": "registry_error",
        "id": id,
        "code": code,
        "message": bounded_chars(message, REGISTRY_ERROR_MESSAGE_CHARS),
    });
    wrap_botified_frame(bounded_registry_response(
        body,
        body_cap(max_frame_bytes),
        RegistryResponseTruncateSide,
    ))
}

fn registry_snapshot_stdio_body(
    id: &str,
    result: RegistryQueryResult<RegistryItem>,
    max_response_bytes: usize,
) -> Value {
    let server_time = result.server_time;
    let items = result
        .items
        .iter()
        .map(|item| current_registry_item_json(item, server_time))
        .collect::<Vec<_>>();
    let body = json!({
        "op": "registry_snapshot",
        "id": id,
        "server_time": crate::formatting::system_time_rfc3339(server_time),
        "items": items,
        "matched_count": result.matched_count,
        "returned_count": result.returned_count,
        "truncated": result.truncated,
        "truncated_reason": result.truncated_reason,
    });
    bounded_registry_response(body, max_response_bytes, RegistryResponseTruncateSide)
}

fn wrap_botified_frame(body: Value) -> String {
    format!("<botified>{}</botified>\n", body)
}

fn body_cap(max_frame_bytes: usize) -> usize {
    max_frame_bytes.saturating_sub(BOTIFIED_FRAME_OVERHEAD_BYTES)
}

#[derive(Debug, Clone, Copy)]
struct RegistryResponseTruncateSide;

fn bounded_registry_response(
    mut body: Value,
    max_response_bytes: usize,
    _side: RegistryResponseTruncateSide,
) -> Value {
    while body.to_string().len() > max_response_bytes {
        let Some(items) = body.get_mut("items").and_then(Value::as_array_mut) else {
            break;
        };
        if items.is_empty() {
            break;
        }
        items.pop();
        mark_registry_response_truncated(&mut body);
    }

    if body.to_string().len() <= max_response_bytes {
        return body;
    }

    compact_registry_response(body, max_response_bytes)
}

fn mark_registry_response_truncated(body: &mut Value) {
    let returned_count = body
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if let Value::Object(object) = body {
        object.insert("returned_count".to_owned(), json!(returned_count));
        object.insert("truncated".to_owned(), json!(true));
        object.insert("truncated_reason".to_owned(), json!("response_bytes"));
    }
}

fn compact_registry_response(body: Value, max_response_bytes: usize) -> Value {
    let compact = if body.get("op").and_then(Value::as_str) == Some("registry_error") {
        json!({
            "op": "registry_error",
            "id": body.get("id").cloned().unwrap_or(Value::Null),
            "code": body.get("code").cloned().unwrap_or_else(|| json!("registry_error")),
            "message": body.get("message").cloned().unwrap_or_else(|| json!("registry error")),
            "truncated": true,
            "truncated_reason": "response_bytes"
        })
    } else {
        json!({
            "op": body.get("op").cloned().unwrap_or_else(|| json!("registry_snapshot")),
            "id": body.get("id").cloned().unwrap_or(Value::Null),
            "items": [],
            "matched_count": body.get("matched_count").cloned().unwrap_or_else(|| json!(0)),
            "returned_count": 0,
            "truncated": true,
            "truncated_reason": "response_bytes"
        })
    };
    fit_compact_registry_response(compact, max_response_bytes)
}

fn fit_compact_registry_response(mut compact: Value, max_response_bytes: usize) -> Value {
    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    if compact
        .as_object()
        .is_some_and(|object| object.contains_key("message"))
    {
        if let Some(object) = compact.as_object_mut() {
            object.remove("message");
        }
        if compact.to_string().len() <= max_response_bytes {
            return compact;
        }
    }

    if compact.get("op").and_then(Value::as_str) == Some("registry_snapshot") {
        return fit_compact_registry_snapshot_response(compact, max_response_bytes);
    }

    if let Some(object) = compact.as_object_mut() {
        object.insert("id".to_owned(), Value::Null);
        object.remove("items");
        object.remove("matched_count");
        object.remove("returned_count");
    }
    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    json!({
        "op": compact.get("op").cloned().unwrap_or(Value::Null),
        "truncated": true,
        "truncated_reason": "response_bytes"
    })
}

fn fit_compact_registry_snapshot_response(mut compact: Value, max_response_bytes: usize) -> Value {
    if let Some(object) = compact.as_object_mut() {
        object.insert("id".to_owned(), Value::Null);
        object.insert("items".to_owned(), json!([]));
    }
    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    if let Some(object) = compact.as_object_mut() {
        object.remove("matched_count");
        object.remove("returned_count");
    }
    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    json!({
        "op": "registry_snapshot",
        "items": [],
        "truncated": true,
        "truncated_reason": "response_bytes"
    })
}

fn current_registry_item_json(item: &RegistryItem, server_time: SystemTime) -> Value {
    let mut value = registry_item_json(item);
    if let Value::Object(object) = &mut value {
        object.insert(
            "age_secs".to_owned(),
            json!(duration_between(server_time, item.updated_at)),
        );
        object.insert(
            "expires_in_secs".to_owned(),
            json!(item
                .expires_at
                .map(|expires_at| duration_between(expires_at, server_time))),
        );
    }
    value
}

fn registry_item_json(item: &RegistryItem) -> Value {
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

fn duration_secs(duration: Duration) -> f64 {
    duration.as_secs_f64()
}

fn duration_between(later: SystemTime, earlier: SystemTime) -> f64 {
    later
        .duration_since(earlier)
        .unwrap_or_default()
        .as_secs_f64()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::RegistryWriterKind;
    use std::time::UNIX_EPOCH;

    fn botified_body(frame: &str) -> Value {
        let body = frame
            .strip_prefix("<botified>")
            .and_then(|text| text.strip_suffix("</botified>\n"))
            .expect("frame should be wrapped");
        serde_json::from_str(body).expect("frame body should be JSON")
    }

    fn oversized_result() -> RegistryQueryResult<RegistryItem> {
        let now = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        RegistryQueryResult {
            server_time: now,
            items: vec![RegistryItem {
                topic: "robot.pose".to_owned(),
                value: json!({"payload": "x".repeat(4096)}),
                source: "localization".to_owned(),
                writer_kind: RegistryWriterKind::ManagedTask,
                origin: "task:large".to_owned(),
                seq: 7,
                freq_hz: Some(30.0),
                updated_at: now,
                expires_at: Some(now + Duration::from_secs(5)),
                ttl: Some(Duration::from_secs(5)),
            }],
            matched_count: 1,
            returned_count: 1,
            truncated: false,
            truncated_reason: None,
        }
    }

    fn small_result() -> RegistryQueryResult<RegistryItem> {
        let now = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        RegistryQueryResult {
            server_time: now,
            items: vec![RegistryItem {
                topic: "robot.pose".to_owned(),
                value: json!({"x": 1}),
                source: "localization".to_owned(),
                writer_kind: RegistryWriterKind::ManagedTask,
                origin: "task:reader".to_owned(),
                seq: 8,
                freq_hz: Some(10.0),
                updated_at: now,
                expires_at: Some(now + Duration::from_secs(5)),
                ttl: Some(Duration::from_secs(5)),
            }],
            matched_count: 1,
            returned_count: 1,
            truncated: false,
            truncated_reason: None,
        }
    }

    #[test]
    fn stdio_registry_response_default_cap_is_control_frame_sized() {
        assert_eq!(DEFAULT_STDIO_REGISTRY_RESPONSE_BYTES, 4 * 1024);
        assert_eq!(
            stdio_registry_response_cap(usize::MAX),
            DEFAULT_STDIO_REGISTRY_RESPONSE_BYTES
        );
    }

    #[test]
    fn stdio_registry_snapshot_uses_items_field_without_entries_alias() {
        let frame = registry_snapshot_stdio_frame(
            "read-items",
            small_result(),
            DEFAULT_STDIO_REGISTRY_RESPONSE_BYTES,
        );

        let body = botified_body(&frame);
        assert_eq!(body["op"], json!("registry_snapshot"));
        assert_eq!(body["items"][0]["topic"], json!("robot.pose"));
        assert!(
            body.get("entries").is_none(),
            "entries is not a wire field: {body}"
        );
    }

    #[test]
    fn stdio_registry_snapshot_keeps_truncation_metadata_at_tiny_config_cap() {
        let cap = stdio_registry_response_cap(32);
        let frame = registry_snapshot_stdio_frame("read-small", oversized_result(), cap);

        assert!(
            frame.len() <= cap,
            "snapshot frame should fit effective stdio cap: {} > {}\n{frame}",
            frame.len(),
            cap
        );
        let body = botified_body(&frame);
        assert_eq!(body["op"], json!("registry_snapshot"));
        assert_eq!(body["truncated"], json!(true));
        assert_eq!(body["truncated_reason"], json!("response_bytes"));
        assert!(
            !frame.contains(&"x".repeat(128)),
            "snapshot frame should not leak oversized item values: {frame}"
        );
    }

    #[test]
    fn stdio_registry_snapshot_retains_items_array_after_compact_fallback() {
        let cap = stdio_registry_response_cap(16);
        let frame =
            registry_snapshot_stdio_frame(&"read-items".repeat(64), oversized_result(), cap);

        assert!(
            frame.len() <= cap,
            "snapshot frame should fit effective stdio cap: {} > {}\n{frame}",
            frame.len(),
            cap
        );
        let body = botified_body(&frame);
        assert_eq!(body["op"], json!("registry_snapshot"));
        assert_eq!(body["items"], json!([]));
        assert!(
            body.get("entries").is_none(),
            "entries is not a wire field: {body}"
        );
        assert_eq!(body["truncated"], json!(true));
        assert_eq!(body["truncated_reason"], json!("response_bytes"));
    }

    #[test]
    fn stdio_registry_error_is_bounded_at_tiny_config_cap_without_query_detail() {
        let cap = stdio_registry_response_cap(16);
        let frame = registry_error_stdio_frame(
            &"read-secret-detail".repeat(64),
            "invalid_pattern",
            &format!("invalid pattern secret_query_detail {}", "x".repeat(4096)),
            cap,
        );

        assert!(
            frame.len() <= cap,
            "error frame should fit effective stdio cap: {} > {}\n{frame}",
            frame.len(),
            cap
        );
        let body = botified_body(&frame);
        assert_eq!(body["op"], json!("registry_error"));
        assert_eq!(body["truncated"], json!(true));
        assert_eq!(body["truncated_reason"], json!("response_bytes"));
        assert!(
            !frame.contains("secret_query_detail"),
            "registry_error must not echo query detail: {frame}"
        );
    }
}
