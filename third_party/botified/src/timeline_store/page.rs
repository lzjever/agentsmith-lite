use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader};
#[cfg(test)]
use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::event::EventCursor;

use super::segments::{
    invalid_segment_data_error, PositionedFileReader, SnapshotSegment, TIMELINE_SPARSE_INDEX_STRIDE,
};
use super::{
    is_recovery_record, record_instance, valid_record, HistoryBoundary, RetainedBounds,
    TimelineCheckpoint, TimelineForwardPage, TimelineHistoryPage, TimelineReadSnapshot,
    TimelineRetentionSnapshot, TimelineStore, TimelineStoreError, TimelineStoreRecord,
};

impl TimelineReadSnapshot {
    fn new(store: &TimelineStore) -> Self {
        Self {
            instance: store.instance.clone(),
            latest_seq: store.latest_seq,
            cutoff_unix_ms: store.retention_cutoff_unix_ms(),
            retention_days: store.retention_days,
            hot_event_capacity: store.hot_event_capacity,
            retained_bounds: store.retained_bounds.clone(),
            recovery_ranges: Arc::clone(&store.recovery_ranges),
            segments: Arc::clone(&store.segments),
            #[cfg(test)]
            segment_reads: store.segment_reads.clone(),
            #[cfg(test)]
            read_record_count: store.read_record_count.clone(),
            #[cfg(test)]
            segment_state_observer: store.segment_state_observer.clone(),
            #[cfg(test)]
            segment_read_observer: store.segment_read_observer.clone(),
        }
    }

    pub(crate) fn checkpoint(&self) -> TimelineCheckpoint {
        TimelineCheckpoint {
            seq: self.latest_seq,
            cursor: self.cursor_for_seq(self.latest_seq),
        }
    }

    pub(crate) fn retention(&self) -> TimelineRetentionSnapshot {
        if self.cutoff_unix_ms == self.retained_bounds.cutoff_unix_ms {
            return self
                .retained_bounds
                .snapshot(self.retention_days, self.hot_event_capacity);
        }
        self.compute_retained_bounds()
            .unwrap_or_else(|_| RetainedBounds::new(self.cutoff_unix_ms))
            .snapshot(self.retention_days, self.hot_event_capacity)
    }

    fn compute_retained_bounds(&self) -> Result<RetainedBounds, TimelineStoreError> {
        let mut bounds = RetainedBounds::new(self.cutoff_unix_ms);
        for segment_index in 0..self.segments.len() {
            let metadata = self.snapshot_segment(segment_index);
            let state = &metadata.state;
            if state.first_seq > self.latest_seq
                || state.max_append_time_unix_ms < self.cutoff_unix_ms
            {
                continue;
            }
            if state.min_append_time_unix_ms >= self.cutoff_unix_ms
                && state.last_seq <= self.latest_seq
            {
                bounds.include(
                    state.first_seq,
                    &state.first_cursor,
                    state.min_append_time_unix_ms,
                    state.last_seq,
                    &state.last_cursor,
                );
                continue;
            }
            self.scan_segment_from(&metadata, 0, |record| {
                if record.envelope.seq <= self.latest_seq && self.is_retained_record(&record) {
                    bounds.push(&record);
                }
                true
            })?;
        }
        Ok(bounds)
    }

    pub(crate) fn tail(self, limit: usize) -> Result<TimelineHistoryPage, TimelineStoreError> {
        validate_limit(limit)?;
        let checkpoint = self.cursor_for_seq(self.latest_seq);
        let mut records = VecDeque::with_capacity(limit.saturating_add(1));
        for segment_index in (0..self.segments.len()).rev() {
            let metadata = self.snapshot_segment(segment_index);
            if metadata.state.max_append_time_unix_ms < self.cutoff_unix_ms {
                continue;
            }
            let start = self.backward_scan_start(&metadata, self.latest_seq, limit);
            let mut segment_tail = VecDeque::with_capacity(limit.saturating_add(1));
            self.scan_segment_from(&metadata, start, |record| {
                if self.is_retained_record(&record)
                    && !is_recovery_record(&record)
                    && record.envelope.seq <= self.latest_seq
                {
                    segment_tail.push_back(record);
                    if segment_tail.len() > limit.saturating_add(1) {
                        segment_tail.pop_front();
                    }
                }
                true
            })?;
            for record in segment_tail.into_iter().rev() {
                records.push_front(record);
                if records.len() > limit {
                    break;
                }
            }
            if records.len() > limit {
                break;
            }
        }
        if records.is_empty() {
            return Ok(TimelineHistoryPage {
                events: Vec::new(),
                page_start_cursor: checkpoint.clone(),
                page_end_cursor: checkpoint.clone(),
                next_cursor: checkpoint,
                has_more_before: false,
                history_boundary: if self.latest_seq == 0 {
                    HistoryBoundary::Start
                } else {
                    HistoryBoundary::Expired
                },
            });
        }
        let has_more_before = records.len() > limit;
        if has_more_before {
            records.pop_front();
        }
        let events = records
            .into_iter()
            .map(|record| record.envelope)
            .collect::<Vec<_>>();
        let first = events.first().expect("non-empty cold tail");
        let last = events.last().expect("non-empty cold tail");
        Ok(TimelineHistoryPage {
            page_start_cursor: first.cursor.clone(),
            page_end_cursor: last.cursor.clone(),
            next_cursor: checkpoint,
            has_more_before,
            history_boundary: history_boundary_for_page(has_more_before, first.seq),
            events,
        })
    }

    pub(crate) fn read_forward(
        self,
        cursor: &str,
        limit: usize,
    ) -> Result<TimelineForwardPage, TimelineStoreError> {
        validate_limit(limit)?;
        let cursor_seq = parse_boundary_cursor(cursor, self.instance.as_ref())?;
        if cursor_seq > self.latest_seq {
            return Err(TimelineStoreError::StaleCursor);
        }
        let mut boundary_found = (cursor_seq == 0 && self.latest_seq == 0)
            || cursor_seq == self.latest_seq
            || self.is_recovered_boundary(cursor_seq);
        let mut first_retained_seq = None;
        let mut events = Vec::with_capacity(limit.saturating_add(1));
        for segment_index in 0..self.segments.len() {
            let metadata = self.snapshot_segment(segment_index);
            let state = &metadata.state;
            let skip = state.last_seq < cursor_seq
                || (state.max_append_time_unix_ms < self.cutoff_unix_ms
                    && state.last_seq != cursor_seq);
            if skip {
                continue;
            }
            let start = self.forward_scan_start(&metadata, cursor_seq);
            let complete = self.scan_segment_from(&metadata, start, |record| {
                let retained = self.is_retained_record(&record);
                if record_instance(&record.envelope).as_deref() == Some(self.instance.as_ref())
                    && record.envelope.seq == cursor_seq
                    && (retained || cursor_seq == self.latest_seq)
                {
                    boundary_found = true;
                }
                if !retained || record.envelope.seq > self.latest_seq {
                    return true;
                }
                first_retained_seq.get_or_insert(record.envelope.seq);
                if record.envelope.seq > cursor_seq && !is_recovery_record(&record) {
                    events.push(record.envelope);
                }
                events.len() <= limit
            })?;
            if !complete {
                break;
            }
        }
        if cursor_seq == 0 && first_retained_seq == Some(1) {
            boundary_found = true;
        }
        if !boundary_found {
            return Err(TimelineStoreError::StaleCursor);
        }
        let has_more_after = events.len() > limit;
        events.truncate(limit);
        let next_cursor = events
            .last()
            .map(|event| event.cursor.clone())
            .unwrap_or_else(|| cursor.to_owned());
        Ok(TimelineForwardPage {
            events,
            next_cursor,
            has_more_after,
        })
    }

    pub(crate) fn read_backward(
        self,
        cursor: &str,
        limit: usize,
    ) -> Result<TimelineHistoryPage, TimelineStoreError> {
        validate_limit(limit)?;
        let cursor_seq = parse_boundary_cursor(cursor, self.instance.as_ref())?;
        if cursor_seq > self.latest_seq || (cursor_seq == 0 && self.latest_seq != 0) {
            return Err(TimelineStoreError::StaleCursor);
        }
        let mut boundary_found = (cursor_seq == 0 && self.latest_seq == 0)
            || cursor_seq == self.latest_seq
            || self.is_recovered_boundary(cursor_seq);
        let mut earliest_seen: Option<u64> = None;
        let mut page = VecDeque::with_capacity(limit.saturating_add(1));
        for segment_index in (0..self.segments.len()).rev() {
            let metadata = self.snapshot_segment(segment_index);
            let state = &metadata.state;
            let skip = state.first_seq > cursor_seq
                || (state.max_append_time_unix_ms < self.cutoff_unix_ms
                    && state.last_seq != cursor_seq);
            if skip {
                continue;
            }
            let start = self.backward_scan_start(&metadata, cursor_seq, limit);
            let mut segment_page = VecDeque::with_capacity(limit.saturating_add(1));
            self.scan_segment_from(&metadata, start, |record| {
                let retained = self.is_retained_record(&record);
                if record_instance(&record.envelope).as_deref() == Some(self.instance.as_ref()) {
                    if record.envelope.seq == cursor_seq
                        && (retained || cursor_seq == self.latest_seq)
                    {
                        boundary_found = true;
                    } else if record.envelope.seq > cursor_seq {
                        return false;
                    }
                }
                if retained && !is_recovery_record(&record) {
                    earliest_seen = Some(
                        earliest_seen
                            .map(|seq| seq.min(record.envelope.seq))
                            .unwrap_or(record.envelope.seq),
                    );
                    if record.envelope.seq < cursor_seq {
                        segment_page.push_back(record);
                        if segment_page.len() > limit.saturating_add(1) {
                            segment_page.pop_front();
                        }
                    }
                }
                true
            })?;
            for record in segment_page.into_iter().rev() {
                page.push_front(record);
                if page.len() > limit {
                    break;
                }
            }
            if boundary_found && page.len() > limit {
                break;
            }
        }
        if !boundary_found {
            return Err(TimelineStoreError::StaleCursor);
        }
        let has_more_before = page.len() > limit;
        if has_more_before {
            page.pop_front();
        }
        let events = page
            .into_iter()
            .map(|record| record.envelope)
            .collect::<Vec<_>>();
        let history_boundary = events.first().map_or_else(
            || history_boundary_for_empty_page(earliest_seen, self.latest_seq),
            |first| history_boundary_for_page(has_more_before, first.seq),
        );
        Ok(TimelineHistoryPage {
            page_start_cursor: events
                .first()
                .map(|event| event.cursor.clone())
                .unwrap_or_else(|| cursor.to_owned()),
            page_end_cursor: events
                .last()
                .map(|event| event.cursor.clone())
                .unwrap_or_else(|| cursor.to_owned()),
            next_cursor: self.cursor_for_seq(self.latest_seq),
            has_more_before,
            history_boundary,
            events,
        })
    }

    fn scan_segment_from(
        &self,
        metadata: &SnapshotSegment,
        start: u64,
        mut visit: impl FnMut(TimelineStoreRecord) -> bool,
    ) -> Result<bool, TimelineStoreError> {
        #[cfg(test)]
        self.segment_reads.fetch_add(1, Ordering::Relaxed);
        let expected_len = metadata.state.valid_len.saturating_sub(start);
        #[cfg(test)]
        if let Some(observer) = &self.segment_read_observer {
            observer();
        }
        let mut reader = BufReader::new(PositionedFileReader::new(
            Arc::clone(&metadata.file),
            start,
            expected_len,
        ));
        let mut consumed = 0_u64;
        let required_seq = metadata.state.last_seq.min(self.latest_seq);
        let mut last_snapshot_seq = None;
        loop {
            let mut line = String::new();
            let read = reader
                .read_line(&mut line)
                .map_err(|source| TimelineStoreError::Io {
                    path: metadata.path.clone(),
                    source,
                })?;
            if read == 0 {
                break;
            }
            consumed = consumed.saturating_add(read as u64);
            if line.trim().is_empty() {
                continue;
            }
            let record = serde_json::from_str::<TimelineStoreRecord>(&line)
                .ok()
                .filter(valid_record)
                .ok_or_else(|| invalid_segment_data_error(&metadata.path))?;
            if record.envelope.seq <= self.latest_seq
                && record_instance(&record.envelope).as_deref() == Some(self.instance.as_ref())
            {
                last_snapshot_seq = Some(record.envelope.seq);
            }
            #[cfg(test)]
            {
                self.read_record_count.fetch_add(1, Ordering::Relaxed);
            }
            if !visit(record) {
                return Ok(false);
            }
        }
        if consumed != expected_len && last_snapshot_seq != Some(required_seq) {
            return Err(TimelineStoreError::Io {
                path: metadata.path.clone(),
                source: io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "timeline segment changed while reading snapshot",
                ),
            });
        }
        Ok(true)
    }

    pub(super) fn snapshot_segment(&self, segment_index: usize) -> SnapshotSegment {
        #[cfg(test)]
        if let Some(observer) = &self.segment_state_observer {
            observer();
        }
        SnapshotSegment::new(self.segments[segment_index].as_ref())
    }

    fn forward_scan_start(&self, metadata: &SnapshotSegment, cursor_seq: u64) -> u64 {
        let offsets = &metadata.sparse_offsets;
        let anchor = offsets
            .partition_point(|entry| entry.seq <= cursor_seq)
            .saturating_sub(1);
        offsets[anchor]
            .offset
            .max(self.retention_scan_start(metadata))
    }

    fn backward_scan_start(
        &self,
        metadata: &SnapshotSegment,
        cursor_seq: u64,
        limit: usize,
    ) -> u64 {
        let state = &metadata.state;
        let offsets = &metadata.sparse_offsets;
        let cursor_start = if cursor_seq >= state.last_seq {
            let desired_record = state.record_count.saturating_sub(limit.saturating_add(1));
            let anchor = desired_record / TIMELINE_SPARSE_INDEX_STRIDE;
            offsets[anchor].offset
        } else {
            let anchor = offsets
                .partition_point(|entry| entry.seq < cursor_seq)
                .saturating_sub(1);
            let available_before_cursor = cursor_seq
                .saturating_sub(offsets[anchor].seq)
                .min(usize::MAX as u64) as usize;
            let anchors_back = limit
                .saturating_add(1)
                .saturating_sub(available_before_cursor)
                .div_ceil(TIMELINE_SPARSE_INDEX_STRIDE);
            offsets[anchor.saturating_sub(anchors_back)].offset
        };
        cursor_start.max(self.retention_scan_start(metadata))
    }

    fn retention_scan_start(&self, metadata: &SnapshotSegment) -> u64 {
        if metadata.state.min_append_time_unix_ms >= self.cutoff_unix_ms {
            return metadata.sparse_offsets[0].offset;
        }
        let offsets = &metadata.sparse_offsets;
        let first_retained_anchor =
            offsets.partition_point(|entry| entry.append_time_unix_ms < self.cutoff_unix_ms);
        offsets[first_retained_anchor.saturating_sub(1)].offset
    }

    fn is_retained_record(&self, record: &TimelineStoreRecord) -> bool {
        record.append_time_unix_ms >= self.cutoff_unix_ms
            && record_instance(&record.envelope).as_deref() == Some(self.instance.as_ref())
    }

    fn is_recovered_boundary(&self, seq: u64) -> bool {
        self.recovery_ranges.iter().any(|range| {
            range.append_time_unix_ms >= self.cutoff_unix_ms
                && (range.start..=range.end).contains(&seq)
        })
    }

    fn cursor_for_seq(&self, seq: u64) -> String {
        EventCursor::for_instance(self.instance.to_string(), seq)
            .expect("timeline store instance should be valid")
            .to_string()
    }
}

impl TimelineStore {
    pub fn tail(&self, limit: usize) -> Result<TimelineHistoryPage, TimelineStoreError> {
        if let Some(page) = self.try_cached_tail(limit)? {
            return Ok(page);
        }
        TimelineReadSnapshot::new(self).tail(limit)
    }

    pub fn read_forward(
        &self,
        cursor: &str,
        limit: usize,
    ) -> Result<TimelineForwardPage, TimelineStoreError> {
        if let Some(page) = self.try_cached_forward(cursor, limit)? {
            return Ok(page);
        }
        TimelineReadSnapshot::new(self).read_forward(cursor, limit)
    }

    pub fn read_backward(
        &self,
        cursor: &str,
        limit: usize,
    ) -> Result<TimelineHistoryPage, TimelineStoreError> {
        if let Some(page) = self.try_cached_backward(cursor, limit)? {
            return Ok(page);
        }
        TimelineReadSnapshot::new(self).read_backward(cursor, limit)
    }

    pub(crate) fn try_cached_tail(
        &self,
        limit: usize,
    ) -> Result<Option<TimelineHistoryPage>, TimelineStoreError> {
        validate_limit(limit)?;
        if !self.recovery_ranges.is_empty() {
            return Ok(None);
        }
        Ok(self.cached_tail(limit))
    }

    pub(crate) fn try_cached_forward(
        &self,
        cursor: &str,
        limit: usize,
    ) -> Result<Option<TimelineForwardPage>, TimelineStoreError> {
        validate_limit(limit)?;
        let cursor_seq = parse_boundary_cursor(cursor, self.instance.as_ref())?;
        if !self.recovery_ranges.is_empty() {
            return Ok(None);
        }
        Ok(self.cached_forward(cursor, cursor_seq, limit))
    }

    pub(crate) fn try_cached_backward(
        &self,
        cursor: &str,
        limit: usize,
    ) -> Result<Option<TimelineHistoryPage>, TimelineStoreError> {
        validate_limit(limit)?;
        let cursor_seq = parse_boundary_cursor(cursor, self.instance.as_ref())?;
        if !self.recovery_ranges.is_empty() {
            return Ok(None);
        }
        Ok(self.cached_backward(cursor, cursor_seq, limit))
    }

    pub(crate) fn read_snapshot(&self) -> TimelineReadSnapshot {
        TimelineReadSnapshot::new(self)
    }

    fn cached_tail(&self, limit: usize) -> Option<TimelineHistoryPage> {
        let (earliest_seq, latest_seq) = self.current_retained_bounds()?;
        let latest = self.hot_cache.back()?;
        if latest.envelope.seq != latest_seq {
            return None;
        }
        let start = self.hot_cache.len().saturating_sub(limit);
        if self.hot_cache.len() < limit && self.hot_cache.front()?.envelope.seq != earliest_seq {
            return None;
        }
        let page = self.hot_cache.range(start..).cloned().collect::<Vec<_>>();
        let has_more_before = page.first()?.envelope.seq != earliest_seq;
        Some(TimelineHistoryPage {
            page_start_cursor: page.first()?.envelope.cursor.clone(),
            page_end_cursor: page.last()?.envelope.cursor.clone(),
            next_cursor: self.cursor_for_seq(self.latest_seq),
            has_more_before,
            history_boundary: history_boundary_for_page(has_more_before, earliest_seq),
            events: page.into_iter().map(|record| record.envelope).collect(),
        })
    }

    fn cached_forward(
        &self,
        cursor: &str,
        cursor_seq: u64,
        limit: usize,
    ) -> Option<TimelineForwardPage> {
        let (_, latest_seq) = self.current_retained_bounds()?;
        if cursor_seq == latest_seq {
            return None;
        }
        let cursor_index = self
            .hot_cache
            .iter()
            .position(|record| record.envelope.seq == cursor_seq)?;
        let available = self.hot_cache.len() - cursor_index - 1;
        if available < limit && self.hot_cache.back()?.envelope.seq != latest_seq {
            return None;
        }
        let events = self
            .hot_cache
            .iter()
            .skip(cursor_index + 1)
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
        Some(TimelineForwardPage {
            events: events.into_iter().map(|record| record.envelope).collect(),
            next_cursor,
            has_more_after: next_seq < latest_seq,
        })
    }

    fn cached_backward(
        &self,
        cursor: &str,
        cursor_seq: u64,
        limit: usize,
    ) -> Option<TimelineHistoryPage> {
        let (earliest_seq, _) = self.current_retained_bounds()?;
        let cursor_index = self
            .hot_cache
            .iter()
            .position(|record| record.envelope.seq == cursor_seq)?;
        if cursor_index < limit && self.hot_cache.front()?.envelope.seq != earliest_seq {
            return None;
        }
        let start = cursor_index.saturating_sub(limit);
        let page = self
            .hot_cache
            .range(start..cursor_index)
            .cloned()
            .collect::<Vec<_>>();
        let has_more_before = page
            .first()
            .map(|record| record.envelope.seq != earliest_seq)
            .unwrap_or(false);
        let history_boundary = if page.is_empty() {
            history_boundary_for_empty_page(Some(earliest_seq), self.latest_seq)
        } else {
            history_boundary_for_page(has_more_before, earliest_seq)
        };
        Some(TimelineHistoryPage {
            page_start_cursor: page
                .first()
                .map(|record| record.envelope.cursor.clone())
                .unwrap_or_else(|| cursor.to_owned()),
            page_end_cursor: page
                .last()
                .map(|record| record.envelope.cursor.clone())
                .unwrap_or_else(|| cursor.to_owned()),
            next_cursor: self.cursor_for_seq(self.latest_seq),
            has_more_before,
            history_boundary,
            events: page.into_iter().map(|record| record.envelope).collect(),
        })
    }

    fn current_retained_bounds(&self) -> Option<(u64, u64)> {
        if !self.segments_dir.is_dir() {
            return None;
        }
        let current_cutoff = self.retention_cutoff_unix_ms();
        let earliest_append_time = self.retained_bounds.earliest_append_time_unix_ms?;
        if current_cutoff < self.retained_bounds.cutoff_unix_ms
            || current_cutoff > earliest_append_time
        {
            return None;
        }
        Some((
            self.retained_bounds.earliest_seq?,
            self.retained_bounds.latest_seq?,
        ))
    }
}

fn parse_boundary_cursor(cursor: &str, expected_instance: &str) -> Result<u64, TimelineStoreError> {
    let parsed =
        EventCursor::parse_timeline(cursor).map_err(|_| TimelineStoreError::InvalidCursor)?;
    match parsed {
        EventCursor::Global { instance, seq } if instance == expected_instance => Ok(seq),
        EventCursor::Global { .. } | EventCursor::Message { .. } => {
            Err(TimelineStoreError::StaleCursor)
        }
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

#[cfg(test)]
mod tests {
    use super::{parse_boundary_cursor, TimelineStoreError};

    #[derive(Debug)]
    enum Expected {
        Seq(u64),
        InvalidCursor,
        StaleCursor,
    }

    #[test]
    fn boundary_cursor_parser_preserves_cursor_classification() {
        for (cursor, expected) in [
            ("evt_owner_42", Expected::Seq(42)),
            ("evt_foreign_42", Expected::StaleCursor),
            ("not-a-cursor", Expected::InvalidCursor),
            ("msg_7_6964", Expected::InvalidCursor),
        ] {
            let actual = parse_boundary_cursor(cursor, "owner");
            match (expected, actual) {
                (Expected::Seq(expected), Ok(actual)) => assert_eq!(actual, expected),
                (Expected::InvalidCursor, Err(TimelineStoreError::InvalidCursor))
                | (Expected::StaleCursor, Err(TimelineStoreError::StaleCursor)) => {}
                (expected, actual) => {
                    panic!("unexpected result for {cursor}: expected {expected:?}, got {actual:?}")
                }
            }
        }
    }
}
