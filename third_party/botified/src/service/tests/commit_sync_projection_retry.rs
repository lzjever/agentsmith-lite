fn controlled_commit_service(writer: ControlledSessionFile) -> Service {
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("controlled-session.jsonl"),
        writer,
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("controlled-commit"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay::default(),
        Some(recorder),
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    service
        .inner
        .state
        .lock()
        .unwrap()
        .input_queue
        .enqueue(input_queue_test_message(
            "commit_race_input",
            InputUrgency::Normal,
            InputSource::User,
        ));
    service
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_accepted_sync_does_not_block_status_or_shutdown_cancellation() {
    let writer = ControlledSessionFile::default();
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("controlled-session-accepted.jsonl"),
        writer.clone(),
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("controlled-session-accepted"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay::default(),
        Some(recorder),
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    writer.reset_sync();
    writer.set_block_sync(true);
    let active_cancel = CancellationToken::new();
    {
        let mut state = service.inner.state.lock().unwrap();
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_active".to_owned());
        state.active_cancel = Some(active_cancel.clone());
    }

    let enqueue_service = service.clone();
    let enqueue = tokio::spawn(async move {
        enqueue_service
            .enqueue(
                "accepted_during_shutdown",
                vec![ContentPart::text("durable shutdown window")],
            )
            .await
    });
    tokio::task::block_in_place(|| writer.wait_for_sync());

    let status_service = service.clone();
    let (status_tx, status_rx) = std::sync::mpsc::sync_channel(1);
    let status_thread = std::thread::spawn(move || {
        status_tx.send(status_service.status()).unwrap();
    });
    let status_was_timely =
        tokio::task::block_in_place(|| status_rx.recv_timeout(Duration::from_millis(250)));
    tokio::task::block_in_place(|| std::thread::sleep(Duration::from_millis(50)));
    let ack_was_blocked = !enqueue.is_finished();

    let shutdown_service = service.clone();
    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::sync_channel(1);
    let shutdown_thread = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("shutdown test runtime should build");
        shutdown_tx
            .send(runtime.block_on(shutdown_service.shutdown()))
            .unwrap();
    });
    let shutdown_status_service = service.clone();
    let (shutdown_status_tx, shutdown_status_rx) = std::sync::mpsc::sync_channel(1);
    let shutdown_status_thread = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_millis(250);
        loop {
            let status = shutdown_status_service.status();
            if status.state == ServiceState::ShuttingDown || std::time::Instant::now() >= deadline {
                shutdown_status_tx.send(status).unwrap();
                break;
            }
            std::thread::yield_now();
        }
    });
    let shutdown_became_visible =
        tokio::task::block_in_place(|| shutdown_status_rx.recv_timeout(Duration::from_millis(250)));
    tokio::task::block_in_place(|| std::thread::sleep(Duration::from_millis(50)));
    let ack_still_blocked = !enqueue.is_finished();
    let shutdown_waited_for_persistence = shutdown_rx.try_recv().is_err();

    writer.set_block_sync(false);
    let outcome = tokio::time::timeout(Duration::from_secs(2), enqueue)
        .await
        .expect("enqueue should finish after accepted-input sync")
        .expect("enqueue task should not panic")
        .expect("reserved accepted input should finalize");
    tokio::task::block_in_place(|| {
        shutdown_rx
            .recv_timeout(SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT)
            .expect("shutdown should finish after reservation finalizes")
    });
    status_thread
        .join()
        .expect("status thread should not panic");
    shutdown_status_thread
        .join()
        .expect("shutdown status thread should not panic");
    shutdown_thread
        .join()
        .expect("shutdown thread should not panic");

    assert!(
        status_was_timely.is_ok(),
        "status should not wait for accepted-input sync"
    );
    assert!(
        ack_was_blocked,
        "enqueue must not acknowledge before accepted input is durable"
    );
    assert!(
        active_cancel.is_cancelled()
            && shutdown_became_visible
                .is_ok_and(|status| status.state == ServiceState::ShuttingDown),
        "shutdown should cancel and become visible during accepted-input sync"
    );
    assert!(
        ack_still_blocked,
        "durable enqueue acknowledgement must remain blocked"
    );
    assert!(
        shutdown_waited_for_persistence,
        "shutdown must wait for accepted-input persistence"
    );
    assert_eq!(outcome.submit_status, EnqueueSubmitStatus::Queued);
    assert_eq!(service.status().queue_length, 1);

    let accepted = writer
        .contents()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("session line should be JSON"))
        .find(|line| {
            line["type"] == "accepted_input" && line["message_id"] == "accepted_during_shutdown"
        })
        .expect("durable accepted input should remain replayable");
    let replayed = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("controlled-session-recovered"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay {
            pending_messages: vec![DrainedMessage::new(
                accepted["message_id"].as_str().unwrap(),
                vec![ContentPart::text("durable shutdown window")],
            )],
            ..SessionReplay::default()
        },
        None,
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("durable accepted input should recover");
    assert_eq!(replayed.status().queue_length, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn task_session_sync_does_not_block_shutdown_visibility() {
    let writer = ControlledSessionFile::default();
    writer.set_block_sync(true);
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("controlled-task-session-accepted.jsonl"),
        writer.clone(),
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("controlled-task-session-accepted"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay::default(),
        Some(recorder),
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let active_cancel = CancellationToken::new();
    {
        let mut state = service.inner.state.lock().unwrap();
        state.state = ServiceState::Running;
        state.active_turn_id = Some("turn_active".to_owned());
        state.active_cancel = Some(active_cancel.clone());
    }
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new("call_task_sync", "bash", "{}"));

    let enqueue_inner = service.inner.clone();
    let task_id = task.task_id.clone();
    let enqueue = tokio::spawn(async move {
        enqueue_task_input_inner(
            &enqueue_inner,
            &task_id,
            "task_sync_shutdown".to_owned(),
            vec![ContentPart::text("task durable shutdown window")],
            InputSource::TaskTell,
            InputUrgency::Normal,
            Some(QueuedInputMetadata::TaskTell {
                task_id: task_id.clone(),
                tell_id: "tell_task_sync_shutdown".to_owned(),
            }),
            || Ok(()),
        )
        .await
    });
    tokio::task::block_in_place(|| writer.wait_for_sync());

    let shutdown_service = service.clone();
    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::sync_channel(1);
    let shutdown_thread = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("shutdown test runtime should build");
        shutdown_tx
            .send(runtime.block_on(shutdown_service.shutdown()))
            .unwrap();
    });
    let visible = tokio::time::timeout(Duration::from_millis(250), async {
        loop {
            if active_cancel.is_cancelled() && service.status().state == ServiceState::ShuttingDown
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    let shutdown_waited = shutdown_rx.try_recv().is_err();

    writer.set_block_sync(false);
    service.inner.background_tasks.finish_task(
        &task.task_id,
        TaskState::Cancelled,
        "test task stopped during shutdown",
    );
    let attempt = tokio::time::timeout(Duration::from_secs(2), enqueue)
        .await
        .expect("task enqueue should finish after sync release")
        .expect("task enqueue should not panic");
    tokio::task::block_in_place(|| {
        shutdown_rx
            .recv_timeout(SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT)
            .expect("shutdown should finish after task persistence")
    });
    shutdown_thread.join().expect("shutdown thread should join");

    assert!(
        visible,
        "shutdown cancellation and state must not wait for task sync"
    );
    assert!(shutdown_waited, "shutdown must wait for task persistence");
    assert!(attempt.outcome.is_err());
    assert_eq!(service.status().state, ServiceState::ShuttingDown);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_failed_finalize_only_recovers_user_input() {
    for (source, metadata, should_recover) in [
        (InputSource::User, None, true),
        (
            InputSource::SubagentCallback,
            Some(QueuedInputMetadata::SubagentCallback {
                subagent_id: "sub_failed_finalize".to_owned(),
                kind: "task_completed".to_owned(),
                task_id: None,
                ask_id: None,
                tell_id: None,
                task_message: None,
                label: None,
                summary: None,
            }),
            false,
        ),
    ] {
        let writer = ControlledSessionFile::default();
        writer.set_block_sync(true);
        let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
            PathBuf::from("controlled-failed-finalize.jsonl"),
            writer.clone(),
        ));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("controlled-failed-finalize"),
            Arc::new(PanicProvider),
            Vec::new(),
            SessionReplay::default(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        )
        .expect("service construction should succeed");

        let inner = service.inner.clone();
        let enqueue = tokio::spawn(async move {
            let _intake = inner.intake_gate.lock().await;
            persist_prepared_enqueue(
                &inner,
                AcceptedInputEntry {
                    message_id: format!("failed_finalize_{source:?}"),
                    content: vec![ContentPart::text("concurrent failed finalize")],
                    cursor_seq: inner.last_event_seq(),
                    source,
                    metadata,
                    urgency: InputUrgency::Normal,
                },
            )
            .await
        });
        tokio::task::block_in_place(|| writer.wait_for_sync());
        {
            let mut state = service.inner.state.lock().unwrap();
            state.state = ServiceState::Failed;
            state.last_error = Some("concurrent failure".to_owned());
        }
        writer.set_block_sync(false);
        let attempt = enqueue.await.expect("enqueue should not panic");

        assert_eq!(attempt.outcome.is_ok(), should_recover, "{source:?}");
        assert_eq!(
            service.status().state,
            if should_recover {
                ServiceState::Running
            } else {
                ServiceState::Failed
            },
            "{source:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_waits_for_durable_complete_commit_and_commit_wins() {
    let writer = ControlledSessionFile::default();
    writer.set_block_sync(true);
    let service = controlled_commit_service(writer.clone());
    let batch = service.begin_drain(CancellationToken::new()).await;
    let commit = service.commit(&batch.id).await.unwrap();
    let committing = {
        let inner = service.inner.clone();
        let batch_id = batch.id.clone();
        tokio::spawn(async move { inner.complete_commit(&batch_id, &commit, None).await })
    };
    tokio::task::block_in_place(|| writer.wait_for_sync());
    let rolling_back = {
        let inner = service.inner.clone();
        let batch_id = batch.id.clone();
        tokio::spawn(async move { inner.rollback(&batch_id).await })
    };
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(
        !rolling_back.is_finished(),
        "rollback crossed the durable commit gate"
    );
    writer.set_block_sync(false);
    committing.await.unwrap().unwrap();
    rolling_back.await.unwrap();
    assert_eq!(service.status().queue_length, 0);
    assert!(writer.contents().contains("commit_race_input"));
    assert!(service
        .begin_drain(CancellationToken::new())
        .await
        .messages
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_durable_complete_commit_releases_gate_for_rollback() {
    let writer = ControlledSessionFile::default();
    writer.set_block_sync(true);
    writer.set_fail_sync(true);
    let service = controlled_commit_service(writer.clone());
    let batch = service.begin_drain(CancellationToken::new()).await;
    let commit = service.commit(&batch.id).await.unwrap();
    let committing = {
        let inner = service.inner.clone();
        let batch_id = batch.id.clone();
        tokio::spawn(async move { inner.complete_commit(&batch_id, &commit, None).await })
    };
    tokio::task::block_in_place(|| writer.wait_for_sync());
    let rolling_back = {
        let inner = service.inner.clone();
        let batch_id = batch.id.clone();
        tokio::spawn(async move { inner.rollback(&batch_id).await })
    };
    writer.set_block_sync(false);
    assert!(committing.await.unwrap().is_err());
    tokio::time::timeout(Duration::from_secs(1), rolling_back)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(service.status().queue_length, 1);
    let retry = service.begin_drain(CancellationToken::new()).await;
    assert_eq!(retry.messages.len(), 1);
    assert_eq!(retry.messages[0].id, "commit_race_input");
}

fn projection_intent(id: &str) -> CallbackDeliveryIntent {
    CallbackDeliveryIntent {
        projection_id: CallbackDeliveryIntent::projection_id_for_input(id),
        event_type: CallbackDeliveryEventType::TaskDelivered,
        data: json!({"callback_input_id": id}),
    }
}

fn controlled_projection_service(
    name: &str,
    writer: ControlledSessionFile,
    intents: Vec<CallbackDeliveryIntent>,
    data_dir: PathBuf,
) -> Service {
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        data_dir.join("session.jsonl"),
        writer,
    ));
    let mut config = AgentConfig::new("system").with_session(name);
    config.task_output.data_dir = data_dir;
    let mut init = ServiceInit::new(config, Arc::new(PanicProvider), Vec::new());
    init.session_recorder = Some(recorder.clone());
    init.recorder = Some(recorder);
    init.pending_delivery_intents = intents;
    Service::from_init(init).expect("service construction should succeed")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_waits_for_blocked_callback_projection_retry_attempt() {
    let writer = ControlledSessionFile::default();
    writer.set_block_sync(true);
    let service = controlled_projection_service(
        "blocked-projection-retry-shutdown",
        writer.clone(),
        vec![projection_intent("blocked_projection_retry")],
        service_test_home("blocked-projection-retry-shutdown"),
    );

    let waiting_writer = writer.clone();
    tokio::task::spawn_blocking(move || waiting_writer.wait_for_sync())
        .await
        .expect("projection retry wait should not panic");
    let active_workers_during_io = service.inner.active_service_worker_count();

    let shutdown_service = service.clone();
    let mut shutdown = tokio::spawn(async move { shutdown_service.shutdown().await });
    let shutdown_while_io_blocked =
        tokio::time::timeout(Duration::from_millis(250), &mut shutdown).await;

    writer.set_block_sync(false);
    if !shutdown.is_finished() {
        tokio::time::timeout(SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT, shutdown)
            .await
            .expect("shutdown should finish after projection I/O returns")
            .expect("shutdown should not panic");
    }

    assert_eq!(active_workers_during_io, 1);
    assert!(
        shutdown_while_io_blocked.is_err(),
        "shutdown should wait for the in-flight projection retry"
    );
    assert_eq!(service.inner.active_service_worker_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn callback_projection_releases_pending_queue_lock_during_blocked_io() {
    let service = Service::new(
        AgentConfig::new("system").with_session("projection-queue-lock"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let timeline = service.inner.timeline_store.clone();
    let blocker = std::thread::spawn(move || {
        let _timeline_guard = timeline.lock().unwrap();
        locked_tx.send(()).unwrap();
        release_rx.recv().unwrap();
    });
    locked_rx.recv().unwrap();
    service
        .inner
        .track_callback_delivery_intents(&[projection_intent("a")]);
    let projecting = {
        let inner = service.inner.clone();
        tokio::spawn(async move { inner.try_project_pending_service_projections().await })
    };
    tokio::time::sleep(Duration::from_millis(25)).await;
    let tracking = {
        let inner = service.inner.clone();
        tokio::spawn(async move {
            inner.track_callback_delivery_intents(&[projection_intent("b")]);
        })
    };
    tokio::time::timeout(Duration::from_secs(1), tracking)
        .await
        .expect("tracking B blocked on the pending queue mutex")
        .unwrap();
    release_tx.send(()).unwrap();
    blocker.join().unwrap();
    projecting.await.unwrap();
}

#[test]
fn repeated_callback_ack_failure_appends_one_raw_timeline_event() {
    let writer = ControlledSessionFile::default();
    writer.set_fail_sync(true);
    let intent = projection_intent("ack_failure_a");
    let service = controlled_projection_service(
        "repeated-ack-failure",
        writer,
        vec![intent.clone()],
        service_test_home("repeated-ack-failure"),
    );
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        service
            .inner
            .try_project_pending_service_projections()
            .await;
        service
            .inner
            .try_project_pending_service_projections()
            .await;
    });
    assert_eq!(
        service
            .events_after(0)
            .iter()
            .filter(|event| event.data["projection_id"] == intent.projection_id)
            .count(),
        1
    );
}

#[test]
fn callback_ack_failure_does_not_starve_later_projection_and_both_recover() {
    let writer = ControlledSessionFile::default();
    writer.set_fail_sync(true);
    let a = projection_intent("starvation_a");
    let b = projection_intent("starvation_b");
    let service = controlled_projection_service(
        "ack-failure-no-starvation",
        writer.clone(),
        vec![a.clone(), b.clone()],
        service_test_home("ack-failure-no-starvation"),
    );
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(service.inner.try_project_pending_service_projections());
    assert_eq!(
        service
            .events_after(0)
            .iter()
            .filter(|event| {
                event.data["projection_id"] == a.projection_id
                    || event.data["projection_id"] == b.projection_id
            })
            .count(),
        2
    );
    writer.set_fail_sync(false);
    runtime.block_on(service.inner.try_project_pending_service_projections());
    assert!(service
        .inner
        .pending_delivery_intents
        .lock()
        .unwrap()
        .is_empty());
    assert_eq!(writer.contents().matches("delivery_projected").count(), 2);
}

#[test]
fn callback_projection_restart_after_append_before_ack_has_no_duplicate() {
    let data_dir = service_test_home("projection-restart-idempotency");
    let intent = projection_intent("restart_between_append_and_ack");
    let failing = ControlledSessionFile::default();
    failing.set_fail_sync(true);
    let first = controlled_projection_service(
        "projection-restart",
        failing,
        vec![intent.clone()],
        data_dir.clone(),
    );
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(first.inner.try_project_pending_service_projections());
    drop(first);

    let recovered_writer = ControlledSessionFile::default();
    let recovered = controlled_projection_service(
        "projection-restart",
        recovered_writer.clone(),
        vec![intent.clone()],
        data_dir,
    );
    runtime.block_on(recovered.inner.try_project_pending_service_projections());
    assert!(recovered
        .inner
        .pending_delivery_intents
        .lock()
        .unwrap()
        .is_empty());
    let timeline = recovered
        .inner
        .timeline_store
        .lock()
        .unwrap()
        .tail(100)
        .unwrap();
    assert_eq!(
        timeline
            .events
            .iter()
            .filter(|event| event.data["projection_id"] == intent.projection_id)
            .count(),
        1
    );
    assert_eq!(
        recovered_writer
            .contents()
            .matches("delivery_projected")
            .count(),
        1
    );
}

#[test]
fn service_constructed_outside_tokio_starts_callback_retry_worker_on_start() {
    let writer = ControlledSessionFile::default();
    let intent = projection_intent("outside_runtime");
    let service = controlled_projection_service(
        "outside-runtime-retry",
        writer.clone(),
        vec![intent.clone()],
        service_test_home("outside-runtime-retry"),
    );
    assert!(!service
        .inner
        .service_projection_worker_started
        .load(Ordering::Acquire));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        service.start_pending_if_needed().await;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if service
                    .inner
                    .pending_delivery_intents
                    .lock()
                    .unwrap()
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    });
    assert!(service
        .inner
        .service_projection_worker_started
        .load(Ordering::Acquire));
    assert_eq!(
        service
            .events_after(0)
            .iter()
            .filter(|event| event.data["projection_id"] == intent.projection_id)
            .count(),
        1
    );
    assert_eq!(writer.contents().matches("delivery_projected").count(), 1);
}

#[tokio::test]
async fn callback_user_batch_write_failure_keeps_callback_and_intent_pending() {
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        FailingSyncSessionFile,
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay::default(),
        Some(recorder),
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let task = service
        .inner
        .background_tasks
        .start_task(NewBackgroundTask::new(
            "call_batch_failure",
            "bash",
            "batch failure",
        ));
    let callback_id = "task_callback_batch_failure";
    complete_task_callback_fixture(&service, &task.task_id);
    service
        .inner
        .background_tasks
        .set_callback_pending(
            &task.task_id,
            callback_id,
            vec![ContentPart::text("callback")],
        )
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
            content: vec![ContentPart::text("callback")],
            source: InputSource::TaskCallback,
            urgency: InputUrgency::Normal,
            metadata: Some(test_task_callback_metadata(&task.task_id)),
            cursor_seq: 0,
            delivery: None,
        });
    }
    let batch = service.begin_drain(CancellationToken::new()).await;
    let commit = service
        .commit(&batch.id)
        .await
        .expect("commit should prepare");
    let error = service
        .complete_commit(&batch.id, &commit, None)
        .await
        .expect_err("durable batch write should fail");
    assert!(error.to_string().contains("sync_data failed"));
    assert_eq!(service.status().queue_length, 1);
    assert_eq!(
        service
            .inner
            .background_tasks
            .get(&task.task_id)
            .unwrap()
            .callback_delivery,
        CallbackDelivery::Enqueued
    );
    assert!(service
        .events_after(0)
        .iter()
        .all(|event| event.event_type != "task.callback_delivered"));
    assert!(service
        .inner
        .pending_delivery_intents
        .lock()
        .expect("pending delivery intents mutex poisoned")
        .is_empty());
}

#[tokio::test]
async fn subagent_callback_delivered_append_failure_does_not_requeue_committed_input() {
    let service = Service::new(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent = open_test_subagent(&service, "worker");
    let callback_id = "subagent_callback_delivery_append_fails";
    {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        manager
            .record_callback(
                &subagent.id,
                callback_id,
                "completed",
                SubagentCallbackStatus::Pending,
                None,
            )
            .expect("subagent callback should be pending");
    }

    let callback_content = vec![ContentPart::text("<subagent_callback />")];
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
            source: InputSource::SubagentCallback,
            urgency: InputUrgency::Normal,
            metadata: Some(QueuedInputMetadata::SubagentCallback {
                subagent_id: subagent.id.clone(),
                kind: "completed".to_owned(),
                task_id: None,
                ask_id: None,
                tell_id: None,
                task_message: None,
                label: Some(subagent.name.clone()),
                summary: Some(subagent.purpose.clone()),
            }),
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
        .complete_commit(&batch.id, &commit, Some("cyc_subagent_delivery"))
        .await
        .expect("durable commit should survive projection failure");
    assert_eq!(service.status().queue_length, 0);
    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent.id)
        .expect("subagent should remain");
    assert_eq!(snapshot.pending_callback_count, 0);
    assert_eq!(
        snapshot
            .callbacks
            .last()
            .expect("callback should remain")
            .status,
        SubagentCallbackStatus::Delivered
    );
    assert!(!service
        .events_after(0)
        .iter()
        .any(|event| event.event_type == "subagent.callback_delivered"));

    let delivered = service
        .events_after(0)
        .into_iter()
        .filter(|event| event.event_type == "subagent.callback_delivered")
        .collect::<Vec<_>>();
    assert!(delivered.is_empty());
}
