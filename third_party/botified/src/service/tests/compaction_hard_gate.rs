#[tokio::test]
async fn service_compaction_slow_provider_does_not_block_user_turn() {
    let provider = Arc::new(CompactTestProvider::blocked_soft(
        vec![Ok(ProviderResponse::text("first done"))],
        vec![Ok(ProviderResponse::text("summary ready"))],
    ));
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        compact_old_context(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", soft_compact_trigger_content("first"))
        .await
        .expect("enqueue should succeed");
    wait_until(|| provider.compact_requests().len() == 1).await;
    wait_for_service_idle(&service).await;

    assert_eq!(service.status().state, ServiceState::Idle);
    assert_eq!(
        provider.main_requests().len(),
        1,
        "slow background compaction must not block the user provider turn"
    );
    assert_eq!(provider.compact_requests().len(), 1);
    assert_eq!(provider.active_compactions(), 1);
    let compact_request = provider
        .compact_requests()
        .pop()
        .expect("compact request should be recorded");
    assert_eq!(
        compact_request
            .profiling_context()
            .expect("compaction request should be profiled")
            .request_kind
            .as_str(),
        "compaction"
    );
    assert!(
        compact_request.preview_context().is_none(),
        "background compaction must not stream text preview"
    );

    provider.release_compactions();
    wait_until(|| provider.active_compactions() == 0).await;
}

#[tokio::test]
async fn service_compaction_uncommitted_background_run_leaves_no_session_half_product() {
    let home = service_test_home("compact-uncommitted-restart");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let old_context = compact_old_context();
    session
        .recorder()
        .record_user_batch_with_ids_sync(&old_context[0..1], &["old_msg".to_owned()])
        .expect("old user should persist");
    session
        .recorder()
        .record_message_sync(&old_context[1])
        .expect("old assistant should persist");
    drop(session);

    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should reopen");
    let provider = Arc::new(CompactTestProvider::blocked_soft(
        vec![Ok(ProviderResponse::text("first done"))],
        vec![Ok(ProviderResponse::text("summary ready"))],
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        opened.replay(),
        Some(opened.recorder()),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", soft_compact_trigger_content("first"))
        .await
        .expect("first enqueue should succeed");
    wait_until(|| provider.compact_requests().len() == 1).await;
    wait_for_service_idle(&service).await;

    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay without uncommitted compaction");
    assert!(
        !replayed.initial_messages().iter().any(|message| {
            matches!(message, Message::User { content } if content.iter().any(|part| {
                matches!(part, ContentPart::Text { text } if text.contains("Compaction summary"))
            }))
        }),
        "uncommitted background compaction must not leave a replayable partial summary"
    );

    provider.release_compactions();
    wait_until(|| provider.active_compactions() == 0).await;
}

#[tokio::test]
async fn service_compaction_commits_summary_tail_and_run_start_messages_at_next_safe_point() {
    let provider = Arc::new(CompactTestProvider::soft(
        vec![
            Ok(ProviderResponse::text("first done")),
            Ok(ProviderResponse::text("second done")),
        ],
        vec![Ok(ProviderResponse::text("summary ready"))],
    ));
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        compact_old_context(),
        None,
    )
    .expect("service construction should succeed");
    let first_content = soft_compact_trigger_content("first");

    service
        .enqueue("msg_1", first_content.clone())
        .await
        .expect("first enqueue should succeed");
    wait_for_service_idle(&service).await;
    wait_until(|| provider.active_compactions() == 0).await;

    service
        .enqueue("msg_2", vec![ContentPart::text("second")])
        .await
        .expect("second enqueue should succeed");
    wait_for_service_idle(&service).await;

    let main_requests = provider.main_requests();
    assert_eq!(main_requests.len(), 2);
    assert_eq!(
        main_requests[1].transcript_messages(),
        vec![
            crate::compact::summary_message("summary ready"),
            Message::user(first_content),
            Message::assistant_text("first done"),
            Message::user(vec![ContentPart::text("second")]),
        ]
    );
    assert!(service
        .events_after(0)
        .iter()
        .any(|event| event.event_type == "compact.completed"));
}

#[test]
fn successful_hard_compaction_key_distinguishes_same_length_prefix_changes() {
    let successful_key = HardCompactFailureKey {
        provider_profile: "default".to_owned(),
        provider_name: Some("test".to_owned()),
        provider_model: Some("model".to_owned()),
        target_usable_tokens: 1_024,
        retained_start: 2,
        start_len: 4,
        prefix_hash: 11,
    };
    let slot = CompactSlot::Idle {
        suppressed_start_len: None,
        last_successful_hard_key: Some(successful_key.clone()),
    };

    assert!(successful_hard_compaction_made_no_progress(
        &slot,
        &successful_key
    ));
    let mut changed_prefix = successful_key;
    changed_prefix.prefix_hash = 12;
    assert!(
        !successful_hard_compaction_made_no_progress(&slot, &changed_prefix),
        "same-length history with a different compacted prefix must be allowed to compact"
    );
}

#[test]
fn terminal_local_recovery_suppression_tracks_transcript_route_and_window() {
    let coordinator = CompactCoordinator::default();
    let metadata = ProviderMetadata::new("default")
        .with_name("test")
        .with_model("model-a");
    let messages = vec![Message::user(vec![ContentPart::text("recovered")])];
    let key = terminal_local_recovery_key(&messages, Some(&metadata), 1_024);
    coordinator.suppress_terminal_local_recovery(key.clone());

    assert!(coordinator.terminal_local_recovery_suppresses(&key));

    let mut appended = messages.clone();
    appended.push(Message::user(vec![ContentPart::text("new input")]));
    assert!(
        !coordinator.terminal_local_recovery_suppresses(&terminal_local_recovery_key(
            &appended,
            Some(&metadata),
            1_024
        ))
    );

    let changed_prefix = vec![Message::user(vec![ContentPart::text("other prefix")])];
    assert!(
        !coordinator.terminal_local_recovery_suppresses(&terminal_local_recovery_key(
            &changed_prefix,
            Some(&metadata),
            1_024
        ))
    );

    let mut changed_model = metadata.clone();
    changed_model.model = Some("model-b".to_owned());
    assert!(
        !coordinator.terminal_local_recovery_suppresses(&terminal_local_recovery_key(
            &messages,
            Some(&changed_model),
            1_024
        ))
    );
    assert!(
        !coordinator.terminal_local_recovery_suppresses(&terminal_local_recovery_key(
            &messages,
            Some(&metadata),
            2_048
        ))
    );
}

#[tokio::test]
async fn main_compaction_provider_panic_completes_slot_and_releases_worker() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-main-compaction-panic"),
        Arc::new(PanicOnceCompactionProvider::new()),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let run_id = 41;
    *service
        .inner
        .compact
        .slot
        .lock()
        .expect("compact slot mutex poisoned") = CompactSlot::Running {
        run_id,
        messages_at_start: Vec::new(),
        retained_start: 0,
        start_len: 0,
        cancel: CancellationToken::new(),
        hard_failure_key: None,
        hard_failure_count_at_start: 0,
    };

    let notified = service.inner.notify.notified();
    spawn_compaction_provider_call(
        service.inner.clone(),
        run_id,
        Vec::new(),
        CancellationToken::new(),
    );
    tokio::time::timeout(Duration::from_secs(1), notified)
        .await
        .expect("compaction panic should notify gate waiters");
    wait_until(|| service.inner.active_service_worker_count() == 0).await;

    let slot = service
        .inner
        .compact
        .slot
        .lock()
        .expect("compact slot mutex poisoned");
    assert!(matches!(
        &*slot,
        CompactSlot::Completed {
            run_id: completed_id,
            summary_result: Err(error),
            ..
        } if *completed_id == run_id && error.contains("compaction provider worker panicked")
    ));
    assert_eq!(service.status().state, ServiceState::Idle);
}

#[tokio::test]
async fn subagent_compaction_provider_panic_completes_slot_and_releases_worker() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-compaction-panic"),
        Arc::new(TextProvider("unused")),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let hook = SubagentCompactionHook::new(
        Arc::downgrade(&service.inner),
        "panic-compaction-subagent".to_owned(),
        AgentConfig::new("subagent system"),
        Arc::new(PanicOnceCompactionProvider::new()),
        None,
        CancellationToken::new(),
    );
    let run_id = 42;
    *hook
        .runtime
        .compact
        .slot
        .lock()
        .expect("subagent compact slot mutex poisoned") = CompactSlot::Running {
        run_id,
        messages_at_start: Vec::new(),
        retained_start: 0,
        start_len: 0,
        cancel: CancellationToken::new(),
        hard_failure_key: None,
        hard_failure_count_at_start: 0,
    };

    let notified = hook.runtime.notify.notified();
    hook.runtime.clone().spawn_compaction_provider_call(
        run_id,
        Vec::new(),
        CancellationToken::new(),
    );
    tokio::time::timeout(Duration::from_secs(1), notified)
        .await
        .expect("subagent compaction panic should notify gate waiters");
    wait_until(|| service.inner.active_service_worker_count() == 0).await;

    let slot = hook
        .runtime
        .compact
        .slot
        .lock()
        .expect("subagent compact slot mutex poisoned");
    assert!(matches!(
        &*slot,
        CompactSlot::Completed {
            run_id: completed_id,
            summary_result: Err(error),
            ..
        } if *completed_id == run_id && error.contains("compaction provider worker panicked")
    ));
    assert_eq!(service.status().state, ServiceState::Idle);
}

#[tokio::test]
async fn hard_gate_retries_after_compaction_provider_panic() {
    let provider = Arc::new(PanicOnceCompactionProvider::new());
    let service = Service::with_initial_context(
        AgentConfig::new("system").with_session("service-hard-gate-compaction-panic"),
        provider.clone(),
        Vec::new(),
        hard_gate_compactable_context(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_for_service_idle(&service).await;

    assert_eq!(provider.compact_attempts.load(Ordering::SeqCst), 2);
    assert_eq!(provider.inner.main_requests().len(), 1);
    assert_eq!(service.status().state, ServiceState::Idle);
    assert!(service
        .events_after(0)
        .iter()
        .any(|event| event.event_type == "compact.failed"));
}

#[tokio::test]
async fn service_hard_gate_starts_compaction_and_resumes_after_commit() {
    let mut provider = CompactTestProvider::blocked(
        vec![
            Ok(ProviderResponse::text("after compact")),
            Ok(ProviderResponse::text("urgent after pause")),
        ],
        vec![Ok(ProviderResponse::text("summary ready from hard gate"))],
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        hard_gate_compactable_context(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_until(|| provider.compact_requests().len() == 1).await;

    assert_eq!(
        provider.main_requests().len(),
        0,
        "hard gate must pause the agent-turn provider call"
    );
    let status_data = {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        service.inner.service_status_data_from_locked(&state).0
    };
    assert_eq!(
        status_data["context_maintenance"]["provider_calls_paused"],
        json!(true)
    );
    assert!(
        status_data["context_maintenance"]
            .get("hard_stop_tokens")
            .is_none(),
        "service status must not expose compact policy hard thresholds"
    );
    assert!(
        status_data["context_maintenance"]
            .get("observed_input_tokens")
            .is_none(),
        "service status should stay low-mindshare and avoid token diagnostics"
    );
    let bootstrap = service.timeline_bootstrap_snapshot();
    let bootstrap_service_maintenance = bootstrap["active_items"]
        .as_array()
        .expect("/v1/state active_items should be an array")
        .iter()
        .find(|item| item["id"] == json!("service"))
        .and_then(|item| item["data"].get("context_maintenance"))
        .expect("/v1/state service active item should include context maintenance");
    assert_eq!(
        bootstrap_service_maintenance["summary"],
        json!("History is being shortened before continuing.")
    );
    assert!(
        bootstrap_service_maintenance
            .get("hard_stop_tokens")
            .is_none(),
        "/v1/state must not expose compact policy hard thresholds"
    );
    assert!(
        bootstrap_service_maintenance
            .get("observed_input_tokens")
            .is_none(),
        "/v1/state must not expose token diagnostics"
    );

    service
        .enqueue_with_urgency(
            "msg_urgent_during_pause",
            vec![ContentPart::text("urgent while maintenance paused")],
            InputUrgency::Urgent,
        )
        .await
        .expect("urgent enqueue should be accepted while maintenance is paused");
    assert_eq!(
        provider.main_requests().len(),
        0,
        "urgent input must not bypass the hard gate while provider calls are paused"
    );

    provider.release_compactions();
    wait_for_service_idle(&service).await;

    assert_eq!(
        provider.compact_requests().len(),
        1,
        "a successful hard-gate compaction that makes no progress must recover without calling the compact provider again"
    );
    let main_requests = provider.main_requests();
    assert!(!main_requests.is_empty());
    let main_messages = provider.main_requests()[0].transcript_messages();
    assert!(matches!(
        &main_messages[0],
        Message::User { content }
            if content.iter().any(|part| {
                matches!(
                    part,
                    ContentPart::Text { text }
                        if text.contains("Compaction summary:\nsummary ready from hard gate")
                )
            })
    ));
    assert!(service
        .events_after(0)
        .iter()
        .any(|event| event.event_type == "compact.completed"));
    let status_data = {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        service.inner.service_status_data_from_locked(&state).0
    };
    assert_eq!(
        status_data["context_maintenance"]["provider_calls_paused"],
        json!(false)
    );
    assert_eq!(service.status().queue_length, 0);
    let urgent_rendered = format!(
        "{:?}",
        main_requests
            .iter()
            .flat_map(|request| request.transcript_messages())
            .collect::<Vec<_>>()
    );
    assert!(
        urgent_rendered.contains("urgent while maintenance paused"),
        "queued urgent input should drain after maintenance completes"
    );
}

#[tokio::test]
async fn service_hard_gate_regular_notify_does_not_drain_inputs_before_compact_finishes() {
    let mut provider = CompactTestProvider::blocked(
        vec![Ok(ProviderResponse::text("after compact"))],
        vec![Ok(ProviderResponse::text("summary ready from hard gate"))],
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        hard_gate_compactable_context(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_until(|| provider.compact_requests().len() == 1).await;

    service
        .enqueue(
            "msg_normal_during_pause",
            vec![ContentPart::text("normal queued")],
        )
        .await
        .expect("normal enqueue should be accepted while paused");
    service
        .enqueue_with_urgency(
            "msg_urgent_during_pause",
            vec![ContentPart::text("urgent queued")],
            InputUrgency::Urgent,
        )
        .await
        .expect("urgent enqueue should be accepted while paused");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_pause_ask", "bash", "{}"));
    let start_cancel = service
        .inner
        .handle_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "ask_during_pause".to_owned(),
                request: "ask queued while compact runs".to_owned(),
                expect: Some("answer".to_owned()),
                timeout: Some(Duration::from_secs(5)),
                urgency: InputUrgency::Normal,
            },
        )
        .await;
    assert!(
        start_cancel.is_none(),
        "paused running turn should not start a second agent loop"
    );

    service
        .inner
        .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(10));

    assert_eq!(
        service.status().queue_length,
        3,
        "normal, urgent, and expired task ask inputs must remain queued until compact finishes"
    );
    assert_eq!(
        provider.main_requests().len(),
        0,
        "hard gate must still block provider calls while compact is running"
    );
    let request = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain")
        .requests
        .into_iter()
        .find(|request| request.request_id == "ask_during_pause")
        .expect("task ask should exist");
    assert_eq!(
        request.state,
        TaskRequestState::Expired,
        "task ask expiry must not let the paused agent loop drain the queued ask"
    );

    provider.release_compactions();
    wait_until(|| provider.main_requests().len() == 1).await;

    assert_eq!(service.status().queue_length, 0);
    let rendered = format!("{:?}", provider.main_requests()[0].transcript_messages());
    assert!(rendered.contains("normal queued"));
    assert!(rendered.contains("urgent queued"));
    assert!(
        !rendered.contains("ask queued while compact runs"),
        "expired task ask should be removed as stale after compact completes"
    );
}

#[tokio::test]
async fn service_compaction_hard_gate_queues_task_and_subagent_callbacks_until_compact_finishes() {
    let mut provider = CompactTestProvider::blocked(
        vec![Ok(ProviderResponse::text("after compact callbacks"))],
        vec![
            Ok(ProviderResponse::text("summary ready from hard gate")),
            Ok(ProviderResponse::text("summary ready from hard gate")),
        ],
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let hard_stop_tokens =
        crate::compact::CompactPolicy::from_provider_metadata(&provider.metadata)
            .limits()
            .hard_stop_tokens;
    let mut initial_context = hard_gate_compactable_context();
    let retained_target_tokens = hard_stop_tokens.saturating_add(256);
    let retained_tokens = crate::compact::estimate_message_tokens(&initial_context[1]);
    let padding_chars = retained_target_tokens
        .saturating_sub(retained_tokens)
        .saturating_mul(3);
    let Message::Assistant {
        content: Some(content),
        ..
    } = &mut initial_context[1]
    else {
        panic!("hard-gate fixture should retain an assistant message");
    };
    content.push_str(&"p".repeat(padding_chars));
    assert!(
        crate::compact::estimate_message_tokens(&initial_context[1]) >= retained_target_tokens,
        "retained fixture must independently exceed the hard stop"
    );
    let provider = Arc::new(provider);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        initial_context,
        None,
    )
    .expect("service construction should succeed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    let task_id = "task_hard_gate_callback".to_owned();
    let tool_call = ToolCall::new("call_hard_gate_callback", "bash", json!({}));
    assert!(host.publish_task(
        task_id.clone(),
        NewBackgroundTask::new(tool_call.id.clone(), tool_call.name.clone(), "{}"),
    ));
    let subagent_snapshot = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let running = manager
            .spawn("CallbackWorker", "finish while hard gate is paused")
            .expect("spawn subagent");
        manager
            .complete(&running.id, "subagent result ready")
            .expect("complete subagent")
    };

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_until(|| provider.compact_requests().len() == 1).await;
    assert_eq!(
        provider.main_requests().len(),
        0,
        "hard gate must pause the main provider call before callbacks arrive"
    );

    host.finish_task(
        task_id.clone(),
        tool_call.clone(),
        DetachedToolResult {
            tool_result: ToolResult::success(
                tool_call.id.clone(),
                tool_call.name.clone(),
                "background final output",
            ),
            state: TaskState::Completed,
        },
    )
    .await;
    enqueue_subagent_callback(service.inner.clone(), &subagent_snapshot, "completed").await;
    tokio::task::yield_now().await;

    assert_eq!(
        provider.main_requests().len(),
        0,
        "callback notifications must not bypass the hard gate"
    );
    assert_eq!(
        service.status().queue_length,
        2,
        "task and subagent callbacks should remain queued while compact runs"
    );
    let task = service
        .inner
        .background_tasks
        .get(&task_id)
        .expect("task should remain visible");
    assert_eq!(task.callback_delivery, CallbackDelivery::Enqueued);
    let subagent_during_pause = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_snapshot.id)
        .expect("subagent snapshot should remain visible");
    assert_eq!(subagent_during_pause.pending_callback_count, 1);
    let events = service.events_after(0);
    assert!(
        events
            .iter()
            .any(|event| event.event_type == "task.callback_queued"),
        "task callback should be durably queued before compact completes: {events:?}"
    );
    assert!(
        events.iter().any(|event| {
            event.event_type == "subagent.callback"
                && event.data["callback_status"] == json!("pending")
        }),
        "subagent callback should be durably queued before compact completes: {events:?}"
    );

    provider.release_compactions();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let task_failed = service
                .inner
                .background_tasks
                .get(&task_id)
                .is_some_and(|task| task.callback_delivery == CallbackDelivery::Failed);
            let subagent_failed = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned")
                .snapshot(&subagent_snapshot.id)
                .is_some_and(|snapshot| {
                    snapshot.pending_callback_count == 0
                        && snapshot.failed_callback_count == 1
                        && snapshot
                            .callbacks
                            .iter()
                            .all(|callback| callback.status == SubagentCallbackStatus::Failed)
                });
            if provider.compact_requests().len() == 2 && task_failed && subagent_failed {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("compact_no_progress should fail task and subagent callbacks terminally");
    assert_eq!(
        provider.compact_requests().len(),
        2,
        "the repeated fixed summary must reach compact_no_progress without a third compact provider call"
    );
    assert_eq!(provider.main_requests().len(), 0);
    let task = service
        .inner
        .background_tasks
        .get(&task_id)
        .expect("task should remain visible after drain");
    assert_eq!(task.callback_delivery, CallbackDelivery::Failed);
    let subagent_after_drain = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_snapshot.id)
        .expect("subagent snapshot should remain visible after drain");
    assert_eq!(subagent_after_drain.callback_count, 1);
    assert_eq!(subagent_after_drain.pending_callback_count, 0);
    assert_eq!(subagent_after_drain.failed_callback_count, 1);
    let subagent_callback = subagent_after_drain
        .callbacks
        .first()
        .expect("subagent callback should remain visible after drain");
    assert_eq!(subagent_callback.status, SubagentCallbackStatus::Failed);
    let events = service.events_after(0);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "task.callback_failed")
            .count(),
        1,
        "task callback terminal failure must remain exactly once"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "subagent.callback"
                    && event.data["callback_status"] == json!("pending")
            })
            .count(),
        1,
        "subagent callback pending event must remain exactly once"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "subagent.callback"
                    && event.data["callback_status"] == json!("failed")
            })
            .count(),
        1,
        "subagent callback terminal failure must remain exactly once"
    );
    assert!(
        events
            .iter()
            .filter(|event| event.event_type == "task.callback_delivered")
            .count()
            <= 1
    );
    assert!(
        events
            .iter()
            .filter(|event| event.event_type == "subagent.callback_delivered")
            .count()
            <= 1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "compact.completed"
                    && event.data["reason"] == json!("compact_no_progress")
            })
            .count(),
        1,
        "two identical summaries must terminate through compact_no_progress"
    );
}

#[tokio::test]
async fn subagent_hard_gate_compacts_branch_locally_without_main_session_or_timeline() {
    let mut subagent_provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("subagent after compact"))],
        vec![Ok(ProviderResponse::text("subagent summary"))],
    );
    set_compact_test_metadata(&mut subagent_provider, 8_192, 1_024);
    let subagent_provider = Arc::new(subagent_provider);
    let recorder = Arc::new(RecordingCompactionRecorder::default());
    let service = Service::with_initial_context(
        AgentConfig::new("system").with_session("service-subagent-compact-isolated"),
        Arc::new(TextProvider("main callback observed")),
        Vec::new(),
        Vec::new(),
        Some(recorder.clone()),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .spawn("Worker", "large inherited context")
        .expect("spawn subagent")
        .id;
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), subagent_provider.clone());
    let mut initial_messages = hard_gate_compactable_context();
    initial_messages.push(Message::user(vec![ContentPart::text(
        "current subagent task",
    )]));
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(subagent_id.clone(), initial_messages.clone());
    let before_seq = service.inner.last_event_seq();

    run_subagent_loop(
        service.inner.clone(),
        subagent_id.clone(),
        service.inner.subagent_config(),
        initial_messages,
        subagent_provider.clone(),
        Vec::new(),
        CancellationToken::new(),
    )
    .await;
    wait_for_service_idle(&service).await;

    assert_eq!(subagent_provider.compact_requests().len(), 1);
    assert_eq!(subagent_provider.main_requests().len(), 1);
    let subagent_request_messages = subagent_provider.main_requests()[0].transcript_messages();
    assert!(matches!(
        &subagent_request_messages[0],
        Message::User { content }
            if content.iter().any(|part| {
                matches!(
                    part,
                    ContentPart::Text { text }
                        if text.contains("Compaction summary:\nsubagent summary")
                )
            })
    ));
    assert!(
        recorder.compactions().is_empty(),
        "subagent compaction must not write the main session recorder"
    );
    let events = service.events_after(before_seq);
    assert!(events
        .iter()
        .any(|event| event.event_type == "subagent.completed"));
    assert!(
        !events
            .iter()
            .any(|event| event.event_type.starts_with("compact.")),
        "subagent internal compaction must not be written to the main timeline: {events:?}"
    );
    let stored_context = service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .get(&subagent_id)
        .cloned()
        .expect("subagent context should be retained");
    assert!(matches!(
        &stored_context[0],
        Message::User { content }
            if content.iter().any(|part| {
                matches!(
                    part,
                    ContentPart::Text { text }
                        if text.contains("Compaction summary:\nsubagent summary")
                )
            })
    ));
}

#[tokio::test]
async fn subagent_compact_failure_uses_branch_recovery_without_failing_main_service() {
    let mut subagent_provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("subagent after recovery"))],
        vec![
            Err(ProviderError::request_failed("subagent summary failed 1")),
            Err(ProviderError::request_failed("subagent summary failed 2")),
            Err(ProviderError::request_failed("subagent summary failed 3")),
        ],
    );
    set_compact_test_metadata(&mut subagent_provider, 8_192, 1_024);
    let subagent_provider = Arc::new(subagent_provider);
    let recorder = Arc::new(RecordingCompactionRecorder::default());
    let service = Service::with_initial_context(
        AgentConfig::new("system").with_session("service-subagent-compact-failure"),
        Arc::new(TextProvider("main callback observed")),
        Vec::new(),
        Vec::new(),
        Some(recorder.clone()),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .spawn("Worker", "large inherited context")
        .expect("spawn subagent")
        .id;
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), subagent_provider.clone());
    let mut initial_messages = hard_gate_compactable_context();
    initial_messages.push(Message::user(vec![ContentPart::text(
        "current subagent task",
    )]));
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(subagent_id.clone(), initial_messages.clone());
    let before_seq = service.inner.last_event_seq();

    run_subagent_loop(
        service.inner.clone(),
        subagent_id.clone(),
        service.inner.subagent_config(),
        initial_messages,
        subagent_provider.clone(),
        Vec::new(),
        CancellationToken::new(),
    )
    .await;
    wait_for_service_idle(&service).await;

    assert_eq!(
        subagent_provider.compact_requests().len(),
        MAX_HARD_COMPACT_FAILURES
    );
    let main_requests = subagent_provider.main_requests();
    assert_eq!(main_requests.len(), 1);
    assert!(has_local_degraded_recovery(
        &main_requests[0].transcript_messages()
    ));
    assert_eq!(service.status().state, ServiceState::Idle);
    assert!(
        recorder.compactions().is_empty(),
        "subagent recovery must not write the main session recorder"
    );
    let events = service.events_after(before_seq);
    assert!(events
        .iter()
        .any(|event| event.event_type == "subagent.completed"));
    assert!(
        !events
            .iter()
            .any(|event| event.event_type.starts_with("compact.")),
        "subagent compact failure diagnostics must stay off the main timeline: {events:?}"
    );
}

#[tokio::test]
async fn service_compaction_policy_uses_tool_capable_provider_metadata() {
    let text_provider = Arc::new(CompactTestProvider::new(
        Vec::new(),
        vec![Ok(ProviderResponse::text("summary ready"))],
    ));
    let tool_provider = Arc::new(CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("tool endpoint done"))],
        Vec::new(),
    ));
    let provider = Arc::new(crate::provider::router::ProviderRouter::new(vec![
        crate::provider::router::ProviderEndpoint::new(
            "text-large",
            0,
            [crate::provider::router::ProviderCapability::Text],
            text_provider.clone(),
        )
        .with_context_window_tokens(3_000_000)
        .with_max_output_tokens(20_000),
        crate::provider::router::ProviderEndpoint::new(
            "tools-small",
            1,
            [
                crate::provider::router::ProviderCapability::Text,
                crate::provider::router::ProviderCapability::ToolCalls,
            ],
            tool_provider.clone(),
        )
        .with_context_window_tokens(500_000)
        .with_max_output_tokens(20_000),
    ]));
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider,
        vec![Arc::new(NoopTool)],
        hard_gate_compact_request_text_route_context(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_for_service_idle(&service).await;

    assert_eq!(
        tool_provider.main_requests().len(),
        1,
        "real agent request should route to the tool-capable endpoint"
    );
    assert_eq!(
        text_provider.compact_requests().len(),
        1,
        "compaction should be planned from the tool-capable endpoint metadata, not the empty text-only request metadata"
    );
    assert!(
        !tool_provider.main_requests()[0].tools.is_empty(),
        "real agent request should carry tool specs that drive provider routing"
    );
}

#[tokio::test]
async fn service_hard_gate_uses_final_tool_request_metadata_not_text_fallback() {
    let text_provider = Arc::new(CompactTestProvider::blocked(
        Vec::new(),
        vec![Ok(ProviderResponse::text("tool route summary"))],
    ));
    let tool_provider = Arc::new(CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("tool endpoint done"))],
        Vec::new(),
    ));
    let provider = Arc::new(crate::provider::router::ProviderRouter::new(vec![
        crate::provider::router::ProviderEndpoint::new(
            "text-large",
            0,
            [crate::provider::router::ProviderCapability::Text],
            text_provider.clone(),
        )
        .with_context_window_tokens(3_000_000)
        .with_max_output_tokens(20_000),
        crate::provider::router::ProviderEndpoint::new(
            "tools-small",
            1,
            [
                crate::provider::router::ProviderCapability::Text,
                crate::provider::router::ProviderCapability::ToolCalls,
            ],
            tool_provider.clone(),
        )
        .with_context_window_tokens(500_000)
        .with_max_output_tokens(20_000),
    ]));
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider,
        vec![Arc::new(NoopTool)],
        hard_gate_compact_request_text_route_context(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_until(|| text_provider.compact_requests().len() == 1).await;

    assert_eq!(
        tool_provider.main_requests().len(),
        0,
        "tool-capable small-window metadata from the final request must pause the provider call"
    );
    assert_eq!(
        text_provider.compact_requests().len(),
        1,
        "compaction itself can still route to the text endpoint"
    );

    text_provider.release_compactions();
    wait_for_service_idle(&service).await;

    assert_eq!(tool_provider.main_requests().len(), 1);
    assert!(
        !tool_provider.main_requests()[0].tools.is_empty(),
        "resumed provider call should still use the final tool-bearing request"
    );
}

#[tokio::test]
async fn service_compact_request_hard_gate_uses_compact_route_metadata() {
    let text_provider = Arc::new(CompactTestProvider::new(
        Vec::new(),
        vec![Ok(ProviderResponse::text("text route summary"))],
    ));
    let tool_provider = Arc::new(CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("tool endpoint done"))],
        Vec::new(),
    ));
    let provider = Arc::new(crate::provider::router::ProviderRouter::new(vec![
        crate::provider::router::ProviderEndpoint::new(
            "text-large",
            0,
            [crate::provider::router::ProviderCapability::Text],
            text_provider.clone(),
        )
        .with_context_window_tokens(3_000_000)
        .with_max_output_tokens(20_000),
        crate::provider::router::ProviderEndpoint::new(
            "tools-small",
            1,
            [
                crate::provider::router::ProviderCapability::Text,
                crate::provider::router::ProviderCapability::ToolCalls,
            ],
            tool_provider.clone(),
        )
        .with_context_window_tokens(500_000)
        .with_max_output_tokens(20_000),
    ]));
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider,
        vec![Arc::new(NoopTool)],
        hard_gate_compact_request_text_route_context(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_for_service_idle(&service).await;

    assert_eq!(
        text_provider.compact_requests().len(),
        1,
        "compact request hard-stop check must use the text endpoint selected for the compact request"
    );
    assert_eq!(tool_provider.main_requests().len(), 1);
    let main_messages = tool_provider.main_requests()[0].transcript_messages();
    assert!(
        !has_local_degraded_recovery(&main_messages),
        "compact request that fits its own provider route must not be degraded using the agent turn window"
    );
    assert!(matches!(
        &main_messages[0],
        Message::User { content }
            if content.iter().any(|part| {
                matches!(
                    part,
                    ContentPart::Text { text }
                        if text.contains("Compaction summary:\ntext route summary")
                )
            })
    ));
}

#[tokio::test]
async fn service_hard_gate_uses_degraded_recovery_after_repeated_compact_failures() {
    let mut provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("after degraded recovery"))],
        vec![
            Err(ProviderError::request_failed("summary provider failed 1")),
            Err(ProviderError::request_failed("summary provider failed 2")),
            Err(ProviderError::request_failed("summary provider failed 3")),
        ],
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        hard_gate_compactable_context(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_for_service_idle(&service).await;

    assert_eq!(provider.compact_requests().len(), MAX_HARD_COMPACT_FAILURES);
    let main_requests = provider.main_requests();
    assert_eq!(main_requests.len(), 1);
    assert!(
        has_local_degraded_recovery(&main_requests[0].transcript_messages()),
        "agent provider must only run after degraded recovery rebuilt the request"
    );
    assert!(
        service
            .events_after(0)
            .iter()
            .filter(|event| event.event_type == "compact.failed")
            .count()
            >= MAX_HARD_COMPACT_FAILURES
    );
}

#[tokio::test]
async fn service_hard_gate_compact_request_over_hard_stop_uses_local_recovery_without_provider() {
    let mut provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("after compact request overflow"))],
        vec![Ok(ProviderResponse::text("should not be used"))],
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        hard_gate_compact_request_overflow_context(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_for_service_idle(&service).await;

    assert_eq!(
        provider.compact_requests().len(),
        0,
        "oversized compaction requests must not call the compact provider"
    );
    let main_requests = provider.main_requests();
    assert_eq!(main_requests.len(), 1);
    assert!(has_local_degraded_recovery(
        &main_requests[0].transcript_messages()
    ));
}

#[tokio::test]
async fn service_session_replay_first_provider_request_over_hard_gate_uses_recovery() {
    let mut provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("after replay recovery"))],
        vec![Ok(ProviderResponse::text(
            "should not compact replay overflow",
        ))],
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-replay-hard-gate"),
        provider.clone(),
        Vec::new(),
        SessionReplay {
            initial_context: hard_gate_compact_request_overflow_context(),
            pending_messages: vec![DrainedMessage::new(
                "msg_replayed",
                vec![ContentPart::text("replayed current input")],
            )],
            ..SessionReplay::default()
        },
        None,
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;

    assert_eq!(
        provider.compact_requests().len(),
        0,
        "replayed oversized first request should use local recovery before compact provider"
    );
    let main_requests = provider.main_requests();
    assert_eq!(main_requests.len(), 1);
    let request_messages = main_requests[0].transcript_messages();
    assert!(has_local_degraded_recovery(&request_messages));
    assert!(
        format!("{:?}", request_messages).contains("replayed current input"),
        "replayed pending input should remain in the recovered provider request"
    );
}

#[tokio::test]
async fn service_session_replay_restart_boundary_defers_pending_through_tool_followup() {
    let home = service_test_home("restart-boundary-before-pending-input");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let active = Message::user(vec![ContentPart::text(
        "active user retained after compaction",
    )]);
    opened
        .recorder()
        .record_user_batch_with_ids_sync(std::slice::from_ref(&active), &["msg_active".to_owned()])
        .expect("active user should persist");
    opened
        .recorder()
        .record_compaction_with_active_user_message_id_sync(
            &[ContentPart::text("Compaction summary:\nrestart")],
            std::slice::from_ref(&active),
            Some("msg_active"),
        )
        .expect("active compaction should persist");
    opened
        .recorder()
        .record_accepted_input_sync(&AcceptedInputEntry {
            message_id: "msg_pending".to_owned(),
            content: vec![ContentPart::text("pending user after restart")],
            cursor_seq: 7,
            source: InputSource::User,
            metadata: None,
            urgency: InputUrgency::Normal,
        })
        .expect("pending input should persist");
    drop(opened);

    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay");
    assert_eq!(replayed.pending_messages().len(), 1);
    assert_eq!(
        replayed
            .restart_boundary()
            .expect("active compaction should replay restart boundary")
            .active_user_message_id(),
        "msg_active"
    );

    let provider = Arc::new(CompactTestProvider::new(
        vec![
            Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
                "call_restart_active",
                "noop",
                json!({}),
            )])),
            Ok(ProviderResponse::text("active handled after tool")),
            Ok(ProviderResponse::text("pending handled")),
        ],
        Vec::new(),
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        vec![Arc::new(NoopTool) as Arc<dyn Tool>],
        replayed.replay(),
        Some(replayed.recorder()),
        replayed.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;

    let main_requests = provider.main_requests();
    assert_eq!(
        main_requests.len(),
        3,
        "pending input should wait until the replayed active request and its tool follow-up complete"
    );
    let first_request = format!("{:?}", main_requests[0].transcript_messages());
    assert!(
        first_request.contains("active user retained after compaction"),
        "first provider request must resume the compacted active user"
    );
    assert!(
        !first_request.contains("pending user after restart"),
        "first provider request must not drain later pending input over the restart boundary"
    );
    assert!(
        !first_request.contains("ToolResult"),
        "first provider request must not contain a tool result before the active tool runs"
    );
    let second_request = format!("{:?}", main_requests[1].transcript_messages());
    assert!(
        second_request.contains("active user retained after compaction"),
        "tool follow-up provider request must still be for the active replayed request"
    );
    assert!(
        second_request.contains("ToolResult") && second_request.contains("ok"),
        "tool follow-up provider request must include the tool result"
    );
    assert!(
        !second_request.contains("pending user after restart"),
        "tool follow-up provider request must not drain later pending input over the restart boundary"
    );
    let third_request = format!("{:?}", main_requests[2].transcript_messages());
    assert!(
        third_request.contains("active handled after tool"),
        "third provider request should start after the replayed active request completes"
    );
    assert!(
        third_request.contains("pending user after restart"),
        "pending input should drain after the active replayed request finishes"
    );
    assert!(
        !first_request.contains("pending user after restart")
            && !second_request.contains("pending user after restart")
            && third_request.contains("pending user after restart"),
        "pending input should first appear in the third provider request"
    );
}

#[tokio::test]
async fn service_session_replay_restart_boundary_survives_provider_retry() {
    let home = service_test_home("restart-boundary-provider-retry-before-pending-input");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let active = Message::user(vec![ContentPart::text(
        "active user retained across provider retry",
    )]);
    opened
        .recorder()
        .record_user_batch_with_ids_sync(std::slice::from_ref(&active), &["msg_active".to_owned()])
        .expect("active user should persist");
    opened
        .recorder()
        .record_compaction_with_active_user_message_id_sync(
            &[ContentPart::text("Compaction summary:\nrestart retry")],
            std::slice::from_ref(&active),
            Some("msg_active"),
        )
        .expect("active compaction should persist");
    opened
        .recorder()
        .record_accepted_input_sync(&AcceptedInputEntry {
            message_id: "msg_pending".to_owned(),
            content: vec![ContentPart::text("pending user after provider retry")],
            cursor_seq: 9,
            source: InputSource::User,
            metadata: None,
            urgency: InputUrgency::Normal,
        })
        .expect("pending input should persist");
    drop(opened);

    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay");
    let provider = Arc::new(CompactTestProvider::new(
        vec![
            Err(ProviderError::request_failed("provider temporarily down")),
            Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
                "call_retry_active",
                "noop",
                json!({}),
            )])),
            Ok(ProviderResponse::text("active handled after retry tool")),
            Ok(ProviderResponse::text("pending handled after retry")),
        ],
        Vec::new(),
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        vec![Arc::new(NoopTool) as Arc<dyn Tool>],
        replayed.replay(),
        Some(replayed.recorder()),
        replayed.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;

    let main_requests = provider.main_requests();
    assert_eq!(
        main_requests.len(),
        4,
        "provider retry must preserve the replayed active request boundary until it completes"
    );
    let first_request = format!("{:?}", main_requests[0].transcript_messages());
    let second_request = format!("{:?}", main_requests[1].transcript_messages());
    let third_request = format!("{:?}", main_requests[2].transcript_messages());
    let fourth_request = format!("{:?}", main_requests[3].transcript_messages());
    for (index, request) in [&first_request, &second_request, &third_request]
        .into_iter()
        .enumerate()
    {
        assert!(
            request.contains("active user retained across provider retry"),
            "request {index} should still process the replayed active input"
        );
        assert!(
            !request.contains("pending user after provider retry"),
            "request {index} must not drain pending input before the replayed active request completes"
        );
    }
    assert!(
        third_request.contains("ToolResult") && third_request.contains("ok"),
        "tool follow-up after provider retry should still contain the active tool result"
    );
    assert!(
        fourth_request.contains("pending user after provider retry"),
        "pending input should drain only after the active replayed request completes"
    );
}

#[tokio::test]
async fn service_session_replay_restart_boundary_survives_provider_stop_retry() {
    let home = service_test_home("restart-boundary-provider-stop-before-pending-input");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let active = Message::user(vec![ContentPart::text(
        "active user retained across provider stop",
    )]);
    opened
        .recorder()
        .record_user_batch_with_ids_sync(std::slice::from_ref(&active), &["msg_active".to_owned()])
        .expect("active user should persist");
    opened
        .recorder()
        .record_compaction_with_active_user_message_id_sync(
            &[ContentPart::text(
                "Compaction summary:\nprovider stop retry",
            )],
            std::slice::from_ref(&active),
            Some("msg_active"),
        )
        .expect("active compaction should persist");
    opened
        .recorder()
        .record_accepted_input_sync(&AcceptedInputEntry {
            message_id: "msg_pending".to_owned(),
            content: vec![ContentPart::text("pending user after provider stop")],
            cursor_seq: 11,
            source: InputSource::User,
            metadata: None,
            urgency: InputUrgency::Normal,
        })
        .expect("pending input should persist");
    drop(opened);

    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay");
    let provider = Arc::new(CompactTestProvider::new(
        vec![
            Ok(ProviderResponse {
                text: None,
                tool_calls: Vec::new(),
                assistant_replay: None,
                usage: None,
                stop_reason: StopReason::ProviderStop,
                metadata: None,
            }),
            Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
                "call_provider_stop_active",
                "noop",
                json!({}),
            )])),
            Ok(ProviderResponse::text(
                "active handled after provider stop tool",
            )),
            Ok(ProviderResponse::text(
                "pending handled after provider stop",
            )),
        ],
        Vec::new(),
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        vec![Arc::new(NoopTool) as Arc<dyn Tool>],
        replayed.replay(),
        Some(replayed.recorder()),
        replayed.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service.start_pending_if_needed().await;
    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("provider_stop should fail without consuming pending input");
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert_eq!(
            state
                .restart_boundary
                .as_ref()
                .map(SessionRestartBoundary::active_user_message_id),
            Some("msg_active"),
            "provider_stop must preserve the active restart boundary for retry"
        );
        assert_eq!(state.input_queue.len(), 1);
    }

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;

    let main_requests = provider.main_requests();
    assert_eq!(
        main_requests.len(),
        4,
        "provider_stop retry must preserve the active request boundary until it completes"
    );
    let retry_request = format!("{:?}", main_requests[1].transcript_messages());
    let tool_followup_request = format!("{:?}", main_requests[2].transcript_messages());
    let pending_request = format!("{:?}", main_requests[3].transcript_messages());
    assert!(retry_request.contains("active user retained across provider stop"));
    assert!(
        !retry_request.contains("pending user after provider stop"),
        "provider_stop retry must not drain pending input over the active boundary"
    );
    assert!(
        tool_followup_request.contains("ToolResult") && tool_followup_request.contains("ok"),
        "active tool follow-up should still run before pending input"
    );
    assert!(
        !tool_followup_request.contains("pending user after provider stop"),
        "pending input must remain deferred through active tool follow-up"
    );
    assert!(
        pending_request.contains("pending user after provider stop"),
        "pending input should drain only after the active request completes"
    );
}

#[tokio::test]
async fn service_session_replay_restart_boundary_survives_cancel_retry() {
    let home = service_test_home("restart-boundary-cancel-retry-before-pending-input");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let active = Message::user(vec![ContentPart::text(
        "active user retained across cancel retry",
    )]);
    opened
        .recorder()
        .record_user_batch_with_ids_sync(std::slice::from_ref(&active), &["msg_active".to_owned()])
        .expect("active user should persist");
    opened
        .recorder()
        .record_compaction_with_active_user_message_id_sync(
            &[ContentPart::text("Compaction summary:\ncancel retry")],
            std::slice::from_ref(&active),
            Some("msg_active"),
        )
        .expect("active compaction should persist");
    opened
        .recorder()
        .record_accepted_input_sync(&AcceptedInputEntry {
            message_id: "msg_pending".to_owned(),
            content: vec![ContentPart::text("pending user after cancel retry")],
            cursor_seq: 10,
            source: InputSource::User,
            metadata: None,
            urgency: InputUrgency::Normal,
        })
        .expect("pending input should persist");
    drop(opened);

    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay");
    let provider = Arc::new(CancelFirstMainProvider::new(
        vec![
            Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
                "call_cancel_active",
                "noop",
                json!({}),
            )])),
            Ok(ProviderResponse::text("active handled after cancel tool")),
            Ok(ProviderResponse::text("pending handled after cancel")),
        ],
        Vec::new(),
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        vec![Arc::new(NoopTool) as Arc<dyn Tool>],
        replayed.replay(),
        Some(replayed.recorder()),
        replayed.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service.start_pending_if_needed().await;
    wait_until(|| provider.main_requests().len() == 1).await;
    service.abort().await;
    wait_for_service_idle(&service).await;

    let main_requests = provider.main_requests();
    assert_eq!(
        main_requests.len(),
        4,
        "cancel retry must preserve the replayed active request boundary until it completes"
    );
    let first_request = format!("{:?}", main_requests[0].transcript_messages());
    let second_request = format!("{:?}", main_requests[1].transcript_messages());
    let third_request = format!("{:?}", main_requests[2].transcript_messages());
    let fourth_request = format!("{:?}", main_requests[3].transcript_messages());
    for (index, request) in [&first_request, &second_request, &third_request]
        .into_iter()
        .enumerate()
    {
        assert!(
            request.contains("active user retained across cancel retry"),
            "request {index} should still process the replayed active input"
        );
        assert!(
            !request.contains("pending user after cancel retry"),
            "request {index} must not drain pending input before the replayed active request completes"
        );
    }
    assert!(
        third_request.contains("ToolResult") && third_request.contains("ok"),
        "tool follow-up after cancel retry should still contain the active tool result"
    );
    assert!(
        fourth_request.contains("pending user after cancel retry"),
        "pending input should drain only after the active replayed request completes"
    );
}

#[tokio::test]
async fn service_hard_gate_after_tool_result_recovers_without_rejecting_original_input() {
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_initial_context_and_pending_messages(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        Vec::new(),
        oversized_active_batch("msg_tool_replacement"),
        None,
    )
    .expect("service construction should succeed");

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;

    assert_eq!(
        provider.main_requests().len(),
        0,
        "oversized active batch must stop before a provider call"
    );
    assert!(
        service.events_after(0).iter().all(|event| {
            event.event_type != "message.rejected"
                || (event.data["message_id"] != json!("msg_tool_replacement_1")
                    && event.data["message_id"] != json!("msg_tool_replacement_2"))
        }),
        "multi-input overflow must not reject one accepted input as isolated"
    );
    let context = service.context_messages();
    let rendered = format!("{context:?}");
    assert!(
        has_local_degraded_recovery(&context),
        "oversized active batch should leave a bounded local recovery transcript"
    );
    assert!(
        !rendered.contains("msg_tool_replacement first active input")
            && !rendered.contains("msg_tool_replacement second active input"),
        "oversized active batch must not remain in the active provider transcript"
    );

    service
        .enqueue(
            "msg_after_tool_overflow",
            vec![ContentPart::text("small after tool overflow")],
        )
        .await
        .expect("follow-up input should enqueue");
    wait_for_service_idle(&service).await;

    let main_requests = provider.main_requests();
    assert_eq!(
        main_requests.len(),
        1,
        "follow-up input should reach the provider after active batch recovery"
    );
    let followup_rendered = format!("{:?}", main_requests[0].transcript_messages());
    assert!(
        followup_rendered.contains("small after tool overflow"),
        "follow-up input should be present in the recovered provider request"
    );
    assert!(
        !followup_rendered.contains("msg_tool_replacement first active input")
            && !followup_rendered.contains("msg_tool_replacement second active input"),
        "follow-up provider request must not replay the oversized active batch"
    );
}
