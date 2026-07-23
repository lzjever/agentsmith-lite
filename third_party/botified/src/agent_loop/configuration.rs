use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::context_files::ContextFileLoadConfig;
use crate::skills::{Skill, SkillLoadConfig};
use crate::tasks::TaskOutputPolicy;

const DEFAULT_DETACH_AFTER: Duration = Duration::from_secs(1);
const MAX_DETACH_AFTER: Duration = Duration::from_secs(10);
const DEFAULT_TOOL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TOOL_TIMEOUT: Duration = Duration::from_secs(1_800);
const DEFAULT_MAX_CONCURRENT_TASKS: usize = 4;
const DEFAULT_MAX_RETAINED_TASKS: usize = 128;
const DEFAULT_TASK_RETENTION: Duration = Duration::from_secs(86_400);
const DEFAULT_MAX_TASK_REQUEST_PENDING: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolExecutionPolicy {
    pub default_detach_after: Duration,
    pub max_detach_after: Duration,
    pub default_timeout: Duration,
    pub max_timeout: Duration,
    pub max_concurrent_tasks: usize,
    pub max_retained_tasks: usize,
    pub task_retention: Duration,
    pub max_task_request_pending: Duration,
}

impl ToolExecutionPolicy {
    pub fn with_default_detach_after(mut self, duration: Duration) -> Self {
        self.default_detach_after = duration;
        self
    }

    pub fn with_max_detach_after(mut self, duration: Duration) -> Self {
        self.max_detach_after = duration;
        self
    }

    pub fn with_default_timeout(mut self, duration: Duration) -> Self {
        self.default_timeout = duration;
        self
    }

    pub fn with_max_timeout(mut self, duration: Duration) -> Self {
        self.max_timeout = duration;
        self
    }

    pub fn with_max_concurrent_tasks(mut self, max_concurrent_tasks: usize) -> Self {
        self.max_concurrent_tasks = max_concurrent_tasks;
        self
    }

    pub fn with_max_retained_tasks(mut self, max_retained_tasks: usize) -> Self {
        self.max_retained_tasks = max_retained_tasks;
        self
    }

    pub fn with_task_retention(mut self, duration: Duration) -> Self {
        self.task_retention = duration;
        self
    }

    pub fn with_max_task_request_pending(mut self, duration: Duration) -> Self {
        self.max_task_request_pending = duration;
        self
    }
}

impl Default for ToolExecutionPolicy {
    fn default() -> Self {
        Self {
            default_detach_after: DEFAULT_DETACH_AFTER,
            max_detach_after: MAX_DETACH_AFTER,
            default_timeout: DEFAULT_TOOL_TIMEOUT,
            max_timeout: MAX_TOOL_TIMEOUT,
            max_concurrent_tasks: DEFAULT_MAX_CONCURRENT_TASKS,
            max_retained_tasks: DEFAULT_MAX_RETAINED_TASKS,
            task_retention: DEFAULT_TASK_RETENTION,
            max_task_request_pending: DEFAULT_MAX_TASK_REQUEST_PENDING,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    pub system_prompt: String,
    pub cwd: String,
    #[serde(default)]
    pub skills: Vec<Skill>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_refresh: Option<PromptRefreshConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub tool_execution: ToolExecutionPolicy,
    #[serde(default)]
    pub task_output: TaskOutputPolicy,
}

impl AgentConfig {
    pub fn new(system_prompt: impl Into<String>) -> Self {
        Self {
            system_prompt: system_prompt.into(),
            cwd: ".".to_owned(),
            skills: Vec::new(),
            prompt_refresh: None,
            session: None,
            turn_id: None,
            tool_execution: ToolExecutionPolicy::default(),
            task_output: TaskOutputPolicy::default(),
        }
    }

    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = cwd.into();
        self
    }

    pub fn with_skills(mut self, skills: Vec<Skill>) -> Self {
        self.skills = skills;
        self
    }

    pub fn with_prompt_refresh(
        mut self,
        base_system_prompt: impl Into<String>,
        skill_load_config: SkillLoadConfig,
        context_file_load_config: ContextFileLoadConfig,
    ) -> Self {
        self.prompt_refresh = Some(PromptRefreshConfig {
            base_system_prompt: base_system_prompt.into(),
            skill_load_config,
            context_file_load_config,
        });
        self
    }

    pub fn with_session(mut self, session: impl Into<String>) -> Self {
        self.session = Some(session.into());
        self
    }

    pub fn with_turn_id(mut self, turn_id: impl Into<String>) -> Self {
        self.turn_id = Some(turn_id.into());
        self
    }

    pub fn with_tool_execution_policy(mut self, policy: ToolExecutionPolicy) -> Self {
        self.tool_execution = policy;
        self
    }

    pub fn with_task_output_policy(mut self, policy: TaskOutputPolicy) -> Self {
        self.task_output = policy;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptRefreshConfig {
    pub base_system_prompt: String,
    pub skill_load_config: SkillLoadConfig,
    pub context_file_load_config: ContextFileLoadConfig,
}
