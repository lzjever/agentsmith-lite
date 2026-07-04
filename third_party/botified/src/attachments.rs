use serde_json::Value;
use thiserror::Error;

use crate::types::ContentPart;

pub const MAX_IMAGE_BASE64_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum AttachmentError {
    #[error("invalid request")]
    InvalidRequest,
    #[error("unsupported attachment")]
    UnsupportedAttachment,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedUserInput {
    pub items: Vec<PublicInputItem>,
}

impl ParsedUserInput {
    pub fn new(items: Vec<PublicInputItem>) -> Self {
        Self { items }
    }

    pub fn contains_file_refs(&self) -> bool {
        self.items
            .iter()
            .any(|item| matches!(item, PublicInputItem::File { .. }))
    }

    pub fn into_unbound_content(self) -> Result<Vec<ContentPart>, AttachmentError> {
        self.items
            .into_iter()
            .map(|item| match item {
                PublicInputItem::Text { text } => Ok(ContentPart::text(text)),
                PublicInputItem::Skill {
                    name,
                    path,
                    arguments,
                } => Ok(ContentPart::Skill {
                    name,
                    path,
                    arguments,
                }),
                PublicInputItem::File { .. } => Err(AttachmentError::InvalidRequest),
            })
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PublicInputItem {
    Text {
        text: String,
    },
    File {
        file_id: String,
    },
    Skill {
        name: Option<String>,
        path: Option<String>,
        arguments: Option<String>,
    },
}

pub fn parse_user_input(input: Value) -> Result<ParsedUserInput, AttachmentError> {
    let object = input.as_object().ok_or(AttachmentError::InvalidRequest)?;
    let has_text = object.contains_key("text");
    let has_items = object.contains_key("items");

    match (has_text, has_items) {
        (true, true) => Err(AttachmentError::InvalidRequest),
        (true, false) => parse_text_shortcut(object.get("text")),
        (false, true) => parse_items(object.get("items")),
        (false, false) => Err(AttachmentError::InvalidRequest),
    }
}

fn parse_text_shortcut(value: Option<&Value>) -> Result<ParsedUserInput, AttachmentError> {
    let text = non_empty_string(value).ok_or(AttachmentError::InvalidRequest)?;
    Ok(ParsedUserInput::new(vec![PublicInputItem::Text {
        text: text.to_owned(),
    }]))
}

fn parse_items(value: Option<&Value>) -> Result<ParsedUserInput, AttachmentError> {
    let items = value
        .and_then(Value::as_array)
        .ok_or(AttachmentError::InvalidRequest)?;

    if items.is_empty() {
        return Err(AttachmentError::InvalidRequest);
    }

    let mut parts = Vec::with_capacity(items.len());
    for item in items {
        parts.push(parse_item(item)?);
    }

    if parts.is_empty() {
        return Err(AttachmentError::InvalidRequest);
    }

    Ok(ParsedUserInput::new(parts))
}

fn parse_item(item: &Value) -> Result<PublicInputItem, AttachmentError> {
    let object = item.as_object().ok_or(AttachmentError::InvalidRequest)?;
    let item_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or(AttachmentError::InvalidRequest)?;

    match item_type {
        "text" => {
            let text =
                non_empty_string(object.get("text")).ok_or(AttachmentError::InvalidRequest)?;
            Ok(PublicInputItem::Text {
                text: text.to_owned(),
            })
        }
        "file" => {
            if object.keys().any(|key| key != "type" && key != "file_id") {
                return Err(AttachmentError::InvalidRequest);
            }
            let file_id =
                non_empty_string(object.get("file_id")).ok_or(AttachmentError::InvalidRequest)?;
            Ok(PublicInputItem::File {
                file_id: file_id.to_owned(),
            })
        }
        "image_url" | "image_base64" => Err(AttachmentError::UnsupportedAttachment),
        "skill" => parse_skill_like_item(object, false),
        "mention" => parse_skill_like_item(object, true),
        "image_path" | "multipart" => Err(AttachmentError::UnsupportedAttachment),
        _ => Err(AttachmentError::UnsupportedAttachment),
    }
}

fn parse_skill_like_item(
    object: &serde_json::Map<String, Value>,
    reject_non_skill_resource_paths: bool,
) -> Result<PublicInputItem, AttachmentError> {
    let name = optional_non_empty_string(object.get("name"));
    let path = optional_non_empty_string(object.get("path"));
    if name.is_none() && path.is_none() {
        return Err(AttachmentError::InvalidRequest);
    }
    if reject_non_skill_resource_paths && path.is_some_and(is_non_skill_resource_path) {
        return Err(AttachmentError::UnsupportedAttachment);
    }
    let arguments = optional_non_empty_string(object.get("arguments"));
    Ok(PublicInputItem::Skill {
        name: name.map(str::to_owned),
        path: path.map(str::to_owned),
        arguments: arguments.map(str::to_owned),
    })
}

fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    let text = value?.as_str()?;
    if text.trim().is_empty() {
        return None;
    }
    Some(text)
}

fn optional_non_empty_string(value: Option<&Value>) -> Option<&str> {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text),
        _ => None,
    }
}

fn is_non_skill_resource_path(path: &str) -> bool {
    path.contains("://") && !path.starts_with("skill://")
}
