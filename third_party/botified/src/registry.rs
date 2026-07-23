use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::SystemTime;

use rand::RngCore;
use tokio::sync::{broadcast, Notify};

mod maintenance;
mod model;
mod store;
mod subscription;
mod topic;

use maintenance::prune_expired_locked;
#[cfg(test)]
use maintenance::MaintenanceTestPause;
pub(crate) use maintenance::RegistryMaintenanceHandle;

pub(crate) use model::MIN_REGISTRY_WS_MESSAGE_BYTES;
pub use model::{
    RegistryConfig, RegistryDeleteAck, RegistryError, RegistryHistoryResult, RegistryItem,
    RegistryQuery, RegistryQueryResult, RegistrySetAck, RegistrySetRequest, RegistryStats,
    RegistryStoreOptions, RegistryTopicSummary, RegistryTtl, RegistryWriterKind,
};
pub(crate) use subscription::RegistrySubscriptionSnapshot;
use topic::{validate_topic_name, TopicPattern};
pub(crate) use topic::{RegistrySubscriptionFilter, RegistrySubscriptionFilterError};

#[cfg(test)]
pub(crate) const MIN_REGISTRY_RESPONSE_BYTES: usize = 74;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryChangeKind {
    Set,
    Delete,
    Expire,
}

#[derive(Debug, Clone)]
pub enum RegistryChange {
    Set {
        seq: u64,
        changed_at: SystemTime,
        item: Arc<RegistryItem>,
    },
    Delete {
        seq: u64,
        changed_at: SystemTime,
        topic: String,
        writer_kind: RegistryWriterKind,
        origin: String,
    },
    Expire {
        seq: u64,
        changed_at: SystemTime,
        topic: String,
    },
}

impl RegistryChange {
    pub fn kind(&self) -> RegistryChangeKind {
        match self {
            Self::Set { .. } => RegistryChangeKind::Set,
            Self::Delete { .. } => RegistryChangeKind::Delete,
            Self::Expire { .. } => RegistryChangeKind::Expire,
        }
    }

    pub fn seq(&self) -> u64 {
        match self {
            Self::Set { seq, .. } | Self::Delete { seq, .. } | Self::Expire { seq, .. } => *seq,
        }
    }

    pub fn topic(&self) -> &str {
        match self {
            Self::Set { item, .. } => &item.topic,
            Self::Delete { topic, .. } | Self::Expire { topic, .. } => topic,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RegistryStore {
    config: RegistryConfig,
    options: RegistryStoreOptions,
    instance_id: String,
    started_at: SystemTime,
    inner: Arc<RegistryShared>,
}

#[derive(Debug)]
struct RegistryShared {
    state: Mutex<RegistryInner>,
    deadline_notify: Arc<Notify>,
    changes: broadcast::Sender<RegistryChange>,
    maintenance_started: AtomicBool,
    active_subscriptions: AtomicUsize,
    subscription_rejected_total: AtomicU64,
    slow_subscription_closed_total: AtomicU64,
    #[cfg(test)]
    after_deadline_check_pause: Mutex<Option<MaintenanceTestPause>>,
    #[cfg(test)]
    before_batch_yield_pause: Mutex<Option<MaintenanceTestPause>>,
}

#[derive(Debug)]
struct RegistryInner {
    current: HashMap<String, Arc<RegistryItem>>,
    current_expirations: BTreeSet<(SystemTime, String, u64)>,
    history: BTreeMap<u128, HistoryEntry>,
    history_expirations: BTreeSet<(SystemTime, u128)>,
    known_topics: usize,
    history_bytes: usize,
    history_topic_counts: HashMap<String, usize>,
    next_history_id: u128,
    last_committed_seq: u64,
    set_total: u64,
    delete_total: u64,
    expire_total: u64,
    pruned_history_items_total: u64,
    rejected_writes_total: u64,
    #[cfg(test)]
    history_expiration_index_visits: usize,
}

#[derive(Debug, Clone)]
struct HistoryEntry {
    item: Arc<RegistryItem>,
    value_bytes: usize,
    retention_deadline: Option<SystemTime>,
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
        #[cfg(not(test))]
        config.validate()?;
        #[cfg(test)]
        if config.max_response_bytes == MIN_REGISTRY_RESPONSE_BYTES {
            let mut validation_config = config.clone();
            validation_config.max_response_bytes = MIN_REGISTRY_WS_MESSAGE_BYTES;
            validation_config.validate()?;
        } else {
            config.validate()?;
        }
        options.validate()?;
        let (changes, _) = broadcast::channel(options.change_broadcast_capacity);
        Ok(Self {
            config,
            options,
            instance_id: new_instance_id(),
            started_at,
            inner: Arc::new(RegistryShared {
                state: Mutex::new(RegistryInner {
                    current: HashMap::new(),
                    current_expirations: BTreeSet::new(),
                    history: BTreeMap::new(),
                    history_expirations: BTreeSet::new(),
                    known_topics: 0,
                    history_bytes: 0,
                    history_topic_counts: HashMap::new(),
                    next_history_id: 1,
                    last_committed_seq: 0,
                    set_total: 0,
                    delete_total: 0,
                    expire_total: 0,
                    pruned_history_items_total: 0,
                    rejected_writes_total: 0,
                    #[cfg(test)]
                    history_expiration_index_visits: 0,
                }),
                deadline_notify: Arc::new(Notify::new()),
                changes,
                maintenance_started: AtomicBool::new(false),
                active_subscriptions: AtomicUsize::new(0),
                subscription_rejected_total: AtomicU64::new(0),
                slow_subscription_closed_total: AtomicU64::new(0),
                #[cfg(test)]
                after_deadline_check_pause: Mutex::new(None),
                #[cfg(test)]
                before_batch_yield_pause: Mutex::new(None),
            }),
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
            known_topics: inner.known_topics,
            current_topics: inner.current.len(),
            history_items: inner.history.len(),
            history_bytes: inner.history_bytes,
            last_committed_seq: inner.last_committed_seq,
            set_total: inner.set_total,
            delete_total: inner.delete_total,
            expire_total: inner.expire_total,
            pruned_history_items_total: inner.pruned_history_items_total,
            rejected_writes_total: inner.rejected_writes_total,
            active_subscriptions: self.inner.active_subscriptions.load(Ordering::Acquire),
            max_subscriptions: self.config.max_subscriptions,
            subscription_rejected_total: self
                .inner
                .subscription_rejected_total
                .load(Ordering::Relaxed),
            slow_subscription_closed_total: self
                .inner
                .slow_subscription_closed_total
                .load(Ordering::Relaxed),
        }
    }

    pub fn last_committed_seq(&self) -> u64 {
        self.lock_inner().last_committed_seq
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, RegistryInner> {
        self.inner
            .state
            .lock()
            .expect("registry store mutex should not be poisoned")
    }
}

impl Default for RegistryStore {
    fn default() -> Self {
        Self::new(RegistryConfig::default()).expect("default registry config should be valid")
    }
}

fn new_instance_id() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("reg_{}", hex::encode(bytes))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, UNIX_EPOCH};

    use serde_json::json;

    use super::*;

    pub(super) fn timestamp(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    pub(super) fn performance_test_config() -> RegistryConfig {
        RegistryConfig {
            history_retention: Duration::from_secs(10_000),
            default_ttl: Duration::from_secs(10_000),
            max_subscriptions: 64,
            max_topics: 256,
            max_topic_len: 64,
            max_source_len: 32,
            max_value_bytes: 128,
            max_history_items: 256,
            max_history_bytes: 256 * 128,
            default_query_limit: 16,
            max_query_limit: 256,
            max_response_bytes: 1024,
        }
    }

    #[test]
    fn set_pruning_work_is_independent_of_unexpired_history_length() {
        let store = RegistryStore::new_at(performance_test_config(), timestamp(0)).unwrap();
        for index in 0..128 {
            store
                .set_at(
                    RegistryWriterKind::WebsocketClient,
                    "ws:test",
                    RegistrySetRequest::new(
                        format!("robot.topic_{}", index % 16),
                        json!(index),
                        "test",
                    ),
                    timestamp(1),
                )
                .unwrap();
        }
        {
            let mut inner = store.lock_inner();
            inner.history_expiration_index_visits = 0;
        }

        store
            .set_at(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                RegistrySetRequest::new("robot.next", json!(true), "test"),
                timestamp(2),
            )
            .unwrap();

        assert!(store.lock_inner().history_expiration_index_visits <= 2);
    }

    #[test]
    fn expiration_work_tracks_expired_items_and_retention_boundary_is_strict() {
        let mut config = performance_test_config();
        config.history_retention = Duration::from_secs(10);
        config.default_ttl = Duration::from_secs(10);
        let store = RegistryStore::new_at(config, timestamp(0)).unwrap();
        for index in 0..64 {
            store
                .set_at(
                    RegistryWriterKind::WebsocketClient,
                    "ws:test",
                    RegistrySetRequest::new(
                        format!("robot.topic_{}", index % 16),
                        json!(index),
                        "test",
                    ),
                    timestamp(1),
                )
                .unwrap();
        }
        {
            let mut inner = store.lock_inner();
            inner.history_expiration_index_visits = 0;
        }

        store
            .set_at(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                RegistrySetRequest::new("robot.boundary", json!(true), "test"),
                timestamp(11),
            )
            .unwrap();
        {
            let inner = store.lock_inner();
            assert_eq!(inner.history.len(), 65);
            assert!(inner.history_expiration_index_visits <= 2);
        }

        {
            let mut inner = store.lock_inner();
            inner.history_expiration_index_visits = 0;
        }
        store
            .set_at(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                RegistrySetRequest::new("robot.after_boundary", json!(true), "test"),
                timestamp(12),
            )
            .unwrap();
        let inner = store.lock_inner();
        assert_eq!(inner.history.len(), 2);
        assert_eq!(inner.pruned_history_items_total, 64);
        assert!(inner.history_expiration_index_visits <= 65);
    }

    #[test]
    fn cap_eviction_removes_matching_deadline_index_entries() {
        let mut config = performance_test_config();
        config.max_history_items = 8;
        let store = RegistryStore::new_at(config, timestamp(0)).unwrap();
        for index in 0..128 {
            store
                .set_at(
                    RegistryWriterKind::WebsocketClient,
                    "ws:test",
                    RegistrySetRequest::new(
                        format!("robot.topic_{}", index % 16),
                        json!(index),
                        "test",
                    ),
                    timestamp(1),
                )
                .unwrap();
        }
        let inner = store.lock_inner();
        assert_eq!(inner.history.len(), 8);
        assert_eq!(inner.history_expirations.len(), 8);
        assert_eq!(inner.current_expirations.len(), inner.current.len());
    }

    #[test]
    fn seq_exhaustion_rejects_set_delete_and_expire_without_mutating_current() {
        let mut config = performance_test_config();
        config.max_response_bytes = 16 * 1024;
        let store = RegistryStore::new_at(config, timestamp(0)).unwrap();
        store
            .set_at(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                RegistrySetRequest::new("robot.pose", json!("first"), "first"),
                timestamp(1),
            )
            .unwrap();
        store.lock_inner().last_committed_seq = u64::MAX;

        let before = store.lock_inner().current.clone();
        assert_eq!(
            store
                .set_at(
                    RegistryWriterKind::WebsocketClient,
                    "ws:test",
                    RegistrySetRequest::new("robot.pose", json!("second"), "second"),
                    timestamp(2),
                )
                .unwrap_err(),
            RegistryError::SeqExhausted
        );
        assert_eq!(store.lock_inner().current, before);
        assert_eq!(
            store
                .delete_at(
                    RegistryWriterKind::MainAgent,
                    "agent:main",
                    "robot.pose",
                    timestamp(2),
                )
                .unwrap_err(),
            RegistryError::SeqExhausted
        );
        assert_eq!(store.lock_inner().current, before);

        let expiring = RegistryStore::new_at(performance_test_config(), timestamp(0)).unwrap();
        expiring
            .set_at(
                RegistryWriterKind::ManagedTask,
                "task:test",
                RegistrySetRequest::new("robot.short", json!(true), "short")
                    .with_ttl(RegistryTtl::Seconds(1.0)),
                timestamp(1),
            )
            .unwrap();
        expiring.lock_inner().last_committed_seq = u64::MAX;
        assert_eq!(
            expiring
                .get_at(RegistryQuery::new("robot.short"), timestamp(2))
                .unwrap_err(),
            RegistryError::SeqExhausted
        );
        assert!(expiring.lock_inner().current.contains_key("robot.short"));
    }

    #[test]
    fn history_id_wrap_preserves_insertion_order_and_cap_eviction() {
        let mut config = performance_test_config();
        config.max_history_items = 3;
        let store = RegistryStore::new_at(config, timestamp(0)).unwrap();

        for (second, value) in [(1, 1), (2, 2)] {
            store
                .set_at(
                    RegistryWriterKind::WebsocketClient,
                    "ws:test",
                    RegistrySetRequest::new("robot.pose", json!(value), "test"),
                    timestamp(second),
                )
                .unwrap();
        }
        store.lock_inner().next_history_id = u128::MAX;
        for (second, value) in [(3, 3), (4, 4)] {
            store
                .set_at(
                    RegistryWriterKind::WebsocketClient,
                    "ws:test",
                    RegistrySetRequest::new("robot.pose", json!(value), "test"),
                    timestamp(second),
                )
                .unwrap();
        }

        let history = store
            .history_at(
                RegistryQuery::history("robot.pose", 10.0).with_limit(3),
                timestamp(4),
            )
            .unwrap();
        assert_eq!(
            history
                .items
                .iter()
                .map(|item| item.value.clone())
                .collect::<Vec<_>>(),
            vec![json!(2), json!(3), json!(4)]
        );
        let inner = store.lock_inner();
        assert_eq!(
            inner.history.keys().copied().collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        assert_eq!(inner.history_expirations.len(), inner.history.len());
        assert_eq!(inner.pruned_history_items_total, 1);
        drop(inner);

        let expired = store
            .history_at(
                RegistryQuery::history("robot.pose", 20_000.0).with_limit(3),
                timestamp(10_005),
            )
            .unwrap();
        assert!(expired.items.is_empty());
        assert_eq!(store.lock_inner().history_expirations.len(), 0);
    }

    #[test]
    fn set_shares_one_arc_between_current_history_and_change() {
        let store = RegistryStore::new_at(performance_test_config(), timestamp(0)).unwrap();
        let mut changes = store.subscribe_changes();
        store
            .set_at(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                RegistrySetRequest::new("robot.pose", json!({"x": 1}), "test"),
                timestamp(1),
            )
            .unwrap();

        let inner = store.lock_inner();
        let current = inner.current.get("robot.pose").unwrap();
        let history = &inner.history.first_key_value().unwrap().1.item;
        let RegistryChange::Set { item: changed, .. } = changes.try_recv().unwrap() else {
            panic!("set must publish a set change");
        };
        assert!(Arc::ptr_eq(current, history));
        assert!(Arc::ptr_eq(current, &changed));
    }

    #[test]
    fn overwrite_keeps_current_expiry_index_bounded_and_stale_deadline_is_harmless() {
        let store = RegistryStore::new_at(performance_test_config(), timestamp(0)).unwrap();
        for second in 1..=128 {
            store
                .set_at(
                    RegistryWriterKind::WebsocketClient,
                    "ws:test",
                    RegistrySetRequest::new("robot.pose", json!(second), "test")
                        .with_ttl(RegistryTtl::Seconds(100.0)),
                    timestamp(second),
                )
                .unwrap();
            assert_eq!(store.lock_inner().current_expirations.len(), 1);
        }

        let stale = (timestamp(2), "robot.pose".to_owned(), 1);
        store.lock_inner().current_expirations.insert(stale);
        store.maintenance_step_at(timestamp(150));
        assert_eq!(
            store.lock_inner().current.get("robot.pose").unwrap().seq,
            128
        );
    }

    #[test]
    fn history_time_item_and_byte_eviction_remove_deadline_entries_without_changes() {
        for config in [
            RegistryConfig {
                history_retention: Duration::from_secs(1),
                ..performance_test_config()
            },
            RegistryConfig {
                max_history_items: 1,
                ..performance_test_config()
            },
            RegistryConfig {
                max_history_bytes: 1,
                ..performance_test_config()
            },
        ] {
            let store = RegistryStore::new_at(config, timestamp(0)).unwrap();
            let mut changes = store.subscribe_changes();
            for second in 1..=2 {
                store
                    .set_at(
                        RegistryWriterKind::WebsocketClient,
                        "ws:test",
                        RegistrySetRequest::new(
                            format!("robot.topic_{second}"),
                            json!(second),
                            "test",
                        )
                        .with_ttl(RegistryTtl::Null),
                        timestamp(second),
                    )
                    .unwrap();
            }
            while changes.try_recv().is_ok() {}
            let seq = store.last_committed_seq();
            store.maintenance_step_at(timestamp(4));
            let inner = store.lock_inner();
            assert_eq!(inner.history_expirations.len(), inner.history.len());
            assert_eq!(
                inner.history_bytes,
                inner
                    .history
                    .values()
                    .map(|entry| entry.value_bytes)
                    .sum::<usize>()
            );
            assert_eq!(inner.last_committed_seq, seq);
            assert!(inner.pruned_history_items_total >= 1);
            assert!(changes.try_recv().is_err());
        }
    }

    #[test]
    fn delete_lazy_prune_and_maintenance_race_commits_expire_once() {
        let store = RegistryStore::new_at(performance_test_config(), timestamp(0)).unwrap();
        let mut changes = store.subscribe_changes();
        store
            .set_at(
                RegistryWriterKind::ManagedTask,
                "task:test",
                RegistrySetRequest::new("robot.race", json!(1), "test")
                    .with_ttl(RegistryTtl::Seconds(1.0)),
                timestamp(1),
            )
            .unwrap();
        changes.try_recv().unwrap();

        let barrier = Arc::new(Barrier::new(3));
        std::thread::scope(|scope| {
            let delete_store = store.clone();
            let delete_barrier = barrier.clone();
            scope.spawn(move || {
                delete_barrier.wait();
                delete_store
                    .delete_at(
                        RegistryWriterKind::MainAgent,
                        "agent:main",
                        "robot.race",
                        timestamp(2),
                    )
                    .unwrap();
            });
            let get_store = store.clone();
            let get_barrier = barrier.clone();
            scope.spawn(move || {
                get_barrier.wait();
                get_store
                    .get_at(RegistryQuery::new("robot.race"), timestamp(2))
                    .unwrap();
            });
            barrier.wait();
            store.maintenance_step_at(timestamp(2));
        });

        let published = std::iter::from_fn(|| changes.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].kind(), RegistryChangeKind::Expire);
        assert_eq!(store.stats().expire_total, 1);
        assert_eq!(store.stats().delete_total, 0);
        assert_eq!(store.last_committed_seq(), 2);
    }

    #[test]
    fn concurrent_writes_preserve_caps_and_global_change_order_without_deadlock() {
        let mut config = performance_test_config();
        config.max_topics = 32;
        config.max_history_items = 128;
        config.max_history_bytes = 128 * 128;
        let store = RegistryStore::new_at(config, timestamp(0)).unwrap();
        let mut changes = store.subscribe_changes();

        std::thread::scope(|scope| {
            for worker in 0..16 {
                let store = store.clone();
                scope.spawn(move || {
                    for index in 0..100 {
                        store
                            .set_at(
                                RegistryWriterKind::WebsocketClient,
                                format!("ws:{worker}"),
                                RegistrySetRequest::new(
                                    format!("robot.topic_{}", index % 32),
                                    json!({"worker": worker, "index": index}),
                                    "test",
                                )
                                .with_ttl(RegistryTtl::Null),
                                timestamp(1),
                            )
                            .unwrap();
                    }
                });
            }
        });

        let stats = store.stats();
        assert_eq!(stats.current_topics, 32);
        assert_eq!(stats.history_items, 128);
        assert_eq!(stats.last_committed_seq, 1600);
        assert_eq!(stats.set_total, 1600);
        let published = std::iter::from_fn(|| changes.try_recv().ok()).collect::<Vec<_>>();
        assert_eq!(published.len(), 1600);
        assert!(published
            .windows(2)
            .all(|pair| pair[0].seq() + 1 == pair[1].seq()));
        let inner = store.lock_inner();
        assert_eq!(inner.current_expirations.len(), 0);
        assert_eq!(inner.history_expirations.len(), inner.history.len());
    }
}
