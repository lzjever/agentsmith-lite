struct PendingCancellationProvider {
    entered: AtomicBool,
    completed: AtomicBool,
    dropped: AtomicBool,
    notify: Notify,
    release: Notify,
}

impl PendingCancellationProvider {
    fn new() -> Self {
        Self {
            entered: AtomicBool::new(false),
            completed: AtomicBool::new(false),
            dropped: AtomicBool::new(false),
            notify: Notify::new(),
            release: Notify::new(),
        }
    }

    async fn wait_until_entered(&self) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !self.entered.load(Ordering::SeqCst) {
                self.notify.notified().await;
            }
        })
        .await
        .expect("service provider should enter complete within 1 second");
    }

    fn release(&self) {
        self.release.notify_one();
    }

    async fn wait_until_completed(&self) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !self.completed.load(Ordering::SeqCst) {
                self.notify.notified().await;
            }
        })
        .await
        .expect("service provider should complete within 1 second");
    }

    async fn wait_until_dropped(&self) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !self.dropped.load(Ordering::SeqCst) {
                self.notify.notified().await;
            }
        })
        .await
        .expect("provider future should be dropped after cancellation");
    }
}

struct CancellationDropProbe<'a>(&'a PendingCancellationProvider);

impl Drop for CancellationDropProbe<'_> {
    fn drop(&mut self) {
        self.0.dropped.store(true, Ordering::SeqCst);
        self.0.notify.notify_one();
    }
}

#[async_trait]
impl Provider for PendingCancellationProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        let _drop_probe = CancellationDropProbe(self);
        self.entered.store(true, Ordering::SeqCst);
        self.notify.notify_one();
        self.release.notified().await;
        self.completed.store(true, Ordering::SeqCst);
        self.notify.notify_one();
        Ok(ProviderResponse::text("controlled provider completed"))
    }
}

#[tokio::test]
async fn service_abort_drops_uncooperative_main_provider_and_releases_worker() {
    let provider = Arc::new(PendingCancellationProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-provider-cancellation"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    service
        .enqueue("pending-provider", vec![ContentPart::text("wait")])
        .await
        .expect("input should enqueue");
    provider.wait_until_entered().await;

    service.abort().await;

    provider.wait_until_dropped().await;
    tokio::time::timeout(
        Duration::from_secs(1),
        service.wait_for_state(ServiceState::Idle),
    )
    .await
    .expect("aborted service should become idle");
    wait_until(|| service.inner.active_service_worker_count() == 0).await;
}

#[tokio::test]
async fn shutdown_drops_uncooperative_main_provider_and_remains_quiescent() {
    let provider = Arc::new(PendingCancellationProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-main-provider-shutdown-cancellation"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    service
        .enqueue("shutdown-pending", vec![ContentPart::text("wait forever")])
        .await
        .expect("input should enqueue");
    provider.wait_until_entered().await;

    let shutdown_service = service.clone();
    let shutdown = tokio::spawn(async move { shutdown_service.shutdown().await });

    provider.wait_until_dropped().await;
    wait_until(|| service.inner.active_service_worker_count() == 0).await;
    let status = tokio::time::timeout(Duration::from_secs(1), shutdown)
        .await
        .expect("shutdown should finish after dropping the provider future")
        .expect("shutdown task should not panic");
    assert_eq!(status.state, ServiceState::ShuttingDown);
    assert_eq!(status.last_error, None);
    assert_eq!(service.status().last_error, None);

    let events = service.events_after(0);
    let abort_requests = events
        .iter()
        .filter(|event| event.event_type == "agent.abort_requested")
        .collect::<Vec<_>>();
    assert_eq!(abort_requests.len(), 1);
    assert_eq!(abort_requests[0].data["reason"], json!("service_shutdown"));
    assert!(events.iter().any(|event| {
        event.event_type == "service.status" && event.data["state"] == json!("shutting_down")
    }));
}

#[tokio::test]
async fn main_compaction_cancellation_drops_uncooperative_provider_future() {
    let provider = Arc::new(PendingCancellationProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("main-compaction-provider-cancellation"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let run_id = 81;
    let cancel = CancellationToken::new();
    *service
        .inner
        .compact
        .slot
        .lock()
        .expect("compact slot mutex poisoned") = CompactSlot::Running {
        run_id,
        messages_at_start: Vec::new(),
        retained_start: 0,
        start_len: 0,
        cancel: cancel.clone(),
        hard_failure_key: None,
        hard_failure_count_at_start: 0,
    };
    spawn_compaction_provider_call(service.inner.clone(), run_id, Vec::new(), cancel.clone());
    provider.wait_until_entered().await;

    cancel.cancel();

    provider.wait_until_dropped().await;
    wait_until(|| service.inner.active_service_worker_count() == 0).await;
    let slot = service
        .inner
        .compact
        .slot
        .lock()
        .expect("compact slot mutex poisoned");
    assert!(matches!(
        &*slot,
        CompactSlot::Completed { summary_result: Err(error), .. }
            if error == "compaction request cancelled"
    ));
}

#[tokio::test]
async fn stale_main_compaction_worker_completion_preserves_new_running_slot() {
    let provider = Arc::new(PendingCancellationProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("stale-main-compaction-worker-completion"),
        provider.clone(),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let run_a_id = 91;
    let run_a_messages = vec![Message::user(vec![ContentPart::text("run a")])];
    let run_a_cancel = CancellationToken::new();
    *service
        .inner
        .compact
        .slot
        .lock()
        .expect("compact slot mutex poisoned") = CompactSlot::Running {
        run_id: run_a_id,
        messages_at_start: run_a_messages.clone(),
        retained_start: 0,
        start_len: 1,
        cancel: run_a_cancel.clone(),
        hard_failure_key: None,
        hard_failure_count_at_start: 0,
    };
    spawn_compaction_provider_call(
        service.inner.clone(),
        run_a_id,
        run_a_messages.clone(),
        run_a_cancel.clone(),
    );
    provider.wait_until_entered().await;

    {
        let slot = service
            .inner
            .compact
            .slot
            .lock()
            .expect("compact slot mutex poisoned");
        assert!(matches!(
            &*slot,
            CompactSlot::Running { run_id, .. } if *run_id == run_a_id
        ));
    }
    assert_eq!(service.inner.active_service_worker_count(), 1);

    let run_b_id = 92;
    let run_b_messages = vec![
        Message::user(vec![ContentPart::text("run b user")]),
        Message::assistant_text("run b assistant"),
    ];
    let run_b_hard_failure_key = HardCompactFailureKey {
        provider_profile: "run-b-profile".to_owned(),
        provider_name: Some("run-b-provider".to_owned()),
        provider_model: Some("run-b-model".to_owned()),
        target_usable_tokens: 4_096,
        retained_start: 1,
        start_len: 2,
        prefix_hash: 92,
    };
    let run_b_cancel = CancellationToken::new();
    *service
        .inner
        .compact
        .slot
        .lock()
        .expect("compact slot mutex poisoned") = CompactSlot::Running {
        run_id: run_b_id,
        messages_at_start: run_b_messages.clone(),
        retained_start: 1,
        start_len: 2,
        cancel: run_b_cancel.clone(),
        hard_failure_key: Some(run_b_hard_failure_key.clone()),
        hard_failure_count_at_start: 7,
    };

    let slot_progress = service.inner.notify.notified();
    tokio::pin!(slot_progress);
    slot_progress.as_mut().enable();
    provider.release();
    provider.wait_until_completed().await;
    provider.wait_until_dropped().await;
    tokio::time::timeout(Duration::from_secs(1), slot_progress)
        .await
        .expect("stale compaction completion should notify slot waiters");
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let notified = service.inner.notify.notified();
            if service.inner.active_service_worker_count() == 0 {
                break;
            }
            notified.await;
        }
    })
    .await
    .expect("stale compaction worker should release its registry guard");

    let slot = service
        .inner
        .compact
        .slot
        .lock()
        .expect("compact slot mutex poisoned");
    match &*slot {
        CompactSlot::Running {
            run_id,
            messages_at_start,
            retained_start,
            start_len,
            cancel,
            hard_failure_key,
            hard_failure_count_at_start,
        } => {
            assert_eq!(*run_id, run_b_id);
            assert_eq!(messages_at_start, &run_b_messages);
            assert_eq!(*retained_start, 1);
            assert_eq!(*start_len, 2);
            assert!(!cancel.is_cancelled());
            assert_eq!(
                hard_failure_key.as_ref(),
                Some(&run_b_hard_failure_key)
            );
            assert_eq!(*hard_failure_count_at_start, 7);
        }
        _ => panic!("stale completion must leave the replacement running slot intact"),
    }
    assert!(!run_a_cancel.is_cancelled());
    assert!(!run_b_cancel.is_cancelled());
    assert_eq!(service.inner.active_service_worker_count(), 0);
}

#[tokio::test]
async fn subagent_compaction_cancellation_drops_uncooperative_provider_future() {
    let provider = Arc::new(PendingCancellationProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("subagent-compaction-provider-cancellation"),
        Arc::new(TextProvider("unused")),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let parent_cancel = CancellationToken::new();
    let hook = SubagentCompactionHook::new(
        Arc::downgrade(&service.inner),
        "pending-compaction-subagent".to_owned(),
        AgentConfig::new("subagent system"),
        provider.clone(),
        None,
        parent_cancel,
    );
    let run_id = 82;
    let cancel = CancellationToken::new();
    *hook
        .runtime
        .compact
        .slot
        .lock()
        .expect("compact slot mutex poisoned") = CompactSlot::Running {
        run_id,
        messages_at_start: Vec::new(),
        retained_start: 0,
        start_len: 0,
        cancel: cancel.clone(),
        hard_failure_key: None,
        hard_failure_count_at_start: 0,
    };
    hook.runtime
        .clone()
        .spawn_compaction_provider_call(run_id, Vec::new(), cancel.clone());
    provider.wait_until_entered().await;

    cancel.cancel();

    provider.wait_until_dropped().await;
    wait_until(|| service.inner.active_service_worker_count() == 0).await;
    let slot = hook
        .runtime
        .compact
        .slot
        .lock()
        .expect("compact slot mutex poisoned");
    assert!(matches!(
        &*slot,
        CompactSlot::Completed { summary_result: Err(error), .. }
            if error == "compaction request cancelled"
    ));
}

#[tokio::test]
async fn subagent_cancel_drops_uncooperative_provider_and_releases_worker() {
    let provider = Arc::new(PendingCancellationProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("subagent-provider-cancellation"),
        Arc::new(TextProvider("unused")),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = spawn_panicking_subagent(&service, provider.clone(), "wait forever");
    provider.wait_until_entered().await;

    service.inner.cancel_subagent_tool_result(
        ToolCall::new("cancel-pending", "subagent_cancel", json!({})),
        &subagent_id,
    );

    provider.wait_until_dropped().await;
    wait_until(|| service.inner.active_service_worker_count() == 0).await;
}

#[tokio::test]
async fn shutdown_cancels_pending_subagent_without_failure_or_callback() {
    let provider = Arc::new(PendingCancellationProvider::new());
    let service = Service::new(
        AgentConfig::new("system").with_session("service-subagent-provider-shutdown-cancellation"),
        Arc::new(TextProvider("unused")),
        Vec::new(),
    )
    .expect("service construction should succeed");
    let subagent_id = spawn_panicking_subagent(&service, provider.clone(), "wait forever");
    provider.wait_until_entered().await;
    let before_seq = service.inner.last_event_seq();

    let shutdown_service = service.clone();
    let shutdown = tokio::spawn(async move { shutdown_service.shutdown().await });

    provider.wait_until_dropped().await;
    wait_until(|| service.inner.active_service_worker_count() == 0).await;
    tokio::time::timeout(Duration::from_secs(1), shutdown)
        .await
        .expect("shutdown should finish after dropping the subagent provider future")
        .expect("shutdown task should not panic");

    let snapshot = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&subagent_id)
        .expect("subagent snapshot");
    assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
    assert_eq!(snapshot.run_state, SubagentRunState::Idle);
    assert_eq!(snapshot.callback_count, 0);
    let events = service.events_after(before_seq);
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "subagent.cancelled"
                    && event.data["subagent_id"] == json!(subagent_id)
            })
            .count(),
        1,
        "shutdown should publish the stable cancellation event once: {events:?}"
    );
    assert!(!events.iter().any(|event| {
        event.event_type == "subagent.failed" && event.data["subagent_id"] == json!(subagent_id)
    }));
    assert!(!events.iter().any(|event| {
        event.event_type == "subagent.callback" && event.data["subagent_id"] == json!(subagent_id)
    }));
}
