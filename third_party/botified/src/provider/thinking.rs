use serde::{Deserialize, Serialize};
use thiserror::Error;

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
    pub level: ThinkingLevel,
}

impl Default for ThinkingConfig {
    fn default() -> Self {
        Self {
            level: ThinkingLevel::Off,
        }
    }
}

impl ThinkingConfig {
    pub fn new(level: ThinkingLevel) -> Self {
        Self { level }
    }

    pub fn validate(&self) -> Result<(), ThinkingConfigError> {
        Ok(())
    }

    pub fn is_off(&self) -> bool {
        self.level.is_off()
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("invalid thinking config: {message}")]
pub struct ThinkingConfigError {
    message: String,
}
