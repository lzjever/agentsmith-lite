use serde_json::json;

use super::super::compaction_shared::INPUT_TOO_LARGE_FOR_MODEL_WINDOW;
use super::super::subagent_projection::{project_subagent_callback_metadata, subagent_event_data};
use super::super::task_runtime::task_tell_snapshot;
use super::super::*;
use super::rejected_input_removal::RejectedInputContextRemoval;

pub(in crate::service) const REJECTED_INPUT_APPEND_FAILED: &str =
    "oversized input rejection event append failed";

pub(super) fn input_too_large_for_model_window_message(
    _observed_input_tokens: usize,
    _hard_stop_tokens: usize,
) -> String {
    "This input is too large to send. Shorten it or split it into smaller messages.".to_owned()
}

fn rejected_input_too_large_for_model_window_summary(
    input_id: &str,
    source: InputSource,
    observed_input_tokens: usize,
    hard_stop_tokens: usize,
) -> Vec<ContentPart> {
    vec![ContentPart::text(format!(
        "{}\n\n\
Botified rejected one accepted input because it was too large for the model window. The rejected input text was omitted from the provider transcript and from replay summaries.\n\n\
Rejected input id: {input_id}\n\
Rejected input source: {}\n\
Observed request tokens: {observed_input_tokens}\n\
Target usable tokens: {hard_stop_tokens}",
        crate::compact::LOCAL_DEGRADED_RECOVERY_FIRST_LINE,
        source.as_str(),
    ))]
}

fn current_request_is_single_user_message(
    messages: &[Message],
    current_request_start: usize,
) -> bool {
    let Some(request) = messages.get(current_request_start..) else {
        return false;
    };
    matches!(request, [Message::User { .. }])
}

pub(super) fn current_request_can_be_rejected_as_single_user_input(
    messages: &[Message],
    safe_point: AgentCompactionSafePoint<'_>,
) -> bool {
    safe_point.current_request_input_count == 1
        && safe_point.active_user_message_id.is_some()
        && safe_point.active_input_source.is_some()
        && current_request_is_single_user_message(messages, safe_point.current_request_start)
}

impl ServiceInner {
    pub(super) async fn reject_current_input_too_large_for_model_window(
        &self,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
        observed_input_tokens: usize,
        hard_stop_tokens: usize,
    ) -> Option<AgentCompactionUpdate> {
        if safe_point.current_request_input_count != 1 {
            return None;
        }
        if !current_request_is_single_user_message(messages, safe_point.current_request_start) {
            return None;
        }
        let input_id = safe_point.active_user_message_id?;
        let source = safe_point.active_input_source?;
        let urgency = safe_point.active_input_urgency.unwrap_or_default();
        let Some(Message::User { content }) = messages.get(safe_point.current_request_start) else {
            return None;
        };

        let (rejection_data, turn_id) = {
            let state = self.state.lock().expect("service state mutex poisoned");
            (
                input_rejection_data(
                    InputRejection::new(
                        input_id,
                        content,
                        source,
                        urgency,
                        INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
                        input_too_large_for_model_window_message(
                            observed_input_tokens,
                            hard_stop_tokens,
                        ),
                        false,
                    ),
                    state.input_queue.len(),
                ),
                state.active_turn_id.clone(),
            )
        };
        if self
            .try_append_event_for_turn(turn_id.as_deref(), "message.rejected", rejection_data)
            .is_err()
        {
            return Some(AgentCompactionUpdate::fail_persistence(
                safe_point.current_request_start.min(messages.len()),
                REJECTED_INPUT_APPEND_FAILED,
            ));
        }

        let message =
            input_too_large_for_model_window_message(observed_input_tokens, hard_stop_tokens);
        let mut repaired_messages = messages.clone();
        repaired_messages.remove(safe_point.current_request_start);
        repaired_messages = repair_provider_transcript(repaired_messages);
        let removal_summary = rejected_input_too_large_for_model_window_summary(
            input_id,
            source,
            observed_input_tokens,
            hard_stop_tokens,
        );

        let removal_outcome = self
            .record_rejected_input_context_removal(RejectedInputContextRemoval {
                input_id,
                rejected_summary_content: &removal_summary,
                retained_context_after_removal: &repaired_messages,
                source,
                input_metadata: safe_point.active_input_metadata,
                observed_input_tokens,
                hard_stop_tokens,
            })
            .await;
        self.record_task_input_too_large_diagnostic(
            input_id,
            source,
            urgency,
            safe_point.active_input_metadata,
            content,
            &message,
        );

        let removal_replay_safe = removal_outcome.is_replay_safe();
        self.append_compact_debug_event(
            "compact.failed",
            json!({
                "reason": INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
                "input_id": input_id,
                "source": source.as_str(),
                "observed_input_tokens": observed_input_tokens,
                "hard_stop_tokens": hard_stop_tokens,
                "removal_persisted": removal_replay_safe,
                "removal_outcome": format!("{removal_outcome:?}"),
            }),
        );

        *messages = repaired_messages;
        Some(AgentCompactionUpdate::finish_current_request(
            safe_point.current_request_start.min(messages.len()),
        ))
    }

    pub(super) fn record_task_input_too_large_diagnostic(
        &self,
        input_id: &str,
        source: InputSource,
        urgency: InputUrgency,
        metadata: Option<&QueuedInputMetadata>,
        content: &[ContentPart],
        message: &str,
    ) {
        match (source, metadata) {
            (
                InputSource::TaskRequest,
                Some(QueuedInputMetadata::TaskRequest {
                    task_id,
                    request_id,
                }),
            ) => {
                if let Some(resolution) = self.background_tasks.reject_task_request(
                    task_id,
                    request_id,
                    INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
                    message,
                ) {
                    self.apply_task_request_effects(&resolution.effects);
                } else {
                    self.append_event_for_turn_or_record_error(
                        None,
                        "task_ask.rejected",
                        json!({
                            "task_id": task_id,
                            "ask_id": request_id,
                            "state": "rejected",
                            "status": "rejected",
                            "failure_reason": message,
                            "error": {
                                "code": INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
                                "message": message,
                                "retryable": false
                            }
                        }),
                    );
                }
                self.append_service_status_for_current_state(None);
            }
            (InputSource::TaskTell, Some(QueuedInputMetadata::TaskTell { task_id, tell_id })) => {
                let task = self.background_tasks.get(task_id);
                let snapshot = task_tell_snapshot(
                    task_id,
                    task.as_ref(),
                    TaskTellFrame {
                        id: tell_id.clone(),
                        message: summarize_input_content(content).content_preview,
                        urgency,
                    },
                    "rejected",
                    Some(message.to_owned()),
                );
                let mut data = task_tell_event_data(&snapshot);
                data["error"] = json!({
                    "code": INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
                    "message": message,
                    "retryable": false
                });
                self.append_event_for_turn_or_record_error(None, "task_tell.rejected", data);
                self.write_task_tell_profile("task_tell.rejected", &snapshot);
                self.append_service_status_for_current_state(None);
            }
            (
                InputSource::TaskCallback,
                Some(QueuedInputMetadata::TaskCallback { task_id, .. }),
            ) => {
                if let Some((snapshot, previous_delivery)) = self
                    .background_tasks
                    .stage_callback_failed_for_compaction(task_id, message)
                {
                    let mut data = task_event_data(&snapshot);
                    data["task_id"] = json!(task_id);
                    data["callback_input_id"] = json!(input_id);
                    data["error"] = json!({
                        "code": INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
                        "message": message,
                        "retryable": false
                    });
                    if self
                        .append_event_for_turn_or_record_error(None, "task.callback_failed", data)
                        .is_some()
                    {
                        self.background_tasks
                            .commit_callback_failed_if_payload(task_id, input_id, message);
                    } else {
                        self.background_tasks.restore_callback_if_failed(
                            task_id,
                            input_id,
                            message,
                            previous_delivery,
                        );
                    }
                } else {
                    self.append_event_for_turn_or_record_error(
                        None,
                        "task.callback_failed",
                        json!({
                            "task_id": task_id,
                            "callback_input_id": input_id,
                            "callback_delivery": "failed",
                            "callback_failure_reason": message,
                            "error": {
                                "code": INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
                                "message": message,
                                "retryable": false
                            }
                        }),
                    );
                }
                self.append_service_status_for_current_state(None);
            }
            (
                InputSource::SubagentCallback,
                Some(
                    metadata @ QueuedInputMetadata::SubagentCallback {
                        subagent_id, kind, ..
                    },
                ),
            ) => {
                let snapshot = self
                    .subagents
                    .lock()
                    .expect("subagent manager mutex poisoned")
                    .record_callback(
                        subagent_id,
                        input_id.to_owned(),
                        kind.clone(),
                        SubagentCallbackStatus::Failed,
                        Some(message.to_owned()),
                    )
                    .ok();
                if let Some(snapshot) = snapshot {
                    let mut data = subagent_event_data(&snapshot);
                    project_subagent_callback_metadata(&mut data, input_id, metadata, "failed");
                    data["callback_failure_reason"] = json!(message);
                    data["error"] = json!({
                        "code": INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
                        "message": message,
                        "retryable": false
                    });
                    self.append_event_for_turn_or_record_error(None, "subagent.callback", data);
                    self.append_service_status_for_current_state(None);
                } else {
                    let mut data = json!({
                        "subagent_id": subagent_id,
                        "callback_id": input_id,
                        "callback_kind": kind,
                        "callback_status": "failed",
                        "callback_failure_reason": message,
                        "error": {
                            "code": INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
                            "message": message,
                            "retryable": false
                        }
                    });
                    project_subagent_callback_metadata(&mut data, input_id, metadata, "failed");
                    self.append_event_for_turn_or_record_error(None, "subagent.callback", data);
                }
            }
            _ => {}
        }
    }
}
