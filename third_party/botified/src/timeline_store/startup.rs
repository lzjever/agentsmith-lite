use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use super::meta::MetaRead;
use super::segments::{
    invalid_segment_data_error, parse_segment_path, recover_corrupt_suffix, scan_jsonl_records,
    scan_jsonl_records_with_offsets, segment_paths, PhysicalSegment, SegmentMetadata, SegmentVisit,
};
use super::{
    callback_projection_id, record_instance, recovery_range, valid_record, BoundaryCache,
    BoundaryEntry, RecoveryRange, RetainedBounds, TimelineStoreError, TimelineStoreRecord,
};

#[derive(Debug)]
pub(super) struct SegmentSummaryScan {
    pub(super) paths: Vec<PhysicalSegment>,
    pub(super) physical_segment_max_append_times: HashMap<PathBuf, i64>,
    pub(super) instances: HashMap<String, InstanceSummary>,
    instance_sequences: HashMap<String, Vec<SequenceEntry>>,
    pub(super) recovery_ranges: Vec<InstanceRecoveryRange>,
    pub(super) namespace_record_count: usize,
    pub(super) ambiguous: bool,
    pub(super) repaired_torn_tail: bool,
}

#[derive(Debug, Clone, Copy)]
struct SequenceEntry {
    seq: u64,
    recovery: Option<RecoveryRange>,
    is_recovery_record: bool,
}

#[derive(Debug, Clone)]
pub(super) struct InstanceRecoveryRange {
    pub(super) instance: String,
    pub(super) range: RecoveryRange,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct InstanceSummary {
    pub(super) latest_seq: u64,
    latest_seq_append_time_unix_ms: i64,
    pub(super) max_append_time_unix_ms: i64,
}

impl Default for InstanceSummary {
    fn default() -> Self {
        Self {
            latest_seq: 0,
            latest_seq_append_time_unix_ms: i64::MIN,
            max_append_time_unix_ms: i64::MIN,
        }
    }
}

impl InstanceSummary {
    fn push(&mut self, record: &TimelineStoreRecord) {
        if record.envelope.seq > self.latest_seq
            || (record.envelope.seq == self.latest_seq
                && record.append_time_unix_ms > self.latest_seq_append_time_unix_ms)
        {
            self.latest_seq = record.envelope.seq;
            self.latest_seq_append_time_unix_ms = record.append_time_unix_ms;
        }
        self.max_append_time_unix_ms = self.max_append_time_unix_ms.max(record.append_time_unix_ms);
    }
}

pub(super) struct StartupIndexes {
    pub(super) hot_cache: VecDeque<TimelineStoreRecord>,
    pub(super) segments: Vec<Arc<SegmentMetadata>>,
    pub(super) boundary_cache: Option<BoundaryCache>,
    pub(super) retained_bounds: RetainedBounds,
    pub(super) callback_projection_ids: HashMap<String, PathBuf>,
}

pub(super) fn summarize_segments(
    segments_dir: &Path,
    repair_latest: bool,
) -> Result<SegmentSummaryScan, TimelineStoreError> {
    let paths = segment_paths(segments_dir)?;
    let mut physical_segment_max_append_times = HashMap::new();
    let mut instances = HashMap::<String, InstanceSummary>::new();
    let mut instance_sequences = HashMap::<String, Vec<SequenceEntry>>::new();
    let mut namespace_record_count = 0;
    let mut ambiguous = false;
    let mut recovery_ranges = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let result = scan_jsonl_records_with_offsets(path, valid_record, |record, _, _| {
            namespace_record_count += 1;
            physical_segment_max_append_times
                .entry(path.clone())
                .and_modify(|max_time: &mut i64| {
                    *max_time = (*max_time).max(record.append_time_unix_ms)
                })
                .or_insert(record.append_time_unix_ms);
            if let Some(instance) = record_instance(&record.envelope) {
                let recovery = recovery_range(&record);
                instance_sequences
                    .entry(instance.clone())
                    .or_default()
                    .push(SequenceEntry {
                        seq: record.envelope.seq,
                        recovery,
                        is_recovery_record: record.envelope.event_type
                            == super::RECOVERY_EVENT_TYPE,
                    });
                if let Some(range) = recovery {
                    recovery_ranges.push(InstanceRecoveryRange {
                        instance: instance.clone(),
                        range,
                    });
                }
                instances.entry(instance).or_default().push(&record);
            } else {
                ambiguous = true;
            }
            true
        })?;
        if let Some(invalid_offset) = result.invalid_offset {
            let safe_torn_tail =
                repair_latest && index + 1 == paths.len() && result.invalid_unterminated;
            if safe_torn_tail {
                recover_corrupt_suffix(segments_dir, &paths, index, invalid_offset)?;
                let mut rescanned = summarize_segments(segments_dir, false)?;
                rescanned.repaired_torn_tail = true;
                return Ok(rescanned);
            } else {
                ambiguous = true;
            }
            break;
        }
    }
    Ok(SegmentSummaryScan {
        paths: segment_paths(segments_dir)?
            .iter()
            .map(|path| parse_segment_path(path))
            .collect::<Result<Vec<_>, _>>()?,
        physical_segment_max_append_times,
        instances,
        instance_sequences,
        recovery_ranges,
        namespace_record_count,
        ambiguous,
        repaired_torn_tail: false,
    })
}

pub(super) fn build_startup_indexes(
    paths: &[PhysicalSegment],
    instance: &str,
    cutoff: i64,
    hot_event_capacity: usize,
) -> Result<StartupIndexes, TimelineStoreError> {
    let mut segments = Vec::new();
    let mut boundary_path = None;
    let mut retained_bounds = RetainedBounds::new(cutoff);
    let mut callback_candidates = HashMap::<String, (u64, u64, PathBuf)>::new();
    let mut hot_candidates = BTreeMap::<(u64, u64), TimelineStoreRecord>::new();
    let mut scan_order = 0_u64;

    for physical in paths {
        let path = &physical.path;
        let read_handle = Arc::new(File::open(path).map_err(|source| TimelineStoreError::Io {
            path: path.clone(),
            source,
        })?);
        let mut metadata = None::<SegmentMetadata>;
        let result = scan_jsonl_records_with_offsets(path, valid_record, |record, start, end| {
            if record_instance(&record.envelope).as_deref() != Some(instance) {
                return true;
            }
            scan_order = scan_order.saturating_add(1);
            if let Some(segment) = &mut metadata {
                segment.push(&record, start, end);
            } else {
                metadata = Some(SegmentMetadata::from_record(
                    path.clone(),
                    Arc::clone(&read_handle),
                    &record,
                    start,
                    end,
                ));
            }
            if record.append_time_unix_ms >= cutoff {
                retained_bounds.push(&record);
                if let Some(id) = callback_projection_id(&record) {
                    let candidate = (record.envelope.seq, scan_order, path.clone());
                    if callback_candidates
                        .get(&id)
                        .map(|current| (current.0, current.1) <= (candidate.0, candidate.1))
                        .unwrap_or(true)
                    {
                        callback_candidates.insert(id, candidate);
                    }
                }
                hot_candidates.insert((record.envelope.seq, scan_order), record);
                if hot_candidates.len() > hot_event_capacity {
                    hot_candidates.pop_first();
                }
            }
            true
        })?;
        if result.visit == SegmentVisit::Invalid {
            return Err(invalid_segment_data_error(path));
        }
        if let Some(metadata) = metadata {
            let is_boundary = {
                let state = metadata
                    .state
                    .read()
                    .expect("timeline segment metadata lock poisoned");
                state.min_append_time_unix_ms < cutoff && state.max_append_time_unix_ms >= cutoff
            };
            if boundary_path.is_none() && is_boundary {
                boundary_path = Some(path.clone());
            }
            segments.push(Arc::new(metadata));
        }
    }

    let boundary_cache = boundary_path
        .map(|path| load_startup_boundary_cache(path, instance))
        .transpose()?;
    let hot_cache = hot_candidates.into_values().collect();
    let callback_projection_ids = callback_candidates
        .into_iter()
        .map(|(id, (_, _, path))| (id, path))
        .collect();
    Ok(StartupIndexes {
        hot_cache,
        segments,
        boundary_cache,
        retained_bounds,
        callback_projection_ids,
    })
}

fn load_startup_boundary_cache(
    path: PathBuf,
    instance: &str,
) -> Result<BoundaryCache, TimelineStoreError> {
    let mut entries = Vec::new();
    let result = scan_jsonl_records(&path, valid_record, |record| {
        if record_instance(&record.envelope).as_deref() == Some(instance) {
            entries.push(BoundaryEntry::from_record(&record));
        }
        true
    })?;
    if result.visit == SegmentVisit::Invalid {
        return Err(invalid_segment_data_error(&path));
    }
    Ok(BoundaryCache::with_entries(path, entries))
}

pub(super) struct StartupIdentity {
    pub(super) instance: String,
    pub(super) latest_seq: u64,
}

pub(super) fn choose_instance_from_summaries(
    meta: &MetaRead,
    scan: &SegmentSummaryScan,
) -> Option<StartupIdentity> {
    if scan.ambiguous {
        return None;
    }
    match meta {
        MetaRead::Valid(meta) => {
            if scan.namespace_record_count == 0 {
                return Some(StartupIdentity {
                    instance: meta.instance.clone(),
                    latest_seq: meta.latest_seq,
                });
            }
            let sequences = scan.instance_sequences.get(&meta.instance)?;
            if !continuous(sequences) {
                return None;
            }
            if meta.latest_seq < sequences[0].seq.saturating_sub(1) {
                return None;
            }
            let records_latest = sequences.last()?.seq;
            if records_latest < meta.latest_seq && !scan.repaired_torn_tail {
                return None;
            }
            Some(StartupIdentity {
                instance: meta.instance.clone(),
                latest_seq: records_latest.max(meta.latest_seq),
            })
        }
        MetaRead::Missing | MetaRead::Invalid => {
            if scan.namespace_record_count == 0 {
                return Some(StartupIdentity {
                    instance: generate_timeline_instance(),
                    latest_seq: 0,
                });
            }
            if scan.instance_sequences.len() != 1 {
                return None;
            }
            let (instance, sequences) = scan.instance_sequences.iter().next()?;
            continuous(sequences).then(|| StartupIdentity {
                instance: instance.clone(),
                latest_seq: sequences.last().expect("non-empty instance records").seq,
            })
        }
    }
}

fn continuous(sequences: &[SequenceEntry]) -> bool {
    !sequences.is_empty()
        && sequences
            .first()
            .is_some_and(|entry| !entry.is_recovery_record || entry.recovery.is_some())
        && sequences.windows(2).all(|pair| {
            let previous = pair[0];
            let next = pair[1];
            if previous.seq.checked_add(1) == Some(next.seq) {
                return !next.is_recovery_record;
            }
            next.recovery.is_some_and(|range| {
                previous.seq.checked_add(1) == Some(range.start)
                    && range.end.checked_add(1) == Some(next.seq)
            })
        })
}

pub(super) fn detach_active_timeline(timeline_dir: &Path) -> Result<(), TimelineStoreError> {
    let parent = timeline_dir.parent().unwrap_or_else(|| Path::new("."));
    let name = timeline_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("timeline");
    let target = parent.join(format!(
        ".{name}.quarantine-{}-{}",
        std::process::id(),
        unique_stamp()
    ));
    fs::rename(timeline_dir, &target).map_err(|source| TimelineStoreError::Io {
        path: timeline_dir.to_path_buf(),
        source,
    })?;
    super::sync_dir(parent).map_err(|source| TimelineStoreError::Io {
        path: parent.to_path_buf(),
        source,
    })
}

fn unique_stamp() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
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
