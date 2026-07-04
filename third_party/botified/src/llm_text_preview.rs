use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

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
            time: timestamp_now(),
            provider_request_id: metadata.provider_request_id.clone(),
            turn_id: metadata.turn_id.clone(),
            cycle_id: metadata.cycle_id.clone(),
            provider_call_index: metadata.provider_call_index,
            input_ids: metadata.input_ids.clone(),
        }
    }

    pub fn text_delta(metadata: &LlmTextPreviewMetadata, delta: impl Into<String>) -> Self {
        Self::TextDelta {
            time: timestamp_now(),
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
            time: timestamp_now(),
            provider_request_id: metadata.provider_request_id.clone(),
            turn_id: metadata.turn_id.clone(),
            cycle_id: metadata.cycle_id.clone(),
            provider_call_index: metadata.provider_call_index,
            input_ids: metadata.input_ids.clone(),
            text_emitted,
            stop_reason: stop_reason_name(stop_reason).to_owned(),
        }
    }

    pub fn aborted(metadata: &LlmTextPreviewMetadata, reason: impl Into<String>) -> Self {
        Self::Aborted {
            time: timestamp_now(),
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
            time: timestamp_now(),
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
            time: timestamp_now(),
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
        let id = inner.next_subscriber_id;
        inner.next_subscriber_id = inner.next_subscriber_id.saturating_add(1);
        inner
            .subscribers
            .push(LlmTextPreviewSubscriber { id, filter, tx });
        LlmTextPreviewSubscription { rx }
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
                Err(mpsc::error::TrySendError::Full(_)) => false,
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            }
        });
    }
}

struct LlmTextPreviewSubscriber {
    #[allow(dead_code)]
    id: u64,
    filter: LlmTextPreviewFilter,
    tx: mpsc::Sender<LlmTextPreviewFrame>,
}

pub struct LlmTextPreviewSubscription {
    rx: mpsc::Receiver<LlmTextPreviewFrame>,
}

impl LlmTextPreviewSubscription {
    pub async fn recv(&mut self) -> Option<LlmTextPreviewFrame> {
        self.rx.recv().await
    }

    pub fn try_recv(&mut self) -> Result<LlmTextPreviewFrame, mpsc::error::TryRecvError> {
        self.rx.try_recv()
    }
}

fn timestamp_now() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("unix:{}", duration.as_secs())
}

fn stop_reason_name(stop_reason: StopReason) -> &'static str {
    match stop_reason {
        StopReason::EndTurn => "end_turn",
        StopReason::ToolCalls => "tool_calls",
        StopReason::ToolTerminated => "tool_terminated",
        StopReason::ProviderStop => "provider_stop",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
