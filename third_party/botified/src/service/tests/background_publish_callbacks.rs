#[tokio::test]
async fn service_background_host_rejects_publish_after_shutdown_and_cancels_task() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-host-shutdown"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    let cancel = CancellationToken::new();

    let shutdown = service.shutdown().await;
    assert_eq!(shutdown.state, ServiceState::ShuttingDown);

    let published = host.publish_task(
        "task_after_shutdown".to_owned(),
        NewBackgroundTask::new("call_after_shutdown", "bash", "{}")
            .with_cancel_token(cancel.clone()),
    );

    assert!(!published);
    assert!(cancel.is_cancelled());
    assert!(service.get_background_task("task_after_shutdown").is_none());
    assert!(!service
        .events_after(0)
        .iter()
        .any(|event| event.event_type == "task.detached"));
}

#[test]
fn preset_publish_rejection_after_admission_rolls_back_task_and_artifact() {
    let home = service_test_home("preset-publish-rejection-rollback");
    fs::create_dir_all(&home).expect("create preset test home");
    let task_output =
        crate::tasks::TaskOutputPolicy::new(home.join(".botified/state"), 8192, 16 * 1024 * 1024);
    let service = Service::new(
        AgentConfig::new("system")
            .with_session("preset-publish-rejection-rollback")
            .with_cwd(home.display().to_string())
            .with_task_output_policy(task_output),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed")
    .with_task_presets(RuntimeTaskPresetsConfig {
        presets: [(
            "perception".to_owned(),
            crate::config::RuntimeTaskPresetConfig {
                description: "Runs perception.".to_owned(),
                command: "while true; do sleep 1; done".to_owned(),
            },
        )]
        .into_iter()
        .collect(),
        start_on_boot: Vec::new(),
    });
    let admitted = Arc::new(Mutex::new(None::<(String, PathBuf)>));
    {
        let inner = service.inner.clone();
        let admitted = admitted.clone();
        let home = home.clone();
        service.inner.set_subagent_test_hook(
            SubagentTestHookKind::BackgroundTaskPublishBeforeAppend,
            Arc::new(move || {
                let tasks = inner.background_tasks.list_by_owner(&TaskOwner::Main);
                assert_eq!(tasks.len(), 1, "preset should be admitted before publish");
                let snapshot = &tasks[0];
                let artifact = snapshot
                    .artifact_path
                    .clone()
                    .expect("admitted preset artifact path");
                let artifact = if artifact.is_absolute() {
                    artifact
                } else {
                    home.join(artifact)
                };
                assert!(artifact.is_file(), "artifact should exist before publish");
                *admitted.lock().expect("admitted task mutex poisoned") =
                    Some((snapshot.task_id.clone(), artifact));
                let mut state = inner.state.lock().expect("service state mutex poisoned");
                state.state = ServiceState::Failed;
                state.last_error = Some("injected pre-publish failure".to_owned());
            }),
        );
    }
    let before_seq = service.status().last_event_seq;

    let result = service.task_preset_start("perception");

    assert_eq!(result["kind"], "task_preset_start");
    assert_eq!(result["ok"], false);
    assert_eq!(result["code"], "task_preset_start_failed");
    assert!(result.get("task_id").is_none());
    let (task_id, artifact) = admitted
        .lock()
        .expect("admitted task mutex poisoned")
        .clone()
        .expect("publish hook should observe admitted preset");
    let retained_task = service.get_background_task(&task_id);
    let artifact_exists = artifact.exists();
    let task_events = service
        .events_after(before_seq)
        .into_iter()
        .filter(|event| {
            event.data["task_id"] == task_id
                || matches!(
                    event.event_type.as_str(),
                    "task.detached"
                        | "task.updated"
                        | "task.completed"
                        | "task.failed"
                        | "task.cancelled"
                )
        })
        .collect::<Vec<_>>();
    assert!(
        retained_task.is_none() && !artifact_exists && task_events.is_empty(),
        "failed preset publish leaked task={retained_task:?}, artifact={artifact_exists}, events={task_events:?}"
    );

    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::BackgroundTaskPublishBeforeAppend,
        Arc::new(|| {}),
    );
    drop(service);
    fs::remove_dir_all(home).expect("remove preset test home");
}

#[tokio::test]
async fn service_background_host_rejects_publish_when_task_detached_event_fails() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-host-detached-write-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    let cancel = CancellationToken::new();
    let before_seq = service.status().last_event_seq;
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

    let published = host.publish_task(
        "task_detached_write_fails".to_owned(),
        NewBackgroundTask::new("call_detached_write_fails", "bash", "{}")
            .with_cancel_token(cancel.clone()),
    );

    assert!(!published);
    assert!(cancel.is_cancelled());
    assert!(service
        .get_background_task("task_detached_write_fails")
        .is_none());
    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(service
        .status()
        .last_error
        .as_deref()
        .is_some_and(|error| error.contains("timeline persistence failed")));
    assert!(!service
        .events_after(before_seq)
        .iter()
        .any(|event| event.event_type == "task.detached"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn production_publish_rejection_reaches_bash_registration_and_reaps_child() {
    let pid_path = std::env::temp_dir().join(format!(
        "botified-production-publish-rejection-{}-{}.pid",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("system clock should follow the Unix epoch")
            .as_nanos()
    ));
    let provider = Arc::new(PrepublishBashProvider {
        pid_path: pid_path.clone(),
        calls: AtomicUsize::new(0),
    });
    let service = Service::new(
        AgentConfig::new("system")
            .with_session("service-production-publish-rejection")
            .with_tool_execution_policy(
                crate::ToolExecutionPolicy::default()
                    .with_max_detach_after(Duration::from_secs(60)),
            ),
        provider,
        vec![Arc::new(BashTool::new_local_for_test())],
    )
    .expect("service construction should succeed");
    {
        let inner = service.inner.clone();
        service.inner.set_subagent_test_hook(
            SubagentTestHookKind::BackgroundTaskPublishBeforeAppend,
            Arc::new(move || {
                inner
                    .timeline_store
                    .lock()
                    .expect("timeline store mutex poisoned")
                    .inject_next_write_failure(TimelineWriteFailure::Flush);
            }),
        );
    }

    service
        .enqueue(
            "msg_production_publish_rejection",
            vec![ContentPart::text("start interactive bash")],
        )
        .await
        .expect("message should enqueue");
    tokio::time::timeout(
        Duration::from_secs(10),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("publication failure should fail the service");
    let child_pid = std::fs::read_to_string(&pid_path)
        .expect("bash child should publish its pid before publication")
        .parse::<libc::pid_t>()
        .expect("bash child pid should parse");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            // SAFETY: signal 0 only probes whether the child still exists.
            if unsafe { libc::kill(child_pid, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("rejected registration should terminate and reap the bash child");
    assert!(service
        .inner
        .background_tasks
        .list()
        .iter()
        .all(|task| task.tool_call_id != "call_prepublish_rejected"));
    std::fs::remove_file(pid_path).expect("pid file cleanup should succeed");
}

#[tokio::test]
async fn service_background_host_rejects_publish_when_status_event_fails() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-host-status-write-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    let cancel = CancellationToken::new();
    let before_seq = service.status().last_event_seq;
    service.inject_timeline_write_failure_after_events(1, TimelineWriteFailure::Flush);

    let published = host.publish_task(
        "task_status_write_fails".to_owned(),
        NewBackgroundTask::new("call_status_write_fails", "bash", "{}")
            .with_cancel_token(cancel.clone()),
    );

    assert!(!published);
    assert!(cancel.is_cancelled());
    let task = service
        .get_background_task("task_status_write_fails")
        .expect("durable detached task should remain inspectable");
    assert_eq!(task["state"], "failed");
    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(service
        .status()
        .last_error
        .as_deref()
        .is_some_and(|error| error.contains("timeline persistence failed")));
    let events = service.events_after(before_seq);
    assert!(events
        .iter()
        .any(|event| event.event_type == "task.detached"));
    assert!(
        events.iter().any(|event| event.event_type == "task.failed"),
        "failed task should be durably visible after startup status failure: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|event| event.event_type == "service.status"),
        "service should publish a later failed status after the injected status failure: {events:?}"
    );
}

#[tokio::test]
async fn service_background_host_terminal_append_failure_does_not_enqueue_callback_or_start_agent()
{
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-host-terminal-write-failure"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    let task_id = "task_terminal_write_fails".to_owned();
    assert!(host.publish_task(
        task_id.clone(),
        NewBackgroundTask::new("call_terminal_write_fails", "bash", "{}"),
    ));
    let active_cancel = CancellationToken::new();
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_active_terminal_failure".to_owned());
        state.active_cancel = Some(active_cancel.clone());
    }
    service
        .inner
        .background_tasks
        .update_output(&task_id, TaskOutputUpdate::bytes("already captured"))
        .expect("task output should update");
    let before_seq = service.status().last_event_seq;
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);
    let tool_call = ToolCall::new("call_terminal_write_fails", "bash", json!({}));

    host.finish_task(
        task_id.clone(),
        tool_call.clone(),
        DetachedToolResult {
            tool_result: ToolResult::success(tool_call.id, tool_call.name, "done"),
            state: TaskState::Completed,
        },
    )
    .await;
    tokio::task::yield_now().await;

    let snapshot = service
        .inner
        .background_tasks
        .get(&task_id)
        .expect("task should remain visible after terminal append failure");
    assert_eq!(snapshot.state, TaskState::Completed);
    assert_eq!(snapshot.callback_delivery, CallbackDelivery::NotReady);
    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(active_cancel.is_cancelled());
    assert_eq!(service.status().queue_length, 0);
    assert_eq!(provider.calls(), 0);
    let events = service.events_after(before_seq);
    assert!(
        !events.iter().any(|event| matches!(
            event.event_type.as_str(),
            "task.completed" | "task.callback_pending" | "task.callback_queued"
        )),
        "terminal append failure must not publish or advance callback events: {events:?}"
    );
}

#[tokio::test]
async fn service_background_host_callback_pending_append_failure_rolls_back_pending_callback() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-host-callback-pending-write-failure"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    let task_id = "task_callback_pending_write_fails".to_owned();
    assert!(host.publish_task(
        task_id.clone(),
        NewBackgroundTask::new("call_callback_pending_write_fails", "bash", "{}"),
    ));
    let active_cancel = CancellationToken::new();
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_active_callback_pending_failure".to_owned());
        state.active_cancel = Some(active_cancel.clone());
    }
    service
        .inner
        .background_tasks
        .update_output(&task_id, TaskOutputUpdate::bytes("already captured"))
        .expect("task output should update");
    let before_seq = service.status().last_event_seq;
    service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);
    let tool_call = ToolCall::new("call_callback_pending_write_fails", "bash", json!({}));

    host.finish_task(
        task_id.clone(),
        tool_call.clone(),
        DetachedToolResult {
            tool_result: ToolResult::success(tool_call.id, tool_call.name, "done"),
            state: TaskState::Completed,
        },
    )
    .await;
    tokio::task::yield_now().await;

    let snapshot = service
        .inner
        .background_tasks
        .get(&task_id)
        .expect("task should remain visible after callback append failure");
    assert_eq!(snapshot.state, TaskState::Completed);
    assert_eq!(snapshot.callback_delivery, CallbackDelivery::NotReady);
    assert_eq!(snapshot.callback_payload, None);
    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(active_cancel.is_cancelled());
    assert_eq!(service.status().queue_length, 0);
    assert_eq!(provider.calls(), 0);
    let events = service.events_after(before_seq);
    assert!(events
        .iter()
        .any(|event| event.event_type == "task.completed"));
    assert!(
        !events.iter().any(|event| matches!(
            event.event_type.as_str(),
            "task.callback_pending" | "task.callback_queued"
        )),
        "callback pending append failure must not publish callback events: {events:?}"
    );
}

#[tokio::test]
async fn pending_task_callback_queued_append_failure_does_not_mark_enqueued_or_start_agent() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-host-callback-queued-write-failure"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_callback_queued_write_fails",
            "bash",
            "{}",
        ));
    let callback_id = "task_callback_queued_write_fails";
    complete_task_callback_fixture(&service, &task.task_id);
    service
        .inner
        .background_tasks
        .set_callback_pending(
            &task.task_id,
            callback_id,
            vec![ContentPart::text("<task_callback />")],
        )
        .expect("callback should become pending");
    let before_seq = service.status().last_event_seq;
    service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);

    retry_pending_task_callbacks(service.inner.clone()).await;
    tokio::task::yield_now().await;

    let snapshot = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain visible after queued append failure");
    assert_eq!(snapshot.callback_delivery, CallbackDelivery::Pending);
    assert_eq!(service.status().state, ServiceState::Failed);
    assert_eq!(provider.calls(), 0);
    let events = service.events_after(before_seq);
    assert!(
        !events
            .iter()
            .any(|event| event.event_type == "task.callback_queued"),
        "failed task.callback_queued append must not publish queued event: {events:?}"
    );
}

#[tokio::test]
async fn pending_task_callback_enqueue_persistence_failure_keeps_pending_callback() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system")
            .with_session("service-host-callback-enqueue-persistence-failure"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_callback_enqueue_write_fails",
            "bash",
            "{}",
        ));
    let callback_id = "task_callback_enqueue_write_fails";
    complete_task_callback_fixture(&service, &task.task_id);
    service
        .inner
        .background_tasks
        .set_callback_pending(
            &task.task_id,
            callback_id,
            vec![ContentPart::text("<task_callback />")],
        )
        .expect("callback should become pending");
    let before_seq = service.status().last_event_seq;
    service.inject_timeline_write_failure_after_events(1, TimelineWriteFailure::Flush);

    retry_pending_task_callbacks(service.inner.clone()).await;
    tokio::task::yield_now().await;

    let snapshot = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain visible after callback enqueue failure");
    assert_eq!(snapshot.callback_delivery, CallbackDelivery::Pending);
    assert_eq!(service.status().state, ServiceState::Failed);
    assert_eq!(service.status().queue_length, 0);
    assert_eq!(provider.calls(), 0);
    let events = service.events_after(before_seq);
    assert!(events
        .iter()
        .any(|event| event.event_type == "message.received"));
    assert!(
        !events.iter().any(|event| matches!(
            event.event_type.as_str(),
            "task.callback_failed" | "task.callback_queued"
        )),
        "callback enqueue persistence failure must leave callback pending: {events:?}"
    );
}

#[tokio::test]
async fn pending_task_callback_failed_append_failure_restores_pending_callback() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-host-callback-failed-write-failure"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_callback_failed_write_fails",
            "bash",
            "{}",
        ));
    let callback_id = "task_callback_failed_write_fails";
    complete_task_callback_fixture(&service, &task.task_id);
    service
        .inner
        .background_tasks
        .set_callback_pending(&task.task_id, callback_id, Vec::new())
        .expect("callback should become pending");
    let before_seq = service.status().last_event_seq;
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

    retry_pending_task_callbacks(service.inner.clone()).await;

    let snapshot = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain visible after callback failed append failure");
    assert_eq!(snapshot.callback_delivery, CallbackDelivery::Pending);
    assert_eq!(service.status().state, ServiceState::Failed);
    assert_eq!(provider.calls(), 0);
    let events = service.events_after(before_seq);
    assert!(
        !events
            .iter()
            .any(|event| event.event_type == "task.callback_failed"),
        "failed task.callback_failed append must not publish a fake terminal callback event: {events:?}"
    );
}

#[tokio::test]
async fn pending_task_callback_failure_becomes_prunable_after_durable_append() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-host-callback-failed-committed"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_callback_failed_committed",
            "bash",
            "{}",
        ));
    let callback_id = "task_callback_failed_committed";
    complete_task_callback_fixture(&service, &task.task_id);
    service
        .inner
        .background_tasks
        .set_callback_pending(&task.task_id, callback_id, Vec::new())
        .expect("callback should become pending");
    let before_seq = service.status().last_event_seq;

    retry_pending_task_callbacks(service.inner.clone()).await;

    assert!(service
        .events_after(before_seq)
        .iter()
        .any(|event| event.event_type == "task.callback_failed"));
    assert_eq!(provider.calls(), 0);
    assert_eq!(
        service.inner.background_tasks.prune(
            SystemTime::now() + Duration::from_secs(365 * 24 * 60 * 60)
        ),
        1
    );
    assert!(service.inner.background_tasks.get(&task.task_id).is_none());
}

#[tokio::test]
async fn callback_queued_status_failure_cancels_active_turn_and_failed_drain_is_empty() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system")
            .with_session("service-host-callback-queued-status-write-failure"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let active_cancel = CancellationToken::new();
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_active".to_owned());
        state.active_cancel = Some(active_cancel.clone());
    }
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_callback_queued_status_write_fails",
            "bash",
            "{}",
        ));
    let callback_id = "task_callback_queued_status_write_fails";
    complete_task_callback_fixture(&service, &task.task_id);
    service
        .inner
        .background_tasks
        .set_callback_pending(
            &task.task_id,
            callback_id,
            vec![ContentPart::text("<task_callback />")],
        )
        .expect("callback should become pending");
    service.inject_timeline_write_failure_after_events(4, TimelineWriteFailure::Flush);

    retry_pending_task_callbacks(service.inner.clone()).await;
    tokio::task::yield_now().await;

    let snapshot = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain visible after callback queued status failure");
    assert_eq!(snapshot.callback_delivery, CallbackDelivery::Enqueued);
    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(active_cancel.is_cancelled());
    assert_eq!(provider.calls(), 0);

    let batch = service.begin_drain(CancellationToken::new()).await;
    assert_eq!(batch.id, "batch_failed");
    assert!(
        batch.messages.is_empty(),
        "failed service must not drain queued callback inputs"
    );
}
