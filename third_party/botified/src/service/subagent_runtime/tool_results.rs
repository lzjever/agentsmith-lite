use serde_json::{json, Value};

use super::super::{SubagentManagerError, SubagentSnapshot, ToolCall, ToolResult};

pub(super) fn subagent_manager_error_tool_result(
    call: ToolCall,
    error: SubagentManagerError,
) -> ToolResult {
    let (kind, message) = match &error {
        SubagentManagerError::InvalidLimit { field } => {
            ("invalid_limit", format!("invalid subagent limit: {field}"))
        }
        SubagentManagerError::ParallelLimit { max_parallel } => (
            "parallel_limit",
            format!("subagent parallel limit exceeded: max_parallel={max_parallel}"),
        ),
        SubagentManagerError::BranchLimit { max_branches } => (
            "branch_limit",
            format!("subagent branch limit exceeded: max_branches={max_branches}"),
        ),
        SubagentManagerError::QueueLimit {
            max_queued_messages,
        } => (
            "queued_message_limit",
            format!(
                "subagent queued message limit exceeded: max_queued_messages={max_queued_messages}"
            ),
        ),
        SubagentManagerError::NotFound { id } => {
            ("subagent_not_found", format!("subagent not found: {id}"))
        }
        SubagentManagerError::Cancelled { id } => {
            ("subagent_cancelled", format!("subagent is cancelled: {id}"))
        }
    };
    ToolResult::error(
        call.id,
        call.name,
        message,
        json!({"kind": kind, "error": error.to_string()}),
    )
}

pub(super) fn subagent_start_persistence_error_tool_result(
    call: ToolCall,
    snapshot: &SubagentSnapshot,
) -> ToolResult {
    ToolResult::error(
        call.id,
        call.name,
        "subagent start persistence failed",
        json!({
            "kind": "subagent_start_persistence_failed",
            "subagent_id": snapshot.id,
            "name": snapshot.name,
            "status": "failed"
        }),
    )
}

pub(super) fn subagent_tool_success_result(call: ToolCall, details: Value) -> ToolResult {
    ToolResult::success(call.id, call.name, details.to_string()).with_details(details)
}
