use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use crate::system_prompt::PromptCapabilities;
use crate::tools::{Tool, ToolSpec};

use super::tool_execution::seconds_for_message;
use super::{AgentRunErrorKind, ToolExecutionPolicy};

pub(crate) struct FinalToolSnapshot {
    specs: Vec<ToolSpec>,
    tools_by_name: BTreeMap<String, Arc<dyn Tool>>,
    prompt_capabilities: PromptCapabilities,
}

impl FinalToolSnapshot {
    pub(crate) fn build(
        tools: Vec<Arc<dyn Tool>>,
        policy: &ToolExecutionPolicy,
    ) -> Result<Self, AgentRunErrorKind> {
        let specs = tools
            .iter()
            .map(|tool| decorate_tool_spec(tool.spec(), policy))
            .collect::<Vec<_>>();
        validate_final_tool_specs(&specs)
            .map_err(|message| AgentRunErrorKind::Configuration { message })?;
        let mut tools_by_name = BTreeMap::new();
        for (tool, spec) in tools.into_iter().zip(&specs) {
            tools_by_name.insert(spec.name.clone(), tool);
        }

        let prompt_capabilities = PromptCapabilities::from_tool_names(tools_by_name.keys());
        Ok(Self {
            specs,
            tools_by_name,
            prompt_capabilities,
        })
    }

    pub(crate) fn with_tools(mut self, tools: Vec<Arc<dyn Tool>>) -> Self {
        assert_eq!(
            tools.len(),
            self.specs.len(),
            "final tool snapshot binding must preserve tool count"
        );
        self.tools_by_name = tools
            .into_iter()
            .zip(&self.specs)
            .map(|(tool, spec)| (spec.name.clone(), tool))
            .collect();
        self
    }

    pub(super) fn tool(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools_by_name.get(name)
    }

    pub(super) fn prompt_capabilities(&self) -> PromptCapabilities {
        self.prompt_capabilities
    }

    pub(crate) fn specs(&self) -> &[ToolSpec] {
        &self.specs
    }
}

fn decorate_tool_spec(mut spec: ToolSpec, policy: &ToolExecutionPolicy) -> ToolSpec {
    if spec.name != "bash" {
        return spec;
    }
    spec.description.push_str(&format!(
        " Execution policy: detach_after_secs is a foreground-wait threshold with default {} seconds and is clamped to {} seconds; 0 detaches immediately. It does not guarantee runtime, timeout, success, readiness, output, or callback delivery. Detached execution returns an acknowledgement proving only running state and task identity. Any terminal callback is a best-effort terminal callback. timeout_secs has default {} seconds and is clamped to {} seconds; explicit JSON null disables the automatic deadline.",
        seconds_for_message(policy.default_detach_after),
        seconds_for_message(policy.max_detach_after),
        seconds_for_message(policy.default_timeout),
        seconds_for_message(policy.max_timeout),
    ));
    spec
}

fn validate_final_tool_specs(specs: &[ToolSpec]) -> Result<(), String> {
    validate_final_tool_names(specs.iter().map(|spec| spec.name.as_str()))
}

pub(crate) fn validate_final_tool_names<'a>(
    tool_names: impl IntoIterator<Item = &'a str>,
) -> Result<(), String> {
    let mut names = HashSet::new();
    for name in tool_names {
        if !names.insert(name) {
            return Err(format!("duplicate tool name `{name}`"));
        }
    }
    if names.contains("agent_runtime_set") && !names.contains("agent_runtime_get") {
        return Err("`agent_runtime_set` requires `agent_runtime_get`".to_owned());
    }
    Ok(())
}
