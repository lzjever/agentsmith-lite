use std::env;
use std::error::Error;
use std::fmt;
use std::io;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::time::Duration;

use botified::http::router_with_terminal;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

mod cli;
mod http_server;
mod runtime_assembly;
mod serve_data_dir_lock;

#[cfg(test)]
use cli::DEFAULT_CONFIG_PATH;
use cli::{usage, CliAction, ServeArgs};

const HTTP_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

fn missing_config_message(path: &Path, mock_provider: bool) -> String {
    let mock_hint = if mock_provider {
        " (mock provider requested)"
    } else {
        ""
    };
    format!(
        "runtime config not found{}: {}; provide the AgentSmith-generated config and restart botified serve",
        mock_hint,
        path.display()
    )
}

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
    let mut assembly =
        runtime_assembly::assemble_runtime(&args.config_path, args.mock_provider, &startup_dir)?;
    assembly.service.start_pending_if_needed().await;
    let service_key = assembly.service_key.take();
    let app = router_with_terminal(
        assembly.service.clone(),
        service_key,
        assembly.terminal.clone(),
    );
    let bind = format!("{}:{}", assembly.host, assembly.port);
    let listener = TcpListener::bind((assembly.host.as_str(), assembly.port)).await?;

    eprintln!("botified service listening on http://{bind}");
    let graceful_shutdown = CancellationToken::new();
    let force_shutdown = CancellationToken::new();
    let mut server = tokio::spawn(http_server::serve(
        listener,
        app,
        graceful_shutdown.clone(),
        force_shutdown.clone(),
    ));
    for result in assembly.service.start_task_presets_on_boot() {
        if !result
            .get("ok")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            eprintln!("warning: failed to start task preset on boot: {result}");
        }
    }

    tokio::select! {
        result = &mut server => {
            flatten_http_server_result(result)?;
        }
        () = shutdown_signal() => {
            eprintln!("botified service shutting down");
            graceful_shutdown.cancel();
            let shutdown = assembly.service.shutdown();
            let server_shutdown = shutdown_http_server_before_timeout(
                &mut server,
                force_shutdown,
                HTTP_SHUTDOWN_GRACE,
            );
            let (serve_result, _) = tokio::join!(server_shutdown, shutdown);
            serve_result?;
        }
    }
    Ok(())
}

async fn shutdown_http_server_before_timeout(
    server: &mut tokio::task::JoinHandle<io::Result<()>>,
    force_shutdown: CancellationToken,
    grace: Duration,
) -> io::Result<()> {
    match tokio::time::timeout(grace, &mut *server).await {
        Ok(result) => flatten_http_server_result(result),
        Err(_) => {
            eprintln!(
                "botified service forcing shutdown after waiting {}s for HTTP clients",
                grace.as_secs()
            );
            force_shutdown.cancel();
            server.abort();
            match server.await {
                Err(error) if error.is_cancelled() => Ok(()),
                result => flatten_http_server_result(result),
            }
        }
    }
}

fn flatten_http_server_result(
    result: Result<io::Result<()>, tokio::task::JoinError>,
) -> io::Result<()> {
    result.map_err(|error| io::Error::other(format!("HTTP server task failed: {error}")))?
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
    fn cli_help_with_extra_argument_is_rejected() {
        assert_eq!(
            CliAction::parse(["--help", "extra"].into_iter().map(str::to_owned)),
            Err(format!("unknown argument: extra\n{}", usage()))
        );
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
    async fn graceful_shutdown_timeout_forces_and_joins_http_server() {
        let force_shutdown = CancellationToken::new();
        let mut server = tokio::spawn(std::future::pending::<io::Result<()>>());

        shutdown_http_server_before_timeout(
            &mut server,
            force_shutdown.clone(),
            Duration::from_millis(1),
        )
        .await
        .expect("pending server timeout should not be an IO error");

        assert!(force_shutdown.is_cancelled());
        assert!(server.is_finished());
    }

    #[tokio::test]
    async fn graceful_shutdown_reports_completed_server() {
        let force_shutdown = CancellationToken::new();
        let mut server = tokio::spawn(async { Ok::<(), io::Error>(()) });

        shutdown_http_server_before_timeout(
            &mut server,
            force_shutdown.clone(),
            Duration::from_secs(1),
        )
        .await
        .expect("completed server should not be an IO error");

        assert!(!force_shutdown.is_cancelled());
        assert!(server.is_finished());
    }

    #[test]
    fn usage_mentions_config_and_mock_provider_only() {
        let usage = usage();

        assert!(usage.contains("botified serve"));
        assert!(usage.contains("--config"));
        assert!(usage.contains("--mock-provider"));
        assert!(!usage.contains("setup"));
        assert!(!usage.contains("--base-url"));
        assert!(!usage.contains("--session"));
        assert!(!usage.contains("--tools"));
    }
}
