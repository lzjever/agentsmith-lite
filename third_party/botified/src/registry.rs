use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryConfig {
    pub retention: Duration,
    pub default_ttl: Duration,
    pub max_topics: usize,
    pub max_topic_len: usize,
    pub max_source_len: usize,
    pub max_value_bytes: usize,
    pub max_history_items: usize,
    pub max_history_bytes: usize,
    pub default_query_limit: usize,
    pub max_query_limit: usize,
    pub max_response_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistryStoreOptions {
    pub websocket_max_frame_bytes: usize,
}

impl RegistryStoreOptions {
    pub const DEFAULT_WEBSOCKET_MAX_FRAME_BYTES: usize = 64 * 1024;

    pub const fn new() -> Self {
        Self {
            websocket_max_frame_bytes: Self::DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
        }
    }

    pub const fn with_websocket_max_frame_bytes(
        mut self,
        websocket_max_frame_bytes: usize,
    ) -> Self {
        self.websocket_max_frame_bytes = websocket_max_frame_bytes;
        self
    }

    fn validate(&self) -> Result<(), RegistryError> {
        validate_positive_usize(
            "registry.websocket_max_frame_bytes",
            self.websocket_max_frame_bytes,
        )
    }
}

impl Default for RegistryStoreOptions {
    fn default() -> Self {
        Self::new()
    }
}

impl RegistryConfig {
    pub const DEFAULT_RETENTION: Duration = Duration::from_secs(300);
    pub const DEFAULT_TTL: Duration = Duration::from_secs(5);
    pub const DEFAULT_MAX_TOPICS: usize = 4096;
    pub const DEFAULT_MAX_TOPIC_LEN: usize = 256;
    pub const DEFAULT_MAX_SOURCE_LEN: usize = 128;
    pub const DEFAULT_MAX_VALUE_BYTES: usize = 8192;
    pub const DEFAULT_MAX_HISTORY_ITEMS: usize = 20_000;
    pub const DEFAULT_MAX_HISTORY_BYTES: usize = 67_108_864;
    pub const DEFAULT_QUERY_LIMIT: usize = 100;
    pub const DEFAULT_MAX_QUERY_LIMIT: usize = 1000;
    pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 262_144;

    pub fn validate(&self) -> Result<(), RegistryError> {
        validate_positive_duration("registry.retention", self.retention)?;
        validate_positive_duration("registry.default_ttl", self.default_ttl)?;
        if self.default_ttl > self.retention {
            return Err(RegistryError::InvalidConfig(
                "registry.default_ttl must be less than or equal to registry.retention".to_owned(),
            ));
        }
        validate_positive_usize("registry.max_topics", self.max_topics)?;
        validate_positive_usize("registry.max_topic_len", self.max_topic_len)?;
        validate_positive_usize("registry.max_source_len", self.max_source_len)?;
        validate_positive_usize("registry.max_value_bytes", self.max_value_bytes)?;
        validate_positive_usize("registry.max_history_items", self.max_history_items)?;
        validate_positive_usize("registry.max_history_bytes", self.max_history_bytes)?;
        validate_positive_usize("registry.default_query_limit", self.default_query_limit)?;
        validate_positive_usize("registry.max_query_limit", self.max_query_limit)?;
        validate_positive_usize("registry.max_response_bytes", self.max_response_bytes)?;
        if self.default_query_limit > self.max_query_limit {
            return Err(RegistryError::InvalidConfig(
                "registry.default_query_limit must be less than or equal to registry.max_query_limit"
                    .to_owned(),
            ));
        }
        Ok(())
    }
}

impl Default for RegistryConfig {
    fn default() -> Self {
        Self {
            retention: Self::DEFAULT_RETENTION,
            default_ttl: Self::DEFAULT_TTL,
            max_topics: Self::DEFAULT_MAX_TOPICS,
            max_topic_len: Self::DEFAULT_MAX_TOPIC_LEN,
            max_source_len: Self::DEFAULT_MAX_SOURCE_LEN,
            max_value_bytes: Self::DEFAULT_MAX_VALUE_BYTES,
            max_history_items: Self::DEFAULT_MAX_HISTORY_ITEMS,
            max_history_bytes: Self::DEFAULT_MAX_HISTORY_BYTES,
            default_query_limit: Self::DEFAULT_QUERY_LIMIT,
            max_query_limit: Self::DEFAULT_MAX_QUERY_LIMIT,
            max_response_bytes: Self::DEFAULT_MAX_RESPONSE_BYTES,
        }
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RegistryError {
    #[error("invalid registry config: {0}")]
    InvalidConfig(String),
    #[error("invalid topic")]
    InvalidTopic,
    #[error("invalid topic pattern")]
    InvalidPattern,
    #[error("value field is required")]
    InvalidValue,
    #[error("ttl_secs must be a finite positive number")]
    InvalidTtl,
    #[error("freq_hz must be finite and greater than or equal to zero")]
    InvalidFrequency,
    #[error("source must be non-empty and within configured limits")]
    InvalidSource,
    #[error("value exceeds registry max_value_bytes")]
    ValueTooLarge,
    #[error("registry max_topics limit reached")]
    TooManyTopics,
    #[error("query limit exceeds configured bounds")]
    QueryTooLarge,
    #[error("since_secs must be a finite positive number")]
    InvalidSince,
}

impl RegistryError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidConfig(_) => "invalid_config",
            Self::InvalidTopic => "invalid_topic",
            Self::InvalidPattern => "invalid_pattern",
            Self::InvalidValue => "invalid_value",
            Self::InvalidTtl => "invalid_ttl",
            Self::InvalidFrequency => "invalid_frequency",
            Self::InvalidSource => "invalid_source",
            Self::ValueTooLarge => "value_too_large",
            Self::TooManyTopics => "too_many_topics",
            Self::QueryTooLarge => "query_too_large",
            Self::InvalidSince => "invalid_since",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryWriterKind {
    WebsocketClient,
    MainAgent,
    Subagent,
    ManagedTask,
}

impl RegistryWriterKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WebsocketClient => "websocket_client",
            Self::MainAgent => "main_agent",
            Self::Subagent => "subagent",
            Self::ManagedTask => "managed_task",
        }
    }
}

impl fmt::Display for RegistryWriterKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RegistryTtl {
    Default,
    Seconds(f64),
    Null,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RegistrySetRequest {
    pub topic: String,
    pub value: Option<Value>,
    pub source: String,
    pub ttl: RegistryTtl,
    pub freq_hz: Option<f64>,
}

impl RegistrySetRequest {
    pub fn new(topic: impl Into<String>, value: Value, source: impl Into<String>) -> Self {
        Self {
            topic: topic.into(),
            value: Some(value),
            source: source.into(),
            ttl: RegistryTtl::Default,
            freq_hz: None,
        }
    }

    pub fn missing_value(topic: impl Into<String>, source: impl Into<String>) -> Self {
        Self {
            topic: topic.into(),
            value: None,
            source: source.into(),
            ttl: RegistryTtl::Default,
            freq_hz: None,
        }
    }

    pub fn with_source(mut self, source: impl Into<String>) -> Self {
        self.source = source.into();
        self
    }

    pub fn with_ttl(mut self, ttl: RegistryTtl) -> Self {
        self.ttl = ttl;
        self
    }

    pub fn with_freq_hz(mut self, freq_hz: f64) -> Self {
        self.freq_hz = Some(freq_hz);
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RegistryQuery {
    pub topic: String,
    pub since_secs: Option<f64>,
    pub limit: Option<usize>,
}

impl RegistryQuery {
    pub fn new(topic: impl Into<String>) -> Self {
        Self {
            topic: topic.into(),
            since_secs: None,
            limit: None,
        }
    }

    pub fn history(topic: impl Into<String>, since_secs: f64) -> Self {
        Self {
            topic: topic.into(),
            since_secs: Some(since_secs),
            limit: None,
        }
    }

    pub fn with_limit(mut self, limit: usize) -> Self {
        self.limit = Some(limit);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RegistryItem {
    pub topic: String,
    pub value: Value,
    pub source: String,
    pub writer_kind: RegistryWriterKind,
    pub origin: String,
    pub seq: u64,
    pub freq_hz: Option<f64>,
    pub updated_at: SystemTime,
    pub expires_at: SystemTime,
    pub ttl: Duration,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RegistrySetAck {
    pub topic: String,
    pub source: String,
    pub writer_kind: RegistryWriterKind,
    pub origin: String,
    pub seq: u64,
    pub freq_hz: Option<f64>,
    pub updated_at: SystemTime,
    pub expires_at: SystemTime,
    pub ttl: Duration,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RegistryTopicSummary {
    pub topic: String,
    pub writer_kind: RegistryWriterKind,
    pub origin: String,
    pub source: String,
    pub latest_seq: u64,
    pub last_seen_at: SystemTime,
    pub current: bool,
    pub expires_at: Option<SystemTime>,
    pub sample_count_retained: usize,
    pub freq_hz: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RegistryQueryResult<T> {
    pub server_time: SystemTime,
    pub items: Vec<T>,
    pub matched_count: usize,
    pub returned_count: usize,
    pub truncated: bool,
    pub truncated_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RegistryHistoryResult {
    pub server_time: SystemTime,
    pub items: Vec<RegistryItem>,
    pub oldest_seq: Option<u64>,
    pub newest_seq: Option<u64>,
    pub matched_count: usize,
    pub returned_count: usize,
    pub truncated: bool,
    pub truncated_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RegistryStats {
    pub history_bytes: usize,
    pub pruned_history_items_total: u64,
    pub rejected_writes_total: u64,
}

#[derive(Debug, Clone)]
pub struct RegistryStore {
    config: RegistryConfig,
    options: RegistryStoreOptions,
    instance_id: String,
    started_at: SystemTime,
    inner: Arc<Mutex<RegistryInner>>,
}

#[derive(Debug)]
struct RegistryInner {
    current: HashMap<String, RegistryItem>,
    history: VecDeque<HistoryEntry>,
    history_bytes: usize,
    next_seq: u64,
    pruned_history_items_total: u64,
    rejected_writes_total: u64,
}

#[derive(Debug, Clone)]
struct HistoryEntry {
    item: RegistryItem,
    value_bytes: usize,
}

impl RegistryStore {
    pub fn new(config: RegistryConfig) -> Result<Self, RegistryError> {
        Self::new_at(config, SystemTime::now())
    }

    pub fn new_at(config: RegistryConfig, started_at: SystemTime) -> Result<Self, RegistryError> {
        Self::with_options_at(config, RegistryStoreOptions::default(), started_at)
    }

    pub fn with_options(
        config: RegistryConfig,
        options: RegistryStoreOptions,
    ) -> Result<Self, RegistryError> {
        Self::with_options_at(config, options, SystemTime::now())
    }

    pub fn with_options_at(
        config: RegistryConfig,
        options: RegistryStoreOptions,
        started_at: SystemTime,
    ) -> Result<Self, RegistryError> {
        config.validate()?;
        options.validate()?;
        Ok(Self {
            config,
            options,
            instance_id: new_instance_id(),
            started_at,
            inner: Arc::new(Mutex::new(RegistryInner {
                current: HashMap::new(),
                history: VecDeque::new(),
                history_bytes: 0,
                next_seq: 1,
                pruned_history_items_total: 0,
                rejected_writes_total: 0,
            })),
        })
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn started_at(&self) -> SystemTime {
        self.started_at
    }

    pub fn config(&self) -> &RegistryConfig {
        &self.config
    }

    pub fn options(&self) -> &RegistryStoreOptions {
        &self.options
    }

    pub fn stats(&self) -> RegistryStats {
        let inner = self.lock_inner();
        RegistryStats {
            history_bytes: inner.history_bytes,
            pruned_history_items_total: inner.pruned_history_items_total,
            rejected_writes_total: inner.rejected_writes_total,
        }
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
        prune_locked(&self.config, &mut inner, now);

        if !inner.current.contains_key(&prepared.item.topic)
            && inner.current.len() >= self.config.max_topics
        {
            inner.rejected_writes_total += 1;
            return Err(RegistryError::TooManyTopics);
        }

        let seq = inner.next_seq;
        inner.next_seq = inner.next_seq.saturating_add(1);
        let mut item = prepared.item;
        item.seq = seq;
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

        inner.current.insert(item.topic.clone(), item.clone());
        inner.history.push_back(HistoryEntry {
            item,
            value_bytes: prepared.value_bytes,
        });
        inner.history_bytes = inner.history_bytes.saturating_add(prepared.value_bytes);
        prune_locked(&self.config, &mut inner, now);

        Ok(ack)
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

        let (mut items, matched_count) = {
            let mut inner = self.lock_inner();
            prune_locked(&self.config, &mut inner, now);

            let mut matches = inner
                .current
                .values()
                .filter(|item| !is_expired(item, now) && pattern.matches(&item.topic))
                .collect::<Vec<_>>();
            matches.sort_by(|left, right| left.topic.cmp(&right.topic));
            let matched_count = matches.len();
            let items = matches.into_iter().take(limit).cloned().collect::<Vec<_>>();
            (items, matched_count)
        };

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
        let window = since.min(self.config.retention);

        let (mut items, matched_count) = {
            let mut inner = self.lock_inner();
            prune_locked(&self.config, &mut inner, now);

            let mut items = Vec::new();
            let mut matched_count = 0usize;
            for entry in inner.history.iter().rev() {
                if within_window(entry.item.updated_at, now, window)
                    && pattern.matches(&entry.item.topic)
                {
                    matched_count = matched_count.saturating_add(1);
                    if items.len() < limit {
                        items.push(entry.item.clone());
                    }
                }
            }
            items.reverse();
            (items, matched_count)
        };

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

        let (mut items, matched_count) = {
            let mut inner = self.lock_inner();
            prune_locked(&self.config, &mut inner, now);

            let mut accumulators = HashMap::<String, TopicAccumulator>::new();
            for entry in &inner.history {
                accumulators
                    .entry(entry.item.topic.clone())
                    .or_default()
                    .record_history(&entry.item);
            }
            for item in inner.current.values() {
                accumulators
                    .entry(item.topic.clone())
                    .or_default()
                    .record_current(item, !is_expired(item, now));
            }

            let mut items = accumulators
                .into_values()
                .map(TopicAccumulator::into_summary)
                .filter(|summary| pattern.matches(&summary.topic))
                .collect::<Vec<_>>();
            items.sort_by(|left, right| left.topic.cmp(&right.topic));
            let matched_count = items.len();
            items.truncate(limit);
            (items, matched_count)
        };

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
            RegistryTtl::Default => self.config.default_ttl,
            RegistryTtl::Seconds(seconds) => {
                duration_from_secs(seconds, RegistryError::InvalidTtl)?
            }
            RegistryTtl::Null => return Err(RegistryError::InvalidTtl),
        }
        .min(self.config.retention);
        let freq_hz = match request.freq_hz {
            Some(freq_hz) if !freq_hz.is_finite() || freq_hz < 0.0 => {
                return Err(RegistryError::InvalidFrequency)
            }
            other => other,
        };
        let expires_at = now.checked_add(ttl).unwrap_or(now);

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

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, RegistryInner> {
        self.inner
            .lock()
            .expect("registry store mutex should not be poisoned")
    }

    fn record_rejected_write(&self) {
        let mut inner = self.lock_inner();
        inner.rejected_writes_total = inner.rejected_writes_total.saturating_add(1);
    }
}

impl Default for RegistryStore {
    fn default() -> Self {
        Self::new(RegistryConfig::default()).expect("default registry config should be valid")
    }
}

#[derive(Debug)]
struct PreparedSet {
    item: RegistryItem,
    value_bytes: usize,
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
            .map(|latest| item.seq > latest.seq)
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
            expires_at: Some(latest.expires_at),
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
    expires_at: SystemTime,
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct TopicPattern {
    segments: Vec<PatternSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PatternSegment {
    Literal(String),
    One,
    Rest,
}

impl TopicPattern {
    fn parse(pattern: &str, max_len: usize) -> Result<Self, RegistryError> {
        if pattern.is_empty() || pattern.len() > max_len {
            return Err(RegistryError::InvalidPattern);
        }
        if pattern.starts_with('.') || pattern.ends_with('.') || pattern.contains("..") {
            return Err(RegistryError::InvalidPattern);
        }

        let raw_segments = pattern.split('.').collect::<Vec<_>>();
        let mut segments = Vec::with_capacity(raw_segments.len());
        for (index, segment) in raw_segments.iter().enumerate() {
            match *segment {
                "*" => segments.push(PatternSegment::One),
                "**" => {
                    if index != raw_segments.len() - 1 {
                        return Err(RegistryError::InvalidPattern);
                    }
                    segments.push(PatternSegment::Rest);
                }
                literal => {
                    if !is_valid_topic_segment(literal) {
                        return Err(RegistryError::InvalidPattern);
                    }
                    segments.push(PatternSegment::Literal(literal.to_owned()));
                }
            }
        }

        Ok(Self { segments })
    }

    fn matches(&self, topic: &str) -> bool {
        let topic_segments = topic.split('.').collect::<Vec<_>>();
        let mut topic_index = 0usize;
        for (pattern_index, pattern_segment) in self.segments.iter().enumerate() {
            match pattern_segment {
                PatternSegment::Rest => {
                    return pattern_index == self.segments.len() - 1;
                }
                PatternSegment::One => {
                    if topic_index >= topic_segments.len() {
                        return false;
                    }
                    topic_index += 1;
                }
                PatternSegment::Literal(literal) => {
                    if topic_index >= topic_segments.len() || literal != topic_segments[topic_index]
                    {
                        return false;
                    }
                    topic_index += 1;
                }
            }
        }
        topic_index == topic_segments.len()
    }
}

fn validate_topic_name(topic: &str, max_len: usize) -> Result<(), RegistryError> {
    if topic.is_empty() || topic.len() > max_len {
        return Err(RegistryError::InvalidTopic);
    }
    if topic.starts_with('.') || topic.ends_with('.') || topic.contains("..") {
        return Err(RegistryError::InvalidTopic);
    }
    for segment in topic.split('.') {
        if !is_valid_topic_segment(segment) {
            return Err(RegistryError::InvalidTopic);
        }
    }
    Ok(())
}

fn is_valid_topic_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
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

fn validate_positive_duration(field: &str, value: Duration) -> Result<(), RegistryError> {
    if value.is_zero() {
        Err(RegistryError::InvalidConfig(format!(
            "{field} must be greater than 0"
        )))
    } else {
        Ok(())
    }
}

fn validate_positive_usize(field: &str, value: usize) -> Result<(), RegistryError> {
    if value == 0 {
        Err(RegistryError::InvalidConfig(format!(
            "{field} must be greater than 0"
        )))
    } else {
        Ok(())
    }
}

fn prune_locked(config: &RegistryConfig, inner: &mut RegistryInner, now: SystemTime) {
    let mut retained = VecDeque::with_capacity(inner.history.len());
    let mut retained_bytes = 0usize;
    for entry in inner.history.drain(..) {
        if older_than_retention(entry.item.updated_at, now, config.retention) {
            inner.pruned_history_items_total = inner.pruned_history_items_total.saturating_add(1);
        } else {
            retained_bytes = retained_bytes.saturating_add(entry.value_bytes);
            retained.push_back(entry);
        }
    }
    inner.history = retained;
    inner.history_bytes = retained_bytes;

    inner.current.retain(|_, item| !is_expired(item, now));

    while inner.history.len() > config.max_history_items
        || inner.history_bytes > config.max_history_bytes
    {
        let Some(removed) = inner.history.pop_front() else {
            inner.history_bytes = 0;
            break;
        };
        inner.history_bytes = inner.history_bytes.saturating_sub(removed.value_bytes);
        inner.pruned_history_items_total = inner.pruned_history_items_total.saturating_add(1);
    }
}

fn older_than_retention(updated_at: SystemTime, now: SystemTime, retention: Duration) -> bool {
    now.duration_since(updated_at)
        .is_ok_and(|age| age > retention)
}

fn within_window(updated_at: SystemTime, now: SystemTime, window: Duration) -> bool {
    now.duration_since(updated_at)
        .map(|age| age <= window)
        .unwrap_or(true)
}

fn is_expired(item: &RegistryItem, now: SystemTime) -> bool {
    now.duration_since(item.expires_at).is_ok()
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
    let mut truncated = false;
    while !items.is_empty() && estimated_response_bytes(items) > max_response_bytes {
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

fn estimated_response_bytes<T: Serialize>(items: &[T]) -> usize {
    let item_bytes = items
        .iter()
        .map(|item| {
            serde_json::to_vec(item)
                .map(|encoded| encoded.len())
                .unwrap_or(0)
        })
        .sum::<usize>();
    128usize
        .saturating_add(item_bytes)
        .saturating_add(items.len().saturating_sub(1))
}

fn new_instance_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("reg_{}", hex::encode(bytes))
}
