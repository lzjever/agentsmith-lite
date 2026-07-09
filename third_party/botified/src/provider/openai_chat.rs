use std::collections::BTreeMap;
use std::future::Future;

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{Certificate, Client, StatusCode};
use serde_json::{json, Map, Number, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::config::OpenAiCompatibleConfig;
use crate::llm_text_preview::{LlmTextPreviewFrame, ProviderPreviewContext};
use crate::message_render::render_file_manifest;
use crate::profiling::{
    CsvEventRow, ProfilingTimestamp, ProviderProfilingContext, ProviderRequestSequence,
    SharedProfiler,
};
use crate::provider::thinking::{ThinkingConfig, ThinkingFormat, ThinkingLevel};
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

const MAX_PROVIDER_SUCCESS_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PROVIDER_ERROR_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_PROVIDER_ERROR_MESSAGE_CHARS: usize = 4096;
const TRUNCATED_MARKER: &str = "... [truncated]";

#[derive(Debug, Error)]
pub enum OpenAiChatError {
    #[error("invalid OpenAI Chat Completions request: {message}")]
    InvalidRequest { message: String },
    #[error("invalid OpenAI Chat Completions response: {message}")]
    InvalidResponse { message: String },
}

impl OpenAiChatError {
    fn invalid_request(message: impl Into<String>) -> Self {
        Self::InvalidRequest {
            message: message.into(),
        }
    }

    fn invalid_response(message: impl Into<String>) -> Self {
        Self::InvalidResponse {
            message: message.into(),
        }
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
        config
            .thinking
            .validate()
            .map_err(|error| ProviderError::config(error.to_string()))?;
        let mut builder = Client::builder().timeout(config.request_timeout);
        if let Some(ca_bundle_path) = config.ca_bundle_path.as_ref() {
            let pem = std::fs::read(ca_bundle_path).map_err(|error| {
                ProviderError::config(format!(
                    "failed to read provider CA bundle {}: {error}",
                    ca_bundle_path.display()
                ))
            })?;
            let certificates = Certificate::from_pem_bundle(&pem).map_err(|error| {
                ProviderError::config(format!(
                    "failed to parse provider CA bundle {}: {error}",
                    ca_bundle_path.display()
                ))
            })?;
            if certificates.is_empty() {
                return Err(ProviderError::config(format!(
                    "provider CA bundle {} did not contain any PEM certificates",
                    ca_bundle_path.display()
                )));
            }
            for certificate in certificates {
                builder = builder.add_root_certificate(certificate);
            }
        }
        let client = builder
            .build()
            .map_err(|error| ProviderError::request_failed(error.to_string()))?;
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
                .with_model(self.config.model.clone()),
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

        let mut body = match build_chat_completions_request(
            &self.config.model,
            &self.config.thinking,
            &request,
        ) {
            Ok(body) => body,
            Err(error) => {
                let error = ProviderError::request_failed(error.to_string());
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
        let preview_context = request.preview_context().cloned();
        if preview_context.is_some() {
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

        if let Some(context) = preview_context.as_ref() {
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
                if let Some(context) = preview_context.as_ref() {
                    if status.is_success() {
                        match read_streaming_response(
                            response,
                            &self.config.thinking,
                            context,
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
                                publish_preview_error(context, &error);
                                Err(error)
                            }
                            Err(error) => {
                                if cancel.is_cancelled() {
                                    publish_preview_aborted(context);
                                } else {
                                    publish_preview_error(context, &error);
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
                                parse_chat_completions_response(
                                    &json_response.value,
                                    &self.config.thinking,
                                )
                                .map_err(|error| ProviderError::request_failed(error.to_string()))
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
                if let Some(context) = preview_context.as_ref() {
                    if cancel.is_cancelled() {
                        publish_preview_aborted(context);
                    } else {
                        publish_preview_error(context, &error);
                    }
                }
                Err(error)
            }
            Err(error) => {
                if let Some(context) = preview_context.as_ref() {
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
                .field("stop_reason", stop_reason_name(response.stop_reason))
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

fn stop_reason_name(stop_reason: StopReason) -> &'static str {
    match stop_reason {
        StopReason::EndTurn => "end_turn",
        StopReason::ToolCalls => "tool_calls",
        StopReason::ToolTerminated => "tool_terminated",
        StopReason::ProviderStop => "provider_stop",
    }
}

pub fn build_chat_completions_request(
    model: &str,
    thinking: &ThinkingConfig,
    request: &ProviderRequest,
) -> Result<Value, OpenAiChatError> {
    if model.trim().is_empty() {
        return Err(OpenAiChatError::invalid_request("model is required"));
    }
    thinking
        .validate()
        .map_err(|error| OpenAiChatError::invalid_request(error.to_string()))?;

    let include_reasoning_content = thinking.includes_reasoning_content_replay();
    let model_input = request.model_input();
    validate_provider_model_input(&model_input).map_err(|error| {
        OpenAiChatError::invalid_request(format!("invalid transcript: {error}"))
    })?;
    let mut messages = Vec::with_capacity(model_input.len());
    for input in &model_input {
        messages.push(map_model_input(input, include_reasoning_content)?);
    }

    let mut body = Map::new();
    body.insert("model".to_owned(), Value::String(model.to_owned()));
    body.insert("messages".to_owned(), Value::Array(messages));

    if !request.tools.is_empty() {
        body.insert(
            "tools".to_owned(),
            Value::Array(request.tools.iter().map(map_tool_spec).collect()),
        );
    }
    if let Some(temperature) = request.temperature {
        let temperature = Number::from_f64(temperature)
            .ok_or_else(|| OpenAiChatError::invalid_request("temperature must be finite"))?;
        body.insert("temperature".to_owned(), Value::Number(temperature));
    }
    if let Some(max_tokens) = request.max_tokens {
        body.insert(
            "max_tokens".to_owned(),
            Value::Number(Number::from(u64::from(max_tokens))),
        );
    }
    apply_thinking_config(&mut body, thinking)?;

    Ok(Value::Object(body))
}

fn enable_streaming_request(body: &mut Value) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    object.insert("stream".to_owned(), Value::Bool(true));
    object.insert(
        "stream_options".to_owned(),
        json!({ "include_usage": true }),
    );
}

pub fn parse_chat_completions_response(
    value: &Value,
    thinking: &ThinkingConfig,
) -> Result<ProviderResponse, OpenAiChatError> {
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| OpenAiChatError::invalid_response("missing first choice"))?;
    let message = choice
        .get("message")
        .and_then(Value::as_object)
        .ok_or_else(|| OpenAiChatError::invalid_response("missing assistant message"))?;
    let text = parse_assistant_text(message)?;
    let tool_calls = parse_tool_calls(message.get("tool_calls"))?;
    let finish_reason = choice.get("finish_reason").and_then(Value::as_str);
    let stop_reason = map_finish_reason(finish_reason, &tool_calls);
    if !assistant_payload_is_compatible(finish_reason, text.as_deref(), &tool_calls, stop_reason) {
        return Err(OpenAiChatError::invalid_response(
            "assistant message must include non-empty content or tool_calls, and finish_reason tool_calls must include tool_calls",
        ));
    }
    let assistant_replay =
        parse_reasoning_content(message, thinking.includes_reasoning_content_replay())?
            .map(AssistantMessageReplay::reasoning_content);

    Ok(ProviderResponse {
        text,
        tool_calls,
        assistant_replay,
        usage: parse_usage(value.get("usage"))?,
        stop_reason,
        metadata: None,
    })
}

pub fn parse_provider_error(status: u16, value: &Value) -> ProviderError {
    let error = value.get("error").unwrap_or(value);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .unwrap_or("provider returned an error");
    let code = error
        .get("code")
        .and_then(value_to_string)
        .or_else(|| error.get("type").and_then(value_to_string));

    ProviderError::provider_returned(
        Some(status),
        code,
        truncate_text(message, MAX_PROVIDER_ERROR_MESSAGE_CHARS, false),
    )
}

fn apply_thinking_config(
    body: &mut Map<String, Value>,
    thinking: &ThinkingConfig,
) -> Result<(), OpenAiChatError> {
    match (thinking.format, thinking.level) {
        (ThinkingFormat::None, ThinkingLevel::Off) => {}
        (ThinkingFormat::OpenAi, ThinkingLevel::Off) => {
            if let Some(effort) = thinking
                .mapped_off_level()
                .map_err(|error| OpenAiChatError::invalid_request(error.to_string()))?
            {
                body.insert("reasoning_effort".to_owned(), Value::String(effort));
            }
        }
        (ThinkingFormat::OpenAi, _) => {
            body.insert(
                "reasoning_effort".to_owned(),
                Value::String(mapped_non_off_level(thinking)?),
            );
        }
        (ThinkingFormat::Deepseek, ThinkingLevel::Off) => {
            body.insert("thinking".to_owned(), thinking_type("disabled"));
        }
        (ThinkingFormat::Deepseek, _) => {
            body.insert("thinking".to_owned(), thinking_type("enabled"));
            body.insert(
                "reasoning_effort".to_owned(),
                Value::String(mapped_non_off_level(thinking)?),
            );
        }
        (ThinkingFormat::Qwen, ThinkingLevel::Off) => {
            body.insert("enable_thinking".to_owned(), Value::Bool(false));
        }
        (ThinkingFormat::Qwen, _) => {
            body.insert("enable_thinking".to_owned(), Value::Bool(true));
            if let Some(budget_tokens) = thinking.budget_tokens {
                body.insert(
                    "thinking_budget".to_owned(),
                    Value::Number(Number::from(u64::from(budget_tokens))),
                );
            }
        }
        (ThinkingFormat::Glm, ThinkingLevel::Off) => {
            body.insert("thinking".to_owned(), thinking_type("disabled"));
        }
        (ThinkingFormat::Glm, _) => {
            body.insert("thinking".to_owned(), thinking_type("enabled"));
        }
        (ThinkingFormat::None, _) => {
            return Err(OpenAiChatError::invalid_request(
                "thinking format none requires level off",
            ));
        }
    }
    Ok(())
}

fn mapped_non_off_level(thinking: &ThinkingConfig) -> Result<String, OpenAiChatError> {
    thinking
        .mapped_non_off_level()
        .map_err(|error| OpenAiChatError::invalid_request(error.to_string()))
}

fn thinking_type(value: &str) -> Value {
    json!({ "type": value })
}

fn validate_api_key(config: &OpenAiCompatibleConfig) -> Result<(), ProviderError> {
    match config.api_key.as_deref() {
        Some(api_key) if !api_key.trim().is_empty() => Ok(()),
        _ => Err(missing_api_key_error()),
    }
}

fn missing_api_key_error() -> ProviderError {
    ProviderError::config(
        "missing OpenAI-compatible provider API key; set the environment variable named by providers[].api_key_env in botified.yaml, or run botified serve with --mock-provider for local development",
    )
}

fn cancelled_error() -> ProviderError {
    ProviderError::request_failed("provider request cancelled")
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
            return Err(ProviderError::request_failed(format!(
                "provider response exceeded {MAX_PROVIDER_SUCCESS_RESPONSE_BYTES} byte limit"
            )));
        }
        return Ok(JsonResponse {
            value: non_json_error(status, error_body_to_message(&body.bytes, true)),
            body_bytes,
        });
    }

    match serde_json::from_slice(&body.bytes) {
        Ok(value) => Ok(JsonResponse { value, body_bytes }),
        Err(error) if status.is_success() => Err(ProviderError::request_failed(format!(
            "invalid provider JSON response: {error}"
        ))),
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
    thinking: &ThinkingConfig,
    preview_context: &ProviderPreviewContext,
    cancel: &CancellationToken,
) -> Result<StreamingResponse, ProviderError> {
    let mut stream = response.bytes_stream();
    let mut parser = ChatCompletionsStreamParser::new(
        thinking.includes_reasoning_content_replay(),
        preview_context.clone(),
    );
    let mut buffer = Vec::new();
    let mut body_bytes = 0usize;

    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => {
                publish_preview_aborted(preview_context);
                return Err(cancelled_error());
            }
            next = stream.next() => next,
        };

        let Some(chunk) = next else {
            let error = ProviderError::request_failed("provider stream ended before [DONE]");
            publish_preview_error(preview_context, &error);
            return Err(error);
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                let error = map_reqwest_error(error);
                if cancel.is_cancelled() {
                    publish_preview_aborted(preview_context);
                } else {
                    publish_preview_error(preview_context, &error);
                }
                return Err(error);
            }
        };
        body_bytes = match body_bytes.checked_add(chunk.len()) {
            Some(total) if total <= MAX_PROVIDER_SUCCESS_RESPONSE_BYTES => total,
            _ => {
                let error = ProviderError::request_failed(format!(
                    "provider response exceeded {MAX_PROVIDER_SUCCESS_RESPONSE_BYTES} byte limit"
                ));
                publish_preview_error(preview_context, &error);
                return Err(error);
            }
        };
        buffer.extend_from_slice(&chunk);

        while let Some((index, separator_len)) = find_sse_event_separator(&buffer) {
            let event = buffer[..index].to_vec();
            buffer.drain(..index + separator_len);
            if let Err(error) = parser.process_event(&event) {
                let error = ProviderError::request_failed(error.to_string());
                publish_preview_error(preview_context, &error);
                return Err(error);
            }
            if parser.done {
                return parser.finish(body_bytes).map_err(|error| {
                    let error = ProviderError::request_failed(error.to_string());
                    publish_preview_error(preview_context, &error);
                    error
                });
            }
        }
    }
}

fn find_sse_event_separator(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer.windows(2).position(|window| window == b"\n\n");
    let crlf = buffer.windows(4).position(|window| window == b"\r\n\r\n");
    match (crlf, lf) {
        (Some(crlf), Some(lf)) if crlf <= lf => Some((crlf, 4)),
        (Some(_), Some(lf)) => Some((lf, 2)),
        (Some(crlf), None) => Some((crlf, 4)),
        (None, Some(lf)) => Some((lf, 2)),
        (None, None) => None,
    }
}

struct ChatCompletionsStreamParser {
    include_reasoning_content: bool,
    preview_context: ProviderPreviewContext,
    text: String,
    reasoning_content: String,
    tool_calls: StreamingToolCallAssembler,
    usage: Option<Usage>,
    finish_reason: Option<String>,
    text_emitted: bool,
    done: bool,
}

impl ChatCompletionsStreamParser {
    fn new(include_reasoning_content: bool, preview_context: ProviderPreviewContext) -> Self {
        Self {
            include_reasoning_content,
            preview_context,
            text: String::new(),
            reasoning_content: String::new(),
            tool_calls: StreamingToolCallAssembler::default(),
            usage: None,
            finish_reason: None,
            text_emitted: false,
            done: false,
        }
    }

    fn process_event(&mut self, event: &[u8]) -> Result<(), OpenAiChatError> {
        let event = std::str::from_utf8(event).map_err(|error| {
            OpenAiChatError::invalid_response(format!("invalid SSE UTF-8: {error}"))
        })?;
        let mut data_lines = Vec::new();
        for raw_line in event.lines() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            if let Some(data) = line.strip_prefix("data:") {
                data_lines.push(data.strip_prefix(' ').unwrap_or(data));
            }
        }
        if data_lines.is_empty() {
            return Ok(());
        }
        let data = data_lines.join("\n");
        if data.trim() == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        let value: Value = serde_json::from_str(&data).map_err(|error| {
            OpenAiChatError::invalid_response(format!("invalid streaming JSON chunk: {error}"))
        })?;
        self.process_json_chunk(&value)
    }

    fn process_json_chunk(&mut self, value: &Value) -> Result<(), OpenAiChatError> {
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(|| OpenAiChatError::invalid_response("streaming chunk missing choices"))?;
        if choices.is_empty() {
            if value.get("usage").is_some() {
                self.usage = parse_usage(value.get("usage"))?;
            }
            return Ok(());
        }

        if value.get("usage").is_some() {
            self.usage = parse_usage(value.get("usage"))?;
        }

        let choice = choices
            .first()
            .ok_or_else(|| OpenAiChatError::invalid_response("missing first choice"))?;
        if let Some(finish_reason) = choice.get("finish_reason") {
            match finish_reason {
                Value::String(value) => self.finish_reason = Some(value.clone()),
                Value::Null => {}
                _ => {
                    return Err(OpenAiChatError::invalid_response(
                        "finish_reason must be a string",
                    ));
                }
            }
        }
        let Some(delta) = choice.get("delta") else {
            return Ok(());
        };
        let delta = delta
            .as_object()
            .ok_or_else(|| OpenAiChatError::invalid_response("delta must be an object"))?;

        self.accumulate_visible_delta(delta, "content")?;
        self.accumulate_visible_delta(delta, "refusal")?;

        self.accumulate_reasoning(delta);
        if let Some(tool_calls) = delta.get("tool_calls") {
            self.tool_calls.push_delta(tool_calls)?;
        }
        Ok(())
    }

    fn accumulate_visible_delta(
        &mut self,
        delta: &Map<String, Value>,
        key: &str,
    ) -> Result<(), OpenAiChatError> {
        match delta.get(key) {
            Some(Value::String(content)) if !content.is_empty() => {
                self.text.push_str(content);
                self.text_emitted = true;
                self.preview_context
                    .sink
                    .publish(LlmTextPreviewFrame::text_delta(
                        &self.preview_context.metadata,
                        content,
                    ));
            }
            Some(Value::String(_)) | Some(Value::Null) | None => {}
            Some(_) => {
                return Err(OpenAiChatError::invalid_response(format!(
                    "delta {key} must be a string"
                )));
            }
        }
        Ok(())
    }

    fn accumulate_reasoning(&mut self, delta: &Map<String, Value>) {
        if !self.include_reasoning_content {
            return;
        }
        for key in [
            "reasoning_content",
            "reasoning",
            "thinking",
            "chain_of_thought",
        ] {
            if let Some(value) = delta.get(key).and_then(Value::as_str) {
                self.reasoning_content.push_str(value);
            }
        }
    }

    fn finish(self, body_bytes: usize) -> Result<StreamingResponse, OpenAiChatError> {
        let tool_calls = self.tool_calls.finish()?;
        let text = (!self.text.is_empty()).then_some(self.text);
        let finish_reason = self.finish_reason.as_deref();
        let stop_reason = map_finish_reason(finish_reason, &tool_calls);
        if !assistant_payload_is_compatible(
            finish_reason,
            text.as_deref(),
            &tool_calls,
            stop_reason,
        ) {
            return Err(OpenAiChatError::invalid_response(
                "assistant message must include non-empty content or tool_calls, and finish_reason tool_calls must include tool_calls",
            ));
        }
        let assistant_replay = (!self.reasoning_content.is_empty())
            .then(|| AssistantMessageReplay::reasoning_content(self.reasoning_content));
        self.preview_context
            .sink
            .publish(LlmTextPreviewFrame::finished(
                &self.preview_context.metadata,
                self.text_emitted,
                stop_reason,
            ));

        Ok(StreamingResponse {
            response: ProviderResponse {
                text,
                tool_calls,
                assistant_replay,
                usage: self.usage,
                stop_reason,
                metadata: None,
            },
            body_bytes,
        })
    }
}

fn map_finish_reason(finish_reason: Option<&str>, tool_calls: &[ToolCall]) -> StopReason {
    if !tool_calls.is_empty() || finish_reason == Some("tool_calls") {
        StopReason::ToolCalls
    } else if finish_reason == Some("stop") {
        StopReason::EndTurn
    } else {
        StopReason::ProviderStop
    }
}

fn assistant_payload_is_compatible(
    finish_reason: Option<&str>,
    text: Option<&str>,
    tool_calls: &[ToolCall],
    stop_reason: StopReason,
) -> bool {
    if finish_reason == Some("tool_calls") && tool_calls.is_empty() {
        return false;
    }
    assistant_payload_is_valid(text, tool_calls)
        || matches!(stop_reason, StopReason::EndTurn | StopReason::ProviderStop)
}

#[derive(Default)]
struct StreamingToolCallAssembler {
    parts: BTreeMap<usize, StreamingToolCallPart>,
}

impl StreamingToolCallAssembler {
    fn push_delta(&mut self, value: &Value) -> Result<(), OpenAiChatError> {
        let calls = value.as_array().ok_or_else(|| {
            OpenAiChatError::invalid_response("delta.tool_calls must be an array")
        })?;
        for call in calls {
            let index = call
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| {
                    OpenAiChatError::invalid_response("delta.tool_calls missing valid index")
                })?;
            let part = self.parts.entry(index).or_default();
            match call.get("type") {
                Some(Value::String(call_type)) if call_type == "function" => {}
                Some(Value::String(_)) => {
                    return Err(OpenAiChatError::invalid_response(
                        "tool call type must be function",
                    ));
                }
                Some(Value::Null) | None => {}
                Some(_) => {
                    return Err(OpenAiChatError::invalid_response(
                        "tool call type must be function",
                    ));
                }
            }
            if let Some(id) = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                part.set_id(id);
            }
            let Some(function) = call.get("function") else {
                continue;
            };
            let function = function.as_object().ok_or_else(|| {
                OpenAiChatError::invalid_response("delta.tool_calls function must be an object")
            })?;
            if let Some(name) = function
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
            {
                part.set_name(name);
            }
            match function.get("arguments") {
                Some(Value::String(arguments)) => part.arguments.push_str(arguments),
                Some(Value::Null) | None => {}
                Some(_) => {
                    return Err(OpenAiChatError::invalid_response(
                        "delta.tool_calls function.arguments must be a string",
                    ));
                }
            }
        }
        Ok(())
    }

    fn finish(self) -> Result<Vec<ToolCall>, OpenAiChatError> {
        self.parts
            .into_iter()
            .map(|(index, part)| part.finish(index))
            .collect()
    }
}

#[derive(Default)]
struct StreamingToolCallPart {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    conflict: Option<String>,
}

impl StreamingToolCallPart {
    fn set_id(&mut self, id: &str) {
        match self.id.as_deref() {
            Some(existing) if existing != id => {
                self.conflict = Some("conflicting tool call id fragments".to_owned());
            }
            Some(_) => {}
            None => self.id = Some(id.to_owned()),
        }
    }

    fn set_name(&mut self, name: &str) {
        match self.name.as_deref() {
            Some(existing) if existing != name => {
                self.conflict = Some("conflicting tool call name fragments".to_owned());
            }
            Some(_) => {}
            None => self.name = Some(name.to_owned()),
        }
    }

    fn finish(self, index: usize) -> Result<ToolCall, OpenAiChatError> {
        let id = self.id.ok_or_else(|| {
            OpenAiChatError::invalid_response(format!("tool call {index} missing id"))
        })?;
        let name = self.name.ok_or_else(|| {
            OpenAiChatError::invalid_response(format!("tool call {index} missing name"))
        })?;
        let arguments = if self.arguments.is_empty() {
            "{}".to_owned()
        } else {
            self.arguments
        };
        if let Some(conflict) = self.conflict {
            return Ok(ToolCall::invalid_arguments(id, name, arguments, conflict));
        }
        Ok(match serde_json::from_str::<Value>(&arguments) {
            Ok(arguments_value) if arguments_value.is_object() => {
                ToolCall::new(id, name, arguments_value)
            }
            Ok(_) => ToolCall::invalid_arguments(
                id,
                name,
                arguments,
                "tool arguments must be a JSON object",
            ),
            Err(error) => ToolCall::invalid_arguments(id, name, arguments, error.to_string()),
        })
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

fn non_json_error(status: StatusCode, text: String) -> Value {
    let message = if text.trim().is_empty() {
        status.to_string()
    } else {
        text
    };
    json!({ "error": { "message": message } })
}

fn error_body_to_message(bytes: &[u8], truncated: bool) -> String {
    let text = String::from_utf8_lossy(bytes);
    truncate_text(&text, MAX_PROVIDER_ERROR_MESSAGE_CHARS, truncated)
}

fn truncate_text(text: &str, max_chars: usize, force_marker: bool) -> String {
    let mut truncated = text.chars().count() > max_chars;
    let mut result: String = text.chars().take(max_chars).collect();
    if force_marker {
        truncated = true;
    }
    if truncated {
        result.push_str(TRUNCATED_MARKER);
    }
    result
}

fn map_reqwest_error(error: reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::request_failed("provider request timed out")
    } else {
        ProviderError::request_failed(error.to_string())
    }
}

fn map_model_input(
    input: &ModelInput,
    include_reasoning_content: bool,
) -> Result<Value, OpenAiChatError> {
    match input {
        ModelInput::Context { role, content } => Ok(json!({
            "role": map_context_role(*role),
            "content": content
        })),
        ModelInput::Message { message } => map_message(message, include_reasoning_content),
    }
}

fn map_context_role(role: ContextRole) -> &'static str {
    match role {
        ContextRole::System => "system",
        ContextRole::Developer => "system",
        ContextRole::User => "user",
    }
}

fn map_message(
    message: &Message,
    include_reasoning_content: bool,
) -> Result<Value, OpenAiChatError> {
    match message {
        Message::User { content } => Ok(json!({
            "role": "user",
            "content": content
                .iter()
                .map(map_content_part)
                .collect::<Vec<_>>()
        })),
        Message::Assistant {
            content,
            tool_calls,
            assistant_replay,
            ..
        } => {
            if !assistant_payload_is_valid(content.as_deref(), tool_calls) {
                return Err(OpenAiChatError::invalid_request(
                    "assistant message must include non-empty content or tool_calls",
                ));
            }
            let mut object = Map::new();
            object.insert("role".to_owned(), Value::String("assistant".to_owned()));
            object.insert(
                "content".to_owned(),
                content.clone().map(Value::String).unwrap_or(Value::Null),
            );
            if include_reasoning_content {
                if let Some(reasoning_content) = assistant_replay
                    .as_ref()
                    .and_then(|replay| replay.reasoning_content.as_deref())
                    .filter(|reasoning_content| !reasoning_content.is_empty())
                {
                    object.insert(
                        "reasoning_content".to_owned(),
                        Value::String(reasoning_content.to_owned()),
                    );
                }
            }
            if !tool_calls.is_empty() {
                object.insert(
                    "tool_calls".to_owned(),
                    Value::Array(tool_calls.iter().map(map_tool_call).collect()),
                );
            }
            Ok(Value::Object(object))
        }
        Message::ToolResult(result) => Ok(json!({
            "role": "tool",
            "tool_call_id": result.tool_call_id,
            "content": result.text
        })),
    }
}

fn map_content_part(part: &ContentPart) -> Value {
    match part {
        ContentPart::Text { text } => json!({
            "type": "text",
            "text": text
        }),
        ContentPart::ImageUrl { url } => json!({
            "type": "image_url",
            "image_url": {"url": url}
        }),
        ContentPart::ImageBase64 { mime_type, data } => json!({
            "type": "image_url",
            "image_url": {"url": format!("data:{mime_type};base64,{data}")}
        }),
        ContentPart::File { binding } => json!({
            "type": "text",
            "text": render_file_manifest(binding)
        }),
        ContentPart::Skill {
            name,
            path,
            arguments,
        } => json!({
            "type": "text",
            "text": format!(
                "Requested skill: name={}, path={}, arguments={}",
                name.as_deref().unwrap_or(""),
                path.as_deref().unwrap_or(""),
                arguments.as_deref().unwrap_or("")
            )
        }),
    }
}

fn map_tool_spec(spec: &ToolSpec) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": spec.name,
            "description": spec.description,
            "parameters": spec.input_schema
        }
    })
}

fn map_tool_call(call: &ToolCall) -> Value {
    json!({
        "id": call.id,
        "type": "function",
        "function": {
            "name": call.name,
            "arguments": call.arguments_json_string()
        }
    })
}

fn parse_tool_calls(value: Option<&Value>) -> Result<Vec<ToolCall>, OpenAiChatError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let calls = value
        .as_array()
        .ok_or_else(|| OpenAiChatError::invalid_response("tool_calls must be an array"))?;
    calls
        .iter()
        .map(|call| {
            if call.get("type").and_then(Value::as_str) != Some("function") {
                return Err(OpenAiChatError::invalid_response(
                    "tool call type must be function",
                ));
            }
            let id = required_str(call, "id")?;
            let function = call
                .get("function")
                .and_then(Value::as_object)
                .ok_or_else(|| OpenAiChatError::invalid_response("tool call missing function"))?;
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| OpenAiChatError::invalid_response("tool call missing name"))?;
            let arguments = match function.get("arguments") {
                Some(Value::String(arguments)) => arguments.as_str(),
                Some(_) => {
                    return Err(OpenAiChatError::invalid_response(
                        "tool call arguments must be a string",
                    ))
                }
                None => "{}",
            };
            Ok(match serde_json::from_str::<Value>(arguments) {
                Ok(arguments) if arguments.is_object() => ToolCall::new(id, name, arguments),
                Ok(_) => ToolCall::invalid_arguments(
                    id,
                    name,
                    arguments,
                    "tool arguments must be a JSON object",
                ),
                Err(error) => ToolCall::invalid_arguments(id, name, arguments, error.to_string()),
            })
        })
        .collect()
}

fn parse_usage(value: Option<&Value>) -> Result<Option<Usage>, OpenAiChatError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    Ok(Some(Usage {
        input_tokens: required_u64(value, "prompt_tokens")?,
        output_tokens: required_u64(value, "completion_tokens")?,
        total_tokens: required_u64(value, "total_tokens")?,
        cached_input_tokens: optional_nested_u64(value, "prompt_tokens_details", "cached_tokens"),
        reasoning_output_tokens: optional_nested_u64(
            value,
            "completion_tokens_details",
            "reasoning_tokens",
        ),
    }))
}

fn parse_reasoning_content(
    message: &Map<String, Value>,
    include_reasoning_content: bool,
) -> Result<Option<String>, OpenAiChatError> {
    if !include_reasoning_content {
        return Ok(None);
    }

    match message.get("reasoning_content") {
        Some(Value::String(reasoning_content)) if !reasoning_content.is_empty() => {
            Ok(Some(reasoning_content.clone()))
        }
        Some(Value::String(_)) | Some(Value::Null) | None => Ok(None),
        _ => Err(OpenAiChatError::invalid_response(
            "assistant reasoning_content must be a string",
        )),
    }
}

fn parse_assistant_text(message: &Map<String, Value>) -> Result<Option<String>, OpenAiChatError> {
    if let Some(refusal) = message.get("refusal").and_then(Value::as_str) {
        if !refusal.is_empty() {
            return Ok(Some(refusal.to_owned()));
        }
    }

    match message.get("content") {
        Some(Value::String(content)) if !content.is_empty() => Ok(Some(content.clone())),
        Some(Value::String(_)) | Some(Value::Null) | None => Ok(None),
        Some(Value::Array(parts)) => parse_assistant_content_parts(parts),
        _ => Err(OpenAiChatError::invalid_response(
            "assistant content must be a string or content parts array",
        )),
    }
}

fn parse_assistant_content_parts(parts: &[Value]) -> Result<Option<String>, OpenAiChatError> {
    let mut text = Vec::new();
    for part in parts {
        let part_type = part.get("type").and_then(Value::as_str);
        match part_type {
            Some("text") => {
                if let Some(value) = part.get("text").and_then(Value::as_str) {
                    if !value.is_empty() {
                        text.push(value.to_owned());
                    }
                }
            }
            Some("refusal") => {
                if let Some(value) = part.get("refusal").and_then(Value::as_str) {
                    if !value.is_empty() {
                        text.push(value.to_owned());
                    }
                }
            }
            _ => {}
        }
    }

    if text.is_empty() {
        Ok(None)
    } else {
        Ok(Some(text.join("\n")))
    }
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, OpenAiChatError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| OpenAiChatError::invalid_response(format!("missing string field {key}")))
}

fn required_u64(value: &Value, key: &str) -> Result<u64, OpenAiChatError> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| OpenAiChatError::invalid_response(format!("missing integer field {key}")))
}

fn optional_nested_u64(value: &Value, object_key: &str, key: &str) -> u64 {
    value
        .get(object_key)
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .unwrap_or_default()
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_text_preview::{
        LlmTextPreviewFilter, LlmTextPreviewHub, LlmTextPreviewMetadata,
    };
    use std::path::PathBuf;

    #[test]
    fn ca_bundle_path_is_loaded_when_building_openai_chat_provider() {
        let path = temp_file_path("ca-bundle-invalid.pem");
        std::fs::write(&path, b"not a pem certificate").expect("write invalid CA bundle");

        let error = match OpenAiChatProvider::new(
            OpenAiCompatibleConfig::new("local-openai", "https://models.local.test/v1", "gpt")
                .with_api_key("sk-test")
                .with_ca_bundle_path(path.clone()),
        ) {
            Ok(_) => panic!("invalid CA bundle should fail provider construction"),
            Err(error) => error,
        };

        let message = error.to_string();
        assert!(message.contains("CA bundle"));
        assert!(message.contains(&path.display().to_string()));
        let _ = std::fs::remove_file(path);
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
        let mut parser = ChatCompletionsStreamParser::new(true, context);
        let mut buffer = Vec::new();
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
            buffer.extend_from_slice(&chunk);
            while let Some((index, separator_len)) = find_sse_event_separator(&buffer) {
                let event = buffer[..index].to_vec();
                buffer.drain(..index + separator_len);
                parser.process_event(&event).expect("event should parse");
            }
        }

        assert!(parser.done);
        let response = parser
            .finish(body_bytes)
            .expect("stream should finish")
            .response;
        assert_eq!(response.text.as_deref(), Some("hi 世界"));
        assert_eq!(response.stop_reason, StopReason::EndTurn);
        assert_eq!(
            response
                .assistant_replay
                .as_ref()
                .and_then(|replay| replay.reasoning_content.as_deref()),
            Some("private")
        );

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
        let mut parser = ChatCompletionsStreamParser::new(true, context);
        let mut buffer = Vec::new();
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
            buffer.extend_from_slice(&chunk);
            while let Some((index, separator_len)) = find_sse_event_separator(&buffer) {
                let event = buffer[..index].to_vec();
                buffer.drain(..index + separator_len);
                parser.process_event(&event).expect("event should parse");
            }
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
        let mut parser = ChatCompletionsStreamParser::new(true, context);
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
        let mut parser = ChatCompletionsStreamParser::new(false, context);
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

    fn temp_file_path(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "botified-openai-chat-{name}-{}-{stamp}",
            std::process::id()
        ))
    }
}
