use super::subagent_projection::{
    project_subagent_callback_metadata, subagent_active_item_status, subagent_event_data,
    subagent_public_summary,
};
use super::task_runtime::project_task_callback_delivery;
use super::ContextMaintenanceStatus;
use super::*;

pub(super) fn timeline_cursor_for_event(inner: &ServiceInner, event: &ServiceEvent) -> EventCursor {
    EventCursor::for_instance(
        inner
            .timeline_store
            .lock()
            .expect("timeline store mutex poisoned")
            .instance()
            .to_owned(),
        event.seq,
    )
    .expect("timeline store instance should be valid")
}

pub(super) fn current_timeline_cursor(timeline_store: &Arc<Mutex<TimelineStore>>) -> EventCursor {
    let checkpoint = timeline_store
        .lock()
        .expect("timeline store mutex poisoned")
        .checkpoint();
    EventCursor::parse_timeline(&checkpoint.cursor)
        .expect("timeline store checkpoint should use a timeline cursor")
}

pub(super) fn append_committed_service_event(
    timeline_store: &Arc<Mutex<TimelineStore>>,
    event_log: &Arc<Mutex<EventLog>>,
    #[cfg(test)] event_commit_test_hook: Option<&EventCommitTestHook>,
    session: Option<&str>,
    turn_id: Option<&str>,
    event_type: &str,
    data: Value,
) -> Result<ServiceEvent, TimelineStoreError> {
    let (envelope, provisional) = {
        let mut store = timeline_store
            .lock()
            .expect("timeline store mutex poisoned");
        let next_seq = store.checkpoint().seq.saturating_add(1);
        let provisional =
            service_event_for_persistence(next_seq, event_type, session, turn_id, data);
        project_timeline_event(&provisional, store.instance())
            .map_err(TimelineStoreError::Envelope)
            .and_then(|projected| {
                let append = TimelineAppend {
                    time: Some(provisional.time.clone()),
                    session_id: projected.session_id,
                    event_type: projected.event_type,
                    trace: projected.trace,
                    item: projected.item,
                    data: projected.data,
                };
                store.append(append).map(|envelope| (envelope, provisional))
            })?
    };
    debug_assert_eq!(envelope.seq, provisional.seq);
    let event = ServiceEvent {
        seq: envelope.seq,
        time: envelope.time,
        event_type: provisional.event_type,
        session: provisional.session,
        turn_id: provisional.turn_id,
        data: provisional.data,
    };
    #[cfg(test)]
    if let Some(hook) = event_commit_test_hook {
        hook.after_durable(&event.event_type);
    }
    event_log
        .lock()
        .expect("event log mutex poisoned")
        .append_committed(event.clone());
    Ok(event)
}

fn service_event_for_persistence(
    seq: u64,
    event_type: &str,
    session: Option<&str>,
    turn_id: Option<&str>,
    data: Value,
) -> ServiceEvent {
    let task_interaction_message =
        if event_type.starts_with("task_ask.") || event_type.starts_with("task_tell.") {
            data.get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        } else {
            None
        };
    let mut event = ServiceEvent::new(seq, event_type, session, turn_id, data);

    // Ask/tell messages already passed the task protocol limit. They are public detail text,
    // while every other event field keeps the generic redaction and diagnostic bounds above.
    if let (Some(message), Some(data)) = (task_interaction_message, event.data.as_object_mut()) {
        data.insert("message".to_owned(), json!(message));
    }
    event
}

fn append_callback_projection_service_event(
    timeline_store: &Arc<Mutex<TimelineStore>>,
    event_log: &Arc<Mutex<EventLog>>,
    #[cfg(test)] event_commit_test_hook: &EventCommitTestHook,
    session: Option<&str>,
    event_type: &str,
    projection_id: &str,
    data: Value,
) -> Result<Option<ServiceEvent>, TimelineStoreError> {
    let event = {
        let mut store = timeline_store
            .lock()
            .expect("timeline store mutex poisoned");
        let next_seq = store.checkpoint().seq.saturating_add(1);
        let provisional = ServiceEvent::new(next_seq, event_type, session, None, data);
        let projected = project_timeline_event(&provisional, store.instance())
            .map_err(TimelineStoreError::Envelope)?;
        let append = TimelineAppend {
            time: Some(provisional.time.clone()),
            session_id: projected.session_id,
            event_type: projected.event_type,
            trace: projected.trace,
            item: projected.item,
            data: projected.data,
        };
        store
            .append_callback_projection(projection_id, append)?
            .map(|envelope| ServiceEvent {
                seq: envelope.seq,
                time: envelope.time,
                event_type: provisional.event_type,
                session: provisional.session,
                turn_id: None,
                data: provisional.data,
            })
    };
    if let Some(event) = event.as_ref() {
        #[cfg(test)]
        event_commit_test_hook.after_durable(&event.event_type);
        event_log
            .lock()
            .expect("event log mutex poisoned")
            .append_committed(event.clone());
    }
    Ok(event)
}

pub(super) fn timeline_persistence_service_error(error: TimelineStoreError) -> ServiceError {
    ServiceError::Persistence {
        message: format!("timeline persistence failed: {error}"),
    }
}

pub(super) fn retained_cursor_seqs_for_replay(
    timeline_store: &Arc<Mutex<TimelineStore>>,
    cursor_seqs: &[u64],
) -> Result<HashSet<u64>, ServiceError> {
    timeline_store
        .lock()
        .expect("timeline store mutex poisoned")
        .retained_cursor_seqs(cursor_seqs)
        .map_err(timeline_persistence_service_error)
}

#[cfg(test)]
pub(super) fn insert_message_index_entry(
    message_index: &mut HashMap<String, MessageIndexEntry>,
    message_id: String,
    content: Vec<ContentPart>,
    cursor: EventCursor,
) {
    insert_message_index_entry_with_delivery(message_index, message_id, content, cursor, None);
}

pub(super) fn insert_message_index_entry_with_delivery(
    message_index: &mut HashMap<String, MessageIndexEntry>,
    message_id: String,
    content: Vec<ContentPart>,
    cursor: EventCursor,
    delivery: Option<MessageDelivery>,
) {
    insert_message_index_entry_with_projection_state_and_delivery(
        message_index,
        message_id,
        content,
        cursor,
        MessageProjectionState::Live,
        delivery,
    );
}

pub(super) fn insert_message_index_entry_with_projection_state_and_delivery(
    message_index: &mut HashMap<String, MessageIndexEntry>,
    message_id: String,
    content: Vec<ContentPart>,
    cursor: EventCursor,
    projection_state: MessageProjectionState,
    delivery: Option<MessageDelivery>,
) {
    message_index.insert(
        message_id,
        MessageIndexEntry {
            content,
            cursor,
            projection_state,
            delivery,
        },
    );
}

pub(super) fn prune_message_index_to_retained_window(state: &mut ServiceInnerState) {
    let protected_ids = state.input_queue.protected_message_ids();
    let max_entries = DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW.saturating_add(protected_ids.len());
    let remove_count = state.message_index.len().saturating_sub(max_entries);
    if remove_count == 0 {
        return;
    }

    let mut candidates = state
        .message_index
        .iter()
        .filter(|(message_id, _)| !protected_ids.contains(*message_id))
        .map(|(message_id, entry)| {
            (
                message_id.clone(),
                entry.cursor.seq(),
                durable_sort_seq(
                    state
                        .durable_message_replays
                        .get(message_id)
                        .map(|replay| replay.terminal_seq),
                    entry.cursor.seq(),
                ),
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| (left.2, left.1, &left.0).cmp(&(right.2, right.1, &right.0)));

    for (message_id, _, _) in candidates.into_iter().take(remove_count) {
        state.message_index.remove(&message_id);
    }
}

pub(super) fn prune_durable_message_replays_to_retained_window(state: &mut ServiceInnerState) {
    let remove_count = state
        .durable_message_replays
        .len()
        .saturating_sub(DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW);
    if remove_count == 0 {
        return;
    }

    let mut candidates = state
        .durable_message_replays
        .iter()
        .map(|(message_id, replay)| {
            (
                message_id.clone(),
                durable_sort_seq(Some(replay.terminal_seq), replay.replay_start_seq),
                replay.replay_start_seq,
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| (left.1, left.2, &left.0).cmp(&(right.1, right.2, &right.0)));

    for (message_id, _, _) in candidates.into_iter().take(remove_count) {
        state.durable_message_replays.remove(&message_id);
    }
}

fn durable_sort_seq(terminal_seq: Option<u64>, fallback_seq: u64) -> u64 {
    terminal_seq.unwrap_or(fallback_seq)
}

struct BootstrapStateSnapshot {
    state: ServiceState,
    queued_inputs: Vec<QueuedMessage>,
    last_error: Option<String>,
    context_maintenance: ContextMaintenanceStatus,
}

pub(super) async fn record_non_session_accepted_input(
    inner: &ServiceInner,
    accepted: &AcceptedInputEntry,
) -> Result<bool, ServiceError> {
    if inner.session_recorder.is_some() {
        return Ok(false);
    }
    let Some(recorder) = inner.recorder.as_ref() else {
        return Ok(false);
    };
    recorder
        .record_accepted_input(accepted)
        .await
        .map_err(|error| ServiceError::Persistence {
            message: error.to_string(),
        })?;
    Ok(true)
}

impl ServiceInner {
    #[cfg(test)]
    pub(super) fn set_bootstrap_state_snapshot_test_hook(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self
            .bootstrap_state_snapshot_test_hook
            .lock()
            .expect("bootstrap state snapshot test hook poisoned") = Some(hook);
    }

    #[cfg(test)]
    pub(super) fn set_bootstrap_task_snapshot_test_hook(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self
            .bootstrap_task_snapshot_test_hook
            .lock()
            .expect("bootstrap task snapshot test hook poisoned") = Some(hook);
    }

    #[cfg(test)]
    pub(super) fn set_status_state_snapshot_test_hook(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self
            .status_state_snapshot_test_hook
            .lock()
            .expect("status state snapshot test hook poisoned") = Some(hook);
    }

    #[cfg(test)]
    fn invoke_bootstrap_state_snapshot_test_hook(&self) {
        let hook = self
            .bootstrap_state_snapshot_test_hook
            .lock()
            .expect("bootstrap state snapshot test hook poisoned")
            .take();
        if let Some(hook) = hook {
            hook();
        }
    }

    #[cfg(test)]
    fn invoke_bootstrap_task_snapshot_test_hook(&self) {
        let hook = self
            .bootstrap_task_snapshot_test_hook
            .lock()
            .expect("bootstrap task snapshot test hook poisoned")
            .take();
        if let Some(hook) = hook {
            hook();
        }
    }

    #[cfg(test)]
    fn invoke_status_state_snapshot_test_hook(&self) {
        let hook = self
            .status_state_snapshot_test_hook
            .lock()
            .expect("status state snapshot test hook poisoned")
            .take();
        if let Some(hook) = hook {
            hook();
        }
    }

    pub(super) fn timeline_bootstrap_snapshot(&self) -> Value {
        let (timeline_snapshot, timeline_cursor, timeline_seq, timeline_active_items) = {
            #[cfg(test)]
            self.event_commit_test_hook
                .gate_attempt(EventCommitGateActor::Bootstrap);
            let _event_commit_guard = self
                .event_commit_gate
                .lock()
                .expect("event commit gate poisoned");
            let (timeline_snapshot, checkpoint) = {
                let store = self
                    .timeline_store
                    .lock()
                    .expect("timeline store mutex poisoned");
                let snapshot = store.read_snapshot();
                let checkpoint = snapshot.checkpoint();
                (snapshot, checkpoint)
            };
            let (cursor, active_items) = {
                let log = self.event_log.lock().expect("event log mutex poisoned");
                (log.current_cursor(), log.active_timeline_items())
            };
            assert_eq!(checkpoint.seq, cursor.seq());
            (timeline_snapshot, cursor, checkpoint.seq, active_items)
        };
        let retention = timeline_snapshot.retention();

        let state_snapshot = {
            let state = self.state.lock().expect("service state mutex poisoned");
            BootstrapStateSnapshot {
                state: state.state,
                queued_inputs: state.input_queue.iter().cloned().collect(),
                last_error: state.last_error.clone(),
                context_maintenance: state.context_maintenance.clone(),
            }
        };
        #[cfg(test)]
        self.invoke_bootstrap_state_snapshot_test_hook();

        let task_snapshots = self.background_tasks.list_by_owner(&TaskOwner::Main);
        #[cfg(test)]
        self.invoke_bootstrap_task_snapshot_test_hook();
        let tasks = Self::timeline_task_summary_from(&task_snapshots);
        let active_items_omitted = Self::active_items_omitted_summary_from(&task_snapshots);
        let subagent_snapshots = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .list();

        let queue_length = state_snapshot.queued_inputs.len();
        let service_state = service_state_name(state_snapshot.state);
        let service_status_data = self
            .service_status_data_from_values(
                state_snapshot.state,
                queue_length,
                state_snapshot.last_error.clone(),
                state_snapshot.context_maintenance,
                tasks.clone(),
            )
            .0;
        let providers = self.provider_summaries_json();
        let mut active_items = vec![
            json!({
                "id": "service",
                "type": "service_status",
                "status": service_state,
                "data": service_status_data
            }),
            json!({
                "id": "queue",
                "type": "queue_state",
                "status": "ready",
                "data": {
                    "queue_length": queue_length
                }
            }),
        ];
        // The timeline projection owns event-backed active items, including task asks.
        // Background task snapshots remain authoritative for task rows and summaries.
        active_items.extend(
            timeline_active_items
                .into_iter()
                .filter(|item| item["type"] != "subagent"),
        );

        for (index, queued) in state_snapshot.queued_inputs.iter().enumerate() {
            let summary = summarize_input_content(&queued.content);
            active_items.push(json!({
                "id": input_item_id(&queued.id),
                "type": "input",
                "status": "queued",
                "data": {
                    "input_id": &queued.id,
                    "input_kind": input_kind_name(queued.source),
                    "source": queued.source.as_str(),
                    "urgency": queued.urgency.as_str(),
                    "message_id": &queued.id,
                    "content_preview": summary.content_preview,
                    "content_bytes": summary.content_bytes,
                    "content_truncated": summary.content_truncated,
                    "content_kind": summary.content_kind,
                    "queue_position": index + 1
                }
            }));
        }

        for task in task_snapshots
            .iter()
            .filter(|task| task_requires_active_item(task))
        {
            active_items.push(json!({
                "id": format!("task_{}", task.task_id),
                "type": "background_task",
                "status": active_task_status(task),
                "data": task_event_data(task)
            }));
        }

        for subagent in subagent_snapshots.into_iter().filter(|snapshot| {
            snapshot.lifecycle == SubagentLifecycle::Open
                || snapshot.run_state == SubagentRunState::Running
                || !snapshot.queued_messages.is_empty()
        }) {
            active_items.push(json!({
                "id": format!("subagent_{}", subagent.id),
                "type": "subagent",
                "status": subagent_active_item_status(&subagent),
                "data": subagent_public_summary(&subagent)
            }));
        }

        json!({
            "session_id": self.config.session.clone().unwrap_or_else(|| "thread_local".to_owned()),
            "state": service_state,
            "queue_length": queue_length,
            "timeline_cursor": timeline_cursor.to_string(),
            "timeline_seq": timeline_seq,
            "timeline": {
                "endpoint": "/v1/timeline",
                "version": TIMELINE_VERSION,
                "retention": {
                    "kind": "durable_file",
                    "retention_days": retention.retention_days,
                    "hot_event_capacity": retention.hot_event_capacity,
                    "earliest_seq": retention.earliest_seq,
                    "earliest_cursor": retention.earliest_cursor,
                    "latest_seq": retention.latest_seq,
                    "latest_cursor": retention.latest_cursor
                },
                "capabilities": {
                    "timeline_live_follow": true,
                    "durable_timeline_read": true,
                    "history_pagination": true,
                    "incremental_output": true
                }
            },
            "providers": providers,
            "tasks": tasks,
            "registry": self.registry_bootstrap_summary(),
            "internal_diagnostics": {
                "stdio": self.stdio_diagnostics_summary()
            },
            "active_items": active_items,
            "active_items_omitted": active_items_omitted,
            "last_error": state_snapshot.last_error
        })
    }

    fn registry_bootstrap_summary(&self) -> Value {
        let Some(store) = self.registry_store.as_ref() else {
            return json!({
                "enabled": false,
                "capabilities": Self::registry_capabilities(false)
            });
        };
        let config = store.config().clone();
        let options = *store.options();
        let stats = store.stats();

        json!({
            "endpoint": "/v1/registry/ws",
            "current_endpoint": "/v1/registry/current",
            "history_endpoint": "/v1/registry/history",
            "topics_endpoint": "/v1/registry/topics",
            "enabled": true,
            "instance_id": store.instance_id(),
            "started_at": crate::formatting::system_time_rfc3339(store.started_at()),
            "history_retention_secs": config.history_retention.as_secs_f64(),
            "default_ttl_secs": config.default_ttl.as_secs_f64(),
            "max_topics": config.max_topics,
            "max_subscriptions": config.max_subscriptions,
            "max_value_bytes": config.max_value_bytes,
            "max_query_limit": config.max_query_limit,
            "max_response_bytes": config.max_response_bytes,
            "websocket_max_frame_bytes": options.websocket_max_frame_bytes,
            "current_topics": stats.known_topics,
            "active_current_topics": stats.current_topics,
            "history_items": stats.history_items,
            "history_bytes": stats.history_bytes,
            "last_committed_seq": stats.last_committed_seq,
            "set_total": stats.set_total,
            "delete_total": stats.delete_total,
            "expire_total": stats.expire_total,
            "pruned_history_items_total": stats.pruned_history_items_total,
            "rejected_writes_total": stats.rejected_writes_total,
            "active_subscriptions": stats.active_subscriptions,
            "subscription_rejected_total": stats.subscription_rejected_total,
            "slow_subscription_closed_total": stats.slow_subscription_closed_total,
            "latest_seq": stats.last_committed_seq,
            "capabilities": Self::registry_capabilities(true)
        })
    }

    fn registry_capabilities(enabled: bool) -> Value {
        json!({
            "set": enabled,
            "get": enabled,
            "history": enabled,
            "delete": enabled,
            "topics": enabled,
            "wildcard": enabled,
            "http_read": enabled,
            "subscribe": enabled
        })
    }

    fn provider_summaries_json(&self) -> Value {
        let providers = self
            .provider_summaries
            .lock()
            .expect("provider summaries mutex poisoned");
        Value::Array(
            providers
                .iter()
                .filter_map(ProviderMetadata::sanitized)
                .map(|provider| json!(provider))
                .collect(),
        )
    }

    fn timeline_task_summary(&self) -> Value {
        let tasks = self.background_tasks.list_by_owner(&TaskOwner::Main);
        Self::timeline_task_summary_from(&tasks)
    }

    fn timeline_task_summary_from(tasks: &[TaskSnapshot]) -> Value {
        let running = tasks
            .iter()
            .filter(|task| task.state == TaskState::Running)
            .count();
        let cancelling = tasks
            .iter()
            .filter(|task| task.state == TaskState::Cancelling)
            .count();
        let pending_callbacks = tasks
            .iter()
            .filter(|task| {
                matches!(
                    task.callback_delivery,
                    CallbackDelivery::Pending | CallbackDelivery::Enqueued
                )
            })
            .count();
        let pending_asks = tasks
            .iter()
            .flat_map(|task| task.requests.iter())
            .filter(|request| request.state == TaskRequestState::Pending)
            .count();

        json!({
            "running": running,
            "cancelling": cancelling,
            "pending_callbacks": pending_callbacks,
            "pending_asks": pending_asks
        })
    }

    fn active_items_omitted_summary_from(tasks: &[TaskSnapshot]) -> Value {
        let omitted_background_tasks = tasks
            .iter()
            .filter(|task| task.state.is_terminal() && !task_requires_active_item(task))
            .count();

        if omitted_background_tasks == 0 {
            json!({
                "omitted_count": 0,
                "by_type": {}
            })
        } else {
            json!({
                "omitted_count": omitted_background_tasks,
                "by_type": {
                    "background_task": omitted_background_tasks
                }
            })
        }
    }

    pub(super) fn status(&self) -> ServiceStatus {
        let (state, queue_length, last_error) = {
            let state = self.state.lock().expect("service state mutex poisoned");
            debug_assert_shutdown_cancel_visible(&state);
            (
                state.state,
                state.input_queue.len(),
                state.last_error.clone(),
            )
        };
        #[cfg(test)]
        self.invoke_status_state_snapshot_test_hook();
        // The timeline sequence is a later, weakly consistent watermark for this state copy.
        ServiceStatus {
            state,
            queue_length,
            last_event_seq: self.last_event_seq(),
            session: self.config.session.clone(),
            last_error,
        }
    }

    pub(super) fn record_timeline_persistence_error(&self, error: TimelineStoreError) {
        let message = format!("timeline persistence failed: {error}");
        self.transition_to_failed(message, |_| ());
    }

    fn record_timeline_persistence_error_for_locked(
        &self,
        error: TimelineStoreError,
    ) -> FailedTransitionIntent {
        FailedTransitionIntent::timeline(error)
    }

    pub(super) fn event_window_after_cursor(
        &self,
        cursor: EventCursor,
    ) -> Result<EventReadWindow, EventReadError> {
        self.event_log
            .lock()
            .expect("event log mutex poisoned")
            .read_window_after_cursor(cursor)
    }

    pub(super) fn status_from_locked(&self, state: &ServiceInnerState) -> ServiceStatus {
        debug_assert_shutdown_cancel_visible(state);
        ServiceStatus {
            state: state.state,
            queue_length: state.input_queue.len(),
            last_event_seq: self.last_event_seq(),
            session: self.config.session.clone(),
            last_error: state.last_error.clone(),
        }
    }

    pub(super) fn service_status_data_from_locked(
        &self,
        state: &ServiceInnerState,
    ) -> (Value, u64) {
        debug_assert_shutdown_cancel_visible(state);
        let generation = self
            .service_status_generation
            .fetch_add(1, Ordering::AcqRel)
            + 1;
        let tasks = self.timeline_task_summary();
        (
            Self::service_status_data_with_tasks(
                state.state,
                state.input_queue.len(),
                state.last_error.clone(),
                state.context_maintenance.clone(),
                tasks,
            ),
            generation,
        )
    }

    pub(super) fn service_status_data(
        &self,
        state: ServiceState,
        queue_length: usize,
        last_error: Option<String>,
        context_maintenance: ContextMaintenanceStatus,
    ) -> Value {
        let tasks = self.timeline_task_summary();
        Self::service_status_data_with_tasks(
            state,
            queue_length,
            last_error,
            context_maintenance,
            tasks,
        )
    }

    fn service_status_data_from_values(
        &self,
        state: ServiceState,
        queue_length: usize,
        last_error: Option<String>,
        context_maintenance: ContextMaintenanceStatus,
        tasks: Value,
    ) -> (Value, u64) {
        let generation = self
            .service_status_generation
            .fetch_add(1, Ordering::AcqRel)
            + 1;
        (
            Self::service_status_data_with_tasks(
                state,
                queue_length,
                last_error,
                context_maintenance,
                tasks,
            ),
            generation,
        )
    }

    fn service_status_data_with_tasks(
        state: ServiceState,
        queue_length: usize,
        last_error: Option<String>,
        context_maintenance: ContextMaintenanceStatus,
        tasks: Value,
    ) -> Value {
        json!({
            "state": service_state_name(state),
            "queue_length": queue_length,
            "tasks": tasks,
            "context_maintenance": context_maintenance.to_json(),
            "last_error": last_error
        })
    }

    pub(super) fn try_append_service_status_for_locked(
        &self,
        state: &mut ServiceInnerState,
        turn_id: Option<&str>,
    ) -> Result<ServiceEvent, FailedTransitionIntent> {
        self.try_append_service_status_event_for_locked(state, turn_id)
            .map_err(|error| self.record_timeline_persistence_error_for_locked(error))
    }

    pub(super) fn try_append_service_status_event_for_locked(
        &self,
        state: &ServiceInnerState,
        turn_id: Option<&str>,
    ) -> Result<ServiceEvent, TimelineStoreError> {
        let (data, generation) = self.service_status_data_from_locked(state);
        let result = self.try_append_event_for_turn(turn_id, "service.status", data);
        match &result {
            Ok(_) => self.mark_service_status_published(generation),
            Err(_) => self.mark_service_status_dirty(generation),
        }
        result
    }

    pub(super) fn append_service_status_for_current_state(
        &self,
        turn_id: Option<&str>,
    ) -> Option<ServiceEvent> {
        match self.try_append_service_status_for_current_state(turn_id) {
            Ok(event) => Some(event),
            Err(failure) => {
                failure.transition(self);
                None
            }
        }
    }

    pub(super) fn try_append_service_status_for_current_state(
        &self,
        turn_id: Option<&str>,
    ) -> Result<ServiceEvent, FailedTransitionIntent> {
        let (data, generation) = {
            let state = self.state.lock().expect("service state mutex poisoned");
            self.service_status_data_from_locked(&state)
        };
        let result = self.try_append_event_for_turn(turn_id, "service.status", data);
        match result {
            Ok(event) => {
                self.mark_service_status_published(generation);
                Ok(event)
            }
            Err(error) => {
                self.mark_service_status_dirty(generation);
                Err(FailedTransitionIntent::timeline(error))
            }
        }
    }

    pub(super) fn append_post_commit_service_status(&self, turn_id: Option<&str>) {
        let (data, generation) = {
            let state = self.state.lock().expect("service state mutex poisoned");
            self.service_status_data_from_locked(&state)
        };
        let result = self.try_append_event_for_turn(turn_id, "service.status", data);
        match result {
            Err(_) => self.mark_service_status_dirty(generation),
            Ok(_) => self.mark_service_status_published(generation),
        }
    }

    pub(super) fn mark_service_status_dirty(&self, generation: u64) {
        if self
            .published_service_status_generation
            .load(Ordering::Acquire)
            >= generation
        {
            return;
        }
        self.dirty_service_status_generation
            .fetch_max(generation, Ordering::AcqRel);
        let published = self
            .published_service_status_generation
            .load(Ordering::Acquire);
        self.clear_published_dirty_service_status(published);
        if self.dirty_service_status_generation.load(Ordering::Acquire) != 0 {
            self.service_projection_notify.notify_one();
        }
    }

    pub(super) fn mark_service_status_published(&self, generation: u64) {
        let published = self
            .published_service_status_generation
            .fetch_max(generation, Ordering::AcqRel)
            .max(generation);
        self.clear_published_dirty_service_status(published);
    }

    fn clear_published_dirty_service_status(&self, published: u64) {
        let mut dirty = self.dirty_service_status_generation.load(Ordering::Acquire);
        while dirty != 0 && dirty <= published {
            match self.dirty_service_status_generation.compare_exchange_weak(
                dirty,
                0,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(current) => dirty = current,
            }
        }
    }

    pub(super) fn try_project_dirty_service_status_once(&self) {
        let dirty_generation = self.dirty_service_status_generation.load(Ordering::Acquire);
        if dirty_generation == 0 {
            return;
        }
        let (data, generation) = {
            let state = self.state.lock().expect("service state mutex poisoned");
            self.service_status_data_from_locked(&state)
        };
        if self
            .try_append_event_for_turn(None, "service.status", data)
            .is_err()
        {
            return;
        }
        self.mark_service_status_published(generation);
    }

    pub(super) fn append_task_updated_event(&self, snapshot: &TaskSnapshot) {
        self.append_event_for_turn_or_record_error(None, "task.updated", task_event_data(snapshot));
        self.append_service_status_for_current_state(None);
    }

    pub(super) fn prepare_callback_delivery_events(
        &self,
        plan: &InputQueueCommitPlan,
        cycle_id: Option<&str>,
    ) -> Vec<PreparedCallbackDeliveryEvent> {
        let mut events = Vec::new();
        for message in &plan.messages {
            let input_id = &message.id;
            if let Some(metadata @ QueuedInputMetadata::TaskCallback { .. }) =
                message.metadata.as_ref()
            {
                events.push(PreparedCallbackDeliveryEvent {
                    input_id: input_id.clone(),
                    target: CallbackDeliveryTarget::Task,
                    data: project_task_callback_delivery(input_id, metadata, cycle_id),
                });
                continue;
            }
            let Some(QueuedInputMetadata::SubagentCallback { subagent_id, .. }) =
                message.metadata.as_ref()
            else {
                continue;
            };
            let delivered_subagent_callback = {
                self.subagents
                    .lock()
                    .expect("subagent manager mutex poisoned")
                    .callback_delivered_snapshot(input_id)
            };
            let mut data = delivered_subagent_callback
                .as_ref()
                .map(subagent_event_data)
                .unwrap_or_else(|| json!({ "subagent_id": subagent_id }));
            project_subagent_callback_metadata(
                &mut data,
                input_id,
                message.metadata.as_ref().expect("matched metadata"),
                "delivered",
            );
            events.push(PreparedCallbackDeliveryEvent {
                input_id: input_id.clone(),
                target: CallbackDeliveryTarget::Subagent,
                data,
            });
        }
        events
    }

    pub(super) fn track_callback_delivery_intents(&self, intents: &[CallbackDeliveryIntent]) {
        let mut pending = self
            .pending_delivery_intents
            .lock()
            .expect("pending delivery intents mutex poisoned");
        for intent in intents {
            if !pending
                .iter()
                .any(|pending| pending.projection_id == intent.projection_id)
            {
                pending.push_back(intent.clone());
            }
        }
    }

    pub(super) async fn try_project_pending_service_projections(&self) {
        let _runner = self.service_projection_runner.lock().await;
        self.try_project_pending_service_projections_once();
    }

    fn try_project_pending_service_projections_once(&self) {
        let intents = self
            .pending_delivery_intents
            .lock()
            .expect("pending delivery intents mutex poisoned")
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        for intent in intents {
            if self.project_callback_delivery_intent_once(&intent).is_ok() {
                let mut pending = self
                    .pending_delivery_intents
                    .lock()
                    .expect("pending delivery intents mutex poisoned");
                if let Some(index) = pending
                    .iter()
                    .position(|queued| queued.projection_id == intent.projection_id)
                {
                    pending.remove(index);
                }
            }
        }
        self.try_project_dirty_service_status_once();
    }

    pub(super) fn ensure_service_projection_retry_loop(self: &Arc<Self>) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        if self
            .service_projection_worker_started
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let weak_inner = Arc::downgrade(self);
        runtime.spawn(async move {
            let mut backoff = CALLBACK_DELIVERY_RETRY_MIN_BACKOFF;
            loop {
                let Some(inner) = weak_inner.upgrade() else {
                    return;
                };
                let notified = inner.service_projection_notify.clone();
                let shutdown = inner.task_observer_preview_cancel.clone();
                drop(inner);
                tokio::select! {
                    _ = notified.notified() => {}
                    _ = shutdown.cancelled() => return,
                }
                loop {
                    let Some(inner) = weak_inner.upgrade() else {
                        return;
                    };
                    let shutdown = inner.task_observer_preview_cancel.clone();
                    drop(inner);
                    tokio::select! {
                        _ = tokio::time::sleep(backoff) => {}
                        _ = shutdown.cancelled() => return,
                    }
                    let Some(inner) = weak_inner.upgrade() else {
                        return;
                    };
                    let _runner = inner.service_projection_runner.lock().await;
                    let Some(worker_guard) =
                        inner.register_service_worker(ServiceWorkerKind::CallbackProjectionRetry)
                    else {
                        return;
                    };
                    let projection_inner = inner.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        projection_inner.try_project_pending_service_projections_once();
                    })
                    .await;
                    drop(worker_guard);
                    let callbacks_empty = inner
                        .pending_delivery_intents
                        .lock()
                        .expect("pending delivery intents mutex poisoned")
                        .is_empty();
                    let status_clean = inner
                        .dirty_service_status_generation
                        .load(Ordering::Acquire)
                        == 0;
                    if callbacks_empty && status_clean {
                        backoff = CALLBACK_DELIVERY_RETRY_MIN_BACKOFF;
                        break;
                    }
                    backoff = (backoff * 2).min(CALLBACK_DELIVERY_RETRY_MAX_BACKOFF);
                }
            }
        });
    }

    pub(super) fn project_callback_delivery_intent_once(
        &self,
        intent: &CallbackDeliveryIntent,
    ) -> Result<(), String> {
        let event_type = match intent.event_type {
            CallbackDeliveryEventType::TaskDelivered => "task.callback_delivered",
            CallbackDeliveryEventType::SubagentDelivered => "subagent.callback_delivered",
        };
        let mut data = intent.data.clone();
        data["projection_id"] = json!(intent.projection_id);
        self.try_append_callback_projection_event(event_type, &intent.projection_id, data)
            .map_err(|error| error.to_string())?;
        let Some(recorder) = self.session_recorder.as_deref() else {
            return Ok(());
        };
        recorder
            .record_delivery_projected_sync(std::slice::from_ref(&intent.projection_id))
            .map_err(|error| error.to_string())
    }

    pub(super) fn last_event_seq(&self) -> u64 {
        self.timeline_store
            .lock()
            .expect("timeline store mutex poisoned")
            .checkpoint()
            .seq
    }

    #[cfg(test)]
    pub(super) fn append_event_for_turn(
        &self,
        turn_id: Option<&str>,
        event_type: &str,
        data: serde_json::Value,
    ) -> ServiceEvent {
        self.try_append_event_for_turn(turn_id, event_type, data)
            .expect("timeline event should persist")
    }

    pub(super) fn append_event_for_turn_or_record_error(
        &self,
        turn_id: Option<&str>,
        event_type: &str,
        data: serde_json::Value,
    ) -> Option<ServiceEvent> {
        match self.try_append_event_for_turn(turn_id, event_type, data) {
            Ok(event) => Some(event),
            Err(error) => {
                self.record_timeline_persistence_error(error);
                None
            }
        }
    }

    pub(super) fn try_append_event_for_turn_or_mark_locked(
        &self,
        _state: &mut ServiceInnerState,
        turn_id: Option<&str>,
        event_type: &str,
        data: serde_json::Value,
    ) -> Result<ServiceEvent, FailedTransitionIntent> {
        match self.try_append_event_for_turn(turn_id, event_type, data) {
            Ok(event) => Ok(event),
            Err(error) => Err(self.record_timeline_persistence_error_for_locked(error)),
        }
    }

    pub(super) fn try_append_event_for_turn(
        &self,
        turn_id: Option<&str>,
        event_type: &str,
        data: serde_json::Value,
    ) -> Result<ServiceEvent, TimelineStoreError> {
        #[cfg(test)]
        self.event_commit_test_hook
            .gate_attempt(EventCommitGateActor::Regular);
        let _event_commit_guard = self
            .event_commit_gate
            .lock()
            .expect("event commit gate poisoned");
        if let Some(failure) = self.next_service_event_write_failure() {
            self.timeline_store
                .lock()
                .expect("timeline store mutex poisoned")
                .inject_next_write_failure(failure);
        }
        let event = append_committed_service_event(
            &self.timeline_store,
            &self.event_log,
            #[cfg(test)]
            Some(&self.event_commit_test_hook),
            self.config.session.as_deref(),
            turn_id,
            event_type,
            data,
        )?;
        self.record_public_replay_event(&event);
        self.event_notify.notify_waiters();
        Ok(event)
    }

    fn try_append_callback_projection_event(
        &self,
        event_type: &str,
        projection_id: &str,
        data: Value,
    ) -> Result<Option<ServiceEvent>, TimelineStoreError> {
        #[cfg(test)]
        self.event_commit_test_hook
            .gate_attempt(EventCommitGateActor::Callback);
        let _event_commit_guard = self
            .event_commit_gate
            .lock()
            .expect("event commit gate poisoned");
        if let Some(failure) = self.next_service_event_write_failure() {
            self.timeline_store
                .lock()
                .expect("timeline store mutex poisoned")
                .inject_next_write_failure(failure);
        }
        let event = append_callback_projection_service_event(
            &self.timeline_store,
            &self.event_log,
            #[cfg(test)]
            &self.event_commit_test_hook,
            self.config.session.as_deref(),
            event_type,
            projection_id,
            data,
        )?;
        if let Some(event) = event.as_ref() {
            self.record_public_replay_event(event);
            self.event_notify.notify_waiters();
        }
        Ok(event)
    }

    fn next_service_event_write_failure(&self) -> Option<TimelineWriteFailure> {
        let mut guard = self
            .next_service_event_write_failure
            .lock()
            .expect("service event write failure mutex poisoned");
        let (remaining, failure) = guard.as_mut()?;
        if *remaining == 0 {
            let failure = *failure;
            *guard = None;
            return Some(failure);
        }
        *remaining -= 1;
        None
    }

    fn record_public_replay_event(&self, event: &ServiceEvent) {
        if self.session_recorder.is_none() {
            return;
        }
        self.public_replay
            .lock()
            .expect("public replay projection buffer mutex poisoned")
            .observe(event);
    }
}
