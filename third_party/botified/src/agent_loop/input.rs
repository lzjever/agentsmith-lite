use std::collections::BTreeMap;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::session::CompactionMetadata;
use crate::types::{ContentPart, Message};

use super::{
    emit, emit_aborted, emit_error, fail_if_event_log_failed, ActiveCycle, AgentConfig,
    AgentEventLog, AgentRunError, AgentRunErrorKind,
};

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct AgentCommitError {
    message: String,
}

impl AgentCommitError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait AgentContextRecorder: Send + Sync {
    async fn record_message(&self, message: &Message) -> Result<(), AgentCommitError>;

    async fn record_accepted_input(
        &self,
        entry: &AcceptedInputEntry,
    ) -> Result<(), AgentCommitError>;

    async fn record_pending_input_removed(
        &self,
        _message_id: &str,
        _source: InputSource,
        _metadata: Option<&QueuedInputMetadata>,
        _reason: &str,
    ) -> Result<(), AgentCommitError> {
        Ok(())
    }

    async fn record_compaction(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
    ) -> Result<(), AgentCommitError> {
        self.record_compaction_with_metadata(summary, retained_messages, None)
            .await
    }

    async fn record_compaction_with_metadata(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        _metadata: Option<&CompactionMetadata>,
    ) -> Result<(), AgentCommitError> {
        self.record_message(&Message::user(summary.to_vec()))
            .await?;
        for message in retained_messages {
            self.record_message(message).await?;
        }
        Ok(())
    }

    async fn record_compaction_with_active_user_message_id(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        _active_user_message_id: Option<&str>,
    ) -> Result<(), AgentCommitError> {
        self.record_compaction_with_active_user_message_id_and_metadata(
            summary,
            retained_messages,
            _active_user_message_id,
            None,
        )
        .await
    }

    async fn record_compaction_with_active_user_message_id_and_metadata(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        _active_user_message_id: Option<&str>,
        metadata: Option<&CompactionMetadata>,
    ) -> Result<(), AgentCommitError> {
        self.record_compaction_with_metadata(summary, retained_messages, metadata)
            .await
    }

    async fn record_user_batch(&self, messages: &[Message]) -> Result<(), AgentCommitError> {
        for message in messages {
            if !matches!(message, Message::User { .. }) {
                return Err(AgentCommitError::new(
                    "user batch contains a non-user message",
                ));
            }
            self.record_message(message).await?;
        }
        Ok(())
    }

    async fn record_user_batch_with_ids(
        &self,
        messages: &[Message],
        message_ids: &[String],
    ) -> Result<(), AgentCommitError>;
}

#[async_trait]
pub trait AgentInputDrainer: Send + Sync {
    async fn begin_drain(&self, cancel: CancellationToken) -> DrainBatch;

    /// Prepare a pending drain for timeline persistence. Implementations must
    /// not make the drained user input durable here; `complete_commit` is the
    /// finalization point after `queue.drained` and `cycle.started` persist.
    async fn commit(&self, batch_id: &str) -> Result<DrainCommit, AgentCommitError>;

    async fn complete_commit(
        &self,
        _batch_id: &str,
        _commit: &DrainCommit,
        _cycle_id: Option<&str>,
    ) -> Result<(), AgentCommitError> {
        Ok(())
    }

    async fn rollback(&self, batch_id: &str);
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrainBatch {
    pub id: String,
    pub messages: Vec<DrainedMessage>,
}

impl DrainBatch {
    pub fn new(id: impl Into<String>, messages: Vec<DrainedMessage>) -> Self {
        Self {
            id: id.into(),
            messages,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DrainCommit {
    pub queue_length: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub callback_delivery_input_ids: Vec<String>,
}

impl DrainCommit {
    pub fn new(queue_length: usize) -> Self {
        Self {
            queue_length,
            callback_delivery_input_ids: Vec::new(),
        }
    }

    pub fn with_callback_delivery_input_ids(mut self, input_ids: Vec<String>) -> Self {
        self.callback_delivery_input_ids = input_ids;
        self
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputSource {
    #[default]
    User,
    TaskCallback,
    SubagentCallback,
    #[serde(rename = "task_ask")]
    TaskRequest,
    #[serde(rename = "task_tell")]
    TaskTell,
}

impl InputSource {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::TaskCallback => "task_callback",
            Self::SubagentCallback => "subagent_callback",
            Self::TaskRequest => "task_ask",
            Self::TaskTell => "task_tell",
        }
    }

    pub fn is_user(source: &Self) -> bool {
        *source == Self::User
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputUrgency {
    #[default]
    Normal,
    Urgent,
}

impl InputUrgency {
    pub fn is_normal(urgency: &Self) -> bool {
        *urgency == Self::Normal
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Urgent => "urgent",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "normal" => Some(Self::Normal),
            "urgent" => Some(Self::Urgent),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueuedInputMetadata {
    TaskCallback {
        task_id: String,
        tool_call_id: String,
        tool_name: String,
        execution_state: TaskCallbackExecutionState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        output_tail: String,
        output_tail_truncated: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "task_ask")]
    TaskRequest {
        task_id: String,
        #[serde(rename = "ask_id")]
        request_id: String,
    },
    #[serde(rename = "task_tell")]
    TaskTell { task_id: String, tell_id: String },
    SubagentCallback {
        subagent_id: String,
        kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ask_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tell_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskCallbackExecutionState {
    Completed,
    Failed,
    TimedOut,
    Cancelled,
    Lost,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AcceptedInputEntry {
    pub message_id: String,
    pub content: Vec<ContentPart>,
    pub cursor_seq: u64,
    pub source: InputSource,
    pub metadata: Option<QueuedInputMetadata>,
    pub urgency: InputUrgency,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrainedMessage {
    pub id: String,
    pub content: Vec<ContentPart>,
    #[serde(default, skip_serializing_if = "InputSource::is_user")]
    pub source: InputSource,
    #[serde(default, skip_serializing_if = "InputUrgency::is_normal")]
    pub urgency: InputUrgency,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<QueuedInputMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<MessageDelivery>,
}

impl DrainedMessage {
    pub fn new(id: impl Into<String>, content: Vec<ContentPart>) -> Self {
        Self {
            id: id.into(),
            content,
            source: InputSource::User,
            urgency: InputUrgency::Normal,
            metadata: None,
            cursor_seq: None,
            delivery: None,
        }
    }

    pub fn with_source(mut self, source: InputSource) -> Self {
        self.source = source;
        self
    }

    pub fn with_urgency(mut self, urgency: InputUrgency) -> Self {
        self.urgency = urgency;
        self
    }

    pub fn with_metadata(mut self, metadata: QueuedInputMetadata) -> Self {
        self.metadata = Some(metadata);
        self
    }

    pub fn with_cursor_seq(mut self, cursor_seq: u64) -> Self {
        self.cursor_seq = Some(cursor_seq);
        self
    }

    fn into_user_message(self) -> Message {
        Message::user(self.content)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageDelivery {
    pub delivery_key: String,
    pub request_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveRequestInput {
    pub id: String,
    pub content: Vec<ContentPart>,
    pub source: InputSource,
    pub urgency: InputUrgency,
    pub metadata: Option<QueuedInputMetadata>,
}

impl ActiveRequestInput {
    fn from_drained_message(message: &DrainedMessage) -> Self {
        Self {
            id: message.id.clone(),
            content: message.content.clone(),
            source: message.source,
            urgency: message.urgency,
            metadata: message.metadata.clone(),
        }
    }
}

pub(super) async fn drain_inputs(
    input_drainer: Option<&dyn AgentInputDrainer>,
    cancel: CancellationToken,
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    messages: &mut Vec<Message>,
    provider_calls: usize,
) -> Result<Option<DrainedInput>, AgentRunError> {
    let Some(drainer) = input_drainer else {
        return Ok(None);
    };

    let batch = drainer.begin_drain(cancel.clone()).await;
    if cancel.is_cancelled() {
        drainer.rollback(&batch.id).await;
        let error = AgentRunError::new(AgentRunErrorKind::Cancelled, messages, provider_calls);
        emit_aborted(event_log, config, &error);
        return Err(error);
    }

    if batch.messages.is_empty() {
        return Ok(None);
    }

    let request_start = messages.len();
    let batch_id = batch.id.clone();
    let drained_messages = batch.messages;
    let DrainedInputFacts {
        timeline,
        active_inputs,
        active_user_message_id,
        input_count,
        active_input_source,
        active_input_urgency,
        active_input_metadata,
    } = drained_input_facts(&drained_messages);
    let user_messages = drained_messages
        .into_iter()
        .map(DrainedMessage::into_user_message)
        .collect::<Vec<_>>();

    let cycle = commit_drained_input_batch(
        drainer,
        &batch_id,
        timeline,
        event_log,
        config,
        messages,
        provider_calls,
    )
    .await?;

    messages.extend(user_messages);
    Ok(Some(DrainedInput {
        request_start,
        active_user_message_id,
        input_count,
        active_input_source,
        active_input_urgency,
        active_input_metadata,
        active_inputs,
        cycle,
    }))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DrainedInputFacts {
    timeline: DrainedInputTimelineFacts,
    active_inputs: Vec<ActiveRequestInput>,
    active_user_message_id: Option<String>,
    input_count: usize,
    active_input_source: Option<InputSource>,
    active_input_urgency: Option<InputUrgency>,
    active_input_metadata: Option<QueuedInputMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DrainedInputTimelineFacts {
    message_ids: Vec<String>,
    input_sources: BTreeMap<String, String>,
    input_urgencies: BTreeMap<String, String>,
    input_previews: BTreeMap<String, String>,
}

fn drained_input_facts(drained_messages: &[DrainedMessage]) -> DrainedInputFacts {
    let input_count = drained_messages.len();
    let active_input_source = drained_messages.first().map(|drained| drained.source);
    let active_input_urgency = drained_messages.first().map(|drained| drained.urgency);
    let active_input_metadata = drained_messages
        .first()
        .and_then(|drained| drained.metadata.clone());
    let active_inputs = drained_messages
        .iter()
        .map(ActiveRequestInput::from_drained_message)
        .collect::<Vec<_>>();
    let message_ids = drained_messages
        .iter()
        .map(|drained| drained.id.clone())
        .collect::<Vec<_>>();
    let active_user_message_id = message_ids.first().cloned();
    let input_sources = drained_messages
        .iter()
        .map(|drained| (drained.id.clone(), drained.source.as_str().to_owned()))
        .collect::<BTreeMap<_, _>>();
    let input_urgencies = drained_messages
        .iter()
        .map(|drained| (drained.id.clone(), drained.urgency.as_str().to_owned()))
        .collect::<BTreeMap<_, _>>();
    let input_previews = drained_messages
        .iter()
        .map(|drained| {
            (
                drained.id.clone(),
                drained_content_preview(&drained.content),
            )
        })
        .collect::<BTreeMap<_, _>>();

    DrainedInputFacts {
        timeline: DrainedInputTimelineFacts {
            message_ids,
            input_sources,
            input_urgencies,
            input_previews,
        },
        active_inputs,
        active_user_message_id,
        input_count,
        active_input_source,
        active_input_urgency,
        active_input_metadata,
    }
}

async fn commit_drained_input_batch(
    drainer: &dyn AgentInputDrainer,
    batch_id: &str,
    timeline: DrainedInputTimelineFacts,
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    messages: &[Message],
    provider_calls: usize,
) -> Result<Option<ActiveCycle>, AgentRunError> {
    let DrainedInputTimelineFacts {
        message_ids,
        input_sources,
        input_urgencies,
        input_previews,
    } = timeline;
    let commit = drainer.commit(batch_id).await.map_err(|error| {
        let error = AgentRunError::new(
            AgentRunErrorKind::Persistence {
                message: error.to_string(),
            },
            messages,
            provider_calls,
        );
        emit_error(event_log, config, &error);
        error
    })?;
    let queue_length = commit.queue_length;
    let queue_event = emit(
        event_log,
        config,
        "queue.drained",
        json!({
            "message_count": message_ids.len(),
            "message_ids": message_ids.clone(),
            "input_ids": message_ids.clone(),
            "input_sources": input_sources.clone(),
            "input_urgencies": input_urgencies.clone(),
            "input_previews": input_previews.clone(),
            "queue_length": queue_length
        }),
    );
    if let Err(error) = fail_if_event_log_failed(event_log, messages, provider_calls) {
        drainer.rollback(batch_id).await;
        return Err(error);
    }
    let cycle_id = queue_event
        .as_ref()
        .map(|event| format!("cyc_{}", event.seq));
    let cycle = if let Some(cycle_id) = cycle_id.as_deref() {
        emit(
            event_log,
            config,
            "cycle.started",
            json!({
                "cycle_id": cycle_id,
                "input_ids": message_ids.clone(),
                "input_sources": input_sources.clone(),
                "input_urgencies": input_urgencies.clone(),
                "input_previews": input_previews.clone(),
                "queue_length": queue_length
            }),
        );
        if let Err(error) = fail_if_event_log_failed(event_log, messages, provider_calls) {
            drainer.rollback(batch_id).await;
            return Err(error);
        }
        Some(ActiveCycle::new(
            cycle_id.to_owned(),
            message_ids,
            input_sources,
            input_urgencies,
            input_previews,
            queue_length,
        ))
    } else {
        None
    };
    drainer
        .complete_commit(batch_id, &commit, cycle_id.as_deref())
        .await
        .map_err(|error| {
            let error = AgentRunError::new(
                AgentRunErrorKind::Persistence {
                    message: error.to_string(),
                },
                messages,
                provider_calls,
            );
            emit_error(event_log, config, &error);
            error
        })?;
    Ok(cycle)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DrainedInput {
    pub(super) request_start: usize,
    pub(super) active_user_message_id: Option<String>,
    pub(super) input_count: usize,
    pub(super) active_input_source: Option<InputSource>,
    pub(super) active_input_urgency: Option<InputUrgency>,
    pub(super) active_input_metadata: Option<QueuedInputMetadata>,
    pub(super) active_inputs: Vec<ActiveRequestInput>,
    pub(super) cycle: Option<ActiveCycle>,
}

pub(super) fn initial_active_request_inputs(
    messages: &[Message],
    current_request_start: usize,
    active_input_ids: &[String],
    known_user_messages: &[DrainedMessage],
) -> Vec<ActiveRequestInput> {
    active_input_ids
        .iter()
        .enumerate()
        .filter_map(|(offset, active_input_id)| {
            if let Some(message) = known_user_messages
                .iter()
                .rev()
                .find(|message| message.id == active_input_id.as_str())
            {
                return Some(ActiveRequestInput::from_drained_message(message));
            }
            let Some(Message::User { content }) =
                messages.get(current_request_start.saturating_add(offset))
            else {
                return None;
            };
            Some(ActiveRequestInput {
                id: active_input_id.clone(),
                content: content.clone(),
                source: InputSource::User,
                urgency: InputUrgency::Normal,
                metadata: None,
            })
        })
        .collect()
}

fn drained_content_preview(content: &[ContentPart]) -> String {
    const MAX_PREVIEW_CHARS: usize = 256;

    let mut preview = String::new();
    for part in content {
        if !preview.is_empty() {
            preview.push('\n');
        }
        match part {
            ContentPart::Text { text } => preview.push_str(text),
            ContentPart::ImageUrl { .. } => preview.push_str("[image_url]"),
            ContentPart::ImageBase64 { mime_type, .. } => {
                preview.push_str("[image_base64:");
                preview.push_str(mime_type);
                preview.push(']');
            }
            ContentPart::File { binding } => {
                preview.push_str("[file ");
                preview.push_str(&binding.filename);
                preview.push(' ');
                preview.push_str(&binding.mime_type);
                preview.push(' ');
                preview.push_str(&binding.size_bytes.to_string());
                preview.push_str(" bytes]");
            }
            ContentPart::Skill {
                name,
                path,
                arguments,
            } => {
                preview.push_str("[skill");
                if let Some(name) = name {
                    preview.push(' ');
                    preview.push_str(name);
                } else if let Some(path) = path {
                    preview.push(' ');
                    preview.push_str(path);
                }
                if arguments.is_some() {
                    preview.push_str(" args]");
                } else {
                    preview.push(']');
                }
            }
        }
    }

    if preview.chars().count() > MAX_PREVIEW_CHARS {
        preview.chars().take(MAX_PREVIEW_CHARS).collect()
    } else {
        preview
    }
}

#[cfg(test)]
mod tests {
    use super::InputSource;

    #[test]
    fn input_source_as_str_matches_serde_wire_names() {
        for (source, expected) in [
            (InputSource::User, "user"),
            (InputSource::TaskCallback, "task_callback"),
            (InputSource::SubagentCallback, "subagent_callback"),
            (InputSource::TaskRequest, "task_ask"),
            (InputSource::TaskTell, "task_tell"),
        ] {
            assert_eq!(source.as_str(), expected);
            assert_eq!(
                serde_json::to_value(source).expect("input source should serialize"),
                serde_json::json!(expected)
            );
        }
    }
}
