use crate::files::FileStore;
use crate::message_render::{
    render_content_part_for_text, render_content_part_for_text_with_file_store,
};
use crate::provider::{ProviderMetadata, ProviderRequest, ProviderResponse};
use crate::tools::ToolSpec;
use crate::types::{ContentPart, Message, ModelInput, StopReason, ToolCall, ToolResult};

const IMAGE_TOKEN_ESTIMATE: usize = 1_200;
const TOOL_RESULT_SUMMARY_MAX_CHARS: usize = 2_000;
const MODEL_INPUT_CONTEXT_OVERHEAD_TOKENS: usize = 4;
const MESSAGE_OVERHEAD_TOKENS: usize = 4;
const TOOL_SPEC_OVERHEAD_TOKENS: usize = 8;
const UNKNOWN_CONTEXT_WINDOW_TOKENS: usize = 128_000;
const UNKNOWN_MAX_OUTPUT_TOKENS: usize = 16_000;
const MAX_RESERVED_OUTPUT_TOKENS: usize = 20_000;
const MIN_PRESERVE_RECENT_TOKENS: usize = 2_000;
const MAX_PRESERVE_RECENT_TOKENS: usize = 8_000;
pub(crate) const LOCAL_DEGRADED_RECOVERY_FIRST_LINE: &str =
    "Local degraded recovery summary (not an LLM summary).";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelContextLimits {
    pub context_window_tokens: Option<usize>,
    pub max_output_tokens: Option<usize>,
}

impl ModelContextLimits {
    pub fn unknown() -> Self {
        Self {
            context_window_tokens: None,
            max_output_tokens: None,
        }
    }

    pub fn from_provider_metadata(metadata: &ProviderMetadata) -> Self {
        Self {
            context_window_tokens: metadata
                .context_window_tokens
                .and_then(u64_to_nonzero_usize),
            max_output_tokens: metadata.max_output_tokens.and_then(u64_to_nonzero_usize),
        }
    }
}

impl Default for ModelContextLimits {
    fn default() -> Self {
        Self::unknown()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompactModelLimits {
    pub context_window_tokens: usize,
    pub max_output_tokens: usize,
    pub reserved_output_tokens: usize,
    pub usable_context_tokens: usize,
    pub soft_start_tokens: usize,
    pub hard_stop_tokens: usize,
    pub preserve_recent_tokens: usize,
}

impl CompactModelLimits {
    pub fn from_model_limits(limits: ModelContextLimits) -> Self {
        let context_window_tokens = limits
            .context_window_tokens
            .filter(|tokens| *tokens > 1)
            .unwrap_or(UNKNOWN_CONTEXT_WINDOW_TOKENS);
        let default_max_output_tokens = UNKNOWN_MAX_OUTPUT_TOKENS
            .min(context_window_tokens.saturating_sub(1))
            .max(1);
        let max_output_tokens = limits
            .max_output_tokens
            .filter(|tokens| *tokens > 0)
            .unwrap_or(default_max_output_tokens)
            .min(context_window_tokens.saturating_sub(1))
            .max(1);
        let reserved_output_tokens = max_output_tokens.min(MAX_RESERVED_OUTPUT_TOKENS);
        let usable_context_tokens = context_window_tokens
            .saturating_sub(reserved_output_tokens)
            .max(1);
        let soft_start_tokens = floor_ratio(usable_context_tokens, 85, 100);
        let hard_stop_tokens = usable_context_tokens;
        let preserve_recent_tokens = (usable_context_tokens / 4)
            .clamp(MIN_PRESERVE_RECENT_TOKENS, MAX_PRESERVE_RECENT_TOKENS);

        Self {
            context_window_tokens,
            max_output_tokens,
            reserved_output_tokens,
            usable_context_tokens,
            soft_start_tokens,
            hard_stop_tokens,
            preserve_recent_tokens,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompactPolicy {
    limits: CompactModelLimits,
}

impl CompactPolicy {
    pub fn from_model_limits(limits: ModelContextLimits) -> Self {
        Self {
            limits: CompactModelLimits::from_model_limits(limits),
        }
    }

    pub fn from_provider_metadata(metadata: &ProviderMetadata) -> Self {
        Self::from_model_limits(ModelContextLimits::from_provider_metadata(metadata))
    }

    pub fn from_resolved_limits(limits: CompactModelLimits) -> Self {
        Self { limits }
    }

    pub fn limits(self) -> CompactModelLimits {
        self.limits
    }
}

impl Default for CompactPolicy {
    fn default() -> Self {
        Self::from_model_limits(ModelContextLimits::unknown())
    }
}

fn u64_to_nonzero_usize(value: u64) -> Option<usize> {
    usize::try_from(value).ok().filter(|value| *value > 0)
}

fn floor_ratio(value: usize, numerator: usize, denominator: usize) -> usize {
    debug_assert!(denominator > 0);
    (value / denominator) * numerator + (value % denominator) * numerator / denominator
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactPlan {
    pub tokens_before: usize,
    pub retained_start: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CompactStartDecision {
    NotNeeded,
    RecoveryRequired {
        reason: &'static str,
    },
    Candidate {
        tokens_before: usize,
        retained_start: usize,
        start_len: usize,
    },
}

pub fn maybe_plan_compaction(messages: &[Message], policy: CompactPolicy) -> Option<CompactPlan> {
    let tokens_before = context_tokens(messages);
    maybe_plan_compaction_with_observed_tokens(messages, policy, tokens_before)
}

pub fn maybe_plan_compaction_with_observed_tokens(
    messages: &[Message],
    policy: CompactPolicy,
    tokens_before: usize,
) -> Option<CompactPlan> {
    let limits = policy.limits();
    if tokens_before < limits.soft_start_tokens || messages.len() < 2 {
        return None;
    }

    let retained_start = retained_start(messages, limits.preserve_recent_tokens);
    if retained_start == 0 {
        return None;
    }

    Some(CompactPlan {
        tokens_before,
        retained_start,
    })
}

pub(crate) fn decide_compaction_start(
    messages: &[Message],
    policy: CompactPolicy,
    current_request_start: usize,
    estimated_input_tokens: usize,
    hard_gate: bool,
) -> CompactStartDecision {
    let transcript_tokens = context_tokens(messages);
    let tokens_before = if hard_gate {
        estimated_input_tokens.max(transcript_tokens)
    } else {
        transcript_tokens
    };
    if tokens_before < policy.limits().soft_start_tokens {
        return CompactStartDecision::NotNeeded;
    }

    let plan = maybe_plan_compaction_with_observed_tokens(messages, policy, tokens_before);
    let Some(plan) = plan else {
        return if hard_gate {
            CompactStartDecision::RecoveryRequired {
                reason: "no_compaction_plan",
            }
        } else {
            CompactStartDecision::NotNeeded
        };
    };

    let retained_start = plan.retained_start.min(current_request_start);
    if retained_start == 0 || retained_start >= messages.len() {
        return if hard_gate {
            CompactStartDecision::RecoveryRequired {
                reason: "no_compaction_boundary",
            }
        } else {
            CompactStartDecision::NotNeeded
        };
    }

    CompactStartDecision::Candidate {
        tokens_before,
        retained_start,
        start_len: messages.len(),
    }
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

#[derive(Debug, Clone, PartialEq)]
pub struct DegradedLocalRecovery {
    summary_content: Vec<ContentPart>,
    retained_messages: Vec<Message>,
    pub retained_start: usize,
}

impl DegradedLocalRecovery {
    pub fn summary_content(&self) -> &[ContentPart] {
        &self.summary_content
    }

    pub fn summary_message(&self) -> Message {
        Message::user(self.summary_content.clone())
    }

    pub fn retained_messages(&self) -> &[Message] {
        &self.retained_messages
    }

    pub fn messages(&self) -> Vec<Message> {
        std::iter::once(self.summary_message())
            .chain(self.retained_messages.clone())
            .collect()
    }
}

pub fn build_degraded_local_recovery(
    messages: &[Message],
    policy: CompactPolicy,
) -> DegradedLocalRecovery {
    let retained_start = retained_start(messages, policy.limits().preserve_recent_tokens);
    build_degraded_local_recovery_from_start(messages, retained_start)
}

pub fn build_degraded_local_recovery_preserving_from(
    messages: &[Message],
    policy: CompactPolicy,
    preserve_start: usize,
) -> DegradedLocalRecovery {
    let retained_start =
        retained_start(messages, policy.limits().preserve_recent_tokens).min(preserve_start);
    build_degraded_local_recovery_from_start(messages, retained_start)
}

fn build_degraded_local_recovery_from_start(
    messages: &[Message],
    retained_start: usize,
) -> DegradedLocalRecovery {
    let retained_start = retained_start.min(messages.len());
    let mut retained_messages = messages
        .iter()
        .take(retained_start)
        .filter(|message| is_bounded_summary_message(message))
        .map(bound_message_for_recovery)
        .collect::<Vec<_>>();
    let retained_recent_messages = messages.len().saturating_sub(retained_start);
    retained_messages.extend(
        messages
            .iter()
            .skip(retained_start)
            .map(bound_message_for_recovery),
    );

    let preserved_summary_messages = retained_messages
        .iter()
        .filter(|message| is_bounded_summary_message(message))
        .count();
    let omitted_older_raw_messages = retained_start.saturating_sub(
        messages
            .iter()
            .take(retained_start)
            .filter(|message| is_bounded_summary_message(message))
            .count(),
    );
    let summary = degraded_local_recovery_summary(
        preserved_summary_messages,
        retained_recent_messages,
        omitted_older_raw_messages,
    );

    DegradedLocalRecovery {
        summary_content: vec![ContentPart::text(summary)],
        retained_messages,
        retained_start,
    }
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
    estimate_messages_tokens(messages)
}

pub fn estimate_provider_request_input_tokens(request: &ProviderRequest) -> usize {
    request
        .input
        .iter()
        .map(estimate_model_input_tokens)
        .sum::<usize>()
        + request
            .tools
            .iter()
            .map(estimate_tool_spec_tokens)
            .sum::<usize>()
}

fn estimate_model_input_tokens(input: &ModelInput) -> usize {
    match input {
        ModelInput::Context { content, .. } => {
            MODEL_INPUT_CONTEXT_OVERHEAD_TOKENS + estimate_text_tokens(content)
        }
        ModelInput::Message { message } => estimate_message_tokens(message),
    }
}

pub fn estimate_message_tokens(message: &Message) -> usize {
    match message {
        Message::User { content } => MESSAGE_OVERHEAD_TOKENS + estimate_content_tokens(content),
        Message::Assistant {
            content,
            tool_calls,
            assistant_replay,
            ..
        } => {
            let mut tokens = MESSAGE_OVERHEAD_TOKENS;
            tokens += content
                .as_ref()
                .map_or(0, |text| estimate_text_tokens(text));
            tokens += assistant_replay
                .as_ref()
                .and_then(|replay| replay.reasoning_content.as_ref())
                .map_or(0, |text| estimate_text_tokens(text));
            for call in tool_calls {
                tokens += estimate_tool_call_tokens(call);
            }
            tokens
        }
        Message::ToolResult(result) => {
            MESSAGE_OVERHEAD_TOKENS + estimate_tool_result_tokens(result)
        }
    }
}

fn estimate_text_tokens(text: &str) -> usize {
    let chars = text.chars().count();
    let char_estimate = chars.div_ceil(4);
    let byte_estimate = text.len().div_ceil(3);
    char_estimate.max(byte_estimate).max(1)
}

fn estimate_content_tokens(content: &[ContentPart]) -> usize {
    content
        .iter()
        .map(|part| match part {
            ContentPart::Text { text } => estimate_text_tokens(text),
            ContentPart::ImageUrl { .. } | ContentPart::ImageBase64 { .. } => IMAGE_TOKEN_ESTIMATE,
            ContentPart::File { .. } => estimate_text_tokens(&render_content_part_for_text(part)),
            ContentPart::Skill {
                name,
                path,
                arguments,
            } => [name.as_deref(), path.as_deref(), arguments.as_deref()]
                .into_iter()
                .flatten()
                .map(estimate_text_tokens)
                .sum(),
        })
        .sum()
}

fn estimate_tool_call_tokens(call: &ToolCall) -> usize {
    estimate_text_tokens(&call.id)
        + estimate_text_tokens(&call.name)
        + estimate_text_tokens(&call.arguments_json_string())
        + call
            .arguments_error
            .as_ref()
            .map_or(0, |text| estimate_text_tokens(text))
}

fn estimate_tool_result_tokens(result: &ToolResult) -> usize {
    estimate_text_tokens(&result.tool_call_id)
        + estimate_text_tokens(&result.tool_name)
        + estimate_text_tokens(&result.bounded_text_for_model())
}

fn estimate_tool_spec_tokens(tool: &ToolSpec) -> usize {
    let chars = serde_json::to_string(tool)
        .map(|text| estimate_text_tokens(&text))
        .unwrap_or_else(|_| {
            estimate_text_tokens(&tool.name)
                + estimate_text_tokens(&tool.description)
                + estimate_text_tokens(&tool.input_schema.to_string())
        });
    TOOL_SPEC_OVERHEAD_TOKENS + chars
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

fn is_bounded_summary_message(message: &Message) -> bool {
    let Message::User { content } = message else {
        return false;
    };
    content.iter().any(|part| match part {
        ContentPart::Text { text } => {
            let text = text.trim_start();
            text.starts_with("Compaction summary:")
                || text.starts_with(LOCAL_DEGRADED_RECOVERY_FIRST_LINE)
        }
        _ => false,
    })
}

fn degraded_local_recovery_summary(
    preserved_summary_messages: usize,
    retained_recent_messages: usize,
    omitted_older_raw_messages: usize,
) -> String {
    format!(
        "{LOCAL_DEGRADED_RECOVERY_FIRST_LINE}\n\n\
This bounded recovery view was generated locally because normal compaction could not produce a usable model summary. Full history remains in the session/timeline files.\n\n\
Preserved prior bounded summary messages: {preserved_summary_messages}\n\
Retained recent transcript messages: {retained_recent_messages}\n\
Omitted older raw transcript messages: {omitted_older_raw_messages}\n\n\
No facts were inferred beyond retained prior summaries and retained recent messages."
    )
}

fn summary_prompt(messages: &[Message], file_store: Option<&FileStore>) -> String {
    format!(
        "Summarize the older conversation history as a concise handoff document for continuing the same task. Use this exact structure:\n\n## Current Objective\n## User Preferences / Constraints\n## Completed Work\n## Active Work\n## Background Tasks / Subagents\n## Important Files / Artifacts\n## Errors / Open Questions\n## Next Step\n\nRules:\n- Preserve exact paths, commands, IDs, error strings, task labels, and subagent names.\n- Do not invent details. If the transcript does not establish a fact, write `(none)` or `unknown`.\n- Files must be summarized from file binding manifests only; do not claim file contents were read unless the transcript includes them.\n- Registry state should only be included when it appears in the transcript, such as in a tool result.\n- Background task or subagent state should only be summarized from facts already present in the transcript.\n\nConversation to summarize:\n\n{}",
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
    crate::types::bounded_text_tail_with_notice(text, TOOL_RESULT_SUMMARY_MAX_CHARS)
}

fn bound_message_for_recovery(message: &Message) -> Message {
    match message {
        Message::ToolResult(result) => Message::ToolResult(result.bounded_for_transcript()),
        _ => message.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_text(text: &str) -> Message {
        Message::user(vec![ContentPart::text(text)])
    }

    fn compact_start_policy(
        soft_start_tokens: usize,
        preserve_recent_tokens: usize,
    ) -> CompactPolicy {
        CompactPolicy::from_resolved_limits(CompactModelLimits {
            context_window_tokens: 128,
            max_output_tokens: 8,
            reserved_output_tokens: 8,
            usable_context_tokens: 120,
            soft_start_tokens,
            hard_stop_tokens: 120,
            preserve_recent_tokens,
        })
    }

    #[test]
    fn compact_start_decision_hard_gate_uses_observed_tokens_and_clamps_boundary() {
        let messages = vec![
            user_text("one"),
            user_text("two"),
            user_text("three"),
            user_text("four"),
        ];
        let policy = compact_start_policy(50, 1);

        assert!(
            context_tokens(&messages) < policy.limits().soft_start_tokens,
            "fixture should require observed hard-gate tokens to plan"
        );

        assert_eq!(
            decide_compaction_start(&messages, policy, 2, 80, true),
            CompactStartDecision::Candidate {
                tokens_before: 80,
                retained_start: 2,
                start_len: messages.len(),
            }
        );
    }

    #[test]
    fn compact_start_decision_soft_uses_effective_tokens_from_same_decision() {
        let call = ToolCall::new("call_1", "lookup", serde_json::json!({"q": "status"}));
        let messages = vec![
            user_text("old request"),
            Message::Assistant {
                content: Some("short answer".to_owned()),
                tool_calls: Vec::new(),
                assistant_replay: None,
                usage: Some(crate::types::Usage {
                    input_tokens: 8,
                    cached_input_tokens: 0,
                    output_tokens: 2,
                    reasoning_output_tokens: 0,
                    total_tokens: 10,
                }),
                stop_reason: Some(StopReason::EndTurn),
            },
            user_text("new request with enough input to cross the soft watermark"),
            Message::assistant_tool_calls(vec![call.clone()]),
            Message::tool_result(ToolResult::success(&call.id, &call.name, "new tool result")),
        ];
        let policy = compact_start_policy(50, 1);

        assert!(
            context_tokens(&messages) >= policy.limits().soft_start_tokens,
            "new transcript content after observed usage should cross the soft watermark"
        );

        let transcript_tokens = context_tokens(&messages);

        assert_eq!(
            decide_compaction_start(&messages, policy, 2, 80, false),
            CompactStartDecision::Candidate {
                tokens_before: transcript_tokens,
                retained_start: 2,
                start_len: messages.len(),
            }
        );
    }

    #[test]
    fn compact_start_decision_soft_ignores_non_transcript_request_overhead() {
        let messages = vec![user_text("old"), user_text("current")];
        let policy = compact_start_policy(50, 1);

        assert!(context_tokens(&messages) < policy.limits().soft_start_tokens);
        assert_eq!(
            decide_compaction_start(&messages, policy, 1, 80, false),
            CompactStartDecision::NotNeeded
        );
    }

    #[test]
    fn compact_start_decision_hard_gate_no_plan_requires_recovery() {
        let messages = vec![user_text("only one message")];
        let policy = compact_start_policy(1, 1);

        assert_eq!(
            decide_compaction_start(&messages, policy, 1, 80, true),
            CompactStartDecision::RecoveryRequired {
                reason: "no_compaction_plan",
            }
        );
    }

    #[test]
    fn compact_start_decision_hard_gate_invalid_boundary_requires_recovery() {
        let messages = vec![user_text("old"), user_text("current")];
        let policy = compact_start_policy(1, 1);

        assert_eq!(
            decide_compaction_start(&messages, policy, 0, 80, true),
            CompactStartDecision::RecoveryRequired {
                reason: "no_compaction_boundary",
            }
        );
    }

    #[test]
    fn compact_start_decision_soft_invalid_boundary_is_not_needed() {
        let messages = vec![user_text("old"), user_text("current")];
        let policy = compact_start_policy(1, 1);

        assert_eq!(
            decide_compaction_start(&messages, policy, 0, 80, false),
            CompactStartDecision::NotNeeded
        );
    }
}
