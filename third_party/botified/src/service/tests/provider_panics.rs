#[tokio::test]
async fn main_provider_panic_terminalizes_worker_and_shutdown_remains_quiescent() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-main-provider-panic"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");

    service
        .enqueue("panic-main", vec![ContentPart::text("panic now")])
        .await
        .expect("input should enqueue");
    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("provider panic should fail the service");
    wait_until(|| service.inner.active_service_worker_count() == 0).await;

    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(state.active_cancel.is_none());
        assert!(state.active_turn_id.is_none());
        assert!(!state.input_queue.has_pending_batch());
        assert_eq!(
            state.input_queue.len(),
            0,
            "input is committed before the provider worker starts"
        );
    }
    tokio::time::timeout(Duration::from_secs(1), service.abort())
        .await
        .expect("abort after panic should not hang");
    let shutdown = tokio::time::timeout(Duration::from_secs(1), service.shutdown())
        .await
        .expect("shutdown after panic should not wait for a leaked worker");
    assert_eq!(shutdown.state, ServiceState::ShuttingDown);
}

#[tokio::test]
async fn stale_main_worker_panic_does_not_terminalize_new_active_turn() {
    let provider = Arc::new(ControlledPanicProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-stale-main-worker-panic"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    service
        .enqueue("new-turn", vec![ContentPart::text("new active turn")])
        .await
        .expect("new turn should start");
    provider.wait_until_entered().await;
    let (new_turn_id, new_cancel) = {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        (
            state
                .active_turn_id
                .clone()
                .expect("new turn should be active"),
            state
                .active_cancel
                .clone()
                .expect("new turn should be cancellable"),
        )
    };
    let before_seq = service.inner.last_event_seq();

    terminalize_service_loop_panic(
        service.inner.clone(),
        "turn_old".to_owned(),
        "late panic from turn_old".to_owned(),
    );

    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert_eq!(state.state, ServiceState::Running);
        assert_eq!(state.active_turn_id.as_deref(), Some(new_turn_id.as_str()));
        assert!(state.active_cancel.is_some());
        assert!(!new_cancel.is_cancelled());
        assert_eq!(state.last_error, None);
    }
    assert_eq!(service.inner.last_event_seq(), before_seq);
    provider.release();
    service.wait_for_state(ServiceState::Failed).await;
    wait_until(|| service.inner.active_service_worker_count() == 0).await;
}

#[tokio::test]
async fn main_provider_long_panic_bounds_last_error_and_status_event() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-main-provider-long-panic"),
        Arc::new(LongPanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let before_seq = service.inner.last_event_seq();

    service
        .enqueue(
            "panic-main-long",
            vec![ContentPart::text("panic with long text")],
        )
        .await
        .expect("input should enqueue");
    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("provider panic should fail the service");
    wait_until(|| service.inner.active_service_worker_count() == 0).await;

    let prefix_chars = "agent loop worker panicked: ".chars().count();
    let last_error = service
        .status()
        .last_error
        .expect("panic should set last_error");
    assert!(
        last_error.chars().count() <= prefix_chars + SERVICE_WORKER_PANIC_MAX_CHARS,
        "panic error must be bounded: {} chars",
        last_error.chars().count()
    );
    assert!(!last_error.contains("PANIC_TAIL_SENTINEL"));
    let status_errors = service
        .events_after(before_seq)
        .into_iter()
        .filter(|event| event.event_type == "service.status")
        .filter_map(|event| event.data["last_error"].as_str().map(ToOwned::to_owned))
        .collect::<Vec<_>>();
    assert!(!status_errors.is_empty());
    assert!(status_errors.iter().all(|error| {
        error.chars().count() <= prefix_chars + SERVICE_WORKER_PANIC_MAX_CHARS
            && !error.contains("PANIC_TAIL_SENTINEL")
    }));
}

#[tokio::test]
async fn main_provider_panic_cancels_running_compaction() {
    let provider = Arc::new(ControlledPanicProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-main-panic-cancels-compaction"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    service
        .enqueue(
            "panic-main-compact",
            vec![ContentPart::text("enter provider")],
        )
        .await
        .expect("input should enqueue");
    provider.wait_until_entered().await;
    let compact_cancel = CancellationToken::new();
    *service
        .inner
        .compact
        .slot
        .lock()
        .expect("compact slot mutex poisoned") = CompactSlot::Running {
        run_id: 77,
        messages_at_start: Vec::new(),
        retained_start: 0,
        start_len: 0,
        cancel: compact_cancel.clone(),
        hard_failure_key: None,
        hard_failure_count_at_start: 0,
    };

    provider.release();
    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("provider panic should fail the service");
    assert!(compact_cancel.is_cancelled());
}

#[tokio::test]
async fn main_provider_panic_after_abort_finishes_as_cancelled_not_failed() {
    let provider = Arc::new(ControlledPanicProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-main-abort-provider-panic"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    service
        .enqueue("abort-panic", vec![ContentPart::text("wait then panic")])
        .await
        .expect("input should enqueue");
    provider.wait_until_entered().await;

    assert_eq!(service.abort().await.state, ServiceState::Aborting);
    provider.release();
    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Idle),
    )
    .await
    .expect("abort-winning provider panic should finish like cancellation");
    assert_eq!(service.status().last_error, None);
    wait_until(|| service.inner.active_service_worker_count() == 0).await;
}

#[tokio::test]
async fn subagent_provider_panic_fails_once_and_releases_parallel_slot() {
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-provider-panic"),
        Arc::new(TextProvider("callback handled")),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(1, 4)),
    )
    .expect("service construction should succeed");
    let before_seq = service.inner.last_event_seq();
    let provider = Arc::new(ControlledPanicProvider::new());
    let subagent_id = spawn_panicking_subagent(&service, provider.clone(), "panic branch");
    provider.wait_until_entered().await;
    let panic_cancel = service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .get(&subagent_id)
        .expect("subagent cancel token should be registered")
        .clone();
    provider.release();

    wait_until(|| {
        service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .is_some_and(|snapshot| snapshot.run_state == SubagentRunState::Failed)
    })
    .await;
    wait_until(|| service.inner.active_service_worker_count() == 0).await;

    let mut manager = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned");
    let snapshot = manager.snapshot(&subagent_id).expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Open);
    assert_eq!(snapshot.callback_count, 1);
    assert_eq!(manager.running_count(), 0);
    manager
        .spawn("Replacement", "parallel slot probe")
        .expect("panic must release the parallel slot");
    drop(manager);
    assert!(panic_cancel.is_cancelled());
    assert!(!service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .contains_key(&subagent_id));
    let events = service.events_after(before_seq);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "subagent.failed")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "subagent.callback"
                    && event.data["subagent_id"] == json!(subagent_id)
                    && event.data["callback_kind"] == json!("failed")
            })
            .count(),
        1
    );
}

#[tokio::test]
async fn subagent_panic_after_partial_progress_preserves_context_for_queued_run() {
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-partial-progress-panic"),
        Arc::new(TextProvider("callback handled")),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(1, 4)),
    )
    .expect("service construction should succeed");
    let provider = Arc::new(PartialProgressThenPanicProvider::new());
    let subagent_id = spawn_panicking_subagent_with_tools(
        &service,
        provider.clone(),
        "make partial progress",
        vec![Arc::new(NoopTool)],
    );
    provider.wait_until_panic_entered().await;

    let queued = service.inner.send_subagent_tool_result(
        ToolCall::new("queue-after-progress", "subagent_send", json!({})),
        &subagent_id,
        "continue from partial progress",
    );
    assert!(!queued.is_error, "{queued:?}");
    assert_eq!(queued.details["status"], json!("queued"));

    provider.panic_release.notify_one();
    let request = tokio::time::timeout(Duration::from_secs(2), provider.wait_for_queued_request())
        .await
        .expect("queued run should start after the panic");
    let transcript = request.transcript_messages();
    assert!(
        transcript.iter().any(|message| matches!(
            message,
            Message::Assistant { tool_calls, .. }
                if tool_calls.iter().any(|call| call.id == "call_partial_progress")
        )),
        "queued run lost the assistant tool call from before the panic: {transcript:?}"
    );
    assert!(
        transcript.iter().any(|message| matches!(
            message,
            Message::ToolResult(result) if result.tool_call_id == "call_partial_progress"
        )),
        "queued run lost the tool result from before the panic: {transcript:?}"
    );
}

#[tokio::test]
async fn subagent_provider_panic_after_cancel_does_not_reactivate_branch() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-panic-cancel-race"),
        Arc::new(TextProvider("unused")),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let provider = Arc::new(ControlledPanicProvider::new());
    let subagent_id = spawn_panicking_subagent(&service, provider.clone(), "cancel then panic");
    provider.wait_until_entered().await;
    let before_seq = service.inner.last_event_seq();

    service.inner.cancel_subagent_tool_result(
        ToolCall::new("cancel-panic", "subagent_cancel", json!({})),
        &subagent_id,
    );
    provider.release();
    wait_until(|| service.inner.active_service_worker_count() == 0).await;

    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert_ne!(snapshot.run_state, SubagentRunState::Failed);
    assert_eq!(snapshot.callback_count, 0);
    let events = service.events_after(before_seq);
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.failed"));
    assert!(!events
        .iter()
        .any(|event| event.event_type == "subagent.callback"));
}

#[tokio::test]
async fn subagent_failure_shutdown_during_callback_does_not_start_queued_run() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-callback-shutdown-fence"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let (subagent_id, messages) = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let snapshot = manager
            .spawn("Queued", "running before failure")
            .expect("spawn subagent");
        manager
            .send(&snapshot.id, "queued after failure")
            .expect("queue next run");
        (
            snapshot.id,
            vec![Message::user(vec![ContentPart::text("initial run")])],
        )
    };
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(subagent_id.clone(), messages.clone());
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), provider.clone());
    let shutdown_inner = service.inner.clone();
    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::CallbackEnqueueBeforeRecord,
        Arc::new(move || {
            shutdown_inner
                .state
                .lock()
                .expect("service state mutex poisoned")
                .state = ServiceState::ShuttingDown;
        }),
    );
    let before_seq = service.inner.last_event_seq();

    terminalize_failed_subagent_run(
        service.inner.clone(),
        subagent_id.clone(),
        "injected subagent failure".to_owned(),
        messages,
    )
    .await;

    assert_eq!(service.status().state, ServiceState::ShuttingDown);
    assert_eq!(provider.calls(), 0);
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.run_state, SubagentRunState::Failed);
    assert!(!service.events_after(before_seq).iter().any(|event| {
        event.event_type == "subagent.started" && event.data["subagent_id"] == subagent_id
    }));
}

#[tokio::test]
async fn subagent_failure_does_not_append_after_shutdown_wins_terminal_boundary() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-failure-shutdown-boundary"),
        Arc::new(TextProvider("unused")),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .spawn("Boundary", "fail at shutdown boundary")
        .expect("spawn subagent");
    let messages = vec![Message::user(vec![ContentPart::text("initial run")])];
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(snapshot.id.clone(), messages.clone());
    let shutdown_inner = service.inner.clone();
    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::TerminalStateBeforeAppend,
        Arc::new(move || {
            shutdown_inner
                .state
                .lock()
                .expect("service state mutex poisoned")
                .state = ServiceState::ShuttingDown;
        }),
    );
    let before_seq = service.inner.last_event_seq();

    terminalize_failed_subagent_run(
        service.inner.clone(),
        snapshot.id.clone(),
        "injected failure".to_owned(),
        messages,
    )
    .await;

    assert_eq!(service.status().state, ServiceState::ShuttingDown);
    assert!(!service.events_after(before_seq).iter().any(|event| {
        event.event_type == "subagent.failed" && event.data["subagent_id"] == snapshot.id
    }));
}

#[tokio::test]
async fn subagent_terminal_failure_event_persistence_error_keeps_failed_context_without_callback() {
    let main_provider = Arc::new(CountingProvider::new());
    let subagent_provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system")
            .with_session("service-subagent-terminal-failure-event-persistence-error"),
        main_provider.clone(),
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
            .spawn("Worker", "fail while persisting terminal event")
            .expect("spawn subagent");
        manager
            .send(&snapshot.id, "queued follow-up")
            .expect("queue follow-up");
        snapshot.id
    };
    let initial_context = vec![Message::user(vec![ContentPart::text("initial context")])];
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(subagent_id.clone(), initial_context);
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), subagent_provider.clone());
    let terminal_messages = vec![Message::user(vec![ContentPart::text(
        "terminal failure context",
    )])];
    let terminal_error = "terminal provider failure".to_owned();
    let before_seq = service.inner.last_event_seq();
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

    terminalize_failed_subagent_run(
        service.inner.clone(),
        subagent_id.clone(),
        terminal_error.clone(),
        terminal_messages.clone(),
    )
    .await;

    let status = service.status();
    assert_eq!(status.state, ServiceState::Failed);
    assert_eq!(status.queue_length, 0);
    assert_eq!(status.last_event_seq, before_seq);
    assert_eq!(main_provider.calls(), 0);
    assert_eq!(subagent_provider.calls(), 0);
    assert_eq!(service.inner.active_service_worker_count(), 0);
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("failed subagent should remain inspectable");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Open);
    assert_eq!(snapshot.run_state, SubagentRunState::Failed);
    assert_eq!(snapshot.latest_result, None);
    assert_eq!(snapshot.latest_error.as_deref(), Some(terminal_error.as_str()));
    assert_eq!(snapshot.queued_message_count, 1);
    assert_eq!(snapshot.queued_messages, vec!["queued follow-up".to_owned()]);
    assert_eq!(snapshot.callback_count, 0);
    assert_eq!(snapshot.pending_callback_count, 0);
    assert_eq!(snapshot.failed_callback_count, 0);
    assert_eq!(
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .get(&subagent_id),
        Some(&terminal_messages)
    );
    assert!(service.events_after(before_seq).is_empty());
}

#[tokio::test]
async fn stale_subagent_failure_cannot_publish_new_run_snapshot_or_duplicate_callback() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-stale-failure-run"),
        Arc::new(TextProvider("callback handled")),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .spawn("Boundary", "old panicking run")
        .expect("spawn subagent");
    let old_messages = vec![Message::user(vec![ContentPart::text("old run")])];
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(snapshot.id.clone(), old_messages.clone());
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(snapshot.id.clone(), provider.clone());
    let old_cancel = Arc::new(CancellationToken::new());
    service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .insert(snapshot.id.clone(), old_cancel.clone());
    let send_result = Arc::new(Mutex::new(None));
    let hook_result = send_result.clone();
    let hook_ran = Arc::new(AtomicBool::new(false));
    let hook_once = hook_ran.clone();
    let send_inner = service.inner.clone();
    let send_subagent_id = snapshot.id.clone();
    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::TerminalStateBeforeAppend,
        Arc::new(move || {
            if hook_once.swap(true, Ordering::SeqCst) {
                return;
            }
            let result = send_inner.send_subagent_tool_result(
                ToolCall::new("send_during_old_failure", "subagent_send", json!({})),
                &send_subagent_id,
                "new run",
            );
            *hook_result.lock().expect("hook result mutex poisoned") = Some(result);
        }),
    );
    let before_seq = service.inner.last_event_seq();

    terminalize_failed_subagent_run_for_current(
        service.inner.clone(),
        snapshot.id.clone(),
        "old run panic".to_owned(),
        old_messages,
        Some(old_cancel),
    )
    .await;
    wait_until(|| provider.calls() == 1).await;
    wait_until(|| {
        service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&snapshot.id)
            .is_some_and(|snapshot| snapshot.run_state == SubagentRunState::Completed)
    })
    .await;

    let send_result = send_result
        .lock()
        .expect("hook result mutex poisoned")
        .clone()
        .expect("send hook should run");
    assert!(!send_result.is_error, "{send_result:?}");
    assert_eq!(send_result.details["status"], json!("queued"));
    let final_snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .expect("subagent should remain available");
    assert_eq!(final_snapshot.run_state, SubagentRunState::Completed);
    assert_eq!(final_snapshot.callback_count, 2);
    assert!(!service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .contains_key(&snapshot.id));
    let events = service.events_after(before_seq);
    let failed = events
        .iter()
        .filter(|event| {
            event.event_type == "subagent.failed" && event.data["subagent_id"] == snapshot.id
        })
        .collect::<Vec<_>>();
    assert_eq!(failed.len(), 1, "{events:?}");
    assert_eq!(failed[0].data["run_state"], json!("failed"));
    assert_eq!(failed[0].data["latest_error"], json!("old run panic"));
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "subagent.callback"
                    && event.data["subagent_id"] == snapshot.id
                    && event.data["callback_kind"] == "failed"
            })
            .count(),
        1,
        "{events:?}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "subagent.callback"
                    && event.data["subagent_id"] == snapshot.id
                    && event.data["callback_kind"] == "completed"
            })
            .count(),
        1,
        "{events:?}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "subagent.started" && event.data["subagent_id"] == snapshot.id
            })
            .count(),
        1,
        "{events:?}"
    );
    let failed_position = events
        .iter()
        .position(|event| {
            event.event_type == "subagent.failed" && event.data["subagent_id"] == snapshot.id
        })
        .expect("failed event should exist");
    let callback_position = events
        .iter()
        .position(|event| {
            event.event_type == "subagent.callback"
                && event.data["subagent_id"] == snapshot.id
                && event.data["callback_kind"] == "failed"
        })
        .expect("failed callback event should exist");
    let next_start_position = events
        .iter()
        .position(|event| {
            event.event_type == "subagent.started" && event.data["subagent_id"] == snapshot.id
        })
        .expect("next started event should exist");
    assert!(
        failed_position < callback_position && callback_position < next_start_position,
        "failed event, failed callback, and next start must remain ordered: \
         failed_position={failed_position}, callback_position={callback_position}, \
         next_start_position={next_start_position}, events={events:?}"
    );
}

#[tokio::test]
async fn subagent_failure_does_not_start_queued_run_after_failed_wins_start_boundary() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-queued-failed-boundary"),
        Arc::new(TextProvider("callback handled")),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let snapshot = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let snapshot = manager
            .spawn("Boundary", "queue before failure")
            .expect("spawn subagent");
        manager
            .send(&snapshot.id, "queued after failure")
            .expect("queue next run");
        snapshot
    };
    let messages = vec![Message::user(vec![ContentPart::text("initial run")])];
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(snapshot.id.clone(), messages.clone());
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(snapshot.id.clone(), provider.clone());
    let failed_inner = service.inner.clone();
    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::QueuedRunProviderClone,
        Arc::new(move || {
            failed_inner
                .state
                .lock()
                .expect("service state mutex poisoned")
                .state = ServiceState::Failed;
        }),
    );
    let before_seq = service.inner.last_event_seq();

    terminalize_failed_subagent_run(
        service.inner.clone(),
        snapshot.id.clone(),
        "injected failure".to_owned(),
        messages,
    )
    .await;
    tokio::task::yield_now().await;

    assert_eq!(service.status().state, ServiceState::Failed);
    assert_eq!(provider.calls(), 0);
    let blocked = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .expect("subagent snapshot");
    assert_eq!(blocked.run_state, SubagentRunState::Failed);
    assert_eq!(blocked.queued_message_count, 1);
    assert!(!service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .contains_key(&snapshot.id));
    assert!(!service.events_after(before_seq).iter().any(|event| {
        event.event_type == "subagent.started" && event.data["subagent_id"] == snapshot.id
    }));

    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::QueuedRunProviderClone,
        Arc::new(|| {}),
    );
    service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .state = ServiceState::Idle;
    maybe_start_next_subagent_run(service.inner.clone(), snapshot.id.clone());
    wait_until(|| provider.calls() == 1).await;
    wait_until(|| {
        service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&snapshot.id)
            .is_some_and(|snapshot| snapshot.run_state == SubagentRunState::Completed)
    })
    .await;
    let recovered = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .expect("subagent snapshot");
    assert_eq!(recovered.queued_message_count, 0);
    assert!(!service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .contains_key(&snapshot.id));
}

#[tokio::test]
async fn main_panic_after_partial_progress_preserves_context_with_and_without_recorder() {
    for with_recorder in [false, true] {
        let provider = Arc::new(PartialProgressThenPanicProvider::new());
        let config = AgentConfig::new("system").with_session(format!(
            "service-main-partial-progress-panic-{with_recorder}"
        ));
        let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(NoopTool)];
        let service = if with_recorder {
            Service::with_initial_context(
                config,
                provider.clone(),
                tools,
                Vec::new(),
                Some(Arc::new(RecordingCompactionRecorder::default())),
            )
            .expect("service construction with recorder should succeed")
        } else {
            Service::new(config, provider.clone(), tools)
                .expect("service construction without recorder should succeed")
        };

        service
            .enqueue(
                format!("initial-{with_recorder}"),
                vec![ContentPart::text("make partial progress")],
            )
            .await
            .expect("initial input should enqueue");
        provider.wait_until_panic_entered().await;
        provider.panic_release.notify_one();
        tokio::time::timeout(
            Duration::from_secs(2),
            service.wait_for_state(ServiceState::Failed),
        )
        .await
        .expect("provider panic should fail the service");

        service
            .enqueue(
                format!("recovery-{with_recorder}"),
                vec![ContentPart::text("continue after panic")],
            )
            .await
            .expect("user input should recover the failed service");
        let request =
            tokio::time::timeout(Duration::from_secs(2), provider.wait_for_queued_request())
                .await
                .expect("recovery run should reach the provider");
        let transcript = request.transcript_messages();
        let user_texts = transcript
            .iter()
            .filter_map(|message| match message {
                Message::User { content } => Some(callback_text(content)),
                Message::Assistant { .. } | Message::ToolResult(_) => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            user_texts,
            vec!["make partial progress", "continue after panic"],
            "main recovery duplicated user context with_recorder={with_recorder}"
        );
        assert!(
            transcript.iter().any(|message| matches!(
                message,
                Message::Assistant { tool_calls, .. }
                    if tool_calls.iter().any(|call| call.id == "call_partial_progress")
            )),
            "main recovery lost assistant progress with_recorder={with_recorder}: {transcript:?}"
        );
        assert!(
            transcript.iter().any(|message| matches!(
                message,
                Message::ToolResult(result)
                    if result.tool_call_id == "call_partial_progress"
            )),
            "main recovery lost tool progress with_recorder={with_recorder}: {transcript:?}"
        );
    }
}

#[tokio::test]
async fn main_partial_progress_before_panic_replays_from_real_session() {
    let home = service_test_home("main-partial-progress-panic-restart");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let provider = Arc::new(PartialProgressThenPanicProvider::new());
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        vec![Arc::new(NoopTool) as Arc<dyn Tool>],
        opened.replay(),
        Some(opened.recorder()),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service
        .enqueue(
            "partial-before-restart",
            vec![ContentPart::text("persist partial progress")],
        )
        .await
        .expect("input should enqueue");
    provider.wait_until_panic_entered().await;
    provider.panic_release.notify_one();
    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("provider panic should fail the service");
    wait_until(|| service.inner.active_service_worker_count() == 0).await;
    drop(service);
    drop(opened);

    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay");
    let messages = replayed.initial_messages();
    assert!(messages.iter().any(|message| matches!(
        message,
        Message::User { content }
            if callback_text(content) == "persist partial progress"
    )));
    assert!(messages.iter().any(|message| matches!(
        message,
        Message::Assistant { tool_calls, .. }
            if tool_calls.iter().any(|call| call.id == "call_partial_progress")
    )));
    assert!(messages.iter().any(|message| matches!(
        message,
        Message::ToolResult(result) if result.tool_call_id == "call_partial_progress"
    )));
}
