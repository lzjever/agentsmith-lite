use super::compaction_shared::{
    bounded_compact_diagnostic, compact_prefix_hash, provider_compact_request_hard_stop_tokens,
    remap_compacted_index, retained_compaction_tail, successful_hard_compaction_made_no_progress,
    terminal_local_recovery_key, CompactCoordinator, CompactSlot, CompactionStartOutcome,
    DegradedLocalRecoveryContext, HardCompactFailureKey, HardCompactionContext,
    INPUT_TOO_LARGE_FOR_MODEL_WINDOW, MAX_HARD_COMPACT_FAILURES,
};
use super::*;

pub(super) struct SubagentCompactionHook {
    pub(super) runtime: Arc<SubagentCompactionRuntime>,
}

impl SubagentCompactionHook {
    pub(super) fn new(
        inner: Weak<ServiceInner>,
        subagent_id: String,
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        file_store: Option<FileStore>,
        parent_cancel: CancellationToken,
    ) -> Self {
        Self {
            runtime: Arc::new(SubagentCompactionRuntime {
                inner,
                subagent_id,
                compact: CompactCoordinator::default(),
                notify: Notify::new(),
                provider,
                config,
                file_store,
                parent_cancel,
                diagnostics: Mutex::new(Vec::new()),
            }),
        }
    }

    pub(super) fn cancel_running(&self) {
        self.runtime.cancel_compaction_run();
    }
}

#[async_trait]
impl AgentCompactionHook for SubagentCompactionHook {
    async fn on_agent_safe_point(
        &self,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
    ) -> AgentCompactionUpdate {
        let mut update = self
            .runtime
            .try_commit_completed_compaction(messages, safe_point)
            .await;
        update.current_request_start = update.current_request_start.min(messages.len());
        update
    }

    async fn on_provider_request_ready(
        &self,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
        budget: AgentProviderRequestBudget,
    ) -> AgentCompactionUpdate {
        self.runtime
            .handle_provider_request_budget(messages, safe_point, budget)
            .await
    }
}

pub(super) struct SubagentCompactionRuntime {
    inner: Weak<ServiceInner>,
    subagent_id: String,
    pub(super) compact: CompactCoordinator,
    pub(super) notify: Notify,
    provider: Arc<dyn Provider>,
    config: AgentConfig,
    file_store: Option<FileStore>,
    parent_cancel: CancellationToken,
    diagnostics: Mutex<Vec<String>>,
}

impl SubagentCompactionRuntime {
    fn record_context_snapshot(&self, messages: &[Message]) {
        if let Some(inner) = self.inner.upgrade() {
            inner.update_subagent_context_if_open(&self.subagent_id, |context| {
                *context = messages.to_vec();
            });
        }
    }

    async fn handle_provider_request_budget(
        self: &Arc<Self>,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
        budget: AgentProviderRequestBudget,
    ) -> AgentCompactionUpdate {
        let policy = budget
            .provider_metadata
            .as_ref()
            .map(crate::compact::CompactPolicy::from_provider_metadata)
            .unwrap_or_default();
        let limits = policy.limits();
        if budget.estimated_input_tokens > limits.hard_stop_tokens {
            let recovery_key = terminal_local_recovery_key(
                messages,
                budget.provider_metadata.as_ref(),
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
                self.push_diagnostic(
                    "compact.failed",
                    json!({
                        "reason": INPUT_TOO_LARGE_FOR_MODEL_WINDOW,
                        "observed_input_tokens": budget.estimated_input_tokens,
                        "hard_stop_tokens": limits.hard_stop_tokens,
                    }),
                );
                return AgentCompactionUpdate::new(safe_point.current_request_start);
            }

            let before_commit = messages.clone();
            let update = self
                .try_commit_completed_compaction(messages, safe_point)
                .await;
            if *messages != before_commit {
                return AgentCompactionUpdate::rebuild_provider_request(
                    update.current_request_start.min(messages.len()),
                );
            }

            let hard_context = self.hard_compaction_context(
                messages,
                update.current_request_start,
                policy,
                &budget,
            );
            if self.hard_compaction_requires_recovery(hard_context.as_ref()) {
                return self.apply_degraded_local_recovery(
                    messages,
                    safe_point,
                    policy,
                    DegradedLocalRecoveryContext {
                        provider_metadata: budget.provider_metadata.as_ref(),
                        reason: "compact_provider_failed",
                        observed_request_tokens: budget.estimated_input_tokens,
                        target_usable_tokens: limits.hard_stop_tokens,
                    },
                );
            }

            let notified = self.notify.notified();
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
                    notified.await;
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
                    return self.apply_degraded_local_recovery(
                        messages,
                        safe_point,
                        policy,
                        DegradedLocalRecoveryContext {
                            provider_metadata: budget.provider_metadata.as_ref(),
                            reason,
                            observed_request_tokens: budget.estimated_input_tokens,
                            target_usable_tokens: limits.hard_stop_tokens,
                        },
                    );
                }
                CompactionStartOutcome::NotNeeded => {}
            }

            return AgentCompactionUpdate::new(update.current_request_start.min(messages.len()));
        }

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
        let metadata = budget.provider_metadata.as_ref();
        let failure_key = HardCompactFailureKey {
            provider_profile: metadata
                .map(|metadata| metadata.profile.clone())
                .unwrap_or_else(|| "<unknown>".to_owned()),
            provider_name: metadata.and_then(|metadata| metadata.name.clone()),
            provider_model: metadata.and_then(|metadata| metadata.model.clone()),
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
            .expect("subagent compact slot mutex poisoned");
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

    fn apply_degraded_local_recovery(
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
        let summary_message = recovery.summary_message();
        let retained_messages = retained_compaction_tail(recovery.retained_messages());
        let retained_start = recovery.retained_start;
        let retained_tail_len = messages.len().saturating_sub(retained_start);
        let preserved_before_retained = retained_messages.len().saturating_sub(retained_tail_len);
        let remapped_request_start = if safe_point.current_request_start < retained_start {
            0
        } else {
            1 + preserved_before_retained + safe_point.current_request_start - retained_start
        };

        let mut recovered_messages = Vec::with_capacity(1 + retained_messages.len());
        recovered_messages.push(summary_message);
        recovered_messages.extend(retained_messages);
        *messages = repair_provider_transcript(recovered_messages);
        self.record_context_snapshot(messages);
        self.compact
            .suppress_terminal_local_recovery(terminal_local_recovery_key(
                messages,
                provider_metadata,
                target_usable_tokens,
            ));
        self.install_compaction_idle(None, None);
        self.push_diagnostic(
            "compact.completed",
            json!({
                "source": "local_recovery",
                "degraded": true,
                "reason": reason,
                "observed_request_tokens": observed_request_tokens,
                "target_usable_tokens": target_usable_tokens,
                "retained_start": retained_start,
                "messages_after": messages.len(),
            }),
        );

        AgentCompactionUpdate::rebuild_after_recovery(remapped_request_start.min(messages.len()))
    }

    async fn try_commit_completed_compaction(
        &self,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
    ) -> AgentCompactionUpdate {
        let completed = {
            let mut slot = self
                .compact
                .slot
                .lock()
                .expect("subagent compact slot mutex poisoned");
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
                self.push_diagnostic(
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
            self.push_diagnostic(
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
        let mut compacted = Vec::with_capacity(1 + retained_messages.len());
        compacted.push(summary_message);
        compacted.extend(retained_messages);
        *messages = repair_provider_transcript(compacted);
        self.record_context_snapshot(messages);
        self.install_compaction_idle(None, hard_failure_key);
        self.push_diagnostic(
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

    fn maybe_start_compaction(
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
                .expect("subagent compact slot mutex poisoned");
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
                    suppressed_start_len,
                    ..
                } => {
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
                .expect("subagent compact slot mutex poisoned");
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
                self.push_diagnostic(
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
        let cancel = self.parent_cancel.child_token();
        {
            let mut slot = self
                .compact
                .slot
                .lock()
                .expect("subagent compact slot mutex poisoned");
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

        self.push_diagnostic(
            "compact.started",
            json!({
                "run_id": run_id,
                "start_len": start_len,
                "retained_start": retained_start,
                "tokens_before": tokens_before,
            }),
        );
        self.clone().spawn_compaction_provider_call(
            run_id,
            messages_at_start[..retained_start].to_vec(),
            cancel,
        );
        CompactionStartOutcome::Started
    }

    pub(super) fn spawn_compaction_provider_call(
        self: Arc<Self>,
        run_id: u64,
        summary_source: Vec<Message>,
        cancel: CancellationToken,
    ) {
        let Some(guard) = self.inner.upgrade().and_then(|inner| {
            inner.register_service_worker(ServiceWorkerKind::BackgroundCompletion)
        }) else {
            cancel.cancel();
            self.finish_compaction_run(
                run_id,
                Err("service stopped before subagent compaction could start".to_owned()),
            );
            return;
        };
        let provider = self.provider.clone();
        let config = self.config.clone();
        let file_store = self.file_store.clone();
        let worker_runtime = self.clone();
        let panic_runtime = self;
        let worker = async move {
            let mut request = crate::compact::build_compaction_request_with_file_store(
                config.system_prompt.clone(),
                &summary_source,
                file_store.as_ref(),
            );
            request.set_profiling_context(ProviderProfilingContext {
                session: config.session.clone(),
                turn_id: None,
                cycle_id: None,
                provider_call_index: usize::try_from(run_id).unwrap_or(usize::MAX),
                request_kind: "compaction".to_owned(),
                input_message_count: summary_source.len(),
                message_count: request.input.len(),
                tool_spec_count: request.tools.len(),
            });

            let summary_result = if cancel.is_cancelled() {
                Err("compaction request cancelled".to_owned())
            } else {
                match crate::provider::complete_with_cancellation(
                    provider.as_ref(),
                    request,
                    cancel.clone(),
                )
                .await
                {
                    Err(crate::provider::ProviderCompletionError::Cancelled) => {
                        Err("compaction request cancelled".to_owned())
                    }
                    Ok(response) if cancel.is_cancelled() => {
                        let _ = response;
                        Err("compaction request cancelled".to_owned())
                    }
                    Ok(response) => crate::compact::response_summary(response),
                    Err(crate::provider::ProviderCompletionError::Provider(error)) => {
                        Err(error.to_string())
                    }
                }
            };
            worker_runtime.finish_compaction_run(run_id, summary_result);
        };
        tokio::spawn(supervise_service_worker(
            guard,
            worker,
            move |panic| async move {
                panic_runtime.finish_compaction_run(
                    run_id,
                    Err(format!("compaction provider worker panicked: {panic}")),
                );
            },
        ));
    }

    fn finish_compaction_run(&self, run_id: u64, summary_result: Result<String, String>) {
        let mut slot = self
            .compact
            .slot
            .lock()
            .expect("subagent compact slot mutex poisoned");
        let previous = std::mem::replace(
            &mut *slot,
            CompactSlot::Idle {
                suppressed_start_len: None,
                last_successful_hard_key: None,
            },
        );
        match previous {
            CompactSlot::Running {
                run_id: running_id,
                messages_at_start,
                retained_start,
                start_len,
                hard_failure_key,
                hard_failure_count_at_start,
                ..
            } if running_id == run_id => {
                *slot = CompactSlot::Completed {
                    run_id,
                    messages_at_start,
                    retained_start,
                    start_len,
                    summary_result,
                    hard_failure_key,
                    hard_failure_count_at_start,
                };
            }
            other => {
                *slot = other;
            }
        }
        self.notify.notify_waiters();
    }

    fn install_compaction_idle(
        &self,
        suppressed_start_len: Option<usize>,
        last_successful_hard_key: Option<HardCompactFailureKey>,
    ) {
        *self
            .compact
            .slot
            .lock()
            .expect("subagent compact slot mutex poisoned") = CompactSlot::Idle {
            suppressed_start_len,
            last_successful_hard_key,
        };
    }

    fn install_compaction_failure(
        &self,
        reason: &'static str,
        diagnostic: String,
        suppressed_start_len: Option<usize>,
        hard_failure_key: Option<HardCompactFailureKey>,
        hard_failure_count: usize,
    ) {
        *self
            .compact
            .slot
            .lock()
            .expect("subagent compact slot mutex poisoned") = CompactSlot::Failed {
            reason,
            diagnostic,
            suppressed_start_len,
            hard_failure_key,
            hard_failure_count,
        };
    }

    fn cancel_compaction_run(&self) {
        let slot = self
            .compact
            .slot
            .lock()
            .expect("subagent compact slot mutex poisoned");
        if let CompactSlot::Running { cancel, .. } = &*slot {
            cancel.cancel();
        }
    }

    fn push_diagnostic(&self, event_type: &'static str, data: Value) {
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("subagent compact diagnostics mutex poisoned");
        if diagnostics.len() >= 16 {
            diagnostics.remove(0);
        }
        diagnostics.push(format!(
            "subagent_id={} event_type={} data={}",
            self.subagent_id, event_type, data
        ));
    }
}
