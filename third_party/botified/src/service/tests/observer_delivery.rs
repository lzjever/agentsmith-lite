#[tokio::test]
async fn final_observer_receives_future_user_text_and_filters_non_text_input() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-observe-final-user-text"),
        Arc::new(TextProvider("assistant visible final")),
        Vec::new(),
    )
    .expect("service construction should succeed");

    service
        .enqueue(
            "msg_before_observe",
            vec![ContentPart::text("before observe")],
        )
        .await
        .expect("message before observer should enqueue");
    service.wait_for_state(ServiceState::Idle).await;

    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_observer", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let before_seq = service.status().last_event_seq;
    activate_task_observer_for_test(&service, &task.task_id, TaskObserveConfig::final_text());

    service
        .enqueue(
            "msg_future_observe",
            vec![ContentPart::text("future user text")],
        )
        .await
        .expect("future message should enqueue");
    service.wait_for_state(ServiceState::Idle).await;
    wait_until(|| stdin.text().contains("future user text")).await;

    service
        .enqueue(
            "msg_mixed_observe",
            vec![
                ContentPart::text("mixed text must not become user_text"),
                ContentPart::image_base64("image/png", "BASE64_SECRET_MUST_NOT_LEAK"),
            ],
        )
        .await
        .expect("mixed message should enqueue");
    service.wait_for_state(ServiceState::Idle).await;
    tokio::task::yield_now().await;

    let written = stdin.text();
    assert!(written.contains(r#""source":"user""#), "{written}");
    assert!(written.contains("future user text"), "{written}");
    assert!(written.contains(r#""source":"assistant""#), "{written}");
    assert!(!written.contains("before observe"), "{written}");
    assert!(
        !written.contains("mixed text must not become user_text"),
        "{written}"
    );
    assert!(
        !written.contains("BASE64_SECRET_MUST_NOT_LEAK"),
        "{written}"
    );
    assert!(!service
        .events_after(before_seq)
        .iter()
        .any(|event| event.event_type.starts_with("task_send.")));
}

#[tokio::test]
async fn final_observer_skips_empty_assistant_text_from_tool_call_message() {
    let provider = Arc::new(EmptyAssistantToolCallProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-observe-empty-assistant-tool-call"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_empty_assistant_observer",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    activate_task_observer_for_test(&service, &task.task_id, TaskObserveConfig::final_text());

    service
        .enqueue(
            "msg_empty_assistant_tool_call",
            vec![ContentPart::text("trigger empty assistant tool call")],
        )
        .await
        .expect("message should enqueue");
    service.wait_for_state(ServiceState::Idle).await;
    wait_until(|| provider.calls() >= 2).await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let frames = botified_frame_strings(&stdin.text())
        .into_iter()
        .map(|frame| botified_json_from_frame(&frame))
        .collect::<Vec<_>>();
    assert!(
        frames.iter().any(|frame| frame["source"] == "user"),
        "{frames:?}"
    );
    assert!(
        !frames.iter().any(|frame| frame["source"] == "assistant"),
        "empty tool-call-only assistant.message must not publish assistant_text: {frames:?}"
    );
}

#[tokio::test]
async fn observe_delivery_does_not_pollute_session_timeline_provider_context_or_active_items() {
    let home = service_test_home("observe-delivery-nonpollution");
    let opened =
        open_or_create_session_in_home_with_cwd("service-observe-boundary", &home, "/repo")
            .expect("session should open");
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session(opened.name().to_owned()),
        provider.clone(),
        Vec::new(),
        opened.replay(),
        Some(opened.recorder()),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_observe_boundary",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    activate_task_observer_for_test(&service, &task.task_id, TaskObserveConfig::final_text());

    let before_seq = service.status().last_event_seq;
    let before_session = fs::read_to_string(opened.path()).expect("session should read");
    let before_provider_calls = provider.calls();
    let before_context = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .context
        .clone();
    let before_active_items = service.timeline_bootstrap_snapshot()["active_items"].clone();
    let delivery_text = "SIDE_CAR_DELIVERY_SECRET";

    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: delivery_text,
            message_id: Some("assistant-observe-delivery"),
            cycle_id: None,
        });
    wait_until(|| stdin.text().contains(delivery_text)).await;
    wait_for_service_workers_idle(&service).await;

    let after_session = fs::read_to_string(opened.path()).expect("session should read");
    assert_eq!(after_session, before_session);
    assert!(!after_session.contains(delivery_text), "{after_session}");
    assert!(
        !after_session.contains(r#""op":"observe""#),
        "{after_session}"
    );
    assert_eq!(provider.calls(), before_provider_calls);
    let after_context = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .context
        .clone();
    assert_eq!(after_context, before_context);
    assert_eq!(
        service.timeline_bootstrap_snapshot()["active_items"],
        before_active_items
    );
    let events = service.events_after(before_seq);
    assert!(
        events.is_empty(),
        "observe delivery must not append timeline events: {events:?}"
    );
    assert!(!events.iter().any(|event| {
        event.event_type.starts_with("task_send.")
            || event.event_type.contains("observe")
            || event.data.to_string().contains(delivery_text)
    }));
}

#[tokio::test(flavor = "current_thread")]
async fn failed_task_observer_write_does_not_block_provider_completion() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-observe-failed-writer"),
        Arc::new(TextProvider(
            "assistant finished after observer write failed",
        )),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_observe_failed_writer",
            "bash",
            "{}",
        ));
    service
        .inner
        .background_tasks
        .register_stdin_writer(
            &task.task_id,
            Arc::new(ObserveWouldBlockTaskStdin::default()),
        )
        .expect("task exists");
    activate_task_observer_for_test(&service, &task.task_id, TaskObserveConfig::final_text());

    service
        .enqueue(
            "msg_observer_writer_failed",
            vec![ContentPart::text("user text starts observer write")],
        )
        .await
        .expect("message should enqueue");

    tokio::time::timeout(
        Duration::from_secs(1),
        service.wait_for_state(ServiceState::Idle),
    )
    .await
    .expect("provider turn should complete after observer write failure");
    wait_until(|| !service.inner.task_observer.is_observing(&task.task_id)).await;
}

#[tokio::test]
async fn stream_observer_preview_loop_fans_out_each_frame_once_per_task() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-observe-stream-fanout-once"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed")
    .with_llm_text_preview_enabled(true);
    let task_a = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_stream_observer_a",
            "bash",
            "{}",
        ));
    let task_b = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_stream_observer_b",
            "bash",
            "{}",
        ));
    let stdin_a = RecordingTaskStdin::default();
    let stdin_b = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task_a.task_id, Arc::new(stdin_a.clone()))
        .expect("task a exists");
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task_b.task_id, Arc::new(stdin_b.clone()))
        .expect("task b exists");

    activate_task_observer_for_test(
        &service,
        &task_a.task_id,
        TaskObserveConfig::stream_text(1).unwrap(),
    );
    activate_task_observer_for_test(
        &service,
        &task_b.task_id,
        TaskObserveConfig::stream_text(1).unwrap(),
    );

    let metadata = crate::llm_text_preview::LlmTextPreviewMetadata {
        provider_request_id: "prq_stream_once".to_owned(),
        turn_id: Some("turn_stream_once".to_owned()),
        cycle_id: Some("cycle_stream_once".to_owned()),
        provider_call_index: 0,
        input_ids: vec!["msg_stream_once".to_owned()],
    };
    let sink = service
        .llm_text_preview_sink()
        .expect("preview sink should be enabled");
    sink.publish(crate::llm_text_preview::LlmTextPreviewFrame::started(
        &metadata,
    ));
    sink.publish(crate::llm_text_preview::LlmTextPreviewFrame::text_delta(
        &metadata,
        "draft once",
    ));
    sink.publish(crate::llm_text_preview::LlmTextPreviewFrame::finished(
        &metadata,
        true,
        StopReason::EndTurn,
    ));

    wait_until(|| {
        botified_frame_strings(&stdin_a.text()).len() >= 2
            && botified_frame_strings(&stdin_b.text()).len() >= 2
    })
    .await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    for text in [stdin_a.text(), stdin_b.text()] {
        let frames = botified_frame_strings(&text)
            .into_iter()
            .map(|frame| botified_json_from_frame(&frame))
            .collect::<Vec<_>>();
        let events = frames
            .iter()
            .map(|frame| frame["event"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(events, vec!["text", "done"], "{frames:?}");
    }
}

#[test]
fn stream_observer_preview_loop_restarts_after_runtime_drop() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-observe-runtime-restart"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed")
    .with_llm_text_preview_enabled(true);
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_stream_observer_runtime_restart",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let runtime_a = tokio::runtime::Runtime::new().unwrap();
    runtime_a.block_on(async {
        service.inner.ensure_task_observer_preview_loop();
        tokio::task::yield_now().await;
    });
    assert!(service
        .inner
        .task_observer_preview_loop_started
        .load(Ordering::Acquire));
    drop(runtime_a);

    assert!(!service
        .inner
        .task_observer_preview_loop_started
        .load(Ordering::Acquire));

    let runtime_b = tokio::runtime::Runtime::new().unwrap();
    runtime_b.block_on(async {
        activate_task_observer_for_test(
            &service,
            &task.task_id,
            TaskObserveConfig::stream_text(1).unwrap(),
        );
        let metadata = crate::llm_text_preview::LlmTextPreviewMetadata {
            provider_request_id: "prq_stream_runtime_restart".to_owned(),
            turn_id: Some("turn_stream_runtime_restart".to_owned()),
            cycle_id: Some("cycle_stream_runtime_restart".to_owned()),
            provider_call_index: 0,
            input_ids: vec!["msg_stream_runtime_restart".to_owned()],
        };
        service
            .llm_text_preview_sink()
            .expect("preview sink should be enabled")
            .publish(crate::llm_text_preview::LlmTextPreviewFrame::text_delta(
                &metadata,
                "runtime B preview",
            ));
        wait_until(|| stdin.text().contains("runtime B preview")).await;
    });
}

#[test]
fn shutdown_waits_for_preview_loop_publication_window() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-observe-publish-shutdown"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed")
    .with_llm_text_preview_enabled(true);
    let publish_release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let (publish_entered_tx, publish_entered_rx) = std::sync::mpsc::sync_channel(1);
    let publish_release_for_hook = publish_release.clone();
    service
        .inner
        .set_task_observer_preview_publish_hook_for_test(Arc::new(move || {
            publish_entered_tx
                .send(())
                .expect("publish-window test should still be waiting");
            let (released, changed) = &*publish_release_for_hook;
            let released = released
                .lock()
                .expect("preview publish release mutex poisoned");
            let (released, timeout) = changed
                .wait_timeout_while(released, Duration::from_secs(5), |released| !*released)
                .expect("preview publish release mutex poisoned while waiting");
            assert!(
                *released,
                "timed out waiting to release preview publication: {}",
                timeout.timed_out()
            );
        }));

    let ensure_service = service.clone();
    let ensure_thread = std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().expect("ensure runtime should build");
        runtime.block_on(async {
            ensure_service.inner.ensure_task_observer_preview_loop();
        });
    });
    publish_entered_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("ensure should enter the preview publication window");

    let shutdown_service = service.clone();
    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::sync_channel(1);
    let shutdown_thread = std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().expect("shutdown runtime should build");
        shutdown_tx
            .send(runtime.block_on(shutdown_service.shutdown()))
            .expect("shutdown test should still be waiting");
    });
    tokio::runtime::Runtime::new()
        .expect("cancellation wait runtime should build")
        .block_on(service.inner.task_observer_preview_cancel.cancelled());

    assert!(
        shutdown_rx
            .recv_timeout(Duration::from_millis(250))
            .is_err(),
        "shutdown must not miss a preview handle being published"
    );
    assert!(
        service
            .inner
            .task_observer_preview_loop_started
            .load(Ordering::Acquire),
        "preview started latch should remain set while publication is paused"
    );

    let (released, changed) = &*publish_release;
    *released
        .lock()
        .expect("preview publish release mutex poisoned") = true;
    changed.notify_all();
    ensure_thread.join().expect("ensure thread should join");
    shutdown_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("shutdown should finish after the preview handle is published");
    shutdown_thread.join().expect("shutdown thread should join");

    assert!(!service
        .inner
        .task_observer_preview_loop_started
        .load(Ordering::Acquire));
    assert!(service
        .inner
        .task_observer_preview_join
        .lock()
        .expect("task observer preview join mutex poisoned")
        .is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn stream_observer_preview_loop_recovers_after_hub_drops_full_subscription() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-observe-stream-resubscribe"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed")
    .with_llm_text_preview_enabled(true);
    let observed = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_stream_observer_gap",
            "bash",
            "{}",
        ));
    let observed_stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&observed.task_id, Arc::new(observed_stdin.clone()))
        .expect("observed task exists");
    activate_task_observer_for_test(
        &service,
        &observed.task_id,
        TaskObserveConfig::stream_text(10).unwrap(),
    );

    let sink = service
        .llm_text_preview_sink()
        .expect("preview sink should be enabled");
    let stale = crate::llm_text_preview::LlmTextPreviewMetadata {
        provider_request_id: "prq_stream_stale".to_owned(),
        turn_id: Some("turn_stream_drop".to_owned()),
        cycle_id: Some("cycle_stream_drop".to_owned()),
        provider_call_index: 0,
        input_ids: vec!["msg_stream_drop".to_owned()],
    };
    sink.publish(crate::llm_text_preview::LlmTextPreviewFrame::text_delta(
        &stale, "stale",
    ));
    wait_until(|| {
        service
            .inner
            .task_observer
            .stream_buffer_for_test(&observed.task_id)
            .is_some_and(|(id, text)| id == "prq_stream_stale" && text == "stale")
    })
    .await;

    for index in 0..65 {
        let metadata = crate::llm_text_preview::LlmTextPreviewMetadata {
            provider_request_id: format!("prq_stream_drop_{index}"),
            turn_id: Some("turn_stream_drop".to_owned()),
            cycle_id: Some("cycle_stream_drop".to_owned()),
            provider_call_index: 0,
            input_ids: vec!["msg_stream_drop".to_owned()],
        };
        sink.publish(crate::llm_text_preview::LlmTextPreviewFrame::started(
            &metadata,
        ));
    }
    wait_until(|| {
        service
            .inner
            .task_observer
            .stream_buffer_for_test(&observed.task_id)
            .is_none()
    })
    .await;

    let metadata = crate::llm_text_preview::LlmTextPreviewMetadata {
        provider_request_id: "prq_stream_recovered".to_owned(),
        turn_id: Some("turn_stream_recovered".to_owned()),
        cycle_id: Some("cycle_stream_recovered".to_owned()),
        provider_call_index: 0,
        input_ids: vec!["msg_stream_recovered".to_owned()],
    };
    sink.publish(crate::llm_text_preview::LlmTextPreviewFrame::text_delta(
        &metadata,
        "fresh text",
    ));

    wait_until(|| observed_stdin.text().contains("fresh text")).await;
    let frames = botified_frame_strings(&observed_stdin.text())
        .into_iter()
        .map(|frame| botified_json_from_frame(&frame))
        .collect::<Vec<_>>();
    assert_eq!(frames.len(), 1, "{frames:?}");
    assert_eq!(frames[0]["event"], json!("text"));
    assert_eq!(frames[0]["text"], json!("fresh text"));
    assert!(!observed_stdin.text().contains("stale"));
}

#[tokio::test(flavor = "current_thread")]
async fn observer_would_block_failure_does_not_prevent_task_send() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-observe-priority-stdin"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_observe_priority_writer",
            "bash",
            "{}",
        ));
    let stdin = ObserveWouldBlockTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    activate_task_observer_for_test(&service, &task.task_id, TaskObserveConfig::final_text());

    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "observe writer would block before task send",
            message_id: Some("assistant-priority-observe"),
            cycle_id: None,
        });
    wait_until(|| !service.inner.task_observer.is_observing(&task.task_id)).await;

    let outcome = service.inner.send_task_message_by_owner(
        &TaskOwner::Main,
        &task.task_id,
        "task send proceeds after observe would block",
    );
    assert_eq!(outcome.status, TaskSendStatus::Written);
    assert!(
        stdin
            .text()
            .contains("task send proceeds after observe would block"),
        "{}",
        stdin.text()
    );
    assert!(!stdin.text().contains(r#""op":"observe""#));
}

#[tokio::test]
async fn task_initiated_observe_rejects_ineligible_owner_and_preview_disabled() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-observe-rejections"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let preview_disabled = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_stream_observe", "bash", "{}"));
    let preview_disabled_stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(
            &preview_disabled.task_id,
            Arc::new(preview_disabled_stdin.clone()),
        )
        .expect("task exists");
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: preview_disabled.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "preview_disabled".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::stream_text(1).unwrap()),
        },
    )]);
    wait_until(|| preview_disabled_stdin.text().contains("preview_disabled")).await;
    assert!(!service
        .inner
        .task_observer
        .is_observing(&preview_disabled.task_id));
    assert!(preview_disabled_stdin
        .text()
        .contains(r#""code":"preview_disabled""#));

    let subagent_owned = service.inner.background_tasks.start_task(
        NewBackgroundTask::new("call_cross_owner_observe", "bash", "{}")
            .with_owner(TaskOwner::subagent("branch-observe")),
    );
    let subagent_stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&subagent_owned.task_id, Arc::new(subagent_stdin.clone()))
        .expect("task exists");
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: subagent_owned.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "subagent_owner".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    wait_until(|| subagent_stdin.text().contains("owner_not_eligible")).await;
    assert!(!service
        .inner
        .task_observer
        .is_observing(&subagent_owned.task_id));
    assert!(subagent_stdin
        .text()
        .contains(r#""code":"owner_not_eligible""#));

    let events = service.events_after(0);
    assert!(events.iter().any(|event| {
        event.event_type == "task_observer.failed"
            && event.data["error_code"] == json!("preview_disabled")
    }));
    assert!(!events
        .iter()
        .any(|event| event.event_type.starts_with("task_send.")));
}

#[tokio::test]
async fn task_observe_enable_result_write_failure_does_not_activate_and_records_failure_once() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-observe-result-write-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_observe_result_write_failure",
            "bash",
            "{}",
        ));
    let stdin = RejectingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");

    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "enable_write_fails".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);

    wait_until(|| stdin.write_attempted()).await;
    wait_until(|| service.inner.task_observer.slot_count_for_test() == 0).await;
    assert!(stdin.write_attempted());
    assert!(!service.inner.task_observer.is_observing(&task.task_id));
    let events = service.events_after(0);
    let failed = events
        .iter()
        .filter(|event| {
            event.event_type == "task_observer.failed"
                && event.data["task_id"] == task.task_id
                && event.data["request_id"] == "enable_write_fails"
        })
        .collect::<Vec<_>>();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].data["error_code"], "result_write_failed");
    assert!(!events.iter().any(|event| {
        event.event_type == "task_observer.enabled"
            && event.data["task_id"] == task.task_id
            && event.data["request_id"] == "enable_write_fails"
    }));

    let diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(diagnostics["total"], json!(1));
    assert_eq!(diagnostics["by_domain"]["task_observer"], json!(1));
    assert_eq!(diagnostics["by_code"]["result_write_failed"], json!(1));
    assert_eq!(diagnostics["last"]["domain"], "task_observer");
    assert_eq!(diagnostics["last"]["task_id"], task.task_id);
    assert_eq!(diagnostics["last"]["op"], "observe_result");
    assert_eq!(diagnostics["last"]["code"], "result_write_failed");
    assert_eq!(diagnostics["last"]["id"], "enable_write_fails");
}

#[tokio::test(flavor = "current_thread")]
async fn task_observer_writer_failure_and_queue_full_clean_observer_without_task_send_events() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-observe-delivery-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");

    let failing = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_observe_write_failed",
            "bash",
            "{}",
        ));
    service
        .inner
        .background_tasks
        .register_stdin_writer(&failing.task_id, Arc::new(FailingTaskStdin))
        .expect("task exists");
    activate_task_observer_for_test(&service, &failing.task_id, TaskObserveConfig::final_text());
    let before_delivery_seq = service.status().last_event_seq;

    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "writer should fail",
            message_id: Some("assistant-write-fails"),
            cycle_id: None,
        });
    wait_until(|| !service.inner.task_observer.is_observing(&failing.task_id)).await;

    let queued = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_observe_queue_full",
            "bash",
            "{}",
        ));
    let queued_stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&queued.task_id, Arc::new(queued_stdin.clone()))
        .expect("task exists");
    activate_task_observer_for_test(&service, &queued.task_id, TaskObserveConfig::final_text());
    for index in 0..64 {
        service
            .inner
            .task_observer
            .publish_final_text(FinalTextObservation {
                kind: FinalTextObservationKind::AssistantText,
                text: &format!("queue fill {index}"),
                message_id: Some("assistant-queue-full"),
                cycle_id: None,
            });
    }
    wait_until(|| !service.inner.task_observer.is_observing(&queued.task_id)).await;
    wait_until(|| {
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["by_domain"]
            ["task_observer"]
            == json!(3)
    })
    .await;

    let diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(diagnostics["by_domain"]["task_observer"], json!(3));
    assert_eq!(diagnostics["by_code"]["observer_write_failed"], json!(1));
    assert_eq!(diagnostics["by_code"]["observer_write_detail"], json!(1));
    assert_eq!(diagnostics["by_code"]["observer_queue_full"], json!(1));
    assert!(!service
        .events_after(before_delivery_seq)
        .iter()
        .any(|event| event.event_type.starts_with("task_send.")));
}
