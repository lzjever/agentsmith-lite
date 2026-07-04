use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::tasks::InteractiveStdioBridge;
use crate::types::{Message, ToolCall, ToolResult};

mod bash;
pub use bash::BashTool;
mod publish_file;
pub use publish_file::{FilePublicationSink, PublishFileTool, PUBLISH_FILE_TOOL_NAME};
mod registry;
pub use registry::{
    is_registry_tool_name, registry_tools_for_writer, RegistryGetTool, RegistryHistoryTool,
    RegistrySetTool, REGISTRY_GET_TOOL_NAME, REGISTRY_HISTORY_TOOL_NAME, REGISTRY_SET_TOOL_NAME,
};
mod view_image;
pub use view_image::ViewImageTool;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl ToolSpec {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolVisibility {
    #[default]
    Inherited,
    PublicOutput,
    SubagentControl,
}

impl ToolVisibility {
    pub fn is_subagent_visible(self) -> bool {
        matches!(self, Self::Inherited)
    }
}

pub fn tools_for_subagent(tools: &[Arc<dyn Tool>]) -> Vec<Arc<dyn Tool>> {
    tools
        .iter()
        .filter(|tool| tool.visibility().is_subagent_visible())
        .cloned()
        .collect()
}

pub fn tools_for_main(tools: &[Arc<dyn Tool>]) -> Vec<Arc<dyn Tool>> {
    tools.to_vec()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutputSnapshot {
    pub tail: String,
    pub output_bytes: u64,
    pub output_live: bool,
    pub output_complete: bool,
    pub output_last_updated_at: Option<std::time::SystemTime>,
    pub artifact_path: Option<PathBuf>,
    pub output_tail_truncated: bool,
    pub output_artifact_truncated: bool,
    pub output_dropped_bytes: u64,
}

pub trait ToolOutputSink: Send + Sync {
    fn record(&self, bytes: &[u8]) -> Result<ToolOutputSnapshot, ToolError>;

    fn complete(&self) -> Result<ToolOutputSnapshot, ToolError>;

    fn snapshot(&self) -> ToolOutputSnapshot;
}

#[derive(Clone)]
pub struct ToolExecutionContext {
    pub cwd: String,
    pub timeout: ToolTimeout,
    pub output_sink: Option<Arc<dyn ToolOutputSink>>,
    pub interactive_stdio: Option<Arc<dyn InteractiveStdioBridge>>,
    pub provider_transcript_snapshot: Option<Vec<Message>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolTimeout {
    Default,
    Deadline(Duration),
    NoDeadline,
}

impl ToolTimeout {
    pub fn deadline(self) -> Option<Duration> {
        match self {
            Self::Deadline(timeout) => Some(timeout),
            Self::Default | Self::NoDeadline => None,
        }
    }
}

impl std::fmt::Debug for ToolExecutionContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ToolExecutionContext")
            .field("cwd", &self.cwd)
            .field("timeout", &self.timeout)
            .field("has_output_sink", &self.output_sink.is_some())
            .field("has_interactive_stdio", &self.interactive_stdio.is_some())
            .field(
                "provider_transcript_snapshot_len",
                &self
                    .provider_transcript_snapshot
                    .as_ref()
                    .map(|messages| messages.len()),
            )
            .finish()
    }
}

impl PartialEq for ToolExecutionContext {
    fn eq(&self, other: &Self) -> bool {
        self.cwd == other.cwd && self.timeout == other.timeout
    }
}

impl Eq for ToolExecutionContext {}

impl ToolOutputSnapshot {
    pub fn empty_live(artifact_path: Option<PathBuf>) -> Self {
        Self {
            tail: String::new(),
            output_bytes: 0,
            output_live: true,
            output_complete: false,
            output_last_updated_at: None,
            artifact_path,
            output_tail_truncated: false,
            output_artifact_truncated: false,
            output_dropped_bytes: 0,
        }
    }
}

impl ToolExecutionContext {
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            cwd: cwd.into(),
            timeout: ToolTimeout::Default,
            output_sink: None,
            interactive_stdio: None,
            provider_transcript_snapshot: None,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = ToolTimeout::Deadline(timeout);
        self
    }

    pub fn with_no_deadline(mut self) -> Self {
        self.timeout = ToolTimeout::NoDeadline;
        self
    }

    pub fn with_output_sink(mut self, output_sink: Arc<dyn ToolOutputSink>) -> Self {
        self.output_sink = Some(output_sink);
        self
    }

    pub fn with_interactive_stdio(
        mut self,
        interactive_stdio: Arc<dyn InteractiveStdioBridge>,
    ) -> Self {
        self.interactive_stdio = Some(interactive_stdio);
        self
    }

    pub fn with_provider_transcript_snapshot(mut self, messages: Vec<Message>) -> Self {
        self.provider_transcript_snapshot = Some(messages);
        self
    }
}

#[derive(Debug, Error)]
pub enum ToolError {
    #[error("tool execution failed: {message}")]
    ExecutionFailed { message: String },
}

impl ToolError {
    pub fn execution_failed(message: impl Into<String>) -> Self {
        Self::ExecutionFailed {
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::Inherited
    }

    async fn execute(
        &self,
        call: ToolCall,
        context: ToolExecutionContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError>;
}
