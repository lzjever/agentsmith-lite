use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingFormat {
    None,
    #[serde(rename = "openai")]
    OpenAi,
    Deepseek,
    Qwen,
    Glm,
}

impl ThinkingFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::OpenAi => "openai",
            Self::Deepseek => "deepseek",
            Self::Qwen => "qwen",
            Self::Glm => "glm",
        }
    }

    fn rejects_non_off_level_map_strings(self) -> bool {
        matches!(self, Self::Qwen | Self::Glm)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    #[serde(rename = "xhigh")]
    XHigh,
}

impl ThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
        }
    }

    pub fn is_off(self) -> bool {
        self == Self::Off
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThinkingConfig {
    pub format: ThinkingFormat,
    pub level: ThinkingLevel,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub level_map: BTreeMap<ThinkingLevel, Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_tokens: Option<u32>,
}

impl Default for ThinkingConfig {
    fn default() -> Self {
        Self {
            format: ThinkingFormat::None,
            level: ThinkingLevel::Off,
            level_map: BTreeMap::new(),
            budget_tokens: None,
        }
    }
}

impl ThinkingConfig {
    pub fn new(format: ThinkingFormat, level: ThinkingLevel) -> Self {
        Self {
            format,
            level,
            ..Self::default()
        }
    }

    pub fn validate(&self) -> Result<(), ThinkingConfigError> {
        if self.format == ThinkingFormat::None && !self.level.is_off() {
            return Err(ThinkingConfigError::new(
                "thinking format none requires level off",
            ));
        }
        if matches!(self.budget_tokens, Some(0)) {
            return Err(ThinkingConfigError::new(
                "thinking budget_tokens must be greater than 0",
            ));
        }
        if self.budget_tokens.is_some() && self.format != ThinkingFormat::Qwen {
            return Err(ThinkingConfigError::new(
                "thinking budget_tokens is only supported for qwen format",
            ));
        }

        if self.format.rejects_non_off_level_map_strings() {
            for (level, mapped) in &self.level_map {
                if !level.is_off() && mapped.is_some() {
                    return Err(ThinkingConfigError::new(format!(
                        "thinking format {} does not support string level_map.{} mappings",
                        self.format.as_str(),
                        level.as_str()
                    )));
                }
            }
        }

        if !self.level.is_off() {
            self.mapped_non_off_level()?;
        }
        if let Some(Some(mapped)) = self.level_map.get(&ThinkingLevel::Off) {
            if !(self.format == ThinkingFormat::OpenAi && self.level.is_off()) {
                return Err(ThinkingConfigError::new(
                    "thinking level_map.off string is only supported for openai format with level off",
                ));
            }
            validate_mapped_level(mapped, ThinkingLevel::Off)?;
        }

        Ok(())
    }

    pub fn mapped_non_off_level(&self) -> Result<String, ThinkingConfigError> {
        if self.level.is_off() {
            return Err(ThinkingConfigError::new(
                "thinking off level does not have a non-off effort mapping",
            ));
        }
        match self.level_map.get(&self.level) {
            Some(Some(mapped)) => validate_mapped_level(mapped, self.level),
            Some(None) => Err(ThinkingConfigError::new(format!(
                "thinking level {} is unsupported by this provider",
                self.level.as_str()
            ))),
            None => Ok(self.level.as_str().to_owned()),
        }
    }

    pub fn mapped_off_level(&self) -> Result<Option<String>, ThinkingConfigError> {
        match self.level_map.get(&ThinkingLevel::Off) {
            Some(Some(mapped)) => validate_mapped_level(mapped, ThinkingLevel::Off).map(Some),
            Some(None) | None => Ok(None),
        }
    }

    pub fn includes_reasoning_content_replay(&self) -> bool {
        !self.level.is_off()
            && matches!(
                self.format,
                ThinkingFormat::Deepseek | ThinkingFormat::Qwen | ThinkingFormat::Glm
            )
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("invalid thinking config: {message}")]
pub struct ThinkingConfigError {
    message: String,
}

impl ThinkingConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

fn validate_mapped_level(
    mapped: &str,
    level: ThinkingLevel,
) -> Result<String, ThinkingConfigError> {
    let mapped = mapped.trim();
    if mapped.is_empty() {
        Err(ThinkingConfigError::new(format!(
            "thinking level {} maps to an empty provider value",
            level.as_str()
        )))
    } else {
        Ok(mapped.to_owned())
    }
}
