use super::compaction_runtime::{
    spawn_compaction_provider_call, PendingRecoveryRecordKind,
    ACTIVE_REQUEST_RECOVERY_APPEND_FAILED, ACTIVE_REQUEST_TOO_LARGE_FOR_MODEL_WINDOW,
    REJECTED_INPUT_APPEND_FAILED,
};
use super::compaction_shared::{
    successful_hard_compaction_made_no_progress, terminal_local_recovery_key, CompactSlot,
    HardCompactFailureKey, INPUT_TOO_LARGE_FOR_MODEL_WINDOW, MAX_HARD_COMPACT_FAILURES,
};
use super::subagent_compaction::SubagentCompactionHook;
use super::subagent_projection::add_subagent_callback_identity;
use super::task_runtime::{callback_text, project_task_callback_delivery, task_request_input_id};
use super::*;

use crate::files::FileStoreOptions;
use crate::profiling::{resolve_profiling_config, CsvProfiler};
use crate::provider::{ProviderError, ProviderRequest, ProviderResponse};
use crate::session::{open_or_create_session_in_home_with_cwd, SessionFileIo};
use crate::tasks::TaskOutputSnapshot;
use crate::timeline::TimelineItem;
use crate::types::{StopReason, Usage};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Condvar;
use tokio::sync::oneshot;

include!("tests/support_core.rs");
include!("tests/bootstrap_callback_surface.rs");
include!("tests/subagent_lifecycle_tools.rs");
include!("tests/subagent_lifecycle_tools_continued.rs");
include!("tests/support_task_runtime.rs");
include!("tests/provider_panics.rs");
include!("tests/provider_cancellation.rs");
include!("tests/support_compaction_runtime.rs");
include!("tests/compaction_hard_gate.rs");
include!("tests/compaction_replay_tool_results.rs");
include!("tests/active_request_recovery.rs");
include!("tests/compaction_commit_retry.rs");
include!("tests/support_input_queue.rs");
include!("tests/input_queue_callback_commit.rs");
include!("tests/commit_sync_projection_retry.rs");
include!("tests/event_commit_ordering.rs");
include!("tests/read_side_phase_b.rs");
include!("tests/durable_input_replay.rs");
include!("tests/background_publish_callbacks.rs");
include!("tests/task_stdio_frames.rs");
include!("tests/task_frame_lanes.rs");
include!("tests/task_input_lane_lifecycle.rs");
include!("tests/observer_cancel_races.rs");
include!("tests/observer_delivery.rs");
include!("tests/registry_stdio.rs");
include!("tests/task_request_effects.rs");
include!("tests/support_public_replay.rs");
include!("tests/public_replay_cursor.rs");
