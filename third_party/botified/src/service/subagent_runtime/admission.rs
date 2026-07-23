use std::sync::Arc;

use crate::subagents::SubagentSnapshot;

use super::super::subagent_projection::subagent_event_data;
use super::super::{ServiceInner, ServiceState, ServiceWorkerGuard, ServiceWorkerKind};
use super::SubagentEventAppendOutcome;
#[cfg(test)]
use super::SubagentTestHookKind;

pub(super) type SubagentStartReservation = (SubagentEventAppendOutcome, ServiceWorkerGuard);
pub(super) type SubagentStartAdmission<T> = Option<(T, Option<SubagentStartReservation>)>;

impl ServiceInner {
    pub(super) fn admit_subagent_start<T, E>(
        self: &Arc<Self>,
        prepare: impl FnOnce() -> Result<(T, Option<SubagentSnapshot>), E>,
    ) -> Result<SubagentStartAdmission<T>, E> {
        #[cfg(test)]
        self.run_subagent_test_hook(SubagentTestHookKind::StartAdmission);
        let lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let mut state = self.state.lock().expect("service state mutex poisoned");
        if matches!(
            state.state,
            ServiceState::Failed | ServiceState::ShuttingDown
        ) {
            return Ok(None);
        }
        let (value, started_snapshot) = prepare()?;
        let mut started = started_snapshot.map(|snapshot| {
            state
                .service_workers
                .register(ServiceWorkerKind::SubagentRun);
            let worker_guard = ServiceWorkerGuard {
                inner: Arc::downgrade(self),
                kind: ServiceWorkerKind::SubagentRun,
            };
            let mut outcome = match self.try_append_event_for_turn(
                None,
                "subagent.started",
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
            (outcome, worker_guard)
        });
        let persistence_error = started
            .as_mut()
            .and_then(|(outcome, _)| outcome.persistence_error.take());
        drop(state);
        drop(lifecycle);
        if let Some(error) = persistence_error {
            self.record_timeline_persistence_error(error);
        }
        Ok(Some((value, started)))
    }
}
