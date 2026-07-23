#[tokio::test]
async fn service_compaction_clears_retained_usage_so_success_does_not_immediately_retrigger() {
    let provider = Arc::new(CompactTestProvider::new(
        vec![
            Ok(ProviderResponse::text("first done")),
            Ok(ProviderResponse::text("second done")),
        ],
        vec![Ok(ProviderResponse::text("summary ready"))],
    ));
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        compact_context_with_retained_high_usage_assistant(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", vec![ContentPart::text("first")])
        .await
        .expect("first enqueue should succeed");
    wait_for_service_idle(&service).await;
    wait_until(|| provider.active_compactions() == 0).await;

    service
        .enqueue("msg_2", vec![ContentPart::text("second")])
        .await
        .expect("second enqueue should succeed");
    wait_for_service_idle(&service).await;

    assert_eq!(
        provider.compact_requests().len(),
        1,
        "successful compaction should not immediately retrigger from stale retained usage totals"
    );
    assert!(service.context_messages().iter().all(|message| {
        !matches!(
            message,
            Message::Assistant {
                usage: Some(Usage {
                    total_tokens: 20_000,
                    ..
                }),
                ..
            }
        )
    }));
}

#[tokio::test]
async fn service_compaction_summary_failures_are_diagnostics_not_turn_failures() {
    enum SummaryFailure {
        ProviderError,
        ProviderStop,
        ToolCalls,
        Empty,
    }

    fn compact_response(kind: SummaryFailure) -> Result<ProviderResponse, ProviderError> {
        match kind {
            SummaryFailure::ProviderError => {
                Err(ProviderError::request_failed("summary provider failed"))
            }
            SummaryFailure::ProviderStop => Ok(ProviderResponse {
                text: Some("partial".to_owned()),
                tool_calls: Vec::new(),
                assistant_replay: None,
                usage: None,
                stop_reason: StopReason::ProviderStop,
                metadata: None,
            }),
            SummaryFailure::ToolCalls => Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
                "call_summary",
                "lookup",
                json!({"q": "summary"}),
            )])),
            SummaryFailure::Empty => Ok(ProviderResponse {
                text: Some("  ".to_owned()),
                tool_calls: Vec::new(),
                assistant_replay: None,
                usage: None,
                stop_reason: StopReason::EndTurn,
                metadata: None,
            }),
        }
    }

    for (name, failure) in [
        ("provider_error", SummaryFailure::ProviderError),
        ("provider_stop", SummaryFailure::ProviderStop),
        ("tool_calls", SummaryFailure::ToolCalls),
        ("empty", SummaryFailure::Empty),
    ] {
        let provider = Arc::new(CompactTestProvider::soft(
            vec![
                Ok(ProviderResponse::text(format!("{name} first done"))),
                Ok(ProviderResponse::text(format!("{name} second done"))),
            ],
            vec![compact_response(failure)],
        ));
        let service = Service::with_initial_context(
            AgentConfig::new("system"),
            provider.clone(),
            Vec::new(),
            compact_old_context(),
            None,
        )
        .expect("service construction should succeed");

        service
            .enqueue(
                format!("{name}_msg_1"),
                soft_compact_trigger_content("first"),
            )
            .await
            .expect("first enqueue should succeed");
        wait_for_service_idle(&service).await;
        wait_until(|| provider.active_compactions() == 0).await;

        service
            .enqueue(format!("{name}_msg_2"), vec![ContentPart::text("second")])
            .await
            .expect("second enqueue should succeed");
        wait_for_service_idle(&service).await;

        assert_eq!(service.status().state, ServiceState::Idle, "{name}");
        assert_eq!(
            first_text(&service.context_messages()).as_deref(),
            Some("historic request ".to_owned() + &"old ".repeat(400)).as_deref(),
            "{name}"
        );
        assert!(
            service
                .events_after(0)
                .iter()
                .any(|event| event.event_type == "compact.failed"),
            "{name}"
        );
    }
}

#[tokio::test]
async fn service_compaction_session_append_failure_keeps_memory_and_suppresses_same_len_retry() {
    let session_file = CompactionFlushFailureSessionFile::default();
    let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
        PathBuf::from("compact-fails.jsonl"),
        session_file.clone(),
    ));
    let provider = Arc::new(CompactTestProvider::soft(
        vec![
            Ok(ProviderResponse::text("first done")),
            Ok(ProviderResponse::text("second done")),
        ],
        vec![Ok(ProviderResponse::text("summary ready"))],
    ));
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("compact-fail"),
        provider.clone(),
        Vec::new(),
        SessionReplay {
            initial_context: compact_old_context(),
            ..SessionReplay::default()
        },
        Some(recorder),
        Vec::new(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", soft_compact_trigger_content("first"))
        .await
        .expect("first enqueue should succeed");
    wait_for_service_idle(&service).await;
    wait_until(|| provider.active_compactions() == 0).await;

    service
        .enqueue("msg_2", vec![ContentPart::text("second")])
        .await
        .expect("second enqueue should succeed");
    wait_for_service_idle(&service).await;

    assert_eq!(service.status().state, ServiceState::Idle);
    assert_eq!(session_file.compaction_flush_attempts(), 1);
    assert_eq!(
        first_text(&service.context_messages()).as_deref(),
        Some("historic request ".to_owned() + &"old ".repeat(400)).as_deref()
    );
    assert_eq!(
        provider.compact_requests().len(),
        1,
        "failed commit must not immediately start another run at the same safe point"
    );
    assert!(service
        .events_after(0)
        .iter()
        .any(|event| event.event_type == "compact.failed"));
}

#[tokio::test]
async fn service_compaction_drops_completed_result_when_prefix_no_longer_matches() {
    let provider = Arc::new(CompactTestProvider::blocked_soft(
        vec![
            Ok(ProviderResponse::text("first done")),
            Ok(ProviderResponse::text("second done")),
        ],
        vec![Ok(ProviderResponse::text("stale summary"))],
    ));
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        compact_old_context(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", soft_compact_trigger_content("first"))
        .await
        .expect("first enqueue should succeed");
    wait_until(|| provider.compact_requests().len() == 1).await;
    wait_for_service_idle(&service).await;
    {
        let mut state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        state.context = vec![Message::assistant_text("external compacted state")];
    }
    provider.release_compactions();
    wait_until(|| provider.active_compactions() == 0).await;

    service
        .enqueue("msg_2", vec![ContentPart::text("second")])
        .await
        .expect("second enqueue should succeed");
    wait_for_service_idle(&service).await;

    let main_requests = provider.main_requests();
    assert_eq!(main_requests.len(), 2);
    assert_eq!(
        main_requests[1].transcript_messages(),
        vec![
            Message::assistant_text("external compacted state"),
            Message::user(vec![ContentPart::text("second")]),
        ]
    );
    assert!(!service.context_messages().iter().any(|message| {
        matches!(message, Message::User { content } if content.iter().any(|part| {
            matches!(part, ContentPart::Text { text } if text.contains("stale summary"))
        }))
    }));
}

#[tokio::test]
async fn service_compaction_allows_only_one_running_summary() {
    let provider = Arc::new(CompactTestProvider::blocked_soft(
        vec![
            Ok(ProviderResponse::text("first done")),
            Ok(ProviderResponse::text("second done")),
        ],
        vec![Ok(ProviderResponse::text("summary ready"))],
    ));
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        compact_old_context(),
        None,
    )
    .expect("service construction should succeed");

    service
        .enqueue("msg_1", soft_compact_trigger_content("first"))
        .await
        .expect("first enqueue should succeed");
    wait_until(|| provider.compact_requests().len() == 1).await;
    wait_for_service_idle(&service).await;

    service
        .enqueue(
            "msg_2",
            vec![ContentPart::text("second while summary is still running")],
        )
        .await
        .expect("second enqueue should succeed");
    wait_for_service_idle(&service).await;

    let main_requests = provider.main_requests();
    assert_eq!(main_requests.len(), 2);
    assert_low_water_compaction_request(&provider, &main_requests[0]);
    assert_low_water_compaction_request(&provider, &main_requests[1]);
    assert_eq!(provider.compact_requests().len(), 1);
    assert_eq!(provider.max_active_compactions(), 1);

    provider.release_compactions();
    wait_until(|| provider.active_compactions() == 0).await;
}

#[tokio::test]
async fn service_compaction_committed_session_replays_after_restart() {
    let home = service_test_home("compact-committed-restart");
    let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let old_context = compact_old_context();
    session
        .recorder()
        .record_user_batch_with_ids_sync(&old_context[0..1], &["old_msg".to_owned()])
        .expect("old user should persist");
    session
        .recorder()
        .record_message_sync(&old_context[1])
        .expect("old assistant should persist");
    drop(session);

    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should reopen");
    let provider = Arc::new(CompactTestProvider::soft(
        vec![
            Ok(ProviderResponse::text("first done")),
            Ok(ProviderResponse::text("second done")),
        ],
        vec![Ok(ProviderResponse::text("summary ready"))],
    ));
    let first_content = soft_compact_trigger_content("first");
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
        .enqueue("msg_1", first_content.clone())
        .await
        .expect("first enqueue should succeed");
    wait_for_service_idle(&service).await;
    wait_until(|| provider.active_compactions() == 0).await;
    service
        .enqueue("msg_2", vec![ContentPart::text("second")])
        .await
        .expect("second enqueue should succeed");
    wait_for_service_idle(&service).await;
    drop(service);

    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay committed compaction");
    assert_eq!(
        replayed.initial_messages(),
        &[
            crate::compact::summary_message("summary ready"),
            Message::user(first_content),
            Message::assistant_text("first done"),
            Message::user(vec![ContentPart::text("second")]),
            Message::assistant_text("second done"),
        ],
        "session replay must match the in-memory post-compaction transcript including messages appended while the compact run was in flight"
    );
}

