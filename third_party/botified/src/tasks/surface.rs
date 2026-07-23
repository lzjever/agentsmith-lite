use super::{CallbackDelivery, TaskSnapshot, TaskState};
use crate::formatting::system_time_rfc3339;

#[derive(Debug, Clone)]
pub(crate) struct TaskSurfaceFacts {
    pub(crate) state_name: &'static str,
    pub(crate) callback_delivery_name: &'static str,
    pub(crate) timeout_secs: Option<f64>,
    pub(crate) timeout_at_rfc3339: Option<String>,
    pub(crate) forced_termination_at_rfc3339: Option<String>,
    pub(crate) output_artifact_path: Option<String>,
    pub(crate) output_live: bool,
    pub(crate) output_complete: bool,
    pub(crate) output_bytes: u64,
    pub(crate) output_last_updated_at_rfc3339: Option<String>,
    pub(crate) output_tail_truncated: bool,
    pub(crate) output_artifact_truncated: bool,
    pub(crate) output_dropped_bytes: u64,
    pub(crate) callback_input_id: Option<String>,
}

pub(crate) fn task_surface_facts(snapshot: &TaskSnapshot) -> TaskSurfaceFacts {
    let timeout_at_rfc3339 = snapshot.timeout_at.map(system_time_rfc3339);
    TaskSurfaceFacts {
        state_name: task_state_name(snapshot.state),
        callback_delivery_name: callback_delivery_name(snapshot.callback_delivery),
        timeout_secs: task_timeout_secs(snapshot),
        timeout_at_rfc3339: timeout_at_rfc3339.clone(),
        forced_termination_at_rfc3339: timeout_at_rfc3339,
        output_artifact_path: task_output_artifact_path(snapshot),
        output_live: snapshot.output.output_live,
        output_complete: snapshot.output.output_complete,
        output_bytes: snapshot.output.output_bytes,
        output_last_updated_at_rfc3339: snapshot
            .output
            .output_last_updated_at
            .map(system_time_rfc3339),
        output_tail_truncated: snapshot.output.output_tail_truncated,
        output_artifact_truncated: snapshot.output.output_artifact_truncated,
        output_dropped_bytes: snapshot.output.output_dropped_bytes,
        callback_input_id: snapshot
            .callback_payload
            .as_ref()
            .map(|payload| payload.message_id.clone()),
    }
}

pub(crate) fn task_state_name(state: TaskState) -> &'static str {
    match state {
        TaskState::Running => "running",
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::TimedOut => "timed_out",
        TaskState::Cancelling => "cancelling",
        TaskState::Cancelled => "cancelled",
        TaskState::Lost => "lost",
    }
}

fn callback_delivery_name(delivery: CallbackDelivery) -> &'static str {
    match delivery {
        CallbackDelivery::NotReady => "not_ready",
        CallbackDelivery::Pending => "pending",
        CallbackDelivery::Enqueued => "queued",
        CallbackDelivery::Delivered => "delivered",
        CallbackDelivery::Failed => "failed",
    }
}

fn task_timeout_secs(snapshot: &TaskSnapshot) -> Option<f64> {
    let timeout_at = snapshot.timeout_at?;
    let started = snapshot.detached_at.unwrap_or(snapshot.started_at);
    timeout_at
        .duration_since(started)
        .ok()
        .map(|duration| duration.as_secs_f64())
}

fn task_output_artifact_path(snapshot: &TaskSnapshot) -> Option<String> {
    snapshot
        .output
        .artifact_path
        .as_ref()
        .map(|path| path.display().to_string())
}
