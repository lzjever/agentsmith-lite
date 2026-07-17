use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::agent_events::AgentUsage;
use crate::compact::{self, CompactConfig};
use crate::context_files::{load_context_files, ContextFileLoadConfig};
use crate::event::{EventLog, ServiceEvent};
use crate::files::FileStore;
use crate::llm_text_preview::{LlmTextPreviewMetadata, LlmTextPreviewSink, ProviderPreviewContext};
use crate::message_render::render_messages_for_provider_with_file_store;
use crate::profiling::{CsvEventRow, ProfilingTimestamp, ProviderProfilingContext, SharedProfiler};
use crate::provider::{Provider, ProviderErrorDiagnostic, ProviderMetadata, ProviderRequest};
use crate::skills::{
    load_skills, render_requested_skill_contexts_for_contents_with_frozen_bodies, skill_identity,
    FrozenSkillBodies, RequestedSkillContexts, Skill, SkillIdentity, SkillLoadConfig,
};
use crate::system_prompt::{
    build_system_prompt_with_capabilities, render_available_skills_context_report,
    render_explicit_skill_context, render_project_instruction_context,
    render_runtime_environment_context, PromptCapabilities, RuntimeEnvironmentContext,
};
use crate::tasks::{
    is_builtin_task_tool, BackgroundTaskManager, BotifiedFrameEvent, BoundedTaskOutputSink,
    InteractiveStdioBridge, NewBackgroundTask, TaskOutputPolicy, TaskState, TaskStdinWriter,
};
use crate::tools::{
    is_registry_tool_name, Tool, ToolError, ToolExecutionContext, ToolOutputSink,
    ToolOutputSnapshot, ToolTimeout,
};
use crate::transcript::{repair_provider_transcript, validate_provider_transcript};
use crate::types::{
    assistant_payload_is_valid, ContentPart, ContextRole, Message, StopReason, ToolCall,
    ToolResult, Usage,
};

const DEFAULT_DETACH_AFTER: Duration = Duration::from_secs(1);
const MAX_DETACH_AFTER: Duration = Duration::from_secs(10);
const DEFAULT_TOOL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TOOL_TIMEOUT: Duration = Duration::from_secs(1_800);
const DEFAULT_MAX_CONCURRENT_TASKS: usize = 4;
const DEFAULT_MAX_RETAINED_TASKS: usize = 128;
const DEFAULT_TASK_RETENTION: Duration = Duration::from_secs(86_400);
const DEFAULT_MAX_TASK_REQUEST_PENDING: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolExecutionPolicy {
    pub default_detach_after: Duration,
    pub max_detach_after: Duration,
    pub default_timeout: Duration,
    pub max_timeout: Duration,
    pub max_concurrent_tasks: usize,
    pub max_retained_tasks: usize,
    pub task_retention: Duration,
    pub max_task_request_pending: Duration,
}

impl ToolExecutionPolicy {
    pub fn with_default_detach_after(mut self, duration: Duration) -> Self {
        self.default_detach_after = duration;
        self
    }

    pub fn with_max_detach_after(mut self, duration: Duration) -> Self {
        self.max_detach_after = duration;
        self
    }

    pub fn with_default_timeout(mut self, duration: Duration) -> Self {
        self.default_timeout = duration;
        self
    }

    pub fn with_max_timeout(mut self, duration: Duration) -> Self {
        self.max_timeout = duration;
        self
    }

    pub fn with_max_concurrent_tasks(mut self, max_concurrent_tasks: usize) -> Self {
        self.max_concurrent_tasks = max_concurrent_tasks;
        self
    }

    pub fn with_max_retained_tasks(mut self, max_retained_tasks: usize) -> Self {
        self.max_retained_tasks = max_retained_tasks;
        self
    }

    pub fn with_task_retention(mut self, duration: Duration) -> Self {
        self.task_retention = duration;
        self
    }

    pub fn with_max_task_request_pending(mut self, duration: Duration) -> Self {
        self.max_task_request_pending = duration;
        self
    }
}

impl Default for ToolExecutionPolicy {
    fn default() -> Self {
        Self {
            default_detach_after: DEFAULT_DETACH_AFTER,
            max_detach_after: MAX_DETACH_AFTER,
            default_timeout: DEFAULT_TOOL_TIMEOUT,
            max_timeout: MAX_TOOL_TIMEOUT,
            max_concurrent_tasks: DEFAULT_MAX_CONCURRENT_TASKS,
            max_retained_tasks: DEFAULT_MAX_RETAINED_TASKS,
            task_retention: DEFAULT_TASK_RETENTION,
            max_task_request_pending: DEFAULT_MAX_TASK_REQUEST_PENDING,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentConfig {
    pub system_prompt: String,
    pub cwd: String,
    #[serde(default)]
    pub skills: Vec<Skill>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_refresh: Option<PromptRefreshConfig>,
    #[serde(default, skip_serializing_if = "PromptCapabilities::is_default")]
    pub prompt_capabilities: PromptCapabilities,
    #[serde(default)]
    pub compact: CompactConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub tool_execution: ToolExecutionPolicy,
    #[serde(default)]
    pub task_output: TaskOutputPolicy,
}

impl AgentConfig {
    pub fn new(system_prompt: impl Into<String>) -> Self {
        Self {
            system_prompt: system_prompt.into(),
            cwd: ".".to_owned(),
            skills: Vec::new(),
            prompt_refresh: None,
            prompt_capabilities: PromptCapabilities::default(),
            compact: CompactConfig::default(),
            session: None,
            turn_id: None,
            tool_execution: ToolExecutionPolicy::default(),
            task_output: TaskOutputPolicy::default(),
        }
    }

    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = cwd.into();
        self
    }

    pub fn with_skills(mut self, skills: Vec<Skill>) -> Self {
        self.skills = skills;
        self
    }

    pub fn with_prompt_refresh(
        mut self,
        base_system_prompt: impl Into<String>,
        skill_load_config: SkillLoadConfig,
        context_file_load_config: ContextFileLoadConfig,
    ) -> Self {
        self.prompt_refresh = Some(PromptRefreshConfig {
            base_system_prompt: base_system_prompt.into(),
            skill_load_config,
            context_file_load_config,
        });
        self
    }

    pub fn with_file_publication_capability(mut self) -> Self {
        self.prompt_capabilities = self.prompt_capabilities.with_file_publication();
        self
    }

    pub fn without_file_publication_capability(mut self) -> Self {
        self.prompt_capabilities = self.prompt_capabilities.without_file_publication();
        self
    }

    pub fn with_subagent_control_capability(mut self) -> Self {
        self.prompt_capabilities = self.prompt_capabilities.with_subagents();
        self
    }

    pub fn without_subagent_control_capability(mut self) -> Self {
        self.prompt_capabilities = self.prompt_capabilities.without_subagents();
        self
    }

    pub fn with_registry_capability(mut self) -> Self {
        self.prompt_capabilities = self.prompt_capabilities.with_registry();
        self
    }

    pub fn without_registry_capability(mut self) -> Self {
        self.prompt_capabilities = self.prompt_capabilities.without_registry();
        self
    }

    pub fn with_compact_threshold(mut self, threshold_tokens: usize) -> Self {
        self.compact.threshold_tokens = threshold_tokens;
        self
    }

    pub fn with_compact_keep_recent_tokens(mut self, keep_recent_tokens: usize) -> Self {
        self.compact.keep_recent_tokens = keep_recent_tokens;
        self
    }

    pub fn without_compaction(mut self) -> Self {
        self.compact.enabled = false;
        self
    }

    pub fn with_session(mut self, session: impl Into<String>) -> Self {
        self.session = Some(session.into());
        self
    }

    pub fn with_turn_id(mut self, turn_id: impl Into<String>) -> Self {
        self.turn_id = Some(turn_id.into());
        self
    }

    pub fn with_tool_execution_policy(mut self, policy: ToolExecutionPolicy) -> Self {
        self.tool_execution = policy;
        self
    }

    pub fn with_task_output_policy(mut self, policy: TaskOutputPolicy) -> Self {
        self.task_output = policy;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptRefreshConfig {
    pub base_system_prompt: String,
    pub skill_load_config: SkillLoadConfig,
    pub context_file_load_config: ContextFileLoadConfig,
}

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
        }
    }
}

fn requested_skill_contexts_for_current_request(
    messages: &[Message],
    skills: &[Skill],
    frozen_bodies: &FrozenSkillBodies,
    cwd: &Path,
    current_request_start: usize,
) -> RequestedSkillContexts {
    render_requested_skill_contexts_for_contents_with_frozen_bodies(
        messages[current_request_start..]
            .iter()
            .filter_map(|message| match message {
                Message::User { content } => Some(content.as_slice()),
                Message::Assistant { .. } | Message::ToolResult(_) => None,
            }),
        skills,
        cwd,
        Some(frozen_bodies),
    )
}

fn render_explicit_skill_context_without_requested(
    skills: &[Skill],
    requested_identities: &HashSet<SkillIdentity>,
) -> Option<String> {
    if requested_identities.is_empty() {
        return render_explicit_skill_context(skills);
    }

    let filtered = skills
        .iter()
        .filter(|skill| {
            !(skill.is_explicit() && requested_identities.contains(&skill_identity(skill)))
        })
        .cloned()
        .collect::<Vec<_>>();
    render_explicit_skill_context(&filtered)
}

fn runtime_environment_context(config: &AgentConfig) -> RuntimeEnvironmentContext {
    RuntimeEnvironmentContext {
        cwd: model_visible_cwd(&config.cwd).display().to_string(),
        shell: "bash -lc".to_owned(),
    }
}

fn model_visible_cwd(cwd: &str) -> PathBuf {
    let path = Path::new(cwd);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    std::fs::canonicalize(&absolute).unwrap_or(absolute)
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

fn map_current_request_start_after_compaction(
    original_request_start: usize,
    retained_start: usize,
) -> usize {
    if original_request_start <= retained_start {
        1
    } else {
        1 + (original_request_start - retained_start)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct AgentCommitError {
    message: String,
}

impl AgentCommitError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait AgentContextRecorder: Send + Sync {
    async fn record_message(&self, message: &Message) -> Result<(), AgentCommitError>;

    async fn record_accepted_input(
        &self,
        entry: &AcceptedInputEntry,
    ) -> Result<(), AgentCommitError>;

    async fn record_pending_input_removed(
        &self,
        _message_id: &str,
        _source: InputSource,
        _metadata: Option<&QueuedInputMetadata>,
        _reason: &str,
    ) -> Result<(), AgentCommitError> {
        Ok(())
    }

    async fn record_compaction(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
    ) -> Result<(), AgentCommitError> {
        self.record_message(&Message::user(summary.to_vec()))
            .await?;
        for message in retained_messages {
            self.record_message(message).await?;
        }
        Ok(())
    }

    async fn record_compaction_with_active_user_message_id(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        _active_user_message_id: Option<&str>,
    ) -> Result<(), AgentCommitError> {
        self.record_compaction(summary, retained_messages).await
    }

    async fn record_user_batch(&self, messages: &[Message]) -> Result<(), AgentCommitError> {
        for message in messages {
            if !matches!(message, Message::User { .. }) {
                return Err(AgentCommitError::new(
                    "user batch contains a non-user message",
                ));
            }
            self.record_message(message).await?;
        }
        Ok(())
    }

    async fn record_user_batch_with_ids(
        &self,
        messages: &[Message],
        message_ids: &[String],
    ) -> Result<(), AgentCommitError>;
}

#[async_trait]
pub trait AgentInputDrainer: Send + Sync {
    async fn begin_drain(&self, cancel: CancellationToken) -> DrainBatch;

    /// Prepare a pending drain for timeline persistence. Implementations must
    /// not make the drained user input durable here; `complete_commit` is the
    /// finalization point after `queue.drained` and `cycle.started` persist.
    async fn commit(&self, batch_id: &str) -> Result<DrainCommit, AgentCommitError>;

    async fn complete_commit(
        &self,
        _batch_id: &str,
        _commit: &DrainCommit,
        _cycle_id: Option<&str>,
    ) -> Result<(), AgentCommitError> {
        Ok(())
    }

    async fn rollback(&self, batch_id: &str);
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrainBatch {
    pub id: String,
    pub messages: Vec<DrainedMessage>,
}

impl DrainBatch {
    pub fn new(id: impl Into<String>, messages: Vec<DrainedMessage>) -> Self {
        Self {
            id: id.into(),
            messages,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DrainCommit {
    pub queue_length: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub callback_delivery_input_ids: Vec<String>,
}

impl DrainCommit {
    pub fn new(queue_length: usize) -> Self {
        Self {
            queue_length,
            callback_delivery_input_ids: Vec::new(),
        }
    }

    pub fn with_callback_delivery_input_ids(mut self, input_ids: Vec<String>) -> Self {
        self.callback_delivery_input_ids = input_ids;
        self
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputSource {
    #[default]
    User,
    TaskCallback,
    SubagentCallback,
    #[serde(rename = "task_ask")]
    TaskRequest,
    #[serde(rename = "task_tell")]
    TaskTell,
}

impl InputSource {
    pub fn is_user(source: &Self) -> bool {
        *source == Self::User
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputUrgency {
    #[default]
    Normal,
    Urgent,
}

impl InputUrgency {
    pub fn is_normal(urgency: &Self) -> bool {
        *urgency == Self::Normal
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Urgent => "urgent",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "normal" => Some(Self::Normal),
            "urgent" => Some(Self::Urgent),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueuedInputMetadata {
    #[serde(rename = "task_ask")]
    TaskRequest {
        task_id: String,
        #[serde(rename = "ask_id")]
        request_id: String,
    },
    #[serde(rename = "task_tell")]
    TaskTell { task_id: String, tell_id: String },
    SubagentCallback {
        subagent_id: String,
        callback_id: String,
        kind: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AcceptedInputEntry {
    pub message_id: String,
    pub content: Vec<ContentPart>,
    pub cursor_seq: u64,
    pub source: InputSource,
    pub metadata: Option<QueuedInputMetadata>,
    pub urgency: InputUrgency,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrainedMessage {
    pub id: String,
    pub content: Vec<ContentPart>,
    #[serde(default, skip_serializing_if = "InputSource::is_user")]
    pub source: InputSource,
    #[serde(default, skip_serializing_if = "InputUrgency::is_normal")]
    pub urgency: InputUrgency,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<QueuedInputMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_seq: Option<u64>,
}

impl DrainedMessage {
    pub fn new(id: impl Into<String>, content: Vec<ContentPart>) -> Self {
        Self {
            id: id.into(),
            content,
            source: InputSource::User,
            urgency: InputUrgency::Normal,
            metadata: None,
            cursor_seq: None,
        }
    }

    pub fn with_source(mut self, source: InputSource) -> Self {
        self.source = source;
        self
    }

    pub fn with_urgency(mut self, urgency: InputUrgency) -> Self {
        self.urgency = urgency;
        self
    }

    pub fn with_metadata(mut self, metadata: QueuedInputMetadata) -> Self {
        self.metadata = Some(metadata);
        self
    }

    pub fn with_cursor_seq(mut self, cursor_seq: u64) -> Self {
        self.cursor_seq = Some(cursor_seq);
        self
    }

    fn into_user_message(self) -> Message {
        Message::user(self.content)
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

pub(crate) async fn run_agent_with_shared_event_log(
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: &dyn Provider,
    tools: Vec<Arc<dyn Tool>>,
    options: SharedAgentRunOptions<'_>,
) -> Result<AgentRunResult, AgentRunError> {
    run_agent_inner(
        config,
        initial_messages,
        provider,
        tools,
        AgentRuntime {
            input_drainer: options.input_drainer,
            context_recorder: options.context_recorder,
            initial_current_request_start: options.initial_current_request_start,
            initial_active_user_message_id: options.initial_active_user_message_id,
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
    cancel: CancellationToken,
    event_log: Option<AgentEventLog<'a>>,
    background_host: Option<Arc<dyn BackgroundExecutionHost>>,
    profiler: Option<SharedProfiler>,
    file_store: Option<FileStore>,
    preview_sink: Option<LlmTextPreviewSink>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PromptMaterialSnapshot {
    system_prompt: String,
    skills: Vec<Skill>,
    requested_skill_bodies: FrozenSkillBodies,
    project_instruction_context: Option<String>,
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
    let profiler = runtime.profiler.clone();
    let turn_profile_start = profiler_now(profiler.as_ref());
    let profile_config = config.clone();
    let result = run_agent_inner_body(config, initial_messages, provider, tools, runtime).await;
    write_turn_profile_row(
        profiler.as_ref(),
        &profile_config,
        turn_profile_start,
        &result,
    );
    result
}

async fn run_agent_inner_body(
    config: AgentConfig,
    initial_messages: Vec<Message>,
    provider: &dyn Provider,
    tools: Vec<Arc<dyn Tool>>,
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
    let background_host = runtime.background_host;
    let profiler = runtime.profiler;
    let file_store = runtime.file_store;
    let preview_sink = runtime.preview_sink;
    let mut current_request_start = runtime
        .initial_current_request_start
        .unwrap_or_else(|| current_request_start(&messages))
        .min(messages.len());
    let mut current_request_active_user_message_id = runtime.initial_active_user_message_id;
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
            current_request_active_user_message_id = drained_request_start.active_user_message_id;
            if provider_calls > 0 {
                prompt_material_snapshot = None;
            }
        }

        if let Some(retained_start) = maybe_compact_history(
            provider,
            cancel.clone(),
            &mut events,
            &config,
            &mut messages,
            current_request_start,
            current_request_active_user_message_id.as_deref(),
            context_recorder,
            provider_calls,
            active_cycle.as_ref(),
            &mut turn_usage,
            file_store.as_ref(),
            profiler.as_ref(),
        )
        .await?
        {
            current_request_start =
                map_current_request_start_after_compaction(current_request_start, retained_start);
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

        provider_calls += 1;
        let provider_observation = active_cycle
            .as_mut()
            .map(ActiveCycle::next_provider_request)
            .unwrap_or_else(|| ProviderRequestObservation::new(None, provider_calls));
        if prompt_material_snapshot.is_none() {
            prompt_material_snapshot = Some(refresh_prompt_materials(&mut config));
        }
        let prompt_materials = prompt_material_snapshot
            .as_ref()
            .expect("prompt material snapshot should be initialized before provider request");
        let mut request = ProviderRequest::new(
            prompt_materials.system_prompt.clone(),
            render_messages_for_provider_with_file_store(&messages, file_store.as_ref()),
            tools.iter().map(|tool| tool.spec()).collect(),
        );
        let available_skills_report =
            render_available_skills_context_report(&prompt_materials.skills);
        for warning in available_skills_report.warnings {
            emit(
                &mut events,
                &config,
                "service.warning",
                json!({ "message": warning }),
            );
        }
        if let Some(context) = available_skills_report.context {
            request = request.with_prefix_context(ContextRole::Developer, context);
        }
        let requested_skill_contexts = requested_skill_contexts_for_current_request(
            &messages,
            &prompt_materials.skills,
            &prompt_materials.requested_skill_bodies,
            Path::new(&config.cwd),
            current_request_start,
        );
        if let Some(context) = render_explicit_skill_context_without_requested(
            &prompt_materials.skills,
            &requested_skill_contexts.identities,
        ) {
            request = request.with_prefix_context(ContextRole::User, context);
        }
        if let Some(context) = prompt_materials.project_instruction_context.clone() {
            request = request.with_prefix_context(ContextRole::User, context);
        }
        request = request.with_prefix_context(
            ContextRole::System,
            render_runtime_environment_context(&runtime_environment_context(&config)),
        );
        for context in requested_skill_contexts.contexts {
            request = request.with_turn_context_at_transcript_index(
                ContextRole::User,
                context,
                current_request_start,
            );
        }
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
        let provider_metadata = provider.metadata_for_request(&request);
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
        let provider_result = provider.complete(request, cancel.clone()).await;
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
            Err(error) => {
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
                context_recorder,
                &assistant,
                &mut events,
                &config,
                &messages,
                provider_calls,
                active_cycle.as_ref(),
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
                &tools,
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
                    result = record_context_message(
                        context_recorder,
                        &tool_result_message,
                        &mut events,
                        &config,
                        &messages,
                        provider_calls,
                        active_cycle.as_ref(),
                    ) => {
                        if let Err(error) = result {
                            if let Some(run) = detached_run.as_ref() {
                                let (host, task_id, tool_call, result) = run
                                    .terminal_to_finish_without_start(
                                    "background task ack persistence failed",
                                    "background_task_ack_persistence_failed",
                                    TaskState::Failed,
                                );
                                host.finish_task(task_id, tool_call, result).await;
                            }
                            return Err(error);
                        }
                    }
                }
            } else {
                record_context_message(
                    context_recorder,
                    &tool_result_message,
                    &mut events,
                    &config,
                    &messages,
                    provider_calls,
                    active_cycle.as_ref(),
                )
                .await?;
            }
            let Message::ToolResult(tool_result) = &tool_result_message else {
                unreachable!("tool result message should contain a tool result");
            };
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
                tool_result,
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
                return Err(error);
            }
            write_tool_profile_row(
                profiler.as_ref(),
                &config,
                active_cycle.as_ref(),
                &tool_call,
                index + 1,
                tool_profile_start,
                tool_result,
            );
            if let Some(run) = detached_run {
                start_published_detached_tool_run(run);
            }
            messages.push(tool_result_message);
            if terminate {
                append_placeholder_tool_results(
                    &mut events,
                    &config,
                    &mut messages,
                    PersistContext {
                        context_recorder,
                        provider_calls,
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

fn bash_command_started_before_execute_candidate(
    config: &AgentConfig,
    background_host_present: bool,
    tool_call: &ToolCall,
) -> Option<bool> {
    bash_command(tool_call)?;
    let controls = resolve_tool_execution_controls(&config.tool_execution, tool_call).ok()?;
    if background_host_present && controls.detach_after.is_zero() {
        return None;
    }
    Some(background_host_present)
}

fn refresh_prompt_materials(config: &mut AgentConfig) -> PromptMaterialSnapshot {
    let project_instruction_context = if let Some(refresh) = config.prompt_refresh.as_ref() {
        let loaded_context_files = load_context_files(&refresh.context_file_load_config);
        let loaded_skills = load_skills(&refresh.skill_load_config);
        config.skills = loaded_skills.skills;
        config.system_prompt = build_system_prompt_with_capabilities(
            &refresh.base_system_prompt,
            config.prompt_capabilities,
        );
        render_project_instruction_context(&loaded_context_files.files)
    } else {
        config.system_prompt = build_system_prompt_with_capabilities(
            &config.system_prompt,
            config.prompt_capabilities,
        );
        None
    };

    let skills = config.skills.clone();
    PromptMaterialSnapshot {
        system_prompt: config.system_prompt.clone(),
        requested_skill_bodies: FrozenSkillBodies::from_skills(&skills),
        skills,
        project_instruction_context,
    }
}

async fn drain_inputs(
    input_drainer: Option<&dyn AgentInputDrainer>,
    cancel: CancellationToken,
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    messages: &mut Vec<Message>,
    provider_calls: usize,
) -> Result<Option<DrainedInput>, AgentRunError> {
    let Some(drainer) = input_drainer else {
        return Ok(None);
    };

    let batch = drainer.begin_drain(cancel.clone()).await;
    if cancel.is_cancelled() {
        drainer.rollback(&batch.id).await;
        let error = AgentRunError::new(AgentRunErrorKind::Cancelled, messages, provider_calls);
        emit_aborted(event_log, config, &error);
        return Err(error);
    }

    if batch.messages.is_empty() {
        return Ok(None);
    }

    let request_start = messages.len();
    let batch_id = batch.id.clone();
    let drained_messages = batch.messages;
    let message_ids = drained_messages
        .iter()
        .map(|drained| drained.id.clone())
        .collect::<Vec<_>>();
    let active_user_message_id = message_ids.first().cloned();
    let input_sources = drained_messages
        .iter()
        .map(|drained| {
            (
                drained.id.clone(),
                input_source_name(drained.source).to_owned(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let input_urgencies = drained_messages
        .iter()
        .map(|drained| (drained.id.clone(), drained.urgency.as_str().to_owned()))
        .collect::<BTreeMap<_, _>>();
    let input_previews = drained_messages
        .iter()
        .map(|drained| {
            (
                drained.id.clone(),
                drained_content_preview(&drained.content),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let user_messages = drained_messages
        .into_iter()
        .map(DrainedMessage::into_user_message)
        .collect::<Vec<_>>();
    let commit = drainer.commit(&batch_id).await.map_err(|error| {
        let error = AgentRunError::new(
            AgentRunErrorKind::Persistence {
                message: error.to_string(),
            },
            messages,
            provider_calls,
        );
        emit_error(event_log, config, &error);
        error
    })?;
    let queue_length = commit.queue_length;
    let queue_event = emit(
        event_log,
        config,
        "queue.drained",
        json!({
            "message_count": message_ids.len(),
            "message_ids": message_ids.clone(),
            "input_ids": message_ids.clone(),
            "input_sources": input_sources.clone(),
            "input_urgencies": input_urgencies.clone(),
            "input_previews": input_previews.clone(),
            "queue_length": queue_length
        }),
    );
    if let Err(error) = fail_if_event_log_failed(event_log, messages, provider_calls) {
        drainer.rollback(&batch_id).await;
        return Err(error);
    }
    let cycle_id = queue_event
        .as_ref()
        .map(|event| format!("cyc_{}", event.seq));
    let cycle = if let Some(cycle_id) = cycle_id.as_deref() {
        emit(
            event_log,
            config,
            "cycle.started",
            json!({
                "cycle_id": cycle_id,
                "input_ids": message_ids.clone(),
                "input_sources": input_sources.clone(),
                "input_urgencies": input_urgencies.clone(),
                "input_previews": input_previews.clone(),
                "queue_length": queue_length
            }),
        );
        if let Err(error) = fail_if_event_log_failed(event_log, messages, provider_calls) {
            drainer.rollback(&batch_id).await;
            return Err(error);
        }
        Some(ActiveCycle::new(
            cycle_id.to_owned(),
            message_ids,
            input_sources,
            input_urgencies,
            input_previews,
            queue_length,
        ))
    } else {
        None
    };
    drainer
        .complete_commit(&batch_id, &commit, cycle_id.as_deref())
        .await
        .map_err(|error| {
            let error = AgentRunError::new(
                AgentRunErrorKind::Persistence {
                    message: error.to_string(),
                },
                messages,
                provider_calls,
            );
            emit_error(event_log, config, &error);
            error
        })?;
    messages.extend(user_messages);
    Ok(Some(DrainedInput {
        request_start,
        active_user_message_id,
        cycle,
    }))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DrainedInput {
    request_start: usize,
    active_user_message_id: Option<String>,
    cycle: Option<ActiveCycle>,
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

fn drained_content_preview(content: &[ContentPart]) -> String {
    const MAX_PREVIEW_CHARS: usize = 256;

    let mut preview = String::new();
    for part in content {
        if !preview.is_empty() {
            preview.push('\n');
        }
        match part {
            ContentPart::Text { text } => preview.push_str(text),
            ContentPart::ImageUrl { .. } => preview.push_str("[image_url]"),
            ContentPart::ImageBase64 { mime_type, .. } => {
                preview.push_str("[image_base64:");
                preview.push_str(mime_type);
                preview.push(']');
            }
            ContentPart::File { binding } => {
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

    if preview.chars().count() > MAX_PREVIEW_CHARS {
        preview.chars().take(MAX_PREVIEW_CHARS).collect()
    } else {
        preview
    }
}

#[allow(clippy::too_many_arguments)]
async fn maybe_compact_history(
    provider: &dyn Provider,
    cancel: CancellationToken,
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    messages: &mut Vec<Message>,
    current_request_start: usize,
    active_user_message_id: Option<&str>,
    recorder: Option<&dyn AgentContextRecorder>,
    provider_calls: usize,
    active_cycle: Option<&ActiveCycle>,
    turn_usage: &mut AgentUsage,
    file_store: Option<&FileStore>,
    profiler: Option<&SharedProfiler>,
) -> Result<Option<usize>, AgentRunError> {
    if current_request_start == 0 {
        return Ok(None);
    }

    let Some(plan) = compact::maybe_plan_compaction(messages, &config.compact) else {
        return Ok(None);
    };

    let retained_start = plan.retained_start.min(current_request_start);
    let compacted_messages = messages[..retained_start].to_vec();
    let retained_messages = repair_provider_transcript(messages[retained_start..].to_vec());
    emit(
        event_log,
        config,
        "compact.started",
        json!({
            "tokens_before": plan.tokens_before,
            "message_count": messages.len(),
            "retained_message_count": retained_messages.len()
        }),
    );

    let mut request = compact::build_compaction_request_with_file_store(
        "You summarize conversation history for context compaction.".to_owned(),
        &compacted_messages,
        file_store,
    );
    if profiler.is_some() {
        request.set_profiling_context(ProviderProfilingContext {
            session: config.session.clone(),
            turn_id: config.turn_id.clone(),
            cycle_id: active_cycle.map(|cycle| cycle.cycle_id.clone()),
            provider_call_index: provider_calls + 1,
            request_kind: "compaction".to_owned(),
            input_message_count: compacted_messages.len(),
            message_count: request.input.len(),
            tool_spec_count: request.tools.len(),
        });
    }
    if cancel.is_cancelled() {
        let error = AgentRunError::new(AgentRunErrorKind::Cancelled, messages, provider_calls);
        emit_aborted_for_cycle(event_log, config, active_cycle, &error);
        return Err(error);
    }
    let provider_result = provider.complete(request, cancel.clone()).await;
    if cancel.is_cancelled() {
        let error = AgentRunError::new(AgentRunErrorKind::Cancelled, messages, provider_calls);
        emit_aborted_for_cycle(event_log, config, active_cycle, &error);
        return Err(error);
    }

    let response = match provider_result {
        Ok(response) => response,
        Err(error) => {
            let diagnostic = error.diagnostic();
            let error = AgentRunError::new(
                AgentRunErrorKind::provider_with_diagnostic(
                    format!("compaction failed: {error}"),
                    diagnostic,
                ),
                messages,
                provider_calls,
            );
            emit_error_for_cycle(event_log, config, active_cycle, &error);
            return Err(error);
        }
    };
    add_provider_usage(turn_usage, response.usage);
    let summary = match compact::response_summary(response) {
        Ok(summary) => summary,
        Err(message) => {
            let error = AgentRunError::new(
                AgentRunErrorKind::provider(format!("compaction failed: {message}")),
                messages,
                provider_calls,
            );
            emit_error_for_cycle(event_log, config, active_cycle, &error);
            return Err(error);
        }
    };

    let summary_message = compact::summary_message(summary);
    let Message::User { content: summary } = &summary_message else {
        unreachable!("compaction summary should be a user message");
    };
    if let Some(recorder) = recorder {
        if let Err(error) = recorder
            .record_compaction_with_active_user_message_id(
                summary,
                &retained_messages,
                active_user_message_id,
            )
            .await
        {
            let error = AgentRunError::new(
                AgentRunErrorKind::Persistence {
                    message: error.to_string(),
                },
                messages,
                provider_calls,
            );
            emit_error_for_cycle(event_log, config, active_cycle, &error);
            return Err(error);
        }
    }

    *messages = std::iter::once(summary_message)
        .chain(retained_messages)
        .collect();
    emit(
        event_log,
        config,
        "compact.completed",
        json!({
            "message_count": messages.len(),
        }),
    );
    Ok(Some(retained_start))
}

async fn record_context_message(
    recorder: Option<&dyn AgentContextRecorder>,
    message: &Message,
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    messages: &[Message],
    provider_calls: usize,
    active_cycle: Option<&ActiveCycle>,
) -> Result<(), AgentRunError> {
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
}

struct PlaceholderToolResults<'a> {
    tool_calls: &'a [ToolCall],
    prestarted_bash_tool_call_ids: &'a HashSet<String>,
    kind: &'a str,
    text: &'a str,
}

enum ToolExecutionOutcome {
    Inline(ToolResult),
    Detached {
        ack: ToolResult,
        run: Box<DetachedToolRun>,
    },
}

struct DetachedToolRun {
    host: Arc<dyn BackgroundExecutionHost>,
    task_id: String,
    task: NewBackgroundTask,
    tool_call: ToolCall,
    runnable: RunnableToolExecution,
    output_sink: Option<Arc<BoundedTaskOutputSink>>,
    prepublish_interactive_stdio: Option<Arc<PrepublishInteractiveStdioBridge>>,
    cancel: CancellationToken,
    pending: Option<BoxDetachedToolFuture>,
}

impl DetachedToolRun {
    fn cancel(&self) {
        self.cancel.cancel();
    }

    fn publish(&self) -> bool {
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

    fn terminal_to_finish_without_start(
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
        let result = DetachedToolResult {
            tool_result: ToolResult::error(
                self.tool_call.id.clone(),
                self.tool_call.name.clone(),
                reason,
                json!({"kind": kind}),
            ),
            state,
        };
        (
            self.host.clone(),
            self.task_id.clone(),
            self.tool_call.clone(),
            result,
        )
    }
}

struct PrepublishInteractiveStdioBridge {
    inner: Arc<dyn InteractiveStdioBridge>,
    state: Mutex<PrepublishInteractiveStdioState>,
    notify: Notify,
}

struct PrepublishInteractiveStdioState {
    published: bool,
    stdin_writer: Option<Arc<dyn TaskStdinWriter>>,
    events: Vec<BotifiedFrameEvent>,
}

impl PrepublishInteractiveStdioBridge {
    fn new(inner: Arc<dyn InteractiveStdioBridge>) -> Self {
        Self {
            inner,
            state: Mutex::new(PrepublishInteractiveStdioState {
                published: false,
                stdin_writer: None,
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
        let (stdin_writer, events) = {
            let mut state = self
                .state
                .lock()
                .expect("interactive stdio bridge mutex poisoned");
            if state.published {
                return;
            }
            state.published = true;
            (state.stdin_writer.take(), std::mem::take(&mut state.events))
        };
        if let Some(stdin_writer) = stdin_writer {
            self.inner.register_stdin_writer(stdin_writer);
        }
        if !events.is_empty() {
            self.inner.handle_frame_events(events);
        }
    }
}

impl InteractiveStdioBridge for PrepublishInteractiveStdioBridge {
    fn register_stdin_writer(&self, writer: Arc<dyn TaskStdinWriter>) {
        let writer = {
            let mut state = self
                .state
                .lock()
                .expect("interactive stdio bridge mutex poisoned");
            if state.published {
                Some(writer)
            } else {
                state.stdin_writer = Some(writer);
                None
            }
        };
        if let Some(writer) = writer {
            self.inner.register_stdin_writer(writer);
        }
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

type BoxDetachedToolFuture = Pin<Box<dyn Future<Output = DetachedToolResult> + Send>>;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DetachedToolResult {
    pub tool_result: ToolResult,
    pub state: TaskState,
}

#[derive(Clone)]
struct RunnableToolExecution {
    tool: Arc<dyn Tool>,
    tool_call: ToolCall,
    cwd: String,
    provider_transcript_snapshot: Vec<Message>,
    timeout: ToolTimeout,
    output_sink: Option<Arc<dyn ToolOutputSink>>,
    interactive_stdio: Option<Arc<dyn InteractiveStdioBridge>>,
}

enum PreparedToolExecution {
    Ready(ToolResult),
    Runnable(RunnableToolExecution),
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ToolExecutionControls {
    detach_after: Duration,
    timeout: Option<Duration>,
}

const TOOL_TIMEOUT_CLEANUP_GRACE: Duration = Duration::from_secs(1);

fn is_builtin_inline_tool(name: &str) -> bool {
    is_builtin_task_tool(name) || is_registry_tool_name(name)
}

async fn execute_tool_call_with_policy(
    config: &AgentConfig,
    tools: &[Arc<dyn Tool>],
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
        runnable_tool_call,
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

    let ack = detached_ack_tool_result(&tool_call, &task_id, controls, output_sink.as_ref());
    let background_cancel = CancellationToken::new();
    let now = SystemTime::now();
    let timeout_at = controls.timeout.map(|timeout| now + timeout);
    let mut task = NewBackgroundTask::new(
        tool_call.id.clone(),
        tool_call.name.clone(),
        tool_call.arguments_json_string(),
    )
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
    tools: &[Arc<dyn Tool>],
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

    let Some(tool) = tools.iter().find(|tool| tool.spec().name == tool_call.name) else {
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
    tools: &[Arc<dyn Tool>],
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

    let Some(tool) = tools
        .iter()
        .rev()
        .find(|tool| tool.spec().name == tool_call.name)
    else {
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
fn start_detached_tool_run(run: Box<DetachedToolRun>) {
    if !run.publish() {
        run.cancel();
        return;
    }
    start_published_detached_tool_run(run);
}

fn start_published_detached_tool_run(run: Box<DetachedToolRun>) {
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
        let child = tokio::spawn(async move {
            match pending {
                Some(pending) => pending.await,
                None => runnable.execute(cancel).await,
            }
        });
        let result = match child.await {
            Ok(result) => result,
            Err(error) => detached_tool_join_error_result(&tool_call, error),
        };
        host.finish_task(task_id, tool_call, result).await;
    });
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

fn background_task_publish_failed_tool_result(tool_call: &ToolCall) -> ToolResult {
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
        "forced_termination_at": forced_termination_at.map(system_time_rfc3339),
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
            .map(|time| json!(system_time_rfc3339(time)))
            .unwrap_or(Value::Null);
        details["output_tail"] = json!(output.tail);
        details["output_tail_truncated"] = json!(output.output_tail_truncated);
        details["output_artifact_truncated"] = json!(output.output_artifact_truncated);
        details["output_dropped_bytes"] = json!(output.output_dropped_bytes);
    }
    details
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

fn resolve_tool_execution_controls(
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

fn seconds_for_message(duration: Duration) -> String {
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
    }
    tool_call
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
        let message = Message::tool_result(result);
        record_context_message(
            persist.context_recorder,
            &message,
            event_log,
            config,
            messages,
            persist.provider_calls,
            active_cycle,
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

fn emit(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    event_type: &str,
    data: Value,
) -> Option<ServiceEvent> {
    event_log.as_mut().and_then(|log| {
        log.append(
            event_type,
            config.session.as_deref(),
            config.turn_id.as_deref(),
            data,
        )
    })
}

fn fail_if_event_log_failed(
    event_log: &mut Option<AgentEventLog<'_>>,
    messages: &[Message],
    provider_calls: usize,
) -> Result<(), AgentRunError> {
    let Some(log) = event_log.as_mut() else {
        return Ok(());
    };
    let Some(message) = log.take_failure() else {
        return Ok(());
    };
    Err(AgentRunError::new(
        AgentRunErrorKind::Persistence {
            message: format!("timeline persistence failed: {message}"),
        },
        messages,
        provider_calls,
    ))
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

fn profiler_now(profiler: Option<&SharedProfiler>) -> Option<ProfilingTimestamp> {
    profiler.and_then(|profiler| profiler.lock().ok().map(|profiler| profiler.now()))
}

fn write_profile_event_row(profiler: Option<&SharedProfiler>, row: CsvEventRow) {
    let Some(profiler) = profiler else {
        return;
    };
    let Ok(mut profiler) = profiler.lock() else {
        return;
    };
    let _ = profiler.write_event_row(row);
}

fn write_tool_profile_row(
    profiler: Option<&SharedProfiler>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    tool_call: &ToolCall,
    tool_index: usize,
    start: Option<ProfilingTimestamp>,
    result: &ToolResult,
) {
    let Some(start) = start else {
        return;
    };
    let Some(end) = profiler_now(profiler) else {
        return;
    };
    let (event_name, status, success) = tool_profile_status(result);
    let mut row = CsvEventRow::new("tool_call", event_name, status)
        .success(success)
        .timing(start, Some(end))
        .optional_field("session", config.session.as_deref())
        .optional_field("turn_id", config.turn_id.as_deref())
        .field("tool_call_id", &tool_call.id)
        .field("tool_name", &tool_call.name)
        .field("tool_index", tool_index);
    if let Some(active_cycle) = active_cycle {
        row = row.field("cycle_id", &active_cycle.cycle_id);
    }
    write_profile_event_row(profiler, row);
}

fn write_turn_profile_row(
    profiler: Option<&SharedProfiler>,
    config: &AgentConfig,
    start: Option<ProfilingTimestamp>,
    result: &Result<AgentRunResult, AgentRunError>,
) {
    let Some(start) = start else {
        return;
    };
    let Some(end) = profiler_now(profiler) else {
        return;
    };
    let profile = turn_profile_terminal(result);
    let mut row = CsvEventRow::new("turn", profile.event_name, profile.status)
        .success(profile.success)
        .timing(start, Some(end))
        .optional_field("session", config.session.as_deref())
        .optional_field("turn_id", config.turn_id.as_deref())
        .field("provider_call_index", profile.provider_calls);
    if let Some(stop_reason) = profile.stop_reason {
        row = row.field("stop_reason", profile_stop_reason_name(stop_reason));
    }
    if let Some(error_kind) = profile.error_kind {
        row = row.field("error_kind", error_kind);
    }
    write_profile_event_row(profiler, row);
}

struct TurnProfileTerminal {
    event_name: &'static str,
    status: &'static str,
    success: bool,
    stop_reason: Option<StopReason>,
    provider_calls: usize,
    error_kind: Option<String>,
}

fn turn_profile_terminal(result: &Result<AgentRunResult, AgentRunError>) -> TurnProfileTerminal {
    match result {
        Ok(result) => TurnProfileTerminal {
            event_name: "turn.completed",
            status: "ok",
            success: true,
            stop_reason: Some(result.stop_reason),
            provider_calls: result.provider_calls,
            error_kind: None,
        },
        Err(error) => {
            let (event_name, status, error_kind) = match &error.kind {
                AgentRunErrorKind::Cancelled => {
                    ("turn.cancelled", "cancelled", "cancelled".to_owned())
                }
                AgentRunErrorKind::Provider { code, .. } => ("turn.failed", "error", code.clone()),
                AgentRunErrorKind::ProviderStop { .. } => {
                    ("turn.failed", "error", "provider_stop".to_owned())
                }
                AgentRunErrorKind::Persistence { .. } => {
                    ("turn.failed", "error", "persistence".to_owned())
                }
            };
            TurnProfileTerminal {
                event_name,
                status,
                success: false,
                stop_reason: None,
                provider_calls: error.provider_calls,
                error_kind: Some(error_kind),
            }
        }
    }
}

fn tool_profile_status(result: &ToolResult) -> (&'static str, &'static str, bool) {
    if !result.is_error {
        return ("tool.completed", "ok", true);
    }
    let kind = result.details.get("kind").and_then(Value::as_str);
    let timed_out = result
        .details
        .get("timed_out")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    match kind {
        Some("tool_timeout") if timed_out => ("tool.timeout", "timeout", false),
        Some("tool_cancelled" | "tool_aborted") => ("tool.cancelled", "cancelled", false),
        _ => ("tool.failed", "error", false),
    }
}

fn profile_stop_reason_name(stop_reason: StopReason) -> &'static str {
    match stop_reason {
        StopReason::EndTurn => "end_turn",
        StopReason::ToolCalls => "tool_calls",
        StopReason::ToolTerminated => "tool_terminated",
        StopReason::ProviderStop => "provider_stop",
    }
}

fn close_and_replace_active_cycle(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: &mut Option<ActiveCycle>,
    active_cycle_last_stop_reason: &mut Option<StopReason>,
    replacement_cycle: Option<ActiveCycle>,
    provider_calls: usize,
    turn_usage: &mut AgentUsage,
) {
    close_active_cycle_before_replacement(
        event_log,
        config,
        active_cycle.as_ref(),
        provider_calls,
        *active_cycle_last_stop_reason,
        turn_usage,
    );
    *active_cycle = replacement_cycle;
    *active_cycle_last_stop_reason = None;
}

fn close_active_cycle_before_replacement(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    provider_calls: usize,
    stop_reason: Option<StopReason>,
    turn_usage: &mut AgentUsage,
) {
    let Some(active_cycle) = active_cycle else {
        return;
    };

    let usage = std::mem::take(turn_usage);
    emit(
        event_log,
        config,
        "turn.completed",
        add_cycle_data(
            turn_completed_data(
                completed_cycle_provider_calls(Some(active_cycle), provider_calls),
                stop_reason.unwrap_or(StopReason::EndTurn),
                usage,
            ),
            Some(active_cycle),
        ),
    );
}

fn completed_cycle_provider_calls(
    active_cycle: Option<&ActiveCycle>,
    total_provider_calls: usize,
) -> usize {
    active_cycle
        .map(|cycle| cycle.provider_call_index)
        .unwrap_or(total_provider_calls)
}

fn emit_provider_started(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    observation: &ProviderRequestObservation,
    provider_call: usize,
    message_count: usize,
    metadata: Option<&ProviderMetadata>,
) {
    emit(
        event_log,
        config,
        "provider.started",
        provider_lifecycle_data(
            observation,
            metadata,
            json!({
                "provider_call": provider_call,
                "message_count": message_count,
                "status": "running"
            }),
        ),
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_provider_completed(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    observation: &ProviderRequestObservation,
    provider_call: usize,
    duration_ms: u64,
    stop_reason: StopReason,
    usage: Option<Usage>,
    tool_call_count: usize,
    has_text: bool,
    metadata: Option<&ProviderMetadata>,
) {
    emit(
        event_log,
        config,
        "provider.completed",
        provider_lifecycle_data(
            observation,
            metadata,
            json!({
                "provider_call": provider_call,
                "duration_ms": duration_ms,
                "stop_reason": stop_reason,
                "usage": usage_value(usage),
                "tool_call_count": tool_call_count,
                "has_text": has_text,
                "status": "completed"
            }),
        ),
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_provider_failed(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    observation: &ProviderRequestObservation,
    provider_call: usize,
    duration_ms: u64,
    diagnostic: &ProviderErrorDiagnostic,
    metadata: Option<&ProviderMetadata>,
) {
    let mut data = json!({
        "provider_call": provider_call,
        "duration_ms": duration_ms,
        "status": "failed",
        "retryable": diagnostic.retryable,
        "error": diagnostic_error_object(diagnostic)
    });
    if let Some(object) = data.as_object_mut() {
        if let Some(status) = diagnostic.status {
            object.insert("provider_status".to_owned(), json!(status));
        }
    }

    emit(
        event_log,
        config,
        "provider.failed",
        provider_lifecycle_data(observation, metadata, data),
    );
}

fn diagnostic_error_object(diagnostic: &ProviderErrorDiagnostic) -> Value {
    let mut error = json!({
        "code": diagnostic.code,
        "message": diagnostic.message,
        "retryable": diagnostic.retryable,
    });
    if let Some(object) = error.as_object_mut() {
        if let Some(status) = diagnostic.status {
            object.insert("status".to_owned(), json!(status));
        }
        if let Some(provider_code) = diagnostic.provider_code.as_deref() {
            object.insert("provider_code".to_owned(), json!(provider_code));
        }
    }
    error
}

fn provider_lifecycle_data(
    observation: &ProviderRequestObservation,
    metadata: Option<&ProviderMetadata>,
    mut data: Value,
) -> Value {
    if let Some(object) = data.as_object_mut() {
        object.insert(
            "provider_request_id".to_owned(),
            json!(observation.provider_request_id.as_str()),
        );
        object.insert(
            "provider_call_index".to_owned(),
            json!(observation.provider_call_index),
        );
        insert_provider_metadata(object, metadata);
        if let Some(cycle_id) = observation.cycle_id.as_deref() {
            object.insert("cycle_id".to_owned(), json!(cycle_id));
        }
    }
    data
}

fn insert_provider_metadata(
    object: &mut serde_json::Map<String, Value>,
    metadata: Option<&ProviderMetadata>,
) {
    let Some(metadata) = metadata.and_then(ProviderMetadata::sanitized) else {
        object.insert("provider".to_owned(), json!("unknown"));
        object.insert("model".to_owned(), Value::Null);
        return;
    };

    object.insert("provider".to_owned(), json!(metadata.profile.clone()));
    object.insert("profile".to_owned(), json!(metadata.profile));
    object.insert(
        "name".to_owned(),
        metadata.name.map(Value::String).unwrap_or(Value::Null),
    );
    object.insert(
        "model".to_owned(),
        metadata.model.map(Value::String).unwrap_or(Value::Null),
    );
    object.insert(
        "capabilities".to_owned(),
        json!(metadata
            .capabilities
            .iter()
            .map(|capability| capability.as_str())
            .collect::<Vec<_>>()),
    );
}

fn usage_value(usage: Option<Usage>) -> Value {
    usage
        .map(|usage| {
            json!({
                "input": usage.input_tokens,
                "cached_input": usage.cached_input_tokens,
                "output": usage.output_tokens,
                "reasoning_output": usage.reasoning_output_tokens,
                "total": usage.total_tokens
            })
        })
        .unwrap_or(Value::Null)
}

fn turn_completed_data(provider_calls: usize, stop_reason: StopReason, usage: AgentUsage) -> Value {
    json!({
        "provider_calls": provider_calls,
        "provider_request_count": provider_calls,
        "stop_reason": stop_reason,
        "usage": {
            "input": usage.input_tokens,
            "cached_input": usage.cached_input_tokens,
            "output": usage.output_tokens,
            "reasoning_output": usage.reasoning_output_tokens,
        }
    })
}

fn add_cycle_data(mut data: Value, active_cycle: Option<&ActiveCycle>) -> Value {
    if let (Some(object), Some(active_cycle)) = (data.as_object_mut(), active_cycle) {
        object.insert("cycle_id".to_owned(), json!(active_cycle.cycle_id.clone()));
        object.insert(
            "input_ids".to_owned(),
            json!(active_cycle.input_ids.clone()),
        );
        object.insert(
            "input_sources".to_owned(),
            json!(active_cycle.input_sources.clone()),
        );
        object.insert(
            "input_urgencies".to_owned(),
            json!(active_cycle.input_urgencies.clone()),
        );
        object.insert(
            "input_previews".to_owned(),
            json!(active_cycle.input_previews.clone()),
        );
        object.insert("queue_length".to_owned(), json!(active_cycle.queue_length));
    }
    data
}

fn add_cycle_id(mut data: Value, cycle_id: Option<&str>) -> Value {
    if let (Some(object), Some(cycle_id)) = (data.as_object_mut(), cycle_id) {
        object.insert("cycle_id".to_owned(), json!(cycle_id));
    }
    data
}

fn elapsed_millis(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn emit_error(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    error: &AgentRunError,
) {
    emit_error_with_cycle(event_log, config, None, error);
}

fn emit_error_for_cycle(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    error: &AgentRunError,
) {
    emit_error_with_cycle(event_log, config, active_cycle, error);
}

fn emit_error_with_cycle(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    error: &AgentRunError,
) {
    emit(
        event_log,
        config,
        "agent.error",
        add_cycle_data(error_event_data(error), active_cycle),
    );
}

fn emit_aborted(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    error: &AgentRunError,
) {
    emit_aborted_with_cycle(event_log, config, None, error);
}

fn emit_aborted_for_cycle(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    error: &AgentRunError,
) {
    emit_aborted_with_cycle(event_log, config, active_cycle, error);
}

fn emit_aborted_with_cycle(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    error: &AgentRunError,
) {
    emit(
        event_log,
        config,
        "agent.aborted",
        add_cycle_data(error_event_data(error), active_cycle),
    );
}

fn error_event_data(error: &AgentRunError) -> Value {
    let diagnostic = agent_error_diagnostic(&error.kind);
    let message = error.to_string();
    let mut error_object = json!({
        "code": diagnostic.code,
        "message": message,
        "retryable": diagnostic.retryable
    });
    if let Some(object) = error_object.as_object_mut() {
        if let Some(status) = diagnostic.status {
            object.insert("status".to_owned(), json!(status));
        }
        if let Some(provider_code) = diagnostic.provider_code.as_deref() {
            object.insert("provider_code".to_owned(), json!(provider_code));
        }
    }

    let mut data = json!({
        "message": message,
        "error": error_object,
        "retryable": diagnostic.retryable
    });
    if let Some(object) = data.as_object_mut() {
        if let Some(status) = diagnostic.status {
            object.insert("status".to_owned(), json!(status));
        }
    }
    data
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ErrorEventDiagnostic {
    code: String,
    retryable: bool,
    status: Option<u16>,
    provider_code: Option<String>,
}

impl ErrorEventDiagnostic {
    fn new(code: &str, retryable: bool) -> Self {
        Self {
            code: code.to_owned(),
            retryable,
            status: None,
            provider_code: None,
        }
    }
}

fn agent_error_diagnostic(kind: &AgentRunErrorKind) -> ErrorEventDiagnostic {
    match kind {
        AgentRunErrorKind::Cancelled => ErrorEventDiagnostic::new("cancelled", true),
        AgentRunErrorKind::Provider {
            code,
            retryable,
            status,
            provider_code,
            ..
        } => ErrorEventDiagnostic {
            code: code.clone(),
            retryable: *retryable,
            status: *status,
            provider_code: provider_code.clone(),
        },
        AgentRunErrorKind::ProviderStop { .. } => ErrorEventDiagnostic::new("provider_stop", false),
        AgentRunErrorKind::Persistence { .. } => {
            ErrorEventDiagnostic::new("persistence_error", false)
        }
    }
}

fn emit_tool_started(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    tool_call: &ToolCall,
) {
    emit(
        event_log,
        config,
        "tool.started",
        add_cycle_id(
            json!({
                "tool_call_id": tool_call.id,
                "tool_name": tool_call.name
            }),
            active_cycle.map(|cycle| cycle.cycle_id.as_str()),
        ),
    );
}

fn emit_bash_command_execution_started(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    tool_call: &ToolCall,
    background_detach_candidate: bool,
    inline_replay_started: bool,
) {
    let Some(command) = bash_command(tool_call) else {
        return;
    };
    emit(
        event_log,
        config,
        "tool.started",
        add_cycle_id(
            json!({
                "tool_call_id": tool_call.id,
                "tool_name": tool_call.name,
                "command": command,
                "aggregated_output": "",
                "exit_code": Value::Null,
                "status": "in_progress",
                "background_detach_candidate": background_detach_candidate,
                "inline_replay_started": inline_replay_started
            }),
            active_cycle.map(|cycle| cycle.cycle_id.as_str()),
        ),
    );
}

fn emit_tool_completed(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    tool_call: &ToolCall,
    result: &ToolResult,
    detached_ack: bool,
) {
    let mut data = add_cycle_id(
        json!({
        "tool_call_id": result.tool_call_id,
        "tool_name": result.tool_name,
        "is_error": result.is_error,
        "detached_ack": detached_ack
        }),
        active_cycle.map(|cycle| cycle.cycle_id.as_str()),
    );
    if !detached_ack {
        if let Some(command) = bash_command(tool_call) {
            let exit_code = bash_exit_code(result);
            let status = if !result.is_error && exit_code == Some(0) {
                "completed"
            } else {
                "failed"
            };
            data["command"] = json!(command);
            data["aggregated_output"] = json!(bash_aggregated_output(result));
            data["exit_code"] = json!(exit_code);
            data["status"] = json!(status);
        }
    }
    emit(event_log, config, "tool.completed", data);
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

fn bash_aggregated_output(result: &ToolResult) -> &str {
    result
        .details
        .get("aggregated_output")
        .and_then(Value::as_str)
        .unwrap_or(result.text.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::tools::ToolSpec;

    #[test]
    fn detached_ack_proves_running_identity_without_promising_completion() {
        let result = detached_ack_tool_result(
            &ToolCall::new("call_detached", "bash", json!({"command":"sleep 30"})),
            "task_detached",
            ToolExecutionControls {
                detach_after: Duration::ZERO,
                timeout: Some(Duration::from_secs(60)),
            },
            None,
        );

        assert!(result
            .text
            .contains("proves only running state and task identity"));
        assert!(result
            .text
            .contains("not success, completion, readiness, usable output, or callback delivery"));
        assert!(result
            .text
            .contains("Any terminal callback is best-effort."));
        assert!(!result.text.contains("The final result will arrive"));
    }

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
}
