use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::provider::router::{
    format_capabilities, no_matching_endpoint_error, required_capabilities, ProviderCapability,
    ProviderEndpoint, ProviderRouter,
};
use crate::provider::thinking::ThinkingLevel;
use crate::provider::{
    Provider, ProviderError, ProviderMetadata, ProviderRequest, ProviderResponse,
};

pub const AUTO_PROVIDER_NAME: &str = "auto";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSelection {
    provider_name: String,
    thinking_level: Option<ThinkingLevel>,
}

impl RuntimeSelection {
    pub fn auto() -> Self {
        Self {
            provider_name: AUTO_PROVIDER_NAME.to_owned(),
            thinking_level: None,
        }
    }

    pub fn named(provider_name: impl Into<String>) -> Self {
        Self {
            provider_name: provider_name.into(),
            thinking_level: None,
        }
    }

    pub fn from_parts(
        provider_name: Option<String>,
        thinking_level: Option<ThinkingLevel>,
        base: &RuntimeSelection,
    ) -> Self {
        let thinking_level = thinking_level
            .map(RuntimeThinkingLevelPatch::Set)
            .unwrap_or(RuntimeThinkingLevelPatch::Unchanged);
        base.apply_patch(provider_name, thinking_level)
    }

    pub fn apply_patch(
        &self,
        provider_name: Option<String>,
        thinking_level: RuntimeThinkingLevelPatch,
    ) -> Self {
        Self {
            provider_name: provider_name.unwrap_or_else(|| self.provider_name.clone()),
            thinking_level: match thinking_level {
                RuntimeThinkingLevelPatch::Unchanged => self.thinking_level,
                RuntimeThinkingLevelPatch::Clear => None,
                RuntimeThinkingLevelPatch::Set(level) => Some(level),
            },
        }
    }

    pub fn with_thinking_level(mut self, thinking_level: Option<ThinkingLevel>) -> Self {
        self.thinking_level = thinking_level;
        self
    }

    pub fn provider_name(&self) -> &str {
        &self.provider_name
    }

    pub fn thinking_level(&self) -> Option<ThinkingLevel> {
        self.thinking_level
    }

    pub fn to_json(&self) -> Value {
        json!({
            "provider_name": self.provider_name,
            "thinking_level": self.thinking_level.map(ThinkingLevel::as_str),
        })
    }
}

impl Default for RuntimeSelection {
    fn default() -> Self {
        Self::auto()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeThinkingLevelPatch {
    Unchanged,
    Clear,
    Set(ThinkingLevel),
}

impl RuntimeThinkingLevelPatch {
    pub fn is_unchanged(self) -> bool {
        matches!(self, Self::Unchanged)
    }
}

#[derive(Clone)]
pub struct RuntimeSelectionHandle {
    catalog: Arc<RuntimeProviderCatalog>,
    state: RuntimeSelectionState,
}

#[derive(Clone)]
enum RuntimeSelectionState {
    Mutable(Arc<Mutex<RuntimeSelection>>),
    Fixed(RuntimeSelection),
}

impl RuntimeSelectionHandle {
    pub fn new_mutable(endpoints: Vec<ProviderEndpoint>) -> Result<Self, ProviderError> {
        Ok(Self {
            catalog: Arc::new(RuntimeProviderCatalog::new(endpoints)?),
            state: RuntimeSelectionState::Mutable(Arc::new(Mutex::new(RuntimeSelection::auto()))),
        })
    }

    pub fn fixed_from_selection(&self, selection: RuntimeSelection) -> Result<Self, ProviderError> {
        self.catalog.validate_agent_selection(&selection)?;
        Ok(Self {
            catalog: self.catalog.clone(),
            state: RuntimeSelectionState::Fixed(selection),
        })
    }

    pub fn provider(&self) -> Arc<dyn Provider> {
        Arc::new(RuntimeSelectingProvider {
            handle: self.clone(),
        })
    }

    pub fn auto_provider(&self) -> Arc<dyn Provider> {
        self.catalog.auto_provider()
    }

    pub fn snapshot(&self) -> RuntimeSelection {
        match &self.state {
            RuntimeSelectionState::Mutable(selection) => selection
                .lock()
                .expect("runtime selection mutex poisoned")
                .clone(),
            RuntimeSelectionState::Fixed(selection) => selection.clone(),
        }
    }

    pub fn set(&self, selection: RuntimeSelection) -> Result<(), ProviderError> {
        let RuntimeSelectionState::Mutable(current) = &self.state else {
            return Err(ProviderError::config(
                "agent_runtime_set is not available for fixed subagent runtime",
            ));
        };
        self.catalog.validate_agent_selection(&selection)?;
        *current.lock().expect("runtime selection mutex poisoned") = selection;
        Ok(())
    }

    pub fn validate_agent_selection(
        &self,
        selection: &RuntimeSelection,
    ) -> Result<(), ProviderError> {
        self.catalog.validate_agent_selection(selection)
    }

    pub fn fixed_provider_for(
        &self,
        selection: RuntimeSelection,
    ) -> Result<(Self, Arc<dyn Provider>), ProviderError> {
        let fixed = self.fixed_from_selection(selection)?;
        let provider = fixed.provider();
        Ok((fixed, provider))
    }

    pub fn runtime_get_json(&self, can_set: bool) -> Value {
        let selection = self.snapshot();
        let current = self
            .catalog
            .resolve_endpoint_for_capabilities(&selection, &agent_required_capabilities())
            .ok()
            .map(|endpoint| current_endpoint_summary_json(endpoint, &selection));
        let providers = self
            .catalog
            .router
            .endpoints()
            .iter()
            .map(endpoint_summary_json)
            .collect::<Vec<_>>();
        json!({
            "selection": selection.to_json(),
            "current_provider": current,
            "providers": providers,
            "subagents": {
                "spawn_default": "inherit_main_runtime_snapshot",
                "spawn_overrides": ["provider_name", "thinking_level"],
                "runtime_after_spawn": "fixed",
                "tools": {
                    "agent_runtime_get": true,
                    "agent_runtime_set": false
                }
            },
            "can_set": can_set,
        })
    }
}

struct RuntimeSelectingProvider {
    handle: RuntimeSelectionHandle,
}

#[async_trait]
impl Provider for RuntimeSelectingProvider {
    fn metadata_for_request(&self, request: &ProviderRequest) -> Option<ProviderMetadata> {
        let selection = self.handle.snapshot();
        self.handle
            .catalog
            .resolve_provider_for_request(&selection, request)
            .ok()
            .map(|resolved| {
                resolved
                    .endpoint
                    .metadata()
                    .with_fallbacks(resolved.provider.metadata_for_request(request))
            })
    }

    async fn complete(
        &self,
        request: ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderResponse, ProviderError> {
        let selection = self.handle.snapshot();
        let resolved = self
            .handle
            .catalog
            .resolve_provider_for_request(&selection, &request)?;
        let mut response = resolved.provider.complete(request, cancel).await?;
        response.metadata = Some(
            resolved
                .endpoint
                .metadata()
                .with_fallbacks(response.metadata.take()),
        );
        Ok(response)
    }
}

struct RuntimeProviderCatalog {
    router: ProviderRouter,
}

struct ResolvedRuntimeProvider<'a> {
    endpoint: &'a ProviderEndpoint,
    provider: Arc<dyn Provider>,
}

impl RuntimeProviderCatalog {
    fn new(endpoints: Vec<ProviderEndpoint>) -> Result<Self, ProviderError> {
        let mut names = HashSet::new();
        for endpoint in &endpoints {
            if endpoint.name() == AUTO_PROVIDER_NAME {
                return Err(ProviderError::config(
                    "provider name auto is reserved for runtime automatic selection",
                ));
            }
            if !names.insert(endpoint.name().to_owned()) {
                return Err(ProviderError::config(format!(
                    "duplicate provider name {}",
                    endpoint.name()
                )));
            }
        }
        Ok(Self {
            router: ProviderRouter::new(endpoints),
        })
    }

    fn auto_provider(&self) -> Arc<dyn Provider> {
        Arc::new(ProviderRouter::new(self.router.endpoints().to_vec()))
    }

    fn validate_agent_selection(&self, selection: &RuntimeSelection) -> Result<(), ProviderError> {
        self.validate_provider_name(selection.provider_name())?;
        let endpoint =
            self.resolve_endpoint_for_capabilities(selection, &agent_required_capabilities())?;
        if selection.thinking_level().is_some() {
            endpoint.provider_for_thinking(selection.thinking_level())?;
        }
        Ok(())
    }

    fn validate_provider_name(&self, provider_name: &str) -> Result<(), ProviderError> {
        let provider_name = provider_name.trim();
        if provider_name.is_empty() {
            return Err(ProviderError::config("provider_name must not be empty"));
        }
        if provider_name == AUTO_PROVIDER_NAME {
            return Ok(());
        }
        if self
            .router
            .endpoints()
            .iter()
            .any(|endpoint| endpoint.name() == provider_name)
        {
            return Ok(());
        }
        Err(ProviderError::config(format!(
            "unknown provider_name {provider_name}"
        )))
    }

    fn resolve_provider_for_request(
        &self,
        selection: &RuntimeSelection,
        request: &ProviderRequest,
    ) -> Result<ResolvedRuntimeProvider<'_>, ProviderError> {
        let required = required_capabilities(request);
        let endpoint = self.resolve_endpoint_for_capabilities(selection, &required)?;
        let provider = endpoint.provider_for_thinking(selection.thinking_level())?;
        Ok(ResolvedRuntimeProvider { endpoint, provider })
    }

    fn resolve_endpoint_for_capabilities(
        &self,
        selection: &RuntimeSelection,
        required: &[ProviderCapability],
    ) -> Result<&ProviderEndpoint, ProviderError> {
        self.validate_provider_name(selection.provider_name())?;
        let endpoint = if selection.provider_name() == AUTO_PROVIDER_NAME {
            self.router
                .select_endpoint(required)
                .ok_or_else(|| no_matching_endpoint_error(required, self.router.endpoints()))?
        } else {
            let endpoint = self
                .router
                .endpoints()
                .iter()
                .find(|endpoint| endpoint.name() == selection.provider_name())
                .ok_or_else(|| {
                    ProviderError::config(format!(
                        "unknown provider_name {}",
                        selection.provider_name()
                    ))
                })?;
            if !endpoint.supports(required) {
                return Err(ProviderError::config(format!(
                    "provider_name {} does not support required capabilities {}; endpoint capabilities {}",
                    selection.provider_name(),
                    format_capabilities(required),
                    format_capabilities(endpoint.capabilities())
                )));
            }
            endpoint
        };
        validate_thinking_level(endpoint, selection.thinking_level())?;
        Ok(endpoint)
    }
}

fn validate_thinking_level(
    endpoint: &ProviderEndpoint,
    thinking_level: Option<ThinkingLevel>,
) -> Result<(), ProviderError> {
    let Some(thinking_level) = thinking_level else {
        return Ok(());
    };
    let api_compat = endpoint.api_compat().ok_or_else(|| {
        ProviderError::config(format!(
            "provider_name {} cannot validate runtime thinking_level {}",
            endpoint.name(),
            thinking_level.as_str()
        ))
    })?;
    api_compat
        .validate_thinking_level(thinking_level)
        .map_err(|error| {
            ProviderError::config(format!(
                "provider_name {} rejects thinking_level {}: {error}",
                endpoint.name(),
                thinking_level.as_str()
            ))
        })
}

fn agent_required_capabilities() -> Vec<ProviderCapability> {
    vec![ProviderCapability::Text, ProviderCapability::ToolCalls]
}

fn sanitized_metadata_json(metadata: &ProviderMetadata) -> Value {
    let metadata = metadata.sanitized().unwrap_or_else(|| metadata.clone());
    json!({
        "profile": metadata.profile,
        "name": metadata.name,
        "model": metadata.model,
        "api_compat": metadata.api_compat.map(|api_compat| api_compat.as_str()),
        "capabilities": metadata
            .capabilities
            .iter()
            .map(|capability| capability.as_str())
            .collect::<Vec<_>>(),
        "context_window_tokens": metadata.context_window_tokens,
        "max_output_tokens": metadata.max_output_tokens,
    })
}

fn endpoint_summary_json(endpoint: &ProviderEndpoint) -> Value {
    let mut summary = sanitized_metadata_json(&endpoint.metadata());
    if let Some(summary) = summary.as_object_mut() {
        summary.insert(
            "default_thinking_level".to_owned(),
            json!(endpoint.default_thinking_level().as_str()),
        );
    }
    summary
}

fn current_endpoint_summary_json(
    endpoint: &ProviderEndpoint,
    selection: &RuntimeSelection,
) -> Value {
    let mut summary = endpoint_summary_json(endpoint);
    if let Some(summary) = summary.as_object_mut() {
        let effective = selection
            .thinking_level()
            .unwrap_or_else(|| endpoint.default_thinking_level());
        summary.insert(
            "effective_thinking_level".to_owned(),
            json!(effective.as_str()),
        );
    }
    summary
}
