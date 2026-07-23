use std::collections::BTreeSet;
use std::env;
use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use botified::config::{
    resolve_files_root_dir, resolve_runtime_paths, RuntimeConfig, RuntimeTool,
    RuntimeToolExecutionConfig,
};
use botified::files::{FileStore, FileStoreOptions};
use botified::profiling::{resolve_profiling_config, CsvProfiler, SharedProfiler};
use botified::provider::openai_chat::OpenAiChatProvider;
use botified::provider::runtime_selection::RuntimeSelectionHandle;
use botified::provider::thinking::ThinkingConfig;
use botified::session::open_or_create_session_in_home_with_cwd;
use botified::{
    load_context_files, try_load_skills, AgentConfig, BashTool, ContextFileLoadConfig, Provider,
    ProviderEndpoint, ProviderError, ProviderRequest, ProviderResponse, RegistryStore, Service,
    ServiceLimits, ServiceSubagentOptions, SkillLoadConfig, SubagentLimits, TaskOutputPolicy, Tool,
    ToolExecutionPolicy, ViewImageTool,
};
use tokio_util::sync::CancellationToken;

use super::{missing_config_message, serve_data_dir_lock, StartupError};

pub(super) struct RuntimeAssembly {
    pub(super) service: Service,
    pub(super) service_key: Option<String>,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) terminal: botified::http::TerminalConfig,
    _data_dir_lock: serve_data_dir_lock::ServeDataDirLock,
}

pub(super) fn assemble_runtime(
    requested_path: &Path,
    mock: bool,
    startup_dir: &Path,
) -> Result<RuntimeAssembly, Box<dyn Error>> {
    let config_path = botified::path_utils::lexical_absolute(requested_path, startup_dir);
    let runtime_config = match fs::metadata(&config_path) {
        Ok(_) => RuntimeConfig::load(&config_path)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(Box::new(StartupError::new(missing_config_message(
                &config_path,
                mock,
            ))));
        }
        Err(error) => {
            return Err(Box::new(StartupError::new(format!(
                "failed to inspect runtime config {}: {error}",
                config_path.display()
            ))));
        }
    };

    let paths = resolve_runtime_paths(&config_path, startup_dir, &runtime_config.runtime)?;
    eprintln!(
        "botified runtime paths: config_path={} startup_dir={} cwd={} data_dir={}",
        paths.config_path.display(),
        paths.startup_dir.display(),
        paths.cwd.display(),
        paths.data_dir.display()
    );
    let cwd = paths.cwd;
    let data_dir = paths.data_dir;
    let _data_dir_lock = serve_data_dir_lock::ServeDataDirLock::acquire(&data_dir)?;
    let profiler = match resolve_profiling_config(&runtime_config.profiling, &data_dir)? {
        Some(config) => {
            let profiler = CsvProfiler::create_shared(config)?;
            let report_dir = profiler
                .lock()
                .expect("profiler mutex poisoned")
                .report_dir()
                .to_path_buf();
            eprintln!("botified profiling report dir: {}", report_dir.display());
            Some(profiler)
        }
        None => None,
    };
    let service_key = runtime_config.resolve_service_key(env::vars())?;
    let skill_load_config = SkillLoadConfig {
        cwd: cwd.clone(),
        data_dir: Some(data_dir.clone()),
        botified_home: None,
        explicit: runtime_config.skills.explicit.clone(),
        default_discovery: runtime_config.skills.default_discovery,
    };
    let context_file_load_config = ContextFileLoadConfig {
        cwd: cwd.clone(),
        data_dir: Some(data_dir.clone()),
        botified_home: None,
        default_discovery: runtime_config.context_files.enabled,
        max_total_bytes: runtime_config.context_files.max_total_bytes,
    };
    let loaded_context_files = load_context_files(&context_file_load_config);
    let loaded_skills = try_load_skills(&skill_load_config)?;
    let mut startup_warnings = loaded_context_files.warnings.clone();
    startup_warnings.extend(loaded_skills.warnings.clone());
    let base_system_prompt = "You are Botified, a minimal headless agent service.";
    let mut config = AgentConfig::new(base_system_prompt)
        .with_cwd(cwd.display().to_string())
        .with_skills(loaded_skills.skills)
        .with_tool_execution_policy(tool_execution_policy(&runtime_config.tools.execution))
        .with_task_output_policy(task_output_policy(
            data_dir.clone(),
            &runtime_config.tools.execution,
        ))
        .with_prompt_refresh(
            base_system_prompt,
            skill_load_config,
            context_file_load_config,
        );
    let (replay, recorder) = if let Some(session) = runtime_config.runtime.session.clone() {
        let mut session =
            open_or_create_session_in_home_with_cwd(&session, &data_dir, config.cwd.clone())?;
        if !runtime_config.runtime.resume_unfinished {
            session.discard_unfinished_sync()?;
        }
        startup_warnings.extend(session.warnings().iter().cloned());
        config = config.with_session(session.name().to_owned());
        (session.replay(), Some(session.recorder()))
    } else {
        (botified::SessionReplay::default(), None)
    };
    for warning in &startup_warnings {
        eprintln!("warning: {warning}");
    }

    let provider_endpoints =
        build_provider_endpoints(&runtime_config, mock, env::vars(), profiler.clone())?;
    let runtime_selection = RuntimeSelectionHandle::new_mutable(provider_endpoints)?;
    let subagent_options = build_subagent_options(&runtime_config)?;
    let provider = runtime_selection.provider();
    let tool_provider = runtime_selection.auto_provider();
    let bash_tool =
        BashTool::from_executor_addr(&runtime_config.tools.execution.bash_executor_addr)
            .and_then(|tool| {
                tool.with_exact_secret_env_names(configured_credential_env_names(&runtime_config))
            })
            .map_err(StartupError::new)?;
    let tools = build_tools(&runtime_config.tools.enabled, tool_provider, &bash_tool)
        .map_err(StartupError::new)?;
    let limits = ServiceLimits::new(runtime_config.service.max_queue_messages)
        .with_max_queue_bytes(runtime_config.service.max_queue_bytes);
    let files_root_dir = resolve_files_root_dir(&runtime_config.files, &data_dir);
    let file_store = FileStore::open(
        FileStoreOptions::new(files_root_dir.clone())
            .with_max_file_bytes(runtime_config.files.max_file_bytes)
            .with_max_upload_files(runtime_config.files.max_upload_files)
            .with_max_upload_request_bytes(runtime_config.files.max_upload_request_bytes)
            .with_max_message_files(runtime_config.files.max_message_files)
            .with_max_message_referenced_file_bytes(
                runtime_config.files.max_message_referenced_file_bytes,
            )
            .with_max_store_bytes(runtime_config.files.max_store_bytes)
            .with_retention_secs(runtime_config.files.retention_secs),
    )?;
    eprintln!("botified files root: {}", files_root_dir.display());
    let registry_store = build_registry_store(&runtime_config)?;
    let service = Service::with_session_replay_and_limits_and_file_store_and_registry_store_and_subagent_options_and_runtime_selection(
        config,
        provider,
        tools,
        replay,
        recorder,
        startup_warnings,
        limits,
        file_store,
        registry_store,
        subagent_options,
        Some(runtime_selection),
        runtime_config.timeline.retention_days,
    )?
    .with_task_presets(runtime_config.task_presets.clone())
    .with_task_preset_bash_tool(bash_tool)
    .with_provider_summaries(runtime_config.provider_summaries())
    .with_profiler(profiler.clone())
    .with_llm_text_preview_enabled(runtime_config.llm_text_preview.enabled);

    Ok(RuntimeAssembly {
        service,
        service_key,
        host: runtime_config.service.host,
        port: runtime_config.service.port,
        terminal: botified::http::TerminalConfig {
            executor_addr: runtime_config
                .tools
                .execution
                .bash_executor_addr
                .parse()
                .map_err(|error| {
                    StartupError::new(format!("invalid bash executor address: {error}"))
                })?,
            cwd: cwd.display().to_string(),
        },
        _data_dir_lock,
    })
}

fn build_subagent_options(
    runtime_config: &RuntimeConfig,
) -> Result<ServiceSubagentOptions, Box<dyn Error>> {
    if !runtime_config.subagents.enabled {
        return Ok(ServiceSubagentOptions::disabled());
    }

    let options = ServiceSubagentOptions::enabled(SubagentLimits::new(
        runtime_config.subagents.max_parallel,
        runtime_config.subagents.max_branches,
    ));
    Ok(options)
}

fn build_registry_store(
    runtime_config: &RuntimeConfig,
) -> Result<Option<RegistryStore>, StartupError> {
    if !runtime_config.registry.enabled {
        return Ok(None);
    }

    RegistryStore::with_options(
        runtime_config.registry.store_config(),
        runtime_config.registry.store_options(),
    )
    .map(Some)
    .map_err(|error| StartupError::new(error.to_string()))
}

fn build_provider_endpoints(
    runtime_config: &RuntimeConfig,
    mock_provider: bool,
    env: impl IntoIterator<Item = (String, String)>,
    profiler: Option<SharedProfiler>,
) -> Result<Vec<ProviderEndpoint>, Box<dyn Error>> {
    runtime_config.validate()?;
    if mock_provider {
        return Ok(runtime_config
            .providers
            .iter()
            .map(|provider| {
                let mock_provider = Arc::new(DevelopmentMockProvider) as Arc<dyn Provider>;
                ProviderEndpoint::new(
                    provider.name.clone(),
                    provider.priority,
                    provider.capabilities.clone(),
                    mock_provider.clone(),
                )
                .with_api_compat(provider.api_compat)
                .with_default_thinking_level(provider.thinking.level)
                .with_thinking_variant_factory(move |_| Ok(mock_provider.clone()))
                .with_model(provider.model.clone())
                .with_optional_context_window_tokens(provider.context_window_tokens)
                .with_optional_max_output_tokens(provider.max_output_tokens)
            })
            .collect());
    }

    runtime_config
        .resolved_provider_configs(env)?
        .into_iter()
        .map(|resolved| {
            let model = resolved.config.model.clone();
            let context_window_tokens = resolved.config.context_window_tokens;
            let max_output_tokens = resolved.config.max_output_tokens;
            let api_compat = resolved.config.api_compat;
            let default_thinking_level = resolved.config.thinking.level;
            let variant_config = resolved.config.clone();
            let variant_profiler = profiler.clone();
            let provider =
                Arc::new(OpenAiChatProvider::new(resolved.config)?.with_profiler(profiler.clone()))
                    as Arc<dyn Provider>;
            Ok(ProviderEndpoint::new(
                resolved.name,
                resolved.priority,
                resolved.capabilities,
                provider,
            ))
            .map(|endpoint| {
                endpoint
                    .with_api_compat(api_compat)
                    .with_default_thinking_level(default_thinking_level)
                    .with_thinking_variant_factory(move |thinking_level| {
                        let config = variant_config
                            .clone()
                            .with_thinking(ThinkingConfig::new(thinking_level));
                        Ok(Arc::new(
                            OpenAiChatProvider::new(config)?
                                .with_profiler(variant_profiler.clone()),
                        ) as Arc<dyn Provider>)
                    })
                    .with_model(model)
                    .with_optional_context_window_tokens(context_window_tokens)
                    .with_optional_max_output_tokens(max_output_tokens)
            })
        })
        .collect::<Result<Vec<_>, ProviderError>>()
        .map_err(|error| Box::new(error) as Box<dyn Error>)
}

fn build_tools(
    enabled: &[RuntimeTool],
    provider: Arc<dyn Provider>,
    bash_tool: &BashTool,
) -> Result<Vec<Arc<dyn Tool>>, String> {
    let mut tools: Vec<Arc<dyn Tool>> = Vec::with_capacity(enabled.len());
    for tool in enabled {
        match tool {
            RuntimeTool::Bash => tools.push(Arc::new(bash_tool.clone())),
            RuntimeTool::ViewImage => tools.push(Arc::new(ViewImageTool::new(provider.clone()))),
        }
    }
    Ok(tools)
}

fn configured_credential_env_names(runtime_config: &RuntimeConfig) -> BTreeSet<String> {
    runtime_config
        .providers
        .iter()
        .map(|provider| provider.api_key_env.clone())
        .chain(
            runtime_config
                .service
                .service_key_env
                .as_deref()
                .map(str::trim)
                .map(str::to_owned),
        )
        .collect()
}

fn tool_execution_policy(execution: &RuntimeToolExecutionConfig) -> ToolExecutionPolicy {
    ToolExecutionPolicy::default()
        .with_default_detach_after(execution.default_detach_after_secs.as_duration())
        .with_max_detach_after(execution.max_detach_after_secs.as_duration())
        .with_default_timeout(execution.default_timeout_secs.as_duration())
        .with_max_timeout(execution.max_timeout_secs.as_duration())
        .with_max_concurrent_tasks(execution.max_concurrent_tasks)
        .with_max_retained_tasks(execution.max_retained_tasks)
        .with_task_retention(Duration::from_secs(execution.task_retention_secs))
        .with_max_task_request_pending(execution.max_task_ask_pending_secs.as_duration())
}

fn task_output_policy(
    data_dir: PathBuf,
    execution: &RuntimeToolExecutionConfig,
) -> TaskOutputPolicy {
    TaskOutputPolicy::new(
        data_dir,
        execution.callback_output_tail_bytes,
        execution.max_task_output_bytes,
    )
}

struct DevelopmentMockProvider;

const RELEASE_CHECK_TRIGGER: &str = "BOTIFIED_RELEASE_CHECK_BASH";
const RELEASE_CHECK_TOOL_CALL_ID: &str = "release_check_bash";
const RELEASE_CHECK_OUTPUT_MARKER: &str = "BOTIFIED_RELEASE_CHECK_OUTPUT";

#[async_trait]
impl Provider for DevelopmentMockProvider {
    async fn complete(
        &self,
        request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        let messages = request.transcript_messages();
        if pending_release_check_tool_result(&messages) {
            return Ok(ProviderResponse::text("release check bash complete"));
        }

        let text = latest_user_text(&messages).unwrap_or("message received");
        if text.contains(RELEASE_CHECK_TRIGGER)
            && request.tools.iter().any(|tool| tool.name == "bash")
        {
            return Ok(ProviderResponse::tool_calls(vec![botified::ToolCall::new(
                RELEASE_CHECK_TOOL_CALL_ID,
                "bash",
                serde_json::json!({
                    "command": format!("sleep 1; printf '{RELEASE_CHECK_OUTPUT_MARKER}\\n'"),
                    "timeout_secs": 5
                }),
            )]));
        }

        Ok(ProviderResponse::text(format!(
            "development mock response: {text}"
        )))
    }
}

fn latest_user_text(messages: &[botified::Message]) -> Option<&str> {
    messages.iter().rev().find_map(|message| match message {
        botified::Message::User { content } => content.iter().find_map(|part| match part {
            botified::ContentPart::Text { text } => Some(text.as_str()),
            botified::ContentPart::ImageUrl { .. }
            | botified::ContentPart::ImageBase64 { .. }
            | botified::ContentPart::File { .. }
            | botified::ContentPart::Skill { .. } => None,
        }),
        botified::Message::Assistant { .. } | botified::Message::ToolResult(_) => None,
    })
}

fn pending_release_check_tool_result(messages: &[botified::Message]) -> bool {
    for message in messages.iter().rev() {
        match message {
            botified::Message::ToolResult(result)
                if result.tool_call_id == RELEASE_CHECK_TOOL_CALL_ID =>
            {
                return true;
            }
            botified::Message::Assistant {
                content: Some(_),
                tool_calls,
                ..
            } if tool_calls.is_empty() => return false,
            botified::Message::User { .. }
            | botified::Message::Assistant { .. }
            | botified::Message::ToolResult(_) => {}
        }
    }
    false
}

#[cfg(test)]
pub(super) fn test_temp_dir(name: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time should be after epoch")
        .as_nanos();
    let path = env::temp_dir().join(format!(
        "botified-main-{name}-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&path).expect("create temp dir");
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use botified::provider::thinking::ThinkingLevel;
    use botified::{ToolCall, ToolExecutionContext};
    use serde_json::json;

    struct EnvRestore {
        key: &'static str,
        value: Option<std::ffi::OsString>,
    }

    impl EnvRestore {
        fn capture(key: &'static str) -> Self {
            Self {
                key,
                value: env::var_os(key),
            }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            match &self.value {
                Some(value) => env::set_var(self.key, value),
                None => env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn runtime_paths_resolve_relative_to_config_and_agent_cwd() {
        let startup = test_temp_dir("runtime-paths").join("startup");
        let cwd = startup.join("config").join("workspace");
        std::fs::create_dir_all(&cwd).expect("create runtime cwd");

        let mut config = RuntimeConfig::example();
        config.runtime.cwd = PathBuf::from("workspace");
        config.runtime.data_dir = PathBuf::from(".botified/state");
        let paths =
            resolve_runtime_paths(Path::new("config/botified.yaml"), &startup, &config.runtime)
                .expect("runtime paths should resolve");

        assert_eq!(paths.cwd, cwd);
        assert_eq!(paths.data_dir, paths.cwd.join(".botified").join("state"));
    }

    #[test]
    fn build_tools_maps_bash_view_image_and_empty_config() {
        let provider = Arc::new(DevelopmentMockProvider) as Arc<dyn Provider>;
        let enabled = RuntimeConfig::example().tools.enabled;
        let tools = build_tools(
            &enabled,
            provider.clone(),
            &BashTool::new("127.0.0.1:9".parse().expect("test address")),
        )
        .expect("default example tools should build");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].spec().name, "bash");
        assert_eq!(tools[1].spec().name, "view_image");

        let tools = build_tools(
            &[],
            provider,
            &BashTool::new("127.0.0.1:9".parse().expect("test address")),
        )
        .expect("empty tool config should build");
        assert!(tools.is_empty());
    }

    #[test]
    fn configured_credential_env_names_collects_all_providers_and_service_with_deduplication() {
        let mut config = RuntimeConfig::example();
        config.providers.truncate(3);
        config.providers[0].api_key_env = "GALBOT_CONTROL".to_owned();
        config.providers[1].api_key_env = "GALBOT_OTHER_CONTROL".to_owned();
        config.providers[2].api_key_env = "GALBOT_CONTROL".to_owned();
        config.service.service_key_env = Some("  GALBOT_OTHER_CONTROL  ".to_owned());

        assert_eq!(
            configured_credential_env_names(&config),
            BTreeSet::from([
                "GALBOT_CONTROL".to_owned(),
                "GALBOT_OTHER_CONTROL".to_owned(),
            ])
        );
    }

    #[tokio::test]
    async fn configured_runtime_generic_bash_filters_exact_credential_env() {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;

        const CREDENTIAL_ENV: &str = "GALBOT_RUNTIME_CONTROL";
        let _restore = EnvRestore::capture(CREDENTIAL_ENV);
        env::set_var(CREDENTIAL_ENV, "runtime-credential-value");
        let mut config = RuntimeConfig::example();
        config.providers[0].api_key_env = CREDENTIAL_ENV.to_owned();
        let listener = TcpListener::bind("127.0.0.1:0").expect("executor listener should bind");
        let address = listener
            .local_addr()
            .expect("executor address should resolve");
        let executor = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("executor should accept");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("stream should clone"))
                .read_line(&mut request)
                .expect("execute request should read");
            let request: serde_json::Value =
                serde_json::from_str(request.trim_end()).expect("request should parse");
            let command = request["command"].as_str().expect("command should be text");
            assert!(command.contains("builtin unset -v -- GALBOT_RUNTIME_CONTROL"));
            writeln!(
                stream,
                "{}",
                json!({"op": "output", "data": BASE64.encode(b"control=unset\n")})
            )
            .expect("output event should write");
            writeln!(stream, "{}", json!({"op": "completed", "exit_code": 0}))
                .expect("completion event should write");
        });
        let bash_tool = BashTool::new(address)
            .with_exact_secret_env_names(configured_credential_env_names(&config))
            .expect("runtime credential env names should be valid");
        let provider = Arc::new(DevelopmentMockProvider) as Arc<dyn Provider>;
        let tools = build_tools(&[RuntimeTool::Bash], provider, &bash_tool)
            .expect("configured bash tool should build");

        let result = tools[0]
            .execute(
                ToolCall::new(
                    "call_runtime_bash",
                    "bash",
                    json!({"command": "printf 'control=%s\\n' \"${GALBOT_RUNTIME_CONTROL-unset}\""}),
                ),
                ToolExecutionContext::new("."),
                CancellationToken::new(),
            )
            .await
            .expect("configured runtime bash should execute");
        executor.join().expect("executor should finish");

        assert!(!result.is_error, "{}", result.text);
        assert!(result.text.contains("control=unset"), "{}", result.text);
        assert!(
            !result.text.contains("runtime-credential-value"),
            "{}",
            result.text
        );
    }

    #[test]
    fn provider_endpoints_follow_runtime_config() {
        let mut config = RuntimeConfig::example();
        config.tools.enabled = vec![RuntimeTool::Bash];
        let provider_secrets = [
            ("BOTIFIED_TEXT_API_KEY", "text-secret-value"),
            ("BOTIFIED_VISION_API_KEY", "vision-secret-value"),
            ("BOTIFIED_REASONING_API_KEY", "reasoning-secret-value"),
            ("BOTIFIED_GLM_API_KEY", "glm-secret-value"),
            ("BOTIFIED_ZAI_GLM_API_KEY", "zai-glm-secret-value"),
        ];

        let endpoints = build_provider_endpoints(
            &config,
            false,
            provider_secrets
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned())),
            None,
        )
        .expect("provider endpoints should build");

        assert_eq!(endpoints.len(), config.providers.len());
        assert_eq!(endpoints[0].name(), "text-main");
        assert_eq!(endpoints[0].priority(), 10);
        assert_eq!(
            endpoints[0].capabilities(),
            &config.providers[0].capabilities
        );
        assert_eq!(endpoints[0].context_window_tokens(), Some(131_072));
        assert_eq!(endpoints[0].max_output_tokens(), Some(32_768));
        assert_eq!(endpoints[0].default_thinking_level(), ThinkingLevel::Off);

        let reasoning_endpoint = endpoints
            .iter()
            .find(|endpoint| endpoint.name() == "reasoning-main")
            .expect("reasoning provider endpoint should build");
        assert_eq!(
            reasoning_endpoint.default_thinking_level(),
            ThinkingLevel::XHigh
        );

        let glm_endpoint = endpoints
            .iter()
            .find(|endpoint| endpoint.name() == "glm-tools")
            .expect("dashscope glm provider endpoint should build");
        assert_eq!(glm_endpoint.model(), Some("glm-model"));
        assert_eq!(glm_endpoint.priority(), 40);
        assert_eq!(glm_endpoint.context_window_tokens(), Some(131_072));
        assert_eq!(glm_endpoint.max_output_tokens(), Some(32_768));
        assert_eq!(
            glm_endpoint.capabilities(),
            &config.providers[3].capabilities
        );
        assert_eq!(glm_endpoint.default_thinking_level(), ThinkingLevel::XHigh);

        let glm_metadata = glm_endpoint
            .as_single_provider()
            .metadata_for_request(&ProviderRequest::new("", Vec::new(), Vec::new()))
            .expect("dashscope glm provider metadata should be available");
        assert_eq!(
            glm_metadata
                .api_compat
                .as_ref()
                .map(|api_compat| api_compat.as_str()),
            Some("dashscope_glm")
        );

        let zai_endpoint = endpoints
            .iter()
            .find(|endpoint| endpoint.name() == "zai-glm-coding")
            .expect("zai glm provider endpoint should build");
        assert_eq!(zai_endpoint.model(), Some("glm-5.2"));
        assert_eq!(zai_endpoint.priority(), 50);
        assert_eq!(
            zai_endpoint.capabilities(),
            &config.providers[4].capabilities
        );

        let metadata = zai_endpoint
            .as_single_provider()
            .metadata_for_request(&ProviderRequest::new("", Vec::new(), Vec::new()))
            .expect("zai glm provider metadata should be available");
        assert_eq!(metadata.profile, "zai-glm-coding");
        assert_eq!(metadata.name.as_deref(), Some("zai-glm-coding"));
        assert_eq!(metadata.model.as_deref(), Some("glm-5.2"));
        assert_eq!(metadata.context_window_tokens, Some(131_072));
        assert_eq!(metadata.max_output_tokens, Some(32_768));
        assert_eq!(
            metadata
                .api_compat
                .as_ref()
                .map(|api_compat| api_compat.as_str()),
            Some("zai_glm")
        );
        let rendered_metadata =
            serde_yaml::to_string(&metadata).expect("provider metadata should serialize");
        for (_, secret) in provider_secrets {
            assert!(!rendered_metadata.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn mock_provider_endpoints_do_not_require_api_key_env() {
        let mut config = RuntimeConfig::example();
        config.tools.enabled = vec![RuntimeTool::Bash];

        let endpoints =
            build_provider_endpoints(&config, true, std::iter::empty::<(String, String)>(), None)
                .expect("mock provider endpoints should build without provider API keys");

        assert_eq!(endpoints.len(), config.providers.len());
        assert_eq!(endpoints[1].name(), "vision-main");
        assert_eq!(
            endpoints[0].default_thinking_level(),
            config.providers[0].thinking.level
        );
        assert_eq!(endpoints[2].default_thinking_level(), ThinkingLevel::XHigh);
    }
}
