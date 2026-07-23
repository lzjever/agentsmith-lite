#[test]
fn input_queue_state_wrong_commit_or_cleared_batch_does_not_modify_queue() {
    let mut queue = InputQueueState::new(VecDeque::new());
    queue.enqueue(input_queue_test_message(
        "msg_1",
        InputUrgency::Normal,
        InputSource::User,
    ));
    let batch = queue.begin_drain();

    let wrong = queue
        .prepare_commit("batch_wrong")
        .expect_err("wrong batch id should fail");
    assert!(wrong.to_string().contains("mismatch"));
    assert_eq!(queue.len(), 1);
    assert!(queue.has_pending_batch());

    let plan = queue
        .prepare_commit(&batch.id)
        .expect("pending batch should prepare");
    queue.rollback(&batch.id);
    let cleared = queue
        .finish_commit(&plan)
        .expect_err("cleared batch should fail");
    assert!(cleared.to_string().contains("cleared"));
    assert_eq!(queue.len(), 1);
    assert!(!queue.has_pending_batch());
}

#[test]
fn input_queue_state_drain_preserves_source_metadata_urgency_and_cursor() {
    let mut queue = InputQueueState::new(VecDeque::new());
    queue.enqueue(input_queue_task_request_message(
        "task_request_1",
        "task_1",
        "request_1",
    ));

    let batch = queue.begin_drain();
    assert_eq!(batch.messages.len(), 1);
    let message = &batch.messages[0];
    assert_eq!(message.id, "task_request_1");
    assert_eq!(message.source, InputSource::TaskRequest);
    assert_eq!(message.urgency, InputUrgency::Urgent);
    assert_eq!(message.cursor_seq, Some(42));
    assert_eq!(
        message.metadata,
        Some(QueuedInputMetadata::TaskRequest {
            task_id: "task_1".to_owned(),
            request_id: "request_1".to_owned(),
        })
    );
}

#[tokio::test]
async fn session_accepted_record_failure_does_not_mutate_enqueue_state() {
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        FailingSyncSessionFile,
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-session-record-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay::default(),
        Some(recorder),
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let before_seq = service.inner.last_event_seq();

    let error = service
        .enqueue(
            "msg_session_record_fails",
            vec![ContentPart::text("not durable")],
        )
        .await
        .expect_err("session accepted write failure should reject enqueue");

    assert!(matches!(error, ServiceError::Persistence { .. }));
    let state = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned");
    assert_eq!(state.state, ServiceState::Idle);
    assert_eq!(state.input_queue.len(), 0);
    assert_eq!(state.next_turn_number, 1);
    assert_eq!(state.active_turn_id, None);
    assert!(state.active_cancel.is_none());
    assert!(!state.message_index.contains_key("msg_session_record_fails"));
    drop(state);

    let failed_events = service.events_after(before_seq);
    assert!(
        failed_events.is_empty(),
        "session accepted failure must not publish ghost timeline events: {failed_events:?}"
    );
}

#[tokio::test]
async fn session_task_accepted_failure_does_not_commit_or_publish() {
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        FailingSyncSessionFile,
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-task-session-record-failure"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay::default(),
        Some(recorder),
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    let task = service.inner.background_tasks.start_task_with_id(
        "durable-failure-task".to_owned(),
        NewBackgroundTask::new("call_durable_failure", "bash", "{}"),
    );
    let bridge_committed = Arc::new(AtomicBool::new(false));
    let committed = bridge_committed.clone();

    let attempt = enqueue_task_input_inner(
        &service.inner,
        &task.task_id,
        "durable-failure-input".to_owned(),
        vec![ContentPart::text("must not commit")],
        InputSource::TaskTell,
        InputUrgency::Normal,
        Some(QueuedInputMetadata::TaskTell {
            task_id: task.task_id.clone(),
            tell_id: "durable-failure-tell".to_owned(),
        }),
        move || {
            committed.store(true, Ordering::SeqCst);
            Ok(())
        },
    )
    .await;

    assert!(attempt.outcome.is_err());
    assert_eq!(service.status().state, ServiceState::Failed);
    assert!(!bridge_committed.load(Ordering::SeqCst));
    assert!(service.events_after(0).iter().all(|event| {
        !matches!(
            event.event_type.as_str(),
            "message.received" | "message.queued"
        )
    }));
}

async fn assert_task_cancel_rollback_failure_outcome(
    case: &str,
    fail_rollback_sync: bool,
    fail_tombstone_sync: bool,
) {
    let home = service_test_home(&format!("task-final-admission-{case}"));
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let session_path = opened.path().to_path_buf();
    let session_header = fs::read(&session_path).expect("session header should read");
    drop(opened);

    let writer = ControlledSessionFile::from_bytes(session_header);
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        session_path.clone(),
        writer.clone(),
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
    let task = service.inner.background_tasks.start_task_with_id(
        "fenced-durable-task".to_owned(),
        NewBackgroundTask::new("call_fenced_durable", "bash", "{}"),
    );
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    service
        .inner
        .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
            if kind != TaskFrameAdmissionKind::TaskInputBeforeFinal {
                return;
            }
            entered_tx
                .send(())
                .expect("final admission test remains active");
            if let Some(receiver) = release_rx.lock().unwrap().take() {
                receiver.recv().expect("final admission should be released");
            }
        })));

    let enqueue_inner = service.inner.clone();
    let task_id = task.task_id.clone();
    let final_commit_called = Arc::new(AtomicBool::new(false));
    let final_commit_called_for_enqueue = final_commit_called.clone();
    let enqueue = tokio::spawn(async move {
        enqueue_task_input_inner(
            &enqueue_inner,
            &task_id,
            "fenced-durable-input".to_owned(),
            vec![ContentPart::text("must not replay after restart")],
            InputSource::TaskTell,
            InputUrgency::Normal,
            Some(QueuedInputMetadata::TaskTell {
                task_id: task_id.clone(),
                tell_id: "fenced-durable-tell".to_owned(),
            }),
            move || {
                final_commit_called_for_enqueue.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
    });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(2)))
        .await
        .expect("final admission waiter should not panic")
        .expect("enqueue should reach the final admission boundary");

    if fail_rollback_sync {
        writer.fail_sync_after(1);
    } else {
        writer.fail_next_set_len();
    }
    if fail_tombstone_sync {
        writer.fail_sync_after(1);
    }
    service
        .cancel_background_task(&task.task_id)
        .expect("task cancellation should win final admission");
    release_tx
        .send(())
        .expect("enqueue should remain paused before final admission");
    let attempt = tokio::time::timeout(Duration::from_secs(2), enqueue)
        .await
        .expect("fenced enqueue should finish")
        .expect("fenced enqueue task should not panic");
    service.inner.set_task_frame_admission_hook_for_test(None);

    assert!(!final_commit_called.load(Ordering::SeqCst));
    if fail_tombstone_sync {
        let error = attempt
            .outcome
            .expect_err("rollback and tombstone failure should reject persistence");
        assert!(matches!(error, ServiceError::Persistence { .. }));
        let error = error.to_string();
        assert!(error.contains("controlled set_len failure"), "{error}");
        assert!(
            error.contains("controlled scheduled sync failure"),
            "{error}"
        );
        assert_eq!(service.status().state, ServiceState::Failed);
        let state = service.inner.state.lock().unwrap();
        assert_eq!(state.input_queue.len(), 0);
        assert!(!state.message_index.contains_key("fenced-durable-input"));
        drop(state);
        assert!(service.events_after(0).iter().all(|event| {
            !matches!(
                event.event_type.as_str(),
                "message.received" | "message.queued"
            )
        }));
        let contents = writer.contents();
        assert!(contents.contains("\"type\":\"accepted_input\""));
        assert!(!contents.contains("\"type\":\"pending_input_removed\""));
        return;
    }

    assert!(matches!(attempt.outcome, Err(ServiceError::ShuttingDown)));
    assert_eq!(service.status().queue_length, 0);
    let contents = writer.contents();
    assert_eq!(
        contents.contains("\"type\":\"accepted_input\""),
        !fail_rollback_sync,
        "set_len failure retains the accepted line; rollback sync failure occurs after truncation"
    );
    assert!(contents.contains("\"type\":\"pending_input_removed\""));
    assert!(contents.contains("\"reason\":\"task_commit_fenced\""));

    fs::write(&session_path, writer.bytes()).expect("controlled session bytes should write");
    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session with retirement tombstone should reopen");
    assert!(reopened.pending_messages().is_empty());
    assert!(reopened.initial_messages().is_empty());
    assert!(reopened.restart_boundary().is_none());
    let restarted = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        reopened.replay(),
        Some(reopened.recorder()),
        reopened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service should restart from the fenced session");
    assert_eq!(restarted.status().queue_length, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn task_cancel_final_admission_with_rollback_failure_restarts_without_pending_input() {
    assert_task_cancel_rollback_failure_outcome("set-len-failure", false, false).await;
    assert_task_cancel_rollback_failure_outcome("sync-failure", true, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn task_cancel_rollback_and_tombstone_sync_failure_fails_closed_without_publish() {
    assert_task_cancel_rollback_failure_outcome("rollback-and-tombstone-failure", false, true)
        .await;
}

#[tokio::test]
async fn task_final_commit_failure_with_rollback_failure_restarts_without_pending_input() {
    let home = service_test_home("task-final-commit-rollback-failure");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let session_path = opened.path().to_path_buf();
    let session_header = fs::read(&session_path).expect("session header should read");
    drop(opened);

    let writer = ControlledSessionFile::from_bytes(session_header);
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        session_path.clone(),
        writer.clone(),
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
    let task = service.inner.background_tasks.start_task_with_id(
        "final-commit-durable-task".to_owned(),
        NewBackgroundTask::new("call_final_commit_durable", "bash", "{}"),
    );
    writer.fail_next_set_len();
    let final_commit_called = Arc::new(AtomicBool::new(false));
    let final_commit_called_for_enqueue = final_commit_called.clone();

    let attempt = enqueue_task_input_inner(
        &service.inner,
        &task.task_id,
        "final-commit-durable-input".to_owned(),
        vec![ContentPart::text(
            "must not replay after final commit failure",
        )],
        InputSource::TaskRequest,
        InputUrgency::Normal,
        Some(QueuedInputMetadata::TaskRequest {
            task_id: task.task_id.clone(),
            request_id: "final-commit-durable-request".to_owned(),
        }),
        move || {
            final_commit_called_for_enqueue.store(true, Ordering::SeqCst);
            Err(FailedTransitionIntent {
                message: "injected final commit failure".to_owned(),
                clear_active_turn: false,
            })
        },
    )
    .await;

    assert!(final_commit_called.load(Ordering::SeqCst));
    assert!(matches!(
        attempt.outcome,
        Err(ServiceError::Persistence { .. })
    ));
    assert_eq!(service.status().state, ServiceState::Failed);
    let state = service.inner.state.lock().unwrap();
    assert_eq!(state.input_queue.len(), 0);
    assert!(!state
        .message_index
        .contains_key("final-commit-durable-input"));
    drop(state);
    assert!(service.events_after(0).iter().all(|event| {
        !matches!(
            event.event_type.as_str(),
            "message.received" | "message.queued"
        )
    }));
    let contents = writer.contents();
    assert!(contents.contains("\"type\":\"accepted_input\""));
    assert!(contents.contains("\"type\":\"pending_input_removed\""));
    assert!(contents.contains("\"reason\":\"task_final_commit_failed\""));

    fs::write(&session_path, writer.bytes()).expect("controlled session bytes should write");
    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session with final commit tombstone should reopen");
    assert!(reopened.pending_messages().is_empty());
    assert!(reopened.initial_messages().is_empty());
    assert!(reopened.restart_boundary().is_none());
    let restarted = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        reopened.replay(),
        Some(reopened.recorder()),
        reopened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service should restart after final commit failure");
    assert_eq!(restarted.status().queue_length, 0);
}

#[tokio::test]
async fn non_session_post_commit_projection_failure_does_not_write_tombstone() {
    #[derive(Default)]
    struct CountingRecorder {
        accepted: AtomicUsize,
        removed: AtomicUsize,
    }

    #[async_trait]
    impl AgentContextRecorder for CountingRecorder {
        async fn record_message(&self, _message: &Message) -> Result<(), AgentCommitError> {
            Ok(())
        }

        async fn record_accepted_input(
            &self,
            _entry: &AcceptedInputEntry,
        ) -> Result<(), AgentCommitError> {
            self.accepted.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn record_pending_input_removed(
            &self,
            _message_id: &str,
            _source: InputSource,
            _metadata: Option<&QueuedInputMetadata>,
            _reason: &str,
        ) -> Result<(), AgentCommitError> {
            self.removed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn record_user_batch_with_ids(
            &self,
            _messages: &[Message],
            _message_ids: &[String],
        ) -> Result<(), AgentCommitError> {
            Ok(())
        }
    }

    let recorder = Arc::new(CountingRecorder::default());
    let service = Service::with_initial_context(
        AgentConfig::new("system").with_session("service-non-session-post-commit"),
        Arc::new(PanicProvider),
        Vec::new(),
        Vec::new(),
        Some(recorder.clone()),
    )
    .expect("service construction should succeed");
    let task = service.inner.background_tasks.start_task_with_id(
        "post-commit-task".to_owned(),
        NewBackgroundTask::new("call_post_commit", "bash", "{}"),
    );
    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

    let attempt = enqueue_task_input_inner(
        &service.inner,
        &task.task_id,
        "post-commit-input".to_owned(),
        vec![ContentPart::text("durable post commit")],
        InputSource::TaskRequest,
        InputUrgency::Normal,
        Some(QueuedInputMetadata::TaskRequest {
            task_id: task.task_id.clone(),
            request_id: "post-commit-ask".to_owned(),
        }),
        || Ok(()),
    )
    .await;

    assert!(attempt.outcome.is_err());
    assert_eq!(service.status().state, ServiceState::Failed);
    assert_eq!(recorder.accepted.load(Ordering::SeqCst), 1);
    assert_eq!(recorder.removed.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn timeline_append_failure_preserves_durable_accepted_input_for_restart() {
    let home = service_test_home("accepted-input-timeline-failure");
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
    let before_seq = service.inner.last_event_seq();
    service.inject_timeline_write_failure_after_events(0, TimelineWriteFailure::Append);

    let error = service
        .enqueue(
            "msg_session_rollback_fails",
            vec![ContentPart::text("timeline failure preserves commit")],
        )
        .await
        .expect_err("timeline projection failure should reject this process attempt");

    assert!(matches!(error, ServiceError::Persistence { .. }));
    let message = error.to_string();
    assert!(
        message.contains("timeline persistence failed"),
        "error should retain timeline persistence failure: {message}"
    );
    assert!(
        message.contains("injected timeline append failure"),
        "error should include the timeline append failure: {message}"
    );

    let state = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned");
    assert_eq!(state.state, ServiceState::Idle);
    assert_eq!(state.input_queue.len(), 0);
    assert_eq!(state.next_turn_number, 1);
    assert_eq!(state.active_turn_id, None);
    assert!(state.active_cancel.is_none());
    assert!(!state
        .message_index
        .contains_key("msg_session_rollback_fails"));
    drop(state);

    let failed_events = service.events_after(before_seq);
    assert!(
        failed_events.is_empty(),
        "failed first projection must not publish ghost events: {failed_events:?}"
    );
    drop(service);
    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should reopen");
    assert_eq!(reopened.pending_messages().len(), 1);
    assert_eq!(
        reopened.pending_messages()[0].id,
        "msg_session_rollback_fails"
    );
}

#[tokio::test]
async fn pending_delivery_identity_survives_restart_and_remains_idempotent() {
    struct CancelBlockedProvider {
        entered: CancellationToken,
    }

    #[async_trait]
    impl Provider for CancelBlockedProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            cancel: CancellationToken,
        ) -> Result<ProviderResponse, ProviderError> {
            self.entered.cancel();
            cancel.cancelled().await;
            Err(ProviderError::request_failed("blocked provider cancelled"))
        }
    }

    let home = service_test_home("pending-delivery-restart");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let provider = Arc::new(CancelBlockedProvider {
        entered: CancellationToken::new(),
    });
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        opened.replay(),
        Some(opened.recorder()),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service
        .enqueue(
            "active-message",
            vec![ContentPart::text("keep the provider blocked")],
        )
        .await
        .expect("active message should start");
    tokio::time::timeout(Duration::from_secs(2), provider.entered.cancelled())
        .await
        .expect("provider should enter");

    let queued = service
        .enqueue_delivery(
            "delivery-pending-restart".to_owned(),
            "request-hash-a".to_owned(),
            vec![ContentPart::text("pending delivered text")],
            InputUrgency::Normal,
        )
        .await
        .expect("delivery should queue behind the blocked provider");
    assert_eq!(queued.submit_status, EnqueueSubmitStatus::Queued);
    service.shutdown().await;
    drop(service);
    drop(opened);

    let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should reopen");
    assert!(reopened.pending_messages().iter().any(|message| {
        message.id == "delivery-pending-restart"
            && message.delivery
                == Some(MessageDelivery {
                    delivery_key: "delivery-pending-restart".to_owned(),
                    request_hash: "request-hash-a".to_owned(),
                })
    }));
    let restarted = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        reopened.replay(),
        Some(reopened.recorder()),
        reopened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service should restart from pending input");

    let receipt = restarted
        .delivery_receipt("delivery-pending-restart")
        .expect("pending delivery receipt should be rebuilt");
    assert_eq!(receipt.request_hash, "request-hash-a");
    let duplicate = restarted
        .enqueue_delivery(
            "delivery-pending-restart".to_owned(),
            "request-hash-a".to_owned(),
            vec![ContentPart::text("pending delivered text")],
            InputUrgency::Normal,
        )
        .await
        .expect("same delivery should be idempotent after restart");
    assert_eq!(duplicate.submit_status, EnqueueSubmitStatus::Duplicate);
    assert!(matches!(
        restarted
            .enqueue_delivery(
                "delivery-pending-restart".to_owned(),
                "request-hash-b".to_owned(),
                vec![ContentPart::text("pending delivered text")],
                InputUrgency::Normal,
            )
            .await,
        Err(ServiceError::MessageConflict { .. })
    ));
}

#[tokio::test]
async fn durable_delivery_identity_survives_same_process_timeline_failure() {
    let home = service_test_home("delivery-timeline-failure");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let session_path = opened.path().to_path_buf();
    let provider = Arc::new(CountingProvider::new());
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        opened.replay(),
        Some(opened.recorder()),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");
    service.inject_timeline_write_failure_after_events(0, TimelineWriteFailure::Append);

    let content = vec![ContentPart::text("durable delivery before timeline")];
    let error = service
        .enqueue_delivery(
            "delivery-timeline-failure".to_owned(),
            "request-hash-a".to_owned(),
            content.clone(),
            InputUrgency::Normal,
        )
        .await
        .expect_err("timeline projection should fail after durable acceptance");
    assert!(matches!(error, ServiceError::Persistence { .. }));

    let missing_projection_receipt = service
        .delivery_receipt("delivery-timeline-failure")
        .expect("durable delivery should remain queryable in this process");
    assert_eq!(missing_projection_receipt.request_hash, "request-hash-a");
    let recovered = service
        .enqueue_delivery(
            "delivery-timeline-failure".to_owned(),
            "request-hash-a".to_owned(),
            content.clone(),
            InputUrgency::Normal,
        )
        .await
        .expect("same delivery retry should repair the missing projection");
    assert_eq!(recovered.submit_status, EnqueueSubmitStatus::Started);
    let live_receipt = service
        .delivery_receipt("delivery-timeline-failure")
        .expect("repaired delivery should have a live receipt");
    assert_ne!(live_receipt.cursor, missing_projection_receipt.cursor);
    wait_for_service_idle(&service).await;
    assert_eq!(provider.calls(), 1);
    assert!(matches!(
        service
            .enqueue_delivery(
                "delivery-timeline-failure".to_owned(),
                "request-hash-b".to_owned(),
                content,
                InputUrgency::Normal,
            )
            .await,
        Err(ServiceError::MessageConflict { .. })
    ));

    let accepted_count = fs::read_to_string(session_path)
        .expect("session should be readable")
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| {
            entry["type"] == "accepted_input"
                && entry["message_id"] == "delivery-timeline-failure"
        })
        .count();
    assert_eq!(accepted_count, 1);
}

#[test]
fn input_queue_state_task_request_candidates_and_stale_removal_match_source_metadata() {
    let mut queue = InputQueueState::new(VecDeque::new());
    queue.enqueue(input_queue_task_request_message(
        "task_request_match",
        "task_1",
        "request_1",
    ));
    queue.enqueue(input_queue_test_message(
        "normal_user",
        InputUrgency::Normal,
        InputSource::User,
    ));
    queue.enqueue(input_queue_task_request_message(
        "task_request_other",
        "task_1",
        "request_2",
    ));
    queue.enqueue(QueuedMessage {
        id: "task_request_missing_metadata".to_owned(),
        content: vec![ContentPart::text("invalid task request")],
        source: InputSource::TaskRequest,
        urgency: InputUrgency::Normal,
        metadata: None,
        cursor_seq: 99,
        delivery: None,
    });

    let candidates = queue.task_request_candidates();
    assert_eq!(candidates.len(), 2);
    assert_eq!(
        candidates
            .iter()
            .map(|candidate| (
                candidate.message_id.as_str(),
                candidate.task_id.as_str(),
                candidate.request_id.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("task_request_match", "task_1", "request_1"),
            ("task_request_other", "task_1", "request_2"),
        ]
    );

    let removed = queue.remove_stale_task_request(&StaleTaskRequest {
        candidate: QueuedTaskRequestCandidate {
            message_id: "task_request_match".to_owned(),
            task_id: "task_1".to_owned(),
            request_id: "request_1".to_owned(),
            source: InputSource::TaskRequest,
            metadata: QueuedInputMetadata::TaskRequest {
                task_id: "task_1".to_owned(),
                request_id: "request_1".to_owned(),
            },
        },
        state: Some(TaskRequestState::Expired),
        reason: "request_not_pending",
    });

    assert!(removed);
    assert_eq!(queue.len(), 3);
    assert_eq!(
        queue
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "normal_user",
            "task_request_other",
            "task_request_missing_metadata"
        ]
    );
}

#[test]
fn replay_message_index_and_durable_replays_are_bounded_to_recent_window_plus_pending() {
    let total = crate::session::DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW + 9;
    let known_user_messages = (0..total).map(replay_known_message).collect::<Vec<_>>();
    let message_cursors = (0..total).map(replay_cursor).collect::<Vec<_>>();
    let pending_messages = vec![replay_known_message(0)];

    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay {
            pending_messages,
            known_user_messages,
            message_cursors,
            ..SessionReplay::default()
        },
        None,
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    let state = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned");
    assert_eq!(state.input_queue.len(), 1);
    assert_eq!(
        state.message_index.len(),
        crate::session::DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW + 1
    );
    assert!(
        state.message_index.contains_key("msg_0"),
        "pending input must stay indexed even when it is older than the retained window"
    );
    assert!(
        !state.message_index.contains_key("msg_1"),
        "old committed-only ids outside the retained window should be evicted"
    );
    assert!(state
        .message_index
        .contains_key(&format!("msg_{}", total - 1)));
    assert_eq!(
        state.durable_message_replays.len(),
        crate::session::DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW
    );
    assert!(!state.durable_message_replays.contains_key("msg_1"));
    assert!(state
        .durable_message_replays
        .contains_key(&format!("msg_{}", total - 1)));
}

#[test]
fn replay_retained_cursor_corruption_is_a_persistence_error() {
    let data_dir = service_test_home("replay-retained-cursor-corruption");
    let session = "replay-retained-cursor-corruption";
    let mut timeline = TimelineStore::open(TimelineStoreOptions::new(&data_dir, Some(session)))
        .expect("open replay timeline");
    let events = (0..2)
        .map(|index| {
            timeline
                .append(TimelineAppend::new(
                    format!("event-{index}"),
                    session,
                    Value::Null,
                ))
                .expect("append replay timeline event")
        })
        .collect::<Vec<_>>();
    let segments_dir = data_dir.join("timelines").join(session).join("segments");
    let segment_path = fs::read_dir(&segments_dir)
        .expect("read timeline segments")
        .next()
        .expect("timeline segment")
        .expect("read timeline segment entry")
        .path();
    fs::write(&segment_path, b"{not-json\n").expect("corrupt replay timeline segment");
    let timeline = Arc::new(Mutex::new(timeline));

    let error = retained_cursor_seqs_for_replay(&timeline, &[events[0].seq, events[1].seq])
        .expect_err("corrupt replay timeline must fail service recovery");

    assert!(matches!(
        error,
        ServiceError::Persistence { message }
            if message.contains("corrupt timeline segment")
                && message.contains(&segment_path.display().to_string())
    ));
}

#[test]
fn restart_reconciles_durable_message_cursors_against_retained_timeline() {
    let data_dir = service_test_home("restart-cursor-reconciliation");
    let session = "restart-cursor-reconciliation";
    let cursor_count = 32;
    let mut timeline = TimelineStore::open(TimelineStoreOptions::new(&data_dir, Some(session)))
        .expect("open restart timeline");
    for seq in 1..=cursor_count * 2 {
        timeline
            .append(TimelineAppend::new(
                format!("event-{seq}"),
                session,
                Value::Null,
            ))
            .expect("append restart timeline event");
    }
    drop(timeline);

    let known_user_messages = (0..cursor_count)
        .map(replay_known_message)
        .collect::<Vec<_>>();
    let message_cursors = (0..cursor_count)
        .map(|index| DurableMessageCursor {
            message_id: format!("msg_{index}"),
            replay_start_seq: index as u64 * 2 + 1,
            terminal_seq: index as u64 * 2 + 2,
            replay_events: vec![ThreadEvent::TurnStarted],
        })
        .collect::<Vec<_>>();
    let mut config = AgentConfig::new("system").with_session(session);
    config.task_output.data_dir = data_dir;

    let service = Service::with_session_replay_and_limits(
        config,
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay {
            known_user_messages,
            message_cursors,
            ..SessionReplay::default()
        },
        None,
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("restart service");
    let state = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned");
    for index in 0..cursor_count {
        assert_eq!(
            state
                .message_index
                .get(&format!("msg_{index}"))
                .expect("restored message index entry")
                .cursor
                .seq(),
            index as u64 * 2 + 1
        );
    }
}

#[test]
fn replay_known_user_messages_protects_all_restart_boundary_active_ids() {
    let total = crate::session::DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW + 9;
    let known_user_messages = (0..total).map(replay_known_message).collect::<Vec<_>>();
    let protected_ids = vec!["msg_10".to_owned(), "msg_11".to_owned()];
    let first_ordinary_retained_id = format!(
        "msg_{}",
        total - crate::session::DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW - protected_ids.len()
    );
    let restart_boundary =
        SessionRestartBoundary::with_active_input_ids_and_active_user_message_index(
            protected_ids.clone(),
            Some(0),
        );

    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        Arc::new(PanicProvider),
        Vec::new(),
        SessionReplay {
            initial_context: vec![
                Message::user(vec![ContentPart::text("first active")]),
                Message::user(vec![ContentPart::text("second active")]),
            ],
            known_user_messages,
            restart_boundary: Some(restart_boundary),
            ..SessionReplay::default()
        },
        None,
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    let state = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned");
    for protected_id in protected_ids {
        assert!(
            state
                .known_user_messages
                .iter()
                .any(|message| message.id == protected_id),
            "restart boundary active id {protected_id} must be retained"
        );
    }
    assert!(
        state
            .known_user_messages
            .iter()
            .any(|message| message.id == first_ordinary_retained_id),
        "protected ids must not consume the ordinary recent replay window"
    );
}
