#[tokio::test]
async fn service_registry_set_stdio_writes_store_without_agent_side_effects() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-set"),
        provider.clone(),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let main_task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_set_main",
            "bash",
            "{}",
        ));
    let subagent_task = service.inner.background_tasks.start_task(
        NewBackgroundTask::new("call_registry_set_subagent", "bash", "{}")
            .with_owner(TaskOwner::subagent("subagent-a")),
    );
    let before_seq = service.status().last_event_seq;
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: main_task.task_id.clone(),
    };

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
        TaskRegistrySetFrame {
            id: Some("pose-1".to_owned()),
            topic: "robot.pose".to_owned(),
            value: json!({"x": 1}),
            source: Some("localization".to_owned()),
            ttl: crate::registry::RegistryTtl::Default,
            freq_hz: Some(20.0),
        },
    )]);
    let subagent_bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: subagent_task.task_id.clone(),
    };
    subagent_bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
        TaskRegistrySetFrame {
            id: None,
            topic: "robot.subagent".to_owned(),
            value: json!({"ready": true}),
            source: None,
            ttl: crate::registry::RegistryTtl::Default,
            freq_hz: None,
        },
    )]);

    wait_until(|| {
        store
            .get(RegistryQuery::new("robot.*").with_limit(10))
            .is_ok_and(|result| result.returned_count == 2)
    })
    .await;

    let result = store
        .get(RegistryQuery::new("robot.*").with_limit(10))
        .expect("registry get should succeed");
    let pose = result
        .items
        .iter()
        .find(|item| item.topic == "robot.pose")
        .expect("pose item should be present");
    assert_eq!(pose.writer_kind, RegistryWriterKind::ManagedTask);
    assert_eq!(pose.origin, format!("task:{}", main_task.task_id));
    assert_eq!(pose.source, "localization");
    let subagent = result
        .items
        .iter()
        .find(|item| item.topic == "robot.subagent")
        .expect("subagent item should be present");
    assert_eq!(subagent.writer_kind, RegistryWriterKind::ManagedTask);
    assert_eq!(
        subagent.origin,
        format!("subagent:subagent-a/task:{}", subagent_task.task_id)
    );
    assert_eq!(subagent.source, "bash");
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status().queue_length, 0);
    let events = service.events_after(before_seq);
    assert!(
        events.is_empty(),
        "successful registry_set should not write timeline events: {events:?}"
    );
}

#[tokio::test]
async fn service_registry_delete_stdio_preserves_lane_order_and_has_no_agent_side_effects() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let mut changes = store.subscribe_changes();
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-delete"),
        provider.clone(),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_registry_delete", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let before_seq = service.status().last_event_seq;
    let before_context_len = service_context_len(&service);
    let before_active_items = service.timeline_bootstrap_snapshot()["active_items"].clone();
    let before_task_requests = task_request_count(&service, &task.task_id);

    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    }
    .handle_frame_events(vec![
        BotifiedFrameEvent::RegistrySet(TaskRegistrySetFrame {
            id: Some("set-first".to_owned()),
            topic: "robot.pose".to_owned(),
            value: json!({"x": 1}),
            source: None,
            ttl: crate::registry::RegistryTtl::Default,
            freq_hz: None,
        }),
        BotifiedFrameEvent::RegistryDelete(crate::tasks::TaskRegistryDeleteFrame {
            id: Some("delete-second".to_owned()),
            topic: "robot.pose".to_owned(),
        }),
        BotifiedFrameEvent::RegistryGet(TaskRegistryGetFrame {
            id: "get-third".to_owned(),
            topic: "robot.pose".to_owned(),
            limit: Some(1),
        }),
    ]);

    wait_until(|| stdin.text().contains("get-third")).await;
    let set_change = changes.recv().await.expect("set change");
    let delete_change = changes.recv().await.expect("delete change");
    assert!(matches!(
        set_change,
        crate::registry::RegistryChange::Set { .. }
    ));
    match delete_change {
        crate::registry::RegistryChange::Delete {
            topic,
            writer_kind,
            origin,
            ..
        } => {
            assert_eq!(topic, "robot.pose");
            assert_eq!(writer_kind, RegistryWriterKind::ManagedTask);
            assert_eq!(origin, format!("task:{}", task.task_id));
        }
        other => panic!("expected delete change, got {other:?}"),
    }
    let frames = botified_frame_strings(&stdin.text());
    assert_eq!(
        frames.len(),
        1,
        "set/delete must not write stdin ack: {frames:?}"
    );
    let snapshot = botified_json_from_frame(&frames[0]);
    assert_eq!(snapshot["id"], "get-third");
    assert_eq!(snapshot["returned_count"], 0);
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status().queue_length, 0);
    assert!(service.events_after(before_seq).is_empty());
    assert_eq!(service_context_len(&service), before_context_len);
    assert_eq!(
        service.timeline_bootstrap_snapshot()["active_items"],
        before_active_items
    );
    assert_eq!(
        task_request_count(&service, &task.task_id),
        before_task_requests
    );
}

#[tokio::test]
async fn service_registry_delete_handles_noop_disabled_store_error_and_missing_writer() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    store
        .set(
            RegistryWriterKind::WebsocketClient,
            "ws:test",
            crate::registry::RegistrySetRequest::new("robot.pose", json!(1), "test"),
        )
        .expect("registry seed should succeed");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-delete-no-writer"),
        Arc::new(PanicProvider),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_delete_no_writer",
            "bash",
            "{}",
        ));
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id,
    };
    bridge.handle_frame_events(vec![
        BotifiedFrameEvent::RegistryDelete(crate::tasks::TaskRegistryDeleteFrame {
            id: Some("delete-existing".to_owned()),
            topic: "robot.pose".to_owned(),
        }),
        BotifiedFrameEvent::RegistryDelete(crate::tasks::TaskRegistryDeleteFrame {
            id: Some("delete-noop".to_owned()),
            topic: "robot.pose".to_owned(),
        }),
        BotifiedFrameEvent::RegistryDelete(crate::tasks::TaskRegistryDeleteFrame {
            id: Some("delete-invalid".to_owned()),
            topic: "robot.*".to_owned(),
        }),
    ]);
    wait_until(|| {
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["total"] == json!(1)
    })
    .await;
    assert_eq!(
        store
            .get(RegistryQuery::new("robot.pose"))
            .unwrap()
            .returned_count,
        0
    );
    let diagnostics = &service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"];
    assert_eq!(diagnostics["by_domain"]["task_stdio_registry"], 1);
    assert_eq!(diagnostics["last"]["op"], "registry_delete");
    assert_eq!(diagnostics["last"]["id"], "delete-invalid");
    assert_eq!(diagnostics["last"]["code"], "invalid_topic");

    let disabled = Service::new(
        AgentConfig::new("system").with_session("service-delete-disabled"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let disabled_task = disabled
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_delete_disabled", "bash", "{}"));
    ServiceInteractiveStdioBridge {
        inner: disabled.inner.clone(),
        task_id: disabled_task.task_id,
    }
    .handle_frame_events(vec![BotifiedFrameEvent::RegistryDelete(
        crate::tasks::TaskRegistryDeleteFrame {
            id: None,
            topic: "robot.pose".to_owned(),
        },
    )]);
    wait_until(|| {
        disabled.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["total"] == json!(1)
    })
    .await;
    let disabled_diagnostic =
        &disabled.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["last"];
    assert_eq!(disabled_diagnostic["code"], "registry_disabled");
    assert_eq!(disabled_diagnostic["op"], "registry_delete");
    assert_eq!(disabled_diagnostic["id"], Value::Null);
}

#[tokio::test]
async fn registry_delete_lane_overflow_records_diagnostic_without_stdin_response() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-delete-lane-full"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_delete_lane_full",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .unwrap();
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
        .unwrap()
        .get(&task.task_id)
        .unwrap()
        .control_for_test();
    control.wait_dequeued(1).await;
    let mut events = (0..task_bridge::TASK_FRAME_LANE_CAPACITY)
        .map(|index| {
            BotifiedFrameEvent::RegistryDelete(crate::tasks::TaskRegistryDeleteFrame {
                id: Some(format!("queued-{index}")),
                topic: format!("robot.queued{index}"),
            })
        })
        .collect::<Vec<_>>();
    events.push(BotifiedFrameEvent::RegistryDelete(
        crate::tasks::TaskRegistryDeleteFrame {
            id: Some("overflow-delete".to_owned()),
            topic: "robot.overflow".to_owned(),
        },
    ));
    bridge.handle_frame_events(events);
    let diagnostics = &service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"];
    assert_eq!(diagnostics["by_code"]["task_frame_lane_full"], 1);
    assert_eq!(diagnostics["last"]["domain"], "task_stdio_registry");
    assert_eq!(diagnostics["last"]["op"], "registry_delete");
    assert_eq!(diagnostics["last"]["id"], "overflow-delete");
    assert!(stdin.text().is_empty());
    service.cancel_background_task(&task.task_id);
    drop(transition_guard);
    wait_for_service_workers_idle(&service).await;
}

#[tokio::test]
async fn service_registry_get_stdio_writes_snapshot_and_error_without_agent_side_effects() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    store
        .set(
            RegistryWriterKind::WebsocketClient,
            "ws:test",
            crate::registry::RegistrySetRequest::new(
                "robot.pose",
                json!({"x": 1, "y": 2}),
                "localization",
            ),
        )
        .expect("seed registry set should succeed");
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-get"),
        provider.clone(),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_registry_get", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let before_seq = service.status().last_event_seq;
    let before_context_len = service_context_len(&service);
    let before_active_items = service.timeline_bootstrap_snapshot()["active_items"].clone();
    let before_task_requests = task_request_count(&service, &task.task_id);
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "read-1".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(10),
        },
    )]);

    wait_until(|| stdin.text().contains("\"op\":\"registry_snapshot\"")).await;
    let snapshot = first_botified_json(&stdin.text());
    assert_eq!(snapshot["op"], json!("registry_snapshot"));
    assert_eq!(snapshot["id"], json!("read-1"));
    assert_eq!(snapshot["returned_count"], json!(1));
    assert_eq!(snapshot["items"][0]["topic"], json!("robot.pose"));
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status().queue_length, 0);
    assert!(
        service.events_after(before_seq).is_empty(),
        "registry_get success must not write timeline events: {:?}",
        service.events_after(before_seq)
    );
    assert_eq!(service_context_len(&service), before_context_len);
    assert_eq!(
        service.timeline_bootstrap_snapshot()["active_items"],
        before_active_items
    );
    assert_eq!(
        task_request_count(&service, &task.task_id),
        before_task_requests
    );

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "bad-limit".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(store.config().max_query_limit + 1),
        },
    )]);

    wait_until(|| stdin.text().contains("\"op\":\"registry_error\"")).await;
    assert!(stdin.text().contains("\"id\":\"bad-limit\""));
    assert!(stdin.text().contains("\"code\":\"query_too_large\""));
    assert_eq!(provider.calls(), 0);
    assert!(
        service.events_after(before_seq).is_empty(),
        "registry_get error must not write timeline events: {:?}",
        service.events_after(before_seq)
    );
    assert_eq!(service_context_len(&service), before_context_len);
    assert_eq!(
        service.timeline_bootstrap_snapshot()["active_items"],
        before_active_items
    );
    assert_eq!(
        task_request_count(&service, &task.task_id),
        before_task_requests
    );
}

#[test]
fn service_registry_get_missing_writer_records_bounded_diagnostic_without_agent_side_effects() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let query = "robot.super_secret_query_detail";
    store
        .set_at(
            RegistryWriterKind::WebsocketClient,
            "ws:test",
            crate::registry::RegistrySetRequest::new(query, json!(1), "test")
                .with_ttl(crate::registry::RegistryTtl::Seconds(1.0)),
            SystemTime::now() - Duration::from_secs(2),
        )
        .expect("expired registry seed should remain pending lazy prune");
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-missing-writer"),
        provider.clone(),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_missing_writer",
            "bash",
            "{}",
        ));
    let before_seq = service.status().last_event_seq;
    let before_context_len = service_context_len(&service);
    let before_active_items = service.inner.timeline_bootstrap_snapshot()["active_items"].clone();
    let before_task_requests = task_request_count(&service, &task.task_id);
    let before_registry_stats = store.stats();
    assert_eq!(before_registry_stats.current_topics, 1);
    assert_eq!(before_registry_stats.expire_total, 0);
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime should build");

    runtime.block_on(async {
        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
            TaskRegistryGetFrame {
                id: "read-missing-writer".to_owned(),
                topic: query.to_owned(),
                limit: Some(1),
            },
        )]);

        wait_until(|| {
            service.inner.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["total"]
                == json!(1)
        })
        .await;
    });
    let diagnostics =
        service.inner.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(diagnostics["by_domain"]["task_stdio_registry"], json!(1));
    assert_eq!(diagnostics["by_code"]["stdin_write_failed"], json!(1));
    assert_eq!(diagnostics["last"]["domain"], json!("task_stdio_registry"));
    assert_eq!(diagnostics["last"]["op"], json!("registry_get"));
    assert_eq!(diagnostics["last"]["code"], json!("stdin_write_failed"));
    assert_eq!(diagnostics["last"]["id"], json!("read-missing-writer"));
    assert_eq!(diagnostics["last"]["task_id"], json!(task.task_id));
    let message = diagnostics["last"]["message"]
        .as_str()
        .expect("diagnostic message should be a string");
    assert!(message.len() <= 512, "diagnostic message must stay bounded");
    assert!(message.contains("not writable"), "{diagnostics}");
    assert!(
        !message.contains(query),
        "diagnostic message must not echo registry query: {diagnostics}"
    );
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status().queue_length, 0);
    assert!(
        service.events_after(before_seq).is_empty(),
        "missing registry writer must not write timeline events: {:?}",
        service.events_after(before_seq)
    );
    assert_eq!(service_context_len(&service), before_context_len);
    assert_eq!(
        service.inner.timeline_bootstrap_snapshot()["active_items"],
        before_active_items
    );
    assert_eq!(
        task_request_count(&service, &task.task_id),
        before_task_requests
    );
    assert_eq!(store.stats(), before_registry_stats);
}

#[tokio::test]
async fn service_registry_get_delivered_writer_diagnostic_is_bounded_without_agent_side_effects() {
    #[derive(Clone)]
    struct DiagnosticTaskStdin {
        inner: RecordingTaskStdin,
        diagnostic: Arc<str>,
    }

    impl TaskStdinWriter for DiagnosticTaskStdin {
        fn atomic_frame_cap(&self) -> usize {
            TASK_STDIN_FRAME_SAFETY_CEILING
        }

        fn try_write_frame(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
            self.inner.try_write_frame(bytes)?;
            Ok(TaskStdinWriteSuccess::delivered_with_diagnostic(
                self.diagnostic.as_ref(),
            ))
        }
    }

    let (profiler, report_dir) =
        service_test_profiler("stdio-registry-delivered-writer-diagnostic");
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-writer-diagnostic"),
        provider.clone(),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed")
    .with_profiler(Some(profiler.clone()));
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_writer_diagnostic",
            "bash",
            "{}",
        ));
    let diagnostic = format!("{}DIAGNOSTIC_TAIL_SENTINEL", "界".repeat(512));
    let stdin = DiagnosticTaskStdin {
        inner: RecordingTaskStdin::default(),
        diagnostic: Arc::from(diagnostic),
    };
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let before_seq = service.status().last_event_seq;
    let before_context_len = service_context_len(&service);
    let before_active_items = service.timeline_bootstrap_snapshot()["active_items"].clone();
    let before_task_requests = task_request_count(&service, &task.task_id);
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "read-writer-diagnostic".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);

    wait_until(|| {
        stdin
            .inner
            .text()
            .contains("\"id\":\"read-writer-diagnostic\"")
            && service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["total"]
                == json!(1)
    })
    .await;
    let written = stdin.inner.text();
    assert!(written.contains("\"op\":\"registry_snapshot\""));
    assert!(written.contains("\"id\":\"read-writer-diagnostic\""));
    let diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(diagnostics["by_domain"]["task_stdio_registry"], json!(1));
    assert_eq!(diagnostics["by_code"]["stdin_write_diagnostic"], json!(1));
    assert_eq!(diagnostics["last"]["domain"], json!("task_stdio_registry"));
    assert_eq!(diagnostics["last"]["code"], json!("stdin_write_diagnostic"));
    assert_eq!(diagnostics["last"]["op"], json!("registry"));
    assert_eq!(diagnostics["last"]["task_id"], json!(task.task_id));
    assert_eq!(diagnostics["last"]["id"], json!("read-writer-diagnostic"));
    let message = diagnostics["last"]["message"]
        .as_str()
        .expect("diagnostic message should be a string");
    assert_eq!(message.chars().count(), 512);
    assert_eq!(message, "界".repeat(512));
    assert!(!message.contains("DIAGNOSTIC_TAIL_SENTINEL"));
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status().queue_length, 0);
    assert!(service.events_after(before_seq).is_empty());
    assert_eq!(service_context_len(&service), before_context_len);
    assert_eq!(
        service.timeline_bootstrap_snapshot()["active_items"],
        before_active_items
    );
    assert_eq!(
        task_request_count(&service, &task.task_id),
        before_task_requests
    );

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let profile_events =
        fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    assert!(!profile_events.contains("task_stdio_registry"));
    assert!(!profile_events.contains("stdin_write_diagnostic"));
    assert!(!profile_events.contains("DIAGNOSTIC_TAIL_SENTINEL"));
    let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
    assert_eq!(summary_value(&summary, "task_requests"), "0");
    assert_eq!(summary_value(&summary, "task_requests_failed"), "0");
}

#[tokio::test]
async fn service_registry_get_rejecting_writer_records_bounded_diagnostic() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    store
        .set(
            RegistryWriterKind::WebsocketClient,
            "ws:test",
            crate::registry::RegistrySetRequest::new("robot.pose", json!({"x": 1}), "localization"),
        )
        .expect("seed registry set should succeed");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-rejecting-writer"),
        Arc::new(PanicProvider),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_rejecting_writer",
            "bash",
            "{}",
        ));
    let stdin = RejectingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "read-unsupported".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    wait_until(|| stdin.write_attempted()).await;

    assert!(stdin.write_attempted());
    let diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(diagnostics["by_domain"]["task_stdio_registry"], json!(1));
    assert_eq!(diagnostics["by_code"]["stdin_write_failed"], json!(1));
    assert_eq!(diagnostics["last"]["id"], json!("read-unsupported"));
    assert!(
        diagnostics["last"]["message"]
            .as_str()
            .expect("diagnostic message should be a string")
            .contains("unsupported"),
        "{diagnostics}"
    );
}

#[tokio::test]
async fn service_registry_get_would_block_writer_records_bounded_diagnostic() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    store
        .set(
            RegistryWriterKind::WebsocketClient,
            "ws:test",
            crate::registry::RegistrySetRequest::new("robot.pose", json!({"x": 1}), "localization"),
        )
        .expect("seed registry set should succeed");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-would-block"),
        Arc::new(PanicProvider),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_would_block",
            "bash",
            "{}",
        ));
    let stdin = WouldBlockTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "read-would-block".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    wait_until(|| stdin.write_attempted()).await;

    assert!(stdin.write_attempted());
    let diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(diagnostics["by_domain"]["task_stdio_registry"], json!(1));
    assert_eq!(diagnostics["by_code"]["stdin_write_failed"], json!(1));
    assert_eq!(diagnostics["last"]["id"], json!("read-would-block"));
    assert!(
        diagnostics["last"]["message"]
            .as_str()
            .expect("diagnostic message should be a string")
            .contains("would block"),
        "{diagnostics}"
    );
}

#[tokio::test]
async fn service_registry_get_stdio_response_is_bounded_and_does_not_echo_query_detail() {
    let store = RegistryStore::new(crate::registry::RegistryConfig {
        history_retention: Duration::from_secs(60),
        default_ttl: Duration::from_secs(30),
        max_subscriptions: 64,
        max_topics: 8,
        max_topic_len: 256,
        max_source_len: 64,
        max_value_bytes: 512,
        max_history_items: 64,
        max_history_bytes: 16 * 1024,
        default_query_limit: 8,
        max_query_limit: 8,
        max_response_bytes: 520,
    })
    .expect("registry should initialize");
    for index in 0..3 {
        store
            .set(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                crate::registry::RegistrySetRequest::new(
                    format!("robot.pose.{index}"),
                    json!({"payload": "x".repeat(80)}),
                    "localization",
                ),
            )
            .expect("seed registry set should succeed");
    }
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-get-bounded"),
        provider.clone(),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_get_bounded",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let before_seq = service.status().last_event_seq;
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "read-large".to_owned(),
            topic: "robot.pose.*".to_owned(),
            limit: Some(8),
        },
    )]);

    wait_until(|| stdin.text().contains("\"op\":\"registry_snapshot\"")).await;
    let frames = botified_frame_strings(&stdin.text());
    let snapshot_frame = frames
        .first()
        .expect("stdin should contain snapshot frame")
        .clone();
    assert!(
        snapshot_frame.len() <= store.config().max_response_bytes,
        "snapshot frame should be capped: {} > {}\n{snapshot_frame}",
        snapshot_frame.len(),
        store.config().max_response_bytes
    );
    let snapshot = botified_json_from_frame(&snapshot_frame);
    assert_eq!(snapshot["op"], json!("registry_snapshot"));
    assert_eq!(snapshot["id"], json!("read-large"));
    assert_eq!(snapshot["truncated"], json!(true));
    assert!(snapshot["truncated_reason"].is_string());

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "bad-pattern".to_owned(),
            topic: "robot..super_secret_query_detail".to_owned(),
            limit: Some(1),
        },
    )]);

    wait_until(|| botified_frame_strings(&stdin.text()).len() >= 2).await;
    let frames = botified_frame_strings(&stdin.text());
    let error_frame = frames.last().expect("stdin should contain error frame");
    assert!(
        error_frame.len() <= store.config().max_response_bytes,
        "error frame should be capped: {} > {}\n{error_frame}",
        error_frame.len(),
        store.config().max_response_bytes
    );
    assert!(
        !error_frame.contains("super_secret_query_detail"),
        "registry_error must not echo query detail: {error_frame}"
    );
    let error = botified_json_from_frame(error_frame);
    assert_eq!(error["op"], json!("registry_error"));
    assert_eq!(error["id"], json!("bad-pattern"));
    assert_eq!(error["code"], json!("invalid_pattern"));
    assert_eq!(provider.calls(), 0);
    assert!(
        service.events_after(before_seq).is_empty(),
        "bounded registry_get responses must not write timeline events: {:?}",
        service.events_after(before_seq)
    );
}

#[test]
fn service_runtime_first_use_starts_one_registry_maintenance_loop_and_stop_paths_end_it() {
    fn short_retention_store() -> RegistryStore {
        RegistryStore::new(crate::registry::RegistryConfig {
            history_retention: Duration::from_millis(30),
            default_ttl: Duration::from_secs(60),
            max_subscriptions: 64,
            max_topics: 8,
            max_topic_len: 64,
            max_source_len: 64,
            max_value_bytes: 512,
            max_history_items: 64,
            max_history_bytes: 16 * 1024,
            default_query_limit: 8,
            max_query_limit: 8,
            max_response_bytes: 4096,
        })
        .unwrap()
    }

    let store = short_retention_store();
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("registry-maintenance-shutdown"),
        Arc::new(CountingProvider::new()),
        Vec::new(),
        store.clone(),
    )
    .unwrap();
    let service_clone = service.clone();
    store
        .set(
            RegistryWriterKind::WebsocketClient,
            "ws:test",
            crate::registry::RegistrySetRequest::new("robot.before", json!(1), "test")
                .with_ttl(crate::registry::RegistryTtl::Seconds(0.03)),
        )
        .unwrap();
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(store.stats().current_topics, 1);
    assert_eq!(store.stats().history_items, 1);

    let dropped_store = short_retention_store();
    let dropped_service = Service::with_registry_store(
        AgentConfig::new("system").with_session("registry-maintenance-drop"),
        Arc::new(CountingProvider::new()),
        Vec::new(),
        dropped_store.clone(),
    )
    .unwrap();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        assert!(service.registry_store().is_some());
        assert!(service.registry_store().is_some());
        assert!(service_clone.registry_store().is_some());
        tokio::time::timeout(Duration::from_secs(1), async {
            while store.stats().history_items != 0 || store.stats().current_topics != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first runtime use must start maintenance and clear the backlog");
        assert_eq!(store.stats().expire_total, 1);

        drop(service_clone);
        service.shutdown().await;
        store
            .set(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                crate::registry::RegistrySetRequest::new("robot.after", json!(2), "test")
                    .with_ttl(crate::registry::RegistryTtl::Null),
            )
            .unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(store.stats().history_items, 1);

        assert!(dropped_service.registry_store().is_some());
        drop(dropped_service);
        tokio::task::yield_now().await;
        dropped_store
            .set(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                crate::registry::RegistrySetRequest::new("robot.after_drop", json!(3), "test")
                    .with_ttl(crate::registry::RegistryTtl::Null),
            )
            .unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(dropped_store.stats().history_items, 1);
    });
}

#[tokio::test]
async fn service_registry_get_stdio_response_respects_task_stdin_control_cap() {
    let store = RegistryStore::new(crate::registry::RegistryConfig {
        history_retention: Duration::from_secs(60),
        default_ttl: Duration::from_secs(30),
        max_subscriptions: 64,
        max_topics: 16,
        max_topic_len: 256,
        max_source_len: 64,
        max_value_bytes: 8192,
        max_history_items: 64,
        max_history_bytes: 64 * 1024,
        default_query_limit: 16,
        max_query_limit: 16,
        max_response_bytes: 32 * 1024,
    })
    .expect("registry should initialize");
    for index in 0..8 {
        store
            .set(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                crate::registry::RegistrySetRequest::new(
                    format!("robot.payload.{index}"),
                    json!({"payload": "x".repeat(4096)}),
                    "localization",
                ),
            )
            .expect("seed registry set should succeed");
    }
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-stdin-cap"),
        Arc::new(PanicProvider),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_stdin_cap",
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

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "read-stdin-cap".to_owned(),
            topic: "robot.payload.*".to_owned(),
            limit: Some(16),
        },
    )]);

    wait_until(|| stdin.text().contains("\"op\":\"registry_snapshot\"")).await;
    let frames = botified_frame_strings(&stdin.text());
    let snapshot_frame = frames.first().expect("stdin should contain snapshot frame");
    assert!(
        snapshot_frame.len() <= TASK_STDIN_FRAME_SAFETY_CEILING,
        "registry stdin response must fit control frame cap: {} > {}\n{snapshot_frame}",
        snapshot_frame.len(),
        TASK_STDIN_FRAME_SAFETY_CEILING
    );
    let snapshot = botified_json_from_frame(snapshot_frame);
    assert_eq!(snapshot["op"], json!("registry_snapshot"));
    assert_eq!(snapshot["truncated"], json!(true));
    assert_eq!(snapshot["truncated_reason"], json!("response_bytes"));
}

#[tokio::test]
async fn service_registry_get_builds_response_for_the_registered_writer_cap() {
    let store = RegistryStore::new(crate::registry::RegistryConfig {
        max_response_bytes: 32 * 1024,
        ..Default::default()
    })
    .expect("registry should initialize");
    store
        .set(
            RegistryWriterKind::WebsocketClient,
            "ws:test",
            crate::registry::RegistrySetRequest::new(
                "robot.payload",
                json!({"payload": "x".repeat(2048)}),
                "localization",
            ),
        )
        .expect("seed registry set should succeed");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-writer-cap"),
        Arc::new(PanicProvider),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_writer_cap",
            "bash",
            "{}",
        ));
    let stdin = CappedRecordingTaskStdin::new(512);
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "read-writer-cap".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(8),
        },
    )]);

    wait_until(|| stdin.text().contains("\"op\":\"registry_snapshot\"")).await;
    let frame = botified_frame_strings(&stdin.text())
        .into_iter()
        .next()
        .expect("stdin should contain a registry response");
    assert!(frame.len() <= 512, "{} > 512\n{frame}", frame.len());
    let snapshot = botified_json_from_frame(&frame);
    assert_eq!(snapshot["truncated"], json!(true));
    assert_eq!(snapshot["truncated_reason"], json!("response_bytes"));
    let diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_ne!(diagnostics["by_code"]["stdin_write_failed"], json!(1));
}

#[tokio::test]
async fn service_registry_get_rejects_159_byte_writer_before_enabled_formatter() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-registry-enabled-writer-too-small"),
        Arc::new(PanicProvider),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_registry_enabled_tiny_writer", "bash", "{}"));
    let stdin = CappedRecordingTaskStdin::new(159);
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");

    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id,
    }
    .handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "enabled-too-small".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);

    wait_until(|| {
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["by_code"]
            ["stdin_write_failed"]
            == json!(1)
    })
    .await;
    assert!(stdin.text().is_empty());
    let diagnostic =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["last"].clone();
    assert_eq!(diagnostic["id"], json!("enabled-too-small"));
    assert!(
        diagnostic["message"]
            .as_str()
            .is_some_and(|message| message.contains("minimum registry response frame (160 bytes)")),
        "{diagnostic}"
    );
}

#[tokio::test]
async fn service_registry_disabled_rejects_159_byte_writer_before_error_formatter() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-registry-disabled-writer-too-small"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service.inner.background_tasks.start_task(NewBackgroundTask::new(
        "call_registry_disabled_tiny_writer",
        "bash",
        "{}",
    ));
    let stdin = CappedRecordingTaskStdin::new(159);
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");

    ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id,
    }
    .handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "disabled-too-small".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);

    wait_until(|| {
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["by_code"]
            ["stdin_write_failed"]
            == json!(1)
    })
    .await;
    assert!(stdin.text().is_empty());
    let diagnostic =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["last"].clone();
    assert_eq!(diagnostic["id"], json!("disabled-too-small"));
    assert!(
        diagnostic["message"]
            .as_str()
            .is_some_and(|message| message.contains("minimum registry response frame (160 bytes)")),
        "{diagnostic}"
    );
}

#[tokio::test]
async fn service_registry_enabled_and_disabled_writers_accept_160_byte_frames() {
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let enabled = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-registry-enabled-minimum-writer"),
        Arc::new(PanicProvider),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed");
    let enabled_task = enabled.inner.background_tasks.start_task(NewBackgroundTask::new(
        "call_registry_enabled_minimum_writer",
        "bash",
        "{}",
    ));
    let enabled_stdin = CappedRecordingTaskStdin::new(160);
    enabled
        .inner
        .background_tasks
        .register_stdin_writer(&enabled_task.task_id, Arc::new(enabled_stdin.clone()))
        .expect("task exists");
    ServiceInteractiveStdioBridge {
        inner: enabled.inner.clone(),
        task_id: enabled_task.task_id,
    }
    .handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "enabled-min".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    wait_until(|| !enabled_stdin.text().is_empty()).await;
    let enabled_frame = botified_frame_strings(&enabled_stdin.text())
        .into_iter()
        .next()
        .expect("enabled registry response should be written");
    assert!(enabled_frame.len() <= 160, "{enabled_frame}");
    assert_eq!(botified_json_from_frame(&enabled_frame)["op"], "registry_snapshot");

    let disabled = Service::new(
        AgentConfig::new("system").with_session("service-registry-disabled-minimum-writer"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let disabled_task = disabled.inner.background_tasks.start_task(NewBackgroundTask::new(
        "call_registry_disabled_minimum_writer",
        "bash",
        "{}",
    ));
    let disabled_stdin = CappedRecordingTaskStdin::new(160);
    disabled
        .inner
        .background_tasks
        .register_stdin_writer(&disabled_task.task_id, Arc::new(disabled_stdin.clone()))
        .expect("task exists");
    ServiceInteractiveStdioBridge {
        inner: disabled.inner.clone(),
        task_id: disabled_task.task_id,
    }
    .handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "disabled-min".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        },
    )]);
    wait_until(|| !disabled_stdin.text().is_empty()).await;
    let disabled_frame = botified_frame_strings(&disabled_stdin.text())
        .into_iter()
        .next()
        .expect("disabled registry error should be written");
    assert!(disabled_frame.len() <= 160, "{disabled_frame}");
    assert_eq!(botified_json_from_frame(&disabled_frame)["op"], "registry_error");
}

#[tokio::test]
async fn registry_lane_full_rejects_159_byte_writer_before_error_formatter() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-registry-lane-full-tiny-writer"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service.inner.background_tasks.start_task(NewBackgroundTask::new(
        "call_registry_lane_full_tiny_writer",
        "bash",
        "{}",
    ));
    let stdin = CappedRecordingTaskStdin::new(159);
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

    let mut events = (0..task_bridge::TASK_FRAME_LANE_CAPACITY)
        .map(|index| {
            BotifiedFrameEvent::RegistryGet(TaskRegistryGetFrame {
                id: format!("queued-{index}"),
                topic: "robot.*".to_owned(),
                limit: Some(1),
            })
        })
        .collect::<Vec<_>>();
    events.push(BotifiedFrameEvent::RegistryGet(TaskRegistryGetFrame {
        id: "x".repeat(25),
        topic: "robot.*".to_owned(),
        limit: Some(1),
    }));
    bridge.handle_frame_events(events);

    let diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(diagnostics["by_code"]["stdin_write_failed"], json!(1));
    assert_eq!(diagnostics["by_code"]["task_frame_lane_full"], json!(1));
    assert!(stdin.text().is_empty());

    service.cancel_background_task(&task.task_id);
    drop(transition_guard);
    wait_for_service_workers_idle(&service).await;
}

#[tokio::test]
async fn service_registry_get_stdio_tiny_response_cap_uses_effective_minimum() {
    let store = RegistryStore::new(crate::registry::RegistryConfig {
        history_retention: Duration::from_secs(60),
        default_ttl: Duration::from_secs(30),
        max_subscriptions: 64,
        max_topics: 8,
        max_topic_len: 256,
        max_source_len: 64,
        max_value_bytes: 2048,
        max_history_items: 64,
        max_history_bytes: 16 * 1024,
        default_query_limit: 8,
        max_query_limit: 8,
        max_response_bytes: 74,
    })
    .expect("registry should initialize");
    store
        .set(
            RegistryWriterKind::WebsocketClient,
            "ws:test",
            crate::registry::RegistrySetRequest::new(
                "robot.pose",
                json!({"payload": "x".repeat(1024)}),
                "localization",
            ),
        )
        .expect("seed registry set should succeed");
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-get-tiny-cap"),
        provider.clone(),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_get_tiny_cap",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    let before_seq = service.status().last_event_seq;
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };
    let effective_cap = stdio_registry_response_cap(store.config().max_response_bytes);
    assert!(effective_cap > store.config().max_response_bytes);

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "tiny-read".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(8),
        },
    )]);

    wait_until(|| stdin.text().contains("\"op\":\"registry_snapshot\"")).await;
    let frames = botified_frame_strings(&stdin.text());
    let snapshot_frame = frames.first().expect("stdin should contain snapshot frame");
    assert!(
        snapshot_frame.len() <= effective_cap,
        "snapshot frame should fit effective stdio cap: {} > {}\n{snapshot_frame}",
        snapshot_frame.len(),
        effective_cap
    );
    let snapshot = botified_json_from_frame(snapshot_frame);
    assert_eq!(snapshot["op"], json!("registry_snapshot"));
    assert_eq!(snapshot["truncated"], json!(true));
    assert_eq!(snapshot["truncated_reason"], json!("response_bytes"));

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
        TaskRegistryGetFrame {
            id: "tiny-error".to_owned(),
            topic: "robot..secret_query_detail".to_owned(),
            limit: Some(1),
        },
    )]);

    wait_until(|| botified_frame_strings(&stdin.text()).len() >= 2).await;
    let frames = botified_frame_strings(&stdin.text());
    let error_frame = frames.last().expect("stdin should contain error frame");
    assert!(
        error_frame.len() <= effective_cap,
        "error frame should fit effective stdio cap: {} > {}\n{error_frame}",
        error_frame.len(),
        effective_cap
    );
    let error = botified_json_from_frame(error_frame);
    assert_eq!(error["op"], json!("registry_error"));
    assert_eq!(error["code"], json!("invalid_pattern"));
    assert!(
        !error_frame.contains("secret_query_detail"),
        "registry_error must not echo query detail: {error_frame}"
    );
    assert_eq!(provider.calls(), 0);
    assert!(
        service.events_after(before_seq).is_empty(),
        "tiny-cap registry_get responses must not write timeline events: {:?}",
        service.events_after(before_seq)
    );
}

#[tokio::test]
async fn service_registry_set_stdio_uses_active_store_limits_for_value_and_source() {
    let store = RegistryStore::new(crate::registry::RegistryConfig {
        history_retention: Duration::from_secs(60),
        default_ttl: Duration::from_secs(30),
        max_subscriptions: 64,
        max_topics: 8,
        max_topic_len: 256,
        max_source_len: 8,
        max_value_bytes: 16,
        max_history_items: 64,
        max_history_bytes: 16 * 1024,
        default_query_limit: 8,
        max_query_limit: 8,
        max_response_bytes: 1024,
    })
    .expect("registry should initialize");
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-active-limits"),
        provider.clone(),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_set_active_limits",
            "bash",
            "{}",
        ));
    let before_seq = service.status().last_event_seq;
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
        TaskRegistrySetFrame {
            id: Some("large-value".to_owned()),
            topic: "robot.pose".to_owned(),
            value: json!({"payload": "x".repeat(64)}),
            source: Some("local".to_owned()),
            ttl: crate::registry::RegistryTtl::Default,
            freq_hz: None,
        },
    )]);

    wait_until(|| {
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["total"] == json!(1)
    })
    .await;
    let first_diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(
        first_diagnostics["by_domain"]["task_stdio_registry"],
        json!(1)
    );
    assert_eq!(first_diagnostics["by_code"]["value_too_large"], json!(1));
    assert_eq!(first_diagnostics["last"]["code"], json!("value_too_large"));
    assert_eq!(first_diagnostics["last"]["id"], json!("large-value"));
    assert!(first_diagnostics["last"]["recorded_at"].is_string());
    assert!(
        !first_diagnostics.to_string().contains(&"x".repeat(64)),
        "diagnostic must not echo oversized registry value: {first_diagnostics}"
    );

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
        TaskRegistrySetFrame {
            id: Some("long-source".to_owned()),
            topic: "robot.pose".to_owned(),
            value: json!({"ok": true}),
            source: Some("source-name-is-too-long".to_owned()),
            ttl: crate::registry::RegistryTtl::Default,
            freq_hz: None,
        },
    )]);

    wait_until(|| {
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["total"] == json!(2)
    })
    .await;
    let diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(diagnostics["total"], json!(2));
    assert_eq!(diagnostics["by_domain"]["task_stdio_registry"], json!(2));
    assert_eq!(diagnostics["by_domain"]["task_stdio_protocol"], Value::Null);
    assert_eq!(diagnostics["by_code"]["value_too_large"], json!(1));
    assert_eq!(diagnostics["by_code"]["invalid_source"], json!(1));
    assert_eq!(diagnostics["last"]["domain"], json!("task_stdio_registry"));
    assert_eq!(diagnostics["last"]["code"], json!("invalid_source"));
    assert_eq!(diagnostics["last"]["id"], json!("long-source"));
    assert!(diagnostics["last"]["recorded_at"].is_string());
    assert!(
        !diagnostics.to_string().contains("source-name-is-too-long"),
        "diagnostic must not echo oversized registry source: {diagnostics}"
    );
    assert_eq!(
        store
            .get(RegistryQuery::new("robot.pose"))
            .expect("registry get should succeed")
            .returned_count,
        0
    );
    assert_eq!(provider.calls(), 0);
    assert!(
        service.events_after(before_seq).is_empty(),
        "registry_set store-limit diagnostics must not write timeline events: {:?}",
        service.events_after(before_seq)
    );
}

#[tokio::test]
async fn service_registry_set_stdio_allows_values_and_sources_above_defaults_when_store_allows() {
    let store = RegistryStore::new(crate::registry::RegistryConfig {
        history_retention: Duration::from_secs(60),
        default_ttl: Duration::from_secs(30),
        max_subscriptions: 64,
        max_topics: 8,
        max_topic_len: 256,
        max_source_len: crate::registry::RegistryConfig::DEFAULT_MAX_SOURCE_LEN + 32,
        max_value_bytes: crate::registry::RegistryConfig::DEFAULT_MAX_VALUE_BYTES + 512,
        max_history_items: 64,
        max_history_bytes: 64 * 1024,
        default_query_limit: 8,
        max_query_limit: 8,
        max_response_bytes: 32 * 1024,
    })
    .expect("registry should initialize");
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-relaxed-limits"),
        provider.clone(),
        Vec::new(),
        store.clone(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_registry_set_relaxed_limits",
            "bash",
            "{}",
        ));
    let before_seq = service.status().last_event_seq;
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };
    let large_value = "v".repeat(crate::registry::RegistryConfig::DEFAULT_MAX_VALUE_BYTES + 1);
    let long_source = "s".repeat(crate::registry::RegistryConfig::DEFAULT_MAX_SOURCE_LEN + 1);

    bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
        TaskRegistrySetFrame {
            id: Some("relaxed".to_owned()),
            topic: "robot.pose".to_owned(),
            value: json!(large_value),
            source: Some(long_source.clone()),
            ttl: crate::registry::RegistryTtl::Default,
            freq_hz: None,
        },
    )]);

    wait_until(|| {
        store
            .get(RegistryQuery::new("robot.pose"))
            .is_ok_and(|result| result.returned_count == 1)
    })
    .await;
    let result = store
        .get(RegistryQuery::new("robot.pose"))
        .expect("registry get should succeed");
    assert_eq!(result.returned_count, 1);
    assert_eq!(result.items[0].source, long_source);
    assert_eq!(provider.calls(), 0);
    assert!(
        service.events_after(before_seq).is_empty(),
        "successful relaxed-limit registry_set must not write timeline events: {:?}",
        service.events_after(before_seq)
    );
    let diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(diagnostics["total"], json!(0));
    assert_eq!(diagnostics["last"], Value::Null);
}

#[tokio::test]
async fn service_registry_stdio_diagnostics_do_not_become_task_ask_rejections() {
    let (profiler, report_dir) =
        service_test_profiler("stdio-registry-diagnostics-no-agent-pollution");
    let store = RegistryStore::new(Default::default()).expect("registry should initialize");
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_registry_store(
        AgentConfig::new("system").with_session("service-stdio-registry-diagnostics"),
        provider.clone(),
        Vec::new(),
        store,
    )
    .expect("service construction should succeed")
    .with_profiler(Some(profiler.clone()));
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_registry_diag", "bash", "{}"));
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(FailingTaskStdin))
        .expect("task exists");
    let before_seq = service.status().last_event_seq;
    let before_context_len = service_context_len(&service);
    let before_active_items = service.timeline_bootstrap_snapshot()["active_items"].clone();
    let before_task_requests = task_request_count(&service, &task.task_id);
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };

    bridge.handle_frame_events(vec![
        BotifiedFrameEvent::RegistrySet(TaskRegistrySetFrame {
            id: Some("bad-topic".to_owned()),
            topic: "robot..bad".to_owned(),
            value: json!({"secret": "must not leak"}),
            source: Some("diagnostic-test".to_owned()),
            ttl: crate::registry::RegistryTtl::Default,
            freq_hz: None,
        }),
        BotifiedFrameEvent::RegistryGet(TaskRegistryGetFrame {
            id: "read-closed".to_owned(),
            topic: "robot.*".to_owned(),
            limit: Some(1),
        }),
        BotifiedFrameEvent::RegistryDiagnostic(TaskFrameDiagnostic {
            op: Some("registry_set".to_owned()),
            code: "invalid_value",
            message: "registry_set value is required".to_owned(),
            request_id: Some("bad-set".to_owned()),
        }),
        BotifiedFrameEvent::ProtocolDiagnostic(TaskFrameDiagnostic {
            op: Some("registry_snapshot".to_owned()),
            code: "unsupported_op",
            message: "echoed stdin frame".to_owned(),
            request_id: Some("echoed".to_owned()),
        }),
    ]);

    wait_until(|| {
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"]["total"] == json!(4)
    })
    .await;

    let events = service.events_after(before_seq);
    assert!(
        events.is_empty(),
        "stdio registry/protocol diagnostics must not write timeline events: {events:?}"
    );
    assert_eq!(provider.calls(), 0);
    assert_eq!(service.status().queue_length, 0);
    assert_eq!(service_context_len(&service), before_context_len);
    assert_eq!(
        service.timeline_bootstrap_snapshot()["active_items"],
        before_active_items
    );
    assert_eq!(
        task_request_count(&service, &task.task_id),
        before_task_requests
    );
    let diagnostics =
        service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
    assert_eq!(diagnostics["total"], json!(4));
    assert_eq!(diagnostics["by_domain"]["task_stdio_registry"], json!(3));
    assert_eq!(diagnostics["by_domain"]["task_stdio_protocol"], json!(1));
    assert_eq!(diagnostics["by_code"]["invalid_topic"], json!(1));
    assert_eq!(diagnostics["by_code"]["stdin_write_failed"], json!(1));
    assert_eq!(diagnostics["by_code"]["invalid_value"], json!(1));
    assert_eq!(diagnostics["by_code"]["unsupported_op"], json!(1));
    assert_eq!(diagnostics["last"]["domain"], json!("task_stdio_protocol"));
    assert_eq!(diagnostics["last"]["code"], json!("unsupported_op"));
    assert_eq!(diagnostics["last"]["op"], json!("registry_snapshot"));
    assert_eq!(diagnostics["last"]["id"], json!("echoed"));
    assert!(diagnostics["last"]["recorded_at"].is_string());
    assert!(
        !diagnostics.to_string().contains("must not leak"),
        "internal diagnostic summary must stay bounded and omit registry values: {diagnostics}"
    );

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let profile_events =
        fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    assert!(!profile_events.contains("task_stdio_registry"));
    assert!(!profile_events.contains("task_stdio_protocol"));
    assert!(!profile_events.contains("stdin_write_failed"));
    assert!(!profile_events.contains("must not leak"));
    let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
    assert_eq!(summary_value(&summary, "task_requests"), "0");
    assert_eq!(summary_value(&summary, "task_requests_failed"), "0");
}
