use std::net::SocketAddr;
use std::sync::Once;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use botified::config::OpenAiCompatibleConfig;
use botified::llm_text_preview::LlmTextPreviewFilter;
use botified::profiling::{resolve_profiling_config, CsvProfiler, ProviderProfilingContext};
use botified::provider::openai_chat::OpenAiChatProvider;
use botified::{
    ContentPart, LlmTextPreviewHub, LlmTextPreviewMetadata, Message, Provider, ProviderError,
    ProviderPreviewContext, ProviderRequest, StopReason, ToolCall, Usage,
};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

static LOCAL_NO_PROXY: Once = Once::new();
const LEGACY_PROVIDER_RESPONSE_LIMIT_BYTES: usize = 1024 * 1024;
const SUCCESS_PROVIDER_RESPONSE_LIMIT_BYTES: usize = 32 * 1024 * 1024;

fn ensure_local_no_proxy_for_tests() {
    LOCAL_NO_PROXY.call_once(|| {
        std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
        std::env::set_var("no_proxy", "127.0.0.1,localhost");
    });
}

#[tokio::test]
async fn openai_chat_provider_posts_body_auth_and_parses_success() {
    let (server, mut requests) = spawn_test_server(ServerMode::Success).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");

    let response = provider
        .complete(
            ProviderRequest::new(
                "Be direct.",
                vec![Message::user(vec![ContentPart::text("hello")])],
                Vec::new(),
            ),
            CancellationToken::new(),
        )
        .await
        .expect("provider request should succeed");

    assert_eq!(response.text.as_deref(), Some("ok"));
    assert!(response.tool_calls.is_empty());
    assert_eq!(response.stop_reason, StopReason::EndTurn);
    let metadata = response
        .metadata
        .expect("successful response should include provider metadata");
    assert_eq!(metadata.profile, "test");
    assert_eq!(metadata.name.as_deref(), Some("test"));
    assert_eq!(metadata.model.as_deref(), Some("test-model"));
    assert!(metadata.capabilities.is_empty());
    let captured = requests.recv().await.expect("request should be captured");
    assert_eq!(captured.path, "/chat/completions");
    assert_eq!(captured.authorization.as_deref(), Some("Bearer sk-test"));
    assert_eq!(captured.body["model"], "test-model");
    assert_eq!(captured.body["messages"][0]["role"], "system");
    assert_eq!(captured.body["messages"][1]["content"][0]["text"], "hello");
    assert!(captured.body.get("stream").is_none());
    assert!(captured.body.get("stream_options").is_none());
}

#[tokio::test]
async fn openai_chat_provider_accepts_http_empty_stop_response() {
    let (server, mut requests) = spawn_test_server(ServerMode::EmptyStop).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");

    let response = provider
        .complete(simple_request(), CancellationToken::new())
        .await
        .expect("empty stop response should succeed");

    assert_eq!(response.text, None);
    assert!(response.tool_calls.is_empty());
    assert_eq!(response.stop_reason, StopReason::EndTurn);
    let metadata = response
        .metadata
        .expect("successful response should include provider metadata");
    assert_eq!(metadata.profile, "test");
    assert_eq!(metadata.name.as_deref(), Some("test"));
    assert_eq!(metadata.model.as_deref(), Some("test-model"));
    assert!(metadata.capabilities.is_empty());
    let captured = requests.recv().await.expect("request should be captured");
    assert_eq!(captured.path, "/chat/completions");
    assert_eq!(captured.body["model"], "test-model");
    assert!(captured.body.get("stream").is_none());
    assert!(captured.body.get("stream_options").is_none());
}

#[tokio::test]
async fn openai_chat_provider_parses_error_status() {
    let (server, _requests) = spawn_test_server(ServerMode::ProviderError).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");

    let error = provider
        .complete(simple_request(), CancellationToken::new())
        .await
        .expect_err("provider error should be returned");

    match error {
        ProviderError::ProviderReturned {
            status,
            code,
            message,
        } => {
            assert_eq!(status, Some(429));
            assert_eq!(code.as_deref(), Some("rate_limit"));
            assert_eq!(message, "slow down");
        }
        other => panic!("unexpected error: {other}"),
    }
}

#[tokio::test]
async fn openai_chat_provider_truncates_large_non_json_error() {
    let (server, _requests) = spawn_test_server(ServerMode::LargeNonJsonError).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");

    let error = provider
        .complete(simple_request(), CancellationToken::new())
        .await
        .expect_err("provider error should be returned");

    match error {
        ProviderError::ProviderReturned {
            status, message, ..
        } => {
            assert_eq!(status, Some(502));
            assert!(message.len() < 5000, "message was not truncated");
            assert!(message.contains("[truncated]"));
        }
        other => panic!("unexpected error: {other}"),
    }
}

#[tokio::test]
async fn openai_chat_provider_keeps_error_response_body_at_legacy_limit() {
    let (server, _requests) = spawn_test_server(ServerMode::HugeJsonError).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");

    let error = provider
        .complete(simple_request(), CancellationToken::new())
        .await
        .expect_err("huge provider error body should be truncated");

    match error {
        ProviderError::ProviderReturned {
            status,
            code,
            message,
        } => {
            assert_eq!(status, Some(502));
            assert_eq!(
                code, None,
                "error response body must stay capped before trailing code is parsed"
            );
            assert!(message.contains("[truncated]"));
            assert!(message.len() < 5000, "message was not truncated");
        }
        other => panic!("unexpected error: {other}"),
    }
}

#[tokio::test]
async fn openai_chat_provider_accepts_large_success_response_over_legacy_limit() {
    let (server, _requests) = spawn_test_server(ServerMode::LargeSuccessOverLegacyLimit).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");

    let response = provider
        .complete(simple_request(), CancellationToken::new())
        .await
        .expect("large success response should pass the success response cap");

    let text = response.text.expect("assistant text should parse");
    assert!(
        text.len() > LEGACY_PROVIDER_RESPONSE_LIMIT_BYTES,
        "test fixture must exceed the legacy 1MiB cap"
    );
}

#[tokio::test]
async fn openai_chat_provider_rejects_success_response_over_success_limit() {
    let (server, _requests) = spawn_test_server(ServerMode::SuccessByteLimitExceeded).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");

    let error = provider
        .complete(simple_request(), CancellationToken::new())
        .await
        .expect_err("success response beyond success cap should fail");

    assert!(error.to_string().contains("byte limit"));
    assert!(error
        .to_string()
        .contains(&SUCCESS_PROVIDER_RESPONSE_LIMIT_BYTES.to_string()));
}

#[tokio::test]
async fn openai_chat_provider_times_out() {
    let (server, _requests) = spawn_test_server(ServerMode::Slow).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test")
            .with_request_timeout(Duration::from_millis(30)),
    )
    .expect("provider should build");

    let error = provider
        .complete(simple_request(), CancellationToken::new())
        .await
        .expect_err("request should time out");

    assert!(error.to_string().contains("timed out"));
}

#[tokio::test]
async fn openai_chat_provider_honors_cancellation() {
    let (server, mut requests) = spawn_test_server(ServerMode::Slow).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test")
            .with_request_timeout(Duration::from_secs(5)),
    )
    .expect("provider should build");
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();

    let task = tokio::spawn(async move { provider.complete(simple_request(), task_cancel).await });
    requests.recv().await.expect("request should start");
    cancel.cancel();
    let error = task
        .await
        .expect("task should finish")
        .expect_err("request should be cancelled");

    assert!(error.to_string().contains("cancelled"));
}

#[tokio::test]
async fn openai_chat_provider_writes_success_profile_row_with_usage_without_changing_body() {
    let (server, mut requests) = spawn_test_server(ServerMode::SuccessWithUsage).await;
    let profiler = test_profiler("provider-success");
    let report_dir = profiler
        .lock()
        .expect("profiler mutex poisoned")
        .report_dir()
        .to_path_buf();
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build")
    .with_profiler(Some(profiler.clone()));

    let response = provider
        .complete(profiled_request(), CancellationToken::new())
        .await
        .expect("provider request should succeed");

    assert_eq!(
        response.text.as_deref(),
        Some("instrumented assistant output")
    );
    let captured = requests.recv().await.expect("request should be captured");
    assert!(captured.body.get("stream").is_none());
    assert!(captured.body.get("profiling_context").is_none());

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    assert!(events.contains(",provider_request,provider.completed,ok,true,"));
    assert!(events.contains(",agent_turn,1,1,true,true,"));
    assert!(events.contains(",test,test-model,200,"));
    assert!(events.contains(",11,4,6,2,17,"));
    assert!(
        !events.contains("hello"),
        "profile rows must not contain raw prompt text:\n{events}"
    );
    assert!(
        !events.contains("instrumented assistant output"),
        "profile rows must not contain raw assistant output:\n{events}"
    );
}

#[tokio::test]
async fn openai_chat_provider_skips_profile_row_without_context_even_when_profiler_exists() {
    let (server, _requests) = spawn_test_server(ServerMode::SuccessWithUsage).await;
    let profiler = test_profiler("provider-skip-no-context");
    let report_dir = profiler
        .lock()
        .expect("profiler mutex poisoned")
        .report_dir()
        .to_path_buf();
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build")
    .with_profiler(Some(profiler.clone()));

    provider
        .complete(simple_request(), CancellationToken::new())
        .await
        .expect("provider request should succeed");

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    assert!(!events.contains(",provider_request,"));
}

#[tokio::test]
async fn openai_chat_provider_writes_error_profile_row_without_raw_provider_body() {
    let (server, _requests) = spawn_test_server(ServerMode::ProviderError).await;
    let profiler = test_profiler("provider-error");
    let report_dir = profiler
        .lock()
        .expect("profiler mutex poisoned")
        .report_dir()
        .to_path_buf();
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build")
    .with_profiler(Some(profiler.clone()));

    provider
        .complete(profiled_request(), CancellationToken::new())
        .await
        .expect_err("provider error should be returned");

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    assert!(events.contains(",provider_request,provider.failed,error,false,"));
    assert!(events.contains(",test,test-model,429,"));
    assert!(events.contains(",provider_returned_error,"));
    assert!(events.contains(",rate_limit,"));
    assert!(
        !events.contains("slow down"),
        "profile rows should not copy raw provider error body text:\n{events}"
    );
}

#[tokio::test]
async fn openai_chat_provider_writes_timeout_profile_row() {
    let (server, _requests) = spawn_test_server(ServerMode::Slow).await;
    let profiler = test_profiler("provider-timeout");
    let report_dir = profiler
        .lock()
        .expect("profiler mutex poisoned")
        .report_dir()
        .to_path_buf();
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test")
            .with_request_timeout(Duration::from_millis(30)),
    )
    .expect("provider should build")
    .with_profiler(Some(profiler.clone()));

    provider
        .complete(profiled_request(), CancellationToken::new())
        .await
        .expect_err("request should time out");

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    assert!(events.contains(",provider_request,provider.timeout,timeout,false,"));
    let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
    assert_eq!(summary_value(&summary, "provider_requests"), "1");
    assert_eq!(summary_value(&summary, "provider_timeouts"), "1");
}

#[tokio::test]
async fn openai_chat_provider_writes_cancelled_profile_row() {
    let (server, mut requests) = spawn_test_server(ServerMode::Slow).await;
    let profiler = test_profiler("provider-cancelled");
    let report_dir = profiler
        .lock()
        .expect("profiler mutex poisoned")
        .report_dir()
        .to_path_buf();
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test")
            .with_request_timeout(Duration::from_secs(5)),
    )
    .expect("provider should build")
    .with_profiler(Some(profiler.clone()));
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();

    let task =
        tokio::spawn(async move { provider.complete(profiled_request(), task_cancel).await });
    requests.recv().await.expect("request should start");
    cancel.cancel();
    task.await
        .expect("task should finish")
        .expect_err("request should be cancelled");

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    assert!(events.contains(",provider_request,provider.cancelled,cancelled,false,"));
    let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
    assert_eq!(summary_value(&summary, "provider_requests"), "1");
    assert_eq!(summary_value(&summary, "provider_cancelled"), "1");
}

#[tokio::test]
async fn llm_text_preview_openai_chat_provider_streams_sse_and_publishes_text_frames() {
    let (server, mut requests) = spawn_test_server(ServerMode::StreamSuccessSplit).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());

    let response = provider
        .complete(preview_request(&hub), CancellationToken::new())
        .await
        .expect("streaming provider request should succeed");

    assert_eq!(response.text.as_deref(), Some("hello 世界"));
    assert!(response.tool_calls.is_empty());
    assert_eq!(response.stop_reason, StopReason::EndTurn);
    assert_eq!(
        response.usage,
        Some(Usage {
            input_tokens: 9,
            cached_input_tokens: 2,
            output_tokens: 4,
            reasoning_output_tokens: 1,
            total_tokens: 13,
        })
    );

    let captured = requests.recv().await.expect("request should be captured");
    assert_eq!(captured.body["stream"].as_bool(), Some(true));
    assert_eq!(
        captured.body["stream_options"],
        json!({"include_usage": true})
    );
    assert!(captured.body.get("preview_context").is_none());
    assert!(captured.body.get("provider_request_id").is_none());
    assert!(captured.body.get("input_ids").is_none());

    let started = next_preview_value(&mut preview).await;
    let first_delta = next_preview_value(&mut preview).await;
    let second_delta = next_preview_value(&mut preview).await;
    let finished = next_preview_value(&mut preview).await;
    assert_eq!(started["type"], "started");
    assert_eq!(first_delta["type"], "text_delta");
    assert_eq!(first_delta["delta"], "hello ");
    assert_eq!(second_delta["type"], "text_delta");
    assert_eq!(second_delta["delta"], "世界");
    assert_eq!(finished["type"], "finished");
    assert_eq!(finished["text_emitted"], true);
    assert_eq!(finished["stop_reason"], "end_turn");
    for frame in [started, first_delta, second_delta, finished] {
        let encoded = frame.to_string();
        assert!(!encoded.contains("reasoning_content"));
        assert!(!encoded.contains("raw"));
        assert!(!encoded.contains("cursor"));
        assert!(!encoded.contains("seq"));
        assert!(!encoded.contains("item"));
        assert_eq!(frame["provider_request_id"], "prq_cyc_99_1");
        assert_eq!(frame["cycle_id"], "cyc_99");
        assert_eq!(frame["input_ids"], json!(["msg_1"]));
    }
}

#[tokio::test]
async fn llm_text_preview_streaming_success_without_usage_returns_none() {
    let (server, _requests) = spawn_test_server(ServerMode::StreamSuccessNoUsage).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());

    let response = provider
        .complete(preview_request(&hub), CancellationToken::new())
        .await
        .expect("stream without usage should succeed");

    assert_eq!(response.text.as_deref(), Some("hello without usage"));
    assert_eq!(response.usage, None);
    assert_eq!(response.stop_reason, StopReason::EndTurn);

    assert_eq!(next_preview_value(&mut preview).await["type"], "started");
    assert_eq!(next_preview_value(&mut preview).await["type"], "text_delta");
    assert_eq!(next_preview_value(&mut preview).await["type"], "finished");
}

#[tokio::test]
async fn llm_text_preview_tool_call_only_stream_assembles_final_tool_calls_without_text_delta() {
    let (server, _requests) = spawn_test_server(ServerMode::StreamToolCalls).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());

    let response = provider
        .complete(preview_request(&hub), CancellationToken::new())
        .await
        .expect("tool call stream should succeed");

    assert_eq!(response.text, None);
    assert_eq!(response.stop_reason, StopReason::ToolCalls);
    assert_eq!(
        response.tool_calls,
        vec![
            ToolCall::new("call_a", "bash", json!({"command": "pwd"})),
            ToolCall::new("call_b", "status", json!({})),
        ]
    );

    let started = next_preview_value(&mut preview).await;
    let finished = next_preview_value(&mut preview).await;
    assert_eq!(started["type"], "started");
    assert_eq!(finished["type"], "finished");
    assert_eq!(finished["text_emitted"], false);
    assert_eq!(finished["stop_reason"], "tool_calls");
    let encoded = serde_json::to_string(&[started, finished]).expect("frames should encode");
    for forbidden in ["arguments", "command", "pwd", "call_a", "call_b"] {
        assert!(
            !encoded.contains(forbidden),
            "preview frames must not leak tool-call internals ({forbidden}): {encoded}"
        );
    }
    expect_no_preview_frame(&mut preview).await;
}

#[tokio::test]
async fn llm_text_preview_rejects_non_function_streaming_tool_call_without_finished() {
    let (server, _requests) = spawn_test_server(ServerMode::StreamNonFunctionToolCall).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());

    let error = provider
        .complete(preview_request(&hub), CancellationToken::new())
        .await
        .expect_err("non-function streaming tool call must fail");
    assert!(error
        .to_string()
        .contains("tool call type must be function"));

    let started = next_preview_value(&mut preview).await;
    let error = next_preview_value(&mut preview).await;
    assert_eq!(started["type"], "started");
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "provider_request_failed");
    let encoded = error.to_string();
    for forbidden in ["file_search", "secret query", "call_file"] {
        assert!(
            !encoded.contains(forbidden),
            "preview error must be sanitized ({forbidden}): {encoded}"
        );
    }
    expect_no_preview_frame(&mut preview).await;
}

#[tokio::test]
async fn llm_text_preview_streaming_refusal_delta_matches_non_stream_text_semantics() {
    let (server, _requests) = spawn_test_server(ServerMode::StreamRefusal).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());

    let response = provider
        .complete(preview_request(&hub), CancellationToken::new())
        .await
        .expect("refusal stream should succeed");

    assert_eq!(response.text.as_deref(), Some("I cannot help with that."));
    assert!(response.tool_calls.is_empty());
    assert_eq!(response.stop_reason, StopReason::EndTurn);

    let started = next_preview_value(&mut preview).await;
    let delta = next_preview_value(&mut preview).await;
    let finished = next_preview_value(&mut preview).await;
    assert_eq!(started["type"], "started");
    assert_eq!(delta["type"], "text_delta");
    assert_eq!(delta["delta"], "I cannot help with that.");
    assert_eq!(finished["type"], "finished");
    assert_eq!(finished["text_emitted"], true);
    assert_eq!(finished["stop_reason"], "end_turn");
}

#[tokio::test]
async fn llm_text_preview_malformed_stream_returns_error_frame_without_finished() {
    let (server, _requests) = spawn_test_server(ServerMode::StreamMalformedJson).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());

    provider
        .complete(preview_request(&hub), CancellationToken::new())
        .await
        .expect_err("malformed stream should fail provider request");

    let started = next_preview_value(&mut preview).await;
    let error = next_preview_value(&mut preview).await;
    assert_eq!(started["type"], "started");
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "provider_request_failed");
    assert_eq!(error["retryable"], true);
    let encoded = error.to_string();
    assert!(!encoded.contains("not-json"));
    assert!(!encoded.contains("hello"));
    assert!(!encoded.contains("sk-test"));
    expect_no_preview_frame(&mut preview).await;
}

#[tokio::test]
async fn llm_text_preview_stream_byte_limit_overflow_returns_sanitized_error_without_finished() {
    let (server, _requests) = spawn_test_server(ServerMode::StreamByteLimitExceeded).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());

    let error = provider
        .complete(preview_request(&hub), CancellationToken::new())
        .await
        .expect_err("oversized stream should fail provider request");
    assert!(error.to_string().contains("byte limit"));

    let started = next_preview_value(&mut preview).await;
    let error = next_preview_value(&mut preview).await;
    assert_eq!(started["type"], "started");
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "provider_request_failed");
    assert_eq!(error["retryable"], true);
    let encoded = error.to_string();
    for forbidden in ["overflow-secret", "sk-test", "Authorization", "data:"] {
        assert!(
            !encoded.contains(forbidden),
            "preview error must be sanitized ({forbidden}): {encoded}"
        );
    }
    expect_no_preview_frame(&mut preview).await;
}

#[tokio::test]
async fn llm_text_preview_stream_accepts_large_success_over_legacy_limit() {
    let (server, _requests) =
        spawn_test_server(ServerMode::StreamLargeSuccessOverLegacyLimit).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());

    let response = provider
        .complete(preview_request(&hub), CancellationToken::new())
        .await
        .expect("large streaming response should pass the success response cap");

    let text = response.text.expect("assistant text should parse");
    assert!(
        text.len() > LEGACY_PROVIDER_RESPONSE_LIMIT_BYTES,
        "test fixture must exceed the legacy 1MiB cap"
    );
    assert_eq!(next_preview_value(&mut preview).await["type"], "started");
    assert_eq!(next_preview_value(&mut preview).await["type"], "text_delta");
    assert_eq!(next_preview_value(&mut preview).await["type"], "finished");
    expect_no_preview_frame(&mut preview).await;
}

#[tokio::test]
async fn llm_text_preview_non_success_provider_error_returns_sanitized_error_without_finished() {
    let (server, _requests) = spawn_test_server(ServerMode::ProviderError).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());

    let error = provider
        .complete(preview_request(&hub), CancellationToken::new())
        .await
        .expect_err("provider error status should fail");
    assert!(matches!(error, ProviderError::ProviderReturned { .. }));

    let started = next_preview_value(&mut preview).await;
    let error = next_preview_value(&mut preview).await;
    assert_eq!(started["type"], "started");
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "provider_returned_error");
    assert_eq!(error["provider_status"], 429);
    assert_eq!(error["retryable"], true);
    let encoded = error.to_string();
    for forbidden in ["slow down", "rate_limit", "sk-test", "Authorization"] {
        assert!(
            !encoded.contains(forbidden),
            "preview error must be sanitized ({forbidden}): {encoded}"
        );
    }
    expect_no_preview_frame(&mut preview).await;
}

#[tokio::test]
async fn llm_text_preview_stream_eof_without_done_returns_error_frame_without_finished() {
    let (server, _requests) = spawn_test_server(ServerMode::StreamEofWithoutDone).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());

    let error = provider
        .complete(preview_request(&hub), CancellationToken::new())
        .await
        .expect_err("EOF before [DONE] should fail provider request");
    assert!(error.to_string().contains("ended before [DONE]"));

    let started = next_preview_value(&mut preview).await;
    let delta = next_preview_value(&mut preview).await;
    let error = next_preview_value(&mut preview).await;
    assert_eq!(started["type"], "started");
    assert_eq!(delta["type"], "text_delta");
    assert_eq!(delta["delta"], "partial before eof");
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "provider_request_failed");
    assert_eq!(error["retryable"], true);
    let encoded_error = error.to_string();
    for forbidden in [
        "partial before eof",
        "reasoning_content",
        "private eof reasoning",
        "sk-test",
        "Authorization",
        "data:",
        "[DONE]",
    ] {
        assert!(
            !encoded_error.contains(forbidden),
            "preview error must be sanitized ({forbidden}): {encoded_error}"
        );
    }
    expect_no_preview_frame(&mut preview).await;
}

#[tokio::test]
async fn llm_text_preview_already_cancelled_request_publishes_no_frames_before_started() {
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", "http://127.0.0.1:9/v1", "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());
    let cancel = CancellationToken::new();
    cancel.cancel();

    provider
        .complete(preview_request(&hub), cancel)
        .await
        .expect_err("already cancelled request should fail");

    expect_no_preview_frame(&mut preview).await;
}

#[tokio::test]
async fn llm_text_preview_cancel_after_started_publishes_aborted_without_finished() {
    let (server, mut requests) = spawn_test_server(ServerMode::Slow).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test")
            .with_request_timeout(Duration::from_secs(5)),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::new();
    let mut preview = hub.subscribe(LlmTextPreviewFilter::default());
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();

    let task =
        tokio::spawn(async move { provider.complete(preview_request(&hub), task_cancel).await });
    requests.recv().await.expect("request should start");
    let started = next_preview_value(&mut preview).await;
    assert_eq!(started["type"], "started");

    cancel.cancel();
    task.await
        .expect("provider task should finish")
        .expect_err("cancelled request should fail");

    let aborted = next_preview_value(&mut preview).await;
    assert_eq!(aborted["type"], "aborted");
    assert_eq!(aborted["reason"], "provider request cancelled");
    expect_no_preview_frame(&mut preview).await;
}

#[tokio::test]
async fn llm_text_preview_slow_subscriber_does_not_block_provider_completion() {
    let (server, _requests) = spawn_test_server(ServerMode::StreamManyDeltas).await;
    let provider = OpenAiChatProvider::new(
        OpenAiCompatibleConfig::new("test", server.base_url(), "test-model")
            .with_api_key("sk-test"),
    )
    .expect("provider should build");
    let hub = LlmTextPreviewHub::with_capacity(1);
    let _slow_subscriber = hub.subscribe(LlmTextPreviewFilter::default());

    let response = tokio::time::timeout(
        Duration::from_secs(1),
        provider.complete(preview_request(&hub), CancellationToken::new()),
    )
    .await
    .expect("slow subscriber must not block provider completion")
    .expect("provider request should succeed");

    assert_eq!(response.stop_reason, StopReason::EndTurn);
    assert_eq!(response.usage, None);
    assert_eq!(
        response
            .text
            .as_deref()
            .expect("stream should emit text")
            .len(),
        128
    );
}

#[test]
fn openai_chat_provider_requires_api_key() {
    let error = match OpenAiChatProvider::new(OpenAiCompatibleConfig::new(
        "test",
        "https://provider.example.test/v1",
        "test-model",
    )) {
        Ok(_) => panic!("missing key should fail provider config"),
        Err(error) => error,
    };

    let rendered = error.to_string();
    assert!(rendered.contains("provider config error"));
    assert!(rendered.contains("providers[].api_key_env"));
    assert!(rendered.contains("--mock-provider"));
    assert!(!rendered.contains("sk-"));
}

fn simple_request() -> ProviderRequest {
    ProviderRequest::new(
        "system",
        vec![Message::user(vec![ContentPart::text("hello")])],
        Vec::new(),
    )
}

fn preview_request(hub: &LlmTextPreviewHub) -> ProviderRequest {
    simple_request().with_preview_context(ProviderPreviewContext::new(
        LlmTextPreviewMetadata {
            provider_request_id: "prq_cyc_99_1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            cycle_id: Some("cyc_99".to_owned()),
            provider_call_index: 1,
            input_ids: vec!["msg_1".to_owned()],
        },
        hub.sink(),
    ))
}

async fn next_preview_value(
    preview: &mut botified::llm_text_preview::LlmTextPreviewSubscription,
) -> Value {
    let frame = tokio::time::timeout(Duration::from_secs(2), preview.recv())
        .await
        .expect("preview frame should arrive")
        .expect("preview subscription should remain open");
    serde_json::to_value(frame).expect("preview frame should serialize")
}

async fn expect_no_preview_frame(
    preview: &mut botified::llm_text_preview::LlmTextPreviewSubscription,
) {
    match tokio::time::timeout(Duration::from_millis(150), preview.recv()).await {
        Err(_) => {}
        Ok(None) => {}
        Ok(Some(frame)) => panic!("unexpected preview frame: {frame:?}"),
    }
}

fn profiled_request() -> ProviderRequest {
    simple_request().with_profiling_context(ProviderProfilingContext {
        session: Some("session-1".to_owned()),
        turn_id: Some("turn-1".to_owned()),
        cycle_id: Some("cycle-1".to_owned()),
        provider_call_index: 1,
        request_kind: "agent_turn".to_owned(),
        input_message_count: 1,
        message_count: 1,
        tool_spec_count: 0,
    })
}

fn test_profiler(name: &str) -> botified::profiling::SharedProfiler {
    let data_dir = temp_dir(name);
    let config = resolve_profiling_config(
        &botified::config::RuntimeProfilingConfig {
            enabled: true,
            output_dir: None,
            run_label: Some(name.to_owned()),
        },
        &data_dir,
    )
    .expect("profiling config should resolve")
    .expect("profiling should be enabled");
    CsvProfiler::create_shared(config).expect("profiler should create files")
}

fn temp_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "botified-provider-http-{name}-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn summary_value<'a>(summary: &'a str, column: &str) -> &'a str {
    let mut lines = summary.lines();
    let header = lines.next().expect("summary header");
    let row = lines.next().expect("summary row");
    let index = header
        .split(',')
        .position(|name| name == column)
        .unwrap_or_else(|| panic!("summary column {column} not found"));
    row.split(',')
        .nth(index)
        .unwrap_or_else(|| panic!("summary row missing column {column}"))
}

#[derive(Clone, Copy)]
enum ServerMode {
    Success,
    EmptyStop,
    LargeSuccessOverLegacyLimit,
    SuccessByteLimitExceeded,
    SuccessWithUsage,
    ProviderError,
    LargeNonJsonError,
    HugeJsonError,
    Slow,
    StreamSuccessSplit,
    StreamSuccessNoUsage,
    StreamToolCalls,
    StreamNonFunctionToolCall,
    StreamRefusal,
    StreamMalformedJson,
    StreamEofWithoutDone,
    StreamLargeSuccessOverLegacyLimit,
    StreamByteLimitExceeded,
    StreamManyDeltas,
}

struct CapturedRequest {
    path: String,
    authorization: Option<String>,
    body: Value,
}

struct TestServer {
    addr: SocketAddr,
    handle: tokio::task::JoinHandle<()>,
}

impl TestServer {
    fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn spawn_test_server(mode: ServerMode) -> (TestServer, mpsc::Receiver<CapturedRequest>) {
    ensure_local_no_proxy_for_tests();
    let (tx, rx) = mpsc::channel(8);
    let app = Router::new()
        .route("/chat/completions", post(chat_completions))
        .with_state(TestState { tx, mode });
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test server should bind");
    let addr = listener.local_addr().expect("test server should have addr");
    let handle = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("test server should run");
    });

    (TestServer { addr, handle }, rx)
}

#[derive(Clone)]
struct TestState {
    tx: mpsc::Sender<CapturedRequest>,
    mode: ServerMode,
}

async fn chat_completions(
    State(state): State<TestState>,
    uri: Uri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let _ = state
        .tx
        .send(CapturedRequest {
            path: uri.path().to_owned(),
            authorization: headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            body,
        })
        .await;

    match state.mode {
        ServerMode::Success => Json(json!({
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "ok"
                    }
                }
            ]
        }))
        .into_response(),
        ServerMode::EmptyStop => Json(json!({
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": null
                    }
                }
            ]
        }))
        .into_response(),
        ServerMode::LargeSuccessOverLegacyLimit => Json(json!({
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "x".repeat(LEGACY_PROVIDER_RESPONSE_LIMIT_BYTES + 16 * 1024)
                    }
                }
            ]
        }))
        .into_response(),
        ServerMode::SuccessByteLimitExceeded => Json(json!({
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "x".repeat(SUCCESS_PROVIDER_RESPONSE_LIMIT_BYTES + 16 * 1024)
                    }
                }
            ]
        }))
        .into_response(),
        ServerMode::SuccessWithUsage => Json(json!({
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "instrumented assistant output"
                    }
                }
            ],
            "usage": {
                "prompt_tokens": 11,
                "prompt_tokens_details": {"cached_tokens": 4},
                "completion_tokens": 6,
                "completion_tokens_details": {"reasoning_tokens": 2},
                "total_tokens": 17
            }
        }))
        .into_response(),
        ServerMode::ProviderError => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": {
                    "message": "slow down",
                    "code": "rate_limit"
                }
            })),
        )
            .into_response(),
        ServerMode::LargeNonJsonError => {
            (StatusCode::BAD_GATEWAY, "x".repeat(20_000)).into_response()
        }
        ServerMode::HugeJsonError => {
            let body = format!(
                "{{\"error\":{{\"message\":\"{}\",\"code\":\"after_legacy_limit\"}}}}",
                "x".repeat(LEGACY_PROVIDER_RESPONSE_LIMIT_BYTES + 16 * 1024)
            );
            (
                StatusCode::BAD_GATEWAY,
                [("content-type", "application/json")],
                body,
            )
                .into_response()
        }
        ServerMode::Slow => {
            sleep(Duration::from_secs(10)).await;
            Json(json!({
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": "late"
                        }
                    }
                ]
            }))
            .into_response()
        }
        ServerMode::StreamSuccessSplit => sse_response(split_utf8_chunk(stream_success_chunks())),
        ServerMode::StreamSuccessNoUsage => sse_response(stream_success_no_usage_chunks()),
        ServerMode::StreamToolCalls => sse_response(stream_tool_call_chunks()),
        ServerMode::StreamNonFunctionToolCall => {
            sse_response(stream_non_function_tool_call_chunks())
        }
        ServerMode::StreamRefusal => sse_response(stream_refusal_chunks()),
        ServerMode::StreamMalformedJson => sse_response(vec![b"data: {not-json}\n\n".to_vec()]),
        ServerMode::StreamEofWithoutDone => sse_response(stream_eof_without_done_chunks()),
        ServerMode::StreamLargeSuccessOverLegacyLimit => {
            sse_response(stream_large_success_over_legacy_limit_chunks())
        }
        ServerMode::StreamByteLimitExceeded => sse_response(stream_byte_limit_exceeded_chunks()),
        ServerMode::StreamManyDeltas => sse_response(stream_many_delta_chunks()),
    }
}

fn sse_response(chunks: Vec<Vec<u8>>) -> Response {
    (
        StatusCode::OK,
        [("content-type", "text/event-stream")],
        chunks.concat(),
    )
        .into_response()
}

fn sse_json(value: Value) -> Vec<u8> {
    format!("data: {}\r\n\r\n", value).into_bytes()
}

fn stream_success_chunks() -> Vec<Vec<u8>> {
    vec![
        b": provider comment\r\n\r\n".to_vec(),
        b"\r\n".to_vec(),
        sse_json(json!({
            "choices": [
                {
                    "delta": {
                        "content": "hello ",
                        "reasoning_content": "private reasoning must not preview"
                    }
                }
            ]
        })),
        sse_json(json!({
            "choices": [
                {
                    "delta": {
                        "content": "世界",
                        "thinking": "private thinking must not preview"
                    }
                }
            ]
        })),
        sse_json(json!({
            "choices": [],
            "usage": {
                "prompt_tokens": 9,
                "prompt_tokens_details": {"cached_tokens": 2},
                "completion_tokens": 4,
                "completion_tokens_details": {"reasoning_tokens": 1},
                "total_tokens": 13
            }
        })),
        sse_json(json!({
            "choices": [
                {
                    "delta": {},
                    "finish_reason": "stop"
                }
            ]
        })),
        b"data: [DONE]\r\n\r\n".to_vec(),
    ]
}

fn stream_success_no_usage_chunks() -> Vec<Vec<u8>> {
    vec![
        sse_json(json!({
            "choices": [
                {
                    "delta": {
                        "content": "hello without usage"
                    }
                }
            ],
            "usage": null
        })),
        sse_json(json!({
            "choices": [
                {
                    "delta": {},
                    "finish_reason": "stop"
                }
            ],
            "usage": null
        })),
        b"data: [DONE]\n\n".to_vec(),
    ]
}

fn stream_large_success_over_legacy_limit_chunks() -> Vec<Vec<u8>> {
    vec![
        sse_json(json!({
            "choices": [
                {
                    "delta": {
                        "content": "x".repeat(LEGACY_PROVIDER_RESPONSE_LIMIT_BYTES + 16 * 1024)
                    }
                }
            ]
        })),
        sse_json(json!({
            "choices": [
                {
                    "delta": {},
                    "finish_reason": "stop"
                }
            ]
        })),
        b"data: [DONE]\r\n\r\n".to_vec(),
    ]
}

fn split_utf8_chunk(chunks: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    let mut split = Vec::new();
    for chunk in chunks {
        if let Some(index) = chunk
            .windows("世界".len())
            .position(|window| window == "世界".as_bytes())
        {
            split.push(chunk[..index + 1].to_vec());
            split.push(chunk[index + 1..].to_vec());
        } else {
            split.push(chunk);
        }
    }
    split
}

fn stream_tool_call_chunks() -> Vec<Vec<u8>> {
    vec![
        sse_json(json!({
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_a",
                                "type": "function",
                                "function": {
                                    "name": "bash",
                                    "arguments": "{\"command\""
                                }
                            }
                        ]
                    }
                }
            ]
        })),
        sse_json(json!({
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 1,
                                "id": "call_b",
                                "type": "function",
                                "function": {
                                    "name": "status",
                                    "arguments": "{}"
                                }
                            },
                            {
                                "index": 0,
                                "function": {
                                    "arguments": ":\"pwd\"}"
                                }
                            }
                        ]
                    }
                }
            ]
        })),
        sse_json(json!({
            "choices": [
                {
                    "delta": {},
                    "finish_reason": "tool_calls"
                }
            ]
        })),
        b"data: [DONE]\n\n".to_vec(),
    ]
}

fn stream_non_function_tool_call_chunks() -> Vec<Vec<u8>> {
    vec![sse_json(json!({
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_file",
                            "type": "file_search",
                            "function": {
                                "name": "bash",
                                "arguments": "{\"query\":\"secret query\"}"
                            }
                        }
                    ]
                }
            }
        ]
    }))]
}

fn stream_refusal_chunks() -> Vec<Vec<u8>> {
    vec![
        sse_json(json!({
            "choices": [
                {
                    "delta": {
                        "refusal": "I cannot help with that."
                    }
                }
            ]
        })),
        sse_json(json!({
            "choices": [
                {
                    "delta": {},
                    "finish_reason": "stop"
                }
            ]
        })),
        b"data: [DONE]\n\n".to_vec(),
    ]
}

fn stream_eof_without_done_chunks() -> Vec<Vec<u8>> {
    vec![sse_json(json!({
        "choices": [
            {
                "delta": {
                    "content": "partial before eof",
                    "reasoning_content": "private eof reasoning"
                }
            }
        ]
    }))]
}

fn stream_byte_limit_exceeded_chunks() -> Vec<Vec<u8>> {
    vec![format!(
        "data: {{\"overflow\":\"{}\"}}\n\n",
        "overflow-secret"
            .repeat((SUCCESS_PROVIDER_RESPONSE_LIMIT_BYTES / "overflow-secret".len()) + 1)
    )
    .into_bytes()]
}

fn stream_many_delta_chunks() -> Vec<Vec<u8>> {
    let mut chunks = Vec::new();
    for _ in 0..128 {
        chunks.push(sse_json(json!({
            "choices": [
                {
                    "delta": {
                        "content": "x"
                    }
                }
            ]
        })));
    }
    chunks.push(sse_json(json!({
        "choices": [
            {
                "delta": {},
                "finish_reason": "stop"
            }
        ]
    })));
    chunks.push(b"data: [DONE]\n\n".to_vec());
    chunks
}
