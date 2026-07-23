use serde_json::json;

use crate::agent_loop::{AgentCompactionSafePoint, AgentCompactionUpdate};
use crate::session::CompactionMetadata;
use crate::transcript::repair_provider_transcript;
use crate::types::{ContentPart, Message};

use super::super::compaction_shared::{bounded_compact_diagnostic, retained_compaction_tail};
use super::super::{ActiveRequestInput, ContextMaintenanceStatus, ServiceInner};
use super::{input_too_large_for_model_window_message, usize_to_u64_saturating};

pub(in crate::service) const ACTIVE_REQUEST_TOO_LARGE_FOR_MODEL_WINDOW: &str =
    "active_request_too_large_for_model_window";
pub(in crate::service) const ACTIVE_REQUEST_RECOVERY_APPEND_FAILED: &str =
    "active request recovery compaction append failed";

fn active_request_too_large_for_model_window_summary(request: &[Message]) -> Vec<ContentPart> {
    let user_messages = request
        .iter()
        .filter(|message| matches!(message, Message::User { .. }))
        .count();
    let assistant_messages = request
        .iter()
        .filter(|message| matches!(message, Message::Assistant { .. }))
        .count();
    let tool_results = request
        .iter()
        .filter(|message| matches!(message, Message::ToolResult(_)))
        .count();
    vec![ContentPart::text(format!(
        "{}\n\n\
This bounded recovery view was generated locally because the active request still exceeded the model window after local recovery. Botified omitted that active request from the provider transcript so later inputs can continue. Full accepted input and tool output remain in the session/timeline files.\n\n\
Omitted active request messages: {}\n\
Omitted user messages: {user_messages}\n\
Omitted assistant messages: {assistant_messages}\n\
Omitted tool result messages: {tool_results}\n\n\
No facts were inferred from the omitted active request.",
        crate::compact::LOCAL_DEGRADED_RECOVERY_FIRST_LINE,
        request.len(),
    ))]
}

fn recovered_prefix_before_oversized_active_request(
    prefix: &[Message],
    policy: crate::compact::CompactPolicy,
    target_usable_tokens: usize,
) -> Vec<Message> {
    let repaired_prefix = repair_provider_transcript(prefix.to_vec());
    if crate::compact::context_tokens(&repaired_prefix) <= target_usable_tokens {
        return retained_compaction_tail(&repaired_prefix);
    }
    retained_compaction_tail(
        &crate::compact::build_degraded_local_recovery(&repaired_prefix, policy).messages(),
    )
}

impl ServiceInner {
    pub(super) async fn recover_oversized_active_request_for_model_window(
        &self,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
        policy: crate::compact::CompactPolicy,
        observed_input_tokens: usize,
        hard_stop_tokens: usize,
    ) -> AgentCompactionUpdate {
        let split = safe_point.current_request_start.min(messages.len());
        let prefix = &messages[..split];
        let active_request = &messages[split..];
        let omitted_message_count = active_request.len();
        let summary_content = active_request_too_large_for_model_window_summary(active_request);
        let summary_message = Message::user(summary_content.clone());
        let retained_messages =
            recovered_prefix_before_oversized_active_request(prefix, policy, hard_stop_tokens);
        let metadata = CompactionMetadata {
            source: Some("local_recovery".to_owned()),
            degraded: true,
            reason: Some(ACTIVE_REQUEST_TOO_LARGE_FOR_MODEL_WINDOW.to_owned()),
            observed_request_tokens: Some(usize_to_u64_saturating(observed_input_tokens)),
            target_usable_tokens: Some(usize_to_u64_saturating(hard_stop_tokens)),
        };

        let mut recovery_persisted = false;
        if let Some(recorder) = self.recorder.as_deref() {
            if let Err(error) = recorder
                .record_compaction_with_active_user_message_id_and_metadata(
                    &summary_content,
                    &retained_messages,
                    None,
                    Some(&metadata),
                )
                .await
            {
                let diagnostic = bounded_compact_diagnostic(&error.to_string());
                self.append_compact_debug_event(
                    "compact.failed",
                    json!({
                        "reason": "active_request_recovery_session_append_failed",
                        "source": "local_recovery",
                        "degraded": true,
                        "volatile": true,
                        "error": diagnostic,
                    }),
                );
                self.clear_any_pending_recovery_record();
                return AgentCompactionUpdate::fail_persistence(
                    safe_point.current_request_start.min(messages.len()),
                    ACTIVE_REQUEST_RECOVERY_APPEND_FAILED,
                );
            } else {
                recovery_persisted = true;
            }
        }
        if recovery_persisted {
            self.note_durable_transcript_boundary();
        }
        self.close_out_omitted_active_request_inputs_for_model_window(
            safe_point.active_inputs,
            observed_input_tokens,
            hard_stop_tokens,
        );

        let mut recovered_messages = Vec::with_capacity(1 + retained_messages.len());
        recovered_messages.push(summary_message);
        recovered_messages.extend(retained_messages);
        *messages = repair_provider_transcript(recovered_messages);
        self.replace_main_context_snapshot(messages);
        self.install_compaction_idle(None, None);
        self.set_context_maintenance_status(ContextMaintenanceStatus::degraded(
            ACTIVE_REQUEST_TOO_LARGE_FOR_MODEL_WINDOW,
            false,
            observed_input_tokens,
            hard_stop_tokens,
        ));
        self.append_compact_debug_event(
            "compact.completed",
            json!({
                "source": "local_recovery",
                "degraded": true,
                "volatile": false,
                "reason": ACTIVE_REQUEST_TOO_LARGE_FOR_MODEL_WINDOW,
                "observed_request_tokens": observed_input_tokens,
                "target_usable_tokens": hard_stop_tokens,
                "current_request_start": split,
                "omitted_message_count": omitted_message_count,
                "messages_after": messages.len(),
            }),
        );

        AgentCompactionUpdate::finish_current_request(messages.len())
    }

    fn close_out_omitted_active_request_inputs_for_model_window(
        &self,
        active_inputs: &[ActiveRequestInput],
        observed_input_tokens: usize,
        hard_stop_tokens: usize,
    ) {
        let message =
            input_too_large_for_model_window_message(observed_input_tokens, hard_stop_tokens);
        for input in active_inputs {
            self.record_task_input_too_large_diagnostic(
                &input.id,
                input.source,
                input.urgency,
                input.metadata.as_ref(),
                &input.content,
                &message,
            );
        }
    }
}
