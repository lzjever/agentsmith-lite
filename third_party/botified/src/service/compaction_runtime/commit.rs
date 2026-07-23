use serde_json::json;

use crate::agent_loop::{AgentCompactionSafePoint, AgentCompactionUpdate};
use crate::transcript::repair_provider_transcript;
use crate::Message;

use super::super::compaction_shared::{
    bounded_compact_diagnostic, remap_compacted_index, retained_compaction_tail, CompactSlot,
};
use super::super::ServiceInner;

impl ServiceInner {
    pub(super) async fn try_commit_completed_compaction(
        &self,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
    ) -> AgentCompactionUpdate {
        self.retry_pending_recovery_record(Some(messages)).await;

        let completed = {
            let mut slot = self
                .compact
                .slot
                .lock()
                .expect("compact slot mutex poisoned");
            match std::mem::replace(
                &mut *slot,
                CompactSlot::Idle {
                    suppressed_start_len: None,
                    last_successful_hard_key: None,
                },
            ) {
                CompactSlot::Completed {
                    run_id,
                    messages_at_start,
                    retained_start,
                    start_len,
                    summary_result,
                    hard_failure_key,
                    hard_failure_count_at_start,
                } => Some((
                    run_id,
                    messages_at_start,
                    retained_start,
                    start_len,
                    summary_result,
                    hard_failure_key,
                    hard_failure_count_at_start,
                )),
                other => {
                    *slot = other;
                    None
                }
            }
        };

        let Some((
            run_id,
            messages_at_start,
            retained_start,
            start_len,
            summary_result,
            hard_failure_key,
            hard_failure_count_at_start,
        )) = completed
        else {
            return AgentCompactionUpdate::unchanged(safe_point);
        };

        let summary = match summary_result {
            Ok(summary) => summary,
            Err(diagnostic) => {
                let diagnostic = bounded_compact_diagnostic(&diagnostic);
                let hard_failure_count = hard_failure_count_at_start.saturating_add(1);
                self.install_compaction_failure(
                    "summary_failed",
                    diagnostic.clone(),
                    Some(messages.len()),
                    hard_failure_key,
                    hard_failure_count,
                );
                self.append_compact_debug_event(
                    "compact.failed",
                    json!({
                        "run_id": run_id,
                        "reason": "summary_failed",
                        "error": diagnostic,
                        "hard_failure_count": hard_failure_count,
                    }),
                );
                return AgentCompactionUpdate::unchanged(safe_point);
            }
        };

        if retained_start > start_len
            || start_len != messages_at_start.len()
            || messages.len() < start_len
            || messages.get(..start_len) != Some(messages_at_start.as_slice())
        {
            self.install_compaction_failure(
                "prefix_mismatch",
                "completed compaction no longer matches transcript prefix".to_owned(),
                Some(messages.len()),
                None,
                0,
            );
            self.append_compact_debug_event(
                "compact.failed",
                json!({
                    "run_id": run_id,
                    "reason": "prefix_mismatch",
                }),
            );
            return AgentCompactionUpdate::unchanged(safe_point);
        }

        let retained_messages = retained_compaction_tail(&messages[retained_start..]);
        let summary_message = crate::compact::summary_message(&summary);
        let summary_content = match &summary_message {
            Message::User { content } => content.clone(),
            _ => Vec::new(),
        };
        if let Some(recorder) = self.recorder.as_deref() {
            if let Err(error) = recorder
                .record_compaction_with_active_user_message_id(
                    &summary_content,
                    &retained_messages,
                    safe_point.active_user_message_id,
                )
                .await
            {
                let diagnostic = bounded_compact_diagnostic(&error.to_string());
                self.install_compaction_failure(
                    "session_append_failed",
                    diagnostic.clone(),
                    Some(messages.len()),
                    None,
                    0,
                );
                self.append_compact_debug_event(
                    "compact.failed",
                    json!({
                        "run_id": run_id,
                        "reason": "session_append_failed",
                        "error": diagnostic,
                    }),
                );
                return AgentCompactionUpdate::unchanged(safe_point);
            }
            self.note_durable_transcript_boundary();
        }

        let mut compacted = Vec::with_capacity(1 + retained_messages.len());
        compacted.push(summary_message);
        compacted.extend(retained_messages);
        *messages = repair_provider_transcript(compacted);
        self.replace_main_context_snapshot(messages);
        self.install_compaction_idle(None, hard_failure_key);
        self.clear_context_maintenance_paused();
        self.append_compact_debug_event(
            "compact.completed",
            json!({
                "run_id": run_id,
                "summary_message_count": 1,
                "retained_start": retained_start,
                "start_len": start_len,
                "messages_after": messages.len(),
            }),
        );

        AgentCompactionUpdate::new(remap_compacted_index(
            safe_point.current_request_start,
            retained_start,
        ))
    }
}
