use crate::files::{FileRecord, FileStore};
use crate::types::{ContentPart, Message, MessageFileBinding};

const FILE_MANIFEST_MAX_CHARS: usize = 4 * 1024;
const FIELD_MAX_CHARS: usize = 1024;

pub fn render_messages_for_provider(messages: &[Message]) -> Vec<Message> {
    render_messages_for_provider_with_file_store(messages, None)
}

pub fn render_messages_for_provider_with_file_store(
    messages: &[Message],
    file_store: Option<&FileStore>,
) -> Vec<Message> {
    messages
        .iter()
        .cloned()
        .map(|message| render_message_for_provider(message, file_store))
        .collect()
}

pub fn render_content_part_for_text(part: &ContentPart) -> String {
    render_content_part_for_text_with_file_store(part, None)
}

pub fn render_content_part_for_text_with_file_store(
    part: &ContentPart,
    file_store: Option<&FileStore>,
) -> String {
    match part {
        ContentPart::Text { text } => text.clone(),
        ContentPart::ImageUrl { .. } => "[image url omitted]".to_owned(),
        ContentPart::ImageBase64 { mime_type, .. } => {
            format!("[image base64 omitted: {mime_type}]")
        }
        ContentPart::File { binding } => render_file_manifest_with_file_store(binding, file_store),
        ContentPart::Skill {
            name,
            path,
            arguments,
        } => format!(
            "[skill invocation omitted: name={}, path={}, arguments={}]",
            name.as_deref().unwrap_or(""),
            path.as_deref().unwrap_or(""),
            arguments.as_deref().unwrap_or("")
        ),
    }
}

pub fn render_file_manifest(binding: &MessageFileBinding) -> String {
    render_file_manifest_from_binding(binding)
}

pub fn render_file_manifest_with_file_store(
    binding: &MessageFileBinding,
    file_store: Option<&FileStore>,
) -> String {
    let Some(file_store) = file_store else {
        return render_file_manifest_from_binding(binding);
    };

    let binding = match file_store.metadata(&binding.file_id) {
        Ok(record) => binding_from_current_record(binding, record),
        Err(error) => {
            let mut binding = binding.clone();
            binding.available = false;
            binding.unavailable_reason = Some(error.code().to_owned());
            binding.agent_path = None;
            binding
        }
    };
    render_file_manifest_from_binding(&binding)
}

fn render_file_manifest_from_binding(binding: &MessageFileBinding) -> String {
    let mut manifest = String::new();
    manifest.push_str("Attached file manifest:\n");
    push_field(&mut manifest, "message_id", &binding.message_id);
    push_field(&mut manifest, "input_id", &binding.input_id);
    push_field(
        &mut manifest,
        "content_index",
        &binding.content_index.to_string(),
    );
    push_field(&mut manifest, "file_id", &binding.file_id);
    push_field(&mut manifest, "filename", &binding.filename);
    push_field(&mut manifest, "mime_type", &binding.mime_type);
    push_field(&mut manifest, "size_bytes", &binding.size_bytes.to_string());
    push_field(&mut manifest, "sha256", &binding.sha256);
    push_field(&mut manifest, "source", binding.source.as_str());
    push_field(
        &mut manifest,
        "available",
        if binding.available { "true" } else { "false" },
    );
    if let Some(reason) = binding.unavailable_reason.as_deref() {
        push_field(&mut manifest, "unavailable_reason", reason);
    }
    if binding.available {
        if let Some(agent_path) = binding.agent_path.as_deref() {
            push_field(&mut manifest, "agent_path", agent_path);
        }
    }
    if let Some(description) = binding.description.as_deref() {
        push_field(&mut manifest, "description", description);
    }
    manifest.push('\n');
    manifest.push_str("Content has not been read. Use tools to inspect this file only if the user explicitly asks or the task requires it.");
    truncate_chars(&manifest, FILE_MANIFEST_MAX_CHARS)
}

fn binding_from_current_record(
    binding: &MessageFileBinding,
    record: FileRecord,
) -> MessageFileBinding {
    MessageFileBinding {
        message_id: binding.message_id.clone(),
        input_id: binding.input_id.clone(),
        content_index: binding.content_index,
        file_id: record.file_id,
        filename: record.filename,
        mime_type: record.mime_type,
        size_bytes: record.size_bytes,
        sha256: record.sha256,
        source: record.source,
        description: record.description,
        agent_path: Some(record.agent_path.display().to_string()),
        available: true,
        unavailable_reason: None,
    }
}

fn render_message_for_provider(message: Message, file_store: Option<&FileStore>) -> Message {
    match message {
        Message::User { content } => Message::user(
            content
                .into_iter()
                .map(|part| render_content_part_for_provider(part, file_store))
                .collect(),
        ),
        Message::Assistant {
            content,
            tool_calls,
            assistant_replay,
            usage,
            stop_reason,
        } => Message::Assistant {
            content,
            tool_calls,
            assistant_replay,
            usage,
            stop_reason,
        },
        Message::ToolResult(result) => Message::ToolResult(result),
    }
}

fn render_content_part_for_provider(
    part: ContentPart,
    file_store: Option<&FileStore>,
) -> ContentPart {
    match part {
        ContentPart::File { binding } => {
            ContentPart::text(render_file_manifest_with_file_store(&binding, file_store))
        }
        other => other,
    }
}

fn push_field(manifest: &mut String, name: &str, value: &str) {
    manifest.push_str("- ");
    manifest.push_str(name);
    manifest.push_str(": ");
    manifest.push_str(&truncate_chars(value, FIELD_MAX_CHARS));
    manifest.push('\n');
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_owned();
    }
    if max_chars <= 32 {
        return value.chars().take(max_chars).collect();
    }
    let truncated = value.chars().take(max_chars - 32).collect::<String>();
    format!("{truncated}\n[manifest truncated]")
}
