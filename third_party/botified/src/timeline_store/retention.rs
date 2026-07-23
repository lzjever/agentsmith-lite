use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::segments::{latest_physical_segment, read_segment_records};
use super::{
    callback_projection_id, record_instance, TimelineRetentionSnapshot, TimelineStore,
    TimelineStoreError, TimelineStoreRecord,
};

#[derive(Debug, Clone)]
pub(super) struct BoundaryEntry {
    append_time_unix_ms: i64,
    seq: u64,
    cursor: String,
    projection_id: Option<String>,
}

impl BoundaryEntry {
    pub(super) fn from_record(record: &TimelineStoreRecord) -> Self {
        Self {
            append_time_unix_ms: record.append_time_unix_ms,
            seq: record.envelope.seq,
            cursor: record.envelope.cursor.clone(),
            projection_id: callback_projection_id(record),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct BoundaryCache {
    pub(super) path: PathBuf,
    entries: Vec<BoundaryEntry>,
    retained_start: usize,
}

impl BoundaryCache {
    fn from_records(path: PathBuf, records: Vec<TimelineStoreRecord>) -> Self {
        let entries = records.iter().map(BoundaryEntry::from_record).collect();
        Self::with_entries(path, entries)
    }

    pub(super) fn with_entries(path: PathBuf, mut entries: Vec<BoundaryEntry>) -> Self {
        entries.sort_by_key(|entry| (entry.append_time_unix_ms, entry.seq));
        Self {
            path,
            entries,
            retained_start: 0,
        }
    }

    pub(super) fn push(&mut self, record: &TimelineStoreRecord, cutoff: i64) {
        self.entries.push(BoundaryEntry::from_record(record));
        self.entries
            .sort_by_key(|entry| (entry.append_time_unix_ms, entry.seq));
        self.reposition(cutoff);
    }

    fn reposition(&mut self, cutoff: i64) {
        self.retained_start = self
            .entries
            .partition_point(|entry| entry.append_time_unix_ms < cutoff);
    }

    fn retained_entries(&self) -> &[BoundaryEntry] {
        &self.entries[self.retained_start..]
    }
}

#[derive(Debug, Clone, Default)]
pub(super) struct RetainedBounds {
    pub(super) cutoff_unix_ms: i64,
    pub(super) earliest_seq: Option<u64>,
    earliest_cursor: Option<String>,
    pub(super) earliest_append_time_unix_ms: Option<i64>,
    pub(super) latest_seq: Option<u64>,
    latest_cursor: Option<String>,
}

impl RetainedBounds {
    pub(super) fn new(cutoff_unix_ms: i64) -> Self {
        Self {
            cutoff_unix_ms,
            ..Self::default()
        }
    }

    pub(super) fn push(&mut self, record: &TimelineStoreRecord) {
        self.include(
            record.envelope.seq,
            &record.envelope.cursor,
            record.append_time_unix_ms,
            record.envelope.seq,
            &record.envelope.cursor,
        );
    }

    pub(super) fn include(
        &mut self,
        first_seq: u64,
        first_cursor: &str,
        first_append_time_unix_ms: i64,
        last_seq: u64,
        last_cursor: &str,
    ) {
        self.earliest_append_time_unix_ms = Some(
            self.earliest_append_time_unix_ms
                .map(|time| time.min(first_append_time_unix_ms))
                .unwrap_or(first_append_time_unix_ms),
        );
        if self.earliest_seq.map(|seq| first_seq < seq).unwrap_or(true) {
            self.earliest_seq = Some(first_seq);
            self.earliest_cursor = Some(first_cursor.to_owned());
        }
        if self.latest_seq.map(|seq| last_seq > seq).unwrap_or(true) {
            self.latest_seq = Some(last_seq);
            self.latest_cursor = Some(last_cursor.to_owned());
        }
    }

    pub(super) fn snapshot(
        &self,
        retention_days: u64,
        hot_event_capacity: usize,
    ) -> TimelineRetentionSnapshot {
        TimelineRetentionSnapshot {
            retention_days,
            hot_event_capacity,
            earliest_seq: self.earliest_seq,
            earliest_cursor: self.earliest_cursor.clone(),
            latest_seq: self.latest_seq,
            latest_cursor: self.latest_cursor.clone(),
        }
    }
}

impl TimelineStore {
    pub(super) fn prune_expired_segments(&mut self) -> Result<(), TimelineStoreError> {
        let cutoff = self.retention_cutoff_unix_ms();
        let mixed_boundary = self
            .segments
            .iter()
            .find(|segment| {
                let state = segment
                    .state
                    .read()
                    .expect("timeline segment metadata lock poisoned");
                state.min_append_time_unix_ms < cutoff && state.max_append_time_unix_ms >= cutoff
            })
            .map(|segment| segment.path.clone());
        let cached_rollback_boundary = self.boundary_cache.as_ref().and_then(|cache| {
            self.segments
                .iter()
                .find(|segment| {
                    segment.path == cache.path
                        && segment
                            .state
                            .read()
                            .expect("timeline segment metadata lock poisoned")
                            .max_append_time_unix_ms
                            >= cutoff
                })
                .map(|segment| segment.path.clone())
        });
        let active_boundary = mixed_boundary.or(cached_rollback_boundary);
        self.prepare_boundary_cache(active_boundary.as_deref(), cutoff)?;

        if let Some(path) = self
            .physical_segment_max_append_times
            .iter()
            .filter(|(_, max_time)| **max_time < cutoff)
            .map(|(path, _)| path.clone())
            .min()
        {
            if self.take_write_failure(super::TimelineWriteFailure::PruneUnlink) {
                self.meta_dirty = true;
                self.meta_current = false;
                return Err(TimelineStoreError::InjectedWrite {
                    failure: "prune_unlink",
                });
            }
            if let Err(source) = fs::remove_file(&path) {
                if source.kind() != std::io::ErrorKind::NotFound {
                    self.meta_dirty = true;
                    self.meta_current = false;
                    return Err(TimelineStoreError::Io { path, source });
                }
            }
            let parent = path.parent().unwrap_or_else(|| Path::new("."));
            let dir_sync = if self.take_write_failure(super::TimelineWriteFailure::PruneDirSync) {
                Err(std::io::Error::other(
                    "injected prune directory sync failure",
                ))
            } else {
                super::sync_dir(parent)
            };
            if let Err(source) = dir_sync {
                self.prune_dir_sync_pending = Some(path.clone());
                self.meta_dirty = true;
                self.meta_current = false;
                return Err(TimelineStoreError::Io {
                    path: parent.to_path_buf(),
                    source,
                });
            }
            self.commit_segment_absent(&path, cutoff);
            self.meta_dirty = true;
            self.meta_current = false;
            self.meta_dirty_after_prune = true;
            return Ok(());
        }
        self.recompute_retained_state(cutoff);
        Ok(())
    }

    pub(super) fn commit_segment_absent(&mut self, path: &Path, cutoff: i64) {
        self.physical_segment_max_append_times.remove(path);
        Arc::make_mut(&mut self.segments).retain(|segment| segment.path != path);
        self.callback_projection_ids
            .retain(|_, projection_path| projection_path != path);
        if self
            .boundary_cache
            .as_ref()
            .map(|cache| cache.path.as_path())
            == Some(path)
        {
            self.boundary_cache = None;
        }
        if self
            .current_segment
            .as_ref()
            .map(|segment| segment.path.as_path())
            == Some(path)
        {
            self.current_segment = latest_physical_segment(&self.segments_dir).ok().flatten();
        }
        self.recompute_retained_state(cutoff);
    }

    fn prepare_boundary_cache(
        &mut self,
        boundary_path: Option<&Path>,
        cutoff: i64,
    ) -> Result<(), TimelineStoreError> {
        let Some(path) = boundary_path else {
            self.boundary_cache = None;
            return Ok(());
        };
        if self
            .boundary_cache
            .as_ref()
            .map(|cache| cache.path.as_path())
            != Some(path)
        {
            let records = read_segment_records(path)?
                .records
                .into_iter()
                .filter(|record| {
                    record_instance(&record.envelope).as_deref() == Some(self.instance.as_ref())
                })
                .collect();
            self.boundary_cache = Some(BoundaryCache::from_records(path.to_path_buf(), records));
            #[cfg(test)]
            {
                self.boundary_segment_loads += 1;
            }
        }
        self.boundary_cache
            .as_mut()
            .expect("boundary cache initialized")
            .reposition(cutoff);
        Ok(())
    }

    pub(super) fn recompute_retained_state(&mut self, cutoff: i64) {
        let fully_retained = self
            .segments
            .iter()
            .filter(|segment| {
                segment
                    .state
                    .read()
                    .expect("timeline segment metadata lock poisoned")
                    .min_append_time_unix_ms
                    >= cutoff
            })
            .collect::<Vec<_>>();
        let mut bounds = RetainedBounds::new(cutoff);
        for segment in &fully_retained {
            let state = segment
                .state
                .read()
                .expect("timeline segment metadata lock poisoned");
            bounds.include(
                state.first_seq,
                &state.first_cursor,
                state.min_append_time_unix_ms,
                state.last_seq,
                &state.last_cursor,
            );
        }
        if let Some(cache) = &self.boundary_cache {
            for entry in cache.retained_entries() {
                bounds.include(
                    entry.seq,
                    &entry.cursor,
                    entry.append_time_unix_ms,
                    entry.seq,
                    &entry.cursor,
                );
            }
        }
        self.retained_bounds = bounds;
        self.hot_cache
            .retain(|record| record.append_time_unix_ms >= cutoff);
        self.callback_projection_ids
            .retain(|_, path| fully_retained.iter().any(|segment| segment.path == *path));
        if let Some(cache) = &self.boundary_cache {
            for entry in cache.retained_entries() {
                if let Some(id) = &entry.projection_id {
                    self.callback_projection_ids
                        .insert(id.clone(), cache.path.clone());
                }
            }
        }
    }
}

pub(super) fn retained_snapshot(
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
