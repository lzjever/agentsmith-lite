use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{atomic::AtomicU64, Mutex};

use tokio_util::sync::CancellationToken;

use crate::provider::{Provider, ProviderMetadata};
use crate::types::Message;

pub(super) const MAX_HARD_COMPACT_FAILURES: usize = 3;
pub(super) const INPUT_TOO_LARGE_FOR_MODEL_WINDOW: &str = "input_too_large_for_model_window";
const COMPACT_DIAGNOSTIC_MAX_CHARS: usize = 512;

pub(super) struct CompactCoordinator {
    pub(super) slot: Mutex<CompactSlot>,
    terminal_local_recovery: Mutex<Option<TerminalLocalRecoveryKey>>,
    pub(super) next_run_id: AtomicU64,
}

impl Default for CompactCoordinator {
    fn default() -> Self {
        Self {
            slot: Mutex::new(CompactSlot::Idle {
                suppressed_start_len: None,
                last_successful_hard_key: None,
            }),
            terminal_local_recovery: Mutex::new(None),
            next_run_id: AtomicU64::new(1),
        }
    }
}

pub(super) enum CompactSlot {
    Idle {
        suppressed_start_len: Option<usize>,
        last_successful_hard_key: Option<HardCompactFailureKey>,
    },
    Running {
        run_id: u64,
        messages_at_start: Vec<Message>,
        retained_start: usize,
        start_len: usize,
        cancel: CancellationToken,
        hard_failure_key: Option<HardCompactFailureKey>,
        hard_failure_count_at_start: usize,
    },
    Completed {
        run_id: u64,
        messages_at_start: Vec<Message>,
        retained_start: usize,
        start_len: usize,
        summary_result: Result<String, String>,
        hard_failure_key: Option<HardCompactFailureKey>,
        hard_failure_count_at_start: usize,
    },
    Failed {
        reason: &'static str,
        diagnostic: String,
        suppressed_start_len: Option<usize>,
        hard_failure_key: Option<HardCompactFailureKey>,
        hard_failure_count: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HardCompactFailureKey {
    pub(super) provider_profile: String,
    pub(super) provider_name: Option<String>,
    pub(super) provider_model: Option<String>,
    pub(super) target_usable_tokens: usize,
    pub(super) retained_start: usize,
    pub(super) start_len: usize,
    pub(super) prefix_hash: u64,
}

#[derive(Debug, Clone)]
pub(super) struct HardCompactionContext {
    pub(super) failure_key: HardCompactFailureKey,
    pub(super) failure_count_at_start: usize,
    pub(super) target_usable_tokens: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TerminalLocalRecoveryKey {
    provider_profile: String,
    provider_name: Option<String>,
    provider_model: Option<String>,
    hard_stop_tokens: usize,
    transcript_hash: u64,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct DegradedLocalRecoveryContext<'a> {
    pub(super) provider_metadata: Option<&'a ProviderMetadata>,
    pub(super) reason: &'static str,
    pub(super) observed_request_tokens: usize,
    pub(super) target_usable_tokens: usize,
}

pub(super) fn terminal_local_recovery_key(
    messages: &[Message],
    metadata: Option<&ProviderMetadata>,
    hard_stop_tokens: usize,
) -> TerminalLocalRecoveryKey {
    TerminalLocalRecoveryKey {
        provider_profile: metadata
            .map(|metadata| metadata.profile.clone())
            .unwrap_or_else(|| "<unknown>".to_owned()),
        provider_name: metadata.and_then(|metadata| metadata.name.clone()),
        provider_model: metadata.and_then(|metadata| metadata.model.clone()),
        hard_stop_tokens,
        transcript_hash: compact_prefix_hash(messages),
    }
}

impl CompactCoordinator {
    pub(super) fn terminal_local_recovery_suppresses(
        &self,
        key: &TerminalLocalRecoveryKey,
    ) -> bool {
        let stored = self
            .terminal_local_recovery
            .lock()
            .expect("terminal local recovery mutex poisoned")
            .clone();
        stored.as_ref() == Some(key)
    }

    pub(super) fn suppress_terminal_local_recovery(&self, key: TerminalLocalRecoveryKey) {
        *self
            .terminal_local_recovery
            .lock()
            .expect("terminal local recovery mutex poisoned") = Some(key);
    }
}

pub(super) fn successful_hard_compaction_made_no_progress(
    slot: &CompactSlot,
    key: &HardCompactFailureKey,
) -> bool {
    matches!(
        slot,
        CompactSlot::Idle {
            last_successful_hard_key: Some(existing_key),
            ..
        } if existing_key == key
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CompactionStartOutcome {
    Started,
    Running,
    Completed,
    NotNeeded,
    RecoveryRequired { reason: &'static str },
}

pub(super) fn compact_prefix_hash(messages: &[Message]) -> u64 {
    let mut hasher = DefaultHasher::new();
    match serde_json::to_string(messages) {
        Ok(serialized) => serialized.hash(&mut hasher),
        Err(_) => format!("{messages:?}").hash(&mut hasher),
    }
    hasher.finish()
}

pub(super) fn remap_compacted_index(index: usize, retained_start: usize) -> usize {
    1 + index.saturating_sub(retained_start)
}

pub(super) fn bounded_compact_diagnostic(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.chars().count() <= COMPACT_DIAGNOSTIC_MAX_CHARS {
        return trimmed.to_owned();
    }
    trimmed.chars().take(COMPACT_DIAGNOSTIC_MAX_CHARS).collect()
}

pub(super) fn provider_compact_request_hard_stop_tokens(
    provider: &dyn Provider,
    request: &crate::provider::ProviderRequest,
) -> Option<usize> {
    provider
        .metadata_for_request(request)
        .as_ref()
        .map(crate::compact::CompactPolicy::from_provider_metadata)
        .map(|policy| policy.limits().hard_stop_tokens)
}

pub(super) fn retained_compaction_tail(messages: &[Message]) -> Vec<Message> {
    messages
        .iter()
        .cloned()
        .map(clear_compaction_retained_usage)
        .collect()
}

fn clear_compaction_retained_usage(message: Message) -> Message {
    match message {
        Message::ToolResult(result) => Message::ToolResult(result.bounded_for_transcript()),
        Message::Assistant {
            content,
            tool_calls,
            assistant_replay,
            stop_reason,
            ..
        } => Message::Assistant {
            content,
            tool_calls,
            assistant_replay,
            usage: None,
            stop_reason,
        },
        other => other,
    }
}
