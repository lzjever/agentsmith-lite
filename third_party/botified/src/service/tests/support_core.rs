struct PanicProvider;

#[async_trait]
impl Provider for PanicProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        panic!("provider should not be called")
    }
}

struct ControlledPanicProvider {
    entered: AtomicBool,
    entered_notify: Notify,
    release: Notify,
}

impl ControlledPanicProvider {
    fn new() -> Self {
        Self {
            entered: AtomicBool::new(false),
            entered_notify: Notify::new(),
            release: Notify::new(),
        }
    }

    async fn wait_until_entered(&self) {
        while !self.entered.load(Ordering::SeqCst) {
            self.entered_notify.notified().await;
        }
    }

    fn release(&self) {
        self.release.notify_one();
    }
}

#[async_trait]
impl Provider for ControlledPanicProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        self.entered.store(true, Ordering::SeqCst);
        self.entered_notify.notify_waiters();
        self.release.notified().await;
        panic!("controlled provider panic")
    }
}

struct LongPanicProvider;

#[async_trait]
impl Provider for LongPanicProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        panic!("{}PANIC_TAIL_SENTINEL", "x".repeat(16 * 1024))
    }
}

struct PartialProgressThenPanicProvider {
    calls: AtomicUsize,
    panic_entered: AtomicBool,
    panic_entered_notify: Notify,
    panic_release: Notify,
    queued_request: Mutex<Option<ProviderRequest>>,
    queued_request_notify: Notify,
}

impl PartialProgressThenPanicProvider {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            panic_entered: AtomicBool::new(false),
            panic_entered_notify: Notify::new(),
            panic_release: Notify::new(),
            queued_request: Mutex::new(None),
            queued_request_notify: Notify::new(),
        }
    }

    async fn wait_until_panic_entered(&self) {
        while !self.panic_entered.load(Ordering::SeqCst) {
            self.panic_entered_notify.notified().await;
        }
    }

    async fn wait_for_queued_request(&self) -> ProviderRequest {
        loop {
            if let Some(request) = self
                .queued_request
                .lock()
                .expect("queued request mutex poisoned")
                .clone()
            {
                return request;
            }
            self.queued_request_notify.notified().await;
        }
    }
}

#[async_trait]
impl Provider for PartialProgressThenPanicProvider {
    async fn complete(
        &self,
        request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        match self.calls.fetch_add(1, Ordering::SeqCst) {
            0 => Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
                "call_partial_progress",
                "noop",
                json!({}),
            )])),
            1 => {
                self.panic_entered.store(true, Ordering::SeqCst);
                self.panic_entered_notify.notify_waiters();
                self.panic_release.notified().await;
                panic!("panic after partial provider and tool progress")
            }
            2 => {
                *self
                    .queued_request
                    .lock()
                    .expect("queued request mutex poisoned") = Some(request);
                self.queued_request_notify.notify_waiters();
                Ok(ProviderResponse::text("queued run completed"))
            }
            call => panic!("unexpected provider call {call}"),
        }
    }
}

struct TextProvider(&'static str);

#[async_trait]
impl Provider for TextProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        Ok(ProviderResponse::text(self.0))
    }
}

struct CountingProvider {
    calls: AtomicUsize,
}

#[derive(Default)]
struct CapturingProvider {
    requests: Mutex<Vec<ProviderRequest>>,
}

#[async_trait]
impl Provider for CapturingProvider {
    async fn complete(
        &self,
        request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        self.requests.lock().unwrap().push(request);
        Ok(ProviderResponse::text("recovered"))
    }
}

struct PrepublishBashProvider {
    pid_path: PathBuf,
    calls: AtomicUsize,
}

#[async_trait]
impl Provider for PrepublishBashProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            let command = format!(
                "printf '%s' $$ > '{}'; printf '<botified>{{\"op\":\"tell\",\"id\":\"ready\",\"message\":\"ready\"}}</botified>\\n'; sleep 60",
                self.pid_path.display()
            );
            return Ok(ProviderResponse::tool_calls(vec![ToolCall::new(
                "call_prepublish_rejected",
                "bash",
                json!({
                    "command": command,
                    "detach_after_secs": 60,
                    "timeout_secs": 60,
                    "interactive_stdio": true
                }),
            )]));
        }
        Ok(ProviderResponse::text("done"))
    }
}

impl CountingProvider {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl Provider for CountingProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ProviderResponse::text("ok"))
    }
}

struct CompactTestProvider {
    main_responses: Mutex<Vec<Result<ProviderResponse, ProviderError>>>,
    compact_responses: Mutex<Vec<Result<ProviderResponse, ProviderError>>>,
    main_requests: Mutex<Vec<ProviderRequest>>,
    compact_requests: Mutex<Vec<ProviderRequest>>,
    metadata: ProviderMetadata,
    block_compaction: AtomicBool,
    compaction_release: Notify,
    active_compactions: AtomicUsize,
    max_active_compactions: AtomicUsize,
}

struct PanicOnceCompactionProvider {
    inner: CompactTestProvider,
    compact_attempts: AtomicUsize,
}

impl PanicOnceCompactionProvider {
    fn new() -> Self {
        Self {
            inner: CompactTestProvider::new(
                vec![Ok(ProviderResponse::text("after compact panic"))],
                vec![Ok(ProviderResponse::text("summary after compact panic"))],
            ),
            compact_attempts: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl Provider for PanicOnceCompactionProvider {
    fn metadata_for_request(&self, request: &ProviderRequest) -> Option<ProviderMetadata> {
        self.inner.metadata_for_request(request)
    }

    async fn complete(
        &self,
        request: ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        let is_compaction = request
            .profiling_context()
            .is_some_and(|context| context.request_kind == "compaction");
        if is_compaction && self.compact_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            panic!("compaction provider panic")
        }
        self.inner.complete(request, cancel).await
    }
}

struct CancelFirstMainProvider {
    inner: CompactTestProvider,
    cancel_first_main: AtomicBool,
}

struct NoopTool;

#[async_trait]
impl Tool for NoopTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "noop",
            "No-op tool used by service compaction tests.",
            json!({"type": "object", "properties": {}}),
        )
    }

    async fn execute(
        &self,
        call: ToolCall,
        _context: ToolExecutionContext,
        _cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        Ok(ToolResult::success(call.id, call.name, "ok"))
    }
}

impl CancelFirstMainProvider {
    fn new(
        main_responses: Vec<Result<ProviderResponse, ProviderError>>,
        compact_responses: Vec<Result<ProviderResponse, ProviderError>>,
    ) -> Self {
        Self {
            inner: CompactTestProvider::new(main_responses, compact_responses),
            cancel_first_main: AtomicBool::new(true),
        }
    }

    fn main_requests(&self) -> Vec<ProviderRequest> {
        self.inner.main_requests()
    }
}

#[async_trait]
impl Provider for CancelFirstMainProvider {
    fn metadata_for_request(&self, request: &ProviderRequest) -> Option<ProviderMetadata> {
        self.inner.metadata_for_request(request)
    }

    async fn complete(
        &self,
        request: ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        let is_compaction = request
            .profiling_context()
            .is_some_and(|context| context.request_kind == "compaction");
        if !is_compaction && self.cancel_first_main.swap(false, Ordering::SeqCst) {
            self.inner
                .main_requests
                .lock()
                .expect("main requests mutex poisoned")
                .push(request);
            cancel.cancelled().await;
            return Err(ProviderError::request_failed("cancelled first request"));
        }
        self.inner.complete(request, cancel).await
    }
}

impl CompactTestProvider {
    fn new(
        main_responses: Vec<Result<ProviderResponse, ProviderError>>,
        compact_responses: Vec<Result<ProviderResponse, ProviderError>>,
    ) -> Self {
        Self {
            main_responses: Mutex::new(main_responses.into_iter().rev().collect()),
            compact_responses: Mutex::new(compact_responses.into_iter().rev().collect()),
            main_requests: Mutex::new(Vec::new()),
            compact_requests: Mutex::new(Vec::new()),
            metadata: ProviderMetadata::new("compact-test")
                .with_context_window_tokens(8_192)
                .with_max_output_tokens(1_024),
            block_compaction: AtomicBool::new(false),
            compaction_release: Notify::new(),
            active_compactions: AtomicUsize::new(0),
            max_active_compactions: AtomicUsize::new(0),
        }
    }

    fn blocked(
        main_responses: Vec<Result<ProviderResponse, ProviderError>>,
        compact_responses: Vec<Result<ProviderResponse, ProviderError>>,
    ) -> Self {
        let provider = Self::new(main_responses, compact_responses);
        provider.block_compaction.store(true, Ordering::SeqCst);
        provider
    }

    fn soft(
        main_responses: Vec<Result<ProviderResponse, ProviderError>>,
        compact_responses: Vec<Result<ProviderResponse, ProviderError>>,
    ) -> Self {
        let mut provider = Self::new(main_responses, compact_responses);
        set_compact_test_metadata(&mut provider, 40_000, 256);
        provider
    }

    fn blocked_soft(
        main_responses: Vec<Result<ProviderResponse, ProviderError>>,
        compact_responses: Vec<Result<ProviderResponse, ProviderError>>,
    ) -> Self {
        let provider = Self::soft(main_responses, compact_responses);
        provider.block_compaction.store(true, Ordering::SeqCst);
        provider
    }

    fn main_requests(&self) -> Vec<ProviderRequest> {
        self.main_requests
            .lock()
            .expect("main requests mutex poisoned")
            .clone()
    }

    fn compact_requests(&self) -> Vec<ProviderRequest> {
        self.compact_requests
            .lock()
            .expect("compact requests mutex poisoned")
            .clone()
    }

    fn active_compactions(&self) -> usize {
        self.active_compactions.load(Ordering::SeqCst)
    }

    fn max_active_compactions(&self) -> usize {
        self.max_active_compactions.load(Ordering::SeqCst)
    }

    fn release_compactions(&self) {
        self.block_compaction.store(false, Ordering::SeqCst);
        self.compaction_release.notify_waiters();
    }

    fn record_active_compaction(&self) {
        let active = self.active_compactions.fetch_add(1, Ordering::SeqCst) + 1;
        let mut current = self.max_active_compactions.load(Ordering::SeqCst);
        while active > current {
            match self.max_active_compactions.compare_exchange(
                current,
                active,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(next) => current = next,
            }
        }
    }
}

#[async_trait]
impl Provider for CompactTestProvider {
    fn metadata_for_request(&self, _request: &ProviderRequest) -> Option<ProviderMetadata> {
        Some(self.metadata.clone())
    }

    async fn complete(
        &self,
        request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        let is_compaction = request
            .profiling_context()
            .is_some_and(|context| context.request_kind == "compaction");
        if is_compaction {
            self.compact_requests
                .lock()
                .expect("compact requests mutex poisoned")
                .push(request);
            self.record_active_compaction();
            while self.block_compaction.load(Ordering::SeqCst) {
                self.compaction_release.notified().await;
            }
            let response = self
                .compact_responses
                .lock()
                .expect("compact responses mutex poisoned")
                .pop()
                .unwrap_or_else(|| Ok(ProviderResponse::text("summary ready")));
            self.active_compactions.fetch_sub(1, Ordering::SeqCst);
            return response;
        }

        self.main_requests
            .lock()
            .expect("main requests mutex poisoned")
            .push(request);
        self.main_responses
            .lock()
            .expect("main responses mutex poisoned")
            .pop()
            .unwrap_or_else(|| Ok(ProviderResponse::text("main done")))
    }
}

#[derive(Clone, Debug)]
struct RecordedCompaction {
    summary: Vec<ContentPart>,
    retained_messages: Vec<Message>,
    active_user_message_id: Option<String>,
    metadata: Option<CompactionMetadata>,
}

#[derive(Default)]
struct RecordingCompactionRecorder {
    compactions: Mutex<Vec<RecordedCompaction>>,
    fail_compaction: AtomicBool,
}

struct BlockingAcceptedInputRecorder {
    entered: CancellationToken,
    release: CancellationToken,
}

impl BlockingAcceptedInputRecorder {
    fn new() -> Self {
        Self {
            entered: CancellationToken::new(),
            release: CancellationToken::new(),
        }
    }
}

#[async_trait]
impl AgentContextRecorder for BlockingAcceptedInputRecorder {
    async fn record_message(&self, _message: &Message) -> Result<(), AgentCommitError> {
        Ok(())
    }

    async fn record_accepted_input(
        &self,
        _entry: &AcceptedInputEntry,
    ) -> Result<(), AgentCommitError> {
        self.entered.cancel();
        self.release.cancelled().await;
        Ok(())
    }

    async fn record_user_batch_with_ids(
        &self,
        _messages: &[Message],
        _message_ids: &[String],
    ) -> Result<(), AgentCommitError> {
        Ok(())
    }
}

impl RecordingCompactionRecorder {
    fn failing_compaction() -> Self {
        let recorder = Self::default();
        recorder.fail_compaction.store(true, Ordering::SeqCst);
        recorder
    }

    fn set_fail_compaction(&self, fail: bool) {
        self.fail_compaction.store(fail, Ordering::SeqCst);
    }

    fn compactions(&self) -> Vec<RecordedCompaction> {
        self.compactions
            .lock()
            .expect("recorded compactions mutex poisoned")
            .clone()
    }
}

#[async_trait]
impl AgentContextRecorder for RecordingCompactionRecorder {
    async fn record_message(&self, _message: &Message) -> Result<(), AgentCommitError> {
        Ok(())
    }

    async fn record_accepted_input(
        &self,
        _entry: &AcceptedInputEntry,
    ) -> Result<(), AgentCommitError> {
        Ok(())
    }

    async fn record_user_batch_with_ids(
        &self,
        _messages: &[Message],
        _message_ids: &[String],
    ) -> Result<(), AgentCommitError> {
        Ok(())
    }

    async fn record_compaction_with_active_user_message_id_and_metadata(
        &self,
        summary: &[ContentPart],
        retained_messages: &[Message],
        active_user_message_id: Option<&str>,
        metadata: Option<&CompactionMetadata>,
    ) -> Result<(), AgentCommitError> {
        if self.fail_compaction.load(Ordering::SeqCst) {
            return Err(AgentCommitError::new("compaction append failed"));
        }
        self.compactions
            .lock()
            .expect("recorded compactions mutex poisoned")
            .push(RecordedCompaction {
                summary: summary.to_vec(),
                retained_messages: retained_messages.to_vec(),
                active_user_message_id: active_user_message_id.map(ToOwned::to_owned),
                metadata: metadata.cloned(),
            });
        Ok(())
    }
}

fn compact_old_context() -> Vec<Message> {
    vec![
        Message::user(vec![ContentPart::text(format!(
            "historic request {}",
            "old ".repeat(400)
        ))]),
        Message::Assistant {
            content: Some("historic answer".to_owned()),
            tool_calls: Vec::new(),
            assistant_replay: None,
            usage: Some(Usage {
                input_tokens: 19_500,
                cached_input_tokens: 0,
                output_tokens: 500,
                reasoning_output_tokens: 0,
                total_tokens: 20_000,
            }),
            stop_reason: Some(StopReason::EndTurn),
        },
    ]
}

fn compact_context_with_retained_high_usage_assistant() -> Vec<Message> {
    vec![
        Message::user(vec![ContentPart::text(format!(
            "discarded prefix {}",
            "old ".repeat(800)
        ))]),
        Message::user(vec![ContentPart::text(format!(
            "recent retained request {}",
            "recent ".repeat(1_300)
        ))]),
        Message::Assistant {
            content: Some("recent retained answer".to_owned()),
            tool_calls: Vec::new(),
            assistant_replay: None,
            usage: Some(Usage {
                input_tokens: 19_500,
                cached_input_tokens: 0,
                output_tokens: 500,
                reasoning_output_tokens: 0,
                total_tokens: 20_000,
            }),
            stop_reason: Some(StopReason::EndTurn),
        },
    ]
}

fn hard_gate_compactable_context() -> Vec<Message> {
    vec![
        Message::user(vec![ContentPart::text(format!(
            "historic overflow {}",
            "o".repeat(18_000)
        ))]),
        Message::Assistant {
            content: Some(format!("retained bridge {}", "b".repeat(11_000))),
            tool_calls: Vec::new(),
            assistant_replay: None,
            usage: Some(Usage {
                input_tokens: 19_500,
                cached_input_tokens: 0,
                output_tokens: 500,
                reasoning_output_tokens: 0,
                total_tokens: 20_000,
            }),
            stop_reason: Some(StopReason::EndTurn),
        },
    ]
}

fn hard_gate_compact_request_text_route_context() -> Vec<Message> {
    vec![
        Message::user(vec![ContentPart::text(format!(
            "historic compact request text route {}",
            "o".repeat(1_600_000)
        ))]),
        Message::Assistant {
            content: Some(format!("retained bridge {}", "b".repeat(30_000))),
            tool_calls: Vec::new(),
            assistant_replay: None,
            usage: Some(Usage {
                input_tokens: 19_500,
                cached_input_tokens: 0,
                output_tokens: 500,
                reasoning_output_tokens: 0,
                total_tokens: 20_000,
            }),
            stop_reason: Some(StopReason::EndTurn),
        },
    ]
}

fn hard_gate_compact_request_overflow_context() -> Vec<Message> {
    vec![
        Message::user(vec![ContentPart::text(format!(
            "historic compact request overflow {}",
            "o".repeat(80_000)
        ))]),
        Message::Assistant {
            content: Some(format!("retained bridge {}", "b".repeat(9_000))),
            tool_calls: Vec::new(),
            assistant_replay: None,
            usage: Some(Usage {
                input_tokens: 19_500,
                cached_input_tokens: 0,
                output_tokens: 500,
                reasoning_output_tokens: 0,
                total_tokens: 20_000,
            }),
            stop_reason: Some(StopReason::EndTurn),
        },
    ]
}

fn soft_compact_trigger_content(label: &str) -> Vec<ContentPart> {
    vec![ContentPart::text(format!(
        "{label} {}",
        "relevant transcript content ".repeat(3_750)
    ))]
}

fn oversized_active_batch(prefix: &str) -> Vec<DrainedMessage> {
    vec![
        DrainedMessage::new(
            format!("{prefix}_1"),
            vec![ContentPart::text(format!(
                "{prefix} first active input {}",
                "a".repeat(30_000)
            ))],
        ),
        DrainedMessage::new(
            format!("{prefix}_2"),
            vec![ContentPart::text(format!(
                "{prefix} second active input {}",
                "b".repeat(30_000)
            ))],
        ),
    ]
}

fn set_compact_test_metadata(
    provider: &mut CompactTestProvider,
    context_window_tokens: u64,
    max_output_tokens: u64,
) {
    provider.metadata = ProviderMetadata::new("compact-test")
        .with_context_window_tokens(context_window_tokens)
        .with_max_output_tokens(max_output_tokens);
}

fn first_text(messages: &[Message]) -> Option<String> {
    messages.iter().find_map(|message| match message {
        Message::User { content } => content.iter().find_map(|part| match part {
            ContentPart::Text { text } => Some(text.clone()),
            _ => None,
        }),
        _ => None,
    })
}

fn has_local_degraded_recovery(messages: &[Message]) -> bool {
    first_text(messages)
        .as_deref()
        .is_some_and(|text| text.contains("Local degraded recovery summary"))
}

fn assert_low_water_compaction_request(provider: &CompactTestProvider, request: &ProviderRequest) {
    let policy = crate::compact::CompactPolicy::from_provider_metadata(&provider.metadata);
    let limits = policy.limits();
    let estimated_input_tokens = crate::compact::estimate_provider_request_input_tokens(request);
    let transcript = request.transcript_messages();
    let transcript_tokens = crate::compact::context_tokens(&transcript);

    assert!(
        estimated_input_tokens < limits.hard_stop_tokens,
        "fixture must stay below the hard-gate pause threshold: estimated={estimated_input_tokens}, hard={}",
        limits.hard_stop_tokens
    );
    assert!(
        crate::compact::maybe_plan_compaction(&transcript, policy).is_some(),
        "fixture transcript must still trigger low-water compaction planning: transcript={transcript_tokens}, soft={}",
        limits.soft_start_tokens
    );
}

struct EmptyAssistantToolCallProvider {
    calls: AtomicUsize,
}

impl EmptyAssistantToolCallProvider {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl Provider for EmptyAssistantToolCallProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            return Ok(ProviderResponse {
                text: Some(String::new()),
                tool_calls: vec![ToolCall::new(
                    "call_empty_text_task_list",
                    "task_list",
                    json!({}),
                )],
                assistant_replay: None,
                usage: None,
                stop_reason: StopReason::ToolCalls,
                metadata: None,
            });
        }

        Ok(ProviderResponse {
            text: None,
            tool_calls: Vec::new(),
            assistant_replay: None,
            usage: None,
            stop_reason: StopReason::EndTurn,
            metadata: None,
        })
    }
}

struct FailingSyncSessionFile;

#[derive(Default)]
struct ControlledSessionState {
    bytes: Vec<u8>,
    block_sync: bool,
    sync_entered: bool,
    fail_sync: bool,
    sync_count: usize,
    fail_sync_at: Option<usize>,
    fail_set_len: usize,
}

#[derive(Clone, Default)]
struct ControlledSessionFile {
    shared: Arc<(Mutex<ControlledSessionState>, Condvar)>,
}

impl ControlledSessionFile {
    fn from_bytes(bytes: Vec<u8>) -> Self {
        Self {
            shared: Arc::new((
                Mutex::new(ControlledSessionState {
                    bytes,
                    ..ControlledSessionState::default()
                }),
                Condvar::new(),
            )),
        }
    }

    fn set_block_sync(&self, value: bool) {
        let (lock, wake) = &*self.shared;
        lock.lock()
            .expect("controlled session mutex poisoned")
            .block_sync = value;
        wake.notify_all();
    }

    fn set_fail_sync(&self, value: bool) {
        self.shared
            .0
            .lock()
            .expect("controlled session mutex poisoned")
            .fail_sync = value;
    }

    fn fail_next_set_len(&self) {
        self.shared
            .0
            .lock()
            .expect("controlled session mutex poisoned")
            .fail_set_len += 1;
    }

    fn fail_sync_after(&self, successful_syncs: usize) {
        let mut state = self
            .shared
            .0
            .lock()
            .expect("controlled session mutex poisoned");
        state.fail_sync_at = Some(
            state
                .sync_count
                .saturating_add(successful_syncs)
                .saturating_add(1),
        );
    }

    fn wait_for_sync(&self) {
        let (lock, wake) = &*self.shared;
        let mut state = lock.lock().expect("controlled session mutex poisoned");
        while !state.sync_entered {
            state = wake.wait(state).expect("controlled session mutex poisoned");
        }
    }

    fn reset_sync(&self) {
        self.shared
            .0
            .lock()
            .expect("controlled session mutex poisoned")
            .sync_entered = false;
    }

    fn contents(&self) -> String {
        String::from_utf8(
            self.shared
                .0
                .lock()
                .expect("controlled session mutex poisoned")
                .bytes
                .clone(),
        )
        .expect("session fixture should be utf-8")
    }

    fn bytes(&self) -> Vec<u8> {
        self.shared
            .0
            .lock()
            .expect("controlled session mutex poisoned")
            .bytes
            .clone()
    }
}

impl SessionFileIo for ControlledSessionFile {
    fn len(&mut self) -> io::Result<u64> {
        Ok(self.shared.0.lock().unwrap().bytes.len() as u64)
    }
    fn write_line(&mut self, line: &str) -> io::Result<()> {
        let mut state = self.shared.0.lock().unwrap();
        state.bytes.extend_from_slice(line.as_bytes());
        state.bytes.push(b'\n');
        Ok(())
    }
    fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.shared.0.lock().unwrap().bytes.extend_from_slice(bytes);
        Ok(())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn sync_data(&mut self) -> io::Result<()> {
        let (lock, wake) = &*self.shared;
        let mut state = lock.lock().unwrap();
        state.sync_entered = true;
        wake.notify_all();
        while state.block_sync {
            state = wake.wait(state).unwrap();
        }
        state.sync_count = state.sync_count.saturating_add(1);
        if state.fail_sync_at == Some(state.sync_count) {
            state.fail_sync_at = None;
            return Err(io::Error::other("controlled scheduled sync failure"));
        }
        if state.fail_sync {
            Err(io::Error::other("controlled sync failure"))
        } else {
            Ok(())
        }
    }
    fn set_len(&mut self, len: u64) -> io::Result<()> {
        let mut state = self.shared.0.lock().unwrap();
        if state.fail_set_len > 0 {
            state.fail_set_len -= 1;
            return Err(io::Error::other("controlled set_len failure"));
        }
        state.bytes.truncate(len as usize);
        Ok(())
    }
}

impl SessionFileIo for FailingSyncSessionFile {
    fn len(&mut self) -> io::Result<u64> {
        Ok(0)
    }

    fn write_line(&mut self, _line: &str) -> io::Result<()> {
        Ok(())
    }

    fn write_bytes(&mut self, _bytes: &[u8]) -> io::Result<()> {
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn sync_data(&mut self) -> io::Result<()> {
        Err(io::Error::other("sync_data failed"))
    }

    fn set_len(&mut self, _len: u64) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
struct FailNextSyncSessionFile {
    state: Arc<Mutex<(Vec<u8>, bool)>>,
}

impl FailNextSyncSessionFile {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            state: Arc::new(Mutex::new((bytes, true))),
        }
    }

    fn bytes(&self) -> Vec<u8> {
        self.state
            .lock()
            .expect("session file mutex poisoned")
            .0
            .clone()
    }
}

impl SessionFileIo for FailNextSyncSessionFile {
    fn len(&mut self) -> io::Result<u64> {
        Ok(self
            .state
            .lock()
            .expect("session file mutex poisoned")
            .0
            .len() as u64)
    }

    fn write_line(&mut self, line: &str) -> io::Result<()> {
        let mut state = self.state.lock().expect("session file mutex poisoned");
        state.0.extend_from_slice(line.as_bytes());
        state.0.push(b'\n');
        Ok(())
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.state
            .lock()
            .expect("session file mutex poisoned")
            .0
            .extend_from_slice(bytes);
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn sync_data(&mut self) -> io::Result<()> {
        let mut state = self.state.lock().expect("session file mutex poisoned");
        if state.1 {
            state.1 = false;
            return Err(io::Error::other("injected ack sync failure"));
        }
        Ok(())
    }

    fn set_len(&mut self, len: u64) -> io::Result<()> {
        self.state
            .lock()
            .expect("session file mutex poisoned")
            .0
            .truncate(len as usize);
        Ok(())
    }
}

struct FailingPendingRemovalRecorder;

#[async_trait]
impl AgentContextRecorder for FailingPendingRemovalRecorder {
    async fn record_message(&self, _message: &Message) -> Result<(), AgentCommitError> {
        Ok(())
    }

    async fn record_accepted_input(
        &self,
        _entry: &AcceptedInputEntry,
    ) -> Result<(), AgentCommitError> {
        Ok(())
    }

    async fn record_pending_input_removed(
        &self,
        _message_id: &str,
        _source: InputSource,
        _metadata: Option<&QueuedInputMetadata>,
        _reason: &str,
    ) -> Result<(), AgentCommitError> {
        Err(AgentCommitError::new("pending removal write failed"))
    }

    async fn record_user_batch_with_ids(
        &self,
        messages: &[Message],
        message_ids: &[String],
    ) -> Result<(), AgentCommitError> {
        if messages.len() != message_ids.len() {
            return Err(AgentCommitError::new(
                "user batch message id count does not match message count",
            ));
        }
        Ok(())
    }
}

struct FailingProvider;

#[async_trait]
impl Provider for FailingProvider {
    async fn complete(
        &self,
        _request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        Err(ProviderError::request_failed("provider failed"))
    }
}

fn install_subagent_cancel_hook(
    service: &Service,
    kind: SubagentTestHookKind,
    subagent_id: String,
) {
    let inner = service.inner.clone();
    service.inner.set_subagent_test_hook(
        kind,
        Arc::new(move || {
            let _ = inner.cancel_subagent_tool_result(
                ToolCall::new(
                    "race_cancel",
                    "subagent_cancel",
                    json!({"subagent_id": subagent_id}),
                ),
                &subagent_id,
            );
        }),
    );
}

fn assert_subagent_runtime_resources_absent(service: &Service, subagent_id: &str) {
    assert!(!service
        .inner
        .subagent_contexts
        .lock()
        .expect("subagent contexts mutex poisoned")
        .contains_key(subagent_id));
    assert!(!service
        .inner
        .subagent_providers
        .lock()
        .expect("subagent providers mutex poisoned")
        .contains_key(subagent_id));
    assert!(!service
        .inner
        .subagent_runtime_selections
        .lock()
        .expect("subagent runtime selections mutex poisoned")
        .contains_key(subagent_id));
    assert!(!service
        .inner
        .subagent_cancels
        .lock()
        .expect("subagent cancels mutex poisoned")
        .contains_key(subagent_id));
    assert!(!service
        .inner
        .subagent_tool_snapshots
        .lock()
        .expect("subagent tool snapshots mutex poisoned")
        .contains_key(subagent_id));
}

fn tool_text_json(result: &ToolResult) -> Value {
    let parsed: Value = serde_json::from_str(&result.text).expect("tool text should be JSON");
    assert_eq!(parsed, result.details);
    parsed
}

fn service_test_home(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "botified-service-{name}-{}-{stamp}",
        std::process::id()
    ))
}
