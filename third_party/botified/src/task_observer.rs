use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, Weak,
};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::llm_text_preview::LlmTextPreviewFrame;
#[cfg(target_os = "linux")]
use crate::tasks::OBSERVER_STDIN_ATOMIC_WRITE_BYTES;
use crate::tasks::{TaskStdinWriter, DEFAULT_BOTIFIED_FRAME_BYTES};

const DEFAULT_OBSERVE_QUEUE_CAPACITY: usize = 32;
const OBSERVE_TEXT_CHUNK_BYTES: usize = 384;
const OBSERVE_FIELD_CHARS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskObserveMode {
    Final,
    Stream,
}

impl TaskObserveMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "final" => Some(Self::Final),
            "stream" => Some(Self::Stream),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Final => "final",
            Self::Stream => "stream",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskObserverDiagnostic {
    pub task_id: String,
    pub code: &'static str,
    pub message: String,
}

type TaskObserverDiagnosticSink = Arc<dyn Fn(TaskObserverDiagnostic) + Send + Sync>;

#[derive(Clone)]
pub struct TaskConversationObserver {
    inner: Arc<TaskConversationObserverInner>,
}

struct TaskConversationObserverInner {
    observers: Mutex<HashMap<String, ObserverState>>,
    next_generation: AtomicU64,
    next_observation_id: AtomicU64,
    diagnostic_sink: TaskObserverDiagnosticSink,
}

#[derive(Clone)]
struct ObserverState {
    mode: TaskObserveMode,
    sender: mpsc::Sender<String>,
    generation: u64,
    cancel: CancellationToken,
}

#[derive(Debug, Clone)]
pub struct FinalTextObservation<'a> {
    pub kind: FinalTextObservationKind,
    pub text: &'a str,
    pub message_id: Option<&'a str>,
    pub cycle_id: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalTextObservationKind {
    UserText,
    AssistantText,
}

impl FinalTextObservationKind {
    fn frame_kind(self) -> &'static str {
        match self {
            Self::UserText => "user_text",
            Self::AssistantText => "assistant_text",
        }
    }
}

impl TaskConversationObserver {
    pub fn new(diagnostic_sink: impl Fn(TaskObserverDiagnostic) + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(TaskConversationObserverInner {
                observers: Mutex::new(HashMap::new()),
                next_generation: AtomicU64::new(1),
                next_observation_id: AtomicU64::new(1),
                diagnostic_sink: Arc::new(diagnostic_sink),
            }),
        }
    }

    pub fn enable(
        &self,
        task_id: impl Into<String>,
        mode: TaskObserveMode,
        writer: Arc<dyn TaskStdinWriter>,
    ) -> CancellationToken {
        let task_id = task_id.into();
        let generation = self.inner.next_generation.fetch_add(1, Ordering::SeqCst);
        let cancel = CancellationToken::new();
        let (sender, receiver) = mpsc::channel(DEFAULT_OBSERVE_QUEUE_CAPACITY);
        let previous = {
            let mut observers = self
                .inner
                .observers
                .lock()
                .expect("task observer mutex poisoned");
            observers.insert(
                task_id.clone(),
                ObserverState {
                    mode,
                    sender,
                    generation,
                    cancel: cancel.clone(),
                },
            )
        };
        if let Some(previous) = previous {
            previous.cancel.cancel();
        }
        spawn_observer_writer(
            Arc::downgrade(&self.inner),
            task_id,
            generation,
            cancel.clone(),
            receiver,
            writer,
        );
        cancel
    }

    pub fn disable(&self, task_id: &str) -> bool {
        let removed = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .remove(task_id);
        if let Some(removed) = removed {
            removed.cancel.cancel();
            return true;
        }
        false
    }

    pub fn remove_task(&self, task_id: &str) {
        self.disable(task_id);
    }

    pub fn is_observing(&self, task_id: &str) -> bool {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .contains_key(task_id)
    }

    pub fn mode_for_task(&self, task_id: &str) -> Option<TaskObserveMode> {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .get(task_id)
            .map(|state| state.mode)
    }

    pub fn has_stream_observers(&self) -> bool {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .values()
            .any(|state| state.mode == TaskObserveMode::Stream)
    }

    pub fn publish_final_text(&self, observation: FinalTextObservation<'_>) {
        let frames = self.inner.final_text_frames(observation);
        self.publish_frames(TaskObserveMode::Final, frames);
    }

    pub fn publish_preview_frame(&self, frame: &LlmTextPreviewFrame) {
        // The preview loop can outlive stream observers; skip idle JSON frame construction.
        if !self.has_stream_observers() {
            return;
        }
        let frames = self.inner.preview_frames(frame);
        if !frames.is_empty() {
            self.publish_frames(TaskObserveMode::Stream, frames);
        }
    }

    fn publish_frames(&self, mode: TaskObserveMode, frames: Vec<String>) {
        if frames.is_empty() {
            return;
        }
        let targets = {
            let observers = self
                .inner
                .observers
                .lock()
                .expect("task observer mutex poisoned");
            observers
                .iter()
                .filter(|(_, state)| state.mode == mode)
                .map(|(task_id, state)| (task_id.clone(), state.generation, state.sender.clone()))
                .collect::<Vec<_>>()
        };

        for (task_id, generation, sender) in targets {
            for frame in &frames {
                match sender.try_send(frame.clone()) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        self.inner.remove_generation_with_diagnostic(
                            &task_id,
                            generation,
                            "observer_queue_full",
                            "task observe queue is full",
                        );
                        break;
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        self.inner.remove_generation_with_diagnostic(
                            &task_id,
                            generation,
                            "observer_queue_closed",
                            "task observe queue is closed",
                        );
                        break;
                    }
                }
            }
        }
    }
}

impl TaskConversationObserverInner {
    fn final_text_frames(&self, observation: FinalTextObservation<'_>) -> Vec<String> {
        if observation.text.trim().is_empty() {
            return Vec::new();
        }
        let metadata = ObserveFrameMetadata {
            mode: TaskObserveMode::Final,
            kind: observation.kind.frame_kind(),
            message_id: observation.message_id,
            provider_request_id: None,
            cycle_id: observation.cycle_id,
            text_emitted: None,
            error: None,
        };
        self.text_frames(metadata, observation.text)
    }

    fn preview_frames(&self, frame: &LlmTextPreviewFrame) -> Vec<String> {
        match frame {
            LlmTextPreviewFrame::Started {
                provider_request_id,
                cycle_id,
                ..
            } => self.text_frames(
                ObserveFrameMetadata {
                    mode: TaskObserveMode::Stream,
                    kind: "assistant_text_started",
                    message_id: None,
                    provider_request_id: Some(provider_request_id),
                    cycle_id: cycle_id.as_deref(),
                    text_emitted: None,
                    error: None,
                },
                "",
            ),
            LlmTextPreviewFrame::TextDelta {
                provider_request_id,
                cycle_id,
                delta,
                ..
            } => self.text_frames(
                ObserveFrameMetadata {
                    mode: TaskObserveMode::Stream,
                    kind: "assistant_text",
                    message_id: None,
                    provider_request_id: Some(provider_request_id),
                    cycle_id: cycle_id.as_deref(),
                    text_emitted: None,
                    error: None,
                },
                delta,
            ),
            LlmTextPreviewFrame::Finished {
                provider_request_id,
                cycle_id,
                text_emitted,
                ..
            } => self.text_frames(
                ObserveFrameMetadata {
                    mode: TaskObserveMode::Stream,
                    kind: "assistant_text_done",
                    message_id: None,
                    provider_request_id: Some(provider_request_id),
                    cycle_id: cycle_id.as_deref(),
                    text_emitted: Some(*text_emitted),
                    error: None,
                },
                "",
            ),
            LlmTextPreviewFrame::Aborted {
                provider_request_id,
                cycle_id,
                ..
            } => self.text_frames(
                ObserveFrameMetadata {
                    mode: TaskObserveMode::Stream,
                    kind: "assistant_text_error",
                    message_id: None,
                    provider_request_id: Some(provider_request_id),
                    cycle_id: cycle_id.as_deref(),
                    text_emitted: None,
                    error: Some(ObserveErrorPayload {
                        code: "aborted".to_owned(),
                        retryable: true,
                        provider_status: None,
                    }),
                },
                "",
            ),
            LlmTextPreviewFrame::Error {
                provider_request_id,
                cycle_id,
                code,
                retryable,
                provider_status,
                ..
            } => self.text_frames(
                ObserveFrameMetadata {
                    mode: TaskObserveMode::Stream,
                    kind: "assistant_text_error",
                    message_id: None,
                    provider_request_id: Some(provider_request_id),
                    cycle_id: cycle_id.as_deref(),
                    text_emitted: None,
                    error: Some(ObserveErrorPayload {
                        code: bounded_chars(code, OBSERVE_FIELD_CHARS),
                        retryable: *retryable,
                        provider_status: *provider_status,
                    }),
                },
                "",
            ),
            LlmTextPreviewFrame::Status { .. } => Vec::new(),
        }
    }

    fn text_frames(&self, metadata: ObserveFrameMetadata<'_>, text: &str) -> Vec<String> {
        let observation_id = format!(
            "obs_{}",
            self.next_observation_id.fetch_add(1, Ordering::SeqCst)
        );
        let chunks = chunk_text_by_bytes(text, OBSERVE_TEXT_CHUNK_BYTES);
        let timestamp = timestamp_now();
        let last_index = chunks.len().saturating_sub(1);
        chunks
            .into_iter()
            .enumerate()
            .map(|(index, chunk)| {
                observe_frame(
                    &observation_id,
                    metadata.clone(),
                    chunk,
                    index,
                    index == last_index,
                    &timestamp,
                )
            })
            .collect()
    }

    fn remove_generation_with_diagnostic(
        &self,
        task_id: &str,
        generation: u64,
        code: &'static str,
        message: impl Into<String>,
    ) {
        let removed = {
            let mut observers = self.observers.lock().expect("task observer mutex poisoned");
            let should_remove = observers
                .get(task_id)
                .is_some_and(|state| state.generation == generation);
            should_remove.then(|| observers.remove(task_id)).flatten()
        };
        if let Some(removed) = removed {
            removed.cancel.cancel();
            (self.diagnostic_sink)(TaskObserverDiagnostic {
                task_id: task_id.to_owned(),
                code,
                message: message.into(),
            });
        }
    }
}

fn spawn_observer_writer(
    inner: Weak<TaskConversationObserverInner>,
    task_id: String,
    generation: u64,
    cancel: CancellationToken,
    mut receiver: mpsc::Receiver<String>,
    writer: Arc<dyn TaskStdinWriter>,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                frame = receiver.recv() => {
                    let Some(frame) = frame else {
                        break;
                    };
                    let write = write_observe_frame_blocking(writer.clone(), frame);
                    tokio::pin!(write);
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        result = &mut write => {
                            if let Err(error) = result {
                                if let Some(inner) = inner.upgrade() {
                                    inner.remove_generation_with_diagnostic(
                                        &task_id,
                                        generation,
                                        "observer_write_failed",
                                        bounded_chars(&error, 512),
                                    );
                                }
                                break;
                            }
                        }
                    }
                }
            }
        }
    });
}

async fn write_observe_frame_blocking(
    writer: Arc<dyn TaskStdinWriter>,
    frame: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || writer.try_write_observer_stdin(frame.as_bytes()))
        .await
        .unwrap_or_else(|error| Err(format!("observer writer task failed: {error}")))
}

#[derive(Clone)]
struct ObserveFrameMetadata<'a> {
    mode: TaskObserveMode,
    kind: &'static str,
    message_id: Option<&'a str>,
    provider_request_id: Option<&'a str>,
    cycle_id: Option<&'a str>,
    text_emitted: Option<bool>,
    error: Option<ObserveErrorPayload>,
}

#[derive(Debug, Clone, Serialize)]
struct ObserveFramePayload<'a> {
    op: &'static str,
    id: &'a str,
    kind: &'static str,
    mode: &'static str,
    text: &'a str,
    chunk_index: usize,
    is_last_chunk: bool,
    timestamp: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cycle_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text_emitted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ObserveErrorPayload>,
}

#[derive(Debug, Clone, Serialize)]
struct ObserveErrorPayload {
    code: String,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_status: Option<u16>,
}

fn observe_frame(
    observation_id: &str,
    metadata: ObserveFrameMetadata<'_>,
    text: &str,
    chunk_index: usize,
    is_last_chunk: bool,
    timestamp: &str,
) -> String {
    let payload = ObserveFramePayload {
        op: "observe",
        id: observation_id,
        kind: metadata.kind,
        mode: metadata.mode.as_str(),
        text,
        chunk_index,
        is_last_chunk,
        timestamp,
        message_id: metadata
            .message_id
            .map(|value| bounded_chars(value, OBSERVE_FIELD_CHARS)),
        provider_request_id: metadata
            .provider_request_id
            .map(|value| bounded_chars(value, OBSERVE_FIELD_CHARS)),
        cycle_id: metadata
            .cycle_id
            .map(|value| bounded_chars(value, OBSERVE_FIELD_CHARS)),
        text_emitted: metadata.text_emitted,
        error: metadata.error,
    };
    let json = serde_json::to_string(&payload).expect("observe frame should serialize");
    debug_assert!(json.len() + "<botified></botified>\n".len() <= DEFAULT_BOTIFIED_FRAME_BYTES);
    #[cfg(target_os = "linux")]
    debug_assert!(
        json.len() + "<botified></botified>\n".len() <= OBSERVER_STDIN_ATOMIC_WRITE_BYTES
    );
    format!("<botified>{json}</botified>\n")
}

fn chunk_text_by_bytes(text: &str, max_bytes: usize) -> Vec<&str> {
    if text.is_empty() {
        return vec![""];
    }
    let max_bytes = max_bytes.max(1);
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + max_bytes).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            end = text[start..]
                .char_indices()
                .nth(1)
                .map(|(offset, _)| start + offset)
                .unwrap_or(text.len());
        }
        chunks.push(&text[start..end]);
        start = end;
    }
    chunks
}

fn bounded_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    value.chars().take(max_chars).collect()
}

fn timestamp_now() -> String {
    system_time_rfc3339(SystemTime::now())
}

fn system_time_rfc3339(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let total_seconds = duration.as_secs() as i64;
    let nanos = duration.subsec_nanos();
    let days_since_unix_epoch = total_seconds.div_euclid(86_400);
    let seconds_of_day = total_seconds.rem_euclid(86_400);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    let (year, month, day) = civil_from_days(days_since_unix_epoch);
    if nanos == 0 {
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
    } else {
        let millis = nanos / 1_000_000;
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
    }
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_piece = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_piece + 2) / 5 + 1;
    let month = month_piece + if month_piece < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };

    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_text_preview::LlmTextPreviewMetadata;
    use crate::tasks::TASK_STDIN_OBSERVE_FRAME_BYTES;
    use crate::types::StopReason;
    use serde_json::Value;
    use std::sync::{atomic::AtomicUsize, Condvar, Mutex as StdMutex};
    use std::time::Duration;
    use tokio::sync::oneshot;

    #[derive(Clone, Default)]
    struct RecordingStdin {
        text: Arc<StdMutex<String>>,
    }

    impl RecordingStdin {
        fn text(&self) -> String {
            self.text
                .lock()
                .expect("recording stdin mutex poisoned")
                .clone()
        }
    }

    impl TaskStdinWriter for RecordingStdin {
        fn write_stdin(&self, bytes: &[u8]) -> Result<(), String> {
            self.text
                .lock()
                .expect("recording stdin mutex poisoned")
                .push_str(&String::from_utf8_lossy(bytes));
            Ok(())
        }

        fn supports_observer_stdin(&self) -> bool {
            true
        }

        fn try_write_observer_stdin(&self, bytes: &[u8]) -> Result<(), String> {
            self.write_stdin(bytes)
        }
    }

    #[derive(Clone)]
    struct BlockingStdin {
        started: Arc<StdMutex<Option<oneshot::Sender<()>>>>,
        release: Arc<(StdMutex<bool>, Condvar)>,
        completed_writes: Arc<AtomicUsize>,
    }

    impl BlockingStdin {
        fn new() -> (Self, oneshot::Receiver<()>) {
            let (started_tx, started_rx) = oneshot::channel();
            (
                Self {
                    started: Arc::new(StdMutex::new(Some(started_tx))),
                    release: Arc::new((StdMutex::new(false), Condvar::new())),
                    completed_writes: Arc::new(AtomicUsize::new(0)),
                },
                started_rx,
            )
        }

        fn release(&self) {
            let (lock, cvar) = &*self.release;
            *lock.lock().expect("blocking stdin mutex poisoned") = true;
            cvar.notify_all();
        }

        fn completed_writes(&self) -> usize {
            self.completed_writes.load(Ordering::SeqCst)
        }

        fn release_on_drop(&self) -> BlockingStdinReleaseGuard {
            BlockingStdinReleaseGuard {
                stdin: self.clone(),
            }
        }
    }

    impl TaskStdinWriter for BlockingStdin {
        fn write_stdin(&self, _bytes: &[u8]) -> Result<(), String> {
            if let Some(started) = self
                .started
                .lock()
                .expect("blocking stdin started mutex poisoned")
                .take()
            {
                let _ = started.send(());
            }
            let (lock, cvar) = &*self.release;
            let mut released = lock.lock().expect("blocking stdin mutex poisoned");
            while !*released {
                released = cvar
                    .wait(released)
                    .expect("blocking stdin condvar wait failed");
            }
            self.completed_writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn supports_observer_stdin(&self) -> bool {
            true
        }

        fn try_write_observer_stdin(&self, bytes: &[u8]) -> Result<(), String> {
            self.write_stdin(bytes)
        }
    }

    struct BlockingStdinReleaseGuard {
        stdin: BlockingStdin,
    }

    impl Drop for BlockingStdinReleaseGuard {
        fn drop(&mut self) {
            self.stdin.release();
        }
    }

    #[derive(Clone)]
    struct HoldFirstRecordingStdin {
        first_started: Arc<StdMutex<Option<oneshot::Sender<()>>>>,
        release_first: Arc<(StdMutex<bool>, Condvar)>,
        call_count: Arc<AtomicUsize>,
        writes: Arc<StdMutex<Vec<String>>>,
    }

    impl HoldFirstRecordingStdin {
        fn new() -> (Self, oneshot::Receiver<()>) {
            let (started_tx, started_rx) = oneshot::channel();
            (
                Self {
                    first_started: Arc::new(StdMutex::new(Some(started_tx))),
                    release_first: Arc::new((StdMutex::new(false), Condvar::new())),
                    call_count: Arc::new(AtomicUsize::new(0)),
                    writes: Arc::new(StdMutex::new(Vec::new())),
                },
                started_rx,
            )
        }

        fn release_first(&self) {
            let (lock, cvar) = &*self.release_first;
            *lock
                .lock()
                .expect("hold-first stdin release mutex poisoned") = true;
            cvar.notify_all();
        }

        fn release_first_on_drop(&self) -> HoldFirstRecordingStdinReleaseGuard {
            HoldFirstRecordingStdinReleaseGuard {
                stdin: self.clone(),
            }
        }

        fn write_count(&self) -> usize {
            self.writes
                .lock()
                .expect("hold-first stdin writes mutex poisoned")
                .len()
        }

        fn text(&self) -> String {
            self.writes
                .lock()
                .expect("hold-first stdin writes mutex poisoned")
                .join("")
        }
    }

    struct HoldFirstRecordingStdinReleaseGuard {
        stdin: HoldFirstRecordingStdin,
    }

    impl Drop for HoldFirstRecordingStdinReleaseGuard {
        fn drop(&mut self) {
            self.stdin.release_first();
        }
    }

    impl TaskStdinWriter for HoldFirstRecordingStdin {
        fn write_stdin(&self, bytes: &[u8]) -> Result<(), String> {
            let index = self.call_count.fetch_add(1, Ordering::SeqCst);
            if index == 0 {
                if let Some(started) = self
                    .first_started
                    .lock()
                    .expect("hold-first stdin started mutex poisoned")
                    .take()
                {
                    let _ = started.send(());
                }
                let (lock, cvar) = &*self.release_first;
                let mut released = lock
                    .lock()
                    .expect("hold-first stdin release mutex poisoned");
                while !*released {
                    released = cvar
                        .wait(released)
                        .expect("hold-first stdin condvar wait failed");
                }
            }
            self.writes
                .lock()
                .expect("hold-first stdin writes mutex poisoned")
                .push(String::from_utf8_lossy(bytes).to_string());
            Ok(())
        }

        fn supports_observer_stdin(&self) -> bool {
            true
        }

        fn try_write_observer_stdin(&self, bytes: &[u8]) -> Result<(), String> {
            self.write_stdin(bytes)
        }
    }

    fn frame_values(text: &str) -> Vec<Value> {
        text.split("<botified>")
            .skip(1)
            .map(|rest| {
                let end = rest.find("</botified>").expect("frame should close");
                serde_json::from_str(&rest[..end]).expect("frame should be valid JSON")
            })
            .collect()
    }

    fn frame_strings(text: &str) -> Vec<String> {
        text.split_inclusive('\n')
            .filter(|line| line.starts_with("<botified>"))
            .map(ToOwned::to_owned)
            .collect()
    }

    async fn wait_until(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if condition() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("condition should become true before timeout");
    }

    #[tokio::test]
    async fn final_text_frames_are_valid_chunked_observe_json() {
        let observer = TaskConversationObserver::new(|_| {});
        let stdin = RecordingStdin::default();
        observer.enable("task-a", TaskObserveMode::Final, Arc::new(stdin.clone()));

        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: &format!("alpha-{}-omega", "x".repeat(OBSERVE_TEXT_CHUNK_BYTES + 16)),
            message_id: Some("assistant-public"),
            cycle_id: Some("cycle-1"),
        });
        wait_until(|| frame_values(&stdin.text()).len() >= 2).await;

        let frames = frame_values(&stdin.text());
        assert!(frames.len() >= 2);
        assert!(frames.iter().all(|frame| frame["op"] == "observe"));
        assert!(frames.iter().all(|frame| frame["kind"] == "assistant_text"));
        assert!(frames.iter().all(|frame| frame["mode"] == "final"));
        assert!(frames
            .iter()
            .all(|frame| frame["message_id"] == "assistant-public"));
        assert_eq!(frames[0]["chunk_index"], 0);
        assert_eq!(frames.last().unwrap()["is_last_chunk"], true);
        assert!(frames
            .iter()
            .all(|frame| frame.to_string().len() < DEFAULT_BOTIFIED_FRAME_BYTES));
    }

    #[tokio::test]
    async fn escaping_heavy_observe_frames_stay_within_stdin_observe_frame_cap() {
        let observer = TaskConversationObserver::new(|_| {});
        let stdin = RecordingStdin::default();
        observer.enable("task-a", TaskObserveMode::Final, Arc::new(stdin.clone()));

        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: &"\\".repeat(OBSERVE_TEXT_CHUNK_BYTES * 4),
            message_id: Some("assistant-public"),
            cycle_id: Some("cycle-1"),
        });
        wait_until(|| frame_strings(&stdin.text()).len() >= 4).await;

        let frames = frame_strings(&stdin.text());
        assert!(frames.len() >= 4);
        assert!(
            frames
                .iter()
                .all(|frame| frame.len() <= TASK_STDIN_OBSERVE_FRAME_BYTES),
            "observe frames must stay within stdin cap: {:?}",
            frames.iter().map(|frame| frame.len()).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn final_text_observer_ignores_empty_text() {
        let observer = TaskConversationObserver::new(|_| {});
        let stdin = RecordingStdin::default();
        observer.enable("task-a", TaskObserveMode::Final, Arc::new(stdin.clone()));

        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "",
            message_id: Some("assistant-empty"),
            cycle_id: None,
        });
        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: " \t\n",
            message_id: Some("assistant-whitespace"),
            cycle_id: None,
        });
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert_eq!(stdin.text(), "");
    }

    #[tokio::test]
    async fn preview_frames_map_only_visible_stream_events() {
        let observer = TaskConversationObserver::new(|_| {});
        let stdin = RecordingStdin::default();
        observer.enable("task-a", TaskObserveMode::Stream, Arc::new(stdin.clone()));
        let metadata = LlmTextPreviewMetadata {
            provider_request_id: "prq_1".to_owned(),
            turn_id: Some("turn_1".to_owned()),
            cycle_id: Some("cyc_1".to_owned()),
            provider_call_index: 0,
            input_ids: vec!["msg_1".to_owned()],
        };

        observer.publish_preview_frame(&LlmTextPreviewFrame::started(&metadata));
        observer.publish_preview_frame(&LlmTextPreviewFrame::text_delta(&metadata, "draft"));
        observer.publish_preview_frame(&LlmTextPreviewFrame::finished(
            &metadata,
            true,
            StopReason::EndTurn,
        ));
        wait_until(|| frame_values(&stdin.text()).len() >= 3).await;

        let kinds = frame_values(&stdin.text())
            .into_iter()
            .map(|frame| frame["kind"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                "assistant_text_started",
                "assistant_text",
                "assistant_text_done"
            ]
        );
    }

    #[test]
    fn preview_frame_without_stream_observer_skips_frame_construction() {
        let observer = TaskConversationObserver::new(|_| {});
        let metadata = LlmTextPreviewMetadata {
            provider_request_id: "prq_no_observer".to_owned(),
            turn_id: Some("turn_no_observer".to_owned()),
            cycle_id: Some("cyc_no_observer".to_owned()),
            provider_call_index: 0,
            input_ids: vec!["msg_no_observer".to_owned()],
        };
        let before = observer.inner.next_observation_id.load(Ordering::SeqCst);

        observer.publish_preview_frame(&LlmTextPreviewFrame::text_delta(
            &metadata,
            "draft without observer",
        ));

        assert_eq!(
            observer.inner.next_observation_id.load(Ordering::SeqCst),
            before
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_observer_writer_does_not_block_async_runtime() {
        let observer = TaskConversationObserver::new(|_| {});
        let (stdin, started) = BlockingStdin::new();
        let _release_guard = stdin.release_on_drop();

        observer.enable("task-a", TaskObserveMode::Final, Arc::new(stdin.clone()));
        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "blocked writer",
            message_id: Some("assistant-blocked"),
            cycle_id: None,
        });

        tokio::time::timeout(Duration::from_secs(1), started)
            .await
            .expect("blocking writer should start without stalling the runtime")
            .expect("blocking writer start signal should send");

        let (probe_tx, probe_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = probe_tx.send(());
        });
        tokio::time::timeout(Duration::from_millis(100), probe_rx)
            .await
            .expect("async runtime should continue while writer is blocked")
            .expect("probe task should send");

        stdin.release();
        wait_until(|| stdin.completed_writes() == 1).await;
    }

    #[tokio::test]
    async fn observer_writer_preserves_frame_order_while_first_write_is_blocked() {
        let observer = TaskConversationObserver::new(|_| {});
        let (stdin, first_started) = HoldFirstRecordingStdin::new();
        let _release_guard = stdin.release_first_on_drop();
        observer.enable("task-a", TaskObserveMode::Final, Arc::new(stdin.clone()));

        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "first",
            message_id: Some("assistant-first"),
            cycle_id: None,
        });
        tokio::time::timeout(Duration::from_secs(1), first_started)
            .await
            .expect("first writer call should start")
            .expect("first writer signal should send");

        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "second",
            message_id: Some("assistant-second"),
            cycle_id: None,
        });
        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "third",
            message_id: Some("assistant-third"),
            cycle_id: None,
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(stdin.write_count(), 0);

        stdin.release_first();
        wait_until(|| stdin.write_count() == 3).await;

        let texts = frame_values(&stdin.text())
            .into_iter()
            .map(|frame| frame["text"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(texts, vec!["first", "second", "third"]);
    }
}
