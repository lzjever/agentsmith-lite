#[tokio::test]
async fn service_task_list_tool_result_stays_structured_and_bounded_in_provider_request() {
    let mut provider = CompactTestProvider::new(
        vec![
            Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
                "call_list_many_tasks",
                "task_list",
                json!({}),
            )])),
            Ok(ProviderResponse::text("listed many tasks")),
        ],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 128_000, 4_096);
    let provider = Arc::new(provider);
    let service = Service::with_initial_context(
        AgentConfig::new("system"),
        provider.clone(),
        Vec::new(),
        Vec::new(),
        None,
    )
    .expect("service construction should succeed");
    for index in 0..90 {
        let task = service.inner.background_tasks.start_task(
            NewBackgroundTask::new(
                format!("call_task_list_{index}"),
                "bash",
                format!("{}-{index}", "argument-".repeat(3_000)),
            )
            .with_artifact_path(format!(".botified/state/tasks/t_{index}/output.log")),
        );
        service
            .inner
            .background_tasks
            .update_output(
                &task.task_id,
                TaskOutputUpdate::bytes(format!(
                    "HEAD_SENTINEL_{index}{}TAIL_SENTINEL_{index}",
                    "y".repeat(20_000)
                )),
            )
            .expect("task should exist");
    }

    service
        .enqueue(
            "msg_task_list_many",
            vec![ContentPart::text("list many tasks")],
        )
        .await
        .expect("message should enqueue");
    wait_for_service_idle(&service).await;

    let requests = provider.main_requests();
    assert_eq!(requests.len(), 2);
    let result = requests[1]
        .transcript_messages()
        .into_iter()
        .find_map(|message| match message {
            Message::ToolResult(result) if result.tool_name == "task_list" => Some(result),
            _ => None,
        })
        .expect("task_list result should be in the follow-up request");
    let parsed: Value =
        serde_json::from_str(&result.text).expect("task_list text should remain JSON");
    assert_eq!(parsed["kind"], json!("task_list"));
    assert_eq!(parsed["total"], json!(90));
    assert_eq!(parsed["omitted"], json!(26));
    assert_eq!(result.details["kind"], json!("task_list"));
    assert_eq!(result.details["total"], json!(90));
    assert_eq!(result.details["omitted"], json!(26));
    assert!(
        result.text.len() <= 64 * 1024,
        "provider-visible task_list text should stay bounded, len={}",
        result.text.len()
    );
    assert!(
        result.details.to_string().len() <= 64 * 1024,
        "provider-visible task_list details should stay bounded"
    );
    assert!(!result.text.contains(&"argument-".repeat(100)));
    assert!(!result.text.contains(&"y".repeat(4_096)));
}

#[tokio::test]
async fn service_subagent_list_tool_result_stays_structured_and_bounded_in_provider_request() {
    let mut provider = CompactTestProvider::new(
        vec![
            Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
                "call_list_many_subagents",
                "subagent_list",
                json!({}),
            )])),
            Ok(ProviderResponse::text("listed many subagents")),
        ],
        Vec::new(),
    );
    set_compact_test_metadata(&mut provider, 256_000, 4_096);
    let provider = Arc::new(provider);
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-list-many-structured"),
        provider.clone(),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(64, 64)),
    )
    .expect("service construction should succeed");
    {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        for index in 0..48 {
            let snapshot = manager
                .open(
                    format!("Reviewer {index}"),
                    format!("purpose-{index}-{}", "p".repeat(4_000)),
                )
                .expect("subagent should open");
            manager
                .complete(
                    &snapshot.id,
                    format!("result-{index}-{}", "r".repeat(8_000)),
                )
                .expect("subagent should complete");
        }
    }

    service
        .enqueue(
            "msg_subagent_list_many",
            vec![ContentPart::text("list many subagents")],
        )
        .await
        .expect("message should enqueue");
    wait_for_service_idle(&service).await;

    let requests = provider.main_requests();
    assert_eq!(requests.len(), 2);
    let result = requests[1]
        .transcript_messages()
        .into_iter()
        .find_map(|message| match message {
            Message::ToolResult(result) if result.tool_name == "subagent_list" => Some(result),
            _ => None,
        })
        .expect("subagent_list result should be in the follow-up request");
    let parsed: Value =
        serde_json::from_str(&result.text).expect("subagent_list text should remain JSON");
    assert_eq!(parsed["kind"], json!("subagent_list"));
    assert_eq!(parsed["total"], json!(48));
    let subagents = parsed["subagents"]
        .as_array()
        .expect("bounded subagent_list text should keep subagents array");
    let first = subagents
        .first()
        .expect("bounded subagent_list should keep at least one subagent");
    assert!(first["subagent_id"].as_str().is_some());
    assert!(first["name"].as_str().is_some());
    assert_eq!(first["lifecycle"], json!("open"));
    assert_eq!(first["run_state"], json!("completed"));
    assert_eq!(first["status_summary"], json!("completed"));
    assert_eq!(result.details["kind"], json!("subagent_list"));
    assert_eq!(result.details["total"], json!(48));
    assert!(result.details["subagents"].is_array());
    assert!(
        result.text.len() <= 64 * 1024,
        "provider-visible subagent_list text should stay bounded, len={}",
        result.text.len()
    );
    assert!(
        result.details.to_string().len() <= 64 * 1024,
        "provider-visible subagent_list details should stay bounded"
    );
}

#[tokio::test]
async fn service_subagent_read_all_tool_result_stays_structured_and_bounded_in_provider_request() {
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 256_000, 4_096);
    let provider = Arc::new(provider);
    let service = Service::with_subagent_options(
        AgentConfig::new("system").with_session("service-subagent-read-all-structured"),
        provider.clone(),
        Vec::new(),
        ServiceSubagentOptions::enabled(SubagentLimits::new(2, 4).with_tail_limit(64)),
    )
    .expect("service construction should succeed");
    let subagent_id = {
        let mut manager = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let snapshot = manager
            .spawn("Reader", format!("initial-task-{}", "i".repeat(8_000)))
            .expect("subagent should spawn");
        for index in 0..64 {
            manager
                .send(
                    &snapshot.id,
                    format!("queued-message-{index}-{}", "q".repeat(8_000)),
                )
                .expect("queued message should record");
            manager
                .record_callback(
                    &snapshot.id,
                    format!("callback_{index}"),
                    "completed",
                    SubagentCallbackStatus::Pending,
                    Some(format!("failure-reason-{index}-{}", "f".repeat(1_000))),
                )
                .expect("callback should record");
        }
        snapshot.id
    };
    {
        let mut responses = provider
            .main_responses
            .lock()
            .expect("main responses mutex poisoned");
        responses.push(Ok(ProviderResponse::text("read subagent")));
        responses.push(Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
            "call_read_large_subagent",
            "subagent_read",
            json!({"subagent_id": subagent_id, "include": "all"}),
        )])));
    }

    service
        .enqueue(
            "msg_subagent_read_all",
            vec![ContentPart::text("read all for subagent")],
        )
        .await
        .expect("message should enqueue");
    wait_for_service_idle(&service).await;

    let requests = provider.main_requests();
    assert_eq!(requests.len(), 2);
    let result = requests[1]
        .transcript_messages()
        .into_iter()
        .find_map(|message| match message {
            Message::ToolResult(result) if result.tool_name == "subagent_read" => Some(result),
            _ => None,
        })
        .expect("subagent_read result should be in the follow-up request");
    let parsed: Value =
        serde_json::from_str(&result.text).expect("subagent_read text should remain JSON");
    assert_eq!(parsed["subagent_id"], json!(subagent_id));
    assert_eq!(parsed["name"], json!("Reader"));
    assert_eq!(parsed["lifecycle"], json!("open"));
    assert_eq!(parsed["run_state"], json!("running"));
    assert_eq!(parsed["status_summary"], json!("running"));
    assert!(
        parsed["queued_messages"].is_array(),
        "bounded subagent_read text should keep queued_messages"
    );
    assert!(
        parsed["callbacks"].is_array(),
        "bounded subagent_read text should keep callbacks"
    );
    assert_eq!(result.details["subagent_id"], json!(subagent_id));
    assert_eq!(result.details["name"], json!("Reader"));
    assert!(result.details["queued_messages"].is_array());
    assert!(result.details["callbacks"].is_array());
    assert!(
        result.text.len() <= 64 * 1024,
        "provider-visible subagent_read text should stay bounded, len={}",
        result.text.len()
    );
    assert!(
        result.details.to_string().len() <= 64 * 1024,
        "provider-visible subagent_read details should stay bounded"
    );
}

#[tokio::test]
async fn service_degraded_recovery_active_request_too_large_persists_terminal_compaction() {
    let home = service_test_home("active-request-too-large-terminal-compaction");
    let opened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should open");
    let path = opened.path().to_path_buf();
    let mut provider = CompactTestProvider::new(Vec::new(), Vec::new());
    set_compact_test_metadata(&mut provider, 8_192, 1_024);
    let provider = Arc::new(provider);
    let service = Service::with_session_replay_and_limits(
        AgentConfig::new("system").with_session("service-test"),
        provider.clone(),
        Vec::new(),
        SessionReplay {
            pending_messages: oversized_active_batch("msg_terminal_recovery"),
            ..opened.replay()
        },
        Some(opened.recorder()),
        opened.warnings().to_vec(),
        ServiceLimits::default(),
    )
    .expect("service construction should succeed");

    service.start_pending_if_needed().await;
    wait_for_service_idle(&service).await;
    drop(service);

    assert_eq!(
        provider.main_requests().len(),
        0,
        "active-request recovery must stop before sending the oversized active batch"
    );
    let records = session_body_records(&fs::read(&path).expect("session should read"));
    let compaction = records
        .iter()
        .find(|record| {
            record["type"] == json!("compaction")
                && record["metadata"]["reason"] == json!(ACTIVE_REQUEST_TOO_LARGE_FOR_MODEL_WINDOW)
        })
        .expect("active-request recovery compaction should be durable");
    assert!(
        compaction.get("active_user_message_id").is_none(),
        "active-request recovery compaction must not leave a restart boundary"
    );
    assert_eq!(
        compaction["metadata"]["source"],
        json!("local_recovery"),
        "active-request recovery should persist structured local-recovery metadata"
    );
    assert_eq!(compaction["metadata"]["degraded"], json!(true));

    let replayed = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
        .expect("session should replay active-request recovery");
    assert!(
        replayed.restart_boundary().is_none(),
        "terminal active-request recovery must not replay as an active request"
    );
    let replayed_messages = format!("{:?}", replayed.initial_messages());
    assert!(replayed_messages.contains("Local degraded recovery summary"));
    assert!(
        !replayed_messages.contains("msg_terminal_recovery first active input")
            && !replayed_messages.contains("msg_terminal_recovery second active input"),
        "replay must not revive the omitted active request"
    );
}

