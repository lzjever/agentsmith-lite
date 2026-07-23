use std::{
    path::PathBuf,
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::agent_loop::InputUrgency;
use crate::types::ContentPart;

use super::DEFAULT_OUTPUT_TAIL_LIMIT;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskOutputPolicy {
    pub data_dir: PathBuf,
    pub callback_output_tail_bytes: usize,
    pub max_task_output_bytes: usize,
}

impl TaskOutputPolicy {
    pub fn new(
        data_dir: impl Into<PathBuf>,
        callback_output_tail_bytes: usize,
        max_task_output_bytes: usize,
    ) -> Self {
        Self {
            data_dir: data_dir.into(),
            callback_output_tail_bytes,
            max_task_output_bytes,
        }
    }
}

impl Default for TaskOutputPolicy {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from(".botified").join("state"),
            callback_output_tail_bytes: DEFAULT_OUTPUT_TAIL_LIMIT,
            max_task_output_bytes: 16 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Running,
    Completed,
    Failed,
    TimedOut,
    Cancelling,
    Cancelled,
    Lost,
}

impl TaskState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::TimedOut | Self::Cancelled | Self::Lost
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallbackDelivery {
    NotReady,
    Pending,
    Enqueued,
    Delivered,
    Failed,
}

impl CallbackDelivery {
    pub fn requires_retention(self) -> bool {
        matches!(self, Self::Pending | Self::Enqueued | Self::Failed)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskOwner {
    #[default]
    Main,
    Subagent {
        subagent_id: String,
    },
}

impl TaskOwner {
    pub fn subagent(subagent_id: impl Into<String>) -> Self {
        Self::Subagent {
            subagent_id: subagent_id.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct NewBackgroundTask {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments_summary: String,
    pub task_label: Option<String>,
    pub preset_id: Option<String>,
    pub preset_description: Option<String>,
    pub owner: TaskOwner,
    pub detached_at: Option<SystemTime>,
    pub timeout_at: Option<SystemTime>,
    pub artifact_path: Option<PathBuf>,
    pub cancel_token: CancellationToken,
}

impl NewBackgroundTask {
    pub fn new(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        arguments_summary: impl Into<String>,
    ) -> Self {
        Self {
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            arguments_summary: arguments_summary.into(),
            task_label: None,
            preset_id: None,
            preset_description: None,
            owner: TaskOwner::default(),
            detached_at: None,
            timeout_at: None,
            artifact_path: None,
            cancel_token: CancellationToken::new(),
        }
    }

    pub fn with_task_label(mut self, task_label: Option<String>) -> Self {
        self.task_label = task_label;
        self
    }

    pub fn with_owner(mut self, owner: TaskOwner) -> Self {
        self.owner = owner;
        self
    }

    pub fn with_preset(
        mut self,
        preset_id: impl Into<String>,
        preset_description: impl Into<String>,
    ) -> Self {
        self.preset_id = Some(preset_id.into());
        self.preset_description = Some(preset_description.into());
        self
    }

    pub fn with_detached_at(mut self, detached_at: SystemTime) -> Self {
        self.detached_at = Some(detached_at);
        self
    }

    pub fn with_timeout_at(mut self, timeout_at: SystemTime) -> Self {
        self.timeout_at = Some(timeout_at);
        self
    }

    pub fn with_artifact_path(mut self, artifact_path: impl Into<PathBuf>) -> Self {
        self.artifact_path = Some(artifact_path.into());
        self
    }

    pub fn with_cancel_token(mut self, cancel_token: CancellationToken) -> Self {
        self.cancel_token = cancel_token;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskOutputUpdate {
    pub(super) bytes: Vec<u8>,
    pub(super) output_bytes_delta: u64,
    pub(super) output_dropped_bytes_delta: u64,
    pub(super) output_artifact_truncated: bool,
}

impl TaskOutputUpdate {
    pub fn bytes(bytes: impl AsRef<[u8]>) -> Self {
        let bytes = bytes.as_ref().to_vec();
        let output_bytes_delta = bytes.len() as u64;
        Self {
            bytes,
            output_bytes_delta,
            output_dropped_bytes_delta: 0,
            output_artifact_truncated: false,
        }
    }

    pub fn artifact_progress(
        bytes: impl AsRef<[u8]>,
        output_bytes_delta: u64,
        output_dropped_bytes_delta: u64,
        output_artifact_truncated: bool,
    ) -> Self {
        Self {
            bytes: bytes.as_ref().to_vec(),
            output_bytes_delta,
            output_dropped_bytes_delta,
            output_artifact_truncated,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskOutputSnapshot {
    pub tail: String,
    pub output_bytes: u64,
    pub output_live: bool,
    pub output_complete: bool,
    pub output_last_updated_at: Option<SystemTime>,
    pub artifact_path: Option<PathBuf>,
    pub output_tail_truncated: bool,
    pub output_artifact_truncated: bool,
    pub output_dropped_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskCallbackPayloadSnapshot {
    pub task_id: String,
    pub message_id: String,
    pub content: Vec<ContentPart>,
}

#[derive(Debug, Clone)]
pub struct TaskSnapshot {
    pub task_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments_summary: String,
    pub task_label: Option<String>,
    pub preset_id: Option<String>,
    pub preset_description: Option<String>,
    pub owner: TaskOwner,
    pub state: TaskState,
    pub started_at: SystemTime,
    pub detached_at: Option<SystemTime>,
    pub timeout_at: Option<SystemTime>,
    pub completed_at: Option<SystemTime>,
    pub callback_delivery: CallbackDelivery,
    pub callback_payload: Option<TaskCallbackPayloadSnapshot>,
    pub callback_failure_reason: Option<String>,
    pub output: TaskOutputSnapshot,
    pub artifact_path: Option<PathBuf>,
    pub cancel_token: CancellationToken,
    pub requests: Vec<TaskRequestSnapshot>,
}

impl TaskSnapshot {
    pub fn requires_callback_retention(&self) -> bool {
        self.callback_delivery.requires_retention()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRequestState {
    Pending,
    Replied,
    Written,
    WriteFailed,
    Expired,
    Rejected,
    TaskTerminal,
}

impl TaskRequestState {
    pub fn is_pending(self) -> bool {
        matches!(self, Self::Pending)
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Pending | Self::Replied)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskRequestSnapshot {
    pub task_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments_summary: String,
    pub task_label: Option<String>,
    pub work_summary: Option<String>,
    pub owner: TaskOwner,
    pub sender: String,
    pub request_id: String,
    pub request: String,
    pub expect: Option<String>,
    pub urgency: InputUrgency,
    pub state: TaskRequestState,
    pub requested_at: SystemTime,
    pub deadline_at: SystemTime,
    pub requested_timeout: Option<Duration>,
    pub effective_timeout: Duration,
    pub completed_at: Option<SystemTime>,
    pub failure_reason: Option<String>,
}
