#[test]
fn task_send_rejects_bounded_terminal_noninteractive_oversized_write_failed_and_cross_owner() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-send-rejections"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");

    let terminal = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_terminal_send", "bash", "{}"));
    service
        .inner
        .background_tasks
        .finish_task(&terminal.task_id, TaskState::Completed, "done")
        .expect("task should finish");
    let terminal_send =
        service
            .inner
            .send_task_message_by_owner(&TaskOwner::Main, &terminal.task_id, "hello");
    assert_eq!(terminal_send.status, TaskSendStatus::TaskTerminal);

    let noninteractive = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_no_stdin_send", "bash", "{}"));
    let noninteractive_send = service.inner.send_task_message_by_owner(
        &TaskOwner::Main,
        &noninteractive.task_id,
        "hello",
    );
    assert_eq!(noninteractive_send.status, TaskSendStatus::StdinNotWritable);

    let oversized = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_oversized_send", "bash", "{}"));
    let oversized_stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&oversized.task_id, Arc::new(oversized_stdin.clone()))
        .expect("task exists");
    let oversized_send = service.inner.send_task_message_by_owner(
        &TaskOwner::Main,
        &oversized.task_id,
        &"x".repeat(TASK_STDIN_FRAME_SAFETY_CEILING),
    );
    assert_eq!(oversized_send.status, TaskSendStatus::MessageTooLarge);
    assert_eq!(oversized_stdin.text(), "");

    let failing = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_failed_send", "bash", "{}"));
    service
        .inner
        .background_tasks
        .register_stdin_writer(&failing.task_id, Arc::new(FailingTaskStdin))
        .expect("task exists");
    let failed_send =
        service
            .inner
            .send_task_message_by_owner(&TaskOwner::Main, &failing.task_id, "hello");
    assert_eq!(failed_send.status, TaskSendStatus::WriteFailed);
    assert!(service.events_after(0).iter().any(|event| {
        event.event_type == "task_send.failed"
            && event.data["task_id"] == json!(failing.task_id)
            && event.data["status"] == json!("write_failed")
    }));

    let subagent_owned = service.inner.background_tasks.start_task(
        NewBackgroundTask::new("call_cross_owner_send", "bash", "{}")
            .with_owner(TaskOwner::subagent("branch-send")),
    );
    let cross_owner_stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&subagent_owned.task_id, Arc::new(cross_owner_stdin.clone()))
        .expect("task exists");
    let cross_owner_send = service.inner.send_task_message_by_owner(
        &TaskOwner::Main,
        &subagent_owned.task_id,
        "hello",
    );
    assert_eq!(cross_owner_send.status, TaskSendStatus::UnknownTask);
    assert_eq!(cross_owner_stdin.text(), "");
}

#[tokio::test]
async fn task_request_profiling_records_requested_written_and_expired_without_payloads() {
    let (profiler, report_dir) = service_test_profiler("task-request-lifecycle");
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-request-profile"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed")
    .with_profiler(Some(profiler.clone()));
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_profiled", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin))
        .expect("task exists");

    assert!(matches!(
        service.inner.admit_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "need secret input".to_owned(),
                expect: Some("short secret answer".to_owned()),
                timeout: Some(Duration::from_secs(60)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestFrameAdmission::Accepted(_)
    ));
    let written = service
        .inner
        .reply_task_request(&task.task_id, "r1", "raw answer");
    assert_eq!(written.status, TaskReplyStatus::Written);

    assert!(matches!(
        service.inner.admit_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "r2".to_owned(),
                request: "expire this payload".to_owned(),
                expect: None,
                timeout: Some(Duration::from_nanos(1)),
                urgency: InputUrgency::Urgent,
            },
        ),
        TaskRequestFrameAdmission::Accepted(_)
    ));
    service
        .inner
        .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    assert!(events.contains(",task_ask,task_ask.requested,pending,"));
    assert!(events.contains(",task_ask,task_reply.written,written,"));
    assert!(events.contains(",task_ask,task_ask.expired,expired,"));
    assert!(!events.contains("need secret input"));
    assert!(!events.contains("short secret answer"));
    assert!(!events.contains("raw answer"));
    assert!(!events.contains("expire this payload"));

    let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
    assert_eq!(summary_value(&summary, "task_requests"), "2");
    assert_eq!(summary_value(&summary, "task_requests_replied"), "1");
    assert_eq!(summary_value(&summary, "task_requests_expired"), "1");
    assert_eq!(summary_value(&summary, "task_requests_failed"), "0");
}

#[test]
fn task_request_profiling_records_missing_task_rejection_without_payload() {
    let (profiler, report_dir) = service_test_profiler("task-request-missing");
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-request-missing-profile"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed")
    .with_profiler(Some(profiler.clone()));

    assert!(matches!(
        service.inner.admit_task_request_frame(
            "missing_task",
            TaskRequestFrame {
                id: "q1".to_owned(),
                request: "raw payload must stay out of profiling".to_owned(),
                expect: Some("secret expected shape".to_owned()),
                timeout: Some(Duration::from_secs(60)),
                urgency: InputUrgency::Urgent,
            },
        ),
        TaskRequestFrameAdmission::None
    ));

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    assert!(events.contains(",task_ask,task_ask.rejected,rejected,"));
    assert!(events.contains(",missing_task,q1,"));
    assert!(events.contains(",urgent,"));
    assert!(events.contains(",task_not_found,"));
    assert!(!events.contains("raw payload must stay out of profiling"));
    assert!(!events.contains("secret expected shape"));

    let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
    assert_eq!(summary_value(&summary, "task_requests"), "1");
    assert_eq!(summary_value(&summary, "task_requests_failed"), "1");
}

#[test]
fn task_request_profiling_records_malformed_diagnostic_without_counting_task_request() {
    let (profiler, report_dir) = service_test_profiler("task-request-diagnostic");
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-diagnostic-profile"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed")
    .with_profiler(Some(profiler.clone()));
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_profiled", "bash", "{}"));

    service.inner.handle_task_frame_diagnostic(
        &task.task_id,
        TaskFrameDiagnostic {
            op: None,
            code: "malformed_frame",
            message: "invalid botified frame JSON".to_owned(),
            request_id: None,
        },
    );

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    assert!(events.contains(",task_ask,task_ask.rejected,rejected,"));
    assert!(events.contains(",malformed_frame,false,task frame diagnostic rejected"));
    assert!(!events.contains("invalid botified frame JSON"));

    let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
    assert_eq!(summary_value(&summary, "task_requests"), "0");
    assert_eq!(summary_value(&summary, "task_requests_failed"), "0");
}

#[test]
fn task_request_profiling_records_diagnostic_with_request_id_without_payload_message() {
    let (profiler, report_dir) = service_test_profiler("task-request-diagnostic-with-id");
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-diagnostic-with-id-profile"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed")
    .with_profiler(Some(profiler.clone()));
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_profiled", "bash", "{}"));

    service.inner.handle_task_frame_diagnostic(
        &task.task_id,
        TaskFrameDiagnostic {
            op: Some("ask".to_owned()),
            code: "unknown_field",
            message: "unknown field fake_secret_field with value sk-fake-secret".to_owned(),
            request_id: Some("q1".to_owned()),
        },
    );

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    assert!(events.contains(",task_ask,task_ask.rejected,rejected,"));
    assert!(events.contains(",unknown_field,false,"));
    assert!(events.contains(&format!(",{},q1,", task.task_id)));
    assert!(!events.contains("fake_secret_field"));
    assert!(!events.contains("sk-fake-secret"));

    let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
    assert_eq!(summary_value(&summary, "task_requests"), "1");
    assert_eq!(summary_value(&summary, "task_requests_failed"), "1");
}

#[test]
fn task_tell_and_send_profiling_records_structured_fields_without_payloads() {
    fn csv_field<'a>(headers: &[&str], row: &'a [&str], name: &str) -> &'a str {
        let index = headers
            .iter()
            .position(|header| *header == name)
            .unwrap_or_else(|| panic!("missing CSV column {name}"));
        row.get(index)
            .copied()
            .unwrap_or_else(|| panic!("CSV row missing column {name}"))
    }

    let (profiler, report_dir) = service_test_profiler("task-tell-send-profile");
    let service = Service::new(
        AgentConfig::new("system").with_session("service-task-tell-send-profile"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed")
    .with_profiler(Some(profiler.clone()));
    let tell_task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_profiled_tell", "bash", "{}"));
    let tell_message = "raw tell payload must stay out of profiling";
    let tell = super::task_runtime::task_tell_snapshot(
        &tell_task.task_id,
        Some(&tell_task),
        TaskTellFrame {
            id: "tell-profile-1".to_owned(),
            message: tell_message.to_owned(),
            urgency: InputUrgency::Urgent,
        },
        "rejected",
        Some("tell profile rejection".to_owned()),
    );
    service
        .inner
        .write_task_tell_profile("task_tell.rejected", &tell);

    let send_task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_profiled_send", "bash", "{}"));
    service
        .inner
        .background_tasks
        .register_stdin_writer(&send_task.task_id, Arc::new(FailingTaskStdin))
        .expect("task exists");
    let send_message = "raw send payload must stay out of profiling";
    let send = service.inner.send_task_message_by_owner(
        &TaskOwner::Main,
        &send_task.task_id,
        send_message,
    );
    assert_eq!(send.status, TaskSendStatus::WriteFailed);
    let send_id = send.send_id.as_deref().expect("failed write retains send ID");

    profiler
        .lock()
        .expect("profiler mutex poisoned")
        .finish()
        .expect("summary should write");
    let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
    let mut lines = events.lines();
    let headers = lines
        .next()
        .expect("events CSV should have a header")
        .split(',')
        .collect::<Vec<_>>();
    let rows = lines
        .map(|line| line.split(',').collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let tell_row = rows
        .iter()
        .find(|row| {
            csv_field(&headers, row, "kind") == "task_tell"
                && csv_field(&headers, row, "event_name") == "task_tell.rejected"
        })
        .expect("task tell profile row should exist");
    assert_eq!(csv_field(&headers, tell_row, "status"), "rejected");
    assert_eq!(
        csv_field(&headers, tell_row, "task_id"),
        tell_task.task_id
    );
    assert_eq!(
        csv_field(&headers, tell_row, "task_tell_id"),
        "tell-profile-1"
    );
    assert_eq!(csv_field(&headers, tell_row, "task_urgency"), "urgent");
    assert_eq!(
        csv_field(&headers, tell_row, "task_tell_bytes"),
        tell_message.len().to_string()
    );
    assert_eq!(csv_field(&headers, tell_row, "task_state"), "rejected");
    assert_eq!(csv_field(&headers, tell_row, "error_kind"), "rejected");
    assert_eq!(
        csv_field(&headers, tell_row, "error_message_truncated"),
        "tell profile rejection"
    );

    let send_row = rows
        .iter()
        .find(|row| {
            csv_field(&headers, row, "kind") == "task_send"
                && csv_field(&headers, row, "event_name") == "task_send.failed"
        })
        .expect("task send failure profile row should exist");
    assert_eq!(csv_field(&headers, send_row, "status"), "write_failed");
    assert_eq!(
        csv_field(&headers, send_row, "task_id"),
        send_task.task_id
    );
    assert_eq!(csv_field(&headers, send_row, "task_send_id"), send_id);
    assert_eq!(
        csv_field(&headers, send_row, "task_state"),
        "write_failed"
    );
    assert_eq!(
        csv_field(&headers, send_row, "error_kind"),
        "write_failed"
    );
    assert_eq!(
        csv_field(&headers, send_row, "error_message_truncated"),
        "stdin closed"
    );
    assert!(!events.contains(tell_message));
    assert!(!events.contains(send_message));
}

#[test]
fn accepted_task_request_enqueue_failure_after_expired_does_not_emit_second_terminal_effect() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-enqueue-failure-after-expired"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_expired_reject", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("task exists");
    assert!(matches!(
        service.inner.background_tasks.accept_task_request(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "need input".to_owned(),
                expect: None,
                timeout: Some(Duration::from_nanos(1)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestAdmission::Accepted(_)
    ));

    service
        .inner
        .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));
    service
        .inner
        .reject_accepted_task_request_after_enqueue_failure(
            &task.task_id,
            "r1",
            &ServiceError::QueueFull,
        );

    let events = service.events_after(0);
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "task_ask.expired" && event.data["ask_id"] == "r1"
            })
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "task_ask.rejected" && event.data["ask_id"] == "r1"
            })
            .count(),
        0,
        "enqueue failure must not emit a second terminal task_ask event after expiration"
    );
    let stdin_text = stdin.text();
    assert_eq!(stdin_text.matches("\"code\":\"ask_expired\"").count(), 1);
    assert_eq!(stdin_text.matches("\"code\":\"queue_full\"").count(), 0);
}

#[tokio::test]
async fn main_task_ask_queue_full_rejects_once_and_writes_correlated_exception() {
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_limits(
        AgentConfig::new("system").with_session("service-main-task-ask-queue-full"),
        provider.clone(),
        Vec::new(),
        ServiceLimits::new(1),
    )
    .expect("service construction should succeed");
    let queued_sentinel = QueuedMessage {
        id: "queued_user".to_owned(),
        content: vec![ContentPart::text("queued")],
        source: InputSource::User,
        urgency: InputUrgency::Normal,
        metadata: None,
        cursor_seq: service.inner.last_event_seq(),
        delivery: None,
    };
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_queue_full".to_owned());
        state.active_cancel = Some(CancellationToken::new());
        state.input_queue.enqueue(queued_sentinel.clone());
    }
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_queue_full_ask", "bash", "{}"));
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
        .expect("running task should accept stdin writer");

    let start = service
        .inner
        .handle_task_request_frame(
            &task.task_id,
            TaskRequestFrame {
                id: "queue_full_ask".to_owned(),
                request: "ask the agent".to_owned(),
                expect: Some("short answer".to_owned()),
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        )
        .await;

    assert!(start.is_none());
    let request = service
        .inner
        .background_tasks
        .get(&task.task_id)
        .expect("task should remain inspectable")
        .requests
        .into_iter()
        .find(|request| request.request_id == "queue_full_ask")
        .expect("request should be retained");
    assert_eq!(request.state, TaskRequestState::Rejected);

    let events = service.events_after(0);
    let requested = events
        .iter()
        .filter(|event| {
            event.event_type == "task_ask.requested"
                && event.data["task_id"] == task.task_id
                && event.data["ask_id"] == "queue_full_ask"
        })
        .collect::<Vec<_>>();
    let rejected = events
        .iter()
        .filter(|event| {
            event.event_type == "task_ask.rejected"
                && event.data["task_id"] == task.task_id
                && event.data["ask_id"] == "queue_full_ask"
        })
        .collect::<Vec<_>>();
    assert_eq!(requested.len(), 1);
    assert_eq!(rejected.len(), 1);
    let input_id = task_request_input_id(&task.task_id, "queue_full_ask");
    let message_rejected = events
        .iter()
        .filter(|event| {
            event.event_type == "message.rejected" && event.data["message_id"] == input_id
        })
        .collect::<Vec<_>>();
    assert_eq!(message_rejected.len(), 1);
    assert_eq!(message_rejected[0].data["error"]["code"], "queue_full");
    assert!(
        requested[0].seq < message_rejected[0].seq
            && message_rejected[0].seq < rejected[0].seq,
        "task request admission, enqueue rejection, and task rejection must commit in order"
    );
    assert!(!events.iter().any(|event| {
        matches!(event.event_type.as_str(), "message.received" | "message.queued")
            && event.data["input_kind"] == "task_request"
    }));

    let frames = botified_frame_strings(&stdin.text())
        .into_iter()
        .map(|frame| botified_json_from_frame(&frame))
        .collect::<Vec<_>>();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["op"], "reply");
    assert_eq!(frames[0]["id"], "queue_full_ask");
    assert_eq!(frames[0]["exception"]["code"], "queue_full");
    assert_eq!(provider.calls(), 0);

    let state = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned");
    assert_eq!(
        state.input_queue.iter().cloned().collect::<Vec<_>>(),
        vec![queued_sentinel]
    );
}

#[test]
fn subagent_owned_task_request_effects_publish_canonical_terminal_events() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-request-effects"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open("Worker", "request effects")
        .expect("open subagent")
        .id;
    let task = service.inner.background_tasks.start_task(
        NewBackgroundTask::new("call_subagent_request_effects", "bash", "{}")
            .with_owner(TaskOwner::subagent(subagent_id.clone())),
    );
    let stdin = RecordingTaskStdin::default();
    service
        .inner
        .background_tasks
        .register_stdin_writer(&task.task_id, Arc::new(stdin))
        .expect("task exists");
    assert!(matches!(
        service.inner.background_tasks.accept_task_request(
            &task.task_id,
            TaskRequestFrame {
                id: "expires".to_owned(),
                request: "request expires".to_owned(),
                expect: None,
                timeout: Some(Duration::from_nanos(1)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestAdmission::Accepted(_)
    ));

    service
        .inner
        .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));
    assert!(matches!(
        service.inner.background_tasks.accept_task_request(
            &task.task_id,
            TaskRequestFrame {
                id: "terminal".to_owned(),
                request: "request terminal".to_owned(),
                expect: None,
                timeout: Some(Duration::from_secs(30)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestAdmission::Accepted(_)
    ));
    let finalization = service
        .inner
        .background_tasks
        .finish_task(&task.task_id, TaskState::Failed, "task terminated")
        .expect("finish task");
    service
        .inner
        .apply_task_request_effects(&finalization.pending_request_effects);

    let events = service.events_after(0);
    for (event_type, ask_id, reply_status, state) in [
        ("task_ask.expired", "expires", "expired", "expired"),
        ("task_ask.rejected", "terminal", "rejected", "task_terminal"),
    ] {
        let event = events
            .iter()
            .find(|event| event.event_type == event_type && event.data["ask_id"] == json!(ask_id))
            .unwrap_or_else(|| panic!("missing {event_type} for {ask_id}: {events:#?}"));
        assert_eq!(event.data["subagent_id"], json!(subagent_id));
        assert_eq!(event.data["task_id"], json!(task.task_id));
        assert_eq!(event.data["reply_status"], json!(reply_status));
        assert_eq!(event.data["state"], json!(state));
    }
}

#[test]
fn task_request_effect_stdin_write_failure_emits_bounded_diagnostic() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-effect-stdin-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_stdin_missing", "bash", "{}"));
    assert!(matches!(
        service.inner.background_tasks.accept_task_request(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "need input".to_owned(),
                expect: None,
                timeout: Some(Duration::from_nanos(1)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestAdmission::Accepted(_)
    ));

    service
        .inner
        .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));

    let diagnostic = service
        .events_after(0)
        .into_iter()
        .find(|event| event.event_type == "task.stdin_write_failed")
        .expect("effect stdin failure should emit a diagnostic event");
    assert_eq!(diagnostic.data["task_id"], json!(task.task_id));
    assert_eq!(diagnostic.data["ask_id"], json!("r1"));
    assert_eq!(diagnostic.data["kind"], json!("ask_expired"));
    assert!(diagnostic.data["error"]
        .as_str()
        .expect("diagnostic error should be a string")
        .contains("stdin"));
}

#[test]
fn ask_timeout_exception_rejecting_writer_records_diagnostic_without_sync_fallback() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-effect-rejecting-writer"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_effect_rejecting_writer",
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
        service.inner.background_tasks.accept_task_request(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "need input".to_owned(),
                expect: None,
                timeout: Some(Duration::from_nanos(1)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestAdmission::Accepted(_)
    ));

    service
        .inner
        .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));

    assert!(stdin.write_attempted());
    let diagnostic = service
        .events_after(0)
        .into_iter()
        .find(|event| event.event_type == "task.stdin_write_failed")
        .expect("effect stdin failure should emit a diagnostic event");
    assert_eq!(diagnostic.data["task_id"], json!(task.task_id));
    assert_eq!(diagnostic.data["ask_id"], json!("r1"));
    assert_eq!(diagnostic.data["kind"], json!("ask_expired"));
    assert!(
        diagnostic.data["error"]
            .as_str()
            .expect("diagnostic error should be a string")
            .contains("unsupported"),
        "{diagnostic:?}"
    );
}

#[test]
fn ask_timeout_exception_would_block_writer_records_diagnostic_without_sync_fallback() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-effect-would-block-priority"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_effect_would_block_priority",
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
        service.inner.background_tasks.accept_task_request(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "need input".to_owned(),
                expect: None,
                timeout: Some(Duration::from_nanos(1)),
                urgency: InputUrgency::Normal,
            },
        ),
        TaskRequestAdmission::Accepted(_)
    ));

    service
        .inner
        .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));

    assert!(stdin.write_attempted());
    let diagnostic = service
        .events_after(0)
        .into_iter()
        .find(|event| event.event_type == "task.stdin_write_failed")
        .expect("effect stdin failure should emit a diagnostic event");
    assert_eq!(diagnostic.data["task_id"], json!(task.task_id));
    assert_eq!(diagnostic.data["ask_id"], json!("r1"));
    assert_eq!(diagnostic.data["kind"], json!("ask_expired"));
    assert!(
        diagnostic.data["error"]
            .as_str()
            .expect("diagnostic error should be a string")
            .contains("would block"),
        "{diagnostic:?}"
    );
}
