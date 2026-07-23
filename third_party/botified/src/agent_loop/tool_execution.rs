use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::{
    record_context_message, AgentConfig, AgentRunError, BackgroundExecutionHost, FinalToolSnapshot,
    RecordContextMessage, ToolExecutionPolicy,
};
use crate::formatting::bounded_chars;
use crate::tasks::{
    is_builtin_task_tool, BotifiedFrameEvent, BoundedTaskOutputSink, InteractiveStdioBridge,
    NewBackgroundTask, TaskState, TaskStdinWriter,
};
use crate::tools::{
    is_registry_tool_name, Tool, ToolError, ToolExecutionContext, ToolOutputSink,
    ToolOutputSnapshot, ToolTimeout,
};
use crate::types::{Message, ToolCall, ToolResult};

pub(super) async fn record_tool_result_or_detached_ack(
    message: &Message,
    context: RecordContextMessage<'_, '_>,
    detached_ack_persistence_target: Option<DetachedAckPersistenceTarget>,
) -> Result<(), AgentRunError> {
    if let Err(error) = record_context_message(message, context).await {
        if let Some(target) = detached_ack_persistence_target {
            let (host, task_id, tool_call, result) = target.terminal_to_finish_without_start(
                "background task ack persistence failed",
                "background_task_ack_persistence_failed",
                TaskState::Failed,
            );
            host.finish_task(task_id, tool_call, result).await;
        }
        return Err(error);
    }
    Ok(())
}

pub(super) struct DetachedAckPersistenceTarget {
    host: Arc<dyn BackgroundExecutionHost>,
    task_id: String,
    tool_call: ToolCall,
    cancel: CancellationToken,
}

impl DetachedAckPersistenceTarget {
    pub(super) fn from_run(run: &DetachedToolRun) -> Self {
        Self {
            host: run.host.clone(),
            task_id: run.task_id.clone(),
            tool_call: run.tool_call.clone(),
            cancel: run.cancel.clone(),
        }
    }

    fn terminal_to_finish_without_start(
        self,
        reason: &'static str,
        kind: &'static str,
        state: TaskState,
    ) -> (
        Arc<dyn BackgroundExecutionHost>,
        String,
        ToolCall,
        DetachedToolResult,
    ) {
        self.cancel.cancel();
        let result = detached_tool_terminal_result(&self.tool_call, reason, kind, state);
        (self.host, self.task_id, self.tool_call, result)
    }
}

fn detached_tool_terminal_result(
    tool_call: &ToolCall,
    reason: &'static str,
    kind: &'static str,
    state: TaskState,
) -> DetachedToolResult {
    DetachedToolResult {
        tool_result: ToolResult::error(
            tool_call.id.clone(),
            tool_call.name.clone(),
            reason,
            json!({"kind": kind}),
        ),
        state,
    }
}

pub(super) enum ToolExecutionOutcome {
    Inline(ToolResult),
    Detached {
        ack: ToolResult,
        run: Box<DetachedToolRun>,
    },
}

pub(super) struct DetachedToolRun {
    pub(super) host: Arc<dyn BackgroundExecutionHost>,
    pub(super) task_id: String,
    pub(super) task: NewBackgroundTask,
    pub(super) tool_call: ToolCall,
    pub(super) runnable: RunnableToolExecution,
    pub(super) output_sink: Option<Arc<BoundedTaskOutputSink>>,
    pub(super) prepublish_interactive_stdio: Option<Arc<PrepublishInteractiveStdioBridge>>,
    pub(super) cancel: CancellationToken,
    pub(super) pending: Option<BoxDetachedToolFuture>,
}

impl DetachedToolRun {
    pub(super) fn cancel(&self) {
        self.cancel.cancel();
        if let Some(bridge) = self.prepublish_interactive_stdio.as_ref() {
            bridge.reject_before_publish("task stdin registration cancelled before publication");
        }
    }

    pub(super) fn publish(&self) -> bool {
        let published = self
            .host
            .publish_task(self.task_id.clone(), self.task.clone());
        if published {
            if let Some(bridge) = self.prepublish_interactive_stdio.as_ref() {
                bridge.flush_after_publish();
            }
        }
        published
    }

    pub(super) fn terminal_to_finish_without_start(
        &self,
        reason: &'static str,
        kind: &'static str,
        state: TaskState,
    ) -> (
        Arc<dyn BackgroundExecutionHost>,
        String,
        ToolCall,
        DetachedToolResult,
    ) {
        self.cancel();
        let result = detached_tool_terminal_result(&self.tool_call, reason, kind, state);
        (
            self.host.clone(),
            self.task_id.clone(),
            self.tool_call.clone(),
            result,
        )
    }
}

pub(super) struct PrepublishInteractiveStdioBridge {
    inner: Arc<dyn InteractiveStdioBridge>,
    state: Mutex<PrepublishInteractiveStdioState>,
    notify: Notify,
}

struct PrepublishInteractiveStdioState {
    published: bool,
    rejection: Option<String>,
    stdin_registration: Option<PendingStdinRegistration>,
    events: Vec<BotifiedFrameEvent>,
}

struct PendingStdinRegistration {
    writer: Arc<dyn TaskStdinWriter>,
}

impl PrepublishInteractiveStdioBridge {
    fn new(inner: Arc<dyn InteractiveStdioBridge>) -> Self {
        Self {
            inner,
            state: Mutex::new(PrepublishInteractiveStdioState {
                published: false,
                rejection: None,
                stdin_registration: None,
                events: Vec::new(),
            }),
            notify: Notify::new(),
        }
    }

    async fn wait_for_prepublish_frame(&self) {
        loop {
            let notified = self.notify.notified();
            if self.has_buffered_events() {
                return;
            }
            notified.await;
        }
    }

    fn has_buffered_events(&self) -> bool {
        !self
            .state
            .lock()
            .expect("interactive stdio bridge mutex poisoned")
            .events
            .is_empty()
    }

    fn flush_after_publish(&self) {
        let (stdin_registration, events) = {
            let mut state = self
                .state
                .lock()
                .expect("interactive stdio bridge mutex poisoned");
            if state.published {
                return;
            }
            state.published = true;
            (
                state.stdin_registration.take(),
                std::mem::take(&mut state.events),
            )
        };
        if let Some(registration) = stdin_registration {
            let _ = self.inner.register_stdin_writer(registration.writer);
        }
        if !events.is_empty() {
            self.inner.handle_frame_events(events);
        }
    }

    fn reject_before_publish(&self, reason: impl Into<String>) {
        let reason = reason.into();
        {
            let mut state = self
                .state
                .lock()
                .expect("interactive stdio bridge mutex poisoned");
            if state.published {
                return;
            }
            state.rejection = Some(reason.clone());
            state.stdin_registration.take();
        }
    }
}

impl InteractiveStdioBridge for PrepublishInteractiveStdioBridge {
    fn register_stdin_writer(&self, writer: Arc<dyn TaskStdinWriter>) -> Result<(), String> {
        let pending = {
            let mut state = self
                .state
                .lock()
                .expect("interactive stdio bridge mutex poisoned");
            if state.published {
                false
            } else if let Some(error) = state.rejection.clone() {
                return Err(error);
            } else {
                if state.stdin_registration.is_some() {
                    return Err("task stdin writer registration is already pending".to_owned());
                }
                state.stdin_registration = Some(PendingStdinRegistration {
                    writer: writer.clone(),
                });
                true
            }
        };
        if pending {
            return Ok(());
        }
        self.inner.register_stdin_writer(writer)
    }

    fn handle_frame_events(&self, events: Vec<BotifiedFrameEvent>) {
        if events.is_empty() {
            return;
        }
        let events = {
            let mut state = self
                .state
                .lock()
                .expect("interactive stdio bridge mutex poisoned");
            if state.published {
                Some(events)
            } else {
                state.events.extend(events);
                self.notify.notify_waiters();
                None
            }
        };
        if let Some(events) = events {
            self.inner.handle_frame_events(events);
        }
    }
}

pub(super) type BoxDetachedToolFuture = Pin<Box<dyn Future<Output = DetachedToolResult> + Send>>;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DetachedToolResult {
    pub tool_result: ToolResult,
    pub state: TaskState,
}

#[derive(Clone)]
pub(super) struct RunnableToolExecution {
    pub(super) tool: Arc<dyn Tool>,
    pub(super) tool_call: ToolCall,
    pub(super) cwd: String,
    pub(super) provider_transcript_snapshot: Vec<Message>,
    pub(super) timeout: ToolTimeout,
    pub(super) output_sink: Option<Arc<dyn ToolOutputSink>>,
    pub(super) interactive_stdio: Option<Arc<dyn InteractiveStdioBridge>>,
}

enum PreparedToolExecution {
    Ready(ToolResult),
    Runnable(RunnableToolExecution),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct ToolExecutionControls {
    detach_after: Duration,
    timeout: Option<Duration>,
}

pub(super) const TOOL_TIMEOUT_CLEANUP_GRACE: Duration = Duration::from_secs(1);

fn is_builtin_inline_tool(name: &str) -> bool {
    is_builtin_task_tool(name) || is_registry_tool_name(name) || is_task_preset_tool_name(name)
}

fn is_task_preset_tool_name(name: &str) -> bool {
    matches!(name, "task_preset_list" | "task_preset_start")
}

pub(super) async fn execute_tool_call_with_policy(
    config: &AgentConfig,
    tools: &FinalToolSnapshot,
    tool_call: ToolCall,
    provider_transcript_snapshot: Vec<Message>,
    cancel: CancellationToken,
    background_host: Option<Arc<dyn BackgroundExecutionHost>>,
) -> ToolExecutionOutcome {
    if is_builtin_inline_tool(&tool_call.name) {
        let tool_cancel = cancel.child_token();
        let result = execute_builtin_inline_tool(
            config,
            tools,
            tool_call,
            provider_transcript_snapshot,
            tool_cancel.clone(),
        )
        .await;
        if tool_cancel.is_cancelled() {
            cancel.cancel();
        }
        return ToolExecutionOutcome::Inline(result);
    }

    let controls = match resolve_tool_execution_controls(&config.tool_execution, &tool_call) {
        Ok(controls) => controls,
        Err(result) => return ToolExecutionOutcome::Inline(result),
    };
    let task_label = match resolve_task_label(&tool_call) {
        Ok(label) => label,
        Err(result) => return ToolExecutionOutcome::Inline(result),
    };
    let task_id = background_host
        .as_ref()
        .map(|host| host.allocate_task_id())
        .unwrap_or_else(|| format!("inline_{}", artifact_task_component(&tool_call.id)));
    let output_sink = if tool_call.name == "bash" {
        match BoundedTaskOutputSink::create(
            &config.task_output,
            &config.cwd,
            task_id.clone(),
            background_host.as_ref().map(|host| host.task_manager()),
        ) {
            Ok(sink) => Some(sink),
            Err(error) => {
                return ToolExecutionOutcome::Inline(ToolResult::error(
                    tool_call.id,
                    tool_call.name,
                    error.to_string(),
                    json!({"kind": "output_artifact_error"}),
                ));
            }
        }
    } else {
        None
    };
    let interactive_stdio = match resolve_interactive_stdio(&tool_call, background_host.is_some()) {
        Ok(value) => value,
        Err(result) => return ToolExecutionOutcome::Inline(result),
    };
    if interactive_stdio && tool_call.name != "bash" {
        return ToolExecutionOutcome::Inline(ToolResult::error(
            tool_call.id,
            tool_call.name,
            "interactive_stdio is only supported by bash",
            json!({"kind": "invalid_tool_execution_control", "field": "interactive_stdio"}),
        ));
    }
    if interactive_stdio && background_host.is_none() {
        return ToolExecutionOutcome::Inline(ToolResult::error(
            tool_call.id,
            tool_call.name,
            "interactive_stdio requires background task execution",
            json!({"kind": "interactive_stdio_requires_background_task"}),
        ));
    }
    let prepublish_interactive_stdio = if interactive_stdio {
        background_host
            .as_ref()
            .and_then(|host| host.interactive_stdio_bridge(&task_id))
            .map(|bridge| Arc::new(PrepublishInteractiveStdioBridge::new(bridge)))
    } else {
        None
    };
    let interactive_bridge = prepublish_interactive_stdio
        .as_ref()
        .map(|bridge| bridge.clone() as Arc<dyn InteractiveStdioBridge>);
    let runnable_tool_call = strip_tool_execution_controls(tool_call.clone());
    let prepared = match prepare_tool_execution(
        config,
        tools,
        runnable_tool_call.clone(),
        provider_transcript_snapshot,
        controls,
        output_sink.clone(),
        interactive_bridge,
    ) {
        PreparedToolExecution::Ready(result) => return ToolExecutionOutcome::Inline(result),
        PreparedToolExecution::Runnable(runnable) => runnable,
    };
    let detach_after = controls.detach_after;
    let Some(host) = background_host else {
        let result = prepared.execute(cancel.child_token()).await;
        if result.state == TaskState::Cancelled {
            cancel.cancel();
        }
        return ToolExecutionOutcome::Inline(result.tool_result);
    };

    let ack = detached_ack_tool_result(
        &runnable_tool_call,
        &task_id,
        controls,
        output_sink.as_ref(),
    );
    let background_cancel = CancellationToken::new();
    let now = SystemTime::now();
    let timeout_at = controls.timeout.map(|timeout| now + timeout);
    let mut task = NewBackgroundTask::new(
        runnable_tool_call.id.clone(),
        runnable_tool_call.name.clone(),
        runnable_tool_call.arguments_json_string(),
    )
    .with_task_label(task_label)
    .with_detached_at(now)
    .with_cancel_token(background_cancel.clone());
    if let Some(timeout_at) = timeout_at {
        task = task.with_timeout_at(timeout_at);
    }
    let task = if let Some(path) = output_sink.as_ref().and_then(|sink| sink.artifact_path()) {
        task.with_artifact_path(path)
    } else {
        task
    };

    if detach_after.is_zero() {
        if let Err(result) = admit_detached_task(config, &tool_call, host.as_ref()) {
            background_cancel.cancel();
            return ToolExecutionOutcome::Inline(result);
        }
        return ToolExecutionOutcome::Detached {
            ack,
            run: Box::new(DetachedToolRun {
                host,
                task_id,
                task,
                tool_call,
                runnable: prepared,
                output_sink,
                prepublish_interactive_stdio,
                cancel: background_cancel,
                pending: None,
            }),
        };
    }

    let mut pending = prepared.clone().boxed_execute(background_cancel.clone());
    let effective_detach_after = controls
        .timeout
        .map(|timeout| detach_after.min(timeout))
        .unwrap_or(detach_after);
    tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            background_cancel.cancel();
            if let Some(bridge) = prepublish_interactive_stdio.as_ref() {
                bridge.reject_before_publish("task stdin registration cancelled before publication");
            }
            ToolExecutionOutcome::Inline(ToolResult::error(
                tool_call.id,
                tool_call.name,
                "tool execution aborted",
                json!({"kind": "tool_aborted"}),
            ))
        },
        _ = tokio::time::sleep(effective_detach_after) => {
            if let Err(result) = admit_detached_task(config, &tool_call, host.as_ref()) {
                background_cancel.cancel();
                if let Some(bridge) = prepublish_interactive_stdio.as_ref() {
                    bridge.reject_before_publish("task stdin registration rejected before publication");
                }
                return ToolExecutionOutcome::Inline(result);
            }
            ToolExecutionOutcome::Detached {
                ack,
                run: Box::new(DetachedToolRun {
                    host,
                    task_id,
                    task,
                    tool_call,
                    runnable: prepared,
                    output_sink,
                    prepublish_interactive_stdio,
                    cancel: background_cancel,
                    pending: Some(pending),
                }),
            }
        },
        _ = async {
            if let Some(bridge) = prepublish_interactive_stdio.as_ref() {
                bridge.wait_for_prepublish_frame().await;
            } else {
                std::future::pending::<()>().await;
            }
        }, if prepublish_interactive_stdio.is_some() => {
            if let Err(result) = admit_detached_task(config, &tool_call, host.as_ref()) {
                background_cancel.cancel();
                if let Some(bridge) = prepublish_interactive_stdio.as_ref() {
                    bridge.reject_before_publish("task stdin registration rejected before publication");
                }
                return ToolExecutionOutcome::Inline(result);
            }
            ToolExecutionOutcome::Detached {
                ack,
                run: Box::new(DetachedToolRun {
                    host,
                    task_id,
                    task,
                    tool_call,
                    runnable: prepared,
                    output_sink,
                    prepublish_interactive_stdio,
                    cancel: background_cancel,
                    pending: Some(pending),
                }),
            }
        },
        result = &mut pending => {
            if result.state == TaskState::Cancelled {
                cancel.cancel();
            }
            ToolExecutionOutcome::Inline(result.tool_result)
        },
    }
}

fn admit_detached_task(
    config: &AgentConfig,
    tool_call: &ToolCall,
    host: &dyn BackgroundExecutionHost,
) -> Result<(), ToolResult> {
    let running = host.task_manager().running_or_cancelling_count();
    if running >= config.tool_execution.max_concurrent_tasks {
        return Err(ToolResult::error(
            tool_call.id.clone(),
            tool_call.name.clone(),
            format!(
                "background task concurrency limit reached: {} running or cancelling tasks",
                config.tool_execution.max_concurrent_tasks
            ),
            json!({
                "kind": "background_task_concurrency_limit",
                "max_concurrent_tasks": config.tool_execution.max_concurrent_tasks,
                "running_or_cancelling_tasks": running
            }),
        ));
    }
    Ok(())
}

fn prepare_tool_execution(
    config: &AgentConfig,
    tools: &FinalToolSnapshot,
    tool_call: ToolCall,
    provider_transcript_snapshot: Vec<Message>,
    controls: ToolExecutionControls,
    output_sink: Option<Arc<BoundedTaskOutputSink>>,
    interactive_stdio: Option<Arc<dyn InteractiveStdioBridge>>,
) -> PreparedToolExecution {
    if let Some(error) = tool_call.arguments_error.clone() {
        return PreparedToolExecution::Ready(ToolResult::error(
            tool_call.id,
            tool_call.name,
            format!("invalid tool arguments: {error}"),
            json!({
                "kind": "invalid_tool_arguments",
                "error": error
            }),
        ));
    }

    let Some(tool) = tools.tool(&tool_call.name) else {
        return PreparedToolExecution::Ready(ToolResult::error(
            tool_call.id,
            tool_call.name,
            "tool not found",
            json!({"kind": "tool_not_found"}),
        ));
    };

    let output_sink = output_sink.map(|sink| sink as Arc<dyn ToolOutputSink>);
    PreparedToolExecution::Runnable(RunnableToolExecution {
        tool: tool.clone(),
        tool_call,
        cwd: config.cwd.clone(),
        provider_transcript_snapshot,
        timeout: match controls.timeout {
            Some(timeout) => ToolTimeout::Deadline(timeout),
            None => ToolTimeout::NoDeadline,
        },
        output_sink,
        interactive_stdio,
    })
}

async fn execute_builtin_inline_tool(
    config: &AgentConfig,
    tools: &FinalToolSnapshot,
    tool_call: ToolCall,
    provider_transcript_snapshot: Vec<Message>,
    cancel: CancellationToken,
) -> ToolResult {
    if let Some(error) = tool_call.arguments_error.clone() {
        return ToolResult::error(
            tool_call.id,
            tool_call.name,
            format!("invalid tool arguments: {error}"),
            json!({
                "kind": "invalid_tool_arguments",
                "error": error
            }),
        );
    }

    let Some(tool) = tools.tool(&tool_call.name) else {
        return ToolResult::error(
            tool_call.id,
            tool_call.name,
            "tool not found",
            json!({"kind": "tool_not_found"}),
        );
    };

    let tool_name = tool_call.name.clone();
    let tool_call_id = tool_call.id.clone();
    match tool
        .execute(
            tool_call,
            ToolExecutionContext::new(config.cwd.clone())
                .with_provider_transcript_snapshot(provider_transcript_snapshot),
            cancel,
        )
        .await
    {
        Ok(result) => result,
        Err(error) => ToolResult::error(
            tool_call_id,
            tool_name,
            error.to_string(),
            json!({"kind": "tool_error"}),
        ),
    }
}

impl RunnableToolExecution {
    fn boxed_execute(self, cancel: CancellationToken) -> BoxDetachedToolFuture {
        Box::pin(async move { self.execute(cancel).await })
    }

    async fn execute(self, cancel: CancellationToken) -> DetachedToolResult {
        let tool_name = self.tool_call.name.clone();
        let tool_call_id = self.tool_call.id.clone();
        if cancel.is_cancelled() {
            return DetachedToolResult {
                tool_result: cancelled_tool_result(tool_call_id, tool_name),
                state: TaskState::Cancelled,
            };
        }
        let mut context = ToolExecutionContext::new(self.cwd);
        context = context.with_provider_transcript_snapshot(self.provider_transcript_snapshot);
        match self.timeout {
            ToolTimeout::Default => {}
            ToolTimeout::Deadline(timeout) => {
                context = context.with_timeout(timeout);
            }
            ToolTimeout::NoDeadline => {
                context = context.with_no_deadline();
            }
        }
        let has_output_sink = self.output_sink.is_some();
        if let Some(output_sink) = self.output_sink {
            context = context.with_output_sink(output_sink);
        }
        if let Some(interactive_stdio) = self.interactive_stdio {
            context = context.with_interactive_stdio(interactive_stdio);
        }
        let future = self.tool.execute(self.tool_call, context, cancel.clone());
        tokio::pin!(future);
        let wrapper_timeout = self.timeout.deadline().filter(|_| !has_output_sink);
        let result = if let Some(timeout) = wrapper_timeout {
            tokio::select! {
                result = &mut future => result,
                _ = tokio::time::sleep(timeout) => {
                    cancel.cancel();
                    let observed = tokio::time::timeout(TOOL_TIMEOUT_CLEANUP_GRACE, &mut future)
                        .await
                        .ok();
                    return DetachedToolResult {
                        tool_result: timeout_tool_result(tool_call_id, tool_name, observed),
                        state: TaskState::TimedOut,
                    };
                }
            }
        } else {
            future.await
        };

        let tool_result = match result {
            Ok(result) => result,
            Err(error) => ToolResult::error(
                tool_call_id,
                tool_name,
                error.to_string(),
                json!({"kind": "tool_error"}),
            ),
        };
        if cancel.is_cancelled() {
            return DetachedToolResult {
                tool_result,
                state: TaskState::Cancelled,
            };
        }
        let state = task_state_from_tool_result(&tool_result);
        DetachedToolResult { tool_result, state }
    }
}

fn cancelled_tool_result(tool_call_id: String, tool_name: String) -> ToolResult {
    ToolResult::error(
        tool_call_id,
        tool_name,
        "tool execution cancelled",
        json!({"kind": "tool_cancelled", "cancelled": true}),
    )
}

fn timeout_tool_result(
    tool_call_id: String,
    tool_name: String,
    observed: Option<Result<ToolResult, ToolError>>,
) -> ToolResult {
    match observed {
        Some(Ok(mut result)) => {
            result.is_error = true;
            match &mut result.details {
                Value::Object(details) => {
                    details.insert("kind".to_owned(), json!("tool_timeout"));
                    details.insert("timed_out".to_owned(), json!(true));
                }
                _ => {
                    result.details = json!({
                        "kind": "tool_timeout",
                        "timed_out": true
                    });
                }
            }
            if !result.text.to_ascii_lowercase().contains("timed out") {
                result.text = format!("tool execution timed out\n{}", result.text);
            }
            result
        }
        Some(Err(error)) => ToolResult::error(
            tool_call_id,
            tool_name,
            format!("tool execution timed out; cleanup failed: {error}"),
            json!({
                "kind": "tool_timeout",
                "timed_out": true,
                "cleanup_error": error.to_string()
            }),
        ),
        None => ToolResult::error(
            tool_call_id,
            tool_name,
            "tool execution timed out",
            json!({"kind": "tool_timeout", "timed_out": true}),
        ),
    }
}

fn task_state_from_tool_result(tool_result: &ToolResult) -> TaskState {
    if tool_result
        .details
        .get("timed_out")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        TaskState::TimedOut
    } else if tool_result.is_error {
        TaskState::Failed
    } else {
        TaskState::Completed
    }
}

#[cfg(test)]
pub(super) fn start_detached_tool_run(run: Box<DetachedToolRun>) {
    if !run.publish() {
        run.cancel();
        return;
    }
    start_published_detached_tool_run(run);
}

pub(super) fn start_published_detached_tool_run(run: Box<DetachedToolRun>) {
    let DetachedToolRun {
        host,
        task_id,
        task,
        tool_call,
        runnable,
        output_sink,
        prepublish_interactive_stdio: _,
        cancel,
        pending,
    } = *run;
    drop(task);
    if let Some(output_sink) = output_sink.as_ref() {
        output_sink.sync_to_task_record();
    }
    tokio::spawn(async move {
        let supervise_cancel = runnable.timeout == ToolTimeout::NoDeadline;
        let supervisor_cancel = cancel.clone();
        let mut child = tokio::spawn(async move {
            match pending {
                Some(pending) => pending.await,
                None => runnable.execute(cancel).await,
            }
        });
        let result = if supervise_cancel {
            tokio::select! {
                biased;
                joined = &mut child => detached_tool_join_result(&tool_call, joined),
                _ = supervisor_cancel.cancelled() => {
                    match tokio::time::timeout(TOOL_TIMEOUT_CLEANUP_GRACE, &mut child).await {
                        Ok(joined) => detached_tool_join_result(&tool_call, joined),
                        Err(_) => {
                            child.abort();
                            let _ = child.await;
                            DetachedToolResult {
                                tool_result: cancelled_tool_result(
                                    tool_call.id.clone(),
                                    tool_call.name.clone(),
                                ),
                                state: TaskState::Cancelled,
                            }
                        }
                    }
                }
            }
        } else {
            detached_tool_join_result(&tool_call, child.await)
        };
        host.finish_task(task_id, tool_call, result).await;
    });
}

fn detached_tool_join_result(
    tool_call: &ToolCall,
    joined: Result<DetachedToolResult, tokio::task::JoinError>,
) -> DetachedToolResult {
    match joined {
        Ok(result) => result,
        Err(error) => detached_tool_join_error_result(tool_call, error),
    }
}

fn detached_tool_join_error_result(
    tool_call: &ToolCall,
    error: tokio::task::JoinError,
) -> DetachedToolResult {
    if error.is_panic() {
        let text = panic_payload_to_string(error.into_panic())
            .map(|message| format!("tool execution panicked: {message}"))
            .unwrap_or_else(|| "tool execution panicked".to_owned());
        return DetachedToolResult {
            tool_result: ToolResult::error(
                tool_call.id.clone(),
                tool_call.name.clone(),
                text,
                json!({"kind": "tool_panic"}),
            ),
            state: TaskState::Failed,
        };
    }

    DetachedToolResult {
        tool_result: ToolResult::error(
            tool_call.id.clone(),
            tool_call.name.clone(),
            format!("tool execution join failed: {error}"),
            json!({"kind": "tool_join_error"}),
        ),
        state: TaskState::Failed,
    }
}

fn panic_payload_to_string(payload: Box<dyn std::any::Any + Send + 'static>) -> Option<String> {
    match payload.downcast::<String>() {
        Ok(message) => Some(*message),
        Err(payload) => match payload.downcast::<&'static str>() {
            Ok(message) => Some((*message).to_owned()),
            Err(_) => None,
        },
    }
}

pub(super) fn background_task_publish_failed_tool_result(tool_call: &ToolCall) -> ToolResult {
    ToolResult::error(
        tool_call.id.clone(),
        tool_call.name.clone(),
        "background task could not be published",
        json!({"kind": "background_task_publish_failed"}),
    )
}

fn detached_ack_tool_result(
    tool_call: &ToolCall,
    task_id: &str,
    controls: ToolExecutionControls,
    output_sink: Option<&Arc<BoundedTaskOutputSink>>,
) -> ToolResult {
    let output = output_sink.map(|sink| sink.snapshot());
    let forced_termination_at = controls.timeout.map(|timeout| SystemTime::now() + timeout);
    let artifact_path = output
        .as_ref()
        .and_then(|snapshot| snapshot.artifact_path.as_ref())
        .map(|path| path.display().to_string());
    let mut text = format!(
        "Background task detached.\ntool: {}\nstatus: running\ntask_id: {task_id}\ndetach_after_secs: {}\ntimeout_secs: {}\nforced_termination_at: {}\n",
        tool_call.name,
        seconds_for_message(controls.detach_after),
        optional_seconds_for_message(controls.timeout),
        optional_system_time_rfc3339(forced_termination_at)
    );
    if let Some(path) = artifact_path.as_ref() {
        text.push_str(&format!("output_artifact_path: {path}\n"));
    }
    if let Some(snapshot) = output.as_ref() {
        text.push_str(&format!("output_live: {}\n", snapshot.output_live));
        text.push_str(&format!("output_complete: {}\n", snapshot.output_complete));
        text.push_str(&format!("output_bytes: {}\n", snapshot.output_bytes));
        text.push_str(&format!(
            "output_artifact_truncated: {}\n",
            snapshot.output_artifact_truncated
        ));
        text.push_str(&format!(
            "output_dropped_bytes: {}\n",
            snapshot.output_dropped_bytes
        ));
    }
    text.push_str(
        "This acknowledgement proves only running state and task identity, not success, completion, readiness, usable output, or callback delivery. Any terminal callback is best-effort.",
    );

    ToolResult::success(tool_call.id.clone(), tool_call.name.clone(), text).with_details(
        task_ack_details(
            tool_call,
            task_id,
            controls,
            forced_termination_at,
            output.as_ref(),
        ),
    )
}

fn task_ack_details(
    tool_call: &ToolCall,
    task_id: &str,
    controls: ToolExecutionControls,
    forced_termination_at: Option<SystemTime>,
    output: Option<&ToolOutputSnapshot>,
) -> Value {
    let mut details = json!({
        "kind": "background_task_detached",
        "background_task_detached": true,
        "task_id": task_id,
        "tool_call_id": tool_call.id,
        "tool_name": tool_call.name,
        "state": "running",
        "detach_after_secs": controls.detach_after.as_secs_f64(),
        "timeout_secs": controls.timeout.map(|timeout| timeout.as_secs_f64()),
        "forced_termination_at": forced_termination_at.map(crate::formatting::system_time_rfc3339),
        "arguments_summary": bounded_chars(&tool_call.arguments_json_string(), 512)
    });
    if let Some(output) = output {
        details["output_artifact_path"] = output
            .artifact_path
            .as_ref()
            .map(|path| json!(path.display().to_string()))
            .unwrap_or(Value::Null);
        details["output_live"] = json!(output.output_live);
        details["output_complete"] = json!(output.output_complete);
        details["output_bytes"] = json!(output.output_bytes);
        details["output_last_updated_at"] = output
            .output_last_updated_at
            .map(|time| json!(crate::formatting::system_time_rfc3339(time)))
            .unwrap_or(Value::Null);
        details["output_tail"] = json!(output.tail);
        details["output_tail_truncated"] = json!(output.output_tail_truncated);
        details["output_artifact_truncated"] = json!(output.output_artifact_truncated);
        details["output_dropped_bytes"] = json!(output.output_dropped_bytes);
    }
    details
}

pub(super) fn resolve_tool_execution_controls(
    policy: &ToolExecutionPolicy,
    tool_call: &ToolCall,
) -> Result<ToolExecutionControls, ToolResult> {
    let detach_after = match resolve_detach_after(policy, tool_call) {
        Ok(duration) => duration,
        Err(message) => {
            return Err(invalid_tool_control_result(
                tool_call,
                "detach_after_secs",
                message,
            ));
        }
    };
    let timeout = match resolve_timeout(policy, tool_call) {
        Ok(duration) => duration,
        Err(message) => {
            return Err(invalid_tool_control_result(
                tool_call,
                "timeout_secs",
                message,
            ));
        }
    };

    let detach_after = timeout
        .map(|timeout| detach_after.min(timeout))
        .unwrap_or(detach_after);

    Ok(ToolExecutionControls {
        detach_after,
        timeout,
    })
}

fn resolve_detach_after(
    policy: &ToolExecutionPolicy,
    tool_call: &ToolCall,
) -> Result<Duration, String> {
    let Some(duration) = parse_duration_field(tool_call, "detach_after_secs")? else {
        return Ok(policy.default_detach_after);
    };
    Ok(duration.min(policy.max_detach_after))
}

fn resolve_timeout(
    policy: &ToolExecutionPolicy,
    tool_call: &ToolCall,
) -> Result<Option<Duration>, String> {
    let Some(value) = tool_call.arguments.get("timeout_secs") else {
        return Ok(Some(policy.default_timeout));
    };
    if value.is_null() {
        return Ok(None);
    }
    if let Some(text) = value.as_str() {
        let text = text.trim();
        if text.is_empty() || text.eq_ignore_ascii_case("null") {
            return Ok(None);
        }
    }
    let duration = parse_duration_value(value)?;
    if duration.is_zero() {
        return Err("must be greater than 0".to_owned());
    }
    Ok(Some(duration.min(policy.max_timeout)))
}

fn parse_duration_field(tool_call: &ToolCall, field: &str) -> Result<Option<Duration>, String> {
    let Some(value) = tool_call.arguments.get(field) else {
        return Ok(None);
    };
    parse_duration_value(value).map(Some)
}

fn parse_duration_value(value: &Value) -> Result<Duration, String> {
    let seconds = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let text = text.trim();
            (!text.is_empty())
                .then(|| text.parse::<f64>().ok())
                .flatten()
        }
        _ => None,
    };
    let Some(seconds) = seconds else {
        return Err("must be a number".to_owned());
    };
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("must be a finite non-negative number".to_owned());
    }
    Ok(Duration::from_secs_f64(seconds))
}

pub(super) fn seconds_for_message(duration: Duration) -> String {
    let seconds = duration.as_secs_f64();
    if seconds.fract() == 0.0 {
        format!("{seconds:.0}")
    } else {
        seconds.to_string()
    }
}

fn optional_seconds_for_message(duration: Option<Duration>) -> String {
    duration
        .map(seconds_for_message)
        .unwrap_or_else(|| "null".to_owned())
}

fn optional_system_time_rfc3339(time: Option<SystemTime>) -> String {
    time.map(crate::formatting::system_time_rfc3339)
        .unwrap_or_else(|| "null".to_owned())
}

fn artifact_task_component(task_id: &str) -> String {
    task_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn strip_tool_execution_controls(mut tool_call: ToolCall) -> ToolCall {
    if let Value::Object(arguments) = &mut tool_call.arguments {
        arguments.remove("detach_after_secs");
        arguments.remove("timeout_secs");
        arguments.remove("interactive_stdio");
        arguments.remove("task_label");
    }
    tool_call
}

fn resolve_task_label(tool_call: &ToolCall) -> Result<Option<String>, ToolResult> {
    let Some(value) = tool_call.arguments.get("task_label") else {
        return Ok(None);
    };
    let Some(value) = value.as_str() else {
        return Err(invalid_tool_control_result(
            tool_call,
            "task_label",
            "must be a string".to_owned(),
        ));
    };
    Ok(crate::tasks::normalize_task_label(value))
}

fn resolve_interactive_stdio(
    tool_call: &ToolCall,
    background_host_available: bool,
) -> Result<bool, ToolResult> {
    let Some(value) = tool_call.arguments.get("interactive_stdio") else {
        return Ok(tool_call.name == "bash" && background_host_available);
    };
    value.as_bool().ok_or_else(|| {
        invalid_tool_control_result(
            tool_call,
            "interactive_stdio",
            "must be a boolean".to_owned(),
        )
    })
}

fn invalid_tool_control_result(tool_call: &ToolCall, field: &str, message: String) -> ToolResult {
    ToolResult::error(
        tool_call.id.clone(),
        tool_call.name.clone(),
        format!("invalid tool execution control {field}: {message}"),
        json!({
            "kind": "invalid_tool_execution_control",
            "field": field,
            "error": message
        }),
    )
}
