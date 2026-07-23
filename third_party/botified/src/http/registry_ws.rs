use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::extract::ws::{
    close_code, CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade,
};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::formatting::bounded_chars;
use crate::registry::{
    RegistryChange, RegistryDeleteAck, RegistryError, RegistryItem, RegistryQuery, RegistrySetAck,
    RegistrySetRequest, RegistryStore, RegistrySubscriptionFilter, RegistrySubscriptionFilterError,
    RegistrySubscriptionSnapshot, RegistryTtl, RegistryWriterKind,
};

use super::{
    authorize, bounded_registry_response, duration_secs, registry_get_response,
    registry_history_response, registry_item_json, registry_store_from_state, ApiError, HttpState,
    RegistryResponseTruncateSide,
};

const REGISTRY_WS_ERROR_MESSAGE_CHARS: usize = 256;
static NEXT_REGISTRY_WS_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

pub(super) async fn registry_ws_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = registry_store_from_state(&state)?;
    let permit = state
        .registry_ws_connection_slots
        .as_ref()
        .expect("registry websocket slots should exist when registry is enabled")
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::registry_ws_connection_limit())?;
    let registry_blocking_slots = state
        .registry_blocking_slots
        .as_ref()
        .expect("registry blocking slots should exist when registry is enabled")
        .clone();
    let origin = next_registry_ws_origin();
    let websocket_max_frame_bytes = store.options().websocket_max_frame_bytes;
    Ok(ws
        .max_message_size(websocket_max_frame_bytes)
        .max_frame_size(websocket_max_frame_bytes)
        .on_upgrade(move |socket| {
            registry_ws_loop(socket, store, origin, permit, registry_blocking_slots)
        }))
}

fn next_registry_ws_origin() -> String {
    let id = NEXT_REGISTRY_WS_CONNECTION_ID.fetch_add(1, Ordering::SeqCst);
    format!("ws:conn_{id}")
}

async fn registry_ws_loop(
    mut socket: WebSocket,
    store: RegistryStore,
    origin: String,
    _permit: OwnedSemaphorePermit,
    registry_blocking_slots: Arc<Semaphore>,
) {
    let websocket_max_frame_bytes = store.options().websocket_max_frame_bytes;
    while let Some(frame) = socket.recv().await {
        match &frame {
            Ok(WsMessage::Ping(payload)) => {
                if socket.send(WsMessage::Pong(payload.clone())).await.is_err() {
                    return;
                }
                continue;
            }
            Ok(WsMessage::Pong(_)) => continue,
            Ok(WsMessage::Close(_)) => return,
            Err(error) => {
                let message = error.to_string();
                let code = if message.contains("too long")
                    || message.contains("TooLong")
                    || message.contains("capacity")
                {
                    close_code::SIZE
                } else {
                    close_code::PROTOCOL
                };
                let _ = socket
                    .send(WsMessage::Close(Some(CloseFrame {
                        code,
                        reason: "websocket transport error".into(),
                    })))
                    .await;
                return;
            }
            _ => {}
        }
        let request_id = if let Ok(WsMessage::Text(text)) = &frame {
            match registry_ws_subscribe_request(&store, text) {
                RegistryWsSubscribeRequest::NotSubscribe { id } => id,
                RegistryWsSubscribeRequest::Reject {
                    response,
                    close_code,
                } => {
                    let _ = socket.send(WsMessage::Text(response.to_string())).await;
                    let _ = socket
                        .send(WsMessage::Close(Some(CloseFrame {
                            code: close_code,
                            reason: "subscription rejected".into(),
                        })))
                        .await;
                    return;
                }
                RegistryWsSubscribeRequest::Ready { id, filter } => {
                    let worker_permit = match registry_blocking_slots.clone().try_acquire_owned() {
                        Ok(permit) => permit,
                        Err(_) => {
                            send_registry_ws_worker_error_and_close(
                                &mut socket,
                                id,
                                RegistryWsWorkerFailure::Limit,
                                registry_ws_outbound_limit(&store),
                            )
                            .await;
                            return;
                        }
                    };
                    let subscription_store = store.clone();
                    match run_registry_ws_task(worker_permit, move || {
                        subscription_store.begin_subscription(filter)
                    })
                    .await
                    {
                        Ok(Ok(snapshot)) => {
                            run_registry_subscription(socket, store, id, snapshot).await;
                        }
                        Ok(Err(error)) => {
                            let close_code = registry_ws_store_error_close_code(&error);
                            let response = bounded_registry_response(
                                registry_ws_store_error(Some(id), error),
                                registry_ws_outbound_limit(&store),
                                RegistryResponseTruncateSide::Back,
                            );
                            let _ = socket.send(WsMessage::Text(response.to_string())).await;
                            let _ = socket
                                .send(WsMessage::Close(Some(CloseFrame {
                                    code: close_code,
                                    reason: "subscription rejected".into(),
                                })))
                                .await;
                        }
                        Err(_) => {
                            send_registry_ws_worker_error_and_close(
                                &mut socket,
                                id,
                                RegistryWsWorkerFailure::Internal,
                                registry_ws_outbound_limit(&store),
                            )
                            .await;
                        }
                    }
                    return;
                }
            }
        } else {
            Value::Null
        };
        let response = match registry_ws_frame_response(
            store.clone(),
            origin.clone(),
            websocket_max_frame_bytes,
            frame,
            Arc::clone(&registry_blocking_slots),
            request_id,
        )
        .await
        {
            Ok(Some(response)) => response,
            Ok(None) => return,
            Err(failure) => {
                send_registry_ws_worker_error_and_close(
                    &mut socket,
                    failure.id,
                    failure.kind,
                    registry_ws_outbound_limit(&store),
                )
                .await;
                return;
            }
        };
        if socket
            .send(WsMessage::Text(response.to_string()))
            .await
            .is_err()
        {
            return;
        }
    }
}

fn registry_ws_store_error_close_code(error: &RegistryError) -> u16 {
    match error {
        RegistryError::InvalidTopic | RegistryError::InvalidPattern => close_code::PROTOCOL,
        RegistryError::TooManySubscriptions | RegistryError::TooManyTopics => close_code::POLICY,
        RegistryError::SeqExhausted
        | RegistryError::DeadlineOverflow
        | RegistryError::InvalidConfig(_) => close_code::ERROR,
        _ => close_code::PROTOCOL,
    }
}

enum RegistryWsSubscribeRequest {
    NotSubscribe {
        id: Value,
    },
    Reject {
        response: Value,
        close_code: u16,
    },
    Ready {
        id: Value,
        filter: RegistrySubscriptionFilter,
    },
}

fn registry_ws_subscribe_request(store: &RegistryStore, text: &str) -> RegistryWsSubscribeRequest {
    let Ok(body) = serde_json::from_str::<Value>(text) else {
        return RegistryWsSubscribeRequest::NotSubscribe { id: Value::Null };
    };
    let response_id = registry_response_id(&body);
    let Some(object) = body.as_object() else {
        return RegistryWsSubscribeRequest::NotSubscribe { id: response_id };
    };
    if object.get("op").and_then(Value::as_str) != Some("subscribe") {
        return RegistryWsSubscribeRequest::NotSubscribe { id: response_id };
    }
    let id = match scalar_request_id(object) {
        Some(id) => id,
        None => {
            return registry_ws_subscribe_protocol_rejection(
                store,
                registry_ws_error(None, "invalid_request", "id must be a JSON scalar"),
            );
        }
    };
    if let Err(response) = reject_unknown_ws_fields(object, &["op", "id", "topics"], &id) {
        return registry_ws_subscribe_protocol_rejection(store, response);
    }
    let topics = match object.get("topics") {
        Some(Value::Array(topics)) if topics.iter().all(Value::is_string) => topics
            .iter()
            .map(|topic| topic.as_str().unwrap().to_owned())
            .collect(),
        _ => {
            return registry_ws_subscribe_protocol_rejection(
                store,
                registry_ws_error(
                    Some(id),
                    "invalid_request",
                    "topics must be a non-empty array of strings",
                ),
            );
        }
    };
    let filter = match store.subscription_filter(topics) {
        Ok(filter) => filter,
        Err(RegistrySubscriptionFilterError::InvalidPattern) => {
            return registry_ws_subscribe_protocol_rejection(
                store,
                registry_ws_store_error(Some(id), RegistryError::InvalidPattern),
            );
        }
        Err(RegistrySubscriptionFilterError::Empty) => {
            return registry_ws_subscribe_protocol_rejection(
                store,
                registry_ws_error(
                    Some(id),
                    "invalid_request",
                    "topics must be a non-empty array of strings",
                ),
            );
        }
        Err(RegistrySubscriptionFilterError::TooMany) => {
            return registry_ws_subscribe_protocol_rejection(
                store,
                registry_ws_error(
                    Some(id),
                    "invalid_request",
                    "topics must contain at most 64 unique items",
                ),
            );
        }
    };
    if !registry_ws_id_fits_subscribe(store, &id, filter.canonical_topics()) {
        return registry_ws_subscribe_protocol_rejection(
            store,
            registry_ws_error(
                None,
                "invalid_request",
                "id exceeds websocket response limit",
            ),
        );
    }
    RegistryWsSubscribeRequest::Ready { id, filter }
}

fn registry_ws_subscribe_protocol_rejection(
    store: &RegistryStore,
    response: Value,
) -> RegistryWsSubscribeRequest {
    RegistryWsSubscribeRequest::Reject {
        response: bounded_registry_response(
            response,
            registry_ws_outbound_limit(store),
            RegistryResponseTruncateSide::Back,
        ),
        close_code: close_code::PROTOCOL,
    }
}

fn scalar_request_id(object: &serde_json::Map<String, Value>) -> Option<Value> {
    match object.get("id") {
        None => Some(Value::Null),
        Some(value @ (Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null)) => {
            Some(value.clone())
        }
        Some(_) => None,
    }
}

fn registry_ws_outbound_limit(store: &RegistryStore) -> usize {
    store
        .config()
        .max_response_bytes
        .min(store.options().websocket_max_frame_bytes)
}

fn registry_subscription_begin(
    store: &RegistryStore,
    id: &Value,
    topics: &[String],
    watermark: u64,
    server_time: &str,
) -> Value {
    json!({
        "ok": true,
        "op": "snapshot_begin",
        "kind": "registry_subscribe",
        "id": id,
        "instance_id": store.instance_id(),
        "topics": topics,
        "watermark": watermark,
        "server_time": server_time,
    })
}

fn registry_ws_id_fits_subscribe(store: &RegistryStore, id: &Value, topics: &[String]) -> bool {
    registry_subscription_begin(store, id, topics, u64::MAX, "9999-12-31T23:59:59.999Z")
        .to_string()
        .len()
        <= registry_ws_outbound_limit(store)
}

fn registry_ws_delete_ack_fits(store: &RegistryStore, id: &Value, topic: &str) -> bool {
    json!({
        "ok": true,
        "op": "ack",
        "kind": "registry_delete",
        "id": id,
        "topic": topic,
        "deleted": true,
        "seq": u64::MAX,
        "server_time": "9999-12-31T23:59:59.999Z"
    })
    .to_string()
    .len()
        <= registry_ws_outbound_limit(store)
}

fn registry_ws_delete_id_fits(store: &RegistryStore, id: &Value) -> bool {
    registry_ws_delete_ack_fits(store, id, "a")
}

async fn registry_ws_frame_response(
    store: RegistryStore,
    origin: String,
    websocket_max_frame_bytes: usize,
    frame: Result<WsMessage, axum::Error>,
    registry_blocking_slots: Arc<Semaphore>,
    request_id: Value,
) -> Result<Option<Value>, RegistryWsFrameFailure> {
    let max_response_bytes = registry_ws_outbound_limit(&store);
    let frame = match frame {
        Ok(frame) => frame,
        Err(_) => return Ok(None),
    };
    match frame {
        WsMessage::Text(text) => {
            let permit = registry_blocking_slots.try_acquire_owned().map_err(|_| {
                RegistryWsFrameFailure {
                    id: request_id.clone(),
                    kind: RegistryWsWorkerFailure::Limit,
                }
            })?;
            run_registry_ws_task(permit, move || {
                registry_ws_text_response(&store, &origin, websocket_max_frame_bytes, &text)
            })
            .await
            .map_err(|kind| RegistryWsFrameFailure {
                id: request_id,
                kind,
            })
            .map(Some)
        }
        WsMessage::Binary(_) => Ok(Some(bounded_registry_response(
            registry_ws_error(
                None,
                "unsupported_frame",
                "registry websocket only accepts text JSON frames",
            ),
            max_response_bytes,
            RegistryResponseTruncateSide::Back,
        ))),
        WsMessage::Ping(_) | WsMessage::Pong(_) => Ok(None),
        WsMessage::Close(_) => Ok(None),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RegistryWsFrameFailure {
    id: Value,
    kind: RegistryWsWorkerFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegistryWsWorkerFailure {
    Limit,
    Internal,
}

async fn run_registry_ws_task<T: Send + 'static>(
    permit: OwnedSemaphorePermit,
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, RegistryWsWorkerFailure> {
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        task()
    })
    .await
    .map_err(|_| RegistryWsWorkerFailure::Internal)
}

fn registry_ws_worker_error(
    id: Value,
    failure: RegistryWsWorkerFailure,
    max_response_bytes: usize,
) -> Value {
    let (code, message) = match failure {
        RegistryWsWorkerFailure::Limit => {
            ("registry_worker_limit", "registry worker limit reached")
        }
        RegistryWsWorkerFailure::Internal => ("internal_error", "registry websocket worker failed"),
    };
    let mut error = registry_ws_error(Some(id), code, message);
    error["error"]["retryable"] = Value::Bool(true);
    bounded_registry_response(
        error,
        max_response_bytes,
        RegistryResponseTruncateSide::Back,
    )
}

async fn send_registry_ws_worker_error_and_close<S>(
    sink: &mut S,
    id: Value,
    failure: RegistryWsWorkerFailure,
    max_response_bytes: usize,
) where
    S: Sink<WsMessage> + Unpin,
{
    let close = match failure {
        RegistryWsWorkerFailure::Limit => close_code::AGAIN,
        RegistryWsWorkerFailure::Internal => close_code::ERROR,
    };
    let _ = sink
        .send(WsMessage::Text(
            registry_ws_worker_error(id, failure, max_response_bytes).to_string(),
        ))
        .await;
    let _ = sink
        .send(WsMessage::Close(Some(CloseFrame {
            code: close,
            reason: "registry worker error".into(),
        })))
        .await;
}

fn registry_ws_text_response(
    store: &RegistryStore,
    origin: &str,
    websocket_max_frame_bytes: usize,
    text: &str,
) -> Value {
    let response = registry_ws_text_response_inner(store, origin, websocket_max_frame_bytes, text);
    if matches!(
        response.get("kind").and_then(Value::as_str),
        Some("registry_delete" | "registry_set")
    ) && response.get("ok").and_then(Value::as_bool) == Some(true)
    {
        debug_assert!(response.to_string().len() <= registry_ws_outbound_limit(store));
        return response;
    }
    bounded_registry_response(
        response,
        registry_ws_outbound_limit(store),
        RegistryResponseTruncateSide::Back,
    )
}

fn registry_ws_text_response_inner(
    store: &RegistryStore,
    origin: &str,
    websocket_max_frame_bytes: usize,
    text: &str,
) -> Value {
    if text.len() > websocket_max_frame_bytes {
        return registry_ws_error(
            None,
            "frame_too_large",
            "registry websocket text frame too large",
        );
    }

    let body: Value = match serde_json::from_str(text) {
        Ok(body) => body,
        Err(_) => {
            return registry_ws_error(None, "malformed_json", "request frame must be JSON");
        }
    };
    let id = registry_response_id(&body);
    let Some(object) = body.as_object() else {
        return registry_ws_error(
            Some(id),
            "invalid_request",
            "request frame must be a JSON object",
        );
    };
    let Some(op) = object.get("op").and_then(Value::as_str) else {
        return registry_ws_error(Some(id), "invalid_request", "op is required");
    };

    match op {
        "set" => registry_ws_set(store, origin, object),
        "get" => registry_ws_get(store, id, object),
        "history" => registry_ws_history(store, id, object),
        "delete" => registry_ws_delete(store, origin, id, object),
        "subscribe" => registry_ws_error(Some(id), "invalid_request", "invalid subscribe request"),
        _ => registry_ws_error(
            Some(id),
            "invalid_request",
            "unsupported registry websocket op",
        ),
    }
}

fn registry_ws_delete(
    store: &RegistryStore,
    origin: &str,
    id: Value,
    object: &serde_json::Map<String, Value>,
) -> Value {
    if let Err(response) = reject_unknown_ws_fields(object, &["op", "id", "topic"], &id) {
        return response;
    }
    let Some(id) = scalar_request_id(object) else {
        return registry_ws_error(None, "invalid_request", "id must be a JSON scalar");
    };
    let topic = match required_ws_string(object, "topic", "missing_topic") {
        Ok(topic) => topic,
        Err(response) => return with_registry_response_id(response, &id),
    };
    if topic.contains('*') {
        return registry_ws_error(
            Some(id),
            "invalid_request",
            "delete requires an exact topic",
        );
    }
    if let Err(error) = store.validate_delete_topic(&topic) {
        return registry_ws_store_error(Some(id), error);
    }
    if !registry_ws_delete_id_fits(store, &id) {
        return registry_ws_error(
            None,
            "invalid_request",
            "id exceeds websocket response limit",
        );
    }
    if !registry_ws_delete_ack_fits(store, &id, &topic) {
        return registry_ws_error(
            Some(id),
            "item_too_large",
            "registry delete acknowledgement exceeds websocket message limit",
        );
    }
    match store.delete(
        RegistryWriterKind::WebsocketClient,
        origin.to_owned(),
        topic,
    ) {
        Ok(ack) => registry_delete_response(ack, id),
        Err(error) => registry_ws_store_error(Some(id), error),
    }
}

fn registry_delete_response(ack: RegistryDeleteAck, id: Value) -> Value {
    json!({
        "ok": true,
        "op": "ack",
        "kind": "registry_delete",
        "id": id,
        "topic": ack.topic,
        "deleted": ack.deleted,
        "seq": ack.seq,
        "server_time": crate::formatting::system_time_rfc3339(ack.server_time),
    })
}

fn registry_ws_set(
    store: &RegistryStore,
    origin: &str,
    object: &serde_json::Map<String, Value>,
) -> Value {
    let Some(id) = scalar_request_id(object) else {
        return registry_ws_error(None, "invalid_request", "id must be a JSON scalar");
    };
    if let Err(response) = reject_unknown_ws_fields(
        object,
        &[
            "op", "id", "topic", "value", "source", "ttl_secs", "freq_hz",
        ],
        &id,
    ) {
        return response;
    }
    let topic = match required_ws_string(object, "topic", "missing_topic") {
        Ok(topic) => topic,
        Err(response) => return with_registry_response_id(response, &id),
    };
    let Some(value) = object.get("value").cloned() else {
        return registry_ws_error(Some(id), "missing_value", "value is required");
    };
    let source = match object.get("source") {
        Some(Value::String(source)) => source.clone(),
        Some(_) => return registry_ws_error(Some(id), "invalid_source", "source must be a string"),
        None => return registry_ws_error(Some(id), "missing_source", "source is required"),
    };
    let mut request = RegistrySetRequest::new(topic, value, source);
    if let Some(ttl) = object.get("ttl_secs") {
        let ttl = match ws_ttl(ttl) {
            Ok(ttl) => ttl,
            Err(response) => return with_registry_response_id(response, &id),
        };
        request = request.with_ttl(ttl);
    }
    if let Some(freq_hz) = object.get("freq_hz") {
        let Some(freq_hz) = freq_hz.as_f64() else {
            return registry_ws_error(Some(id), "invalid_frequency", "freq_hz must be a number");
        };
        request = request.with_freq_hz(freq_hz);
    }
    let max_response_bytes = registry_ws_outbound_limit(store);
    if registry_set_compact_ack(&id, u64::MAX, max_response_bytes).is_none() {
        return registry_ws_error(
            None,
            "invalid_request",
            "id exceeds websocket response limit",
        );
    }

    match store.set(
        RegistryWriterKind::WebsocketClient,
        origin.to_owned(),
        request,
    ) {
        Ok(ack) => registry_set_response(ack, id, max_response_bytes),
        Err(error) => registry_ws_store_error(Some(id), error),
    }
}

fn registry_ws_get(
    store: &RegistryStore,
    id: Value,
    object: &serde_json::Map<String, Value>,
) -> Value {
    if let Err(response) = reject_unknown_ws_fields(object, &["op", "id", "topic", "limit"], &id) {
        return response;
    }
    let query = match ws_query(object, false) {
        Ok(query) => query,
        Err(response) => return with_registry_response_id(response, &id),
    };
    match store.get(query) {
        Ok(result) => registry_get_response(result, Some(id), store.config().max_response_bytes),
        Err(error) => registry_ws_store_error(Some(id), error),
    }
}

fn registry_ws_history(
    store: &RegistryStore,
    id: Value,
    object: &serde_json::Map<String, Value>,
) -> Value {
    if let Err(response) =
        reject_unknown_ws_fields(object, &["op", "id", "topic", "since_secs", "limit"], &id)
    {
        return response;
    }
    let query = match ws_query(object, true) {
        Ok(query) => query,
        Err(response) => return with_registry_response_id(response, &id),
    };
    match store.history(query) {
        Ok(result) => {
            registry_history_response(result, Some(id), store.config().max_response_bytes)
        }
        Err(error) => registry_ws_store_error(Some(id), error),
    }
}

fn reject_unknown_ws_fields(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    id: &Value,
) -> Result<(), Value> {
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(registry_ws_error(
            Some(id.clone()),
            "invalid_request",
            unknown_ws_field_message(field),
        ));
    }
    Ok(())
}

fn unknown_ws_field_message(field: &str) -> String {
    if !field.is_empty()
        && field.len() <= 64
        && field
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        format!("unknown field: {field}")
    } else {
        "unknown field".to_owned()
    }
}

fn ws_query(
    object: &serde_json::Map<String, Value>,
    require_since: bool,
) -> Result<RegistryQuery, Value> {
    let topic = required_ws_string(object, "topic", "missing_topic")?;
    let mut query = if require_since {
        let Some(value) = object.get("since_secs") else {
            return Err(registry_ws_error(
                None,
                "missing_since_secs",
                "since_secs is required",
            ));
        };
        let Some(since_secs) = value.as_f64() else {
            return Err(registry_ws_error(
                None,
                "invalid_since",
                "since_secs must be a number",
            ));
        };
        RegistryQuery::history(topic, since_secs)
    } else {
        RegistryQuery::new(topic)
    };
    if let Some(limit) = object.get("limit") {
        query = query.with_limit(ws_limit(limit)?);
    }
    Ok(query)
}

fn required_ws_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
    missing_code: &'static str,
) -> Result<String, Value> {
    match object.get(field) {
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => Err(registry_ws_error(
            None,
            "invalid_request",
            format!("{field} must be a string"),
        )),
        None => Err(registry_ws_error(
            None,
            missing_code,
            format!("{field} is required"),
        )),
    }
}

fn ws_limit(value: &Value) -> Result<usize, Value> {
    let Some(raw) = value.as_u64() else {
        return Err(registry_ws_error(
            None,
            "invalid_limit",
            "limit must be a positive integer",
        ));
    };
    usize::try_from(raw)
        .map_err(|_| registry_ws_error(None, "invalid_limit", "limit must be a positive integer"))
}

fn ws_ttl(value: &Value) -> Result<RegistryTtl, Value> {
    if value.is_null() {
        return Ok(RegistryTtl::Null);
    }
    let Some(seconds) = value.as_f64() else {
        return Err(registry_ws_error(
            None,
            "invalid_ttl",
            "ttl_secs must be a number",
        ));
    };
    Ok(RegistryTtl::Seconds(seconds))
}

fn registry_ws_store_error(id: Option<Value>, error: RegistryError) -> Value {
    registry_ws_error(id, error.code(), error.to_string())
}

fn registry_ws_error(id: Option<Value>, code: &'static str, message: impl Into<String>) -> Value {
    json!({
        "ok": false,
        "op": "error",
        "id": id.unwrap_or(Value::Null),
        "error": {
            "code": code,
            "message": bounded_chars(&message.into(), REGISTRY_WS_ERROR_MESSAGE_CHARS),
            "retryable": false
        }
    })
}

fn registry_response_id(body: &Value) -> Value {
    match body.get("id") {
        Some(Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null) => {
            body.get("id").cloned().unwrap_or(Value::Null)
        }
        _ => Value::Null,
    }
}

fn with_registry_response_id(mut response: Value, id: &Value) -> Value {
    response["id"] = id.clone();
    response
}

fn registry_set_response(ack: RegistrySetAck, id: Value, max_response_bytes: usize) -> Value {
    let mut body = json!({
        "ok": true,
        "op": "ack",
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
    body["id"] = id.clone();
    if body.to_string().len() <= max_response_bytes {
        return body;
    }
    registry_set_compact_ack(&id, ack.seq, max_response_bytes)
        .expect("set ack was preflighted with the worst-case sequence")
}

fn registry_set_compact_ack(id: &Value, seq: u64, max_response_bytes: usize) -> Option<Value> {
    let mut compact = json!({
        "ok": true,
        "op": "ack",
        "kind": "registry_set",
        "id": id,
        "seq": seq,
        "writer_kind": RegistryWriterKind::WebsocketClient.as_str(),
        "truncated": true,
        "truncated_reason": "response_bytes",
    });
    if compact.to_string().len() <= max_response_bytes {
        return Some(compact);
    }
    compact
        .as_object_mut()
        .expect("set acknowledgement should be an object")
        .remove("truncated_reason");
    (compact.to_string().len() <= max_response_bytes).then_some(compact)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegistrySubscriptionFatal {
    BroadcastLag,
    SlowConsumer,
}

impl RegistrySubscriptionFatal {
    fn reason(self) -> &'static str {
        match self {
            Self::BroadcastLag => "broadcast_lag",
            Self::SlowConsumer => "slow_consumer",
        }
    }
}

enum RegistrySubscriptionSend {
    Sent,
    Closed,
    Fatal(RegistrySubscriptionFatal),
    SendTimeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimedWsSendError {
    Closed,
    Timeout,
}

async fn timed_ws_send<S>(
    sink: &mut S,
    message: WsMessage,
    send_timeout: Duration,
) -> Result<(), TimedWsSendError>
where
    S: futures_util::Sink<WsMessage> + Unpin,
{
    match tokio::time::timeout(send_timeout, sink.send(message)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(TimedWsSendError::Closed),
        Err(_) => Err(TimedWsSendError::Timeout),
    }
}

struct RegistrySubscriptionCancelGuard(CancellationToken);

impl Drop for RegistrySubscriptionCancelGuard {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

async fn run_registry_subscription(
    socket: WebSocket,
    store: RegistryStore,
    id: Value,
    snapshot: RegistrySubscriptionSnapshot,
) {
    let (sink, stream) = socket.split();
    let _ = run_registry_subscription_parts(sink, stream, store, id, snapshot).await;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RegistrySubscriptionRunReport {
    reason: Option<&'static str>,
    cancellation_observed: bool,
    drain_joined: bool,
}

async fn run_registry_subscription_parts<S, R, E>(
    mut sink: S,
    mut stream: R,
    store: RegistryStore,
    id: Value,
    snapshot: RegistrySubscriptionSnapshot,
) -> RegistrySubscriptionRunReport
where
    S: Sink<WsMessage> + Unpin,
    R: Stream<Item = Result<WsMessage, E>> + Unpin,
{
    let RegistrySubscriptionSnapshot {
        receiver,
        watermark,
        items,
        snapshot_time,
        permit,
        filter,
    } = snapshot;
    let topics = filter.canonical_topics().to_vec();
    let cancel = CancellationToken::new();
    let cancel_guard = RegistrySubscriptionCancelGuard(cancel.clone());
    let (data_tx, mut data_rx) = mpsc::channel(store.options().subscription_queue_capacity);
    let (fatal_tx, mut fatal_rx) = mpsc::channel(1);
    let drain_cancel = cancel.clone();
    let drain = tokio::spawn(drain_registry_subscription(
        receiver,
        filter,
        watermark,
        data_tx,
        fatal_tx,
        drain_cancel,
    ));

    let max_bytes = registry_ws_outbound_limit(&store);
    let send_timeout = store.options().subscription_send_timeout;
    let mut last_sent_seq = watermark;
    let outcome = run_registry_subscription_owner(
        &mut sink,
        &mut stream,
        &mut fatal_rx,
        &mut data_rx,
        &store,
        &id,
        &topics,
        watermark,
        snapshot_time,
        items,
        max_bytes,
        send_timeout,
        &mut last_sent_seq,
    )
    .await;

    if let Some(reason) = outcome {
        store.record_slow_subscription_closed();
        let resync = json!({
            "ok": false,
            "op": "resync_required",
            "kind": "registry_subscribe",
            "instance_id": store.instance_id(),
            "last_sent_seq": last_sent_seq,
            "reason": reason,
        });
        if resync.to_string().len() <= max_bytes {
            let _ =
                tokio::time::timeout(send_timeout, sink.send(WsMessage::Text(resync.to_string())))
                    .await;
        }
        let _ = tokio::time::timeout(
            send_timeout,
            sink.send(WsMessage::Close(Some(CloseFrame {
                code: close_code::ERROR,
                reason: "resubscribe required".into(),
            }))),
        )
        .await;
    }
    cancel.cancel();
    let drain_joined = drain.await.is_ok();
    drop(permit);
    drop(cancel_guard);
    RegistrySubscriptionRunReport {
        reason: outcome,
        cancellation_observed: cancel.is_cancelled(),
        drain_joined,
    }
}

async fn drain_registry_subscription(
    mut receiver: tokio::sync::broadcast::Receiver<RegistryChange>,
    filter: RegistrySubscriptionFilter,
    watermark: u64,
    data_tx: mpsc::Sender<RegistryChange>,
    fatal_tx: mpsc::Sender<RegistrySubscriptionFatal>,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            received = receiver.recv() => {
                match received {
                    Ok(change) => {
                        if change.seq() <= watermark || !filter.matches(change.topic()) {
                            continue;
                        }
                        if data_tx.try_send(change).is_err() {
                            let _ = fatal_tx.try_send(RegistrySubscriptionFatal::SlowConsumer);
                            cancel.cancel();
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = fatal_tx.try_send(RegistrySubscriptionFatal::BroadcastLag);
                        cancel.cancel();
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_registry_subscription_owner<S, R, E>(
    sink: &mut S,
    stream: &mut R,
    fatal_rx: &mut mpsc::Receiver<RegistrySubscriptionFatal>,
    data_rx: &mut mpsc::Receiver<RegistryChange>,
    store: &RegistryStore,
    id: &Value,
    topics: &[String],
    watermark: u64,
    snapshot_time: SystemTime,
    items: Vec<Arc<RegistryItem>>,
    max_bytes: usize,
    send_timeout: Duration,
    last_sent_seq: &mut u64,
) -> Option<&'static str>
where
    S: Sink<WsMessage> + Unpin,
    R: Stream<Item = Result<WsMessage, E>> + Unpin,
{
    let server_time = crate::formatting::system_time_rfc3339(snapshot_time);
    let begin = registry_subscription_begin(store, id, topics, watermark, &server_time);
    if begin.to_string().len() > max_bytes {
        send_subscription_error_and_close(
            sink,
            id.clone(),
            "item_too_large",
            "subscription envelope exceeds websocket message limit",
            max_bytes,
            send_timeout,
        )
        .await;
        return None;
    }
    if let Some(reason) = subscription_send_result(
        send_subscription_json(sink, stream, fatal_rx, begin, max_bytes, send_timeout).await,
    ) {
        return reason;
    }

    let item_count = items.len();
    let mut planner = RegistrySnapshotChunkPlanner::new(store.instance_id(), watermark, max_bytes);
    for item in items {
        let action = planner.push(registry_item_json(item.as_ref()));
        let (chunk, oversized) = match action {
            RegistrySnapshotPlanAction::Pending => continue,
            RegistrySnapshotPlanAction::ChunkReady(chunk) => (Some(chunk), false),
            RegistrySnapshotPlanAction::ItemTooLarge { completed } => (completed, true),
        };
        if let Some(chunk) = chunk {
            let text = planner.chunk_text(chunk);
            if let Some(reason) = subscription_send_result(
                send_subscription_text(sink, stream, fatal_rx, text, max_bytes, send_timeout).await,
            ) {
                return reason;
            }
        }
        if oversized {
            send_subscription_error_and_close(
                sink,
                id.clone(),
                "item_too_large",
                RegistrySnapshotPlanFailure::ItemTooLarge.message(),
                max_bytes,
                send_timeout,
            )
            .await;
            return None;
        }
    }
    let chunk = match planner.finish() {
        Ok(chunk) => chunk,
        Err(failure) => {
            send_subscription_error_and_close(
                sink,
                id.clone(),
                "item_too_large",
                failure.message(),
                max_bytes,
                send_timeout,
            )
            .await;
            return None;
        }
    };
    let chunk_count = chunk.chunk_index + 1;
    let text = planner.chunk_text(chunk);
    if let Some(reason) = subscription_send_result(
        send_subscription_text(sink, stream, fatal_rx, text, max_bytes, send_timeout).await,
    ) {
        return reason;
    }
    let end = json!({
        "ok": true,
        "op": "snapshot_end",
        "kind": "registry_subscribe",
        "instance_id": store.instance_id(),
        "watermark": watermark,
        "item_count": item_count,
        "chunk_count": chunk_count,
    });
    if end.to_string().len() > max_bytes {
        send_subscription_error_and_close(
            sink,
            id.clone(),
            "item_too_large",
            "subscription envelope exceeds websocket message limit",
            max_bytes,
            send_timeout,
        )
        .await;
        return None;
    }
    if let Some(reason) = subscription_send_result(
        send_subscription_json(sink, stream, fatal_rx, end, max_bytes, send_timeout).await,
    ) {
        return reason;
    }

    loop {
        tokio::select! {
            biased;
            fatal = fatal_rx.recv() => {
                return fatal.map(|fatal| fatal.reason());
            }
            inbound = stream.next() => {
                match handle_subscription_inbound(sink, inbound, max_bytes, send_timeout).await {
                    RegistrySubscriptionSend::Sent => {}
                    RegistrySubscriptionSend::Closed => return None,
                    RegistrySubscriptionSend::Fatal(fatal) => return Some(fatal.reason()),
                    RegistrySubscriptionSend::SendTimeout => return Some("send_timeout"),
                }
            }
            change = data_rx.recv() => {
                let change = change?;
                let seq = change.seq();
                let frame = registry_change_json(store.instance_id(), &change);
                if frame.to_string().len() > max_bytes {
                    send_subscription_error_and_close(
                        sink,
                        Value::Null,
                        "item_too_large",
                        "registry change exceeds websocket message limit",
                        max_bytes,
                        send_timeout,
                    ).await;
                    return None;
                }
                match send_subscription_json(sink, stream, fatal_rx, frame, max_bytes, send_timeout).await {
                    RegistrySubscriptionSend::Sent => *last_sent_seq = seq,
                    RegistrySubscriptionSend::Closed => return None,
                    RegistrySubscriptionSend::Fatal(fatal) => return Some(fatal.reason()),
                    RegistrySubscriptionSend::SendTimeout => return Some("send_timeout"),
                }
            }
        }
    }
}

fn subscription_send_result(result: RegistrySubscriptionSend) -> Option<Option<&'static str>> {
    match result {
        RegistrySubscriptionSend::Sent => None,
        RegistrySubscriptionSend::Closed => Some(None),
        RegistrySubscriptionSend::Fatal(fatal) => Some(Some(fatal.reason())),
        RegistrySubscriptionSend::SendTimeout => Some(Some("send_timeout")),
    }
}

const SNAPSHOT_CHUNK_INDEX_PREFIX: &str = "{\"chunk_index\":";
const SNAPSHOT_CHUNK_INSTANCE_ID_PREFIX: &str = ",\"instance_id\":";
const SNAPSHOT_CHUNK_ITEMS_PREFIX: &str = ",\"items\":[";
const SNAPSHOT_CHUNK_WATERMARK_PREFIX: &str =
    "],\"kind\":\"registry_subscribe\",\"ok\":true,\"op\":\"snapshot_chunk\",\"watermark\":";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegistrySnapshotPlanFailure {
    ItemTooLarge,
    EnvelopeTooLarge,
}

impl RegistrySnapshotPlanFailure {
    fn message(self) -> &'static str {
        match self {
            Self::ItemTooLarge => "registry item exceeds websocket message limit",
            Self::EnvelopeTooLarge => "subscription envelope exceeds websocket message limit",
        }
    }
}

#[derive(Debug, Clone)]
struct RegistrySnapshotChunkPlan {
    chunk_index: usize,
    items: Vec<String>,
    serialized_len: usize,
}

impl RegistrySnapshotChunkPlan {
    fn into_text(self, instance_id_json: &str, watermark: u64) -> String {
        let mut text = String::with_capacity(self.serialized_len);
        text.push_str(SNAPSHOT_CHUNK_INDEX_PREFIX);
        write!(text, "{}", self.chunk_index).expect("writing to String should succeed");
        text.push_str(SNAPSHOT_CHUNK_INSTANCE_ID_PREFIX);
        text.push_str(instance_id_json);
        text.push_str(SNAPSHOT_CHUNK_ITEMS_PREFIX);
        for (index, item) in self.items.into_iter().enumerate() {
            if index > 0 {
                text.push(',');
            }
            text.push_str(&item);
        }
        text.push_str(SNAPSHOT_CHUNK_WATERMARK_PREFIX);
        write!(text, "{watermark}}}").expect("writing to String should succeed");
        debug_assert_eq!(text.len(), self.serialized_len);
        text
    }
}

#[derive(Debug)]
enum RegistrySnapshotPlanAction {
    Pending,
    ChunkReady(RegistrySnapshotChunkPlan),
    ItemTooLarge {
        completed: Option<RegistrySnapshotChunkPlan>,
    },
}

#[derive(Debug)]
struct RegistrySnapshotChunkPlanner {
    instance_id_json: String,
    watermark: u64,
    max_bytes: usize,
    chunk_index: usize,
    chunk_items: Vec<String>,
    items_bytes: usize,
    #[cfg(test)]
    serialized_item_count: usize,
}

impl RegistrySnapshotChunkPlanner {
    fn new(instance_id: &str, watermark: u64, max_bytes: usize) -> Self {
        Self {
            instance_id_json: serde_json::to_string(instance_id)
                .expect("registry instance id should serialize"),
            watermark,
            max_bytes,
            chunk_index: 0,
            chunk_items: Vec::new(),
            items_bytes: 0,
            #[cfg(test)]
            serialized_item_count: 0,
        }
    }

    fn push(&mut self, item: Value) -> RegistrySnapshotPlanAction {
        let item = serde_json::to_string(&item).expect("registry item should serialize");
        #[cfg(test)]
        {
            self.serialized_item_count += 1;
        }
        let separator_bytes = usize::from(!self.chunk_items.is_empty());
        let candidate_len = self
            .current_base_len()
            .saturating_add(self.items_bytes)
            .saturating_add(separator_bytes)
            .saturating_add(item.len());
        if candidate_len <= self.max_bytes {
            self.items_bytes += separator_bytes + item.len();
            self.chunk_items.push(item);
            return RegistrySnapshotPlanAction::Pending;
        }

        let completed = (!self.chunk_items.is_empty()).then(|| self.take_current_chunk());

        let single_len = self.current_base_len().saturating_add(item.len());
        if single_len > self.max_bytes {
            return RegistrySnapshotPlanAction::ItemTooLarge { completed };
        }
        self.items_bytes = item.len();
        self.chunk_items.push(item);
        match completed {
            Some(chunk) => RegistrySnapshotPlanAction::ChunkReady(chunk),
            None => RegistrySnapshotPlanAction::Pending,
        }
    }

    fn finish(&mut self) -> Result<RegistrySnapshotChunkPlan, RegistrySnapshotPlanFailure> {
        let serialized_len = self.current_base_len() + self.items_bytes;
        if self.chunk_items.is_empty() && self.chunk_index == 0 && serialized_len > self.max_bytes {
            return Err(RegistrySnapshotPlanFailure::EnvelopeTooLarge);
        }
        debug_assert!(serialized_len <= self.max_bytes);
        Ok(RegistrySnapshotChunkPlan {
            chunk_index: self.chunk_index,
            items: std::mem::take(&mut self.chunk_items),
            serialized_len,
        })
    }

    fn chunk_text(&self, chunk: RegistrySnapshotChunkPlan) -> String {
        chunk.into_text(&self.instance_id_json, self.watermark)
    }

    fn current_base_len(&self) -> usize {
        registry_snapshot_chunk_base_len(
            self.instance_id_json.len(),
            self.watermark,
            self.chunk_index,
        )
    }

    fn take_current_chunk(&mut self) -> RegistrySnapshotChunkPlan {
        let chunk = RegistrySnapshotChunkPlan {
            chunk_index: self.chunk_index,
            items: std::mem::take(&mut self.chunk_items),
            serialized_len: self.current_base_len() + self.items_bytes,
        };
        self.items_bytes = 0;
        self.chunk_index += 1;
        chunk
    }

    #[cfg(test)]
    fn serialized_item_count(&self) -> usize {
        self.serialized_item_count
    }

    #[cfg(test)]
    fn buffered_item_count(&self) -> usize {
        self.chunk_items.len()
    }
}

fn registry_snapshot_chunk_base_len(
    instance_id_json_len: usize,
    watermark: u64,
    chunk_index: usize,
) -> usize {
    SNAPSHOT_CHUNK_INDEX_PREFIX.len()
        + decimal_len(chunk_index as u64)
        + SNAPSHOT_CHUNK_INSTANCE_ID_PREFIX.len()
        + instance_id_json_len
        + SNAPSHOT_CHUNK_ITEMS_PREFIX.len()
        + SNAPSHOT_CHUNK_WATERMARK_PREFIX.len()
        + decimal_len(watermark)
        + 1
}

fn decimal_len(value: u64) -> usize {
    value.checked_ilog10().unwrap_or(0) as usize + 1
}

fn registry_change_json(instance_id: &str, change: &RegistryChange) -> Value {
    match change {
        RegistryChange::Set {
            seq,
            changed_at,
            item,
        } => json!({
            "ok": true,
            "op": "change",
            "kind": "registry_change",
            "instance_id": instance_id,
            "change": "set",
            "seq": seq,
            "topic": item.topic,
            "changed_at": crate::formatting::system_time_rfc3339(*changed_at),
            "item": registry_item_json(item),
        }),
        RegistryChange::Delete {
            seq,
            changed_at,
            topic,
            ..
        } => json!({
            "ok": true,
            "op": "change",
            "kind": "registry_change",
            "instance_id": instance_id,
            "change": "delete",
            "seq": seq,
            "topic": topic,
            "changed_at": crate::formatting::system_time_rfc3339(*changed_at),
            "item": null,
        }),
        RegistryChange::Expire {
            seq,
            changed_at,
            topic,
        } => json!({
            "ok": true,
            "op": "change",
            "kind": "registry_change",
            "instance_id": instance_id,
            "change": "expire",
            "seq": seq,
            "topic": topic,
            "changed_at": crate::formatting::system_time_rfc3339(*changed_at),
            "item": null,
        }),
    }
}

async fn send_subscription_text<S, R, E>(
    sink: &mut S,
    stream: &mut R,
    fatal_rx: &mut mpsc::Receiver<RegistrySubscriptionFatal>,
    text: String,
    max_bytes: usize,
    send_timeout: Duration,
) -> RegistrySubscriptionSend
where
    S: Sink<WsMessage> + Unpin,
    R: Stream<Item = Result<WsMessage, E>> + Unpin,
{
    debug_assert!(text.len() <= max_bytes);
    loop {
        tokio::select! {
            biased;
            fatal = fatal_rx.recv() => {
                return fatal.map(RegistrySubscriptionSend::Fatal).unwrap_or(RegistrySubscriptionSend::Closed);
            }
            inbound = stream.next() => {
                match handle_subscription_inbound(sink, inbound, max_bytes, send_timeout).await {
                    RegistrySubscriptionSend::Sent => continue,
                    result => return result,
                }
            }
            sent = timed_ws_send(sink, WsMessage::Text(text.clone()), send_timeout) => {
                return match sent {
                    Ok(()) => RegistrySubscriptionSend::Sent,
                    Err(TimedWsSendError::Closed) => RegistrySubscriptionSend::Closed,
                    Err(TimedWsSendError::Timeout) => RegistrySubscriptionSend::SendTimeout,
                };
            }
        }
    }
}

async fn send_subscription_json<S, R, E>(
    sink: &mut S,
    stream: &mut R,
    fatal_rx: &mut mpsc::Receiver<RegistrySubscriptionFatal>,
    body: Value,
    max_bytes: usize,
    send_timeout: Duration,
) -> RegistrySubscriptionSend
where
    S: Sink<WsMessage> + Unpin,
    R: Stream<Item = Result<WsMessage, E>> + Unpin,
{
    let text = body.to_string();
    debug_assert!(text.len() <= max_bytes);
    loop {
        tokio::select! {
            biased;
            fatal = fatal_rx.recv() => {
                return fatal.map(RegistrySubscriptionSend::Fatal).unwrap_or(RegistrySubscriptionSend::Closed);
            }
            inbound = stream.next() => {
                match handle_subscription_inbound(sink, inbound, max_bytes, send_timeout).await {
                    RegistrySubscriptionSend::Sent => continue,
                    result => return result,
                }
            }
            sent = timed_ws_send(sink, WsMessage::Text(text.clone()), send_timeout) => {
                return match sent {
                    Ok(()) => RegistrySubscriptionSend::Sent,
                    Err(TimedWsSendError::Closed) => RegistrySubscriptionSend::Closed,
                    Err(TimedWsSendError::Timeout) => RegistrySubscriptionSend::SendTimeout,
                };
            }
        }
    }
}

async fn handle_subscription_inbound<S, E>(
    sink: &mut S,
    inbound: Option<Result<WsMessage, E>>,
    max_bytes: usize,
    send_timeout: Duration,
) -> RegistrySubscriptionSend
where
    S: Sink<WsMessage> + Unpin,
{
    match inbound {
        Some(Ok(WsMessage::Ping(payload))) => {
            match tokio::time::timeout(send_timeout, sink.send(WsMessage::Pong(payload))).await {
                Ok(Ok(())) => RegistrySubscriptionSend::Sent,
                Ok(Err(_)) => RegistrySubscriptionSend::Closed,
                Err(_) => RegistrySubscriptionSend::SendTimeout,
            }
        }
        Some(Ok(WsMessage::Pong(_))) => RegistrySubscriptionSend::Sent,
        Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => RegistrySubscriptionSend::Closed,
        Some(Ok(WsMessage::Text(_) | WsMessage::Binary(_))) => {
            let error = bounded_registry_response(
                registry_ws_error(
                    None,
                    "invalid_request",
                    "subscription connection does not accept business requests",
                ),
                max_bytes,
                RegistryResponseTruncateSide::Back,
            );
            let _ =
                tokio::time::timeout(send_timeout, sink.send(WsMessage::Text(error.to_string())))
                    .await;
            let _ = tokio::time::timeout(
                send_timeout,
                sink.send(WsMessage::Close(Some(CloseFrame {
                    code: close_code::PROTOCOL,
                    reason: "subscription protocol error".into(),
                }))),
            )
            .await;
            RegistrySubscriptionSend::Closed
        }
    }
}

async fn send_subscription_error_and_close<S>(
    sink: &mut S,
    id: Value,
    code: &'static str,
    message: &'static str,
    max_bytes: usize,
    send_timeout: Duration,
) where
    S: Sink<WsMessage> + Unpin,
{
    let error = bounded_registry_response(
        registry_ws_error(Some(id), code, message),
        max_bytes,
        RegistryResponseTruncateSide::Back,
    )
    .to_string();
    let _ = tokio::time::timeout(send_timeout, sink.send(WsMessage::Text(error))).await;
    let _ = tokio::time::timeout(
        send_timeout,
        sink.send(WsMessage::Close(Some(CloseFrame {
            code: close_code::ERROR,
            reason: "subscription error".into(),
        }))),
    )
    .await;
}

#[cfg(test)]
mod registry_subscription_tests {
    use std::convert::Infallible;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::task::{Context, Poll};

    use futures_util::{Sink, Stream};
    use serde_json::json;

    use super::super::{bounded_registry_response, RegistryResponseTruncateSide};
    use super::*;
    use crate::registry::{
        RegistryConfig, RegistryStoreOptions, MIN_REGISTRY_RESPONSE_BYTES,
        MIN_REGISTRY_WS_MESSAGE_BYTES,
    };

    fn store_with_capacities(broadcast: usize, queue: usize) -> RegistryStore {
        RegistryStore::with_options(
            RegistryConfig::default(),
            RegistryStoreOptions::default().with_subscription_limits(
                broadcast,
                queue,
                Duration::from_millis(10),
            ),
        )
        .unwrap()
    }

    fn write(store: &RegistryStore, topic: &str, value: u64) {
        store
            .set(
                RegistryWriterKind::MainAgent,
                "main_agent",
                RegistrySetRequest::new(topic, json!(value), "test").with_ttl(RegistryTtl::Null),
            )
            .unwrap();
    }

    fn subscription_filter(store: &RegistryStore, topics: &[&str]) -> RegistrySubscriptionFilter {
        store
            .subscription_filter(topics.iter().map(|topic| (*topic).to_owned()).collect())
            .unwrap()
    }

    fn collect_snapshot_plan(
        instance_id: &str,
        watermark: u64,
        items: impl IntoIterator<Item = Value>,
        max_bytes: usize,
    ) -> (
        RegistrySnapshotChunkPlanner,
        Vec<RegistrySnapshotChunkPlan>,
        Option<RegistrySnapshotPlanFailure>,
        usize,
    ) {
        let mut planner = RegistrySnapshotChunkPlanner::new(instance_id, watermark, max_bytes);
        let mut chunks = Vec::new();
        let mut max_buffered_items = 0;
        for item in items {
            match planner.push(item) {
                RegistrySnapshotPlanAction::Pending => {}
                RegistrySnapshotPlanAction::ChunkReady(chunk) => chunks.push(chunk),
                RegistrySnapshotPlanAction::ItemTooLarge { completed } => {
                    chunks.extend(completed);
                    max_buffered_items = max_buffered_items.max(planner.buffered_item_count());
                    return (
                        planner,
                        chunks,
                        Some(RegistrySnapshotPlanFailure::ItemTooLarge),
                        max_buffered_items,
                    );
                }
            }
            max_buffered_items = max_buffered_items.max(planner.buffered_item_count());
        }
        let failure = match planner.finish() {
            Ok(chunk) => {
                chunks.push(chunk);
                None
            }
            Err(failure) => Some(failure),
        };
        (planner, chunks, failure, max_buffered_items)
    }

    #[test]
    fn response_helper_keeps_legacy_74_byte_compaction_coverage_without_a_store() {
        let response = bounded_registry_response(
            json!({
                "ok": true,
                "op": "snapshot",
                "kind": "registry_get",
                "id": "x".repeat(256),
                "items": [{"payload": "x".repeat(1024)}],
                "matched_count": 1,
                "returned_count": 1,
                "truncated": false,
                "truncated_reason": null,
            }),
            MIN_REGISTRY_RESPONSE_BYTES,
            RegistryResponseTruncateSide::Back,
        );
        assert!(response.to_string().len() <= MIN_REGISTRY_RESPONSE_BYTES);
        assert_eq!(response["ok"], true);
        assert_eq!(response["op"], "snapshot");
        assert!(response["items"].is_array());
        assert_eq!(response["truncated"], true);
    }

    #[tokio::test]
    async fn registry_ws_worker_panic_maps_to_stable_retryable_error() {
        let permit = Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap();
        run_registry_ws_task::<()>(permit, || panic!("sensitive worker panic"))
            .await
            .expect_err("worker panic should fail");

        let error = registry_ws_worker_error(
            json!("known-id"),
            RegistryWsWorkerFailure::Internal,
            MIN_REGISTRY_WS_MESSAGE_BYTES,
        );
        assert_eq!(error["ok"], false);
        assert_eq!(error["op"], "error");
        assert_eq!(error["id"], "known-id");
        assert_eq!(error["error"]["code"], "internal_error");
        assert_eq!(error["error"]["retryable"], true);
        assert_eq!(
            error["error"]["message"],
            "registry websocket worker failed"
        );
        assert!(!error.to_string().contains("sensitive"));
    }

    #[tokio::test]
    async fn registry_ws_frame_worker_limit_preserves_non_subscribe_request_id() {
        let store = RegistryStore::new(RegistryConfig::default()).unwrap();
        let text = json!({
            "op": "get",
            "id": "limited-request",
            "topic": "robot.**"
        })
        .to_string();
        let request_id = match registry_ws_subscribe_request(&store, &text) {
            RegistryWsSubscribeRequest::NotSubscribe { id } => id,
            _ => panic!("get request must use normal frame dispatch"),
        };
        let max_frame_bytes = store.options().websocket_max_frame_bytes;

        let failure = registry_ws_frame_response(
            store.clone(),
            "ws:test".to_owned(),
            max_frame_bytes,
            Ok(WsMessage::Text(text)),
            Arc::new(Semaphore::new(0)),
            request_id,
        )
        .await
        .expect_err("exhausted worker slots should reject the frame");

        assert_eq!(failure.id, "limited-request");
        assert_eq!(failure.kind, RegistryWsWorkerFailure::Limit);
        let response =
            registry_ws_worker_error(failure.id, failure.kind, registry_ws_outbound_limit(&store));
        assert_eq!(response["id"], "limited-request");
        assert_eq!(response["error"]["code"], "registry_worker_limit");
        assert_eq!(response["error"]["retryable"], true);
    }

    #[test]
    fn snapshot_chunk_planner_emits_one_exact_empty_frame() {
        let instance_id = "registry-\"escaped";
        let watermark = 42;
        let (planner, mut chunks, failure, max_buffered) =
            collect_snapshot_plan(instance_id, watermark, std::iter::empty(), usize::MAX);

        assert_eq!(planner.serialized_item_count(), 0);
        assert_eq!(failure, None);
        assert_eq!(max_buffered, 0);
        assert_eq!(chunks.len(), 1);
        let chunk = chunks.pop().unwrap();
        let expected = json!({
            "ok": true,
            "op": "snapshot_chunk",
            "kind": "registry_subscribe",
            "instance_id": instance_id,
            "watermark": watermark,
            "chunk_index": 0,
            "items": [],
        })
        .to_string();
        let text = planner.chunk_text(chunk);
        assert_eq!(text, expected);
    }

    #[test]
    fn snapshot_chunk_planner_accepts_exact_fit_and_rejects_one_byte_over() {
        let instance_id = "registry-fit";
        let watermark = 7;
        let item = json!({"payload": "fit"});
        let item_len = serde_json::to_string(&item).unwrap().len();
        let instance_id_json_len = serde_json::to_string(instance_id).unwrap().len();
        let exact_cap =
            registry_snapshot_chunk_base_len(instance_id_json_len, watermark, 0) + item_len;

        let (exact, chunks, failure, max_buffered) =
            collect_snapshot_plan(instance_id, watermark, [item.clone()], exact_cap);
        assert_eq!(exact.serialized_item_count(), 1);
        assert_eq!(failure, None);
        assert_eq!(max_buffered, 1);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].serialized_len, exact_cap);
        assert_eq!(exact.chunk_text(chunks[0].clone()).len(), exact_cap);

        let (over_by_one, chunks, failure, max_buffered) =
            collect_snapshot_plan(instance_id, watermark, [item], exact_cap - 1);
        assert_eq!(over_by_one.serialized_item_count(), 1);
        assert_eq!(max_buffered, 0);
        assert_eq!(failure, Some(RegistrySnapshotPlanFailure::ItemTooLarge));
        assert!(chunks.is_empty());
    }

    #[test]
    fn snapshot_chunk_planner_preserves_completed_chunks_before_oversized_item() {
        let instance_id = "registry-partial";
        let watermark = 9;
        let first = json!({"order": 0, "payload": "small"});
        let oversized = json!({"order": 1, "payload": "x".repeat(1024)});
        let first_len = serde_json::to_string(&first).unwrap().len();
        let instance_id_json_len = serde_json::to_string(instance_id).unwrap().len();
        let cap = registry_snapshot_chunk_base_len(instance_id_json_len, watermark, 0) + first_len;

        let (planner, chunks, failure, max_buffered) =
            collect_snapshot_plan(instance_id, watermark, [first.clone(), oversized], cap);
        assert_eq!(planner.serialized_item_count(), 2);
        assert_eq!(max_buffered, 1);
        assert_eq!(failure, Some(RegistrySnapshotPlanFailure::ItemTooLarge));
        assert_eq!(chunks.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(&chunks[0].items[0]).unwrap(),
            first
        );
        assert_eq!(chunks[0].serialized_len, cap);
    }

    #[test]
    fn snapshot_chunk_planner_handles_index_width_change_without_exceeding_cap() {
        let instance_id = "registry-index";
        let watermark = u64::MAX;
        let item = json!({"payload": "x".repeat(80)});
        let item_len = serde_json::to_string(&item).unwrap().len();
        let instance_id_json_len = serde_json::to_string(instance_id).unwrap().len();
        let cap = registry_snapshot_chunk_base_len(instance_id_json_len, watermark, 10) + item_len;
        let items = std::iter::repeat_n(item, 11).collect::<Vec<_>>();

        let (planner, chunks, failure, max_buffered) =
            collect_snapshot_plan(instance_id, watermark, items, cap);
        assert_eq!(planner.serialized_item_count(), 11);
        assert_eq!(failure, None);
        assert_eq!(max_buffered, 1);
        assert_eq!(chunks.len(), 11);
        assert!(chunks.iter().all(|chunk| chunk.items.len() == 1));
        assert_eq!(chunks[9].chunk_index, 9);
        assert_eq!(chunks[10].chunk_index, 10);
        assert_eq!(chunks[10].serialized_len, chunks[9].serialized_len + 1);
        for chunk in chunks {
            let text = planner.chunk_text(chunk);
            assert!(text.len() <= cap);
        }
    }

    #[test]
    fn snapshot_chunk_planner_flattens_escaped_and_multibyte_items_in_order() {
        let instance_id = "registry-多字节-\"\\";
        let watermark = 123;
        let items = (0..12)
            .map(|index| {
                json!({
                    "order": index,
                    "escaped": "quote: \" slash: \\ newline:\n",
                    "multibyte": "机器人状态",
                })
            })
            .collect::<Vec<_>>();
        let instance_id_json_len = serde_json::to_string(instance_id).unwrap().len();
        let largest_item_len = items
            .iter()
            .map(|item| serde_json::to_string(item).unwrap().len())
            .max()
            .unwrap();
        let cap = registry_snapshot_chunk_base_len(instance_id_json_len, watermark, 11)
            + largest_item_len
            + 8;

        let (planner, chunks, failure, max_buffered) =
            collect_snapshot_plan(instance_id, watermark, items.clone(), cap);
        assert_eq!(planner.serialized_item_count(), items.len());
        assert_eq!(failure, None);
        assert_eq!(max_buffered, 1);
        let flattened = chunks
            .iter()
            .flat_map(|chunk| chunk.items.iter())
            .map(|item| serde_json::from_str::<Value>(item).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(flattened, items);
        for chunk in chunks {
            let expected_len = chunk.serialized_len;
            let text = planner.chunk_text(chunk);
            assert_eq!(text.len(), expected_len);
            assert!(text.len() <= cap);
            serde_json::from_str::<Value>(&text).expect("planned frame must be valid JSON");
        }
    }

    #[test]
    fn subscribe_store_errors_map_to_distinct_standard_close_classes() {
        assert_eq!(
            registry_ws_store_error_close_code(&RegistryError::InvalidPattern),
            close_code::PROTOCOL
        );
        assert_eq!(
            registry_ws_store_error_close_code(&RegistryError::TooManySubscriptions),
            close_code::POLICY
        );
        assert_eq!(
            registry_ws_store_error_close_code(&RegistryError::SeqExhausted),
            close_code::ERROR
        );
    }

    #[test]
    fn subscribe_max_watermark_preflight_rejects_before_begin_or_lazy_expire() {
        let store = RegistryStore::new(RegistryConfig {
            max_response_bytes: 200,
            ..RegistryConfig::default()
        })
        .unwrap();
        store
            .set_at(
                RegistryWriterKind::MainAgent,
                "main_agent",
                RegistrySetRequest::new("robot.expired", json!(1), "test")
                    .with_ttl(RegistryTtl::Seconds(1.0)),
                SystemTime::now() - Duration::from_secs(2),
            )
            .unwrap();
        let before = store.stats();

        let request = registry_ws_subscribe_request(
            &store,
            &json!({"op":"subscribe","id":null,"topics":["robot.**","controller.mode"]})
                .to_string(),
        );

        assert!(matches!(
            request,
            RegistryWsSubscribeRequest::Reject {
                close_code: close_code::PROTOCOL,
                ..
            }
        ));
        let after = store.stats();
        assert_eq!(after.active_subscriptions, 0);
        assert_eq!(after.expire_total, before.expire_total);
        assert_eq!(after.last_committed_seq, before.last_committed_seq);
        assert_eq!(after.current_topics, before.current_topics);
    }

    #[test]
    fn subscribe_invalid_pattern_preflight_rejects_before_begin_or_lazy_expire() {
        let store = RegistryStore::new(RegistryConfig::default()).unwrap();
        store
            .set_at(
                RegistryWriterKind::MainAgent,
                "main_agent",
                RegistrySetRequest::new("robot.expired", json!(1), "test")
                    .with_ttl(RegistryTtl::Seconds(1.0)),
                SystemTime::now() - Duration::from_secs(2),
            )
            .unwrap();
        let before = store.stats();

        let request = registry_ws_subscribe_request(
            &store,
            &json!({
                "op": "subscribe",
                "id": "bad-pattern",
                "topics": ["robot.**", "robot.**.bad"]
            })
            .to_string(),
        );

        let RegistryWsSubscribeRequest::Reject {
            response,
            close_code,
        } = request
        else {
            panic!("invalid subscription pattern must be rejected during preflight");
        };
        assert_eq!(response["id"], "bad-pattern");
        assert_eq!(response["error"]["code"], "invalid_pattern");
        assert_eq!(close_code, close_code::PROTOCOL);
        assert_eq!(store.stats(), before);
    }

    #[tokio::test]
    async fn drain_reports_global_broadcast_lag_on_independent_fatal_channel() {
        let store = store_with_capacities(2, 8);
        let snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        write(&store, "robot.a", 1);
        write(&store, "robot.a", 2);
        write(&store, "robot.a", 3);
        let (data_tx, _data_rx) = mpsc::channel(8);
        let (fatal_tx, mut fatal_rx) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let RegistrySubscriptionSnapshot {
            receiver,
            watermark,
            filter,
            permit,
            ..
        } = snapshot;

        drain_registry_subscription(
            receiver,
            filter,
            watermark,
            data_tx,
            fatal_tx,
            cancel.clone(),
        )
        .await;

        assert_eq!(
            fatal_rx.recv().await,
            Some(RegistrySubscriptionFatal::BroadcastLag)
        );
        assert!(cancel.is_cancelled());
        assert_eq!(store.stats().active_subscriptions, 1);
        drop(permit);
        assert_eq!(store.stats().active_subscriptions, 0);
    }

    #[tokio::test]
    async fn drain_reports_matching_queue_full_and_exits_without_blocking_writer() {
        let store = store_with_capacities(16, 1);
        let snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        let (data_tx, _data_rx) = mpsc::channel(1);
        let capacity_probe = data_tx.clone();
        let (fatal_tx, mut fatal_rx) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let RegistrySubscriptionSnapshot {
            receiver,
            watermark,
            filter,
            permit,
            ..
        } = snapshot;
        let join = tokio::spawn(drain_registry_subscription(
            receiver,
            filter,
            watermark,
            data_tx,
            fatal_tx,
            cancel.clone(),
        ));

        write(&store, "robot.a", 1);
        while capacity_probe.capacity() != 0 {
            tokio::task::yield_now().await;
        }
        write(&store, "robot.a", 2);

        assert_eq!(
            fatal_rx.recv().await,
            Some(RegistrySubscriptionFatal::SlowConsumer)
        );
        join.await.unwrap();
        assert!(cancel.is_cancelled());
        drop(permit);
        assert_eq!(store.stats().active_subscriptions, 0);
    }

    #[tokio::test]
    async fn drain_filters_unrelated_changes_before_the_data_queue() {
        let store = store_with_capacities(32, 1);
        let snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.match"]))
            .unwrap();
        let (data_tx, mut data_rx) = mpsc::channel(1);
        let (fatal_tx, mut fatal_rx) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let RegistrySubscriptionSnapshot {
            receiver,
            watermark,
            filter,
            permit,
            ..
        } = snapshot;
        let join = tokio::spawn(drain_registry_subscription(
            receiver,
            filter,
            watermark,
            data_tx,
            fatal_tx,
            cancel.clone(),
        ));

        for index in 0..20 {
            write(&store, "other.topic", index);
        }
        write(&store, "robot.match", 21);
        let change = data_rx.recv().await.unwrap();
        assert_eq!(change.topic(), "robot.match");
        assert!(fatal_rx.try_recv().is_err());

        cancel.cancel();
        join.await.unwrap();
        drop(permit);
        assert_eq!(store.stats().active_subscriptions, 0);
    }

    #[derive(Clone, Copy)]
    enum ControlledSinkMode {
        Ready,
        BlockFirstSend,
        BlockedGate,
        BlockSnapshotEndFlush,
    }

    struct ControlledSinkState {
        mode: ControlledSinkMode,
        ready_polls: AtomicUsize,
        blocked: AtomicBool,
        blocked_waker: futures_util::task::AtomicWaker,
        first_send_polled: tokio::sync::Notify,
        snapshot_end_sent: tokio::sync::Notify,
        change_sent: tokio::sync::Notify,
        sent: Mutex<Vec<WsMessage>>,
    }

    #[derive(Clone)]
    struct ControlledSink {
        state: Arc<ControlledSinkState>,
    }

    impl ControlledSink {
        fn new(mode: ControlledSinkMode) -> (Self, Arc<ControlledSinkState>) {
            let state = Arc::new(ControlledSinkState {
                mode,
                ready_polls: AtomicUsize::new(0),
                blocked: AtomicBool::new(matches!(mode, ControlledSinkMode::BlockedGate)),
                blocked_waker: futures_util::task::AtomicWaker::new(),
                first_send_polled: tokio::sync::Notify::new(),
                snapshot_end_sent: tokio::sync::Notify::new(),
                change_sent: tokio::sync::Notify::new(),
                sent: Mutex::new(Vec::new()),
            });
            (
                Self {
                    state: Arc::clone(&state),
                },
                state,
            )
        }

        fn unblock(&self) {
            self.state.blocked.store(false, Ordering::SeqCst);
            self.state.blocked_waker.wake();
        }
    }

    impl Sink<WsMessage> for ControlledSink {
        type Error = Infallible;

        fn poll_ready(
            self: Pin<&mut Self>,
            context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            let poll = self.state.ready_polls.fetch_add(1, Ordering::SeqCst);
            if poll == 0 {
                self.state.first_send_polled.notify_one();
            }
            if matches!(self.state.mode, ControlledSinkMode::BlockedGate)
                && self.state.blocked.load(Ordering::SeqCst)
            {
                self.state.blocked_waker.register(context.waker());
                return Poll::Pending;
            }
            if matches!(self.state.mode, ControlledSinkMode::BlockFirstSend) && poll == 0 {
                Poll::Pending
            } else {
                Poll::Ready(Ok(()))
            }
        }

        fn start_send(self: Pin<&mut Self>, item: WsMessage) -> Result<(), Self::Error> {
            if let WsMessage::Text(text) = &item {
                if serde_json::from_str::<Value>(text)
                    .ok()
                    .and_then(|body| body.get("op").and_then(Value::as_str).map(str::to_owned))
                    .as_deref()
                    == Some("snapshot_end")
                {
                    if matches!(self.state.mode, ControlledSinkMode::BlockSnapshotEndFlush) {
                        self.state.blocked.store(true, Ordering::SeqCst);
                    }
                    self.state.snapshot_end_sent.notify_one();
                }
                if serde_json::from_str::<Value>(text)
                    .ok()
                    .and_then(|body| body.get("op").and_then(Value::as_str).map(str::to_owned))
                    .as_deref()
                    == Some("change")
                {
                    self.state.change_sent.notify_one();
                }
            }
            self.state.sent.lock().unwrap().push(item);
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            if self.state.blocked.load(Ordering::SeqCst) {
                self.state.blocked_waker.register(context.waker());
                Poll::Pending
            } else {
                Poll::Ready(Ok(()))
            }
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn registry_ws_worker_failure_sends_error_then_internal_error_close() {
        for (failure, expected_code, expected_close) in [
            (
                RegistryWsWorkerFailure::Internal,
                "internal_error",
                close_code::ERROR,
            ),
            (
                RegistryWsWorkerFailure::Limit,
                "registry_worker_limit",
                close_code::AGAIN,
            ),
        ] {
            let (mut sink, state) = ControlledSink::new(ControlledSinkMode::Ready);
            send_registry_ws_worker_error_and_close(
                &mut sink,
                json!("known-id"),
                failure,
                MIN_REGISTRY_WS_MESSAGE_BYTES,
            )
            .await;

            let sent = state.sent.lock().unwrap();
            assert_eq!(sent.len(), 2);
            let WsMessage::Text(text) = &sent[0] else {
                panic!("worker failure should send a text error first");
            };
            let error: Value = serde_json::from_str(text).unwrap();
            assert_eq!(error["id"], "known-id");
            assert_eq!(error["error"]["code"], expected_code);
            assert_eq!(error["error"]["retryable"], true);
            let WsMessage::Close(Some(close)) = &sent[1] else {
                panic!("worker failure should close after the error frame");
            };
            assert_eq!(close.code, expected_close);
        }
    }

    struct PendingStream;

    impl Stream for PendingStream {
        type Item = Result<WsMessage, Infallible>;

        fn poll_next(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            Poll::Pending
        }
    }

    struct ControlledStream {
        receiver: mpsc::Receiver<Result<WsMessage, Infallible>>,
    }

    impl Stream for ControlledStream {
        type Item = Result<WsMessage, Infallible>;

        fn poll_next(
            mut self: Pin<&mut Self>,
            context: &mut Context<'_>,
        ) -> Poll<Option<Self::Item>> {
            self.receiver.poll_recv(context)
        }
    }

    fn assert_resync_and_close(
        state: &ControlledSinkState,
        max_bytes: usize,
        watermark: u64,
        reason: &str,
    ) {
        let sent = state.sent.lock().unwrap();
        let resync = sent
            .iter()
            .filter_map(|message| match message {
                WsMessage::Text(text) => serde_json::from_str::<Value>(text).ok(),
                _ => None,
            })
            .find(|body| body["op"] == "resync_required")
            .expect("owner should send best-effort resync_required");
        assert!(resync.to_string().len() <= max_bytes);
        assert_eq!(resync["last_sent_seq"], watermark);
        assert_eq!(resync["reason"], reason);
        assert!(resync.get("id").is_none());
        let close = sent
            .iter()
            .find_map(|message| match message {
                WsMessage::Close(Some(frame)) => Some(frame.code),
                _ => None,
            })
            .expect("owner should close after resync");
        assert_eq!(close, close_code::ERROR);
    }

    fn assert_slot_reusable_once(store: &RegistryStore) {
        assert_eq!(store.stats().active_subscriptions, 0);
        let replacement = store
            .begin_subscription(subscription_filter(store, &["robot.**"]))
            .unwrap();
        assert_eq!(store.stats().active_subscriptions, 1);
        drop(replacement);
        assert_eq!(store.stats().active_subscriptions, 0);
    }

    fn sent_json_bodies(state: &ControlledSinkState) -> Vec<Value> {
        state
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter_map(|message| match message {
                WsMessage::Text(text) => serde_json::from_str(text).ok(),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn snapshot_before_lock_barrier_commits_set_only_in_snapshot() {
        let store = RegistryStore::new(RegistryConfig::default()).unwrap();
        let hook_store = store.clone();
        let snapshot = store
            .begin_subscription_before_lock(subscription_filter(&store, &["robot.**"]), move || {
                write(&hook_store, "robot.before_lock", 1);
            })
            .unwrap();
        assert_eq!(snapshot.watermark, 1);
        assert_eq!(snapshot.items.len(), 1);
        let (sink, state) = ControlledSink::new(ControlledSinkMode::Ready);
        let (inbound, receiver) = mpsc::channel(1);
        let owner = tokio::spawn(run_registry_subscription_parts(
            sink,
            ControlledStream { receiver },
            store.clone(),
            Value::Null,
            snapshot,
        ));
        state.snapshot_end_sent.notified().await;
        inbound.send(Ok(WsMessage::Close(None))).await.unwrap();
        let report = owner.await.unwrap();
        assert_eq!(report.reason, None);
        assert!(report.drain_joined);
        let bodies = sent_json_bodies(&state);
        assert_eq!(
            bodies.iter().filter(|body| body["op"] == "change").count(),
            0
        );
        let items = bodies
            .iter()
            .find(|body| body["op"] == "snapshot_chunk")
            .unwrap()["items"]
            .as_array()
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["topic"], "robot.before_lock");
        assert_slot_reusable_once(&store);
    }

    #[tokio::test]
    async fn snapshot_obtained_before_send_queues_delete_exactly_once_after_end() {
        let store = RegistryStore::new(RegistryConfig::default()).unwrap();
        write(&store, "robot.deleted", 1);
        let snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        let watermark = snapshot.watermark;
        let deleted = store
            .delete(RegistryWriterKind::MainAgent, "main_agent", "robot.deleted")
            .unwrap();
        assert_eq!(deleted.seq, Some(watermark + 1));
        let (sink, state) = ControlledSink::new(ControlledSinkMode::Ready);
        let (inbound, receiver) = mpsc::channel(1);
        let owner = tokio::spawn(run_registry_subscription_parts(
            sink,
            ControlledStream { receiver },
            store.clone(),
            Value::Null,
            snapshot,
        ));
        state.change_sent.notified().await;
        inbound.send(Ok(WsMessage::Close(None))).await.unwrap();
        let report = owner.await.unwrap();
        assert_eq!(report.reason, None);
        let bodies = sent_json_bodies(&state);
        let end_index = bodies
            .iter()
            .position(|body| body["op"] == "snapshot_end")
            .unwrap();
        let changes = bodies
            .iter()
            .enumerate()
            .filter(|(_, body)| body["op"] == "change")
            .collect::<Vec<_>>();
        assert_eq!(changes.len(), 1);
        assert!(changes[0].0 > end_index);
        assert_eq!(changes[0].1["change"], "delete");
        assert_eq!(changes[0].1["seq"], watermark + 1);
        assert_slot_reusable_once(&store);
    }

    #[tokio::test]
    async fn snapshot_end_flush_barrier_queues_expire_exactly_once_after_end() {
        let store = RegistryStore::new(RegistryConfig::default()).unwrap();
        let written_at = SystemTime::now();
        store
            .set_at(
                RegistryWriterKind::MainAgent,
                "main_agent",
                RegistrySetRequest::new("robot.expiring", json!(1), "test")
                    .with_ttl(RegistryTtl::Seconds(60.0)),
                written_at,
            )
            .unwrap();
        let snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        let watermark = snapshot.watermark;
        let (sink, state) = ControlledSink::new(ControlledSinkMode::BlockSnapshotEndFlush);
        let sink_control = ControlledSink {
            state: Arc::clone(&state),
        };
        let (inbound, receiver) = mpsc::channel(1);
        let owner = tokio::spawn(run_registry_subscription_parts(
            sink,
            ControlledStream { receiver },
            store.clone(),
            Value::Null,
            snapshot,
        ));
        state.snapshot_end_sent.notified().await;
        store
            .get_at(
                RegistryQuery::new("robot.expiring"),
                written_at + Duration::from_secs(61),
            )
            .unwrap();
        sink_control.unblock();
        state.change_sent.notified().await;
        inbound.send(Ok(WsMessage::Close(None))).await.unwrap();
        let report = owner.await.unwrap();
        assert_eq!(report.reason, None);
        let bodies = sent_json_bodies(&state);
        let end_index = bodies
            .iter()
            .position(|body| body["op"] == "snapshot_end")
            .unwrap();
        let changes = bodies
            .iter()
            .enumerate()
            .filter(|(_, body)| body["op"] == "change")
            .collect::<Vec<_>>();
        assert_eq!(changes.len(), 1);
        assert!(changes[0].0 > end_index);
        assert_eq!(changes[0].1["change"], "expire");
        assert_eq!(changes[0].1["seq"], watermark + 1);
        assert_slot_reusable_once(&store);
    }

    #[tokio::test]
    async fn owner_global_lag_resyncs_cancels_joins_and_releases_once() {
        let store = store_with_capacities(2, 8);
        let snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        let watermark = snapshot.watermark;
        assert_eq!(
            store.options().subscription_send_timeout,
            Duration::from_millis(10)
        );
        write(&store, "robot.a", 1);
        write(&store, "robot.a", 2);
        write(&store, "robot.a", 3);
        let (sink, state) = ControlledSink::new(ControlledSinkMode::Ready);

        let report = run_registry_subscription_parts(
            sink,
            PendingStream,
            store.clone(),
            Value::Null,
            snapshot,
        )
        .await;

        assert_eq!(report.reason, Some("broadcast_lag"));
        assert!(report.cancellation_observed);
        assert!(report.drain_joined);
        assert_eq!(store.stats().slow_subscription_closed_total, 1);
        assert_resync_and_close(
            &state,
            store.config().max_response_bytes,
            watermark,
            "broadcast_lag",
        );
        assert_slot_reusable_once(&store);
    }

    #[tokio::test]
    async fn owner_matching_queue_full_resyncs_without_blocking_writer_and_releases_once() {
        let store = store_with_capacities(16, 1);
        let snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        let watermark = snapshot.watermark;
        let (sink, state) = ControlledSink::new(ControlledSinkMode::BlockFirstSend);
        let owner = tokio::spawn(run_registry_subscription_parts(
            sink,
            PendingStream,
            store.clone(),
            Value::Null,
            snapshot,
        ));
        state.first_send_polled.notified().await;

        write(&store, "robot.a", 1);
        write(&store, "robot.a", 2);
        let report = owner.await.unwrap();

        assert_eq!(report.reason, Some("slow_consumer"));
        assert!(report.cancellation_observed);
        assert!(report.drain_joined);
        assert_eq!(store.stats().slow_subscription_closed_total, 1);
        assert_resync_and_close(
            &state,
            store.config().max_response_bytes,
            watermark,
            "slow_consumer",
        );
        assert_slot_reusable_once(&store);
    }

    #[tokio::test(start_paused = true)]
    async fn owner_send_deadline_resyncs_cancels_joins_and_releases_once() {
        let store = store_with_capacities(16, 8);
        let snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        let watermark = snapshot.watermark;
        assert_eq!(
            store.options().subscription_send_timeout,
            Duration::from_millis(10)
        );
        let (sink, state) = ControlledSink::new(ControlledSinkMode::BlockedGate);

        let owner = tokio::spawn(run_registry_subscription_parts(
            sink,
            PendingStream,
            store.clone(),
            Value::Null,
            snapshot,
        ));
        state.first_send_polled.notified().await;
        write(&store, "robot.writer_does_not_block", 1);
        tokio::time::advance(Duration::from_millis(11)).await;
        for _ in 0..3 {
            tokio::task::yield_now().await;
            if state.ready_polls.load(Ordering::SeqCst) >= 2 {
                break;
            }
        }
        assert!(state.ready_polls.load(Ordering::SeqCst) >= 2);
        ControlledSink {
            state: Arc::clone(&state),
        }
        .unblock();
        tokio::task::yield_now().await;
        assert!(
            owner.is_finished(),
            "owner must finish after its send deadline; ready_polls={}, sent={}",
            state.ready_polls.load(Ordering::SeqCst),
            state.sent.lock().unwrap().len()
        );
        let report = owner.await.unwrap();

        assert_eq!(report.reason, Some("send_timeout"));
        assert!(report.cancellation_observed);
        assert!(report.drain_joined);
        assert_eq!(store.stats().slow_subscription_closed_total, 1);
        assert_resync_and_close(
            &state,
            store.config().max_response_bytes,
            watermark,
            "send_timeout",
        );
        assert_slot_reusable_once(&store);
    }

    #[tokio::test]
    async fn owner_snapshot_oversize_closes_and_releases_permit_once() {
        let store = RegistryStore::new(RegistryConfig {
            max_response_bytes: 360,
            max_value_bytes: 2048,
            ..RegistryConfig::default()
        })
        .unwrap();
        store
            .set(
                RegistryWriterKind::MainAgent,
                "main_agent",
                RegistrySetRequest::new("robot.large", json!({"payload": "x".repeat(500)}), "test")
                    .with_ttl(RegistryTtl::Null),
            )
            .unwrap();
        let snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        let (sink, state) = ControlledSink::new(ControlledSinkMode::Ready);
        let report = run_registry_subscription_parts(
            sink,
            PendingStream,
            store.clone(),
            Value::Null,
            snapshot,
        )
        .await;
        assert_eq!(report.reason, None);
        assert!(report.cancellation_observed);
        assert!(report.drain_joined);
        assert_eq!(store.stats().slow_subscription_closed_total, 0);
        let sent = state.sent.lock().unwrap();
        assert!(sent.iter().any(|message| matches!(message, WsMessage::Close(Some(frame)) if frame.code == close_code::ERROR)));
        drop(sent);
        assert_slot_reusable_once(&store);
    }

    #[tokio::test]
    async fn owner_change_oversize_closes_and_releases_permit_once() {
        let store = RegistryStore::new(RegistryConfig {
            max_response_bytes: 360,
            max_value_bytes: 2048,
            ..RegistryConfig::default()
        })
        .unwrap();
        let snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        let (sink, state) = ControlledSink::new(ControlledSinkMode::Ready);
        let owner = tokio::spawn(run_registry_subscription_parts(
            sink,
            PendingStream,
            store.clone(),
            Value::Null,
            snapshot,
        ));
        state.snapshot_end_sent.notified().await;
        store
            .set(
                RegistryWriterKind::MainAgent,
                "main_agent",
                RegistrySetRequest::new("robot.large", json!({"payload": "x".repeat(500)}), "test")
                    .with_ttl(RegistryTtl::Null),
            )
            .unwrap();
        let report = owner.await.unwrap();
        assert_eq!(report.reason, None);
        assert!(report.cancellation_observed);
        assert!(report.drain_joined);
        assert_eq!(store.stats().slow_subscription_closed_total, 0);
        assert_slot_reusable_once(&store);
    }

    struct PendingSink;

    impl Sink<WsMessage> for PendingSink {
        type Error = Infallible;

        fn poll_ready(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }

        fn start_send(self: Pin<&mut Self>, _item: WsMessage) -> Result<(), Self::Error> {
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test(start_paused = true)]
    async fn outbound_send_deadline_times_out_a_blocked_sink() {
        let result = timed_ws_send(
            &mut PendingSink,
            WsMessage::Text("blocked".to_owned()),
            Duration::from_millis(10),
        )
        .await;
        assert_eq!(result, Err(TimedWsSendError::Timeout));
    }
}
