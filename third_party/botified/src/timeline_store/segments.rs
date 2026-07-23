use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::FileExt;
#[cfg(windows)]
use std::os::windows::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;

use crate::private_fs::{ensure_private_dir, open_private_file, private_open_options};

use super::{sync_dir, valid_record, TimelineStoreError, TimelineStoreRecord};

pub(super) const SEGMENTS_DIR: &str = "segments";
const CORRUPT_SEGMENTS_DIR: &str = "corrupt_segments";
const REPAIR_TMP_PREFIX: &str = ".timeline-repair-";
const QUARANTINE_TMP_PREFIX: &str = ".quarantine-";
pub(super) const TIMELINE_SPARSE_INDEX_STRIDE: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PhysicalSegment {
    pub(super) ordinal: u64,
    pub(super) date: String,
    pub(super) path: PathBuf,
}

impl PhysicalSegment {
    pub(super) fn new(segments_dir: &Path, ordinal: u64, date: String) -> Self {
        Self {
            ordinal,
            path: segments_dir.join(format!("{ordinal:020}-{date}.jsonl")),
            date,
        }
    }
}

#[derive(Debug)]
pub(super) struct SegmentMetadata {
    pub(super) path: PathBuf,
    file: Arc<File>,
    pub(super) state: RwLock<SegmentMetadataState>,
    pub(super) sparse_offsets: RwLock<Arc<Vec<SparseOffset>>>,
}

#[derive(Debug, Clone)]
pub(super) struct SegmentMetadataState {
    pub(super) min_append_time_unix_ms: i64,
    pub(super) max_append_time_unix_ms: i64,
    pub(super) first_seq: u64,
    pub(super) first_cursor: String,
    pub(super) last_seq: u64,
    pub(super) last_cursor: String,
    pub(super) record_count: usize,
    pub(super) valid_len: u64,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct SparseOffset {
    pub(super) seq: u64,
    pub(super) append_time_unix_ms: i64,
    pub(super) offset: u64,
}

#[derive(Debug)]
pub(super) struct SnapshotSegment {
    pub(super) path: PathBuf,
    pub(super) file: Arc<File>,
    pub(super) state: SegmentMetadataState,
    pub(super) sparse_offsets: Arc<Vec<SparseOffset>>,
}

impl SnapshotSegment {
    pub(super) fn new(segment: &SegmentMetadata) -> Self {
        let state = segment
            .state
            .read()
            .expect("timeline segment metadata lock poisoned")
            .clone();
        let sparse_offsets = segment
            .sparse_offsets
            .read()
            .expect("timeline sparse offsets lock poisoned")
            .clone();
        Self {
            path: segment.path.clone(),
            file: Arc::clone(&segment.file),
            state,
            sparse_offsets,
        }
    }
}

pub(super) struct PositionedFileReader {
    file: Arc<File>,
    offset: u64,
    remaining: u64,
}

impl PositionedFileReader {
    pub(super) fn new(file: Arc<File>, offset: u64, remaining: u64) -> Self {
        Self {
            file,
            offset,
            remaining,
        }
    }
}

impl Read for PositionedFileReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let len = buffer
            .len()
            .min(self.remaining.min(usize::MAX as u64) as usize);
        let read = positioned_read(&self.file, &mut buffer[..len], self.offset)?;
        self.offset = self.offset.saturating_add(read as u64);
        self.remaining = self.remaining.saturating_sub(read as u64);
        Ok(read)
    }
}

#[cfg(unix)]
fn positioned_read(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    file.read_at(buffer, offset)
}

#[cfg(windows)]
fn positioned_read(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    file.seek_read(buffer, offset)
}

#[cfg(test)]
pub(super) struct SegmentRollbackState {
    min_append_time_unix_ms: i64,
    max_append_time_unix_ms: i64,
    last_seq: u64,
    last_cursor: String,
    record_count: usize,
    valid_len: u64,
    sparse_offset_len: usize,
}

#[cfg(test)]
impl From<&SegmentMetadata> for SegmentRollbackState {
    fn from(segment: &SegmentMetadata) -> Self {
        let state = segment
            .state
            .read()
            .expect("timeline segment metadata lock poisoned");
        Self {
            min_append_time_unix_ms: state.min_append_time_unix_ms,
            max_append_time_unix_ms: state.max_append_time_unix_ms,
            last_seq: state.last_seq,
            last_cursor: state.last_cursor.clone(),
            record_count: state.record_count,
            valid_len: state.valid_len,
            sparse_offset_len: segment
                .sparse_offsets
                .read()
                .expect("timeline sparse offsets lock poisoned")
                .len(),
        }
    }
}

#[cfg(test)]
impl SegmentRollbackState {
    pub(super) fn restore(self, segment: &SegmentMetadata) {
        let mut state = segment
            .state
            .write()
            .expect("timeline segment metadata lock poisoned");
        state.min_append_time_unix_ms = self.min_append_time_unix_ms;
        state.max_append_time_unix_ms = self.max_append_time_unix_ms;
        state.last_seq = self.last_seq;
        state.last_cursor = self.last_cursor;
        state.record_count = self.record_count;
        state.valid_len = self.valid_len;
        let mut sparse_offsets = segment
            .sparse_offsets
            .write()
            .expect("timeline sparse offsets lock poisoned");
        Arc::make_mut(&mut sparse_offsets).truncate(self.sparse_offset_len);
    }
}

impl SegmentMetadata {
    pub(super) fn from_record(
        path: PathBuf,
        file: Arc<File>,
        record: &TimelineStoreRecord,
        start: u64,
        end: u64,
    ) -> Self {
        Self {
            path,
            file,
            state: RwLock::new(SegmentMetadataState {
                min_append_time_unix_ms: record.append_time_unix_ms,
                max_append_time_unix_ms: record.append_time_unix_ms,
                first_seq: record.envelope.seq,
                first_cursor: record.envelope.cursor.clone(),
                last_seq: record.envelope.seq,
                last_cursor: record.envelope.cursor.clone(),
                record_count: 1,
                valid_len: end,
            }),
            sparse_offsets: RwLock::new(Arc::new(vec![SparseOffset {
                seq: record.envelope.seq,
                append_time_unix_ms: record.append_time_unix_ms,
                offset: start,
            }])),
        }
    }

    pub(super) fn push(&self, record: &TimelineStoreRecord, start: u64, end: u64) {
        let mut state = self
            .state
            .write()
            .expect("timeline segment metadata lock poisoned");
        state.min_append_time_unix_ms = state
            .min_append_time_unix_ms
            .min(record.append_time_unix_ms);
        state.max_append_time_unix_ms = state
            .max_append_time_unix_ms
            .max(record.append_time_unix_ms);
        if record.envelope.seq < state.first_seq {
            state.first_seq = record.envelope.seq;
            state.first_cursor = record.envelope.cursor.clone();
        }
        if record.envelope.seq >= state.last_seq {
            state.last_seq = record.envelope.seq;
            state.last_cursor = record.envelope.cursor.clone();
        }
        if state
            .record_count
            .is_multiple_of(TIMELINE_SPARSE_INDEX_STRIDE)
        {
            Arc::make_mut(
                &mut self
                    .sparse_offsets
                    .write()
                    .expect("timeline sparse offsets lock poisoned"),
            )
            .push(SparseOffset {
                seq: record.envelope.seq,
                append_time_unix_ms: record.append_time_unix_ms,
                offset: start,
            });
        }
        state.record_count += 1;
        state.valid_len = end;
    }
}

#[derive(Debug)]
pub(super) struct SegmentRead {
    pub(super) records: Vec<TimelineStoreRecord>,
    pub(super) invalid_offset: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SegmentVisit {
    Complete,
    Stopped,
    Invalid,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct JsonlScanResult {
    pub(super) visit: SegmentVisit,
    pub(super) invalid_offset: Option<u64>,
    pub(super) invalid_unterminated: bool,
}

pub(super) fn scan_jsonl_records<T: DeserializeOwned>(
    path: &Path,
    valid: impl Fn(&T) -> bool,
    mut visit: impl FnMut(T) -> bool,
) -> Result<JsonlScanResult, TimelineStoreError> {
    scan_jsonl_records_with_offsets(path, valid, |record, _, _| visit(record))
}

pub(super) fn scan_jsonl_records_with_offsets<T: DeserializeOwned>(
    path: &Path,
    valid: impl Fn(&T) -> bool,
    mut visit: impl FnMut(T, u64, u64) -> bool,
) -> Result<JsonlScanResult, TimelineStoreError> {
    let file = File::open(path).map_err(|source| TimelineStoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut reader = BufReader::new(file);
    let mut offset = 0_u64;

    loop {
        let line_start = offset;
        let mut line = Vec::new();
        let read =
            reader
                .read_until(b'\n', &mut line)
                .map_err(|source| TimelineStoreError::Io {
                    path: path.to_path_buf(),
                    source,
                })?;
        if read == 0 {
            return Ok(JsonlScanResult {
                visit: SegmentVisit::Complete,
                invalid_offset: None,
                invalid_unterminated: false,
            });
        }
        offset += read as u64;
        let terminated = line.last() == Some(&b'\n');
        if !terminated {
            return Ok(JsonlScanResult {
                visit: SegmentVisit::Invalid,
                invalid_offset: Some(line_start),
                invalid_unterminated: true,
            });
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let Some(record) = serde_json::from_slice::<T>(&line).ok().filter(&valid) else {
            return Ok(JsonlScanResult {
                visit: SegmentVisit::Invalid,
                invalid_offset: Some(line_start),
                invalid_unterminated: false,
            });
        };
        if !visit(record, line_start, offset) {
            return Ok(JsonlScanResult {
                visit: SegmentVisit::Stopped,
                invalid_offset: None,
                invalid_unterminated: false,
            });
        }
    }
}

pub(super) fn read_segment_records(path: &Path) -> Result<SegmentRead, TimelineStoreError> {
    let mut records = Vec::new();
    let result = scan_jsonl_records(path, valid_record, |record| {
        records.push(record);
        true
    })?;
    Ok(SegmentRead {
        records,
        invalid_offset: result.invalid_offset,
    })
}

pub(super) fn visit_segment_records(
    path: &Path,
    visit: impl FnMut(TimelineStoreRecord) -> bool,
) -> Result<SegmentVisit, TimelineStoreError> {
    scan_jsonl_records(path, valid_record, visit).map(|result| result.visit)
}

pub(super) fn recover_corrupt_suffix(
    segments_dir: &Path,
    paths: &[PathBuf],
    corrupt_index: usize,
    valid_len: u64,
) -> Result<(), TimelineStoreError> {
    let timeline_dir = segments_dir.parent().unwrap_or_else(|| Path::new("."));
    let quarantine_dir = timeline_dir.join(CORRUPT_SEGMENTS_DIR);
    let quarantine_exists = quarantine_dir.exists();
    ensure_private_dir(&quarantine_dir).map_err(|source| TimelineStoreError::Io {
        path: quarantine_dir.clone(),
        source,
    })?;
    if !quarantine_exists {
        sync_dir(timeline_dir).map_err(|source| TimelineStoreError::Io {
            path: timeline_dir.to_path_buf(),
            source,
        })?;
    }

    for path in paths.iter().skip(corrupt_index + 1) {
        let target = unique_quarantine_path(&quarantine_dir, path);
        fs::rename(path, &target).map_err(|source| TimelineStoreError::Io {
            path: path.clone(),
            source,
        })?;
        sync_dir(&quarantine_dir).map_err(|source| TimelineStoreError::Io {
            path: quarantine_dir.clone(),
            source,
        })?;
        sync_dir(segments_dir).map_err(|source| TimelineStoreError::Io {
            path: segments_dir.to_path_buf(),
            source,
        })?;
    }

    let corrupt_path = &paths[corrupt_index];
    publish_quarantine_suffix(&quarantine_dir, corrupt_path, valid_len)?;
    publish_valid_prefix(corrupt_path, valid_len)
}

fn publish_valid_prefix(path: &Path, valid_len: u64) -> Result<(), TimelineStoreError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp_path = parent.join(format!(
        "{REPAIR_TMP_PREFIX}{}-{}.tmp",
        std::process::id(),
        unique_stamp()
    ));
    let mut source = File::open(path).map_err(|source| TimelineStoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if let Err(error) = write_synced_new_file_from(&tmp_path, (&mut source).take(valid_len)) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }
    drop(source);
    if let Err(source) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        });
    }
    sync_dir(parent).map_err(|source| TimelineStoreError::Io {
        path: parent.to_path_buf(),
        source,
    })
}

fn publish_quarantine_suffix(
    dir: &Path,
    source: &Path,
    valid_len: u64,
) -> Result<(), TimelineStoreError> {
    let target = unique_quarantine_path(dir, source);
    let tmp = dir.join(format!(
        "{QUARANTINE_TMP_PREFIX}{}-{}.tmp",
        std::process::id(),
        unique_stamp()
    ));
    let mut source_file = File::open(source).map_err(|error| TimelineStoreError::Io {
        path: source.to_path_buf(),
        source: error,
    })?;
    source_file
        .seek(SeekFrom::Start(valid_len))
        .map_err(|error| TimelineStoreError::Io {
            path: source.to_path_buf(),
            source: error,
        })?;
    if let Err(error) = write_synced_new_file_from(&tmp, source_file) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if let Err(source) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(TimelineStoreError::Io {
            path: target,
            source,
        });
    }
    sync_dir(dir).map_err(|source| TimelineStoreError::Io {
        path: dir.to_path_buf(),
        source,
    })
}

fn write_synced_new_file_from(
    path: &Path,
    mut source: impl Read,
) -> Result<(), TimelineStoreError> {
    let mut options = private_open_options();
    options.create_new(true).write(true);
    let mut file = open_private_file(&options, path).map_err(|source| TimelineStoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    io::copy(&mut source, &mut file)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_data())
        .map_err(|source| TimelineStoreError::Io {
            path: path.to_path_buf(),
            source,
        })
}

fn unique_quarantine_path(dir: &Path, source: &Path) -> PathBuf {
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("segment.jsonl");
    dir.join(format!(
        "{name}.corrupt.{}.{}",
        std::process::id(),
        unique_stamp()
    ))
}

pub(super) fn unique_stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

pub(super) fn cleanup_recovery_temps(timeline_dir: &Path, segments_dir: &Path) {
    cleanup_temp_files(segments_dir, REPAIR_TMP_PREFIX);
    cleanup_temp_files(
        &timeline_dir.join(CORRUPT_SEGMENTS_DIR),
        QUARANTINE_TMP_PREFIX,
    );
}

fn cleanup_temp_files(dir: &Path, prefix: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut removed = false;
    for entry in entries.flatten() {
        let path = entry.path();
        let owned_tmp = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with(prefix) && name.ends_with(".tmp"))
            .unwrap_or(false);
        if owned_tmp {
            removed |= fs::remove_file(path).is_ok();
        }
    }
    if removed {
        let _ = sync_dir(dir);
    }
}

pub(super) fn invalid_segment_data_error(path: &Path) -> TimelineStoreError {
    TimelineStoreError::Io {
        path: path.to_path_buf(),
        source: io::Error::new(io::ErrorKind::InvalidData, "corrupt timeline segment"),
    }
}

pub(super) fn migrate_legacy_segments(segments_dir: &Path) -> Result<(), TimelineStoreError> {
    let mut legacy = Vec::<(String, PathBuf)>::new();
    let mut max_ordinal = None::<u64>;
    let entries = fs::read_dir(segments_dir).map_err(|source| TimelineStoreError::Io {
        path: segments_dir.to_path_buf(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| TimelineStoreError::Io {
            path: segments_dir.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
            continue;
        }
        if let Ok(segment) = parse_segment_path(&path) {
            max_ordinal = Some(
                max_ordinal
                    .map(|ordinal| ordinal.max(segment.ordinal))
                    .unwrap_or(segment.ordinal),
            );
            continue;
        }
        let date = parse_legacy_segment_date(&path)
            .ok_or_else(|| invalid_segment_path(&path))?
            .to_owned();
        legacy.push((date, path));
    }
    legacy.sort_by(|left, right| left.0.cmp(&right.0));
    if legacy.is_empty() {
        return Ok(());
    }

    let mut next_ordinal = match max_ordinal {
        Some(ordinal) => ordinal.checked_add(1).ok_or_else(|| {
            ordinal_overflow_error(&segments_dir.join(format!("{ordinal:020}")), ordinal)
        })?,
        None => 0,
    };
    for (index, (date, source_path)) in legacy.iter().enumerate() {
        let target = PhysicalSegment::new(segments_dir, next_ordinal, date.clone()).path;
        if target.exists() {
            return Err(invalid_segment_path(&target));
        }
        fs::rename(source_path, &target).map_err(|source| TimelineStoreError::Io {
            path: source_path.clone(),
            source,
        })?;
        sync_dir(segments_dir).map_err(|source| TimelineStoreError::Io {
            path: segments_dir.to_path_buf(),
            source,
        })?;
        if index + 1 < legacy.len() {
            next_ordinal = next_ordinal
                .checked_add(1)
                .ok_or_else(|| ordinal_overflow_error(&target, next_ordinal))?;
        }
    }
    Ok(())
}

fn parse_legacy_segment_date(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?;
    if !name.is_ascii() || name.len() != 16 || &name[10..] != ".jsonl" {
        return None;
    }
    let date = &name[..10];
    valid_utc_date_name(date).then_some(date)
}

pub(super) fn segment_paths(segments_dir: &Path) -> Result<Vec<PathBuf>, TimelineStoreError> {
    let mut segments = Vec::new();
    match fs::read_dir(segments_dir) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|source| TimelineStoreError::Io {
                    path: segments_dir.to_path_buf(),
                    source,
                })?;
                let path = entry.path();
                if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
                    segments.push(parse_segment_path(&path)?);
                }
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(TimelineStoreError::Io {
                path: segments_dir.to_path_buf(),
                source,
            });
        }
    }
    segments.sort_by_key(|segment| segment.ordinal);
    for pair in segments.windows(2) {
        if pair[0].ordinal == pair[1].ordinal {
            return Err(invalid_segment_path(&pair[1].path));
        }
    }
    Ok(segments.into_iter().map(|segment| segment.path).collect())
}

pub(super) fn parse_segment_path(path: &Path) -> Result<PhysicalSegment, TimelineStoreError> {
    let invalid = || invalid_segment_path(path);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(invalid)?;
    if !name.is_ascii() || name.len() != 37 || &name[20..21] != "-" || &name[31..] != ".jsonl" {
        return Err(invalid());
    }
    let ordinal_text = &name[..20];
    let date = &name[21..31];
    if !ordinal_text.bytes().all(|byte| byte.is_ascii_digit()) || !valid_utc_date_name(date) {
        return Err(invalid());
    }
    let ordinal = ordinal_text.parse::<u64>().map_err(|_| invalid())?;
    Ok(PhysicalSegment {
        ordinal,
        date: date.to_owned(),
        path: path.to_path_buf(),
    })
}

pub(super) fn latest_physical_segment(
    segments_dir: &Path,
) -> Result<Option<PhysicalSegment>, TimelineStoreError> {
    segment_paths(segments_dir)?
        .last()
        .map(|path| parse_segment_path(path))
        .transpose()
}

fn invalid_segment_path(path: &Path) -> TimelineStoreError {
    TimelineStoreError::Io {
        path: path.to_path_buf(),
        source: io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid timeline segment filename",
        ),
    }
}

fn ordinal_overflow_error(path: &Path, ordinal: u64) -> TimelineStoreError {
    TimelineStoreError::Io {
        path: path.to_path_buf(),
        source: io::Error::other(format!("timeline segment ordinal overflow after {ordinal}")),
    }
}

fn valid_utc_date_name(date: &str) -> bool {
    if date.len() != 10 || &date[4..5] != "-" || &date[7..8] != "-" {
        return false;
    }
    let year = date[..4].parse::<u32>().ok();
    let month = date[5..7].parse::<u32>().ok();
    let day = date[8..10].parse::<u32>().ok();
    let (Some(year), Some(month), Some(day)) = (year, month, day) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max_day).contains(&day)
}

#[cfg(test)]
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

#[cfg(test)]
pub(super) fn truncate_last_record(path: &Path) -> Result<(), TimelineStoreError> {
    let mut options = private_open_options();
    options.read(true).write(true);
    let mut file = open_private_file(&options, path).map_err(|source| TimelineStoreError::Io {
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
