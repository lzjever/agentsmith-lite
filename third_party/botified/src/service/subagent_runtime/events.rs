use serde_json::{json, Value};

use crate::subagents::SubagentSnapshot;
use crate::tasks::TaskSnapshot;
use crate::timeline_store::TimelineStoreError;

use super::super::subagent_projection::subagent_event_data;
use super::super::{task_state_name, ServiceInner, ServiceState};

pub(in crate::service) struct SubagentEventAppendOutcome {
    pub(in crate::service) event_written: bool,
    pub(in crate::service) status_written: bool,
    pub(in crate::service) persistence_error: Option<TimelineStoreError>,
}

impl SubagentEventAppendOutcome {
    pub(in crate::service) fn complete(&self) -> bool {
        self.event_written && self.status_written
    }
}

impl ServiceInner {
    pub(in crate::service) fn append_subagent_event_outcome(
        &self,
        event_type: &'static str,
        snapshot: &SubagentSnapshot,
    ) -> SubagentEventAppendOutcome {
        #[cfg(test)]
        {
            assert!(
                self.subagents.try_lock().is_ok(),
                "subagent events must be appended after releasing the subagent manager lock"
            );
        }
        let mut outcome =
            self.try_append_subagent_event_outcome(event_type, subagent_event_data(snapshot));
        if let Some(error) = outcome.persistence_error.take() {
            self.record_timeline_persistence_error(error);
        }
        outcome
    }

    pub(super) fn try_append_subagent_event_outcome(
        &self,
        event_type: &'static str,
        data: Value,
    ) -> SubagentEventAppendOutcome {
        if let Err(error) = self.try_append_event_for_turn(None, event_type, data) {
            return SubagentEventAppendOutcome {
                event_written: false,
                status_written: false,
                persistence_error: Some(error),
            };
        }
        let status_result = {
            let state = self.state.lock().expect("service state mutex poisoned");
            self.try_append_service_status_event_for_locked(&state, None)
        };
        SubagentEventAppendOutcome {
            event_written: true,
            status_written: status_result.is_ok(),
            persistence_error: status_result.err(),
        }
    }

    pub(super) fn append_subagent_event(
        &self,
        event_type: &'static str,
        snapshot: &SubagentSnapshot,
    ) -> bool {
        self.append_subagent_event_outcome(event_type, snapshot)
            .complete()
    }

    pub(in crate::service) fn append_subagent_task_failed_event(
        &self,
        snapshot: &SubagentSnapshot,
        task: &TaskSnapshot,
        reason: &str,
    ) -> bool {
        let mut data = subagent_event_data(snapshot);
        data["task_id"] = json!(task.task_id);
        data["task_status"] = json!(task_state_name(task.state));
        data["task_failure_reason"] = json!(reason);
        let event_written = self
            .append_event_for_turn_or_record_error(None, "subagent.task_failed", data)
            .is_some();
        let status_written = self.append_service_status_for_current_state(None).is_some();
        event_written && status_written
    }

    pub(in crate::service) fn append_subagent_event_for_id(
        &self,
        event_type: &'static str,
        subagent_id: &str,
    ) -> bool {
        let Some(snapshot) = self.subagent_snapshot(subagent_id) else {
            return false;
        };
        self.append_subagent_event(event_type, &snapshot)
    }

    pub(in crate::service) fn try_append_subagent_event_for_id(
        &self,
        event_type: &'static str,
        subagent_id: &str,
    ) -> SubagentEventAppendOutcome {
        let Some(snapshot) = self.subagent_snapshot(subagent_id) else {
            return SubagentEventAppendOutcome {
                event_written: false,
                status_written: false,
                persistence_error: None,
            };
        };
        self.try_append_subagent_event_outcome(event_type, subagent_event_data(&snapshot))
    }

    pub(super) fn append_subagent_event_if_current_open(
        &self,
        event_type: &'static str,
        snapshot: &SubagentSnapshot,
    ) -> Option<SubagentSnapshot> {
        self.append_subagent_event_outcome_if_current_open(event_type, snapshot)
            .and_then(|(snapshot, outcome)| outcome.complete().then_some(snapshot))
    }

    fn append_subagent_event_outcome_if_current_open(
        &self,
        event_type: &'static str,
        snapshot: &SubagentSnapshot,
    ) -> Option<(SubagentSnapshot, SubagentEventAppendOutcome)> {
        let (current, mut outcome) = {
            let _lifecycle = self
                .subagent_lifecycle
                .lock()
                .expect("subagent lifecycle mutex poisoned");
            let state = self.state.lock().expect("service state mutex poisoned");
            if matches!(
                state.state,
                ServiceState::Failed | ServiceState::ShuttingDown
            ) {
                return None;
            }
            let current = self.open_subagent_snapshot(&snapshot.id)?;
            let mut outcome = match self.try_append_event_for_turn(
                None,
                event_type,
                subagent_event_data(&current),
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
            (current, outcome)
        };
        if let Some(error) = outcome.persistence_error.take() {
            self.record_timeline_persistence_error(error);
        }
        Some((current, outcome))
    }
}
