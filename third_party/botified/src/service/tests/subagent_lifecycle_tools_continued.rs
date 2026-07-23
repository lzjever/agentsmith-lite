#[tokio::test]
async fn subagent_cancel_during_queued_run_start_does_not_restore_context_or_cancel_token() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-queued-start-race"),
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
        .insert(subagent_id.clone(), Arc::new(TextProvider("queued result")));
    install_subagent_cancel_hook(
        &service,
        SubagentTestHookKind::QueuedRunProviderClone,
        subagent_id.clone(),
    );
    let before_seq = service.inner.last_event_seq();

    maybe_start_next_subagent_run(service.inner.clone(), subagent_id.clone());

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
        .any(|event| event.event_type == "subagent.started"));
}

#[tokio::test]
async fn subagent_cancel_after_queued_run_state_before_event_does_not_append_stale_started() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-queued-start-event-race"),
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
        .insert(subagent_id.clone(), Arc::new(TextProvider("queued result")));
    install_subagent_cancel_hook(
        &service,
        SubagentTestHookKind::QueuedRunStateBeforeAppend,
        subagent_id.clone(),
    );
    let before_seq = service.inner.last_event_seq();

    maybe_start_next_subagent_run(service.inner.clone(), subagent_id.clone());

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
        "subagent.started",
    );
}

#[tokio::test]
async fn durable_subagent_callback_accept_is_not_rejected_by_post_accept_shutdown() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-callback-shutdown-race"),
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
        state.active_turn_id = Some("turn_callback_shutdown_race".to_owned());
        state.active_cancel = Some(CancellationToken::new());
    }
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Callback", "post accept shutdown race")
        .expect("open subagent");
    let inner = service.inner.clone();
    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::CallbackEnqueueBeforeRecord,
        Arc::new(move || {
            let mut state = inner.state.lock().expect("service state mutex poisoned");
            if let Some(cancel) = state.active_cancel.as_ref() {
                cancel.cancel();
            }
            state.state = ServiceState::ShuttingDown;
        }),
    );
    let before_seq = service.inner.last_event_seq();

    enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.callback_count, 1);
    assert_eq!(snapshot.pending_callback_count, 1);
    let state = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned");
    assert!(state
        .input_queue
        .iter()
        .any(|queued| queued.source == InputSource::SubagentCallback));
    assert!(!service.events_after(before_seq).iter().any(|event| {
        event.event_type == "message.rejected"
            && event.data["reason"] == json!("service_shutting_down")
    }));
    assert!(service.events_after(before_seq).iter().any(|event| {
        event.event_type == "subagent.callback" && event.data["callback_status"] == json!("pending")
    }));
}

#[tokio::test]
async fn subagent_cancel_between_callback_enqueue_and_record_does_not_pollute_queue_or_branch() {
    let home = service_test_home("subagent-callback-cancel-tombstone");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let session_path = home.join("sessions/service-test.jsonl");
    let service = Service::with_initial_context(
        AgentConfig::new("system").with_session("service-subagent-callback-record-race"),
        Arc::new(PanicProvider),
        Vec::new(),
        session.initial_messages().to_vec(),
        Some(session.recorder()),
    )
    .expect("service construction should succeed");
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_callback_race".to_owned());
        state.active_cancel = Some(CancellationToken::new());
    }
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Callback", "callback race")
        .expect("open subagent");
    install_subagent_cancel_hook(
        &service,
        SubagentTestHookKind::CallbackEnqueueBeforeRecord,
        snapshot.id.clone(),
    );

    enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert_eq!(snapshot.callback_count, 0);
    let state = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned");
    assert!(!state
        .input_queue
        .iter()
        .any(|queued| queued.source == InputSource::SubagentCallback));

    let entries = fs::read_to_string(&session_path)
        .expect("session should read")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("session line should parse"))
        .collect::<Vec<_>>();
    let accepted_callback = entries
        .iter()
        .find(|entry| {
            entry["type"] == "accepted_input"
                && entry["source"] == "subagent_callback"
                && entry["metadata"]["subagent_callback"]["subagent_id"] == snapshot.id
        })
        .expect("cancelled durable callback should still have an accepted entry");
    let callback_id = accepted_callback["message_id"]
        .as_str()
        .expect("accepted callback should include message_id");
    assert!(entries.iter().any(|entry| {
        entry["type"] == "pending_input_removed"
            && entry["message_id"] == callback_id
            && entry["source"] == "subagent_callback"
            && entry["metadata"]["subagent_callback"]["subagent_id"] == snapshot.id
            && entry["reason"] == "subagent_cancelled"
    }));

    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should reopen");
    assert!(
        reopened.pending_messages().is_empty(),
        "cancelled subagent callback must not rehydrate as pending after restart"
    );
}

#[tokio::test]
async fn subagent_cancelled_pending_removal_failure_fails_service_and_cancels_turn() {
    let service = Service::with_initial_context(
        AgentConfig::new("system")
            .with_session("service-subagent-cancelled-pending-removal-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
        Vec::new(),
        Some(Arc::new(FailingPendingRemovalRecorder)),
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
        state.active_turn_id = Some("turn_callback_cancel_tombstone_failed".to_owned());
        state.active_cancel = Some(active_cancel.clone());
    }
    let snapshot = open_test_subagent(&service, "CallbackCancelTombstoneFailed");
    install_subagent_cancel_hook(
        &service,
        SubagentTestHookKind::CallbackEnqueueBeforeRecord,
        snapshot.id.clone(),
    );
    let before_seq = service.inner.last_event_seq();

    enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(active_cancel.is_cancelled());
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert_eq!(snapshot.callback_count, 0);
    assert!(service.events_after(before_seq).iter().any(|event| {
        event.event_type == "subagent.callback_pending_removal_failed"
            && event.data["reason"] == json!("subagent_cancelled")
            && event.data["error"]["code"] == json!("pending_removal_persistence_failed")
    }));
}

#[tokio::test]
async fn session_subagent_callback_record_failure_does_not_publish_input_timeline() {
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        FailingSyncSessionFile,
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-subagent-callback-record-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay::default(),
        Some(recorder),
        Vec::new(),
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
        state.active_turn_id = Some("turn_callback_record_failure".to_owned());
        state.active_cancel = Some(CancellationToken::new());
    }
    let snapshot = open_test_subagent(&service, "CallbackRecordFailure");
    let callback_id = "subagent_callback_record_failure".to_owned();
    let before_seq = service.inner.last_event_seq();

    let (_, status, _, _) = enqueue_subagent_callback_input(
        &service.inner,
        SubagentCallbackFacts::default(),
        &snapshot.id,
        callback_id.clone(),
        "completed",
        vec![ContentPart::text("callback body")],
    )
    .await
    .expect("failed callback should still record lifecycle outcome");

    assert_eq!(status, "failed");
    assert_recorded_callback(
        &service,
        &snapshot.id,
        &callback_id,
        SubagentCallbackStatus::Failed,
    );
    let events = service.events_after(before_seq);
    assert!(
        events.iter().all(|event| {
            !(matches!(
                event.event_type.as_str(),
                "message.received" | "message.queued"
            ) && event.data["message_id"] == json!(callback_id))
        }),
        "session record failure must not publish ghost input timeline events: {events:?}"
    );
    assert_eq!(service.status().queue_length, 0);
}

#[tokio::test]
async fn session_subagent_callback_status_append_failure_preserves_committed_input() {
    let home = service_test_home("subagent-callback-status-failure");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let session_path = session.path().to_path_buf();
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        session.replay(),
        Some(session.recorder()),
        session.warnings().to_vec(),
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
        state.active_turn_id = Some("turn_callback_status_failure".to_owned());
        state.active_cancel = Some(CancellationToken::new());
    }
    let snapshot = open_test_subagent(&service, "CallbackStatusFailure");
    let callback_id = "subagent_callback_status_failure".to_owned();
    service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);

    let (_, status, _, _) = enqueue_subagent_callback_input(
        &service.inner,
        SubagentCallbackFacts::default(),
        &snapshot.id,
        callback_id.clone(),
        "completed",
        vec![ContentPart::text("callback body")],
    )
    .await
    .expect("timeline failure should still record callback outcome");

    assert_eq!(status, "failed");
    let entries = fs::read_to_string(&session_path)
        .expect("session should read")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("session line should parse"))
        .collect::<Vec<_>>();
    assert!(
        entries.iter().any(|entry| {
            entry["type"] == "accepted_input"
                && entry["message_id"].as_str() == Some(callback_id.as_str())
        }),
        "timeline failure after accepted persistence must preserve accepted_input: {entries:?}"
    );
    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should reopen after committed callback");
    assert_eq!(reopened.pending_messages().len(), 1);
    assert_eq!(reopened.pending_messages()[0].id, callback_id);
}

#[tokio::test]
async fn session_subagent_cancel_before_callback_enqueue_does_not_record_accepted_input() {
    let home = service_test_home("subagent-callback-session-cancel-no-accepted");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let session_path = session.path().to_path_buf();
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        session.replay(),
        Some(session.recorder()),
        session.warnings().to_vec(),
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
        state.active_turn_id = Some("turn_callback_cancel_no_accepted".to_owned());
        state.active_cancel = Some(CancellationToken::new());
    }
    let snapshot = open_test_subagent(&service, "CallbackCancelNoAccepted");
    install_subagent_cancel_hook(
        &service,
        SubagentTestHookKind::CallbackEnqueueBeforeRecord,
        snapshot.id.clone(),
    );

    enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert_eq!(snapshot.callback_count, 0);
    let entries = fs::read_to_string(&session_path)
        .expect("session should read")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("session line should parse"))
        .collect::<Vec<_>>();
    assert!(
        !entries.iter().any(|entry| {
            entry["type"] == "accepted_input" && entry["source"] == "subagent_callback"
        }),
        "session-mode cancelled callback must not persist accepted_input: {entries:?}"
    );
    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should reopen");
    assert!(reopened.pending_messages().is_empty());
}

#[tokio::test]
async fn subagent_cancel_after_callback_record_before_event_does_not_append_stale_callback() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-callback-event-race"),
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
        state.active_turn_id = Some("turn_callback_event_race".to_owned());
        state.active_cancel = Some(CancellationToken::new());
    }
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Callback", "callback event race")
        .expect("open subagent");
    install_subagent_cancel_hook(
        &service,
        SubagentTestHookKind::CallbackRecordBeforeAppend,
        snapshot.id.clone(),
    );
    let before_seq = service.inner.last_event_seq();

    enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert_subagent_not_reactivated_after_cancel(
        &service,
        before_seq,
        &snapshot.id,
        "subagent.callback",
    );
}

#[tokio::test]
async fn subagent_callback_event_failure_cancels_start_and_rolls_back_callback() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system")
            .with_session("service-subagent-callback-event-persistence-failure"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let snapshot = open_test_subagent(&service, "CallbackEventFailure");
    let before_seq = service.inner.last_event_seq();
    service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);

    enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;
    tokio::task::yield_now().await;

    assert_eq!(service.status().state, ServiceState::Failed);
    assert_eq!(service.status().queue_length, 0);
    assert_eq!(provider.calls(), 0);
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.callback_count, 0);
    assert_eq!(snapshot.pending_callback_count, 0);
    assert_eq!(snapshot.failed_callback_count, 0);
    let events = service.events_after(before_seq);
    assert!(events
        .iter()
        .any(|event| event.event_type == "message.received"));
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.callback"));
}

#[tokio::test]
async fn subagent_task_ask_callback_rollback_preserves_structured_identity() {
    let home = service_test_home("subagent-task-ask-callback-rollback-identity");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let session_path = session.path().to_path_buf();
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        session.replay(),
        Some(session.recorder()),
        session.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let metadata = QueuedInputMetadata::SubagentCallback {
        subagent_id: "subagent-identity".to_owned(),
        kind: "task_ask".to_owned(),
        task_id: Some("task-identity".to_owned()),
        ask_id: Some("ask-identity".to_owned()),
        tell_id: None,
        task_message: Some("callback body".to_owned()),
        label: Some("worker".to_owned()),
        summary: Some("identity task".to_owned()),
    };
    assert!(valid_subagent_callback_metadata(&metadata));
    let accepted = AcceptedInputEntry {
        message_id: "callback-identity".to_owned(),
        content: vec![ContentPart::text("callback body")],
        cursor_seq: service.inner.last_event_seq(),
        source: InputSource::SubagentCallback,
        metadata: Some(metadata.clone()),
        urgency: InputUrgency::Normal,
    };
    service
        .inner
        .recorder
        .as_ref()
        .expect("session recorder")
        .record_accepted_input(&accepted)
        .await
        .expect("accepted callback should be durable");

    rollback_enqueued_subagent_callback(&service.inner, "callback-identity", &metadata).await;

    let entries = fs::read_to_string(&session_path)
        .expect("session should read")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("session line should parse"))
        .collect::<Vec<_>>();
    let tombstone = entries
        .iter()
        .find(|entry| {
            entry["type"] == "pending_input_removed" && entry["message_id"] == "callback-identity"
        })
        .expect("rollback tombstone should be durable");
    let metadata_value = &tombstone["metadata"]["subagent_callback"];
    assert_eq!(metadata_value["task_id"], json!("task-identity"));
    assert_eq!(metadata_value["ask_id"], json!("ask-identity"));
    assert!(metadata_value["tell_id"].is_null());

    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay rollback tombstone");
    assert!(reopened.pending_messages().is_empty());
}

#[test]
fn terminal_callback_semantics_are_owned_by_service_mapping() {
    for (kind, expected_status) in [
        ("task_completed", "completed"),
        ("task_failed", "failed"),
        ("task_timed_out", "timed_out"),
        ("task_cancelled", "cancelled"),
        ("task_lost", "lost"),
    ] {
        let mut data = json!({});
        add_subagent_callback_identity(&mut data, kind, Some("task_1"), None);
        assert_eq!(data["semantic_kind"], "task_result");
        assert_eq!(data["semantic_status"], expected_status);
        assert_eq!(data["task_id"], "task_1");
    }
}

#[tokio::test]
async fn subagent_callback_rollback_keeps_pending_state_when_tombstone_fails() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_initial_context(
        AgentConfig::new("system")
            .with_session("service-subagent-callback-rollback-tombstone-failure"),
        provider.clone(),
        Vec::new(),
        Vec::new(),
        Some(Arc::new(FailingPendingRemovalRecorder)),
    )
    .expect("service construction should succeed");
    let snapshot = open_test_subagent(&service, "CallbackRollbackTombstoneFailure");
    let before_seq = service.inner.last_event_seq();
    service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);

    enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;
    tokio::task::yield_now().await;

    assert_eq!(service.status().state, ServiceState::Failed);
    assert_eq!(
        service.status().queue_length,
        1,
        "accepted callback must stay queued when its removal tombstone fails"
    );
    assert_eq!(provider.calls(), 0);
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.callback_count, 1);
    assert_eq!(snapshot.pending_callback_count, 1);
    assert_eq!(snapshot.failed_callback_count, 0);
    let events = service.events_after(before_seq);
    assert!(events
        .iter()
        .any(|event| event.event_type == "message.received"));
    assert!(events.iter().any(|event| {
        event.event_type == "subagent.callback_pending_removal_failed"
            && event.data["error"]["code"] == json!("pending_removal_persistence_failed")
    }));
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.callback"));
}

#[tokio::test]
async fn subagent_cancel_rejects_reason_argument_by_contract() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-cancel-reason"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Reviewer", "review cancellation reason")
        .expect("open subagent")
        .id;
    let tool = SubagentCancelTool::new(Arc::downgrade(&service.inner));

    let result = tool
        .execute(
            ToolCall::new(
                "cancel_reason",
                "subagent_cancel",
                json!({"subagent_id": subagent_id, "reason": "obsolete"}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("tool execution should return a result");

    assert!(result.is_error, "{result:?}");
    assert_eq!(result.details["kind"], json!("invalid_tool_arguments"));
    assert_eq!(result.details["field"], json!("reason"));
    assert!(!service
        .events_after(0)
        .iter()
        .any(|event| event.event_type == "subagent.cancelled"));
}

#[tokio::test]
async fn subagent_spawn_text_is_llm_visible_and_self_contained() {
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-spawn-text"),
        Arc::new(TextProvider("spawn result")),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
    )
    .expect("service construction should succeed");
    let tool = SubagentSpawnTool::new(Arc::downgrade(&service.inner));

    let result = tool
        .execute(
            ToolCall::new(
                "spawn_text",
                "subagent_spawn",
                json!({"task": "inspect the auth flow", "name_hint": "Reviewer = Auth\nFlow"}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("spawn should return");

    assert!(!result.is_error, "{result:?}");
    let text = tool_text_json(&result);
    let subagent_id = text["subagent_id"]
        .as_str()
        .expect("spawn details should include subagent_id");
    assert_eq!(text["subagent_id"], json!(subagent_id));
    assert_eq!(text["name"], json!("Reviewer = Auth Flow"));
    assert_eq!(text["status"], json!("started"));
    assert_eq!(text["callback_pending"], json!(true));
}

#[tokio::test]
async fn subagent_list_text_is_llm_visible_for_empty_and_non_empty_lists() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-list-text"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let tool = SubagentListTool::new(Arc::downgrade(&service.inner));

    let empty = tool
        .execute(
            ToolCall::new("list_empty", "subagent_list", json!({})),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("empty list should return");
    assert!(!empty.is_error, "{empty:?}");
    let empty_text = tool_text_json(&empty);
    assert_eq!(empty_text["total"], json!(0));
    assert_eq!(
        empty_text["subagents"]
            .as_array()
            .expect("subagents should be an array")
            .len(),
        0
    );

    let (running_id, completed_id) = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let running = manager
            .spawn("Runner", "keep working")
            .expect("spawn running subagent");
        let completed = manager
            .spawn("Finisher = Audit", "finish work")
            .expect("spawn completed subagent");
        manager
            .complete(&completed.id, "finished review\nline=2")
            .expect("complete subagent");
        manager
            .record_callback(
                &running.id,
                "callback_1",
                "completed",
                SubagentCallbackStatus::Pending,
                None,
            )
            .expect("record pending callback");
        (running.id, completed.id)
    };

    let listed = tool
        .execute(
            ToolCall::new("list_full", "subagent_list", json!({})),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("list should return");
    assert!(!listed.is_error, "{listed:?}");
    let listed_text = tool_text_json(&listed);
    assert_eq!(listed_text["total"], json!(2));
    let subagents = listed_text["subagents"]
        .as_array()
        .expect("subagents should be an array");
    let running = subagents
        .iter()
        .find(|subagent| subagent["subagent_id"] == running_id)
        .expect("running subagent should be listed");
    assert_eq!(running["name"], json!("Runner"));
    assert_eq!(running["lifecycle"], json!("open"));
    assert_eq!(running["run_state"], json!("running"));
    assert_eq!(running["status_summary"], json!("running"));
    assert_eq!(running["pending_callback_count"], json!(1));
    let completed = subagents
        .iter()
        .find(|subagent| subagent["subagent_id"] == completed_id)
        .expect("completed subagent should be listed");
    assert_eq!(completed["name"], json!("Finisher = Audit"));
    assert_eq!(completed["latest_result"], json!("finished review\nline=2"));
}

#[tokio::test]
async fn subagent_send_and_cancel_text_are_details_json() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-send-cancel-text"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .spawn("Worker = One", "initial work")
        .expect("spawn subagent")
        .id;

    let send = SubagentSendTool::new(Arc::downgrade(&service.inner))
        .execute(
            ToolCall::new(
                "send_text",
                "subagent_send",
                json!({"subagent_id": subagent_id, "message": "follow up\nkey=value"}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("send should return");
    assert!(!send.is_error, "{send:?}");
    let send_text = tool_text_json(&send);
    assert_eq!(send_text["subagent_id"], json!(subagent_id));
    assert_eq!(send_text["name"], json!("Worker = One"));
    assert_eq!(send_text["status"], json!("queued"));
    assert_eq!(send_text["queued_messages"], json!(1));

    let cancel = SubagentCancelTool::new(Arc::downgrade(&service.inner))
        .execute(
            ToolCall::new(
                "cancel_text",
                "subagent_cancel",
                json!({"subagent_id": subagent_id}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("cancel should return");
    assert!(!cancel.is_error, "{cancel:?}");
    let cancel_text = tool_text_json(&cancel);
    assert_eq!(cancel_text["subagent_id"], json!(subagent_id));
    assert_eq!(cancel_text["name"], json!("Worker = One"));
    assert_eq!(cancel_text["status"], json!("cancelled"));
    assert!(cancel_text["cancelled_task_ids"].is_array());
}

#[test]
fn subagent_read_missing_id_preserves_structured_error() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-read-missing"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let before_seq = service.inner.last_event_seq();

    let result = service.inner.read_subagent_tool_result(
        ToolCall::new(
            "read_missing",
            "subagent_read",
            json!({"subagent_id": "missing-subagent", "include": "summary"}),
        ),
        "missing-subagent",
        "summary",
    );

    assert_eq!(result.tool_call_id, "read_missing");
    assert_eq!(result.tool_name, "subagent_read");
    assert_eq!(result.text, "subagent not found: missing-subagent");
    assert!(result.is_error);
    assert!(!result.terminate);
    assert_eq!(
        result.details,
        json!({
            "kind": "subagent_not_found",
            "subagent_id": "missing-subagent"
        })
    );
    assert_eq!(service.inner.last_event_seq(), before_seq);
    assert!(service.events_after(before_seq).is_empty());
    assert!(service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .list()
        .is_empty());
}

#[tokio::test]
async fn subagent_read_include_contract_is_summary_tail_or_all() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-read-include"),
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
            .spawn("Reader", "read include contract")
            .expect("spawn subagent");
        manager
            .complete(&snapshot.id, "summary ready")
            .expect("complete subagent");
        snapshot.id
    };
    let tool = SubagentReadTool::new(Arc::downgrade(&service.inner));
    assert_eq!(
        tool.spec().input_schema["properties"]["include"]["enum"],
        json!(["summary", "tail", "all"])
    );

    let summary = tool
        .execute(
            ToolCall::new(
                "read_summary",
                "subagent_read",
                json!({"subagent_id": subagent_id}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("summary read should return");
    assert!(!summary.is_error, "{summary:?}");
    assert!(summary.details.get("tail").is_none());
    assert!(summary.details.get("queued_messages").is_none());

    let tail = tool
        .execute(
            ToolCall::new(
                "read_tail",
                "subagent_read",
                json!({"subagent_id": subagent_id, "include": "tail"}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("tail read should return");
    assert!(!tail.is_error, "{tail:?}");
    assert!(tail.details["tail"]
        .as_array()
        .expect("tail include should return tail array")
        .iter()
        .any(|entry| entry["text"] == "summary ready"));
    assert!(tail.details.get("queued_messages").is_none());

    let all = tool
        .execute(
            ToolCall::new(
                "read_all",
                "subagent_read",
                json!({"subagent_id": subagent_id, "include": "all"}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("all read should return");
    assert!(!all.is_error, "{all:?}");
    assert!(all.details.get("tail").is_some());
    assert!(all.details.get("queued_messages").is_some());
    assert!(all.details.get("owned_task_ids").is_some());
    assert!(all.details.get("callbacks").is_some());

    let invalid = tool
        .execute(
            ToolCall::new(
                "read_invalid",
                "subagent_read",
                json!({"subagent_id": subagent_id, "include": "messages"}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("invalid read should return");
    assert!(invalid.is_error, "{invalid:?}");
    assert_eq!(
        invalid.details,
        json!({"kind": "invalid_subagent_arguments", "field": "include"})
    );
}

#[tokio::test]
async fn subagent_read_text_is_llm_visible_and_respects_include() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-read-text"),
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
            .spawn("Reader", "read text contract")
            .expect("spawn subagent");
        manager
            .complete(&snapshot.id, "summary ready\nkey=value")
            .expect("complete subagent");
        snapshot.id
    };
    let tool = SubagentReadTool::new(Arc::downgrade(&service.inner));

    let summary = tool
        .execute(
            ToolCall::new(
                "read_text_summary",
                "subagent_read",
                json!({"subagent_id": subagent_id}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("summary read should return");
    assert!(!summary.is_error, "{summary:?}");
    let summary_text = tool_text_json(&summary);
    assert_eq!(summary_text["subagent_id"], json!(subagent_id));
    assert_eq!(summary_text["name"], json!("Reader"));
    assert_eq!(summary_text["run_state"], json!("completed"));
    assert_eq!(
        summary_text["latest_result"],
        json!("summary ready\nkey=value")
    );
    assert!(summary_text.get("tail").is_none());

    let tail = tool
        .execute(
            ToolCall::new(
                "read_text_tail",
                "subagent_read",
                json!({"subagent_id": subagent_id, "include": "tail"}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("tail read should return");
    assert!(!tail.is_error, "{tail:?}");
    let tail_text = tool_text_json(&tail);
    assert!(tail_text["tail"]
        .as_array()
        .expect("tail should be an array")
        .iter()
        .any(|entry| entry["kind"] == "result" && entry["text"] == "summary ready\nkey=value"));
}
