mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use botified::files::{FileStore, FileStoreOptions};
use botified::http::router;
use botified::session::open_or_create_session_in_home;
use botified::{
    AgentConfig, ContentPart, FileRecord, FileSource, Message, MessageFileBinding, ModelInput,
    ProviderRequest, ProviderResponse, Service, ServiceLimits, ServiceState,
};
use serde_json::{json, Value};
use support::{BlockingProvider, ScriptedProvider};
use tower::ServiceExt;

const UPLOADED_MARKER: &[u8] = b"UPLOADED_FILE_CONTENT_MARKER";
const UPLOADED_MARKER_BASE64: &str = "VVBMT0FERURfRklMRV9DT05URU5UX01BUktFUg==";

#[tokio::test]
async fn valid_file_ref_binds_before_enqueue_and_provider_sees_manifest_only() {
    let provider = Arc::new(ScriptedProvider::new(vec![Ok(ProviderResponse::text(
        "ok",
    ))]));
    let store = FileStore::open(FileStoreOptions::new(temp_dir("valid-ref")))
        .expect("file store should open");
    let service = Service::with_file_store(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        store,
    );
    let app = router(service.clone(), None);
    let file_id = upload_file(&app, "report.txt", "text/plain", UPLOADED_MARKER).await;

    let accepted = app
        .clone()
        .oneshot(json_request(json!({
            "client_message_id": "file-message",
            "items": [
                { "type": "text", "text": "Summarize the attached file only if needed." },
                { "type": "file", "file_id": file_id }
            ]
        })))
        .await
        .expect("message request should complete");
    assert_eq!(accepted.status(), StatusCode::OK);
    let body = response_json(accepted).await;
    assert_eq!(body["kind"], "input_accepted");
    assert_eq!(
        body["content_preview"],
        "Summarize the attached file only if needed.\n[file report.txt text/plain 28 bytes]"
    );
    assert_eq!(body["content_kind"], "mixed");
    assert_eq!(body["content_bytes"], 71);

    service.wait_for_state(ServiceState::Idle).await;
    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    let transcript_text = transcript_text(&requests[0]);
    assert!(transcript_text.contains("Attached file manifest:"));
    assert!(transcript_text.contains("- message_id: file-message"));
    assert!(transcript_text.contains("- input_id: file-message"));
    assert!(transcript_text.contains("- content_index: 1"));
    assert!(transcript_text.contains("- filename: report.txt"));
    assert!(transcript_text.contains("- mime_type: text/plain"));
    assert!(transcript_text.contains("- size_bytes: 28"));
    assert!(transcript_text.contains("- source: upload"));
    assert!(transcript_text.contains("- available: true"));
    assert!(transcript_text.contains("- agent_path: "));
    assert!(transcript_text.contains("Content has not been read."));
    assert!(!transcript_text.contains("UPLOADED_FILE_CONTENT_MARKER"));
    assert!(!transcript_text.contains(UPLOADED_MARKER_BASE64));
}

#[tokio::test]
async fn large_file_ref_within_file_limits_queues_by_manifest_bytes() {
    let provider = Arc::new(BlockingProvider::new(
        1,
        vec![
            Ok(ProviderResponse::text("first")),
            Ok(ProviderResponse::text("second")),
        ],
    ));
    let large_file_len = 64 * 1024;
    let store = FileStore::open(
        FileStoreOptions::new(temp_dir("large-ref-queue"))
            .with_max_file_bytes((large_file_len + 1) as u64)
            .with_max_message_referenced_file_bytes((large_file_len + 1) as u64),
    )
    .expect("file store should open");
    let service = Service::with_file_store_and_limits(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        store,
        ServiceLimits::new(32).with_max_queue_bytes(4096),
    );
    let app = router(service.clone(), None);
    let raw_marker = b"LARGE_FILE_RAW_CONTENT_MARKER";
    let mut large_file = vec![b'x'; large_file_len];
    large_file[..raw_marker.len()].copy_from_slice(raw_marker);
    let file_id = upload_file(&app, "large.txt", "text/plain", &large_file).await;

    let started = app
        .clone()
        .oneshot(json_request(json!({
            "client_message_id": "active-turn",
            "text": "start"
        })))
        .await
        .expect("first message request should complete");
    assert_eq!(started.status(), StatusCode::OK);
    provider.wait_for_call_count(1).await;
    provider.wait_for_blocked_call_count(1).await;

    let queued = app
        .clone()
        .oneshot(json_request(json!({
            "client_message_id": "large-file-queued",
            "items": [{ "type": "file", "file_id": file_id }]
        })))
        .await
        .expect("large file message request should complete");
    assert_eq!(queued.status(), StatusCode::OK);
    let body = response_json(queued).await;
    assert_eq!(body["kind"], "input_queued");
    assert_eq!(body["queue_length"], 1);

    provider.release();
    service.wait_for_state(ServiceState::Idle).await;

    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    let transcript_text = transcript_text(&requests[1]);
    assert!(transcript_text.contains("Attached file manifest:"));
    assert!(transcript_text.contains("- message_id: large-file-queued"));
    assert!(transcript_text.contains("- filename: large.txt"));
    assert!(transcript_text.contains("- size_bytes: 65536"));
    assert!(transcript_text.contains("Content has not been read."));
    assert!(!transcript_text.contains("LARGE_FILE_RAW_CONTENT_MARKER"));
}

#[tokio::test]
async fn file_only_message_is_accepted_and_summarized_as_file() {
    let provider = Arc::new(ScriptedProvider::new(vec![Ok(ProviderResponse::text(
        "ok",
    ))]));
    let store = FileStore::open(FileStoreOptions::new(temp_dir("file-only")))
        .expect("file store should open");
    let service = Service::with_file_store(AgentConfig::new("system"), provider, Vec::new(), store);
    let app = router(service.clone(), None);
    let file_id = upload_file(&app, "image.png", "image/png", b"png bytes").await;

    let accepted = app
        .oneshot(json_request(json!({
            "client_message_id": "file-only",
            "items": [{ "type": "file", "file_id": file_id }]
        })))
        .await
        .expect("message request should complete");
    assert_eq!(accepted.status(), StatusCode::OK);
    let body = response_json(accepted).await;
    assert_eq!(
        body["content_preview"],
        "[file image.png image/png 9 bytes]"
    );
    assert_eq!(body["content_bytes"], 9);
    assert_eq!(body["content_kind"], "file");

    service.wait_for_state(ServiceState::Idle).await;
}

#[tokio::test]
async fn missing_and_expired_file_refs_reject_before_enqueue() {
    let provider = Arc::new(ScriptedProvider::new(vec![Ok(ProviderResponse::text(
        "must not run",
    ))]));
    let store = FileStore::open(FileStoreOptions::new(temp_dir("missing-expired")))
        .expect("file store should open");
    let service = Service::with_file_store(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        store,
    );
    let app = router(service.clone(), None);

    let invalid = app
        .clone()
        .oneshot(json_request(json!({
            "client_message_id": "invalid-file",
            "items": [{ "type": "file", "file_id": "not-a-file-id" }]
        })))
        .await
        .expect("invalid file request should complete");
    assert_json_error(invalid, StatusCode::BAD_REQUEST, "invalid_file_id").await;
    assert_eq!(service.status().queue_length, 0);
    assert!(provider.requests().is_empty());

    let missing = app
        .clone()
        .oneshot(json_request(json!({
            "client_message_id": "missing-file",
            "items": [{ "type": "file", "file_id": "file_00000000000000000000000000000000" }]
        })))
        .await
        .expect("missing file request should complete");
    assert_json_error(missing, StatusCode::NOT_FOUND, "file_not_found").await;
    assert_eq!(service.status().queue_length, 0);
    assert!(provider.requests().is_empty());

    let expired_store =
        FileStore::open(FileStoreOptions::new(temp_dir("expired-ref")).with_retention_secs(0))
            .expect("expired store should open");
    let expired_service = Service::with_file_store(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        expired_store,
    );
    let expired_app = router(expired_service.clone(), None);
    let expired_file = upload_file(&expired_app, "old.txt", "text/plain", b"old").await;
    let expired = expired_app
        .oneshot(json_request(json!({
            "client_message_id": "expired-file",
            "items": [{ "type": "file", "file_id": expired_file }]
        })))
        .await
        .expect("expired file request should complete");
    assert_json_error(expired, StatusCode::GONE, "file_expired").await;
    assert_eq!(expired_service.status().queue_length, 0);
    assert!(provider.requests().is_empty());
}

#[tokio::test]
async fn invalid_multi_file_ref_does_not_touch_previously_valid_ref() {
    let root = temp_dir("invalid-multi-no-touch");
    let provider = Arc::new(ScriptedProvider::new(vec![Ok(ProviderResponse::text(
        "must not run",
    ))]));
    let store = FileStore::open(FileStoreOptions::new(root.clone()).with_retention_secs(3600))
        .expect("file store should open");
    let record = store
        .store_bytes(
            "valid.txt",
            Some("text/plain"),
            b"valid",
            FileSource::Upload,
            None,
        )
        .expect("store file");
    let shortened_until = unix_now_secs().saturating_add(120);
    write_retained_until(&root, &record, shortened_until);
    let service = Service::with_file_store(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        store,
    );
    let app = router(service.clone(), None);

    let rejected = app
        .oneshot(json_request(json!({
            "client_message_id": "mixed-valid-missing",
            "items": [
                { "type": "file", "file_id": record.file_id },
                { "type": "file", "file_id": "file_00000000000000000000000000000000" }
            ]
        })))
        .await
        .expect("message request should complete");

    assert_json_error(rejected, StatusCode::NOT_FOUND, "file_not_found").await;
    assert_eq!(
        read_metadata_record(&root, &record.file_id).retained_until,
        shortened_until
    );
    assert_eq!(service.status().queue_length, 0);
    assert!(provider.requests().is_empty());
}

#[tokio::test]
async fn invalid_file_ref_does_not_persist_session_entry() {
    let home = temp_dir("invalid-session-home");
    let session =
        open_or_create_session_in_home("invalid-file-session", &home).expect("session open");
    let session_path = session.path().to_path_buf();
    let provider = Arc::new(ScriptedProvider::new(vec![Ok(ProviderResponse::text(
        "must not run",
    ))]));
    let store = FileStore::open(FileStoreOptions::new(temp_dir("invalid-session-files")))
        .expect("file store should open");
    let service = Service::with_session_replay_and_restart_boundary_and_limits_and_file_store(
        AgentConfig::new("system").with_session("invalid-file-session"),
        provider.clone(),
        Vec::new(),
        session.initial_messages().to_vec(),
        session.pending_messages().to_vec(),
        session.known_user_messages().to_vec(),
        session.message_cursors().to_vec(),
        None,
        Some(session.recorder()),
        session.warnings().to_vec(),
        ServiceLimits::default(),
        store,
    );
    let app = router(service.clone(), None);

    let response = app
        .oneshot(json_request(json!({
            "client_message_id": "invalid-session-file",
            "items": [{ "type": "file", "file_id": "file_00000000000000000000000000000000" }]
        })))
        .await
        .expect("invalid file ref should complete");

    assert_json_error(response, StatusCode::NOT_FOUND, "file_not_found").await;
    assert_eq!(service.status().queue_length, 0);
    assert!(provider.requests().is_empty());
    let session_jsonl = fs::read_to_string(session_path).expect("session should read");
    assert!(!session_jsonl.contains("invalid-session-file"));
    assert!(!session_jsonl.contains("\"type\":\"file\""));
}

#[tokio::test]
async fn unreferenced_upload_is_invisible_to_provider() {
    let provider = Arc::new(ScriptedProvider::new(vec![Ok(ProviderResponse::text(
        "ok",
    ))]));
    let store = FileStore::open(FileStoreOptions::new(temp_dir("unreferenced")))
        .expect("file store should open");
    let service = Service::with_file_store(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        store,
    );
    let app = router(service.clone(), None);
    let _file_id = upload_file(
        &app,
        "secret.txt",
        "text/plain",
        b"UNREFERENCED_UPLOAD_MARKER",
    )
    .await;

    let accepted = app
        .oneshot(json_request(json!({
            "client_message_id": "plain-after-upload",
            "text": "plain question"
        })))
        .await
        .expect("message request should complete");
    assert_eq!(accepted.status(), StatusCode::OK);
    service.wait_for_state(ServiceState::Idle).await;

    let transcript_text = transcript_text(&provider.requests()[0]);
    assert!(transcript_text.contains("plain question"));
    assert!(!transcript_text.contains("secret.txt"));
    assert!(!transcript_text.contains("UNREFERENCED_UPLOAD_MARKER"));
    assert!(!transcript_text.contains("Attached file manifest:"));
}

#[tokio::test]
async fn session_persists_binding_metadata_without_uploaded_bytes() {
    let home = temp_dir("session-home");
    let session =
        open_or_create_session_in_home("file-session", &home).expect("session should open");
    let session_path = session.path().to_path_buf();
    let provider = Arc::new(ScriptedProvider::new(vec![Ok(ProviderResponse::text(
        "ok",
    ))]));
    let store =
        FileStore::open(FileStoreOptions::new(temp_dir("session-files"))).expect("store open");
    let service = Service::with_session_replay_and_restart_boundary_and_limits_and_file_store(
        AgentConfig::new("system").with_session("file-session"),
        provider,
        Vec::new(),
        session.initial_messages().to_vec(),
        session.pending_messages().to_vec(),
        session.known_user_messages().to_vec(),
        session.message_cursors().to_vec(),
        None,
        Some(session.recorder()),
        session.warnings().to_vec(),
        ServiceLimits::default(),
        store,
    );
    let app = router(service.clone(), None);
    let file_id = upload_file(&app, "private.txt", "text/plain", UPLOADED_MARKER).await;

    let accepted = app
        .oneshot(json_request(json!({
            "client_message_id": "session-file",
            "items": [{ "type": "file", "file_id": file_id }]
        })))
        .await
        .expect("message request should complete");
    assert_eq!(accepted.status(), StatusCode::OK);
    service.wait_for_state(ServiceState::Idle).await;

    let session_jsonl = fs::read_to_string(session_path).expect("session should read");
    assert!(session_jsonl.contains("\"type\":\"file\""));
    assert!(session_jsonl.contains("\"message_id\":\"session-file\""));
    assert!(session_jsonl.contains("\"input_id\":\"session-file\""));
    assert!(session_jsonl.contains("\"filename\":\"private.txt\""));
    assert!(session_jsonl.contains("\"mime_type\":\"text/plain\""));
    assert!(session_jsonl.contains("\"size_bytes\":28"));
    assert!(session_jsonl.contains("\"sha256\""));
    assert!(session_jsonl.contains("\"source\":\"upload\""));
    assert!(session_jsonl.contains("\"agent_path\""));
    assert!(session_jsonl.contains("\"available\":true"));
    assert!(!session_jsonl.contains("UPLOADED_FILE_CONTENT_MARKER"));
    assert!(!session_jsonl.contains(UPLOADED_MARKER_BASE64));
}

#[tokio::test]
async fn stale_history_binding_renders_unavailable_and_does_not_block_text_turn() {
    let provider = Arc::new(ScriptedProvider::new(vec![Ok(ProviderResponse::text(
        "ok",
    ))]));
    let stale = MessageFileBinding::available(
        "old-file",
        "old-file",
        0,
        "file_0123456789abcdef0123456789abcdef",
        "old.txt",
        "text/plain",
        4,
        "sha",
        FileSource::Upload,
        None,
        Some("/tmp/missing".to_owned()),
    )
    .unavailable("file_expired");
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        vec![Message::user(vec![ContentPart::file(stale)])],
        None,
    );
    let app = router(service.clone(), None);

    let accepted = app
        .oneshot(json_request(json!({
            "client_message_id": "after-stale",
            "text": "continue with text"
        })))
        .await
        .expect("message request should complete");
    assert_eq!(accepted.status(), StatusCode::OK);
    service.wait_for_state(ServiceState::Idle).await;

    let transcript_text = transcript_text(&provider.requests()[0]);
    assert!(transcript_text.contains("Attached file manifest:"));
    assert!(transcript_text.contains("- message_id: old-file"));
    assert!(transcript_text.contains("- available: false"));
    assert!(transcript_text.contains("- unavailable_reason: file_expired"));
    assert!(!transcript_text.contains("- agent_path: "));
    assert!(transcript_text.contains("continue with text"));
}

#[tokio::test]
async fn stale_store_file_bindings_render_unavailable_without_blocking_text_turn() {
    let root = temp_dir("store-stale-history");
    let provider = Arc::new(ScriptedProvider::new(vec![Ok(ProviderResponse::text(
        "ok",
    ))]));
    let store = FileStore::open(FileStoreOptions::new(root.clone()).with_retention_secs(3600))
        .expect("file store should open");
    let missing_object = store
        .store_bytes(
            "missing-object.txt",
            Some("text/plain"),
            b"missing object",
            FileSource::Upload,
            None,
        )
        .expect("store missing object");
    let expired = store
        .store_bytes(
            "expired-metadata.txt",
            Some("text/plain"),
            b"expired metadata",
            FileSource::Upload,
            None,
        )
        .expect("store expired metadata");
    let missing_binding = binding_from_record("old-missing", 0, &missing_object);
    let expired_binding = binding_from_record("old-expired", 1, &expired);
    fs::remove_file(&missing_object.agent_path).expect("remove object");
    write_retained_until(&root, &expired, unix_now_secs().saturating_sub(1));
    let service = Service::with_session_replay_and_restart_boundary_and_limits_and_file_store(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        vec![Message::user(vec![
            ContentPart::file(missing_binding),
            ContentPart::file(expired_binding),
        ])],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        None,
        None,
        Vec::new(),
        ServiceLimits::default(),
        store,
    );

    service
        .enqueue(
            "after-real-stale",
            vec![ContentPart::text("continue with text")],
        )
        .await
        .expect("text turn should enqueue");
    service.wait_for_state(ServiceState::Idle).await;

    let transcript_text = transcript_text(&provider.requests()[0]);
    assert!(transcript_text.contains("- message_id: old-missing"));
    assert!(transcript_text.contains("- filename: missing-object.txt"));
    assert!(transcript_text.contains("- unavailable_reason: file_object_missing"));
    assert!(transcript_text.contains("- message_id: old-expired"));
    assert!(transcript_text.contains("- filename: expired-metadata.txt"));
    assert!(transcript_text.contains("- unavailable_reason: file_expired"));
    assert!(transcript_text.contains("- available: false"));
    assert!(!transcript_text.contains("- agent_path: "));
    assert!(transcript_text.contains("continue with text"));
}

async fn upload_file(
    app: &axum::Router,
    filename: &str,
    content_type: &str,
    bytes: &[u8],
) -> String {
    let response = app
        .clone()
        .oneshot(multipart_request(filename, content_type, bytes))
        .await
        .expect("upload request should complete");
    assert_eq!(response.status(), StatusCode::OK);
    response_json(response).await["files"][0]["file_id"]
        .as_str()
        .expect("file_id should be present")
        .to_owned()
}

fn multipart_request(filename: &str, content_type: &str, bytes: &[u8]) -> Request<Body> {
    let boundary = "botified-provider-manifest-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    Request::builder()
        .method(Method::POST)
        .uri("/v1/files")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .expect("multipart request should build")
}

fn json_request(body: Value) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri("/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("json request should build")
}

async fn assert_json_error(response: axum::response::Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"]["code"], code);
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body should read");
    serde_json::from_slice(&bytes).expect("body should be json")
}

fn transcript_text(request: &ProviderRequest) -> String {
    request
        .model_input()
        .into_iter()
        .filter_map(|input| match input {
            ModelInput::Message {
                message: Message::User { content },
            } => Some(
                content
                    .into_iter()
                    .filter_map(|part| match part {
                        ContentPart::Text { text } => Some(text),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn binding_from_record(
    message_id: &str,
    content_index: usize,
    record: &FileRecord,
) -> MessageFileBinding {
    MessageFileBinding::available(
        message_id,
        message_id,
        content_index,
        record.file_id.clone(),
        record.filename.clone(),
        record.mime_type.clone(),
        record.size_bytes,
        record.sha256.clone(),
        record.source,
        record.description.clone(),
        Some(record.agent_path.display().to_string()),
    )
}

fn write_retained_until(root: &Path, record: &FileRecord, retained_until: u64) {
    let mut updated = record.clone();
    updated.retained_until = retained_until;
    let mut bytes = serde_json::to_vec_pretty(&updated).expect("metadata should serialize");
    bytes.push(b'\n');
    fs::write(metadata_path(root, &record.file_id), bytes).expect("metadata should write");
}

fn read_metadata_record(root: &Path, file_id: &str) -> FileRecord {
    let raw = fs::read(metadata_path(root, file_id)).expect("metadata should read");
    serde_json::from_slice(&raw).expect("metadata should parse")
}

fn metadata_path(root: &Path, file_id: &str) -> PathBuf {
    root.join("metadata").join(format!("{file_id}.json"))
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should be after epoch")
        .as_secs()
}

fn temp_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time should be after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "botified-provider-manifest-{name}-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}
