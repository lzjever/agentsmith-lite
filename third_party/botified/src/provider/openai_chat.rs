use std::borrow::Cow;
use std::collections::BTreeMap;
use std::future::Future;

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::{json, Map, Number, Value};
use tokio_util::sync::CancellationToken;

use crate::config::{
    is_loopback_http_provider_base_url, validate_provider_base_url, OpenAiCompatibleConfig,
};
use crate::llm_text_preview::{LlmTextPreviewFrame, ProviderPreviewContext};
use crate::message_render::render_file_manifest;
use crate::profiling::{
    CsvEventRow, ProfilingTimestamp, ProviderProfilingContext, ProviderRequestSequence,
    SharedProfiler,
};
use crate::provider::api_compat::ProviderApiCompat;
use crate::provider::thinking::{ThinkingConfig, ThinkingLevel};
use crate::provider::Provider;
use crate::provider::{
    ProviderError, ProviderErrorDiagnostic, ProviderMetadata, ProviderRequest, ProviderResponse,
};
use crate::tools::ToolSpec;
use crate::transcript::validate_provider_model_input;
use crate::types::{
    assistant_payload_is_valid, AssistantMessageReplay, ContentPart, ContextRole, Message,
    ModelInput, StopReason, ToolCall, Usage,
};

mod error;
mod request;
mod response;
mod stream;

use error::{
    cancelled_error, error_body_to_message, invalid_response_error, map_reqwest_error,
    missing_api_key_error, non_json_error, validate_api_key,
};
pub use error::{parse_provider_error, OpenAiChatError};
pub use request::build_chat_completions_request;
use request::{enable_streaming_request, ProviderRequestDialect};
pub use response::parse_chat_completions_response;
#[cfg(test)]
use stream::StreamingToolCallAssembler;
use stream::{ChatCompletionsStreamParser, SseEventBuffer};

const MAX_PROVIDER_SUCCESS_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PROVIDER_ERROR_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy)]
struct ProviderApiCompatPolicy {
    api_compat: ProviderApiCompat,
    thinking_level: ThinkingLevel,
}

impl ProviderApiCompatPolicy {
    fn from_config(config: &OpenAiCompatibleConfig) -> Result<Self, OpenAiChatError> {
        Self::new(config.api_compat, &config.thinking)
    }

    fn new(
        api_compat: ProviderApiCompat,
        thinking: &ThinkingConfig,
    ) -> Result<Self, OpenAiChatError> {
        thinking
            .validate()
            .map_err(|error| OpenAiChatError::invalid_request(error.to_string()))?;
        api_compat
            .validate_thinking_level(thinking.level)
            .map_err(OpenAiChatError::invalid_request)?;
        Ok(Self {
            api_compat,
            thinking_level: thinking.level,
        })
    }

    fn reasoning_replay(self) -> ProviderReasoningReplayPolicy {
        ProviderReasoningReplayPolicy {
            enabled: matches!(
                self.api_compat,
                ProviderApiCompat::Deepseek
                    | ProviderApiCompat::DashscopeGlm
                    | ProviderApiCompat::ZaiGlm
            ) && !self.thinking_level.is_off(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ProviderReasoningReplayPolicy {
    enabled: bool,
}

impl ProviderReasoningReplayPolicy {
    fn store_assistant_replay(self, tool_calls: &[ToolCall]) -> bool {
        self.enabled && !tool_calls.is_empty()
    }
}

#[derive(Clone)]
pub struct OpenAiChatProvider {
    config: OpenAiCompatibleConfig,
    client: Client,
    profiler: Option<SharedProfiler>,
}

impl OpenAiChatProvider {
    pub fn new(config: OpenAiCompatibleConfig) -> Result<Self, ProviderError> {
        validate_api_key(&config)?;
        validate_provider_base_url(&config.profile, &config.base_url)
            .map_err(|error| ProviderError::config(error.message()))?;
        config
            .thinking
            .validate()
            .map_err(|error| ProviderError::config(error.to_string()))?;
        config
            .api_compat
            .validate_thinking_level(config.thinking.level)
            .map_err(ProviderError::config)?;
        let mut client_builder = Client::builder()
            .timeout(config.request_timeout)
            .redirect(reqwest::redirect::Policy::none());
        if is_loopback_http_provider_base_url(&config.base_url) {
            client_builder = client_builder.no_proxy();
        }
        let client = client_builder
            .build()
            .map_err(|error| ProviderError::config(error.to_string()))?;
        Ok(Self {
            config,
            client,
            profiler: None,
        })
    }

    pub fn with_profiler(mut self, profiler: Option<SharedProfiler>) -> Self {
        self.profiler = profiler;
        self
    }
}

#[async_trait]
impl Provider for OpenAiChatProvider {
    fn metadata_for_request(&self, _request: &ProviderRequest) -> Option<ProviderMetadata> {
        Some(
            ProviderMetadata::new(self.config.profile.clone())
                .with_model(self.config.model.clone())
                .with_api_compat(self.config.api_compat)
                .with_optional_context_window_tokens(self.config.context_window_tokens)
                .with_optional_max_output_tokens(self.config.max_output_tokens),
        )
    }

    async fn complete(
        &self,
        request: ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }

        let profiling = self.begin_profile(request.profiling_context().cloned());
        let mut request_body_bytes = None;
        let mut response_body_bytes = None;
        let mut http_status = None;

        let policy = match ProviderApiCompatPolicy::from_config(&self.config) {
            Ok(policy) => policy,
            Err(error) => {
                let error = ProviderError::config(error.to_string());
                self.finish_profile(
                    profiling,
                    request_body_bytes,
                    response_body_bytes,
                    http_status,
                    Err(&error),
                );
                return Err(error);
            }
        };

        let mut body = match build_chat_completions_request(&self.config, &request) {
            Ok(body) => body,
            Err(error) => {
                let error = ProviderError::config(error.to_string());
                self.finish_profile(
                    profiling,
                    request_body_bytes,
                    response_body_bytes,
                    http_status,
                    Err(&error),
                );
                return Err(error);
            }
        };
        let request_dialect = ProviderRequestDialect::from_policy(policy);
        let preview_context = request.preview_context().cloned();
        let force_streaming_transport = request_dialect.requires_streaming_transport(&request);
        let stream_preview_context = if force_streaming_transport {
            None
        } else {
            preview_context.as_ref()
        };
        if stream_preview_context.is_some() {
            enable_streaming_request(&mut body);
        }
        request_body_bytes = serde_json::to_vec(&body).ok().map(|bytes| bytes.len());

        let api_key = match self
            .config
            .api_key
            .as_deref()
            .ok_or_else(missing_api_key_error)
        {
            Ok(api_key) => api_key,
            Err(error) => {
                self.finish_profile(
                    profiling,
                    request_body_bytes,
                    response_body_bytes,
                    http_status,
                    Err(&error),
                );
                return Err(error);
            }
        };

        if cancel.is_cancelled() {
            let error = cancelled_error();
            self.finish_profile(
                profiling,
                request_body_bytes,
                response_body_bytes,
                http_status,
                Err(&error),
            );
            return Err(error);
        }

        if let Some(context) = stream_preview_context {
            context
                .sink
                .publish(LlmTextPreviewFrame::started(&context.metadata));
        }

        let result = match await_with_cancel(
            self.client
                .post(self.config.chat_completions_url())
                .bearer_auth(api_key)
                .json(&body)
                .send(),
            &cancel,
        )
        .await
        {
            Ok(Ok(response)) => {
                let status = response.status();
                http_status = Some(status.as_u16());
                if stream_preview_context.is_some() || force_streaming_transport {
                    if status.is_success() {
                        match read_streaming_response(
                            response,
                            policy,
                            stream_preview_context,
                            &cancel,
                        )
                        .await
                        {
                            Ok(stream_response) => {
                                response_body_bytes = Some(stream_response.body_bytes);
                                Ok(stream_response.response)
                            }
                            Err(error) => Err(error),
                        }
                    } else {
                        match read_json_response(response, &cancel).await {
                            Ok(json_response) => {
                                response_body_bytes = Some(json_response.body_bytes);
                                let error =
                                    parse_provider_error(status.as_u16(), &json_response.value);
                                if let Some(context) = stream_preview_context {
                                    publish_preview_error(context, &error);
                                }
                                Err(error)
                            }
                            Err(error) => {
                                if let Some(context) = stream_preview_context {
                                    if cancel.is_cancelled() {
                                        publish_preview_aborted(context);
                                    } else {
                                        publish_preview_error(context, &error);
                                    }
                                }
                                Err(error)
                            }
                        }
                    }
                } else {
                    match read_json_response(response, &cancel).await {
                        Ok(json_response) => {
                            response_body_bytes = Some(json_response.body_bytes);
                            if status.is_success() {
                                parse_chat_completions_response(&json_response.value, &self.config)
                                    .map_err(|error| {
                                        invalid_response_error(status, error.to_string())
                                    })
                            } else {
                                Err(parse_provider_error(status.as_u16(), &json_response.value))
                            }
                        }
                        Err(error) => Err(error),
                    }
                }
            }
            Ok(Err(error)) => {
                let error = map_reqwest_error(error);
                if let Some(context) = stream_preview_context {
                    if cancel.is_cancelled() {
                        publish_preview_aborted(context);
                    } else {
                        publish_preview_error(context, &error);
                    }
                }
                Err(error)
            }
            Err(error) => {
                if let Some(context) = stream_preview_context {
                    if cancel.is_cancelled() {
                        publish_preview_aborted(context);
                    } else {
                        publish_preview_error(context, &error);
                    }
                }
                Err(error)
            }
        };

        let mut result = result;
        if let Ok(response) = result.as_mut() {
            response.metadata = self.metadata_for_request(&request);
        }
        self.finish_profile(
            profiling,
            request_body_bytes,
            response_body_bytes,
            http_status,
            result.as_ref(),
        );
        result
    }
}

struct ProviderProfileState {
    profiler: SharedProfiler,
    context: ProviderProfilingContext,
    start: ProfilingTimestamp,
    sequence: ProviderRequestSequence,
}

impl OpenAiChatProvider {
    fn begin_profile(
        &self,
        context: Option<ProviderProfilingContext>,
    ) -> Option<ProviderProfileState> {
        let context = context?;
        let profiler = self.profiler.as_ref()?.clone();
        let mut locked = profiler.lock().ok()?;
        let start = locked.now();
        let sequence = locked.begin_provider_request(&self.config.profile, start);
        drop(locked);
        Some(ProviderProfileState {
            profiler,
            context,
            start,
            sequence,
        })
    }

    fn finish_profile(
        &self,
        state: Option<ProviderProfileState>,
        request_body_bytes: Option<usize>,
        response_body_bytes: Option<usize>,
        http_status: Option<u16>,
        result: Result<&ProviderResponse, &ProviderError>,
    ) {
        let Some(state) = state else {
            return;
        };
        let profiler = state.profiler.clone();
        let Ok(mut profiler) = profiler.lock() else {
            return;
        };
        let end = profiler.now();
        let row = provider_profile_row(
            &self.config.profile,
            &self.config.model,
            state,
            end,
            request_body_bytes,
            response_body_bytes,
            http_status,
            result,
        );
        let _ = profiler.write_event_row(row);
    }
}

#[allow(clippy::too_many_arguments)]
fn provider_profile_row(
    provider_name: &str,
    model: &str,
    state: ProviderProfileState,
    end: ProfilingTimestamp,
    request_body_bytes: Option<usize>,
    response_body_bytes: Option<usize>,
    http_status: Option<u16>,
    result: Result<&ProviderResponse, &ProviderError>,
) -> CsvEventRow {
    let (event_name, status, success) = match result {
        Ok(_) => ("provider.completed", "ok", true),
        Err(error) if provider_error_is_timeout(error) => ("provider.timeout", "timeout", false),
        Err(error) if provider_error_is_cancelled(error) => {
            ("provider.cancelled", "cancelled", false)
        }
        Err(_) => ("provider.failed", "error", false),
    };
    let mut row = CsvEventRow::new("provider_request", event_name, status)
        .success(success)
        .timing(state.start, Some(end))
        .optional_field("session", state.context.session.as_deref())
        .optional_field("turn_id", state.context.turn_id.as_deref())
        .optional_field("cycle_id", state.context.cycle_id.as_deref())
        .field("provider_call_index", state.context.provider_call_index)
        .field("request_kind", state.context.request_kind)
        .field(
            "provider_request_index",
            state.sequence.provider_request_index,
        )
        .field(
            "provider_request_index_for_provider",
            state.sequence.provider_request_index_for_provider,
        )
        .field(
            "is_first_provider_request_in_run",
            state.sequence.is_first_provider_request_in_run,
        )
        .field(
            "is_first_provider_request_for_provider",
            state.sequence.is_first_provider_request_for_provider,
        )
        .field(
            "service_start_to_provider_start_ms",
            state.sequence.service_start_to_provider_start_ms,
        )
        .field("provider_name", provider_name)
        .field("model", model)
        .optional_field("http_status", http_status)
        .field("input_message_count", state.context.input_message_count)
        .field("message_count", state.context.message_count)
        .field("tool_spec_count", state.context.tool_spec_count)
        .optional_field("request_body_bytes", request_body_bytes)
        .optional_field("response_body_bytes", response_body_bytes);

    match result {
        Ok(response) => {
            row = row
                .field("stop_reason", response.stop_reason.as_str())
                .field("tool_call_count", response.tool_calls.len());
            if let Some(usage) = response.usage {
                row = row
                    .field("input_tokens", usage.input_tokens)
                    .field("cached_input_tokens", usage.cached_input_tokens)
                    .field("output_tokens", usage.output_tokens)
                    .field("reasoning_output_tokens", usage.reasoning_output_tokens)
                    .field("total_tokens", usage.total_tokens);
                if usage.input_tokens > 0 {
                    row = row.field(
                        "cache_hit_ratio",
                        format!(
                            "{:.6}",
                            usage.cached_input_tokens as f64 / usage.input_tokens as f64
                        ),
                    );
                }
            }
        }
        Err(error) => {
            let diagnostic = error.diagnostic();
            row = row
                .field("error_kind", diagnostic.code)
                .field("error_retryable", diagnostic.retryable)
                .field("error_code", provider_error_code(&diagnostic))
                .field(
                    "error_message_truncated",
                    provider_error_summary(&diagnostic),
                );
        }
    }

    row
}

fn provider_error_code(diagnostic: &ProviderErrorDiagnostic) -> String {
    diagnostic
        .provider_code
        .clone()
        .unwrap_or_else(|| diagnostic.code.to_owned())
}

fn provider_error_summary(diagnostic: &ProviderErrorDiagnostic) -> String {
    match (diagnostic.status, diagnostic.provider_code.as_deref()) {
        (Some(status), Some(code)) => format!("status {status} provider_code {code}"),
        (Some(status), None) => format!("status {status}"),
        (None, Some(code)) => format!("provider_code {code}"),
        (None, None) => diagnostic.code.to_owned(),
    }
}

fn provider_error_is_timeout(error: &ProviderError) -> bool {
    error
        .diagnostic()
        .message
        .to_ascii_lowercase()
        .contains("timed out")
}

fn provider_error_is_cancelled(error: &ProviderError) -> bool {
    error
        .diagnostic()
        .message
        .to_ascii_lowercase()
        .contains("cancelled")
}

async fn await_with_cancel<T>(
    future: impl Future<Output = T>,
    cancel: &CancellationToken,
) -> Result<T, ProviderError> {
    tokio::select! {
        _ = cancel.cancelled() => Err(cancelled_error()),
        result = future => Ok(result),
    }
}

async fn read_json_response(
    response: reqwest::Response,
    cancel: &CancellationToken,
) -> Result<JsonResponse, ProviderError> {
    let status = response.status();
    let response_limit = if status.is_success() {
        MAX_PROVIDER_SUCCESS_RESPONSE_BYTES
    } else {
        MAX_PROVIDER_ERROR_RESPONSE_BYTES
    };
    let body = read_response_body(response, cancel, response_limit).await?;
    let body_bytes = body.bytes.len();
    if body.truncated {
        if status.is_success() {
            return Err(invalid_response_error(
                status,
                format!(
                    "provider response exceeded {MAX_PROVIDER_SUCCESS_RESPONSE_BYTES} byte limit"
                ),
            ));
        }
        return Ok(JsonResponse {
            value: non_json_error(status, error_body_to_message(&body.bytes, true)),
            body_bytes,
        });
    }

    match serde_json::from_slice(&body.bytes) {
        Ok(value) => Ok(JsonResponse { value, body_bytes }),
        Err(error) if status.is_success() => Err(invalid_response_error(
            status,
            format!("invalid provider JSON response: {error}"),
        )),
        Err(_) => Ok(JsonResponse {
            value: non_json_error(status, error_body_to_message(&body.bytes, false)),
            body_bytes,
        }),
    }
}

struct JsonResponse {
    value: Value,
    body_bytes: usize,
}

struct StreamingResponse {
    response: ProviderResponse,
    body_bytes: usize,
}

async fn read_streaming_response(
    response: reqwest::Response,
    policy: ProviderApiCompatPolicy,
    preview_context: Option<&ProviderPreviewContext>,
    cancel: &CancellationToken,
) -> Result<StreamingResponse, ProviderError> {
    let status = response.status();
    let mut stream = response.bytes_stream();
    let mut parser = ChatCompletionsStreamParser::new(policy, preview_context.cloned());
    let mut buffer = SseEventBuffer::default();
    let mut body_bytes = 0usize;

    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => {
                if let Some(context) = preview_context {
                    publish_preview_aborted(context);
                }
                return Err(cancelled_error());
            }
            next = stream.next() => next,
        };

        let Some(chunk) = next else {
            let error = ProviderError::request_failed("provider stream ended before [DONE]");
            if let Some(context) = preview_context {
                publish_preview_error(context, &error);
            }
            return Err(error);
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                let error = map_reqwest_error(error);
                if let Some(context) = preview_context {
                    if cancel.is_cancelled() {
                        publish_preview_aborted(context);
                    } else {
                        publish_preview_error(context, &error);
                    }
                }
                return Err(error);
            }
        };
        body_bytes = match body_bytes.checked_add(chunk.len()) {
            Some(total) if total <= MAX_PROVIDER_SUCCESS_RESPONSE_BYTES => total,
            _ => {
                let error = invalid_response_error(
                    status,
                    format!(
                        "provider response exceeded {MAX_PROVIDER_SUCCESS_RESPONSE_BYTES} byte limit"
                    ),
                );
                if let Some(context) = preview_context {
                    publish_preview_error(context, &error);
                }
                return Err(error);
            }
        };
        buffer.extend(&chunk);

        while let Some(event) = buffer.next_event() {
            if let Err(error) = parser.process_event(event) {
                let error = invalid_response_error(status, error.to_string());
                if let Some(context) = preview_context {
                    publish_preview_error(context, &error);
                }
                return Err(error);
            }
            if parser.done {
                return parser.finish(body_bytes).map_err(|error| {
                    let error = invalid_response_error(status, error.to_string());
                    if let Some(context) = preview_context {
                        publish_preview_error(context, &error);
                    }
                    error
                });
            }
        }
        buffer.compact();
    }
}

fn publish_preview_error(context: &ProviderPreviewContext, error: &ProviderError) {
    let diagnostic = error.diagnostic();
    context.sink.publish(LlmTextPreviewFrame::error(
        &context.metadata,
        diagnostic.code,
        diagnostic.retryable,
        diagnostic.status,
    ));
}

fn publish_preview_aborted(context: &ProviderPreviewContext) {
    context.sink.publish(LlmTextPreviewFrame::aborted(
        &context.metadata,
        "provider request cancelled",
    ));
}

struct ResponseBody {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn read_response_body(
    mut response: reqwest::Response,
    cancel: &CancellationToken,
    response_limit: usize,
) -> Result<ResponseBody, ProviderError> {
    let mut bytes = Vec::new();
    let mut truncated = false;

    while let Some(chunk) = await_with_cancel(response.chunk(), cancel)
        .await?
        .map_err(map_reqwest_error)?
    {
        let remaining = response_limit.saturating_sub(bytes.len());
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(ResponseBody { bytes, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_text_preview::{
        LlmTextPreviewFilter, LlmTextPreviewHub, LlmTextPreviewMetadata,
    };
    use crate::types::ToolResult;

    fn provider_config(
        api_compat: ProviderApiCompat,
        thinking_level: ThinkingLevel,
    ) -> OpenAiCompatibleConfig {
        OpenAiCompatibleConfig::new("test", "https://provider.example/v1", "same-model")
            .with_api_compat(api_compat)
            .with_thinking(ThinkingConfig::new(thinking_level))
    }

    fn stream_policy(parse_reasoning: bool) -> ProviderApiCompatPolicy {
        let (api_compat, thinking) = if parse_reasoning {
            (
                ProviderApiCompat::Deepseek,
                ThinkingConfig::new(ThinkingLevel::High),
            )
        } else {
            (
                ProviderApiCompat::Standard,
                ThinkingConfig::new(ThinkingLevel::Off),
            )
        };
        ProviderApiCompatPolicy::new(api_compat, &thinking).expect("stream policy should be valid")
    }

    fn request_dialect(
        api_compat: ProviderApiCompat,
        thinking_level: ThinkingLevel,
    ) -> ProviderRequestDialect {
        let thinking = ThinkingConfig::new(thinking_level);
        let policy = ProviderApiCompatPolicy::new(api_compat, &thinking)
            .expect("request dialect policy should be valid");
        ProviderRequestDialect::from_policy(policy)
    }

    fn request_with_tools(with_tools: bool) -> ProviderRequest {
        let tools = if with_tools {
            vec![ToolSpec::new(
                "status",
                "Check status.",
                json!({"type": "object"}),
            )]
        } else {
            Vec::new()
        };
        ProviderRequest::new(
            "system",
            vec![Message::user(vec![ContentPart::text("hello")])],
            tools,
        )
    }

    #[test]
    fn reasoning_replay_parse_path_is_policy_gated() {
        let value = json!({
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "reasoning_content": "Need the working directory before answering.",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "bash",
                                    "arguments": "{\"command\":\"pwd\"}"
                                }
                            }
                        ]
                    }
                }
            ]
        });

        for (api_compat, thinking_level, expected_replay) in [
            (
                ProviderApiCompat::Deepseek,
                ThinkingLevel::High,
                Some("Need the working directory before answering."),
            ),
            (ProviderApiCompat::DashscopeQwen, ThinkingLevel::XHigh, None),
        ] {
            let response = parse_chat_completions_response(
                &value,
                &provider_config(api_compat, thinking_level),
            )
            .expect("response with reasoning_content should parse");

            assert_eq!(
                response
                    .assistant_replay
                    .as_ref()
                    .and_then(|replay| replay.reasoning_content.as_deref()),
                expected_replay,
                "{api_compat:?} {thinking_level:?}"
            );
        }

        let malformed = json!({
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "reasoning_content": {"private": "malformed"},
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "bash",
                                    "arguments": "{\"command\":\"pwd\"}"
                                }
                            }
                        ]
                    }
                }
            ]
        });

        let response = parse_chat_completions_response(
            &malformed,
            &provider_config(ProviderApiCompat::Deepseek, ThinkingLevel::Off),
        )
        .expect("disabled replay must ignore malformed reasoning_content");
        assert_eq!(response.assistant_replay, None);
    }

    #[test]
    fn reasoning_replay_build_path_is_policy_and_tool_call_gated() {
        fn request_with_replay_tool_call() -> ProviderRequest {
            ProviderRequest::new(
                "system",
                vec![
                    Message::assistant_tool_calls_with_replay(
                        vec![ToolCall::new("call_1", "bash", json!({"command": "pwd"}))],
                        AssistantMessageReplay::reasoning_content(
                            "Need the working directory before answering.",
                        ),
                    ),
                    Message::tool_result(ToolResult::success("call_1", "bash", "/tmp")),
                    Message::user(vec![ContentPart::text("now continue")]),
                ],
                Vec::new(),
            )
        }

        for (api_compat, thinking_level, expected_replay) in [
            (
                ProviderApiCompat::Deepseek,
                ThinkingLevel::High,
                Some("Need the working directory before answering."),
            ),
            (ProviderApiCompat::DashscopeQwen, ThinkingLevel::XHigh, None),
            (ProviderApiCompat::Deepseek, ThinkingLevel::Off, None),
        ] {
            let body = build_chat_completions_request(
                &provider_config(api_compat, thinking_level),
                &request_with_replay_tool_call(),
            )
            .expect("request with replay tool call should build");

            assert_eq!(
                body["messages"][1]
                    .get("reasoning_content")
                    .and_then(Value::as_str),
                expected_replay,
                "{api_compat:?} {thinking_level:?}"
            );
        }

        let text_request = ProviderRequest::new(
            "system",
            vec![Message::Assistant {
                content: Some("final answer".to_owned()),
                tool_calls: Vec::new(),
                assistant_replay: Some(AssistantMessageReplay::reasoning_content(
                    "Private reasoning summary.",
                )),
                usage: None,
                stop_reason: Some(StopReason::EndTurn),
            }],
            Vec::new(),
        );
        let body = build_chat_completions_request(
            &provider_config(ProviderApiCompat::Deepseek, ThinkingLevel::High),
            &text_request,
        )
        .expect("text assistant with replay should build");
        assert!(body["messages"][1].get("reasoning_content").is_none());
    }

    #[test]
    fn reasoning_replay_policy_matrix_matches_provider_requirements() {
        let replay_providers = [
            ProviderApiCompat::Deepseek,
            ProviderApiCompat::DashscopeGlm,
            ProviderApiCompat::ZaiGlm,
        ];
        let non_replay_providers = [ProviderApiCompat::DashscopeQwen];
        let thinking_on_levels = [
            ThinkingLevel::Low,
            ThinkingLevel::Medium,
            ThinkingLevel::High,
            ThinkingLevel::XHigh,
        ];

        for api_compat in replay_providers {
            let thinking = ThinkingConfig::new(ThinkingLevel::Off);
            let policy = ProviderApiCompatPolicy::new(api_compat, &thinking)
                .expect("off thinking should be valid");
            assert!(
                !policy.reasoning_replay().enabled,
                "{api_compat:?} off thinking must not replay"
            );

            for thinking_level in thinking_on_levels {
                let thinking = ThinkingConfig::new(thinking_level);
                let policy = ProviderApiCompatPolicy::new(api_compat, &thinking)
                    .expect("thinking level should be valid");
                assert!(
                    policy.reasoning_replay().enabled,
                    "{api_compat:?} {thinking_level:?} should replay"
                );
            }
        }

        for api_compat in non_replay_providers {
            for thinking_level in [
                ThinkingLevel::Off,
                ThinkingLevel::Low,
                ThinkingLevel::Medium,
                ThinkingLevel::High,
                ThinkingLevel::XHigh,
            ] {
                let thinking = ThinkingConfig::new(thinking_level);
                let policy = ProviderApiCompatPolicy::new(api_compat, &thinking)
                    .expect("thinking level should be valid");
                assert!(
                    !policy.reasoning_replay().enabled,
                    "{api_compat:?} {thinking_level:?} must not replay"
                );
            }
        }

        let thinking = ThinkingConfig::new(ThinkingLevel::Off);
        let policy = ProviderApiCompatPolicy::new(ProviderApiCompat::Standard, &thinking)
            .expect("standard off thinking should be valid");
        assert!(!policy.reasoning_replay().enabled);
    }

    #[test]
    fn request_dialect_streaming_transport_matrix_matches_provider_requirements() {
        for (api_compat, thinking_level, with_tools, expected) in [
            (
                ProviderApiCompat::DashscopeQwen,
                ThinkingLevel::Off,
                false,
                false,
            ),
            (
                ProviderApiCompat::DashscopeQwen,
                ThinkingLevel::XHigh,
                false,
                true,
            ),
            (
                ProviderApiCompat::DashscopeGlm,
                ThinkingLevel::XHigh,
                false,
                false,
            ),
            (
                ProviderApiCompat::DashscopeGlm,
                ThinkingLevel::Off,
                true,
                true,
            ),
            (ProviderApiCompat::ZaiGlm, ThinkingLevel::XHigh, true, false),
        ] {
            let request = request_with_tools(with_tools);
            assert_eq!(
                request_dialect(api_compat, thinking_level).requires_streaming_transport(&request),
                expected,
                "{api_compat:?} {thinking_level:?} with_tools={with_tools}"
            );
        }
    }

    #[test]
    fn sse_event_buffer_handles_lf_and_crlf_separators_in_one_chunk() {
        let mut buffer = SseEventBuffer::default();
        buffer.extend(b"first\n\nsecond\r\n\r\n");

        assert_eq!(buffer.next_event(), Some(b"first".as_slice()));
        assert_eq!(buffer.next_event(), Some(b"second".as_slice()));
        assert_eq!(buffer.next_event(), None);

        buffer.compact();
        assert_eq!(buffer.pending_len(), 0);
    }

    #[test]
    fn sse_event_buffer_handles_separators_split_across_chunks() {
        let mut buffer = SseEventBuffer::default();
        let mut events = Vec::new();

        for chunk in [
            b"first\r".as_slice(),
            b"\n\r".as_slice(),
            b"\nsecond\n".as_slice(),
            b"\n".as_slice(),
        ] {
            buffer.extend(chunk);
            while let Some(event) = buffer.next_event() {
                events.push(event.to_vec());
            }
            buffer.compact();
        }

        assert_eq!(events, [b"first".as_slice(), b"second".as_slice()]);
        assert_eq!(buffer.pending_len(), 0);
    }

    #[test]
    fn sse_event_buffer_compacts_once_after_a_batch_of_events() {
        let mut buffer = SseEventBuffer::default();
        buffer.extend(b"one\n\ntwo\n\npartial");

        assert_eq!(buffer.next_event(), Some(b"one".as_slice()));
        assert_eq!(buffer.next_event(), Some(b"two".as_slice()));
        assert_eq!(buffer.next_event(), None);
        assert_eq!(buffer.pending_len(), b"one\n\ntwo\n\npartial".len());

        buffer.compact();
        assert_eq!(buffer.pending_bytes(), b"partial");
    }

    #[test]
    fn sse_event_buffer_scans_large_chunked_event_near_linearly() {
        const TOTAL_BYTES: usize = MAX_PROVIDER_SUCCESS_RESPONSE_BYTES;
        const CHUNK_BYTES: usize = 4 * 1024;

        let mut buffer = SseEventBuffer::default();
        let chunk = vec![b'x'; CHUNK_BYTES];
        for _ in 0..TOTAL_BYTES / CHUNK_BYTES {
            buffer.extend(&chunk);
            assert_eq!(buffer.next_event(), None);
        }

        assert_eq!(buffer.pending_len(), TOTAL_BYTES);
        assert!(
            buffer.scanned_bytes() <= TOTAL_BYTES + 3 * (TOTAL_BYTES / CHUNK_BYTES),
            "incremental SSE scan revisited too much data: scanned={} buffered={TOTAL_BYTES}",
            buffer.scanned_bytes()
        );
    }

    #[test]
    fn llm_text_preview_stream_parser_handles_split_crlf_utf8_comment_empty_and_done() {
        let hub = LlmTextPreviewHub::new();
        let mut subscription = hub.subscribe(LlmTextPreviewFilter::default());
        let metadata = LlmTextPreviewMetadata {
            provider_request_id: "prq_test_1".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            cycle_id: Some("cyc_test".to_owned()),
            provider_call_index: 1,
            input_ids: vec!["msg_1".to_owned()],
        };
        let context = ProviderPreviewContext::new(metadata, hub.sink());
        let mut parser = ChatCompletionsStreamParser::new(stream_policy(true), Some(context));
        let mut buffer = SseEventBuffer::default();
        let chunks = split_chunks(vec![
            b": comment\r\n\r\n".to_vec(),
            b"\r\n".to_vec(),
            sse_json(json!({
                "choices": [
                    {
                        "delta": {
                            "content": "hi ",
                            "reasoning_content": "private"
                        }
                    }
                ]
            })),
            sse_json(json!({
                "choices": [
                    {
                        "delta": {
                            "content": "世界"
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
        ]);
        let mut body_bytes = 0usize;

        for chunk in chunks {
            body_bytes += chunk.len();
            buffer.extend(&chunk);
            while let Some(event) = buffer.next_event() {
                parser.process_event(event).expect("event should parse");
            }
            buffer.compact();
        }

        assert!(parser.done);
        let response = parser
            .finish(body_bytes)
            .expect("stream should finish")
            .response;
        assert_eq!(response.text.as_deref(), Some("hi 世界"));
        assert_eq!(response.stop_reason, StopReason::EndTurn);
        assert_eq!(response.assistant_replay, None);

        let first_delta = serde_json::to_value(
            subscription
                .try_recv()
                .expect("first preview delta should publish"),
        )
        .expect("frame should serialize");
        let second_delta = serde_json::to_value(
            subscription
                .try_recv()
                .expect("second preview delta should publish"),
        )
        .expect("frame should serialize");
        let finished = serde_json::to_value(
            subscription
                .try_recv()
                .expect("finished preview frame should publish"),
        )
        .expect("frame should serialize");
        assert_eq!(first_delta["delta"], "hi ");
        assert_eq!(second_delta["delta"], "世界");
        assert_eq!(finished["type"], "finished");
        assert_eq!(finished["stop_reason"], "end_turn");
        let encoded = serde_json::to_string(&[first_delta, second_delta, finished])
            .expect("frames should encode");
        assert!(!encoded.contains("private"));
        assert!(!encoded.contains("reasoning_content"));
    }

    #[test]
    fn llm_text_preview_stream_parser_accepts_empty_stop_response() {
        let hub = LlmTextPreviewHub::new();
        let mut subscription = hub.subscribe(LlmTextPreviewFilter::default());
        let metadata = LlmTextPreviewMetadata {
            provider_request_id: "prq_test_empty_stop".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            cycle_id: Some("cyc_test".to_owned()),
            provider_call_index: 2,
            input_ids: vec!["msg_1".to_owned()],
        };
        let context = ProviderPreviewContext::new(metadata, hub.sink());
        let mut parser = ChatCompletionsStreamParser::new(stream_policy(true), Some(context));
        let mut buffer = SseEventBuffer::default();
        let chunks = [
            sse_json(json!({
                "choices": [
                    {
                        "delta": {},
                        "finish_reason": "stop"
                    }
                ]
            })),
            b"data: [DONE]\n\n".to_vec(),
        ];
        let body_bytes = chunks.iter().map(Vec::len).sum();

        for chunk in chunks {
            buffer.extend(&chunk);
            while let Some(event) = buffer.next_event() {
                parser.process_event(event).expect("event should parse");
            }
            buffer.compact();
        }

        assert!(parser.done);
        let response = parser
            .finish(body_bytes)
            .expect("empty stop stream should be passed to the agent loop")
            .response;
        assert_eq!(response.text, None);
        assert!(response.tool_calls.is_empty());
        assert_eq!(response.stop_reason, StopReason::EndTurn);

        let finished = serde_json::to_value(
            subscription
                .try_recv()
                .expect("finished preview frame should publish"),
        )
        .expect("frame should serialize");
        assert_eq!(finished["type"], "finished");
        assert_eq!(finished["text_emitted"], false);
        assert_eq!(finished["stop_reason"], "end_turn");
        assert!(subscription.try_recv().is_err());
    }

    #[test]
    fn llm_text_preview_stream_parser_accepts_empty_provider_stop_response() {
        let hub = LlmTextPreviewHub::new();
        let mut subscription = hub.subscribe(LlmTextPreviewFilter::default());
        let metadata = LlmTextPreviewMetadata {
            provider_request_id: "prq_test_empty_provider_stop".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            cycle_id: Some("cyc_test".to_owned()),
            provider_call_index: 2,
            input_ids: vec!["msg_1".to_owned()],
        };
        let context = ProviderPreviewContext::new(metadata, hub.sink());
        let mut parser = ChatCompletionsStreamParser::new(stream_policy(true), Some(context));
        parser
            .process_event(&sse_json(json!({
                "choices": [
                    {
                        "delta": {},
                        "finish_reason": "length"
                    }
                ]
            })))
            .expect("event should parse before final validation");
        parser
            .process_event(b"data: [DONE]\n\n")
            .expect("done should parse");

        let response = parser
            .finish(128)
            .expect("empty provider stop stream should pass to the agent loop")
            .response;
        assert_eq!(response.text, None);
        assert!(response.tool_calls.is_empty());
        assert_eq!(response.stop_reason, StopReason::ProviderStop);

        let finished = serde_json::to_value(
            subscription
                .try_recv()
                .expect("finished preview frame should publish"),
        )
        .expect("frame should serialize");
        assert_eq!(finished["type"], "finished");
        assert_eq!(finished["text_emitted"], false);
        assert_eq!(finished["stop_reason"], "provider_stop");
        assert!(subscription.try_recv().is_err());
    }

    #[test]
    fn llm_text_preview_stream_parser_rejects_tool_calls_finish_without_tool_calls() {
        let hub = LlmTextPreviewHub::new();
        let metadata = LlmTextPreviewMetadata {
            provider_request_id: "prq_test_empty_tool_calls".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            cycle_id: Some("cyc_test".to_owned()),
            provider_call_index: 3,
            input_ids: vec!["msg_1".to_owned()],
        };
        let context = ProviderPreviewContext::new(metadata, hub.sink());
        let mut parser = ChatCompletionsStreamParser::new(stream_policy(false), Some(context));
        parser
            .process_event(&sse_json(json!({
                "choices": [
                    {
                        "delta": {},
                        "finish_reason": "tool_calls"
                    }
                ]
            })))
            .expect("event should parse before final validation");
        parser
            .process_event(b"data: [DONE]\n\n")
            .expect("done should parse");

        let error = match parser.finish(128) {
            Ok(_) => panic!("tool_calls finish reason must include actual tool calls"),
            Err(error) => error,
        };
        assert!(error
            .to_string()
            .contains("finish_reason tool_calls must include tool_calls"));
    }

    #[test]
    fn dashscope_glm_tool_stream_parser_aggregates_arguments_without_preview() {
        let thinking = ThinkingConfig::new(ThinkingLevel::Off);
        let policy = ProviderApiCompatPolicy::new(ProviderApiCompat::DashscopeGlm, &thinking)
            .expect("dashscope glm off thinking should be valid");
        let mut parser = ChatCompletionsStreamParser::new(policy, None);

        for event in [
            sse_json(json!({
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call_1",
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
                                    "index": 0,
                                    "function": {
                                        "arguments": ":\"pwd\"}"
                                    }
                                }
                            ]
                        },
                        "finish_reason": "tool_calls"
                    }
                ]
            })),
            sse_json(json!({
                "choices": [],
                "usage": {
                    "prompt_tokens": 11,
                    "completion_tokens": 7,
                    "total_tokens": 18
                }
            })),
            b"data: [DONE]\n\n".to_vec(),
        ] {
            parser.process_event(&event).expect("event should parse");
        }

        assert!(parser.done);
        let response = parser
            .finish(256)
            .expect("glm tool stream should finish")
            .response;

        assert_eq!(response.text, None);
        assert_eq!(response.stop_reason, StopReason::ToolCalls);
        assert_eq!(
            response.tool_calls,
            vec![ToolCall::new("call_1", "bash", json!({"command": "pwd"}))]
        );
        assert_eq!(
            response.usage,
            Some(Usage {
                input_tokens: 11,
                output_tokens: 7,
                total_tokens: 18,
                cached_input_tokens: 0,
                reasoning_output_tokens: 0,
            })
        );
    }

    #[test]
    fn stream_parser_tool_calls_win_over_stop_and_length_finish_reasons() {
        for finish_reason in ["stop", "length"] {
            let mut parser = ChatCompletionsStreamParser::new(stream_policy(false), None);

            for event in [
                sse_json(json!({
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_1",
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
                                        "index": 0,
                                        "function": {
                                            "arguments": ":\"pwd\"}"
                                        }
                                    }
                                ]
                            },
                            "finish_reason": finish_reason
                        }
                    ]
                })),
                b"data: [DONE]\n\n".to_vec(),
            ] {
                parser.process_event(&event).expect("event should parse");
            }

            let response = parser
                .finish(256)
                .expect("tool stream should finish")
                .response;

            assert_eq!(response.text, None);
            assert_eq!(response.stop_reason, StopReason::ToolCalls);
            assert_eq!(
                response.tool_calls,
                vec![ToolCall::new("call_1", "bash", json!({"command": "pwd"}))]
            );
        }
    }

    #[test]
    fn stream_parser_replays_only_deepseek_reasoning_content_field() {
        let mut parser = ChatCompletionsStreamParser::new(stream_policy(true), None);

        for event in [
            sse_json(json!({
                "choices": [
                    {
                        "delta": {
                            "reasoning_content": "official replay",
                            "thinking": " private thinking must not replay",
                            "chain_of_thought": " private chain must not replay",
                            "reasoning": " private generic reasoning must not replay"
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
                                    "index": 0,
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "bash",
                                        "arguments": "{}"
                                    }
                                }
                            ]
                        },
                        "finish_reason": "tool_calls"
                    }
                ]
            })),
            b"data: [DONE]\n\n".to_vec(),
        ] {
            parser.process_event(&event).expect("event should parse");
        }

        let response = parser
            .finish(256)
            .expect("deepseek tool stream should finish")
            .response;

        assert_eq!(
            response
                .assistant_replay
                .as_ref()
                .and_then(|replay| replay.reasoning_content.as_deref()),
            Some("official replay")
        );
    }

    #[test]
    fn llm_text_preview_tool_call_assembler_handles_interleaved_indices() {
        let mut assembler = StreamingToolCallAssembler::default();

        assembler
            .push_delta(&json!([
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
                    "id": "call_a",
                    "type": "function",
                    "function": {
                        "name": "bash",
                        "arguments": "{\"command\""
                    }
                }
            ]))
            .expect("first interleaved delta should parse");
        assembler
            .push_delta(&json!([
                {
                    "index": 0,
                    "function": {
                        "arguments": ":\"pwd\"}"
                    }
                }
            ]))
            .expect("second interleaved delta should parse");

        let calls = assembler.finish().expect("tool calls should finish");
        assert_eq!(
            calls,
            vec![
                ToolCall::new("call_a", "bash", json!({"command": "pwd"})),
                ToolCall::new("call_b", "status", json!({})),
            ]
        );
    }

    #[test]
    fn llm_text_preview_tool_call_assembler_defaults_empty_arguments_to_empty_object() {
        let mut assembler = StreamingToolCallAssembler::default();

        assembler
            .push_delta(&json!([
                {
                    "index": 0,
                    "id": "call_empty",
                    "type": "function",
                    "function": {
                        "name": "status"
                    }
                }
            ]))
            .expect("tool call without argument fragments should parse");

        let calls = assembler
            .finish()
            .expect("empty arguments should default to an empty object");
        assert_eq!(
            calls,
            vec![ToolCall::new("call_empty", "status", json!({}))]
        );
    }

    #[test]
    fn llm_text_preview_tool_call_assembler_keeps_invalid_arguments_as_tool_error() {
        let mut assembler = StreamingToolCallAssembler::default();

        assembler
            .push_delta(&json!([
                {
                    "index": 0,
                    "id": "call_bad",
                    "type": "function",
                    "function": {
                        "name": "bash",
                        "arguments": "{\"command\":"
                    }
                }
            ]))
            .expect("invalid JSON arguments are deferred to tool-call validation");

        let calls = assembler
            .finish()
            .expect("invalid arguments should produce an invalid tool call");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_bad");
        assert_eq!(calls[0].name, "bash");
        assert_eq!(calls[0].raw_arguments.as_deref(), Some("{\"command\":"));
        assert!(calls[0]
            .arguments_error
            .as_deref()
            .expect("invalid arguments error")
            .contains("EOF"));
    }

    #[test]
    fn llm_text_preview_tool_call_assembler_marks_conflicting_id_or_name_invalid() {
        let mut id_conflict = StreamingToolCallAssembler::default();
        id_conflict
            .push_delta(&json!([
                {
                    "index": 0,
                    "id": "call_a",
                    "function": {
                        "name": "bash",
                        "arguments": "{}"
                    }
                }
            ]))
            .expect("first id fragment should parse");
        id_conflict
            .push_delta(&json!([
                {
                    "index": 0,
                    "id": "call_b"
                }
            ]))
            .expect("conflicting id fragment should be recorded");

        let id_calls = id_conflict.finish().expect("conflict should finish");
        assert_eq!(id_calls[0].id, "call_a");
        assert_eq!(
            id_calls[0].arguments_error.as_deref(),
            Some("conflicting tool call id fragments")
        );

        let mut name_conflict = StreamingToolCallAssembler::default();
        name_conflict
            .push_delta(&json!([
                {
                    "index": 0,
                    "id": "call_name",
                    "function": {
                        "name": "bash",
                        "arguments": "{}"
                    }
                }
            ]))
            .expect("first name fragment should parse");
        name_conflict
            .push_delta(&json!([
                {
                    "index": 0,
                    "function": {
                        "name": "status"
                    }
                }
            ]))
            .expect("conflicting name fragment should be recorded");

        let name_calls = name_conflict.finish().expect("conflict should finish");
        assert_eq!(name_calls[0].name, "bash");
        assert_eq!(
            name_calls[0].arguments_error.as_deref(),
            Some("conflicting tool call name fragments")
        );
    }

    #[test]
    fn llm_text_preview_tool_call_assembler_rejects_missing_or_invalid_index() {
        for value in [
            json!([{"id": "call_missing", "function": {"name": "bash"}}]),
            json!([{"index": "0", "id": "call_string", "function": {"name": "bash"}}]),
            json!([{"index": -1, "id": "call_negative", "function": {"name": "bash"}}]),
        ] {
            let error = StreamingToolCallAssembler::default()
                .push_delta(&value)
                .expect_err("missing or invalid index should be a provider response error");
            assert!(matches!(error, OpenAiChatError::InvalidResponse { .. }));
            assert!(error.to_string().contains("missing valid index"));
        }
    }

    #[test]
    fn llm_text_preview_tool_call_assembler_rejects_non_string_argument_delta() {
        let mut assembler = StreamingToolCallAssembler::default();

        let error = assembler
            .push_delta(&json!([
                {
                    "index": 0,
                    "id": "call_bad_args",
                    "function": {
                        "name": "bash",
                        "arguments": {"command": "pwd"}
                    }
                }
            ]))
            .expect_err("non-string streaming arguments should be rejected");

        assert!(matches!(error, OpenAiChatError::InvalidResponse { .. }));
        assert!(error.to_string().contains("arguments"));
    }

    fn sse_json(value: Value) -> Vec<u8> {
        format!("data: {}\r\n\r\n", value).into_bytes()
    }

    fn split_chunks(chunks: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let mut split = Vec::new();
        for chunk in chunks {
            if let Some(index) = chunk
                .windows("世界".len())
                .position(|window| window == "世界".as_bytes())
            {
                split.push(chunk[..index + 1].to_vec());
                split.push(chunk[index + 1..].to_vec());
            } else if chunk.len() > 4 {
                let midpoint = chunk.len() / 2;
                split.push(chunk[..midpoint].to_vec());
                split.push(chunk[midpoint..].to_vec());
            } else {
                split.push(chunk);
            }
        }
        split
    }
}
