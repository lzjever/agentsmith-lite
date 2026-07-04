use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::event::EventCursor;
use crate::session::encode_session_name;
use crate::timeline::{TimelineEnvelope, TimelineEnvelopeError, TimelineItem, TimelineTrace};

pub const DEFAULT_TIMELINE_RETENTION_DAYS: u64 = 14;
pub const DEFAULT_TIMELINE_HOT_EVENT_CAPACITY: usize = 1024;
pub const DEFAULT_TIMELINE_PAGE_LIMIT: usize = 200;
pub const MAX_TIMELINE_PAGE_LIMIT: usize = 1000;

const THREAD_LOCAL_SESSION_KEY: &str = "thread_local";
const META_FILE: &str = "meta.json";
const META_TMP_FILE: &str = "meta.json.tmp";
const SEGMENTS_DIR: &str = "segments";
const DAY_MS: i64 = 86_400_000;

#[derive(Clone)]
pub struct TimelineStoreOptions {
    data_dir: PathBuf,
    session: Option<String>,
    retention_days: u64,
    hot_event_capacity: usize,
    clock: Arc<dyn TimelineClock>,
}

impl TimelineStoreOptions {
    pub fn new(data_dir: impl Into<PathBuf>, session: Option<&str>) -> Self {
        Self {
            data_dir: data_dir.into(),
            session: session.map(ToOwned::to_owned),
            retention_days: DEFAULT_TIMELINE_RETENTION_DAYS,
            hot_event_capacity: DEFAULT_TIMELINE_HOT_EVENT_CAPACITY,
            clock: Arc::new(SystemTimelineClock),
        }
    }

    pub fn retention_days(mut self, retention_days: u64) -> Self {
        self.retention_days = retention_days;
        self
    }

    pub fn hot_event_capacity(mut self, hot_event_capacity: usize) -> Self {
        self.hot_event_capacity = hot_event_capacity;
        self
    }

    pub fn clock(mut self, clock: impl TimelineClock) -> Self {
        self.clock = Arc::new(clock);
        self
    }
}

pub trait TimelineClock: Send + Sync + 'static {
    fn now_unix_ms(&self) -> i64;
}

#[derive(Debug)]
struct SystemTimelineClock;

impl TimelineClock for SystemTimelineClock {
    fn now_unix_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TimelineAppend {
    pub time: Option<String>,
    pub session_id: String,
    pub event_type: String,
    pub trace: TimelineTrace,
    pub item: Option<TimelineItem>,
    pub data: Value,
}

impl TimelineAppend {
    pub fn new(event_type: impl Into<String>, session_id: impl Into<String>, data: Value) -> Self {
        Self {
            time: None,
            session_id: session_id.into(),
            event_type: event_type.into(),
            trace: TimelineTrace::new(None),
            item: None,
            data,
        }
    }

    pub fn with_time(mut self, time: impl Into<String>) -> Self {
        self.time = Some(time.into());
        self
    }

    pub fn with_trace(mut self, trace: TimelineTrace) -> Self {
        self.trace = trace;
        self
    }

    pub fn with_item(mut self, item: TimelineItem) -> Self {
        self.item = Some(item);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelineCheckpoint {
    pub seq: u64,
    pub cursor: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelineRetentionSnapshot {
    pub retention_days: u64,
    pub hot_event_capacity: usize,
    pub earliest_seq: Option<u64>,
    pub earliest_cursor: Option<String>,
    pub latest_seq: Option<u64>,
    pub latest_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TimelineForwardPage {
    pub events: Vec<TimelineEnvelope>,
    pub next_cursor: String,
    pub has_more_after: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TimelineHistoryPage {
    pub events: Vec<TimelineEnvelope>,
    pub page_start_cursor: String,
    pub page_end_cursor: String,
    pub next_cursor: String,
    pub has_more_before: bool,
    pub history_boundary: HistoryBoundary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryBoundary {
    None,
    Start,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelineWriteFailure {
    Append,
    Flush,
    SyncData,
    MetaWrite,
}

#[derive(Debug, Error)]
pub enum TimelineStoreError {
    #[error("timeline retention_days must be greater than 0")]
    InvalidRetentionDays,
    #[error("timeline limit must be greater than 0")]
    InvalidLimit,
    #[error("invalid timeline cursor")]
    InvalidCursor,
    #[error("stale timeline cursor")]
    StaleCursor,
    #[error("timeline envelope error: {0:?}")]
    Envelope(TimelineEnvelopeError),
    #[error("injected timeline {failure} failure")]
    InjectedWrite { failure: &'static str },
    #[error("timeline io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("timeline json error at {path}: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

impl TimelineStoreError {
    pub fn is_stale_cursor(&self) -> bool {
        matches!(self, Self::StaleCursor)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineStoreRecord {
    pub append_time_unix_ms: i64,
    pub envelope: TimelineEnvelope,
}

pub struct TimelineStore {
    timeline_dir: PathBuf,
    segments_dir: PathBuf,
    meta_path: PathBuf,
    instance: String,
    latest_seq: u64,
    last_append_time_unix_ms: i64,
    retention_days: u64,
    hot_event_capacity: usize,
    hot_cache: VecDeque<TimelineStoreRecord>,
    isolated_segments: HashSet<String>,
    clock: Arc<dyn TimelineClock>,
    next_write_failure: Option<TimelineWriteFailure>,
}

impl TimelineStore {
    pub fn open(options: TimelineStoreOptions) -> Result<Self, TimelineStoreError> {
        if options.retention_days == 0 {
            return Err(TimelineStoreError::InvalidRetentionDays);
        }
        let hot_event_capacity = options.hot_event_capacity.max(1);
        let session_key = timeline_session_key(options.session.as_deref());
        let timeline_dir = options
            .data_dir
            .join("timelines")
            .join(session_key.as_str());
        let segments_dir = timeline_dir.join(SEGMENTS_DIR);
        let meta_path = timeline_dir.join(META_FILE);
        fs::create_dir_all(&segments_dir).map_err(|source| TimelineStoreError::Io {
            path: segments_dir.clone(),
            source,
        })?;

        let meta = read_meta(&meta_path)?;
        let scan = scan_segments(&segments_dir, true)?;
        let instance = choose_instance(meta.as_ref(), &scan.records);
        let mut records = scan
            .records
            .into_iter()
            .filter(|record| record_instance(&record.envelope).as_deref() == Some(&instance))
            .collect::<Vec<_>>();
        records.sort_by_key(|record| record.envelope.seq);

        let latest_seq = records
            .iter()
            .map(|record| record.envelope.seq)
            .max()
            .unwrap_or(0);
        let last_append_time_unix_ms = meta
            .as_ref()
            .filter(|meta| meta.instance == instance)
            .map(|meta| meta.last_append_time_unix_ms)
            .unwrap_or(0)
            .max(
                records
                    .iter()
                    .map(|record| record.append_time_unix_ms)
                    .max()
                    .unwrap_or(0),
            );

        let mut store = Self {
            timeline_dir,
            segments_dir,
            meta_path,
            instance,
            latest_seq,
            last_append_time_unix_ms,
            retention_days: options.retention_days,
            hot_event_capacity,
            hot_cache: VecDeque::new(),
            isolated_segments: scan.isolated_segments,
            clock: options.clock,
            next_write_failure: None,
        };
        store.prune_expired_segments()?;
        store.rebuild_hot_cache(&records);
        store.write_meta()?;
        Ok(store)
    }

    pub fn timeline_dir(&self) -> &Path {
        &self.timeline_dir
    }

    pub fn instance(&self) -> &str {
        &self.instance
    }

    pub fn checkpoint(&self) -> TimelineCheckpoint {
        TimelineCheckpoint {
            seq: self.latest_seq,
            cursor: self.cursor_for_seq(self.latest_seq),
        }
    }

    pub fn retention(&self) -> TimelineRetentionSnapshot {
        let records = self.retained_records().unwrap_or_default();
        retained_snapshot(
            self.retention_days,
            self.hot_event_capacity,
            records.as_slice(),
        )
    }

    pub fn append(
        &mut self,
        append: TimelineAppend,
    ) -> Result<TimelineEnvelope, TimelineStoreError> {
        let previous_latest_seq = self.latest_seq;
        let previous_last_append_time = self.last_append_time_unix_ms;
        let previous_hot_cache = self.hot_cache.clone();

        let now = self.clock.now_unix_ms();
        let append_time_unix_ms = now.max(self.last_append_time_unix_ms);
        let seq = self.latest_seq + 1;
        let cursor = EventCursor::for_instance(self.instance.clone(), seq)
            .map_err(|_| TimelineStoreError::InvalidCursor)?;
        let envelope = TimelineEnvelope::new(
            seq,
            cursor,
            append
                .time
                .unwrap_or_else(|| format!("unix:{}", append_time_unix_ms.div_euclid(1000))),
            append.session_id,
            append.event_type,
            append.trace,
            append.item,
            append.data,
        )
        .map_err(TimelineStoreError::Envelope)?;
        let record = TimelineStoreRecord {
            append_time_unix_ms,
            envelope: envelope.clone(),
        };
        let segment_path = self.segment_path_for_append_time(append_time_unix_ms);

        let append_result = self.append_record_to_segment(&segment_path, &record);
        if append_result.is_err() {
            self.latest_seq = previous_latest_seq;
            self.last_append_time_unix_ms = previous_last_append_time;
            self.hot_cache = previous_hot_cache;
            return append_result.map(|_| envelope);
        }

        self.latest_seq = seq;
        self.last_append_time_unix_ms = append_time_unix_ms;
        self.push_hot_cache(record);
        if let Err(error) = self
            .prune_expired_segments()
            .and_then(|_| self.write_meta())
        {
            let rollback_result = truncate_last_record(&segment_path);
            self.latest_seq = previous_latest_seq;
            self.last_append_time_unix_ms = previous_last_append_time;
            self.hot_cache = previous_hot_cache;
            if let Err(rollback) = rollback_result {
                return Err(append_rollback_error(&segment_path, error, rollback));
            }
            return Err(error);
        }

        Ok(envelope)
    }

    pub fn tail(&self, limit: usize) -> Result<TimelineHistoryPage, TimelineStoreError> {
        validate_limit(limit)?;
        let records = self.retained_records()?;
        let checkpoint = self.checkpoint();
        if records.is_empty() {
            return Ok(TimelineHistoryPage {
                events: Vec::new(),
                page_start_cursor: checkpoint.cursor.clone(),
                page_end_cursor: checkpoint.cursor.clone(),
                next_cursor: checkpoint.cursor,
                has_more_before: false,
                history_boundary: if self.latest_seq == 0 {
                    HistoryBoundary::Start
                } else {
                    HistoryBoundary::Expired
                },
            });
        }

        let start = records.len().saturating_sub(limit);
        let page = records[start..].to_vec();
        let has_more_before = start > 0;
        let history_boundary = history_boundary_for_page(has_more_before, records[0].envelope.seq);
        Ok(TimelineHistoryPage {
            page_start_cursor: page
                .first()
                .map(|record| record.envelope.cursor.clone())
                .unwrap_or_else(|| checkpoint.cursor.clone()),
            page_end_cursor: page
                .last()
                .map(|record| record.envelope.cursor.clone())
                .unwrap_or_else(|| checkpoint.cursor.clone()),
            next_cursor: checkpoint.cursor,
            has_more_before,
            history_boundary,
            events: page.into_iter().map(|record| record.envelope).collect(),
        })
    }

    pub fn read_forward(
        &self,
        cursor: &str,
        limit: usize,
    ) -> Result<TimelineForwardPage, TimelineStoreError> {
        validate_limit(limit)?;
        let cursor_seq = self.parse_boundary_cursor(cursor)?;
        let records = self.retained_records()?;
        self.validate_forward_boundary(cursor_seq, &records)?;

        let events = records
            .iter()
            .filter(|record| record.envelope.seq > cursor_seq)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let next_cursor = events
            .last()
            .map(|record| record.envelope.cursor.clone())
            .unwrap_or_else(|| cursor.to_owned());
        let next_seq = events
            .last()
            .map(|record| record.envelope.seq)
            .unwrap_or(cursor_seq);
        let has_more_after = records.iter().any(|record| record.envelope.seq > next_seq);

        Ok(TimelineForwardPage {
            events: events.into_iter().map(|record| record.envelope).collect(),
            next_cursor,
            has_more_after,
        })
    }

    pub fn read_backward(
        &self,
        cursor: &str,
        limit: usize,
    ) -> Result<TimelineHistoryPage, TimelineStoreError> {
        validate_limit(limit)?;
        let cursor_seq = self.parse_boundary_cursor(cursor)?;
        let records = self.retained_records()?;
        self.validate_backward_boundary(cursor_seq, &records)?;

        let before = records
            .iter()
            .filter(|record| record.envelope.seq < cursor_seq)
            .cloned()
            .collect::<Vec<_>>();
        let start = before.len().saturating_sub(limit);
        let page = before[start..].to_vec();
        let has_more_before = start > 0;
        let history_boundary = if page.is_empty() {
            history_boundary_for_empty_page(
                records.first().map(|record| record.envelope.seq),
                self.latest_seq,
            )
        } else {
            history_boundary_for_page(has_more_before, records[0].envelope.seq)
        };

        Ok(TimelineHistoryPage {
            page_start_cursor: page
                .first()
                .map(|record| record.envelope.cursor.clone())
                .unwrap_or_else(|| cursor.to_owned()),
            page_end_cursor: page
                .last()
                .map(|record| record.envelope.cursor.clone())
                .unwrap_or_else(|| cursor.to_owned()),
            next_cursor: self.checkpoint().cursor,
            has_more_before,
            history_boundary,
            events: page.into_iter().map(|record| record.envelope).collect(),
        })
    }

    #[doc(hidden)]
    pub fn inject_next_write_failure(&mut self, failure: TimelineWriteFailure) {
        self.next_write_failure = Some(failure);
    }

    fn parse_boundary_cursor(&self, cursor: &str) -> Result<u64, TimelineStoreError> {
        let parsed =
            EventCursor::parse_timeline(cursor).map_err(|_| TimelineStoreError::InvalidCursor)?;
        match parsed {
            EventCursor::Global { instance, seq } if instance == self.instance => Ok(seq),
            EventCursor::Global { .. } | EventCursor::Message { .. } => {
                Err(TimelineStoreError::StaleCursor)
            }
        }
    }

    fn validate_forward_boundary(
        &self,
        seq: u64,
        records: &[TimelineStoreRecord],
    ) -> Result<(), TimelineStoreError> {
        if seq > self.latest_seq {
            return Err(TimelineStoreError::StaleCursor);
        }
        if seq == self.latest_seq || (self.latest_seq == 0 && seq == 0) {
            return Ok(());
        }
        let Some(first) = records.first() else {
            return Err(TimelineStoreError::StaleCursor);
        };
        if seq == 0 {
            return if first.envelope.seq == 1 {
                Ok(())
            } else {
                Err(TimelineStoreError::StaleCursor)
            };
        }
        if seq < first.envelope.seq {
            return Err(TimelineStoreError::StaleCursor);
        }
        if records.iter().any(|record| record.envelope.seq == seq) {
            Ok(())
        } else {
            Err(TimelineStoreError::StaleCursor)
        }
    }

    fn validate_backward_boundary(
        &self,
        seq: u64,
        records: &[TimelineStoreRecord],
    ) -> Result<(), TimelineStoreError> {
        if seq > self.latest_seq {
            return Err(TimelineStoreError::StaleCursor);
        }
        if seq == self.latest_seq {
            return Ok(());
        }
        let Some(first) = records.first() else {
            return Err(TimelineStoreError::StaleCursor);
        };
        if seq < first.envelope.seq {
            return Err(TimelineStoreError::StaleCursor);
        }
        if records.iter().any(|record| record.envelope.seq == seq) {
            Ok(())
        } else {
            Err(TimelineStoreError::StaleCursor)
        }
    }

    fn retained_records(&self) -> Result<Vec<TimelineStoreRecord>, TimelineStoreError> {
        let cutoff = self.retention_cutoff_unix_ms();
        let mut records = self
            .read_all_records()?
            .into_iter()
            .filter(|record| record.append_time_unix_ms >= cutoff)
            .filter(|record| record_instance(&record.envelope).as_deref() == Some(&self.instance))
            .collect::<Vec<_>>();
        records.sort_by_key(|record| record.envelope.seq);
        Ok(records)
    }

    fn read_all_records(&self) -> Result<Vec<TimelineStoreRecord>, TimelineStoreError> {
        let mut records = Vec::new();
        for path in segment_paths(&self.segments_dir)? {
            let Some(file_name) = file_name_string(&path) else {
                continue;
            };
            if self.isolated_segments.contains(&file_name) {
                continue;
            }
            let parsed = read_segment_records(&path, false, false)?;
            records.extend(parsed.records);
        }
        Ok(records)
    }

    fn append_record_to_segment(
        &mut self,
        path: &Path,
        record: &TimelineStoreRecord,
    ) -> Result<(), TimelineStoreError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|source| TimelineStoreError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let (mut file, created_file) = match OpenOptions::new()
            .create_new(true)
            .read(true)
            .append(true)
            .open(path)
        {
            Ok(file) => (file, true),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let file = OpenOptions::new()
                    .read(true)
                    .append(true)
                    .open(path)
                    .map_err(|source| TimelineStoreError::Io {
                        path: path.to_path_buf(),
                        source,
                    })?;
                (file, false)
            }
            Err(source) => {
                return Err(TimelineStoreError::Io {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };
        let old_len = file
            .seek(SeekFrom::End(0))
            .map_err(|source| TimelineStoreError::Io {
                path: path.to_path_buf(),
                source,
            })?;
        if self.take_write_failure(TimelineWriteFailure::Append)? {
            return Err(rollback_append_error(
                path,
                old_len,
                TimelineStoreError::InjectedWrite { failure: "append" },
            ));
        }
        if let Err(source) = serde_json::to_writer(&mut file, record) {
            return Err(rollback_append_error(
                path,
                old_len,
                TimelineStoreError::Json {
                    path: path.to_path_buf(),
                    source,
                },
            ));
        }
        if let Err(source) = file.write_all(b"\n") {
            return Err(rollback_append_error(
                path,
                old_len,
                TimelineStoreError::Io {
                    path: path.to_path_buf(),
                    source,
                },
            ));
        }
        if self.take_write_failure(TimelineWriteFailure::Flush)? {
            return Err(rollback_append_error(
                path,
                old_len,
                TimelineStoreError::InjectedWrite { failure: "flush" },
            ));
        }
        if let Err(source) = file.flush() {
            return Err(rollback_append_error(
                path,
                old_len,
                TimelineStoreError::Io {
                    path: path.to_path_buf(),
                    source,
                },
            ));
        }
        if self.take_write_failure(TimelineWriteFailure::SyncData)? {
            return Err(rollback_append_error(
                path,
                old_len,
                TimelineStoreError::InjectedWrite {
                    failure: "sync_data",
                },
            ));
        }
        if let Err(source) = file.sync_data() {
            return Err(rollback_append_error(
                path,
                old_len,
                TimelineStoreError::Io {
                    path: path.to_path_buf(),
                    source,
                },
            ));
        }
        if created_file {
            let parent = path.parent().unwrap_or_else(|| Path::new("."));
            sync_dir(parent).map_err(|source| {
                rollback_append_error(
                    path,
                    old_len,
                    TimelineStoreError::Io {
                        path: parent.to_path_buf(),
                        source,
                    },
                )
            })?;
        }
        Ok(())
    }

    fn take_write_failure(
        &mut self,
        expected: TimelineWriteFailure,
    ) -> Result<bool, TimelineStoreError> {
        if self.next_write_failure == Some(expected) {
            self.next_write_failure = None;
            return Ok(true);
        }
        if self.next_write_failure.is_some() {
            return Ok(false);
        }
        Ok(false)
    }

    fn segment_path_for_append_time(&self, append_time_unix_ms: i64) -> PathBuf {
        self.segments_dir
            .join(format!("{}.jsonl", utc_date_string(append_time_unix_ms)))
    }

    fn cursor_for_seq(&self, seq: u64) -> String {
        EventCursor::for_instance(self.instance.clone(), seq)
            .expect("timeline store instance should be valid")
            .to_string()
    }

    fn retention_cutoff_unix_ms(&self) -> i64 {
        let window_ms = self.retention_days.min((i64::MAX / DAY_MS) as u64) as i64 * DAY_MS;
        self.clock.now_unix_ms().saturating_sub(window_ms)
    }

    fn rebuild_hot_cache(&mut self, records: &[TimelineStoreRecord]) {
        let cutoff = self.retention_cutoff_unix_ms();
        let instance = self.instance.clone();
        self.hot_cache.clear();
        let retained = records
            .iter()
            .filter(|record| record.append_time_unix_ms >= cutoff)
            .filter(|record| {
                record_instance(&record.envelope).as_deref() == Some(instance.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        for record in retained {
            self.push_hot_cache(record);
        }
    }

    fn push_hot_cache(&mut self, record: TimelineStoreRecord) {
        self.hot_cache.push_back(record);
        while self.hot_cache.len() > self.hot_event_capacity {
            self.hot_cache.pop_front();
        }
    }

    fn prune_expired_segments(&mut self) -> Result<(), TimelineStoreError> {
        let cutoff = self.retention_cutoff_unix_ms();
        let paths = segment_paths(&self.segments_dir)?;
        for path in paths {
            let parsed = read_segment_records(&path, false, false)?;
            if parsed.records.is_empty() {
                continue;
            }
            let latest_append_time = parsed
                .records
                .iter()
                .map(|record| record.append_time_unix_ms)
                .max()
                .unwrap_or(i64::MAX);
            if latest_append_time < cutoff {
                fs::remove_file(&path).map_err(|source| TimelineStoreError::Io {
                    path: path.clone(),
                    source,
                })?;
            }
        }
        Ok(())
    }

    fn write_meta(&mut self) -> Result<(), TimelineStoreError> {
        if self.take_write_failure(TimelineWriteFailure::MetaWrite)? {
            return Err(TimelineStoreError::InjectedWrite {
                failure: "write_meta",
            });
        }
        let retention = self.retention();
        let meta = TimelineStoreMeta {
            version: 1,
            instance: self.instance.clone(),
            latest_seq: self.latest_seq,
            latest_cursor: self.cursor_for_seq(self.latest_seq),
            last_append_time_unix_ms: self.last_append_time_unix_ms,
            earliest_seq: retention.earliest_seq,
            earliest_cursor: retention.earliest_cursor,
            latest_retained_seq: retention.latest_seq,
            latest_retained_cursor: retention.latest_cursor,
        };
        let bytes =
            serde_json::to_vec_pretty(&meta).map_err(|source| TimelineStoreError::Json {
                path: self.meta_path.clone(),
                source,
            })?;
        write_meta_atomic(&self.meta_path, &bytes)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TimelineStoreMeta {
    version: u32,
    instance: String,
    latest_seq: u64,
    latest_cursor: String,
    #[serde(default)]
    last_append_time_unix_ms: i64,
    #[serde(default)]
    earliest_seq: Option<u64>,
    #[serde(default)]
    earliest_cursor: Option<String>,
    #[serde(default)]
    latest_retained_seq: Option<u64>,
    #[serde(default)]
    latest_retained_cursor: Option<String>,
}

#[derive(Debug)]
struct SegmentScan {
    records: Vec<TimelineStoreRecord>,
    isolated_segments: HashSet<String>,
}

#[derive(Debug)]
struct SegmentRead {
    records: Vec<TimelineStoreRecord>,
    isolated: bool,
}

fn read_meta(path: &Path) -> Result<Option<TimelineStoreMeta>, TimelineStoreError> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(meta) if valid_meta(&meta) => Ok(Some(meta)),
            Ok(_) | Err(_) => {
                isolate_corrupt_meta(path);
                Ok(None)
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn valid_meta(meta: &TimelineStoreMeta) -> bool {
    meta.version == 1
        && EventCursor::for_instance(meta.instance.clone(), meta.latest_seq)
            .map(|cursor| cursor.to_string() == meta.latest_cursor)
            .unwrap_or(false)
        && optional_meta_cursor_matches(
            &meta.instance,
            meta.earliest_seq,
            meta.earliest_cursor.as_ref(),
        )
        && optional_meta_cursor_matches(
            &meta.instance,
            meta.latest_retained_seq,
            meta.latest_retained_cursor.as_ref(),
        )
}

fn optional_meta_cursor_matches(instance: &str, seq: Option<u64>, cursor: Option<&String>) -> bool {
    match (seq, cursor) {
        (None, None) => true,
        (Some(seq), Some(cursor)) => EventCursor::parse_timeline(cursor)
            .map(|parsed| {
                parsed.seq() == seq
                    && parsed
                        .instance()
                        .map(|value| value == instance)
                        .unwrap_or(false)
            })
            .unwrap_or(false),
        _ => false,
    }
}

fn write_meta_atomic(path: &Path, bytes: &[u8]) -> Result<(), TimelineStoreError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|source| TimelineStoreError::Io {
        path: parent.to_path_buf(),
        source,
    })?;

    let tmp_path = parent.join(META_TMP_FILE);
    remove_file_if_exists(&tmp_path)?;
    if let Err(error) = write_meta_tmp(&tmp_path, path, bytes) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    fs::rename(&tmp_path, path).map_err(|source| {
        let _ = fs::remove_file(&tmp_path);
        TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        }
    })?;
    sync_dir(parent).map_err(|source| TimelineStoreError::Io {
        path: parent.to_path_buf(),
        source,
    })?;
    Ok(())
}

fn write_meta_tmp(
    tmp_path: &Path,
    target_path: &Path,
    bytes: &[u8],
) -> Result<(), TimelineStoreError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(tmp_path)
        .map_err(|source| TimelineStoreError::Io {
            path: tmp_path.to_path_buf(),
            source,
        })?;
    file.write_all(bytes)
        .map_err(|source| TimelineStoreError::Io {
            path: target_path.to_path_buf(),
            source,
        })?;
    file.flush().map_err(|source| TimelineStoreError::Io {
        path: target_path.to_path_buf(),
        source,
    })?;
    file.sync_data().map_err(|source| TimelineStoreError::Io {
        path: target_path.to_path_buf(),
        source,
    })?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<(), TimelineStoreError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn isolate_corrupt_meta(path: &Path) {
    let Some(parent) = path.parent() else {
        return;
    };
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let isolated_path = parent.join(format!(
        "{file_name}.corrupt.{}.{}",
        std::process::id(),
        stamp
    ));
    if fs::rename(path, &isolated_path).is_ok() {
        let _ = sync_dir(parent);
    }
}

fn sync_dir(path: &Path) -> io::Result<()> {
    match File::open(path).and_then(|file| file.sync_all()) {
        Ok(()) => Ok(()),
        Err(error) if is_unsupported_dir_sync(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

fn is_unsupported_dir_sync(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::Unsupported)
        || error.raw_os_error() == Some(22)
        || error.raw_os_error() == Some(45)
        || error.raw_os_error() == Some(95)
        || cfg!(windows) && matches!(error.kind(), io::ErrorKind::PermissionDenied)
}

fn scan_segments(
    segments_dir: &Path,
    repair_latest: bool,
) -> Result<SegmentScan, TimelineStoreError> {
    let paths = segment_paths(segments_dir)?;
    let latest_path = paths.last().cloned();
    let mut records = Vec::new();
    let mut isolated_segments = HashSet::new();
    for path in paths {
        let is_latest = Some(&path) == latest_path.as_ref();
        let read = read_segment_records(&path, is_latest, repair_latest)?;
        if read.isolated {
            if let Some(file_name) = file_name_string(&path) {
                isolated_segments.insert(file_name);
            }
        } else {
            records.extend(read.records);
        }
    }
    Ok(SegmentScan {
        records,
        isolated_segments,
    })
}

fn read_segment_records(
    path: &Path,
    is_latest: bool,
    repair_latest: bool,
) -> Result<SegmentRead, TimelineStoreError> {
    let file = File::open(path).map_err(|source| TimelineStoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut reader = BufReader::new(file);
    let mut records = Vec::new();
    let mut offset = 0_u64;

    loop {
        let line_start = offset;
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|source| TimelineStoreError::Io {
                path: path.to_path_buf(),
                source,
            })?;
        if read == 0 {
            break;
        }
        offset += read as u64;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<TimelineStoreRecord>(&line)
            .ok()
            .filter(valid_record)
        {
            Some(record) => records.push(record),
            None if is_latest && repair_latest => {
                drop(reader);
                OpenOptions::new()
                    .write(true)
                    .open(path)
                    .and_then(|file| file.set_len(line_start))
                    .map_err(|source| TimelineStoreError::Io {
                        path: path.to_path_buf(),
                        source,
                    })?;
                break;
            }
            None => {
                return Ok(SegmentRead {
                    records: Vec::new(),
                    isolated: true,
                });
            }
        }
    }

    Ok(SegmentRead {
        records,
        isolated: false,
    })
}

fn valid_record(record: &TimelineStoreRecord) -> bool {
    if record.envelope.version != crate::timeline::TIMELINE_VERSION {
        return false;
    }
    EventCursor::parse_timeline(&record.envelope.cursor)
        .map(|cursor| cursor.seq() == record.envelope.seq)
        .unwrap_or(false)
}

fn choose_instance(meta: Option<&TimelineStoreMeta>, records: &[TimelineStoreRecord]) -> String {
    if let Some(meta) = meta {
        if EventCursor::for_instance(meta.instance.clone(), meta.latest_seq).is_ok() {
            return meta.instance.clone();
        }
    }

    let mut by_instance: HashMap<String, (u64, i64)> = HashMap::new();
    for record in records {
        let Some(instance) = record_instance(&record.envelope) else {
            continue;
        };
        let entry = by_instance.entry(instance).or_insert((0, i64::MIN));
        if record.envelope.seq > entry.0
            || (record.envelope.seq == entry.0 && record.append_time_unix_ms > entry.1)
        {
            *entry = (record.envelope.seq, record.append_time_unix_ms);
        }
    }
    by_instance
        .into_iter()
        .max_by(|(_, left), (_, right)| left.cmp(right))
        .map(|(instance, _)| instance)
        .unwrap_or_else(generate_timeline_instance)
}

fn record_instance(envelope: &TimelineEnvelope) -> Option<String> {
    EventCursor::parse_timeline(&envelope.cursor)
        .ok()
        .and_then(|cursor| cursor.instance().map(ToOwned::to_owned))
}

fn retained_snapshot(
    retention_days: u64,
    hot_event_capacity: usize,
    records: &[TimelineStoreRecord],
) -> TimelineRetentionSnapshot {
    TimelineRetentionSnapshot {
        retention_days,
        hot_event_capacity,
        earliest_seq: records.first().map(|record| record.envelope.seq),
        earliest_cursor: records.first().map(|record| record.envelope.cursor.clone()),
        latest_seq: records.last().map(|record| record.envelope.seq),
        latest_cursor: records.last().map(|record| record.envelope.cursor.clone()),
    }
}

fn history_boundary_for_page(has_more_before: bool, earliest_seq: u64) -> HistoryBoundary {
    if has_more_before {
        HistoryBoundary::None
    } else {
        history_boundary_at_retained_start(Some(earliest_seq))
    }
}

fn history_boundary_at_retained_start(earliest_seq: Option<u64>) -> HistoryBoundary {
    match earliest_seq {
        Some(1) | None => HistoryBoundary::Start,
        Some(_) => HistoryBoundary::Expired,
    }
}

fn history_boundary_for_empty_page(earliest_seq: Option<u64>, latest_seq: u64) -> HistoryBoundary {
    match earliest_seq {
        Some(seq) => history_boundary_at_retained_start(Some(seq)),
        None if latest_seq == 0 => HistoryBoundary::Start,
        None => HistoryBoundary::Expired,
    }
}

fn validate_limit(limit: usize) -> Result<(), TimelineStoreError> {
    if limit == 0 {
        Err(TimelineStoreError::InvalidLimit)
    } else {
        Ok(())
    }
}

fn segment_paths(segments_dir: &Path) -> Result<Vec<PathBuf>, TimelineStoreError> {
    let mut paths = Vec::new();
    match fs::read_dir(segments_dir) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|source| TimelineStoreError::Io {
                    path: segments_dir.to_path_buf(),
                    source,
                })?;
                let path = entry.path();
                if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
                    paths.push(path);
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(paths),
        Err(source) => {
            return Err(TimelineStoreError::Io {
                path: segments_dir.to_path_buf(),
                source,
            });
        }
    }
    paths.sort();
    Ok(paths)
}

fn timeline_session_key(session: Option<&str>) -> String {
    match session {
        Some(session) => encode_session_name(session),
        None => THREAD_LOCAL_SESSION_KEY.to_owned(),
    }
}

fn generate_timeline_instance() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("t{timestamp:x}{:x}{counter:x}", std::process::id())
}

fn utc_date_string(unix_ms: i64) -> String {
    let days = unix_ms.div_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year as i32, month as u32, day as u32)
}

fn rollback_append_error(
    path: &Path,
    old_len: u64,
    original: TimelineStoreError,
) -> TimelineStoreError {
    match rollback_file_len(path, old_len) {
        Ok(()) => original,
        Err(rollback) => append_rollback_error(path, original, rollback),
    }
}

fn rollback_file_len(path: &Path, old_len: u64) -> Result<(), TimelineStoreError> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|source| TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    truncate_file_len(&mut file, path, old_len)
}

fn truncate_file_len(file: &mut File, path: &Path, len: u64) -> Result<(), TimelineStoreError> {
    file.set_len(len)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_data())
        .map_err(|source| TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    if let Some(parent) = path.parent() {
        sync_dir(parent).map_err(|source| TimelineStoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    Ok(())
}

fn append_rollback_error(
    path: &Path,
    original: TimelineStoreError,
    rollback: TimelineStoreError,
) -> TimelineStoreError {
    TimelineStoreError::Io {
        path: path.to_path_buf(),
        source: io::Error::other(
            format!(
                "timeline append rollback failed; original error: {original}; rollback error: {rollback}"
            ),
        ),
    }
}

fn truncate_last_record(path: &Path) -> Result<(), TimelineStoreError> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|source| TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    let mut reader = BufReader::new(&file);
    let mut offset = 0_u64;
    let mut last_start = 0_u64;
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|source| TimelineStoreError::Io {
                path: path.to_path_buf(),
                source,
            })?;
        if read == 0 {
            break;
        }
        last_start = offset;
        offset += read as u64;
    }
    drop(reader);
    truncate_file_len(&mut file, path, last_start)
}

fn file_name_string(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|file_name| file_name.to_str())
        .map(ToOwned::to_owned)
}
