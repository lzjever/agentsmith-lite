use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::formatting::bounded_chars;
use crate::tools::{Tool, ToolError, ToolExecutionContext, ToolSpec};
use crate::types::{ToolCall, ToolResult};

use super::{
    runtime_work_display, task_state_name, task_surface_facts, BackgroundTaskManager, TaskOwner,
    TaskSnapshot,
};

const TASK_LIST_MAX_TASKS: usize = 64;
const TASK_LIST_OUTPUT_TAIL_CHARS: usize = 2048;
const TASK_CANCEL_OUTPUT_TAIL_CHARS: usize = 2048;
pub const TASK_LIST_TOOL_NAME: &str = "task_list";
pub const TASK_CANCEL_TOOL_NAME: &str = "task_cancel";
pub const TASK_REPLY_TOOL_NAME: &str = "task_reply";
pub const TASK_SEND_TOOL_NAME: &str = "task_send";
#[derive(Debug, Clone)]
pub struct TaskListTool {
    manager: std::sync::Arc<BackgroundTaskManager>,
    owner: TaskOwner,
}

impl TaskListTool {
    pub fn new(manager: std::sync::Arc<BackgroundTaskManager>) -> Self {
        Self::new_for_owner(manager, TaskOwner::Main)
    }

    pub fn new_for_owner(manager: std::sync::Arc<BackgroundTaskManager>, owner: TaskOwner) -> Self {
        Self { manager, owner }
    }
}

#[async_trait]
impl Tool for TaskListTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_LIST_TOOL_NAME,
            "List active and recent in-process background tasks with bounded metadata.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        )
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        let details = task_list_summary(self.manager.list_by_owner(&self.owner));
        Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
    }
}

#[derive(Debug, Clone)]
pub struct TaskCancelTool {
    manager: std::sync::Arc<BackgroundTaskManager>,
}

impl TaskCancelTool {
    pub fn new(manager: std::sync::Arc<BackgroundTaskManager>) -> Self {
        Self { manager }
    }
}

#[async_trait]
impl Tool for TaskCancelTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_CANCEL_TOOL_NAME,
            "Request cancellation of a running in-process background task by task_id.",
            json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The task_id returned by a detached task or task_list."
                    }
                },
                "required": ["task_id"],
                "additionalProperties": false
            }),
        )
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        let Some(task_id) = call.arguments.get("task_id").and_then(Value::as_str) else {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                "task_id is required",
                json!({"kind": "invalid_task_cancel_arguments", "field": "task_id"}),
            ));
        };
        let Some(snapshot) = self.manager.cancel(task_id) else {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                format!("task not found: {task_id}"),
                json!({"kind": "task_not_found", "task_id": task_id}),
            ));
        };

        let details = task_cancel_result_summary(&snapshot);
        Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
    }
}

pub fn is_builtin_task_tool(name: &str) -> bool {
    matches!(
        name,
        TASK_LIST_TOOL_NAME
            | TASK_CANCEL_TOOL_NAME
            | TASK_REPLY_TOOL_NAME
            | TASK_SEND_TOOL_NAME
            | "subagent_spawn"
            | "subagent_send"
            | "subagent_read"
            | "subagent_list"
            | "subagent_cancel"
    )
}

pub fn task_list_summary(snapshots: Vec<TaskSnapshot>) -> Value {
    let total = snapshots.len();
    let tasks = snapshots
        .into_iter()
        .take(TASK_LIST_MAX_TASKS)
        .map(task_summary)
        .collect::<Vec<_>>();
    let omitted = total.saturating_sub(tasks.len());
    json!({
        "kind": "task_list",
        "tasks": tasks,
        "total": total,
        "omitted": omitted
    })
}

pub fn task_detail_summary(snapshot: TaskSnapshot) -> Value {
    let task_id = snapshot.task_id.clone();
    let state = task_state_name(snapshot.state);
    json!({
        "kind": "task_detail",
        "task_id": task_id,
        "state": state,
        "task": task_summary(snapshot)
    })
}

pub fn task_cancel_result_summary(snapshot: &TaskSnapshot) -> Value {
    json!({
        "kind": "task_cancel",
        "task": task_cancel_summary(snapshot),
        "task_id": snapshot.task_id,
        "state": task_state_name(snapshot.state)
    })
}

fn task_summary(snapshot: TaskSnapshot) -> Value {
    let facts = task_surface_facts(&snapshot);
    let display = runtime_work_display(&snapshot);
    json!({
        "task_id": snapshot.task_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "preset_id": snapshot.preset_id,
        "preset_description": snapshot.preset_description,
        "state": facts.state_name,
        "task_label": display.label,
        "arguments_summary": display.summary,
        "timeout_secs": facts.timeout_secs,
        "timeout_at": facts.timeout_at_rfc3339,
        "forced_termination_at": facts.forced_termination_at_rfc3339,
        "output_tail": bounded_chars(&snapshot.output.tail, TASK_LIST_OUTPUT_TAIL_CHARS),
        "output_bytes": facts.output_bytes,
        "output_tail_truncated": facts.output_tail_truncated,
        "output_artifact_path": facts.output_artifact_path,
        "output_artifact_truncated": facts.output_artifact_truncated,
        "output_dropped_bytes": facts.output_dropped_bytes,
        "output_live": facts.output_live,
        "output_complete": facts.output_complete,
        "callback_delivery": facts.callback_delivery_name,
        "callback_failure_reason": snapshot.callback_failure_reason,
    })
}

fn task_cancel_summary(snapshot: &TaskSnapshot) -> Value {
    let facts = task_surface_facts(snapshot);
    let display = runtime_work_display(snapshot);
    json!({
        "task_id": snapshot.task_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "preset_id": snapshot.preset_id,
        "preset_description": snapshot.preset_description,
        "state": facts.state_name,
        "task_label": display.label,
        "arguments_summary": display.summary,
        "timeout_secs": facts.timeout_secs,
        "timeout_at": facts.timeout_at_rfc3339,
        "forced_termination_at": facts.forced_termination_at_rfc3339,
        "output_tail": bounded_chars(&snapshot.output.tail, TASK_CANCEL_OUTPUT_TAIL_CHARS),
        "output_bytes": facts.output_bytes,
        "output_tail_truncated": facts.output_tail_truncated,
        "output_artifact_path": facts.output_artifact_path,
        "output_artifact_truncated": facts.output_artifact_truncated,
        "output_dropped_bytes": facts.output_dropped_bytes,
    })
}
