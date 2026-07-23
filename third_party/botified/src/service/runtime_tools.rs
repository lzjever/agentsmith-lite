use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::reject_unknown_arguments;
use crate::provider::runtime_selection::{
    RuntimeSelectionHandle, RuntimeThinkingLevelPatch, AUTO_PROVIDER_NAME,
};
use crate::provider::thinking::ThinkingLevel;
use crate::tools::{Tool, ToolError, ToolExecutionContext, ToolSpec};
use crate::types::{ToolCall, ToolResult};

pub(super) struct AgentRuntimeGetTool {
    runtime: RuntimeSelectionHandle,
    can_set: bool,
}

pub(super) struct AgentRuntimeSetTool {
    runtime: RuntimeSelectionHandle,
}

impl AgentRuntimeGetTool {
    pub(super) fn new(runtime: RuntimeSelectionHandle, can_set: bool) -> Self {
        Self { runtime, can_set }
    }
}

impl AgentRuntimeSetTool {
    pub(super) fn new(runtime: RuntimeSelectionHandle) -> Self {
        Self { runtime }
    }
}

#[async_trait]
impl Tool for AgentRuntimeGetTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "agent_runtime_get",
            "Return the current provider runtime selection and safe provider summaries.",
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
        let details = self.runtime.runtime_get_json(self.can_set);
        Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
    }
}

#[async_trait]
impl Tool for AgentRuntimeSetTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "agent_runtime_set",
            "Set the main agent provider runtime selection for future provider calls.",
            json!({
                "type": "object",
                "properties": {
                    "provider_name": {
                        "type": "string",
                        "description": "Configured provider name, or auto for automatic selection."
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
        if let Some(result) = reject_unknown_arguments(&call, &["provider_name", "thinking_level"])
        {
            return Ok(result);
        }
        let provider_name = match optional_string_arg(&call.arguments, "provider_name") {
            Ok(value) => value,
            Err(result) => return Ok(result.with_call(call)),
        };
        let thinking_level =
            match optional_thinking_level_patch_arg(&call.arguments, "thinking_level") {
                Ok(value) => value,
                Err(result) => return Ok(result.with_call(call)),
            };
        if provider_name.is_none() && thinking_level.is_unchanged() {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                "provider_name or thinking_level is required",
                json!({"kind": "invalid_runtime_selection", "field": "provider_name"}),
            ));
        }

        let base = self.runtime.snapshot();
        let selection = base.apply_patch(provider_name, thinking_level);
        match self.runtime.set(selection.clone()) {
            Ok(()) => {
                let details = json!({
                    "kind": "agent_runtime_set",
                    "ok": true,
                    "selection": selection.to_json(),
                });
                Ok(ToolResult::success(call.id, call.name, details.to_string())
                    .with_details(details))
            }
            Err(error) => Ok(ToolResult::error(
                call.id,
                call.name,
                error.to_string(),
                json!({
                    "kind": "invalid_runtime_selection",
                    "selection": selection.to_json(),
                    "error": error.to_string(),
                }),
            )),
        }
    }
}

pub(super) struct PendingToolError {
    text: String,
    details: Value,
}

impl PendingToolError {
    fn with_call(self, call: ToolCall) -> ToolResult {
        ToolResult::error(call.id, call.name, self.text, self.details)
    }
}

fn optional_string_arg(arguments: &Value, field: &str) -> Result<Option<String>, PendingToolError> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                return Err(invalid_arg(field, "must not be empty"));
            }
            if field == "provider_name" && value != AUTO_PROVIDER_NAME {
                return Ok(Some(value.to_owned()));
            }
            Ok(Some(value.to_owned()))
        }
        Some(_) => Err(invalid_arg(field, "must be a string")),
    }
}

pub(super) fn optional_thinking_level_patch_arg(
    arguments: &Value,
    field: &str,
) -> Result<RuntimeThinkingLevelPatch, PendingToolError> {
    match arguments.get(field) {
        None => Ok(RuntimeThinkingLevelPatch::Unchanged),
        Some(Value::Null) => Ok(RuntimeThinkingLevelPatch::Clear),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                return Err(invalid_arg(field, "must not be empty"));
            }
            serde_json::from_value::<ThinkingLevel>(Value::String(value.to_owned()))
                .map(RuntimeThinkingLevelPatch::Set)
                .map_err(|_| {
                    invalid_arg(
                        field,
                        "must be one of off, minimal, low, medium, high, xhigh",
                    )
                })
        }
        Some(_) => Err(invalid_arg(field, "must be a string or null")),
    }
}

fn invalid_arg(field: &str, message: &str) -> PendingToolError {
    PendingToolError {
        text: format!("{field} {message}"),
        details: json!({
            "kind": "invalid_runtime_selection",
            "field": field,
            "message": message,
        }),
    }
}
