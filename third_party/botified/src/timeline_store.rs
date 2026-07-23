use std::collections::{HashMap, HashSet, VecDeque};
#[cfg(test)]
use std::fs::OpenOptions;
use std::fs::{self, File};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::event::EventCursor;
use crate::formatting::utc_date_string_from_unix_ms;
use crate::private_fs::{
    ensure_private_dir, ensure_private_dir_with_legacy_tree, open_private_file,
    private_open_options,
};
use crate::session::encode_session_name;
use crate::timeline::{TimelineEnvelope, TimelineEnvelopeError, TimelineItem, TimelineTrace};

mod meta;
mod page;
mod retention;
mod segments;
mod startup;

use meta::{read_meta, write_meta_atomic, MetaRead, TimelineStoreMeta, META_FILE};
use retention::{retained_snapshot, BoundaryCache, BoundaryEntry, RetainedBounds};
use segments::*;
use startup::{
    build_startup_indexes, choose_instance_from_summaries, detach_active_timeline,
    summarize_segments,
};

pub const DEFAULT_TIMELINE_RETENTION_DAYS: u64 = 14;
pub const DEFAULT_TIMELINE_HOT_EVENT_CAPACITY: usize = 1024;
pub const DEFAULT_TIMELINE_PAGE_LIMIT: usize = 200;
pub const MAX_TIMELINE_PAGE_LIMIT: usize = 1000;

const THREAD_LOCAL_SESSION_KEY: &str = "thread_local";
const DAY_MS: i64 = 86_400_000;
// Preserve monotonic appends across ordinary clock corrections without letting a
// bad cross-day timestamp pin daily timeline segments after the clock recovers.
const MAX_APPEND_CLOCK_SKEW_MS: i64 = 60 * 60 * 1_000;
const RECOVERY_EVENT_TYPE: &str = "timeline.recovered";

fn append_time_with_clock_skew_clamp(now_unix_ms: i64, last_append_time_unix_ms: i64) -> i64 {
    if last_append_time_unix_ms > now_unix_ms.saturating_add(MAX_APPEND_CLOCK_SKEW_MS) {
        now_unix_ms
    } else {
        now_unix_ms.max(last_append_time_unix_ms)
    }
}

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
    NewSegmentDirSync,
    MetaWrite,
    PostPruneMetaWrite,
    Rollback,
    PruneUnlink,
    PruneDirSync,
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

    fn is_invalid_data_io(&self) -> bool {
        matches!(self, Self::Io { source, .. } if source.kind() == io::ErrorKind::InvalidData)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineStoreRecord {
    pub append_time_unix_ms: i64,
    pub envelope: TimelineEnvelope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RecoveryRange {
    start: u64,
    end: u64,
    append_time_unix_ms: i64,
}

pub struct TimelineStore {
    timeline_dir: PathBuf,
    segments_dir: PathBuf,
    meta_path: PathBuf,
    instance: Arc<str>,
    latest_seq: u64,
    last_append_time_unix_ms: i64,
    retention_days: u64,
    hot_event_capacity: usize,
    hot_cache: VecDeque<TimelineStoreRecord>,
    segments: Arc<Vec<Arc<SegmentMetadata>>>,
    physical_segment_max_append_times: HashMap<PathBuf, i64>,
    boundary_cache: Option<BoundaryCache>,
    retained_bounds: RetainedBounds,
    recovery_ranges: Arc<Vec<RecoveryRange>>,
    callback_projection_ids: HashMap<String, PathBuf>,
    current_segment: Option<PhysicalSegment>,
    clock: Arc<dyn TimelineClock>,
    write_failures: VecDeque<TimelineWriteFailure>,
    write_poisoned: bool,
    meta_dirty: bool,
    meta_current: bool,
    meta_dirty_after_prune: bool,
    prune_dir_sync_pending: Option<PathBuf>,
    #[cfg(test)]
    boundary_segment_loads: usize,
    #[cfg(test)]
    segment_reads: Arc<AtomicUsize>,
    #[cfg(test)]
    read_record_count: Arc<AtomicUsize>,
    #[cfg(test)]
    segment_state_observer: Option<Arc<dyn Fn() + Send + Sync>>,
    #[cfg(test)]
    segment_read_observer: Option<Arc<dyn Fn() + Send + Sync>>,
}

struct PreparedSegmentAppend {
    path: PathBuf,
    file: File,
    created_file: bool,
    old_len: u64,
    record_end: u64,
    bytes: Vec<u8>,
    read_handle: Option<Arc<File>>,
}

pub(crate) struct TimelineReadSnapshot {
    instance: Arc<str>,
    latest_seq: u64,
    cutoff_unix_ms: i64,
    retention_days: u64,
    hot_event_capacity: usize,
    retained_bounds: RetainedBounds,
    recovery_ranges: Arc<Vec<RecoveryRange>>,
    segments: Arc<Vec<Arc<SegmentMetadata>>>,
    #[cfg(test)]
    segment_reads: Arc<AtomicUsize>,
    #[cfg(test)]
    read_record_count: Arc<AtomicUsize>,
    #[cfg(test)]
    segment_state_observer: Option<Arc<dyn Fn() + Send + Sync>>,
    #[cfg(test)]
    segment_read_observer: Option<Arc<dyn Fn() + Send + Sync>>,
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
        let timelines_dir = options.data_dir.join("timelines");
        for path in [options.data_dir.as_path(), timelines_dir.as_path()] {
            ensure_private_dir(path).map_err(|source| TimelineStoreError::Io {
                path: path.to_path_buf(),
                source,
            })?;
        }
        let timeline_existed = timeline_dir.exists();
        ensure_private_dir_with_legacy_tree(&timeline_dir).map_err(|source| {
            TimelineStoreError::Io {
                path: timeline_dir.clone(),
                source,
            }
        })?;
        ensure_private_dir(&segments_dir).map_err(|source| TimelineStoreError::Io {
            path: segments_dir.clone(),
            source,
        })?;
        if !timeline_existed {
            sync_dir(&segments_dir).map_err(|source| TimelineStoreError::Io {
                path: segments_dir.clone(),
                source,
            })?;
            sync_dir(&timeline_dir).map_err(|source| TimelineStoreError::Io {
                path: timeline_dir.clone(),
                source,
            })?;
        }
        cleanup_recovery_temps(&timeline_dir, &segments_dir);

        let mut detached = !timeline_existed;
        let (meta_read, scan, identity) = loop {
            if let Err(error) = migrate_legacy_segments(&segments_dir) {
                if !error.is_invalid_data_io() {
                    return Err(error);
                }
                detach_active_timeline(&timeline_dir)?;
                create_fresh_timeline_dirs(&timeline_dir, &segments_dir)?;
                detached = true;
                continue;
            }
            let meta_read = read_meta(&meta_path)?;
            let scan = match summarize_segments(&segments_dir, true) {
                Ok(scan) => scan,
                Err(error) if error.is_invalid_data_io() => {
                    detach_active_timeline(&timeline_dir)?;
                    create_fresh_timeline_dirs(&timeline_dir, &segments_dir)?;
                    detached = true;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if let Some(identity) = choose_instance_from_summaries(&meta_read, &scan) {
                break (meta_read, scan, identity);
            }
            detach_active_timeline(&timeline_dir)?;
            create_fresh_timeline_dirs(&timeline_dir, &segments_dir)?;
            detached = true;
        };
        let current_segment = scan.paths.last().cloned();
        let instance = identity.instance;
        let instance_summary = scan.instances.get(&instance).copied();
        let latest_seq = identity.latest_seq;
        let repaired_loss = match (&meta_read, scan.repaired_torn_tail) {
            (MetaRead::Valid(meta), true) if meta.instance == instance => {
                let records_latest = instance_summary
                    .map(|summary| summary.latest_seq)
                    .unwrap_or(0);
                (records_latest < meta.latest_seq)
                    .then_some((records_latest.saturating_add(1), meta.latest_seq))
            }
            _ => None,
        };
        let recovered_last_append_time_unix_ms = match &meta_read {
            MetaRead::Valid(meta) if meta.instance == instance => {
                Some(meta.last_append_time_unix_ms)
            }
            MetaRead::Missing | MetaRead::Invalid | MetaRead::Valid(_) => None,
        }
        .unwrap_or(0)
        .max(
            instance_summary
                .map(|summary| summary.max_append_time_unix_ms)
                .unwrap_or(0),
        );
        let now_unix_ms = options.clock.now_unix_ms();
        let last_append_time_unix_ms =
            append_time_with_clock_skew_clamp(now_unix_ms, recovered_last_append_time_unix_ms);

        let cutoff = now_unix_ms
            .saturating_sub(options.retention_days.min((i64::MAX / DAY_MS) as u64) as i64 * DAY_MS);
        let indexes = build_startup_indexes(&scan.paths, &instance, cutoff, hot_event_capacity)?;
        let recovery_ranges = scan
            .recovery_ranges
            .iter()
            .filter(|range| range.instance == instance)
            .map(|range| range.range)
            .collect();
        let mut store = Self {
            timeline_dir,
            segments_dir,
            meta_path,
            instance: Arc::from(instance),
            latest_seq,
            last_append_time_unix_ms,
            retention_days: options.retention_days,
            hot_event_capacity,
            hot_cache: indexes.hot_cache,
            segments: Arc::new(indexes.segments),
            physical_segment_max_append_times: scan.physical_segment_max_append_times,
            boundary_cache: indexes.boundary_cache,
            retained_bounds: indexes.retained_bounds,
            recovery_ranges: Arc::new(recovery_ranges),
            callback_projection_ids: indexes.callback_projection_ids,
            current_segment,
            clock: options.clock,
            write_failures: VecDeque::new(),
            write_poisoned: false,
            meta_dirty: true,
            meta_current: false,
            meta_dirty_after_prune: false,
            prune_dir_sync_pending: None,
            #[cfg(test)]
            boundary_segment_loads: 0,
            #[cfg(test)]
            segment_reads: Arc::new(AtomicUsize::new(0)),
            #[cfg(test)]
            read_record_count: Arc::new(AtomicUsize::new(0)),
            #[cfg(test)]
            segment_state_observer: None,
            #[cfg(test)]
            segment_read_observer: None,
        };
        if let Some((lost_start, lost_end)) = repaired_loss {
            store.append_recovery(lost_start, lost_end)?;
        }
        store.run_maintenance()?;
        if detached {
            sync_dir(&timelines_dir).map_err(|source| TimelineStoreError::Io {
                path: timelines_dir,
                source,
            })?;
        }
        Ok(store)
    }

    pub fn timeline_dir(&self) -> &Path {
        &self.timeline_dir
    }

    pub fn instance(&self) -> &str {
        self.instance.as_ref()
    }

    pub fn checkpoint(&self) -> TimelineCheckpoint {
        TimelineCheckpoint {
            seq: self.latest_seq,
            cursor: self.cursor_for_seq(self.latest_seq),
        }
    }

    pub fn retention(&self) -> TimelineRetentionSnapshot {
        let cutoff = self.retention_cutoff_unix_ms();
        if cutoff == self.retained_bounds.cutoff_unix_ms {
            return self
                .retained_bounds
                .snapshot(self.retention_days, self.hot_event_capacity);
        }
        let records = self.retained_records().unwrap_or_default();
        retained_snapshot(self.retention_days, self.hot_event_capacity, &records)
    }

    pub fn append(
        &mut self,
        append: TimelineAppend,
    ) -> Result<TimelineEnvelope, TimelineStoreError> {
        self.ensure_writable()?;

        let now = self.clock.now_unix_ms();
        let append_time_unix_ms =
            append_time_with_clock_skew_clamp(now, self.last_append_time_unix_ms);
        let seq = self
            .latest_seq
            .checked_add(1)
            .ok_or(TimelineStoreError::InvalidCursor)?;
        let cursor = EventCursor::for_instance(self.instance.to_string(), seq)
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
        let segment = self.segment_for_append_time(append_time_unix_ms)?;
        let segment_path = segment.path.clone();
        let cached_existing = self
            .current_segment
            .as_ref()
            .is_some_and(|current| current.path == segment_path);
        let needs_read_handle = self.segments.iter().all(|known| known.path != segment_path);
        let prepared = self.prepare_segment_append(
            &segment_path,
            &record,
            cached_existing,
            needs_read_handle,
        )?;
        let (record_start, record_end, read_handle) = self.commit_segment_append(prepared)?;

        self.current_segment = Some(segment);
        self.latest_seq = seq;
        self.last_append_time_unix_ms = append_time_unix_ms;
        self.push_hot_cache(record.clone());
        self.update_segment_metadata(
            &segment_path,
            &record,
            record_start,
            record_end,
            read_handle,
        );
        self.physical_segment_max_append_times
            .entry(segment_path.clone())
            .and_modify(|max_time| *max_time = (*max_time).max(append_time_unix_ms))
            .or_insert(append_time_unix_ms);
        self.meta_dirty = true;
        self.meta_current = false;
        let _ = self.run_maintenance();

        Ok(envelope)
    }

    fn append_recovery(
        &mut self,
        lost_start: u64,
        lost_end: u64,
    ) -> Result<(), TimelineStoreError> {
        self.append(TimelineAppend::new(
            RECOVERY_EVENT_TYPE,
            "timeline-store",
            serde_json::json!({
                "lost_seq": {
                    "start": lost_start,
                    "end": lost_end,
                }
            }),
        ))?;
        Arc::make_mut(&mut self.recovery_ranges).push(RecoveryRange {
            start: lost_start,
            end: lost_end,
            append_time_unix_ms: self.last_append_time_unix_ms,
        });
        Ok(())
    }

    pub fn append_callback_projection(
        &mut self,
        projection_id: &str,
        append: TimelineAppend,
    ) -> Result<Option<TimelineEnvelope>, TimelineStoreError> {
        self.ensure_writable()?;
        self.run_maintenance()?;
        if self.callback_projection_ids.contains_key(projection_id) {
            return Ok(None);
        }
        let envelope = self.append(append)?;
        let path = self
            .current_segment
            .as_ref()
            .expect("successful append has a current segment")
            .path
            .clone();
        self.callback_projection_ids
            .insert(projection_id.to_owned(), path);
        Ok(Some(envelope))
    }

    #[cfg(test)]
    pub(crate) fn clear_hot_cache_for_test(&mut self) {
        self.hot_cache.clear();
    }

    #[cfg(test)]
    pub(crate) fn set_segment_read_observer_for_test(
        &mut self,
        observer: impl Fn() + Send + Sync + 'static,
    ) {
        self.segment_read_observer = Some(Arc::new(observer));
    }

    #[cfg(test)]
    pub(crate) fn set_segment_state_observer_for_test(
        &mut self,
        observer: impl Fn() + Send + Sync + 'static,
    ) {
        self.segment_state_observer = Some(Arc::new(observer));
    }

    #[cfg(test)]
    fn segment_offset_count_for_test(&self) -> usize {
        self.segments[0]
            .sparse_offsets
            .read()
            .expect("timeline sparse offsets lock poisoned")
            .len()
    }

    #[cfg(test)]
    fn segment_offsets_for_test(&self) -> Arc<Vec<SparseOffset>> {
        self.segments[0]
            .sparse_offsets
            .read()
            .expect("timeline sparse offsets lock poisoned")
            .clone()
    }

    #[cfg(test)]
    fn segment_offsets_ptr_for_test(&self) -> *const Vec<SparseOffset> {
        let sparse_offsets = self.segments[0]
            .sparse_offsets
            .read()
            .expect("timeline sparse offsets lock poisoned");
        Arc::as_ptr(&sparse_offsets)
    }

    #[cfg(test)]
    fn segments_ptr_for_test(&self) -> *const Vec<Arc<SegmentMetadata>> {
        Arc::as_ptr(&self.segments)
    }

    #[cfg(test)]
    fn reset_read_record_count(&self) {
        self.read_record_count.store(0, Ordering::Relaxed);
    }

    #[cfg(test)]
    fn read_record_count(&self) -> usize {
        self.read_record_count.load(Ordering::Relaxed)
    }

    pub(crate) fn retained_cursor_seqs(
        &self,
        seqs: &[u64],
    ) -> Result<HashSet<u64>, TimelineStoreError> {
        let requested = seqs.iter().copied().collect::<HashSet<_>>();
        let mut retained = HashSet::with_capacity(requested.len());
        if requested.contains(&self.latest_seq) {
            retained.insert(self.latest_seq);
        }
        if requested.is_empty() {
            return Ok(retained);
        }

        let cutoff = self.retention_cutoff_unix_ms();
        let mut first_retained_seq = None;
        for segment in self.segments.iter().filter(|segment| {
            segment
                .state
                .read()
                .expect("timeline segment metadata lock poisoned")
                .max_append_time_unix_ms
                >= cutoff
        }) {
            let status = self.visit_segment_records(&segment.path, |record| {
                if self.is_retained_record(&record, cutoff) {
                    first_retained_seq.get_or_insert(record.envelope.seq);
                    if requested.contains(&record.envelope.seq) {
                        retained.insert(record.envelope.seq);
                    }
                }
                true
            })?;
            if status == SegmentVisit::Invalid {
                return Err(TimelineStoreError::Io {
                    path: segment.path.clone(),
                    source: io::Error::new(io::ErrorKind::InvalidData, "corrupt timeline segment"),
                });
            }
        }
        if requested.contains(&0) && first_retained_seq == Some(1) {
            retained.insert(0);
        }
        Ok(retained)
    }

    #[doc(hidden)]
    pub fn inject_next_write_failure(&mut self, failure: TimelineWriteFailure) {
        self.write_failures.clear();
        self.write_failures.push_back(failure);
    }

    #[doc(hidden)]
    pub fn inject_write_failures(
        &mut self,
        failures: impl IntoIterator<Item = TimelineWriteFailure>,
    ) {
        self.write_failures = failures.into_iter().collect();
    }

    fn retained_records(&self) -> Result<Vec<TimelineStoreRecord>, TimelineStoreError> {
        let cutoff = self.retention_cutoff_unix_ms();
        let mut records = self
            .read_all_records()?
            .into_iter()
            .filter(|record| record.append_time_unix_ms >= cutoff)
            .filter(|record| {
                record_instance(&record.envelope).as_deref() == Some(self.instance.as_ref())
            })
            .collect::<Vec<_>>();
        records.sort_by_key(|record| record.envelope.seq);
        Ok(records)
    }

    fn read_all_records(&self) -> Result<Vec<TimelineStoreRecord>, TimelineStoreError> {
        let mut records = Vec::new();
        for path in segment_paths(&self.segments_dir)? {
            #[cfg(test)]
            self.segment_reads.fetch_add(1, Ordering::Relaxed);
            let parsed = read_segment_records(&path)?;
            records.extend(parsed.records);
            if parsed.invalid_offset.is_some() {
                break;
            }
        }
        Ok(records)
    }

    fn is_retained_record(&self, record: &TimelineStoreRecord, cutoff: i64) -> bool {
        record.append_time_unix_ms >= cutoff
            && record_instance(&record.envelope).as_deref() == Some(self.instance.as_ref())
    }

    fn visit_segment_records(
        &self,
        path: &Path,
        visit: impl FnMut(TimelineStoreRecord) -> bool,
    ) -> Result<SegmentVisit, TimelineStoreError> {
        #[cfg(test)]
        self.segment_reads.fetch_add(1, Ordering::Relaxed);
        visit_segment_records(path, visit)
    }

    fn prepare_segment_append(
        &mut self,
        path: &Path,
        record: &TimelineStoreRecord,
        cached_existing: bool,
        needs_read_handle: bool,
    ) -> Result<PreparedSegmentAppend, TimelineStoreError> {
        let mut bytes = serde_json::to_vec(record).map_err(|source| TimelineStoreError::Json {
            path: path.to_path_buf(),
            source,
        })?;
        bytes.push(b'\n');
        if let Some(parent) = path.parent() {
            ensure_private_dir(parent).map_err(|source| TimelineStoreError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let mut options = private_open_options();
        options.read(true).append(true);
        if !cached_existing {
            options.create_new(true);
        }
        let mut file =
            open_private_file(&options, path).map_err(|source| TimelineStoreError::Io {
                path: path.to_path_buf(),
                source,
            })?;
        let created_file = !cached_existing;
        let old_len = match file.seek(SeekFrom::End(0)) {
            Ok(len) => len,
            Err(source) => {
                let original = TimelineStoreError::Io {
                    path: path.to_path_buf(),
                    source,
                };
                return self.rollback_prepared_file(path, file, created_file, 0, original);
            }
        };
        let read_handle = if needs_read_handle {
            match file.try_clone() {
                Ok(handle) => Some(Arc::new(handle)),
                Err(source) => {
                    let original = TimelineStoreError::Io {
                        path: path.to_path_buf(),
                        source,
                    };
                    return self.rollback_prepared_file(
                        path,
                        file,
                        created_file,
                        old_len,
                        original,
                    );
                }
            }
        } else {
            None
        };
        let record_end = match old_len.checked_add(bytes.len() as u64) {
            Some(end) => end,
            None => {
                let original = TimelineStoreError::Io {
                    path: path.to_path_buf(),
                    source: io::Error::other("timeline segment offset overflow"),
                };
                return self.rollback_prepared_file(path, file, created_file, old_len, original);
            }
        };
        Ok(PreparedSegmentAppend {
            path: path.to_path_buf(),
            file,
            created_file,
            old_len,
            record_end,
            bytes,
            read_handle,
        })
    }

    fn commit_segment_append(
        &mut self,
        mut prepared: PreparedSegmentAppend,
    ) -> Result<(u64, u64, Option<Arc<File>>), TimelineStoreError> {
        let path = prepared.path.clone();
        let operation = if self.take_write_failure(TimelineWriteFailure::Append) {
            Err(TimelineStoreError::InjectedWrite { failure: "append" })
        } else if let Err(source) = prepared.file.write_all(&prepared.bytes) {
            Err(TimelineStoreError::Io {
                path: path.clone(),
                source,
            })
        } else if self.take_write_failure(TimelineWriteFailure::Flush) {
            Err(TimelineStoreError::InjectedWrite { failure: "flush" })
        } else if let Err(source) = prepared.file.flush() {
            Err(TimelineStoreError::Io {
                path: path.clone(),
                source,
            })
        } else if self.take_write_failure(TimelineWriteFailure::SyncData) {
            Err(TimelineStoreError::InjectedWrite {
                failure: "sync_data",
            })
        } else if let Err(source) = prepared.file.sync_data() {
            Err(TimelineStoreError::Io {
                path: path.clone(),
                source,
            })
        } else if prepared.created_file
            && self.take_write_failure(TimelineWriteFailure::NewSegmentDirSync)
        {
            Err(TimelineStoreError::InjectedWrite {
                failure: "new_segment_dir_sync",
            })
        } else if prepared.created_file {
            sync_dir(path.parent().unwrap_or_else(|| Path::new("."))).map_err(|source| {
                TimelineStoreError::Io {
                    path: path
                        .parent()
                        .unwrap_or_else(|| Path::new("."))
                        .to_path_buf(),
                    source,
                }
            })
        } else {
            Ok(())
        };
        if let Err(original) = operation {
            return self.rollback_prepared_append(prepared, original);
        }
        Ok((prepared.old_len, prepared.record_end, prepared.read_handle))
    }

    fn rollback_prepared_append<T>(
        &mut self,
        prepared: PreparedSegmentAppend,
        original: TimelineStoreError,
    ) -> Result<T, TimelineStoreError> {
        let path = prepared.path.clone();
        let rollback = if self.take_write_failure(TimelineWriteFailure::Rollback) {
            Err(TimelineStoreError::InjectedWrite {
                failure: "rollback",
            })
        } else if prepared.created_file {
            drop(prepared.file);
            fs::remove_file(&path)
                .or_else(|error| {
                    (error.kind() == io::ErrorKind::NotFound)
                        .then_some(())
                        .ok_or(error)
                })
                .map_err(|source| TimelineStoreError::Io {
                    path: path.clone(),
                    source,
                })
                .and_then(|_| {
                    sync_dir(path.parent().unwrap_or_else(|| Path::new("."))).map_err(|source| {
                        TimelineStoreError::Io {
                            path: path
                                .parent()
                                .unwrap_or_else(|| Path::new("."))
                                .to_path_buf(),
                            source,
                        }
                    })
                })
        } else {
            prepared
                .file
                .set_len(prepared.old_len)
                .and_then(|_| prepared.file.sync_data())
                .map_err(|source| TimelineStoreError::Io {
                    path: path.clone(),
                    source,
                })
        };
        match rollback {
            Ok(()) => Err(original),
            Err(rollback) => {
                self.write_poisoned = true;
                Err(TimelineStoreError::Io {
                    path,
                    source: io::Error::other(format!(
                        "timeline append commit is ambiguous; original error: {original}; rollback error: {rollback}"
                    )),
                })
            }
        }
    }

    fn rollback_prepared_file(
        &mut self,
        path: &Path,
        file: File,
        created_file: bool,
        old_len: u64,
        original: TimelineStoreError,
    ) -> Result<PreparedSegmentAppend, TimelineStoreError> {
        self.rollback_prepared_append(
            PreparedSegmentAppend {
                path: path.to_path_buf(),
                file,
                created_file,
                old_len,
                record_end: old_len,
                bytes: Vec::new(),
                read_handle: None,
            },
            original,
        )
    }

    fn take_write_failure(&mut self, expected: TimelineWriteFailure) -> bool {
        if self.write_failures.front() == Some(&expected) {
            self.write_failures.pop_front();
            true
        } else {
            false
        }
    }

    fn ensure_writable(&self) -> Result<(), TimelineStoreError> {
        if self.write_poisoned {
            return Err(TimelineStoreError::Io {
                path: self.timeline_dir.clone(),
                source: io::Error::other("timeline writes are poisoned after an ambiguous commit"),
            });
        }
        Ok(())
    }

    fn segment_for_append_time(
        &self,
        append_time_unix_ms: i64,
    ) -> Result<PhysicalSegment, TimelineStoreError> {
        let date = utc_date_string_from_unix_ms(append_time_unix_ms);
        if let Some(current) = &self.current_segment {
            if current.date == date {
                return Ok(current.clone());
            }
            let ordinal = current
                .ordinal
                .checked_add(1)
                .ok_or_else(|| TimelineStoreError::Io {
                    path: current.path.clone(),
                    source: io::Error::other(format!(
                        "timeline segment ordinal overflow after {}",
                        current.ordinal
                    )),
                })?;
            return Ok(PhysicalSegment::new(&self.segments_dir, ordinal, date));
        }
        Ok(PhysicalSegment::new(&self.segments_dir, 0, date))
    }

    fn cursor_for_seq(&self, seq: u64) -> String {
        EventCursor::for_instance(self.instance.to_string(), seq)
            .expect("timeline store instance should be valid")
            .to_string()
    }

    fn retention_cutoff_unix_ms(&self) -> i64 {
        let window_ms = self.retention_days.min((i64::MAX / DAY_MS) as u64) as i64 * DAY_MS;
        self.clock.now_unix_ms().saturating_sub(window_ms)
    }

    fn push_hot_cache(&mut self, record: TimelineStoreRecord) {
        self.hot_cache.push_back(record);
        while self.hot_cache.len() > self.hot_event_capacity {
            self.hot_cache.pop_front();
        }
    }

    fn update_segment_metadata(
        &mut self,
        path: &Path,
        record: &TimelineStoreRecord,
        start: u64,
        end: u64,
        read_handle: Option<Arc<File>>,
    ) {
        if let Some(segment) = self.segments.iter().find(|segment| segment.path == path) {
            segment.push(record, start, end);
        } else {
            Arc::make_mut(&mut self.segments).push(Arc::new(SegmentMetadata::from_record(
                path.to_path_buf(),
                read_handle.expect("new timeline segment must have a read handle"),
                record,
                start,
                end,
            )));
            Arc::make_mut(&mut self.segments).sort_by(|left, right| left.path.cmp(&right.path));
        }
        if record.append_time_unix_ms >= self.retention_cutoff_unix_ms() {
            self.retained_bounds.push(record);
        }
        let cutoff = self.retention_cutoff_unix_ms();
        if let Some(cache) = &mut self.boundary_cache {
            if cache.path == path {
                cache.push(record, cutoff);
            }
        }
    }

    fn write_meta(&mut self) -> Result<(), TimelineStoreError> {
        if self.meta_dirty_after_prune
            && self.take_write_failure(TimelineWriteFailure::PostPruneMetaWrite)
        {
            return Err(TimelineStoreError::InjectedWrite {
                failure: "post_prune_write_meta",
            });
        }
        if self.take_write_failure(TimelineWriteFailure::MetaWrite) {
            return Err(TimelineStoreError::InjectedWrite {
                failure: "write_meta",
            });
        }
        let retention = self
            .retained_bounds
            .snapshot(self.retention_days, self.hot_event_capacity);
        let meta = TimelineStoreMeta {
            version: 1,
            instance: self.instance.to_string(),
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
        write_meta_atomic(&self.meta_path, &bytes)?;
        self.meta_dirty = false;
        self.meta_current = true;
        self.meta_dirty_after_prune = false;
        Ok(())
    }

    fn run_maintenance(&mut self) -> Result<(), TimelineStoreError> {
        if let Some(path) = self.prune_dir_sync_pending.clone() {
            let parent = path.parent().unwrap_or_else(|| Path::new("."));
            if self.take_write_failure(TimelineWriteFailure::PruneDirSync) {
                return Err(TimelineStoreError::InjectedWrite {
                    failure: "prune_dir_sync",
                });
            }
            sync_dir(parent).map_err(|source| TimelineStoreError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
            self.prune_dir_sync_pending = None;
            let cutoff = self.retention_cutoff_unix_ms();
            self.commit_segment_absent(&path, cutoff);
            self.meta_dirty = true;
            self.meta_current = false;
            self.meta_dirty_after_prune = true;
        }

        loop {
            if self.meta_dirty {
                self.write_meta()?;
            }
            if !self.meta_current || self.prune_dir_sync_pending.is_some() {
                return Ok(());
            }
            let before = self.physical_segment_max_append_times.len();
            self.prune_expired_segments()?;
            if self.prune_dir_sync_pending.is_some() {
                return Ok(());
            }
            if !self.meta_dirty && self.physical_segment_max_append_times.len() == before {
                return Ok(());
            }
        }
    }
}

fn sync_dir(path: &Path) -> io::Result<()> {
    match File::open(path).and_then(|file| file.sync_all()) {
        Ok(()) => Ok(()),
        Err(error) if is_unsupported_dir_sync(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

fn create_fresh_timeline_dirs(
    timeline_dir: &Path,
    segments_dir: &Path,
) -> Result<(), TimelineStoreError> {
    for path in [timeline_dir, segments_dir] {
        ensure_private_dir(path).map_err(|source| TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    }
    sync_dir(segments_dir).map_err(|source| TimelineStoreError::Io {
        path: segments_dir.to_path_buf(),
        source,
    })?;
    sync_dir(timeline_dir).map_err(|source| TimelineStoreError::Io {
        path: timeline_dir.to_path_buf(),
        source,
    })
}

fn is_unsupported_dir_sync(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::Unsupported)
        || error.raw_os_error() == Some(22)
        || error.raw_os_error() == Some(45)
        || error.raw_os_error() == Some(95)
        || cfg!(windows) && matches!(error.kind(), io::ErrorKind::PermissionDenied)
}

fn valid_record(record: &TimelineStoreRecord) -> bool {
    if record.envelope.version != crate::timeline::TIMELINE_VERSION || record.envelope.seq == 0 {
        return false;
    }
    EventCursor::parse_timeline(&record.envelope.cursor)
        .map(|cursor| cursor.seq() == record.envelope.seq)
        .unwrap_or(false)
}

fn recovery_range(record: &TimelineStoreRecord) -> Option<RecoveryRange> {
    if record.envelope.event_type != RECOVERY_EVENT_TYPE {
        return None;
    }
    let lost = record.envelope.data.get("lost_seq")?;
    let start = lost.get("start")?.as_u64()?;
    let end = lost.get("end")?.as_u64()?;
    (start > 0 && start <= end && end.checked_add(1) == Some(record.envelope.seq)).then_some(
        RecoveryRange {
            start,
            end,
            append_time_unix_ms: record.append_time_unix_ms,
        },
    )
}

fn is_recovery_record(record: &TimelineStoreRecord) -> bool {
    record.envelope.event_type == RECOVERY_EVENT_TYPE
}

fn callback_projection_id(record: &TimelineStoreRecord) -> Option<String> {
    matches!(
        record.envelope.event_type.as_str(),
        "task.callback_delivered"
            | "background_task.callback_delivered"
            | "subagent.callback_delivered"
    )
    .then(|| {
        record
            .envelope
            .data
            .get("projection_id")?
            .as_str()
            .map(str::to_owned)
    })
    .flatten()
}

fn record_instance(envelope: &TimelineEnvelope) -> Option<String> {
    EventCursor::parse_timeline(&envelope.cursor)
        .ok()
        .and_then(|cursor| cursor.instance().map(ToOwned::to_owned))
}

fn timeline_session_key(session: Option<&str>) -> String {
    match session {
        Some(session) => encode_session_name(session),
        None => THREAD_LOCAL_SESSION_KEY.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::Deserializer;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Mutex;
    use std::time::Duration;

    static LIVE_SCANNED_PAYLOADS: AtomicUsize = AtomicUsize::new(0);
    static PEAK_SCANNED_PAYLOADS: AtomicUsize = AtomicUsize::new(0);

    struct TrackedPayload(String);

    impl<'de> Deserialize<'de> for TrackedPayload {
        fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
        where
            D: Deserializer<'de>,
        {
            let payload = String::deserialize(deserializer)?;
            let live = LIVE_SCANNED_PAYLOADS.fetch_add(1, AtomicOrdering::SeqCst) + 1;
            PEAK_SCANNED_PAYLOADS.fetch_max(live, AtomicOrdering::SeqCst);
            Ok(Self(payload))
        }
    }

    impl Drop for TrackedPayload {
        fn drop(&mut self) {
            let _owned_bytes = self.0.len();
            LIVE_SCANNED_PAYLOADS.fetch_sub(1, AtomicOrdering::SeqCst);
        }
    }

    #[derive(Deserialize)]
    struct TrackedRecord {
        #[serde(rename = "payload")]
        _payload: TrackedPayload,
    }

    #[test]
    fn jsonl_scanner_releases_each_owned_payload_when_visitor_does_not_retain_it() {
        LIVE_SCANNED_PAYLOADS.store(0, AtomicOrdering::SeqCst);
        PEAK_SCANNED_PAYLOADS.store(0, AtomicOrdering::SeqCst);
        let root = std::env::temp_dir().join(format!(
            "botified-timeline-streaming-scan-{}-{}",
            std::process::id(),
            unique_stamp()
        ));
        fs::create_dir_all(&root).expect("create scanner test root");
        let path = root.join("records.jsonl");
        let payload = "x".repeat(64 * 1024);
        let lines = (0..32)
            .map(|_| serde_json::json!({"payload": payload}).to_string())
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, format!("{lines}\n")).expect("write scanner records");

        let mut visited = 0;
        let result = scan_jsonl_records::<TrackedRecord>(
            &path,
            |_| true,
            |_| {
                visited += 1;
                true
            },
        )
        .expect("scan records");

        assert_eq!(result.visit, SegmentVisit::Complete);
        assert_eq!(visited, 32);
        assert_eq!(LIVE_SCANNED_PAYLOADS.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(PEAK_SCANNED_PAYLOADS.load(AtomicOrdering::SeqCst), 1);
        fs::remove_dir_all(root).expect("clean scanner test root");
    }

    #[test]
    fn startup_hot_cache_strictly_keeps_the_latest_k_records() {
        let root = std::env::temp_dir().join(format!(
            "botified-timeline-startup-hot-cap-{}-{}",
            std::process::id(),
            unique_stamp()
        ));
        let clock = TestClock(Arc::new(Mutex::new(1_800_000_000_000)));
        let options = || {
            TimelineStoreOptions::new(&root, Some("startup-hot-cap"))
                .retention_days(1)
                .hot_event_capacity(3)
                .clock(clock.clone())
        };
        let mut store = TimelineStore::open(options()).expect("open initial store");
        append_test_events(&mut store, 8);
        drop(store);

        let reopened = TimelineStore::open(options()).expect("rebuild bounded hot cache");
        assert_eq!(reopened.hot_cache.len(), 3);
        assert_eq!(
            reopened
                .hot_cache
                .iter()
                .map(|record| record.envelope.seq)
                .collect::<Vec<_>>(),
            [6, 7, 8]
        );

        drop(reopened);
        fs::remove_dir_all(root).expect("clean startup hot cache test root");
    }

    #[derive(Clone)]
    struct TestClock(Arc<Mutex<i64>>);

    impl TimelineClock for TestClock {
        fn now_unix_ms(&self) -> i64 {
            *self.0.lock().expect("test clock")
        }
    }

    impl TestClock {
        fn set(&self, value: i64) {
            *self.0.lock().expect("test clock") = value;
        }
    }

    fn test_store(name: &str, capacity: usize, clock: TestClock) -> TimelineStore {
        let root = std::env::temp_dir().join(format!(
            "botified-timeline-hot-cache-{name}-{}-{}",
            std::process::id(),
            unique_stamp()
        ));
        TimelineStore::open(
            TimelineStoreOptions::new(root, Some(name))
                .retention_days(1)
                .hot_event_capacity(capacity)
                .clock(clock),
        )
        .expect("open test store")
    }

    fn append_test_events(store: &mut TimelineStore, count: usize) -> Vec<TimelineEnvelope> {
        (1..=count)
            .map(|seq| {
                store
                    .append(TimelineAppend::new(
                        format!("event-{seq}"),
                        "test",
                        Value::Null,
                    ))
                    .expect("append test event")
            })
            .collect()
    }

    #[test]
    fn hot_cache_serves_provably_complete_pages_without_segment_reads() {
        let clock = TestClock(Arc::new(Mutex::new(1_800_000_000_000)));
        let mut store = test_store("complete-pages", 3, clock.clone());
        let events = append_test_events(&mut store, 5);

        store.segment_reads.store(0, Ordering::Relaxed);
        let tail = store.tail(2).expect("cached tail");
        assert_eq!(
            tail.events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            [4, 5]
        );
        assert_eq!(tail.page_start_cursor, events[3].cursor);
        assert_eq!(tail.page_end_cursor, events[4].cursor);
        assert_eq!(tail.next_cursor, events[4].cursor);
        assert!(tail.has_more_before);
        assert_eq!(tail.history_boundary, HistoryBoundary::None);
        assert_eq!(store.segment_reads.load(Ordering::Relaxed), 0);

        let forward = store
            .read_forward(&events[2].cursor, 10)
            .expect("cached forward through latest");
        assert_eq!(
            forward
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            [4, 5]
        );
        assert_eq!(forward.next_cursor, events[4].cursor);
        assert!(!forward.has_more_after);
        assert_eq!(store.segment_reads.load(Ordering::Relaxed), 0);

        let backward = store
            .read_backward(&events[4].cursor, 2)
            .expect("cached backward page");
        assert_eq!(
            backward
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            [3, 4]
        );
        assert_eq!(backward.page_start_cursor, events[2].cursor);
        assert_eq!(backward.page_end_cursor, events[3].cursor);
        assert_eq!(backward.next_cursor, events[4].cursor);
        assert!(backward.has_more_before);
        assert_eq!(backward.history_boundary, HistoryBoundary::None);
        assert_eq!(store.segment_reads.load(Ordering::Relaxed), 0);

        let mut exact_capacity = test_store("exact-capacity", 3, clock);
        let exact_events = append_test_events(&mut exact_capacity, 3);
        exact_capacity.segment_reads.store(0, Ordering::Relaxed);
        let exact_tail = exact_capacity.tail(3).expect("full cached tail");
        assert_eq!(exact_tail.history_boundary, HistoryBoundary::Start);
        assert!(!exact_tail.has_more_before);
        let to_start = exact_capacity
            .read_backward(&exact_events[2].cursor, 10)
            .expect("cached backward to retained start");
        assert_eq!(
            to_start
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(to_start.history_boundary, HistoryBoundary::Start);
        assert!(!to_start.has_more_before);
        assert_eq!(exact_capacity.segment_reads.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn retained_seq_batch_reads_each_segment_at_most_once() {
        let base = 1_800_000_000_000;
        let clock = TestClock(Arc::new(Mutex::new(base)));
        let root = std::env::temp_dir().join(format!(
            "botified-timeline-retained-seq-batch-{}-{}",
            std::process::id(),
            unique_stamp()
        ));
        let mut store = TimelineStore::open(
            TimelineStoreOptions::new(root, Some("retained-seq-batch"))
                .retention_days(14)
                .hot_event_capacity(1)
                .clock(clock.clone()),
        )
        .expect("open batch test store");
        let mut events = Vec::new();
        for day in 0..8 {
            clock.set(base + day * DAY_MS);
            events.extend(append_test_events(&mut store, 16));
        }
        assert_eq!(store.segments.len(), 8);

        store.segment_reads.store(0, Ordering::Relaxed);
        let requested = events
            .iter()
            .flat_map(|event| [event.seq, event.seq])
            .collect::<Vec<_>>();
        let retained = store
            .retained_cursor_seqs(&requested)
            .expect("batch retained cursor lookup");

        assert_eq!(retained.len(), events.len());
        assert!(events.iter().all(|event| retained.contains(&event.seq)));
        assert_eq!(
            store.segment_reads.load(Ordering::Relaxed),
            store.segments.len(),
            "batch lookup must scan each retained segment once, independent of cursor count"
        );
    }

    #[test]
    fn retained_seq_lookup_propagates_segment_io_errors() {
        let clock = TestClock(Arc::new(Mutex::new(1_800_000_000_000)));
        let mut store = test_store("retained-seq-io-error", 1, clock);
        let events = append_test_events(&mut store, 2);
        let segment_path = store.segments[0].path.clone();
        fs::remove_file(&segment_path).expect("remove retained segment");

        let error = store
            .retained_cursor_seqs(&[events[0].seq])
            .expect_err("missing retained segment must fail lookup");

        assert!(matches!(
            error,
            TimelineStoreError::Io { path, .. } if path == segment_path
        ));
    }

    #[test]
    fn retained_seq_lookup_rejects_partial_results_from_corrupt_segment() {
        let clock = TestClock(Arc::new(Mutex::new(1_800_000_000_000)));
        let mut store = test_store("retained-seq-corrupt", 1, clock);
        let events = append_test_events(&mut store, 2);
        let segment_path = store.segments[0].path.clone();
        let mut segment = OpenOptions::new()
            .append(true)
            .open(&segment_path)
            .expect("open retained segment");
        writeln!(segment, "{{not-json").expect("corrupt retained segment");

        let error = store
            .retained_cursor_seqs(&[events[0].seq, events[1].seq])
            .expect_err("corrupt retained segment must not return a partial set");

        assert!(matches!(
            error,
            TimelineStoreError::Io { path, source }
                if path == segment_path && source.kind() == io::ErrorKind::InvalidData
        ));
    }

    #[test]
    fn retained_seq_lookup_keeps_mixed_retained_and_expired_policy() {
        let base = 1_800_000_000_000;
        let clock = TestClock(Arc::new(Mutex::new(base)));
        let mut store = test_store("retained-seq-mixed", 1, clock.clone());
        let expired = append_test_events(&mut store, 1).remove(0);
        clock.set(base + 2 * DAY_MS);
        let retained = append_test_events(&mut store, 1).remove(0);

        let retained_seqs = store
            .retained_cursor_seqs(&[expired.seq, retained.seq])
            .expect("mixed retained and expired lookup");

        assert_eq!(retained_seqs, HashSet::from([retained.seq]));
    }

    #[test]
    fn hot_cache_falls_back_when_page_completeness_is_not_provable() {
        let base = 1_800_000_000_000;
        let clock = TestClock(Arc::new(Mutex::new(base)));
        let mut store = test_store("fallback-pages", 3, clock.clone());
        let events = append_test_events(&mut store, 5);

        store.segment_reads.store(0, Ordering::Relaxed);
        assert_eq!(store.tail(4).expect("cross-cache tail").events.len(), 4);
        assert!(store.segment_reads.load(Ordering::Relaxed) > 0);

        store.segment_reads.store(0, Ordering::Relaxed);
        assert_eq!(
            store
                .read_forward(&events[1].cursor, 2)
                .expect("cursor before cache")
                .events
                .len(),
            2
        );
        assert!(store.segment_reads.load(Ordering::Relaxed) > 0);

        store.segment_reads.store(0, Ordering::Relaxed);
        assert_eq!(
            store
                .read_backward(&events[3].cursor, 3)
                .expect("prefix before cache")
                .events
                .len(),
            3
        );
        assert!(store.segment_reads.load(Ordering::Relaxed) > 0);

        clock.set(base + DAY_MS + 1);
        store.segment_reads.store(0, Ordering::Relaxed);
        let expired = store.tail(2).expect("expired tail");
        assert!(expired.events.is_empty());
        assert_eq!(expired.history_boundary, HistoryBoundary::Expired);
        assert_eq!(
            store.segment_reads.load(Ordering::Relaxed),
            0,
            "segment metadata should prove that the retained range is empty"
        );

        store.segment_reads.store(0, Ordering::Relaxed);
        assert!(matches!(
            store.tail(0),
            Err(TimelineStoreError::InvalidLimit)
        ));
        assert!(matches!(
            store.read_forward(&events[4].cursor, 0),
            Err(TimelineStoreError::InvalidLimit)
        ));
        assert!(matches!(
            store.read_backward(&events[4].cursor, 0),
            Err(TimelineStoreError::InvalidLimit)
        ));
        assert_eq!(store.segment_reads.load(Ordering::Relaxed), 0);
        let stale = EventCursor::for_instance("other", 5)
            .expect("stale cursor")
            .to_string();
        assert!(matches!(
            store.read_forward(&stale, 1),
            Err(TimelineStoreError::StaleCursor)
        ));
    }

    #[test]
    fn future_cursor_is_stale_for_forward_and_backward_before_segment_io() {
        let clock = TestClock(Arc::new(Mutex::new(1_800_000_000_000)));
        let mut store = test_store("future-cursor-validation", 1, clock);
        let latest = append_test_events(&mut store, 2)
            .pop()
            .expect("latest event");
        let future_cursor = EventCursor::for_instance(store.instance(), latest.seq + 1)
            .expect("future cursor")
            .to_string();
        store.segment_reads.store(0, Ordering::Relaxed);

        assert!(matches!(
            store.read_forward(&future_cursor, 1),
            Err(TimelineStoreError::StaleCursor)
        ));
        assert!(matches!(
            store.read_backward(&future_cursor, 1),
            Err(TimelineStoreError::StaleCursor)
        ));
        assert_eq!(store.segment_reads.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn cold_single_segment_pages_parse_only_the_requested_window() {
        let clock = TestClock(Arc::new(Mutex::new(1_800_000_000_000)));
        let mut store = test_store("bounded-cold-window", 1, clock);
        let events = append_test_events(&mut store, 200);

        store.reset_read_record_count();
        let tail = store.tail(5).expect("bounded cold tail");
        assert_eq!(tail.events.first().map(|event| event.seq), Some(196));
        assert!(store.read_record_count() <= TIMELINE_SPARSE_INDEX_STRIDE + 6);

        store.reset_read_record_count();
        let mut cursor = events[0].cursor.clone();
        for _ in 0..10 {
            let page = store
                .read_forward(&cursor, 5)
                .expect("bounded forward continuation");
            cursor = page.next_cursor;
        }
        assert!(
            store.read_record_count() <= 10 * (TIMELINE_SPARSE_INDEX_STRIDE + 6),
            "forward pagination must not rescan the segment prefix"
        );

        store.reset_read_record_count();
        let mut cursor = events[199].cursor.clone();
        for _ in 0..10 {
            let page = store
                .read_backward(&cursor, 5)
                .expect("bounded backward continuation");
            cursor = page.page_start_cursor;
        }
        assert!(
            store.read_record_count() <= 10 * (TIMELINE_SPARSE_INDEX_STRIDE + 6),
            "backward pagination must not rescan the segment prefix"
        );
    }

    #[test]
    fn read_snapshot_shares_segments_without_cloning_segment_or_sparse_state() {
        let clock = TestClock(Arc::new(Mutex::new(1_800_000_000_000)));
        let mut store = test_store("shared-snapshot-segments", 1, clock);
        append_test_events(&mut store, 1);
        let collection = store.segments_ptr_for_test();
        let segment = Arc::clone(&store.segments[0]);
        let state = segment.state.write().expect("segment state");
        let offsets = segment
            .sparse_offsets
            .write()
            .expect("timeline sparse offsets lock poisoned");

        let snapshot = store.read_snapshot();
        assert_eq!(snapshot.segments.len(), 1);
        assert!(Arc::ptr_eq(&snapshot.segments, &store.segments));
        assert_eq!(store.segments_ptr_for_test(), collection);
        drop(offsets);
        drop(state);

        append_test_events(&mut store, 1);
        assert_eq!(snapshot.tail(10).expect("snapshot tail").events.len(), 1);
    }

    #[test]
    fn read_snapshot_freezes_checkpoint_and_retention_before_later_appends() {
        let clock = TestClock(Arc::new(Mutex::new(1_800_000_000_000)));
        let mut store = test_store("snapshot-frozen-metadata", 7, clock);
        let original = append_test_events(&mut store, 1).remove(0);
        store.segment_reads.store(0, Ordering::Relaxed);
        let snapshot = store.read_snapshot();

        append_test_events(&mut store, 1);

        assert_eq!(
            snapshot.checkpoint(),
            TimelineCheckpoint {
                seq: original.seq,
                cursor: original.cursor.clone(),
            }
        );
        assert_eq!(
            snapshot.retention(),
            TimelineRetentionSnapshot {
                retention_days: 1,
                hot_event_capacity: 7,
                earliest_seq: Some(original.seq),
                earliest_cursor: Some(original.cursor.clone()),
                latest_seq: Some(original.seq),
                latest_cursor: Some(original.cursor),
            }
        );
        assert_eq!(store.segment_reads.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn read_snapshot_retention_filters_a_mixed_cutoff_boundary() {
        let now = 1_800_000_000_000;
        let clock = TestClock(Arc::new(Mutex::new(now - DAY_MS - 1)));
        let mut store = test_store("snapshot-mixed-retention", 3, clock.clone());
        let expired = append_test_events(&mut store, 1).remove(0);
        clock.set(now - DAY_MS);
        let retained = append_test_events(&mut store, 1).remove(0);
        clock.set(now);
        assert_eq!(store.segments.len(), 1, "test requires a mixed segment");
        let snapshot = store.read_snapshot();
        clock.set(now - DAY_MS + 2);
        let later = append_test_events(&mut store, 1).remove(0);
        assert_eq!(
            store.segments.len(),
            1,
            "later append must share the segment"
        );

        let retention = snapshot.retention();

        assert_ne!(retention.earliest_seq, Some(expired.seq));
        assert_eq!(retention.earliest_seq, Some(retained.seq));
        assert_eq!(retention.earliest_cursor, Some(retained.cursor.clone()));
        assert_eq!(retention.latest_seq, Some(retained.seq));
        assert_eq!(retention.latest_cursor, Some(retained.cursor));
        assert_ne!(retention.latest_seq, Some(later.seq));
    }

    #[test]
    fn read_snapshot_retention_handles_non_monotonic_append_times_in_a_mixed_segment() {
        let day = 1_800_000_000_000;
        let retained_time = day + 6 * 60 * 60 * 1_000;
        let expired_time = day + 2 * 60 * 60 * 1_000;
        let cutoff = day + 4 * 60 * 60 * 1_000;
        let clock = TestClock(Arc::new(Mutex::new(retained_time)));
        let mut store = test_store("snapshot-non-monotonic-retention", 1, clock.clone());
        let earliest = append_test_events(&mut store, TIMELINE_SPARSE_INDEX_STRIDE).remove(0);
        clock.set(expired_time);
        append_test_events(&mut store, TIMELINE_SPARSE_INDEX_STRIDE);
        clock.set(retained_time + 60 * 60 * 1_000);
        let latest = append_test_events(&mut store, 1).remove(0);
        assert_eq!(store.segments.len(), 1, "test requires one mixed segment");
        clock.set(cutoff + DAY_MS);

        let retention = store.read_snapshot().retention();

        assert_eq!(retention.earliest_seq, Some(earliest.seq));
        assert_eq!(retention.earliest_cursor, Some(earliest.cursor));
        assert_eq!(retention.latest_seq, Some(latest.seq));
        assert_eq!(retention.latest_cursor, Some(latest.cursor));
    }

    #[test]
    fn read_snapshot_retention_preserves_fields_when_every_record_is_expired() {
        let base = 1_800_000_000_000;
        let clock = TestClock(Arc::new(Mutex::new(base)));
        let mut store = test_store("snapshot-expired-retention", 5, clock.clone());
        append_test_events(&mut store, 1);
        clock.set(base + DAY_MS + 1);

        assert_eq!(
            store.read_snapshot().retention(),
            TimelineRetentionSnapshot {
                retention_days: 1,
                hot_event_capacity: 5,
                earliest_seq: None,
                earliest_cursor: None,
                latest_seq: None,
                latest_cursor: None,
            }
        );
    }

    #[test]
    fn read_snapshot_retention_falls_back_to_empty_bounds_when_scanning_fails() {
        let base = 1_800_000_000_000;
        let clock = TestClock(Arc::new(Mutex::new(base)));
        let mut store = test_store("snapshot-retention-scan-failure", 4, clock.clone());
        append_test_events(&mut store, 1);
        clock.set(base + 2);
        append_test_events(&mut store, 1);
        clock.set(base + DAY_MS + 1);
        let snapshot = store.read_snapshot();
        OpenOptions::new()
            .write(true)
            .open(&store.segments[0].path)
            .expect("open snapshot segment")
            .set_len(0)
            .expect("truncate snapshot segment");

        assert_eq!(
            snapshot.retention(),
            TimelineRetentionSnapshot {
                retention_days: 1,
                hot_event_capacity: 4,
                earliest_seq: None,
                earliest_cursor: None,
                latest_seq: None,
                latest_cursor: None,
            }
        );
    }

    #[test]
    fn read_snapshot_retention_scans_without_holding_the_store_mutex() {
        let base = 1_800_000_000_000;
        let clock = TestClock(Arc::new(Mutex::new(base)));
        let mut store = test_store("snapshot-retention-outside-lock", 1, clock.clone());
        append_test_events(&mut store, 1);
        clock.set(base + 2);
        append_test_events(&mut store, 1);
        clock.set(base + DAY_MS + 1);
        let (read_started_tx, read_started_rx) = std::sync::mpsc::sync_channel(1);
        let (resume_read_tx, resume_read_rx) = std::sync::mpsc::sync_channel(1);
        let resume_read_rx = Arc::new(Mutex::new(resume_read_rx));
        store.set_segment_read_observer_for_test(move || {
            read_started_tx.send(()).expect("signal snapshot scan");
            resume_read_rx
                .lock()
                .expect("resume receiver")
                .recv_timeout(Duration::from_secs(5))
                .expect("resume snapshot scan");
        });
        let store = Arc::new(Mutex::new(store));
        let snapshot = store.lock().expect("store mutex").read_snapshot();

        let reader = std::thread::spawn(move || snapshot.retention());
        read_started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("snapshot scan should start");
        let guard = store
            .try_lock()
            .expect("store mutex must be available during snapshot scan");
        drop(guard);
        resume_read_tx.send(()).expect("resume snapshot scan");

        assert_eq!(
            reader.join().expect("join snapshot scan").latest_seq,
            Some(2)
        );
    }

    #[test]
    fn read_snapshot_retention_scans_only_the_mixed_boundary_segment() {
        let now = 1_800_000_000_000;
        let clock = TestClock(Arc::new(Mutex::new(now - 3 * DAY_MS - 1)));
        let root = std::env::temp_dir().join(format!(
            "botified-timeline-snapshot-retention-bounds-{}-{}",
            std::process::id(),
            unique_stamp()
        ));
        let mut store = TimelineStore::open(
            TimelineStoreOptions::new(&root, Some("snapshot-retention-bounds"))
                .retention_days(3)
                .hot_event_capacity(1)
                .clock(clock.clone()),
        )
        .expect("open store");
        append_test_events(&mut store, TIMELINE_SPARSE_INDEX_STRIDE * 2);
        clock.set(now - 3 * DAY_MS + 1);
        let first_retained = append_test_events(&mut store, 5).remove(0);
        for day in 1..=3 {
            clock.set(now - (3 - day) * DAY_MS);
            append_test_events(&mut store, TIMELINE_SPARSE_INDEX_STRIDE * 2);
        }
        assert_eq!(store.segments.len(), 4);
        clock.set(now + 1);
        store.segment_reads.store(0, Ordering::Relaxed);
        store.reset_read_record_count();

        let retention = store.read_snapshot().retention();

        assert_eq!(retention.earliest_seq, Some(first_retained.seq));
        assert_eq!(store.segment_reads.load(Ordering::Relaxed), 1);
        assert_eq!(
            store.read_record_count(),
            TIMELINE_SPARSE_INDEX_STRIDE * 2 + 5,
            "retention fallback must fully scan only the mixed segment"
        );
        drop(store);
        fs::remove_dir_all(root).expect("clean snapshot retention test root");
    }

    #[test]
    fn snapshot_reads_pruned_unlinked_segment() {
        let base = 1_800_000_000_000;
        let clock = TestClock(Arc::new(Mutex::new(base)));
        let mut store = test_store("snapshot-pruned-segment", 1, clock.clone());
        let original = append_test_events(&mut store, 1).remove(0);
        store.clear_hot_cache_for_test();
        let original_path = store.segments[0].path.clone();
        let snapshot = store.read_snapshot();

        clock
            .0
            .lock()
            .map(|mut now| *now = base + DAY_MS + 1)
            .unwrap();
        append_test_events(&mut store, 1);
        assert!(
            !original_path.exists(),
            "append should prune the old segment"
        );

        let page = snapshot
            .tail(10)
            .expect("snapshot should retain the unlinked file");
        assert_eq!(page.events, [original]);
    }

    #[test]
    fn snapshot_ignores_later_append_that_is_rolled_back_and_truncated() {
        let clock = TestClock(Arc::new(Mutex::new(1_800_000_000_000)));
        let mut store = test_store("snapshot-append-rollback", 1, clock);
        let original = append_test_events(&mut store, 1).remove(0);
        store.clear_hot_cache_for_test();
        let rollback = SegmentRollbackState::from(store.segments[0].as_ref());
        let (read_started_tx, read_started_rx) = std::sync::mpsc::sync_channel(1);
        let (resume_read_tx, resume_read_rx) = std::sync::mpsc::sync_channel(1);
        let resume_read_rx = Arc::new(Mutex::new(resume_read_rx));
        store.set_segment_read_observer_for_test(move || {
            read_started_tx.send(()).unwrap();
            resume_read_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        });
        let snapshot = store.read_snapshot();

        append_test_events(&mut store, 1);
        let path = store.segments[0].path.clone();
        let reader = std::thread::spawn(move || snapshot.tail(10));
        read_started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("snapshot scan should start");
        rollback.restore(store.segments[0].as_ref());
        truncate_last_record(&path).expect("simulate append rollback truncate");
        resume_read_tx.send(()).unwrap();

        let page = reader
            .join()
            .unwrap()
            .expect("pre-append snapshot should not observe rollback truncation");
        assert_eq!(page.events, [original]);
    }

    #[test]
    fn segment_offsets_are_sparse_and_snapshot_does_not_clone_them() {
        let clock = TestClock(Arc::new(Mutex::new(1_800_000_000_000)));
        let mut store = test_store("sparse-offsets", 1, clock);
        append_test_events(&mut store, TIMELINE_SPARSE_INDEX_STRIDE * 4);
        assert!(store.segment_offset_count_for_test() <= 5);

        let snapshot = store.read_snapshot();
        let page_state = snapshot.snapshot_segment(0);
        let offsets = store.segment_offsets_for_test();
        assert!(
            Arc::ptr_eq(&page_state.sparse_offsets, &offsets),
            "page state must share the sparse offset allocation"
        );

        append_test_events(&mut store, 1);
        let after_first_anchor = store.segment_offsets_ptr_for_test();
        assert_ne!(after_first_anchor, Arc::as_ptr(&offsets));

        append_test_events(&mut store, TIMELINE_SPARSE_INDEX_STRIDE);
        assert_eq!(
            after_first_anchor,
            store.segment_offsets_ptr_for_test(),
            "only the first anchor overlapping an active page state should copy"
        );
        assert_eq!(page_state.sparse_offsets.len(), 4);
    }

    #[test]
    fn mixed_retention_tail_near_segment_end_parses_only_cutoff_stride_and_limit() {
        let now = 1_800_000_000_000;
        let clock = TestClock(Arc::new(Mutex::new(now - DAY_MS - 1)));
        let mut store = test_store("mixed-retention-sparse-cutoff", 1, clock.clone());
        append_test_events(&mut store, TIMELINE_SPARSE_INDEX_STRIDE * 8);
        clock.set(now - DAY_MS);
        append_test_events(&mut store, 5);
        clock.set(now);
        store.clear_hot_cache_for_test();

        store.reset_read_record_count();
        let page = store.tail(5).expect("mixed-retention tail");

        assert_eq!(page.events.len(), 5);
        assert!(
            store.read_record_count() <= 5 + TIMELINE_SPARSE_INDEX_STRIDE,
            "cutoff lookup must not scan the expired segment prefix"
        );
    }

    #[test]
    fn read_snapshot_defers_segment_io_until_reading() {
        let clock = TestClock(Arc::new(Mutex::new(1_800_000_000_000)));
        let mut store = test_store("snapshot-open-outside-lock", 1, clock);
        append_test_events(&mut store, 2);
        store.clear_hot_cache_for_test();
        let opens = Arc::new(AtomicUsize::new(0));
        store.set_segment_read_observer_for_test({
            let opens = opens.clone();
            move || {
                opens.fetch_add(1, AtomicOrdering::Relaxed);
            }
        });

        let snapshot = store.read_snapshot();
        assert_eq!(opens.load(AtomicOrdering::Relaxed), 0);
        assert_eq!(snapshot.tail(1).expect("snapshot tail").events.len(), 1);
        assert!(opens.load(AtomicOrdering::Relaxed) > 0);
    }

    #[test]
    fn hot_cache_bounds_remain_valid_only_until_earliest_retained_time() {
        let base = 1_800_000_000_000;
        let clock = TestClock(Arc::new(Mutex::new(base)));
        let mut store = test_store("moving-cutoff", 3, clock.clone());
        let events = append_test_events(&mut store, 3);

        clock.set(base + 1);
        store.segment_reads.store(0, Ordering::Relaxed);
        assert_eq!(store.tail(2).expect("tail before earliest").events.len(), 2);
        assert_eq!(
            store
                .read_forward(&events[0].cursor, 2)
                .expect("forward before earliest")
                .events
                .len(),
            2
        );
        assert_eq!(
            store
                .read_backward(&events[2].cursor, 2)
                .expect("backward before earliest")
                .events
                .len(),
            2
        );
        assert_eq!(store.segment_reads.load(Ordering::Relaxed), 0);

        clock.set(base + DAY_MS);
        store.segment_reads.store(0, Ordering::Relaxed);
        assert_eq!(
            store.tail(3).expect("tail at earliest cutoff").events.len(),
            3
        );
        assert_eq!(store.segment_reads.load(Ordering::Relaxed), 0);

        clock.set(base + DAY_MS + 1);
        store.segment_reads.store(0, Ordering::Relaxed);
        let expired = store.tail(2).expect("tail after earliest expired");
        assert!(expired.events.is_empty());
        assert_eq!(expired.history_boundary, HistoryBoundary::Expired);
        assert_eq!(
            store.segment_reads.load(Ordering::Relaxed),
            0,
            "segment metadata should prove that the retained range is empty"
        );

        clock.set(base - 1);
        store.segment_reads.store(0, Ordering::Relaxed);
        assert_eq!(
            store
                .tail(2)
                .expect("tail after clock rollback")
                .events
                .len(),
            2
        );
        assert!(store.segment_reads.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn repeated_appends_on_same_mixed_boundary_load_it_once() {
        let base = 1_800_000_000_000;
        let root = std::env::temp_dir().join(format!(
            "botified-timeline-boundary-cache-{}-{}",
            std::process::id(),
            unique_stamp()
        ));
        let clock = TestClock(Arc::new(Mutex::new(base - DAY_MS - 1)));
        let mut store = TimelineStore::open(
            TimelineStoreOptions::new(&root, Some("boundary-cache"))
                .retention_days(1)
                .clock(clock.clone()),
        )
        .expect("open store");
        let append = |store: &mut TimelineStore, event_type: String| {
            store
                .append(TimelineAppend::new(event_type, "test", Value::Null))
                .expect("append")
        };
        let projection_id = "callback-delivered:rollback-boundary";
        store
            .append_callback_projection(
                projection_id,
                TimelineAppend::new(
                    "subagent.callback_delivered",
                    "test",
                    serde_json::json!({"projection_id": projection_id}),
                ),
            )
            .expect("append callback")
            .expect("new callback");
        clock.set(base - DAY_MS);
        append(&mut store, "retained-boundary".to_owned());

        clock.set(base);
        append(&mut store, "first-current".to_owned());
        assert_eq!(store.boundary_segment_loads, 1);
        for index in 1..=16 {
            append(&mut store, format!("current-{index}"));
        }
        assert_eq!(store.boundary_segment_loads, 1);

        clock.set(base - 1);
        append(&mut store, "clock-rollback".to_owned());
        assert_eq!(store.retention().earliest_seq, Some(1));
        assert!(store
            .append_callback_projection(
                projection_id,
                TimelineAppend::new(
                    "subagent.callback_delivered",
                    "test",
                    serde_json::json!({"projection_id": projection_id}),
                ),
            )
            .expect("deduplicate restored callback")
            .is_none());
        assert_eq!(store.boundary_segment_loads, 1);

        drop(store);
        fs::remove_dir_all(root).expect("clean test root");
    }

    #[test]
    fn reopen_preloads_mixed_boundary_cache_without_reloading_on_first_append() {
        let day = 20_000 * DAY_MS;
        let eight_am = day + 8 * 60 * 60 * 1_000;
        let six_am = day + 6 * 60 * 60 * 1_000;
        let next_day_seven_am = day + DAY_MS + 7 * 60 * 60 * 1_000;
        let root = std::env::temp_dir().join(format!(
            "botified-timeline-reopen-boundary-cache-{}-{}",
            std::process::id(),
            unique_stamp()
        ));
        let clock = TestClock(Arc::new(Mutex::new(eight_am)));
        let options = || {
            TimelineStoreOptions::new(&root, Some("reopen-boundary-cache"))
                .retention_days(1)
                .clock(clock.clone())
        };
        let callback = |id: &str| {
            TimelineAppend::new(
                "subagent.callback_delivered",
                "test",
                serde_json::json!({"projection_id": id}),
            )
        };
        let retained_id = "callback-delivered:reopen-retained-eight";
        let expired_id = "callback-delivered:reopen-expired-six";
        let mut store = TimelineStore::open(options()).expect("open initial store");
        let retained = store
            .append_callback_projection(retained_id, callback(retained_id))
            .expect("append retained callback")
            .expect("new retained callback");
        clock.set(six_am);
        store
            .append_callback_projection(expired_id, callback(expired_id))
            .expect("append expired callback")
            .expect("new expired callback");
        clock.set(next_day_seven_am);
        let current = append_test_events(&mut store, 1).remove(0);
        drop(store);

        let mut reopened = TimelineStore::open(options()).expect("reopen mixed boundary store");
        assert_eq!(reopened.boundary_segment_loads, 0);
        assert_eq!(reopened.retention().earliest_seq, Some(retained.seq));
        assert_eq!(reopened.retention().latest_seq, Some(current.seq));
        assert_eq!(
            reopened
                .tail(10)
                .expect("tail after mixed boundary reopen")
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            [retained.seq, current.seq]
        );

        let first_after_reopen = append_test_events(&mut reopened, 1).remove(0);
        assert_eq!(reopened.boundary_segment_loads, 0);
        assert!(reopened
            .append_callback_projection(retained_id, callback(retained_id))
            .expect("deduplicate retained callback after reopen")
            .is_none());
        let replacement = reopened
            .append_callback_projection(expired_id, callback(expired_id))
            .expect("reuse expired callback after reopen")
            .expect("expired callback should append again");
        assert_eq!(reopened.retention().earliest_seq, Some(retained.seq));
        assert_eq!(reopened.retention().latest_seq, Some(replacement.seq));
        assert_eq!(
            reopened
                .tail(10)
                .expect("tail after callback checks")
                .events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            [
                retained.seq,
                current.seq,
                first_after_reopen.seq,
                replacement.seq,
            ]
        );

        drop(reopened);
        fs::remove_dir_all(root).expect("clean test root");
    }
}
