use super::*;

impl ProviderReasoningReplayPolicy {
    fn emit_reasoning_content_for_assistant(
        self,
        tool_calls: &[ToolCall],
        assistant_replay: Option<&AssistantMessageReplay>,
    ) -> Option<String> {
        if !self.store_assistant_replay(tool_calls) {
            return None;
        }
        assistant_replay
            .and_then(|replay| replay.reasoning_content.as_deref())
            .filter(|reasoning_content| !reasoning_content.is_empty())
            .map(ToOwned::to_owned)
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct ProviderRequestDialect {
    api_compat: ProviderApiCompat,
    thinking_level: ThinkingLevel,
}

impl ProviderRequestDialect {
    pub(super) fn from_policy(policy: ProviderApiCompatPolicy) -> Self {
        Self {
            api_compat: policy.api_compat,
            thinking_level: policy.thinking_level,
        }
    }

    fn apply_request_body(
        self,
        body: &mut Map<String, Value>,
        request: &ProviderRequest,
    ) -> Result<(), OpenAiChatError> {
        self.apply_thinking_request_body(body)?;
        self.apply_tool_request_body(body, request);
        Ok(())
    }

    fn apply_thinking_request_body(
        self,
        body: &mut Map<String, Value>,
    ) -> Result<(), OpenAiChatError> {
        match self.api_compat {
            ProviderApiCompat::Standard => {}
            ProviderApiCompat::Deepseek if self.thinking_level == ThinkingLevel::Off => {
                body.insert("thinking".to_owned(), thinking_type("disabled"));
            }
            ProviderApiCompat::Deepseek => {
                body.insert("thinking".to_owned(), thinking_type("enabled"));
                body.insert(
                    "reasoning_effort".to_owned(),
                    Value::String(reasoning_effort(self.thinking_level)?),
                );
            }
            ProviderApiCompat::DashscopeQwen if self.thinking_level == ThinkingLevel::Off => {
                body.insert("enable_thinking".to_owned(), Value::Bool(false));
            }
            ProviderApiCompat::DashscopeQwen => {
                body.insert("enable_thinking".to_owned(), Value::Bool(true));
                body.insert("stream".to_owned(), Value::Bool(true));
            }
            ProviderApiCompat::DashscopeGlm if self.thinking_level == ThinkingLevel::Off => {
                body.insert("enable_thinking".to_owned(), Value::Bool(false));
            }
            ProviderApiCompat::DashscopeGlm => {
                body.insert("enable_thinking".to_owned(), Value::Bool(true));
                body.insert(
                    "reasoning_effort".to_owned(),
                    Value::String(reasoning_effort(self.thinking_level)?),
                );
                body.insert("clear_thinking".to_owned(), Value::Bool(false));
            }
            ProviderApiCompat::ZaiGlm if self.thinking_level == ThinkingLevel::Off => {
                body.insert("thinking".to_owned(), thinking_type("disabled"));
            }
            ProviderApiCompat::ZaiGlm => {
                body.insert(
                    "thinking".to_owned(),
                    json!({"type": "enabled", "clear_thinking": false}),
                );
                body.insert(
                    "reasoning_effort".to_owned(),
                    Value::String(reasoning_effort(self.thinking_level)?),
                );
            }
        }
        Ok(())
    }

    fn apply_tool_request_body(self, body: &mut Map<String, Value>, request: &ProviderRequest) {
        if request.tools.is_empty() {
            return;
        }
        match self.api_compat {
            ProviderApiCompat::DashscopeQwen => {
                body.insert("parallel_tool_calls".to_owned(), Value::Bool(true));
            }
            ProviderApiCompat::DashscopeGlm => {
                body.insert("stream".to_owned(), Value::Bool(true));
                body.insert("tool_stream".to_owned(), Value::Bool(true));
            }
            ProviderApiCompat::Standard
            | ProviderApiCompat::Deepseek
            | ProviderApiCompat::ZaiGlm => {}
        }
    }

    pub(super) fn requires_streaming_transport(self, request: &ProviderRequest) -> bool {
        (self.api_compat == ProviderApiCompat::DashscopeQwen && !self.thinking_level.is_off())
            || (self.api_compat == ProviderApiCompat::DashscopeGlm && !request.tools.is_empty())
    }
}

pub fn build_chat_completions_request(
    config: &OpenAiCompatibleConfig,
    request: &ProviderRequest,
) -> Result<Value, OpenAiChatError> {
    if config.model.trim().is_empty() {
        return Err(OpenAiChatError::invalid_request("model is required"));
    }
    let policy = ProviderApiCompatPolicy::from_config(config)?;
    let request_dialect = ProviderRequestDialect::from_policy(policy);
    let reasoning_replay = policy.reasoning_replay();

    let model_input = request.model_input();
    validate_provider_model_input(&model_input).map_err(|error| {
        OpenAiChatError::invalid_request(format!("invalid transcript: {error}"))
    })?;
    let mut messages = Vec::with_capacity(model_input.len());
    for input in &model_input {
        messages.push(map_model_input(input, reasoning_replay)?);
    }

    let mut body = Map::new();
    body.insert("model".to_owned(), Value::String(config.model.clone()));
    body.insert("messages".to_owned(), Value::Array(messages));

    if !request.tools.is_empty() {
        body.insert(
            "tools".to_owned(),
            Value::Array(request.tools.iter().map(map_tool_spec).collect()),
        );
    }
    if let Some(temperature) = request.temperature {
        let temperature = Number::from_f64(temperature)
            .ok_or_else(|| OpenAiChatError::invalid_request("temperature must be finite"))?;
        body.insert("temperature".to_owned(), Value::Number(temperature));
    }
    if let Some(max_tokens) = request.max_tokens {
        body.insert(
            "max_tokens".to_owned(),
            Value::Number(Number::from(u64::from(max_tokens))),
        );
    }
    request_dialect.apply_request_body(&mut body, request)?;

    Ok(Value::Object(body))
}

pub(super) fn enable_streaming_request(body: &mut Value) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    object.insert("stream".to_owned(), Value::Bool(true));
    object.insert(
        "stream_options".to_owned(),
        json!({ "include_usage": true }),
    );
}

fn reasoning_effort(level: ThinkingLevel) -> Result<String, OpenAiChatError> {
    match level {
        ThinkingLevel::Low | ThinkingLevel::Medium | ThinkingLevel::High => Ok("high".to_owned()),
        ThinkingLevel::XHigh => Ok("max".to_owned()),
        ThinkingLevel::Off | ThinkingLevel::Minimal => Err(OpenAiChatError::invalid_request(
            "unsupported provider thinking level",
        )),
    }
}

fn thinking_type(value: &str) -> Value {
    json!({ "type": value })
}

fn map_model_input(
    input: &ModelInput,
    reasoning_replay: ProviderReasoningReplayPolicy,
) -> Result<Value, OpenAiChatError> {
    match input {
        ModelInput::Context { role, content } => Ok(json!({
            "role": map_context_role(*role),
            "content": content
        })),
        ModelInput::Message { message } => map_message(message, reasoning_replay),
    }
}

fn map_context_role(role: ContextRole) -> &'static str {
    match role {
        ContextRole::System => "system",
        ContextRole::Developer => "system",
        ContextRole::User => "user",
    }
}

fn map_message(
    message: &Message,
    reasoning_replay: ProviderReasoningReplayPolicy,
) -> Result<Value, OpenAiChatError> {
    match message {
        Message::User { content } => Ok(json!({
            "role": "user",
            "content": content
                .iter()
                .map(map_content_part)
                .collect::<Vec<_>>()
        })),
        Message::Assistant {
            content,
            tool_calls,
            assistant_replay,
            ..
        } => {
            if !assistant_payload_is_valid(content.as_deref(), tool_calls) {
                return Err(OpenAiChatError::invalid_request(
                    "assistant message must include non-empty content or tool_calls",
                ));
            }
            let mut object = Map::new();
            object.insert("role".to_owned(), Value::String("assistant".to_owned()));
            object.insert(
                "content".to_owned(),
                content.clone().map(Value::String).unwrap_or(Value::Null),
            );
            if let Some(reasoning_content) = reasoning_replay
                .emit_reasoning_content_for_assistant(tool_calls, assistant_replay.as_ref())
            {
                object.insert(
                    "reasoning_content".to_owned(),
                    Value::String(reasoning_content),
                );
            }
            if !tool_calls.is_empty() {
                object.insert(
                    "tool_calls".to_owned(),
                    Value::Array(tool_calls.iter().map(map_tool_call).collect()),
                );
            }
            Ok(Value::Object(object))
        }
        Message::ToolResult(result) => Ok(json!({
            "role": "tool",
            "tool_call_id": result.tool_call_id,
            "content": result.bounded_text_for_model()
        })),
    }
}

fn map_content_part(part: &ContentPart) -> Value {
    match part {
        ContentPart::Text { text } => json!({
            "type": "text",
            "text": text
        }),
        ContentPart::ImageUrl { url } => json!({
            "type": "image_url",
            "image_url": {"url": url}
        }),
        ContentPart::ImageBase64 { mime_type, data } => json!({
            "type": "image_url",
            "image_url": {"url": format!("data:{mime_type};base64,{data}")}
        }),
        ContentPart::File { binding } => json!({
            "type": "text",
            "text": render_file_manifest(binding)
        }),
        ContentPart::Skill {
            name,
            path,
            arguments,
        } => json!({
            "type": "text",
            "text": format!(
                "Requested skill: name={}, path={}, arguments={}",
                name.as_deref().unwrap_or(""),
                path.as_deref().unwrap_or(""),
                arguments.as_deref().unwrap_or("")
            )
        }),
    }
}

fn map_tool_spec(spec: &ToolSpec) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": spec.name,
            "description": spec.description,
            "parameters": spec.input_schema
        }
    })
}

fn map_tool_call(call: &ToolCall) -> Value {
    json!({
        "id": call.id,
        "type": "function",
        "function": {
            "name": call.name,
            "arguments": call.arguments_json_string()
        }
    })
}
