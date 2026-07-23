#[tokio::test]
async fn mixed_task_stdout_events_wait_for_prior_handler_in_scanner_order() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdout-mixed-order"),
        Arc::new(TextProvider("mixed order complete")),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_mixed_order", "bash", "{}"));
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
    .handle_frame_events(vec![
        BotifiedFrameEvent::Ask(TaskRequestFrame {
            id: "ask-first".to_owned(),
            request: "first".to_owned(),
            expect: None,
            timeout: Some(Duration::from_secs(30)),
            urgency: InputUrgency::Normal,
        }),
        BotifiedFrameEvent::ObserveRequest(TaskObserveRequestFrame {
            id: "observe-second".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        }),
        BotifiedFrameEvent::Tell(TaskTellFrame {
            id: "tell-third".to_owned(),
            message: "third".to_owned(),
            urgency: InputUrgency::Normal,
        }),
        BotifiedFrameEvent::RegistryGet(TaskRegistryGetFrame {
            id: "registry-fourth".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        }),
    ]);

    wait_until(|| {
        service.events_after(0).iter().any(|event| {
            event.event_type == "task_ask.requested" && event.data["ask_id"] == json!("ask-first")
        })
    })
    .await;
    assert!(
        !service.events_after(0).iter().any(|event| {
            event.event_type == "task_tell.accepted" && event.data["tell_id"] == json!("tell-third")
        }),
        "tell must not pass a prior blocked observe handler"
    );
    assert!(
        !stdin.text().contains("registry-fourth"),
        "registry get must not pass a prior blocked observe handler"
    );

    drop(transition_guard);
    wait_until(|| stdin.text().contains("registry-fourth")).await;
    let events = service.events_after(0);
    let ask = events
        .iter()
        .position(|event| event.event_type == "task_ask.requested")
        .expect("ask effect");
    let observe = events
        .iter()
        .position(|event| event.event_type == "task_observer.enabled")
        .expect("observe effect");
    let tell = events
        .iter()
        .position(|event| event.event_type == "task_tell.accepted")
        .expect("tell effect");
    assert!(ask < observe && observe < tell, "events: {events:?}");
    let frames = botified_frame_strings(&stdin.text())
        .into_iter()
        .map(|frame| botified_json_from_frame(&frame))
        .collect::<Vec<_>>();
    let observe = frames
        .iter()
        .position(|frame| frame["id"] == "observe-second")
        .expect("observe result");
    let registry = frames
        .iter()
        .position(|frame| frame["id"] == "registry-fourth")
        .expect("registry result");
    assert!(observe < registry, "frames: {frames:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn blocked_task_frame_lane_does_not_block_another_task_lane() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-independent-task-frame-lanes"),
        Arc::new(PanicProvider),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let tasks = ["call_lane_a", "call_lane_b"].map(|call_id| {
        service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(call_id, "bash", "{}"))
    });
    let stdins = [RecordingTaskStdin::default(), RecordingTaskStdin::default()];
    for (task, stdin) in tasks.iter().zip(&stdins) {
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
    }

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
            entered_tx.send(()).expect("task A waiter remains open");
            release_rx
                .lock()
                .expect("task A release mutex poisoned")
                .recv_timeout(Duration::from_secs(5))
                .expect("task A handler should be released");
        })));

    let send_get = |task_id: &str, request_id: &str| {
        ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task_id.to_owned(),
        }
        .handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
            TaskRegistryGetFrame {
                id: request_id.to_owned(),
                topic: "robot.*".to_owned(),
                limit: Some(1),
            },
        )]);
    };
    send_get(&tasks[0].task_id, "task-a-get");
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("task A entry waiter should not panic")
        .expect("task A should reach the commit barrier");

    send_get(&tasks[1].task_id, "task-b-get");
    wait_until(|| stdins[1].text().contains("task-b-get")).await;
    assert!(!stdins[0].text().contains("task-a-get"));
    {
        let lanes = service
            .inner
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned");
        assert_eq!(lanes.len(), 2);
        let lane_a = lanes
            .get(&tasks[0].task_id)
            .expect("task A lane exists")
            .control_for_test();
        let lane_b = lanes
            .get(&tasks[1].task_id)
            .expect("task B lane exists")
            .control_for_test();
        assert!(!Arc::ptr_eq(&lane_a, &lane_b));
    }

    release_tx
        .send(())
        .expect("task A handler should accept release");
    wait_until(|| stdins[0].text().contains("task-a-get")).await;
    service.inner.set_task_frame_admission_hook_for_test(None);
    for task in &tasks {
        service.cancel_background_task(&task.task_id);
    }
    wait_for_service_workers_idle(&service).await;
    assert!(service.inner.task_frame_lanes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn ordinary_task_frames_keep_one_persistent_lane_without_observer_slots() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-persistent-task-frame-lane"),
        Arc::new(TextProvider("ordinary frames processed")),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_persistent_lane", "bash", "{}"));
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
        BotifiedFrameEvent::Ask(TaskRequestFrame {
            id: "ask-first".to_owned(),
            request: "first request".to_owned(),
            expect: None,
            timeout: Some(Duration::from_secs(30)),
            urgency: InputUrgency::Normal,
        }),
        BotifiedFrameEvent::Tell(TaskTellFrame {
            id: "tell-first".to_owned(),
            message: "first notification".to_owned(),
            urgency: InputUrgency::Normal,
        }),
        BotifiedFrameEvent::RegistryGet(TaskRegistryGetFrame {
            id: "first".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        }),
    ]);
    wait_until(|| stdin.text().contains(r#""id":"first""#)).await;
    assert!(service.events_after(0).iter().any(|event| {
        event.event_type == "task_ask.requested" && event.data["ask_id"] == json!("ask-first")
    }));
    assert!(service.events_after(0).iter().any(|event| {
        event.event_type == "task_tell.accepted" && event.data["tell_id"] == json!("tell-first")
    }));
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
    assert_eq!(
        service
            .inner
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned")
            .len(),
        1
    );

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "second".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    wait_until(|| stdin.text().contains(r#""id":"second""#)).await;
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
    assert_eq!(
        service
            .inner
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned")
            .len(),
        1,
        "idle periods must not tear down and recreate the task lane"
    );

    service.cancel_background_task(&task.task_id);
    wait_for_service_workers_idle(&service).await;
    assert!(service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .is_empty());
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
}

#[tokio::test]
async fn task_frame_lane_spawn_failure_drops_caller_owned_closure_without_relocking_map() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-frame-lane-spawn-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_spawn_failure", "bash", "{}"));
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

    service.inner.fail_next_task_frame_lane_spawn_for_test();
    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "injected-spawn-failure".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    assert!(service.inner.task_frame_lanes.lock().unwrap().is_empty());
    assert_eq!(
        service
            .inner
            .state
            .lock()
            .unwrap()
            .service_workers
            .frame_handler_count(),
        0,
        "failed spawn must release its worker guard"
    );
    assert!(!stdin.text().contains("injected-spawn-failure"));

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "spawn-retry".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    wait_until(|| stdin.text().contains("spawn-retry")).await;
    assert_eq!(service.inner.task_frame_lanes.lock().unwrap().len(), 1);

    service.cancel_background_task(&task.task_id);
    wait_for_service_workers_idle(&service).await;
    assert!(service.inner.task_frame_lanes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dropping_service_closes_lane_sender_and_signals_actor_done() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-drop-frame-lane"),
        Arc::new(PanicProvider),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_drop_lane", "bash", "{}"));
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
    .handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "drop-lane".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    wait_until(|| stdin.text().contains("drop-lane")).await;
    let control = service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .get(&task.task_id)
        .expect("lane exists")
        .control_for_test();

    drop(service);
    tokio::time::timeout(Duration::from_secs(2), control.wait_done())
        .await
        .expect("dropping the last sender must stop the actor");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registry_commits_are_dropped_after_terminal_service_publication() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-registry-set-failed-fence"),
        Arc::new(PanicProvider),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_set_fence",
            "bash",
            "{}",
        ));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind != TaskFrameAdmissionKind::RegistrySet {
                return;
            }
            entered_tx
                .send(())
                .expect("registry set waiter remains open");
            if let Some(release_rx) = release_rx
                .lock()
                .expect("registry set release mutex poisoned")
                .take()
            {
                release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("registry set commit should be released");
            }
        })));
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
        TaskRegistrySetFrame {
            id: Some("set-after-failed".to_owned()),
            topic: "robot.after_failed".to_owned(),
            value: json!({"committed": true}),
            source: None,
            ttl: crate::registry::RegistryTtl::Default,
            freq_hz: None,
        },
    )]);
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("registry set waiter should not panic")
        .expect("registry set should reach commit boundary");

    service.inner.mark_failed("forced failure");
    assert_eq!(service.status().state, ServiceState::Failed);
    release_tx
        .send(())
        .expect("registry set should accept release");
    wait_for_service_workers_idle(&service).await;
    assert_eq!(
        store
            .get(RegistryQuery::new("robot.after_failed"))
            .expect("registry query should succeed")
            .returned_count,
        0
    );
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);

    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    store
        .set(
            RegistryWriterKind::WebsocketClient,
            "ws:test",
            crate::registry::RegistrySetRequest::new("robot.pose", json!({"x": 1}), "test"),
        )
        .expect("registry seed should succeed");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-registry-get-shutdown-fence"),
        Arc::new(PanicProvider),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_get_fence",
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
            if kind != TaskFrameAdmissionKind::RegistryGet {
                return;
            }
            entered_tx
                .send(())
                .expect("registry get waiter remains open");
            if let Some(release_rx) = release_rx
                .lock()
                .expect("registry get release mutex poisoned")
                .take()
            {
                release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("registry get commit should be released");
            }
        })));
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id,
    }
    .handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "get-after-shutdown".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("registry get waiter should not panic")
        .expect("registry get should reach commit boundary");

    let shutdown_service = service.clone();
    let shutdown = tokio::spawn(async move { shutdown_service.shutdown().await });
    wait_until(|| service.status().state == ServiceState::ShuttingDown).await;
    release_tx
        .send(())
        .expect("registry get should accept release");
    shutdown.await.expect("shutdown should not panic");
    assert!(stdin.text().is_empty());
    assert!(service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .is_empty());
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn registry_delete_commit_is_dropped_after_task_terminal_fence() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    store
        .set(
            RegistryWriterKind::WebsocketClient,
            "ws:test",
            crate::registry::RegistrySetRequest::new("robot.keep", json!(1), "test"),
        )
        .expect("registry seed should succeed");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-registry-delete-fence"),
        Arc::new(PanicProvider),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_delete_fence",
            "bash",
            "{}",
        ));
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind == TaskFrameAdmissionKind::RegistryDelete {
                entered_tx.send(()).expect("delete waiter remains open");
                release_rx
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
            }
        })));
    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![BotifiedFrameEvent::RegistryDelete(
        crate::tasks::TaskRegistryDeleteFrame {
            id: Some("delete-after-terminal".to_owned()),
            topic: "robot.keep".to_owned(),
        },
    )]);
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .unwrap()
        .expect("delete reaches commit boundary");
    service.cancel_background_task(&task.task_id);
    release_tx.send(()).expect("delete accepts release");
    wait_for_service_workers_idle(&service).await;
    assert_eq!(
        store
            .get(RegistryQuery::new("robot.keep"))
            .unwrap()
            .returned_count,
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn start_pending_persistence_failure_fences_task_frames_before_failed_visibility() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-start-pending-failed-fence"),
        Arc::new(TextProvider("restarted pending input")),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_start_pending_failed_fence",
            "bash",
            "{}",
        ));
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(RecordingTaskStdin::default()))
        .expect("task exists");
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };
    bridge.handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "observe-before-start-failure".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    wait_until(|| service.inner.task_observer.is_observing(&task.task_id)).await;

    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind != TaskFrameAdmissionKind::RegistrySet {
                return;
            }
            entered_tx
                .send(())
                .expect("registry set waiter remains open");
            if let Some(release_rx) = release_rx
                .lock()
                .expect("registry set release mutex poisoned")
                .take()
            {
                release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("registry set commit should be released");
            }
        })));
    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
        TaskRegistrySetFrame {
            id: Some("set-during-start-failure".to_owned()),
            topic: "robot.start_pending_failed".to_owned(),
            value: json!({"committed": true}),
            source: None,
            ttl: crate::registry::RegistryTtl::Default,
            freq_hz: None,
        },
    )]);
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("registry set waiter should not panic")
        .expect("registry set should reach commit boundary");

    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Failed;
        state.input_queue.enqueue(QueuedMessage {
            id: "pending-after-start-failure".to_owned(),
            content: vec![ContentPart::text("resume pending work")],
            source: InputSource::User,
            urgency: InputUrgency::Normal,
            metadata: None,
            cursor_seq: service.inner.last_event_seq(),
            delivery: None,
        });
    }
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);
    let status = service.start_pending_if_needed().await;

    assert_eq!(status.state, ServiceState::Failed);
    release_tx
        .send(())
        .expect("registry set should accept release");
    wait_for_service_workers_idle(&service).await;
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
    assert_eq!(
        store
            .get(RegistryQuery::new("robot.start_pending_failed"))
            .expect("registry query should succeed")
            .returned_count,
        0
    );

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;
    assert!(service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .is_empty());
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
    service.cancel_background_task(&task.task_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn locked_timeline_failure_fences_task_frames_before_failed_visibility() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-locked-timeline-failed-fence"),
        Arc::new(TextProvider("restart after timeline failure")),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_locked_timeline_failed_fence",
            "bash",
            "{}",
        ));
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(RecordingTaskStdin::default()))
        .expect("task exists");
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };
    bridge.handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "observe-before-locked-failure".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    wait_until(|| service.inner.task_observer.is_observing(&task.task_id)).await;

    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind != TaskFrameAdmissionKind::RegistrySet {
                return;
            }
            entered_tx
                .send(())
                .expect("registry set waiter remains open");
            if let Some(release_rx) = release_rx
                .lock()
                .expect("registry set release mutex poisoned")
                .take()
            {
                release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("registry set commit should be released");
            }
        })));
    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
        TaskRegistrySetFrame {
            id: Some("set-during-locked-failure".to_owned()),
            topic: "robot.locked_timeline_failed".to_owned(),
            value: json!({"committed": true}),
            source: None,
            ttl: crate::registry::RegistryTtl::Default,
            freq_hz: None,
        },
    )]);
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("registry set waiter should not panic")
        .expect("registry set should reach commit boundary");

    let host = ServiceBackgroundExecutionHost {
        inner: service.inner.clone(),
        owner: TaskOwner::Main,
    };
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);
    assert!(!host.publish_task(
        "task_locked_timeline_failure".to_owned(),
        NewBackgroundTask::new("call_locked_timeline_failure", "bash", "{}"),
    ));

    assert_eq!(service.status().state, ServiceState::Failed);
    release_tx
        .send(())
        .expect("registry set should accept release");
    wait_for_service_workers_idle(&service).await;
    assert_eq!(service.inner.task_observer.slot_count_for_test(), 0);
    assert_eq!(
        store
            .get(RegistryQuery::new("robot.locked_timeline_failed"))
            .expect("registry query should succeed")
            .returned_count,
        0
    );

    service
        .enqueue(
            "restart-after-locked-timeline-failure",
            vec![ContentPart::text("restart")],
        )
        .await
        .expect("restart input should enqueue");
    wait_for_service_idle(&service).await;
    assert!(service
        .inner
        .task_frame_lanes
        .lock()
        .expect("task frame lanes mutex poisoned")
        .is_empty());
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
    service.cancel_background_task(&task.task_id);
}
