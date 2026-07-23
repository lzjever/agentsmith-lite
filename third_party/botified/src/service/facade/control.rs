use serde_json::json;

use super::super::{
    emit_urgent_preemption, enqueue_input_inner, enqueue_input_inner_with_delivery,
    input_rejection_data, publish_start_pending_status, spawn_service_loop, start_pending_locked,
    task_callback_metadata, task_cancel_result_summary, task_reply_details,
    timeline_cursor_for_event, Arc, BackgroundTaskManager, CancellationToken, ContentPart,
    DeliveryReceipt, EnqueueInputAttempt, EnqueueOutcome, EventCursor, FileStore, InputRejection,
    InputSource, InputUrgency, LlmTextPreviewSink, MessageDelivery, Ordering, ProviderMetadata,
    RegistryStore, RuntimeTaskPresetsConfig, Service, ServiceError, ServiceState, ServiceStatus,
    SharedProfiler, TaskOwner, TimelineWriteFailure, Value,
};

impl Service {
    pub fn set_provider_summaries(&self, providers: Vec<ProviderMetadata>) {
        *self
            .inner
            .provider_summaries
            .lock()
            .expect("provider summaries mutex poisoned") = providers
            .into_iter()
            .filter_map(|metadata| metadata.sanitized())
            .collect();
    }

    pub fn set_profiler(&self, profiler: Option<SharedProfiler>) {
        *self
            .inner
            .profiler
            .lock()
            .expect("service profiler mutex poisoned") = profiler;
    }

    pub fn set_llm_text_preview_enabled(&self, enabled: bool) {
        self.inner
            .llm_text_preview_enabled
            .store(enabled, Ordering::SeqCst);
    }

    pub fn llm_text_preview_sink(&self) -> Option<LlmTextPreviewSink> {
        self.llm_text_preview_enabled()
            .then(|| self.inner.llm_text_preview_hub.sink())
    }

    pub fn file_store(&self) -> Option<FileStore> {
        self.inner.file_store.clone()
    }

    pub fn registry_store(&self) -> Option<RegistryStore> {
        self.inner.ensure_registry_maintenance();
        self.inner.registry_store.clone()
    }
    #[doc(hidden)]
    pub fn inject_next_timeline_write_failure(&self, failure: TimelineWriteFailure) {
        self.inner
            .timeline_store
            .lock()
            .expect("timeline store mutex poisoned")
            .inject_next_write_failure(failure);
    }

    #[doc(hidden)]
    pub fn inject_timeline_write_failure_after_events(
        &self,
        skip_events: usize,
        failure: TimelineWriteFailure,
    ) {
        *self
            .inner
            .next_service_event_write_failure
            .lock()
            .expect("service event write failure mutex poisoned") = Some((skip_events, failure));
    }

    #[doc(hidden)]
    pub fn inject_next_agent_timeline_write_failure(&self, failure: TimelineWriteFailure) {
        self.inject_agent_timeline_write_failure_after_events(0, failure);
    }

    #[doc(hidden)]
    pub fn inject_agent_timeline_write_failure_after_events(
        &self,
        skip_events: usize,
        failure: TimelineWriteFailure,
    ) {
        *self
            .inner
            .next_agent_event_write_failure
            .lock()
            .expect("agent event write failure mutex poisoned") = Some((skip_events, failure));
    }

    pub fn background_task_manager(&self) -> Arc<BackgroundTaskManager> {
        self.inner.background_tasks.clone()
    }

    pub fn cancel_background_task(&self, task_id: &str) -> Option<Value> {
        self.inner
            .cancel_background_task_by_owner(&TaskOwner::Main, task_id)
            .map(|snapshot| task_cancel_result_summary(&snapshot))
    }
    pub fn set_task_presets(&self, task_presets: RuntimeTaskPresetsConfig) {
        *self
            .inner
            .task_presets
            .lock()
            .expect("task presets mutex poisoned") = task_presets;
    }

    pub fn task_preset_start(&self, preset_id: &str) -> Value {
        self.inner.start_task_preset(preset_id)
    }

    pub fn start_task_presets_on_boot(&self) -> Vec<Value> {
        let start_ids = self
            .inner
            .task_presets
            .lock()
            .expect("task presets mutex poisoned")
            .start_on_boot
            .clone();
        start_ids
            .iter()
            .map(|preset_id| self.inner.start_task_preset(preset_id))
            .collect()
    }
    pub fn reply_task_request(&self, task_id: &str, request_id: &str, response: &str) -> Value {
        let outcome = self.inner.reply_task_request(task_id, request_id, response);
        task_reply_details(&outcome)
    }

    pub async fn enqueue(
        &self,
        message_id: impl Into<String>,
        content: Vec<ContentPart>,
    ) -> Result<EnqueueOutcome, ServiceError> {
        self.enqueue_with_urgency(message_id, content, InputUrgency::Normal)
            .await
    }

    pub async fn enqueue_with_urgency(
        &self,
        message_id: impl Into<String>,
        content: Vec<ContentPart>,
        urgency: InputUrgency,
    ) -> Result<EnqueueOutcome, ServiceError> {
        self.enqueue_input(message_id, content, InputSource::User, urgency, None)
            .await
    }

    pub async fn enqueue_delivery(
        &self,
        delivery_key: String,
        request_hash: String,
        content: Vec<ContentPart>,
        urgency: InputUrgency,
    ) -> Result<EnqueueOutcome, ServiceError> {
        if self.inner.session_recorder.is_none() {
            return Err(ServiceError::Persistence {
                message: "durable session storage is required for delivery".to_owned(),
            });
        }
        let delivery = MessageDelivery {
            delivery_key: delivery_key.clone(),
            request_hash,
        };
        self.enqueue_input(
            delivery_key,
            content,
            InputSource::User,
            urgency,
            Some(delivery),
        )
        .await
    }

    pub fn delivery_receipt(&self, delivery_key: &str) -> Option<DeliveryReceipt> {
        let state = self
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        let entry = state.message_index.get(delivery_key)?;
        let delivery = entry.delivery.as_ref()?;
        Some(DeliveryReceipt {
            delivery_key: delivery.delivery_key.clone(),
            request_hash: delivery.request_hash.clone(),
            message_id: delivery_key.to_owned(),
            cursor: entry.cursor.clone(),
        })
    }

    pub async fn enqueue_task_callback(
        &self,
        task_id: impl Into<String>,
        message_id: impl Into<String>,
        content: Vec<ContentPart>,
    ) -> Result<EnqueueOutcome, ServiceError> {
        let task_id = task_id.into();
        let snapshot =
            self.inner
                .background_tasks
                .get(&task_id)
                .ok_or_else(|| ServiceError::Persistence {
                    message: format!("task callback snapshot {task_id} is unavailable"),
                })?;
        let metadata =
            task_callback_metadata(&snapshot).ok_or_else(|| ServiceError::Persistence {
                message: format!("task callback snapshot {task_id} is not terminal"),
            })?;
        let attempt = enqueue_input_inner(
            &self.inner,
            message_id.into(),
            content,
            InputSource::TaskCallback,
            InputUrgency::Normal,
            Some(metadata),
        )
        .await;
        let EnqueueInputAttempt {
            outcome,
            start_cancel,
            preemption,
            ..
        } = attempt;
        if let Some(cancel) = start_cancel {
            self.spawn_loop(cancel);
        }
        if let Some(preemption) = preemption {
            emit_urgent_preemption(self.inner.as_ref(), preemption);
        }
        outcome
    }

    pub fn reject_user_message(
        &self,
        message_id: &str,
        content: &[ContentPart],
        reason: &'static str,
        message: impl Into<String>,
        retryable: bool,
    ) -> Option<EventCursor> {
        let (data, turn_id) = {
            let state = self
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            (
                input_rejection_data(
                    InputRejection::new(
                        message_id,
                        content,
                        InputSource::User,
                        InputUrgency::Normal,
                        reason,
                        message,
                        retryable,
                    ),
                    state.input_queue.len(),
                ),
                state.active_turn_id.clone(),
            )
        };
        let event =
            match self
                .inner
                .try_append_event_for_turn(turn_id.as_deref(), "message.rejected", data)
            {
                Ok(event) => event,
                Err(error) => {
                    self.inner.record_timeline_persistence_error(error);
                    return None;
                }
            };
        if let Err(failure) = self
            .inner
            .try_append_service_status_for_current_state(turn_id.as_deref())
        {
            failure.transition(self.inner.as_ref());
        }
        self.inner.notify.notify_waiters();
        Some(timeline_cursor_for_event(self.inner.as_ref(), &event))
    }

    async fn enqueue_input(
        &self,
        message_id: impl Into<String>,
        content: Vec<ContentPart>,
        source: InputSource,
        urgency: InputUrgency,
        delivery: Option<MessageDelivery>,
    ) -> Result<EnqueueOutcome, ServiceError> {
        let attempt = enqueue_input_inner_with_delivery(
            &self.inner,
            message_id.into(),
            content,
            source,
            urgency,
            None,
            delivery,
        )
        .await;
        let EnqueueInputAttempt {
            outcome,
            start_cancel,
            preemption,
            failure: _,
        } = attempt;
        let should_notify = outcome.is_ok() || start_cancel.is_some() || preemption.is_some();

        if let Some(cancel) = start_cancel {
            self.spawn_loop(cancel);
        }
        if let Some(preemption) = preemption {
            emit_urgent_preemption(self.inner.as_ref(), preemption);
        }
        if should_notify {
            self.inner.notify.notify_waiters();
        }
        outcome
    }

    pub async fn abort(&self) -> ServiceStatus {
        let (cancel, turn_id) = {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            match state.state {
                ServiceState::Running => {
                    state.state = ServiceState::Aborting;
                    (state.active_cancel.clone(), state.active_turn_id.clone())
                }
                ServiceState::Idle
                | ServiceState::Aborting
                | ServiceState::Failed
                | ServiceState::ShuttingDown => (None, None),
            }
        };

        if let Some(cancel) = cancel {
            cancel.cancel();
            self.inner.append_event_for_turn_or_record_error(
                turn_id.as_deref(),
                "agent.abort_requested",
                json!({}),
            );
            self.inner
                .append_service_status_for_current_state(turn_id.as_deref());
        }
        self.inner.notify.notify_waiters();
        self.status()
    }

    pub async fn start_pending_if_needed(&self) -> ServiceStatus {
        self.inner.ensure_service_projection_retry_loop();
        self.inner.service_projection_notify.notify_one();
        let outcome = publish_start_pending_status(&self.inner, {
            let _intake = self.inner.intake_gate.lock().await;
            let mut state = self
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            start_pending_locked(&self.inner, &mut state)
        });

        if let Some(failure) = outcome.failure {
            failure.transition(self.inner.as_ref());
        } else if let Some(cancel) = outcome.start_cancel {
            self.spawn_loop(cancel);
        }
        self.inner.notify.notify_waiters();
        self.status()
    }

    fn spawn_loop(&self, cancel: CancellationToken) {
        spawn_service_loop(self.inner.clone(), cancel);
    }
}
