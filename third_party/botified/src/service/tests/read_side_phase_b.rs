const READ_SIDE_PHASE_B_DEADMAN: Duration = Duration::from_secs(5);

struct RetentionScanReleaseGuard(Option<std::sync::mpsc::SyncSender<()>>);

impl RetentionScanReleaseGuard {
    fn new(sender: std::sync::mpsc::SyncSender<()>) -> Self {
        Self(Some(sender))
    }

    fn release(&mut self) {
        if let Some(sender) = self.0.take() {
            sender.send(()).expect("resume retention scan");
        }
    }
}

impl Drop for RetentionScanReleaseGuard {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

#[derive(Clone)]
struct ReadSidePhaseBClock(Arc<Mutex<i64>>);

impl crate::timeline_store::TimelineClock for ReadSidePhaseBClock {
    fn now_unix_ms(&self) -> i64 {
        *self.0.lock().expect("read-side phase B clock")
    }
}

impl ReadSidePhaseBClock {
    fn set(&self, value: i64) {
        *self.0.lock().expect("read-side phase B clock") = value;
    }
}

fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after epoch")
        .as_millis() as i64
}

fn retention_scan_fixture(name: &str) -> EventCommitTestFixture {
    const DAY_MS: i64 = 86_400_000;
    let data_dir = service_test_home(name);
    let now = unix_time_ms();
    let cutoff = now - DEFAULT_TIMELINE_RETENTION_DAYS as i64 * DAY_MS;
    let clock = ReadSidePhaseBClock(Arc::new(Mutex::new(cutoff - 60_000)));
    let mut store = TimelineStore::open(
        TimelineStoreOptions::new(&data_dir, Some(name))
            .retention_days(DEFAULT_TIMELINE_RETENTION_DAYS)
            .clock(clock.clone()),
    )
    .expect("open mixed-retention timeline fixture");
    store
        .append(TimelineAppend::new("expired-seed", name, Value::Null))
        .expect("append expired timeline seed");
    clock.set(cutoff + 60_000);
    store
        .append(TimelineAppend::new("retained-seed", name, Value::Null))
        .expect("append retained timeline seed");
    drop(store);

    let service = Service::with_timeline_data_dir(
        AgentConfig::new("system").with_session(name),
        Arc::new(PanicProvider),
        Vec::new(),
        &data_dir,
    )
    .expect("service construction should succeed");
    let opened_at = unix_time_ms();
    let deadline = std::time::Instant::now() + READ_SIDE_PHASE_B_DEADMAN;
    while unix_time_ms() <= opened_at {
        assert!(
            std::time::Instant::now() < deadline,
            "system clock should advance for retention scan fixture"
        );
        std::thread::yield_now();
    }
    EventCommitTestFixture {
        service: Some(service),
        data_dir,
    }
}

#[test]
fn status_releases_state_before_waiting_for_timeline_store() {
    let fixture = EventCommitTestFixture::new("status-timeline-lock-order");
    let service = fixture.service();
    let timeline_guard = service.inner.timeline_store.lock().unwrap();
    let (state_copied_tx, state_copied_rx) = std::sync::mpsc::sync_channel(1);
    let (continue_tx, continue_rx) = std::sync::mpsc::sync_channel(1);
    let continue_rx = Arc::new(Mutex::new(continue_rx));
    service
        .inner
        .set_status_state_snapshot_test_hook(Arc::new(move || {
            state_copied_tx.send(()).expect("signal copied status state");
            continue_rx
                .lock()
                .unwrap()
                .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
                .expect("continue status");
        }));

    let (status_tx, status_rx) = std::sync::mpsc::sync_channel(1);
    let status_service = service.clone();
    let reader = std::thread::spawn(move || {
        status_tx
            .send(status_service.status())
            .expect("status result should send");
    });
    state_copied_rx
        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
        .expect("status should copy state");
    let state_available = service.inner.state.try_lock().is_ok();

    continue_tx.send(()).expect("continue status read");
    drop(timeline_guard);
    status_rx
        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
        .expect("status should finish after timeline unlock");
    reader.join().expect("status thread should not panic");
    assert!(
        state_available,
        "status must release state before reading timeline sequence"
    );
}

#[test]
fn bootstrap_waits_for_durable_event_projection_and_returns_matching_cursor() {
    let fixture = EventCommitTestFixture::new("bootstrap-commit-projection");
    let service = fixture.service();
    service
        .inner
        .event_commit_test_hook
        .pause_after_durable("task_ask.requested");

    let append_inner = service.inner.clone();
    let append = std::thread::spawn(move || {
        append_inner.try_append_event_for_turn(
            None,
            "task_ask.requested",
            json!({"task_id": "gate_visible", "ask_id": "question", "status": "pending"}),
        )
    });
    service.inner.event_commit_test_hook.wait_until_paused();
    service
        .inner
        .event_commit_test_hook
        .expect_gate_attempt(EventCommitGateActor::Bootstrap);

    let (bootstrap_tx, bootstrap_rx) = std::sync::mpsc::sync_channel(1);
    let bootstrap_service = service.clone();
    let bootstrap = std::thread::spawn(move || {
        bootstrap_tx
            .send(bootstrap_service.timeline_bootstrap_snapshot())
            .expect("bootstrap result should send");
    });
    service
        .inner
        .event_commit_test_hook
        .wait_until_gate_attempt(EventCommitGateActor::Bootstrap);
    service.inner.event_commit_test_hook.release();
    let event = append
        .join()
        .expect("append thread should not panic")
        .expect("event should append");
    let snapshot = bootstrap_rx
        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
        .expect("bootstrap should finish after projection");
    bootstrap.join().expect("bootstrap thread should not panic");

    assert_eq!(snapshot["timeline_seq"], json!(event.seq));
    assert_eq!(
        EventCursor::parse_timeline(snapshot["timeline_cursor"].as_str().unwrap())
            .expect("bootstrap cursor should parse")
            .seq(),
        event.seq
    );
    assert!(snapshot["active_items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == json!("task_ask_gate_visible_question")));
}

#[test]
fn blocked_bootstrap_retention_does_not_block_status_state_or_event_append() {
    let fixture = retention_scan_fixture("bootstrap-retention-concurrency");
    let service = fixture.service();
    let frozen_seq = service.inner.last_event_seq();
    let (scan_started_tx, scan_started_rx) = std::sync::mpsc::sync_channel(1);
    let (release_scan_tx, release_scan_rx) = std::sync::mpsc::sync_channel(1);
    let mut release_scan = RetentionScanReleaseGuard::new(release_scan_tx);
    let release_scan_rx = Arc::new(Mutex::new(release_scan_rx));
    let first_read = Arc::new(AtomicBool::new(true));
    service
        .inner
        .timeline_store
        .lock()
        .unwrap()
        .set_segment_read_observer_for_test({
            let first_read = first_read.clone();
            move || {
                if first_read.swap(false, Ordering::AcqRel) {
                    scan_started_tx.send(()).expect("signal retention scan");
                    release_scan_rx
                        .lock()
                        .unwrap()
                        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
                        .expect("release retention scan");
                }
            }
        });

    let (bootstrap_tx, bootstrap_rx) = std::sync::mpsc::sync_channel(1);
    let bootstrap_service = service.clone();
    let bootstrap = std::thread::spawn(move || {
        bootstrap_tx
            .send(bootstrap_service.timeline_bootstrap_snapshot())
            .expect("bootstrap result should send");
    });
    scan_started_rx
        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
        .expect("retention scan should start");

    let (status_tx, status_rx) = std::sync::mpsc::sync_channel(1);
    let status_service = service.clone();
    let status = std::thread::spawn(move || {
        status_tx
            .send(status_service.status())
            .expect("status result should send");
    });
    status_rx
        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
        .expect("status must finish during retention scan");
    let state_available = service.inner.state.try_lock().is_ok();

    let (append_tx, append_rx) = std::sync::mpsc::sync_channel(1);
    let append_inner = service.inner.clone();
    let append = std::thread::spawn(move || {
        append_tx
            .send(append_inner.try_append_event_for_turn(
                None,
                "test.after_frozen_bootstrap",
                json!({}),
            ))
            .expect("append result should send");
    });
    let appended = append_rx
        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
        .expect("append must finish during retention scan")
        .expect("event should append during retention scan");

    release_scan.release();
    let snapshot = bootstrap_rx
        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
        .expect("bootstrap should finish");
    bootstrap.join().expect("bootstrap thread should not panic");
    status.join().expect("status thread should not panic");
    append.join().expect("append thread should not panic");

    assert!(state_available, "state mutex must be free during retention scan");
    assert!(appended.seq > frozen_seq);
    assert_eq!(snapshot["timeline_seq"], json!(frozen_seq));
    assert_eq!(
        snapshot["timeline"]["retention"]["latest_seq"],
        json!(frozen_seq)
    );
}

#[test]
fn bootstrap_state_and_task_fields_are_each_from_one_snapshot() {
    let fixture = EventCommitTestFixture::new("bootstrap-single-source");
    let service = fixture.service();

    let (state_paused_tx, state_paused_rx) = std::sync::mpsc::sync_channel(1);
    let (release_state_tx, release_state_rx) = std::sync::mpsc::sync_channel(1);
    let release_state_rx = Arc::new(Mutex::new(release_state_rx));
    service
        .inner
        .set_bootstrap_state_snapshot_test_hook(Arc::new(move || {
            state_paused_tx.send(()).expect("signal state snapshot");
            release_state_rx
                .lock()
                .unwrap()
                .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
                .expect("release state snapshot");
        }));

    let (task_paused_tx, task_paused_rx) = std::sync::mpsc::sync_channel(1);
    let (release_task_tx, release_task_rx) = std::sync::mpsc::sync_channel(1);
    let release_task_rx = Arc::new(Mutex::new(release_task_rx));
    service
        .inner
        .set_bootstrap_task_snapshot_test_hook(Arc::new(move || {
            task_paused_tx.send(()).expect("signal task snapshot");
            release_task_rx
                .lock()
                .unwrap()
                .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
                .expect("release task snapshot");
        }));

    let (snapshot_tx, snapshot_rx) = std::sync::mpsc::sync_channel(1);
    let snapshot_service = service.clone();
    let reader = std::thread::spawn(move || {
        snapshot_tx
            .send(snapshot_service.timeline_bootstrap_snapshot())
            .expect("snapshot result should send");
    });
    state_paused_rx
        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
        .expect("state snapshot should pause");

    let (mutated_tx, mutated_rx) = std::sync::mpsc::sync_channel(1);
    let mutation_inner = service.inner.clone();
    let mutate = std::thread::spawn(move || {
        let mut state = mutation_inner.state.lock().unwrap();
        state.state = ServiceState::Failed;
        state.last_error = Some("newer state".to_owned());
        mutated_tx.send(()).expect("state mutation should send");
    });
    mutated_rx
        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
        .expect("state mutation must finish after bootstrap snapshot");
    release_state_tx.send(()).expect("release state snapshot");

    task_paused_rx
        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
        .expect("task snapshot should pause");
    service.inner.background_tasks.start_task_with_id(
        "after-task-snapshot",
        NewBackgroundTask::new("call", "tool", "summary"),
    );
    release_task_tx.send(()).expect("release task snapshot");

    let snapshot = snapshot_rx
        .recv_timeout(READ_SIDE_PHASE_B_DEADMAN)
        .expect("bootstrap should finish");
    reader.join().expect("bootstrap thread should not panic");
    mutate.join().expect("state mutation should not panic");

    let service_item = snapshot["active_items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == json!("service"))
        .unwrap();
    assert_eq!(snapshot["state"], service_item["status"]);
    assert_eq!(snapshot["last_error"], service_item["data"]["last_error"]);
    assert_eq!(snapshot["tasks"], service_item["data"]["tasks"]);
    assert_eq!(snapshot["tasks"]["running"], json!(0));
    assert!(!snapshot["active_items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == json!("task_after-task-snapshot")));
}
