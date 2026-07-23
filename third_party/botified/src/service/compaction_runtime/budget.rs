use super::super::compaction_shared::{
    compact_prefix_hash, terminal_local_recovery_key, CompactSlot, CompactionStartOutcome,
    DegradedLocalRecoveryContext, HardCompactFailureKey, HardCompactionContext,
    MAX_HARD_COMPACT_FAILURES,
};
use super::super::*;
use super::rejected_input::current_request_can_be_rejected_as_single_user_input;

impl ServiceInner {
    fn compact_policy_for_budget(
        &self,
        budget: &AgentProviderRequestBudget,
    ) -> crate::compact::CompactPolicy {
        let metadata = self.provider_metadata_for_budget(budget);
        metadata
            .as_ref()
            .map(crate::compact::CompactPolicy::from_provider_metadata)
            .unwrap_or_default()
    }

    fn provider_metadata_for_budget(
        &self,
        budget: &AgentProviderRequestBudget,
    ) -> Option<ProviderMetadata> {
        budget.provider_metadata.clone().or_else(|| {
            self.provider_summaries
                .lock()
                .expect("provider summaries mutex poisoned")
                .first()
                .cloned()
        })
    }

    pub(super) async fn handle_provider_request_budget(
        self: &Arc<Self>,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
        budget: AgentProviderRequestBudget,
    ) -> AgentCompactionUpdate {
        self.retry_pending_recovery_record(Some(messages)).await;
        let provider_metadata = self.provider_metadata_for_budget(&budget);
        let policy = self.compact_policy_for_budget(&budget);
        let limits = policy.limits();
        if budget.estimated_input_tokens > limits.hard_stop_tokens {
            let recovery_key = terminal_local_recovery_key(
                messages,
                provider_metadata.as_ref(),
                limits.hard_stop_tokens,
            );
            if !safe_point.recovery_attempted
                && self
                    .compact
                    .terminal_local_recovery_suppresses(&recovery_key)
            {
                return AgentCompactionUpdate::rebuild_after_recovery(
                    safe_point.current_request_start,
                );
            }
            if safe_point.recovery_attempted {
                if let Some(update) = self
                    .reject_current_input_too_large_for_model_window(
                        messages,
                        safe_point,
                        budget.estimated_input_tokens,
                        limits.hard_stop_tokens,
                    )
                    .await
                {
                    if matches!(
                        update.provider_request_action,
                        AgentProviderRequestAction::FinishCurrentRequest
                    ) {
                        self.clear_context_maintenance_paused();
                    }
                    return update;
                }
                return self
                    .as_ref()
                    .recover_oversized_active_request_for_model_window(
                        messages,
                        safe_point,
                        policy,
                        budget.estimated_input_tokens,
                        limits.hard_stop_tokens,
                    )
                    .await;
            }

            self.set_context_maintenance_paused(
                "hard_gate",
                budget.estimated_input_tokens,
                limits.hard_stop_tokens,
            );

            let before_commit = messages.clone();
            let update = self
                .try_commit_completed_compaction(messages, safe_point)
                .await;
            if *messages != before_commit {
                return AgentCompactionUpdate::rebuild_provider_request(
                    update.current_request_start.min(messages.len()),
                );
            }

            if self.compaction_failed_at_len("session_append_failed", messages.len()) {
                return self
                    .apply_degraded_local_recovery(
                        messages,
                        safe_point,
                        policy,
                        DegradedLocalRecoveryContext {
                            provider_metadata: provider_metadata.as_ref(),
                            reason: "session_append_failed",
                            observed_request_tokens: budget.estimated_input_tokens,
                            target_usable_tokens: limits.hard_stop_tokens,
                        },
                    )
                    .await;
            }

            let hard_context = self.hard_compaction_context(
                messages,
                update.current_request_start,
                policy,
                &budget,
            );
            if self.hard_compaction_requires_recovery(hard_context.as_ref()) {
                return self
                    .apply_degraded_local_recovery(
                        messages,
                        safe_point,
                        policy,
                        DegradedLocalRecoveryContext {
                            provider_metadata: provider_metadata.as_ref(),
                            reason: "compact_provider_failed",
                            observed_request_tokens: budget.estimated_input_tokens,
                            target_usable_tokens: limits.hard_stop_tokens,
                        },
                    )
                    .await;
            }

            let start_outcome = self.maybe_start_compaction(
                messages,
                update.current_request_start,
                policy,
                budget.estimated_input_tokens,
                true,
                hard_context,
            );
            match start_outcome {
                CompactionStartOutcome::Started | CompactionStartOutcome::Running => {
                    self.wait_for_compaction_gate_progress().await;
                    return AgentCompactionUpdate::rebuild_provider_request(
                        update.current_request_start.min(messages.len()),
                    );
                }
                CompactionStartOutcome::Completed => {
                    return AgentCompactionUpdate::rebuild_provider_request(
                        update.current_request_start.min(messages.len()),
                    );
                }
                CompactionStartOutcome::RecoveryRequired { reason } => {
                    if reason != "compact_no_progress"
                        && update.current_request_start == 0
                        && !current_request_can_be_rejected_as_single_user_input(
                            messages, safe_point,
                        )
                    {
                        return self
                            .as_ref()
                            .recover_oversized_active_request_for_model_window(
                                messages,
                                safe_point,
                                policy,
                                budget.estimated_input_tokens,
                                limits.hard_stop_tokens,
                            )
                            .await;
                    }
                    return self
                        .apply_degraded_local_recovery(
                            messages,
                            safe_point,
                            policy,
                            DegradedLocalRecoveryContext {
                                provider_metadata: provider_metadata.as_ref(),
                                reason,
                                observed_request_tokens: budget.estimated_input_tokens,
                                target_usable_tokens: limits.hard_stop_tokens,
                            },
                        )
                        .await;
                }
                CompactionStartOutcome::NotNeeded => {}
            }

            return AgentCompactionUpdate::new(update.current_request_start.min(messages.len()));
        }

        self.clear_context_maintenance_paused();
        let before_commit = messages.clone();
        let update = self
            .try_commit_completed_compaction(messages, safe_point)
            .await;
        if *messages != before_commit {
            return AgentCompactionUpdate::rebuild_provider_request(
                update.current_request_start.min(messages.len()),
            );
        }
        self.maybe_start_compaction(
            messages,
            update.current_request_start,
            policy,
            budget.estimated_input_tokens,
            false,
            None,
        );
        AgentCompactionUpdate::new(update.current_request_start.min(messages.len()))
    }

    fn set_context_maintenance_paused(
        &self,
        reason: &'static str,
        observed_input_tokens: usize,
        hard_stop_tokens: usize,
    ) {
        let current = self
            .state
            .lock()
            .expect("service state mutex poisoned")
            .context_maintenance
            .clone();
        let status = if current.degraded || current.volatile {
            current.with_pause(reason, observed_input_tokens, hard_stop_tokens)
        } else {
            ContextMaintenanceStatus::paused(reason, observed_input_tokens, hard_stop_tokens)
        };
        self.set_context_maintenance_status(status);
    }

    pub(super) fn clear_context_maintenance_paused(&self) {
        let current = self
            .state
            .lock()
            .expect("service state mutex poisoned")
            .context_maintenance
            .clone();
        let status = if current.degraded || current.volatile {
            current.without_pause()
        } else {
            ContextMaintenanceStatus::default()
        };
        self.set_context_maintenance_status(status);
    }
    fn hard_compaction_context(
        &self,
        messages: &[Message],
        current_request_start: usize,
        policy: crate::compact::CompactPolicy,
        budget: &AgentProviderRequestBudget,
    ) -> Option<HardCompactionContext> {
        let observed_tokens = budget
            .estimated_input_tokens
            .max(crate::compact::context_tokens(messages));
        let plan = crate::compact::maybe_plan_compaction_with_observed_tokens(
            messages,
            policy,
            observed_tokens,
        )?;
        let retained_start = plan.retained_start.min(current_request_start);
        if retained_start == 0 || retained_start >= messages.len() {
            return None;
        }
        let metadata = self.provider_metadata_for_budget(budget);
        let failure_key = HardCompactFailureKey {
            provider_profile: metadata
                .as_ref()
                .map(|metadata| metadata.profile.clone())
                .unwrap_or_else(|| "<unknown>".to_owned()),
            provider_name: metadata.as_ref().and_then(|metadata| metadata.name.clone()),
            provider_model: metadata
                .as_ref()
                .and_then(|metadata| metadata.model.clone()),
            target_usable_tokens: policy.limits().hard_stop_tokens,
            retained_start,
            start_len: messages.len(),
            prefix_hash: compact_prefix_hash(&messages[..retained_start]),
        };
        let failure_count_at_start = self.hard_failure_count_for_key(&failure_key);
        Some(HardCompactionContext {
            failure_key,
            failure_count_at_start,
            target_usable_tokens: policy.limits().hard_stop_tokens,
        })
    }

    fn hard_failure_count_for_key(&self, key: &HardCompactFailureKey) -> usize {
        let slot = self
            .compact
            .slot
            .lock()
            .expect("compact slot mutex poisoned");
        match &*slot {
            CompactSlot::Failed {
                hard_failure_key: Some(existing_key),
                hard_failure_count,
                ..
            } if existing_key == key => *hard_failure_count,
            _ => 0,
        }
    }

    fn hard_compaction_requires_recovery(&self, context: Option<&HardCompactionContext>) -> bool {
        context.is_some_and(|context| context.failure_count_at_start >= MAX_HARD_COMPACT_FAILURES)
    }

    fn compaction_failed_at_len(&self, reason: &'static str, start_len: usize) -> bool {
        let slot = self
            .compact
            .slot
            .lock()
            .expect("compact slot mutex poisoned");
        matches!(
            &*slot,
            CompactSlot::Failed {
                reason: failure_reason,
                suppressed_start_len: Some(suppressed_start_len),
                ..
            } if *failure_reason == reason && *suppressed_start_len == start_len
        )
    }
}
