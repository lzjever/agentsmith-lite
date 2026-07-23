use serde::{Deserialize, Serialize};

use crate::provider::thinking::ThinkingLevel;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderApiCompat {
    #[default]
    Standard,
    Deepseek,
    DashscopeQwen,
    DashscopeGlm,
    ZaiGlm,
}

impl ProviderApiCompat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Deepseek => "deepseek",
            Self::DashscopeQwen => "dashscope_qwen",
            Self::DashscopeGlm => "dashscope_glm",
            Self::ZaiGlm => "zai_glm",
        }
    }

    pub fn validate_thinking_level(self, level: ThinkingLevel) -> Result<(), String> {
        match (self, level) {
            (Self::Standard, ThinkingLevel::Off)
            | (Self::DashscopeQwen, ThinkingLevel::Off)
            | (Self::DashscopeQwen, ThinkingLevel::Low)
            | (Self::DashscopeQwen, ThinkingLevel::Medium)
            | (Self::DashscopeQwen, ThinkingLevel::High)
            | (Self::DashscopeQwen, ThinkingLevel::XHigh)
            | (Self::DashscopeGlm, ThinkingLevel::Off)
            | (Self::DashscopeGlm, ThinkingLevel::Low)
            | (Self::DashscopeGlm, ThinkingLevel::Medium)
            | (Self::DashscopeGlm, ThinkingLevel::High)
            | (Self::DashscopeGlm, ThinkingLevel::XHigh)
            | (Self::ZaiGlm, ThinkingLevel::Off)
            | (Self::ZaiGlm, ThinkingLevel::Low)
            | (Self::ZaiGlm, ThinkingLevel::Medium)
            | (Self::ZaiGlm, ThinkingLevel::High)
            | (Self::ZaiGlm, ThinkingLevel::XHigh)
            | (Self::Deepseek, ThinkingLevel::Off)
            | (Self::Deepseek, ThinkingLevel::Low)
            | (Self::Deepseek, ThinkingLevel::Medium)
            | (Self::Deepseek, ThinkingLevel::High)
            | (Self::Deepseek, ThinkingLevel::XHigh) => Ok(()),
            (Self::Standard, _) => Err(
                "api_compat standard only supports thinking.level off; choose an explicit provider api_compat for thinking"
                    .to_owned(),
            ),
            (Self::Deepseek, ThinkingLevel::Minimal) => Err(
                "api_compat deepseek does not support thinking.level minimal in this release"
                    .to_owned(),
            ),
            (Self::DashscopeQwen, ThinkingLevel::Minimal) => Err(
                "api_compat dashscope_qwen does not support thinking.level minimal in this release"
                    .to_owned(),
            ),
            (Self::DashscopeGlm, ThinkingLevel::Minimal) => Err(
                "api_compat dashscope_glm does not support thinking.level minimal in this release"
                    .to_owned(),
            ),
            (Self::ZaiGlm, ThinkingLevel::Minimal) => Err(
                "api_compat zai_glm does not support thinking.level minimal in this release"
                    .to_owned(),
            ),
        }
    }
}
