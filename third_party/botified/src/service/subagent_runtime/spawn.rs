use std::sync::Arc;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::provider::runtime_selection::RuntimeSelectionHandle;
use crate::provider::Provider;
use crate::subagents::SubagentManagerError;
use crate::tasks::TaskOwner;
use crate::transcript::repair_provider_transcript;
use crate::types::{Message, ToolCall, ToolResult};

use super::super::{service_unavailable_tool_result, ServiceInner, SubagentSpawnRequest};
use super::{
    subagent_manager_error_tool_result, subagent_start_persistence_error_tool_result,
    subagent_tool_success_result, PreparedSubagentRun,
};

impl ServiceInner {
    pub(in crate::service) fn spawn_subagent_tool_result(
        self: &Arc<Self>,
        call: ToolCall,
        request: SubagentSpawnRequest<'_>,
    ) -> ToolResult {
        let SubagentSpawnRequest {
            task,
            name_hint,
            inherit_context,
            provider_name,
            thinking_level,
            provider_transcript_snapshot,
        } = request;
        if !self.subagent_options.enabled_flag() {
            return ToolResult::error(
                call.id,
                call.name,
                "subagents are disabled",
                json!({"kind": "subagents_disabled"}),
            );
        }
        let (provider, runtime_selection) = match &self.runtime_selection {
            Some(runtime) => {
                let base = runtime.snapshot();
                let selection = base.apply_patch(provider_name, thinking_level);
                match runtime.fixed_provider_for(selection.clone()) {
                    Ok((fixed_runtime, provider)) => (provider, Some(fixed_runtime)),
                    Err(error) => {
                        return ToolResult::error(
                            call.id,
                            call.name,
                            error.to_string(),
                            json!({
                                "kind": "invalid_runtime_selection",
                                "selection": selection.to_json(),
                                "error": error.to_string(),
                            }),
                        );
                    }
                }
            }
            None => {
                if provider_name.is_some() || !thinking_level.is_unchanged() {
                    return ToolResult::error(
                        call.id,
                        call.name,
                        "runtime selection is not available",
                        json!({"kind": "runtime_selection_unavailable"}),
                    );
                }
                (self.provider.clone(), None)
            }
        };
        let initial_messages = self.initial_subagent_messages(
            task,
            inherit_context,
            provider_transcript_snapshot,
            &call.id,
        );
        let admitted = self.admit_subagent_start(|| {
            self.prepare_spawned_subagent_run_locked(
                name_hint,
                task,
                initial_messages,
                provider,
                runtime_selection,
            )
            .map(|prepared| {
                let snapshot = prepared.snapshot.clone();
                (prepared, Some(snapshot))
            })
        });
        let Some((prepared, Some((append, worker_guard)))) = (match admitted {
            Ok(admitted) => admitted,
            Err(error) => return subagent_manager_error_tool_result(call, error),
        }) else {
            return service_unavailable_tool_result(call);
        };
        let snapshot = prepared.snapshot.clone();
        if !append.complete() {
            self.cancel_prepared_subagent_spawn_after_start_persistence_failure(
                prepared,
                append.event_written,
            );
            return subagent_start_persistence_error_tool_result(call, &snapshot);
        }
        self.spawn_prepared_subagent_run(prepared, worker_guard);

        let details = json!({
            "subagent_id": snapshot.id,
            "name": snapshot.name,
            "status": "started",
            "callback_pending": true,
            "error": Value::Null
        });
        subagent_tool_success_result(call, details)
    }

    fn cancel_prepared_subagent_spawn_after_start_persistence_failure(
        self: &Arc<Self>,
        prepared: PreparedSubagentRun,
        started_event_written: bool,
    ) {
        let subagent_id = prepared.subagent_id.clone();
        prepared.cancel.cancel();
        let Ok((snapshot, already_cancelled, cancel)) =
            self.cancel_subagent_lifecycle(&subagent_id)
        else {
            return;
        };
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        self.background_tasks
            .cancel_all_by_owner(&TaskOwner::subagent(subagent_id));
        if started_event_written && !already_cancelled {
            self.append_subagent_event("subagent.cancelled", &snapshot);
        }
    }

    fn prepare_spawned_subagent_run_locked(
        &self,
        name_hint: &str,
        task: &str,
        initial_messages: Vec<Message>,
        provider: Arc<dyn Provider>,
        runtime_selection: Option<RuntimeSelectionHandle>,
    ) -> Result<PreparedSubagentRun, SubagentManagerError> {
        let mut manager = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let snapshot = manager.spawn(name_hint, task)?;
        let messages = repair_provider_transcript(initial_messages);
        self.subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(snapshot.id.clone(), messages.clone());
        self.subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .insert(snapshot.id.clone(), provider.clone());
        if let Some(runtime_selection) = runtime_selection {
            self.subagent_runtime_selections
                .lock()
                .expect("subagent runtime selections mutex poisoned")
                .insert(snapshot.id.clone(), runtime_selection);
        }
        let cancel = Arc::new(CancellationToken::new());
        self.subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .insert(snapshot.id.clone(), cancel.clone());
        Ok(PreparedSubagentRun {
            subagent_id: snapshot.id.clone(),
            snapshot,
            messages,
            provider,
            cancel,
        })
    }
}
