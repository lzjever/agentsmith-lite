use std::sync::Arc;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::subagents::{SubagentLifecycle, SubagentManagerError, SubagentRunState};
use crate::types::{ToolCall, ToolResult};

use super::super::{service_unavailable_tool_result, ServiceInner};
use super::bootstrap::push_subagent_user_message_locked;
use super::{
    subagent_manager_error_tool_result, subagent_start_persistence_error_tool_result,
    subagent_tool_success_result, PreparedSubagentRun,
};

impl ServiceInner {
    pub(in crate::service) fn send_subagent_tool_result(
        self: &Arc<Self>,
        call: ToolCall,
        subagent_id: &str,
        message: &str,
    ) -> ToolResult {
        let prepare_call = call.clone();
        let admitted = self.admit_subagent_start(|| {
            let mut prepared_run = None;
            let mut manager = self
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            let Some(current) = manager.snapshot(subagent_id) else {
                return Err(subagent_manager_error_tool_result(
                    prepare_call.clone(),
                    SubagentManagerError::NotFound {
                        id: subagent_id.to_owned(),
                    },
                ));
            };
            if current.lifecycle == SubagentLifecycle::Cancelled {
                return Err(subagent_manager_error_tool_result(
                    prepare_call.clone(),
                    SubagentManagerError::Cancelled {
                        id: subagent_id.to_owned(),
                    },
                ));
            }
            let was_running = current.run_state == SubagentRunState::Running;
            let mut contexts = self
                .subagent_contexts
                .lock()
                .expect("subagent contexts mutex poisoned");
            let provider = if was_running {
                None
            } else {
                let Some(provider) = self
                    .subagent_providers
                    .lock()
                    .expect("subagent providers mutex poisoned")
                    .get(subagent_id)
                    .cloned()
                else {
                    return Err(ToolResult::error(
                        prepare_call.id.clone(),
                        prepare_call.name.clone(),
                        format!("subagent provider missing: {subagent_id}"),
                        json!({"kind": "subagent_provider_missing", "subagent_id": subagent_id}),
                    ));
                };
                Some(provider)
            };
            match manager.send(subagent_id, message) {
                Ok(snapshot) => {
                    if let Some(provider) = provider {
                        let messages =
                            push_subagent_user_message_locked(&mut contexts, subagent_id, message);
                        let cancel = Arc::new(CancellationToken::new());
                        self.subagent_cancels
                            .lock()
                            .expect("subagent cancels mutex poisoned")
                            .insert(subagent_id.to_owned(), cancel.clone());
                        prepared_run = Some(PreparedSubagentRun {
                            subagent_id: subagent_id.to_owned(),
                            snapshot: snapshot.clone(),
                            messages,
                            provider,
                            cancel,
                        });
                    }
                    let started_snapshot = (!was_running).then(|| snapshot.clone());
                    Ok(((snapshot, !was_running, prepared_run), started_snapshot))
                }
                Err(error) => Err(subagent_manager_error_tool_result(prepare_call, error)),
            }
        });
        let Some(((snapshot, should_start, prepared_run), start)) = (match admitted {
            Ok(admitted) => admitted,
            Err(result) => return result,
        }) else {
            return service_unavailable_tool_result(call);
        };
        if let Some(prepared) = prepared_run {
            let (append, worker_guard) = start.expect("idle subagent send should reserve a worker");
            if !append.complete() {
                let snapshot = prepared.snapshot.clone();
                self.fail_prepared_subagent_run_after_start_persistence_failure(
                    prepared,
                    append.event_written,
                );
                return subagent_start_persistence_error_tool_result(call, &snapshot);
            }
            self.spawn_prepared_subagent_run(prepared, worker_guard);
        }
        let status = if should_start { "started" } else { "queued" };
        let details = json!({
            "subagent_id": snapshot.id,
            "name": snapshot.name,
            "status": status,
            "queued_messages": snapshot.queued_message_count,
            "error": Value::Null
        });
        subagent_tool_success_result(call, details)
    }
}
