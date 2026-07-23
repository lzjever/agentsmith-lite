use super::*;

#[derive(Debug, Clone, Default)]
pub(in crate::service) struct InternalStdioDiagnostics {
    total: u64,
    by_domain: HashMap<String, u64>,
    by_code: HashMap<String, u64>,
    last: Option<Value>,
}

impl InternalStdioDiagnostics {
    fn record(&mut self, domain: &'static str, code: &'static str, summary: Value) {
        self.total = self.total.saturating_add(1);
        increment_counter(&mut self.by_domain, domain);
        increment_counter(&mut self.by_code, code);
        self.last = Some(summary);
    }

    fn to_json(&self) -> Value {
        json!({
            "total": self.total,
            "by_domain": self.by_domain,
            "by_code": self.by_code,
            "last": self.last
        })
    }
}

fn increment_counter(counters: &mut HashMap<String, u64>, key: &str) {
    let entry = counters.entry(key.to_owned()).or_insert(0);
    *entry = entry.saturating_add(1);
}

impl ServiceInner {
    pub(in crate::service) fn stdio_diagnostics_summary(&self) -> Value {
        self.stdio_diagnostics
            .lock()
            .expect("stdio diagnostics mutex poisoned")
            .to_json()
    }

    pub(super) fn write_task_request_profile_for_snapshot(
        &self,
        event_name: &'static str,
        snapshot: &TaskRequestSnapshot,
    ) {
        let Some(profiler) = self.profiler() else {
            return;
        };
        let Ok(mut profiler) = profiler.lock() else {
            return;
        };
        let now = profiler.now();
        let state = task_request_state_name(snapshot.state);
        let mut row = CsvEventRow::new("task_ask", event_name, state)
            .timing(now, None)
            .field("task_id", &snapshot.task_id)
            .field("task_ask_id", &snapshot.request_id)
            .field("task_urgency", snapshot.urgency.as_str())
            .field("task_ask_bytes", snapshot.request.len())
            .field(
                "task_expect_bytes",
                snapshot.expect.as_deref().map(str::len).unwrap_or(0),
            )
            .field("task_state", state)
            .field("tool_call_id", &snapshot.tool_call_id)
            .field("tool_name", &snapshot.tool_name);
        if snapshot.state.is_terminal() && snapshot.state != TaskRequestState::Written {
            row = row.field("error_kind", state).optional_field(
                "error_message_truncated",
                snapshot.failure_reason.as_deref(),
            );
        }
        let _ = profiler.write_event_row(row);
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn write_rejected_task_request_profile(
        &self,
        task_id: &str,
        request_id: Option<&str>,
        urgency: Option<InputUrgency>,
        request_bytes: Option<usize>,
        expect_bytes: Option<usize>,
        error_kind: &'static str,
        error_message: &str,
    ) {
        let Some(profiler) = self.profiler() else {
            return;
        };
        let Ok(mut profiler) = profiler.lock() else {
            return;
        };
        let now = profiler.now();
        let row = CsvEventRow::new("task_ask", "task_ask.rejected", "rejected")
            .timing(now, None)
            .field("task_id", task_id)
            .optional_field("task_ask_id", request_id)
            .optional_field("task_urgency", urgency.map(|urgency| urgency.as_str()))
            .optional_field("task_ask_bytes", request_bytes)
            .optional_field("task_expect_bytes", expect_bytes)
            .field("task_state", "rejected")
            .field("error_kind", error_kind)
            .field("error_retryable", false)
            .field("error_message_truncated", bounded_chars(error_message, 256));
        let _ = profiler.write_event_row(row);
    }

    pub(in crate::service) fn write_task_tell_profile(
        &self,
        event_name: &'static str,
        snapshot: &TaskTellSnapshot,
    ) {
        let Some(profiler) = self.profiler() else {
            return;
        };
        let Ok(mut profiler) = profiler.lock() else {
            return;
        };
        let now = profiler.now();
        let mut row = CsvEventRow::new("task_tell", event_name, snapshot.state)
            .timing(now, None)
            .field("task_id", &snapshot.task_id)
            .field("task_tell_id", &snapshot.tell_id)
            .field("task_urgency", snapshot.urgency.as_str())
            .field("task_tell_bytes", snapshot.message.len())
            .field("task_state", snapshot.state)
            .field("tool_call_id", &snapshot.tool_call_id)
            .field("tool_name", &snapshot.tool_name);
        if snapshot.failure_reason.is_some() {
            row = row.field("error_kind", snapshot.state).optional_field(
                "error_message_truncated",
                snapshot.failure_reason.as_deref(),
            );
        }
        let _ = profiler.write_event_row(row);
    }

    pub(super) fn write_task_send_profile(
        &self,
        event_name: &'static str,
        outcome: &TaskSendOutcome,
    ) {
        let Some(profiler) = self.profiler() else {
            return;
        };
        let Ok(mut profiler) = profiler.lock() else {
            return;
        };
        let now = profiler.now();
        let status = task_send_status_name(&outcome.status);
        let mut row = CsvEventRow::new("task_send", event_name, status)
            .timing(now, None)
            .field("task_id", &outcome.task_id)
            .optional_field("task_send_id", outcome.send_id.as_deref())
            .field("task_state", status);
        if !outcome.ok() {
            row = row
                .field("error_kind", status)
                .field("error_message_truncated", &outcome.message);
        }
        let _ = profiler.write_event_row(row);
    }

    pub(super) fn write_task_reply_profile(
        &self,
        event_name: &'static str,
        outcome: &TaskReplyOutcome,
    ) {
        if let Some(snapshot) = outcome.snapshot.as_ref() {
            self.write_task_request_profile_for_snapshot(event_name, snapshot);
            return;
        }
        let Some(task_id) = outcome.task_id.as_deref() else {
            return;
        };
        let Some(request_id) = outcome.request_id.as_deref() else {
            return;
        };
        let Some(profiler) = self.profiler() else {
            return;
        };
        let Ok(mut profiler) = profiler.lock() else {
            return;
        };
        let now = profiler.now();
        let status = task_reply_status_name(&outcome.status);
        let row = CsvEventRow::new("task_ask", event_name, status)
            .timing(now, None)
            .field("task_id", task_id)
            .field("task_ask_id", request_id)
            .field("task_state", status)
            .field("error_kind", status)
            .field("error_message_truncated", &outcome.message);
        let _ = profiler.write_event_row(row);
    }

    pub(super) fn record_delivered_task_stdin_diagnostic(
        &self,
        domain: &'static str,
        task_id: &str,
        kind: TaskStdinFrameKind,
        request_id: Option<String>,
        delivered: TaskStdinWriteSuccess,
    ) {
        let Some(diagnostic) = delivered.diagnostic else {
            return;
        };
        self.record_internal_stdio_diagnostic(
            domain,
            task_id,
            TaskFrameDiagnostic {
                op: Some(kind.as_str().to_owned()),
                code: "stdin_write_diagnostic",
                message: bounded_chars(&diagnostic, 512),
                request_id,
            },
        );
    }

    pub(super) fn commit_task_internal_diagnostic(
        &self,
        domain: &'static str,
        task_id: &str,
        diagnostic: TaskFrameDiagnostic,
    ) {
        self.with_task_frame_commit(task_id, TaskFrameAdmissionKind::Diagnostic, || {
            self.record_internal_stdio_diagnostic(domain, task_id, diagnostic);
            Ok(())
        });
    }

    pub(super) fn record_internal_stdio_diagnostic(
        &self,
        domain: &'static str,
        task_id: &str,
        diagnostic: TaskFrameDiagnostic,
    ) {
        if self.is_failed_or_shutting_down() {
            return;
        }
        let code = diagnostic.code;
        let bounded_summary = json!({
            "domain": domain,
            "code": code,
            "task_id": bounded_chars(task_id, 128),
            "op": diagnostic.op.map(|op| bounded_chars(&op, 64)),
            "id": diagnostic.request_id.map(|id| bounded_chars(&id, 128)),
            "message": bounded_chars(&diagnostic.message, 512),
            "recorded_at": crate::formatting::system_time_rfc3339(SystemTime::now()),
        });
        self.stdio_diagnostics
            .lock()
            .expect("stdio diagnostics mutex poisoned")
            .record(domain, code, bounded_summary);
    }
}
