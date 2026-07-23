use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(test)]
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::agent_events::AgentUsage;
use crate::event::{EventLog, ServiceEvent};
use crate::files::FileStore;
use crate::llm_text_preview::{LlmTextPreviewMetadata, LlmTextPreviewSink, ProviderPreviewContext};
use crate::profiling::{ProviderProfilingContext, SharedProfiler};
use crate::provider::{
    complete_with_cancellation, Provider, ProviderCompletionError, ProviderErrorDiagnostic,
    ProviderMetadata,
};
use crate::tasks::{BackgroundTaskManager, InteractiveStdioBridge, NewBackgroundTask, TaskState};
use crate::tools::Tool;
use crate::transcript::{repair_provider_transcript, validate_provider_transcript};
use crate::types::{assistant_payload_is_valid, Message, StopReason, ToolCall, ToolResult, Usage};

mod configuration;
mod events;
mod input;
mod provider_request;
mod tool_execution;
mod tool_snapshot;

pub use configuration::{AgentConfig, PromptRefreshConfig, ToolExecutionPolicy};
use input::{drain_inputs, initial_active_request_inputs};
pub use input::{
    AcceptedInputEntry, ActiveRequestInput, AgentCommitError, AgentContextRecorder,
    AgentInputDrainer, DrainBatch, DrainCommit, DrainedMessage, InputSource, InputUrgency,
    MessageDelivery, QueuedInputMetadata, TaskCallbackExecutionState,
};
use provider_request::{
    build_final_provider_request, BuiltProviderRequest, PromptMaterialSnapshot,
};
pub(crate) use tool_snapshot::{validate_final_tool_names, FinalToolSnapshot};

use events::{
    add_cycle_data, add_cycle_id, close_active_cycle_before_replacement,
    close_and_replace_active_cycle, completed_cycle_provider_calls, elapsed_millis, emit,
    emit_aborted, emit_aborted_for_cycle, emit_bash_command_execution_started, emit_error,
    emit_error_for_cycle, emit_provider_completed, emit_provider_failed, emit_provider_started,
    emit_tool_completed, emit_tool_started, fail_if_event_log_failed, profiler_now,
    turn_completed_data, write_tool_profile_row, write_turn_profile_row,
};
pub(crate) use tool_execution::DetachedToolResult;
use tool_execution::{
    background_task_publish_failed_tool_result, execute_tool_call_with_policy,
    record_tool_result_or_detached_ack, resolve_tool_execution_controls,
    start_published_detached_tool_run, DetachedAckPersistenceTarget, ToolExecutionOutcome,
};

#[cfg(test)]
use tool_execution::{
    start_detached_tool_run, DetachedToolRun, RunnableToolExecution, TOOL_TIMEOUT_CLEANUP_GRACE,
};

#[cfg(test)]
use crate::tools::{ToolError, ToolExecutionContext, ToolTimeout};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentRunResult {
    pub messages: Vec<Message>,
    pub stop_reason: StopReason,
    pub provider_calls: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentRunError {
    pub kind: AgentRunErrorKind,
    pub messages: Vec<Message>,
    pub provider_calls: usize,
    pub open_request_boundary: Option<Box<AgentRunOpenRequestBoundary>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRunOpenRequestBoundary {
    pub active_user_message_id: String,
    pub active_input_ids: Vec<String>,
    pub current_request_start: usize,
}

impl std::fmt::Display for AgentRunError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.kind.fmt(formatter)
    }
}

impl std::error::Error for AgentRunError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentRunErrorKind {
    Cancelled,
    Provider {
        message: String,
        #[serde(default = "default_provider_error_code")]
        code: String,
        #[serde(default = "default_provider_error_retryable")]
        retryable: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_code: Option<String>,
    },
    ProviderStop {
        message: String,
    },
    Persistence {
        message: String,
    },
    Configuration {
        message: String,
    },
}

impl std::fmt::Display for AgentRunErrorKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(formatter, "agent run cancelled"),
            Self::Provider { message, .. } => write!(formatter, "provider failed: {message}"),
            Self::ProviderStop { message } => {
                write!(
                    formatter,
                    "provider stopped before completing the turn: {message}"
                )
            }
            Self::Persistence { message } => write!(formatter, "persistence failed: {message}"),
            Self::Configuration { message } => {
                write!(formatter, "agent configuration invalid: {message}")
            }
        }
    }
}

fn default_provider_error_code() -> String {
    "provider_error".to_owned()
}

fn default_provider_error_retryable() -> bool {
    true
}

impl AgentRunErrorKind {
    fn provider(message: impl Into<String>) -> Self {
        Self::Provider {
            message: message.into(),
            code: default_provider_error_code(),
            retryable: default_provider_error_retryable(),
            status: None,
            provider_code: None,
        }
    }

    fn provider_with_diagnostic(
        message: impl Into<String>,
        diagnostic: ProviderErrorDiagnostic,
    ) -> Self {
        Self::Provider {
            message: message.into(),
            code: diagnostic.code.to_owned(),
            retryable: diagnostic.retryable,
            status: diagnostic.status,
            provider_code: diagnostic.provider_code,
        }
    }
}

impl AgentRunError {
    fn new(kind: AgentRunErrorKind, messages: &[Message], provider_calls: usize) -> Self {
        Self {
            kind,
            messages: messages.to_vec(),
            provider_calls,
            open_request_boundary: None,
        }
    }

    fn with_open_request_boundary(
        mut self,
        active_user_message_id: Option<&str>,
        active_inputs: &[ActiveRequestInput],
        current_request_start: usize,
    ) -> Self {
        self.open_request_boundary = active_user_message_id.map(|active_user_message_id| {
            let mut active_input_ids = active_inputs
                .iter()
                .map(|input| input.id.clone())
                .collect::<Vec<_>>();
            if active_input_ids
                .first()
                .is_none_or(|input_id| input_id != active_user_message_id)
            {
                active_input_ids.insert(0, active_user_message_id.to_owned());
            }
            Box::new(AgentRunOpenRequestBoundary {
                active_user_message_id: active_user_message_id.to_owned(),
                active_input_ids,
                current_request_start,
            })
        });
        self
    }
}

fn current_request_start(messages: &[Message]) -> usize {
    messages
        .iter()
        .rposition(|message| {
            matches!(
                message,
                Message::Assistant { tool_calls, .. } if tool_calls.is_empty()
            )
        })
        .map(|index| index + 1)
        .unwrap_or(0)
}

fn assistant_text_is_visible(content: Option<&str>) -> bool {
    content.is_some_and(|content| !content.trim().is_empty())
}

fn request_has_visible_assistant_text(messages: &[Message], request_start: usize) -> bool {
    messages[request_start.min(messages.len())..]
        .iter()
        .any(|message| match message {
            Message::Assistant { content, .. } => assistant_text_is_visible(content.as_deref()),
            Message::User { .. } | Message::ToolResult(_) => false,
        })
}

fn request_has_tool_result(messages: &[Message], request_start: usize) -> bool {
    messages[request_start.min(messages.len())..]
        .iter()
        .any(|message| matches!(message, Message::ToolResult(_)))
}

fn should_silently_finish_empty_assistant(
    stop_reason: StopReason,
    has_visible_assistant_text_or_tool_result: bool,
) -> bool {
    has_visible_assistant_text_or_tool_result && stop_reason == StopReason::EndTurn
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentCompactionSafePoint<'a> {
    pub current_request_start: usize,
    pub active_user_message_id: Option<&'a str>,
    pub current_request_input_count: usize,
    pub active_inputs: &'a [ActiveRequestInput],
    pub active_input_source: Option<InputSource>,
    pub active_input_urgency: Option<InputUrgency>,
    pub active_input_metadata: Option<&'a QueuedInputMetadata>,
    pub recovery_attempted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentCompactionUpdate {
    pub current_request_start: usize,
    pub provider_request_action: AgentProviderRequestAction,
}

impl AgentCompactionUpdate {
    pub fn new(current_request_start: usize) -> Self {
        Self {
            current_request_start,
            provider_request_action: AgentProviderRequestAction::Proceed,
        }
    }

    pub fn unchanged(safe_point: AgentCompactionSafePoint<'_>) -> Self {
        Self::new(safe_point.current_request_start)
    }

    pub fn rebuild_provider_request(current_request_start: usize) -> Self {
        Self {
            current_request_start,
            provider_request_action: AgentProviderRequestAction::Rebuild,
        }
    }

    pub fn rebuild_after_recovery(current_request_start: usize) -> Self {
        Self {
            current_request_start,
            provider_request_action: AgentProviderRequestAction::RebuildAfterRecovery,
        }
    }

    pub fn finish_current_request(current_request_start: usize) -> Self {
        Self {
            current_request_start,
            provider_request_action: AgentProviderRequestAction::FinishCurrentRequest,
        }
    }

    pub fn fail_persistence(current_request_start: usize, message: &'static str) -> Self {
        Self {
            current_request_start,
            provider_request_action: AgentProviderRequestAction::FailPersistence { message },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentProviderRequestAction {
    Proceed,
    Rebuild,
    RebuildAfterRecovery,
    FinishCurrentRequest,
    FailPersistence { message: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProviderRequestBudget {
    pub estimated_input_tokens: usize,
    pub provider_metadata: Option<ProviderMetadata>,
}

#[async_trait]
pub trait AgentCompactionHook: Send + Sync {
    async fn on_agent_safe_point(
        &self,
        messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
    ) -> AgentCompactionUpdate;

    async fn on_provider_request_ready(
        &self,
        _messages: &mut Vec<Message>,
        safe_point: AgentCompactionSafePoint<'_>,
        _budget: AgentProviderRequestBudget,
    ) -> AgentCompactionUpdate {
        AgentCompactionUpdate::unchanged(safe_point)
    }
}

pub async fn run_agent(
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: &dyn Provider,
    tools: Vec<Arc<dyn Tool>>,
    cancel: CancellationToken,
    event_log: Option<&mut EventLog>,
) -> Result<AgentRunResult, AgentRunError> {
    run_agent_with_input_drainer(
        config,
        initial_messages,
        provider,
        tools,
        None,
        cancel,
        event_log,
    )
    .await
}

pub async fn run_agent_with_compaction_hook(
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: &dyn Provider,
    tools: Vec<Arc<dyn Tool>>,
    compaction_hook: &dyn AgentCompactionHook,
    cancel: CancellationToken,
    event_log: Option<&mut EventLog>,
) -> Result<AgentRunResult, AgentRunError> {
    run_agent_inner(
        config,
        initial_messages,
        provider,
        tools,
        AgentRuntime {
            input_drainer: None,
            context_recorder: None,
            initial_current_request_start: None,
            initial_active_user_message_id: None,
            initial_active_input_ids: Vec::new(),
            initial_known_user_messages: Vec::new(),
            compaction_hook: Some(compaction_hook),
            cancel,
            event_log: event_log.map(AgentEventLog::Borrowed),
            background_host: None,
            profiler: None,
            file_store: None,
            preview_sink: None,
        },
    )
    .await
}

pub async fn run_agent_with_input_drainer(
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: &dyn Provider,
    tools: Vec<Arc<dyn Tool>>,
    input_drainer: Option<&dyn AgentInputDrainer>,
    cancel: CancellationToken,
    event_log: Option<&mut EventLog>,
) -> Result<AgentRunResult, AgentRunError> {
    run_agent_inner(
        config,
        initial_messages,
        provider,
        tools,
        AgentRuntime {
            input_drainer,
            context_recorder: None,
            initial_current_request_start: None,
            initial_active_user_message_id: None,
            initial_active_input_ids: Vec::new(),
            initial_known_user_messages: Vec::new(),
            compaction_hook: None,
            cancel,
            event_log: event_log.map(AgentEventLog::Borrowed),
            background_host: None,
            profiler: None,
            file_store: None,
            preview_sink: None,
        },
    )
    .await
}

pub(crate) struct SharedAgentRunOptions<'a> {
    pub input_drainer: Option<&'a dyn AgentInputDrainer>,
    pub context_recorder: Option<&'a dyn AgentContextRecorder>,
    pub initial_current_request_start: Option<usize>,
    pub initial_active_user_message_id: Option<String>,
    pub initial_active_input_ids: Vec<String>,
    pub initial_known_user_messages: Vec<DrainedMessage>,
    pub cancel: CancellationToken,
    pub event_log: Option<Arc<Mutex<EventLog>>>,
    pub event_appender: Option<SharedEventAppender>,
    pub event_notify: Option<Arc<Notify>>,
    pub event_observer: Option<SharedEventObserver>,
    pub background_host: Option<Arc<dyn BackgroundExecutionHost>>,
    pub profiler: Option<SharedProfiler>,
    pub file_store: Option<FileStore>,
    pub preview_sink: Option<LlmTextPreviewSink>,
}

pub(crate) type SharedEventObserver = Arc<dyn Fn(&ServiceEvent) + Send + Sync>;
pub(crate) type SharedEventAppender = Arc<
    dyn Fn(String, Option<String>, Option<String>, Value) -> Result<ServiceEvent, AgentCommitError>
        + Send
        + Sync,
>;

#[async_trait]
pub(crate) trait BackgroundExecutionHost: Send + Sync {
    fn allocate_task_id(&self) -> String;

    fn task_manager(&self) -> Arc<BackgroundTaskManager>;

    fn publish_task(&self, task_id: String, task: NewBackgroundTask) -> bool;

    async fn finish_task(&self, task_id: String, tool_call: ToolCall, result: DetachedToolResult);

    fn interactive_stdio_bridge(&self, task_id: &str) -> Option<Arc<dyn InteractiveStdioBridge>>;
}

pub(crate) async fn run_agent_with_shared_event_log_and_compaction_hook(
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: &dyn Provider,
    tools: Arc<FinalToolSnapshot>,
    options: SharedAgentRunOptions<'_>,
    compaction_hook: Option<&dyn AgentCompactionHook>,
) -> Result<AgentRunResult, AgentRunError> {
    run_agent_inner_with_snapshot(
        config,
        initial_messages,
        provider,
        tools,
        AgentRuntime {
            input_drainer: options.input_drainer,
            context_recorder: options.context_recorder,
            initial_current_request_start: options.initial_current_request_start,
            initial_active_user_message_id: options.initial_active_user_message_id,
            initial_active_input_ids: options.initial_active_input_ids,
            initial_known_user_messages: options.initial_known_user_messages,
            compaction_hook,
            cancel: options.cancel,
            event_log: options
                .event_appender
                .map(|appender| AgentEventLog::Shared {
                    appender,
                    failure: None,
                })
                .or_else(|| {
                    options.event_log.map(|log| {
                        let notify = options.event_notify.clone();
                        let observer = options.event_observer.clone();
                        AgentEventLog::Shared {
                            appender: Arc::new(move |event_type, session, turn_id, data| {
                                let event = {
                                    log.lock().expect("event log mutex poisoned").append(
                                        event_type,
                                        session.as_deref(),
                                        turn_id.as_deref(),
                                        data,
                                    )
                                };
                                if let Some(observer) = observer.as_ref() {
                                    observer(&event);
                                }
                                if let Some(notify) = notify.as_ref() {
                                    notify.notify_waiters();
                                }
                                Ok(event)
                            }),
                            failure: None,
                        }
                    })
                }),
            background_host: options.background_host,
            profiler: options.profiler,
            file_store: options.file_store,
            preview_sink: options.preview_sink,
        },
    )
    .await
}

enum AgentEventLog<'a> {
    Borrowed(&'a mut EventLog),
    Shared {
        appender: SharedEventAppender,
        failure: Option<String>,
    },
}

impl AgentEventLog<'_> {
    fn append(
        &mut self,
        event_type: &str,
        session: Option<&str>,
        turn_id: Option<&str>,
        data: Value,
    ) -> Option<ServiceEvent> {
        match self {
            AgentEventLog::Borrowed(log) => Some(log.append(event_type, session, turn_id, data)),
            AgentEventLog::Shared { appender, failure } => {
                if failure.is_some() {
                    return None;
                }
                match appender(
                    event_type.to_owned(),
                    session.map(ToOwned::to_owned),
                    turn_id.map(ToOwned::to_owned),
                    data,
                ) {
                    Ok(event) => Some(event),
                    Err(error) => {
                        *failure = Some(error.to_string());
                        None
                    }
                }
            }
        }
    }

    fn take_failure(&mut self) -> Option<String> {
        match self {
            AgentEventLog::Borrowed(_) => None,
            AgentEventLog::Shared { failure, .. } => failure.take(),
        }
    }
}

struct AgentRuntime<'a> {
    input_drainer: Option<&'a dyn AgentInputDrainer>,
    context_recorder: Option<&'a dyn AgentContextRecorder>,
    initial_current_request_start: Option<usize>,
    initial_active_user_message_id: Option<String>,
    initial_active_input_ids: Vec<String>,
    initial_known_user_messages: Vec<DrainedMessage>,
    compaction_hook: Option<&'a dyn AgentCompactionHook>,
    cancel: CancellationToken,
    event_log: Option<AgentEventLog<'a>>,
    background_host: Option<Arc<dyn BackgroundExecutionHost>>,
    profiler: Option<SharedProfiler>,
    file_store: Option<FileStore>,
    preview_sink: Option<LlmTextPreviewSink>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveCycle {
    cycle_id: String,
    input_ids: Vec<String>,
    input_sources: BTreeMap<String, String>,
    input_urgencies: BTreeMap<String, String>,
    input_previews: BTreeMap<String, String>,
    queue_length: usize,
    provider_call_index: usize,
    assistant_message_index: usize,
}

impl ActiveCycle {
    fn new(
        cycle_id: impl Into<String>,
        input_ids: Vec<String>,
        input_sources: BTreeMap<String, String>,
        input_urgencies: BTreeMap<String, String>,
        input_previews: BTreeMap<String, String>,
        queue_length: usize,
    ) -> Self {
        Self {
            cycle_id: cycle_id.into(),
            input_ids,
            input_sources,
            input_urgencies,
            input_previews,
            queue_length,
            provider_call_index: 0,
            assistant_message_index: 0,
        }
    }

    fn next_provider_request(&mut self) -> ProviderRequestObservation {
        self.provider_call_index += 1;
        ProviderRequestObservation::new(Some(self.cycle_id.clone()), self.provider_call_index)
    }

    fn next_assistant_message_index(&mut self) -> usize {
        self.assistant_message_index += 1;
        self.assistant_message_index
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderRequestObservation {
    cycle_id: Option<String>,
    provider_request_id: String,
    provider_call_index: usize,
}

impl ProviderRequestObservation {
    fn new(cycle_id: Option<String>, provider_call_index: usize) -> Self {
        let provider_request_id = match cycle_id.as_deref() {
            Some(cycle_id) => format!("prq_{cycle_id}_{provider_call_index}"),
            None => format!("prq_unknown_{provider_call_index}"),
        };
        Self {
            cycle_id,
            provider_request_id,
            provider_call_index,
        }
    }
}

async fn run_agent_inner(
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: &dyn Provider,
    tools: Vec<Arc<dyn Tool>>,
    runtime: AgentRuntime<'_>,
) -> Result<AgentRunResult, AgentRunError> {
    let snapshot = FinalToolSnapshot::build(tools, &config.tool_execution)
        .map(Arc::new)
        .map_err(|kind| AgentRunError::new(kind, &initial_messages, 0));
    match snapshot {
        Ok(snapshot) => {
            run_agent_inner_with_snapshot(config, initial_messages, provider, snapshot, runtime)
                .await
        }
        Err(error) => Err(error),
    }
}

async fn run_agent_inner_with_snapshot(
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: &dyn Provider,
    snapshot: Arc<FinalToolSnapshot>,
    runtime: AgentRuntime<'_>,
) -> Result<AgentRunResult, AgentRunError> {
    let profiler = runtime.profiler.clone();
    let turn_profile_start = profiler_now(profiler.as_ref());
    let profile_config = config.clone();
    let result = run_agent_inner_body(config, initial_messages, provider, snapshot, runtime).await;
    write_turn_profile_row(
        profiler.as_ref(),
        &profile_config,
        turn_profile_start,
        &result,
    );
    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingInputDrainBoundary {
    Open,
    DeferUntilCurrentRequestComplete,
}

impl PendingInputDrainBoundary {
    fn for_initial_restart(has_initial_request_boundary: bool) -> Self {
        if has_initial_request_boundary {
            Self::DeferUntilCurrentRequestComplete
        } else {
            Self::Open
        }
    }

    fn can_drain_at_safe_point(self) -> bool {
        self == Self::Open
    }

    fn finish_current_request(&mut self) {
        *self = Self::Open;
    }
}

async fn run_agent_inner_body(
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: &dyn Provider,
    tool_snapshot: Arc<FinalToolSnapshot>,
    runtime: AgentRuntime<'_>,
) -> Result<AgentRunResult, AgentRunError> {
    let mut config = config;
    let mut events = runtime.event_log;
    let mut messages = repair_provider_transcript(initial_messages);
    let mut provider_calls = 0;
    let mut turn_usage = AgentUsage::default();
    let cancel = runtime.cancel;
    let input_drainer = runtime.input_drainer;
    let context_recorder = runtime.context_recorder;
    let compaction_hook = runtime.compaction_hook;
    let background_host = runtime.background_host;
    let profiler = runtime.profiler;
    let file_store = runtime.file_store;
    let preview_sink = runtime.preview_sink;
    let mut pending_input_drain_boundary = PendingInputDrainBoundary::for_initial_restart(
        runtime.initial_current_request_start.is_some(),
    );
    let mut current_request_start = runtime
        .initial_current_request_start
        .unwrap_or_else(|| current_request_start(&messages))
        .min(messages.len());
    let mut initial_active_input_ids = runtime.initial_active_input_ids;
    if initial_active_input_ids.is_empty() {
        if let Some(active_user_message_id) = runtime.initial_active_user_message_id {
            initial_active_input_ids.push(active_user_message_id);
        }
    }
    let mut current_request_active_user_message_id = initial_active_input_ids.first().cloned();
    let mut current_request_active_inputs = initial_active_request_inputs(
        &messages,
        current_request_start,
        &initial_active_input_ids,
        &runtime.initial_known_user_messages,
    );
    let mut current_request_input_count = current_request_active_inputs.len();
    let mut current_request_active_input_source = current_request_active_inputs
        .first()
        .map(|input| input.source);
    let mut current_request_active_input_urgency = current_request_active_inputs
        .first()
        .map(|input| input.urgency);
    let mut current_request_active_input_metadata = current_request_active_inputs
        .first()
        .and_then(|input| input.metadata.clone());
    let mut current_request_recovery_attempted = false;
    let mut prompt_material_snapshot: Option<PromptMaterialSnapshot> = None;
    let mut active_cycle: Option<ActiveCycle> = None;
    let mut active_cycle_last_stop_reason: Option<StopReason> = None;

    emit(&mut events, &config, "turn.started", json!({}));
    fail_if_event_log_failed(&mut events, &messages, provider_calls)?;

    loop {
        if cancel.is_cancelled() {
            let error = AgentRunError::new(AgentRunErrorKind::Cancelled, &messages, provider_calls);
            emit_aborted_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
            return Err(error);
        }

        let drained_request_start = if pending_input_drain_boundary.can_drain_at_safe_point() {
            drain_inputs(
                input_drainer,
                cancel.clone(),
                &mut events,
                &config,
                &mut messages,
                provider_calls,
            )
            .await?
        } else {
            None
        };
        if let Some(drained_request_start) = drained_request_start {
            close_and_replace_active_cycle(
                &mut events,
                &config,
                &mut active_cycle,
                &mut active_cycle_last_stop_reason,
                drained_request_start.cycle,
                provider_calls,
                &mut turn_usage,
            );
            current_request_start = drained_request_start.request_start;
            current_request_active_user_message_id = drained_request_start.active_user_message_id;
            current_request_input_count = drained_request_start.input_count;
            current_request_active_input_source = drained_request_start.active_input_source;
            current_request_active_input_urgency = drained_request_start.active_input_urgency;
            current_request_active_input_metadata = drained_request_start.active_input_metadata;
            current_request_active_inputs = drained_request_start.active_inputs;
            current_request_recovery_attempted = false;
            if provider_calls > 0 {
                prompt_material_snapshot = None;
            }
        }

        if let Some(hook) = compaction_hook {
            let update = hook
                .on_agent_safe_point(
                    &mut messages,
                    AgentCompactionSafePoint {
                        current_request_start,
                        active_user_message_id: current_request_active_user_message_id.as_deref(),
                        current_request_input_count,
                        active_inputs: &current_request_active_inputs,
                        active_input_source: current_request_active_input_source,
                        active_input_urgency: current_request_active_input_urgency,
                        active_input_metadata: current_request_active_input_metadata.as_ref(),
                        recovery_attempted: current_request_recovery_attempted,
                    },
                )
                .await;
            current_request_start = update.current_request_start.min(messages.len());
        }

        messages = repair_provider_transcript(messages);
        current_request_start = current_request_start.min(messages.len());
        let has_visible_assistant_text_in_request =
            request_has_visible_assistant_text(&messages, current_request_start);
        let has_tool_result_in_request = request_has_tool_result(&messages, current_request_start);
        if let Err(error) = validate_provider_transcript(&messages) {
            let error = AgentRunError::new(
                AgentRunErrorKind::provider(format!("invalid provider transcript: {error}")),
                &messages,
                provider_calls,
            );
            emit_error_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
            return Err(error);
        }

        let BuiltProviderRequest {
            mut request,
            warnings,
        } = build_final_provider_request(
            &mut config,
            &messages,
            tool_snapshot.as_ref(),
            file_store.as_ref(),
            current_request_start,
            &mut prompt_material_snapshot,
        );
        let provider_metadata = provider.metadata_for_request(&request);
        let estimated_input_tokens =
            crate::compact::estimate_provider_request_input_tokens(&request);

        // Keep runtime provider selection unpinned here. The compaction hook or
        // hard gate below may rebuild/finish/fail without calling complete, so
        // content-keyed metadata pins can go stale. In service runtime, the only
        // model-visible runtime mutation is agent_runtime_set, which is executed
        // from tool calls returned by complete and therefore can affect only a
        // later provider request.
        if let Some(hook) = compaction_hook {
            let update = hook
                .on_provider_request_ready(
                    &mut messages,
                    AgentCompactionSafePoint {
                        current_request_start,
                        active_user_message_id: current_request_active_user_message_id.as_deref(),
                        current_request_input_count,
                        active_inputs: &current_request_active_inputs,
                        active_input_source: current_request_active_input_source,
                        active_input_urgency: current_request_active_input_urgency,
                        active_input_metadata: current_request_active_input_metadata.as_ref(),
                        recovery_attempted: current_request_recovery_attempted,
                    },
                    AgentProviderRequestBudget {
                        estimated_input_tokens,
                        provider_metadata: provider_metadata.clone(),
                    },
                )
                .await;
            current_request_start = update.current_request_start.min(messages.len());
            match update.provider_request_action {
                AgentProviderRequestAction::Proceed => {}
                AgentProviderRequestAction::Rebuild => {
                    prompt_material_snapshot = None;
                    continue;
                }
                AgentProviderRequestAction::RebuildAfterRecovery => {
                    current_request_recovery_attempted = true;
                    prompt_material_snapshot = None;
                    continue;
                }
                AgentProviderRequestAction::FinishCurrentRequest => {
                    prompt_material_snapshot = None;
                    close_active_cycle_before_replacement(
                        &mut events,
                        &config,
                        active_cycle.as_ref(),
                        provider_calls,
                        Some(StopReason::EndTurn),
                        &mut turn_usage,
                    );
                    active_cycle_last_stop_reason = None;
                    fail_if_event_log_failed(&mut events, &messages, provider_calls)?;
                    pending_input_drain_boundary.finish_current_request();

                    let drained_request_start = drain_inputs(
                        input_drainer,
                        cancel.clone(),
                        &mut events,
                        &config,
                        &mut messages,
                        provider_calls,
                    )
                    .await?;
                    if let Some(drained_request_start) = drained_request_start {
                        active_cycle = drained_request_start.cycle;
                        current_request_start = drained_request_start.request_start;
                        current_request_active_user_message_id =
                            drained_request_start.active_user_message_id;
                        current_request_input_count = drained_request_start.input_count;
                        current_request_active_input_source =
                            drained_request_start.active_input_source;
                        current_request_active_input_urgency =
                            drained_request_start.active_input_urgency;
                        current_request_active_input_metadata =
                            drained_request_start.active_input_metadata;
                        current_request_active_inputs = drained_request_start.active_inputs;
                        current_request_recovery_attempted = false;
                        continue;
                    }

                    emit(&mut events, &config, "agent.idle", json!({}));
                    fail_if_event_log_failed(&mut events, &messages, provider_calls)?;
                    return Ok(AgentRunResult {
                        messages,
                        stop_reason: StopReason::EndTurn,
                        provider_calls,
                    });
                }
                AgentProviderRequestAction::FailPersistence { message } => {
                    let error = AgentRunError::new(
                        AgentRunErrorKind::Persistence {
                            message: message.to_owned(),
                        },
                        &messages,
                        provider_calls,
                    )
                    .with_open_request_boundary(
                        current_request_active_user_message_id.as_deref(),
                        &current_request_active_inputs,
                        current_request_start,
                    );
                    emit_error_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
                    return Err(error);
                }
            }
        }

        let hard_stop_tokens = provider_metadata
            .as_ref()
            .map(crate::compact::CompactPolicy::from_provider_metadata)
            .unwrap_or_default()
            .limits()
            .hard_stop_tokens;
        if estimated_input_tokens > hard_stop_tokens {
            let error = AgentRunError::new(
                AgentRunErrorKind::provider(format!(
                    "provider request input estimate {estimated_input_tokens} exceeds hard context limit {hard_stop_tokens}"
                )),
                &messages,
                provider_calls,
            );
            emit_error_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
            return Err(error);
        }
        current_request_recovery_attempted = false;

        for warning in warnings {
            emit(
                &mut events,
                &config,
                "service.warning",
                json!({ "message": warning }),
            );
        }

        let provider_call = provider_calls + 1;
        let provider_observation = active_cycle
            .as_mut()
            .map(ActiveCycle::next_provider_request)
            .unwrap_or_else(|| ProviderRequestObservation::new(None, provider_call));
        provider_calls = provider_call;
        if profiler.is_some() {
            request.set_profiling_context(ProviderProfilingContext {
                session: config.session.clone(),
                turn_id: config.turn_id.clone(),
                cycle_id: provider_observation.cycle_id.clone(),
                provider_call_index: provider_observation.provider_call_index,
                request_kind: "agent_turn".to_owned(),
                input_message_count: messages.len(),
                message_count: request.input.len(),
                tool_spec_count: request.tools.len(),
            });
        }
        if let Some(sink) = preview_sink.as_ref() {
            request.set_preview_context(ProviderPreviewContext::new(
                LlmTextPreviewMetadata {
                    provider_request_id: provider_observation.provider_request_id.clone(),
                    turn_id: config.turn_id.clone(),
                    cycle_id: provider_observation.cycle_id.clone(),
                    provider_call_index: provider_observation.provider_call_index,
                    input_ids: active_cycle
                        .as_ref()
                        .map(|cycle| cycle.input_ids.clone())
                        .unwrap_or_default(),
                },
                sink.clone(),
            ));
        }
        if cancel.is_cancelled() {
            let error = AgentRunError::new(AgentRunErrorKind::Cancelled, &messages, provider_calls);
            emit_aborted_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
            return Err(error);
        }
        emit_provider_started(
            &mut events,
            &config,
            &provider_observation,
            provider_calls,
            messages.len(),
            provider_metadata.as_ref(),
        );
        fail_if_event_log_failed(&mut events, &messages, provider_calls)?;
        let provider_started_at = Instant::now();
        if cancel.is_cancelled() {
            let provider_duration_ms = elapsed_millis(provider_started_at);
            let error = AgentRunError::new(AgentRunErrorKind::Cancelled, &messages, provider_calls);
            let diagnostic = ProviderErrorDiagnostic {
                code: "cancelled",
                message: "provider request cancelled".to_owned(),
                retryable: true,
                status: None,
                provider_code: None,
            };
            emit_provider_failed(
                &mut events,
                &config,
                &provider_observation,
                provider_calls,
                provider_duration_ms,
                &diagnostic,
                provider_metadata.as_ref(),
            );
            emit_aborted_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
            return Err(error);
        }
        let provider_result = complete_with_cancellation(provider, request, cancel.clone()).await;
        let provider_duration_ms = elapsed_millis(provider_started_at);
        if cancel.is_cancelled() {
            let error = AgentRunError::new(AgentRunErrorKind::Cancelled, &messages, provider_calls);
            let diagnostic = ProviderErrorDiagnostic {
                code: "cancelled",
                message: "provider request cancelled".to_owned(),
                retryable: true,
                status: None,
                provider_code: None,
            };
            emit_provider_failed(
                &mut events,
                &config,
                &provider_observation,
                provider_calls,
                provider_duration_ms,
                &diagnostic,
                provider_metadata.as_ref(),
            );
            emit_aborted_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
            return Err(error);
        }

        let response = match provider_result {
            Ok(response) => response,
            Err(ProviderCompletionError::Provider(error)) => {
                let diagnostic = error.diagnostic();
                let message = diagnostic.message.clone();
                emit_provider_failed(
                    &mut events,
                    &config,
                    &provider_observation,
                    provider_calls,
                    provider_duration_ms,
                    &diagnostic,
                    provider_metadata.as_ref(),
                );
                let error = AgentRunError::new(
                    AgentRunErrorKind::provider_with_diagnostic(message, diagnostic),
                    &messages,
                    provider_calls,
                );
                emit_error_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
                return Err(error);
            }
            Err(ProviderCompletionError::Cancelled) => {
                unreachable!("provider cancellation outcome requires a cancelled token");
            }
        };
        let response_metadata = response
            .metadata
            .clone()
            .or_else(|| provider_metadata.clone());
        add_provider_usage(&mut turn_usage, response.usage);

        emit_provider_completed(
            &mut events,
            &config,
            &provider_observation,
            provider_calls,
            provider_duration_ms,
            response.stop_reason,
            response.usage,
            response.tool_calls.len(),
            response.text.is_some(),
            response_metadata.as_ref(),
        );
        fail_if_event_log_failed(&mut events, &messages, provider_calls)?;
        active_cycle_last_stop_reason = Some(response.stop_reason);

        if let Some(duplicate_id) = duplicate_tool_call_id(&response.tool_calls) {
            let error = AgentRunError::new(
                AgentRunErrorKind::provider(format!(
                    "provider returned duplicate tool_call id {duplicate_id:?} in one assistant response"
                )),
                &messages,
                provider_calls,
            );
            emit_error_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
            return Err(error);
        }

        let assistant_payload_valid =
            assistant_payload_is_valid(response.text.as_deref(), &response.tool_calls);
        let provider_stopped = response.stop_reason == StopReason::ProviderStop;
        if provider_stopped && !assistant_payload_valid {
            let error = AgentRunError::new(
                AgentRunErrorKind::ProviderStop {
                    message: "provider_stop".to_owned(),
                },
                &messages,
                provider_calls,
            );
            emit_error_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
            return Err(error);
        }

        let silently_finish_empty_assistant = !assistant_payload_valid
            && should_silently_finish_empty_assistant(
                response.stop_reason,
                has_visible_assistant_text_in_request || has_tool_result_in_request,
            );
        if !assistant_payload_valid && !silently_finish_empty_assistant {
            let error = AgentRunError::new(
                AgentRunErrorKind::provider(
                    "provider returned assistant message without non-empty content or tool_calls",
                ),
                &messages,
                provider_calls,
            );
            emit_error_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
            return Err(error);
        }

        if !silently_finish_empty_assistant {
            let assistant = Message::Assistant {
                content: response.text.clone(),
                tool_calls: response.tool_calls.clone(),
                assistant_replay: response.assistant_replay.clone(),
                usage: response.usage,
                stop_reason: Some(response.stop_reason),
            };
            record_context_message(
                &assistant,
                RecordContextMessage {
                    recorder: context_recorder,
                    event_log: &mut events,
                    config: &config,
                    messages: &messages,
                    provider_calls,
                    active_cycle: active_cycle.as_ref(),
                    active_request_boundary: ActiveRequestBoundary {
                        active_user_message_id: current_request_active_user_message_id.as_deref(),
                        active_inputs: &current_request_active_inputs,
                        current_request_start,
                    },
                },
            )
            .await?;
            messages.push(assistant);
            let assistant_message_index = active_cycle
                .as_mut()
                .map(ActiveCycle::next_assistant_message_index)
                .unwrap_or(provider_calls);
            emit(
                &mut events,
                &config,
                "assistant.message",
                add_cycle_id(
                    json!({
                        "provider_request_id": provider_observation.provider_request_id.as_str(),
                        "provider_call_index": provider_observation.provider_call_index,
                        "message_index": assistant_message_index,
                    "text": response.text,
                    "tool_call_count": response.tool_calls.len(),
                    "usage": response.usage.map(|usage| json!({
                        "input": usage.input_tokens,
                        "cached_input": usage.cached_input_tokens,
                        "output": usage.output_tokens,
                        "reasoning_output": usage.reasoning_output_tokens,
                        "total": usage.total_tokens
                    })),
                    "stop_reason": response.stop_reason
                    }),
                    provider_observation.cycle_id.as_deref(),
                ),
            );
        }

        if provider_stopped {
            let error = AgentRunError::new(
                AgentRunErrorKind::ProviderStop {
                    message: "provider_stop".to_owned(),
                },
                &messages,
                provider_calls,
            );
            emit_error_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
            return Err(error);
        }

        if response.tool_calls.is_empty() {
            pending_input_drain_boundary.finish_current_request();
            let drained_request_start = drain_inputs(
                input_drainer,
                cancel.clone(),
                &mut events,
                &config,
                &mut messages,
                provider_calls,
            )
            .await?;
            if let Some(drained_request_start) = drained_request_start {
                close_and_replace_active_cycle(
                    &mut events,
                    &config,
                    &mut active_cycle,
                    &mut active_cycle_last_stop_reason,
                    drained_request_start.cycle,
                    provider_calls,
                    &mut turn_usage,
                );
                current_request_start = drained_request_start.request_start;
                current_request_active_user_message_id =
                    drained_request_start.active_user_message_id;
                current_request_input_count = drained_request_start.input_count;
                current_request_active_input_source = drained_request_start.active_input_source;
                current_request_active_input_urgency = drained_request_start.active_input_urgency;
                current_request_active_input_metadata = drained_request_start.active_input_metadata;
                current_request_active_inputs = drained_request_start.active_inputs;
                current_request_recovery_attempted = false;
                prompt_material_snapshot = None;
                continue;
            }

            emit(
                &mut events,
                &config,
                "turn.completed",
                add_cycle_data(
                    turn_completed_data(
                        completed_cycle_provider_calls(active_cycle.as_ref(), provider_calls),
                        response.stop_reason,
                        turn_usage,
                    ),
                    active_cycle.as_ref(),
                ),
            );
            emit(&mut events, &config, "agent.idle", json!({}));
            return Ok(AgentRunResult {
                messages,
                stop_reason: response.stop_reason,
                provider_calls,
            });
        }

        let tool_calls = response.tool_calls;
        let mut prestarted_bash_tool_call_ids = HashSet::new();
        for (index, tool_call) in tool_calls.iter().cloned().enumerate() {
            let tool_profile_start = profiler_now(profiler.as_ref());
            if cancel.is_cancelled() {
                append_placeholder_tool_results(
                    &mut events,
                    &config,
                    &mut messages,
                    PersistContext {
                        context_recorder,
                        provider_calls,
                        active_request_boundary: ActiveRequestBoundary {
                            active_user_message_id: current_request_active_user_message_id
                                .as_deref(),
                            active_inputs: &current_request_active_inputs,
                            current_request_start,
                        },
                    },
                    active_cycle.as_ref(),
                    PlaceholderToolResults {
                        tool_calls: &tool_calls[index..],
                        prestarted_bash_tool_call_ids: &prestarted_bash_tool_call_ids,
                        kind: "tool_aborted",
                        text: "tool execution aborted",
                    },
                )
                .await?;
                let error =
                    AgentRunError::new(AgentRunErrorKind::Cancelled, &messages, provider_calls);
                emit_aborted_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
                return Err(error);
            }

            let bash_started_before_execute = bash_command_started_before_execute_candidate(
                &config,
                background_host.is_some(),
                &tool_call,
            );
            if let Some(background_detach_candidate) = bash_started_before_execute {
                emit_bash_command_execution_started(
                    &mut events,
                    &config,
                    active_cycle.as_ref(),
                    &tool_call,
                    background_detach_candidate,
                    false,
                );
                prestarted_bash_tool_call_ids.insert(tool_call.id.clone());
            } else {
                emit_tool_started(&mut events, &config, active_cycle.as_ref(), &tool_call);
            }
            fail_if_event_log_failed(&mut events, &messages, provider_calls)?;
            let tool_execution = execute_tool_call_with_policy(
                &config,
                tool_snapshot.as_ref(),
                tool_call.clone(),
                repair_provider_transcript(messages.clone()),
                cancel.clone(),
                background_host.clone(),
            )
            .await;
            let (mut tool_result, mut detached_run, mut detached_ack) = match tool_execution {
                ToolExecutionOutcome::Inline(result) => (result, None, false),
                ToolExecutionOutcome::Detached { ack, run } => (ack, Some(run), true),
            };
            if cancel.is_cancelled() {
                if let Some(run) = detached_run.as_ref() {
                    run.cancel();
                }
                append_placeholder_tool_results(
                    &mut events,
                    &config,
                    &mut messages,
                    PersistContext {
                        context_recorder,
                        provider_calls,
                        active_request_boundary: ActiveRequestBoundary {
                            active_user_message_id: current_request_active_user_message_id
                                .as_deref(),
                            active_inputs: &current_request_active_inputs,
                            current_request_start,
                        },
                    },
                    active_cycle.as_ref(),
                    PlaceholderToolResults {
                        tool_calls: &tool_calls[index..],
                        prestarted_bash_tool_call_ids: &prestarted_bash_tool_call_ids,
                        kind: "tool_aborted",
                        text: "tool execution aborted",
                    },
                )
                .await?;
                let error =
                    AgentRunError::new(AgentRunErrorKind::Cancelled, &messages, provider_calls);
                emit_aborted_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
                return Err(error);
            }
            if let Some(run) = detached_run.as_ref() {
                if !run.publish() {
                    run.cancel();
                    tool_result = background_task_publish_failed_tool_result(&tool_call);
                    detached_run = None;
                    detached_ack = false;
                }
            }
            tool_result = tool_result.bounded_for_transcript();
            let terminate = tool_result.terminate;
            let tool_result_message = Message::tool_result(tool_result);
            if detached_run.is_some() {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        if let Some(run) = detached_run.as_ref() {
                            let (host, task_id, tool_call, result) = run
                                .terminal_to_finish_without_start(
                                    "background task ack persistence aborted",
                                    "background_task_ack_aborted",
                                    TaskState::Cancelled,
                                );
                            host.finish_task(task_id, tool_call, result).await;
                        }
                        append_placeholder_tool_results(
                            &mut events,
                            &config,
                            &mut messages,
                            PersistContext {
                                context_recorder,
                                provider_calls,
                                active_request_boundary: ActiveRequestBoundary {
                                    active_user_message_id: current_request_active_user_message_id
                                        .as_deref(),
                                    active_inputs: &current_request_active_inputs,
                                    current_request_start,
                                },
                            },
                            active_cycle.as_ref(),
                            PlaceholderToolResults {
                                tool_calls: &tool_calls[index..],
                                prestarted_bash_tool_call_ids: &prestarted_bash_tool_call_ids,
                                kind: "tool_aborted",
                                text: "tool execution aborted",
                            },
                        )
                        .await?;
                        let error = AgentRunError::new(
                            AgentRunErrorKind::Cancelled,
                            &messages,
                            provider_calls,
                        );
                        emit_aborted_for_cycle(&mut events, &config, active_cycle.as_ref(), &error);
                        return Err(error);
                    }
                    result = record_tool_result_or_detached_ack(
                        &tool_result_message,
                        RecordContextMessage {
                            recorder: context_recorder,
                            event_log: &mut events,
                            config: &config,
                            messages: &messages,
                            provider_calls,
                            active_cycle: active_cycle.as_ref(),
                            active_request_boundary: ActiveRequestBoundary {
                                active_user_message_id: current_request_active_user_message_id.as_deref(),
                                active_inputs: &current_request_active_inputs,
                                current_request_start,
                            },
                        },
                        detached_run
                            .as_deref()
                            .map(DetachedAckPersistenceTarget::from_run),
                    ) => {
                        result?;
                    }
                }
            } else {
                record_tool_result_or_detached_ack(
                    &tool_result_message,
                    RecordContextMessage {
                        recorder: context_recorder,
                        event_log: &mut events,
                        config: &config,
                        messages: &messages,
                        provider_calls,
                        active_cycle: active_cycle.as_ref(),
                        active_request_boundary: ActiveRequestBoundary {
                            active_user_message_id: current_request_active_user_message_id
                                .as_deref(),
                            active_inputs: &current_request_active_inputs,
                            current_request_start,
                        },
                    },
                    None,
                )
                .await?;
            }
            let Message::ToolResult(tool_result) = &tool_result_message else {
                unreachable!("tool result message should contain a tool result");
            };
            let tool_result = tool_result.clone();
            messages.push(tool_result_message);
            if !detached_ack && bash_command(&tool_call).is_some() {
                let inline_replay_started = bash_started_before_execute == Some(true);
                if bash_started_before_execute.is_none() || inline_replay_started {
                    emit_bash_command_execution_started(
                        &mut events,
                        &config,
                        active_cycle.as_ref(),
                        &tool_call,
                        false,
                        inline_replay_started,
                    );
                }
            }
            emit_tool_completed(
                &mut events,
                &config,
                active_cycle.as_ref(),
                &tool_call,
                &tool_result,
                detached_ack,
            );
            if let Err(error) = fail_if_event_log_failed(&mut events, &messages, provider_calls) {
                if let Some(run) = detached_run.as_ref() {
                    let (host, task_id, tool_call, result) = run.terminal_to_finish_without_start(
                        "background task ack persistence failed",
                        "background_task_ack_persistence_failed",
                        TaskState::Failed,
                    );
                    host.finish_task(task_id, tool_call, result).await;
                }
                let error = if terminate {
                    error
                } else {
                    error.with_open_request_boundary(
                        current_request_active_user_message_id.as_deref(),
                        &current_request_active_inputs,
                        current_request_start,
                    )
                };
                return Err(error);
            }
            write_tool_profile_row(
                profiler.as_ref(),
                &config,
                active_cycle.as_ref(),
                &tool_call,
                index + 1,
                tool_profile_start,
                &tool_result,
            );
            if let Some(run) = detached_run {
                start_published_detached_tool_run(run);
            }
            if terminate {
                append_placeholder_tool_results(
                    &mut events,
                    &config,
                    &mut messages,
                    PersistContext {
                        context_recorder,
                        provider_calls,
                        active_request_boundary: ActiveRequestBoundary {
                            active_user_message_id: current_request_active_user_message_id
                                .as_deref(),
                            active_inputs: &current_request_active_inputs,
                            current_request_start,
                        },
                    },
                    active_cycle.as_ref(),
                    PlaceholderToolResults {
                        tool_calls: &tool_calls[index + 1..],
                        prestarted_bash_tool_call_ids: &prestarted_bash_tool_call_ids,
                        kind: "tool_skipped_after_terminate",
                        text: "tool skipped after terminating tool result",
                    },
                )
                .await?;
                emit(
                    &mut events,
                    &config,
                    "turn.completed",
                    add_cycle_data(
                        turn_completed_data(
                            completed_cycle_provider_calls(active_cycle.as_ref(), provider_calls),
                            StopReason::ToolTerminated,
                            turn_usage,
                        ),
                        active_cycle.as_ref(),
                    ),
                );
                emit(&mut events, &config, "agent.idle", json!({}));
                return Ok(AgentRunResult {
                    messages,
                    stop_reason: StopReason::ToolTerminated,
                    provider_calls,
                });
            }
        }
    }
}

fn duplicate_tool_call_id(tool_calls: &[ToolCall]) -> Option<&str> {
    let mut ids = HashSet::with_capacity(tool_calls.len());
    tool_calls
        .iter()
        .find_map(|call| (!ids.insert(call.id.as_str())).then_some(call.id.as_str()))
}

fn bash_command_started_before_execute_candidate(
    config: &AgentConfig,
    background_host_present: bool,
    tool_call: &ToolCall,
) -> Option<bool> {
    bash_command(tool_call)?;
    resolve_tool_execution_controls(&config.tool_execution, tool_call).ok()?;
    Some(background_host_present)
}

#[derive(Clone, Copy)]
struct ActiveRequestBoundary<'a> {
    active_user_message_id: Option<&'a str>,
    active_inputs: &'a [ActiveRequestInput],
    current_request_start: usize,
}

pub(super) struct RecordContextMessage<'a, 'log> {
    recorder: Option<&'a dyn AgentContextRecorder>,
    event_log: &'a mut Option<AgentEventLog<'log>>,
    config: &'a AgentConfig,
    messages: &'a [Message],
    provider_calls: usize,
    active_cycle: Option<&'a ActiveCycle>,
    active_request_boundary: ActiveRequestBoundary<'a>,
}

pub(super) async fn record_context_message(
    message: &Message,
    context: RecordContextMessage<'_, '_>,
) -> Result<(), AgentRunError> {
    let RecordContextMessage {
        recorder,
        event_log,
        config,
        messages,
        provider_calls,
        active_cycle,
        active_request_boundary,
    } = context;
    let Some(recorder) = recorder else {
        return Ok(());
    };
    if let Err(error) = recorder.record_message(message).await {
        let error = AgentRunError::new(
            AgentRunErrorKind::Persistence {
                message: error.to_string(),
            },
            messages,
            provider_calls,
        )
        .with_open_request_boundary(
            active_request_boundary.active_user_message_id,
            active_request_boundary.active_inputs,
            active_request_boundary.current_request_start,
        );
        emit_error_for_cycle(event_log, config, active_cycle, &error);
        return Err(error);
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct PersistContext<'a> {
    context_recorder: Option<&'a dyn AgentContextRecorder>,
    provider_calls: usize,
    active_request_boundary: ActiveRequestBoundary<'a>,
}

struct PlaceholderToolResults<'a> {
    tool_calls: &'a [ToolCall],
    prestarted_bash_tool_call_ids: &'a HashSet<String>,
    kind: &'a str,
    text: &'a str,
}

async fn append_placeholder_tool_results(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    messages: &mut Vec<Message>,
    persist: PersistContext<'_>,
    active_cycle: Option<&ActiveCycle>,
    placeholders: PlaceholderToolResults<'_>,
) -> Result<(), AgentRunError> {
    for tool_call in placeholders.tool_calls {
        let result = ToolResult::error(
            tool_call.id.clone(),
            tool_call.name.clone(),
            placeholders.text,
            json!({ "kind": placeholders.kind }),
        );
        let message = Message::tool_result(result.bounded_for_transcript());
        record_context_message(
            &message,
            RecordContextMessage {
                recorder: persist.context_recorder,
                event_log,
                config,
                messages,
                provider_calls: persist.provider_calls,
                active_cycle,
                active_request_boundary: persist.active_request_boundary,
            },
        )
        .await?;
        let Message::ToolResult(result) = &message else {
            unreachable!("placeholder tool result should be a tool result");
        };
        if !placeholders
            .prestarted_bash_tool_call_ids
            .contains(&tool_call.id)
        {
            emit_bash_command_execution_started(
                event_log,
                config,
                active_cycle,
                tool_call,
                false,
                false,
            );
        }
        emit_tool_completed(event_log, config, active_cycle, tool_call, result, false);
        messages.push(message);
    }
    Ok(())
}

fn add_provider_usage(turn_usage: &mut AgentUsage, usage: Option<Usage>) {
    let Some(usage) = usage else {
        return;
    };

    turn_usage.input_tokens += usage.input_tokens;
    turn_usage.cached_input_tokens += usage.cached_input_tokens;
    turn_usage.output_tokens += usage.output_tokens;
    turn_usage.reasoning_output_tokens += usage.reasoning_output_tokens;
}

fn bash_command(tool_call: &ToolCall) -> Option<&str> {
    if tool_call.name != "bash" {
        return None;
    }
    tool_call.arguments.get("command").and_then(Value::as_str)
}

fn bash_exit_code(result: &ToolResult) -> Option<i32> {
    result
        .details
        .get("exit_code")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
}

fn bash_output_tail(result: &ToolResult) -> &str {
    result
        .details
        .get("output_tail")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn copy_bash_output_metadata(result: &ToolResult, data: &mut Value) {
    for key in [
        "output_artifact_path",
        "output_live",
        "output_complete",
        "output_bytes",
        "output_tail_truncated",
        "output_artifact_truncated",
        "output_dropped_bytes",
    ] {
        if let Some(value) = result.details.get(key) {
            data[key] = value.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::tools::ToolSpec;

    struct CountingTool {
        calls: Arc<AtomicUsize>,
    }

    impl CountingTool {
        fn new() -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    struct FutureDropGuard {
        drops: Arc<AtomicUsize>,
    }

    impl Drop for FutureDropGuard {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct PendingTool {
        starts: AtomicUsize,
        start_notify: Notify,
        drops: Arc<AtomicUsize>,
    }

    impl PendingTool {
        fn new(drops: Arc<AtomicUsize>) -> Self {
            Self {
                starts: AtomicUsize::new(0),
                start_notify: Notify::new(),
                drops,
            }
        }

        async fn wait_started(&self) {
            loop {
                let notified = self.start_notify.notified();
                if self.starts.load(Ordering::SeqCst) > 0 {
                    return;
                }
                notified.await;
            }
        }
    }

    #[async_trait]
    impl Tool for PendingTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new("pending", "pending test tool", json!({"type": "object"}))
        }

        async fn execute(
            &self,
            _call: ToolCall,
            _context: ToolExecutionContext,
            _cancel: CancellationToken,
        ) -> Result<ToolResult, ToolError> {
            let _drop_guard = FutureDropGuard {
                drops: self.drops.clone(),
            };
            self.starts.fetch_add(1, Ordering::SeqCst);
            self.start_notify.notify_waiters();
            std::future::pending().await
        }
    }

    struct CooperativeCancelTool {
        starts: AtomicUsize,
        start_notify: Notify,
        drops: Arc<AtomicUsize>,
    }

    impl CooperativeCancelTool {
        fn new(drops: Arc<AtomicUsize>) -> Self {
            Self {
                starts: AtomicUsize::new(0),
                start_notify: Notify::new(),
                drops,
            }
        }

        async fn wait_started(&self) {
            loop {
                let notified = self.start_notify.notified();
                if self.starts.load(Ordering::SeqCst) > 0 {
                    return;
                }
                notified.await;
            }
        }
    }

    #[async_trait]
    impl Tool for CooperativeCancelTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(
                "cooperative",
                "cooperative cancellation test tool",
                json!({"type": "object"}),
            )
        }

        async fn execute(
            &self,
            call: ToolCall,
            _context: ToolExecutionContext,
            cancel: CancellationToken,
        ) -> Result<ToolResult, ToolError> {
            let _drop_guard = FutureDropGuard {
                drops: self.drops.clone(),
            };
            self.starts.fetch_add(1, Ordering::SeqCst);
            self.start_notify.notify_waiters();
            cancel.cancelled().await;
            Ok(ToolResult::success(call.id, call.name, "cleaned up"))
        }
    }

    struct CompletionRaceTool {
        starts: AtomicUsize,
        start_notify: Notify,
        finish_barrier: Arc<tokio::sync::Barrier>,
    }

    impl CompletionRaceTool {
        fn new(finish_barrier: Arc<tokio::sync::Barrier>) -> Self {
            Self {
                starts: AtomicUsize::new(0),
                start_notify: Notify::new(),
                finish_barrier,
            }
        }

        async fn wait_started(&self) {
            loop {
                let notified = self.start_notify.notified();
                if self.starts.load(Ordering::SeqCst) > 0 {
                    return;
                }
                notified.await;
            }
        }
    }

    #[async_trait]
    impl Tool for CompletionRaceTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(
                "race",
                "completion race test tool",
                json!({"type": "object"}),
            )
        }

        async fn execute(
            &self,
            call: ToolCall,
            _context: ToolExecutionContext,
            _cancel: CancellationToken,
        ) -> Result<ToolResult, ToolError> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            self.start_notify.notify_waiters();
            self.finish_barrier.wait().await;
            Ok(ToolResult::success(call.id, call.name, "finished"))
        }
    }

    #[async_trait]
    impl Tool for CountingTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(
                "counting",
                "counting test tool",
                json!({
                    "type": "object",
                    "properties": {}
                }),
            )
        }

        async fn execute(
            &self,
            call: ToolCall,
            _context: ToolExecutionContext,
            _cancel: CancellationToken,
        ) -> Result<ToolResult, ToolError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ToolResult::success(call.id, call.name, "done"))
        }
    }

    struct RejectingBackgroundHost {
        manager: Arc<BackgroundTaskManager>,
        publish_calls: AtomicUsize,
        finish_calls: AtomicUsize,
    }

    impl RejectingBackgroundHost {
        fn new() -> Self {
            Self {
                manager: Arc::new(BackgroundTaskManager::new()),
                publish_calls: AtomicUsize::new(0),
                finish_calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl BackgroundExecutionHost for RejectingBackgroundHost {
        fn allocate_task_id(&self) -> String {
            "task_rejected".to_owned()
        }

        fn task_manager(&self) -> Arc<BackgroundTaskManager> {
            self.manager.clone()
        }

        fn publish_task(&self, _task_id: String, _task: NewBackgroundTask) -> bool {
            self.publish_calls.fetch_add(1, Ordering::SeqCst);
            false
        }

        async fn finish_task(
            &self,
            _task_id: String,
            _tool_call: ToolCall,
            _result: DetachedToolResult,
        ) {
            self.finish_calls.fetch_add(1, Ordering::SeqCst);
        }

        fn interactive_stdio_bridge(
            &self,
            _task_id: &str,
        ) -> Option<Arc<dyn InteractiveStdioBridge>> {
            None
        }
    }

    struct PublishingBackgroundHost {
        manager: Arc<BackgroundTaskManager>,
        publish_calls: AtomicUsize,
        finish_calls: AtomicUsize,
        finish_results: Mutex<Vec<DetachedToolResult>>,
        finish_notify: Notify,
        cancel_on_publish: bool,
    }

    impl PublishingBackgroundHost {
        fn new(cancel_on_publish: bool) -> Self {
            Self {
                manager: Arc::new(BackgroundTaskManager::new()),
                publish_calls: AtomicUsize::new(0),
                finish_calls: AtomicUsize::new(0),
                finish_results: Mutex::new(Vec::new()),
                finish_notify: Notify::new(),
                cancel_on_publish,
            }
        }

        async fn wait_for_finish_count(&self, expected: usize) {
            loop {
                let notified = self.finish_notify.notified();
                if self.finish_calls.load(Ordering::SeqCst) >= expected {
                    return;
                }
                notified.await;
            }
        }

        fn finish_results(&self) -> Vec<DetachedToolResult> {
            self.finish_results
                .lock()
                .expect("finish results mutex poisoned")
                .clone()
        }
    }

    #[async_trait]
    impl BackgroundExecutionHost for PublishingBackgroundHost {
        fn allocate_task_id(&self) -> String {
            "task_published".to_owned()
        }

        fn task_manager(&self) -> Arc<BackgroundTaskManager> {
            self.manager.clone()
        }

        fn publish_task(&self, task_id: String, task: NewBackgroundTask) -> bool {
            self.publish_calls.fetch_add(1, Ordering::SeqCst);
            self.manager.start_task_with_id(task_id.clone(), task);
            if self.cancel_on_publish {
                self.manager.cancel(&task_id);
            }
            true
        }

        async fn finish_task(
            &self,
            task_id: String,
            _tool_call: ToolCall,
            result: DetachedToolResult,
        ) {
            self.manager
                .finish_task(&task_id, result.state, "task reached terminal state");
            self.finish_results
                .lock()
                .expect("finish results mutex poisoned")
                .push(result);
            self.finish_calls.fetch_add(1, Ordering::SeqCst);
            self.finish_notify.notify_waiters();
        }

        fn interactive_stdio_bridge(
            &self,
            _task_id: &str,
        ) -> Option<Arc<dyn InteractiveStdioBridge>> {
            None
        }
    }

    fn start_no_deadline_test_run(
        host: Arc<PublishingBackgroundHost>,
        task_id: &str,
        tool_name: &str,
        tool: Arc<dyn Tool>,
        cancel: CancellationToken,
    ) {
        let tool_call = ToolCall::new(format!("call_{task_id}"), tool_name, json!({}));
        let task = NewBackgroundTask::new(
            tool_call.id.clone(),
            tool_call.name.clone(),
            tool_call.arguments_json_string(),
        )
        .with_cancel_token(cancel.clone());
        start_detached_tool_run(Box::new(DetachedToolRun {
            host,
            task_id: task_id.to_owned(),
            task,
            tool_call: tool_call.clone(),
            runnable: RunnableToolExecution {
                tool,
                tool_call,
                cwd: ".".to_owned(),
                provider_transcript_snapshot: Vec::new(),
                timeout: ToolTimeout::NoDeadline,
                output_sink: None,
                interactive_stdio: None,
            },
            output_sink: None,
            prepublish_interactive_stdio: None,
            cancel,
            pending: None,
        }));
    }

    #[tokio::test]
    async fn publish_rejection_cancels_detached_run_without_starting_tool() {
        let host = Arc::new(RejectingBackgroundHost::new());
        let tool = Arc::new(CountingTool::new());
        let cancel = CancellationToken::new();
        let tool_call = ToolCall::new("call_rejected", "counting", json!({}));
        let task = NewBackgroundTask::new("call_rejected", "counting", "{}")
            .with_cancel_token(cancel.clone());

        start_detached_tool_run(Box::new(DetachedToolRun {
            host: host.clone(),
            task_id: "task_rejected".to_owned(),
            task,
            tool_call: tool_call.clone(),
            runnable: RunnableToolExecution {
                tool: tool.clone(),
                tool_call,
                cwd: ".".to_owned(),
                provider_transcript_snapshot: Vec::new(),
                timeout: ToolTimeout::NoDeadline,
                output_sink: None,
                interactive_stdio: None,
            },
            output_sink: None,
            prepublish_interactive_stdio: None,
            cancel: cancel.clone(),
            pending: None,
        }));

        assert_eq!(host.publish_calls.load(Ordering::SeqCst), 1);
        assert!(cancel.is_cancelled());
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert_eq!(tool.calls(), 0);
        assert_eq!(host.finish_calls.load(Ordering::SeqCst), 0);
        assert!(host.manager.list().is_empty());
    }

    #[tokio::test]
    async fn cancelled_detached_run_before_first_poll_does_not_start_tool() {
        let host = Arc::new(PublishingBackgroundHost::new(true));
        let tool = Arc::new(CountingTool::new());
        let cancel = CancellationToken::new();
        let tool_call = ToolCall::new("call_cancelled", "counting", json!({}));
        let task = NewBackgroundTask::new("call_cancelled", "counting", "{}")
            .with_cancel_token(cancel.clone());

        start_detached_tool_run(Box::new(DetachedToolRun {
            host: host.clone(),
            task_id: "task_cancelled".to_owned(),
            task,
            tool_call: tool_call.clone(),
            runnable: RunnableToolExecution {
                tool: tool.clone(),
                tool_call,
                cwd: ".".to_owned(),
                provider_transcript_snapshot: Vec::new(),
                timeout: ToolTimeout::NoDeadline,
                output_sink: None,
                interactive_stdio: None,
            },
            output_sink: None,
            prepublish_interactive_stdio: None,
            cancel: cancel.clone(),
            pending: None,
        }));

        tokio::time::timeout(Duration::from_secs(1), host.wait_for_finish_count(1))
            .await
            .expect("cancelled detached run should finish");
        assert_eq!(host.publish_calls.load(Ordering::SeqCst), 1);
        assert_eq!(tool.calls(), 0);
        assert!(cancel.is_cancelled());
        let results = host.finish_results();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].state, TaskState::Cancelled);
        assert_eq!(results[0].tool_result.details["cancelled"], json!(true));
        assert_eq!(
            host.manager
                .get("task_cancelled")
                .expect("task should be recorded")
                .state,
            TaskState::Cancelled
        );
    }

    #[tokio::test(start_paused = true)]
    async fn detached_no_deadline_pending_tool_is_aborted_after_task_cancel_grace() {
        let host = Arc::new(PublishingBackgroundHost::new(false));
        let drops = Arc::new(AtomicUsize::new(0));
        let tool = Arc::new(PendingTool::new(drops.clone()));
        let cancel = CancellationToken::new();
        start_no_deadline_test_run(
            host.clone(),
            "task_pending_cancel",
            "pending",
            tool.clone(),
            cancel,
        );
        tool.wait_started().await;

        host.manager
            .cancel("task_pending_cancel")
            .expect("published task should be cancellable");
        tokio::task::yield_now().await;
        tokio::time::advance(TOOL_TIMEOUT_CLEANUP_GRACE + Duration::from_millis(1)).await;
        tokio::time::timeout(Duration::from_secs(1), host.wait_for_finish_count(1))
            .await
            .expect("cancelled pending tool should finish after cleanup grace");

        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert_eq!(host.finish_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.finish_results()[0].state, TaskState::Cancelled);
        assert_eq!(
            host.manager
                .get("task_pending_cancel")
                .expect("task should remain recorded")
                .state,
            TaskState::Cancelled
        );
    }

    #[tokio::test(start_paused = true)]
    async fn detached_no_deadline_pending_tool_is_aborted_after_shutdown_cancel_grace() {
        let host = Arc::new(PublishingBackgroundHost::new(false));
        let drops = Arc::new(AtomicUsize::new(0));
        let tool = Arc::new(PendingTool::new(drops.clone()));
        let cancel = CancellationToken::new();
        start_no_deadline_test_run(
            host.clone(),
            "task_pending_shutdown",
            "pending",
            tool.clone(),
            cancel.clone(),
        );
        tool.wait_started().await;

        cancel.cancel();
        tokio::task::yield_now().await;
        tokio::time::advance(TOOL_TIMEOUT_CLEANUP_GRACE + Duration::from_millis(1)).await;
        tokio::time::timeout(Duration::from_secs(1), host.wait_for_finish_count(1))
            .await
            .expect("shutdown-cancelled pending tool should finish after cleanup grace");

        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert_eq!(host.finish_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.finish_results()[0].state, TaskState::Cancelled);
        assert_eq!(
            host.manager
                .get("task_pending_shutdown")
                .expect("task should remain recorded")
                .state,
            TaskState::Cancelled
        );
    }

    #[tokio::test]
    async fn detached_no_deadline_cooperative_cancel_finishes_once_within_grace() {
        let host = Arc::new(PublishingBackgroundHost::new(false));
        let drops = Arc::new(AtomicUsize::new(0));
        let tool = Arc::new(CooperativeCancelTool::new(drops.clone()));
        let cancel = CancellationToken::new();
        start_no_deadline_test_run(
            host.clone(),
            "task_cooperative_cancel",
            "cooperative",
            tool.clone(),
            cancel.clone(),
        );
        tool.wait_started().await;

        cancel.cancel();
        tokio::time::timeout(Duration::from_millis(250), host.wait_for_finish_count(1))
            .await
            .expect("cooperative tool should finish without exhausting cleanup grace");

        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert_eq!(host.finish_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.finish_results()[0].state, TaskState::Cancelled);
    }

    #[tokio::test]
    async fn detached_no_deadline_completion_cancel_race_finishes_exactly_once() {
        let host = Arc::new(PublishingBackgroundHost::new(false));
        let finish_barrier = Arc::new(tokio::sync::Barrier::new(2));
        let tool = Arc::new(CompletionRaceTool::new(finish_barrier.clone()));
        let cancel = CancellationToken::new();
        start_no_deadline_test_run(
            host.clone(),
            "task_completion_cancel_race",
            "race",
            tool.clone(),
            cancel.clone(),
        );
        tool.wait_started().await;

        let cancel_task = tokio::spawn(async move {
            finish_barrier.wait().await;
            cancel.cancel();
        });
        tokio::time::timeout(Duration::from_secs(1), host.wait_for_finish_count(1))
            .await
            .expect("completion/cancel race should reach a terminal result");
        cancel_task.await.expect("cancel racer should not panic");
        tokio::time::sleep(Duration::from_millis(25)).await;

        assert_eq!(host.finish_calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.finish_results().len(), 1);
        assert!(host
            .manager
            .get("task_completion_cancel_race")
            .expect("task should remain recorded")
            .state
            .is_terminal());
    }
}
