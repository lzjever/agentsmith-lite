use super::*;

impl ServiceInner {
    pub(super) fn handle_task_registry_set_frame(
        &self,
        task_id: &str,
        frame: TaskRegistrySetFrame,
    ) {
        self.with_task_frame_commit(task_id, TaskFrameAdmissionKind::RegistrySet, || {
            let task = self
                .background_tasks
                .get(task_id)
                .expect("task frame commit requires a running task");
            let Some(store) = self.registry_store.as_ref() else {
                self.handle_task_registry_diagnostic(
                    task_id,
                    TaskFrameDiagnostic {
                        op: Some("registry_set".to_owned()),
                        code: "registry_disabled",
                        message: "registry is not enabled".to_owned(),
                        request_id: frame.id,
                    },
                );
                return Ok(());
            };

            let default_source = default_registry_source_for_task(&task);
            let request_id = frame.id.clone();
            let request = frame.into_request(default_source);
            let origin = managed_task_registry_origin(&task);
            if let Err(error) = store.set(RegistryWriterKind::ManagedTask, origin, request) {
                self.handle_task_registry_diagnostic(
                    task_id,
                    TaskFrameDiagnostic {
                        op: Some("registry_set".to_owned()),
                        code: error.code(),
                        message: error.to_string(),
                        request_id,
                    },
                );
            }
            Ok(())
        });
    }

    pub(super) fn handle_task_registry_get_frame(
        &self,
        task_id: &str,
        frame: TaskRegistryGetFrame,
    ) {
        self.with_task_frame_commit(task_id, TaskFrameAdmissionKind::RegistryGet, || {
            let Some(writer) = self.background_tasks.stdin_writer(task_id) else {
                self.record_task_registry_write_failure(
                    task_id,
                    &frame.id,
                    "task stdin is not writable",
                );
                return Ok(());
            };
            let Some(writer_cap) =
                self.registry_stdio_writer_cap(task_id, &frame.id, writer.as_ref())
            else {
                return Ok(());
            };

            let Some(store) = self.registry_store.as_ref() else {
                let response = registry_error_stdio_frame(
                    &frame.id,
                    "registry_disabled",
                    "registry is not enabled",
                    writer_cap,
                );
                self.write_task_registry_response(task_id, &frame.id, writer, response);
                return Ok(());
            };
            let response_cap =
                stdio_registry_response_cap(store.config().max_response_bytes).min(writer_cap);
            let response = match store.get(frame.query()) {
                Ok(result) => registry_snapshot_stdio_frame(&frame.id, result, response_cap),
                Err(error) => registry_error_stdio_frame(
                    &frame.id,
                    error.code(),
                    &error.to_string(),
                    response_cap,
                ),
            };
            self.write_task_registry_response(task_id, &frame.id, writer, response);
            Ok(())
        });
    }

    pub(super) fn handle_task_registry_delete_frame(
        &self,
        task_id: &str,
        frame: TaskRegistryDeleteFrame,
    ) {
        self.with_task_frame_commit(task_id, TaskFrameAdmissionKind::RegistryDelete, || {
            let task = self
                .background_tasks
                .get(task_id)
                .expect("task frame commit requires a running task");
            let Some(store) = self.registry_store.as_ref() else {
                self.handle_task_registry_diagnostic(
                    task_id,
                    TaskFrameDiagnostic {
                        op: Some("registry_delete".to_owned()),
                        code: "registry_disabled",
                        message: "registry is not enabled".to_owned(),
                        request_id: frame.id,
                    },
                );
                return Ok(());
            };

            let request_id = frame.id;
            let origin = managed_task_registry_origin(&task);
            if let Err(error) = store.delete(RegistryWriterKind::ManagedTask, origin, frame.topic) {
                self.handle_task_registry_diagnostic(
                    task_id,
                    TaskFrameDiagnostic {
                        op: Some("registry_delete".to_owned()),
                        code: error.code(),
                        message: error.to_string(),
                        request_id,
                    },
                );
            }
            Ok(())
        });
    }

    fn write_task_registry_response(
        &self,
        task_id: &str,
        request_id: &str,
        writer: Arc<dyn TaskStdinWriter>,
        frame: String,
    ) {
        let result = try_write_task_stdin_frame(
            writer.as_ref(),
            TaskStdinFrameKind::Registry,
            frame.as_bytes(),
        );
        match result {
            Ok(delivered) => {
                self.record_delivered_task_stdin_diagnostic(
                    "task_stdio_registry",
                    task_id,
                    TaskStdinFrameKind::Registry,
                    Some(request_id.to_owned()),
                    delivered,
                );
            }
            Err(error) => self.record_task_registry_write_failure(task_id, request_id, &error),
        }
    }
}
