use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::ServiceEvent;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ThreadEvent {
    #[serde(rename = "thread.started")]
    ThreadStarted { thread_id: String },
    #[serde(rename = "turn.started")]
    TurnStarted,
    #[serde(rename = "item.started")]
    ItemStarted { item: ThreadItem },
    #[serde(rename = "item.updated")]
    ItemUpdated { item: ThreadItem },
    #[serde(rename = "item.completed")]
    ItemCompleted { item: ThreadItem },
    #[serde(rename = "turn.completed")]
    TurnCompleted { usage: AgentUsage },
    #[serde(rename = "turn.failed")]
    TurnFailed { error: EventError },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ThreadItem {
    AgentMessage {
        id: String,
        text: String,
    },
    CommandExecution {
        id: String,
        command: String,
        output_tail: String,
        exit_code: Option<i32>,
        status: CommandExecutionStatus,
    },
    BackgroundTask {
        id: String,
        task_id: String,
        tool_name: String,
        status: BackgroundTaskStatus,
        arguments_summary: Option<String>,
        output_tail: Option<String>,
        output_artifact_path: Option<String>,
        output_live: Option<bool>,
        output_complete: Option<bool>,
        output_bytes: Option<u64>,
        output_last_updated_at: Option<String>,
        output_tail_truncated: Option<bool>,
        output_artifact_truncated: Option<bool>,
        output_dropped_bytes: Option<u64>,
        callback_delivery: Option<String>,
        callback_failure_reason: Option<String>,
    },
    Error {
        id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandExecutionStatus {
    InProgress,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTaskStatus {
    InProgress,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventError {
    pub message: String,
}

pub fn project_thread_event(event: &ServiceEvent) -> Option<ThreadEvent> {
    match event.event_type.as_str() {
        "turn.started" => Some(ThreadEvent::TurnStarted),
        "assistant.message" => {
            event
                .data
                .get("text")
                .and_then(Value::as_str)
                .map(|text| ThreadEvent::ItemCompleted {
                    item: ThreadItem::AgentMessage {
                        id: format!("item_{}", event.seq),
                        text: text.to_owned(),
                    },
                })
        }
        "tool.started" => command_execution_started(event),
        "tool.completed" => command_execution_completed(event),
        "task.detached" => background_task_started(event),
        "task.completed" => background_task_terminal(event, BackgroundTaskStatus::Completed),
        "task.failed" => background_task_terminal(event, BackgroundTaskStatus::Failed),
        "task.cancelled" => background_task_terminal(event, BackgroundTaskStatus::Cancelled),
        "task.timed_out" => background_task_terminal(event, BackgroundTaskStatus::TimedOut),
        "task.callback_pending" | "task.callback_queued" | "task.callback_failed" => {
            background_task_callback_delivery(event)
        }
        "turn.completed" => Some(ThreadEvent::TurnCompleted {
            usage: agent_usage(event.data.get("usage")),
        }),
        "agent.error" | "agent.aborted" => {
            let message = event
                .data
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("agent run failed")
                .to_owned();
            Some(ThreadEvent::TurnFailed {
                error: EventError { message },
            })
        }
        _ => None,
    }
}

pub fn is_public_terminal_event(event: &ThreadEvent) -> bool {
    matches!(
        event,
        ThreadEvent::TurnCompleted { .. } | ThreadEvent::TurnFailed { .. }
    )
}

fn agent_usage(value: Option<&Value>) -> AgentUsage {
    let Some(value) = value else {
        return AgentUsage::default();
    };

    AgentUsage {
        input_tokens: usage_field(value, "input_tokens", "input"),
        cached_input_tokens: usage_field(value, "cached_input_tokens", "cached_input"),
        output_tokens: usage_field(value, "output_tokens", "output"),
        reasoning_output_tokens: usage_field(value, "reasoning_output_tokens", "reasoning_output"),
    }
}

fn usage_field(value: &Value, public_key: &str, raw_key: &str) -> u64 {
    value
        .get(public_key)
        .or_else(|| value.get(raw_key))
        .and_then(Value::as_u64)
        .unwrap_or_default()
}

fn command_execution_started(event: &ServiceEvent) -> Option<ThreadEvent> {
    if event
        .data
        .get("background_detach_candidate")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    if event.data.get("tool_name").and_then(Value::as_str) != Some("bash") {
        return None;
    }
    let tool_call_id = event.data.get("tool_call_id").and_then(Value::as_str)?;
    let command = event.data.get("command").and_then(Value::as_str)?;
    Some(ThreadEvent::ItemStarted {
        item: ThreadItem::CommandExecution {
            id: command_execution_item_id(tool_call_id),
            command: command.to_owned(),
            output_tail: String::new(),
            exit_code: None,
            status: CommandExecutionStatus::InProgress,
        },
    })
}

fn command_execution_completed(event: &ServiceEvent) -> Option<ThreadEvent> {
    if event
        .data
        .get("detached_ack")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    if event.data.get("tool_name").and_then(Value::as_str) != Some("bash") {
        return None;
    }
    let tool_call_id = event.data.get("tool_call_id").and_then(Value::as_str)?;
    let command = event.data.get("command").and_then(Value::as_str)?;
    let output_tail = event
        .data
        .get("output_tail")
        .and_then(Value::as_str)
        .map(|value| crate::types::bounded_text_tail(value, 4096))
        .unwrap_or_default();
    let exit_code = event
        .data
        .get("exit_code")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok());
    let status = match event.data.get("status").and_then(Value::as_str)? {
        "completed" => CommandExecutionStatus::Completed,
        "failed" => CommandExecutionStatus::Failed,
        _ => return None,
    };

    Some(ThreadEvent::ItemCompleted {
        item: ThreadItem::CommandExecution {
            id: command_execution_item_id(tool_call_id),
            command: command.to_owned(),
            output_tail: output_tail.to_owned(),
            exit_code,
            status,
        },
    })
}

fn command_execution_item_id(tool_call_id: &str) -> String {
    format!("item_{tool_call_id}")
}

fn background_task_started(event: &ServiceEvent) -> Option<ThreadEvent> {
    background_task_event(event, BackgroundTaskStatus::InProgress)
        .map(|item| ThreadEvent::ItemStarted { item })
}

fn background_task_terminal(
    event: &ServiceEvent,
    status: BackgroundTaskStatus,
) -> Option<ThreadEvent> {
    background_task_event(event, status).map(|item| ThreadEvent::ItemCompleted { item })
}

fn background_task_callback_delivery(event: &ServiceEvent) -> Option<ThreadEvent> {
    let status = background_task_status_field(event).unwrap_or(BackgroundTaskStatus::Completed);
    background_task_event(event, status).map(|item| ThreadEvent::ItemUpdated { item })
}

fn background_task_event(event: &ServiceEvent, status: BackgroundTaskStatus) -> Option<ThreadItem> {
    let task_id = event.data.get("task_id").and_then(Value::as_str)?;
    let tool_name = event.data.get("tool_name").and_then(Value::as_str)?;

    Some(ThreadItem::BackgroundTask {
        id: background_task_item_id(task_id),
        task_id: task_id.to_owned(),
        tool_name: tool_name.to_owned(),
        status,
        arguments_summary: bounded_string_field(&event.data, "arguments_summary", 512),
        output_tail: bounded_string_field(&event.data, "output_tail", 4096),
        output_artifact_path: bounded_string_field(&event.data, "output_artifact_path", 4096),
        output_live: bool_field(&event.data, "output_live"),
        output_complete: bool_field(&event.data, "output_complete"),
        output_bytes: u64_field(&event.data, "output_bytes"),
        output_last_updated_at: bounded_string_field(&event.data, "output_last_updated_at", 128),
        output_tail_truncated: bool_field(&event.data, "output_tail_truncated"),
        output_artifact_truncated: bool_field(&event.data, "output_artifact_truncated"),
        output_dropped_bytes: u64_field(&event.data, "output_dropped_bytes"),
        callback_delivery: bounded_string_field(&event.data, "callback_delivery", 64),
        callback_failure_reason: bounded_string_field(&event.data, "callback_failure_reason", 512),
    })
}

fn background_task_item_id(task_id: &str) -> String {
    format!("item_{task_id}")
}

fn background_task_status_field(event: &ServiceEvent) -> Option<BackgroundTaskStatus> {
    match event.data.get("status").and_then(Value::as_str)? {
        "in_progress" | "running" => Some(BackgroundTaskStatus::InProgress),
        "completed" => Some(BackgroundTaskStatus::Completed),
        "failed" | "lost" => Some(BackgroundTaskStatus::Failed),
        "cancelled" | "cancelling" => Some(BackgroundTaskStatus::Cancelled),
        "timed_out" => Some(BackgroundTaskStatus::TimedOut),
        _ => None,
    }
}

fn bounded_string_field(data: &Value, key: &str, max_chars: usize) -> Option<String> {
    data.get(key)
        .and_then(Value::as_str)
        .map(|value| value.chars().take(max_chars).collect())
}

fn bool_field(data: &Value, key: &str) -> Option<bool> {
    data.get(key).and_then(Value::as_bool)
}

fn u64_field(data: &Value, key: &str) -> Option<u64> {
    data.get(key).and_then(Value::as_u64)
}
