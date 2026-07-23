use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::agent_loop::{
    run_agent_with_shared_event_log_and_compaction_hook, AgentRunErrorKind, FinalToolSnapshot,
    SharedAgentRunOptions,
};
use crate::subagents::SubagentManagerError;
use crate::tasks::TaskOwner;
#[cfg(test)]
use crate::Tool;
use crate::{repair_provider_transcript, AgentConfig, Message, Provider};

use super::super::subagent_compaction::SubagentCompactionHook;
use super::super::task_runtime::ServiceBackgroundExecutionHost;
use super::super::{ServiceInner, ServiceWorkerGuard};
use super::bootstrap::push_subagent_user_message_locked;
use super::context::SubagentContextRecorder;
use super::enqueue_subagent_callback;
use super::launch::PreparedSubagentRun;
use super::terminal::{subagent_result_text, SubagentRunTerminal};
use super::SubagentEventAppendOutcome;
#[cfg(test)]
use super::SubagentTestHookKind;

#[cfg(test)]
pub(in crate::service) async fn run_subagent_loop(
    inner: Arc<ServiceInner>,
    subagent_id: String,
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: Arc<dyn Provider>,
    tools: Vec<Arc<dyn Tool>>,
    cancel: CancellationToken,
) {
    let tools = match FinalToolSnapshot::build(tools, &config.tool_execution) {
        Ok(snapshot) => Arc::new(snapshot),
        Err(error) => {
            inner.transition_to_failed(
                format!("invalid subagent tool configuration: {error}"),
                |_| {},
            );
            return;
        }
    };
    run_subagent_loop_with_snapshot(
        inner,
        subagent_id,
        config,
        initial_messages,
        provider,
        tools,
        cancel,
    )
    .await;
}

pub(super) async fn run_subagent_loop_with_snapshot(
    inner: Arc<ServiceInner>,
    subagent_id: String,
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: Arc<dyn Provider>,
    tools: Arc<FinalToolSnapshot>,
    cancel: CancellationToken,
) {
    let compaction_hook = SubagentCompactionHook::new(
        Arc::downgrade(&inner),
        subagent_id.clone(),
        config.clone(),
        provider.clone(),
        inner.file_store.clone(),
        cancel.clone(),
    );
    let context_recorder = SubagentContextRecorder {
        inner: inner.clone(),
        subagent_id: subagent_id.clone(),
    };
    let result = run_agent_with_shared_event_log_and_compaction_hook(
        config,
        repair_provider_transcript(initial_messages),
        provider.as_ref(),
        tools,
        SharedAgentRunOptions {
            input_drainer: None,
            context_recorder: Some(&context_recorder),
            initial_current_request_start: None,
            initial_active_user_message_id: None,
            initial_active_input_ids: Vec::new(),
            initial_known_user_messages: Vec::new(),
            cancel,
            event_log: None,
            event_appender: None,
            event_notify: None,
            event_observer: None,
            background_host: Some(Arc::new(ServiceBackgroundExecutionHost {
                inner: inner.clone(),
                owner: TaskOwner::subagent(subagent_id.clone()),
            })),
            profiler: inner.profiler(),
            file_store: inner.file_store.clone(),
            preview_sink: None,
        },
        Some(&compaction_hook),
    )
    .await;
    compaction_hook.cancel_running();

    inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .remove(&subagent_id);

    if inner.is_failed() {
        match result {
            Ok(result) => {
                let messages = repair_provider_transcript(result.messages);
                let result_text = subagent_result_text(&messages);
                let _ = inner.finish_subagent_run_with_context(
                    &subagent_id,
                    SubagentRunTerminal::Completed(result_text),
                    messages,
                );
            }
            Err(error) if error.kind == AgentRunErrorKind::Cancelled => {
                if let Ok((_, _, Some(cancel))) = inner.cancel_subagent_lifecycle(&subagent_id) {
                    cancel.cancel();
                }
                inner
                    .background_tasks
                    .cancel_all_by_owner(&TaskOwner::subagent(subagent_id));
            }
            Err(error) => {
                let error_message = error.to_string();
                let messages = repair_provider_transcript(error.messages);
                let _ = inner.finish_subagent_run_with_context(
                    &subagent_id,
                    SubagentRunTerminal::Failed(error_message),
                    messages,
                );
            }
        }
        return;
    }

    match result {
        Ok(result) => {
            let messages = repair_provider_transcript(result.messages);
            let result_text = subagent_result_text(&messages);
            #[cfg(test)]
            inner.run_subagent_test_hook(SubagentTestHookKind::TerminalBeforeContextStore);
            let snapshot = match inner.finish_subagent_run_with_context(
                &subagent_id,
                SubagentRunTerminal::Completed(result_text),
                messages,
            ) {
                Ok(snapshot) => snapshot,
                Err(SubagentManagerError::Cancelled { .. }) => return,
                Err(_) => return,
            };
            #[cfg(test)]
            inner.run_subagent_test_hook(SubagentTestHookKind::TerminalStateBeforeAppend);
            let Some(snapshot) =
                inner.append_subagent_event_if_current_open("subagent.completed", &snapshot)
            else {
                return;
            };
            enqueue_subagent_callback(inner.clone(), &snapshot, "completed").await;
            maybe_start_next_subagent_run(inner, subagent_id);
        }
        Err(error) if error.kind == AgentRunErrorKind::Cancelled => {
            let Ok((snapshot, already_cancelled, cancel)) =
                inner.cancel_subagent_lifecycle(&subagent_id)
            else {
                return;
            };
            if let Some(cancel) = cancel {
                cancel.cancel();
            }
            inner
                .background_tasks
                .cancel_all_by_owner(&TaskOwner::subagent(subagent_id.clone()));
            if !already_cancelled {
                inner.append_subagent_event("subagent.cancelled", &snapshot);
            }
        }
        Err(error) if matches!(error.kind, AgentRunErrorKind::Configuration { .. }) => {
            let error_message = error.to_string();
            let messages = repair_provider_transcript(error.messages);
            let snapshot = match inner.finish_subagent_run_with_context(
                &subagent_id,
                SubagentRunTerminal::Failed(error_message),
                messages,
            ) {
                Ok(snapshot) => snapshot,
                Err(SubagentManagerError::Cancelled { .. }) => return,
                Err(_) => return,
            };
            let Some(snapshot) =
                inner.append_subagent_event_if_current_open("subagent.failed", &snapshot)
            else {
                return;
            };
            enqueue_subagent_callback(inner, &snapshot, "failed").await;
        }
        Err(error) => {
            let error_message = error.to_string();
            let messages = repair_provider_transcript(error.messages);
            terminalize_failed_subagent_run(inner, subagent_id, error_message, messages).await;
        }
    }
}

pub(in crate::service) async fn terminalize_failed_subagent_run(
    inner: Arc<ServiceInner>,
    subagent_id: String,
    error_message: String,
    messages: Vec<Message>,
) {
    terminalize_failed_subagent_run_for_current(inner, subagent_id, error_message, messages, None)
        .await;
}

pub(in crate::service) async fn terminalize_failed_subagent_run_for_current(
    inner: Arc<ServiceInner>,
    subagent_id: String,
    error_message: String,
    messages: Vec<Message>,
    expected_cancel: Option<Arc<CancellationToken>>,
) {
    #[cfg(test)]
    inner.run_subagent_test_hook(SubagentTestHookKind::TerminalBeforeContextStore);
    #[cfg(test)]
    inner.run_subagent_test_hook(SubagentTestHookKind::TerminalStateBeforeAppend);
    let Some(snapshot) = inner.fail_subagent_run_and_append_if_current(
        &subagent_id,
        &error_message,
        messages,
        expected_cancel.as_ref(),
    ) else {
        return;
    };
    enqueue_subagent_callback(inner.clone(), &snapshot, "failed").await;
    if inner.is_failed_or_shutting_down() {
        return;
    }
    maybe_start_next_subagent_run(inner, subagent_id);
}

impl ServiceInner {
    fn prepare_next_subagent_run_and_append_start(
        self: &Arc<Self>,
        subagent_id: &str,
    ) -> Option<(
        PreparedSubagentRun,
        SubagentEventAppendOutcome,
        ServiceWorkerGuard,
    )> {
        let admitted = self
            .admit_subagent_start(|| {
                let mut manager = self
                    .subagents
                    .lock()
                    .expect("subagent manager mutex poisoned");
                let Some(current) = manager.snapshot(subagent_id) else {
                    return Ok::<_, ()>((None, None));
                };
                if current.queued_message_count == 0 {
                    return Ok((None, None));
                }
                let mut contexts = self
                    .subagent_contexts
                    .lock()
                    .expect("subagent contexts mutex poisoned");
                let Some(provider) = self
                    .subagent_providers
                    .lock()
                    .expect("subagent providers mutex poisoned")
                    .get(subagent_id)
                    .cloned()
                else {
                    return Ok((None, None));
                };
                let Some((snapshot, message)) =
                    manager.start_next_queued(subagent_id).ok().flatten()
                else {
                    return Ok((None, None));
                };
                drop(manager);
                let messages =
                    push_subagent_user_message_locked(&mut contexts, subagent_id, &message);
                let cancel = Arc::new(CancellationToken::new());
                self.subagent_cancels
                    .lock()
                    .expect("subagent cancels mutex poisoned")
                    .insert(subagent_id.to_owned(), cancel.clone());
                let prepared = PreparedSubagentRun {
                    subagent_id: subagent_id.to_owned(),
                    snapshot: snapshot.clone(),
                    messages,
                    provider,
                    cancel,
                };
                Ok((Some(prepared), Some(snapshot)))
            })
            .ok()??;
        let (prepared, started) = admitted;
        let prepared = prepared?;
        let (append, worker_guard) = started?;
        Some((prepared, append, worker_guard))
    }
}

pub(in crate::service) fn maybe_start_next_subagent_run(
    inner: Arc<ServiceInner>,
    subagent_id: String,
) {
    #[cfg(test)]
    inner.run_subagent_test_hook(SubagentTestHookKind::QueuedRunProviderClone);
    #[cfg(test)]
    inner.run_subagent_test_hook(SubagentTestHookKind::QueuedRunStateBeforeAppend);
    let Some((prepared, append, worker_guard)) =
        inner.prepare_next_subagent_run_and_append_start(&subagent_id)
    else {
        return;
    };
    if !append.complete() {
        inner.fail_prepared_subagent_run_after_start_persistence_failure(
            prepared,
            append.event_written,
        );
        return;
    }
    inner.spawn_prepared_subagent_run(prepared, worker_guard);
}
