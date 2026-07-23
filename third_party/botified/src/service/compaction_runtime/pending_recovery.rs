use serde_json::json;

use crate::agent_loop::{InputSource, QueuedInputMetadata};
use crate::session::CompactionMetadata;
use crate::types::{ContentPart, Message};

use super::super::compaction_shared::{bounded_compact_diagnostic, retained_compaction_tail};
use super::super::{ContextMaintenanceStatus, ServiceInner, ServiceInnerState};

#[derive(Debug, Clone, PartialEq)]
pub(in crate::service) struct PendingRecoveryRecord {
    pub(in crate::service) kind: PendingRecoveryRecordKind,
    pub(super) summary_content: Vec<ContentPart>,
    pub(super) retained_messages: Vec<Message>,
    pub(super) active_user_message_id: Option<String>,
    pub(super) metadata: CompactionMetadata,
    pub(in crate::service) reason: &'static str,
    pub(super) observed_request_tokens: usize,
    pub(super) target_usable_tokens: usize,
    pub(super) durable_transcript_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::service) enum PendingRecoveryRecordKind {
    DegradedLocalRecovery,
    RejectedInputRemoval {
        message_id: String,
        source: InputSource,
        metadata: Option<Box<QueuedInputMetadata>>,
        tombstone_persisted: bool,
    },
}

fn refresh_rejected_input_removal_recovery_record(
    record: &PendingRecoveryRecord,
    current_messages: &[Message],
    durable_transcript_epoch: u64,
) -> Option<PendingRecoveryRecord> {
    let Some(Message::User { content }) = current_messages.first() else {
        return None;
    };
    Some(PendingRecoveryRecord {
        kind: record.kind.clone(),
        summary_content: content.clone(),
        retained_messages: retained_compaction_tail(&current_messages[1..]),
        active_user_message_id: None,
        metadata: record.metadata.clone(),
        reason: record.reason,
        observed_request_tokens: record.observed_request_tokens,
        target_usable_tokens: record.target_usable_tokens,
        durable_transcript_epoch,
    })
}

fn expire_stale_degraded_recovery_record(state: &mut ServiceInnerState) {
    if state
        .pending_recovery_record
        .as_ref()
        .is_some_and(|record| {
            matches!(
                record.kind,
                PendingRecoveryRecordKind::DegradedLocalRecovery
            ) && record.durable_transcript_epoch != state.durable_transcript_epoch
        })
    {
        state.pending_recovery_record = None;
    }
}

impl ServiceInner {
    pub(super) async fn retry_pending_recovery_record(
        &self,
        current_messages: Option<&[Message]>,
    ) -> bool {
        let pending_record = self.pending_recovery_record_for_retry(current_messages);
        let Some(record) = pending_record else {
            return false;
        };

        let Some(recorder) = self.recorder.as_deref() else {
            self.clear_pending_recovery_record(&record);
            return false;
        };

        match recorder
            .record_compaction_with_active_user_message_id_and_metadata(
                &record.summary_content,
                &record.retained_messages,
                record.active_user_message_id.as_deref(),
                Some(&record.metadata),
            )
            .await
        {
            Ok(()) => {
                let cleared = self.clear_pending_recovery_record(&record);
                if cleared {
                    self.note_durable_transcript_boundary();
                    self.set_context_maintenance_status(ContextMaintenanceStatus::degraded(
                        record.reason,
                        false,
                        record.observed_request_tokens,
                        record.target_usable_tokens,
                    ));
                    self.append_compact_debug_event(
                        "compact.completed",
                        json!({
                            "source": "local_recovery",
                            "degraded": true,
                            "volatile": false,
                            "reason": record.reason,
                            "pending_retry": true,
                        }),
                    );
                }
                cleared
            }
            Err(error) => {
                let diagnostic = bounded_compact_diagnostic(&error.to_string());
                self.append_compact_debug_event(
                    "compact.failed",
                    json!({
                        "reason": "pending_local_recovery_session_append_failed",
                        "source": "local_recovery",
                        "degraded": true,
                        "volatile": true,
                        "error": diagnostic,
                    }),
                );
                false
            }
        }
    }

    fn pending_recovery_record_for_retry(
        &self,
        current_messages: Option<&[Message]>,
    ) -> Option<PendingRecoveryRecord> {
        let mut state = self.state.lock().expect("service state mutex poisoned");
        let record = state.pending_recovery_record.clone()?;
        if record.durable_transcript_epoch == state.durable_transcript_epoch {
            return Some(record);
        }

        match &record.kind {
            PendingRecoveryRecordKind::DegradedLocalRecovery => {
                state.pending_recovery_record = None;
                None
            }
            PendingRecoveryRecordKind::RejectedInputRemoval { .. } => {
                let refreshed = refresh_rejected_input_removal_recovery_record(
                    &record,
                    current_messages?,
                    state.durable_transcript_epoch,
                )?;
                state.pending_recovery_record = Some(refreshed.clone());
                Some(refreshed)
            }
        }
    }

    pub(super) fn save_pending_recovery_record(&self, record: PendingRecoveryRecord) {
        let mut state = self.state.lock().expect("service state mutex poisoned");
        if state.pending_recovery_record.is_none() {
            state.pending_recovery_record = Some(record);
        }
    }

    pub(super) fn replace_pending_recovery_record(&self, record: PendingRecoveryRecord) {
        self.state
            .lock()
            .expect("service state mutex poisoned")
            .pending_recovery_record = Some(record);
    }

    pub(super) fn clear_any_pending_recovery_record(&self) {
        self.state
            .lock()
            .expect("service state mutex poisoned")
            .pending_recovery_record = None;
    }

    fn clear_pending_recovery_record(&self, record: &PendingRecoveryRecord) -> bool {
        let mut state = self.state.lock().expect("service state mutex poisoned");
        if state
            .pending_recovery_record
            .as_ref()
            .is_some_and(|pending| pending == record)
        {
            state.pending_recovery_record = None;
            return true;
        }
        false
    }

    pub(super) fn mark_rejected_input_removal_tombstone_persisted(
        &self,
        record: &PendingRecoveryRecord,
    ) -> bool {
        let mut state = self.state.lock().expect("service state mutex poisoned");
        let Some(pending) = state.pending_recovery_record.as_mut() else {
            return false;
        };
        if pending != record {
            return false;
        }
        if let PendingRecoveryRecordKind::RejectedInputRemoval {
            tombstone_persisted,
            ..
        } = &mut pending.kind
        {
            *tombstone_persisted = true;
            return true;
        }
        false
    }

    pub(super) fn current_durable_transcript_epoch(&self) -> u64 {
        self.state
            .lock()
            .expect("service state mutex poisoned")
            .durable_transcript_epoch
    }

    pub(in crate::service) fn note_durable_transcript_boundary(&self) {
        let mut state = self.state.lock().expect("service state mutex poisoned");
        state.durable_transcript_epoch = state.durable_transcript_epoch.saturating_add(1);
        expire_stale_degraded_recovery_record(&mut state);
    }
}
