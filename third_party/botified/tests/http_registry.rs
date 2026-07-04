#[allow(dead_code)]
mod support;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use botified::http::router;
use botified::registry::RegistryStoreOptions;
use botified::{AgentConfig, ProviderResponse, RegistryConfig, RegistryStore, Service};
use serde_json::{json, Value};
use support::ScriptedProvider;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use tower::ServiceExt;

fn registry_config() -> RegistryConfig {
    RegistryConfig {
        retention: Duration::from_secs(60),
        default_ttl: Duration::from_secs(30),
        max_topics: 32,
        max_topic_len: 128,
        max_source_len: 64,
        max_value_bytes: 4096,
        max_history_items: 256,
        max_history_bytes: 64 * 1024,
        default_query_limit: 16,
        max_query_limit: 64,
        max_response_bytes: 64 * 1024,
    }
}

fn registry_store() -> RegistryStore {
    RegistryStore::new(registry_config()).expect("registry config should be valid")
}

fn registry_store_with_ws_limit(websocket_max_frame_bytes: usize) -> RegistryStore {
    RegistryStore::with_options(
        registry_config(),
        RegistryStoreOptions::default().with_websocket_max_frame_bytes(websocket_max_frame_bytes),
    )
    .expect("registry config should be valid")
}

fn app_with_registry(service_key: Option<&str>) -> (axum::Router, Service) {
    app_with_registry_store(service_key, registry_store())
}

fn app_with_registry_store(
    service_key: Option<&str>,
    registry_store: RegistryStore,
) -> (axum::Router, Service) {
    let provider = Arc::new(ScriptedProvider::new(Vec::new()));
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("http-registry-test"),
        provider,
        Vec::new(),
        registry_store,
    );
    let app = router(service.clone(), service_key.map(ToOwned::to_owned));
    (app, service)
}

fn app_without_registry(service_key: Option<&str>) -> (axum::Router, Service) {
    let provider = Arc::new(ScriptedProvider::new(vec![Ok(ProviderResponse::text(
        "unused",
    ))]));
    let service = Service::new(
        AgentConfig::new("system").with_session("http-registry-disabled"),
        provider,
        Vec::new(),
    );
    let app = router(service.clone(), service_key.map(ToOwned::to_owned));
    (app, service)
}

fn request(method: Method, uri: &str, bearer: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(Body::empty()).expect("request should build")
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = response_bytes(response).await;
    serde_json::from_slice(&bytes).expect("body should be json")
}

async fn response_bytes(response: axum::response::Response) -> Vec<u8> {
    to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body should read")
        .to_vec()
}

async fn assert_http_error(response: axum::response::Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"]["code"], code);
    assert!(body["error"]["message"].is_string());
}

struct TestServer {
    addr: SocketAddr,
    handle: JoinHandle<()>,
}

impl TestServer {
    async fn spawn(app: axum::Router) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let addr = listener.local_addr().expect("listener should have addr");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("test server should run");
        });
        Self { addr, handle }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

#[derive(Debug)]
struct WsClient {
    stream: TcpStream,
}

impl WsClient {
    async fn connect(
        addr: SocketAddr,
        path: &str,
        bearer: Option<&str>,
    ) -> Result<Self, StatusCode> {
        let mut stream = TcpStream::connect(addr)
            .await
            .expect("websocket tcp connect should succeed");
        let auth = bearer
            .map(|token| format!("Authorization: Bearer {token}\r\n"))
            .unwrap_or_default();
        let request = format!(
            "GET {path} HTTP/1.1\r\n\
             Host: {addr}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             {auth}\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .await
            .expect("handshake request should write");
        let response = read_http_response_head(&mut stream).await;
        let status = parse_status(&response);
        if status == StatusCode::SWITCHING_PROTOCOLS {
            Ok(Self { stream })
        } else {
            Err(status)
        }
    }

    async fn send_json(&mut self, value: Value) -> Value {
        self.send_text(&value.to_string()).await;
        self.read_json().await
    }

    async fn send_json_text(&mut self, value: Value) -> String {
        self.send_text(&value.to_string()).await;
        self.read_text().await
    }

    async fn send_text(&mut self, text: &str) {
        write_client_text_frame(&mut self.stream, text.as_bytes()).await;
    }

    async fn read_json(&mut self) -> Value {
        let text = self.read_text().await;
        serde_json::from_str(&text).expect("websocket response should be json")
    }

    async fn read_text(&mut self) -> String {
        read_server_text_frame(&mut self.stream).await
    }
}

async fn read_http_response_head(stream: &mut TcpStream) -> String {
    let mut buffer = Vec::new();
    let mut byte = [0_u8; 1];
    timeout(Duration::from_secs(2), async {
        loop {
            stream
                .read_exact(&mut byte)
                .await
                .expect("handshake response should read");
            buffer.push(byte[0]);
            if buffer.ends_with(b"\r\n\r\n") {
                break;
            }
        }
    })
    .await
    .expect("handshake response should arrive");
    String::from_utf8(buffer).expect("handshake response should be utf8")
}

fn parse_status(response: &str) -> StatusCode {
    let line = response
        .lines()
        .next()
        .expect("response should have status line");
    let code = line
        .split_whitespace()
        .nth(1)
        .expect("status line should include code");
    StatusCode::from_u16(code.parse().expect("status should be numeric"))
        .expect("status should be valid")
}

async fn write_client_text_frame(stream: &mut TcpStream, payload: &[u8]) {
    let mut frame = Vec::new();
    frame.push(0x81);
    if payload.len() <= 125 {
        frame.push(0x80 | payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    let mask = [0x11, 0x22, 0x33, 0x44];
    frame.extend_from_slice(&mask);
    for (index, byte) in payload.iter().enumerate() {
        frame.push(byte ^ mask[index % mask.len()]);
    }
    stream
        .write_all(&frame)
        .await
        .expect("websocket frame should write");
}

async fn read_server_text_frame(stream: &mut TcpStream) -> String {
    timeout(Duration::from_secs(2), async {
        loop {
            let mut header = [0_u8; 2];
            stream
                .read_exact(&mut header)
                .await
                .expect("websocket frame header should read");
            let opcode = header[0] & 0x0f;
            let masked = header[1] & 0x80 != 0;
            let mut len = (header[1] & 0x7f) as u64;
            if len == 126 {
                let mut bytes = [0_u8; 2];
                stream
                    .read_exact(&mut bytes)
                    .await
                    .expect("websocket extended len should read");
                len = u16::from_be_bytes(bytes) as u64;
            } else if len == 127 {
                let mut bytes = [0_u8; 8];
                stream
                    .read_exact(&mut bytes)
                    .await
                    .expect("websocket extended len should read");
                len = u64::from_be_bytes(bytes);
            }
            let mut mask = [0_u8; 4];
            if masked {
                stream
                    .read_exact(&mut mask)
                    .await
                    .expect("websocket mask should read");
            }
            let mut payload = vec![0_u8; len as usize];
            stream
                .read_exact(&mut payload)
                .await
                .expect("websocket payload should read");
            if masked {
                for (index, byte) in payload.iter_mut().enumerate() {
                    *byte ^= mask[index % mask.len()];
                }
            }
            match opcode {
                0x1 => return String::from_utf8(payload).expect("text frame should be utf8"),
                0x8 => panic!("websocket closed before text response"),
                0x9 | 0xa => continue,
                other => panic!("unexpected websocket opcode {other}"),
            }
        }
    })
    .await
    .expect("websocket text response should arrive")
}

fn assert_ws_error(body: &Value, code: &str) {
    assert_eq!(body["ok"], false);
    assert_eq!(body["op"], "error");
    assert!(
        body.get("id").is_some(),
        "websocket errors must include a stable id field: {body}"
    );
    assert_eq!(body["error"]["code"], code);
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("error message should be string")
            .len()
            <= 256
    );
    assert_eq!(body["error"]["retryable"], false);
}

fn padded_get_frame(min_len: usize) -> String {
    let mut padding = String::new();
    loop {
        let frame = json!({
            "op": "get",
            "id": format!("padded-get-{padding}"),
            "topic": "robot.pose",
        })
        .to_string();
        if frame.len() > min_len {
            return frame;
        }
        padding.push('x');
    }
}

#[tokio::test]
async fn websocket_set_get_history_and_http_debug_happy_path() {
    let (app, _service) = app_with_registry(None);
    let server = TestServer::spawn(app.clone()).await;
    let mut ws = WsClient::connect(server.addr, "/v1/registry/ws", None)
        .await
        .expect("websocket should upgrade");

    let ack = ws
        .send_json(json!({
            "op": "set",
            "id": "set-pose",
            "topic": "robot.pose",
            "value": {"x": 1, "y": 2},
            "source": "localization",
            "ttl_secs": 30,
            "freq_hz": 20.0
        }))
        .await;
    assert_eq!(ack["ok"], true);
    assert_eq!(ack["op"], "ack");
    assert_eq!(ack["id"], "set-pose");
    assert_eq!(ack["topic"], "robot.pose");
    assert_eq!(ack["source"], "localization");
    assert_eq!(ack["writer_kind"], "websocket_client");
    assert!(ack["origin"]
        .as_str()
        .expect("origin should be string")
        .starts_with("ws:"));

    let raw_ack = ws
        .send_json(json!({
            "op": "set",
            "topic": "robot.pose.raw",
            "value": [1, 2, 3],
            "source": "localization"
        }))
        .await;
    assert_eq!(raw_ack["ok"], true);
    assert_eq!(raw_ack["op"], "ack");
    assert_eq!(raw_ack["id"], Value::Null);

    let current = ws
        .send_json(json!({
            "op": "get",
            "id": "get-robot",
            "topic": "robot.**",
            "limit": 10
        }))
        .await;
    assert_eq!(current["ok"], true);
    assert_eq!(current["op"], "snapshot");
    assert_eq!(current["id"], "get-robot");
    assert_eq!(current["matched_count"], 2);
    assert_eq!(current["returned_count"], 2);
    assert_eq!(current["items"][0]["topic"], "robot.pose");
    assert_eq!(current["items"][0]["value"], json!({"x": 1, "y": 2}));

    let history = ws
        .send_json(json!({
            "op": "history",
            "id": "history-robot",
            "topic": "robot.**",
            "since_secs": 60,
            "limit": 10
        }))
        .await;
    assert_eq!(history["ok"], true);
    assert_eq!(history["op"], "history");
    assert_eq!(history["id"], "history-robot");
    assert_eq!(history["matched_count"], 2);
    assert_eq!(history["oldest_seq"], 1);
    assert_eq!(history["newest_seq"], 2);

    let current_without_id = ws
        .send_json(json!({
            "op": "get",
            "topic": "robot.pose"
        }))
        .await;
    assert_eq!(current_without_id["ok"], true);
    assert_eq!(current_without_id["op"], "snapshot");
    assert_eq!(current_without_id["id"], Value::Null);

    let history_without_id = ws
        .send_json(json!({
            "op": "history",
            "topic": "robot.pose",
            "since_secs": 60
        }))
        .await;
    assert_eq!(history_without_id["ok"], true);
    assert_eq!(history_without_id["op"], "history");
    assert_eq!(history_without_id["id"], Value::Null);

    let http_current = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/registry/current?topic=robot.**&limit=10",
            None,
        ))
        .await
        .expect("current request should complete");
    assert_eq!(http_current.status(), StatusCode::OK);
    let http_current = response_json(http_current).await;
    assert_eq!(http_current["ok"], true);
    assert_eq!(http_current["kind"], "registry_get");
    assert_eq!(http_current["matched_count"], 2);

    let http_history = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/registry/history?topic=robot.**&since_secs=60&limit=10",
            None,
        ))
        .await
        .expect("history request should complete");
    assert_eq!(http_history.status(), StatusCode::OK);
    let http_history = response_json(http_history).await;
    assert_eq!(http_history["ok"], true);
    assert_eq!(http_history["kind"], "registry_history");
    assert_eq!(http_history["matched_count"], 2);

    let topics = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/registry/topics?topic=**&limit=10",
            None,
        ))
        .await
        .expect("topics request should complete");
    assert_eq!(topics.status(), StatusCode::OK);
    let topics = response_json(topics).await;
    assert_eq!(topics["ok"], true);
    assert_eq!(topics["kind"], "registry_topics");
    assert_eq!(topics["matched_count"], 2);
    assert_eq!(topics["items"][0]["topic"], "robot.pose");

    let no_http_set = app
        .clone()
        .oneshot(request(Method::POST, "/v1/registry/set", None))
        .await
        .expect("missing set endpoint request should complete");
    assert_eq!(no_http_set.status(), StatusCode::NOT_FOUND);

    let state = app
        .oneshot(request(Method::GET, "/v1/state", None))
        .await
        .expect("state request should complete");
    assert_eq!(state.status(), StatusCode::OK);
    let state = response_json(state).await;
    assert_eq!(state["registry"]["enabled"], true);
    assert_eq!(state["registry"]["active_current_topics"], 2);
    assert!(
        state["active_items"]
            .as_array()
            .expect("active_items should be array")
            .iter()
            .all(|item| item["type"] != "registry"),
        "registry must not appear in active_items: {state}"
    );
}

#[tokio::test]
async fn websocket_frame_limit_comes_from_registry_store_options() {
    let oversized_for_small_limit = padded_get_frame(256);

    let (small_app, _service) = app_with_registry_store(None, registry_store_with_ws_limit(256));
    let small_server = TestServer::spawn(small_app).await;
    let mut small_ws = WsClient::connect(small_server.addr, "/v1/registry/ws", None)
        .await
        .expect("websocket should upgrade");
    small_ws.send_text(&oversized_for_small_limit).await;
    let rejected = small_ws.read_json().await;
    assert_ws_error(&rejected, "frame_too_large");

    let (default_app, _service) = app_with_registry(None);
    let default_server = TestServer::spawn(default_app).await;
    let mut default_ws = WsClient::connect(default_server.addr, "/v1/registry/ws", None)
        .await
        .expect("websocket should upgrade");
    default_ws.send_text(&oversized_for_small_limit).await;
    let accepted_by_default = default_ws.read_json().await;
    assert_eq!(accepted_by_default["ok"], true);
    assert_eq!(accepted_by_default["op"], "snapshot");

    let larger_frame = padded_get_frame(1024);
    let (large_app, _service) =
        app_with_registry_store(None, registry_store_with_ws_limit(larger_frame.len() + 1));
    let large_server = TestServer::spawn(large_app).await;
    let mut large_ws = WsClient::connect(large_server.addr, "/v1/registry/ws", None)
        .await
        .expect("websocket should upgrade");
    large_ws.send_text(&larger_frame).await;
    let accepted_by_large_config = large_ws.read_json().await;
    assert_eq!(accepted_by_large_config["ok"], true);
    assert_eq!(accepted_by_large_config["op"], "snapshot");
}

#[tokio::test]
async fn registry_endpoints_are_404_when_disabled() {
    let (app, _service) = app_without_registry(None);

    for uri in [
        "/v1/registry/current?topic=**",
        "/v1/registry/history?topic=**&since_secs=60",
        "/v1/registry/topics?topic=**",
        "/v1/registry/ws",
    ] {
        let response = app
            .clone()
            .oneshot(request(Method::GET, uri, None))
            .await
            .expect("disabled registry request should complete");
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
    }
}

#[tokio::test]
async fn registry_endpoints_reuse_service_key_auth() {
    let (app, _service) = app_with_registry(Some("secret"));

    let missing = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/registry/current?topic=robot.pose",
            None,
        ))
        .await
        .expect("current request should complete");
    assert_http_error(missing, StatusCode::UNAUTHORIZED, "unauthorized").await;

    let authorized = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/registry/current?topic=robot.pose",
            Some("secret"),
        ))
        .await
        .expect("current request should complete");
    assert_eq!(authorized.status(), StatusCode::OK);

    let server = TestServer::spawn(app).await;
    let ws_missing = WsClient::connect(server.addr, "/v1/registry/ws", None).await;
    assert_eq!(
        ws_missing.expect_err("missing auth should not upgrade"),
        StatusCode::UNAUTHORIZED
    );
    WsClient::connect(server.addr, "/v1/registry/ws", Some("secret"))
        .await
        .expect("authorized websocket should upgrade");
}

#[tokio::test]
async fn websocket_errors_are_structured() {
    let (app, _service) = app_with_registry(None);
    let server = TestServer::spawn(app).await;
    let mut ws = WsClient::connect(server.addr, "/v1/registry/ws", None)
        .await
        .expect("websocket should upgrade");

    ws.send_text("{").await;
    let malformed = ws.read_json().await;
    assert_eq!(malformed["id"], Value::Null);
    assert_ws_error(&malformed, "malformed_json");

    let missing_op = ws.send_json(json!({"id": "missing-op"})).await;
    assert_eq!(missing_op["id"], "missing-op");
    assert_ws_error(&missing_op, "invalid_request");

    let unknown = ws
        .send_json(json!({"op": "delete", "id": "unknown-op", "topic": "robot.pose"}))
        .await;
    assert_eq!(unknown["id"], "unknown-op");
    assert_ws_error(&unknown, "invalid_request");

    let invalid_topic = ws
        .send_json(json!({
            "op": "set",
            "id": "bad-topic",
            "topic": "robot..pose",
            "value": 1,
            "source": "localization"
        }))
        .await;
    assert_eq!(invalid_topic["id"], "bad-topic");
    assert_ws_error(&invalid_topic, "invalid_topic");

    let missing_source = ws
        .send_json(json!({
            "op": "set",
            "id": "missing-source",
            "topic": "robot.pose",
            "value": 1
        }))
        .await;
    assert_eq!(missing_source["id"], "missing-source");
    assert_ws_error(&missing_source, "missing_source");

    let oversized = format!(
        "{{\"op\":\"get\",\"id\":\"oversized\",\"topic\":\"robot.pose\",\"padding\":\"{}\"}}",
        "x".repeat(70 * 1024)
    );
    ws.send_text(&oversized).await;
    let oversized = ws.read_json().await;
    assert_ws_error(&oversized, "frame_too_large");
    assert!(
        oversized.to_string().len() < 1024,
        "oversized-frame error should stay bounded: {oversized}"
    );
}

#[tokio::test]
async fn websocket_subscribe_is_rejected_as_unsupported() {
    let (app, _service) = app_with_registry(None);
    let server = TestServer::spawn(app).await;
    let mut ws = WsClient::connect(server.addr, "/v1/registry/ws", None)
        .await
        .expect("websocket should upgrade");

    let rejected = ws
        .send_json(json!({
            "op": "subscribe",
            "id": "subscribe-robot",
            "topic": "robot.pose"
        }))
        .await;

    assert_eq!(rejected["id"], "subscribe-robot");
    assert_ws_error(&rejected, "invalid_request");
}

#[tokio::test]
async fn registry_http_and_websocket_responses_are_final_size_bounded() {
    let max_response_bytes = 900;
    let store = RegistryStore::new(RegistryConfig {
        max_value_bytes: 4096,
        max_response_bytes,
        default_query_limit: 16,
        max_query_limit: 16,
        ..registry_config()
    })
    .expect("registry config should be valid");
    for index in 0..8 {
        store
            .set(
                botified::RegistryWriterKind::WebsocketClient,
                "ws:test",
                botified::registry::RegistrySetRequest::new(
                    format!("robot.pose.{index}"),
                    json!({"index": index, "payload": "x".repeat(120)}),
                    "localization",
                ),
            )
            .expect("seed write should succeed");
    }

    let (app, _service) = app_with_registry_store(None, store);
    for uri in [
        "/v1/registry/current?topic=robot.**&limit=16",
        "/v1/registry/history?topic=robot.**&since_secs=60&limit=16",
        "/v1/registry/topics?topic=robot.**&limit=16",
    ] {
        let response = app
            .clone()
            .oneshot(request(Method::GET, uri, None))
            .await
            .expect("registry request should complete");
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response_bytes(response).await;
        assert!(
            bytes.len() <= max_response_bytes,
            "{uri} final response must respect max_response_bytes, got {} bytes",
            bytes.len()
        );
        let body: Value = serde_json::from_slice(&bytes).expect("body should be json");
        assert_eq!(body["ok"], true);
        assert_eq!(body["truncated"], true);
        assert_eq!(body["truncated_reason"], "response_bytes");
        assert!(body["items"].is_array());
    }

    let server = TestServer::spawn(app).await;
    let mut ws = WsClient::connect(server.addr, "/v1/registry/ws", None)
        .await
        .expect("websocket should upgrade");

    let current_text = ws
        .send_json_text(json!({
            "op": "get",
            "id": "small-current",
            "topic": "robot.**",
            "limit": 16
        }))
        .await;
    assert!(
        current_text.len() <= max_response_bytes,
        "websocket get final response must respect max_response_bytes, got {} bytes",
        current_text.len()
    );
    let current: Value = serde_json::from_str(&current_text).expect("response should be json");
    assert_eq!(current["ok"], true);
    assert_eq!(current["op"], "snapshot");
    assert_eq!(current["id"], "small-current");
    assert_eq!(current["truncated"], true);
    assert_eq!(current["truncated_reason"], "response_bytes");

    let history_text = ws
        .send_json_text(json!({
            "op": "history",
            "id": "small-history",
            "topic": "robot.**",
            "since_secs": 60,
            "limit": 16
        }))
        .await;
    assert!(
        history_text.len() <= max_response_bytes,
        "websocket history final response must respect max_response_bytes, got {} bytes",
        history_text.len()
    );
    let history: Value = serde_json::from_str(&history_text).expect("response should be json");
    assert_eq!(history["ok"], true);
    assert_eq!(history["op"], "history");
    assert_eq!(history["id"], "small-history");
    assert_eq!(history["truncated"], true);
    assert_eq!(history["truncated_reason"], "response_bytes");
}

#[tokio::test]
async fn websocket_set_ack_is_final_size_bounded() {
    let max_response_bytes = 260;
    let store = RegistryStore::new(RegistryConfig {
        max_topic_len: 512,
        max_source_len: 512,
        max_value_bytes: 128,
        max_response_bytes,
        ..registry_config()
    })
    .expect("registry config should be valid");
    let (app, _service) = app_with_registry_store(None, store);
    let server = TestServer::spawn(app).await;
    let mut ws = WsClient::connect(server.addr, "/v1/registry/ws", None)
        .await
        .expect("websocket should upgrade");
    let topic = format!("agent.{}", "a".repeat(180));
    let source = format!("SENSITIVE_SOURCE_{}", "x".repeat(240));

    let ack_text = ws
        .send_json_text(json!({
            "op": "set",
            "id": "bounded-set-ack",
            "topic": topic,
            "value": 1,
            "source": source,
        }))
        .await;

    assert!(
        ack_text.len() <= max_response_bytes,
        "websocket set ack must respect max_response_bytes, got {} bytes: {ack_text}",
        ack_text.len()
    );
    assert!(
        !ack_text.contains("SENSITIVE_SOURCE_"),
        "bounded set ack must not leak oversized source metadata: {ack_text}"
    );
    let ack: Value = serde_json::from_str(&ack_text).expect("ack should be json");
    assert_eq!(ack["ok"], true);
    assert_eq!(ack["op"], "ack");
    assert_eq!(ack["kind"], "registry_set");
    assert_eq!(ack["id"], "bounded-set-ack");
    assert_eq!(ack["truncated"], true);
    assert_eq!(ack["truncated_reason"], "response_bytes");
}

#[tokio::test]
async fn websocket_set_get_history_reject_unknown_fields_without_writing() {
    let (app, _service) = app_with_registry(None);
    let server = TestServer::spawn(app).await;
    let mut ws = WsClient::connect(server.addr, "/v1/registry/ws", None)
        .await
        .expect("websocket should upgrade");

    let set_error = ws
        .send_json(json!({
            "op": "set",
            "id": "unknown-set",
            "topic": "agent.status.task_focus",
            "value": {"note": "client tried to forge writer fields"},
            "source": "external-client",
            "writer_kind": "main_agent",
            "origin": "main_agent"
        }))
        .await;
    assert_eq!(set_error["id"], "unknown-set");
    assert_ws_error(&set_error, "invalid_request");

    let current = ws
        .send_json(json!({
            "op": "get",
            "id": "read-after-rejected-set",
            "topic": "agent.status.task_focus"
        }))
        .await;
    assert_eq!(current["ok"], true);
    assert_eq!(current["op"], "snapshot");
    assert_eq!(current["matched_count"], 0);
    assert_eq!(current["returned_count"], 0);

    let get_error = ws
        .send_json(json!({
            "op": "get",
            "id": "unknown-get",
            "topic": "agent.status.task_focus",
            "extra": true
        }))
        .await;
    assert_eq!(get_error["id"], "unknown-get");
    assert_ws_error(&get_error, "invalid_request");

    let history_error = ws
        .send_json(json!({
            "op": "history",
            "id": "unknown-history",
            "topic": "agent.status.task_focus",
            "since_secs": 60,
            "extra": true
        }))
        .await;
    assert_eq!(history_error["id"], "unknown-history");
    assert_ws_error(&history_error, "invalid_request");
}

#[tokio::test]
async fn websocket_string_id_is_echoed_without_truncation_when_within_caps() {
    let (app, _service) = app_with_registry(None);
    let server = TestServer::spawn(app).await;
    let mut ws = WsClient::connect(server.addr, "/v1/registry/ws", None)
        .await
        .expect("websocket should upgrade");
    let long_id = format!("request-{}", "x".repeat(512));

    let current = ws
        .send_json(json!({
            "op": "get",
            "id": long_id,
            "topic": "robot.pose"
        }))
        .await;

    assert_eq!(current["ok"], true);
    assert_eq!(current["op"], "snapshot");
    assert_eq!(current["id"], long_id);
}
