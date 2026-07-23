#[test]
fn durable_ack_boundary_message_cursor_sync_failure_does_not_install_replay_marker() {
    let session_file = CursorSyncFailureSessionFile::failing_cursor("msg_1");
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        session_file.clone(),
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
    let turn_id = "turn_1";
    let turn_started =
        service
            .inner
            .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
    let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        insert_message_index_entry(
            &mut state.message_index,
            "msg_1".to_owned(),
            vec![ContentPart::text("needs durable cursor")],
            message_cursor,
        );
    }
    service.inner.append_event_for_turn(
        Some(turn_id),
        "queue.drained",
        json!({"message_ids": ["msg_1"]}),
    );
    service
        .inner
        .append_event_for_turn(Some(turn_id), "turn.completed", json!({"usage": {}}));

    let error = persist_public_replay(service.inner.as_ref(), 0)
        .expect_err("message cursor sync failure should be returned");
    assert!(error.contains("message cursor sync_data failed"));

    assert_eq!(session_file.cursor_attempts("msg_1"), 1);
    assert!(!service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .durable_message_replays
        .contains_key("msg_1"));

    session_file.allow_cursor_sync("msg_1");
    persist_public_replay(service.inner.as_ref(), 0)
        .expect("cursor persistence retry should succeed");

    assert_eq!(session_file.cursor_attempts("msg_1"), 2);
    assert!(service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .durable_message_replays
        .contains_key("msg_1"));
}

#[test]
fn public_replay_cursor_gap_fails_without_writing_partial_cursor() {
    let session_file = CursorSyncFailureSessionFile::default();
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        session_file.clone(),
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
    let after_seq = service.inner.last_event_seq();
    let turn_id = "turn_gap";
    let turn_started = append_raw_event_for_turn(
        service.inner.as_ref(),
        Some(turn_id),
        "turn.started",
        json!({}),
    );
    let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        insert_message_index_entry(
            &mut state.message_index,
            "msg_1".to_owned(),
            vec![ContentPart::text("needs durable cursor")],
            message_cursor,
        );
    }

    for index in 0..DEFAULT_EVENT_LOG_CAPACITY {
        append_raw_event_for_turn(
            service.inner.as_ref(),
            Some(turn_id),
            "provider.delta",
            json!({"index": index}),
        );
    }
    append_raw_event_for_turn(
        service.inner.as_ref(),
        Some(turn_id),
        "queue.drained",
        json!({"message_ids": ["msg_1"]}),
    );
    append_raw_event_for_turn(
        service.inner.as_ref(),
        Some(turn_id),
        "queue.drained",
        json!({"message_ids": []}),
    );

    let error = persist_public_replay(service.inner.as_ref(), after_seq)
        .expect_err("event gap before queue.drained should fail public replay projection");
    assert!(
        error.contains("public replay") && error.contains("event gap"),
        "error should explain lost public replay event gap, got: {error}"
    );
    assert_eq!(
        session_file.cursor_attempts("msg_1"),
        0,
        "gap handling must fail before writing a partial message cursor"
    );
    assert!(!service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .durable_message_replays
        .contains_key("msg_1"));
}

#[test]
fn public_replay_cursor_incomplete_raw_projection_fails_closed_without_pruning_buffer() {
    let session_file = CursorSyncFailureSessionFile::default();
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        session_file.clone(),
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
    let after_seq = service.inner.last_event_seq();
    let turn_id = "turn_incomplete";
    let turn_started =
        service
            .inner
            .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
    let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        insert_message_index_entry(
            &mut state.message_index,
            "msg_1".to_owned(),
            vec![ContentPart::text("needs durable cursor")],
            message_cursor,
        );
    }
    service.inner.append_event_for_turn(
        Some(turn_id),
        "queue.drained",
        json!({"message_ids": ["msg_1"]}),
    );

    let error = persist_public_replay(service.inner.as_ref(), after_seq)
        .expect_err("non-durable queue.drained without terminal public event should fail");
    assert!(
        error.contains("public replay") && error.contains("incomplete"),
        "error should explain incomplete public replay projection, got: {error}"
    );
    assert_eq!(session_file.cursor_attempts("msg_1"), 0);
    assert!(!service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .durable_message_replays
        .contains_key("msg_1"));
    assert!(
        public_replay_buffer_event_count(service.inner.as_ref()) > 0,
        "incomplete projection failure must not prune retry buffer"
    );
}

#[test]
fn public_replay_cursor_raw_and_buffered_complete_turn_projections_match() {
    let session_file = CursorSyncFailureSessionFile::default();
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        session_file,
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
    let after_seq = service.inner.last_event_seq();
    let turn_id = "turn_projection_equivalence";
    let message_id = "msg_1";
    let turn_started =
        service
            .inner
            .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
    let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        insert_message_index_entry(
            &mut state.message_index,
            message_id.to_owned(),
            vec![ContentPart::text("needs durable cursor")],
            message_cursor,
        );
    }
    service.inner.append_event_for_turn(
        Some(turn_id),
        "queue.drained",
        json!({"message_ids": [message_id]}),
    );
    service
        .inner
        .append_event_for_turn(Some(turn_id), "turn.completed", json!({"usage": {}}));

    let raw_events = service
        .inner
        .event_log
        .lock()
        .expect("event log mutex poisoned")
        .read_after(after_seq);
    let raw_plan = plan_raw_public_replay_cursors(service.inner.as_ref(), &raw_events);
    let buffered_plan = plan_buffered_public_replay_cursors(service.inner.as_ref(), after_seq);

    assert!(raw_plan.complete);
    assert!(buffered_plan.complete);
    assert_eq!(raw_plan.cursors.len(), 1);
    assert_eq!(buffered_plan.cursors.len(), 1);
    let raw_cursor = &raw_plan.cursors[0];
    let buffered_cursor = &buffered_plan.cursors[0];
    assert_eq!(raw_cursor.message_id, message_id);
    assert_eq!(buffered_cursor.message_id, message_id);
    assert_eq!(
        raw_cursor.replay_start_seq,
        buffered_cursor.replay_start_seq
    );
    assert_eq!(raw_cursor.terminal_seq, buffered_cursor.terminal_seq);
    assert_eq!(raw_cursor.replay_events, buffered_cursor.replay_events);
}

#[test]
fn public_replay_cursor_projects_multiple_drains_in_same_turn() {
    let session_file = CursorSyncFailureSessionFile::default();
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        session_file,
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
    let after_seq = service.inner.last_event_seq();
    let turn_id = "turn_multi_drain_projection";
    let turn_started =
        service
            .inner
            .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
    let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        for message_id in ["msg_1", "msg_2"] {
            insert_message_index_entry(
                &mut state.message_index,
                message_id.to_owned(),
                vec![ContentPart::text(format!(
                    "needs durable cursor {message_id}"
                ))],
                message_cursor.clone(),
            );
        }
    }

    service.inner.append_event_for_turn(
        Some(turn_id),
        "provider.delta",
        json!({"text": "raw-only provider event"}),
    );
    service.inner.append_event_for_turn(
        Some(turn_id),
        "queue.drained",
        json!({"message_ids": ["msg_1"]}),
    );
    let second_drain = service.inner.append_event_for_turn(
        Some(turn_id),
        "queue.drained",
        json!({"message_ids": ["msg_2"]}),
    );
    let turn_completed = service.inner.append_event_for_turn(
        Some(turn_id),
        "turn.completed",
        json!({"usage": {"input": 7, "output": 11}}),
    );

    let raw_events = service
        .inner
        .event_log
        .lock()
        .expect("event log mutex poisoned")
        .read_after(after_seq);
    let raw_plan = plan_raw_public_replay_cursors(service.inner.as_ref(), &raw_events);
    let buffered_plan = plan_buffered_public_replay_cursors(service.inner.as_ref(), after_seq);

    assert!(raw_plan.complete);
    assert!(buffered_plan.complete);
    assert_eq!(raw_plan.cursors.len(), 2);
    assert_eq!(buffered_plan.cursors.len(), 2);
    assert_eq!(raw_plan.cursors, buffered_plan.cursors);

    let msg_1 = raw_plan
        .cursors
        .iter()
        .find(|cursor| cursor.message_id.as_str() == "msg_1")
        .expect("msg_1 cursor should be planned");
    let msg_2 = raw_plan
        .cursors
        .iter()
        .find(|cursor| cursor.message_id.as_str() == "msg_2")
        .expect("msg_2 cursor should be planned");
    let real_completed_event = ThreadEvent::TurnCompleted {
        usage: crate::agent_events::AgentUsage {
            input_tokens: 7,
            cached_input_tokens: 0,
            output_tokens: 11,
            reasoning_output_tokens: 0,
        },
    };

    assert_eq!(msg_1.terminal_seq, second_drain.seq);
    assert_eq!(
        msg_1.replay_events,
        vec![ThreadEvent::TurnStarted, synthetic_turn_completed_event()]
    );
    assert!(!msg_1.replay_events.contains(&real_completed_event));

    assert_eq!(msg_2.terminal_seq, turn_completed.seq);
    assert_eq!(
        msg_2.replay_events,
        vec![ThreadEvent::TurnStarted, real_completed_event]
    );
}

#[test]
fn public_replay_cursor_survives_event_ring_gap_with_per_cycle_projection_buffer() {
    let session_file = CursorSyncFailureSessionFile::default();
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        session_file.clone(),
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
    let after_seq = service.inner.last_event_seq();
    let turn_id = "turn_buffer_gap";
    let turn_started =
        service
            .inner
            .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
    let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        insert_message_index_entry(
            &mut state.message_index,
            "msg_1".to_owned(),
            vec![ContentPart::text("needs durable cursor")],
            message_cursor,
        );
    }

    for index in 0..DEFAULT_EVENT_LOG_CAPACITY {
        service.inner.append_event_for_turn(
            Some(turn_id),
            "provider.delta",
            json!({"index": index}),
        );
    }
    service.inner.append_event_for_turn(
        Some(turn_id),
        "queue.drained",
        json!({"message_ids": ["msg_1"]}),
    );
    service
        .inner
        .append_event_for_turn(Some(turn_id), "turn.completed", json!({"usage": {}}));

    assert!(service
        .inner
        .event_log
        .lock()
        .expect("event log mutex poisoned")
        .read_after(after_seq)
        .iter()
        .any(|event| event.event_type == "event.gap"));
    persist_public_replay(service.inner.as_ref(), after_seq)
        .expect("per-cycle buffer should persist cursor despite ring gap");

    assert_eq!(session_file.cursor_attempts("msg_1"), 1);
    assert!(service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .durable_message_replays
        .contains_key("msg_1"));
}

#[test]
fn public_replay_cursor_sync_failure_with_buffer_does_not_install_marker_and_retries() {
    let session_file = CursorSyncFailureSessionFile::failing_cursor("msg_1");
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        session_file.clone(),
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
    let after_seq = service.inner.last_event_seq();
    let turn_id = "turn_buffer_retry";
    let turn_started =
        service
            .inner
            .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
    let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        insert_message_index_entry(
            &mut state.message_index,
            "msg_1".to_owned(),
            vec![ContentPart::text("needs durable cursor")],
            message_cursor,
        );
    }

    for index in 0..DEFAULT_EVENT_LOG_CAPACITY {
        service.inner.append_event_for_turn(
            Some(turn_id),
            "provider.delta",
            json!({"index": index}),
        );
    }
    service.inner.append_event_for_turn(
        Some(turn_id),
        "queue.drained",
        json!({"message_ids": ["msg_1"]}),
    );
    service
        .inner
        .append_event_for_turn(Some(turn_id), "turn.completed", json!({"usage": {}}));

    let error = persist_public_replay(service.inner.as_ref(), after_seq)
        .expect_err("cursor sync failure should be returned even when buffer covers gap");
    assert!(error.contains("message cursor sync_data failed"));
    assert_eq!(session_file.cursor_attempts("msg_1"), 1);
    assert!(!service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .durable_message_replays
        .contains_key("msg_1"));
    assert!(
        public_replay_buffer_event_count(service.inner.as_ref()) > 0,
        "cursor sync failure must keep buffer events for retry"
    );

    session_file.allow_cursor_sync("msg_1");
    persist_public_replay(service.inner.as_ref(), after_seq)
        .expect("buffered cursor persistence retry should succeed");
    assert_eq!(session_file.cursor_attempts("msg_1"), 2);
    assert!(service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .durable_message_replays
        .contains_key("msg_1"));
}

#[test]
fn public_replay_cursor_batch_sync_failure_installs_synced_markers_and_retries_missing() {
    let session_file = CursorSyncFailureSessionFile::failing_cursor("msg_2");
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        session_file.clone(),
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
    let after_seq = service.inner.last_event_seq();
    let turn_id = "turn_buffer_batch";
    let turn_started =
        service
            .inner
            .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
    let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        for message_id in ["msg_1", "msg_2"] {
            insert_message_index_entry(
                &mut state.message_index,
                message_id.to_owned(),
                vec![ContentPart::text(format!(
                    "needs durable cursor {message_id}"
                ))],
                message_cursor.clone(),
            );
        }
    }

    for index in 0..DEFAULT_EVENT_LOG_CAPACITY {
        service.inner.append_event_for_turn(
            Some(turn_id),
            "provider.delta",
            json!({"index": index}),
        );
    }
    service.inner.append_event_for_turn(
        Some(turn_id),
        "queue.drained",
        json!({"message_ids": ["msg_1", "msg_2"]}),
    );
    service
        .inner
        .append_event_for_turn(Some(turn_id), "turn.completed", json!({"usage": {}}));

    let error = persist_public_replay(service.inner.as_ref(), after_seq)
        .expect_err("second cursor sync failure should return an error");
    assert!(error.contains("message cursor sync_data failed"));
    assert_eq!(session_file.synced_cursor_ids(), vec!["msg_1"]);
    assert_eq!(session_file.cursor_attempts("msg_1"), 1);
    assert_eq!(session_file.cursor_attempts("msg_2"), 1);
    {
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(
            state.durable_message_replays.contains_key("msg_1"),
            "msg_1 marker should be installed immediately after its cursor sync succeeds"
        );
        assert!(!state.durable_message_replays.contains_key("msg_2"));
    }
    assert!(
        public_replay_buffer_event_count(service.inner.as_ref()) > 0,
        "partial cursor sync failure must not prune retry buffer"
    );

    session_file.allow_cursor_sync("msg_2");
    persist_public_replay(service.inner.as_ref(), after_seq)
        .expect("retry should write only the missing cursor");
    assert_eq!(session_file.synced_cursor_ids(), vec!["msg_1", "msg_2"]);
    assert_eq!(
        session_file.cursor_attempts("msg_1"),
        1,
        "retry should skip already durable cursor"
    );
    assert_eq!(session_file.cursor_attempts("msg_2"), 2);
    let state = service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned");
    assert!(state.durable_message_replays.contains_key("msg_1"));
    assert!(state.durable_message_replays.contains_key("msg_2"));
}

#[test]
fn public_replay_cursor_prunes_no_candidate_and_already_durable_buffer_windows() {
    let session_file = CursorSyncFailureSessionFile::default();
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("session.jsonl"),
        session_file.clone(),
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

    let empty_after_seq = service.inner.last_event_seq();
    service
        .inner
        .append_event_for_turn(Some("turn_empty"), "turn.started", json!({}));
    service.inner.append_event_for_turn(
        Some("turn_empty"),
        "queue.drained",
        json!({"message_ids": []}),
    );
    service
        .inner
        .append_event_for_turn(Some("turn_empty"), "turn.completed", json!({"usage": {}}));
    assert!(public_replay_buffer_event_count(service.inner.as_ref()) > 0);
    persist_public_replay(service.inner.as_ref(), empty_after_seq)
        .expect("empty queue.drained replay window should be pruned successfully");
    assert_eq!(public_replay_buffer_event_count(service.inner.as_ref()), 0);

    let msg_after_seq = service.inner.last_event_seq();
    let turn_started =
        service
            .inner
            .append_event_for_turn(Some("turn_msg"), "turn.started", json!({}));
    let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        insert_message_index_entry(
            &mut state.message_index,
            "msg_1".to_owned(),
            vec![ContentPart::text("needs durable cursor")],
            message_cursor,
        );
    }
    service.inner.append_event_for_turn(
        Some("turn_msg"),
        "queue.drained",
        json!({"message_ids": ["msg_1"]}),
    );
    service
        .inner
        .append_event_for_turn(Some("turn_msg"), "turn.completed", json!({"usage": {}}));
    persist_public_replay(service.inner.as_ref(), msg_after_seq)
        .expect("first message cursor persist should succeed");
    assert_eq!(session_file.cursor_attempts("msg_1"), 1);
    assert_eq!(public_replay_buffer_event_count(service.inner.as_ref()), 0);

    let durable_after_seq = service.inner.last_event_seq();
    service
        .inner
        .append_event_for_turn(Some("turn_durable"), "turn.started", json!({}));
    service.inner.append_event_for_turn(
        Some("turn_durable"),
        "queue.drained",
        json!({"message_ids": ["msg_1"]}),
    );
    service.inner.append_event_for_turn(
        Some("turn_durable"),
        "turn.completed",
        json!({"usage": {}}),
    );
    assert!(public_replay_buffer_event_count(service.inner.as_ref()) > 0);
    persist_public_replay(service.inner.as_ref(), durable_after_seq)
        .expect("already durable candidate replay window should prune without rewriting");
    assert_eq!(
        session_file.cursor_attempts("msg_1"),
        1,
        "already durable message cursor should not be rewritten"
    );
    assert_eq!(public_replay_buffer_event_count(service.inner.as_ref()), 0);
}
