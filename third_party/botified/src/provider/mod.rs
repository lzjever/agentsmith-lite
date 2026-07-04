use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::llm_text_preview::ProviderPreviewContext;
use crate::profiling::ProviderProfilingContext;
use crate::provider::router::ProviderCapability;
use crate::tools::ToolSpec;
use crate::types::{
    AssistantMessageReplay, ContextRole, Message, ModelInput, StopReason, ToolCall, Usage,
};

pub mod openai_chat;
pub mod router;
pub mod thinking;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderRequest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input: Vec<ModelInput>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip)]
    profiling_context: Option<ProviderProfilingContext>,
    #[serde(skip)]
    preview_context: Option<ProviderPreviewContext>,
}

impl ProviderRequest {
    pub fn new(
        system_prompt: impl Into<String>,
        messages: Vec<Message>,
        tools: Vec<ToolSpec>,
    ) -> Self {
        let system_prompt = system_prompt.into();
        let mut input = Vec::with_capacity(messages.len() + usize::from(!system_prompt.is_empty()));
        if !system_prompt.is_empty() {
            input.push(ModelInput::context(ContextRole::System, system_prompt));
        }
        input.extend(messages.into_iter().map(ModelInput::message));

        Self {
            input,
            tools,
            temperature: None,
            max_tokens: None,
            profiling_context: None,
            preview_context: None,
        }
    }

    pub fn with_context(self, role: ContextRole, content: impl Into<String>) -> Self {
        self.with_prefix_context(role, content)
    }

    pub fn with_prefix_context(mut self, role: ContextRole, content: impl Into<String>) -> Self {
        self.insert_context_at_transcript_index(role, content, 0);
        self
    }

    pub fn with_turn_context_at_transcript_index(
        mut self,
        role: ContextRole,
        content: impl Into<String>,
        transcript_index: usize,
    ) -> Self {
        self.insert_context_at_transcript_index(role, content, transcript_index);
        self
    }

    pub fn model_input(&self) -> Vec<ModelInput> {
        self.input.clone()
    }

    pub fn transcript_messages(&self) -> Vec<Message> {
        self.input
            .iter()
            .filter_map(|input| match input {
                ModelInput::Message { message } => Some(message.clone()),
                ModelInput::Context { .. } => None,
            })
            .collect()
    }

    pub fn with_temperature(mut self, temperature: f64) -> Self {
        self.temperature = Some(temperature);
        self
    }

    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }

    pub fn with_profiling_context(mut self, context: ProviderProfilingContext) -> Self {
        self.profiling_context = Some(context);
        self
    }

    pub fn set_profiling_context(&mut self, context: ProviderProfilingContext) {
        self.profiling_context = Some(context);
    }

    pub fn profiling_context(&self) -> Option<&ProviderProfilingContext> {
        self.profiling_context.as_ref()
    }

    pub fn with_preview_context(mut self, context: ProviderPreviewContext) -> Self {
        self.preview_context = Some(context);
        self
    }

    pub fn set_preview_context(&mut self, context: ProviderPreviewContext) {
        self.preview_context = Some(context);
    }

    pub fn preview_context(&self) -> Option<&ProviderPreviewContext> {
        self.preview_context.as_ref()
    }

    fn insert_context_at_transcript_index(
        &mut self,
        role: ContextRole,
        content: impl Into<String>,
        transcript_index: usize,
    ) {
        let insert_at = self.input_index_for_transcript_index(transcript_index);
        self.input
            .insert(insert_at, ModelInput::context(role, content));
    }

    fn input_index_for_transcript_index(&self, transcript_index: usize) -> usize {
        let mut message_index = 0;
        for (input_index, input) in self.input.iter().enumerate() {
            if matches!(input, ModelInput::Message { .. }) {
                if message_index == transcript_index {
                    return input_index;
                }
                message_index += 1;
            }
        }
        self.input.len()
    }
}

pub const MAX_PROVIDER_LABEL_CHARS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderMetadata {
    pub profile: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<ProviderCapability>,
}

impl ProviderMetadata {
    pub fn new(profile: impl Into<String>) -> Self {
        let profile = profile.into();
        Self {
            name: Some(profile.clone()),
            profile,
            model: None,
            capabilities: Vec::new(),
        }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    pub fn with_capabilities(
        mut self,
        capabilities: impl IntoIterator<Item = ProviderCapability>,
    ) -> Self {
        self.capabilities = capabilities.into_iter().collect();
        self
    }

    pub fn with_fallbacks(mut self, fallback: Option<ProviderMetadata>) -> Self {
        let Some(fallback) = fallback else {
            return self;
        };

        if self.profile.trim().is_empty() {
            self.profile = fallback.profile;
        }
        if self.name.is_none() {
            self.name = fallback.name;
        }
        if self.model.is_none() {
            self.model = fallback.model;
        }
        if self.capabilities.is_empty() {
            self.capabilities = fallback.capabilities;
        }
        self
    }

    pub fn sanitized(&self) -> Option<Self> {
        let profile = sanitize_provider_label(&self.profile)
            .or_else(|| self.name.as_deref().and_then(sanitize_provider_label))?;
        Some(Self {
            profile,
            name: self.name.as_deref().and_then(sanitize_provider_label),
            model: self.model.as_deref().and_then(sanitize_provider_label),
            capabilities: self.capabilities.clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_replay: Option<AssistantMessageReplay>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    pub stop_reason: StopReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ProviderMetadata>,
}

impl ProviderResponse {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            text: Some(text.into()),
            tool_calls: Vec::new(),
            assistant_replay: None,
            usage: None,
            stop_reason: StopReason::EndTurn,
            metadata: None,
        }
    }

    pub fn tool_calls(tool_calls: Vec<ToolCall>) -> Self {
        Self {
            text: None,
            tool_calls,
            assistant_replay: None,
            usage: None,
            stop_reason: StopReason::ToolCalls,
            metadata: None,
        }
    }
}

fn sanitize_provider_label(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let sanitized = value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_PROVIDER_LABEL_CHARS)
        .collect::<String>();
    (!sanitized.is_empty()).then_some(sanitized)
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("provider config error: {message}")]
    Config { message: String },
    #[error("provider request failed: {message}")]
    RequestFailed { message: String },
    #[error("provider returned error status {status:?} code {code:?}: {message}")]
    ProviderReturned {
        status: Option<u16>,
        code: Option<String>,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderErrorDiagnostic {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub status: Option<u16>,
    pub provider_code: Option<String>,
}

impl ProviderError {
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config {
            message: message.into(),
        }
    }

    pub fn request_failed(message: impl Into<String>) -> Self {
        Self::RequestFailed {
            message: message.into(),
        }
    }

    pub fn provider_returned(
        status: Option<u16>,
        code: Option<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::ProviderReturned {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn diagnostic(&self) -> ProviderErrorDiagnostic {
        match self {
            Self::Config { .. } => ProviderErrorDiagnostic {
                code: "provider_config_error",
                message: self.to_string(),
                retryable: false,
                status: None,
                provider_code: None,
            },
            Self::RequestFailed { .. } => ProviderErrorDiagnostic {
                code: "provider_request_failed",
                message: self.to_string(),
                retryable: true,
                status: None,
                provider_code: None,
            },
            Self::ProviderReturned { status, code, .. } => ProviderErrorDiagnostic {
                code: "provider_returned_error",
                message: self.to_string(),
                retryable: provider_returned_status_is_retryable(*status),
                status: *status,
                provider_code: code.clone(),
            },
        }
    }
}

fn provider_returned_status_is_retryable(status: Option<u16>) -> bool {
    matches!(status, Some(408 | 409 | 429) | Some(500..=599))
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn metadata_for_request(&self, _request: &ProviderRequest) -> Option<ProviderMetadata> {
        None
    }

    async fn complete(
        &self,
        request: ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ContentPart;
    use serde_json::json;

    #[test]
    fn provider_request_with_context_matches_prefix_context_order() {
        let message = user_message("ordinary user");
        let with_context = ProviderRequest::new("base system", vec![message.clone()], Vec::new())
            .with_context(ContextRole::Developer, "developer context")
            .with_context(ContextRole::User, "user context");
        let with_prefix_context =
            ProviderRequest::new("base system", vec![message.clone()], Vec::new())
                .with_prefix_context(ContextRole::Developer, "developer context")
                .with_prefix_context(ContextRole::User, "user context");

        let expected = vec![
            ModelInput::context(ContextRole::System, "base system"),
            ModelInput::context(ContextRole::Developer, "developer context"),
            ModelInput::context(ContextRole::User, "user context"),
            ModelInput::message(message),
        ];

        assert_eq!(with_context.model_input(), expected);
        assert_eq!(with_prefix_context.model_input(), expected);
        assert_eq!(
            with_context.transcript_messages(),
            vec![user_message("ordinary user")]
        );

        let request_without_messages = ProviderRequest::new("", Vec::new(), Vec::new())
            .with_prefix_context(ContextRole::User, "only");
        assert_eq!(
            request_without_messages.model_input(),
            vec![ModelInput::context(ContextRole::User, "only")]
        );
    }

    #[test]
    fn provider_request_inserts_turn_context_before_second_transcript_message() {
        let first = user_message("first");
        let second = user_message("second");

        let request = ProviderRequest::new("", vec![first.clone(), second.clone()], Vec::new())
            .with_turn_context_at_transcript_index(ContextRole::User, "turn context", 1);

        assert_eq!(
            request.model_input(),
            vec![
                ModelInput::message(first.clone()),
                ModelInput::context(ContextRole::User, "turn context"),
                ModelInput::message(second.clone()),
            ]
        );
        assert_eq!(request.transcript_messages(), vec![first, second]);
    }

    #[test]
    fn provider_request_preserves_repeated_turn_context_order() {
        let first = user_message("first");
        let second = user_message("second");

        let request = ProviderRequest::new("", vec![first.clone(), second.clone()], Vec::new())
            .with_turn_context_at_transcript_index(ContextRole::Developer, "first context", 1)
            .with_turn_context_at_transcript_index(ContextRole::User, "second context", 1);

        assert_eq!(
            request.model_input(),
            vec![
                ModelInput::message(first),
                ModelInput::context(ContextRole::Developer, "first context"),
                ModelInput::context(ContextRole::User, "second context"),
                ModelInput::message(second),
            ]
        );
    }

    #[test]
    fn provider_request_appends_turn_context_when_no_messages_exist() {
        let request = ProviderRequest::new("base system", Vec::new(), Vec::new())
            .with_turn_context_at_transcript_index(ContextRole::Developer, "turn context", 3);

        assert_eq!(
            request.model_input(),
            vec![
                ModelInput::context(ContextRole::System, "base system"),
                ModelInput::context(ContextRole::Developer, "turn context"),
            ]
        );
    }

    #[test]
    fn provider_request_prefix_context_does_not_affect_transcript_indices() {
        let first = user_message("first");
        let second = user_message("second");

        let request = ProviderRequest::new(
            "base system",
            vec![first.clone(), second.clone()],
            Vec::new(),
        )
        .with_prefix_context(ContextRole::Developer, "prefix context")
        .with_turn_context_at_transcript_index(ContextRole::User, "turn context", 1);

        assert_eq!(
            request.model_input(),
            vec![
                ModelInput::context(ContextRole::System, "base system"),
                ModelInput::context(ContextRole::Developer, "prefix context"),
                ModelInput::message(first),
                ModelInput::context(ContextRole::User, "turn context"),
                ModelInput::message(second),
            ]
        );
    }

    #[test]
    fn provider_request_serializes_complete_input() {
        let request = ProviderRequest::new(
            "base system",
            vec![user_message("ordinary user")],
            Vec::new(),
        )
        .with_context(ContextRole::Developer, "developer context");

        let value = serde_json::to_value(&request).expect("request should serialize");
        assert!(value.get("system_prompt").is_none());
        assert!(value.get("messages").is_none());
        assert_eq!(
            value["input"],
            json!([
                {"kind": "context", "role": "system", "content": "base system"},
                {"kind": "context", "role": "developer", "content": "developer context"},
                {
                    "kind": "message",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": "ordinary user"}]
                    }
                }
            ])
        );
    }

    #[test]
    fn provider_request_deserialize_rejects_legacy_shape() {
        let legacy = json!({
            "system_prompt": "base system",
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "ordinary user"}]
                }
            ]
        });

        let error = serde_json::from_value::<ProviderRequest>(legacy)
            .expect_err("legacy request shape should not deserialize");

        assert!(
            error.to_string().contains("unknown field"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn provider_request_deserializes_complete_input_shape() {
        let value = json!({
            "input": [
                {"kind": "context", "role": "system", "content": "base system"},
                {"kind": "context", "role": "developer", "content": "developer context"},
                {
                    "kind": "message",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": "ordinary user"}]
                    }
                }
            ],
            "tools": [
                {
                    "name": "bash",
                    "description": "Run commands.",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "command": {"type": "string"}
                        }
                    }
                }
            ],
            "temperature": 0.0,
            "max_tokens": 42
        });

        let request = serde_json::from_value::<ProviderRequest>(value)
            .expect("current input shape should deserialize");

        assert_eq!(
            request.model_input(),
            vec![
                ModelInput::context(ContextRole::System, "base system"),
                ModelInput::context(ContextRole::Developer, "developer context"),
                ModelInput::message(user_message("ordinary user")),
            ]
        );
        assert_eq!(request.tools.len(), 1);
        assert_eq!(request.tools[0].name, "bash");
        assert_eq!(request.temperature, Some(0.0));
        assert_eq!(request.max_tokens, Some(42));
    }

    fn user_message(text: impl Into<String>) -> Message {
        Message::user(vec![ContentPart::text(text)])
    }
}
