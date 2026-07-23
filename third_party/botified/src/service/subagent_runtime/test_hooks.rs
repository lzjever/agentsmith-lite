use std::sync::{Arc, Mutex};

use super::super::ServiceInner;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::service) enum SubagentTestHookKind {
    TerminalBeforeContextStore,
    TerminalStateBeforeAppend,
    SubagentPublishOpenCheck,
    BackgroundTaskPublishBeforeAppend,
    QueuedRunProviderClone,
    QueuedRunStateBeforeAppend,
    StartAdmission,
    CallbackEnqueueBeforeRecord,
    CallbackOutcomeBeforeLifecycle,
    CallbackRecordBeforeAppend,
}

type SubagentTestHook = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
pub(in crate::service) struct SubagentTestHooks {
    after_terminal_before_context_store: Mutex<Option<SubagentTestHook>>,
    after_terminal_state_before_append: Mutex<Option<SubagentTestHook>>,
    after_subagent_publish_open_check: Mutex<Option<SubagentTestHook>>,
    before_background_task_publish_append: Mutex<Option<SubagentTestHook>>,
    after_queued_run_provider_clone: Mutex<Option<SubagentTestHook>>,
    after_queued_run_state_before_append: Mutex<Option<SubagentTestHook>>,
    before_start_admission: Mutex<Option<SubagentTestHook>>,
    after_callback_enqueue_before_record: Mutex<Option<SubagentTestHook>>,
    after_callback_outcome_before_lifecycle: Mutex<Option<SubagentTestHook>>,
    after_callback_record_before_append: Mutex<Option<SubagentTestHook>>,
}

impl SubagentTestHooks {
    fn set(&self, kind: SubagentTestHookKind, hook: SubagentTestHook) {
        let slot = match kind {
            SubagentTestHookKind::TerminalBeforeContextStore => {
                &self.after_terminal_before_context_store
            }
            SubagentTestHookKind::TerminalStateBeforeAppend => {
                &self.after_terminal_state_before_append
            }
            SubagentTestHookKind::SubagentPublishOpenCheck => {
                &self.after_subagent_publish_open_check
            }
            SubagentTestHookKind::BackgroundTaskPublishBeforeAppend => {
                &self.before_background_task_publish_append
            }
            SubagentTestHookKind::QueuedRunProviderClone => &self.after_queued_run_provider_clone,
            SubagentTestHookKind::QueuedRunStateBeforeAppend => {
                &self.after_queued_run_state_before_append
            }
            SubagentTestHookKind::StartAdmission => &self.before_start_admission,
            SubagentTestHookKind::CallbackEnqueueBeforeRecord => {
                &self.after_callback_enqueue_before_record
            }
            SubagentTestHookKind::CallbackOutcomeBeforeLifecycle => {
                &self.after_callback_outcome_before_lifecycle
            }
            SubagentTestHookKind::CallbackRecordBeforeAppend => {
                &self.after_callback_record_before_append
            }
        };
        *slot.lock().expect("subagent test hook mutex poisoned") = Some(hook);
    }

    fn run(&self, kind: SubagentTestHookKind) {
        let hook = {
            let slot = match kind {
                SubagentTestHookKind::TerminalBeforeContextStore => {
                    &self.after_terminal_before_context_store
                }
                SubagentTestHookKind::TerminalStateBeforeAppend => {
                    &self.after_terminal_state_before_append
                }
                SubagentTestHookKind::SubagentPublishOpenCheck => {
                    &self.after_subagent_publish_open_check
                }
                SubagentTestHookKind::BackgroundTaskPublishBeforeAppend => {
                    &self.before_background_task_publish_append
                }
                SubagentTestHookKind::QueuedRunProviderClone => {
                    &self.after_queued_run_provider_clone
                }
                SubagentTestHookKind::QueuedRunStateBeforeAppend => {
                    &self.after_queued_run_state_before_append
                }
                SubagentTestHookKind::StartAdmission => &self.before_start_admission,
                SubagentTestHookKind::CallbackEnqueueBeforeRecord => {
                    &self.after_callback_enqueue_before_record
                }
                SubagentTestHookKind::CallbackOutcomeBeforeLifecycle => {
                    &self.after_callback_outcome_before_lifecycle
                }
                SubagentTestHookKind::CallbackRecordBeforeAppend => {
                    &self.after_callback_record_before_append
                }
            };
            slot.lock()
                .expect("subagent test hook mutex poisoned")
                .clone()
        };
        if let Some(hook) = hook {
            hook();
        }
    }
}

impl ServiceInner {
    pub(in crate::service) fn set_subagent_test_hook(
        &self,
        kind: SubagentTestHookKind,
        hook: SubagentTestHook,
    ) {
        self.subagent_test_hooks.set(kind, hook);
    }

    pub(in crate::service) fn run_subagent_test_hook(&self, kind: SubagentTestHookKind) {
        self.subagent_test_hooks.run(kind);
    }
}
