use serde_json::json;

use crate::agent_loop::{AgentCommitError, InputSource, QueuedInputMetadata};
use crate::session::CompactionMetadata;
use crate::types::{ContentPart, Message};

use super::super::compaction_shared::{
    bounded_compact_diagnostic, retained_compaction_tail, INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
};
use super::super::{ContextMaintenanceStatus, ServiceInner};
use super::{usize_to_u64_saturating, PendingRecoveryRecord, PendingRecoveryRecordKind};

pub(super) struct RejectedInputContextRemoval<'a> {
    pub(super) input_id: &'a str,
    pub(super) rejected_summary_content: &'a [ContentPart],
    pub(super) retained_context_after_removal: &'a [Message],
    pub(super) source: InputSource,
    pub(super) input_metadata: Option<&'a QueuedInputMetadata>,
    pub(super) observed_input_tokens: usize,
    pub(super) hard_stop_tokens: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RejectedInputContextRemovalOutcome {
    DurableCompaction,
    DurableTombstone,
    NoDurableMarker,
}

impl RejectedInputContextRemovalOutcome {
    pub(super) fn is_replay_safe(self) -> bool {
        matches!(
            self,
            RejectedInputContextRemovalOutcome::DurableCompaction
                | RejectedInputContextRemovalOutcome::DurableTombstone
        )
    }
}

impl ServiceInner {
    pub(super) async fn record_rejected_input_context_removal(
        &self,
        removal: RejectedInputContextRemoval<'_>,
    ) -> RejectedInputContextRemovalOutcome {
        let RejectedInputContextRemoval {
            input_id,
            rejected_summary_content,
            retained_context_after_removal,
            source,
            input_metadata,
            observed_input_tokens,
            hard_stop_tokens,
        } = removal;
        let Some(recorder) = self.recorder.as_deref() else {
            return RejectedInputContextRemovalOutcome::DurableCompaction;
        };
        let retained_messages = retained_compaction_tail(retained_context_after_removal);
        let metadata = CompactionMetadata {
            source: Some("local_recovery".to_owned()),
            degraded: true,
            reason: Some(INPUT_TOO_LARGE_FOR_MODEL_WINDOW.to_owned()),
            observed_request_tokens: Some(usize_to_u64_saturating(observed_input_tokens)),
            target_usable_tokens: Some(usize_to_u64_saturating(hard_stop_tokens)),
        };
        let mut pending_record = PendingRecoveryRecord {
            kind: PendingRecoveryRecordKind::RejectedInputRemoval {
                message_id: input_id.to_owned(),
                source,
                metadata: input_metadata.cloned().map(Box::new),
                tombstone_persisted: false,
            },
            summary_content: rejected_summary_content.to_vec(),
            retained_messages: retained_messages.clone(),
            active_user_message_id: None,
            metadata: metadata.clone(),
            reason: INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
            observed_request_tokens: observed_input_tokens,
            target_usable_tokens: hard_stop_tokens,
            durable_transcript_epoch: self.current_durable_transcript_epoch(),
        };
        if let Err(error) = recorder
            .record_compaction_with_active_user_message_id_and_metadata(
                rejected_summary_content,
                &retained_messages,
                None,
                Some(&metadata),
            )
            .await
        {
            let diagnostic = bounded_compact_diagnostic(&error.to_string());
            let tombstone_persisted = self
                .record_rejected_input_removal_tombstone(&pending_record)
                .await;
            if let PendingRecoveryRecordKind::RejectedInputRemoval {
                tombstone_persisted: persisted,
                ..
            } = &mut pending_record.kind
            {
                *persisted = tombstone_persisted;
            }
            self.replace_pending_recovery_record(pending_record);
            self.set_context_maintenance_status(ContextMaintenanceStatus::degraded(
                "input_removal_session_append_failed",
                true,
                observed_input_tokens,
                hard_stop_tokens,
            ));
            self.append_compact_debug_event(
                "compact.failed",
                json!({
                    "reason": "input_removal_session_append_failed",
                    "source": "local_recovery",
                    "degraded": true,
                    "volatile": true,
                    "input_id": input_id,
                    "error": diagnostic,
                    "tombstone_persisted": tombstone_persisted,
                }),
            );
            return if tombstone_persisted {
                RejectedInputContextRemovalOutcome::DurableTombstone
            } else {
                RejectedInputContextRemovalOutcome::NoDurableMarker
            };
        }
        self.clear_any_pending_recovery_record();
        self.note_durable_transcript_boundary();
        RejectedInputContextRemovalOutcome::DurableCompaction
    }

    async fn record_rejected_input_removal_tombstone(
        &self,
        record: &PendingRecoveryRecord,
    ) -> bool {
        match self
            .record_rejected_input_removal_tombstone_result(record)
            .await
        {
            Ok(()) => true,
            Err(error) => {
                self.append_rejected_input_removal_tombstone_failed(record, &error);
                false
            }
        }
    }

    pub(super) fn append_rejected_input_removal_tombstone_failed(
        &self,
        record: &PendingRecoveryRecord,
        error: &AgentCommitError,
    ) {
        let input_id = match &record.kind {
            PendingRecoveryRecordKind::RejectedInputRemoval { message_id, .. } => {
                message_id.as_str()
            }
            PendingRecoveryRecordKind::DegradedLocalRecovery => "",
        };
        self.append_compact_debug_event(
            "compact.failed",
            json!({
                "reason": "input_removal_tombstone_append_failed",
                "source": "local_recovery",
                "degraded": true,
                "volatile": true,
                "input_id": input_id,
                "error": bounded_compact_diagnostic(&error.to_string()),
            }),
        );
    }

    pub(super) async fn record_rejected_input_removal_tombstone_result(
        &self,
        record: &PendingRecoveryRecord,
    ) -> Result<(), AgentCommitError> {
        let Some(recorder) = self.recorder.as_deref() else {
            return Ok(());
        };
        let PendingRecoveryRecordKind::RejectedInputRemoval {
            message_id,
            source,
            metadata,
            ..
        } = &record.kind
        else {
            return Ok(());
        };
        recorder
            .record_pending_input_removed(
                message_id,
                *source,
                metadata.as_deref(),
                INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
            )
            .await
    }
}
