pub mod agent_events;
pub mod agent_loop;
pub mod attachments;
pub mod compact;
pub mod config;
pub mod context_files;
pub mod event;
pub mod files;
pub mod http;
pub mod llm_text_preview;
pub mod message_render;
pub mod path_utils;
pub mod profiling;
pub mod provider;
pub mod registry;
pub mod registry_protocol;
pub mod service;
pub mod session;
pub mod skills;
pub mod subagents;
pub mod system_prompt;
pub mod task_observer;
pub mod tasks;
pub mod timeline;
pub mod timeline_store;
pub mod tools;
pub mod transcript;
pub mod types;

pub use agent_events::{AgentUsage, CommandExecutionStatus, EventError, ThreadEvent, ThreadItem};
pub use agent_loop::{
    run_agent, run_agent_with_input_drainer, AcceptedInputEntry, AgentCommitError, AgentConfig,
    AgentContextRecorder, AgentInputDrainer, AgentRunError, AgentRunErrorKind, AgentRunResult,
    DrainBatch, DrainedMessage, InputSource, InputUrgency, PromptRefreshConfig,
    QueuedInputMetadata, ToolExecutionPolicy,
};
pub use attachments::{
    parse_user_input, AttachmentError, ParsedUserInput, PublicInputItem, MAX_IMAGE_BASE64_BYTES,
};
pub use compact::{
    CompactConfig, DEFAULT_COMPACT_KEEP_RECENT_TOKENS, DEFAULT_COMPACT_THRESHOLD_TOKENS,
};
pub use context_files::{
    load_context_files, ContextFile, ContextFileLoadConfig, LoadedContextFiles,
};
pub use event::{
    redact_event_data, EventCursor, EventLog, EventReadError, EventReadWindow, ServiceEvent,
    DEFAULT_EVENT_LOG_CAPACITY,
};
pub use files::{
    ExternalFileMetadata, FileDownload, FileRecord, FileSource, FileStore, FileStoreError,
    FileStoreErrorKind, FileStoreOptions,
};
pub use llm_text_preview::{
    LlmTextPreviewFrame, LlmTextPreviewHub, LlmTextPreviewMetadata, LlmTextPreviewSink,
    LlmTextPreviewSubscription, ProviderPreviewContext,
};
pub use message_render::{render_file_manifest, render_messages_for_provider};
pub use provider::{
    router::{ProviderCapability, ProviderEndpoint, ProviderRouter},
    Provider, ProviderError, ProviderRequest, ProviderResponse,
};
pub use registry::{
    RegistryConfig, RegistryError, RegistryHistoryResult, RegistryItem, RegistryQuery,
    RegistryQueryResult, RegistrySetAck, RegistrySetRequest, RegistryStore, RegistryTopicSummary,
    RegistryTtl, RegistryWriterKind,
};
pub use service::{
    EnqueueOutcome, EnqueueSubmitStatus, Service, ServiceError, ServiceLimits, ServiceState,
    ServiceStatus, ServiceSubagentOptions, DEFAULT_MAX_QUEUE_MESSAGES,
};
pub use session::{
    encode_session_name, open_or_create_session, open_or_create_session_in_home,
    DurableMessageCursor, FileSessionRecorder, OpenedSession, SessionError, SessionRestartBoundary,
    DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW,
};
pub use skills::{
    load_skills, try_load_skills, LoadedSkills, Skill, SkillLoadConfig, SkillLoadError,
    SkillLocation,
};
pub use subagents::{
    SubagentLifecycle, SubagentLimits, SubagentManager, SubagentManagerError, SubagentRunState,
    SubagentSnapshot, SubagentTailEntry, SubagentTailKind,
};
pub use system_prompt::{
    build_system_prompt, build_system_prompt_with_capabilities, render_available_skills_context,
    render_available_skills_context_report, render_explicit_skill_context,
    render_runtime_environment_context, AvailableSkillsRenderReport, PromptCapabilities,
    RuntimeEnvironmentContext,
};
pub use task_observer::{
    FinalTextObservation, FinalTextObservationKind, TaskConversationObserver, TaskObserveMode,
    TaskObserverDiagnostic,
};
pub use tasks::{
    task_exception_frame, task_response_frame, BackgroundTaskManager, BotifiedFrameEvent,
    BotifiedFrameScan, BotifiedFrameScanner, BoundedTaskOutputSink, CallbackDelivery,
    NewBackgroundTask, SharedTaskStdinWriter, TaskCallbackPayloadSnapshot, TaskCancelTool,
    TaskFrameDiagnostic, TaskListTool, TaskOutputPolicy, TaskOutputSnapshot, TaskOutputUpdate,
    TaskRegistryGetFrame, TaskRegistrySetFrame, TaskReplyOutcome, TaskReplyStatus,
    TaskRequestAdmission, TaskRequestFrame, TaskRequestSnapshot, TaskRequestState, TaskSnapshot,
    TaskState, TaskStdinWriter,
};
pub use timeline::{
    TimelineEnvelope, TimelineEnvelopeError, TimelineItem, TimelineTrace, TIMELINE_VERSION,
};
pub use tools::{
    BashTool, FilePublicationSink, PublishFileTool, Tool, ToolError, ToolExecutionContext,
    ToolOutputSink, ToolOutputSnapshot, ToolSpec, ToolTimeout, ViewImageTool,
    PUBLISH_FILE_TOOL_NAME,
};
pub use transcript::{
    repair_provider_transcript, validate_provider_model_input, validate_provider_transcript,
    TranscriptError,
};
pub use types::{
    AssistantMessageReplay, ContentPart, ContextRole, Message, MessageFileBinding, ModelInput,
    StopReason, ToolCall, ToolResult, Usage,
};
