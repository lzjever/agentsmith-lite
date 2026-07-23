use std::sync::Weak;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::{
    reject_unknown_arguments, service_unavailable_tool_result, ServiceInner, SubagentSpawnRequest,
};
use crate::provider::runtime_selection::RuntimeThinkingLevelPatch;
use crate::provider::thinking::ThinkingLevel;
use crate::tools::{Tool, ToolError, ToolExecutionContext, ToolSpec, ToolVisibility};
use crate::types::{ToolCall, ToolResult};

pub(super) struct SubagentSpawnTool {
    inner: Weak<ServiceInner>,
}

pub(super) struct SubagentSendTool {
    inner: Weak<ServiceInner>,
}

pub(super) struct SubagentReadTool {
    inner: Weak<ServiceInner>,
}

pub(super) struct SubagentListTool {
    inner: Weak<ServiceInner>,
}

pub(super) struct SubagentCancelTool {
    inner: Weak<ServiceInner>,
}

impl SubagentSpawnTool {
    pub(super) fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

impl SubagentSendTool {
    pub(super) fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

impl SubagentReadTool {
    pub(super) fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

impl SubagentListTool {
    pub(super) fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

impl SubagentCancelTool {
    pub(super) fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl Tool for SubagentSpawnTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "subagent_spawn",
            "Create one internal subagent branch and start its first run.",
            json!({
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "The bounded task instruction for the subagent."
                    },
                    "name_hint": {
                        "type": "string",
                        "description": "Optional short human-readable branch name hint."
                    },
                    "inherit_context": {
                        "type": "boolean",
                        "description": "When true, start from the current main context snapshot; defaults to false."
                    },
                    "provider_name": {
                        "type": "string",
                        "description": "Optional configured provider name, or auto."
                    },
                    "thinking_level": {
                        "oneOf": [
                            {
                                "type": "string",
                                "enum": ["off", "minimal", "low", "medium", "high", "xhigh"]
                            },
                            { "type": "null" }
                        ],
                        "description": "Optional runtime thinking intensity override; null clears the override."
                    }
                },
                "required": ["task"],
                "additionalProperties": false
            }),
        )
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::SubagentControl
    }

    async fn execute(
        &self,
        call: ToolCall,
        context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) = reject_unknown_arguments(
            &call,
            &[
                "task",
                "name_hint",
                "inherit_context",
                "provider_name",
                "thinking_level",
            ],
        ) {
            return Ok(result);
        }
        let Some(task) = call
            .arguments
            .get("task")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return Ok(invalid_subagent_argument(call, "task"));
        };
        let name_hint = call
            .arguments
            .get("name_hint")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let inherit_context = call
            .arguments
            .get("inherit_context")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let provider_name = match call.arguments.get("provider_name") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => {
                let value = value.trim();
                if value.is_empty() {
                    return Ok(ToolResult::error(
                        call.id,
                        call.name,
                        "provider_name must not be empty",
                        json!({
                            "kind": "invalid_runtime_selection",
                            "field": "provider_name"
                        }),
                    ));
                }
                Some(value.to_owned())
            }
            Some(_) => {
                return Ok(ToolResult::error(
                    call.id,
                    call.name,
                    "provider_name must be a string",
                    json!({
                        "kind": "invalid_runtime_selection",
                        "field": "provider_name"
                    }),
                ));
            }
        };
        let thinking_level = match call.arguments.get("thinking_level") {
            None => RuntimeThinkingLevelPatch::Unchanged,
            Some(Value::Null) => RuntimeThinkingLevelPatch::Clear,
            Some(Value::String(value)) => {
                match serde_json::from_value::<ThinkingLevel>(Value::String(value.clone())) {
                    Ok(level) => RuntimeThinkingLevelPatch::Set(level),
                    Err(_) => {
                        return Ok(ToolResult::error(
                            call.id,
                            call.name,
                            "thinking_level must be one of off, minimal, low, medium, high, xhigh",
                            json!({
                                "kind": "invalid_runtime_selection",
                                "field": "thinking_level"
                            }),
                        ));
                    }
                }
            }
            Some(_) => {
                return Ok(ToolResult::error(
                    call.id,
                    call.name,
                    "thinking_level must be a string or null",
                    json!({
                        "kind": "invalid_runtime_selection",
                        "field": "thinking_level"
                    }),
                ));
            }
        };
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        Ok(inner.spawn_subagent_tool_result(
            call,
            SubagentSpawnRequest {
                task: &task,
                name_hint: &name_hint,
                inherit_context,
                provider_name,
                thinking_level,
                provider_transcript_snapshot: context.provider_transcript_snapshot,
            },
        ))
    }
}

#[async_trait]
impl Tool for SubagentSendTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "subagent_send",
            "Send a follow-up instruction to an existing internal subagent branch.",
            json!({
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "The subagent_id returned by subagent_spawn or subagent_list."
                    },
                    "message": {
                        "type": "string",
                        "description": "The branch-local follow-up instruction."
                    }
                },
                "required": ["subagent_id", "message"],
                "additionalProperties": false
            }),
        )
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::SubagentControl
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) = reject_unknown_arguments(&call, &["subagent_id", "message"]) {
            return Ok(result);
        }
        let Some(subagent_id) = call
            .arguments
            .get("subagent_id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return Ok(invalid_subagent_argument(call, "subagent_id"));
        };
        let Some(message) = call
            .arguments
            .get("message")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return Ok(invalid_subagent_argument(call, "message"));
        };
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        Ok(inner.send_subagent_tool_result(call, &subagent_id, &message))
    }
}

#[async_trait]
impl Tool for SubagentReadTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "subagent_read",
            "Read a bounded summary of one internal subagent branch.",
            json!({
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "The subagent_id returned by subagent_spawn or subagent_list."
                    },
                    "include": {
                        "type": "string",
                        "enum": ["summary", "tail", "all"],
                        "description": "Optional bounded view to include; defaults to summary."
                    }
                },
                "required": ["subagent_id"],
                "additionalProperties": false
            }),
        )
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::SubagentControl
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) = reject_unknown_arguments(&call, &["subagent_id", "include"]) {
            return Ok(result);
        }
        let Some(subagent_id) = call
            .arguments
            .get("subagent_id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return Ok(invalid_subagent_argument(call, "subagent_id"));
        };
        let include = call
            .arguments
            .get("include")
            .and_then(Value::as_str)
            .unwrap_or("summary")
            .to_owned();
        if !matches!(include.as_str(), "summary" | "tail" | "all") {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                "include must be summary, tail, or all",
                json!({"kind": "invalid_subagent_arguments", "field": "include"}),
            ));
        }
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        Ok(inner.read_subagent_tool_result(call, &subagent_id, &include))
    }
}

#[async_trait]
impl Tool for SubagentListTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "subagent_list",
            "List internal subagent branches with bounded summaries.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        )
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::SubagentControl
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
        Ok(inner.list_subagents_tool_result(call))
    }
}

#[async_trait]
impl Tool for SubagentCancelTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "subagent_cancel",
            "Cancel one internal subagent branch.",
            json!({
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "The subagent_id returned by subagent_spawn or subagent_list."
                    }
                },
                "required": ["subagent_id"],
                "additionalProperties": false
            }),
        )
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::SubagentControl
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) = reject_unknown_arguments(&call, &["subagent_id"]) {
            return Ok(result);
        }
        let Some(subagent_id) = call
            .arguments
            .get("subagent_id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return Ok(invalid_subagent_argument(call, "subagent_id"));
        };
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        Ok(inner.cancel_subagent_tool_result(call, &subagent_id))
    }
}

fn invalid_subagent_argument(call: ToolCall, field: &str) -> ToolResult {
    ToolResult::error(
        call.id,
        call.name,
        format!("{field} is required"),
        json!({"kind": "invalid_subagent_arguments", "field": field}),
    )
}
