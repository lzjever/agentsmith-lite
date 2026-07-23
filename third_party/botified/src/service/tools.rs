use std::collections::HashSet;
use std::sync::Weak;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::task_projection::{task_reply_details, task_send_details};
use super::{
    reject_unknown_arguments, service_unavailable_tool_result, ServiceInner, TaskSendOutcome,
    TaskSendStatus,
};
use crate::tasks::{
    task_cancel_result_summary, TaskOwner, TASK_CANCEL_TOOL_NAME, TASK_REPLY_TOOL_NAME,
    TASK_SEND_TOOL_NAME,
};
use crate::tools::{Tool, ToolError, ToolExecutionContext, ToolSpec};
use crate::types::{ToolCall, ToolResult};

pub(super) struct ServiceTaskCancelTool {
    inner: Weak<ServiceInner>,
    owner: TaskOwner,
}

pub(super) struct ServiceTaskReplyTool {
    inner: Weak<ServiceInner>,
    owner: TaskOwner,
}

pub(super) struct ServiceTaskSendTool {
    inner: Weak<ServiceInner>,
    owner: TaskOwner,
}

pub(super) struct ServiceTaskPresetListTool {
    inner: Weak<ServiceInner>,
}

pub(super) struct ServiceTaskPresetStartTool {
    inner: Weak<ServiceInner>,
}

impl ServiceTaskReplyTool {
    pub(super) fn new(inner: Weak<ServiceInner>, owner: TaskOwner) -> Self {
        Self { inner, owner }
    }
}

impl ServiceTaskSendTool {
    pub(super) fn new(inner: Weak<ServiceInner>, owner: TaskOwner) -> Self {
        Self { inner, owner }
    }
}

impl ServiceTaskPresetListTool {
    pub(super) fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

impl ServiceTaskPresetStartTool {
    pub(super) fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

impl ServiceTaskCancelTool {
    pub(super) fn new(inner: Weak<ServiceInner>, owner: TaskOwner) -> Self {
        Self { inner, owner }
    }
}

#[async_trait]
impl Tool for ServiceTaskCancelTool {
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
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        let Some(snapshot) = inner.cancel_background_task_by_owner(&self.owner, task_id) else {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                format!("task not found: {task_id}"),
                json!({"kind": "task_not_found", "task_id": task_id}),
            ));
        };

        let details = task_cancel_result_summary(&snapshot);
        let mut result = ToolResult::success(call.id, call.name, details.to_string());
        result.details = details;
        Ok(result)
    }
}

#[async_trait]
impl Tool for ServiceTaskReplyTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_REPLY_TOOL_NAME,
            "Reply to a pending <task_ask ...> input. Use only for task_ask inputs; the message is written to child stdin as a <botified>{\"op\":\"reply\",...}</botified> line.",
            json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The task_id attribute from the <task_ask ...> input."
                    },
                    "ask_id": {
                        "type": "string",
                        "description": "The ask_id attribute from the <task_ask ...> input."
                    },
                    "message": {
                        "type": "string",
                        "description": "The answer message to write to the child process stdin in the unified botified reply envelope."
                    }
                },
                "required": ["task_id", "ask_id", "message"],
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
        if let Some(result) =
            reject_unknown_task_reply_arguments(&call, &["task_id", "ask_id", "message"])
        {
            return Ok(result);
        }
        let Some(task_id) = call.arguments.get("task_id").and_then(Value::as_str) else {
            return Ok(invalid_task_reply_argument(call, "task_id"));
        };
        let Some(request_id) = call.arguments.get("ask_id").and_then(Value::as_str) else {
            return Ok(invalid_task_reply_argument(call, "ask_id"));
        };
        let Some(response) = call.arguments.get("message").and_then(Value::as_str) else {
            return Ok(invalid_task_reply_argument(call, "message"));
        };
        let Some(inner) = self.inner.upgrade() else {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                "service is not available",
                json!({"kind": "service_unavailable"}),
            ));
        };
        let outcome = inner.reply_task_request_by_owner(&self.owner, task_id, request_id, response);
        let details = task_reply_details(&outcome);
        if outcome.ok() {
            Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
        } else {
            Ok(ToolResult::error(
                call.id,
                call.name,
                outcome.message,
                details,
            ))
        }
    }
}

#[async_trait]
impl Tool for ServiceTaskSendTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_SEND_TOOL_NAME,
            "Send a message to a running interactive task stdin. This does not reply to any pending task_ask and does not wait for an acknowledgement; use only with task_id values from trusted task metadata.",
            json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The task_id from trusted task metadata such as task_list, task_ask, task_tell, callback, or tool result. Do not guess task ids."
                    },
                    "message": {
                        "type": "string",
                        "description": "The message to write to child stdin in a <botified>{\"op\":\"send\",...}</botified> envelope. This does not resolve pending asks or wait for ack."
                    }
                },
                "required": ["task_id", "message"],
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
        if let Some(result) = reject_unknown_arguments(&call, &["task_id", "message"]) {
            return Ok(result);
        }
        let Some(task_id) = call.arguments.get("task_id").and_then(Value::as_str) else {
            return Ok(invalid_task_send_argument(call, "task_id"));
        };
        let Some(message) = call.arguments.get("message").and_then(Value::as_str) else {
            return Ok(invalid_task_send_argument(call, "message"));
        };
        let Some(inner) = self.inner.upgrade() else {
            let details = task_send_details(&TaskSendOutcome::new(
                TaskSendStatus::ServiceUnavailable,
                task_id,
                None,
                "service is not available",
            ));
            return Ok(ToolResult::error(
                call.id,
                call.name,
                "service is not available",
                details,
            ));
        };
        let outcome = inner.send_task_message_by_owner(&self.owner, task_id, message);
        let details = task_send_details(&outcome);
        if outcome.ok() {
            Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
        } else {
            Ok(ToolResult::error(
                call.id,
                call.name,
                outcome.message,
                details,
            ))
        }
    }
}

#[async_trait]
impl Tool for ServiceTaskPresetListTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "task_preset_list",
            "List configured task presets that can be started as managed background tasks. The command is intentionally not exposed.",
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
        if let Some(result) = reject_unknown_arguments(&call, &[]) {
            return Ok(result);
        }
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        let details = inner.task_preset_list_details();
        Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
    }
}

#[async_trait]
impl Tool for ServiceTaskPresetStartTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "task_preset_start",
            "Start one configured task preset as a managed background task by preset_id. The preset command, cwd, env, args, and timeout cannot be overridden.",
            json!({
                "type": "object",
                "properties": {
                    "preset_id": {
                        "type": "string",
                        "description": "The preset id from task_preset_list."
                    }
                },
                "required": ["preset_id"],
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
        if let Some(result) = reject_unknown_arguments(&call, &["preset_id"]) {
            return Ok(result);
        }
        let Some(preset_id) = call.arguments.get("preset_id").and_then(Value::as_str) else {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                "preset_id is required",
                json!({"kind": "invalid_task_preset_start_arguments", "field": "preset_id"}),
            ));
        };
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        let details = inner.start_task_preset(preset_id);
        if details.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
        } else {
            Ok(ToolResult::error(
                call.id,
                call.name,
                details
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("task preset start failed")
                    .to_owned(),
                details,
            ))
        }
    }
}

fn invalid_task_reply_argument(call: ToolCall, field: &str) -> ToolResult {
    ToolResult::error(
        call.id,
        call.name,
        format!("{field} is required"),
        json!({"kind": "invalid_task_reply_arguments", "field": field}),
    )
}

fn reject_unknown_task_reply_arguments(call: &ToolCall, allowed: &[&str]) -> Option<ToolResult> {
    let object = call.arguments.as_object()?;
    let allowed = allowed.iter().copied().collect::<HashSet<_>>();
    let unknown = object
        .keys()
        .find(|key| !allowed.contains(key.as_str()))?
        .clone();
    Some(ToolResult::error(
        call.id.clone(),
        call.name.clone(),
        format!("unknown argument: {unknown}"),
        json!({"kind": "invalid_task_reply_arguments", "field": unknown}),
    ))
}

fn invalid_task_send_argument(call: ToolCall, field: &str) -> ToolResult {
    ToolResult::error(
        call.id,
        call.name,
        format!("{field} is required"),
        json!({"kind": "invalid_task_send_arguments", "field": field}),
    )
}
