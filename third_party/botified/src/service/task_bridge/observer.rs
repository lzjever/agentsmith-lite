use super::*;

#[cfg(test)]
type TaskObserverPreviewPublishHook = Arc<dyn Fn() + Send + Sync>;

#[cfg(test)]
type TaskObserverPreviewPublishHooks = HashMap<usize, TaskObserverPreviewPublishHook>;

#[cfg(test)]
fn task_observer_preview_publish_hooks() -> &'static Mutex<TaskObserverPreviewPublishHooks> {
    static HOOKS: std::sync::OnceLock<Mutex<TaskObserverPreviewPublishHooks>> =
        std::sync::OnceLock::new();
    HOOKS.get_or_init(|| Mutex::new(HashMap::new()))
}

impl ServiceInner {
    fn commit_task_observer_result(
        &self,
        task_id: &str,
        commit: impl FnOnce() -> Result<(), ObserverCommitError>,
    ) -> Result<(), ObserverCommitError> {
        self.with_task_frame_commit(task_id, TaskFrameAdmissionKind::Observe, || Ok(commit()))
            .unwrap_or(Err(ObserverCommitError::AdmissionClosed))
    }

    pub(in crate::service) fn ensure_task_observer_preview_loop(&self) {
        let mut preview_join = self
            .task_observer_preview_join
            .lock()
            .expect("task observer preview join mutex poisoned");
        if self
            .task_observer_preview_loop_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let started_guard = TaskObserverPreviewLoopStartedGuard::new(Arc::downgrade(
            &self.task_observer_preview_loop_started,
        ));
        #[cfg(test)]
        self.run_task_observer_preview_publish_hook_for_test();
        let subscription = self
            .llm_text_preview_hub
            .subscribe(LlmTextPreviewFilter::default());
        let join = spawn_task_observer_preview_loop(
            self.task_observer.clone(),
            self.llm_text_preview_hub.clone(),
            subscription,
            started_guard,
            self.task_observer_preview_cancel.clone(),
        );
        *preview_join = Some(join);
    }

    #[cfg(test)]
    pub(in crate::service) fn set_task_observer_preview_publish_hook_for_test(
        &self,
        hook: Arc<dyn Fn() + Send + Sync>,
    ) {
        task_observer_preview_publish_hooks()
            .lock()
            .expect("task observer preview publish hooks mutex poisoned")
            .insert(
                Arc::as_ptr(&self.task_observer_preview_loop_started) as usize,
                hook,
            );
    }

    #[cfg(test)]
    fn run_task_observer_preview_publish_hook_for_test(&self) {
        let hook = task_observer_preview_publish_hooks()
            .lock()
            .expect("task observer preview publish hooks mutex poisoned")
            .remove(&(Arc::as_ptr(&self.task_observer_preview_loop_started) as usize));
        if let Some(hook) = hook {
            hook();
        }
    }

    pub(super) async fn handle_task_observe_request(
        self: &Arc<Self>,
        task_id: &str,
        frame: TaskObserveRequestFrame,
    ) {
        let transition = self.task_observer.transition_for(task_id);
        let _transition = transition.lock().await;
        self.task_observer.wait_for_retirement(task_id).await;
        let request_id = frame.id;
        let old_config = self.task_observer.config_for_task(task_id);
        let requested_action = match (&frame.action, old_config.is_some()) {
            (TaskObserveRequestAction::Disable, _) => "disable",
            (TaskObserveRequestAction::Enable(_), true) => "replace",
            (TaskObserveRequestAction::Enable(_), false) => "enable",
        };
        let requested_config = match frame.action {
            TaskObserveRequestAction::Enable(config) => Some(config),
            TaskObserveRequestAction::Disable => None,
        };

        let snapshot = self.background_tasks.get(task_id);
        let validation = match snapshot.as_ref() {
            None => Err(("task_not_running", "task does not exist")),
            Some(snapshot) if snapshot.owner != TaskOwner::Main => Err((
                "owner_not_eligible",
                "only Main-owned tasks can observe the public conversation",
            )),
            Some(snapshot) if snapshot.state != TaskState::Running => Err((
                "task_not_running",
                "task must be Running to configure observation",
            )),
            Some(_) => Ok(()),
        };
        let writer = self.background_tasks.stdin_writer(task_id);
        let validation = validation.and_then(|()| {
            writer.as_ref().map(|_| ()).ok_or((
                "stdin_unsupported",
                "task has no supported interactive stdin writer",
            ))
        });
        let validation = validation.and_then(|()| {
            if requested_config.is_some_and(|config| {
                config.delivery == TaskObserveDelivery::StreamText
                    && !self.llm_text_preview_enabled.load(Ordering::SeqCst)
            }) {
                Err((
                    "preview_disabled",
                    "stream_text requires llm_text_preview.enabled=true",
                ))
            } else {
                Ok(())
            }
        });

        if let Err((code, message)) = validation {
            if let Some(writer) = writer.as_ref() {
                self.attempt_task_observe_failure_result(
                    task_id,
                    writer.as_ref(),
                    &request_id,
                    code,
                    message,
                );
            }
            self.append_task_observer_request_lifecycle(
                "task_observer.failed",
                task_id,
                &request_id,
                requested_action,
                requested_config,
                Some(code),
            );
            return;
        }
        let writer = writer.expect("validated writer exists");
        let frame_cap = writer.atomic_frame_cap();

        if let Some(config) = requested_config {
            if config.delivery == TaskObserveDelivery::StreamText {
                self.ensure_task_observer_preview_loop();
            }
            let success_result =
                match task_observe_result_enabled_frame(&request_id, config, frame_cap) {
                    Ok(frame) => frame,
                    Err(error) => {
                        self.attempt_task_observe_failure_result(
                            task_id,
                            writer.as_ref(),
                            &request_id,
                            "result_build_failed",
                            &error,
                        );
                        self.append_task_observer_request_lifecycle(
                            "task_observer.failed",
                            task_id,
                            &request_id,
                            requested_action,
                            Some(config),
                            Some("result_build_failed"),
                        );
                        return;
                    }
                };
            let prepared =
                match self
                    .task_observer
                    .prepare(task_id.to_owned(), config, writer.clone())
                {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        self.attempt_task_observe_failure_result(
                            task_id,
                            writer.as_ref(),
                            &request_id,
                            "observer_prepare_failed",
                            &error,
                        );
                        self.append_task_observer_request_lifecycle(
                            "task_observer.failed",
                            task_id,
                            &request_id,
                            requested_action,
                            Some(config),
                            Some("observer_prepare_failed"),
                        );
                        return;
                    }
                };

            if old_config.is_some() {
                self.task_observer.retire_and_wait(task_id).await;
            }
            let commit = self.commit_task_observer_result(task_id, || {
                self.task_observer.write_result_and_activate(prepared, || {
                    try_write_task_stdin_frame(
                        writer.as_ref(),
                        TaskStdinFrameKind::ObserveResult,
                        success_result.as_bytes(),
                    )
                    .map(|_| ())
                })
            });
            if let Err(error) = commit {
                let (code, message) = match error {
                    ObserverCommitError::AdmissionClosed => (
                        "task_not_running",
                        "task observer admission closed before result write".to_owned(),
                    ),
                    ObserverCommitError::Write(error) => ("result_write_failed", error),
                };
                self.append_task_observer_request_lifecycle(
                    "task_observer.failed",
                    task_id,
                    &request_id,
                    requested_action,
                    Some(config),
                    Some(code),
                );
                self.record_internal_stdio_diagnostic(
                    "task_observer",
                    task_id,
                    TaskFrameDiagnostic {
                        op: Some("observe_result".to_owned()),
                        code,
                        message: bounded_chars(&message, 512),
                        request_id: Some(request_id),
                    },
                );
                return;
            }
            self.append_task_observer_request_lifecycle(
                if old_config.is_some() {
                    "task_observer.replaced"
                } else {
                    "task_observer.enabled"
                },
                task_id,
                &request_id,
                requested_action,
                Some(config),
                None,
            );
            return;
        }

        let success_result = match task_observe_result_disabled_frame(&request_id, frame_cap) {
            Ok(frame) => frame,
            Err(error) => {
                self.attempt_task_observe_failure_result(
                    task_id,
                    writer.as_ref(),
                    &request_id,
                    "result_build_failed",
                    &error,
                );
                self.append_task_observer_request_lifecycle(
                    "task_observer.failed",
                    task_id,
                    &request_id,
                    requested_action,
                    None,
                    Some("result_build_failed"),
                );
                return;
            }
        };
        self.task_observer.retire_and_wait(task_id).await;
        match self.commit_task_observer_result(task_id, || {
            self.task_observer.write_result_if_admitted(task_id, || {
                try_write_task_stdin_frame(
                    writer.as_ref(),
                    TaskStdinFrameKind::ObserveResult,
                    success_result.as_bytes(),
                )
                .map(|_| ())
            })
        }) {
            Ok(_) => self.append_task_observer_request_lifecycle(
                "task_observer.disabled",
                task_id,
                &request_id,
                requested_action,
                None,
                None,
            ),
            Err(ObserverCommitError::AdmissionClosed) => {
                self.append_task_observer_request_lifecycle(
                    "task_observer.failed",
                    task_id,
                    &request_id,
                    requested_action,
                    None,
                    Some("task_not_running"),
                );
            }
            Err(ObserverCommitError::Write(error)) => {
                self.append_task_observer_request_lifecycle(
                    "task_observer.failed",
                    task_id,
                    &request_id,
                    requested_action,
                    None,
                    Some("result_write_failed"),
                );
                self.record_internal_stdio_diagnostic(
                    "task_observer",
                    task_id,
                    TaskFrameDiagnostic {
                        op: Some("observe_result".to_owned()),
                        code: "result_write_failed",
                        message: bounded_chars(&error, 512),
                        request_id: Some(request_id),
                    },
                );
            }
        }
    }

    pub(super) async fn handle_rejected_task_observe_request(
        self: &Arc<Self>,
        task_id: &str,
        frame: TaskObserveRequestRejectedFrame,
    ) {
        let transition = self.task_observer.transition_for(task_id);
        let _transition = transition.lock().await;
        self.task_observer.wait_for_retirement(task_id).await;
        self.record_internal_stdio_diagnostic(
            "task_stdio_protocol",
            task_id,
            TaskFrameDiagnostic {
                op: Some("observe_request".to_owned()),
                code: "observe_request_rejected",
                message: frame.exception.message.clone(),
                request_id: Some(frame.id.clone()),
            },
        );
        let snapshot = self.background_tasks.get(task_id);
        let eligibility_error = match snapshot.as_ref() {
            None => Some(("task_not_running", "task does not exist")),
            Some(snapshot) if snapshot.owner != TaskOwner::Main => Some((
                "owner_not_eligible",
                "only Main-owned tasks can observe the public conversation",
            )),
            Some(snapshot) if snapshot.state != TaskState::Running => Some((
                "task_not_running",
                "task must be Running to configure observation",
            )),
            Some(_) => None,
        };
        let Some(writer) = self.background_tasks.stdin_writer(task_id) else {
            return;
        };
        let (code, message) = eligibility_error.unwrap_or((
            frame.exception.code.as_str(),
            frame.exception.message.as_str(),
        ));
        if let Err((failure_code, ObserverCommitError::Write(error))) = self
            .write_task_observe_failure_result(task_id, writer.as_ref(), &frame.id, code, message)
        {
            self.record_observe_result_failure(task_id, &frame.id, failure_code, &error);
        }
    }

    fn write_task_observe_failure_result(
        &self,
        task_id: &str,
        writer: &dyn TaskStdinWriter,
        request_id: &str,
        code: &str,
        message: &str,
    ) -> Result<(), (&'static str, ObserverCommitError)> {
        let frame = task_observe_result_failure_frame(
            request_id,
            code,
            message,
            false,
            writer.atomic_frame_cap(),
        )
        .map_err(|error| {
            (
                "failure_result_build_failed",
                ObserverCommitError::Write(error),
            )
        })?;
        self.commit_task_observer_result(task_id, || {
            self.task_observer.write_result_if_admitted(task_id, || {
                try_write_task_stdin_frame(
                    writer,
                    TaskStdinFrameKind::ObserveResult,
                    frame.as_bytes(),
                )
                .map(|_| ())
            })
        })
        .map_err(|error| ("failure_result_write_failed", error))
    }

    fn attempt_task_observe_failure_result(
        &self,
        task_id: &str,
        writer: &dyn TaskStdinWriter,
        request_id: &str,
        code: &str,
        message: &str,
    ) {
        if let Err((failure_code, ObserverCommitError::Write(error))) =
            self.write_task_observe_failure_result(task_id, writer, request_id, code, message)
        {
            self.record_observe_result_failure(task_id, request_id, failure_code, &error);
        }
    }

    fn record_observe_result_failure(
        &self,
        task_id: &str,
        request_id: &str,
        code: &'static str,
        error: &str,
    ) {
        self.record_internal_stdio_diagnostic(
            "task_observer",
            task_id,
            TaskFrameDiagnostic {
                op: Some("observe_result".to_owned()),
                code,
                message: bounded_chars(error, 512),
                request_id: Some(request_id.to_owned()),
            },
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn append_task_observer_request_lifecycle(
        &self,
        event_type: &'static str,
        task_id: &str,
        request_id: &str,
        requested_action: &'static str,
        requested_config: Option<TaskObserveConfig>,
        error_code: Option<&'static str>,
    ) {
        self.with_task_frame_commit(task_id, TaskFrameAdmissionKind::Observe, || {
            let active = self.task_observer.config_for_task(task_id);
            self.try_append_task_frame_event_and_status(
                event_type,
                json!({
                    "task_id": bounded_chars(task_id, 128),
                    "request_id": bounded_chars(request_id, 128),
                    "requested_action": requested_action,
                    "requested_delivery": requested_config.map(|config| config.delivery.as_str()),
                    "min_batch_chars": requested_config.and_then(|config| config.min_batch_chars),
                    "error_code": error_code,
                    "resulting_observing": active.is_some(),
                    "active_generation": self.task_observer.generation_for_task(task_id),
                    "active_delivery": active.map(|config| config.delivery.as_str()),
                }),
            )
        });
    }

    pub(in crate::service) fn record_task_observer_diagnostic(
        &self,
        diagnostic: TaskObserverDiagnostic,
    ) {
        if diagnostic.code != "observer_write_detail" {
            self.append_event_for_turn_or_record_error(
                None,
                "task_observer.detached",
                json!({
                    "task_id": bounded_chars(&diagnostic.task_id, 128),
                    "reason": diagnostic.code,
                }),
            );
            self.append_service_status_for_current_state(None);
        }
        self.record_internal_stdio_diagnostic(
            "task_observer",
            &diagnostic.task_id,
            TaskFrameDiagnostic {
                op: Some("observe".to_owned()),
                code: diagnostic.code,
                message: diagnostic.message,
                request_id: None,
            },
        );
    }

    pub(in crate::service) async fn retire_task_observer_for_exit(
        &self,
        task_id: &str,
        reason: &'static str,
    ) {
        let transition = self.task_observer.transition_if_present(task_id);
        let _transition = match transition.as_ref() {
            Some(transition) => Some(transition.lock().await),
            None => None,
        };
        if self.task_observer.retire_and_wait(task_id).await.is_some() {
            self.append_event_for_turn_or_record_error(
                None,
                "task_observer.detached",
                json!({"task_id": bounded_chars(task_id, 128), "reason": reason}),
            );
        }
    }
}
