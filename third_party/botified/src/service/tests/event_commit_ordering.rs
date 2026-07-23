const EVENT_COMMIT_TEST_DEADMAN: Duration = Duration::from_secs(5);

struct EventCommitTestFixture {
    service: Option<Service>,
    data_dir: PathBuf,
}

impl EventCommitTestFixture {
    fn new(name: &str) -> Self {
        let data_dir = service_test_home(name);
        let service = Service::with_timeline_data_dir(
            AgentConfig::new("system").with_session(name),
            Arc::new(PanicProvider),
            Vec::new(),
            &data_dir,
        )
        .expect("service construction should succeed");
        Self {
            service: Some(service),
            data_dir,
        }
    }

    fn service(&self) -> &Service {
        self.service
            .as_ref()
            .expect("event commit test service should exist")
    }
}

impl Drop for EventCommitTestFixture {
    fn drop(&mut self) {
        drop(self.service.take());
        let _ = fs::remove_dir_all(&self.data_dir);
    }
}

fn assert_event_log_is_commit_ordered(service: &Service, event_types: &[&str]) {
    let events = service
        .events_after(0)
        .into_iter()
        .filter(|event| event_types.contains(&event.event_type.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(events.len(), event_types.len());
    assert!(
        events.windows(2).all(|pair| pair[0].seq < pair[1].seq),
        "EventLog must preserve durable commit order: {events:?}"
    );
}

#[test]
fn concurrent_regular_events_cannot_project_out_of_durable_order() {
    let fixture = EventCommitTestFixture::new("regular-event-commit-order");
    let service = fixture.service();
    service
        .inner
        .event_commit_test_hook
        .pause_after_durable("test.regular_a");

    let (event_a_tx, event_a_rx) = std::sync::mpsc::sync_channel(1);
    let append_a = {
        let inner = service.inner.clone();
        std::thread::spawn(move || {
            event_a_tx
                .send(inner.try_append_event_for_turn(None, "test.regular_a", json!({})))
                .expect("event A result should send");
        })
    };
    service.inner.event_commit_test_hook.wait_until_paused();
    service
        .inner
        .event_commit_test_hook
        .expect_gate_attempt(EventCommitGateActor::Regular);

    let (event_b_tx, event_b_rx) = std::sync::mpsc::sync_channel(1);
    let append_b = {
        let inner = service.inner.clone();
        std::thread::spawn(move || {
            event_b_tx
                .send(inner.try_append_event_for_turn(None, "test.regular_b", json!({})))
                .expect("event B result should send");
        })
    };
    service
        .inner
        .event_commit_test_hook
        .wait_until_gate_attempt(EventCommitGateActor::Regular);
    service.inner.event_commit_test_hook.release();
    let event_a = event_a_rx
        .recv_timeout(EVENT_COMMIT_TEST_DEADMAN)
        .expect("event A result should arrive")
        .expect("event A should persist");
    let event_b = event_b_rx
        .recv_timeout(EVENT_COMMIT_TEST_DEADMAN)
        .expect("event B result should arrive")
        .expect("event B should persist");
    append_a.join().expect("event A thread should not panic");
    append_b.join().expect("event B thread should not panic");
    assert!(
        event_a.seq < event_b.seq,
        "A must be durably committed first"
    );

    assert_event_log_is_commit_ordered(service, &["test.regular_a", "test.regular_b"]);
}

#[test]
fn regular_and_callback_events_share_durable_commit_order() {
    let fixture = EventCommitTestFixture::new("callback-event-commit-order");
    let service = fixture.service();
    service
        .inner
        .event_commit_test_hook
        .pause_after_durable("test.regular_before_callback");

    let (regular_tx, regular_rx) = std::sync::mpsc::sync_channel(1);
    let append_regular = {
        let inner = service.inner.clone();
        std::thread::spawn(move || {
            regular_tx
                .send(inner.try_append_event_for_turn(
                    None,
                    "test.regular_before_callback",
                    json!({}),
                ))
                .expect("regular event result should send");
        })
    };
    service.inner.event_commit_test_hook.wait_until_paused();
    service
        .inner
        .event_commit_test_hook
        .expect_gate_attempt(EventCommitGateActor::Callback);

    let (callback_tx, callback_rx) = std::sync::mpsc::sync_channel(1);
    let append_callback = {
        let inner = service.inner.clone();
        std::thread::spawn(move || {
            let result = inner.project_callback_delivery_intent_once(&CallbackDeliveryIntent {
                projection_id: "test-shared-commit-gate".to_owned(),
                event_type: CallbackDeliveryEventType::TaskDelivered,
                data: json!({"callback_input_id": "test-shared-commit-gate"}),
            });
            callback_tx
                .send(result)
                .expect("callback event result should send");
        })
    };
    service
        .inner
        .event_commit_test_hook
        .wait_until_gate_attempt(EventCommitGateActor::Callback);
    service.inner.event_commit_test_hook.release();
    let regular = regular_rx
        .recv_timeout(EVENT_COMMIT_TEST_DEADMAN)
        .expect("regular event result should arrive")
        .expect("regular event should persist");
    callback_rx
        .recv_timeout(EVENT_COMMIT_TEST_DEADMAN)
        .expect("callback event result should arrive")
        .expect("callback event should persist");
    append_regular
        .join()
        .expect("regular event thread should not panic");
    append_callback
        .join()
        .expect("callback event thread should not panic");
    let projected_events = service.events_after(0);
    let callback = projected_events
        .iter()
        .find(|event| event.event_type == "task.callback_delivered")
        .expect("callback event should exist");
    assert!(
        regular.seq < callback.seq,
        "regular event must be durable first"
    );

    assert_event_log_is_commit_ordered(
        service,
        &["test.regular_before_callback", "task.callback_delivered"],
    );
}

#[tokio::test]
async fn persistence_failure_does_not_project_or_notify() {
    let fixture = EventCommitTestFixture::new("failed-event-not-projected-or-notified");
    let service = fixture.service();
    let before_seq = service.current_event_cursor().seq();
    let mut notified = Box::pin(service.inner.event_notify.notified());
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(notified.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;

    service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);
    service
        .inner
        .try_append_event_for_turn(None, "test.must_not_project", json!({}))
        .expect_err("injected timeline failure should reject the event");

    assert_eq!(service.current_event_cursor().seq(), before_seq);
    assert!(service
        .events_after(before_seq)
        .iter()
        .all(|event| event.event_type != "test.must_not_project"));
    assert!(
        tokio::time::timeout(Duration::from_millis(25), notified.as_mut())
            .await
            .is_err(),
        "failed persistence must not notify event waiters"
    );
}

#[test]
fn post_commit_meta_failure_publishes_returned_envelope_once() {
    let fixture = EventCommitTestFixture::new("meta-failure-publishes-once");
    let service = fixture.service();
    service.inject_next_timeline_write_failure(TimelineWriteFailure::MetaWrite);

    let committed = service
        .inner
        .try_append_event_for_turn(None, "test.meta_failure_committed", json!({}))
        .expect("meta checkpoint failure must not hide a durable event");
    let published = service
        .events_after(committed.seq.saturating_sub(1))
        .into_iter()
        .filter(|event| event.event_type == "test.meta_failure_committed")
        .collect::<Vec<_>>();

    assert_eq!(published.len(), 1);
    assert_eq!(published[0].seq, committed.seq);
}
