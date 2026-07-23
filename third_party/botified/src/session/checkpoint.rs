use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(test)]
use std::cell::RefCell;

use crate::private_fs::{open_private_file, private_open_options};
use crate::types::{ContentPart, Message};

use super::writer::{append_serialized_compaction_line, fail_if_compaction_poisoned};
use super::{
    replay, serialize_session_line, sync_session_parent_dir, CompactionMetadata,
    FileSessionRecorder, LoadedSession, SessionError, SessionLine,
};

impl FileSessionRecorder {
    pub fn record_compaction_sync(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
    ) -> Result<(), SessionError> {
        self.record_compaction_with_metadata_sync(summary, retained_messages, None)
    }

    pub fn record_compaction_with_metadata_sync(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        metadata: Option<&CompactionMetadata>,
    ) -> Result<(), SessionError> {
        self.record_compaction_with_active_user_message_id_and_metadata_sync(
            summary,
            retained_messages,
            None,
            metadata,
        )
    }

    pub fn record_compaction_with_active_user_message_id_sync(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        active_user_message_id: Option<&str>,
    ) -> Result<(), SessionError> {
        self.record_compaction_with_active_user_message_id_and_metadata_sync(
            summary,
            retained_messages,
            active_user_message_id,
            None,
        )
    }

    pub fn record_compaction_with_active_user_message_id_and_metadata_sync(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        active_user_message_id: Option<&str>,
        metadata: Option<&CompactionMetadata>,
    ) -> Result<(), SessionError> {
        let retained_messages = bound_retained_messages_for_transcript(retained_messages);
        let compaction = SessionLine::Compaction {
            active_user_message_id: active_user_message_id.map(ToOwned::to_owned),
            active_input_ids: None,
            active_user_message_index: None,
            summary: summary.to_vec(),
            retained_messages,
            metadata: metadata.cloned(),
        };
        let _path_lock = self
            .shared
            .path_lock
            .lock()
            .expect("session path lock poisoned");
        let mut append = self
            .shared
            .append
            .lock()
            .expect("session append state mutex poisoned");
        fail_if_compaction_poisoned(&self.path, &append)?;
        let line = serialize_session_line(&self.path, &compaction)?;
        if let Err(error) =
            append_serialized_compaction_line(&self.path, append.file.as_mut(), &line)
        {
            if matches!(error, SessionError::AmbiguousStorage { .. }) {
                append.compaction_poisoned = true;
            }
            return Err(error);
        }

        // Checkpointing is an optimization after the existing successful append boundary.
        // Any failure leaves that append and its open file handle as the source of truth.
        if self.filesystem_backed {
            if let Ok(replacement) = write_session_checkpoint(&self.path, &compaction) {
                append.file = Box::new(replacement.file);
            }
        }
        Ok(())
    }
}

struct CheckpointReplacement {
    file: File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckpointFailureStep {
    TempOpen,
    TempWrite,
    TempFlush,
    TempSyncData,
    ReplacementOpen,
    PreRenameDirSync,
    Rename,
    PostRenameDirSync,
    Cleanup,
}

#[cfg(test)]
thread_local! {
    static CHECKPOINT_FAILURES: RefCell<Vec<CheckpointFailureStep>> = const { RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn with_checkpoint_failures<T>(
    failures: &[CheckpointFailureStep],
    action: impl FnOnce() -> T,
) -> T {
    CHECKPOINT_FAILURES.with(|configured| {
        let previous = configured.replace(failures.to_vec());
        let result = action();
        configured.replace(previous);
        result
    })
}

fn inject_checkpoint_failure(path: &Path, step: CheckpointFailureStep) -> Result<(), SessionError> {
    #[cfg(test)]
    if CHECKPOINT_FAILURES.with(|failures| failures.borrow().contains(&step)) {
        return Err(SessionError::Io {
            path: path.to_path_buf(),
            source: std::io::Error::other(format!("injected checkpoint {step:?} failure")),
        });
    }
    let _ = (path, step);
    Ok(())
}

fn write_session_checkpoint(
    path: &Path,
    compaction: &SessionLine,
) -> Result<CheckpointReplacement, SessionError> {
    let expected_name = match replay::read_session_header(path)? {
        SessionLine::Header { ref name, .. } => name.clone(),
        _ => unreachable!("read_session_header only returns headers"),
    };
    let loaded = replay::load_session(path, &expected_name)?;
    let header = replay::read_session_header(path)?;
    let checkpoint_lines = checkpoint_session_lines(header, loaded, compaction.clone());
    let temp_path = checkpoint_temp_path(path);

    let result = (|| {
        inject_checkpoint_failure(&temp_path, CheckpointFailureStep::TempOpen)?;
        let mut temp_options = private_open_options();
        temp_options.write(true).create_new(true);
        let mut temp =
            open_private_file(&temp_options, &temp_path).map_err(|source| SessionError::Io {
                path: temp_path.clone(),
                source,
            })?;
        for entry in checkpoint_lines {
            inject_checkpoint_failure(&temp_path, CheckpointFailureStep::TempWrite)?;
            let line = serialize_session_line(&temp_path, &entry)?;
            temp.write_all(line.as_bytes())
                .and_then(|()| temp.write_all(b"\n"))
                .map_err(|source| SessionError::Io {
                    path: temp_path.clone(),
                    source,
                })?;
        }
        inject_checkpoint_failure(&temp_path, CheckpointFailureStep::TempFlush)?;
        Write::flush(&mut temp).map_err(|source| SessionError::Io {
            path: temp_path.clone(),
            source,
        })?;
        inject_checkpoint_failure(&temp_path, CheckpointFailureStep::TempSyncData)?;
        temp.sync_data().map_err(|source| SessionError::Io {
            path: temp_path.clone(),
            source,
        })?;
        let mut replacement_options = private_open_options();
        replacement_options.append(true);
        inject_checkpoint_failure(&temp_path, CheckpointFailureStep::ReplacementOpen)?;
        let replacement =
            open_private_file(&replacement_options, &temp_path).map_err(|source| {
                SessionError::Io {
                    path: temp_path.clone(),
                    source,
                }
            })?;
        inject_checkpoint_failure(path, CheckpointFailureStep::PreRenameDirSync)?;
        sync_session_parent_dir(path)?;
        inject_checkpoint_failure(path, CheckpointFailureStep::Rename)?;
        fs::rename(&temp_path, path).map_err(|source| SessionError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let _ = inject_checkpoint_failure(path, CheckpointFailureStep::PostRenameDirSync)
            .and_then(|()| sync_session_parent_dir(path));
        Ok(CheckpointReplacement { file: replacement })
    })();

    if result.is_err()
        && inject_checkpoint_failure(&temp_path, CheckpointFailureStep::Cleanup).is_ok()
    {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn checkpoint_session_lines(
    header: SessionLine,
    loaded: LoadedSession,
    compaction: SessionLine,
) -> Vec<SessionLine> {
    let pending_ids = loaded
        .pending_messages
        .iter()
        .map(|message| message.id.clone())
        .collect::<HashSet<_>>();
    let mut lines = vec![header];
    for message in loaded.known_user_messages {
        if let Some(cursor_seq) = message.cursor_seq {
            lines.push(SessionLine::AcceptedInput {
                message_id: message.id.clone(),
                cursor_seq,
                source: message.source,
                urgency: message.urgency,
                metadata: message.metadata.clone(),
                delivery: message.delivery.clone(),
                content: message.content.clone(),
            });
        }
        if !pending_ids.contains(&message.id) {
            lines.push(SessionLine::UserMessage {
                message_id: Some(message.id),
                message: Message::user(message.content),
            });
        }
    }
    if !loaded.pending_delivery_intents.is_empty() {
        lines.push(SessionLine::UserBatch {
            message_ids: Some(Vec::new()),
            messages: Vec::new(),
            delivery_intents: loaded.pending_delivery_intents,
        });
    }
    lines.extend(
        loaded
            .message_cursors
            .into_iter()
            .map(|cursor| SessionLine::MessageCursor {
                message_id: cursor.message_id,
                replay_start_seq: cursor.replay_start_seq,
                terminal_seq: cursor.terminal_seq,
                replay_events: cursor.replay_events,
            }),
    );
    let compaction = match (compaction, loaded.restart_boundary) {
        (
            SessionLine::Compaction {
                active_user_message_id,
                summary,
                retained_messages,
                metadata,
                ..
            },
            boundary,
        ) => SessionLine::Compaction {
            active_user_message_id,
            active_input_ids: boundary
                .as_ref()
                .map(|boundary| boundary.active_input_ids.clone()),
            active_user_message_index: boundary
                .and_then(|boundary| boundary.active_user_message_index),
            summary,
            retained_messages,
            metadata,
        },
        _ => unreachable!("checkpoint compaction must be a compaction line"),
    };
    lines.push(compaction);
    lines
}

fn checkpoint_temp_path(path: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.jsonl");
    path.with_file_name(format!(
        ".{file_name}.checkpoint-{}-{nonce}.tmp",
        std::process::id()
    ))
}

fn bound_retained_messages_for_transcript(messages: &[Message]) -> Vec<Message> {
    messages
        .iter()
        .map(|message| match message {
            Message::ToolResult(result) => Message::ToolResult(result.bounded_for_transcript()),
            _ => message.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::open_or_create_session_in_home;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_home(label: &str) -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "botified-session-checkpoint-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn pre_rename_checkpoint_failures_are_best_effort_after_truth_sync() {
        for step in [
            CheckpointFailureStep::TempOpen,
            CheckpointFailureStep::TempWrite,
            CheckpointFailureStep::TempFlush,
            CheckpointFailureStep::TempSyncData,
            CheckpointFailureStep::ReplacementOpen,
            CheckpointFailureStep::PreRenameDirSync,
            CheckpointFailureStep::Rename,
        ] {
            let home = temp_home(&format!("pre-{step:?}"));
            let opened = open_or_create_session_in_home("checkpoint", &home).unwrap();
            opened
                .recorder()
                .record_message_sync(&Message::assistant_text("obsolete"))
                .unwrap();

            with_checkpoint_failures(&[step], || {
                opened
                    .recorder()
                    .record_compaction_sync(&[ContentPart::text("summary")], &[])
            })
            .expect("checkpoint optimization failure must not flip durable truth");
            opened
                .recorder()
                .record_message_sync(&Message::assistant_text("after truth"))
                .expect("the existing append handle should remain usable");
            drop(opened);

            let replayed = open_or_create_session_in_home("checkpoint", &home).unwrap();
            assert_eq!(
                replayed.initial_messages(),
                &[
                    Message::user(vec![ContentPart::text("summary")]),
                    Message::assistant_text("after truth"),
                ],
                "{step:?}"
            );
            let _ = fs::remove_dir_all(home);
        }
    }

    #[test]
    fn post_rename_sync_failure_keeps_replacement_for_second_recorder() {
        let home = temp_home("post-rename");
        let first = open_or_create_session_in_home("checkpoint", &home).unwrap();
        let second = open_or_create_session_in_home("checkpoint", &home).unwrap();
        first
            .recorder()
            .record_message_sync(&Message::assistant_text("obsolete"))
            .unwrap();

        with_checkpoint_failures(&[CheckpointFailureStep::PostRenameDirSync], || {
            first
                .recorder()
                .record_compaction_sync(&[ContentPart::text("summary")], &[])
        })
        .expect("post-rename sync is best effort once truth and rename succeeded");
        second
            .recorder()
            .record_message_sync(&Message::assistant_text(
                "second recorder replacement append",
            ))
            .unwrap();
        drop(first);
        drop(second);

        let replayed = open_or_create_session_in_home("checkpoint", &home).unwrap();
        assert_eq!(
            replayed.initial_messages(),
            &[
                Message::user(vec![ContentPart::text("summary")]),
                Message::assistant_text("second recorder replacement append"),
            ]
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn checkpoint_cleanup_failure_is_best_effort_after_truth_sync() {
        let home = temp_home("cleanup");
        let opened = open_or_create_session_in_home("checkpoint", &home).unwrap();
        with_checkpoint_failures(
            &[
                CheckpointFailureStep::TempWrite,
                CheckpointFailureStep::Cleanup,
            ],
            || {
                opened
                    .recorder()
                    .record_compaction_sync(&[ContentPart::text("summary")], &[])
            },
        )
        .expect("cleanup failure must not flip durable compaction truth");
        let sessions = home.join("sessions");
        assert!(fs::read_dir(&sessions).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".checkpoint-")
        }));
        drop(opened);

        let reopened = open_or_create_session_in_home("checkpoint", &home)
            .expect("startup should clean the abandoned checkpoint temp");
        assert_eq!(
            reopened.initial_messages(),
            &[Message::user(vec![ContentPart::text("summary")])]
        );
        let _ = fs::remove_dir_all(home);
    }
}
