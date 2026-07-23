#[cfg(test)]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Weak};

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::*;

// One small bounded lane per running task keeps stdout non-blocking while preserving scan order.
pub(in crate::service) const TASK_FRAME_LANE_CAPACITY: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum TaskFrameLanePhase {
    Open = 0,
    FinishDrain = 1,
    Discard = 2,
}

pub(in crate::service) struct TaskFrameLaneControl {
    phase: AtomicU8,
    phase_changed: Notify,
    cancel: CancellationToken,
    done: CancellationToken,
    #[cfg(test)]
    dequeued_count: AtomicU64,
    #[cfg(test)]
    dequeued_notify: Notify,
}

impl TaskFrameLaneControl {
    fn new() -> Self {
        Self {
            phase: AtomicU8::new(TaskFrameLanePhase::Open as u8),
            phase_changed: Notify::new(),
            cancel: CancellationToken::new(),
            done: CancellationToken::new(),
            #[cfg(test)]
            dequeued_count: AtomicU64::new(0),
            #[cfg(test)]
            dequeued_notify: Notify::new(),
        }
    }

    fn phase(&self) -> TaskFrameLanePhase {
        match self.phase.load(Ordering::SeqCst) {
            0 => TaskFrameLanePhase::Open,
            1 => TaskFrameLanePhase::FinishDrain,
            _ => TaskFrameLanePhase::Discard,
        }
    }

    fn finish_drain(&self) {
        if self
            .phase
            .compare_exchange(
                TaskFrameLanePhase::Open as u8,
                TaskFrameLanePhase::FinishDrain as u8,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            self.phase_changed.notify_one();
        }
    }

    fn discard(&self) {
        self.phase
            .store(TaskFrameLanePhase::Discard as u8, Ordering::SeqCst);
        self.cancel.cancel();
        self.phase_changed.notify_one();
    }

    pub(in crate::service) async fn wait_done(&self) {
        self.done.cancelled().await;
    }

    fn signal_done(&self) {
        self.done.cancel();
    }

    #[cfg(test)]
    fn note_dequeued(&self) {
        self.dequeued_count.fetch_add(1, Ordering::SeqCst);
        self.dequeued_notify.notify_waiters();
    }

    #[cfg(test)]
    pub(in crate::service) async fn wait_dequeued(&self, count: u64) {
        loop {
            let notified = self.dequeued_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.dequeued_count.load(Ordering::SeqCst) >= count {
                return;
            }
            notified.await;
        }
    }
}

pub(in crate::service) struct TaskFrameLane {
    sender: mpsc::Sender<TaskFrameLaneItem>,
    control: Arc<TaskFrameLaneControl>,
}

impl TaskFrameLane {
    #[cfg(test)]
    pub(in crate::service) fn capacity(&self) -> usize {
        self.sender.capacity()
    }

    #[cfg(test)]
    pub(in crate::service) fn control_for_test(&self) -> Arc<TaskFrameLaneControl> {
        self.control.clone()
    }
}

struct TaskFrameLaneActorGuard {
    inner: Weak<ServiceInner>,
    task_id: String,
    control: Arc<TaskFrameLaneControl>,
}

impl Drop for TaskFrameLaneActorGuard {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            let mut lanes = inner
                .task_frame_lanes
                .lock()
                .expect("task frame lanes mutex poisoned");
            if lanes
                .get(&self.task_id)
                .is_some_and(|lane| Arc::ptr_eq(&lane.control, &self.control))
            {
                lanes.remove(&self.task_id);
            }
            inner.notify.notify_waiters();
        }
        self.control.signal_done();
    }
}

impl TaskFrameAdmissionGate {
    fn ingress_is_open(&self, task_id: &str) -> bool {
        !self.finishing_tasks.contains(task_id)
    }

    fn take_lane_spawn_failure_for_test(&mut self) -> bool {
        #[cfg(test)]
        {
            std::mem::take(&mut self.fail_next_lane_spawn)
        }
        #[cfg(not(test))]
        {
            false
        }
    }
}

struct TaskFrameLaneItem {
    event: BotifiedFrameEvent,
    _observer_admission: Option<TaskObserverRequestAdmission>,
}

impl ServiceInner {
    #[cfg(test)]
    pub(in crate::service) fn fail_next_task_frame_lane_spawn_for_test(&self) {
        self.task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned")
            .fail_next_lane_spawn = true;
    }

    pub(in crate::service) fn close_task_frame_admission(
        &self,
        admission: &mut TaskFrameAdmissionGate,
        task_id: &str,
    ) -> (bool, Option<Arc<TaskFrameLaneControl>>) {
        admission.finishing_tasks.insert(task_id.to_owned());
        admission.discarding_tasks.insert(task_id.to_owned());
        let had_observer_admission = self.task_observer.close_admission(task_id);
        let lane = self
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned")
            .get(task_id)
            .map(|lane| lane.control.clone());
        if let Some(control) = lane.as_ref() {
            control.discard();
        }
        (had_observer_admission, lane)
    }

    pub(in crate::service) fn finish_task_frame_admission(
        &self,
        admission: &mut TaskFrameAdmissionGate,
        task_id: &str,
    ) -> Option<Arc<TaskFrameLaneControl>> {
        admission.finishing_tasks.insert(task_id.to_owned());
        let lane = self
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned")
            .get(task_id)
            .map(|lane| lane.control.clone());
        if let Some(control) = lane.as_ref() {
            control.finish_drain();
        }
        lane
    }

    pub(in crate::service) fn discard_all_task_frame_lanes(
        &self,
        admission: &mut TaskFrameAdmissionGate,
    ) -> Vec<Arc<TaskFrameLaneControl>> {
        let lanes = self
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned");
        let mut controls = Vec::with_capacity(lanes.len());
        for (task_id, lane) in lanes.iter() {
            admission.finishing_tasks.insert(task_id.clone());
            admission.discarding_tasks.insert(task_id.clone());
            lane.control.discard();
            controls.push(lane.control.clone());
        }
        controls
    }

    pub(super) fn admit_and_enqueue_task_frame(
        self: &Arc<Self>,
        task_id: &str,
        event: BotifiedFrameEvent,
    ) {
        let mut admission = self
            .task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned");
        if self.is_failed_or_shutting_down() || !admission.ingress_is_open(task_id) {
            return;
        }
        if !self
            .background_tasks
            .get(task_id)
            .is_some_and(|task| task.state == TaskState::Running)
        {
            return;
        }
        let is_observe = matches!(
            &event,
            BotifiedFrameEvent::ObserveRequest(_) | BotifiedFrameEvent::ObserveRequestRejected(_)
        );
        let observer_admission = if is_observe {
            let Some(observer_admission) = self.task_observer.admit_request(task_id) else {
                return;
            };
            admission.pause_for_test(TaskFrameAdmissionKind::Observe);
            Some(observer_admission)
        } else {
            None
        };
        let item = TaskFrameLaneItem {
            event,
            _observer_admission: observer_admission,
        };

        let mut lanes = self
            .task_frame_lanes
            .lock()
            .expect("task frame lanes mutex poisoned");
        if !lanes.contains_key(task_id) {
            drop(lanes);
            let fail_spawn = admission.take_lane_spawn_failure_for_test();
            let Some(lane) = self.spawn_task_frame_lane(task_id, fail_spawn) else {
                return;
            };
            lanes = self
                .task_frame_lanes
                .lock()
                .expect("task frame lanes mutex poisoned");
            lanes.insert(task_id.to_owned(), lane);
        }
        let (mut sender, control) = {
            let lane = lanes
                .get(task_id)
                .expect("task frame lane was just inserted");
            (lane.sender.clone(), lane.control.clone())
        };
        match sender.try_send(item) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(item)) => {
                drop(lanes);
                self.reject_full_task_frame_lane(task_id, &item.event);
            }
            Err(mpsc::error::TrySendError::Closed(item)) => {
                if lanes
                    .get(task_id)
                    .is_some_and(|current| Arc::ptr_eq(&current.control, &control))
                {
                    lanes.remove(task_id);
                }
                if self.is_failed_or_shutting_down() || !admission.ingress_is_open(task_id) {
                    return;
                }
                drop(lanes);
                let fail_spawn = admission.take_lane_spawn_failure_for_test();
                let Some(replacement) = self.spawn_task_frame_lane(task_id, fail_spawn) else {
                    self.reject_full_task_frame_lane(task_id, &item.event);
                    return;
                };
                sender = replacement.sender.clone();
                lanes = self
                    .task_frame_lanes
                    .lock()
                    .expect("task frame lanes mutex poisoned");
                lanes.insert(task_id.to_owned(), replacement);
                match sender.try_send(item) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(item))
                    | Err(mpsc::error::TrySendError::Closed(item)) => {
                        drop(lanes);
                        self.reject_full_task_frame_lane(task_id, &item.event);
                    }
                }
            }
        }
    }

    fn spawn_task_frame_lane(
        self: &Arc<Self>,
        task_id: &str,
        fail_spawn_for_test: bool,
    ) -> Option<TaskFrameLane> {
        let worker_guard = self.register_service_worker(ServiceWorkerKind::FrameHandler)?;
        let (sender, mut receiver) = mpsc::channel::<TaskFrameLaneItem>(TASK_FRAME_LANE_CAPACITY);
        let control = Arc::new(TaskFrameLaneControl::new());
        let actor_control = control.clone();
        let weak = Arc::downgrade(self);
        let lane_task_id = task_id.to_owned();
        let actor_guard = TaskFrameLaneActorGuard {
            inner: weak.clone(),
            task_id: lane_task_id.clone(),
            control: actor_control.clone(),
        };
        let actor = async move {
            let _worker_guard = worker_guard;
            let _actor_guard = actor_guard;
            loop {
                let item = match actor_control.phase() {
                    TaskFrameLanePhase::Discard => break,
                    TaskFrameLanePhase::FinishDrain => match receiver.try_recv() {
                        Ok(item) => item,
                        Err(mpsc::error::TryRecvError::Empty)
                        | Err(mpsc::error::TryRecvError::Disconnected) => break,
                    },
                    TaskFrameLanePhase::Open => {
                        tokio::select! {
                            biased;
                            _ = actor_control.cancel.cancelled() => break,
                            _ = actor_control.phase_changed.notified() => continue,
                            item = receiver.recv() => match item {
                                Some(item) => item,
                                None => break,
                            },
                        }
                    }
                };
                #[cfg(test)]
                actor_control.note_dequeued();
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                tokio::select! {
                    biased;
                    _ = actor_control.cancel.cancelled() => break,
                    _ = inner.clone().handle_task_frame_events(
                        lane_task_id.clone(),
                        vec![item.event],
                    ) => {}
                }
            }
        };
        #[cfg(test)]
        if fail_spawn_for_test {
            drop(actor);
            return None;
        }
        #[cfg(not(test))]
        let _ = fail_spawn_for_test;
        tokio::spawn(actor);
        Some(TaskFrameLane { sender, control })
    }

    fn reject_full_task_frame_lane(&self, task_id: &str, event: &BotifiedFrameEvent) {
        const CODE: &str = "task_frame_lane_full";
        const MESSAGE: &str = "task stdout event lane is full";
        let response = self
            .background_tasks
            .stdin_writer(task_id)
            .and_then(|writer| {
                let built = match event {
                    BotifiedFrameEvent::Ask(frame) => Some((
                        TaskStdinFrameKind::Reply,
                        Ok(task_exception_frame(&frame.id, CODE, MESSAGE)),
                    )),
                    BotifiedFrameEvent::RegistryGet(frame) => {
                        let cap =
                            self.registry_stdio_writer_cap(task_id, &frame.id, writer.as_ref())?;
                        Some((
                            TaskStdinFrameKind::Registry,
                            Ok(registry_error_stdio_frame(&frame.id, CODE, MESSAGE, cap)),
                        ))
                    }
                    BotifiedFrameEvent::ObserveRequest(frame) => Some((
                        TaskStdinFrameKind::ObserveResult,
                        task_observe_result_failure_frame(
                            &frame.id,
                            CODE,
                            MESSAGE,
                            true,
                            writer.atomic_frame_cap(),
                        ),
                    )),
                    BotifiedFrameEvent::ObserveRequestRejected(frame) => Some((
                        TaskStdinFrameKind::ObserveResult,
                        task_observe_result_failure_frame(
                            &frame.id,
                            CODE,
                            MESSAGE,
                            true,
                            writer.atomic_frame_cap(),
                        ),
                    )),
                    _ => None,
                }?;
                Some((writer, built.0, built.1))
            });
        if let Some((writer, kind, Ok(frame))) = response {
            if let Err(error) = try_write_task_stdin_frame(writer.as_ref(), kind, frame.as_bytes())
            {
                self.record_internal_stdio_diagnostic(
                    "task_stdio",
                    task_id,
                    TaskFrameDiagnostic {
                        op: Some(kind.as_str().to_owned()),
                        code: "overload_result_write_failed",
                        message: bounded_chars(&error, 512),
                        request_id: task_frame_request_id(event),
                    },
                );
            }
        }
        self.record_task_frame_lane_overflow(task_id, event);
    }

    fn record_task_frame_lane_overflow(&self, task_id: &str, event: &BotifiedFrameEvent) {
        let (domain, op, request_id) = match event {
            BotifiedFrameEvent::Ask(frame) => ("task_stdio", "ask", Some(frame.id.clone())),
            BotifiedFrameEvent::Tell(frame) => ("task_stdio", "tell", Some(frame.id.clone())),
            BotifiedFrameEvent::RegistrySet(frame) => {
                ("task_stdio_registry", "registry_set", frame.id.clone())
            }
            BotifiedFrameEvent::RegistryDelete(frame) => {
                ("task_stdio_registry", "registry_delete", frame.id.clone())
            }
            BotifiedFrameEvent::RegistryGet(frame) => (
                "task_stdio_registry",
                "registry_get",
                Some(frame.id.clone()),
            ),
            BotifiedFrameEvent::ObserveRequest(frame) => {
                ("task_observer", "observe_request", Some(frame.id.clone()))
            }
            BotifiedFrameEvent::ObserveRequestRejected(frame) => {
                ("task_observer", "observe_request", Some(frame.id.clone()))
            }
            BotifiedFrameEvent::Diagnostic(diagnostic) => {
                ("task_stdio", "diagnostic", diagnostic.request_id.clone())
            }
            BotifiedFrameEvent::ProtocolDiagnostic(diagnostic) => (
                "task_stdio_protocol",
                "protocol_diagnostic",
                diagnostic.request_id.clone(),
            ),
            BotifiedFrameEvent::RegistryDiagnostic(diagnostic) => (
                "task_stdio_registry",
                "registry_diagnostic",
                diagnostic.request_id.clone(),
            ),
        };
        let diagnostic = TaskFrameDiagnostic {
            op: Some(op.to_owned()),
            code: "task_frame_lane_full",
            message: "task stdout event lane is full".to_owned(),
            request_id,
        };
        self.record_internal_stdio_diagnostic(domain, task_id, diagnostic);
    }
}

fn task_frame_request_id(event: &BotifiedFrameEvent) -> Option<String> {
    match event {
        BotifiedFrameEvent::Ask(frame) => Some(frame.id.clone()),
        BotifiedFrameEvent::Tell(frame) => Some(frame.id.clone()),
        BotifiedFrameEvent::RegistrySet(frame) => frame.id.clone(),
        BotifiedFrameEvent::RegistryGet(frame) => Some(frame.id.clone()),
        BotifiedFrameEvent::RegistryDelete(frame) => frame.id.clone(),
        BotifiedFrameEvent::ObserveRequest(frame) => Some(frame.id.clone()),
        BotifiedFrameEvent::ObserveRequestRejected(frame) => Some(frame.id.clone()),
        BotifiedFrameEvent::Diagnostic(frame)
        | BotifiedFrameEvent::ProtocolDiagnostic(frame)
        | BotifiedFrameEvent::RegistryDiagnostic(frame) => frame.request_id.clone(),
    }
}
