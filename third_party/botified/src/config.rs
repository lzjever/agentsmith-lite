use std::fmt;
use std::net::IpAddr;
use std::time::Duration;

use thiserror::Error;

pub use crate::provider::api_compat::ProviderApiCompat;
use crate::provider::thinking::ThinkingConfig;

#[path = "config/runtime.rs"]
mod runtime;

pub use runtime::{
    default_example_yaml, resolve_files_root_dir, resolve_runtime_paths, ResolvedProviderConfig,
    ResolvedRuntimePaths, RuntimeAgentConfig, RuntimeConfig, RuntimeContextFilesConfig,
    RuntimeFilesConfig, RuntimeLlmTextPreviewConfig, RuntimeProfilingConfig, RuntimeProviderConfig,
    RuntimeRegistryConfig, RuntimeServiceConfig, RuntimeSkillsConfig, RuntimeTaskPresetConfig,
    RuntimeTaskPresetsConfig, RuntimeTimelineConfig, RuntimeTool, RuntimeToolExecutionConfig,
    RuntimeToolsConfig, RUNTIME_CONFIG_VERSION,
};

pub const DEFAULT_PROVIDER_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, PartialEq, Eq)]
pub struct OpenAiCompatibleConfig {
    pub profile: String,
    pub base_url: String,
    pub model: String,
    pub api_compat: ProviderApiCompat,
    pub api_key: Option<String>,
    pub request_timeout: Duration,
    pub context_window_tokens: Option<u64>,
    pub max_output_tokens: Option<u64>,
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
            .field("api_compat", &self.api_compat)
            .field("api_key", &self.api_key.as_ref().map(|_| "[redacted]"))
            .field("request_timeout", &self.request_timeout)
            .field("context_window_tokens", &self.context_window_tokens)
            .field("max_output_tokens", &self.max_output_tokens)
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
            api_compat: ProviderApiCompat::Standard,
            api_key: None,
            request_timeout: DEFAULT_PROVIDER_TIMEOUT,
            context_window_tokens: None,
            max_output_tokens: None,
            thinking: ThinkingConfig::default(),
        }
    }

    pub fn with_api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
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

    pub fn with_api_compat(mut self, api_compat: ProviderApiCompat) -> Self {
        self.api_compat = api_compat;
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

    pub fn with_context_window_tokens(mut self, context_window_tokens: u64) -> Self {
        self.context_window_tokens = Some(context_window_tokens);
        self
    }

    pub fn with_optional_context_window_tokens(
        mut self,
        context_window_tokens: Option<u64>,
    ) -> Self {
        self.context_window_tokens = context_window_tokens;
        self
    }

    pub fn with_max_output_tokens(mut self, max_output_tokens: u64) -> Self {
        self.max_output_tokens = Some(max_output_tokens);
        self
    }

    pub fn with_optional_max_output_tokens(mut self, max_output_tokens: Option<u64>) -> Self {
        self.max_output_tokens = max_output_tokens;
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

pub(crate) fn validate_provider_base_url(
    provider_name: &str,
    base_url: &str,
) -> Result<(), ConfigError> {
    let url = reqwest::Url::parse(base_url).map_err(|_| {
        ConfigError::new(format!(
            "provider {provider_name} base_url must use https; http is allowed only for a literal loopback IP or the AgentSmith Lite in-cluster broker"
        ))
    })?;
    let transport_allowed = match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => {
            is_loopback_http_provider_url(&url) || is_agentsmith_lite_internal_broker_url(&url)
        }
        _ => false,
    };
    let components_allowed = url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none();
    if transport_allowed && components_allowed {
        Ok(())
    } else {
        Err(ConfigError::new(format!(
            "provider {provider_name} base_url must use https; http is allowed only for a literal loopback IP or the AgentSmith Lite in-cluster broker"
        )))
    }
}

pub(crate) fn is_loopback_http_provider_base_url(base_url: &str) -> bool {
    reqwest::Url::parse(base_url).is_ok_and(|url| is_loopback_http_provider_url(&url))
}

fn is_loopback_http_provider_url(url: &reqwest::Url) -> bool {
    url.scheme() == "http" && url.host_str().is_some_and(is_provider_url_loopback_host)
}

fn is_agentsmith_lite_internal_broker_url(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let labels = host.split('.').collect::<Vec<_>>();
    labels.len() == 5
        && labels[0] == "agentsmith-lite-api"
        && is_kubernetes_dns_label(labels[1])
        && labels[2..] == ["svc", "cluster", "local"]
}

fn is_kubernetes_dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn is_provider_url_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.parse::<IpAddr>().is_ok_and(|addr| addr.is_loopback())
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
