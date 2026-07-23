use std::sync::Arc;

use async_trait::async_trait;

use crate::agent_loop::{AcceptedInputEntry, AgentCommitError, AgentContextRecorder};
use crate::session::CompactionMetadata;
use crate::subagents::SubagentLifecycle;
use crate::{ContentPart, Message};

use super::super::ServiceInner;

pub(super) struct SubagentContextRecorder {
    pub(super) inner: Arc<ServiceInner>,
    pub(super) subagent_id: String,
}

impl SubagentContextRecorder {
    fn update(&self, update: impl FnOnce(&mut Vec<Message>)) {
        self.inner
            .update_subagent_context_if_open(&self.subagent_id, update);
    }
}

#[async_trait]
impl AgentContextRecorder for SubagentContextRecorder {
    async fn record_message(&self, message: &Message) -> Result<(), AgentCommitError> {
        self.update(|messages| messages.push(message.clone()));
        Ok(())
    }

    async fn record_accepted_input(
        &self,
        _entry: &AcceptedInputEntry,
    ) -> Result<(), AgentCommitError> {
        Ok(())
    }

    async fn record_compaction_with_active_user_message_id_and_metadata(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        _active_user_message_id: Option<&str>,
        _metadata: Option<&CompactionMetadata>,
    ) -> Result<(), AgentCommitError> {
        self.update(|messages| {
            *messages = std::iter::once(Message::user(summary.to_vec()))
                .chain(retained_messages.iter().cloned())
                .collect();
        });
        Ok(())
    }

    async fn record_user_batch_with_ids(
        &self,
        messages: &[Message],
        _message_ids: &[String],
    ) -> Result<(), AgentCommitError> {
        self.update(|context| context.extend_from_slice(messages));
        Ok(())
    }
}

impl ServiceInner {
    pub(in crate::service) fn update_subagent_context_if_open(
        &self,
        subagent_id: &str,
        update: impl FnOnce(&mut Vec<Message>),
    ) {
        let _lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let is_open = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(subagent_id)
            .is_some_and(|snapshot| snapshot.lifecycle == SubagentLifecycle::Open);
        if !is_open {
            return;
        }
        let mut contexts = self
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned");
        if let Some(messages) = contexts.get_mut(subagent_id) {
            update(messages);
        }
    }
}
