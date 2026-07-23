use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum CliAction {
    Help,
    Serve(ServeArgs),
}

impl CliAction {
    pub(super) fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
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
        if command == "serve" {
            return parse_serve_action(args);
        }
        Err(usage())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ServeArgs {
    pub(super) config_path: PathBuf,
    pub(super) mock_provider: bool,
}

#[cfg(test)]
impl ServeArgs {
    pub(super) fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
        match CliAction::parse(args)? {
            CliAction::Serve(args) => Ok(args),
            CliAction::Help => Err(usage()),
        }
    }
}

pub(super) const DEFAULT_CONFIG_PATH: &str = "./botified.yaml";

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

pub(super) fn usage() -> String {
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
