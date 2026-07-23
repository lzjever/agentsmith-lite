use serde_json::json;

use crate::tasks::{TaskOwner, TaskState};

use super::super::{
    Service, ServiceState, ServiceStatus, SERVICE_SHUTDOWN_TASK_DRAIN_POLL,
    SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT,
};

impl Service {
    pub async fn shutdown(&self) -> ServiceStatus {
        let (turn_id, should_emit_abort, publish_status) = {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            let turn_id = state.active_turn_id.clone();
            if state.state == ServiceState::ShuttingDown {
                (turn_id, false, false)
            } else {
                let should_emit_abort = state.active_cancel.is_some();
                if let Some(cancel) = state.active_cancel.as_ref() {
                    cancel.cancel();
                }
                state.state = ServiceState::ShuttingDown;
                state.last_error = None;
                (turn_id, should_emit_abort, true)
            }
        };
        if publish_status {
            if let Err(failure) = self
                .inner
                .try_append_service_status_for_current_state(turn_id.as_deref())
            {
                failure.transition(self.inner.as_ref());
            }
        }
        self.inner.notify.notify_waiters();
        self.inner.registry_maintenance_cancel.cancel();
        let registry_maintenance = self
            .inner
            .registry_maintenance_join
            .lock()
            .expect("registry maintenance join mutex poisoned")
            .take();
        if let Some(maintenance) = registry_maintenance {
            maintenance.join().await;
        }

        let (frame_lanes, cancelled_tasks) = {
            let mut admission = self
                .inner
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned");
            let frame_lanes = self.inner.discard_all_task_frame_lanes(&mut admission);
            self.inner.task_observer.close_all_admission();
            let cancelled_tasks = self.inner.background_tasks.cancel_all();
            self.inner
                .subagent_tool_snapshots
                .lock()
                .expect("subagent tool snapshots mutex poisoned")
                .clear();
            admission.finishing_tasks.clear();
            admission.discarding_tasks.clear();
            (frame_lanes, cancelled_tasks)
        };

        if should_emit_abort {
            self.inner.append_event_for_turn_or_record_error(
                turn_id.as_deref(),
                "agent.abort_requested",
                json!({"reason": "service_shutdown"}),
            );
        }

        self.inner.task_observer_preview_cancel.cancel();
        for lane in frame_lanes {
            lane.wait_done().await;
        }
        let preview_join = self
            .inner
            .task_observer_preview_join
            .lock()
            .expect("task observer preview join mutex poisoned")
            .take();
        if let Some(join) = preview_join {
            let _ = join.await;
        }
        self.inner.task_observer.clear_stream_buffers();
        for task_id in self.inner.task_observer.active_task_ids() {
            self.inner
                .retire_task_observer_for_exit(&task_id, "service_cleanup")
                .await;
            self.inner.task_observer.release_closed_admission(&task_id);
        }

        for snapshot in cancelled_tasks {
            if snapshot.state == TaskState::Cancelling && snapshot.owner == TaskOwner::Main {
                self.inner.append_task_updated_event(&snapshot);
            }
        }
        for cancel in self
            .inner
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .values()
        {
            cancel.cancel();
        }
        self.inner.cancel_compaction_run();
        self.inner.append_service_status_for_current_state(None);
        self.inner.notify.notify_waiters();
        self.wait_for_shutdown_quiescence().await;
        self.status()
    }

    async fn wait_for_shutdown_quiescence(&self) {
        let _ = tokio::time::timeout(SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT, async {
            loop {
                if self.inner.shutdown_quiescent() {
                    return;
                }
                tokio::select! {
                    _ = self.inner.notify.notified() => {}
                    _ = tokio::time::sleep(SERVICE_SHUTDOWN_TASK_DRAIN_POLL) => {}
                }
            }
        })
        .await;
    }
}
