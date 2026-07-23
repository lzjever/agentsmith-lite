fn activate_task_observer_for_test(service: &Service, task_id: &str, config: TaskObserveConfig) {
    let writer = service
        .inner
        .background_tasks
        .stdin_writer(task_id)
        .expect("task stdin writer should be registered");
    let prepared = service
        .inner
        .task_observer
        .prepare(task_id.to_owned(), config, writer)
        .expect("observer generation should prepare");
    service.inner.task_observer.activate(prepared);
    if config.delivery == TaskObserveDelivery::StreamText {
        service.inner.ensure_task_observer_preview_loop();
    }
}
async fn wait_for_service_idle(service: &Service) {
    tokio::time::timeout(
        Duration::from_secs(10),
        service.wait_for_state(ServiceState::Idle),
    )
    .await
    .expect("service should become idle");
}

#[derive(Clone, Default)]
struct CompactionFlushFailureSessionFile {
    state: Arc<Mutex<CompactionFlushFailureSessionFileState>>,
}

#[derive(Default)]
struct CompactionFlushFailureSessionFileState {
    bytes: Vec<u8>,
    last_line: String,
    compaction_flush_attempts: usize,
}

impl CompactionFlushFailureSessionFile {
    fn compaction_flush_attempts(&self) -> usize {
        self.state
            .lock()
            .expect("compaction session file mutex poisoned")
            .compaction_flush_attempts
    }
}

impl SessionFileIo for CompactionFlushFailureSessionFile {
    fn len(&mut self) -> io::Result<u64> {
        Ok(self
            .state
            .lock()
            .expect("compaction session file mutex poisoned")
            .bytes
            .len() as u64)
    }

    fn write_line(&mut self, line: &str) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .expect("compaction session file mutex poisoned");
        state.last_line = line.to_owned();
        state.bytes.extend_from_slice(line.as_bytes());
        state.bytes.push(b'\n');
        Ok(())
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.state
            .lock()
            .expect("compaction session file mutex poisoned")
            .bytes
            .extend_from_slice(bytes);
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .expect("compaction session file mutex poisoned");
        if state.last_line.contains("\"type\":\"compaction\"") {
            state.compaction_flush_attempts += 1;
            return Err(io::Error::other("compaction flush failed"));
        }
        Ok(())
    }

    fn sync_data(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn set_len(&mut self, len: u64) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .expect("compaction session file mutex poisoned");
        state.bytes.truncate(len as usize);
        state.last_line.clear();
        Ok(())
    }
}

#[derive(Clone)]
struct SwitchableCompactionFlushFailureSessionFile {
    state: Arc<Mutex<SwitchableCompactionFlushFailureSessionFileState>>,
}

struct SwitchableCompactionFlushFailureSessionFileState {
    bytes: Vec<u8>,
    last_line: String,
    compaction_flush_attempts: usize,
    fail_compaction: bool,
    fail_compaction_rollback: bool,
    fail_pending_removal: bool,
}

impl SwitchableCompactionFlushFailureSessionFile {
    fn from_bytes(bytes: Vec<u8>) -> Self {
        Self {
            state: Arc::new(Mutex::new(
                SwitchableCompactionFlushFailureSessionFileState {
                    bytes,
                    last_line: String::new(),
                    compaction_flush_attempts: 0,
                    fail_compaction: true,
                    fail_compaction_rollback: false,
                    fail_pending_removal: false,
                },
            )),
        }
    }

    fn bytes(&self) -> Vec<u8> {
        self.state
            .lock()
            .expect("first compaction session file mutex poisoned")
            .bytes
            .clone()
    }

    fn compaction_flush_attempts(&self) -> usize {
        self.state
            .lock()
            .expect("first compaction session file mutex poisoned")
            .compaction_flush_attempts
    }

    fn set_fail_compaction(&self, fail: bool) {
        self.state
            .lock()
            .expect("first compaction session file mutex poisoned")
            .fail_compaction = fail;
    }

    fn set_fail_compaction_rollback(&self, fail: bool) {
        self.state
            .lock()
            .expect("first compaction session file mutex poisoned")
            .fail_compaction_rollback = fail;
    }

    fn set_fail_pending_removal(&self, fail: bool) {
        self.state
            .lock()
            .expect("first compaction session file mutex poisoned")
            .fail_pending_removal = fail;
    }
}

impl SessionFileIo for SwitchableCompactionFlushFailureSessionFile {
    fn len(&mut self) -> io::Result<u64> {
        Ok(self
            .state
            .lock()
            .expect("first compaction session file mutex poisoned")
            .bytes
            .len() as u64)
    }

    fn write_line(&mut self, line: &str) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .expect("first compaction session file mutex poisoned");
        state.last_line = line.to_owned();
        state.bytes.extend_from_slice(line.as_bytes());
        state.bytes.push(b'\n');
        Ok(())
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.state
            .lock()
            .expect("first compaction session file mutex poisoned")
            .bytes
            .extend_from_slice(bytes);
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .expect("first compaction session file mutex poisoned");
        if state.last_line.contains("\"type\":\"compaction\"") {
            state.compaction_flush_attempts += 1;
            if state.fail_compaction {
                return Err(io::Error::other("switchable compaction flush failed"));
            }
        }
        if state
            .last_line
            .contains("\"type\":\"pending_input_removed\"")
            && state.fail_pending_removal
        {
            return Err(io::Error::other(
                "switchable pending input removal flush failed",
            ));
        }
        Ok(())
    }

    fn sync_data(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn set_len(&mut self, len: u64) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .expect("first compaction session file mutex poisoned");
        if state.last_line.contains("\"type\":\"compaction\"") && state.fail_compaction_rollback {
            return Err(io::Error::other("compaction rollback truncate failed"));
        }
        state.bytes.truncate(len as usize);
        state.last_line.clear();
        Ok(())
    }
}

fn session_body_records(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(bytes)
        .lines()
        .skip(1)
        .map(|line| serde_json::from_str(line).expect("session body line should be json"))
        .collect()
}
