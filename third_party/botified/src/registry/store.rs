use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

use super::{
    prune_expired_locked, validate_topic_name, HistoryEntry, RegistryChange, RegistryConfig,
    RegistryDeleteAck, RegistryError, RegistryHistoryResult, RegistryInner, RegistryItem,
    RegistryQuery, RegistryQueryResult, RegistrySetAck, RegistrySetRequest, RegistryStore,
    RegistryTopicSummary, RegistryTtl, RegistryWriterKind, TopicPattern,
};

impl RegistryStore {
    pub(crate) fn validate_delete_topic(&self, topic: &str) -> Result<(), RegistryError> {
        validate_topic_name(topic, self.config.max_topic_len)
    }

    pub fn set(
        &self,
        writer_kind: RegistryWriterKind,
        origin: impl Into<String>,
        request: RegistrySetRequest,
    ) -> Result<RegistrySetAck, RegistryError> {
        self.set_at(writer_kind, origin, request, SystemTime::now())
    }

    pub fn set_at(
        &self,
        writer_kind: RegistryWriterKind,
        origin: impl Into<String>,
        request: RegistrySetRequest,
        now: SystemTime,
    ) -> Result<RegistrySetAck, RegistryError> {
        let prepared = match self.prepare_set(writer_kind, origin.into(), request, now) {
            Ok(prepared) => prepared,
            Err(error) => {
                self.record_rejected_write();
                return Err(error);
            }
        };

        let mut inner = self.lock_inner();
        if let Err(error) = prune_expired_locked(&self.config, &self.inner.changes, &mut inner, now)
        {
            inner.rejected_writes_total = inner.rejected_writes_total.saturating_add(1);
            return Err(error);
        }

        if !inner.current.contains_key(&prepared.item.topic)
            && inner.current.len() >= self.config.max_topics
        {
            inner.rejected_writes_total += 1;
            return Err(RegistryError::TooManyTopics);
        }

        let change = commit_change_locked(
            &self.config,
            &self.inner.changes,
            &mut inner,
            RegistryCommit::Set(prepared),
        )
        .inspect_err(|_| {
            inner.rejected_writes_total = inner.rejected_writes_total.saturating_add(1);
        })?
        .expect("set commit must produce a change");
        let RegistryChange::Set { item, .. } = change else {
            unreachable!("set commit returned a non-set change")
        };
        let ack = RegistrySetAck {
            topic: item.topic.clone(),
            source: item.source.clone(),
            writer_kind: item.writer_kind,
            origin: item.origin.clone(),
            seq: item.seq,
            freq_hz: item.freq_hz,
            updated_at: item.updated_at,
            expires_at: item.expires_at,
            ttl: item.ttl,
        };
        drop(inner);
        self.inner.deadline_notify.notify_one();
        Ok(ack)
    }

    pub fn delete(
        &self,
        writer_kind: RegistryWriterKind,
        origin: impl Into<String>,
        topic: impl Into<String>,
    ) -> Result<RegistryDeleteAck, RegistryError> {
        self.delete_at(writer_kind, origin, topic, SystemTime::now())
    }

    pub fn delete_at(
        &self,
        writer_kind: RegistryWriterKind,
        origin: impl Into<String>,
        topic: impl Into<String>,
        now: SystemTime,
    ) -> Result<RegistryDeleteAck, RegistryError> {
        let topic = topic.into();
        if let Err(error) = validate_topic_name(&topic, self.config.max_topic_len) {
            self.record_rejected_write();
            return Err(error);
        }
        let mut inner = self.lock_inner();
        if let Err(error) = prune_expired_locked(&self.config, &self.inner.changes, &mut inner, now)
        {
            inner.rejected_writes_total = inner.rejected_writes_total.saturating_add(1);
            return Err(error);
        }

        if !inner.current.contains_key(&topic) {
            return Ok(RegistryDeleteAck {
                topic,
                deleted: false,
                seq: None,
                server_time: now,
            });
        };
        let change = commit_change_locked(
            &self.config,
            &self.inner.changes,
            &mut inner,
            RegistryCommit::Delete {
                topic: topic.clone(),
                writer_kind,
                origin: origin.into(),
                changed_at: now,
            },
        )
        .inspect_err(|_| {
            inner.rejected_writes_total = inner.rejected_writes_total.saturating_add(1);
        })?
        .expect("existing delete must produce a change");
        let seq = change.seq();
        Ok(RegistryDeleteAck {
            topic,
            deleted: true,
            seq: Some(seq),
            server_time: now,
        })
    }

    pub fn get(
        &self,
        query: RegistryQuery,
    ) -> Result<RegistryQueryResult<RegistryItem>, RegistryError> {
        self.get_at(query, SystemTime::now())
    }

    pub fn get_at(
        &self,
        query: RegistryQuery,
        now: SystemTime,
    ) -> Result<RegistryQueryResult<RegistryItem>, RegistryError> {
        let pattern = TopicPattern::parse(&query.topic, self.config.max_topic_len)?;
        let limit = self.resolve_limit(query.limit)?;

        let snapshot = {
            let mut inner = self.lock_inner();
            prune_expired_locked(&self.config, &self.inner.changes, &mut inner, now)?;
            if pattern.is_exact() {
                inner
                    .current
                    .get(&query.topic)
                    .cloned()
                    .into_iter()
                    .collect::<Vec<_>>()
            } else {
                inner.current.values().cloned().collect::<Vec<_>>()
            }
        };
        let mut matches = snapshot
            .into_iter()
            .filter(|item| !is_expired(item, now) && pattern.matches(&item.topic))
            .collect::<Vec<_>>();
        matches.sort_by(|left, right| left.topic.cmp(&right.topic));
        let matched_count = matches.len();
        let mut items = matches
            .into_iter()
            .take(limit)
            .map(|item| item.as_ref().clone())
            .collect::<Vec<_>>();

        let mut truncated = matched_count > limit;
        let mut truncated_reason = truncated.then(|| "limit".to_owned());
        if truncate_items_to_response_bytes(
            &mut items,
            self.config.max_response_bytes,
            TruncateSide::Back,
        ) {
            truncated = true;
            truncated_reason = Some("response_bytes".to_owned());
        }
        let returned_count = items.len();

        Ok(RegistryQueryResult {
            server_time: now,
            items,
            matched_count,
            returned_count,
            truncated,
            truncated_reason,
        })
    }

    pub fn history(&self, query: RegistryQuery) -> Result<RegistryHistoryResult, RegistryError> {
        self.history_at(query, SystemTime::now())
    }

    pub fn history_at(
        &self,
        query: RegistryQuery,
        now: SystemTime,
    ) -> Result<RegistryHistoryResult, RegistryError> {
        let pattern = TopicPattern::parse(&query.topic, self.config.max_topic_len)?;
        let limit = self.resolve_limit(query.limit)?;
        let since_secs = query.since_secs.ok_or(RegistryError::InvalidSince)?;
        let since = duration_from_secs(since_secs, RegistryError::InvalidSince)?;
        let window = since.min(self.config.history_retention);

        let snapshot = {
            let mut inner = self.lock_inner();
            prune_expired_locked(&self.config, &self.inner.changes, &mut inner, now)?;
            inner
                .history
                .values()
                .map(|entry| entry.item.clone())
                .collect::<Vec<_>>()
        };
        let matches = snapshot
            .into_iter()
            .filter(|item| {
                within_window(item.updated_at, now, window) && pattern.matches(&item.topic)
            })
            .collect::<Vec<_>>();
        let matched_count = matches.len();
        let start = matched_count.saturating_sub(limit);
        let mut items = matches[start..]
            .iter()
            .map(|item| item.as_ref().clone())
            .collect::<Vec<_>>();

        let mut truncated = matched_count > items.len();
        let mut truncated_reason = truncated.then(|| "limit".to_owned());
        if truncate_items_to_response_bytes(
            &mut items,
            self.config.max_response_bytes,
            TruncateSide::Front,
        ) {
            truncated = true;
            truncated_reason = Some("response_bytes".to_owned());
        }
        let oldest_seq = items.first().map(|item| item.seq);
        let newest_seq = items.last().map(|item| item.seq);
        let returned_count = items.len();

        Ok(RegistryHistoryResult {
            server_time: now,
            items,
            oldest_seq,
            newest_seq,
            matched_count,
            returned_count,
            truncated,
            truncated_reason,
        })
    }

    pub fn topics(
        &self,
        query: RegistryQuery,
    ) -> Result<RegistryQueryResult<RegistryTopicSummary>, RegistryError> {
        self.topics_at(query, SystemTime::now())
    }

    pub fn topics_at(
        &self,
        query: RegistryQuery,
        now: SystemTime,
    ) -> Result<RegistryQueryResult<RegistryTopicSummary>, RegistryError> {
        let pattern = TopicPattern::parse(&query.topic, self.config.max_topic_len)?;
        let limit = self.resolve_limit(query.limit)?;

        let (history, current) = {
            let mut inner = self.lock_inner();
            prune_expired_locked(&self.config, &self.inner.changes, &mut inner, now)?;
            (
                inner
                    .history
                    .values()
                    .map(|entry| entry.item.clone())
                    .collect::<Vec<_>>(),
                inner.current.values().cloned().collect::<Vec<_>>(),
            )
        };
        let mut accumulators = HashMap::<String, TopicAccumulator>::new();
        for item in history {
            accumulators
                .entry(item.topic.clone())
                .or_default()
                .record_history(&item);
        }
        for item in current {
            accumulators
                .entry(item.topic.clone())
                .or_default()
                .record_current(&item, !is_expired(&item, now));
        }
        let mut items = accumulators
            .into_values()
            .map(TopicAccumulator::into_summary)
            .filter(|summary| pattern.matches(&summary.topic))
            .collect::<Vec<_>>();
        items.sort_by(|left, right| left.topic.cmp(&right.topic));
        let matched_count = items.len();
        items.truncate(limit);

        let mut truncated = matched_count > limit;
        let mut truncated_reason = truncated.then(|| "limit".to_owned());
        if truncate_items_to_response_bytes(
            &mut items,
            self.config.max_response_bytes,
            TruncateSide::Back,
        ) {
            truncated = true;
            truncated_reason = Some("response_bytes".to_owned());
        }
        let returned_count = items.len();

        Ok(RegistryQueryResult {
            server_time: now,
            items,
            matched_count,
            returned_count,
            truncated,
            truncated_reason,
        })
    }

    fn prepare_set(
        &self,
        writer_kind: RegistryWriterKind,
        origin: String,
        request: RegistrySetRequest,
        now: SystemTime,
    ) -> Result<PreparedSet, RegistryError> {
        validate_topic_name(&request.topic, self.config.max_topic_len)?;
        let source = normalize_source(&request.source, self.config.max_source_len)?;
        let value = request.value.ok_or(RegistryError::InvalidValue)?;
        let value_bytes = value_size(&value)?;
        if value_bytes > self.config.max_value_bytes {
            return Err(RegistryError::ValueTooLarge);
        }
        let ttl = match request.ttl {
            RegistryTtl::Default => Some(self.config.default_ttl),
            RegistryTtl::Seconds(seconds) => {
                Some(duration_from_secs(seconds, RegistryError::InvalidTtl)?)
            }
            RegistryTtl::Null => None,
        };
        let freq_hz = match request.freq_hz {
            Some(freq_hz) if !freq_hz.is_finite() || freq_hz < 0.0 => {
                return Err(RegistryError::InvalidFrequency)
            }
            other => other,
        };
        let expires_at = ttl
            .map(|ttl| now.checked_add(ttl).ok_or(RegistryError::DeadlineOverflow))
            .transpose()?;

        Ok(PreparedSet {
            value_bytes,
            item: RegistryItem {
                topic: request.topic,
                value,
                source,
                writer_kind,
                origin,
                seq: 0,
                freq_hz,
                updated_at: now,
                expires_at,
                ttl,
            },
        })
    }

    fn resolve_limit(&self, limit: Option<usize>) -> Result<usize, RegistryError> {
        let limit = limit.unwrap_or(self.config.default_query_limit);
        if limit == 0 || limit > self.config.max_query_limit {
            return Err(RegistryError::QueryTooLarge);
        }
        Ok(limit)
    }

    fn record_rejected_write(&self) {
        let mut inner = self.lock_inner();
        inner.rejected_writes_total = inner.rejected_writes_total.saturating_add(1);
    }
}

#[derive(Debug)]
pub(super) struct PreparedSet {
    item: RegistryItem,
    value_bytes: usize,
}

#[derive(Debug)]
pub(super) enum RegistryCommit {
    Set(PreparedSet),
    Delete {
        topic: String,
        writer_kind: RegistryWriterKind,
        origin: String,
        changed_at: SystemTime,
    },
    Expire {
        topic: String,
        item_seq: u64,
        changed_at: SystemTime,
    },
}

#[derive(Debug, Default)]
struct TopicAccumulator {
    latest: Option<TopicLatest>,
    sample_count_retained: usize,
    current: bool,
}

impl TopicAccumulator {
    fn record_history(&mut self, item: &RegistryItem) {
        self.sample_count_retained += 1;
        self.record_latest(item);
    }

    fn record_current(&mut self, item: &RegistryItem, current: bool) {
        self.current |= current;
        self.record_latest(item);
    }

    fn record_latest(&mut self, item: &RegistryItem) {
        let replace = self
            .latest
            .as_ref()
            .map(|latest| item.seq >= latest.seq)
            .unwrap_or(true);
        if replace {
            self.latest = Some(TopicLatest::from_item(item));
        }
    }

    fn into_summary(self) -> RegistryTopicSummary {
        let latest = self
            .latest
            .expect("topic accumulator should contain at least one item");
        RegistryTopicSummary {
            topic: latest.topic,
            writer_kind: latest.writer_kind,
            origin: latest.origin,
            source: latest.source,
            latest_seq: latest.seq,
            last_seen_at: latest.updated_at,
            current: self.current,
            expires_at: latest.expires_at,
            sample_count_retained: self.sample_count_retained,
            freq_hz: latest.freq_hz,
        }
    }
}

#[derive(Debug)]
struct TopicLatest {
    topic: String,
    writer_kind: RegistryWriterKind,
    origin: String,
    source: String,
    seq: u64,
    updated_at: SystemTime,
    expires_at: Option<SystemTime>,
    freq_hz: Option<f64>,
}

impl TopicLatest {
    fn from_item(item: &RegistryItem) -> Self {
        Self {
            topic: item.topic.clone(),
            writer_kind: item.writer_kind,
            origin: item.origin.clone(),
            source: item.source.clone(),
            seq: item.seq,
            updated_at: item.updated_at,
            expires_at: item.expires_at,
            freq_hz: item.freq_hz,
        }
    }
}

fn normalize_source(source: &str, max_len: usize) -> Result<String, RegistryError> {
    let source = source.trim();
    if source.is_empty() || source.len() > max_len {
        return Err(RegistryError::InvalidSource);
    }
    Ok(source.to_owned())
}

fn value_size(value: &Value) -> Result<usize, RegistryError> {
    serde_json::to_vec(value)
        .map(|encoded| encoded.len())
        .map_err(|_| RegistryError::InvalidValue)
}

fn duration_from_secs(seconds: f64, error: RegistryError) -> Result<Duration, RegistryError> {
    if !seconds.is_finite() || seconds <= 0.0 {
        return Err(error);
    }
    let millis = (seconds * 1000.0).round();
    if !millis.is_finite() || millis <= 0.0 || millis > u64::MAX as f64 {
        return Err(error);
    }
    Ok(Duration::from_millis(millis as u64))
}

fn allocate_history_id(inner: &mut RegistryInner) -> u128 {
    if inner.next_history_id == u128::MAX {
        renumber_history_ids(inner);
    }
    let history_id = inner.next_history_id;
    inner.next_history_id = inner
        .next_history_id
        .checked_add(1)
        .expect("history ids should be renumbered before overflow");
    history_id
}

fn renumber_history_ids(inner: &mut RegistryInner) {
    let old_history = std::mem::take(&mut inner.history);
    let mut history = BTreeMap::new();
    let mut history_expirations = BTreeSet::new();
    for (index, (_, entry)) in old_history.into_iter().enumerate() {
        let history_id = index as u128 + 1;
        if let Some(deadline) = entry.retention_deadline {
            history_expirations.insert((deadline, history_id));
        }
        history.insert(history_id, entry);
    }
    inner.next_history_id = history.len() as u128 + 1;
    inner.history = history;
    inner.history_expirations = history_expirations;
}

fn allocate_seq_locked(inner: &mut RegistryInner) -> Result<u64, RegistryError> {
    let seq = inner
        .last_committed_seq
        .checked_add(1)
        .ok_or(RegistryError::SeqExhausted)?;
    inner.last_committed_seq = seq;
    Ok(seq)
}

pub(super) fn commit_change_locked(
    config: &RegistryConfig,
    changes: &broadcast::Sender<RegistryChange>,
    inner: &mut RegistryInner,
    commit: RegistryCommit,
) -> Result<Option<RegistryChange>, RegistryError> {
    let change = match commit {
        RegistryCommit::Set(prepared) => {
            let seq = allocate_seq_locked(inner)?;
            let mut item = prepared.item;
            item.seq = seq;
            let item = Arc::new(item);
            let was_known = inner.current.contains_key(&item.topic)
                || inner.history_topic_counts.contains_key(&item.topic);
            if let Some(previous) = inner.current.insert(item.topic.clone(), item.clone()) {
                remove_current_expiration_locked(inner, &previous);
            }
            if let Some(expires_at) = item.expires_at {
                inner
                    .current_expirations
                    .insert((expires_at, item.topic.clone(), item.seq));
            }

            let history_id = allocate_history_id(inner);
            let retention_deadline = item.updated_at.checked_add(config.history_retention);
            inner.history.insert(
                history_id,
                HistoryEntry {
                    item: item.clone(),
                    value_bytes: prepared.value_bytes,
                    retention_deadline,
                },
            );
            *inner
                .history_topic_counts
                .entry(item.topic.clone())
                .or_default() += 1;
            if !was_known {
                inner.known_topics = inner.known_topics.saturating_add(1);
            }
            if let Some(retention_deadline) = retention_deadline {
                inner
                    .history_expirations
                    .insert((retention_deadline, history_id));
            }
            inner.history_bytes = inner.history_bytes.saturating_add(prepared.value_bytes);
            inner.set_total = inner.set_total.saturating_add(1);
            enforce_history_caps_locked(config, inner);
            RegistryChange::Set {
                seq,
                changed_at: item.updated_at,
                item,
            }
        }
        RegistryCommit::Delete {
            topic,
            writer_kind,
            origin,
            changed_at,
        } => {
            let Some(item) = inner.current.get(&topic).cloned() else {
                return Ok(None);
            };
            let seq = allocate_seq_locked(inner)?;
            inner.current.remove(&topic);
            remove_current_expiration_locked(inner, &item);
            if !inner.history_topic_counts.contains_key(&topic) {
                inner.known_topics = inner.known_topics.saturating_sub(1);
            }
            inner.delete_total = inner.delete_total.saturating_add(1);
            RegistryChange::Delete {
                seq,
                changed_at,
                topic,
                writer_kind,
                origin,
            }
        }
        RegistryCommit::Expire {
            topic,
            item_seq,
            changed_at,
        } => {
            let Some(item) = inner.current.get(&topic).cloned() else {
                return Ok(None);
            };
            if item.seq != item_seq || !is_expired(&item, changed_at) {
                return Ok(None);
            }
            let seq = allocate_seq_locked(inner)?;
            inner.current.remove(&topic);
            remove_current_expiration_locked(inner, &item);
            if !inner.history_topic_counts.contains_key(&topic) {
                inner.known_topics = inner.known_topics.saturating_sub(1);
            }
            inner.expire_total = inner.expire_total.saturating_add(1);
            RegistryChange::Expire {
                seq,
                changed_at,
                topic,
            }
        }
    };
    let _ = changes.send(change.clone());
    Ok(Some(change))
}

fn remove_current_expiration_locked(inner: &mut RegistryInner, item: &RegistryItem) {
    if let Some(expires_at) = item.expires_at {
        inner
            .current_expirations
            .remove(&(expires_at, item.topic.clone(), item.seq));
    }
}

fn enforce_history_caps_locked(config: &RegistryConfig, inner: &mut RegistryInner) {
    while inner.history.len() > config.max_history_items
        || inner.history_bytes > config.max_history_bytes
    {
        let Some(history_id) = inner.history.first_key_value().map(|(&id, _)| id) else {
            inner.history_bytes = 0;
            break;
        };
        remove_history_entry_locked(inner, history_id);
    }
}

pub(super) fn remove_history_entry_locked(inner: &mut RegistryInner, history_id: u128) {
    let Some(removed) = inner.history.remove(&history_id) else {
        return;
    };
    inner.history_bytes = inner.history_bytes.saturating_sub(removed.value_bytes);
    inner.pruned_history_items_total = inner.pruned_history_items_total.saturating_add(1);
    let remove_topic = if let Some(count) = inner.history_topic_counts.get_mut(&removed.item.topic)
    {
        *count -= 1;
        *count == 0
    } else {
        false
    };
    if remove_topic {
        inner.history_topic_counts.remove(&removed.item.topic);
        if !inner.current.contains_key(&removed.item.topic) {
            inner.known_topics = inner.known_topics.saturating_sub(1);
        }
    }
    if let Some(deadline) = removed.retention_deadline {
        inner.history_expirations.remove(&(deadline, history_id));
    }
}

fn within_window(updated_at: SystemTime, now: SystemTime, window: Duration) -> bool {
    now.duration_since(updated_at)
        .map(|age| age <= window)
        .unwrap_or(true)
}

fn is_expired(item: &RegistryItem, now: SystemTime) -> bool {
    item.expires_at
        .is_some_and(|expires_at| now.duration_since(expires_at).is_ok())
}

#[derive(Debug, Clone, Copy)]
enum TruncateSide {
    Front,
    Back,
}

fn truncate_items_to_response_bytes<T: Serialize>(
    items: &mut Vec<T>,
    max_response_bytes: usize,
    side: TruncateSide,
) -> bool {
    let item_bytes = items
        .iter()
        .map(|item| {
            serde_json::to_vec(item)
                .map(|encoded| encoded.len())
                .unwrap_or(0)
        })
        .collect::<Vec<_>>();
    let mut estimated_bytes = estimated_response_bytes_from_lengths(&item_bytes);
    let mut removed = 0usize;

    while removed < items.len() && estimated_bytes > max_response_bytes {
        let index = match side {
            TruncateSide::Front => removed,
            TruncateSide::Back => items.len() - 1 - removed,
        };
        estimated_bytes = estimated_bytes
            .saturating_sub(item_bytes[index])
            .saturating_sub((items.len() - removed > 1) as usize);
        removed += 1;
    }

    if removed == 0 {
        return false;
    }
    match side {
        TruncateSide::Front => {
            items.drain(..removed);
        }
        TruncateSide::Back => items.truncate(items.len() - removed),
    }
    true
}

fn estimated_response_bytes_from_lengths(item_bytes: &[usize]) -> usize {
    128usize
        .saturating_add(item_bytes.iter().copied().sum::<usize>())
        .saturating_add(item_bytes.len().saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use serde::ser::SerializeStruct;
    use serde::{Serialize, Serializer};

    use super::*;

    #[derive(Debug)]
    struct CountingItem {
        id: usize,
        payload: String,
        serializations: Arc<AtomicUsize>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    struct PlainItem {
        id: usize,
        payload: String,
    }

    impl Serialize for CountingItem {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            self.serializations.fetch_add(1, Ordering::SeqCst);
            let mut state = serializer.serialize_struct("CountingItem", 2)?;
            state.serialize_field("id", &self.id)?;
            state.serialize_field("payload", &self.payload)?;
            state.end()
        }
    }

    #[test]
    fn response_truncation_serializes_each_item_at_most_once() {
        for side in [TruncateSide::Front, TruncateSide::Back] {
            let counters = (0..32)
                .map(|_| Arc::new(AtomicUsize::new(0)))
                .collect::<Vec<_>>();
            let mut items = counters
                .iter()
                .enumerate()
                .map(|(id, serializations)| CountingItem {
                    id,
                    payload: "x".repeat(64),
                    serializations: serializations.clone(),
                })
                .collect::<Vec<_>>();

            assert!(truncate_items_to_response_bytes(&mut items, 128, side));
            assert!(items.is_empty());
            assert!(counters
                .iter()
                .all(|counter| counter.load(Ordering::SeqCst) == 1));
        }
    }

    fn quadratic_truncate_oracle<T: Serialize>(
        items: &mut Vec<T>,
        max_response_bytes: usize,
        side: TruncateSide,
    ) -> bool {
        let mut truncated = false;
        while !items.is_empty() {
            let lengths = items
                .iter()
                .map(|item| {
                    serde_json::to_vec(item)
                        .map(|encoded| encoded.len())
                        .unwrap_or(0)
                })
                .collect::<Vec<_>>();
            if estimated_response_bytes_from_lengths(&lengths) <= max_response_bytes {
                break;
            }
            match side {
                TruncateSide::Front => {
                    items.remove(0);
                }
                TruncateSide::Back => {
                    items.pop();
                }
            }
            truncated = true;
        }
        truncated
    }

    #[test]
    fn linear_response_truncation_matches_quadratic_oracle() {
        let original = (0..12)
            .map(|id| PlainItem {
                id,
                payload: "x".repeat(id * 7),
            })
            .collect::<Vec<_>>();
        for side in [TruncateSide::Front, TruncateSide::Back] {
            for max_response_bytes in [0, 127, 128, 129, 160, 256, 512, 1024, usize::MAX] {
                let mut expected = original.clone();
                let expected_truncated =
                    quadratic_truncate_oracle(&mut expected, max_response_bytes, side);
                let mut actual = original.clone();
                let actual_truncated =
                    truncate_items_to_response_bytes(&mut actual, max_response_bytes, side);
                assert_eq!(actual, expected, "side={side:?}, cap={max_response_bytes}");
                assert_eq!(
                    actual_truncated, expected_truncated,
                    "side={side:?}, cap={max_response_bytes}"
                );
            }
        }
    }
}
