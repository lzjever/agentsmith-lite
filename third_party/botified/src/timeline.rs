use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::event::{EventCursor, ServiceEvent};

pub const TIMELINE_VERSION: &str = "botified.timeline.v1";
const MAX_TIMELINE_TEXT_CHARS: usize = 512;
const MAX_TIMELINE_LABEL_CHARS: usize = 128;
const MAX_TIMELINE_CALLBACKS: usize = 8;
const DEFAULT_CANCELLED_SUBAGENT_TOMBSTONES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineTrace {
    pub cycle_id: Option<String>,
}

impl TimelineTrace {
    pub fn new(cycle_id: Option<String>) -> Self {
        Self { cycle_id }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub status: String,
}

impl TimelineItem {
    pub fn new(
        id: impl Into<String>,
        item_type: impl Into<String>,
        status: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            item_type: item_type.into(),
            status: status.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineActiveItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<TimelineTrace>,
    pub data: Value,
}

impl TimelineActiveItem {
    fn new(item: &TimelineItem, cycle_id: Option<&str>, data: Value) -> Self {
        Self {
            id: item.id.clone(),
            item_type: item.item_type.clone(),
            status: item.status.clone(),
            trace: cycle_id.map(|cycle_id| TimelineTrace::new(Some(cycle_id.to_owned()))),
            data,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TimelineActiveProjection {
    items: BTreeMap<String, TimelineActiveItem>,
    item_cycles: BTreeMap<String, String>,
    cancelled_subagents: BTreeMap<String, u64>,
}

impl TimelineActiveProjection {
    pub fn apply_event(&mut self, event: &ServiceEvent) {
        self.apply_event_with_cancelled_subagent_limit(
            event,
            DEFAULT_CANCELLED_SUBAGENT_TOMBSTONES,
        );
    }

    pub(crate) fn apply_event_with_cancelled_subagent_limit(
        &mut self,
        event: &ServiceEvent,
        cancelled_subagent_limit: usize,
    ) {
        self.apply_detached_command_cleanup(event);

        let projected = project_event_fields(event);
        let Some(item) = projected.item.as_ref() else {
            return;
        };

        if item.item_type == "subagent" {
            if item.status == "cancelled" {
                self.remember_cancelled_subagent(&item.id, event.seq, cancelled_subagent_limit);
                self.remove(&item.id);
                return;
            }
            if self.cancelled_subagents.contains_key(&item.id) {
                return;
            }
        }

        match item.item_type.as_str() {
            "cycle" if item.status == "running" => {
                self.insert(item, projected.cycle_id.as_deref(), projected.data);
            }
            "cycle" => {
                self.remove(&item.id);
                if let Some(cycle_id) = projected.cycle_id.as_deref() {
                    self.remove_cycle_items(cycle_id);
                }
            }
            "provider_request" | "command_execution" if item.status == "running" => {
                self.insert(item, projected.cycle_id.as_deref(), projected.data);
            }
            "provider_request" | "command_execution" => {
                self.remove_if_cycle_matches(&item.id, projected.cycle_id.as_deref());
            }
            "task_ask" if item.status == "pending" => {
                self.insert(item, projected.cycle_id.as_deref(), projected.data);
            }
            "task_ask" => {
                self.remove(&item.id);
            }
            "subagent" if matches!(item.status.as_str(), "running" | "open") => {
                self.insert(item, projected.cycle_id.as_deref(), projected.data);
            }
            _ => {}
        }
    }

    pub fn items(&self) -> Vec<TimelineActiveItem> {
        self.items.values().cloned().collect()
    }

    fn insert(&mut self, item: &TimelineItem, cycle_id: Option<&str>, data: Value) {
        if self
            .items
            .get(&item.id)
            .is_some_and(|existing| active_item_identity_conflicts(existing, item, cycle_id))
        {
            return;
        }
        self.items.insert(
            item.id.clone(),
            TimelineActiveItem::new(item, cycle_id, data),
        );
        if let Some(cycle_id) = cycle_id {
            self.item_cycles
                .insert(item.id.clone(), cycle_id.to_owned());
        } else {
            self.item_cycles.remove(&item.id);
        }
    }

    fn remove(&mut self, item_id: &str) {
        self.items.remove(item_id);
        self.item_cycles.remove(item_id);
    }

    fn remember_cancelled_subagent(&mut self, item_id: &str, seq: u64, limit: usize) {
        self.cancelled_subagents.insert(item_id.to_owned(), seq);
        self.trim_cancelled_subagents(limit.max(1));
    }

    fn trim_cancelled_subagents(&mut self, limit: usize) {
        while self.cancelled_subagents.len() > limit {
            let Some(oldest_id) = self
                .cancelled_subagents
                .iter()
                .min_by(|(left_id, left_seq), (right_id, right_seq)| {
                    left_seq.cmp(right_seq).then_with(|| left_id.cmp(right_id))
                })
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            self.cancelled_subagents.remove(&oldest_id);
        }
    }

    fn remove_if_cycle_matches(&mut self, item_id: &str, cycle_id: Option<&str>) {
        let should_remove = self
            .items
            .get(item_id)
            .is_some_and(|item| active_item_cycle(item) == cycle_id || cycle_id.is_none());
        if should_remove {
            self.remove(item_id);
        }
    }

    fn remove_cycle_items(&mut self, cycle_id: &str) {
        let item_ids = self
            .item_cycles
            .iter()
            .filter(|(_, item_cycle_id)| *item_cycle_id == cycle_id)
            .map(|(item_id, _)| item_id.clone())
            .collect::<Vec<_>>();
        for item_id in item_ids {
            self.remove(&item_id);
        }
    }

    fn apply_detached_command_cleanup(&mut self, event: &ServiceEvent) {
        if event.event_type == "tool.completed" && bool_field(&event.data, "detached_ack", false) {
            if let Some(tool_call_id) = event.data.get("tool_call_id").and_then(Value::as_str) {
                self.remove(&command_execution_item_id(tool_call_id));
            }
        }
        if event.event_type == "task.detached" {
            if let Some(tool_call_id) = event.data.get("tool_call_id").and_then(Value::as_str) {
                self.remove(&command_execution_item_id(tool_call_id));
            }
        }
    }
}

fn active_item_identity_conflicts(
    existing: &TimelineActiveItem,
    item: &TimelineItem,
    cycle_id: Option<&str>,
) -> bool {
    existing.item_type != item.item_type || active_item_cycle(existing) != cycle_id
}

fn active_item_cycle(item: &TimelineActiveItem) -> Option<&str> {
    item.trace
        .as_ref()
        .and_then(|trace| trace.cycle_id.as_deref())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineEnvelope {
    pub version: String,
    pub seq: u64,
    pub cursor: String,
    pub time: String,
    pub session_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub trace: TimelineTrace,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<TimelineItem>,
    pub data: Value,
}

impl TimelineEnvelope {
    pub fn active_item(&self) -> Option<TimelineActiveItem> {
        self.item.as_ref().map(|item| TimelineActiveItem {
            id: item.id.clone(),
            item_type: item.item_type.clone(),
            status: item.status.clone(),
            trace: Some(self.trace.clone()),
            data: self.data.clone(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new(
        seq: u64,
        cursor: EventCursor,
        time: impl Into<String>,
        session_id: impl Into<String>,
        event_type: impl Into<String>,
        trace: TimelineTrace,
        item: Option<TimelineItem>,
        data: Value,
    ) -> Result<Self, TimelineEnvelopeError> {
        if !cursor.is_timeline() {
            return Err(TimelineEnvelopeError::NonTimelineCursor);
        }
        if cursor.seq() != seq {
            return Err(TimelineEnvelopeError::CursorSeqMismatch);
        }

        Ok(Self {
            version: TIMELINE_VERSION.to_owned(),
            seq,
            cursor: cursor.to_string(),
            time: time.into(),
            session_id: session_id.into(),
            event_type: event_type.into(),
            trace,
            item,
            data,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelineEnvelopeError {
    NonTimelineCursor,
    CursorSeqMismatch,
}

pub fn project_timeline_event(
    event: &ServiceEvent,
    process_instance: &str,
) -> Result<TimelineEnvelope, TimelineEnvelopeError> {
    let cursor = EventCursor::for_instance(process_instance, event.seq)
        .map_err(|_| TimelineEnvelopeError::NonTimelineCursor)?;
    let projected = project_event_fields(event);
    TimelineEnvelope::new(
        event.seq,
        cursor,
        event.time.clone(),
        event
            .session
            .clone()
            .unwrap_or_else(|| "thread_local".to_owned()),
        projected.event_type,
        TimelineTrace::new(projected.cycle_id),
        projected.item,
        projected.data,
    )
}

pub fn push_timeline_event_line(
    body: &mut Vec<u8>,
    envelope: &TimelineEnvelope,
) -> Result<(), serde_json::Error> {
    serde_json::to_writer(&mut *body, envelope)?;
    body.push(b'\n');
    Ok(())
}

pub(crate) fn input_item_id(input_id: &str) -> String {
    format!("inp_{}", short_hash_len_prefixed_parts(&[input_id]))
}

pub(crate) fn task_ask_item_id(task_id: &str, request_id: &str) -> String {
    format!("task_ask_{task_id}_{request_id}")
}

struct ProjectedEvent {
    event_type: String,
    cycle_id: Option<String>,
    item: Option<TimelineItem>,
    data: Value,
}

fn project_event_fields(event: &ServiceEvent) -> ProjectedEvent {
    match event.event_type.as_str() {
        "message.received" => input_event(event, "input.accepted", "accepted"),
        "message.queued" => input_event(event, "input.queued", "queued"),
        "message.rejected" => input_event(event, "input.rejected", "rejected"),
        "queue.drained" => input_drained_event(event),
        "queue.pressure" => queue_pressure_event(event),
        "cycle.started" => cycle_started_event(event),
        "provider.started" => provider_request_event(event, "started", "running"),
        "provider.completed" => provider_request_event(event, "completed", "completed"),
        "provider.failed" => provider_request_event(event, "failed", "failed"),
        "assistant.message" => assistant_message_event(event),
        "turn.completed" => cycle_completed_event(event),
        "tool.started" => {
            command_execution_started_event(event).unwrap_or_else(|| service_event(event))
        }
        "tool.completed" => {
            command_execution_completed_event(event).unwrap_or_else(|| service_event(event))
        }
        "file.published" => file_published_event(event),
        event_type if event_type.starts_with("task_ask.") => task_request_event(event),
        event_type if event_type.starts_with("task_tell.") => task_tell_event(event),
        event_type if event_type.starts_with("task_reply.") => task_reply_event(event),
        event_type if event_type.starts_with("task_send.") => task_send_event(event),
        event_type if event_type.starts_with("task.") => background_task_event(event),
        "subagent.started"
        | "subagent.completed"
        | "subagent.failed"
        | "subagent.cancelled"
        | "subagent.callback"
        | "subagent.callback_delivered" => subagent_event(event),
        "service.status" => service_status_event(event),
        event_type if event_type.starts_with("compact.") => compact_service_event(event),
        "agent.error" | "agent.aborted" if cycle_id_from_data(event).is_some() => {
            cycle_failed_event(event)
        }
        "agent.error" | "agent.aborted" => service_error_event(event),
        _ => service_event(event),
    }
}

fn input_event(event: &ServiceEvent, event_type: &str, status: &str) -> ProjectedEvent {
    let input_id = event
        .data
        .get("input_id")
        .or_else(|| event.data.get("message_id"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let mut data = json!({
        "input_id": input_id,
        "input_kind": string_field(&event.data, "input_kind", "user_message"),
        "source": string_field(&event.data, "source", "unknown"),
        "message_id": string_field(&event.data, "message_id", input_id),
        "content_preview": string_field(&event.data, "content_preview", ""),
        "content_bytes": u64_field(&event.data, "content_bytes", 0),
        "content_truncated": bool_field(&event.data, "content_truncated", false),
        "content_kind": string_field(&event.data, "content_kind", "text"),
        "queue_length": u64_field(&event.data, "queue_length", 0),
    });
    if let Some(queue_position) = event.data.get("queue_position").and_then(Value::as_u64) {
        data["queue_position"] = json!(queue_position);
    }
    if let Some(reason) = event.data.get("reason").and_then(Value::as_str) {
        data["reason"] = json!(reason);
    }
    if let Some(text) = event.data.get("text").and_then(Value::as_str) {
        data["text"] = json!(text);
    }
    if let Some(urgency) = event.data.get("urgency") {
        data["urgency"] = urgency.clone();
    }
    if let Some(object) = data.as_object_mut() {
        for key in [
            "task_id",
            "ask_id",
            "tell_id",
            "subagent_id",
            "callback_id",
            "callback_kind",
            "callback_status",
            "task_label",
            "label",
            "summary",
        ] {
            if let Some(value) = event.data.get(key).filter(|value| !value.is_null()) {
                object.insert(key.to_owned(), value.clone());
            }
        }
    }
    if event_type == "input.rejected" {
        let reason = event
            .data
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("input_rejected");
        data["error"] = error_object(event, reason, "input rejected", false);
    } else if let Some(error) = event.data.get("error") {
        data["error"] = error.clone();
    }

    ProjectedEvent {
        event_type: event_type.to_owned(),
        cycle_id: None,
        item: Some(TimelineItem::new(input_item_id(input_id), "input", status)),
        data,
    }
}

fn input_drained_event(event: &ServiceEvent) -> ProjectedEvent {
    let input_ids = event
        .data
        .get("input_ids")
        .or_else(|| event.data.get("message_ids"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let cycle_id = format!("cyc_{}", event.seq);
    ProjectedEvent {
        event_type: "input.drained".to_owned(),
        cycle_id: Some(cycle_id),
        item: None,
        data: json!({
            "input_ids": input_ids,
            "input_sources": event.data.get("input_sources").cloned().unwrap_or_else(|| json!({})),
            "input_previews": event.data.get("input_previews").cloned().unwrap_or_else(|| json!({})),
            "queue_length": u64_field(&event.data, "queue_length", 0),
        }),
    }
}

fn queue_pressure_event(event: &ServiceEvent) -> ProjectedEvent {
    ProjectedEvent {
        event_type: "queue.pressure".to_owned(),
        cycle_id: cycle_id_from_data(event),
        item: Some(TimelineItem::new("queue", "queue_state", "limited")),
        data: json!({
            "queue_length": u64_field(&event.data, "queue_length", 0),
            "max_queue_messages": u64_field(&event.data, "max_queue_messages", 0),
            "max_queue_bytes": u64_field(&event.data, "max_queue_bytes", 0),
            "input_rejected": bool_field(&event.data, "input_rejected", false),
            "error": error_object(event, "queue_full", "message queue is full", true),
        }),
    }
}

fn cycle_started_event(event: &ServiceEvent) -> ProjectedEvent {
    let cycle_id = cycle_id_from_data(event).unwrap_or_else(|| format!("cyc_{}", event.seq));
    let input_ids = event
        .data
        .get("input_ids")
        .or_else(|| event.data.get("message_ids"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    ProjectedEvent {
        event_type: "cycle.started".to_owned(),
        cycle_id: Some(cycle_id.clone()),
        item: Some(TimelineItem::new(cycle_id.clone(), "cycle", "running")),
        data: json!({
            "cycle_id": cycle_id,
            "input_ids": input_ids,
            "input_sources": event.data.get("input_sources").cloned().unwrap_or_else(|| json!({})),
            "input_previews": event.data.get("input_previews").cloned().unwrap_or_else(|| json!({})),
            "queue_length": u64_field(&event.data, "queue_length", 0),
        }),
    }
}

fn cycle_completed_event(event: &ServiceEvent) -> ProjectedEvent {
    let cycle_id = cycle_id_from_data(event);
    let item = cycle_id
        .as_ref()
        .map(|cycle_id| TimelineItem::new(cycle_id.clone(), "cycle", "completed"));
    let provider_request_count = u64_field(
        &event.data,
        "provider_request_count",
        u64_field(&event.data, "provider_calls", 0),
    );
    ProjectedEvent {
        event_type: "cycle.completed".to_owned(),
        cycle_id: cycle_id.clone(),
        item,
        data: json!({
            "cycle_id": cycle_id.clone().unwrap_or_else(|| "unknown".to_owned()),
            "input_ids": event.data.get("input_ids").cloned().unwrap_or_else(|| json!([])),
            "provider_request_count": provider_request_count,
            "provider_calls": u64_field(&event.data, "provider_calls", 0),
            "queue_length": u64_field(&event.data, "queue_length", 0),
            "stop_reason": event.data.get("stop_reason").cloned().unwrap_or(Value::Null),
            "usage": event.data.get("usage").cloned().unwrap_or(Value::Null),
        }),
    }
}

fn cycle_failed_event(event: &ServiceEvent) -> ProjectedEvent {
    let cycle_id = cycle_id_from_data(event);
    let item = cycle_id
        .as_ref()
        .map(|cycle_id| TimelineItem::new(cycle_id.clone(), "cycle", "failed"));
    let error = error_object(
        event,
        if event.event_type == "agent.aborted" {
            "aborted"
        } else {
            "agent_error"
        },
        "cycle failed",
        false,
    );
    let retryable = error
        .get("retryable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    ProjectedEvent {
        event_type: "cycle.failed".to_owned(),
        cycle_id: cycle_id.clone(),
        item,
        data: json!({
            "cycle_id": cycle_id.unwrap_or_else(|| "unknown".to_owned()),
            "input_ids": event.data.get("input_ids").cloned().unwrap_or_else(|| json!([])),
            "queue_length": u64_field(&event.data, "queue_length", 0),
            "error": error,
            "retryable": retryable,
        }),
    }
}

fn provider_request_event(event: &ServiceEvent, suffix: &str, status: &str) -> ProjectedEvent {
    let cycle_id = cycle_id_from_data(event);
    let provider_call_index = u64_field(
        &event.data,
        "provider_call_index",
        u64_field(&event.data, "provider_call", 0),
    );
    let provider_request_id = event
        .data
        .get("provider_request_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| match cycle_id.as_deref() {
            Some(cycle_id) => format!("prq_{cycle_id}_{provider_call_index}"),
            None => format!("prq_unknown_{}", event.seq),
        });

    let mut data = json!({
        "provider_request_id": provider_request_id,
        "provider_call_index": provider_call_index,
        "provider": bounded_provider_label(&event.data),
        "profile": optional_bounded_string_field(&event.data, "profile", MAX_TIMELINE_LABEL_CHARS),
        "name": optional_bounded_string_field(&event.data, "name", MAX_TIMELINE_LABEL_CHARS),
        "model": optional_bounded_string_field(&event.data, "model", MAX_TIMELINE_LABEL_CHARS),
        "capabilities": bounded_string_array_field(&event.data, "capabilities", MAX_TIMELINE_LABEL_CHARS),
    });

    if suffix != "started" {
        data["duration_ms"] = json!(u64_field(&event.data, "duration_ms", 0));
    }
    if suffix == "completed" {
        data["usage"] = event.data.get("usage").cloned().unwrap_or(Value::Null);
        data["stop_reason"] = event
            .data
            .get("stop_reason")
            .cloned()
            .unwrap_or(Value::Null);
    }
    if suffix == "failed" {
        data["error"] = bounded_error(&event.data, "provider_error");
    }

    ProjectedEvent {
        event_type: format!("provider_request.{suffix}"),
        cycle_id,
        item: Some(TimelineItem::new(
            string_field(&data, "provider_request_id", "prq_unknown"),
            "provider_request",
            status,
        )),
        data,
    }
}

fn assistant_message_event(event: &ServiceEvent) -> ProjectedEvent {
    let text = event.data.get("text").and_then(Value::as_str).unwrap_or("");
    let (content_preview, content_truncated) = bounded_text(text, MAX_TIMELINE_TEXT_CHARS);
    let cycle_id = cycle_id_from_data(event);
    let provider_request_id = event
        .data
        .get("provider_request_id")
        .and_then(Value::as_str);
    let message_index = u64_field(&event.data, "message_index", 1);
    let assistant_message_id = if let (Some(cycle_id), Some(provider_request_id)) =
        (cycle_id.as_deref(), provider_request_id)
    {
        format!(
            "asst_{}",
            short_hash_len_prefixed_parts(&[
                cycle_id,
                provider_request_id,
                &message_index.to_string(),
            ])
        )
    } else {
        format!("assistant_{}", event.seq)
    };

    ProjectedEvent {
        event_type: "assistant_message.completed".to_owned(),
        cycle_id,
        item: Some(TimelineItem::new(
            assistant_message_id.clone(),
            "assistant_message",
            "completed",
        )),
        data: json!({
            "assistant_message_id": assistant_message_id,
            "provider_request_id": provider_request_id.unwrap_or("unknown"),
            "message_index": message_index,
            "text": text,
            "content_preview": content_preview,
            "content_bytes": text.len(),
            "content_truncated": content_truncated,
            "content_kind": "text",
            "tool_call_count": u64_field(&event.data, "tool_call_count", 0),
            "usage": event.data.get("usage").cloned().unwrap_or(Value::Null),
            "stop_reason": event.data.get("stop_reason").cloned().unwrap_or(Value::Null),
        }),
    }
}

fn command_execution_started_event(event: &ServiceEvent) -> Option<ProjectedEvent> {
    if bool_field(&event.data, "inline_replay_started", false) {
        return None;
    }
    if event.data.get("tool_name").and_then(Value::as_str) != Some("bash") {
        return None;
    }
    let tool_call_id = event.data.get("tool_call_id").and_then(Value::as_str)?;
    let command = event.data.get("command").and_then(Value::as_str)?;
    let output_tail = output_tail(event);
    let (bounded_output_tail, output_tail_truncated) =
        bounded_text(&output_tail, MAX_TIMELINE_TEXT_CHARS);

    Some(ProjectedEvent {
        event_type: "command_execution.started".to_owned(),
        cycle_id: cycle_id_from_data(event),
        item: Some(TimelineItem::new(
            command_execution_item_id(tool_call_id),
            "command_execution",
            "running",
        )),
        data: json!({
            "tool_call_id": tool_call_id,
            "command": command,
            "output_tail": bounded_output_tail,
            "output_bytes": output_bytes(event, &output_tail),
            "output_complete": false,
            "output_artifact_path": event.data
                .get("output_artifact_path")
                .cloned()
                .unwrap_or(Value::Null),
            "output_tail_truncated": output_tail_truncated
                || bool_field(&event.data, "output_tail_truncated", false),
            "output_artifact_truncated": bool_field(&event.data, "output_artifact_truncated", false),
            "output_dropped_bytes": u64_field(&event.data, "output_dropped_bytes", 0),
            "exit_code": Value::Null,
            "status": string_field(&event.data, "status", "in_progress"),
        }),
    })
}

fn command_execution_completed_event(event: &ServiceEvent) -> Option<ProjectedEvent> {
    if bool_field(&event.data, "detached_ack", false) {
        return None;
    }
    if event.data.get("tool_name").and_then(Value::as_str) != Some("bash") {
        return None;
    }
    let tool_call_id = event.data.get("tool_call_id").and_then(Value::as_str)?;
    let command = event.data.get("command").and_then(Value::as_str)?;
    let output_tail = output_tail(event);
    let (bounded_output_tail, output_tail_truncated) =
        bounded_text(&output_tail, MAX_TIMELINE_TEXT_CHARS);
    let exit_code = event
        .data
        .get("exit_code")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok());
    let status = match event.data.get("status").and_then(Value::as_str) {
        Some("completed") => "completed",
        Some("cancelled") => "cancelled",
        Some("failed") => "failed",
        _ if exit_code == Some(0) => "completed",
        _ => "failed",
    };
    let event_suffix = match status {
        "completed" => "completed",
        "cancelled" => "cancelled",
        _ => "failed",
    };

    Some(ProjectedEvent {
        event_type: format!("command_execution.{event_suffix}"),
        cycle_id: cycle_id_from_data(event),
        item: Some(TimelineItem::new(
            command_execution_item_id(tool_call_id),
            "command_execution",
            status,
        )),
        data: json!({
            "tool_call_id": tool_call_id,
            "command": command,
            "output_tail": bounded_output_tail,
            "output_bytes": output_bytes(event, &output_tail),
            "output_complete": bool_field(&event.data, "output_complete", true),
            "output_artifact_path": event.data
                .get("output_artifact_path")
                .cloned()
                .unwrap_or(Value::Null),
            "output_tail_truncated": output_tail_truncated
                || bool_field(&event.data, "output_tail_truncated", false),
            "output_artifact_truncated": bool_field(&event.data, "output_artifact_truncated", false),
            "output_dropped_bytes": u64_field(&event.data, "output_dropped_bytes", 0),
            "exit_code": exit_code,
            "status": status,
        }),
    })
}

fn command_execution_item_id(tool_call_id: &str) -> String {
    format!("cmd_{tool_call_id}")
}

fn output_tail(event: &ServiceEvent) -> String {
    event
        .data
        .get("output_tail")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn output_bytes(event: &ServiceEvent, output_tail: &str) -> u64 {
    event
        .data
        .get("output_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(output_tail.len() as u64)
}

fn background_task_event(event: &ServiceEvent) -> ProjectedEvent {
    let task_id = string_field(&event.data, "task_id", "unknown");
    let (event_suffix, default_status) = match event.event_type.as_str() {
        "task.detached" => ("started", "running"),
        "task.completed" => ("completed", "completed"),
        "task.failed" => ("failed", "failed"),
        "task.cancelled" => ("cancelled", "cancelled"),
        "task.timed_out" => ("timed_out", "timed_out"),
        "task.lost" => ("lost", "lost"),
        "task.callback_pending" => ("callback_pending", "completed"),
        "task.callback_queued" => ("callback_queued", "completed"),
        "task.callback_delivered" => ("callback_delivered", "completed"),
        "task.callback_failed" => ("callback_failed", "completed"),
        _ => ("updated", "updated"),
    };
    let status = background_task_status(event, default_status);
    ProjectedEvent {
        event_type: format!("background_task.{event_suffix}"),
        cycle_id: cycle_id_from_data(event),
        item: Some(TimelineItem::new(
            format!("task_{task_id}"),
            "background_task",
            status,
        )),
        data: event.data.clone(),
    }
}

fn task_request_event(event: &ServiceEvent) -> ProjectedEvent {
    let task_id = string_field(&event.data, "task_id", "unknown");
    let request_id = string_field(&event.data, "ask_id", "unknown");
    let status = match event.event_type.as_str() {
        "task_ask.requested" => "pending".to_owned(),
        "task_ask.expired" => "expired".to_owned(),
        "task_ask.rejected" => {
            let state = string_field(&event.data, "state", "rejected");
            match state {
                "expired" => "expired".to_owned(),
                "task_terminal" => "task_terminal".to_owned(),
                _ => "rejected".to_owned(),
            }
        }
        _ => string_field(&event.data, "status", "updated").to_owned(),
    };
    ProjectedEvent {
        event_type: event.event_type.clone(),
        cycle_id: cycle_id_from_data(event),
        item: Some(TimelineItem::new(
            task_ask_item_id(task_id, request_id),
            "task_ask",
            status,
        )),
        data: event.data.clone(),
    }
}

fn task_reply_event(event: &ServiceEvent) -> ProjectedEvent {
    let task_id = string_field(&event.data, "task_id", "unknown");
    let request_id = string_field(&event.data, "ask_id", "unknown");
    let item = task_reply_item_status(event)
        .map(|status| TimelineItem::new(task_ask_item_id(task_id, request_id), "task_ask", status));
    ProjectedEvent {
        event_type: event.event_type.clone(),
        cycle_id: cycle_id_from_data(event),
        item,
        data: event.data.clone(),
    }
}

fn task_tell_event(event: &ServiceEvent) -> ProjectedEvent {
    let task_id = string_field(&event.data, "task_id", "unknown");
    let tell_id = string_field(&event.data, "tell_id", "unknown");
    ProjectedEvent {
        event_type: event.event_type.clone(),
        cycle_id: cycle_id_from_data(event),
        item: Some(TimelineItem::new(
            format!("task_tell_{task_id}_{tell_id}"),
            "task_tell",
            string_field(&event.data, "status", "updated"),
        )),
        data: event.data.clone(),
    }
}

fn task_send_event(event: &ServiceEvent) -> ProjectedEvent {
    let task_id = string_field(&event.data, "task_id", "unknown");
    let send_id = string_field(&event.data, "send_id", "unknown");
    ProjectedEvent {
        event_type: event.event_type.clone(),
        cycle_id: cycle_id_from_data(event),
        item: Some(TimelineItem::new(
            format!("task_send_{task_id}_{send_id}"),
            "task_send",
            string_field(&event.data, "status", "updated"),
        )),
        data: event.data.clone(),
    }
}

fn task_reply_item_status(event: &ServiceEvent) -> Option<String> {
    match event.event_type.as_str() {
        "task_reply.written" => Some("written".to_owned()),
        "task_reply.accepted" => Some("accepted".to_owned()),
        "task_reply.failed" => terminal_task_reply_state(event).map(ToOwned::to_owned),
        _ => None,
    }
}

fn file_published_event(event: &ServiceEvent) -> ProjectedEvent {
    let file_id = string_field(&event.data, "file_id", "unknown");
    ProjectedEvent {
        event_type: "file.published".to_owned(),
        cycle_id: cycle_id_from_data(event),
        item: Some(TimelineItem::new(file_id, "file", "published")),
        data: json!({
            "file_id": file_id,
            "filename": string_field(&event.data, "filename", ""),
            "mime_type": string_field(&event.data, "mime_type", "application/octet-stream"),
            "size_bytes": u64_field(&event.data, "size_bytes", 0),
            "sha256": string_field(&event.data, "sha256", ""),
            "download_url": string_field(&event.data, "download_url", ""),
            "source": string_field(&event.data, "source", "published"),
            "description": event.data.get("description").cloned().unwrap_or(Value::Null),
        }),
    }
}

fn terminal_task_reply_state(event: &ServiceEvent) -> Option<&'static str> {
    match event.data.get("state").and_then(Value::as_str) {
        Some("write_failed") => Some("failed"),
        Some("expired") => Some("expired"),
        Some("rejected") => Some("rejected"),
        Some("task_terminal") => Some("task_terminal"),
        Some("written") => Some("written"),
        _ => None,
    }
}

fn background_task_status(event: &ServiceEvent, default_status: &str) -> String {
    for key in ["state", "status"] {
        if let Some(status) = event.data.get(key).and_then(Value::as_str) {
            if let Some(status) = normalize_background_task_status(status) {
                return status.to_owned();
            }
        }
    }
    default_status.to_owned()
}

fn normalize_background_task_status(status: &str) -> Option<&'static str> {
    match status {
        "in_progress" | "running" => Some("running"),
        "completed" => Some("completed"),
        "failed" => Some("failed"),
        "timed_out" => Some("timed_out"),
        "cancelled" => Some("cancelled"),
        "cancelling" => Some("cancelling"),
        "lost" => Some("lost"),
        _ => None,
    }
}

fn subagent_event(event: &ServiceEvent) -> ProjectedEvent {
    let subagent_id = string_field(&event.data, "subagent_id", "unknown");
    let item_status = subagent_item_status(event);
    let status_summary = string_field(&event.data, "status_summary", item_status);
    let status = string_field(&event.data, "status", status_summary);

    let mut data = json!({
        "subagent_id": bounded_text(subagent_id, MAX_TIMELINE_LABEL_CHARS).0,
        "name": bounded_text(string_field(&event.data, "name", "unnamed"), MAX_TIMELINE_LABEL_CHARS).0,
        "purpose": bounded_text(string_field(&event.data, "purpose", ""), MAX_TIMELINE_TEXT_CHARS).0,
        "status": bounded_text(status, MAX_TIMELINE_LABEL_CHARS).0,
        "status_summary": bounded_text(status_summary, MAX_TIMELINE_LABEL_CHARS).0,
        "latest_result": optional_string_field(&event.data, "latest_result"),
        "latest_error": optional_string_field(&event.data, "latest_error"),
        "owned_task_count": u64_field(&event.data, "owned_task_count", 0),
        "latest_callback": bounded_callback_summary(event.data.get("latest_callback")),
    });

    if let Some(object) = data.as_object_mut() {
        for key in [
            "projection_id",
            "callback_id",
            "callback_kind",
            "callback_status",
            "semantic_kind",
            "semantic_status",
            "task_id",
            "ask_id",
            "tell_id",
            "task_label",
            "label",
            "summary",
            "reply_status",
        ] {
            if let Some(value) = optional_bounded_string_field_value(&event.data, key) {
                object.insert(key.to_owned(), value);
            }
        }
        if let Some(callbacks) = bounded_callback_summaries(event.data.get("callbacks")) {
            object.insert("callbacks".to_owned(), callbacks);
        }
        for key in ["task_message", "question", "notice"] {
            let value = optional_string_field(&event.data, key);
            if !value.is_null() {
                object.insert(key.to_owned(), value);
            }
        }
    }

    ProjectedEvent {
        event_type: event.event_type.clone(),
        cycle_id: None,
        item: Some(TimelineItem::new(
            format!("subagent_{subagent_id}"),
            "subagent",
            item_status,
        )),
        data,
    }
}

fn subagent_item_status(event: &ServiceEvent) -> &'static str {
    if event.event_type == "subagent.cancelled"
        || event.data.get("lifecycle").and_then(Value::as_str) == Some("cancelled")
        || event.data.get("status_summary").and_then(Value::as_str) == Some("cancelled")
    {
        "cancelled"
    } else if event.event_type == "subagent.started"
        || event.data.get("run_state").and_then(Value::as_str) == Some("running")
        || event.data.get("status_summary").and_then(Value::as_str) == Some("running")
    {
        "running"
    } else {
        "open"
    }
}

fn optional_bounded_string_field_value(data: &Value, key: &str) -> Option<Value> {
    data.get(key)
        .and_then(Value::as_str)
        .map(|value| json!(bounded_text(value, MAX_TIMELINE_LABEL_CHARS).0))
}

fn bounded_callback_summary(callback: Option<&Value>) -> Value {
    let Some(callback) = callback.and_then(Value::as_object) else {
        return Value::Null;
    };
    json!({
        "callback_id": callback
            .get("callback_id")
            .and_then(Value::as_str)
            .map(|value| bounded_text(value, MAX_TIMELINE_LABEL_CHARS).0),
        "kind": callback
            .get("kind")
            .and_then(Value::as_str)
            .map(|value| bounded_text(value, MAX_TIMELINE_LABEL_CHARS).0),
        "status": callback
            .get("status")
            .and_then(Value::as_str)
            .map(|value| bounded_text(value, MAX_TIMELINE_LABEL_CHARS).0),
        "failure_reason": callback
            .get("failure_reason")
            .and_then(Value::as_str)
            .map(|value| bounded_text(value, MAX_TIMELINE_TEXT_CHARS).0),
    })
}

fn bounded_callback_summaries(callbacks: Option<&Value>) -> Option<Value> {
    let callbacks = callbacks?.as_array()?;
    Some(json!(callbacks
        .iter()
        .take(MAX_TIMELINE_CALLBACKS)
        .map(|callback| bounded_callback_summary(Some(callback)))
        .collect::<Vec<_>>()))
}

fn service_error_event(event: &ServiceEvent) -> ProjectedEvent {
    let error = error_object(event, "service_error", "service error", false);
    ProjectedEvent {
        event_type: "service.error".to_owned(),
        cycle_id: cycle_id_from_data(event),
        item: Some(TimelineItem::new(
            format!("err_evt_{}", event.seq),
            "error",
            "failed",
        )),
        data: json!({
            "code": string_field(&error, "code", "service_error"),
            "message": string_field(&error, "message", "service error"),
            "retryable": bool_field(&error, "retryable", false),
        }),
    }
}

fn service_status_event(event: &ServiceEvent) -> ProjectedEvent {
    let state = string_field(&event.data, "state", "updated");
    let mut data = json!({
        "state": state,
        "queue_length": u64_field(&event.data, "queue_length", 0),
        "tasks": event.data.get("tasks").cloned().unwrap_or_else(|| json!({
            "running": 0,
            "cancelling": 0,
            "pending_callbacks": 0
        })),
        "last_error": event.data.get("last_error").cloned().unwrap_or(Value::Null),
    });
    if let Some(context_maintenance) = event.data.get("context_maintenance") {
        data["context_maintenance"] = context_maintenance.clone();
    }
    ProjectedEvent {
        event_type: "service.status".to_owned(),
        cycle_id: cycle_id_from_data(event),
        item: Some(TimelineItem::new("service", "service_status", state)),
        data,
    }
}

fn compact_service_event(event: &ServiceEvent) -> ProjectedEvent {
    let mut data = Map::new();
    data.insert(
        "raw_event_type".to_owned(),
        Value::String(event.event_type.clone()),
    );
    if let Some(status) = event
        .event_type
        .strip_prefix("compact.")
        .filter(|status| !status.is_empty())
    {
        data.insert(
            "status".to_owned(),
            json!(bounded_text(status, MAX_TIMELINE_LABEL_CHARS).0),
        );
    }
    for key in ["reason", "source"] {
        if let Some(value) = event.data.get(key).and_then(Value::as_str) {
            data.insert(
                key.to_owned(),
                json!(bounded_text(value, MAX_TIMELINE_LABEL_CHARS).0),
            );
        }
    }
    if let Some(summary) = event.data.get("summary").and_then(Value::as_str) {
        data.insert(
            "summary".to_owned(),
            json!(bounded_text(summary, MAX_TIMELINE_TEXT_CHARS).0),
        );
    }
    for key in ["degraded", "volatile"] {
        if let Some(value) = event.data.get(key).and_then(Value::as_bool) {
            data.insert(key.to_owned(), json!(value));
        }
    }

    ProjectedEvent {
        event_type: "service.event".to_owned(),
        cycle_id: cycle_id_from_data(event),
        item: None,
        data: Value::Object(data),
    }
}

fn service_event(event: &ServiceEvent) -> ProjectedEvent {
    let mut data = match event.data.clone() {
        Value::Object(object) => Value::Object(object),
        other => json!({ "raw": other }),
    };
    if let Some(object) = data.as_object_mut() {
        object.insert(
            "raw_event_type".to_owned(),
            Value::String(event.event_type.clone()),
        );
    }
    ProjectedEvent {
        event_type: "service.event".to_owned(),
        cycle_id: cycle_id_from_data(event),
        item: None,
        data,
    }
}

fn string_field<'a>(data: &'a Value, key: &str, default: &'a str) -> &'a str {
    data.get(key).and_then(Value::as_str).unwrap_or(default)
}

fn u64_field(data: &Value, key: &str, default: u64) -> u64 {
    data.get(key).and_then(Value::as_u64).unwrap_or(default)
}

fn bool_field(data: &Value, key: &str, default: bool) -> bool {
    data.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn cycle_id_from_data(event: &ServiceEvent) -> Option<String> {
    event
        .data
        .get("cycle_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn bounded_provider_label(data: &Value) -> String {
    let value = data
        .get("provider")
        .and_then(Value::as_str)
        .or_else(|| data.get("profile").and_then(Value::as_str))
        .unwrap_or("unknown");
    bounded_text(value, MAX_TIMELINE_LABEL_CHARS).0
}

fn optional_bounded_string_field(data: &Value, key: &str, max_chars: usize) -> Value {
    data.get(key)
        .and_then(Value::as_str)
        .map(|value| json!(bounded_text(value, max_chars).0))
        .unwrap_or(Value::Null)
}

fn optional_string_field(data: &Value, key: &str) -> Value {
    data.get(key)
        .and_then(Value::as_str)
        .map(|value| json!(value))
        .unwrap_or(Value::Null)
}

fn bounded_string_array_field(data: &Value, key: &str, max_chars: usize) -> Value {
    let values = data
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(|value| bounded_text(value, max_chars).0)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!(values)
}

fn bounded_error(data: &Value, default_code: &str) -> Value {
    let error = data.get("error").unwrap_or(&Value::Null);
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or(default_code);
    let message = error
        .get("message")
        .or_else(|| data.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("provider request failed");
    let retryable = error
        .get("retryable")
        .or_else(|| data.get("retryable"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let status = error
        .get("status")
        .or_else(|| data.get("provider_status"))
        .or_else(|| data.get("status"))
        .and_then(Value::as_u64);
    let provider_code = error.get("provider_code").and_then(Value::as_str);

    let mut bounded = json!({
        "code": bounded_text(code, MAX_TIMELINE_LABEL_CHARS).0,
        "message": bounded_text(message, MAX_TIMELINE_TEXT_CHARS).0,
        "retryable": retryable,
    });
    if let Some(object) = bounded.as_object_mut() {
        if let Some(status) = status {
            object.insert("status".to_owned(), json!(status));
        }
        if let Some(provider_code) = provider_code {
            object.insert(
                "provider_code".to_owned(),
                json!(bounded_text(provider_code, MAX_TIMELINE_LABEL_CHARS).0),
            );
        }
    }
    bounded
}

fn error_object(
    event: &ServiceEvent,
    default_code: &str,
    default_message: &str,
    default_retryable: bool,
) -> Value {
    let error = event.data.get("error").unwrap_or(&Value::Null);
    let code = error
        .get("code")
        .or_else(|| event.data.get("code"))
        .and_then(Value::as_str)
        .unwrap_or(default_code);
    let message = error
        .get("message")
        .or_else(|| event.data.get("message"))
        .and_then(Value::as_str)
        .unwrap_or(default_message);
    let retryable = error
        .get("retryable")
        .or_else(|| event.data.get("retryable"))
        .and_then(Value::as_bool)
        .unwrap_or(default_retryable);
    let status = error
        .get("status")
        .or_else(|| event.data.get("provider_status"))
        .or_else(|| event.data.get("status"))
        .and_then(Value::as_u64);
    let provider_code = error.get("provider_code").and_then(Value::as_str);

    let mut projected = json!({
        "code": bounded_text(code, MAX_TIMELINE_LABEL_CHARS).0,
        "message": bounded_text(message, MAX_TIMELINE_TEXT_CHARS).0,
        "retryable": retryable,
    });
    if let Some(object) = projected.as_object_mut() {
        if let Some(status) = status {
            object.insert("status".to_owned(), json!(status));
        }
        if let Some(provider_code) = provider_code {
            object.insert(
                "provider_code".to_owned(),
                json!(bounded_text(provider_code, MAX_TIMELINE_LABEL_CHARS).0),
            );
        }
    }
    projected
}

fn bounded_text(text: &str, max_chars: usize) -> (String, bool) {
    if text.chars().count() <= max_chars {
        return (text.to_owned(), false);
    }
    (text.chars().take(max_chars).collect(), true)
}

fn short_hash_len_prefixed_parts(parts: &[&str]) -> String {
    let mut source = Vec::new();
    for value in parts {
        source.extend_from_slice(value.len().to_string().as_bytes());
        source.push(b':');
        source.extend_from_slice(value.as_bytes());
    }
    let digest = sha256(&source);
    let mut hex = String::with_capacity(32);
    for byte in &digest[..16] {
        hex.push(hex_char(byte >> 4));
        hex.push(hex_char(byte & 0x0f));
    }
    hex
}

fn hex_char(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'a' + value - 10) as char,
        _ => unreachable!("hex nibble should be <= 15"),
    }
}

fn sha256(input: &[u8]) -> [u8; 32] {
    const H0: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut bytes = input.to_vec();
    bytes.push(0x80);
    while bytes.len() % 64 != 56 {
        bytes.push(0);
    }
    bytes.extend_from_slice(&bit_len.to_be_bytes());

    let mut h = H0;
    for chunk in bytes.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (index, word) in w.iter_mut().take(16).enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes([
                chunk[offset],
                chunk[offset + 1],
                chunk[offset + 2],
                chunk[offset + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut digest = [0u8; 32];
    for (index, word) in h.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_cancelled_bash_as_cancelled_command_execution() {
        let event = ServiceEvent::new(
            1,
            "tool.completed",
            Some("session-1"),
            Some("turn-1"),
            json!({
                "tool_call_id": "call-cancelled",
                "tool_name": "bash",
                "command": "sleep 120",
                "output_tail": "tool execution aborted",
                "exit_code": Value::Null,
                "status": "cancelled"
            }),
        );

        let projected = project_timeline_event(&event, "testprocess")
            .expect("cancelled command should project");

        assert_eq!(projected.event_type, "command_execution.cancelled");
        assert_eq!(projected.item.expect("command item").status, "cancelled");
        assert_eq!(projected.data["status"], json!("cancelled"));
    }
}
