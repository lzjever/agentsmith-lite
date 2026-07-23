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
    fn atomic_frame_cap(&self) -> usize {
        TASK_STDIN_FRAME_SAFETY_CEILING
    }

    fn try_write_frame(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        self.text
            .lock()
            .expect("recording stdin mutex poisoned")
            .push_str(&String::from_utf8_lossy(bytes));
        Ok(TaskStdinWriteSuccess::delivered())
    }
}

#[derive(Clone)]
struct BlockingObserveResultStdin {
    text: Arc<Mutex<String>>,
    entered: std::sync::mpsc::Sender<()>,
    release: Arc<Mutex<Option<std::sync::mpsc::Receiver<()>>>>,
    calls: Arc<AtomicUsize>,
}

impl TaskStdinWriter for BlockingObserveResultStdin {
    fn atomic_frame_cap(&self) -> usize {
        TASK_STDIN_FRAME_SAFETY_CEILING
    }

    fn try_write_frame(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            let _ = self.entered.send(());
            if let Some(release) = self
                .release
                .lock()
                .expect("observe-result release mutex poisoned")
                .take()
            {
                release
                    .recv_timeout(Duration::from_secs(5))
                    .expect("observe-result write should be released");
            }
        }
        self.text
            .lock()
            .expect("blocking stdin text mutex poisoned")
            .push_str(&String::from_utf8_lossy(bytes));
        Ok(TaskStdinWriteSuccess::delivered())
    }
}

#[derive(Clone)]
struct CappedRecordingTaskStdin {
    inner: RecordingTaskStdin,
    frame_cap: usize,
}

impl CappedRecordingTaskStdin {
    fn new(frame_cap: usize) -> Self {
        Self {
            inner: RecordingTaskStdin::default(),
            frame_cap,
        }
    }

    fn text(&self) -> String {
        self.inner.text()
    }
}

impl TaskStdinWriter for CappedRecordingTaskStdin {
    fn atomic_frame_cap(&self) -> usize {
        self.frame_cap
    }

    fn try_write_frame(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        self.inner.try_write_frame(bytes)
    }
}

#[derive(Clone, Default)]
struct FailingTaskStdin;

impl TaskStdinWriter for FailingTaskStdin {
    fn atomic_frame_cap(&self) -> usize {
        TASK_STDIN_FRAME_SAFETY_CEILING
    }

    fn try_write_frame(&self, _bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        Err("stdin closed".to_owned())
    }
}

#[derive(Clone, Default)]
struct RejectingTaskStdin {
    write_attempted: Arc<AtomicBool>,
}

impl RejectingTaskStdin {
    fn write_attempted(&self) -> bool {
        self.write_attempted.load(Ordering::SeqCst)
    }
}

#[derive(Clone, Default)]
struct CountingRejectingTaskStdin {
    write_attempts: Arc<AtomicUsize>,
}

impl CountingRejectingTaskStdin {
    fn write_attempts(&self) -> usize {
        self.write_attempts.load(Ordering::SeqCst)
    }
}

impl TaskStdinWriter for CountingRejectingTaskStdin {
    fn atomic_frame_cap(&self) -> usize {
        TASK_STDIN_FRAME_SAFETY_CEILING
    }

    fn try_write_frame(&self, _bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        self.write_attempts.fetch_add(1, Ordering::SeqCst);
        Err("atomic stdin writes are unsupported".to_owned())
    }
}

impl TaskStdinWriter for RejectingTaskStdin {
    fn atomic_frame_cap(&self) -> usize {
        TASK_STDIN_FRAME_SAFETY_CEILING
    }

    fn try_write_frame(&self, _bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        self.write_attempted.store(true, Ordering::SeqCst);
        Err("atomic stdin writes are unsupported".to_owned())
    }
}

#[derive(Clone, Default)]
struct WouldBlockTaskStdin {
    write_attempted: Arc<AtomicBool>,
}

impl WouldBlockTaskStdin {
    fn write_attempted(&self) -> bool {
        self.write_attempted.load(Ordering::SeqCst)
    }
}

impl TaskStdinWriter for WouldBlockTaskStdin {
    fn atomic_frame_cap(&self) -> usize {
        TASK_STDIN_FRAME_SAFETY_CEILING
    }

    fn try_write_frame(&self, _bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        self.write_attempted.store(true, Ordering::SeqCst);
        Err("stdin writer would block".to_owned())
    }
}

#[derive(Clone, Default)]
struct ShortWriteTaskStdin;

impl TaskStdinWriter for ShortWriteTaskStdin {
    fn atomic_frame_cap(&self) -> usize {
        TASK_STDIN_FRAME_SAFETY_CEILING
    }

    fn try_write_frame(&self, _bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        Err("short nonblocking stdin write: 12/64 bytes".to_owned())
    }
}

#[derive(Clone, Default)]
struct ObserveWouldBlockTaskStdin {
    text: Arc<Mutex<String>>,
}

impl ObserveWouldBlockTaskStdin {
    fn text(&self) -> String {
        self.text
            .lock()
            .expect("observe stdin text mutex poisoned")
            .clone()
    }
}

impl TaskStdinWriter for ObserveWouldBlockTaskStdin {
    fn atomic_frame_cap(&self) -> usize {
        TASK_STDIN_FRAME_SAFETY_CEILING
    }

    fn try_write_frame(&self, bytes: &[u8]) -> Result<TaskStdinWriteSuccess, String> {
        if String::from_utf8_lossy(bytes).contains(r#""op":"observe""#) {
            return Err("stdin writer would block".to_owned());
        }
        self.text
            .lock()
            .expect("observe stdin text mutex poisoned")
            .push_str(&String::from_utf8_lossy(bytes));
        Ok(TaskStdinWriteSuccess::delivered())
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

fn spawn_panicking_subagent(
    service: &Service,
    provider: Arc<dyn Provider>,
    purpose: &str,
) -> String {
    spawn_panicking_subagent_with_tools(service, provider, purpose, Vec::new())
}

fn spawn_panicking_subagent_with_tools(
    service: &Service,
    provider: Arc<dyn Provider>,
    purpose: &str,
    tools: Vec<Arc<dyn Tool>>,
) -> String {
    let subagent_id = service
        .inner
        .subagents
        .lock()
        .expect("subagent manager mutex poisoned")
        .spawn("PanicWorker", purpose)
        .expect("subagent should start")
        .id;
    let messages = vec![Message::user(vec![ContentPart::text(purpose)])];
    service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .insert(subagent_id.clone(), messages.clone());
    service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .insert(subagent_id.clone(), provider.clone());
    let cancel = Arc::new(CancellationToken::new());
    service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .insert(subagent_id.clone(), cancel.clone());
    let tools = Arc::new(
        FinalToolSnapshot::build(tools, &service.inner.config.tool_execution)
            .expect("empty tool snapshot should validate"),
    );
    spawn_subagent_loop(
        service.inner.clone(),
        subagent_id.clone(),
        service.inner.subagent_config(),
        messages,
        provider,
        tools,
        cancel,
    );
    subagent_id
}

