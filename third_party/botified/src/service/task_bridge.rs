use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::registry_protocol::MIN_STDIO_REGISTRY_RESPONSE_BYTES;
use crate::tasks::TaskRegistryDeleteFrame;

use super::task_projection::{
    duplicate_task_request_warning_data, task_frame_diagnostic_data, task_reply_attempt_event_type,
    task_reply_event_data, task_reply_status_name, task_request_content,
    task_request_effect_event_data, task_request_event_data, task_request_state_name,
    task_send_details, task_send_status_name, task_stdin_write_failed_event_data,
    task_tell_content, task_tell_diagnostic_event_data, task_tell_event_data,
};
use super::task_runtime::{
    callback_text, default_registry_source_for_task, exception_code_for_rejected_request,
    exception_code_for_service_error, managed_task_registry_origin,
    schedule_task_request_deadline_check, spawn_task_observer_preview_loop, task_request_input_id,
    task_stdin_intent_frame_kind, task_tell_input_id, task_tell_snapshot,
    TaskObserverPreviewLoopStartedGuard,
};
use super::*;

mod admission;
mod diagnostics;
mod lane;
mod observer;
mod registry;

use admission::TaskTellFrameAdmission;
pub(super) use admission::{
    TaskFrameAdmissionGate, TaskFrameAdmissionKind, TaskRequestFrameAdmission,
};
pub(super) use diagnostics::InternalStdioDiagnostics;
pub(super) use lane::TaskFrameLane;
#[cfg(test)]
pub(super) use lane::TASK_FRAME_LANE_CAPACITY;

static NEXT_TASK_SEND_ID_SUFFIX: AtomicU64 = AtomicU64::new(1);

impl ServiceInner {
    fn try_append_task_frame_event(
        &self,
        event_type: &'static str,
        data: Value,
    ) -> Result<(), FailedTransitionIntent> {
        self.try_append_event_for_turn(None, event_type, data)
            .map(|_| ())
            .map_err(FailedTransitionIntent::timeline)
    }

    fn try_append_task_frame_event_and_status(
        &self,
        event_type: &'static str,
        data: Value,
    ) -> Result<(), FailedTransitionIntent> {
        let mut state = self.state.lock().expect("service state mutex poisoned");
        self.try_append_event_for_turn_or_mark_locked(&mut state, None, event_type, data)?;
        let turn_id = state.active_turn_id.clone();
        self.try_append_service_status_for_locked(&mut state, turn_id.as_deref())?;
        Ok(())
    }

    pub(super) fn reply_task_request(
        &self,
        task_id: &str,
        request_id: &str,
        response: &str,
    ) -> TaskReplyOutcome {
        self.reply_task_request_by_owner(&TaskOwner::Main, task_id, request_id, response)
    }

    pub(super) fn reply_task_request_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
        request_id: &str,
        response: &str,
    ) -> TaskReplyOutcome {
        if self.is_failed_or_shutting_down() {
            let outcome = TaskReplyOutcome::rejected(
                task_id,
                request_id,
                "service is not accepting task replies",
            );
            self.write_task_reply_profile("task_reply.failed", &outcome);
            return outcome;
        }
        let plan = self
            .background_tasks
            .prepare_task_reply_by_owner(owner, task_id, request_id, response);
        if let TaskOwner::Subagent { subagent_id } = owner {
            let outcome = match plan {
                TaskReplyPlan::ReadyToWrite { stdin_intents, .. } => {
                    let append =
                        self.try_append_subagent_event_for_id("subagent.callback", subagent_id);
                    if !append.complete() {
                        let reason = "task reply audit persistence failed";
                        let exception = TaskStdinIntent::exception(
                            task_id,
                            request_id,
                            "persistence_failed",
                            reason,
                        );
                        let _ = self.apply_task_stdin_intent(&exception);
                        let outcome = self.background_tasks.complete_prepared_task_reply_by_owner(
                            owner,
                            task_id,
                            request_id,
                            Err(reason.to_owned()),
                        );
                        if let Some(error) = append.persistence_error {
                            self.record_timeline_persistence_error(error);
                        }
                        outcome
                    } else {
                        let write_result = self.apply_task_stdin_intents(&stdin_intents);
                        self.background_tasks.complete_prepared_task_reply_by_owner(
                            owner,
                            task_id,
                            request_id,
                            write_result,
                        )
                    }
                }
                TaskReplyPlan::Finished(outcome) => {
                    self.append_subagent_event_for_id("subagent.callback", subagent_id);
                    outcome
                }
            };
            self.apply_task_request_effects(&outcome.effects);
            let mut data = task_reply_event_data(&outcome);
            data["subagent_id"] = json!(subagent_id);
            data["task_id"] = json!(task_id);
            data["ask_id"] = json!(request_id);
            if let Some(event_type) = outcome.canonical_event_type() {
                self.append_event_for_turn_or_record_error(None, event_type, data);
                self.write_task_reply_profile(event_type, &outcome);
            }
            self.append_service_status_for_current_state(None);
            return outcome;
        }
        let outcome = match plan {
            TaskReplyPlan::ReadyToWrite { stdin_intents, .. } => {
                let write_result = self.apply_task_stdin_intents(&stdin_intents);
                self.background_tasks.complete_prepared_task_reply_by_owner(
                    owner,
                    task_id,
                    request_id,
                    write_result,
                )
            }
            TaskReplyPlan::Finished(outcome) => {
                self.apply_task_request_effects(&outcome.effects);
                outcome
            }
        };
        if outcome.status == TaskReplyStatus::Written {
            self.append_event_for_turn_or_record_error(
                None,
                "task_reply.accepted",
                task_reply_event_data(&outcome),
            );
            self.write_task_reply_profile("task_reply.accepted", &outcome);
        }
        let event_type = task_reply_attempt_event_type(&outcome);
        self.append_event_for_turn_or_record_error(
            None,
            event_type,
            task_reply_event_data(&outcome),
        );
        self.write_task_reply_profile(event_type, &outcome);
        self.append_service_status_for_current_state(None);
        outcome
    }

    pub(super) fn send_task_message_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
        message: &str,
    ) -> TaskSendOutcome {
        if self.is_failed_or_shutting_down() {
            let outcome = TaskSendOutcome::new(
                TaskSendStatus::ServiceUnavailable,
                task_id,
                None,
                "service is not accepting task sends",
            );
            self.append_task_send_event("task_send.failed", &outcome);
            return outcome;
        }
        let Some(task) = self.background_tasks.get_by_owner(owner, task_id) else {
            let outcome = TaskSendOutcome::new(
                TaskSendStatus::UnknownTask,
                task_id,
                None,
                format!("unknown task: {task_id}"),
            );
            self.append_task_send_event("task_send.failed", &outcome);
            return outcome;
        };
        if task.state.is_terminal() {
            let outcome = TaskSendOutcome::new(
                TaskSendStatus::TaskTerminal,
                task_id,
                None,
                "task is terminal",
            );
            self.append_task_send_event("task_send.failed", &outcome);
            return outcome;
        }
        let Some(writer) = self.background_tasks.stdin_writer(task_id) else {
            let outcome = TaskSendOutcome::new(
                TaskSendStatus::StdinNotWritable,
                task_id,
                None,
                "task stdin is not writable",
            );
            self.append_task_send_event("task_send.failed", &outcome);
            return outcome;
        };
        let frame_cap = writer.atomic_frame_cap();

        let send_id = next_task_send_id();
        let intent = TaskStdinIntent::send(task_id, &send_id, message);
        if let Err(error) =
            validate_task_stdin_frame(TaskStdinFrameKind::Send, intent.frame.as_bytes(), frame_cap)
        {
            let outcome = TaskSendOutcome::new(
                TaskSendStatus::MessageTooLarge,
                task_id,
                Some(send_id),
                bounded_chars(&error, 512),
            );
            self.append_task_send_event("task_send.failed", &outcome);
            return outcome;
        }

        if let TaskOwner::Subagent { subagent_id } = owner {
            if !self.append_subagent_event_for_id("subagent.callback", subagent_id) {
                let outcome = TaskSendOutcome::new(
                    TaskSendStatus::WriteFailed,
                    task_id,
                    None,
                    "task send audit persistence failed",
                );
                self.append_task_send_event("task_send.failed", &outcome);
                return outcome;
            }
        }

        let accepted = TaskSendOutcome::new(
            TaskSendStatus::Written,
            task_id,
            Some(send_id.clone()),
            "task send accepted",
        );
        self.append_task_send_event("task_send.accepted", &accepted);

        let outcome = match self.apply_task_stdin_intent(&intent) {
            Ok(()) => TaskSendOutcome::new(
                TaskSendStatus::Written,
                task_id,
                Some(send_id),
                "task send written",
            ),
            Err(error) => TaskSendOutcome::new(
                TaskSendStatus::WriteFailed,
                task_id,
                Some(send_id),
                bounded_chars(&error, 512),
            ),
        };
        let event_type = if outcome.ok() {
            "task_send.written"
        } else {
            "task_send.failed"
        };
        self.append_task_send_event(event_type, &outcome);
        self.append_service_status_for_current_state(None);
        outcome
    }

    fn append_task_send_event(&self, event_type: &'static str, outcome: &TaskSendOutcome) {
        self.append_event_for_turn_or_record_error(None, event_type, task_send_details(outcome));
        self.write_task_send_profile(event_type, outcome);
    }

    pub(super) fn apply_task_request_effects(&self, effects: &[TaskRequestEffect]) {
        for effect in effects {
            self.apply_task_request_effect(effect);
        }
    }

    fn try_apply_task_frame_request_effects(
        &self,
        effects: &[TaskRequestEffect],
    ) -> Result<(), FailedTransitionIntent> {
        for effect in effects {
            self.try_append_task_frame_event(
                effect.event_type,
                task_request_effect_event_data(effect),
            )?;
            self.write_task_request_profile_for_snapshot(effect.event_type, &effect.snapshot);
            for intent in &effect.stdin_intents {
                self.try_apply_task_frame_stdin_intent(intent)?;
            }
        }
        Ok(())
    }

    fn try_apply_task_frame_stdin_intent(
        &self,
        intent: &TaskStdinIntent,
    ) -> Result<(), FailedTransitionIntent> {
        if let Err(error) = self.apply_task_stdin_intent(intent) {
            self.try_append_task_frame_event(
                "task.stdin_write_failed",
                task_stdin_write_failed_event_data(intent, &error),
            )?;
        }
        Ok(())
    }

    fn apply_task_request_effect(&self, effect: &TaskRequestEffect) {
        self.append_event_for_turn_or_record_error(
            None,
            effect.event_type,
            task_request_effect_event_data(effect),
        );
        self.write_task_request_profile_for_snapshot(effect.event_type, &effect.snapshot);
        for intent in &effect.stdin_intents {
            self.apply_task_stdin_intent_with_diagnostic(intent);
        }
    }

    fn apply_task_stdin_intents(&self, intents: &[TaskStdinIntent]) -> Result<(), String> {
        for intent in intents {
            self.apply_task_stdin_intent(intent)?;
        }
        Ok(())
    }

    fn apply_task_stdin_intent(&self, intent: &TaskStdinIntent) -> Result<(), String> {
        let writer = self
            .background_tasks
            .stdin_writer(&intent.task_id)
            .ok_or_else(|| "task stdin is not writable".to_owned())?;
        let kind = task_stdin_intent_frame_kind(intent);
        let delivered = try_write_task_stdin_frame(writer.as_ref(), kind, intent.frame.as_bytes())?;
        self.record_delivered_task_stdin_diagnostic(
            "task_stdio_protocol",
            &intent.task_id,
            kind,
            Some(intent.request_id.clone()),
            delivered,
        );
        Ok(())
    }

    fn apply_task_stdin_intent_with_diagnostic(&self, intent: &TaskStdinIntent) {
        if let Err(error) = self.apply_task_stdin_intent(intent) {
            self.append_event_for_turn_or_record_error(
                None,
                "task.stdin_write_failed",
                task_stdin_write_failed_event_data(intent, &error),
            );
        }
    }

    async fn handle_task_frame_events(
        self: Arc<Self>,
        task_id: String,
        events: Vec<BotifiedFrameEvent>,
    ) {
        let mut start_cancel = None;
        for event in events {
            if self.is_failed_or_shutting_down() {
                return;
            }
            match event {
                BotifiedFrameEvent::Ask(frame) => {
                    if let Some(cancel) = self.handle_task_request_frame(&task_id, frame).await {
                        start_cancel.get_or_insert(cancel);
                    }
                }
                BotifiedFrameEvent::Tell(frame) => {
                    if let Some(cancel) = self.handle_task_tell_frame(&task_id, frame).await {
                        start_cancel.get_or_insert(cancel);
                    }
                }
                BotifiedFrameEvent::RegistrySet(frame) => {
                    self.handle_task_registry_set_frame(&task_id, frame);
                }
                BotifiedFrameEvent::RegistryGet(frame) => {
                    self.handle_task_registry_get_frame(&task_id, frame);
                }
                BotifiedFrameEvent::RegistryDelete(frame) => {
                    self.handle_task_registry_delete_frame(&task_id, frame);
                }
                BotifiedFrameEvent::ObserveRequest(frame) => {
                    self.handle_task_observe_request(&task_id, frame).await;
                }
                BotifiedFrameEvent::ObserveRequestRejected(frame) => {
                    self.handle_rejected_task_observe_request(&task_id, frame)
                        .await;
                }
                BotifiedFrameEvent::Diagnostic(diagnostic) => {
                    self.handle_task_frame_diagnostic(&task_id, diagnostic);
                }
                BotifiedFrameEvent::ProtocolDiagnostic(diagnostic) => {
                    self.commit_task_protocol_diagnostic(&task_id, diagnostic);
                }
                BotifiedFrameEvent::RegistryDiagnostic(diagnostic) => {
                    self.commit_task_registry_diagnostic(&task_id, diagnostic);
                }
            }
        }
        if let Some(cancel) = start_cancel {
            spawn_service_loop(self.clone(), cancel);
        }
        self.notify.notify_waiters();
    }

    pub(super) async fn handle_task_request_frame(
        self: &Arc<Self>,
        task_id: &str,
        frame: TaskRequestFrame,
    ) -> Option<CancellationToken> {
        match self.admit_task_request_frame(task_id, frame) {
            TaskRequestFrameAdmission::Accepted(accepted) => {
                if self.is_failed() {
                    return None;
                }
                if let TaskOwner::Subagent { subagent_id } = &accepted.owner {
                    let content = callback_text(&accepted.content);
                    let callback = enqueue_subagent_text_callback(
                        self.clone(),
                        Some(task_id),
                        subagent_id,
                        "task_ask",
                        Some(&accepted.request_id),
                        Some(&accepted.task_message),
                        content,
                    )
                    .await;
                    if !callback.queued {
                        self.reject_accepted_task_request_after_callback_failure(
                            task_id,
                            &accepted.request_id,
                            "agent_callback_unavailable",
                            "task request could not be delivered to the subagent",
                        );
                    }
                    if let Some(error) = callback.persistence_error {
                        self.record_timeline_persistence_error(error);
                    }
                    return None;
                }
                if self.is_failed() {
                    return None;
                }
                let EnqueueInputAttempt {
                    outcome,
                    start_cancel,
                    preemption,
                    failure: _,
                } = enqueue_task_input_inner(
                    self,
                    task_id,
                    accepted.message_id,
                    accepted.content,
                    InputSource::TaskRequest,
                    accepted.urgency,
                    Some(accepted.metadata),
                    || Ok(()),
                )
                .await;
                if self.is_failed() {
                    return None;
                }
                if let Err(error) = outcome {
                    self.reject_accepted_task_request_after_enqueue_failure(
                        task_id,
                        &accepted.request_id,
                        &error,
                    );
                }
                let _ = (start_cancel, preemption);
                None
            }
            TaskRequestFrameAdmission::ApplyStdinIntents(intents) => {
                self.with_task_frame_commit(task_id, TaskFrameAdmissionKind::Ask, || {
                    for intent in &intents {
                        self.try_apply_task_frame_stdin_intent(intent)?;
                    }
                    Ok(())
                });
                None
            }
            TaskRequestFrameAdmission::None => None,
        }
    }

    async fn handle_task_tell_frame(
        self: &Arc<Self>,
        task_id: &str,
        frame: TaskTellFrame,
    ) -> Option<CancellationToken> {
        match self.admit_task_tell_frame(task_id, frame) {
            TaskTellFrameAdmission::Accepted(accepted) => {
                if self.is_failed() {
                    return None;
                }
                if let TaskOwner::Subagent { subagent_id } = &accepted.snapshot.owner {
                    let content = callback_text(&accepted.content);
                    let callback = enqueue_subagent_text_callback(
                        self.clone(),
                        Some(task_id),
                        subagent_id,
                        "task_tell",
                        Some(&accepted.snapshot.tell_id),
                        Some(&accepted.snapshot.message),
                        content,
                    )
                    .await;
                    if !callback.queued {
                        let mut rejected = accepted.snapshot.clone();
                        rejected.state = "rejected";
                        rejected.failure_reason =
                            Some("task tell could not be delivered to the subagent".to_owned());
                        if self
                            .with_task_frame_commit(task_id, TaskFrameAdmissionKind::Tell, || {
                                self.try_append_task_frame_event_and_status(
                                    "task_tell.rejected",
                                    task_tell_event_data(&rejected),
                                )
                            })
                            .is_some()
                        {
                            self.write_task_tell_profile("task_tell.rejected", &rejected);
                        }
                    }
                    if let Some(error) = callback.persistence_error {
                        self.record_timeline_persistence_error(error);
                    }
                    return None;
                }
                let urgency = accepted.snapshot.urgency;
                let EnqueueInputAttempt {
                    outcome,
                    start_cancel,
                    preemption,
                    failure: _,
                } = enqueue_task_input_inner(
                    self,
                    task_id,
                    accepted.message_id,
                    accepted.content,
                    InputSource::TaskTell,
                    urgency,
                    Some(*accepted.metadata),
                    || {
                        self.try_append_task_frame_event(
                            "task_tell.queued",
                            task_tell_event_data(&accepted.snapshot),
                        )?;
                        self.write_task_tell_profile("task_tell.queued", &accepted.snapshot);
                        Ok(())
                    },
                )
                .await;
                if self.is_failed() {
                    return None;
                }
                match outcome {
                    Ok(_) => {}
                    Err(error) => {
                        let mut rejected = accepted.snapshot.clone();
                        rejected.state = "rejected";
                        rejected.failure_reason = Some(error.to_string());
                        if self
                            .with_task_frame_commit(task_id, TaskFrameAdmissionKind::Tell, || {
                                self.try_append_task_frame_event(
                                    "task_tell.rejected",
                                    task_tell_event_data(&rejected),
                                )
                            })
                            .is_some()
                        {
                            self.write_task_tell_profile("task_tell.rejected", &rejected);
                        }
                    }
                }
                let _ = (start_cancel, preemption);
                None
            }
            TaskTellFrameAdmission::Rejected(snapshot) => {
                if self
                    .with_task_frame_commit(task_id, TaskFrameAdmissionKind::Tell, || {
                        self.try_append_task_frame_event_and_status(
                            "task_tell.rejected",
                            task_tell_event_data(&snapshot),
                        )
                    })
                    .is_some()
                {
                    self.write_task_tell_profile("task_tell.rejected", &snapshot);
                }
                None
            }
            TaskTellFrameAdmission::None => None,
        }
    }

    fn registry_stdio_writer_cap(
        &self,
        task_id: &str,
        request_id: &str,
        writer: &dyn TaskStdinWriter,
    ) -> Option<usize> {
        let writer_cap = writer.atomic_frame_cap();
        if writer_cap < MIN_STDIO_REGISTRY_RESPONSE_BYTES {
            self.record_task_registry_write_failure(
                task_id,
                request_id,
                &format!(
                    "task stdin atomic frame cap {writer_cap} cannot hold minimum registry response frame ({MIN_STDIO_REGISTRY_RESPONSE_BYTES} bytes)"
                ),
            );
            return None;
        }
        Some(writer_cap)
    }

    fn record_task_registry_write_failure(&self, task_id: &str, request_id: &str, error: &str) {
        self.handle_task_registry_diagnostic(
            task_id,
            TaskFrameDiagnostic {
                op: Some("registry_get".to_owned()),
                code: "stdin_write_failed",
                message: bounded_chars(error, 512),
                request_id: Some(request_id.to_owned()),
            },
        );
    }

    fn handle_task_registry_diagnostic(&self, task_id: &str, diagnostic: TaskFrameDiagnostic) {
        self.record_internal_stdio_diagnostic("task_stdio_registry", task_id, diagnostic);
    }

    fn commit_task_protocol_diagnostic(&self, task_id: &str, diagnostic: TaskFrameDiagnostic) {
        self.commit_task_internal_diagnostic("task_stdio_protocol", task_id, diagnostic);
    }

    fn commit_task_registry_diagnostic(&self, task_id: &str, diagnostic: TaskFrameDiagnostic) {
        self.commit_task_internal_diagnostic("task_stdio_registry", task_id, diagnostic);
    }

    pub(super) fn reject_accepted_task_request_after_enqueue_failure(
        &self,
        task_id: &str,
        request_id: &str,
        error: &ServiceError,
    ) {
        let reason = error.to_string();
        self.with_task_frame_commit(task_id, TaskFrameAdmissionKind::Ask, || {
            if let Some(resolution) = self.background_tasks.reject_task_request(
                task_id,
                request_id,
                exception_code_for_service_error(error),
                reason,
            ) {
                self.try_apply_task_frame_request_effects(&resolution.effects)?;
                let mut state = self.state.lock().expect("service state mutex poisoned");
                let turn_id = state.active_turn_id.clone();
                self.try_append_service_status_for_locked(&mut state, turn_id.as_deref())?;
            }
            Ok(())
        });
    }

    fn reject_accepted_task_request_after_callback_failure(
        &self,
        task_id: &str,
        request_id: &str,
        exception_code: &'static str,
        reason: &'static str,
    ) {
        self.with_task_frame_commit(task_id, TaskFrameAdmissionKind::Ask, || {
            if let Some(resolution) = self.background_tasks.reject_task_request(
                task_id,
                request_id,
                exception_code,
                reason,
            ) {
                self.try_apply_task_frame_request_effects(&resolution.effects)?;
                let mut state = self.state.lock().expect("service state mutex poisoned");
                let turn_id = state.active_turn_id.clone();
                self.try_append_service_status_for_locked(&mut state, turn_id.as_deref())?;
            }
            Ok(())
        });
    }

    pub(super) fn handle_task_frame_diagnostic(
        &self,
        task_id: &str,
        diagnostic: TaskFrameDiagnostic,
    ) {
        if let Some(intent) = self.admit_task_frame_diagnostic(task_id, diagnostic) {
            if self.is_failed() {
                return;
            }
            self.apply_task_stdin_intent_with_diagnostic(&intent);
        }
    }

    fn admit_task_frame_diagnostic(
        &self,
        task_id: &str,
        diagnostic: TaskFrameDiagnostic,
    ) -> Option<TaskStdinIntent> {
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
            return None;
        }
        admission.pause_for_test(TaskFrameAdmissionKind::Diagnostic);
        if self.is_failed_or_shutting_down()
            || !admission.task_can_commit(task_id)
            || self
                .background_tasks
                .get(task_id)
                .is_some_and(|task| task.state != TaskState::Running)
        {
            return None;
        }

        let task = self.background_tasks.get(task_id);
        if diagnostic.op.as_deref() == Some("tell") {
            let tell_id = diagnostic
                .request_id
                .clone()
                .unwrap_or_else(|| "unknown".to_owned());
            let snapshot = task_tell_snapshot(
                task_id,
                task.as_ref(),
                TaskTellFrame {
                    id: tell_id,
                    message: String::new(),
                    urgency: InputUrgency::Normal,
                },
                "rejected",
                Some(diagnostic.message.clone()),
            );
            if let Err(failure) = self.try_append_task_frame_event_and_status(
                "task_tell.rejected",
                task_tell_diagnostic_event_data(&snapshot, &diagnostic),
            ) {
                drop(admission);
                failure.transition(self);
                return None;
            }
            self.write_task_tell_profile("task_tell.rejected", &snapshot);
            return None;
        }
        if let Some(TaskSnapshot {
            owner: TaskOwner::Subagent { subagent_id },
            ..
        }) = task.as_ref()
        {
            let append = self.try_append_subagent_event_for_id("subagent.callback", subagent_id);
            if let Some(error) = append.persistence_error {
                drop(admission);
                FailedTransitionIntent::timeline(error).transition(self);
                return None;
            }
            return diagnostic.request_id.as_deref().map(|request_id| {
                TaskStdinIntent::exception(
                    task_id,
                    request_id,
                    diagnostic.code,
                    &diagnostic.message,
                )
            });
        }
        if let Err(failure) = self.try_append_task_frame_event_and_status(
            "task_ask.rejected",
            task_frame_diagnostic_data(task_id, &diagnostic, task.as_ref()),
        ) {
            drop(admission);
            failure.transition(self);
            return None;
        }
        self.write_rejected_task_request_profile(
            task_id,
            diagnostic.request_id.as_deref(),
            None,
            None,
            None,
            diagnostic.code,
            "task frame diagnostic rejected",
        );
        diagnostic.request_id.as_deref().map(|request_id| {
            TaskStdinIntent::exception(task_id, request_id, diagnostic.code, &diagnostic.message)
        })
    }

    pub(super) fn expire_due_task_requests(&self, task_id: &str, now: SystemTime) {
        if self.is_failed_or_shutting_down() {
            return;
        }
        let expired = self
            .background_tasks
            .expire_pending_requests_for_task(task_id, now);
        if expired.is_empty() {
            return;
        }
        for resolution in expired {
            self.apply_task_request_effects(&resolution.effects);
        }
        self.append_service_status_for_current_state(None);
        self.notify.notify_waiters();
    }
}

pub(super) struct ServiceInteractiveStdioBridge {
    pub(super) inner: Arc<ServiceInner>,
    pub(super) task_id: String,
}

impl ServiceInner {
    pub(super) fn cancel_background_task_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
    ) -> Option<TaskSnapshot> {
        let (had_observer_admission, retirement) = {
            let mut admission = self
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned");
            self.background_tasks.get_by_owner(owner, task_id)?;
            let (had_observer_admission, _frame_lane) =
                self.close_task_frame_admission(&mut admission, task_id);
            let retirement = self.task_observer.prepare_retirement(task_id);
            admission.pause_for_test(TaskFrameAdmissionKind::Cancel);
            (had_observer_admission, retirement)
        };
        let retired_generation = retirement.retired_generation();
        retirement.fence();
        let snapshot = {
            let mut admission = self
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned");
            let snapshot = self.background_tasks.cancel_by_owner(owner, task_id);
            admission.finishing_tasks.remove(task_id);
            admission.discarding_tasks.remove(task_id);
            snapshot
        };
        if snapshot.is_none() {
            if let Some(generation) = retired_generation {
                self.task_observer
                    .complete_fenced_retirement(task_id, generation);
            }
        }
        if retired_generation.is_some() {
            self.append_event_for_turn_or_record_error(
                None,
                "task_observer.detached",
                json!({"task_id": bounded_chars(task_id, 128), "reason": "task_not_running"}),
            );
        }
        self.task_observer.cleanup_terminal(task_id);
        if !had_observer_admission {
            self.task_observer.release_closed_admission(task_id);
        }
        let snapshot = snapshot?;
        if snapshot.state == TaskState::Cancelling {
            match owner {
                TaskOwner::Main => self.append_task_updated_event(&snapshot),
                TaskOwner::Subagent { subagent_id } => {
                    self.append_subagent_event_for_id("subagent.callback", subagent_id);
                }
            }
        }
        Some(snapshot)
    }
}

impl InteractiveStdioBridge for ServiceInteractiveStdioBridge {
    fn register_stdin_writer(&self, writer: Arc<dyn TaskStdinWriter>) -> Result<(), String> {
        self.inner
            .background_tasks
            .register_stdin_writer(&self.task_id, writer)
            .map(|_| ())
    }

    fn handle_frame_events(&self, events: Vec<BotifiedFrameEvent>) {
        for event in events {
            self.inner
                .clone()
                .admit_and_enqueue_task_frame(&self.task_id, event);
        }
    }
}

fn next_task_send_id() -> String {
    let suffix = NEXT_TASK_SEND_ID_SUFFIX.fetch_add(1, Ordering::SeqCst);
    format!("s{suffix}")
}
