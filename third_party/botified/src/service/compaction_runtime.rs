mod active_request_recovery;
mod budget;
mod commit;
mod degraded_recovery;
mod pending_recovery;
mod rejected_input;
mod rejected_input_removal;
mod slot;
mod start;
mod worker;

use super::*;

#[cfg(test)]
pub(super) use active_request_recovery::{
    ACTIVE_REQUEST_RECOVERY_APPEND_FAILED, ACTIVE_REQUEST_TOO_LARGE_FOR_MODEL_WINDOW,
};
pub(super) use pending_recovery::{PendingRecoveryRecord, PendingRecoveryRecordKind};
use rejected_input::input_too_large_for_model_window_message;
#[cfg(test)]
pub(super) use rejected_input::REJECTED_INPUT_APPEND_FAILED;
pub(super) use worker::spawn_compaction_provider_call;

pub(super) struct ServiceCompactionHook {
    pub(super) inner: Weak<ServiceInner>,
}

#[async_trait]
impl AgentCompactionHook for ServiceCompactionHook {
    async fn on_agent_safe_point(
        &self,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
    ) -> AgentCompactionUpdate {
        let Some(inner) = self.inner.upgrade() else {
            return AgentCompactionUpdate::unchanged(safe_point);
        };
        let mut update = inner
            .try_commit_completed_compaction(messages, safe_point)
            .await;
        update.current_request_start = update.current_request_start.min(messages.len());
        update
    }

    async fn on_provider_request_ready(
        &self,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
        budget: AgentProviderRequestBudget,
    ) -> AgentCompactionUpdate {
        let Some(inner) = self.inner.upgrade() else {
            return AgentCompactionUpdate::unchanged(safe_point);
        };
        inner
            .handle_provider_request_budget(messages, safe_point, budget)
            .await
    }
}

fn usize_to_u64_saturating(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

impl ServiceInner {
    pub(super) async fn ensure_pending_recovery_safe_before_user_batch(
        &self,
    ) -> Result<(), AgentCommitError> {
        self.retry_pending_recovery_record(None).await;
        let pending_record = {
            self.state
                .lock()
                .expect("service state mutex poisoned")
                .pending_recovery_record
                .clone()
        };
        let Some(record) = pending_record else {
            return Ok(());
        };
        match &record.kind {
            PendingRecoveryRecordKind::DegradedLocalRecovery => {
                return Err(AgentCommitError::new(
                    "pending local recovery compaction append failed",
                ));
            }
            PendingRecoveryRecordKind::RejectedInputRemoval {
                tombstone_persisted: false,
                ..
            } => {
                if let Err(error) = self
                    .record_rejected_input_removal_tombstone_result(&record)
                    .await
                {
                    self.append_rejected_input_removal_tombstone_failed(&record, &error);
                    return Err(error);
                }
                self.mark_rejected_input_removal_tombstone_persisted(&record);
            }
            PendingRecoveryRecordKind::RejectedInputRemoval {
                tombstone_persisted: true,
                ..
            } => {}
        }
        Ok(())
    }

    fn replace_main_context_snapshot(&self, messages: &[Message]) {
        self.state
            .lock()
            .expect("service state mutex poisoned")
            .context = messages.to_vec();
    }

    fn set_context_maintenance_status(&self, status: ContextMaintenanceStatus) {
        let (turn_id, data, generation) = {
            let mut state = self.state.lock().expect("service state mutex poisoned");
            if state.context_maintenance == status {
                return;
            }
            state.context_maintenance = status;
            let (data, generation) = self.service_status_data_from_locked(&state);
            (state.active_turn_id.clone(), data, generation)
        };
        let result = self.try_append_event_for_turn(turn_id.as_deref(), "service.status", data);
        match result {
            Ok(_) => self.mark_service_status_published(generation),
            Err(_) => self.mark_service_status_dirty(generation),
        }
        self.notify.notify_waiters();
    }

    fn append_compact_debug_event(&self, event_type: &'static str, data: Value) {
        let _ = self.try_append_event_for_turn(None, event_type, data);
    }
}
