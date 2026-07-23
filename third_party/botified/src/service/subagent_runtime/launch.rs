use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::agent_loop::FinalToolSnapshot;
use crate::provider::Provider;
use crate::subagents::SubagentSnapshot;
use crate::tasks::TaskOwner;
use crate::tools::Tool;
use crate::transcript::repair_provider_transcript;
use crate::types::Message;

use super::super::{
    tools_for_subagent, with_builtin_service_tools, BuiltinServiceToolContext, ServiceInner,
    ServiceWorkerGuard,
};
use super::worker::{spawn_subagent_loop_with_guard, SubagentLoopStart};

pub(super) struct PreparedSubagentRun {
    pub(super) snapshot: SubagentSnapshot,
    pub(super) subagent_id: String,
    pub(super) messages: Vec<Message>,
    pub(super) provider: Arc<dyn Provider>,
    pub(super) cancel: Arc<CancellationToken>,
}

impl ServiceInner {
    fn subagent_tools(self: &Arc<Self>, subagent_id: &str) -> Vec<Arc<dyn Tool>> {
        let runtime_selection = self
            .subagent_runtime_selections
            .lock()
            .expect("subagent runtime selections mutex poisoned")
            .get(subagent_id)
            .cloned()
            .map(|runtime| (runtime, false));
        with_builtin_service_tools(
            tools_for_subagent(&self.base_tools),
            BuiltinServiceToolContext {
                background_tasks: self.background_tasks.clone(),
                inner: Arc::downgrade(self),
                file_store: None,
                registry_store: self.registry_store.clone(),
                runtime_selection,
                owner: TaskOwner::subagent(subagent_id),
                subagents_enabled: false,
            },
        )
    }

    pub(super) fn spawn_prepared_subagent_run(
        self: &Arc<Self>,
        prepared: PreparedSubagentRun,
        worker_guard: ServiceWorkerGuard,
    ) {
        let subagent_id = prepared.subagent_id.clone();
        let tool_snapshot = {
            let mut snapshots = self
                .subagent_tool_snapshots
                .lock()
                .expect("subagent tool snapshots mutex poisoned");
            if let Some(snapshot) = snapshots.get(&subagent_id) {
                snapshot.clone()
            } else {
                let tools = self.subagent_tools(&subagent_id);
                let snapshot = match FinalToolSnapshot::build(tools, &self.config.tool_execution) {
                    Ok(snapshot) => Arc::new(snapshot),
                    Err(error) => {
                        drop(snapshots);
                        self.transition_to_failed(
                            format!("invalid subagent tool configuration: {error}"),
                            |_| {},
                        );
                        return;
                    }
                };
                snapshots.insert(subagent_id.clone(), snapshot.clone());
                snapshot
            }
        };
        spawn_subagent_loop_with_guard(
            self.clone(),
            SubagentLoopStart {
                subagent_id,
                config: self.subagent_config(),
                initial_messages: repair_provider_transcript(prepared.messages),
                provider: prepared.provider,
                tools: tool_snapshot,
                cancel: prepared.cancel,
                guard: worker_guard,
            },
        );
    }
}
