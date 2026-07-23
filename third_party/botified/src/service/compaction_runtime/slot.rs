use super::super::compaction_shared::{CompactSlot, HardCompactFailureKey};
use super::super::{ServiceInner, ServiceState};

impl ServiceInner {
    pub(super) fn finish_compaction_run(
        &self,
        run_id: u64,
        summary_result: Result<String, String>,
    ) {
        let mut slot = self
            .compact
            .slot
            .lock()
            .expect("compact slot mutex poisoned");
        let previous = std::mem::replace(
            &mut *slot,
            CompactSlot::Idle {
                suppressed_start_len: None,
                last_successful_hard_key: None,
            },
        );
        match previous {
            CompactSlot::Running {
                run_id: running_id,
                messages_at_start,
                retained_start,
                start_len,
                hard_failure_key,
                hard_failure_count_at_start,
                ..
            } if running_id == run_id => {
                *slot = CompactSlot::Completed {
                    run_id,
                    messages_at_start,
                    retained_start,
                    start_len,
                    summary_result,
                    hard_failure_key,
                    hard_failure_count_at_start,
                };
            }
            other => {
                *slot = other;
            }
        }
        self.notify.notify_waiters();
    }

    pub(super) fn install_compaction_idle(
        &self,
        suppressed_start_len: Option<usize>,
        last_successful_hard_key: Option<HardCompactFailureKey>,
    ) {
        *self
            .compact
            .slot
            .lock()
            .expect("compact slot mutex poisoned") = CompactSlot::Idle {
            suppressed_start_len,
            last_successful_hard_key,
        };
    }

    pub(super) fn install_compaction_failure(
        &self,
        reason: &'static str,
        diagnostic: String,
        suppressed_start_len: Option<usize>,
        hard_failure_key: Option<HardCompactFailureKey>,
        hard_failure_count: usize,
    ) {
        *self
            .compact
            .slot
            .lock()
            .expect("compact slot mutex poisoned") = CompactSlot::Failed {
            reason,
            diagnostic,
            suppressed_start_len,
            hard_failure_key,
            hard_failure_count,
        };
    }

    pub(in crate::service) fn cancel_compaction_run(&self) {
        let slot = self
            .compact
            .slot
            .lock()
            .expect("compact slot mutex poisoned");
        if let CompactSlot::Running { cancel, .. } = &*slot {
            cancel.cancel();
        }
    }

    pub(super) async fn wait_for_compaction_gate_progress(&self) {
        loop {
            let notified = self.notify.notified();
            if !self.should_keep_waiting_for_compaction_gate() {
                return;
            }
            notified.await;
        }
    }

    fn should_keep_waiting_for_compaction_gate(&self) -> bool {
        let service_state = self
            .state
            .lock()
            .expect("service state mutex poisoned")
            .state;
        if matches!(
            service_state,
            ServiceState::Aborting | ServiceState::Failed | ServiceState::ShuttingDown
        ) {
            return false;
        }
        matches!(
            *self
                .compact
                .slot
                .lock()
                .expect("compact slot mutex poisoned"),
            CompactSlot::Running { .. }
        )
    }
}
