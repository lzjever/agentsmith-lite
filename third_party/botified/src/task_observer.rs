use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, Weak,
};
use std::time::SystemTime;

use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

use crate::formatting::bounded_chars;
use crate::llm_text_preview::LlmTextPreviewFrame;
use crate::tasks::{
    representable_observe_message_id, task_observe_done_frame, task_observe_error_frame,
    task_observe_text_frames, try_write_task_stdin_frame, TaskObserveConfig, TaskObserveDelivery,
    TaskObserveException, TaskObserveSource, TaskObserveTextMetadata, TaskStdinFrameKind,
    TaskStdinWriter,
};

const OBSERVE_QUEUE_CAPACITY: usize = 32;
const OBSERVE_DIAGNOSTIC_CHARS: usize = 512;

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
    observers: Mutex<HashMap<String, ObserverSlot>>,
    transitions: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    #[cfg(test)]
    discard_all_before_fence_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    next_generation: AtomicU64,
    next_observation_id: AtomicU64,
    diagnostic_sink: TaskObserverDiagnosticSink,
}

#[derive(Default)]
struct ObserverSlot {
    active: Option<ObserverState>,
    prepared_generation: Option<u64>,
    retirement: Option<RetirementFence>,
    admission_closed: bool,
    admitted_requests: usize,
}

#[derive(Clone)]
struct RetirementFence {
    generation: u64,
    done: CancellationToken,
    write_fence: Arc<Mutex<()>>,
}

struct ObserverState {
    config: TaskObserveConfig,
    sender: mpsc::Sender<String>,
    generation: u64,
    cancel: CancellationToken,
    worker_done: CancellationToken,
    write_fence: Arc<Mutex<()>>,
    frame_cap: usize,
    stream: Option<StreamBuffer>,
}

#[derive(Debug)]
struct StreamBuffer {
    provider_request_id: String,
    cycle_id: Option<String>,
    text: String,
    scalar_count: usize,
}

pub struct PreparedGeneration {
    task_id: String,
    inner: Weak<TaskConversationObserverInner>,
    generation: u64,
    state: Option<ObserverState>,
}

pub(crate) struct TaskObserverRequestAdmission {
    task_id: String,
    inner: Weak<TaskConversationObserverInner>,
}

impl Drop for TaskObserverRequestAdmission {
    fn drop(&mut self) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        inner.release_request_admission(&self.task_id);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObserverCommitError {
    AdmissionClosed,
    Write(String),
}

impl PreparedGeneration {
    pub fn generation(&self) -> u64 {
        self.state
            .as_ref()
            .expect("prepared generation must still be available")
            .generation
    }

    pub fn config(&self) -> TaskObserveConfig {
        self.state
            .as_ref()
            .expect("prepared generation must still be available")
            .config
    }

    pub fn cancel(mut self) {
        if let Some(state) = self.state.take() {
            state.cancel.cancel();
            if let Some(inner) = self.inner.upgrade() {
                inner.release_preparation(&self.task_id, self.generation);
            }
        }
    }
}

impl Drop for PreparedGeneration {
    fn drop(&mut self) {
        if let Some(state) = self.state.take() {
            state.cancel.cancel();
            if let Some(inner) = self.inner.upgrade() {
                inner.release_preparation(&self.task_id, self.generation);
            }
        }
    }
}

pub struct RetiredGeneration {
    generation: u64,
    state: Option<ObserverState>,
}

pub(crate) struct PreparedObserverRetirement {
    fences: Vec<Arc<Mutex<()>>>,
    retired_generation: Option<u64>,
    retired_state: Option<ObserverState>,
}

impl PreparedObserverRetirement {
    pub(crate) fn retired_generation(&self) -> Option<u64> {
        self.retired_generation
    }

    pub(crate) fn fence(mut self) {
        for fence in &self.fences {
            let _write = fence
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        self.retired_state.take();
    }
}

impl RetiredGeneration {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub async fn wait(mut self) {
        let Some(state) = self.state.take() else {
            return;
        };
        state.cancel.cancel();
        state.worker_done.cancelled().await;
    }

    pub fn fence_in_flight(&self) {
        if let Some(state) = self.state.as_ref() {
            let _write = state
                .write_fence
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}

impl Drop for RetiredGeneration {
    fn drop(&mut self) {
        if let Some(state) = self.state.take() {
            state.cancel.cancel();
        }
    }
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

impl TaskConversationObserver {
    pub fn new(diagnostic_sink: impl Fn(TaskObserverDiagnostic) + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(TaskConversationObserverInner {
                observers: Mutex::new(HashMap::new()),
                transitions: Mutex::new(HashMap::new()),
                #[cfg(test)]
                discard_all_before_fence_hook: Mutex::new(None),
                next_generation: AtomicU64::new(1),
                next_observation_id: AtomicU64::new(1),
                diagnostic_sink: Arc::new(diagnostic_sink),
            }),
        }
    }

    pub(crate) fn transition_for(&self, task_id: &str) -> Arc<AsyncMutex<()>> {
        let mut transitions = self
            .inner
            .transitions
            .lock()
            .expect("task observer transition mutex poisoned");
        transitions
            .entry(task_id.to_owned())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    pub(crate) fn transition_if_present(&self, task_id: &str) -> Option<Arc<AsyncMutex<()>>> {
        self.inner
            .transitions
            .lock()
            .expect("task observer transition mutex poisoned")
            .get(task_id)
            .cloned()
    }

    fn retire_transition(&self, task_id: &str) {
        self.inner
            .transitions
            .lock()
            .expect("task observer transition mutex poisoned")
            .remove(task_id);
    }

    pub(crate) fn admit_request(&self, task_id: &str) -> Option<TaskObserverRequestAdmission> {
        let mut observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        let slot = observers.entry(task_id.to_owned()).or_default();
        if slot.admission_closed {
            return None;
        }
        slot.admitted_requests = slot.admitted_requests.saturating_add(1);
        Some(TaskObserverRequestAdmission {
            task_id: task_id.to_owned(),
            inner: Arc::downgrade(&self.inner),
        })
    }

    pub(crate) fn close_admission(&self, task_id: &str) -> bool {
        if let Some(slot) = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .get_mut(task_id)
        {
            slot.admission_closed = true;
            return slot.admitted_requests != 0;
        }
        false
    }

    pub(crate) fn release_closed_admission(&self, task_id: &str) {
        let mut observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        let remove = if let Some(slot) = observers.get_mut(task_id) {
            slot.admission_closed = false;
            slot.active.is_none() && slot.prepared_generation.is_none() && slot.retirement.is_none()
        } else {
            false
        };
        if remove {
            observers.remove(task_id);
        }
    }

    pub fn write_result_if_admitted(
        &self,
        task_id: &str,
        write_result: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), ObserverCommitError> {
        let observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        if observers
            .get(task_id)
            .is_some_and(|slot| slot.admission_closed)
        {
            return Err(ObserverCommitError::AdmissionClosed);
        }
        write_result().map_err(ObserverCommitError::Write)
    }

    pub(crate) fn close_all_admission(&self) {
        let mut observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        for slot in observers.values_mut() {
            slot.admission_closed = true;
        }
        observers.retain(|_, slot| {
            slot.admitted_requests != 0
                || slot.active.is_some()
                || slot.prepared_generation.is_some()
                || slot.retirement.is_some()
        });
    }

    pub(crate) fn discard_all_and_fence(&self) {
        let fences = {
            let mut observers = self
                .inner
                .observers
                .lock()
                .expect("task observer mutex poisoned");
            let mut fences = Vec::new();
            for slot in observers.values_mut() {
                slot.admission_closed = true;
                slot.prepared_generation = None;
                if let Some(state) = slot.active.take() {
                    state.cancel.cancel();
                    fences.push(state.write_fence);
                }
                if let Some(retirement) = slot.retirement.take() {
                    fences.push(retirement.write_fence);
                }
            }
            observers.clear();
            fences
        };
        #[cfg(test)]
        let before_fence_hook = self
            .inner
            .discard_all_before_fence_hook
            .lock()
            .expect("discard-all before-fence test hook mutex poisoned")
            .take();
        #[cfg(test)]
        if let Some(hook) = before_fence_hook {
            hook();
        }
        for fence in fences {
            let _write = fence
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        self.inner
            .transitions
            .lock()
            .expect("task observer transition mutex poisoned")
            .clear();
    }

    pub(crate) fn cleanup_terminal(&self, task_id: &str) {
        self.retire_transition(task_id);
        let mut observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        let removable = observers.get(task_id).is_some_and(|slot| {
            slot.admitted_requests == 0
                && slot.active.is_none()
                && slot.prepared_generation.is_none()
                && slot.retirement.is_none()
        });
        if removable {
            observers.remove(task_id);
        }
    }

    /// Clears a matching retirement after its write fence has been acquired.
    pub(crate) fn complete_fenced_retirement(&self, task_id: &str, generation: u64) {
        let mut observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        let removable = observers.get_mut(task_id).is_some_and(|slot| {
            if slot
                .retirement
                .as_ref()
                .is_some_and(|retirement| retirement.generation == generation)
            {
                slot.retirement = None;
            }
            slot.admitted_requests == 0
                && slot.active.is_none()
                && slot.prepared_generation.is_none()
                && slot.retirement.is_none()
        });
        if removable {
            observers.remove(task_id);
        }
    }

    pub fn prepare(
        &self,
        task_id: impl Into<String>,
        config: TaskObserveConfig,
        writer: Arc<dyn TaskStdinWriter>,
    ) -> Result<PreparedGeneration, String> {
        let task_id = task_id.into();
        let generation = self.inner.next_generation.fetch_add(1, Ordering::SeqCst);
        {
            let mut observers = self
                .inner
                .observers
                .lock()
                .map_err(|_| "task observer mutex poisoned".to_owned())?;
            observers
                .try_reserve(1)
                .map_err(|_| "task observer map capacity reservation failed".to_owned())?;
            let slot = observers.entry(task_id.clone()).or_default();
            if slot.admission_closed {
                return Err("task observer admission is closed".to_owned());
            }
            if slot.prepared_generation.is_some() {
                return Err("task observer generation is already prepared".to_owned());
            }
            slot.prepared_generation = Some(generation);
        }
        let cancel = CancellationToken::new();
        let worker_done = CancellationToken::new();
        let write_fence = Arc::new(Mutex::new(()));
        let frame_cap = writer.atomic_frame_cap();
        let (sender, receiver) = mpsc::channel(OBSERVE_QUEUE_CAPACITY);
        spawn_observer_writer(
            ObserverWriterGeneration {
                inner: Arc::downgrade(&self.inner),
                task_id: task_id.clone(),
                generation,
                cancel: cancel.clone(),
                worker_done: worker_done.clone(),
                write_fence: write_fence.clone(),
            },
            receiver,
            writer,
        );
        Ok(PreparedGeneration {
            task_id,
            inner: Arc::downgrade(&self.inner),
            generation,
            state: Some(ObserverState {
                config,
                sender,
                generation,
                cancel,
                worker_done,
                write_fence,
                frame_cap,
                stream: None,
            }),
        })
    }

    /// Activates a fully prepared generation after its successful result was written.
    /// Capacity was reserved by `prepare`, so this publication step cannot fail.
    pub fn activate(&self, mut prepared: PreparedGeneration) {
        let state = prepared
            .state
            .take()
            .expect("prepared generation must only be activated once");
        let mut observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        let (_, mut slot) = observers
            .remove_entry(prepared.task_id.as_str())
            .expect("prepared generation owns a reserved observer map slot");
        debug_assert_eq!(slot.prepared_generation, Some(prepared.generation));
        debug_assert!(
            slot.active.is_none(),
            "caller must retire before activation"
        );
        debug_assert!(slot.retirement.is_none(), "caller must await retirement");
        slot.prepared_generation = None;
        slot.active = Some(state);
        observers.insert(std::mem::take(&mut prepared.task_id), slot);
    }

    pub fn write_result_and_activate(
        &self,
        mut prepared: PreparedGeneration,
        write_result: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), ObserverCommitError> {
        let mut observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        let (_, mut slot) = observers
            .remove_entry(prepared.task_id.as_str())
            .expect("prepared generation owns a reserved observer map slot");
        debug_assert_eq!(slot.prepared_generation, Some(prepared.generation));
        debug_assert!(
            slot.active.is_none(),
            "caller must retire before activation"
        );
        debug_assert!(slot.retirement.is_none(), "caller must await retirement");
        if slot.admission_closed {
            slot.prepared_generation = None;
            observers.insert(std::mem::take(&mut prepared.task_id), slot);
            prepared
                .state
                .take()
                .expect("prepared state exists")
                .cancel
                .cancel();
            return Err(ObserverCommitError::AdmissionClosed);
        }
        if let Err(error) = write_result() {
            slot.prepared_generation = None;
            let task_id = std::mem::take(&mut prepared.task_id);
            observers.insert(task_id, slot);
            prepared
                .state
                .take()
                .expect("prepared state exists")
                .cancel
                .cancel();
            return Err(ObserverCommitError::Write(error));
        }
        slot.prepared_generation = None;
        slot.active = prepared.state.take();
        observers.insert(std::mem::take(&mut prepared.task_id), slot);
        Ok(())
    }

    pub fn retire(&self, task_id: &str) -> Option<RetiredGeneration> {
        self.inner.begin_retirement(task_id, None)
    }

    pub(crate) fn prepare_retirement(&self, task_id: &str) -> PreparedObserverRetirement {
        let mut observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        let Some(slot) = observers.get_mut(task_id) else {
            return PreparedObserverRetirement {
                fences: Vec::new(),
                retired_generation: None,
                retired_state: None,
            };
        };
        let mut fences = slot
            .retirement
            .as_ref()
            .map(|retirement| vec![retirement.write_fence.clone()])
            .unwrap_or_default();
        let retired_state = slot.active.take();
        let retired_generation = retired_state.as_ref().map(|state| state.generation);
        if let Some(state) = retired_state.as_ref() {
            state.cancel.cancel();
            fences.push(state.write_fence.clone());
            slot.retirement = Some(RetirementFence {
                generation: state.generation,
                done: state.worker_done.clone(),
                write_fence: state.write_fence.clone(),
            });
        }
        PreparedObserverRetirement {
            fences,
            retired_generation,
            retired_state,
        }
    }

    pub async fn retire_and_wait(&self, task_id: &str) -> Option<u64> {
        if let Some(retired) = self.retire(task_id) {
            let generation = retired.generation();
            retired.wait().await;
            return Some(generation);
        }
        self.wait_for_retirement(task_id).await;
        None
    }

    pub fn retire_and_fence(&self, task_id: &str) -> Option<u64> {
        if let Some(retired) = self.retire(task_id) {
            let generation = retired.generation();
            retired.fence_in_flight();
            drop(retired);
            return Some(generation);
        }
        let retirement = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .get(task_id)
            .and_then(|slot| slot.retirement.clone());
        if let Some(retirement) = retirement {
            let _write = retirement
                .write_fence
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        None
    }

    pub async fn wait_for_retirement(&self, task_id: &str) {
        let retirement = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .get(task_id)
            .and_then(|slot| slot.retirement.clone());
        if let Some(retirement) = retirement {
            retirement.done.cancelled().await;
        }
    }

    pub fn is_observing(&self, task_id: &str) -> bool {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .get(task_id)
            .is_some_and(|slot| slot.active.is_some())
    }

    pub fn generation_for_task(&self, task_id: &str) -> Option<u64> {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .get(task_id)
            .and_then(|slot| slot.active.as_ref())
            .map(|state| state.generation)
    }

    pub fn config_for_task(&self, task_id: &str) -> Option<TaskObserveConfig> {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .get(task_id)
            .and_then(|slot| slot.active.as_ref())
            .map(|state| state.config)
    }

    pub fn has_stream_observers(&self) -> bool {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .values()
            .filter_map(|slot| slot.active.as_ref())
            .any(|state| state.config.delivery == TaskObserveDelivery::StreamText)
    }

    pub fn clear_stream_buffers(&self) {
        let mut observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        for state in observers
            .values_mut()
            .filter_map(|slot| slot.active.as_mut())
        {
            state.stream = None;
        }
    }

    #[cfg(test)]
    pub fn stream_buffer_for_test(&self, task_id: &str) -> Option<(String, String)> {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .get(task_id)
            .and_then(|slot| slot.active.as_ref())
            .and_then(|state| state.stream.as_ref())
            .map(|buffer| (buffer.provider_request_id.clone(), buffer.text.clone()))
    }

    #[cfg(test)]
    pub fn slot_count_for_test(&self) -> usize {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .len()
    }

    #[cfg(test)]
    pub fn transition_count_for_test(&self) -> usize {
        self.inner
            .transitions
            .lock()
            .expect("task observer transition mutex poisoned")
            .len()
    }

    #[cfg(test)]
    pub fn retirement_generation_for_test(&self, task_id: &str) -> Option<u64> {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .get(task_id)
            .and_then(|slot| slot.retirement.as_ref())
            .map(|retirement| retirement.generation)
    }

    #[cfg(test)]
    pub fn admission_closed_for_test(&self, task_id: &str) -> bool {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .get(task_id)
            .is_some_and(|slot| slot.admission_closed)
    }

    #[cfg(test)]
    pub(crate) fn set_discard_all_before_fence_hook_for_test(
        &self,
        hook: impl FnOnce() + Send + 'static,
    ) {
        *self
            .inner
            .discard_all_before_fence_hook
            .lock()
            .expect("discard-all before-fence test hook mutex poisoned") = Some(Box::new(hook));
    }

    pub fn active_task_ids(&self) -> Vec<String> {
        self.inner
            .observers
            .lock()
            .expect("task observer mutex poisoned")
            .iter()
            .filter(|(_, slot)| slot.active.is_some())
            .map(|(task_id, _)| task_id.clone())
            .collect()
    }

    pub fn publish_final_text(&self, observation: FinalTextObservation<'_>) {
        if observation.text.trim().is_empty() {
            return;
        }
        let source = match observation.kind {
            FinalTextObservationKind::UserText => TaskObserveSource::User,
            FinalTextObservationKind::AssistantText => TaskObserveSource::Assistant,
        };
        let timestamp = SystemTime::now();
        let message_id = representable_observe_message_id(observation.message_id);
        let mut failures = Vec::new();
        let mut observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        for (task_id, state) in observers
            .iter_mut()
            .filter_map(|(task_id, slot)| slot.active.as_mut().map(|state| (task_id, state)))
        {
            let delivery = state.config.delivery;
            let eligible = delivery == TaskObserveDelivery::FinalText
                || (delivery == TaskObserveDelivery::StreamText
                    && source == TaskObserveSource::User);
            if !eligible {
                continue;
            }
            let observation_id = self.inner.next_observation_id();
            let built = task_observe_text_frames(
                &observation_id,
                TaskObserveTextMetadata {
                    delivery,
                    source,
                    timestamp,
                    message_id,
                    provider_request_id: None,
                    cycle_id: observation.cycle_id,
                },
                observation.text,
                state.frame_cap,
            );
            if let Err(code) = enqueue_built_frames(state, built) {
                failures.push((task_id.clone(), state.generation, code));
            }
        }
        drop(observers);
        for (task_id, generation, code) in failures {
            self.inner
                .clone()
                .detach_generation(task_id, generation, code);
        }
    }

    pub fn publish_preview_frame(&self, frame: &LlmTextPreviewFrame) {
        let mut failures = Vec::new();
        let mut observers = self
            .inner
            .observers
            .lock()
            .expect("task observer mutex poisoned");
        for (task_id, state) in observers
            .iter_mut()
            .filter_map(|(task_id, slot)| slot.active.as_mut().map(|state| (task_id, state)))
        {
            if state.config.delivery != TaskObserveDelivery::StreamText {
                continue;
            }
            if let Err(code) = self.inner.apply_preview_frame(state, frame) {
                failures.push((task_id.clone(), state.generation, code));
            }
        }
        drop(observers);
        for (task_id, generation, code) in failures {
            self.inner
                .clone()
                .detach_generation(task_id, generation, code);
        }
    }
}

impl TaskConversationObserverInner {
    fn release_request_admission(&self, task_id: &str) {
        let mut observers = self.observers.lock().expect("task observer mutex poisoned");
        let remove = if let Some(slot) = observers.get_mut(task_id) {
            debug_assert!(slot.admitted_requests != 0);
            if slot.admitted_requests != 0 {
                slot.admitted_requests -= 1;
            }
            slot.admitted_requests == 0
                && slot.active.is_none()
                && slot.prepared_generation.is_none()
                && slot.retirement.is_none()
        } else {
            false
        };
        if remove {
            observers.remove(task_id);
        }
    }

    fn release_preparation(&self, task_id: &str, generation: u64) {
        let mut observers = self.observers.lock().expect("task observer mutex poisoned");
        let remove_slot = if let Some(slot) = observers.get_mut(task_id) {
            if slot.prepared_generation == Some(generation) {
                slot.prepared_generation = None;
            }
            slot.admitted_requests == 0
                && slot.active.is_none()
                && slot.prepared_generation.is_none()
                && slot.retirement.is_none()
        } else {
            false
        };
        if remove_slot {
            observers.remove(task_id);
        }
    }

    fn begin_retirement(
        self: &Arc<Self>,
        task_id: &str,
        generation: Option<u64>,
    ) -> Option<RetiredGeneration> {
        let mut observers = self.observers.lock().expect("task observer mutex poisoned");
        let slot = observers.get_mut(task_id)?;
        let matches = slot.active.as_ref().is_some_and(|state| {
            generation.is_none_or(|generation| state.generation == generation)
        });
        if !matches {
            return None;
        }
        let state = slot
            .active
            .take()
            .expect("matching active generation exists");
        state.cancel.cancel();
        slot.retirement = Some(RetirementFence {
            generation: state.generation,
            done: state.worker_done.clone(),
            write_fence: state.write_fence.clone(),
        });
        Some(RetiredGeneration {
            generation: state.generation,
            state: Some(state),
        })
    }

    fn complete_writer_generation(&self, task_id: &str, generation: u64) {
        let mut observers = self.observers.lock().expect("task observer mutex poisoned");
        let remove_slot = if let Some(slot) = observers.get_mut(task_id) {
            if slot
                .active
                .as_ref()
                .is_some_and(|state| state.generation == generation)
            {
                if let Some(state) = slot.active.take() {
                    state.cancel.cancel();
                }
            }
            if slot.prepared_generation == Some(generation) {
                slot.prepared_generation = None;
            }
            if slot
                .retirement
                .as_ref()
                .is_some_and(|retirement| retirement.generation == generation)
            {
                slot.retirement = None;
            }
            slot.admitted_requests == 0
                && slot.active.is_none()
                && slot.prepared_generation.is_none()
                && slot.retirement.is_none()
        } else {
            false
        };
        if remove_slot {
            observers.remove(task_id);
        }
    }

    fn next_observation_id(&self) -> String {
        format!(
            "obs_{}",
            self.next_observation_id.fetch_add(1, Ordering::SeqCst)
        )
    }

    fn apply_preview_frame(
        &self,
        state: &mut ObserverState,
        frame: &LlmTextPreviewFrame,
    ) -> Result<(), &'static str> {
        match frame {
            LlmTextPreviewFrame::Started {
                provider_request_id,
                cycle_id,
                ..
            } => {
                if provider_request_id.is_empty() {
                    state.stream = None;
                    return Ok(());
                }
                state.stream = Some(StreamBuffer {
                    provider_request_id: provider_request_id.clone(),
                    cycle_id: cycle_id.clone(),
                    text: String::new(),
                    scalar_count: 0,
                });
                Ok(())
            }
            LlmTextPreviewFrame::TextDelta {
                provider_request_id,
                cycle_id,
                delta,
                ..
            } => {
                if provider_request_id.is_empty() {
                    state.stream = None;
                    return Ok(());
                }
                if state
                    .stream
                    .as_ref()
                    .is_none_or(|buffer| buffer.provider_request_id != *provider_request_id)
                {
                    state.stream = Some(StreamBuffer {
                        provider_request_id: provider_request_id.clone(),
                        cycle_id: cycle_id.clone(),
                        text: String::new(),
                        scalar_count: 0,
                    });
                }
                let buffer = state.stream.as_mut().expect("stream buffer was installed");
                buffer.text.push_str(delta);
                buffer.scalar_count = buffer.scalar_count.saturating_add(delta.chars().count());
                if buffer.scalar_count
                    >= usize::from(state.config.min_batch_chars.expect("stream batch is set"))
                {
                    flush_stream_buffer(self, state)?;
                }
                Ok(())
            }
            LlmTextPreviewFrame::Finished {
                provider_request_id,
                cycle_id,
                ..
            } => self.finish_stream(state, provider_request_id, cycle_id.as_deref(), None),
            LlmTextPreviewFrame::Aborted {
                provider_request_id,
                cycle_id,
                ..
            } => self.finish_stream(
                state,
                provider_request_id,
                cycle_id.as_deref(),
                Some(TaskObserveException::new(
                    "aborted",
                    "provider text generation aborted",
                    true,
                )),
            ),
            LlmTextPreviewFrame::Error {
                provider_request_id,
                cycle_id,
                code,
                retryable,
                ..
            } => self.finish_stream(
                state,
                provider_request_id,
                cycle_id.as_deref(),
                Some(TaskObserveException::new(
                    code,
                    bounded_chars(code, 256),
                    *retryable,
                )),
            ),
            LlmTextPreviewFrame::Status { .. } => Ok(()),
        }
    }

    fn finish_stream(
        &self,
        state: &mut ObserverState,
        provider_request_id: &str,
        cycle_id: Option<&str>,
        exception: Option<TaskObserveException>,
    ) -> Result<(), &'static str> {
        if provider_request_id.is_empty()
            || state
                .stream
                .as_ref()
                .is_none_or(|buffer| buffer.provider_request_id != provider_request_id)
        {
            return Ok(());
        }
        flush_stream_buffer(self, state)?;
        state.stream = None;
        let observation_id = self.next_observation_id();
        let timestamp = SystemTime::now();
        let frame = match exception {
            Some(exception) => task_observe_error_frame(
                &observation_id,
                timestamp,
                provider_request_id,
                cycle_id,
                exception,
                state.frame_cap,
            ),
            None => task_observe_done_frame(
                &observation_id,
                timestamp,
                provider_request_id,
                cycle_id,
                state.frame_cap,
            ),
        };
        enqueue_frame(state, frame.map_err(|_| "observer_frame_build_failed")?)
    }

    fn detach_generation(self: Arc<Self>, task_id: String, generation: u64, code: &'static str) {
        let Some(retired) = self.begin_retirement(&task_id, Some(generation)) else {
            return;
        };
        tokio::spawn(async move {
            retired.wait().await;
            (self.diagnostic_sink)(TaskObserverDiagnostic {
                task_id,
                code,
                message: observer_failure_message(code).to_owned(),
            });
        });
    }
}

fn flush_stream_buffer(
    inner: &TaskConversationObserverInner,
    state: &mut ObserverState,
) -> Result<(), &'static str> {
    let Some(buffer) = state.stream.as_mut() else {
        return Ok(());
    };
    if buffer.text.is_empty() {
        buffer.scalar_count = 0;
        return Ok(());
    }
    let text = std::mem::take(&mut buffer.text);
    buffer.scalar_count = 0;
    let observation_id = inner.next_observation_id();
    let timestamp = SystemTime::now();
    let frames = task_observe_text_frames(
        &observation_id,
        TaskObserveTextMetadata {
            delivery: TaskObserveDelivery::StreamText,
            source: TaskObserveSource::Assistant,
            timestamp,
            message_id: None,
            provider_request_id: Some(&buffer.provider_request_id),
            cycle_id: buffer.cycle_id.as_deref(),
        },
        &text,
        state.frame_cap,
    );
    enqueue_built_frames(state, frames)
}

fn enqueue_built_frames(
    state: &mut ObserverState,
    frames: Result<Vec<String>, String>,
) -> Result<(), &'static str> {
    let frames = frames.map_err(|_| "observer_frame_build_failed")?;
    for frame in frames {
        enqueue_frame(state, frame)?;
    }
    Ok(())
}

fn enqueue_frame(state: &mut ObserverState, frame: String) -> Result<(), &'static str> {
    match state.sender.try_send(frame) {
        Ok(()) => Ok(()),
        Err(mpsc::error::TrySendError::Full(_)) => Err("observer_queue_full"),
        Err(mpsc::error::TrySendError::Closed(_)) => Err("observer_queue_closed"),
    }
}

struct ObserverWriterGeneration {
    inner: Weak<TaskConversationObserverInner>,
    task_id: String,
    generation: u64,
    cancel: CancellationToken,
    worker_done: CancellationToken,
    write_fence: Arc<Mutex<()>>,
}

struct ObserverWriterDoneGuard {
    inner: Weak<TaskConversationObserverInner>,
    task_id: String,
    generation: u64,
    worker_done: CancellationToken,
}

impl Drop for ObserverWriterDoneGuard {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            inner.complete_writer_generation(&self.task_id, self.generation);
        }
        self.worker_done.cancel();
    }
}

fn spawn_observer_writer(
    worker: ObserverWriterGeneration,
    mut receiver: mpsc::Receiver<String>,
    writer: Arc<dyn TaskStdinWriter>,
) {
    let ObserverWriterGeneration {
        inner,
        task_id,
        generation,
        cancel,
        worker_done,
        write_fence,
    } = worker;
    let done_guard = ObserverWriterDoneGuard {
        inner: inner.clone(),
        task_id: task_id.clone(),
        generation,
        worker_done,
    };
    tokio::spawn(async move {
        let _done_guard = done_guard;
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                frame = receiver.recv() => {
                    let Some(frame) = frame else { break; };
                    let result = {
                        let _write = write_fence
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if cancel.is_cancelled() {
                            break;
                        }
                        try_write_task_stdin_frame(
                            writer.as_ref(),
                            TaskStdinFrameKind::Observe,
                            frame.as_bytes(),
                        )
                    };
                    if let Err(error) = result {
                        if let Some(inner) = inner.upgrade() {
                            inner.clone().detach_generation(
                                task_id.clone(),
                                generation,
                                "observer_write_failed",
                            );
                            (inner.diagnostic_sink)(TaskObserverDiagnostic {
                                task_id: task_id.clone(),
                                code: "observer_write_detail",
                                message: bounded_chars(&error, OBSERVE_DIAGNOSTIC_CHARS),
                            });
                        }
                        break;
                    }
                }
            }
        }
    });
}

fn observer_failure_message(code: &str) -> &'static str {
    match code {
        "observer_queue_full" => "task observe queue is full",
        "observer_queue_closed" => "task observe queue is closed",
        "observer_frame_build_failed" => "task observe frame could not be built",
        "observer_write_failed" => "task observe stdin write failed",
        _ => "task observer detached",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_text_preview::LlmTextPreviewMetadata;
    use crate::tasks::{TaskStdinWriteSuccess, TASK_STDIN_FRAME_SAFETY_CEILING};
    use crate::types::StopReason;
    use serde_json::Value;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize},
        mpsc as std_mpsc, Mutex as StdMutex,
    };
    use std::time::Duration;

    #[derive(Clone)]
    struct RecordingStdin {
        frames: Arc<StdMutex<Vec<String>>>,
        cap: usize,
    }

    impl Default for RecordingStdin {
        fn default() -> Self {
            Self {
                frames: Arc::new(StdMutex::new(Vec::new())),
                cap: TASK_STDIN_FRAME_SAFETY_CEILING,
            }
        }
    }

    impl RecordingStdin {
        fn values(&self) -> Vec<Value> {
            self.frames
                .lock()
                .unwrap()
                .iter()
                .map(|frame| {
                    serde_json::from_str(
                        frame
                            .strip_prefix("<botified>")
                            .unwrap()
                            .strip_suffix("</botified>\n")
                            .unwrap(),
                    )
                    .unwrap()
                })
                .collect()
        }
    }

    impl TaskStdinWriter for RecordingStdin {
        fn atomic_frame_cap(&self) -> usize {
            self.cap
        }

        fn try_write_frame(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
            self.frames
                .lock()
                .unwrap()
                .push(String::from_utf8(bytes.to_vec()).unwrap());
            Ok(TaskStdinWriteSuccess::delivered())
        }
    }

    #[derive(Clone, Default)]
    struct FailingStdin(Arc<AtomicUsize>);

    impl TaskStdinWriter for FailingStdin {
        fn atomic_frame_cap(&self) -> usize {
            TASK_STDIN_FRAME_SAFETY_CEILING
        }

        fn try_write_frame(&self, _bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err("would block".to_owned())
        }
    }

    struct BlockingPanickingStdin {
        entered: std_mpsc::Sender<()>,
        release: StdMutex<std_mpsc::Receiver<()>>,
    }

    impl TaskStdinWriter for BlockingPanickingStdin {
        fn atomic_frame_cap(&self) -> usize {
            TASK_STDIN_FRAME_SAFETY_CEILING
        }

        fn try_write_frame(&self, _bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
            self.entered.send(()).expect("panic test remains active");
            self.release
                .lock()
                .expect("panic release mutex poisoned")
                .recv()
                .expect("panic test releases writer");
            panic!("injected observer writer panic");
        }
    }

    async fn wait_until(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if condition() {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    fn metadata(id: &str) -> LlmTextPreviewMetadata {
        LlmTextPreviewMetadata {
            provider_request_id: id.to_owned(),
            turn_id: Some("turn_1".to_owned()),
            cycle_id: Some("cycle_1".to_owned()),
            provider_call_index: 0,
            input_ids: Vec::new(),
        }
    }

    #[tokio::test]
    async fn prepared_generation_is_invisible_until_activation() {
        let observer = TaskConversationObserver::new(|_| {});
        let stdin = RecordingStdin::default();
        let prepared = observer
            .prepare(
                "task",
                TaskObserveConfig::final_text(),
                Arc::new(stdin.clone()),
            )
            .unwrap();
        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::UserText,
            text: "before fence",
            message_id: Some("msg_1"),
            cycle_id: None,
        });
        assert!(stdin.values().is_empty());

        observer.activate(prepared);
        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::UserText,
            text: "after fence",
            message_id: Some("msg_2"),
            cycle_id: None,
        });
        wait_until(|| stdin.values().len() == 1).await;
        assert_eq!(stdin.values()[0]["text"], "after fence");
    }

    #[tokio::test]
    async fn failed_or_closed_commit_never_activates_and_releases_reservation() {
        let observer = TaskConversationObserver::new(|_| {});
        let stdin = RecordingStdin::default();
        let prepared = observer
            .prepare(
                "write-fails",
                TaskObserveConfig::final_text(),
                Arc::new(stdin.clone()),
            )
            .unwrap();
        assert!(matches!(
            observer.write_result_and_activate(prepared, || Err("result failed".to_owned())),
            Err(ObserverCommitError::Write(error)) if error == "result failed"
        ));
        assert!(!observer.is_observing("write-fails"));
        observer.activate(
            observer
                .prepare(
                    "write-fails",
                    TaskObserveConfig::final_text(),
                    Arc::new(stdin.clone()),
                )
                .unwrap(),
        );
        assert!(observer.is_observing("write-fails"));

        let prepared = observer
            .prepare("closed", TaskObserveConfig::final_text(), Arc::new(stdin))
            .unwrap();
        observer.close_admission("closed");
        let writes = AtomicUsize::new(0);
        assert_eq!(
            observer.write_result_and_activate(prepared, || {
                writes.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
            Err(ObserverCommitError::AdmissionClosed)
        );
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        assert!(!observer.is_observing("closed"));
        assert_eq!(observer.slot_count_for_test(), 2);

        observer.close_admission("never-observed");
        assert_eq!(
            observer.slot_count_for_test(),
            2,
            "closing admission must not create a permanent tombstone"
        );
        observer.release_closed_admission("closed");
        assert_eq!(observer.slot_count_for_test(), 1);
    }

    #[tokio::test]
    async fn fenced_retirement_cleanup_is_generation_guarded() {
        let observer = TaskConversationObserver::new(|_| {});
        observer.inner.observers.lock().unwrap().insert(
            "task".to_owned(),
            ObserverSlot {
                retirement: Some(RetirementFence {
                    generation: 7,
                    done: CancellationToken::new(),
                    write_fence: Arc::new(Mutex::new(())),
                }),
                ..ObserverSlot::default()
            },
        );

        observer.complete_fenced_retirement("task", 6);
        assert_eq!(observer.retirement_generation_for_test("task"), Some(7));

        observer.complete_fenced_retirement("task", 7);
        assert_eq!(observer.slot_count_for_test(), 0);

        let replacement = observer
            .prepare(
                "task",
                TaskObserveConfig::final_text(),
                Arc::new(RecordingStdin::default()),
            )
            .unwrap();
        let replacement_generation = replacement.generation();
        observer.activate(replacement);
        observer.inner.complete_writer_generation("task", 7);
        assert_eq!(
            observer.generation_for_task("task"),
            Some(replacement_generation)
        );
        observer.retire_and_wait("task").await;
    }

    #[tokio::test]
    async fn final_and_stream_user_text_share_dynamic_cap_chunking() {
        let observer = TaskConversationObserver::new(|_| {});
        let stdin = RecordingStdin {
            cap: 420,
            ..RecordingStdin::default()
        };
        observer.activate(
            observer
                .prepare(
                    "task",
                    TaskObserveConfig::final_text(),
                    Arc::new(stdin.clone()),
                )
                .unwrap(),
        );
        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::UserText,
            text: &format!("{}{}", "\\\"".repeat(100), "界".repeat(100)),
            message_id: Some("msg_1"),
            cycle_id: None,
        });
        wait_until(|| stdin.values().len() > 1).await;
        assert!(stdin.frames.lock().unwrap().iter().all(|f| f.len() <= 420));
        let values = stdin.values();
        assert_eq!(values[0]["delivery"], "final_text");
        assert_eq!(values[0]["source"], "user");
        assert_eq!(values.last().unwrap()["is_last_chunk"], true);
        let timestamp = values[0]["timestamp"].clone();
        assert!(timestamp.as_str().is_some_and(|value| value.ends_with('Z')));
        assert!(values.iter().all(|value| value["timestamp"] == timestamp));
    }

    #[tokio::test]
    async fn opaque_public_message_ids_are_forwarded_only_when_observe_representable() {
        let observer = TaskConversationObserver::new(|_| {});
        let stdin = RecordingStdin::default();
        observer.activate(
            observer
                .prepare(
                    "task",
                    TaskObserveConfig::final_text(),
                    Arc::new(stdin.clone()),
                )
                .unwrap(),
        );

        let cases = [
            ("valid_token-1", true),
            ("unicode-消息", false),
            ("spaced id", false),
            ("slash/id", false),
        ];
        for (index, (message_id, representable)) in cases.into_iter().enumerate() {
            observer.publish_final_text(FinalTextObservation {
                kind: FinalTextObservationKind::UserText,
                text: &format!("visible-{index}"),
                message_id: Some(message_id),
                cycle_id: None,
            });
            wait_until(|| stdin.values().len() == index + 1).await;
            let values = stdin.values();
            assert_eq!(values[index]["text"], format!("visible-{index}"));
            assert_eq!(
                values[index].get("message_id").and_then(Value::as_str),
                representable.then_some(message_id)
            );
            assert!(observer.is_observing("task"));
        }

        let overlong = "x".repeat(2049);
        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::UserText,
            text: "visible-overlong",
            message_id: Some(&overlong),
            cycle_id: None,
        });
        wait_until(|| stdin.values().len() == 5).await;
        assert_eq!(stdin.values()[4]["text"], "visible-overlong");
        assert!(stdin.values()[4].get("message_id").is_none());
        assert!(observer.is_observing("task"));
    }

    #[tokio::test]
    async fn stream_batches_scalars_and_terminal_only_closes_matching_draft() {
        let observer = TaskConversationObserver::new(|_| {});
        let stdin = RecordingStdin::default();
        observer.activate(
            observer
                .prepare(
                    "task",
                    TaskObserveConfig::stream_text(3).unwrap(),
                    Arc::new(stdin.clone()),
                )
                .unwrap(),
        );
        let first = metadata("prq_1");
        observer.publish_preview_frame(&LlmTextPreviewFrame::text_delta(&first, "你"));
        observer.publish_preview_frame(&LlmTextPreviewFrame::text_delta(&first, "好a"));
        let other = metadata("prq_2");
        observer.publish_preview_frame(&LlmTextPreviewFrame::finished(
            &other,
            true,
            StopReason::EndTurn,
        ));
        observer.publish_preview_frame(&LlmTextPreviewFrame::finished(
            &first,
            true,
            StopReason::EndTurn,
        ));
        wait_until(|| stdin.values().len() == 2).await;
        let values = stdin.values();
        assert_eq!(values[0]["text"], "你好a");
        assert_eq!(values[1]["event"], "done");
        assert!(observer.is_observing("task"));
    }

    #[tokio::test]
    async fn new_stream_id_discards_old_buffer_and_late_delta_starts_new_buffer() {
        let observer = TaskConversationObserver::new(|_| {});
        let stdin = RecordingStdin::default();
        observer.activate(
            observer
                .prepare(
                    "task",
                    TaskObserveConfig::stream_text(10).unwrap(),
                    Arc::new(stdin.clone()),
                )
                .unwrap(),
        );
        observer.publish_preview_frame(&LlmTextPreviewFrame::text_delta(&metadata("old"), "drop"));
        observer.publish_preview_frame(&LlmTextPreviewFrame::text_delta(&metadata("new"), "keep"));
        observer.publish_preview_frame(&LlmTextPreviewFrame::finished(
            &metadata("new"),
            true,
            StopReason::EndTurn,
        ));
        wait_until(|| stdin.values().len() == 2).await;
        assert_eq!(stdin.values()[0]["text"], "keep");
    }

    #[tokio::test]
    async fn write_failure_retires_only_matching_generation_once() {
        let diagnostics = Arc::new(StdMutex::new(Vec::new()));
        let captured = diagnostics.clone();
        let observer = TaskConversationObserver::new(move |diagnostic| {
            captured.lock().unwrap().push(diagnostic.code);
        });
        let failing = FailingStdin::default();
        let healthy = RecordingStdin::default();
        observer.activate(
            observer
                .prepare(
                    "bad",
                    TaskObserveConfig::final_text(),
                    Arc::new(failing.clone()),
                )
                .unwrap(),
        );
        observer.activate(
            observer
                .prepare(
                    "good",
                    TaskObserveConfig::final_text(),
                    Arc::new(healthy.clone()),
                )
                .unwrap(),
        );
        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "visible",
            message_id: Some("msg_1"),
            cycle_id: None,
        });
        wait_until(|| !observer.is_observing("bad") && healthy.values().len() == 1).await;
        assert!(observer.is_observing("good"));
        assert_eq!(
            diagnostics
                .lock()
                .unwrap()
                .iter()
                .filter(|code| **code == "observer_write_failed")
                .count(),
            1
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn writer_panic_completes_matching_retirement_and_terminal_cleanup() {
        let observer = TaskConversationObserver::new(|_| {});
        observer.transition_for("panic-writer");
        let (entered_tx, entered_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        observer.activate(
            observer
                .prepare(
                    "panic-writer",
                    TaskObserveConfig::final_text(),
                    Arc::new(BlockingPanickingStdin {
                        entered: entered_tx,
                        release: StdMutex::new(release_rx),
                    }),
                )
                .unwrap(),
        );
        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "panic in writer",
            message_id: None,
            cycle_id: None,
        });
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("writer reaches injected panic boundary");

        let retired = observer.retire("panic-writer").expect("active generation");
        assert_eq!(
            observer.retirement_generation_for_test("panic-writer"),
            Some(retired.generation())
        );
        release_tx.send(()).expect("writer remains blocked");
        tokio::time::timeout(Duration::from_secs(1), retired.wait())
            .await
            .expect("writer panic must signal retirement completion");

        observer.cleanup_terminal("panic-writer");
        assert_eq!(observer.slot_count_for_test(), 0);
        assert_eq!(observer.transition_count_for_test(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn diagnostic_sink_panic_completes_writer_retirement_without_residue() {
        let (entered_tx, entered_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let release_rx = Arc::new(StdMutex::new(release_rx));
        let panic_once = Arc::new(AtomicBool::new(true));
        let observer = TaskConversationObserver::new({
            let release_rx = release_rx.clone();
            let panic_once = panic_once.clone();
            move |_| {
                if panic_once.swap(false, Ordering::SeqCst) {
                    entered_tx.send(()).expect("sink panic test remains active");
                    release_rx
                        .lock()
                        .expect("sink release mutex poisoned")
                        .recv()
                        .expect("sink panic test releases callback");
                    panic!("injected observer diagnostic sink panic");
                }
            }
        });
        observer.transition_for("panic-sink");
        observer.activate(
            observer
                .prepare(
                    "panic-sink",
                    TaskObserveConfig::final_text(),
                    Arc::new(FailingStdin::default()),
                )
                .unwrap(),
        );
        observer.publish_final_text(FinalTextObservation {
            kind: FinalTextObservationKind::AssistantText,
            text: "fail before sink panic",
            message_id: None,
            cycle_id: None,
        });
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("sink runs after matching retirement is installed");
        assert!(observer
            .retirement_generation_for_test("panic-sink")
            .is_some());

        release_tx.send(()).expect("sink remains blocked");
        tokio::time::timeout(
            Duration::from_secs(1),
            observer.retire_and_wait("panic-sink"),
        )
        .await
        .expect("sink panic must not strand retirement");

        observer.cleanup_terminal("panic-sink");
        assert_eq!(observer.slot_count_for_test(), 0);
        assert_eq!(observer.transition_count_for_test(), 0);
    }

    #[tokio::test]
    async fn retirement_drops_buffer_without_flush() {
        let observer = TaskConversationObserver::new(|_| {});
        let stdin = RecordingStdin::default();
        observer.activate(
            observer
                .prepare(
                    "task",
                    TaskObserveConfig::stream_text(20).unwrap(),
                    Arc::new(stdin.clone()),
                )
                .unwrap(),
        );
        observer.publish_preview_frame(&LlmTextPreviewFrame::text_delta(
            &metadata("prq_1"),
            "pending",
        ));
        observer.retire_and_wait("task").await;
        assert!(stdin.values().is_empty());
        assert!(!observer.is_observing("task"));
    }
}
