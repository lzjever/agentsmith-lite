use std::collections::HashMap;

use crate::agent_loop::AgentConfig;
use crate::formatting::bounded_chars;
use crate::transcript::repair_provider_transcript;
use crate::types::{ContentPart, Message};

use super::super::ServiceInner;
use super::callback::SUBAGENT_CALLBACK_TEXT_CHARS;

const SUBAGENT_ROLE_INSTRUCTION: &str = "You are an internal subagent branch. Inherited conversation messages are read-only reference context. Only the final user message beginning with \"Botified subagent assignment:\" is the active assignment for this run. Work only on that assignment, keep results concise, and do not assume you can spawn more subagents or publish directly to the user.";
const SUBAGENT_ASSIGNMENT_INSTRUCTION: &str = "Botified subagent assignment:\nTreat every message before this one as read-only reference context. The assignment below is the sole active assignment for this run.\n\nAssignment:\n";

fn subagent_task_instruction(task: &str) -> String {
    format!(
        "{SUBAGENT_ASSIGNMENT_INSTRUCTION}{}",
        bounded_chars(task, SUBAGENT_CALLBACK_TEXT_CHARS)
    )
}

fn branch_inheritance_snapshot_without_current_tool_block(
    messages: Vec<Message>,
    current_tool_call_id: &str,
) -> Vec<Message> {
    let mut filtered = Vec::with_capacity(messages.len());
    let mut index = 0;

    while index < messages.len() {
        let Message::Assistant { tool_calls, .. } = &messages[index] else {
            filtered.push(messages[index].clone());
            index += 1;
            continue;
        };
        if !tool_calls
            .iter()
            .any(|call| call.id == current_tool_call_id)
        {
            filtered.push(messages[index].clone());
            index += 1;
            continue;
        }

        let block_tool_call_ids = tool_calls
            .iter()
            .map(|call| call.id.as_str())
            .collect::<Vec<_>>();
        index += 1;
        while index < messages.len() {
            let Message::ToolResult(result) = &messages[index] else {
                break;
            };
            if !block_tool_call_ids.contains(&result.tool_call_id.as_str()) {
                break;
            }
            index += 1;
        }
    }

    repair_provider_transcript(filtered)
}

impl ServiceInner {
    pub(super) fn initial_subagent_messages(
        &self,
        task: &str,
        inherit_context: bool,
        provider_transcript_snapshot: Option<Vec<Message>>,
        current_tool_call_id: &str,
    ) -> Vec<Message> {
        let mut messages = if inherit_context {
            provider_transcript_snapshot
                .map(|messages| {
                    branch_inheritance_snapshot_without_current_tool_block(
                        messages,
                        current_tool_call_id,
                    )
                })
                .unwrap_or_else(|| {
                    let state = self.state.lock().expect("service state mutex poisoned");
                    repair_provider_transcript(state.context.clone())
                })
        } else {
            Vec::new()
        };
        messages.push(Message::user(vec![ContentPart::text(
            subagent_task_instruction(task),
        )]));
        repair_provider_transcript(messages)
    }

    pub(in crate::service) fn subagent_config(&self) -> AgentConfig {
        let mut config = self.config.clone();
        config.system_prompt = format!("{}\n\n{}", config.system_prompt, SUBAGENT_ROLE_INSTRUCTION);
        if let Some(refresh) = config.prompt_refresh.as_mut() {
            refresh.base_system_prompt = format!(
                "{}\n\n{}",
                refresh.base_system_prompt, SUBAGENT_ROLE_INSTRUCTION
            );
        }
        config.turn_id = None;
        config
    }
}

pub(super) fn push_subagent_user_message_locked(
    contexts: &mut HashMap<String, Vec<Message>>,
    subagent_id: &str,
    message: &str,
) -> Vec<Message> {
    let messages = contexts.entry(subagent_id.to_owned()).or_default();
    messages.push(Message::user(vec![ContentPart::text(
        subagent_task_instruction(message),
    )]));
    *messages = repair_provider_transcript(messages.clone());
    messages.clone()
}
