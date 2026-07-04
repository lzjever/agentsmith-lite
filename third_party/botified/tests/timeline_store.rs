use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use botified::timeline_store::{
    HistoryBoundary, TimelineAppend, TimelineClock, TimelineStore, TimelineStoreOptions,
    TimelineStoreRecord, TimelineWriteFailure, DEFAULT_TIMELINE_HOT_EVENT_CAPACITY,
};
use botified::{EventCursor, TimelineEnvelope, TimelineTrace};
use serde_json::json;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[test]
fn append_read_tail_backward_and_forward_pages_are_ordered_and_cursor_based() {
    let clock = ManualClock::new(1_800_000_000_000);
    let mut store = open_store("core-pages", Some("session-a"), 14, clock.clone());

    let first = append_event(&mut store, "one");
    let second = append_event(&mut store, "two");
    let third = append_event(&mut store, "three");
    let fourth = append_event(&mut store, "four");

    assert_eq!(store.checkpoint().seq, 4);
    assert_eq!(store.checkpoint().cursor, fourth.cursor);
    assert_eq!(store.retention().earliest_seq, Some(1));
    assert_eq!(store.retention().latest_seq, Some(4));

    let forward = store
        .read_forward(&first.cursor, 2)
        .expect("forward page should read");
    assert_eq!(event_types(&forward.events), ["two", "three"]);
    assert_eq!(forward.next_cursor, third.cursor);
    assert!(forward.has_more_after);

    let forward_rest = store
        .read_forward(&forward.next_cursor, 2)
        .expect("second forward page should read");
    assert_eq!(event_types(&forward_rest.events), ["four"]);
    assert_eq!(forward_rest.next_cursor, fourth.cursor);
    assert!(!forward_rest.has_more_after);

    let tail = store.tail(2).expect("tail page should read");
    assert_eq!(event_types(&tail.events), ["three", "four"]);
    assert_eq!(tail.page_start_cursor, third.cursor);
    assert_eq!(tail.page_end_cursor, fourth.cursor);
    assert_eq!(tail.next_cursor, fourth.cursor);
    assert!(tail.has_more_before);
    assert_eq!(tail.history_boundary, HistoryBoundary::None);

    let backward = store
        .read_backward(&fourth.cursor, 2)
        .expect("backward page should read");
    assert_eq!(event_types(&backward.events), ["two", "three"]);
    assert_eq!(backward.page_start_cursor, second.cursor);
    assert_eq!(backward.page_end_cursor, third.cursor);
    assert!(backward.has_more_before);
    assert_eq!(backward.history_boundary, HistoryBoundary::None);

    let start = store
        .read_backward(&second.cursor, 2)
        .expect("backward page to start should read");
    assert_eq!(event_types(&start.events), ["one"]);
    assert!(!start.has_more_before);
    assert_eq!(start.history_boundary, HistoryBoundary::Start);
}

#[test]
fn empty_store_has_zero_checkpoint_and_tail_zero_cursors() {
    let clock = ManualClock::new(1_800_000_000_000);
    let store = open_store("empty", Some("empty-session"), 14, clock);

    let checkpoint = store.checkpoint();
    assert_eq!(checkpoint.seq, 0);
    assert!(checkpoint.cursor.ends_with("_0"));
    assert_eq!(store.retention().earliest_seq, None);
    assert_eq!(store.retention().latest_seq, None);

    let tail = store.tail(10).expect("empty tail should read");
    assert!(tail.events.is_empty());
    assert_eq!(tail.page_start_cursor, checkpoint.cursor);
    assert_eq!(tail.page_end_cursor, checkpoint.cursor);
    assert_eq!(tail.next_cursor, checkpoint.cursor);
    assert!(!tail.has_more_before);
    assert_eq!(tail.history_boundary, HistoryBoundary::Start);
}

#[test]
fn expired_empty_retained_range_keeps_latest_checkpoint_for_tail_forward_and_backward() {
    let base = 1_800_000_000_000;
    let clock = ManualClock::new(base - DAY_MS - 1);
    let root = timeline_root("expired-empty-retained");
    let mut store = open_store_at(&root, Some("expired-empty"), 1, clock.clone());
    append_event(&mut store, "expired-latest");
    let checkpoint = store.checkpoint();

    clock.set(base);
    assert_eq!(store.retention().earliest_seq, None);
    assert_eq!(store.retention().latest_seq, None);

    let tail = store.tail(10).expect("tail should use latest checkpoint");
    assert!(tail.events.is_empty());
    assert_eq!(tail.page_start_cursor, checkpoint.cursor);
    assert_eq!(tail.page_end_cursor, checkpoint.cursor);
    assert_eq!(tail.next_cursor, checkpoint.cursor);
    assert_eq!(tail.history_boundary, HistoryBoundary::Expired);

    let forward = store
        .read_forward(&checkpoint.cursor, 10)
        .expect("latest checkpoint remains a valid forward boundary");
    assert!(forward.events.is_empty());
    assert_eq!(forward.next_cursor, checkpoint.cursor);
    assert!(!forward.has_more_after);

    let backward = store
        .read_backward(&checkpoint.cursor, 10)
        .expect("latest checkpoint remains a valid backward boundary");
    assert!(backward.events.is_empty());
    assert_eq!(backward.page_start_cursor, checkpoint.cursor);
    assert_eq!(backward.page_end_cursor, checkpoint.cursor);
    assert!(!backward.has_more_before);
    assert_eq!(backward.history_boundary, HistoryBoundary::Expired);

    let zero_cursor = EventCursor::for_instance(store.instance(), 0)
        .expect("zero cursor")
        .to_string();
    assert!(store
        .read_forward(&zero_cursor, 10)
        .expect_err("zero cursor is stale after all real events expired")
        .is_stale_cursor());

    let reopened = TimelineStore::open(
        TimelineStoreOptions::new(&root, Some("expired-empty"))
            .retention_days(1)
            .clock(clock),
    )
    .expect("reopen expired empty retained store");
    assert_eq!(reopened.checkpoint(), checkpoint);
    assert_eq!(reopened.retention().earliest_seq, None);
    let reopened_tail = reopened.tail(10).expect("reopened tail");
    assert!(reopened_tail.events.is_empty());
    assert_eq!(reopened_tail.history_boundary, HistoryBoundary::Expired);
    let reopened_backward = reopened
        .read_backward(&checkpoint.cursor, 10)
        .expect("reopened backward from latest checkpoint");
    assert!(reopened_backward.events.is_empty());
    assert_eq!(reopened_backward.history_boundary, HistoryBoundary::Expired);
}

#[test]
fn retention_filters_mixed_expired_segment_and_preserves_records_at_cutoff() {
    let base = 1_800_000_000_000;
    let clock = ManualClock::new(base);
    let mut store = open_store("mixed-retention", Some("retained"), 1, clock.clone());

    clock.set(base - DAY_MS - 1);
    let expired = append_event(&mut store, "expired");
    clock.set(base - DAY_MS);
    let at_cutoff = append_event(&mut store, "at-cutoff");
    clock.set(base - DAY_MS + 1);
    let retained = append_event(&mut store, "retained");

    clock.set(base);

    let retention = store.retention();
    assert_eq!(retention.earliest_seq, Some(at_cutoff.seq));
    assert_eq!(retention.earliest_cursor, Some(at_cutoff.cursor.clone()));
    assert_eq!(retention.latest_seq, Some(retained.seq));

    let tail = store.tail(10).expect("tail should apply logical retention");
    assert_eq!(event_types(&tail.events), ["at-cutoff", "retained"]);

    let stale = store
        .read_forward(&expired.cursor, 10)
        .expect_err("cursor before cutoff should be stale");
    assert!(stale.is_stale_cursor());

    let page = store
        .read_forward(&at_cutoff.cursor, 10)
        .expect("cursor at cutoff is retained");
    assert_eq!(event_types(&page.events), ["retained"]);
}

#[test]
fn meta_loss_recovers_instance_latest_seq_hot_cache_and_retained_range() {
    let clock = ManualClock::new(1_800_000_000_000);
    let root = timeline_root("meta-loss");
    let mut store = open_store_at(&root, Some("session-meta"), 14, clock.clone());
    let first = append_event(&mut store, "first");
    let second = append_event(&mut store, "second");
    let dir = store.timeline_dir().to_path_buf();
    fs::remove_file(dir.join("meta.json")).expect("remove meta");

    let restored = TimelineStore::open(
        TimelineStoreOptions::new(&root, Some("session-meta"))
            .retention_days(14)
            .clock(clock),
    )
    .expect("store should recover without meta");

    assert_eq!(restored.checkpoint().seq, second.seq);
    assert_eq!(restored.checkpoint().cursor, second.cursor);
    assert_eq!(restored.retention().earliest_cursor, Some(first.cursor));
    let tail = restored.tail(10).expect("tail after recovery");
    assert_eq!(event_types(&tail.events), ["first", "second"]);
}

#[test]
fn stale_meta_latest_seq_above_segment_max_is_corrected_on_reopen() {
    let clock = ManualClock::new(1_800_000_000_000);
    let root = timeline_root("stale-meta-latest-seq");
    let mut store = open_store_at(&root, Some("session-stale-meta"), 14, clock.clone());
    let first = append_event(&mut store, "first");
    let second = append_event(&mut store, "second");
    let dir = store.timeline_dir().to_path_buf();
    let stale_seq = second.seq + 100;
    let stale_cursor = EventCursor::for_instance(store.instance(), stale_seq)
        .expect("stale cursor")
        .to_string();

    let meta_path = dir.join("meta.json");
    let mut meta: serde_json::Value =
        serde_json::from_slice(&fs::read(&meta_path).expect("read meta"))
            .expect("meta should be valid json");
    meta["latest_seq"] = json!(stale_seq);
    meta["latest_cursor"] = json!(stale_cursor);
    fs::write(
        &meta_path,
        serde_json::to_vec_pretty(&meta).expect("serialize stale meta"),
    )
    .expect("write stale meta");

    let restored = TimelineStore::open(
        TimelineStoreOptions::new(&root, Some("session-stale-meta"))
            .retention_days(14)
            .clock(clock),
    )
    .expect("stale meta should be corrected from segment records");

    assert_eq!(restored.checkpoint().seq, second.seq);
    assert_eq!(restored.checkpoint().cursor, second.cursor);
    assert_eq!(restored.retention().earliest_cursor, Some(first.cursor));
    assert!(restored
        .read_forward(&stale_cursor, 10)
        .expect_err("stale meta cursor must not become a future checkpoint")
        .is_stale_cursor());

    let rebuilt_meta: serde_json::Value =
        serde_json::from_slice(&fs::read(meta_path).expect("read rebuilt meta"))
            .expect("rebuilt meta should be valid json");
    assert_eq!(rebuilt_meta["latest_seq"], second.seq);
    assert_eq!(rebuilt_meta["latest_cursor"], second.cursor);
}

#[test]
fn corrupt_meta_is_isolated_and_rebuilt_from_segments() {
    let clock = ManualClock::new(1_800_000_000_000);
    let root = timeline_root("corrupt-meta");
    let mut store = open_store_at(&root, Some("session-corrupt-meta"), 14, clock.clone());
    let first = append_event(&mut store, "first");
    let second = append_event(&mut store, "second");
    let dir = store.timeline_dir().to_path_buf();
    fs::write(dir.join("meta.json"), b"{not-valid-json").expect("corrupt meta");

    let restored = TimelineStore::open(
        TimelineStoreOptions::new(&root, Some("session-corrupt-meta"))
            .retention_days(14)
            .clock(clock),
    )
    .expect("corrupt meta should not block segment recovery");

    assert_eq!(restored.checkpoint().seq, second.seq);
    assert_eq!(restored.checkpoint().cursor, second.cursor);
    assert_eq!(restored.retention().earliest_cursor, Some(first.cursor));
    assert_eq!(
        event_types(&restored.tail(10).expect("tail after corrupt meta").events),
        ["first", "second"]
    );

    let rebuilt_meta: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("meta.json")).expect("read rebuilt meta"))
            .expect("rebuilt meta should be valid json");
    assert_eq!(rebuilt_meta["latest_seq"], second.seq);
    assert!(
        fs::read_dir(&dir)
            .expect("read timeline dir")
            .any(|entry| entry
                .expect("timeline entry")
                .file_name()
                .to_string_lossy()
                .starts_with("meta.json.corrupt.")),
        "corrupt meta should be isolated before rewrite"
    );
}

#[test]
fn meta_rewrite_uses_temp_file_and_publishes_complete_json() {
    let clock = ManualClock::new(1_800_000_000_000);
    let root = timeline_root("atomic-meta");
    let mut store = open_store_at(&root, Some("session-atomic-meta"), 14, clock);
    let first = append_event(&mut store, "first");
    let dir = store.timeline_dir().to_path_buf();
    let tmp = dir.join("meta.json.tmp");
    fs::write(&tmp, b"stale temp").expect("write stale temp");

    let second = append_event(&mut store, "second");

    assert!(
        !tmp.exists(),
        "successful atomic meta publish should not leave the temp file behind"
    );
    let meta: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("meta.json")).expect("read meta"))
            .expect("published meta should be complete json");
    assert_eq!(meta["latest_seq"], second.seq);
    assert_eq!(meta["earliest_seq"], first.seq);
}

#[test]
fn new_segment_directory_sync_path_succeeds_and_reopens() {
    let base = 1_800_000_000_000;
    let clock = ManualClock::new(base);
    let root = timeline_root("new-segment-dir-sync");
    let mut store = open_store_at(&root, Some("session-dir-sync"), 14, clock.clone());
    let first = append_event(&mut store, "first-day");

    clock.set(base + DAY_MS);
    let second = append_event(&mut store, "second-day");
    let segments = sorted_segment_paths(&store);
    assert_eq!(segments.len(), 2, "test should create two segment files");
    for segment in &segments {
        assert!(
            segment.exists(),
            "segment should be visible after append ack"
        );
    }

    let restored = TimelineStore::open(
        TimelineStoreOptions::new(&root, Some("session-dir-sync"))
            .retention_days(14)
            .clock(clock),
    )
    .expect("directory sync path should not break ordinary reopen");

    assert_eq!(restored.checkpoint().seq, second.seq);
    assert_eq!(restored.retention().earliest_cursor, Some(first.cursor));
    assert_eq!(
        event_types(&restored.tail(10).expect("tail after reopen").events),
        ["first-day", "second-day"]
    );
}

#[test]
fn session_instances_are_isolated_under_same_data_dir() {
    let clock = ManualClock::new(1_800_000_000_000);
    let root = timeline_root("instance-isolation");
    let mut first =
        TimelineStore::open(TimelineStoreOptions::new(&root, Some("alpha")).clock(clock.clone()))
            .expect("open first store");
    let mut second =
        TimelineStore::open(TimelineStoreOptions::new(&root, Some("beta")).clock(clock))
            .expect("open second store");

    let first_event = append_event(&mut first, "alpha-event");
    let second_event = append_event(&mut second, "beta-event");

    assert_eq!(first_event.seq, 1);
    assert_eq!(second_event.seq, 1);
    assert_ne!(first.checkpoint().cursor, second.checkpoint().cursor);
    assert_eq!(
        event_types(&first.tail(10).expect("first tail").events),
        ["alpha-event"]
    );
    assert_eq!(
        event_types(&second.tail(10).expect("second tail").events),
        ["beta-event"]
    );
}

#[test]
fn same_timeline_dir_mixed_instance_records_keep_current_meta_instance_isolated() {
    let clock = ManualClock::new(1_800_000_000_000);
    let root = timeline_root("mixed-instance-current");
    let mut store = open_store_at(&root, Some("same-session"), 14, clock.clone());
    let first = append_event(&mut store, "current-one");
    let second = append_event(&mut store, "current-two");
    let current_instance = store.instance().to_owned();
    let segment = only_segment_path(&store);
    let foreign = manual_record(
        1_800_000_000_001,
        "tforeigninstance",
        3,
        "foreign-three",
        "same-session",
    );
    write_record_line(&segment, &foreign);

    let restored = TimelineStore::open(
        TimelineStoreOptions::new(&root, Some("same-session"))
            .retention_days(14)
            .clock(clock),
    )
    .expect("mixed instance store should restore current meta instance");

    assert_eq!(restored.instance(), current_instance);
    assert_eq!(restored.checkpoint().seq, second.seq);
    assert_eq!(restored.checkpoint().cursor, second.cursor);
    assert_eq!(
        event_types(&restored.tail(10).expect("tail after mixed instance").events),
        ["current-one", "current-two"]
    );
    assert_eq!(restored.retention().earliest_cursor, Some(first.cursor));
    assert!(restored
        .read_forward(&foreign.envelope.cursor, 10)
        .expect_err("foreign instance cursor should be stale")
        .is_stale_cursor());
}

#[test]
fn latest_segment_bad_line_truncates_from_first_bad_line_and_drops_later_valid_records() {
    let clock = ManualClock::new(1_800_000_000_000);
    let root = timeline_root("latest-corrupt");
    let mut store = open_store_at(&root, Some("session-corrupt"), 14, clock.clone());
    let first = append_event(&mut store, "first");
    append_event(&mut store, "second");
    let segment = only_segment_path(&store);
    fs::OpenOptions::new()
        .append(true)
        .open(&segment)
        .expect("open segment")
        .write_all(
            br#"not-json
{"append_time_unix_ms":1800000000000,"envelope":{"version":"botified.timeline.v1","seq":99,"cursor":"evt_tbad_99","time":"unix:test","session_id":"session-corrupt","type":"after-bad","trace":{"cycle_id":null},"data":{}}}
"#,
        )
        .expect("append corruption");

    let restored = TimelineStore::open(
        TimelineStoreOptions::new(&root, Some("session-corrupt"))
            .retention_days(14)
            .clock(clock),
    )
    .expect("latest corrupt segment should recover by truncating");

    assert_eq!(restored.checkpoint().seq, 2);
    assert_eq!(restored.retention().earliest_cursor, Some(first.cursor));
    assert_eq!(
        event_types(&restored.tail(10).expect("tail after repair").events),
        ["first", "second"]
    );
    let repaired = fs::read_to_string(segment).expect("read repaired segment");
    assert!(!repaired.contains("not-json"));
    assert!(!repaired.contains("after-bad"));
}

#[test]
fn non_latest_segment_bad_line_isolated_while_latest_segment_remains_readable() {
    let base = 1_800_000_000_000;
    let clock = ManualClock::new(base);
    let root = timeline_root("old-corrupt");
    let mut store = open_store_at(&root, Some("session-old-corrupt"), 14, clock.clone());

    clock.set(base);
    let old = append_event(&mut store, "old");
    clock.set(base + DAY_MS);
    let latest = append_event(&mut store, "latest");

    let mut segments = sorted_segment_paths(&store);
    assert_eq!(segments.len(), 2, "test requires two date segments");
    fs::OpenOptions::new()
        .append(true)
        .open(segments.remove(0))
        .expect("open old segment")
        .write_all(b"bad-json\n")
        .expect("corrupt old segment");

    let restored = TimelineStore::open(
        TimelineStoreOptions::new(&root, Some("session-old-corrupt"))
            .retention_days(14)
            .clock(clock),
    )
    .expect("old corrupt segment should be isolated");

    assert_eq!(
        event_types(&restored.tail(10).expect("tail after isolate").events),
        ["latest"]
    );
    assert_eq!(restored.retention().earliest_cursor, Some(latest.cursor));
    assert!(restored
        .read_forward(&old.cursor, 10)
        .expect_err("cursor in isolated segment is stale")
        .is_stale_cursor());
}

#[test]
fn append_flush_or_sync_failure_rolls_back_segment_and_reopen_does_not_see_failed_record() {
    for (label, failure) in [
        ("append", TimelineWriteFailure::Append),
        ("flush", TimelineWriteFailure::Flush),
        ("sync_data", TimelineWriteFailure::SyncData),
    ] {
        let clock = ManualClock::new(1_800_000_000_000);
        let root = timeline_root(&format!("failure-{label}"));
        let mut store = open_store_at(&root, Some(label), 14, clock.clone());
        let first = append_event(&mut store, "first");
        let segment_path = only_segment_path(&store);
        let segment_len_before = segment_len(&segment_path);

        store.inject_next_write_failure(failure);
        let error = store
            .append(TimelineAppend::new(
                "should-not-commit",
                label,
                json!({"failed": true}),
            ))
            .expect_err("injected failure should fail append");
        assert!(error.to_string().contains(label));

        assert_eq!(store.checkpoint().seq, first.seq);
        assert_eq!(store.checkpoint().cursor, first.cursor);
        assert_eq!(
            event_types(&store.tail(10).expect("tail after failure").events),
            ["first"]
        );
        assert_segment_rolled_back(&segment_path, segment_len_before);

        drop(store);
        let reopened = TimelineStore::open(
            TimelineStoreOptions::new(&root, Some(label))
                .retention_days(14)
                .clock(clock),
        )
        .expect("reopen after failed append");
        assert_eq!(reopened.checkpoint().seq, first.seq);
        assert_eq!(
            event_types(&reopened.tail(10).expect("reopened tail").events),
            ["first"]
        );
    }
}

#[test]
fn append_meta_write_failure_rolls_back_synced_segment_record_before_reopen() {
    let clock = ManualClock::new(1_800_000_000_000);
    let root = timeline_root("failure-meta-write");
    let mut store = open_store_at(&root, Some("meta-write"), 14, clock.clone());
    let first = append_event(&mut store, "first");
    let segment_path = only_segment_path(&store);
    let segment_len_before = segment_len(&segment_path);

    store.inject_next_write_failure(TimelineWriteFailure::MetaWrite);
    let error = store
        .append(TimelineAppend::new(
            "should-not-commit",
            "meta-write",
            json!({"failed": true}),
        ))
        .expect_err("injected meta write failure should fail append");
    assert!(error.to_string().contains("write_meta"));

    assert_eq!(store.checkpoint().seq, first.seq);
    assert_eq!(store.checkpoint().cursor, first.cursor);
    assert_eq!(
        event_types(&store.tail(10).expect("tail after meta failure").events),
        ["first"]
    );
    assert_segment_rolled_back(&segment_path, segment_len_before);

    drop(store);
    let reopened = TimelineStore::open(
        TimelineStoreOptions::new(&root, Some("meta-write"))
            .retention_days(14)
            .clock(clock),
    )
    .expect("reopen after failed meta write append");
    assert_eq!(reopened.checkpoint().seq, first.seq);
    assert_eq!(
        event_types(&reopened.tail(10).expect("reopened tail").events),
        ["first"]
    );
}

fn open_store(
    name: &str,
    session: Option<&str>,
    retention_days: u64,
    clock: ManualClock,
) -> TimelineStore {
    let root = timeline_root(name);
    open_store_at(&root, session, retention_days, clock)
}

fn open_store_at(
    root: &PathBuf,
    session: Option<&str>,
    retention_days: u64,
    clock: ManualClock,
) -> TimelineStore {
    TimelineStore::open(
        TimelineStoreOptions::new(root, session)
            .retention_days(retention_days)
            .hot_event_capacity(DEFAULT_TIMELINE_HOT_EVENT_CAPACITY)
            .clock(clock),
    )
    .expect("open timeline store")
}

fn append_event(store: &mut TimelineStore, event_type: &str) -> botified::TimelineEnvelope {
    store
        .append(TimelineAppend::new(
            event_type,
            "test-session",
            json!({"event_type": event_type}),
        ))
        .expect("append event")
}

fn manual_record(
    append_time_unix_ms: i64,
    instance: &str,
    seq: u64,
    event_type: &str,
    session_id: &str,
) -> TimelineStoreRecord {
    let cursor = EventCursor::for_instance(instance, seq).expect("manual cursor");
    let envelope = TimelineEnvelope::new(
        seq,
        cursor,
        format!("unix:{}", append_time_unix_ms.div_euclid(1000)),
        session_id,
        event_type,
        TimelineTrace::new(None),
        None,
        json!({"event_type": event_type}),
    )
    .expect("manual envelope");
    TimelineStoreRecord {
        append_time_unix_ms,
        envelope,
    }
}

fn write_record_line(path: &PathBuf, record: &TimelineStoreRecord) {
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("open segment for manual record");
    serde_json::to_writer(&mut file, record).expect("write manual record");
    file.write_all(b"\n").expect("newline manual record");
}

fn assert_segment_rolled_back(path: &PathBuf, expected_len: u64) {
    assert_eq!(segment_len(path), expected_len);
    assert!(
        !fs::read_to_string(path)
            .expect("read segment after rollback")
            .contains("should-not-commit"),
        "rolled back segment must not contain the failed record"
    );
}

fn segment_len(path: &PathBuf) -> u64 {
    fs::metadata(path).expect("segment metadata").len()
}

fn event_types(events: &[botified::TimelineEnvelope]) -> Vec<&str> {
    events
        .iter()
        .map(|event| event.event_type.as_str())
        .collect()
}

fn only_segment_path(store: &TimelineStore) -> PathBuf {
    let segments = sorted_segment_paths(store);
    assert_eq!(segments.len(), 1, "expected exactly one segment");
    segments.into_iter().next().expect("segment")
}

fn sorted_segment_paths(store: &TimelineStore) -> Vec<PathBuf> {
    let mut paths = fs::read_dir(store.timeline_dir().join("segments"))
        .expect("read segments dir")
        .map(|entry| entry.expect("segment entry").path())
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn timeline_root(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "botified-timeline-store-{name}-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}

#[derive(Debug, Clone)]
struct ManualClock {
    now_ms: Arc<Mutex<i64>>,
}

impl ManualClock {
    fn new(now_ms: i64) -> Self {
        Self {
            now_ms: Arc::new(Mutex::new(now_ms)),
        }
    }

    fn set(&self, now_ms: i64) {
        *self.now_ms.lock().expect("clock mutex") = now_ms;
    }
}

impl TimelineClock for ManualClock {
    fn now_unix_ms(&self) -> i64 {
        *self.now_ms.lock().expect("clock mutex")
    }
}
