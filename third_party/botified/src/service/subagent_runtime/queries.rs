use serde_json::json;

use crate::subagents::{SubagentLifecycle, SubagentSnapshot};
use crate::types::{ToolCall, ToolResult};

use super::super::subagent_projection::{subagent_read_details, subagent_summary};
use super::super::ServiceInner;
use super::subagent_tool_success_result;

impl ServiceInner {
    pub(super) fn subagent_snapshot(&self, subagent_id: &str) -> Option<SubagentSnapshot> {
        self.subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(subagent_id)
    }

    pub(super) fn open_subagent_snapshot(&self, subagent_id: &str) -> Option<SubagentSnapshot> {
        self.subagent_snapshot(subagent_id).and_then(|snapshot| {
            (snapshot.lifecycle != SubagentLifecycle::Cancelled).then_some(snapshot)
        })
    }

    pub(in crate::service) fn read_subagent_tool_result(
        &self,
        call: ToolCall,
        subagent_id: &str,
        include: &str,
    ) -> ToolResult {
        let Some(snapshot) = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(subagent_id)
        else {
            return ToolResult::error(
                call.id,
                call.name,
                format!("subagent not found: {subagent_id}"),
                json!({"kind": "subagent_not_found", "subagent_id": subagent_id}),
            );
        };
        let details = subagent_read_details(&snapshot, include);
        subagent_tool_success_result(call, details)
    }

    pub(in crate::service) fn list_subagents_tool_result(&self, call: ToolCall) -> ToolResult {
        let snapshots = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .list();
        let details = json!({
            "kind": "subagent_list",
            "subagents": snapshots
                .iter()
                .map(subagent_summary)
                .collect::<Vec<_>>(),
            "total": snapshots.len()
        });
        subagent_tool_success_result(call, details)
    }
}
