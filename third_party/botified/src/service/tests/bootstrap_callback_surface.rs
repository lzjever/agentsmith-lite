#[test]
fn cold_timeline_scan_does_not_hold_service_store_mutex() {
    let mut config = AgentConfig::new("system").with_session("cold-read-append");
    config.task_output.data_dir = service_test_home("cold-read-append");
    let service = Service::new(config, Arc::new(PanicProvider), Vec::new())
        .expect("service construction should succeed");
    {
        let mut store = service.inner.timeline_store.lock().unwrap();
        for index in 0..20 {
            store
                .append(TimelineAppend::new(
                    format!("seed-{index}"),
                    "cold-read-append",
                    Value::Null,
                ))
                .expect("seed timeline");
        }
        store.clear_hot_cache_for_test();
    }

    let (scan_started_tx, scan_started_rx) = std::sync::mpsc::sync_channel(1);
    let (release_scan_tx, release_scan_rx) = std::sync::mpsc::sync_channel(1);
    let release_scan_rx = Arc::new(Mutex::new(release_scan_rx));
    let first_segment = Arc::new(AtomicBool::new(true));
    service
        .inner
        .timeline_store
        .lock()
        .unwrap()
        .set_segment_state_observer_for_test({
            let first_segment = first_segment.clone();
            move || {
                if first_segment.swap(false, Ordering::AcqRel) {
                    scan_started_tx.send(()).unwrap();
                    release_scan_rx.lock().unwrap().recv().unwrap();
                }
            }
        });

    let reading_service = service.clone();
    let reader = std::thread::spawn(move || reading_service.timeline_tail_page(5));
    scan_started_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("cold scan should start");

    let (append_done_tx, append_done_rx) = std::sync::mpsc::sync_channel(1);
    let timeline_store = service.inner.timeline_store.clone();
    let event_log = service.inner.event_log.clone();
    let appender = std::thread::spawn(move || {
        let result = append_committed_service_event(
            &timeline_store,
            &event_log,
            None,
            Some("cold-read-append"),
            None,
            "concurrent-append",
            Value::Null,
        );
        append_done_tx.send(result.is_ok()).unwrap();
    });
    let append_finished_while_scan_blocked = append_done_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or(false);

    release_scan_tx.send(()).unwrap();
    assert!(reader.join().unwrap().is_ok());
    appender.join().unwrap();
    assert!(
        append_finished_while_scan_blocked,
        "append must not wait for cold timeline parsing"
    );
}

fn timeline_init_for_test(name: &str) -> ServiceInit {
    let mut config = AgentConfig::new("system").with_session(name);
    config.task_output.data_dir = service_test_home(name);
    ServiceInit::new(config, Arc::new(PanicProvider), Vec::new())
}

fn assert_timeline_init_persistence_error(result: Result<Service, ServiceError>, detail: &str) {
    match result {
        Err(ServiceError::Persistence { message }) => {
            assert!(
                message.contains(detail),
                "unexpected persistence error: {message}"
            );
        }
        Err(error) => panic!("expected persistence error, got {error:?}"),
        Ok(_) => panic!("timeline initialization failure should reject construction"),
    }
}

#[test]
fn timeline_store_open_failure_returns_persistence_error() {
    let init = timeline_init_for_test("timeline-open-failure");
    let data_dir = init.config.task_output.data_dir.clone();
    fs::write(&data_dir, b"not a directory").expect("timeline failure fixture should write");

    let result = Service::from_init(init);
    fs::remove_file(data_dir).expect("timeline failure fixture should clean up");
    assert_timeline_init_persistence_error(result, "timeline io error");
}

#[test]
fn service_started_append_failure_returns_persistence_error() {
    let mut init = timeline_init_for_test("timeline-started-append-failure");
    init.timeline_init_write_failure = Some((
        TimelineInitAppendPoint::ServiceStarted,
        TimelineWriteFailure::Flush,
    ));

    assert_timeline_init_persistence_error(
        Service::from_init(init),
        "injected timeline flush failure",
    );
}

#[test]
fn service_warning_append_failure_returns_persistence_error() {
    let mut init = timeline_init_for_test("timeline-warning-append-failure");
    init.warnings.push("startup warning".to_owned());
    init.timeline_init_write_failure = Some((
        TimelineInitAppendPoint::ServiceWarning,
        TimelineWriteFailure::Flush,
    ));

    assert_timeline_init_persistence_error(
        Service::from_init(init),
        "injected timeline flush failure",
    );
}

async fn restart_and_commit_pending_callback(
    home: &PathBuf,
    expected_source: InputSource,
    pending_event: ServiceEvent,
    delivered_event_type: &str,
) -> (DrainedMessage, Value, Value) {
    let reopened = open_or_create_session_in_home_with_cwd("service-test", home, "/repo")
        .expect("pending callback session should reopen");
    assert_eq!(reopened.pending_messages().len(), 1);
    assert_eq!(reopened.pending_messages()[0].source, expected_source);

    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        reopened.replay(),
        Some(reopened.recorder()),
        reopened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    assert!(service.inner.background_tasks.list().is_empty());
    assert!(service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .list()
        .is_empty());
    assert_eq!(service.status().queue_length, 1);

    let before_delivery = service.inner.last_event_seq();
    let batch = service.begin_drain(CancellationToken::new()).await;
    assert_eq!(batch.messages.len(), 1);
    let drained = batch.messages[0].clone();
    assert_eq!(drained.source, expected_source);
    let commit = service
        .commit(&batch.id)
        .await
        .expect("restarted callback commit should prepare");
    assert_eq!(commit.callback_delivery_input_ids, vec![drained.id.clone()]);
    service
        .complete_commit(&batch.id, &commit, Some("cycle_after_restart"))
        .await
        .expect("restarted callback commit should complete");
    assert_eq!(service.status().queue_length, 0);
    assert!(service.inner.background_tasks.list().is_empty());
    assert!(service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .list()
        .is_empty());

    let delivered = service
        .events_after(before_delivery)
        .into_iter()
        .find(|event| event.event_type == delivered_event_type)
        .expect("callback delivered event should be appended after restart");
    let replayed = open_or_create_session_in_home_with_cwd("service-test", home, "/repo")
        .expect("committed callback session should reopen");
    assert!(replayed.pending_messages().is_empty());
    (drained, pending_event.data, delivered.data)
}

fn service_provider_visible_tool_names(service: &Service) -> BTreeSet<String> {
    crate::tools::tools_for_main(&service.inner.tools)
        .into_iter()
        .map(|tool| tool.spec().name)
        .collect()
}

fn expected_service_tool_names(extra: &[&str]) -> BTreeSet<String> {
    [
        "task_list",
        "task_cancel",
        "task_reply",
        "task_send",
        "task_preset_list",
        "task_preset_start",
    ]
    .into_iter()
    .chain(extra.iter().copied())
    .map(ToOwned::to_owned)
    .collect()
}

fn complete_task_callback_fixture(service: &Service, task_id: &str) {
    service
        .inner
        .background_tasks
        .update_output(task_id, TaskOutputUpdate::bytes("callback output"))
        .expect("task output should update");
    service
        .inner
        .background_tasks
        .finish_task(task_id, TaskState::Completed, "task completed")
        .expect("task should become terminal");
}

fn service_task_surface_snapshot(state: TaskState, output_tail: String) -> TaskSnapshot {
    let artifact_path = PathBuf::from(".botified/state/tasks/task_surface/output.log");
    TaskSnapshot {
        task_id: "task_surface".to_owned(),
        tool_call_id: "call_surface".to_owned(),
        tool_name: "bash".to_owned(),
        arguments_summary: format!("{}ARGUMENT_TAIL_SENTINEL", "a".repeat(600)),
        task_label: None,
        preset_id: Some("preset_surface".to_owned()),
        preset_description: Some("Surface preset".to_owned()),
        owner: TaskOwner::Main,
        state,
        started_at: UNIX_EPOCH + Duration::from_secs(100),
        detached_at: Some(UNIX_EPOCH + Duration::from_secs(120)),
        timeout_at: Some(UNIX_EPOCH + Duration::from_secs(150)),
        completed_at: Some(UNIX_EPOCH + Duration::from_secs(151)),
        callback_delivery: CallbackDelivery::Failed,
        callback_payload: Some(TaskCallbackPayloadSnapshot {
            task_id: "task_surface".to_owned(),
            message_id: "task_callback_surface".to_owned(),
            content: vec![ContentPart::text("<task_callback />")],
        }),
        callback_failure_reason: Some("callback write failed".to_owned()),
        output: TaskOutputSnapshot {
            tail: output_tail,
            output_bytes: 42,
            output_live: false,
            output_complete: true,
            output_last_updated_at: Some(UNIX_EPOCH + Duration::from_secs(130)),
            artifact_path: Some(artifact_path.clone()),
            output_tail_truncated: true,
            output_artifact_truncated: true,
            output_dropped_bytes: 17,
        },
        artifact_path: Some(artifact_path),
        cancel_token: CancellationToken::new(),
        requests: Vec::new(),
    }
}

fn test_task_callback_metadata(task_id: &str) -> QueuedInputMetadata {
    QueuedInputMetadata::TaskCallback {
        task_id: task_id.to_owned(),
        tool_call_id: format!("call_{task_id}"),
        tool_name: "bash".to_owned(),
        execution_state: TaskCallbackExecutionState::Completed,
        label: Some("background task".to_owned()),
        summary: Some("test callback".to_owned()),
        output_tail: "done".to_owned(),
        output_tail_truncated: false,
        error: None,
    }
}

#[test]
fn task_callback_delivery_projects_every_terminal_state_from_metadata() {
    for (execution_state, expected) in [
        (TaskCallbackExecutionState::Completed, "completed"),
        (TaskCallbackExecutionState::Failed, "failed"),
        (TaskCallbackExecutionState::TimedOut, "timed_out"),
        (TaskCallbackExecutionState::Cancelled, "cancelled"),
        (TaskCallbackExecutionState::Lost, "lost"),
    ] {
        let mut metadata = test_task_callback_metadata("task-terminal");
        let QueuedInputMetadata::TaskCallback {
            execution_state: state,
            ..
        } = &mut metadata
        else {
            unreachable!();
        };
        *state = execution_state;
        let data = project_task_callback_delivery("callback-unique", &metadata, Some("cyc-1"));
        assert_eq!(data["state"], expected);
        assert_eq!(data["status"], expected);
        assert_eq!(data["callback_input_id"], "callback-unique");
        assert!(data.get("callback_id").is_none());
        assert_eq!(data["tool_call_id"], "call_task-terminal");
        assert_eq!(data["tool_name"], "bash");
        assert_eq!(data["task_label"], "background task");
        assert_eq!(data["work_summary"], "test callback");
        assert_eq!(data["output_tail"], "done");
        assert_eq!(data["output_tail_truncated"], false);
        assert_eq!(data["callback_delivery"], "delivered");
        assert_eq!(data["cycle_id"], "cyc-1");
    }
}

#[test]
fn lost_task_has_distinct_terminal_event_callback_body_and_subagent_kind() {
    let snapshot = service_task_surface_snapshot(TaskState::Lost, "worker disappeared".into());
    let text = task_callback_content(&ToolCall::new("call_surface", "bash", json!({})), &snapshot)
        .into_iter()
        .find_map(|part| match part {
            ContentPart::Text { text } => Some(text),
            ContentPart::ImageUrl { .. }
            | ContentPart::ImageBase64 { .. }
            | ContentPart::File { .. }
            | ContentPart::Skill { .. } => None,
        })
        .expect("callback content should include text");

    assert_eq!(terminal_task_event_type(TaskState::Lost), "task.lost");
    assert_eq!(subagent_task_callback_kind(TaskState::Lost), "task_lost");
    assert!(valid_subagent_callback_metadata(
        &QueuedInputMetadata::SubagentCallback {
            subagent_id: "worker".into(),
            kind: "task_lost".into(),
            task_id: Some("task_surface".into()),
            ask_id: None,
            tell_id: None,
            task_message: None,
            label: None,
            summary: None,
        }
    ));
    assert!(text.contains("status=\"lost\""), "{text}");
    assert!(!text.contains("status=\"failed\""), "{text}");
}

#[test]
fn subagent_callback_metadata_identity_matrix_is_strict() {
    let metadata = |kind: &str, (task, ask, tell): (bool, bool, bool)| {
        QueuedInputMetadata::SubagentCallback {
            subagent_id: "worker".to_owned(),
            kind: kind.to_owned(),
            task_id: task.then(|| "task".to_owned()),
            ask_id: ask.then(|| "ask".to_owned()),
            tell_id: tell.then(|| "tell".to_owned()),
            task_message: Some("task message".to_owned()),
            label: Some("worker label".to_owned()),
            summary: Some("worker summary".to_owned()),
        }
    };
    let cases = [
        ("completed", Some((false, false, false))),
        ("failed", Some((false, false, false))),
        ("task_ask", Some((true, true, false))),
        ("task_tell", Some((true, false, true))),
        ("task_completed", Some((true, false, false))),
        ("task_failed", Some((true, false, false))),
        ("task_timed_out", Some((true, false, false))),
        ("task_cancelled", Some((true, false, false))),
        ("task_lost", Some((true, false, false))),
        ("unknown", None),
    ];

    for (kind, required) in cases {
        for mask in 0_u8..8 {
            let presence = (
                mask & 0b001 != 0,
                mask & 0b010 != 0,
                mask & 0b100 != 0,
            );
            assert_eq!(
                valid_subagent_callback_metadata(&metadata(kind, presence)),
                required == Some(presence),
                "kind={kind}, presence={presence:?}, required={required:?}"
            );
        }
    }

    assert!(!valid_subagent_callback_metadata(
        &test_task_callback_metadata("task")
    ));
}

#[test]
fn task_callback_delivery_core_fields_do_not_depend_on_manager_snapshot() {
    fn event(service: &Service, metadata: QueuedInputMetadata) -> Value {
        let plan = InputQueueCommitPlan {
            batch_id: "batch-manager-independence".to_owned(),
            messages: vec![QueuedMessage {
                id: "callback-stable".to_owned(),
                content: vec![ContentPart::text("opaque callback body")],
                source: InputSource::TaskCallback,
                urgency: InputUrgency::Normal,
                metadata: Some(metadata),
                cursor_seq: 7,
                delivery: None,
            }],
        };
        service.inner.prepare_callback_delivery_events(&plan, None)[0]
            .data
            .clone()
    }

    let without_manager = Service::new(
        AgentConfig::new("system"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let with_manager = Service::new(
        AgentConfig::new("system"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    with_manager.inner.background_tasks.start_task_with_id(
        "task-stable",
        NewBackgroundTask::new("different-call", "different-tool", "different summary"),
    );
    let metadata = test_task_callback_metadata("task-stable");
    assert_eq!(
        event(&without_manager, metadata.clone()),
        event(&with_manager, metadata)
    );
}

#[test]
fn task_event_data_preserves_task_surface_facts_for_timeline_projection() {
    let snapshot = service_task_surface_snapshot(TaskState::TimedOut, "0123456789".to_owned());
    let data = task_event_data(&snapshot);

    assert_eq!(data["task_id"], json!("task_surface"));
    assert_eq!(data["tool_call_id"], json!("call_surface"));
    assert_eq!(data["tool_name"], json!("bash"));
    assert_eq!(data["preset_id"], json!("preset_surface"));
    assert_eq!(data["preset_description"], json!("Surface preset"));
    assert_eq!(data["state"], json!("timed_out"));
    assert_eq!(data["status"], json!("timed_out"));
    assert_eq!(data["arguments_summary"].as_str().unwrap().len(), 512);
    assert!(!data["arguments_summary"]
        .as_str()
        .unwrap()
        .contains("ARGUMENT_TAIL_SENTINEL"));
    assert_eq!(data["timeout_secs"], json!(30.0));
    assert_eq!(data["timeout_at"], json!("1970-01-01T00:02:30Z"));
    assert_eq!(data["forced_termination_at"], json!("1970-01-01T00:02:30Z"));
    assert_eq!(data["output_tail"], json!("0123456789"));
    assert_eq!(data["output_live"], json!(false));
    assert_eq!(data["output_complete"], json!(true));
    assert_eq!(data["output_bytes"], json!(42));
    assert_eq!(
        data["output_last_updated_at"],
        json!("1970-01-01T00:02:10Z")
    );
    assert_eq!(data["output_tail_truncated"], json!(true));
    assert_eq!(
        data["output_artifact_path"],
        json!(".botified/state/tasks/task_surface/output.log")
    );
    assert_eq!(data["output_artifact_truncated"], json!(true));
    assert_eq!(data["output_dropped_bytes"], json!(17));
    assert_eq!(data["callback_delivery"], json!("failed"));
    assert_eq!(
        data["callback_failure_reason"],
        json!("callback write failed")
    );
    assert_eq!(data["callback_input_id"], json!("task_callback_surface"));

    let projected = crate::timeline::project_timeline_event(
        &ServiceEvent {
            seq: 42,
            time: "1970-01-01T00:00:00Z".to_owned(),
            event_type: "task.updated".to_owned(),
            session: Some("session_surface".to_owned()),
            turn_id: None,
            data: data.clone(),
        },
        "p7k3",
    )
    .expect("task.updated should project to timeline");
    assert_eq!(projected.event_type, "background_task.updated");
    assert_eq!(
        projected.item,
        Some(TimelineItem::new(
            "task_task_surface",
            "background_task",
            "timed_out"
        ))
    );
    assert_eq!(projected.data, data);
}

#[test]
fn task_interaction_event_data_preserves_complete_message_for_timeline_detail() {
    let service = Service::new(
        AgentConfig::new("system").with_session("task-interaction-event-detail"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let ask_message = format!("{}ASK_EVENT_TAIL_SENTINEL", "ask ".repeat(1_300));
    let tell_message = format!("{}TELL_EVENT_TAIL_SENTINEL", "tell ".repeat(1_050));
    let arguments_summary = format!("{}ARGUMENT_TAIL_SENTINEL", "argument ".repeat(80));
    let diagnostic = format!("{}DIAGNOSTIC_TAIL_SENTINEL", "diagnostic ".repeat(500));
    let requested_at = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
    let ask = TaskRequestSnapshot {
        task_id: "task_event_detail".to_owned(),
        tool_call_id: "call_event_detail".to_owned(),
        tool_name: "bash".to_owned(),
        arguments_summary: arguments_summary.clone(),
        task_label: Some("background task".to_owned()),
        work_summary: Some("event detail test".to_owned()),
        owner: TaskOwner::Main,
        sender: "bash: bounded summary".to_owned(),
        request_id: "ask_event_detail".to_owned(),
        request: ask_message.clone(),
        expect: Some("single line".to_owned()),
        urgency: InputUrgency::Normal,
        state: TaskRequestState::Pending,
        requested_at,
        deadline_at: requested_at + Duration::from_secs(300),
        requested_timeout: None,
        effective_timeout: Duration::from_secs(300),
        completed_at: None,
        failure_reason: Some(diagnostic.clone()),
    };
    let tell = TaskTellSnapshot {
        task_id: "task_event_detail".to_owned(),
        tool_call_id: "call_event_detail".to_owned(),
        tool_name: "bash".to_owned(),
        arguments_summary,
        task_label: Some("background task".to_owned()),
        work_summary: Some("event detail test".to_owned()),
        owner: TaskOwner::Main,
        sender: "bash: bounded summary".to_owned(),
        tell_id: "tell_event_detail".to_owned(),
        message: tell_message.clone(),
        urgency: InputUrgency::Normal,
        state: "accepted",
        told_at: requested_at,
        failure_reason: Some(diagnostic),
    };

    for (event_type, data, expected_message, sentinel) in [
        (
            "task_ask.requested",
            task_request_event_data(&ask),
            ask_message,
            "ASK_EVENT_TAIL_SENTINEL",
        ),
        (
            "task_tell.accepted",
            task_tell_event_data(&tell),
            tell_message,
            "TELL_EVENT_TAIL_SENTINEL",
        ),
    ] {
        assert_eq!(data["message"], expected_message);
        assert!(data["message"]
            .as_str()
            .expect("task interaction message")
            .ends_with(sentinel));
        assert_eq!(
            data["arguments_summary"]
                .as_str()
                .expect("arguments summary")
                .chars()
                .count(),
            512
        );

        assert!(expected_message.chars().count() < 8 * 1024);
        let event = service.inner.append_event_for_turn(None, event_type, data);
        assert_eq!(event.data["message"], expected_message);
        assert!(!event.data["failure_reason"]
            .as_str()
            .expect("bounded failure reason")
            .contains("DIAGNOSTIC_TAIL_SENTINEL"));
        let projected = crate::timeline::project_timeline_event(&event, "p7k3")
            .expect("task interaction should project to timeline");
        assert_eq!(projected.data["message"], expected_message);
    }

    let timeline = service
        .timeline_tail_page(16)
        .expect("task interaction timeline should be readable");
    for (event_type, sentinel) in [
        ("task_ask.requested", "ASK_EVENT_TAIL_SENTINEL"),
        ("task_tell.accepted", "TELL_EVENT_TAIL_SENTINEL"),
    ] {
        let event = timeline
            .events
            .iter()
            .find(|event| event.event_type == event_type)
            .expect("persisted task interaction event");
        assert!(event.data["message"]
            .as_str()
            .expect("persisted task interaction message")
            .ends_with(sentinel));
    }
}

#[test]
fn task_callback_content_preserves_status_mapping_and_bounded_output_surface() {
    let snapshot = service_task_surface_snapshot(
        TaskState::Cancelling,
        format!("{}TAIL_SENTINEL", "x".repeat(9 * 1024)),
    );
    let text = task_callback_content(&ToolCall::new("call_surface", "bash", json!({})), &snapshot)
        .into_iter()
        .find_map(|part| match part {
            ContentPart::Text { text } => Some(text),
            ContentPart::ImageUrl { .. }
            | ContentPart::ImageBase64 { .. }
            | ContentPart::File { .. }
            | ContentPart::Skill { .. } => None,
        })
        .expect("callback content should include text");

    let attributes = parse_task_callback_xml_attributes(&text);
    assert_eq!(
        attributes.get("task_id").map(String::as_str),
        Some("task_surface")
    );
    assert_eq!(
        attributes.get("tool_call_id").map(String::as_str),
        Some("call_surface")
    );
    assert_eq!(
        attributes.get("tool_name").map(String::as_str),
        Some("bash")
    );
    assert_eq!(
        attributes.get("status").map(String::as_str),
        Some("cancelled")
    );
    assert_eq!(
        attributes.get("label").map(String::as_str),
        Some("preset_surface")
    );
    assert_eq!(
        attributes.get("summary").map(String::as_str),
        Some("Surface preset")
    );
    assert!(text.contains("output_artifact_path: .botified/state/tasks/task_surface/output.log"));
    assert!(text.contains("timeout_secs: 30"));
    assert!(text.contains("forced_termination_at: 1970-01-01T00:02:30Z"));
    assert!(text.contains("output_live: false"));
    assert!(text.contains("output_complete: true"));
    assert!(text.contains("output_bytes: 42"));
    assert!(text.contains("output_last_updated_at: 1970-01-01T00:02:10Z"));
    assert!(text.contains("output_tail_truncated: true"));
    assert!(text.contains("output_artifact_truncated: true"));
    assert!(text.contains("output_dropped_bytes: 17"));
    assert!(text.contains(&format!("output_tail:\n{}", "x".repeat(8 * 1024))));
    assert!(!text.contains("TAIL_SENTINEL"));
}

fn parse_task_callback_xml_attributes(text: &str) -> HashMap<String, String> {
    let opening_tag = text
        .strip_prefix("<task_callback ")
        .and_then(|text| text.split_once('>').map(|(tag, _)| tag))
        .expect("callback content should start with a task_callback opening tag");
    let mut attributes = HashMap::new();
    let mut remaining = opening_tag.trim();
    while !remaining.is_empty() {
        let (name, after_name) = remaining
            .split_once("=\"")
            .expect("task_callback attribute should use a quoted value");
        let (value, after_value) = after_name
            .split_once('"')
            .expect("task_callback attribute value should be closed");
        assert!(
            attributes
                .insert(name.trim().to_owned(), value.to_owned())
                .is_none(),
            "task_callback attribute names should be unique"
        );
        remaining = after_value.trim_start();
    }
    attributes
}

#[test]
fn service_thread_id_uses_session_when_present_and_local_default_otherwise() {
    let provider: Arc<dyn Provider> = Arc::new(PanicProvider);
    let with_session = Service::new(
        AgentConfig::new("system").with_session("thread-id-session"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    assert_eq!(with_session.thread_id(), "thread-id-session");

    let without_session = Service::new(AgentConfig::new("system"), provider, Vec::new())
        .expect("service construction should succeed");
    assert_eq!(without_session.thread_id(), "thread_local");
}

#[test]
fn service_constructor_matrix_preserves_provider_visible_tool_name_sets() {
    let provider: Arc<dyn Provider> = Arc::new(PanicProvider);

    let default_service = Service::new(AgentConfig::new("system"), provider.clone(), Vec::new())
        .expect("service construction should succeed");
    assert_eq!(
        service_provider_visible_tool_names(&default_service),
        expected_service_tool_names(&[])
    );

    let file_store = FileStore::open(FileStoreOptions::new(service_test_home(
        "init-tool-matrix-files",
    )))
    .expect("file store should open");
    let file_service = Service::with_file_store(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        file_store,
    )
    .expect("service construction should succeed");
    assert_eq!(
        service_provider_visible_tool_names(&file_service),
        expected_service_tool_names(&["publish_file"])
    );

    let registry_store =
        RegistryStore::new(Default::default()).expect("default registry config should be valid");
    let registry_service = Service::with_registry_store(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        registry_store,
    )
    .expect("service construction should succeed");
    assert_eq!(
        service_provider_visible_tool_names(&registry_service),
        expected_service_tool_names(&[
            "registry_set",
            "registry_delete",
            "registry_get",
            "registry_history",
        ])
    );

    let subagent_service = Service::with_subagent_options(
        AgentConfig::new("system"),
        provider,
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
    )
    .expect("service construction should succeed");
    assert_eq!(
        service_provider_visible_tool_names(&subagent_service),
        expected_service_tool_names(&[
            "subagent_spawn",
            "subagent_send",
            "subagent_read",
            "subagent_list",
            "subagent_cancel",
        ])
    );
}

#[test]
fn service_widest_replay_constructor_preserves_provider_visible_tool_names_and_replay_inputs() {
    let provider: Arc<dyn Provider> = Arc::new(PanicProvider);
    let file_store = FileStore::open(FileStoreOptions::new(service_test_home(
        "widest-replay-constructor-files",
    )))
    .expect("file store should open");
    let registry_store =
        RegistryStore::new(Default::default()).expect("default registry config should be valid");
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("widest-replay-constructor.jsonl"),
        FailingSyncSessionFile,
    ));
    let restart_boundary =
        SessionRestartBoundary::with_active_input_ids_and_active_user_message_index(
            vec!["msg_0".to_owned()],
            Some(0),
        );

    let service = Service::with_session_replay_and_limits_and_file_store_and_registry_store_and_subagent_options(
        AgentConfig::new("system").with_session("service-widest-replay-constructor"),
        provider,
        Vec::new(),
        SessionReplay {
            initial_context: vec![Message::user(vec![ContentPart::text("active replay input")])],
            pending_messages: vec![DrainedMessage::new(
                "pending_0",
                vec![ContentPart::text("pending replay input")],
            )],
            known_user_messages: vec![replay_known_message(0)],
            message_cursors: vec![replay_cursor(0)],
            restart_boundary: Some(restart_boundary),
            pending_delivery_intents: Vec::new(),
        },
        Some(recorder.clone()),
        Vec::new(),
        ServiceLimits::default(),
        file_store,
        Some(registry_store),
        ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
        3,
    ).expect("service construction should succeed");

    assert_eq!(
        service_provider_visible_tool_names(&service),
        expected_service_tool_names(&[
            "publish_file",
            "registry_set",
            "registry_delete",
            "registry_get",
            "registry_history",
            "subagent_spawn",
            "subagent_send",
            "subagent_read",
            "subagent_list",
            "subagent_cancel",
        ])
    );
    assert!(service.inner.recorder.is_some());
    assert!(Arc::ptr_eq(
        service
            .inner
            .session_recorder
            .as_ref()
            .expect("session recorder should be retained"),
        &recorder
    ));
    assert_eq!(
        service
            .inner
            .timeline_store
            .lock()
            .expect("timeline store mutex poisoned")
            .retention()
            .retention_days,
        3
    );

    let state = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned");
    assert_eq!(
        state
            .restart_boundary
            .as_ref()
            .expect("restart boundary should be retained")
            .active_input_ids(),
        ["msg_0".to_owned()].as_slice()
    );
    assert!(state.durable_message_replays.contains_key("msg_0"));
}

fn open_test_subagent(service: &Service, name: &str) -> SubagentSnapshot {
    service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .open(name, "callback early return")
        .expect("open subagent")
}

fn install_callback_outcome_state_unlocked_assertion(service: &Service) -> Arc<AtomicUsize> {
    let checks = Arc::new(AtomicUsize::new(0));
    let checks_for_hook = checks.clone();
    let inner = service.inner.clone();
    service.inner.set_subagent_test_hook(
        SubagentTestHookKind::CallbackOutcomeBeforeLifecycle,
        Arc::new(move || {
            checks_for_hook.fetch_add(1, Ordering::SeqCst);
            assert!(
                inner.state.try_lock().is_ok(),
                "subagent callback outcome must be recorded after releasing service state"
            );
        }),
    );
    checks
}

fn assert_recorded_callback(
    service: &Service,
    subagent_id: &str,
    callback_id: &str,
    status: SubagentCallbackStatus,
) {
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(subagent_id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.callback_count, 1);
    let callback = snapshot
        .callbacks
        .last()
        .expect("callback summary should be recorded");
    assert_eq!(callback.callback_id, callback_id);
    assert_eq!(callback.status, status);
}

fn assert_subagent_not_reactivated_after_cancel(
    service: &Service,
    before_seq: u64,
    subagent_id: &str,
    stale_event_type: &str,
) {
    let events = service.events_after(before_seq);
    let cancel_index = events
        .iter()
        .position(|event| {
            event.event_type == "subagent.cancelled"
                && event.data["subagent_id"] == json!(subagent_id)
        })
        .unwrap_or_else(|| panic!("subagent.cancelled should be emitted: {events:?}"));
    assert!(
        !events.iter().skip(cancel_index + 1).any(|event| {
            event.event_type == stale_event_type && event.data["subagent_id"] == json!(subagent_id)
        }),
        "stale {stale_event_type} must not be appended after cancellation: {events:?}"
    );

    let state = service.timeline_bootstrap_snapshot();
    let active_items = state["active_items"]
        .as_array()
        .expect("active_items should be an array");
    let item_id = format!("subagent_{subagent_id}");
    assert!(
        !active_items.iter().any(|item| item["id"] == json!(item_id)),
        "cancelled subagent must not be active after stale event window: {active_items:?}"
    );
}
