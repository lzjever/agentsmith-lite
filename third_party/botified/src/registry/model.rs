use std::fmt;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub(crate) const MIN_REGISTRY_WS_MESSAGE_BYTES: usize = 160;
const REGISTRY_CHANGE_CAPACITY: usize = 4096;
const REGISTRY_SUBSCRIPTION_QUEUE_CAPACITY: usize = 256;
const REGISTRY_SUBSCRIPTION_SEND_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryConfig {
    pub history_retention: Duration,
    pub default_ttl: Duration,
    pub max_subscriptions: usize,
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
    pub(crate) change_broadcast_capacity: usize,
    pub(crate) subscription_queue_capacity: usize,
    pub(crate) subscription_send_timeout: Duration,
}

impl RegistryStoreOptions {
    pub const DEFAULT_WEBSOCKET_MAX_FRAME_BYTES: usize = 64 * 1024;

    pub const fn new() -> Self {
        Self {
            websocket_max_frame_bytes: Self::DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
            change_broadcast_capacity: REGISTRY_CHANGE_CAPACITY,
            subscription_queue_capacity: REGISTRY_SUBSCRIPTION_QUEUE_CAPACITY,
            subscription_send_timeout: REGISTRY_SUBSCRIPTION_SEND_TIMEOUT,
        }
    }

    pub const fn with_websocket_max_frame_bytes(
        mut self,
        websocket_max_frame_bytes: usize,
    ) -> Self {
        self.websocket_max_frame_bytes = websocket_max_frame_bytes;
        self
    }

    #[cfg(test)]
    pub(crate) const fn with_subscription_limits(
        mut self,
        change_broadcast_capacity: usize,
        subscription_queue_capacity: usize,
        subscription_send_timeout: Duration,
    ) -> Self {
        self.change_broadcast_capacity = change_broadcast_capacity;
        self.subscription_queue_capacity = subscription_queue_capacity;
        self.subscription_send_timeout = subscription_send_timeout;
        self
    }

    pub(super) fn validate(&self) -> Result<(), RegistryError> {
        if self.websocket_max_frame_bytes < MIN_REGISTRY_WS_MESSAGE_BYTES {
            return Err(RegistryError::InvalidConfig(format!(
                "registry.websocket_max_frame_bytes must be greater than or equal to {MIN_REGISTRY_WS_MESSAGE_BYTES}"
            )));
        }
        validate_positive_usize(
            "registry.websocket_max_frame_bytes",
            self.websocket_max_frame_bytes,
        )?;
        validate_positive_usize(
            "registry.change_broadcast_capacity",
            self.change_broadcast_capacity,
        )?;
        validate_positive_usize(
            "registry.subscription_queue_capacity",
            self.subscription_queue_capacity,
        )?;
        validate_positive_duration(
            "registry.subscription_send_timeout",
            self.subscription_send_timeout,
        )
    }
}

impl Default for RegistryStoreOptions {
    fn default() -> Self {
        Self::new()
    }
}

impl RegistryConfig {
    pub const DEFAULT_HISTORY_RETENTION: Duration = Duration::from_secs(300);
    pub const DEFAULT_TTL: Duration = Duration::from_secs(5);
    pub const DEFAULT_MAX_SUBSCRIPTIONS: usize = 64;
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
        validate_positive_duration("registry.history_retention", self.history_retention)?;
        validate_positive_duration("registry.default_ttl", self.default_ttl)?;
        validate_positive_usize("registry.max_subscriptions", self.max_subscriptions)?;
        validate_positive_usize("registry.max_topics", self.max_topics)?;
        validate_positive_usize("registry.max_topic_len", self.max_topic_len)?;
        validate_positive_usize("registry.max_source_len", self.max_source_len)?;
        validate_positive_usize("registry.max_value_bytes", self.max_value_bytes)?;
        validate_positive_usize("registry.max_history_items", self.max_history_items)?;
        validate_positive_usize("registry.max_history_bytes", self.max_history_bytes)?;
        validate_positive_usize("registry.default_query_limit", self.default_query_limit)?;
        validate_positive_usize("registry.max_query_limit", self.max_query_limit)?;
        if self.max_response_bytes < MIN_REGISTRY_WS_MESSAGE_BYTES {
            return Err(RegistryError::InvalidConfig(format!(
                "registry.max_response_bytes must be greater than or equal to {MIN_REGISTRY_WS_MESSAGE_BYTES}"
            )));
        }
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
            history_retention: Self::DEFAULT_HISTORY_RETENTION,
            default_ttl: Self::DEFAULT_TTL,
            max_subscriptions: Self::DEFAULT_MAX_SUBSCRIPTIONS,
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
    #[error("registry ttl deadline is outside the supported time range")]
    DeadlineOverflow,
    #[error("registry sequence is exhausted")]
    SeqExhausted,
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
    #[error("registry max_subscriptions limit reached")]
    TooManySubscriptions,
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
            Self::DeadlineOverflow => "deadline_overflow",
            Self::SeqExhausted => "seq_exhausted",
            Self::InvalidFrequency => "invalid_frequency",
            Self::InvalidSource => "invalid_source",
            Self::ValueTooLarge => "value_too_large",
            Self::TooManyTopics => "too_many_topics",
            Self::QueryTooLarge => "query_too_large",
            Self::TooManySubscriptions => "too_many_subscriptions",
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
    pub expires_at: Option<SystemTime>,
    pub ttl: Option<Duration>,
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
    pub expires_at: Option<SystemTime>,
    pub ttl: Option<Duration>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RegistryDeleteAck {
    pub topic: String,
    pub deleted: bool,
    pub seq: Option<u64>,
    pub server_time: SystemTime,
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
    pub known_topics: usize,
    pub current_topics: usize,
    pub history_items: usize,
    pub history_bytes: usize,
    pub last_committed_seq: u64,
    pub set_total: u64,
    pub delete_total: u64,
    pub expire_total: u64,
    pub pruned_history_items_total: u64,
    pub rejected_writes_total: u64,
    pub active_subscriptions: usize,
    pub max_subscriptions: usize,
    pub subscription_rejected_total: u64,
    pub slow_subscription_closed_total: u64,
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
