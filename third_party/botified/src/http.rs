use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::multipart::{MultipartError, MultipartRejection};
use axum::extract::rejection::BytesRejection;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, FromRequest, Path as AxumPath, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::agent_loop::InputUrgency;
use crate::attachments::{parse_user_input, AttachmentError, ParsedUserInput, PublicInputItem};
use crate::event::EventCursor;
use crate::files::{
    FileRecord, FileStore, FileStoreError, FileStoreErrorKind, DEFAULT_MAX_UPLOAD_REQUEST_BYTES,
};
use crate::registry::{
    RegistryError, RegistryHistoryResult, RegistryItem, RegistryQueryResult, RegistryStore,
};
use crate::service::{
    summarize_input_content, EnqueueSubmitStatus, Service, ServiceError, ServiceState,
};
use crate::timeline_store::TimelineStoreError;
use crate::types::{ContentPart, MessageFileBinding};

mod delivery;
mod files;
mod registry_http;
mod registry_ws;
mod timeline;

use delivery::{delivery_from_body, validate_delivery_key};

pub const MAX_HTTP_JSON_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_HTTP_MESSAGE_REQUESTS: usize = 4;
pub const MAX_HTTP_SERVICE_MUTATIONS: usize = 4;
pub const MAX_HTTP_LLM_TEXT_PREVIEW_SUBSCRIPTIONS: usize = 64;
pub const MAX_HTTP_TIMELINE_FOLLOW_CONNECTIONS: usize = 32;
pub const MAX_HTTP_TIMELINE_BLOCKING_TASKS: usize = 4;
pub const MAX_HTTP_REGISTRY_WS_CONTROL_CONNECTIONS: usize = 32;
pub const MAX_HTTP_REGISTRY_BLOCKING_TASKS: usize = 4;
const HTTP_JSON_BODY_READ_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const HTTP_UPLOAD_BODY_READ_TIMEOUT: Duration = Duration::from_secs(300);
const HISTORY_BOUNDARY_HEADER: &str = "x-botified-history-boundary";
const AGENT_MEDIATED_TASK_REPLY_MESSAGE: &str =
    "task asks are agent-mediated; use normal chat so the agent can call task_reply(task_id, ask_id, message)";
const RESERVED_CLIENT_MESSAGE_ID_PREFIXES: [&str; 5] = [
    "task_callback_",
    "task_ask_",
    "task_reply_",
    "subagent_callback_",
    "botified_",
];
static NEXT_AUTO_MESSAGE_ID_PREFIX: AtomicU64 = AtomicU64::new(1);

#[cfg(test)]
std::thread_local! {
    static REGISTRY_SERIALIZATION_COUNTS: std::cell::Cell<(usize, usize)> =
        const { std::cell::Cell::new((0, 0)) };
}

#[derive(Clone)]
struct HttpState {
    service: Service,
    service_key: Option<String>,
    file_store: Option<FileStore>,
    terminal: Option<TerminalConfig>,
    auto_message_id_prefix: String,
    next_message_id: Arc<AtomicU64>,
    message_request_slots: Arc<Semaphore>,
    service_mutation_slots: Arc<Semaphore>,
    file_upload_slots: Arc<Semaphore>,
    file_download_slots: Arc<Semaphore>,
    llm_text_preview_slots: Arc<Semaphore>,
    timeline_follow_slots: Arc<Semaphore>,
    timeline_blocking_slots: Arc<Semaphore>,
    registry_ws_connection_slots: Option<Arc<Semaphore>>,
    registry_blocking_slots: Option<Arc<Semaphore>>,
}

impl HttpState {
    fn new(
        service: Service,
        service_key: Option<String>,
        terminal: Option<TerminalConfig>,
    ) -> Self {
        let file_store = service.file_store();
        let registry_ws_connection_slots = service.registry_store().map(|store| {
            let capacity = store
                .config()
                .max_subscriptions
                .saturating_add(MAX_HTTP_REGISTRY_WS_CONTROL_CONNECTIONS)
                .min(Semaphore::MAX_PERMITS);
            Arc::new(Semaphore::new(capacity))
        });
        let registry_blocking_slots = service
            .registry_store()
            .map(|_| Arc::new(Semaphore::new(MAX_HTTP_REGISTRY_BLOCKING_TASKS)));
        Self {
            service,
            service_key,
            file_store,
            terminal,
            auto_message_id_prefix: new_auto_message_id_prefix(),
            next_message_id: Arc::new(AtomicU64::new(1)),
            message_request_slots: Arc::new(Semaphore::new(MAX_HTTP_MESSAGE_REQUESTS)),
            service_mutation_slots: Arc::new(Semaphore::new(MAX_HTTP_SERVICE_MUTATIONS)),
            file_upload_slots: Arc::new(Semaphore::new(1)),
            file_download_slots: Arc::new(Semaphore::new(2)),
            llm_text_preview_slots: Arc::new(Semaphore::new(
                MAX_HTTP_LLM_TEXT_PREVIEW_SUBSCRIPTIONS,
            )),
            timeline_follow_slots: Arc::new(Semaphore::new(MAX_HTTP_TIMELINE_FOLLOW_CONNECTIONS)),
            timeline_blocking_slots: Arc::new(Semaphore::new(MAX_HTTP_TIMELINE_BLOCKING_TASKS)),
            registry_ws_connection_slots,
            registry_blocking_slots,
        }
    }

    fn next_message_id(&self) -> String {
        let id = self.next_message_id.fetch_add(1, Ordering::SeqCst);
        format!("msg_{}_{}", self.auto_message_id_prefix, id)
    }
}

#[derive(Debug, Clone)]
pub struct TerminalConfig {
    pub executor_addr: std::net::SocketAddr,
    pub cwd: String,
}

fn new_auto_message_id_prefix() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let process = std::process::id();
    let sequence = NEXT_AUTO_MESSAGE_ID_PREFIX.fetch_add(1, Ordering::SeqCst);
    format!("{stamp:x}_{process:x}_{sequence:x}")
}

pub fn router(service: Service, service_key: Option<String>) -> Router {
    router_with_optional_terminal(service, service_key, None)
}

pub fn router_with_terminal(
    service: Service,
    service_key: Option<String>,
    terminal: TerminalConfig,
) -> Router {
    router_with_optional_terminal(service, service_key, Some(terminal))
}

fn router_with_optional_terminal(
    service: Service,
    service_key: Option<String>,
    terminal: Option<TerminalConfig>,
) -> Router {
    let max_upload_request_bytes = service
        .file_store()
        .map(|file_store| file_store.options().max_upload_request_bytes)
        .unwrap_or(DEFAULT_MAX_UPLOAD_REQUEST_BYTES);
    let state = HttpState::new(service, service_key, terminal);
    build_router(state, max_upload_request_bytes)
}

fn build_router(state: HttpState, max_upload_request_bytes: u64) -> Router {
    let files_upload_limit = usize::try_from(max_upload_request_bytes).unwrap_or(usize::MAX);
    let registry_enabled = state.service.registry_store().is_some();
    let mut protected = Router::new()
        .route("/v1/state", get(state_handler))
        .route(
            "/v1/messages",
            post(messages_handler).layer(DefaultBodyLimit::max(MAX_HTTP_JSON_BYTES)),
        )
        .route(
            "/v1/deliveries/:delivery_key",
            get(delivery_receipt_handler),
        )
        .route(
            "/v1/files",
            post(files::upload_files_handler).layer(DefaultBodyLimit::max(files_upload_limit)),
        )
        .route("/v1/files/:file_id", get(files::download_file_handler))
        .route("/v1/timeline", get(timeline::timeline_handler))
        .route(
            "/v1/llm-text-preview",
            get(timeline::llm_text_preview_handler),
        )
        .route("/v1/abort", post(abort_handler))
        .route(
            "/v1/background-tasks/:task_id/stop",
            post(stop_background_task_handler),
        )
        .route("/v1/task-presets", get(task_presets_handler))
        .route(
            "/v1/task-presets/:preset_id/start",
            post(task_preset_start_handler).layer(DefaultBodyLimit::max(MAX_HTTP_JSON_BYTES)),
        );

    if state.terminal.is_some() {
        protected = protected.route("/v1/terminal/ws", get(terminal_ws_handler));
    }

    if registry_enabled {
        protected = protected
            .route("/v1/registry/ws", get(registry_ws::registry_ws_handler))
            .route(
                "/v1/registry/current",
                get(registry_http::registry_current_handler),
            )
            .route(
                "/v1/registry/history",
                get(registry_http::registry_history_handler),
            )
            .route(
                "/v1/registry/topics",
                get(registry_http::registry_topics_handler),
            );
    }

    let protected = protected.route_layer(middleware::from_fn_with_state(
        state.clone(),
        authorize_request,
    ));
    Router::new()
        .route("/healthz", get(healthz))
        .merge(protected)
        .with_state(state)
}

async fn terminal_ws_handler(
    State(state): State<HttpState>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let terminal = state
        .terminal
        .clone()
        .ok_or_else(ApiError::terminal_unavailable)?;
    Ok(ws
        .on_upgrade(move |socket| terminal_websocket(socket, terminal))
        .into_response())
}

async fn terminal_websocket(socket: WebSocket, terminal: TerminalConfig) {
    let executor = match TcpStream::connect(terminal.executor_addr).await {
        Ok(stream) => stream,
        Err(_) => {
            let (mut sender, _) = socket.split();
            let _ = sender
                .send(WsMessage::Text(
                    json!({"op": "error", "message": "Task terminal is unavailable"}).to_string(),
                ))
                .await;
            return;
        }
    };
    let (executor_reader, mut executor_writer) = executor.into_split();
    let execute = json!({
        "op": "execute",
        "mode": "terminal",
        "command": "exec bash -il",
        "cwd": terminal.cwd,
        "interactive_stdio": true,
    })
    .to_string();
    if executor_writer
        .write_all(format!("{execute}\n").as_bytes())
        .await
        .is_err()
    {
        return;
    }

    let (mut ws_sender, mut ws_receiver) = socket.split();
    if ws_sender
        .send(WsMessage::Text(json!({"op": "ready"}).to_string()))
        .await
        .is_err()
    {
        let _ = executor_writer.write_all(b"{\"op\":\"cancel\"}\n").await;
        return;
    }
    let output = async {
        let mut lines = BufReader::new(executor_reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if ws_sender.send(WsMessage::Text(line)).await.is_err() {
                break;
            }
        }
    };
    let input = async {
        while let Some(Ok(message)) = ws_receiver.next().await {
            match message {
                WsMessage::Text(text) => {
                    if executor_writer.write_all(text.as_bytes()).await.is_err()
                        || executor_writer.write_all(b"\n").await.is_err()
                    {
                        break;
                    }
                }
                WsMessage::Close(_) => break,
                _ => {}
            }
        }
    };
    tokio::select! {
        _ = output => {}
        _ = input => {}
    }
    let _ = executor_writer.write_all(b"{\"op\":\"cancel\"}\n").await;
}

async fn healthz() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn authorize_request(
    State(state): State<HttpState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    authorize(request.headers(), state.service_key.as_deref())?;
    Ok(next.run(request).await)
}

async fn state_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let service = state.service.clone();
    let snapshot = run_timeline_blocking_task(
        state.timeline_blocking_slots.clone(),
        "timeline state snapshot",
        move || service.timeline_bootstrap_snapshot(),
    )
    .await?;
    Ok(Json(snapshot))
}

async fn run_timeline_blocking_task<T: Send + 'static>(
    slots: Arc<Semaphore>,
    operation: &'static str,
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ApiError> {
    let permit = slots
        .try_acquire_owned()
        .map_err(|_| ApiError::timeline_worker_limit())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        task()
    })
    .await
    .map_err(|_| ApiError::timeline_worker_failed(operation))
}

async fn run_service_mutation_blocking_task<T: Send + 'static>(
    slots: Arc<Semaphore>,
    operation: &'static str,
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ApiError> {
    let permit = slots
        .try_acquire_owned()
        .map_err(|_| ApiError::service_mutation_worker_limit())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        task()
    })
    .await
    .map_err(|_| ApiError::service_mutation_worker_failed(operation))
}

async fn run_message_blocking_task<T: Send + 'static>(
    request_permit: Arc<OwnedSemaphorePermit>,
    operation: &'static str,
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(move || {
        let _request_permit = request_permit;
        task()
    })
    .await
    .map_err(|_| ApiError::message_worker_failed(operation))
}

async fn messages_handler(
    State(state): State<HttpState>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    authorize(request.headers(), state.service_key.as_deref())?;
    require_message_json_content_type(request.headers())?;
    let request_permit = Arc::new(
        state
            .message_request_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::message_request_limit())?,
    );

    let body = read_bytes_body_with_timeout(request, &state, HTTP_JSON_BODY_READ_TIMEOUT).await?;
    let body = parse_json_body(body)?;
    let delivery = delivery_from_body(&body)?;
    if delivery.is_none() && is_slash_command_body(&body) {
        let service = state.service.clone();
        let runtime = tokio::runtime::Handle::current();
        let slash_response =
            run_message_blocking_task(request_permit.clone(), "message slash command", move || {
                let _runtime = runtime.enter();
                slash_command_response(&service, &body)
                    .expect("slash command body should produce a response")
            })
            .await?;
        return Ok(Json(slash_response));
    }

    let client_message_id = message_id_from_body(&body)?;
    if let (Some(delivery), Some(client_message_id)) =
        (delivery.as_ref(), client_message_id.as_ref())
    {
        if delivery.delivery_key != *client_message_id {
            return Err(ApiError::invalid_request(
                "client_message_id must equal delivery_key when delivery_key is supplied",
            ));
        }
    }
    let message_id = delivery
        .as_ref()
        .map(|value| value.delivery_key.clone())
        .or(client_message_id)
        .unwrap_or_else(|| state.next_message_id());
    let urgency_result = input_urgency_from_body(&body);
    let input = parse_user_input(body).map_err(ApiError::from_attachment)?;
    let content =
        bind_user_input_content(&state, &message_id, input, request_permit.clone()).await?;
    let urgency = match urgency_result {
        Ok(urgency) => urgency,
        Err(message) => {
            let service = state.service.clone();
            let rejected_message_id = message_id.clone();
            let rejection_message = message.clone();
            let timeline_cursor =
                run_message_blocking_task(request_permit.clone(), "message rejection", move || {
                    service.reject_user_message(
                        &rejected_message_id,
                        &content,
                        "invalid_urgency",
                        rejection_message,
                        false,
                    )
                })
                .await?;
            return Err(ApiError::invalid_request(message)
                .with_timeline_cursor(timeline_cursor.map(|cursor| cursor.to_string())));
        }
    };
    let content_summary = summarize_input_content(&content);
    let service = state.service.clone();
    let enqueue_message_id = message_id.clone();
    let cursor_message_id = message_id.clone();
    let enqueue_delivery = delivery.clone();
    let runtime = tokio::runtime::Handle::current();
    let outcome = run_message_blocking_task(request_permit.clone(), "message enqueue", move || {
        let before_enqueue_cursor = service.current_event_cursor();
        let enqueue = match enqueue_delivery {
            Some(delivery) => runtime.block_on(service.enqueue_delivery(
                delivery.delivery_key,
                delivery.request_hash,
                content,
                urgency,
            )),
            None => {
                runtime.block_on(service.enqueue_with_urgency(enqueue_message_id, content, urgency))
            }
        };
        match enqueue {
            Ok(outcome) => Ok(outcome),
            Err(error) => {
                let timeline_cursor = append_safe_rejection_cursor(
                    &service,
                    &before_enqueue_cursor,
                    &cursor_message_id,
                );
                Err((error, timeline_cursor))
            }
        }
    })
    .await?;
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err((error, timeline_cursor)) => {
            return Err(ApiError::from_service(error).with_timeline_cursor(timeline_cursor));
        }
    };

    let response = MessageResponse {
        ok: true,
        kind: if delivery.is_some() && outcome.submit_status == EnqueueSubmitStatus::Duplicate {
            "idempotent"
        } else {
            message_response_kind(outcome.submit_status)
        },
        input_id: message_id.clone(),
        message_id,
        timeline_cursor: outcome.cursor.to_string(),
        content_preview: content_summary.content_preview,
        content_bytes: content_summary.content_bytes,
        content_truncated: content_summary.content_truncated,
        content_kind: content_summary.content_kind,
        queue_length: outcome.service_status.queue_length,
        state: outcome.service_status.state,
        delivery_key: delivery.as_ref().map(|value| value.delivery_key.clone()),
        request_hash: delivery.as_ref().map(|value| value.request_hash.clone()),
    };
    Ok(Json(json!(response)))
}

async fn delivery_receipt_handler(
    State(state): State<HttpState>,
    AxumPath(delivery_key): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    validate_delivery_key(&delivery_key)?;
    match state.service.delivery_receipt(&delivery_key) {
        Some(receipt) => Ok(Json(json!({
            "ok": true,
            "found": true,
            "delivery_key": receipt.delivery_key,
            "request_hash": receipt.request_hash,
            "message_id": receipt.message_id,
            "timeline_cursor": receipt.cursor.to_string(),
        }))),
        None => Ok(Json(json!({"ok": true, "found": false}))),
    }
}

async fn bind_user_input_content(
    state: &HttpState,
    message_id: &str,
    input: ParsedUserInput,
    request_permit: Arc<OwnedSemaphorePermit>,
) -> Result<Vec<ContentPart>, ApiError> {
    if !input.contains_file_refs() {
        return input
            .into_unbound_content()
            .map_err(ApiError::from_attachment);
    }

    let store = state
        .file_store
        .as_ref()
        .ok_or_else(ApiError::file_store_unavailable)?;
    let store = store.clone();
    let message_id = message_id.to_owned();
    run_file_store_task("message file binding", move || {
        let _request_permit = request_permit;
        bind_file_refs(&message_id, input, &store)
    })
    .await?
}

async fn run_file_store_task<T: Send + 'static>(
    operation: &'static str,
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| ApiError::from_file_worker_join(operation, error))
}

fn bind_file_refs(
    message_id: &str,
    input: ParsedUserInput,
    store: &FileStore,
) -> Result<Vec<ContentPart>, ApiError> {
    let mut file_count = 0usize;
    let mut referenced_bytes = 0u64;
    let mut content = Vec::with_capacity(input.items.len());
    let mut verified_records: HashMap<String, FileRecord> = HashMap::new();
    let mut distinct_file_ids = Vec::new();

    for item in input.items {
        match item {
            PublicInputItem::Text { text } => content.push(ContentPart::text(text)),
            PublicInputItem::Skill {
                name,
                path,
                arguments,
            } => content.push(ContentPart::Skill {
                name,
                path,
                arguments,
            }),
            PublicInputItem::File { file_id } => {
                file_count += 1;
                if file_count > store.options().max_message_files {
                    return Err(ApiError::too_many_file_refs());
                }
                let record = if let Some(record) = verified_records.get(&file_id) {
                    record.clone()
                } else {
                    let record = store
                        .verify_file(&file_id)
                        .map_err(ApiError::from_message_file_store)?;
                    distinct_file_ids.push(record.file_id.clone());
                    verified_records.insert(file_id, record.clone());
                    record
                };
                referenced_bytes = referenced_bytes.saturating_add(record.size_bytes);
                if referenced_bytes > store.options().max_message_referenced_file_bytes {
                    return Err(ApiError::referenced_files_too_large());
                }
                let content_index = content.len();
                content.push(ContentPart::file(MessageFileBinding::available(
                    message_id,
                    message_id,
                    content_index,
                    record.file_id,
                    record.filename,
                    record.mime_type,
                    record.size_bytes,
                    record.sha256,
                    record.source,
                    record.description,
                    Some(record.agent_path.display().to_string()),
                )));
            }
        }
    }

    store
        .touch_many(&distinct_file_ids)
        .map_err(ApiError::from_message_file_store)?;

    Ok(content)
}

async fn abort_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<AbortResponse>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let service = state.service.clone();
    let runtime = tokio::runtime::Handle::current();
    let status = run_service_mutation_blocking_task(
        state.service_mutation_slots.clone(),
        "service abort",
        move || {
            let before_abort_seq = service.current_event_cursor().seq();
            let mut status = runtime.block_on(service.abort());
            let abort_was_requested = service
                .events_after(before_abort_seq)
                .iter()
                .any(|event| event.event_type == "agent.abort_requested");
            if abort_was_requested && status.state == ServiceState::Idle {
                status.state = ServiceState::Aborting;
            }
            status
        },
    )
    .await?;

    Ok(Json(AbortResponse {
        ok: true,
        queue_length: status.queue_length,
        state: status.state,
    }))
}

async fn stop_background_task_handler(
    State(state): State<HttpState>,
    AxumPath(task_id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let service = state.service.clone();
    let result = run_service_mutation_blocking_task(
        state.service_mutation_slots.clone(),
        "background task stop",
        move || service.cancel_background_task(&task_id),
    )
    .await?;
    match result {
        Some(mut result) => {
            result["ok"] = json!(true);
            Ok(Json(result))
        }
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "background_task_not_found",
            "background task was not found",
            false,
        )),
    }
}

async fn task_presets_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    Ok(Json(state.service.task_preset_list()))
}

async fn task_preset_start_handler(
    State(state): State<HttpState>,
    AxumPath(preset_id): AxumPath<String>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    authorize(request.headers(), state.service_key.as_deref())?;
    let body = read_bytes_body_with_timeout(request, &state, HTTP_JSON_BODY_READ_TIMEOUT).await?;
    parse_empty_task_preset_start_body(body)?;
    let service = state.service.clone();
    let runtime = tokio::runtime::Handle::current();
    let result = run_service_mutation_blocking_task(
        state.service_mutation_slots.clone(),
        "task preset start",
        move || runtime.block_on(async move { service.task_preset_start(&preset_id) }),
    )
    .await?;
    if result.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(Json(result));
    }
    let code = result
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("task_preset_start_failed");
    let status = if code == "preset_not_found" {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::BAD_REQUEST
    };
    Err(ApiError::new(
        status,
        task_preset_start_error_code(code),
        result
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("task preset start failed"),
        false,
    ))
}

fn registry_store_from_state(state: &HttpState) -> Result<RegistryStore, ApiError> {
    state.service.registry_store().ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "registry endpoint is not available",
            false,
        )
    })
}

fn registry_get_response(
    result: RegistryQueryResult<RegistryItem>,
    id: Option<Value>,
    max_response_bytes: usize,
) -> Value {
    let server_time = result.server_time;
    let items = result
        .items
        .iter()
        .map(|item| current_registry_item_json(item, server_time))
        .collect::<Vec<_>>();
    let mut body = json!({
        "ok": true,
        "op": "snapshot",
        "kind": "registry_get",
        "server_time": crate::formatting::system_time_rfc3339(server_time),
        "items": items,
        "matched_count": result.matched_count,
        "returned_count": result.returned_count,
        "truncated": result.truncated,
        "truncated_reason": result.truncated_reason,
    });
    if let Some(id) = id {
        body["id"] = id;
    }
    bounded_registry_response(body, max_response_bytes, RegistryResponseTruncateSide::Back)
}

fn registry_history_response(
    result: RegistryHistoryResult,
    id: Option<Value>,
    max_response_bytes: usize,
) -> Value {
    let items = result
        .items
        .iter()
        .map(registry_item_json)
        .collect::<Vec<_>>();
    let mut body = json!({
        "ok": true,
        "op": "history",
        "kind": "registry_history",
        "server_time": crate::formatting::system_time_rfc3339(result.server_time),
        "items": items,
        "oldest_seq": result.oldest_seq,
        "newest_seq": result.newest_seq,
        "matched_count": result.matched_count,
        "returned_count": result.returned_count,
        "truncated": result.truncated,
        "truncated_reason": result.truncated_reason,
    });
    if let Some(id) = id {
        body["id"] = id;
    }
    bounded_registry_response(
        body,
        max_response_bytes,
        RegistryResponseTruncateSide::Front,
    )
}

#[derive(Debug, Clone, Copy)]
enum RegistryResponseTruncateSide {
    Front,
    Back,
}

fn bounded_registry_response(
    mut body: Value,
    max_response_bytes: usize,
    side: RegistryResponseTruncateSide,
) -> Value {
    if serialized_registry_body_len(&body) <= max_response_bytes {
        return body;
    }

    let Some(items) = body.get_mut("items").and_then(Value::as_array_mut) else {
        return compact_registry_response(body, max_response_bytes);
    };
    let mut items = std::mem::take(items);
    if items.is_empty() {
        return compact_registry_response(body, max_response_bytes);
    }

    let item_lengths = items
        .iter()
        .map(serialized_registry_item_len)
        .collect::<Vec<_>>();

    // Keep history sequence bounds unchanged while sizing non-empty results. They are
    // cleared only when truncation removes every item, matching the response contract.
    set_registry_response_truncated(&mut body, 0, false);
    let scaffold_len = serialized_registry_body_len(&body);
    let max_kept = items.len() - 1;
    let mut kept = 0;
    let mut serialized_items_len = 0usize;
    for count in 1..=max_kept {
        let index = match side {
            RegistryResponseTruncateSide::Front => item_lengths.len() - count,
            RegistryResponseTruncateSide::Back => count - 1,
        };
        serialized_items_len = serialized_items_len.saturating_add(item_lengths[index]);
        let candidate_len = scaffold_len
            .saturating_add(serialized_items_len)
            .saturating_add(count - 1)
            .saturating_add(decimal_len(count) - 1);
        if candidate_len > max_response_bytes {
            break;
        }
        kept = count;
    }

    items = match side {
        RegistryResponseTruncateSide::Front => items.split_off(items.len() - kept),
        RegistryResponseTruncateSide::Back => {
            items.truncate(kept);
            items
        }
    };
    body["items"] = Value::Array(items);
    mark_registry_response_truncated(&mut body);

    if serialized_registry_body_len(&body) <= max_response_bytes {
        return body;
    }

    compact_registry_response(body, max_response_bytes)
}

fn serialized_registry_body_len(body: &Value) -> usize {
    #[cfg(test)]
    REGISTRY_SERIALIZATION_COUNTS.with(|counts| {
        let (body_count, item_count) = counts.get();
        counts.set((body_count + 1, item_count));
    });
    serde_json::to_vec(body)
        .expect("serializing a JSON value cannot fail")
        .len()
}

fn serialized_registry_item_len(item: &Value) -> usize {
    #[cfg(test)]
    REGISTRY_SERIALIZATION_COUNTS.with(|counts| {
        let (body_count, item_count) = counts.get();
        counts.set((body_count, item_count + 1));
    });
    serde_json::to_vec(item)
        .expect("serializing a JSON value cannot fail")
        .len()
}

fn decimal_len(mut value: usize) -> usize {
    let mut len = 1;
    while value >= 10 {
        value /= 10;
        len += 1;
    }
    len
}

fn mark_registry_response_truncated(body: &mut Value) {
    let returned_count = body
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    set_registry_response_truncated(body, returned_count, returned_count == 0);
}

fn set_registry_response_truncated(body: &mut Value, returned_count: usize, clear_bounds: bool) {
    if let Value::Object(object) = body {
        object.insert("returned_count".to_owned(), json!(returned_count));
        object.insert("truncated".to_owned(), json!(true));
        object.insert("truncated_reason".to_owned(), json!("response_bytes"));
        if clear_bounds {
            if object.contains_key("oldest_seq") {
                object.insert("oldest_seq".to_owned(), Value::Null);
            }
            if object.contains_key("newest_seq") {
                object.insert("newest_seq".to_owned(), Value::Null);
            }
        }
    }
}

fn compact_registry_response(body: Value, max_response_bytes: usize) -> Value {
    let compact = if body.get("ok").and_then(Value::as_bool) == Some(false) {
        compact_registry_error_response(&body)
    } else if body.get("items").is_some() {
        compact_registry_items_response(&body)
    } else {
        compact_registry_ack_response(&body)
    };
    fit_compact_registry_response(compact, max_response_bytes)
}

fn compact_registry_items_response(body: &Value) -> Value {
    let mut compact = serde_json::Map::new();
    compact.insert("ok".to_owned(), json!(true));
    copy_json_field(body, &mut compact, "op");
    copy_json_field(body, &mut compact, "kind");
    copy_json_field(body, &mut compact, "id");
    compact.insert("items".to_owned(), json!([]));
    compact.insert(
        "matched_count".to_owned(),
        body.get("matched_count")
            .cloned()
            .unwrap_or_else(|| json!(0)),
    );
    compact.insert("returned_count".to_owned(), json!(0));
    compact.insert("truncated".to_owned(), json!(true));
    compact.insert("truncated_reason".to_owned(), json!("response_bytes"));
    if body.get("oldest_seq").is_some() {
        compact.insert("oldest_seq".to_owned(), Value::Null);
    }
    if body.get("newest_seq").is_some() {
        compact.insert("newest_seq".to_owned(), Value::Null);
    }

    Value::Object(compact)
}

fn compact_registry_ack_response(body: &Value) -> Value {
    let mut compact = serde_json::Map::new();
    compact.insert("ok".to_owned(), json!(true));
    copy_json_field(body, &mut compact, "op");
    copy_json_field(body, &mut compact, "kind");
    copy_json_field(body, &mut compact, "id");
    copy_json_field(body, &mut compact, "seq");
    copy_json_field(body, &mut compact, "writer_kind");
    compact.insert("truncated".to_owned(), json!(true));
    compact.insert("truncated_reason".to_owned(), json!("response_bytes"));
    Value::Object(compact)
}

fn compact_registry_error_response(body: &Value) -> Value {
    json!({
        "ok": false,
        "op": "error",
        "id": body.get("id").cloned().unwrap_or(Value::Null),
        "error": {
            "code": body
                .get("error")
                .and_then(|error| error.get("code"))
                .cloned()
                .unwrap_or_else(|| json!("invalid_request")),
            "message": "request rejected",
            "retryable": body
                .get("error")
                .and_then(|error| error.get("retryable"))
                .cloned()
                .unwrap_or(Value::Bool(false)),
        }
    })
}

fn fit_compact_registry_response(mut compact: Value, max_response_bytes: usize) -> Value {
    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    if compact
        .as_object()
        .is_some_and(|object| object.contains_key("id"))
    {
        if let Some(object) = compact.as_object_mut() {
            object.insert("id".to_owned(), Value::Null);
        }
        if compact.to_string().len() <= max_response_bytes {
            return compact;
        }
    }

    if let Some(object) = compact.as_object_mut() {
        object.remove("truncated_reason");
    }
    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    if let Some(object) = compact.as_object_mut() {
        object.remove("writer_kind");
        object.remove("seq");
        object.remove("matched_count");
    }
    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    if let Some(object) = compact.as_object_mut() {
        object.remove("oldest_seq");
        object.remove("newest_seq");
    }
    if compact.to_string().len() <= max_response_bytes {
        return compact;
    }

    let fallback = if compact.get("ok").and_then(Value::as_bool) == Some(false) {
        json!({
            "ok": false,
            "op": "error",
            "error": {
                "code": compact
                    .get("error")
                    .and_then(|error| error.get("code"))
                    .cloned()
                    .unwrap_or_else(|| json!("invalid_request"))
            }
        })
    } else if compact.get("items").is_some() {
        json!({
            "ok": true,
            "op": compact.get("op").cloned().unwrap_or(Value::Null),
            "items": [],
            "returned_count": 0,
            "truncated": true
        })
    } else {
        json!({
            "ok": true,
            "op": compact.get("op").cloned().unwrap_or(Value::Null),
            "kind": compact.get("kind").cloned().unwrap_or(Value::Null),
            "truncated": true
        })
    };
    if fallback.to_string().len() <= max_response_bytes {
        fallback
    } else {
        json!({})
    }
}

fn copy_json_field(body: &Value, target: &mut serde_json::Map<String, Value>, field: &str) {
    if let Some(value) = body.get(field) {
        target.insert(field.to_owned(), value.clone());
    }
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

async fn read_bytes_body_with_timeout(
    request: Request,
    state: &HttpState,
    read_timeout: Duration,
) -> Result<Bytes, ApiError> {
    tokio::time::timeout(read_timeout, Bytes::from_request(request, state))
        .await
        .map_err(|_| ApiError::request_body_timeout())?
        .map_err(ApiError::from_body_rejection)
}

fn parse_json_body(body: Bytes) -> Result<Value, ApiError> {
    if body.is_empty() {
        return Err(ApiError::invalid_request("request body must be JSON"));
    }
    serde_json::from_slice(&body).map_err(|_| ApiError::invalid_request("invalid JSON body"))
}

fn parse_empty_task_preset_start_body(body: Bytes) -> Result<(), ApiError> {
    if body.is_empty() {
        return Ok(());
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_task_preset_start_body",
            "request body must be empty or {}",
            false,
        )
    })?;
    if value.as_object().is_some_and(serde_json::Map::is_empty) {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_task_preset_start_body",
            "request body must be empty or {}",
            false,
        ))
    }
}

fn task_preset_start_error_code(code: &str) -> &'static str {
    match code {
        "preset_not_found" => "preset_not_found",
        "service_unavailable" => "service_unavailable",
        "background_task_concurrency_limit" => "background_task_concurrency_limit",
        "output_artifact_error" => "output_artifact_error",
        "interactive_stdio_unavailable" => "interactive_stdio_unavailable",
        "task_preset_start_failed" => "task_preset_start_failed",
        _ => "task_preset_start_failed",
    }
}

fn message_id_from_body(body: &Value) -> Result<Option<String>, ApiError> {
    let Some(value) = body.get("client_message_id") else {
        return Ok(None);
    };
    let Some(message_id) = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err(ApiError::invalid_request(
            "client_message_id must be a non-empty string",
        ));
    };
    if let Some(prefix) = RESERVED_CLIENT_MESSAGE_ID_PREFIXES
        .iter()
        .find(|prefix| message_id.starts_with(**prefix))
    {
        return Err(ApiError::message_conflict(format!(
            "client_message_id must not use reserved prefix {prefix}"
        )));
    }
    Ok(Some(message_id.to_owned()))
}

fn authorize(headers: &HeaderMap, service_key: Option<&str>) -> Result<(), ApiError> {
    let Some(service_key) = service_key else {
        return if headers.contains_key(header::ORIGIN) {
            Err(ApiError::origin_not_allowed())
        } else {
            Ok(())
        };
    };

    let expected = format!("Bearer {service_key}");
    let authorized = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected);

    if authorized {
        Ok(())
    } else {
        Err(ApiError {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: "missing or invalid bearer token".to_owned(),
            retryable: false,
            timeline_cursor: None,
            history_boundary: None,
        })
    }
}

fn require_message_json_content_type(headers: &HeaderMap) -> Result<(), ApiError> {
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("application/json"));
    if is_json {
        Ok(())
    } else {
        Err(ApiError::unsupported_message_content_type())
    }
}

fn message_response_kind(status: EnqueueSubmitStatus) -> &'static str {
    match status {
        EnqueueSubmitStatus::Started => "input_accepted",
        EnqueueSubmitStatus::Queued => "input_queued",
        EnqueueSubmitStatus::Duplicate => "input_duplicate",
    }
}

fn input_urgency_from_body(body: &Value) -> Result<InputUrgency, String> {
    match body.get("urgency") {
        Some(Value::String(value)) => InputUrgency::parse(value)
            .ok_or_else(|| "message urgency must be \"normal\" or \"urgent\"".to_owned()),
        Some(_) => Err("message urgency must be \"normal\" or \"urgent\"".to_owned()),
        None => Ok(InputUrgency::Normal),
    }
}

fn slash_command_response(service: &Service, body: &Value) -> Option<Value> {
    let text = pure_text_message_body(body)?;
    let command_text = text.trim();
    if !command_text.starts_with('/') || command_text.starts_with("//") {
        return None;
    }

    let command = command_text.trim_start_matches('/').trim();
    let parts = command.split_whitespace().collect::<Vec<_>>();
    if parts.is_empty() {
        return Some(command_error(
            "",
            "unknown_command",
            "unknown slash command",
        ));
    }

    match parts.as_slice() {
        ["tasks"] => Some(command_result("tasks", service.list_background_tasks())),
        ["task", "reply", ..] => Some(command_error(
            "task reply",
            "invalid_command",
            AGENT_MEDIATED_TASK_REPLY_MESSAGE,
        )),
        ["task", task_id] => match service.get_background_task(task_id) {
            Some(result) => Some(command_result("task", result)),
            None => Some(command_error(
                "task",
                "task_not_found",
                format!("unknown task: {task_id}"),
            )),
        },
        ["task", "stop", task_id] => match service.cancel_background_task(task_id) {
            Some(result) => Some(command_result("task stop", result)),
            None => Some(command_error(
                "task stop",
                "task_not_found",
                format!("unknown task: {task_id}"),
            )),
        },
        ["task", ..] => Some(command_error(
            command_name(&parts),
            "invalid_command",
            "invalid task command",
        )),
        _ => Some(command_error(
            command_name(&parts),
            "unknown_command",
            "unknown slash command",
        )),
    }
}

fn is_slash_command_body(body: &Value) -> bool {
    pure_text_message_body(body).is_some_and(|text| {
        let command = text.trim();
        command.starts_with('/') && !command.starts_with("//")
    })
}

fn pure_text_message_body(body: &Value) -> Option<&str> {
    let object = body.as_object()?;
    match (object.get("text"), object.get("items")) {
        (Some(text), None) => text.as_str(),
        (None, Some(Value::Array(items))) if items.len() == 1 => {
            let item = items.first()?.as_object()?;
            if item.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            item.get("text")?.as_str()
        }
        _ => None,
    }
}

fn command_result(command: &str, result: Value) -> Value {
    json!({
        "ok": true,
        "kind": "command_result",
        "command": command,
        "result": result
    })
}

fn command_error(command: impl Into<String>, code: &str, message: impl Into<String>) -> Value {
    let command = command.into();
    json!({
        "ok": false,
        "kind": "command_error",
        "command": command,
        "error": {
            "code": code,
            "message": message.into()
        }
    })
}

fn command_name(parts: &[&str]) -> String {
    match parts {
        ["task", "stop", ..] => "task stop".to_owned(),
        ["task", "reply", ..] => "task reply".to_owned(),
        ["task", ..] => "task".to_owned(),
        [command, ..] => (*command).to_owned(),
        [] => String::new(),
    }
}

fn append_safe_rejection_cursor(
    service: &Service,
    before_enqueue_cursor: &EventCursor,
    message_id: &str,
) -> Option<String> {
    let instance = before_enqueue_cursor.instance()?;
    let window = service
        .event_window_after_cursor(before_enqueue_cursor.clone())
        .ok()?;
    let event = window.events.iter().rev().find(|event| {
        event.event_type == "message.rejected"
            && event.data.get("message_id").and_then(Value::as_str) == Some(message_id)
    })?;
    EventCursor::for_instance(instance.to_owned(), event.seq)
        .ok()
        .map(|cursor| cursor.to_string())
}

#[derive(Debug, Serialize)]
struct MessageResponse {
    ok: bool,
    kind: &'static str,
    input_id: String,
    message_id: String,
    timeline_cursor: String,
    content_preview: String,
    content_bytes: usize,
    content_truncated: bool,
    content_kind: &'static str,
    queue_length: usize,
    state: ServiceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    delivery_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_hash: Option<String>,
}

#[derive(Debug, Serialize)]
struct AbortResponse {
    ok: bool,
    queue_length: usize,
    state: ServiceState,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    retryable: bool,
    timeline_cursor: Option<String>,
    history_boundary: Option<&'static str>,
}

impl ApiError {
    fn new(
        status: StatusCode,
        code: &'static str,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retryable,
            timeline_cursor: None,
            history_boundary: None,
        }
    }

    fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message, false)
    }

    fn message_conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "message_conflict",
            message: message.into(),
            retryable: false,
            timeline_cursor: None,
            history_boundary: None,
        }
    }

    fn terminal_unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "terminal_unavailable",
            "task terminal is unavailable",
            true,
        )
    }

    fn stale_cursor() -> Self {
        Self {
            status: StatusCode::GONE,
            code: "stale_cursor",
            message: "cursor is outside the retained event window".to_owned(),
            retryable: true,
            timeline_cursor: None,
            history_boundary: Some("expired"),
        }
    }

    fn preview_disabled() -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "preview_disabled",
            message: "llm text preview is disabled".to_owned(),
            retryable: false,
            timeline_cursor: None,
            history_boundary: None,
        }
    }

    fn preview_subscription_limit() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "preview_subscription_limit",
            "llm text preview subscription limit reached",
            true,
        )
    }

    fn timeline_follow_connection_limit() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "timeline_follow_connection_limit",
            "timeline follow connection limit reached",
            true,
        )
    }

    fn registry_ws_connection_limit() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "registry_ws_connection_limit",
            "registry websocket connection limit reached",
            true,
        )
    }

    fn unsupported_last_event_id() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "unsupported_last_event_id",
            "llm text preview does not support Last-Event-ID",
            false,
        )
    }

    fn with_timeline_cursor(mut self, timeline_cursor: Option<String>) -> Self {
        self.timeline_cursor = timeline_cursor;
        self
    }

    fn from_timeline_store(error: TimelineStoreError) -> Self {
        match error {
            TimelineStoreError::InvalidCursor
            | TimelineStoreError::InvalidLimit
            | TimelineStoreError::InvalidRetentionDays
            | TimelineStoreError::Envelope(_) => Self::invalid_request(error.to_string()),
            TimelineStoreError::StaleCursor => Self::stale_cursor(),
            TimelineStoreError::InjectedWrite { .. }
            | TimelineStoreError::Io { .. }
            | TimelineStoreError::Json { .. } => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "persistence_error",
                error.to_string(),
                true,
            ),
        }
    }

    fn timeline_worker_failed(operation: &'static str) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            format!("{operation} worker failed"),
            true,
        )
    }

    fn timeline_worker_limit() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "timeline_worker_limit",
            "timeline worker limit reached",
            true,
        )
    }

    fn service_mutation_worker_failed(operation: &'static str) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            format!("{operation} worker failed"),
            true,
        )
    }

    fn service_mutation_worker_limit() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "service_mutation_worker_limit",
            "service mutation worker limit reached",
            true,
        )
    }

    fn message_worker_failed(operation: &'static str) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            format!("{operation} worker failed"),
            true,
        )
    }

    fn message_request_limit() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "message_request_limit",
            "message request limit reached",
            true,
        )
    }

    fn request_body_timeout() -> Self {
        Self::new(
            StatusCode::REQUEST_TIMEOUT,
            "request_body_timeout",
            "request body read timed out",
            true,
        )
    }

    fn origin_not_allowed() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "origin_not_allowed",
            "browser-origin requests require service authentication",
            false,
        )
    }

    fn unsupported_message_content_type() -> Self {
        Self::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Content-Type must be application/json",
            false,
        )
    }

    fn from_registry(error: RegistryError) -> Self {
        let status = match error {
            RegistryError::ValueTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            RegistryError::TooManyTopics => StatusCode::TOO_MANY_REQUESTS,
            _ => StatusCode::BAD_REQUEST,
        };
        Self::new(status, error.code(), error.to_string(), false)
    }

    fn registry_worker_failed(operation: &'static str) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            format!("{operation} worker failed"),
            true,
        )
    }

    fn registry_worker_limit() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "registry_worker_limit",
            "registry worker limit reached",
            true,
        )
    }

    fn from_body_rejection(error: BytesRejection) -> Self {
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Self {
                status: StatusCode::PAYLOAD_TOO_LARGE,
                code: "body_too_large",
                message: "request body too large".to_owned(),
                retryable: false,
                timeline_cursor: None,
                history_boundary: None,
            }
        } else {
            Self::invalid_request(error.to_string())
        }
    }

    fn from_multipart_rejection(error: MultipartRejection) -> Self {
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Self::upload_too_large()
        } else {
            Self::new(
                StatusCode::BAD_REQUEST,
                "invalid_multipart",
                error.to_string(),
                false,
            )
        }
    }

    fn from_multipart_error(error: MultipartError) -> Self {
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Self::upload_too_large()
        } else {
            Self::new(
                StatusCode::BAD_REQUEST,
                "invalid_multipart",
                error.to_string(),
                false,
            )
        }
    }

    fn file_store_unavailable() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            "file store is not configured",
            true,
        )
    }

    fn file_upload_limit() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "file_upload_limit",
            "file upload limit reached",
            true,
        )
    }

    fn file_download_limit() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "file_download_limit",
            "file download limit reached",
            true,
        )
    }

    fn from_file_worker_join(operation: &'static str, _error: tokio::task::JoinError) -> Self {
        Self::file_worker_failed(operation)
    }

    fn file_worker_failed(operation: &'static str) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            format!("{operation} worker failed"),
            true,
        )
    }

    fn invalid_filename(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_filename", message, false)
    }

    fn no_files() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "no_files",
            "multipart request must include at least one file part",
            false,
        )
    }

    fn upload_too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "upload_too_large",
            "upload request too large",
            false,
        )
    }

    fn too_many_files() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_many_files",
            "too many uploaded files",
            false,
        )
    }

    fn too_many_file_refs() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_many_file_refs",
            "too many referenced files",
            false,
        )
    }

    fn referenced_files_too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "referenced_files_too_large",
            "referenced files exceed per-message limit",
            false,
        )
    }

    fn from_upload_file_store(error: FileStoreError) -> Self {
        match error.kind() {
            FileStoreErrorKind::InvalidFilename => Self::new(
                StatusCode::BAD_REQUEST,
                "invalid_filename",
                error.to_string(),
                false,
            ),
            FileStoreErrorKind::FileTooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "file_too_large",
                error.to_string(),
                false,
            ),
            FileStoreErrorKind::StoreTooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "store_too_large",
                error.to_string(),
                false,
            ),
            FileStoreErrorKind::InvalidFileId
            | FileStoreErrorKind::FileNotFound
            | FileStoreErrorKind::FileExpired
            | FileStoreErrorKind::ObjectMissing
            | FileStoreErrorKind::CorruptMetadata
            | FileStoreErrorKind::Storage => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage_error",
                error.to_string(),
                true,
            ),
        }
    }

    fn from_download_file_store(error: FileStoreError) -> Self {
        match error.kind() {
            FileStoreErrorKind::InvalidFileId => Self::new(
                StatusCode::BAD_REQUEST,
                "invalid_file_id",
                error.to_string(),
                false,
            ),
            FileStoreErrorKind::FileNotFound => Self::new(
                StatusCode::NOT_FOUND,
                "file_not_found",
                error.to_string(),
                false,
            ),
            FileStoreErrorKind::FileExpired => {
                Self::new(StatusCode::GONE, "file_expired", error.to_string(), false)
            }
            FileStoreErrorKind::ObjectMissing | FileStoreErrorKind::CorruptMetadata => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "file_unavailable",
                error.to_string(),
                true,
            ),
            FileStoreErrorKind::InvalidFilename
            | FileStoreErrorKind::FileTooLarge
            | FileStoreErrorKind::StoreTooLarge
            | FileStoreErrorKind::Storage => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage_error",
                error.to_string(),
                true,
            ),
        }
    }

    fn from_message_file_store(error: FileStoreError) -> Self {
        match error.kind() {
            FileStoreErrorKind::InvalidFileId => Self::new(
                StatusCode::BAD_REQUEST,
                "invalid_file_id",
                error.to_string(),
                false,
            ),
            FileStoreErrorKind::FileNotFound => Self::new(
                StatusCode::NOT_FOUND,
                "file_not_found",
                error.to_string(),
                false,
            ),
            FileStoreErrorKind::FileExpired => {
                Self::new(StatusCode::GONE, "file_expired", error.to_string(), false)
            }
            FileStoreErrorKind::ObjectMissing | FileStoreErrorKind::CorruptMetadata => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "file_unavailable",
                error.to_string(),
                true,
            ),
            FileStoreErrorKind::InvalidFilename
            | FileStoreErrorKind::FileTooLarge
            | FileStoreErrorKind::StoreTooLarge
            | FileStoreErrorKind::Storage => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage_error",
                error.to_string(),
                true,
            ),
        }
    }

    fn from_attachment(error: AttachmentError) -> Self {
        match error {
            AttachmentError::InvalidRequest => Self::invalid_request("invalid message input"),
            AttachmentError::UnsupportedAttachment => Self {
                status: StatusCode::BAD_REQUEST,
                code: "unsupported_attachment",
                message: "unsupported attachment".to_owned(),
                retryable: false,
                timeline_cursor: None,
                history_boundary: None,
            },
        }
    }

    fn from_service(error: ServiceError) -> Self {
        match error {
            ServiceError::EmptyMessage => Self {
                status: StatusCode::BAD_REQUEST,
                code: "invalid_request",
                message: error.to_string(),
                retryable: false,
                timeline_cursor: None,
                history_boundary: None,
            },
            ServiceError::MessageConflict { .. } => Self {
                status: StatusCode::CONFLICT,
                code: "message_conflict",
                message: error.to_string(),
                retryable: false,
                timeline_cursor: None,
                history_boundary: None,
            },
            ServiceError::QueueFull => Self {
                status: StatusCode::TOO_MANY_REQUESTS,
                code: "queue_full",
                message: error.to_string(),
                retryable: true,
                timeline_cursor: None,
                history_boundary: None,
            },
            ServiceError::ShuttingDown => Self {
                status: StatusCode::SERVICE_UNAVAILABLE,
                code: "service_shutting_down",
                message: error.to_string(),
                retryable: false,
                timeline_cursor: None,
                history_boundary: None,
            },
            ServiceError::Configuration { .. } => Self {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "configuration_error",
                message: error.to_string(),
                retryable: false,
                timeline_cursor: None,
                history_boundary: None,
            },
            ServiceError::Persistence { .. } => Self {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "persistence_error",
                message: error.to_string(),
                retryable: true,
                timeline_cursor: None,
                history_boundary: None,
            },
        }
    }
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

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let history_boundary = self.history_boundary;
        let mut body = json!({
            "ok": false,
            "error": {
                "code": self.code,
                "message": self.message,
                "retryable": self.retryable
            }
        });
        if let Some(timeline_cursor) = self.timeline_cursor {
            body["timeline_cursor"] = json!(timeline_cursor);
        }
        if let Some(boundary) = history_boundary {
            body["error"]["history_boundary"] = json!(boundary);
        }
        let mut response = (self.status, Json(body)).into_response();
        if let Some(boundary) = history_boundary {
            response
                .headers_mut()
                .insert(HISTORY_BOUNDARY_HEADER, HeaderValue::from_static(boundary));
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::mpsc;
    use std::time::Duration as StdDuration;

    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tokio::sync::oneshot;
    use tokio::time::timeout;
    use tokio_util::sync::CancellationToken;
    use tower::ServiceExt;

    use super::*;
    use crate::agent_loop::AgentConfig;
    use crate::provider::{Provider, ProviderError, ProviderRequest, ProviderResponse};
    use crate::service::ServiceLimits;
    use crate::session::open_or_create_session_in_home_with_cwd;
    use crate::tasks::NewBackgroundTask;

    struct TextProvider;

    #[async_trait::async_trait]
    impl Provider for TextProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _cancel: CancellationToken,
        ) -> Result<ProviderResponse, ProviderError> {
            Ok(ProviderResponse::text("done"))
        }
    }

    struct CountingTextProvider(Arc<AtomicUsize>);

    #[async_trait::async_trait]
    impl Provider for CountingTextProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _cancel: CancellationToken,
        ) -> Result<ProviderResponse, ProviderError> {
            self.0.fetch_add(1, AtomicOrdering::SeqCst);
            Ok(ProviderResponse::text("done"))
        }
    }

    #[tokio::test]
    async fn delivery_receipt_is_session_owned_atomic_and_restart_durable() {
        let home = tempfile::tempdir().expect("session home");
        let files = tempfile::tempdir().expect("file root");
        let session =
            open_or_create_session_in_home_with_cwd("delivery-session", home.path(), "/workspace")
                .expect("session should open");
        let file_store =
            FileStore::open(crate::files::FileStoreOptions::new(files.path())).expect("file store");
        let provider_calls = Arc::new(AtomicUsize::new(0));
        let service = Service::with_session_replay_and_limits_and_file_store(
            AgentConfig::new("test").with_session("delivery-session"),
            Arc::new(CountingTextProvider(provider_calls.clone())),
            Vec::new(),
            session.replay(),
            Some(session.recorder()),
            Vec::new(),
            ServiceLimits::default(),
            file_store,
        )
        .expect("service should build");
        let app = router(service, Some("service-secret".to_owned()));
        let post = |hash: &'static str| {
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("authorization", "Bearer service-secret")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "text": "run once",
                        "delivery_key": "delivery_task_1",
                        "request_hash": hash,
                    })
                    .to_string(),
                ))
                .expect("request should build")
        };

        let (first, duplicate) = tokio::join!(
            app.clone().oneshot(post("hash-one")),
            app.clone().oneshot(post("hash-one"))
        );
        let first = first.expect("first request should respond");
        let duplicate = duplicate.expect("duplicate request should respond");
        assert_eq!(first.status(), StatusCode::OK);
        let first_body: Value = serde_json::from_slice(
            &to_bytes(first.into_body(), MAX_HTTP_JSON_BYTES)
                .await
                .expect("first body should read"),
        )
        .expect("first body should parse");
        assert_eq!(first_body["delivery_key"], "delivery_task_1");
        assert_eq!(first_body["request_hash"], "hash-one");

        assert_eq!(duplicate.status(), StatusCode::OK);
        let duplicate_body: Value = serde_json::from_slice(
            &to_bytes(duplicate.into_body(), MAX_HTTP_JSON_BYTES)
                .await
                .expect("duplicate body should read"),
        )
        .expect("duplicate body should parse");
        assert_eq!(
            duplicate_body["timeline_cursor"],
            first_body["timeline_cursor"]
        );
        let kinds = [first_body["kind"].as_str(), duplicate_body["kind"].as_str()];
        assert_eq!(
            kinds
                .iter()
                .filter(|kind| **kind == Some("input_accepted"))
                .count(),
            1
        );
        timeout(StdDuration::from_secs(2), async {
            while provider_calls.load(AtomicOrdering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("accepted message should execute");
        assert_eq!(provider_calls.load(AtomicOrdering::SeqCst), 1);
        assert!(
            !files.path().join("delivery-receipts").exists(),
            "delivery state must not be stored in the File Library"
        );

        let mismatch = app
            .clone()
            .oneshot(post("hash-two"))
            .await
            .expect("router should respond");
        assert_eq!(mismatch.status(), StatusCode::CONFLICT);

        let reopened =
            open_or_create_session_in_home_with_cwd("delivery-session", home.path(), "/workspace")
                .expect("session should reopen");
        let restarted = Service::with_session_replay_and_limits(
            AgentConfig::new("test").with_session("delivery-session"),
            Arc::new(TextProvider),
            Vec::new(),
            reopened.replay(),
            Some(reopened.recorder()),
            Vec::new(),
            ServiceLimits::default(),
        )
        .expect("restarted service should build");
        let receipt = router(restarted, Some("service-secret".to_owned()))
            .oneshot(
                Request::builder()
                    .uri("/v1/deliveries/delivery_task_1")
                    .header("authorization", "Bearer service-secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(receipt.status(), StatusCode::OK);
        let receipt_body: Value = serde_json::from_slice(
            &to_bytes(receipt.into_body(), MAX_HTTP_JSON_BYTES)
                .await
                .expect("receipt body should read"),
        )
        .expect("receipt body should parse");
        assert_eq!(receipt_body["found"], true);
        assert_eq!(receipt_body["request_hash"], "hash-one");
    }

    #[tokio::test]
    async fn delivered_slash_text_is_enqueued_as_user_input() {
        let home = tempfile::tempdir().expect("session home");
        let session =
            open_or_create_session_in_home_with_cwd("slash-session", home.path(), "/workspace")
                .expect("session should open");
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("test").with_session("slash-session"),
            Arc::new(TextProvider),
            Vec::new(),
            session.replay(),
            Some(session.recorder()),
            Vec::new(),
            ServiceLimits::default(),
        )
        .expect("service should build");
        let app = router(service, Some("service-secret".to_owned()));
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/messages")
                    .header("authorization", "Bearer service-secret")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "text": "/tasks",
                            "delivery_key": "delivery_slash_1",
                            "request_hash": "slash-hash",
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), MAX_HTTP_JSON_BYTES)
                .await
                .expect("response body should read"),
        )
        .expect("response body should parse");
        assert_ne!(body["kind"], "command_result");
        assert_ne!(body["kind"], "command_error");
        assert_eq!(body["delivery_key"], "delivery_slash_1");
        assert_eq!(body["request_hash"], "slash-hash");

        let receipt = app
            .oneshot(
                Request::builder()
                    .uri("/v1/deliveries/delivery_slash_1")
                    .header("authorization", "Bearer service-secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(receipt.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn background_stop_route_uses_runtime_success_shape_and_safe_missing_response() {
        let service = Service::new(AgentConfig::new("test"), Arc::new(TextProvider), Vec::new())
            .expect("service should build");
        service.background_task_manager().start_task_with_id(
            "task_1",
            NewBackgroundTask::new("call_1", "bash", "sleep 30"),
        );
        let app = router(service, Some("service-secret".to_owned()));
        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/background-tasks/task_1/stop")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let stopped = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/background-tasks/task_1/stop")
                    .header("authorization", "Bearer service-secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(stopped.status(), StatusCode::OK);
        let stopped_body: Value = serde_json::from_slice(
            &to_bytes(stopped.into_body(), MAX_HTTP_JSON_BYTES)
                .await
                .expect("success body should read"),
        )
        .expect("success body should parse");
        assert_eq!(stopped_body["ok"], true);
        assert_eq!(stopped_body["kind"], "task_cancel");
        assert_eq!(stopped_body["task_id"], "task_1");
        assert_eq!(stopped_body["state"], "cancelling");
        assert_eq!(stopped_body["task"]["task_id"], "task_1");
        assert_eq!(stopped_body["task"]["state"], "cancelling");

        let missing = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/background-tasks/missing/stop")
                    .header("authorization", "Bearer service-secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let body: Value = serde_json::from_slice(
            &to_bytes(missing.into_body(), MAX_HTTP_JSON_BYTES)
                .await
                .expect("missing body should read"),
        )
        .expect("missing body should parse");
        assert_eq!(body["error"]["code"], "background_task_not_found");
        assert_eq!(body["error"]["retryable"], false);
    }

    #[tokio::test]
    async fn terminal_route_is_explicit_and_requires_service_auth() {
        let service = Service::new(AgentConfig::new("test"), Arc::new(TextProvider), Vec::new())
            .expect("service should build");
        let without_terminal = router(service.clone(), Some("service-secret".to_owned()));
        let missing = without_terminal
            .oneshot(
                Request::builder()
                    .uri("/v1/terminal/ws")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("router should respond");
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        let app = router_with_terminal(
            service,
            Some("service-secret".to_owned()),
            TerminalConfig {
                executor_addr: "127.0.0.1:3110"
                    .parse()
                    .expect("executor address should parse"),
                cwd: "/workspace".to_owned(),
            },
        );
        let unauthorized = app
            .clone()
            .oneshot(websocket_upgrade_request(None))
            .await
            .expect("router should respond");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let upgrade = app
            .oneshot(websocket_upgrade_request(Some("service-secret")))
            .await
            .expect("router should respond");
        assert_eq!(upgrade.status(), StatusCode::UPGRADE_REQUIRED);
    }

    fn websocket_upgrade_request(service_key: Option<&str>) -> Request<Body> {
        let mut request = Request::builder()
            .uri("/v1/terminal/ws")
            .header("connection", "upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==");
        if let Some(service_key) = service_key {
            request = request.header("authorization", format!("Bearer {service_key}"));
        }
        request
            .body(Body::empty())
            .expect("upgrade request should build")
    }

    #[test]
    fn bind_file_refs_fully_verifies_each_distinct_id_once() {
        let root = tempfile::tempdir().expect("temp dir");
        let store =
            FileStore::open(crate::files::FileStoreOptions::new(root.path())).expect("file store");
        let first = store
            .store_bytes(
                "first.txt",
                Some("text/plain"),
                b"first",
                crate::files::FileSource::Upload,
                None,
            )
            .expect("first file");
        let second = store
            .store_bytes(
                "second.txt",
                Some("text/plain"),
                b"second",
                crate::files::FileSource::Upload,
                None,
            )
            .expect("second file");
        let input = ParsedUserInput::new(vec![
            PublicInputItem::File {
                file_id: first.file_id.clone(),
            },
            PublicInputItem::File {
                file_id: first.file_id.clone(),
            },
            PublicInputItem::File {
                file_id: second.file_id.clone(),
            },
            PublicInputItem::File {
                file_id: first.file_id,
            },
            PublicInputItem::File {
                file_id: second.file_id,
            },
        ]);

        let content = bind_file_refs("duplicate-bindings", input, &store).expect("bindings");

        assert_eq!(content.len(), 5);
        assert_eq!(store.full_verification_count(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_timeline_read_does_not_block_health_work() {
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let slots = Arc::new(Semaphore::new(1));
        let read = tokio::spawn(run_timeline_blocking_task(
            slots.clone(),
            "timeline test read",
            move || {
                let _ = entered_tx.send(());
                let released = release_rx.recv_timeout(StdDuration::from_secs(5)).is_ok();
                json!({"released": released})
            },
        ));

        entered_rx.await.expect("blocking read should start");
        assert!(slots.try_acquire().is_err());
        let health_result = timeout(Duration::from_secs(1), healthz()).await;
        release_tx.send(()).expect("release blocking read");
        let read_result = read.await.unwrap().unwrap();

        let _ = health_result.expect("health work should run while timeline read is blocked");
        assert_eq!(read_result, json!({"released": true}));
        assert_eq!(slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancelled_timeline_read_holds_slot_until_blocking_worker_exits() {
        let slots = Arc::new(Semaphore::new(1));
        let (entered_tx, entered_rx) = oneshot::channel();
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let task = tokio::spawn(run_timeline_blocking_task(
            slots.clone(),
            "timeline cancelled read",
            move || {
                let _ = entered_tx.send(());
                let _ = release_rx.recv_timeout(StdDuration::from_secs(5));
            },
        ));

        entered_rx.await.expect("blocking read should start");
        task.abort();
        let _ = task.await;
        assert!(slots.try_acquire().is_err());

        release_tx.send(()).expect("release blocking read");
        timeout(Duration::from_secs(1), async {
            while slots.available_permits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("slot should release after the blocking worker exits");
        assert_eq!(slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn timeline_worker_limit_is_retryable_service_unavailable() {
        let slots = Arc::new(Semaphore::new(1));
        let _held = slots.clone().try_acquire_owned().unwrap();
        let error = run_timeline_blocking_task(slots, "timeline limited read", || ())
            .await
            .expect_err("full timeline worker pool should reject immediately");

        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code, "timeline_worker_limit");
        assert_eq!(error.message, "timeline worker limit reached");
        assert!(error.retryable);
    }

    #[tokio::test]
    async fn service_mutation_worker_limit_is_retryable_service_unavailable() {
        let slots = Arc::new(Semaphore::new(MAX_HTTP_SERVICE_MUTATIONS));
        let _held = slots
            .clone()
            .try_acquire_many_owned(MAX_HTTP_SERVICE_MUTATIONS as u32)
            .unwrap();
        let error = run_service_mutation_blocking_task(slots, "limited service mutation", || ())
            .await
            .expect_err("full service mutation worker pool should reject immediately");

        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code, "service_mutation_worker_limit");
        assert_eq!(error.message, "service mutation worker limit reached");
        assert!(error.retryable);
    }

    fn quadratic_bounded_registry_response(
        mut body: Value,
        max_response_bytes: usize,
        side: RegistryResponseTruncateSide,
    ) -> Value {
        while body.to_string().len() > max_response_bytes {
            let Some(items) = body.get_mut("items").and_then(Value::as_array_mut) else {
                break;
            };
            if items.is_empty() {
                break;
            }
            match side {
                RegistryResponseTruncateSide::Front => {
                    items.remove(0);
                }
                RegistryResponseTruncateSide::Back => {
                    items.pop();
                }
            }
            mark_registry_response_truncated(&mut body);
        }

        if body.to_string().len() <= max_response_bytes {
            body
        } else {
            compact_registry_response(body, max_response_bytes)
        }
    }

    fn snapshot_body(items: Vec<Value>) -> Value {
        json!({
            "ok": true,
            "op": "snapshot",
            "kind": "registry_get",
            "id": "request-1",
            "server_time": "2026-07-19T00:00:00Z",
            "matched_count": items.len(),
            "returned_count": items.len(),
            "items": items,
            "truncated": false,
            "truncated_reason": null,
        })
    }

    fn history_body(items: Vec<Value>) -> Value {
        json!({
            "ok": true,
            "op": "history",
            "kind": "registry_history",
            "server_time": "2026-07-19T00:00:00Z",
            "matched_count": items.len(),
            "returned_count": items.len(),
            "items": items,
            "oldest_seq": 41,
            "newest_seq": 99,
            "truncated": false,
            "truncated_reason": null,
        })
    }

    #[test]
    fn bounded_registry_response_matches_quadratic_oracle_for_mixed_items() {
        let items = vec![
            json!("plain"),
            json!("quotes: \" and slash: \\ and newline:\n"),
            json!({"nested": [1, true, null], "unicode": "\u{754c}"}),
            json!(["short", {"long": "x".repeat(73)}]),
        ];

        let count_boundary_items = (0..12)
            .map(|index| json!({"index": index, "value": "z".repeat(index + 1)}))
            .collect();
        for body in [
            snapshot_body(items.clone()),
            history_body(items),
            snapshot_body(count_boundary_items),
        ] {
            let initial_len = body.to_string().len();
            for side in [
                RegistryResponseTruncateSide::Front,
                RegistryResponseTruncateSide::Back,
            ] {
                for cap in 0..=initial_len + 1 {
                    assert_eq!(
                        bounded_registry_response(body.clone(), cap, side),
                        quadratic_bounded_registry_response(body.clone(), cap, side),
                        "response differed for cap {cap} and side {side:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn bounded_registry_response_honors_exact_boundary_and_truncate_side() {
        let body = snapshot_body(vec![
            json!({"index": 0, "value": "a".repeat(80)}),
            json!({"index": 1, "value": "b".repeat(80)}),
            json!({"index": 2, "value": "c".repeat(80)}),
        ]);

        for (side, expected_indexes) in [
            (RegistryResponseTruncateSide::Back, vec![0, 1]),
            (RegistryResponseTruncateSide::Front, vec![1, 2]),
        ] {
            let mut expected = body.clone();
            let items = expected["items"].as_array_mut().expect("items array");
            match side {
                RegistryResponseTruncateSide::Front => {
                    items.remove(0);
                }
                RegistryResponseTruncateSide::Back => {
                    items.pop();
                }
            }
            mark_registry_response_truncated(&mut expected);
            let exact_cap = expected.to_string().len();

            let actual = bounded_registry_response(body.clone(), exact_cap, side);
            assert_eq!(actual, expected);
            assert_eq!(actual.to_string().len(), exact_cap);
            assert_eq!(actual["returned_count"], 2);
            assert_eq!(
                actual["items"]
                    .as_array()
                    .expect("items array")
                    .iter()
                    .map(|item| item["index"].as_u64().expect("item index"))
                    .collect::<Vec<_>>(),
                expected_indexes
            );
        }
    }

    #[test]
    fn bounded_registry_response_preserves_or_clears_history_bounds() {
        let body = history_body(vec![
            json!({"seq": 41, "value": "a".repeat(100)}),
            json!({"seq": 99, "value": "b".repeat(100)}),
        ]);
        let mut one_item = body.clone();
        one_item["items"]
            .as_array_mut()
            .expect("items array")
            .remove(0);
        mark_registry_response_truncated(&mut one_item);

        let non_empty = bounded_registry_response(
            body.clone(),
            one_item.to_string().len(),
            RegistryResponseTruncateSide::Front,
        );
        assert_eq!(non_empty["oldest_seq"], 41);
        assert_eq!(non_empty["newest_seq"], 99);

        let mut expected_empty = body.clone();
        expected_empty["items"] = json!([]);
        mark_registry_response_truncated(&mut expected_empty);
        let empty = bounded_registry_response(
            body,
            expected_empty.to_string().len(),
            RegistryResponseTruncateSide::Front,
        );
        assert_eq!(empty, expected_empty);
        assert_eq!(empty["oldest_seq"], Value::Null);
        assert_eq!(empty["newest_seq"], Value::Null);
    }

    #[test]
    fn bounded_registry_response_serializes_each_item_once_and_body_constant_times() {
        let body = snapshot_body(
            (0..1_000)
                .map(|index| json!({"index": index, "value": "x".repeat(32)}))
                .collect(),
        );
        let cap = body.to_string().len() / 2;
        REGISTRY_SERIALIZATION_COUNTS.with(|counts| counts.set((0, 0)));

        let response = bounded_registry_response(body, cap, RegistryResponseTruncateSide::Back);

        let (body_serializations, item_serializations) =
            REGISTRY_SERIALIZATION_COUNTS.with(std::cell::Cell::get);
        assert_eq!(item_serializations, 1_000);
        assert_eq!(body_serializations, 3);
        assert!(response["truncated"].as_bool().unwrap_or(false));
        assert!(response.to_string().len() <= cap);
    }

    #[test]
    fn bounded_registry_response_final_size_miss_goes_directly_to_compact() {
        let mut body = history_body(vec![json!({"seq": 1, "value": "x".repeat(200)})]);
        body["oldest_seq"] = json!(1);
        body["newest_seq"] = json!(2);
        let mut scaffold = body.clone();
        scaffold["items"] = json!([]);
        set_registry_response_truncated(&mut scaffold, 0, false);
        let cap = scaffold.to_string().len();
        let expected = quadratic_bounded_registry_response(
            body.clone(),
            cap,
            RegistryResponseTruncateSide::Front,
        );
        REGISTRY_SERIALIZATION_COUNTS.with(|counts| counts.set((0, 0)));

        let response = bounded_registry_response(body, cap, RegistryResponseTruncateSide::Front);

        assert_eq!(response, expected);
        assert!(response.get("server_time").is_none());
        assert!(response.to_string().len() <= cap);
        assert_eq!(
            REGISTRY_SERIALIZATION_COUNTS.with(std::cell::Cell::get),
            (3, 1)
        );
    }

    #[test]
    fn bounded_registry_response_fast_path_serializes_body_once() {
        let body = snapshot_body(vec![json!({"value": "fits"})]);
        let exact_cap = body.to_string().len();
        REGISTRY_SERIALIZATION_COUNTS.with(|counts| counts.set((0, 0)));

        assert_eq!(
            bounded_registry_response(body.clone(), exact_cap, RegistryResponseTruncateSide::Back,),
            body
        );
        assert_eq!(
            REGISTRY_SERIALIZATION_COUNTS.with(std::cell::Cell::get),
            (1, 0)
        );
    }

    #[test]
    fn compact_registry_response_keeps_tiny_cap_cascade_for_all_shapes() {
        let items = snapshot_body(vec![]);
        let ack = json!({
            "ok": true,
            "op": "set",
            "kind": "registry_set",
            "id": "request-id-that-does-not-fit",
            "seq": 42,
            "writer_kind": "http"
        });
        let error = json!({
            "ok": false,
            "id": "request-id-that-does-not-fit",
            "error": {"code": "bad", "message": "detailed failure", "retryable": false}
        });

        for body in [&items, &ack, &error] {
            assert_eq!(compact_registry_response(body.clone(), 0), json!({}));
        }

        let mut null_id_ack = compact_registry_ack_response(&ack);
        null_id_ack["id"] = Value::Null;
        assert_eq!(
            compact_registry_response(ack.clone(), null_id_ack.to_string().len()),
            null_id_ack
        );

        let item_fallback = json!({
            "ok": true,
            "op": "snapshot",
            "items": [],
            "returned_count": 0,
            "truncated": true
        });
        let ack_fallback = json!({
            "ok": true,
            "op": "set",
            "kind": "registry_set",
            "truncated": true
        });
        let error_fallback = json!({
            "ok": false,
            "op": "error",
            "error": {"code": "bad"}
        });
        for (body, fallback) in [
            (items, item_fallback),
            (ack, ack_fallback),
            (error, error_fallback),
        ] {
            assert_eq!(
                compact_registry_response(body, fallback.to_string().len()),
                fallback
            );
        }
    }
}
