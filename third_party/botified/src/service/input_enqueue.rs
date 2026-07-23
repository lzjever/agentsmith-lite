use super::ContextMaintenanceStatus;
use super::*;

pub(super) struct EnqueueInputAttempt {
    pub(super) outcome: Result<EnqueueOutcome, ServiceError>,
    pub(super) start_cancel: Option<CancellationToken>,
    pub(super) preemption: Option<AcceptedInputPreemption>,
    pub(super) failure: Option<FailedTransitionIntent>,
}

pub(super) enum EnqueuePreflight {
    Continue,
    Complete(EnqueueInputAttempt),
    Reject {
        data: Value,
        turn_id: Option<String>,
        error: ServiceError,
        queue_pressure: bool,
        failed_with_pending: bool,
    },
}

#[derive(Debug, Clone)]
pub(super) struct AcceptedInputPreemption {
    cancel: CancellationToken,
    turn_id: Option<String>,
    input_id: String,
    source: InputSource,
    urgency: InputUrgency,
}

struct PreparedEnqueue {
    accepted: AcceptedInputEntry,
    delivery: Option<MessageDelivery>,
    accepted_input_already_durable: bool,
    submit_status: EnqueueSubmitStatus,
    turn_id: Option<String>,
    start_cancel: Option<CancellationToken>,
    planned_state: ServiceState,
    planned_queue_length: usize,
    summary: InputContentSummary,
    input_text: Option<String>,
    preemption: Option<AcceptedInputPreemption>,
}

pub(super) struct EnqueuePersistence {
    prepared: Option<PreparedEnqueue>,
    _worker: ServiceWorkerGuard,
}

struct PublishedEnqueue {
    accepted_cursor: EventCursor,
    outcome_cursor: EventCursor,
}

impl EnqueueInputAttempt {
    fn accepted(
        outcome: EnqueueOutcome,
        start_cancel: Option<CancellationToken>,
        preemption: Option<AcceptedInputPreemption>,
    ) -> Self {
        Self {
            outcome: Ok(outcome),
            start_cancel,
            preemption,
            failure: None,
        }
    }

    pub(super) fn rejected(error: ServiceError, start_cancel: Option<CancellationToken>) -> Self {
        Self {
            outcome: Err(error),
            start_cancel,
            preemption: None,
            failure: None,
        }
    }

    fn failed_transition(failure: FailedTransitionIntent) -> Self {
        Self {
            outcome: Err(failure.service_error()),
            start_cancel: None,
            preemption: None,
            failure: Some(failure),
        }
    }

    fn consume_failure(mut self, inner: &ServiceInner) -> Self {
        if let Some(failure) = self.failure.take() {
            failure.transition(inner);
        }
        self
    }
}

pub(super) fn enqueue_preflight_locked(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
    message_id: &str,
    content: &[ContentPart],
    source: InputSource,
    urgency: InputUrgency,
    metadata: Option<&QueuedInputMetadata>,
    delivery: Option<&MessageDelivery>,
) -> EnqueuePreflight {
    if let Some(message) = inner
        .configuration_error
        .lock()
        .expect("service configuration error mutex poisoned")
        .clone()
    {
        return EnqueuePreflight::Complete(EnqueueInputAttempt::rejected(
            ServiceError::Configuration { message },
            None,
        ));
    }
    if let Some(entry) = state.message_index.get(message_id) {
        if entry.content == content && entry.delivery.as_ref() == delivery {
            if entry.delivery.is_some()
                && entry.projection_state == MessageProjectionState::MissingProjection
            {
                return EnqueuePreflight::Continue;
            }
            return EnqueuePreflight::Complete(EnqueueInputAttempt::accepted(
                duplicate_outcome(inner, state, entry.cursor.clone()),
                None,
                None,
            ));
        }
        let message = format!("message id {message_id} was already used with different content");
        let mut rejection = InputRejection::new(
            message_id,
            content,
            source,
            urgency,
            "message_conflict",
            message,
            false,
        );
        if let Some(metadata) = metadata {
            rejection = rejection.with_metadata(metadata);
        }
        return EnqueuePreflight::Reject {
            data: input_rejection_data(rejection, state.input_queue.len()),
            turn_id: state.active_turn_id.clone(),
            error: ServiceError::MessageConflict {
                message_id: message_id.to_owned(),
            },
            queue_pressure: false,
            failed_with_pending: false,
        };
    }
    if state.state == ServiceState::ShuttingDown {
        let mut rejection = InputRejection::new(
            message_id,
            content,
            source,
            urgency,
            "service_shutting_down",
            "service is shutting down",
            false,
        );
        if let Some(metadata) = metadata {
            rejection = rejection.with_metadata(metadata);
        }
        return EnqueuePreflight::Reject {
            data: input_rejection_data(rejection, state.input_queue.len()),
            turn_id: state.active_turn_id.clone(),
            error: ServiceError::ShuttingDown,
            queue_pressure: false,
            failed_with_pending: false,
        };
    }
    if state.state == ServiceState::Failed && !InputSource::is_user(&source) {
        return EnqueuePreflight::Complete(EnqueueInputAttempt::rejected(
            ServiceError::ShuttingDown,
            None,
        ));
    }
    if state.input_queue.len() >= inner.limits.max_queue_messages
        || state
            .input_queue
            .bytes_with_new_message_exceeds_limit(content, inner.limits.max_queue_bytes)
    {
        let mut rejection = InputRejection::new(
            message_id,
            content,
            source,
            urgency,
            "queue_full",
            "message queue is full",
            true,
        );
        if let Some(metadata) = metadata {
            rejection = rejection.with_metadata(metadata);
        }
        return EnqueuePreflight::Reject {
            data: input_rejection_data(rejection, state.input_queue.len()),
            turn_id: state.active_turn_id.clone(),
            error: ServiceError::QueueFull,
            queue_pressure: true,
            failed_with_pending: state.state == ServiceState::Failed
                && (!state.input_queue.is_empty() || state.restart_boundary.is_some()),
        };
    }
    EnqueuePreflight::Continue
}

pub(super) fn complete_enqueue_preflight(
    inner: &ServiceInner,
    preflight: EnqueuePreflight,
) -> Option<EnqueueInputAttempt> {
    let (data, turn_id, error, queue_pressure, failed_with_pending) = match preflight {
        EnqueuePreflight::Continue => return None,
        EnqueuePreflight::Complete(attempt) => return Some(attempt),
        EnqueuePreflight::Reject {
            data,
            turn_id,
            error,
            queue_pressure,
            failed_with_pending,
        } => (data, turn_id, error, queue_pressure, failed_with_pending),
    };

    if let Err(error) =
        inner.try_append_event_for_turn(turn_id.as_deref(), "message.rejected", data)
    {
        return Some(EnqueueInputAttempt::failed_transition(
            FailedTransitionIntent::timeline(error),
        ));
    }
    if queue_pressure {
        let queue_length = inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .input_queue
            .len();
        if let Err(error) = inner.try_append_event_for_turn(
            turn_id.as_deref(),
            "queue.pressure",
            json!({
                "queue_length": queue_length,
                "max_queue_messages": inner.limits.max_queue_messages,
                "max_queue_bytes": inner.limits.max_queue_bytes,
                "input_rejected": true,
                "error": {
                    "code": "queue_full",
                    "message": "message queue is full",
                    "retryable": true
                }
            }),
        ) {
            return Some(EnqueueInputAttempt::failed_transition(
                FailedTransitionIntent::timeline(error),
            ));
        }
    }

    let start_cancel = if failed_with_pending {
        let outcome = {
            let mut state = inner.state.lock().expect("service state mutex poisoned");
            start_pending_locked(inner, &mut state)
        };
        let outcome = publish_start_pending_status(inner, outcome);
        if let Some(failure) = outcome.failure {
            return Some(EnqueueInputAttempt::failed_transition(failure));
        }
        outcome.start_cancel
    } else {
        if let Err(failure) = inner.try_append_service_status_for_current_state(turn_id.as_deref())
        {
            return Some(EnqueueInputAttempt::failed_transition(failure));
        }
        None
    };
    Some(EnqueueInputAttempt::rejected(error, start_cancel))
}

pub(super) async fn enqueue_input_inner(
    inner: &ServiceInner,
    message_id: String,
    content: Vec<ContentPart>,
    source: InputSource,
    urgency: InputUrgency,
    metadata: Option<QueuedInputMetadata>,
) -> EnqueueInputAttempt {
    enqueue_input_inner_with_failure(inner, message_id, content, source, urgency, metadata)
        .await
        .consume_failure(inner)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn enqueue_task_input_inner(
    inner: &Arc<ServiceInner>,
    task_id: &str,
    message_id: String,
    content: Vec<ContentPart>,
    source: InputSource,
    urgency: InputUrgency,
    metadata: Option<QueuedInputMetadata>,
    final_commit: impl FnOnce() -> Result<(), FailedTransitionIntent>,
) -> EnqueueInputAttempt {
    debug_assert!(!InputSource::is_user(&source));
    if !valid_input_metadata(source, metadata.as_ref()) {
        return EnqueueInputAttempt::rejected(
            ServiceError::Persistence {
                message: "input source and metadata do not match".to_owned(),
            },
            None,
        );
    }
    let _intake = inner.intake_gate.lock().await;
    let cursor_seq = inner.last_event_seq();

    let preflight = {
        let admission = inner
            .task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned");
        if inner.is_failed_or_shutting_down()
            || !admission.task_can_commit(task_id)
            || !inner
                .background_tasks
                .get(task_id)
                .is_some_and(|task| task.state == TaskState::Running)
        {
            return EnqueueInputAttempt::rejected(ServiceError::ShuttingDown, None);
        }
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        enqueue_preflight_locked(
            inner,
            &mut state,
            &message_id,
            &content,
            source,
            urgency,
            metadata.as_ref(),
            None,
        )
    };
    if let Some(attempt) = complete_enqueue_preflight(inner, preflight) {
        return attempt.consume_failure(inner);
    }

    let accepted = AcceptedInputEntry {
        message_id,
        content,
        cursor_seq,
        source,
        metadata,
        urgency,
    };
    let mut persistence = {
        let admission = inner
            .task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned");
        admission.pause_for_test(TaskFrameAdmissionKind::TaskInputPersistence);
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        if matches!(
            state.state,
            ServiceState::Failed | ServiceState::ShuttingDown
        ) || !admission.task_can_commit(task_id)
            || !inner
                .background_tasks
                .get(task_id)
                .is_some_and(|task| task.state == TaskState::Running)
        {
            return EnqueueInputAttempt::rejected(ServiceError::ShuttingDown, None);
        }
        match prepare_enqueue_persistence_locked(inner, &mut state, accepted.clone(), None) {
            Ok(prepared) => EnqueuePersistence {
                prepared: Some(prepared),
                _worker: ServiceWorkerGuard {
                    inner: Arc::downgrade(inner),
                    kind: ServiceWorkerKind::InputPersistence,
                },
            },
            Err(error) => return EnqueueInputAttempt::rejected(error, None),
        }
    };

    let accepted_was_recorded = if inner.session_recorder.is_some() {
        false
    } else {
        match record_non_session_accepted_input(inner, &accepted).await {
            Ok(recorded) => recorded,
            Err(error) => {
                inner.mark_failed(error.to_string());
                return EnqueueInputAttempt::rejected(error, None);
            }
        }
    };

    inner.pause_before_task_frame_commit_for_test(TaskFrameAdmissionKind::TaskInputBeforeFinal);
    let mut failure = None;
    let mut committed = false;
    let attempt = {
        let accepted_undo = inner
            .session_recorder
            .as_ref()
            .map(|recorder| {
                recorder
                    .record_accepted_input_with_undo_sync(&accepted)
                    .map_err(|error| ServiceError::Persistence {
                        message: error.to_string(),
                    })
            })
            .transpose()
            .inspect_err(|error| {
                failure = Some(FailedTransitionIntent {
                    message: error.to_string(),
                    clear_active_turn: false,
                });
            });
        match accepted_undo {
            Err(error) => EnqueueInputAttempt::rejected(error, None),
            Ok(accepted_undo) => {
                let can_commit = {
                    let admission = inner
                        .task_frame_admission_gate
                        .lock()
                        .expect("task frame admission gate mutex poisoned");
                    admission.pause_for_test(TaskFrameAdmissionKind::TaskInputFinal);
                    !inner.is_failed_or_shutting_down()
                        && admission.task_can_commit(task_id)
                        && inner
                            .background_tasks
                            .get(task_id)
                            .is_some_and(|task| task.state == TaskState::Running)
                };
                if !can_commit {
                    if let Err(error) = rollback_or_retire_session_accepted_input(
                        inner,
                        &accepted,
                        accepted_undo,
                        "task_commit_fenced",
                    ) {
                        failure = Some(FailedTransitionIntent {
                            message: error.to_string(),
                            clear_active_turn: false,
                        });
                        EnqueueInputAttempt::rejected(error, None)
                    } else {
                        EnqueueInputAttempt::rejected(ServiceError::ShuttingDown, None)
                    }
                } else if let Err(intent) = final_commit() {
                    failure = Some(intent);
                    let rollback_error = rollback_or_retire_session_accepted_input(
                        inner,
                        &accepted,
                        accepted_undo,
                        "task_final_commit_failed",
                    )
                    .err();
                    EnqueueInputAttempt::rejected(
                        ServiceError::Persistence {
                            message: rollback_error.map_or_else(
                                || "task input final commit failed".to_owned(),
                                |error| format!(
                                    "task input final commit failed; session accepted rollback failed: {error}"
                                ),
                            ),
                        },
                        None,
                    )
                } else {
                    committed = true;
                    if let Some(undo) = accepted_undo {
                        undo.commit();
                    }
                    let mut attempt = publish_and_finalize_enqueue(inner, &mut persistence);
                    if let Err(error) = &attempt.outcome {
                        failure = Some(FailedTransitionIntent {
                            message: error.to_string(),
                            clear_active_turn: false,
                        });
                    }
                    if let Some(cancel) = attempt.start_cancel.take() {
                        spawn_service_loop(inner.clone(), cancel);
                    }
                    if let Some(preemption) = attempt.preemption.take() {
                        emit_urgent_preemption(inner, preemption);
                    }
                    attempt
                }
            }
        }
    };
    drop(persistence);

    if let Some(failure) = failure {
        failure.transition(inner);
    }

    if accepted_was_recorded && !committed && attempt.outcome.is_err() {
        if let Some(recorder) = inner.recorder.as_ref() {
            if let Err(error) = recorder
                .record_pending_input_removed(
                    &accepted.message_id,
                    accepted.source,
                    accepted.metadata.as_ref(),
                    "task_commit_fenced",
                )
                .await
            {
                inner.mark_failed(format!(
                    "failed to retire fenced task input preparation: {error}"
                ));
            }
        }
    }
    attempt
}

fn rollback_or_retire_session_accepted_input(
    inner: &ServiceInner,
    accepted: &AcceptedInputEntry,
    undo: Option<crate::session::AcceptedInputUndo<'_>>,
    reason: &str,
) -> Result<(), ServiceError> {
    let Some(undo) = undo else {
        return Ok(());
    };
    let Err(rollback_error) = undo.rollback() else {
        return Ok(());
    };
    let recorder = inner
        .session_recorder
        .as_ref()
        .expect("session accepted input undo should retain its recorder");
    recorder
        .record_pending_input_removed_sync(
            &accepted.message_id,
            accepted.source,
            accepted.metadata.clone(),
            reason,
        )
        .map_err(|retirement_error| ServiceError::Persistence {
            message: format!(
                "session accepted rollback failed: {rollback_error}; failed to persist pending input removal: {retirement_error}"
            ),
        })
}

pub(super) async fn enqueue_input_inner_with_failure(
    inner: &ServiceInner,
    message_id: String,
    content: Vec<ContentPart>,
    source: InputSource,
    urgency: InputUrgency,
    metadata: Option<QueuedInputMetadata>,
) -> EnqueueInputAttempt {
    enqueue_input_inner_with_delivery(inner, message_id, content, source, urgency, metadata, None)
        .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn enqueue_input_inner_with_delivery(
    inner: &ServiceInner,
    message_id: String,
    content: Vec<ContentPart>,
    source: InputSource,
    urgency: InputUrgency,
    metadata: Option<QueuedInputMetadata>,
    delivery: Option<MessageDelivery>,
) -> EnqueueInputAttempt {
    if !valid_input_metadata(source, metadata.as_ref()) {
        return EnqueueInputAttempt::rejected(
            ServiceError::Persistence {
                message: "input source and metadata do not match".to_owned(),
            },
            None,
        );
    }
    let _intake = inner.intake_gate.lock().await;
    if content.is_empty() {
        let mut rejection = InputRejection::new(
            &message_id,
            &content,
            source,
            urgency,
            "empty_message",
            "message content must not be empty",
            false,
        );
        if let Some(metadata) = metadata.as_ref() {
            rejection = rejection.with_metadata(metadata);
        }
        let (data, turn_id) = {
            let state = inner.state.lock().expect("service state mutex poisoned");
            (
                input_rejection_data(rejection, state.input_queue.len()),
                state.active_turn_id.clone(),
            )
        };
        if let Err(error) =
            inner.try_append_event_for_turn(turn_id.as_deref(), "message.rejected", data)
        {
            return EnqueueInputAttempt::failed_transition(FailedTransitionIntent::timeline(error));
        }
        if let Err(error) = inner.try_append_service_status_for_current_state(turn_id.as_deref()) {
            return EnqueueInputAttempt::failed_transition(error);
        }
        return EnqueueInputAttempt::rejected(ServiceError::EmptyMessage, None);
    }

    let cursor_seq = inner.last_event_seq();

    let preflight = {
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        enqueue_preflight_locked(
            inner,
            &mut state,
            &message_id,
            &content,
            source,
            urgency,
            metadata.as_ref(),
            delivery.as_ref(),
        )
    };
    if let Some(attempt) = complete_enqueue_preflight(inner, preflight) {
        return attempt;
    }

    let accepted = AcceptedInputEntry {
        message_id,
        content,
        cursor_seq,
        source,
        metadata,
        urgency,
    };

    persist_prepared_enqueue_with_delivery(inner, accepted, delivery).await
}

#[cfg(test)]
pub(super) async fn persist_prepared_enqueue(
    inner: &ServiceInner,
    accepted: AcceptedInputEntry,
) -> EnqueueInputAttempt {
    persist_prepared_enqueue_with_delivery(inner, accepted, None).await
}

pub(super) async fn persist_prepared_enqueue_with_delivery(
    inner: &ServiceInner,
    accepted: AcceptedInputEntry,
    delivery: Option<MessageDelivery>,
) -> EnqueueInputAttempt {
    let mut persistence = match prepare_enqueue_persistence_with_delivery(inner, accepted, delivery)
    {
        Ok(persistence) => persistence,
        Err(error) => return EnqueueInputAttempt::rejected(error, None),
    };

    let accepted_input_already_durable = persistence
        .prepared
        .as_ref()
        .expect("enqueue persistence should retain preparation")
        .accepted_input_already_durable;
    let recorded = if accepted_input_already_durable {
        Ok(false)
    } else if inner.session_recorder.is_some() {
        record_session_prepared_enqueue(inner, &persistence)
    } else {
        record_non_session_accepted_input(
            inner,
            &persistence
                .prepared
                .as_ref()
                .expect("enqueue persistence should retain preparation")
                .accepted,
        )
        .await
    };
    if let Err(error) = recorded {
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        if state.state != ServiceState::Failed {
            state.last_error = Some(error.to_string());
        }
        return EnqueueInputAttempt::rejected(error, None);
    }
    install_durable_delivery_identity(inner, &persistence);

    publish_and_finalize_enqueue(inner, &mut persistence)
}

fn install_durable_delivery_identity(inner: &ServiceInner, persistence: &EnqueuePersistence) {
    let prepared = persistence
        .prepared
        .as_ref()
        .expect("enqueue persistence should retain preparation");
    let Some(delivery) = prepared.delivery.clone() else {
        return;
    };
    let cursor = current_timeline_cursor(&inner.timeline_store);
    let mut state = inner.state.lock().expect("service state mutex poisoned");
    insert_message_index_entry_with_projection_state_and_delivery(
        &mut state.message_index,
        prepared.accepted.message_id.clone(),
        prepared.accepted.content.clone(),
        cursor,
        MessageProjectionState::MissingProjection,
        Some(delivery),
    );
    prune_message_index_to_retained_window(&mut state);
}

pub(super) fn record_session_prepared_enqueue(
    inner: &ServiceInner,
    persistence: &EnqueuePersistence,
) -> Result<bool, ServiceError> {
    inner
        .session_recorder
        .as_ref()
        .expect("session enqueue should retain its recorder")
        .record_accepted_input_with_delivery_sync(
            &persistence
                .prepared
                .as_ref()
                .expect("enqueue persistence should retain preparation")
                .accepted,
            persistence
                .prepared
                .as_ref()
                .and_then(|prepared| prepared.delivery.as_ref()),
        )
        .map(|_| false)
        .map_err(|error| ServiceError::Persistence {
            message: error.to_string(),
        })
}

pub(super) fn prepare_enqueue_persistence(
    inner: &ServiceInner,
    accepted: AcceptedInputEntry,
) -> Result<EnqueuePersistence, ServiceError> {
    prepare_enqueue_persistence_with_delivery(inner, accepted, None)
}

pub(super) fn prepare_enqueue_persistence_with_delivery(
    inner: &ServiceInner,
    accepted: AcceptedInputEntry,
    delivery: Option<MessageDelivery>,
) -> Result<EnqueuePersistence, ServiceError> {
    let prepared = {
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        prepare_enqueue_persistence_locked(inner, &mut state, accepted, delivery)?
    };
    Ok(EnqueuePersistence {
        prepared: Some(prepared),
        _worker: ServiceWorkerGuard {
            inner: inner.self_weak.clone(),
            kind: ServiceWorkerKind::InputPersistence,
        },
    })
}

fn prepare_enqueue_persistence_locked(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
    accepted: AcceptedInputEntry,
    delivery: Option<MessageDelivery>,
) -> Result<PreparedEnqueue, ServiceError> {
    let prepared = prepare_enqueue_locked(inner, state, accepted, delivery)?;
    state
        .service_workers
        .register(ServiceWorkerKind::InputPersistence);
    Ok(prepared)
}

pub(super) fn publish_and_finalize_enqueue(
    inner: &ServiceInner,
    persistence: &mut EnqueuePersistence,
) -> EnqueueInputAttempt {
    let (last_error, context_maintenance) = {
        let state = inner.state.lock().expect("service state mutex poisoned");
        align_prepared_enqueue_with_state(
            persistence
                .prepared
                .as_mut()
                .expect("enqueue persistence should retain preparation"),
            &state,
        );
        (state.last_error.clone(), state.context_maintenance.clone())
    };
    let published = match publish_prepared_enqueue_timeline(
        inner,
        persistence
            .prepared
            .as_ref()
            .expect("enqueue persistence should retain preparation"),
        last_error,
        context_maintenance,
    ) {
        Ok(published) => published,
        Err(error) => {
            let mut state = inner.state.lock().expect("service state mutex poisoned");
            if state.state != ServiceState::Failed {
                state.last_error = Some(error.to_string());
            }
            return EnqueueInputAttempt::rejected(error, None);
        }
    };

    let mut state = inner.state.lock().expect("service state mutex poisoned");
    align_prepared_enqueue_with_state(
        persistence
            .prepared
            .as_mut()
            .expect("enqueue persistence should retain preparation"),
        &state,
    );
    let prepared = persistence
        .prepared
        .take()
        .expect("enqueue persistence should retain preparation");
    let finalized = finalize_prepared_enqueue_locked(inner, &mut state, prepared, published);
    match finalized {
        Ok((outcome, start_cancel, preemption)) => {
            EnqueueInputAttempt::accepted(outcome, start_cancel, preemption)
        }
        Err(error) => EnqueueInputAttempt::rejected(error, None),
    }
}

fn align_prepared_enqueue_with_state(prepared: &mut PreparedEnqueue, state: &ServiceInnerState) {
    prepared.planned_queue_length = state.input_queue.len().saturating_add(1);
    if state.state == ServiceState::ShuttingDown {
        prepared.submit_status = EnqueueSubmitStatus::Queued;
        prepared.turn_id = state.active_turn_id.clone();
        prepared.start_cancel = None;
        prepared.planned_state = state.state;
        prepared.preemption = None;
    }
}

pub(super) fn valid_input_metadata(
    source: InputSource,
    metadata: Option<&QueuedInputMetadata>,
) -> bool {
    match (source, metadata) {
        (InputSource::User, None)
        | (InputSource::TaskCallback, Some(QueuedInputMetadata::TaskCallback { .. }))
        | (InputSource::TaskRequest, Some(QueuedInputMetadata::TaskRequest { .. }))
        | (InputSource::TaskTell, Some(QueuedInputMetadata::TaskTell { .. })) => true,
        (
            InputSource::SubagentCallback,
            Some(metadata @ QueuedInputMetadata::SubagentCallback { .. }),
        ) => valid_subagent_callback_metadata(metadata),
        _ => false,
    }
}

pub(super) struct InputRejection<'a> {
    message_id: &'a str,
    content: &'a [ContentPart],
    source: InputSource,
    urgency: InputUrgency,
    reason: &'static str,
    message: String,
    retryable: bool,
    metadata: Option<&'a QueuedInputMetadata>,
}

impl<'a> InputRejection<'a> {
    pub(super) fn new(
        message_id: &'a str,
        content: &'a [ContentPart],
        source: InputSource,
        urgency: InputUrgency,
        reason: &'static str,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            message_id,
            content,
            source,
            urgency,
            reason,
            message: message.into(),
            retryable,
            metadata: None,
        }
    }

    pub(super) fn with_metadata(mut self, metadata: &'a QueuedInputMetadata) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

fn add_input_metadata_fields(data: &mut Value, metadata: Option<&QueuedInputMetadata>) {
    let Some(fields) = data.as_object_mut() else {
        return;
    };
    match metadata {
        Some(QueuedInputMetadata::TaskCallback { task_id, .. }) => {
            fields.insert("task_id".into(), json!(task_id));
        }
        Some(QueuedInputMetadata::TaskRequest {
            task_id,
            request_id,
        }) => {
            fields.insert("task_id".into(), json!(task_id));
            fields.insert("ask_id".into(), json!(request_id));
        }
        Some(QueuedInputMetadata::TaskTell { task_id, tell_id }) => {
            fields.insert("task_id".into(), json!(task_id));
            fields.insert("tell_id".into(), json!(tell_id));
        }
        Some(QueuedInputMetadata::SubagentCallback {
            subagent_id,
            kind,
            task_id,
            ask_id,
            tell_id,
            task_message,
            label,
            summary,
        }) => {
            fields.insert("subagent_id".into(), json!(subagent_id));
            fields.insert("callback_kind".into(), json!(kind));
            if let Some(value) = task_id {
                fields.insert("task_id".into(), json!(value));
            }
            if let Some(value) = ask_id {
                fields.insert("ask_id".into(), json!(value));
            }
            if let Some(value) = tell_id {
                fields.insert("tell_id".into(), json!(value));
            }
            if let Some(value) = task_message {
                fields.insert("task_message".into(), json!(value));
            }
            if let Some(value) = label {
                fields.insert("label".into(), json!(value));
            }
            if let Some(value) = summary {
                fields.insert("summary".into(), json!(value));
            }
        }
        None => {}
    }
}

pub(super) fn input_rejection_data(rejection: InputRejection<'_>, queue_length: usize) -> Value {
    let summary = summarize_input_content(rejection.content);
    let mut data = json!({
        "message_id": rejection.message_id,
        "input_id": rejection.message_id,
        "input_kind": input_kind_name(rejection.source),
        "source": rejection.source.as_str(),
        "urgency": rejection.urgency.as_str(),
        "content_preview": summary.content_preview,
        "content_bytes": summary.content_bytes,
        "content_truncated": summary.content_truncated,
        "content_kind": summary.content_kind,
        "queue_length": queue_length,
        "reason": rejection.reason,
        "error": { "code": rejection.reason, "message": rejection.message, "retryable": rejection.retryable }
    });
    add_input_metadata_fields(&mut data, rejection.metadata);
    data
}

pub(super) fn start_turn(state: &mut ServiceInnerState) -> String {
    let turn_id = format!("turn_{}", state.next_turn_number);
    state.next_turn_number += 1;
    state.active_turn_id = Some(turn_id.clone());
    turn_id
}

pub(super) fn clear_active_turn(state: &mut ServiceInnerState) {
    state.active_turn_id = None;
}

pub(super) fn start_followup_turn(state: &mut ServiceInnerState) -> CancellationToken {
    let cancel = CancellationToken::new();
    start_turn(state);
    state.state = ServiceState::Running;
    state.active_cancel = Some(cancel.clone());
    cancel
}

fn terminal_assistant_message(message: &Message) -> bool {
    matches!(
        message,
        Message::Assistant {
            stop_reason: Some(StopReason::EndTurn | StopReason::ToolTerminated),
            ..
        }
    )
}

fn restart_boundary_still_open(messages: &[Message], boundary: &SessionRestartBoundary) -> bool {
    let current_request_start = boundary
        .current_request_start_or_context_start(messages)
        .min(messages.len());
    !messages[current_request_start..].iter().any(|message| {
        terminal_assistant_message(message)
            || matches!(message, Message::ToolResult(result) if result.terminate)
    })
}

pub(super) fn open_request_boundary_from_agent_error(
    error: &crate::agent_loop::AgentRunError,
) -> Option<SessionRestartBoundary> {
    error.open_request_boundary.as_ref().map(|boundary| {
        SessionRestartBoundary::with_active_input_ids_and_active_user_message_index(
            boundary.active_input_ids.clone(),
            Some(boundary.current_request_start),
        )
    })
}

fn restore_restart_boundary_for_unfinished_request(
    state: &mut ServiceInnerState,
    restart_boundary: Option<&SessionRestartBoundary>,
) {
    let Some(restart_boundary) = restart_boundary else {
        return;
    };
    let request_start = restart_boundary.current_request_start_or_context_start(&state.context);
    if restart_boundary_still_open(&state.context, restart_boundary)
        && !request_range_contains_synthetic_missing_tool_result(
            &state.context,
            request_start..state.context.len(),
        )
    {
        state.restart_boundary = Some(restart_boundary.clone());
    }
}

pub(super) fn restore_restart_boundary_for_error(
    state: &mut ServiceInnerState,
    restart_boundary_for_retry: Option<&SessionRestartBoundary>,
    error_boundary: Option<&SessionRestartBoundary>,
) {
    restore_restart_boundary_for_unfinished_request(state, error_boundary);
    if state.restart_boundary.is_none() {
        restore_restart_boundary_for_unfinished_request(state, restart_boundary_for_retry);
    }
}

fn prepare_enqueue_locked(
    inner: &ServiceInner,
    state: &ServiceInnerState,
    accepted: AcceptedInputEntry,
    delivery: Option<MessageDelivery>,
) -> Result<PreparedEnqueue, ServiceError> {
    if let Some(message) = inner
        .configuration_error
        .lock()
        .expect("service configuration error mutex poisoned")
        .clone()
    {
        return Err(ServiceError::Configuration { message });
    }
    let AcceptedInputEntry {
        ref message_id,
        ref content,
        source,
        urgency,
        ..
    } = accepted;
    if state.state == ServiceState::Failed && !InputSource::is_user(&source) {
        return Err(ServiceError::ShuttingDown);
    }
    let summary = summarize_input_content(content);
    let planned_queue_length = state.input_queue.len().saturating_add(1);

    let mut preemption = None;
    let (submit_status, turn_id, start_cancel, planned_state) = match state.state {
        ServiceState::Idle | ServiceState::Failed => {
            let cancel = CancellationToken::new();
            let turn_id = format!("turn_{}", state.next_turn_number);
            (
                EnqueueSubmitStatus::Started,
                Some(turn_id),
                Some(cancel),
                ServiceState::Running,
            )
        }
        ServiceState::Running => {
            let turn_id = state.active_turn_id.clone();
            let mut planned_state = ServiceState::Running;
            if urgency == InputUrgency::Urgent && !state.context_maintenance.provider_calls_paused {
                if let Some(cancel) = state.active_cancel.clone() {
                    planned_state = ServiceState::Aborting;
                    preemption = Some(AcceptedInputPreemption {
                        cancel,
                        turn_id: turn_id.clone(),
                        input_id: message_id.to_owned(),
                        source,
                        urgency,
                    });
                }
            }
            (EnqueueSubmitStatus::Queued, turn_id, None, planned_state)
        }
        ServiceState::Aborting => {
            let turn_id = state.active_turn_id.clone();
            (
                EnqueueSubmitStatus::Queued,
                turn_id,
                None,
                ServiceState::Aborting,
            )
        }
        ServiceState::ShuttingDown => {
            return Err(ServiceError::ShuttingDown);
        }
    };

    let input_text = text_only_input_content(content).map(str::to_owned);
    let accepted_input_already_durable = delivery.as_ref().is_some_and(|delivery| {
        state.message_index.get(message_id).is_some_and(|entry| {
            entry.content == *content
                && entry.delivery.as_ref() == Some(delivery)
                && entry.projection_state == MessageProjectionState::MissingProjection
        })
    });

    Ok(PreparedEnqueue {
        accepted,
        delivery,
        accepted_input_already_durable,
        submit_status,
        turn_id,
        start_cancel,
        planned_state,
        planned_queue_length,
        summary,
        input_text,
        preemption,
    })
}

fn publish_prepared_enqueue_timeline(
    inner: &ServiceInner,
    prepared: &PreparedEnqueue,
    last_error: Option<String>,
    context_maintenance: ContextMaintenanceStatus,
) -> Result<PublishedEnqueue, ServiceError> {
    let accepted = &prepared.accepted;
    let message_id = &accepted.message_id;
    let source = accepted.source;
    let urgency = accepted.urgency;
    let summary = &prepared.summary;
    let accepted_event = inner
        .try_append_event_for_turn(prepared.turn_id.as_deref(), "message.received", {
            let mut data = json!({
                "message_id": message_id,
                "input_id": message_id,
                "input_kind": input_kind_name(source),
                "source": source.as_str(),
                "urgency": urgency.as_str(),
                "content_preview": summary.content_preview,
                "content_bytes": summary.content_bytes,
                "content_truncated": summary.content_truncated,
                "content_kind": summary.content_kind,
                "queue_length": prepared.planned_queue_length
            });
            if let Some(text) = prepared.input_text.as_deref() {
                data["text"] = json!(text);
            }
            add_input_metadata_fields(&mut data, accepted.metadata.as_ref());
            data
        })
        .map_err(timeline_persistence_service_error)?;
    let accepted_cursor = timeline_cursor_for_event(inner, &accepted_event);

    let mut outcome_cursor = accepted_cursor.clone();
    if prepared.submit_status == EnqueueSubmitStatus::Queued {
        let queued_event = inner
            .try_append_event_for_turn(prepared.turn_id.as_deref(), "message.queued", {
                let mut data = json!({
                    "message_id": message_id,
                    "input_id": message_id,
                    "input_kind": input_kind_name(source),
                    "source": source.as_str(),
                    "urgency": urgency.as_str(),
                    "content_preview": summary.content_preview,
                    "content_bytes": summary.content_bytes,
                    "content_truncated": summary.content_truncated,
                    "content_kind": summary.content_kind,
                    "queue_length": prepared.planned_queue_length,
                    "queue_position": prepared.planned_queue_length
                });
                if let Some(text) = prepared.input_text.as_deref() {
                    data["text"] = json!(text);
                }
                add_input_metadata_fields(&mut data, accepted.metadata.as_ref());
                data
            })
            .map_err(timeline_persistence_service_error)?;
        outcome_cursor = timeline_cursor_for_event(inner, &queued_event);
    }

    inner
        .try_append_event_for_turn(
            prepared.turn_id.as_deref(),
            "service.status",
            inner.service_status_data(
                prepared.planned_state,
                prepared.planned_queue_length,
                last_error,
                context_maintenance,
            ),
        )
        .map_err(timeline_persistence_service_error)?;

    Ok(PublishedEnqueue {
        accepted_cursor,
        outcome_cursor,
    })
}

fn finalize_prepared_enqueue_locked(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
    prepared: PreparedEnqueue,
    published: PublishedEnqueue,
) -> Result<
    (
        EnqueueOutcome,
        Option<CancellationToken>,
        Option<AcceptedInputPreemption>,
    ),
    ServiceError,
> {
    if state.state == ServiceState::Failed && !InputSource::is_user(&prepared.accepted.source) {
        return Err(ServiceError::ShuttingDown);
    }
    let PreparedEnqueue {
        accepted,
        delivery,
        accepted_input_already_durable: _,
        submit_status,
        turn_id,
        start_cancel,
        planned_state,
        planned_queue_length: _,
        summary: _,
        input_text,
        preemption,
    } = prepared;
    let PublishedEnqueue {
        accepted_cursor,
        outcome_cursor,
    } = published;
    let AcceptedInputEntry {
        message_id,
        content,
        source,
        urgency,
        metadata,
        cursor_seq,
    } = accepted;

    if submit_status == EnqueueSubmitStatus::Started {
        state.next_turn_number += 1;
        state.active_turn_id = turn_id.clone();
        state.active_cancel = start_cancel.clone();
    }
    state.state = planned_state;
    let known_message = DrainedMessage {
        id: message_id.clone(),
        content: content.clone(),
        source,
        urgency,
        metadata: metadata.clone(),
        cursor_seq: Some(cursor_seq),
        delivery: delivery.clone(),
    };
    state.input_queue.enqueue(QueuedMessage {
        id: message_id.clone(),
        content: content.clone(),
        source,
        urgency,
        metadata,
        cursor_seq,
        delivery: delivery.clone(),
    });
    insert_message_index_entry_with_delivery(
        &mut state.message_index,
        message_id.clone(),
        content,
        accepted_cursor.clone(),
        delivery,
    );
    remember_known_user_message(state, known_message);
    prune_message_index_to_retained_window(state);

    if source == InputSource::User {
        if let Some(text) = input_text.as_deref() {
            inner
                .task_observer
                .publish_final_text(FinalTextObservation {
                    kind: FinalTextObservationKind::UserText,
                    text,
                    message_id: Some(&message_id),
                    cycle_id: None,
                });
        }
    }

    Ok((
        EnqueueOutcome {
            submit_status,
            service_status: inner.status_from_locked(state),
            turn_id,
            cursor: outcome_cursor,
        },
        start_cancel,
        preemption,
    ))
}

pub(super) fn emit_urgent_preemption(inner: &ServiceInner, preemption: AcceptedInputPreemption) {
    preemption.cancel.cancel();
    inner.append_event_for_turn_or_record_error(
        preemption.turn_id.as_deref(),
        "agent.abort_requested",
        json!({
            "reason": "urgent_input",
            "input_id": &preemption.input_id,
            "message_id": &preemption.input_id,
            "input_kind": input_kind_name(preemption.source),
            "source": preemption.source.as_str(),
            "urgency": preemption.urgency.as_str()
        }),
    );
    inner.append_service_status_for_current_state(preemption.turn_id.as_deref());
}

fn duplicate_outcome(
    inner: &ServiceInner,
    state: &ServiceInnerState,
    cursor: EventCursor,
) -> EnqueueOutcome {
    EnqueueOutcome {
        submit_status: EnqueueSubmitStatus::Duplicate,
        service_status: inner.status_from_locked(state),
        turn_id: None,
        cursor,
    }
}

pub(super) struct StartPendingLockedOutcome {
    pub(super) start_cancel: Option<CancellationToken>,
    pub(super) failure: Option<FailedTransitionIntent>,
    status: Option<(Option<String>, Value, u64)>,
}

pub(super) fn start_pending_locked(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
) -> StartPendingLockedOutcome {
    if inner
        .configuration_error
        .lock()
        .expect("service configuration error mutex poisoned")
        .is_some()
    {
        return StartPendingLockedOutcome {
            start_cancel: None,
            failure: None,
            status: None,
        };
    }
    let start_cancel = match state.state {
        ServiceState::Idle | ServiceState::Failed
            if !state.input_queue.is_empty() || state.restart_boundary.is_some() =>
        {
            let cancel = CancellationToken::new();
            start_turn(state);
            state.state = ServiceState::Running;
            state.active_cancel = Some(cancel.clone());
            Some(cancel)
        }
        ServiceState::Idle
        | ServiceState::Failed
        | ServiceState::Running
        | ServiceState::Aborting
        | ServiceState::ShuttingDown => None,
    };

    let status = start_cancel.as_ref().map(|_| {
        let turn_id = state.active_turn_id.clone();
        let (data, generation) = inner.service_status_data_from_locked(state);
        (turn_id, data, generation)
    });

    StartPendingLockedOutcome {
        start_cancel,
        failure: None,
        status,
    }
}

pub(super) fn publish_start_pending_status(
    inner: &ServiceInner,
    mut outcome: StartPendingLockedOutcome,
) -> StartPendingLockedOutcome {
    let Some((turn_id, data, generation)) = outcome.status.take() else {
        return outcome;
    };
    match inner.try_append_event_for_turn(turn_id.as_deref(), "service.status", data) {
        Ok(_) => inner.mark_service_status_published(generation),
        Err(error) => {
            inner.mark_service_status_dirty(generation);
            let mut state = inner.state.lock().expect("service state mutex poisoned");
            if state.active_turn_id == turn_id {
                state.active_cancel = None;
                clear_active_turn(&mut state);
            }
            outcome.start_cancel = None;
            outcome.failure = Some(FailedTransitionIntent::start_pending(error));
        }
    }
    outcome
}
