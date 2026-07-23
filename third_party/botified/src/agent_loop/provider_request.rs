use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::context_files::load_context_files;
use crate::files::FileStore;
use crate::message_render::render_messages_for_provider_with_file_store;
use crate::provider::ProviderRequest;
use crate::skills::{
    load_skills, render_requested_skill_contexts_for_contents_with_frozen_bodies, skill_identity,
    FrozenSkillBodies, RequestedSkillContexts, Skill, SkillIdentity,
};
use crate::system_prompt::{
    build_system_prompt_with_capabilities, render_available_skills_context_report,
    render_explicit_skill_context, render_project_instruction_context,
    render_runtime_environment_context, PromptCapabilities, RuntimeEnvironmentContext,
};
use crate::types::{ContextRole, Message};

use super::{AgentConfig, FinalToolSnapshot};

fn requested_skill_contexts_for_current_request(
    messages: &[Message],
    skills: &[Skill],
    frozen_bodies: &FrozenSkillBodies,
    cwd: &Path,
    current_request_start: usize,
) -> RequestedSkillContexts {
    render_requested_skill_contexts_for_contents_with_frozen_bodies(
        messages[current_request_start..]
            .iter()
            .filter_map(|message| match message {
                Message::User { content } => Some(content.as_slice()),
                Message::Assistant { .. } | Message::ToolResult(_) => None,
            }),
        skills,
        cwd,
        Some(frozen_bodies),
    )
}

fn render_explicit_skill_context_without_requested(
    skills: &[Skill],
    requested_identities: &HashSet<SkillIdentity>,
) -> Option<String> {
    if requested_identities.is_empty() {
        return render_explicit_skill_context(skills);
    }

    let filtered = skills
        .iter()
        .filter(|skill| {
            !(skill.is_explicit() && requested_identities.contains(&skill_identity(skill)))
        })
        .cloned()
        .collect::<Vec<_>>();
    render_explicit_skill_context(&filtered)
}

fn runtime_environment_context(config: &AgentConfig) -> RuntimeEnvironmentContext {
    RuntimeEnvironmentContext {
        cwd: model_visible_cwd(&config.cwd).display().to_string(),
        shell: "bash -lc".to_owned(),
        max_concurrent_tasks: config.tool_execution.max_concurrent_tasks,
    }
}

pub(super) fn build_final_provider_request(
    config: &mut AgentConfig,
    messages: &[Message],
    tools: &FinalToolSnapshot,
    file_store: Option<&FileStore>,
    current_request_start: usize,
    prompt_material_snapshot: &mut Option<PromptMaterialSnapshot>,
) -> BuiltProviderRequest {
    if prompt_material_snapshot.is_none() {
        *prompt_material_snapshot = Some(refresh_prompt_materials(
            config,
            tools.prompt_capabilities(),
        ));
    }
    let prompt_materials = prompt_material_snapshot
        .as_ref()
        .expect("prompt material snapshot should be initialized before provider request");
    let mut request = ProviderRequest::new(
        prompt_materials.system_prompt.clone(),
        render_messages_for_provider_with_file_store(messages, file_store),
        tools.specs().to_vec(),
    );
    let available_skills_report = render_available_skills_context_report(&prompt_materials.skills);
    if let Some(context) = available_skills_report.context {
        request = request.with_prefix_context(ContextRole::Developer, context);
    }
    let requested_skill_contexts = requested_skill_contexts_for_current_request(
        messages,
        &prompt_materials.skills,
        &prompt_materials.requested_skill_bodies,
        Path::new(&config.cwd),
        current_request_start,
    );
    if let Some(context) = render_explicit_skill_context_without_requested(
        &prompt_materials.skills,
        &requested_skill_contexts.identities,
    ) {
        request = request.with_prefix_context(ContextRole::User, context);
    }
    if let Some(context) = prompt_materials.project_instruction_context.clone() {
        request = request.with_prefix_context(ContextRole::User, context);
    }
    request = request.with_prefix_context(
        ContextRole::System,
        render_runtime_environment_context(&runtime_environment_context(config)),
    );
    for context in requested_skill_contexts.contexts {
        request = request.with_turn_context_at_transcript_index(
            ContextRole::User,
            context,
            current_request_start,
        );
    }

    BuiltProviderRequest {
        request,
        warnings: available_skills_report.warnings,
    }
}

fn model_visible_cwd(cwd: &str) -> PathBuf {
    let path = Path::new(cwd);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    std::fs::canonicalize(&absolute).unwrap_or(absolute)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PromptMaterialSnapshot {
    system_prompt: String,
    skills: Vec<Skill>,
    requested_skill_bodies: FrozenSkillBodies,
    project_instruction_context: Option<String>,
}

pub(super) struct BuiltProviderRequest {
    pub(super) request: ProviderRequest,
    pub(super) warnings: Vec<String>,
}

fn refresh_prompt_materials(
    config: &mut AgentConfig,
    prompt_capabilities: PromptCapabilities,
) -> PromptMaterialSnapshot {
    let project_instruction_context = if let Some(refresh) = config.prompt_refresh.as_ref() {
        let loaded_context_files = load_context_files(&refresh.context_file_load_config);
        let loaded_skills = load_skills(&refresh.skill_load_config);
        config.skills = loaded_skills.skills;
        config.system_prompt =
            build_system_prompt_with_capabilities(&refresh.base_system_prompt, prompt_capabilities);
        render_project_instruction_context(&loaded_context_files.files)
    } else {
        config.system_prompt =
            build_system_prompt_with_capabilities(&config.system_prompt, prompt_capabilities);
        None
    };

    let skills = config.skills.clone();
    PromptMaterialSnapshot {
        system_prompt: config.system_prompt.clone(),
        requested_skill_bodies: FrozenSkillBodies::from_skills(&skills),
        skills,
        project_instruction_context,
    }
}
