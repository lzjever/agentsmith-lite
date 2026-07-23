#[tokio::test]
async fn subagent_callbacks_use_independent_ids_even_when_event_seq_based_id_would_conflict() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-callback-ids"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let snapshot = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let running = manager
            .spawn("Reviewer", "review callback ids")
            .expect("spawn subagent");
        manager
            .complete(&running.id, "callback body")
            .expect("complete subagent")
    };
    let cursor_event = service
        .inner
        .append_event_for_turn(None, "test.cursor", json!({}));
    let legacy_event_seq_id = format!(
        "subagent_callback_{}_{}_{}",
        snapshot.id,
        "completed",
        service.inner.last_event_seq().saturating_add(1)
    );
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        insert_message_index_entry(
            &mut state.message_index,
            legacy_event_seq_id.clone(),
            vec![ContentPart::text("pre-existing different content")],
            timeline_cursor_for_event(service.inner.as_ref(), &cursor_event),
        );
    }
    let before_seq = service.inner.last_event_seq();

    enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;
    enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.callback_count, 2);
    assert_eq!(snapshot.pending_callback_count, 2);
    assert_eq!(snapshot.failed_callback_count, 0);
    assert_eq!(snapshot.callbacks.len(), 2);
    assert_ne!(
        snapshot.callbacks[0].callback_id,
        snapshot.callbacks[1].callback_id
    );
    assert!(!snapshot
        .callbacks
        .iter()
        .any(|callback| callback.callback_id == legacy_event_seq_id));
    assert!(!service
        .events_after(before_seq)
        .iter()
        .any(|event| event.data["reason"] == json!("message_conflict")));
}

#[tokio::test]
async fn subagent_callback_ids_do_not_collide_with_old_unretained_session_ids_after_restart() {
    let home = service_test_home("subagent-callback-restart-id-collision");
    let legacy_callback_id = "subagent_callback_sa_000001_completed_1".to_owned();
    let legacy_content = vec![ContentPart::text("historic callback body")];
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    session
        .recorder()
        .record_accepted_input_sync(&AcceptedInputEntry {
            message_id: legacy_callback_id.clone(),
            content: legacy_content.clone(),
            cursor_seq: 1,
            source: InputSource::SubagentCallback,
            metadata: Some(QueuedInputMetadata::SubagentCallback {
                subagent_id: "sa_000001".to_owned(),
                kind: "completed".to_owned(),
                task_id: None,
                ask_id: None,
                tell_id: None,
                task_message: None,
                label: Some("worker".to_owned()),
                summary: Some("historic work".to_owned()),
            }),
            urgency: InputUrgency::Normal,
        })
        .expect("legacy callback accepted input should persist");
    session
        .recorder()
        .record_user_batch_with_ids_sync(
            &[Message::user(legacy_content)],
            std::slice::from_ref(&legacy_callback_id),
        )
        .expect("legacy callback should be committed");

    for index in 0..(DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW + 4) {
        let message_id = format!("historic_msg_{index}");
        let content = vec![ContentPart::text(format!("historic message {index}"))];
        session
            .recorder()
            .record_accepted_input_sync(&AcceptedInputEntry {
                message_id: message_id.clone(),
                content: content.clone(),
                cursor_seq: index as u64 + 2,
                source: InputSource::User,
                metadata: None,
                urgency: InputUrgency::Normal,
            })
            .expect("historic accepted input should persist");
        session
            .recorder()
            .record_user_batch_with_ids_sync(
                &[Message::user(content)],
                std::slice::from_ref(&message_id),
            )
            .expect("historic message should be committed");
    }
    session
        .recorder()
        .record_compaction_sync(&[ContentPart::text("summary")], &[])
        .expect("session should compact");
    drop(session);

    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should reopen before new callback");
    assert!(
        reopened
            .known_user_messages()
            .iter()
            .all(|message| message.id != legacy_callback_id),
        "legacy callback id must be outside the retained message index"
    );

    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        reopened.replay(),
        Some(reopened.recorder()),
        reopened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_restart_callback".to_owned());
        state.active_cancel = Some(CancellationToken::new());
    }
    let snapshot = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let running = manager
            .spawn("Reviewer", "review callback ids")
            .expect("spawn subagent");
        manager
            .complete(&running.id, "callback body")
            .expect("complete subagent")
    };

    enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

    let entries = fs::read_to_string(home.join("sessions/service-test.jsonl"))
        .expect("session should read")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("session line should parse"))
        .collect::<Vec<_>>();
    let subagent_callback_ids = entries
        .iter()
        .filter(|entry| entry["type"] == "accepted_input" && entry["source"] == "subagent_callback")
        .filter_map(|entry| entry["message_id"].as_str())
        .collect::<Vec<_>>();
    let new_callback_id = subagent_callback_ids
        .last()
        .expect("new callback accepted input should be recorded");
    assert_ne!(*new_callback_id, legacy_callback_id);
    assert!(new_callback_id.starts_with("subagent_callback_"));

    open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should reopen after new callback without id collision");
}

#[tokio::test]
async fn subagent_callback_early_returns_record_outcome_after_state_lock_is_released() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-empty-callback"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let snapshot = open_test_subagent(&service, "Empty");
    let checks = install_callback_outcome_state_unlocked_assertion(&service);
    let callback_id = "subagent_callback_empty".to_owned();

    let (_, status, _, _) = enqueue_subagent_callback_input(
        &service.inner,
        SubagentCallbackFacts::default(),
        &snapshot.id,
        callback_id.clone(),
        "completed",
        Vec::new(),
    )
    .await
    .expect("empty callback should still record outcome");

    assert_eq!(status, "failed");
    assert_eq!(checks.load(Ordering::SeqCst), 1);
    assert_recorded_callback(
        &service,
        &snapshot.id,
        &callback_id,
        SubagentCallbackStatus::Failed,
    );

    let service = Service::with_limits(
        AgentConfig::new("system").with_session("service-queue-full-callback"),
        Arc::new(PanicProvider),
        Vec::new(),
        ServiceLimits::new(1),
    )
    .expect("service construction should succeed");
    let snapshot = open_test_subagent(&service, "QueueFull");
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_queue_full".to_owned());
        state.active_cancel = Some(CancellationToken::new());
        state.input_queue.enqueue(QueuedMessage {
            id: "queued_user".to_owned(),
            content: vec![ContentPart::text("queued")],
            source: InputSource::User,
            urgency: InputUrgency::Normal,
            metadata: None,
            cursor_seq: service.inner.last_event_seq(),
            delivery: None,
        });
    }
    let checks = install_callback_outcome_state_unlocked_assertion(&service);
    let callback_id = "subagent_callback_queue_full".to_owned();

    let (_, status, _, _) = enqueue_subagent_callback_input(
        &service.inner,
        SubagentCallbackFacts::default(),
        &snapshot.id,
        callback_id.clone(),
        "completed",
        vec![ContentPart::text("callback body")],
    )
    .await
    .expect("queue-full callback should still record outcome");

    assert_eq!(status, "queue_full");
    assert_eq!(checks.load(Ordering::SeqCst), 1);
    assert_recorded_callback(
        &service,
        &snapshot.id,
        &callback_id,
        SubagentCallbackStatus::Failed,
    );

    let service = Service::new(
        AgentConfig::new("system").with_session("service-shutdown-callback"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let snapshot = open_test_subagent(&service, "Shutdown");
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::ShuttingDown;
    }
    let checks = install_callback_outcome_state_unlocked_assertion(&service);
    let callback_id = "subagent_callback_shutdown".to_owned();

    let (_, status, _, _) = enqueue_subagent_callback_input(
        &service.inner,
        SubagentCallbackFacts::default(),
        &snapshot.id,
        callback_id.clone(),
        "completed",
        vec![ContentPart::text("callback body")],
    )
    .await
    .expect("shutdown callback should still record outcome");

    assert_eq!(status, "failed");
    assert_eq!(checks.load(Ordering::SeqCst), 1);
    assert_recorded_callback(
        &service,
        &snapshot.id,
        &callback_id,
        SubagentCallbackStatus::Failed,
    );

    let service = Service::new(
        AgentConfig::new("system").with_session("service-duplicate-callback"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let snapshot = open_test_subagent(&service, "Duplicate");
    let callback_id = "subagent_callback_duplicate".to_owned();
    let content = vec![ContentPart::text("duplicate body")];
    let cursor_event = service
        .inner
        .append_event_for_turn(None, "test.cursor", json!({}));
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        insert_message_index_entry(
            &mut state.message_index,
            callback_id.clone(),
            content.clone(),
            timeline_cursor_for_event(service.inner.as_ref(), &cursor_event),
        );
    }
    let checks = install_callback_outcome_state_unlocked_assertion(&service);

    let (_, status, _, _) = enqueue_subagent_callback_input(
        &service.inner,
        SubagentCallbackFacts::default(),
        &snapshot.id,
        callback_id.clone(),
        "completed",
        content,
    )
    .await
    .expect("duplicate callback should still record outcome");

    assert_eq!(status, "queued");
    assert_eq!(checks.load(Ordering::SeqCst), 1);
    assert_recorded_callback(
        &service,
        &snapshot.id,
        &callback_id,
        SubagentCallbackStatus::Pending,
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn blocked_preflight_callback_append_does_not_hold_task_admission_during_shutdown() {
    let service = Service::with_limits(
        AgentConfig::new("system").with_session("service-callback-append-shutdown"),
        Arc::new(PanicProvider),
        Vec::new(),
        ServiceLimits::new(1),
    )
    .expect("service construction should succeed");
    let subagent = open_test_subagent(&service, "BlockedCallbackAppend");
    let active_cancel = CancellationToken::new();
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_callback_append_shutdown".to_owned());
        state.active_cancel = Some(active_cancel.clone());
        state.input_queue.enqueue(QueuedMessage {
            id: "queued_user".to_owned(),
            content: vec![ContentPart::text("queued")],
            source: InputSource::User,
            urgency: InputUrgency::Normal,
            metadata: None,
            cursor_seq: service.inner.last_event_seq(),
            delivery: None,
        });
    }
    let task = service.inner.background_tasks.start_task(
        NewBackgroundTask::new("call_callback_append", "bash", "{}")
            .with_owner(TaskOwner::subagent(subagent.id.clone())),
    );
    let (entered_tx, entered_rx) = oneshot::channel();
    let entered_tx = Mutex::new(Some(entered_tx));
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let release_rx = Mutex::new(Some(release_rx));
    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::CallbackRecordBeforeAppend,
        Arc::new(move || {
            entered_tx
                .lock()
                .expect("callback pre-append hook entry mutex poisoned")
                .take()
                .expect("callback pre-append hook should run once")
                .send(())
                .expect("callback pre-append hook should report entry");
            release_rx
                .lock()
                .expect("callback pre-append hook release mutex poisoned")
                .take()
                .expect("callback pre-append hook should run once")
                .recv()
                .expect("callback pre-append hook should be released");
        }),
    );

    let callback_id = "subagent_callback_blocked_append".to_owned();
    let callback_inner = service.inner.clone();
    let callback_subagent_id = subagent.id.clone();
    let callback_task_id = task.task_id.clone();
    let callback_message_id = callback_id.clone();
    let callback = tokio::spawn(async move {
        enqueue_subagent_callback_input(
            &callback_inner,
            SubagentCallbackFacts {
                task_id: Some(&callback_task_id),
                semantic_id: Some("tell_blocked_append"),
                task_message: Some("blocked append"),
            },
            &callback_subagent_id,
            callback_message_id,
            "task_tell",
            vec![ContentPart::text("callback body")],
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .expect("callback should reach the pre-append hook before the deadman timeout")
        .expect("callback pre-append hook should report entry");

    let shutdown_service = service.clone();
    let shutdown = tokio::spawn(async move { shutdown_service.shutdown().await });
    let shutdown_progress = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let task_is_cancelling = service
                .inner
                .background_tasks
                .get(&task.task_id)
                .is_some_and(|snapshot| snapshot.state == TaskState::Cancelling);
            if active_cancel.is_cancelled()
                && service.status().state == ServiceState::ShuttingDown
                && task_is_cancelling
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;

    release_tx
        .send(())
        .expect("callback pre-append hook should accept release");
    shutdown_progress
        .expect("shutdown cancellation and admission termination must not wait for timeline I/O");
    let callback = callback
        .await
        .expect("callback enqueue task should not panic")
        .expect("queue-full callback should record its outcome");
    service.inner.background_tasks.finish_task(
        &task.task_id,
        TaskState::Cancelled,
        "test task stopped during shutdown",
    );
    shutdown.await.expect("shutdown task should not panic");

    assert_eq!(callback.1, "queue_full");
    let callback_events = service
        .events_after(0)
        .into_iter()
        .filter(|event| {
            event.event_type == "subagent.callback"
                && event.data["callback_id"] == json!(callback_id)
        })
        .collect::<Vec<_>>();
    assert_eq!(
        callback_events.len(),
        1,
        "blocked callback event must be published exactly once"
    );
}

#[test]
fn repeated_subagent_cancel_appends_cancelled_event_once() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-cancel-idempotent"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Reviewer", "review cancellation")
        .expect("open subagent")
        .id;
    let before_cancel_seq = service.inner.last_event_seq();

    let first = service.inner.cancel_subagent_tool_result(
        ToolCall::new(
            "cancel_1",
            "subagent_cancel",
            json!({"subagent_id": subagent_id}),
        ),
        &subagent_id,
    );
    assert!(!first.is_error, "{first:?}");

    let second = service.inner.cancel_subagent_tool_result(
        ToolCall::new(
            "cancel_2",
            "subagent_cancel",
            json!({"subagent_id": subagent_id}),
        ),
        &subagent_id,
    );
    assert!(!second.is_error, "{second:?}");

    let cancel_events = service
        .events_after(before_cancel_seq)
        .into_iter()
        .filter(|event| event.event_type == "subagent.cancelled")
        .collect::<Vec<_>>();
    assert_eq!(
        cancel_events.len(),
        1,
        "repeated cancel should not append duplicate lifecycle terminal events: {cancel_events:?}"
    );
}

#[test]
fn subagent_cancel_releases_context_provider_cancel_token_and_all_owned_tasks_idempotently() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-cancel-cleanup"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Reviewer", "review cleanup")
        .expect("open subagent")
        .id;
    let subagent_cancel = Arc::new(CancellationToken::new());
    service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .insert(subagent_id.clone(), subagent_cancel.clone());
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(
            subagent_id.clone(),
            vec![Message::user(vec![ContentPart::text("ctx")])],
        );
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), Arc::new(PanicProvider));

    let owner = TaskOwner::subagent(subagent_id.clone());
    let owned_tokens = (0..200)
        .map(|index| {
            let token = CancellationToken::new();
            let task_id = format!("owned_task_{index:03}");
            service.inner.background_tasks.start_task_with_id(
                task_id.clone(),
                NewBackgroundTask::new(format!("call_{index:03}"), "bash", "{}")
                    .with_owner(owner.clone())
                    .with_cancel_token(token.clone()),
            );
            service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned")
                .add_owned_task_id(&subagent_id, task_id)
                .expect("owned task id should attach");
            token
        })
        .collect::<Vec<_>>();

    let first = service.inner.cancel_subagent_tool_result(
        ToolCall::new(
            "cancel_cleanup_1",
            "subagent_cancel",
            json!({"subagent_id": subagent_id}),
        ),
        &subagent_id,
    );
    assert!(!first.is_error, "{first:?}");
    assert!(subagent_cancel.is_cancelled());
    assert!(!service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .contains_key(&subagent_id));
    assert!(!service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .contains_key(&subagent_id));
    assert!(!service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .contains_key(&subagent_id));
    assert!(
        owned_tokens.iter().all(CancellationToken::is_cancelled),
        "subagent_cancel must cancel every non-terminal task owned by the branch"
    );

    let second = service.inner.cancel_subagent_tool_result(
        ToolCall::new(
            "cancel_cleanup_2",
            "subagent_cancel",
            json!({"subagent_id": subagent_id}),
        ),
        &subagent_id,
    );
    assert!(!second.is_error, "{second:?}");
    assert!(!service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .contains_key(&subagent_id));
    assert!(!service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .contains_key(&subagent_id));
}

#[test]
fn subagent_cancel_event_failure_keeps_cleanup_committed() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-cancel-event-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .spawn("Reviewer", "review cancellation failure")
        .expect("spawn subagent")
        .id;
    let subagent_cancel = Arc::new(CancellationToken::new());
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(
            subagent_id.clone(),
            vec![Message::user(vec![ContentPart::text("context")])],
        );
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), Arc::new(PanicProvider));
    service
        .inner
        .subagent_runtime_selections
        .lock()
        .expect("subagent runtime selections mutex poisoned")
        .insert(
            subagent_id.clone(),
            RuntimeSelectionHandle::new_mutable(Vec::new())
                .expect("empty runtime selection catalog should construct"),
        );
    service
        .inner
        .subagent_tool_snapshots
        .lock()
        .expect("subagent tool snapshots mutex poisoned")
        .insert(
            subagent_id.clone(),
            Arc::new(
                FinalToolSnapshot::build(Vec::new(), &service.inner.config.tool_execution)
                    .expect("empty tool snapshot should validate"),
            ),
        );
    service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .insert(subagent_id.clone(), subagent_cancel.clone());

    let task_id = "cancel_event_failure_task".to_owned();
    let task_cancel = CancellationToken::new();
    service.inner.background_tasks.start_task_with_id(
        task_id.clone(),
        NewBackgroundTask::new("cancel_event_failure_call", "bash", "{}")
            .with_owner(TaskOwner::subagent(subagent_id.clone()))
            .with_cancel_token(task_cancel.clone()),
    );
    service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .add_owned_task_id(&subagent_id, task_id.clone())
        .expect("owned task id should attach");

    let before_seq = service.inner.last_event_seq();
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

    let result = service.inner.cancel_subagent_tool_result(
        ToolCall::new(
            "cancel_event_failure",
            "subagent_cancel",
            json!({"subagent_id": subagent_id}),
        ),
        &subagent_id,
    );

    assert!(!result.is_error, "{result:?}");
    assert_eq!(
        tool_text_json(&result),
        json!({
            "subagent_id": subagent_id,
            "name": "Reviewer",
            "status": "cancelled",
            "cancelled_task_ids": [task_id],
            "error": Value::Null
        })
    );
    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(subagent_cancel.is_cancelled());
    assert!(task_cancel.is_cancelled());
    assert_subagent_runtime_resources_absent(&service, &subagent_id);

    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("cancelled subagent should remain inspectable");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert_eq!(snapshot.run_state, SubagentRunState::Idle);

    let task = service
        .inner
        .background_tasks
        .get(&task_id)
        .expect("owned task should remain inspectable");
    assert_eq!(task.owner, TaskOwner::subagent(subagent_id.clone()));
    assert_eq!(task.state, TaskState::Cancelling);
    assert!(!service.events_after(before_seq).iter().any(|event| {
        event.event_type == "subagent.cancelled"
            && event.data["subagent_id"] == json!(subagent_id)
    }));
}

#[tokio::test]
async fn subagent_owned_task_cancel_appends_callback_after_releasing_subagent_manager_lock() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-task-cancel-lock-order"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("TaskCancel", "task cancel lock order")
        .expect("open subagent")
        .id;
    let owner = TaskOwner::subagent(subagent_id.clone());
    let cancel = CancellationToken::new();
    service.inner.background_tasks.start_task_with_id(
        "task_lock_order".to_owned(),
        NewBackgroundTask::new("call_lock_order", "bash", "{}")
            .with_owner(owner.clone())
            .with_cancel_token(cancel.clone()),
    );
    service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .add_owned_task_id(&subagent_id, "task_lock_order")
        .expect("owned task should attach");
    let tool = ServiceTaskCancelTool::new(Arc::downgrade(&service.inner), owner);
    let before_seq = service.inner.last_event_seq();

    let result = tool
        .execute(
            ToolCall::new(
                "cancel_task_lock_order",
                "task_cancel",
                json!({"task_id": "task_lock_order"}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("task cancel tool should return");

    assert!(!result.is_error, "{result:?}");
    assert!(cancel.is_cancelled());
    assert!(
        service
            .events_after(before_seq)
            .iter()
            .any(|event| event.event_type == "subagent.callback"
                && event.data["subagent_id"] == json!(subagent_id)),
        "subagent-owned task cancel should append a callback summary event"
    );
}

#[tokio::test]
async fn cancelled_subagent_late_success_does_not_restore_context_or_enqueue_callback() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-late-success"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let snapshot = manager
            .spawn("Late", "late success")
            .expect("spawn subagent");
        manager.cancel(&snapshot.id).expect("cancel subagent");
        snapshot.id
    };
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .remove(&subagent_id);
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .remove(&subagent_id);
    let before_seq = service.inner.last_event_seq();

    run_subagent_loop(
        service.inner.clone(),
        subagent_id.clone(),
        service.inner.subagent_config(),
        vec![Message::user(vec![ContentPart::text("late success")])],
        Arc::new(TextProvider("late result")),
        Vec::new(),
        CancellationToken::new(),
    )
    .await;

    assert!(!service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .contains_key(&subagent_id));
    assert!(!service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .contains_key(&subagent_id));
    let events = service.events_after(before_seq);
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.completed"));
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.callback"));
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.callback_count, 0);
}

#[tokio::test]
async fn subagent_cancel_between_success_and_context_store_does_not_restore_context() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-success-store-race"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        manager
            .spawn("Race", "success context race")
            .expect("spawn subagent")
            .id
    };
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(
            subagent_id.clone(),
            vec![Message::user(vec![ContentPart::text("initial")])],
        );
    install_subagent_cancel_hook(
        &service,
        SubagentTestHookKind::TerminalBeforeContextStore,
        subagent_id.clone(),
    );
    let before_seq = service.inner.last_event_seq();

    run_subagent_loop(
        service.inner.clone(),
        subagent_id.clone(),
        service.inner.subagent_config(),
        vec![Message::user(vec![ContentPart::text("late success")])],
        Arc::new(TextProvider("late result")),
        Vec::new(),
        CancellationToken::new(),
    )
    .await;

    assert_subagent_runtime_resources_absent(&service, &subagent_id);
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert!(!service
        .events_after(before_seq)
        .iter()
        .any(|event| event.event_type == "subagent.completed"));
}

#[tokio::test]
async fn subagent_cancel_between_failure_and_context_store_does_not_restore_context() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-failure-store-race"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        manager
            .spawn("Race", "failure context race")
            .expect("spawn subagent")
            .id
    };
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(
            subagent_id.clone(),
            vec![Message::user(vec![ContentPart::text("initial")])],
        );
    install_subagent_cancel_hook(
        &service,
        SubagentTestHookKind::TerminalBeforeContextStore,
        subagent_id.clone(),
    );
    let before_seq = service.inner.last_event_seq();

    run_subagent_loop(
        service.inner.clone(),
        subagent_id.clone(),
        service.inner.subagent_config(),
        vec![Message::user(vec![ContentPart::text("late failure")])],
        Arc::new(FailingProvider),
        Vec::new(),
        CancellationToken::new(),
    )
    .await;

    assert_subagent_runtime_resources_absent(&service, &subagent_id);
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert!(!service
        .events_after(before_seq)
        .iter()
        .any(|event| event.event_type == "subagent.failed"));
}

#[tokio::test]
async fn subagent_cancel_after_success_state_before_event_does_not_append_stale_completed() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-success-event-race"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        manager
            .spawn("Race", "success event race")
            .expect("spawn subagent")
            .id
    };
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(
            subagent_id.clone(),
            vec![Message::user(vec![ContentPart::text("initial")])],
        );
    install_subagent_cancel_hook(
        &service,
        SubagentTestHookKind::TerminalStateBeforeAppend,
        subagent_id.clone(),
    );
    let before_seq = service.inner.last_event_seq();

    run_subagent_loop(
        service.inner.clone(),
        subagent_id.clone(),
        service.inner.subagent_config(),
        vec![Message::user(vec![ContentPart::text("late success")])],
        Arc::new(TextProvider("late result")),
        Vec::new(),
        CancellationToken::new(),
    )
    .await;

    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert_subagent_not_reactivated_after_cancel(
        &service,
        before_seq,
        &subagent_id,
        "subagent.completed",
    );
}

#[tokio::test]
async fn subagent_cancel_after_failure_state_before_event_does_not_append_stale_failed() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-failure-event-race"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        manager
            .spawn("Race", "failure event race")
            .expect("spawn subagent")
            .id
    };
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(
            subagent_id.clone(),
            vec![Message::user(vec![ContentPart::text("initial")])],
        );
    install_subagent_cancel_hook(
        &service,
        SubagentTestHookKind::TerminalStateBeforeAppend,
        subagent_id.clone(),
    );
    let before_seq = service.inner.last_event_seq();

    run_subagent_loop(
        service.inner.clone(),
        subagent_id.clone(),
        service.inner.subagent_config(),
        vec![Message::user(vec![ContentPart::text("late failure")])],
        Arc::new(FailingProvider),
        Vec::new(),
        CancellationToken::new(),
    )
    .await;

    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert_subagent_not_reactivated_after_cancel(
        &service,
        before_seq,
        &subagent_id,
        "subagent.failed",
    );
}

#[tokio::test]
async fn subagent_token_cancel_marks_branch_cancelled_and_removes_runtime_resources() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-token-cancel"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_subagent_token_cancel".to_owned());
        state.active_cancel = Some(CancellationToken::new());
    }
    let subagent_id = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        manager
            .spawn("TokenCancel", "cancel token race")
            .expect("spawn subagent")
            .id
    };
    let cancel = Arc::new(CancellationToken::new());
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(
            subagent_id.clone(),
            vec![Message::user(vec![ContentPart::text("initial")])],
        );
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), Arc::new(PanicProvider));
    service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .insert(subagent_id.clone(), cancel.clone());
    cancel.cancel();
    let before_seq = service.inner.last_event_seq();

    run_subagent_loop(
        service.inner.clone(),
        subagent_id.clone(),
        service.inner.subagent_config(),
        vec![Message::user(vec![ContentPart::text("will cancel")])],
        Arc::new(PanicProvider),
        Vec::new(),
        cancel.as_ref().clone(),
    )
    .await;

    assert_subagent_runtime_resources_absent(&service, &subagent_id);
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert_eq!(snapshot.run_state, SubagentRunState::Idle);
    assert_eq!(snapshot.callback_count, 0);
    let events = service.events_after(before_seq);
    assert!(events
        .iter()
        .any(|event| event.event_type == "subagent.cancelled"));
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.failed"));
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.callback"));
}

#[test]
fn repeated_subagent_open_and_cancel_does_not_retain_tool_snapshots() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-snapshot-retention"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let tool_snapshot = Arc::new(
        FinalToolSnapshot::build(Vec::new(), &service.inner.config.tool_execution)
            .expect("empty tool snapshot should validate"),
    );

    for index in 0..32 {
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open(format!("Worker {index}"), "snapshot lifecycle")
            .expect("open subagent")
            .id;
        service
            .inner
            .subagent_tool_snapshots
            .lock()
            .expect("subagent tool snapshots mutex poisoned")
            .insert(subagent_id.clone(), tool_snapshot.clone());

        service
            .inner
            .cancel_subagent_lifecycle(&subagent_id)
            .expect("cancel subagent");

        assert_subagent_runtime_resources_absent(&service, &subagent_id);
        assert_eq!(
            service
                .inner
                .subagent_tool_snapshots
                .lock()
                .expect("subagent tool snapshots mutex poisoned")
                .len(),
            0
        );
    }
}

#[test]
fn subagent_cancel_during_owned_task_publish_does_not_leave_orphan_running_task() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-task-publish-race"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "publish task race")
        .expect("open subagent")
        .id;
    {
        let inner = service.inner.clone();
        let subagent_id = subagent_id.clone();
        service.inner.set_subagent_test_hook(
            SubagentTestHookKind::SubagentPublishOpenCheck,
            Arc::new(move || {
                inner
                    .subagents
                    .lock()
                    .expect("subagent manager mutex poisoned")
                    .cancel(&subagent_id)
                    .expect("cancel subagent");
                inner
                    .subagent_contexts
                    .lock()
                    .expect("subagent contexts mutex poisoned")
                    .remove(&subagent_id);
                inner
                    .subagent_providers
                    .lock()
                    .expect("subagent providers mutex poisoned")
                    .remove(&subagent_id);
                inner
                    .subagent_cancels
                    .lock()
                    .expect("subagent cancels mutex poisoned")
                    .remove(&subagent_id);
                inner
                    .background_tasks
                    .cancel_all_by_owner(&TaskOwner::subagent(subagent_id.clone()));
            }),
        );
    }
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::subagent(subagent_id.clone()),
    };
    let cancel = CancellationToken::new();

    let published = host.publish_task(
        "orphan_task".to_owned(),
        NewBackgroundTask::new("orphan_call", "bash", "{}").with_cancel_token(cancel.clone()),
    );

    assert!(!published);
    assert!(cancel.is_cancelled());
    assert!(service.inner.background_tasks.get("orphan_task").is_none());
    assert_subagent_runtime_resources_absent(&service, &subagent_id);
}

#[test]
fn subagent_owned_task_publish_event_failure_fails_task_without_running() {
    let service = Service::new(
        AgentConfig::new("system")
            .with_session("service-subagent-task-publish-persistence-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "publish task persistence failure")
        .expect("open subagent")
        .id;
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::subagent(subagent_id.clone()),
    };
    let cancel = CancellationToken::new();
    let before_seq = service.inner.last_event_seq();
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

    let published = host.publish_task(
        "failed_publish_task".to_owned(),
        NewBackgroundTask::new("failed_publish_call", "bash", "{}")
            .with_cancel_token(cancel.clone()),
    );

    assert!(!published);
    assert!(cancel.is_cancelled());
    let task = service
        .inner
        .background_tasks
        .get("failed_publish_task")
        .expect("failed task retained for inspection");
    assert_eq!(task.owner, TaskOwner::subagent(subagent_id.clone()));
    assert_eq!(task.state, TaskState::Failed);
    assert_eq!(service.status().state, ServiceState::Failed);
    let events = service.events_after(before_seq);
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.callback"));
    assert_subagent_runtime_resources_absent(&service, &subagent_id);
}

#[test]
fn subagent_owned_task_publish_status_failure_records_terminal_compensation() {
    let service = Service::new(
        AgentConfig::new("system")
            .with_session("service-subagent-task-publish-status-persistence-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "publish task status persistence failure")
        .expect("open subagent")
        .id;
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::subagent(subagent_id.clone()),
    };
    let cancel = CancellationToken::new();
    let before_seq = service.inner.last_event_seq();
    service.inject_timeline_write_failure_after_events(1, TimelineWriteFailure::Flush);

    let published = host.publish_task(
        "failed_status_task".to_owned(),
        NewBackgroundTask::new("failed_status_call", "bash", "{}")
            .with_cancel_token(cancel.clone()),
    );

    assert!(!published);
    assert!(cancel.is_cancelled());
    let task = service
        .inner
        .background_tasks
        .get("failed_status_task")
        .expect("failed task retained for inspection");
    assert_eq!(task.owner, TaskOwner::subagent(subagent_id.clone()));
    assert_eq!(task.state, TaskState::Failed);
    assert_eq!(service.status().state, ServiceState::Failed);
    let events = service.events_after(before_seq);
    assert!(events
        .iter()
        .any(|event| event.event_type == "subagent.callback"));
    let task_failed = events
        .iter()
        .find(|event| event.event_type == "subagent.task_failed")
        .expect("status failure after subagent task publication needs terminal compensation");
    assert_eq!(task_failed.data["task_id"], json!("failed_status_task"));
    assert_eq!(task_failed.data["task_status"], json!("failed"));
    assert_subagent_runtime_resources_absent(&service, &subagent_id);
}

#[test]
fn subagent_owned_task_publish_rejects_failed_service_without_starting_task() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-task-publish-failed-service"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "failed service publish")
        .expect("open subagent")
        .id;
    service.inner.mark_failed("timeline persistence failed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::subagent(subagent_id),
    };
    let cancel = CancellationToken::new();

    let published = host.publish_task(
        "failed_service_task".to_owned(),
        NewBackgroundTask::new("failed_service_call", "bash", "{}")
            .with_cancel_token(cancel.clone()),
    );

    assert!(!published);
    assert!(cancel.is_cancelled());
    assert!(service
        .inner
        .background_tasks
        .get("failed_service_task")
        .is_none());
}

#[tokio::test]
async fn completed_subagent_owned_tasks_are_bounded_without_losing_owner_callbacks() {
    let service = Service::new(
        AgentConfig::new("system")
            .with_session("service-subagent-owned-task-retention")
            .with_tool_execution_policy(
                crate::agent_loop::ToolExecutionPolicy::default().with_max_retained_tasks(2),
            ),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_subagent_owned_retention".to_owned());
        state.active_cancel = Some(CancellationToken::new());
    }
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "bounded owned tasks")
        .expect("open subagent")
        .id;
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::subagent(subagent_id.clone()),
    };

    for index in 0..32 {
        let task_id = format!("subagent_owned_retained_{index}");
        let call_id = format!("call_subagent_owned_retained_{index}");
        assert!(host.publish_task(
            task_id.clone(),
            NewBackgroundTask::new(call_id.clone(), "bash", "{}"),
        ));
        host.finish_task(
            task_id,
            ToolCall::new(call_id.clone(), "bash", json!({})),
            DetachedToolResult {
                tool_result: ToolResult::success(call_id, "bash", "done"),
                state: TaskState::Completed,
            },
        )
        .await;
        assert!(service.inner.background_tasks.list().len() <= 2);
    }

    let subagent = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent snapshot");
    assert_eq!(subagent.pending_callback_count, 32);
}

#[tokio::test]
async fn background_completion_after_failed_service_does_not_enqueue_callback_or_events() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-background-completion-after-failed"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    let published = host.publish_task(
        "task_after_failed".to_owned(),
        NewBackgroundTask::new("call_after_failed", "bash", "{}"),
    );
    assert!(published);
    service.inner.mark_failed("timeline persistence failed");
    let before_seq = service.inner.last_event_seq();

    host.finish_task(
        "task_after_failed".to_owned(),
        ToolCall::new("call_after_failed", "bash", json!({})),
        DetachedToolResult {
            tool_result: ToolResult::success("call_after_failed", "bash", "done"),
            state: TaskState::Completed,
        },
    )
    .await;

    let task = service
        .inner
        .background_tasks
        .get("task_after_failed")
        .expect("task should remain inspectable");
    assert_eq!(task.state, TaskState::Completed);
    assert_eq!(task.callback_delivery, CallbackDelivery::NotReady);
    let events = service.events_after(before_seq);
    assert!(
        events.is_empty(),
        "failed service must not append task terminal or callback events after background completion: {events:?}"
    );
}

#[tokio::test]
async fn background_completion_after_shutdown_does_not_enqueue_callback_or_events() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-background-completion-after-shutdown"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    assert!(host.publish_task(
        "task_after_shutdown".to_owned(),
        NewBackgroundTask::new("call_after_shutdown", "bash", "{}"),
    ));
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::ShuttingDown;
    }
    let before_seq = service.inner.last_event_seq();

    host.finish_task(
        "task_after_shutdown".to_owned(),
        ToolCall::new("call_after_shutdown", "bash", json!({})),
        DetachedToolResult {
            tool_result: ToolResult::success("call_after_shutdown", "bash", "done"),
            state: TaskState::Completed,
        },
    )
    .await;

    let task = service
        .inner
        .background_tasks
        .get("task_after_shutdown")
        .expect("task should remain inspectable");
    assert_eq!(task.state, TaskState::Completed);
    assert_eq!(task.callback_delivery, CallbackDelivery::NotReady);
    let events = service.events_after(before_seq);
    assert!(
        events.is_empty(),
        "shutting down service must not append task terminal or callback events: {events:?}"
    );
}

#[tokio::test]
async fn subagent_terminal_after_failed_service_does_not_enqueue_callback_or_events() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-terminal-after-failed"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .spawn("Worker", "finish after service failed")
        .expect("spawn subagent")
        .id;
    service.inner.mark_failed("timeline persistence failed");
    let before_seq = service.inner.last_event_seq();
    let cancel = Arc::new(CancellationToken::new());
    let observed_cancel = cancel.clone();
    service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .insert(subagent_id.clone(), cancel.clone());

    let subagent_config = AgentConfig::new("system");
    let subagent_tools = Arc::new(
        FinalToolSnapshot::build(Vec::new(), &subagent_config.tool_execution)
            .expect("empty subagent tools should validate"),
    );
    spawn_subagent_loop(
        service.inner.clone(),
        subagent_id.clone(),
        subagent_config,
        vec![Message::user(vec![ContentPart::text("finish")])],
        provider.clone(),
        subagent_tools,
        cancel,
    );
    assert!(observed_cancel.is_cancelled());
    assert_eq!(service.inner.active_service_worker_count(), 0);
    assert_subagent_runtime_resources_absent(&service, &subagent_id);
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let snapshot = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned")
                .snapshot(&subagent_id)
                .expect("subagent snapshot");
            if snapshot.lifecycle == SubagentLifecycle::Cancelled {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("subagent should be cancelled locally");

    assert_eq!(provider.calls(), 0);
    let events = service.events_after(before_seq);
    assert!(
        !events.iter().any(|event| matches!(
            event.event_type.as_str(),
            "subagent.completed" | "subagent.callback"
        )),
        "failed service must not append subagent terminal or callback events: {events:?}"
    );
}

#[tokio::test]
async fn subagent_owned_task_request_callback_queue_full_writes_exception_to_child() {
    let service = Service::with_limits(
        AgentConfig::new("system").with_session("service-subagent-task-request-queue-full"),
        Arc::new(PanicProvider),
        Vec::new(),
        ServiceLimits::new(1),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "request queue full")
        .expect("open subagent")
        .id;
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_queue_full".to_owned());
        state.active_cancel = Some(CancellationToken::new());
        state.input_queue.enqueue(QueuedMessage {
            id: "queued_user".to_owned(),
            content: vec![ContentPart::text("queued")],
            source: InputSource::User,
            urgency: InputUrgency::Normal,
            metadata: None,
            cursor_seq: service.inner.last_event_seq(),
            delivery: None,
        });
    }
    let task = service.inner.background_tasks.start_task(
        NewBackgroundTask::new("call_subagent_request", "bash", "{}")
            .with_owner(TaskOwner::subagent(subagent_id.clone())),
    );
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("running task should accept stdin writer");

    let start = service
        .inner
        .handle_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "need_agent".to_owned(),
                request: "ask the agent".to_owned(),
                expect: Some("short answer".to_owned()),
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        )
        .await;

    assert!(start.is_none());
    let request = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain inspectable")
        .requests
        .into_iter()
        .find(|request| request.request_id == "need_agent")
        .expect("request should be retained");
    assert_eq!(request.state, TaskRequestState::Rejected);
    let stdin_text = stdin.text();
    assert!(stdin_text.contains("\"id\":\"need_agent\""));
    assert!(stdin_text.contains("\"exception\""));
    assert!(stdin_text.contains("agent_callback_unavailable"));
    assert!(service
        .events_after(0)
        .iter()
        .any(|event| event.event_type == "subagent.callback"
            && event.data["callback_status"] == "failed"));
}

#[tokio::test]
async fn subagent_owned_task_request_callback_audit_failure_rolls_back_and_writes_exception() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-task-request-audit-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "request audit failure")
        .expect("open subagent")
        .id;
    let task = service.inner.background_tasks.start_task(
        NewBackgroundTask::new("call_subagent_request_audit", "bash", "{}")
            .with_owner(TaskOwner::subagent(subagent_id.clone())),
    );
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("running task should accept stdin writer");
    let before_seq = service.inner.last_event_seq();
    service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);

    let start = service
        .inner
        .handle_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "need_agent".to_owned(),
                request: "ask the agent".to_owned(),
                expect: Some("short answer".to_owned()),
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        )
        .await;

    assert!(start.is_none());
    assert_eq!(service.status().state, ServiceState::Failed);
    assert_eq!(service.status().queue_length, 0);
    let request = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain inspectable")
        .requests
        .into_iter()
        .find(|request| request.request_id == "need_agent")
        .expect("request should be retained");
    assert_eq!(request.state, TaskRequestState::Rejected);
    let stdin_text = stdin.text();
    assert!(stdin_text.contains("\"id\":\"need_agent\""));
    assert!(stdin_text.contains("\"exception\""));
    assert!(stdin_text.contains("agent_callback_unavailable"));
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent should remain inspectable");
    assert_eq!(snapshot.callback_count, 0);
    assert_eq!(snapshot.pending_callback_count, 0);
    let events = service.events_after(before_seq);
    assert!(events
        .iter()
        .any(|event| event.event_type == "message.received"));
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.callback"));
}

#[test]
fn subagent_owned_task_reply_audit_failure_writes_exception_not_normal_response() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-task-reply-audit-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "reply audit failure")
        .expect("open subagent")
        .id;
    let owner = TaskOwner::subagent(subagent_id.clone());
    let task = service.inner.background_tasks.start_task(
        NewBackgroundTask::new("call_subagent_reply", "bash", "{}").with_owner(owner.clone()),
    );
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("running task should accept stdin writer");
    assert!(matches!(
        service.inner.background_tasks.accept_task_request(
            &task.task_id,
            TaskRequestFrame {
                id: "reply_me".to_owned(),
                request: "need response".to_owned(),
                expect: None,
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestAdmission::Accepted(_)
    ));
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

    let outcome = service.inner.reply_task_request_by_owner(
        &owner,
        &task.task_id,
        "reply_me",
        "normal response",
    );

    assert_eq!(outcome.status, TaskReplyStatus::Failed);
    assert_eq!(service.status().state, ServiceState::Failed);
    let request = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain inspectable")
        .requests
        .into_iter()
        .find(|request| request.request_id == "reply_me")
        .expect("request should be retained");
    assert_eq!(request.state, TaskRequestState::WriteFailed);
    let stdin_text = stdin.text();
    assert!(stdin_text.contains("\"id\":\"reply_me\""));
    assert!(stdin_text.contains("\"exception\""));
    assert!(stdin_text.contains("persistence_failed"));
    assert!(!stdin_text.contains("normal response"));
}

#[test]
fn subagent_owned_finished_task_reply_applies_terminal_effects_once() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-finished-reply-effects"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "expired reply")
        .expect("open subagent")
        .id;
    let owner = TaskOwner::subagent(subagent_id.clone());
    let task = service.inner.background_tasks.start_task(
        NewBackgroundTask::new("call_subagent_expired_reply", "bash", "{}")
            .with_owner(owner.clone()),
    );
    let stdin = CountingRejectingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("running task should accept stdin writer");
    assert!(matches!(
        service.inner.background_tasks.accept_task_request(
            &task.task_id,
            TaskRequestFrame {
                id: "expired_reply".to_owned(),
                request: "need response".to_owned(),
                expect: None,
                timeout: Some(Duration::from_nanos(1)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestAdmission::Accepted(_)
    ));

    let outcome = service.inner.reply_task_request_by_owner(
        &owner,
        &task.task_id,
        "expired_reply",
        "late response",
    );

    assert_eq!(outcome.status, TaskReplyStatus::Expired);
    let terminal_events = service
        .events_after(0)
        .into_iter()
        .filter(|event| {
            event.event_type == "task_ask.expired" && event.data["ask_id"] == "expired_reply"
        })
        .collect::<Vec<_>>();
    assert_eq!(terminal_events.len(), 1);
    assert_eq!(terminal_events[0].data["subagent_id"], json!(subagent_id));
    assert_eq!(terminal_events[0].data["reply_status"], "expired");
    assert_eq!(
        stdin.write_attempts(),
        1,
        "exception should be attempted once"
    );
    assert_eq!(
        service
            .events_after(0)
            .iter()
            .filter(|event| {
                event.event_type == "task.stdin_write_failed"
                    && event.data["ask_id"] == "expired_reply"
            })
            .count(),
        1,
        "stdin diagnostic should be emitted once"
    );

    let canonical_count = terminal_events.len();
    let diagnostic_count = service
        .events_after(0)
        .iter()
        .filter(|event| {
            event.event_type == "task.stdin_write_failed" && event.data["ask_id"] == "expired_reply"
        })
        .count();
    let second = service.inner.reply_task_request_by_owner(
        &owner,
        &task.task_id,
        "expired_reply",
        "later response",
    );
    assert_eq!(second.status, TaskReplyStatus::Expired);
    assert_eq!(stdin.write_attempts(), 1);
    assert_eq!(
        service
            .events_after(0)
            .iter()
            .filter(|event| {
                matches!(
                    event.event_type.as_str(),
                    "task_ask.expired"
                        | "task_ask.rejected"
                        | "task_reply.written"
                        | "task_reply.failed"
                ) && event.data["ask_id"] == "expired_reply"
            })
            .count(),
        canonical_count
    );
    assert_eq!(
        service
            .events_after(0)
            .iter()
            .filter(|event| {
                event.event_type == "task.stdin_write_failed"
                    && event.data["ask_id"] == "expired_reply"
            })
            .count(),
        diagnostic_count
    );
}

#[test]
fn subagent_owned_written_task_reply_repeated_reply_has_no_terminal_side_effects() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-written-reply-once"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "written reply")
        .expect("open subagent")
        .id;
    let owner = TaskOwner::subagent(subagent_id);
    let task = service.inner.background_tasks.start_task(
        NewBackgroundTask::new("call_subagent_written_reply", "bash", "{}")
            .with_owner(owner.clone()),
    );
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("running task should accept stdin writer");
    assert!(matches!(
        service.inner.background_tasks.accept_task_request(
            &task.task_id,
            TaskRequestFrame {
                id: "written_reply".to_owned(),
                request: "need response".to_owned(),
                expect: None,
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestAdmission::Accepted(_)
    ));

    let first = service.inner.reply_task_request_by_owner(
        &owner,
        &task.task_id,
        "written_reply",
        "first response",
    );
    assert_eq!(first.status, TaskReplyStatus::Written);
    let canonical_count = service
        .events_after(0)
        .iter()
        .filter(|event| {
            matches!(
                event.event_type.as_str(),
                "task_ask.expired"
                    | "task_ask.rejected"
                    | "task_reply.written"
                    | "task_reply.failed"
            ) && event.data["ask_id"] == "written_reply"
        })
        .count();
    let stdin_text = stdin.text();
    assert_eq!(stdin_text.matches("first response").count(), 1);

    let second = service.inner.reply_task_request_by_owner(
        &owner,
        &task.task_id,
        "written_reply",
        "second response",
    );
    assert_eq!(second.status, TaskReplyStatus::AlreadyResolved);
    assert_eq!(stdin.text(), stdin_text);
    assert_eq!(
        service
            .events_after(0)
            .iter()
            .filter(|event| {
                matches!(
                    event.event_type.as_str(),
                    "task_ask.expired"
                        | "task_ask.rejected"
                        | "task_reply.written"
                        | "task_reply.failed"
                ) && event.data["ask_id"] == "written_reply"
            })
            .count(),
        canonical_count
    );
    assert!(!stdin.text().contains("exception"));
}

#[test]
fn subagent_spawn_pre_admission_rejections_are_side_effect_free() {
    struct Case {
        name: &'static str,
        options: ServiceSubagentOptions,
        provider_name: Option<&'static str>,
        thinking_level: RuntimeThinkingLevelPatch,
        expected_text: &'static str,
        expected_kind: &'static str,
    }

    let cases = [
        Case {
            name: "disabled",
            options: ServiceSubagentOptions::disabled(),
            provider_name: None,
            thinking_level: RuntimeThinkingLevelPatch::Unchanged,
            expected_text: "subagents are disabled",
            expected_kind: "subagents_disabled",
        },
        Case {
            name: "provider_override_without_runtime_selection",
            options: ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
            provider_name: Some("alternate"),
            thinking_level: RuntimeThinkingLevelPatch::Unchanged,
            expected_text: "runtime selection is not available",
            expected_kind: "runtime_selection_unavailable",
        },
        Case {
            name: "thinking_override_without_runtime_selection",
            options: ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
            provider_name: None,
            thinking_level: RuntimeThinkingLevelPatch::Set(
                crate::provider::thinking::ThinkingLevel::High,
            ),
            expected_text: "runtime selection is not available",
            expected_kind: "runtime_selection_unavailable",
        },
    ];

    for case in cases {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::with_subagent_options(
            AgentConfig::new("system").with_session(format!(
                "service-subagent-spawn-pre-admission-{}",
                case.name
            )),
            provider.clone(),
            Vec::new(),
            case.options,
        )
        .expect("service construction should succeed");
        let admission_calls = Arc::new(AtomicUsize::new(0));
        let admission_calls_for_hook = admission_calls.clone();
        service.inner.set_subagent_test_hook(
            SubagentTestHookKind::StartAdmission,
            Arc::new(move || {
                admission_calls_for_hook.fetch_add(1, Ordering::SeqCst);
            }),
        );
        let before_seq = service.inner.last_event_seq();
        let call_id = format!("spawn_pre_admission_{}", case.name);

        let result = service.inner.spawn_subagent_tool_result(
            ToolCall::new(
                &call_id,
                "subagent_spawn",
                json!({"task": "must not start"}),
            ),
            SubagentSpawnRequest {
                task: "must not start",
                name_hint: "Worker",
                inherit_context: false,
                provider_name: case.provider_name.map(ToOwned::to_owned),
                thinking_level: case.thinking_level,
                provider_transcript_snapshot: None,
            },
        );

        assert_eq!(
            result,
            ToolResult::error(
                call_id,
                "subagent_spawn",
                case.expected_text,
                json!({"kind": case.expected_kind}),
            ),
            "case {}",
            case.name
        );
        assert_eq!(
            admission_calls.load(Ordering::SeqCst),
            0,
            "case {}",
            case.name
        );
        assert_eq!(
            service.status().state,
            ServiceState::Idle,
            "case {}",
            case.name
        );
        assert_eq!(provider.calls(), 0, "case {}", case.name);
        assert_eq!(
            service.inner.active_service_worker_count(),
            0,
            "case {}",
            case.name
        );
        assert!(
            service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned")
                .list()
                .is_empty(),
            "case {}",
            case.name
        );
        assert!(
            service
                .inner
                .subagent_contexts
                .lock()
                .expect("subagent contexts mutex poisoned")
                .is_empty(),
            "case {}",
            case.name
        );
        assert!(
            service
                .inner
                .subagent_providers
                .lock()
                .expect("subagent providers mutex poisoned")
                .is_empty(),
            "case {}",
            case.name
        );
        assert!(
            service
                .inner
                .subagent_runtime_selections
                .lock()
                .expect("subagent runtime selections mutex poisoned")
                .is_empty(),
            "case {}",
            case.name
        );
        assert!(
            service
                .inner
                .subagent_cancels
                .lock()
                .expect("subagent cancels mutex poisoned")
                .is_empty(),
            "case {}",
            case.name
        );
        assert!(
            service
                .inner
                .subagent_tool_snapshots
                .lock()
                .expect("subagent tool snapshots mutex poisoned")
                .is_empty(),
            "case {}",
            case.name
        );
        assert!(
            service.events_after(before_seq).is_empty(),
            "case {}",
            case.name
        );
    }
}

#[test]
fn subagent_spawn_start_event_failure_does_not_start_branch_run() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-spawn-start-event-failure"),
        provider.clone(),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
    )
    .expect("service construction should succeed");
    let before_seq = service.inner.last_event_seq();
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

    let result = service.inner.spawn_subagent_tool_result(
        ToolCall::new(
            "spawn_start_event_fails",
            "subagent_spawn",
            json!({"task": "invisible task"}),
        ),
        SubagentSpawnRequest {
            task: "invisible task",
            name_hint: "Worker",
            inherit_context: false,
            provider_name: None,
            thinking_level: RuntimeThinkingLevelPatch::Unchanged,
            provider_transcript_snapshot: None,
        },
    );

    assert!(result.is_error, "{result:?}");
    assert_eq!(
        result.details["kind"],
        json!("subagent_start_persistence_failed")
    );
    let subagent_id = result.details["subagent_id"]
        .as_str()
        .expect("error should identify the unstarted subagent");
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status().state, ServiceState::Failed);
    assert_subagent_runtime_resources_absent(&service, subagent_id);
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(subagent_id)
        .expect("cancelled branch should remain inspectable");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    let events = service.events_after(before_seq);
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.started"));
}

#[test]
fn subagent_start_status_failure_does_not_spawn_and_releases_reservation() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-start-status-failure"),
        provider.clone(),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
    )
    .expect("service construction should succeed");
    let before_seq = service.inner.last_event_seq();
    service.inject_timeline_write_failure_after_events(1, TimelineWriteFailure::Flush);

    let result = service.inner.spawn_subagent_tool_result(
        ToolCall::new(
            "spawn_start_status_fails",
            "subagent_spawn",
            json!({"task": "must not run"}),
        ),
        SubagentSpawnRequest {
            task: "must not run",
            name_hint: "Worker",
            inherit_context: false,
            provider_name: None,
            thinking_level: RuntimeThinkingLevelPatch::Unchanged,
            provider_transcript_snapshot: None,
        },
    );

    assert!(result.is_error, "{result:?}");
    assert_eq!(
        result.details["kind"],
        json!("subagent_start_persistence_failed")
    );
    let subagent_id = result.details["subagent_id"]
        .as_str()
        .expect("error should identify the unstarted subagent");
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status().state, ServiceState::Failed);
    assert_eq!(service.inner.active_service_worker_count(), 0);
    assert_subagent_runtime_resources_absent(&service, subagent_id);
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(subagent_id)
        .expect("cancelled branch should remain inspectable");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert_eq!(snapshot.run_state, SubagentRunState::Idle);
    assert_eq!(snapshot.queued_message_count, 0);

    let events = service.events_after(before_seq);
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["subagent.started", "subagent.cancelled", "service.status"]
    );
    assert_eq!(events[0].data["subagent_id"], json!(subagent_id));
    assert_eq!(events[1].data["subagent_id"], json!(subagent_id));
    assert_eq!(events[2].data["state"], json!("failed"));
}

#[test]
fn subagent_queued_run_missing_provider_is_side_effect_free() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-queued-missing-provider"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let before_snapshot = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let running = manager
            .spawn("Queued", "initial run")
            .expect("spawn subagent");
        manager
            .send(&running.id, "queued followup")
            .expect("queue next run");
        manager
            .complete(&running.id, "initial done")
            .expect("complete initial run")
    };
    assert_eq!(before_snapshot.run_state, SubagentRunState::Completed);
    assert_eq!(before_snapshot.queued_messages, vec!["queued followup"]);
    let subagent_id = before_snapshot.id.clone();
    let original_context = vec![Message::user(vec![ContentPart::text(
        "original queued context",
    )])];
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(subagent_id.clone(), original_context.clone());
    let admission_calls = Arc::new(AtomicUsize::new(0));
    let admission_calls_for_hook = admission_calls.clone();
    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::StartAdmission,
        Arc::new(move || {
            admission_calls_for_hook.fetch_add(1, Ordering::SeqCst);
        }),
    );
    let before_status = service.status();
    let before_seq = service.inner.last_event_seq();

    maybe_start_next_subagent_run(service.inner.clone(), subagent_id.clone());

    assert_eq!(admission_calls.load(Ordering::SeqCst), 1);
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status(), before_status);
    assert_eq!(service.inner.active_service_worker_count(), 0);
    assert_eq!(
        service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent should remain inspectable"),
        before_snapshot
    );
    assert_eq!(
        &*service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned"),
        &HashMap::from([(subagent_id.clone(), original_context)])
    );
    assert!(service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .is_empty());
    assert!(service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .is_empty());
    assert!(service.events_after(before_seq).is_empty());
}

#[test]
fn subagent_queued_run_start_event_failure_does_not_leave_branch_running() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-queued-start-write-failure"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let snapshot = manager
            .spawn("Queued", "initial run")
            .expect("spawn subagent");
        manager
            .send(&snapshot.id, "queued run")
            .expect("queue next run");
        manager
            .complete(&snapshot.id, "initial done")
            .expect("complete initial run");
        snapshot.id
    };
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(
            subagent_id.clone(),
            vec![Message::user(vec![ContentPart::text("initial")])],
        );
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), provider.clone());
    let before_seq = service.inner.last_event_seq();
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

    maybe_start_next_subagent_run(service.inner.clone(), subagent_id.clone());

    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(!service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .contains_key(&subagent_id));
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent should remain inspectable");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Open);
    assert_eq!(snapshot.run_state, SubagentRunState::Failed);
    assert!(!service
        .events_after(before_seq)
        .iter()
        .any(|event| event.event_type == "subagent.started"));
}

#[test]
fn idle_subagent_send_missing_provider_is_side_effect_free() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-send-missing-provider"),
        provider.clone(),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
    )
    .expect("service construction should succeed");
    let before_snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "idle branch")
        .expect("open subagent");
    let subagent_id = before_snapshot.id.clone();
    let original_context = vec![Message::user(vec![ContentPart::text("existing context")])];
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(subagent_id.clone(), original_context.clone());
    let admission_calls = Arc::new(AtomicUsize::new(0));
    let admission_calls_for_hook = admission_calls.clone();
    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::StartAdmission,
        Arc::new(move || {
            admission_calls_for_hook.fetch_add(1, Ordering::SeqCst);
        }),
    );
    let before_status = service.status();
    let before_seq = service.inner.last_event_seq();
    let call_id = "send_missing_provider";

    let result = service.inner.send_subagent_tool_result(
        ToolCall::new(
            call_id,
            "subagent_send",
            json!({"subagent_id": subagent_id, "message": "do work"}),
        ),
        &subagent_id,
        "do work",
    );

    assert_eq!(
        result,
        ToolResult::error(
            call_id,
            "subagent_send",
            format!("subagent provider missing: {subagent_id}"),
            json!({
                "kind": "subagent_provider_missing",
                "subagent_id": subagent_id
            }),
        )
    );
    assert_eq!(admission_calls.load(Ordering::SeqCst), 1);
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status(), before_status);
    assert_eq!(service.inner.active_service_worker_count(), 0);
    assert_eq!(
        service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent should remain inspectable"),
        before_snapshot
    );
    assert_eq!(
        &*service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned"),
        &HashMap::from([(subagent_id.clone(), original_context)])
    );
    assert!(service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .is_empty());
    assert!(service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .is_empty());
    assert!(service.events_after(before_seq).is_empty());
}

#[test]
fn subagent_send_start_event_failure_does_not_start_idle_branch_run() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-send-start-event-failure"),
        provider.clone(),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "idle branch")
        .expect("open subagent")
        .id;
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(subagent_id.clone(), Vec::new());
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), provider.clone());
    let before_seq = service.inner.last_event_seq();
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

    let result = service.inner.send_subagent_tool_result(
        ToolCall::new(
            "send_start_event_fails",
            "subagent_send",
            json!({"subagent_id": subagent_id, "message": "do work"}),
        ),
        &subagent_id,
        "do work",
    );

    assert!(result.is_error, "{result:?}");
    assert_eq!(
        result.details["kind"],
        json!("subagent_start_persistence_failed")
    );
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(!service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .contains_key(&subagent_id));
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent should remain inspectable");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Open);
    assert_eq!(snapshot.run_state, SubagentRunState::Failed);
    let events = service.events_after(before_seq);
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.started"));
}

#[test]
fn subagent_send_start_status_failure_appends_failed_and_releases_reservation() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-send-start-status-failure"),
        provider.clone(),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "idle branch")
        .expect("open subagent")
        .id;
    let original_context = vec![
        Message::user(vec![ContentPart::text("existing context")]),
        Message::assistant_text("prior branch response"),
    ];
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(subagent_id.clone(), original_context.clone());
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), provider.clone());
    let before_seq = service.inner.last_event_seq();
    service.inject_timeline_write_failure_after_events(1, TimelineWriteFailure::Flush);

    let result = service.inner.send_subagent_tool_result(
        ToolCall::new(
            "send_start_status_fails",
            "subagent_send",
            json!({"subagent_id": subagent_id, "message": "do work"}),
        ),
        &subagent_id,
        "do work",
    );

    assert_eq!(
        result,
        ToolResult::error(
            "send_start_status_fails",
            "subagent_send",
            "subagent start persistence failed",
            json!({
                "kind": "subagent_start_persistence_failed",
                "subagent_id": subagent_id,
                "name": "Worker",
                "status": "failed"
            }),
        )
    );
    assert_eq!(service.status().state, ServiceState::Failed);
    assert_eq!(service.inner.active_service_worker_count(), 0);
    assert_eq!(provider.calls(), 0);
    assert!(service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .is_empty());

    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent should remain inspectable");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Open);
    assert_eq!(snapshot.run_state, SubagentRunState::Failed);
    assert_eq!(snapshot.latest_result, None);
    assert_eq!(
        snapshot.latest_error.as_deref(),
        Some("subagent start persistence failed")
    );
    assert!(snapshot.callbacks.is_empty());

    let prepared_context = service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .get(&subagent_id)
        .cloned()
        .expect("prepared context should be retained");
    assert_eq!(prepared_context.len(), original_context.len() + 1);
    assert_eq!(
        &prepared_context[..original_context.len()],
        original_context.as_slice()
    );
    let Message::User { content } = prepared_context.last().expect("assignment message") else {
        panic!("last prepared message should be the user assignment");
    };
    assert_eq!(content.len(), 1);
    let ContentPart::Text { text } = &content[0] else {
        panic!("assignment should contain only text");
    };
    assert!(text.starts_with("Botified subagent assignment:\n"));
    assert!(text.ends_with("Assignment:\ndo work"));

    let providers = service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned");
    assert_eq!(providers.len(), 1);
    assert!(providers.contains_key(&subagent_id));
    drop(providers);

    let events = service.events_after(before_seq);
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["subagent.started", "subagent.failed", "service.status"]
    );
    assert_eq!(events[0].data["subagent_id"], json!(subagent_id));
    assert_eq!(events[0].data["run_state"], json!("running"));
    assert_eq!(events[0].data["latest_result"], Value::Null);
    assert_eq!(events[0].data["latest_error"], Value::Null);
    assert_eq!(events[1].data["subagent_id"], json!(subagent_id));
    assert_eq!(events[1].data["run_state"], json!("failed"));
    assert_eq!(events[1].data["latest_result"], Value::Null);
    assert_eq!(
        events[1].data["latest_error"],
        json!("subagent start persistence failed")
    );
    assert_eq!(events[2].data["state"], json!("failed"));
}

#[test]
fn subagent_spawn_is_rejected_when_failed_wins_start_admission() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-spawn-terminal-admission"),
        provider.clone(),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
    )
    .expect("service construction should succeed");
    let failed_inner = service.inner.clone();
    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::StartAdmission,
        Arc::new(move || {
            let mut state = failed_inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Failed;
            state.last_error = Some("injected terminal race".to_owned());
        }),
    );
    let before_seq = service.inner.last_event_seq();

    let result = service.inner.spawn_subagent_tool_result(
        ToolCall::new("spawn_terminal_race", "subagent_spawn", json!({})),
        SubagentSpawnRequest {
            task: "must not start",
            name_hint: "Worker",
            inherit_context: false,
            provider_name: None,
            thinking_level: RuntimeThinkingLevelPatch::Unchanged,
            provider_transcript_snapshot: None,
        },
    );

    assert!(result.is_error, "{result:?}");
    assert_eq!(result.details["kind"], json!("service_unavailable"));
    assert_eq!(service.status().state, ServiceState::Failed);
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.inner.active_service_worker_count(), 0);
    assert!(service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .list()
        .is_empty());
    assert!(service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .is_empty());
    assert!(service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .is_empty());
    assert!(service
        .inner
        .subagent_runtime_selections
        .lock()
        .expect("subagent runtime selections mutex poisoned")
        .is_empty());
    assert!(service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .is_empty());
    assert!(!service
        .events_after(before_seq)
        .iter()
        .any(|event| event.event_type == "subagent.started"));
}

#[test]
fn idle_subagent_send_is_rejected_when_shutdown_wins_start_admission() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-send-terminal-admission"),
        provider.clone(),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "idle branch")
        .expect("open subagent")
        .id;
    let original_context = vec![Message::user(vec![ContentPart::text("existing context")])];
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(subagent_id.clone(), original_context.clone());
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), provider.clone());
    let shutdown_inner = service.inner.clone();
    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::StartAdmission,
        Arc::new(move || {
            shutdown_inner
                .state
                .lock()
                .expect("service state mutex poisoned")
                .state = ServiceState::ShuttingDown;
        }),
    );
    let before_seq = service.inner.last_event_seq();

    let result = service.inner.send_subagent_tool_result(
        ToolCall::new("send_terminal_race", "subagent_send", json!({})),
        &subagent_id,
        "must remain queued nowhere",
    );

    assert!(result.is_error, "{result:?}");
    assert_eq!(result.details["kind"], json!("service_unavailable"));
    assert_eq!(service.status().state, ServiceState::ShuttingDown);
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.inner.active_service_worker_count(), 0);
    assert!(service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .contains_key(&subagent_id));
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent remains available");
    assert_eq!(snapshot.run_state, SubagentRunState::Idle);
    assert_eq!(snapshot.queued_message_count, 0);
    assert!(!service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .contains_key(&subagent_id));
    assert_eq!(
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .get(&subagent_id),
        Some(&original_context)
    );
    assert!(!service
        .events_after(before_seq)
        .iter()
        .any(|event| event.event_type == "subagent.started"));
}
