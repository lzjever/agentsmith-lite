use std::sync::Arc;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::subagents::{SubagentLifecycle, SubagentManagerError, SubagentSnapshot};
use crate::tasks::{TaskOwner, TaskState};
use crate::types::{ToolCall, ToolResult};

use super::super::ServiceInner;
use super::{subagent_manager_error_tool_result, subagent_tool_success_result};

impl ServiceInner {
    pub(in crate::service) fn cancel_subagent_tool_result(
        self: &Arc<Self>,
        call: ToolCall,
        subagent_id: &str,
    ) -> ToolResult {
        let (snapshot, already_cancelled, cancel) =
            match self.cancel_subagent_lifecycle(subagent_id) {
                Ok(cancelled) => cancelled,
                Err(error) => return subagent_manager_error_tool_result(call, error),
            };
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        let owner = TaskOwner::subagent(subagent_id.to_owned());
        let cancelled_task_ids = self
            .background_tasks
            .cancel_all_by_owner(&owner)
            .into_iter()
            .filter(|task| task.state == TaskState::Cancelling)
            .map(|task| task.task_id)
            .collect::<Vec<_>>();
        if !already_cancelled {
            self.append_subagent_event("subagent.cancelled", &snapshot);
        }
        let details = json!({
            "subagent_id": snapshot.id,
            "name": snapshot.name,
            "status": "cancelled",
            "cancelled_task_ids": cancelled_task_ids,
            "error": Value::Null
        });
        subagent_tool_success_result(call, details)
    }

    pub(in crate::service) fn cancel_subagent_lifecycle(
        &self,
        subagent_id: &str,
    ) -> Result<(SubagentSnapshot, bool, Option<Arc<CancellationToken>>), SubagentManagerError>
    {
        let _lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let mut manager = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let already_cancelled = manager
            .snapshot(subagent_id)
            .is_some_and(|snapshot| snapshot.lifecycle == SubagentLifecycle::Cancelled);
        let snapshot = manager.cancel(subagent_id)?;
        self.subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .remove(subagent_id);
        self.subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .remove(subagent_id);
        self.subagent_runtime_selections
            .lock()
            .expect("subagent runtime selections mutex poisoned")
            .remove(subagent_id);
        self.subagent_tool_snapshots
            .lock()
            .expect("subagent tool snapshots mutex poisoned")
            .remove(subagent_id);
        let cancel = self
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .remove(subagent_id);
        Ok((snapshot, already_cancelled, cancel))
    }
}
