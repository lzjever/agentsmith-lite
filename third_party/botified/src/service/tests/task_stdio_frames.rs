#[tokio::test]
async fn service_interactive_frame_after_shutdown_has_no_side_effects() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-late-frame-after-shutdown"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let shutdown = service.shutdown().await;
    assert_eq!(shutdown.state, ServiceState::ShuttingDown);
    let seq_after_shutdown = service.status().last_event_seq;
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: "task_after_shutdown".to_owned(),
    };

    bridge.handle_frame_events(vec![
        BotifiedFrameEvent::Diagnostic(TaskFrameDiagnostic {
            op: Some("ask".to_owned()),
            code: "invalid_frame",
            message: "late diagnostic".to_owned(),
            request_id: Some("diagnostic_1".to_owned()),
        }),
        BotifiedFrameEvent::Ask(TaskRequestFrame {
            id: "request_1".to_owned(),
            request: "late request".to_owned(),
            expect: None,
            timeout: Some(Duration::from_millis(1)),
            urgency: InputUrgency::Normal,
        }),
    ]);
    tokio::task::yield_now().await;

    let late_events = service.events_after(seq_after_shutdown);
    assert!(
        late_events.is_empty(),
        "late frame after shutdown should not emit service events: {late_events:?}"
    );
    assert_eq!(service.status().state, ServiceState::ShuttingDown);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_publishes_before_terminating_interactive_frame_admission() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-frame-race-shutdown"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_frame_race", "bash", "{}"));
    let seq_before_frame = service.status().last_event_seq;
    let (entered_tx, entered_rx) = oneshot::channel();
    let entered_tx = Mutex::new(Some(entered_tx));
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind != TaskFrameAdmissionKind::Diagnostic {
                return;
            }
            if let Some(entered_tx) = entered_tx
                .lock()
                .expect("entered sender mutex poisoned")
                .take()
            {
                let _ = entered_tx.send(());
            }
            if let Some(release_rx) = release_rx
                .lock()
                .expect("release receiver mutex poisoned")
                .take()
            {
                release_rx
                    .recv_timeout(SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT + Duration::from_secs(5))
                    .expect("admission test hook should be released");
            }
        })));
    let bridge = ServiceInteractiveStdioBridge {
        inner: service.inner.clone(),
        task_id: task.task_id.clone(),
    };

    bridge.handle_frame_events(vec![BotifiedFrameEvent::Diagnostic(TaskFrameDiagnostic {
        op: Some("ask".to_owned()),
        code: "invalid_request",
        message: "late malformed request".to_owned(),
        request_id: Some("request_race".to_owned()),
    })]);
    tokio::time::timeout(SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT, entered_rx)
        .await
        .expect("frame handler should enter the admission gate before the shutdown drain budget")
        .expect("frame handler should retain the admission waiter");

    let shutdown_service = service.clone();
    let (shutdown_started_tx, shutdown_started_rx) = oneshot::channel();
    let (shutdown_done_tx, mut shutdown_done_rx) =
        oneshot::channel::<std::thread::Result<ServiceStatus>>();
    let shutdown_thread = std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .expect("shutdown test runtime should build");
            let _ = shutdown_started_tx.send(());
            runtime.block_on(shutdown_service.shutdown())
        }));
        let _ = shutdown_done_tx.send(result);
    });
    tokio::time::timeout(Duration::from_secs(2), shutdown_started_rx)
        .await
        .expect("shutdown thread should start")
        .expect("shutdown thread should report start");
    tokio::time::timeout(Duration::from_millis(250), &mut shutdown_done_rx)
        .await
        .expect_err("shutdown should wait for the in-flight admission gate");
    wait_until(|| service.status().state == ServiceState::ShuttingDown).await;
    release_tx
        .send(())
        .expect("admission test hook should accept release");
    service.inner.background_tasks.finish_task(
        &task.task_id,
        TaskState::Cancelled,
        "test task stopped during shutdown",
    );
    let shutdown = tokio::time::timeout(
        SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT + Duration::from_secs(5),
        shutdown_done_rx,
    )
    .await
    .expect("shutdown should finish after admission gate releases")
    .expect("shutdown thread should report result");
    let shutdown = match shutdown {
        Ok(shutdown) => shutdown,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    shutdown_thread
        .join()
        .expect("shutdown helper thread should not panic");
    service.inner.set_task_frame_admission_hook_for_test(None);
    assert_eq!(shutdown.state, ServiceState::ShuttingDown);
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

    let events = service.events_after(seq_before_frame);
    let rejected = events
        .iter()
        .filter(|event| {
            event.event_type == "task_ask.rejected" && event.data["ask_id"] == json!("request_race")
        })
        .collect::<Vec<_>>();
    assert!(
        rejected.is_empty(),
        "admission termination after shutdown must have no request side effects: {events:?}"
    );
    let shutdown_status = events
        .iter()
        .find(|event| {
            event.event_type == "service.status" && event.data["state"] == json!("shutting_down")
        })
        .expect("shutdown status should be recorded");
    assert_eq!(shutdown_status.data["state"], json!("shutting_down"));
    assert_eq!(service.status().state, ServiceState::ShuttingDown);
}

#[tokio::test]
async fn task_request_deadline_after_failed_service_has_no_side_effects() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-request-deadline-after-failed"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_deadline_after_failed",
            "bash",
            "{}",
        ));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    assert!(matches!(
        service.inner.admit_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "need answer".to_owned(),
                expect: None,
                timeout: Some(Duration::from_millis(1)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestFrameAdmission::Accepted(_)
    ));
    service.inner.mark_failed("timeline persistence failed");
    let before_seq = service.inner.last_event_seq();

    service
        .inner
        .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));

    let snapshot = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain inspectable");
    let request = snapshot
        .requests
        .iter()
        .find(|request| request.request_id == "r1")
        .expect("request should exist");
    assert_eq!(request.state, TaskRequestState::Pending);
    assert_eq!(stdin.text(), "");
    let events = service.events_after(before_seq);
    assert!(
        events.is_empty(),
        "failed service must not expire task requests or write stdin: {events:?}"
    );
}

#[tokio::test]
async fn task_reply_after_failed_or_shutdown_has_no_side_effects() {
    for state in [ServiceState::Failed, ServiceState::ShuttingDown] {
        let service = Service::new(
            AgentConfig::new("system").with_session(format!("service-task-reply-after-{state:?}")),
            Arc::new(PanicProvider),
            Vec::new(),
        )
        .expect("service construction should succeed");
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_reply_after_stop",
                "bash",
                "{}",
            ));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        assert!(matches!(
            service.inner.admit_task_request_frame(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need answer".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_secs(30)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestFrameAdmission::Accepted(_)
        ));
        {
            let mut locked = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            locked.state = state;
        }
        let before_seq = service.inner.last_event_seq();

        let outcome = service
            .inner
            .reply_task_request(&task.task_id, "r1", "normal response");

        assert_eq!(outcome.status, TaskReplyStatus::Failed);
        assert_eq!(outcome.message, "service is not accepting task replies");
        assert_eq!(stdin.text(), "");
        let snapshot = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task should remain inspectable");
        let request = snapshot
            .requests
            .iter()
            .find(|request| request.request_id == "r1")
            .expect("request should exist");
        assert_eq!(request.state, TaskRequestState::Pending);
        let events = service.events_after(before_seq);
        assert!(
            events.is_empty(),
            "stopped service must not append task reply events for {state:?}: {events:?}"
        );
    }
}

#[tokio::test]
async fn task_send_writes_unified_frame_without_resolving_pending_ask() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-send-pending-ask"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_send_pending", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    assert!(matches!(
        service.inner.admit_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "need answer".to_owned(),
                expect: None,
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestFrameAdmission::Accepted(_)
    ));

    let send = service.inner.send_task_message_by_owner(
        &TaskOwner::Main,
        &task.task_id,
        "pause after current segment",
    );

    assert_eq!(send.status, TaskSendStatus::Written);
    let send_id = send
        .send_id
        .expect("successful send should include send_id");
    assert_eq!(
        stdin.text(),
        format!(
            "<botified>{{\"op\":\"send\",\"id\":\"{send_id}\",\"message\":\"pause after current segment\"}}</botified>\n"
        )
    );
    let snapshot = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task exists");
    let request = snapshot
        .requests
        .iter()
        .find(|request| request.request_id == "r1")
        .expect("pending ask exists");
    assert_eq!(request.state, TaskRequestState::Pending);

    let reply = service
        .inner
        .reply_task_request(&task.task_id, "r1", "answer");
    assert_eq!(reply.status, TaskReplyStatus::Written);
    let stdin_text = stdin.text();
    assert!(stdin_text.contains("\"op\":\"send\""));
    assert!(stdin_text.contains("\"op\":\"reply\""));
    assert_eq!(stdin_text.matches("<botified>").count(), 2);
}

#[test]
fn task_send_rejecting_writer_maps_to_write_failed() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-send-rejecting-writer"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_send_rejecting_writer",
            "bash",
            "{}",
        ));
    let stdin = RejectingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");

    let outcome =
        service
            .inner
            .send_task_message_by_owner(&TaskOwner::Main, &task.task_id, "hello");

    assert_eq!(outcome.status, TaskSendStatus::WriteFailed);
    assert!(
        outcome.message.contains("unsupported"),
        "{}",
        outcome.message
    );
    assert!(stdin.write_attempted());
}

#[test]
fn task_send_would_block_writer_fails_without_sync_fallback() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-send-would-block"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_send_would_block",
            "bash",
            "{}",
        ));
    let stdin = WouldBlockTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");

    let outcome = service.inner.send_task_message_by_owner(
        &TaskOwner::Main,
        &task.task_id,
        "frame should fail fast",
    );

    assert_eq!(outcome.status, TaskSendStatus::WriteFailed);
    assert!(
        outcome.message.contains("would block"),
        "{}",
        outcome.message
    );
    assert!(stdin.write_attempted());
}

#[tokio::test]
async fn task_reply_pending_ask_rejecting_writer_fails_without_sync_fallback() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-reply-rejecting-writer"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_reply_rejecting_writer",
            "bash",
            "{}",
        ));
    let stdin = RejectingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    assert!(matches!(
        service.inner.admit_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "need answer".to_owned(),
                expect: None,
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestFrameAdmission::Accepted(_)
    ));

    let outcome = service
        .inner
        .reply_task_request(&task.task_id, "r1", "answer");

    assert_eq!(outcome.status, TaskReplyStatus::Failed);
    assert!(
        outcome.message.contains("unsupported"),
        "{}",
        outcome.message
    );
    assert!(stdin.write_attempted());
    let snapshot = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task exists");
    let request = snapshot
        .requests
        .iter()
        .find(|request| request.request_id == "r1")
        .expect("request should exist");
    assert_eq!(request.state, TaskRequestState::WriteFailed);
}

#[tokio::test]
async fn task_reply_pending_ask_would_block_writer_fails_without_sync_fallback() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-reply-would-block"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_reply_would_block",
            "bash",
            "{}",
        ));
    let stdin = WouldBlockTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    assert!(matches!(
        service.inner.admit_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "need answer".to_owned(),
                expect: None,
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestFrameAdmission::Accepted(_)
    ));

    let outcome = service
        .inner
        .reply_task_request(&task.task_id, "r1", "answer");

    assert_eq!(outcome.status, TaskReplyStatus::Failed);
    assert!(
        outcome.message.contains("would block"),
        "{}",
        outcome.message
    );
    assert!(stdin.write_attempted());
    assert!(service.events_after(0).iter().any(|event| {
        event.event_type == "task_reply.failed"
            && event.data["task_id"] == json!(task.task_id)
            && event.data["ask_id"] == json!("r1")
            && event.data["status"] == json!("write_failed")
    }));
    let snapshot = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task exists");
    let request = snapshot
        .requests
        .iter()
        .find(|request| request.request_id == "r1")
        .expect("request should exist");
    assert_eq!(request.state, TaskRequestState::WriteFailed);
}

#[tokio::test]
async fn task_reply_short_write_writer_maps_to_write_failed_diagnostic() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-reply-short-write"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_reply_short_write",
            "bash",
            "{}",
        ));
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(ShortWriteTaskStdin))
        .expect("task exists");
    assert!(matches!(
        service.inner.admit_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "need answer".to_owned(),
                expect: None,
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestFrameAdmission::Accepted(_)
    ));

    let outcome = service
        .inner
        .reply_task_request(&task.task_id, "r1", "answer");

    assert_eq!(outcome.status, TaskReplyStatus::Failed);
    assert!(outcome.message.contains("short nonblocking stdin write"));
    assert!(service.events_after(0).iter().any(|event| {
        event.event_type == "task_reply.failed"
            && event.data["task_id"] == json!(task.task_id)
            && event.data["ask_id"] == json!("r1")
            && event.data["status"] == json!("write_failed")
            && event.data["message"]
                .as_str()
                .is_some_and(|message| message.contains("short nonblocking stdin write"))
    }));
}

#[tokio::test]
async fn task_reply_escaping_heavy_payload_rejected_by_final_frame_bytes_without_resolving_ask() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-reply-frame-byte-cap"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_reply_byte_cap", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    assert!(matches!(
        service.inner.admit_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "need answer".to_owned(),
                expect: None,
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestFrameAdmission::Accepted(_)
    ));

    let outcome = service.inner.reply_task_request(
        &task.task_id,
        "r1",
        &"\\".repeat(TASK_STDIN_FRAME_SAFETY_CEILING),
    );

    assert_eq!(outcome.status, TaskReplyStatus::ResponseTooLarge);
    assert_eq!(stdin.text(), "");
    let snapshot = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task exists");
    let request = snapshot
        .requests
        .iter()
        .find(|request| request.request_id == "r1")
        .expect("request should exist");
    assert_eq!(request.state, TaskRequestState::Pending);
}

#[test]
fn task_send_escaping_heavy_payload_rejected_by_final_frame_bytes() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-send-frame-byte-cap"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_send_byte_cap", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");

    let outcome = service.inner.send_task_message_by_owner(
        &TaskOwner::Main,
        &task.task_id,
        &"\\".repeat(TASK_STDIN_FRAME_SAFETY_CEILING),
    );

    assert_eq!(outcome.status, TaskSendStatus::MessageTooLarge);
    assert_eq!(stdin.text(), "");
    assert!(!service.events_after(0).iter().any(|event| {
        event.event_type == "task_send.accepted" && event.data["task_id"] == json!(task.task_id)
    }));
}

#[tokio::test]
async fn task_stdout_observe_request_fences_activation_replace_and_disable() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-stdout-observe-fence"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_observe_fence", "bash", "{}"));
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

    bridge.handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "enable_final".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    wait_until(|| stdin.text().contains(r#""id":"enable_final""#)).await;
    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "after enable",
            message_id: Some("msg_enable"),
            cycle_id: None,
        });
    wait_until(|| stdin.text().contains("after enable")).await;

    bridge.handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "replace_final".to_owned(),
            action: TaskObserveRequestAction::Enable(TaskObserveConfig::final_text()),
        },
    )]);
    wait_until(|| stdin.text().contains(r#""id":"replace_final""#)).await;
    bridge.handle_frame_events(vec![BotifiedFrameEvent::ObserveRequest(
        TaskObserveRequestFrame {
            id: "disable_final".to_owned(),
            action: TaskObserveRequestAction::Disable,
        },
    )]);
    wait_until(|| stdin.text().contains(r#""id":"disable_final""#)).await;
    service
        .inner
        .task_observer
        .publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "must not appear",
            message_id: Some("msg_disabled"),
            cycle_id: None,
        });
    tokio::task::yield_now().await;

    let frames = botified_frame_strings(&stdin.text())
        .into_iter()
        .map(|frame| botified_json_from_frame(&frame))
        .collect::<Vec<_>>();
    let enable = frames
        .iter()
        .position(|frame| frame["id"] == "enable_final")
        .unwrap();
    let observed = frames
        .iter()
        .position(|frame| frame["text"] == "after enable")
        .unwrap();
    assert!(enable < observed, "success result must fence observation");
    assert!(!stdin.text().contains("must not appear"));
    let lifecycle = service.events_after(0);
    assert!(lifecycle
        .iter()
        .any(|event| event.event_type == "task_observer.enabled"));
    assert!(lifecycle
        .iter()
        .any(|event| event.event_type == "task_observer.replaced"));
    assert!(lifecycle
        .iter()
        .any(|event| event.event_type == "task_observer.disabled"));
}

