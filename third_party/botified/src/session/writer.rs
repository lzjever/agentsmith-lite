use std::fs::File;
use std::io::{self, Write};
use std::path::Path;
use std::sync::MutexGuard;

use crate::agent_loop::{AcceptedInputEntry, InputSource, QueuedInputMetadata};
use crate::types::Message;

use super::open::truncate_session_file_with_writer;
use super::{
    durable_terminal_seq, serialize_session_line, validate_delivery_intents,
    validate_projection_ids, CallbackDeliveryIntent, DurableMessageCursor, FileSessionRecorder,
    SessionAppendState, SessionError, SessionLine,
};

impl FileSessionRecorder {
    fn append_entry(
        &self,
        entry: SessionLine,
        durability: SessionAppendDurability,
    ) -> Result<(), SessionError> {
        let _path_lock = self
            .shared
            .path_lock
            .lock()
            .expect("session path lock poisoned");
        let line = serialize_session_line(&self.path, &entry)?;
        let mut append = self
            .shared
            .append
            .lock()
            .expect("session append state mutex poisoned");
        fail_if_compaction_poisoned(&self.path, &append)?;
        append_serialized_session_line(&self.path, append.file.as_mut(), &line, durability)
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
            Message::Assistant { tool_calls, .. } => self.append_entry(
                SessionLine::AssistantMessage {
                    message: message.clone(),
                },
                if tool_calls.is_empty() {
                    SessionAppendDurability::FlushOnly
                } else {
                    SessionAppendDurability::SyncData
                },
            ),
            Message::ToolResult(result) => self.append_entry(
                SessionLine::ToolResult {
                    result: result.bounded_for_transcript(),
                },
                SessionAppendDurability::FlushOnly,
            ),
        }
    }

    pub fn record_accepted_input_sync(
        &self,
        entry: &AcceptedInputEntry,
    ) -> Result<(), SessionError> {
        self.record_accepted_input_with_delivery_sync(entry, None)
    }

    pub(crate) fn record_accepted_input_with_delivery_sync(
        &self,
        entry: &AcceptedInputEntry,
        delivery: Option<&crate::agent_loop::MessageDelivery>,
    ) -> Result<(), SessionError> {
        self.append_entry(
            accepted_input_session_line(entry, delivery),
            SessionAppendDurability::SyncData,
        )
    }

    pub(crate) fn record_accepted_input_with_undo_sync(
        &self,
        entry: &AcceptedInputEntry,
    ) -> Result<super::AcceptedInputUndo<'_>, SessionError> {
        let session_line = accepted_input_session_line(entry, None);
        let path_lock = self
            .shared
            .path_lock
            .lock()
            .expect("session path lock poisoned");
        let line = serialize_session_line(&self.path, &session_line)?;
        let mut append = self
            .shared
            .append
            .lock()
            .expect("session append state mutex poisoned");
        fail_if_compaction_poisoned(&self.path, &append)?;
        let old_len = append.file.len().map_err(|source| SessionError::Io {
            path: self.path.clone(),
            source,
        })?;
        append_serialized_session_line_from_len(
            &self.path,
            append.file.as_mut(),
            &line,
            SessionAppendDurability::SyncData,
            old_len,
        )
        .map_err(|failure| failure.into_regular_error(&self.path))?;
        Ok(AcceptedInputUndo {
            path: &self.path,
            append,
            _path_lock: path_lock,
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

    pub fn record_unfinished_work_discarded_sync(
        &self,
        message_ids: &[String],
        projection_ids: &[String],
        reason: &str,
    ) -> Result<(), SessionError> {
        validate_projection_ids(&self.path, 0, projection_ids)?;
        self.append_entry(
            SessionLine::UnfinishedWorkDiscarded {
                message_ids: message_ids.to_vec(),
                projection_ids: projection_ids.to_vec(),
                reason: reason.to_owned(),
            },
            SessionAppendDurability::SyncData,
        )
    }

    pub fn record_user_batch_sync(&self, messages: &[Message]) -> Result<(), SessionError> {
        self.append_user_batch_entry(messages, None, &[])
    }

    pub fn record_user_batch_with_ids_sync(
        &self,
        messages: &[Message],
        message_ids: &[String],
    ) -> Result<(), SessionError> {
        self.record_user_batch_with_ids_and_delivery_intents_sync(messages, message_ids, &[])
    }

    pub fn record_user_batch_with_ids_and_delivery_intents_sync(
        &self,
        messages: &[Message],
        message_ids: &[String],
        delivery_intents: &[CallbackDeliveryIntent],
    ) -> Result<(), SessionError> {
        self.append_user_batch_entry(messages, Some(message_ids), delivery_intents)
    }

    pub fn record_delivery_projected_sync(
        &self,
        projection_ids: &[String],
    ) -> Result<(), SessionError> {
        validate_projection_ids(&self.path, 0, projection_ids)?;
        self.append_entry(
            SessionLine::DeliveryProjected {
                projection_ids: projection_ids.to_vec(),
            },
            SessionAppendDurability::SyncData,
        )
    }

    fn append_user_batch_entry(
        &self,
        messages: &[Message],
        message_ids: Option<&[String]>,
        delivery_intents: &[CallbackDeliveryIntent],
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
        validate_delivery_intents(&self.path, 0, delivery_intents)?;
        if delivery_intents.is_empty() && matches!(messages, [_]) {
            return self.append_entry(
                SessionLine::UserMessage {
                    message_id: message_ids.and_then(|ids| ids.first().cloned()),
                    message: messages[0].clone(),
                },
                SessionAppendDurability::SyncData,
            );
        }
        self.append_entry(
            SessionLine::UserBatch {
                message_ids: message_ids.map(|ids| ids.to_vec()),
                messages: messages.to_vec(),
                delivery_intents: delivery_intents.to_vec(),
            },
            SessionAppendDurability::SyncData,
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
    append: MutexGuard<'a, SessionAppendState>,
    _path_lock: MutexGuard<'a, ()>,
    old_len: u64,
    active: bool,
}

impl AcceptedInputUndo<'_> {
    pub(crate) fn commit(mut self) {
        self.active = false;
    }

    pub(crate) fn rollback(mut self) -> Result<(), SessionError> {
        self.active = false;
        truncate_session_file_with_writer(self.path, self.append.file.as_mut(), self.old_len)
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
pub(super) enum SessionAppendDurability {
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

fn accepted_input_session_line(
    entry: &AcceptedInputEntry,
    delivery: Option<&crate::agent_loop::MessageDelivery>,
) -> SessionLine {
    SessionLine::AcceptedInput {
        message_id: entry.message_id.clone(),
        cursor_seq: entry.cursor_seq,
        source: entry.source,
        metadata: entry.metadata.clone(),
        urgency: entry.urgency,
        delivery: delivery.cloned(),
        content: entry.content.clone(),
    }
}

pub(super) fn append_serialized_session_line(
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
        .map_err(|failure| failure.into_regular_error(path))
}

pub(super) fn append_serialized_compaction_line(
    path: &Path,
    file: &mut dyn SessionFileIo,
    line: &str,
) -> Result<(), SessionError> {
    let old_len = file.len().map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    append_serialized_session_line_from_len(
        path,
        file,
        line,
        SessionAppendDurability::SyncData,
        old_len,
    )
    .map_err(|failure| match failure {
        SessionAppendFailure::Original(error) => error,
        SessionAppendFailure::RollbackAmbiguous { original, rollback } => {
            SessionError::AmbiguousStorage {
                path: path.to_path_buf(),
                message: format!(
                    "compaction append rollback failed; original error: {original}; rollback error: {rollback}"
                ),
            }
        }
    })
}

pub(super) fn fail_if_compaction_poisoned(
    path: &Path,
    append: &SessionAppendState,
) -> Result<(), SessionError> {
    if append.compaction_poisoned {
        return Err(SessionError::AmbiguousStorage {
            path: path.to_path_buf(),
            message: "a prior compaction rollback failed".to_owned(),
        });
    }
    Ok(())
}

fn append_serialized_session_line_from_len(
    path: &Path,
    file: &mut dyn SessionFileIo,
    line: &str,
    durability: SessionAppendDurability,
    old_len: u64,
) -> Result<(), SessionAppendFailure> {
    if let Err(source) = file.write_line(line) {
        return Err(rollback_session_append_failure(
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
        return Err(rollback_session_append_failure(
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
            return Err(rollback_session_append_failure(
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

enum SessionAppendFailure {
    Original(SessionError),
    RollbackAmbiguous {
        original: SessionError,
        rollback: SessionError,
    },
}

fn rollback_session_append_failure(
    path: &Path,
    file: &mut dyn SessionFileIo,
    old_len: u64,
    original: SessionError,
) -> SessionAppendFailure {
    match truncate_session_file_with_writer(path, file, old_len) {
        Ok(()) => SessionAppendFailure::Original(original),
        Err(rollback) => SessionAppendFailure::RollbackAmbiguous { original, rollback },
    }
}

impl SessionAppendFailure {
    fn into_regular_error(self, path: &Path) -> SessionError {
        match self {
            Self::Original(error) => error,
            Self::RollbackAmbiguous { original, rollback } => {
                session_append_rollback_error(path, original, rollback)
            }
        }
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
