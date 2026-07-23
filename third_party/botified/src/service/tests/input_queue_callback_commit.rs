#[test]
fn input_queue_state_urgent_first_pending_freeze_and_rollback() {
    let mut queue = InputQueueState::new(VecDeque::new());
    queue.enqueue(input_queue_test_message(
        "normal_1",
        InputUrgency::Normal,
        InputSource::User,
    ));
    queue.enqueue(input_queue_test_message(
        "urgent_1",
        InputUrgency::Urgent,
        InputSource::User,
    ));
    queue.enqueue(input_queue_test_message(
        "normal_2",
        InputUrgency::Normal,
        InputSource::User,
    ));
    queue.enqueue(input_queue_test_message(
        "urgent_2",
        InputUrgency::Urgent,
        InputSource::User,
    ));

    let first = queue.begin_drain();
    assert_eq!(
        input_queue_batch_ids(&first),
        vec!["urgent_1", "urgent_2", "normal_1", "normal_2"]
    );
    queue.enqueue(input_queue_test_message(
        "urgent_late",
        InputUrgency::Urgent,
        InputSource::User,
    ));
    let frozen = queue.begin_drain();
    assert_eq!(frozen.id, first.id);
    assert_eq!(
        input_queue_batch_ids(&frozen),
        vec!["urgent_1", "urgent_2", "normal_1", "normal_2"]
    );

    queue.rollback(&first.id);
    let after_rollback = queue.begin_drain();
    assert_eq!(
        input_queue_batch_ids(&after_rollback),
        vec![
            "urgent_1",
            "urgent_2",
            "urgent_late",
            "normal_1",
            "normal_2"
        ]
    );
}

#[test]
fn input_queue_state_commit_removes_selected_and_preserves_late_input() {
    let mut queue = InputQueueState::new(VecDeque::new());
    queue.enqueue(input_queue_test_message(
        "normal_1",
        InputUrgency::Normal,
        InputSource::User,
    ));
    queue.enqueue(input_queue_test_message(
        "urgent_1",
        InputUrgency::Urgent,
        InputSource::User,
    ));
    queue.enqueue(input_queue_test_message(
        "normal_2",
        InputUrgency::Normal,
        InputSource::User,
    ));
    let batch = queue.begin_drain();
    queue.enqueue(input_queue_test_message(
        "urgent_late",
        InputUrgency::Urgent,
        InputSource::User,
    ));

    let plan = queue
        .prepare_commit(&batch.id)
        .expect("pending batch should prepare");
    let result = queue
        .finish_commit(&plan)
        .expect("pending batch should finish");

    assert_eq!(result.queue_length, 1);
    assert_eq!(result.callback_delivery_input_ids, Vec::<String>::new());
    assert_eq!(
        queue
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["urgent_late"]
    );
}

#[test]
fn input_queue_state_commit_reports_callback_delivery_ids() {
    let mut queue = InputQueueState::new(VecDeque::new());
    queue.enqueue(input_queue_test_message(
        "callback_1",
        InputUrgency::Normal,
        InputSource::TaskCallback,
    ));
    queue.enqueue(input_queue_test_message(
        "user_1",
        InputUrgency::Normal,
        InputSource::User,
    ));
    queue.enqueue(input_queue_test_message(
        "callback_2",
        InputUrgency::Normal,
        InputSource::TaskCallback,
    ));
    let batch = queue.begin_drain();
    let plan = queue
        .prepare_commit(&batch.id)
        .expect("pending batch should prepare");
    let result = queue
        .finish_commit(&plan)
        .expect("pending batch should finish");

    assert_eq!(
        result.callback_delivery_input_ids,
        vec!["callback_1", "callback_2"]
    );
    assert_eq!(result.queue_length, 0);
}

#[tokio::test]
async fn callback_delivered_append_failure_does_not_requeue_committed_input() {
    let home = service_test_home("task-delivery-projection-recovery");
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
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_delivery", "bash", "{}"));
    let callback_id = "task_callback_delivery_append_fails";
    let callback_content = vec![ContentPart::text("<task_callback />")];
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

    let cursor = service.current_event_cursor();
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
            cursor_seq: cursor.seq(),
            delivery: None,
        });
        insert_message_index_entry(
            &mut state.message_index,
            callback_id.to_owned(),
            callback_content,
            cursor,
        );
    }

    let batch = service.begin_drain(CancellationToken::new()).await;
    let commit = service
        .commit(&batch.id)
        .await
        .expect("commit should prepare callback delivery");
    assert_eq!(
        commit.callback_delivery_input_ids,
        vec![callback_id.to_owned()]
    );

    service.inject_timeline_write_failure_after_events(0, TimelineWriteFailure::Flush);
    service
        .complete_commit(&batch.id, &commit, Some("cyc_delivery"))
        .await
        .expect("durable commit should survive projection failure");
    assert_eq!(service.status().queue_length, 0);
    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task should remain")
            .callback_delivery,
        CallbackDelivery::Delivered
    );
    assert!(!service
        .events_after(0)
        .iter()
        .any(|event| event.event_type == "task.callback_delivered"));

    let delivered = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(event) = service
                .events_after(0)
                .into_iter()
                .find(|event| event.event_type == "task.callback_delivered")
            {
                break event;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("idle service should retry callback projection");
    assert_eq!(delivered.data["callback_input_id"], json!(callback_id));
    assert_eq!(
        delivered.data["projection_id"],
        json!(CallbackDeliveryIntent::projection_id_for_input(callback_id))
    );
    tokio::time::sleep(CALLBACK_DELIVERY_RETRY_MAX_BACKOFF).await;
    assert_eq!(
        service
            .events_after(0)
            .iter()
            .filter(|event| event.event_type == "task.callback_delivered")
            .count(),
        1,
        "acked intent must not retry again in the same process"
    );
    let acked = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("acked session should reopen");
    assert!(acked.pending_messages().is_empty());
    assert!(acked.pending_delivery_intents().is_empty());
}

#[tokio::test]
async fn partial_callback_projection_acks_only_successes_and_restart_recovers_remaining() {
    let home = service_test_home("partial-delivery-projection-recovery");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let intents = [
        CallbackDeliveryIntent {
            projection_id: CallbackDeliveryIntent::projection_id_for_input("task_one"),
            event_type: CallbackDeliveryEventType::TaskDelivered,
            data: json!({"callback_input_id": "task_one", "payload": "task payload"}),
        },
        CallbackDeliveryIntent {
            projection_id: CallbackDeliveryIntent::projection_id_for_input("subagent_two"),
            event_type: CallbackDeliveryEventType::SubagentDelivered,
            data: json!({"callback_id": "subagent_two", "payload": "subagent payload"}),
        },
    ];
    session
        .recorder()
        .record_user_batch_with_ids_and_delivery_intents_sync(
            &[
                Message::user(vec![ContentPart::text("one")]),
                Message::user(vec![ContentPart::text("two")]),
            ],
            &["task_one".to_owned(), "subagent_two".to_owned()],
            &intents,
        )
        .expect("intent batch should persist");

    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay::default(),
        Some(session.recorder()),
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    service.inject_timeline_write_failure_after_events(1, TimelineWriteFailure::Flush);
    assert!(service
        .inner
        .project_callback_delivery_intent_once(&intents[0])
        .is_ok());
    assert!(service
        .inner
        .project_callback_delivery_intent_once(&intents[1])
        .is_err());

    drop(service);
    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("partially projected session should reopen");
    assert_eq!(reopened.pending_delivery_intents(), &intents[1..]);
    let recovered = Service::with_session_replay_and_limits_and_file_store_and_registry_store_and_subagent_options_and_runtime_selection(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            reopened.replay(),
            Some(reopened.recorder()),
            reopened.warnings().to_vec(),
            ServiceLimits::default(),
            FileStore::open(FileStoreOptions::new(home.join("files")))
                .expect("file store should open"),
            None,
            ServiceSubagentOptions::default(),
            None,
            DEFAULT_TIMELINE_RETENTION_DAYS,
        ).expect("service construction should succeed");
    let projected = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(event) = recovered
                .events_after(0)
                .into_iter()
                .find(|event| event.event_type == "subagent.callback_delivered")
            {
                break event;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("remaining intent should project on restart");
    assert_eq!(projected.data["payload"], json!("subagent payload"));
    assert_eq!(
        projected.data["projection_id"],
        json!(intents[1].projection_id)
    );
    let public = crate::timeline::project_timeline_event(
        &projected,
        recovered
            .current_event_cursor()
            .instance()
            .expect("timeline cursor should include instance"),
    )
    .expect("subagent delivery should project publicly");
    assert_eq!(
        public.data["projection_id"],
        json!(intents[1].projection_id),
        "public retries and restart recovery must retain the durable projection id"
    );
}

#[test]
fn post_commit_status_failure_retries_latest_snapshot_without_requeue() {
    let home = service_test_home("post-commit-status-retry-latest");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let session_path = opened.path().to_path_buf();
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        opened.replay(),
        Some(opened.recorder()),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let runtime = tokio::runtime::Runtime::new().expect("runtime should start");
    runtime.block_on(async {
        let first_content = vec![ContentPart::text("first")];
        let cursor = service.current_event_cursor();
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.input_queue.enqueue(QueuedMessage {
                id: "status_first".to_owned(),
                content: first_content.clone(),
                source: InputSource::User,
                urgency: InputUrgency::Normal,
                metadata: None,
                cursor_seq: cursor.seq(),
                delivery: None,
            });
            insert_message_index_entry(
                &mut state.message_index,
                "status_first".to_owned(),
                first_content,
                cursor,
            );
        }
        let batch = service.begin_drain(CancellationToken::new()).await;
        let second_content = vec![ContentPart::text("second")];
        let cursor = service.current_event_cursor();
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.input_queue.enqueue(QueuedMessage {
                id: "status_second".to_owned(),
                content: second_content.clone(),
                source: InputSource::User,
                urgency: InputUrgency::Normal,
                metadata: None,
                cursor_seq: cursor.seq(),
                delivery: None,
            });
            insert_message_index_entry(
                &mut state.message_index,
                "status_second".to_owned(),
                second_content,
                cursor,
            );
        }
        let commit = service
            .commit(&batch.id)
            .await
            .expect("commit should prepare");
        service.inject_timeline_write_failure_after_events(0, TimelineWriteFailure::Flush);
        service
            .complete_commit(&batch.id, &commit, None)
            .await
            .expect("durable commit must survive status projection failure");

        assert_eq!(service.status().queue_length, 1);
        service
            .inner
            .try_project_pending_service_projections()
            .await;
    });

    let statuses = service
        .events_after(0)
        .into_iter()
        .filter(|event| event.event_type == "service.status")
        .collect::<Vec<_>>();
    assert_eq!(
        statuses.last().expect("retry should heal status").data["queue_length"],
        json!(1)
    );
    let records = session_body_records(&fs::read(session_path).expect("session should read"));
    assert_eq!(
        records
            .iter()
            .filter(|record| {
                record["type"] == "user_message" && record["message_id"] == "status_first"
            })
            .count(),
        1
    );
}

#[test]
fn newer_normal_status_publish_clears_older_failed_generation_without_retry() {
    let service = Service::new(
        AgentConfig::new("system"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    service.inject_timeline_write_failure_after_events(0, TimelineWriteFailure::Flush);
    service.inner.append_post_commit_service_status(None);
    assert_ne!(
        service
            .inner
            .dirty_service_status_generation
            .load(Ordering::Acquire),
        0
    );

    assert!(service
        .inner
        .append_service_status_for_current_state(None)
        .is_some());
    assert_eq!(
        service
            .inner
            .dirty_service_status_generation
            .load(Ordering::Acquire),
        0
    );
    service.inner.try_project_dirty_service_status_once();

    assert_eq!(
        service
            .events_after(0)
            .iter()
            .filter(|event| event.event_type == "service.status")
            .count(),
        1,
        "the successful normal publish must satisfy the older failed generation"
    );
}

#[test]
fn service_status_generation_races_leave_only_unpublished_generations_dirty() {
    let service = Service::new(
        AgentConfig::new("system"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let inner = service.inner.clone();

    std::thread::scope(|scope| {
        scope.spawn(|| inner.mark_service_status_published(2));
        scope.spawn(|| inner.mark_service_status_dirty(1));
    });
    assert_eq!(
        inner
            .dirty_service_status_generation
            .load(Ordering::Acquire),
        0,
        "an older failure racing a newer publish must stay clean"
    );

    inner.mark_service_status_dirty(3);
    std::thread::scope(|scope| {
        scope.spawn(|| inner.mark_service_status_published(4));
        scope.spawn(|| inner.mark_service_status_dirty(3));
    });
    assert_eq!(
        inner
            .dirty_service_status_generation
            .load(Ordering::Acquire),
        0,
        "a newer publish must clear an already recorded older failure"
    );

    inner.mark_service_status_dirty(5);
    assert_eq!(
        inner
            .dirty_service_status_generation
            .load(Ordering::Acquire),
        5,
        "a genuinely unpublished generation must remain dirty"
    );
}

#[test]
fn stale_status_append_cannot_publish_newer_failed_snapshot_generation() {
    let service = Service::new(
        AgentConfig::new("system"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let inner = &service.inner;

    let (snapshot_a, generation_a) = {
        let state = inner.state.lock().expect("service state mutex poisoned");
        inner.service_status_data_from_locked(&state)
    };
    let (snapshot_b, generation_b) = {
        let state = inner.state.lock().expect("service state mutex poisoned");
        inner.service_status_data_from_locked(&state)
    };
    assert!(generation_a < generation_b);

    service.inject_timeline_write_failure_after_events(0, TimelineWriteFailure::Flush);
    assert!(inner
        .try_append_event_for_turn(None, "service.status", snapshot_b)
        .is_err());
    inner.mark_service_status_dirty(generation_b);

    inner
        .try_append_event_for_turn(None, "service.status", snapshot_a)
        .expect("stale snapshot A should append after B fails");
    inner.mark_service_status_published(generation_a);

    assert_eq!(
        inner
            .dirty_service_status_generation
            .load(Ordering::Acquire),
        generation_b,
        "stale A must not satisfy failed snapshot B"
    );

    inner.try_project_dirty_service_status_once();
    assert_eq!(
        inner
            .dirty_service_status_generation
            .load(Ordering::Acquire),
        0,
        "B must remain eligible for retry until a newer snapshot publishes"
    );
}

#[test]
fn persistent_post_commit_status_failure_never_duplicates_session_batch() {
    let home = service_test_home("post-commit-status-persistent-failure");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let session_path = opened.path().to_path_buf();
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        opened.replay(),
        Some(opened.recorder()),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let runtime = tokio::runtime::Runtime::new().expect("runtime should start");
    runtime.block_on(async {
        let content = vec![ContentPart::text("once")];
        let cursor = service.current_event_cursor();
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.input_queue.enqueue(QueuedMessage {
                id: "status_persistent".to_owned(),
                content: content.clone(),
                source: InputSource::User,
                urgency: InputUrgency::Normal,
                metadata: None,
                cursor_seq: cursor.seq(),
                delivery: None,
            });
            insert_message_index_entry(
                &mut state.message_index,
                "status_persistent".to_owned(),
                content,
                cursor,
            );
        }
        let batch = service.begin_drain(CancellationToken::new()).await;
        let commit = service
            .commit(&batch.id)
            .await
            .expect("commit should prepare");
        let before_status_failure = service.inner.last_event_seq();
        service.inject_timeline_write_failure_after_events(0, TimelineWriteFailure::Flush);
        service
            .complete_commit(&batch.id, &commit, None)
            .await
            .expect("commit should remain successful");

        for _ in 0..3 {
            service.inject_timeline_write_failure_after_events(0, TimelineWriteFailure::Flush);
            service
                .inner
                .try_project_pending_service_projections()
                .await;
            assert_eq!(service.status().queue_length, 0);
        }
        service
            .inner
            .try_project_pending_service_projections()
            .await;
        assert_eq!(
            service
                .events_after(before_status_failure)
                .iter()
                .filter(|event| event.event_type == "service.status")
                .filter(|event| event.data["queue_length"] == json!(0))
                .count(),
            1,
            "one current status should heal display after persistent failures clear"
        );
    });

    let records = session_body_records(&fs::read(session_path).expect("session should read"));
    assert_eq!(
        records
            .iter()
            .filter(|record| {
                record["type"] == "user_message" && record["message_id"] == "status_persistent"
            })
            .count(),
        1
    );
}

#[tokio::test]
async fn callback_ack_write_failure_retries_with_identical_projection() {
    let home = service_test_home("callback-ack-write-failure");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let intent = CallbackDeliveryIntent {
        projection_id: CallbackDeliveryIntent::projection_id_for_input("task_ack_failure"),
        event_type: CallbackDeliveryEventType::TaskDelivered,
        data: json!({
            "callback_input_id": "task_ack_failure",
            "task_id": "task_ack_failure",
            "status": "completed",
        }),
    };
    opened
        .recorder()
        .record_user_batch_with_ids_and_delivery_intents_sync(
            &[Message::user(vec![ContentPart::text("callback")])],
            &["task_ack_failure".to_owned()],
            std::slice::from_ref(&intent),
        )
        .expect("batch should persist");
    let session_path = opened.path().to_path_buf();
    let writer = FailNextSyncSessionFile::new(fs::read(&session_path).expect("session bytes"));
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        session_path.clone(),
        writer.clone(),
    ));
    let service = Service::with_session_replay_and_limits_and_file_store_and_registry_store_and_subagent_options_and_runtime_selection(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay {
            pending_delivery_intents: vec![intent.clone()],
            ..opened.replay()
        },
        Some(recorder),
        Vec::new(),
        ServiceLimits::default(),
        FileStore::open(FileStoreOptions::new(home.join("files"))).expect("file store"),
        None,
        ServiceSubagentOptions::default(),
        None,
        DEFAULT_TIMELINE_RETENTION_DAYS,
    ).expect("service construction should succeed");

    let projected = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let events = service
                .events_after(0)
                .into_iter()
                .filter(|event| event.event_type == "task.callback_delivered")
                .collect::<Vec<_>>();
            if !events.is_empty()
                && service
                    .inner
                    .pending_delivery_intents
                    .lock()
                    .expect("pending delivery intents mutex poisoned")
                    .is_empty()
            {
                break events;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("online retry should persist the ack");
    assert!(projected.iter().all(|event| {
        event.event_type == projected[0].event_type && event.data == projected[0].data
    }));
    assert_eq!(
        projected.len(),
        1,
        "timeline projection must remain idempotent"
    );
    assert_eq!(
        projected[0].data["projection_id"],
        json!(intent.projection_id)
    );

    fs::write(&session_path, writer.bytes()).expect("persist test writer bytes");
    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should reopen");
    assert!(reopened.pending_delivery_intents().is_empty());
}

#[tokio::test]
async fn pending_task_callback_delivers_from_session_after_service_restart() {
    let home = service_test_home("pending-task-callback-delivery-restart");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let service_a = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        session.replay(),
        Some(session.recorder()),
        session.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    service_a
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .state = ServiceState::Running;
    let host = ServiceBackgroundExecutionHost {
        inner: service_a.inner.clone(),
        owner: TaskOwner::Main,
    };
    let task_id = "task_restart_delivery".to_owned();
    let tool_call = ToolCall::new("call_restart_delivery", "bash", json!({"job": "restart"}));
    assert!(host.publish_task(
        task_id.clone(),
        NewBackgroundTask::new(
            tool_call.id.clone(),
            tool_call.name.clone(),
            "restart callback summary",
        )
        .with_task_label(Some("restart callback label".to_owned())),
    ));
    host.finish_task(
        task_id.clone(),
        tool_call,
        DetachedToolResult {
            tool_result: ToolResult::success(
                "call_restart_delivery",
                "bash",
                "durable task output",
            ),
            state: TaskState::Completed,
        },
    )
    .await;

    let pending = service_a
        .events_after(0)
        .into_iter()
        .find(|event| event.event_type == "task.callback_pending")
        .expect("task callback should have a pending event");
    assert_eq!(pending.data["callback_delivery"], json!("pending"));
    assert!(service_a
        .events_after(pending.seq)
        .iter()
        .any(|event| event.event_type == "task.callback_queued"));
    assert_eq!(service_a.status().queue_length, 1);
    drop(service_a);

    let (drained, pending, delivered) = restart_and_commit_pending_callback(
        &home,
        InputSource::TaskCallback,
        pending,
        "task.callback_delivered",
    )
    .await;
    assert_eq!(delivered["callback_input_id"], json!(drained.id));
    for field in [
        "task_id",
        "tool_call_id",
        "tool_name",
        "state",
        "status",
        "task_label",
        "work_summary",
        "output_tail",
        "output_tail_truncated",
    ] {
        assert_eq!(delivered[field], pending[field], "field {field} changed");
    }
    assert_eq!(delivered["callback_delivery"], json!("delivered"));
    assert_eq!(delivered["cycle_id"], json!("cycle_after_restart"));
}

#[tokio::test]
async fn pending_subagent_callback_delivers_from_session_after_service_restart() {
    let home = service_test_home("pending-subagent-callback-delivery-restart");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let service_a = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        session.replay(),
        Some(session.recorder()),
        session.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    service_a
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .state = ServiceState::Running;
    let snapshot = {
        let mut manager = service_a
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let running = manager
            .spawn("Restart Worker", "durable subagent summary")
            .expect("subagent should spawn");
        manager
            .complete(&running.id, "durable subagent output")
            .expect("subagent should complete")
    };
    enqueue_subagent_callback(service_a.inner.clone(), &snapshot, "completed").await;

    let pending = service_a
        .events_after(0)
        .into_iter()
        .find(|event| {
            event.event_type == "subagent.callback"
                && event.data["callback_status"] == json!("pending")
        })
        .expect("subagent callback should have a pending event");
    assert_eq!(pending.data["callback_status"], json!("pending"));
    assert_eq!(service_a.status().queue_length, 1);
    drop(service_a);

    let (drained, pending, delivered) = restart_and_commit_pending_callback(
        &home,
        InputSource::SubagentCallback,
        pending,
        "subagent.callback_delivered",
    )
    .await;
    assert_eq!(delivered["callback_id"], json!(drained.id));
    for field in [
        "subagent_id",
        "callback_kind",
        "semantic_kind",
        "semantic_status",
        "label",
        "summary",
    ] {
        assert_eq!(delivered[field], pending[field], "field {field} changed");
    }
    assert_eq!(delivered["output"], json!("durable subagent output"));
    assert_eq!(delivered["output"], pending["latest_result"]);
    assert_eq!(delivered["callback_status"], json!("delivered"));
}

#[tokio::test]
async fn complete_commit_recomputes_callback_delivery_from_pending_batch() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_delivery_recomputed",
            "bash",
            "{}",
        ));
    let callback_id = "task_callback_delivery_recomputed";
    let callback_content = vec![ContentPart::text("<task_callback />")];
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

    let cursor = service.current_event_cursor();
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
            cursor_seq: cursor.seq(),
            delivery: None,
        });
        insert_message_index_entry(
            &mut state.message_index,
            callback_id.to_owned(),
            callback_content,
            cursor,
        );
    }

    let batch = service.begin_drain(CancellationToken::new()).await;
    let commit = service
        .commit(&batch.id)
        .await
        .expect("commit should prepare callback delivery");
    assert_eq!(
        commit.callback_delivery_input_ids,
        vec![callback_id.to_owned()]
    );
    let tampered_commit = DrainCommit::new(commit.queue_length);

    service
        .complete_commit(&batch.id, &tampered_commit, Some("cyc_recomputed"))
        .await
        .expect("commit should complete from internal pending-batch state");

    assert_eq!(service.status().queue_length, 0);
    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task should remain")
            .callback_delivery,
        CallbackDelivery::Delivered
    );
    let delivered = service
        .events_after(0)
        .into_iter()
        .filter(|event| event.event_type == "task.callback_delivered")
        .collect::<Vec<_>>();
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].data["callback_input_id"], json!(callback_id));
    assert_eq!(delivered[0].data["cycle_id"], json!("cyc_recomputed"));
}

#[tokio::test]
async fn concurrent_complete_commit_records_one_user_batch() {
    let home = service_test_home("concurrent-complete-commit");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay::default(),
        Some(session.recorder()),
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.input_queue.enqueue(input_queue_test_message(
            "concurrent_user",
            InputUrgency::Normal,
            InputSource::User,
        ));
    }
    let batch = service.begin_drain(CancellationToken::new()).await;
    let commit = service
        .commit(&batch.id)
        .await
        .expect("commit should prepare");
    let first = service.inner.clone();
    let second = service.inner.clone();
    let first_batch = batch.id.clone();
    let second_batch = batch.id.clone();
    let first_commit = commit.clone();
    let second_commit = commit.clone();
    let (first_result, second_result) = tokio::join!(
        async move {
            first
                .complete_commit(&first_batch, &first_commit, None)
                .await
        },
        async move {
            second
                .complete_commit(&second_batch, &second_commit, None)
                .await
        },
    );
    assert_eq!(
        usize::from(first_result.is_ok()) + usize::from(second_result.is_ok()),
        1
    );

    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should reopen");
    assert!(reopened.pending_messages().is_empty());
    assert_eq!(reopened.initial_messages().len(), 1);
    assert_eq!(service.status().queue_length, 0);
}
