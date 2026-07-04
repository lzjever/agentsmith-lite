use botified::timeline::project_timeline_event;
use botified::{
    EventCursor, EventLog, ServiceEvent, TimelineEnvelope, TimelineEnvelopeError, TimelineItem,
    TimelineTrace, TIMELINE_VERSION,
};
use serde_json::json;

#[test]
fn timeline_envelope_serializes_required_v1_schema_fields() {
    let raw = ServiceEvent::new(
        43,
        "input.accepted",
        Some("internal-session"),
        Some("turn_1"),
        json!({
            "input_id": "client-123",
            "input_kind": "user_message",
            "source": "user"
        }),
    );
    let envelope = TimelineEnvelope::new(
        raw.seq,
        EventCursor::for_instance("p7k3", raw.seq).unwrap(),
        raw.time.clone(),
        "robot-session",
        "input.accepted",
        TimelineTrace::new(None),
        Some(TimelineItem::new("inp_abc123", "input", "accepted")),
        raw.data.clone(),
    )
    .expect("timeline envelope should accept evt cursor");

    let value = serde_json::to_value(&envelope).expect("envelope should serialize");
    let object = value.as_object().expect("envelope should be a JSON object");

    assert_eq!(object.len(), 9);
    for key in [
        "version",
        "seq",
        "cursor",
        "time",
        "session_id",
        "type",
        "trace",
        "item",
        "data",
    ] {
        assert!(object.contains_key(key), "missing envelope key {key}");
    }
    assert_eq!(value["version"], TIMELINE_VERSION);
    assert_eq!(value["seq"], 43);
    assert_eq!(value["cursor"], "evt_p7k3_43");
    assert_eq!(value["session_id"], "robot-session");
    assert_eq!(value["type"], "input.accepted");
    assert_eq!(value["item"]["id"], "inp_abc123");
    assert_eq!(value["item"]["type"], "input");
    assert_eq!(value["item"]["status"], "accepted");

    let trace = value["trace"]
        .as_object()
        .expect("trace should be a JSON object");
    assert_eq!(trace.len(), 1);
    assert!(trace.contains_key("cycle_id"));
    assert!(value["trace"]["cycle_id"].is_null());
}

#[test]
fn timeline_envelope_omits_optional_item_and_keeps_trace_cycle_only() {
    let envelope = TimelineEnvelope::new(
        12,
        EventCursor::for_instance("p7k3", 12).unwrap(),
        "2026-06-19T12:00:00.000Z",
        "robot-session",
        "service.status",
        TimelineTrace::new(Some("cyc_12".to_owned())),
        None,
        json!({
            "state": "running",
            "queue_length": 1
        }),
    )
    .expect("timeline envelope should accept evt cursor");

    let value = serde_json::to_value(&envelope).expect("envelope should serialize");
    let object = value.as_object().expect("envelope should be a JSON object");

    assert_eq!(object.len(), 8);
    assert!(object.get("item").is_none());
    assert_eq!(value["trace"]["cycle_id"], "cyc_12");
    assert_eq!(
        value["trace"]
            .as_object()
            .expect("trace object")
            .keys()
            .collect::<Vec<_>>(),
        vec!["cycle_id"]
    );
}

#[test]
fn timeline_envelope_rejects_message_cursor_family() {
    let error = TimelineEnvelope::new(
        7,
        EventCursor::for_message(7, "client-42"),
        "2026-06-19T12:00:00.000Z",
        "robot-session",
        "input.accepted",
        TimelineTrace::new(None),
        None,
        json!({}),
    )
    .expect_err("timeline envelope must not accept msg_ cursors");

    assert_eq!(error, TimelineEnvelopeError::NonTimelineCursor);

    let invalid_global = EventCursor::Global {
        instance: "bad_id".to_owned(),
        seq: 7,
    };
    let error = TimelineEnvelope::new(
        7,
        invalid_global,
        "2026-06-19T12:00:00.000Z",
        "robot-session",
        "input.accepted",
        TimelineTrace::new(None),
        None,
        json!({}),
    )
    .expect_err("timeline envelope must reject malformed evt_ cursors");

    assert_eq!(error, TimelineEnvelopeError::NonTimelineCursor);
}

#[test]
fn timeline_projects_provider_request_lifecycle() {
    let started = ServiceEvent::new(
        14,
        "provider.started",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "provider_request_id": "prq_cyc_12_1",
            "provider_call_index": 1,
            "provider": "text-main",
            "profile": "text-main",
            "name": "text-main",
            "model": "text-model",
            "capabilities": ["text", "tool_calls"]
        }),
    );
    let completed = ServiceEvent::new(
        16,
        "provider.completed",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "provider_request_id": "prq_cyc_12_1",
            "provider_call_index": 1,
            "provider": "text-main",
            "profile": "text-main",
            "name": "text-main",
            "model": "text-model",
            "capabilities": ["text", "tool_calls"],
            "duration_ms": 27,
            "usage": {
                "input": 10,
                "cached_input": 1,
                "output": 3,
                "reasoning_output": 2,
                "total": 13
            },
            "stop_reason": "end_turn"
        }),
    );
    let failed = ServiceEvent::new(
        18,
        "provider.failed",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "provider_request_id": "prq_cyc_12_2",
            "provider_call_index": 2,
            "provider": "vision-main",
            "profile": "vision-main",
            "name": "vision-main",
            "model": "vision-model",
            "capabilities": ["text", "image"],
            "duration_ms": 31,
            "error": {
                "code": "provider_returned_error",
                "message": "provider returned error status Some(429) code Some(\"rate_limit\"): slow down",
                "retryable": true,
                "status": 429,
                "provider_code": "rate_limit"
            }
        }),
    );

    let started = project_timeline_event(&started, "p7k3").expect("started projection");
    assert_eq!(started.event_type, "provider_request.started");
    assert_eq!(started.trace.cycle_id.as_deref(), Some("cyc_12"));
    assert_eq!(
        started.item,
        Some(TimelineItem::new(
            "prq_cyc_12_1",
            "provider_request",
            "running"
        ))
    );
    assert_eq!(started.data["provider_request_id"], "prq_cyc_12_1");
    assert_eq!(started.data["provider_call_index"], 1);
    assert_eq!(started.data["provider"], "text-main");
    assert_eq!(started.data["profile"], "text-main");
    assert_eq!(started.data["name"], "text-main");
    assert_eq!(started.data["model"], "text-model");
    assert_eq!(started.data["capabilities"], json!(["text", "tool_calls"]));

    let completed = project_timeline_event(&completed, "p7k3").expect("completed projection");
    assert_eq!(completed.event_type, "provider_request.completed");
    assert_eq!(completed.trace.cycle_id.as_deref(), Some("cyc_12"));
    assert_eq!(
        completed.item,
        Some(TimelineItem::new(
            "prq_cyc_12_1",
            "provider_request",
            "completed"
        ))
    );
    assert_eq!(completed.data["duration_ms"], 27);
    assert_eq!(completed.data["provider"], "text-main");
    assert_eq!(completed.data["profile"], "text-main");
    assert_eq!(completed.data["model"], "text-model");
    assert_eq!(
        completed.data["capabilities"],
        json!(["text", "tool_calls"])
    );
    assert_eq!(completed.data["usage"]["input"], 10);
    assert_eq!(completed.data["stop_reason"], "end_turn");

    let failed = project_timeline_event(&failed, "p7k3").expect("failed projection");
    assert_eq!(failed.event_type, "provider_request.failed");
    assert_eq!(failed.trace.cycle_id.as_deref(), Some("cyc_12"));
    assert_eq!(
        failed.item,
        Some(TimelineItem::new(
            "prq_cyc_12_2",
            "provider_request",
            "failed"
        ))
    );
    assert_eq!(failed.data["duration_ms"], 31);
    assert_eq!(failed.data["provider"], "vision-main");
    assert_eq!(failed.data["profile"], "vision-main");
    assert_eq!(failed.data["model"], "vision-model");
    assert_eq!(failed.data["capabilities"], json!(["text", "image"]));
    assert_eq!(failed.data["error"]["code"], "provider_returned_error");
    assert_eq!(
        failed.data["error"]["message"],
        "provider returned error status Some(429) code Some(\"rate_limit\"): slow down"
    );
    assert_eq!(failed.data["error"]["retryable"], true);
    assert_eq!(failed.data["error"]["status"], 429);
    assert_eq!(failed.data["error"]["provider_code"], "rate_limit");
}

#[test]
fn timeline_projects_canonical_service_status_and_raw_service_event() {
    let status = ServiceEvent::new(
        7,
        "service.status",
        Some("session"),
        None,
        json!({
            "state": "running",
            "queue_length": 2,
            "tasks": {
                "running": 1,
                "cancelling": 0,
                "pending_callbacks": 1
            },
            "last_error": null
        }),
    );
    let warning = ServiceEvent::new(
        8,
        "service.warning",
        Some("session"),
        None,
        json!({
            "message": "heads up"
        }),
    );

    let status = project_timeline_event(&status, "p7k3").expect("status projection");
    assert_eq!(status.event_type, "service.status");
    assert_eq!(
        status.item,
        Some(TimelineItem::new("service", "service_status", "running"))
    );
    assert_eq!(status.data["state"], "running");
    assert_eq!(status.data["queue_length"], 2);
    assert_eq!(status.data["tasks"]["running"], 1);
    assert_eq!(status.data["tasks"]["cancelling"], 0);
    assert_eq!(status.data["tasks"]["pending_callbacks"], 1);
    assert!(status.data["last_error"].is_null());
    assert!(status.data.get("raw").is_none());
    assert!(status.data.get("raw_event_type").is_none());

    let warning = project_timeline_event(&warning, "p7k3").expect("warning projection");
    assert_eq!(warning.event_type, "service.event");
    assert!(warning.item.is_none());
    assert_eq!(warning.data["raw_event_type"], "service.warning");
    assert_eq!(warning.data["message"], "heads up");
}

#[test]
fn timeline_projects_subagent_events_as_first_class_summary_items() {
    let started = ServiceEvent::new(
        30,
        "subagent.started",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_main",
            "subagent_id": "sa_review",
            "name": "reviewer",
            "purpose": "review runtime config",
            "lifecycle": "open",
            "run_state": "running",
            "status_summary": "running",
            "latest_result": null,
            "latest_error": null,
            "queued_message_count": 1,
            "owned_task_count": 0,
            "callback_count": 1,
            "pending_callback_count": 1,
            "failed_callback_count": 0,
            "latest_callback": {
                "callback_id": "cb_1",
                "kind": "task_ask",
                "status": "pending",
                "failure_reason": null,
                "tool_payload": {"secret": "do not project"}
            },
            "tail": [{"kind": "sent", "text": "branch internal"}],
            "provider": {"secret": "do not project"},
            "tool_payload": {"secret": "do not project"}
        }),
    );

    let projected = project_timeline_event(&started, "p7k3").expect("subagent projection");

    assert_eq!(projected.event_type, "subagent.started");
    assert_eq!(projected.trace.cycle_id, None);
    assert_eq!(
        projected.item,
        Some(TimelineItem::new(
            "subagent_sa_review",
            "subagent",
            "running"
        ))
    );
    assert_eq!(projected.data["subagent_id"], "sa_review");
    assert_eq!(projected.data["name"], "reviewer");
    assert_eq!(projected.data["purpose"], "review runtime config");
    assert_eq!(projected.data["status"], "running");
    assert_eq!(projected.data["status_summary"], "running");
    assert!(projected.data["latest_result"].is_null());
    assert!(projected.data["latest_error"].is_null());
    assert_eq!(projected.data["owned_task_count"], 0);
    assert_eq!(projected.data["latest_callback"]["callback_id"], "cb_1");
    assert_eq!(projected.data["latest_callback"]["kind"], "task_ask");
    assert_eq!(projected.data["latest_callback"]["status"], "pending");
    assert!(projected.data["latest_callback"]["failure_reason"].is_null());

    for forbidden in [
        "raw_event_type",
        "cycle_id",
        "lifecycle",
        "run_state",
        "queued_message_count",
        "callback_count",
        "pending_callback_count",
        "failed_callback_count",
        "tail",
        "provider",
        "tool_payload",
    ] {
        assert!(
            projected.data.get(forbidden).is_none(),
            "subagent timeline data must not expose {forbidden}: {:?}",
            projected.data
        );
    }
    assert!(
        projected.data["latest_callback"]
            .get("tool_payload")
            .is_none(),
        "callback summary must be bounded: {:?}",
        projected.data["latest_callback"]
    );
}

#[test]
fn event_log_active_projection_keeps_open_subagent_until_cancelled() {
    let mut log = EventLog::with_process_instance("p7k3", 32).expect("event log");

    log.append(
        "queue.drained",
        Some("session"),
        Some("turn_1"),
        json!({
            "message_count": 1,
            "message_ids": ["msg_1"],
            "input_ids": ["msg_1"],
            "input_sources": {"msg_1": "user"},
            "input_previews": {"msg_1": "start work"},
            "queue_length": 0
        }),
    );
    log.append(
        "cycle.started",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_1",
            "input_ids": ["msg_1"],
            "queue_length": 0
        }),
    );
    log.append(
        "subagent.started",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_1",
            "subagent_id": "sa_review",
            "name": "reviewer",
            "purpose": "review runtime config",
            "lifecycle": "open",
            "run_state": "running",
            "status_summary": "running",
            "latest_result": null,
            "latest_error": null,
            "owned_task_count": 0,
            "tail": [{"kind": "sent", "text": "branch internal"}]
        }),
    );

    let active = log.active_timeline_items();
    let subagent = active
        .iter()
        .find(|item| item["id"] == "subagent_sa_review")
        .unwrap_or_else(|| panic!("subagent should be active: {active:?}"));
    assert_eq!(subagent["type"], "subagent");
    assert_eq!(subagent["status"], "running");
    assert!(
        subagent.get("trace").is_none(),
        "subagent active item must not be tied to the main cycle: {subagent:?}"
    );

    log.append(
        "turn.completed",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_1",
            "input_ids": ["msg_1"],
            "provider_request_count": 0,
            "queue_length": 0,
            "stop_reason": "end_turn",
            "usage": null
        }),
    );
    assert!(
        log.active_timeline_items()
            .iter()
            .any(|item| item["id"] == "subagent_sa_review"),
        "main cycle terminal cleanup must not remove subagent active item"
    );

    log.append(
        "subagent.completed",
        Some("session"),
        None,
        json!({
            "cycle_id": "cyc_1",
            "subagent_id": "sa_review",
            "name": "reviewer",
            "purpose": "review runtime config",
            "lifecycle": "open",
            "run_state": "completed",
            "status_summary": "completed",
            "latest_result": "looks good",
            "latest_error": null,
            "owned_task_count": 1,
            "latest_callback": {
                "callback_id": "cb_done",
                "kind": "completed",
                "status": "delivered",
                "failure_reason": null
            },
            "tail": [{"kind": "result", "text": "branch internal"}]
        }),
    );
    let active = log.active_timeline_items();
    let subagent = active
        .iter()
        .find(|item| item["id"] == "subagent_sa_review")
        .unwrap_or_else(|| panic!("completed subagent should stay active: {active:?}"));
    assert_eq!(subagent["status"], "open");
    assert_eq!(subagent["data"]["status_summary"], "completed");
    assert_eq!(subagent["data"]["latest_result"], "looks good");
    assert!(subagent["data"].get("tail").is_none());

    log.append(
        "subagent.failed",
        Some("session"),
        None,
        json!({
            "subagent_id": "sa_review",
            "name": "reviewer",
            "purpose": "review runtime config",
            "lifecycle": "open",
            "run_state": "failed",
            "status_summary": "failed",
            "latest_result": null,
            "latest_error": "provider failed",
            "owned_task_count": 1,
            "latest_callback": {
                "callback_id": "cb_failed",
                "kind": "failed",
                "status": "failed",
                "failure_reason": "queue_full"
            }
        }),
    );
    let active = log.active_timeline_items();
    let subagent = active
        .iter()
        .find(|item| item["id"] == "subagent_sa_review")
        .unwrap_or_else(|| panic!("failed subagent should stay active: {active:?}"));
    assert_eq!(subagent["status"], "open");
    assert_eq!(subagent["data"]["status_summary"], "failed");
    assert_eq!(subagent["data"]["latest_error"], "provider failed");

    log.append(
        "subagent.callback",
        Some("session"),
        None,
        json!({
            "subagent_id": "sa_review",
            "name": "reviewer",
            "purpose": "review runtime config",
            "lifecycle": "open",
            "run_state": "idle",
            "status_summary": "idle",
            "latest_result": "looks good",
            "latest_error": null,
            "owned_task_count": 1,
            "callback_id": "cb_idle",
            "callback_kind": "task_completed",
            "callback_status": "queued",
            "latest_callback": {
                "callback_id": "cb_idle",
                "kind": "task_completed",
                "status": "pending",
                "failure_reason": null
            }
        }),
    );
    let active = log.active_timeline_items();
    let subagent = active
        .iter()
        .find(|item| item["id"] == "subagent_sa_review")
        .unwrap_or_else(|| panic!("callback subagent should stay active: {active:?}"));
    assert_eq!(subagent["status"], "open");
    assert_eq!(subagent["data"]["callback_id"], "cb_idle");
    assert_eq!(subagent["data"]["callback_kind"], "task_completed");
    assert_eq!(subagent["data"]["callback_status"], "queued");

    log.append(
        "subagent.callback_delivered",
        Some("session"),
        None,
        json!({
            "subagent_id": "sa_review",
            "name": "reviewer",
            "purpose": "review runtime config",
            "lifecycle": "open",
            "run_state": "idle",
            "status_summary": "idle",
            "latest_result": "looks good",
            "latest_error": null,
            "owned_task_count": 1,
            "callback_id": "cb_idle",
            "callback_status": "delivered",
            "latest_callback": {
                "callback_id": "cb_idle",
                "kind": "task_completed",
                "status": "delivered",
                "failure_reason": null
            }
        }),
    );
    let active = log.active_timeline_items();
    let subagent = active
        .iter()
        .find(|item| item["id"] == "subagent_sa_review")
        .unwrap_or_else(|| panic!("delivered callback subagent should stay active: {active:?}"));
    assert_eq!(subagent["status"], "open");
    assert_eq!(subagent["data"]["callback_id"], "cb_idle");
    assert_eq!(subagent["data"]["callback_status"], "delivered");

    log.append(
        "subagent.cancelled",
        Some("session"),
        None,
        json!({
            "subagent_id": "sa_review",
            "name": "reviewer",
            "purpose": "review runtime config",
            "lifecycle": "cancelled",
            "run_state": "idle",
            "status_summary": "cancelled",
            "latest_result": "looks good",
            "latest_error": null,
            "owned_task_count": 1
        }),
    );
    assert!(
        !log.active_timeline_items()
            .iter()
            .any(|item| item["id"] == "subagent_sa_review"),
        "cancelled subagent should be removed from active items"
    );

    for (event_type, run_state, status_summary) in [
        ("subagent.started", "running", "running"),
        ("subagent.callback", "idle", "idle"),
    ] {
        log.append(
            event_type,
            Some("session"),
            None,
            json!({
                "subagent_id": "sa_review",
                "name": "reviewer",
                "purpose": "review runtime config",
                "lifecycle": "open",
                "run_state": run_state,
                "status_summary": status_summary,
                "latest_result": "stale",
                "latest_error": null,
                "owned_task_count": 1,
                "callback_id": "cb_stale",
                "callback_kind": "completed",
                "callback_status": "queued"
            }),
        );
        assert!(
            !log.active_timeline_items()
                .iter()
                .any(|item| item["id"] == "subagent_sa_review"),
            "stale {event_type} must not reactivate a cancelled subagent"
        );
    }
}

#[test]
fn event_log_subagent_cancel_tombstones_are_bounded_by_retained_capacity() {
    fn append_subagent_event(
        log: &mut EventLog,
        event_type: &str,
        subagent_id: &str,
        lifecycle: &str,
        run_state: &str,
        status_summary: &str,
    ) {
        log.append(
            event_type,
            Some("session"),
            None,
            json!({
                "subagent_id": subagent_id,
                "name": "reviewer",
                "purpose": "review runtime config",
                "lifecycle": lifecycle,
                "run_state": run_state,
                "status_summary": status_summary,
                "latest_result": null,
                "latest_error": null,
                "owned_task_count": 0
            }),
        );
    }

    fn has_active_subagent(log: &EventLog, subagent_id: &str) -> bool {
        let item_id = format!("subagent_{subagent_id}");
        log.active_timeline_items()
            .iter()
            .any(|item| item["id"] == item_id)
    }

    let mut log = EventLog::with_process_instance("p7k3", 3).expect("event log");
    append_subagent_event(
        &mut log,
        "subagent.started",
        "sa_open",
        "open",
        "running",
        "running",
    );

    let cancel_count = 8;
    for index in 0..cancel_count {
        append_subagent_event(
            &mut log,
            "subagent.cancelled",
            &format!("sa_cancel_{index}"),
            "cancelled",
            "idle",
            "cancelled",
        );
    }

    assert!(
        has_active_subagent(&log, "sa_open"),
        "open subagent should not be removed by cancelled tombstone trimming"
    );

    append_subagent_event(
        &mut log,
        "subagent.callback",
        "sa_cancel_7",
        "open",
        "idle",
        "idle",
    );
    assert!(
        !has_active_subagent(&log, "sa_cancel_7"),
        "recent stale callback inside the retained window must not reactivate a cancelled subagent"
    );

    append_subagent_event(
        &mut log,
        "subagent.started",
        "sa_cancel_0",
        "open",
        "running",
        "running",
    );
    assert!(
        has_active_subagent(&log, "sa_cancel_0"),
        "cancel tombstones should not be retained beyond the event log window"
    );

    append_subagent_event(
        &mut log,
        "subagent.started",
        "sa_fresh",
        "open",
        "running",
        "running",
    );
    assert!(
        has_active_subagent(&log, "sa_fresh"),
        "bounded tombstones must not block normal new subagent ids"
    );
}

#[test]
fn timeline_projects_rejection_retryable_and_queue_pressure() {
    let rejected = ServiceEvent::new(
        49,
        "message.rejected",
        Some("session"),
        None,
        json!({
            "message_id": "msg_3",
            "input_id": "msg_3",
            "input_kind": "user_message",
            "source": "user",
            "content_preview": "full",
            "content_bytes": 4,
            "content_truncated": false,
            "content_kind": "text",
            "queue_length": 1,
            "reason": "queue_full",
            "error": {
                "code": "queue_full",
                "message": "message queue is full",
                "retryable": true
            }
        }),
    );
    let pressure = ServiceEvent::new(
        50,
        "queue.pressure",
        Some("session"),
        None,
        json!({
            "queue_length": 1,
            "max_queue_messages": 1,
            "max_queue_bytes": 1048576,
            "input_rejected": true,
            "error": {
                "code": "queue_full",
                "message": "message queue is full",
                "retryable": true
            }
        }),
    );

    let rejected = project_timeline_event(&rejected, "p7k3").expect("rejected projection");
    assert_eq!(rejected.event_type, "input.rejected");
    assert_eq!(rejected.item.expect("input item").status, "rejected");
    assert_eq!(rejected.data["input_id"], "msg_3");
    assert_eq!(rejected.data["reason"], "queue_full");
    assert_eq!(rejected.data["error"]["code"], "queue_full");
    assert_eq!(rejected.data["error"]["retryable"], true);

    let pressure = project_timeline_event(&pressure, "p7k3").expect("pressure projection");
    assert_eq!(pressure.event_type, "queue.pressure");
    assert_eq!(pressure.trace.cycle_id, None);
    assert_eq!(
        pressure.item,
        Some(TimelineItem::new("queue", "queue_state", "limited"))
    );
    assert_eq!(pressure.data["queue_length"], 1);
    assert_eq!(pressure.data["max_queue_messages"], 1);
    assert_eq!(pressure.data["max_queue_bytes"], 1048576);
    assert_eq!(pressure.data["input_rejected"], true);
    assert_eq!(pressure.data["error"]["code"], "queue_full");
    assert_eq!(pressure.data["error"]["retryable"], true);
}

#[test]
fn timeline_projects_cycle_lifecycle() {
    let drained = ServiceEvent::new(
        12,
        "queue.drained",
        Some("session"),
        Some("turn_1"),
        json!({
            "message_count": 1,
            "message_ids": ["msg_1"],
            "input_ids": ["msg_1"],
            "input_sources": {
                "msg_1": "user"
            },
            "input_previews": {
                "msg_1": "start work"
            },
            "queue_length": 0
        }),
    );
    let started = ServiceEvent::new(
        13,
        "cycle.started",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "input_ids": ["msg_1"],
            "input_sources": {
                "msg_1": "user"
            },
            "input_previews": {
                "msg_1": "start work"
            },
            "queue_length": 0
        }),
    );
    let completed = ServiceEvent::new(
        20,
        "turn.completed",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "input_ids": ["msg_1"],
            "provider_calls": 1,
            "provider_request_count": 1,
            "queue_length": 0,
            "stop_reason": "end_turn",
            "usage": {
                "input": 10,
                "cached_input": 0,
                "output": 3,
                "reasoning_output": 0
            }
        }),
    );
    let failed = ServiceEvent::new(
        21,
        "agent.error",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "input_ids": ["msg_1"],
            "queue_length": 0,
            "message": "provider failed: unavailable",
            "error": {
                "code": "provider_error",
                "message": "provider failed: unavailable",
                "retryable": true
            },
            "retryable": true
        }),
    );

    let drained = project_timeline_event(&drained, "p7k3").expect("drained projection");
    assert_eq!(drained.event_type, "input.drained");
    assert_eq!(drained.trace.cycle_id.as_deref(), Some("cyc_12"));
    assert!(drained.item.is_none());
    assert_eq!(drained.data["input_ids"], json!(["msg_1"]));
    assert_eq!(drained.data["input_sources"]["msg_1"], "user");
    assert_eq!(drained.data["input_previews"]["msg_1"], "start work");
    assert_eq!(drained.data["queue_length"], 0);

    let started = project_timeline_event(&started, "p7k3").expect("started projection");
    assert_eq!(started.event_type, "cycle.started");
    assert_eq!(started.trace.cycle_id.as_deref(), Some("cyc_12"));
    assert_eq!(
        started.item,
        Some(TimelineItem::new("cyc_12", "cycle", "running"))
    );
    assert_eq!(started.data["cycle_id"], "cyc_12");
    assert_eq!(started.data["input_ids"], json!(["msg_1"]));
    assert_eq!(started.data["input_sources"]["msg_1"], "user");
    assert_eq!(started.data["input_previews"]["msg_1"], "start work");
    assert_eq!(started.data["queue_length"], 0);

    let completed = project_timeline_event(&completed, "p7k3").expect("completed projection");
    assert_eq!(completed.event_type, "cycle.completed");
    assert_eq!(completed.trace.cycle_id.as_deref(), Some("cyc_12"));
    assert_eq!(
        completed.item,
        Some(TimelineItem::new("cyc_12", "cycle", "completed"))
    );
    assert_eq!(completed.data["cycle_id"], "cyc_12");
    assert_eq!(completed.data["input_ids"], json!(["msg_1"]));
    assert_eq!(completed.data["provider_request_count"], 1);
    assert_eq!(completed.data["queue_length"], 0);
    assert_eq!(completed.data["stop_reason"], "end_turn");

    let failed = project_timeline_event(&failed, "p7k3").expect("failed projection");
    assert_eq!(failed.event_type, "cycle.failed");
    assert_eq!(failed.trace.cycle_id.as_deref(), Some("cyc_12"));
    assert_eq!(
        failed.item,
        Some(TimelineItem::new("cyc_12", "cycle", "failed"))
    );
    assert_eq!(failed.data["cycle_id"], "cyc_12");
    assert_eq!(failed.data["input_ids"], json!(["msg_1"]));
    assert_eq!(failed.data["queue_length"], 0);
    assert_eq!(failed.data["error"]["code"], "provider_error");
    assert_eq!(
        failed.data["error"]["message"],
        "provider failed: unavailable"
    );
    assert_eq!(failed.data["error"]["retryable"], true);
    assert_eq!(failed.data["retryable"], true);
}

#[test]
fn timeline_projects_service_error_item_contract() {
    let event = ServiceEvent::new(
        51,
        "agent.error",
        Some("session"),
        Some("turn_1"),
        json!({
            "message": "failed to persist public replay",
            "error": {
                "code": "persistence_error",
                "message": "failed to persist public replay",
                "retryable": false
            },
            "retryable": false
        }),
    );

    let projected = project_timeline_event(&event, "p7k3").expect("service error projection");
    assert_eq!(projected.event_type, "service.error");
    let item = projected.item.expect("service error item");
    assert!(item.id.starts_with("err_evt_"));
    assert_eq!(item.item_type, "error");
    assert_eq!(item.status, "failed");
    assert_eq!(projected.data["code"], "persistence_error");
    assert_eq!(projected.data["message"], "failed to persist public replay");
    assert_eq!(projected.data["retryable"], false);
    assert!(projected.data.get("raw").is_none());
}

#[test]
fn event_log_active_projection_closes_cycle_provider_and_command_together() {
    let mut log = EventLog::with_process_instance("p7k3", 32).expect("event log");
    let drained = log.append(
        "queue.drained",
        Some("session"),
        Some("turn_1"),
        json!({
            "message_count": 1,
            "message_ids": ["msg_1"],
            "input_ids": ["msg_1"],
            "input_sources": {
                "msg_1": "user"
            },
            "input_previews": {
                "msg_1": "start work"
            },
            "queue_length": 0
        }),
    );
    let cycle_id = format!("cyc_{}", drained.seq);
    log.append(
        "cycle.started",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": cycle_id,
            "input_ids": ["msg_1"],
            "input_sources": {
                "msg_1": "user"
            },
            "input_previews": {
                "msg_1": "start work"
            },
            "queue_length": 0
        }),
    );
    log.append(
        "provider.started",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": cycle_id,
            "provider_request_id": format!("prq_{cycle_id}_1"),
            "provider_call_index": 1,
            "provider": "unknown",
            "model": null
        }),
    );
    log.append(
        "tool.started",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": cycle_id,
            "tool_call_id": "call_bash",
            "tool_name": "bash",
            "command": "sleep 1",
            "aggregated_output": "",
            "exit_code": null,
            "status": "in_progress"
        }),
    );

    let active = log.active_timeline_items();
    for item_type in ["cycle", "provider_request", "command_execution"] {
        let item = active
            .iter()
            .find(|item| item["type"] == item_type && item["status"] == "running")
            .unwrap_or_else(|| panic!("{item_type} should be active: {active:?}"));
        assert_eq!(item["trace"]["cycle_id"], cycle_id);
    }

    log.append(
        "turn.completed",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": cycle_id,
            "input_ids": ["msg_1"],
            "provider_request_count": 1,
            "queue_length": 0,
            "stop_reason": "end_turn",
            "usage": {
                "input": 1,
                "cached_input": 0,
                "output": 1,
                "reasoning_output": 0
            }
        }),
    );

    let active = log.active_timeline_items();
    assert!(
        !active.iter().any(|item| matches!(
            item["type"].as_str(),
            Some("cycle" | "provider_request" | "command_execution")
        )),
        "terminal cycle event should clear running active items: {active:?}"
    );
}

#[test]
fn event_log_active_projection_preserves_existing_item_on_cycle_id_collision() {
    let mut log = EventLog::with_process_instance("p7k3", 32).expect("event log");
    log.append(
        "provider.started",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_1",
            "provider_request_id": "prq_collision",
            "provider_call_index": 1,
            "provider": "first",
            "model": null
        }),
    );
    log.append(
        "provider.started",
        Some("session"),
        Some("turn_2"),
        json!({
            "cycle_id": "cyc_2",
            "provider_request_id": "prq_collision",
            "provider_call_index": 1,
            "provider": "second",
            "model": null
        }),
    );

    let active = log.active_timeline_items();
    let provider = active
        .iter()
        .find(|item| item["id"] == "prq_collision")
        .expect("original provider request should remain active");
    assert_eq!(provider["trace"]["cycle_id"], "cyc_1");
    assert_eq!(provider["data"]["provider"], "first");

    log.append(
        "provider.completed",
        Some("session"),
        Some("turn_2"),
        json!({
            "cycle_id": "cyc_2",
            "provider_request_id": "prq_collision",
            "provider_call_index": 1,
            "provider": "second",
            "model": null
        }),
    );
    let active = log.active_timeline_items();
    assert!(
        active
            .iter()
            .any(|item| item["id"] == "prq_collision" && item["trace"]["cycle_id"] == "cyc_1"),
        "terminal event for collided item must not remove original active item: {active:?}"
    );

    log.append(
        "provider.completed",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_1",
            "provider_request_id": "prq_collision",
            "provider_call_index": 1,
            "provider": "first",
            "model": null
        }),
    );
    let active = log.active_timeline_items();
    assert!(
        !active.iter().any(|item| item["id"] == "prq_collision"),
        "matching terminal event should remove original active item: {active:?}"
    );
}

#[test]
fn timeline_projects_inline_bash_command_execution_lifecycle() {
    let started = ServiceEvent::new(
        17,
        "tool.started",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "tool_call_id": "call_1",
            "tool_name": "bash",
            "command": "printf hello",
            "aggregated_output": "",
            "exit_code": null,
            "status": "in_progress"
        }),
    );
    let completed = ServiceEvent::new(
        18,
        "tool.completed",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "tool_call_id": "call_1",
            "tool_name": "bash",
            "command": "printf hello",
            "aggregated_output": "hello",
            "output_artifact_path": ".botified/tasks/call_1/output.log",
            "exit_code": 0,
            "status": "completed",
            "detached_ack": false
        }),
    );
    let failed = ServiceEvent::new(
        19,
        "tool.completed",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "tool_call_id": "call_2",
            "tool_name": "bash",
            "command": "false",
            "aggregated_output": "nope",
            "exit_code": 1,
            "status": "failed",
            "detached_ack": false
        }),
    );

    let started = project_timeline_event(&started, "p7k3").expect("started projection");
    assert_eq!(started.event_type, "command_execution.started");
    assert_eq!(started.trace.cycle_id.as_deref(), Some("cyc_12"));
    assert_eq!(
        started.item,
        Some(TimelineItem::new(
            "cmd_call_1",
            "command_execution",
            "running"
        ))
    );
    assert_eq!(started.data["tool_call_id"], "call_1");
    assert_eq!(started.data["command"], "printf hello");
    assert_eq!(started.data["output_tail"], "");
    assert_eq!(started.data["output_bytes"], 0);
    assert_eq!(started.data["output_complete"], false);
    assert!(started.data["exit_code"].is_null());
    assert_eq!(started.data["status"], "in_progress");

    let completed = project_timeline_event(&completed, "p7k3").expect("completed projection");
    assert_eq!(completed.event_type, "command_execution.completed");
    assert_eq!(completed.trace.cycle_id.as_deref(), Some("cyc_12"));
    assert_eq!(
        completed.item,
        Some(TimelineItem::new(
            "cmd_call_1",
            "command_execution",
            "completed"
        ))
    );
    assert_eq!(completed.data["output_tail"], "hello");
    assert_eq!(completed.data["output_bytes"], 5);
    assert_eq!(completed.data["output_complete"], true);
    assert_eq!(
        completed.data["output_artifact_path"],
        ".botified/tasks/call_1/output.log"
    );
    assert_eq!(completed.data["exit_code"], 0);
    assert_eq!(completed.data["status"], "completed");

    let failed = project_timeline_event(&failed, "p7k3").expect("failed projection");
    assert_eq!(failed.event_type, "command_execution.failed");
    assert_eq!(
        failed.item,
        Some(TimelineItem::new(
            "cmd_call_2",
            "command_execution",
            "failed"
        ))
    );
    assert_eq!(failed.data["command"], "false");
    assert_eq!(failed.data["output_tail"], "nope");
    assert_eq!(failed.data["output_bytes"], 4);
    assert_eq!(failed.data["output_complete"], true);
    assert_eq!(failed.data["exit_code"], 1);
    assert_eq!(failed.data["status"], "failed");
}

#[test]
fn timeline_projects_background_task_state_and_callback_delivery_separately() {
    let updated = ServiceEvent::new(
        20,
        "task.updated",
        Some("session"),
        None,
        json!({
            "task_id": "task_123",
            "tool_call_id": "call_bg",
            "tool_name": "slow_fake",
            "state": "cancelling",
            "status": "cancelling",
            "callback_delivery": "not_ready"
        }),
    );
    let queued = ServiceEvent::new(
        21,
        "task.callback_queued",
        Some("session"),
        None,
        json!({
            "task_id": "task_123",
            "tool_call_id": "call_bg",
            "tool_name": "slow_fake",
            "state": "completed",
            "status": "completed",
            "callback_delivery": "queued"
        }),
    );
    let delivered = ServiceEvent::new(
        22,
        "task.callback_delivered",
        Some("session"),
        None,
        json!({
            "task_id": "task_123",
            "tool_call_id": "call_bg",
            "tool_name": "slow_fake",
            "state": "failed",
            "status": "failed",
            "callback_delivery": "delivered"
        }),
    );

    let updated = project_timeline_event(&updated, "p7k3").expect("updated projection");
    assert_eq!(updated.event_type, "background_task.updated");
    assert_eq!(
        updated.item,
        Some(TimelineItem::new(
            "task_task_123",
            "background_task",
            "cancelling"
        ))
    );
    assert_eq!(updated.data["state"], "cancelling");

    let queued = project_timeline_event(&queued, "p7k3").expect("queued projection");
    assert_eq!(queued.event_type, "background_task.callback_queued");
    assert_eq!(
        queued.item,
        Some(TimelineItem::new(
            "task_task_123",
            "background_task",
            "completed"
        ))
    );
    assert_eq!(queued.data["callback_delivery"], "queued");

    let delivered = project_timeline_event(&delivered, "p7k3").expect("delivered projection");
    assert_eq!(delivered.event_type, "background_task.callback_delivered");
    assert_eq!(
        delivered.item,
        Some(TimelineItem::new(
            "task_task_123",
            "background_task",
            "failed"
        ))
    );
    assert_eq!(delivered.data["callback_delivery"], "delivered");
}

#[test]
fn retryable_task_reply_failure_does_not_clear_pending_ask_projection() {
    let mut log = EventLog::with_process_instance("p7k3", 16).unwrap();

    log.append(
        "task_ask.requested",
        Some("session"),
        None,
        json!({
            "task_id": "t1",
            "ask_id": "r1",
            "state": "pending",
            "status": "pending",
            "message": "continue?"
        }),
    );
    assert_eq!(log.active_timeline_items().len(), 1);

    let retryable = log.append(
        "task_reply.failed",
        Some("session"),
        None,
        json!({
            "kind": "task_reply",
            "ok": false,
            "status": "response_too_large",
            "message": "task reply response is too large",
            "task_id": "t1",
            "ask_id": "r1"
        }),
    );
    let projected = project_timeline_event(&retryable, "p7k3").expect("projection");
    assert_eq!(projected.event_type, "task_reply.failed");
    assert!(projected.item.is_none());

    let active = log.active_timeline_items();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0]["id"], "task_ask_t1_r1");
    assert_eq!(active[0]["status"], "pending");

    log.append(
        "task_reply.failed",
        Some("session"),
        None,
        json!({
            "kind": "task_reply",
            "ok": false,
            "status": "write_failed",
            "state": "write_failed",
            "message": "task stdin is not writable",
            "task_id": "t1",
            "ask_id": "r1"
        }),
    );
    assert!(log.active_timeline_items().is_empty());
}

#[test]
fn timeline_projects_non_bash_tools_as_raw_service_events() {
    let started = ServiceEvent::new(
        20,
        "tool.started",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "tool_call_id": "call_lookup",
            "tool_name": "lookup",
            "status": "in_progress"
        }),
    );
    let completed = ServiceEvent::new(
        21,
        "tool.completed",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "tool_call_id": "call_lookup",
            "tool_name": "lookup",
            "status": "completed",
            "detached_ack": false
        }),
    );

    for event in [started, completed] {
        let raw_event_type = event.event_type.clone();
        let projected = project_timeline_event(&event, "p7k3").expect("tool projection");

        assert_eq!(projected.event_type, "service.event");
        assert_eq!(projected.trace.cycle_id.as_deref(), Some("cyc_12"));
        assert!(projected.item.is_none());
        assert_eq!(projected.data["raw_event_type"], raw_event_type);
        assert_eq!(projected.data["tool_call_id"], "call_lookup");
        assert_ne!(projected.data["state"], "updated");
    }
}

#[test]
fn timeline_projects_assistant_message_with_cycle_trace_and_stable_item_id() {
    let first = ServiceEvent::new(
        24,
        "assistant.message",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "provider_request_id": "prq_cyc_12_2",
            "message_index": 1,
            "text": "done",
            "tool_call_count": 0,
            "usage": null,
            "stop_reason": "end_turn"
        }),
    );
    let replay = ServiceEvent::new(
        99,
        "assistant.message",
        Some("session"),
        Some("turn_2"),
        json!({
            "cycle_id": "cyc_12",
            "provider_request_id": "prq_cyc_12_2",
            "message_index": 1,
            "text": "done",
            "tool_call_count": 0,
            "usage": null,
            "stop_reason": "end_turn"
        }),
    );

    let first = project_timeline_event(&first, "p7k3").expect("first projection");
    let replay = project_timeline_event(&replay, "p7k3").expect("replay projection");

    assert_eq!(first.event_type, "assistant_message.completed");
    assert_eq!(first.trace.cycle_id.as_deref(), Some("cyc_12"));
    let first_item = first.item.as_ref().expect("assistant item");
    let replay_item = replay.item.as_ref().expect("assistant replay item");
    assert_eq!(first_item.id, replay_item.id);
    assert_eq!(first_item.id, "asst_f1ba61289bdf5aceb0d5ae08fec8f5da");
    assert_ne!(first_item.id, "assistant_24");
    assert_eq!(first_item.item_type, "assistant_message");
    assert_eq!(first_item.status, "completed");
    assert_eq!(first.data["assistant_message_id"], first_item.id);
    assert_eq!(first.data["provider_request_id"], "prq_cyc_12_2");
    assert_eq!(first.data["message_index"], 1);
    assert_eq!(first.data["text"], "done");
}

#[test]
fn timeline_assistant_message_keeps_full_text_for_detail_with_bounded_preview() {
    let full_text = format!("prefix {} suffix", "middle ".repeat(120));
    let event = ServiceEvent::new(
        24,
        "assistant.message",
        Some("session"),
        Some("turn_1"),
        json!({
            "cycle_id": "cyc_12",
            "provider_request_id": "prq_cyc_12_2",
            "message_index": 1,
            "text": full_text,
            "tool_call_count": 0,
            "usage": null,
            "stop_reason": "end_turn"
        }),
    );

    let projected = project_timeline_event(&event, "p7k3").expect("projection");
    assert_eq!(projected.event_type, "assistant_message.completed");
    assert_eq!(projected.data["text"], full_text);
    assert_eq!(projected.data["content_truncated"], true);
    assert!(
        projected.data["content_preview"]
            .as_str()
            .expect("preview")
            .len()
            < full_text.len()
    );
}

#[test]
fn timeline_item_ids_use_length_prefixed_sha256_first_16_bytes() {
    let input = ServiceEvent::new(
        10,
        "message.received",
        Some("session"),
        Some("turn_1"),
        json!({
            "input_id": "client-123",
            "message_id": "client-123",
            "input_kind": "user_message",
            "source": "user",
            "content_preview": "hello",
            "text": "hello full detail",
            "content_bytes": 5,
            "content_truncated": false,
            "content_kind": "text",
            "queue_length": 1
        }),
    );
    let projected = project_timeline_event(&input, "p7k3").expect("input projection");
    assert_eq!(
        projected.item.expect("input item").id,
        "inp_33e50e6c6e93391b2841f6ad0bfd1b86"
    );
    assert_eq!(projected.data["text"], "hello full detail");
}

#[test]
fn input_urgency_projection_preserves_present_raw_field_and_omits_absent_field() {
    for (seq, raw_type, projected_type) in [
        (31, "message.received", "input.accepted"),
        (32, "message.queued", "input.queued"),
        (33, "message.rejected", "input.rejected"),
    ] {
        let event = ServiceEvent::new(
            seq,
            raw_type,
            Some("session"),
            Some("turn_1"),
            json!({
                "input_id": format!("urgent-{seq}"),
                "message_id": format!("urgent-{seq}"),
                "input_kind": "user_message",
                "source": "user",
                "content_preview": "interrupt safely",
                "content_bytes": 16,
                "content_truncated": false,
                "content_kind": "text",
                "queue_length": 0,
                "urgency": "urgent"
            }),
        );

        let projected = project_timeline_event(&event, "p7k3").expect("input projection");

        assert_eq!(projected.event_type, projected_type);
        assert_eq!(projected.data["urgency"], "urgent");
    }

    let normal = ServiceEvent::new(
        34,
        "message.received",
        Some("session"),
        Some("turn_1"),
        json!({
            "input_id": "normal-no-urgency",
            "message_id": "normal-no-urgency",
            "input_kind": "user_message",
            "source": "user",
            "content_preview": "normal",
            "content_bytes": 6,
            "content_truncated": false,
            "content_kind": "text",
            "queue_length": 0
        }),
    );

    let projected = project_timeline_event(&normal, "p7k3").expect("input projection");

    assert_eq!(projected.event_type, "input.accepted");
    assert!(
        projected.data.get("urgency").is_none(),
        "projection must not synthesize urgency when raw field is absent: {:?}",
        projected.data
    );
}
