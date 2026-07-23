use std::fmt;
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::formatting::unix_timestamp_now;
use crate::types::StopReason;

const DEFAULT_SUBSCRIBER_CAPACITY: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LlmTextPreviewMetadata {
    pub provider_request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cycle_id: Option<String>,
    pub provider_call_index: usize,
    #[serde(default)]
    pub input_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LlmTextPreviewFilter {
    pub provider_request_id: Option<String>,
    pub cycle_id: Option<String>,
    pub input_id: Option<String>,
}

impl LlmTextPreviewFilter {
    pub fn matches(&self, frame: &LlmTextPreviewFrame) -> bool {
        if let Some(provider_request_id) = self.provider_request_id.as_deref() {
            if frame.provider_request_id() != provider_request_id {
                return false;
            }
        }
        if let Some(cycle_id) = self.cycle_id.as_deref() {
            if frame.cycle_id() != Some(cycle_id) {
                return false;
            }
        }
        if let Some(input_id) = self.input_id.as_deref() {
            if !frame.input_ids().iter().any(|id| id == input_id) {
                return false;
            }
        }
        true
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum LlmTextPreviewFrame {
    Started {
        time: String,
        provider_request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cycle_id: Option<String>,
        provider_call_index: usize,
        input_ids: Vec<String>,
    },
    TextDelta {
        time: String,
        provider_request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cycle_id: Option<String>,
        provider_call_index: usize,
        input_ids: Vec<String>,
        delta: String,
    },
    Finished {
        time: String,
        provider_request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cycle_id: Option<String>,
        provider_call_index: usize,
        input_ids: Vec<String>,
        text_emitted: bool,
        stop_reason: String,
    },
    Aborted {
        time: String,
        provider_request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cycle_id: Option<String>,
        provider_call_index: usize,
        input_ids: Vec<String>,
        reason: String,
    },
    Error {
        time: String,
        provider_request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cycle_id: Option<String>,
        provider_call_index: usize,
        input_ids: Vec<String>,
        code: String,
        retryable: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_status: Option<u16>,
    },
    Status {
        time: String,
        provider_request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cycle_id: Option<String>,
        provider_call_index: usize,
        input_ids: Vec<String>,
        code: String,
    },
}

impl LlmTextPreviewFrame {
    pub fn event_name(&self) -> &'static str {
        match self {
            Self::Started { .. } => "started",
            Self::TextDelta { .. } => "text_delta",
            Self::Finished { .. } => "finished",
            Self::Aborted { .. } => "aborted",
            Self::Error { .. } => "error",
            Self::Status { .. } => "status",
        }
    }

    pub fn event_type(&self) -> &'static str {
        self.event_name()
    }

    pub fn started(metadata: &LlmTextPreviewMetadata) -> Self {
        Self::Started {
            time: unix_timestamp_now(),
            provider_request_id: metadata.provider_request_id.clone(),
            turn_id: metadata.turn_id.clone(),
            cycle_id: metadata.cycle_id.clone(),
            provider_call_index: metadata.provider_call_index,
            input_ids: metadata.input_ids.clone(),
        }
    }

    pub fn text_delta(metadata: &LlmTextPreviewMetadata, delta: impl Into<String>) -> Self {
        Self::TextDelta {
            time: unix_timestamp_now(),
            provider_request_id: metadata.provider_request_id.clone(),
            turn_id: metadata.turn_id.clone(),
            cycle_id: metadata.cycle_id.clone(),
            provider_call_index: metadata.provider_call_index,
            input_ids: metadata.input_ids.clone(),
            delta: delta.into(),
        }
    }

    pub fn finished(
        metadata: &LlmTextPreviewMetadata,
        text_emitted: bool,
        stop_reason: StopReason,
    ) -> Self {
        Self::Finished {
            time: unix_timestamp_now(),
            provider_request_id: metadata.provider_request_id.clone(),
            turn_id: metadata.turn_id.clone(),
            cycle_id: metadata.cycle_id.clone(),
            provider_call_index: metadata.provider_call_index,
            input_ids: metadata.input_ids.clone(),
            text_emitted,
            stop_reason: stop_reason.as_str().to_owned(),
        }
    }

    pub fn aborted(metadata: &LlmTextPreviewMetadata, reason: impl Into<String>) -> Self {
        Self::Aborted {
            time: unix_timestamp_now(),
            provider_request_id: metadata.provider_request_id.clone(),
            turn_id: metadata.turn_id.clone(),
            cycle_id: metadata.cycle_id.clone(),
            provider_call_index: metadata.provider_call_index,
            input_ids: metadata.input_ids.clone(),
            reason: reason.into(),
        }
    }

    pub fn error(
        metadata: &LlmTextPreviewMetadata,
        code: impl Into<String>,
        retryable: bool,
        provider_status: Option<u16>,
    ) -> Self {
        Self::Error {
            time: unix_timestamp_now(),
            provider_request_id: metadata.provider_request_id.clone(),
            turn_id: metadata.turn_id.clone(),
            cycle_id: metadata.cycle_id.clone(),
            provider_call_index: metadata.provider_call_index,
            input_ids: metadata.input_ids.clone(),
            code: code.into(),
            retryable,
            provider_status,
        }
    }

    pub fn status(metadata: &LlmTextPreviewMetadata, code: impl Into<String>) -> Self {
        Self::Status {
            time: unix_timestamp_now(),
            provider_request_id: metadata.provider_request_id.clone(),
            turn_id: metadata.turn_id.clone(),
            cycle_id: metadata.cycle_id.clone(),
            provider_call_index: metadata.provider_call_index,
            input_ids: metadata.input_ids.clone(),
            code: code.into(),
        }
    }

    pub fn provider_request_id(&self) -> &str {
        match self {
            Self::Started {
                provider_request_id,
                ..
            }
            | Self::TextDelta {
                provider_request_id,
                ..
            }
            | Self::Finished {
                provider_request_id,
                ..
            }
            | Self::Aborted {
                provider_request_id,
                ..
            }
            | Self::Error {
                provider_request_id,
                ..
            }
            | Self::Status {
                provider_request_id,
                ..
            } => provider_request_id,
        }
    }

    pub fn turn_id(&self) -> Option<&str> {
        match self {
            Self::Started { turn_id, .. }
            | Self::TextDelta { turn_id, .. }
            | Self::Finished { turn_id, .. }
            | Self::Aborted { turn_id, .. }
            | Self::Error { turn_id, .. }
            | Self::Status { turn_id, .. } => turn_id.as_deref(),
        }
    }

    pub fn cycle_id(&self) -> Option<&str> {
        match self {
            Self::Started { cycle_id, .. }
            | Self::TextDelta { cycle_id, .. }
            | Self::Finished { cycle_id, .. }
            | Self::Aborted { cycle_id, .. }
            | Self::Error { cycle_id, .. }
            | Self::Status { cycle_id, .. } => cycle_id.as_deref(),
        }
    }

    pub fn provider_call_index(&self) -> usize {
        match self {
            Self::Started {
                provider_call_index,
                ..
            }
            | Self::TextDelta {
                provider_call_index,
                ..
            }
            | Self::Finished {
                provider_call_index,
                ..
            }
            | Self::Aborted {
                provider_call_index,
                ..
            }
            | Self::Error {
                provider_call_index,
                ..
            }
            | Self::Status {
                provider_call_index,
                ..
            } => *provider_call_index,
        }
    }

    pub fn input_ids(&self) -> &[String] {
        match self {
            Self::Started { input_ids, .. }
            | Self::TextDelta { input_ids, .. }
            | Self::Finished { input_ids, .. }
            | Self::Aborted { input_ids, .. }
            | Self::Error { input_ids, .. }
            | Self::Status { input_ids, .. } => input_ids,
        }
    }

    pub fn delta_text(&self) -> Option<&str> {
        match self {
            Self::TextDelta { delta, .. } => Some(delta),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct ProviderPreviewContext {
    pub metadata: LlmTextPreviewMetadata,
    pub sink: LlmTextPreviewSink,
}

impl ProviderPreviewContext {
    pub fn new(metadata: LlmTextPreviewMetadata, sink: LlmTextPreviewSink) -> Self {
        Self { metadata, sink }
    }
}

impl fmt::Debug for ProviderPreviewContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderPreviewContext")
            .field("metadata", &self.metadata)
            .field("sink", &"<runtime>")
            .finish()
    }
}

impl PartialEq for ProviderPreviewContext {
    fn eq(&self, other: &Self) -> bool {
        self.metadata == other.metadata
    }
}

impl Eq for ProviderPreviewContext {}

#[derive(Clone)]
pub struct LlmTextPreviewHub {
    inner: Arc<Mutex<LlmTextPreviewHubInner>>,
}

impl LlmTextPreviewHub {
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_SUBSCRIBER_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(LlmTextPreviewHubInner {
                subscribers: Vec::new(),
                next_subscriber_id: 1,
                capacity: capacity.max(1),
            })),
        }
    }

    pub fn sink(&self) -> LlmTextPreviewSink {
        LlmTextPreviewSink {
            inner: self.inner.clone(),
        }
    }

    pub fn subscribe(&self, filter: LlmTextPreviewFilter) -> LlmTextPreviewSubscription {
        let mut inner = self.inner.lock().expect("preview hub mutex poisoned");
        let (tx, rx) = mpsc::channel(inner.capacity);
        let terminal_frame = Arc::new(Mutex::new(None));
        let id = inner.next_subscriber_id;
        inner.next_subscriber_id = inner.next_subscriber_id.saturating_add(1);
        inner.subscribers.push(LlmTextPreviewSubscriber {
            id,
            filter,
            tx,
            terminal_frame: terminal_frame.clone(),
        });
        LlmTextPreviewSubscription {
            rx,
            hub: Arc::downgrade(&self.inner),
            subscriber_id: id,
            terminal_frame,
        }
    }
}

impl Default for LlmTextPreviewHub {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for LlmTextPreviewHub {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LlmTextPreviewHub")
    }
}

#[derive(Clone)]
pub struct LlmTextPreviewSink {
    inner: Arc<Mutex<LlmTextPreviewHubInner>>,
}

impl LlmTextPreviewSink {
    pub fn publish(&self, frame: LlmTextPreviewFrame) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.publish(frame);
    }
}

impl fmt::Debug for LlmTextPreviewSink {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("LlmTextPreviewSink")
    }
}

struct LlmTextPreviewHubInner {
    subscribers: Vec<LlmTextPreviewSubscriber>,
    next_subscriber_id: u64,
    capacity: usize,
}

impl LlmTextPreviewHubInner {
    fn publish(&mut self, frame: LlmTextPreviewFrame) {
        self.subscribers
            .retain(|subscriber| !subscriber.tx.is_closed());
        self.subscribers.retain(|subscriber| {
            if !subscriber.filter.matches(&frame) {
                return true;
            }
            match subscriber.tx.try_send(frame.clone()) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    subscriber.record_lagged(&frame);
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            }
        });
    }
}

struct LlmTextPreviewSubscriber {
    id: u64,
    filter: LlmTextPreviewFilter,
    tx: mpsc::Sender<LlmTextPreviewFrame>,
    terminal_frame: Arc<Mutex<Option<LlmTextPreviewFrame>>>,
}

impl LlmTextPreviewSubscriber {
    fn record_lagged(&self, frame: &LlmTextPreviewFrame) {
        let Ok(mut terminal_frame) = self.terminal_frame.lock() else {
            return;
        };
        if terminal_frame.is_none() {
            *terminal_frame = Some(status_frame_from(frame, "subscriber_lagged"));
        }
    }
}

pub struct LlmTextPreviewSubscription {
    rx: mpsc::Receiver<LlmTextPreviewFrame>,
    hub: Weak<Mutex<LlmTextPreviewHubInner>>,
    subscriber_id: u64,
    terminal_frame: Arc<Mutex<Option<LlmTextPreviewFrame>>>,
}

impl LlmTextPreviewSubscription {
    pub async fn recv(&mut self) -> Option<LlmTextPreviewFrame> {
        match self.rx.recv().await {
            Some(frame) => Some(frame),
            None => self.take_terminal_frame(),
        }
    }

    pub fn try_recv(&mut self) -> Result<LlmTextPreviewFrame, mpsc::error::TryRecvError> {
        match self.rx.try_recv() {
            Ok(frame) => Ok(frame),
            Err(mpsc::error::TryRecvError::Disconnected) => self
                .take_terminal_frame()
                .ok_or(mpsc::error::TryRecvError::Disconnected),
            Err(error) => Err(error),
        }
    }

    fn take_terminal_frame(&self) -> Option<LlmTextPreviewFrame> {
        self.terminal_frame.lock().ok()?.take()
    }
}

fn status_frame_from(frame: &LlmTextPreviewFrame, code: &str) -> LlmTextPreviewFrame {
    LlmTextPreviewFrame::status(
        &LlmTextPreviewMetadata {
            provider_request_id: frame.provider_request_id().to_owned(),
            turn_id: frame.turn_id().map(ToOwned::to_owned),
            cycle_id: frame.cycle_id().map(ToOwned::to_owned),
            provider_call_index: frame.provider_call_index(),
            input_ids: frame.input_ids().to_vec(),
        },
        code,
    )
}

impl Drop for LlmTextPreviewSubscription {
    fn drop(&mut self) {
        let Some(hub) = self.hub.upgrade() else {
            return;
        };
        let Ok(mut inner) = hub.lock() else {
            return;
        };
        inner
            .subscribers
            .retain(|subscriber| subscriber.id != self.subscriber_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn llm_text_preview_drop_unregisters_without_publish() {
        let hub = LlmTextPreviewHub::new();

        for _ in 0..1_000 {
            drop(hub.subscribe(LlmTextPreviewFilter::default()));
        }

        assert_eq!(
            hub.inner
                .lock()
                .expect("preview hub mutex poisoned")
                .subscribers
                .len(),
            0
        );
    }

    #[test]
    fn llm_text_preview_drop_and_publish_are_concurrency_safe() {
        const PUBLISHERS: usize = 8;
        const FRAMES_PER_PUBLISHER: usize = 100;
        const CHURNERS: usize = 8;
        const SUBSCRIPTIONS_PER_CHURNER: usize = 500;

        let hub = LlmTextPreviewHub::with_capacity(PUBLISHERS * FRAMES_PER_PUBLISHER);
        let mut stable_subscription = hub.subscribe(LlmTextPreviewFilter::default());
        let metadata = LlmTextPreviewMetadata {
            provider_request_id: "prq_concurrent".to_owned(),
            turn_id: Some("turn-1".to_owned()),
            cycle_id: Some("cyc-1".to_owned()),
            provider_call_index: 0,
            input_ids: vec!["msg-1".to_owned()],
        };

        thread::scope(|scope| {
            for _ in 0..PUBLISHERS {
                let sink = hub.sink();
                let metadata = metadata.clone();
                scope.spawn(move || {
                    for _ in 0..FRAMES_PER_PUBLISHER {
                        sink.publish(LlmTextPreviewFrame::text_delta(&metadata, "delta"));
                    }
                });
            }
            for _ in 0..CHURNERS {
                let hub = hub.clone();
                scope.spawn(move || {
                    for _ in 0..SUBSCRIPTIONS_PER_CHURNER {
                        drop(hub.subscribe(LlmTextPreviewFilter::default()));
                    }
                });
            }
        });

        let mut received = 0;
        while stable_subscription.try_recv().is_ok() {
            received += 1;
        }
        assert_eq!(received, PUBLISHERS * FRAMES_PER_PUBLISHER);
        assert_eq!(
            hub.inner
                .lock()
                .expect("preview hub mutex poisoned")
                .subscribers
                .len(),
            1
        );

        drop(stable_subscription);
        assert!(hub
            .inner
            .lock()
            .expect("preview hub mutex poisoned")
            .subscribers
            .is_empty());
    }

    #[test]
    fn llm_text_preview_slow_subscriber_gets_one_lag_status_before_disconnect() {
        let hub = LlmTextPreviewHub::with_capacity(1);
        let mut subscription = hub.subscribe(LlmTextPreviewFilter::default());
        let metadata = LlmTextPreviewMetadata {
            provider_request_id: "prq_slow".to_owned(),
            turn_id: None,
            cycle_id: None,
            provider_call_index: 0,
            input_ids: Vec::new(),
        };
        let sink = hub.sink();

        sink.publish(LlmTextPreviewFrame::text_delta(&metadata, "first"));
        sink.publish(LlmTextPreviewFrame::text_delta(&metadata, "second"));

        assert_eq!(
            subscription
                .try_recv()
                .expect("queued first frame should remain available")
                .delta_text(),
            Some("first")
        );
        match subscription
            .try_recv()
            .expect("lagged subscriber should receive a terminal status")
        {
            LlmTextPreviewFrame::Status {
                provider_request_id,
                code,
                ..
            } => {
                assert_eq!(provider_request_id, "prq_slow");
                assert_eq!(code, "subscriber_lagged");
            }
            other => panic!("expected terminal lag status, got {other:?}"),
        }
        assert_eq!(
            subscription.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        );
        assert!(hub
            .inner
            .lock()
            .expect("preview hub mutex poisoned")
            .subscribers
            .is_empty());
    }

    #[test]
    fn llm_text_preview_publish_cleans_closed_filtered_subscriber() {
        let hub = LlmTextPreviewHub::new();
        let subscription = hub.subscribe(LlmTextPreviewFilter {
            provider_request_id: Some("prq_never_matches".to_owned()),
            cycle_id: None,
            input_id: None,
        });
        assert_eq!(
            hub.inner
                .lock()
                .expect("preview hub mutex poisoned")
                .subscribers
                .len(),
            1
        );

        drop(subscription);
        hub.sink()
            .publish(LlmTextPreviewFrame::started(&LlmTextPreviewMetadata {
                provider_request_id: "prq_other".to_owned(),
                turn_id: Some("turn-1".to_owned()),
                cycle_id: Some("cyc_1".to_owned()),
                provider_call_index: 1,
                input_ids: vec!["msg_1".to_owned()],
            }));

        assert_eq!(
            hub.inner
                .lock()
                .expect("preview hub mutex poisoned")
                .subscribers
                .len(),
            0
        );
    }
}
