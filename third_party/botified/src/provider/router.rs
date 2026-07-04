use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

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
    provider: Arc<dyn Provider>,
}

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
            provider,
        }
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
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

    pub fn as_single_provider(&self) -> Arc<dyn Provider> {
        Arc::new(ProviderRouter::new(vec![self.clone()]))
    }

    fn supports(&self, required: &[ProviderCapability]) -> bool {
        required
            .iter()
            .all(|capability| self.capabilities.contains(capability))
    }

    fn metadata(&self) -> ProviderMetadata {
        ProviderMetadata::new(self.name.clone())
            .with_name(self.name.clone())
            .with_capabilities(self.capabilities.clone())
            .with_fallbacks(self.model.clone().map(|model| ProviderMetadata {
                profile: self.name.clone(),
                name: Some(self.name.clone()),
                model: Some(model),
                capabilities: self.capabilities.clone(),
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

    fn select_endpoint(&self, required: &[ProviderCapability]) -> Option<&ProviderEndpoint> {
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

fn required_capabilities(request: &ProviderRequest) -> Vec<ProviderCapability> {
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

fn no_matching_endpoint_error(
    required: &[ProviderCapability],
    endpoints: &[ProviderEndpoint],
) -> ProviderError {
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

fn format_capabilities(capabilities: &[ProviderCapability]) -> String {
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
