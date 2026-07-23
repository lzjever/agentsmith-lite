use serde_json::json;

use crate::agent_loop::{AgentCompactionSafePoint, AgentCompactionUpdate};
use crate::session::CompactionMetadata;
use crate::transcript::repair_provider_transcript;
use crate::Message;

use super::super::compaction_shared::{
    bounded_compact_diagnostic, retained_compaction_tail, terminal_local_recovery_key,
    DegradedLocalRecoveryContext,
};
use super::super::{ContextMaintenanceStatus, ServiceInner};
use super::{usize_to_u64_saturating, PendingRecoveryRecord, PendingRecoveryRecordKind};

impl ServiceInner {
    pub(super) async fn apply_degraded_local_recovery(
        &self,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
        policy: crate::compact::CompactPolicy,
        recovery_context: DegradedLocalRecoveryContext<'_>,
    ) -> AgentCompactionUpdate {
        let DegradedLocalRecoveryContext {
            provider_metadata,
            reason,
            observed_request_tokens,
            target_usable_tokens,
        } = recovery_context;
        let recovery = crate::compact::build_degraded_local_recovery_preserving_from(
            messages,
            policy,
            safe_point.current_request_start,
        );
        let summary_content = recovery.summary_content().to_vec();
        let summary_message = recovery.summary_message();
        let retained_messages = retained_compaction_tail(recovery.retained_messages());
        let metadata = CompactionMetadata {
            source: Some("local_recovery".to_owned()),
            degraded: true,
            reason: Some(reason.to_owned()),
            observed_request_tokens: Some(usize_to_u64_saturating(observed_request_tokens)),
            target_usable_tokens: Some(usize_to_u64_saturating(target_usable_tokens)),
        };

        let retained_start = recovery.retained_start;
        let retained_tail_len = messages.len().saturating_sub(retained_start);
        let preserved_before_retained = retained_messages.len().saturating_sub(retained_tail_len);
        let remapped_request_start = if safe_point.current_request_start < retained_start {
            0
        } else {
            1 + preserved_before_retained + safe_point.current_request_start - retained_start
        };

        let mut volatile = false;
        let mut recovery_persisted = false;
        if let Some(recorder) = self.recorder.as_deref() {
            if let Err(error) = recorder
                .record_compaction_with_active_user_message_id_and_metadata(
                    &summary_content,
                    &retained_messages,
                    safe_point.active_user_message_id,
                    Some(&metadata),
                )
                .await
            {
                volatile = true;
                let diagnostic = bounded_compact_diagnostic(&error.to_string());
                self.append_compact_debug_event(
                    "compact.failed",
                    json!({
                        "reason": "local_recovery_session_append_failed",
                        "source": "local_recovery",
                        "degraded": true,
                        "volatile": true,
                        "error": diagnostic,
                    }),
                );
            } else {
                recovery_persisted = true;
            }
        }
        if recovery_persisted {
            self.note_durable_transcript_boundary();
        }
        if volatile {
            self.save_pending_recovery_record(PendingRecoveryRecord {
                kind: PendingRecoveryRecordKind::DegradedLocalRecovery,
                summary_content: summary_content.clone(),
                retained_messages: retained_messages.clone(),
                active_user_message_id: safe_point.active_user_message_id.map(ToOwned::to_owned),
                metadata: metadata.clone(),
                reason,
                observed_request_tokens,
                target_usable_tokens,
                durable_transcript_epoch: self.current_durable_transcript_epoch(),
            });
        }

        let mut recovered_messages = Vec::with_capacity(1 + retained_messages.len());
        recovered_messages.push(summary_message);
        recovered_messages.extend(retained_messages);
        *messages = repair_provider_transcript(recovered_messages);
        self.replace_main_context_snapshot(messages);
        self.compact
            .suppress_terminal_local_recovery(terminal_local_recovery_key(
                messages,
                provider_metadata,
                target_usable_tokens,
            ));
        self.install_compaction_idle(None, None);
        self.set_context_maintenance_status(ContextMaintenanceStatus::degraded(
            if volatile {
                "session_append_failed"
            } else {
                reason
            },
            volatile,
            observed_request_tokens,
            target_usable_tokens,
        ));
        self.append_compact_debug_event(
            "compact.completed",
            json!({
                "source": "local_recovery",
                "degraded": true,
                "volatile": volatile,
                "reason": reason,
                "observed_request_tokens": observed_request_tokens,
                "target_usable_tokens": target_usable_tokens,
                "retained_start": retained_start,
                "messages_after": messages.len(),
            }),
        );

        AgentCompactionUpdate::rebuild_after_recovery(remapped_request_start.min(messages.len()))
    }
}
