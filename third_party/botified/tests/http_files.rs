#![allow(dead_code)]

mod support;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use botified::files::{FileStore, FileStoreOptions};
use botified::http::{router, MAX_HTTP_JSON_BYTES};
use botified::{AgentConfig, ProviderResponse, Service, StopReason};
use serde_json::{json, Value};
use support::ScriptedProvider;
use tower::ServiceExt;

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[tokio::test]
async fn files_api_requires_service_key_and_uploads_single_multi_and_empty_files() {
    let app = test_app(
        FileStoreOptions::new(temp_dir("auth-upload")),
        Some("secret"),
    );

    let unauthorized = app
        .clone()
        .oneshot(multipart_request(
            "/v1/files",
            &[part("one.txt", "text/plain", b"one")],
            None,
        ))
        .await
        .expect("unauthorized upload completes");
    assert_json_error(unauthorized, StatusCode::UNAUTHORIZED, "unauthorized").await;

    let upload = app
        .clone()
        .oneshot(multipart_request(
            "/v1/files",
            &[
                part("one.txt", "text/plain", b"one"),
                part("two.bin", "application/octet-stream", b"two"),
                part("empty.txt", "text/plain", b""),
            ],
            Some("secret"),
        ))
        .await
        .expect("upload completes");
    assert_eq!(upload.status(), StatusCode::OK);
    let raw = response_bytes(upload).await;
    let text = String::from_utf8(raw.to_vec()).expect("json utf8");
    assert!(!text.contains("agent_path"));
    let body: Value = serde_json::from_str(&text).expect("json body");
    assert_eq!(body["ok"], true);
    assert_eq!(body["files"].as_array().expect("files").len(), 3);
    assert_eq!(body["files"][0]["filename"], "one.txt");
    assert_eq!(body["files"][2]["size_bytes"], 0);
    assert_eq!(body["files"][2]["sha256"], EMPTY_SHA256);
}

#[tokio::test]
async fn files_api_downloads_bytes_with_headers_and_sha256() {
    let app = test_app(FileStoreOptions::new(temp_dir("download")), Some("secret"));
    let upload = app
        .clone()
        .oneshot(multipart_request(
            "/v1/files",
            &[part("report.txt", "text/plain", b"hello")],
            Some("secret"),
        ))
        .await
        .expect("upload completes");
    let file_id = response_json(upload).await["files"][0]["file_id"]
        .as_str()
        .expect("file id")
        .to_owned();

    let download = app
        .clone()
        .oneshot(raw_request(
            Method::GET,
            &format!("/v1/files/{file_id}"),
            None,
            Some("secret"),
        ))
        .await
        .expect("download completes");

    assert_eq!(download.status(), StatusCode::OK);
    assert_eq!(download.headers()[header::CONTENT_TYPE], "text/plain");
    assert_eq!(download.headers()[header::CONTENT_LENGTH], "5");
    assert_eq!(
        download.headers()["x-botified-sha256"],
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    assert!(download.headers()[header::CONTENT_DISPOSITION]
        .to_str()
        .expect("content-disposition")
        .contains("report.txt"));
    assert_eq!(response_bytes(download).await.as_ref(), b"hello");
}

#[tokio::test]
async fn files_api_returns_structured_errors_for_bad_missing_and_expired_ids() {
    let app = test_app(
        FileStoreOptions::new(temp_dir("errors")).with_retention_secs(0),
        Some("secret"),
    );

    let bad_id = app
        .clone()
        .oneshot(raw_request(
            Method::GET,
            "/v1/files/not-a-file",
            None,
            Some("secret"),
        ))
        .await
        .expect("bad id completes");
    assert_json_error(bad_id, StatusCode::BAD_REQUEST, "invalid_file_id").await;

    let missing = app
        .clone()
        .oneshot(raw_request(
            Method::GET,
            "/v1/files/file_00000000000000000000000000000000",
            None,
            Some("secret"),
        ))
        .await
        .expect("missing completes");
    assert_json_error(missing, StatusCode::NOT_FOUND, "file_not_found").await;

    let upload = app
        .clone()
        .oneshot(multipart_request(
            "/v1/files",
            &[part("old.txt", "text/plain", b"old")],
            Some("secret"),
        ))
        .await
        .expect("upload completes");
    let file_id = response_json(upload).await["files"][0]["file_id"]
        .as_str()
        .expect("file id")
        .to_owned();

    let expired = app
        .oneshot(raw_request(
            Method::GET,
            &format!("/v1/files/{file_id}"),
            None,
            Some("secret"),
        ))
        .await
        .expect("expired completes");
    assert_json_error(expired, StatusCode::GONE, "file_expired").await;
}

#[tokio::test]
async fn file_upload_limit_is_route_specific_and_json_limit_stays_independent() {
    let tiny_file_limit_app = test_app(
        FileStoreOptions::new(temp_dir("tiny-limit")).with_max_upload_request_bytes(512),
        None,
    );

    let json_under_global_over_file_limit = tiny_file_limit_app
        .clone()
        .oneshot(raw_request(
            Method::POST,
            "/v1/messages",
            Some(json!({"text": "x".repeat(800)}).to_string()),
            None,
        ))
        .await
        .expect("message completes");
    assert_eq!(json_under_global_over_file_limit.status(), StatusCode::OK);

    let upload_over_file_limit = tiny_file_limit_app
        .oneshot(multipart_request(
            "/v1/files",
            &[part(
                "large.bin",
                "application/octet-stream",
                &vec![b'x'; 800],
            )],
            None,
        ))
        .await
        .expect("large upload completes");
    assert_json_error(
        upload_over_file_limit,
        StatusCode::PAYLOAD_TOO_LARGE,
        "upload_too_large",
    )
    .await;

    let large_file_limit_app = test_app(
        FileStoreOptions::new(temp_dir("large-limit"))
            .with_max_upload_request_bytes((MAX_HTTP_JSON_BYTES + 2 * 1024 * 1024) as u64)
            .with_max_file_bytes((MAX_HTTP_JSON_BYTES + 1024 * 1024) as u64),
        None,
    );

    let large_file = vec![b'z'; MAX_HTTP_JSON_BYTES + 1024];
    let upload_over_json_limit = large_file_limit_app
        .clone()
        .oneshot(multipart_request(
            "/v1/files",
            &[part("big.bin", "application/octet-stream", &large_file)],
            None,
        ))
        .await
        .expect("large upload under files limit completes");
    assert_eq!(upload_over_json_limit.status(), StatusCode::OK);

    let oversized_json = format!("{{\"text\":\"{}\"}}", "x".repeat(MAX_HTTP_JSON_BYTES));
    let message_over_json_limit = large_file_limit_app
        .oneshot(raw_request(
            Method::POST,
            "/v1/messages",
            Some(oversized_json),
            None,
        ))
        .await
        .expect("oversized json completes");
    assert_json_error(
        message_over_json_limit,
        StatusCode::PAYLOAD_TOO_LARGE,
        "body_too_large",
    )
    .await;
}

#[tokio::test]
async fn multi_file_upload_is_all_or_none_when_one_part_fails() {
    let root = temp_dir("rollback");
    let app = test_app(
        FileStoreOptions::new(root.clone())
            .with_max_file_bytes(4)
            .with_max_upload_request_bytes(2048),
        None,
    );

    let response = app
        .oneshot(multipart_request(
            "/v1/files",
            &[
                part("ok.txt", "text/plain", b"ok"),
                part("too-large.txt", "text/plain", b"12345"),
            ],
            None,
        ))
        .await
        .expect("upload completes");
    assert_json_error(response, StatusCode::PAYLOAD_TOO_LARGE, "file_too_large").await;

    let object_count = fs::read_dir(root.join("objects"))
        .expect("objects dir")
        .count();
    let metadata_count = fs::read_dir(root.join("metadata"))
        .expect("metadata dir")
        .count();
    assert_eq!(object_count, 0);
    assert_eq!(metadata_count, 0);
}

fn test_app(options: FileStoreOptions, service_key: Option<&str>) -> axum::Router {
    let provider = Arc::new(ScriptedProvider::new(vec![Ok(provider_response("ok"))]));
    let store = FileStore::open(options).expect("open file store");
    let service = Service::with_file_store(AgentConfig::new("system"), provider, Vec::new(), store);
    router(service, service_key.map(ToOwned::to_owned))
}

fn provider_response(text: &str) -> ProviderResponse {
    ProviderResponse {
        text: Some(text.to_owned()),
        tool_calls: Vec::new(),
        assistant_replay: None,
        usage: None,
        stop_reason: StopReason::EndTurn,
        metadata: None,
    }
}

struct MultipartPart<'a> {
    filename: &'a str,
    content_type: &'a str,
    bytes: &'a [u8],
}

fn part<'a>(filename: &'a str, content_type: &'a str, bytes: &'a [u8]) -> MultipartPart<'a> {
    MultipartPart {
        filename,
        content_type,
        bytes,
    }
}

fn multipart_request(
    uri: &str,
    parts: &[MultipartPart<'_>],
    bearer: Option<&str>,
) -> Request<Body> {
    let boundary = "botified-test-boundary";
    let mut body = Vec::new();
    for part in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n",
                part.filename
            )
            .as_bytes(),
        );
        body.extend_from_slice(format!("Content-Type: {}\r\n\r\n", part.content_type).as_bytes());
        body.extend_from_slice(part.bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let mut builder = Request::builder().method(Method::POST).uri(uri).header(
        header::CONTENT_TYPE,
        format!("multipart/form-data; boundary={boundary}"),
    );
    if let Some(token) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(Body::from(body)).expect("multipart request")
}

fn raw_request(
    method: Method,
    uri: &str,
    body: Option<String>,
    bearer: Option<&str>,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .expect("request"),
        None => builder.body(Body::empty()).expect("request"),
    }
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = response_bytes(response).await;
    serde_json::from_slice(&bytes).expect("json body")
}

async fn response_bytes(response: axum::response::Response) -> axum::body::Bytes {
    to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("read response body")
}

async fn assert_json_error(response: axum::response::Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"]["code"], code);
}

fn temp_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "botified-http-files-test-{name}-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}
