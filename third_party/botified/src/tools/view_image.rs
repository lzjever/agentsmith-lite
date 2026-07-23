use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::attachments::MAX_IMAGE_BASE64_BYTES;
use crate::provider::{
    complete_with_cancellation, Provider, ProviderCompletionError, ProviderRequest,
};
use crate::types::{ContentPart, Message, ToolCall, ToolResult};

use super::{Tool, ToolError, ToolExecutionContext, ToolSpec};

const DEFAULT_QUESTION: &str = "Describe this image concisely.";
const MAX_RAW_IMAGE_BYTES: u64 = (MAX_IMAGE_BASE64_BYTES / 4 * 3) as u64;

#[derive(Clone)]
pub struct ViewImageTool {
    provider: Arc<dyn Provider>,
}

impl ViewImageTool {
    pub fn new(provider: Arc<dyn Provider>) -> Self {
        Self { provider }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewImageArguments {
    path: String,
    #[serde(default)]
    question: Option<String>,
}

#[async_trait]
impl Tool for ViewImageTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "view_image",
            "Inspect a local image file and answer a question about it.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Local path to a PNG, JPEG, WEBP, or GIF image. Relative paths resolve against the agent working directory."
                    },
                    "question": {
                        "type": "string",
                        "description": "Optional question to answer about the image."
                    }
                },
                "required": ["path"]
            }),
        )
    }

    async fn execute(
        &self,
        call: ToolCall,
        context: ToolExecutionContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult, ToolError> {
        let arguments: ViewImageArguments =
            serde_json::from_value(call.arguments).map_err(|error| {
                ToolError::execution_failed(format!("invalid view_image arguments: {error}"))
            })?;
        let resolved_path = resolve_path(&context.cwd, &arguments.path)?;
        let metadata = fs::metadata(&resolved_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ToolError::execution_failed(format!(
                    "view_image path not found: {}",
                    resolved_path.display()
                ))
            } else {
                ToolError::execution_failed(format!(
                    "failed to read view_image path {}: {error}",
                    resolved_path.display()
                ))
            }
        })?;
        if !metadata.is_file() {
            return Err(ToolError::execution_failed(format!(
                "view_image path is not a file: {}",
                resolved_path.display()
            )));
        }

        ensure_size_within_budget(metadata.len(), &resolved_path)?;
        let bytes = fs::read(&resolved_path).map_err(|error| {
            ToolError::execution_failed(format!(
                "failed to read view_image file {}: {error}",
                resolved_path.display()
            ))
        })?;
        ensure_size_within_budget(bytes.len() as u64, &resolved_path)?;
        let mime_type = mime_type_for_image(&resolved_path, &bytes)?;

        let image_data = STANDARD.encode(&bytes);
        if image_data.len() > MAX_IMAGE_BASE64_BYTES {
            return Err(too_large_error(bytes.len() as u64, &resolved_path));
        }

        let question = normalized_question(arguments.question);
        let request = ProviderRequest::new(
            "",
            vec![Message::user(vec![
                ContentPart::text(question.clone()),
                ContentPart::image_base64(mime_type, image_data),
            ])],
            Vec::new(),
        );
        let provider_result =
            complete_with_cancellation(self.provider.as_ref(), request, cancel.clone()).await;
        if cancel.is_cancelled() {
            return Err(ToolError::execution_failed(
                "view_image provider request cancelled",
            ));
        }
        let response = match provider_result {
            Ok(response) => response,
            Err(ProviderCompletionError::Provider(error)) => {
                return Err(ToolError::execution_failed(format!(
                    "view_image provider request failed: {error}"
                )))
            }
            Err(ProviderCompletionError::Cancelled) => {
                return Err(ToolError::execution_failed(
                    "view_image provider request cancelled",
                ));
            }
        };

        if !response.tool_calls.is_empty() {
            return Err(ToolError::execution_failed(
                "view_image provider returned tool calls instead of text",
            ));
        }
        let text = response
            .text
            .ok_or_else(|| ToolError::execution_failed("view_image provider returned no text"))?;
        if text.trim().is_empty() {
            return Err(ToolError::execution_failed(
                "view_image provider returned no text",
            ));
        }

        let mut result = ToolResult::success(call.id, call.name, text);
        result.details = json!({
            "path": resolved_path.display().to_string(),
            "mime_type": mime_type,
            "size_bytes": bytes.len(),
            "question": question
        });
        Ok(result)
    }
}

fn resolve_path(cwd: &str, path: &str) -> Result<PathBuf, ToolError> {
    if path.trim().is_empty() {
        return Err(ToolError::execution_failed(
            "view_image path must not be empty",
        ));
    }

    let path = Path::new(path);
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(Path::new(cwd).join(path))
    }
}

fn mime_type_for_image(path: &Path, bytes: &[u8]) -> Result<&'static str, ToolError> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Ok("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && bytes[8..12] == *b"WEBP" {
        return Ok("image/webp");
    }
    mime_type_for_path(path)
}

fn mime_type_for_path(path: &Path) -> Result<&'static str, ToolError> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            ToolError::execution_failed(format!(
                "unsupported view_image extension for {}",
                path.display()
            ))
        })?;

    match extension.as_str() {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        _ => Err(ToolError::execution_failed(format!(
            "unsupported view_image extension .{extension} for {}; expected png, jpg, jpeg, webp, or gif",
            path.display()
        ))),
    }
}

fn ensure_size_within_budget(size_bytes: u64, path: &Path) -> Result<(), ToolError> {
    if size_bytes == 0 {
        return Err(ToolError::execution_failed(format!(
            "view_image file is empty: {}",
            path.display()
        )));
    }
    if size_bytes > MAX_RAW_IMAGE_BYTES
        || encoded_base64_len(size_bytes) > MAX_IMAGE_BASE64_BYTES as u64
    {
        return Err(too_large_error(size_bytes, path));
    }
    Ok(())
}

fn encoded_base64_len(size_bytes: u64) -> u64 {
    size_bytes.div_ceil(3).saturating_mul(4)
}

fn too_large_error(size_bytes: u64, path: &Path) -> ToolError {
    ToolError::execution_failed(format!(
        "view_image file is too large: {} is {} bytes; base64 image budget is {} bytes",
        path.display(),
        size_bytes,
        MAX_IMAGE_BASE64_BYTES
    ))
}

fn normalized_question(question: Option<String>) -> String {
    question
        .as_deref()
        .map(str::trim)
        .filter(|question| !question.is_empty())
        .unwrap_or(DEFAULT_QUESTION)
        .to_owned()
}
