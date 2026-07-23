mod control;
mod read;
mod shutdown;

use super::compaction_shared::CompactCoordinator;
use super::ContextMaintenanceStatus;
use super::*;

impl Service {
    pub fn new(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
    ) -> Result<Self, ServiceError> {
        Self::with_limits(config, provider, tools, ServiceLimits::default())
    }

    pub fn with_timeline_data_dir(
        mut config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        timeline_data_dir: impl Into<PathBuf>,
    ) -> Result<Self, ServiceError> {
        config.task_output.data_dir = timeline_data_dir.into();
        Self::with_limits(config, provider, tools, ServiceLimits::default())
    }

    pub fn with_file_store(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        file_store: FileStore,
    ) -> Result<Self, ServiceError> {
        Self::with_file_store_and_limits(
            config,
            provider,
            tools,
            file_store,
            ServiceLimits::default(),
        )
    }

    pub fn with_registry_store(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        registry_store: RegistryStore,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_options(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            ServiceLimits::default(),
            None,
            Some(registry_store),
            ServiceSubagentOptions::default(),
        )
    }

    pub fn with_provider_summaries(self, providers: Vec<ProviderMetadata>) -> Self {
        self.set_provider_summaries(providers);
        self
    }

    pub fn with_runtime_selection(
        config: AgentConfig,
        runtime_selection: RuntimeSelectionHandle,
        tools: Vec<Arc<dyn Tool>>,
    ) -> Result<Self, ServiceError> {
        Self::with_runtime_selection_and_subagent_options(
            config,
            runtime_selection,
            tools,
            ServiceSubagentOptions::default(),
        )
    }

    pub fn with_runtime_selection_and_subagent_options(
        config: AgentConfig,
        runtime_selection: RuntimeSelectionHandle,
        tools: Vec<Arc<dyn Tool>>,
        subagent_options: ServiceSubagentOptions,
    ) -> Result<Self, ServiceError> {
        let provider = runtime_selection.provider();
        let mut init = ServiceInit::new(config, provider, tools);
        init.runtime_selection = Some(runtime_selection);
        init.subagent_options = subagent_options;
        Self::from_init(init)
    }

    pub fn with_profiler(self, profiler: Option<SharedProfiler>) -> Self {
        self.set_profiler(profiler);
        self
    }

    pub fn with_llm_text_preview_enabled(self, enabled: bool) -> Self {
        self.set_llm_text_preview_enabled(enabled);
        self
    }

    pub fn with_limits(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        limits: ServiceLimits,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            limits,
        )
    }

    pub fn with_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        subagent_options: ServiceSubagentOptions,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_and_subagent_options(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            ServiceLimits::default(),
            subagent_options,
        )
    }

    pub fn with_registry_store_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        registry_store: RegistryStore,
        subagent_options: ServiceSubagentOptions,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_options(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            ServiceLimits::default(),
            None,
            Some(registry_store),
            subagent_options,
        )
    }

    pub fn with_file_store_and_limits(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        file_store: FileStore,
        limits: ServiceLimits,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_optional_file_store(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            limits,
            Some(file_store),
        )
    }

    pub fn with_file_store_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        file_store: FileStore,
        subagent_options: ServiceSubagentOptions,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_optional_file_store_and_subagent_options(
            config,
            provider,
            tools,
            Vec::new(),
            Vec::new(),
            Vec::new(),
            None,
            Vec::new(),
            ServiceLimits::default(),
            Some(file_store),
            subagent_options,
        )
    }

    pub fn with_initial_context(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages(
            config,
            provider,
            tools,
            initial_context,
            Vec::new(),
            recorder,
        )
    }

    pub(super) fn with_initial_context_and_pending_messages(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_warnings(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            recorder,
            Vec::new(),
        )
    }

    pub fn with_initial_context_and_warnings(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_warnings(
            config,
            provider,
            tools,
            initial_context,
            Vec::new(),
            recorder,
            warnings,
        )
    }

    fn with_initial_context_and_pending_messages_and_warnings(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            Vec::new(),
            recorder,
            warnings,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            recorder,
            warnings,
            ServiceLimits::default(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_limits(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        replay: SessionReplay,
        recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
    ) -> Result<Self, ServiceError> {
        let context_recorder = recorder
            .clone()
            .map(|recorder| recorder as Arc<dyn AgentContextRecorder>);
        let mut init = ServiceInit::new(config, provider, tools);
        init.initial_context = replay.initial_context;
        init.pending_messages = replay.pending_messages;
        init.known_user_messages = replay.known_user_messages;
        init.message_cursors = replay.message_cursors;
        init.restart_boundary = replay.restart_boundary;
        init.pending_delivery_intents = replay.pending_delivery_intents;
        init.recorder = context_recorder;
        init.session_recorder = recorder;
        init.warnings = warnings;
        init.limits = limits;
        Self::from_init(init)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_recorders_and_limits(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        replay: SessionReplay,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        session_recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
    ) -> Result<Self, ServiceError> {
        Self::with_session_replay_and_recorders_and_limits_and_subagent_options(
            config,
            provider,
            tools,
            replay,
            recorder,
            session_recorder,
            warnings,
            limits,
            ServiceSubagentOptions::default(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_recorders_and_limits_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        replay: SessionReplay,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        session_recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        subagent_options: ServiceSubagentOptions,
    ) -> Result<Self, ServiceError> {
        let mut init = ServiceInit::new(config, provider, tools);
        init.initial_context = replay.initial_context;
        init.pending_messages = replay.pending_messages;
        init.known_user_messages = replay.known_user_messages;
        init.message_cursors = replay.message_cursors;
        init.restart_boundary = replay.restart_boundary;
        init.pending_delivery_intents = replay.pending_delivery_intents;
        init.recorder = recorder;
        init.session_recorder = session_recorder;
        init.warnings = warnings;
        init.limits = limits;
        init.subagent_options = subagent_options;
        Self::from_init(init)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_limits_and_file_store(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        replay: SessionReplay,
        recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: FileStore,
    ) -> Result<Self, ServiceError> {
        Self::with_session_replay_and_limits_and_file_store_and_subagent_options(
            config,
            provider,
            tools,
            replay,
            recorder,
            warnings,
            limits,
            file_store,
            ServiceSubagentOptions::default(),
            DEFAULT_TIMELINE_RETENTION_DAYS,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_limits_and_file_store_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        replay: SessionReplay,
        recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: FileStore,
        subagent_options: ServiceSubagentOptions,
        timeline_retention_days: u64,
    ) -> Result<Self, ServiceError> {
        Self::with_session_replay_and_limits_and_file_store_and_registry_store_and_subagent_options(
            config,
            provider,
            tools,
            replay,
            recorder,
            warnings,
            limits,
            file_store,
            None,
            subagent_options,
            timeline_retention_days,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_limits_and_file_store_and_registry_store_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        replay: SessionReplay,
        recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: FileStore,
        registry_store: Option<RegistryStore>,
        subagent_options: ServiceSubagentOptions,
        timeline_retention_days: u64,
    ) -> Result<Self, ServiceError> {
        Self::with_session_replay_and_limits_and_file_store_and_registry_store_and_subagent_options_and_runtime_selection(
            config,
            provider,
            tools,
            replay,
            recorder,
            warnings,
            limits,
            file_store,
            registry_store,
            subagent_options,
            None,
            timeline_retention_days,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn with_session_replay_and_limits_and_file_store_and_registry_store_and_subagent_options_and_runtime_selection(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        replay: SessionReplay,
        recorder: Option<Arc<FileSessionRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: FileStore,
        registry_store: Option<RegistryStore>,
        subagent_options: ServiceSubagentOptions,
        runtime_selection: Option<RuntimeSelectionHandle>,
        timeline_retention_days: u64,
    ) -> Result<Self, ServiceError> {
        let context_recorder = recorder
            .clone()
            .map(|recorder| recorder as Arc<dyn AgentContextRecorder>);
        let mut init = ServiceInit::new(config, provider, tools);
        init.initial_context = replay.initial_context;
        init.pending_messages = replay.pending_messages;
        init.known_user_messages = replay.known_user_messages;
        init.message_cursors = replay.message_cursors;
        init.restart_boundary = replay.restart_boundary;
        init.pending_delivery_intents = replay.pending_delivery_intents;
        init.recorder = context_recorder;
        init.session_recorder = recorder;
        init.warnings = warnings;
        init.limits = limits;
        init.file_store = Some(file_store);
        init.registry_store = registry_store;
        init.subagent_options = subagent_options;
        init.runtime_selection = runtime_selection;
        init.timeline_retention_days = timeline_retention_days;
        Self::from_init(init)
    }

    #[allow(clippy::too_many_arguments)]
    fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_and_subagent_options(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            recorder,
            warnings,
            limits,
            ServiceSubagentOptions::default(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        subagent_options: ServiceSubagentOptions,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_optional_file_store_and_subagent_options(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            recorder,
            warnings,
            limits,
            None,
            subagent_options,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_optional_file_store(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: Option<FileStore>,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_options(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            recorder,
            warnings,
            limits,
            file_store,
            None,
            ServiceSubagentOptions::default(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_optional_file_store_and_subagent_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: Option<FileStore>,
        subagent_options: ServiceSubagentOptions,
    ) -> Result<Self, ServiceError> {
        Self::with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_options(
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            recorder,
            warnings,
            limits,
            file_store,
            None,
            subagent_options,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn with_initial_context_and_pending_messages_and_known_user_messages_and_warnings_and_limits_with_options(
        config: AgentConfig,
        provider: Arc<dyn Provider>,
        tools: Vec<Arc<dyn Tool>>,
        initial_context: Vec<Message>,
        pending_messages: Vec<DrainedMessage>,
        known_user_messages: Vec<DrainedMessage>,
        recorder: Option<Arc<dyn AgentContextRecorder>>,
        warnings: Vec<String>,
        limits: ServiceLimits,
        file_store: Option<FileStore>,
        registry_store: Option<RegistryStore>,
        subagent_options: ServiceSubagentOptions,
    ) -> Result<Self, ServiceError> {
        let mut init = ServiceInit::new(config, provider, tools);
        init.initial_context = initial_context;
        init.pending_messages = pending_messages;
        init.known_user_messages = known_user_messages;
        init.recorder = recorder;
        init.warnings = warnings;
        init.limits = limits;
        init.file_store = file_store;
        init.registry_store = registry_store;
        init.subagent_options = subagent_options;
        Self::from_init(init)
    }

    pub(super) fn from_init(init: ServiceInit) -> Result<Self, ServiceError> {
        let ServiceInit {
            config,
            provider,
            tools,
            initial_context,
            pending_messages,
            known_user_messages,
            message_cursors,
            restart_boundary,
            recorder,
            session_recorder,
            pending_delivery_intents,
            warnings,
            limits,
            file_store,
            registry_store,
            subagent_options,
            runtime_selection,
            timeline_retention_days,
            #[cfg(test)]
            mut timeline_init_write_failure,
        } = init;
        assert!(
            limits.max_queue_messages > 0,
            "max_queue_messages must be greater than 0"
        );
        assert!(
            limits.max_queue_bytes > 0,
            "max_queue_bytes must be greater than 0"
        );
        let initial_context = repair_provider_transcript(initial_context);
        let restart_boundary = restart_boundary.filter(|boundary| {
            let request_start = boundary.current_request_start_or_context_start(&initial_context);
            !request_range_contains_synthetic_missing_tool_result(
                &initial_context,
                request_start..initial_context.len(),
            )
        });
        let background_tasks = Arc::new(
            BackgroundTaskManager::with_limits_and_task_request_deadline(
                config.task_output.callback_output_tail_bytes,
                config.tool_execution.max_retained_tasks,
                config.tool_execution.task_retention,
                config.tool_execution.max_task_request_pending,
            ),
        );
        let base_tools = tools;
        let subagents_enabled = subagent_options.enabled_flag();
        let validation_tools = with_builtin_service_tools(
            base_tools.clone(),
            BuiltinServiceToolContext {
                background_tasks: background_tasks.clone(),
                inner: Weak::new(),
                file_store: file_store.clone(),
                registry_store: registry_store.clone(),
                runtime_selection: runtime_selection.clone().map(|runtime| (runtime, true)),
                owner: TaskOwner::Main,
                subagents_enabled,
            },
        );
        let main_snapshot = FinalToolSnapshot::build(validation_tools, &config.tool_execution)
            .map_err(|error| ServiceError::Configuration {
                message: format!("invalid main tool configuration: {error}"),
            })?;
        if subagents_enabled {
            if let Some(message) = subagent_tool_configuration_error(
                &base_tools,
                &main_snapshot,
                registry_store.is_some(),
                runtime_selection.is_some(),
            ) {
                return Err(ServiceError::Configuration { message });
            }
        }
        let timeline_options = TimelineStoreOptions::new(
            inferred_timeline_data_dir(&config),
            config.session.as_deref(),
        )
        .retention_days(timeline_retention_days)
        .hot_event_capacity(DEFAULT_TIMELINE_HOT_EVENT_CAPACITY);
        let timeline_store = Arc::new(Mutex::new(
            TimelineStore::open(timeline_options).map_err(timeline_persistence_service_error)?,
        ));
        #[cfg(test)]
        if timeline_init_write_failure
            .as_ref()
            .is_some_and(|(point, _)| *point == TimelineInitAppendPoint::ServiceStarted)
        {
            let (_, failure) = timeline_init_write_failure
                .take()
                .expect("checked timeline init write failure should exist");
            timeline_store
                .lock()
                .expect("timeline store mutex poisoned")
                .inject_next_write_failure(failure);
        }
        let timeline_instance = timeline_store
            .lock()
            .expect("timeline store mutex poisoned")
            .instance()
            .to_owned();
        let event_log = Arc::new(Mutex::new(
            EventLog::with_process_instance(timeline_instance.clone(), DEFAULT_EVENT_LOG_CAPACITY)
                .expect("timeline store instance should be valid"),
        ));
        append_committed_service_event(
            &timeline_store,
            &event_log,
            #[cfg(test)]
            None,
            config.session.as_deref(),
            None,
            "service.started",
            json!({}),
        )
        .map_err(timeline_persistence_service_error)?;
        for warning in &warnings {
            #[cfg(test)]
            if timeline_init_write_failure
                .as_ref()
                .is_some_and(|(point, _)| *point == TimelineInitAppendPoint::ServiceWarning)
            {
                let (_, failure) = timeline_init_write_failure
                    .take()
                    .expect("checked timeline init write failure should exist");
                timeline_store
                    .lock()
                    .expect("timeline store mutex poisoned")
                    .inject_next_write_failure(failure);
            }
            append_committed_service_event(
                &timeline_store,
                &event_log,
                #[cfg(test)]
                None,
                config.session.as_deref(),
                None,
                "service.warning",
                json!({ "message": warning }),
            )
            .map_err(timeline_persistence_service_error)?;
        }
        let replay_cursor = current_timeline_cursor(&timeline_store);
        let replay_cursor_seq = replay_cursor.seq();
        let protected_known_user_message_ids = restart_boundary
            .as_ref()
            .map(SessionRestartBoundary::active_input_ids)
            .unwrap_or(&[]);
        let known_user_messages = retain_recent_known_user_messages_for_replay(
            known_user_messages,
            &pending_messages,
            DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW,
            protected_known_user_message_ids,
        );
        let message_cursors = retain_recent_message_cursors_for_replay(
            message_cursors,
            DEFAULT_ACCEPTED_MESSAGE_REPLAY_WINDOW,
        );
        let queue = pending_messages
            .into_iter()
            .map(|message| QueuedMessage {
                id: message.id,
                content: message.content,
                source: message.source,
                urgency: message.urgency,
                metadata: message.metadata,
                cursor_seq: message.cursor_seq.unwrap_or(replay_cursor_seq),
                delivery: message.delivery,
            })
            .collect::<VecDeque<_>>();
        let message_cursors = message_cursors
            .into_iter()
            .map(|cursor| {
                let terminal_seq = durable_terminal_seq(
                    cursor.replay_start_seq,
                    cursor.terminal_seq,
                    !cursor.replay_events.is_empty(),
                );
                (cursor, terminal_seq)
            })
            .collect::<Vec<_>>();
        let mut cursor_seqs = message_cursors
            .iter()
            .flat_map(|(cursor, terminal_seq)| [cursor.replay_start_seq, *terminal_seq])
            .collect::<Vec<_>>();
        cursor_seqs.extend(queue.iter().map(|message| message.cursor_seq));
        let retained_cursor_seqs = retained_cursor_seqs_for_replay(&timeline_store, &cursor_seqs)?;
        let mut durable_message_replays = HashMap::new();
        let mut durable_message_index_cursors = HashMap::new();
        for (cursor, terminal_seq) in message_cursors {
            let fully_retained = retained_cursor_seqs.contains(&cursor.replay_start_seq)
                && (terminal_seq <= cursor.replay_start_seq
                    || retained_cursor_seqs.contains(&terminal_seq));
            let message_cursor = if fully_retained {
                EventCursor::for_instance(timeline_instance.clone(), cursor.replay_start_seq)
                    .expect("timeline store instance should be valid")
            } else {
                replay_cursor.clone()
            };
            durable_message_index_cursors.insert(cursor.message_id.clone(), message_cursor);
            durable_message_replays.insert(
                cursor.message_id,
                DurableMessageReplay {
                    replay_start_seq: cursor.replay_start_seq,
                    terminal_seq,
                    events: cursor.replay_events,
                },
            );
        }
        let mut message_index = HashMap::new();
        for message in &known_user_messages {
            if let Some(cursor) = durable_message_index_cursors.get(&message.id) {
                insert_message_index_entry_with_delivery(
                    &mut message_index,
                    message.id.clone(),
                    message.content.clone(),
                    cursor.clone(),
                    message.delivery.clone(),
                );
            } else {
                insert_message_index_entry_with_projection_state_and_delivery(
                    &mut message_index,
                    message.id.clone(),
                    message.content.clone(),
                    replay_cursor.clone(),
                    MessageProjectionState::MissingProjection,
                    message.delivery.clone(),
                );
            }
        }
        for message in &queue {
            let cursor = if retained_cursor_seqs.contains(&message.cursor_seq) {
                EventCursor::for_instance(timeline_instance.clone(), message.cursor_seq)
                    .expect("timeline store instance should be valid")
            } else {
                replay_cursor.clone()
            };
            insert_message_index_entry_with_delivery(
                &mut message_index,
                message.id.clone(),
                message.content.clone(),
                cursor,
                message.delivery.clone(),
            );
        }

        let event_notify = Arc::new(Notify::new());
        let initial_state = ServiceInnerState {
            state: ServiceState::Idle,
            context: initial_context,
            input_queue: InputQueueState::new(queue),
            known_user_messages,
            service_workers: ServiceWorkerRegistry::default(),
            message_index,
            durable_message_replays,
            restart_boundary,
            next_turn_number: 1,
            active_turn_id: None,
            active_cancel: None,
            last_error: None,
            context_maintenance: ContextMaintenanceStatus::default(),
            pending_recovery_record: None,
            durable_transcript_epoch: 0,
        };
        let mut initial_state = initial_state;
        prune_message_index_to_retained_window(&mut initial_state);
        prune_durable_message_replays_to_retained_window(&mut initial_state);
        let subagent_callback_epoch = new_subagent_callback_epoch();
        let registry_maintenance_cancel = CancellationToken::new();

        let subagent_manager = SubagentManager::new(subagent_options.limits())
            .expect("service subagent limits must be valid");
        let inner = Arc::new_cyclic(|weak_inner| {
            let tools = with_builtin_service_tools(
                base_tools.clone(),
                BuiltinServiceToolContext {
                    background_tasks: background_tasks.clone(),
                    inner: weak_inner.clone(),
                    file_store: file_store.clone(),
                    registry_store: registry_store.clone(),
                    runtime_selection: runtime_selection.clone().map(|runtime| (runtime, true)),
                    owner: TaskOwner::Main,
                    subagents_enabled,
                },
            );
            let main_snapshot = main_snapshot.with_tools(tools.clone());
            ServiceInner {
                self_weak: weak_inner.clone(),
                config,
                provider,
                base_tools: base_tools.clone(),
                #[cfg(test)]
                tools,
                tool_snapshot: Some(Arc::new(main_snapshot)),
                configuration_error: Mutex::new(None),
                file_store: file_store.clone(),
                registry_store: registry_store.clone(),
                registry_maintenance_cancel: registry_maintenance_cancel.clone(),
                registry_maintenance_join: Mutex::new(None),
                provider_summaries: Mutex::new(Vec::new()),
                runtime_selection,
                recorder,
                session_recorder,
                pending_delivery_intents: Mutex::new(pending_delivery_intents.into()),
                service_projection_notify: Arc::new(Notify::new()),
                service_projection_runner: AsyncMutex::new(()),
                service_projection_worker_started: AtomicBool::new(false),
                service_status_generation: AtomicU64::new(0),
                published_service_status_generation: AtomicU64::new(0),
                dirty_service_status_generation: AtomicU64::new(0),
                event_commit_gate: Mutex::new(()),
                commit_gate: AsyncMutex::new(()),
                compact: CompactCoordinator::default(),
                background_tasks,
                subagent_options,
                subagents: Mutex::new(subagent_manager),
                subagent_lifecycle: Mutex::new(()),
                subagent_contexts: Mutex::new(HashMap::new()),
                subagent_cancels: Mutex::new(HashMap::new()),
                subagent_providers: Mutex::new(HashMap::new()),
                subagent_runtime_selections: Mutex::new(HashMap::new()),
                subagent_tool_snapshots: Mutex::new(HashMap::new()),
                subagent_callback_epoch,
                next_subagent_callback_seq: AtomicU64::new(1),
                task_presets: Mutex::new(RuntimeTaskPresetsConfig::default()),
                task_preset_bash_tool: Mutex::new(None),
                #[cfg(test)]
                subagent_test_hooks: SubagentTestHooks::default(),
                limits,
                timeline_store,
                next_service_event_write_failure: Mutex::new(None),
                next_agent_event_write_failure: Mutex::new(None),
                #[cfg(test)]
                event_commit_test_hook: EventCommitTestHook::default(),
                #[cfg(test)]
                bootstrap_state_snapshot_test_hook: Mutex::new(None),
                #[cfg(test)]
                bootstrap_task_snapshot_test_hook: Mutex::new(None),
                #[cfg(test)]
                status_state_snapshot_test_hook: Mutex::new(None),
                event_log,
                event_notify,
                public_replay: Mutex::new(PublicReplayProjectionBuffer::default()),
                intake_gate: AsyncMutex::new(()),
                task_frame_admission_gate: Mutex::new(TaskFrameAdmissionGate::default()),
                task_frame_lanes: Mutex::new(HashMap::new()),
                stdio_diagnostics: Mutex::new(InternalStdioDiagnostics::default()),
                state: Mutex::new(initial_state),
                notify: Notify::new(),
                profiler: Mutex::new(None),
                llm_text_preview_enabled: AtomicBool::new(false),
                llm_text_preview_hub: LlmTextPreviewHub::new(),
                task_observer: TaskConversationObserver::new({
                    let weak_inner = weak_inner.clone();
                    move |diagnostic| {
                        if let Some(inner) = weak_inner.upgrade() {
                            inner.record_task_observer_diagnostic(diagnostic);
                        }
                    }
                }),
                task_observer_preview_loop_started: Arc::new(AtomicBool::new(false)),
                task_observer_preview_cancel: CancellationToken::new(),
                task_observer_preview_join: Mutex::new(None),
            }
        });

        inner.ensure_registry_maintenance();

        if let Some(message) = inner
            .configuration_error
            .lock()
            .expect("service configuration error mutex poisoned")
            .clone()
        {
            return Err(ServiceError::Configuration { message });
        }

        inner.ensure_service_projection_retry_loop();
        inner.service_projection_notify.notify_one();

        Ok(Self { inner })
    }

    pub fn with_task_presets(self, task_presets: RuntimeTaskPresetsConfig) -> Self {
        self.set_task_presets(task_presets);
        self
    }

    pub fn with_task_preset_bash_tool(self, bash_tool: BashTool) -> Self {
        *self
            .inner
            .task_preset_bash_tool
            .lock()
            .expect("task preset bash tool mutex poisoned") = Some(bash_tool);
        self
    }
}
