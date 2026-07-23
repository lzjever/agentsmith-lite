use std::sync::atomic::Ordering;

use serde_json::Value;

use crate::event::{EventCursor, EventReadError, EventReadWindow, ServiceEvent};
use crate::llm_text_preview::{LlmTextPreviewFilter, LlmTextPreviewSubscription};
use crate::tasks::{task_detail_summary, TaskOwner};
use crate::timeline_store::TimelineStoreError;
use crate::types::Message;

use super::super::{
    current_timeline_cursor, task_list_summary, Service, ServiceState, ServiceStatus,
    TimelineForwardPage, TimelineHistoryPage,
};

impl Service {
    pub fn llm_text_preview_enabled(&self) -> bool {
        self.inner.llm_text_preview_enabled.load(Ordering::SeqCst)
    }
    pub fn subscribe_llm_text_preview(
        &self,
        filter: LlmTextPreviewFilter,
    ) -> Option<LlmTextPreviewSubscription> {
        self.llm_text_preview_enabled()
            .then(|| self.inner.llm_text_preview_hub.subscribe(filter))
    }
    pub fn status(&self) -> ServiceStatus {
        self.inner.status()
    }

    pub fn timeline_bootstrap_snapshot(&self) -> Value {
        self.inner.ensure_registry_maintenance();
        self.inner.timeline_bootstrap_snapshot()
    }

    pub fn context_messages(&self) -> Vec<Message> {
        self.inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .context
            .clone()
    }

    pub fn events_after(&self, after_seq: u64) -> Vec<ServiceEvent> {
        self.inner
            .event_log
            .lock()
            .expect("event log mutex poisoned")
            .read_after(after_seq)
    }

    pub fn events_after_cursor(
        &self,
        cursor: EventCursor,
    ) -> Result<Vec<ServiceEvent>, EventReadError> {
        Ok(self.event_window_after_cursor(cursor)?.events)
    }

    pub fn event_window_after_cursor(
        &self,
        cursor: EventCursor,
    ) -> Result<EventReadWindow, EventReadError> {
        self.inner.event_window_after_cursor(cursor)
    }

    pub fn current_event_cursor(&self) -> EventCursor {
        current_timeline_cursor(&self.inner.timeline_store)
    }

    pub fn timeline_forward_page(
        &self,
        cursor: &str,
        limit: usize,
    ) -> Result<TimelineForwardPage, TimelineStoreError> {
        let snapshot = {
            let store = self
                .inner
                .timeline_store
                .lock()
                .expect("timeline store mutex poisoned");
            if let Some(page) = store.try_cached_forward(cursor, limit)? {
                return Ok(page);
            }
            store.read_snapshot()
        };
        snapshot.read_forward(cursor, limit)
    }

    pub fn timeline_backward_page(
        &self,
        cursor: &str,
        limit: usize,
    ) -> Result<TimelineHistoryPage, TimelineStoreError> {
        let snapshot = {
            let store = self
                .inner
                .timeline_store
                .lock()
                .expect("timeline store mutex poisoned");
            if let Some(page) = store.try_cached_backward(cursor, limit)? {
                return Ok(page);
            }
            store.read_snapshot()
        };
        snapshot.read_backward(cursor, limit)
    }

    pub fn timeline_tail_page(
        &self,
        limit: usize,
    ) -> Result<TimelineHistoryPage, TimelineStoreError> {
        let snapshot = {
            let store = self
                .inner
                .timeline_store
                .lock()
                .expect("timeline store mutex poisoned");
            if let Some(page) = store.try_cached_tail(limit)? {
                return Ok(page);
            }
            store.read_snapshot()
        };
        snapshot.tail(limit)
    }
    pub(crate) async fn wait_for_event_after(&self, seq: u64) {
        loop {
            let notified = self.inner.event_notify.notified();
            if self.current_event_cursor().seq() > seq {
                return;
            }
            notified.await;
        }
    }

    pub fn thread_id(&self) -> String {
        self.inner
            .config
            .session
            .clone()
            .unwrap_or_else(|| "thread_local".to_owned())
    }

    pub fn list_background_tasks(&self) -> Value {
        task_list_summary(self.inner.background_tasks.list_by_owner(&TaskOwner::Main))
    }

    pub fn get_background_task(&self, task_id: &str) -> Option<Value> {
        self.inner
            .background_tasks
            .get_by_owner(&TaskOwner::Main, task_id)
            .map(task_detail_summary)
    }
    pub fn task_preset_list(&self) -> Value {
        self.inner.task_preset_list_details()
    }
    pub async fn wait_for_state(&self, desired: ServiceState) {
        loop {
            let notified = self.inner.notify.notified();
            if self.status().state == desired {
                return;
            }
            notified.await;
        }
    }
}
