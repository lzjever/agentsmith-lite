use std::collections::HashSet;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::agent_events::ThreadEvent;
use crate::agent_loop::{
    AcceptedInputEntry, AgentCommitError, AgentContextRecorder, DrainedMessage, InputSource,
    InputUrgency, QueuedInputMetadata,
};
use crate::transcript::repair_provider_transcript;
use crate::types::{ContentPart, Message, StopReason, ToolResult};

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
}

#[derive(Debug, Clone)]
pub struct OpenedSession {
    name: String,
    path: PathBuf,
    initial_messages: Vec<Message>,
    pending_messages: Vec<DrainedMessage>,
    known_user_messages: Vec<DrainedMessage>,
    message_cursors: Vec<DurableMessageCursor>,
    restart_boundary: Option<SessionRestartBoundary>,
    warnings: Vec<String>,
    recorder: Arc<FileSessionRecorder>,
}

impl OpenedSession {
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

    pub fn restart_boundary(&self) -> Option<&SessionRestartBoundary> {
        self.restart_boundary.as_ref()
    }

    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    pub fn recorder(&self) -> Arc<FileSessionRecorder> {
        self.recorder.clone()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRestartBoundary {
    active_user_message_id: String,
}

impl SessionRestartBoundary {
    fn new(active_user_message_id: String) -> Self {
        Self {
            active_user_message_id,
        }
    }

    pub fn active_user_message_id(&self) -> &str {
        &self.active_user_message_id
    }

    pub fn current_request_start(&self, initial_messages: &[Message]) -> usize {
        initial_messages.len()
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

#[derive(Debug, Clone, Default)]
struct LoadedSession {
    initial_messages: Vec<Message>,
    pending_messages: Vec<DrainedMessage>,
    known_user_messages: Vec<DrainedMessage>,
    message_cursors: Vec<DurableMessageCursor>,
    restart_boundary: Option<SessionRestartBoundary>,
    warnings: Vec<String>,
}

pub(crate) fn retain_recent_known_user_messages_for_replay(
    mut known_user_messages: Vec<DrainedMessage>,
    pending_messages: &[DrainedMessage],
    retained_window: usize,
) -> Vec<DrainedMessage> {
    let pending_ids = pending_messages
        .iter()
        .map(|message| message.id.clone())
        .collect::<HashSet<_>>();
    let mut retained_ids = pending_ids.clone();
    let mut retained_recent = 0usize;

    for message in known_user_messages.iter().rev() {
        if pending_ids.contains(&message.id) {
            retained_ids.insert(message.id.clone());
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
    file: Mutex<Box<dyn SessionFileIo>>,
}

impl std::fmt::Debug for FileSessionRecorder {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FileSessionRecorder")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl FileSessionRecorder {
    fn new(path: PathBuf, file: File) -> Self {
        Self {
            path,
            file: Mutex::new(Box::new(file)),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test_with_writer(
        path: PathBuf,
        writer: impl SessionFileIo + 'static,
    ) -> Self {
        Self {
            path,
            file: Mutex::new(Box::new(writer)),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn append_entry(
        &self,
        entry: SessionLine,
        durability: SessionAppendDurability,
    ) -> Result<(), SessionError> {
        let line = serialize_session_line(&self.path, &entry)?;
        let mut file = self.file.lock().expect("session file mutex poisoned");
        append_serialized_session_line(&self.path, file.as_mut(), &line, durability)
    }

    pub fn record_message_sync(&self, message: &Message) -> Result<(), SessionError> {
        match message {
            Message::User { .. } => self.append_entry(
                SessionLine::UserMessage {
                    message_id: None,
                    message: message.clone(),
                },
                SessionAppendDurability::FlushOnly,
            ),
            Message::Assistant { .. } => self.append_entry(
                SessionLine::AssistantMessage {
                    message: message.clone(),
                },
                SessionAppendDurability::FlushOnly,
            ),
            Message::ToolResult(result) => self.append_entry(
                SessionLine::ToolResult {
                    result: result.clone(),
                },
                SessionAppendDurability::FlushOnly,
            ),
        }
    }

    pub fn record_accepted_input_sync(
        &self,
        entry: &AcceptedInputEntry,
    ) -> Result<(), SessionError> {
        self.append_entry(
            accepted_input_session_line(entry),
            SessionAppendDurability::SyncData,
        )
    }

    pub(crate) fn record_accepted_input_with_undo_sync(
        &self,
        entry: &AcceptedInputEntry,
    ) -> Result<AcceptedInputUndo<'_>, SessionError> {
        let session_line = accepted_input_session_line(entry);
        let line = serialize_session_line(&self.path, &session_line)?;
        let mut file = self.file.lock().expect("session file mutex poisoned");
        let old_len = file.len().map_err(|source| SessionError::Io {
            path: self.path.clone(),
            source,
        })?;
        append_serialized_session_line_from_len(
            &self.path,
            file.as_mut(),
            &line,
            SessionAppendDurability::SyncData,
            old_len,
        )?;
        Ok(AcceptedInputUndo {
            path: &self.path,
            file,
            old_len,
            active: true,
        })
    }

    pub fn record_pending_input_removed_sync(
        &self,
        message_id: &str,
        source: InputSource,
        metadata: Option<QueuedInputMetadata>,
        reason: &str,
    ) -> Result<(), SessionError> {
        self.append_entry(
            SessionLine::PendingInputRemoved {
                message_id: message_id.to_owned(),
                source,
                metadata,
                reason: reason.to_owned(),
            },
            SessionAppendDurability::SyncData,
        )
    }

    pub fn record_user_batch_sync(&self, messages: &[Message]) -> Result<(), SessionError> {
        self.append_user_batch_entry(messages, None)
    }

    pub fn record_user_batch_with_ids_sync(
        &self,
        messages: &[Message],
        message_ids: &[String],
    ) -> Result<(), SessionError> {
        self.append_user_batch_entry(messages, Some(message_ids))
    }

    fn append_user_batch_entry(
        &self,
        messages: &[Message],
        message_ids: Option<&[String]>,
    ) -> Result<(), SessionError> {
        for message in messages {
            if !matches!(message, Message::User { .. }) {
                return Err(SessionError::BadEntry {
                    path: self.path.clone(),
                    line: 0,
                    message: "user batch contains a non-user message".to_owned(),
                });
            }
        }
        if let Some(message_ids) = message_ids {
            if message_ids.len() != messages.len() {
                return Err(SessionError::BadEntry {
                    path: self.path.clone(),
                    line: 0,
                    message: "user batch message id count does not match message count".to_owned(),
                });
            }
        }
        if let [message] = messages {
            return self.append_entry(
                SessionLine::UserMessage {
                    message_id: message_ids.and_then(|ids| ids.first().cloned()),
                    message: message.clone(),
                },
                SessionAppendDurability::SyncData,
            );
        }
        self.append_entry(
            SessionLine::UserBatch {
                message_ids: message_ids.map(|ids| ids.to_vec()),
                messages: messages.to_vec(),
            },
            SessionAppendDurability::SyncData,
        )
    }

    pub fn record_compaction_sync(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
    ) -> Result<(), SessionError> {
        self.record_compaction_with_active_user_message_id_sync(summary, retained_messages, None)
    }

    pub fn record_compaction_with_active_user_message_id_sync(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        active_user_message_id: Option<&str>,
    ) -> Result<(), SessionError> {
        self.append_entry(
            SessionLine::Compaction {
                active_user_message_id: active_user_message_id.map(ToOwned::to_owned),
                summary: summary.to_vec(),
                retained_messages: retained_messages.to_vec(),
            },
            SessionAppendDurability::FlushOnly,
        )
    }

    pub fn record_message_cursor_sync(
        &self,
        cursor: &DurableMessageCursor,
    ) -> Result<(), SessionError> {
        let terminal_seq = durable_terminal_seq(
            cursor.replay_start_seq,
            cursor.terminal_seq,
            !cursor.replay_events.is_empty(),
        );
        self.append_entry(
            SessionLine::MessageCursor {
                message_id: cursor.message_id.clone(),
                replay_start_seq: cursor.replay_start_seq,
                terminal_seq,
                replay_events: cursor.replay_events.clone(),
            },
            SessionAppendDurability::SyncData,
        )
    }
}

pub(crate) struct AcceptedInputUndo<'a> {
    path: &'a Path,
    file: MutexGuard<'a, Box<dyn SessionFileIo>>,
    old_len: u64,
    active: bool,
}

impl AcceptedInputUndo<'_> {
    pub(crate) fn commit(mut self) {
        self.active = false;
    }

    pub(crate) fn rollback(mut self) -> Result<(), SessionError> {
        self.active = false;
        truncate_session_file_with_writer(self.path, self.file.as_mut(), self.old_len)
    }
}

impl Drop for AcceptedInputUndo<'_> {
    fn drop(&mut self) {
        debug_assert!(
            !self.active,
            "accepted input undo must be committed or rolled back"
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionAppendDurability {
    FlushOnly,
    SyncData,
}

pub(crate) trait SessionFileIo: Send {
    fn len(&mut self) -> std::io::Result<u64>;
    fn write_line(&mut self, line: &str) -> std::io::Result<()>;
    fn write_bytes(&mut self, bytes: &[u8]) -> std::io::Result<()>;
    fn flush(&mut self) -> std::io::Result<()>;
    fn sync_data(&mut self) -> std::io::Result<()>;
    fn set_len(&mut self, len: u64) -> std::io::Result<()>;
}

impl SessionFileIo for File {
    fn len(&mut self) -> std::io::Result<u64> {
        self.metadata().map(|metadata| metadata.len())
    }

    fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        writeln!(self, "{line}")
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.write_all(bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Write::flush(self)
    }

    fn sync_data(&mut self) -> std::io::Result<()> {
        File::sync_data(self)
    }

    fn set_len(&mut self, len: u64) -> std::io::Result<()> {
        File::set_len(self, len)
    }
}

fn accepted_input_session_line(entry: &AcceptedInputEntry) -> SessionLine {
    SessionLine::AcceptedInput {
        message_id: entry.message_id.clone(),
        cursor_seq: entry.cursor_seq,
        source: entry.source,
        metadata: entry.metadata.clone(),
        urgency: entry.urgency,
        content: entry.content.clone(),
    }
}

fn serialize_session_line(path: &Path, entry: &SessionLine) -> Result<String, SessionError> {
    serde_json::to_string(entry).map_err(|error| SessionError::BadEntry {
        path: path.to_path_buf(),
        line: 0,
        message: error.to_string(),
    })
}

fn append_serialized_session_line(
    path: &Path,
    file: &mut dyn SessionFileIo,
    line: &str,
    durability: SessionAppendDurability,
) -> Result<(), SessionError> {
    let old_len = file.len().map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    append_serialized_session_line_from_len(path, file, line, durability, old_len)
}

fn append_serialized_session_line_from_len(
    path: &Path,
    file: &mut dyn SessionFileIo,
    line: &str,
    durability: SessionAppendDurability,
    old_len: u64,
) -> Result<(), SessionError> {
    if let Err(source) = file.write_line(line) {
        return Err(rollback_session_append_error(
            path,
            file,
            old_len,
            SessionError::Io {
                path: path.to_path_buf(),
                source,
            },
        ));
    }
    if let Err(source) = file.flush() {
        return Err(rollback_session_append_error(
            path,
            file,
            old_len,
            SessionError::Io {
                path: path.to_path_buf(),
                source,
            },
        ));
    }
    if durability == SessionAppendDurability::SyncData {
        if let Err(source) = file.sync_data() {
            return Err(rollback_session_append_error(
                path,
                file,
                old_len,
                SessionError::Io {
                    path: path.to_path_buf(),
                    source,
                },
            ));
        }
    }
    Ok(())
}

fn rollback_session_append_error(
    path: &Path,
    file: &mut dyn SessionFileIo,
    old_len: u64,
    original: SessionError,
) -> SessionError {
    match truncate_session_file_with_writer(path, file, old_len) {
        Ok(()) => original,
        Err(rollback) => session_append_rollback_error(path, original, rollback),
    }
}

fn session_append_rollback_error(
    path: &Path,
    original: SessionError,
    rollback: SessionError,
) -> SessionError {
    SessionError::Io {
        path: path.to_path_buf(),
        source: io::Error::other(format!(
            "session append rollback failed; original error: {original}; rollback error: {rollback}"
        )),
    }
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
        self.record_compaction_sync(summary, retained_messages)
            .map_err(|error| AgentCommitError::new(error.to_string()))
    }

    async fn record_compaction_with_active_user_message_id(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        active_user_message_id: Option<&str>,
    ) -> Result<(), AgentCommitError> {
        self.record_compaction_with_active_user_message_id_sync(
            summary,
            retained_messages,
            active_user_message_id,
        )
        .map_err(|error| AgentCommitError::new(error.to_string()))
    }
}

pub fn open_or_create_session(name: &str) -> Result<OpenedSession, SessionError> {
    open_or_create_session_with_cwd(name, current_dir_string()?)
}

pub fn open_or_create_session_with_cwd(
    name: &str,
    cwd: impl Into<String>,
) -> Result<OpenedSession, SessionError> {
    open_or_create_session_in_home_with_cwd(name, default_botified_home(), cwd)
}

pub fn open_or_create_session_in_home(
    name: &str,
    home: impl AsRef<Path>,
) -> Result<OpenedSession, SessionError> {
    open_or_create_session_in_home_with_cwd(name, home, current_dir_string()?)
}

pub fn open_or_create_session_in_home_with_cwd(
    name: &str,
    home: impl AsRef<Path>,
    cwd: impl Into<String>,
) -> Result<OpenedSession, SessionError> {
    if name.trim().is_empty() {
        return Err(SessionError::EmptyName);
    }

    let home = home.as_ref();
    let cwd = cwd.into();
    let sessions_dir = home.join("sessions");
    fs::create_dir_all(&sessions_dir).map_err(|source| SessionError::Io {
        path: sessions_dir.clone(),
        source,
    })?;

    let path = sessions_dir.join(format!("{}.jsonl", encode_session_name(name)));
    let loaded = if path.exists() {
        load_existing_session(&path, name, &cwd)?
    } else {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                write_session_header(&path, &mut file, name, &cwd)?;
                sync_session_parent_dir(&path)?;
                LoadedSession::default()
            }
            Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                load_existing_session(&path, name, &cwd)?
            }
            Err(source) => {
                return Err(SessionError::Io {
                    path: path.clone(),
                    source,
                });
            }
        }
    };

    let file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|source| SessionError::Io {
            path: path.clone(),
            source,
        })?;

    Ok(OpenedSession {
        name: name.to_owned(),
        path: path.clone(),
        initial_messages: loaded.initial_messages,
        pending_messages: loaded.pending_messages,
        known_user_messages: loaded.known_user_messages,
        message_cursors: loaded.message_cursors,
        restart_boundary: loaded.restart_boundary,
        warnings: loaded.warnings,
        recorder: Arc::new(FileSessionRecorder::new(path, file)),
    })
}

fn load_existing_session(
    path: &Path,
    expected_name: &str,
    cwd: &str,
) -> Result<LoadedSession, SessionError> {
    let metadata = fs::metadata(path).map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if metadata.len() == 0 {
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .map_err(|source| SessionError::Io {
                path: path.to_path_buf(),
                source,
            })?;
        write_session_header(path, &mut file, expected_name, cwd)?;
        return Ok(LoadedSession {
            warnings: vec![format!(
                "session recovery rewrite_empty_session_header path={} line=1 offset=0",
                path.display()
            )],
            ..LoadedSession::default()
        });
    }
    load_session(path, expected_name)
}

fn write_session_header(
    path: &Path,
    file: &mut File,
    name: &str,
    cwd: &str,
) -> Result<(), SessionError> {
    write_session_header_with_writer(path, file, name, cwd)
}

fn write_session_header_with_writer(
    path: &Path,
    file: &mut dyn SessionFileIo,
    name: &str,
    cwd: &str,
) -> Result<(), SessionError> {
    let header = serde_json::to_string(&SessionLine::Header {
        version: SESSION_VERSION,
        name: name.to_owned(),
        created_at: created_at_seconds()?,
        cwd: cwd.to_owned(),
    })
    .map_err(|error| SessionError::BadHeader {
        path: path.to_path_buf(),
        message: error.to_string(),
    })?;
    append_serialized_session_line(path, file, &header, SessionAppendDurability::SyncData)
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

fn default_botified_home() -> PathBuf {
    env::var_os("BOTIFIED_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".botified")))
        .unwrap_or_else(|| PathBuf::from(".botified"))
}

fn current_dir_string() -> Result<String, SessionError> {
    let path = env::current_dir().map_err(|source| SessionError::Io {
        path: PathBuf::from("."),
        source,
    })?;
    Ok(path.display().to_string())
}

fn created_at_seconds() -> Result<u64, SessionError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|source| SessionError::BadHeader {
            path: PathBuf::new(),
            message: source.to_string(),
        })
}

fn load_session(path: &Path, expected_name: &str) -> Result<LoadedSession, SessionError> {
    let file = File::open(path).map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let file_len = file
        .metadata()
        .map_err(|source| SessionError::Io {
            path: path.to_path_buf(),
            source,
        })?
        .len();
    let mut reader = BufReader::new(file);
    let Some(header_record) = read_raw_record(path, &mut reader, 1, 0)? else {
        return Err(SessionError::BadHeader {
            path: path.to_path_buf(),
            message: "missing header".to_owned(),
        });
    };
    parse_header_record(path, expected_name, &header_record)?;

    let mut replay = SessionReplay::default();
    let mut warnings = Vec::new();
    let mut last_good_offset = header_record.end_offset;
    let mut last_good_line = header_record.line;
    let mut last_good_had_newline = header_record.had_newline;
    let mut next_line = 2;
    let mut next_offset = header_record.end_offset;

    while let Some(record) = read_raw_record(path, &mut reader, next_line, next_offset)? {
        match parse_body_record(path, record.line, record.payload()) {
            Ok(Some(entry)) => {
                apply_session_line(path, record.line, &mut replay, entry)?;
                last_good_offset = record.end_offset;
                last_good_line = record.line;
                last_good_had_newline = record.had_newline;
            }
            Ok(None) => {
                last_good_offset = record.end_offset;
                last_good_line = record.line;
                last_good_had_newline = record.had_newline;
            }
            Err(error) => {
                if record.end_offset == file_len {
                    truncate_session_file(path, last_good_offset)?;
                    warnings.push(format!(
                        "session recovery truncate_corrupt_tail path={} line={} offset={} end_offset={} truncate_to={} discarded_bytes={}",
                        path.display(),
                        record.line,
                        record.start_offset,
                        record.end_offset,
                        last_good_offset,
                        file_len.saturating_sub(last_good_offset)
                    ));
                    return Ok(replay.into_loaded(warnings));
                }
                return Err(error);
            }
        }
        next_line += 1;
        next_offset = record.end_offset;
    }

    if !last_good_had_newline && last_good_offset == file_len {
        append_session_newline(path)?;
        warnings.push(format!(
            "session recovery append_missing_newline path={} line={} offset={} appended_bytes=1",
            path.display(),
            last_good_line,
            last_good_offset
        ));
    }

    Ok(replay.into_loaded(warnings))
}

#[derive(Debug)]
struct RawRecord {
    line: usize,
    start_offset: u64,
    end_offset: u64,
    had_newline: bool,
    bytes: Vec<u8>,
}

impl RawRecord {
    fn payload(&self) -> &[u8] {
        let mut end = self.bytes.len();
        if end > 0 && self.bytes[end - 1] == b'\n' {
            end -= 1;
            if end > 0 && self.bytes[end - 1] == b'\r' {
                end -= 1;
            }
        }
        &self.bytes[..end]
    }
}

fn read_raw_record<R: BufRead>(
    path: &Path,
    reader: &mut R,
    line: usize,
    start_offset: u64,
) -> Result<Option<RawRecord>, SessionError> {
    let mut bytes = Vec::new();
    let read = reader
        .read_until(b'\n', &mut bytes)
        .map_err(|source| SessionError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    if read == 0 {
        return Ok(None);
    }
    let had_newline = bytes.last() == Some(&b'\n');
    Ok(Some(RawRecord {
        line,
        start_offset,
        end_offset: start_offset + read as u64,
        had_newline,
        bytes,
    }))
}

fn parse_header_record(
    path: &Path,
    expected_name: &str,
    record: &RawRecord,
) -> Result<(), SessionError> {
    let raw = std::str::from_utf8(record.payload()).map_err(|error| SessionError::BadHeader {
        path: path.to_path_buf(),
        message: error.to_string(),
    })?;
    let header_value: serde_json::Value =
        serde_json::from_str(raw).map_err(|error| SessionError::BadHeader {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?;
    if header_value.get("type").and_then(serde_json::Value::as_str) != Some("session") {
        return Err(SessionError::BadHeader {
            path: path.to_path_buf(),
            message: "first line must be a session header".to_owned(),
        });
    }

    match serde_json::from_value(header_value).map_err(|error| SessionError::BadHeader {
        path: path.to_path_buf(),
        message: error.to_string(),
    })? {
        SessionLine::Header { version, name, .. } if version == SESSION_VERSION => {
            if name != expected_name {
                return Err(SessionError::BadHeader {
                    path: path.to_path_buf(),
                    message: format!(
                        "session name mismatch: expected {expected_name:?}, found {name:?}"
                    ),
                });
            }
            Ok(())
        }
        SessionLine::Header { version, .. } => Err(SessionError::BadHeader {
            path: path.to_path_buf(),
            message: format!("unsupported version {version}"),
        }),
        _ => Err(SessionError::BadHeader {
            path: path.to_path_buf(),
            message: "first line must be a header".to_owned(),
        }),
    }
}

fn parse_body_record(
    path: &Path,
    line: usize,
    payload: &[u8],
) -> Result<Option<SessionLine>, SessionError> {
    let raw = std::str::from_utf8(payload).map_err(|error| SessionError::BadEntry {
        path: path.to_path_buf(),
        line,
        message: error.to_string(),
    })?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(raw)
        .map(Some)
        .map_err(|error| SessionError::BadEntry {
            path: path.to_path_buf(),
            line,
            message: error.to_string(),
        })
}

#[derive(Debug, Default)]
struct SessionReplay {
    messages: Vec<Message>,
    pending_messages: Vec<DrainedMessage>,
    known_user_messages: Vec<DrainedMessage>,
    message_cursors: Vec<DurableMessageCursor>,
    restart_boundary: Option<SessionRestartBoundary>,
}

impl SessionReplay {
    fn into_loaded(self, warnings: Vec<String>) -> LoadedSession {
        let pending_messages = self.pending_messages;
        let known_user_messages = retain_recent_known_user_messages_for_replay(
            self.known_user_messages,
            &pending_messages,
            DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW,
        );
        let message_cursors = retain_recent_message_cursors_for_replay(
            self.message_cursors,
            DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW,
        );
        LoadedSession {
            initial_messages: repair_provider_transcript(self.messages),
            pending_messages,
            known_user_messages,
            message_cursors,
            restart_boundary: self.restart_boundary,
            warnings,
        }
    }
}

fn apply_session_line(
    path: &Path,
    line_no: usize,
    replay: &mut SessionReplay,
    entry: SessionLine,
) -> Result<(), SessionError> {
    match entry {
        SessionLine::Header { .. } => Err(SessionError::BadEntry {
            path: path.to_path_buf(),
            line: line_no,
            message: "header is only valid as the first line".to_owned(),
        }),
        SessionLine::AcceptedInput {
            message_id,
            cursor_seq,
            source,
            metadata,
            urgency,
            content,
        } => {
            let entry = SessionInputEntry {
                message_id,
                content,
                source,
                metadata,
                urgency,
                cursor_seq: Some(cursor_seq),
            };
            record_known_user_message(
                path,
                line_no,
                &mut replay.known_user_messages,
                entry.clone(),
            )?;
            record_pending_user_message(path, line_no, &mut replay.pending_messages, entry)
        }
        SessionLine::UserMessage {
            message_id,
            message,
        } => {
            if !matches!(message, Message::User { .. }) {
                return Err(bad_role(path, line_no, "user_message"));
            }
            if let Some(message_id) = message_id {
                let Message::User { content } = &message else {
                    return Err(bad_role(path, line_no, "user_message"));
                };
                record_known_user_message(
                    path,
                    line_no,
                    &mut replay.known_user_messages,
                    SessionInputEntry::normal_user(message_id.clone(), content.clone()),
                )?;
                remove_pending_message(&mut replay.pending_messages, &message_id);
            }
            replay.messages.push(message);
            Ok(())
        }
        SessionLine::AssistantMessage { message } => {
            if !matches!(message, Message::Assistant { .. }) {
                return Err(bad_role(path, line_no, "assistant_message"));
            }
            if is_terminal_assistant(&message) {
                replay.restart_boundary = None;
            }
            if message.is_valid_assistant_for_provider_replay() {
                replay.messages.push(message);
            }
            Ok(())
        }
        SessionLine::UserBatch {
            message_ids,
            messages: batch,
        } => {
            for message in &batch {
                if !matches!(message, Message::User { .. }) {
                    return Err(bad_role(path, line_no, "user_batch"));
                }
            }
            if let Some(message_ids) = message_ids {
                if message_ids.len() != batch.len() {
                    return Err(SessionError::BadEntry {
                        path: path.to_path_buf(),
                        line: line_no,
                        message: "user_batch message_ids length does not match messages".to_owned(),
                    });
                }
                for (message_id, message) in message_ids.iter().zip(&batch) {
                    let Message::User { content } = message else {
                        return Err(bad_role(path, line_no, "user_batch"));
                    };
                    record_known_user_message(
                        path,
                        line_no,
                        &mut replay.known_user_messages,
                        SessionInputEntry::normal_user(message_id.clone(), content.clone()),
                    )?;
                }
                for message_id in &message_ids {
                    remove_pending_message(&mut replay.pending_messages, message_id);
                }
            }
            replay.messages.extend(batch);
            Ok(())
        }
        SessionLine::ToolResult { result } => {
            replay.messages.push(Message::ToolResult(result));
            Ok(())
        }
        SessionLine::PendingInputRemoved {
            message_id,
            source: _,
            metadata: _,
            reason: _,
        } => {
            remove_pending_message(&mut replay.pending_messages, &message_id);
            Ok(())
        }
        SessionLine::Compaction {
            active_user_message_id,
            summary,
            retained_messages,
        } => {
            replay.messages.clear();
            replay.messages.push(Message::user(summary));
            replay
                .messages
                .extend(repair_provider_transcript(retained_messages));
            replay.restart_boundary = active_user_message_id.map(SessionRestartBoundary::new);
            Ok(())
        }
        SessionLine::MessageCursor {
            message_id,
            replay_start_seq,
            terminal_seq,
            replay_events,
        } => {
            let terminal_seq =
                durable_terminal_seq(replay_start_seq, terminal_seq, !replay_events.is_empty());
            if replay
                .restart_boundary
                .as_ref()
                .is_some_and(|boundary| boundary.active_user_message_id() == message_id.as_str())
            {
                replay.restart_boundary = None;
            }
            if let Some(position) = replay
                .message_cursors
                .iter_mut()
                .position(|cursor| cursor.message_id == message_id)
            {
                let mut existing = replay.message_cursors.remove(position);
                existing.replay_start_seq = replay_start_seq;
                existing.terminal_seq = terminal_seq;
                existing.replay_events = replay_events;
                replay.message_cursors.push(existing);
            } else {
                replay.message_cursors.push(DurableMessageCursor {
                    message_id,
                    replay_start_seq,
                    terminal_seq,
                    replay_events,
                });
            }
            Ok(())
        }
    }
}

fn truncate_session_file(path: &Path, len: u64) -> Result<(), SessionError> {
    let mut file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|source| SessionError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    truncate_session_file_with_writer(path, &mut file, len)
}

fn truncate_session_file_with_writer(
    path: &Path,
    file: &mut dyn SessionFileIo,
    len: u64,
) -> Result<(), SessionError> {
    file.set_len(len).map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    file.flush().map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    file.sync_data().map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn append_session_newline(path: &Path) -> Result<(), SessionError> {
    let mut file = OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|source| SessionError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    append_session_newline_with_writer(path, &mut file)
}

fn append_session_newline_with_writer(
    path: &Path,
    file: &mut dyn SessionFileIo,
) -> Result<(), SessionError> {
    file.write_bytes(b"\n").map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    file.flush().map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    file.sync_data().map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn is_terminal_assistant(message: &Message) -> bool {
    matches!(
        message,
        Message::Assistant {
            stop_reason: Some(StopReason::EndTurn),
            ..
        }
    )
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

#[derive(Clone)]
struct SessionInputEntry {
    message_id: String,
    content: Vec<ContentPart>,
    source: InputSource,
    metadata: Option<QueuedInputMetadata>,
    urgency: InputUrgency,
    cursor_seq: Option<u64>,
}

impl SessionInputEntry {
    fn normal_user(message_id: String, content: Vec<ContentPart>) -> Self {
        Self {
            message_id,
            content,
            source: InputSource::User,
            metadata: None,
            urgency: InputUrgency::Normal,
            cursor_seq: None,
        }
    }
}

fn record_known_user_message(
    path: &Path,
    line: usize,
    known_user_messages: &mut Vec<DrainedMessage>,
    entry: SessionInputEntry,
) -> Result<(), SessionError> {
    let SessionInputEntry {
        message_id,
        content,
        source,
        metadata,
        urgency,
        cursor_seq,
    } = entry;
    if let Some(position) = known_user_messages
        .iter()
        .position(|message| message.id == message_id)
    {
        let existing = &known_user_messages[position];
        if existing.content != content {
            return Err(SessionError::BadEntry {
                path: path.to_path_buf(),
                line,
                message: "message id reused with different content".to_owned(),
            });
        }
        let existing = known_user_messages.remove(position);
        known_user_messages.push(existing);
        return Ok(());
    }

    let mut message = DrainedMessage::new(message_id, content);
    message.source = source;
    message.urgency = urgency;
    message.metadata = metadata;
    message.cursor_seq = cursor_seq;
    known_user_messages.push(message);
    Ok(())
}

fn record_pending_user_message(
    path: &Path,
    line: usize,
    pending_messages: &mut Vec<DrainedMessage>,
    entry: SessionInputEntry,
) -> Result<(), SessionError> {
    let SessionInputEntry {
        message_id,
        content,
        source,
        metadata,
        urgency,
        cursor_seq,
    } = entry;
    if let Some(existing) = pending_messages
        .iter()
        .find(|message| message.id == message_id)
    {
        if existing.content != content {
            return Err(SessionError::BadEntry {
                path: path.to_path_buf(),
                line,
                message: "message id reused with different content".to_owned(),
            });
        }
        return Ok(());
    }

    let mut message = DrainedMessage::new(message_id, content);
    message.source = source;
    message.urgency = urgency;
    message.metadata = metadata;
    message.cursor_seq = cursor_seq;
    pending_messages.push(message);
    Ok(())
}

fn remove_pending_message(pending_messages: &mut Vec<DrainedMessage>, message_id: &str) {
    pending_messages.retain(|message| message.id != message_id);
}

fn bad_role(path: &Path, line: usize, entry_type: &str) -> SessionError {
    SessionError::BadEntry {
        path: path.to_path_buf(),
        line,
        message: format!("{entry_type} contains the wrong message role"),
    }
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
    Compaction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        active_user_message_id: Option<String>,
        summary: Vec<ContentPart>,
        #[serde(default)]
        retained_messages: Vec<Message>,
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
    use super::*;
    use std::io;
    use std::sync::{Arc, Mutex};

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
    }

    impl SpySessionFile {
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
    fn ordinary_transcript_and_compaction_remain_flush_only() {
        let message_spy = SpySessionFile::default();
        recorder_with_spy(message_spy.clone())
            .record_message_sync(&Message::assistant_text("ok"))
            .expect("ordinary transcript append should flush");
        assert_eq!(
            message_spy.operations(),
            vec![SpyFileOp::Write, SpyFileOp::Flush]
        );

        let compaction_spy = SpySessionFile::default();
        recorder_with_spy(compaction_spy.clone())
            .record_compaction_sync(&text_content("summary"), &[Message::assistant_text("kept")])
            .expect("compaction append should flush");
        assert_eq!(
            compaction_spy.operations(),
            vec![SpyFileOp::Write, SpyFileOp::Flush]
        );
    }

    #[test]
    fn durable_append_sync_data_failure_returns_error() {
        for operation in [
            "accepted_input",
            "user_batch",
            "pending_input_removed",
            "message_cursor",
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
