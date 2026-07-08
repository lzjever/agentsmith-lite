use std::collections::{HashMap, HashSet, VecDeque};
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
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::agent_events::{is_public_terminal_event, project_thread_event, ThreadEvent};
use crate::agent_loop::{
    run_agent_with_shared_event_log, AcceptedInputEntry, AgentCommitError, AgentConfig,
    AgentContextRecorder, AgentInputDrainer, AgentRunErrorKind, BackgroundExecutionHost,
    DetachedToolResult, DrainBatch, DrainCommit, DrainedMessage, InputSource, InputUrgency,
    QueuedInputMetadata, SharedAgentRunOptions, SharedEventAppender,
};
use crate::event::{
    EventCursor, EventLog, EventReadError, EventReadWindow, ServiceEvent,
    DEFAULT_EVENT_LOG_CAPACITY,
};
use crate::files::{ExternalFileMetadata, FileStore};
use crate::llm_text_preview::{
    LlmTextPreviewFilter, LlmTextPreviewHub, LlmTextPreviewSink, LlmTextPreviewSubscription,
};
use crate::message_render::render_file_manifest;
use crate::profiling::{CsvEventRow, SharedProfiler};
use crate::provider::{Provider, ProviderMetadata};
use crate::registry::{RegistryQuery, RegistryStore, RegistryWriterKind};
use crate::registry_protocol::{
    registry_error_stdio_frame, registry_snapshot_stdio_frame, stdio_registry_response_cap,
};
use crate::session::{
    retain_recent_known_user_messages_for_replay, retain_recent_message_cursors_for_replay,
    DurableMessageCursor, FileSessionRecorder, SessionRestartBoundary,
    DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW,
};
use crate::subagents::{
    SubagentCallbackStatus, SubagentLifecycle, SubagentLimits, SubagentManager,
    SubagentManagerError, SubagentRunState, SubagentSnapshot, SubagentTailKind,
};
use crate::task_observer::{
    FinalTextObservation, FinalTextObservationKind, TaskConversationObserver, TaskObserveMode,
    TaskObserverDiagnostic,
};
use crate::tasks::{
    task_cancel_result_summary, task_detail_summary, task_list_summary, try_write_task_stdin_frame,
    validate_task_stdin_frame, BackgroundTaskManager, BotifiedFrameEvent, CallbackDelivery,
    InteractiveStdioBridge, NewBackgroundTask, TaskCallbackPayloadSnapshot, TaskFrameDiagnostic,
    TaskListTool, TaskOutputUpdate, TaskOwner, TaskRegistryGetFrame, TaskRegistrySetFrame,
    TaskReplyOutcome, TaskReplyPlan, TaskReplyStatus, TaskRequestAdmission, TaskRequestEffect,
    TaskRequestFrame, TaskRequestSnapshot, TaskRequestState, TaskSnapshot, TaskState,
    TaskStdinFrameKind, TaskStdinIntent, TaskStdinIntentKind, TaskStdinWriteSuccess,
    TaskStdinWriter, TaskTellFrame, TASK_CANCEL_TOOL_NAME, TASK_OBSERVE_TOOL_NAME,
    TASK_REPLY_TOOL_NAME, TASK_SEND_TOOL_NAME, TASK_STDIN_CONTROL_FRAME_BYTES,
};
use crate::timeline::{input_item_id, project_timeline_event, TIMELINE_VERSION};
use crate::timeline_store::{
    TimelineAppend, TimelineForwardPage, TimelineHistoryPage, TimelineStore, TimelineStoreError,
    TimelineStoreOptions, TimelineWriteFailure, DEFAULT_TIMELINE_HOT_EVENT_CAPACITY,
    DEFAULT_TIMELINE_RETENTION_DAYS,
};
use crate::tools::{
    registry_tools_for_writer, tools_for_subagent, FilePublicationSink, PublishFileTool, Tool,
    ToolError, ToolExecutionContext, ToolSpec, ToolVisibility,
};
use crate::transcript::repair_provider_transcript;
use crate::types::{ContentPart, Message, ToolCall, ToolResult};

static NEXT_TASK_TELL_INPUT_SUFFIX: AtomicU64 = AtomicU64::new(1);
static NEXT_TASK_SEND_ID_SUFFIX: AtomicU64 = AtomicU64::new(1);

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

impl std::ops::Deref for EnqueueOutcome {
    type Target = ServiceStatus;

    fn deref(&self) -> &Self::Target {
        &self.service_status
    }
}

fn with_builtin_service_tools(
    mut tools: Vec<Arc<dyn Tool>>,
    background_tasks: Arc<BackgroundTaskManager>,
    inner: Weak<ServiceInner>,
    file_store: Option<FileStore>,
    registry_store: Option<RegistryStore>,
    owner: TaskOwner,
    subagents_enabled: bool,
) -> Vec<Arc<dyn Tool>> {
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
        background_tasks,
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
        tools.push(Arc::new(ServiceTaskObserveTool::new(
            inner.clone(),
            owner.clone(),
        )));
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

#[derive(Debug, Clone, Default)]
struct InternalStdioDiagnostics {
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
    model_aliases: HashMap<String, Arc<dyn Provider>>,
}

impl ServiceSubagentOptions {
    pub fn disabled() -> Self {
        Self::default()
    }

    pub fn enabled(limits: SubagentLimits) -> Self {
        Self {
            enabled: true,
            limits,
            model_aliases: HashMap::new(),
        }
    }

    pub fn with_model_alias(
        mut self,
        alias: impl Into<String>,
        provider: Arc<dyn Provider>,
    ) -> Self {
        self.model_aliases.insert(alias.into(), provider);
        self
    }

    fn enabled_flag(&self) -> bool {
        self.enabled
    }

    fn limits(&self) -> SubagentLimits {
        self.limits
    }

    fn provider_for_alias(&self, alias: &str) -> Option<Arc<dyn Provider>> {
        self.model_aliases.get(alias).cloned()
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
    #[error("failed to persist accepted message: {message}")]
    Persistence { message: String },
}

#[derive(Clone)]
pub struct Service {
    inner: Arc<ServiceInner>,
}

struct ServiceInner {
    config: AgentConfig,
    provider: Arc<dyn Provider>,
    base_tools: Vec<Arc<dyn Tool>>,
    tools: Vec<Arc<dyn Tool>>,
    file_store: Option<FileStore>,
    registry_store: Option<RegistryStore>,
    provider_summaries: Mutex<Vec<ProviderMetadata>>,
    recorder: Option<Arc<dyn AgentContextRecorder>>,
    session_recorder: Option<Arc<FileSessionRecorder>>,
    background_tasks: Arc<BackgroundTaskManager>,
    subagent_options: ServiceSubagentOptions,
    subagents: Mutex<SubagentManager>,
    subagent_lifecycle: Mutex<()>,
    subagent_contexts: Mutex<HashMap<String, Vec<Message>>>,
    subagent_cancels: Mutex<HashMap<String, CancellationToken>>,
    subagent_providers: Mutex<HashMap<String, Arc<dyn Provider>>>,
    subagent_callback_epoch: String,
    next_subagent_callback_seq: AtomicU64,
    #[cfg(test)]
    subagent_test_hooks: SubagentTestHooks,
    limits: ServiceLimits,
    timeline_store: Arc<Mutex<TimelineStore>>,
    next_service_event_write_failure: Mutex<Option<(usize, TimelineWriteFailure)>>,
    next_agent_event_write_failure: Mutex<Option<(usize, TimelineWriteFailure)>>,
    event_log: Arc<Mutex<EventLog>>,
    event_notify: Arc<Notify>,
    public_replay: Mutex<PublicReplayProjectionBuffer>,
    intake_gate: AsyncMutex<()>,
    task_frame_admission_gate: Mutex<TaskFrameAdmissionGate>,
    stdio_diagnostics: Mutex<InternalStdioDiagnostics>,
    state: Mutex<ServiceInnerState>,
    notify: Notify,
    profiler: Mutex<Option<SharedProfiler>>,
    llm_text_preview_enabled: AtomicBool,
    llm_text_preview_hub: LlmTextPreviewHub,
    task_observer: TaskConversationObserver,
    task_observer_preview_loop_started: Arc<AtomicBool>,
}

struct PreparedSubagentRun {
    snapshot: SubagentSnapshot,
    subagent_id: String,
    messages: Vec<Message>,
    provider: Arc<dyn Provider>,
    cancel: CancellationToken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SubagentEventAppendOutcome {
    event_written: bool,
    status_written: bool,
}

impl SubagentEventAppendOutcome {
    fn complete(self) -> bool {
        self.event_written && self.status_written
    }
}

enum SubagentRunTerminal {
    Completed(String),
    Failed(String),
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubagentTestHookKind {
    TerminalBeforeContextStore,
    TerminalStateBeforeAppend,
    SubagentPublishOpenCheck,
    QueuedRunProviderClone,
    QueuedRunStateBeforeAppend,
    CallbackEnqueueBeforeRecord,
    CallbackOutcomeBeforeLifecycle,
    CallbackRecordBeforeAppend,
}

#[cfg(test)]
type SubagentTestHook = Arc<dyn Fn() + Send + Sync>;

#[cfg(test)]
#[derive(Default)]
struct SubagentTestHooks {
    after_terminal_before_context_store: Mutex<Option<SubagentTestHook>>,
    after_terminal_state_before_append: Mutex<Option<SubagentTestHook>>,
    after_subagent_publish_open_check: Mutex<Option<SubagentTestHook>>,
    after_queued_run_provider_clone: Mutex<Option<SubagentTestHook>>,
    after_queued_run_state_before_append: Mutex<Option<SubagentTestHook>>,
    after_callback_enqueue_before_record: Mutex<Option<SubagentTestHook>>,
    after_callback_outcome_before_lifecycle: Mutex<Option<SubagentTestHook>>,
    after_callback_record_before_append: Mutex<Option<SubagentTestHook>>,
}

#[cfg(test)]
impl SubagentTestHooks {
    fn set(&self, kind: SubagentTestHookKind, hook: SubagentTestHook) {
        let slot = match kind {
            SubagentTestHookKind::TerminalBeforeContextStore => {
                &self.after_terminal_before_context_store
            }
            SubagentTestHookKind::TerminalStateBeforeAppend => {
                &self.after_terminal_state_before_append
            }
            SubagentTestHookKind::SubagentPublishOpenCheck => {
                &self.after_subagent_publish_open_check
            }
            SubagentTestHookKind::QueuedRunProviderClone => &self.after_queued_run_provider_clone,
            SubagentTestHookKind::QueuedRunStateBeforeAppend => {
                &self.after_queued_run_state_before_append
            }
            SubagentTestHookKind::CallbackEnqueueBeforeRecord => {
                &self.after_callback_enqueue_before_record
            }
            SubagentTestHookKind::CallbackOutcomeBeforeLifecycle => {
                &self.after_callback_outcome_before_lifecycle
            }
            SubagentTestHookKind::CallbackRecordBeforeAppend => {
                &self.after_callback_record_before_append
            }
        };
        *slot.lock().expect("subagent test hook mutex poisoned") = Some(hook);
    }

    fn run(&self, kind: SubagentTestHookKind) {
        let hook = {
            let slot = match kind {
                SubagentTestHookKind::TerminalBeforeContextStore => {
                    &self.after_terminal_before_context_store
                }
                SubagentTestHookKind::TerminalStateBeforeAppend => {
                    &self.after_terminal_state_before_append
                }
                SubagentTestHookKind::SubagentPublishOpenCheck => {
                    &self.after_subagent_publish_open_check
                }
                SubagentTestHookKind::QueuedRunProviderClone => {
                    &self.after_queued_run_provider_clone
                }
                SubagentTestHookKind::QueuedRunStateBeforeAppend => {
                    &self.after_queued_run_state_before_append
                }
                SubagentTestHookKind::CallbackEnqueueBeforeRecord => {
                    &self.after_callback_enqueue_before_record
                }
                SubagentTestHookKind::CallbackOutcomeBeforeLifecycle => {
                    &self.after_callback_outcome_before_lifecycle
                }
                SubagentTestHookKind::CallbackRecordBeforeAppend => {
                    &self.after_callback_record_before_append
                }
            };
            slot.lock()
                .expect("subagent test hook mutex poisoned")
                .clone()
        };
        if let Some(hook) = hook {
            hook();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskFrameAdmissionKind {
    Ask,
    Tell,
    Diagnostic,
}

#[derive(Default)]
struct TaskFrameAdmissionGate {
    #[cfg(test)]
    hook: Option<Arc<dyn Fn(TaskFrameAdmissionKind) + Send + Sync>>,
}

impl TaskFrameAdmissionGate {
    fn pause_for_test(&self, kind: TaskFrameAdmissionKind) {
        #[cfg(test)]
        if let Some(hook) = &self.hook {
            hook(kind);
        }
        #[cfg(not(test))]
        let _ = kind;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServiceWorkerKind {
    AgentLoop,
    FrameHandler,
    BackgroundCompletion,
    SubagentRun,
}

impl ServiceWorkerKind {
    fn can_start_during_shutdown(self) -> bool {
        matches!(self, Self::BackgroundCompletion)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct ServiceWorkerRegistry {
    agent_loop: usize,
    frame_handler: usize,
    background_completion: usize,
    subagent_run: usize,
}

impl ServiceWorkerRegistry {
    fn register(&mut self, kind: ServiceWorkerKind) {
        match kind {
            ServiceWorkerKind::AgentLoop => self.agent_loop += 1,
            ServiceWorkerKind::FrameHandler => self.frame_handler += 1,
            ServiceWorkerKind::BackgroundCompletion => self.background_completion += 1,
            ServiceWorkerKind::SubagentRun => self.subagent_run += 1,
        }
    }

    fn complete(&mut self, kind: ServiceWorkerKind) {
        let count = match kind {
            ServiceWorkerKind::AgentLoop => &mut self.agent_loop,
            ServiceWorkerKind::FrameHandler => &mut self.frame_handler,
            ServiceWorkerKind::BackgroundCompletion => &mut self.background_completion,
            ServiceWorkerKind::SubagentRun => &mut self.subagent_run,
        };
        *count = count.saturating_sub(1);
    }

    fn active_count(&self) -> usize {
        self.agent_loop + self.frame_handler + self.background_completion + self.subagent_run
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

struct ServiceTaskCancelTool {
    background_tasks: Arc<BackgroundTaskManager>,
    inner: Weak<ServiceInner>,
    owner: TaskOwner,
}

struct ServiceTaskReplyTool {
    inner: Weak<ServiceInner>,
    owner: TaskOwner,
}

struct ServiceTaskSendTool {
    inner: Weak<ServiceInner>,
    owner: TaskOwner,
}

struct ServiceTaskObserveTool {
    inner: Weak<ServiceInner>,
    owner: TaskOwner,
}

struct SubagentSpawnTool {
    inner: Weak<ServiceInner>,
}

struct SubagentSendTool {
    inner: Weak<ServiceInner>,
}

struct SubagentReadTool {
    inner: Weak<ServiceInner>,
}

struct SubagentListTool {
    inner: Weak<ServiceInner>,
}

struct SubagentCancelTool {
    inner: Weak<ServiceInner>,
}

#[derive(Debug, Default)]
struct PublicReplayProjectionBuffer {
    events: Vec<BufferedPublicReplayEvent>,
}

impl PublicReplayProjectionBuffer {
    fn observe(&mut self, event: &ServiceEvent) {
        let Some(turn_id) = event.turn_id.clone() else {
            return;
        };
        if event.event_type == "queue.drained" {
            self.events.push(BufferedPublicReplayEvent {
                seq: event.seq,
                turn_id,
                kind: BufferedPublicReplayEventKind::QueueDrained {
                    message_ids: message_ids_from_event_data(&event.data),
                },
            });
            return;
        }
        if let Some(thread_event) = project_thread_event(event) {
            self.events.push(BufferedPublicReplayEvent {
                seq: event.seq,
                turn_id,
                kind: BufferedPublicReplayEventKind::Public(Box::new(thread_event)),
            });
        }
    }

    fn events_after(&self, after_seq: u64) -> Vec<BufferedPublicReplayEvent> {
        self.events
            .iter()
            .filter(|event| event.seq > after_seq)
            .cloned()
            .collect()
    }

    fn prune_through(&mut self, terminal_seq: u64) {
        self.events.retain(|event| event.seq > terminal_seq);
    }
}

#[derive(Debug, Clone)]
struct BufferedPublicReplayEvent {
    seq: u64,
    turn_id: String,
    kind: BufferedPublicReplayEventKind,
}

#[derive(Debug, Clone)]
enum BufferedPublicReplayEventKind {
    QueueDrained { message_ids: Vec<String> },
    Public(Box<ThreadEvent>),
}

const TASK_REPLY_SOURCE: &str = "agent_tool";

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

#[derive(Debug, Clone, PartialEq, Eq)]
enum TaskObserveStatus {
    Enabled,
    Disabled,
    UnknownTask,
    TaskTerminal,
    StdinNotWritable,
    PreviewDisabled,
    InvalidArguments,
    NotAllowed,
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
struct TaskObserveOutcome {
    status: TaskObserveStatus,
    task_id: String,
    mode: Option<TaskObserveMode>,
    message: String,
    field: Option<&'static str>,
}

impl TaskObserveOutcome {
    fn new(
        status: TaskObserveStatus,
        task_id: impl Into<String>,
        mode: Option<TaskObserveMode>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status,
            task_id: task_id.into(),
            mode,
            message: message.into(),
            field: None,
        }
    }

    fn invalid(
        task_id: impl Into<String>,
        field: &'static str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status: TaskObserveStatus::InvalidArguments,
            task_id: task_id.into(),
            mode: None,
            message: message.into(),
            field: Some(field),
        }
    }

    fn ok(&self) -> bool {
        matches!(
            self.status,
            TaskObserveStatus::Enabled | TaskObserveStatus::Disabled
        )
    }

    fn observing(&self) -> bool {
        self.status == TaskObserveStatus::Enabled
    }
}

impl ServiceTaskReplyTool {
    fn new(inner: Weak<ServiceInner>, owner: TaskOwner) -> Self {
        Self { inner, owner }
    }
}

impl ServiceTaskSendTool {
    fn new(inner: Weak<ServiceInner>, owner: TaskOwner) -> Self {
        Self { inner, owner }
    }
}

impl ServiceTaskObserveTool {
    fn new(inner: Weak<ServiceInner>, owner: TaskOwner) -> Self {
        Self { inner, owner }
    }
}

impl ServiceTaskCancelTool {
    fn new(
        background_tasks: Arc<BackgroundTaskManager>,
        inner: Weak<ServiceInner>,
        owner: TaskOwner,
    ) -> Self {
        Self {
            background_tasks,
            inner,
            owner,
        }
    }
}

impl SubagentSpawnTool {
    fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

impl SubagentSendTool {
    fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

impl SubagentReadTool {
    fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

impl SubagentListTool {
    fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

impl SubagentCancelTool {
    fn new(inner: Weak<ServiceInner>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl Tool for ServiceTaskCancelTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_CANCEL_TOOL_NAME,
            "Request cancellation of a running in-process background task by task_id.",
            json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The task_id returned by a detached task or task_list."
                    }
                },
                "required": ["task_id"],
                "additionalProperties": false
            }),
        )
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        let Some(task_id) = call.arguments.get("task_id").and_then(Value::as_str) else {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                "task_id is required",
                json!({"kind": "invalid_task_cancel_arguments", "field": "task_id"}),
            ));
        };
        let Some(snapshot) = self.background_tasks.cancel_by_owner(&self.owner, task_id) else {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                format!("task not found: {task_id}"),
                json!({"kind": "task_not_found", "task_id": task_id}),
            ));
        };

        if snapshot.state == TaskState::Cancelling {
            if let Some(inner) = self.inner.upgrade() {
                match &self.owner {
                    TaskOwner::Main => inner.append_task_updated_event(&snapshot),
                    TaskOwner::Subagent { subagent_id } => {
                        inner.append_subagent_event_for_id("subagent.callback", subagent_id);
                    }
                }
            }
        }

        let details = task_cancel_result_summary(&snapshot);
        let mut result = ToolResult::success(call.id, call.name, details.to_string());
        result.details = details;
        Ok(result)
    }
}

#[async_trait]
impl Tool for ServiceTaskReplyTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_REPLY_TOOL_NAME,
            "Reply to a pending <task_ask ...> input. Use only for task_ask inputs; the message is written to child stdin as a <botified>{\"op\":\"reply\",...}</botified> line.",
            json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The task_id attribute from the <task_ask ...> input."
                    },
                    "ask_id": {
                        "type": "string",
                        "description": "The ask_id attribute from the <task_ask ...> input."
                    },
                    "message": {
                        "type": "string",
                        "description": "The answer message to write to the child process stdin in the unified botified reply envelope."
                    }
                },
                "required": ["task_id", "ask_id", "message"],
                "additionalProperties": false
            }),
        )
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) =
            reject_unknown_task_reply_arguments(&call, &["task_id", "ask_id", "message"])
        {
            return Ok(result);
        }
        let Some(task_id) = call.arguments.get("task_id").and_then(Value::as_str) else {
            return Ok(invalid_task_reply_argument(call, "task_id"));
        };
        let Some(request_id) = call.arguments.get("ask_id").and_then(Value::as_str) else {
            return Ok(invalid_task_reply_argument(call, "ask_id"));
        };
        let Some(response) = call.arguments.get("message").and_then(Value::as_str) else {
            return Ok(invalid_task_reply_argument(call, "message"));
        };
        let Some(inner) = self.inner.upgrade() else {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                "service is not available",
                json!({"kind": "service_unavailable"}),
            ));
        };
        let outcome = inner.reply_task_request_by_owner(&self.owner, task_id, request_id, response);
        let details = task_reply_details(&outcome);
        if outcome.ok() {
            Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
        } else {
            Ok(ToolResult::error(
                call.id,
                call.name,
                outcome.message,
                details,
            ))
        }
    }
}

#[async_trait]
impl Tool for ServiceTaskSendTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_SEND_TOOL_NAME,
            "Send a message to a running interactive task stdin. This does not reply to any pending task_ask and does not wait for an acknowledgement; use only with task_id values from trusted task metadata.",
            json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The task_id from trusted task metadata such as task_list, task_ask, task_tell, callback, or tool result. Do not guess task ids."
                    },
                    "message": {
                        "type": "string",
                        "description": "The message to write to child stdin in a <botified>{\"op\":\"send\",...}</botified> envelope. This does not resolve pending asks or wait for ack."
                    }
                },
                "required": ["task_id", "message"],
                "additionalProperties": false
            }),
        )
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) = reject_unknown_arguments(&call, &["task_id", "message"]) {
            return Ok(result);
        }
        let Some(task_id) = call.arguments.get("task_id").and_then(Value::as_str) else {
            return Ok(invalid_task_send_argument(call, "task_id"));
        };
        let Some(message) = call.arguments.get("message").and_then(Value::as_str) else {
            return Ok(invalid_task_send_argument(call, "message"));
        };
        let Some(inner) = self.inner.upgrade() else {
            let details = task_send_details(&TaskSendOutcome::new(
                TaskSendStatus::ServiceUnavailable,
                task_id,
                None,
                "service is not available",
            ));
            return Ok(ToolResult::error(
                call.id,
                call.name,
                "service is not available",
                details,
            ));
        };
        let outcome = inner.send_task_message_by_owner(&self.owner, task_id, message);
        let details = task_send_details(&outcome);
        if outcome.ok() {
            Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
        } else {
            Ok(ToolResult::error(
                call.id,
                call.name,
                outcome.message,
                details,
            ))
        }
    }
}

#[async_trait]
impl Tool for ServiceTaskObserveTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_OBSERVE_TOOL_NAME,
            "Enable or disable a read-only conversation observer for a running interactive task. The observer writes future text-only observe frames to task stdin and cannot modify user input or assistant output.",
            json!({
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The task_id of the running interactive task that will receive observe frames."
                    },
                    "enabled": {
                        "type": "boolean",
                        "description": "Enable the observer when true, or disable the existing observer for this task when false."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["final", "stream"],
                        "description": "Observation mode when enabling: final observes future external user text and assistant final text; stream observes assistant draft started/delta/done/error and requires llm_text_preview.enabled=true."
                    }
                },
                "required": ["task_id", "enabled"],
                "additionalProperties": false
            }),
        )
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) = reject_unknown_arguments(&call, &["task_id", "enabled", "mode"]) {
            return Ok(result);
        }
        let Some(task_id) = call.arguments.get("task_id").and_then(Value::as_str) else {
            return Ok(invalid_task_observe_argument(call, "task_id"));
        };
        let Some(enabled) = call.arguments.get("enabled").and_then(Value::as_bool) else {
            return Ok(invalid_task_observe_argument(call, "enabled"));
        };
        let mode = if enabled {
            let Some(mode) = call.arguments.get("mode").and_then(Value::as_str) else {
                return Ok(invalid_task_observe_argument(call, "mode"));
            };
            match TaskObserveMode::parse(mode) {
                Some(mode) => Some(mode),
                None => {
                    let outcome = TaskObserveOutcome::invalid(
                        task_id,
                        "mode",
                        "mode must be \"final\" or \"stream\"",
                    );
                    let details = task_observe_details(&outcome);
                    return Ok(ToolResult::error(
                        call.id,
                        call.name,
                        outcome.message,
                        details,
                    ));
                }
            }
        } else {
            None
        };
        let Some(inner) = self.inner.upgrade() else {
            let outcome = TaskObserveOutcome::new(
                TaskObserveStatus::ServiceUnavailable,
                task_id,
                mode,
                "service is not available",
            );
            let details = task_observe_details(&outcome);
            return Ok(ToolResult::error(
                call.id,
                call.name,
                outcome.message,
                details,
            ));
        };
        let outcome = inner.observe_task_by_owner(&self.owner, task_id, enabled, mode);
        let details = task_observe_details(&outcome);
        if outcome.ok() {
            Ok(ToolResult::success(call.id, call.name, details.to_string()).with_details(details))
        } else {
            Ok(ToolResult::error(
                call.id,
                call.name,
                outcome.message,
                details,
            ))
        }
    }
}

#[async_trait]
impl Tool for SubagentSpawnTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "subagent_spawn",
            "Create one internal subagent branch and start its first run.",
            json!({
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "The bounded task instruction for the subagent."
                    },
                    "name_hint": {
                        "type": "string",
                        "description": "Optional short human-readable branch name hint."
                    },
                    "inherit_context": {
                        "type": "boolean",
                        "description": "When true, start from the current main context snapshot; defaults to false."
                    },
                    "model_alias": {
                        "type": "string",
                        "description": "Optional configured subagent model alias."
                    }
                },
                "required": ["task"],
                "additionalProperties": false
            }),
        )
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::SubagentControl
    }

    async fn execute(
        &self,
        call: ToolCall,
        context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) = reject_unknown_arguments(
            &call,
            &["task", "name_hint", "inherit_context", "model_alias"],
        ) {
            return Ok(result);
        }
        let Some(task) = call
            .arguments
            .get("task")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return Ok(invalid_subagent_argument(call, "task"));
        };
        let name_hint = call
            .arguments
            .get("name_hint")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let inherit_context = call
            .arguments
            .get("inherit_context")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let model_alias = call
            .arguments
            .get("model_alias")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        Ok(inner.spawn_subagent_tool_result(
            call,
            &task,
            &name_hint,
            inherit_context,
            model_alias.as_deref(),
            context.provider_transcript_snapshot,
        ))
    }
}

#[async_trait]
impl Tool for SubagentSendTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "subagent_send",
            "Send a follow-up instruction to an existing internal subagent branch.",
            json!({
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "The subagent_id returned by subagent_spawn or subagent_list."
                    },
                    "message": {
                        "type": "string",
                        "description": "The branch-local follow-up instruction."
                    }
                },
                "required": ["subagent_id", "message"],
                "additionalProperties": false
            }),
        )
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::SubagentControl
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) = reject_unknown_arguments(&call, &["subagent_id", "message"]) {
            return Ok(result);
        }
        let Some(subagent_id) = call
            .arguments
            .get("subagent_id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return Ok(invalid_subagent_argument(call, "subagent_id"));
        };
        let Some(message) = call
            .arguments
            .get("message")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return Ok(invalid_subagent_argument(call, "message"));
        };
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        Ok(inner.send_subagent_tool_result(call, &subagent_id, &message))
    }
}

#[async_trait]
impl Tool for SubagentReadTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "subagent_read",
            "Read a bounded summary of one internal subagent branch.",
            json!({
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "The subagent_id returned by subagent_spawn or subagent_list."
                    },
                    "include": {
                        "type": "string",
                        "enum": ["summary", "tail", "all"],
                        "description": "Optional bounded view to include; defaults to summary."
                    }
                },
                "required": ["subagent_id"],
                "additionalProperties": false
            }),
        )
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::SubagentControl
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) = reject_unknown_arguments(&call, &["subagent_id", "include"]) {
            return Ok(result);
        }
        let Some(subagent_id) = call
            .arguments
            .get("subagent_id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return Ok(invalid_subagent_argument(call, "subagent_id"));
        };
        let include = call
            .arguments
            .get("include")
            .and_then(Value::as_str)
            .unwrap_or("summary")
            .to_owned();
        if !matches!(include.as_str(), "summary" | "tail" | "all") {
            return Ok(ToolResult::error(
                call.id,
                call.name,
                "include must be summary, tail, or all",
                json!({"kind": "invalid_subagent_arguments", "field": "include"}),
            ));
        }
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        Ok(inner.read_subagent_tool_result(call, &subagent_id, &include))
    }
}

#[async_trait]
impl Tool for SubagentListTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "subagent_list",
            "List internal subagent branches with bounded summaries.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        )
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::SubagentControl
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) = reject_unknown_arguments(&call, &[]) {
            return Ok(result);
        }
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        Ok(inner.list_subagents_tool_result(call))
    }
}

#[async_trait]
impl Tool for SubagentCancelTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "subagent_cancel",
            "Cancel one internal subagent branch.",
            json!({
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "The subagent_id returned by subagent_spawn or subagent_list."
                    }
                },
                "required": ["subagent_id"],
                "additionalProperties": false
            }),
        )
    }

    fn visibility(&self) -> ToolVisibility {
        ToolVisibility::SubagentControl
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        if let Some(result) = reject_unknown_arguments(&call, &["subagent_id"]) {
            return Ok(result);
        }
        let Some(subagent_id) = call
            .arguments
            .get("subagent_id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            return Ok(invalid_subagent_argument(call, "subagent_id"));
        };
        let Some(inner) = self.inner.upgrade() else {
            return Ok(service_unavailable_tool_result(call));
        };
        Ok(inner.cancel_subagent_tool_result(call, &subagent_id))
    }
}

fn invalid_task_reply_argument(call: ToolCall, field: &str) -> ToolResult {
    ToolResult::error(
        call.id,
        call.name,
        format!("{field} is required"),
        json!({"kind": "invalid_task_reply_arguments", "field": field}),
    )
}

fn reject_unknown_task_reply_arguments(call: &ToolCall, allowed: &[&str]) -> Option<ToolResult> {
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
        json!({"kind": "invalid_task_reply_arguments", "field": unknown}),
    ))
}

fn invalid_task_send_argument(call: ToolCall, field: &str) -> ToolResult {
    ToolResult::error(
        call.id,
        call.name,
        format!("{field} is required"),
        json!({"kind": "invalid_task_send_arguments", "field": field}),
    )
}

fn invalid_task_observe_argument(call: ToolCall, field: &'static str) -> ToolResult {
    let outcome = TaskObserveOutcome::invalid("", field, format!("{field} is required"));
    ToolResult::error(
        call.id,
        call.name,
        outcome.message.clone(),
        task_observe_details(&outcome),
    )
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

fn invalid_subagent_argument(call: ToolCall, field: &str) -> ToolResult {
    ToolResult::error(
        call.id,
        call.name,
        format!("{field} is required"),
        json!({"kind": "invalid_subagent_arguments", "field": field}),
    )
}

fn service_unavailable_tool_result(call: ToolCall) -> ToolResult {
    ToolResult::error(
        call.id,
        call.name,
        "service is not available",
        json!({"kind": "service_unavailable"}),
    )
}

trait ToolResultDetailsExt {
    fn with_details(self, details: Value) -> Self;
}

impl ToolResultDetailsExt for ToolResult {
    fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}

struct ServiceInnerState {
    state: ServiceState,
    context: Vec<Message>,
    input_queue: InputQueueState,
    service_workers: ServiceWorkerRegistry,
    message_index: HashMap<String, MessageIndexEntry>,
    durable_message_replays: HashMap<String, DurableMessageReplay>,
    restart_boundary: Option<SessionRestartBoundary>,
    next_turn_number: u64,
    active_turn_id: Option<String>,
    active_cancel: Option<CancellationToken>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QueuedMessage {
    id: String,
    content: Vec<ContentPart>,
    source: InputSource,
    urgency: InputUrgency,
    metadata: Option<QueuedInputMetadata>,
    cursor_seq: u64,
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
    event_type: &'static str,
    data: Value,
}

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
    Complete,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MessageIndexEntry {
    content: Vec<ContentPart>,
    cursor: EventCursor,
    projection_state: MessageProjectionState,
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

fn durable_terminal_seq(replay_start_seq: u64, raw_terminal_seq: u64, has_events: bool) -> u64 {
    let terminal_seq = if raw_terminal_seq == 0 {
        replay_start_seq
    } else {
        raw_terminal_seq
    };
    if has_events {
        terminal_seq.max(replay_start_seq.saturating_add(1))
    } else {
        terminal_seq
    }
}

static NEXT_SUBAGENT_CALLBACK_EPOCH: AtomicU64 = AtomicU64::new(1);
static NEXT_DEFAULT_TIMELINE_DIR: AtomicU64 = AtomicU64::new(1);

fn new_subagent_callback_epoch() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let ordinal = NEXT_SUBAGENT_CALLBACK_EPOCH.fetch_add(1, Ordering::Relaxed);
    format!("c{timestamp:x}{:x}{ordinal:x}", std::process::id())
}

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

impl Service {
    pub fn new(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
    ) -> Self {
        Self::with_limits(config, provider, tools, ServiceLimits::default())
    }

    pub fn with_timeline_data_dir(
        mut config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        timeline_data_dir: impl Into<PathBuf>,
    ) -> Self {
        config.task_output.data_dir = timeline_data_dir.into();
        Self::with_limits(config, provider, tools, ServiceLimits::default())
    }

    pub fn with_file_store(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        file_store: FileStore,
    ) -> Self {
        Self::with_file_store_and_limits(
            config,
            provider,
            tools,
            file_store,
            ServiceLimits::default(),
        )
    }

    pub fn with_registry_store(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        registry_store: RegistryStore,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_options(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            ServiceLimits::default(),
            None,
            Some(registry_store),
            ServiceSubagentOptions::default(),
        )
    }

    pub fn with_provider_summaries(self, providers: Vec<ProviderMetadata>) -> Self {
        self.set_provider_summaries(providers);
        self
    }

    pub fn with_profiler(self, profiler: Option<SharedProfiler>) -> Self {
        self.set_profiler(profiler);
        self
    }

    pub fn with_llm_text_preview_enabled(self, enabled: bool) -> Self {
        self.set_llm_text_preview_enabled(enabled);
        self
    }

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

    pub fn llm_text_preview_enabled(&self) -> bool {
        self.inner.llm_text_preview_enabled.load(Ordering::SeqCst)
    }

    pub fn llm_text_preview_sink(&self) -> Option<LlmTextPreviewSink> {
        self.llm_text_preview_enabled()
            .then(|| self.inner.llm_text_preview_hub.sink())
    }

    pub fn subscribe_llm_text_preview(
        &self,
        filter: LlmTextPreviewFilter,
    ) -> Option<LlmTextPreviewSubscription> {
        self.llm_text_preview_enabled()
            .then(|| self.inner.llm_text_preview_hub.subscribe(filter))
    }

    pub fn file_store(&self) -> Option<FileStore> {
        self.inner.file_store.clone()
    }

    pub fn registry_store(&self) -> Option<RegistryStore> {
        self.inner.registry_store.clone()
    }

    pub fn with_limits(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        limits: ServiceLimits,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            limits,
        )
    }

    pub fn with_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        subagent_options: ServiceSubagentOptions,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_and_subagent_options(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            ServiceLimits::default(),
            subagent_options,
        )
    }

    pub fn with_registry_store_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        registry_store: RegistryStore,
        subagent_options: ServiceSubagentOptions,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_options(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            ServiceLimits::default(),
            None,
            Some(registry_store),
            subagent_options,
        )
    }

    pub fn with_file_store_and_limits(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        file_store: FileStore,
        limits: ServiceLimits,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_optional_file_store(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            limits,
            Some(file_store),
        )
    }

    pub fn with_file_store_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        file_store: FileStore,
        subagent_options: ServiceSubagentOptions,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_optional_file_store_and_subagent_options(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            ServiceLimits::default(),
            Some(file_store),
            subagent_options,
        )
    }

    pub fn with_initial_context(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
    ) -> Self {
        Self::with_initial_context_and_pending_messages(
            config,
            provider,
            tools,
            initial_context,
            Vec::new(),
            recorder,
        )
    }

    pub fn with_initial_context_and_pending_messages(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_warnings(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            recorder,
            Vec::new(),
        )
    }

    pub fn with_initial_context_and_warnings(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_warnings(
            config,
            provider,
            tools,
            initial_context,
            Vec::new(),
            recorder,
            warnings,
        )
    }

    pub fn with_initial_context_and_pending_messages_and_known_user_messages(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            recorder,
            Vec::new(),
        )
    }

    pub fn with_initial_context_and_pending_messages_and_warnings(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            Vec::new(),
            recorder,
            warnings,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            recorder,
            warnings,
            ServiceLimits::default(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_limits(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        message_cursors: Vec<DurableMessageCursor>,
        recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
    ) -> Self {
        let context_recorder = recorder
            .clone()
            .map(|recorder| recorder as Arc<dyn AgentContextRecorder>);
        Self::with_public_replay_and_limits(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            message_cursors,
            None,
            context_recorder,
            recorder,
            warnings,
            limits,
            None,
            None,
            ServiceSubagentOptions::default(),
            DEFAULT_TIMELINE_RETENTION_DAYS,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_restart_boundary_and_limits(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        message_cursors: Vec<DurableMessageCursor>,
        restart_boundary: Option<SessionRestartBoundary>,
        recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
    ) -> Self {
        let context_recorder = recorder
            .clone()
            .map(|recorder| recorder as Arc<dyn AgentContextRecorder>);
        Self::with_public_replay_and_limits(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            message_cursors,
            restart_boundary,
            context_recorder,
            recorder,
            warnings,
            limits,
            None,
            None,
            ServiceSubagentOptions::default(),
            DEFAULT_TIMELINE_RETENTION_DAYS,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_restart_boundary_and_limits_and_file_store(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        message_cursors: Vec<DurableMessageCursor>,
        restart_boundary: Option<SessionRestartBoundary>,
        recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: FileStore,
    ) -> Self {
        Self::with_session_replay_and_restart_boundary_and_limits_and_file_store_and_subagent_options(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            message_cursors,
            restart_boundary,
            recorder,
            warnings,
            limits,
            file_store,
            ServiceSubagentOptions::default(),
            DEFAULT_TIMELINE_RETENTION_DAYS,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_restart_boundary_and_limits_and_file_store_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        message_cursors: Vec<DurableMessageCursor>,
        restart_boundary: Option<SessionRestartBoundary>,
        recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: FileStore,
        subagent_options: ServiceSubagentOptions,
        timeline_retention_days: u64,
    ) -> Self {
        Self::with_session_replay_and_restart_boundary_and_limits_and_file_store_and_registry_store_and_subagent_options(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            message_cursors,
            restart_boundary,
            recorder,
            warnings,
            limits,
            file_store,
            None,
            subagent_options,
            timeline_retention_days,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_restart_boundary_and_limits_and_file_store_and_registry_store_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        message_cursors: Vec<DurableMessageCursor>,
        restart_boundary: Option<SessionRestartBoundary>,
        recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: FileStore,
        registry_store: Option<RegistryStore>,
        subagent_options: ServiceSubagentOptions,
        timeline_retention_days: u64,
    ) -> Self {
        let context_recorder = recorder
            .clone()
            .map(|recorder| recorder as Arc<dyn AgentContextRecorder>);
        Self::with_public_replay_and_limits(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            message_cursors,
            restart_boundary,
            context_recorder,
            recorder,
            warnings,
            limits,
            Some(file_store),
            registry_store,
            subagent_options,
            timeline_retention_days,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_and_subagent_options(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            recorder,
            warnings,
            limits,
            ServiceSubagentOptions::default(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        subagent_options: ServiceSubagentOptions,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_optional_file_store_and_subagent_options(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            recorder,
            warnings,
            limits,
            None,
            subagent_options,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_optional_file_store(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: Option<FileStore>,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_options(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            recorder,
            warnings,
            limits,
            file_store,
            None,
            ServiceSubagentOptions::default(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_optional_file_store_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: Option<FileStore>,
        subagent_options: ServiceSubagentOptions,
    ) -> Self {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_options(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            recorder,
            warnings,
            limits,
            file_store,
            None,
            subagent_options,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: Option<FileStore>,
        registry_store: Option<RegistryStore>,
        subagent_options: ServiceSubagentOptions,
    ) -> Self {
        Self::with_public_replay_and_limits(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            Vec::new(),
            None,
            recorder,
            None,
            warnings,
            limits,
            file_store,
            registry_store,
            subagent_options,
            DEFAULT_TIMELINE_RETENTION_DAYS,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_public_replay_and_limits(
        mut config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        message_cursors: Vec<DurableMessageCursor>,
        restart_boundary: Option<SessionRestartBoundary>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        session_recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: Option<FileStore>,
        registry_store: Option<RegistryStore>,
        subagent_options: ServiceSubagentOptions,
        timeline_retention_days: u64,
    ) -> Self {
        assert!(
            limits.max_queue_messages > 0,
            "max_queue_messages must be greater than 0"
        );
        assert!(
            limits.max_queue_bytes > 0,
            "max_queue_bytes must be greater than 0"
        );
        if file_store.is_some() {
            config = config.with_file_publication_capability();
        }
        if registry_store.is_some() {
            config = config.with_registry_capability();
        }
        if subagent_options.enabled_flag() {
            config = config.with_subagent_control_capability();
        }
        let initial_context = repair_provider_transcript(initial_context);
        let background_tasks = Arc::new(
            BackgroundTaskManager::with_limits_and_task_request_deadline(
                config.task_output.callback_output_tail_bytes,
                config.tool_execution.max_retained_tasks,
                config.tool_execution.task_retention,
                config.tool_execution.max_task_request_pending,
            ),
        );
        let timeline_options = TimelineStoreOptions::new(
            inferred_timeline_data_dir(&config),
            config.session.as_deref(),
        )
        .retention_days(timeline_retention_days)
        .hot_event_capacity(DEFAULT_TIMELINE_HOT_EVENT_CAPACITY);
        let timeline_store = Arc::new(Mutex::new(
            TimelineStore::open(timeline_options).expect("timeline store should open"),
        ));
        let timeline_instance = timeline_store
            .lock()
            .expect("timeline store mutex poisoned")
            .instance()
            .to_owned();
        let event_log = Arc::new(Mutex::new(
            EventLog::with_process_instance(timeline_instance.clone(), DEFAULT_EVENT_LOG_CAPACITY)
                .expect("timeline store instance should be valid"),
        ));
        append_committed_service_event(
            &timeline_store,
            &event_log,
            config.session.as_deref(),
            None,
            "service.started",
            json!({}),
        )
        .expect("service.started timeline event should persist");
        for warning in &warnings {
            append_committed_service_event(
                &timeline_store,
                &event_log,
                config.session.as_deref(),
                None,
                "service.warning",
                json!({ "message": warning }),
            )
            .expect("service.warning timeline event should persist");
        }
        let replay_cursor = current_timeline_cursor(&timeline_store);
        let replay_cursor_seq = replay_cursor.seq();
        let known_user_messages = retain_recent_known_user_messages_for_replay(
            known_user_messages,
            &pending_messages,
            DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW,
        );
        let message_cursors = retain_recent_message_cursors_for_replay(
            message_cursors,
            DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW,
        );
        let queue = pending_messages
            .into_iter()
            .map(|message| QueuedMessage {
                id: message.id,
                content: message.content,
                source: message.source,
                urgency: message.urgency,
                metadata: message.metadata,
                cursor_seq: message.cursor_seq.unwrap_or(replay_cursor_seq),
            })
            .collect::<VecDeque<_>>();
        let mut durable_message_replays = HashMap::new();
        let mut durable_message_index_cursors = HashMap::new();
        for cursor in message_cursors {
            let terminal_seq = durable_terminal_seq(
                cursor.replay_start_seq,
                cursor.terminal_seq,
                !cursor.replay_events.is_empty(),
            );
            let message_cursor = retained_timeline_cursor_for_durable_message(
                &timeline_store,
                &timeline_instance,
                cursor.replay_start_seq,
                terminal_seq,
            )
            .unwrap_or_else(|| replay_cursor.clone());
            durable_message_index_cursors.insert(cursor.message_id.clone(), message_cursor);
            durable_message_replays.insert(
                cursor.message_id,
                DurableMessageReplay {
                    replay_start_seq: cursor.replay_start_seq,
                    terminal_seq,
                    events: cursor.replay_events,
                },
            );
        }
        let mut message_index = HashMap::new();
        for message in known_user_messages {
            if let Some(cursor) = durable_message_index_cursors.get(&message.id) {
                insert_message_index_entry(
                    &mut message_index,
                    message.id.clone(),
                    message.content,
                    cursor.clone(),
                );
            } else {
                insert_message_index_entry_with_projection_state(
                    &mut message_index,
                    message.id.clone(),
                    message.content,
                    replay_cursor.clone(),
                    MessageProjectionState::MissingProjection,
                );
            }
        }
        for message in &queue {
            let cursor = retained_timeline_cursor_for_seq(
                &timeline_store,
                &timeline_instance,
                message.cursor_seq,
            )
            .unwrap_or_else(|| replay_cursor.clone());
            insert_message_index_entry(
                &mut message_index,
                message.id.clone(),
                message.content.clone(),
                cursor,
            );
        }

        let event_notify = Arc::new(Notify::new());
        let initial_state = ServiceInnerState {
            state: ServiceState::Idle,
            context: initial_context,
            input_queue: InputQueueState::new(queue),
            service_workers: ServiceWorkerRegistry::default(),
            message_index,
            durable_message_replays,
            restart_boundary,
            next_turn_number: 1,
            active_turn_id: None,
            active_cancel: None,
            last_error: None,
        };
        let mut initial_state = initial_state;
        prune_message_index_to_retained_window(&mut initial_state);
        prune_durable_message_replays_to_retained_window(&mut initial_state);
        let subagent_callback_epoch = new_subagent_callback_epoch();

        let base_tools = tools;
        let subagent_manager = SubagentManager::new(subagent_options.limits())
            .expect("service subagent limits must be valid");
        let subagents_enabled = subagent_options.enabled_flag();
        let inner = Arc::new_cyclic(|weak_inner| {
            let tools = with_builtin_service_tools(
                base_tools.clone(),
                background_tasks.clone(),
                weak_inner.clone(),
                file_store.clone(),
                registry_store.clone(),
                TaskOwner::Main,
                subagents_enabled,
            );
            ServiceInner {
                config,
                provider,
                base_tools: base_tools.clone(),
                tools,
                file_store: file_store.clone(),
                registry_store: registry_store.clone(),
                provider_summaries: Mutex::new(Vec::new()),
                recorder,
                session_recorder,
                background_tasks,
                subagent_options,
                subagents: Mutex::new(subagent_manager),
                subagent_lifecycle: Mutex::new(()),
                subagent_contexts: Mutex::new(HashMap::new()),
                subagent_cancels: Mutex::new(HashMap::new()),
                subagent_providers: Mutex::new(HashMap::new()),
                subagent_callback_epoch,
                next_subagent_callback_seq: AtomicU64::new(1),
                #[cfg(test)]
                subagent_test_hooks: SubagentTestHooks::default(),
                limits,
                timeline_store,
                next_service_event_write_failure: Mutex::new(None),
                next_agent_event_write_failure: Mutex::new(None),
                event_log,
                event_notify,
                public_replay: Mutex::new(PublicReplayProjectionBuffer::default()),
                intake_gate: AsyncMutex::new(()),
                task_frame_admission_gate: Mutex::new(TaskFrameAdmissionGate::default()),
                stdio_diagnostics: Mutex::new(InternalStdioDiagnostics::default()),
                state: Mutex::new(initial_state),
                notify: Notify::new(),
                profiler: Mutex::new(None),
                llm_text_preview_enabled: AtomicBool::new(false),
                llm_text_preview_hub: LlmTextPreviewHub::new(),
                task_observer: TaskConversationObserver::new({
                    let weak_inner = weak_inner.clone();
                    move |diagnostic| {
                        if let Some(inner) = weak_inner.upgrade() {
                            inner.record_task_observer_diagnostic(diagnostic);
                        }
                    }
                }),
                task_observer_preview_loop_started: Arc::new(AtomicBool::new(false)),
            }
        });

        Self { inner }
    }

    pub fn status(&self) -> ServiceStatus {
        self.inner.status()
    }

    pub fn timeline_bootstrap_snapshot(&self) -> Value {
        self.inner.timeline_bootstrap_snapshot()
    }

    pub fn context_messages(&self) -> Vec<Message> {
        self.inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .context
            .clone()
    }

    pub fn events_after(&self, after_seq: u64) -> Vec<ServiceEvent> {
        self.inner
            .event_log
            .lock()
            .expect("event log mutex poisoned")
            .read_after(after_seq)
    }

    pub fn events_after_cursor(
        &self,
        cursor: EventCursor,
    ) -> Result<Vec<ServiceEvent>, EventReadError> {
        Ok(self.event_window_after_cursor(cursor)?.events)
    }

    pub fn event_window_after_cursor(
        &self,
        cursor: EventCursor,
    ) -> Result<EventReadWindow, EventReadError> {
        self.inner.event_window_after_cursor(cursor)
    }

    pub fn current_event_cursor(&self) -> EventCursor {
        current_timeline_cursor(&self.inner.timeline_store)
    }

    pub fn timeline_forward_page(
        &self,
        cursor: &str,
        limit: usize,
    ) -> Result<TimelineForwardPage, TimelineStoreError> {
        self.inner
            .timeline_store
            .lock()
            .expect("timeline store mutex poisoned")
            .read_forward(cursor, limit)
    }

    pub fn timeline_backward_page(
        &self,
        cursor: &str,
        limit: usize,
    ) -> Result<TimelineHistoryPage, TimelineStoreError> {
        self.inner
            .timeline_store
            .lock()
            .expect("timeline store mutex poisoned")
            .read_backward(cursor, limit)
    }

    pub fn timeline_tail_page(
        &self,
        limit: usize,
    ) -> Result<TimelineHistoryPage, TimelineStoreError> {
        self.inner
            .timeline_store
            .lock()
            .expect("timeline store mutex poisoned")
            .tail(limit)
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

    pub(crate) async fn wait_for_event_after(&self, seq: u64) {
        loop {
            let notified = self.inner.event_notify.notified();
            if self.current_event_cursor().seq() > seq {
                return;
            }
            notified.await;
        }
    }

    pub fn thread_id(&self) -> String {
        self.inner
            .config
            .session
            .clone()
            .unwrap_or_else(|| "thread_local".to_owned())
    }

    pub fn list_background_tasks(&self) -> Value {
        task_list_summary(self.inner.background_tasks.list_by_owner(&TaskOwner::Main))
    }

    pub fn get_background_task(&self, task_id: &str) -> Option<Value> {
        self.inner
            .background_tasks
            .get_by_owner(&TaskOwner::Main, task_id)
            .map(task_detail_summary)
    }

    pub fn cancel_background_task(&self, task_id: &str) -> Option<Value> {
        let snapshot = self
            .inner
            .background_tasks
            .cancel_by_owner(&TaskOwner::Main, task_id)?;
        if snapshot.state == TaskState::Cancelling {
            self.inner.append_task_updated_event(&snapshot);
        }
        Some(task_cancel_result_summary(&snapshot))
    }

    pub async fn shutdown(&self) -> ServiceStatus {
        let (turn_id, should_emit_abort) = {
            let _admission = self
                .inner
                .task_frame_admission_gate
                .lock()
                .expect("task frame admission gate mutex poisoned");
            let mut state = self
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            if state.state == ServiceState::ShuttingDown {
                (state.active_turn_id.clone(), false)
            } else {
                let active_cancel = state.active_cancel.clone();
                let turn_id = state.active_turn_id.clone();
                let should_emit_abort = active_cancel.is_some();
                if let Some(cancel) = active_cancel.as_ref() {
                    cancel.cancel();
                }
                state.state = ServiceState::ShuttingDown;
                state.last_error = None;
                self.inner
                    .append_service_status_for_locked(&mut state, turn_id.as_deref());
                (turn_id, should_emit_abort)
            }
        };

        if should_emit_abort {
            self.inner.append_event_for_turn_or_record_error(
                turn_id.as_deref(),
                "agent.abort_requested",
                json!({"reason": "service_shutdown"}),
            );
        }

        for snapshot in self.inner.background_tasks.cancel_all() {
            if snapshot.state == TaskState::Cancelling && snapshot.owner == TaskOwner::Main {
                self.inner.append_task_updated_event(&snapshot);
            }
        }
        for cancel in self
            .inner
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .values()
        {
            cancel.cancel();
        }
        self.inner.append_service_status_for_current_state(None);
        self.inner.notify.notify_waiters();
        self.wait_for_shutdown_quiescence().await;
        self.status()
    }

    async fn wait_for_shutdown_quiescence(&self) {
        let _ = tokio::time::timeout(SERVICE_SHUTDOWN_TASK_DRAIN_TIMEOUT, async {
            loop {
                if self.inner.shutdown_quiescent() {
                    return;
                }
                tokio::select! {
                    _ = self.inner.notify.notified() => {}
                    _ = tokio::time::sleep(SERVICE_SHUTDOWN_TASK_DRAIN_POLL) => {}
                }
            }
        })
        .await;
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
        self.enqueue_input(message_id, content, InputSource::User, urgency)
            .await
    }

    pub async fn enqueue_task_callback(
        &self,
        message_id: impl Into<String>,
        content: Vec<ContentPart>,
    ) -> Result<EnqueueOutcome, ServiceError> {
        self.enqueue_input(
            message_id,
            content,
            InputSource::TaskCallback,
            InputUrgency::Normal,
        )
        .await
    }

    pub fn reject_user_message(
        &self,
        message_id: &str,
        content: &[ContentPart],
        reason: &'static str,
        message: impl Into<String>,
        retryable: bool,
    ) -> Option<EventCursor> {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        let event = match try_append_input_rejected_event(
            self.inner.as_ref(),
            &state,
            InputRejection::new(
                message_id,
                content,
                InputSource::User,
                InputUrgency::Normal,
                reason,
                message,
                retryable,
            ),
        ) {
            Ok(event) => event,
            Err(error) => {
                drop(state);
                self.inner.record_timeline_persistence_error(error);
                return None;
            }
        };
        let turn_id = state.active_turn_id.clone();
        self.inner
            .append_service_status_for_locked(&mut state, turn_id.as_deref());
        self.inner.notify.notify_waiters();
        Some(timeline_cursor_for_event(self.inner.as_ref(), &event))
    }

    async fn enqueue_input(
        &self,
        message_id: impl Into<String>,
        content: Vec<ContentPart>,
        source: InputSource,
        urgency: InputUrgency,
    ) -> Result<EnqueueOutcome, ServiceError> {
        let EnqueueInputAttempt {
            outcome,
            start_cancel,
            preemption,
        } = enqueue_input_inner(
            self.inner.as_ref(),
            message_id.into(),
            content,
            source,
            urgency,
            None,
        )
        .await;
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
        let (status, start_cancel) = {
            let _intake = self.inner.intake_gate.lock().await;
            let mut state = self
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            start_pending_locked(&self.inner, &mut state)
        };

        if let Some(cancel) = start_cancel {
            self.spawn_loop(cancel);
        }
        self.inner.notify.notify_waiters();
        status
    }

    pub async fn wait_for_state(&self, desired: ServiceState) {
        loop {
            let notified = self.inner.notify.notified();
            if self.status().state == desired {
                return;
            }
            notified.await;
        }
    }

    fn spawn_loop(&self, cancel: CancellationToken) {
        spawn_service_loop(self.inner.clone(), cancel);
    }
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
        if self.skip_stale_task_requests_before_drain().await == StaleTaskRequestDrain::Blocked {
            return DrainBatch::new("batch_stale_task_request_tombstone_failed", Vec::new());
        }

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
        let (plan, result, turn_id, status_data) = {
            let state = self.state.lock().expect("service state mutex poisoned");
            let plan = state.input_queue.prepare_commit(batch_id)?;
            let result = state.input_queue.commit_result(&plan)?;
            let mut status_data = self.service_status_data_from_locked(&state);
            status_data["queue_length"] = json!(result.queue_length);
            (plan, result, state.active_turn_id.clone(), status_data)
        };

        self.try_append_event_for_turn(turn_id.as_deref(), "service.status", status_data)
            .map_err(|error| AgentCommitError::new(error.to_string()))?;

        let callback_delivery_events =
            self.prepare_callback_delivery_events(&result.callback_delivery_input_ids, cycle_id);
        for event in &callback_delivery_events {
            self.try_append_event_for_turn(None, event.event_type, event.data.clone())
                .map_err(|error| AgentCommitError::new(error.to_string()))?;
        }

        record_committed_user_batch(self.recorder.as_deref(), &plan).await?;

        {
            let mut state = self.state.lock().expect("service state mutex poisoned");
            let finished = state.input_queue.finish_commit(&plan)?;
            debug_assert!(result.queue_length >= commit.queue_length);
            debug_assert!(finished.queue_length >= result.queue_length);
        }

        for event in &callback_delivery_events {
            match event.target {
                CallbackDeliveryTarget::Task => {
                    let delivered = self
                        .background_tasks
                        .set_callback_delivered_by_input_id(&event.input_id)
                        .is_some();
                    debug_assert!(delivered);
                }
                CallbackDeliveryTarget::Subagent => {
                    let delivered = self
                        .subagents
                        .lock()
                        .expect("subagent manager mutex poisoned")
                        .mark_callback_delivered(&event.input_id)
                        .is_some();
                    debug_assert!(delivered);
                }
            }
        }

        self.notify.notify_waiters();
        retry_pending_task_callbacks_for_inner(self).await;
        Ok(())
    }

    async fn rollback(&self, batch_id: &str) {
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
    message
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

fn input_source_name(source: InputSource) -> &'static str {
    match source {
        InputSource::User => "user",
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

fn timeline_cursor_for_event(inner: &ServiceInner, event: &ServiceEvent) -> EventCursor {
    EventCursor::for_instance(
        inner
            .timeline_store
            .lock()
            .expect("timeline store mutex poisoned")
            .instance()
            .to_owned(),
        event.seq,
    )
    .expect("timeline store instance should be valid")
}

fn current_timeline_cursor(timeline_store: &Arc<Mutex<TimelineStore>>) -> EventCursor {
    let checkpoint = timeline_store
        .lock()
        .expect("timeline store mutex poisoned")
        .checkpoint();
    EventCursor::parse_timeline(&checkpoint.cursor)
        .expect("timeline store checkpoint should use a timeline cursor")
}

fn retained_timeline_cursor_for_seq(
    timeline_store: &Arc<Mutex<TimelineStore>>,
    timeline_instance: &str,
    seq: u64,
) -> Option<EventCursor> {
    let cursor = EventCursor::for_instance(timeline_instance.to_owned(), seq)
        .expect("timeline store instance should be valid");
    let cursor_text = cursor.to_string();
    timeline_store
        .lock()
        .expect("timeline store mutex poisoned")
        .read_forward(&cursor_text, 1)
        .is_ok()
        .then_some(cursor)
}

fn retained_timeline_cursor_for_durable_message(
    timeline_store: &Arc<Mutex<TimelineStore>>,
    timeline_instance: &str,
    replay_start_seq: u64,
    terminal_seq: u64,
) -> Option<EventCursor> {
    let cursor =
        retained_timeline_cursor_for_seq(timeline_store, timeline_instance, replay_start_seq)?;
    if terminal_seq > replay_start_seq
        && retained_timeline_cursor_for_seq(timeline_store, timeline_instance, terminal_seq)
            .is_none()
    {
        return None;
    }
    Some(cursor)
}

fn append_committed_service_event(
    timeline_store: &Arc<Mutex<TimelineStore>>,
    event_log: &Arc<Mutex<EventLog>>,
    session: Option<&str>,
    turn_id: Option<&str>,
    event_type: &str,
    data: Value,
) -> Result<ServiceEvent, TimelineStoreError> {
    let (envelope, provisional) = {
        let mut store = timeline_store
            .lock()
            .expect("timeline store mutex poisoned");
        let next_seq = store.checkpoint().seq.saturating_add(1);
        let provisional = ServiceEvent::new(next_seq, event_type, session, turn_id, data);
        project_timeline_event(&provisional, store.instance())
            .map_err(TimelineStoreError::Envelope)
            .and_then(|projected| {
                let append = TimelineAppend {
                    time: Some(provisional.time.clone()),
                    session_id: projected.session_id,
                    event_type: projected.event_type,
                    trace: projected.trace,
                    item: projected.item,
                    data: projected.data,
                };
                store.append(append).map(|envelope| (envelope, provisional))
            })?
    };
    debug_assert_eq!(envelope.seq, provisional.seq);
    let event = ServiceEvent {
        seq: envelope.seq,
        time: envelope.time,
        event_type: provisional.event_type,
        session: provisional.session,
        turn_id: provisional.turn_id,
        data: provisional.data,
    };
    event_log
        .lock()
        .expect("event log mutex poisoned")
        .append_committed(event.clone());
    Ok(event)
}

fn timeline_persistence_service_error(error: TimelineStoreError) -> ServiceError {
    ServiceError::Persistence {
        message: format!("timeline persistence failed: {error}"),
    }
}

fn insert_message_index_entry(
    message_index: &mut HashMap<String, MessageIndexEntry>,
    message_id: String,
    content: Vec<ContentPart>,
    cursor: EventCursor,
) {
    insert_message_index_entry_with_projection_state(
        message_index,
        message_id,
        content,
        cursor,
        MessageProjectionState::Live,
    );
}

fn insert_message_index_entry_with_projection_state(
    message_index: &mut HashMap<String, MessageIndexEntry>,
    message_id: String,
    content: Vec<ContentPart>,
    cursor: EventCursor,
    projection_state: MessageProjectionState,
) {
    message_index.insert(
        message_id,
        MessageIndexEntry {
            content,
            cursor,
            projection_state,
        },
    );
}

fn prune_message_index_to_retained_window(state: &mut ServiceInnerState) {
    let protected_ids = state.input_queue.protected_message_ids();
    let max_entries = DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW.saturating_add(protected_ids.len());
    let remove_count = state.message_index.len().saturating_sub(max_entries);
    if remove_count == 0 {
        return;
    }

    let mut candidates = state
        .message_index
        .iter()
        .filter(|(message_id, _)| !protected_ids.contains(*message_id))
        .map(|(message_id, entry)| {
            (
                message_id.clone(),
                entry.cursor.seq(),
                durable_sort_seq(
                    state
                        .durable_message_replays
                        .get(message_id)
                        .map(|replay| replay.terminal_seq),
                    entry.cursor.seq(),
                ),
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| (left.2, left.1, &left.0).cmp(&(right.2, right.1, &right.0)));

    for (message_id, _, _) in candidates.into_iter().take(remove_count) {
        state.message_index.remove(&message_id);
    }
}

fn prune_durable_message_replays_to_retained_window(state: &mut ServiceInnerState) {
    let remove_count = state
        .durable_message_replays
        .len()
        .saturating_sub(DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW);
    if remove_count == 0 {
        return;
    }

    let mut candidates = state
        .durable_message_replays
        .iter()
        .map(|(message_id, replay)| {
            (
                message_id.clone(),
                durable_sort_seq(Some(replay.terminal_seq), replay.replay_start_seq),
                replay.replay_start_seq,
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| (left.1, left.2, &left.0).cmp(&(right.1, right.2, &right.0)));

    for (message_id, _, _) in candidates.into_iter().take(remove_count) {
        state.durable_message_replays.remove(&message_id);
    }
}

fn durable_sort_seq(terminal_seq: Option<u64>, fallback_seq: u64) -> u64 {
    terminal_seq.unwrap_or(fallback_seq)
}

struct EnqueueInputAttempt {
    outcome: Result<EnqueueOutcome, ServiceError>,
    start_cancel: Option<CancellationToken>,
    preemption: Option<AcceptedInputPreemption>,
}

struct AcceptedTaskRequestFrameAdmission {
    request_id: String,
    message_id: String,
    content: Vec<ContentPart>,
    urgency: InputUrgency,
    metadata: QueuedInputMetadata,
    owner: TaskOwner,
}

#[derive(Debug, Clone)]
struct TaskTellSnapshot {
    task_id: String,
    tool_call_id: String,
    tool_name: String,
    arguments_summary: String,
    owner: TaskOwner,
    sender: String,
    tell_id: String,
    message: String,
    urgency: InputUrgency,
    state: &'static str,
    told_at: SystemTime,
    failure_reason: Option<String>,
}

struct AcceptedTaskTellFrameAdmission {
    snapshot: TaskTellSnapshot,
    message_id: String,
    content: Vec<ContentPart>,
    metadata: QueuedInputMetadata,
}

enum TaskRequestFrameAdmission {
    Accepted(AcceptedTaskRequestFrameAdmission),
    ApplyStdinIntents(Vec<TaskStdinIntent>),
    None,
}

enum TaskTellFrameAdmission {
    Accepted(AcceptedTaskTellFrameAdmission),
    Rejected(TaskTellSnapshot),
    None,
}

#[derive(Debug, Clone)]
struct AcceptedInputPreemption {
    cancel: CancellationToken,
    turn_id: Option<String>,
    input_id: String,
    source: InputSource,
    urgency: InputUrgency,
}

struct PreparedEnqueue {
    accepted: AcceptedInputEntry,
    submit_status: EnqueueSubmitStatus,
    turn_id: Option<String>,
    start_cancel: Option<CancellationToken>,
    planned_state: ServiceState,
    planned_queue_length: usize,
    summary: InputContentSummary,
    input_text: Option<String>,
    preemption: Option<AcceptedInputPreemption>,
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
        }
    }

    fn rejected(error: ServiceError, start_cancel: Option<CancellationToken>) -> Self {
        Self {
            outcome: Err(error),
            start_cancel,
            preemption: None,
        }
    }
}

fn enqueue_admission_locked(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
    message_id: &str,
    content: &[ContentPart],
    source: InputSource,
    urgency: InputUrgency,
) -> Option<EnqueueInputAttempt> {
    if let Some(entry) = state.message_index.get(message_id) {
        if entry.content == content {
            return Some(EnqueueInputAttempt::accepted(
                duplicate_outcome(inner, state, entry.cursor.clone()),
                None,
                None,
            ));
        }
        let message = format!("message id {message_id} was already used with different content");
        if let Err(error) = append_input_rejected_event(
            inner,
            state,
            InputRejection::new(
                message_id,
                content,
                source,
                urgency,
                "message_conflict",
                message,
                false,
            ),
        ) {
            return Some(EnqueueInputAttempt::rejected(error, None));
        }
        let turn_id = state.active_turn_id.clone();
        if let Err(error) = inner.try_append_service_status_for_locked(state, turn_id.as_deref()) {
            return Some(EnqueueInputAttempt::rejected(error, None));
        }
        return Some(EnqueueInputAttempt::rejected(
            ServiceError::MessageConflict {
                message_id: message_id.to_owned(),
            },
            None,
        ));
    }
    if state.state == ServiceState::ShuttingDown {
        return Some(reject_shutting_down_locked(
            inner, state, message_id, content, source, urgency,
        ));
    }
    if state.input_queue.len() >= inner.limits.max_queue_messages {
        return Some(reject_queue_full_locked(
            inner, state, message_id, content, source, urgency,
        ));
    }
    if state
        .input_queue
        .bytes_with_new_message_exceeds_limit(content, inner.limits.max_queue_bytes)
    {
        return Some(reject_queue_full_locked(
            inner, state, message_id, content, source, urgency,
        ));
    }
    None
}

async fn enqueue_input_inner(
    inner: &ServiceInner,
    message_id: String,
    content: Vec<ContentPart>,
    source: InputSource,
    urgency: InputUrgency,
    metadata: Option<QueuedInputMetadata>,
) -> EnqueueInputAttempt {
    let _intake = inner.intake_gate.lock().await;
    if content.is_empty() {
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        if let Err(error) = append_input_rejected_event(
            inner,
            &mut state,
            InputRejection::new(
                &message_id,
                &content,
                source,
                urgency,
                "empty_message",
                "message content must not be empty",
                false,
            ),
        ) {
            return EnqueueInputAttempt::rejected(error, None);
        }
        let turn_id = state.active_turn_id.clone();
        if let Err(error) =
            inner.try_append_service_status_for_locked(&mut state, turn_id.as_deref())
        {
            return EnqueueInputAttempt::rejected(error, None);
        }
        return EnqueueInputAttempt::rejected(ServiceError::EmptyMessage, None);
    }

    let cursor_seq = inner.last_event_seq();

    {
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        if let Some(attempt) =
            enqueue_admission_locked(inner, &mut state, &message_id, &content, source, urgency)
        {
            return attempt;
        }
    }

    let accepted = AcceptedInputEntry {
        message_id,
        content,
        cursor_seq,
        source,
        metadata,
        urgency,
    };

    if let Err(error) = record_non_session_accepted_input(inner, &accepted).await {
        return EnqueueInputAttempt::rejected(error, None);
    }

    let mut state = inner.state.lock().expect("service state mutex poisoned");
    match enqueue_admitted_locked(inner, &mut state, accepted) {
        Ok((outcome, start_cancel, preemption)) => {
            EnqueueInputAttempt::accepted(outcome, start_cancel, preemption)
        }
        Err(error) => {
            state.last_error = Some(error.to_string());
            EnqueueInputAttempt::rejected(error, None)
        }
    }
}

async fn enqueue_subagent_callback_input(
    inner: &ServiceInner,
    subagent_id: &str,
    callback_id: String,
    kind: &'static str,
    content: Vec<ContentPart>,
) -> Option<(SubagentSnapshot, String, Option<CancellationToken>)> {
    let _intake = inner.intake_gate.lock().await;
    let source = InputSource::SubagentCallback;
    let urgency = InputUrgency::Normal;
    if content.is_empty() {
        let outcome = {
            let mut state = inner.state.lock().expect("service state mutex poisoned");
            let append_error = append_input_rejected_event(
                inner,
                &mut state,
                InputRejection::new(
                    &callback_id,
                    &content,
                    source,
                    urgency,
                    "empty_message",
                    "message content must not be empty",
                    false,
                ),
            )
            .and_then(|_| {
                let turn_id = state.active_turn_id.clone();
                inner.try_append_service_status_for_locked(&mut state, turn_id.as_deref())
            })
            .err();
            SubagentCallbackOutcome {
                callback_id,
                kind,
                event_status: "failed",
                callback_status: SubagentCallbackStatus::Failed,
                failure_reason: Some(
                    append_error
                        .map(|error| error.to_string())
                        .unwrap_or_else(|| ServiceError::EmptyMessage.to_string()),
                ),
                start_cancel: None,
            }
        };
        return record_subagent_callback_outcome(inner, subagent_id, outcome);
    }

    let cursor_seq = inner.last_event_seq();
    let admission_outcome = {
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        enqueue_admission_locked(inner, &mut state, &callback_id, &content, source, urgency).map(
            |attempt| {
                let (event_status, callback_status, failure_reason) =
                    callback_status_for_enqueue_outcome(&attempt);
                SubagentCallbackOutcome {
                    callback_id: callback_id.clone(),
                    kind,
                    event_status,
                    callback_status,
                    failure_reason,
                    start_cancel: attempt.start_cancel,
                }
            },
        )
    };
    if let Some(outcome) = admission_outcome {
        return record_subagent_callback_outcome(inner, subagent_id, outcome);
    }

    let accepted = AcceptedInputEntry {
        message_id: callback_id.clone(),
        content,
        cursor_seq,
        source,
        metadata: Some(QueuedInputMetadata::SubagentCallback {
            subagent_id: subagent_id.to_owned(),
            callback_id: callback_id.clone(),
            kind: kind.to_owned(),
        }),
        urgency,
    };

    let accepted_was_recorded_before_enqueue =
        match record_non_session_accepted_input(inner, &accepted).await {
            Ok(recorded) => recorded,
            Err(error) => {
                return record_subagent_callback_outcome(
                    inner,
                    subagent_id,
                    SubagentCallbackOutcome {
                        callback_id,
                        kind,
                        event_status: "failed",
                        callback_status: SubagentCallbackStatus::Failed,
                        failure_reason: Some(error.to_string()),
                        start_cancel: None,
                    },
                );
            }
        };

    let accepted_for_tombstone = if accepted_was_recorded_before_enqueue {
        Some(accepted.clone())
    } else {
        None
    };

    #[cfg(test)]
    inner.run_subagent_test_hook(SubagentTestHookKind::CallbackEnqueueBeforeRecord);

    let queued = {
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
            let mut state = inner.state.lock().expect("service state mutex poisoned");
            let mut preemption_to_emit = None;
            let attempt = match enqueue_admitted_locked(inner, &mut state, accepted) {
                Ok((outcome, start_cancel, preemption)) => {
                    preemption_to_emit = preemption;
                    EnqueueInputAttempt::accepted(outcome, start_cancel, None)
                }
                Err(error) => {
                    state.last_error = Some(error.to_string());
                    EnqueueInputAttempt::rejected(error, None)
                }
            };
            drop(state);
            if let Some(preemption) = preemption_to_emit {
                emit_urgent_preemption(inner, preemption);
            }
            let (event_status, callback_status, failure_reason) =
                callback_status_for_enqueue_outcome(&attempt);
            record_subagent_callback_outcome_locked(
                inner,
                subagent_id,
                SubagentCallbackOutcome {
                    callback_id,
                    kind,
                    event_status,
                    callback_status,
                    failure_reason,
                    start_cancel: attempt.start_cancel,
                },
            )
        }
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
    queued
}

async fn record_non_session_accepted_input(
    inner: &ServiceInner,
    accepted: &AcceptedInputEntry,
) -> Result<bool, ServiceError> {
    if inner.session_recorder.is_some() {
        return Ok(false);
    }
    let Some(recorder) = inner.recorder.as_ref() else {
        return Ok(false);
    };
    recorder
        .record_accepted_input(accepted)
        .await
        .map_err(|error| ServiceError::Persistence {
            message: error.to_string(),
        })?;
    Ok(true)
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
    let mut state = inner.state.lock().expect("service state mutex poisoned");
    state.last_error = Some(format!(
        "failed to persist subagent callback pending removal: {error_message}"
    ));
    if state.state != ServiceState::ShuttingDown {
        state.state = ServiceState::Failed;
    }
    if let Some(cancel) = state.active_cancel.as_ref() {
        cancel.cancel();
    }
    let turn_id = state.active_turn_id.clone();
    inner.append_event_for_turn_or_mark_locked(
        &mut state,
        turn_id.as_deref(),
        "subagent.callback_pending_removal_failed",
        json!({
            "message_id": accepted.message_id,
            "input_id": accepted.message_id,
            "input_kind": input_kind_name(accepted.source),
            "source": input_source_name(accepted.source),
            "reason": reason,
            "error": {
                "code": "pending_removal_persistence_failed",
                "message": error_message,
                "retryable": true
            }
        }),
    );
    let turn_id = state.active_turn_id.clone();
    inner.append_service_status_for_locked(&mut state, turn_id.as_deref());
    inner.notify.notify_waiters();
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

fn reject_shutting_down_locked(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
    message_id: &str,
    content: &[ContentPart],
    source: InputSource,
    urgency: InputUrgency,
) -> EnqueueInputAttempt {
    let message = "service is shutting down";
    if let Err(error) = append_input_rejected_event(
        inner,
        state,
        InputRejection::new(
            message_id,
            content,
            source,
            urgency,
            "service_shutting_down",
            message,
            false,
        ),
    ) {
        return EnqueueInputAttempt::rejected(error, None);
    }
    let turn_id = state.active_turn_id.clone();
    if let Err(error) = inner.try_append_service_status_for_locked(state, turn_id.as_deref()) {
        return EnqueueInputAttempt::rejected(error, None);
    }
    EnqueueInputAttempt::rejected(ServiceError::ShuttingDown, None)
}

fn reject_queue_full_locked(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
    message_id: &str,
    content: &[ContentPart],
    source: InputSource,
    urgency: InputUrgency,
) -> EnqueueInputAttempt {
    let message = "message queue is full";
    let failed_with_pending = state.state == ServiceState::Failed
        && (!state.input_queue.is_empty() || state.restart_boundary.is_some());
    if let Err(error) = append_input_rejected_event(
        inner,
        state,
        InputRejection::new(
            message_id,
            content,
            source,
            urgency,
            "queue_full",
            message,
            true,
        ),
    ) {
        return EnqueueInputAttempt::rejected(error, None);
    }
    if let Err(error) = append_queue_pressure_event(inner, state, message) {
        return EnqueueInputAttempt::rejected(error, None);
    }

    let start_cancel = if failed_with_pending {
        let (_status, start_cancel) = start_pending_locked(inner, state);
        start_cancel
    } else {
        let turn_id = state.active_turn_id.clone();
        if let Err(error) = inner.try_append_service_status_for_locked(state, turn_id.as_deref()) {
            return EnqueueInputAttempt::rejected(error, None);
        }
        None
    };

    EnqueueInputAttempt::rejected(ServiceError::QueueFull, start_cancel)
}

struct InputRejection<'a> {
    message_id: &'a str,
    content: &'a [ContentPart],
    source: InputSource,
    urgency: InputUrgency,
    reason: &'static str,
    message: String,
    retryable: bool,
}

impl<'a> InputRejection<'a> {
    fn new(
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
        }
    }
}

fn append_input_rejected_event(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
    rejection: InputRejection<'_>,
) -> Result<ServiceEvent, ServiceError> {
    let summary = summarize_input_content(rejection.content);
    let queue_length = state.input_queue.len();
    let turn_id = state.active_turn_id.clone();
    inner.try_append_event_for_turn_or_mark_locked(
        state,
        turn_id.as_deref(),
        "message.rejected",
        json!({
            "message_id": rejection.message_id,
            "input_id": rejection.message_id,
            "input_kind": input_kind_name(rejection.source),
            "source": input_source_name(rejection.source),
            "urgency": rejection.urgency.as_str(),
            "content_preview": summary.content_preview,
            "content_bytes": summary.content_bytes,
            "content_truncated": summary.content_truncated,
            "content_kind": summary.content_kind,
            "queue_length": queue_length,
            "reason": rejection.reason,
            "error": {
                "code": rejection.reason,
                "message": rejection.message,
                "retryable": rejection.retryable
            }
        }),
    )
}

fn try_append_input_rejected_event(
    inner: &ServiceInner,
    state: &ServiceInnerState,
    rejection: InputRejection<'_>,
) -> Result<ServiceEvent, TimelineStoreError> {
    let summary = summarize_input_content(rejection.content);
    inner.try_append_event_for_turn(
        state.active_turn_id.as_deref(),
        "message.rejected",
        json!({
            "message_id": rejection.message_id,
            "input_id": rejection.message_id,
            "input_kind": input_kind_name(rejection.source),
            "source": input_source_name(rejection.source),
            "urgency": rejection.urgency.as_str(),
            "content_preview": summary.content_preview,
            "content_bytes": summary.content_bytes,
            "content_truncated": summary.content_truncated,
            "content_kind": summary.content_kind,
            "queue_length": state.input_queue.len(),
            "reason": rejection.reason,
            "error": {
                "code": rejection.reason,
                "message": rejection.message,
                "retryable": rejection.retryable
            }
        }),
    )
}

fn append_queue_pressure_event(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
    message: &str,
) -> Result<ServiceEvent, ServiceError> {
    let queue_length = state.input_queue.len();
    let turn_id = state.active_turn_id.clone();
    inner.try_append_event_for_turn_or_mark_locked(
        state,
        turn_id.as_deref(),
        "queue.pressure",
        json!({
            "queue_length": queue_length,
            "max_queue_messages": inner.limits.max_queue_messages,
            "max_queue_bytes": inner.limits.max_queue_bytes,
            "input_rejected": true,
            "error": {
                "code": "queue_full",
                "message": message,
                "retryable": true
            }
        }),
    )
}

fn start_turn(state: &mut ServiceInnerState) -> String {
    let turn_id = format!("turn_{}", state.next_turn_number);
    state.next_turn_number += 1;
    state.active_turn_id = Some(turn_id.clone());
    turn_id
}

fn clear_active_turn(state: &mut ServiceInnerState) {
    state.active_turn_id = None;
}

fn start_followup_turn(state: &mut ServiceInnerState) -> CancellationToken {
    let cancel = CancellationToken::new();
    start_turn(state);
    state.state = ServiceState::Running;
    state.active_cancel = Some(cancel.clone());
    cancel
}

fn enqueue_locked(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
    accepted: AcceptedInputEntry,
) -> Result<
    (
        EnqueueOutcome,
        Option<CancellationToken>,
        Option<AcceptedInputPreemption>,
    ),
    ServiceError,
> {
    let prepared = prepare_enqueue_locked(inner, state, accepted)?;
    let published = publish_prepared_enqueue_timeline(inner, state, &prepared)?;
    finalize_prepared_enqueue_locked(inner, state, prepared, published)
}

fn enqueue_admitted_locked(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
    accepted: AcceptedInputEntry,
) -> Result<
    (
        EnqueueOutcome,
        Option<CancellationToken>,
        Option<AcceptedInputPreemption>,
    ),
    ServiceError,
> {
    if inner.session_recorder.is_some() {
        enqueue_locked_with_session_record(inner, state, accepted)
    } else {
        enqueue_locked(inner, state, accepted)
    }
}

fn enqueue_locked_with_session_record(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
    accepted: AcceptedInputEntry,
) -> Result<
    (
        EnqueueOutcome,
        Option<CancellationToken>,
        Option<AcceptedInputPreemption>,
    ),
    ServiceError,
> {
    let prepared = prepare_enqueue_locked(inner, state, accepted)?;
    let accepted_undo = inner
        .session_recorder
        .as_ref()
        .map(|recorder| {
            recorder
                .record_accepted_input_with_undo_sync(&prepared.accepted)
                .map_err(|error| ServiceError::Persistence {
                    message: error.to_string(),
                })
        })
        .transpose()?;
    let published = match publish_prepared_enqueue_timeline(inner, state, &prepared) {
        Ok(published) => published,
        Err(error) => {
            if let Some(undo) = accepted_undo {
                if let Err(rollback) = undo.rollback() {
                    return Err(ServiceError::Persistence {
                        message: format!(
                            "timeline persistence failed: {error}; session accepted rollback failed: {rollback}"
                        ),
                    });
                }
            }
            return Err(error);
        }
    };
    if let Some(undo) = accepted_undo {
        undo.commit();
    }
    finalize_prepared_enqueue_locked(inner, state, prepared, published)
}

fn prepare_enqueue_locked(
    _inner: &ServiceInner,
    state: &ServiceInnerState,
    accepted: AcceptedInputEntry,
) -> Result<PreparedEnqueue, ServiceError> {
    let AcceptedInputEntry {
        ref message_id,
        ref content,
        source,
        urgency,
        ..
    } = accepted;
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
            if urgency == InputUrgency::Urgent {
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
            let turn_id = state.active_turn_id.clone();
            (
                EnqueueSubmitStatus::Queued,
                turn_id,
                None,
                ServiceState::ShuttingDown,
            )
        }
    };

    let input_text = text_only_input_content(content).map(str::to_owned);

    Ok(PreparedEnqueue {
        accepted,
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
    state: &ServiceInnerState,
    prepared: &PreparedEnqueue,
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
                "source": input_source_name(source),
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
                    "source": input_source_name(source),
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
                state.last_error.clone(),
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
    let PreparedEnqueue {
        accepted,
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
    state.input_queue.enqueue(QueuedMessage {
        id: message_id.clone(),
        content: content.clone(),
        source,
        urgency,
        metadata,
        cursor_seq,
    });
    insert_message_index_entry(
        &mut state.message_index,
        message_id.clone(),
        content,
        accepted_cursor.clone(),
    );
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

fn emit_urgent_preemption(inner: &ServiceInner, preemption: AcceptedInputPreemption) {
    preemption.cancel.cancel();
    inner.append_event_for_turn_or_record_error(
        preemption.turn_id.as_deref(),
        "agent.abort_requested",
        json!({
            "reason": "urgent_input",
            "input_id": &preemption.input_id,
            "message_id": &preemption.input_id,
            "input_kind": input_kind_name(preemption.source),
            "source": input_source_name(preemption.source),
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

fn start_pending_locked(
    inner: &ServiceInner,
    state: &mut ServiceInnerState,
) -> (ServiceStatus, Option<CancellationToken>) {
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

    if start_cancel.is_some() {
        let turn_id = state.active_turn_id.clone();
        if let Err(error) = inner.try_append_event_for_turn(
            turn_id.as_deref(),
            "service.status",
            inner.service_status_data_from_locked(state),
        ) {
            state.last_error = Some(format!("timeline persistence failed: {error}"));
            state.state = ServiceState::Failed;
            state.active_cancel = None;
            clear_active_turn(state);
            return (inner.status_from_locked(state), None);
        }
    }

    (inner.status_from_locked(state), start_cancel)
}

impl ServiceInner {
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
        if state.state == ServiceState::ShuttingDown && !kind.can_start_during_shutdown() {
            return None;
        }
        state.service_workers.register(kind);
        Some(ServiceWorkerGuard {
            inner: Arc::downgrade(self),
            kind,
        })
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

    #[cfg(test)]
    fn set_task_frame_admission_hook_for_test(
        &self,
        hook: Option<Arc<dyn Fn(TaskFrameAdmissionKind) + Send + Sync>>,
    ) {
        self.task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned")
            .hook = hook;
    }

    async fn skip_stale_task_requests_before_drain(&self) -> StaleTaskRequestDrain {
        let stale = self
            .queued_task_request_candidates()
            .into_iter()
            .filter_map(|candidate| self.stale_task_request(candidate))
            .collect::<Vec<_>>();
        if stale.is_empty() {
            return StaleTaskRequestDrain::Complete;
        }

        for request in stale {
            if let Err(error) = self.record_stale_task_request_tombstone(&request).await {
                self.append_stale_task_request_skip_failed(&request, error);
                self.notify.notify_waiters();
                return StaleTaskRequestDrain::Blocked;
            }
            self.remove_stale_task_request_from_queue(&request);
        }

        if self.input_queue_is_empty() {
            retry_pending_task_callbacks_for_inner(self).await;
        }
        self.notify.notify_waiters();
        StaleTaskRequestDrain::Complete
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
        self.append_event_for_turn_or_mark_locked(
            &mut state,
            turn_id.as_deref(),
            "task_ask.stale_skipped",
            json!({
                "message_id": request.candidate.message_id,
                "input_id": request.candidate.message_id,
                "input_kind": input_kind_name(request.candidate.source),
                "source": input_source_name(request.candidate.source),
                "task_id": request.candidate.task_id,
                "ask_id": request.candidate.request_id,
                "state": request_state,
                "status": request_state,
                "reason": request.reason,
                "queue_length": queue_length
            }),
        );
        let turn_id = state.active_turn_id.clone();
        self.append_service_status_for_locked(&mut state, turn_id.as_deref());
    }

    fn append_stale_task_request_skip_failed(
        &self,
        request: &StaleTaskRequest,
        error: AgentCommitError,
    ) {
        let error_message = error.to_string();
        let queue_length = {
            let mut state = self.state.lock().expect("service state mutex poisoned");
            state.last_error = Some(format!(
                "failed to persist stale task ask tombstone: {error_message}"
            ));
            if state.state != ServiceState::ShuttingDown {
                state.state = ServiceState::Failed;
            }
            state.input_queue.len()
        };
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
                "source": input_source_name(request.candidate.source),
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

    fn mark_failed(&self, message: impl Into<String>) {
        let cancel = {
            let mut state = self.state.lock().expect("service state mutex poisoned");
            state.last_error = Some(message.into());
            if state.state == ServiceState::ShuttingDown {
                None
            } else {
                state.state = ServiceState::Failed;
                state.active_cancel.clone()
            }
        };
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        self.cancel_active_turn_if_failed();
        self.notify.notify_waiters();
    }

    fn timeline_bootstrap_snapshot(&self) -> Value {
        let state = self.state.lock().expect("service state mutex poisoned");
        let (timeline_cursor, timeline_seq, retention, timeline_active_items) =
            self.retained_timeline_position_and_active_items();
        let tasks = self.timeline_task_summary();
        let active_items_omitted = self.active_items_omitted_summary();
        let queue_length = state.input_queue.len();
        let service_state = service_state_name(state.state);
        let service_status_data = self.service_status_data_from_locked(&state);
        let providers = self.provider_summaries_json();
        let mut active_items = vec![
            json!({
                "id": "service",
                "type": "service_status",
                "status": service_state,
                "data": service_status_data
            }),
            json!({
                "id": "queue",
                "type": "queue_state",
                "status": "ready",
                "data": {
                    "queue_length": queue_length
                }
            }),
        ];
        active_items.extend(
            timeline_active_items
                .into_iter()
                .filter(|item| item["type"] != "subagent"),
        );

        for (index, queued) in state.input_queue.iter().enumerate() {
            let summary = summarize_input_content(&queued.content);
            active_items.push(json!({
                "id": input_item_id(&queued.id),
                "type": "input",
                "status": "queued",
                "data": {
                    "input_id": &queued.id,
                    "input_kind": input_kind_name(queued.source),
                    "source": input_source_name(queued.source),
                    "urgency": queued.urgency.as_str(),
                    "message_id": &queued.id,
                    "content_preview": summary.content_preview,
                    "content_bytes": summary.content_bytes,
                    "content_truncated": summary.content_truncated,
                    "content_kind": summary.content_kind,
                    "queue_position": index + 1
                }
            }));
        }

        for task in self
            .background_tasks
            .list_by_owner(&TaskOwner::Main)
            .into_iter()
            .filter(task_requires_active_item)
        {
            active_items.push(json!({
                "id": format!("task_{}", task.task_id),
                "type": "background_task",
                "status": active_task_status(&task),
                "data": task_event_data(&task)
            }));
        }

        for request in self
            .background_tasks
            .list_by_owner(&TaskOwner::Main)
            .into_iter()
            .flat_map(|task| task.requests)
            .filter(|request| request.state == TaskRequestState::Pending)
        {
            active_items.push(json!({
                "id": task_request_item_id(&request.task_id, &request.request_id),
                "type": "task_ask",
                "status": "pending",
                "data": task_request_event_data(&request)
            }));
        }

        for subagent in self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .list()
            .into_iter()
            .filter(|snapshot| {
                snapshot.lifecycle == SubagentLifecycle::Open
                    || snapshot.run_state == SubagentRunState::Running
                    || !snapshot.queued_messages.is_empty()
            })
        {
            active_items.push(json!({
                "id": format!("subagent_{}", subagent.id),
                "type": "subagent",
                "status": subagent_active_item_status(&subagent),
                "data": subagent_public_summary(&subagent)
            }));
        }

        json!({
            "session_id": self.config.session.clone().unwrap_or_else(|| "thread_local".to_owned()),
            "state": service_state,
            "queue_length": queue_length,
            "timeline_cursor": timeline_cursor.to_string(),
            "timeline_seq": timeline_seq,
            "timeline": {
                "endpoint": "/v1/timeline",
                "version": TIMELINE_VERSION,
                "retention": {
                    "kind": "durable_file",
                    "retention_days": retention.retention_days,
                    "hot_event_capacity": retention.hot_event_capacity,
                    "earliest_seq": retention.earliest_seq,
                    "earliest_cursor": retention.earliest_cursor,
                    "latest_seq": retention.latest_seq,
                    "latest_cursor": retention.latest_cursor
                },
                "capabilities": {
                    "timeline_live_follow": true,
                    "durable_timeline_read": true,
                    "history_pagination": true,
                    "incremental_output": true
                }
            },
            "providers": providers,
            "tasks": tasks,
            "registry": self.registry_bootstrap_summary(),
            "internal_diagnostics": {
                "stdio": self.stdio_diagnostics_summary()
            },
            "active_items": active_items,
            "active_items_omitted": active_items_omitted,
            "last_error": state.last_error.clone()
        })
    }

    fn stdio_diagnostics_summary(&self) -> Value {
        self.stdio_diagnostics
            .lock()
            .expect("stdio diagnostics mutex poisoned")
            .to_json()
    }

    fn registry_bootstrap_summary(&self) -> Value {
        let Some(store) = self.registry_store.as_ref() else {
            return json!({
                "enabled": false,
                "capabilities": Self::registry_capabilities(false)
            });
        };
        let config = store.config().clone();
        let options = *store.options();
        let current = store
            .get(RegistryQuery::new("**").with_limit(config.max_query_limit))
            .ok();
        let topics = store
            .topics(RegistryQuery::new("**").with_limit(config.max_query_limit))
            .ok();
        let history = store
            .history(
                RegistryQuery::history("**", config.retention.as_secs_f64())
                    .with_limit(config.max_query_limit),
            )
            .ok();
        let stats = store.stats();
        let latest_seq = history
            .as_ref()
            .and_then(|history| history.newest_seq)
            .or_else(|| {
                topics
                    .as_ref()
                    .and_then(|topics| topics.items.iter().map(|topic| topic.latest_seq).max())
            })
            .unwrap_or(0);

        json!({
            "endpoint": "/v1/registry/ws",
            "current_endpoint": "/v1/registry/current",
            "history_endpoint": "/v1/registry/history",
            "topics_endpoint": "/v1/registry/topics",
            "enabled": true,
            "instance_id": store.instance_id(),
            "started_at": system_time_rfc3339(store.started_at()),
            "retention_secs": config.retention.as_secs_f64(),
            "default_ttl_secs": config.default_ttl.as_secs_f64(),
            "max_topics": config.max_topics,
            "max_value_bytes": config.max_value_bytes,
            "max_query_limit": config.max_query_limit,
            "max_response_bytes": config.max_response_bytes,
            "websocket_max_frame_bytes": options.websocket_max_frame_bytes,
            "current_topics": topics.as_ref().map(|topics| topics.matched_count).unwrap_or(0),
            "active_current_topics": current.as_ref().map(|current| current.matched_count).unwrap_or(0),
            "history_items": history.as_ref().map(|history| history.matched_count).unwrap_or(0),
            "history_bytes": stats.history_bytes,
            "pruned_history_items_total": stats.pruned_history_items_total,
            "rejected_writes_total": stats.rejected_writes_total,
            "latest_seq": latest_seq,
            "capabilities": Self::registry_capabilities(true)
        })
    }

    fn registry_capabilities(enabled: bool) -> Value {
        json!({
            "set": enabled,
            "get": enabled,
            "history": enabled,
            "topics": enabled,
            "wildcard": enabled,
            "http_read": enabled,
            "subscribe": false
        })
    }

    fn provider_summaries_json(&self) -> Value {
        let providers = self
            .provider_summaries
            .lock()
            .expect("provider summaries mutex poisoned");
        Value::Array(
            providers
                .iter()
                .filter_map(ProviderMetadata::sanitized)
                .map(|provider| json!(provider))
                .collect(),
        )
    }

    fn retained_timeline_position_and_active_items(
        &self,
    ) -> (
        EventCursor,
        u64,
        crate::timeline_store::TimelineRetentionSnapshot,
        Vec<Value>,
    ) {
        let (checkpoint, retention) = {
            let store = self
                .timeline_store
                .lock()
                .expect("timeline store mutex poisoned");
            (store.checkpoint(), store.retention())
        };
        let log = self.event_log.lock().expect("event log mutex poisoned");
        let active_items = log.active_timeline_items();
        let cursor = EventCursor::parse_timeline(&checkpoint.cursor)
            .expect("timeline checkpoint cursor should parse");
        (cursor, checkpoint.seq, retention, active_items)
    }

    fn timeline_task_summary(&self) -> Value {
        let tasks = self.background_tasks.list_by_owner(&TaskOwner::Main);
        let running = tasks
            .iter()
            .filter(|task| task.state == TaskState::Running)
            .count();
        let cancelling = tasks
            .iter()
            .filter(|task| task.state == TaskState::Cancelling)
            .count();
        let pending_callbacks = tasks
            .iter()
            .filter(|task| {
                matches!(
                    task.callback_delivery,
                    CallbackDelivery::Pending | CallbackDelivery::Enqueued
                )
            })
            .count();
        let pending_asks = tasks
            .iter()
            .flat_map(|task| task.requests.iter())
            .filter(|request| request.state == TaskRequestState::Pending)
            .count();

        json!({
            "running": running,
            "cancelling": cancelling,
            "pending_callbacks": pending_callbacks,
            "pending_asks": pending_asks
        })
    }

    fn active_items_omitted_summary(&self) -> Value {
        let omitted_background_tasks = self
            .background_tasks
            .list_by_owner(&TaskOwner::Main)
            .into_iter()
            .filter(|task| task.state.is_terminal() && !task_requires_active_item(task))
            .count();

        if omitted_background_tasks == 0 {
            json!({
                "omitted_count": 0,
                "by_type": {}
            })
        } else {
            json!({
                "omitted_count": omitted_background_tasks,
                "by_type": {
                    "background_task": omitted_background_tasks
                }
            })
        }
    }

    fn status(&self) -> ServiceStatus {
        let state = self.state.lock().expect("service state mutex poisoned");
        self.status_from_locked(&state)
    }

    fn record_timeline_persistence_error(&self, error: TimelineStoreError) {
        {
            let mut state = self.state.lock().expect("service state mutex poisoned");
            let _ = self.record_timeline_persistence_error_for_locked(&mut state, error);
        }
        self.cancel_active_turn_if_failed();
    }

    fn record_timeline_persistence_error_for_locked(
        &self,
        state: &mut ServiceInnerState,
        error: TimelineStoreError,
    ) -> ServiceError {
        let message = format!("timeline persistence failed: {error}");
        state.last_error = Some(message.clone());
        if state.state != ServiceState::ShuttingDown {
            state.state = ServiceState::Failed;
        }
        if let Some(cancel) = state.active_cancel.as_ref() {
            cancel.cancel();
        }
        self.notify.notify_waiters();
        ServiceError::Persistence { message }
    }

    fn event_window_after_cursor(
        &self,
        cursor: EventCursor,
    ) -> Result<EventReadWindow, EventReadError> {
        self.event_log
            .lock()
            .expect("event log mutex poisoned")
            .read_window_after_cursor(cursor)
    }

    fn status_from_locked(&self, state: &ServiceInnerState) -> ServiceStatus {
        debug_assert_shutdown_cancel_visible(state);
        ServiceStatus {
            state: state.state,
            queue_length: state.input_queue.len(),
            last_event_seq: self.last_event_seq(),
            session: self.config.session.clone(),
            last_error: state.last_error.clone(),
        }
    }

    fn service_status_data_from_locked(&self, state: &ServiceInnerState) -> Value {
        debug_assert_shutdown_cancel_visible(state);
        self.service_status_data(
            state.state,
            state.input_queue.len(),
            state.last_error.clone(),
        )
    }

    fn service_status_data(
        &self,
        state: ServiceState,
        queue_length: usize,
        last_error: Option<String>,
    ) -> Value {
        json!({
            "state": service_state_name(state),
            "queue_length": queue_length,
            "tasks": self.timeline_task_summary(),
            "last_error": last_error
        })
    }

    fn append_service_status_for_locked(
        &self,
        state: &mut ServiceInnerState,
        turn_id: Option<&str>,
    ) -> Option<ServiceEvent> {
        self.try_append_service_status_for_locked(state, turn_id)
            .ok()
    }

    fn try_append_service_status_for_locked(
        &self,
        state: &mut ServiceInnerState,
        turn_id: Option<&str>,
    ) -> Result<ServiceEvent, ServiceError> {
        let data = self.service_status_data_from_locked(state);
        self.try_append_event_for_turn_or_mark_locked(state, turn_id, "service.status", data)
    }

    fn append_service_status_for_current_state(
        &self,
        turn_id: Option<&str>,
    ) -> Option<ServiceEvent> {
        let mut state = self.state.lock().expect("service state mutex poisoned");
        self.append_service_status_for_locked(&mut state, turn_id)
    }

    fn append_task_updated_event(&self, snapshot: &TaskSnapshot) {
        self.append_event_for_turn_or_record_error(None, "task.updated", task_event_data(snapshot));
        self.append_service_status_for_current_state(None);
    }

    fn prepare_callback_delivery_events(
        &self,
        input_ids: &[String],
        cycle_id: Option<&str>,
    ) -> Vec<PreparedCallbackDeliveryEvent> {
        let mut events = Vec::new();
        for input_id in input_ids {
            if let Some(snapshot) = self
                .background_tasks
                .callback_delivered_snapshot_by_input_id(input_id)
            {
                events.push(PreparedCallbackDeliveryEvent {
                    input_id: input_id.clone(),
                    target: CallbackDeliveryTarget::Task,
                    event_type: "task.callback_delivered",
                    data: task_event_data_with_cycle(&snapshot, cycle_id),
                });
            }
            let delivered_subagent_callback = {
                self.subagents
                    .lock()
                    .expect("subagent manager mutex poisoned")
                    .callback_delivered_snapshot(input_id)
            };
            if let Some(snapshot) = delivered_subagent_callback {
                let mut data = subagent_event_data(&snapshot);
                data["callback_id"] = json!(input_id);
                data["callback_status"] = json!("delivered");
                events.push(PreparedCallbackDeliveryEvent {
                    input_id: input_id.clone(),
                    target: CallbackDeliveryTarget::Subagent,
                    event_type: "subagent.callback_delivered",
                    data,
                });
            }
        }
        events
    }

    fn append_subagent_event_outcome(
        &self,
        event_type: &'static str,
        snapshot: &SubagentSnapshot,
    ) -> SubagentEventAppendOutcome {
        #[cfg(test)]
        {
            assert!(
                self.subagents.try_lock().is_ok(),
                "subagent events must be appended after releasing the subagent manager lock"
            );
        }
        let event_written = self
            .append_event_for_turn_or_record_error(None, event_type, subagent_event_data(snapshot))
            .is_some();
        let status_written = self.append_service_status_for_current_state(None).is_some();
        SubagentEventAppendOutcome {
            event_written,
            status_written,
        }
    }

    fn append_subagent_event(&self, event_type: &'static str, snapshot: &SubagentSnapshot) -> bool {
        self.append_subagent_event_outcome(event_type, snapshot)
            .complete()
    }

    fn append_subagent_task_failed_event(
        &self,
        snapshot: &SubagentSnapshot,
        task: &TaskSnapshot,
        reason: &str,
    ) -> bool {
        let mut data = subagent_event_data(snapshot);
        data["task_id"] = json!(task.task_id);
        data["task_status"] = json!(task_state_name(task.state));
        data["task_failure_reason"] = json!(reason);
        let event_written = self
            .append_event_for_turn_or_record_error(None, "subagent.task_failed", data)
            .is_some();
        let status_written = self.append_service_status_for_current_state(None).is_some();
        event_written && status_written
    }

    fn subagent_snapshot(&self, subagent_id: &str) -> Option<SubagentSnapshot> {
        self.subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(subagent_id)
    }

    fn open_subagent_snapshot(&self, subagent_id: &str) -> Option<SubagentSnapshot> {
        self.subagent_snapshot(subagent_id).and_then(|snapshot| {
            (snapshot.lifecycle != SubagentLifecycle::Cancelled).then_some(snapshot)
        })
    }

    fn append_subagent_event_for_id(&self, event_type: &'static str, subagent_id: &str) -> bool {
        let Some(snapshot) = self.subagent_snapshot(subagent_id) else {
            return false;
        };
        self.append_subagent_event(event_type, &snapshot)
    }

    fn append_subagent_event_if_current_open(
        &self,
        event_type: &'static str,
        snapshot: &SubagentSnapshot,
    ) -> Option<SubagentSnapshot> {
        self.append_subagent_event_outcome_if_current_open(event_type, snapshot)
            .and_then(|(snapshot, outcome)| outcome.complete().then_some(snapshot))
    }

    fn append_subagent_event_outcome_if_current_open(
        &self,
        event_type: &'static str,
        snapshot: &SubagentSnapshot,
    ) -> Option<(SubagentSnapshot, SubagentEventAppendOutcome)> {
        let _lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let current = self.open_subagent_snapshot(&snapshot.id)?;
        let outcome = self.append_subagent_event_outcome(event_type, &current);
        Some((current, outcome))
    }

    fn append_subagent_callback_event_if_current_open(
        &self,
        snapshot: &SubagentSnapshot,
        callback_id: &str,
        kind: &'static str,
        status: &str,
    ) -> bool {
        let _lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let Some(current) = self.open_subagent_snapshot(&snapshot.id) else {
            return false;
        };
        let mut data = subagent_event_data(&current);
        data["callback_id"] = json!(callback_id);
        data["callback_kind"] = json!(kind);
        data["callback_status"] = json!(status);
        let event_written = self
            .append_event_for_turn_or_record_error(None, "subagent.callback", data)
            .is_some();
        let status_written = self.append_service_status_for_current_state(None).is_some();
        event_written && status_written
    }

    fn spawn_subagent_tool_result(
        self: &Arc<Self>,
        call: ToolCall,
        task: &str,
        name_hint: &str,
        inherit_context: bool,
        model_alias: Option<&str>,
        provider_transcript_snapshot: Option<Vec<Message>>,
    ) -> ToolResult {
        if !self.subagent_options.enabled_flag() {
            return ToolResult::error(
                call.id,
                call.name,
                "subagents are disabled",
                json!({"kind": "subagents_disabled"}),
            );
        }
        let provider = match model_alias {
            Some(alias) => match self.subagent_options.provider_for_alias(alias) {
                Some(provider) => provider,
                None => {
                    return ToolResult::error(
                        call.id,
                        call.name,
                        format!("unknown model_alias: {alias}"),
                        json!({"kind": "unknown_model_alias", "model_alias": alias}),
                    );
                }
            },
            None => self.provider.clone(),
        };
        let initial_messages = self.initial_subagent_messages(
            task,
            inherit_context,
            provider_transcript_snapshot,
            &call.id,
        );
        let prepared =
            match self.prepare_spawned_subagent_run(name_hint, task, initial_messages, provider) {
                Ok(prepared) => prepared,
                Err(error) => return subagent_manager_error_tool_result(call, error),
            };
        let snapshot = prepared.snapshot.clone();
        let append = self.append_subagent_event_outcome("subagent.started", &snapshot);
        if !append.complete() {
            self.cancel_prepared_subagent_spawn_after_start_persistence_failure(
                prepared,
                append.event_written,
            );
            return subagent_start_persistence_error_tool_result(call, &snapshot);
        }
        self.spawn_prepared_subagent_run(prepared);

        let details = json!({
            "subagent_id": snapshot.id,
            "name": snapshot.name,
            "status": "started",
            "callback_pending": true,
            "error": Value::Null
        });
        subagent_tool_success_result(call, details)
    }

    fn send_subagent_tool_result(
        self: &Arc<Self>,
        call: ToolCall,
        subagent_id: &str,
        message: &str,
    ) -> ToolResult {
        let mut prepared_run = None;
        let (snapshot, should_start) = {
            let _lifecycle = self
                .subagent_lifecycle
                .lock()
                .expect("subagent lifecycle mutex poisoned");
            let mut manager = self
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            let Some(current) = manager.snapshot(subagent_id) else {
                return subagent_manager_error_tool_result(
                    call,
                    SubagentManagerError::NotFound {
                        id: subagent_id.to_owned(),
                    },
                );
            };
            if current.lifecycle == SubagentLifecycle::Cancelled {
                return subagent_manager_error_tool_result(
                    call,
                    SubagentManagerError::Cancelled {
                        id: subagent_id.to_owned(),
                    },
                );
            }
            let was_running = current.run_state == SubagentRunState::Running;
            let mut contexts = self
                .subagent_contexts
                .lock()
                .expect("subagent contexts mutex poisoned");
            let provider = if was_running {
                None
            } else {
                let Some(provider) = self
                    .subagent_providers
                    .lock()
                    .expect("subagent providers mutex poisoned")
                    .get(subagent_id)
                    .cloned()
                else {
                    return ToolResult::error(
                        call.id,
                        call.name,
                        format!("subagent provider missing: {subagent_id}"),
                        json!({"kind": "subagent_provider_missing", "subagent_id": subagent_id}),
                    );
                };
                Some(provider)
            };
            match manager.send(subagent_id, message) {
                Ok(snapshot) => {
                    if let Some(provider) = provider {
                        let messages =
                            push_subagent_user_message_locked(&mut contexts, subagent_id, message);
                        let cancel = CancellationToken::new();
                        self.subagent_cancels
                            .lock()
                            .expect("subagent cancels mutex poisoned")
                            .insert(subagent_id.to_owned(), cancel.clone());
                        prepared_run = Some(PreparedSubagentRun {
                            subagent_id: subagent_id.to_owned(),
                            snapshot: snapshot.clone(),
                            messages,
                            provider,
                            cancel,
                        });
                    }
                    (snapshot, !was_running)
                }
                Err(error) => return subagent_manager_error_tool_result(call, error),
            }
        };
        if let Some(prepared) = prepared_run {
            let append = self.append_subagent_event_outcome("subagent.started", &prepared.snapshot);
            if !append.complete() {
                let snapshot = prepared.snapshot.clone();
                self.fail_prepared_subagent_run_after_start_persistence_failure(
                    prepared,
                    append.event_written,
                );
                return subagent_start_persistence_error_tool_result(call, &snapshot);
            }
            self.spawn_prepared_subagent_run(prepared);
        }
        let status = if should_start { "started" } else { "queued" };
        let details = json!({
            "subagent_id": snapshot.id,
            "name": snapshot.name,
            "status": status,
            "queued_messages": snapshot.queued_message_count,
            "error": Value::Null
        });
        subagent_tool_success_result(call, details)
    }

    fn read_subagent_tool_result(
        &self,
        call: ToolCall,
        subagent_id: &str,
        include: &str,
    ) -> ToolResult {
        let Some(snapshot) = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(subagent_id)
        else {
            return ToolResult::error(
                call.id,
                call.name,
                format!("subagent not found: {subagent_id}"),
                json!({"kind": "subagent_not_found", "subagent_id": subagent_id}),
            );
        };
        let details = subagent_read_details(&snapshot, include);
        subagent_tool_success_result(call, details)
    }

    fn list_subagents_tool_result(&self, call: ToolCall) -> ToolResult {
        let snapshots = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .list();
        let details = json!({
            "kind": "subagent_list",
            "subagents": snapshots
                .iter()
                .map(subagent_summary)
                .collect::<Vec<_>>(),
            "total": snapshots.len()
        });
        subagent_tool_success_result(call, details)
    }

    fn cancel_subagent_tool_result(
        self: &Arc<Self>,
        call: ToolCall,
        subagent_id: &str,
    ) -> ToolResult {
        let (snapshot, already_cancelled, cancel) =
            match self.cancel_subagent_lifecycle(subagent_id) {
                Ok(cancelled) => cancelled,
                Err(error) => return subagent_manager_error_tool_result(call, error),
            };
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        let owner = TaskOwner::subagent(subagent_id.to_owned());
        let cancelled_task_ids = self
            .background_tasks
            .cancel_all_by_owner(&owner)
            .into_iter()
            .filter(|task| task.state == TaskState::Cancelling)
            .map(|task| task.task_id)
            .collect::<Vec<_>>();
        if !already_cancelled {
            self.append_subagent_event("subagent.cancelled", &snapshot);
        }
        let details = json!({
            "subagent_id": snapshot.id,
            "name": snapshot.name,
            "status": "cancelled",
            "cancelled_task_ids": cancelled_task_ids,
            "error": Value::Null
        });
        subagent_tool_success_result(call, details)
    }

    fn cancel_subagent_lifecycle(
        &self,
        subagent_id: &str,
    ) -> Result<(SubagentSnapshot, bool, Option<CancellationToken>), SubagentManagerError> {
        let _lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let mut manager = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let already_cancelled = manager
            .snapshot(subagent_id)
            .is_some_and(|snapshot| snapshot.lifecycle == SubagentLifecycle::Cancelled);
        let snapshot = manager.cancel(subagent_id)?;
        self.subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .remove(subagent_id);
        self.subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .remove(subagent_id);
        let cancel = self
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .remove(subagent_id);
        Ok((snapshot, already_cancelled, cancel))
    }

    fn cancel_prepared_subagent_spawn_after_start_persistence_failure(
        self: &Arc<Self>,
        prepared: PreparedSubagentRun,
        started_event_written: bool,
    ) {
        let subagent_id = prepared.subagent_id.clone();
        prepared.cancel.cancel();
        let Ok((snapshot, already_cancelled, cancel)) =
            self.cancel_subagent_lifecycle(&subagent_id)
        else {
            return;
        };
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        self.background_tasks
            .cancel_all_by_owner(&TaskOwner::subagent(subagent_id));
        if started_event_written && !already_cancelled {
            self.append_subagent_event("subagent.cancelled", &snapshot);
        }
    }

    fn fail_prepared_subagent_run_after_start_persistence_failure(
        self: &Arc<Self>,
        prepared: PreparedSubagentRun,
        started_event_written: bool,
    ) {
        let subagent_id = prepared.subagent_id.clone();
        prepared.cancel.cancel();
        self.subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .remove(&subagent_id);
        let Ok(snapshot) = self.finish_subagent_run_with_context(
            &subagent_id,
            SubagentRunTerminal::Failed("subagent start persistence failed".to_owned()),
            prepared.messages,
        ) else {
            return;
        };
        if started_event_written {
            self.append_subagent_event("subagent.failed", &snapshot);
        }
    }

    fn initial_subagent_messages(
        &self,
        task: &str,
        inherit_context: bool,
        provider_transcript_snapshot: Option<Vec<Message>>,
        current_tool_call_id: &str,
    ) -> Vec<Message> {
        let mut messages = if inherit_context {
            provider_transcript_snapshot
                .map(|messages| {
                    branch_inheritance_snapshot_without_current_tool_block(
                        messages,
                        current_tool_call_id,
                    )
                })
                .unwrap_or_else(|| {
                    let state = self.state.lock().expect("service state mutex poisoned");
                    repair_provider_transcript(state.context.clone())
                })
        } else {
            Vec::new()
        };
        messages.push(Message::user(vec![ContentPart::text(
            subagent_task_instruction(task),
        )]));
        repair_provider_transcript(messages)
    }

    fn subagent_tools(self: &Arc<Self>, subagent_id: &str) -> Vec<Arc<dyn Tool>> {
        with_builtin_service_tools(
            tools_for_subagent(&self.base_tools),
            self.background_tasks.clone(),
            Arc::downgrade(self),
            None,
            self.registry_store.clone(),
            TaskOwner::subagent(subagent_id),
            false,
        )
    }

    fn subagent_config(&self) -> AgentConfig {
        let mut config = self
            .config
            .clone()
            .without_subagent_control_capability()
            .without_file_publication_capability();
        config.system_prompt = format!("{}\n\n{}", config.system_prompt, SUBAGENT_ROLE_INSTRUCTION);
        if let Some(refresh) = config.prompt_refresh.as_mut() {
            refresh.base_system_prompt = format!(
                "{}\n\n{}",
                refresh.base_system_prompt, SUBAGENT_ROLE_INSTRUCTION
            );
        }
        config.turn_id = None;
        config
    }

    fn finish_subagent_run_with_context(
        &self,
        subagent_id: &str,
        terminal: SubagentRunTerminal,
        messages: Vec<Message>,
    ) -> Result<SubagentSnapshot, SubagentManagerError> {
        let _lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let mut manager = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let snapshot = match terminal {
            SubagentRunTerminal::Completed(result_text) => {
                manager.complete(subagent_id, result_text)?
            }
            SubagentRunTerminal::Failed(error_message) => {
                manager.fail(subagent_id, error_message)?
            }
        };
        self.subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(subagent_id.to_owned(), messages);
        Ok(snapshot)
    }

    fn prepare_spawned_subagent_run(
        &self,
        name_hint: &str,
        task: &str,
        initial_messages: Vec<Message>,
        provider: Arc<dyn Provider>,
    ) -> Result<PreparedSubagentRun, SubagentManagerError> {
        let _lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let mut manager = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let snapshot = manager.spawn(name_hint, task)?;
        let messages = repair_provider_transcript(initial_messages);
        self.subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(snapshot.id.clone(), messages.clone());
        self.subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .insert(snapshot.id.clone(), provider.clone());
        let cancel = CancellationToken::new();
        self.subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .insert(snapshot.id.clone(), cancel.clone());
        Ok(PreparedSubagentRun {
            subagent_id: snapshot.id.clone(),
            snapshot,
            messages,
            provider,
            cancel,
        })
    }

    fn prepare_next_subagent_run(&self, subagent_id: &str) -> Option<PreparedSubagentRun> {
        let _lifecycle = self
            .subagent_lifecycle
            .lock()
            .expect("subagent lifecycle mutex poisoned");
        let mut manager = self
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned");
        let current = manager.snapshot(subagent_id)?;
        if current.queued_message_count == 0 {
            return None;
        }
        let mut contexts = self
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned");
        let provider = self
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .get(subagent_id)
            .cloned()?;
        let (snapshot, message) = manager.start_next_queued(subagent_id).ok().flatten()?;
        let messages = push_subagent_user_message_locked(&mut contexts, subagent_id, &message);
        let cancel = CancellationToken::new();
        self.subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .insert(subagent_id.to_owned(), cancel.clone());
        Some(PreparedSubagentRun {
            subagent_id: subagent_id.to_owned(),
            snapshot,
            messages,
            provider,
            cancel,
        })
    }

    fn spawn_prepared_subagent_run(self: &Arc<Self>, prepared: PreparedSubagentRun) {
        let subagent_id = prepared.subagent_id.clone();
        spawn_subagent_loop(
            self.clone(),
            subagent_id.clone(),
            self.subagent_config(),
            repair_provider_transcript(prepared.messages),
            prepared.provider,
            self.subagent_tools(&subagent_id),
            prepared.cancel,
        );
    }

    fn write_task_request_profile_for_snapshot(
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
    fn write_rejected_task_request_profile(
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

    fn write_task_tell_profile(&self, event_name: &'static str, snapshot: &TaskTellSnapshot) {
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

    fn write_task_send_profile(&self, event_name: &'static str, outcome: &TaskSendOutcome) {
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

    fn write_task_reply_profile(&self, event_name: &'static str, outcome: &TaskReplyOutcome) {
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

    fn reply_task_request(
        &self,
        task_id: &str,
        request_id: &str,
        response: &str,
    ) -> TaskReplyOutcome {
        self.reply_task_request_by_owner(&TaskOwner::Main, task_id, request_id, response)
    }

    fn reply_task_request_by_owner(
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
            return match plan {
                TaskReplyPlan::ReadyToWrite { stdin_intents, .. } => {
                    if !self.append_subagent_event_for_id("subagent.callback", subagent_id) {
                        let reason = "task reply audit persistence failed";
                        let exception = TaskStdinIntent::exception(
                            task_id,
                            request_id,
                            "persistence_failed",
                            reason,
                        );
                        let _ = self.apply_task_stdin_intent(&exception);
                        self.background_tasks.complete_prepared_task_reply_by_owner(
                            owner,
                            task_id,
                            request_id,
                            Err(reason.to_owned()),
                        )
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
                    self.apply_task_request_effects(&outcome.effects);
                    self.append_subagent_event_for_id("subagent.callback", subagent_id);
                    outcome
                }
            };
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
        let event_type = match outcome.status {
            TaskReplyStatus::Written => "task_reply.written",
            TaskReplyStatus::Failed => "task_reply.failed",
            _ => "task_reply.failed",
        };
        self.append_event_for_turn_or_record_error(
            None,
            event_type,
            task_reply_event_data(&outcome),
        );
        self.write_task_reply_profile(event_type, &outcome);
        self.append_service_status_for_current_state(None);
        outcome
    }

    fn send_task_message_by_owner(
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
        if self.background_tasks.stdin_writer(task_id).is_none() {
            let outcome = TaskSendOutcome::new(
                TaskSendStatus::StdinNotWritable,
                task_id,
                None,
                "task stdin is not writable",
            );
            self.append_task_send_event("task_send.failed", &outcome);
            return outcome;
        }

        let send_id = next_task_send_id();
        let intent = TaskStdinIntent::send(task_id, &send_id, message);
        if let Err(error) =
            validate_task_stdin_frame(TaskStdinFrameKind::Send, intent.frame.as_bytes())
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

    fn observe_task_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
        enabled: bool,
        mode: Option<TaskObserveMode>,
    ) -> TaskObserveOutcome {
        if owner != &TaskOwner::Main {
            let outcome = TaskObserveOutcome::new(
                TaskObserveStatus::NotAllowed,
                task_id,
                mode,
                "task_observe is only available to the main agent",
            );
            self.append_task_observe_event("task_observe.failed", &outcome);
            return outcome;
        }
        if self.is_failed_or_shutting_down() {
            let outcome = TaskObserveOutcome::new(
                TaskObserveStatus::ServiceUnavailable,
                task_id,
                mode,
                "service is not accepting task observes",
            );
            self.append_task_observe_event("task_observe.failed", &outcome);
            return outcome;
        }
        if !enabled {
            self.task_observer.disable(task_id);
            let outcome = TaskObserveOutcome::new(
                TaskObserveStatus::Disabled,
                task_id,
                None,
                "task observer disabled",
            );
            self.append_task_observe_event("task_observe.disabled", &outcome);
            self.append_service_status_for_current_state(None);
            return outcome;
        }

        let Some(mode) = mode else {
            let outcome =
                TaskObserveOutcome::invalid(task_id, "mode", "mode is required when enabled=true");
            self.append_task_observe_event("task_observe.failed", &outcome);
            return outcome;
        };
        let Some(task) = self.background_tasks.get_by_owner(owner, task_id) else {
            let outcome = TaskObserveOutcome::new(
                TaskObserveStatus::UnknownTask,
                task_id,
                Some(mode),
                format!("unknown task: {task_id}"),
            );
            self.append_task_observe_event("task_observe.failed", &outcome);
            return outcome;
        };
        if task.state.is_terminal() {
            let outcome = TaskObserveOutcome::new(
                TaskObserveStatus::TaskTerminal,
                task_id,
                Some(mode),
                "task is terminal",
            );
            self.append_task_observe_event("task_observe.failed", &outcome);
            return outcome;
        }
        let Some(writer) = self.background_tasks.stdin_writer(task_id) else {
            let outcome = TaskObserveOutcome::new(
                TaskObserveStatus::StdinNotWritable,
                task_id,
                Some(mode),
                "task stdin is not writable",
            );
            self.append_task_observe_event("task_observe.failed", &outcome);
            return outcome;
        };
        if mode == TaskObserveMode::Stream && !self.llm_text_preview_enabled.load(Ordering::SeqCst)
        {
            let outcome = TaskObserveOutcome::new(
                TaskObserveStatus::PreviewDisabled,
                task_id,
                Some(mode),
                "stream observation requires llm_text_preview.enabled=true",
            );
            self.append_task_observe_event("task_observe.failed", &outcome);
            return outcome;
        }
        if !writer.supports_observer_stdin() {
            let outcome = TaskObserveOutcome::new(
                TaskObserveStatus::StdinNotWritable,
                task_id,
                Some(mode),
                "task stdin does not support observer writes",
            );
            self.append_task_observe_event("task_observe.failed", &outcome);
            return outcome;
        }

        self.task_observer.enable(task_id.to_owned(), mode, writer);
        if mode == TaskObserveMode::Stream {
            self.ensure_task_observer_preview_loop();
        }
        let outcome = TaskObserveOutcome::new(
            TaskObserveStatus::Enabled,
            task_id,
            Some(mode),
            "task observer enabled",
        );
        self.append_task_observe_event("task_observe.enabled", &outcome);
        self.append_service_status_for_current_state(None);
        outcome
    }

    fn ensure_task_observer_preview_loop(&self) {
        if self
            .task_observer_preview_loop_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        spawn_task_observer_preview_loop(
            self.task_observer.clone(),
            self.llm_text_preview_hub.clone(),
            self.task_observer_preview_loop_started.clone(),
        );
    }

    fn append_task_send_event(&self, event_type: &'static str, outcome: &TaskSendOutcome) {
        self.append_event_for_turn_or_record_error(None, event_type, task_send_details(outcome));
        self.write_task_send_profile(event_type, outcome);
    }

    fn append_task_observe_event(&self, event_type: &'static str, outcome: &TaskObserveOutcome) {
        self.append_event_for_turn_or_record_error(None, event_type, task_observe_details(outcome));
    }

    fn apply_task_request_effects(&self, effects: &[TaskRequestEffect]) {
        for effect in effects {
            self.apply_task_request_effect(effect);
        }
    }

    fn apply_task_request_effect(&self, effect: &TaskRequestEffect) {
        if matches!(effect.snapshot.owner, TaskOwner::Subagent { .. }) {
            for intent in &effect.stdin_intents {
                self.apply_task_stdin_intent_with_diagnostic(intent);
            }
            return;
        }
        self.append_event_for_turn_or_record_error(
            None,
            effect.event_type,
            task_request_event_data(&effect.snapshot),
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

    fn record_delivered_task_stdin_diagnostic(
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
                BotifiedFrameEvent::Diagnostic(diagnostic) => {
                    self.handle_task_frame_diagnostic(&task_id, diagnostic);
                }
                BotifiedFrameEvent::ProtocolDiagnostic(diagnostic) => {
                    self.handle_task_protocol_diagnostic(&task_id, diagnostic);
                }
                BotifiedFrameEvent::RegistryDiagnostic(diagnostic) => {
                    self.handle_task_registry_diagnostic(&task_id, diagnostic);
                }
            }
        }
        if let Some(cancel) = start_cancel {
            spawn_service_loop(self.clone(), cancel);
        }
        self.notify.notify_waiters();
    }

    async fn handle_task_request_frame(
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
                    let queued = enqueue_subagent_text_callback(
                        self.clone(),
                        subagent_id,
                        "task_ask",
                        content,
                    )
                    .await;
                    if !queued {
                        self.reject_accepted_task_request_after_callback_failure(
                            task_id,
                            &accepted.request_id,
                            "agent_callback_unavailable",
                            "task request could not be delivered to the subagent",
                        );
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
                } = enqueue_input_inner(
                    self,
                    accepted.message_id,
                    accepted.content,
                    InputSource::TaskRequest,
                    accepted.urgency,
                    Some(accepted.metadata),
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
                if let Some(preemption) = preemption {
                    emit_urgent_preemption(self, preemption);
                }
                start_cancel
            }
            TaskRequestFrameAdmission::ApplyStdinIntents(intents) => {
                for intent in intents {
                    if self.is_failed() {
                        return None;
                    }
                    self.apply_task_stdin_intent_with_diagnostic(&intent);
                }
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
                    let queued = enqueue_subagent_text_callback(
                        self.clone(),
                        subagent_id,
                        "task_tell",
                        content,
                    )
                    .await;
                    if !queued {
                        let mut rejected = accepted.snapshot.clone();
                        rejected.state = "rejected";
                        rejected.failure_reason =
                            Some("task tell could not be delivered to the subagent".to_owned());
                        self.append_event_for_turn_or_record_error(
                            None,
                            "task_tell.rejected",
                            task_tell_event_data(&rejected),
                        );
                        self.write_task_tell_profile("task_tell.rejected", &rejected);
                        self.append_service_status_for_current_state(None);
                    }
                    return None;
                }
                let urgency = accepted.snapshot.urgency;
                let EnqueueInputAttempt {
                    outcome,
                    start_cancel,
                    preemption,
                } = enqueue_input_inner(
                    self,
                    accepted.message_id,
                    accepted.content,
                    InputSource::TaskTell,
                    urgency,
                    Some(accepted.metadata),
                )
                .await;
                if self.is_failed() {
                    return None;
                }
                match outcome {
                    Ok(_) => {
                        self.append_event_for_turn_or_record_error(
                            None,
                            "task_tell.queued",
                            task_tell_event_data(&accepted.snapshot),
                        );
                        self.write_task_tell_profile("task_tell.queued", &accepted.snapshot);
                    }
                    Err(error) => {
                        let mut rejected = accepted.snapshot.clone();
                        rejected.state = "rejected";
                        rejected.failure_reason = Some(error.to_string());
                        self.append_event_for_turn_or_record_error(
                            None,
                            "task_tell.rejected",
                            task_tell_event_data(&rejected),
                        );
                        self.write_task_tell_profile("task_tell.rejected", &rejected);
                    }
                }
                if let Some(preemption) = preemption {
                    emit_urgent_preemption(self, preemption);
                }
                start_cancel
            }
            TaskTellFrameAdmission::Rejected(snapshot) => {
                self.append_event_for_turn_or_record_error(
                    None,
                    "task_tell.rejected",
                    task_tell_event_data(&snapshot),
                );
                self.write_task_tell_profile("task_tell.rejected", &snapshot);
                self.append_service_status_for_current_state(None);
                None
            }
            TaskTellFrameAdmission::None => None,
        }
    }

    fn handle_task_registry_set_frame(&self, task_id: &str, frame: TaskRegistrySetFrame) {
        let Some(task) = self.background_tasks.get(task_id) else {
            self.handle_task_registry_diagnostic(
                task_id,
                TaskFrameDiagnostic {
                    op: Some("registry_set".to_owned()),
                    code: "task_not_found",
                    message: "task not found".to_owned(),
                    request_id: frame.id,
                },
            );
            return;
        };
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
            return;
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
    }

    fn handle_task_registry_get_frame(&self, task_id: &str, frame: TaskRegistryGetFrame) {
        if self.background_tasks.get(task_id).is_none() {
            self.handle_task_registry_diagnostic(
                task_id,
                TaskFrameDiagnostic {
                    op: Some("registry_get".to_owned()),
                    code: "task_not_found",
                    message: "task not found".to_owned(),
                    request_id: Some(frame.id),
                },
            );
            return;
        }

        let Some(store) = self.registry_store.as_ref() else {
            let response = registry_error_stdio_frame(
                &frame.id,
                "registry_disabled",
                "registry is not enabled",
                TASK_STDIN_CONTROL_FRAME_BYTES,
            );
            self.write_task_registry_response(task_id, &frame.id, response);
            return;
        };
        let response_cap = stdio_registry_response_cap(store.config().max_response_bytes)
            .min(TASK_STDIN_CONTROL_FRAME_BYTES);
        let response = match store.get(frame.query()) {
            Ok(result) => registry_snapshot_stdio_frame(&frame.id, result, response_cap),
            Err(error) => registry_error_stdio_frame(
                &frame.id,
                error.code(),
                &error.to_string(),
                response_cap,
            ),
        };
        self.write_task_registry_response(task_id, &frame.id, response);
    }

    fn write_task_registry_response(&self, task_id: &str, request_id: &str, frame: String) {
        let result = self
            .background_tasks
            .stdin_writer(task_id)
            .ok_or_else(|| "task stdin is not writable".to_owned())
            .and_then(|writer| {
                try_write_task_stdin_frame(
                    writer.as_ref(),
                    TaskStdinFrameKind::Registry,
                    frame.as_bytes(),
                )
            });
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
            Err(error) => {
                self.handle_task_registry_diagnostic(
                    task_id,
                    TaskFrameDiagnostic {
                        op: Some("registry_get".to_owned()),
                        code: "stdin_write_failed",
                        message: bounded_chars(&error, 512),
                        request_id: Some(request_id.to_owned()),
                    },
                );
            }
        }
    }

    fn handle_task_protocol_diagnostic(&self, task_id: &str, diagnostic: TaskFrameDiagnostic) {
        self.record_internal_stdio_diagnostic("task_stdio_protocol", task_id, diagnostic);
    }

    fn handle_task_registry_diagnostic(&self, task_id: &str, diagnostic: TaskFrameDiagnostic) {
        self.record_internal_stdio_diagnostic("task_stdio_registry", task_id, diagnostic);
    }

    fn record_task_observer_diagnostic(&self, diagnostic: TaskObserverDiagnostic) {
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

    fn record_internal_stdio_diagnostic(
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
            "recorded_at": system_time_rfc3339(SystemTime::now()),
        });
        self.stdio_diagnostics
            .lock()
            .expect("stdio diagnostics mutex poisoned")
            .record(domain, code, bounded_summary);
    }

    fn admit_task_request_frame(
        self: &Arc<Self>,
        task_id: &str,
        frame: TaskRequestFrame,
    ) -> TaskRequestFrameAdmission {
        let admission = self
            .task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned");
        if self.is_failed_or_shutting_down() {
            return TaskRequestFrameAdmission::None;
        }
        admission.pause_for_test(TaskFrameAdmissionKind::Ask);
        if self.is_failed_or_shutting_down() {
            return TaskRequestFrameAdmission::None;
        }

        let request_id = frame.id.clone();
        let request_bytes = frame.request.len();
        let expect_bytes = frame.expect.as_deref().map(str::len).unwrap_or(0);
        let urgency = frame.urgency;
        match self.background_tasks.accept_task_request(task_id, frame) {
            TaskRequestAdmission::Accepted(snapshot) => {
                schedule_task_request_deadline_check(self.clone(), snapshot.clone());
                let accepted = AcceptedTaskRequestFrameAdmission {
                    request_id: request_id.clone(),
                    message_id: task_request_input_id(task_id, &request_id),
                    content: task_request_content(&snapshot),
                    urgency: snapshot.urgency,
                    metadata: QueuedInputMetadata::TaskRequest {
                        task_id: task_id.to_owned(),
                        request_id,
                    },
                    owner: snapshot.owner.clone(),
                };
                if matches!(snapshot.owner, TaskOwner::Subagent { .. }) {
                    return TaskRequestFrameAdmission::Accepted(accepted);
                }
                self.append_event_for_turn_or_record_error(
                    None,
                    "task_ask.requested",
                    task_request_event_data(&snapshot),
                );
                self.write_task_request_profile_for_snapshot("task_ask.requested", &snapshot);
                self.append_service_status_for_current_state(None);
                TaskRequestFrameAdmission::Accepted(accepted)
            }
            TaskRequestAdmission::Duplicate(snapshot) => {
                if let TaskOwner::Subagent { subagent_id } = &snapshot.owner {
                    self.append_subagent_event_for_id("subagent.callback", subagent_id);
                    return TaskRequestFrameAdmission::None;
                }
                self.append_event_for_turn_or_record_error(
                    None,
                    "service.warning",
                    duplicate_task_request_warning_data(&snapshot),
                );
                TaskRequestFrameAdmission::None
            }
            TaskRequestAdmission::Rejected(snapshot) => {
                if matches!(snapshot.owner, TaskOwner::Subagent { .. }) {
                    let reason = snapshot
                        .failure_reason
                        .clone()
                        .unwrap_or_else(|| "task request rejected".to_owned());
                    return TaskRequestFrameAdmission::ApplyStdinIntents(vec![
                        TaskStdinIntent::exception(
                            task_id,
                            &request_id,
                            exception_code_for_rejected_request(&reason),
                            &reason,
                        ),
                    ]);
                }
                self.append_event_for_turn_or_record_error(
                    None,
                    "task_ask.rejected",
                    task_request_event_data(&snapshot),
                );
                self.write_task_request_profile_for_snapshot("task_ask.rejected", &snapshot);
                let reason = snapshot
                    .failure_reason
                    .clone()
                    .unwrap_or_else(|| "task request rejected".to_owned());
                self.append_service_status_for_current_state(None);
                TaskRequestFrameAdmission::ApplyStdinIntents(vec![TaskStdinIntent::exception(
                    task_id,
                    &request_id,
                    exception_code_for_rejected_request(&reason),
                    &reason,
                )])
            }
            TaskRequestAdmission::TaskMissing => {
                self.append_event_for_turn_or_record_error(
                    None,
                    "task_ask.rejected",
                    json!({
                        "task_id": task_id,
                        "ask_id": request_id,
                        "state": "rejected",
                        "status": "rejected",
                        "failure_reason": "task not found"
                    }),
                );
                self.write_rejected_task_request_profile(
                    task_id,
                    Some(&request_id),
                    Some(urgency),
                    Some(request_bytes),
                    Some(expect_bytes),
                    "task_not_found",
                    "task not found",
                );
                TaskRequestFrameAdmission::None
            }
        }
    }

    fn admit_task_tell_frame(
        self: &Arc<Self>,
        task_id: &str,
        frame: TaskTellFrame,
    ) -> TaskTellFrameAdmission {
        let admission = self
            .task_frame_admission_gate
            .lock()
            .expect("task frame admission gate mutex poisoned");
        if self.is_failed_or_shutting_down() {
            return TaskTellFrameAdmission::None;
        }
        admission.pause_for_test(TaskFrameAdmissionKind::Tell);
        if self.is_failed_or_shutting_down() {
            return TaskTellFrameAdmission::None;
        }

        let tell_id = frame.id.clone();
        let task = self.background_tasks.get(task_id);
        let Some(task) = task else {
            return TaskTellFrameAdmission::Rejected(task_tell_snapshot(
                task_id,
                None,
                frame,
                "rejected",
                Some("task not found".to_owned()),
            ));
        };
        if task.state.is_terminal() {
            return TaskTellFrameAdmission::Rejected(task_tell_snapshot(
                task_id,
                Some(&task),
                frame,
                "task_terminal",
                Some("task is terminal".to_owned()),
            ));
        }

        let snapshot = task_tell_snapshot(task_id, Some(&task), frame, "accepted", None);
        let suffix = NEXT_TASK_TELL_INPUT_SUFFIX.fetch_add(1, Ordering::SeqCst);
        let accepted = AcceptedTaskTellFrameAdmission {
            message_id: task_tell_input_id(task_id, &tell_id, suffix),
            content: task_tell_content(&snapshot),
            metadata: QueuedInputMetadata::TaskTell {
                task_id: task_id.to_owned(),
                tell_id,
            },
            snapshot,
        };
        if matches!(accepted.snapshot.owner, TaskOwner::Subagent { .. }) {
            return TaskTellFrameAdmission::Accepted(accepted);
        }
        self.append_event_for_turn_or_record_error(
            None,
            "task_tell.accepted",
            task_tell_event_data(&accepted.snapshot),
        );
        self.write_task_tell_profile("task_tell.accepted", &accepted.snapshot);
        self.append_service_status_for_current_state(None);
        TaskTellFrameAdmission::Accepted(accepted)
    }

    fn reject_accepted_task_request_after_enqueue_failure(
        &self,
        task_id: &str,
        request_id: &str,
        error: &ServiceError,
    ) {
        let reason = error.to_string();
        if let Some(resolution) = self.background_tasks.reject_task_request(
            task_id,
            request_id,
            exception_code_for_service_error(error),
            reason,
        ) {
            self.apply_task_request_effects(&resolution.effects);
            self.append_service_status_for_current_state(None);
        }
    }

    fn reject_accepted_task_request_after_callback_failure(
        &self,
        task_id: &str,
        request_id: &str,
        exception_code: &'static str,
        reason: &'static str,
    ) {
        if let Some(resolution) =
            self.background_tasks
                .reject_task_request(task_id, request_id, exception_code, reason)
        {
            self.apply_task_request_effects(&resolution.effects);
            self.append_service_status_for_current_state(None);
        }
    }

    fn handle_task_frame_diagnostic(&self, task_id: &str, diagnostic: TaskFrameDiagnostic) {
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
        if self.is_failed_or_shutting_down() {
            return None;
        }
        admission.pause_for_test(TaskFrameAdmissionKind::Diagnostic);
        if self.is_failed_or_shutting_down() {
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
            self.append_event_for_turn_or_record_error(
                None,
                "task_tell.rejected",
                task_tell_diagnostic_event_data(&snapshot, &diagnostic),
            );
            self.write_task_tell_profile("task_tell.rejected", &snapshot);
            self.append_service_status_for_current_state(None);
            return None;
        }
        if let Some(TaskSnapshot {
            owner: TaskOwner::Subagent { subagent_id },
            ..
        }) = task.as_ref()
        {
            self.append_subagent_event_for_id("subagent.callback", subagent_id);
            return diagnostic.request_id.as_deref().map(|request_id| {
                TaskStdinIntent::exception(
                    task_id,
                    request_id,
                    diagnostic.code,
                    &diagnostic.message,
                )
            });
        }
        self.append_event_for_turn_or_record_error(
            None,
            "task_ask.rejected",
            task_frame_diagnostic_data(task_id, &diagnostic, task.as_ref()),
        );
        self.write_rejected_task_request_profile(
            task_id,
            diagnostic.request_id.as_deref(),
            None,
            None,
            None,
            diagnostic.code,
            "task frame diagnostic rejected",
        );
        self.append_service_status_for_current_state(None);
        diagnostic.request_id.as_deref().map(|request_id| {
            TaskStdinIntent::exception(task_id, request_id, diagnostic.code, &diagnostic.message)
        })
    }

    fn expire_due_task_requests(&self, task_id: &str, now: SystemTime) {
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

    fn last_event_seq(&self) -> u64 {
        self.timeline_store
            .lock()
            .expect("timeline store mutex poisoned")
            .checkpoint()
            .seq
    }

    fn next_subagent_callback_id(&self) -> String {
        let seq = self
            .next_subagent_callback_seq
            .fetch_add(1, Ordering::Relaxed);
        format!("subagent_callback_{}_{}", self.subagent_callback_epoch, seq)
    }

    #[cfg(test)]
    fn set_subagent_test_hook(&self, kind: SubagentTestHookKind, hook: SubagentTestHook) {
        self.subagent_test_hooks.set(kind, hook);
    }

    #[cfg(test)]
    fn run_subagent_test_hook(&self, kind: SubagentTestHookKind) {
        self.subagent_test_hooks.run(kind);
    }

    #[cfg(test)]
    fn append_event_for_turn(
        &self,
        turn_id: Option<&str>,
        event_type: &str,
        data: serde_json::Value,
    ) -> ServiceEvent {
        self.try_append_event_for_turn(turn_id, event_type, data)
            .expect("timeline event should persist")
    }

    fn append_event_for_turn_or_record_error(
        &self,
        turn_id: Option<&str>,
        event_type: &str,
        data: serde_json::Value,
    ) -> Option<ServiceEvent> {
        match self.try_append_event_for_turn(turn_id, event_type, data) {
            Ok(event) => Some(event),
            Err(error) => {
                self.record_timeline_persistence_error(error);
                None
            }
        }
    }

    fn append_event_for_turn_or_mark_locked(
        &self,
        state: &mut ServiceInnerState,
        turn_id: Option<&str>,
        event_type: &str,
        data: serde_json::Value,
    ) -> Option<ServiceEvent> {
        self.try_append_event_for_turn_or_mark_locked(state, turn_id, event_type, data)
            .ok()
    }

    fn try_append_event_for_turn_or_mark_locked(
        &self,
        state: &mut ServiceInnerState,
        turn_id: Option<&str>,
        event_type: &str,
        data: serde_json::Value,
    ) -> Result<ServiceEvent, ServiceError> {
        match self.try_append_event_for_turn(turn_id, event_type, data) {
            Ok(event) => Ok(event),
            Err(error) => Err(self.record_timeline_persistence_error_for_locked(state, error)),
        }
    }

    fn try_append_event_for_turn(
        &self,
        turn_id: Option<&str>,
        event_type: &str,
        data: serde_json::Value,
    ) -> Result<ServiceEvent, TimelineStoreError> {
        if let Some(failure) = self.next_service_event_write_failure() {
            self.timeline_store
                .lock()
                .expect("timeline store mutex poisoned")
                .inject_next_write_failure(failure);
        }
        let event = append_committed_service_event(
            &self.timeline_store,
            &self.event_log,
            self.config.session.as_deref(),
            turn_id,
            event_type,
            data,
        )?;
        self.record_public_replay_event(&event);
        self.event_notify.notify_waiters();
        Ok(event)
    }

    fn next_service_event_write_failure(&self) -> Option<TimelineWriteFailure> {
        let mut guard = self
            .next_service_event_write_failure
            .lock()
            .expect("service event write failure mutex poisoned");
        let (remaining, failure) = guard.as_mut()?;
        if *remaining == 0 {
            let failure = *failure;
            *guard = None;
            return Some(failure);
        }
        *remaining -= 1;
        None
    }

    fn record_public_replay_event(&self, event: &ServiceEvent) {
        if self.session_recorder.is_none() {
            return;
        }
        self.public_replay
            .lock()
            .expect("public replay projection buffer mutex poisoned")
            .observe(event);
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

fn task_requires_active_item(task: &TaskSnapshot) -> bool {
    matches!(task.state, TaskState::Running | TaskState::Cancelling)
        || (task.state.is_terminal()
            && matches!(
                task.callback_delivery,
                CallbackDelivery::Pending | CallbackDelivery::Enqueued | CallbackDelivery::Failed
            ))
}

fn active_task_status(task: &TaskSnapshot) -> &'static str {
    task_state_name(task.state)
}

fn schedule_task_request_deadline_check(inner: Arc<ServiceInner>, snapshot: TaskRequestSnapshot) {
    let task_id = snapshot.task_id;
    let deadline_at = snapshot.deadline_at;
    let delay = snapshot
        .deadline_at
        .duration_since(SystemTime::now())
        .unwrap_or(Duration::ZERO);
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        if inner.is_failed_or_shutting_down() {
            return;
        }
        inner.expire_due_task_requests(&task_id, deadline_at);
    });
}

fn exception_code_for_service_error(error: &ServiceError) -> &'static str {
    match error {
        ServiceError::QueueFull => "queue_full",
        ServiceError::EmptyMessage => "empty_message",
        ServiceError::MessageConflict { .. } => "message_conflict",
        ServiceError::ShuttingDown => "service_shutting_down",
        ServiceError::Persistence { .. } => "persistence_error",
    }
}

fn exception_code_for_rejected_request(reason: &str) -> &'static str {
    if reason.contains("global task ask pending limit") {
        "global_pending_limit_reached"
    } else if reason.contains("pending limit") {
        "pending_limit_reached"
    } else if reason.contains("terminal") {
        "task_terminal"
    } else {
        "ask_rejected"
    }
}

struct ServiceBackgroundExecutionHost {
    inner: Arc<ServiceInner>,
    owner: TaskOwner,
}

#[async_trait]
impl BackgroundExecutionHost for ServiceBackgroundExecutionHost {
    fn allocate_task_id(&self) -> String {
        self.inner.background_tasks.allocate_task_id()
    }

    fn task_manager(&self) -> Arc<BackgroundTaskManager> {
        self.inner.background_tasks.clone()
    }

    fn publish_task(&self, task_id: String, task: NewBackgroundTask) -> bool {
        let task = task.with_owner(self.owner.clone());
        if let TaskOwner::Subagent { subagent_id } = &self.owner {
            #[cfg(test)]
            self.inner
                .run_subagent_test_hook(SubagentTestHookKind::SubagentPublishOpenCheck);
            let (subagent_snapshot, started_task_id) = {
                let _lifecycle = self
                    .inner
                    .subagent_lifecycle
                    .lock()
                    .expect("subagent lifecycle mutex poisoned");
                let state = self
                    .inner
                    .state
                    .lock()
                    .expect("service state mutex poisoned");
                if matches!(
                    state.state,
                    ServiceState::Failed | ServiceState::ShuttingDown
                ) {
                    task.cancel_token.cancel();
                    return false;
                }
                let mut manager = self
                    .inner
                    .subagents
                    .lock()
                    .expect("subagent manager mutex poisoned");
                let subagent_open = manager
                    .snapshot(subagent_id)
                    .is_some_and(|snapshot| snapshot.lifecycle != SubagentLifecycle::Cancelled);
                if !subagent_open {
                    task.cancel_token.cancel();
                    return false;
                }
                let snapshot = self
                    .inner
                    .background_tasks
                    .start_task_with_id(task_id, task);
                let started_task_id = snapshot.task_id.clone();
                match manager.add_owned_task_id(subagent_id, snapshot.task_id) {
                    Ok(snapshot) => (snapshot, started_task_id),
                    Err(_) => {
                        self.inner
                            .background_tasks
                            .cancel_by_owner(&self.owner, &started_task_id);
                        return false;
                    }
                }
            };
            let append = self
                .inner
                .append_subagent_event_outcome("subagent.callback", &subagent_snapshot);
            if !append.complete() {
                if let Some(finalization) = self.inner.background_tasks.cancel_and_fail_by_owner(
                    &self.owner,
                    &started_task_id,
                    "subagent task publish persistence failed",
                ) {
                    self.inner
                        .apply_task_request_effects(&finalization.pending_request_effects);
                    self.inner
                        .background_tasks
                        .release_stdin_writer(&started_task_id);
                    if append.event_written {
                        self.inner.append_subagent_task_failed_event(
                            &subagent_snapshot,
                            &finalization.snapshot,
                            "subagent_task_publish_persistence_failed",
                        );
                    }
                }
                return false;
            }
            return true;
        }
        {
            let mut state = self
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            if matches!(
                state.state,
                ServiceState::Failed | ServiceState::ShuttingDown
            ) {
                task.cancel_token.cancel();
                return false;
            }
            let snapshot = self
                .inner
                .background_tasks
                .start_task_with_id(task_id, task);
            if self.owner == TaskOwner::Main {
                if self
                    .inner
                    .try_append_event_for_turn_or_mark_locked(
                        &mut state,
                        None,
                        "task.detached",
                        task_event_data(&snapshot),
                    )
                    .is_err()
                {
                    self.inner
                        .background_tasks
                        .discard_unstarted_by_owner(&self.owner, &snapshot.task_id);
                    return false;
                }
                if self
                    .inner
                    .try_append_service_status_for_locked(&mut state, None)
                    .is_err()
                {
                    if let Some(finalization) =
                        self.inner.background_tasks.cancel_and_fail_by_owner(
                            &self.owner,
                            &snapshot.task_id,
                            "task startup persistence failed",
                        )
                    {
                        self.inner
                            .apply_task_request_effects(&finalization.pending_request_effects);
                        self.inner
                            .background_tasks
                            .release_stdin_writer(&snapshot.task_id);
                        let failed_snapshot = self
                            .inner
                            .background_tasks
                            .get(&snapshot.task_id)
                            .unwrap_or(finalization.snapshot);
                        self.inner.append_event_for_turn_or_mark_locked(
                            &mut state,
                            None,
                            "task.failed",
                            task_event_data(&failed_snapshot),
                        );
                        self.inner
                            .append_service_status_for_locked(&mut state, None);
                    }
                    return false;
                }
            }
        }
        true
    }

    async fn finish_task(&self, task_id: String, tool_call: ToolCall, result: DetachedToolResult) {
        let Some(_guard) = self
            .inner
            .register_service_worker(ServiceWorkerKind::BackgroundCompletion)
        else {
            return;
        };
        if self.inner.is_failed_or_shutting_down() {
            self.inner.background_tasks.finish_task(
                &task_id,
                result.state,
                "service stopped before task completion could be recorded",
            );
            self.inner.background_tasks.release_stdin_writer(&task_id);
            self.inner.task_observer.remove_task(&task_id);
            return;
        }
        let should_record_final_text =
            self.inner
                .background_tasks
                .get(&task_id)
                .is_some_and(|snapshot| {
                    snapshot.output.artifact_path.is_none() && snapshot.output.output_bytes == 0
                });
        if should_record_final_text {
            if let Some(snapshot) = self.inner.background_tasks.update_output(
                &task_id,
                TaskOutputUpdate::bytes(result.tool_result.text.as_bytes()),
            ) {
                if self.owner == TaskOwner::Main {
                    self.inner.append_task_updated_event(&snapshot);
                }
            }
        }
        let Some(finalization) = self.inner.background_tasks.finish_task(
            &task_id,
            result.state,
            "task reached terminal state",
        ) else {
            return;
        };
        self.inner
            .apply_task_request_effects(&finalization.pending_request_effects);
        let snapshot = self
            .inner
            .background_tasks
            .get(&task_id)
            .unwrap_or(finalization.snapshot);
        self.inner.background_tasks.release_stdin_writer(&task_id);
        self.inner.task_observer.remove_task(&task_id);

        match &self.owner {
            TaskOwner::Main => {
                if self
                    .inner
                    .append_event_for_turn_or_record_error(
                        None,
                        terminal_task_event_type(result.state),
                        task_event_data(&snapshot),
                    )
                    .is_none()
                {
                    self.inner.cancel_active_turn_if_failed();
                    return;
                }
                if self
                    .inner
                    .append_service_status_for_current_state(None)
                    .is_none()
                {
                    self.inner.cancel_active_turn_if_failed();
                    return;
                }
                if suppress_background_task_callback(&result.tool_result) {
                    return;
                }

                let callback_id = format!("task_callback_{task_id}");
                let callback = task_callback_content(&tool_call, &snapshot);
                if let Some(snapshot) = self.inner.background_tasks.set_callback_pending(
                    &task_id,
                    callback_id.clone(),
                    callback,
                ) {
                    if self
                        .inner
                        .append_event_for_turn_or_record_error(
                            None,
                            "task.callback_pending",
                            task_event_data(&snapshot),
                        )
                        .is_none()
                    {
                        self.inner
                            .background_tasks
                            .clear_callback_pending_if_payload(&task_id, &callback_id);
                        self.inner.cancel_active_turn_if_failed();
                        return;
                    }
                    if self
                        .inner
                        .append_service_status_for_current_state(None)
                        .is_none()
                    {
                        self.inner.cancel_active_turn_if_failed();
                        return;
                    }
                    retry_pending_task_callbacks(self.inner.clone()).await;
                }
            }
            TaskOwner::Subagent { subagent_id } => {
                let callback = task_callback_content(&tool_call, &snapshot);
                enqueue_subagent_text_callback(
                    self.inner.clone(),
                    subagent_id,
                    subagent_task_callback_kind(snapshot.state),
                    callback_text(&callback),
                )
                .await;
            }
        }
    }

    fn interactive_stdio_bridge(&self, task_id: &str) -> Option<Arc<dyn InteractiveStdioBridge>> {
        Some(Arc::new(ServiceInteractiveStdioBridge {
            inner: self.inner.clone(),
            task_id: task_id.to_owned(),
        }))
    }
}

struct ServiceInteractiveStdioBridge {
    inner: Arc<ServiceInner>,
    task_id: String,
}

impl InteractiveStdioBridge for ServiceInteractiveStdioBridge {
    fn register_stdin_writer(&self, writer: Arc<dyn TaskStdinWriter>) {
        self.inner
            .background_tasks
            .register_stdin_writer(&self.task_id, writer);
    }

    fn handle_frame_events(&self, events: Vec<BotifiedFrameEvent>) {
        if events.is_empty() {
            return;
        }
        let Some(guard) = self
            .inner
            .register_service_worker(ServiceWorkerKind::FrameHandler)
        else {
            return;
        };
        let mut deferred = Vec::new();
        for event in events {
            if self.inner.is_failed_or_shutting_down() {
                return;
            }
            match event {
                BotifiedFrameEvent::Diagnostic(diagnostic) => {
                    self.inner
                        .handle_task_frame_diagnostic(&self.task_id, diagnostic);
                }
                request @ (BotifiedFrameEvent::Ask(_)
                | BotifiedFrameEvent::Tell(_)
                | BotifiedFrameEvent::RegistrySet(_)
                | BotifiedFrameEvent::RegistryGet(_)
                | BotifiedFrameEvent::ProtocolDiagnostic(_)
                | BotifiedFrameEvent::RegistryDiagnostic(_)) => deferred.push(request),
            }
        }
        if deferred.is_empty() {
            self.inner.notify.notify_waiters();
            return;
        }
        if self.inner.is_failed_or_shutting_down() {
            return;
        }
        let inner = self.inner.clone();
        let task_id = self.task_id.clone();
        tokio::spawn(async move {
            let _guard = guard;
            if inner.is_failed_or_shutting_down() {
                return;
            }
            inner.handle_task_frame_events(task_id, deferred).await;
        });
    }
}

fn terminal_task_event_type(state: TaskState) -> &'static str {
    match state {
        TaskState::Completed => "task.completed",
        TaskState::Failed => "task.failed",
        TaskState::TimedOut => "task.timed_out",
        TaskState::Cancelled | TaskState::Cancelling => "task.cancelled",
        TaskState::Running | TaskState::Lost => "task.failed",
    }
}

fn suppress_background_task_callback(result: &ToolResult) -> bool {
    matches!(
        result.details.get("kind").and_then(Value::as_str),
        Some("background_task_ack_aborted" | "background_task_ack_persistence_failed")
    )
}

fn task_event_data(snapshot: &TaskSnapshot) -> serde_json::Value {
    json!({
        "task_id": snapshot.task_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "state": task_state_name(snapshot.state),
        "status": task_state_name(snapshot.state),
        "arguments_summary": bounded_chars(&snapshot.arguments_summary, 512),
        "timeout_secs": task_timeout_secs(snapshot),
        "timeout_at": snapshot.timeout_at.map(system_time_rfc3339),
        "forced_termination_at": snapshot.timeout_at.map(system_time_rfc3339),
        "output_tail": snapshot.output.tail,
        "output_live": snapshot.output.output_live,
        "output_complete": snapshot.output.output_complete,
        "output_bytes": snapshot.output.output_bytes,
        "output_last_updated_at": snapshot.output.output_last_updated_at.map(system_time_rfc3339),
        "output_tail_truncated": snapshot.output.output_tail_truncated,
        "output_artifact_path": snapshot.output.artifact_path.as_ref().map(|path| path.display().to_string()),
        "output_artifact_truncated": snapshot.output.output_artifact_truncated,
        "output_dropped_bytes": snapshot.output.output_dropped_bytes,
        "callback_delivery": callback_delivery_name(snapshot.callback_delivery),
        "callback_failure_reason": snapshot.callback_failure_reason,
        "callback_input_id": snapshot.callback_payload.as_ref().map(|payload| payload.message_id.clone()),
    })
}

fn task_timeout_secs(snapshot: &TaskSnapshot) -> Option<f64> {
    let timeout_at = snapshot.timeout_at?;
    let started = snapshot.detached_at.unwrap_or(snapshot.started_at);
    timeout_at
        .duration_since(started)
        .ok()
        .map(|duration| duration.as_secs_f64())
}

fn task_request_input_id(task_id: &str, request_id: &str) -> String {
    format!("task_ask_{task_id}_{request_id}")
}

fn task_tell_input_id(task_id: &str, tell_id: &str, suffix: u64) -> String {
    format!("task_tell_{task_id}_{tell_id}_{suffix}")
}

fn task_request_item_id(task_id: &str, request_id: &str) -> String {
    format!("task_ask_{task_id}_{request_id}")
}

fn task_tell_snapshot(
    task_id: &str,
    task: Option<&TaskSnapshot>,
    frame: TaskTellFrame,
    state: &'static str,
    failure_reason: Option<String>,
) -> TaskTellSnapshot {
    let arguments_summary = task
        .map(|task| bounded_chars(&task.arguments_summary, 512))
        .unwrap_or_default();
    let tool_name = task
        .map(|task| task.tool_name.clone())
        .unwrap_or_else(|| "unknown".to_owned());
    let sender = if arguments_summary.trim().is_empty() {
        tool_name.clone()
    } else {
        format!("{tool_name}: {arguments_summary}")
    };
    TaskTellSnapshot {
        task_id: task_id.to_owned(),
        tool_call_id: task
            .map(|task| task.tool_call_id.clone())
            .unwrap_or_default(),
        tool_name,
        arguments_summary,
        owner: task.map(|task| task.owner.clone()).unwrap_or_default(),
        sender,
        tell_id: frame.id,
        message: frame.message,
        urgency: frame.urgency,
        state,
        told_at: SystemTime::now(),
        failure_reason,
    }
}

fn managed_task_registry_origin(task: &TaskSnapshot) -> String {
    match &task.owner {
        TaskOwner::Main => format!("task:{}", task.task_id),
        TaskOwner::Subagent { subagent_id } => {
            format!("subagent:{subagent_id}/task:{}", task.task_id)
        }
    }
}

fn default_registry_source_for_task(task: &TaskSnapshot) -> String {
    if task.tool_name.trim().is_empty() {
        "task".to_owned()
    } else {
        task.tool_name.clone()
    }
}

fn task_request_content(snapshot: &TaskRequestSnapshot) -> Vec<ContentPart> {
    let mut body = format!(
        "<task_ask task_id=\"{}\" ask_id=\"{}\" tool_call_id=\"{}\" tool_name=\"{}\" sender=\"{}\" urgency=\"{}\" arguments_summary=\"{}\" asked_at=\"{}\" deadline_at=\"{}\" effective_timeout_secs=\"{}\"",
        xml_attr_escape(&snapshot.task_id),
        xml_attr_escape(&snapshot.request_id),
        xml_attr_escape(&snapshot.tool_call_id),
        xml_attr_escape(&snapshot.tool_name),
        xml_attr_escape(&snapshot.sender),
        snapshot.urgency.as_str(),
        xml_attr_escape(&snapshot.arguments_summary),
        system_time_rfc3339(snapshot.requested_at),
        system_time_rfc3339(snapshot.deadline_at),
        duration_secs_attr(snapshot.effective_timeout)
    );
    if let Some(timeout) = snapshot.requested_timeout {
        body.push_str(&format!(
            " requested_timeout_secs=\"{}\"",
            duration_secs_attr(timeout)
        ));
    }
    if let Some(expect) = snapshot.expect.as_deref() {
        body.push_str(&format!(" expect=\"{}\"", xml_attr_escape(expect)));
    }
    body.push_str(">\n");
    body.push_str(&snapshot.request);
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str("</task_ask>");
    vec![ContentPart::text(body)]
}

fn task_tell_content(snapshot: &TaskTellSnapshot) -> Vec<ContentPart> {
    let mut body = format!(
        "<task_tell task_id=\"{}\" tell_id=\"{}\" tool_call_id=\"{}\" tool_name=\"{}\" sender=\"{}\" urgency=\"{}\" arguments_summary=\"{}\" told_at=\"{}\">\n",
        xml_attr_escape(&snapshot.task_id),
        xml_attr_escape(&snapshot.tell_id),
        xml_attr_escape(&snapshot.tool_call_id),
        xml_attr_escape(&snapshot.tool_name),
        xml_attr_escape(&snapshot.sender),
        snapshot.urgency.as_str(),
        xml_attr_escape(&snapshot.arguments_summary),
        system_time_rfc3339(snapshot.told_at),
    );
    body.push_str(&snapshot.message);
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str("</task_tell>");
    vec![ContentPart::text(body)]
}

fn task_request_event_data(snapshot: &TaskRequestSnapshot) -> serde_json::Value {
    json!({
        "task_id": snapshot.task_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "arguments_summary": bounded_chars(&snapshot.arguments_summary, 512),
        "sender": snapshot.sender,
        "ask_id": snapshot.request_id,
        "urgency": snapshot.urgency.as_str(),
        "state": task_request_state_name(snapshot.state),
        "status": task_request_state_name(snapshot.state),
        "message": bounded_chars(&snapshot.request, 512),
        "expect": snapshot.expect,
        "asked_at": system_time_rfc3339(snapshot.requested_at),
        "deadline_at": system_time_rfc3339(snapshot.deadline_at),
        "requested_timeout_secs": snapshot.requested_timeout.map(duration_secs_value),
        "effective_timeout_secs": duration_secs_value(snapshot.effective_timeout),
        "failure_reason": snapshot.failure_reason,
    })
}

fn task_tell_event_data(snapshot: &TaskTellSnapshot) -> serde_json::Value {
    json!({
        "kind": "task_tell",
        "task_id": snapshot.task_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "arguments_summary": bounded_chars(&snapshot.arguments_summary, 512),
        "sender": snapshot.sender,
        "tell_id": snapshot.tell_id,
        "urgency": snapshot.urgency.as_str(),
        "state": snapshot.state,
        "status": snapshot.state,
        "message": bounded_chars(&snapshot.message, 512),
        "told_at": system_time_rfc3339(snapshot.told_at),
        "failure_reason": snapshot.failure_reason,
    })
}

fn task_tell_diagnostic_event_data(
    snapshot: &TaskTellSnapshot,
    diagnostic: &TaskFrameDiagnostic,
) -> serde_json::Value {
    let mut data = task_tell_event_data(snapshot);
    data["error"] = json!({
        "code": diagnostic.code,
        "message": diagnostic.message,
        "retryable": false
    });
    data
}

fn task_stdin_write_failed_event_data(intent: &TaskStdinIntent, error: &str) -> serde_json::Value {
    let kind = match intent.kind {
        TaskStdinIntentKind::Response => "response",
        TaskStdinIntentKind::Exception { code } => code,
        TaskStdinIntentKind::Send => "send",
    };
    let mut data = json!({
        "task_id": intent.task_id,
        "kind": kind,
        "error": bounded_chars(error, 512),
    });
    match intent.kind {
        TaskStdinIntentKind::Send => data["send_id"] = json!(intent.request_id),
        TaskStdinIntentKind::Response | TaskStdinIntentKind::Exception { .. } => {
            data["ask_id"] = json!(intent.request_id);
        }
    }
    data
}

fn task_stdin_intent_frame_kind(intent: &TaskStdinIntent) -> TaskStdinFrameKind {
    match intent.kind {
        TaskStdinIntentKind::Response | TaskStdinIntentKind::Exception { .. } => {
            TaskStdinFrameKind::Reply
        }
        TaskStdinIntentKind::Send => TaskStdinFrameKind::Send,
    }
}

fn duplicate_task_request_warning_data(snapshot: &TaskRequestSnapshot) -> serde_json::Value {
    json!({
        "domain": "task_ask",
        "code": "duplicate_ask_id",
        "severity": "warning",
        "status": "ignored",
        "message": "duplicate pending task_ask id ignored",
        "task_id": snapshot.task_id,
        "ask_id": snapshot.request_id,
        "tool_call_id": snapshot.tool_call_id,
        "tool_name": snapshot.tool_name,
        "arguments_summary": bounded_chars(&snapshot.arguments_summary, 512),
        "sender": snapshot.sender,
        "asked_at": system_time_rfc3339(snapshot.requested_at),
        "deadline_at": system_time_rfc3339(snapshot.deadline_at),
        "requested_timeout_secs": snapshot.requested_timeout.map(duration_secs_value),
        "effective_timeout_secs": duration_secs_value(snapshot.effective_timeout),
    })
}

fn duration_secs_value(duration: Duration) -> f64 {
    duration.as_secs_f64()
}

fn duration_secs_attr(duration: Duration) -> String {
    let seconds = duration.as_secs_f64();
    if seconds.fract() == 0.0 {
        return format!("{seconds:.0}");
    }
    let mut text = format!("{seconds:.9}");
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    text
}

fn task_frame_diagnostic_data(
    task_id: &str,
    diagnostic: &TaskFrameDiagnostic,
    task: Option<&TaskSnapshot>,
) -> serde_json::Value {
    let mut data = json!({
        "task_id": task_id,
        "ask_id": diagnostic.request_id,
        "state": "rejected",
        "status": "rejected",
        "failure_reason": diagnostic.message,
        "error": {
            "code": diagnostic.code,
            "message": diagnostic.message,
            "retryable": false
        }
    });
    if let Some(task) = task {
        let arguments_summary = bounded_chars(&task.arguments_summary, 512);
        data["tool_call_id"] = json!(task.tool_call_id.clone());
        data["tool_name"] = json!(task.tool_name.clone());
        data["arguments_summary"] = json!(arguments_summary.clone());
        data["sender"] = json!(task_request_sender_for_event(
            &task.tool_name,
            &arguments_summary
        ));
    }
    data
}

fn task_request_sender_for_event(tool_name: &str, arguments_summary: &str) -> String {
    if arguments_summary.trim().is_empty() {
        tool_name.to_owned()
    } else {
        format!("{tool_name}: {arguments_summary}")
    }
}

fn task_reply_event_data(outcome: &TaskReplyOutcome) -> serde_json::Value {
    let mut data = task_reply_details(outcome);
    if let Some(snapshot) = outcome.snapshot.as_ref() {
        data["task_id"] = json!(snapshot.task_id);
        data["ask_id"] = json!(snapshot.request_id);
        data["state"] = json!(task_request_state_name(snapshot.state));
        data["status"] = json!(task_request_state_name(snapshot.state));
    }
    data
}

fn task_reply_details(outcome: &TaskReplyOutcome) -> serde_json::Value {
    json!({
        "kind": "task_reply",
        "ok": outcome.ok(),
        "status": task_reply_status_name(&outcome.status),
        "message": outcome.message,
        "task_id": outcome.task_id.clone(),
        "ask_id": outcome.request_id.clone(),
        "source": TASK_REPLY_SOURCE,
    })
}

fn task_send_details(outcome: &TaskSendOutcome) -> serde_json::Value {
    json!({
        "kind": "task_send",
        "ok": outcome.ok(),
        "status": task_send_status_name(&outcome.status),
        "state": task_send_status_name(&outcome.status),
        "message": outcome.message,
        "task_id": outcome.task_id,
        "send_id": outcome.send_id,
        "source": "agent_tool",
    })
}

fn task_observe_details(outcome: &TaskObserveOutcome) -> serde_json::Value {
    let mut details = json!({
        "kind": "task_observe",
        "ok": outcome.ok(),
        "status": task_observe_status_name(&outcome.status),
        "state": task_observe_status_name(&outcome.status),
        "task_id": outcome.task_id,
        "observing": outcome.observing(),
        "mode": outcome.mode.map(TaskObserveMode::as_str),
        "source": "agent_tool",
    });
    if !outcome.ok() {
        details["error"] = json!({
            "code": task_observe_error_code(&outcome.status),
            "message": outcome.message,
            "retryable": false,
        });
        if let Some(field) = outcome.field {
            details["field"] = json!(field);
        }
    }
    details
}

fn task_reply_status_name(status: &TaskReplyStatus) -> &'static str {
    match status {
        TaskReplyStatus::Written => "written",
        TaskReplyStatus::Failed => "failed",
        TaskReplyStatus::UnknownTask => "unknown_task",
        TaskReplyStatus::UnknownRequest => "unknown_ask",
        TaskReplyStatus::AlreadyResolved => "already_resolved",
        TaskReplyStatus::Expired => "expired",
        TaskReplyStatus::TaskTerminal => "task_terminal",
        TaskReplyStatus::ResponseTooLarge => "message_too_large",
    }
}

fn task_send_status_name(status: &TaskSendStatus) -> &'static str {
    match status {
        TaskSendStatus::Written => "written",
        TaskSendStatus::UnknownTask => "unknown_task",
        TaskSendStatus::TaskTerminal => "task_terminal",
        TaskSendStatus::StdinNotWritable => "stdin_not_writable",
        TaskSendStatus::MessageTooLarge => "message_too_large",
        TaskSendStatus::WriteFailed => "write_failed",
        TaskSendStatus::ServiceUnavailable => "service_unavailable",
    }
}

fn task_observe_status_name(status: &TaskObserveStatus) -> &'static str {
    match status {
        TaskObserveStatus::Enabled => "enabled",
        TaskObserveStatus::Disabled => "disabled",
        TaskObserveStatus::UnknownTask => "unknown_task",
        TaskObserveStatus::TaskTerminal => "task_terminal",
        TaskObserveStatus::StdinNotWritable => "stdin_not_writable",
        TaskObserveStatus::PreviewDisabled => "preview_disabled",
        TaskObserveStatus::InvalidArguments => "invalid_arguments",
        TaskObserveStatus::NotAllowed => "not_allowed",
        TaskObserveStatus::ServiceUnavailable => "service_unavailable",
    }
}

fn task_observe_error_code(status: &TaskObserveStatus) -> &'static str {
    match status {
        TaskObserveStatus::Enabled | TaskObserveStatus::Disabled => "ok",
        TaskObserveStatus::UnknownTask => "task_not_found",
        TaskObserveStatus::TaskTerminal => "task_terminal",
        TaskObserveStatus::StdinNotWritable => "stdin_not_writable",
        TaskObserveStatus::PreviewDisabled => "preview_disabled",
        TaskObserveStatus::InvalidArguments => "invalid_arguments",
        TaskObserveStatus::NotAllowed => "not_allowed",
        TaskObserveStatus::ServiceUnavailable => "service_unavailable",
    }
}

fn next_task_send_id() -> String {
    let suffix = NEXT_TASK_SEND_ID_SUFFIX.fetch_add(1, Ordering::SeqCst);
    format!("s{suffix}")
}

fn task_request_state_name(state: TaskRequestState) -> &'static str {
    match state {
        TaskRequestState::Pending => "pending",
        TaskRequestState::Replied => "replied",
        TaskRequestState::Written => "written",
        TaskRequestState::WriteFailed => "write_failed",
        TaskRequestState::Expired => "expired",
        TaskRequestState::Rejected => "rejected",
        TaskRequestState::TaskTerminal => "task_terminal",
    }
}

fn task_event_data_with_cycle(
    snapshot: &TaskSnapshot,
    cycle_id: Option<&str>,
) -> serde_json::Value {
    let mut data = task_event_data(snapshot);
    if let (Some(object), Some(cycle_id)) = (data.as_object_mut(), cycle_id) {
        object.insert("cycle_id".to_owned(), json!(cycle_id));
    }
    data
}

fn task_state_name(state: TaskState) -> &'static str {
    match state {
        TaskState::Running => "running",
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::TimedOut => "timed_out",
        TaskState::Cancelling => "cancelling",
        TaskState::Cancelled => "cancelled",
        TaskState::Lost => "lost",
    }
}

fn spawn_task_observer_preview_loop(
    observer: TaskConversationObserver,
    hub: LlmTextPreviewHub,
    started: Arc<AtomicBool>,
) {
    let mut subscription = hub.subscribe(LlmTextPreviewFilter::default());
    tokio::spawn(async move {
        loop {
            while let Some(frame) = subscription.recv().await {
                observer.publish_preview_frame(&frame);
            }

            if observer.has_stream_observers() {
                subscription = hub.subscribe(LlmTextPreviewFilter::default());
                continue;
            }

            started.store(false, Ordering::SeqCst);
            if !observer.has_stream_observers()
                || started
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
            {
                break;
            }
            subscription = hub.subscribe(LlmTextPreviewFilter::default());
        }
    });
}

async fn retry_pending_task_callbacks(inner: Arc<ServiceInner>) {
    if inner.is_failed_or_shutting_down() {
        return;
    }
    let pending = inner.background_tasks.pending_callbacks();
    for payload in pending {
        if !inner
            .background_tasks
            .get(&payload.task_id)
            .is_some_and(|snapshot| snapshot.owner == TaskOwner::Main)
        {
            continue;
        }
        if inner.has_queued_task_request_for_task(&payload.task_id) {
            continue;
        }
        if inner.is_failed_or_shutting_down() {
            return;
        }
        let EnqueueInputAttempt {
            outcome,
            start_cancel,
            preemption: _,
        } = enqueue_task_callback_payload(inner.as_ref(), &payload).await;
        let mut start_cancel = start_cancel;
        let mut should_notify = start_cancel.is_some();
        match outcome {
            Ok(_) => {
                if let Some(snapshot) = inner
                    .background_tasks
                    .set_callback_enqueued_if_pending(&payload.task_id)
                {
                    if inner
                        .append_event_for_turn_or_record_error(
                            None,
                            "task.callback_queued",
                            task_event_data(&snapshot),
                        )
                        .is_none()
                    {
                        inner.background_tasks.restore_callback_pending_if_enqueued(
                            &payload.task_id,
                            &payload.message_id,
                        );
                        if let Some(cancel) = start_cancel.take() {
                            cancel.cancel();
                        }
                        inner.cancel_active_turn_if_failed();
                        continue;
                    }
                    if inner
                        .append_service_status_for_current_state(None)
                        .is_none()
                    {
                        if let Some(cancel) = start_cancel.take() {
                            cancel.cancel();
                        }
                        inner.cancel_active_turn_if_failed();
                        continue;
                    }
                }
                should_notify = true;
            }
            Err(ServiceError::QueueFull) => {}
            Err(ServiceError::Persistence { message }) => {
                inner.mark_failed(message);
            }
            Err(error) => {
                record_pending_task_callback_failed(inner.as_ref(), &payload, error.to_string());
            }
        }
        if should_notify {
            inner.notify.notify_waiters();
        }
        if let Some(cancel) = start_cancel {
            spawn_service_loop(inner.clone(), cancel);
        }
    }
}

async fn retry_pending_task_callbacks_for_inner(inner: &ServiceInner) {
    if inner.is_failed_or_shutting_down() {
        return;
    }
    let pending = inner.background_tasks.pending_callbacks();
    for payload in pending {
        if !inner
            .background_tasks
            .get(&payload.task_id)
            .is_some_and(|snapshot| snapshot.owner == TaskOwner::Main)
        {
            continue;
        }
        if inner.has_queued_task_request_for_task(&payload.task_id) {
            continue;
        }
        if inner.is_failed_or_shutting_down() {
            return;
        }
        let EnqueueInputAttempt { outcome, .. } =
            enqueue_task_callback_payload(inner, &payload).await;
        match outcome {
            Ok(_) => {
                if let Some(snapshot) = inner
                    .background_tasks
                    .set_callback_enqueued_if_pending(&payload.task_id)
                {
                    if inner
                        .append_event_for_turn_or_record_error(
                            None,
                            "task.callback_queued",
                            task_event_data(&snapshot),
                        )
                        .is_none()
                    {
                        inner.background_tasks.restore_callback_pending_if_enqueued(
                            &payload.task_id,
                            &payload.message_id,
                        );
                        inner.cancel_active_turn_if_failed();
                        continue;
                    }
                    if inner
                        .append_service_status_for_current_state(None)
                        .is_none()
                    {
                        inner.cancel_active_turn_if_failed();
                        continue;
                    }
                }
                inner.notify.notify_waiters();
            }
            Err(ServiceError::QueueFull) => {}
            Err(ServiceError::Persistence { message }) => {
                inner.mark_failed(message);
            }
            Err(error) => {
                record_pending_task_callback_failed(inner, &payload, error.to_string());
            }
        }
    }
}

fn record_pending_task_callback_failed(
    inner: &ServiceInner,
    payload: &TaskCallbackPayloadSnapshot,
    reason: String,
) {
    if let Some(snapshot) = inner
        .background_tasks
        .set_callback_failed_if_pending(&payload.task_id, reason)
    {
        let event = inner.append_event_for_turn_or_record_error(
            None,
            "task.callback_failed",
            task_event_data(&snapshot),
        );
        if event.is_none() {
            inner
                .background_tasks
                .restore_callback_pending_if_failed(&payload.task_id);
            inner.cancel_active_turn_if_failed();
            return;
        }
        inner.append_service_status_for_current_state(None);
    }
}

async fn enqueue_task_callback_payload(
    inner: &ServiceInner,
    payload: &TaskCallbackPayloadSnapshot,
) -> EnqueueInputAttempt {
    enqueue_input_inner(
        inner,
        payload.message_id.clone(),
        payload.content.clone(),
        InputSource::TaskCallback,
        InputUrgency::Normal,
        None,
    )
    .await
}

fn callback_delivery_name(delivery: CallbackDelivery) -> &'static str {
    match delivery {
        CallbackDelivery::NotReady => "not_ready",
        CallbackDelivery::Pending => "pending",
        CallbackDelivery::Enqueued => "queued",
        CallbackDelivery::Delivered => "delivered",
        CallbackDelivery::Failed => "failed",
    }
}

fn task_callback_content(tool_call: &ToolCall, snapshot: &TaskSnapshot) -> Vec<ContentPart> {
    let status = match snapshot.state {
        TaskState::Completed => "completed",
        TaskState::Failed => "failed",
        TaskState::TimedOut => "timed_out",
        TaskState::Cancelled | TaskState::Cancelling => "cancelled",
        TaskState::Running | TaskState::Lost => "failed",
    };
    let artifact_path = snapshot
        .output
        .artifact_path
        .as_ref()
        .map(|path| path.display().to_string());
    let mut body = String::new();
    if let Some(path) = artifact_path {
        body.push_str(&format!("output_artifact_path: {path}\n"));
    }
    body.push_str(&format!(
        "timeout_secs: {}\n",
        optional_seconds_for_callback(task_timeout_secs(snapshot))
    ));
    body.push_str(&format!(
        "forced_termination_at: {}\n",
        optional_time_for_callback(snapshot.timeout_at)
    ));
    body.push_str(&format!("output_live: {}\n", snapshot.output.output_live));
    body.push_str(&format!(
        "output_complete: {}\n",
        snapshot.output.output_complete
    ));
    body.push_str(&format!("output_bytes: {}\n", snapshot.output.output_bytes));
    if let Some(updated_at) = snapshot.output.output_last_updated_at {
        body.push_str(&format!(
            "output_last_updated_at: {}\n",
            system_time_rfc3339(updated_at)
        ));
    }
    body.push_str(&format!(
        "output_tail_truncated: {}\n",
        snapshot.output.output_tail_truncated
    ));
    body.push_str(&format!(
        "output_artifact_truncated: {}\n",
        snapshot.output.output_artifact_truncated
    ));
    body.push_str(&format!(
        "output_dropped_bytes: {}\n",
        snapshot.output.output_dropped_bytes
    ));
    if !snapshot.output.tail.is_empty() {
        body.push_str("output_tail:\n");
        body.push_str(&bounded_chars(&snapshot.output.tail, 8 * 1024));
        if !body.ends_with('\n') {
            body.push('\n');
        }
    }
    vec![ContentPart::text(format!(
        "<task_callback task_id=\"{}\" tool_call_id=\"{}\" tool_name=\"{}\" status=\"{}\">\n{}\n</task_callback>",
        xml_attr_escape(&snapshot.task_id),
        xml_attr_escape(&tool_call.id),
        xml_attr_escape(&tool_call.name),
        status,
        body
    ))]
}

fn optional_seconds_for_callback(seconds: Option<f64>) -> String {
    seconds
        .map(|seconds| {
            if seconds.fract() == 0.0 {
                format!("{seconds:.0}")
            } else {
                seconds.to_string()
            }
        })
        .unwrap_or_else(|| "null".to_owned())
}

fn optional_time_for_callback(time: Option<SystemTime>) -> String {
    time.map(system_time_rfc3339)
        .unwrap_or_else(|| "null".to_owned())
}

fn bounded_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn system_time_rfc3339(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = duration.as_secs();
    let nanos = duration.subsec_nanos();
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    if nanos == 0 {
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
    } else {
        let millis = nanos / 1_000_000;
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
    }
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_piece = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_piece + 2) / 5 + 1;
    let month = month_piece + if month_piece < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };

    (year as i32, month as u32, day as u32)
}

fn xml_attr_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn persist_public_replay(inner: &ServiceInner, after_seq: u64) -> Result<(), String> {
    let Some(recorder) = inner.session_recorder.as_ref() else {
        return Ok(());
    };

    let buffered_plan = plan_buffered_public_replay_cursors(inner, after_seq);
    let raw_events = inner
        .event_log
        .lock()
        .expect("event log mutex poisoned")
        .read_after(after_seq);
    if raw_events
        .iter()
        .any(|event| event.event_type == "event.gap")
        && !buffered_plan.complete
    {
        return Err("public replay cursor persistence failed: event gap in replay window".into());
    }
    if raw_events.is_empty()
        && buffered_plan.cursors.is_empty()
        && buffered_plan.prune_through_seq.is_none()
    {
        return Ok(());
    }

    let use_buffered_plan = buffered_plan.complete && buffered_plan.prune_through_seq.is_some();
    let new_message_cursors = if use_buffered_plan {
        buffered_plan.cursors
    } else {
        let raw_plan = plan_raw_public_replay_cursors(inner, &raw_events);
        if !raw_plan.complete {
            return Err(
                "public replay cursor persistence failed: incomplete replay projection".into(),
            );
        }
        raw_plan.cursors
    };
    let prune_through_seq = if use_buffered_plan {
        buffered_plan.prune_through_seq
    } else {
        plan_raw_public_replay_prune_through(&raw_events, &new_message_cursors)
    };

    for cursor in &new_message_cursors {
        if let Err(error) = recorder.record_message_cursor_sync(cursor) {
            return Err(error.to_string());
        }
        install_durable_message_replay(inner, cursor);
    }

    if let Some(prune_through_seq) = prune_through_seq {
        inner
            .public_replay
            .lock()
            .expect("public replay projection buffer mutex poisoned")
            .prune_through(prune_through_seq);
    }
    Ok(())
}

fn install_durable_message_replay(inner: &ServiceInner, cursor: &DurableMessageCursor) {
    let mut state = inner.state.lock().expect("service state mutex poisoned");
    state
        .durable_message_replays
        .entry(cursor.message_id.clone())
        .or_insert_with(|| DurableMessageReplay {
            replay_start_seq: cursor.replay_start_seq,
            terminal_seq: cursor.terminal_seq,
            events: cursor.replay_events.clone(),
        });
    prune_durable_message_replays_to_retained_window(&mut state);
    prune_message_index_to_retained_window(&mut state);
}

fn plan_raw_public_replay_cursors(
    inner: &ServiceInner,
    raw_events: &[ServiceEvent],
) -> RawReplayPlan {
    let state = inner.state.lock().expect("service state mutex poisoned");
    let mut planned = Vec::new();
    let mut complete = true;

    for event in raw_events {
        if event.event_type == "queue.drained" {
            for message_id in message_ids_from_event_data(&event.data) {
                if state.durable_message_replays.contains_key(&message_id) {
                    continue;
                }
                let replay_start_seq = state
                    .message_index
                    .get(&message_id)
                    .map(|entry| entry.cursor.seq())
                    .unwrap_or(0);
                let Some(projection) = durable_message_projection(raw_events, &message_id) else {
                    complete = false;
                    continue;
                };
                planned.push(durable_message_cursor(
                    message_id,
                    replay_start_seq,
                    projection,
                ));
            }
        }
    }
    RawReplayPlan {
        cursors: planned,
        complete,
    }
}

fn plan_raw_public_replay_prune_through(
    raw_events: &[ServiceEvent],
    cursors: &[DurableMessageCursor],
) -> Option<u64> {
    raw_events
        .iter()
        .filter_map(|event| {
            project_thread_event(event)
                .filter(is_public_terminal_event)
                .map(|_| event.seq)
        })
        .max()
        .or_else(|| cursors.iter().map(|cursor| cursor.terminal_seq).max())
}

struct RawReplayPlan {
    cursors: Vec<DurableMessageCursor>,
    complete: bool,
}

fn plan_buffered_public_replay_cursors(inner: &ServiceInner, after_seq: u64) -> BufferedReplayPlan {
    let buffered_events = inner
        .public_replay
        .lock()
        .expect("public replay projection buffer mutex poisoned")
        .events_after(after_seq);
    if buffered_events.is_empty() {
        return BufferedReplayPlan::incomplete();
    }

    let prune_through_seq = buffered_events
        .iter()
        .filter_map(|event| match &event.kind {
            BufferedPublicReplayEventKind::Public(public_event)
                if is_public_terminal_event(public_event.as_ref()) =>
            {
                Some(event.seq)
            }
            _ => None,
        })
        .max();
    let state = inner.state.lock().expect("service state mutex poisoned");
    let mut planned = Vec::new();
    let mut complete = prune_through_seq.is_some();
    for event in &buffered_events {
        let BufferedPublicReplayEventKind::QueueDrained { message_ids } = &event.kind else {
            continue;
        };
        for message_id in message_ids {
            if state.durable_message_replays.contains_key(message_id) {
                continue;
            }
            let replay_start_seq = state
                .message_index
                .get(message_id)
                .map(|entry| entry.cursor.seq())
                .unwrap_or(0);
            let Some(projection) =
                durable_message_projection_from_buffer(&buffered_events, message_id)
            else {
                complete = false;
                continue;
            };
            planned.push(durable_message_cursor(
                message_id.clone(),
                replay_start_seq,
                projection,
            ));
        }
    }
    BufferedReplayPlan {
        cursors: planned,
        complete,
        prune_through_seq,
    }
}

struct BufferedReplayPlan {
    cursors: Vec<DurableMessageCursor>,
    complete: bool,
    prune_through_seq: Option<u64>,
}

impl BufferedReplayPlan {
    fn incomplete() -> Self {
        Self {
            cursors: Vec::new(),
            complete: false,
            prune_through_seq: None,
        }
    }
}

fn durable_message_cursor(
    message_id: String,
    replay_start_seq: u64,
    projection: DurableMessageProjection,
) -> DurableMessageCursor {
    let terminal_seq = durable_terminal_seq(
        replay_start_seq,
        projection.terminal_seq,
        !projection.events.is_empty(),
    );
    DurableMessageCursor {
        message_id,
        replay_start_seq,
        terminal_seq,
        replay_events: projection.events,
    }
}

fn durable_message_projection(
    raw_events: &[ServiceEvent],
    message_id: &str,
) -> Option<DurableMessageProjection> {
    let target = find_durable_message_target(raw_events, message_id)?;

    let mut selected = Vec::new();
    let mut terminal_seq = None;
    let start_index = if target.synthetic_start {
        selected.push(ThreadEvent::TurnStarted);
        target.start_index + 1
    } else {
        target.start_index
    };

    for (index, event) in raw_events.iter().enumerate().skip(start_index) {
        if index > target.drain_index && is_queue_drained_for_turn(event, &target.turn_id) {
            selected.push(synthetic_turn_completed_event());
            terminal_seq = Some(event.seq);
            break;
        }
        if event.turn_id.as_deref() != Some(target.turn_id.as_str()) {
            continue;
        }
        if let Some(public_event) = project_thread_event(event) {
            let terminal = is_public_terminal_event(&public_event);
            selected.push(public_event);
            if terminal {
                terminal_seq = Some(event.seq);
                break;
            }
        }
    }

    terminal_seq.map(|terminal_seq| DurableMessageProjection {
        terminal_seq,
        events: selected,
    })
}

fn durable_message_projection_from_buffer(
    events: &[BufferedPublicReplayEvent],
    message_id: &str,
) -> Option<DurableMessageProjection> {
    let target = find_buffered_durable_message_target(events, message_id)?;

    let mut selected = Vec::new();
    let mut terminal_seq = None;
    let start_index = if target.synthetic_start {
        selected.push(ThreadEvent::TurnStarted);
        target.start_index + 1
    } else {
        target.start_index
    };

    for (index, event) in events.iter().enumerate().skip(start_index) {
        if index > target.drain_index && is_buffered_queue_drained_for_turn(event, &target.turn_id)
        {
            selected.push(synthetic_turn_completed_event());
            terminal_seq = Some(event.seq);
            break;
        }
        if event.turn_id != target.turn_id {
            continue;
        }
        if let BufferedPublicReplayEventKind::Public(public_event) = &event.kind {
            let public_event = public_event.as_ref();
            let terminal = is_public_terminal_event(public_event);
            selected.push(public_event.clone());
            if terminal {
                terminal_seq = Some(event.seq);
                break;
            }
        }
    }

    terminal_seq.map(|terminal_seq| DurableMessageProjection {
        terminal_seq,
        events: selected,
    })
}

fn find_durable_message_target(
    events: &[ServiceEvent],
    message_id: &str,
) -> Option<DurableMessageTarget> {
    let drain_index = events
        .iter()
        .position(|event| is_queue_drained_for_message(event, message_id))?;
    let turn_id = events[drain_index].turn_id.clone()?;
    let prior_batch_in_turn = events
        .iter()
        .take(drain_index)
        .any(|event| is_queue_drained_for_turn(event, &turn_id));
    let start_index = if prior_batch_in_turn {
        None
    } else {
        events.iter().take(drain_index).position(|event| {
            event.event_type == "turn.started" && event.turn_id.as_deref() == Some(&turn_id)
        })
    };
    let (start_index, synthetic_start) = start_index
        .map(|index| (index, false))
        .unwrap_or((drain_index, true));

    Some(DurableMessageTarget {
        turn_id,
        drain_index,
        start_index,
        synthetic_start,
    })
}

fn is_queue_drained_for_message(event: &ServiceEvent, message_id: &str) -> bool {
    event.event_type == "queue.drained"
        && event
            .data
            .get("message_ids")
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(message_id)))
}

fn is_queue_drained_for_turn(event: &ServiceEvent, turn_id: &str) -> bool {
    event.event_type == "queue.drained" && event.turn_id.as_deref() == Some(turn_id)
}

fn synthetic_turn_completed_event() -> ThreadEvent {
    ThreadEvent::TurnCompleted {
        usage: crate::agent_events::AgentUsage::default(),
    }
}

struct DurableMessageTarget {
    turn_id: String,
    drain_index: usize,
    start_index: usize,
    synthetic_start: bool,
}

fn find_buffered_durable_message_target(
    events: &[BufferedPublicReplayEvent],
    message_id: &str,
) -> Option<DurableMessageTarget> {
    let drain_index = events
        .iter()
        .position(|event| is_buffered_queue_drained_for_message(event, message_id))?;
    let turn_id = events[drain_index].turn_id.clone();
    let prior_batch_in_turn = events
        .iter()
        .take(drain_index)
        .any(|event| is_buffered_queue_drained_for_turn(event, &turn_id));
    let start_index = if prior_batch_in_turn {
        None
    } else {
        events.iter().take(drain_index).position(|event| {
            event.turn_id == turn_id
                && matches!(&event.kind, BufferedPublicReplayEventKind::Public(public_event)
                    if matches!(public_event.as_ref(), ThreadEvent::TurnStarted))
        })
    };
    let (start_index, synthetic_start) = start_index
        .map(|index| (index, false))
        .unwrap_or((drain_index, true));

    Some(DurableMessageTarget {
        turn_id,
        drain_index,
        start_index,
        synthetic_start,
    })
}

fn is_buffered_queue_drained_for_message(
    event: &BufferedPublicReplayEvent,
    message_id: &str,
) -> bool {
    matches!(
        &event.kind,
        BufferedPublicReplayEventKind::QueueDrained { message_ids }
            if message_ids.iter().any(|id| id == message_id)
    )
}

fn is_buffered_queue_drained_for_turn(event: &BufferedPublicReplayEvent, turn_id: &str) -> bool {
    event.turn_id == turn_id
        && matches!(
            &event.kind,
            BufferedPublicReplayEventKind::QueueDrained { .. }
        )
}

struct DurableMessageProjection {
    terminal_seq: u64,
    events: Vec<ThreadEvent>,
}

fn message_ids_from_event_data(data: &Value) -> Vec<String> {
    data.get("message_ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

const SUBAGENT_ROLE_INSTRUCTION: &str = "You are an internal subagent branch. Work only on the assigned task, keep results concise, and do not assume you can spawn more subagents or publish directly to the user.";
const SUBAGENT_CALLBACK_TEXT_CHARS: usize = 8 * 1024;

fn subagent_task_instruction(task: &str) -> String {
    format!(
        "Subagent task:\n{}",
        bounded_chars(task, SUBAGENT_CALLBACK_TEXT_CHARS)
    )
}

fn branch_inheritance_snapshot_without_current_tool_block(
    messages: Vec<Message>,
    current_tool_call_id: &str,
) -> Vec<Message> {
    let mut filtered = Vec::with_capacity(messages.len());
    let mut index = 0;

    while index < messages.len() {
        let Message::Assistant { tool_calls, .. } = &messages[index] else {
            filtered.push(messages[index].clone());
            index += 1;
            continue;
        };
        if !tool_calls
            .iter()
            .any(|call| call.id == current_tool_call_id)
        {
            filtered.push(messages[index].clone());
            index += 1;
            continue;
        }

        let block_tool_call_ids = tool_calls
            .iter()
            .map(|call| call.id.as_str())
            .collect::<Vec<_>>();
        index += 1;
        while index < messages.len() {
            let Message::ToolResult(result) = &messages[index] else {
                break;
            };
            if !block_tool_call_ids.contains(&result.tool_call_id.as_str()) {
                break;
            }
            index += 1;
        }
    }

    repair_provider_transcript(filtered)
}

fn subagent_manager_error_tool_result(call: ToolCall, error: SubagentManagerError) -> ToolResult {
    let (kind, message) = match &error {
        SubagentManagerError::InvalidLimit { field } => {
            ("invalid_limit", format!("invalid subagent limit: {field}"))
        }
        SubagentManagerError::ParallelLimit { max_parallel } => (
            "parallel_limit",
            format!("subagent parallel limit exceeded: max_parallel={max_parallel}"),
        ),
        SubagentManagerError::BranchLimit { max_branches } => (
            "branch_limit",
            format!("subagent branch limit exceeded: max_branches={max_branches}"),
        ),
        SubagentManagerError::QueueLimit {
            max_queued_messages,
        } => (
            "queued_message_limit",
            format!(
                "subagent queued message limit exceeded: max_queued_messages={max_queued_messages}"
            ),
        ),
        SubagentManagerError::NotFound { id } => {
            ("subagent_not_found", format!("subagent not found: {id}"))
        }
        SubagentManagerError::Cancelled { id } => {
            ("subagent_cancelled", format!("subagent is cancelled: {id}"))
        }
    };
    ToolResult::error(
        call.id,
        call.name,
        message,
        json!({"kind": kind, "error": error.to_string()}),
    )
}

fn subagent_start_persistence_error_tool_result(
    call: ToolCall,
    snapshot: &SubagentSnapshot,
) -> ToolResult {
    ToolResult::error(
        call.id,
        call.name,
        "subagent start persistence failed",
        json!({
            "kind": "subagent_start_persistence_failed",
            "subagent_id": snapshot.id,
            "name": snapshot.name,
            "status": "failed"
        }),
    )
}

fn subagent_tool_success_result(call: ToolCall, details: Value) -> ToolResult {
    ToolResult::success(call.id, call.name, details.to_string()).with_details(details)
}

fn subagent_summary(snapshot: &SubagentSnapshot) -> Value {
    json!({
        "subagent_id": snapshot.id,
        "name": snapshot.name,
        "purpose": bounded_chars(&snapshot.purpose, 512),
        "lifecycle": subagent_lifecycle_name(snapshot.lifecycle),
        "run_state": subagent_run_state_name(snapshot.run_state),
        "status_summary": subagent_status_summary(snapshot),
        "latest_result": snapshot.latest_result.as_ref().map(|value| bounded_chars(value, 2048)),
        "latest_error": snapshot.latest_error.as_ref().map(|value| bounded_chars(value, 2048)),
        "queued_message_count": snapshot.queued_message_count,
        "owned_task_count": snapshot.owned_task_count,
        "owned_task_ids_omitted": snapshot.owned_task_ids_omitted,
        "owned_task_ids_truncated": snapshot.owned_task_ids_truncated,
        "callback_count": snapshot.callback_count,
        "pending_callback_count": snapshot.pending_callback_count,
        "failed_callback_count": snapshot.failed_callback_count,
        "callbacks_omitted": snapshot.callbacks_omitted,
        "callbacks_truncated": snapshot.callbacks_truncated,
        "latest_callback": snapshot.callbacks.last().map(subagent_callback_summary_json),
        "tail_truncated": snapshot.tail_truncated,
    })
}

fn subagent_public_summary(snapshot: &SubagentSnapshot) -> Value {
    let status_summary = subagent_status_summary(snapshot);
    json!({
        "subagent_id": snapshot.id,
        "name": snapshot.name,
        "purpose": bounded_chars(&snapshot.purpose, 512),
        "status": status_summary,
        "status_summary": status_summary,
        "latest_result": snapshot.latest_result.as_ref().map(|value| bounded_chars(value, 2048)),
        "latest_error": snapshot.latest_error.as_ref().map(|value| bounded_chars(value, 2048)),
        "queued_message_count": snapshot.queued_message_count,
        "owned_task_count": snapshot.owned_task_count,
        "owned_task_ids_omitted": snapshot.owned_task_ids_omitted,
        "owned_task_ids_truncated": snapshot.owned_task_ids_truncated,
        "callback_count": snapshot.callback_count,
        "pending_callback_count": snapshot.pending_callback_count,
        "failed_callback_count": snapshot.failed_callback_count,
        "callbacks_omitted": snapshot.callbacks_omitted,
        "callbacks_truncated": snapshot.callbacks_truncated,
        "latest_callback": snapshot.callbacks.last().map(subagent_callback_summary_json),
    })
}

fn subagent_read_details(snapshot: &SubagentSnapshot, include: &str) -> Value {
    let mut details = subagent_summary(snapshot);
    if matches!(include, "tail" | "all") {
        details["tail"] = json!(snapshot
            .tail
            .iter()
            .map(subagent_tail_entry_json)
            .collect::<Vec<_>>());
    }
    if include == "all" {
        details["queued_messages"] = json!(snapshot
            .queued_messages
            .iter()
            .map(|message| bounded_chars(message, 1024))
            .collect::<Vec<_>>());
        details["owned_task_ids"] = json!(snapshot.owned_task_ids);
        details["callbacks"] = json!(snapshot
            .callbacks
            .iter()
            .map(subagent_callback_summary_json)
            .collect::<Vec<_>>());
    }
    details
}

fn subagent_callback_summary_json(callback: &crate::subagents::SubagentCallbackSummary) -> Value {
    json!({
        "callback_id": callback.callback_id,
        "kind": callback.kind,
        "status": subagent_callback_status_name(callback.status),
        "failure_reason": callback.failure_reason.as_ref().map(|reason| bounded_chars(reason, 512))
    })
}

fn subagent_event_data(snapshot: &SubagentSnapshot) -> Value {
    let mut data = subagent_summary(snapshot);
    data["tail"] = json!(snapshot
        .tail
        .iter()
        .rev()
        .take(4)
        .map(subagent_tail_entry_json)
        .collect::<Vec<_>>());
    data
}

fn subagent_tail_entry_json(entry: &crate::subagents::SubagentTailEntry) -> Value {
    json!({
        "kind": subagent_tail_kind_name(entry.kind),
        "text": bounded_chars(&entry.text, 2048)
    })
}

fn subagent_lifecycle_name(lifecycle: SubagentLifecycle) -> &'static str {
    match lifecycle {
        SubagentLifecycle::Open => "open",
        SubagentLifecycle::Cancelled => "cancelled",
    }
}

fn subagent_run_state_name(state: SubagentRunState) -> &'static str {
    match state {
        SubagentRunState::Idle => "idle",
        SubagentRunState::Running => "running",
        SubagentRunState::Completed => "completed",
        SubagentRunState::Failed => "failed",
    }
}

fn subagent_tail_kind_name(kind: SubagentTailKind) -> &'static str {
    match kind {
        SubagentTailKind::Sent => "sent",
        SubagentTailKind::Queued => "queued",
        SubagentTailKind::Result => "result",
        SubagentTailKind::Error => "error",
        SubagentTailKind::Cancelled => "cancelled",
        SubagentTailKind::Task => "task",
    }
}

fn subagent_callback_status_name(status: SubagentCallbackStatus) -> &'static str {
    match status {
        SubagentCallbackStatus::Pending => "pending",
        SubagentCallbackStatus::Delivered => "delivered",
        SubagentCallbackStatus::Failed => "failed",
    }
}

fn subagent_status_summary(snapshot: &SubagentSnapshot) -> &'static str {
    if snapshot.lifecycle == SubagentLifecycle::Cancelled {
        "cancelled"
    } else {
        subagent_run_state_name(snapshot.run_state)
    }
}

fn subagent_active_item_status(snapshot: &SubagentSnapshot) -> &'static str {
    if snapshot.lifecycle == SubagentLifecycle::Cancelled {
        "cancelled"
    } else if snapshot.run_state == SubagentRunState::Running {
        "running"
    } else {
        "open"
    }
}

fn subagent_result_text(messages: &[Message]) -> String {
    messages
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::Assistant { content, .. } => content.clone(),
            Message::User { .. } | Message::ToolResult(_) => None,
        })
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "subagent completed".to_owned())
}

fn push_subagent_user_message_locked(
    contexts: &mut HashMap<String, Vec<Message>>,
    subagent_id: &str,
    message: &str,
) -> Vec<Message> {
    let messages = contexts.entry(subagent_id.to_owned()).or_default();
    messages.push(Message::user(vec![ContentPart::text(
        subagent_task_instruction(message),
    )]));
    *messages = repair_provider_transcript(messages.clone());
    messages.clone()
}

fn spawn_subagent_loop(
    inner: Arc<ServiceInner>,
    subagent_id: String,
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: Arc<dyn Provider>,
    tools: Vec<Arc<dyn Tool>>,
    cancel: CancellationToken,
) {
    let Some(guard) = inner.register_service_worker(ServiceWorkerKind::SubagentRun) else {
        cancel.cancel();
        inner
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .remove(&subagent_id);
        return;
    };
    tokio::spawn(async move {
        let _guard = guard;
        run_subagent_loop(
            inner,
            subagent_id,
            config,
            initial_messages,
            provider,
            tools,
            cancel,
        )
        .await;
    });
}

async fn run_subagent_loop(
    inner: Arc<ServiceInner>,
    subagent_id: String,
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: Arc<dyn Provider>,
    tools: Vec<Arc<dyn Tool>>,
    cancel: CancellationToken,
) {
    let result = run_agent_with_shared_event_log(
        config,
        repair_provider_transcript(initial_messages),
        provider.as_ref(),
        tools,
        SharedAgentRunOptions {
            input_drainer: None,
            context_recorder: None,
            initial_current_request_start: None,
            initial_active_user_message_id: None,
            cancel,
            event_log: None,
            event_appender: None,
            event_notify: None,
            event_observer: None,
            background_host: Some(Arc::new(ServiceBackgroundExecutionHost {
                inner: inner.clone(),
                owner: TaskOwner::subagent(subagent_id.clone()),
            })),
            profiler: inner.profiler(),
            file_store: inner.file_store.clone(),
            preview_sink: None,
        },
    )
    .await;

    inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .remove(&subagent_id);

    if inner.is_failed() {
        match result {
            Ok(result) => {
                let messages = repair_provider_transcript(result.messages);
                let result_text = subagent_result_text(&messages);
                let _ = inner.finish_subagent_run_with_context(
                    &subagent_id,
                    SubagentRunTerminal::Completed(result_text),
                    messages,
                );
            }
            Err(error) if error.kind == AgentRunErrorKind::Cancelled => {
                if let Ok((_, _, Some(cancel))) = inner.cancel_subagent_lifecycle(&subagent_id) {
                    cancel.cancel();
                }
                inner
                    .background_tasks
                    .cancel_all_by_owner(&TaskOwner::subagent(subagent_id));
            }
            Err(error) => {
                let error_message = error.to_string();
                let messages = repair_provider_transcript(error.messages);
                let _ = inner.finish_subagent_run_with_context(
                    &subagent_id,
                    SubagentRunTerminal::Failed(error_message),
                    messages,
                );
            }
        }
        return;
    }

    match result {
        Ok(result) => {
            let messages = repair_provider_transcript(result.messages);
            let result_text = subagent_result_text(&messages);
            #[cfg(test)]
            inner.run_subagent_test_hook(SubagentTestHookKind::TerminalBeforeContextStore);
            let snapshot = match inner.finish_subagent_run_with_context(
                &subagent_id,
                SubagentRunTerminal::Completed(result_text),
                messages,
            ) {
                Ok(snapshot) => snapshot,
                Err(SubagentManagerError::Cancelled { .. }) => return,
                Err(_) => return,
            };
            #[cfg(test)]
            inner.run_subagent_test_hook(SubagentTestHookKind::TerminalStateBeforeAppend);
            let Some(snapshot) =
                inner.append_subagent_event_if_current_open("subagent.completed", &snapshot)
            else {
                return;
            };
            enqueue_subagent_callback(inner.clone(), &snapshot, "completed").await;
            maybe_start_next_subagent_run(inner, subagent_id);
        }
        Err(error) if error.kind == AgentRunErrorKind::Cancelled => {
            let Ok((snapshot, already_cancelled, cancel)) =
                inner.cancel_subagent_lifecycle(&subagent_id)
            else {
                return;
            };
            if let Some(cancel) = cancel {
                cancel.cancel();
            }
            inner
                .background_tasks
                .cancel_all_by_owner(&TaskOwner::subagent(subagent_id.clone()));
            if !already_cancelled {
                inner.append_subagent_event("subagent.cancelled", &snapshot);
            }
        }
        Err(error) => {
            let error_message = error.to_string();
            let messages = repair_provider_transcript(error.messages);
            #[cfg(test)]
            inner.run_subagent_test_hook(SubagentTestHookKind::TerminalBeforeContextStore);
            let snapshot = match inner.finish_subagent_run_with_context(
                &subagent_id,
                SubagentRunTerminal::Failed(error_message),
                messages,
            ) {
                Ok(snapshot) => snapshot,
                Err(SubagentManagerError::Cancelled { .. }) => return,
                Err(_) => return,
            };
            #[cfg(test)]
            inner.run_subagent_test_hook(SubagentTestHookKind::TerminalStateBeforeAppend);
            let Some(snapshot) =
                inner.append_subagent_event_if_current_open("subagent.failed", &snapshot)
            else {
                return;
            };
            enqueue_subagent_callback(inner.clone(), &snapshot, "failed").await;
            maybe_start_next_subagent_run(inner, subagent_id);
        }
    }
}

fn maybe_start_next_subagent_run(inner: Arc<ServiceInner>, subagent_id: String) {
    #[cfg(test)]
    inner.run_subagent_test_hook(SubagentTestHookKind::QueuedRunProviderClone);
    let Some(prepared) = inner.prepare_next_subagent_run(&subagent_id) else {
        return;
    };
    let snapshot = prepared.snapshot.clone();
    #[cfg(test)]
    inner.run_subagent_test_hook(SubagentTestHookKind::QueuedRunStateBeforeAppend);
    let Some((_, append)) =
        inner.append_subagent_event_outcome_if_current_open("subagent.started", &snapshot)
    else {
        prepared.cancel.cancel();
        return;
    };
    if !append.complete() {
        inner.fail_prepared_subagent_run_after_start_persistence_failure(
            prepared,
            append.event_written,
        );
        return;
    }
    inner.spawn_prepared_subagent_run(prepared);
}

async fn enqueue_subagent_callback(
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
    let content = vec![ContentPart::text(subagent_callback_body(
        snapshot,
        &callback_id,
        kind,
    ))];
    let Some((snapshot, status, start_cancel)) = enqueue_subagent_callback_input(
        inner.as_ref(),
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
    if !inner.append_subagent_callback_event_if_current_open(&snapshot, &callback_id, kind, &status)
    {
        rollback_enqueued_subagent_callback(inner.as_ref(), &snapshot.id, &callback_id, kind).await;
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

async fn enqueue_subagent_text_callback(
    inner: Arc<ServiceInner>,
    subagent_id: &str,
    kind: &'static str,
    text: String,
) -> bool {
    let snapshot = inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .snapshot(subagent_id);
    let Some(snapshot) = snapshot else {
        return false;
    };
    if snapshot.lifecycle == SubagentLifecycle::Cancelled {
        return false;
    }
    let callback_id = inner.next_subagent_callback_id();
    let body = format!(
        "<subagent_callback subagent_id=\"{}\" callback_id=\"{}\" kind=\"{}\" status=\"{}\" name=\"{}\">\n{}\n</subagent_callback>",
        xml_attr_escape(&snapshot.id),
        xml_attr_escape(&callback_id),
        kind,
        subagent_status_summary(&snapshot),
        xml_attr_escape(&snapshot.name),
        bounded_chars(&text, SUBAGENT_CALLBACK_TEXT_CHARS)
    );
    let Some((snapshot, status, start_cancel)) = enqueue_subagent_callback_input(
        inner.as_ref(),
        &snapshot.id,
        callback_id.clone(),
        kind,
        vec![ContentPart::text(body)],
    )
    .await
    else {
        return false;
    };
    #[cfg(test)]
    inner.run_subagent_test_hook(SubagentTestHookKind::CallbackRecordBeforeAppend);
    if !inner.append_subagent_callback_event_if_current_open(&snapshot, &callback_id, kind, &status)
    {
        rollback_enqueued_subagent_callback(inner.as_ref(), subagent_id, &callback_id, kind).await;
        if let Some(cancel) = start_cancel {
            cancel.cancel();
        }
        inner.cancel_active_turn_if_failed();
        inner.notify.notify_waiters();
        return false;
    }
    inner.notify.notify_waiters();
    if let Some(cancel) = start_cancel {
        spawn_service_loop(inner, cancel);
    }
    status == "queued"
}

async fn rollback_enqueued_subagent_callback(
    inner: &ServiceInner,
    subagent_id: &str,
    callback_id: &str,
    kind: &'static str,
) {
    let accepted = AcceptedInputEntry {
        message_id: callback_id.to_owned(),
        content: Vec::new(),
        cursor_seq: inner.last_event_seq(),
        source: InputSource::SubagentCallback,
        metadata: Some(QueuedInputMetadata::SubagentCallback {
            subagent_id: subagent_id.to_owned(),
            callback_id: callback_id.to_owned(),
            kind: kind.to_owned(),
        }),
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

fn callback_text(content: &[ContentPart]) -> String {
    content
        .iter()
        .filter_map(|part| match part {
            ContentPart::Text { text } => Some(text.as_str()),
            ContentPart::ImageUrl { .. }
            | ContentPart::ImageBase64 { .. }
            | ContentPart::File { .. }
            | ContentPart::Skill { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn subagent_task_callback_kind(state: TaskState) -> &'static str {
    match state {
        TaskState::Completed => "task_completed",
        TaskState::Failed => "task_failed",
        TaskState::TimedOut => "task_timed_out",
        TaskState::Cancelled | TaskState::Cancelling => "task_cancelled",
        TaskState::Running | TaskState::Lost => "task_failed",
    }
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
    format!(
        "<subagent_callback subagent_id=\"{}\" callback_id=\"{}\" kind=\"{}\" status=\"{}\" name=\"{}\">\n{}\n</subagent_callback>",
        xml_attr_escape(&snapshot.id),
        xml_attr_escape(callback_id),
        kind,
        status,
        xml_attr_escape(&snapshot.name),
        bounded_chars(body, SUBAGENT_CALLBACK_TEXT_CHARS)
    )
}

async fn run_service_loop(inner: Arc<ServiceInner>, cancel: CancellationToken) {
    let (
        config,
        initial_messages,
        replay_after_seq,
        initial_current_request_start,
        initial_active_user_message_id,
    ) = {
        let mut state = inner.state.lock().expect("service state mutex poisoned");
        if state.state == ServiceState::ShuttingDown {
            state.active_cancel = None;
            state.input_queue.clear_pending_batch();
            clear_active_turn(&mut state);
            inner.append_service_status_for_locked(&mut state, None);
            inner.notify.notify_waiters();
            return;
        }
        if state.state == ServiceState::Failed {
            state.active_cancel = None;
            state.input_queue.clear_pending_batch();
            clear_active_turn(&mut state);
            inner.append_service_status_for_locked(&mut state, None);
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
        let initial_active_user_message_id =
            restart_boundary.map(|boundary| boundary.active_user_message_id().to_owned());
        (
            inner.config.clone().with_turn_id(turn_id),
            initial_messages,
            inner.last_event_seq(),
            initial_current_request_start,
            initial_active_user_message_id,
        )
    };

    let result = run_agent_with_shared_event_log(
        config,
        initial_messages,
        inner.provider.as_ref(),
        inner.tools.clone(),
        SharedAgentRunOptions {
            input_drainer: Some(inner.as_ref()),
            context_recorder: inner
                .recorder
                .as_ref()
                .map(|recorder| recorder.as_ref() as &dyn AgentContextRecorder),
            initial_current_request_start,
            initial_active_user_message_id,
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
                            let message_id = format!("assistant_message_{}", event.seq);
                            inner
                                .task_observer
                                .publish_final_text(FinalTextObservation {
                                    kind: FinalTextObservationKind::AssistantText,
                                    text: &text,
                                    message_id: Some(&message_id),
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
    )
    .await;

    let replay_persist_error = persist_public_replay(&inner, replay_after_seq)
        .err()
        .map(|message| format!("failed to persist public event replay: {message}"));

    let next_cancel = {
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
        } else if let Some(error_message) = replay_persist_error {
            match result {
                Ok(result) => state.context = repair_provider_transcript(result.messages),
                Err(error) => state.context = repair_provider_transcript(error.messages),
            }
            state.last_error = Some(error_message);
            state.state = ServiceState::Failed;
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
                    state.context = repair_provider_transcript(error.messages);
                    match error.kind {
                        AgentRunErrorKind::Cancelled => {
                            if state.input_queue.is_empty() {
                                state.state = ServiceState::Idle;
                                clear_active_turn(&mut state);
                                None
                            } else {
                                Some(start_followup_turn(&mut state))
                            }
                        }
                        AgentRunErrorKind::ProviderStop { .. } => {
                            state.last_error = Some(error_message);
                            state.state = ServiceState::Failed;
                            clear_active_turn(&mut state);
                            None
                        }
                        AgentRunErrorKind::Provider { .. } => {
                            state.last_error = Some(error_message);
                            if state.input_queue.is_empty() {
                                state.state = ServiceState::Idle;
                                clear_active_turn(&mut state);
                                None
                            } else {
                                Some(start_followup_turn(&mut state))
                            }
                        }
                        AgentRunErrorKind::Persistence { .. } => {
                            state.last_error = Some(error_message);
                            state.state = ServiceState::Failed;
                            clear_active_turn(&mut state);
                            None
                        }
                    }
                }
            }
        };
        let turn_id = state.active_turn_id.clone();
        if inner
            .append_service_status_for_locked(&mut state, turn_id.as_deref())
            .is_some()
        {
            next_cancel
        } else {
            None
        }
    };

    if !inner.is_shutting_down() {
        retry_pending_task_callbacks(inner.clone()).await;
    }
    inner.notify.notify_waiters();
    if let Some(cancel) = next_cancel {
        spawn_service_loop(inner, cancel);
    }
}

fn spawn_service_loop(inner: Arc<ServiceInner>, cancel: CancellationToken) {
    let Some(guard) = inner.register_service_worker(ServiceWorkerKind::AgentLoop) else {
        return;
    };
    tokio::spawn(async move {
        let _guard = guard;
        run_service_loop(inner, cancel).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::profiling::{resolve_profiling_config, CsvProfiler};
    use crate::provider::{ProviderError, ProviderRequest, ProviderResponse};
    use crate::session::{open_or_create_session_in_home_with_cwd, SessionFileIo};
    use crate::types::StopReason;
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize},
        Condvar,
    };
    use tokio::sync::oneshot;

    struct PanicProvider;

    #[async_trait]
    impl Provider for PanicProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _cancel: CancellationToken,
        ) -> Result<ProviderResponse, ProviderError> {
            panic!("provider should not be called")
        }
    }

    struct TextProvider(&'static str);

    #[async_trait]
    impl Provider for TextProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _cancel: CancellationToken,
        ) -> Result<ProviderResponse, ProviderError> {
            Ok(ProviderResponse::text(self.0))
        }
    }

    struct CountingProvider {
        calls: AtomicUsize,
    }

    impl CountingProvider {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl Provider for CountingProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _cancel: CancellationToken,
        ) -> Result<ProviderResponse, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ProviderResponse::text("ok"))
        }
    }

    struct EmptyAssistantToolCallProvider {
        calls: AtomicUsize,
    }

    impl EmptyAssistantToolCallProvider {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl Provider for EmptyAssistantToolCallProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _cancel: CancellationToken,
        ) -> Result<ProviderResponse, ProviderError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                return Ok(ProviderResponse {
                    text: Some(String::new()),
                    tool_calls: vec![ToolCall::new(
                        "call_empty_text_task_list",
                        "task_list",
                        json!({}),
                    )],
                    assistant_replay: None,
                    usage: None,
                    stop_reason: StopReason::ToolCalls,
                    metadata: None,
                });
            }

            Ok(ProviderResponse {
                text: None,
                tool_calls: Vec::new(),
                assistant_replay: None,
                usage: None,
                stop_reason: StopReason::EndTurn,
                metadata: None,
            })
        }
    }

    struct TaskObserveToolProvider {
        task_id: Arc<Mutex<Option<String>>>,
        calls: AtomicUsize,
    }

    impl TaskObserveToolProvider {
        fn new(task_id: Arc<Mutex<Option<String>>>) -> Self {
            Self {
                task_id,
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl Provider for TaskObserveToolProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _cancel: CancellationToken,
        ) -> Result<ProviderResponse, ProviderError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                let task_id = self
                    .task_id
                    .lock()
                    .expect("task id mutex poisoned")
                    .clone()
                    .expect("task id should be installed before provider call");
                return Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
                    "call_enable_observer",
                    "task_observe",
                    json!({
                        "task_id": task_id,
                        "enabled": true,
                        "mode": "final"
                    }),
                )]));
            }

            Ok(ProviderResponse::text("observer tool enabled"))
        }
    }

    struct FailingSyncSessionFile;

    impl SessionFileIo for FailingSyncSessionFile {
        fn len(&mut self) -> io::Result<u64> {
            Ok(0)
        }

        fn write_line(&mut self, _line: &str) -> io::Result<()> {
            Ok(())
        }

        fn write_bytes(&mut self, _bytes: &[u8]) -> io::Result<()> {
            Ok(())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn sync_data(&mut self) -> io::Result<()> {
            Err(io::Error::other("sync_data failed"))
        }

        fn set_len(&mut self, _len: u64) -> io::Result<()> {
            Ok(())
        }
    }

    struct FailingPendingRemovalRecorder;

    #[async_trait]
    impl AgentContextRecorder for FailingPendingRemovalRecorder {
        async fn record_message(&self, _message: &Message) -> Result<(), AgentCommitError> {
            Ok(())
        }

        async fn record_accepted_input(
            &self,
            _entry: &AcceptedInputEntry,
        ) -> Result<(), AgentCommitError> {
            Ok(())
        }

        async fn record_pending_input_removed(
            &self,
            _message_id: &str,
            _source: InputSource,
            _metadata: Option<&QueuedInputMetadata>,
            _reason: &str,
        ) -> Result<(), AgentCommitError> {
            Err(AgentCommitError::new("pending removal write failed"))
        }

        async fn record_user_batch_with_ids(
            &self,
            messages: &[Message],
            message_ids: &[String],
        ) -> Result<(), AgentCommitError> {
            if messages.len() != message_ids.len() {
                return Err(AgentCommitError::new(
                    "user batch message id count does not match message count",
                ));
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct RollbackSetLenFailureSessionFile {
        bytes: Vec<u8>,
    }

    impl SessionFileIo for RollbackSetLenFailureSessionFile {
        fn len(&mut self) -> io::Result<u64> {
            Ok(self.bytes.len() as u64)
        }

        fn write_line(&mut self, line: &str) -> io::Result<()> {
            self.bytes.extend_from_slice(line.as_bytes());
            self.bytes.push(b'\n');
            Ok(())
        }

        fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
            self.bytes.extend_from_slice(bytes);
            Ok(())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn sync_data(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn set_len(&mut self, _len: u64) -> io::Result<()> {
            Err(io::Error::other("rollback set_len failed"))
        }
    }

    struct FailingProvider;

    #[async_trait]
    impl Provider for FailingProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _cancel: CancellationToken,
        ) -> Result<ProviderResponse, ProviderError> {
            Err(ProviderError::request_failed("provider failed"))
        }
    }

    fn install_subagent_cancel_hook(
        service: &Service,
        kind: SubagentTestHookKind,
        subagent_id: String,
    ) {
        let inner = service.inner.clone();
        service.inner.set_subagent_test_hook(
            kind,
            Arc::new(move || {
                let _ = inner.cancel_subagent_tool_result(
                    ToolCall::new(
                        "race_cancel",
                        "subagent_cancel",
                        json!({"subagent_id": subagent_id}),
                    ),
                    &subagent_id,
                );
            }),
        );
    }

    fn assert_subagent_runtime_resources_absent(service: &Service, subagent_id: &str) {
        assert!(!service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .contains_key(subagent_id));
        assert!(!service
            .inner
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .contains_key(subagent_id));
        assert!(!service
            .inner
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .contains_key(subagent_id));
    }

    fn tool_text_json(result: &ToolResult) -> Value {
        let parsed: Value = serde_json::from_str(&result.text).expect("tool text should be JSON");
        assert_eq!(parsed, result.details);
        parsed
    }

    fn service_test_home(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "botified-service-{name}-{}-{stamp}",
            std::process::id()
        ))
    }

    fn open_test_subagent(service: &Service, name: &str) -> SubagentSnapshot {
        service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open(name, "callback early return")
            .expect("open subagent")
    }

    fn install_callback_outcome_state_unlocked_assertion(service: &Service) -> Arc<AtomicUsize> {
        let checks = Arc::new(AtomicUsize::new(0));
        let checks_for_hook = checks.clone();
        let inner = service.inner.clone();
        service.inner.set_subagent_test_hook(
            SubagentTestHookKind::CallbackOutcomeBeforeLifecycle,
            Arc::new(move || {
                checks_for_hook.fetch_add(1, Ordering::SeqCst);
                assert!(
                    inner.state.try_lock().is_ok(),
                    "subagent callback outcome must be recorded after releasing service state"
                );
            }),
        );
        checks
    }

    fn assert_recorded_callback(
        service: &Service,
        subagent_id: &str,
        callback_id: &str,
        status: SubagentCallbackStatus,
    ) {
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(subagent_id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.callback_count, 1);
        let callback = snapshot
            .callbacks
            .last()
            .expect("callback summary should be recorded");
        assert_eq!(callback.callback_id, callback_id);
        assert_eq!(callback.status, status);
    }

    fn assert_subagent_not_reactivated_after_cancel(
        service: &Service,
        before_seq: u64,
        subagent_id: &str,
        stale_event_type: &str,
    ) {
        let events = service.events_after(before_seq);
        let cancel_index = events
            .iter()
            .position(|event| {
                event.event_type == "subagent.cancelled"
                    && event.data["subagent_id"] == json!(subagent_id)
            })
            .unwrap_or_else(|| panic!("subagent.cancelled should be emitted: {events:?}"));
        assert!(
            !events.iter().skip(cancel_index + 1).any(|event| {
                event.event_type == stale_event_type
                    && event.data["subagent_id"] == json!(subagent_id)
            }),
            "stale {stale_event_type} must not be appended after cancellation: {events:?}"
        );

        let state = service.timeline_bootstrap_snapshot();
        let active_items = state["active_items"]
            .as_array()
            .expect("active_items should be an array");
        let item_id = format!("subagent_{subagent_id}");
        assert!(
            !active_items.iter().any(|item| item["id"] == json!(item_id)),
            "cancelled subagent must not be active after stale event window: {active_items:?}"
        );
    }

    #[tokio::test]
    async fn subagent_callbacks_use_independent_ids_even_when_event_seq_based_id_would_conflict() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-callback-ids"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let snapshot = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            let running = manager
                .spawn("Reviewer", "review callback ids")
                .expect("spawn subagent");
            manager
                .complete(&running.id, "callback body")
                .expect("complete subagent")
        };
        let cursor_event = service
            .inner
            .append_event_for_turn(None, "test.cursor", json!({}));
        let legacy_event_seq_id = format!(
            "subagent_callback_{}_{}_{}",
            snapshot.id,
            "completed",
            service.inner.last_event_seq().saturating_add(1)
        );
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            insert_message_index_entry(
                &mut state.message_index,
                legacy_event_seq_id.clone(),
                vec![ContentPart::text("pre-existing different content")],
                timeline_cursor_for_event(service.inner.as_ref(), &cursor_event),
            );
        }
        let before_seq = service.inner.last_event_seq();

        enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;
        enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&snapshot.id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.callback_count, 2);
        assert_eq!(snapshot.pending_callback_count, 2);
        assert_eq!(snapshot.failed_callback_count, 0);
        assert_eq!(snapshot.callbacks.len(), 2);
        assert_ne!(
            snapshot.callbacks[0].callback_id,
            snapshot.callbacks[1].callback_id
        );
        assert!(!snapshot
            .callbacks
            .iter()
            .any(|callback| callback.callback_id == legacy_event_seq_id));
        assert!(!service
            .events_after(before_seq)
            .iter()
            .any(|event| event.data["reason"] == json!("message_conflict")));
    }

    #[tokio::test]
    async fn subagent_callback_ids_do_not_collide_with_old_unretained_session_ids_after_restart() {
        let home = service_test_home("subagent-callback-restart-id-collision");
        let legacy_callback_id = "subagent_callback_sa_000001_completed_1".to_owned();
        let legacy_content = vec![ContentPart::text("historic callback body")];
        let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
            .expect("session should open");
        session
            .recorder()
            .record_accepted_input_sync(&AcceptedInputEntry {
                message_id: legacy_callback_id.clone(),
                content: legacy_content.clone(),
                cursor_seq: 1,
                source: InputSource::SubagentCallback,
                metadata: Some(QueuedInputMetadata::SubagentCallback {
                    subagent_id: "sa_000001".to_owned(),
                    callback_id: legacy_callback_id.clone(),
                    kind: "completed".to_owned(),
                }),
                urgency: InputUrgency::Normal,
            })
            .expect("legacy callback accepted input should persist");
        session
            .recorder()
            .record_user_batch_with_ids_sync(
                &[Message::user(legacy_content)],
                std::slice::from_ref(&legacy_callback_id),
            )
            .expect("legacy callback should be committed");

        for index in 0..(DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW + 4) {
            let message_id = format!("historic_msg_{index}");
            let content = vec![ContentPart::text(format!("historic message {index}"))];
            session
                .recorder()
                .record_accepted_input_sync(&AcceptedInputEntry {
                    message_id: message_id.clone(),
                    content: content.clone(),
                    cursor_seq: index as u64 + 2,
                    source: InputSource::User,
                    metadata: None,
                    urgency: InputUrgency::Normal,
                })
                .expect("historic accepted input should persist");
            session
                .recorder()
                .record_user_batch_with_ids_sync(
                    &[Message::user(content)],
                    std::slice::from_ref(&message_id),
                )
                .expect("historic message should be committed");
        }
        session
            .recorder()
            .record_compaction_sync(&[ContentPart::text("summary")], &[])
            .expect("session should compact");
        drop(session);

        let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
            .expect("session should reopen before new callback");
        assert!(
            reopened
                .known_user_messages()
                .iter()
                .all(|message| message.id != legacy_callback_id),
            "legacy callback id must be outside the retained message index"
        );

        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            reopened.initial_messages().to_vec(),
            reopened.pending_messages().to_vec(),
            reopened.known_user_messages().to_vec(),
            reopened.message_cursors().to_vec(),
            Some(reopened.recorder()),
            reopened.warnings().to_vec(),
            ServiceLimits::default(),
        );
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_restart_callback".to_owned());
            state.active_cancel = Some(CancellationToken::new());
        }
        let snapshot = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            let running = manager
                .spawn("Reviewer", "review callback ids")
                .expect("spawn subagent");
            manager
                .complete(&running.id, "callback body")
                .expect("complete subagent")
        };

        enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

        let entries = fs::read_to_string(home.join("sessions/service-test.jsonl"))
            .expect("session should read")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("session line should parse"))
            .collect::<Vec<_>>();
        let subagent_callback_ids = entries
            .iter()
            .filter(|entry| {
                entry["type"] == "accepted_input" && entry["source"] == "subagent_callback"
            })
            .filter_map(|entry| entry["message_id"].as_str())
            .collect::<Vec<_>>();
        assert!(subagent_callback_ids.contains(&legacy_callback_id.as_str()));
        let new_callback_id = subagent_callback_ids
            .last()
            .expect("new callback accepted input should be recorded");
        assert_ne!(*new_callback_id, legacy_callback_id);
        assert!(new_callback_id.starts_with("subagent_callback_"));

        open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
            .expect("session should reopen after new callback without id collision");
    }

    #[tokio::test]
    async fn subagent_callback_early_returns_record_outcome_after_state_lock_is_released() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-empty-callback"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let snapshot = open_test_subagent(&service, "Empty");
        let checks = install_callback_outcome_state_unlocked_assertion(&service);
        let callback_id = "subagent_callback_empty".to_owned();

        let (_, status, _) = enqueue_subagent_callback_input(
            service.inner.as_ref(),
            &snapshot.id,
            callback_id.clone(),
            "completed",
            Vec::new(),
        )
        .await
        .expect("empty callback should still record outcome");

        assert_eq!(status, "failed");
        assert_eq!(checks.load(Ordering::SeqCst), 1);
        assert_recorded_callback(
            &service,
            &snapshot.id,
            &callback_id,
            SubagentCallbackStatus::Failed,
        );

        let service = Service::with_limits(
            AgentConfig::new("system").with_session("service-queue-full-callback"),
            Arc::new(PanicProvider),
            Vec::new(),
            ServiceLimits::new(1),
        );
        let snapshot = open_test_subagent(&service, "QueueFull");
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_queue_full".to_owned());
            state.active_cancel = Some(CancellationToken::new());
            state.input_queue.enqueue(QueuedMessage {
                id: "queued_user".to_owned(),
                content: vec![ContentPart::text("queued")],
                source: InputSource::User,
                urgency: InputUrgency::Normal,
                metadata: None,
                cursor_seq: service.inner.last_event_seq(),
            });
        }
        let checks = install_callback_outcome_state_unlocked_assertion(&service);
        let callback_id = "subagent_callback_queue_full".to_owned();

        let (_, status, _) = enqueue_subagent_callback_input(
            service.inner.as_ref(),
            &snapshot.id,
            callback_id.clone(),
            "completed",
            vec![ContentPart::text("callback body")],
        )
        .await
        .expect("queue-full callback should still record outcome");

        assert_eq!(status, "queue_full");
        assert_eq!(checks.load(Ordering::SeqCst), 1);
        assert_recorded_callback(
            &service,
            &snapshot.id,
            &callback_id,
            SubagentCallbackStatus::Failed,
        );

        let service = Service::new(
            AgentConfig::new("system").with_session("service-shutdown-callback"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let snapshot = open_test_subagent(&service, "Shutdown");
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::ShuttingDown;
        }
        let checks = install_callback_outcome_state_unlocked_assertion(&service);
        let callback_id = "subagent_callback_shutdown".to_owned();

        let (_, status, _) = enqueue_subagent_callback_input(
            service.inner.as_ref(),
            &snapshot.id,
            callback_id.clone(),
            "completed",
            vec![ContentPart::text("callback body")],
        )
        .await
        .expect("shutdown callback should still record outcome");

        assert_eq!(status, "failed");
        assert_eq!(checks.load(Ordering::SeqCst), 1);
        assert_recorded_callback(
            &service,
            &snapshot.id,
            &callback_id,
            SubagentCallbackStatus::Failed,
        );

        let service = Service::new(
            AgentConfig::new("system").with_session("service-duplicate-callback"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let snapshot = open_test_subagent(&service, "Duplicate");
        let callback_id = "subagent_callback_duplicate".to_owned();
        let content = vec![ContentPart::text("duplicate body")];
        let cursor_event = service
            .inner
            .append_event_for_turn(None, "test.cursor", json!({}));
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            insert_message_index_entry(
                &mut state.message_index,
                callback_id.clone(),
                content.clone(),
                timeline_cursor_for_event(service.inner.as_ref(), &cursor_event),
            );
        }
        let checks = install_callback_outcome_state_unlocked_assertion(&service);

        let (_, status, _) = enqueue_subagent_callback_input(
            service.inner.as_ref(),
            &snapshot.id,
            callback_id.clone(),
            "completed",
            content,
        )
        .await
        .expect("duplicate callback should still record outcome");

        assert_eq!(status, "queued");
        assert_eq!(checks.load(Ordering::SeqCst), 1);
        assert_recorded_callback(
            &service,
            &snapshot.id,
            &callback_id,
            SubagentCallbackStatus::Pending,
        );
    }

    #[test]
    fn repeated_subagent_cancel_appends_cancelled_event_once() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-cancel-idempotent"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Reviewer", "review cancellation")
            .expect("open subagent")
            .id;
        let before_cancel_seq = service.inner.last_event_seq();

        let first = service.inner.cancel_subagent_tool_result(
            ToolCall::new(
                "cancel_1",
                "subagent_cancel",
                json!({"subagent_id": subagent_id}),
            ),
            &subagent_id,
        );
        assert!(!first.is_error, "{first:?}");

        let second = service.inner.cancel_subagent_tool_result(
            ToolCall::new(
                "cancel_2",
                "subagent_cancel",
                json!({"subagent_id": subagent_id}),
            ),
            &subagent_id,
        );
        assert!(!second.is_error, "{second:?}");

        let cancel_events = service
            .events_after(before_cancel_seq)
            .into_iter()
            .filter(|event| event.event_type == "subagent.cancelled")
            .collect::<Vec<_>>();
        assert_eq!(
            cancel_events.len(),
            1,
            "repeated cancel should not append duplicate lifecycle terminal events: {cancel_events:?}"
        );
    }

    #[test]
    fn subagent_cancel_releases_context_provider_cancel_token_and_all_owned_tasks_idempotently() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-cancel-cleanup"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Reviewer", "review cleanup")
            .expect("open subagent")
            .id;
        let subagent_cancel = CancellationToken::new();
        service
            .inner
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .insert(subagent_id.clone(), subagent_cancel.clone());
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(
                subagent_id.clone(),
                vec![Message::user(vec![ContentPart::text("ctx")])],
            );
        service
            .inner
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .insert(subagent_id.clone(), Arc::new(PanicProvider));

        let owner = TaskOwner::subagent(subagent_id.clone());
        let owned_tokens = (0..200)
            .map(|index| {
                let token = CancellationToken::new();
                let task_id = format!("owned_task_{index:03}");
                service.inner.background_tasks.start_task_with_id(
                    task_id.clone(),
                    NewBackgroundTask::new(format!("call_{index:03}"), "bash", "{}")
                        .with_owner(owner.clone())
                        .with_cancel_token(token.clone()),
                );
                service
                    .inner
                    .subagents
                    .lock()
                    .expect("subagent manager mutex poisoned")
                    .add_owned_task_id(&subagent_id, task_id)
                    .expect("owned task id should attach");
                token
            })
            .collect::<Vec<_>>();

        let first = service.inner.cancel_subagent_tool_result(
            ToolCall::new(
                "cancel_cleanup_1",
                "subagent_cancel",
                json!({"subagent_id": subagent_id}),
            ),
            &subagent_id,
        );
        assert!(!first.is_error, "{first:?}");
        assert!(subagent_cancel.is_cancelled());
        assert!(!service
            .inner
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .contains_key(&subagent_id));
        assert!(!service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .contains_key(&subagent_id));
        assert!(!service
            .inner
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .contains_key(&subagent_id));
        assert!(
            owned_tokens.iter().all(CancellationToken::is_cancelled),
            "subagent_cancel must cancel every non-terminal task owned by the branch"
        );

        let second = service.inner.cancel_subagent_tool_result(
            ToolCall::new(
                "cancel_cleanup_2",
                "subagent_cancel",
                json!({"subagent_id": subagent_id}),
            ),
            &subagent_id,
        );
        assert!(!second.is_error, "{second:?}");
        assert!(!service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .contains_key(&subagent_id));
        assert!(!service
            .inner
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .contains_key(&subagent_id));
    }

    #[tokio::test]
    async fn subagent_owned_task_cancel_appends_callback_after_releasing_subagent_manager_lock() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-task-cancel-lock-order"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("TaskCancel", "task cancel lock order")
            .expect("open subagent")
            .id;
        let owner = TaskOwner::subagent(subagent_id.clone());
        let cancel = CancellationToken::new();
        service.inner.background_tasks.start_task_with_id(
            "task_lock_order".to_owned(),
            NewBackgroundTask::new("call_lock_order", "bash", "{}")
                .with_owner(owner.clone())
                .with_cancel_token(cancel.clone()),
        );
        service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .add_owned_task_id(&subagent_id, "task_lock_order")
            .expect("owned task should attach");
        let tool = ServiceTaskCancelTool::new(
            service.inner.background_tasks.clone(),
            Arc::downgrade(&service.inner),
            owner,
        );
        let before_seq = service.inner.last_event_seq();

        let result = tool
            .execute(
                ToolCall::new(
                    "cancel_task_lock_order",
                    "task_cancel",
                    json!({"task_id": "task_lock_order"}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("task cancel tool should return");

        assert!(!result.is_error, "{result:?}");
        assert!(cancel.is_cancelled());
        assert!(
            service
                .events_after(before_seq)
                .iter()
                .any(|event| event.event_type == "subagent.callback"
                    && event.data["subagent_id"] == json!(subagent_id)),
            "subagent-owned task cancel should append a callback summary event"
        );
    }

    #[tokio::test]
    async fn cancelled_subagent_late_success_does_not_restore_context_or_enqueue_callback() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-late-success"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            let snapshot = manager
                .spawn("Late", "late success")
                .expect("spawn subagent");
            manager.cancel(&snapshot.id).expect("cancel subagent");
            snapshot.id
        };
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .remove(&subagent_id);
        service
            .inner
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .remove(&subagent_id);
        let before_seq = service.inner.last_event_seq();

        run_subagent_loop(
            service.inner.clone(),
            subagent_id.clone(),
            service.inner.subagent_config(),
            vec![Message::user(vec![ContentPart::text("late success")])],
            Arc::new(TextProvider("late result")),
            Vec::new(),
            CancellationToken::new(),
        )
        .await;

        assert!(!service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .contains_key(&subagent_id));
        assert!(!service
            .inner
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .contains_key(&subagent_id));
        let events = service.events_after(before_seq);
        assert!(!events
            .iter()
            .any(|event| event.event_type == "subagent.completed"));
        assert!(!events
            .iter()
            .any(|event| event.event_type == "subagent.callback"));
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.callback_count, 0);
    }

    #[tokio::test]
    async fn subagent_cancel_between_success_and_context_store_does_not_restore_context() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-success-store-race"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            manager
                .spawn("Race", "success context race")
                .expect("spawn subagent")
                .id
        };
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(
                subagent_id.clone(),
                vec![Message::user(vec![ContentPart::text("initial")])],
            );
        install_subagent_cancel_hook(
            &service,
            SubagentTestHookKind::TerminalBeforeContextStore,
            subagent_id.clone(),
        );
        let before_seq = service.inner.last_event_seq();

        run_subagent_loop(
            service.inner.clone(),
            subagent_id.clone(),
            service.inner.subagent_config(),
            vec![Message::user(vec![ContentPart::text("late success")])],
            Arc::new(TextProvider("late result")),
            Vec::new(),
            CancellationToken::new(),
        )
        .await;

        assert_subagent_runtime_resources_absent(&service, &subagent_id);
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        assert!(!service
            .events_after(before_seq)
            .iter()
            .any(|event| event.event_type == "subagent.completed"));
    }

    #[tokio::test]
    async fn subagent_cancel_between_failure_and_context_store_does_not_restore_context() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-failure-store-race"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            manager
                .spawn("Race", "failure context race")
                .expect("spawn subagent")
                .id
        };
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(
                subagent_id.clone(),
                vec![Message::user(vec![ContentPart::text("initial")])],
            );
        install_subagent_cancel_hook(
            &service,
            SubagentTestHookKind::TerminalBeforeContextStore,
            subagent_id.clone(),
        );
        let before_seq = service.inner.last_event_seq();

        run_subagent_loop(
            service.inner.clone(),
            subagent_id.clone(),
            service.inner.subagent_config(),
            vec![Message::user(vec![ContentPart::text("late failure")])],
            Arc::new(FailingProvider),
            Vec::new(),
            CancellationToken::new(),
        )
        .await;

        assert_subagent_runtime_resources_absent(&service, &subagent_id);
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        assert!(!service
            .events_after(before_seq)
            .iter()
            .any(|event| event.event_type == "subagent.failed"));
    }

    #[tokio::test]
    async fn subagent_cancel_after_success_state_before_event_does_not_append_stale_completed() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-success-event-race"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            manager
                .spawn("Race", "success event race")
                .expect("spawn subagent")
                .id
        };
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(
                subagent_id.clone(),
                vec![Message::user(vec![ContentPart::text("initial")])],
            );
        install_subagent_cancel_hook(
            &service,
            SubagentTestHookKind::TerminalStateBeforeAppend,
            subagent_id.clone(),
        );
        let before_seq = service.inner.last_event_seq();

        run_subagent_loop(
            service.inner.clone(),
            subagent_id.clone(),
            service.inner.subagent_config(),
            vec![Message::user(vec![ContentPart::text("late success")])],
            Arc::new(TextProvider("late result")),
            Vec::new(),
            CancellationToken::new(),
        )
        .await;

        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        assert_subagent_not_reactivated_after_cancel(
            &service,
            before_seq,
            &subagent_id,
            "subagent.completed",
        );
    }

    #[tokio::test]
    async fn subagent_cancel_after_failure_state_before_event_does_not_append_stale_failed() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-failure-event-race"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            manager
                .spawn("Race", "failure event race")
                .expect("spawn subagent")
                .id
        };
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(
                subagent_id.clone(),
                vec![Message::user(vec![ContentPart::text("initial")])],
            );
        install_subagent_cancel_hook(
            &service,
            SubagentTestHookKind::TerminalStateBeforeAppend,
            subagent_id.clone(),
        );
        let before_seq = service.inner.last_event_seq();

        run_subagent_loop(
            service.inner.clone(),
            subagent_id.clone(),
            service.inner.subagent_config(),
            vec![Message::user(vec![ContentPart::text("late failure")])],
            Arc::new(FailingProvider),
            Vec::new(),
            CancellationToken::new(),
        )
        .await;

        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        assert_subagent_not_reactivated_after_cancel(
            &service,
            before_seq,
            &subagent_id,
            "subagent.failed",
        );
    }

    #[tokio::test]
    async fn subagent_token_cancel_marks_branch_cancelled_and_removes_runtime_resources() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-token-cancel"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_subagent_token_cancel".to_owned());
            state.active_cancel = Some(CancellationToken::new());
        }
        let subagent_id = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            manager
                .spawn("TokenCancel", "cancel token race")
                .expect("spawn subagent")
                .id
        };
        let cancel = CancellationToken::new();
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(
                subagent_id.clone(),
                vec![Message::user(vec![ContentPart::text("initial")])],
            );
        service
            .inner
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .insert(subagent_id.clone(), Arc::new(PanicProvider));
        service
            .inner
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .insert(subagent_id.clone(), cancel.clone());
        cancel.cancel();
        let before_seq = service.inner.last_event_seq();

        run_subagent_loop(
            service.inner.clone(),
            subagent_id.clone(),
            service.inner.subagent_config(),
            vec![Message::user(vec![ContentPart::text("will cancel")])],
            Arc::new(PanicProvider),
            Vec::new(),
            cancel,
        )
        .await;

        assert_subagent_runtime_resources_absent(&service, &subagent_id);
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        assert_eq!(snapshot.run_state, SubagentRunState::Idle);
        assert_eq!(snapshot.callback_count, 0);
        let events = service.events_after(before_seq);
        assert!(events
            .iter()
            .any(|event| event.event_type == "subagent.cancelled"));
        assert!(!events
            .iter()
            .any(|event| event.event_type == "subagent.failed"));
        assert!(!events
            .iter()
            .any(|event| event.event_type == "subagent.callback"));
    }

    #[test]
    fn subagent_cancel_during_owned_task_publish_does_not_leave_orphan_running_task() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-task-publish-race"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Worker", "publish task race")
            .expect("open subagent")
            .id;
        {
            let inner = service.inner.clone();
            let subagent_id = subagent_id.clone();
            service.inner.set_subagent_test_hook(
                SubagentTestHookKind::SubagentPublishOpenCheck,
                Arc::new(move || {
                    inner
                        .subagents
                        .lock()
                        .expect("subagent manager mutex poisoned")
                        .cancel(&subagent_id)
                        .expect("cancel subagent");
                    inner
                        .subagent_contexts
                        .lock()
                        .expect("subagent contexts mutex poisoned")
                        .remove(&subagent_id);
                    inner
                        .subagent_providers
                        .lock()
                        .expect("subagent providers mutex poisoned")
                        .remove(&subagent_id);
                    inner
                        .subagent_cancels
                        .lock()
                        .expect("subagent cancels mutex poisoned")
                        .remove(&subagent_id);
                    inner
                        .background_tasks
                        .cancel_all_by_owner(&TaskOwner::subagent(subagent_id.clone()));
                }),
            );
        }
        let host = ServiceBackgroundExecutionHost {
            inner: service.inner.clone(),
            owner: TaskOwner::subagent(subagent_id.clone()),
        };
        let cancel = CancellationToken::new();

        let published = host.publish_task(
            "orphan_task".to_owned(),
            NewBackgroundTask::new("orphan_call", "bash", "{}").with_cancel_token(cancel.clone()),
        );

        assert!(!published);
        assert!(cancel.is_cancelled());
        assert!(service.inner.background_tasks.get("orphan_task").is_none());
        assert_subagent_runtime_resources_absent(&service, &subagent_id);
    }

    #[test]
    fn subagent_owned_task_publish_event_failure_fails_task_without_running() {
        let service = Service::new(
            AgentConfig::new("system")
                .with_session("service-subagent-task-publish-persistence-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Worker", "publish task persistence failure")
            .expect("open subagent")
            .id;
        let host = ServiceBackgroundExecutionHost {
            inner: service.inner.clone(),
            owner: TaskOwner::subagent(subagent_id.clone()),
        };
        let cancel = CancellationToken::new();
        let before_seq = service.inner.last_event_seq();
        service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

        let published = host.publish_task(
            "failed_publish_task".to_owned(),
            NewBackgroundTask::new("failed_publish_call", "bash", "{}")
                .with_cancel_token(cancel.clone()),
        );

        assert!(!published);
        assert!(cancel.is_cancelled());
        let task = service
            .inner
            .background_tasks
            .get("failed_publish_task")
            .expect("failed task retained for inspection");
        assert_eq!(task.owner, TaskOwner::subagent(subagent_id.clone()));
        assert_eq!(task.state, TaskState::Failed);
        assert_eq!(service.status().state, ServiceState::Failed);
        let events = service.events_after(before_seq);
        assert!(!events
            .iter()
            .any(|event| event.event_type == "subagent.callback"));
        assert_subagent_runtime_resources_absent(&service, &subagent_id);
    }

    #[test]
    fn subagent_owned_task_publish_status_failure_records_terminal_compensation() {
        let service = Service::new(
            AgentConfig::new("system")
                .with_session("service-subagent-task-publish-status-persistence-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Worker", "publish task status persistence failure")
            .expect("open subagent")
            .id;
        let host = ServiceBackgroundExecutionHost {
            inner: service.inner.clone(),
            owner: TaskOwner::subagent(subagent_id.clone()),
        };
        let cancel = CancellationToken::new();
        let before_seq = service.inner.last_event_seq();
        service.inject_timeline_write_failure_after_events(1, TimelineWriteFailure::Flush);

        let published = host.publish_task(
            "failed_status_task".to_owned(),
            NewBackgroundTask::new("failed_status_call", "bash", "{}")
                .with_cancel_token(cancel.clone()),
        );

        assert!(!published);
        assert!(cancel.is_cancelled());
        let task = service
            .inner
            .background_tasks
            .get("failed_status_task")
            .expect("failed task retained for inspection");
        assert_eq!(task.owner, TaskOwner::subagent(subagent_id.clone()));
        assert_eq!(task.state, TaskState::Failed);
        assert_eq!(service.status().state, ServiceState::Failed);
        let events = service.events_after(before_seq);
        assert!(events
            .iter()
            .any(|event| event.event_type == "subagent.callback"));
        let task_failed = events
            .iter()
            .find(|event| event.event_type == "subagent.task_failed")
            .expect("status failure after subagent task publication needs terminal compensation");
        assert_eq!(task_failed.data["task_id"], json!("failed_status_task"));
        assert_eq!(task_failed.data["task_status"], json!("failed"));
        assert_subagent_runtime_resources_absent(&service, &subagent_id);
    }

    #[test]
    fn subagent_owned_task_publish_rejects_failed_service_without_starting_task() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-task-publish-failed-service"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Worker", "failed service publish")
            .expect("open subagent")
            .id;
        service.inner.mark_failed("timeline persistence failed");
        let host = ServiceBackgroundExecutionHost {
            inner: service.inner.clone(),
            owner: TaskOwner::subagent(subagent_id),
        };
        let cancel = CancellationToken::new();

        let published = host.publish_task(
            "failed_service_task".to_owned(),
            NewBackgroundTask::new("failed_service_call", "bash", "{}")
                .with_cancel_token(cancel.clone()),
        );

        assert!(!published);
        assert!(cancel.is_cancelled());
        assert!(service
            .inner
            .background_tasks
            .get("failed_service_task")
            .is_none());
    }

    #[tokio::test]
    async fn background_completion_after_failed_service_does_not_enqueue_callback_or_events() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-background-completion-after-failed"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let host = ServiceBackgroundExecutionHost {
            inner: service.inner.clone(),
            owner: TaskOwner::Main,
        };
        let published = host.publish_task(
            "task_after_failed".to_owned(),
            NewBackgroundTask::new("call_after_failed", "bash", "{}"),
        );
        assert!(published);
        service.inner.mark_failed("timeline persistence failed");
        let before_seq = service.inner.last_event_seq();

        host.finish_task(
            "task_after_failed".to_owned(),
            ToolCall::new("call_after_failed", "bash", json!({})),
            DetachedToolResult {
                tool_result: ToolResult::success("call_after_failed", "bash", "done"),
                state: TaskState::Completed,
            },
        )
        .await;

        let task = service
            .inner
            .background_tasks
            .get("task_after_failed")
            .expect("task should remain inspectable");
        assert_eq!(task.state, TaskState::Completed);
        assert_eq!(task.callback_delivery, CallbackDelivery::NotReady);
        let events = service.events_after(before_seq);
        assert!(
            events.is_empty(),
            "failed service must not append task terminal or callback events after background completion: {events:?}"
        );
    }

    #[tokio::test]
    async fn background_completion_after_shutdown_does_not_enqueue_callback_or_events() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-background-completion-after-shutdown"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let host = ServiceBackgroundExecutionHost {
            inner: service.inner.clone(),
            owner: TaskOwner::Main,
        };
        assert!(host.publish_task(
            "task_after_shutdown".to_owned(),
            NewBackgroundTask::new("call_after_shutdown", "bash", "{}"),
        ));
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::ShuttingDown;
        }
        let before_seq = service.inner.last_event_seq();

        host.finish_task(
            "task_after_shutdown".to_owned(),
            ToolCall::new("call_after_shutdown", "bash", json!({})),
            DetachedToolResult {
                tool_result: ToolResult::success("call_after_shutdown", "bash", "done"),
                state: TaskState::Completed,
            },
        )
        .await;

        let task = service
            .inner
            .background_tasks
            .get("task_after_shutdown")
            .expect("task should remain inspectable");
        assert_eq!(task.state, TaskState::Completed);
        assert_eq!(task.callback_delivery, CallbackDelivery::NotReady);
        let events = service.events_after(before_seq);
        assert!(
            events.is_empty(),
            "shutting down service must not append task terminal or callback events: {events:?}"
        );
    }

    #[tokio::test]
    async fn subagent_terminal_after_failed_service_does_not_enqueue_callback_or_events() {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-terminal-after-failed"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .spawn("Worker", "finish after service failed")
            .expect("spawn subagent")
            .id;
        let cancel = CancellationToken::new();
        service
            .inner
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .insert(subagent_id.clone(), cancel.clone());
        service.inner.mark_failed("timeline persistence failed");
        let before_seq = service.inner.last_event_seq();

        spawn_subagent_loop(
            service.inner.clone(),
            subagent_id.clone(),
            AgentConfig::new("system"),
            vec![Message::user(vec![ContentPart::text("finish")])],
            provider.clone(),
            Vec::new(),
            cancel,
        );
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let snapshot = service
                    .inner
                    .subagents
                    .lock()
                    .expect("subagent manager mutex poisoned")
                    .snapshot(&subagent_id)
                    .expect("subagent snapshot");
                if snapshot.lifecycle == SubagentLifecycle::Cancelled {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("subagent should be cancelled locally");

        assert_eq!(provider.calls(), 0);
        let events = service.events_after(before_seq);
        assert!(
            !events.iter().any(|event| matches!(
                event.event_type.as_str(),
                "subagent.completed" | "subagent.callback"
            )),
            "failed service must not append subagent terminal or callback events: {events:?}"
        );
        assert!(!service
            .inner
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .contains_key(&subagent_id));
    }

    #[tokio::test]
    async fn subagent_owned_task_request_callback_queue_full_writes_exception_to_child() {
        let service = Service::with_limits(
            AgentConfig::new("system").with_session("service-subagent-task-request-queue-full"),
            Arc::new(PanicProvider),
            Vec::new(),
            ServiceLimits::new(1),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Worker", "request queue full")
            .expect("open subagent")
            .id;
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_queue_full".to_owned());
            state.active_cancel = Some(CancellationToken::new());
            state.input_queue.enqueue(QueuedMessage {
                id: "queued_user".to_owned(),
                content: vec![ContentPart::text("queued")],
                source: InputSource::User,
                urgency: InputUrgency::Normal,
                metadata: None,
                cursor_seq: service.inner.last_event_seq(),
            });
        }
        let task = service.inner.background_tasks.start_task(
            NewBackgroundTask::new("call_subagent_request", "bash", "{}")
                .with_owner(TaskOwner::subagent(subagent_id.clone())),
        );
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()));

        let start = service
            .inner
            .handle_task_request_frame(
                &task.task_id,
                TaskRequestFrame {
                    id: "need_agent".to_owned(),
                    request: "ask the agent".to_owned(),
                    expect: Some("short answer".to_owned()),
                    timeout: Some(Duration::from_secs(30)),
                    urgency: InputUrgency::Normal,
                },
            )
            .await;

        assert!(start.is_none());
        let request = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task should remain inspectable")
            .requests
            .into_iter()
            .find(|request| request.request_id == "need_agent")
            .expect("request should be retained");
        assert_eq!(request.state, TaskRequestState::Rejected);
        let stdin_text = stdin.text();
        assert!(stdin_text.contains("\"id\":\"need_agent\""));
        assert!(stdin_text.contains("\"exception\""));
        assert!(stdin_text.contains("agent_callback_unavailable"));
        assert!(service
            .events_after(0)
            .iter()
            .any(|event| event.event_type == "subagent.callback"
                && event.data["callback_status"] == "queue_full"));
    }

    #[tokio::test]
    async fn subagent_owned_task_request_callback_audit_failure_rolls_back_and_writes_exception() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-task-request-audit-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Worker", "request audit failure")
            .expect("open subagent")
            .id;
        let task = service.inner.background_tasks.start_task(
            NewBackgroundTask::new("call_subagent_request_audit", "bash", "{}")
                .with_owner(TaskOwner::subagent(subagent_id.clone())),
        );
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()));
        let before_seq = service.inner.last_event_seq();
        service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);

        let start = service
            .inner
            .handle_task_request_frame(
                &task.task_id,
                TaskRequestFrame {
                    id: "need_agent".to_owned(),
                    request: "ask the agent".to_owned(),
                    expect: Some("short answer".to_owned()),
                    timeout: Some(Duration::from_secs(30)),
                    urgency: InputUrgency::Normal,
                },
            )
            .await;

        assert!(start.is_none());
        assert_eq!(service.status().state, ServiceState::Failed);
        assert_eq!(service.status().queue_length, 0);
        let request = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task should remain inspectable")
            .requests
            .into_iter()
            .find(|request| request.request_id == "need_agent")
            .expect("request should be retained");
        assert_eq!(request.state, TaskRequestState::Rejected);
        let stdin_text = stdin.text();
        assert!(stdin_text.contains("\"id\":\"need_agent\""));
        assert!(stdin_text.contains("\"exception\""));
        assert!(stdin_text.contains("agent_callback_unavailable"));
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent should remain inspectable");
        assert_eq!(snapshot.callback_count, 0);
        assert_eq!(snapshot.pending_callback_count, 0);
        let events = service.events_after(before_seq);
        assert!(events
            .iter()
            .any(|event| event.event_type == "message.received"));
        assert!(!events
            .iter()
            .any(|event| event.event_type == "subagent.callback"));
    }

    #[test]
    fn subagent_owned_task_reply_audit_failure_writes_exception_not_normal_response() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-task-reply-audit-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Worker", "reply audit failure")
            .expect("open subagent")
            .id;
        let owner = TaskOwner::subagent(subagent_id);
        let task = service.inner.background_tasks.start_task(
            NewBackgroundTask::new("call_subagent_reply", "bash", "{}").with_owner(owner.clone()),
        );
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()));
        assert!(matches!(
            service.inner.background_tasks.accept_task_request(
                &task.task_id,
                TaskRequestFrame {
                    id: "reply_me".to_owned(),
                    request: "need response".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_secs(30)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestAdmission::Accepted(_)
        ));
        service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

        let outcome = service.inner.reply_task_request_by_owner(
            &owner,
            &task.task_id,
            "reply_me",
            "normal response",
        );

        assert_eq!(outcome.status, TaskReplyStatus::Failed);
        assert_eq!(service.status().state, ServiceState::Failed);
        let request = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task should remain inspectable")
            .requests
            .into_iter()
            .find(|request| request.request_id == "reply_me")
            .expect("request should be retained");
        assert_eq!(request.state, TaskRequestState::WriteFailed);
        let stdin_text = stdin.text();
        assert!(stdin_text.contains("\"id\":\"reply_me\""));
        assert!(stdin_text.contains("\"exception\""));
        assert!(stdin_text.contains("persistence_failed"));
        assert!(!stdin_text.contains("normal response"));
    }

    #[test]
    fn subagent_spawn_start_event_failure_does_not_start_branch_run() {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::with_subagent_options(
            AgentConfig::new("system").with_session("service-subagent-spawn-start-event-failure"),
            provider.clone(),
            Vec::new(),
            ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
        );
        let before_seq = service.inner.last_event_seq();
        service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

        let result = service.inner.spawn_subagent_tool_result(
            ToolCall::new(
                "spawn_start_event_fails",
                "subagent_spawn",
                json!({"task": "invisible task"}),
            ),
            "invisible task",
            "Worker",
            false,
            None,
            None,
        );

        assert!(result.is_error, "{result:?}");
        assert_eq!(
            result.details["kind"],
            json!("subagent_start_persistence_failed")
        );
        let subagent_id = result.details["subagent_id"]
            .as_str()
            .expect("error should identify the unstarted subagent");
        assert_eq!(provider.calls(), 0);
        assert_eq!(service.status().state, ServiceState::Failed);
        assert_subagent_runtime_resources_absent(&service, subagent_id);
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(subagent_id)
            .expect("cancelled branch should remain inspectable");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        let events = service.events_after(before_seq);
        assert!(!events
            .iter()
            .any(|event| event.event_type == "subagent.started"));
    }

    #[test]
    fn subagent_queued_run_start_event_failure_does_not_leave_branch_running() {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-queued-start-write-failure"),
            provider.clone(),
            Vec::new(),
        );
        let subagent_id = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            let snapshot = manager
                .spawn("Queued", "initial run")
                .expect("spawn subagent");
            manager
                .send(&snapshot.id, "queued run")
                .expect("queue next run");
            manager
                .complete(&snapshot.id, "initial done")
                .expect("complete initial run");
            snapshot.id
        };
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(
                subagent_id.clone(),
                vec![Message::user(vec![ContentPart::text("initial")])],
            );
        service
            .inner
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .insert(subagent_id.clone(), provider.clone());
        let before_seq = service.inner.last_event_seq();
        service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

        maybe_start_next_subagent_run(service.inner.clone(), subagent_id.clone());

        assert_eq!(provider.calls(), 0);
        assert_eq!(service.status().state, ServiceState::Failed);
        assert!(!service
            .inner
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .contains_key(&subagent_id));
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent should remain inspectable");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Open);
        assert_eq!(snapshot.run_state, SubagentRunState::Failed);
        assert!(!service
            .events_after(before_seq)
            .iter()
            .any(|event| event.event_type == "subagent.started"));
    }

    #[test]
    fn subagent_send_start_event_failure_does_not_start_idle_branch_run() {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::with_subagent_options(
            AgentConfig::new("system").with_session("service-subagent-send-start-event-failure"),
            provider.clone(),
            Vec::new(),
            ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Worker", "idle branch")
            .expect("open subagent")
            .id;
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(subagent_id.clone(), Vec::new());
        service
            .inner
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .insert(subagent_id.clone(), provider.clone());
        let before_seq = service.inner.last_event_seq();
        service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

        let result = service.inner.send_subagent_tool_result(
            ToolCall::new(
                "send_start_event_fails",
                "subagent_send",
                json!({"subagent_id": subagent_id, "message": "do work"}),
            ),
            &subagent_id,
            "do work",
        );

        assert!(result.is_error, "{result:?}");
        assert_eq!(
            result.details["kind"],
            json!("subagent_start_persistence_failed")
        );
        assert_eq!(provider.calls(), 0);
        assert_eq!(service.status().state, ServiceState::Failed);
        assert!(!service
            .inner
            .subagent_cancels
            .lock()
            .expect("subagent cancels mutex poisoned")
            .contains_key(&subagent_id));
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent should remain inspectable");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Open);
        assert_eq!(snapshot.run_state, SubagentRunState::Failed);
        let events = service.events_after(before_seq);
        assert!(!events
            .iter()
            .any(|event| event.event_type == "subagent.started"));
    }

    #[tokio::test]
    async fn subagent_cancel_during_queued_run_start_does_not_restore_context_or_cancel_token() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-queued-start-race"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            let snapshot = manager
                .spawn("Queued", "initial run")
                .expect("spawn subagent");
            manager
                .send(&snapshot.id, "queued run")
                .expect("queue next run");
            manager
                .complete(&snapshot.id, "initial done")
                .expect("complete initial run");
            snapshot.id
        };
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(
                subagent_id.clone(),
                vec![Message::user(vec![ContentPart::text("initial")])],
            );
        service
            .inner
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .insert(subagent_id.clone(), Arc::new(TextProvider("queued result")));
        install_subagent_cancel_hook(
            &service,
            SubagentTestHookKind::QueuedRunProviderClone,
            subagent_id.clone(),
        );
        let before_seq = service.inner.last_event_seq();

        maybe_start_next_subagent_run(service.inner.clone(), subagent_id.clone());

        assert_subagent_runtime_resources_absent(&service, &subagent_id);
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        assert!(!service
            .events_after(before_seq)
            .iter()
            .any(|event| event.event_type == "subagent.started"));
    }

    #[tokio::test]
    async fn subagent_cancel_after_queued_run_state_before_event_does_not_append_stale_started() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-queued-start-event-race"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            let snapshot = manager
                .spawn("Queued", "initial run")
                .expect("spawn subagent");
            manager
                .send(&snapshot.id, "queued run")
                .expect("queue next run");
            manager
                .complete(&snapshot.id, "initial done")
                .expect("complete initial run");
            snapshot.id
        };
        service
            .inner
            .subagent_contexts
            .lock()
            .expect("subagent contexts mutex poisoned")
            .insert(
                subagent_id.clone(),
                vec![Message::user(vec![ContentPart::text("initial")])],
            );
        service
            .inner
            .subagent_providers
            .lock()
            .expect("subagent providers mutex poisoned")
            .insert(subagent_id.clone(), Arc::new(TextProvider("queued result")));
        install_subagent_cancel_hook(
            &service,
            SubagentTestHookKind::QueuedRunStateBeforeAppend,
            subagent_id.clone(),
        );
        let before_seq = service.inner.last_event_seq();

        maybe_start_next_subagent_run(service.inner.clone(), subagent_id.clone());

        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent_id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        assert_subagent_not_reactivated_after_cancel(
            &service,
            before_seq,
            &subagent_id,
            "subagent.started",
        );
    }

    #[tokio::test]
    async fn durable_subagent_callback_accept_is_not_rejected_by_post_accept_shutdown() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-callback-shutdown-race"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_callback_shutdown_race".to_owned());
            state.active_cancel = Some(CancellationToken::new());
        }
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Callback", "post accept shutdown race")
            .expect("open subagent");
        let inner = service.inner.clone();
        service.inner.set_subagent_test_hook(
            SubagentTestHookKind::CallbackEnqueueBeforeRecord,
            Arc::new(move || {
                let mut state = inner.state.lock().expect("service state mutex poisoned");
                if let Some(cancel) = state.active_cancel.as_ref() {
                    cancel.cancel();
                }
                state.state = ServiceState::ShuttingDown;
            }),
        );
        let before_seq = service.inner.last_event_seq();

        enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&snapshot.id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.callback_count, 1);
        assert_eq!(snapshot.pending_callback_count, 1);
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(state
            .input_queue
            .iter()
            .any(|queued| queued.source == InputSource::SubagentCallback));
        assert!(!service.events_after(before_seq).iter().any(|event| {
            event.event_type == "message.rejected"
                && event.data["reason"] == json!("service_shutting_down")
        }));
        assert!(service.events_after(before_seq).iter().any(|event| {
            event.event_type == "subagent.callback"
                && event.data["callback_status"] == json!("queued")
        }));
    }

    #[tokio::test]
    async fn subagent_cancel_between_callback_enqueue_and_record_does_not_pollute_queue_or_branch()
    {
        let home = service_test_home("subagent-callback-cancel-tombstone");
        let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
            .expect("session should open");
        let session_path = home.join("sessions/service-test.jsonl");
        let service = Service::with_initial_context(
            AgentConfig::new("system").with_session("service-subagent-callback-record-race"),
            Arc::new(PanicProvider),
            Vec::new(),
            session.initial_messages().to_vec(),
            Some(session.recorder()),
        );
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_callback_race".to_owned());
            state.active_cancel = Some(CancellationToken::new());
        }
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Callback", "callback race")
            .expect("open subagent");
        install_subagent_cancel_hook(
            &service,
            SubagentTestHookKind::CallbackEnqueueBeforeRecord,
            snapshot.id.clone(),
        );

        enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&snapshot.id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        assert_eq!(snapshot.callback_count, 0);
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(!state
            .input_queue
            .iter()
            .any(|queued| queued.source == InputSource::SubagentCallback));

        let entries = fs::read_to_string(&session_path)
            .expect("session should read")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("session line should parse"))
            .collect::<Vec<_>>();
        let accepted_callback = entries
            .iter()
            .find(|entry| {
                entry["type"] == "accepted_input"
                    && entry["source"] == "subagent_callback"
                    && entry["metadata"]["subagent_callback"]["subagent_id"] == snapshot.id
            })
            .expect("cancelled durable callback should still have an accepted entry");
        let callback_id = accepted_callback["message_id"]
            .as_str()
            .expect("accepted callback should include message_id");
        assert!(entries.iter().any(|entry| {
            entry["type"] == "pending_input_removed"
                && entry["message_id"] == callback_id
                && entry["source"] == "subagent_callback"
                && entry["metadata"]["subagent_callback"]["subagent_id"] == snapshot.id
                && entry["reason"] == "subagent_cancelled"
        }));

        let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
            .expect("session should reopen");
        assert!(
            reopened.pending_messages().is_empty(),
            "cancelled subagent callback must not rehydrate as pending after restart"
        );
    }

    #[tokio::test]
    async fn subagent_cancelled_pending_removal_failure_fails_service_and_cancels_turn() {
        let service = Service::with_initial_context(
            AgentConfig::new("system")
                .with_session("service-subagent-cancelled-pending-removal-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Some(Arc::new(FailingPendingRemovalRecorder)),
        );
        let active_cancel = CancellationToken::new();
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_callback_cancel_tombstone_failed".to_owned());
            state.active_cancel = Some(active_cancel.clone());
        }
        let snapshot = open_test_subagent(&service, "CallbackCancelTombstoneFailed");
        install_subagent_cancel_hook(
            &service,
            SubagentTestHookKind::CallbackEnqueueBeforeRecord,
            snapshot.id.clone(),
        );
        let before_seq = service.inner.last_event_seq();

        enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

        assert_eq!(service.status().state, ServiceState::Failed);
        assert!(active_cancel.is_cancelled());
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&snapshot.id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        assert_eq!(snapshot.callback_count, 0);
        assert!(service.events_after(before_seq).iter().any(|event| {
            event.event_type == "subagent.callback_pending_removal_failed"
                && event.data["reason"] == json!("subagent_cancelled")
                && event.data["error"]["code"] == json!("pending_removal_persistence_failed")
        }));
    }

    #[tokio::test]
    async fn session_subagent_callback_record_failure_does_not_publish_input_timeline() {
        let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
            PathBuf::from("session.jsonl"),
            FailingSyncSessionFile,
        ));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-subagent-callback-record-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        );
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_callback_record_failure".to_owned());
            state.active_cancel = Some(CancellationToken::new());
        }
        let snapshot = open_test_subagent(&service, "CallbackRecordFailure");
        let callback_id = "subagent_callback_record_failure".to_owned();
        let before_seq = service.inner.last_event_seq();

        let (_, status, _) = enqueue_subagent_callback_input(
            service.inner.as_ref(),
            &snapshot.id,
            callback_id.clone(),
            "completed",
            vec![ContentPart::text("callback body")],
        )
        .await
        .expect("failed callback should still record lifecycle outcome");

        assert_eq!(status, "failed");
        assert_recorded_callback(
            &service,
            &snapshot.id,
            &callback_id,
            SubagentCallbackStatus::Failed,
        );
        let events = service.events_after(before_seq);
        assert!(
            events.iter().all(|event| {
                !(matches!(
                    event.event_type.as_str(),
                    "message.received" | "message.queued"
                ) && event.data["message_id"] == json!(callback_id))
            }),
            "session record failure must not publish ghost input timeline events: {events:?}"
        );
        assert_eq!(service.status().queue_length, 0);
    }

    #[tokio::test]
    async fn session_subagent_callback_status_append_failure_rolls_back_accepted_input() {
        let home = service_test_home("subagent-callback-status-failure");
        let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
            .expect("session should open");
        let session_path = session.path().to_path_buf();
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            session.initial_messages().to_vec(),
            session.pending_messages().to_vec(),
            session.known_user_messages().to_vec(),
            session.message_cursors().to_vec(),
            Some(session.recorder()),
            session.warnings().to_vec(),
            ServiceLimits::default(),
        );
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_callback_status_failure".to_owned());
            state.active_cancel = Some(CancellationToken::new());
        }
        let snapshot = open_test_subagent(&service, "CallbackStatusFailure");
        let callback_id = "subagent_callback_status_failure".to_owned();
        service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);

        let (_, status, _) = enqueue_subagent_callback_input(
            service.inner.as_ref(),
            &snapshot.id,
            callback_id.clone(),
            "completed",
            vec![ContentPart::text("callback body")],
        )
        .await
        .expect("timeline failure should still record callback outcome");

        assert_eq!(status, "failed");
        let entries = fs::read_to_string(&session_path)
            .expect("session should read")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("session line should parse"))
            .collect::<Vec<_>>();
        assert!(
            !entries.iter().any(|entry| {
                entry["type"] == "accepted_input"
                    && entry["message_id"].as_str() == Some(callback_id.as_str())
            }),
            "timeline failure after accepted persistence must roll back accepted_input: {entries:?}"
        );
        let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
            .expect("session should reopen after rolled back callback");
        assert!(
            reopened.pending_messages().is_empty(),
            "failed callback enqueue must not replay after restart"
        );
    }

    #[tokio::test]
    async fn session_subagent_cancel_before_callback_enqueue_does_not_record_accepted_input() {
        let home = service_test_home("subagent-callback-session-cancel-no-accepted");
        let session = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
            .expect("session should open");
        let session_path = session.path().to_path_buf();
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            session.initial_messages().to_vec(),
            session.pending_messages().to_vec(),
            session.known_user_messages().to_vec(),
            session.message_cursors().to_vec(),
            Some(session.recorder()),
            session.warnings().to_vec(),
            ServiceLimits::default(),
        );
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_callback_cancel_no_accepted".to_owned());
            state.active_cancel = Some(CancellationToken::new());
        }
        let snapshot = open_test_subagent(&service, "CallbackCancelNoAccepted");
        install_subagent_cancel_hook(
            &service,
            SubagentTestHookKind::CallbackEnqueueBeforeRecord,
            snapshot.id.clone(),
        );

        enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&snapshot.id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        assert_eq!(snapshot.callback_count, 0);
        let entries = fs::read_to_string(&session_path)
            .expect("session should read")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("session line should parse"))
            .collect::<Vec<_>>();
        assert!(
            !entries.iter().any(|entry| {
                entry["type"] == "accepted_input" && entry["source"] == "subagent_callback"
            }),
            "session-mode cancelled callback must not persist accepted_input: {entries:?}"
        );
        let reopened = open_or_create_session_in_home_with_cwd("service-test", &home, "/repo")
            .expect("session should reopen");
        assert!(reopened.pending_messages().is_empty());
    }

    #[tokio::test]
    async fn subagent_cancel_after_callback_record_before_event_does_not_append_stale_callback() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-callback-event-race"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_callback_event_race".to_owned());
            state.active_cancel = Some(CancellationToken::new());
        }
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Callback", "callback event race")
            .expect("open subagent");
        install_subagent_cancel_hook(
            &service,
            SubagentTestHookKind::CallbackRecordBeforeAppend,
            snapshot.id.clone(),
        );
        let before_seq = service.inner.last_event_seq();

        enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;

        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&snapshot.id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.lifecycle, SubagentLifecycle::Cancelled);
        assert_subagent_not_reactivated_after_cancel(
            &service,
            before_seq,
            &snapshot.id,
            "subagent.callback",
        );
    }

    #[tokio::test]
    async fn subagent_callback_event_failure_cancels_start_and_rolls_back_callback() {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::new(
            AgentConfig::new("system")
                .with_session("service-subagent-callback-event-persistence-failure"),
            provider.clone(),
            Vec::new(),
        );
        let snapshot = open_test_subagent(&service, "CallbackEventFailure");
        let before_seq = service.inner.last_event_seq();
        service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);

        enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;
        tokio::task::yield_now().await;

        assert_eq!(service.status().state, ServiceState::Failed);
        assert_eq!(service.status().queue_length, 0);
        assert_eq!(provider.calls(), 0);
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&snapshot.id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.callback_count, 0);
        assert_eq!(snapshot.pending_callback_count, 0);
        assert_eq!(snapshot.failed_callback_count, 0);
        let events = service.events_after(before_seq);
        assert!(events
            .iter()
            .any(|event| event.event_type == "message.received"));
        assert!(!events
            .iter()
            .any(|event| event.event_type == "subagent.callback"));
    }

    #[tokio::test]
    async fn subagent_callback_rollback_keeps_pending_state_when_tombstone_fails() {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::with_initial_context(
            AgentConfig::new("system")
                .with_session("service-subagent-callback-rollback-tombstone-failure"),
            provider.clone(),
            Vec::new(),
            Vec::new(),
            Some(Arc::new(FailingPendingRemovalRecorder)),
        );
        let snapshot = open_test_subagent(&service, "CallbackRollbackTombstoneFailure");
        let before_seq = service.inner.last_event_seq();
        service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);

        enqueue_subagent_callback(service.inner.clone(), &snapshot, "completed").await;
        tokio::task::yield_now().await;

        assert_eq!(service.status().state, ServiceState::Failed);
        assert_eq!(
            service.status().queue_length,
            1,
            "accepted callback must stay queued when its removal tombstone fails"
        );
        assert_eq!(provider.calls(), 0);
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&snapshot.id)
            .expect("subagent snapshot");
        assert_eq!(snapshot.callback_count, 1);
        assert_eq!(snapshot.pending_callback_count, 1);
        assert_eq!(snapshot.failed_callback_count, 0);
        let events = service.events_after(before_seq);
        assert!(events
            .iter()
            .any(|event| event.event_type == "message.received"));
        assert!(events.iter().any(|event| {
            event.event_type == "subagent.callback_pending_removal_failed"
                && event.data["error"]["code"] == json!("pending_removal_persistence_failed")
        }));
        assert!(!events
            .iter()
            .any(|event| event.event_type == "subagent.callback"));
    }

    #[tokio::test]
    async fn subagent_cancel_rejects_reason_argument_by_contract() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-cancel-reason"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .open("Reviewer", "review cancellation reason")
            .expect("open subagent")
            .id;
        let tool = SubagentCancelTool::new(Arc::downgrade(&service.inner));

        let result = tool
            .execute(
                ToolCall::new(
                    "cancel_reason",
                    "subagent_cancel",
                    json!({"subagent_id": subagent_id, "reason": "obsolete"}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("tool execution should return a result");

        assert!(result.is_error, "{result:?}");
        assert_eq!(result.details["kind"], json!("invalid_tool_arguments"));
        assert_eq!(result.details["field"], json!("reason"));
        assert!(!service
            .events_after(0)
            .iter()
            .any(|event| event.event_type == "subagent.cancelled"));
    }

    #[tokio::test]
    async fn subagent_spawn_text_is_llm_visible_and_self_contained() {
        let service = Service::with_subagent_options(
            AgentConfig::new("system").with_session("service-subagent-spawn-text"),
            Arc::new(TextProvider("spawn result")),
            Vec::new(),
            ServiceSubagentOptions::enabled(SubagentLimits::new(2, 8)),
        );
        let tool = SubagentSpawnTool::new(Arc::downgrade(&service.inner));

        let result = tool
            .execute(
                ToolCall::new(
                    "spawn_text",
                    "subagent_spawn",
                    json!({"task": "inspect the auth flow", "name_hint": "Reviewer = Auth\nFlow"}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("spawn should return");

        assert!(!result.is_error, "{result:?}");
        let text = tool_text_json(&result);
        let subagent_id = text["subagent_id"]
            .as_str()
            .expect("spawn details should include subagent_id");
        assert_eq!(text["subagent_id"], json!(subagent_id));
        assert_eq!(text["name"], json!("Reviewer = Auth Flow"));
        assert_eq!(text["status"], json!("started"));
        assert_eq!(text["callback_pending"], json!(true));
    }

    #[tokio::test]
    async fn subagent_list_text_is_llm_visible_for_empty_and_non_empty_lists() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-list-text"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let tool = SubagentListTool::new(Arc::downgrade(&service.inner));

        let empty = tool
            .execute(
                ToolCall::new("list_empty", "subagent_list", json!({})),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("empty list should return");
        assert!(!empty.is_error, "{empty:?}");
        let empty_text = tool_text_json(&empty);
        assert_eq!(empty_text["total"], json!(0));
        assert_eq!(
            empty_text["subagents"]
                .as_array()
                .expect("subagents should be an array")
                .len(),
            0
        );

        let (running_id, completed_id) = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            let running = manager
                .spawn("Runner", "keep working")
                .expect("spawn running subagent");
            let completed = manager
                .spawn("Finisher = Audit", "finish work")
                .expect("spawn completed subagent");
            manager
                .complete(&completed.id, "finished review\nline=2")
                .expect("complete subagent");
            manager
                .record_callback(
                    &running.id,
                    "callback_1",
                    "completed",
                    SubagentCallbackStatus::Pending,
                    None,
                )
                .expect("record pending callback");
            (running.id, completed.id)
        };

        let listed = tool
            .execute(
                ToolCall::new("list_full", "subagent_list", json!({})),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("list should return");
        assert!(!listed.is_error, "{listed:?}");
        let listed_text = tool_text_json(&listed);
        assert_eq!(listed_text["total"], json!(2));
        let subagents = listed_text["subagents"]
            .as_array()
            .expect("subagents should be an array");
        let running = subagents
            .iter()
            .find(|subagent| subagent["subagent_id"] == running_id)
            .expect("running subagent should be listed");
        assert_eq!(running["name"], json!("Runner"));
        assert_eq!(running["lifecycle"], json!("open"));
        assert_eq!(running["run_state"], json!("running"));
        assert_eq!(running["status_summary"], json!("running"));
        assert_eq!(running["pending_callback_count"], json!(1));
        let completed = subagents
            .iter()
            .find(|subagent| subagent["subagent_id"] == completed_id)
            .expect("completed subagent should be listed");
        assert_eq!(completed["name"], json!("Finisher = Audit"));
        assert_eq!(completed["latest_result"], json!("finished review\nline=2"));
    }

    #[tokio::test]
    async fn subagent_send_and_cancel_text_are_details_json() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-send-cancel-text"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .spawn("Worker = One", "initial work")
            .expect("spawn subagent")
            .id;

        let send = SubagentSendTool::new(Arc::downgrade(&service.inner))
            .execute(
                ToolCall::new(
                    "send_text",
                    "subagent_send",
                    json!({"subagent_id": subagent_id, "message": "follow up\nkey=value"}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("send should return");
        assert!(!send.is_error, "{send:?}");
        let send_text = tool_text_json(&send);
        assert_eq!(send_text["subagent_id"], json!(subagent_id));
        assert_eq!(send_text["name"], json!("Worker = One"));
        assert_eq!(send_text["status"], json!("queued"));
        assert_eq!(send_text["queued_messages"], json!(1));

        let cancel = SubagentCancelTool::new(Arc::downgrade(&service.inner))
            .execute(
                ToolCall::new(
                    "cancel_text",
                    "subagent_cancel",
                    json!({"subagent_id": subagent_id}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("cancel should return");
        assert!(!cancel.is_error, "{cancel:?}");
        let cancel_text = tool_text_json(&cancel);
        assert_eq!(cancel_text["subagent_id"], json!(subagent_id));
        assert_eq!(cancel_text["name"], json!("Worker = One"));
        assert_eq!(cancel_text["status"], json!("cancelled"));
        assert!(cancel_text["cancelled_task_ids"].is_array());
    }

    #[tokio::test]
    async fn subagent_read_include_contract_is_summary_tail_or_all() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-read-include"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            let snapshot = manager
                .spawn("Reader", "read include contract")
                .expect("spawn subagent");
            manager
                .complete(&snapshot.id, "summary ready")
                .expect("complete subagent");
            snapshot.id
        };
        let tool = SubagentReadTool::new(Arc::downgrade(&service.inner));
        assert_eq!(
            tool.spec().input_schema["properties"]["include"]["enum"],
            json!(["summary", "tail", "all"])
        );

        let summary = tool
            .execute(
                ToolCall::new(
                    "read_summary",
                    "subagent_read",
                    json!({"subagent_id": subagent_id}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("summary read should return");
        assert!(!summary.is_error, "{summary:?}");
        assert!(summary.details.get("tail").is_none());
        assert!(summary.details.get("queued_messages").is_none());

        let tail = tool
            .execute(
                ToolCall::new(
                    "read_tail",
                    "subagent_read",
                    json!({"subagent_id": subagent_id, "include": "tail"}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("tail read should return");
        assert!(!tail.is_error, "{tail:?}");
        assert!(tail.details["tail"]
            .as_array()
            .expect("tail include should return tail array")
            .iter()
            .any(|entry| entry["text"] == "summary ready"));
        assert!(tail.details.get("queued_messages").is_none());

        let all = tool
            .execute(
                ToolCall::new(
                    "read_all",
                    "subagent_read",
                    json!({"subagent_id": subagent_id, "include": "all"}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("all read should return");
        assert!(!all.is_error, "{all:?}");
        assert!(all.details.get("tail").is_some());
        assert!(all.details.get("queued_messages").is_some());
        assert!(all.details.get("owned_task_ids").is_some());
        assert!(all.details.get("callbacks").is_some());

        let invalid = tool
            .execute(
                ToolCall::new(
                    "read_invalid",
                    "subagent_read",
                    json!({"subagent_id": subagent_id, "include": "messages"}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("invalid read should return");
        assert!(invalid.is_error, "{invalid:?}");
        assert_eq!(
            invalid.details,
            json!({"kind": "invalid_subagent_arguments", "field": "include"})
        );
    }

    #[tokio::test]
    async fn subagent_read_text_is_llm_visible_and_respects_include() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-subagent-read-text"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent_id = {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            let snapshot = manager
                .spawn("Reader", "read text contract")
                .expect("spawn subagent");
            manager
                .complete(&snapshot.id, "summary ready\nkey=value")
                .expect("complete subagent");
            snapshot.id
        };
        let tool = SubagentReadTool::new(Arc::downgrade(&service.inner));

        let summary = tool
            .execute(
                ToolCall::new(
                    "read_text_summary",
                    "subagent_read",
                    json!({"subagent_id": subagent_id}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("summary read should return");
        assert!(!summary.is_error, "{summary:?}");
        let summary_text = tool_text_json(&summary);
        assert_eq!(summary_text["subagent_id"], json!(subagent_id));
        assert_eq!(summary_text["name"], json!("Reader"));
        assert_eq!(summary_text["run_state"], json!("completed"));
        assert_eq!(
            summary_text["latest_result"],
            json!("summary ready\nkey=value")
        );
        assert!(summary_text.get("tail").is_none());

        let tail = tool
            .execute(
                ToolCall::new(
                    "read_text_tail",
                    "subagent_read",
                    json!({"subagent_id": subagent_id, "include": "tail"}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("tail read should return");
        assert!(!tail.is_error, "{tail:?}");
        let tail_text = tool_text_json(&tail);
        assert!(tail_text["tail"]
            .as_array()
            .expect("tail should be an array")
            .iter()
            .any(|entry| entry["kind"] == "result" && entry["text"] == "summary ready\nkey=value"));
    }

    fn service_test_profiler(name: &str) -> (SharedProfiler, PathBuf) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();
        let data_dir = std::env::temp_dir().join(format!(
            "botified-service-profiling-{name}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&data_dir).expect("create profiling temp dir");
        let resolved = resolve_profiling_config(
            &crate::config::RuntimeProfilingConfig {
                enabled: true,
                output_dir: None,
                run_label: Some(name.to_owned()),
            },
            &data_dir,
        )
        .expect("profiling config should resolve")
        .expect("profiling should be enabled");
        let profiler = CsvProfiler::create_shared(resolved).expect("profiler should create files");
        let report_dir = profiler
            .lock()
            .expect("profiler mutex poisoned")
            .report_dir()
            .to_path_buf();
        (profiler, report_dir)
    }

    fn summary_value<'a>(summary: &'a str, column: &str) -> &'a str {
        let mut lines = summary.lines();
        let header = lines.next().expect("summary header");
        let row = lines.next().expect("summary row");
        let index = header
            .split(',')
            .position(|name| name == column)
            .unwrap_or_else(|| panic!("summary column {column} not found"));
        row.split(',')
            .nth(index)
            .unwrap_or_else(|| panic!("summary row missing column {column}"))
    }

    #[derive(Clone, Default)]
    struct RecordingTaskStdin {
        text: Arc<Mutex<String>>,
    }

    impl RecordingTaskStdin {
        fn text(&self) -> String {
            self.text
                .lock()
                .expect("recording stdin mutex poisoned")
                .clone()
        }
    }

    impl TaskStdinWriter for RecordingTaskStdin {
        fn write_stdin(&self, bytes: &[u8]) -> Result<(), String> {
            self.text
                .lock()
                .expect("recording stdin mutex poisoned")
                .push_str(&String::from_utf8_lossy(bytes));
            Ok(())
        }

        fn supports_priority_stdin(&self) -> bool {
            true
        }

        fn try_write_priority_stdin(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
            self.write_stdin(bytes)
                .map(|_| TaskStdinWriteSuccess::delivered())
        }

        fn supports_observer_stdin(&self) -> bool {
            true
        }

        fn try_write_observer_stdin(&self, bytes: &[u8]) -> Result<(), String> {
            self.write_stdin(bytes)
        }
    }

    #[derive(Clone, Default)]
    struct FailingTaskStdin;

    impl TaskStdinWriter for FailingTaskStdin {
        fn write_stdin(&self, _bytes: &[u8]) -> Result<(), String> {
            Err("stdin closed".to_owned())
        }

        fn supports_priority_stdin(&self) -> bool {
            true
        }

        fn try_write_priority_stdin(&self, _bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
            Err("stdin closed".to_owned())
        }

        fn supports_observer_stdin(&self) -> bool {
            true
        }

        fn try_write_observer_stdin(&self, _bytes: &[u8]) -> Result<(), String> {
            Err("stdin closed".to_owned())
        }
    }

    #[derive(Clone, Default)]
    struct UnsupportedObserverTaskStdin;

    impl TaskStdinWriter for UnsupportedObserverTaskStdin {
        fn write_stdin(&self, _bytes: &[u8]) -> Result<(), String> {
            Ok(())
        }

        fn supports_observer_stdin(&self) -> bool {
            false
        }
    }

    #[derive(Clone)]
    struct BlockingTaskStdin {
        started: Arc<Mutex<Option<oneshot::Sender<()>>>>,
        release: Arc<(Mutex<bool>, Condvar)>,
        completed_writes: Arc<AtomicUsize>,
    }

    impl BlockingTaskStdin {
        fn new() -> (Self, oneshot::Receiver<()>) {
            let (started_tx, started_rx) = oneshot::channel();
            (
                Self {
                    started: Arc::new(Mutex::new(Some(started_tx))),
                    release: Arc::new((Mutex::new(false), Condvar::new())),
                    completed_writes: Arc::new(AtomicUsize::new(0)),
                },
                started_rx,
            )
        }

        fn release(&self) {
            let (lock, cvar) = &*self.release;
            *lock.lock().expect("blocking stdin mutex poisoned") = true;
            cvar.notify_all();
        }

        fn completed_writes(&self) -> usize {
            self.completed_writes.load(Ordering::SeqCst)
        }

        fn release_on_drop(&self) -> BlockingTaskStdinReleaseGuard {
            BlockingTaskStdinReleaseGuard {
                stdin: self.clone(),
            }
        }
    }

    impl TaskStdinWriter for BlockingTaskStdin {
        fn write_stdin(&self, _bytes: &[u8]) -> Result<(), String> {
            if let Some(started) = self
                .started
                .lock()
                .expect("blocking stdin started mutex poisoned")
                .take()
            {
                let _ = started.send(());
            }
            let (lock, cvar) = &*self.release;
            let mut released = lock.lock().expect("blocking stdin mutex poisoned");
            while !*released {
                released = cvar
                    .wait(released)
                    .expect("blocking stdin condvar wait failed");
            }
            self.completed_writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn supports_observer_stdin(&self) -> bool {
            true
        }

        fn try_write_observer_stdin(&self, bytes: &[u8]) -> Result<(), String> {
            self.write_stdin(bytes)
        }
    }

    struct BlockingTaskStdinReleaseGuard {
        stdin: BlockingTaskStdin,
    }

    impl Drop for BlockingTaskStdinReleaseGuard {
        fn drop(&mut self) {
            self.stdin.release();
        }
    }

    #[derive(Clone, Default)]
    struct UnsupportedPriorityTaskStdin {
        sync_called: Arc<AtomicBool>,
    }

    impl UnsupportedPriorityTaskStdin {
        fn sync_called(&self) -> bool {
            self.sync_called.load(Ordering::SeqCst)
        }
    }

    impl TaskStdinWriter for UnsupportedPriorityTaskStdin {
        fn write_stdin(&self, _bytes: &[u8]) -> Result<(), String> {
            self.sync_called.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct WouldBlockPriorityTaskStdin {
        sync_called: Arc<AtomicBool>,
    }

    impl WouldBlockPriorityTaskStdin {
        fn sync_called(&self) -> bool {
            self.sync_called.load(Ordering::SeqCst)
        }
    }

    impl TaskStdinWriter for WouldBlockPriorityTaskStdin {
        fn write_stdin(&self, _bytes: &[u8]) -> Result<(), String> {
            self.sync_called.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn supports_priority_stdin(&self) -> bool {
            true
        }

        fn try_write_priority_stdin(&self, _bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
            Err("stdin writer would block".to_owned())
        }
    }

    #[derive(Clone, Default)]
    struct ShortWritePriorityTaskStdin;

    impl TaskStdinWriter for ShortWritePriorityTaskStdin {
        fn write_stdin(&self, _bytes: &[u8]) -> Result<(), String> {
            panic!("service should not use synchronous write_stdin fallback for priority writes");
        }

        fn supports_priority_stdin(&self) -> bool {
            true
        }

        fn try_write_priority_stdin(&self, _bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
            Err("short nonblocking stdin write: 12/64 bytes".to_owned())
        }
    }

    #[derive(Clone)]
    struct ObserveBlockingPriorityTaskStdin {
        write_lock: Arc<Mutex<()>>,
        observe_started: Arc<Mutex<Option<oneshot::Sender<()>>>>,
        observe_release: Arc<(Mutex<bool>, Condvar)>,
        text: Arc<Mutex<String>>,
    }

    impl ObserveBlockingPriorityTaskStdin {
        fn new() -> (Self, oneshot::Receiver<()>) {
            let (started_tx, started_rx) = oneshot::channel();
            (
                Self {
                    write_lock: Arc::new(Mutex::new(())),
                    observe_started: Arc::new(Mutex::new(Some(started_tx))),
                    observe_release: Arc::new((Mutex::new(false), Condvar::new())),
                    text: Arc::new(Mutex::new(String::new())),
                },
                started_rx,
            )
        }

        fn release_observe(&self) {
            let (lock, cvar) = &*self.observe_release;
            *lock.lock().expect("observe release mutex poisoned") = true;
            cvar.notify_all();
        }

        fn release_observe_on_drop(&self) -> ObserveBlockingPriorityTaskStdinReleaseGuard {
            ObserveBlockingPriorityTaskStdinReleaseGuard {
                stdin: self.clone(),
            }
        }

        fn text(&self) -> String {
            self.text
                .lock()
                .expect("observe priority text mutex poisoned")
                .clone()
        }

        fn signal_observe_started(&self) {
            if let Some(started) = self
                .observe_started
                .lock()
                .expect("observe started mutex poisoned")
                .take()
            {
                let _ = started.send(());
            }
        }

        fn wait_for_observe_release(&self) {
            let (lock, cvar) = &*self.observe_release;
            let mut released = lock.lock().expect("observe release mutex poisoned");
            while !*released {
                released = cvar
                    .wait(released)
                    .expect("observe release condvar wait failed");
            }
        }

        fn record(&self, bytes: &[u8]) {
            self.text
                .lock()
                .expect("observe priority text mutex poisoned")
                .push_str(&String::from_utf8_lossy(bytes));
        }
    }

    impl TaskStdinWriter for ObserveBlockingPriorityTaskStdin {
        fn write_stdin(&self, bytes: &[u8]) -> Result<(), String> {
            let _guard = self
                .write_lock
                .lock()
                .expect("observe priority write mutex poisoned");
            if String::from_utf8_lossy(bytes).contains(r#""op":"observe""#) {
                self.signal_observe_started();
                self.wait_for_observe_release();
            }
            self.record(bytes);
            Ok(())
        }

        fn try_write_observer_stdin(&self, bytes: &[u8]) -> Result<(), String> {
            self.signal_observe_started();
            self.wait_for_observe_release();
            self.record(bytes);
            Ok(())
        }

        fn supports_priority_stdin(&self) -> bool {
            true
        }

        fn try_write_priority_stdin(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
            self.record(bytes);
            Ok(TaskStdinWriteSuccess::delivered())
        }

        fn supports_observer_stdin(&self) -> bool {
            true
        }
    }

    struct ObserveBlockingPriorityTaskStdinReleaseGuard {
        stdin: ObserveBlockingPriorityTaskStdin,
    }

    impl Drop for ObserveBlockingPriorityTaskStdinReleaseGuard {
        fn drop(&mut self) {
            self.stdin.release_observe();
        }
    }

    fn run_on_thread_with_timeout<T: Send + 'static>(
        timeout: Duration,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, std::sync::mpsc::RecvTimeoutError> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
            let _ = tx.send(result);
        });
        match rx.recv_timeout(timeout)? {
            Ok(value) => Ok(value),
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    async fn wait_until(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if condition() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("condition should become true before timeout");
    }

    async fn wait_for_service_workers_idle(service: &Service) {
        wait_until(|| {
            service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned")
                .service_workers
                .active_count()
                == 0
        })
        .await;
    }

    fn service_context_len(service: &Service) -> usize {
        service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .context
            .len()
    }

    fn task_request_count(service: &Service, task_id: &str) -> usize {
        service
            .inner
            .background_tasks
            .get(task_id)
            .map(|task| task.requests.len())
            .unwrap_or(0)
    }

    fn botified_frame_strings(text: &str) -> Vec<String> {
        let mut frames = Vec::new();
        let mut rest = text;
        while let Some(start) = rest.find("<botified>") {
            let after_start = start + "<botified>".len();
            let Some(relative_end) = rest[after_start..].find("</botified>") else {
                break;
            };
            let end = after_start + relative_end + "</botified>".len();
            frames.push(rest[start..end].to_owned());
            rest = &rest[end..];
        }
        frames
    }

    fn botified_json_from_frame(frame: &str) -> Value {
        let start = frame
            .find("<botified>")
            .expect("frame should contain botified open tag")
            + "<botified>".len();
        let end = frame[start..]
            .find("</botified>")
            .expect("frame should contain botified close tag")
            + start;
        serde_json::from_str(&frame[start..end]).expect("botified frame should contain JSON")
    }

    fn first_botified_json(text: &str) -> Value {
        let start = text
            .find("<botified>")
            .expect("stdin should contain botified open tag")
            + "<botified>".len();
        let end = text[start..]
            .find("</botified>")
            .expect("stdin should contain botified close tag")
            + start;
        serde_json::from_str(&text[start..end]).expect("botified frame should contain JSON")
    }

    fn input_queue_test_message(
        id: &str,
        urgency: InputUrgency,
        source: InputSource,
    ) -> QueuedMessage {
        QueuedMessage {
            id: id.to_owned(),
            content: vec![ContentPart::text(format!("content for {id}"))],
            source,
            urgency,
            metadata: None,
            cursor_seq: 10,
        }
    }

    fn input_queue_task_request_message(
        id: &str,
        task_id: &str,
        request_id: &str,
    ) -> QueuedMessage {
        QueuedMessage {
            id: id.to_owned(),
            content: vec![ContentPart::text("task request")],
            source: InputSource::TaskRequest,
            urgency: InputUrgency::Urgent,
            metadata: Some(QueuedInputMetadata::TaskRequest {
                task_id: task_id.to_owned(),
                request_id: request_id.to_owned(),
            }),
            cursor_seq: 42,
        }
    }

    fn replay_known_message(index: usize) -> DrainedMessage {
        DrainedMessage::new(
            format!("msg_{index}"),
            vec![ContentPart::text(format!("known {index}"))],
        )
    }

    fn replay_cursor(index: usize) -> DurableMessageCursor {
        DurableMessageCursor {
            message_id: format!("msg_{index}"),
            replay_start_seq: index as u64 + 10,
            terminal_seq: index as u64 + 11,
            replay_events: vec![
                ThreadEvent::TurnStarted,
                ThreadEvent::TurnCompleted {
                    usage: crate::agent_events::AgentUsage::default(),
                },
            ],
        }
    }

    fn input_queue_batch_ids(batch: &DrainBatch) -> Vec<String> {
        batch
            .messages
            .iter()
            .map(|message| message.id.clone())
            .collect()
    }

    #[test]
    fn input_queue_state_urgent_first_pending_freeze_and_rollback() {
        let mut queue = InputQueueState::new(VecDeque::new());
        queue.enqueue(input_queue_test_message(
            "normal_1",
            InputUrgency::Normal,
            InputSource::User,
        ));
        queue.enqueue(input_queue_test_message(
            "urgent_1",
            InputUrgency::Urgent,
            InputSource::User,
        ));
        queue.enqueue(input_queue_test_message(
            "normal_2",
            InputUrgency::Normal,
            InputSource::User,
        ));
        queue.enqueue(input_queue_test_message(
            "urgent_2",
            InputUrgency::Urgent,
            InputSource::User,
        ));

        let first = queue.begin_drain();
        assert_eq!(
            input_queue_batch_ids(&first),
            vec!["urgent_1", "urgent_2", "normal_1", "normal_2"]
        );
        queue.enqueue(input_queue_test_message(
            "urgent_late",
            InputUrgency::Urgent,
            InputSource::User,
        ));
        let frozen = queue.begin_drain();
        assert_eq!(frozen.id, first.id);
        assert_eq!(
            input_queue_batch_ids(&frozen),
            vec!["urgent_1", "urgent_2", "normal_1", "normal_2"]
        );

        queue.rollback(&first.id);
        let after_rollback = queue.begin_drain();
        assert_eq!(
            input_queue_batch_ids(&after_rollback),
            vec![
                "urgent_1",
                "urgent_2",
                "urgent_late",
                "normal_1",
                "normal_2"
            ]
        );
    }

    #[test]
    fn input_queue_state_commit_removes_selected_and_preserves_late_input() {
        let mut queue = InputQueueState::new(VecDeque::new());
        queue.enqueue(input_queue_test_message(
            "normal_1",
            InputUrgency::Normal,
            InputSource::User,
        ));
        queue.enqueue(input_queue_test_message(
            "urgent_1",
            InputUrgency::Urgent,
            InputSource::User,
        ));
        queue.enqueue(input_queue_test_message(
            "normal_2",
            InputUrgency::Normal,
            InputSource::User,
        ));
        let batch = queue.begin_drain();
        queue.enqueue(input_queue_test_message(
            "urgent_late",
            InputUrgency::Urgent,
            InputSource::User,
        ));

        let plan = queue
            .prepare_commit(&batch.id)
            .expect("pending batch should prepare");
        let result = queue
            .finish_commit(&plan)
            .expect("pending batch should finish");

        assert_eq!(result.queue_length, 1);
        assert_eq!(result.callback_delivery_input_ids, Vec::<String>::new());
        assert_eq!(
            queue
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["urgent_late"]
        );
    }

    #[test]
    fn input_queue_state_commit_reports_callback_delivery_ids() {
        let mut queue = InputQueueState::new(VecDeque::new());
        queue.enqueue(input_queue_test_message(
            "callback_1",
            InputUrgency::Normal,
            InputSource::TaskCallback,
        ));
        queue.enqueue(input_queue_test_message(
            "user_1",
            InputUrgency::Normal,
            InputSource::User,
        ));
        queue.enqueue(input_queue_test_message(
            "callback_2",
            InputUrgency::Normal,
            InputSource::TaskCallback,
        ));
        let batch = queue.begin_drain();
        let plan = queue
            .prepare_commit(&batch.id)
            .expect("pending batch should prepare");
        let result = queue
            .finish_commit(&plan)
            .expect("pending batch should finish");

        assert_eq!(
            result.callback_delivery_input_ids,
            vec!["callback_1", "callback_2"]
        );
        assert_eq!(result.queue_length, 0);
    }

    #[tokio::test]
    async fn callback_delivered_append_failure_keeps_delivery_state_and_queue_pending() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_delivery", "bash", "{}"));
        let callback_id = "task_callback_delivery_append_fails";
        let callback_content = vec![ContentPart::text("<task_callback />")];
        service
            .inner
            .background_tasks
            .set_callback_pending(&task.task_id, callback_id, callback_content.clone())
            .expect("callback should become pending");
        service
            .inner
            .background_tasks
            .set_callback_enqueued(&task.task_id)
            .expect("callback should become enqueued");

        let cursor = service.current_event_cursor();
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.input_queue.enqueue(QueuedMessage {
                id: callback_id.to_owned(),
                content: callback_content.clone(),
                source: InputSource::TaskCallback,
                urgency: InputUrgency::Normal,
                metadata: None,
                cursor_seq: cursor.seq(),
            });
            insert_message_index_entry(
                &mut state.message_index,
                callback_id.to_owned(),
                callback_content,
                cursor,
            );
        }

        let batch = service.begin_drain(CancellationToken::new()).await;
        let commit = service
            .commit(&batch.id)
            .await
            .expect("commit should prepare callback delivery");
        assert_eq!(
            commit.callback_delivery_input_ids,
            vec![callback_id.to_owned()]
        );

        service.inject_timeline_write_failure_after_events(1, TimelineWriteFailure::Flush);
        let error = service
            .complete_commit(&batch.id, &commit, Some("cyc_delivery"))
            .await
            .expect_err("task.callback_delivered append should fail");
        assert!(error.to_string().contains("timeline"));
        assert_eq!(service.status().queue_length, 1);
        assert_eq!(
            service
                .inner
                .background_tasks
                .get(&task.task_id)
                .expect("task should remain")
                .callback_delivery,
            CallbackDelivery::Enqueued
        );
        assert!(!service
            .events_after(0)
            .iter()
            .any(|event| event.event_type == "task.callback_delivered"));

        let retry_commit = service
            .commit(&batch.id)
            .await
            .expect("failed delivered append should leave batch retryable");
        service
            .complete_commit(&batch.id, &retry_commit, Some("cyc_delivery"))
            .await
            .expect("retry should deliver callback");

        assert_eq!(service.status().queue_length, 0);
        assert_eq!(
            service
                .inner
                .background_tasks
                .get(&task.task_id)
                .expect("task should remain")
                .callback_delivery,
            CallbackDelivery::Delivered
        );
        let delivered = service
            .events_after(0)
            .into_iter()
            .filter(|event| event.event_type == "task.callback_delivered")
            .collect::<Vec<_>>();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].data["callback_input_id"], json!(callback_id));
        assert_eq!(delivered[0].data["callback_delivery"], json!("delivered"));
        assert_eq!(delivered[0].data["cycle_id"], json!("cyc_delivery"));
    }

    #[tokio::test]
    async fn complete_commit_recomputes_callback_delivery_from_pending_batch() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_delivery_recomputed",
                "bash",
                "{}",
            ));
        let callback_id = "task_callback_delivery_recomputed";
        let callback_content = vec![ContentPart::text("<task_callback />")];
        service
            .inner
            .background_tasks
            .set_callback_pending(&task.task_id, callback_id, callback_content.clone())
            .expect("callback should become pending");
        service
            .inner
            .background_tasks
            .set_callback_enqueued(&task.task_id)
            .expect("callback should become enqueued");

        let cursor = service.current_event_cursor();
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.input_queue.enqueue(QueuedMessage {
                id: callback_id.to_owned(),
                content: callback_content.clone(),
                source: InputSource::TaskCallback,
                urgency: InputUrgency::Normal,
                metadata: None,
                cursor_seq: cursor.seq(),
            });
            insert_message_index_entry(
                &mut state.message_index,
                callback_id.to_owned(),
                callback_content,
                cursor,
            );
        }

        let batch = service.begin_drain(CancellationToken::new()).await;
        let commit = service
            .commit(&batch.id)
            .await
            .expect("commit should prepare callback delivery");
        assert_eq!(
            commit.callback_delivery_input_ids,
            vec![callback_id.to_owned()]
        );
        let tampered_commit = DrainCommit::new(commit.queue_length);

        service
            .complete_commit(&batch.id, &tampered_commit, Some("cyc_recomputed"))
            .await
            .expect("commit should complete from internal pending-batch state");

        assert_eq!(service.status().queue_length, 0);
        assert_eq!(
            service
                .inner
                .background_tasks
                .get(&task.task_id)
                .expect("task should remain")
                .callback_delivery,
            CallbackDelivery::Delivered
        );
        let delivered = service
            .events_after(0)
            .into_iter()
            .filter(|event| event.event_type == "task.callback_delivered")
            .collect::<Vec<_>>();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].data["callback_input_id"], json!(callback_id));
        assert_eq!(delivered[0].data["cycle_id"], json!("cyc_recomputed"));
    }

    #[tokio::test]
    async fn subagent_callback_delivered_append_failure_keeps_delivery_state_and_queue_pending() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let subagent = open_test_subagent(&service, "worker");
        let callback_id = "subagent_callback_delivery_append_fails";
        {
            let mut manager = service
                .inner
                .subagents
                .lock()
                .expect("subagent manager mutex poisoned");
            manager
                .record_callback(
                    &subagent.id,
                    callback_id,
                    "completed",
                    SubagentCallbackStatus::Pending,
                    None,
                )
                .expect("subagent callback should be pending");
        }

        let callback_content = vec![ContentPart::text("<subagent_callback />")];
        let cursor = service.current_event_cursor();
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.input_queue.enqueue(QueuedMessage {
                id: callback_id.to_owned(),
                content: callback_content.clone(),
                source: InputSource::SubagentCallback,
                urgency: InputUrgency::Normal,
                metadata: Some(QueuedInputMetadata::SubagentCallback {
                    subagent_id: subagent.id.clone(),
                    callback_id: callback_id.to_owned(),
                    kind: "completed".to_owned(),
                }),
                cursor_seq: cursor.seq(),
            });
            insert_message_index_entry(
                &mut state.message_index,
                callback_id.to_owned(),
                callback_content,
                cursor,
            );
        }

        let batch = service.begin_drain(CancellationToken::new()).await;
        let commit = service
            .commit(&batch.id)
            .await
            .expect("commit should prepare callback delivery");
        assert_eq!(
            commit.callback_delivery_input_ids,
            vec![callback_id.to_owned()]
        );

        service.inject_timeline_write_failure_after_events(1, TimelineWriteFailure::Flush);
        service
            .complete_commit(&batch.id, &commit, Some("cyc_subagent_delivery"))
            .await
            .expect_err("subagent.callback_delivered append should fail");
        assert_eq!(service.status().queue_length, 1);
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent.id)
            .expect("subagent should remain");
        assert_eq!(snapshot.pending_callback_count, 1);
        assert_eq!(
            snapshot
                .callbacks
                .last()
                .expect("callback should remain")
                .status,
            SubagentCallbackStatus::Pending
        );
        assert!(!service
            .events_after(0)
            .iter()
            .any(|event| event.event_type == "subagent.callback_delivered"));

        let retry_commit = service
            .commit(&batch.id)
            .await
            .expect("failed delivered append should leave batch retryable");
        service
            .complete_commit(&batch.id, &retry_commit, Some("cyc_subagent_delivery"))
            .await
            .expect("retry should deliver callback");

        assert_eq!(service.status().queue_length, 0);
        let snapshot = service
            .inner
            .subagents
            .lock()
            .expect("subagent manager mutex poisoned")
            .snapshot(&subagent.id)
            .expect("subagent should remain");
        assert_eq!(snapshot.pending_callback_count, 0);
        assert_eq!(
            snapshot
                .callbacks
                .last()
                .expect("callback should be delivered")
                .status,
            SubagentCallbackStatus::Delivered
        );
        let delivered = service
            .events_after(0)
            .into_iter()
            .filter(|event| event.event_type == "subagent.callback_delivered")
            .collect::<Vec<_>>();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].data["callback_id"], json!(callback_id));
        assert_eq!(delivered[0].data["callback_status"], json!("delivered"));
    }

    #[test]
    fn input_queue_state_wrong_commit_or_cleared_batch_does_not_modify_queue() {
        let mut queue = InputQueueState::new(VecDeque::new());
        queue.enqueue(input_queue_test_message(
            "msg_1",
            InputUrgency::Normal,
            InputSource::User,
        ));
        let batch = queue.begin_drain();

        let wrong = queue
            .prepare_commit("batch_wrong")
            .expect_err("wrong batch id should fail");
        assert!(wrong.to_string().contains("mismatch"));
        assert_eq!(queue.len(), 1);
        assert!(queue.has_pending_batch());

        let plan = queue
            .prepare_commit(&batch.id)
            .expect("pending batch should prepare");
        queue.rollback(&batch.id);
        let cleared = queue
            .finish_commit(&plan)
            .expect_err("cleared batch should fail");
        assert!(cleared.to_string().contains("cleared"));
        assert_eq!(queue.len(), 1);
        assert!(!queue.has_pending_batch());
    }

    #[test]
    fn input_queue_state_drain_preserves_source_metadata_urgency_and_cursor() {
        let mut queue = InputQueueState::new(VecDeque::new());
        queue.enqueue(input_queue_task_request_message(
            "task_request_1",
            "task_1",
            "request_1",
        ));

        let batch = queue.begin_drain();
        assert_eq!(batch.messages.len(), 1);
        let message = &batch.messages[0];
        assert_eq!(message.id, "task_request_1");
        assert_eq!(message.source, InputSource::TaskRequest);
        assert_eq!(message.urgency, InputUrgency::Urgent);
        assert_eq!(message.cursor_seq, Some(42));
        assert_eq!(
            message.metadata,
            Some(QueuedInputMetadata::TaskRequest {
                task_id: "task_1".to_owned(),
                request_id: "request_1".to_owned(),
            })
        );
    }

    #[tokio::test]
    async fn session_accepted_record_failure_does_not_mutate_enqueue_state() {
        let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
            PathBuf::from("session.jsonl"),
            FailingSyncSessionFile,
        ));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-session-record-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        );
        let before_seq = service.inner.last_event_seq();

        let error = service
            .enqueue(
                "msg_session_record_fails",
                vec![ContentPart::text("not durable")],
            )
            .await
            .expect_err("session accepted write failure should reject enqueue");

        assert!(matches!(error, ServiceError::Persistence { .. }));
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert_eq!(state.state, ServiceState::Idle);
        assert_eq!(state.input_queue.len(), 0);
        assert_eq!(state.next_turn_number, 1);
        assert_eq!(state.active_turn_id, None);
        assert!(state.active_cancel.is_none());
        assert!(!state.message_index.contains_key("msg_session_record_fails"));
        drop(state);

        let failed_events = service.events_after(before_seq);
        assert!(
            failed_events.is_empty(),
            "session accepted failure must not publish ghost timeline events: {failed_events:?}"
        );
    }

    #[tokio::test]
    async fn timeline_append_failure_with_session_rollback_failure_does_not_mutate_enqueue_state() {
        let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
            PathBuf::from("session.jsonl"),
            RollbackSetLenFailureSessionFile::default(),
        ));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-session-rollback-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        );
        let before_seq = service.inner.last_event_seq();
        service.inject_timeline_write_failure_after_events(0, TimelineWriteFailure::Append);

        let error = service
            .enqueue(
                "msg_session_rollback_fails",
                vec![ContentPart::text(
                    "timeline failure should roll back session",
                )],
            )
            .await
            .expect_err("timeline failure with session rollback failure should reject enqueue");

        assert!(matches!(error, ServiceError::Persistence { .. }));
        let message = error.to_string();
        assert!(
            message.contains("timeline persistence failed"),
            "error should retain timeline persistence failure: {message}"
        );
        assert!(
            message.contains("injected timeline append failure"),
            "error should include the timeline append failure: {message}"
        );
        assert!(
            message.contains("session accepted rollback failed"),
            "error should include the accepted rollback failure: {message}"
        );
        assert!(
            message.contains("rollback set_len failed"),
            "error should include the rollback set_len failure: {message}"
        );

        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert_eq!(state.state, ServiceState::Idle);
        assert_eq!(state.input_queue.len(), 0);
        assert_eq!(state.next_turn_number, 1);
        assert_eq!(state.active_turn_id, None);
        assert!(state.active_cancel.is_none());
        assert!(!state
            .message_index
            .contains_key("msg_session_rollback_fails"));
        drop(state);

        let failed_events = service.events_after(before_seq);
        assert!(
            failed_events.is_empty(),
            "timeline failure with rollback failure must not publish ghost events: {failed_events:?}"
        );
    }

    #[test]
    fn input_queue_state_task_request_candidates_and_stale_removal_match_source_metadata() {
        let mut queue = InputQueueState::new(VecDeque::new());
        queue.enqueue(input_queue_task_request_message(
            "task_request_match",
            "task_1",
            "request_1",
        ));
        queue.enqueue(input_queue_test_message(
            "normal_user",
            InputUrgency::Normal,
            InputSource::User,
        ));
        queue.enqueue(input_queue_task_request_message(
            "task_request_other",
            "task_1",
            "request_2",
        ));
        queue.enqueue(QueuedMessage {
            id: "task_request_missing_metadata".to_owned(),
            content: vec![ContentPart::text("invalid task request")],
            source: InputSource::TaskRequest,
            urgency: InputUrgency::Normal,
            metadata: None,
            cursor_seq: 99,
        });

        let candidates = queue.task_request_candidates();
        assert_eq!(candidates.len(), 2);
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| (
                    candidate.message_id.as_str(),
                    candidate.task_id.as_str(),
                    candidate.request_id.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("task_request_match", "task_1", "request_1"),
                ("task_request_other", "task_1", "request_2"),
            ]
        );

        let removed = queue.remove_stale_task_request(&StaleTaskRequest {
            candidate: QueuedTaskRequestCandidate {
                message_id: "task_request_match".to_owned(),
                task_id: "task_1".to_owned(),
                request_id: "request_1".to_owned(),
                source: InputSource::TaskRequest,
                metadata: QueuedInputMetadata::TaskRequest {
                    task_id: "task_1".to_owned(),
                    request_id: "request_1".to_owned(),
                },
            },
            state: Some(TaskRequestState::Expired),
            reason: "request_not_pending",
        });

        assert!(removed);
        assert_eq!(queue.len(), 3);
        assert_eq!(
            queue
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "normal_user",
                "task_request_other",
                "task_request_missing_metadata"
            ]
        );
    }

    #[test]
    fn replay_message_index_and_durable_replays_are_bounded_to_recent_window_plus_pending() {
        let total = crate::session::DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW + 9;
        let known_user_messages = (0..total).map(replay_known_message).collect::<Vec<_>>();
        let message_cursors = (0..total).map(replay_cursor).collect::<Vec<_>>();
        let pending_messages = vec![replay_known_message(0)];

        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            pending_messages,
            known_user_messages,
            message_cursors,
            None,
            Vec::new(),
            ServiceLimits::default(),
        );

        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert_eq!(state.input_queue.len(), 1);
        assert_eq!(
            state.message_index.len(),
            crate::session::DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW + 1
        );
        assert!(
            state.message_index.contains_key("msg_0"),
            "pending input must stay indexed even when it is older than the retained window"
        );
        assert!(
            !state.message_index.contains_key("msg_1"),
            "old committed-only ids outside the retained window should be evicted"
        );
        assert!(state
            .message_index
            .contains_key(&format!("msg_{}", total - 1)));
        assert_eq!(
            state.durable_message_replays.len(),
            crate::session::DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW
        );
        assert!(!state.durable_message_replays.contains_key("msg_1"));
        assert!(state
            .durable_message_replays
            .contains_key(&format!("msg_{}", total - 1)));
    }

    #[tokio::test]
    async fn service_background_host_rejects_publish_after_shutdown_and_cancels_task() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-host-shutdown"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let host = ServiceBackgroundExecutionHost {
            inner: service.inner.clone(),
            owner: TaskOwner::Main,
        };
        let cancel = CancellationToken::new();

        let shutdown = service.shutdown().await;
        assert_eq!(shutdown.state, ServiceState::ShuttingDown);

        let published = host.publish_task(
            "task_after_shutdown".to_owned(),
            NewBackgroundTask::new("call_after_shutdown", "bash", "{}")
                .with_cancel_token(cancel.clone()),
        );

        assert!(!published);
        assert!(cancel.is_cancelled());
        assert!(service.get_background_task("task_after_shutdown").is_none());
        assert!(!service
            .events_after(0)
            .iter()
            .any(|event| event.event_type == "task.detached"));
    }

    #[tokio::test]
    async fn service_background_host_rejects_publish_when_task_detached_event_fails() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-host-detached-write-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let host = ServiceBackgroundExecutionHost {
            inner: service.inner.clone(),
            owner: TaskOwner::Main,
        };
        let cancel = CancellationToken::new();
        let before_seq = service.status().last_event_seq;
        service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

        let published = host.publish_task(
            "task_detached_write_fails".to_owned(),
            NewBackgroundTask::new("call_detached_write_fails", "bash", "{}")
                .with_cancel_token(cancel.clone()),
        );

        assert!(!published);
        assert!(cancel.is_cancelled());
        assert!(service
            .get_background_task("task_detached_write_fails")
            .is_none());
        assert_eq!(service.status().state, ServiceState::Failed);
        assert!(service
            .status()
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("timeline persistence failed")));
        assert!(!service
            .events_after(before_seq)
            .iter()
            .any(|event| event.event_type == "task.detached"));
    }

    #[tokio::test]
    async fn service_background_host_rejects_publish_when_status_event_fails() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-host-status-write-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let host = ServiceBackgroundExecutionHost {
            inner: service.inner.clone(),
            owner: TaskOwner::Main,
        };
        let cancel = CancellationToken::new();
        let before_seq = service.status().last_event_seq;
        service.inject_timeline_write_failure_after_events(1, TimelineWriteFailure::Flush);

        let published = host.publish_task(
            "task_status_write_fails".to_owned(),
            NewBackgroundTask::new("call_status_write_fails", "bash", "{}")
                .with_cancel_token(cancel.clone()),
        );

        assert!(!published);
        assert!(cancel.is_cancelled());
        let task = service
            .get_background_task("task_status_write_fails")
            .expect("durable detached task should remain inspectable");
        assert_eq!(task["state"], "failed");
        assert_eq!(service.status().state, ServiceState::Failed);
        assert!(service
            .status()
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("timeline persistence failed")));
        let events = service.events_after(before_seq);
        assert!(events
            .iter()
            .any(|event| event.event_type == "task.detached"));
        assert!(
            events.iter().any(|event| event.event_type == "task.failed"),
            "failed task should be durably visible after startup status failure: {events:?}"
        );
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "service.status"),
            "service should publish a later failed status after the injected status failure: {events:?}"
        );
    }

    #[tokio::test]
    async fn service_background_host_terminal_append_failure_does_not_enqueue_callback_or_start_agent(
    ) {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::new(
            AgentConfig::new("system").with_session("service-host-terminal-write-failure"),
            provider.clone(),
            Vec::new(),
        );
        let host = ServiceBackgroundExecutionHost {
            inner: service.inner.clone(),
            owner: TaskOwner::Main,
        };
        let task_id = "task_terminal_write_fails".to_owned();
        assert!(host.publish_task(
            task_id.clone(),
            NewBackgroundTask::new("call_terminal_write_fails", "bash", "{}"),
        ));
        let active_cancel = CancellationToken::new();
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_active_terminal_failure".to_owned());
            state.active_cancel = Some(active_cancel.clone());
        }
        service
            .inner
            .background_tasks
            .update_output(&task_id, TaskOutputUpdate::bytes("already captured"))
            .expect("task output should update");
        let before_seq = service.status().last_event_seq;
        service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);
        let tool_call = ToolCall::new("call_terminal_write_fails", "bash", json!({}));

        host.finish_task(
            task_id.clone(),
            tool_call.clone(),
            DetachedToolResult {
                tool_result: ToolResult::success(tool_call.id, tool_call.name, "done"),
                state: TaskState::Completed,
            },
        )
        .await;
        tokio::task::yield_now().await;

        let snapshot = service
            .inner
            .background_tasks
            .get(&task_id)
            .expect("task should remain visible after terminal append failure");
        assert_eq!(snapshot.state, TaskState::Completed);
        assert_eq!(snapshot.callback_delivery, CallbackDelivery::NotReady);
        assert_eq!(service.status().state, ServiceState::Failed);
        assert!(active_cancel.is_cancelled());
        assert_eq!(service.status().queue_length, 0);
        assert_eq!(provider.calls(), 0);
        let events = service.events_after(before_seq);
        assert!(
            !events.iter().any(|event| matches!(
                event.event_type.as_str(),
                "task.completed" | "task.callback_pending" | "task.callback_queued"
            )),
            "terminal append failure must not publish or advance callback events: {events:?}"
        );
    }

    #[tokio::test]
    async fn service_background_host_callback_pending_append_failure_rolls_back_pending_callback() {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::new(
            AgentConfig::new("system").with_session("service-host-callback-pending-write-failure"),
            provider.clone(),
            Vec::new(),
        );
        let host = ServiceBackgroundExecutionHost {
            inner: service.inner.clone(),
            owner: TaskOwner::Main,
        };
        let task_id = "task_callback_pending_write_fails".to_owned();
        assert!(host.publish_task(
            task_id.clone(),
            NewBackgroundTask::new("call_callback_pending_write_fails", "bash", "{}"),
        ));
        let active_cancel = CancellationToken::new();
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_active_callback_pending_failure".to_owned());
            state.active_cancel = Some(active_cancel.clone());
        }
        service
            .inner
            .background_tasks
            .update_output(&task_id, TaskOutputUpdate::bytes("already captured"))
            .expect("task output should update");
        let before_seq = service.status().last_event_seq;
        service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);
        let tool_call = ToolCall::new("call_callback_pending_write_fails", "bash", json!({}));

        host.finish_task(
            task_id.clone(),
            tool_call.clone(),
            DetachedToolResult {
                tool_result: ToolResult::success(tool_call.id, tool_call.name, "done"),
                state: TaskState::Completed,
            },
        )
        .await;
        tokio::task::yield_now().await;

        let snapshot = service
            .inner
            .background_tasks
            .get(&task_id)
            .expect("task should remain visible after callback append failure");
        assert_eq!(snapshot.state, TaskState::Completed);
        assert_eq!(snapshot.callback_delivery, CallbackDelivery::NotReady);
        assert_eq!(snapshot.callback_payload, None);
        assert_eq!(service.status().state, ServiceState::Failed);
        assert!(active_cancel.is_cancelled());
        assert_eq!(service.status().queue_length, 0);
        assert_eq!(provider.calls(), 0);
        let events = service.events_after(before_seq);
        assert!(events
            .iter()
            .any(|event| event.event_type == "task.completed"));
        assert!(
            !events.iter().any(|event| matches!(
                event.event_type.as_str(),
                "task.callback_pending" | "task.callback_queued"
            )),
            "callback pending append failure must not publish callback events: {events:?}"
        );
    }

    #[tokio::test]
    async fn pending_task_callback_queued_append_failure_does_not_mark_enqueued_or_start_agent() {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::new(
            AgentConfig::new("system").with_session("service-host-callback-queued-write-failure"),
            provider.clone(),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_callback_queued_write_fails",
                "bash",
                "{}",
            ));
        let callback_id = "task_callback_queued_write_fails";
        service
            .inner
            .background_tasks
            .set_callback_pending(
                &task.task_id,
                callback_id,
                vec![ContentPart::text("<task_callback />")],
            )
            .expect("callback should become pending");
        let before_seq = service.status().last_event_seq;
        service.inject_timeline_write_failure_after_events(2, TimelineWriteFailure::Flush);

        retry_pending_task_callbacks(service.inner.clone()).await;
        tokio::task::yield_now().await;

        let snapshot = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task should remain visible after queued append failure");
        assert_eq!(snapshot.callback_delivery, CallbackDelivery::Pending);
        assert_eq!(service.status().state, ServiceState::Failed);
        assert_eq!(provider.calls(), 0);
        let events = service.events_after(before_seq);
        assert!(
            !events
                .iter()
                .any(|event| event.event_type == "task.callback_queued"),
            "failed task.callback_queued append must not publish queued event: {events:?}"
        );
    }

    #[tokio::test]
    async fn pending_task_callback_enqueue_persistence_failure_keeps_pending_callback() {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::new(
            AgentConfig::new("system")
                .with_session("service-host-callback-enqueue-persistence-failure"),
            provider.clone(),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_callback_enqueue_write_fails",
                "bash",
                "{}",
            ));
        let callback_id = "task_callback_enqueue_write_fails";
        service
            .inner
            .background_tasks
            .set_callback_pending(
                &task.task_id,
                callback_id,
                vec![ContentPart::text("<task_callback />")],
            )
            .expect("callback should become pending");
        let before_seq = service.status().last_event_seq;
        service.inject_timeline_write_failure_after_events(1, TimelineWriteFailure::Flush);

        retry_pending_task_callbacks(service.inner.clone()).await;
        tokio::task::yield_now().await;

        let snapshot = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task should remain visible after callback enqueue failure");
        assert_eq!(snapshot.callback_delivery, CallbackDelivery::Pending);
        assert_eq!(service.status().state, ServiceState::Failed);
        assert_eq!(service.status().queue_length, 0);
        assert_eq!(provider.calls(), 0);
        let events = service.events_after(before_seq);
        assert!(events
            .iter()
            .any(|event| event.event_type == "message.received"));
        assert!(
            !events.iter().any(|event| matches!(
                event.event_type.as_str(),
                "task.callback_failed" | "task.callback_queued"
            )),
            "callback enqueue persistence failure must leave callback pending: {events:?}"
        );
    }

    #[tokio::test]
    async fn pending_task_callback_failed_append_failure_restores_pending_callback() {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::new(
            AgentConfig::new("system").with_session("service-host-callback-failed-write-failure"),
            provider.clone(),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_callback_failed_write_fails",
                "bash",
                "{}",
            ));
        let callback_id = "task_callback_failed_write_fails";
        service
            .inner
            .background_tasks
            .set_callback_pending(&task.task_id, callback_id, Vec::new())
            .expect("callback should become pending");
        let before_seq = service.status().last_event_seq;
        service.inject_next_timeline_write_failure(TimelineWriteFailure::Flush);

        retry_pending_task_callbacks(service.inner.clone()).await;

        let snapshot = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task should remain visible after callback failed append failure");
        assert_eq!(snapshot.callback_delivery, CallbackDelivery::Pending);
        assert_eq!(service.status().state, ServiceState::Failed);
        assert_eq!(provider.calls(), 0);
        let events = service.events_after(before_seq);
        assert!(
            !events
                .iter()
                .any(|event| event.event_type == "task.callback_failed"),
            "failed task.callback_failed append must not publish a fake terminal callback event: {events:?}"
        );
    }

    #[tokio::test]
    async fn callback_queued_status_failure_cancels_active_turn_and_failed_drain_is_empty() {
        let provider = Arc::new(CountingProvider::new());
        let service = Service::new(
            AgentConfig::new("system")
                .with_session("service-host-callback-queued-status-write-failure"),
            provider.clone(),
            Vec::new(),
        );
        let active_cancel = CancellationToken::new();
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            state.state = ServiceState::Running;
            state.active_turn_id = Some("turn_active".to_owned());
            state.active_cancel = Some(active_cancel.clone());
        }
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_callback_queued_status_write_fails",
                "bash",
                "{}",
            ));
        let callback_id = "task_callback_queued_status_write_fails";
        service
            .inner
            .background_tasks
            .set_callback_pending(
                &task.task_id,
                callback_id,
                vec![ContentPart::text("<task_callback />")],
            )
            .expect("callback should become pending");
        service.inject_timeline_write_failure_after_events(4, TimelineWriteFailure::Flush);

        retry_pending_task_callbacks(service.inner.clone()).await;
        tokio::task::yield_now().await;

        let snapshot = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task should remain visible after callback queued status failure");
        assert_eq!(snapshot.callback_delivery, CallbackDelivery::Enqueued);
        assert_eq!(service.status().state, ServiceState::Failed);
        assert!(active_cancel.is_cancelled());
        assert_eq!(provider.calls(), 0);

        let batch = service.begin_drain(CancellationToken::new()).await;
        assert_eq!(batch.id, "batch_failed");
        assert!(
            batch.messages.is_empty(),
            "failed service must not drain queued callback inputs"
        );
    }

    #[tokio::test]
    async fn service_interactive_frame_after_shutdown_has_no_side_effects() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-late-frame-after-shutdown"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let shutdown = service.shutdown().await;
        assert_eq!(shutdown.state, ServiceState::ShuttingDown);
        let seq_after_shutdown = service.status().last_event_seq;
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: "task_after_shutdown".to_owned(),
        };

        bridge.handle_frame_events(vec![
            BotifiedFrameEvent::Diagnostic(TaskFrameDiagnostic {
                op: Some("ask".to_owned()),
                code: "invalid_frame",
                message: "late diagnostic".to_owned(),
                request_id: Some("diagnostic_1".to_owned()),
            }),
            BotifiedFrameEvent::Ask(TaskRequestFrame {
                id: "request_1".to_owned(),
                request: "late request".to_owned(),
                expect: None,
                timeout: Some(Duration::from_millis(1)),
                urgency: InputUrgency::Normal,
            }),
        ]);
        tokio::task::yield_now().await;

        let late_events = service.events_after(seq_after_shutdown);
        assert!(
            late_events.is_empty(),
            "late frame after shutdown should not emit service events: {late_events:?}"
        );
        assert_eq!(service.status().state, ServiceState::ShuttingDown);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn service_interactive_frame_admission_gate_linearizes_before_shutdown() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-frame-race-shutdown"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let seq_before_frame = service.status().last_event_seq;
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release_rx = Arc::new(Mutex::new(Some(release_rx)));
        service
            .inner
            .set_task_frame_admission_hook_for_test(Some(Arc::new(move |kind| {
                if kind != TaskFrameAdmissionKind::Ask {
                    return;
                }
                let _ = entered_tx.send(());
                if let Some(release_rx) = release_rx
                    .lock()
                    .expect("release receiver mutex poisoned")
                    .take()
                {
                    release_rx
                        .recv_timeout(Duration::from_secs(1))
                        .expect("admission test hook should be released");
                }
            })));
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: "missing_task_frame_race".to_owned(),
        };

        bridge.handle_frame_events(vec![BotifiedFrameEvent::Ask(TaskRequestFrame {
            id: "request_race".to_owned(),
            request: "late request".to_owned(),
            expect: None,
            timeout: Some(Duration::from_secs(30)),
            urgency: InputUrgency::Normal,
        })]);
        tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(1)))
            .await
            .expect("admission wait task should not panic")
            .expect("frame handler should enter the admission gate");

        let shutdown_service = service.clone();
        let mut shutdown = tokio::spawn(async move { shutdown_service.shutdown().await });
        tokio::time::timeout(Duration::from_millis(50), &mut shutdown)
            .await
            .expect_err("shutdown should wait for the in-flight admission gate");
        release_tx
            .send(())
            .expect("admission test hook should accept release");
        let shutdown = tokio::time::timeout(Duration::from_secs(1), shutdown)
            .await
            .expect("shutdown should finish after admission gate releases")
            .expect("shutdown task should not panic");
        service.inner.set_task_frame_admission_hook_for_test(None);
        assert_eq!(shutdown.state, ServiceState::ShuttingDown);

        let events = service.events_after(seq_before_frame);
        let rejected = events
            .iter()
            .filter(|event| {
                event.event_type == "task_ask.rejected"
                    && event.data["ask_id"] == json!("request_race")
            })
            .collect::<Vec<_>>();
        assert_eq!(
            rejected.len(),
            1,
            "request should be rejected once: {events:?}"
        );
        let shutdown_status = events
            .iter()
            .find(|event| {
                event.event_type == "service.status"
                    && event.data["state"] == json!("shutting_down")
            })
            .expect("shutdown status should be recorded");
        assert!(
            rejected[0].seq < shutdown_status.seq,
            "admission-first task request must be ordered before shutdown status: {events:?}"
        );
        assert_eq!(service.status().state, ServiceState::ShuttingDown);
    }

    #[tokio::test]
    async fn task_request_deadline_after_failed_service_has_no_side_effects() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-request-deadline-after-failed"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_deadline_after_failed",
                "bash",
                "{}",
            ));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        assert!(matches!(
            service.inner.admit_task_request_frame(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need answer".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_millis(1)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestFrameAdmission::Accepted(_)
        ));
        service.inner.mark_failed("timeline persistence failed");
        let before_seq = service.inner.last_event_seq();

        service
            .inner
            .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));

        let snapshot = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task should remain inspectable");
        let request = snapshot
            .requests
            .iter()
            .find(|request| request.request_id == "r1")
            .expect("request should exist");
        assert_eq!(request.state, TaskRequestState::Pending);
        assert_eq!(stdin.text(), "");
        let events = service.events_after(before_seq);
        assert!(
            events.is_empty(),
            "failed service must not expire task requests or write stdin: {events:?}"
        );
    }

    #[tokio::test]
    async fn task_reply_after_failed_or_shutdown_has_no_side_effects() {
        for state in [ServiceState::Failed, ServiceState::ShuttingDown] {
            let service = Service::new(
                AgentConfig::new("system")
                    .with_session(format!("service-task-reply-after-{state:?}")),
                Arc::new(PanicProvider),
                Vec::new(),
            );
            let task = service
                .inner
                .background_tasks
                .start_task(NewBackgroundTask::new(
                    "call_reply_after_stop",
                    "bash",
                    "{}",
                ));
            let stdin = RecordingTaskStdin::default();
            service
                .inner
                .background_tasks
                .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
                .expect("task exists");
            assert!(matches!(
                service.inner.admit_task_request_frame(
                    &task.task_id,
                    TaskRequestFrame {
                        id: "r1".to_owned(),
                        request: "need answer".to_owned(),
                        expect: None,
                        timeout: Some(Duration::from_secs(30)),
                        urgency: InputUrgency::Normal,
                    },
                ),
                TaskRequestFrameAdmission::Accepted(_)
            ));
            {
                let mut locked = service
                    .inner
                    .state
                    .lock()
                    .expect("service state mutex poisoned");
                locked.state = state;
            }
            let before_seq = service.inner.last_event_seq();

            let outcome = service
                .inner
                .reply_task_request(&task.task_id, "r1", "normal response");

            assert_eq!(outcome.status, TaskReplyStatus::Failed);
            assert_eq!(outcome.message, "service is not accepting task replies");
            assert_eq!(stdin.text(), "");
            let snapshot = service
                .inner
                .background_tasks
                .get(&task.task_id)
                .expect("task should remain inspectable");
            let request = snapshot
                .requests
                .iter()
                .find(|request| request.request_id == "r1")
                .expect("request should exist");
            assert_eq!(request.state, TaskRequestState::Pending);
            let events = service.events_after(before_seq);
            assert!(
                events.is_empty(),
                "stopped service must not append task reply events for {state:?}: {events:?}"
            );
        }
    }

    #[tokio::test]
    async fn task_send_writes_unified_frame_without_resolving_pending_ask() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-send-pending-ask"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_send_pending", "bash", "{}"));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        assert!(matches!(
            service.inner.admit_task_request_frame(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need answer".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_secs(30)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestFrameAdmission::Accepted(_)
        ));

        let send = service.inner.send_task_message_by_owner(
            &TaskOwner::Main,
            &task.task_id,
            "pause after current segment",
        );

        assert_eq!(send.status, TaskSendStatus::Written);
        let send_id = send
            .send_id
            .expect("successful send should include send_id");
        assert_eq!(
            stdin.text(),
            format!(
                "<botified>{{\"op\":\"send\",\"id\":\"{send_id}\",\"message\":\"pause after current segment\"}}</botified>\n"
            )
        );
        let snapshot = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task exists");
        let request = snapshot
            .requests
            .iter()
            .find(|request| request.request_id == "r1")
            .expect("pending ask exists");
        assert_eq!(request.state, TaskRequestState::Pending);

        let reply = service
            .inner
            .reply_task_request(&task.task_id, "r1", "answer");
        assert_eq!(reply.status, TaskReplyStatus::Written);
        let stdin_text = stdin.text();
        assert!(stdin_text.contains("\"op\":\"send\""));
        assert!(stdin_text.contains("\"op\":\"reply\""));
        assert_eq!(stdin_text.matches("<botified>").count(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn task_send_unsupported_priority_writer_fails_fast_without_sync_fallback() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-send-unsupported-priority"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_send_unsupported_priority",
                "bash",
                "{}",
            ));
        let (stdin, started) = BlockingTaskStdin::new();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        let _release_guard = stdin.release_on_drop();

        let inner = service.inner.clone();
        let task_id = task.task_id.clone();
        let outcome = match run_on_thread_with_timeout(Duration::from_millis(200), move || {
            inner.send_task_message_by_owner(&TaskOwner::Main, &task_id, "hello")
        }) {
            Ok(outcome) => outcome,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                panic!("task_send waited on synchronous write_stdin fallback")
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                panic!("task_send helper thread exited without an outcome")
            }
        };

        assert_eq!(outcome.status, TaskSendStatus::WriteFailed);
        assert!(
            outcome.message.contains("unsupported"),
            "{}",
            outcome.message
        );
        assert_eq!(stdin.completed_writes(), 0);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), started)
                .await
                .is_err(),
            "unsupported priority writer must not call synchronous write_stdin"
        );
    }

    #[test]
    fn task_send_would_block_priority_writer_fails_without_sync_fallback() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-send-would-block"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_send_would_block",
                "bash",
                "{}",
            ));
        let stdin = WouldBlockPriorityTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");

        let outcome = service.inner.send_task_message_by_owner(
            &TaskOwner::Main,
            &task.task_id,
            "priority frame should fail fast",
        );

        assert_eq!(outcome.status, TaskSendStatus::WriteFailed);
        assert!(
            outcome.message.contains("would block"),
            "{}",
            outcome.message
        );
        assert!(
            !stdin.sync_called(),
            "would-block priority failure must not call synchronous write_stdin"
        );
    }

    #[tokio::test]
    async fn task_reply_pending_ask_unsupported_priority_writer_fails_without_sync_fallback() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-reply-unsupported-priority"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_reply_unsupported_priority",
                "bash",
                "{}",
            ));
        let stdin = UnsupportedPriorityTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        assert!(matches!(
            service.inner.admit_task_request_frame(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need answer".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_secs(30)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestFrameAdmission::Accepted(_)
        ));

        let outcome = service
            .inner
            .reply_task_request(&task.task_id, "r1", "answer");

        assert_eq!(outcome.status, TaskReplyStatus::Failed);
        assert!(
            outcome.message.contains("unsupported"),
            "{}",
            outcome.message
        );
        assert!(
            !stdin.sync_called(),
            "unsupported priority writer must not call synchronous write_stdin"
        );
        let snapshot = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task exists");
        let request = snapshot
            .requests
            .iter()
            .find(|request| request.request_id == "r1")
            .expect("request should exist");
        assert_eq!(request.state, TaskRequestState::WriteFailed);
    }

    #[tokio::test]
    async fn task_reply_pending_ask_would_block_priority_writer_fails_without_sync_fallback() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-reply-would-block"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_reply_would_block",
                "bash",
                "{}",
            ));
        let stdin = WouldBlockPriorityTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        assert!(matches!(
            service.inner.admit_task_request_frame(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need answer".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_secs(30)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestFrameAdmission::Accepted(_)
        ));

        let outcome = service
            .inner
            .reply_task_request(&task.task_id, "r1", "answer");

        assert_eq!(outcome.status, TaskReplyStatus::Failed);
        assert!(
            outcome.message.contains("would block"),
            "{}",
            outcome.message
        );
        assert!(
            !stdin.sync_called(),
            "would-block priority failure must not call synchronous write_stdin"
        );
        assert!(service.events_after(0).iter().any(|event| {
            event.event_type == "task_reply.failed"
                && event.data["task_id"] == json!(task.task_id)
                && event.data["ask_id"] == json!("r1")
                && event.data["status"] == json!("write_failed")
        }));
        let snapshot = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task exists");
        let request = snapshot
            .requests
            .iter()
            .find(|request| request.request_id == "r1")
            .expect("request should exist");
        assert_eq!(request.state, TaskRequestState::WriteFailed);
    }

    #[tokio::test]
    async fn task_reply_short_write_priority_writer_maps_to_write_failed_diagnostic() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-reply-short-write"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_reply_short_write",
                "bash",
                "{}",
            ));
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(ShortWritePriorityTaskStdin))
            .expect("task exists");
        assert!(matches!(
            service.inner.admit_task_request_frame(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need answer".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_secs(30)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestFrameAdmission::Accepted(_)
        ));

        let outcome = service
            .inner
            .reply_task_request(&task.task_id, "r1", "answer");

        assert_eq!(outcome.status, TaskReplyStatus::Failed);
        assert!(outcome.message.contains("short nonblocking stdin write"));
        assert!(service.events_after(0).iter().any(|event| {
            event.event_type == "task_reply.failed"
                && event.data["task_id"] == json!(task.task_id)
                && event.data["ask_id"] == json!("r1")
                && event.data["status"] == json!("write_failed")
                && event.data["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("short nonblocking stdin write"))
        }));
    }

    #[tokio::test]
    async fn task_reply_escaping_heavy_payload_rejected_by_final_frame_bytes_without_resolving_ask()
    {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-reply-frame-byte-cap"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_reply_byte_cap", "bash", "{}"));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        assert!(matches!(
            service.inner.admit_task_request_frame(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need answer".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_secs(30)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestFrameAdmission::Accepted(_)
        ));

        let outcome = service.inner.reply_task_request(
            &task.task_id,
            "r1",
            &"\\".repeat(TASK_STDIN_CONTROL_FRAME_BYTES),
        );

        assert_eq!(outcome.status, TaskReplyStatus::ResponseTooLarge);
        assert_eq!(stdin.text(), "");
        let snapshot = service
            .inner
            .background_tasks
            .get(&task.task_id)
            .expect("task exists");
        let request = snapshot
            .requests
            .iter()
            .find(|request| request.request_id == "r1")
            .expect("request should exist");
        assert_eq!(request.state, TaskRequestState::Pending);
    }

    #[test]
    fn task_send_escaping_heavy_payload_rejected_by_final_frame_bytes() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-send-frame-byte-cap"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_send_byte_cap", "bash", "{}"));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");

        let outcome = service.inner.send_task_message_by_owner(
            &TaskOwner::Main,
            &task.task_id,
            &"\\".repeat(TASK_STDIN_CONTROL_FRAME_BYTES),
        );

        assert_eq!(outcome.status, TaskSendStatus::MessageTooLarge);
        assert_eq!(stdin.text(), "");
        assert!(!service.events_after(0).iter().any(|event| {
            event.event_type == "task_send.accepted" && event.data["task_id"] == json!(task.task_id)
        }));
    }

    #[tokio::test]
    async fn final_observer_receives_future_user_text_and_filters_non_text_input() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-observe-final-user-text"),
            Arc::new(TextProvider("assistant visible final")),
            Vec::new(),
        );

        service
            .enqueue(
                "msg_before_observe",
                vec![ContentPart::text("before observe")],
            )
            .await
            .expect("message before observer should enqueue");
        service.wait_for_state(ServiceState::Idle).await;

        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_observer", "bash", "{}"));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        let before_seq = service.status().last_event_seq;
        let outcome = service.inner.observe_task_by_owner(
            &TaskOwner::Main,
            &task.task_id,
            true,
            Some(TaskObserveMode::Final),
        );
        assert!(outcome.ok());

        service
            .enqueue(
                "msg_future_observe",
                vec![ContentPart::text("future user text")],
            )
            .await
            .expect("future message should enqueue");
        service.wait_for_state(ServiceState::Idle).await;
        wait_until(|| stdin.text().contains("future user text")).await;

        service
            .enqueue(
                "msg_mixed_observe",
                vec![
                    ContentPart::text("mixed text must not become user_text"),
                    ContentPart::image_base64("image/png", "BASE64_SECRET_MUST_NOT_LEAK"),
                ],
            )
            .await
            .expect("mixed message should enqueue");
        service.wait_for_state(ServiceState::Idle).await;
        tokio::task::yield_now().await;

        let written = stdin.text();
        assert!(written.contains(r#""kind":"user_text""#), "{written}");
        assert!(written.contains("future user text"), "{written}");
        assert!(written.contains(r#""kind":"assistant_text""#), "{written}");
        assert!(!written.contains("before observe"), "{written}");
        assert!(
            !written.contains("mixed text must not become user_text"),
            "{written}"
        );
        assert!(
            !written.contains("BASE64_SECRET_MUST_NOT_LEAK"),
            "{written}"
        );
        assert!(!service
            .events_after(before_seq)
            .iter()
            .any(|event| event.event_type.starts_with("task_send.")));
    }

    #[tokio::test]
    async fn final_observer_skips_empty_assistant_text_from_tool_call_message() {
        let provider = Arc::new(EmptyAssistantToolCallProvider::new());
        let service = Service::new(
            AgentConfig::new("system")
                .with_session("service-task-observe-empty-assistant-tool-call"),
            provider.clone(),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_empty_assistant_observer",
                "bash",
                "{}",
            ));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        let outcome = service.inner.observe_task_by_owner(
            &TaskOwner::Main,
            &task.task_id,
            true,
            Some(TaskObserveMode::Final),
        );
        assert!(outcome.ok());

        service
            .enqueue(
                "msg_empty_assistant_tool_call",
                vec![ContentPart::text("trigger empty assistant tool call")],
            )
            .await
            .expect("message should enqueue");
        service.wait_for_state(ServiceState::Idle).await;
        wait_until(|| provider.calls() >= 2).await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        let frames = botified_frame_strings(&stdin.text())
            .into_iter()
            .map(|frame| botified_json_from_frame(&frame))
            .collect::<Vec<_>>();
        assert!(
            frames.iter().any(|frame| frame["kind"] == "user_text"),
            "{frames:?}"
        );
        assert!(
            !frames.iter().any(|frame| frame["kind"] == "assistant_text"),
            "empty tool-call-only assistant.message must not publish assistant_text: {frames:?}"
        );
    }

    #[tokio::test]
    async fn observe_delivery_does_not_pollute_session_timeline_provider_context_or_active_items() {
        let home = service_test_home("observe-delivery-nonpollution");
        let opened =
            open_or_create_session_in_home_with_cwd("service-observe-boundary", &home, "/repo")
                .expect("session should open");
        let task_id = Arc::new(Mutex::new(None));
        let provider = Arc::new(TaskObserveToolProvider::new(task_id.clone()));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session(opened.name().to_owned()),
            provider.clone(),
            Vec::new(),
            opened.initial_messages().to_vec(),
            opened.pending_messages().to_vec(),
            opened.known_user_messages().to_vec(),
            opened.message_cursors().to_vec(),
            Some(opened.recorder()),
            opened.warnings().to_vec(),
            ServiceLimits::default(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_observe_boundary",
                "bash",
                "{}",
            ));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        *task_id.lock().expect("task id mutex poisoned") = Some(task.task_id.clone());
        let before_enable_seq = service.status().last_event_seq;

        service
            .enqueue(
                "msg_enable_observer",
                vec![ContentPart::text("enable observer through tool")],
            )
            .await
            .expect("message should enqueue");
        wait_until(|| {
            service
                .events_after(before_enable_seq)
                .iter()
                .any(|event| event.event_type == "task_observe.enabled")
        })
        .await;
        service.wait_for_state(ServiceState::Idle).await;
        wait_until(|| provider.calls() >= 2).await;
        wait_until(|| stdin.text().contains("observer tool enabled")).await;

        let before_seq = service.status().last_event_seq;
        let before_session = fs::read_to_string(opened.path()).expect("session should read");
        assert!(before_session.contains("task_observe"), "{before_session}");
        let before_provider_calls = provider.calls();
        let before_context = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .context
            .clone();
        let before_active_items = service.timeline_bootstrap_snapshot()["active_items"].clone();
        let delivery_text = "SIDE_CAR_DELIVERY_SECRET";

        service
            .inner
            .task_observer
            .publish_final_text(FinalTextObservation {
                kind: FinalTextObservationKind::AssistantText,
                text: delivery_text,
                message_id: Some("assistant-observe-delivery"),
                cycle_id: None,
            });
        wait_until(|| stdin.text().contains(delivery_text)).await;
        wait_for_service_workers_idle(&service).await;

        let after_session = fs::read_to_string(opened.path()).expect("session should read");
        assert_eq!(after_session, before_session);
        assert!(!after_session.contains(delivery_text), "{after_session}");
        assert!(
            !after_session.contains(r#""op":"observe""#),
            "{after_session}"
        );
        assert_eq!(provider.calls(), before_provider_calls);
        let after_context = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .context
            .clone();
        assert_eq!(after_context, before_context);
        assert_eq!(
            service.timeline_bootstrap_snapshot()["active_items"],
            before_active_items
        );
        let events = service.events_after(before_seq);
        assert!(
            events.is_empty(),
            "observe delivery must not append timeline events: {events:?}"
        );
        assert!(!events.iter().any(|event| {
            event.event_type.starts_with("task_send.")
                || event.event_type.contains("observe")
                || event.data.to_string().contains(delivery_text)
        }));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_task_observer_writer_does_not_block_provider_completion() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-observe-blocking-writer"),
            Arc::new(TextProvider(
                "assistant finished while observer writer is blocked",
            )),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_observe_blocking_writer",
                "bash",
                "{}",
            ));
        let (stdin, started) = BlockingTaskStdin::new();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        let _release_guard = stdin.release_on_drop();
        let outcome = service.inner.observe_task_by_owner(
            &TaskOwner::Main,
            &task.task_id,
            true,
            Some(TaskObserveMode::Final),
        );
        assert!(outcome.ok());

        service
            .enqueue(
                "msg_observer_writer_blocked",
                vec![ContentPart::text("user text starts observer write")],
            )
            .await
            .expect("message should enqueue");
        tokio::time::timeout(Duration::from_secs(1), started)
            .await
            .expect("observer writer should start without blocking the service runtime")
            .expect("observer writer start signal should send");

        tokio::time::timeout(
            Duration::from_secs(1),
            service.wait_for_state(ServiceState::Idle),
        )
        .await
        .expect("provider turn should complete while observer writer is blocked");

        stdin.release();
        wait_until(|| stdin.completed_writes() >= 1).await;
    }

    #[tokio::test]
    async fn stream_observer_preview_loop_fans_out_each_frame_once_per_task() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-observe-stream-fanout-once"),
            Arc::new(PanicProvider),
            Vec::new(),
        )
        .with_llm_text_preview_enabled(true);
        let task_a = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_stream_observer_a",
                "bash",
                "{}",
            ));
        let task_b = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_stream_observer_b",
                "bash",
                "{}",
            ));
        let stdin_a = RecordingTaskStdin::default();
        let stdin_b = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task_a.task_id, Arc::new(stdin_a.clone()))
            .expect("task a exists");
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task_b.task_id, Arc::new(stdin_b.clone()))
            .expect("task b exists");

        assert!(service
            .inner
            .observe_task_by_owner(
                &TaskOwner::Main,
                &task_a.task_id,
                true,
                Some(TaskObserveMode::Stream),
            )
            .ok());
        assert!(service
            .inner
            .observe_task_by_owner(
                &TaskOwner::Main,
                &task_b.task_id,
                true,
                Some(TaskObserveMode::Stream),
            )
            .ok());

        let metadata = crate::llm_text_preview::LlmTextPreviewMetadata {
            provider_request_id: "prq_stream_once".to_owned(),
            turn_id: Some("turn_stream_once".to_owned()),
            cycle_id: Some("cycle_stream_once".to_owned()),
            provider_call_index: 0,
            input_ids: vec!["msg_stream_once".to_owned()],
        };
        let sink = service
            .llm_text_preview_sink()
            .expect("preview sink should be enabled");
        sink.publish(crate::llm_text_preview::LlmTextPreviewFrame::started(
            &metadata,
        ));
        sink.publish(crate::llm_text_preview::LlmTextPreviewFrame::text_delta(
            &metadata,
            "draft once",
        ));
        sink.publish(crate::llm_text_preview::LlmTextPreviewFrame::finished(
            &metadata,
            true,
            StopReason::EndTurn,
        ));

        wait_until(|| {
            botified_frame_strings(&stdin_a.text()).len() >= 3
                && botified_frame_strings(&stdin_b.text()).len() >= 3
        })
        .await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        for text in [stdin_a.text(), stdin_b.text()] {
            let frames = botified_frame_strings(&text)
                .into_iter()
                .map(|frame| botified_json_from_frame(&frame))
                .collect::<Vec<_>>();
            let kinds = frames
                .iter()
                .map(|frame| frame["kind"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(
                kinds,
                vec![
                    "assistant_text_started",
                    "assistant_text",
                    "assistant_text_done"
                ],
                "{frames:?}"
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stream_observer_preview_loop_recovers_after_hub_drops_full_subscription() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-observe-stream-resubscribe"),
            Arc::new(PanicProvider),
            Vec::new(),
        )
        .with_llm_text_preview_enabled(true);
        let dropped = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_stream_observer_dropped",
                "bash",
                "{}",
            ));
        service
            .inner
            .background_tasks
            .register_stdin_writer(&dropped.task_id, Arc::new(FailingTaskStdin))
            .expect("dropped task exists");
        assert!(service
            .inner
            .observe_task_by_owner(
                &TaskOwner::Main,
                &dropped.task_id,
                true,
                Some(TaskObserveMode::Stream),
            )
            .ok());

        let sink = service
            .llm_text_preview_sink()
            .expect("preview sink should be enabled");
        for index in 0..65 {
            let metadata = crate::llm_text_preview::LlmTextPreviewMetadata {
                provider_request_id: format!("prq_stream_drop_{index}"),
                turn_id: Some("turn_stream_drop".to_owned()),
                cycle_id: Some("cycle_stream_drop".to_owned()),
                provider_call_index: 0,
                input_ids: vec!["msg_stream_drop".to_owned()],
            };
            sink.publish(crate::llm_text_preview::LlmTextPreviewFrame::started(
                &metadata,
            ));
        }
        wait_until(|| !service.inner.task_observer.is_observing(&dropped.task_id)).await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        let recovered = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_stream_observer_recovered",
                "bash",
                "{}",
            ));
        let recovered_stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&recovered.task_id, Arc::new(recovered_stdin.clone()))
            .expect("recovered task exists");
        assert!(service
            .inner
            .observe_task_by_owner(
                &TaskOwner::Main,
                &recovered.task_id,
                true,
                Some(TaskObserveMode::Stream),
            )
            .ok());

        let metadata = crate::llm_text_preview::LlmTextPreviewMetadata {
            provider_request_id: "prq_stream_recovered".to_owned(),
            turn_id: Some("turn_stream_recovered".to_owned()),
            cycle_id: Some("cycle_stream_recovered".to_owned()),
            provider_call_index: 0,
            input_ids: vec!["msg_stream_recovered".to_owned()],
        };
        sink.publish(crate::llm_text_preview::LlmTextPreviewFrame::text_delta(
            &metadata,
            "draft after resubscribe",
        ));

        wait_until(|| recovered_stdin.text().contains("draft after resubscribe")).await;
        let frames = botified_frame_strings(&recovered_stdin.text())
            .into_iter()
            .map(|frame| botified_json_from_frame(&frame))
            .collect::<Vec<_>>();
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["kind"], json!("assistant_text"));
        assert_eq!(frames[0]["text"], json!("draft after resubscribe"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn low_priority_observer_write_does_not_starve_task_send() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-observe-priority-stdin"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_observe_priority_writer",
                "bash",
                "{}",
            ));
        let (stdin, observe_started) = ObserveBlockingPriorityTaskStdin::new();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        let _release_guard = stdin.release_observe_on_drop();
        assert!(service
            .inner
            .observe_task_by_owner(
                &TaskOwner::Main,
                &task.task_id,
                true,
                Some(TaskObserveMode::Final),
            )
            .ok());

        service
            .inner
            .task_observer
            .publish_final_text(FinalTextObservation {
                kind: FinalTextObservationKind::AssistantText,
                text: "observe writer blocks before priority send",
                message_id: Some("assistant-priority-observe"),
                cycle_id: None,
            });
        tokio::time::timeout(Duration::from_secs(1), observe_started)
            .await
            .expect("observe write should start")
            .expect("observe start signal should send");

        let inner = service.inner.clone();
        let task_id = task.task_id.clone();
        let outcome = match run_on_thread_with_timeout(Duration::from_millis(500), move || {
            inner.send_task_message_by_owner(
                &TaskOwner::Main,
                &task_id,
                "priority send must not wait for observe",
            )
        }) {
            Ok(outcome) => outcome,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                panic!("task_send should not be starved by a blocked observe write")
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                panic!("task_send helper thread exited without an outcome")
            }
        };
        assert_eq!(outcome.status, TaskSendStatus::Written);
        assert!(
            stdin
                .text()
                .contains("priority send must not wait for observe"),
            "{}",
            stdin.text()
        );

        stdin.release_observe();
        wait_until(|| stdin.text().contains(r#""op":"observe""#)).await;
    }

    #[test]
    fn task_observe_rejects_terminal_noninteractive_cross_owner_preview_disabled_and_subagent_owner(
    ) {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-observe-rejections"),
            Arc::new(PanicProvider),
            Vec::new(),
        );

        let terminal = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_terminal_observe",
                "bash",
                "{}",
            ));
        service
            .inner
            .background_tasks
            .finish_task(&terminal.task_id, TaskState::Completed, "done")
            .expect("task should finish");
        let terminal_observe = service.inner.observe_task_by_owner(
            &TaskOwner::Main,
            &terminal.task_id,
            true,
            Some(TaskObserveMode::Final),
        );
        assert_eq!(terminal_observe.status, TaskObserveStatus::TaskTerminal);

        let noninteractive = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_no_stdin_observe",
                "bash",
                "{}",
            ));
        let noninteractive_observe = service.inner.observe_task_by_owner(
            &TaskOwner::Main,
            &noninteractive.task_id,
            true,
            Some(TaskObserveMode::Final),
        );
        assert_eq!(
            noninteractive_observe.status,
            TaskObserveStatus::StdinNotWritable
        );

        let preview_disabled = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_stream_observe", "bash", "{}"));
        let preview_disabled_stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(
                &preview_disabled.task_id,
                Arc::new(preview_disabled_stdin.clone()),
            )
            .expect("task exists");
        let preview_disabled_observe = service.inner.observe_task_by_owner(
            &TaskOwner::Main,
            &preview_disabled.task_id,
            true,
            Some(TaskObserveMode::Stream),
        );
        assert_eq!(
            preview_disabled_observe.status,
            TaskObserveStatus::PreviewDisabled
        );
        assert!(!service
            .inner
            .task_observer
            .is_observing(&preview_disabled.task_id));
        assert_eq!(preview_disabled_stdin.text(), "");

        let subagent_owned = service.inner.background_tasks.start_task(
            NewBackgroundTask::new("call_cross_owner_observe", "bash", "{}")
                .with_owner(TaskOwner::subagent("branch-observe")),
        );
        let subagent_stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&subagent_owned.task_id, Arc::new(subagent_stdin.clone()))
            .expect("task exists");
        let cross_owner_observe = service.inner.observe_task_by_owner(
            &TaskOwner::Main,
            &subagent_owned.task_id,
            true,
            Some(TaskObserveMode::Final),
        );
        assert_eq!(cross_owner_observe.status, TaskObserveStatus::UnknownTask);
        assert_eq!(subagent_stdin.text(), "");

        let main_task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_owner_defense_observe",
                "bash",
                "{}",
            ));
        let main_stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&main_task.task_id, Arc::new(main_stdin.clone()))
            .expect("task exists");
        let subagent_owner_observe = service.inner.observe_task_by_owner(
            &TaskOwner::subagent("branch-observe"),
            &main_task.task_id,
            true,
            Some(TaskObserveMode::Final),
        );
        assert_eq!(subagent_owner_observe.status, TaskObserveStatus::NotAllowed);
        assert!(!service.inner.task_observer.is_observing(&main_task.task_id));
        assert_eq!(main_stdin.text(), "");

        let events = service.events_after(0);
        assert!(events.iter().any(|event| {
            event.event_type == "task_observe.failed"
                && event.data["error"]["code"] == json!("preview_disabled")
        }));
        assert!(!events
            .iter()
            .any(|event| event.event_type.starts_with("task_send.")));
    }

    #[test]
    fn task_observe_enable_rejects_writer_without_observer_stdin_support() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-observe-unsupported-stdin"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_unsupported_observer_stdin",
                "bash",
                "{}",
            ));
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(UnsupportedObserverTaskStdin))
            .expect("task exists");

        let before_seq = service.status().last_event_seq;
        let outcome = service.inner.observe_task_by_owner(
            &TaskOwner::Main,
            &task.task_id,
            true,
            Some(TaskObserveMode::Final),
        );

        assert_eq!(outcome.status, TaskObserveStatus::StdinNotWritable);
        assert!(!outcome.ok());
        assert!(!service.inner.task_observer.is_observing(&task.task_id));
        let events = service.events_after(before_seq);
        assert!(events.iter().any(|event| {
            event.event_type == "task_observe.failed"
                && event.data["task_id"] == json!(task.task_id)
                && event.data["status"] == json!("stdin_not_writable")
                && event.data["observing"] == json!(false)
                && event.data["error"]["message"]
                    == json!("task stdin does not support observer writes")
        }));
        assert!(!events
            .iter()
            .any(|event| event.event_type == "task_observe.enabled"));
    }

    #[tokio::test]
    async fn task_observer_writer_failure_and_queue_full_clean_observer_without_task_send_events() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-observe-delivery-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
        );

        let failing = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_observe_write_failed",
                "bash",
                "{}",
            ));
        service
            .inner
            .background_tasks
            .register_stdin_writer(&failing.task_id, Arc::new(FailingTaskStdin))
            .expect("task exists");
        let failing_outcome = service.inner.observe_task_by_owner(
            &TaskOwner::Main,
            &failing.task_id,
            true,
            Some(TaskObserveMode::Final),
        );
        assert!(failing_outcome.ok());
        let before_delivery_seq = service.status().last_event_seq;

        service
            .inner
            .task_observer
            .publish_final_text(FinalTextObservation {
                kind: FinalTextObservationKind::AssistantText,
                text: "writer should fail",
                message_id: Some("assistant-write-fails"),
                cycle_id: None,
            });
        wait_until(|| !service.inner.task_observer.is_observing(&failing.task_id)).await;

        let queued = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_observe_queue_full",
                "bash",
                "{}",
            ));
        let (queued_stdin, queued_started) = BlockingTaskStdin::new();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&queued.task_id, Arc::new(queued_stdin.clone()))
            .expect("task exists");
        let _queued_release_guard = queued_stdin.release_on_drop();
        let queued_outcome = service.inner.observe_task_by_owner(
            &TaskOwner::Main,
            &queued.task_id,
            true,
            Some(TaskObserveMode::Final),
        );
        assert!(queued_outcome.ok());
        service
            .inner
            .task_observer
            .publish_final_text(FinalTextObservation {
                kind: FinalTextObservationKind::AssistantText,
                text: "queue writer blocks on first delivery",
                message_id: Some("assistant-queue-blocked"),
                cycle_id: None,
            });
        tokio::time::timeout(Duration::from_secs(1), queued_started)
            .await
            .expect("queue-full writer should start")
            .expect("queue-full writer start signal should send");
        for index in 0..64 {
            service
                .inner
                .task_observer
                .publish_final_text(FinalTextObservation {
                    kind: FinalTextObservationKind::AssistantText,
                    text: &format!("queue fill {index}"),
                    message_id: Some("assistant-queue-full"),
                    cycle_id: None,
                });
        }
        wait_until(|| !service.inner.task_observer.is_observing(&queued.task_id)).await;
        queued_stdin.release();
        wait_until(|| queued_stdin.completed_writes() >= 1).await;

        let diagnostics =
            service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
        assert_eq!(diagnostics["by_domain"]["task_observer"], json!(2));
        assert_eq!(diagnostics["by_code"]["observer_write_failed"], json!(1));
        assert_eq!(diagnostics["by_code"]["observer_queue_full"], json!(1));
        assert!(!service
            .events_after(before_delivery_seq)
            .iter()
            .any(|event| event.event_type.starts_with("task_send.")));
    }

    #[tokio::test]
    async fn service_registry_set_stdio_writes_store_without_agent_side_effects() {
        let store = RegistryStore::new(Default::default()).expect("registry should initialize");
        let provider = Arc::new(CountingProvider::new());
        let service = Service::with_registry_store(
            AgentConfig::new("system").with_session("service-stdio-registry-set"),
            provider.clone(),
            Vec::new(),
            store.clone(),
        );
        let main_task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_registry_set_main",
                "bash",
                "{}",
            ));
        let subagent_task = service.inner.background_tasks.start_task(
            NewBackgroundTask::new("call_registry_set_subagent", "bash", "{}")
                .with_owner(TaskOwner::subagent("subagent-a")),
        );
        let before_seq = service.status().last_event_seq;
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: main_task.task_id.clone(),
        };

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
            TaskRegistrySetFrame {
                id: Some("pose-1".to_owned()),
                topic: "robot.pose".to_owned(),
                value: json!({"x": 1}),
                source: Some("localization".to_owned()),
                ttl: crate::registry::RegistryTtl::Default,
                freq_hz: Some(20.0),
            },
        )]);
        let subagent_bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: subagent_task.task_id.clone(),
        };
        subagent_bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
            TaskRegistrySetFrame {
                id: None,
                topic: "robot.subagent".to_owned(),
                value: json!({"ready": true}),
                source: None,
                ttl: crate::registry::RegistryTtl::Default,
                freq_hz: None,
            },
        )]);

        wait_until(|| {
            store
                .get(RegistryQuery::new("robot.*").with_limit(10))
                .is_ok_and(|result| result.returned_count == 2)
        })
        .await;

        let result = store
            .get(RegistryQuery::new("robot.*").with_limit(10))
            .expect("registry get should succeed");
        let pose = result
            .items
            .iter()
            .find(|item| item.topic == "robot.pose")
            .expect("pose item should be present");
        assert_eq!(pose.writer_kind, RegistryWriterKind::ManagedTask);
        assert_eq!(pose.origin, format!("task:{}", main_task.task_id));
        assert_eq!(pose.source, "localization");
        let subagent = result
            .items
            .iter()
            .find(|item| item.topic == "robot.subagent")
            .expect("subagent item should be present");
        assert_eq!(subagent.writer_kind, RegistryWriterKind::ManagedTask);
        assert_eq!(
            subagent.origin,
            format!("subagent:subagent-a/task:{}", subagent_task.task_id)
        );
        assert_eq!(subagent.source, "bash");
        assert_eq!(provider.calls(), 0);
        assert_eq!(service.status().queue_length, 0);
        let events = service.events_after(before_seq);
        assert!(
            events.is_empty(),
            "successful registry_set should not write timeline events: {events:?}"
        );
    }

    #[tokio::test]
    async fn service_registry_get_stdio_writes_snapshot_and_error_without_agent_side_effects() {
        let store = RegistryStore::new(Default::default()).expect("registry should initialize");
        store
            .set(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                crate::registry::RegistrySetRequest::new(
                    "robot.pose",
                    json!({"x": 1, "y": 2}),
                    "localization",
                ),
            )
            .expect("seed registry set should succeed");
        let provider = Arc::new(CountingProvider::new());
        let service = Service::with_registry_store(
            AgentConfig::new("system").with_session("service-stdio-registry-get"),
            provider.clone(),
            Vec::new(),
            store.clone(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_registry_get", "bash", "{}"));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        let before_seq = service.status().last_event_seq;
        let before_context_len = service_context_len(&service);
        let before_active_items = service.timeline_bootstrap_snapshot()["active_items"].clone();
        let before_task_requests = task_request_count(&service, &task.task_id);
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task.task_id.clone(),
        };

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
            TaskRegistryGetFrame {
                id: "read-1".to_owned(),
                topic: "robot.*".to_owned(),
                limit: Some(10),
            },
        )]);

        wait_until(|| stdin.text().contains("\"op\":\"registry_snapshot\"")).await;
        let snapshot = first_botified_json(&stdin.text());
        assert_eq!(snapshot["op"], json!("registry_snapshot"));
        assert_eq!(snapshot["id"], json!("read-1"));
        assert_eq!(snapshot["returned_count"], json!(1));
        assert_eq!(snapshot["items"][0]["topic"], json!("robot.pose"));
        assert_eq!(provider.calls(), 0);
        assert_eq!(service.status().queue_length, 0);
        wait_for_service_workers_idle(&service).await;
        assert!(
            service.events_after(before_seq).is_empty(),
            "registry_get success must not write timeline events: {:?}",
            service.events_after(before_seq)
        );
        assert_eq!(service_context_len(&service), before_context_len);
        assert_eq!(
            service.timeline_bootstrap_snapshot()["active_items"],
            before_active_items
        );
        assert_eq!(
            task_request_count(&service, &task.task_id),
            before_task_requests
        );

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
            TaskRegistryGetFrame {
                id: "bad-limit".to_owned(),
                topic: "robot.*".to_owned(),
                limit: Some(store.config().max_query_limit + 1),
            },
        )]);

        wait_until(|| stdin.text().contains("\"op\":\"registry_error\"")).await;
        assert!(stdin.text().contains("\"id\":\"bad-limit\""));
        assert!(stdin.text().contains("\"code\":\"query_too_large\""));
        assert_eq!(provider.calls(), 0);
        wait_for_service_workers_idle(&service).await;
        assert!(
            service.events_after(before_seq).is_empty(),
            "registry_get error must not write timeline events: {:?}",
            service.events_after(before_seq)
        );
        assert_eq!(service_context_len(&service), before_context_len);
        assert_eq!(
            service.timeline_bootstrap_snapshot()["active_items"],
            before_active_items
        );
        assert_eq!(
            task_request_count(&service, &task.task_id),
            before_task_requests
        );
    }

    #[tokio::test]
    async fn service_registry_get_unsupported_priority_writer_records_bounded_diagnostic() {
        let store = RegistryStore::new(Default::default()).expect("registry should initialize");
        store
            .set(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                crate::registry::RegistrySetRequest::new(
                    "robot.pose",
                    json!({"x": 1}),
                    "localization",
                ),
            )
            .expect("seed registry set should succeed");
        let service = Service::with_registry_store(
            AgentConfig::new("system").with_session("service-stdio-registry-unsupported-priority"),
            Arc::new(PanicProvider),
            Vec::new(),
            store,
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_registry_unsupported_priority",
                "bash",
                "{}",
            ));
        let stdin = UnsupportedPriorityTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task.task_id.clone(),
        };

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
            TaskRegistryGetFrame {
                id: "read-unsupported".to_owned(),
                topic: "robot.*".to_owned(),
                limit: Some(1),
            },
        )]);
        wait_for_service_workers_idle(&service).await;

        assert!(
            !stdin.sync_called(),
            "registry_get must not call synchronous write_stdin fallback"
        );
        let diagnostics =
            service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
        assert_eq!(diagnostics["by_domain"]["task_stdio_registry"], json!(1));
        assert_eq!(diagnostics["by_code"]["stdin_write_failed"], json!(1));
        assert_eq!(diagnostics["last"]["id"], json!("read-unsupported"));
        assert!(
            diagnostics["last"]["message"]
                .as_str()
                .expect("diagnostic message should be a string")
                .contains("unsupported"),
            "{diagnostics}"
        );
    }

    #[tokio::test]
    async fn service_registry_get_would_block_priority_writer_records_bounded_diagnostic() {
        let store = RegistryStore::new(Default::default()).expect("registry should initialize");
        store
            .set(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                crate::registry::RegistrySetRequest::new(
                    "robot.pose",
                    json!({"x": 1}),
                    "localization",
                ),
            )
            .expect("seed registry set should succeed");
        let service = Service::with_registry_store(
            AgentConfig::new("system").with_session("service-stdio-registry-would-block"),
            Arc::new(PanicProvider),
            Vec::new(),
            store,
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_registry_would_block",
                "bash",
                "{}",
            ));
        let stdin = WouldBlockPriorityTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task.task_id.clone(),
        };

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
            TaskRegistryGetFrame {
                id: "read-would-block".to_owned(),
                topic: "robot.*".to_owned(),
                limit: Some(1),
            },
        )]);
        wait_for_service_workers_idle(&service).await;

        assert!(
            !stdin.sync_called(),
            "registry_get would-block must not call synchronous write_stdin fallback"
        );
        let diagnostics =
            service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
        assert_eq!(diagnostics["by_domain"]["task_stdio_registry"], json!(1));
        assert_eq!(diagnostics["by_code"]["stdin_write_failed"], json!(1));
        assert_eq!(diagnostics["last"]["id"], json!("read-would-block"));
        assert!(
            diagnostics["last"]["message"]
                .as_str()
                .expect("diagnostic message should be a string")
                .contains("would block"),
            "{diagnostics}"
        );
    }

    #[tokio::test]
    async fn service_registry_get_stdio_response_is_bounded_and_does_not_echo_query_detail() {
        let store = RegistryStore::new(crate::registry::RegistryConfig {
            retention: Duration::from_secs(60),
            default_ttl: Duration::from_secs(30),
            max_topics: 8,
            max_topic_len: 256,
            max_source_len: 64,
            max_value_bytes: 512,
            max_history_items: 64,
            max_history_bytes: 16 * 1024,
            default_query_limit: 8,
            max_query_limit: 8,
            max_response_bytes: 520,
        })
        .expect("registry should initialize");
        for index in 0..3 {
            store
                .set(
                    RegistryWriterKind::WebsocketClient,
                    "ws:test",
                    crate::registry::RegistrySetRequest::new(
                        format!("robot.pose.{index}"),
                        json!({"payload": "x".repeat(80)}),
                        "localization",
                    ),
                )
                .expect("seed registry set should succeed");
        }
        let provider = Arc::new(CountingProvider::new());
        let service = Service::with_registry_store(
            AgentConfig::new("system").with_session("service-stdio-registry-get-bounded"),
            provider.clone(),
            Vec::new(),
            store.clone(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_registry_get_bounded",
                "bash",
                "{}",
            ));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        let before_seq = service.status().last_event_seq;
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task.task_id.clone(),
        };

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
            TaskRegistryGetFrame {
                id: "read-large".to_owned(),
                topic: "robot.pose.*".to_owned(),
                limit: Some(8),
            },
        )]);

        wait_until(|| stdin.text().contains("\"op\":\"registry_snapshot\"")).await;
        wait_for_service_workers_idle(&service).await;
        let frames = botified_frame_strings(&stdin.text());
        let snapshot_frame = frames
            .first()
            .expect("stdin should contain snapshot frame")
            .clone();
        assert!(
            snapshot_frame.len() <= store.config().max_response_bytes,
            "snapshot frame should be capped: {} > {}\n{snapshot_frame}",
            snapshot_frame.len(),
            store.config().max_response_bytes
        );
        let snapshot = botified_json_from_frame(&snapshot_frame);
        assert_eq!(snapshot["op"], json!("registry_snapshot"));
        assert_eq!(snapshot["id"], json!("read-large"));
        assert_eq!(snapshot["truncated"], json!(true));
        assert!(snapshot["truncated_reason"].is_string());

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
            TaskRegistryGetFrame {
                id: "bad-pattern".to_owned(),
                topic: "robot..super_secret_query_detail".to_owned(),
                limit: Some(1),
            },
        )]);

        wait_until(|| botified_frame_strings(&stdin.text()).len() >= 2).await;
        wait_for_service_workers_idle(&service).await;
        let frames = botified_frame_strings(&stdin.text());
        let error_frame = frames.last().expect("stdin should contain error frame");
        assert!(
            error_frame.len() <= store.config().max_response_bytes,
            "error frame should be capped: {} > {}\n{error_frame}",
            error_frame.len(),
            store.config().max_response_bytes
        );
        assert!(
            !error_frame.contains("super_secret_query_detail"),
            "registry_error must not echo query detail: {error_frame}"
        );
        let error = botified_json_from_frame(error_frame);
        assert_eq!(error["op"], json!("registry_error"));
        assert_eq!(error["id"], json!("bad-pattern"));
        assert_eq!(error["code"], json!("invalid_pattern"));
        assert_eq!(provider.calls(), 0);
        assert!(
            service.events_after(before_seq).is_empty(),
            "bounded registry_get responses must not write timeline events: {:?}",
            service.events_after(before_seq)
        );
    }

    #[tokio::test]
    async fn service_registry_get_stdio_response_respects_task_stdin_control_cap() {
        let store = RegistryStore::new(crate::registry::RegistryConfig {
            retention: Duration::from_secs(60),
            default_ttl: Duration::from_secs(30),
            max_topics: 16,
            max_topic_len: 256,
            max_source_len: 64,
            max_value_bytes: 8192,
            max_history_items: 64,
            max_history_bytes: 64 * 1024,
            default_query_limit: 16,
            max_query_limit: 16,
            max_response_bytes: 32 * 1024,
        })
        .expect("registry should initialize");
        for index in 0..8 {
            store
                .set(
                    RegistryWriterKind::WebsocketClient,
                    "ws:test",
                    crate::registry::RegistrySetRequest::new(
                        format!("robot.payload.{index}"),
                        json!({"payload": "x".repeat(4096)}),
                        "localization",
                    ),
                )
                .expect("seed registry set should succeed");
        }
        let service = Service::with_registry_store(
            AgentConfig::new("system").with_session("service-stdio-registry-stdin-cap"),
            Arc::new(PanicProvider),
            Vec::new(),
            store,
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_registry_stdin_cap",
                "bash",
                "{}",
            ));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task.task_id.clone(),
        };

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
            TaskRegistryGetFrame {
                id: "read-stdin-cap".to_owned(),
                topic: "robot.payload.*".to_owned(),
                limit: Some(16),
            },
        )]);

        wait_until(|| stdin.text().contains("\"op\":\"registry_snapshot\"")).await;
        let frames = botified_frame_strings(&stdin.text());
        let snapshot_frame = frames.first().expect("stdin should contain snapshot frame");
        assert!(
            snapshot_frame.len() <= TASK_STDIN_CONTROL_FRAME_BYTES,
            "registry stdin response must fit control frame cap: {} > {}\n{snapshot_frame}",
            snapshot_frame.len(),
            TASK_STDIN_CONTROL_FRAME_BYTES
        );
        let snapshot = botified_json_from_frame(snapshot_frame);
        assert_eq!(snapshot["op"], json!("registry_snapshot"));
        assert_eq!(snapshot["truncated"], json!(true));
        assert_eq!(snapshot["truncated_reason"], json!("response_bytes"));
    }

    #[tokio::test]
    async fn service_registry_get_stdio_tiny_response_cap_uses_effective_minimum() {
        let store = RegistryStore::new(crate::registry::RegistryConfig {
            retention: Duration::from_secs(60),
            default_ttl: Duration::from_secs(30),
            max_topics: 8,
            max_topic_len: 256,
            max_source_len: 64,
            max_value_bytes: 2048,
            max_history_items: 64,
            max_history_bytes: 16 * 1024,
            default_query_limit: 8,
            max_query_limit: 8,
            max_response_bytes: 16,
        })
        .expect("registry should initialize");
        store
            .set(
                RegistryWriterKind::WebsocketClient,
                "ws:test",
                crate::registry::RegistrySetRequest::new(
                    "robot.pose",
                    json!({"payload": "x".repeat(1024)}),
                    "localization",
                ),
            )
            .expect("seed registry set should succeed");
        let provider = Arc::new(CountingProvider::new());
        let service = Service::with_registry_store(
            AgentConfig::new("system").with_session("service-stdio-registry-get-tiny-cap"),
            provider.clone(),
            Vec::new(),
            store.clone(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_registry_get_tiny_cap",
                "bash",
                "{}",
            ));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        let before_seq = service.status().last_event_seq;
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task.task_id.clone(),
        };
        let effective_cap = stdio_registry_response_cap(store.config().max_response_bytes);
        assert!(effective_cap > store.config().max_response_bytes);

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
            TaskRegistryGetFrame {
                id: "tiny-read".to_owned(),
                topic: "robot.*".to_owned(),
                limit: Some(8),
            },
        )]);

        wait_until(|| stdin.text().contains("\"op\":\"registry_snapshot\"")).await;
        wait_for_service_workers_idle(&service).await;
        let frames = botified_frame_strings(&stdin.text());
        let snapshot_frame = frames.first().expect("stdin should contain snapshot frame");
        assert!(
            snapshot_frame.len() <= effective_cap,
            "snapshot frame should fit effective stdio cap: {} > {}\n{snapshot_frame}",
            snapshot_frame.len(),
            effective_cap
        );
        let snapshot = botified_json_from_frame(snapshot_frame);
        assert_eq!(snapshot["op"], json!("registry_snapshot"));
        assert_eq!(snapshot["truncated"], json!(true));
        assert_eq!(snapshot["truncated_reason"], json!("response_bytes"));

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistryGet(
            TaskRegistryGetFrame {
                id: "tiny-error".to_owned(),
                topic: "robot..secret_query_detail".to_owned(),
                limit: Some(1),
            },
        )]);

        wait_until(|| botified_frame_strings(&stdin.text()).len() >= 2).await;
        wait_for_service_workers_idle(&service).await;
        let frames = botified_frame_strings(&stdin.text());
        let error_frame = frames.last().expect("stdin should contain error frame");
        assert!(
            error_frame.len() <= effective_cap,
            "error frame should fit effective stdio cap: {} > {}\n{error_frame}",
            error_frame.len(),
            effective_cap
        );
        let error = botified_json_from_frame(error_frame);
        assert_eq!(error["op"], json!("registry_error"));
        assert_eq!(error["code"], json!("invalid_pattern"));
        assert!(
            !error_frame.contains("secret_query_detail"),
            "registry_error must not echo query detail: {error_frame}"
        );
        assert_eq!(provider.calls(), 0);
        assert!(
            service.events_after(before_seq).is_empty(),
            "tiny-cap registry_get responses must not write timeline events: {:?}",
            service.events_after(before_seq)
        );
    }

    #[tokio::test]
    async fn service_registry_set_stdio_uses_active_store_limits_for_value_and_source() {
        let store = RegistryStore::new(crate::registry::RegistryConfig {
            retention: Duration::from_secs(60),
            default_ttl: Duration::from_secs(30),
            max_topics: 8,
            max_topic_len: 256,
            max_source_len: 8,
            max_value_bytes: 16,
            max_history_items: 64,
            max_history_bytes: 16 * 1024,
            default_query_limit: 8,
            max_query_limit: 8,
            max_response_bytes: 1024,
        })
        .expect("registry should initialize");
        let provider = Arc::new(CountingProvider::new());
        let service = Service::with_registry_store(
            AgentConfig::new("system").with_session("service-stdio-registry-active-limits"),
            provider.clone(),
            Vec::new(),
            store.clone(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_registry_set_active_limits",
                "bash",
                "{}",
            ));
        let before_seq = service.status().last_event_seq;
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task.task_id.clone(),
        };

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
            TaskRegistrySetFrame {
                id: Some("large-value".to_owned()),
                topic: "robot.pose".to_owned(),
                value: json!({"payload": "x".repeat(64)}),
                source: Some("local".to_owned()),
                ttl: crate::registry::RegistryTtl::Default,
                freq_hz: None,
            },
        )]);

        wait_for_service_workers_idle(&service).await;
        let first_diagnostics =
            service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
        assert_eq!(
            first_diagnostics["by_domain"]["task_stdio_registry"],
            json!(1)
        );
        assert_eq!(first_diagnostics["by_code"]["value_too_large"], json!(1));
        assert_eq!(first_diagnostics["last"]["code"], json!("value_too_large"));
        assert_eq!(first_diagnostics["last"]["id"], json!("large-value"));
        assert!(first_diagnostics["last"]["recorded_at"].is_string());
        assert!(
            !first_diagnostics.to_string().contains(&"x".repeat(64)),
            "diagnostic must not echo oversized registry value: {first_diagnostics}"
        );

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
            TaskRegistrySetFrame {
                id: Some("long-source".to_owned()),
                topic: "robot.pose".to_owned(),
                value: json!({"ok": true}),
                source: Some("source-name-is-too-long".to_owned()),
                ttl: crate::registry::RegistryTtl::Default,
                freq_hz: None,
            },
        )]);

        wait_for_service_workers_idle(&service).await;
        let diagnostics =
            service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
        assert_eq!(diagnostics["total"], json!(2));
        assert_eq!(diagnostics["by_domain"]["task_stdio_registry"], json!(2));
        assert_eq!(diagnostics["by_domain"]["task_stdio_protocol"], Value::Null);
        assert_eq!(diagnostics["by_code"]["value_too_large"], json!(1));
        assert_eq!(diagnostics["by_code"]["invalid_source"], json!(1));
        assert_eq!(diagnostics["last"]["domain"], json!("task_stdio_registry"));
        assert_eq!(diagnostics["last"]["code"], json!("invalid_source"));
        assert_eq!(diagnostics["last"]["id"], json!("long-source"));
        assert!(diagnostics["last"]["recorded_at"].is_string());
        assert!(
            !diagnostics.to_string().contains("source-name-is-too-long"),
            "diagnostic must not echo oversized registry source: {diagnostics}"
        );
        assert_eq!(
            store
                .get(RegistryQuery::new("robot.pose"))
                .expect("registry get should succeed")
                .returned_count,
            0
        );
        assert_eq!(provider.calls(), 0);
        assert!(
            service.events_after(before_seq).is_empty(),
            "registry_set store-limit diagnostics must not write timeline events: {:?}",
            service.events_after(before_seq)
        );
    }

    #[tokio::test]
    async fn service_registry_set_stdio_allows_values_and_sources_above_defaults_when_store_allows()
    {
        let store = RegistryStore::new(crate::registry::RegistryConfig {
            retention: Duration::from_secs(60),
            default_ttl: Duration::from_secs(30),
            max_topics: 8,
            max_topic_len: 256,
            max_source_len: crate::registry::RegistryConfig::DEFAULT_MAX_SOURCE_LEN + 32,
            max_value_bytes: crate::registry::RegistryConfig::DEFAULT_MAX_VALUE_BYTES + 512,
            max_history_items: 64,
            max_history_bytes: 64 * 1024,
            default_query_limit: 8,
            max_query_limit: 8,
            max_response_bytes: 32 * 1024,
        })
        .expect("registry should initialize");
        let provider = Arc::new(CountingProvider::new());
        let service = Service::with_registry_store(
            AgentConfig::new("system").with_session("service-stdio-registry-relaxed-limits"),
            provider.clone(),
            Vec::new(),
            store.clone(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_registry_set_relaxed_limits",
                "bash",
                "{}",
            ));
        let before_seq = service.status().last_event_seq;
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task.task_id.clone(),
        };
        let large_value = "v".repeat(crate::registry::RegistryConfig::DEFAULT_MAX_VALUE_BYTES + 1);
        let long_source = "s".repeat(crate::registry::RegistryConfig::DEFAULT_MAX_SOURCE_LEN + 1);

        bridge.handle_frame_events(vec![BotifiedFrameEvent::RegistrySet(
            TaskRegistrySetFrame {
                id: Some("relaxed".to_owned()),
                topic: "robot.pose".to_owned(),
                value: json!(large_value),
                source: Some(long_source.clone()),
                ttl: crate::registry::RegistryTtl::Default,
                freq_hz: None,
            },
        )]);

        wait_for_service_workers_idle(&service).await;
        let result = store
            .get(RegistryQuery::new("robot.pose"))
            .expect("registry get should succeed");
        assert_eq!(result.returned_count, 1);
        assert_eq!(result.items[0].source, long_source);
        assert_eq!(provider.calls(), 0);
        assert!(
            service.events_after(before_seq).is_empty(),
            "successful relaxed-limit registry_set must not write timeline events: {:?}",
            service.events_after(before_seq)
        );
        let diagnostics =
            service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
        assert_eq!(diagnostics["total"], json!(0));
        assert_eq!(diagnostics["last"], Value::Null);
    }

    #[tokio::test]
    async fn service_registry_stdio_diagnostics_do_not_become_task_ask_rejections() {
        let (profiler, report_dir) =
            service_test_profiler("stdio-registry-diagnostics-no-agent-pollution");
        let store = RegistryStore::new(Default::default()).expect("registry should initialize");
        let provider = Arc::new(CountingProvider::new());
        let service = Service::with_registry_store(
            AgentConfig::new("system").with_session("service-stdio-registry-diagnostics"),
            provider.clone(),
            Vec::new(),
            store,
        )
        .with_profiler(Some(profiler.clone()));
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_registry_diag", "bash", "{}"));
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(FailingTaskStdin))
            .expect("task exists");
        let before_seq = service.status().last_event_seq;
        let before_context_len = service_context_len(&service);
        let before_active_items = service.timeline_bootstrap_snapshot()["active_items"].clone();
        let before_task_requests = task_request_count(&service, &task.task_id);
        let bridge = ServiceInteractiveStdioBridge {
            inner: service.inner.clone(),
            task_id: task.task_id.clone(),
        };

        bridge.handle_frame_events(vec![
            BotifiedFrameEvent::RegistrySet(TaskRegistrySetFrame {
                id: Some("bad-topic".to_owned()),
                topic: "robot..bad".to_owned(),
                value: json!({"secret": "must not leak"}),
                source: Some("diagnostic-test".to_owned()),
                ttl: crate::registry::RegistryTtl::Default,
                freq_hz: None,
            }),
            BotifiedFrameEvent::RegistryGet(TaskRegistryGetFrame {
                id: "read-closed".to_owned(),
                topic: "robot.*".to_owned(),
                limit: Some(1),
            }),
            BotifiedFrameEvent::RegistryDiagnostic(TaskFrameDiagnostic {
                op: Some("registry_set".to_owned()),
                code: "invalid_value",
                message: "registry_set value is required".to_owned(),
                request_id: Some("bad-set".to_owned()),
            }),
            BotifiedFrameEvent::ProtocolDiagnostic(TaskFrameDiagnostic {
                op: Some("registry_snapshot".to_owned()),
                code: "unsupported_op",
                message: "echoed stdin frame".to_owned(),
                request_id: Some("echoed".to_owned()),
            }),
        ]);

        wait_for_service_workers_idle(&service).await;

        let events = service.events_after(before_seq);
        assert!(
            events.is_empty(),
            "stdio registry/protocol diagnostics must not write timeline events: {events:?}"
        );
        assert_eq!(provider.calls(), 0);
        assert_eq!(service.status().queue_length, 0);
        assert_eq!(service_context_len(&service), before_context_len);
        assert_eq!(
            service.timeline_bootstrap_snapshot()["active_items"],
            before_active_items
        );
        assert_eq!(
            task_request_count(&service, &task.task_id),
            before_task_requests
        );
        let diagnostics =
            service.timeline_bootstrap_snapshot()["internal_diagnostics"]["stdio"].clone();
        assert_eq!(diagnostics["total"], json!(4));
        assert_eq!(diagnostics["by_domain"]["task_stdio_registry"], json!(3));
        assert_eq!(diagnostics["by_domain"]["task_stdio_protocol"], json!(1));
        assert_eq!(diagnostics["by_code"]["invalid_topic"], json!(1));
        assert_eq!(diagnostics["by_code"]["stdin_write_failed"], json!(1));
        assert_eq!(diagnostics["by_code"]["invalid_value"], json!(1));
        assert_eq!(diagnostics["by_code"]["unsupported_op"], json!(1));
        assert_eq!(diagnostics["last"]["domain"], json!("task_stdio_protocol"));
        assert_eq!(diagnostics["last"]["code"], json!("unsupported_op"));
        assert_eq!(diagnostics["last"]["op"], json!("registry_snapshot"));
        assert_eq!(diagnostics["last"]["id"], json!("echoed"));
        assert!(diagnostics["last"]["recorded_at"].is_string());
        assert!(
            !diagnostics.to_string().contains("must not leak"),
            "internal diagnostic summary must stay bounded and omit registry values: {diagnostics}"
        );

        profiler
            .lock()
            .expect("profiler mutex poisoned")
            .finish()
            .expect("summary should write");
        let profile_events =
            fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
        assert!(!profile_events.contains("task_stdio_registry"));
        assert!(!profile_events.contains("task_stdio_protocol"));
        assert!(!profile_events.contains("stdin_write_failed"));
        assert!(!profile_events.contains("must not leak"));
        let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
        assert_eq!(summary_value(&summary, "task_requests"), "0");
        assert_eq!(summary_value(&summary, "task_requests_failed"), "0");
    }

    #[test]
    fn task_send_rejects_bounded_terminal_noninteractive_oversized_write_failed_and_cross_owner() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-send-rejections"),
            Arc::new(PanicProvider),
            Vec::new(),
        );

        let terminal = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_terminal_send", "bash", "{}"));
        service
            .inner
            .background_tasks
            .finish_task(&terminal.task_id, TaskState::Completed, "done")
            .expect("task should finish");
        let terminal_send =
            service
                .inner
                .send_task_message_by_owner(&TaskOwner::Main, &terminal.task_id, "hello");
        assert_eq!(terminal_send.status, TaskSendStatus::TaskTerminal);

        let noninteractive = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_no_stdin_send", "bash", "{}"));
        let noninteractive_send = service.inner.send_task_message_by_owner(
            &TaskOwner::Main,
            &noninteractive.task_id,
            "hello",
        );
        assert_eq!(noninteractive_send.status, TaskSendStatus::StdinNotWritable);

        let oversized = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_oversized_send", "bash", "{}"));
        let oversized_stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&oversized.task_id, Arc::new(oversized_stdin.clone()))
            .expect("task exists");
        let oversized_send = service.inner.send_task_message_by_owner(
            &TaskOwner::Main,
            &oversized.task_id,
            &"x".repeat(TASK_STDIN_CONTROL_FRAME_BYTES),
        );
        assert_eq!(oversized_send.status, TaskSendStatus::MessageTooLarge);
        assert_eq!(oversized_stdin.text(), "");

        let failing = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_failed_send", "bash", "{}"));
        service
            .inner
            .background_tasks
            .register_stdin_writer(&failing.task_id, Arc::new(FailingTaskStdin))
            .expect("task exists");
        let failed_send =
            service
                .inner
                .send_task_message_by_owner(&TaskOwner::Main, &failing.task_id, "hello");
        assert_eq!(failed_send.status, TaskSendStatus::WriteFailed);
        assert!(service.events_after(0).iter().any(|event| {
            event.event_type == "task_send.failed"
                && event.data["task_id"] == json!(failing.task_id)
                && event.data["status"] == json!("write_failed")
        }));

        let subagent_owned = service.inner.background_tasks.start_task(
            NewBackgroundTask::new("call_cross_owner_send", "bash", "{}")
                .with_owner(TaskOwner::subagent("branch-send")),
        );
        let cross_owner_stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&subagent_owned.task_id, Arc::new(cross_owner_stdin.clone()))
            .expect("task exists");
        let cross_owner_send = service.inner.send_task_message_by_owner(
            &TaskOwner::Main,
            &subagent_owned.task_id,
            "hello",
        );
        assert_eq!(cross_owner_send.status, TaskSendStatus::UnknownTask);
        assert_eq!(cross_owner_stdin.text(), "");
    }

    #[tokio::test]
    async fn task_request_profiling_records_requested_written_and_expired_without_payloads() {
        let (profiler, report_dir) = service_test_profiler("task-request-lifecycle");
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-request-profile"),
            Arc::new(PanicProvider),
            Vec::new(),
        )
        .with_profiler(Some(profiler.clone()));
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_profiled", "bash", "{}"));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin))
            .expect("task exists");

        assert!(matches!(
            service.inner.admit_task_request_frame(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need secret input".to_owned(),
                    expect: Some("short secret answer".to_owned()),
                    timeout: Some(Duration::from_secs(60)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestFrameAdmission::Accepted(_)
        ));
        let written = service
            .inner
            .reply_task_request(&task.task_id, "r1", "raw answer");
        assert_eq!(written.status, TaskReplyStatus::Written);

        assert!(matches!(
            service.inner.admit_task_request_frame(
                &task.task_id,
                TaskRequestFrame {
                    id: "r2".to_owned(),
                    request: "expire this payload".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_nanos(1)),
                    urgency: InputUrgency::Urgent,
                },
            ),
            TaskRequestFrameAdmission::Accepted(_)
        ));
        service
            .inner
            .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));

        profiler
            .lock()
            .expect("profiler mutex poisoned")
            .finish()
            .expect("summary should write");
        let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
        assert!(events.contains(",task_ask,task_ask.requested,pending,"));
        assert!(events.contains(",task_ask,task_reply.written,written,"));
        assert!(events.contains(",task_ask,task_ask.expired,expired,"));
        assert!(!events.contains("need secret input"));
        assert!(!events.contains("short secret answer"));
        assert!(!events.contains("raw answer"));
        assert!(!events.contains("expire this payload"));

        let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
        assert_eq!(summary_value(&summary, "task_requests"), "2");
        assert_eq!(summary_value(&summary, "task_requests_replied"), "1");
        assert_eq!(summary_value(&summary, "task_requests_expired"), "1");
        assert_eq!(summary_value(&summary, "task_requests_failed"), "0");
    }

    #[test]
    fn task_request_profiling_records_missing_task_rejection_without_payload() {
        let (profiler, report_dir) = service_test_profiler("task-request-missing");
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-request-missing-profile"),
            Arc::new(PanicProvider),
            Vec::new(),
        )
        .with_profiler(Some(profiler.clone()));

        assert!(matches!(
            service.inner.admit_task_request_frame(
                "missing_task",
                TaskRequestFrame {
                    id: "q1".to_owned(),
                    request: "raw payload must stay out of profiling".to_owned(),
                    expect: Some("secret expected shape".to_owned()),
                    timeout: Some(Duration::from_secs(60)),
                    urgency: InputUrgency::Urgent,
                },
            ),
            TaskRequestFrameAdmission::None
        ));

        profiler
            .lock()
            .expect("profiler mutex poisoned")
            .finish()
            .expect("summary should write");
        let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
        assert!(events.contains(",task_ask,task_ask.rejected,rejected,"));
        assert!(events.contains(",missing_task,q1,"));
        assert!(events.contains(",urgent,"));
        assert!(events.contains(",task_not_found,"));
        assert!(!events.contains("raw payload must stay out of profiling"));
        assert!(!events.contains("secret expected shape"));

        let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
        assert_eq!(summary_value(&summary, "task_requests"), "1");
        assert_eq!(summary_value(&summary, "task_requests_failed"), "1");
    }

    #[test]
    fn task_request_profiling_records_malformed_diagnostic_without_counting_task_request() {
        let (profiler, report_dir) = service_test_profiler("task-request-diagnostic");
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-diagnostic-profile"),
            Arc::new(PanicProvider),
            Vec::new(),
        )
        .with_profiler(Some(profiler.clone()));
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_profiled", "bash", "{}"));

        service.inner.handle_task_frame_diagnostic(
            &task.task_id,
            TaskFrameDiagnostic {
                op: None,
                code: "malformed_frame",
                message: "invalid botified frame JSON".to_owned(),
                request_id: None,
            },
        );

        profiler
            .lock()
            .expect("profiler mutex poisoned")
            .finish()
            .expect("summary should write");
        let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
        assert!(events.contains(",task_ask,task_ask.rejected,rejected,"));
        assert!(events.contains(",malformed_frame,false,task frame diagnostic rejected"));
        assert!(!events.contains("invalid botified frame JSON"));

        let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
        assert_eq!(summary_value(&summary, "task_requests"), "0");
        assert_eq!(summary_value(&summary, "task_requests_failed"), "0");
    }

    #[test]
    fn task_request_profiling_records_diagnostic_with_request_id_without_payload_message() {
        let (profiler, report_dir) = service_test_profiler("task-request-diagnostic-with-id");
        let service = Service::new(
            AgentConfig::new("system").with_session("service-task-diagnostic-with-id-profile"),
            Arc::new(PanicProvider),
            Vec::new(),
        )
        .with_profiler(Some(profiler.clone()));
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_profiled", "bash", "{}"));

        service.inner.handle_task_frame_diagnostic(
            &task.task_id,
            TaskFrameDiagnostic {
                op: Some("ask".to_owned()),
                code: "unknown_field",
                message: "unknown field fake_secret_field with value sk-fake-secret".to_owned(),
                request_id: Some("q1".to_owned()),
            },
        );

        profiler
            .lock()
            .expect("profiler mutex poisoned")
            .finish()
            .expect("summary should write");
        let events = fs::read_to_string(report_dir.join("events.csv")).expect("read events csv");
        assert!(events.contains(",task_ask,task_ask.rejected,rejected,"));
        assert!(events.contains(",unknown_field,false,"));
        assert!(events.contains(&format!(",{},q1,", task.task_id)));
        assert!(!events.contains("fake_secret_field"));
        assert!(!events.contains("sk-fake-secret"));

        let summary = fs::read_to_string(report_dir.join("summary.csv")).expect("read summary csv");
        assert_eq!(summary_value(&summary, "task_requests"), "1");
        assert_eq!(summary_value(&summary, "task_requests_failed"), "1");
    }

    #[test]
    fn accepted_task_request_enqueue_failure_after_expired_does_not_emit_second_terminal_effect() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-enqueue-failure-after-expired"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_expired_reject", "bash", "{}"));
        let stdin = RecordingTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        assert!(matches!(
            service.inner.background_tasks.accept_task_request(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need input".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_nanos(1)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestAdmission::Accepted(_)
        ));

        service
            .inner
            .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));
        service
            .inner
            .reject_accepted_task_request_after_enqueue_failure(
                &task.task_id,
                "r1",
                &ServiceError::QueueFull,
            );

        let events = service.events_after(0);
        assert_eq!(
            events
                .iter()
                .filter(|event| {
                    event.event_type == "task_ask.expired" && event.data["ask_id"] == "r1"
                })
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| {
                    event.event_type == "task_ask.rejected" && event.data["ask_id"] == "r1"
                })
                .count(),
            0,
            "enqueue failure must not emit a second terminal task_ask event after expiration"
        );
        let stdin_text = stdin.text();
        assert_eq!(stdin_text.matches("\"code\":\"ask_expired\"").count(), 1);
        assert_eq!(stdin_text.matches("\"code\":\"queue_full\"").count(), 0);
    }

    #[test]
    fn task_request_effect_stdin_write_failure_emits_bounded_diagnostic() {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-effect-stdin-failure"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new("call_stdin_missing", "bash", "{}"));
        assert!(matches!(
            service.inner.background_tasks.accept_task_request(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need input".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_nanos(1)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestAdmission::Accepted(_)
        ));

        service
            .inner
            .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));

        let diagnostic = service
            .events_after(0)
            .into_iter()
            .find(|event| event.event_type == "task.stdin_write_failed")
            .expect("effect stdin failure should emit a diagnostic event");
        assert_eq!(diagnostic.data["task_id"], json!(task.task_id));
        assert_eq!(diagnostic.data["ask_id"], json!("r1"));
        assert_eq!(diagnostic.data["kind"], json!("ask_expired"));
        assert!(diagnostic.data["error"]
            .as_str()
            .expect("diagnostic error should be a string")
            .contains("stdin"));
    }

    #[test]
    fn ask_timeout_exception_unsupported_priority_writer_records_diagnostic_without_sync_fallback()
    {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-effect-unsupported-priority"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_effect_unsupported_priority",
                "bash",
                "{}",
            ));
        let stdin = UnsupportedPriorityTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        assert!(matches!(
            service.inner.background_tasks.accept_task_request(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need input".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_nanos(1)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestAdmission::Accepted(_)
        ));

        service
            .inner
            .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));

        assert!(
            !stdin.sync_called(),
            "ask timeout exception must not call synchronous write_stdin fallback"
        );
        let diagnostic = service
            .events_after(0)
            .into_iter()
            .find(|event| event.event_type == "task.stdin_write_failed")
            .expect("effect stdin failure should emit a diagnostic event");
        assert_eq!(diagnostic.data["task_id"], json!(task.task_id));
        assert_eq!(diagnostic.data["ask_id"], json!("r1"));
        assert_eq!(diagnostic.data["kind"], json!("ask_expired"));
        assert!(
            diagnostic.data["error"]
                .as_str()
                .expect("diagnostic error should be a string")
                .contains("unsupported"),
            "{diagnostic:?}"
        );
    }

    #[test]
    fn ask_timeout_exception_would_block_priority_writer_records_diagnostic_without_sync_fallback()
    {
        let service = Service::new(
            AgentConfig::new("system").with_session("service-effect-would-block-priority"),
            Arc::new(PanicProvider),
            Vec::new(),
        );
        let task = service
            .inner
            .background_tasks
            .start_task(NewBackgroundTask::new(
                "call_effect_would_block_priority",
                "bash",
                "{}",
            ));
        let stdin = WouldBlockPriorityTaskStdin::default();
        service
            .inner
            .background_tasks
            .register_stdin_writer(&task.task_id, Arc::new(stdin.clone()))
            .expect("task exists");
        assert!(matches!(
            service.inner.background_tasks.accept_task_request(
                &task.task_id,
                TaskRequestFrame {
                    id: "r1".to_owned(),
                    request: "need input".to_owned(),
                    expect: None,
                    timeout: Some(Duration::from_nanos(1)),
                    urgency: InputUrgency::Normal,
                },
            ),
            TaskRequestAdmission::Accepted(_)
        ));

        service
            .inner
            .expire_due_task_requests(&task.task_id, SystemTime::now() + Duration::from_secs(1));

        assert!(
            !stdin.sync_called(),
            "ask timeout exception would-block must not call synchronous write_stdin fallback"
        );
        let diagnostic = service
            .events_after(0)
            .into_iter()
            .find(|event| event.event_type == "task.stdin_write_failed")
            .expect("effect stdin failure should emit a diagnostic event");
        assert_eq!(diagnostic.data["task_id"], json!(task.task_id));
        assert_eq!(diagnostic.data["ask_id"], json!("r1"));
        assert_eq!(diagnostic.data["kind"], json!("ask_expired"));
        assert!(
            diagnostic.data["error"]
                .as_str()
                .expect("diagnostic error should be a string")
                .contains("would block"),
            "{diagnostic:?}"
        );
    }

    #[derive(Clone, Default)]
    struct CursorSyncFailureSessionFile {
        state: Arc<Mutex<CursorSyncFailureSessionFileState>>,
    }

    #[derive(Default)]
    struct CursorSyncFailureSessionFileState {
        last_line: String,
        fail_cursor_message_id: Option<String>,
        cursor_attempts: HashMap<String, usize>,
        synced_cursor_ids: Vec<String>,
    }

    impl CursorSyncFailureSessionFile {
        fn failing_cursor(message_id: impl Into<String>) -> Self {
            let file = Self::default();
            file.state
                .lock()
                .expect("cursor sync test mutex poisoned")
                .fail_cursor_message_id = Some(message_id.into());
            file
        }

        fn allow_cursor_sync(&self, message_id: &str) {
            let mut state = self.state.lock().expect("cursor sync test mutex poisoned");
            if state.fail_cursor_message_id.as_deref() == Some(message_id) {
                state.fail_cursor_message_id = None;
            }
        }

        fn cursor_attempts(&self, message_id: &str) -> usize {
            *self
                .state
                .lock()
                .expect("cursor sync test mutex poisoned")
                .cursor_attempts
                .get(message_id)
                .unwrap_or(&0)
        }

        fn synced_cursor_ids(&self) -> Vec<String> {
            self.state
                .lock()
                .expect("cursor sync test mutex poisoned")
                .synced_cursor_ids
                .clone()
        }
    }

    impl SessionFileIo for CursorSyncFailureSessionFile {
        fn len(&mut self) -> io::Result<u64> {
            Ok(0)
        }

        fn write_line(&mut self, line: &str) -> io::Result<()> {
            self.state
                .lock()
                .expect("cursor sync test mutex poisoned")
                .last_line = line.to_owned();
            Ok(())
        }

        fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
            self.state
                .lock()
                .expect("cursor sync test mutex poisoned")
                .last_line = String::from_utf8_lossy(bytes).into_owned();
            Ok(())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn sync_data(&mut self) -> io::Result<()> {
            let mut state = self.state.lock().expect("cursor sync test mutex poisoned");
            let Some(message_id) = message_cursor_id_from_line(&state.last_line) else {
                return Ok(());
            };
            *state.cursor_attempts.entry(message_id.clone()).or_insert(0) += 1;
            if state.fail_cursor_message_id.as_deref() == Some(message_id.as_str()) {
                return Err(io::Error::other("message cursor sync_data failed"));
            }
            state.synced_cursor_ids.push(message_id);
            Ok(())
        }

        fn set_len(&mut self, _len: u64) -> io::Result<()> {
            self.state
                .lock()
                .expect("cursor sync test mutex poisoned")
                .last_line
                .clear();
            Ok(())
        }
    }

    fn message_cursor_id_from_line(line: &str) -> Option<String> {
        if !line.contains("\"type\":\"message_cursor\"") {
            return None;
        }
        let start = line.find("\"message_id\":\"")? + "\"message_id\":\"".len();
        let end = line[start..].find('"')?;
        Some(line[start..start + end].to_owned())
    }

    fn append_raw_event_for_turn(
        inner: &ServiceInner,
        turn_id: Option<&str>,
        event_type: &str,
        data: Value,
    ) -> ServiceEvent {
        inner
            .event_log
            .lock()
            .expect("event log mutex poisoned")
            .append(event_type, inner.config.session.as_deref(), turn_id, data)
    }

    fn public_replay_buffer_event_count(inner: &ServiceInner) -> usize {
        inner
            .public_replay
            .lock()
            .expect("public replay projection buffer mutex poisoned")
            .events
            .len()
    }

    #[test]
    fn durable_ack_boundary_message_cursor_sync_failure_does_not_install_replay_marker() {
        let session_file = CursorSyncFailureSessionFile::failing_cursor("msg_1");
        let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
            PathBuf::from("session.jsonl"),
            session_file.clone(),
        ));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        );
        let turn_id = "turn_1";
        let turn_started =
            service
                .inner
                .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
        let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            insert_message_index_entry(
                &mut state.message_index,
                "msg_1".to_owned(),
                vec![ContentPart::text("needs durable cursor")],
                message_cursor,
            );
        }
        service.inner.append_event_for_turn(
            Some(turn_id),
            "queue.drained",
            json!({"message_ids": ["msg_1"]}),
        );
        service
            .inner
            .append_event_for_turn(Some(turn_id), "turn.completed", json!({"usage": {}}));

        let error = persist_public_replay(service.inner.as_ref(), 0)
            .expect_err("message cursor sync failure should be returned");
        assert!(error.contains("message cursor sync_data failed"));

        assert_eq!(session_file.cursor_attempts("msg_1"), 1);
        assert!(!service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .durable_message_replays
            .contains_key("msg_1"));

        session_file.allow_cursor_sync("msg_1");
        persist_public_replay(service.inner.as_ref(), 0)
            .expect("cursor persistence retry should succeed");

        assert_eq!(session_file.cursor_attempts("msg_1"), 2);
        assert!(service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .durable_message_replays
            .contains_key("msg_1"));
    }

    #[test]
    fn public_replay_cursor_gap_fails_without_writing_partial_cursor() {
        let session_file = CursorSyncFailureSessionFile::default();
        let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
            PathBuf::from("session.jsonl"),
            session_file.clone(),
        ));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        );
        let after_seq = service.inner.last_event_seq();
        let turn_id = "turn_gap";
        let turn_started = append_raw_event_for_turn(
            service.inner.as_ref(),
            Some(turn_id),
            "turn.started",
            json!({}),
        );
        let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            insert_message_index_entry(
                &mut state.message_index,
                "msg_1".to_owned(),
                vec![ContentPart::text("needs durable cursor")],
                message_cursor,
            );
        }

        for index in 0..DEFAULT_EVENT_LOG_CAPACITY {
            append_raw_event_for_turn(
                service.inner.as_ref(),
                Some(turn_id),
                "provider.delta",
                json!({"index": index}),
            );
        }
        append_raw_event_for_turn(
            service.inner.as_ref(),
            Some(turn_id),
            "queue.drained",
            json!({"message_ids": ["msg_1"]}),
        );
        append_raw_event_for_turn(
            service.inner.as_ref(),
            Some(turn_id),
            "queue.drained",
            json!({"message_ids": []}),
        );

        let error = persist_public_replay(service.inner.as_ref(), after_seq)
            .expect_err("event gap before queue.drained should fail public replay projection");
        assert!(
            error.contains("public replay") && error.contains("event gap"),
            "error should explain lost public replay event gap, got: {error}"
        );
        assert_eq!(
            session_file.cursor_attempts("msg_1"),
            0,
            "gap handling must fail before writing a partial message cursor"
        );
        assert!(!service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .durable_message_replays
            .contains_key("msg_1"));
    }

    #[test]
    fn public_replay_cursor_incomplete_raw_projection_fails_closed_without_pruning_buffer() {
        let session_file = CursorSyncFailureSessionFile::default();
        let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
            PathBuf::from("session.jsonl"),
            session_file.clone(),
        ));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        );
        let after_seq = service.inner.last_event_seq();
        let turn_id = "turn_incomplete";
        let turn_started =
            service
                .inner
                .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
        let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            insert_message_index_entry(
                &mut state.message_index,
                "msg_1".to_owned(),
                vec![ContentPart::text("needs durable cursor")],
                message_cursor,
            );
        }
        service.inner.append_event_for_turn(
            Some(turn_id),
            "queue.drained",
            json!({"message_ids": ["msg_1"]}),
        );

        let error = persist_public_replay(service.inner.as_ref(), after_seq)
            .expect_err("non-durable queue.drained without terminal public event should fail");
        assert!(
            error.contains("public replay") && error.contains("incomplete"),
            "error should explain incomplete public replay projection, got: {error}"
        );
        assert_eq!(session_file.cursor_attempts("msg_1"), 0);
        assert!(!service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .durable_message_replays
            .contains_key("msg_1"));
        assert!(
            public_replay_buffer_event_count(service.inner.as_ref()) > 0,
            "incomplete projection failure must not prune retry buffer"
        );
    }

    #[test]
    fn public_replay_cursor_survives_event_ring_gap_with_per_cycle_projection_buffer() {
        let session_file = CursorSyncFailureSessionFile::default();
        let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
            PathBuf::from("session.jsonl"),
            session_file.clone(),
        ));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        );
        let after_seq = service.inner.last_event_seq();
        let turn_id = "turn_buffer_gap";
        let turn_started =
            service
                .inner
                .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
        let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            insert_message_index_entry(
                &mut state.message_index,
                "msg_1".to_owned(),
                vec![ContentPart::text("needs durable cursor")],
                message_cursor,
            );
        }

        for index in 0..DEFAULT_EVENT_LOG_CAPACITY {
            service.inner.append_event_for_turn(
                Some(turn_id),
                "provider.delta",
                json!({"index": index}),
            );
        }
        service.inner.append_event_for_turn(
            Some(turn_id),
            "queue.drained",
            json!({"message_ids": ["msg_1"]}),
        );
        service
            .inner
            .append_event_for_turn(Some(turn_id), "turn.completed", json!({"usage": {}}));

        assert!(service
            .inner
            .event_log
            .lock()
            .expect("event log mutex poisoned")
            .read_after(after_seq)
            .iter()
            .any(|event| event.event_type == "event.gap"));
        persist_public_replay(service.inner.as_ref(), after_seq)
            .expect("per-cycle buffer should persist cursor despite ring gap");

        assert_eq!(session_file.cursor_attempts("msg_1"), 1);
        assert!(service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .durable_message_replays
            .contains_key("msg_1"));
    }

    #[test]
    fn public_replay_cursor_sync_failure_with_buffer_does_not_install_marker_and_retries() {
        let session_file = CursorSyncFailureSessionFile::failing_cursor("msg_1");
        let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
            PathBuf::from("session.jsonl"),
            session_file.clone(),
        ));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        );
        let after_seq = service.inner.last_event_seq();
        let turn_id = "turn_buffer_retry";
        let turn_started =
            service
                .inner
                .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
        let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            insert_message_index_entry(
                &mut state.message_index,
                "msg_1".to_owned(),
                vec![ContentPart::text("needs durable cursor")],
                message_cursor,
            );
        }

        for index in 0..DEFAULT_EVENT_LOG_CAPACITY {
            service.inner.append_event_for_turn(
                Some(turn_id),
                "provider.delta",
                json!({"index": index}),
            );
        }
        service.inner.append_event_for_turn(
            Some(turn_id),
            "queue.drained",
            json!({"message_ids": ["msg_1"]}),
        );
        service
            .inner
            .append_event_for_turn(Some(turn_id), "turn.completed", json!({"usage": {}}));

        let error = persist_public_replay(service.inner.as_ref(), after_seq)
            .expect_err("cursor sync failure should be returned even when buffer covers gap");
        assert!(error.contains("message cursor sync_data failed"));
        assert_eq!(session_file.cursor_attempts("msg_1"), 1);
        assert!(!service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .durable_message_replays
            .contains_key("msg_1"));
        assert!(
            public_replay_buffer_event_count(service.inner.as_ref()) > 0,
            "cursor sync failure must keep buffer events for retry"
        );

        session_file.allow_cursor_sync("msg_1");
        persist_public_replay(service.inner.as_ref(), after_seq)
            .expect("buffered cursor persistence retry should succeed");
        assert_eq!(session_file.cursor_attempts("msg_1"), 2);
        assert!(service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .durable_message_replays
            .contains_key("msg_1"));
    }

    #[test]
    fn public_replay_cursor_batch_sync_failure_installs_synced_markers_and_retries_missing() {
        let session_file = CursorSyncFailureSessionFile::failing_cursor("msg_2");
        let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
            PathBuf::from("session.jsonl"),
            session_file.clone(),
        ));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        );
        let after_seq = service.inner.last_event_seq();
        let turn_id = "turn_buffer_batch";
        let turn_started =
            service
                .inner
                .append_event_for_turn(Some(turn_id), "turn.started", json!({}));
        let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            for message_id in ["msg_1", "msg_2"] {
                insert_message_index_entry(
                    &mut state.message_index,
                    message_id.to_owned(),
                    vec![ContentPart::text(format!(
                        "needs durable cursor {message_id}"
                    ))],
                    message_cursor.clone(),
                );
            }
        }

        for index in 0..DEFAULT_EVENT_LOG_CAPACITY {
            service.inner.append_event_for_turn(
                Some(turn_id),
                "provider.delta",
                json!({"index": index}),
            );
        }
        service.inner.append_event_for_turn(
            Some(turn_id),
            "queue.drained",
            json!({"message_ids": ["msg_1", "msg_2"]}),
        );
        service
            .inner
            .append_event_for_turn(Some(turn_id), "turn.completed", json!({"usage": {}}));

        let error = persist_public_replay(service.inner.as_ref(), after_seq)
            .expect_err("second cursor sync failure should return an error");
        assert!(error.contains("message cursor sync_data failed"));
        assert_eq!(session_file.synced_cursor_ids(), vec!["msg_1"]);
        assert_eq!(session_file.cursor_attempts("msg_1"), 1);
        assert_eq!(session_file.cursor_attempts("msg_2"), 1);
        {
            let state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            assert!(
                state.durable_message_replays.contains_key("msg_1"),
                "msg_1 marker should be installed immediately after its cursor sync succeeds"
            );
            assert!(!state.durable_message_replays.contains_key("msg_2"));
        }
        assert!(
            public_replay_buffer_event_count(service.inner.as_ref()) > 0,
            "partial cursor sync failure must not prune retry buffer"
        );

        session_file.allow_cursor_sync("msg_2");
        persist_public_replay(service.inner.as_ref(), after_seq)
            .expect("retry should write only the missing cursor");
        assert_eq!(session_file.synced_cursor_ids(), vec!["msg_1", "msg_2"]);
        assert_eq!(
            session_file.cursor_attempts("msg_1"),
            1,
            "retry should skip already durable cursor"
        );
        assert_eq!(session_file.cursor_attempts("msg_2"), 2);
        let state = service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned");
        assert!(state.durable_message_replays.contains_key("msg_1"));
        assert!(state.durable_message_replays.contains_key("msg_2"));
    }

    #[test]
    fn public_replay_cursor_prunes_no_candidate_and_already_durable_buffer_windows() {
        let session_file = CursorSyncFailureSessionFile::default();
        let recorder = Arc::new(FileSessionRecorder::new_for_test_with_writer(
            PathBuf::from("session.jsonl"),
            session_file.clone(),
        ));
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("service-test"),
            Arc::new(PanicProvider),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        );

        let empty_after_seq = service.inner.last_event_seq();
        service
            .inner
            .append_event_for_turn(Some("turn_empty"), "turn.started", json!({}));
        service.inner.append_event_for_turn(
            Some("turn_empty"),
            "queue.drained",
            json!({"message_ids": []}),
        );
        service.inner.append_event_for_turn(
            Some("turn_empty"),
            "turn.completed",
            json!({"usage": {}}),
        );
        assert!(public_replay_buffer_event_count(service.inner.as_ref()) > 0);
        persist_public_replay(service.inner.as_ref(), empty_after_seq)
            .expect("empty queue.drained replay window should be pruned successfully");
        assert_eq!(public_replay_buffer_event_count(service.inner.as_ref()), 0);

        let msg_after_seq = service.inner.last_event_seq();
        let turn_started =
            service
                .inner
                .append_event_for_turn(Some("turn_msg"), "turn.started", json!({}));
        let message_cursor = timeline_cursor_for_event(service.inner.as_ref(), &turn_started);
        {
            let mut state = service
                .inner
                .state
                .lock()
                .expect("service state mutex poisoned");
            insert_message_index_entry(
                &mut state.message_index,
                "msg_1".to_owned(),
                vec![ContentPart::text("needs durable cursor")],
                message_cursor,
            );
        }
        service.inner.append_event_for_turn(
            Some("turn_msg"),
            "queue.drained",
            json!({"message_ids": ["msg_1"]}),
        );
        service.inner.append_event_for_turn(
            Some("turn_msg"),
            "turn.completed",
            json!({"usage": {}}),
        );
        persist_public_replay(service.inner.as_ref(), msg_after_seq)
            .expect("first message cursor persist should succeed");
        assert_eq!(session_file.cursor_attempts("msg_1"), 1);
        assert_eq!(public_replay_buffer_event_count(service.inner.as_ref()), 0);

        let durable_after_seq = service.inner.last_event_seq();
        service
            .inner
            .append_event_for_turn(Some("turn_durable"), "turn.started", json!({}));
        service.inner.append_event_for_turn(
            Some("turn_durable"),
            "queue.drained",
            json!({"message_ids": ["msg_1"]}),
        );
        service.inner.append_event_for_turn(
            Some("turn_durable"),
            "turn.completed",
            json!({"usage": {}}),
        );
        assert!(public_replay_buffer_event_count(service.inner.as_ref()) > 0);
        persist_public_replay(service.inner.as_ref(), durable_after_seq)
            .expect("already durable candidate replay window should prune without rewriting");
        assert_eq!(
            session_file.cursor_attempts("msg_1"),
            1,
            "already durable message cursor should not be rewritten"
        );
        assert_eq!(public_replay_buffer_event_count(service.inner.as_ref()), 0);
    }
}
