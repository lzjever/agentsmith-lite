use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

static NEXT_TASK_TELL_INPUT_SUFFIX: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::service) enum TaskFrameAdmissionKind {
    Ask,
    Tell,
    RegistrySet,
    RegistryGet,
    RegistryDelete,
    Diagnostic,
    Observe,
    TaskInputPersistence,
    TaskInputBeforeFinal,
    TaskInputFinal,
    Finish,
    Cancel,
}

#[derive(Default)]
pub(in crate::service) struct TaskFrameAdmissionGate {
    pub(in crate::service) finishing_tasks: HashSet<String>,
    pub(in crate::service) discarding_tasks: HashSet<String>,
    #[cfg(test)]
    hook: Option<Arc<dyn Fn(TaskFrameAdmissionKind) + Send + Sync>>,
    #[cfg(test)]
    pub(super) fail_next_lane_spawn: bool,
}

impl TaskFrameAdmissionGate {
    pub(in crate::service) fn task_can_commit(&self, task_id: &str) -> bool {
        !self.discarding_tasks.contains(task_id)
    }

    pub(in crate::service) fn pause_for_test(&self, kind: TaskFrameAdmissionKind) {
        #[cfg(test)]
        if let Some(hook) = &self.hook {
            hook(kind);
        }
        #[cfg(not(test))]
        let _ = kind;
    }
}

pub(in crate::service) struct AcceptedTaskRequestFrameAdmission {
    pub(super) request_id: String,
    pub(super) task_message: String,
    pub(super) message_id: String,
    pub(super) content: Vec<ContentPart>,
    pub(super) urgency: InputUrgency,
    pub(super) metadata: QueuedInputMetadata,
    pub(super) owner: TaskOwner,
}

pub(super) struct AcceptedTaskTellFrameAdmission {
    pub(super) snapshot: TaskTellSnapshot,
    pub(super) message_id: String,
    pub(super) content: Vec<ContentPart>,
    pub(super) metadata: Box<QueuedInputMetadata>,
}

#[allow(clippy::large_enum_variant)]
pub(in crate::service) enum TaskRequestFrameAdmission {
    Accepted(AcceptedTaskRequestFrameAdmission),
    ApplyStdinIntents(Vec<TaskStdinIntent>),
    None,
}

pub(super) enum TaskTellFrameAdmission {
    Accepted(AcceptedTaskTellFrameAdmission),
    Rejected(TaskTellSnapshot),
    None,
}

impl ServiceInner {
    #[cfg(test)]
    pub(in crate::service) fn set_task_frame_admission_hook_for_test(
        &self,
        hook: Option<Arc<dyn Fn(TaskFrameAdmissionKind) + Send + Sync>>,
    ) {
        self.task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned")
            .hook = hook;
    }

    pub(in crate::service) fn pause_before_task_frame_commit_for_test(
        &self,
        kind: TaskFrameAdmissionKind,
    ) {
        #[cfg(test)]
        let hook = self
            .task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned")
            .hook
            .clone();
        #[cfg(test)]
        if let Some(hook) = hook {
            hook(kind);
        }
        #[cfg(not(test))]
        let _ = kind;
    }

    pub(super) fn with_task_frame_commit<T>(
        &self,
        task_id: &str,
        kind: TaskFrameAdmissionKind,
        commit: impl FnOnce() -> Result<T, FailedTransitionIntent>,
    ) -> Option<T> {
        self.pause_before_task_frame_commit_for_test(kind);
        let result = {
            let admission = self
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned");
            if self.is_failed_or_shutting_down()
                || !admission.task_can_commit(task_id)
                || !self
                    .background_tasks
                    .get(task_id)
                    .is_some_and(|task| task.state == TaskState::Running)
            {
                return None;
            }
            commit()
        };
        match result {
            Ok(value) => Some(value),
            Err(failure) => {
                failure.transition(self);
                None
            }
        }
    }

    pub(in crate::service) fn admit_task_request_frame(
        self: &Arc<Self>,
        task_id: &str,
        frame: TaskRequestFrame,
    ) -> TaskRequestFrameAdmission {
        let admission = self
            .task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned");
        if self.is_failed_or_shutting_down()
            || !admission.task_can_commit(task_id)
            || self
                .background_tasks
                .get(task_id)
                .is_some_and(|task| task.state != TaskState::Running)
        {
            return TaskRequestFrameAdmission::None;
        }
        admission.pause_for_test(TaskFrameAdmissionKind::Ask);
        if self.is_failed_or_shutting_down()
            || !admission.task_can_commit(task_id)
            || self
                .background_tasks
                .get(task_id)
                .is_some_and(|task| task.state != TaskState::Running)
        {
            return TaskRequestFrameAdmission::None;
        }

        let request_id = frame.id.clone();
        let request_bytes = frame.request.len();
        let expect_bytes = frame.expect.as_deref().map(str::len).unwrap_or(0);
        let urgency = frame.urgency;
        match self.background_tasks.accept_task_request(task_id, frame) {
            TaskRequestAdmission::Accepted(snapshot) => {
                let accepted = AcceptedTaskRequestFrameAdmission {
                    request_id: request_id.clone(),
                    task_message: snapshot.request.clone(),
                    message_id: task_request_input_id(task_id, &request_id),
                    content: task_request_content(&snapshot),
                    urgency: snapshot.urgency,
                    metadata: QueuedInputMetadata::TaskRequest {
                        task_id: task_id.to_owned(),
                        request_id,
                    },
                    owner: snapshot.owner.clone(),
                };
                if matches!(snapshot.owner, TaskOwner::Subagent { .. }) {
                    schedule_task_request_deadline_check(self.clone(), snapshot);
                    return TaskRequestFrameAdmission::Accepted(accepted);
                }
                if let Err(failure) = self.try_append_task_frame_event_and_status(
                    "task_ask.requested",
                    task_request_event_data(&snapshot),
                ) {
                    drop(admission);
                    failure.transition(self);
                    return TaskRequestFrameAdmission::None;
                }
                self.write_task_request_profile_for_snapshot("task_ask.requested", &snapshot);
                schedule_task_request_deadline_check(self.clone(), snapshot);
                TaskRequestFrameAdmission::Accepted(accepted)
            }
            TaskRequestAdmission::Duplicate(snapshot) => {
                if let TaskOwner::Subagent { subagent_id } = &snapshot.owner {
                    let append =
                        self.try_append_subagent_event_for_id("subagent.callback", subagent_id);
                    if let Some(error) = append.persistence_error {
                        drop(admission);
                        FailedTransitionIntent::timeline(error).transition(self);
                    }
                    return TaskRequestFrameAdmission::None;
                }
                if let Err(failure) = self.try_append_task_frame_event(
                    "service.warning",
                    duplicate_task_request_warning_data(&snapshot),
                ) {
                    drop(admission);
                    failure.transition(self);
                }
                TaskRequestFrameAdmission::None
            }
            TaskRequestAdmission::Rejected(snapshot) => {
                if matches!(snapshot.owner, TaskOwner::Subagent { .. }) {
                    let reason = snapshot
                        .failure_reason
                        .clone()
                        .unwrap_or_else(|| "task request rejected".to_owned());
                    return TaskRequestFrameAdmission::ApplyStdinIntents(vec![
                        TaskStdinIntent::exception(
                            task_id,
                            &request_id,
                            exception_code_for_rejected_request(&reason),
                            &reason,
                        ),
                    ]);
                }
                if let Err(failure) = self.try_append_task_frame_event_and_status(
                    "task_ask.rejected",
                    task_request_event_data(&snapshot),
                ) {
                    drop(admission);
                    failure.transition(self);
                    return TaskRequestFrameAdmission::None;
                }
                self.write_task_request_profile_for_snapshot("task_ask.rejected", &snapshot);
                let reason = snapshot
                    .failure_reason
                    .clone()
                    .unwrap_or_else(|| "task request rejected".to_owned());
                TaskRequestFrameAdmission::ApplyStdinIntents(vec![TaskStdinIntent::exception(
                    task_id,
                    &request_id,
                    exception_code_for_rejected_request(&reason),
                    &reason,
                )])
            }
            TaskRequestAdmission::TaskMissing => {
                if let Err(failure) = self.try_append_task_frame_event(
                    "task_ask.rejected",
                    json!({
                        "task_id": task_id,
                        "ask_id": request_id,
                        "state": "rejected",
                        "status": "rejected",
                        "failure_reason": "task not found"
                    }),
                ) {
                    drop(admission);
                    failure.transition(self);
                    return TaskRequestFrameAdmission::None;
                }
                self.write_rejected_task_request_profile(
                    task_id,
                    Some(&request_id),
                    Some(urgency),
                    Some(request_bytes),
                    Some(expect_bytes),
                    "task_not_found",
                    "task not found",
                );
                TaskRequestFrameAdmission::None
            }
        }
    }

    pub(super) fn admit_task_tell_frame(
        self: &Arc<Self>,
        task_id: &str,
        frame: TaskTellFrame,
    ) -> TaskTellFrameAdmission {
        let admission = self
            .task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned");
        if self.is_failed_or_shutting_down()
            || !admission.task_can_commit(task_id)
            || self
                .background_tasks
                .get(task_id)
                .is_some_and(|task| task.state != TaskState::Running)
        {
            return TaskTellFrameAdmission::None;
        }
        admission.pause_for_test(TaskFrameAdmissionKind::Tell);
        if self.is_failed_or_shutting_down()
            || !admission.task_can_commit(task_id)
            || self
                .background_tasks
                .get(task_id)
                .is_some_and(|task| task.state != TaskState::Running)
        {
            return TaskTellFrameAdmission::None;
        }

        let tell_id = frame.id.clone();
        let task = self.background_tasks.get(task_id);
        let Some(task) = task else {
            return TaskTellFrameAdmission::Rejected(task_tell_snapshot(
                task_id,
                None,
                frame,
                "rejected",
                Some("task not found".to_owned()),
            ));
        };
        if task.state.is_terminal() {
            return TaskTellFrameAdmission::Rejected(task_tell_snapshot(
                task_id,
                Some(&task),
                frame,
                "task_terminal",
                Some("task is terminal".to_owned()),
            ));
        }

        let snapshot = task_tell_snapshot(task_id, Some(&task), frame, "accepted", None);
        let suffix = NEXT_TASK_TELL_INPUT_SUFFIX.fetch_add(1, Ordering::SeqCst);
        let accepted = AcceptedTaskTellFrameAdmission {
            message_id: task_tell_input_id(task_id, &tell_id, suffix),
            content: task_tell_content(&snapshot),
            metadata: Box::new(QueuedInputMetadata::TaskTell {
                task_id: task_id.to_owned(),
                tell_id,
            }),
            snapshot,
        };
        if matches!(accepted.snapshot.owner, TaskOwner::Subagent { .. }) {
            return TaskTellFrameAdmission::Accepted(accepted);
        }
        if let Err(failure) = self.try_append_task_frame_event_and_status(
            "task_tell.accepted",
            task_tell_event_data(&accepted.snapshot),
        ) {
            drop(admission);
            failure.transition(self);
            return TaskTellFrameAdmission::None;
        }
        self.write_task_tell_profile("task_tell.accepted", &accepted.snapshot);
        TaskTellFrameAdmission::Accepted(accepted)
    }
}
