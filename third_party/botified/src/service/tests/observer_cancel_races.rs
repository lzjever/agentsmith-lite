#[tokio::test]
async fn tasks_without_frames_leave_no_observer_transition_entries() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-no-frame-task-churn"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    for index in 0..16 {
        let task_id = format!("task_no_frames_{index}");
        assert!(host.publish_task(
            task_id.clone(),
            NewBackgroundTask::new(format!("call_no_frames_{index}"), "bash", "{}"),
        ));
        host.finish_task(
            task_id,
            ToolCall::new(format!("call_no_frames_{index}"), "bash", json!({})),
            DetachedToolResult {
                tool_result: ToolResult::success(format!("call_no_frames_{index}"), "bash", "done"),
                state: TaskState::Completed,
            },
        )
        .await;
    }
    assert_eq!(service.inner.task_observer.transition_count_for_test(), 0);
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queued_observer_enable_cannot_commit_after_shutdown_is_visible() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-observe-queued-shutdown"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_queued_shutdown", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let transition = service.inner.task_observer.transition_for(&task.task_id);
    let transition_guard = transition.lock().await;
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "queued-before-shutdown".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    let control = service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .get(&task.task_id)
        .expect("lane exists")
        .control_for_test();
    control.wait_dequeued(1).await;

    let (commit_entered_tx, commit_entered_rx) = oneshot::channel();
    let commit_entered_tx = Mutex::new(Some(commit_entered_tx));
    let (commit_release_tx, commit_release_rx) = std::sync::mpsc::channel();
    let commit_release_rx = Arc::new(Mutex::new(Some(commit_release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind != TaskFrameAdmissionKind::Observe {
                return;
            }
            if let Some(entered) = commit_entered_tx
                .lock()
                .expect("observer commit entered mutex poisoned")
                .take()
            {
                let _ = entered.send(());
                commit_release_rx
                    .lock()
                    .expect("observer commit release mutex poisoned")
                    .take()
                    .expect("observer commit release receiver exists")
                    .recv_timeout(SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT + Duration::from_secs(5))
                    .expect("observer commit should be released");
            }
        })));

    drop(transition_guard);
    tokio::time::timeout(SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT, commit_entered_rx)
        .await
        .expect("observer handler should reach the commit boundary")
        .expect("observer commit hook should retain the waiter");

    let shutdown_service = service.clone();
    let shutdown = tokio::spawn(async move { shutdown_service.shutdown().await });
    wait_until(|| service.status().state == ServiceState::ShuttingDown).await;

    commit_release_tx
        .send(())
        .expect("observer commit hook should accept release");
    wait_until(|| {
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .is_some_and(|task| task.state == TaskState::Cancelling)
    })
    .await;
    service.inner.background_tasks.finish_task(
        &task.task_id,
        TaskState::Cancelled,
        "test task stopped during shutdown",
    );
    tokio::time::timeout(
        SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT + Duration::from_secs(5),
        shutdown,
    )
    .await
    .expect("shutdown should finish")
    .expect("shutdown task should not panic");
    service.inner.set_task_frame_admission_hook_for_test(None);
    assert!(!stdin.text().contains("queued-before-shutdown"));
    assert!(!service.inner.task_observer.is_observing(&task.task_id));
    assert!(service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .is_empty());
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn observer_result_in_flight_before_shutdown_can_finish_after_status_is_visible() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-observe-in-flight-shutdown"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_observe_in_flight_shutdown",
            "bash",
            "{}",
        ));
    let text = Arc::new(Mutex::new(String::new()));
    let (write_entered_tx, write_entered_rx) = std::sync::mpsc::channel();
    let (write_release_tx, write_release_rx) = std::sync::mpsc::channel();
    service
        .inner
        .background_tasks
        .register_stdin_writer(
            &task.task_id,
            Arc::new(BlockingObserveResultStdin {
                text: text.clone(),
                entered: write_entered_tx,
                release: Arc::new(Mutex::new(Some(write_release_rx))),
                calls: Arc::new(AtomicUsize::new(0)),
            }),
        )
        .expect("task exists");
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "in-flight-before-shutdown".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    tokio::task::spawn_blocking(move || write_entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("observer result waiter should not panic")
        .expect("observer result write should enter the frame commit gate");

    let shutdown_service = service.clone();
    let shutdown = tokio::spawn(async move { shutdown_service.shutdown().await });
    tokio::time::timeout(Duration::from_secs(2), async {
        wait_until(|| service.status().state == ServiceState::ShuttingDown).await;
    })
    .await
    .expect("shutdown status should be visible while observer result write is in flight");
    assert!(
        !shutdown.is_finished(),
        "shutdown cleanup must wait for the in-flight frame commit"
    );

    write_release_tx
        .send(())
        .expect("observer result writer should accept release");
    wait_until(|| {
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .is_some_and(|task| task.state == TaskState::Cancelling)
    })
    .await;
    service.inner.background_tasks.finish_task(
        &task.task_id,
        TaskState::Cancelled,
        "test task stopped during shutdown",
    );
    tokio::time::timeout(
        SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT + Duration::from_secs(5),
        shutdown,
    )
    .await
    .expect("shutdown should finish after the observer result write")
    .expect("shutdown task should not panic");
    assert!(
        text.lock()
            .expect("blocking stdin text mutex poisoned")
            .contains("in-flight-before-shutdown"),
        "a result commit admitted before shutdown may finish"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queued_observer_enable_cannot_commit_after_failed_is_visible() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-observe-queued-failed"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_queued_failed", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let transition = service.inner.task_observer.transition_for(&task.task_id);
    let transition_guard = transition.lock().await;
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "queued-before-failed".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    let control = service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .get(&task.task_id)
        .expect("lane exists")
        .control_for_test();
    control.wait_dequeued(1).await;

    service.inner.mark_failed("forced failure");
    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(!stdin.text().contains("queued-before-failed"));
    assert!(!service.inner.task_observer.is_observing(&task.task_id));

    drop(transition_guard);
    wait_for_service_workers_idle(&service).await;
    assert!(!stdin.text().contains("queued-before-failed"));
    assert!(!service.inner.task_observer.is_observing(&task.task_id));
    assert!(service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .is_empty());
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
}

#[tokio::test]
async fn failed_service_reclaims_active_observer_and_frame_lane() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-active-observer-failed-cleanup"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_active_failed_cleanup",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
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
            id: "enable-before-failed".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    wait_until(|| service.inner.task_observer.is_observing(&task.task_id)).await;

    service.inner.mark_failed("forced failure");
    assert_eq!(service.status().state, ServiceState::Failed);
    wait_until(|| service.inner.task_observer.slot_count_for_test() == 0).await;
    wait_for_service_workers_idle(&service).await;
    assert!(service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .is_empty());
}

#[tokio::test]
async fn task_frame_lane_overflow_is_bounded_diagnostic_and_reclaimed() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-frame-lane-overflow"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_lane_overflow", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let transition = service.inner.task_observer.transition_for(&task.task_id);
    let transition_guard = transition.lock().await;
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };
    bridge.handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "observe-in-flight".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    let control = service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .get(&task.task_id)
        .expect("lane exists")
        .control_for_test();
    control.wait_dequeued(1).await;

    let overflow_count = 4;
    let events = (0..task_bridge::TASK_FRAME_LANE_CAPACITY + overflow_count)
        .map(|index| {
            BotifiedFrameEvent::ObserveRequest(TaskObserveRequestFrame {
                id: format!("observe-{index}"),
                action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
            })
        })
        .collect();
    bridge.handle_frame_events(events);

    let diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(
        diagnostics["by_code"]["task_frame_lane_full"],
        json!(overflow_count)
    );
    assert_eq!(
        service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .service_workers
            .frame_handler_count(),
        1,
        "one lane must retain only one worker guard"
    );
    let overflow_frames = botified_frame_strings(&stdin.text())
        .into_iter()
        .map(|frame| botified_json_from_frame(&frame))
        .collect::<Vec<_>>();
    assert_eq!(overflow_frames.len(), overflow_count);
    for (offset, frame) in overflow_frames.iter().enumerate() {
        assert_eq!(
            frame["id"],
            json!(format!(
                "observe-{}",
                task_bridge::TASK_FRAME_LANE_CAPACITY + offset
            ))
        );
        assert_eq!(frame["ok"], json!(false));
        assert_eq!(frame["exception"]["code"], json!("task_frame_lane_full"));
    }
    assert_eq!(
        service
            .inner
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned")
            .get(&task.task_id)
            .expect("lane exists")
            .capacity(),
        0
    );

    service.cancel_background_task(&task.task_id);
    drop(transition_guard);
    wait_for_service_workers_idle(&service).await;
    assert!(!service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .contains_key(&task.task_id));
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
    assert_eq!(service.inner.task_observer.transition_count_for_test(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lane_full_correlates_requests_without_admitting_business_effects() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-frame-lane-overload-contract"),
        Arc::new(PanicProvider),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_lane_overload_contract",
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
    let release_rx = Mutex::new(release_rx);
    let first = Arc::new(AtomicBool::new(true));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind != TaskFrameAdmissionKind::RegistryGet || !first.swap(false, Ordering::SeqCst) {
                return;
            }
            entered_tx.send(()).expect("test should observe entry");
            release_rx
                .lock()
                .expect("release receiver mutex poisoned")
                .recv()
                .expect("test should release registry get");
        })));
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };
    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "accepted-first".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    tokio::task::spawn_blocking(move || entered_rx.recv())
        .await
        .expect("entry waiter should not panic")
        .expect("registry get should reach the commit barrier");
    bridge.handle_frame_events(
        (0..task_bridge::TASK_FRAME_LANE_CAPACITY)
            .map(|index| {
                BotifiedFrameEvent::RegistryGet(TaskRegistryGetFrame {
                    id: format!("accepted-{index}"),
                    topic: "robot.*".to_owned(),
                    limit: Some(1),
                })
            })
            .collect(),
    );
    bridge.handle_frame_events(vec![
        BotifiedFrameEvent::Ask(TaskRequestFrame {
            id: "overload-ask".to_owned(),
            request: "must not be admitted".to_owned(),
            expect: None,
            timeout: Some(Duration::from_secs(30)),
            urgency: InputUrgency::Normal,
        }),
        BotifiedFrameEvent::RegistryGet(TaskRegistryGetFrame {
            id: "overload-get".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        }),
        BotifiedFrameEvent::ObserveRequest(TaskObserveRequestFrame {
            id: "overload-observe".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        }),
        BotifiedFrameEvent::Tell(TaskTellFrame {
            id: "overload-tell".to_owned(),
            message: "must not be admitted".to_owned(),
            urgency: InputUrgency::Normal,
        }),
        BotifiedFrameEvent::RegistrySet(TaskRegistrySetFrame {
            id: Some("overload-set".to_owned()),
            topic: "robot.overload".to_owned(),
            value: json!({"must_not": "exist"}),
            source: None,
            ttl: crate::registry::RegistryTtl::Default,
            freq_hz: None,
        }),
    ]);

    let overload = botified_frame_strings(&stdin.text())
        .into_iter()
        .map(|frame| botified_json_from_frame(&frame))
        .collect::<Vec<_>>();
    assert_eq!(
        overload.len(),
        3,
        "uncorrelated overloads must not write stdin"
    );
    assert_eq!(overload[0]["op"], json!("reply"));
    assert_eq!(overload[0]["id"], json!("overload-ask"));
    assert_eq!(overload[1]["op"], json!("registry_error"));
    assert_eq!(overload[1]["id"], json!("overload-get"));
    assert_eq!(overload[2]["op"], json!("observe_result"));
    assert_eq!(overload[2]["id"], json!("overload-observe"));
    assert!(service.events_after(0).iter().all(|event| !matches!(
        event.event_type.as_str(),
        "task_ask.requested" | "task_tell.accepted"
    )));
    assert!(store
        .get(RegistryQuery::new("robot.overload"))
        .expect("registry query should succeed")
        .items
        .is_empty());
    assert!(!service.inner.task_observer.is_observing(&task.task_id));

    release_tx
        .send(())
        .expect("registry get should be released");
    wait_until(|| stdin.text().contains("accepted-31")).await;
    let frames = botified_frame_strings(&stdin.text())
        .into_iter()
        .map(|frame| botified_json_from_frame(&frame))
        .collect::<Vec<_>>();
    let accepted_ids = frames
        .iter()
        .filter(|frame| frame["op"] == "registry_snapshot")
        .map(|frame| frame["id"].as_str().expect("response ID").to_owned())
        .collect::<Vec<_>>();
    let expected = std::iter::once("accepted-first".to_owned())
        .chain((0..task_bridge::TASK_FRAME_LANE_CAPACITY).map(|index| format!("accepted-{index}")))
        .collect::<Vec<_>>();
    assert_eq!(accepted_ids, expected);
    service.inner.set_task_frame_admission_hook_for_test(None);
    service.cancel_background_task(&task.task_id);
    wait_for_service_workers_idle(&service).await;
}

#[tokio::test]
async fn shutdown_completes_with_full_task_frame_lane() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-frame-lane-full-shutdown"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_full_shutdown", "bash", "{}"));
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(RecordingTaskStdin::default()))
        .expect("task exists");
    let transition = service.inner.task_observer.transition_for(&task.task_id);
    let transition_guard = transition.lock().await;
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };
    bridge.handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "in-flight-before-full-shutdown".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    let control = service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .get(&task.task_id)
        .expect("lane exists")
        .control_for_test();
    control.wait_dequeued(1).await;

    let events = (0..task_bridge::TASK_FRAME_LANE_CAPACITY)
        .map(|index| {
            BotifiedFrameEvent::ProtocolDiagnostic(TaskFrameDiagnostic {
                op: Some("test".to_owned()),
                code: "flood",
                message: "flood".to_owned(),
                request_id: Some(format!("flood-{index}")),
            })
        })
        .collect();
    bridge.handle_frame_events(events);
    assert_eq!(
        service
            .inner
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned")
            .get(&task.task_id)
            .expect("lane exists")
            .capacity(),
        0,
        "shutdown test must establish a full backlog"
    );

    let status = tokio::time::timeout(
        SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT + Duration::from_secs(5),
        service.shutdown(),
    )
    .await
    .expect("shutdown must not drain an unbounded task frame backlog");
    drop(transition_guard);
    assert_eq!(status.state, ServiceState::ShuttingDown);
    assert_eq!(
        service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .service_workers
            .frame_handler_count(),
        0
    );
    assert!(service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .is_empty());
}

#[tokio::test]
async fn rejected_or_preview_disabled_observe_request_preserves_active_generation() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-stdout-observe-rejected"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_observe_rejected",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };
    bridge.handle_frame_events(vec![
        BotifiedFrameEvent::ObserveRequest(TaskObserveRequestFrame {
            id: "enable".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        }),
        BotifiedFrameEvent::ObserveRequestRejected(TaskObserveRequestRejectedFrame {
            id: "bad_schema".to_owned(),
            exception: crate::tasks::TaskObserveException::new(
                "irrelevant_field",
                "field is irrelevant",
                false,
            ),
        }),
        BotifiedFrameEvent::ObserveRequest(TaskObserveRequestFrame {
            id: "stream_disabled".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::stream_text(8).unwrap()),
        }),
    ]);
    wait_until(|| stdin.text().contains(r#""id":"stream_disabled""#)).await;
    assert_eq!(
        service.inner.task_observer.config_for_task(&task.task_id),
        Some(TaskObserveConfig::final_text())
    );
    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::UserText,
            text: "old generation survives",
            message_id: Some("msg_survives"),
            cycle_id: None,
        });
    wait_until(|| stdin.text().contains("old generation survives")).await;
    let written = stdin.text();
    assert!(written.contains(r#""code":"irrelevant_field""#));
    assert!(written.contains(r#""code":"preview_disabled""#));
    assert!(!written.contains(r#""delivery":"stream_text","source""#));
}

#[tokio::test]
async fn repeated_observe_ids_attempt_valid_and_rejected_results_in_scanner_order() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-observe-repeated-id-order"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_observe_order", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![
        BotifiedFrameEvent::ObserveRequest(TaskObserveRequestFrame {
            id: "same-id".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        }),
        BotifiedFrameEvent::ObserveRequestRejected(TaskObserveRequestRejectedFrame {
            id: "same-id".to_owned(),
            exception: crate::tasks::TaskObserveException::new(
                "irrelevant_field",
                "field is irrelevant",
                false,
            ),
        }),
        BotifiedFrameEvent::ObserveRequest(TaskObserveRequestFrame {
            id: "same-id".to_owned(),
            action: TaskObserveRequestAction::Disable,
        }),
    ]);

    wait_until(|| stdin.text().matches(r#""id":"same-id""#).count() == 3).await;
    let frames = botified_frame_strings(&stdin.text())
        .into_iter()
        .map(|frame| botified_json_from_frame(&frame))
        .collect::<Vec<_>>();
    assert_eq!(frames.len(), 3, "{frames:?}");
    assert_eq!(frames[0]["ok"], json!(true));
    assert_eq!(frames[0]["observing"], json!(true));
    assert_eq!(frames[1]["ok"], json!(false));
    assert_eq!(frames[1]["exception"]["code"], json!("irrelevant_field"));
    assert_eq!(frames[2]["ok"], json!(true));
    assert_eq!(frames[2]["observing"], json!(false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rejected_observe_result_write_linearizes_before_task_cancelling() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-observe-rejected-exit-race"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_observe_exit_race",
            "bash",
            "{}",
        ));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let text = Arc::new(Mutex::new(String::new()));
    service
        .inner
        .background_tasks
        .register_stdin_writer(
            &task.task_id,
            Arc::new(BlockingObserveResultStdin {
                text: text.clone(),
                entered: entered_tx,
                release: Arc::new(Mutex::new(Some(release_rx))),
                calls: Arc::new(AtomicUsize::new(0)),
            }),
        )
        .expect("task exists");
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };
    bridge.handle_frame_events(vec![BotifiedFrameEvent::ObserveRequestRejected(
        TaskObserveRequestRejectedFrame {
            id: "rejected-before-exit".to_owned(),
            exception: crate::tasks::TaskObserveException::new(
                "invalid_observe_request",
                "invalid observer request",
                false,
            ),
        },
    )]);
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("write-boundary waiter should not panic")
        .expect("failure-result write should reach the boundary");

    let cancel_service = service.clone();
    let cancel_task_id = task.task_id.clone();
    let (cancel_done_tx, cancel_done_rx) = std::sync::mpsc::channel();
    let cancel_thread = std::thread::spawn(move || {
        let result = cancel_service.cancel_background_task(&cancel_task_id);
        cancel_done_tx
            .send(result)
            .expect("cancel result receiver should remain open");
    });
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        cancel_done_rx.try_recv().is_err(),
        "task exit must wait for the admitted failure-result write"
    );
    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task remains visible")
            .state,
        TaskState::Running,
        "Cancelling must not become visible before the admitted write completes"
    );

    release_tx
        .send(())
        .expect("failure-result boundary should accept release");
    cancel_done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("cancel should finish after the write")
        .expect("running task should cancel");
    cancel_thread
        .join()
        .expect("cancel thread should not panic");

    let written = text
        .lock()
        .expect("blocking stdin text mutex poisoned")
        .clone();
    assert!(
        written.contains(r#""id":"rejected-before-exit""#),
        "{written}"
    );
    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("cancelled task remains visible")
            .state,
        TaskState::Cancelling
    );

    bridge.handle_frame_events(vec![BotifiedFrameEvent::ObserveRequestRejected(
        TaskObserveRequestRejectedFrame {
            id: "rejected-after-exit".to_owned(),
            exception: crate::tasks::TaskObserveException::new(
                "invalid_observe_request",
                "late invalid observer request",
                false,
            ),
        },
    )]);
    tokio::task::yield_now().await;
    assert!(
        !text
            .lock()
            .expect("blocking stdin text mutex poisoned")
            .contains("rejected-after-exit"),
        "closed admission must not promise or write a late result"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn main_panic_observer_fence_does_not_hold_service_state_or_block_shutdown() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-main-panic-observer-fence"),
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
        state.active_turn_id = Some("turn_panic_fence".to_owned());
        state.active_cancel = Some(CancellationToken::new());
    }
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_main_panic_observer_fence",
            "bash",
            "{}",
        ));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    service
        .inner
        .background_tasks
        .register_stdin_writer(
            &task.task_id,
            Arc::new(BlockingObserveResultStdin {
                text: Arc::new(Mutex::new(String::new())),
                entered: entered_tx,
                release: Arc::new(Mutex::new(Some(release_rx))),
                calls: Arc::new(AtomicUsize::new(0)),
            }),
        )
        .expect("task exists");
    activate_task_observer_for_test(&service, &task.task_id, TaskObserveConfig::final_text());
    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "hold panic cleanup on the observer fence",
            message_id: Some("msg_main_panic_fence"),
            cycle_id: None,
        });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("observer writer waiter should not panic")
        .expect("observer writer should enter");

    let (phase_entered_tx, phase_entered_rx) = std::sync::mpsc::channel();
    let (phase_release_tx, phase_release_rx) = std::sync::mpsc::channel();
    service
        .inner
        .task_observer
        .set_discard_all_before_fence_hook_for_test(move || {
            phase_entered_tx
                .send(())
                .expect("panic fence phase test remains active");
            phase_release_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("panic fence phase should be released");
        });

    let panic_inner = service.inner.clone();
    let panic_thread = std::thread::spawn(move || {
        terminalize_service_loop_panic(
            panic_inner,
            "turn_panic_fence".to_owned(),
            "injected panic".to_owned(),
        );
    });
    tokio::task::spawn_blocking(move || phase_entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("panic fence phase waiter should not panic")
        .expect("panic cleanup should release the observer map before fencing");
    {
        let state = service
            .inner
            .state
            .try_lock()
            .expect("service state must be available at the observer fence phase");
        assert_eq!(state.state, ServiceState::Failed);
    }

    let shutdown_service = service.clone();
    let shutdown = tokio::spawn(async move { shutdown_service.shutdown().await });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if service
                .inner
                .state
                .try_lock()
                .is_ok_and(|state| state.state == ServiceState::ShuttingDown)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("deadman: shutdown did not make ShuttingDown visible");
    assert!(
        !shutdown.is_finished(),
        "shutdown should still await cleanup"
    );

    phase_release_tx
        .send(())
        .expect("panic fence phase should accept release");
    release_tx.send(()).expect("observer writer remains active");
    panic_thread
        .join()
        .expect("panic terminalizer should not panic");
    service
        .inner
        .background_tasks
        .finish_task(&task.task_id, TaskState::Cancelled, "shutdown cleanup")
        .expect("cancelling task should finish");
    assert_eq!(
        shutdown
            .await
            .expect("shutdown task should not panic")
            .state,
        ServiceState::ShuttingDown
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn task_cancel_tool_closes_and_fences_active_observer_before_cancelling() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-cancel-observer-fence"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_task_cancel_observer_fence",
            "bash",
            "{}",
        ));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let text = Arc::new(Mutex::new(String::new()));
    service
        .inner
        .background_tasks
        .register_stdin_writer(
            &task.task_id,
            Arc::new(BlockingObserveResultStdin {
                text: text.clone(),
                entered: entered_tx,
                release: Arc::new(Mutex::new(Some(release_rx))),
                calls: Arc::new(AtomicUsize::new(0)),
            }),
        )
        .expect("task exists");
    activate_task_observer_for_test(&service, &task.task_id, TaskObserveConfig::final_text());
    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "write admitted before cancellation",
            message_id: Some("msg_before_cancel"),
            cycle_id: None,
        });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("observer writer waiter should not panic")
        .expect("observer writer should enter the old write");

    let tool = ServiceTaskCancelTool::new(Arc::downgrade(&service.inner), TaskOwner::Main);
    let (linearized_tx, linearized_rx) = std::sync::mpsc::channel();
    let linearized_tx = Arc::new(Mutex::new(Some(linearized_tx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind == TaskFrameAdmissionKind::Cancel {
                if let Some(sender) = linearized_tx.lock().unwrap().take() {
                    sender.send(()).expect("cancel test remains active");
                }
            }
        })));
    let task_id = task.task_id.clone();
    let cancel = tokio::spawn(async move {
        tool.execute(
            ToolCall::new(
                "cancel_observing_task",
                "task_cancel",
                json!({"task_id": task_id}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
        .expect("task_cancel should return")
    });
    tokio::task::spawn_blocking(move || linearized_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("cancel linearization waiter should not panic")
        .expect("cancel should linearize before observer fencing");
    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task remains visible")
            .state,
        TaskState::Running,
        "Cancelling must not become visible before the observer write fence"
    );
    assert!(
        !cancel.is_finished(),
        "task_cancel must wait for the old writer"
    );
    assert!(
        service
            .inner
            .task_observer
            .admission_closed_for_test(&task.task_id),
        "task_cancel must close observer admission before fencing"
    );

    release_tx
        .send(())
        .expect("observer writer should accept release");
    let result = cancel.await.expect("task_cancel task should not panic");
    service.inner.set_task_frame_admission_hook_for_test(None);
    assert!(!result.is_error, "{result:?}");
    assert_eq!(result.details["state"], json!("cancelling"));
    assert!(!service.inner.task_observer.is_observing(&task.task_id));

    let written_at_cancel = text
        .lock()
        .expect("blocking stdin text mutex poisoned")
        .clone();
    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "must not write after cancelling",
            message_id: Some("msg_after_cancel"),
            cycle_id: None,
        });
    assert_eq!(
        *text.lock().expect("blocking stdin text mutex poisoned"),
        written_at_cancel,
        "no observe write may complete after task_cancel returns"
    );
    wait_until(|| service.inner.task_observer.slot_count_for_test() == 0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn subagent_task_cancel_fences_observer_before_cancelling() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-task-cancel-fence"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let owner = TaskOwner::subagent("cancel-fence-owner");
    let task = service.inner.background_tasks.start_task(
        NewBackgroundTask::new("call_subagent_cancel_fence", "bash", "{}")
            .with_owner(owner.clone()),
    );
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    service
        .inner
        .background_tasks
        .register_stdin_writer(
            &task.task_id,
            Arc::new(BlockingObserveResultStdin {
                text: Arc::new(Mutex::new(String::new())),
                entered: entered_tx,
                release: Arc::new(Mutex::new(Some(release_rx))),
                calls: Arc::new(AtomicUsize::new(0)),
            }),
        )
        .expect("task exists");
    activate_task_observer_for_test(&service, &task.task_id, TaskObserveConfig::final_text());
    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "subagent write before cancellation",
            message_id: Some("msg_subagent_before_cancel"),
            cycle_id: None,
        });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .unwrap()
        .expect("observer writer should enter");

    let tool = ServiceTaskCancelTool::new(Arc::downgrade(&service.inner), owner);
    let task_id = task.task_id.clone();
    let cancel = tokio::spawn(async move {
        tool.execute(
            ToolCall::new(
                "subagent_cancel",
                "task_cancel",
                json!({"task_id": task_id}),
            ),
            ToolExecutionContext::new("."),
            CancellationToken::new(),
        )
        .await
    });
    wait_until(|| {
        service
            .inner
            .task_observer
            .admission_closed_for_test(&task.task_id)
    })
    .await;
    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .unwrap()
            .state,
        TaskState::Running
    );
    assert!(!cancel.is_finished());

    release_tx.send(()).expect("observer writer remains active");
    let result = cancel.await.expect("cancel task should not panic");
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .unwrap()
            .state,
        TaskState::Cancelling
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_cleans_fence_state_when_task_is_pruned_before_second_lookup() {
    for (case, owner) in [
        ("main", TaskOwner::Main),
        ("subagent", TaskOwner::subagent("pruned-cancel-owner")),
    ] {
        let service = Service::new(
            AgentConfig::new("system").with_session(format!("service-pruned-cancel-{case}")),
            Arc::new(PanicProvider),
            Vec::new(),
        )
        .expect("service construction should succeed");
        let task_id = format!("task_pruned_during_cancel_{case}");
        let task = service.inner.background_tasks.start_task_with_id(
            task_id.clone(),
            NewBackgroundTask::new(format!("call_pruned_cancel_{case}"), "bash", "{}")
                .with_owner(owner.clone()),
        );
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        service
            .inner
            .background_tasks
            .register_stdin_writer(
                &task_id,
                Arc::new(BlockingObserveResultStdin {
                    text: Arc::new(Mutex::new(String::new())),
                    entered: entered_tx,
                    release: Arc::new(Mutex::new(Some(release_rx))),
                    calls: Arc::new(AtomicUsize::new(0)),
                }),
            )
            .expect("task exists");
        activate_task_observer_for_test(&service, &task_id, TaskObserveConfig::final_text());
        service
            .inner
            .task_observer
            .publish_final_text(FinalTextObservation {
                kind: FinalTextObservationKind::AssistantText,
                text: "hold cancellation on the observer write fence",
                message_id: Some("msg_pruned_cancel"),
                cycle_id: None,
            });
        tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
            .await
            .expect("observer writer waiter should not panic")
            .expect("observer writer should enter");

        let cancel_service = service.clone();
        let cancel_owner = owner.clone();
        let cancel_task_id = task_id.clone();
        let cancel = tokio::task::spawn_blocking(move || {
            cancel_service
                .inner
                .cancel_background_task_by_owner(&cancel_owner, &cancel_task_id)
        });
        wait_until(|| {
            service
                .inner
                .task_observer
                .admission_closed_for_test(&task_id)
        })
        .await;

        service
            .inner
            .background_tasks
            .finish_task(
                &task_id,
                TaskState::Completed,
                "completed during cancel fence",
            )
            .expect("task should complete while cancellation is fenced");
        service
            .inner
            .background_tasks
            .set_callback_delivery(&task_id, CallbackDelivery::Delivered);
        assert_eq!(
            service
                .inner
                .background_tasks
                .prune(SystemTime::now() + Duration::from_secs(24 * 60 * 60)),
            1,
            "{case}"
        );

        release_tx.send(()).expect("observer writer remains active");
        assert!(
            cancel
                .await
                .expect("cancel worker should not panic")
                .is_none(),
            "{case}"
        );
        {
            let admission = service.inner.task_frame_admission_gate.lock().unwrap();
            assert!(!admission.finishing_tasks.contains(&task_id), "{case}");
            assert!(!admission.discarding_tasks.contains(&task_id), "{case}");
        }
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

        ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task_id.clone(),
        }
        .handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
            TaskObserveRequestFrame {
                id: format!("late_observe_{case}"),
                action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
            },
        )]);
        wait_for_service_workers_idle(&service).await;
        assert_eq!(
            service.inner.task_observer.slot_count_for_test(),
            0,
            "{case}"
        );

        service.inner.background_tasks.start_task_with_id(
            task.task_id.clone(),
            NewBackgroundTask::new(format!("call_reused_{case}"), "bash", "{}").with_owner(owner),
        );
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(RecordingTaskStdin::default()))
            .expect("reused task exists");
        activate_task_observer_for_test(&service, &task.task_id, TaskObserveConfig::final_text());
        assert!(
            service.inner.task_observer.is_observing(&task.task_id),
            "{case}"
        );
        service
            .inner
            .task_observer
            .retire_and_wait(&task.task_id)
            .await;
        service.inner.task_observer.cleanup_terminal(&task.task_id);
    }
}

#[tokio::test]
async fn sync_cancel_in_runtime_discards_paused_handler_before_return_fence() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-runtime-sync-cancel-fence"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_runtime_sync_cancel_fence",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let transition = service.inner.task_observer.transition_for(&task.task_id);
    let transition_guard = transition.lock().await;

    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "must-be-discarded".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);

    let cancelled = service
        .cancel_background_task(&task.task_id)
        .expect("task should exist");
    assert_eq!(cancelled["state"], json!("cancelling"));
    assert!(
        stdin.text().is_empty(),
        "cancel fence must not write a result"
    );
    assert!(!service.events_after(0).iter().any(|event| {
        event.event_type.starts_with("task_observer.")
            && event.data["request_id"] == json!("must-be-discarded")
    }));

    drop(transition_guard);
    wait_for_service_workers_idle(&service).await;
    assert!(stdin.text().is_empty(), "discarded handler must stay inert");
    assert!(!service.inner.task_observer.is_observing(&task.task_id));
    assert!(service.inner.task_frame_lanes.lock().unwrap().is_empty());
    assert_eq!(service.inner.task_observer.transition_count_for_test(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn task_ask_cancel_win_fences_final_enqueue_before_cancel_returns() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-ask-cancel-win"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_task_ask_cancel_win",
            "bash",
            "{}",
        ));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind == TaskFrameAdmissionKind::TaskInputBeforeFinal {
                entered_tx
                    .send(())
                    .expect("ask cancel-win test remains active");
                if let Some(receiver) = release_rx.lock().unwrap().take() {
                    receiver
                        .recv()
                        .expect("ask final commit should be released");
                }
            }
        })));
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::Ask(TaskRequestFrame {
        id: "cancel-win-ask".to_owned(),
        request: "must not enqueue".to_owned(),
        expect: None,
        timeout: Some(Duration::from_secs(30)),
        urgency: InputUrgency::Normal,
    })]);
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("ask cancel-win waiter should not panic")
        .expect("ask should reach the pre-final boundary");
    let control = service
        .inner
        .task_frame_lanes
        .lock()
        .unwrap()
        .get(&task.task_id)
        .unwrap()
        .control_for_test();

    let cancelled = service
        .cancel_background_task(&task.task_id)
        .expect("task cancellation should succeed");
    assert_eq!(cancelled["state"], json!("cancelling"));
    release_tx.send(()).expect("ask handler remains paused");
    tokio::time::timeout(Duration::from_secs(2), control.wait_done())
        .await
        .expect("discarded ask lane should retire");
    service.inner.set_task_frame_admission_hook_for_test(None);

    assert_eq!(service.status().queue_length, 0);
    assert!(!service.events_after(0).iter().any(|event| {
        event.event_type == "message.received" && event.data["input_kind"] == json!("task_request")
    }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn task_tell_commit_win_finishes_final_commit_before_cancel_linearizes() {
    let home = service_test_home("task-tell-commit-win");
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
        let mut state = service.inner.state.lock().unwrap();
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_task_tell_commit_win".to_owned());
        state.active_cancel = Some(CancellationToken::new());
    }
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_task_tell_commit_win",
            "bash",
            "{}",
        ));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind == TaskFrameAdmissionKind::TaskInputFinal {
                entered_tx
                    .send(())
                    .expect("tell commit-win test remains active");
                if let Some(receiver) = release_rx.lock().unwrap().take() {
                    receiver
                        .recv()
                        .expect("tell final commit should be released");
                }
            }
        })));
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::Tell(TaskTellFrame {
        id: "commit-win-tell".to_owned(),
        message: "must enqueue before cancel".to_owned(),
        urgency: InputUrgency::Normal,
    })]);
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("tell commit-win waiter should not panic")
        .expect("tell should hold the final commit gate");
    let control = service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .get(&task.task_id)
        .expect("tell frame lane should remain active")
        .control_for_test();

    let (cancel_started_tx, cancel_started_rx) = std::sync::mpsc::channel();
    let (cancel_done_tx, cancel_done_rx) = std::sync::mpsc::channel();
    let cancel_service = service.clone();
    let cancel_task_id = task.task_id.clone();
    let cancel = tokio::task::spawn_blocking(move || {
        cancel_started_tx.send(()).unwrap();
        let result = cancel_service.cancel_background_task(&cancel_task_id);
        cancel_done_tx.send(()).unwrap();
        result
    });
    cancel_started_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("cancel caller should start");
    assert!(matches!(
        cancel_done_rx.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));

    release_tx.send(()).expect("tell handler remains paused");
    cancel
        .await
        .expect("cancel worker should not panic")
        .expect("task cancellation should succeed");
    cancel_done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("cancel should finish after final commit");
    tokio::time::timeout(Duration::from_secs(2), control.wait_done())
        .await
        .expect("tell frame lane should finish after final commit");
    service.inner.set_task_frame_admission_hook_for_test(None);

    let events = service.events_after(0);
    let received = events
        .iter()
        .filter(|event| {
            event.event_type == "message.received" && event.data["input_kind"] == json!("task_tell")
        })
        .collect::<Vec<_>>();
    assert_eq!(received.len(), 1, "task tell must be received exactly once");
    let message_id = received[0].data["message_id"]
        .as_str()
        .expect("received task tell should expose its message id");
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "task_tell.queued"
                    && event.data["tell_id"] == json!("commit-win-tell")
            })
            .count(),
        1,
        "task tell commit event must be written exactly once"
    );
    let state = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned");
    assert_eq!(
        state
            .input_queue
            .iter()
            .filter(|queued| queued.id == message_id)
            .count(),
        1,
        "committed task tell must remain queued exactly once"
    );
    drop(state);
    let accepted = fs::read_to_string(session_path)
        .expect("session should read")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("session line should parse"))
        .filter(|entry| entry["type"] == "accepted_input" && entry["message_id"] == message_id)
        .count();
    assert_eq!(accepted, 1, "task tell must be durable exactly once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn public_cancel_retires_active_observer_without_thread_runtime() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-cancel-observer-no-runtime"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_cancel_observer_no_runtime",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
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
            id: "enable_before_cancel".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    wait_until(|| {
        stdin.text().contains(r#""id":"enable_before_cancel""#)
            && service.inner.task_observer.is_observing(&task.task_id)
    })
    .await;

    let cancel_service = service.clone();
    let cancel_task_id = task.task_id.clone();
    let result = std::thread::spawn(move || {
        assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "cancellation thread must not have an entered Tokio runtime"
        );
        cancel_service.cancel_background_task(&cancel_task_id)
    })
    .join()
    .expect("public cancellation thread should not panic")
    .expect("running task should cancel");

    assert_eq!(result["state"], json!("cancelling"));
    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("cancelled task remains visible")
            .state,
        TaskState::Cancelling
    );
    let written_at_cancel = stdin.text();
    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "must not write after no-runtime cancellation",
            message_id: Some("msg_after_no_runtime_cancel"),
            cycle_id: None,
        });
    wait_until(|| {
        service.inner.task_observer.slot_count_for_test() == 0
            && !service
                .inner
                .task_frame_lanes
                .lock()
                .expect("task frame lanes mutex poisoned")
                .contains_key(&task.task_id)
    })
    .await;
    assert!(!service.inner.task_observer.is_observing(&task.task_id));
    assert_eq!(stdin.text(), written_at_cancel, "no post-cancel frame");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn public_cancel_fences_retirement_started_by_observer_replacement() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-cancel-replacement-retirement"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_cancel_replacement_retirement",
            "bash",
            "{}",
        ));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    service
        .inner
        .background_tasks
        .register_stdin_writer(
            &task.task_id,
            Arc::new(BlockingObserveResultStdin {
                text: Arc::new(Mutex::new(String::new())),
                entered: entered_tx,
                release: Arc::new(Mutex::new(Some(release_rx))),
                calls: Arc::new(AtomicUsize::new(0)),
            }),
        )
        .expect("task exists");
    activate_task_observer_for_test(&service, &task.task_id, TaskObserveConfig::final_text());
    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "old generation write",
            message_id: Some("msg_old_generation"),
            cycle_id: None,
        });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("observer writer waiter should not panic")
        .expect("old generation writer should enter");

    let retired = service
        .inner
        .task_observer
        .retire(&task.task_id)
        .expect("replacement should begin old generation retirement");
    let cancel_service = service.clone();
    let cancel_task_id = task.task_id.clone();
    let (cancel_done_tx, cancel_done_rx) = std::sync::mpsc::channel();
    let cancel_started = Arc::new(std::sync::Barrier::new(2));
    let cancel_thread_started = cancel_started.clone();
    let cancel_thread = std::thread::spawn(move || {
        cancel_thread_started.wait();
        cancel_done_tx
            .send(cancel_service.cancel_background_task(&cancel_task_id))
            .expect("cancel receiver should remain open");
    });
    cancel_started.wait();
    assert!(
        cancel_done_rx.try_recv().is_err(),
        "public cancellation must join replacement retirement"
    );
    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task remains visible")
            .state,
        TaskState::Running,
        "replacement retirement must be fenced before Cancelling becomes visible"
    );

    release_tx
        .send(())
        .expect("old generation writer should accept release");
    let result = cancel_done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("public cancellation should finish after the old writer");
    cancel_thread
        .join()
        .expect("public cancellation thread should not panic");
    assert_eq!(
        result.expect("task should exist")["state"],
        json!("cancelling")
    );
    retired.wait().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disable_losing_result_race_to_cancel_discards_lifecycle() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-disable-cancel-lifecycle"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_disable_cancel_lifecycle",
            "bash",
            "{}",
        ));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let text = Arc::new(Mutex::new(String::new()));
    let write_calls = Arc::new(AtomicUsize::new(0));
    service
        .inner
        .background_tasks
        .register_stdin_writer(
            &task.task_id,
            Arc::new(BlockingObserveResultStdin {
                text: text.clone(),
                entered: entered_tx,
                release: Arc::new(Mutex::new(Some(release_rx))),
                calls: write_calls.clone(),
            }),
        )
        .expect("task exists");
    activate_task_observer_for_test(&service, &task.task_id, TaskObserveConfig::final_text());
    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "old write before disable",
            message_id: Some("msg_before_disable"),
            cycle_id: None,
        });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("observer writer waiter should not panic")
        .expect("old observer write should enter");

    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "disable_loses_to_cancel".to_owned(),
            action: TaskObserveRequestAction::Disable,
        },
    )]);
    wait_until(|| {
        service
            .inner
            .task_observer
            .retirement_generation_for_test(&task.task_id)
            .is_some()
    })
    .await;

    let cancel_service = service.clone();
    let cancel_task_id = task.task_id.clone();
    let cancel_thread =
        std::thread::spawn(move || cancel_service.cancel_background_task(&cancel_task_id));
    wait_until(|| {
        service
            .inner
            .task_observer
            .admission_closed_for_test(&task.task_id)
    })
    .await;
    release_tx
        .send(())
        .expect("old observer write should accept release");
    assert!(
        cancel_thread
            .join()
            .expect("public cancellation thread should not panic")
            .is_some(),
        "task should cancel"
    );
    wait_for_service_workers_idle(&service).await;
    wait_until(|| service.inner.task_observer.slot_count_for_test() == 0).await;
    let lifecycle = service
        .events_after(0)
        .into_iter()
        .filter(|event| {
            event.event_type.starts_with("task_observer.")
                && event.data["request_id"] == json!("disable_loses_to_cancel")
        })
        .collect::<Vec<_>>();
    assert!(
        lifecycle.is_empty(),
        "discarded handler wrote: {lifecycle:#?}"
    );
    assert!(
        !text
            .lock()
            .expect("blocking stdin text mutex poisoned")
            .contains("disable_loses_to_cancel"),
        "disable must not attempt a result frame after admission closes"
    );
    assert_eq!(write_calls.load(Ordering::SeqCst), 1);
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
    assert!(
        !service
            .inner
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned")
            .contains_key(&task.task_id),
        "cancelled task must not retain its observer frame lane"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn observer_admission_cannot_resurrect_lane_after_task_cancels() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-observe-lane-admission-race"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_observe_lane_admission_race",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");

    let transition = service.inner.task_observer.transition_for(&task.task_id);
    let transition_guard = transition.lock().await;

    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind != TaskFrameAdmissionKind::Observe {
                return;
            }
            entered_tx
                .send(())
                .expect("observer admission waiter should remain open");
            if let Some(release_rx) = release_rx
                .lock()
                .expect("observer admission release mutex poisoned")
                .take()
            {
                release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("observer admission should be released");
            }
        })));

    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };
    let frame_task = tokio::spawn(async move {
        bridge.handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
            TaskObserveRequestFrame {
                id: "enable-before-cancel".to_owned(),
                action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
            },
        )]);
    });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("observer admission waiter should not panic")
        .expect("observer frame should pause before lane enqueue");

    let cancel_service = service.clone();
    let cancel_task_id = task.task_id.clone();
    let (cancel_done_tx, cancel_done_rx) = std::sync::mpsc::channel();
    let cancel_thread = std::thread::spawn(move || {
        let result = cancel_service.cancel_background_task(&cancel_task_id);
        cancel_done_tx
            .send(result)
            .expect("cancel result receiver should remain open");
    });
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        cancel_done_rx.try_recv().is_err(),
        "task cancellation must wait for observer lane admission to enqueue"
    );

    release_tx
        .send(())
        .expect("observer admission should accept release");
    frame_task.await.expect("frame task should not panic");
    cancel_done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("cancel should finish after observer admission");
    cancel_thread
        .join()
        .expect("cancel thread should not panic");
    service.inner.set_task_frame_admission_hook_for_test(None);
    drop(transition_guard);
    wait_until(|| {
        service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .service_workers
            .frame_handler_count()
            == 0
    })
    .await;

    assert!(
        !service
            .inner
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned")
            .contains_key(&task.task_id),
        "closed task admission must not retain or recreate an observer lane"
    );
    assert!(
        !stdin.text().contains("enable-before-cancel"),
        "cancellation must not produce a post-terminal observer result"
    );
}
