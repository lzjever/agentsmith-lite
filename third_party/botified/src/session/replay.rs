use std::io::{BufRead, BufReader};

use crate::transcript::{
    repair_provider_transcript, request_range_contains_synthetic_missing_tool_result,
};

use super::open::{append_session_newline, truncate_session_file};
use super::*;

pub(super) fn read_session_header(path: &Path) -> Result<SessionLine, SessionError> {
    let file = File::open(path).map_err(|source| SessionError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut reader = BufReader::new(file);
    let record =
        read_raw_record(path, &mut reader, 1, 0)?.ok_or_else(|| SessionError::BadHeader {
            path: path.to_path_buf(),
            message: "missing header".to_owned(),
        })?;
    let raw = std::str::from_utf8(record.payload()).map_err(|error| SessionError::BadHeader {
        path: path.to_path_buf(),
        message: error.to_string(),
    })?;
    serde_json::from_str(raw).map_err(|error| SessionError::BadHeader {
        path: path.to_path_buf(),
        message: error.to_string(),
    })
}

pub(super) fn load_session(
    path: &Path,
    expected_name: &str,
) -> Result<LoadedSession, SessionError> {
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

    let mut replay = SessionReplayAccumulator::default();
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
struct SessionReplayAccumulator {
    messages: Vec<Message>,
    message_ids: Vec<Option<String>>,
    user_batch_spans: Vec<UserBatchSpan>,
    pending_messages: Vec<DrainedMessage>,
    known_user_messages: Vec<DrainedMessage>,
    message_cursors: Vec<DurableMessageCursor>,
    delivery_intents: Vec<CallbackDeliveryIntent>,
    delivery_projection_ids: HashSet<String>,
    projected_delivery_ids: HashSet<String>,
    restart_boundary: Option<SessionRestartBoundary>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UserBatchSpan {
    start: usize,
    len: usize,
    message_ids: Vec<String>,
}

impl UserBatchSpan {
    fn end(&self) -> usize {
        self.start.saturating_add(self.len)
    }

    fn contains(&self, index: usize) -> bool {
        index >= self.start && index < self.end()
    }
}

impl SessionReplayAccumulator {
    fn into_loaded(self, warnings: Vec<String>) -> LoadedSession {
        let pending_messages = self.pending_messages;
        let completed_cursor_message_ids = self
            .message_cursors
            .iter()
            .filter(|cursor| {
                cursor
                    .replay_events
                    .iter()
                    .any(|event| matches!(event, ThreadEvent::TurnCompleted { .. }))
            })
            .map(|cursor| cursor.message_id.clone())
            .collect::<HashSet<_>>();
        let message_cursors = retain_recent_message_cursors_for_replay(
            self.message_cursors,
            DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW,
        );
        let restart_boundary = self.restart_boundary.or_else(|| {
            infer_open_request_restart_boundary(
                &self.messages,
                &self.message_ids,
                &self.user_batch_spans,
                &completed_cursor_message_ids,
            )
        });
        let (initial_messages, restart_boundary) =
            repair_transcript_and_remap_restart_boundary(self.messages, restart_boundary);
        let protected_message_ids = restart_boundary
            .as_ref()
            .map(SessionRestartBoundary::active_input_ids)
            .unwrap_or(&[]);
        let known_user_messages = retain_recent_known_user_messages_for_replay(
            self.known_user_messages,
            &pending_messages,
            DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW,
            protected_message_ids,
        );
        let pending_delivery_intents = self
            .delivery_intents
            .iter()
            .filter(|intent| !self.projected_delivery_ids.contains(&intent.projection_id))
            .cloned()
            .collect();
        LoadedSession {
            initial_messages,
            pending_messages,
            known_user_messages,
            message_cursors,
            pending_delivery_intents,
            restart_boundary,
            warnings,
        }
    }
}

fn repair_transcript_and_remap_restart_boundary(
    raw_messages: Vec<Message>,
    restart_boundary: Option<SessionRestartBoundary>,
) -> (Vec<Message>, Option<SessionRestartBoundary>) {
    let repaired_messages = repair_provider_transcript(raw_messages.clone());
    let restart_boundary = restart_boundary.and_then(|boundary| {
        let raw_request_start = boundary.active_user_message_index.filter(|index| {
            raw_messages
                .get(*index)
                .is_some_and(|message| matches!(message, Message::User { .. }))
        });
        let repaired_request = raw_request_start
            .map(|start| repair_provider_transcript(raw_messages[start..].to_vec()))
            .unwrap_or_else(|| repaired_messages.clone());
        if request_range_contains_synthetic_missing_tool_result(
            &repaired_request,
            0..repaired_request.len(),
        ) || request_contains_terminating_tool_result(&repaired_request)
        {
            return None;
        }

        let repaired_request_start = raw_request_start
            .map(|start| repair_provider_transcript(raw_messages[..start].to_vec()).len());
        Some(
            SessionRestartBoundary::with_active_input_ids_and_active_user_message_index(
                boundary.active_input_ids,
                repaired_request_start,
            ),
        )
    });
    (repaired_messages, restart_boundary)
}

fn infer_open_request_restart_boundary(
    messages: &[Message],
    message_ids: &[Option<String>],
    user_batch_spans: &[UserBatchSpan],
    completed_cursor_message_ids: &HashSet<String>,
) -> Option<SessionRestartBoundary> {
    if messages.len() != message_ids.len() {
        return None;
    }

    let mut active_user: Option<(Vec<String>, usize)> = None;
    for (index, message) in messages.iter().enumerate() {
        if is_terminal_request_message(message) {
            active_user = None;
            continue;
        }
        if matches!(message, Message::User { .. }) {
            if user_batch_spans
                .iter()
                .any(|span| span.contains(index) && span.start != index)
            {
                continue;
            }
            let active_input_ids =
                open_request_active_input_ids(message_ids, user_batch_spans, index);
            let Some(message_id) = active_input_ids.first() else {
                continue;
            };
            if completed_cursor_message_ids.contains(message_id)
                && request_has_provider_progress_after_open_request(
                    messages,
                    user_batch_spans,
                    index,
                )
            {
                active_user = None;
                continue;
            }
            active_user = Some((active_input_ids, index));
        }
    }

    active_user.map(|(active_input_ids, index)| {
        SessionRestartBoundary::with_active_input_ids_and_active_user_message_index(
            active_input_ids,
            Some(index),
        )
    })
}

fn open_request_active_input_ids(
    message_ids: &[Option<String>],
    user_batch_spans: &[UserBatchSpan],
    user_index: usize,
) -> Vec<String> {
    if let Some(span) = user_batch_spans
        .iter()
        .find(|span| span.start == user_index && span.len == span.message_ids.len())
    {
        return span.message_ids.clone();
    }
    message_ids
        .get(user_index)
        .and_then(|message_id| message_id.clone())
        .into_iter()
        .collect()
}

fn consecutive_user_message_ids_from(
    messages: &[Message],
    message_ids: &[Option<String>],
    user_index: usize,
) -> Vec<String> {
    if messages.len() != message_ids.len() {
        return Vec::new();
    }
    messages
        .iter()
        .zip(message_ids)
        .skip(user_index)
        .take_while(|(message, _)| matches!(message, Message::User { .. }))
        .map_while(|(_, message_id)| message_id.clone())
        .collect()
}

fn request_has_provider_progress_after_open_request(
    messages: &[Message],
    user_batch_spans: &[UserBatchSpan],
    user_index: usize,
) -> bool {
    let request_end = user_batch_spans
        .iter()
        .find(|span| span.contains(user_index))
        .map(UserBatchSpan::end)
        .unwrap_or_else(|| user_index.saturating_add(1));
    messages
        .iter()
        .skip(request_end)
        .take_while(|message| !matches!(message, Message::User { .. }))
        .any(|message| matches!(message, Message::Assistant { .. } | Message::ToolResult(_)))
}

fn compaction_retained_message_ids(
    messages: &[Message],
    message_ids: &[Option<String>],
    retained_messages: &[Message],
) -> Vec<Option<String>> {
    let mut retained_message_ids = vec![None; retained_messages.len()];
    if message_ids.len() != messages.len() {
        return retained_message_ids;
    }

    let suffix_len = messages
        .iter()
        .rev()
        .zip(retained_messages.iter().rev())
        .take_while(|(message, retained)| compaction_retained_message_matches(message, retained))
        .count();
    if suffix_len > 0 {
        let message_id_start = messages.len() - suffix_len;
        let retained_id_start = retained_messages.len() - suffix_len;
        retained_message_ids[retained_id_start..]
            .clone_from_slice(&message_ids[message_id_start..]);
    }
    retained_message_ids
}

fn compaction_retained_message_matches(message: &Message, retained: &Message) -> bool {
    match (message, retained) {
        (
            Message::Assistant {
                content,
                tool_calls,
                assistant_replay,
                stop_reason,
                ..
            },
            Message::Assistant {
                content: retained_content,
                tool_calls: retained_tool_calls,
                assistant_replay: retained_assistant_replay,
                stop_reason: retained_stop_reason,
                ..
            },
        ) => {
            content == retained_content
                && tool_calls == retained_tool_calls
                && assistant_replay == retained_assistant_replay
                && stop_reason == retained_stop_reason
        }
        _ => message == retained,
    }
}

fn apply_session_line(
    path: &Path,
    line_no: usize,
    replay: &mut SessionReplayAccumulator,
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
            delivery,
            content,
        } => {
            let entry = SessionInputEntry {
                message_id,
                content,
                source,
                metadata,
                urgency,
                cursor_seq: Some(cursor_seq),
                delivery,
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
            let replay_message_id = message_id.clone();
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
            replay.message_ids.push(replay_message_id);
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
                replay.message_ids.push(None);
            }
            Ok(())
        }
        SessionLine::UserBatch {
            message_ids,
            messages: batch,
            delivery_intents,
        } => {
            validate_delivery_intents(path, line_no, &delivery_intents)?;
            for message in &batch {
                if !matches!(message, Message::User { .. }) {
                    return Err(bad_role(path, line_no, "user_batch"));
                }
            }
            let batch_start = replay.messages.len();
            let batch_len = batch.len();
            let mut user_batch_span = None;
            let replay_message_ids = if let Some(message_ids) = message_ids {
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
                user_batch_span = Some(UserBatchSpan {
                    start: batch_start,
                    len: batch_len,
                    message_ids: message_ids.clone(),
                });
                message_ids.into_iter().map(Some).collect::<Vec<_>>()
            } else {
                vec![None; batch.len()]
            };
            replay.messages.extend(batch);
            replay.message_ids.extend(replay_message_ids);
            if let Some(user_batch_span) = user_batch_span {
                replay.user_batch_spans.push(user_batch_span);
            }
            for intent in delivery_intents {
                if replay
                    .delivery_projection_ids
                    .insert(intent.projection_id.clone())
                {
                    replay.delivery_intents.push(intent);
                } else if replay
                    .delivery_intents
                    .iter()
                    .find(|existing| existing.projection_id == intent.projection_id)
                    .is_some_and(|existing| existing != &intent)
                {
                    return Err(SessionError::BadEntry {
                        path: path.to_path_buf(),
                        line: line_no,
                        message: format!(
                            "conflicting callback delivery intent for projection_id {:?}",
                            intent.projection_id
                        ),
                    });
                }
            }
            Ok(())
        }
        SessionLine::DeliveryProjected { projection_ids } => {
            validate_projection_ids(path, line_no, &projection_ids)?;
            for projection_id in projection_ids {
                if replay.delivery_projection_ids.contains(&projection_id) {
                    replay.projected_delivery_ids.insert(projection_id);
                }
            }
            Ok(())
        }
        SessionLine::ToolResult { result } => {
            if result.terminate {
                replay.restart_boundary = None;
            }
            replay.messages.push(Message::ToolResult(result));
            replay.message_ids.push(None);
            Ok(())
        }
        SessionLine::PendingInputRemoved {
            message_id,
            source: _,
            metadata: _,
            reason: _,
        } => {
            if replay
                .restart_boundary
                .as_ref()
                .is_some_and(|boundary| boundary.contains_active_input_id(&message_id))
            {
                replay.restart_boundary = None;
            }
            remove_pending_message(&mut replay.pending_messages, &message_id);
            if remove_replayed_message(&mut replay.messages, &mut replay.message_ids, &message_id) {
                replay.user_batch_spans.clear();
            }
            Ok(())
        }
        SessionLine::UnfinishedWorkDiscarded {
            message_ids,
            projection_ids,
            reason: _,
        } => {
            let discarded_request_start = message_ids
                .iter()
                .filter_map(|message_id| {
                    replay
                        .message_ids
                        .iter()
                        .position(|stored_id| stored_id.as_deref() == Some(message_id))
                })
                .min();
            if let Some(request_start) = discarded_request_start.or_else(|| {
                replay
                    .restart_boundary
                    .as_ref()
                    .map(|boundary| boundary.current_request_start(&replay.messages))
            }) {
                replay.messages.truncate(request_start);
                replay.message_ids.truncate(request_start);
                replay.user_batch_spans.clear();
            }
            for message_id in message_ids {
                remove_pending_message(&mut replay.pending_messages, &message_id);
                replay
                    .known_user_messages
                    .retain(|message| message.id != message_id);
                replay
                    .message_cursors
                    .retain(|cursor| cursor.message_id != message_id);
                remove_replayed_message(&mut replay.messages, &mut replay.message_ids, &message_id);
            }
            replay
                .delivery_intents
                .retain(|intent| !projection_ids.contains(&intent.projection_id));
            replay.restart_boundary = None;
            Ok(())
        }
        SessionLine::Compaction {
            active_user_message_id,
            active_input_ids,
            active_user_message_index: stored_active_user_message_index,
            summary,
            retained_messages,
            metadata: _,
        } => {
            let retained_message_ids = compaction_retained_message_ids(
                &replay.messages,
                &replay.message_ids,
                &retained_messages,
            );
            let inferred_raw_active_user_message_index =
                active_user_message_id.as_deref().and_then(|id| {
                    retained_message_ids
                        .iter()
                        .position(|message_id| message_id.as_deref() == Some(id))
                        .and_then(|retained_index| {
                            retained_messages
                                .get(retained_index)
                                .is_some_and(|message| matches!(message, Message::User { .. }))
                                .then_some(1 + retained_index)
                        })
                });
            let restart_boundary = active_user_message_id.map(|message_id| {
                let inferred_active_input_ids = inferred_raw_active_user_message_index
                    .and_then(|index| index.checked_sub(1))
                    .map(|retained_index| {
                        consecutive_user_message_ids_from(
                            &retained_messages,
                            &retained_message_ids,
                            retained_index,
                        )
                    })
                    .filter(|ids| ids.first().is_some_and(|id| id == &message_id))
                    .unwrap_or_else(|| vec![message_id]);
                let active_input_ids = active_input_ids
                    .filter(|ids| !ids.is_empty())
                    .unwrap_or(inferred_active_input_ids);
                SessionRestartBoundary::with_active_input_ids_and_active_user_message_index(
                    active_input_ids,
                    stored_active_user_message_index.or(inferred_raw_active_user_message_index),
                )
            });
            let mut raw_context = vec![Message::user(summary)];
            raw_context.extend(retained_messages);
            let raw_context_len = raw_context.len();
            let (repaired_context, restart_boundary) =
                repair_transcript_and_remap_restart_boundary(raw_context, restart_boundary);
            replay.message_ids = if repaired_context.len() == raw_context_len {
                std::iter::once(None).chain(retained_message_ids).collect()
            } else {
                vec![None; repaired_context.len()]
            };
            replay.messages = repaired_context;
            replay.user_batch_spans.clear();
            replay.restart_boundary = restart_boundary;
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
                .is_some_and(|boundary| boundary.contains_active_input_id(&message_id))
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

fn is_terminal_assistant(message: &Message) -> bool {
    matches!(
        message,
        Message::Assistant {
            stop_reason: Some(StopReason::EndTurn | StopReason::ToolTerminated),
            ..
        }
    )
}

fn is_terminal_request_message(message: &Message) -> bool {
    is_terminal_assistant(message)
        || matches!(message, Message::ToolResult(result) if result.terminate)
}

fn request_contains_terminating_tool_result(messages: &[Message]) -> bool {
    messages
        .iter()
        .any(|message| matches!(message, Message::ToolResult(result) if result.terminate))
}

#[derive(Clone)]
struct SessionInputEntry {
    message_id: String,
    content: Vec<ContentPart>,
    source: InputSource,
    metadata: Option<QueuedInputMetadata>,
    urgency: InputUrgency,
    cursor_seq: Option<u64>,
    delivery: Option<crate::agent_loop::MessageDelivery>,
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
            delivery: None,
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
        delivery,
    } = entry;
    if let Some(position) = known_user_messages
        .iter()
        .position(|message| message.id == message_id)
    {
        let existing = &known_user_messages[position];
        if existing.content != content
            || delivery
                .as_ref()
                .is_some_and(|delivery| existing.delivery.as_ref() != Some(delivery))
        {
            return Err(SessionError::BadEntry {
                path: path.to_path_buf(),
                line,
                message: "message id reused with different content or delivery identity".to_owned(),
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
    message.delivery = delivery;
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
        delivery,
    } = entry;
    if let Some(existing) = pending_messages
        .iter()
        .find(|message| message.id == message_id)
    {
        if existing.content != content || existing.delivery != delivery {
            return Err(SessionError::BadEntry {
                path: path.to_path_buf(),
                line,
                message: "message id reused with different content or delivery identity".to_owned(),
            });
        }
        return Ok(());
    }

    let mut message = DrainedMessage::new(message_id, content);
    message.source = source;
    message.urgency = urgency;
    message.metadata = metadata;
    message.cursor_seq = cursor_seq;
    message.delivery = delivery;
    pending_messages.push(message);
    Ok(())
}

fn remove_pending_message(pending_messages: &mut Vec<DrainedMessage>, message_id: &str) {
    pending_messages.retain(|message| message.id != message_id);
}

fn remove_replayed_message(
    messages: &mut Vec<Message>,
    message_ids: &mut Vec<Option<String>>,
    message_id: &str,
) -> bool {
    if let Some(position) = message_ids
        .iter()
        .position(|candidate| candidate.as_deref() == Some(message_id))
    {
        messages.remove(position);
        message_ids.remove(position);
        true
    } else {
        false
    }
}

fn bad_role(path: &Path, line: usize, entry_type: &str) -> SessionError {
    SessionError::BadEntry {
        path: path.to_path_buf(),
        line,
        message: format!("{entry_type} contains the wrong message role"),
    }
}
