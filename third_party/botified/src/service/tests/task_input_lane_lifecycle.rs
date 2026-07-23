#[tokio::test]
async fn task_originated_input_cannot_recover_failed_service_but_user_input_can() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-failed-task-input-source"),
        Arc::new(TextProvider("recovered by user")),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_failed_task_input",
            "bash",
            "{}",
        ));
    service.inner.mark_failed("forced failure");

    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![
        BotifiedFrameEvent::Ask(TaskRequestFrame {
            id: "failed-ask".to_owned(),
            request: "must not recover".to_owned(),
            expect: None,
            timeout: Some(Duration::from_secs(30)),
            urgency: InputUrgency::Normal,
        }),
        BotifiedFrameEvent::Tell(TaskTellFrame {
            id: "failed-tell".to_owned(),
            message: "must not recover".to_owned(),
            urgency: InputUrgency::Normal,
        }),
    ]);
    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(service.inner.task_frame_lanes.lock().unwrap().is_empty());
    assert!(!service.events_after(0).iter().any(|event| {
        matches!(
            event.event_type.as_str(),
            "task_ask.requested" | "task_tell.accepted"
        )
    }));

    service
        .enqueue(
            "external-recovery",
            vec![ContentPart::text("recover from outside")],
        )
        .await
        .expect("external user input should retain recovery contract");
    wait_for_service_idle(&service).await;
    assert_eq!(service.status().state, ServiceState::Idle);
    service.cancel_background_task(&task.task_id);
}

#[tokio::test]
async fn task_input_final_commit_failure_rolls_back_fenced_ask_and_tell_before_recovery() {
    for (case, source, metadata) in [
        (
            "ask",
            InputSource::TaskRequest,
            QueuedInputMetadata::TaskRequest {
                task_id: "fenced-task".to_owned(),
                request_id: "fenced-ask".to_owned(),
            },
        ),
        (
            "tell",
            InputSource::TaskTell,
            QueuedInputMetadata::TaskTell {
                task_id: "fenced-task".to_owned(),
                tell_id: "fenced-tell".to_owned(),
            },
        ),
    ] {
        let provider = Arc::new(CapturingProvider::default());
        let service = Service::new(
            AgentConfig::new("system")
                .with_session(format!("service-task-final-commit-rollback-{case}")),
            provider.clone(),
            Vec::new(),
        )
        .expect("service construction should succeed");
        let task = service.inner.background_tasks.start_task_with_id(
            "fenced-task".to_owned(),
            NewBackgroundTask::new(format!("call_fenced_{case}"), "bash", "{}"),
        );
        let message_id = format!("fenced-{case}-input");
        let fenced_text = format!("fenced {case} must never reach provider");

        let attempt = enqueue_task_input_inner(
            &service.inner,
            &task.task_id,
            message_id.clone(),
            vec![ContentPart::text(fenced_text.clone())],
            source,
            InputUrgency::Normal,
            Some(metadata),
            || {
                Err(FailedTransitionIntent {
                    message: format!("injected {case} final commit failure"),
                    clear_active_turn: false,
                })
            },
        )
        .await;

        assert!(attempt.outcome.is_err(), "{case}");
        assert_eq!(service.status().state, ServiceState::Failed, "{case}");
        {
            let state = service.inner.state.lock().unwrap();
            assert_eq!(state.input_queue.len(), 0, "{case}");
            assert!(!state.message_index.contains_key(&message_id), "{case}");
            assert_eq!(state.next_turn_number, 1, "{case}");
            assert_eq!(state.active_turn_id, None, "{case}");
            assert!(state.active_cancel.is_none(), "{case}");
            assert!(state.known_user_messages.is_empty(), "{case}");
        }

        service
            .enqueue(
                format!("recover-after-fenced-{case}"),
                vec![ContentPart::text(format!("recover after {case}"))],
            )
            .await
            .expect("user input should recover the failed service");
        wait_for_service_idle(&service).await;

        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 1, "{case}");
        let transcript = format!("{:?}", requests[0].transcript_messages());
        assert!(!transcript.contains(&fenced_text), "{case}: {transcript}");
    }
}

#[tokio::test]
async fn urgent_task_input_final_commit_failure_preserves_active_turn_before_recovery() {
    let provider = Arc::new(CapturingProvider::default());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-urgent-task-final-commit-rollback"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let active_cancel = CancellationToken::new();
    {
        let mut state = service.inner.state.lock().unwrap();
        state.state = ServiceState::Running;
        state.next_turn_number = 7;
        state.active_turn_id = Some("turn_existing".to_owned());
        state.active_cancel = Some(active_cancel.clone());
        state.known_user_messages.push(replay_known_message(0));
    }
    let task = service.inner.background_tasks.start_task_with_id(
        "urgent-fenced-task".to_owned(),
        NewBackgroundTask::new("call_urgent_fenced", "bash", "{}"),
    );
    let message_id = "urgent-fenced-input".to_owned();

    let attempt = enqueue_task_input_inner(
        &service.inner,
        &task.task_id,
        message_id.clone(),
        vec![ContentPart::text("urgent input must remain fenced")],
        InputSource::TaskTell,
        InputUrgency::Urgent,
        Some(QueuedInputMetadata::TaskTell {
            task_id: task.task_id.clone(),
            tell_id: "urgent-fenced-tell".to_owned(),
        }),
        || {
            Err(FailedTransitionIntent {
                message: "injected urgent final commit failure".to_owned(),
                clear_active_turn: false,
            })
        },
    )
    .await;

    assert!(attempt.outcome.is_err());
    assert_eq!(service.status().state, ServiceState::Failed);
    {
        let state = service.inner.state.lock().unwrap();
        assert_eq!(state.input_queue.len(), 0);
        assert!(!state.message_index.contains_key(&message_id));
        assert_eq!(state.next_turn_number, 7);
        assert_eq!(state.active_turn_id.as_deref(), Some("turn_existing"));
        assert!(state
            .active_cancel
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled));
        assert_eq!(
            state
                .known_user_messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["msg_0"]
        );
    }
    assert!(active_cancel.is_cancelled());

    service
        .enqueue(
            "recover-after-urgent-fence",
            vec![ContentPart::text("recover after urgent fence")],
        )
        .await
        .expect("user input should recover the failed service");
    wait_for_service_idle(&service).await;

    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let transcript = format!("{:?}", requests[0].transcript_messages());
    assert!(!transcript.contains("urgent input must remain fenced"));
    assert!(transcript.contains("recover after urgent fence"));
}

#[tokio::test]
async fn durable_task_input_survives_projection_failure_for_ask_tell_normal_and_urgent() {
    for (case, source, urgency, metadata) in [
        (
            "ask-normal",
            InputSource::TaskRequest,
            InputUrgency::Normal,
            QueuedInputMetadata::TaskRequest {
                task_id: "projection-task".to_owned(),
                request_id: "ask-normal".to_owned(),
            },
        ),
        (
            "ask-urgent",
            InputSource::TaskRequest,
            InputUrgency::Urgent,
            QueuedInputMetadata::TaskRequest {
                task_id: "projection-task".to_owned(),
                request_id: "ask-urgent".to_owned(),
            },
        ),
        (
            "tell-normal",
            InputSource::TaskTell,
            InputUrgency::Normal,
            QueuedInputMetadata::TaskTell {
                task_id: "projection-task".to_owned(),
                tell_id: "tell-normal".to_owned(),
            },
        ),
        (
            "tell-urgent",
            InputSource::TaskTell,
            InputUrgency::Urgent,
            QueuedInputMetadata::TaskTell {
                task_id: "projection-task".to_owned(),
                tell_id: "tell-urgent".to_owned(),
            },
        ),
    ] {
        let home = service_test_home(&format!("task-input-projection-{case}"));
        let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
            .expect("session should open");
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
            let mut state = service.inner.state.lock().unwrap();
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_projection".to_owned());
            state.active_cancel = Some(CancellationToken::new());
        }
        service.inner.background_tasks.start_task_with_id(
            "projection-task".to_owned(),
            NewBackgroundTask::new(format!("call_{case}"), "bash", "{}"),
        );
        let message_id = format!("input-{case}");
        service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);

        let attempt = enqueue_task_input_inner(
            &service.inner,
            "projection-task",
            message_id.clone(),
            vec![ContentPart::text(format!("committed {case}"))],
            source,
            urgency,
            Some(metadata),
            || Ok(()),
        )
        .await;

        assert!(attempt.outcome.is_err(), "{case}");
        assert_eq!(service.status().state, ServiceState::Failed, "{case}");
        assert!(service.events_after(0).iter().all(|event| {
            !matches!(
                event.event_type.as_str(),
                "task_ask.rejected" | "task_tell.rejected"
            )
        }));
        drop(service);
        let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
            .expect("session should reopen");
        assert_eq!(reopened.pending_messages().len(), 1, "{case}");
        assert_eq!(reopened.pending_messages()[0].id, message_id, "{case}");
    }
}

#[tokio::test]
async fn task_originated_final_enqueue_commit_cannot_race_failed_into_running() {
    let cases = vec![
        (
            InputSource::TaskRequest,
            Some(QueuedInputMetadata::TaskRequest {
                task_id: "race-task".to_owned(),
                request_id: "race-ask".to_owned(),
            }),
        ),
        (
            InputSource::TaskTell,
            Some(QueuedInputMetadata::TaskTell {
                task_id: "race-task".to_owned(),
                tell_id: "race-tell".to_owned(),
            }),
        ),
        (
            InputSource::TaskCallback,
            Some(test_task_callback_metadata("race-task")),
        ),
        (
            InputSource::SubagentCallback,
            Some(QueuedInputMetadata::SubagentCallback {
                subagent_id: "race-subagent".to_owned(),
                kind: "completed".to_owned(),
                task_id: None,
                ask_id: None,
                tell_id: None,
                task_message: None,
                label: Some("worker".to_owned()),
                summary: Some("race work".to_owned()),
            }),
        ),
    ];

    for (index, (source, metadata)) in cases.into_iter().enumerate() {
        assert!(
            valid_input_metadata(source, metadata.as_ref()),
            "race case must reach accepted-input persistence: source={source:?}"
        );
        let recorder = Arc::new(BlockingAcceptedInputRecorder::new());
        let service = Service::with_initial_context(
            AgentConfig::new("system")
                .with_session(format!("service-task-failed-final-race-{index}")),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Some(recorder.clone()),
        )
        .expect("service construction should succeed");
        let inner = service.inner.clone();
        let enqueue = tokio::spawn(async move {
            enqueue_input_inner_with_failure(
                &inner,
                format!("race-input-{index}"),
                vec![ContentPart::text("must not recover Failed")],
                source,
                InputUrgency::Normal,
                metadata,
            )
            .await
        });
        recorder.entered.cancelled().await;
        service
            .inner
            .mark_failed("failed during accepted-input persistence");
        recorder.release.cancel();
        let attempt = enqueue.await.expect("enqueue task should not panic");

        assert!(attempt.outcome.is_err(), "source={source:?}");
        assert!(attempt.start_cancel.is_none(), "source={source:?}");
        assert_eq!(
            service.status().state,
            ServiceState::Failed,
            "source={source:?}"
        );
        assert_eq!(service.status().queue_length, 0, "source={source:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn task_input_persistence_and_failed_transition_share_admission_then_state_lock_order() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-input-persistence-lock-order"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_task_input_persistence_lock_order",
            "bash",
            "{}",
        ));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind != TaskFrameAdmissionKind::TaskInputPersistence {
                return;
            }
            entered_tx
                .send(())
                .expect("persistence lock-order test remains active");
            if let Some(receiver) = release_rx
                .lock()
                .expect("persistence hook release mutex poisoned")
                .take()
            {
                receiver
                    .recv_timeout(Duration::from_secs(5))
                    .expect("persistence preparation should be released");
            }
        })));

    let enqueue_inner = service.inner.clone();
    let enqueue_task_id = task.task_id.clone();
    let enqueue = tokio::spawn(async move {
        enqueue_task_input_inner(
            &enqueue_inner,
            &enqueue_task_id,
            "lock-order-input".to_owned(),
            vec![ContentPart::text("lock order")],
            InputSource::TaskTell,
            InputUrgency::Normal,
            Some(QueuedInputMetadata::TaskTell {
                task_id: enqueue_task_id.clone(),
                tell_id: "lock-order-tell".to_owned(),
            }),
            || Ok(()),
        )
        .await
    });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("persistence hook waiter should not panic")
        .expect("enqueue should pause after taking admission and before taking state");

    let status_service = service.clone();
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::task::spawn_blocking(move || status_service.status()),
    )
    .await
    .expect("state must remain available while enqueue holds admission")
    .expect("status probe should not panic");

    let (failure_started_tx, failure_started_rx) = std::sync::mpsc::channel();
    let failure_inner = service.inner.clone();
    let failed = tokio::task::spawn_blocking(move || {
        failure_started_tx
            .send(())
            .expect("failed transition waiter remains active");
        failure_inner.mark_failed("concurrent persistence lock-order failure");
    });
    tokio::task::spawn_blocking(move || {
        failure_started_rx.recv_timeout(Duration::from_secs(2))
    })
    .await
    .expect("failed transition start waiter should not panic")
    .expect("failed transition should start while persistence is paused");
    assert!(
        !failed.is_finished(),
        "failed transition must wait behind task-input admission"
    );

    release_tx
        .send(())
        .expect("persistence preparation should accept release");
    tokio::time::timeout(Duration::from_secs(2), async {
        enqueue.await.expect("enqueue task should not panic");
        failed.await.expect("failed transition should not panic");
    })
    .await
    .expect("enqueue and failed transition must not deadlock");
    service.inner.set_task_frame_admission_hook_for_test(None);

    assert_eq!(service.status().state, ServiceState::Failed);
}

#[tokio::test]
async fn task_frame_timeline_failures_leave_gate_before_canonical_failed_transition() {
    let cases = vec![
        (
            "ask",
            BotifiedFrameEvent::Ask(TaskRequestFrame {
                id: "failure-ask".to_owned(),
                request: "fail persistence".to_owned(),
                expect: None,
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            }),
        ),
        (
            "tell",
            BotifiedFrameEvent::Tell(TaskTellFrame {
                id: "failure-tell".to_owned(),
                message: "fail persistence".to_owned(),
                urgency: InputUrgency::Normal,
            }),
        ),
        (
            "diagnostic",
            BotifiedFrameEvent::Diagnostic(TaskFrameDiagnostic {
                op: Some("ask".to_owned()),
                code: "invalid_request",
                message: "fail persistence".to_owned(),
                request_id: Some("failure-diagnostic".to_owned()),
            }),
        ),
        (
            "observe",
            BotifiedFrameEvent::ObserveRequest(TaskObserveRequestFrame {
                id: "failure-observe".to_owned(),
                action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
            }),
        ),
    ];

    for (case, event) in cases {
        let service = Service::new(
            AgentConfig::new("system").with_session(format!("service-frame-failure-{case}")),
            Arc::new(PanicProvider),
            Vec::new(),
        )
        .expect("service construction should succeed");
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                format!("call_frame_failure_{case}"),
                "bash",
                "{}",
            ));
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(RecordingTaskStdin::default()))
            .expect("task exists");
        service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

        ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task.task_id.clone(),
        }
        .handle_frame_events(vec![event]);

        tokio::time::timeout(
            Duration::from_secs(2),
            service.wait_for_state(ServiceState::Failed),
        )
        .await
        .unwrap_or_else(|_| panic!("{case} persistence failure deadlocked"));
        wait_for_service_workers_idle(&service).await;
        assert_eq!(
            service
                .inner
                .background_tasks
                .get(&task.task_id)
                .expect("task remains visible")
                .state,
            TaskState::Cancelling,
            "{case}"
        );
        assert!(
            service.inner.task_frame_lanes.lock().unwrap().is_empty(),
            "{case}"
        );
        let admission = service.inner.task_frame_admission_gate.lock().unwrap();
        assert!(!admission.finishing_tasks.contains(&task.task_id), "{case}");
        assert!(
            !admission.discarding_tasks.contains(&task.task_id),
            "{case}"
        );
        drop(admission);
        assert_eq!(
            service.inner.task_observer.slot_count_for_test(),
            0,
            "{case}"
        );
        assert_eq!(
            service.inner.task_observer.transition_count_for_test(),
            0,
            "{case}"
        );
    }
}

#[tokio::test]
async fn natural_finish_drains_accepted_mixed_frames_before_terminal_publication() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-natural-finish-drain"),
        Arc::new(TextProvider("drained task input")),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    let task_id = "natural_finish_drain".to_owned();
    assert!(host.publish_task(
        task_id.clone(),
        NewBackgroundTask::new("call_natural_finish_drain", "bash", "{}"),
    ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let transition = service.inner.task_observer.transition_for(&task_id);
    let transition_guard = transition.lock().await;

    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task_id.clone(),
    }
    .handle_frame_events(vec![
        BotifiedFrameEvent::ObserveRequest(TaskObserveRequestFrame {
            id: "drain-observe".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        }),
        BotifiedFrameEvent::Tell(TaskTellFrame {
            id: "drain-tell".to_owned(),
            message: "accepted before natural exit".to_owned(),
            urgency: InputUrgency::Normal,
        }),
        BotifiedFrameEvent::RegistryGet(TaskRegistryGetFrame {
            id: "drain-registry".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        }),
    ]);

    let finish = tokio::spawn(async move {
        let mut result = ToolResult::success("call_natural_finish_drain", "bash", "done");
        result.details = json!({"kind": "background_task_ack_aborted"});
        host.finish_task(
            task_id,
            ToolCall::new("call_natural_finish_drain", "bash", json!({})),
            DetachedToolResult {
                tool_result: result,
                state: TaskState::Completed,
            },
        )
        .await;
    });
    wait_until(|| {
        service
            .inner
            .task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned")
            .finishing_tasks
            .contains("natural_finish_drain")
    })
    .await;
    assert_eq!(
        service
            .inner
            .background_tasks
            .get("natural_finish_drain")
            .expect("task remains registered")
            .state,
        TaskState::Running,
        "terminal state must wait for accepted handlers"
    );

    drop(transition_guard);
    finish.await.expect("finish task should not panic");
    let events = service.events_after(0);
    let observe = events
        .iter()
        .position(|event| event.event_type == "task_observer.enabled")
        .expect("accepted observer request must drain");
    let tell = events
        .iter()
        .position(|event| event.event_type == "task_tell.accepted")
        .expect("accepted tell must drain");
    let terminal = events
        .iter()
        .position(|event| event.event_type == "task.completed")
        .expect("terminal event must be published");
    assert!(observe < tell && tell < terminal, "events: {events:#?}");
    let written = stdin.text();
    assert!(written.contains("drain-observe"));
    assert!(written.contains("drain-registry"));
    assert!(service.inner.task_frame_lanes.lock().unwrap().is_empty());
    assert_eq!(service.inner.task_observer.transition_count_for_test(), 0);
}

#[tokio::test]
async fn managed_task_exit_reclaims_its_persistent_frame_lane() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-managed-exit-frame-lane"),
        Arc::new(PanicProvider),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    let task_id = "managed_exit_lane".to_owned();
    assert!(host.publish_task(
        task_id.clone(),
        NewBackgroundTask::new("call_managed_exit_lane", "bash", "{}"),
    ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "before-exit".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    wait_until(|| stdin.text().contains("before-exit")).await;
    assert_eq!(
        service
            .inner
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned")
            .len(),
        1
    );

    let mut result = ToolResult::success("call_managed_exit_lane", "bash", "done");
    result.details = json!({"kind": "background_task_ack_aborted"});
    host.finish_task(
        task_id.clone(),
        ToolCall::new("call_managed_exit_lane", "bash", json!({})),
        DetachedToolResult {
            tool_result: result,
            state: TaskState::Completed,
        },
    )
    .await;
    wait_for_service_workers_idle(&service).await;

    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task_id)
            .expect("task remains visible")
            .state,
        TaskState::Completed
    );
    assert!(service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .is_empty());
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn managed_finish_tombstone_blocks_frames_until_terminal_cleanup() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-finish-tombstone"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_finish_tombstone",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind != TaskFrameAdmissionKind::Finish {
                return;
            }
            entered_tx
                .send(())
                .expect("finish hook waiter should remain open");
            if let Some(release_rx) = release_rx
                .lock()
                .expect("finish hook release mutex poisoned")
                .take()
            {
                release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("finish hook should be released");
            }
        })));
    let inner = service.inner.clone();
    let task_id = task.task_id.clone();
    let finish = tokio::spawn(async move {
        let mut result = ToolResult::success("call_finish_tombstone", "bash", "done");
        result.details = json!({"kind": "background_task_ack_aborted"});
        ServiceBackgroundExecutionHost {
            inner,
            owner: TaskOwner::Main,
        }
        .finish_task(
            task_id,
            ToolCall::new("call_finish_tombstone", "bash", json!({})),
            DetachedToolResult {
                tool_result: result,
                state: TaskState::Completed,
            },
        )
        .await;
    });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("finish hook waiter should not panic")
        .expect("finish should enter the tombstone window");

    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "finish-window".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    assert!(!stdin.text().contains("finish-window"));
    assert!(!service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .contains_key(&task.task_id));

    release_tx
        .send(())
        .expect("finish hook should accept release");
    finish.await.expect("finish task should complete");
    service.inner.set_task_frame_admission_hook_for_test(None);
    wait_for_service_workers_idle(&service).await;
    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task remains visible")
            .state,
        TaskState::Completed
    );
    assert!(!service
        .inner
        .task_frame_admission_gate
        .lock()
        .expect("task frame admission gate mutex poisoned")
        .finishing_tasks
        .contains(&task.task_id));
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
    assert_eq!(service.inner.task_observer.transition_count_for_test(), 0);
}
