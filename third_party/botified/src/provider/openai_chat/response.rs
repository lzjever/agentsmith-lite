use super::*;

impl ProviderReasoningReplayPolicy {
    fn parse_reasoning_content(
        self,
        message: &Map<String, Value>,
    ) -> Result<Option<String>, OpenAiChatError> {
        if !self.enabled {
            return Ok(None);
        }

        match message.get("reasoning_content") {
            Some(Value::String(reasoning_content)) if !reasoning_content.is_empty() => {
                Ok(Some(reasoning_content.clone()))
            }
            Some(Value::String(_)) | Some(Value::Null) | None => Ok(None),
            _ => Err(OpenAiChatError::invalid_response(
                "assistant reasoning_content must be a string",
            )),
        }
    }
}

pub fn parse_chat_completions_response(
    value: &Value,
    config: &OpenAiCompatibleConfig,
) -> Result<ProviderResponse, OpenAiChatError> {
    let policy = ProviderApiCompatPolicy::from_config(config)?;
    let reasoning_replay = policy.reasoning_replay();
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| OpenAiChatError::invalid_response("missing first choice"))?;
    let message = choice
        .get("message")
        .and_then(Value::as_object)
        .ok_or_else(|| OpenAiChatError::invalid_response("missing assistant message"))?;
    let text = parse_assistant_text(message)?;
    let tool_calls = parse_tool_calls(message.get("tool_calls"))?;
    let finish_reason = choice.get("finish_reason").and_then(Value::as_str);
    let stop_reason = classify_assistant_payload(finish_reason, text.as_deref(), &tool_calls)?;
    let assistant_replay = if reasoning_replay.store_assistant_replay(&tool_calls) {
        reasoning_replay
            .parse_reasoning_content(message)?
            .map(AssistantMessageReplay::reasoning_content)
    } else {
        None
    };

    Ok(ProviderResponse {
        text,
        tool_calls,
        assistant_replay,
        usage: parse_usage(value.get("usage"))?,
        stop_reason,
        metadata: None,
    })
}

pub(super) fn classify_assistant_payload(
    finish_reason: Option<&str>,
    text: Option<&str>,
    tool_calls: &[ToolCall],
) -> Result<StopReason, OpenAiChatError> {
    let stop_reason = map_finish_reason(finish_reason, tool_calls);
    if !assistant_payload_is_compatible(finish_reason, text, tool_calls, stop_reason) {
        return Err(OpenAiChatError::invalid_response(
            "assistant message must include non-empty content or tool_calls, and finish_reason tool_calls must include tool_calls",
        ));
    }
    Ok(stop_reason)
}

fn map_finish_reason(finish_reason: Option<&str>, tool_calls: &[ToolCall]) -> StopReason {
    if !tool_calls.is_empty() || finish_reason == Some("tool_calls") {
        StopReason::ToolCalls
    } else if finish_reason == Some("stop") {
        StopReason::EndTurn
    } else {
        StopReason::ProviderStop
    }
}

fn assistant_payload_is_compatible(
    finish_reason: Option<&str>,
    text: Option<&str>,
    tool_calls: &[ToolCall],
    stop_reason: StopReason,
) -> bool {
    if finish_reason == Some("tool_calls") && tool_calls.is_empty() {
        return false;
    }
    assistant_payload_is_valid(text, tool_calls)
        || matches!(stop_reason, StopReason::EndTurn | StopReason::ProviderStop)
}

fn parse_tool_calls(value: Option<&Value>) -> Result<Vec<ToolCall>, OpenAiChatError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let calls = value
        .as_array()
        .ok_or_else(|| OpenAiChatError::invalid_response("tool_calls must be an array"))?;
    calls
        .iter()
        .map(|call| {
            if call.get("type").and_then(Value::as_str) != Some("function") {
                return Err(OpenAiChatError::invalid_response(
                    "tool call type must be function",
                ));
            }
            let id = required_str(call, "id")?;
            let function = call
                .get("function")
                .and_then(Value::as_object)
                .ok_or_else(|| OpenAiChatError::invalid_response("tool call missing function"))?;
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| OpenAiChatError::invalid_response("tool call missing name"))?;
            let arguments = match function.get("arguments") {
                Some(Value::String(arguments)) => arguments.as_str(),
                Some(_) => {
                    return Err(OpenAiChatError::invalid_response(
                        "tool call arguments must be a string",
                    ))
                }
                None => "{}",
            };
            Ok(tool_call_from_arguments(id, name, arguments))
        })
        .collect()
}

pub(super) fn tool_call_from_arguments<'a>(
    id: impl Into<String>,
    name: impl Into<String>,
    arguments: impl Into<Cow<'a, str>>,
) -> ToolCall {
    let arguments = arguments.into();
    match serde_json::from_str::<Value>(arguments.as_ref()) {
        Ok(arguments_value) if arguments_value.is_object() => {
            ToolCall::new(id, name, arguments_value)
        }
        Ok(_) => {
            ToolCall::invalid_arguments(id, name, arguments, "tool arguments must be a JSON object")
        }
        Err(error) => ToolCall::invalid_arguments(id, name, arguments, error.to_string()),
    }
}

pub(super) fn parse_usage(value: Option<&Value>) -> Result<Option<Usage>, OpenAiChatError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    Ok(Some(Usage {
        input_tokens: required_u64(value, "prompt_tokens")?,
        output_tokens: required_u64(value, "completion_tokens")?,
        total_tokens: required_u64(value, "total_tokens")?,
        cached_input_tokens: optional_nested_u64(value, "prompt_tokens_details", "cached_tokens"),
        reasoning_output_tokens: optional_nested_u64(
            value,
            "completion_tokens_details",
            "reasoning_tokens",
        ),
    }))
}

fn parse_assistant_text(message: &Map<String, Value>) -> Result<Option<String>, OpenAiChatError> {
    if let Some(refusal) = message.get("refusal").and_then(Value::as_str) {
        if !refusal.is_empty() {
            return Ok(Some(refusal.to_owned()));
        }
    }

    match message.get("content") {
        Some(Value::String(content)) if !content.is_empty() => Ok(Some(content.clone())),
        Some(Value::String(_)) | Some(Value::Null) | None => Ok(None),
        Some(Value::Array(parts)) => parse_assistant_content_parts(parts),
        _ => Err(OpenAiChatError::invalid_response(
            "assistant content must be a string or content parts array",
        )),
    }
}

fn parse_assistant_content_parts(parts: &[Value]) -> Result<Option<String>, OpenAiChatError> {
    let mut text = Vec::new();
    for part in parts {
        let part_type = part.get("type").and_then(Value::as_str);
        match part_type {
            Some("text") => {
                if let Some(value) = part.get("text").and_then(Value::as_str) {
                    if !value.is_empty() {
                        text.push(value.to_owned());
                    }
                }
            }
            Some("refusal") => {
                if let Some(value) = part.get("refusal").and_then(Value::as_str) {
                    if !value.is_empty() {
                        text.push(value.to_owned());
                    }
                }
            }
            _ => {}
        }
    }

    if text.is_empty() {
        Ok(None)
    } else {
        Ok(Some(text.join("\n")))
    }
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, OpenAiChatError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| OpenAiChatError::invalid_response(format!("missing string field {key}")))
}

fn required_u64(value: &Value, key: &str) -> Result<u64, OpenAiChatError> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| OpenAiChatError::invalid_response(format!("missing integer field {key}")))
}

fn optional_nested_u64(value: &Value, object_key: &str, key: &str) -> u64 {
    value
        .get(object_key)
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .unwrap_or_default()
}
