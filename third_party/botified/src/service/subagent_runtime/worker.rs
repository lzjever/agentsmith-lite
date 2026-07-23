use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::agent_loop::FinalToolSnapshot;
#[cfg(test)]
use crate::tasks::TaskOwner;
use crate::{AgentConfig, Message, Provider};

#[cfg(test)]
use super::super::ServiceWorkerKind;
use super::super::{supervise_service_worker, ServiceInner, ServiceWorkerGuard};
use super::{run_subagent_loop_with_snapshot, terminalize_failed_subagent_run_for_current};

pub(super) struct SubagentLoopStart {
    pub(super) subagent_id: String,
    pub(super) config: AgentConfig,
    pub(super) initial_messages: Vec<Message>,
    pub(super) provider: Arc<dyn Provider>,
    pub(super) tools: Arc<FinalToolSnapshot>,
    pub(super) cancel: Arc<CancellationToken>,
    pub(super) guard: ServiceWorkerGuard,
}

#[cfg(test)]
pub(in crate::service) fn spawn_subagent_loop(
    inner: Arc<ServiceInner>,
    subagent_id: String,
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: Arc<dyn Provider>,
    tools: Arc<FinalToolSnapshot>,
    cancel: Arc<CancellationToken>,
) {
    let Some(guard) = inner.register_service_worker(ServiceWorkerKind::SubagentRun) else {
        cancel.cancel();
        let _ = inner.cancel_subagent_lifecycle(&subagent_id);
        inner
            .background_tasks
            .cancel_all_by_owner(&TaskOwner::subagent(subagent_id));
        return;
    };
    spawn_subagent_loop_with_guard(
        inner,
        SubagentLoopStart {
            subagent_id,
            config,
            initial_messages,
            provider,
            tools,
            cancel,
            guard,
        },
    );
}

pub(super) fn spawn_subagent_loop_with_guard(inner: Arc<ServiceInner>, start: SubagentLoopStart) {
    let SubagentLoopStart {
        subagent_id,
        config,
        initial_messages,
        provider,
        tools,
        cancel,
        guard,
    } = start;
    let panic_inner = inner.clone();
    let panic_subagent_id = subagent_id.clone();
    let panic_initial_messages = initial_messages.clone();
    let panic_cancel = cancel.clone();
    tokio::spawn(supervise_service_worker(
        guard,
        run_subagent_loop_with_snapshot(
            inner,
            subagent_id,
            config,
            initial_messages,
            provider,
            tools,
            cancel.as_ref().clone(),
        ),
        move |panic| async move {
            let messages = panic_inner
                .subagent_contexts
                .lock()
                .expect("subagent contexts mutex poisoned")
                .get(&panic_subagent_id)
                .cloned()
                .unwrap_or(panic_initial_messages);
            terminalize_failed_subagent_run_for_current(
                panic_inner.clone(),
                panic_subagent_id.clone(),
                format!("subagent worker panicked: {panic}"),
                messages,
                Some(panic_cancel),
            )
            .await;
        },
    ));
}
