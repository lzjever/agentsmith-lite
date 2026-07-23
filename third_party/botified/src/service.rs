use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, Weak,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::sync::{mpsc, Mutex as AsyncMutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::agent_events::ThreadEvent;
use crate::agent_loop::{
    run_agent_with_shared_event_log_and_compaction_hook, validate_final_tool_names,
    AcceptedInputEntry, ActiveRequestInput, AgentCommitError, AgentCompactionHook,
    AgentCompactionSafePoint, AgentCompactionUpdate, AgentConfig, AgentContextRecorder,
    AgentInputDrainer, AgentProviderRequestAction, AgentProviderRequestBudget, AgentRunErrorKind,
    BackgroundExecutionHost, DetachedToolResult, DrainBatch, DrainCommit, DrainedMessage,
    FinalToolSnapshot, InputSource, InputUrgency, MessageDelivery, QueuedInputMetadata,
    SharedAgentRunOptions, SharedEventAppender, TaskCallbackExecutionState,
};
use crate::config::RuntimeTaskPresetsConfig;
use crate::event::{
    EventCursor, EventLog, EventReadError, EventReadWindow, ServiceEvent,
    DEFAULT_EVENT_LOG_CAPACITY,
};
use crate::files::{ExternalFileMetadata, FileStore};
use crate::formatting::bounded_chars;
use crate::llm_text_preview::{
    LlmTextPreviewFilter, LlmTextPreviewHub, LlmTextPreviewSink, LlmTextPreviewSubscription,
};
use crate::message_render::render_file_manifest;
use crate::profiling::{CsvEventRow, ProviderProfilingContext, SharedProfiler};
use crate::provider::runtime_selection::{RuntimeSelectionHandle, RuntimeThinkingLevelPatch};
use crate::provider::{Provider, ProviderMetadata};
#[cfg(test)]
use crate::registry::RegistryQuery;
use crate::registry::{RegistryMaintenanceHandle, RegistryStore, RegistryWriterKind};
use crate::registry_protocol::{
    registry_error_stdio_frame, registry_snapshot_stdio_frame, stdio_registry_response_cap,
};
use crate::session::{
    retain_recent_known_user_messages_for_replay, retain_recent_message_cursors_for_replay,
    CallbackDeliveryEventType, CallbackDeliveryIntent, CompactionMetadata, DurableMessageCursor,
    FileSessionRecorder, SessionReplay, SessionRestartBoundary,
    DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW,
};
use crate::subagents::{
    SubagentCallbackStatus, SubagentLifecycle, SubagentLimits, SubagentManager,
    SubagentManagerError, SubagentRunState, SubagentSnapshot,
};
use crate::task_observer::{
    FinalTextObservation, FinalTextObservationKind, ObserverCommitError, TaskConversationObserver,
    TaskObserverDiagnostic, TaskObserverRequestAdmission,
};
#[cfg(test)]
use crate::tasks::TASK_STDIN_FRAME_SAFETY_CEILING;
use crate::tasks::{
    task_cancel_result_summary, task_detail_summary, task_exception_frame, task_list_summary,
    task_observe_result_disabled_frame, task_observe_result_enabled_frame,
    task_observe_result_failure_frame, task_state_name, try_write_task_stdin_frame,
    validate_task_stdin_frame, BackgroundTaskManager, BotifiedFrameEvent, BoundedTaskOutputSink,
    CallbackDelivery, InteractiveStdioBridge, NewBackgroundTask, TaskCallbackPayloadSnapshot,
    TaskFrameDiagnostic, TaskListTool, TaskObserveConfig, TaskObserveDelivery,
    TaskObserveRequestAction, TaskObserveRequestFrame, TaskObserveRequestRejectedFrame,
    TaskOutputUpdate, TaskOwner, TaskRegistryGetFrame, TaskRegistrySetFrame, TaskReplyOutcome,
    TaskReplyPlan, TaskReplyStatus, TaskRequestAdmission, TaskRequestEffect, TaskRequestFrame,
    TaskRequestSnapshot, TaskRequestState, TaskSnapshot, TaskState, TaskStdinFrameKind,
    TaskStdinIntent, TaskStdinIntentKind, TaskStdinWriteSuccess, TaskStdinWriter, TaskTellFrame,
};
use crate::timeline::{input_item_id, project_timeline_event, task_ask_item_id, TIMELINE_VERSION};
use crate::timeline_store::{
    TimelineAppend, TimelineForwardPage, TimelineHistoryPage, TimelineStore, TimelineStoreError,
    TimelineStoreOptions, TimelineWriteFailure, DEFAULT_TIMELINE_HOT_EVENT_CAPACITY,
    DEFAULT_TIMELINE_RETENTION_DAYS,
};
use crate::tools::{
    registry_tools_for_writer, tools_for_subagent, BashTool, FilePublicationSink, PublishFileTool,
    Tool, ToolExecutionContext, ToolOutputSink, ToolVisibility,
};
#[cfg(test)]
use crate::tools::{ToolError, ToolSpec};
use crate::transcript::{
    repair_provider_transcript, request_range_contains_synthetic_missing_tool_result,
};
use crate::types::{ContentPart, Message, StopReason, ToolCall, ToolResult};

mod compaction_runtime;
mod compaction_shared;
mod event_persistence;
mod facade;
mod input_enqueue;
mod public_replay;
mod runtime_tools;
mod subagent_compaction;
mod subagent_projection;
mod subagent_runtime;
mod subagent_tools;
mod task_bridge;
mod task_projection;
mod task_runtime;
mod tools;

use self::compaction_runtime::{PendingRecoveryRecord, ServiceCompactionHook};
use self::compaction_shared::CompactCoordinator;
use self::event_persistence::*;
use self::input_enqueue::*;
use self::public_replay::{
    durable_terminal_seq, persist_public_replay, PublicReplayProjectionBuffer,
};
#[cfg(test)]
use self::public_replay::{
    plan_buffered_public_replay_cursors, plan_raw_public_replay_cursors,
    synthetic_turn_completed_event,
};
use self::runtime_tools::{AgentRuntimeGetTool, AgentRuntimeSetTool};
#[cfg(test)]
use self::subagent_runtime::{
    enqueue_subagent_callback, enqueue_subagent_callback_input, maybe_start_next_subagent_run,
    rollback_enqueued_subagent_callback, run_subagent_loop, spawn_subagent_loop,
    terminalize_failed_subagent_run, terminalize_failed_subagent_run_for_current,
    SubagentCallbackFacts, SubagentTestHookKind, SubagentTestHooks,
};
use self::subagent_runtime::{
    enqueue_subagent_text_callback, new_subagent_callback_epoch, valid_subagent_callback_metadata,
};
use self::subagent_tools::{
    SubagentCancelTool, SubagentListTool, SubagentReadTool, SubagentSendTool, SubagentSpawnTool,
};
use self::tools::{
    ServiceTaskCancelTool, ServiceTaskPresetListTool, ServiceTaskPresetStartTool,
    ServiceTaskReplyTool, ServiceTaskSendTool,
};
#[cfg(test)]
use task_bridge::TaskRequestFrameAdmission;
use task_bridge::{
    InternalStdioDiagnostics, ServiceInteractiveStdioBridge, TaskFrameAdmissionGate,
    TaskFrameAdmissionKind,
};
use task_projection::{
    active_task_status, subagent_task_callback_kind, task_callback_content, task_callback_metadata,
    task_event_data, task_reply_details, task_request_state_name, task_requires_active_item,
    task_tell_event_data, terminal_task_event_type,
};
#[cfg(test)]
use task_projection::{task_request_content, task_request_event_data};
use task_runtime::{
    retry_pending_task_callbacks, retry_pending_task_callbacks_for_inner,
    ServiceBackgroundExecutionHost,
};

const SERVICE_WORKER_PANIC_MAX_CHARS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(super) struct ContextMaintenanceStatus {
    pub(super) provider_calls_paused: bool,
    reason: Option<&'static str>,
    degraded: bool,
    volatile: bool,
    observed_input_tokens: Option<usize>,
    hard_stop_tokens: Option<usize>,
}

impl ContextMaintenanceStatus {
    fn paused(reason: &'static str, observed_input_tokens: usize, hard_stop_tokens: usize) -> Self {
        Self {
            provider_calls_paused: true,
            reason: Some(reason),
            degraded: false,
            volatile: false,
            observed_input_tokens: Some(observed_input_tokens),
            hard_stop_tokens: Some(hard_stop_tokens),
        }
    }

    fn degraded(
        reason: &'static str,
        volatile: bool,
        observed_input_tokens: usize,
        hard_stop_tokens: usize,
    ) -> Self {
        Self {
            provider_calls_paused: false,
            reason: Some(reason),
            degraded: true,
            volatile,
            observed_input_tokens: Some(observed_input_tokens),
            hard_stop_tokens: Some(hard_stop_tokens),
        }
    }

    fn with_pause(
        mut self,
        reason: &'static str,
        observed_input_tokens: usize,
        hard_stop_tokens: usize,
    ) -> Self {
        self.provider_calls_paused = true;
        self.reason = Some(reason);
        self.observed_input_tokens = Some(observed_input_tokens);
        self.hard_stop_tokens = Some(hard_stop_tokens);
        self
    }

    fn without_pause(mut self) -> Self {
        self.provider_calls_paused = false;
        self
    }

    fn public_summary(&self) -> Option<&'static str> {
        if self.provider_calls_paused {
            Some("History is being shortened before continuing.")
        } else if self.volatile {
            Some("History was shortened, but the recovery has not been saved yet.")
        } else if self.degraded {
            Some("History was shortened so the conversation can continue.")
        } else {
            None
        }
    }

    pub(super) fn to_json(&self) -> Value {
        let status = if self.provider_calls_paused {
            "provider_calls_paused"
        } else if self.volatile {
            "volatile_degraded"
        } else if self.degraded {
            "degraded"
        } else {
            "idle"
        };
        json!({
            "provider_calls_paused": self.provider_calls_paused,
            "degraded": self.degraded,
            "volatile": self.volatile,
            "status": status,
            "reason": self.reason,
            "summary": self.public_summary()
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TaskSendStatus {
    Written,
    UnknownTask,
    TaskTerminal,
    StdinNotWritable,
    MessageTooLarge,
    WriteFailed,
    ServiceUnavailable,
}

#[derive(Debug, Clone)]
struct TaskSendOutcome {
    status: TaskSendStatus,
    task_id: String,
    send_id: Option<String>,
    message: String,
}

impl TaskSendOutcome {
    fn new(
        status: TaskSendStatus,
        task_id: impl Into<String>,
        send_id: Option<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status,
            task_id: task_id.into(),
            send_id,
            message: message.into(),
        }
    }

    fn ok(&self) -> bool {
        self.status == TaskSendStatus::Written
    }
}

#[derive(Debug, Clone)]
struct TaskTellSnapshot {
    task_id: String,
    tool_call_id: String,
    tool_name: String,
    arguments_summary: String,
    task_label: Option<String>,
    work_summary: Option<String>,
    owner: TaskOwner,
    sender: String,
    tell_id: String,
    message: String,
    urgency: InputUrgency,
    state: &'static str,
    told_at: SystemTime,
    failure_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnqueueSubmitStatus {
    Started,
    Queued,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnqueueOutcome {
    pub submit_status: EnqueueSubmitStatus,
    pub service_status: ServiceStatus,
    pub turn_id: Option<String>,
    pub cursor: EventCursor,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryReceipt {
    pub delivery_key: String,
    pub request_hash: String,
    pub message_id: String,
    pub cursor: EventCursor,
}

impl std::ops::Deref for EnqueueOutcome {
    type Target = ServiceStatus;

    fn deref(&self) -> &Self::Target {
        &self.service_status
    }
}

struct BuiltinServiceToolContext {
    background_tasks: Arc<BackgroundTaskManager>,
    inner: Weak<ServiceInner>,
    file_store: Option<FileStore>,
    registry_store: Option<RegistryStore>,
    runtime_selection: Option<(RuntimeSelectionHandle, bool)>,
    owner: TaskOwner,
    subagents_enabled: bool,
}

impl Drop for ServiceInner {
    fn drop(&mut self) {
        self.registry_maintenance_cancel.cancel();
    }
}

pub(super) struct SubagentSpawnRequest<'a> {
    pub(super) task: &'a str,
    pub(super) name_hint: &'a str,
    pub(super) inherit_context: bool,
    pub(super) provider_name: Option<String>,
    pub(super) thinking_level: RuntimeThinkingLevelPatch,
    pub(super) provider_transcript_snapshot: Option<Vec<Message>>,
}

fn with_builtin_service_tools(
    mut tools: Vec<Arc<dyn Tool>>,
    context: BuiltinServiceToolContext,
) -> Vec<Arc<dyn Tool>> {
    let BuiltinServiceToolContext {
        background_tasks,
        inner,
        file_store,
        registry_store,
        runtime_selection,
        owner,
        subagents_enabled,
    } = context;
    if let Some(file_store) = file_store {
        tools.push(Arc::new(PublishFileTool::new(
            file_store,
            Arc::new(ServiceFilePublicationSink::new(inner.clone())),
        )));
    }
    if let Some(registry_store) = registry_store {
        let (writer_kind, origin) = registry_writer_for_owner(&owner);
        tools.extend(registry_tools_for_writer(
            registry_store,
            writer_kind,
            origin,
        ));
    }
    tools.push(Arc::new(TaskListTool::new_for_owner(
        background_tasks.clone(),
        owner.clone(),
    )));
    tools.push(Arc::new(ServiceTaskCancelTool::new(
        inner.clone(),
        owner.clone(),
    )));
    tools.push(Arc::new(ServiceTaskReplyTool::new(
        inner.clone(),
        owner.clone(),
    )));
    tools.push(Arc::new(ServiceTaskSendTool::new(
        inner.clone(),
        owner.clone(),
    )));
    if owner == TaskOwner::Main {
        tools.push(Arc::new(ServiceTaskPresetListTool::new(inner.clone())));
        tools.push(Arc::new(ServiceTaskPresetStartTool::new(inner.clone())));
    }
    if let Some((runtime_selection, can_set)) = runtime_selection {
        tools.push(Arc::new(AgentRuntimeGetTool::new(
            runtime_selection.clone(),
            can_set,
        )));
        if can_set {
            tools.push(Arc::new(AgentRuntimeSetTool::new(runtime_selection)));
        }
    }
    if subagents_enabled {
        tools.push(Arc::new(SubagentSpawnTool::new(inner.clone())));
        tools.push(Arc::new(SubagentSendTool::new(inner.clone())));
        tools.push(Arc::new(SubagentReadTool::new(inner.clone())));
        tools.push(Arc::new(SubagentListTool::new(inner.clone())));
        tools.push(Arc::new(SubagentCancelTool::new(inner)));
    }
    tools
}

fn subagent_tool_configuration_error(
    base_tools: &[Arc<dyn Tool>],
    main_snapshot: &FinalToolSnapshot,
    registry_enabled: bool,
    runtime_enabled: bool,
) -> Option<String> {
    let mut names = base_tools
        .iter()
        .zip(main_snapshot.specs())
        .filter(|(tool, _)| tool.visibility() == ToolVisibility::Inherited)
        .map(|(_, spec)| spec.name.clone())
        .collect::<Vec<_>>();
    names.extend(["task_list", "task_cancel", "task_reply", "task_send"].map(str::to_owned));
    if registry_enabled {
        names.extend(
            [
                "registry_delete",
                "registry_get",
                "registry_history",
                "registry_set",
            ]
            .map(str::to_owned),
        );
    }
    if runtime_enabled {
        names.push("agent_runtime_get".to_owned());
    }
    validate_final_tool_names(names.iter().map(String::as_str))
        .err()
        .map(|message| format!("invalid subagent tool configuration: {message}"))
}

fn registry_writer_for_owner(owner: &TaskOwner) -> (RegistryWriterKind, String) {
    match owner {
        TaskOwner::Main => (RegistryWriterKind::MainAgent, "main_agent".to_owned()),
        TaskOwner::Subagent { subagent_id } => (
            RegistryWriterKind::Subagent,
            format!("subagent:{subagent_id}"),
        ),
    }
}

struct ServiceFilePublicationSink {
    inner: Weak<ServiceInner>,
}

impl ServiceFilePublicationSink {
    fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

impl FilePublicationSink for ServiceFilePublicationSink {
    fn record_file_published(&self, metadata: &ExternalFileMetadata) -> Result<(), String> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| "service is no longer available".to_owned())?;
        let turn_id = {
            inner
                .state
                .lock()
                .map_err(|_| "service state mutex poisoned".to_owned())?
                .active_turn_id
                .clone()
        };
        let data = serde_json::to_value(metadata)
            .map_err(|error| format!("failed to serialize file metadata: {error}"))?;
        match inner.try_append_event_for_turn(turn_id.as_deref(), "file.published", data) {
            Ok(_) => Ok(()),
            Err(error) => {
                let message = format!("timeline persistence failed: {error}");
                inner.record_timeline_persistence_error(error);
                Err(message)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    Idle,
    Running,
    Aborting,
    Failed,
    ShuttingDown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceStatus {
    pub state: ServiceState,
    pub queue_length: usize,
    pub last_event_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InputContentSummary {
    pub content_preview: String,
    pub content_bytes: usize,
    pub content_truncated: bool,
    pub content_kind: &'static str,
}

pub const DEFAULT_MAX_QUEUE_MESSAGES: usize = 32;
pub const DEFAULT_MAX_QUEUE_BYTES: usize = 32 * 1024 * 1024;
const SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const SERVICE_SHUTDOWN_TASK_DRAIN_POLL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServiceLimits {
    pub max_queue_messages: usize,
    pub max_queue_bytes: usize,
}

impl ServiceLimits {
    pub fn new(max_queue_messages: usize) -> Self {
        assert!(
            max_queue_messages > 0,
            "max_queue_messages must be greater than 0"
        );
        Self {
            max_queue_messages,
            max_queue_bytes: DEFAULT_MAX_QUEUE_BYTES,
        }
    }

    pub fn with_max_queue_bytes(mut self, max_queue_bytes: usize) -> Self {
        assert!(
            max_queue_bytes > 0,
            "max_queue_bytes must be greater than 0"
        );
        self.max_queue_bytes = max_queue_bytes;
        self
    }
}

impl Default for ServiceLimits {
    fn default() -> Self {
        Self {
            max_queue_messages: DEFAULT_MAX_QUEUE_MESSAGES,
            max_queue_bytes: DEFAULT_MAX_QUEUE_BYTES,
        }
    }
}

#[derive(Clone, Default)]
pub struct ServiceSubagentOptions {
    enabled: bool,
    limits: SubagentLimits,
}

impl ServiceSubagentOptions {
    pub fn disabled() -> Self {
        Self::default()
    }

    pub fn enabled(limits: SubagentLimits) -> Self {
        Self {
            enabled: true,
            limits,
        }
    }

    fn enabled_flag(&self) -> bool {
        self.enabled
    }

    fn limits(&self) -> SubagentLimits {
        self.limits
    }
}

struct ServiceInit {
    config: AgentConfig,
    provider: Arc<dyn Provider>,
    tools: Vec<Arc<dyn Tool>>,
    initial_context: Vec<Message>,
    pending_messages: Vec<DrainedMessage>,
    known_user_messages: Vec<DrainedMessage>,
    message_cursors: Vec<DurableMessageCursor>,
    pending_delivery_intents: Vec<CallbackDeliveryIntent>,
    restart_boundary: Option<SessionRestartBoundary>,
    recorder: Option<Arc<dyn AgentContextRecorder>>,
    session_recorder: Option<Arc<FileSessionRecorder>>,
    warnings: Vec<String>,
    limits: ServiceLimits,
    file_store: Option<FileStore>,
    registry_store: Option<RegistryStore>,
    subagent_options: ServiceSubagentOptions,
    runtime_selection: Option<RuntimeSelectionHandle>,
    timeline_retention_days: u64,
    #[cfg(test)]
    timeline_init_write_failure: Option<(TimelineInitAppendPoint, TimelineWriteFailure)>,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimelineInitAppendPoint {
    ServiceStarted,
    ServiceWarning,
}

impl ServiceInit {
    fn new(config: AgentConfig, provider: Arc<dyn Provider>, tools: Vec<Arc<dyn Tool>>) -> Self {
        Self {
            config,
            provider,
            tools,
            initial_context: Vec::new(),
            pending_messages: Vec::new(),
            known_user_messages: Vec::new(),
            message_cursors: Vec::new(),
            pending_delivery_intents: Vec::new(),
            restart_boundary: None,
            recorder: None,
            session_recorder: None,
            warnings: Vec::new(),
            limits: ServiceLimits::default(),
            file_store: None,
            registry_store: None,
            subagent_options: ServiceSubagentOptions::default(),
            runtime_selection: None,
            timeline_retention_days: DEFAULT_TIMELINE_RETENTION_DAYS,
            #[cfg(test)]
            timeline_init_write_failure: None,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ServiceError {
    #[error("message content must not be empty")]
    EmptyMessage,
    #[error("message id {message_id} was already used with different content")]
    MessageConflict { message_id: String },
    #[error("message queue is full")]
    QueueFull,
    #[error("service is shutting down")]
    ShuttingDown,
    #[error("service configuration invalid: {message}")]
    Configuration { message: String },
    #[error("failed to persist accepted message: {message}")]
    Persistence { message: String },
}

#[derive(Debug)]
struct FailedTransitionIntent {
    message: String,
    clear_active_turn: bool,
}

impl FailedTransitionIntent {
    fn timeline(error: TimelineStoreError) -> Self {
        Self {
            message: format!("timeline persistence failed: {error}"),
            clear_active_turn: false,
        }
    }

    fn start_pending(error: TimelineStoreError) -> Self {
        Self {
            message: format!("timeline persistence failed: {error}"),
            clear_active_turn: true,
        }
    }

    fn service_error(&self) -> ServiceError {
        ServiceError::Persistence {
            message: self.message.clone(),
        }
    }

    fn transition(self, inner: &ServiceInner) {
        let Self {
            message,
            clear_active_turn: should_clear_active_turn,
        } = self;
        inner.transition_to_failed(message, |state| {
            if should_clear_active_turn {
                state.active_cancel = None;
                clear_active_turn(state);
            }
        });
    }
}

#[derive(Clone)]
pub struct Service {
    inner: Arc<ServiceInner>,
}

struct ServiceInner {
    self_weak: Weak<ServiceInner>,
    config: AgentConfig,
    provider: Arc<dyn Provider>,
    base_tools: Vec<Arc<dyn Tool>>,
    #[cfg(test)]
    tools: Vec<Arc<dyn Tool>>,
    tool_snapshot: Option<Arc<FinalToolSnapshot>>,
    configuration_error: Mutex<Option<String>>,
    file_store: Option<FileStore>,
    registry_store: Option<RegistryStore>,
    registry_maintenance_cancel: CancellationToken,
    registry_maintenance_join: Mutex<Option<RegistryMaintenanceHandle>>,
    provider_summaries: Mutex<Vec<ProviderMetadata>>,
    runtime_selection: Option<RuntimeSelectionHandle>,
    recorder: Option<Arc<dyn AgentContextRecorder>>,
    session_recorder: Option<Arc<FileSessionRecorder>>,
    pending_delivery_intents: Mutex<VecDeque<CallbackDeliveryIntent>>,
    service_projection_notify: Arc<Notify>,
    service_projection_runner: AsyncMutex<()>,
    service_projection_worker_started: AtomicBool,
    service_status_generation: AtomicU64,
    published_service_status_generation: AtomicU64,
    dirty_service_status_generation: AtomicU64,
    event_commit_gate: Mutex<()>,
    commit_gate: AsyncMutex<()>,
    compact: CompactCoordinator,
    background_tasks: Arc<BackgroundTaskManager>,
    subagent_options: ServiceSubagentOptions,
    subagents: Mutex<SubagentManager>,
    subagent_lifecycle: Mutex<()>,
    subagent_contexts: Mutex<HashMap<String, Vec<Message>>>,
    subagent_cancels: Mutex<HashMap<String, Arc<CancellationToken>>>,
    subagent_providers: Mutex<HashMap<String, Arc<dyn Provider>>>,
    subagent_runtime_selections: Mutex<HashMap<String, RuntimeSelectionHandle>>,
    subagent_tool_snapshots: Mutex<HashMap<String, Arc<FinalToolSnapshot>>>,
    subagent_callback_epoch: String,
    next_subagent_callback_seq: AtomicU64,
    task_presets: Mutex<RuntimeTaskPresetsConfig>,
    task_preset_bash_tool: Mutex<Option<BashTool>>,
    #[cfg(test)]
    subagent_test_hooks: SubagentTestHooks,
    limits: ServiceLimits,
    timeline_store: Arc<Mutex<TimelineStore>>,
    next_service_event_write_failure: Mutex<Option<(usize, TimelineWriteFailure)>>,
    next_agent_event_write_failure: Mutex<Option<(usize, TimelineWriteFailure)>>,
    #[cfg(test)]
    event_commit_test_hook: EventCommitTestHook,
    #[cfg(test)]
    bootstrap_state_snapshot_test_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    bootstrap_task_snapshot_test_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    status_state_snapshot_test_hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    event_log: Arc<Mutex<EventLog>>,
    event_notify: Arc<Notify>,
    public_replay: Mutex<PublicReplayProjectionBuffer>,
    intake_gate: AsyncMutex<()>,
    task_frame_admission_gate: Mutex<TaskFrameAdmissionGate>,
    task_frame_lanes: Mutex<HashMap<String, task_bridge::TaskFrameLane>>,
    stdio_diagnostics: Mutex<InternalStdioDiagnostics>,
    state: Mutex<ServiceInnerState>,
    notify: Notify,
    profiler: Mutex<Option<SharedProfiler>>,
    llm_text_preview_enabled: AtomicBool,
    llm_text_preview_hub: LlmTextPreviewHub,
    task_observer: TaskConversationObserver,
    task_observer_preview_loop_started: Arc<AtomicBool>,
    task_observer_preview_cancel: CancellationToken,
    task_observer_preview_join: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

#[cfg(test)]
#[derive(Default)]
struct EventCommitTestHook {
    state: Mutex<EventCommitTestHookState>,
    changed: std::sync::Condvar,
}

#[cfg(test)]
#[derive(Default)]
struct EventCommitTestHookState {
    event_type: Option<String>,
    entered: bool,
    released: bool,
    expected_gate_actor: Option<EventCommitGateActor>,
    gate_attempted: bool,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EventCommitGateActor {
    Regular,
    Callback,
    Bootstrap,
}

#[cfg(test)]
impl EventCommitTestHook {
    fn pause_after_durable(&self, event_type: &str) {
        let mut state = self.state.lock().expect("event commit test hook poisoned");
        *state = EventCommitTestHookState {
            event_type: Some(event_type.to_owned()),
            entered: false,
            released: false,
            expected_gate_actor: None,
            gate_attempted: false,
        };
    }

    fn expect_gate_attempt(&self, actor: EventCommitGateActor) {
        let mut state = self.state.lock().expect("event commit test hook poisoned");
        state.expected_gate_actor = Some(actor);
        state.gate_attempted = false;
    }

    fn gate_attempt(&self, actor: EventCommitGateActor) {
        let mut state = self.state.lock().expect("event commit test hook poisoned");
        if state.expected_gate_actor == Some(actor) {
            state.gate_attempted = true;
            self.changed.notify_all();
        }
    }

    fn wait_until_gate_attempt(&self, actor: EventCommitGateActor) {
        let state = self.state.lock().expect("event commit test hook poisoned");
        let (state, timeout) = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(5), |state| {
                state.expected_gate_actor != Some(actor) || !state.gate_attempted
            })
            .expect("event commit test hook poisoned while waiting for gate attempt");
        assert!(
            state.expected_gate_actor == Some(actor) && state.gate_attempted,
            "timed out waiting for {actor:?} to attempt event commit gate: {}",
            timeout.timed_out()
        );
    }

    fn after_durable(&self, event_type: &str) {
        let mut state = self.state.lock().expect("event commit test hook poisoned");
        if state.event_type.as_deref() != Some(event_type) {
            return;
        }
        state.event_type = None;
        state.entered = true;
        self.changed.notify_all();
        let (state, timeout) = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(5), |state| !state.released)
            .expect("event commit test hook poisoned while waiting");
        assert!(
            state.released,
            "timed out waiting to release paused event commit: {}",
            timeout.timed_out()
        );
    }

    fn wait_until_paused(&self) {
        let state = self.state.lock().expect("event commit test hook poisoned");
        let (state, timeout) = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(5), |state| !state.entered)
            .expect("event commit test hook poisoned while waiting");
        assert!(
            state.entered,
            "timed out waiting for event commit to pause: {}",
            timeout.timed_out()
        );
    }

    fn release(&self) {
        let mut state = self.state.lock().expect("event commit test hook poisoned");
        state.released = true;
        self.changed.notify_all();
    }
}

struct ServiceContextRecorder {
    inner: Arc<ServiceInner>,
}

#[async_trait]
impl AgentContextRecorder for ServiceContextRecorder {
    async fn record_message(&self, message: &Message) -> Result<(), AgentCommitError> {
        if let Some(recorder) = self.inner.recorder.as_deref() {
            recorder.record_message(message).await?;
            self.inner.note_durable_transcript_boundary();
        }
        self.inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .context
            .push(message.clone());
        Ok(())
    }

    async fn record_accepted_input(
        &self,
        entry: &AcceptedInputEntry,
    ) -> Result<(), AgentCommitError> {
        let Some(recorder) = self.inner.recorder.as_deref() else {
            return Ok(());
        };
        recorder.record_accepted_input(entry).await
    }

    async fn record_pending_input_removed(
        &self,
        message_id: &str,
        source: InputSource,
        metadata: Option<&QueuedInputMetadata>,
        reason: &str,
    ) -> Result<(), AgentCommitError> {
        let Some(recorder) = self.inner.recorder.as_deref() else {
            return Ok(());
        };
        recorder
            .record_pending_input_removed(message_id, source, metadata, reason)
            .await
    }

    async fn record_compaction_with_active_user_message_id_and_metadata(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        active_user_message_id: Option<&str>,
        metadata: Option<&CompactionMetadata>,
    ) -> Result<(), AgentCommitError> {
        if let Some(recorder) = self.inner.recorder.as_deref() {
            recorder
                .record_compaction_with_active_user_message_id_and_metadata(
                    summary,
                    retained_messages,
                    active_user_message_id,
                    metadata,
                )
                .await?;
            self.inner.note_durable_transcript_boundary();
        }
        self.inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .context = std::iter::once(Message::user(summary.to_vec()))
            .chain(retained_messages.iter().cloned())
            .collect();
        Ok(())
    }

    async fn record_user_batch_with_ids(
        &self,
        messages: &[Message],
        message_ids: &[String],
    ) -> Result<(), AgentCommitError> {
        if let Some(recorder) = self.inner.recorder.as_deref() {
            recorder
                .record_user_batch_with_ids(messages, message_ids)
                .await?;
            self.inner.note_durable_transcript_boundary();
        }
        self.inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .context
            .extend_from_slice(messages);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServiceWorkerKind {
    AgentLoop,
    FrameHandler,
    InputPersistence,
    BackgroundCompletion,
    SubagentRun,
    CallbackProjectionRetry,
}

impl ServiceWorkerKind {
    fn can_start_during_terminal_state(self) -> bool {
        matches!(self, Self::BackgroundCompletion)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct ServiceWorkerRegistry {
    agent_loop: usize,
    frame_handler: usize,
    input_persistence: usize,
    background_completion: usize,
    subagent_run: usize,
    callback_projection_retry: usize,
}

impl ServiceWorkerRegistry {
    fn register(&mut self, kind: ServiceWorkerKind) {
        match kind {
            ServiceWorkerKind::AgentLoop => self.agent_loop += 1,
            ServiceWorkerKind::FrameHandler => self.frame_handler += 1,
            ServiceWorkerKind::InputPersistence => self.input_persistence += 1,
            ServiceWorkerKind::BackgroundCompletion => self.background_completion += 1,
            ServiceWorkerKind::SubagentRun => self.subagent_run += 1,
            ServiceWorkerKind::CallbackProjectionRetry => self.callback_projection_retry += 1,
        }
    }

    fn complete(&mut self, kind: ServiceWorkerKind) {
        let count = match kind {
            ServiceWorkerKind::AgentLoop => &mut self.agent_loop,
            ServiceWorkerKind::FrameHandler => &mut self.frame_handler,
            ServiceWorkerKind::InputPersistence => &mut self.input_persistence,
            ServiceWorkerKind::BackgroundCompletion => &mut self.background_completion,
            ServiceWorkerKind::SubagentRun => &mut self.subagent_run,
            ServiceWorkerKind::CallbackProjectionRetry => &mut self.callback_projection_retry,
        };
        *count = count.saturating_sub(1);
    }

    fn active_count(&self) -> usize {
        self.agent_loop
            + self.frame_handler
            + self.input_persistence
            + self.background_completion
            + self.subagent_run
            + self.callback_projection_retry
    }

    #[cfg(test)]
    fn frame_handler_count(&self) -> usize {
        self.frame_handler
    }
}

struct ServiceWorkerGuard {
    inner: Weak<ServiceInner>,
    kind: ServiceWorkerKind,
}

impl Drop for ServiceWorkerGuard {
    fn drop(&mut self) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        {
            let mut state = inner.state.lock().expect("service state mutex poisoned");
            state.service_workers.complete(self.kind);
        }
        inner.notify.notify_waiters();
    }
}

async fn supervise_service_worker<Worker, Terminalizer, TerminalizerFuture>(
    guard: ServiceWorkerGuard,
    worker: Worker,
    terminalize_panic: Terminalizer,
) where
    Worker: Future<Output = ()> + Send + 'static,
    Terminalizer: FnOnce(String) -> TerminalizerFuture + Send + 'static,
    TerminalizerFuture: Future<Output = ()> + Send,
{
    let outcome = tokio::spawn(worker).await;
    if let Err(error) = outcome {
        if error.is_panic() {
            let panic = bounded_chars(&error.to_string(), SERVICE_WORKER_PANIC_MAX_CHARS);
            terminalize_panic(panic).await;
        }
    }
    drop(guard);
}

fn reject_unknown_arguments(call: &ToolCall, allowed: &[&str]) -> Option<ToolResult> {
    let object = call.arguments.as_object()?;
    let allowed = allowed.iter().copied().collect::<HashSet<_>>();
    let unknown = object
        .keys()
        .find(|key| !allowed.contains(key.as_str()))?
        .clone();
    Some(ToolResult::error(
        call.id.clone(),
        call.name.clone(),
        format!("unknown argument: {unknown}"),
        json!({"kind": "invalid_tool_arguments", "field": unknown}),
    ))
}

fn service_unavailable_tool_result(call: ToolCall) -> ToolResult {
    ToolResult::error(
        call.id,
        call.name,
        "service is not available",
        json!({"kind": "service_unavailable"}),
    )
}

struct ServiceInnerState {
    state: ServiceState,
    context: Vec<Message>,
    input_queue: InputQueueState,
    known_user_messages: Vec<DrainedMessage>,
    service_workers: ServiceWorkerRegistry,
    message_index: HashMap<String, MessageIndexEntry>,
    durable_message_replays: HashMap<String, DurableMessageReplay>,
    restart_boundary: Option<SessionRestartBoundary>,
    next_turn_number: u64,
    active_turn_id: Option<String>,
    active_cancel: Option<CancellationToken>,
    last_error: Option<String>,
    context_maintenance: ContextMaintenanceStatus,
    pending_recovery_record: Option<PendingRecoveryRecord>,
    durable_transcript_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QueuedMessage {
    id: String,
    content: Vec<ContentPart>,
    source: InputSource,
    urgency: InputUrgency,
    metadata: Option<QueuedInputMetadata>,
    cursor_seq: u64,
    delivery: Option<MessageDelivery>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingBatch {
    id: String,
    messages: Vec<QueuedMessage>,
}

#[derive(Debug, Clone)]
struct InputQueueCommitPlan {
    batch_id: String,
    messages: Vec<QueuedMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InputQueueCommitResult {
    queue_length: usize,
    callback_delivery_input_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallbackDeliveryTarget {
    Task,
    Subagent,
}

#[derive(Debug, Clone)]
struct PreparedCallbackDeliveryEvent {
    input_id: String,
    target: CallbackDeliveryTarget,
    data: Value,
}

impl PreparedCallbackDeliveryEvent {
    fn delivery_intent(&self) -> CallbackDeliveryIntent {
        let projection_id = CallbackDeliveryIntent::projection_id_for_input(&self.input_id);
        let mut data = self.data.clone();
        data["projection_id"] = json!(projection_id);
        CallbackDeliveryIntent {
            projection_id,
            event_type: match self.target {
                CallbackDeliveryTarget::Task => CallbackDeliveryEventType::TaskDelivered,
                CallbackDeliveryTarget::Subagent => CallbackDeliveryEventType::SubagentDelivered,
            },
            data,
        }
    }
}

const CALLBACK_DELIVERY_RETRY_MIN_BACKOFF: Duration = Duration::from_millis(25);
const CALLBACK_DELIVERY_RETRY_MAX_BACKOFF: Duration = Duration::from_millis(400);

#[derive(Debug, Clone)]
struct InputQueueState {
    queue: VecDeque<QueuedMessage>,
    pending_batch: Option<PendingBatch>,
    next_batch_id: u64,
}

impl InputQueueState {
    fn new(queue: VecDeque<QueuedMessage>) -> Self {
        Self {
            queue,
            pending_batch: None,
            next_batch_id: 1,
        }
    }

    fn len(&self) -> usize {
        self.queue.len()
    }

    fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    fn iter(&self) -> impl Iterator<Item = &QueuedMessage> {
        self.queue.iter()
    }

    fn protected_message_ids(&self) -> HashSet<String> {
        let mut ids = self
            .queue
            .iter()
            .map(|message| message.id.clone())
            .collect::<HashSet<_>>();
        if let Some(batch) = &self.pending_batch {
            ids.extend(batch.messages.iter().map(|message| message.id.clone()));
        }
        ids
    }

    fn has_pending_batch(&self) -> bool {
        self.pending_batch.is_some()
    }

    fn clear_pending_batch(&mut self) {
        self.pending_batch = None;
    }

    fn enqueue(&mut self, message: QueuedMessage) {
        self.queue.push_back(message);
    }

    fn remove_message(&mut self, message_id: &str) -> bool {
        let mut removed = false;
        let before = self.queue.len();
        self.queue.retain(|message| message.id != message_id);
        removed |= self.queue.len() != before;
        if let Some(batch) = self.pending_batch.as_mut() {
            let before = batch.messages.len();
            batch.messages.retain(|message| message.id != message_id);
            removed |= batch.messages.len() != before;
            if batch.messages.is_empty() {
                self.pending_batch = None;
            }
        }
        removed
    }

    fn begin_drain(&mut self) -> DrainBatch {
        if let Some(batch) = self.pending_batch.as_ref() {
            let messages = batch
                .messages
                .iter()
                .map(drained_message_from_queue)
                .collect::<Vec<_>>();
            return DrainBatch::new(batch.id.clone(), messages);
        }
        if self.queue.is_empty() {
            return DrainBatch::new("batch_empty", Vec::new());
        }

        let id = format!("batch_{}", self.next_batch_id);
        self.next_batch_id += 1;
        let batch_messages = self.selected_batch_messages();
        let messages = batch_messages
            .iter()
            .map(drained_message_from_queue)
            .collect::<Vec<_>>();
        self.pending_batch = Some(PendingBatch {
            id: id.clone(),
            messages: batch_messages,
        });
        DrainBatch::new(id, messages)
    }

    fn prepare_commit(&self, batch_id: &str) -> Result<InputQueueCommitPlan, AgentCommitError> {
        let Some(batch) = self.pending_batch.as_ref() else {
            return Err(AgentCommitError::new(format!(
                "no pending input batch for commit {batch_id}"
            )));
        };
        if batch.id != batch_id {
            return Err(AgentCommitError::new(format!(
                "pending input batch mismatch: expected {}, got {batch_id}",
                batch.id
            )));
        }
        if !self.contains_selected_messages(&batch.messages) {
            return Err(AgentCommitError::new(format!(
                "pending input batch {batch_id} no longer matches the queue"
            )));
        }
        Ok(InputQueueCommitPlan {
            batch_id: batch.id.clone(),
            messages: batch.messages.clone(),
        })
    }

    fn finish_commit(
        &mut self,
        plan: &InputQueueCommitPlan,
    ) -> Result<InputQueueCommitResult, AgentCommitError> {
        let result = self.commit_result(plan)?;

        self.pending_batch = None;
        for selected in &plan.messages {
            let Some(index) = self.queue.iter().position(|queued| queued == selected) else {
                return Err(AgentCommitError::new(format!(
                    "pending input batch {} changed during commit",
                    plan.batch_id
                )));
            };
            self.queue.remove(index);
        }

        Ok(result)
    }

    fn commit_result(
        &self,
        plan: &InputQueueCommitPlan,
    ) -> Result<InputQueueCommitResult, AgentCommitError> {
        let Some(batch) = self.pending_batch.as_ref() else {
            return Err(AgentCommitError::new(format!(
                "pending input batch {} was cleared during commit",
                plan.batch_id
            )));
        };
        if batch.id != plan.batch_id {
            return Err(AgentCommitError::new(format!(
                "pending input batch changed during commit: expected {}, got {}",
                batch.id, plan.batch_id
            )));
        }
        if batch.messages != plan.messages || !self.contains_selected_messages(&plan.messages) {
            return Err(AgentCommitError::new(format!(
                "pending input batch {} changed during commit",
                plan.batch_id
            )));
        }

        let callback_delivery_input_ids = plan
            .messages
            .iter()
            .filter(|queued| {
                matches!(
                    queued.source,
                    InputSource::TaskCallback | InputSource::SubagentCallback
                )
            })
            .map(|queued| queued.id.clone())
            .collect::<Vec<_>>();

        Ok(InputQueueCommitResult {
            queue_length: self.queue.len().saturating_sub(plan.messages.len()),
            callback_delivery_input_ids,
        })
    }

    fn rollback(&mut self, batch_id: &str) {
        if self
            .pending_batch
            .as_ref()
            .is_some_and(|batch| batch.id == batch_id)
        {
            self.pending_batch = None;
        }
    }

    fn selected_batch_messages(&self) -> Vec<QueuedMessage> {
        self.queue
            .iter()
            .filter(|message| message.urgency == InputUrgency::Urgent)
            .chain(
                self.queue
                    .iter()
                    .filter(|message| message.urgency == InputUrgency::Normal),
            )
            .cloned()
            .collect()
    }

    fn contains_selected_messages(&self, batch: &[QueuedMessage]) -> bool {
        batch
            .iter()
            .all(|selected| self.queue.iter().any(|queued| queued == selected))
    }

    fn estimated_bytes(&self) -> usize {
        self.queue.iter().fold(0usize, |total, queued| {
            total.saturating_add(queue_content_parts_estimated_bytes(&queued.content))
        })
    }

    fn bytes_with_new_message_exceeds_limit(
        &self,
        content: &[ContentPart],
        max_queue_bytes: usize,
    ) -> bool {
        let incoming = queue_content_parts_estimated_bytes(content);
        match self.estimated_bytes().checked_add(incoming) {
            Some(total) => total > max_queue_bytes,
            None => true,
        }
    }

    fn task_request_candidates(&self) -> Vec<QueuedTaskRequestCandidate> {
        self.queue
            .iter()
            .filter_map(|queued| {
                if queued.source != InputSource::TaskRequest {
                    return None;
                }
                let Some(QueuedInputMetadata::TaskRequest {
                    task_id,
                    request_id,
                }) = queued.metadata.as_ref()
                else {
                    return None;
                };
                Some(QueuedTaskRequestCandidate {
                    message_id: queued.id.clone(),
                    task_id: task_id.clone(),
                    request_id: request_id.clone(),
                    source: queued.source,
                    metadata: queued
                        .metadata
                        .clone()
                        .expect("matched queued task request metadata should exist"),
                })
            })
            .collect()
    }

    fn has_task_request_for_task(&self, task_id: &str) -> bool {
        self.queue.iter().any(|queued| {
            queued.source == InputSource::TaskRequest
                && matches!(
                    queued.metadata.as_ref(),
                    Some(QueuedInputMetadata::TaskRequest {
                        task_id: queued_task_id,
                        ..
                    }) if queued_task_id == task_id
                )
        })
    }

    fn remove_stale_task_request(&mut self, request: &StaleTaskRequest) -> bool {
        let Some(index) = self.queue.iter().position(|queued| {
            queued.id == request.candidate.message_id
                && queued.source == request.candidate.source
                && queued.metadata.as_ref() == Some(&request.candidate.metadata)
        }) else {
            return false;
        };
        self.queue.remove(index);
        true
    }
}

#[derive(Debug, Clone)]
struct QueuedTaskRequestCandidate {
    message_id: String,
    task_id: String,
    request_id: String,
    source: InputSource,
    metadata: QueuedInputMetadata,
}

#[derive(Debug, Clone)]
struct StaleTaskRequest {
    candidate: QueuedTaskRequestCandidate,
    state: Option<TaskRequestState>,
    reason: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StaleTaskRequestDrain {
    Complete { retry_callbacks: bool },
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MessageIndexEntry {
    content: Vec<ContentPart>,
    cursor: EventCursor,
    projection_state: MessageProjectionState,
    delivery: Option<MessageDelivery>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MessageProjectionState {
    Live,
    MissingProjection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableMessageReplay {
    replay_start_seq: u64,
    terminal_seq: u64,
    events: Vec<ThreadEvent>,
}

static NEXT_DEFAULT_TIMELINE_DIR: AtomicU64 = AtomicU64::new(1);

fn default_timeline_data_dir() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let ordinal = NEXT_DEFAULT_TIMELINE_DIR.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "botified-timeline-{}-{stamp}-{ordinal}",
        std::process::id()
    ))
}

fn inferred_timeline_data_dir(config: &AgentConfig) -> PathBuf {
    if config.task_output.data_dir.is_absolute() {
        return config.task_output.data_dir.clone();
    }
    default_timeline_data_dir()
}

#[async_trait]
impl AgentInputDrainer for Service {
    async fn begin_drain(&self, cancel: CancellationToken) -> DrainBatch {
        self.inner.begin_drain(cancel).await
    }

    async fn commit(&self, batch_id: &str) -> Result<DrainCommit, AgentCommitError> {
        self.inner.commit(batch_id).await
    }

    async fn complete_commit(
        &self,
        batch_id: &str,
        commit: &DrainCommit,
        cycle_id: Option<&str>,
    ) -> Result<(), AgentCommitError> {
        self.inner.complete_commit(batch_id, commit, cycle_id).await
    }

    async fn rollback(&self, batch_id: &str) {
        self.inner.rollback(batch_id).await;
    }
}

#[async_trait]
impl AgentInputDrainer for ServiceInner {
    async fn begin_drain(&self, _cancel: CancellationToken) -> DrainBatch {
        let intake = self.intake_gate.lock().await;
        let retry_callbacks = match self.skip_stale_task_requests_before_drain().await {
            StaleTaskRequestDrain::Complete { retry_callbacks } => retry_callbacks,
            StaleTaskRequestDrain::Blocked => {
                return DrainBatch::new("batch_stale_task_request_tombstone_failed", Vec::new());
            }
        };
        drop(intake);
        if retry_callbacks {
            retry_pending_task_callbacks_for_inner(self).await;
        }
        let _intake = self.intake_gate.lock().await;

        let mut state = self.state.lock().expect("service state mutex poisoned");
        if state.state == ServiceState::Failed {
            return DrainBatch::new("batch_failed", Vec::new());
        }
        if state.state == ServiceState::ShuttingDown {
            return DrainBatch::new("batch_shutdown", Vec::new());
        }
        state.input_queue.begin_drain()
    }

    async fn commit(&self, batch_id: &str) -> Result<DrainCommit, AgentCommitError> {
        let _intake = self.intake_gate.lock().await;
        let plan = {
            let state = self.state.lock().expect("service state mutex poisoned");
            state.input_queue.prepare_commit(batch_id)?
        };

        let result = {
            let state = self.state.lock().expect("service state mutex poisoned");
            state.input_queue.commit_result(&plan)?
        };

        Ok(DrainCommit::new(result.queue_length)
            .with_callback_delivery_input_ids(result.callback_delivery_input_ids))
    }

    async fn complete_commit(
        &self,
        batch_id: &str,
        commit: &DrainCommit,
        cycle_id: Option<&str>,
    ) -> Result<(), AgentCommitError> {
        let _commit_guard = self.commit_gate.lock().await;
        let (plan, result, turn_id) = {
            let _intake = self.intake_gate.lock().await;
            let state = self.state.lock().expect("service state mutex poisoned");
            let plan = state.input_queue.prepare_commit(batch_id)?;
            let result = state.input_queue.commit_result(&plan)?;
            (plan, result, state.active_turn_id.clone())
        };

        let user_messages = plan
            .messages
            .iter()
            .map(|queued| Message::user(queued.content.clone()))
            .collect::<Vec<_>>();
        let callback_delivery_events = self.prepare_callback_delivery_events(&plan, cycle_id);
        let delivery_intents = callback_delivery_events
            .iter()
            .map(PreparedCallbackDeliveryEvent::delivery_intent)
            .collect::<Vec<_>>();

        self.ensure_pending_recovery_safe_before_user_batch()
            .await?;
        if let Some(recorder) = self.session_recorder.as_deref() {
            let message_ids = plan
                .messages
                .iter()
                .map(|queued| queued.id.clone())
                .collect::<Vec<_>>();
            recorder
                .record_user_batch_with_ids_and_delivery_intents_sync(
                    &user_messages,
                    &message_ids,
                    &delivery_intents,
                )
                .map_err(|error| AgentCommitError::new(error.to_string()))?;
        } else {
            record_committed_user_batch(self.recorder.as_deref(), &plan).await?;
        }
        self.note_durable_transcript_boundary();

        {
            let _intake = self.intake_gate.lock().await;
            let mut state = self.state.lock().expect("service state mutex poisoned");
            let finished = state.input_queue.finish_commit(&plan)?;
            if state.active_cancel.is_some() && state.active_turn_id.is_some() {
                state.context.extend(user_messages);
            }
            debug_assert!(result.queue_length >= commit.queue_length);
            debug_assert!(finished.queue_length >= result.queue_length);
        }

        for event in &callback_delivery_events {
            match event.target {
                CallbackDeliveryTarget::Task => {
                    let _ = self
                        .background_tasks
                        .set_callback_delivered_by_input_id(&event.input_id);
                }
                CallbackDeliveryTarget::Subagent => {
                    let _ = self
                        .subagents
                        .lock()
                        .expect("subagent manager mutex poisoned")
                        .mark_callback_delivered(&event.input_id);
                }
            }
        }

        self.track_callback_delivery_intents(&delivery_intents);
        self.try_project_pending_service_projections().await;
        if !self
            .pending_delivery_intents
            .lock()
            .expect("pending delivery intents mutex poisoned")
            .is_empty()
        {
            self.service_projection_notify.notify_one();
        }

        self.append_post_commit_service_status(turn_id.as_deref());

        self.notify.notify_waiters();
        drop(_commit_guard);
        retry_pending_task_callbacks_for_inner(self).await;
        Ok(())
    }

    async fn rollback(&self, batch_id: &str) {
        let _commit_guard = self.commit_gate.lock().await;
        let _intake = self.intake_gate.lock().await;
        let mut state = self.state.lock().expect("service state mutex poisoned");
        state.input_queue.rollback(batch_id);
        self.notify.notify_waiters();
    }
}

async fn record_committed_user_batch(
    recorder: Option<&dyn AgentContextRecorder>,
    plan: &InputQueueCommitPlan,
) -> Result<(), AgentCommitError> {
    let Some(recorder) = recorder else {
        return Ok(());
    };
    let user_messages = plan
        .messages
        .iter()
        .map(|queued| Message::user(queued.content.clone()))
        .collect::<Vec<_>>();
    let message_ids = plan
        .messages
        .iter()
        .map(|queued| queued.id.clone())
        .collect::<Vec<_>>();
    recorder
        .record_user_batch_with_ids(&user_messages, &message_ids)
        .await
}

fn drained_message_from_queue(queued: &QueuedMessage) -> DrainedMessage {
    let mut message = DrainedMessage::new(queued.id.clone(), queued.content.clone())
        .with_source(queued.source)
        .with_urgency(queued.urgency)
        .with_cursor_seq(queued.cursor_seq);
    message.metadata = queued.metadata.clone();
    message.delivery = queued.delivery.clone();
    message
}

fn remember_known_user_message(state: &mut ServiceInnerState, message: DrainedMessage) {
    if let Some(position) = state
        .known_user_messages
        .iter()
        .position(|known| known.id == message.id)
    {
        state.known_user_messages.remove(position);
    }
    state.known_user_messages.push(message);
    prune_known_user_messages_to_retained_window(state);
}

fn prune_known_user_messages_to_retained_window(state: &mut ServiceInnerState) {
    let mut protected_ids = state.input_queue.protected_message_ids();
    if let Some(boundary) = state.restart_boundary.as_ref() {
        protected_ids.extend(boundary.active_input_ids().iter().cloned());
    }
    let max_entries = DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW.saturating_add(protected_ids.len());
    let remove_count = state.known_user_messages.len().saturating_sub(max_entries);
    if remove_count == 0 {
        return;
    }

    let mut removable = state
        .known_user_messages
        .iter()
        .filter(|message| !protected_ids.contains(&message.id))
        .map(|message| message.id.clone())
        .take(remove_count)
        .collect::<HashSet<_>>();
    state
        .known_user_messages
        .retain(|message| !removable.remove(&message.id));
}

fn content_parts_estimated_bytes(content: &[ContentPart]) -> usize {
    content.iter().fold(0usize, |total, part| {
        total.saturating_add(content_part_estimated_bytes(part))
    })
}

fn queue_content_parts_estimated_bytes(content: &[ContentPart]) -> usize {
    content.iter().fold(0usize, |total, part| {
        total.saturating_add(queue_content_part_estimated_bytes(part))
    })
}

fn queue_content_part_estimated_bytes(part: &ContentPart) -> usize {
    match part {
        ContentPart::File { binding } => render_file_manifest(binding).len(),
        other => content_part_estimated_bytes(other),
    }
}

fn content_part_estimated_bytes(part: &ContentPart) -> usize {
    match part {
        ContentPart::Text { text } => text.len(),
        ContentPart::ImageUrl { url } => url.len(),
        ContentPart::ImageBase64 { data, .. } => data.len(),
        ContentPart::File { binding } => usize::try_from(binding.size_bytes).unwrap_or(usize::MAX),
        ContentPart::Skill {
            name,
            path,
            arguments,
        } => [name.as_deref(), path.as_deref(), arguments.as_deref()]
            .into_iter()
            .flatten()
            .map(str::len)
            .sum(),
    }
}

pub(crate) fn summarize_input_content(content: &[ContentPart]) -> InputContentSummary {
    const MAX_PREVIEW_CHARS: usize = 256;

    let content_bytes = content_parts_estimated_bytes(content);
    let mut preview = String::new();
    let mut has_text = false;
    let mut has_image = false;
    let mut has_file = false;
    let mut has_skill = false;

    for part in content {
        if !preview.is_empty() {
            preview.push('\n');
        }
        match part {
            ContentPart::Text { text } => {
                has_text = true;
                preview.push_str(text);
            }
            ContentPart::ImageUrl { .. } => {
                has_image = true;
                preview.push_str("[image_url]");
            }
            ContentPart::ImageBase64 { mime_type, .. } => {
                has_image = true;
                preview.push_str("[image_base64:");
                preview.push_str(mime_type);
                preview.push(']');
            }
            ContentPart::File { binding } => {
                has_file = true;
                preview.push_str("[file ");
                preview.push_str(&binding.filename);
                preview.push(' ');
                preview.push_str(&binding.mime_type);
                preview.push(' ');
                preview.push_str(&binding.size_bytes.to_string());
                preview.push_str(" bytes]");
            }
            ContentPart::Skill {
                name,
                path,
                arguments,
            } => {
                has_skill = true;
                preview.push_str("[skill");
                if let Some(name) = name {
                    preview.push(' ');
                    preview.push_str(name);
                } else if let Some(path) = path {
                    preview.push(' ');
                    preview.push_str(path);
                }
                if arguments.is_some() {
                    preview.push_str(" args]");
                } else {
                    preview.push(']');
                }
            }
        }
    }

    let original_chars = preview.chars().count();
    let content_truncated = original_chars > MAX_PREVIEW_CHARS;
    if content_truncated {
        preview = preview.chars().take(MAX_PREVIEW_CHARS).collect();
    }

    let kinds = [has_text, has_image, has_file, has_skill]
        .into_iter()
        .filter(|present| *present)
        .count();
    let content_kind = match (kinds, has_text, has_image, has_file, has_skill) {
        (1, true, false, false, false) => "text",
        (1, false, true, false, false) => "image",
        (1, false, false, true, false) => "file",
        (1, false, false, false, true) => "skill",
        _ => "mixed",
    };

    InputContentSummary {
        content_preview: preview,
        content_bytes,
        content_truncated,
        content_kind,
    }
}

fn text_only_input_content(content: &[ContentPart]) -> Option<&str> {
    match content {
        [ContentPart::Text { text }] => Some(text.as_str()),
        _ => None,
    }
}

fn input_kind_name(source: InputSource) -> &'static str {
    match source {
        InputSource::User => "user_message",
        InputSource::TaskCallback => "task_callback",
        InputSource::SubagentCallback => "subagent_callback",
        InputSource::TaskRequest => "task_ask",
        InputSource::TaskTell => "task_tell",
    }
}

fn service_state_name(state: ServiceState) -> &'static str {
    match state {
        ServiceState::Idle => "idle",
        ServiceState::Running => "running",
        ServiceState::Aborting => "aborting",
        ServiceState::Failed => "failed",
        ServiceState::ShuttingDown => "shutting_down",
    }
}

impl ServiceInner {
    fn ensure_registry_maintenance(self: &Arc<Self>) {
        let Some(store) = self.registry_store.as_ref() else {
            return;
        };
        if let Some(handle) = store.start_maintenance(self.registry_maintenance_cancel.clone()) {
            let mut maintenance = self
                .registry_maintenance_join
                .lock()
                .expect("registry maintenance join mutex poisoned");
            debug_assert!(maintenance.is_none());
            *maintenance = Some(handle);
        }
    }

    fn profiler(&self) -> Option<SharedProfiler> {
        self.profiler
            .lock()
            .expect("service profiler mutex poisoned")
            .clone()
    }

    fn register_service_worker(
        self: &Arc<Self>,
        kind: ServiceWorkerKind,
    ) -> Option<ServiceWorkerGuard> {
        let mut state = self.state.lock().expect("service state mutex poisoned");
        if matches!(
            state.state,
            ServiceState::Failed | ServiceState::ShuttingDown
        ) && !kind.can_start_during_terminal_state()
        {
            return None;
        }
        state.service_workers.register(kind);
        Some(ServiceWorkerGuard {
            inner: Arc::downgrade(self),
            kind,
        })
    }

    fn register_agent_loop_worker(self: &Arc<Self>) -> Option<(ServiceWorkerGuard, String)> {
        let mut state = self.state.lock().expect("service state mutex poisoned");
        if matches!(
            state.state,
            ServiceState::Failed | ServiceState::ShuttingDown
        ) {
            return None;
        }
        let turn_id = state.active_turn_id.clone()?;
        state.service_workers.register(ServiceWorkerKind::AgentLoop);
        Some((
            ServiceWorkerGuard {
                inner: Arc::downgrade(self),
                kind: ServiceWorkerKind::AgentLoop,
            },
            turn_id,
        ))
    }

    fn active_service_worker_count(&self) -> usize {
        self.state
            .lock()
            .expect("service state mutex poisoned")
            .service_workers
            .active_count()
    }

    fn shutdown_quiescent(&self) -> bool {
        self.background_tasks.running_or_cancelling_count() == 0
            && self.active_service_worker_count() == 0
    }

    async fn skip_stale_task_requests_before_drain(&self) -> StaleTaskRequestDrain {
        let stale = self
            .queued_task_request_candidates()
            .into_iter()
            .filter_map(|candidate| self.stale_task_request(candidate))
            .collect::<Vec<_>>();
        if stale.is_empty() {
            return StaleTaskRequestDrain::Complete {
                retry_callbacks: false,
            };
        }

        for request in stale {
            if let Err(error) = self.record_stale_task_request_tombstone(&request).await {
                self.append_stale_task_request_skip_failed(&request, error);
                self.notify.notify_waiters();
                return StaleTaskRequestDrain::Blocked;
            }
            self.remove_stale_task_request_from_queue(&request);
        }

        let retry_callbacks = self.input_queue_is_empty();
        self.notify.notify_waiters();
        StaleTaskRequestDrain::Complete { retry_callbacks }
    }

    fn queued_task_request_candidates(&self) -> Vec<QueuedTaskRequestCandidate> {
        let state = self.state.lock().expect("service state mutex poisoned");
        if state.input_queue.has_pending_batch() || state.state == ServiceState::ShuttingDown {
            return Vec::new();
        }
        state.input_queue.task_request_candidates()
    }

    fn has_queued_task_request_for_task(&self, task_id: &str) -> bool {
        let state = self.state.lock().expect("service state mutex poisoned");
        state.input_queue.has_task_request_for_task(task_id)
    }

    fn input_queue_is_empty(&self) -> bool {
        let state = self.state.lock().expect("service state mutex poisoned");
        state.input_queue.is_empty()
    }

    fn stale_task_request(
        &self,
        candidate: QueuedTaskRequestCandidate,
    ) -> Option<StaleTaskRequest> {
        let mut snapshot = self.background_tasks.get(&candidate.task_id);
        let Some(task) = snapshot.as_ref() else {
            return Some(StaleTaskRequest {
                candidate,
                state: None,
                reason: "task_missing",
            });
        };
        let Some(request) = task
            .requests
            .iter()
            .find(|request| request.request_id == candidate.request_id)
        else {
            return Some(StaleTaskRequest {
                candidate,
                state: None,
                reason: "request_missing",
            });
        };
        if request.state == TaskRequestState::Pending {
            if request.deadline_at <= SystemTime::now() {
                self.expire_due_task_requests(&candidate.task_id, SystemTime::now());
                snapshot = self.background_tasks.get(&candidate.task_id);
            } else {
                return None;
            }
        }

        let state = snapshot
            .as_ref()
            .and_then(|task| {
                task.requests
                    .iter()
                    .find(|request| request.request_id == candidate.request_id)
            })
            .map(|request| request.state);
        match state {
            Some(TaskRequestState::Pending) => None,
            Some(state) => Some(StaleTaskRequest {
                candidate,
                state: Some(state),
                reason: "request_not_pending",
            }),
            None => Some(StaleTaskRequest {
                candidate,
                state: None,
                reason: "request_missing",
            }),
        }
    }

    async fn record_stale_task_request_tombstone(
        &self,
        request: &StaleTaskRequest,
    ) -> Result<(), AgentCommitError> {
        if let Some(recorder) = self.recorder.as_ref() {
            recorder
                .record_pending_input_removed(
                    &request.candidate.message_id,
                    request.candidate.source,
                    Some(&request.candidate.metadata),
                    "stale_task_ask",
                )
                .await?;
        }
        Ok(())
    }

    fn remove_stale_task_request_from_queue(&self, request: &StaleTaskRequest) {
        let mut state = self.state.lock().expect("service state mutex poisoned");
        if state.input_queue.has_pending_batch() {
            return;
        }
        if !state.input_queue.remove_stale_task_request(request) {
            return;
        }
        let queue_length = state.input_queue.len();
        self.background_tasks.mark_task_request_stale_skipped(
            &request.candidate.task_id,
            &request.candidate.request_id,
        );
        let request_state = request
            .state
            .map(task_request_state_name)
            .unwrap_or("missing");
        let turn_id = state.active_turn_id.clone();
        let failure = self
            .try_append_event_for_turn_or_mark_locked(
                &mut state,
                turn_id.as_deref(),
                "task_ask.stale_skipped",
                json!({
                    "message_id": request.candidate.message_id,
                    "input_id": request.candidate.message_id,
                    "input_kind": input_kind_name(request.candidate.source),
                    "source": request.candidate.source.as_str(),
                    "task_id": request.candidate.task_id,
                    "ask_id": request.candidate.request_id,
                    "state": request_state,
                    "status": request_state,
                    "reason": request.reason,
                    "queue_length": queue_length
                }),
            )
            .and_then(|_| {
                let turn_id = state.active_turn_id.clone();
                self.try_append_service_status_for_locked(&mut state, turn_id.as_deref())
            })
            .err();
        drop(state);
        if let Some(failure) = failure {
            failure.transition(self);
        }
    }

    fn append_stale_task_request_skip_failed(
        &self,
        request: &StaleTaskRequest,
        error: AgentCommitError,
    ) {
        let error_message = error.to_string();
        let queue_length = self.transition_to_failed(
            format!("failed to persist stale task ask tombstone: {error_message}"),
            |state| state.input_queue.len(),
        );
        let request_state = request
            .state
            .map(task_request_state_name)
            .unwrap_or("missing");
        self.append_event_for_turn_or_record_error(
            None,
            "task_ask.stale_skip_failed",
            json!({
                "message_id": request.candidate.message_id,
                "input_id": request.candidate.message_id,
                "input_kind": input_kind_name(request.candidate.source),
                "source": request.candidate.source.as_str(),
                "task_id": request.candidate.task_id,
                "ask_id": request.candidate.request_id,
                "state": request_state,
                "status": request_state,
                "reason": request.reason,
                "queue_length": queue_length,
                "error": {
                    "code": "pending_removal_persistence_failed",
                    "message": error_message,
                    "retryable": true
                }
            }),
        );
        self.append_service_status_for_current_state(None);
    }

    fn is_shutting_down(&self) -> bool {
        self.state
            .lock()
            .expect("service state mutex poisoned")
            .state
            == ServiceState::ShuttingDown
    }

    fn is_failed(&self) -> bool {
        self.state
            .lock()
            .expect("service state mutex poisoned")
            .state
            == ServiceState::Failed
    }

    fn is_failed_or_shutting_down(&self) -> bool {
        matches!(
            self.state
                .lock()
                .expect("service state mutex poisoned")
                .state,
            ServiceState::Failed | ServiceState::ShuttingDown
        )
    }

    fn cancel_active_turn_if_failed(&self) {
        let (failed, cancel) = {
            let state = self.state.lock().expect("service state mutex poisoned");
            (
                state.state == ServiceState::Failed,
                (state.state == ServiceState::Failed)
                    .then(|| state.active_cancel.clone())
                    .flatten(),
            )
        };
        let subagent_cancels = if failed {
            self.subagent_cancels
                .lock()
                .expect("subagent cancels mutex poisoned")
                .values()
                .cloned()
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        for cancel in subagent_cancels {
            cancel.cancel();
        }
        if !self.is_failed_or_shutting_down() {
            return;
        }
        let subagent_task_owners = self
            .background_tasks
            .list()
            .into_iter()
            .filter(|task| !task.state.is_terminal())
            .filter_map(|task| match task.owner {
                TaskOwner::Subagent { subagent_id } => Some(TaskOwner::subagent(subagent_id)),
                TaskOwner::Main => None,
            })
            .collect::<HashSet<_>>();
        for owner in subagent_task_owners {
            self.background_tasks.cancel_all_by_owner(&owner);
        }
    }

    fn transition_to_failed<R>(
        &self,
        message: impl Into<String>,
        update_state: impl FnOnce(&mut ServiceInnerState) -> R,
    ) -> R {
        let message = message.into();
        let result = {
            let mut admission = self
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned");
            let _frame_lanes = self.discard_all_task_frame_lanes(&mut admission);
            self.task_observer.close_all_admission();
            drop(admission);
            self.task_observer.discard_all_and_fence();
            let mut admission = self
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned");
            let mut state = self.state.lock().expect("service state mutex poisoned");
            if let Some(cancel) = state.active_cancel.as_ref() {
                cancel.cancel();
            }
            let result = update_state(&mut state);
            let entered_failed = state.state != ServiceState::ShuttingDown;
            if entered_failed {
                state.last_error = Some(message);
                state.state = ServiceState::Failed;
            }
            drop(state);
            if entered_failed {
                self.background_tasks.cancel_all();
                self.subagent_tool_snapshots
                    .lock()
                    .expect("subagent tool snapshots mutex poisoned")
                    .clear();
                admission.finishing_tasks.clear();
                admission.discarding_tasks.clear();
            }
            result
        };
        self.cancel_active_turn_if_failed();
        self.notify.notify_waiters();
        result
    }

    fn mark_failed(&self, message: impl Into<String>) {
        self.transition_to_failed(message, |_| ());
    }
}

fn debug_assert_shutdown_cancel_visible(state: &ServiceInnerState) {
    debug_assert!(
        state.state != ServiceState::ShuttingDown
            || state
                .active_cancel
                .as_ref()
                .map(CancellationToken::is_cancelled)
                .unwrap_or(true),
        "ShuttingDown must not be visible before active cancel is cancelled"
    );
}

async fn run_service_loop(inner: Arc<ServiceInner>, cancel: CancellationToken) {
    let intake = inner.intake_gate.lock().await;
    let (
        config,
        initial_messages,
        replay_after_seq,
        initial_current_request_start,
        initial_active_user_message_id,
        initial_active_input_ids,
        initial_known_user_messages,
        restart_boundary_for_retry,
    ) = {
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        if state.state == ServiceState::ShuttingDown {
            state.active_cancel = None;
            state.input_queue.clear_pending_batch();
            clear_active_turn(&mut state);
            let _ = inner.try_append_service_status_event_for_locked(&state, None);
            inner.notify.notify_waiters();
            return;
        }
        if state.state == ServiceState::Failed {
            state.active_cancel = None;
            state.input_queue.clear_pending_batch();
            clear_active_turn(&mut state);
            let _ = inner.try_append_service_status_event_for_locked(&state, None);
            inner.notify.notify_waiters();
            return;
        }
        let turn_id = state
            .active_turn_id
            .clone()
            .unwrap_or_else(|| start_turn(&mut state));
        let initial_messages = repair_provider_transcript(state.context.clone());
        state.context = initial_messages.clone();
        let restart_boundary = state.restart_boundary.take();
        let initial_current_request_start = restart_boundary
            .as_ref()
            .map(|boundary| boundary.current_request_start(&initial_messages));
        let initial_active_user_message_id = restart_boundary
            .as_ref()
            .map(|boundary| boundary.active_user_message_id().to_owned());
        let initial_active_input_ids = restart_boundary
            .as_ref()
            .map(|boundary| boundary.active_input_ids().to_vec())
            .unwrap_or_default();
        (
            inner.config.clone().with_turn_id(turn_id),
            initial_messages,
            inner.last_event_seq(),
            initial_current_request_start,
            initial_active_user_message_id,
            initial_active_input_ids,
            state.known_user_messages.clone(),
            restart_boundary,
        )
    };
    drop(intake);

    let compaction_hook = ServiceCompactionHook {
        inner: Arc::downgrade(&inner),
    };
    let context_recorder = ServiceContextRecorder {
        inner: inner.clone(),
    };
    let result = run_agent_with_shared_event_log_and_compaction_hook(
        config,
        initial_messages,
        inner.provider.as_ref(),
        inner
            .tool_snapshot
            .clone()
            .expect("running service has a validated main tool snapshot"),
        SharedAgentRunOptions {
            input_drainer: Some(inner.as_ref()),
            context_recorder: Some(&context_recorder),
            initial_current_request_start,
            initial_active_user_message_id,
            initial_active_input_ids,
            initial_known_user_messages,
            cancel,
            event_log: None,
            event_appender: Some({
                let inner = inner.clone();
                Arc::new(
                    move |event_type: String,
                          _session: Option<String>,
                          turn_id: Option<String>,
                          data: Value| {
                        let assistant_final_observation = if event_type == "assistant.message" {
                            data.get("text").and_then(Value::as_str).map(|text| {
                                (
                                    text.to_owned(),
                                    data.get("cycle_id")
                                        .and_then(Value::as_str)
                                        .map(ToOwned::to_owned),
                                )
                            })
                        } else {
                            None
                        };
                        let injected_failure = {
                            let mut guard = inner
                                .next_agent_event_write_failure
                                .lock()
                                .expect("agent event write failure mutex poisoned");
                            let should_inject = match guard.as_mut() {
                                Some((remaining, _)) if *remaining == 0 => true,
                                Some((remaining, _)) => {
                                    *remaining -= 1;
                                    false
                                }
                                None => false,
                            };
                            if should_inject {
                                guard.take().map(|(_, failure)| failure)
                            } else {
                                None
                            }
                        };
                        if let Some(failure) = injected_failure {
                            inner
                                .timeline_store
                                .lock()
                                .expect("timeline store mutex poisoned")
                                .inject_next_write_failure(failure);
                        }
                        let event = inner
                            .try_append_event_for_turn(turn_id.as_deref(), &event_type, data)
                            .map_err(|error| AgentCommitError::new(error.to_string()))?;
                        if let Some((text, cycle_id)) = assistant_final_observation {
                            inner
                                .task_observer
                                .publish_final_text(FinalTextObservation {
                                    kind: FinalTextObservationKind::AssistantText,
                                    text: &text,
                                    message_id: None,
                                    cycle_id: cycle_id.as_deref(),
                                });
                        }
                        Ok(event)
                    },
                ) as SharedEventAppender
            }),
            event_notify: None,
            event_observer: None,
            background_host: Some(Arc::new(ServiceBackgroundExecutionHost {
                inner: inner.clone(),
                owner: TaskOwner::Main,
            })),
            profiler: inner.profiler(),
            file_store: inner.file_store.clone(),
            preview_sink: inner
                .llm_text_preview_enabled
                .load(Ordering::SeqCst)
                .then(|| inner.llm_text_preview_hub.sink()),
        },
        Some(&compaction_hook),
    )
    .await;

    let replay_persist_error = persist_public_replay(&inner, replay_after_seq)
        .err()
        .map(|message| format!("failed to persist public event replay: {message}"));

    if let Err(error) = &result {
        if matches!(error.kind, AgentRunErrorKind::Configuration { .. }) {
            *inner
                .configuration_error
                .lock()
                .expect("service configuration error mutex poisoned") = Some(error.to_string());
        }
    }

    let run_failure = replay_persist_error.clone().or_else(|| match &result {
        Err(error)
            if matches!(
                error.kind,
                AgentRunErrorKind::ProviderStop { .. }
                    | AgentRunErrorKind::Persistence { .. }
                    | AgentRunErrorKind::Configuration { .. }
            ) =>
        {
            Some(error.to_string())
        }
        _ => None,
    });
    let intake = inner.intake_gate.lock().await;
    if let Some(error_message) = run_failure {
        let replay_failed = replay_persist_error.is_some();
        inner.transition_to_failed(error_message, |state| {
            state.active_cancel = None;
            state.input_queue.clear_pending_batch();
            match result {
                Ok(result) => state.context = repair_provider_transcript(result.messages),
                Err(error) => {
                    let error_boundary = open_request_boundary_from_agent_error(&error);
                    state.context = repair_provider_transcript(error.messages);
                    if !replay_failed {
                        restore_restart_boundary_for_error(
                            state,
                            restart_boundary_for_retry.as_ref(),
                            error_boundary.as_ref(),
                        );
                    }
                }
            }
            clear_active_turn(state);
            let turn_id = state.active_turn_id.clone();
            let _ = inner.try_append_service_status_event_for_locked(state, turn_id.as_deref());
        });
        drop(intake);
        if !inner.is_shutting_down() {
            retry_pending_task_callbacks(inner.clone()).await;
        }
        inner.notify.notify_waiters();
        return;
    }

    let (next_cancel, status_failure) = {
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        state.active_cancel = None;
        state.input_queue.clear_pending_batch();

        let next_cancel = if state.state == ServiceState::ShuttingDown {
            match result {
                Ok(result) => state.context = repair_provider_transcript(result.messages),
                Err(error) => state.context = repair_provider_transcript(error.messages),
            }
            state.last_error = None;
            clear_active_turn(&mut state);
            None
        } else {
            match result {
                Ok(result) => {
                    state.context = repair_provider_transcript(result.messages);
                    if state.state == ServiceState::Failed {
                        clear_active_turn(&mut state);
                        None
                    } else if state.input_queue.is_empty() {
                        state.last_error = None;
                        state.state = ServiceState::Idle;
                        clear_active_turn(&mut state);
                        None
                    } else {
                        state.last_error = None;
                        Some(start_followup_turn(&mut state))
                    }
                }
                Err(error) => {
                    let error_message = error.to_string();
                    let error_kind = error.kind.clone();
                    let error_boundary = open_request_boundary_from_agent_error(&error);
                    state.context = repair_provider_transcript(error.messages);
                    match error_kind {
                        AgentRunErrorKind::Cancelled => {
                            restore_restart_boundary_for_error(
                                &mut state,
                                restart_boundary_for_retry.as_ref(),
                                error_boundary.as_ref(),
                            );
                            if state.input_queue.is_empty() {
                                state.state = ServiceState::Idle;
                                clear_active_turn(&mut state);
                                None
                            } else {
                                Some(start_followup_turn(&mut state))
                            }
                        }
                        AgentRunErrorKind::ProviderStop { .. } => {
                            unreachable!("provider-stop failures use the canonical transition")
                        }
                        AgentRunErrorKind::Provider { .. } => {
                            state.last_error = Some(error_message);
                            restore_restart_boundary_for_error(
                                &mut state,
                                restart_boundary_for_retry.as_ref(),
                                error_boundary.as_ref(),
                            );
                            if state.input_queue.is_empty() {
                                state.state = ServiceState::Idle;
                                clear_active_turn(&mut state);
                                None
                            } else {
                                Some(start_followup_turn(&mut state))
                            }
                        }
                        AgentRunErrorKind::Persistence { .. } => {
                            unreachable!("persistence failures use the canonical transition")
                        }
                        AgentRunErrorKind::Configuration { .. } => {
                            unreachable!("configuration failures use the canonical transition")
                        }
                    }
                }
            }
        };
        let turn_id = state.active_turn_id.clone();
        match inner.try_append_service_status_for_locked(&mut state, turn_id.as_deref()) {
            Ok(_) => (next_cancel, None),
            Err(failure) => (None, Some(failure)),
        }
    };

    if let Some(failure) = status_failure {
        failure.transition(inner.as_ref());
    }

    drop(intake);
    if !inner.is_shutting_down() {
        retry_pending_task_callbacks(inner.clone()).await;
    }
    inner.notify.notify_waiters();
    if let Some(cancel) = next_cancel {
        spawn_service_loop(inner, cancel);
    }
}

fn spawn_service_loop(inner: Arc<ServiceInner>, cancel: CancellationToken) {
    inner.ensure_registry_maintenance();
    inner.ensure_service_projection_retry_loop();
    inner.service_projection_notify.notify_one();
    let Some((guard, turn_id)) = inner.register_agent_loop_worker() else {
        return;
    };
    let panic_inner = inner.clone();
    tokio::spawn(supervise_service_worker(
        guard,
        run_service_loop(inner, cancel),
        move |panic| async move {
            terminalize_service_loop_panic(panic_inner, turn_id, panic);
        },
    ));
}

fn terminalize_service_loop_panic(inner: Arc<ServiceInner>, worker_turn_id: String, panic: String) {
    let panic_message = format!("agent loop worker panicked: {panic}");
    let mut actual_failure = false;
    let mut frame_lanes = Vec::new();
    let (next_cancel, status_failure) = {
        let mut admission = inner
            .task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned");
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        if state.active_turn_id.as_deref() != Some(worker_turn_id.as_str()) {
            return;
        }
        match state.state {
            ServiceState::Aborting => {
                state.active_cancel = None;
                state.input_queue.clear_pending_batch();
                let next_cancel = if state.input_queue.is_empty() {
                    state.state = ServiceState::Idle;
                    clear_active_turn(&mut state);
                    None
                } else {
                    Some(start_followup_turn(&mut state))
                };
                let turn_id = state.active_turn_id.clone();
                let status_failure = inner
                    .try_append_service_status_for_locked(&mut state, turn_id.as_deref())
                    .err();
                (next_cancel, status_failure)
            }
            ServiceState::ShuttingDown => {
                state.active_cancel = None;
                state.input_queue.clear_pending_batch();
                clear_active_turn(&mut state);
                (None, None)
            }
            ServiceState::Failed => {
                state.active_cancel = None;
                state.input_queue.clear_pending_batch();
                clear_active_turn(&mut state);
                (None, None)
            }
            ServiceState::Idle | ServiceState::Running => {
                actual_failure = true;
                if let Some(cancel) = state.active_cancel.as_ref() {
                    cancel.cancel();
                }
                frame_lanes = inner.discard_all_task_frame_lanes(&mut admission);
                inner.task_observer.close_all_admission();
                state.active_cancel = None;
                state.input_queue.clear_pending_batch();
                clear_active_turn(&mut state);
                state.last_error = Some(panic_message);
                state.state = ServiceState::Failed;
                let status_failure = inner
                    .try_append_service_status_for_locked(&mut state, None)
                    .err();
                (None, status_failure)
            }
        }
    };
    inner.cancel_compaction_run();
    if actual_failure {
        inner.task_observer.discard_all_and_fence();
    }
    drop(frame_lanes);
    if actual_failure {
        inner.background_tasks.cancel_all();
        inner
            .subagent_tool_snapshots
            .lock()
            .expect("subagent tool snapshots mutex poisoned")
            .clear();
        inner.cancel_active_turn_if_failed();
    }
    if let Some(failure) = status_failure.filter(|_| !actual_failure) {
        failure.transition(inner.as_ref());
    }
    inner.notify.notify_waiters();
    if let Some(cancel) = next_cancel {
        spawn_service_loop(inner, cancel);
    }
}

#[cfg(test)]
mod tests;
