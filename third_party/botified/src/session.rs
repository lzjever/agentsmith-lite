use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::agent_events::ThreadEvent;
use crate::agent_loop::{
    AcceptedInputEntry, AgentCommitError, AgentContextRecorder, DrainedMessage, InputSource,
    InputUrgency, QueuedInputMetadata,
};
use crate::types::{ContentPart, Message, StopReason, ToolResult};

mod checkpoint;
mod open;
mod replay;
mod writer;

pub use open::{
    open_or_create_session, open_or_create_session_in_home,
    open_or_create_session_in_home_with_cwd, open_or_create_session_with_cwd,
};
pub(crate) use writer::{AcceptedInputUndo, SessionFileIo};

const SESSION_VERSION: u32 = 1;
pub const DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW: usize = 1024;

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("session name must not be empty")]
    EmptyName,
    #[error("failed to access session file {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid session header in {path}: {message}")]
    BadHeader { path: PathBuf, message: String },
    #[error("invalid session entry in {path} at line {line}: {message}")]
    BadEntry {
        path: PathBuf,
        line: usize,
        message: String,
    },
    #[error("session storage state is ambiguous for {path}: {message}")]
    AmbiguousStorage { path: PathBuf, message: String },
}

#[derive(Debug, Clone)]
pub struct OpenedSession {
    name: String,
    path: PathBuf,
    initial_messages: Vec<Message>,
    pending_messages: Vec<DrainedMessage>,
    known_user_messages: Vec<DrainedMessage>,
    message_cursors: Vec<DurableMessageCursor>,
    pending_delivery_intents: Vec<CallbackDeliveryIntent>,
    restart_boundary: Option<SessionRestartBoundary>,
    warnings: Vec<String>,
    recorder: Arc<FileSessionRecorder>,
}

#[derive(Debug, Clone, Default)]
pub struct SessionReplay {
    pub initial_context: Vec<Message>,
    pub pending_messages: Vec<DrainedMessage>,
    pub known_user_messages: Vec<DrainedMessage>,
    pub message_cursors: Vec<DurableMessageCursor>,
    pub restart_boundary: Option<SessionRestartBoundary>,
    pub pending_delivery_intents: Vec<CallbackDeliveryIntent>,
}

impl OpenedSession {
    pub fn replay(&self) -> SessionReplay {
        SessionReplay {
            initial_context: self.initial_messages.clone(),
            pending_messages: self.pending_messages.clone(),
            known_user_messages: self.known_user_messages.clone(),
            message_cursors: self.message_cursors.clone(),
            restart_boundary: self.restart_boundary.clone(),
            pending_delivery_intents: self.pending_delivery_intents.clone(),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn initial_messages(&self) -> &[Message] {
        &self.initial_messages
    }

    pub fn pending_messages(&self) -> &[DrainedMessage] {
        &self.pending_messages
    }

    pub fn known_user_messages(&self) -> &[DrainedMessage] {
        &self.known_user_messages
    }

    pub fn message_cursors(&self) -> &[DurableMessageCursor] {
        &self.message_cursors
    }

    pub fn pending_delivery_intents(&self) -> &[CallbackDeliveryIntent] {
        &self.pending_delivery_intents
    }

    pub fn restart_boundary(&self) -> Option<&SessionRestartBoundary> {
        self.restart_boundary.as_ref()
    }

    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    pub fn recorder(&self) -> Arc<FileSessionRecorder> {
        self.recorder.clone()
    }

    pub fn discard_unfinished_sync(&mut self) -> Result<(), SessionError> {
        let mut message_ids = self
            .pending_messages
            .iter()
            .map(|message| message.id.clone())
            .collect::<Vec<_>>();
        if let Some(boundary) = self.restart_boundary.as_ref() {
            for message_id in boundary.active_input_ids() {
                if !message_ids.contains(message_id) {
                    message_ids.push(message_id.clone());
                }
            }
        }
        let projection_ids = self
            .pending_delivery_intents
            .iter()
            .map(|intent| intent.projection_id.clone())
            .collect::<Vec<_>>();
        if message_ids.is_empty() && projection_ids.is_empty() && self.restart_boundary.is_none() {
            return Ok(());
        }

        self.recorder.record_unfinished_work_discarded_sync(
            &message_ids,
            &projection_ids,
            "resume_unfinished_disabled",
        )?;
        if let Some(boundary) = self.restart_boundary.as_ref() {
            self.initial_messages
                .truncate(boundary.current_request_start(&self.initial_messages));
        }
        self.pending_messages.clear();
        self.known_user_messages
            .retain(|message| !message_ids.contains(&message.id));
        self.message_cursors
            .retain(|cursor| !message_ids.contains(&cursor.message_id));
        self.pending_delivery_intents.clear();
        self.restart_boundary = None;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRestartBoundary {
    active_input_ids: Vec<String>,
    active_user_message_index: Option<usize>,
}

impl SessionRestartBoundary {
    pub(crate) fn with_active_input_ids_and_active_user_message_index(
        active_input_ids: Vec<String>,
        active_user_message_index: Option<usize>,
    ) -> Self {
        assert!(
            !active_input_ids.is_empty(),
            "restart boundary must contain at least one active input id"
        );
        Self {
            active_input_ids,
            active_user_message_index,
        }
    }

    pub fn active_user_message_id(&self) -> &str {
        self.active_input_ids
            .first()
            .expect("restart boundary has an active input id")
    }

    pub fn active_input_ids(&self) -> &[String] {
        &self.active_input_ids
    }

    pub(crate) fn contains_active_input_id(&self, message_id: &str) -> bool {
        self.active_input_ids
            .iter()
            .any(|active_id| active_id == message_id)
    }

    pub fn current_request_start(&self, initial_messages: &[Message]) -> usize {
        self.active_user_message_index
            .filter(|index| {
                initial_messages
                    .get(*index)
                    .is_some_and(|message| matches!(message, Message::User { .. }))
            })
            .unwrap_or(initial_messages.len())
    }

    pub(crate) fn current_request_start_or_context_start(
        &self,
        initial_messages: &[Message],
    ) -> usize {
        self.active_user_message_index
            .filter(|index| {
                initial_messages
                    .get(*index)
                    .is_some_and(|message| matches!(message, Message::User { .. }))
            })
            .unwrap_or(0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DurableMessageCursor {
    pub message_id: String,
    #[serde(alias = "cursor_seq")]
    pub replay_start_seq: u64,
    #[serde(default)]
    pub terminal_seq: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replay_events: Vec<ThreadEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallbackDeliveryEventType {
    #[serde(rename = "task.callback_delivered")]
    TaskDelivered,
    #[serde(rename = "subagent.callback_delivered")]
    SubagentDelivered,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CallbackDeliveryIntent {
    pub projection_id: String,
    pub event_type: CallbackDeliveryEventType,
    pub data: Value,
}

impl CallbackDeliveryIntent {
    pub fn projection_id_for_input(input_id: &str) -> String {
        format!("callback-delivered:{input_id}")
    }
}

#[derive(Debug, Clone, Default)]
struct LoadedSession {
    initial_messages: Vec<Message>,
    pending_messages: Vec<DrainedMessage>,
    known_user_messages: Vec<DrainedMessage>,
    message_cursors: Vec<DurableMessageCursor>,
    pending_delivery_intents: Vec<CallbackDeliveryIntent>,
    restart_boundary: Option<SessionRestartBoundary>,
    warnings: Vec<String>,
}

pub(crate) fn retain_recent_known_user_messages_for_replay(
    mut known_user_messages: Vec<DrainedMessage>,
    pending_messages: &[DrainedMessage],
    retained_window: usize,
    protected_message_ids: &[String],
) -> Vec<DrainedMessage> {
    let pending_ids = pending_messages
        .iter()
        .map(|message| message.id.clone())
        .collect::<HashSet<_>>();
    let mut retained_ids = pending_ids.clone();
    retained_ids.extend(protected_message_ids.iter().cloned());
    let mut retained_recent = 0usize;

    for message in known_user_messages.iter().rev() {
        if retained_ids.contains(&message.id) {
            continue;
        }
        if retained_recent < retained_window {
            retained_ids.insert(message.id.clone());
            retained_recent += 1;
        }
    }

    known_user_messages.retain(|message| retained_ids.contains(&message.id));
    known_user_messages
}

pub(crate) fn retain_recent_message_cursors_for_replay(
    mut message_cursors: Vec<DurableMessageCursor>,
    retained_window: usize,
) -> Vec<DurableMessageCursor> {
    let remove_count = message_cursors.len().saturating_sub(retained_window);
    if remove_count > 0 {
        message_cursors.drain(0..remove_count);
    }
    message_cursors
}

pub struct FileSessionRecorder {
    path: PathBuf,
    shared: Arc<SharedSessionPath>,
    filesystem_backed: bool,
}

struct SharedSessionPath {
    path_lock: Arc<Mutex<()>>,
    append: Mutex<SessionAppendState>,
}

pub(super) struct SessionAppendState {
    pub(super) file: Box<dyn SessionFileIo>,
    pub(super) compaction_poisoned: bool,
}

impl std::fmt::Debug for FileSessionRecorder {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FileSessionRecorder")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

fn session_path_lock(path: &Path) -> Arc<Mutex<()>> {
    static PATH_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let locks = PATH_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let key = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut locks = locks.lock().expect("session path lock map poisoned");
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

fn normalized_session_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

fn shared_session_paths() -> &'static Mutex<HashMap<PathBuf, Weak<SharedSessionPath>>> {
    static PATHS: OnceLock<Mutex<HashMap<PathBuf, Weak<SharedSessionPath>>>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn existing_shared_session_path(path: &Path) -> Option<Arc<SharedSessionPath>> {
    let key = normalized_session_path(path);
    let mut paths = shared_session_paths()
        .lock()
        .expect("shared session path map poisoned");
    paths.retain(|_, state| state.strong_count() > 0);
    paths.get(&key).and_then(Weak::upgrade)
}

fn shared_session_path(
    path: &Path,
    file: File,
    path_lock: Arc<Mutex<()>>,
) -> Arc<SharedSessionPath> {
    let key = normalized_session_path(path);
    let mut paths = shared_session_paths()
        .lock()
        .expect("shared session path map poisoned");
    paths.retain(|_, state| state.strong_count() > 0);
    if let Some(state) = paths.get(&key).and_then(Weak::upgrade) {
        return state;
    }
    let state = Arc::new(SharedSessionPath {
        path_lock,
        append: Mutex::new(SessionAppendState {
            file: Box::new(file),
            compaction_poisoned: false,
        }),
    });
    paths.insert(key, Arc::downgrade(&state));
    state
}

impl FileSessionRecorder {
    fn new(path: PathBuf, shared: Arc<SharedSessionPath>) -> Self {
        Self {
            path,
            shared,
            filesystem_backed: true,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test_with_writer(
        path: PathBuf,
        writer: impl SessionFileIo + 'static,
    ) -> Self {
        let path_lock = session_path_lock(&path);
        Self {
            path,
            shared: Arc::new(SharedSessionPath {
                path_lock,
                append: Mutex::new(SessionAppendState {
                    file: Box::new(writer),
                    compaction_poisoned: false,
                }),
            }),
            filesystem_backed: false,
        }
    }

    #[cfg(test)]
    fn clone_for_test(&self) -> Self {
        Self {
            path: self.path.clone(),
            shared: Arc::clone(&self.shared),
            filesystem_backed: self.filesystem_backed,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn validate_delivery_intents(
    path: &Path,
    line: usize,
    intents: &[CallbackDeliveryIntent],
) -> Result<(), SessionError> {
    let projection_ids = intents
        .iter()
        .map(|intent| intent.projection_id.clone())
        .collect::<Vec<_>>();
    validate_projection_ids(path, line, &projection_ids)
}

fn validate_projection_ids(
    path: &Path,
    line: usize,
    projection_ids: &[String],
) -> Result<(), SessionError> {
    let mut unique = HashSet::with_capacity(projection_ids.len());
    for projection_id in projection_ids {
        if projection_id.is_empty() {
            return Err(SessionError::BadEntry {
                path: path.to_path_buf(),
                line,
                message: "callback delivery projection_id must not be empty".to_owned(),
            });
        }
        if !unique.insert(projection_id) {
            return Err(SessionError::BadEntry {
                path: path.to_path_buf(),
                line,
                message: "callback delivery projection_ids must be unique within an entry"
                    .to_owned(),
            });
        }
    }
    Ok(())
}

fn serialize_session_line(path: &Path, entry: &SessionLine) -> Result<String, SessionError> {
    serde_json::to_string(entry).map_err(|error| SessionError::BadEntry {
        path: path.to_path_buf(),
        line: 0,
        message: error.to_string(),
    })
}

#[async_trait]
impl AgentContextRecorder for FileSessionRecorder {
    async fn record_message(&self, message: &Message) -> Result<(), AgentCommitError> {
        self.record_message_sync(message)
            .map_err(|error| AgentCommitError::new(error.to_string()))
    }

    async fn record_accepted_input(
        &self,
        entry: &AcceptedInputEntry,
    ) -> Result<(), AgentCommitError> {
        self.record_accepted_input_sync(entry)
            .map_err(|error| AgentCommitError::new(error.to_string()))
    }

    async fn record_pending_input_removed(
        &self,
        message_id: &str,
        source: InputSource,
        metadata: Option<&QueuedInputMetadata>,
        reason: &str,
    ) -> Result<(), AgentCommitError> {
        self.record_pending_input_removed_sync(message_id, source, metadata.cloned(), reason)
            .map_err(|error| AgentCommitError::new(error.to_string()))
    }

    async fn record_user_batch(&self, messages: &[Message]) -> Result<(), AgentCommitError> {
        self.record_user_batch_sync(messages)
            .map_err(|error| AgentCommitError::new(error.to_string()))
    }

    async fn record_user_batch_with_ids(
        &self,
        messages: &[Message],
        message_ids: &[String],
    ) -> Result<(), AgentCommitError> {
        self.record_user_batch_with_ids_sync(messages, message_ids)
            .map_err(|error| AgentCommitError::new(error.to_string()))
    }

    async fn record_compaction(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
    ) -> Result<(), AgentCommitError> {
        self.record_compaction_with_metadata_sync(summary, retained_messages, None)
            .map_err(|error| AgentCommitError::new(error.to_string()))
    }

    async fn record_compaction_with_metadata(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        metadata: Option<&CompactionMetadata>,
    ) -> Result<(), AgentCommitError> {
        self.record_compaction_with_metadata_sync(summary, retained_messages, metadata)
            .map_err(|error| AgentCommitError::new(error.to_string()))
    }

    async fn record_compaction_with_active_user_message_id(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        active_user_message_id: Option<&str>,
    ) -> Result<(), AgentCommitError> {
        self.record_compaction_with_active_user_message_id_and_metadata_sync(
            summary,
            retained_messages,
            active_user_message_id,
            None,
        )
        .map_err(|error| AgentCommitError::new(error.to_string()))
    }

    async fn record_compaction_with_active_user_message_id_and_metadata(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        active_user_message_id: Option<&str>,
        metadata: Option<&CompactionMetadata>,
    ) -> Result<(), AgentCommitError> {
        self.record_compaction_with_active_user_message_id_and_metadata_sync(
            summary,
            retained_messages,
            active_user_message_id,
            metadata,
        )
        .map_err(|error| AgentCommitError::new(error.to_string()))
    }
}

fn sync_session_parent_dir(path: &Path) -> Result<(), SessionError> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let dir = File::open(parent).map_err(|source| SessionError::Io {
        path: parent.to_path_buf(),
        source,
    })?;
    dir.sync_data().map_err(|source| SessionError::Io {
        path: parent.to_path_buf(),
        source,
    })
}

pub fn encode_session_name(name: &str) -> String {
    let mut encoded = String::new();
    for byte in name.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                encoded.push(char::from(*byte));
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CompactionMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default)]
    pub degraded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_request_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_usable_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SessionLine {
    #[serde(rename = "session")]
    Header {
        version: u32,
        name: String,
        created_at: u64,
        cwd: String,
    },
    AcceptedInput {
        message_id: String,
        cursor_seq: u64,
        source: InputSource,
        urgency: InputUrgency,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<QueuedInputMetadata>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delivery: Option<crate::agent_loop::MessageDelivery>,
        content: Vec<ContentPart>,
    },
    UserMessage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        message: Message,
    },
    UserBatch {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_ids: Option<Vec<String>>,
        messages: Vec<Message>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        delivery_intents: Vec<CallbackDeliveryIntent>,
    },
    DeliveryProjected {
        projection_ids: Vec<String>,
    },
    AssistantMessage {
        message: Message,
    },
    ToolResult {
        result: ToolResult,
    },
    PendingInputRemoved {
        message_id: String,
        #[serde(default, skip_serializing_if = "InputSource::is_user")]
        source: InputSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<QueuedInputMetadata>,
        reason: String,
    },
    UnfinishedWorkDiscarded {
        message_ids: Vec<String>,
        projection_ids: Vec<String>,
        reason: String,
    },
    Compaction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_user_message_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_input_ids: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_user_message_index: Option<usize>,
        summary: Vec<ContentPart>,
        #[serde(default)]
        retained_messages: Vec<Message>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<CompactionMetadata>,
    },
    MessageCursor {
        message_id: String,
        #[serde(alias = "cursor_seq")]
        replay_start_seq: u64,
        #[serde(default)]
        terminal_seq: u64,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        replay_events: Vec<ThreadEvent>,
    },
}

#[cfg(test)]
mod durable_ack_boundary_tests {
    use super::open::{
        append_session_newline_with_writer, truncate_session_file_with_writer,
        write_session_header_with_writer,
    };
    use super::*;
    use crate::agent_loop::AgentConfig;
    use crate::provider::{Provider, ProviderError, ProviderRequest, ProviderResponse};
    use crate::service::{Service, ServiceLimits, ServiceState};
    use crate::tools::{Tool, ToolError, ToolExecutionContext, ToolSpec};
    use crate::types::ToolCall;
    use std::io;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio_util::sync::CancellationToken;

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum SpyFileOp {
        Write,
        Flush,
        SyncData,
        SyncParentDir,
        Truncate,
    }

    #[derive(Clone, Default)]
    struct SpySessionFile {
        state: Arc<Mutex<SpySessionFileState>>,
    }

    #[derive(Default)]
    struct SpySessionFileState {
        ops: Vec<SpyFileOp>,
        bytes: Vec<u8>,
        fail_write: usize,
        fail_flush: usize,
        fail_sync_data: usize,
        fail_set_len: usize,
        fail_assistant_tool_call_sync_data: bool,
        assistant_tool_call_sync_failure_armed: bool,
    }

    impl SpySessionFile {
        fn with_assistant_tool_call_sync_data_failure() -> Self {
            let file = Self::default();
            file.state
                .lock()
                .expect("spy state mutex poisoned")
                .fail_assistant_tool_call_sync_data = true;
            file
        }

        fn with_write_failure() -> Self {
            let file = Self::default();
            file.state
                .lock()
                .expect("spy state mutex poisoned")
                .fail_write = 1;
            file
        }

        fn with_flush_failure() -> Self {
            let file = Self::default();
            file.state
                .lock()
                .expect("spy state mutex poisoned")
                .fail_flush = 1;
            file
        }

        fn with_sync_data_failure() -> Self {
            let file = Self::default();
            file.state
                .lock()
                .expect("spy state mutex poisoned")
                .fail_sync_data = 1;
            file
        }

        fn with_sync_data_and_truncate_failure() -> Self {
            let file = Self::with_sync_data_failure();
            file.state
                .lock()
                .expect("spy state mutex poisoned")
                .fail_set_len = 1;
            file
        }

        fn from_bytes(bytes: Vec<u8>) -> Self {
            Self {
                state: Arc::new(Mutex::new(SpySessionFileState {
                    bytes,
                    ..SpySessionFileState::default()
                })),
            }
        }

        fn from_bytes_with_sync_data_failure(bytes: Vec<u8>) -> Self {
            let file = Self::from_bytes(bytes);
            file.state
                .lock()
                .expect("spy state mutex poisoned")
                .fail_sync_data = 1;
            file
        }

        fn from_bytes_with_sync_data_and_truncate_failure(bytes: Vec<u8>) -> Self {
            let file = Self::from_bytes_with_sync_data_failure(bytes);
            file.state
                .lock()
                .expect("spy state mutex poisoned")
                .fail_set_len = 1;
            file
        }

        fn bytes(&self) -> Vec<u8> {
            self.state
                .lock()
                .expect("spy state mutex poisoned")
                .bytes
                .clone()
        }

        fn operations(&self) -> Vec<SpyFileOp> {
            self.state
                .lock()
                .expect("spy state mutex poisoned")
                .ops
                .clone()
        }

        fn sync_parent_dir(&self) -> io::Result<()> {
            self.state
                .lock()
                .expect("spy state mutex poisoned")
                .ops
                .push(SpyFileOp::SyncParentDir);
            Ok(())
        }
    }

    impl SessionFileIo for SpySessionFile {
        fn len(&mut self) -> io::Result<u64> {
            Ok(self
                .state
                .lock()
                .expect("spy state mutex poisoned")
                .bytes
                .len() as u64)
        }

        fn write_line(&mut self, line: &str) -> io::Result<()> {
            let mut state = self.state.lock().expect("spy state mutex poisoned");
            state.ops.push(SpyFileOp::Write);
            state.bytes.extend_from_slice(line.as_bytes());
            state.bytes.push(b'\n');
            if state.fail_assistant_tool_call_sync_data
                && serde_json::from_str::<Value>(line).is_ok_and(|record| {
                    record["type"] == "assistant_message"
                        && record["message"]["tool_calls"]
                            .as_array()
                            .is_some_and(|tool_calls| !tool_calls.is_empty())
                })
            {
                state.assistant_tool_call_sync_failure_armed = true;
            }
            if state.fail_write > 0 {
                state.fail_write -= 1;
                return Err(io::Error::other("write_line failed"));
            }
            Ok(())
        }

        fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
            let mut state = self.state.lock().expect("spy state mutex poisoned");
            state.ops.push(SpyFileOp::Write);
            state.bytes.extend_from_slice(bytes);
            Ok(())
        }

        fn flush(&mut self) -> io::Result<()> {
            let mut state = self.state.lock().expect("spy state mutex poisoned");
            state.ops.push(SpyFileOp::Flush);
            if state.fail_flush > 0 {
                state.fail_flush -= 1;
                return Err(io::Error::other("flush failed"));
            }
            Ok(())
        }

        fn sync_data(&mut self) -> io::Result<()> {
            let mut state = self.state.lock().expect("spy state mutex poisoned");
            state.ops.push(SpyFileOp::SyncData);
            if state.assistant_tool_call_sync_failure_armed {
                state.assistant_tool_call_sync_failure_armed = false;
                return Err(io::Error::other("assistant tool call sync_data failed"));
            }
            if state.fail_sync_data > 0 {
                state.fail_sync_data -= 1;
                return Err(io::Error::other("sync_data failed"));
            }
            Ok(())
        }

        fn set_len(&mut self, len: u64) -> io::Result<()> {
            let mut state = self.state.lock().expect("spy state mutex poisoned");
            state.ops.push(SpyFileOp::Truncate);
            if state.fail_set_len > 0 {
                state.fail_set_len -= 1;
                return Err(io::Error::other("truncate failed"));
            }
            state.bytes.resize(len as usize, 0);
            Ok(())
        }
    }

    #[derive(Debug, Clone, Copy)]
    enum RecoveryDurabilityScenario {
        EmptyHeaderRewrite,
        TruncateCorruptTail,
        AppendMissingNewline,
    }

    fn recorder_with_spy(spy: SpySessionFile) -> FileSessionRecorder {
        FileSessionRecorder::new_for_test_with_writer(PathBuf::from("session.jsonl"), spy)
    }

    struct ScriptedToolCallProvider {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl Provider for ScriptedToolCallProvider {
        async fn complete(
            &self,
            _request: ProviderRequest,
            _cancel: CancellationToken,
        ) -> Result<ProviderResponse, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
                "call_session_sync_failure",
                "counting_tool",
                serde_json::json!({}),
            )]))
        }
    }

    struct CountingTool {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl Tool for CountingTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(
                "counting_tool",
                "Counts executions in the session durability test.",
                serde_json::json!({"type": "object", "properties": {}}),
            )
        }

        async fn execute(
            &self,
            call: ToolCall,
            _context: ToolExecutionContext,
            _cancel: CancellationToken,
        ) -> Result<ToolResult, ToolError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ToolResult::success(call.id, call.name, "executed"))
        }
    }

    #[tokio::test]
    async fn assistant_tool_call_sync_failure_prevents_tool_execution_and_provider_retry() {
        let spy = SpySessionFile::with_assistant_tool_call_sync_data_failure();
        let recorder = Arc::new(recorder_with_spy(spy));
        let provider = Arc::new(ScriptedToolCallProvider {
            calls: AtomicUsize::new(0),
        });
        let tool = Arc::new(CountingTool {
            calls: AtomicUsize::new(0),
        });
        let service = Service::with_session_replay_and_limits(
            AgentConfig::new("system").with_session("assistant-tool-call-sync-failure"),
            provider.clone(),
            vec![tool.clone()],
            SessionReplay::default(),
            Some(recorder),
            Vec::new(),
            ServiceLimits::default(),
        )
        .expect("service construction should succeed");

        service
            .enqueue(
                "msg_session_sync_failure",
                vec![ContentPart::text("call the counting tool")],
            )
            .await
            .expect("message should enqueue before assistant persistence fails");
        service.wait_for_state(ServiceState::Failed).await;

        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        assert_eq!(tool.calls.load(Ordering::SeqCst), 0);
        assert!(service
            .status()
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("assistant tool call sync_data failed")));
    }

    #[test]
    fn failed_callback_delivery_batch_write_leaves_no_intent_or_commit() {
        let spy = SpySessionFile::with_write_failure();
        let recorder = recorder_with_spy(spy.clone());
        let intent = CallbackDeliveryIntent {
            projection_id: "projection-1".to_owned(),
            event_type: CallbackDeliveryEventType::TaskDelivered,
            data: serde_json::json!({"delivered": true}),
        };

        assert!(recorder
            .record_user_batch_with_ids_and_delivery_intents_sync(
                &[Message::user(vec![ContentPart::text("callback")])],
                &["message-1".to_owned()],
                &[intent],
            )
            .is_err());
        assert!(spy.bytes().is_empty());
        assert_eq!(
            spy.operations(),
            vec![
                SpyFileOp::Write,
                SpyFileOp::Truncate,
                SpyFileOp::Flush,
                SpyFileOp::SyncData,
            ]
        );
    }

    fn open_or_create_session_with_durability_spy_for_test(
        name: &str,
        cwd: &str,
        file: SpySessionFile,
    ) -> Result<OpenedSession, SessionError> {
        let path = PathBuf::from(format!("sessions/{name}.jsonl"));
        let mut writer = file;
        write_session_header_with_writer(&path, &mut writer, name, cwd)?;
        writer
            .sync_parent_dir()
            .map_err(|source| SessionError::Io {
                path: path
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(PathBuf::new),
                source,
            })?;
        Ok(OpenedSession {
            name: name.to_owned(),
            path: path.clone(),
            initial_messages: Vec::new(),
            pending_messages: Vec::new(),
            known_user_messages: Vec::new(),
            message_cursors: Vec::new(),
            pending_delivery_intents: Vec::new(),
            restart_boundary: None,
            warnings: Vec::new(),
            recorder: Arc::new(FileSessionRecorder::new_for_test_with_writer(path, writer)),
        })
    }

    fn load_existing_session_with_durability_spy_for_test(
        scenario: RecoveryDurabilityScenario,
        file: SpySessionFile,
    ) -> Result<OpenedSession, SessionError> {
        let path = PathBuf::from("sessions/recovered.jsonl");
        let mut writer = file;
        let warning = match scenario {
            RecoveryDurabilityScenario::EmptyHeaderRewrite => {
                write_session_header_with_writer(&path, &mut writer, "recovered", "/repo")?;
                "session recovery rewrite_empty_session_header path=sessions/recovered.jsonl line=1 offset=0"
            }
            RecoveryDurabilityScenario::TruncateCorruptTail => {
                truncate_session_file_with_writer(&path, &mut writer, 0)?;
                "session recovery truncate_corrupt_tail path=sessions/recovered.jsonl line=2 offset=0 end_offset=1 truncate_to=0 discarded_bytes=1"
            }
            RecoveryDurabilityScenario::AppendMissingNewline => {
                append_session_newline_with_writer(&path, &mut writer)?;
                "session recovery append_missing_newline path=sessions/recovered.jsonl line=1 offset=0"
            }
        };
        Ok(OpenedSession {
            name: "recovered".to_owned(),
            path: path.clone(),
            initial_messages: Vec::new(),
            pending_messages: Vec::new(),
            known_user_messages: Vec::new(),
            message_cursors: Vec::new(),
            pending_delivery_intents: Vec::new(),
            restart_boundary: None,
            warnings: vec![warning.to_owned()],
            recorder: Arc::new(FileSessionRecorder::new_for_test_with_writer(path, writer)),
        })
    }

    fn text_content(text: &str) -> Vec<ContentPart> {
        vec![ContentPart::text(text)]
    }

    fn temp_home(test: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "botified-session-{test}-{}-{stamp}",
            std::process::id()
        ))
    }

    #[test]
    fn replay_infers_restart_boundary_for_unfinished_tool_result_request() {
        let home = temp_home("open-tool-result-boundary");
        let opened = open_or_create_session_in_home_with_cwd("open-tool-result", &home, "/repo")
            .expect("session should open");
        let user = Message::user(text_content("run tool before crash"));
        opened
            .recorder()
            .record_user_batch_with_ids_sync(&[user], &["msg_active".to_owned()])
            .expect("user batch should persist");
        let call = crate::types::ToolCall::new("call_1", "noop", serde_json::json!({}));
        opened
            .recorder()
            .record_message_sync(&Message::Assistant {
                content: None,
                tool_calls: vec![call.clone()],
                assistant_replay: None,
                usage: None,
                stop_reason: Some(StopReason::ToolCalls),
            })
            .expect("assistant tool call should persist");
        opened
            .recorder()
            .record_message_sync(&Message::ToolResult(ToolResult::success(
                call.id,
                call.name,
                "tool result before crash",
            )))
            .expect("tool result should persist");
        drop(opened);

        let reopened = open_or_create_session_in_home_with_cwd("open-tool-result", &home, "/repo")
            .expect("session should reopen");
        let boundary = reopened
            .restart_boundary()
            .expect("unfinished request should replay with a restart boundary");
        assert_eq!(boundary.active_user_message_id(), "msg_active");
        assert_eq!(
            boundary.current_request_start(reopened.initial_messages()),
            0
        );
    }

    #[test]
    fn replay_infers_restart_boundary_for_unfinished_multi_input_batch() {
        let home = temp_home("open-multi-input-boundary");
        let opened = open_or_create_session_in_home_with_cwd("open-multi-input", &home, "/repo")
            .expect("session should open");
        let users = vec![
            Message::user(text_content("first active input")),
            Message::user(text_content("task-originated active input")),
        ];
        let ids = vec!["msg_active_first".to_owned(), "task_ask_active".to_owned()];
        opened
            .recorder()
            .record_user_batch_with_ids_sync(&users, &ids)
            .expect("user batch should persist");
        let call = crate::types::ToolCall::new("call_1", "noop", serde_json::json!({}));
        opened
            .recorder()
            .record_message_sync(&Message::Assistant {
                content: None,
                tool_calls: vec![call.clone()],
                assistant_replay: None,
                usage: None,
                stop_reason: Some(StopReason::ToolCalls),
            })
            .expect("assistant tool call should persist");
        opened
            .recorder()
            .record_message_sync(&Message::ToolResult(ToolResult::success(
                call.id,
                call.name,
                "tool result before crash",
            )))
            .expect("tool result should persist");
        drop(opened);

        let reopened = open_or_create_session_in_home_with_cwd("open-multi-input", &home, "/repo")
            .expect("session should reopen");
        let boundary = reopened
            .restart_boundary()
            .expect("unfinished request should replay with a restart boundary");
        assert_eq!(boundary.active_user_message_id(), "msg_active_first");
        assert_eq!(boundary.active_input_ids(), ids.as_slice());
        assert_eq!(
            boundary.current_request_start(reopened.initial_messages()),
            0
        );
    }

    #[test]
    fn replay_does_not_merge_independent_user_messages_into_active_batch() {
        let home = temp_home("open-independent-user-boundary");
        let opened =
            open_or_create_session_in_home_with_cwd("open-independent-user", &home, "/repo")
                .expect("session should open");
        opened
            .recorder()
            .record_user_batch_with_ids_sync(
                &[Message::user(text_content("first independent input"))],
                &["msg_first".to_owned()],
            )
            .expect("first user should persist");
        opened
            .recorder()
            .record_user_batch_with_ids_sync(
                &[Message::user(text_content("second independent input"))],
                &["msg_second".to_owned()],
            )
            .expect("second user should persist");
        drop(opened);

        let reopened =
            open_or_create_session_in_home_with_cwd("open-independent-user", &home, "/repo")
                .expect("session should reopen");
        let boundary = reopened
            .restart_boundary()
            .expect("latest unfinished user should create a restart boundary");
        assert_eq!(boundary.active_user_message_id(), "msg_second");
        let expected_ids = vec!["msg_second".to_owned()];
        assert_eq!(boundary.active_input_ids(), expected_ids.as_slice());
    }

    #[test]
    fn replay_does_not_infer_restart_boundary_after_message_cursor() {
        let home = temp_home("message-cursor-no-boundary");
        let opened = open_or_create_session_in_home_with_cwd("message-cursor", &home, "/repo")
            .expect("session should open");
        let user = Message::user(text_content("run tool before cursor"));
        opened
            .recorder()
            .record_user_batch_with_ids_sync(&[user], &["msg_cursor_done".to_owned()])
            .expect("user batch should persist");
        let call = crate::types::ToolCall::new("call_1", "noop", serde_json::json!({}));
        opened
            .recorder()
            .record_message_sync(&Message::Assistant {
                content: None,
                tool_calls: vec![call.clone()],
                assistant_replay: None,
                usage: None,
                stop_reason: Some(StopReason::ToolCalls),
            })
            .expect("assistant tool call should persist");
        opened
            .recorder()
            .record_message_sync(&Message::ToolResult(ToolResult::success(
                call.id,
                call.name,
                "tool result before cursor",
            )))
            .expect("tool result should persist");
        opened
            .recorder()
            .record_message_cursor_sync(&DurableMessageCursor {
                message_id: "msg_cursor_done".to_owned(),
                replay_start_seq: 10,
                terminal_seq: 12,
                replay_events: vec![ThreadEvent::TurnCompleted {
                    usage: crate::agent_events::AgentUsage::default(),
                }],
            })
            .expect("message cursor should persist");
        drop(opened);

        let reopened = open_or_create_session_in_home_with_cwd("message-cursor", &home, "/repo")
            .expect("session should reopen");
        assert!(
            reopened.restart_boundary().is_none(),
            "message cursor is the durable replay boundary and must suppress open-request inference"
        );
    }

    #[test]
    fn replay_infers_restart_boundary_after_failed_message_cursor() {
        let home = temp_home("failed-message-cursor-boundary");
        let opened =
            open_or_create_session_in_home_with_cwd("failed-message-cursor", &home, "/repo")
                .expect("session should open");
        opened
            .recorder()
            .record_user_batch_with_ids_sync(
                &[Message::user(text_content("retry after failed turn"))],
                &["msg_failed_cursor".to_owned()],
            )
            .expect("user batch should persist");
        opened
            .recorder()
            .record_message_cursor_sync(&DurableMessageCursor {
                message_id: "msg_failed_cursor".to_owned(),
                replay_start_seq: 10,
                terminal_seq: 12,
                replay_events: vec![ThreadEvent::TurnFailed {
                    error: crate::agent_events::EventError {
                        message: "transient failure".to_owned(),
                    },
                }],
            })
            .expect("failed message cursor should persist");
        drop(opened);

        let reopened =
            open_or_create_session_in_home_with_cwd("failed-message-cursor", &home, "/repo")
                .expect("session should reopen");
        let boundary = reopened
            .restart_boundary()
            .expect("failed turn cursor should not suppress provider restart boundary");
        assert_eq!(boundary.active_user_message_id(), "msg_failed_cursor");
    }

    #[test]
    fn replay_infers_restart_boundary_for_user_only_completed_cursor() {
        let home = temp_home("user-only-completed-cursor-boundary");
        let opened =
            open_or_create_session_in_home_with_cwd("user-only-completed-cursor", &home, "/repo")
                .expect("session should open");
        opened
            .recorder()
            .record_user_batch_with_ids_sync(
                &[Message::user(text_content(
                    "oversized input finished locally without durable removal",
                ))],
                &["msg_user_only_completed".to_owned()],
            )
            .expect("user batch should persist");
        opened
            .recorder()
            .record_message_cursor_sync(&DurableMessageCursor {
                message_id: "msg_user_only_completed".to_owned(),
                replay_start_seq: 10,
                terminal_seq: 12,
                replay_events: vec![ThreadEvent::TurnCompleted {
                    usage: crate::agent_events::AgentUsage::default(),
                }],
            })
            .expect("completed message cursor should persist");
        drop(opened);

        let reopened =
            open_or_create_session_in_home_with_cwd("user-only-completed-cursor", &home, "/repo")
                .expect("session should reopen");
        let boundary = reopened.restart_boundary().expect(
            "a completed cursor without assistant/tool progress must not suppress restart recovery",
        );
        assert_eq!(boundary.active_user_message_id(), "msg_user_only_completed");
    }

    #[test]
    fn replay_does_not_infer_restart_boundary_after_terminal_assistant() {
        let home = temp_home("terminal-assistant-no-boundary");
        let opened = open_or_create_session_in_home_with_cwd("terminal-assistant", &home, "/repo")
            .expect("session should open");
        opened
            .recorder()
            .record_user_batch_with_ids_sync(
                &[Message::user(text_content("complete request"))],
                &["msg_done".to_owned()],
            )
            .expect("user batch should persist");
        opened
            .recorder()
            .record_message_sync(&Message::Assistant {
                content: Some("done".to_owned()),
                tool_calls: Vec::new(),
                assistant_replay: None,
                usage: None,
                stop_reason: Some(StopReason::EndTurn),
            })
            .expect("assistant should persist");
        drop(opened);

        let reopened =
            open_or_create_session_in_home_with_cwd("terminal-assistant", &home, "/repo")
                .expect("session should reopen");
        assert!(reopened.restart_boundary().is_none());
    }

    #[test]
    fn replay_does_not_infer_restart_boundary_after_tool_terminated_assistant() {
        let home = temp_home("tool-terminated-assistant-no-boundary");
        let opened =
            open_or_create_session_in_home_with_cwd("tool-terminated-assistant", &home, "/repo")
                .expect("session should open");
        opened
            .recorder()
            .record_user_batch_with_ids_sync(
                &[Message::user(text_content("request terminated by tool"))],
                &["msg_tool_terminated".to_owned()],
            )
            .expect("user batch should persist");
        opened
            .recorder()
            .record_message_sync(&Message::Assistant {
                content: Some("tool terminated the turn".to_owned()),
                tool_calls: Vec::new(),
                assistant_replay: None,
                usage: None,
                stop_reason: Some(StopReason::ToolTerminated),
            })
            .expect("tool terminated assistant should persist");
        drop(opened);

        let reopened =
            open_or_create_session_in_home_with_cwd("tool-terminated-assistant", &home, "/repo")
                .expect("session should reopen");
        assert!(
            reopened.restart_boundary().is_none(),
            "tool_terminated is a completed agent turn and must not replay as an open request"
        );
    }

    #[test]
    fn accepted_input_uses_durable_append_boundary() {
        let spy = SpySessionFile::default();
        let recorder = recorder_with_spy(spy.clone());

        recorder
            .record_accepted_input_sync(&AcceptedInputEntry {
                message_id: "msg_1".to_owned(),
                content: text_content("hello"),
                cursor_seq: 7,
                source: InputSource::User,
                metadata: None,
                urgency: InputUrgency::Normal,
            })
            .expect("accepted input should persist only after sync_data succeeds");

        assert_eq!(
            spy.operations(),
            vec![SpyFileOp::Write, SpyFileOp::Flush, SpyFileOp::SyncData]
        );
    }

    #[test]
    fn user_batch_pending_removal_and_message_cursor_use_durable_append_boundary() {
        let user_batch_spy = SpySessionFile::default();
        recorder_with_spy(user_batch_spy.clone())
            .record_user_batch_with_ids_sync(
                &[Message::user(text_content("queued"))],
                &[String::from("msg_queued")],
            )
            .expect("user batch commit should sync before success");
        assert_eq!(
            user_batch_spy.operations(),
            vec![SpyFileOp::Write, SpyFileOp::Flush, SpyFileOp::SyncData]
        );

        let tombstone_spy = SpySessionFile::default();
        recorder_with_spy(tombstone_spy.clone())
            .record_pending_input_removed_sync(
                "task_request_msg",
                InputSource::TaskRequest,
                Some(QueuedInputMetadata::TaskRequest {
                    task_id: "task_1".to_owned(),
                    request_id: "r1".to_owned(),
                }),
                "stale_task_request",
            )
            .expect("pending removal tombstone should sync before success");
        assert_eq!(
            tombstone_spy.operations(),
            vec![SpyFileOp::Write, SpyFileOp::Flush, SpyFileOp::SyncData]
        );

        let cursor_spy = SpySessionFile::default();
        recorder_with_spy(cursor_spy.clone())
            .record_message_cursor_sync(&DurableMessageCursor {
                message_id: "msg_queued".to_owned(),
                replay_start_seq: 11,
                terminal_seq: 14,
                replay_events: Vec::new(),
            })
            .expect("message cursor should sync before success");
        assert_eq!(
            cursor_spy.operations(),
            vec![SpyFileOp::Write, SpyFileOp::Flush, SpyFileOp::SyncData]
        );
    }

    #[test]
    fn ordinary_transcript_remains_flush_only_and_compaction_syncs_truth() {
        let user_spy = SpySessionFile::default();
        recorder_with_spy(user_spy.clone())
            .record_message_sync(&Message::user(text_content("hello")))
            .expect("ordinary user transcript append should flush");
        assert_eq!(
            user_spy.operations(),
            vec![SpyFileOp::Write, SpyFileOp::Flush]
        );

        let assistant_spy = SpySessionFile::default();
        recorder_with_spy(assistant_spy.clone())
            .record_message_sync(&Message::assistant_text("ok"))
            .expect("ordinary transcript append should flush");
        assert_eq!(
            assistant_spy.operations(),
            vec![SpyFileOp::Write, SpyFileOp::Flush]
        );

        let tool_result_spy = SpySessionFile::default();
        recorder_with_spy(tool_result_spy.clone())
            .record_message_sync(&Message::ToolResult(ToolResult::success(
                "call_1", "lookup", "done",
            )))
            .expect("tool result transcript append should flush");
        assert_eq!(
            tool_result_spy.operations(),
            vec![SpyFileOp::Write, SpyFileOp::Flush]
        );

        let compaction_spy = SpySessionFile::default();
        recorder_with_spy(compaction_spy.clone())
            .record_compaction_sync(&text_content("summary"), &[Message::assistant_text("kept")])
            .expect("compaction append should flush");
        assert_eq!(
            compaction_spy.operations(),
            vec![SpyFileOp::Write, SpyFileOp::Flush, SpyFileOp::SyncData]
        );
    }

    #[test]
    fn compaction_truth_failures_roll_back_before_returning_ordinary_error() {
        for (name, spy, expected) in [
            (
                "write",
                SpySessionFile::with_write_failure(),
                vec![
                    SpyFileOp::Write,
                    SpyFileOp::Truncate,
                    SpyFileOp::Flush,
                    SpyFileOp::SyncData,
                ],
            ),
            (
                "flush",
                SpySessionFile::with_flush_failure(),
                vec![
                    SpyFileOp::Write,
                    SpyFileOp::Flush,
                    SpyFileOp::Truncate,
                    SpyFileOp::Flush,
                    SpyFileOp::SyncData,
                ],
            ),
            (
                "sync_data",
                SpySessionFile::with_sync_data_failure(),
                vec![
                    SpyFileOp::Write,
                    SpyFileOp::Flush,
                    SpyFileOp::SyncData,
                    SpyFileOp::Truncate,
                    SpyFileOp::Flush,
                    SpyFileOp::SyncData,
                ],
            ),
        ] {
            let recorder = recorder_with_spy(spy.clone());
            let error = recorder
                .record_compaction_sync(&text_content("summary"), &[])
                .expect_err("compaction truth failure should reject the append");

            assert!(
                !error.to_string().contains("ambiguous"),
                "{name} rollback success should remain an ordinary failure"
            );
            assert_eq!(spy.operations(), expected, "{name}");
            assert!(spy.bytes().is_empty(), "{name} rollback should truncate");
        }
    }

    #[test]
    fn compaction_rollback_ambiguity_poisons_all_shared_recorders_before_io() {
        let spy = SpySessionFile::with_sync_data_and_truncate_failure();
        let recorder = recorder_with_spy(spy.clone());
        let second_recorder = recorder.clone_for_test();

        let error = recorder
            .record_compaction_sync(&text_content("summary"), &[])
            .expect_err("ambiguous compaction rollback should fail terminally");
        assert!(error.to_string().contains("ambiguous"));
        let ops_after_poison = spy.operations();

        for recorder in [&recorder, &second_recorder] {
            let error = recorder
                .record_message_sync(&Message::assistant_text("must fail fast"))
                .expect_err("poison must stop every recorder before persistent io");
            assert!(error.to_string().contains("ambiguous"));
            assert_eq!(spy.operations(), ops_after_poison);
        }
    }

    #[test]
    fn poisoned_second_open_fails_before_cleanup_or_replay_mutation() {
        let home = temp_home("poisoned-second-open");
        let opened =
            open_or_create_session_in_home_with_cwd("poisoned-second-open", &home, "/repo")
                .expect("session should open");
        let path = opened.path().to_path_buf();
        let mut bytes = std::fs::read(&path).expect("session should read");
        assert_eq!(bytes.pop(), Some(b'\n'));
        std::fs::write(&path, &bytes).expect("fixture should remove the final newline");
        let checkpoint_temp = path.with_file_name(format!(
            ".{}.checkpoint-review.tmp",
            path.file_name().unwrap().to_string_lossy()
        ));
        std::fs::write(&checkpoint_temp, b"must not be cleaned")
            .expect("checkpoint temp fixture should write");

        let recorder = opened.recorder();
        let spy = SpySessionFile::from_bytes_with_sync_data_and_truncate_failure(bytes.clone());
        recorder
            .shared
            .append
            .lock()
            .expect("session append state mutex poisoned")
            .file = Box::new(spy);
        let poison_error = recorder
            .record_compaction_sync(&text_content("ambiguous"), &[])
            .expect_err("compaction rollback ambiguity should poison the path");
        assert!(matches!(
            poison_error,
            SessionError::AmbiguousStorage { .. }
        ));
        let bytes_before_reopen = std::fs::read(&path).expect("session should read");

        let reopened =
            open_or_create_session_in_home_with_cwd("poisoned-second-open", &home, "/repo");

        assert_eq!(
            std::fs::read(&path).expect("session should read"),
            bytes_before_reopen,
            "poisoned second open must not repair the missing newline"
        );
        assert!(
            checkpoint_temp.exists(),
            "poisoned second open must not clean checkpoint temps"
        );
        assert!(matches!(
            reopened,
            Err(SessionError::AmbiguousStorage { .. })
        ));
        drop(recorder);
        drop(opened);

        let restarted =
            open_or_create_session_in_home_with_cwd("poisoned-second-open", &home, "/repo")
                .expect("dropping the weak shared state should allow restart replay recovery");
        assert!(
            std::fs::read(&path)
                .expect("restarted session should read")
                .ends_with(b"\n"),
            "restart replay should repair the missing newline"
        );
        assert!(
            !checkpoint_temp.exists(),
            "restart replay should resume checkpoint temp cleanup"
        );
        drop(restarted);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn healthy_shared_session_can_still_reopen_normally() {
        let home = temp_home("healthy-shared-reopen");
        let opened =
            open_or_create_session_in_home_with_cwd("healthy-shared-reopen", &home, "/repo")
                .expect("session should open");
        opened
            .recorder()
            .record_message_sync(&Message::assistant_text("healthy shared append"))
            .expect("message should persist");

        let reopened =
            open_or_create_session_in_home_with_cwd("healthy-shared-reopen", &home, "/repo")
                .expect("healthy shared session should reopen");
        assert_eq!(
            reopened.initial_messages(),
            &[Message::assistant_text("healthy shared append")]
        );
        drop(reopened);
        drop(opened);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn ordinary_append_rollback_ambiguity_does_not_set_compaction_poison() {
        let spy = SpySessionFile::with_sync_data_and_truncate_failure();
        let recorder = recorder_with_spy(spy.clone());
        recorder
            .record_accepted_input_sync(&AcceptedInputEntry {
                message_id: "msg_ambiguous".to_owned(),
                content: text_content("ordinary durable append"),
                cursor_seq: 1,
                source: InputSource::User,
                metadata: None,
                urgency: InputUrgency::Normal,
            })
            .expect_err("ordinary append rollback ambiguity should still return an error");
        let ops_before_followup = spy.operations();

        recorder
            .record_message_sync(&Message::assistant_text("ordinary writes remain enabled"))
            .expect("only compaction rollback ambiguity may poison the path");
        assert!(spy.operations().len() > ops_before_followup.len());
    }

    #[test]
    fn assistant_tool_calls_sync_data_before_success() {
        let assistant_spy = SpySessionFile::default();
        recorder_with_spy(assistant_spy.clone())
            .record_message_sync(&Message::assistant_tool_calls(vec![
                crate::types::ToolCall::new(
                    "call_1",
                    "lookup",
                    serde_json::json!({"query": "status"}),
                ),
            ]))
            .expect("assistant tool call should sync before success");
        assert_eq!(
            assistant_spy.operations(),
            vec![SpyFileOp::Write, SpyFileOp::Flush, SpyFileOp::SyncData]
        );
    }

    #[test]
    fn durable_append_sync_data_failure_returns_error() {
        for operation in [
            "accepted_input",
            "user_batch",
            "pending_input_removed",
            "message_cursor",
            "assistant_tool_call",
        ] {
            let spy = SpySessionFile::with_sync_data_failure();
            let recorder = recorder_with_spy(spy.clone());
            let result = match operation {
                "accepted_input" => recorder.record_accepted_input_sync(&AcceptedInputEntry {
                    message_id: "msg_1".to_owned(),
                    content: text_content("hello"),
                    cursor_seq: 1,
                    source: InputSource::User,
                    metadata: None,
                    urgency: InputUrgency::Normal,
                }),
                "user_batch" => recorder.record_user_batch_with_ids_sync(
                    &[Message::user(text_content("queued"))],
                    &[String::from("msg_queued")],
                ),
                "pending_input_removed" => recorder.record_pending_input_removed_sync(
                    "msg_removed",
                    InputSource::User,
                    None,
                    "stale_task_request",
                ),
                "message_cursor" => recorder.record_message_cursor_sync(&DurableMessageCursor {
                    message_id: "msg_1".to_owned(),
                    replay_start_seq: 2,
                    terminal_seq: 3,
                    replay_events: Vec::new(),
                }),
                "assistant_tool_call" => {
                    recorder.record_message_sync(&Message::assistant_tool_calls(vec![
                        crate::types::ToolCall::new(
                            "call_1",
                            "lookup",
                            serde_json::json!({"query": "status"}),
                        ),
                    ]))
                }
                _ => unreachable!(),
            };

            assert!(
                result.is_err(),
                "{operation} must return sync_data failure instead of acknowledging durability"
            );
            assert_eq!(
                spy.operations(),
                vec![
                    SpyFileOp::Write,
                    SpyFileOp::Flush,
                    SpyFileOp::SyncData,
                    SpyFileOp::Truncate,
                    SpyFileOp::Flush,
                    SpyFileOp::SyncData,
                ],
                "{operation} should roll back the append after sync_data failure"
            );
            assert!(
                spy.bytes().is_empty(),
                "{operation} rollback should remove the failed append bytes"
            );
            assert!(
                !result
                    .expect_err("durable append should fail")
                    .to_string()
                    .contains("rollback failed"),
                "{operation} should return the original error when rollback succeeds"
            );
        }
    }

    #[test]
    fn accepted_input_write_line_failure_rolls_back_append() {
        let spy = SpySessionFile::with_write_failure();
        let recorder = recorder_with_spy(spy.clone());

        let error = recorder
            .record_accepted_input_sync(&AcceptedInputEntry {
                message_id: "msg_write_fails".to_owned(),
                content: text_content("must roll back write failure"),
                cursor_seq: 1,
                source: InputSource::User,
                metadata: None,
                urgency: InputUrgency::Normal,
            })
            .expect_err("accepted input write_line failure should reject append");

        assert!(error.to_string().contains("write_line failed"));
        assert!(
            !error.to_string().contains("rollback failed"),
            "accepted input should return original write_line error when rollback succeeds"
        );
        assert_eq!(
            spy.operations(),
            vec![
                SpyFileOp::Write,
                SpyFileOp::Truncate,
                SpyFileOp::Flush,
                SpyFileOp::SyncData,
            ],
            "accepted input should roll back write_line failure"
        );
        assert!(
            spy.bytes().is_empty(),
            "rollback should remove bytes appended before write_line failure"
        );
    }

    #[test]
    fn accepted_input_flush_failure_rolls_back_append() {
        let spy = SpySessionFile::with_flush_failure();
        let recorder = recorder_with_spy(spy.clone());

        let error = recorder
            .record_accepted_input_sync(&AcceptedInputEntry {
                message_id: "msg_flush_fails".to_owned(),
                content: text_content("must roll back flush failure"),
                cursor_seq: 1,
                source: InputSource::User,
                metadata: None,
                urgency: InputUrgency::Normal,
            })
            .expect_err("accepted input flush failure should reject append");

        assert!(error.to_string().contains("flush failed"));
        assert!(
            !error.to_string().contains("rollback failed"),
            "accepted input should return original flush error when rollback succeeds"
        );
        assert_eq!(
            spy.operations(),
            vec![
                SpyFileOp::Write,
                SpyFileOp::Flush,
                SpyFileOp::Truncate,
                SpyFileOp::Flush,
                SpyFileOp::SyncData,
            ],
            "accepted input should roll back flush failure"
        );
        assert!(
            spy.bytes().is_empty(),
            "rollback should remove bytes appended before flush failure"
        );
    }

    #[test]
    fn durable_append_rollback_failure_reports_original_and_rollback_errors() {
        let spy = SpySessionFile::with_sync_data_and_truncate_failure();
        let recorder = recorder_with_spy(spy.clone());

        let error = recorder
            .record_accepted_input_sync(&AcceptedInputEntry {
                message_id: "msg_rollback_fails".to_owned(),
                content: text_content("not durable"),
                cursor_seq: 1,
                source: InputSource::User,
                metadata: None,
                urgency: InputUrgency::Normal,
            })
            .expect_err("sync_data and rollback should fail");

        let message = error.to_string();
        assert!(message.contains("session append rollback failed"));
        assert!(message.contains("sync_data failed"));
        assert!(message.contains("truncate failed"));
        assert_eq!(
            spy.operations(),
            vec![
                SpyFileOp::Write,
                SpyFileOp::Flush,
                SpyFileOp::SyncData,
                SpyFileOp::Truncate,
            ]
        );
    }

    #[test]
    fn accepted_input_sync_failure_reopen_does_not_replay_failed_append() {
        let home = temp_home("accepted-rollback-reopen");
        let opened =
            open_or_create_session_in_home_with_cwd("accepted-rollback-reopen", &home, "/repo")
                .expect("session should open");
        let path = opened.path().to_path_buf();
        let header_bytes = std::fs::read(&path).expect("session header should read");
        drop(opened);

        let spy = SpySessionFile::from_bytes_with_sync_data_failure(header_bytes.clone());
        let recorder = FileSessionRecorder::new_for_test_with_writer(path.clone(), spy.clone());
        recorder
            .record_accepted_input_sync(&AcceptedInputEntry {
                message_id: "msg_failed_sync".to_owned(),
                content: text_content("must not replay"),
                cursor_seq: 1,
                source: InputSource::User,
                metadata: None,
                urgency: InputUrgency::Normal,
            })
            .expect_err("accepted input sync failure should reject append");

        assert_eq!(
            spy.bytes(),
            header_bytes,
            "rollback should restore the session file bytes to the old length"
        );
        std::fs::write(&path, spy.bytes()).expect("rolled back session bytes should write");
        let reopened =
            open_or_create_session_in_home_with_cwd("accepted-rollback-reopen", &home, "/repo")
                .expect("rolled back session should reopen");
        assert!(reopened.pending_messages().is_empty());
        assert!(reopened.initial_messages().is_empty());
    }

    #[test]
    fn cold_start_discard_is_durable_for_queued_running_and_delivery_intent() {
        let home = temp_home("cold-start-discard");
        let opened = open_or_create_session_in_home_with_cwd("cold-start-discard", &home, "/repo")
            .expect("session should open");
        let recorder = opened.recorder();
        recorder
            .record_user_batch_with_ids_sync(
                &[Message::user(text_content("completed request"))],
                &["msg_completed".to_owned()],
            )
            .expect("completed request should persist");
        recorder
            .record_message_sync(&Message::assistant_text("completed answer"))
            .expect("completed answer should persist");

        let intent = CallbackDeliveryIntent {
            projection_id: "callback-delivered:msg_running".to_owned(),
            event_type: CallbackDeliveryEventType::TaskDelivered,
            data: serde_json::json!({"input_id": "msg_running"}),
        };
        recorder
            .record_user_batch_with_ids_and_delivery_intents_sync(
                &[Message::user(text_content("running request"))],
                &["msg_running".to_owned()],
                &[intent],
            )
            .expect("running request and delivery intent should persist");
        let running_call =
            crate::types::ToolCall::new("call_running", "noop", serde_json::json!({}));
        recorder
            .record_message_sync(&Message::Assistant {
                content: None,
                tool_calls: vec![running_call.clone()],
                assistant_replay: None,
                usage: None,
                stop_reason: Some(StopReason::ToolCalls),
            })
            .expect("running tool call should persist");
        recorder
            .record_message_sync(&Message::ToolResult(ToolResult::success(
                running_call.id,
                running_call.name,
                "tool output before restart",
            )))
            .expect("running tool result should persist");
        recorder
            .record_accepted_input_sync(&AcceptedInputEntry {
                message_id: "msg_queued".to_owned(),
                content: text_content("queued request"),
                cursor_seq: 1,
                source: InputSource::User,
                metadata: None,
                urgency: InputUrgency::Normal,
            })
            .expect("queued request should persist");
        drop(recorder);
        drop(opened);

        let mut reopened =
            open_or_create_session_in_home_with_cwd("cold-start-discard", &home, "/repo")
                .expect("unfinished session should reopen");
        assert_eq!(reopened.pending_messages().len(), 1);
        assert!(reopened.restart_boundary().is_some());
        assert_eq!(reopened.pending_delivery_intents().len(), 1);

        reopened
            .discard_unfinished_sync()
            .expect("cold-start discard should persist atomically");
        assert!(reopened.pending_messages().is_empty());
        assert_eq!(reopened.known_user_messages().len(), 1);
        assert_eq!(reopened.known_user_messages()[0].id, "msg_completed");
        assert!(reopened.restart_boundary().is_none());
        assert!(reopened.pending_delivery_intents().is_empty());
        assert_eq!(reopened.initial_messages().len(), 2);
        drop(reopened);

        let reopened =
            open_or_create_session_in_home_with_cwd("cold-start-discard", &home, "/repo")
                .expect("discarded session should reopen");
        assert!(reopened.pending_messages().is_empty());
        assert_eq!(reopened.known_user_messages().len(), 1);
        assert_eq!(reopened.known_user_messages()[0].id, "msg_completed");
        assert!(reopened.restart_boundary().is_none());
        assert!(reopened.pending_delivery_intents().is_empty());
        assert_eq!(reopened.initial_messages().len(), 2);
    }

    #[test]
    fn new_session_header_syncs_file_and_parent_directory_before_open_returns() {
        let file = SpySessionFile::default();
        let opened = open_or_create_session_with_durability_spy_for_test(
            "new-session",
            "/repo",
            file.clone(),
        )
        .expect("new session should open only after durable header");

        assert_eq!(opened.name(), "new-session");
        assert_eq!(
            file.operations(),
            vec![
                SpyFileOp::Write,
                SpyFileOp::Flush,
                SpyFileOp::SyncData,
                SpyFileOp::SyncParentDir,
            ]
        );
    }

    #[test]
    fn recovery_repairs_sync_file_before_returning_loaded_session() {
        for scenario in [
            RecoveryDurabilityScenario::EmptyHeaderRewrite,
            RecoveryDurabilityScenario::TruncateCorruptTail,
            RecoveryDurabilityScenario::AppendMissingNewline,
        ] {
            let file = SpySessionFile::default();
            let loaded = load_existing_session_with_durability_spy_for_test(scenario, file.clone())
                .expect("repair should return only after durable sync");

            assert!(loaded.warnings().iter().any(|warning| {
                warning.contains(match scenario {
                    RecoveryDurabilityScenario::EmptyHeaderRewrite => {
                        "rewrite_empty_session_header"
                    }
                    RecoveryDurabilityScenario::TruncateCorruptTail => "truncate_corrupt_tail",
                    RecoveryDurabilityScenario::AppendMissingNewline => "append_missing_newline",
                })
            }));
            assert!(
                file.operations().contains(&SpyFileOp::SyncData),
                "{scenario:?} repair must sync_data before returning"
            );
        }
    }
}
