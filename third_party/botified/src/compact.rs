use serde::{Deserialize, Serialize};

use crate::files::FileStore;
use crate::message_render::{
    render_content_part_for_text, render_content_part_for_text_with_file_store,
};
use crate::provider::{ProviderRequest, ProviderResponse};
use crate::types::{
    AssistantMessageReplay, ContentPart, Message, StopReason, ToolCall, ToolResult,
};

pub const DEFAULT_COMPACT_THRESHOLD_TOKENS: usize = 1_000_000;
pub const DEFAULT_COMPACT_KEEP_RECENT_TOKENS: usize = 32_000;
const IMAGE_TOKEN_ESTIMATE: usize = 1_200;
const TOOL_RESULT_SUMMARY_MAX_CHARS: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactConfig {
    pub enabled: bool,
    pub threshold_tokens: usize,
    pub keep_recent_tokens: usize,
}

impl Default for CompactConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold_tokens: DEFAULT_COMPACT_THRESHOLD_TOKENS,
            keep_recent_tokens: DEFAULT_COMPACT_KEEP_RECENT_TOKENS,
        }
    }
}

impl CompactConfig {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactPlan {
    pub tokens_before: usize,
    pub retained_start: usize,
}

pub fn maybe_plan_compaction(messages: &[Message], config: &CompactConfig) -> Option<CompactPlan> {
    if !config.enabled {
        return None;
    }

    let tokens_before = context_tokens(messages);
    if tokens_before <= config.threshold_tokens || messages.len() < 2 {
        return None;
    }

    let retained_start = retained_start(messages, config.keep_recent_tokens);
    if retained_start == 0 {
        return None;
    }

    Some(CompactPlan {
        tokens_before,
        retained_start,
    })
}

pub fn build_compaction_request(system_prompt: String, messages: &[Message]) -> ProviderRequest {
    build_compaction_request_with_file_store(system_prompt, messages, None)
}

pub fn build_compaction_request_with_file_store(
    system_prompt: String,
    messages: &[Message],
    file_store: Option<&FileStore>,
) -> ProviderRequest {
    ProviderRequest::new(
        system_prompt,
        vec![Message::user(vec![ContentPart::text(summary_prompt(
            messages, file_store,
        ))])],
        Vec::new(),
    )
}

pub fn summary_message(summary: impl AsRef<str>) -> Message {
    Message::user(vec![ContentPart::text(format!(
        "Compaction summary:\n{}",
        summary.as_ref().trim()
    ))])
}

pub fn response_summary(response: ProviderResponse) -> Result<String, String> {
    if response.stop_reason == StopReason::ProviderStop {
        return Err(
            "compaction provider stopped before completing summary: provider_stop".to_owned(),
        );
    }
    if !response.tool_calls.is_empty() {
        return Err("compaction response contained tool calls".to_owned());
    }
    if response.stop_reason != StopReason::EndTurn {
        return Err("compaction response did not end the turn".to_owned());
    }
    let Some(text) = response.text else {
        return Err("compaction response did not contain text".to_owned());
    };
    if text.trim().is_empty() {
        return Err("compaction response was empty".to_owned());
    }
    Ok(text)
}

pub fn estimate_messages_tokens(messages: &[Message]) -> usize {
    messages.iter().map(estimate_message_tokens).sum()
}

pub fn context_tokens(messages: &[Message]) -> usize {
    messages
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::Assistant {
                usage: Some(usage), ..
            } if usage.total_tokens > 0 => Some(usage.total_tokens as usize),
            _ => None,
        })
        .unwrap_or_else(|| estimate_messages_tokens(messages))
}

pub fn estimate_message_tokens(message: &Message) -> usize {
    match message {
        Message::User { content } => estimate_chars(content_chars(content)),
        Message::Assistant {
            content,
            tool_calls,
            assistant_replay,
            ..
        } => {
            let mut chars = content.as_ref().map_or(0, |text| text.chars().count());
            chars += assistant_replay_chars(assistant_replay);
            for call in tool_calls {
                chars += tool_call_chars(call);
            }
            estimate_chars(chars)
        }
        Message::ToolResult(result) => estimate_chars(tool_result_chars(result)),
    }
}

fn estimate_chars(chars: usize) -> usize {
    chars.div_ceil(4).max(1)
}

fn content_chars(content: &[ContentPart]) -> usize {
    content
        .iter()
        .map(|part| match part {
            ContentPart::Text { text } => text.chars().count(),
            ContentPart::ImageUrl { .. } | ContentPart::ImageBase64 { .. } => {
                IMAGE_TOKEN_ESTIMATE * 4
            }
            ContentPart::File { .. } => render_content_part_for_text(part).chars().count(),
            ContentPart::Skill {
                name,
                path,
                arguments,
            } => {
                name.as_ref().map_or(0, |text| text.chars().count())
                    + path.as_ref().map_or(0, |text| text.chars().count())
                    + arguments.as_ref().map_or(0, |text| text.chars().count())
            }
        })
        .sum()
}

fn tool_call_chars(call: &ToolCall) -> usize {
    call.id.chars().count()
        + call.name.chars().count()
        + call.arguments_json_string().chars().count()
        + call
            .arguments_error
            .as_ref()
            .map_or(0, |text| text.chars().count())
}

fn assistant_replay_chars(replay: &Option<AssistantMessageReplay>) -> usize {
    replay
        .as_ref()
        .and_then(|replay| replay.reasoning_content.as_ref())
        .map_or(0, |text| text.chars().count())
}

fn tool_result_chars(result: &ToolResult) -> usize {
    result.tool_call_id.chars().count()
        + result.tool_name.chars().count()
        + result.text.chars().count()
        + result.details.to_string().chars().count()
}

fn retained_start(messages: &[Message], keep_recent_tokens: usize) -> usize {
    let mut tokens = 0;
    let mut start = messages.len();
    while start > 0 && tokens < keep_recent_tokens {
        start -= 1;
        tokens += estimate_message_tokens(&messages[start]);
    }
    adjust_for_tool_pairs(messages, start)
}

fn adjust_for_tool_pairs(messages: &[Message], start: usize) -> usize {
    let mut adjusted = start;
    loop {
        let mut next = adjusted;
        for (index, message) in messages.iter().enumerate().take(adjusted) {
            let Message::Assistant { tool_calls, .. } = message else {
                continue;
            };
            if tool_calls.is_empty() {
                continue;
            }
            if retained_has_tool_result(messages, adjusted, tool_calls) {
                next = next.min(index);
            }
        }
        if next == adjusted {
            return adjusted;
        }
        adjusted = next;
    }
}

fn retained_has_tool_result(messages: &[Message], start: usize, tool_calls: &[ToolCall]) -> bool {
    messages.iter().skip(start).any(|message| {
        let Message::ToolResult(result) = message else {
            return false;
        };
        tool_calls.iter().any(|call| call.id == result.tool_call_id)
    })
}

fn summary_prompt(messages: &[Message], file_store: Option<&FileStore>) -> String {
    format!(
        "Summarize the older conversation history for future continuation. Preserve user goals, decisions, constraints, tool calls, tool results, errors, and unresolved work. Do not invent details.\n\nConversation to summarize:\n\n{}",
        serialize_messages_for_summary(messages, file_store)
    )
}

fn serialize_messages_for_summary(messages: &[Message], file_store: Option<&FileStore>) -> String {
    messages
        .iter()
        .filter_map(|message| serialize_message_for_summary(message, file_store))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn serialize_message_for_summary(
    message: &Message,
    file_store: Option<&FileStore>,
) -> Option<String> {
    match message {
        Message::User { content } => Some(format!(
            "[User]: {}",
            serialize_content(content, file_store)
        )),
        Message::Assistant {
            content,
            tool_calls,
            ..
        } => {
            let mut parts = Vec::new();
            if let Some(text) = content.as_deref().filter(|text| !text.is_empty()) {
                parts.push(format!("[Assistant]: {text}"));
            }
            if !tool_calls.is_empty() {
                let calls = tool_calls
                    .iter()
                    .map(|call| {
                        format!(
                            "{}#{}({})",
                            call.name,
                            call.id,
                            call.arguments_json_string()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; ");
                parts.push(format!("[Assistant tool calls]: {calls}"));
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Message::ToolResult(result) => Some(format!(
            "[Tool result {}#{} error={}]: {}",
            result.tool_name,
            result.tool_call_id,
            result.is_error,
            truncate_tool_result(&result.text)
        )),
    }
}

fn serialize_content(content: &[ContentPart], file_store: Option<&FileStore>) -> String {
    content
        .iter()
        .map(|part| render_content_part_for_text_with_file_store(part, file_store))
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate_tool_result(text: &str) -> String {
    let char_count = text.chars().count();
    if char_count <= TOOL_RESULT_SUMMARY_MAX_CHARS {
        return text.to_owned();
    }
    let truncated = text
        .chars()
        .take(TOOL_RESULT_SUMMARY_MAX_CHARS)
        .collect::<String>();
    format!(
        "{}\n\n[... {} more characters truncated]",
        truncated,
        char_count - TOOL_RESULT_SUMMARY_MAX_CHARS
    )
}
