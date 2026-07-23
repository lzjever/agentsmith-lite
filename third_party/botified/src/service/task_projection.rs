use std::time::Duration;

use serde_json::{json, Value};

use super::{TaskSendOutcome, TaskSendStatus, TaskTellSnapshot};
use crate::agent_loop::{QueuedInputMetadata, TaskCallbackExecutionState};
use crate::formatting::bounded_chars;
use crate::tasks::{
    task_state_name, task_surface_facts, CallbackDelivery, TaskFrameDiagnostic, TaskOwner,
    TaskReplyOutcome, TaskReplyStatus, TaskRequestEffect, TaskRequestSnapshot, TaskRequestState,
    TaskSnapshot, TaskState, TaskStdinIntent, TaskStdinIntentKind,
};
use crate::types::{ContentPart, ToolCall};

const TASK_REPLY_SOURCE: &str = "agent_tool";
const TASK_CALLBACK_OUTPUT_TAIL_CHARS: usize = 8 * 1024;
const TASK_CALLBACK_ERROR_CHARS: usize = 512;
const TASK_CALLBACK_SUMMARY_CHARS: usize = 512;

pub(super) fn task_requires_active_item(task: &TaskSnapshot) -> bool {
    matches!(task.state, TaskState::Running | TaskState::Cancelling)
        || (task.state.is_terminal()
            && matches!(
                task.callback_delivery,
                CallbackDelivery::Pending | CallbackDelivery::Enqueued | CallbackDelivery::Failed
            ))
}

pub(super) fn active_task_status(task: &TaskSnapshot) -> &'static str {
    task_state_name(task.state)
}

pub(super) fn terminal_task_event_type(state: TaskState) -> &'static str {
    match state {
        TaskState::Completed => "task.completed",
        TaskState::Failed => "task.failed",
        TaskState::TimedOut => "task.timed_out",
        TaskState::Cancelled | TaskState::Cancelling => "task.cancelled",
        TaskState::Lost => "task.lost",
        TaskState::Running => "task.failed",
    }
}

pub(super) fn task_event_data(snapshot: &TaskSnapshot) -> Value {
    let facts = task_surface_facts(snapshot);
    let display = crate::tasks::runtime_work_display(snapshot);
    json!({
        "task_id": snapshot.task_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "preset_id": snapshot.preset_id,
        "preset_description": snapshot.preset_description,
        "state": facts.state_name,
        "status": facts.state_name,
        "task_label": display.label,
        "work_summary": display.summary,
        "arguments_summary": bounded_chars(&snapshot.arguments_summary, 512),
        "timeout_secs": facts.timeout_secs,
        "timeout_at": facts.timeout_at_rfc3339,
        "forced_termination_at": facts.forced_termination_at_rfc3339,
        "output_tail": snapshot.output.tail,
        "output_live": facts.output_live,
        "output_complete": facts.output_complete,
        "output_bytes": facts.output_bytes,
        "output_last_updated_at": facts.output_last_updated_at_rfc3339,
        "output_tail_truncated": facts.output_tail_truncated,
        "output_artifact_path": facts.output_artifact_path,
        "output_artifact_truncated": facts.output_artifact_truncated,
        "output_dropped_bytes": facts.output_dropped_bytes,
        "callback_delivery": facts.callback_delivery_name,
        "callback_failure_reason": snapshot.callback_failure_reason,
        "callback_input_id": facts.callback_input_id,
    })
}

pub(super) fn task_request_content(snapshot: &TaskRequestSnapshot) -> Vec<ContentPart> {
    let mut body = format!(
        "<task_ask task_id=\"{}\" ask_id=\"{}\" tool_call_id=\"{}\" tool_name=\"{}\" urgency=\"{}\" asked_at=\"{}\" deadline_at=\"{}\" effective_timeout_secs=\"{}\"",
        xml_attr_escape(&snapshot.task_id),
        xml_attr_escape(&snapshot.request_id),
        xml_attr_escape(&snapshot.tool_call_id),
        xml_attr_escape(&snapshot.tool_name),
        snapshot.urgency.as_str(),
        crate::formatting::system_time_rfc3339(snapshot.requested_at),
        crate::formatting::system_time_rfc3339(snapshot.deadline_at),
        duration_secs_attr(snapshot.effective_timeout)
    );
    if let Some(label) = snapshot.task_label.as_deref() {
        body.push_str(&format!(" label=\"{}\"", xml_attr_escape(label)));
    }
    if let Some(summary) = snapshot.work_summary.as_deref() {
        body.push_str(&format!(" summary=\"{}\"", xml_attr_escape(summary)));
    }
    if let Some(timeout) = snapshot.requested_timeout {
        body.push_str(&format!(
            " requested_timeout_secs=\"{}\"",
            duration_secs_attr(timeout)
        ));
    }
    if let Some(expect) = snapshot.expect.as_deref() {
        body.push_str(&format!(" expect=\"{}\"", xml_attr_escape(expect)));
    }
    body.push_str(">\n");
    body.push_str(&snapshot.request);
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str("</task_ask>");
    vec![ContentPart::text(body)]
}

pub(super) fn task_tell_content(snapshot: &TaskTellSnapshot) -> Vec<ContentPart> {
    let mut body = format!(
        "<task_tell task_id=\"{}\" tell_id=\"{}\" tool_call_id=\"{}\" tool_name=\"{}\" urgency=\"{}\" told_at=\"{}\"",
        xml_attr_escape(&snapshot.task_id),
        xml_attr_escape(&snapshot.tell_id),
        xml_attr_escape(&snapshot.tool_call_id),
        xml_attr_escape(&snapshot.tool_name),
        snapshot.urgency.as_str(),
        crate::formatting::system_time_rfc3339(snapshot.told_at),
    );
    if let Some(label) = snapshot.task_label.as_deref() {
        body.push_str(&format!(" label=\"{}\"", xml_attr_escape(label)));
    }
    if let Some(summary) = snapshot.work_summary.as_deref() {
        body.push_str(&format!(" summary=\"{}\"", xml_attr_escape(summary)));
    }
    body.push_str(">\n");
    body.push_str(&snapshot.message);
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str("</task_tell>");
    vec![ContentPart::text(body)]
}

pub(super) fn task_request_event_data(snapshot: &TaskRequestSnapshot) -> Value {
    json!({
        "task_id": snapshot.task_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "arguments_summary": bounded_chars(&snapshot.arguments_summary, 512),
        "task_label": snapshot.task_label,
        "work_summary": snapshot.work_summary,
        "sender": snapshot.sender,
        "ask_id": snapshot.request_id,
        "urgency": snapshot.urgency.as_str(),
        "state": task_request_state_name(snapshot.state),
        "status": task_request_state_name(snapshot.state),
        "message": snapshot.request,
        "expect": snapshot.expect,
        "asked_at": crate::formatting::system_time_rfc3339(snapshot.requested_at),
        "deadline_at": crate::formatting::system_time_rfc3339(snapshot.deadline_at),
        "requested_timeout_secs": snapshot.requested_timeout.map(duration_secs_value),
        "effective_timeout_secs": duration_secs_value(snapshot.effective_timeout),
        "failure_reason": snapshot.failure_reason,
    })
}

pub(super) fn task_request_effect_event_data(effect: &TaskRequestEffect) -> Value {
    let mut data = task_request_event_data(&effect.snapshot);
    if let TaskOwner::Subagent { subagent_id } = &effect.snapshot.owner {
        data["subagent_id"] = json!(subagent_id);
        data["reply_status"] = json!(match effect.event_type {
            "task_ask.expired" => "expired",
            _ => "rejected",
        });
    }
    data
}

pub(super) fn task_tell_event_data(snapshot: &TaskTellSnapshot) -> Value {
    json!({
        "kind": "task_tell",
        "task_id": snapshot.task_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "arguments_summary": bounded_chars(&snapshot.arguments_summary, 512),
        "task_label": snapshot.task_label,
        "work_summary": snapshot.work_summary,
        "sender": snapshot.sender,
        "tell_id": snapshot.tell_id,
        "urgency": snapshot.urgency.as_str(),
        "state": snapshot.state,
        "status": snapshot.state,
        "message": snapshot.message,
        "told_at": crate::formatting::system_time_rfc3339(snapshot.told_at),
        "failure_reason": snapshot.failure_reason,
    })
}

pub(super) fn task_tell_diagnostic_event_data(
    snapshot: &TaskTellSnapshot,
    diagnostic: &TaskFrameDiagnostic,
) -> Value {
    let mut data = task_tell_event_data(snapshot);
    data["error"] = json!({
        "code": diagnostic.code,
        "message": diagnostic.message,
        "retryable": false
    });
    data
}

pub(super) fn task_stdin_write_failed_event_data(intent: &TaskStdinIntent, error: &str) -> Value {
    let kind = match intent.kind {
        TaskStdinIntentKind::Response => "response",
        TaskStdinIntentKind::Exception { code } => code,
        TaskStdinIntentKind::Send => "send",
    };
    let mut data = json!({
        "task_id": intent.task_id,
        "kind": kind,
        "error": bounded_chars(error, 512),
    });
    match intent.kind {
        TaskStdinIntentKind::Send => data["send_id"] = json!(intent.request_id),
        TaskStdinIntentKind::Response | TaskStdinIntentKind::Exception { .. } => {
            data["ask_id"] = json!(intent.request_id);
        }
    }
    data
}

pub(super) fn duplicate_task_request_warning_data(snapshot: &TaskRequestSnapshot) -> Value {
    json!({
        "domain": "task_ask",
        "code": "duplicate_ask_id",
        "severity": "warning",
        "status": "ignored",
        "message": "duplicate pending task_ask id ignored",
        "task_id": snapshot.task_id,
        "ask_id": snapshot.request_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "arguments_summary": bounded_chars(&snapshot.arguments_summary, 512),
        "sender": snapshot.sender,
        "asked_at": crate::formatting::system_time_rfc3339(snapshot.requested_at),
        "deadline_at": crate::formatting::system_time_rfc3339(snapshot.deadline_at),
        "requested_timeout_secs": snapshot.requested_timeout.map(duration_secs_value),
        "effective_timeout_secs": duration_secs_value(snapshot.effective_timeout),
    })
}

pub(super) fn task_frame_diagnostic_data(
    task_id: &str,
    diagnostic: &TaskFrameDiagnostic,
    task: Option<&TaskSnapshot>,
) -> Value {
    let mut data = json!({
        "task_id": task_id,
        "ask_id": diagnostic.request_id,
        "state": "rejected",
        "status": "rejected",
        "failure_reason": diagnostic.message,
        "error": {
            "code": diagnostic.code,
            "message": diagnostic.message,
            "retryable": false
        }
    });
    if let Some(task) = task {
        let arguments_summary = bounded_chars(&task.arguments_summary, 512);
        data["tool_call_id"] = json!(task.tool_call_id.clone());
        data["tool_name"] = json!(task.tool_name.clone());
        data["arguments_summary"] = json!(arguments_summary.clone());
        data["sender"] = json!(task_request_sender_for_event(
            &task.tool_name,
            &arguments_summary
        ));
    }
    data
}

pub(super) fn task_reply_event_data(outcome: &TaskReplyOutcome) -> Value {
    let mut data = task_reply_details(outcome);
    data["reply_status"] = json!(canonical_reply_status(&outcome.status));
    if let Some(snapshot) = outcome.snapshot.as_ref() {
        data["task_id"] = json!(snapshot.task_id);
        data["ask_id"] = json!(snapshot.request_id);
        data["state"] = json!(task_request_state_name(snapshot.state));
        data["status"] = json!(task_request_state_name(snapshot.state));
    }
    data
}

pub(super) fn task_reply_attempt_event_type(outcome: &TaskReplyOutcome) -> &'static str {
    if outcome.status == TaskReplyStatus::Written {
        "task_reply.written"
    } else {
        "task_reply.failed"
    }
}

pub(super) fn task_reply_details(outcome: &TaskReplyOutcome) -> Value {
    json!({
        "kind": "task_reply",
        "ok": outcome.ok(),
        "status": task_reply_status_name(&outcome.status),
        "message": outcome.message,
        "task_id": outcome.task_id.clone(),
        "ask_id": outcome.request_id.clone(),
        "source": TASK_REPLY_SOURCE,
    })
}

pub(super) fn task_reply_status_name(status: &TaskReplyStatus) -> &'static str {
    match status {
        TaskReplyStatus::Written => "written",
        TaskReplyStatus::Failed => "failed",
        TaskReplyStatus::UnknownTask => "unknown_task",
        TaskReplyStatus::UnknownRequest => "unknown_ask",
        TaskReplyStatus::AlreadyResolved => "already_resolved",
        TaskReplyStatus::Expired => "expired",
        TaskReplyStatus::TaskTerminal => "task_terminal",
        TaskReplyStatus::ResponseTooLarge => "message_too_large",
    }
}

pub(super) fn task_send_details(outcome: &TaskSendOutcome) -> Value {
    json!({
        "kind": "task_send",
        "ok": outcome.ok(),
        "status": task_send_status_name(&outcome.status),
        "state": task_send_status_name(&outcome.status),
        "message": outcome.message,
        "task_id": outcome.task_id,
        "send_id": outcome.send_id,
        "source": "agent_tool",
    })
}

pub(super) fn task_send_status_name(status: &TaskSendStatus) -> &'static str {
    match status {
        TaskSendStatus::Written => "written",
        TaskSendStatus::UnknownTask => "unknown_task",
        TaskSendStatus::TaskTerminal => "task_terminal",
        TaskSendStatus::StdinNotWritable => "stdin_not_writable",
        TaskSendStatus::MessageTooLarge => "message_too_large",
        TaskSendStatus::WriteFailed => "write_failed",
        TaskSendStatus::ServiceUnavailable => "service_unavailable",
    }
}

pub(super) fn task_request_state_name(state: TaskRequestState) -> &'static str {
    match state {
        TaskRequestState::Pending => "pending",
        TaskRequestState::Replied => "replied",
        TaskRequestState::Written => "written",
        TaskRequestState::WriteFailed => "write_failed",
        TaskRequestState::Expired => "expired",
        TaskRequestState::Rejected => "rejected",
        TaskRequestState::TaskTerminal => "task_terminal",
    }
}

pub(super) fn task_callback_metadata(snapshot: &TaskSnapshot) -> Option<QueuedInputMetadata> {
    let execution_state = match snapshot.state {
        TaskState::Completed => TaskCallbackExecutionState::Completed,
        TaskState::Failed => TaskCallbackExecutionState::Failed,
        TaskState::TimedOut => TaskCallbackExecutionState::TimedOut,
        TaskState::Cancelled => TaskCallbackExecutionState::Cancelled,
        TaskState::Lost => TaskCallbackExecutionState::Lost,
        TaskState::Running | TaskState::Cancelling => return None,
    };
    let display = crate::tasks::runtime_work_display(snapshot);
    let output_tail = bounded_chars(&snapshot.output.tail, TASK_CALLBACK_OUTPUT_TAIL_CHARS);
    Some(QueuedInputMetadata::TaskCallback {
        task_id: snapshot.task_id.clone(),
        tool_call_id: snapshot.tool_call_id.clone(),
        tool_name: snapshot.tool_name.clone(),
        execution_state,
        label: display.label,
        summary: display
            .summary
            .map(|value| bounded_chars(&value, TASK_CALLBACK_SUMMARY_CHARS)),
        output_tail_truncated: snapshot.output.output_tail_truncated
            || output_tail.chars().count() < snapshot.output.tail.chars().count(),
        output_tail,
        error: snapshot
            .callback_failure_reason
            .as_deref()
            .map(|value| bounded_chars(value, TASK_CALLBACK_ERROR_CHARS)),
    })
}

pub(super) fn task_callback_content(
    tool_call: &ToolCall,
    snapshot: &TaskSnapshot,
) -> Vec<ContentPart> {
    let facts = task_surface_facts(snapshot);
    let status = match snapshot.state {
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::TimedOut => "timed_out",
        TaskState::Cancelled | TaskState::Cancelling => "cancelled",
        TaskState::Lost => "lost",
        TaskState::Running => "failed",
    };
    let mut body = String::new();
    if let Some(path) = facts.output_artifact_path {
        body.push_str(&format!("output_artifact_path: {path}\n"));
    }
    body.push_str(&format!(
        "timeout_secs: {}\n",
        optional_seconds_for_callback(facts.timeout_secs)
    ));
    body.push_str(&format!(
        "forced_termination_at: {}\n",
        facts
            .forced_termination_at_rfc3339
            .as_deref()
            .unwrap_or("null")
    ));
    body.push_str(&format!("output_live: {}\n", facts.output_live));
    body.push_str(&format!("output_complete: {}\n", facts.output_complete));
    body.push_str(&format!("output_bytes: {}\n", facts.output_bytes));
    if let Some(updated_at) = facts.output_last_updated_at_rfc3339 {
        body.push_str(&format!("output_last_updated_at: {updated_at}\n"));
    }
    body.push_str(&format!(
        "output_tail_truncated: {}\n",
        facts.output_tail_truncated
    ));
    body.push_str(&format!(
        "output_artifact_truncated: {}\n",
        facts.output_artifact_truncated
    ));
    body.push_str(&format!(
        "output_dropped_bytes: {}\n",
        facts.output_dropped_bytes
    ));
    if !snapshot.output.tail.is_empty() {
        body.push_str("output_tail:\n");
        body.push_str(&bounded_chars(&snapshot.output.tail, 8 * 1024));
        if !body.ends_with('\n') {
            body.push('\n');
        }
    }
    let display = crate::tasks::runtime_work_display(snapshot);
    let mut attributes = String::new();
    if let Some(label) = display.label.as_deref() {
        attributes.push_str(&format!(" label=\"{}\"", xml_attr_escape(label)));
    }
    if let Some(summary) = display.summary.as_deref() {
        attributes.push_str(&format!(" summary=\"{}\"", xml_attr_escape(summary)));
    }
    vec![ContentPart::text(format!(
        "<task_callback task_id=\"{}\" tool_call_id=\"{}\" tool_name=\"{}\" status=\"{}\"{}>\n{}\n</task_callback>",
        xml_attr_escape(&snapshot.task_id),
        xml_attr_escape(&tool_call.id),
        xml_attr_escape(&tool_call.name),
        status,
        attributes,
        body
    ))]
}

pub(super) fn subagent_task_callback_kind(state: TaskState) -> &'static str {
    match state {
        TaskState::Completed => "task_completed",
        TaskState::Failed => "task_failed",
        TaskState::TimedOut => "task_timed_out",
        TaskState::Cancelled | TaskState::Cancelling => "task_cancelled",
        TaskState::Lost => "task_lost",
        TaskState::Running => "task_failed",
    }
}

pub(super) fn xml_attr_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn duration_secs_value(duration: Duration) -> f64 {
    duration.as_secs_f64()
}

fn duration_secs_attr(duration: Duration) -> String {
    let seconds = duration.as_secs_f64();
    if seconds.fract() == 0.0 {
        return format!("{seconds:.0}");
    }
    let mut text = format!("{seconds:.9}");
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    text
}

fn task_request_sender_for_event(tool_name: &str, arguments_summary: &str) -> String {
    if arguments_summary.trim().is_empty() {
        tool_name.to_owned()
    } else {
        format!("{tool_name}: {arguments_summary}")
    }
}

fn canonical_reply_status(status: &TaskReplyStatus) -> &'static str {
    match status {
        TaskReplyStatus::Written => "written",
        TaskReplyStatus::Failed => "failed",
        TaskReplyStatus::Expired => "expired",
        TaskReplyStatus::UnknownTask
        | TaskReplyStatus::UnknownRequest
        | TaskReplyStatus::AlreadyResolved
        | TaskReplyStatus::TaskTerminal
        | TaskReplyStatus::ResponseTooLarge => "rejected",
    }
}

fn optional_seconds_for_callback(seconds: Option<f64>) -> String {
    seconds
        .map(|seconds| {
            if seconds.fract() == 0.0 {
                format!("{seconds:.0}")
            } else {
                seconds.to_string()
            }
        })
        .unwrap_or_else(|| "null".to_owned())
}
