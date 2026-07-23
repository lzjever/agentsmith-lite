use serde_json::{json, Value};

use crate::agent_loop::QueuedInputMetadata;
use crate::formatting::bounded_chars;
use crate::subagents::{
    SubagentCallbackStatus, SubagentCallbackSummary, SubagentLifecycle, SubagentRunState,
    SubagentSnapshot, SubagentTailEntry, SubagentTailKind,
};

pub(super) fn subagent_summary(snapshot: &SubagentSnapshot) -> Value {
    let display = crate::tasks::subagent_work_display(
        &snapshot.id,
        Some(&snapshot.name),
        Some(&snapshot.purpose),
    );
    json!({
        "subagent_id": snapshot.id,
        "name": snapshot.name,
        "purpose": bounded_chars(&snapshot.purpose, 512),
        "label": display.label,
        "work_summary": display.summary,
        "lifecycle": subagent_lifecycle_name(snapshot.lifecycle),
        "run_state": subagent_run_state_name(snapshot.run_state),
        "status_summary": subagent_status_summary(snapshot),
        "latest_result": snapshot.latest_result.as_ref().map(|value| bounded_chars(value, 2048)),
        "latest_error": snapshot.latest_error.as_ref().map(|value| bounded_chars(value, 2048)),
        "queued_message_count": snapshot.queued_message_count,
        "owned_task_count": snapshot.owned_task_count,
        "owned_task_ids_omitted": snapshot.owned_task_ids_omitted,
        "owned_task_ids_truncated": snapshot.owned_task_ids_truncated,
        "callback_count": snapshot.callback_count,
        "pending_callback_count": snapshot.pending_callback_count,
        "failed_callback_count": snapshot.failed_callback_count,
        "callbacks_omitted": snapshot.callbacks_omitted,
        "callbacks_truncated": snapshot.callbacks_truncated,
        "latest_callback": snapshot.callbacks.last().map(subagent_callback_summary_json),
        "tail_truncated": snapshot.tail_truncated,
    })
}

pub(super) fn subagent_public_summary(snapshot: &SubagentSnapshot) -> Value {
    let status_summary = subagent_status_summary(snapshot);
    let display = crate::tasks::subagent_work_display(
        &snapshot.id,
        Some(&snapshot.name),
        Some(&snapshot.purpose),
    );
    json!({
        "subagent_id": snapshot.id,
        "name": snapshot.name,
        "purpose": bounded_chars(&snapshot.purpose, 512),
        "label": display.label,
        "work_summary": display.summary,
        "status": status_summary,
        "status_summary": status_summary,
        "latest_result": snapshot.latest_result.as_ref().map(|value| bounded_chars(value, 2048)),
        "latest_error": snapshot.latest_error.as_ref().map(|value| bounded_chars(value, 2048)),
        "queued_message_count": snapshot.queued_message_count,
        "owned_task_count": snapshot.owned_task_count,
        "owned_task_ids_omitted": snapshot.owned_task_ids_omitted,
        "owned_task_ids_truncated": snapshot.owned_task_ids_truncated,
        "callback_count": snapshot.callback_count,
        "pending_callback_count": snapshot.pending_callback_count,
        "failed_callback_count": snapshot.failed_callback_count,
        "callbacks_omitted": snapshot.callbacks_omitted,
        "callbacks_truncated": snapshot.callbacks_truncated,
        "latest_callback": snapshot.callbacks.last().map(subagent_callback_summary_json),
    })
}

pub(super) fn subagent_read_details(snapshot: &SubagentSnapshot, include: &str) -> Value {
    let mut details = subagent_summary(snapshot);
    if matches!(include, "tail" | "all") {
        details["tail"] = json!(snapshot
            .tail
            .iter()
            .map(subagent_tail_entry_json)
            .collect::<Vec<_>>());
    }
    if include == "all" {
        details["queued_messages"] = json!(snapshot
            .queued_messages
            .iter()
            .map(|message| bounded_chars(message, 1024))
            .collect::<Vec<_>>());
        details["owned_task_ids"] = json!(snapshot.owned_task_ids);
        details["callbacks"] = json!(snapshot
            .callbacks
            .iter()
            .map(subagent_callback_summary_json)
            .collect::<Vec<_>>());
    }
    details
}

fn subagent_callback_summary_json(callback: &SubagentCallbackSummary) -> Value {
    json!({
        "callback_id": callback.callback_id,
        "kind": callback.kind,
        "status": subagent_callback_status_name(callback.status),
        "failure_reason": callback.failure_reason.as_ref().map(|reason| bounded_chars(reason, 512))
    })
}

pub(super) fn subagent_event_data(snapshot: &SubagentSnapshot) -> Value {
    let mut data = subagent_summary(snapshot);
    data["tail"] = json!(snapshot
        .tail
        .iter()
        .rev()
        .take(4)
        .map(subagent_tail_entry_json)
        .collect::<Vec<_>>());
    data
}

fn subagent_tail_entry_json(entry: &SubagentTailEntry) -> Value {
    json!({
        "kind": subagent_tail_kind_name(entry.kind),
        "text": bounded_chars(&entry.text, 2048)
    })
}

fn subagent_lifecycle_name(lifecycle: SubagentLifecycle) -> &'static str {
    match lifecycle {
        SubagentLifecycle::Open => "open",
        SubagentLifecycle::Cancelled => "cancelled",
    }
}

fn subagent_run_state_name(state: SubagentRunState) -> &'static str {
    match state {
        SubagentRunState::Idle => "idle",
        SubagentRunState::Running => "running",
        SubagentRunState::Completed => "completed",
        SubagentRunState::Failed => "failed",
    }
}

fn subagent_tail_kind_name(kind: SubagentTailKind) -> &'static str {
    match kind {
        SubagentTailKind::Sent => "sent",
        SubagentTailKind::Queued => "queued",
        SubagentTailKind::Result => "result",
        SubagentTailKind::Error => "error",
        SubagentTailKind::Cancelled => "cancelled",
        SubagentTailKind::Task => "task",
    }
}

fn subagent_callback_status_name(status: SubagentCallbackStatus) -> &'static str {
    match status {
        SubagentCallbackStatus::Pending => "pending",
        SubagentCallbackStatus::Delivered => "delivered",
        SubagentCallbackStatus::Failed => "failed",
    }
}

fn canonical_callback_delivery_status(admission_status: &str) -> &'static str {
    match admission_status {
        "queued" | "pending" => "pending",
        "delivered" => "delivered",
        "queue_full" | "failed" => "failed",
        _ => "failed",
    }
}

pub(super) fn project_subagent_callback_metadata(
    data: &mut Value,
    callback_id: &str,
    metadata: &QueuedInputMetadata,
    callback_status: &str,
) {
    let QueuedInputMetadata::SubagentCallback {
        subagent_id,
        kind,
        task_id,
        ask_id,
        tell_id,
        task_message,
        label,
        summary,
    } = metadata
    else {
        return;
    };
    data["subagent_id"] = json!(subagent_id);
    data["callback_id"] = json!(callback_id);
    data["callback_kind"] = json!(kind);
    data["callback_status"] = json!(canonical_callback_delivery_status(callback_status));
    add_subagent_callback_identity(
        data,
        kind,
        task_id.as_deref(),
        ask_id.as_deref().or(tell_id.as_deref()),
    );
    add_subagent_callback_message(data, kind, task_message.as_deref());
    if let Some(label) = label {
        data["label"] = json!(label);
    }
    if let Some(summary) = summary {
        data["summary"] = json!(summary);
    }
}

pub(super) fn add_subagent_callback_identity(
    data: &mut Value,
    kind: &str,
    task_id: Option<&str>,
    semantic_id: Option<&str>,
) {
    if let Some(task_id) = task_id {
        data["task_id"] = json!(task_id);
    }
    match kind {
        "task_ask" => data["ask_id"] = json!(semantic_id),
        "task_tell" => data["tell_id"] = json!(semantic_id),
        _ => {}
    }
    if let Some(semantic_kind) = subagent_callback_semantic_kind(kind) {
        data["semantic_kind"] = json!(semantic_kind);
    }
    if let Some(semantic_status) = subagent_callback_semantic_status(kind) {
        data["semantic_status"] = json!(semantic_status);
    }
}

fn add_subagent_callback_message(data: &mut Value, kind: &str, task_message: Option<&str>) {
    let Some(task_message) = task_message else {
        return;
    };
    let task_message = bounded_chars(task_message, 512);
    data["task_message"] = json!(task_message);
    match kind {
        "task_ask" => data["question"] = json!(task_message),
        "task_tell" => data["notice"] = json!(task_message),
        "completed" | "task_completed" => data["output"] = json!(task_message),
        "failed" | "task_failed" | "task_timed_out" | "task_cancelled" | "task_lost" => {
            data["error"] = json!(task_message)
        }
        _ => {}
    }
}

fn subagent_callback_semantic_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "task_ask" => Some("task_question"),
        "task_tell" => Some("task_notice"),
        "task_completed" | "task_failed" | "task_timed_out" | "task_cancelled" | "task_lost" => {
            Some("task_result")
        }
        "completed" | "failed" => Some("subagent_result"),
        _ => None,
    }
}

fn subagent_callback_semantic_status(kind: &str) -> Option<&'static str> {
    match kind {
        "task_ask" => Some("waiting"),
        "task_tell" => Some("notified"),
        "task_completed" | "completed" => Some("completed"),
        "task_failed" | "failed" => Some("failed"),
        "task_timed_out" => Some("timed_out"),
        "task_cancelled" => Some("cancelled"),
        "task_lost" => Some("lost"),
        _ => None,
    }
}

pub(super) fn subagent_status_summary(snapshot: &SubagentSnapshot) -> &'static str {
    if snapshot.lifecycle == SubagentLifecycle::Cancelled {
        "cancelled"
    } else {
        subagent_run_state_name(snapshot.run_state)
    }
}

pub(super) fn subagent_active_item_status(snapshot: &SubagentSnapshot) -> &'static str {
    if snapshot.lifecycle == SubagentLifecycle::Cancelled {
        "cancelled"
    } else if snapshot.run_state == SubagentRunState::Running {
        "running"
    } else {
        "open"
    }
}
