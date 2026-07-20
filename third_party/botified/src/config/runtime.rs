use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::{non_empty_env, ConfigError, OpenAiCompatibleConfig};
use crate::compact::CompactConfig;
use crate::files::{
    DEFAULT_FILES_ROOT_DIR, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_MESSAGE_FILES,
    DEFAULT_MAX_MESSAGE_REFERENCED_FILE_BYTES, DEFAULT_MAX_STORE_BYTES, DEFAULT_MAX_UPLOAD_FILES,
    DEFAULT_MAX_UPLOAD_REQUEST_BYTES, DEFAULT_RETENTION_SECS,
};
use crate::path_utils::lexical_absolute;
use crate::provider::router::ProviderCapability;
use crate::provider::thinking::ThinkingConfig;
use crate::provider::ProviderMetadata;
use crate::registry::{RegistryConfig, RegistryStoreOptions};

pub const RUNTIME_CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeConfig {
    pub version: u32,
    pub providers: Vec<RuntimeProviderConfig>,
    pub tools: RuntimeToolsConfig,
    pub service: RuntimeServiceConfig,
    pub runtime: RuntimeAgentConfig,
    #[serde(default)]
    pub timeline: RuntimeTimelineConfig,
    #[serde(default)]
    pub files: RuntimeFilesConfig,
    pub skills: RuntimeSkillsConfig,
    pub context_files: RuntimeContextFilesConfig,
    #[serde(default)]
    pub subagents: RuntimeSubagentsConfig,
    pub compact: CompactConfig,
    #[serde(default)]
    pub profiling: RuntimeProfilingConfig,
    #[serde(default)]
    pub llm_text_preview: RuntimeLlmTextPreviewConfig,
    #[serde(default)]
    pub registry: RuntimeRegistryConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeProviderConfig {
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub api_key_env: String,
    #[serde(default)]
    pub ca_bundle_path: Option<PathBuf>,
    pub request_timeout_secs: u64,
    pub priority: i32,
    pub capabilities: Vec<ProviderCapability>,
    pub thinking: ThinkingConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeToolsConfig {
    pub enabled: Vec<RuntimeTool>,
    #[serde(default)]
    pub execution: RuntimeToolExecutionConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeToolExecutionConfig {
    pub bash_executor_addr: String,
    pub default_detach_after_secs: RuntimeSeconds,
    pub max_detach_after_secs: RuntimeSeconds,
    pub default_timeout_secs: RuntimeSeconds,
    pub max_timeout_secs: RuntimeSeconds,
    pub max_concurrent_tasks: usize,
    pub callback_output_tail_bytes: usize,
    pub max_task_output_bytes: usize,
    #[serde(default = "default_execution_max_task_ask_pending_secs")]
    pub max_task_ask_pending_secs: RuntimeSeconds,
    pub max_retained_tasks: usize,
    pub task_retention_secs: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RuntimeSeconds {
    millis: u64,
}

impl RuntimeSeconds {
    pub const fn from_millis(millis: u64) -> Self {
        Self { millis }
    }

    pub const fn as_millis(self) -> u64 {
        self.millis
    }

    pub fn as_duration(self) -> Duration {
        Duration::from_millis(self.millis)
    }

    pub fn as_secs_f64(self) -> f64 {
        self.millis as f64 / 1000.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeTool {
    Bash,
    ViewImage,
}

impl RuntimeTool {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::ViewImage => "view_image",
        }
    }
}

impl fmt::Display for RuntimeTool {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl Serialize for RuntimeSeconds {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_f64(self.as_secs_f64())
    }
}

impl<'de> Deserialize<'de> for RuntimeSeconds {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(RuntimeSecondsVisitor)
    }
}

struct RuntimeSecondsVisitor;

impl Visitor<'_> for RuntimeSecondsVisitor {
    type Value = RuntimeSeconds;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a finite positive number of seconds")
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        runtime_seconds_from_f64(value).map_err(E::custom)
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        runtime_seconds_from_f64(value as f64).map_err(E::custom)
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        value
            .checked_mul(1000)
            .map(RuntimeSeconds::from_millis)
            .ok_or_else(|| E::custom("seconds value is too large"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeServiceConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub service_key_env: Option<String>,
    pub max_queue_messages: usize,
    pub max_queue_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeAgentConfig {
    pub cwd: PathBuf,
    pub data_dir: PathBuf,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default = "default_resume_unfinished")]
    pub resume_unfinished: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeTimelineConfig {
    #[serde(default = "default_timeline_retention_days")]
    pub retention_days: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeFilesConfig {
    #[serde(default = "default_files_root_dir")]
    pub root_dir: PathBuf,
    #[serde(default = "default_files_max_file_bytes")]
    pub max_file_bytes: u64,
    #[serde(default = "default_files_max_upload_files")]
    pub max_upload_files: usize,
    #[serde(default = "default_files_max_upload_request_bytes")]
    pub max_upload_request_bytes: u64,
    #[serde(default = "default_files_max_message_files")]
    pub max_message_files: usize,
    #[serde(default = "default_files_max_message_referenced_file_bytes")]
    pub max_message_referenced_file_bytes: u64,
    #[serde(default = "default_files_max_store_bytes")]
    pub max_store_bytes: u64,
    #[serde(default = "default_files_retention_secs")]
    pub retention_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSkillsConfig {
    pub default_discovery: bool,
    pub explicit: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeContextFilesConfig {
    pub enabled: bool,
    pub max_total_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSubagentsConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_subagents_max_parallel")]
    pub max_parallel: usize,
    #[serde(default = "default_subagents_max_branches")]
    pub max_branches: usize,
    #[serde(default)]
    pub model_aliases: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeProfilingConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub output_dir: Option<PathBuf>,
    #[serde(default)]
    pub run_label: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeLlmTextPreviewConfig {
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRegistryConfig {
    #[serde(default = "default_registry_enabled")]
    pub enabled: bool,
    #[serde(default = "default_registry_retention_secs")]
    pub retention_secs: RuntimeSeconds,
    #[serde(default = "default_registry_default_ttl_secs")]
    pub default_ttl_secs: RuntimeSeconds,
    #[serde(default = "default_registry_max_topics")]
    pub max_topics: usize,
    #[serde(default = "default_registry_max_topic_len")]
    pub max_topic_len: usize,
    #[serde(default = "default_registry_max_source_len")]
    pub max_source_len: usize,
    #[serde(default = "default_registry_max_value_bytes")]
    pub max_value_bytes: usize,
    #[serde(default = "default_registry_max_history_items")]
    pub max_history_items: usize,
    #[serde(default = "default_registry_max_history_bytes")]
    pub max_history_bytes: usize,
    #[serde(default = "default_registry_default_query_limit")]
    pub default_query_limit: usize,
    #[serde(default = "default_registry_max_query_limit")]
    pub max_query_limit: usize,
    #[serde(default = "default_registry_max_response_bytes")]
    pub max_response_bytes: usize,
    #[serde(default = "default_registry_websocket_max_frame_bytes")]
    pub websocket_max_frame_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProviderConfig {
    pub name: String,
    pub priority: i32,
    pub capabilities: Vec<ProviderCapability>,
    pub config: OpenAiCompatibleConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRuntimePaths {
    pub config_path: PathBuf,
    pub startup_dir: PathBuf,
    pub cwd: PathBuf,
    pub data_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeConfigLoad {
    Loaded(Box<RuntimeConfig>),
    GeneratedExample { path: PathBuf },
}

impl RuntimeConfig {
    pub fn example() -> Self {
        Self::from_yaml_str(default_example_yaml())
            .expect("built-in default runtime config example must parse")
    }

    pub fn from_yaml_str(raw: &str) -> Result<Self, ConfigError> {
        let config: Self = serde_yaml::from_str(raw).map_err(|error| {
            ConfigError::new(format!("failed to parse runtime config: {error}"))
        })?;
        config.validate()?;
        Ok(config)
    }

    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let raw = fs::read_to_string(path).map_err(|error| {
            ConfigError::new(format!(
                "failed to read runtime config {}: {error}",
                path.display()
            ))
        })?;
        let config: Self = serde_yaml::from_str(&raw).map_err(|error| {
            ConfigError::new(format!(
                "failed to parse runtime config {}: {error}",
                path.display()
            ))
        })?;
        config.validate()?;
        Ok(config)
    }

    pub fn write_default_example(path: &Path) -> Result<(), ConfigError> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).map_err(|error| {
                ConfigError::new(format!(
                    "failed to create runtime config directory {}: {error}",
                    parent.display()
                ))
            })?;
        }
        fs::write(path, default_example_yaml()).map_err(|error| {
            ConfigError::new(format!(
                "failed to write default runtime config example {}: {error}",
                path.display()
            ))
        })
    }

    pub fn load_or_write_example(path: &Path) -> Result<RuntimeConfigLoad, ConfigError> {
        match fs::read_to_string(path) {
            Ok(raw) => {
                let config: Self = serde_yaml::from_str(&raw).map_err(|error| {
                    ConfigError::new(format!(
                        "failed to parse runtime config {}: {error}",
                        path.display()
                    ))
                })?;
                config.validate()?;
                Ok(RuntimeConfigLoad::Loaded(Box::new(config)))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Self::write_default_example(path)?;
                Ok(RuntimeConfigLoad::GeneratedExample {
                    path: path.to_path_buf(),
                })
            }
            Err(error) => Err(ConfigError::new(format!(
                "failed to read runtime config {}: {error}",
                path.display()
            ))),
        }
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.version != RUNTIME_CONFIG_VERSION {
            return Err(ConfigError::new(format!(
                "unsupported runtime config version {}; expected {RUNTIME_CONFIG_VERSION}",
                self.version
            )));
        }
        if self.providers.is_empty() {
            return Err(ConfigError::new(
                "runtime config requires at least one provider",
            ));
        }

        let mut provider_names = HashSet::new();
        for provider in &self.providers {
            provider.validate()?;
            if !provider_names.insert(provider.name.clone()) {
                return Err(ConfigError::new(format!(
                    "duplicate provider name {}",
                    provider.name
                )));
            }
        }

        self.tools.validate()?;
        self.service.validate()?;
        self.registry.validate()?;
        self.validate_service_tool_auth()?;
        self.validate_tool_provider_capabilities()?;
        self.runtime.validate()?;
        self.timeline.validate()?;
        self.files.validate()?;
        self.skills.validate()?;
        self.context_files.validate()?;
        self.subagents.validate(&provider_names)?;
        validate_compact_config(&self.compact)?;
        self.profiling.validate()?;
        Ok(())
    }

    pub fn provider_configs(
        &self,
        env: impl IntoIterator<Item = (String, String)>,
    ) -> Result<Vec<OpenAiCompatibleConfig>, ConfigError> {
        Ok(self
            .resolved_provider_configs(env)?
            .into_iter()
            .map(|resolved| resolved.config)
            .collect())
    }

    pub fn provider_summaries(&self) -> Vec<ProviderMetadata> {
        self.providers
            .iter()
            .map(|provider| {
                ProviderMetadata::new(provider.name.clone())
                    .with_name(provider.name.clone())
                    .with_model(provider.model.clone())
                    .with_capabilities(provider.capabilities.clone())
            })
            .collect()
    }

    pub fn resolved_provider_configs(
        &self,
        env: impl IntoIterator<Item = (String, String)>,
    ) -> Result<Vec<ResolvedProviderConfig>, ConfigError> {
        self.validate()?;
        let env = env.into_iter().collect::<HashMap<_, _>>();
        self.providers
            .iter()
            .map(|provider| provider.resolve(&env))
            .collect()
    }

    pub fn service_key(&self, env: impl IntoIterator<Item = (String, String)>) -> Option<String> {
        let service_key_env = self.service.service_key_env.as_deref()?.trim();
        if service_key_env.is_empty() {
            return None;
        }
        let env = env.into_iter().collect::<HashMap<_, _>>();
        non_empty_env(&env, service_key_env)
    }

    pub fn resolve_service_key(
        &self,
        env: impl IntoIterator<Item = (String, String)>,
    ) -> Result<Option<String>, ConfigError> {
        self.service.validate()?;
        let Some(service_key_env) = self.service.service_key_env.as_deref() else {
            return Ok(None);
        };
        let service_key_env = service_key_env.trim();
        let env = env.into_iter().collect::<HashMap<_, _>>();
        non_empty_env(&env, service_key_env)
            .map(Some)
            .ok_or_else(|| {
                ConfigError::new(format!(
                    "missing service key; set environment variable {service_key_env}"
                ))
            })
    }

    fn validate_service_tool_auth(&self) -> Result<(), ConfigError> {
        if is_loopback_host(&self.service.host) {
            return Ok(());
        }
        if self.service.service_key_env.is_some() {
            return Ok(());
        }
        if self.tools.enabled.is_empty() && !self.registry.enabled {
            return Ok(());
        }

        Err(ConfigError::new(
            "tools.enabled or registry.enabled requires service.service_key_env when service.host is not loopback/localhost",
        ))
    }

    fn validate_tool_provider_capabilities(&self) -> Result<(), ConfigError> {
        if !self.tools.enabled.contains(&RuntimeTool::ViewImage) {
            return Ok(());
        }
        let has_vision_endpoint = self.providers.iter().any(|provider| {
            provider.capabilities.contains(&ProviderCapability::Text)
                && provider.capabilities.contains(&ProviderCapability::Image)
        });
        if has_vision_endpoint {
            return Ok(());
        }

        Err(ConfigError::new(
            "view_image tool requires a provider endpoint with capabilities [text, image]",
        ))
    }
}

impl RuntimeProviderConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        validate_non_empty_string("provider name", &self.name)?;
        validate_non_empty_string(&format!("provider {} base_url", self.name), &self.base_url)?;
        validate_non_empty_string(&format!("provider {} model", self.name), &self.model)?;
        validate_non_empty_string(
            &format!("provider {} api_key_env", self.name),
            &self.api_key_env,
        )?;
        if let Some(ca_bundle_path) = &self.ca_bundle_path {
            validate_non_empty_path(
                &format!("provider {} ca_bundle_path", self.name),
                ca_bundle_path,
            )?;
        }
        if self.request_timeout_secs == 0 {
            return Err(ConfigError::new(format!(
                "provider {} request_timeout_secs must be greater than 0",
                self.name
            )));
        }
        if self.capabilities.is_empty() {
            return Err(ConfigError::new(format!(
                "provider {} capabilities must not be empty",
                self.name
            )));
        }

        let mut capabilities = HashSet::new();
        for capability in &self.capabilities {
            if !capabilities.insert(*capability) {
                return Err(ConfigError::new(format!(
                    "provider {} duplicate capability {}",
                    self.name, capability
                )));
            }
        }

        self.thinking
            .validate()
            .map_err(|error| ConfigError::new(format!("provider {} {error}", self.name)))?;
        Ok(())
    }

    fn resolve(
        &self,
        env: &HashMap<String, String>,
    ) -> Result<ResolvedProviderConfig, ConfigError> {
        let api_key = non_empty_env(env, &self.api_key_env).ok_or_else(|| {
            ConfigError::new(format!(
                "missing API key for provider {}; set environment variable {}",
                self.name, self.api_key_env
            ))
        })?;

        Ok(ResolvedProviderConfig {
            name: self.name.clone(),
            priority: self.priority,
            capabilities: self.capabilities.clone(),
            config: OpenAiCompatibleConfig::new(&self.name, &self.base_url, &self.model)
                .with_api_key(api_key)
                .with_optional_ca_bundle_path(self.ca_bundle_path.clone())
                .with_request_timeout(Duration::from_secs(self.request_timeout_secs))
                .with_thinking(self.thinking.clone()),
        })
    }
}

impl RuntimeToolsConfig {
    pub const DEFAULT_EXECUTION_DEFAULT_DETACH_AFTER_SECS: RuntimeSeconds =
        RuntimeSeconds::from_millis(1_000);
    pub const DEFAULT_EXECUTION_MAX_DETACH_AFTER_SECS: RuntimeSeconds =
        RuntimeSeconds::from_millis(10_000);
    pub const DEFAULT_EXECUTION_DEFAULT_TIMEOUT_SECS: RuntimeSeconds =
        RuntimeSeconds::from_millis(120_000);
    pub const DEFAULT_EXECUTION_MAX_TIMEOUT_SECS: RuntimeSeconds =
        RuntimeSeconds::from_millis(1_800_000);
    pub const DEFAULT_EXECUTION_MAX_CONCURRENT_TASKS: usize = 4;
    pub const DEFAULT_EXECUTION_CALLBACK_OUTPUT_TAIL_BYTES: usize = 8_192;
    pub const DEFAULT_EXECUTION_MAX_TASK_OUTPUT_BYTES: usize = 16_777_216;
    pub const DEFAULT_EXECUTION_MAX_TASK_ASK_PENDING_SECS: RuntimeSeconds =
        RuntimeSeconds::from_millis(300_000);
    pub const DEFAULT_EXECUTION_MAX_RETAINED_TASKS: usize = 128;
    pub const DEFAULT_EXECUTION_TASK_RETENTION_SECS: u64 = 86_400;

    fn validate(&self) -> Result<(), ConfigError> {
        let mut tools = HashSet::new();
        for tool in &self.enabled {
            if !tools.insert(*tool) {
                return Err(ConfigError::new(format!("duplicate enabled tool {tool}")));
            }
        }
        self.execution.validate()?;
        Ok(())
    }
}

impl Default for RuntimeToolExecutionConfig {
    fn default() -> Self {
        Self {
            bash_executor_addr: "127.0.0.1:3110".to_owned(),
            default_detach_after_secs:
                RuntimeToolsConfig::DEFAULT_EXECUTION_DEFAULT_DETACH_AFTER_SECS,
            max_detach_after_secs: RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_DETACH_AFTER_SECS,
            default_timeout_secs: RuntimeToolsConfig::DEFAULT_EXECUTION_DEFAULT_TIMEOUT_SECS,
            max_timeout_secs: RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_TIMEOUT_SECS,
            max_concurrent_tasks: RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_CONCURRENT_TASKS,
            callback_output_tail_bytes:
                RuntimeToolsConfig::DEFAULT_EXECUTION_CALLBACK_OUTPUT_TAIL_BYTES,
            max_task_output_bytes: RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_TASK_OUTPUT_BYTES,
            max_task_ask_pending_secs:
                RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_TASK_ASK_PENDING_SECS,
            max_retained_tasks: RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_RETAINED_TASKS,
            task_retention_secs: RuntimeToolsConfig::DEFAULT_EXECUTION_TASK_RETENTION_SECS,
        }
    }
}

impl RuntimeToolExecutionConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        let executor_addr = self.bash_executor_addr.parse::<std::net::SocketAddr>().map_err(|error| {
            ConfigError::new(format!("tools.execution.bash_executor_addr must be a socket address: {error}"))
        })?;
        if !executor_addr.ip().is_loopback() {
            return Err(ConfigError::new("tools.execution.bash_executor_addr must use a loopback address"));
        }
        validate_positive_seconds(
            "tools.execution.default_detach_after_secs",
            self.default_detach_after_secs,
        )?;
        validate_positive_seconds(
            "tools.execution.max_detach_after_secs",
            self.max_detach_after_secs,
        )?;
        validate_positive_seconds(
            "tools.execution.default_timeout_secs",
            self.default_timeout_secs,
        )?;
        validate_positive_seconds("tools.execution.max_timeout_secs", self.max_timeout_secs)?;

        if self.default_detach_after_secs > self.max_detach_after_secs {
            return Err(ConfigError::new(
                "tools.execution.default_detach_after_secs must be less than or equal to max_detach_after_secs",
            ));
        }
        if self.default_timeout_secs > self.max_timeout_secs {
            return Err(ConfigError::new(
                "tools.execution.default_timeout_secs must be less than or equal to max_timeout_secs",
            ));
        }

        validate_positive_usize(
            "tools.execution.max_concurrent_tasks",
            self.max_concurrent_tasks,
        )?;
        validate_positive_usize(
            "tools.execution.callback_output_tail_bytes",
            self.callback_output_tail_bytes,
        )?;
        validate_positive_usize(
            "tools.execution.max_task_output_bytes",
            self.max_task_output_bytes,
        )?;
        validate_positive_seconds(
            "tools.execution.max_task_ask_pending_secs",
            self.max_task_ask_pending_secs,
        )?;
        validate_positive_usize(
            "tools.execution.max_retained_tasks",
            self.max_retained_tasks,
        )?;
        if self.task_retention_secs == 0 {
            return Err(ConfigError::new(
                "tools.execution.task_retention_secs must be greater than 0",
            ));
        }
        Ok(())
    }
}

fn default_execution_max_task_ask_pending_secs() -> RuntimeSeconds {
    RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_TASK_ASK_PENDING_SECS
}

impl RuntimeServiceConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        validate_non_empty_string("service host", &self.host)?;
        if self.port == 0 {
            return Err(ConfigError::new("service port must be greater than 0"));
        }
        if let Some(service_key_env) = &self.service_key_env {
            validate_non_empty_string("service service_key_env", service_key_env)?;
        }
        if self.max_queue_messages == 0 {
            return Err(ConfigError::new(
                "service max_queue_messages must be greater than 0",
            ));
        }
        if self.max_queue_bytes == 0 {
            return Err(ConfigError::new(
                "service max_queue_bytes must be greater than 0",
            ));
        }
        Ok(())
    }
}

impl RuntimeAgentConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        validate_non_empty_path("runtime cwd", &self.cwd)?;
        validate_non_empty_path("runtime data_dir", &self.data_dir)?;
        if let Some(session) = &self.session {
            validate_non_empty_string("runtime session", session)?;
        }
        Ok(())
    }
}

impl RuntimeTimelineConfig {
    pub const DEFAULT_RETENTION_DAYS: u64 = 14;

    fn validate(&self) -> Result<(), ConfigError> {
        validate_positive_u64("timeline retention_days", self.retention_days)
    }
}

impl Default for RuntimeTimelineConfig {
    fn default() -> Self {
        Self {
            retention_days: Self::DEFAULT_RETENTION_DAYS,
        }
    }
}

impl Default for RuntimeFilesConfig {
    fn default() -> Self {
        Self {
            root_dir: default_files_root_dir(),
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            max_upload_files: DEFAULT_MAX_UPLOAD_FILES,
            max_upload_request_bytes: DEFAULT_MAX_UPLOAD_REQUEST_BYTES,
            max_message_files: DEFAULT_MAX_MESSAGE_FILES,
            max_message_referenced_file_bytes: DEFAULT_MAX_MESSAGE_REFERENCED_FILE_BYTES,
            max_store_bytes: DEFAULT_MAX_STORE_BYTES,
            retention_secs: DEFAULT_RETENTION_SECS,
        }
    }
}

impl RuntimeFilesConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        validate_non_empty_path("files root_dir", &self.root_dir)?;
        validate_positive_u64("files max_file_bytes", self.max_file_bytes)?;
        validate_positive_usize("files max_upload_files", self.max_upload_files)?;
        validate_positive_u64(
            "files max_upload_request_bytes",
            self.max_upload_request_bytes,
        )?;
        validate_positive_usize("files max_message_files", self.max_message_files)?;
        validate_positive_u64(
            "files max_message_referenced_file_bytes",
            self.max_message_referenced_file_bytes,
        )?;
        validate_positive_u64("files max_store_bytes", self.max_store_bytes)?;
        validate_positive_u64("files retention_secs", self.retention_secs)?;
        Ok(())
    }
}

impl RuntimeSkillsConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        for skill in &self.explicit {
            validate_non_empty_string("skills explicit entry", skill)?;
        }
        Ok(())
    }
}

impl RuntimeContextFilesConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        if self.max_total_bytes == 0 {
            return Err(ConfigError::new(
                "context_files max_total_bytes must be greater than 0",
            ));
        }
        Ok(())
    }
}

impl Default for RuntimeSubagentsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_parallel: default_subagents_max_parallel(),
            max_branches: default_subagents_max_branches(),
            model_aliases: HashMap::new(),
        }
    }
}

impl RuntimeSubagentsConfig {
    fn validate(&self, provider_names: &HashSet<String>) -> Result<(), ConfigError> {
        validate_positive_usize("subagents max_parallel", self.max_parallel)?;
        validate_positive_usize("subagents max_branches", self.max_branches)?;

        for (alias, provider_name) in &self.model_aliases {
            validate_non_empty_string("subagents model_aliases alias", alias)?;
            validate_non_empty_string(
                &format!("subagents model_aliases.{alias} provider"),
                provider_name,
            )?;
            if !provider_names.contains(provider_name) {
                return Err(ConfigError::new(format!(
                    "subagents model_aliases.{alias} references unknown provider {provider_name}"
                )));
            }
        }

        Ok(())
    }
}

impl RuntimeProfilingConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        if let Some(output_dir) = &self.output_dir {
            validate_non_empty_path("profiling output_dir", output_dir)?;
        }
        if let Some(run_label) = &self.run_label {
            validate_non_empty_string("profiling run_label", run_label)?;
        }
        Ok(())
    }
}

impl Default for RuntimeRegistryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            retention_secs: RuntimeSeconds::from_millis(
                RegistryConfig::DEFAULT_RETENTION.as_millis() as u64,
            ),
            default_ttl_secs: RuntimeSeconds::from_millis(
                RegistryConfig::DEFAULT_TTL.as_millis() as u64
            ),
            max_topics: RegistryConfig::DEFAULT_MAX_TOPICS,
            max_topic_len: RegistryConfig::DEFAULT_MAX_TOPIC_LEN,
            max_source_len: RegistryConfig::DEFAULT_MAX_SOURCE_LEN,
            max_value_bytes: RegistryConfig::DEFAULT_MAX_VALUE_BYTES,
            max_history_items: RegistryConfig::DEFAULT_MAX_HISTORY_ITEMS,
            max_history_bytes: RegistryConfig::DEFAULT_MAX_HISTORY_BYTES,
            default_query_limit: RegistryConfig::DEFAULT_QUERY_LIMIT,
            max_query_limit: RegistryConfig::DEFAULT_MAX_QUERY_LIMIT,
            max_response_bytes: RegistryConfig::DEFAULT_MAX_RESPONSE_BYTES,
            websocket_max_frame_bytes: RegistryStoreOptions::DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
        }
    }
}

impl RuntimeRegistryConfig {
    fn validate(&self) -> Result<(), ConfigError> {
        validate_positive_seconds("registry retention_secs", self.retention_secs)?;
        validate_positive_seconds("registry default_ttl_secs", self.default_ttl_secs)?;
        if self.default_ttl_secs > self.retention_secs {
            return Err(ConfigError::new(
                "registry default_ttl_secs must be less than or equal to retention_secs",
            ));
        }
        validate_positive_usize("registry max_topics", self.max_topics)?;
        validate_positive_usize("registry max_topic_len", self.max_topic_len)?;
        validate_positive_usize("registry max_source_len", self.max_source_len)?;
        validate_positive_usize("registry max_value_bytes", self.max_value_bytes)?;
        validate_positive_usize("registry max_history_items", self.max_history_items)?;
        validate_positive_usize("registry max_history_bytes", self.max_history_bytes)?;
        validate_positive_usize("registry default_query_limit", self.default_query_limit)?;
        validate_positive_usize("registry max_query_limit", self.max_query_limit)?;
        validate_positive_usize("registry max_response_bytes", self.max_response_bytes)?;
        validate_positive_usize(
            "registry websocket_max_frame_bytes",
            self.websocket_max_frame_bytes,
        )?;
        if self.default_query_limit > self.max_query_limit {
            return Err(ConfigError::new(
                "registry default_query_limit must be less than or equal to max_query_limit",
            ));
        }
        Ok(())
    }

    pub fn store_config(&self) -> RegistryConfig {
        RegistryConfig {
            retention: self.retention_secs.as_duration(),
            default_ttl: self.default_ttl_secs.as_duration(),
            max_topics: self.max_topics,
            max_topic_len: self.max_topic_len,
            max_source_len: self.max_source_len,
            max_value_bytes: self.max_value_bytes,
            max_history_items: self.max_history_items,
            max_history_bytes: self.max_history_bytes,
            default_query_limit: self.default_query_limit,
            max_query_limit: self.max_query_limit,
            max_response_bytes: self.max_response_bytes,
        }
    }

    pub fn store_options(&self) -> RegistryStoreOptions {
        RegistryStoreOptions::default()
            .with_websocket_max_frame_bytes(self.websocket_max_frame_bytes)
    }
}

impl From<&RuntimeRegistryConfig> for RegistryConfig {
    fn from(config: &RuntimeRegistryConfig) -> Self {
        config.store_config()
    }
}

pub fn default_example_yaml() -> &'static str {
    r#"version: 1

providers:
  - name: text-main
    base_url: https://text-provider.example/v1
    model: text-tool-model
    api_key_env: BOTIFIED_TEXT_API_KEY
    request_timeout_secs: 60
    priority: 10
    capabilities: [text, tool_calls]
    thinking:
      format: none
      level: off
      level_map: {}
      budget_tokens: null

  - name: vision-main
    base_url: https://vision-provider.example/v1
    model: vision-model
    api_key_env: BOTIFIED_VISION_API_KEY
    request_timeout_secs: 60
    priority: 20
    capabilities: [text, image]
    thinking:
      format: qwen
      level: off
      level_map: {}
      budget_tokens: null

  - name: reasoning-main
    base_url: https://reasoning-provider.example/v1
    model: reasoning-model
    api_key_env: BOTIFIED_REASONING_API_KEY
    request_timeout_secs: 120
    priority: 30
    capabilities: [text, tool_calls]
    thinking:
      format: deepseek
      level: high
      level_map:
        minimal: null
        low: null
        medium: high
        high: high
        xhigh: max
      budget_tokens: null

tools:
  enabled: [bash, view_image]
  execution:
    bash_executor_addr: 127.0.0.1:3110
    default_detach_after_secs: 1.0
    max_detach_after_secs: 10.0
    default_timeout_secs: 120.0
    max_timeout_secs: 1800.0
    max_concurrent_tasks: 4
    callback_output_tail_bytes: 8192
    max_task_output_bytes: 16777216
    max_task_ask_pending_secs: 300.0
    max_retained_tasks: 128
    task_retention_secs: 86400

service:
  host: 127.0.0.1
  port: 17777
  service_key_env: BOTIFIED_SERVICE_KEY
  max_queue_messages: 32
  max_queue_bytes: 33554432

registry:
  enabled: true
  retention_secs: 300
  default_ttl_secs: 5
  max_topics: 4096
  max_topic_len: 256
  max_source_len: 128
  max_value_bytes: 8192
  max_history_items: 20000
  max_history_bytes: 67108864
  default_query_limit: 100
  max_query_limit: 1000
  max_response_bytes: 262144
  websocket_max_frame_bytes: 65536

runtime:
  cwd: .
  data_dir: .botified/state
  session: null
  resume_unfinished: true

timeline:
  retention_days: 14

files:
  root_dir: files
  max_file_bytes: 52428800
  max_upload_files: 16
  max_upload_request_bytes: 104857600
  max_message_files: 16
  max_message_referenced_file_bytes: 104857600
  max_store_bytes: 1073741824
  retention_secs: 604800

skills:
  default_discovery: true
  explicit: []

context_files:
  enabled: true
  max_total_bytes: 32768

subagents:
  enabled: true
  max_parallel: 3
  max_branches: 32
  model_aliases: {}

compact:
  enabled: true
  threshold_tokens: 1000000
  keep_recent_tokens: 32000

profiling:
  enabled: false
  output_dir: null
  run_label: null

llm_text_preview:
  enabled: false
"#
}

pub fn resolve_runtime_paths(
    config_path: &Path,
    startup_dir: &Path,
    runtime: &RuntimeAgentConfig,
) -> Result<ResolvedRuntimePaths, ConfigError> {
    runtime.validate()?;
    let startup_dir = lexical_absolute(startup_dir, Path::new("."));
    let config_path = lexical_absolute(config_path, &startup_dir);
    let config_dir = config_path.parent().unwrap_or(&startup_dir);
    let cwd = lexical_absolute(&runtime.cwd, config_dir);
    validate_resolved_cwd(&cwd)?;
    let data_dir = lexical_absolute(&runtime.data_dir, &cwd);

    Ok(ResolvedRuntimePaths {
        config_path,
        startup_dir,
        cwd,
        data_dir,
    })
}

pub fn resolve_files_root_dir(files: &RuntimeFilesConfig, data_dir: &Path) -> PathBuf {
    lexical_absolute(&files.root_dir, data_dir)
}

fn validate_resolved_cwd(cwd: &Path) -> Result<(), ConfigError> {
    let metadata = fs::metadata(cwd).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            ConfigError::new(format!("runtime.cwd {} does not exist", cwd.display()))
        } else {
            ConfigError::new(format!(
                "failed to inspect runtime.cwd {}: {error}",
                cwd.display()
            ))
        }
    })?;
    if metadata.is_dir() {
        Ok(())
    } else {
        Err(ConfigError::new(format!(
            "runtime.cwd {} is not a directory",
            cwd.display()
        )))
    }
}

fn validate_compact_config(compact: &CompactConfig) -> Result<(), ConfigError> {
    if compact.threshold_tokens == 0 {
        return Err(ConfigError::new(
            "compact threshold_tokens must be greater than 0",
        ));
    }
    if compact.keep_recent_tokens == 0 {
        return Err(ConfigError::new(
            "compact keep_recent_tokens must be greater than 0",
        ));
    }
    Ok(())
}

fn runtime_seconds_from_f64(seconds: f64) -> Result<RuntimeSeconds, String> {
    if !seconds.is_finite() {
        return Err("seconds value must be finite".to_owned());
    }
    if seconds <= 0.0 {
        return Err("seconds value must be greater than 0".to_owned());
    }

    let millis = seconds * 1000.0;
    if !millis.is_finite() || millis > u64::MAX as f64 {
        return Err("seconds value is too large".to_owned());
    }

    let rounded = millis.round();
    if (millis - rounded).abs() > 0.000_001 {
        return Err("seconds value must not be more precise than milliseconds".to_owned());
    }
    if rounded == 0.0 {
        return Err("seconds value must be at least 0.001".to_owned());
    }

    Ok(RuntimeSeconds::from_millis(rounded as u64))
}

fn validate_positive_seconds(field: &str, value: RuntimeSeconds) -> Result<(), ConfigError> {
    if value.as_millis() == 0 {
        Err(ConfigError::new(format!("{field} must be greater than 0")))
    } else {
        Ok(())
    }
}

fn validate_positive_usize(field: &str, value: usize) -> Result<(), ConfigError> {
    if value == 0 {
        Err(ConfigError::new(format!("{field} must be greater than 0")))
    } else {
        Ok(())
    }
}

fn validate_positive_u64(field: &str, value: u64) -> Result<(), ConfigError> {
    if value == 0 {
        Err(ConfigError::new(format!("{field} must be greater than 0")))
    } else {
        Ok(())
    }
}

fn validate_non_empty_string(field: &str, value: &str) -> Result<(), ConfigError> {
    if value.trim().is_empty() {
        Err(ConfigError::new(format!("{field} must not be empty")))
    } else {
        Ok(())
    }
}

fn default_timeline_retention_days() -> u64 {
    RuntimeTimelineConfig::DEFAULT_RETENTION_DAYS
}

fn default_resume_unfinished() -> bool {
    true
}

fn default_files_root_dir() -> PathBuf {
    PathBuf::from(DEFAULT_FILES_ROOT_DIR)
}

fn default_files_max_file_bytes() -> u64 {
    DEFAULT_MAX_FILE_BYTES
}

fn default_files_max_upload_files() -> usize {
    DEFAULT_MAX_UPLOAD_FILES
}

fn default_files_max_upload_request_bytes() -> u64 {
    DEFAULT_MAX_UPLOAD_REQUEST_BYTES
}

fn default_files_max_message_files() -> usize {
    DEFAULT_MAX_MESSAGE_FILES
}

fn default_files_max_message_referenced_file_bytes() -> u64 {
    DEFAULT_MAX_MESSAGE_REFERENCED_FILE_BYTES
}

fn default_files_max_store_bytes() -> u64 {
    DEFAULT_MAX_STORE_BYTES
}

fn default_files_retention_secs() -> u64 {
    DEFAULT_RETENTION_SECS
}

fn default_subagents_max_parallel() -> usize {
    3
}

fn default_subagents_max_branches() -> usize {
    32
}

fn default_registry_enabled() -> bool {
    true
}

fn default_registry_retention_secs() -> RuntimeSeconds {
    RuntimeRegistryConfig::default().retention_secs
}

fn default_registry_default_ttl_secs() -> RuntimeSeconds {
    RuntimeRegistryConfig::default().default_ttl_secs
}

fn default_registry_max_topics() -> usize {
    RuntimeRegistryConfig::default().max_topics
}

fn default_registry_max_topic_len() -> usize {
    RuntimeRegistryConfig::default().max_topic_len
}

fn default_registry_max_source_len() -> usize {
    RuntimeRegistryConfig::default().max_source_len
}

fn default_registry_max_value_bytes() -> usize {
    RuntimeRegistryConfig::default().max_value_bytes
}

fn default_registry_max_history_items() -> usize {
    RuntimeRegistryConfig::default().max_history_items
}

fn default_registry_max_history_bytes() -> usize {
    RuntimeRegistryConfig::default().max_history_bytes
}

fn default_registry_default_query_limit() -> usize {
    RuntimeRegistryConfig::default().default_query_limit
}

fn default_registry_max_query_limit() -> usize {
    RuntimeRegistryConfig::default().max_query_limit
}

fn default_registry_max_response_bytes() -> usize {
    RuntimeRegistryConfig::default().max_response_bytes
}

fn default_registry_websocket_max_frame_bytes() -> usize {
    RuntimeRegistryConfig::default().websocket_max_frame_bytes
}

fn validate_non_empty_path(field: &str, value: &Path) -> Result<(), ConfigError> {
    if value.as_os_str().is_empty() {
        Err(ConfigError::new(format!("{field} must not be empty")))
    } else {
        Ok(())
    }
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|addr| addr.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_unfinished_defaults_true_and_accepts_false() {
        let without_field = default_example_yaml().replace("  resume_unfinished: true\n", "");
        let defaulted = RuntimeConfig::from_yaml_str(&without_field)
            .expect("older runtime config should keep crash recovery enabled");
        assert!(defaulted.runtime.resume_unfinished);

        let explicit_false = default_example_yaml().replace(
            "  resume_unfinished: true\n",
            "  resume_unfinished: false\n",
        );
        let disabled = RuntimeConfig::from_yaml_str(&explicit_false)
            .expect("runtime config should allow an explicit discard boundary");
        assert!(!disabled.runtime.resume_unfinished);
    }

    #[test]
    fn ca_bundle_path_resolves_into_openai_compatible_provider_config() {
        let provider = RuntimeProviderConfig {
            name: "local-openai".to_owned(),
            base_url: "https://models.local.test/v1".to_owned(),
            model: "gpt-compatible".to_owned(),
            api_key_env: "MODEL_API_KEY".to_owned(),
            ca_bundle_path: Some(PathBuf::from("/etc/agentsmith-lite/model-ca/ca.crt")),
            request_timeout_secs: 30,
            priority: 10,
            capabilities: vec![ProviderCapability::Text, ProviderCapability::ToolCalls],
            thinking: ThinkingConfig::default(),
        };
        provider.validate().expect("CA bundle path should validate");

        let resolved = provider
            .resolve(&HashMap::from([(
                "MODEL_API_KEY".to_owned(),
                "sk-test-value".to_owned(),
            )]))
            .expect("provider should resolve");

        assert_eq!(
            resolved.config.ca_bundle_path,
            Some(PathBuf::from("/etc/agentsmith-lite/model-ca/ca.crt"))
        );
        assert_eq!(resolved.config.api_key.as_deref(), Some("sk-test-value"));
    }

    #[test]
    fn ca_bundle_path_must_not_be_empty() {
        let provider = RuntimeProviderConfig {
            name: "local-openai".to_owned(),
            base_url: "https://models.local.test/v1".to_owned(),
            model: "gpt-compatible".to_owned(),
            api_key_env: "MODEL_API_KEY".to_owned(),
            ca_bundle_path: Some(PathBuf::new()),
            request_timeout_secs: 30,
            priority: 10,
            capabilities: vec![ProviderCapability::Text],
            thinking: ThinkingConfig::default(),
        };

        let error = provider
            .validate()
            .expect_err("empty CA bundle path should fail validation");

        assert!(error.message().contains("ca_bundle_path"));
    }
}
