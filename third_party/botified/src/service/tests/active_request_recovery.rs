#[tokio::test]
async fn service_active_request_recovery_append_failure_fails_closed_and_recovers_after_restart() {
    let home = service_test_home("active-request-too-large-append-failure-restart");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let path = opened.path().to_path_buf();
    let header_bytes = fs::read(&path).expect("session header should read");
    let session_file = SwitchableCompactionFlushFailureSessionFile::from_bytes(header_bytes);
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        path.clone(),
        session_file.clone(),
    ));
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        SessionReplay {
            pending_messages: oversized_active_batch("msg_restart_recovery"),
            ..opened.replay()
        },
        Some(recorder),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service.start_pending_if_needed().await;
    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("service should fail closed when active recovery cannot be persisted");

    assert_eq!(provider.main_requests().len(), 0);
    assert!(session_file.compaction_flush_attempts() > 0);
    assert!(
        session_body_records(&session_file.bytes())
            .iter()
            .all(|record| {
                record["type"] != json!("compaction")
                    || record["metadata"]["reason"]
                        != json!(ACTIVE_REQUEST_TOO_LARGE_FOR_MODEL_WINDOW)
            }),
        "failed active-request compaction append should roll back its session line"
    );
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert_eq!(
            state.pending_recovery_record, None,
            "active-request recovery cannot be safely retried from memory across process restart"
        );
        assert!(
            state
                .last_error
                .as_deref()
                .is_some_and(|error| error.contains(ACTIVE_REQUEST_RECOVERY_APPEND_FAILED)),
            "service should expose the persistence failure instead of continuing volatile"
        );
    }
    drop(service);

    session_file.set_fail_compaction(false);
    fs::write(&path, session_file.bytes()).expect("captured failed session bytes should write");
    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay after failed active-request recovery");
    assert_eq!(
        replayed
            .restart_boundary()
            .expect("unfinished active request should be inferred on replay")
            .active_user_message_id(),
        "msg_restart_recovery_1"
    );
    let replayed_before_recovery = format!("{:?}", replayed.initial_messages());
    assert!(
        replayed_before_recovery.contains("msg_restart_recovery first active input")
            && replayed_before_recovery.contains("msg_restart_recovery second active input"),
        "without a durable compaction record, replay should preserve the original transcript for a later safe recovery"
    );

    let mut restart_provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("after restart recovery"))],
        vec![Ok(ProviderResponse::text("summary after restart"))],
    );
    set_compact_test_metadata(&mut restart_provider, 8_192, 1_024);
    let restart_provider = Arc::new(restart_provider);
    let restarted = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        restart_provider.clone(),
        Vec::new(),
        replayed.replay(),
        Some(replayed.recorder()),
        replayed.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    restarted
        .enqueue(
            "msg_after_restart",
            vec![ContentPart::text("small after active recovery restart")],
        )
        .await
        .expect("follow-up enqueue after restart should succeed");
    wait_for_service_idle(&restarted).await;

    let records = session_body_records(&fs::read(&path).expect("session should read"));
    let compaction_index = records
        .iter()
        .position(|record| record["type"] == json!("compaction"))
        .expect("restart follow-up should persist a compaction before provider retry");
    let followup_user_index = records
        .iter()
        .position(|record| {
            record["type"] == json!("user_message")
                && record["message_id"] == json!("msg_after_restart")
        })
        .expect("follow-up input should be committed as a user message");
    assert!(
        compaction_index < followup_user_index,
        "restarted service should persist compaction before accepting the next user batch: {records:?}"
    );
    let main_requests = restart_provider.main_requests();
    assert_eq!(main_requests.len(), 1);
    let followup_rendered = format!("{:?}", main_requests[0].transcript_messages());
    assert!(followup_rendered.contains("small after active recovery restart"));
    assert!(
        !followup_rendered.contains("msg_restart_recovery first active input")
            && !followup_rendered.contains("msg_restart_recovery second active input"),
        "provider request after restart must not replay the oversized old active request"
    );
    drop(restarted);

    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay after restart recovery");
    let replayed_messages = format!("{:?}", replayed.initial_messages());
    assert!(replayed_messages.contains("small after active recovery restart"));
    assert!(replayed_messages.contains("after restart recovery"));
    assert!(
        !replayed_messages.contains("msg_restart_recovery first active input")
            && !replayed_messages.contains("msg_restart_recovery second active input"),
        "replay after recovered restart must not revive the oversized active request"
    );
}

#[tokio::test]
async fn service_active_request_recovery_append_failure_preserves_boundary_in_memory() {
    let home = service_test_home("active-request-too-large-append-failure-in-memory");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let path = opened.path().to_path_buf();
    let header_bytes = fs::read(&path).expect("session header should read");
    let session_file = SwitchableCompactionFlushFailureSessionFile::from_bytes(header_bytes);
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        path.clone(),
        session_file.clone(),
    ));
    let mut provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("small after in-memory recovery"))],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        SessionReplay {
            pending_messages: oversized_active_batch("msg_memory_recovery"),
            ..opened.replay()
        },
        Some(recorder),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service.start_pending_if_needed().await;
    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("service should fail closed when active recovery cannot be persisted");
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
            Some("msg_memory_recovery_1"),
            "failed active-request recovery should preserve the open request boundary in memory"
        );
    }

    session_file.set_fail_compaction(false);
    service
        .enqueue(
            "msg_after_failure",
            vec![ContentPart::text("small after same-service recovery")],
        )
        .await
        .expect("follow-up enqueue after failed active recovery should succeed");
    wait_for_service_idle(&service).await;

    let main_requests = provider.main_requests();
    assert_eq!(
        main_requests.len(),
        1,
        "same-service recovery should compact the unfinished active request before draining follow-up input"
    );
    let followup_rendered = format!("{:?}", main_requests[0].transcript_messages());
    assert!(
        followup_rendered.contains("small after same-service recovery"),
        "follow-up input should reach provider after active request recovery persists"
    );
    assert!(
        !followup_rendered.contains("msg_memory_recovery first active input")
            && !followup_rendered.contains("msg_memory_recovery second active input"),
        "follow-up provider request must not merge with or replay the oversized unfinished request"
    );
    let records = session_body_records(&session_file.bytes());
    let compaction_index = records
        .iter()
        .position(|record| {
            record["type"] == json!("compaction")
                && record["metadata"]["reason"] == json!(ACTIVE_REQUEST_TOO_LARGE_FOR_MODEL_WINDOW)
        })
        .expect("same-service retry should persist active-request recovery compaction");
    let followup_user_index = records
        .iter()
        .position(|record| {
            record["type"] == json!("user_message")
                && record["message_id"] == json!("msg_after_failure")
        })
        .expect("follow-up input should be committed after recovery");
    assert!(
        compaction_index < followup_user_index,
        "follow-up input must not commit before active-request recovery is durable: {records:?}"
    );
}

#[tokio::test]
async fn service_active_request_recovery_append_failure_does_not_close_out_task_input() {
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        Arc::new(provider),
        Vec::new(),
        Vec::new(),
        Some(Arc::new(RecordingCompactionRecorder::failing_compaction())),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_active_recovery_failed_ask",
            "bash",
            "{}",
        ));
    let ask_id = "ask_active_recovery_append_failed";
    service
        .inner
        .handle_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: ask_id.to_owned(),
                request: "small task ask before failed active recovery".to_owned(),
                expect: Some("short answer".to_owned()),
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        )
        .await;

    let pending_request = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain")
        .requests
        .into_iter()
        .find(|request| request.request_id == ask_id)
        .expect("task ask should exist before recovery");
    assert_eq!(pending_request.state, TaskRequestState::Pending);
    assert!(
        service.context_messages().is_empty(),
        "empty initial context makes the two-input batch current request start at zero"
    );
    assert_eq!(
        service.status().queue_length,
        1,
        "the task ask should be the sole queued input before its peer arrives"
    );

    service
        .enqueue(
            "msg_huge_active_recovery_peer",
            vec![ContentPart::text(format!(
                "huge active recovery peer {}",
                "p".repeat(40_000)
            ))],
        )
        .await
        .expect("peer input should join the pending task ask");
    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("service should fail when active recovery cannot be persisted");
    assert_eq!(
        service.status().last_error.as_deref(),
        Some("persistence failed: active request recovery compaction append failed")
    );

    let request_after_failure = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain after failed recovery")
        .requests
        .into_iter()
        .find(|request| request.request_id == ask_id)
        .expect("task ask should remain after failed recovery");
    assert_eq!(request_after_failure.state, TaskRequestState::Pending);
    assert!(service.events_after(0).iter().all(|event| {
        event.event_type != "task_ask.rejected" || event.data["ask_id"] != json!(ask_id)
    }));
}

#[tokio::test]
async fn service_hard_gate_multi_input_batch_recovers_without_rejecting_inputs() {
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let first_input = format!("first accepted batch input {}", "a".repeat(30_000));
    let second_input = format!("second accepted batch input {}", "b".repeat(30_000));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("multi-input-hard-gate"),
        provider.clone(),
        Vec::new(),
        SessionReplay {
            pending_messages: vec![
                DrainedMessage::new("msg_batch_1", vec![ContentPart::text(first_input.clone())]),
                DrainedMessage::new("msg_batch_2", vec![ContentPart::text(second_input.clone())]),
            ],
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
        provider.main_requests().len(),
        0,
        "oversized multi-input batch must not reach the provider"
    );
    assert!(
        service.events_after(0).iter().all(|event| {
            event.event_type != "message.rejected"
                || (event.data["message_id"] != json!("msg_batch_1")
                    && event.data["message_id"] != json!("msg_batch_2"))
        }),
        "multi-input overflow must not reject one accepted input as if it were isolated"
    );
    let context = service.context_messages();
    let rendered = format!("{context:?}");
    assert!(
        has_local_degraded_recovery(&context),
        "multi-input overflow should leave a bounded local recovery transcript"
    );
    assert!(
        !rendered.contains("first accepted batch input")
            && !rendered.contains("second accepted batch input"),
        "oversized multi-input batch must not remain in the active provider transcript"
    );
    assert_eq!(service.status().queue_length, 0);

    service
        .enqueue(
            "msg_after_batch_overflow",
            vec![ContentPart::text("small after batch overflow")],
        )
        .await
        .expect("follow-up input should enqueue");
    wait_for_service_idle(&service).await;

    let main_requests = provider.main_requests();
    assert_eq!(
        main_requests.len(),
        1,
        "follow-up input should reach the provider after batch recovery"
    );
    let followup_rendered = format!("{:?}", main_requests[0].transcript_messages());
    assert!(
        followup_rendered.contains("small after batch overflow"),
        "follow-up input should be present in the recovered provider request"
    );
    assert!(
        !followup_rendered.contains("first accepted batch input")
            && !followup_rendered.contains("second accepted batch input"),
        "follow-up provider request must not replay the oversized batch"
    );
}

#[tokio::test]
async fn service_active_request_recovery_closes_out_multi_input_task_ask() {
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        Vec::new(),
        None,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_multi_ask", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("running task should accept stdin writer");
    service
        .inner
        .handle_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "ask_in_omitted_batch".to_owned(),
                request: "small task ask body".to_owned(),
                expect: Some("short answer".to_owned()),
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        )
        .await;
    service
        .enqueue(
            "msg_huge_peer",
            vec![ContentPart::text(format!(
                "huge peer input {}",
                "p".repeat(40_000)
            ))],
        )
        .await
        .expect("peer input should join pending batch");

    wait_for_service_idle(&service).await;

    assert_eq!(provider.main_requests().len(), 0);
    assert_eq!(service.status().queue_length, 0);
    let request = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain")
        .requests
        .into_iter()
        .find(|request| request.request_id == "ask_in_omitted_batch")
        .expect("request should be retained");
    assert_eq!(request.state, TaskRequestState::Rejected);
    let stdin_text = stdin.text();
    assert!(stdin_text.contains("\"id\":\"ask_in_omitted_batch\""));
    assert!(stdin_text.contains("\"exception\""));
    assert!(stdin_text.contains(INPUT_TOO_LARGE_FOR_MODEL_WINDOW));
    assert!(service.events_after(0).iter().any(|event| {
        event.event_type == "task_ask.rejected"
            && event.data["ask_id"] == json!("ask_in_omitted_batch")
            && event.data["state"] == json!("rejected")
            && event.data["failure_reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("too large to send"))
    }));
}

#[tokio::test]
async fn service_active_request_recovery_fails_omitted_task_callback() {
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        Vec::new(),
        None,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_omitted_callback",
            "bash",
            "{}",
        ));
    let callback_id = "task_callback_omitted_recovery";
    let callback_content = vec![ContentPart::text("callback body")];
    complete_task_callback_fixture(&service, &task.task_id);
    service
        .inner
        .background_tasks
        .set_callback_pending(&task.task_id, callback_id, callback_content.clone())
        .expect("callback should become pending");
    service
        .inner
        .background_tasks
        .set_callback_enqueued(&task.task_id)
        .expect("callback should become enqueued");
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.input_queue.enqueue(QueuedMessage {
            id: callback_id.to_owned(),
            content: callback_content.clone(),
            source: InputSource::TaskCallback,
            urgency: InputUrgency::Normal,
            metadata: Some(test_task_callback_metadata(&task.task_id)),
            cursor_seq: service.inner.last_event_seq(),
            delivery: None,
        });
        state.input_queue.enqueue(QueuedMessage {
            id: "msg_huge_callback_peer".to_owned(),
            content: vec![ContentPart::text(format!(
                "huge callback peer {}",
                "c".repeat(40_000)
            ))],
            source: InputSource::User,
            urgency: InputUrgency::Normal,
            metadata: None,
            cursor_seq: service.inner.last_event_seq(),
            delivery: None,
        });
    }

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;

    assert_eq!(provider.main_requests().len(), 0);
    assert_eq!(service.status().queue_length, 0);
    let snapshot = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain inspectable");
    assert_eq!(snapshot.callback_delivery, CallbackDelivery::Failed);
    assert!(snapshot
        .callback_failure_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("too large to send")));
    let events = service.events_after(0);
    assert!(events.iter().any(|event| {
        event.event_type == "task.callback_failed"
            && event.data["callback_delivery"] == json!("failed")
    }));
    let delivered_index = events
        .iter()
        .position(|event| event.event_type == "task.callback_delivered");
    let failed_index = events
        .iter()
        .position(|event| event.event_type == "task.callback_failed")
        .expect("omitted callback should have an auditable failed event");
    if let Some(delivered_index) = delivered_index {
        assert!(
            failed_index > delivered_index,
            "omitted callback failure must compensate any prior drain-delivered event"
        );
    }
}

#[tokio::test]
async fn service_active_request_recovery_rejects_omitted_task_tell() {
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        Vec::new(),
        None,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_omitted_tell", "bash", "{}"));
    let tell_id = "tell_in_omitted_batch";
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.input_queue.enqueue(QueuedMessage {
            id: "msg_huge_tell_peer".to_owned(),
            content: vec![ContentPart::text(format!(
                "huge tell peer {}",
                "t".repeat(40_000)
            ))],
            source: InputSource::User,
            urgency: InputUrgency::Normal,
            metadata: None,
            cursor_seq: service.inner.last_event_seq(),
            delivery: None,
        });
        state.input_queue.enqueue(QueuedMessage {
            id: "task_tell_omitted_recovery".to_owned(),
            content: vec![ContentPart::text("task tell body")],
            source: InputSource::TaskTell,
            urgency: InputUrgency::Normal,
            metadata: Some(QueuedInputMetadata::TaskTell {
                task_id: task.task_id.clone(),
                tell_id: tell_id.to_owned(),
            }),
            cursor_seq: service.inner.last_event_seq(),
            delivery: None,
        });
    }

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;

    assert_eq!(provider.main_requests().len(), 0);
    assert_eq!(service.status().queue_length, 0);
    assert!(service.events_after(0).iter().any(|event| {
        event.event_type == "task_tell.rejected"
            && event.data["tell_id"] == json!(tell_id)
            && event.data["error"]["code"] == json!(INPUT_TOO_LARGE_FOR_MODEL_WINDOW)
    }));
}

#[tokio::test]
async fn service_degraded_recovery_records_compaction_metadata() {
    let mut provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("after metadata recovery"))],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let recorder = Arc::new(RecordingCompactionRecorder::default());
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider,
        Vec::new(),
        hard_gate_compact_request_overflow_context(),
        Some(recorder.clone()),
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_for_service_idle(&service).await;

    let compactions = recorder.compactions();
    assert_eq!(compactions.len(), 1);
    let recorded = &compactions[0];
    assert!(recorded
        .summary
        .iter()
        .any(|part| matches!(part, ContentPart::Text { text } if text.contains("Local degraded recovery summary"))));
    assert!(
        !recorded.retained_messages.is_empty(),
        "recovery should retain a bounded recent tail"
    );
    assert_eq!(recorded.active_user_message_id.as_deref(), Some("msg_1"));
    let metadata = recorded
        .metadata
        .as_ref()
        .expect("metadata should be written");
    assert_eq!(metadata.source.as_deref(), Some("local_recovery"));
    assert!(metadata.degraded);
    assert_eq!(
        metadata.reason.as_deref(),
        Some("compact_request_hard_gate")
    );
    assert!(metadata.observed_request_tokens.unwrap_or(0) > 0);
    assert_eq!(metadata.target_usable_tokens, Some(7_168));
}

#[tokio::test]
async fn service_degraded_recovery_append_failure_continues_with_volatile_status() {
    let mut provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("after volatile recovery"))],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let recorder = Arc::new(RecordingCompactionRecorder::failing_compaction());
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        hard_gate_compact_request_overflow_context(),
        Some(recorder),
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_for_service_idle(&service).await;

    assert_eq!(service.status().state, ServiceState::Idle);
    assert_eq!(provider.main_requests().len(), 1);
    assert!(has_local_degraded_recovery(
        &provider.main_requests()[0].transcript_messages()
    ));
    let status_data = {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        service.inner.service_status_data_from_locked(&state).0
    };
    assert_eq!(status_data["context_maintenance"]["degraded"], json!(true));
    assert_eq!(status_data["context_maintenance"]["volatile"], json!(true));
    assert_eq!(
        status_data["context_maintenance"]["provider_calls_paused"],
        json!(false)
    );
    assert_eq!(
        status_data["context_maintenance"]["reason"],
        json!("session_append_failed")
    );
}

#[tokio::test]
async fn service_degraded_recovery_adopts_volatile_context_after_compaction_poison() {
    let session_file = SwitchableCompactionFlushFailureSessionFile::from_bytes(Vec::new());
    session_file.set_fail_compaction_rollback(true);
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("degraded-poison.jsonl"),
        session_file,
    ));
    let mut provider = CompactTestProvider::new(
        vec![Err(ProviderError::request_failed(
            "provider stops after poisoned volatile recovery",
        ))],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("degraded-poison"),
        provider.clone(),
        Vec::new(),
        SessionReplay {
            initial_context: hard_gate_compact_request_overflow_context(),
            ..SessionReplay::default()
        },
        Some(recorder.clone()),
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_poison", vec![ContentPart::text("current small")])
        .await
        .expect("input should persist before compaction poisons the path");
    tokio::time::timeout(
        Duration::from_secs(10),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("provider failure should end the turn after volatile recovery");

    assert_eq!(provider.main_requests().len(), 1);
    assert!(has_local_degraded_recovery(
        &provider.main_requests()[0].transcript_messages()
    ));
    assert!(has_local_degraded_recovery(&service.context_messages()));
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(matches!(
            state
                .pending_recovery_record
                .as_ref()
                .map(|record| &record.kind),
            Some(PendingRecoveryRecordKind::DegradedLocalRecovery)
        ));
    }
    let error = recorder
        .record_message_sync(&Message::assistant_text("persistent write after poison"))
        .expect_err("poison should stop later persistent writes");
    assert!(error.to_string().contains("ambiguous"));
}

#[tokio::test]
async fn service_degraded_recovery_append_failure_expires_after_assistant_commit() {
    let mut provider = CompactTestProvider::new(
        vec![
            Ok(ProviderResponse::text("after volatile recovery")),
            Ok(ProviderResponse::text("after ordinary followup")),
        ],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let recorder = Arc::new(RecordingCompactionRecorder::failing_compaction());
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        hard_gate_compact_request_overflow_context(),
        Some(recorder.clone()),
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("enqueue should succeed");
    wait_for_service_idle(&service).await;

    let first_request_messages = provider.main_requests()[0].transcript_messages();
    assert!(has_local_degraded_recovery(&first_request_messages));
    assert!(
        recorder.compactions().is_empty(),
        "failed recovery append should leave only an in-memory pending record"
    );

    recorder.set_fail_compaction(false);
    service
        .enqueue(
            "msg_2",
            vec![ContentPart::text("second after stale recovery")],
        )
        .await
        .expect("follow-up enqueue should succeed");
    wait_for_service_idle(&service).await;

    assert!(
        recorder.compactions().is_empty(),
        "ordinary pending recovery must expire once an assistant transcript line is durable"
    );
    let second_request_messages = provider.main_requests()[1].transcript_messages();
    let second_request_debug = format!("{second_request_messages:?}");
    assert!(
        second_request_debug.contains("after volatile recovery"),
        "follow-up provider request must retain the already durable assistant instead of replaying an old compaction snapshot"
    );
    assert!(
        second_request_debug.contains("second after stale recovery"),
        "follow-up user input should still drain normally after stale recovery expires"
    );

    let status_data = {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        service.inner.service_status_data_from_locked(&state).0
    };
    assert_eq!(status_data["context_maintenance"]["degraded"], json!(true));
    assert_eq!(
        status_data["context_maintenance"]["provider_calls_paused"],
        json!(false)
    );
}

#[tokio::test]
async fn service_degraded_recovery_pending_recovery_retries_before_next_input_without_assistant_boundary(
) {
    let home = service_test_home("pending-recovery-no-assistant-boundary");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let old_context = hard_gate_compact_request_overflow_context();
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
    let path = opened.path().to_path_buf();
    let initial_bytes = fs::read(&path).expect("session bytes should read");
    let session_file = SwitchableCompactionFlushFailureSessionFile::from_bytes(initial_bytes);
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        path.clone(),
        session_file.clone(),
    ));
    let mut provider = CompactTestProvider::new(
        vec![
            Err(ProviderError::request_failed(
                "provider failed after volatile recovery",
            )),
            Ok(ProviderResponse::text("after durable recovery retry")),
        ],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        opened.replay(),
        Some(recorder),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("first enqueue should succeed");
    wait_for_service_idle(&service).await;

    assert_eq!(provider.main_requests().len(), 1);
    assert!(has_local_degraded_recovery(
        &provider.main_requests()[0].transcript_messages()
    ));
    assert!(session_file.compaction_flush_attempts() > 0);
    assert!(
        session_body_records(&session_file.bytes())
            .iter()
            .all(|record| record["type"] != json!("compaction")),
        "failed recovery append should roll back the volatile compaction"
    );
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        let pending = state
            .pending_recovery_record
            .as_ref()
            .expect("provider failure should leave pending local recovery");
        assert!(matches!(
            pending.kind,
            PendingRecoveryRecordKind::DegradedLocalRecovery
        ));
        assert_eq!(pending.reason, "compact_request_hard_gate");
    }

    session_file.set_fail_compaction(false);
    service
        .enqueue(
            "msg_2",
            vec![ContentPart::text("second after recovery retry")],
        )
        .await
        .expect("second enqueue should succeed");
    wait_for_service_idle(&service).await;

    let records = session_body_records(&session_file.bytes());
    let retry_compaction_index = records
        .iter()
        .position(|record| {
            record["type"] == json!("compaction")
                && record["metadata"]["reason"] == json!("compact_request_hard_gate")
        })
        .expect("pending recovery retry should persist a compaction");
    let second_user_commit_index = records
        .iter()
        .position(|record| {
            record["type"] == json!("user_message") && record["message_id"] == json!("msg_2")
        })
        .expect("second input should be committed as a user message");
    assert!(
        retry_compaction_index < second_user_commit_index,
        "pending recovery must be persisted before the next user batch is processed: {records:?}"
    );
    let retry_compaction = &records[retry_compaction_index];
    assert_eq!(retry_compaction["active_user_message_id"], json!("msg_1"));
    assert!(retry_compaction["summary"]
        .as_array()
        .expect("summary should be an array")
        .iter()
        .any(|part| part["text"]
            .as_str()
            .is_some_and(|text| text.contains("Local degraded recovery summary"))));
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(
            state.pending_recovery_record.is_none(),
            "successful retry should clear pending local recovery"
        );
    }
    let second_request_debug = format!("{:?}", provider.main_requests()[1].transcript_messages());
    assert!(second_request_debug.contains("Local degraded recovery summary"));
    assert!(second_request_debug.contains("second after recovery retry"));
    assert!(
        !second_request_debug.contains("historic compact request overflow"),
        "provider must not be sent the uncompressed historic context after retry"
    );
    drop(service);

    fs::write(&path, session_file.bytes()).expect("captured session bytes should write");
    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay durable recovery retry");
    let replayed_messages = format!("{:?}", replayed.initial_messages());
    assert!(replayed_messages.contains("Local degraded recovery summary"));
    assert!(replayed_messages.contains("current small"));
    assert!(replayed_messages.contains("second after recovery retry"));
    assert!(replayed_messages.contains("after durable recovery retry"));
    assert!(
        !replayed_messages.contains("historic compact request overflow"),
        "replay must not return to the pre-recovery large context"
    );
}

#[tokio::test]
async fn service_degraded_recovery_pending_retry_failure_blocks_next_input_commit() {
    let home = service_test_home("pending-recovery-retry-failure-blocks-next-input");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let old_context = hard_gate_compact_request_overflow_context();
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
    let path = opened.path().to_path_buf();
    let initial_bytes = fs::read(&path).expect("session bytes should read");
    let session_file = SwitchableCompactionFlushFailureSessionFile::from_bytes(initial_bytes);
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        path.clone(),
        session_file.clone(),
    ));
    let mut provider = CompactTestProvider::new(
        vec![
            Err(ProviderError::request_failed(
                "provider failed after volatile recovery",
            )),
            Ok(ProviderResponse::text(
                "must not run before recovery is durable",
            )),
        ],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        opened.replay(),
        Some(recorder),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("first enqueue should succeed");
    wait_for_service_idle(&service).await;
    assert_eq!(provider.main_requests().len(), 1);
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(
            state.pending_recovery_record.is_some(),
            "provider failure after volatile recovery should keep pending recovery"
        );
    }

    service
        .enqueue(
            "msg_2",
            vec![ContentPart::text("second while recovery still fails")],
        )
        .await
        .expect("enqueue should accept into queue before drain commit");
    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("service should fail closed when recovery retry cannot persist");

    assert_eq!(
        provider.main_requests().len(),
        1,
        "follow-up input must not reach provider before recovery is durable"
    );
    let records = session_body_records(&session_file.bytes());
    assert!(
        records
            .iter()
            .all(|record| record["type"] != json!("compaction")),
        "failed recovery retries should not leave a partial compaction line"
    );
    assert!(
        records.iter().all(|record| {
            record["type"] != json!("user_message") || record["message_id"] != json!("msg_2")
        }),
        "next user input must not become durable while pending recovery cannot persist"
    );
    assert!(
        service
            .status()
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("pending local recovery compaction append failed")),
        "last_error should explain the recovery persistence gate"
    );

    session_file.set_fail_compaction(false);
    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;

    let records = session_body_records(&session_file.bytes());
    let retry_compaction_index = records
        .iter()
        .position(|record| {
            record["type"] == json!("compaction")
                && record["metadata"]["reason"] == json!("compact_request_hard_gate")
        })
        .expect("pending recovery should persist after storage recovers");
    let second_user_commit_index = records
        .iter()
        .position(|record| {
            record["type"] == json!("user_message") && record["message_id"] == json!("msg_2")
        })
        .expect("blocked input should commit after recovery persists");
    assert!(
        retry_compaction_index < second_user_commit_index,
        "recovered pending input must not cross the recovery compaction: {records:?}"
    );
    assert_eq!(
        provider.main_requests().len(),
        2,
        "blocked pending input should reach provider after recovery persists"
    );
    let second_request_debug = format!("{:?}", provider.main_requests()[1].transcript_messages());
    assert!(second_request_debug.contains("Local degraded recovery summary"));
    assert!(second_request_debug.contains("second while recovery still fails"));
}

#[tokio::test]
async fn service_ordinary_pending_recovery_does_not_drop_durable_assistant_on_replay() {
    let home = service_test_home("ordinary-pending-recovery-keeps-assistant");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let path = opened.path().to_path_buf();
    let header_bytes = fs::read(&path).expect("session header should read");
    let session_file = SwitchableCompactionFlushFailureSessionFile::from_bytes(header_bytes);
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        path.clone(),
        session_file.clone(),
    ));
    let mut provider = CompactTestProvider::new(
        vec![
            Ok(ProviderResponse::text("after volatile recovery")),
            Ok(ProviderResponse::text("after durable followup")),
        ],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider,
        Vec::new(),
        SessionReplay {
            initial_context: hard_gate_compact_request_overflow_context(),
            ..opened.replay()
        },
        Some(recorder),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("current small")])
        .await
        .expect("first enqueue should succeed");
    wait_for_service_idle(&service).await;
    assert!(session_file.compaction_flush_attempts() > 0);
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(
            state.pending_recovery_record.is_none(),
            "ordinary pending recovery should expire once the first assistant is durable"
        );
    }

    session_file.set_fail_compaction(false);
    service
        .enqueue(
            "msg_2",
            vec![ContentPart::text("second after stale recovery")],
        )
        .await
        .expect("follow-up enqueue should succeed");
    wait_for_service_idle(&service).await;
    drop(service);

    let bytes = session_file.bytes();
    let records = session_body_records(&bytes);
    assert!(
        !records.iter().any(|record| record["type"] == json!("compaction")),
        "ordinary stale pending recovery must not append an old compaction snapshot after an assistant is durable"
    );

    fs::write(&path, bytes).expect("captured session bytes should write");
    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay");
    let replayed_messages = format!("{:?}", replayed.initial_messages());
    assert!(
        replayed_messages.contains("after volatile recovery"),
        "first assistant output must survive replay after stale pending recovery expires"
    );
    assert!(
        replayed_messages.contains("second after stale recovery"),
        "follow-up user input must survive replay after stale pending recovery expires"
    );
    assert!(
        replayed_messages.contains("after durable followup"),
        "follow-up assistant output must survive replay after stale pending recovery expires"
    );
}

#[tokio::test]
async fn service_recovery_rejects_single_user_input_too_large_and_drains_followup() {
    let mut provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("small handled"))],
        vec![Ok(ProviderResponse::text(
            "should not compact single input",
        ))],
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let recorder = Arc::new(RecordingCompactionRecorder::default());
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        Vec::new(),
        Some(recorder.clone()),
    )
    .expect("service construction should succeed");
    let huge = format!("huge current input {}", "x".repeat(40_000));

    service
        .enqueue("msg_huge", vec![ContentPart::text(huge.clone())])
        .await
        .expect("huge enqueue should be accepted before provider budget");
    wait_for_service_idle(&service).await;

    assert_eq!(
        provider.main_requests().len(),
        0,
        "oversized single input must not reach the agent provider"
    );
    assert_eq!(
        provider.compact_requests().len(),
        0,
        "single-input overflow has no useful normal compaction provider call"
    );
    assert_eq!(service.status().queue_length, 0);
    let rejected = service
        .events_after(0)
        .into_iter()
        .find(|event| {
            event.event_type == "message.rejected" && event.data["message_id"] == json!("msg_huge")
        })
        .expect("oversized input should emit message.rejected");
    assert_eq!(
        rejected.data["error"]["code"],
        json!(INPUT_TOO_LARGE_FOR_MODEL_WINDOW)
    );
    assert_eq!(
        rejected.data["error"]["message"],
        json!("This input is too large to send. Shorten it or split it into smaller messages.")
    );
    let public_rejection = rejected.data["error"]["message"]
        .as_str()
        .expect("rejection message should be a string");
    assert!(
        !public_rejection.contains("estimated input tokens"),
        "public rejection message must not expose token estimates"
    );
    assert!(
        !public_rejection.contains("hard limit"),
        "public rejection message must not expose compact policy thresholds"
    );
    assert!(
        !public_rejection.contains("hard_stop_tokens"),
        "public rejection message must not expose structured diagnostic field names"
    );
    assert!(
        !public_rejection.contains("observed_input_tokens"),
        "public rejection message must not expose structured diagnostic field names"
    );
    let compactions = recorder.compactions();
    assert_eq!(
        compactions.len(),
        2,
        "recovery should be followed by a removal compaction for replay"
    );
    assert_eq!(compactions[1].active_user_message_id.as_deref(), None);
    let removal_metadata = compactions[1]
        .metadata
        .as_ref()
        .expect("rejected input removal should keep structured diagnostics");
    assert_eq!(
        removal_metadata.reason.as_deref(),
        Some(INPUT_TOO_LARGE_FOR_MODEL_WINDOW)
    );
    let observed = removal_metadata
        .observed_request_tokens
        .expect("metadata should include observed token estimate");
    let target = removal_metadata
        .target_usable_tokens
        .expect("metadata should include target usable tokens");
    assert!(observed > target);
    assert!(
        !format!("{:?}", compactions[1].retained_messages).contains(&huge),
        "removal compaction must not retain rejected input"
    );

    service
        .enqueue("msg_small", vec![ContentPart::text("small followup")])
        .await
        .expect("small followup enqueue should succeed");
    wait_for_service_idle(&service).await;

    let main_requests = provider.main_requests();
    assert_eq!(main_requests.len(), 1);
    let rendered = format!("{:?}", main_requests[0].transcript_messages());
    assert!(
        !rendered.contains(&huge),
        "rejected oversized input must not remain in provider transcript"
    );
    assert!(
        rendered.contains("small followup"),
        "follow-up input should drain normally after rejection"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn service_rejected_input_event_append_failure_fails_closed_and_recovers_on_restart() {
    let home = service_test_home("rejected-input-event-append-failure-restart");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let path = opened.path().to_path_buf();
    let mut provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("small handled after restart"))],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        SessionReplay {
            initial_context: Vec::new(),
            ..opened.replay()
        },
        Some(opened.recorder()),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let huge = format!("huge rejection append failure {}", "x".repeat(40_000));

    service
        .inner
        .event_commit_test_hook
        .pause_after_durable("compact.completed");
    service
        .enqueue("msg_huge", vec![ContentPart::text(huge.clone())])
        .await
        .expect("huge enqueue should be accepted before provider budget");
    service.inner.event_commit_test_hook.wait_until_paused();
    let compact_failed_before = service
        .events_after(0)
        .iter()
        .filter(|event| event.event_type == "compact.failed")
        .count();
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);
    service.inner.event_commit_test_hook.release();

    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("service should fail closed when the rejection event cannot be persisted");

    assert_eq!(provider.main_requests().len(), 0);
    assert_eq!(
        service
            .events_after(0)
            .iter()
            .filter(|event| {
                event.event_type == "message.rejected"
                    && event.data["message_id"] == json!("msg_huge")
            })
            .count(),
        0,
        "a failed rejection append must not project a volatile rejection"
    );
    assert_eq!(
        service
            .events_after(0)
            .iter()
            .filter(|event| event.event_type == "compact.failed")
            .count(),
        compact_failed_before,
        "rejection persistence failure must return before compact.failed"
    );
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(
            format!("{:?}", state.context).contains(&huge),
            "failed rejection persistence must preserve the oversized input in memory"
        );
        assert_eq!(
            state
                .restart_boundary
                .as_ref()
                .map(SessionRestartBoundary::active_user_message_id),
            Some("msg_huge")
        );
        assert!(state
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains(REJECTED_INPUT_APPEND_FAILED)));
    }
    let failed_records = session_body_records(&fs::read(&path).expect("session should read"));
    assert!(
        format!("{failed_records:?}").contains(&huge),
        "failed rejection persistence must preserve the oversized input in session history"
    );
    assert!(failed_records.iter().all(|record| {
        record["type"] != json!("compaction")
            || record["metadata"]["reason"] != json!(INPUT_TOO_LARGE_FOR_MODEL_WINDOW)
    }));
    assert!(failed_records.iter().all(|record| {
        record["type"] != json!("pending_input_removed")
            || record["message_id"] != json!("msg_huge")
    }));

    service
        .enqueue(
            "msg_small_after_failure",
            vec![ContentPart::text(
                "small after rejection persistence failure",
            )],
        )
        .await
        .expect("follow-up enqueue should restart the failed service");
    wait_for_service_idle(&service).await;

    assert_eq!(service.status().state, ServiceState::Idle);
    let rejected = service
        .events_after(0)
        .into_iter()
        .filter(|event| {
            event.event_type == "message.rejected" && event.data["message_id"] == json!("msg_huge")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        rejected.len(),
        1,
        "restart recovery should durably reject the oversized input exactly once"
    );
    let records = session_body_records(&fs::read(&path).expect("session should read"));
    let removal = records
        .iter()
        .filter(|record| record["type"] == json!("compaction"))
        .find(|record| record["metadata"]["reason"] == json!(INPUT_TOO_LARGE_FOR_MODEL_WINDOW))
        .expect("restart recovery should durably persist rejected-input removal");
    assert!(removal.get("active_user_message_id").is_none());
    let main_requests = provider.main_requests();
    assert_eq!(main_requests.len(), 1);
    let rendered = format!("{:?}", main_requests[0].transcript_messages());
    assert!(rendered.contains("small after rejection persistence failure"));
    assert!(!rendered.contains(&huge));

    drop(service);
    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay after durable rejected-input removal");
    assert!(replayed.restart_boundary().is_none());
    assert!(!format!("{:?}", replayed.initial_messages()).contains(&huge));
}

#[tokio::test]
async fn service_volatile_rejected_input_removal_retries_without_replaying_rejected_input() {
    let mut provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text(
            "small handled after removal retry",
        ))],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let recorder = Arc::new(RecordingCompactionRecorder::failing_compaction());
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        Vec::new(),
        Some(recorder.clone()),
    )
    .expect("service construction should succeed");
    let huge = format!("huge volatile input {}", "x".repeat(40_000));

    service
        .enqueue("msg_huge", vec![ContentPart::text(huge.clone())])
        .await
        .expect("huge enqueue should be accepted before provider budget");
    wait_for_service_idle(&service).await;

    assert_eq!(provider.main_requests().len(), 0);
    assert!(recorder.compactions().is_empty());
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        let pending = state
            .pending_recovery_record
            .as_ref()
            .expect("failed removal append should leave a pending retry record");
        assert_eq!(pending.reason, INPUT_TOO_LARGE_FOR_MODEL_WINDOW);
        let pending_debug = format!("{pending:?}");
        assert!(
            !pending_debug.contains(&huge),
            "pending retry must supersede the older volatile recovery record that contained the rejected input"
        );
    }

    recorder.set_fail_compaction(false);
    service
        .enqueue("msg_small", vec![ContentPart::text("small followup")])
        .await
        .expect("small followup enqueue should succeed");
    wait_for_service_idle(&service).await;

    let compactions = recorder.compactions();
    assert_eq!(compactions.len(), 1);
    let recorded = &compactions[0];
    assert_eq!(
        recorded
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.reason.as_deref()),
        Some(INPUT_TOO_LARGE_FOR_MODEL_WINDOW)
    );
    assert_eq!(recorded.active_user_message_id.as_deref(), None);
    assert!(
        !format!("{recorded:?}").contains(&huge),
        "retry must persist the removal record, not the stale recovery record with rejected input"
    );
    let rendered = format!("{:?}", provider.main_requests()[0].transcript_messages());
    assert!(!rendered.contains(&huge));
    assert!(rendered.contains("small followup"));
}

#[tokio::test]
async fn service_rejected_input_removal_retry_failure_tombstones_replay() {
    let home = service_test_home("rejected-input-removal-retry-failure-tombstone");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let path = opened.path().to_path_buf();
    let header_bytes = fs::read(&path).expect("session header should read");
    let session_file = SwitchableCompactionFlushFailureSessionFile::from_bytes(header_bytes);
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        path.clone(),
        session_file.clone(),
    ));
    let mut provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text(
            "small handled after failed removal retry",
        ))],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        SessionReplay {
            initial_context: Vec::new(),
            ..opened.replay()
        },
        Some(recorder),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let huge = format!("huge failed removal input {}", "x".repeat(40_000));

    service
        .enqueue("msg_huge", vec![ContentPart::text(huge.clone())])
        .await
        .expect("huge enqueue should be accepted before provider budget");
    wait_for_service_idle(&service).await;
    assert_eq!(provider.main_requests().len(), 0);
    assert!(session_file.compaction_flush_attempts() > 0);

    service
        .enqueue("msg_small", vec![ContentPart::text("small followup")])
        .await
        .expect("small followup enqueue should succeed while removal compaction still fails");
    wait_for_service_idle(&service).await;
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(
            state.pending_recovery_record.is_some(),
            "failed removal compaction should keep its pending recovery intent"
        );
    }
    drop(service);

    let bytes = session_file.bytes();
    let records = session_body_records(&bytes);
    assert!(
        records.iter().any(|record| {
            record["type"] == json!("pending_input_removed")
                && record["message_id"] == json!("msg_huge")
        }),
        "failed removal compaction must persist a tombstone before later transcript can replay safely"
    );
    assert!(
        !records
            .iter()
            .any(|record| record["type"] == json!("compaction")),
        "test writer should keep removal compactions non-durable"
    );

    fs::write(&path, bytes).expect("captured session bytes should write");
    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay rejected input tombstone");
    let replayed_messages = format!("{:?}", replayed.initial_messages());
    assert!(
        !replayed_messages.contains(&huge),
        "rejected oversized input must not revive in replay even when removal retry still fails"
    );
    assert!(replayed_messages.contains("small followup"));
    assert!(replayed_messages.contains("small handled after failed removal retry"));
}

#[tokio::test]
async fn service_rejected_input_removal_continues_online_without_durable_marker() {
    let home = service_test_home("rejected-input-removal-no-durable-marker");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let path = opened.path().to_path_buf();
    let header_bytes = fs::read(&path).expect("session header should read");
    let session_file = SwitchableCompactionFlushFailureSessionFile::from_bytes(header_bytes);
    session_file.set_fail_pending_removal(true);
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        path.clone(),
        session_file.clone(),
    ));
    let mut provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text(
            "small input handled after volatile input removal",
        ))],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        SessionReplay {
            initial_context: Vec::new(),
            ..opened.replay()
        },
        Some(recorder),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let huge = format!("huge no durable removal input {}", "x".repeat(40_000));

    service
        .enqueue("msg_huge", vec![ContentPart::text(huge.clone())])
        .await
        .expect("huge enqueue should be accepted before provider budget");
    wait_for_service_idle(&service).await;

    assert_eq!(
        provider.main_requests().len(),
        0,
        "provider must not receive the oversized rejected input"
    );
    assert!(session_file.compaction_flush_attempts() > 0);
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(
            !format!("{:?}", state.context).contains(&huge),
            "in-memory context should isolate the bad oversized input so the service can continue online"
        );
        assert!(
            state.pending_recovery_record.is_some(),
            "without a durable marker, the service should keep retry state for future marker persistence"
        );
    }

    let no_marker_bytes = session_file.bytes();
    let records = session_body_records(&no_marker_bytes);
    assert!(
        records.iter().any(|record| {
            record["type"] == json!("user_message") && record["message_id"] == json!("msg_huge")
        }),
        "original durable user input must remain the only replay truth"
    );
    assert!(
        records
            .iter()
            .all(|record| record["type"] != json!("compaction")),
        "failed removal compaction should roll back its session line"
    );
    assert!(
        records
            .iter()
            .all(|record| record["type"] != json!("pending_input_removed")),
        "failed removal tombstone should roll back its session line"
    );

    service
        .enqueue(
            "msg_small_while_marker_fails",
            vec![ContentPart::text("small while marker still fails")],
        )
        .await
        .expect("follow-up enqueue can enter the in-memory queue before marker retry");
    tokio::time::timeout(
        Duration::from_secs(2),
        service.wait_for_state(ServiceState::Failed),
    )
    .await
    .expect("service should fail closed when removal marker still cannot persist");
    let blocked_records = session_body_records(&session_file.bytes());
    assert!(
        blocked_records.iter().all(|record| {
            record["type"] != json!("user_message")
                || record["message_id"] != json!("msg_small_while_marker_fails")
        }),
        "follow-up input must not be committed while the removal marker is not durable"
    );
    assert_eq!(
        provider.main_requests().len(),
        0,
        "blocked follow-up input must not reach provider"
    );

    session_file.set_fail_pending_removal(false);
    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;
    let online_requests = provider.main_requests();
    assert_eq!(
        online_requests.len(),
        1,
        "online recovery should allow the blocked input to reach provider"
    );
    let online_request_debug = format!("{:?}", online_requests[0].transcript_messages());
    assert!(online_request_debug.contains("small while marker still fails"));
    assert!(
        !online_request_debug.contains(&huge),
        "online recovery must keep the oversized input out of provider requests"
    );
    let durable_marker_bytes = session_file.bytes();
    drop(service);

    fs::write(&path, durable_marker_bytes).expect("durable marker session bytes should write");
    let marker_replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay durable marker and follow-up");
    let marker_replayed_messages = format!("{:?}", marker_replayed.initial_messages());
    assert!(
        !marker_replayed_messages.contains(&huge),
        "durable removal marker must keep the oversized input from reviving after a later follow-up"
    );
    assert!(marker_replayed_messages.contains("small while marker still fails"));

    fs::write(&path, no_marker_bytes).expect("captured session bytes should write");
    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay original input after failed removal markers");
    assert!(
        format!("{:?}", replayed.initial_messages()).contains(&huge),
        "restart replay must preserve the original input when deletion was not durable"
    );

    let mut restart_provider = CompactTestProvider::new(
        vec![Ok(ProviderResponse::text("small after restart recovery"))],
        Vec::new(),
    );
    set_compact_test_metadata(&mut restart_provider, 8_192, 1_024);
    let restart_provider = Arc::new(restart_provider);
    let restarted = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        restart_provider.clone(),
        Vec::new(),
        replayed.replay(),
        Some(replayed.recorder()),
        replayed.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    restarted
        .enqueue(
            "msg_small_after_restart",
            vec![ContentPart::text("small after marker failure restart")],
        )
        .await
        .expect("follow-up enqueue after restart should succeed");
    wait_for_service_idle(&restarted).await;

    let main_requests = restart_provider.main_requests();
    assert_eq!(
        main_requests.len(),
        1,
        "restart should automatically recover the oversized replayed input before provider call"
    );
    let request_debug = format!("{:?}", main_requests[0].transcript_messages());
    assert!(request_debug.contains("small after marker failure restart"));
    assert!(
        !request_debug.contains(&huge),
        "restart recovery must not send the oversized input back to the provider"
    );
    drop(restarted);

    let final_replay = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay after automatic restart recovery");
    assert!(
        !format!("{:?}", final_replay.initial_messages()).contains(&huge),
        "successful restart recovery should leave a durable session that no longer revives the oversized input"
    );
}

#[tokio::test]
async fn service_rejected_input_removal_compaction_replays_without_restart_boundary() {
    let home = service_test_home("rejected-input-removal-no-boundary");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let path = opened.path().to_path_buf();
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        SessionReplay {
            initial_context: Vec::new(),
            ..opened.replay()
        },
        Some(opened.recorder()),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let huge = format!("huge persisted removal input {}", "x".repeat(40_000));

    service
        .enqueue("msg_huge", vec![ContentPart::text(huge.clone())])
        .await
        .expect("huge enqueue should be accepted before provider budget");
    wait_for_service_idle(&service).await;
    drop(service);

    assert_eq!(provider.main_requests().len(), 0);
    let records = session_body_records(&fs::read(&path).expect("session should read"));
    let removal_compaction = records
        .iter()
        .filter(|record| record["type"] == json!("compaction"))
        .find(|record| {
            record
                .get("metadata")
                .and_then(|metadata| metadata.get("reason"))
                == Some(&json!(INPUT_TOO_LARGE_FOR_MODEL_WINDOW))
        })
        .expect("rejected input removal compaction should be durable");
    assert!(
        removal_compaction.get("active_user_message_id").is_none(),
        "rejected input removal compaction must be terminal and omit active user boundary"
    );
    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay rejected input removal");
    assert!(
        replayed.restart_boundary().is_none(),
        "terminal rejected-input removal compaction must not leave an active user restart boundary"
    );
    assert!(
        !format!("{:?}", replayed.initial_messages()).contains(&huge),
        "replayed provider transcript must not retain rejected oversized input"
    );
}

#[tokio::test]
async fn service_hard_gate_estimator_rejects_cjk_input_before_provider_call() {
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 6_144, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        Vec::new(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue(
            "msg_cjk_huge",
            vec![ContentPart::text("上下文".repeat(2_000))],
        )
        .await
        .expect("message should enqueue before budget check");
    wait_for_service_idle(&service).await;

    assert_eq!(
        provider.main_requests().len(),
        0,
        "hard gate estimator must not undercount non-ASCII input and release the provider call"
    );
    assert!(service.events_after(0).iter().any(|event| {
        event.event_type == "message.rejected"
            && event.data["message_id"] == json!("msg_cjk_huge")
            && event.data["error"]["code"] == json!(INPUT_TOO_LARGE_FOR_MODEL_WINDOW)
    }));
}

#[tokio::test]
async fn service_recovery_rejects_single_task_ask_input_too_large() {
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        Vec::new(),
        None,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_big_ask", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("running task should accept stdin writer");

    service
        .inner
        .handle_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "ask_huge".to_owned(),
                request: format!("task ask body {}", "q".repeat(40_000)),
                expect: Some("short answer".to_owned()),
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        )
        .await;
    wait_for_service_idle(&service).await;

    assert_eq!(provider.main_requests().len(), 0);
    assert_eq!(provider.compact_requests().len(), 0);
    assert_eq!(service.status().queue_length, 0);
    let request = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain")
        .requests
        .into_iter()
        .find(|request| request.request_id == "ask_huge")
        .expect("request should be retained");
    assert_eq!(request.state, TaskRequestState::Rejected);
    assert!(request
        .failure_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("too large to send")));
    let task_failure = request
        .failure_reason
        .as_deref()
        .expect("task rejection should have a public failure reason");
    assert!(
        !task_failure.contains("estimated input tokens"),
        "task rejection must not expose token estimates"
    );
    assert!(
        !task_failure.contains("hard limit"),
        "task rejection must not expose compact policy thresholds"
    );
    let stdin_text = stdin.text();
    assert!(stdin_text.contains("\"id\":\"ask_huge\""));
    assert!(stdin_text.contains("\"exception\""));
    assert!(stdin_text.contains(INPUT_TOO_LARGE_FOR_MODEL_WINDOW));
    assert!(service.events_after(0).iter().any(|event| {
        event.event_type == "task_ask.rejected"
            && event.data["ask_id"] == json!("ask_huge")
            && event.data["failure_reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("too large to send"))
    }));
}

#[tokio::test]
async fn oversized_task_callback_uses_metadata_identity_not_public_message_id() {
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let public_id = "public-callback-id-with-no-task-prefix";
    let task_id = "canonical-task-id";
    let service = Service::with_initial_context_and_pending_messages(
        AgentConfig::new("system"),
        provider,
        Vec::new(),
        Vec::new(),
        vec![DrainedMessage::new(
            public_id,
            vec![ContentPart::text(format!(
                "callback {}",
                "x".repeat(40_000)
            ))],
        )
        .with_source(InputSource::TaskCallback)
        .with_metadata(test_task_callback_metadata(task_id))],
        None,
    )
    .expect("service construction should succeed");
    service.inner.background_tasks.start_task_with_id(
        task_id,
        NewBackgroundTask::new("call_big_callback", "bash", "{}"),
    );

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;

    let failed = service
        .events_after(0)
        .into_iter()
        .find(|event| event.event_type == "task.callback_failed")
        .expect("oversized callback should emit task.callback_failed");
    assert_eq!(failed.data["task_id"], json!(task_id));
    assert_eq!(failed.data["callback_input_id"], json!(public_id));
}

#[tokio::test]
async fn oversized_subagent_callback_preserves_canonical_task_identity() {
    for (kind, ask_id, tell_id, semantic_field, semantic_id) in [
        (
            "task_ask",
            Some("canonical-ask-id"),
            None,
            "ask_id",
            "canonical-ask-id",
        ),
        (
            "task_tell",
            None,
            Some("canonical-tell-id"),
            "tell_id",
            "canonical-tell-id",
        ),
    ] {
        let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
        set_compact_test_metadata(&mut provider, 8_192, 1_024);
        let metadata = QueuedInputMetadata::SubagentCallback {
            subagent_id: format!("sa_big_{kind}"),
            kind: kind.to_owned(),
            task_id: Some("canonical-task-id".to_owned()),
            ask_id: ask_id.map(str::to_owned),
            tell_id: tell_id.map(str::to_owned),
            task_message: Some("callback message".to_owned()),
            label: Some("worker".to_owned()),
            summary: Some("large callback".to_owned()),
        };
        let service = Service::with_initial_context_and_pending_messages(
            AgentConfig::new("system"),
            Arc::new(provider),
            Vec::new(),
            Vec::new(),
            vec![DrainedMessage::new(
                format!("arbitrary-public-{kind}-message-id"),
                vec![ContentPart::text(format!(
                    "callback {}",
                    "x".repeat(40_000)
                ))],
            )
            .with_source(InputSource::SubagentCallback)
            .with_metadata(metadata)],
            None,
        )
        .expect("service construction should succeed");
        service.start_pending_if_needed().await;
        wait_for_service_idle(&service).await;

        let failed = service
            .events_after(0)
            .into_iter()
            .find(|event| {
                event.event_type == "subagent.callback"
                    && event.data["callback_status"] == json!("failed")
            })
            .expect("oversized callback should emit subagent.callback failure");
        assert_eq!(failed.data["callback_kind"], json!(kind));
        assert_eq!(failed.data["task_id"], json!("canonical-task-id"));
        assert_eq!(failed.data[semantic_field], json!(semantic_id));
    }
}

#[tokio::test]
async fn service_replay_restart_boundary_rejects_task_ask_as_task_after_active_recovery() {
    let home = service_test_home("restart-boundary-task-ask-recovery-source");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let task_id = "task_replay_huge_ask";
    let request_id = "ask_replay_huge";
    let input_id = task_request_input_id(task_id, request_id);
    let frame = TaskRequestFrame {
        id: request_id.to_owned(),
        request: format!("replayed task ask body {}", "q".repeat(40_000)),
        expect: Some("short answer".to_owned()),
        timeout: Some(Duration::from_secs(30)),
        urgency: InputUrgency::Normal,
    };

    let seed_tasks = BackgroundTaskManager::new();
    seed_tasks.start_task_with_id(
        task_id,
        NewBackgroundTask::new("call_replay_huge_ask", "bash", "{}"),
    );
    let TaskRequestAdmission::Accepted(seed_request) =
        seed_tasks.accept_task_request(task_id, frame.clone())
    else {
        panic!("seed task ask should be accepted");
    };
    let active_content = task_request_content(&seed_request);
    let active_message = Message::user(active_content.clone());
    let tool_call = ToolCall::new("call_replay_active_tool", "bash", json!({}));
    let assistant_message = Message::assistant_tool_calls(vec![tool_call.clone()]);
    let tool_result_message = Message::tool_result(ToolResult::success(
        tool_call.id.clone(),
        tool_call.name.clone(),
        "bounded replayed tool result",
    ));
    let retained_active_request = vec![
        active_message.clone(),
        assistant_message.clone(),
        tool_result_message.clone(),
    ];
    opened
        .recorder()
        .record_accepted_input_sync(&AcceptedInputEntry {
            message_id: input_id.clone(),
            content: active_content.clone(),
            cursor_seq: 3,
            source: InputSource::TaskRequest,
            metadata: Some(QueuedInputMetadata::TaskRequest {
                task_id: task_id.to_owned(),
                request_id: request_id.to_owned(),
            }),
            urgency: InputUrgency::Normal,
        })
        .expect("accepted task ask should persist");
    opened
        .recorder()
        .record_user_batch_with_ids_sync(
            std::slice::from_ref(&active_message),
            std::slice::from_ref(&input_id),
        )
        .expect("active user batch should persist");
    opened
        .recorder()
        .record_message_sync(&assistant_message)
        .expect("active assistant tool call should persist");
    opened
        .recorder()
        .record_message_sync(&tool_result_message)
        .expect("active tool result should persist");
    opened
        .recorder()
        .record_compaction_with_active_user_message_id_sync(
            &[ContentPart::text("Compaction summary:\nrestart task ask")],
            &retained_active_request,
            Some(input_id.as_str()),
        )
        .expect("restart boundary compaction should persist");
    drop(opened);

    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay");
    assert_eq!(
        replayed
            .restart_boundary()
            .expect("restart boundary should replay")
            .active_user_message_id(),
        input_id
    );
    let known = replayed
        .known_user_messages()
        .iter()
        .find(|message| message.id == input_id)
        .expect("known task ask input should be retained");
    assert_eq!(known.source, InputSource::TaskRequest);
    assert_eq!(
        known.metadata,
        Some(QueuedInputMetadata::TaskRequest {
            task_id: task_id.to_owned(),
            request_id: request_id.to_owned(),
        })
    );

    let mut provider = CompactTestProvider::new(
        Vec::new(),
        vec![
            Err(ProviderError::request_failed("summary provider failed 1")),
            Err(ProviderError::request_failed("summary provider failed 2")),
            Err(ProviderError::request_failed("summary provider failed 3")),
        ],
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        replayed.replay(),
        Some(replayed.recorder()),
        replayed.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let task = service.inner.background_tasks.start_task_with_id(
        task_id,
        NewBackgroundTask::new("call_replay_huge_ask", "bash", "{}"),
    );
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("running task should accept stdin writer");
    let TaskRequestAdmission::Accepted(_) = service
        .inner
        .background_tasks
        .accept_task_request(&task.task_id, frame)
    else {
        panic!("restarted task ask should be pending before recovery");
    };

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;

    assert_eq!(provider.main_requests().len(), 0);
    assert_eq!(provider.compact_requests().len(), MAX_HARD_COMPACT_FAILURES);
    let request = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain")
        .requests
        .into_iter()
        .find(|request| request.request_id == request_id)
        .expect("request should be retained");
    assert_eq!(request.state, TaskRequestState::Rejected);
    assert!(request
        .failure_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("too large to send")));
    let stdin_text = stdin.text();
    assert!(stdin_text.contains("\"id\":\"ask_replay_huge\""));
    assert!(stdin_text.contains("\"exception\""));
    assert!(stdin_text.contains(INPUT_TOO_LARGE_FOR_MODEL_WINDOW));

    let events = service.events_after(0);
    assert!(events.iter().any(|event| {
        event.event_type == "task_ask.rejected"
            && event.data["ask_id"] == json!(request_id)
            && event.data["state"] == json!("rejected")
    }));
    assert!(
        events.iter().all(|event| {
            !(event.event_type == "message.rejected"
                && event.data["message_id"] == json!(input_id)
                && event.data["source"] == json!("user"))
        }),
        "replayed task ask must not be rejected as an ordinary user input"
    );
}

#[tokio::test]
async fn service_replay_restart_boundary_closes_out_entire_active_batch_after_recovery() {
    let home = service_test_home("restart-boundary-active-batch-recovery");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let task_id = "task_replay_active_batch";
    let ask_id = "ask_replay_active_batch";
    let tell_id = "tell_replay_active_batch";
    let ask_input_id = task_request_input_id(task_id, ask_id);
    let tell_input_id = "task_tell_replay_active_batch";
    let callback_input_id = "task_callback_replay_active_batch";
    let frame = TaskRequestFrame {
        id: ask_id.to_owned(),
        request: "replayed task ask in active batch".to_owned(),
        expect: Some("short answer".to_owned()),
        timeout: Some(Duration::from_secs(30)),
        urgency: InputUrgency::Normal,
    };

    let seed_tasks = BackgroundTaskManager::new();
    seed_tasks.start_task_with_id(
        task_id,
        NewBackgroundTask::new("call_replay_active_batch", "bash", "{}"),
    );
    let TaskRequestAdmission::Accepted(seed_request) =
        seed_tasks.accept_task_request(task_id, frame.clone())
    else {
        panic!("seed task ask should be accepted");
    };
    let user_content = vec![ContentPart::text(format!(
        "user input leading active batch {}",
        "u".repeat(40_000)
    ))];
    let ask_content = task_request_content(&seed_request);
    let tell_content = vec![ContentPart::text("task tell in active batch")];
    let callback_content = vec![ContentPart::text("task callback in active batch")];
    let active_messages = vec![
        Message::user(user_content.clone()),
        Message::user(ask_content.clone()),
        Message::user(tell_content.clone()),
        Message::user(callback_content.clone()),
    ];
    let active_ids = vec![
        "msg_user_active_batch".to_owned(),
        ask_input_id.clone(),
        tell_input_id.to_owned(),
        callback_input_id.to_owned(),
    ];
    let tool_call = ToolCall::new("call_replay_active_batch_tool", "bash", json!({}));
    let assistant_message = Message::assistant_tool_calls(vec![tool_call.clone()]);
    let tool_result_message = Message::tool_result(ToolResult::success(
        tool_call.id.clone(),
        tool_call.name.clone(),
        "bounded replayed active batch result",
    ));
    let mut retained_active_request = active_messages.clone();
    retained_active_request.push(assistant_message.clone());
    retained_active_request.push(tool_result_message.clone());

    opened
        .recorder()
        .record_accepted_input_sync(&AcceptedInputEntry {
            message_id: active_ids[0].clone(),
            content: user_content,
            cursor_seq: 3,
            source: InputSource::User,
            metadata: None,
            urgency: InputUrgency::Normal,
        })
        .expect("accepted user input should persist");
    opened
        .recorder()
        .record_accepted_input_sync(&AcceptedInputEntry {
            message_id: ask_input_id.clone(),
            content: ask_content,
            cursor_seq: 4,
            source: InputSource::TaskRequest,
            metadata: Some(QueuedInputMetadata::TaskRequest {
                task_id: task_id.to_owned(),
                request_id: ask_id.to_owned(),
            }),
            urgency: InputUrgency::Normal,
        })
        .expect("accepted task ask should persist");
    opened
        .recorder()
        .record_accepted_input_sync(&AcceptedInputEntry {
            message_id: tell_input_id.to_owned(),
            content: tell_content,
            cursor_seq: 5,
            source: InputSource::TaskTell,
            metadata: Some(QueuedInputMetadata::TaskTell {
                task_id: task_id.to_owned(),
                tell_id: tell_id.to_owned(),
            }),
            urgency: InputUrgency::Normal,
        })
        .expect("accepted task tell should persist");
    opened
        .recorder()
        .record_accepted_input_sync(&AcceptedInputEntry {
            message_id: callback_input_id.to_owned(),
            content: callback_content.clone(),
            cursor_seq: 6,
            source: InputSource::TaskCallback,
            metadata: Some(test_task_callback_metadata(task_id)),
            urgency: InputUrgency::Normal,
        })
        .expect("accepted task callback should persist");
    opened
        .recorder()
        .record_user_batch_with_ids_sync(&active_messages, &active_ids)
        .expect("active user batch should persist");
    opened
        .recorder()
        .record_message_sync(&assistant_message)
        .expect("active assistant tool call should persist");
    opened
        .recorder()
        .record_message_sync(&tool_result_message)
        .expect("active tool result should persist");
    opened
        .recorder()
        .record_compaction_with_active_user_message_id_sync(
            &[ContentPart::text(
                "Compaction summary:\nrestart active batch",
            )],
            &retained_active_request,
            Some(active_ids[0].as_str()),
        )
        .expect("restart boundary compaction should persist");
    drop(opened);

    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay");
    let boundary = replayed
        .restart_boundary()
        .expect("restart boundary should replay");
    assert_eq!(boundary.active_user_message_id(), active_ids[0].as_str());
    assert_eq!(boundary.active_input_ids(), active_ids.as_slice());

    let mut provider = CompactTestProvider::new(
        Vec::new(),
        vec![
            Err(ProviderError::request_failed("summary provider failed 1")),
            Err(ProviderError::request_failed("summary provider failed 2")),
            Err(ProviderError::request_failed("summary provider failed 3")),
        ],
    );
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        replayed.replay(),
        Some(replayed.recorder()),
        replayed.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let task = service.inner.background_tasks.start_task_with_id(
        task_id,
        NewBackgroundTask::new("call_replay_active_batch", "bash", "{}"),
    );
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("running task should accept stdin writer");
    let TaskRequestAdmission::Accepted(_) = service
        .inner
        .background_tasks
        .accept_task_request(&task.task_id, frame)
    else {
        panic!("restarted task ask should be pending before recovery");
    };
    service
        .inner
        .background_tasks
        .set_callback_pending(&task.task_id, callback_input_id, callback_content)
        .expect("callback should become pending");
    service
        .inner
        .background_tasks
        .set_callback_enqueued(&task.task_id)
        .expect("callback should become enqueued");

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;

    assert_eq!(provider.main_requests().len(), 0);
    assert_eq!(provider.compact_requests().len(), MAX_HARD_COMPACT_FAILURES);
    assert_eq!(service.status().queue_length, 0);
    let snapshot = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain");
    let request = snapshot
        .requests
        .iter()
        .find(|request| request.request_id == ask_id)
        .expect("request should be retained");
    assert_eq!(request.state, TaskRequestState::Rejected);
    assert!(request
        .failure_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("too large to send")));
    assert_eq!(snapshot.callback_delivery, CallbackDelivery::Failed);
    assert!(snapshot
        .callback_failure_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("too large to send")));
    let stdin_text = stdin.text();
    assert!(stdin_text.contains("\"id\":\"ask_replay_active_batch\""));
    assert!(stdin_text.contains("\"exception\""));
    assert!(stdin_text.contains(INPUT_TOO_LARGE_FOR_MODEL_WINDOW));

    let events = service.events_after(0);
    assert!(events.iter().any(|event| {
        event.event_type == "task_ask.rejected"
            && event.data["ask_id"] == json!(ask_id)
            && event.data["state"] == json!("rejected")
    }));
    assert!(events.iter().any(|event| {
        event.event_type == "task_tell.rejected"
            && event.data["tell_id"] == json!(tell_id)
            && event.data["error"]["code"] == json!(INPUT_TOO_LARGE_FOR_MODEL_WINDOW)
    }));
    assert!(events.iter().any(|event| {
        event.event_type == "task.callback_failed"
            && event.data["callback_delivery"] == json!("failed")
    }));
}
