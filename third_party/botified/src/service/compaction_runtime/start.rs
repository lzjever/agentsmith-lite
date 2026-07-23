use std::sync::{atomic::Ordering, Arc};

use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::types::Message;

use super::super::compaction_shared::{
    provider_compact_request_hard_stop_tokens, successful_hard_compaction_made_no_progress,
    CompactSlot, CompactionStartOutcome, HardCompactionContext, MAX_HARD_COMPACT_FAILURES,
};
use super::super::ServiceInner;
use super::spawn_compaction_provider_call;

impl ServiceInner {
    pub(super) fn maybe_start_compaction(
        self: &Arc<Self>,
        messages: &[Message],
        current_request_start: usize,
        policy: crate::compact::CompactPolicy,
        estimated_input_tokens: usize,
        hard_gate: bool,
        hard_context: Option<HardCompactionContext>,
    ) -> CompactionStartOutcome {
        let (tokens_before, retained_start, start_len) =
            match crate::compact::decide_compaction_start(
                messages,
                policy,
                current_request_start,
                estimated_input_tokens,
                hard_gate,
            ) {
                crate::compact::CompactStartDecision::NotNeeded => {
                    return CompactionStartOutcome::NotNeeded;
                }
                crate::compact::CompactStartDecision::RecoveryRequired { reason } => {
                    return CompactionStartOutcome::RecoveryRequired { reason };
                }
                crate::compact::CompactStartDecision::Candidate {
                    tokens_before,
                    retained_start,
                    start_len,
                } => (tokens_before, retained_start, start_len),
            };
        if !hard_gate {
            let slot = self
                .compact
                .slot
                .lock()
                .expect("compact slot mutex poisoned");
            match &*slot {
                CompactSlot::Idle {
                    suppressed_start_len,
                    ..
                } => {
                    if *suppressed_start_len == Some(start_len) {
                        return CompactionStartOutcome::NotNeeded;
                    }
                }
                CompactSlot::Failed {
                    reason,
                    diagnostic,
                    suppressed_start_len,
                    ..
                } => {
                    let _ = reason.len();
                    let _ = diagnostic.len();
                    if *suppressed_start_len == Some(start_len) {
                        return CompactionStartOutcome::NotNeeded;
                    }
                }
                CompactSlot::Running { .. } => return CompactionStartOutcome::Running,
                CompactSlot::Completed { .. } => return CompactionStartOutcome::Completed,
            }
        }

        if let Some(context) = hard_context.as_ref() {
            if context.failure_count_at_start >= MAX_HARD_COMPACT_FAILURES {
                return CompactionStartOutcome::RecoveryRequired {
                    reason: "compact_provider_failed",
                };
            }
            let slot = self
                .compact
                .slot
                .lock()
                .expect("compact slot mutex poisoned");
            if successful_hard_compaction_made_no_progress(&slot, &context.failure_key) {
                return CompactionStartOutcome::RecoveryRequired {
                    reason: "compact_no_progress",
                };
            }
            drop(slot);
            let compact_request = crate::compact::build_compaction_request_with_file_store(
                self.config.system_prompt.clone(),
                &messages[..retained_start],
                self.file_store.as_ref(),
            );
            let compact_request_tokens =
                crate::compact::estimate_provider_request_input_tokens(&compact_request);
            let compact_request_limit_tokens =
                provider_compact_request_hard_stop_tokens(self.provider.as_ref(), &compact_request)
                    .unwrap_or(context.target_usable_tokens);
            if compact_request_tokens > compact_request_limit_tokens {
                self.install_compaction_failure(
                    "compact_request_hard_gate",
                    format!(
                        "compaction request input estimate {compact_request_tokens} exceeds hard context limit {}",
                        compact_request_limit_tokens
                    ),
                    Some(start_len),
                    None,
                    0,
                );
                self.append_compact_debug_event(
                    "compact.failed",
                    json!({
                        "reason": "compact_request_hard_gate",
                        "compact_request_tokens": compact_request_tokens,
                        "hard_stop_tokens": compact_request_limit_tokens,
                    }),
                );
                return CompactionStartOutcome::RecoveryRequired {
                    reason: "compact_request_hard_gate",
                };
            }
        }

        let run_id = self.compact.next_run_id.fetch_add(1, Ordering::SeqCst);
        let messages_at_start = messages.to_vec();
        let cancel = CancellationToken::new();
        {
            let mut slot = self
                .compact
                .slot
                .lock()
                .expect("compact slot mutex poisoned");
            match &*slot {
                CompactSlot::Idle {
                    suppressed_start_len,
                    ..
                } if !hard_gate && *suppressed_start_len == Some(start_len) => {
                    return CompactionStartOutcome::NotNeeded;
                }
                CompactSlot::Failed {
                    suppressed_start_len,
                    ..
                } if !hard_gate && *suppressed_start_len == Some(start_len) => {
                    return CompactionStartOutcome::NotNeeded;
                }
                CompactSlot::Idle { .. } => {
                    *slot = CompactSlot::Running {
                        run_id,
                        messages_at_start: messages_at_start.clone(),
                        retained_start,
                        start_len,
                        cancel: cancel.clone(),
                        hard_failure_key: hard_context
                            .as_ref()
                            .map(|context| context.failure_key.clone()),
                        hard_failure_count_at_start: hard_context
                            .as_ref()
                            .map(|context| context.failure_count_at_start)
                            .unwrap_or(0),
                    };
                }
                CompactSlot::Failed {
                    hard_failure_key,
                    hard_failure_count,
                    ..
                } => {
                    let failure_count_at_start = hard_context
                        .as_ref()
                        .map(|context| {
                            if hard_failure_key.as_ref() == Some(&context.failure_key) {
                                *hard_failure_count
                            } else {
                                0
                            }
                        })
                        .unwrap_or(0);
                    *slot = CompactSlot::Running {
                        run_id,
                        messages_at_start: messages_at_start.clone(),
                        retained_start,
                        start_len,
                        cancel: cancel.clone(),
                        hard_failure_key: hard_context
                            .as_ref()
                            .map(|context| context.failure_key.clone()),
                        hard_failure_count_at_start: failure_count_at_start,
                    };
                }
                CompactSlot::Running { .. } => return CompactionStartOutcome::Running,
                CompactSlot::Completed { .. } => return CompactionStartOutcome::Completed,
            }
        }

        self.append_compact_debug_event(
            "compact.started",
            json!({
                "run_id": run_id,
                "start_len": start_len,
                "retained_start": retained_start,
                "tokens_before": tokens_before,
            }),
        );
        spawn_compaction_provider_call(
            self.clone(),
            run_id,
            messages_at_start[..retained_start].to_vec(),
            cancel,
        );
        CompactionStartOutcome::Started
    }
}
