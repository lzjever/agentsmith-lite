use super::*;
use reqwest::StatusCode;
use thiserror::Error;

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
    pub(super) fn invalid_request(message: impl Into<String>) -> Self {
        Self::InvalidRequest {
            message: message.into(),
        }
    }

    pub(super) fn invalid_response(message: impl Into<String>) -> Self {
        Self::InvalidResponse {
            message: message.into(),
        }
    }
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

pub(super) fn validate_api_key(config: &OpenAiCompatibleConfig) -> Result<(), ProviderError> {
    match config.api_key.as_deref() {
        Some(api_key) if !api_key.trim().is_empty() => Ok(()),
        _ => Err(missing_api_key_error()),
    }
}

pub(super) fn missing_api_key_error() -> ProviderError {
    ProviderError::config(
        "missing OpenAI-compatible provider API key; set the environment variable named by providers[].api_key_env in botified.yaml, or run botified serve with --mock-provider for local development",
    )
}

pub(super) fn cancelled_error() -> ProviderError {
    ProviderError::request_failed("provider request cancelled")
}

pub(super) fn invalid_response_error(
    status: StatusCode,
    message: impl Into<String>,
) -> ProviderError {
    ProviderError::provider_returned(
        Some(status.as_u16()),
        Some("invalid_response".to_owned()),
        message,
    )
}

pub(super) fn non_json_error(status: StatusCode, text: String) -> Value {
    let message = if text.trim().is_empty() {
        status.to_string()
    } else {
        text
    };
    json!({ "error": { "message": message } })
}

pub(super) fn error_body_to_message(bytes: &[u8], truncated: bool) -> String {
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

pub(super) fn map_reqwest_error(error: reqwest::Error) -> ProviderError {
    if error.is_builder() {
        ProviderError::config(error.to_string())
    } else if error.is_timeout() {
        ProviderError::request_failed("provider request timed out")
    } else {
        ProviderError::request_failed(error.to_string())
    }
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}
