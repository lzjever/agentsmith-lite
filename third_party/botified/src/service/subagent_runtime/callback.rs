use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::agent_loop::{
    AcceptedInputEntry, AgentCommitError, InputSource, InputUrgency, QueuedInputMetadata,
};
use crate::formatting::bounded_chars;
use crate::subagents::{SubagentCallbackStatus, SubagentLifecycle, SubagentSnapshot};
use crate::tasks::TaskState;
use crate::timeline_store::TimelineStoreError;
use crate::types::ContentPart;

use super::super::event_persistence::record_non_session_accepted_input;
use super::super::input_enqueue::{
    complete_enqueue_preflight, emit_urgent_preemption, enqueue_preflight_locked,
    input_rejection_data, prepare_enqueue_persistence, publish_and_finalize_enqueue,
    record_session_prepared_enqueue, EnqueueInputAttempt, InputRejection,
};
use super::super::subagent_projection::{
    project_subagent_callback_metadata, subagent_event_data, subagent_status_summary,
};
use super::super::task_bridge::TaskFrameAdmissionGate;
use super::super::task_projection::xml_attr_escape;
use super::super::{
    input_kind_name, spawn_service_loop, FailedTransitionIntent, ServiceError, ServiceInner,
};
use super::SubagentEventAppendOutcome;
#[cfg(test)]
use super::SubagentTestHookKind;

pub(super) const SUBAGENT_CALLBACK_TEXT_CHARS: usize = 8 * 1024;

static NEXT_SUBAGENT_CALLBACK_EPOCH: AtomicU64 = AtomicU64::new(1);

pub(in crate::service) struct SubagentTextCallbackOutcome {
    pub(in crate::service) queued: bool,
    pub(in crate::service) persistence_error: Option<TimelineStoreError>,
}

pub(in crate::service) fn new_subagent_callback_epoch() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let ordinal = NEXT_SUBAGENT_CALLBACK_EPOCH.fetch_add(1, Ordering::Relaxed);
    format!("c{timestamp:x}{:x}{ordinal:x}", std::process::id())
}

#[derive(Clone, Copy, Default)]
pub(in crate::service) struct SubagentCallbackFacts<'a> {
    pub(in crate::service) task_id: Option<&'a str>,
    pub(in crate::service) semantic_id: Option<&'a str>,
    pub(in crate::service) task_message: Option<&'a str>,
}

pub(in crate::service) async fn enqueue_subagent_callback_input(
    inner: &Arc<ServiceInner>,
    facts: SubagentCallbackFacts<'_>,
    subagent_id: &str,
    callback_id: String,
    kind: &'static str,
    content: Vec<ContentPart>,
) -> Option<(
    SubagentSnapshot,
    String,
    Option<CancellationToken>,
    Option<SubagentEventAppendOutcome>,
)> {
    let origin_task_id = facts.task_id;
    let snapshot = inner.subagent_snapshot(subagent_id)?;
    let display = crate::tasks::subagent_work_display(
        &snapshot.id,
        Some(&snapshot.name),
        Some(&snapshot.purpose),
    );
    let metadata = subagent_callback_metadata(
        subagent_id,
        kind,
        facts.task_id,
        facts.semantic_id,
        facts.task_message,
        display.label.as_deref(),
        display.summary.as_deref(),
    );
    if !valid_subagent_callback_metadata(&metadata) {
        return None;
    }
    let _intake = inner.intake_gate.lock().await;
    let source = InputSource::SubagentCallback;
    let urgency = InputUrgency::Normal;
    if content.is_empty() {
        let (outcome, failure) = {
            let (data, turn_id) = {
                let state = inner.state.lock().expect("service state mutex poisoned");
                (
                    input_rejection_data(
                        InputRejection::new(
                            &callback_id,
                            &content,
                            source,
                            urgency,
                            "empty_message",
                            "message content must not be empty",
                            false,
                        )
                        .with_metadata(&metadata),
                        state.input_queue.len(),
                    ),
                    state.active_turn_id.clone(),
                )
            };
            let append_error = inner
                .try_append_event_for_turn(turn_id.as_deref(), "message.rejected", data)
                .map_err(FailedTransitionIntent::timeline)
                .and_then(|_| inner.try_append_service_status_for_current_state(turn_id.as_deref()))
                .err();
            let failure_reason = append_error
                .as_ref()
                .map(|error| error.service_error().to_string())
                .unwrap_or_else(|| ServiceError::EmptyMessage.to_string());
            (
                SubagentCallbackOutcome {
                    callback_id,
                    kind,
                    event_status: "failed",
                    callback_status: SubagentCallbackStatus::Failed,
                    failure_reason: Some(failure_reason),
                    start_cancel: None,
                },
                append_error,
            )
        };
        if let Some(failure) = failure {
            failure.transition(inner);
        }
        return record_subagent_callback_outcome(inner, subagent_id, outcome)
            .map(|(snapshot, status, start_cancel)| (snapshot, status, start_cancel, None));
    }

    let cursor_seq = inner.last_event_seq();
    let preflight_outcome = {
        let task_admission = origin_task_id.map(|_| {
            inner
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned")
        });
        if let (Some(task_id), Some(admission)) = (origin_task_id, task_admission.as_ref()) {
            if !subagent_task_callback_can_commit(inner, admission, task_id, kind) {
                return None;
            }
        }
        drop(task_admission);
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        let preflight = enqueue_preflight_locked(
            inner,
            &mut state,
            &callback_id,
            &content,
            source,
            urgency,
            Some(&metadata),
            None,
        );
        drop(state);
        complete_enqueue_preflight(inner, preflight).map(|attempt| {
            let (event_status, callback_status, failure_reason) =
                callback_status_for_enqueue_outcome(&attempt);
            (
                SubagentCallbackOutcome {
                    callback_id: callback_id.clone(),
                    kind,
                    event_status,
                    callback_status,
                    failure_reason,
                    start_cancel: attempt.start_cancel,
                },
                attempt.failure,
            )
        })
    };
    if let Some((outcome, failure)) = preflight_outcome {
        if let Some(failure) = failure {
            failure.transition(inner);
        }
        let task_admission = origin_task_id.map(|_| {
            inner
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned")
        });
        if let (Some(task_id), Some(admission)) = (origin_task_id, task_admission.as_ref()) {
            if !subagent_task_callback_can_commit(inner, admission, task_id, kind) {
                return None;
            }
        }
        drop(task_admission);
        let queued = record_subagent_callback_outcome(inner, subagent_id, outcome);
        let append = facts.task_id.and_then(|_| {
            queued.as_ref().map(|(snapshot, status, _)| {
                #[cfg(test)]
                inner.run_subagent_test_hook(SubagentTestHookKind::CallbackRecordBeforeAppend);
                inner.try_append_subagent_callback_event_if_current_open(
                    snapshot,
                    &callback_id,
                    kind,
                    status,
                    facts,
                )
            })
        });
        return queued
            .map(|(snapshot, status, start_cancel)| (snapshot, status, start_cancel, append));
    }

    let accepted = AcceptedInputEntry {
        message_id: callback_id.clone(),
        content,
        cursor_seq,
        source,
        metadata: Some(metadata),
        urgency,
    };

    let mut persistence = match prepare_enqueue_persistence(inner, accepted.clone()) {
        Ok(persistence) => persistence,
        Err(error) => {
            let queued = record_subagent_callback_outcome(
                inner,
                subagent_id,
                SubagentCallbackOutcome {
                    callback_id: callback_id.clone(),
                    kind,
                    event_status: "failed",
                    callback_status: SubagentCallbackStatus::Failed,
                    failure_reason: Some(error.to_string()),
                    start_cancel: None,
                },
            );
            let append = facts.task_id.and_then(|_| {
                queued.as_ref().map(|(snapshot, status, _)| {
                    inner.try_append_subagent_callback_event_if_current_open(
                        snapshot,
                        &callback_id,
                        kind,
                        status,
                        facts,
                    )
                })
            });
            return queued
                .map(|(snapshot, status, start_cancel)| (snapshot, status, start_cancel, append));
        }
    };

    #[cfg(test)]
    inner.run_subagent_test_hook(SubagentTestHookKind::CallbackEnqueueBeforeRecord);

    let can_record = {
        let task_admission = origin_task_id.map(|_| {
            inner
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned")
        });
        let task_can_commit = match (origin_task_id, task_admission.as_ref()) {
            (Some(task_id), Some(admission)) => {
                subagent_task_callback_can_commit(inner, admission, task_id, kind)
            }
            _ => true,
        };
        drop(task_admission);
        task_can_commit
            && inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned")
                .snapshot(subagent_id)
                .is_some_and(|snapshot| snapshot.lifecycle != SubagentLifecycle::Cancelled)
    };
    if !can_record && inner.session_recorder.is_some() {
        return None;
    }

    let accepted_was_recorded_before_enqueue = match if inner.session_recorder.is_some() {
        record_session_prepared_enqueue(inner, &persistence)
    } else {
        record_non_session_accepted_input(inner, &accepted).await
    } {
        Ok(recorded) => recorded,
        Err(error) => {
            let task_admission = origin_task_id.map(|_| {
                inner
                    .task_frame_admission_gate
                    .lock()
                    .expect("task frame admission gate mutex poisoned")
            });
            if let (Some(task_id), Some(admission)) = (origin_task_id, task_admission.as_ref()) {
                if !subagent_task_callback_can_commit(inner, admission, task_id, kind) {
                    return None;
                }
            }
            drop(task_admission);
            let queued = record_subagent_callback_outcome(
                inner,
                subagent_id,
                SubagentCallbackOutcome {
                    callback_id: callback_id.clone(),
                    kind,
                    event_status: "failed",
                    callback_status: SubagentCallbackStatus::Failed,
                    failure_reason: Some(error.to_string()),
                    start_cancel: None,
                },
            );
            let append = facts.task_id.and_then(|_| {
                queued.as_ref().map(|(snapshot, status, _)| {
                    #[cfg(test)]
                    inner.run_subagent_test_hook(SubagentTestHookKind::CallbackRecordBeforeAppend);
                    inner.try_append_subagent_callback_event_if_current_open(
                        snapshot,
                        &callback_id,
                        kind,
                        status,
                        facts,
                    )
                })
            });
            return queued
                .map(|(snapshot, status, start_cancel)| (snapshot, status, start_cancel, append));
        }
    };

    let accepted_for_tombstone = if accepted_was_recorded_before_enqueue {
        Some(accepted.clone())
    } else {
        None
    };

    let (queued, append) = {
        let task_admission = origin_task_id.map(|_| {
            inner
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned")
        });
        let task_can_commit = match (origin_task_id, task_admission.as_ref()) {
            (Some(task_id), Some(admission)) => {
                subagent_task_callback_can_commit(inner, admission, task_id, kind)
            }
            _ => true,
        };
        drop(task_admission);
        let mut queued = if !task_can_commit {
            None
        } else {
            let _lifecycle = inner
                .subagent_lifecycle
                .lock()
                .expect("subagent lifecycle mutex poisoned");
            if inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned")
                .snapshot(subagent_id)
                .map(|snapshot| snapshot.lifecycle == SubagentLifecycle::Cancelled)
                .unwrap_or(true)
            {
                None
            } else {
                let mut attempt = publish_and_finalize_enqueue(inner, &mut persistence);
                let preemption_to_emit = attempt.preemption.take();
                if let Some(preemption) = preemption_to_emit {
                    emit_urgent_preemption(inner, preemption);
                }
                let (event_status, callback_status, failure_reason) =
                    callback_status_for_enqueue_outcome(&attempt);
                record_subagent_callback_outcome_locked(
                    inner,
                    subagent_id,
                    SubagentCallbackOutcome {
                        callback_id: callback_id.clone(),
                        kind,
                        event_status,
                        callback_status,
                        failure_reason,
                        start_cancel: attempt.start_cancel,
                    },
                )
            }
        };
        let append = facts.task_id.and_then(|_| {
            queued.as_ref().map(|(snapshot, status, _)| {
                #[cfg(test)]
                inner.run_subagent_test_hook(SubagentTestHookKind::CallbackRecordBeforeAppend);
                inner.try_append_subagent_callback_event_if_current_open(
                    snapshot,
                    &callback_id,
                    kind,
                    status,
                    facts,
                )
            })
        });
        if origin_task_id.is_some() {
            if let Some((_, _, start_cancel)) = queued.as_mut() {
                if let Some(cancel) = start_cancel.take() {
                    spawn_service_loop(inner.clone(), cancel);
                }
            }
        }
        (queued, append)
    };
    if queued.is_none() {
        if let Some(accepted_for_tombstone) = accepted_for_tombstone.as_ref() {
            let _ = record_subagent_callback_pending_removed(
                inner,
                accepted_for_tombstone,
                "subagent_cancelled",
            )
            .await;
        }
    }
    queued.map(|(snapshot, status, start_cancel)| (snapshot, status, start_cancel, append))
}

fn subagent_task_callback_can_commit(
    inner: &ServiceInner,
    admission: &TaskFrameAdmissionGate,
    task_id: &str,
    kind: &str,
) -> bool {
    if inner.is_failed_or_shutting_down() || !admission.task_can_commit(task_id) {
        return false;
    }
    inner
        .background_tasks
        .get(task_id)
        .is_some_and(|task| match kind {
            "task_ask" | "task_tell" => task.state == TaskState::Running,
            "task_completed" => task.state == TaskState::Completed,
            "task_failed" => task.state == TaskState::Failed,
            "task_timed_out" => task.state == TaskState::TimedOut,
            "task_cancelled" => matches!(task.state, TaskState::Cancelled | TaskState::Cancelling),
            "task_lost" => task.state == TaskState::Lost,
            _ => false,
        })
}

pub(in crate::service) fn valid_subagent_callback_metadata(metadata: &QueuedInputMetadata) -> bool {
    let QueuedInputMetadata::SubagentCallback {
        kind,
        task_id,
        ask_id,
        tell_id,
        ..
    } = metadata
    else {
        return false;
    };
    match kind.as_str() {
        "task_ask" => task_id.is_some() && ask_id.is_some() && tell_id.is_none(),
        "task_tell" => task_id.is_some() && ask_id.is_none() && tell_id.is_some(),
        "task_completed" | "task_failed" | "task_timed_out" | "task_cancelled" | "task_lost" => {
            task_id.is_some() && ask_id.is_none() && tell_id.is_none()
        }
        "completed" | "failed" => task_id.is_none() && ask_id.is_none() && tell_id.is_none(),
        _ => false,
    }
}

fn subagent_callback_metadata(
    subagent_id: &str,
    kind: &str,
    task_id: Option<&str>,
    semantic_id: Option<&str>,
    task_message: Option<&str>,
    label: Option<&str>,
    summary: Option<&str>,
) -> QueuedInputMetadata {
    QueuedInputMetadata::SubagentCallback {
        subagent_id: subagent_id.to_owned(),
        kind: kind.to_owned(),
        task_id: task_id.map(str::to_owned),
        ask_id: (kind == "task_ask")
            .then(|| semantic_id.map(str::to_owned))
            .flatten(),
        tell_id: (kind == "task_tell")
            .then(|| semantic_id.map(str::to_owned))
            .flatten(),
        task_message: task_message.map(|value| bounded_chars(value, 512)),
        label: label.map(str::to_owned),
        summary: summary.map(str::to_owned),
    }
}

async fn record_subagent_callback_pending_removed(
    inner: &ServiceInner,
    accepted: &AcceptedInputEntry,
    reason: &str,
) -> Result<(), AgentCommitError> {
    let Some(recorder) = inner.recorder.as_ref() else {
        return Ok(());
    };
    if let Err(error) = recorder
        .record_pending_input_removed(
            &accepted.message_id,
            accepted.source,
            accepted.metadata.as_ref(),
            reason,
        )
        .await
    {
        let cloned = error.clone();
        append_subagent_callback_pending_removal_failed(inner, accepted, reason, error);
        return Err(cloned);
    }
    Ok(())
}

fn append_subagent_callback_pending_removal_failed(
    inner: &ServiceInner,
    accepted: &AcceptedInputEntry,
    reason: &str,
    error: AgentCommitError,
) {
    let error_message = error.to_string();
    inner.transition_to_failed(
        format!("failed to persist subagent callback pending removal: {error_message}"),
        |state| {
            let turn_id = state.active_turn_id.clone();
            let _ = inner.try_append_event_for_turn(
                turn_id.as_deref(),
                "subagent.callback_pending_removal_failed",
                json!({
                    "message_id": accepted.message_id,
                    "input_id": accepted.message_id,
                    "input_kind": input_kind_name(accepted.source),
                    "source": accepted.source.as_str(),
                    "reason": reason,
                    "error": {
                        "code": "pending_removal_persistence_failed",
                        "message": error_message,
                        "retryable": true
                    }
                }),
            );
            let turn_id = state.active_turn_id.clone();
            let _ = inner.try_append_service_status_event_for_locked(state, turn_id.as_deref());
        },
    );
}

fn callback_status_for_enqueue_outcome(
    attempt: &EnqueueInputAttempt,
) -> (&'static str, SubagentCallbackStatus, Option<String>) {
    match &attempt.outcome {
        Ok(_) => ("queued", SubagentCallbackStatus::Pending, None),
        Err(ServiceError::QueueFull) => (
            "queue_full",
            SubagentCallbackStatus::Failed,
            Some("queue_full".to_owned()),
        ),
        Err(error) => (
            "failed",
            SubagentCallbackStatus::Failed,
            Some(error.to_string()),
        ),
    }
}

struct SubagentCallbackOutcome {
    callback_id: String,
    kind: &'static str,
    event_status: &'static str,
    callback_status: SubagentCallbackStatus,
    failure_reason: Option<String>,
    start_cancel: Option<CancellationToken>,
}

fn record_subagent_callback_outcome(
    inner: &ServiceInner,
    subagent_id: &str,
    outcome: SubagentCallbackOutcome,
) -> Option<(SubagentSnapshot, String, Option<CancellationToken>)> {
    #[cfg(test)]
    inner.run_subagent_test_hook(SubagentTestHookKind::CallbackOutcomeBeforeLifecycle);

    let _lifecycle = inner
        .subagent_lifecycle
        .lock()
        .expect("subagent lifecycle mutex poisoned");
    record_subagent_callback_outcome_locked(inner, subagent_id, outcome)
}

fn record_subagent_callback_outcome_locked(
    inner: &ServiceInner,
    subagent_id: &str,
    outcome: SubagentCallbackOutcome,
) -> Option<(SubagentSnapshot, String, Option<CancellationToken>)> {
    let mut manager = inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned");
    if manager
        .snapshot(subagent_id)
        .map(|snapshot| snapshot.lifecycle == SubagentLifecycle::Cancelled)
        .unwrap_or(true)
    {
        return None;
    }
    let snapshot = manager
        .record_callback(
            subagent_id,
            outcome.callback_id,
            outcome.kind,
            outcome.callback_status,
            outcome.failure_reason,
        )
        .ok()?;
    Some((
        snapshot,
        outcome.event_status.to_owned(),
        outcome.start_cancel,
    ))
}

impl ServiceInner {
    fn append_subagent_callback_event_if_current_open(
        &self,
        snapshot: &SubagentSnapshot,
        callback_id: &str,
        kind: &'static str,
        status: &str,
        facts: SubagentCallbackFacts<'_>,
    ) -> bool {
        let _lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let Some(current) = self.open_subagent_snapshot(&snapshot.id) else {
            return false;
        };
        let mut data = subagent_event_data(&current);
        let display = crate::tasks::subagent_work_display(
            &current.id,
            Some(&current.name),
            Some(&current.purpose),
        );
        let metadata = subagent_callback_metadata(
            &current.id,
            kind,
            facts.task_id,
            facts.semantic_id,
            facts.task_message,
            display.label.as_deref(),
            display.summary.as_deref(),
        );
        project_subagent_callback_metadata(&mut data, callback_id, &metadata, status);
        let mut outcome = self.try_append_subagent_event_outcome("subagent.callback", data);
        if let Some(error) = outcome.persistence_error.take() {
            self.record_timeline_persistence_error(error);
        }
        outcome.complete()
    }

    fn try_append_subagent_callback_event_if_current_open(
        &self,
        snapshot: &SubagentSnapshot,
        callback_id: &str,
        kind: &'static str,
        status: &str,
        facts: SubagentCallbackFacts<'_>,
    ) -> SubagentEventAppendOutcome {
        let _lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let Some(current) = self.open_subagent_snapshot(&snapshot.id) else {
            return SubagentEventAppendOutcome {
                event_written: false,
                status_written: false,
                persistence_error: None,
            };
        };
        let mut data = subagent_event_data(&current);
        let display = crate::tasks::subagent_work_display(
            &current.id,
            Some(&current.name),
            Some(&current.purpose),
        );
        let metadata = subagent_callback_metadata(
            &current.id,
            kind,
            facts.task_id,
            facts.semantic_id,
            facts.task_message,
            display.label.as_deref(),
            display.summary.as_deref(),
        );
        project_subagent_callback_metadata(&mut data, callback_id, &metadata, status);
        self.try_append_subagent_event_outcome("subagent.callback", data)
    }

    fn next_subagent_callback_id(&self) -> String {
        let seq = self
            .next_subagent_callback_seq
            .fetch_add(1, Ordering::Relaxed);
        format!("subagent_callback_{}_{}", self.subagent_callback_epoch, seq)
    }
}

pub(in crate::service) async fn enqueue_subagent_callback(
    inner: Arc<ServiceInner>,
    snapshot: &SubagentSnapshot,
    kind: &'static str,
) {
    if snapshot.lifecycle == SubagentLifecycle::Cancelled {
        return;
    }
    if inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(&snapshot.id)
        .is_some_and(|snapshot| snapshot.lifecycle == SubagentLifecycle::Cancelled)
    {
        return;
    }
    let callback_id = inner.next_subagent_callback_id();
    let callback_message = snapshot
        .latest_result
        .as_deref()
        .or(snapshot.latest_error.as_deref())
        .unwrap_or_else(|| subagent_status_summary(snapshot));
    let content = vec![ContentPart::text(subagent_callback_body(
        snapshot,
        &callback_id,
        kind,
    ))];
    let Some((snapshot, status, start_cancel, _)) = enqueue_subagent_callback_input(
        &inner,
        SubagentCallbackFacts {
            task_message: Some(callback_message),
            ..SubagentCallbackFacts::default()
        },
        &snapshot.id,
        callback_id.clone(),
        kind,
        content,
    )
    .await
    else {
        return;
    };
    #[cfg(test)]
    inner.run_subagent_test_hook(SubagentTestHookKind::CallbackRecordBeforeAppend);
    if !inner.append_subagent_callback_event_if_current_open(
        &snapshot,
        &callback_id,
        kind,
        &status,
        SubagentCallbackFacts {
            task_message: Some(callback_message),
            ..SubagentCallbackFacts::default()
        },
    ) {
        let display = crate::tasks::subagent_work_display(
            &snapshot.id,
            Some(&snapshot.name),
            Some(&snapshot.purpose),
        );
        let metadata = subagent_callback_metadata(
            &snapshot.id,
            kind,
            None,
            None,
            Some(callback_message),
            display.label.as_deref(),
            display.summary.as_deref(),
        );
        rollback_enqueued_subagent_callback(inner.as_ref(), &callback_id, &metadata).await;
        if let Some(cancel) = start_cancel {
            cancel.cancel();
        }
        inner.cancel_active_turn_if_failed();
        inner.notify.notify_waiters();
        return;
    }
    inner.notify.notify_waiters();
    if let Some(cancel) = start_cancel {
        spawn_service_loop(inner, cancel);
    }
}

pub(in crate::service) async fn enqueue_subagent_text_callback(
    inner: Arc<ServiceInner>,
    origin_task_id: Option<&str>,
    subagent_id: &str,
    kind: &'static str,
    semantic_id: Option<&str>,
    task_message: Option<&str>,
    text: String,
) -> SubagentTextCallbackOutcome {
    let snapshot = inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(subagent_id);
    let Some(snapshot) = snapshot else {
        return SubagentTextCallbackOutcome {
            queued: false,
            persistence_error: None,
        };
    };
    if snapshot.lifecycle == SubagentLifecycle::Cancelled {
        return SubagentTextCallbackOutcome {
            queued: false,
            persistence_error: None,
        };
    }
    let callback_id = inner.next_subagent_callback_id();
    let display = crate::tasks::subagent_work_display(
        &snapshot.id,
        Some(&snapshot.name),
        Some(&snapshot.purpose),
    );
    let body = format!(
        "<subagent_callback subagent_id=\"{}\" callback_id=\"{}\" kind=\"{}\" status=\"{}\" label=\"{}\" summary=\"{}\">\n{}\n</subagent_callback>",
        xml_attr_escape(&snapshot.id),
        xml_attr_escape(&callback_id),
        kind,
        subagent_status_summary(&snapshot),
        xml_attr_escape(display.label.as_deref().unwrap_or("")),
        xml_attr_escape(display.summary.as_deref().unwrap_or("")),
        bounded_chars(&text, SUBAGENT_CALLBACK_TEXT_CHARS)
    );
    let Some((snapshot, status, start_cancel, committed_append)) = enqueue_subagent_callback_input(
        &inner,
        SubagentCallbackFacts {
            task_id: origin_task_id,
            semantic_id,
            task_message,
        },
        &snapshot.id,
        callback_id.clone(),
        kind,
        vec![ContentPart::text(body)],
    )
    .await
    else {
        return SubagentTextCallbackOutcome {
            queued: false,
            persistence_error: None,
        };
    };
    let append = committed_append.unwrap_or_else(|| {
        #[cfg(test)]
        inner.run_subagent_test_hook(SubagentTestHookKind::CallbackRecordBeforeAppend);
        inner.try_append_subagent_callback_event_if_current_open(
            &snapshot,
            &callback_id,
            kind,
            &status,
            SubagentCallbackFacts {
                task_id: origin_task_id,
                semantic_id,
                task_message,
            },
        )
    });
    if !append.complete() {
        let metadata = subagent_callback_metadata(
            subagent_id,
            kind,
            origin_task_id,
            semantic_id,
            task_message,
            display.label.as_deref(),
            display.summary.as_deref(),
        );
        rollback_enqueued_subagent_callback(inner.as_ref(), &callback_id, &metadata).await;
        if let Some(cancel) = start_cancel {
            cancel.cancel();
        }
        inner.notify.notify_waiters();
        return SubagentTextCallbackOutcome {
            queued: false,
            persistence_error: append.persistence_error,
        };
    }
    inner.notify.notify_waiters();
    if let Some(cancel) = start_cancel {
        spawn_service_loop(inner, cancel);
    }
    SubagentTextCallbackOutcome {
        queued: status == "queued",
        persistence_error: None,
    }
}

pub(in crate::service) async fn rollback_enqueued_subagent_callback(
    inner: &ServiceInner,
    callback_id: &str,
    metadata: &QueuedInputMetadata,
) {
    let QueuedInputMetadata::SubagentCallback { subagent_id, .. } = metadata else {
        return;
    };
    if !valid_subagent_callback_metadata(metadata) {
        return;
    }
    let accepted = AcceptedInputEntry {
        message_id: callback_id.to_owned(),
        content: Vec::new(),
        cursor_seq: inner.last_event_seq(),
        source: InputSource::SubagentCallback,
        metadata: Some(metadata.clone()),
        urgency: InputUrgency::Normal,
    };
    if record_subagent_callback_pending_removed(inner, &accepted, "subagent_callback_audit_failed")
        .await
        .is_err()
    {
        return;
    }
    {
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        state.input_queue.remove_message(callback_id);
        state.message_index.remove(callback_id);
        state.durable_message_replays.remove(callback_id);
    }
    let _ = inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .rollback_pending_callback(subagent_id, callback_id);
}

fn subagent_callback_body(
    snapshot: &SubagentSnapshot,
    callback_id: &str,
    kind: &'static str,
) -> String {
    let status = subagent_status_summary(snapshot);
    let body = snapshot
        .latest_result
        .as_deref()
        .or(snapshot.latest_error.as_deref())
        .unwrap_or(status);
    let display = crate::tasks::subagent_work_display(
        &snapshot.id,
        Some(&snapshot.name),
        Some(&snapshot.purpose),
    );
    format!(
        "<subagent_callback subagent_id=\"{}\" callback_id=\"{}\" kind=\"{}\" status=\"{}\" label=\"{}\" summary=\"{}\">\n{}\n</subagent_callback>",
        xml_attr_escape(&snapshot.id),
        xml_attr_escape(callback_id),
        kind,
        status,
        xml_attr_escape(display.label.as_deref().unwrap_or("")),
        xml_attr_escape(display.summary.as_deref().unwrap_or("")),
        bounded_chars(body, SUBAGENT_CALLBACK_TEXT_CHARS)
    )
}
