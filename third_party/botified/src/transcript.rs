use serde_json::json;
use thiserror::Error;

use crate::types::{assistant_payload_is_valid, Message, ModelInput, ToolCall, ToolResult};

const SYNTHETIC_MISSING_TOOL_RESULT_KIND: &str = "synthetic_missing_tool_result";
const SYNTHETIC_MISSING_TOOL_RESULT_TEXT: &str =
    "Synthetic error result inserted because the original tool result was missing from a previous interrupted run.";

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TranscriptError {
    #[error("assistant message at index {index} must include non-empty content or tool_calls")]
    EmptyAssistant { index: usize },
    #[error(
        "tool_result at index {index} with tool_call_id {tool_call_id:?} is not immediately after a matching assistant tool_call"
    )]
    OrphanToolResult { index: usize, tool_call_id: String },
    #[error(
        "assistant tool_call block at index {assistant_index} is missing tool_result messages for tool_call_id(s): {}",
        missing_tool_call_ids.join(", ")
    )]
    IncompleteToolCallBlock {
        assistant_index: usize,
        missing_tool_call_ids: Vec<String>,
    },
    #[error(
        "tool_result at index {index} with tool_call_id {tool_call_id:?} does not match pending assistant tool_call ids"
    )]
    UnexpectedToolResult { index: usize, tool_call_id: String },
    #[error(
        "tool_result at index {index} with tool_call_id {tool_call_id:?} duplicates a prior result in the same assistant tool_call block"
    )]
    DuplicateToolResult { index: usize, tool_call_id: String },
}

pub fn validate_provider_transcript(messages: &[Message]) -> Result<(), TranscriptError> {
    let items = messages
        .iter()
        .enumerate()
        .map(|(index, message)| ReplayItem::from_message(index, message))
        .collect::<Vec<_>>();
    validate_replay_items(&items)
}

pub fn validate_provider_model_input(input: &[ModelInput]) -> Result<(), TranscriptError> {
    let items = input
        .iter()
        .enumerate()
        .map(|(index, input)| ReplayItem::from_model_input(index, input))
        .collect::<Vec<_>>();
    validate_replay_items(&items)
}

pub fn repair_provider_transcript(messages: Vec<Message>) -> Vec<Message> {
    let mut repaired = Vec::with_capacity(messages.len());
    let mut pending: Option<PendingToolCallBlock> = None;

    for message in messages {
        match message {
            Message::User { .. } => {
                close_pending_block(&mut repaired, &mut pending);
                repaired.push(message);
            }
            Message::Assistant {
                ref content,
                ref tool_calls,
                ..
            } if !assistant_payload_is_valid(content.as_deref(), tool_calls) => {
                continue;
            }
            Message::Assistant { ref tool_calls, .. } if tool_calls.is_empty() => {
                close_pending_block(&mut repaired, &mut pending);
                repaired.push(message);
            }
            Message::Assistant { ref tool_calls, .. } => {
                close_pending_block(&mut repaired, &mut pending);
                pending = Some(PendingToolCallBlock::from_tool_calls(tool_calls));
                repaired.push(message);
            }
            Message::ToolResult(result) => {
                let Some(block) = pending.as_mut() else {
                    continue;
                };
                if block.mark_seen(&result.tool_call_id) {
                    repaired.push(Message::ToolResult(result));
                    if block.is_complete() {
                        pending = None;
                    }
                }
            }
        }
    }

    close_pending_block(&mut repaired, &mut pending);
    repaired
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplayRole {
    User,
    Assistant,
    ToolResult,
    Context,
}

#[derive(Debug, Clone, Copy)]
struct ReplayItem<'a> {
    index: usize,
    role: ReplayRole,
    content: Option<&'a str>,
    tool_calls: &'a [ToolCall],
    tool_result: Option<&'a ToolResult>,
}

impl<'a> ReplayItem<'a> {
    fn from_message(index: usize, message: &'a Message) -> Self {
        match message {
            Message::User { .. } => Self::plain(index, ReplayRole::User),
            Message::Assistant {
                content,
                tool_calls,
                ..
            } => Self {
                index,
                role: ReplayRole::Assistant,
                content: content.as_deref(),
                tool_calls,
                tool_result: None,
            },
            Message::ToolResult(result) => Self {
                index,
                role: ReplayRole::ToolResult,
                content: None,
                tool_calls: &[],
                tool_result: Some(result),
            },
        }
    }

    fn from_model_input(index: usize, input: &'a ModelInput) -> Self {
        match input {
            ModelInput::Context { .. } => Self::plain(index, ReplayRole::Context),
            ModelInput::Message { message } => Self::from_message(index, message),
        }
    }

    fn plain(index: usize, role: ReplayRole) -> Self {
        Self {
            index,
            role,
            content: None,
            tool_calls: &[],
            tool_result: None,
        }
    }
}

fn validate_replay_items(items: &[ReplayItem<'_>]) -> Result<(), TranscriptError> {
    let mut index = 0;
    while index < items.len() {
        let item = items[index];
        match item.role {
            ReplayRole::User | ReplayRole::Context => {
                index += 1;
            }
            ReplayRole::ToolResult => {
                let result = item
                    .tool_result
                    .expect("tool result role should include a tool result");
                return Err(TranscriptError::OrphanToolResult {
                    index: item.index,
                    tool_call_id: result.tool_call_id.clone(),
                });
            }
            ReplayRole::Assistant => {
                if !assistant_payload_is_valid(item.content, item.tool_calls) {
                    return Err(TranscriptError::EmptyAssistant { index: item.index });
                }
                if item.tool_calls.is_empty() {
                    index += 1;
                    continue;
                }
                let consumed = validate_tool_result_block(items, index)?;
                index += consumed;
            }
        }
    }
    Ok(())
}

fn validate_tool_result_block(
    items: &[ReplayItem<'_>],
    assistant_position: usize,
) -> Result<usize, TranscriptError> {
    let assistant = items[assistant_position];
    let mut expected = PendingToolCallBlock::from_tool_calls(assistant.tool_calls);
    let mut consumed = 1;

    while !expected.is_complete() {
        let Some(item) = items.get(assistant_position + consumed).copied() else {
            return Err(TranscriptError::IncompleteToolCallBlock {
                assistant_index: assistant.index,
                missing_tool_call_ids: expected.missing_ids(),
            });
        };
        let ReplayRole::ToolResult = item.role else {
            return Err(TranscriptError::IncompleteToolCallBlock {
                assistant_index: assistant.index,
                missing_tool_call_ids: expected.missing_ids(),
            });
        };
        let result = item
            .tool_result
            .expect("tool result role should include a tool result");
        match expected.mark_seen_status(&result.tool_call_id) {
            MarkSeenStatus::SeenNow => {
                consumed += 1;
            }
            MarkSeenStatus::AlreadySeen => {
                return Err(TranscriptError::DuplicateToolResult {
                    index: item.index,
                    tool_call_id: result.tool_call_id.clone(),
                });
            }
            MarkSeenStatus::Unknown => {
                return Err(TranscriptError::UnexpectedToolResult {
                    index: item.index,
                    tool_call_id: result.tool_call_id.clone(),
                });
            }
        }
    }

    Ok(consumed)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingToolCallBlock {
    calls: Vec<PendingToolCall>,
}

impl PendingToolCallBlock {
    fn from_tool_calls(tool_calls: &[ToolCall]) -> Self {
        Self {
            calls: tool_calls
                .iter()
                .map(|call| PendingToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    seen: false,
                })
                .collect(),
        }
    }

    fn mark_seen(&mut self, tool_call_id: &str) -> bool {
        self.mark_seen_status(tool_call_id) == MarkSeenStatus::SeenNow
    }

    fn mark_seen_status(&mut self, tool_call_id: &str) -> MarkSeenStatus {
        let Some(call) = self.calls.iter_mut().find(|call| call.id == tool_call_id) else {
            return MarkSeenStatus::Unknown;
        };
        if call.seen {
            MarkSeenStatus::AlreadySeen
        } else {
            call.seen = true;
            MarkSeenStatus::SeenNow
        }
    }

    fn is_complete(&self) -> bool {
        self.calls.iter().all(|call| call.seen)
    }

    fn missing_ids(&self) -> Vec<String> {
        self.calls
            .iter()
            .filter(|call| !call.seen)
            .map(|call| call.id.clone())
            .collect()
    }

    fn missing_results(&self) -> Vec<ToolResult> {
        self.calls
            .iter()
            .filter(|call| !call.seen)
            .map(|call| synthetic_missing_tool_result(&call.id, &call.name))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingToolCall {
    id: String,
    name: String,
    seen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkSeenStatus {
    SeenNow,
    AlreadySeen,
    Unknown,
}

fn close_pending_block(repaired: &mut Vec<Message>, pending: &mut Option<PendingToolCallBlock>) {
    let Some(block) = pending.take() else {
        return;
    };
    repaired.extend(block.missing_results().into_iter().map(Message::ToolResult));
}

fn synthetic_missing_tool_result(tool_call_id: &str, tool_name: &str) -> ToolResult {
    ToolResult::error(
        tool_call_id,
        tool_name,
        SYNTHETIC_MISSING_TOOL_RESULT_TEXT,
        json!({ "kind": SYNTHETIC_MISSING_TOOL_RESULT_KIND }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ContentPart, StopReason};

    #[test]
    fn repair_inserts_synthetic_results_for_interrupted_tool_call_block() {
        let first = ToolCall::new("call_1", "lookup", json!({}));
        let second = ToolCall::new("call_2", "search", json!({}));
        let repaired = repair_provider_transcript(vec![
            Message::assistant_tool_calls(vec![first.clone(), second.clone()]),
            Message::tool_result(ToolResult::success("call_1", "lookup", "ok")),
            Message::user(vec![ContentPart::text("next")]),
        ]);

        assert_eq!(repaired.len(), 4);
        assert!(matches!(
            &repaired[2],
            Message::ToolResult(result)
                if result.tool_call_id == "call_2"
                    && result.tool_name == "search"
                    && result.is_error
                    && result.details["kind"] == json!(SYNTHETIC_MISSING_TOOL_RESULT_KIND)
        ));
        assert!(matches!(&repaired[3], Message::User { .. }));
        validate_provider_transcript(&repaired).expect("repaired transcript should validate");
    }

    #[test]
    fn repair_filters_empty_assistant_and_orphan_tool_result() {
        let repaired = repair_provider_transcript(vec![
            Message::ToolResult(ToolResult::success("orphan", "lookup", "ignored")),
            Message::Assistant {
                content: None,
                tool_calls: Vec::new(),
                assistant_replay: None,
                usage: None,
                stop_reason: Some(StopReason::EndTurn),
            },
            Message::assistant_text("kept"),
        ]);

        assert_eq!(repaired, vec![Message::assistant_text("kept")]);
        validate_provider_transcript(&repaired).expect("repaired transcript should validate");
    }

    #[test]
    fn validate_rejects_context_interrupted_tool_call_block() {
        let input = vec![
            ModelInput::message(Message::assistant_tool_calls(vec![ToolCall::new(
                "call_1",
                "lookup",
                json!({}),
            )])),
            ModelInput::context(crate::types::ContextRole::User, "inserted context"),
            ModelInput::message(Message::tool_result(ToolResult::success(
                "call_1", "lookup", "ok",
            ))),
        ];

        let error = validate_provider_model_input(&input)
            .expect_err("context must not interrupt tool_call block");

        assert!(matches!(
            error,
            TranscriptError::IncompleteToolCallBlock { .. }
        ));
    }
}
