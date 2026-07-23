use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::provider::api_compat::ProviderApiCompat;
use crate::provider::thinking::ThinkingLevel;
use crate::provider::{
    Provider, ProviderError, ProviderMetadata, ProviderRequest, ProviderResponse,
};
use crate::types::{ContentPart, Message, ModelInput};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCapability {
    Text,
    Image,
    ToolCalls,
}

impl ProviderCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
            Self::ToolCalls => "tool_calls",
        }
    }
}

impl fmt::Display for ProviderCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone)]
pub struct ProviderEndpoint {
    name: String,
    model: Option<String>,
    priority: i32,
    capabilities: Vec<ProviderCapability>,
    context_window_tokens: Option<u64>,
    max_output_tokens: Option<u64>,
    api_compat: Option<ProviderApiCompat>,
    default_thinking_level: ThinkingLevel,
    provider: Arc<dyn Provider>,
    thinking_variant_factory: Option<Arc<ThinkingVariantFactory>>,
    thinking_variant_cache: Arc<Mutex<std::collections::HashMap<ThinkingLevel, Arc<dyn Provider>>>>,
}

type ThinkingVariantFactory =
    dyn Fn(ThinkingLevel) -> Result<Arc<dyn Provider>, ProviderError> + Send + Sync;

impl ProviderEndpoint {
    pub fn new(
        name: impl Into<String>,
        priority: i32,
        capabilities: impl IntoIterator<Item = ProviderCapability>,
        provider: Arc<dyn Provider>,
    ) -> Self {
        Self {
            name: name.into(),
            model: None,
            priority,
            capabilities: capabilities.into_iter().collect(),
            context_window_tokens: None,
            max_output_tokens: None,
            api_compat: None,
            default_thinking_level: ThinkingLevel::Off,
            provider,
            thinking_variant_factory: None,
            thinking_variant_cache: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
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

    pub fn with_api_compat(mut self, api_compat: ProviderApiCompat) -> Self {
        self.api_compat = Some(api_compat);
        self
    }

    pub fn with_default_thinking_level(mut self, thinking_level: ThinkingLevel) -> Self {
        self.default_thinking_level = thinking_level;
        self
    }

    pub fn with_thinking_variant_factory<F>(mut self, factory: F) -> Self
    where
        F: Fn(ThinkingLevel) -> Result<Arc<dyn Provider>, ProviderError> + Send + Sync + 'static,
    {
        self.thinking_variant_factory = Some(Arc::new(factory));
        self
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn priority(&self) -> i32 {
        self.priority
    }

    pub fn capabilities(&self) -> &[ProviderCapability] {
        &self.capabilities
    }

    pub fn context_window_tokens(&self) -> Option<u64> {
        self.context_window_tokens
    }

    pub fn max_output_tokens(&self) -> Option<u64> {
        self.max_output_tokens
    }

    pub fn api_compat(&self) -> Option<ProviderApiCompat> {
        self.api_compat
    }

    pub fn default_thinking_level(&self) -> ThinkingLevel {
        self.default_thinking_level
    }

    pub fn as_single_provider(&self) -> Arc<dyn Provider> {
        Arc::new(ProviderRouter::new(vec![self.clone()]))
    }

    pub(super) fn provider_for_thinking(
        &self,
        thinking_level: Option<ThinkingLevel>,
    ) -> Result<Arc<dyn Provider>, ProviderError> {
        let Some(thinking_level) = thinking_level else {
            return Ok(self.provider.clone());
        };
        let Some(factory) = &self.thinking_variant_factory else {
            return Err(ProviderError::config(format!(
                "provider endpoint {} cannot apply runtime thinking_level {}",
                self.name,
                thinking_level.as_str()
            )));
        };
        if let Some(provider) = self
            .thinking_variant_cache
            .lock()
            .expect("thinking variant cache mutex poisoned")
            .get(&thinking_level)
            .cloned()
        {
            return Ok(provider);
        }
        let provider = factory(thinking_level)?;
        self.thinking_variant_cache
            .lock()
            .expect("thinking variant cache mutex poisoned")
            .insert(thinking_level, provider.clone());
        Ok(provider)
    }

    pub(super) fn supports(&self, required: &[ProviderCapability]) -> bool {
        required
            .iter()
            .all(|capability| self.capabilities.contains(capability))
    }

    pub(super) fn metadata(&self) -> ProviderMetadata {
        ProviderMetadata::new(self.name.clone())
            .with_name(self.name.clone())
            .with_capabilities(self.capabilities.clone())
            .with_optional_context_window_tokens(self.context_window_tokens)
            .with_optional_max_output_tokens(self.max_output_tokens)
            .with_fallbacks(self.api_compat.map(|api_compat| ProviderMetadata {
                profile: self.name.clone(),
                name: Some(self.name.clone()),
                model: self.model.clone(),
                api_compat: Some(api_compat),
                capabilities: self.capabilities.clone(),
                context_window_tokens: self.context_window_tokens,
                max_output_tokens: self.max_output_tokens,
            }))
            .with_fallbacks(self.model.clone().map(|model| ProviderMetadata {
                profile: self.name.clone(),
                name: Some(self.name.clone()),
                model: Some(model),
                api_compat: self.api_compat,
                capabilities: self.capabilities.clone(),
                context_window_tokens: self.context_window_tokens,
                max_output_tokens: self.max_output_tokens,
            }))
    }
}

#[derive(Clone)]
pub struct ProviderRouter {
    endpoints: Vec<ProviderEndpoint>,
}

impl ProviderRouter {
    pub fn new(endpoints: Vec<ProviderEndpoint>) -> Self {
        Self { endpoints }
    }

    pub fn endpoints(&self) -> &[ProviderEndpoint] {
        &self.endpoints
    }

    pub(super) fn select_endpoint(
        &self,
        required: &[ProviderCapability],
    ) -> Option<&ProviderEndpoint> {
        self.endpoints
            .iter()
            .enumerate()
            .filter(|(_, endpoint)| endpoint.supports(required))
            .min_by_key(|(index, endpoint)| (endpoint.priority, *index))
            .map(|(_, endpoint)| endpoint)
    }
}

#[async_trait]
impl Provider for ProviderRouter {
    fn metadata_for_request(&self, request: &ProviderRequest) -> Option<ProviderMetadata> {
        let required = required_capabilities(request);
        let endpoint = self.select_endpoint(&required)?;
        Some(
            endpoint
                .metadata()
                .with_fallbacks(endpoint.provider.metadata_for_request(request)),
        )
    }

    async fn complete(
        &self,
        request: ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        let required = required_capabilities(&request);
        let endpoint = self
            .select_endpoint(&required)
            .ok_or_else(|| no_matching_endpoint_error(&required, &self.endpoints))?;

        let mut response = endpoint.provider.complete(request, cancel).await?;
        response.metadata = Some(endpoint.metadata().with_fallbacks(response.metadata.take()));
        Ok(response)
    }
}

pub(super) fn required_capabilities(request: &ProviderRequest) -> Vec<ProviderCapability> {
    let mut required = vec![ProviderCapability::Text];
    if request_contains_image(request) {
        required.push(ProviderCapability::Image);
    }
    if !request.tools.is_empty() {
        required.push(ProviderCapability::ToolCalls);
    }
    required
}

fn request_contains_image(request: &ProviderRequest) -> bool {
    request.input.iter().any(|input| match input {
        ModelInput::Message { message } => message_contains_image(message),
        ModelInput::Context { .. } => false,
    })
}

fn message_contains_image(message: &Message) -> bool {
    match message {
        Message::User { content } => content.iter().any(|part| {
            matches!(
                part,
                ContentPart::ImageUrl { .. } | ContentPart::ImageBase64 { .. }
            )
        }),
        Message::Assistant { .. } | Message::ToolResult(_) => false,
    }
}

pub(super) fn no_matching_endpoint_error(
    required: &[ProviderCapability],
    endpoints: &[ProviderEndpoint],
) -> ProviderError {
    if endpoints.is_empty() {
        return ProviderError::unavailable(format!(
            "provider_unavailable: no provider is configured for required capabilities {}",
            format_capabilities(required)
        ));
    }

    let endpoint_context = if endpoints.is_empty() {
        "none".to_owned()
    } else {
        endpoints
            .iter()
            .map(|endpoint| {
                format!(
                    "{} priority {} capabilities {}",
                    endpoint.name,
                    endpoint.priority,
                    format_capabilities(&endpoint.capabilities)
                )
            })
            .collect::<Vec<_>>()
            .join("; ")
    };

    ProviderError::config(format!(
        "no provider endpoint supports required capabilities {}; configured endpoints: {}",
        format_capabilities(required),
        endpoint_context
    ))
}

pub(super) fn format_capabilities(capabilities: &[ProviderCapability]) -> String {
    if capabilities.is_empty() {
        "[]".to_owned()
    } else {
        format!(
            "[{}]",
            capabilities
                .iter()
                .map(|capability| capability.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}
