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

