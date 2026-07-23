use super::response::{classify_assistant_payload, parse_usage, tool_call_from_arguments};
use super::*;

#[derive(Default)]
pub(super) struct SseEventBuffer {
    bytes: Vec<u8>,
    event_start: usize,
    scan_cursor: usize,
    #[cfg(test)]
    scanned_bytes: usize,
}

impl SseEventBuffer {
    pub(super) fn extend(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
    }

    pub(super) fn next_event(&mut self) -> Option<&[u8]> {
        let mut cursor = self.scan_cursor.max(self.event_start);
        while cursor < self.bytes.len() {
            #[cfg(test)]
            {
                self.scanned_bytes += 1;
            }

            let separator_len = if self.bytes[cursor..].starts_with(b"\r\n\r\n") {
                4
            } else if self.bytes[cursor..].starts_with(b"\n\n") {
                2
            } else {
                cursor += 1;
                continue;
            };

            let event_start = self.event_start;
            self.event_start = cursor + separator_len;
            self.scan_cursor = self.event_start;
            return Some(&self.bytes[event_start..cursor]);
        }

        self.scan_cursor = self.bytes.len().saturating_sub(3).max(self.event_start);
        None
    }

    pub(super) fn compact(&mut self) {
        if self.event_start == 0 {
            return;
        }

        let consumed = self.event_start;
        self.bytes.copy_within(consumed.., 0);
        self.bytes.truncate(self.bytes.len() - consumed);
        self.scan_cursor = self.scan_cursor.saturating_sub(consumed);
        self.event_start = 0;
    }

    #[cfg(test)]
    pub(super) fn pending_len(&self) -> usize {
        self.bytes.len()
    }

    #[cfg(test)]
    pub(super) fn pending_bytes(&self) -> &[u8] {
        &self.bytes
    }

    #[cfg(test)]
    pub(super) fn scanned_bytes(&self) -> usize {
        self.scanned_bytes
    }
}

pub(super) struct ChatCompletionsStreamParser {
    reasoning_replay: ProviderReasoningReplayPolicy,
    preview_context: Option<ProviderPreviewContext>,
    text: String,
    reasoning_content: String,
    tool_calls: StreamingToolCallAssembler,
    usage: Option<Usage>,
    finish_reason: Option<String>,
    text_emitted: bool,
    pub(super) done: bool,
}

impl ChatCompletionsStreamParser {
    pub(super) fn new(
        policy: ProviderApiCompatPolicy,
        preview_context: Option<ProviderPreviewContext>,
    ) -> Self {
        Self {
            reasoning_replay: policy.reasoning_replay(),
            preview_context,
            text: String::new(),
            reasoning_content: String::new(),
            tool_calls: StreamingToolCallAssembler::default(),
            usage: None,
            finish_reason: None,
            text_emitted: false,
            done: false,
        }
    }

    pub(super) fn process_event(&mut self, event: &[u8]) -> Result<(), OpenAiChatError> {
        let event = std::str::from_utf8(event).map_err(|error| {
            OpenAiChatError::invalid_response(format!("invalid SSE UTF-8: {error}"))
        })?;
        let mut data_lines = Vec::new();
        for raw_line in event.lines() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            if let Some(data) = line.strip_prefix("data:") {
                data_lines.push(data.strip_prefix(' ').unwrap_or(data));
            }
        }
        if data_lines.is_empty() {
            return Ok(());
        }
        let data = data_lines.join("\n");
        if data.trim() == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        let value: Value = serde_json::from_str(&data).map_err(|error| {
            OpenAiChatError::invalid_response(format!("invalid streaming JSON chunk: {error}"))
        })?;
        self.process_json_chunk(&value)
    }

    fn process_json_chunk(&mut self, value: &Value) -> Result<(), OpenAiChatError> {
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(|| OpenAiChatError::invalid_response("streaming chunk missing choices"))?;
        if choices.is_empty() {
            if value.get("usage").is_some() {
                self.usage = parse_usage(value.get("usage"))?;
            }
            return Ok(());
        }

        if value.get("usage").is_some() {
            self.usage = parse_usage(value.get("usage"))?;
        }

        let choice = choices
            .first()
            .ok_or_else(|| OpenAiChatError::invalid_response("missing first choice"))?;
        if let Some(finish_reason) = choice.get("finish_reason") {
            match finish_reason {
                Value::String(value) => self.finish_reason = Some(value.clone()),
                Value::Null => {}
                _ => {
                    return Err(OpenAiChatError::invalid_response(
                        "finish_reason must be a string",
                    ));
                }
            }
        }
        let Some(delta) = choice.get("delta") else {
            return Ok(());
        };
        let delta = delta
            .as_object()
            .ok_or_else(|| OpenAiChatError::invalid_response("delta must be an object"))?;

        self.accumulate_visible_delta(delta, "content")?;
        self.accumulate_visible_delta(delta, "refusal")?;

        self.accumulate_reasoning(delta);
        if let Some(tool_calls) = delta.get("tool_calls") {
            self.tool_calls.push_delta(tool_calls)?;
        }
        Ok(())
    }

    fn accumulate_visible_delta(
        &mut self,
        delta: &Map<String, Value>,
        key: &str,
    ) -> Result<(), OpenAiChatError> {
        match delta.get(key) {
            Some(Value::String(content)) if !content.is_empty() => {
                self.text.push_str(content);
                self.text_emitted = true;
                if let Some(context) = self.preview_context.as_ref() {
                    context
                        .sink
                        .publish(LlmTextPreviewFrame::text_delta(&context.metadata, content));
                }
            }
            Some(Value::String(_)) | Some(Value::Null) | None => {}
            Some(_) => {
                return Err(OpenAiChatError::invalid_response(format!(
                    "delta {key} must be a string"
                )));
            }
        }
        Ok(())
    }

    fn accumulate_reasoning(&mut self, delta: &Map<String, Value>) {
        if !self.reasoning_replay.enabled {
            return;
        }
        if let Some(value) = delta.get("reasoning_content").and_then(Value::as_str) {
            self.reasoning_content.push_str(value);
        }
    }

    pub(super) fn finish(self, body_bytes: usize) -> Result<StreamingResponse, OpenAiChatError> {
        let tool_calls = self.tool_calls.finish()?;
        let text = (!self.text.is_empty()).then_some(self.text);
        let finish_reason = self.finish_reason.as_deref();
        let stop_reason = classify_assistant_payload(finish_reason, text.as_deref(), &tool_calls)?;
        let assistant_replay = (self.reasoning_replay.store_assistant_replay(&tool_calls)
            && !self.reasoning_content.is_empty())
        .then(|| AssistantMessageReplay::reasoning_content(self.reasoning_content));
        if let Some(context) = self.preview_context.as_ref() {
            context.sink.publish(LlmTextPreviewFrame::finished(
                &context.metadata,
                self.text_emitted,
                stop_reason,
            ));
        }

        Ok(StreamingResponse {
            response: ProviderResponse {
                text,
                tool_calls,
                assistant_replay,
                usage: self.usage,
                stop_reason,
                metadata: None,
            },
            body_bytes,
        })
    }
}

#[derive(Default)]
pub(super) struct StreamingToolCallAssembler {
    parts: BTreeMap<usize, StreamingToolCallPart>,
}

impl StreamingToolCallAssembler {
    pub(super) fn push_delta(&mut self, value: &Value) -> Result<(), OpenAiChatError> {
        let calls = value.as_array().ok_or_else(|| {
            OpenAiChatError::invalid_response("delta.tool_calls must be an array")
        })?;
        for call in calls {
            let index = call
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| {
                    OpenAiChatError::invalid_response("delta.tool_calls missing valid index")
                })?;
            let part = self.parts.entry(index).or_default();
            match call.get("type") {
                Some(Value::String(call_type)) if call_type == "function" => {}
                Some(Value::String(_)) => {
                    return Err(OpenAiChatError::invalid_response(
                        "tool call type must be function",
                    ));
                }
                Some(Value::Null) | None => {}
                Some(_) => {
                    return Err(OpenAiChatError::invalid_response(
                        "tool call type must be function",
                    ));
                }
            }
            if let Some(id) = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                part.set_id(id);
            }
            let Some(function) = call.get("function") else {
                continue;
            };
            let function = function.as_object().ok_or_else(|| {
                OpenAiChatError::invalid_response("delta.tool_calls function must be an object")
            })?;
            if let Some(name) = function
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
            {
                part.set_name(name);
            }
            match function.get("arguments") {
                Some(Value::String(arguments)) => part.arguments.push_str(arguments),
                Some(Value::Null) | None => {}
                Some(_) => {
                    return Err(OpenAiChatError::invalid_response(
                        "delta.tool_calls function.arguments must be a string",
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) fn finish(self) -> Result<Vec<ToolCall>, OpenAiChatError> {
        self.parts
            .into_iter()
            .map(|(index, part)| part.finish(index))
            .collect()
    }
}

#[derive(Default)]
struct StreamingToolCallPart {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    conflict: Option<String>,
}

impl StreamingToolCallPart {
    fn set_id(&mut self, id: &str) {
        match self.id.as_deref() {
            Some(existing) if existing != id => {
                self.conflict = Some("conflicting tool call id fragments".to_owned());
            }
            Some(_) => {}
            None => self.id = Some(id.to_owned()),
        }
    }

    fn set_name(&mut self, name: &str) {
        match self.name.as_deref() {
            Some(existing) if existing != name => {
                self.conflict = Some("conflicting tool call name fragments".to_owned());
            }
            Some(_) => {}
            None => self.name = Some(name.to_owned()),
        }
    }

    fn finish(self, index: usize) -> Result<ToolCall, OpenAiChatError> {
        let id = self.id.ok_or_else(|| {
            OpenAiChatError::invalid_response(format!("tool call {index} missing id"))
        })?;
        let name = self.name.ok_or_else(|| {
            OpenAiChatError::invalid_response(format!("tool call {index} missing name"))
        })?;
        let arguments = if self.arguments.is_empty() {
            "{}".to_owned()
        } else {
            self.arguments
        };
        if let Some(conflict) = self.conflict {
            return Ok(ToolCall::invalid_arguments(id, name, arguments, conflict));
        }
        Ok(tool_call_from_arguments(id, name, arguments))
    }
}
