use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::files::FileSource;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    ImageUrl {
        url: String,
    },
    ImageBase64 {
        mime_type: String,
        data: String,
    },
    File {
        binding: MessageFileBinding,
    },
    Skill {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arguments: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageFileBinding {
    pub message_id: String,
    pub input_id: String,
    pub content_index: usize,
    pub file_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub source: FileSource,
    pub description: Option<String>,
    pub agent_path: Option<String>,
    pub available: bool,
    pub unavailable_reason: Option<String>,
}

impl MessageFileBinding {
    #[allow(clippy::too_many_arguments)]
    pub fn available(
        message_id: impl Into<String>,
        input_id: impl Into<String>,
        content_index: usize,
        file_id: impl Into<String>,
        filename: impl Into<String>,
        mime_type: impl Into<String>,
        size_bytes: u64,
        sha256: impl Into<String>,
        source: FileSource,
        description: Option<String>,
        agent_path: Option<String>,
    ) -> Self {
        Self {
            message_id: message_id.into(),
            input_id: input_id.into(),
            content_index,
            file_id: file_id.into(),
            filename: filename.into(),
            mime_type: mime_type.into(),
            size_bytes,
            sha256: sha256.into(),
            source,
            description,
            agent_path,
            available: true,
            unavailable_reason: None,
        }
    }

    pub fn unavailable(mut self, reason: impl Into<String>) -> Self {
        self.available = false;
        self.unavailable_reason = Some(reason.into());
        self.agent_path = None;
        self
    }
}

impl ContentPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    pub fn image_url(url: impl Into<String>) -> Self {
        Self::ImageUrl { url: url.into() }
    }

    pub fn image_base64(mime_type: impl Into<String>, data: impl Into<String>) -> Self {
        Self::ImageBase64 {
            mime_type: mime_type.into(),
            data: data.into(),
        }
    }

    pub fn file(binding: MessageFileBinding) -> Self {
        Self::File { binding }
    }

    pub fn skill(
        name: Option<impl Into<String>>,
        path: Option<impl Into<String>>,
        arguments: Option<impl Into<String>>,
    ) -> Self {
        Self::Skill {
            name: name.map(Into::into),
            path: path.map(Into::into),
            arguments: arguments.map(Into::into),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_arguments: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments_error: Option<String>,
}

impl ToolCall {
    pub fn new(id: impl Into<String>, name: impl Into<String>, arguments: Value) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            arguments,
            raw_arguments: None,
            arguments_error: None,
        }
    }

    pub fn invalid_arguments(
        id: impl Into<String>,
        name: impl Into<String>,
        raw_arguments: impl Into<String>,
        arguments_error: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            arguments: Value::Null,
            raw_arguments: Some(raw_arguments.into()),
            arguments_error: Some(arguments_error.into()),
        }
    }

    pub fn has_invalid_arguments(&self) -> bool {
        self.arguments_error.is_some()
    }

    pub fn arguments_json_string(&self) -> String {
        self.raw_arguments
            .clone()
            .unwrap_or_else(|| self.arguments.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantMessageReplay {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

impl AssistantMessageReplay {
    pub fn reasoning_content(reasoning_content: impl Into<String>) -> Self {
        Self {
            reasoning_content: Some(reasoning_content.into()),
        }
    }

    pub fn is_empty(&self) -> bool {
        match self.reasoning_content.as_deref() {
            Some(reasoning_content) => reasoning_content.is_empty(),
            None => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub tool_name: String,
    pub text: String,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub terminate: bool,
    #[serde(default)]
    pub details: Value,
}

impl ToolResult {
    pub fn success(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            text: text.into(),
            is_error: false,
            terminate: false,
            details: Value::Null,
        }
    }

    pub fn error(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        text: impl Into<String>,
        details: Value,
    ) -> Self {
        Self {
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            text: text.into(),
            is_error: true,
            terminate: false,
            details,
        }
    }

    pub fn with_terminate(mut self) -> Self {
        self.terminate = true;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum Message {
    User {
        content: Vec<ContentPart>,
    },
    Assistant {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<ToolCall>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assistant_replay: Option<AssistantMessageReplay>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_reason: Option<StopReason>,
    },
    ToolResult(ToolResult),
}

impl Message {
    pub fn user(content: Vec<ContentPart>) -> Self {
        Self::User { content }
    }

    pub fn assistant_text(text: impl Into<String>) -> Self {
        Self::Assistant {
            content: Some(text.into()),
            tool_calls: Vec::new(),
            assistant_replay: None,
            usage: None,
            stop_reason: Some(StopReason::EndTurn),
        }
    }

    pub fn assistant_tool_calls(tool_calls: Vec<ToolCall>) -> Self {
        Self::Assistant {
            content: None,
            tool_calls,
            assistant_replay: None,
            usage: None,
            stop_reason: Some(StopReason::ToolCalls),
        }
    }

    pub fn assistant_tool_calls_with_replay(
        tool_calls: Vec<ToolCall>,
        assistant_replay: AssistantMessageReplay,
    ) -> Self {
        Self::Assistant {
            content: None,
            tool_calls,
            assistant_replay: Some(assistant_replay),
            usage: None,
            stop_reason: Some(StopReason::ToolCalls),
        }
    }

    pub fn tool_result(result: ToolResult) -> Self {
        Self::ToolResult(result)
    }

    pub fn is_valid_assistant_for_provider_replay(&self) -> bool {
        match self {
            Self::Assistant {
                content,
                tool_calls,
                ..
            } => assistant_payload_is_valid(content.as_deref(), tool_calls),
            Self::User { .. } | Self::ToolResult(_) => true,
        }
    }
}

pub fn assistant_payload_is_valid(content: Option<&str>, tool_calls: &[ToolCall]) -> bool {
    content.is_some_and(|content| !content.trim().is_empty()) || !tool_calls.is_empty()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    #[serde(default)]
    pub reasoning_output_tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    ToolCalls,
    ToolTerminated,
    ProviderStop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextRole {
    System,
    Developer,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelInput {
    Context { role: ContextRole, content: String },
    Message { message: Message },
}

impl ModelInput {
    pub fn context(role: ContextRole, content: impl Into<String>) -> Self {
        Self::Context {
            role,
            content: content.into(),
        }
    }

    pub fn message(message: Message) -> Self {
        Self::Message { message }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}
