use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use thiserror::Error;

use crate::provider::thinking::ThinkingConfig;

#[path = "config/runtime.rs"]
mod runtime;

pub use runtime::{
    default_example_yaml, resolve_files_root_dir, resolve_runtime_paths, ResolvedProviderConfig,
    ResolvedRuntimePaths, RuntimeAgentConfig, RuntimeConfig, RuntimeConfigLoad,
    RuntimeContextFilesConfig, RuntimeFilesConfig, RuntimeLlmTextPreviewConfig,
    RuntimeProfilingConfig, RuntimeProviderConfig, RuntimeRegistryConfig, RuntimeServiceConfig,
    RuntimeSkillsConfig, RuntimeTimelineConfig, RuntimeTool, RuntimeToolExecutionConfig,
    RuntimeToolsConfig, RUNTIME_CONFIG_VERSION,
};

pub const DEFAULT_PROVIDER_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, PartialEq, Eq)]
pub struct OpenAiCompatibleConfig {
    pub profile: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub ca_bundle_path: Option<PathBuf>,
    pub request_timeout: Duration,
    pub thinking: ThinkingConfig,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("provider config error: {message}")]
pub struct ConfigError {
    message: String,
}

impl ConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Debug for OpenAiCompatibleConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiCompatibleConfig")
            .field("profile", &self.profile)
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("api_key", &self.api_key.as_ref().map(|_| "[redacted]"))
            .field("ca_bundle_path", &self.ca_bundle_path)
            .field("request_timeout", &self.request_timeout)
            .field("thinking", &self.thinking)
            .finish()
    }
}

impl OpenAiCompatibleConfig {
    pub fn new(
        profile: impl Into<String>,
        base_url: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            profile: profile.into(),
            base_url: base_url.into(),
            model: model.into(),
            api_key: None,
            ca_bundle_path: None,
            request_timeout: DEFAULT_PROVIDER_TIMEOUT,
            thinking: ThinkingConfig::default(),
        }
    }

    pub fn with_api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }

    pub fn with_ca_bundle_path(mut self, ca_bundle_path: impl Into<PathBuf>) -> Self {
        self.ca_bundle_path = Some(ca_bundle_path.into());
        self
    }

    pub fn with_optional_ca_bundle_path(mut self, ca_bundle_path: Option<PathBuf>) -> Self {
        self.ca_bundle_path = ca_bundle_path;
        self
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    pub fn with_profile(mut self, profile: impl Into<String>) -> Self {
        self.profile = profile.into();
        self
    }

    pub fn with_request_timeout(mut self, request_timeout: Duration) -> Self {
        self.request_timeout = request_timeout;
        self
    }

    pub fn with_thinking(mut self, thinking: ThinkingConfig) -> Self {
        self.thinking = thinking;
        self
    }

    pub fn authorization_header(&self) -> Option<(String, String)> {
        self.api_key
            .as_ref()
            .map(|api_key| ("Authorization".to_owned(), format!("Bearer {api_key}")))
    }

    pub fn chat_completions_url(&self) -> String {
        join_url(&self.base_url, "chat/completions")
    }
}

fn join_url(base_url: &str, path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    format!("{base}/{path}")
}

fn non_empty_env(env: &std::collections::HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key).and_then(|value| non_empty_value(value))
}

fn non_empty_value(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}
