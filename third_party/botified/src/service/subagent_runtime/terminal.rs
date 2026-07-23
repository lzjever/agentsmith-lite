use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::subagents::{SubagentManagerError, SubagentSnapshot};
use crate::Message;

use super::super::subagent_projection::subagent_event_data;
use super::super::{ServiceInner, ServiceState};
use super::launch::PreparedSubagentRun;
use super::SubagentEventAppendOutcome;

pub(super) enum SubagentRunTerminal {
    Completed(String),
    Failed(String),
}

pub(super) fn subagent_result_text(messages: &[Message]) -> String {
    messages
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::Assistant { content, .. } => content.clone(),
            Message::User { .. } | Message::ToolResult(_) => None,
        })
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "subagent completed".to_owned())
}

impl ServiceInner {
    pub(super) fn fail_prepared_subagent_run_after_start_persistence_failure(
        self: &Arc<Self>,
        prepared: PreparedSubagentRun,
        started_event_written: bool,
    ) {
        let subagent_id = prepared.subagent_id.clone();
        prepared.cancel.cancel();
        self.subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .remove(&subagent_id);
        let Ok(snapshot) = self.finish_subagent_run_with_context(
            &subagent_id,
            SubagentRunTerminal::Failed("subagent start persistence failed".to_owned()),
            prepared.messages,
        ) else {
            return;
        };
        if started_event_written {
            self.append_subagent_event("subagent.failed", &snapshot);
        }
    }

    pub(super) fn finish_subagent_run_with_context(
        &self,
        subagent_id: &str,
        terminal: SubagentRunTerminal,
        messages: Vec<Message>,
    ) -> Result<SubagentSnapshot, SubagentManagerError> {
        let _lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let mut manager = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let snapshot = match terminal {
            SubagentRunTerminal::Completed(result_text) => {
                manager.complete(subagent_id, result_text)?
            }
            SubagentRunTerminal::Failed(error_message) => {
                manager.fail(subagent_id, error_message)?
            }
        };
        self.subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(subagent_id.to_owned(), messages);
        Ok(snapshot)
    }

    pub(super) fn fail_subagent_run_and_append_if_current(
        &self,
        subagent_id: &str,
        error_message: &str,
        messages: Vec<Message>,
        expected_cancel: Option<&Arc<CancellationToken>>,
    ) -> Option<SubagentSnapshot> {
        let lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let state = self.state.lock().expect("service state mutex poisoned");
        if let Some(expected_cancel) = expected_cancel {
            let mut cancels = self
                .subagent_cancels
                .lock()
                .expect("subagent cancels mutex poisoned");
            let is_current = cancels
                .get(subagent_id)
                .is_some_and(|current| Arc::ptr_eq(current, expected_cancel));
            if !is_current {
                return None;
            }
            expected_cancel.cancel();
            cancels.remove(subagent_id);
        }
        let snapshot = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .fail(subagent_id, error_message.to_owned())
            .ok()?;
        self.subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(subagent_id.to_owned(), messages);
        if matches!(
            state.state,
            ServiceState::Failed | ServiceState::ShuttingDown
        ) {
            return None;
        }
        let mut outcome = match self.try_append_event_for_turn(
            None,
            "subagent.failed",
            subagent_event_data(&snapshot),
        ) {
            Ok(_) => SubagentEventAppendOutcome {
                event_written: true,
                status_written: false,
                persistence_error: None,
            },
            Err(error) => SubagentEventAppendOutcome {
                event_written: false,
                status_written: false,
                persistence_error: Some(error),
            },
        };
        if outcome.event_written {
            match self.try_append_service_status_event_for_locked(&state, None) {
                Ok(_) => outcome.status_written = true,
                Err(error) => outcome.persistence_error = Some(error),
            }
        }
        let persistence_error = outcome.persistence_error.take();
        drop(state);
        drop(lifecycle);
        if let Some(error) = persistence_error {
            self.record_timeline_persistence_error(error);
        }
        outcome.complete().then_some(snapshot)
    }
}
