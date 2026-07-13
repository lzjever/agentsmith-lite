use std::collections::VecDeque;
use std::convert::Infallible;
use std::fs;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::extract::multipart::{MultipartError, MultipartRejection};
use axum::extract::rejection::BytesRejection;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{stream, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::agent_loop::InputUrgency;
use crate::attachments::{parse_user_input, AttachmentError, ParsedUserInput, PublicInputItem};
use crate::event::EventCursor;
use crate::files::{
    ExternalFileMetadata, FileRecord, FileSource, FileStore, FileStoreError, FileStoreErrorKind,
    DEFAULT_MAX_UPLOAD_REQUEST_BYTES,
};
use crate::llm_text_preview::{
    LlmTextPreviewFilter, LlmTextPreviewFrame, LlmTextPreviewSubscription,
};
use crate::registry::{
    RegistryError, RegistryHistoryResult, RegistryItem, RegistryQuery, RegistryQueryResult,
    RegistrySetAck, RegistrySetRequest, RegistryStore, RegistryTopicSummary, RegistryTtl,
    RegistryWriterKind,
};
use crate::service::{
    summarize_input_content, EnqueueSubmitStatus, Service, ServiceError, ServiceState,
};
use crate::timeline::{push_timeline_event_line, TimelineEnvelope, TimelineItem, TimelineTrace};
use crate::timeline_store::{
    HistoryBoundary, TimelineForwardPage, TimelineHistoryPage, TimelineStoreError,
    DEFAULT_TIMELINE_PAGE_LIMIT, MAX_TIMELINE_PAGE_LIMIT,
};
use crate::types::{ContentPart, MessageFileBinding};

pub const MAX_HTTP_JSON_BYTES: usize = 10 * 1024 * 1024;
const NEXT_CURSOR_HEADER: &str = "x-botified-next-cursor";
const HAS_MORE_AFTER_HEADER: &str = "x-botified-has-more-after";
const PAGE_START_CURSOR_HEADER: &str = "x-botified-page-start-cursor";
const PAGE_END_CURSOR_HEADER: &str = "x-botified-page-end-cursor";
const HAS_MORE_BEFORE_HEADER: &str = "x-botified-has-more-before";
const HISTORY_BOUNDARY_HEADER: &str = "x-botified-history-boundary";
const TIMELINE_FOLLOW_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const REGISTRY_WS_ERROR_MESSAGE_CHARS: usize = 256;
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
static NEXT_REGISTRY_WS_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct HttpState {
    service: Service,
    service_key: Option<String>,
    file_store: Option<FileStore>,
    auto_message_id_prefix: String,
    next_message_id: Arc<AtomicU64>,
    delivery_store: Option<Arc<DeliveryStore>>,
}

impl HttpState {
    fn new(service: Service, service_key: Option<String>) -> Self {
        let file_store = service.file_store();
        let delivery_store = file_store.as_ref().map(|store| DeliveryStore::new(
            store.options().root_dir.join("delivery-receipts"),
        ));
        Self {
            service,
            service_key,
            file_store,
            auto_message_id_prefix: new_auto_message_id_prefix(),
            next_message_id: Arc::new(AtomicU64::new(1)),
            delivery_store,
        }
    }

    fn next_message_id(&self) -> String {
        let id = self.next_message_id.fetch_add(1, Ordering::SeqCst);
        format!("msg_{}_{}", self.auto_message_id_prefix, id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeliveryReceipt {
    delivery_key: String,
    request_hash: String,
    message_id: String,
    timeline_cursor: String,
}

#[derive(Clone)]
struct DeliveryStore {
    root: PathBuf,
}

impl DeliveryStore {
    fn new(root: PathBuf) -> Arc<Self> {
        Arc::new(Self { root })
    }

    fn path(&self, key: &str) -> Result<PathBuf, ApiError> {
        if key.is_empty() || !key.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') {
            return Err(ApiError::invalid_request("delivery_key must be an ASCII token"));
        }
        Ok(self.root.join(format!("{key}.json")))
    }

    fn get(&self, key: &str) -> Result<Option<DeliveryReceipt>, ApiError> {
        let path = self.path(key)?;
        match fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "delivery_receipt_corrupt", "delivery receipt is corrupt", true)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "delivery_receipt_unavailable", "delivery receipt is unavailable", true)),
        }
    }

    fn put(&self, receipt: &DeliveryReceipt) -> Result<(), ApiError> {
        fs::create_dir_all(&self.root)
            .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "delivery_receipt_unavailable", "delivery receipt is unavailable", true))?;
        let path = self.path(&receipt.delivery_key)?;
        let temp = self.root.join(format!(".{}.tmp", receipt.delivery_key));
        let bytes = serde_json::to_vec(receipt)
            .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "delivery_receipt_unavailable", "delivery receipt is unavailable", true))?;
        fs::write(&temp, bytes)
            .and_then(|_| fs::rename(&temp, &path))
            .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "delivery_receipt_unavailable", "delivery receipt is unavailable", true))
    }
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

fn timestamp_now() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("unix:{}", duration.as_secs())
}

pub fn router(service: Service, service_key: Option<String>) -> Router {
    let max_upload_request_bytes = service
        .file_store()
        .map(|file_store| file_store.options().max_upload_request_bytes)
        .unwrap_or(DEFAULT_MAX_UPLOAD_REQUEST_BYTES);
    let state = HttpState::new(service, service_key);
    build_router(state, max_upload_request_bytes)
}

fn build_router(state: HttpState, max_upload_request_bytes: u64) -> Router {
    let files_upload_limit = usize::try_from(max_upload_request_bytes).unwrap_or(usize::MAX);
    let registry_enabled = state.service.registry_store().is_some();
    let mut router = Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/state", get(state_handler))
        .route(
            "/v1/messages",
            post(messages_handler).layer(DefaultBodyLimit::max(MAX_HTTP_JSON_BYTES)),
        )
        .route("/v1/deliveries/:delivery_key", get(delivery_receipt_handler))
        .route(
            "/v1/files",
            post(upload_files_handler).layer(DefaultBodyLimit::max(files_upload_limit)),
        )
        .route("/v1/files/:file_id", get(download_file_handler))
        .route("/v1/timeline", get(timeline_handler))
        .route("/v1/llm-text-preview", get(llm_text_preview_handler))
        .route("/v1/abort", post(abort_handler));
    router = router.route("/v1/terminal/ws", get(terminal_ws_handler));

    if registry_enabled {
        router = router
            .route("/v1/registry/ws", get(registry_ws_handler))
            .route("/v1/registry/current", get(registry_current_handler))
            .route("/v1/registry/history", get(registry_history_handler))
            .route("/v1/registry/topics", get(registry_topics_handler));
    }

    router.with_state(state)
}

async fn terminal_ws_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    Ok(ws.on_upgrade(terminal_websocket).into_response())
}

async fn terminal_websocket(socket: WebSocket) {
    let executor = match TcpStream::connect("127.0.0.1:3110").await {
        Ok(stream) => stream,
        Err(_) => {
            let (mut sender, _) = socket.split();
            let _ = sender.send(WsMessage::Text(json!({"op":"error","message":"Task terminal is unavailable"}).to_string())).await;
            return;
        }
    };
    let (executor_reader, mut executor_writer) = executor.into_split();
    let home = std::env::var("HOME").unwrap_or_else(|_| "/workspace/task/home".to_owned());
    let execute = json!({"op":"execute","command":"exec bash -il","cwd":home,"interactive_stdio":true}).to_string();
    if executor_writer.write_all(execute.as_bytes()).await.is_err() || executor_writer.write_all(b"\n").await.is_err() {
        return;
    }
    let (mut ws_sender, mut ws_receiver) = socket.split();
    if ws_sender.send(WsMessage::Text(json!({"op":"ready"}).to_string())).await.is_err() {
        return;
    }
    let output = async {
        let mut lines = BufReader::new(executor_reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if ws_sender.send(WsMessage::Text(line)).await.is_err() { break; }
        }
    };
    let input = async {
        while let Some(Ok(message)) = ws_receiver.next().await {
            match message {
                WsMessage::Text(text) => {
                    if executor_writer.write_all(text.as_bytes()).await.is_err() || executor_writer.write_all(b"\n").await.is_err() { break; }
                }
                WsMessage::Close(_) => {
                    let _ = executor_writer.write_all(b"{\"op\":\"cancel\"}\n").await;
                    break;
                }
                _ => {}
            }
        }
    };
    tokio::select! { _ = output => {}, _ = input => {} }
}

async fn healthz() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn state_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    Ok(Json(state.service.timeline_bootstrap_snapshot()))
}

async fn messages_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;

    let body = parse_json_body(body)?;
    let delivery = delivery_from_body(&body)?;
    if let Some(delivery) = delivery.as_ref() {
        let store = state.delivery_store.as_ref().ok_or_else(ApiError::delivery_store_unavailable)?;
        if let Some(receipt) = store.get(&delivery.delivery_key)? {
            if receipt.request_hash != delivery.request_hash {
                return Err(ApiError::message_conflict("delivery_key was already used with a different request_hash"));
            }
            return Ok(Json(message_response_from_receipt(receipt)));
        }
    }
    if let Some(response) = slash_command_response(&state.service, &body) {
        return Ok(Json(response));
    }

    let client_message_id = message_id_from_body(&body)?;
    if let (Some(delivery), Some(client_message_id)) = (delivery.as_ref(), client_message_id.as_ref()) {
        if delivery.delivery_key != *client_message_id {
            return Err(ApiError::invalid_request("client_message_id must equal delivery_key when delivery_key is supplied"));
        }
    }
    let message_id = delivery.as_ref().map(|value| value.delivery_key.clone()).or(client_message_id).unwrap_or_else(|| state.next_message_id());
    let urgency_result = input_urgency_from_body(&body);
    let input = parse_user_input(body).map_err(ApiError::from_attachment)?;
    let content = bind_user_input_content(&state, &message_id, input)?;
    let urgency = match urgency_result {
        Ok(urgency) => urgency,
        Err(message) => {
            let timeline_cursor = state.service.reject_user_message(
                &message_id,
                &content,
                "invalid_urgency",
                message.clone(),
                false,
            );
            return Err(ApiError::invalid_request(message)
                .with_timeline_cursor(timeline_cursor.map(|cursor| cursor.to_string())));
        }
    };
    let content_summary = summarize_input_content(&content);
    let before_enqueue_cursor = state.service.current_event_cursor();
    let outcome = match state
        .service
        .enqueue_with_urgency(message_id.clone(), content, urgency)
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            let timeline_cursor =
                append_safe_rejection_cursor(&state.service, &before_enqueue_cursor, &message_id);
            return Err(ApiError::from_service(error).with_timeline_cursor(timeline_cursor));
        }
    };

    let response = MessageResponse {
        ok: true,
        kind: message_response_kind(outcome.submit_status),
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
    if let Some(delivery) = delivery {
        let store = state.delivery_store.as_ref().ok_or_else(ApiError::delivery_store_unavailable)?;
        store.put(&DeliveryReceipt {
            delivery_key: delivery.delivery_key,
            request_hash: delivery.request_hash,
            message_id: response.message_id.clone(),
            timeline_cursor: response.timeline_cursor.clone(),
        })?;
    }
    Ok(Json(json!(response)))
}

async fn delivery_receipt_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    AxumPath(delivery_key): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = state.delivery_store.as_ref().ok_or_else(ApiError::delivery_store_unavailable)?;
    match store.get(&delivery_key)? {
        Some(receipt) => Ok(Json(json!({
            "ok": true,
            "found": true,
            "delivery_key": receipt.delivery_key,
            "request_hash": receipt.request_hash,
            "message_id": receipt.message_id,
            "timeline_cursor": receipt.timeline_cursor,
        }))),
        None => Ok(Json(json!({ "ok": true, "found": false }))),
    }
}

fn bind_user_input_content(
    state: &HttpState,
    message_id: &str,
    input: ParsedUserInput,
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
    bind_file_refs(message_id, input, store)
}

fn bind_file_refs(
    message_id: &str,
    input: ParsedUserInput,
    store: &FileStore,
) -> Result<Vec<ContentPart>, ApiError> {
    let mut file_count = 0usize;
    let mut referenced_bytes = 0u64;
    let mut content = Vec::with_capacity(input.items.len());
    let mut file_ids = Vec::new();

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
                let record = store
                    .metadata(&file_id)
                    .map_err(ApiError::from_message_file_store)?;
                referenced_bytes = referenced_bytes.saturating_add(record.size_bytes);
                if referenced_bytes > store.options().max_message_referenced_file_bytes {
                    return Err(ApiError::referenced_files_too_large());
                }
                let content_index = content.len();
                file_ids.push(record.file_id.clone());
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
        .touch_many(&file_ids)
        .map_err(ApiError::from_message_file_store)?;

    Ok(content)
}

async fn upload_files_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    multipart: Result<Multipart, MultipartRejection>,
) -> Result<Json<FilesUploadResponse>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let multipart = multipart.map_err(ApiError::from_multipart_rejection)?;
    let store = state
        .file_store
        .as_ref()
        .ok_or_else(ApiError::file_store_unavailable)?
        .clone();
    let records = upload_multipart_files(&store, multipart).await?;

    Ok(Json(FilesUploadResponse {
        ok: true,
        files: records
            .into_iter()
            .map(|record| record.external())
            .collect(),
    }))
}

async fn upload_multipart_files(
    store: &FileStore,
    mut multipart: Multipart,
) -> Result<Vec<FileRecord>, ApiError> {
    let mut records = Vec::new();
    let mut uploaded_bytes = 0_u64;

    while let Some(field) = match multipart.next_field().await {
        Ok(field) => field,
        Err(error) => {
            rollback_uploaded_files(store, &records);
            return Err(ApiError::from_multipart_error(error));
        }
    } {
        if field.name() != Some("file") {
            continue;
        }
        if records.len() >= store.options().max_upload_files {
            rollback_uploaded_files(store, &records);
            return Err(ApiError::too_many_files());
        }

        let filename = field
            .file_name()
            .map(str::to_owned)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                rollback_uploaded_files(store, &records);
                ApiError::invalid_filename("multipart file part requires a filename")
            })?;
        let mime_type = field.content_type().map(str::to_owned);
        let bytes = match field.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                rollback_uploaded_files(store, &records);
                return Err(ApiError::from_multipart_error(error));
            }
        };
        uploaded_bytes = uploaded_bytes.saturating_add(bytes.len() as u64);
        if uploaded_bytes > store.options().max_upload_request_bytes {
            rollback_uploaded_files(store, &records);
            return Err(ApiError::upload_too_large());
        }

        match store.store_bytes(
            &filename,
            mime_type.as_deref(),
            &bytes,
            FileSource::Upload,
            None,
        ) {
            Ok(record) => records.push(record),
            Err(error) => {
                rollback_uploaded_files(store, &records);
                return Err(ApiError::from_upload_file_store(error));
            }
        }
    }

    if records.is_empty() {
        return Err(ApiError::no_files());
    }
    Ok(records)
}

fn rollback_uploaded_files(store: &FileStore, records: &[FileRecord]) {
    for record in records {
        let _ = store.remove_file(&record.file_id);
    }
}

async fn download_file_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    AxumPath(file_id): AxumPath<String>,
) -> Result<Response, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = state
        .file_store
        .as_ref()
        .ok_or_else(ApiError::file_store_unavailable)?;
    let download = store
        .download_bytes(&file_id)
        .map_err(ApiError::from_download_file_store)?;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&download.metadata.mime_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&download.bytes.len().to_string())
            .expect("content length should be ascii"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition(&download.metadata.filename))
            .expect("content-disposition should be ascii"),
    );
    headers.insert(
        "x-botified-sha256",
        HeaderValue::from_str(&download.metadata.sha256).expect("sha256 should be ascii"),
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{}\"", download.metadata.sha256))
            .expect("etag should be ascii"),
    );

    Ok((headers, download.bytes).into_response())
}

async fn timeline_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;

    let query = parse_timeline_query(uri.query().unwrap_or_default())?;
    match query {
        TimelineQuery::Forward {
            cursor,
            follow,
            limit: _,
        } if follow => {
            state
                .service
                .timeline_forward_page(&cursor, 1)
                .map_err(ApiError::from_timeline_store)?;
            let body = timeline_stream_body(state.service.clone(), cursor);
            Ok((
                [(
                    header::CONTENT_TYPE.as_str(),
                    "application/x-ndjson".to_owned(),
                )],
                body,
            )
                .into_response())
        }
        TimelineQuery::Forward {
            cursor,
            follow: _,
            limit,
        } => {
            let page = state
                .service
                .timeline_forward_page(&cursor, limit)
                .map_err(ApiError::from_timeline_store)?;
            Ok(timeline_forward_response(page))
        }
        TimelineQuery::Backward { cursor, limit } => {
            let page = state
                .service
                .timeline_backward_page(&cursor, limit)
                .map_err(ApiError::from_timeline_store)?;
            Ok(timeline_history_response(page))
        }
        TimelineQuery::Tail { limit } => {
            let page = state
                .service
                .timeline_tail_page(limit)
                .map_err(ApiError::from_timeline_store)?;
            Ok(timeline_history_response(page))
        }
    }
}

async fn llm_text_preview_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    if headers.contains_key("last-event-id") {
        return Err(ApiError::unsupported_last_event_id());
    }

    let filter = parse_llm_text_preview_query(uri.query().unwrap_or_default())?;
    let Some(subscription) = state.service.subscribe_llm_text_preview(filter) else {
        return Err(ApiError::preview_disabled());
    };

    Ok((
        [
            (header::CONTENT_TYPE.as_str(), "text/event-stream"),
            (header::CACHE_CONTROL.as_str(), "no-cache"),
        ],
        llm_text_preview_stream_body(subscription),
    )
        .into_response())
}

async fn abort_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<AbortResponse>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let status = state.service.abort().await;

    Ok(Json(AbortResponse {
        ok: true,
        queue_length: status.queue_length,
        state: status.state,
    }))
}

async fn registry_ws_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = registry_store_from_state(&state)?;
    let origin = next_registry_ws_origin();
    Ok(ws.on_upgrade(move |socket| registry_ws_loop(socket, store, origin)))
}

async fn registry_current_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = registry_store_from_state(&state)?;
    let query = parse_registry_http_query(
        uri.query().unwrap_or_default(),
        RegistryHttpQueryKind::Current,
    )?;
    let result = store.get(query).map_err(ApiError::from_registry)?;
    Ok(Json(registry_get_response(
        result,
        None,
        store.config().max_response_bytes,
    )))
}

async fn registry_history_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = registry_store_from_state(&state)?;
    let query = parse_registry_http_query(
        uri.query().unwrap_or_default(),
        RegistryHttpQueryKind::History,
    )?;
    let result = store.history(query).map_err(ApiError::from_registry)?;
    Ok(Json(registry_history_response(
        result,
        None,
        store.config().max_response_bytes,
    )))
}

async fn registry_topics_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = registry_store_from_state(&state)?;
    let query = parse_registry_http_query(
        uri.query().unwrap_or_default(),
        RegistryHttpQueryKind::Topics,
    )?;
    let result = store.topics(query).map_err(ApiError::from_registry)?;
    Ok(Json(registry_topics_response(
        result,
        None,
        store.config().max_response_bytes,
    )))
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

fn next_registry_ws_origin() -> String {
    let id = NEXT_REGISTRY_WS_CONNECTION_ID.fetch_add(1, Ordering::SeqCst);
    format!("ws:conn_{id}")
}

async fn registry_ws_loop(mut socket: WebSocket, store: RegistryStore, origin: String) {
    let websocket_max_frame_bytes = store.options().websocket_max_frame_bytes;
    while let Some(frame) = socket.recv().await {
        let Some(response) =
            registry_ws_frame_response(&store, &origin, websocket_max_frame_bytes, frame)
        else {
            return;
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

fn registry_ws_frame_response(
    store: &RegistryStore,
    origin: &str,
    websocket_max_frame_bytes: usize,
    frame: Result<WsMessage, axum::Error>,
) -> Option<Value> {
    let max_response_bytes = store.config().max_response_bytes;
    let frame = match frame {
        Ok(frame) => frame,
        Err(_) => return None,
    };
    match frame {
        WsMessage::Text(text) => Some(registry_ws_text_response(
            store,
            origin,
            websocket_max_frame_bytes,
            &text,
        )),
        WsMessage::Binary(_) => Some(bounded_registry_response(
            registry_ws_error(
                None,
                "unsupported_frame",
                "registry websocket only accepts text JSON frames",
            ),
            max_response_bytes,
            RegistryResponseTruncateSide::Back,
        )),
        WsMessage::Ping(_) | WsMessage::Pong(_) => Some(bounded_registry_response(
            registry_ws_error(
                None,
                "unsupported_frame",
                "registry websocket only accepts text JSON frames",
            ),
            max_response_bytes,
            RegistryResponseTruncateSide::Back,
        )),
        WsMessage::Close(_) => None,
    }
}

fn registry_ws_text_response(
    store: &RegistryStore,
    origin: &str,
    websocket_max_frame_bytes: usize,
    text: &str,
) -> Value {
    let response = registry_ws_text_response_inner(store, origin, websocket_max_frame_bytes, text);
    bounded_registry_response(
        response,
        store.config().max_response_bytes,
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
        "set" => registry_ws_set(store, origin, id, object),
        "get" => registry_ws_get(store, id, object),
        "history" => registry_ws_history(store, id, object),
        "subscribe" => registry_ws_error(
            Some(id),
            "invalid_request",
            "registry websocket does not support subscribe",
        ),
        _ => registry_ws_error(
            Some(id),
            "invalid_request",
            "unsupported registry websocket op",
        ),
    }
}

fn registry_ws_set(
    store: &RegistryStore,
    origin: &str,
    id: Value,
    object: &serde_json::Map<String, Value>,
) -> Value {
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

    match store.set(
        RegistryWriterKind::WebsocketClient,
        origin.to_owned(),
        request,
    ) {
        Ok(ack) => registry_set_response(ack, Some(id), store.config().max_response_bytes),
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

#[derive(Debug, Clone, Copy)]
enum RegistryHttpQueryKind {
    Current,
    History,
    Topics,
}

fn parse_registry_http_query(
    query: &str,
    kind: RegistryHttpQueryKind,
) -> Result<RegistryQuery, ApiError> {
    let mut topic = None;
    let mut since_secs = None;
    let mut limit = None;
    let mut seen_keys = Vec::new();

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let Some((key, value)) = pair.split_once('=') else {
            return Err(ApiError::invalid_request("invalid query string"));
        };
        if seen_keys.contains(&key) {
            return Err(ApiError::invalid_request("duplicate query parameter"));
        }
        seen_keys.push(key);
        match key {
            "topic" => topic = Some(value.to_owned()),
            "since_secs" if matches!(kind, RegistryHttpQueryKind::History) => {
                since_secs = Some(parse_registry_f64(value, "since_secs")?);
            }
            "limit" => limit = Some(parse_registry_limit(value)?),
            _ => return Err(ApiError::invalid_request("unknown query parameter")),
        }
    }

    let topic = topic.ok_or_else(|| ApiError::invalid_request("topic is required"))?;
    let mut query = match kind {
        RegistryHttpQueryKind::History => {
            let since_secs =
                since_secs.ok_or_else(|| ApiError::invalid_request("since_secs is required"))?;
            RegistryQuery::history(topic, since_secs)
        }
        RegistryHttpQueryKind::Current | RegistryHttpQueryKind::Topics => RegistryQuery::new(topic),
    };
    if let Some(limit) = limit {
        query = query.with_limit(limit);
    }
    Ok(query)
}

fn parse_registry_f64(value: &str, name: &str) -> Result<f64, ApiError> {
    value
        .parse::<f64>()
        .map_err(|_| ApiError::invalid_request(format!("invalid {name}")))
}

fn parse_registry_limit(value: &str) -> Result<usize, ApiError> {
    value
        .parse::<usize>()
        .map_err(|_| ApiError::invalid_request("invalid limit"))
}

fn registry_set_response(
    ack: RegistrySetAck,
    id: Option<Value>,
    max_response_bytes: usize,
) -> Value {
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
        "updated_at": system_time_rfc3339(ack.updated_at),
        "expires_at": system_time_rfc3339(ack.expires_at),
        "ttl_secs": duration_secs(ack.ttl),
    });
    if let Some(id) = id {
        body["id"] = id;
    }
    bounded_registry_response(body, max_response_bytes, RegistryResponseTruncateSide::Back)
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
        "server_time": system_time_rfc3339(server_time),
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
        "server_time": system_time_rfc3339(result.server_time),
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

fn registry_topics_response(
    result: RegistryQueryResult<RegistryTopicSummary>,
    id: Option<Value>,
    max_response_bytes: usize,
) -> Value {
    let items = result
        .items
        .iter()
        .map(registry_topic_json)
        .collect::<Vec<_>>();
    let mut body = json!({
        "ok": true,
        "kind": "registry_topics",
        "server_time": system_time_rfc3339(result.server_time),
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
        if returned_count == 0 {
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
            "retryable": body
                .get("error")
                .and_then(|error| error.get("retryable"))
                .cloned()
                .unwrap_or(Value::Bool(false)),
        },
        "truncated": true,
        "truncated_reason": "response_bytes"
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
            json!(duration_between(item.expires_at, server_time)),
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
        "updated_at": system_time_rfc3339(item.updated_at),
        "expires_at": system_time_rfc3339(item.expires_at),
        "ttl_secs": duration_secs(item.ttl),
    })
}

fn registry_topic_json(topic: &RegistryTopicSummary) -> Value {
    json!({
        "topic": &topic.topic,
        "writer_kind": topic.writer_kind.as_str(),
        "origin": &topic.origin,
        "source": &topic.source,
        "latest_seq": topic.latest_seq,
        "last_seen_at": system_time_rfc3339(topic.last_seen_at),
        "current": topic.current,
        "expires_at": topic.expires_at.map(system_time_rfc3339),
        "sample_count_retained": topic.sample_count_retained,
        "freq_hz": topic.freq_hz,
    })
}

fn parse_json_body(body: Result<Bytes, BytesRejection>) -> Result<Value, ApiError> {
    let body = body.map_err(ApiError::from_body_rejection)?;
    if body.is_empty() {
        return Err(ApiError::invalid_request("request body must be JSON"));
    }
    serde_json::from_slice(&body).map_err(|_| ApiError::invalid_request("invalid JSON body"))
}

fn parse_timeline_query(query: &str) -> Result<TimelineQuery, ApiError> {
    let mut cursor: Option<String> = None;
    let mut follow = false;
    let mut limit = None;
    let mut direction = None;
    let mut tail = None;
    let mut seen_keys = Vec::new();

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let Some((key, value)) = pair.split_once('=') else {
            return Err(ApiError::invalid_request("invalid query string"));
        };
        if seen_keys.contains(&key) {
            return Err(ApiError::invalid_request("duplicate query parameter"));
        }
        seen_keys.push(key);
        match key {
            "cursor" => {
                EventCursor::parse_timeline(value)
                    .map_err(|_| ApiError::invalid_request("invalid cursor"))?;
                cursor = Some(value.to_owned());
            }
            "follow" => {
                follow = match value {
                    "true" => true,
                    "false" => false,
                    _ => return Err(ApiError::invalid_request("invalid follow")),
                };
            }
            "limit" => {
                limit = Some(parse_timeline_limit(value, "limit")?);
            }
            "direction" => {
                direction = Some(value.to_owned());
            }
            "tail" => {
                tail = Some(parse_timeline_limit(value, "tail")?);
            }
            _ => return Err(ApiError::invalid_request("unknown query parameter")),
        }
    }

    if let Some(tail) = tail {
        if cursor.is_some() || direction.is_some() || limit.is_some() || follow {
            return Err(ApiError::invalid_request("invalid timeline query"));
        }
        return Ok(TimelineQuery::Tail { limit: tail });
    }

    match direction.as_deref() {
        Some("backward") => {
            if follow {
                return Err(ApiError::invalid_request("invalid timeline query"));
            }
            let cursor = cursor.ok_or_else(|| ApiError::invalid_request("cursor is required"))?;
            let limit = limit.ok_or_else(|| ApiError::invalid_request("limit is required"))?;
            Ok(TimelineQuery::Backward { cursor, limit })
        }
        Some("forward") | Some(_) => Err(ApiError::invalid_request("invalid direction")),
        None => {
            let cursor = cursor.ok_or_else(|| ApiError::invalid_request("cursor is required"))?;
            if follow && limit.is_some() {
                return Err(ApiError::invalid_request("invalid timeline query"));
            }
            Ok(TimelineQuery::Forward {
                cursor,
                follow,
                limit: limit.unwrap_or(DEFAULT_TIMELINE_PAGE_LIMIT),
            })
        }
    }
}

fn parse_timeline_limit(value: &str, name: &str) -> Result<usize, ApiError> {
    let parsed = value
        .parse::<usize>()
        .map_err(|_| ApiError::invalid_request(format!("invalid {name}")))?;
    if !(1..=MAX_TIMELINE_PAGE_LIMIT).contains(&parsed) {
        return Err(ApiError::invalid_request(format!("invalid {name}")));
    }
    Ok(parsed)
}

fn parse_llm_text_preview_query(query: &str) -> Result<LlmTextPreviewFilter, ApiError> {
    let mut filter = LlmTextPreviewFilter::default();
    let mut seen_keys = Vec::new();

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let Some((key, value)) = pair.split_once('=') else {
            return Err(ApiError::invalid_request("invalid query string"));
        };
        if seen_keys.contains(&key) {
            return Err(ApiError::invalid_request("duplicate query parameter"));
        }
        seen_keys.push(key);
        match key {
            "provider_request_id" => filter.provider_request_id = Some(value.to_owned()),
            "cycle_id" => filter.cycle_id = Some(value.to_owned()),
            "input_id" => filter.input_id = Some(value.to_owned()),
            "cursor" | "seq" | "follow" | "replay" | "since" => {
                return Err(ApiError::invalid_request(
                    "llm text preview does not support replay or cursor parameters",
                ));
            }
            _ => return Err(ApiError::invalid_request("unknown query parameter")),
        }
    }

    Ok(filter)
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

#[derive(Clone)]
struct DeliveryInput {
    delivery_key: String,
    request_hash: String,
}

fn delivery_from_body(body: &Value) -> Result<Option<DeliveryInput>, ApiError> {
    let Some(key) = body.get("delivery_key") else {
        if body.get("request_hash").is_some() {
            return Err(ApiError::invalid_request("request_hash requires delivery_key"));
        }
        return Ok(None);
    };
    let key = key.as_str().map(str::trim).filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::invalid_request("delivery_key must be a non-empty string"))?;
    let hash = body.get("request_hash").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::invalid_request("request_hash must be a non-empty string"))?;
    Ok(Some(DeliveryInput { delivery_key: key.to_owned(), request_hash: hash.to_owned() }))
}

fn message_response_from_receipt(receipt: DeliveryReceipt) -> Value {
    json!({
        "ok": true,
        "kind": "idempotent",
        "input_id": receipt.message_id,
        "message_id": receipt.message_id,
        "timeline_cursor": receipt.timeline_cursor,
        "content_preview": "",
        "content_bytes": 0,
        "content_truncated": false,
        "content_kind": "text",
        "queue_length": 0,
        "state": "idle",
        "delivery_key": receipt.delivery_key,
        "request_hash": receipt.request_hash,
    })
}

fn timeline_stream_body(service: Service, cursor: String) -> Body {
    Body::from_stream(stream::unfold(
        TimelineStreamState::new(service, cursor),
        next_timeline_stream_chunk,
    ))
}

fn llm_text_preview_stream_body(subscription: LlmTextPreviewSubscription) -> Body {
    Body::from_stream(stream::unfold(
        subscription,
        next_llm_text_preview_stream_chunk,
    ))
}

async fn next_llm_text_preview_stream_chunk(
    mut subscription: LlmTextPreviewSubscription,
) -> Option<(Result<Bytes, Infallible>, LlmTextPreviewSubscription)> {
    let frame = subscription.recv().await?;
    Some((Ok(llm_text_preview_event_bytes(&frame)), subscription))
}

fn llm_text_preview_event_bytes(frame: &LlmTextPreviewFrame) -> Bytes {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"event: ");
    bytes.extend_from_slice(frame.event_name().as_bytes());
    bytes.extend_from_slice(b"\n");
    bytes.extend_from_slice(b"data: ");
    serde_json::to_writer(&mut bytes, frame).expect("preview frame should serialize");
    bytes.extend_from_slice(b"\n\n");
    Bytes::from(bytes)
}

fn timeline_envelopes_body(events: &[TimelineEnvelope]) -> Body {
    let mut body = Vec::new();
    for event in events {
        push_timeline_event_line(&mut body, event).expect("timeline envelope should serialize");
    }
    Body::from(body)
}

fn timeline_forward_response(page: TimelineForwardPage) -> Response {
    (
        [
            (
                header::CONTENT_TYPE.as_str(),
                "application/x-ndjson".to_owned(),
            ),
            (NEXT_CURSOR_HEADER, page.next_cursor),
            (HAS_MORE_AFTER_HEADER, page.has_more_after.to_string()),
        ],
        timeline_envelopes_body(&page.events),
    )
        .into_response()
}

fn timeline_history_response(page: TimelineHistoryPage) -> Response {
    (
        [
            (
                header::CONTENT_TYPE.as_str(),
                "application/x-ndjson".to_owned(),
            ),
            (NEXT_CURSOR_HEADER, page.next_cursor),
            (PAGE_START_CURSOR_HEADER, page.page_start_cursor),
            (PAGE_END_CURSOR_HEADER, page.page_end_cursor),
            (HAS_MORE_BEFORE_HEADER, page.has_more_before.to_string()),
            (
                HISTORY_BOUNDARY_HEADER,
                history_boundary_name(page.history_boundary).to_owned(),
            ),
        ],
        timeline_envelopes_body(&page.events),
    )
        .into_response()
}

struct TimelineStreamState {
    service: Service,
    cursor: String,
    processed_seq: u64,
    pending: VecDeque<Bytes>,
    done: bool,
}

impl TimelineStreamState {
    fn new(service: Service, cursor: String) -> Self {
        let processed_seq = EventCursor::parse_timeline(&cursor)
            .map(|cursor| cursor.seq())
            .unwrap_or(0);
        Self {
            service,
            cursor,
            processed_seq,
            pending: VecDeque::new(),
            done: false,
        }
    }
}

async fn next_timeline_stream_chunk(
    mut state: TimelineStreamState,
) -> Option<(Result<Bytes, Infallible>, TimelineStreamState)> {
    if let Some(line) = state.pending.pop_front() {
        return Some((Ok(line), state));
    }
    if state.done {
        return None;
    }

    loop {
        let window = match state
            .service
            .timeline_forward_page(&state.cursor, MAX_TIMELINE_PAGE_LIMIT)
        {
            Ok(window) => window,
            Err(error) => {
                state.done = true;
                return Some((
                    Ok(timeline_stream_error_line(
                        &state.service,
                        ApiError::from_timeline_store(error),
                    )),
                    state,
                ));
            }
        };

        collect_timeline_stream_events(&mut state, window);

        if let Some(line) = state.pending.pop_front() {
            return Some((Ok(line), state));
        }
        if state.done {
            return None;
        }

        let service = state.service.clone();
        let processed_seq = state.processed_seq;
        tokio::select! {
            _ = service.wait_for_event_after(processed_seq) => {}
            _ = tokio::time::sleep(TIMELINE_FOLLOW_HEARTBEAT_INTERVAL) => {
                return Some((Ok(Bytes::from_static(b"\n")), state));
            }
        }
    }
}

fn collect_timeline_stream_events(state: &mut TimelineStreamState, page: TimelineForwardPage) {
    for event in page.events {
        state.processed_seq = event.seq;
        state.pending.push_back(timeline_event_line(&event));
    }
    state.processed_seq = EventCursor::parse_timeline(&page.next_cursor)
        .map(|cursor| cursor.seq())
        .unwrap_or(state.processed_seq);
    state.cursor = page.next_cursor;
}

fn history_boundary_name(boundary: HistoryBoundary) -> &'static str {
    match boundary {
        HistoryBoundary::None => "none",
        HistoryBoundary::Start => "start",
        HistoryBoundary::Expired => "expired",
    }
}

fn timeline_event_line(event: &TimelineEnvelope) -> Bytes {
    let mut line = Vec::new();
    push_timeline_event_line(&mut line, event).expect("timeline envelope should serialize");
    Bytes::from(line)
}

fn timeline_stream_error_line(service: &Service, error: ApiError) -> Bytes {
    let cursor = service.current_event_cursor();
    let seq = cursor.seq();
    let envelope = TimelineEnvelope::new(
        seq,
        cursor,
        timestamp_now(),
        service.thread_id(),
        "service.error",
        TimelineTrace::new(None),
        Some(TimelineItem::new(
            format!("err_evt_{seq}"),
            "error",
            "failed",
        )),
        json!({
            "code": error.code,
            "message": error.message,
            "retryable": error.retryable
        }),
    )
    .expect("current cursor should produce a timeline envelope");
    timeline_event_line(&envelope)
}

fn authorize(headers: &HeaderMap, service_key: Option<&str>) -> Result<(), ApiError> {
    let Some(service_key) = service_key else {
        return Ok(());
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

enum TimelineQuery {
    Forward {
        cursor: String,
        follow: bool,
        limit: usize,
    },
    Backward {
        cursor: String,
        limit: usize,
    },
    Tail {
        limit: usize,
    },
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

#[derive(Debug, Serialize)]
struct FilesUploadResponse {
    ok: bool,
    files: Vec<ExternalFileMetadata>,
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

    fn delivery_store_unavailable() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "delivery_receipt_unavailable", "delivery receipt storage is unavailable", true)
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

    fn from_registry(error: RegistryError) -> Self {
        let status = match error {
            RegistryError::ValueTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            RegistryError::TooManyTopics => StatusCode::TOO_MANY_REQUESTS,
            _ => StatusCode::BAD_REQUEST,
        };
        Self::new(status, error.code(), error.to_string(), false)
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

fn content_disposition(filename: &str) -> String {
    let safe = filename
        .chars()
        .map(|ch| match ch {
            '"' | '\\' => '_',
            ch if ch.is_ascii_graphic() || ch == ' ' => ch,
            _ => '_',
        })
        .collect::<String>();
    format!("attachment; filename=\"{safe}\"")
}

fn bounded_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
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
