use std::sync::{atomic::Ordering, Arc};
use std::time::SystemTime;

use tokio::sync::broadcast;

use super::{
    prune_expired_locked, RegistryChange, RegistryError, RegistryItem, RegistryShared,
    RegistryStore, RegistrySubscriptionFilter, RegistrySubscriptionFilterError,
};

#[derive(Debug)]
pub(crate) struct RegistrySubscriptionSnapshot {
    pub(crate) receiver: broadcast::Receiver<RegistryChange>,
    pub(crate) watermark: u64,
    pub(crate) items: Vec<Arc<RegistryItem>>,
    pub(crate) snapshot_time: SystemTime,
    pub(crate) permit: RegistrySubscriptionPermit,
    pub(crate) filter: RegistrySubscriptionFilter,
}

#[derive(Debug)]
pub(crate) struct RegistrySubscriptionPermit {
    shared: Arc<RegistryShared>,
}

impl Drop for RegistrySubscriptionPermit {
    fn drop(&mut self) {
        self.shared
            .active_subscriptions
            .fetch_sub(1, Ordering::AcqRel);
    }
}

impl RegistryStore {
    pub fn subscribe_changes(&self) -> broadcast::Receiver<RegistryChange> {
        self.inner.changes.subscribe()
    }

    pub(crate) fn subscription_filter(
        &self,
        topics: Vec<String>,
    ) -> Result<RegistrySubscriptionFilter, RegistrySubscriptionFilterError> {
        RegistrySubscriptionFilter::new(topics, self.config.max_topic_len)
    }

    pub(crate) fn begin_subscription(
        &self,
        filter: RegistrySubscriptionFilter,
    ) -> Result<RegistrySubscriptionSnapshot, RegistryError> {
        self.begin_subscription_inner(filter, || {})
    }

    #[cfg(test)]
    pub(crate) fn begin_subscription_before_lock<F>(
        &self,
        filter: RegistrySubscriptionFilter,
        before_lock: F,
    ) -> Result<RegistrySubscriptionSnapshot, RegistryError>
    where
        F: FnOnce(),
    {
        self.begin_subscription_inner(filter, before_lock)
    }

    fn begin_subscription_inner<F>(
        &self,
        filter: RegistrySubscriptionFilter,
        before_lock: F,
    ) -> Result<RegistrySubscriptionSnapshot, RegistryError>
    where
        F: FnOnce(),
    {
        let mut active = self.inner.active_subscriptions.load(Ordering::Acquire);
        loop {
            if active >= self.config.max_subscriptions {
                self.inner
                    .subscription_rejected_total
                    .fetch_add(1, Ordering::Relaxed);
                return Err(RegistryError::TooManySubscriptions);
            }
            match self.inner.active_subscriptions.compare_exchange_weak(
                active,
                active + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(actual) => active = actual,
            }
        }
        let permit = RegistrySubscriptionPermit {
            shared: Arc::clone(&self.inner),
        };
        before_lock();
        let mut inner = self.lock_inner();
        let snapshot_time = SystemTime::now();
        prune_expired_locked(&self.config, &self.inner.changes, &mut inner, snapshot_time)?;
        let receiver = self.inner.changes.subscribe();
        let watermark = inner.last_committed_seq;
        let items = inner.current.values().cloned().collect::<Vec<_>>();
        drop(inner);
        let mut items = items
            .into_iter()
            .filter(|item| filter.matches(&item.topic))
            .collect::<Vec<_>>();
        items.sort_by(|left, right| left.topic.cmp(&right.topic));
        Ok(RegistrySubscriptionSnapshot {
            receiver,
            watermark,
            items,
            snapshot_time,
            permit,
            filter,
        })
    }

    pub(crate) fn record_slow_subscription_closed(&self) {
        self.inner
            .slow_subscription_closed_total
            .fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, SystemTime};

    use serde_json::json;

    use super::*;
    use crate::registry::tests::{performance_test_config, timestamp};
    use crate::registry::{
        RegistryChangeKind, RegistryConfig, RegistryQuery, RegistrySetRequest, RegistryTtl,
        RegistryWriterKind,
    };

    fn subscription_filter(store: &RegistryStore, topics: &[&str]) -> RegistrySubscriptionFilter {
        store
            .subscription_filter(topics.iter().map(|topic| (*topic).to_owned()).collect())
            .unwrap()
    }

    #[test]
    fn subscription_snapshot_registers_receiver_before_watermark_and_arc_snapshot() {
        let store = RegistryStore::new_at(performance_test_config(), timestamp(0)).unwrap();
        store
            .set_at(
                RegistryWriterKind::MainAgent,
                "agent:main",
                RegistrySetRequest::new("robot.before", json!(1), "test")
                    .with_ttl(RegistryTtl::Null),
                timestamp(1),
            )
            .unwrap();
        let mut snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        assert_eq!(snapshot.watermark, 1);
        assert_eq!(snapshot.items.len(), 1);
        assert!(Arc::ptr_eq(
            &snapshot.items[0],
            store.lock_inner().current.get("robot.before").unwrap()
        ));

        store
            .set_at(
                RegistryWriterKind::ManagedTask,
                "task:test",
                RegistrySetRequest::new("robot.after", json!(2), "test")
                    .with_ttl(RegistryTtl::Null),
                timestamp(2),
            )
            .unwrap();
        let change = snapshot.receiver.try_recv().unwrap();
        assert_eq!(change.seq(), snapshot.watermark + 1);
        assert_eq!(change.topic(), "robot.after");
    }

    #[test]
    fn subscription_permit_limits_active_subscriptions_and_releases_on_drop() {
        let store = RegistryStore::new_at(
            RegistryConfig {
                max_subscriptions: 1,
                ..performance_test_config()
            },
            timestamp(0),
        )
        .unwrap();

        let first = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        let stats = store.stats();
        assert_eq!(stats.active_subscriptions, 1);
        assert_eq!(stats.max_subscriptions, 1);
        assert_eq!(
            store
                .begin_subscription(subscription_filter(&store, &["robot.**"]))
                .unwrap_err(),
            RegistryError::TooManySubscriptions
        );
        assert_eq!(store.stats().subscription_rejected_total, 1);

        drop(first);
        assert_eq!(store.stats().active_subscriptions, 0);
        let second = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        assert_eq!(store.stats().active_subscriptions, 1);
        drop(second);
        assert_eq!(store.stats().active_subscriptions, 0);
    }

    #[test]
    fn begin_subscription_prunes_at_snapshot_time_and_future_expiry_is_a_change() {
        let store = RegistryStore::new(performance_test_config()).unwrap();
        let current_time = SystemTime::now();
        store
            .set_at(
                RegistryWriterKind::MainAgent,
                "agent:main",
                RegistrySetRequest::new("robot.future", json!(2), "test")
                    .with_ttl(RegistryTtl::Seconds(60.0)),
                current_time,
            )
            .unwrap();
        store
            .set_at(
                RegistryWriterKind::MainAgent,
                "agent:main",
                RegistrySetRequest::new("robot.expired", json!(1), "test")
                    .with_ttl(RegistryTtl::Seconds(1.0)),
                current_time - Duration::from_secs(2),
            )
            .unwrap();

        let mut snapshot = store
            .begin_subscription(subscription_filter(&store, &["robot.**"]))
            .unwrap();
        assert_eq!(snapshot.watermark, 3);
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].topic, "robot.future");
        assert!(snapshot.snapshot_time >= current_time);

        store
            .get_at(
                RegistryQuery::new("robot.future"),
                current_time + Duration::from_secs(61),
            )
            .unwrap();
        let change = snapshot.receiver.try_recv().unwrap();
        assert_eq!(change.kind(), RegistryChangeKind::Expire);
        assert_eq!(change.topic(), "robot.future");
        assert_eq!(change.seq(), snapshot.watermark + 1);
    }

    #[test]
    fn begin_subscription_seq_exhaustion_releases_slot_without_returning_snapshot() {
        let store = RegistryStore::new(performance_test_config()).unwrap();
        store
            .set_at(
                RegistryWriterKind::MainAgent,
                "agent:main",
                RegistrySetRequest::new("robot.expired", json!(1), "test")
                    .with_ttl(RegistryTtl::Seconds(1.0)),
                SystemTime::now() - Duration::from_secs(2),
            )
            .unwrap();
        store.lock_inner().last_committed_seq = u64::MAX;

        assert_eq!(
            store
                .begin_subscription(subscription_filter(&store, &["robot.**"]))
                .unwrap_err(),
            RegistryError::SeqExhausted
        );
        assert_eq!(store.stats().active_subscriptions, 0);
        assert_eq!(store.stats().expire_total, 0);
        assert_eq!(store.stats().current_topics, 1);
    }
}
