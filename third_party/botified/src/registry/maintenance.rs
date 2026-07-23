use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Weak,
};
use std::time::SystemTime;

use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use super::store::{commit_change_locked, remove_history_entry_locked, RegistryCommit};
use super::{
    RegistryChange, RegistryConfig, RegistryError, RegistryInner, RegistryShared, RegistryStore,
};

const MAINTENANCE_BATCH_SIZE: usize = 64;

#[derive(Debug)]
pub(crate) struct RegistryMaintenanceHandle {
    cancel: CancellationToken,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl RegistryMaintenanceHandle {
    pub(crate) async fn join(mut self) {
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

impl Drop for RegistryMaintenanceHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

struct MaintenanceStartGuard<'a> {
    started: &'a AtomicBool,
    armed: bool,
}

impl Drop for MaintenanceStartGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.started.store(false, Ordering::Release);
        }
    }
}

#[cfg(test)]
#[derive(Debug)]
pub(super) struct MaintenanceTestPause {
    entered: Arc<std::sync::Barrier>,
    resume: Arc<std::sync::Barrier>,
}

#[cfg(test)]
impl MaintenanceTestPause {
    fn wait(self) {
        self.entered.wait();
        self.resume.wait();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct MaintenanceStep {
    processed: usize,
    more_due: bool,
    blocked: bool,
}

impl RegistryStore {
    pub(crate) fn start_maintenance(
        &self,
        service_shutdown: CancellationToken,
    ) -> Option<RegistryMaintenanceHandle> {
        let runtime = tokio::runtime::Handle::try_current().ok()?;
        if self
            .inner
            .maintenance_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return None;
        }
        let mut start_guard = MaintenanceStartGuard {
            started: &self.inner.maintenance_started,
            armed: true,
        };
        let cancel = CancellationToken::new();
        let join = runtime.spawn(run_registry_maintenance(
            Arc::downgrade(&self.inner),
            self.config.clone(),
            service_shutdown,
            cancel.clone(),
        ));
        start_guard.armed = false;
        Some(RegistryMaintenanceHandle {
            cancel,
            join: Some(join),
        })
    }

    #[cfg(test)]
    pub(super) fn maintenance_step_at(&self, now: SystemTime) -> MaintenanceStep {
        maintenance_step(&self.inner, &self.config, now)
    }

    #[cfg(test)]
    fn pause_maintenance_after_deadline_check(
        &self,
        entered: Arc<std::sync::Barrier>,
        resume: Arc<std::sync::Barrier>,
    ) {
        *self
            .inner
            .after_deadline_check_pause
            .lock()
            .expect("registry maintenance test hook mutex poisoned") =
            Some(MaintenanceTestPause { entered, resume });
    }

    #[cfg(test)]
    fn pause_maintenance_before_batch_yield(
        &self,
        entered: Arc<std::sync::Barrier>,
        resume: Arc<std::sync::Barrier>,
    ) {
        *self
            .inner
            .before_batch_yield_pause
            .lock()
            .expect("registry maintenance test hook mutex poisoned") =
            Some(MaintenanceTestPause { entered, resume });
    }
}

pub(super) fn prune_expired_locked(
    config: &RegistryConfig,
    changes: &broadcast::Sender<RegistryChange>,
    inner: &mut RegistryInner,
    now: SystemTime,
) -> Result<(), RegistryError> {
    #[cfg(test)]
    {
        inner.history_expiration_index_visits =
            inner.history_expiration_index_visits.saturating_add(1);
    }
    while let Some(&(deadline, history_id)) = inner.history_expirations.first() {
        if deadline >= now {
            break;
        }
        inner.history_expirations.remove(&(deadline, history_id));
        remove_history_entry_locked(inner, history_id);
        #[cfg(test)]
        {
            inner.history_expiration_index_visits =
                inner.history_expiration_index_visits.saturating_add(1);
        }
    }

    while let Some((expires_at, topic, item_seq)) = inner.current_expirations.first().cloned() {
        if expires_at > now {
            break;
        }
        if inner
            .current
            .get(&topic)
            .is_some_and(|item| item.expires_at == Some(expires_at) && item.seq == item_seq)
        {
            commit_change_locked(
                config,
                changes,
                inner,
                RegistryCommit::Expire {
                    topic,
                    item_seq,
                    changed_at: now,
                },
            )?;
        } else {
            inner
                .current_expirations
                .remove(&(expires_at, topic, item_seq));
        }
    }
    Ok(())
}

fn next_deadline_locked(inner: &RegistryInner) -> Option<SystemTime> {
    let current = inner.current_expirations.first().map(|entry| entry.0);
    let history = inner.history_expirations.first().map(|entry| entry.0);
    match (current, history) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(deadline), None) | (None, Some(deadline)) => Some(deadline),
        (None, None) => None,
    }
}

fn maintenance_step(
    shared: &RegistryShared,
    config: &RegistryConfig,
    now: SystemTime,
) -> MaintenanceStep {
    let mut inner = shared
        .state
        .lock()
        .expect("registry store mutex should not be poisoned");
    let mut processed = 0;
    let mut blocked = false;
    while processed < MAINTENANCE_BATCH_SIZE {
        let due_history = inner
            .history_expirations
            .first()
            .copied()
            .filter(|(deadline, _)| *deadline < now);
        let due_current = inner
            .current_expirations
            .first()
            .cloned()
            .filter(|(deadline, _, _)| *deadline <= now);
        match (due_history, due_current) {
            (None, None) => break,
            (Some((deadline, history_id)), None) => {
                inner.history_expirations.remove(&(deadline, history_id));
                remove_history_entry_locked(&mut inner, history_id);
            }
            (Some((deadline, history_id)), Some((current_deadline, _, _)))
                if deadline <= current_deadline =>
            {
                inner.history_expirations.remove(&(deadline, history_id));
                remove_history_entry_locked(&mut inner, history_id);
            }
            (_, Some((expires_at, topic, item_seq))) => {
                let result = commit_change_locked(
                    config,
                    &shared.changes,
                    &mut inner,
                    RegistryCommit::Expire {
                        topic: topic.clone(),
                        item_seq,
                        changed_at: now,
                    },
                );
                if result.is_err() {
                    blocked = true;
                    break;
                }
                inner
                    .current_expirations
                    .remove(&(expires_at, topic, item_seq));
            }
        }
        processed += 1;
    }
    let more_due = inner
        .history_expirations
        .first()
        .is_some_and(|(deadline, _)| *deadline < now)
        || inner
            .current_expirations
            .first()
            .is_some_and(|(deadline, _, _)| *deadline <= now);
    MaintenanceStep {
        processed,
        more_due,
        blocked,
    }
}

async fn run_registry_maintenance(
    inner: Weak<RegistryShared>,
    config: RegistryConfig,
    service_shutdown: CancellationToken,
    handle_cancel: CancellationToken,
) {
    loop {
        let Some(shared) = inner.upgrade() else {
            return;
        };
        let notify = shared.deadline_notify.clone();
        let notified = notify.notified_owned();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let deadline = {
            let state = shared
                .state
                .lock()
                .expect("registry store mutex should not be poisoned");
            next_deadline_locked(&state)
        };
        #[cfg(test)]
        let after_deadline_check_pause = shared
            .after_deadline_check_pause
            .lock()
            .expect("registry maintenance test hook mutex poisoned")
            .take();
        drop(shared);
        #[cfg(test)]
        if let Some(pause) = after_deadline_check_pause {
            pause.wait();
        }

        match deadline {
            Some(deadline) => {
                let sleep = tokio::time::sleep(
                    deadline
                        .duration_since(SystemTime::now())
                        .unwrap_or_default(),
                );
                tokio::pin!(sleep);
                tokio::select! {
                    _ = service_shutdown.cancelled() => return,
                    _ = handle_cancel.cancelled() => return,
                    _ = &mut notified => continue,
                    _ = &mut sleep => {}
                }
            }
            None => {
                tokio::select! {
                    _ = service_shutdown.cancelled() => return,
                    _ = handle_cancel.cancelled() => return,
                    _ = &mut notified => continue,
                }
            }
        }

        let maintenance_time = SystemTime::now();
        loop {
            let Some(shared) = inner.upgrade() else {
                return;
            };
            let step = maintenance_step(&shared, &config, maintenance_time);
            #[cfg(test)]
            let before_batch_yield_pause = if step.more_due && !step.blocked {
                shared
                    .before_batch_yield_pause
                    .lock()
                    .expect("registry maintenance test hook mutex poisoned")
                    .take()
            } else {
                None
            };
            drop(shared);
            if step.blocked {
                return;
            }
            if !step.more_due {
                break;
            }
            #[cfg(test)]
            if let Some(pause) = before_batch_yield_pause {
                pause.wait();
            }
            tokio::task::yield_now().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::registry::tests::{performance_test_config, timestamp};
    use crate::registry::{
        RegistryChangeKind, RegistrySetRequest, RegistryTtl, RegistryWriterKind,
    };

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_and_repeated_maintenance_start_has_one_owner_and_no_loser_cleanup() {
        let store = RegistryStore::new_at(performance_test_config(), timestamp(0)).unwrap();
        store
            .set_at(
                RegistryWriterKind::ManagedTask,
                "task:test",
                RegistrySetRequest::new("robot.backlog", json!(1), "test")
                    .with_ttl(RegistryTtl::Seconds(1.0)),
                timestamp(1),
            )
            .unwrap();
        let entered = Arc::new(Barrier::new(2));
        let resume = Arc::new(Barrier::new(2));
        store.pause_maintenance_after_deadline_check(entered.clone(), resume.clone());
        let shutdown = CancellationToken::new();
        let callers = Arc::new(tokio::sync::Barrier::new(9));
        let mut starts = Vec::new();
        for _ in 0..8 {
            let store = store.clone();
            let shutdown = shutdown.clone();
            let callers = callers.clone();
            starts.push(tokio::spawn(async move {
                callers.wait().await;
                store.start_maintenance(shutdown)
            }));
        }
        callers.wait().await;
        let mut handles = Vec::new();
        for start in starts {
            if let Some(handle) = start.await.unwrap() {
                handles.push(handle);
            }
        }
        assert_eq!(handles.len(), 1);

        tokio::task::spawn_blocking(move || entered.wait())
            .await
            .unwrap();
        assert!(store.start_maintenance(shutdown.clone()).is_none());
        assert_eq!(store.stats().current_topics, 1);
        assert_eq!(store.stats().history_items, 1);

        shutdown.cancel();
        tokio::task::spawn_blocking(move || resume.wait())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), handles.pop().unwrap().join())
            .await
            .expect("the unique maintenance owner must stop on cancellation");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn real_maintenance_batches_release_lock_for_competing_writer() {
        let mut config = performance_test_config();
        config.max_topics = MAINTENANCE_BATCH_SIZE * 3;
        config.max_history_items = MAINTENANCE_BATCH_SIZE * 3;
        let store = RegistryStore::new_at(config, timestamp(0)).unwrap();
        let mut changes = store.subscribe_changes();
        for index in 0..(MAINTENANCE_BATCH_SIZE + 7) {
            store
                .set_at(
                    RegistryWriterKind::ManagedTask,
                    "task:test",
                    RegistrySetRequest::new(format!("robot.{index}"), json!(index), "test")
                        .with_ttl(RegistryTtl::Seconds(1.0)),
                    timestamp(1),
                )
                .unwrap();
        }
        while changes.try_recv().is_ok() {}
        let entered = Arc::new(Barrier::new(2));
        let resume = Arc::new(Barrier::new(2));
        store.pause_maintenance_before_batch_yield(entered.clone(), resume.clone());
        let shutdown = CancellationToken::new();
        let handle = store
            .start_maintenance(shutdown.clone())
            .expect("runtime should start maintenance");
        tokio::task::spawn_blocking(move || entered.wait())
            .await
            .unwrap();
        assert_eq!(store.stats().expire_total, MAINTENANCE_BATCH_SIZE as u64);
        assert_eq!(store.stats().current_topics, 7);

        let writer = store.clone();
        tokio::time::timeout(
            Duration::from_secs(1),
            tokio::task::spawn_blocking(move || {
                writer.set_at(
                    RegistryWriterKind::WebsocketClient,
                    "ws:between-batches",
                    RegistrySetRequest::new("robot.writer", json!(true), "test")
                        .with_ttl(RegistryTtl::Null),
                    timestamp(1),
                )
            }),
        )
        .await
        .expect("writer must acquire the registry lock between maintenance batches")
        .unwrap()
        .unwrap();
        tokio::task::spawn_blocking(move || resume.wait())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let stats = store.stats();
                if stats.expire_total == (MAINTENANCE_BATCH_SIZE + 7) as u64
                    && stats.history_items == 0
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("maintenance must continue through the remaining batches");
        assert_eq!(store.stats().current_topics, 1);

        let mut seqs = Vec::new();
        while let Ok(change) = changes.try_recv() {
            if change.kind() == RegistryChangeKind::Expire {
                seqs.push(change.seq());
            }
        }
        assert_eq!(seqs.len(), MAINTENANCE_BATCH_SIZE + 7);
        assert!(seqs.windows(2).all(|pair| pair[0] < pair[1]));
        shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(1), handle.join())
            .await
            .expect("maintenance must stop on shutdown");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn registered_notify_catches_earlier_deadline_inserted_before_await() {
        let mut config = performance_test_config();
        config.history_retention = Duration::from_secs(60);
        let store = RegistryStore::new(config).unwrap();
        store
            .set(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                RegistrySetRequest::new("robot.later", json!(1), "test")
                    .with_ttl(RegistryTtl::Seconds(30.0)),
            )
            .unwrap();
        let entered = Arc::new(Barrier::new(2));
        let resume = Arc::new(Barrier::new(2));
        store.pause_maintenance_after_deadline_check(entered.clone(), resume.clone());
        let shutdown = CancellationToken::new();
        let handle = store
            .start_maintenance(shutdown.clone())
            .expect("runtime should start maintenance");
        tokio::task::spawn_blocking(move || entered.wait())
            .await
            .unwrap();
        store
            .set(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                RegistrySetRequest::new("robot.earlier", json!(2), "test")
                    .with_ttl(RegistryTtl::Seconds(0.02)),
            )
            .unwrap();
        tokio::task::spawn_blocking(move || resume.wait())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if store.stats().expire_total == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("registered notification must wake the earlier deadline");
        assert_eq!(store.stats().current_topics, 1);

        shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(1), handle.join())
            .await
            .expect("maintenance must stop on shutdown");
    }
}
