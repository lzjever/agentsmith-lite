use std::env;
use std::error::Error;
use std::fmt;
use std::future::{Future, IntoFuture};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use botified::config::{
    resolve_files_root_dir, resolve_runtime_paths, RuntimeConfig, RuntimeConfigLoad, RuntimeTool,
    RuntimeToolExecutionConfig,
};
use botified::files::{FileStore, FileStoreOptions};
use botified::http::router;
use botified::profiling::{resolve_profiling_config, CsvProfiler, SharedProfiler};
use botified::provider::openai_chat::OpenAiChatProvider;
use botified::session::open_or_create_session_in_home_with_cwd;
use botified::{
    load_context_files, try_load_skills, AgentConfig, BashTool, ContextFileLoadConfig, Provider,
    ProviderEndpoint, ProviderError, ProviderRequest, ProviderResponse, ProviderRouter,
    RegistryStore, Service, ServiceLimits, ServiceSubagentOptions, SkillLoadConfig, SubagentLimits,
    TaskOutputPolicy, Tool, ToolExecutionPolicy, ViewImageTool,
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

const HTTP_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(2);
    }
}

async fn run() -> Result<(), Box<dyn Error>> {
    let action = CliAction::parse(env::args().skip(1))?;
    match action {
        CliAction::Help => {
            println!("{}", usage());
            Ok(())
        }
        CliAction::Serve(args) => run_serve(args).await,
    }
}

async fn run_serve(args: ServeArgs) -> Result<(), Box<dyn Error>> {
    let startup_dir = env::current_dir()?;
    let config_path = botified::path_utils::lexical_absolute(&args.config_path, &startup_dir);
    let runtime_config = match RuntimeConfig::load_or_write_example(&config_path)? {
        RuntimeConfigLoad::Loaded(config) => *config,
        RuntimeConfigLoad::GeneratedExample { path } => {
            eprintln!("{}", generated_config_message(&path));
            return Ok(());
        }
    };

    let paths = resolve_runtime_paths(&config_path, &startup_dir, &runtime_config.runtime)?;
    eprintln!(
        "botified runtime paths: config_path={} startup_dir={} cwd={} data_dir={}",
        paths.config_path.display(),
        paths.startup_dir.display(),
        paths.cwd.display(),
        paths.data_dir.display()
    );
    let cwd = paths.cwd;
    let data_dir = paths.data_dir;
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
    config.compact = runtime_config.compact.clone();
    let (
        initial_context,
        pending_messages,
        known_user_messages,
        message_cursors,
        restart_boundary,
        recorder,
    ): (
        Vec<_>,
        Vec<_>,
        Vec<_>,
        Vec<_>,
        Option<botified::SessionRestartBoundary>,
        Option<Arc<botified::FileSessionRecorder>>,
    ) = if let Some(session) = runtime_config.runtime.session.clone() {
        let session =
            open_or_create_session_in_home_with_cwd(&session, &data_dir, config.cwd.clone())?;
        startup_warnings.extend(session.warnings().iter().cloned());
        config = config.with_session(session.name().to_owned());
        (
            session.initial_messages().to_vec(),
            session.pending_messages().to_vec(),
            session.known_user_messages().to_vec(),
            session.message_cursors().to_vec(),
            session.restart_boundary().cloned(),
            Some(session.recorder()),
        )
    } else {
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), None, None)
    };
    for warning in &startup_warnings {
        eprintln!("warning: {warning}");
    }

    let provider_endpoints = build_provider_endpoints(
        &runtime_config,
        args.mock_provider,
        env::vars(),
        profiler.clone(),
    )?;
    let subagent_options = build_subagent_options(&runtime_config, &provider_endpoints)?;
    let provider = Arc::new(ProviderRouter::new(provider_endpoints)) as Arc<dyn Provider>;
    let tools =
        build_tools(&runtime_config.tools.enabled, provider.clone()).map_err(StartupError::new)?;
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
    let service = Service::with_session_replay_and_restart_boundary_and_limits_and_file_store_and_registry_store_and_subagent_options(
        config,
        provider,
        tools,
        initial_context,
        pending_messages,
        known_user_messages,
        message_cursors,
        restart_boundary,
        recorder,
        startup_warnings,
        limits,
        file_store,
        registry_store,
        subagent_options,
        runtime_config.timeline.retention_days,
    )
    .with_provider_summaries(runtime_config.provider_summaries())
    .with_profiler(profiler.clone())
    .with_llm_text_preview_enabled(runtime_config.llm_text_preview.enabled);
    service.start_pending_if_needed().await;
    let app = router(service.clone(), service_key);
    let bind = format!(
        "{}:{}",
        runtime_config.service.host, runtime_config.service.port
    );
    let listener = TcpListener::bind((
        runtime_config.service.host.as_str(),
        runtime_config.service.port,
    ))
    .await?;

    eprintln!("botified service listening on http://{bind}");
    let shutdown_token = CancellationToken::new();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_token.clone().cancelled_owned())
        .into_future();
    tokio::pin!(server);

    tokio::select! {
        result = &mut server => {
            result?;
        }
        () = shutdown_signal() => {
            eprintln!("botified service shutting down");
            shutdown_token.cancel();
            let shutdown = service.shutdown();
            let server_shutdown =
                graceful_shutdown_completed_before_timeout(&mut server, HTTP_SHUTDOWN_GRACE);
            let (serve_result, _) = tokio::join!(server_shutdown, shutdown);
            if !serve_result? {
                eprintln!(
                    "botified service forcing shutdown after waiting {}s for HTTP clients",
                    HTTP_SHUTDOWN_GRACE.as_secs()
                );
            }
        }
    }
    Ok(())
}

async fn graceful_shutdown_completed_before_timeout<F, E>(
    server: F,
    grace: Duration,
) -> Result<bool, E>
where
    F: Future<Output = Result<(), E>>,
{
    match tokio::time::timeout(grace, server).await {
        Ok(result) => {
            result?;
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let mut terminate = signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
    tokio::select! {
        result = tokio::signal::ctrl_c() => {
            if let Err(error) = result {
                eprintln!("failed to listen for Ctrl-C: {error}");
            }
        }
        _ = terminate.recv() => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        eprintln!("failed to listen for Ctrl-C: {error}");
    }
}

#[derive(Debug, PartialEq, Eq)]
enum CliAction {
    Help,
    Serve(ServeArgs),
}

impl CliAction {
    fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut args = args.into_iter();
        let Some(command) = args.next() else {
            return Err(usage());
        };
        if is_help_flag(&command) {
            if let Some(extra) = args.next() {
                return Err(format!("unknown argument: {extra}\n{}", usage()));
            }
            return Ok(Self::Help);
        }
        if command != "serve" {
            return Err(usage());
        }

        parse_serve_action(args)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ServeArgs {
    config_path: PathBuf,
    mock_provider: bool,
}

#[cfg(test)]
impl ServeArgs {
    fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
        match CliAction::parse(args)? {
            CliAction::Serve(args) => Ok(args),
            CliAction::Help => Err(usage()),
        }
    }
}

const DEFAULT_CONFIG_PATH: &str = "./botified.yaml";

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .filter(|value| !value.trim().is_empty() && !looks_like_flag(value))
        .ok_or_else(|| format!("missing value for {flag}"))
}

fn parse_serve_action(args: impl Iterator<Item = String>) -> Result<CliAction, String> {
    let mut args = args;
    let mut parsed = ServeArgs {
        config_path: PathBuf::from(DEFAULT_CONFIG_PATH),
        mock_provider: false,
    };
    let mut config_seen = false;
    let mut help_seen = false;

    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--config" => {
                if config_seen {
                    return Err("duplicate argument: --config".to_owned());
                }
                config_seen = true;
                parsed.config_path = PathBuf::from(next_value(&mut args, "--config")?);
            }
            value if value.starts_with("--config=") => {
                if config_seen {
                    return Err("duplicate argument: --config".to_owned());
                }
                config_seen = true;
                let (_, value) = value.split_once('=').expect("--config= prefix matched");
                if value.trim().is_empty() {
                    return Err("missing value for --config".to_owned());
                }
                parsed.config_path = PathBuf::from(value);
            }
            "--mock-provider" => parsed.mock_provider = true,
            value if is_help_flag(value) => help_seen = true,
            other if legacy_serve_flag(other) => return Err(legacy_flag_error(other)),
            other => return Err(format!("unknown argument: {other}\n{}", usage())),
        }
    }

    if help_seen {
        Ok(CliAction::Help)
    } else {
        Ok(CliAction::Serve(parsed))
    }
}

fn is_help_flag(value: &str) -> bool {
    matches!(value, "-h" | "--help")
}

fn looks_like_flag(value: &str) -> bool {
    is_help_flag(value) || value == "-nc" || value.starts_with("--")
}

fn usage() -> String {
    "usage: botified serve [--config PATH] [--mock-provider]".to_owned()
}

fn legacy_serve_flag(flag: &str) -> bool {
    matches!(
        flag,
        "--cwd"
            | "--host"
            | "--port"
            | "--service-key"
            | "--session"
            | "--profile"
            | "--base-url"
            | "--model"
            | "--provider-timeout-secs"
            | "--max-turns"
            | "--max-queue-messages"
            | "--max-queue-bytes"
            | "--skill"
            | "--no-skills"
            | "--no-context-files"
            | "-nc"
            | "--tools"
            | "--no-tools"
    ) || [
        "--cwd=",
        "--host=",
        "--port=",
        "--service-key=",
        "--session=",
        "--profile=",
        "--base-url=",
        "--model=",
        "--provider-timeout-secs=",
        "--max-turns=",
        "--max-queue-messages=",
        "--max-queue-bytes=",
        "--skill=",
        "--tools=",
    ]
    .iter()
    .any(|prefix| flag.starts_with(prefix))
}

fn legacy_flag_error(flag: &str) -> String {
    let flag = flag.split_once('=').map_or(flag, |(flag, _)| flag);
    format!(
        "{flag} is no longer supported; configure runtime settings in botified.yaml and pass --config PATH if needed"
    )
}

fn generated_config_message(path: &Path) -> String {
    format!(
        "generated default Botified runtime config at {}. Edit this file, set the credential environment variables named by api_key_env and service_key_env, then restart with botified serve --config {}. No HTTP service was started.",
        path.display(),
        path.display()
    )
}

fn build_subagent_options(
    runtime_config: &RuntimeConfig,
    endpoints: &[ProviderEndpoint],
) -> Result<ServiceSubagentOptions, Box<dyn Error>> {
    if !runtime_config.subagents.enabled {
        return Ok(ServiceSubagentOptions::disabled());
    }

    let mut options = ServiceSubagentOptions::enabled(SubagentLimits::new(
        runtime_config.subagents.max_parallel,
        runtime_config.subagents.max_branches,
    ));
    for (alias, provider_name) in &runtime_config.subagents.model_aliases {
        let endpoint = endpoints
            .iter()
            .find(|endpoint| endpoint.name() == provider_name)
            .ok_or_else(|| {
                StartupError::new(format!(
                    "subagents model_aliases.{alias} references unknown provider {provider_name}"
                ))
            })?;
        options = options.with_model_alias(alias.clone(), endpoint.as_single_provider());
    }
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
                ProviderEndpoint::new(
                    provider.name.clone(),
                    provider.priority,
                    provider.capabilities.clone(),
                    Arc::new(DevelopmentMockProvider) as Arc<dyn Provider>,
                )
                .with_model(provider.model.clone())
            })
            .collect());
    }

    runtime_config
        .resolved_provider_configs(env)?
        .into_iter()
        .map(|resolved| {
            let model = resolved.config.model.clone();
            let provider =
                Arc::new(OpenAiChatProvider::new(resolved.config)?.with_profiler(profiler.clone()))
                    as Arc<dyn Provider>;
            Ok(ProviderEndpoint::new(
                resolved.name,
                resolved.priority,
                resolved.capabilities,
                provider,
            ))
            .map(|endpoint| endpoint.with_model(model))
        })
        .collect::<Result<Vec<_>, ProviderError>>()
        .map_err(|error| Box::new(error) as Box<dyn Error>)
}

fn build_tools(
    enabled: &[RuntimeTool],
    provider: Arc<dyn Provider>,
) -> Result<Vec<Arc<dyn Tool>>, String> {
    let mut tools: Vec<Arc<dyn Tool>> = Vec::with_capacity(enabled.len());
    for tool in enabled {
        match tool {
            RuntimeTool::Bash => tools.push(Arc::new(BashTool::new())),
            RuntimeTool::ViewImage => tools.push(Arc::new(ViewImageTool::new(provider.clone()))),
        }
    }
    Ok(tools)
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

#[derive(Debug)]
struct StartupError {
    message: String,
}

impl StartupError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for StartupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for StartupError {}

struct DevelopmentMockProvider;

const RELEASE_SMOKE_TRIGGER: &str = "BOTIFIED_RELEASE_SMOKE_BASH";
const RELEASE_SMOKE_TOOL_CALL_ID: &str = "release_smoke_bash";
const RELEASE_SMOKE_OUTPUT_MARKER: &str = "BOTIFIED_RELEASE_SMOKE_OUTPUT";

#[async_trait]
impl Provider for DevelopmentMockProvider {
    async fn complete(
        &self,
        request: ProviderRequest,
        _cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        let messages = request.transcript_messages();
        if pending_release_smoke_tool_result(&messages) {
            return Ok(ProviderResponse::text("release smoke bash complete"));
        }

        let text = latest_user_text(&messages).unwrap_or("message received");
        if text.contains(RELEASE_SMOKE_TRIGGER)
            && request.tools.iter().any(|tool| tool.name == "bash")
        {
            return Ok(ProviderResponse::tool_calls(vec![botified::ToolCall::new(
                RELEASE_SMOKE_TOOL_CALL_ID,
                "bash",
                serde_json::json!({
                    "command": format!("sleep 1; printf '{RELEASE_SMOKE_OUTPUT_MARKER}\\n'"),
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

fn pending_release_smoke_tool_result(messages: &[botified::Message]) -> bool {
    for message in messages.iter().rev() {
        match message {
            botified::Message::ToolResult(result)
                if result.tool_call_id == RELEASE_SMOKE_TOOL_CALL_ID =>
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
mod tests {
    use super::*;

    #[test]
    fn serve_args_default_config_path() {
        let args =
            ServeArgs::parse(["serve"].into_iter().map(str::to_owned)).expect("args should parse");

        assert_eq!(args.config_path, PathBuf::from(DEFAULT_CONFIG_PATH));
        assert!(!args.mock_provider);
    }

    #[test]
    fn serve_args_parse_config_path_and_mock_provider() {
        let args = ServeArgs::parse(
            [
                "serve",
                "--config",
                "/tmp/botified-runtime.yaml",
                "--mock-provider",
            ]
            .into_iter()
            .map(str::to_owned),
        )
        .expect("args should parse");

        assert_eq!(
            args.config_path,
            PathBuf::from("/tmp/botified-runtime.yaml")
        );
        assert!(args.mock_provider);
    }

    #[test]
    fn serve_args_parse_config_equals_form() {
        let args = ServeArgs::parse(
            ["serve", "--config=/tmp/runtime.yaml"]
                .into_iter()
                .map(str::to_owned),
        )
        .expect("args should parse");

        assert_eq!(args.config_path, PathBuf::from("/tmp/runtime.yaml"));
    }

    #[test]
    fn cli_action_parse_help_without_serving() {
        for args in [
            vec!["--help"],
            vec!["-h"],
            vec!["serve", "--help"],
            vec!["serve", "-h"],
            vec!["serve", "--config", "missing.yaml", "--help"],
        ] {
            let action =
                CliAction::parse(args.into_iter().map(str::to_owned)).expect("help should parse");

            assert_eq!(action, CliAction::Help);
        }
    }

    #[test]
    fn serve_args_reject_missing_or_duplicate_config_path() {
        let missing = ServeArgs::parse(["serve", "--config"].into_iter().map(str::to_owned))
            .expect_err("missing config path should fail");
        assert!(missing.contains("missing value for --config"));

        let help_as_value = CliAction::parse(
            ["serve", "--config", "--help"]
                .into_iter()
                .map(str::to_owned),
        )
        .expect_err("help flag should not satisfy config value");
        assert!(help_as_value.contains("missing value for --config"));

        let duplicate = ServeArgs::parse(
            ["serve", "--config", "a.yaml", "--config=b.yaml"]
                .into_iter()
                .map(str::to_owned),
        )
        .expect_err("duplicate config should fail");
        assert!(duplicate.contains("duplicate argument: --config"));
    }

    #[test]
    fn serve_args_reject_legacy_provider_flags() {
        for flag in [
            "--profile",
            "--base-url",
            "--model",
            "--provider-timeout-secs",
        ] {
            let error = ServeArgs::parse(["serve", flag, "value"].into_iter().map(str::to_owned))
                .expect_err("legacy provider flag should fail");
            assert!(error.contains(flag), "{flag}: {error}");
            assert!(error.contains("no longer supported"), "{flag}: {error}");
            assert!(error.contains("botified.yaml"), "{flag}: {error}");
        }
    }

    #[test]
    fn serve_args_reject_legacy_runtime_flags() {
        for flag in [
            "--cwd",
            "--host",
            "--port",
            "--service-key",
            "--session",
            "--max-turns",
            "--max-queue-messages",
            "--max-queue-bytes",
            "--skill",
            "--no-skills",
            "--no-context-files",
            "-nc",
            "--tools",
            "--no-tools",
        ] {
            let error = ServeArgs::parse(["serve", flag, "value"].into_iter().map(str::to_owned))
                .expect_err("legacy runtime flag should fail");
            assert!(error.contains(flag), "{flag}: {error}");
            assert!(error.contains("no longer supported"), "{flag}: {error}");
        }
    }

    #[tokio::test]
    async fn graceful_shutdown_timeout_does_not_wait_forever_for_open_http_clients() {
        let completed = graceful_shutdown_completed_before_timeout(
            std::future::pending::<Result<(), std::io::Error>>(),
            Duration::from_millis(1),
        )
        .await
        .expect("pending server timeout should not be an IO error");

        assert!(!completed);
    }

    #[tokio::test]
    async fn graceful_shutdown_reports_completed_server() {
        let completed = graceful_shutdown_completed_before_timeout(
            async { Ok::<(), std::io::Error>(()) },
            Duration::from_secs(1),
        )
        .await
        .expect("completed server should not be an IO error");

        assert!(completed);
    }

    #[test]
    fn usage_mentions_config_and_mock_provider_only() {
        let usage = usage();

        assert!(usage.contains("--config"));
        assert!(usage.contains("--mock-provider"));
        assert!(!usage.contains("--base-url"));
        assert!(!usage.contains("--session"));
        assert!(!usage.contains("--tools"));
    }

    #[test]
    fn generated_config_message_explains_path_and_credentials() {
        let message = generated_config_message(Path::new("/tmp/botified.yaml"));

        assert!(message.contains("/tmp/botified.yaml"));
        assert!(message.contains("generated"));
        assert!(message.contains("credential environment variables"));
        assert!(message.contains("api_key_env"));
        assert!(message.contains("service_key_env"));
        assert!(message.contains("No HTTP service was started"));
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
        let tools =
            build_tools(&enabled, provider.clone()).expect("default example tools should build");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].spec().name, "bash");
        assert_eq!(tools[1].spec().name, "view_image");

        let tools = build_tools(&[], provider).expect("empty tool config should build");
        assert!(tools.is_empty());
    }

    #[test]
    fn provider_endpoints_follow_runtime_config() {
        let mut config = RuntimeConfig::example();
        config.tools.enabled = vec![RuntimeTool::Bash];

        let endpoints = build_provider_endpoints(
            &config,
            false,
            [
                (
                    "BOTIFIED_TEXT_API_KEY".to_owned(),
                    "text-secret-value".to_owned(),
                ),
                (
                    "BOTIFIED_VISION_API_KEY".to_owned(),
                    "vision-secret-value".to_owned(),
                ),
                (
                    "BOTIFIED_REASONING_API_KEY".to_owned(),
                    "reasoning-secret-value".to_owned(),
                ),
            ],
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
    }

    fn test_temp_dir(name: &str) -> PathBuf {
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
}
