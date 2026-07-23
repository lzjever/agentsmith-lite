mod admission;
mod bootstrap;
mod callback;
mod cancellation;
mod context;
mod events;
mod launch;
mod queries;
mod run;
mod send;
mod spawn;
mod terminal;
#[cfg(test)]
mod test_hooks;
mod tool_results;
mod worker;

use launch::PreparedSubagentRun;
use run::run_subagent_loop_with_snapshot;
pub(super) use run::terminalize_failed_subagent_run_for_current;
#[cfg(test)]
pub(super) use run::{
    maybe_start_next_subagent_run, run_subagent_loop, terminalize_failed_subagent_run,
};
#[cfg(test)]
pub(super) use test_hooks::{SubagentTestHookKind, SubagentTestHooks};
use tool_results::{
    subagent_manager_error_tool_result, subagent_start_persistence_error_tool_result,
    subagent_tool_success_result,
};
#[cfg(test)]
pub(super) use worker::spawn_subagent_loop;

pub(super) use callback::{
    enqueue_subagent_callback, enqueue_subagent_text_callback, new_subagent_callback_epoch,
    valid_subagent_callback_metadata,
};
#[cfg(test)]
pub(super) use callback::{
    enqueue_subagent_callback_input, rollback_enqueued_subagent_callback, SubagentCallbackFacts,
};

pub(super) use events::SubagentEventAppendOutcome;
