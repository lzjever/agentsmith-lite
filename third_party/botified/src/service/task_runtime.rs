use super::*;

static NEXT_TASK_PRESET_TOOL_CALL_SUFFIX: AtomicU64 = AtomicU64::new(1);

pub(super) struct TaskObserverPreviewLoopStartedGuard {
    started: Weak<AtomicBool>,
}

impl TaskObserverPreviewLoopStartedGuard {
    pub(super) fn new(started: Weak<AtomicBool>) -> Self {
        Self { started }
    }
}

impl Drop for TaskObserverPreviewLoopStartedGuard {
    fn drop(&mut self) {
        if let Some(started) = self.started.upgrade() {
            started.store(false, Ordering::Release);
        }
    }
}

impl ServiceInner {
    pub(super) fn task_preset_list_details(&self) -> Value {
        let task_presets = self
            .task_presets
            .lock()
            .expect("task presets mutex poisoned")
            .clone();
        let tasks = self.background_tasks.list_by_owner(&TaskOwner::Main);
        let presets = task_presets
            .presets
            .iter()
            .map(|(id, preset)| {
                let running_task_ids = tasks
                    .iter()
                    .filter(|task| {
                        task.preset_id.as_deref() == Some(id.as_str())
                            && matches!(task.state, TaskState::Running | TaskState::Cancelling)
                    })
                    .map(|task| task.task_id.clone())
                    .collect::<Vec<_>>();
                json!({
                    "id": id,
                    "description": preset.description,
                    "running_task_ids": running_task_ids,
                    "start_on_boot": task_presets.start_on_boot.iter().any(|boot_id| boot_id == id),
                })
            })
            .collect::<Vec<_>>();
        json!({
            "kind": "task_preset_list",
            "presets": presets,
        })
    }

    pub(super) fn start_task_preset(self: &Arc<Self>, preset_id: &str) -> Value {
        let Some((description, command)) = self
            .task_presets
            .lock()
            .expect("task presets mutex poisoned")
            .presets
            .get(preset_id)
            .map(|preset| (preset.description.clone(), preset.command.clone()))
        else {
            return task_preset_start_error(
                preset_id,
                "preset_not_found",
                format!("task preset not found: {preset_id}"),
            );
        };

        if self.is_failed_or_shutting_down() {
            return task_preset_start_error(
                preset_id,
                "service_unavailable",
                "service is not available",
            );
        }
        let Some(run_tool) = self
            .task_preset_bash_tool
            .lock()
            .expect("task preset bash tool mutex poisoned")
            .clone()
        else {
            return task_preset_start_error(
                preset_id,
                "service_unavailable",
                "task preset bash execution is not configured",
            );
        };
        let host = ServiceBackgroundExecutionHost {
            inner: self.clone(),
            owner: TaskOwner::Main,
        };
        let task_id = host.allocate_task_id();
        let Some(interactive_stdio) = host.interactive_stdio_bridge(&task_id) else {
            return task_preset_start_error(
                preset_id,
                "interactive_stdio_unavailable",
                "interactive stdio bridge is not available",
            );
        };

        let tool_call = ToolCall::new(
            next_task_preset_tool_call_id(preset_id),
            "bash",
            json!({
                "command": command,
                "timeout_secs": Value::Null,
            }),
        );
        let cancel = CancellationToken::new();
        let now = SystemTime::now();
        let task = NewBackgroundTask::new(
            tool_call.id.clone(),
            tool_call.name.clone(),
            description.clone(),
        )
        .with_detached_at(now)
        .with_cancel_token(cancel.clone())
        .with_preset(preset_id.to_owned(), description.clone());

        if let Err(limit) = self.background_tasks.try_start_task_with_id(
            task_id.clone(),
            task.clone().with_owner(TaskOwner::Main),
            self.config.tool_execution.max_concurrent_tasks,
        ) {
            cancel.cancel();
            return task_preset_start_error(
                preset_id,
                "background_task_concurrency_limit",
                format!(
                    "background task concurrency limit reached: {} running or cancelling tasks",
                    limit.max_concurrent_tasks
                ),
            );
        }

        let output_sink = match BoundedTaskOutputSink::create(
            &self.config.task_output,
            &self.config.cwd,
            task_id.clone(),
            Some(host.task_manager()),
        ) {
            Ok(sink) => sink,
            Err(error) => {
                host.rollback_unpublished_task(&task_id, &cancel);
                return task_preset_start_error(
                    preset_id,
                    "output_artifact_error",
                    error.to_string(),
                );
            }
        };
        output_sink.sync_to_task_record();

        if !host.publish_task(task_id.clone(), task) {
            cancel.cancel();
            if self.background_tasks.get(&task_id).is_none() {
                remove_unpublished_task_output_artifact(output_sink, self.config.cwd.as_str());
            }
            return task_preset_start_error(
                preset_id,
                "task_preset_start_failed",
                "failed to publish task preset background task",
            );
        }
        let Some(snapshot) = self.background_tasks.get(&task_id) else {
            cancel.cancel();
            return task_preset_start_error(
                preset_id,
                "task_preset_start_failed",
                "task preset background task disappeared after publish",
            );
        };

        let run_host = host;
        let run_tool_call = tool_call.clone();
        let run_output_sink = output_sink.clone() as Arc<dyn ToolOutputSink>;
        let run_interactive_stdio = interactive_stdio;
        let run_cancel = cancel.clone();
        let run_cwd = self.config.cwd.clone();
        let run_task_id = task_id.clone();
        tokio::spawn(async move {
            let context = ToolExecutionContext::new(run_cwd)
                .with_no_deadline()
                .with_output_sink(run_output_sink)
                .with_interactive_stdio(run_interactive_stdio);
            let result = run_tool
                .execute(run_tool_call.clone(), context, run_cancel.clone())
                .await;
            let tool_result = match result {
                Ok(result) => result,
                Err(error) => ToolResult::error(
                    run_tool_call.id.clone(),
                    run_tool_call.name.clone(),
                    error.to_string(),
                    json!({"kind": "tool_error"}),
                ),
            };
            let state = if run_cancel.is_cancelled()
                || tool_result
                    .details
                    .get("cancelled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            {
                TaskState::Cancelled
            } else if tool_result
                .details
                .get("timed_out")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                TaskState::TimedOut
            } else if tool_result.is_error {
                TaskState::Failed
            } else {
                TaskState::Completed
            };
            run_host
                .finish_task(
                    run_task_id,
                    run_tool_call,
                    DetachedToolResult { tool_result, state },
                )
                .await;
        });

        let detail = task_detail_summary(snapshot);
        json!({
            "kind": "task_preset_start",
            "ok": true,
            "preset_id": preset_id,
            "description": description,
            "task_id": task_id,
            "task": detail["task"].clone(),
            "timeline_cursor": current_timeline_cursor(&self.timeline_store).to_string(),
        })
    }
}

pub(super) fn schedule_task_request_deadline_check(
    inner: Arc<ServiceInner>,
    snapshot: TaskRequestSnapshot,
) {
    let task_id = snapshot.task_id;
    let deadline_at = snapshot.deadline_at;
    let delay = snapshot
        .deadline_at
        .duration_since(SystemTime::now())
        .unwrap_or(Duration::ZERO);
    let sleep = tokio::time::sleep(delay);
    tokio::spawn(async move {
        sleep.await;
        if inner.is_failed_or_shutting_down() {
            return;
        }
        inner.expire_due_task_requests(&task_id, deadline_at);
    });
}

pub(super) fn exception_code_for_service_error(error: &ServiceError) -> &'static str {
    match error {
        ServiceError::QueueFull => "queue_full",
        ServiceError::EmptyMessage => "empty_message",
        ServiceError::MessageConflict { .. } => "message_conflict",
        ServiceError::ShuttingDown => "service_shutting_down",
        ServiceError::Configuration { .. } => "configuration_error",
        ServiceError::Persistence { .. } => "persistence_error",
    }
}

pub(super) fn exception_code_for_rejected_request(reason: &str) -> &'static str {
    if reason.contains("global task ask pending limit") {
        "global_pending_limit_reached"
    } else if reason.contains("pending limit") {
        "pending_limit_reached"
    } else if reason.contains("terminal") {
        "task_terminal"
    } else {
        "ask_rejected"
    }
}

pub(super) struct ServiceBackgroundExecutionHost {
    pub(super) inner: Arc<ServiceInner>,
    pub(super) owner: TaskOwner,
}

impl ServiceBackgroundExecutionHost {
    fn rollback_unpublished_task(&self, task_id: &str, cancel: &CancellationToken) {
        cancel.cancel();
        self.inner
            .background_tasks
            .discard_unstarted_by_owner(&self.owner, task_id);
    }
}

fn remove_unpublished_task_output_artifact(output_sink: Arc<BoundedTaskOutputSink>, cwd: &str) {
    let artifact_path = output_sink.artifact_path();
    drop(output_sink);
    let Some(artifact_path) = artifact_path else {
        return;
    };
    let cwd =
        crate::path_utils::lexical_absolute(std::path::Path::new(cwd), std::path::Path::new("."));
    let artifact_path = crate::path_utils::lexical_absolute(&artifact_path, &cwd);
    match std::fs::remove_file(&artifact_path) {
        Ok(()) => {
            if let Some(parent) = artifact_path.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {}
    }
}

#[async_trait]
impl BackgroundExecutionHost for ServiceBackgroundExecutionHost {
    fn allocate_task_id(&self) -> String {
        self.inner.background_tasks.allocate_task_id()
    }

    fn task_manager(&self) -> Arc<BackgroundTaskManager> {
        self.inner.background_tasks.clone()
    }

    fn publish_task(&self, task_id: String, task: NewBackgroundTask) -> bool {
        let task = task.with_owner(self.owner.clone());
        if let TaskOwner::Subagent { subagent_id } = &self.owner {
            #[cfg(test)]
            self.inner
                .run_subagent_test_hook(SubagentTestHookKind::SubagentPublishOpenCheck);
            let (subagent_snapshot, started_task_id) = {
                let _lifecycle = self
                    .inner
                    .subagent_lifecycle
                    .lock()
                    .expect("subagent lifecycle mutex poisoned");
                let state = self
                    .inner
                    .state
                    .lock()
                    .expect("service state mutex poisoned");
                if matches!(
                    state.state,
                    ServiceState::Failed | ServiceState::ShuttingDown
                ) {
                    task.cancel_token.cancel();
                    return false;
                }
                let mut manager = self
                    .inner
                    .subagents
                    .lock()
                    .expect("subagent manager mutex poisoned");
                let subagent_open = manager
                    .snapshot(subagent_id)
                    .is_some_and(|snapshot| snapshot.lifecycle != SubagentLifecycle::Cancelled);
                if !subagent_open {
                    task.cancel_token.cancel();
                    return false;
                }
                let snapshot = match self.inner.background_tasks.try_start_task_with_id(
                    task_id,
                    task.clone(),
                    self.inner.config.tool_execution.max_concurrent_tasks,
                ) {
                    Ok(snapshot) => snapshot,
                    Err(_) => {
                        task.cancel_token.cancel();
                        return false;
                    }
                };
                let started_task_id = snapshot.task_id.clone();
                match manager.add_owned_task_id(subagent_id, snapshot.task_id) {
                    Ok(snapshot) => (snapshot, started_task_id),
                    Err(_) => {
                        self.inner
                            .background_tasks
                            .cancel_by_owner(&self.owner, &started_task_id);
                        return false;
                    }
                }
            };
            let append = self
                .inner
                .append_subagent_event_outcome("subagent.callback", &subagent_snapshot);
            if !append.complete() {
                if let Some(finalization) = self.inner.background_tasks.cancel_and_fail_by_owner(
                    &self.owner,
                    &started_task_id,
                    "subagent task publish persistence failed",
                ) {
                    self.inner
                        .apply_task_request_effects(&finalization.pending_request_effects);
                    self.inner
                        .background_tasks
                        .release_stdin_writer(&started_task_id);
                    if append.event_written {
                        self.inner.append_subagent_task_failed_event(
                            &subagent_snapshot,
                            &finalization.snapshot,
                            "subagent_task_publish_persistence_failed",
                        );
                    }
                }
                return false;
            }
            return true;
        }
        let mut failure = None;
        {
            #[cfg(test)]
            self.inner
                .run_subagent_test_hook(SubagentTestHookKind::BackgroundTaskPublishBeforeAppend);
            let mut state = self
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            if matches!(
                state.state,
                ServiceState::Failed | ServiceState::ShuttingDown
            ) {
                self.rollback_unpublished_task(&task_id, &task.cancel_token);
                return false;
            }
            let snapshot = if let Some(snapshot) = self.inner.background_tasks.get(&task_id) {
                snapshot
            } else {
                match self.inner.background_tasks.try_start_task_with_id(
                    task_id.clone(),
                    task.clone(),
                    self.inner.config.tool_execution.max_concurrent_tasks,
                ) {
                    Ok(snapshot) => snapshot,
                    Err(_) => {
                        self.rollback_unpublished_task(&task_id, &task.cancel_token);
                        return false;
                    }
                }
            };
            if self.owner == TaskOwner::Main {
                if let Err(error) = self.inner.try_append_event_for_turn_or_mark_locked(
                    &mut state,
                    None,
                    "task.detached",
                    task_event_data(&snapshot),
                ) {
                    self.rollback_unpublished_task(&snapshot.task_id, &task.cancel_token);
                    failure = Some(error);
                } else if let Err(error) = self
                    .inner
                    .try_append_service_status_for_locked(&mut state, None)
                {
                    if let Some(finalization) =
                        self.inner.background_tasks.cancel_and_fail_by_owner(
                            &self.owner,
                            &snapshot.task_id,
                            "task startup persistence failed",
                        )
                    {
                        self.inner
                            .apply_task_request_effects(&finalization.pending_request_effects);
                        self.inner
                            .background_tasks
                            .release_stdin_writer(&snapshot.task_id);
                        let failed_snapshot = self
                            .inner
                            .background_tasks
                            .get(&snapshot.task_id)
                            .unwrap_or(finalization.snapshot);
                        let _ = self.inner.try_append_event_for_turn(
                            None,
                            "task.failed",
                            task_event_data(&failed_snapshot),
                        );
                        let _ = self
                            .inner
                            .try_append_service_status_event_for_locked(&state, None);
                        self.inner
                            .background_tasks
                            .mark_terminal_callback_delivered_to_owner(&snapshot.task_id);
                    }
                    failure = Some(error);
                }
            }
        }
        if let Some(failure) = failure {
            failure.transition(self.inner.as_ref());
            return false;
        }
        true
    }

    async fn finish_task(&self, task_id: String, tool_call: ToolCall, result: DetachedToolResult) {
        let Some(_guard) = self
            .inner
            .register_service_worker(ServiceWorkerKind::BackgroundCompletion)
        else {
            return;
        };
        let frame_lane = {
            let mut admission = self
                .inner
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned");
            self.inner
                .finish_task_frame_admission(&mut admission, &task_id)
        };
        if let Some(frame_lane) = frame_lane {
            frame_lane.wait_done().await;
        }
        self.inner
            .pause_before_task_frame_commit_for_test(TaskFrameAdmissionKind::Finish);
        let had_observer_admission = {
            let _admission = self
                .inner
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned");
            self.inner.task_observer.close_admission(&task_id)
        };
        self.inner
            .retire_task_observer_for_exit(&task_id, "task_not_running")
            .await;
        if self.inner.is_failed_or_shutting_down() {
            {
                let mut admission = self
                    .inner
                    .task_frame_admission_gate
                    .lock()
                    .expect("task frame admission gate mutex poisoned");
                self.inner.background_tasks.finish_task(
                    &task_id,
                    result.state,
                    "service stopped before task completion could be recorded",
                );
                admission.finishing_tasks.remove(&task_id);
                admission.discarding_tasks.remove(&task_id);
            }
            let _ = had_observer_admission;
            self.inner.task_observer.release_closed_admission(&task_id);
            self.inner.task_observer.cleanup_terminal(&task_id);
            self.inner.background_tasks.release_stdin_writer(&task_id);
            return;
        }
        let should_record_final_text =
            self.inner
                .background_tasks
                .get(&task_id)
                .is_some_and(|snapshot| {
                    snapshot.output.artifact_path.is_none() && snapshot.output.output_bytes == 0
                });
        if should_record_final_text {
            if let Some(snapshot) = self.inner.background_tasks.update_output(
                &task_id,
                TaskOutputUpdate::bytes(result.tool_result.text.as_bytes()),
            ) {
                if self.owner == TaskOwner::Main {
                    self.inner.append_task_updated_event(&snapshot);
                }
            }
        }
        let finalization = {
            let mut admission = self
                .inner
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned");
            let finalization = self.inner.background_tasks.finish_task(
                &task_id,
                result.state,
                "task reached terminal state",
            );
            admission.finishing_tasks.remove(&task_id);
            admission.discarding_tasks.remove(&task_id);
            finalization
        };
        let _ = had_observer_admission;
        self.inner.task_observer.release_closed_admission(&task_id);
        self.inner.task_observer.cleanup_terminal(&task_id);
        let Some(finalization) = finalization else {
            return;
        };
        self.inner
            .apply_task_request_effects(&finalization.pending_request_effects);
        let snapshot = self
            .inner
            .background_tasks
            .get(&task_id)
            .unwrap_or(finalization.snapshot);
        self.inner.background_tasks.release_stdin_writer(&task_id);

        match &self.owner {
            TaskOwner::Main => {
                if self
                    .inner
                    .append_event_for_turn_or_record_error(
                        None,
                        terminal_task_event_type(result.state),
                        task_event_data(&snapshot),
                    )
                    .is_none()
                {
                    self.inner.cancel_active_turn_if_failed();
                    return;
                }
                if self
                    .inner
                    .append_service_status_for_current_state(None)
                    .is_none()
                {
                    self.inner.cancel_active_turn_if_failed();
                    return;
                }
                if snapshot.preset_id.is_some() {
                    self.inner
                        .background_tasks
                        .mark_terminal_callback_delivered_to_owner(&task_id);
                    return;
                }
                if suppress_background_task_callback(&result.tool_result) {
                    self.inner
                        .background_tasks
                        .mark_terminal_callback_delivered_to_owner(&task_id);
                    return;
                }

                let callback_id = format!("task_callback_{task_id}");
                let callback = task_callback_content(&tool_call, &snapshot);
                if let Some(snapshot) = self.inner.background_tasks.set_callback_pending(
                    &task_id,
                    callback_id.clone(),
                    callback,
                ) {
                    if self
                        .inner
                        .append_event_for_turn_or_record_error(
                            None,
                            "task.callback_pending",
                            task_event_data(&snapshot),
                        )
                        .is_none()
                    {
                        self.inner
                            .background_tasks
                            .clear_callback_pending_if_payload(&task_id, &callback_id);
                        self.inner.cancel_active_turn_if_failed();
                        return;
                    }
                    if self
                        .inner
                        .append_service_status_for_current_state(None)
                        .is_none()
                    {
                        self.inner.cancel_active_turn_if_failed();
                        return;
                    }
                    retry_pending_task_callbacks(self.inner.clone()).await;
                }
            }
            TaskOwner::Subagent { subagent_id } => {
                let callback = task_callback_content(&tool_call, &snapshot);
                let outcome = enqueue_subagent_text_callback(
                    self.inner.clone(),
                    Some(&snapshot.task_id),
                    subagent_id,
                    subagent_task_callback_kind(snapshot.state),
                    None,
                    None,
                    callback_text(&callback),
                )
                .await;
                if outcome.queued {
                    self.inner
                        .background_tasks
                        .mark_terminal_callback_delivered_to_owner(&task_id);
                } else {
                    // The rejected enqueue is already the final owner-delivery fact; this path
                    // intentionally has no task.callback_failed timeline event.
                    self.inner.background_tasks.set_callback_failed_committed(
                        &task_id,
                        "subagent owner callback was not accepted",
                    );
                }
                if let Some(error) = outcome.persistence_error {
                    self.inner.record_timeline_persistence_error(error);
                }
            }
        }
    }

    fn interactive_stdio_bridge(&self, task_id: &str) -> Option<Arc<dyn InteractiveStdioBridge>> {
        Some(Arc::new(ServiceInteractiveStdioBridge {
            inner: self.inner.clone(),
            task_id: task_id.to_owned(),
        }))
    }
}

fn suppress_background_task_callback(result: &ToolResult) -> bool {
    matches!(
        result.details.get("kind").and_then(Value::as_str),
        Some("background_task_ack_aborted" | "background_task_ack_persistence_failed")
    )
}

pub(super) fn task_request_input_id(task_id: &str, request_id: &str) -> String {
    task_ask_item_id(task_id, request_id)
}

pub(super) fn task_tell_input_id(task_id: &str, tell_id: &str, suffix: u64) -> String {
    format!("task_tell_{task_id}_{tell_id}_{suffix}")
}

pub(super) fn task_tell_snapshot(
    task_id: &str,
    task: Option<&TaskSnapshot>,
    frame: TaskTellFrame,
    state: &'static str,
    failure_reason: Option<String>,
) -> TaskTellSnapshot {
    let display = task.map(crate::tasks::runtime_work_display);
    let arguments_summary = task
        .map(|task| bounded_chars(&task.arguments_summary, 512))
        .unwrap_or_default();
    let tool_name = task
        .map(|task| task.tool_name.clone())
        .unwrap_or_else(|| "unknown".to_owned());
    let sender = if arguments_summary.trim().is_empty() {
        tool_name.clone()
    } else {
        format!("{tool_name}: {arguments_summary}")
    };
    TaskTellSnapshot {
        task_id: task_id.to_owned(),
        tool_call_id: task
            .map(|task| task.tool_call_id.clone())
            .unwrap_or_default(),
        tool_name,
        arguments_summary,
        task_label: display.as_ref().and_then(|display| display.label.clone()),
        work_summary: display.and_then(|display| display.summary),
        owner: task.map(|task| task.owner.clone()).unwrap_or_default(),
        sender,
        tell_id: frame.id,
        message: frame.message,
        urgency: frame.urgency,
        state,
        told_at: SystemTime::now(),
        failure_reason,
    }
}

pub(super) fn managed_task_registry_origin(task: &TaskSnapshot) -> String {
    match &task.owner {
        TaskOwner::Main => format!("task:{}", task.task_id),
        TaskOwner::Subagent { subagent_id } => {
            format!("subagent:{subagent_id}/task:{}", task.task_id)
        }
    }
}

pub(super) fn default_registry_source_for_task(task: &TaskSnapshot) -> String {
    if task.tool_name.trim().is_empty() {
        "task".to_owned()
    } else {
        task.tool_name.clone()
    }
}

pub(super) fn task_stdin_intent_frame_kind(intent: &TaskStdinIntent) -> TaskStdinFrameKind {
    match intent.kind {
        TaskStdinIntentKind::Response | TaskStdinIntentKind::Exception { .. } => {
            TaskStdinFrameKind::Reply
        }
        TaskStdinIntentKind::Send => TaskStdinFrameKind::Send,
    }
}

fn next_task_preset_tool_call_id(preset_id: &str) -> String {
    let suffix = NEXT_TASK_PRESET_TOOL_CALL_SUFFIX.fetch_add(1, Ordering::SeqCst);
    let component = preset_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let component = if component.is_empty() {
        "preset".to_owned()
    } else {
        component
    };
    format!("task_preset_{component}_{suffix}")
}

fn task_preset_start_error(
    preset_id: &str,
    code: &'static str,
    message: impl Into<String>,
) -> Value {
    json!({
        "kind": "task_preset_start",
        "ok": false,
        "preset_id": preset_id,
        "code": code,
        "message": message.into(),
    })
}

pub(super) fn spawn_task_observer_preview_loop(
    observer: TaskConversationObserver,
    hub: LlmTextPreviewHub,
    mut subscription: LlmTextPreviewSubscription,
    started_guard: TaskObserverPreviewLoopStartedGuard,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let _started_guard = started_guard;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                frame = subscription.recv() => match frame {
                    Some(frame) => observer.publish_preview_frame(&frame),
                    None => {
                        observer.clear_stream_buffers();
                        subscription = hub.subscribe(LlmTextPreviewFilter::default());
                    }
                }
            }
        }
        observer.clear_stream_buffers();
    })
}

pub(super) async fn retry_pending_task_callbacks(inner: Arc<ServiceInner>) {
    if inner.is_failed_or_shutting_down() {
        return;
    }
    let pending = inner.background_tasks.pending_callbacks();
    for payload in pending {
        if !inner
            .background_tasks
            .get(&payload.task_id)
            .is_some_and(|snapshot| snapshot.owner == TaskOwner::Main)
        {
            continue;
        }
        if inner.has_queued_task_request_for_task(&payload.task_id) {
            continue;
        }
        if inner.is_failed_or_shutting_down() {
            return;
        }
        let EnqueueInputAttempt {
            outcome,
            start_cancel,
            preemption: _,
            failure: _,
        } = enqueue_task_callback_payload(inner.as_ref(), &payload).await;
        if inner.is_failed_or_shutting_down() {
            return;
        }
        let mut start_cancel = start_cancel;
        let mut should_notify = start_cancel.is_some();
        match outcome {
            Ok(_) => {
                if let Some(snapshot) = inner
                    .background_tasks
                    .set_callback_enqueued_if_pending(&payload.task_id)
                {
                    if inner
                        .append_event_for_turn_or_record_error(
                            None,
                            "task.callback_queued",
                            task_event_data(&snapshot),
                        )
                        .is_none()
                    {
                        inner.background_tasks.restore_callback_pending_if_enqueued(
                            &payload.task_id,
                            &payload.message_id,
                        );
                        if let Some(cancel) = start_cancel.take() {
                            cancel.cancel();
                        }
                        inner.cancel_active_turn_if_failed();
                        continue;
                    }
                    if inner
                        .append_service_status_for_current_state(None)
                        .is_none()
                    {
                        if let Some(cancel) = start_cancel.take() {
                            cancel.cancel();
                        }
                        inner.cancel_active_turn_if_failed();
                        continue;
                    }
                }
                should_notify = true;
            }
            Err(ServiceError::QueueFull) => {}
            Err(ServiceError::Persistence { message }) => {
                inner.mark_failed(message);
            }
            Err(error) => {
                record_pending_task_callback_failed(inner.as_ref(), &payload, error.to_string());
            }
        }
        if should_notify {
            inner.notify.notify_waiters();
        }
        if let Some(cancel) = start_cancel {
            spawn_service_loop(inner.clone(), cancel);
        }
    }
}

pub(super) async fn retry_pending_task_callbacks_for_inner(inner: &ServiceInner) {
    if inner.is_failed_or_shutting_down() {
        return;
    }
    let pending = inner.background_tasks.pending_callbacks();
    for payload in pending {
        if !inner
            .background_tasks
            .get(&payload.task_id)
            .is_some_and(|snapshot| snapshot.owner == TaskOwner::Main)
        {
            continue;
        }
        if inner.has_queued_task_request_for_task(&payload.task_id) {
            continue;
        }
        if inner.is_failed_or_shutting_down() {
            return;
        }
        let EnqueueInputAttempt { outcome, .. } =
            enqueue_task_callback_payload(inner, &payload).await;
        if inner.is_failed_or_shutting_down() {
            return;
        }
        match outcome {
            Ok(_) => {
                if let Some(snapshot) = inner
                    .background_tasks
                    .set_callback_enqueued_if_pending(&payload.task_id)
                {
                    if inner
                        .append_event_for_turn_or_record_error(
                            None,
                            "task.callback_queued",
                            task_event_data(&snapshot),
                        )
                        .is_none()
                    {
                        inner.background_tasks.restore_callback_pending_if_enqueued(
                            &payload.task_id,
                            &payload.message_id,
                        );
                        inner.cancel_active_turn_if_failed();
                        continue;
                    }
                    if inner
                        .append_service_status_for_current_state(None)
                        .is_none()
                    {
                        inner.cancel_active_turn_if_failed();
                        continue;
                    }
                }
                inner.notify.notify_waiters();
            }
            Err(ServiceError::QueueFull) => {}
            Err(ServiceError::Persistence { message }) => {
                inner.mark_failed(message);
            }
            Err(error) => {
                record_pending_task_callback_failed(inner, &payload, error.to_string());
            }
        }
    }
}

fn record_pending_task_callback_failed(
    inner: &ServiceInner,
    payload: &TaskCallbackPayloadSnapshot,
    reason: String,
) {
    if let Some(snapshot) = inner
        .background_tasks
        .stage_callback_failed_if_pending(&payload.task_id, reason)
    {
        let reason = snapshot
            .callback_failure_reason
            .as_deref()
            .expect("staged callback failure should have a reason");
        let event = inner.append_event_for_turn_or_record_error(
            None,
            "task.callback_failed",
            task_event_data(&snapshot),
        );
        if event.is_none() {
            inner.background_tasks.restore_callback_if_failed(
                &payload.task_id,
                &payload.message_id,
                reason,
                CallbackDelivery::Pending,
            );
            inner.cancel_active_turn_if_failed();
            return;
        }
        inner.background_tasks.commit_callback_failed_if_payload(
            &payload.task_id,
            &payload.message_id,
            reason,
        );
        inner.append_service_status_for_current_state(None);
    }
}

async fn enqueue_task_callback_payload(
    inner: &ServiceInner,
    payload: &TaskCallbackPayloadSnapshot,
) -> EnqueueInputAttempt {
    let metadata = inner
        .background_tasks
        .get(&payload.task_id)
        .and_then(|snapshot| task_callback_metadata(&snapshot));
    let Some(metadata) = metadata else {
        return EnqueueInputAttempt::rejected(
            ServiceError::Persistence {
                message: format!(
                    "terminal task callback snapshot {} is unavailable",
                    payload.task_id
                ),
            },
            None,
        );
    };
    enqueue_input_inner(
        inner,
        payload.message_id.clone(),
        payload.content.clone(),
        InputSource::TaskCallback,
        InputUrgency::Normal,
        Some(metadata),
    )
    .await
}

pub(super) fn project_task_callback_delivery(
    callback_id: &str,
    metadata: &QueuedInputMetadata,
    cycle_id: Option<&str>,
) -> Value {
    let QueuedInputMetadata::TaskCallback {
        task_id,
        tool_call_id,
        tool_name,
        execution_state,
        label,
        summary,
        output_tail,
        output_tail_truncated,
        error,
    } = metadata
    else {
        return Value::Null;
    };
    let state = match execution_state {
        TaskCallbackExecutionState::Completed => "completed",
        TaskCallbackExecutionState::Failed => "failed",
        TaskCallbackExecutionState::TimedOut => "timed_out",
        TaskCallbackExecutionState::Cancelled => "cancelled",
        TaskCallbackExecutionState::Lost => "lost",
    };
    let mut data = json!({
        "task_id": task_id,
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "state": state,
        "status": state,
        "task_label": label,
        "work_summary": summary,
        "output_tail": output_tail,
        "output_tail_truncated": output_tail_truncated,
        "callback_delivery": "delivered",
        "callback_input_id": callback_id,
    });
    if let Some(error) = error {
        data["error"] = json!(error);
    }
    if let Some(cycle_id) = cycle_id {
        data["cycle_id"] = json!(cycle_id);
    }
    data
}

pub(super) fn callback_text(content: &[ContentPart]) -> String {
    content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text { text } => Some(text.as_str()),
            ContentPart::ImageUrl { .. }
            | ContentPart::ImageBase64 { .. }
            | ContentPart::File { .. }
            | ContentPart::Skill { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}
