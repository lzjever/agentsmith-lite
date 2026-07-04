use std::collections::HashMap;

use thiserror::Error;

const DEFAULT_TAIL_LIMIT: usize = 16;
const MAX_QUEUED_MESSAGES_PER_SUBAGENT: usize = 128;
const RECENT_OWNED_TASK_IDS_LIMIT: usize = 64;
const RECENT_CALLBACKS_LIMIT: usize = 64;
const MAX_TAIL_TEXT_CHARS: usize = 8 * 1024;
const MAX_NAME_HINT_CHARS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubagentLimits {
    pub max_parallel: usize,
    pub max_branches: usize,
    pub tail_limit: usize,
}

impl SubagentLimits {
    pub fn new(max_parallel: usize, max_branches: usize) -> Self {
        Self {
            max_parallel,
            max_branches,
            tail_limit: DEFAULT_TAIL_LIMIT,
        }
    }

    pub fn with_tail_limit(mut self, tail_limit: usize) -> Self {
        self.tail_limit = tail_limit;
        self
    }
}

impl Default for SubagentLimits {
    fn default() -> Self {
        Self::new(3, 32)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentLifecycle {
    Open,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentRunState {
    Idle,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentTailKind {
    Sent,
    Queued,
    Result,
    Error,
    Cancelled,
    Task,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentCallbackStatus {
    Pending,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentTailEntry {
    pub kind: SubagentTailKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentCallbackSummary {
    pub callback_id: String,
    pub kind: String,
    pub status: SubagentCallbackStatus,
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentSnapshot {
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub lifecycle: SubagentLifecycle,
    pub run_state: SubagentRunState,
    pub latest_result: Option<String>,
    pub latest_error: Option<String>,
    pub queued_messages: Vec<String>,
    pub queued_message_count: usize,
    pub owned_task_ids: Vec<String>,
    pub owned_task_count: usize,
    pub owned_task_ids_omitted: usize,
    pub owned_task_ids_truncated: bool,
    pub callbacks: Vec<SubagentCallbackSummary>,
    pub callback_count: usize,
    pub pending_callback_count: usize,
    pub failed_callback_count: usize,
    pub callbacks_omitted: usize,
    pub callbacks_truncated: bool,
    pub tail: Vec<SubagentTailEntry>,
    pub tail_truncated: bool,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SubagentManagerError {
    #[error("subagent {field} must be greater than 0")]
    InvalidLimit { field: &'static str },
    #[error("subagent parallel limit exceeded: max_parallel={max_parallel}")]
    ParallelLimit { max_parallel: usize },
    #[error("subagent branch limit exceeded: max_branches={max_branches}")]
    BranchLimit { max_branches: usize },
    #[error("subagent queued message limit exceeded: max_queued_messages={max_queued_messages}")]
    QueueLimit { max_queued_messages: usize },
    #[error("subagent {id} not found")]
    NotFound { id: String },
    #[error("subagent {id} is cancelled")]
    Cancelled { id: String },
}

#[derive(Debug, Clone)]
pub struct SubagentManager {
    limits: SubagentLimits,
    branches: Vec<SubagentBranch>,
    next_id_suffix: u64,
}

impl SubagentManager {
    pub fn new(limits: SubagentLimits) -> Result<Self, SubagentManagerError> {
        validate_limit("max_parallel", limits.max_parallel)?;
        validate_limit("max_branches", limits.max_branches)?;
        validate_limit("tail_limit", limits.tail_limit)?;

        Ok(Self {
            limits,
            branches: Vec::new(),
            next_id_suffix: 1,
        })
    }

    pub fn open(
        &mut self,
        name_hint: impl AsRef<str>,
        purpose: impl Into<String>,
    ) -> Result<SubagentSnapshot, SubagentManagerError> {
        self.ensure_branch_capacity()?;

        let branch = SubagentBranch {
            id: self.next_id(),
            name: self.unique_name(name_hint.as_ref()),
            purpose: purpose.into(),
            lifecycle: SubagentLifecycle::Open,
            run_state: SubagentRunState::Idle,
            latest_result: None,
            latest_error: None,
            queued_messages: Vec::new(),
            owned_task_ids: Vec::new(),
            owned_task_count: 0,
            owned_task_ids_truncated: false,
            callbacks: Vec::new(),
            callback_count: 0,
            pending_callback_count: 0,
            failed_callback_count: 0,
            callbacks_truncated: false,
            pending_callbacks: HashMap::new(),
            tail: Vec::new(),
            tail_truncated: false,
        };
        let snapshot = branch.snapshot();
        self.branches.push(branch);
        Ok(snapshot)
    }

    pub fn spawn(
        &mut self,
        name_hint: impl AsRef<str>,
        task: impl Into<String>,
    ) -> Result<SubagentSnapshot, SubagentManagerError> {
        self.ensure_branch_capacity()?;
        self.ensure_parallel_capacity()?;

        let task = task.into();
        let mut branch = SubagentBranch {
            id: self.next_id(),
            name: self.unique_name(name_hint.as_ref()),
            purpose: task.clone(),
            lifecycle: SubagentLifecycle::Open,
            run_state: SubagentRunState::Running,
            latest_result: None,
            latest_error: None,
            queued_messages: Vec::new(),
            owned_task_ids: Vec::new(),
            owned_task_count: 0,
            owned_task_ids_truncated: false,
            callbacks: Vec::new(),
            callback_count: 0,
            pending_callback_count: 0,
            failed_callback_count: 0,
            callbacks_truncated: false,
            pending_callbacks: HashMap::new(),
            tail: Vec::new(),
            tail_truncated: false,
        };
        branch.push_tail(SubagentTailKind::Sent, task, self.limits.tail_limit);
        let snapshot = branch.snapshot();
        self.branches.push(branch);
        Ok(snapshot)
    }

    pub fn send(
        &mut self,
        id: &str,
        message: impl Into<String>,
    ) -> Result<SubagentSnapshot, SubagentManagerError> {
        let index = self.branch_index(id)?;
        self.ensure_open(index)?;

        let message = bounded_text(&message.into());
        if self.branches[index].run_state == SubagentRunState::Running {
            let branch = &mut self.branches[index];
            if branch.queued_messages.len() >= MAX_QUEUED_MESSAGES_PER_SUBAGENT {
                return Err(SubagentManagerError::QueueLimit {
                    max_queued_messages: MAX_QUEUED_MESSAGES_PER_SUBAGENT,
                });
            }
            branch.queued_messages.push(message.clone());
            branch.push_tail(SubagentTailKind::Queued, message, self.limits.tail_limit);
            return Ok(branch.snapshot());
        }

        self.ensure_parallel_capacity()?;
        let branch = &mut self.branches[index];
        branch.run_state = SubagentRunState::Running;
        branch.push_tail(SubagentTailKind::Sent, message, self.limits.tail_limit);
        Ok(branch.snapshot())
    }

    pub fn start_next_queued(
        &mut self,
        id: &str,
    ) -> Result<Option<(SubagentSnapshot, String)>, SubagentManagerError> {
        let index = self.branch_index(id)?;
        self.ensure_open(index)?;
        if self.branches[index].queued_messages.is_empty() {
            return Ok(None);
        }

        self.ensure_parallel_capacity()?;
        let message = self.branches[index].queued_messages.remove(0);
        let branch = &mut self.branches[index];
        branch.run_state = SubagentRunState::Running;
        branch.push_tail(
            SubagentTailKind::Sent,
            message.clone(),
            self.limits.tail_limit,
        );
        Ok(Some((branch.snapshot(), message)))
    }

    pub fn complete(
        &mut self,
        id: &str,
        result: impl Into<String>,
    ) -> Result<SubagentSnapshot, SubagentManagerError> {
        let index = self.branch_index(id)?;
        self.ensure_open(index)?;

        let result = bounded_text(&result.into());
        let branch = &mut self.branches[index];
        branch.run_state = SubagentRunState::Completed;
        branch.latest_result = Some(result.clone());
        branch.latest_error = None;
        branch.push_tail(SubagentTailKind::Result, result, self.limits.tail_limit);
        Ok(branch.snapshot())
    }

    pub fn fail(
        &mut self,
        id: &str,
        error: impl Into<String>,
    ) -> Result<SubagentSnapshot, SubagentManagerError> {
        let index = self.branch_index(id)?;
        self.ensure_open(index)?;

        let error = bounded_text(&error.into());
        let branch = &mut self.branches[index];
        branch.run_state = SubagentRunState::Failed;
        branch.latest_result = None;
        branch.latest_error = Some(error.clone());
        branch.push_tail(SubagentTailKind::Error, error, self.limits.tail_limit);
        Ok(branch.snapshot())
    }

    pub fn cancel(&mut self, id: &str) -> Result<SubagentSnapshot, SubagentManagerError> {
        let index = self.branch_index(id)?;
        if self.branches[index].lifecycle == SubagentLifecycle::Cancelled {
            return Ok(self.branches[index].snapshot());
        }

        let snapshot = {
            let branch = &mut self.branches[index];
            branch.lifecycle = SubagentLifecycle::Cancelled;
            branch.run_state = SubagentRunState::Idle;
            branch.queued_messages.clear();
            branch.push_tail(
                SubagentTailKind::Cancelled,
                "cancelled",
                self.limits.tail_limit,
            );
            branch.snapshot()
        };
        let branch = self.branches.remove(index);
        self.branches.push(branch);
        self.prune_cancelled_branches();
        Ok(snapshot)
    }

    pub fn add_owned_task_id(
        &mut self,
        id: &str,
        task_id: impl Into<String>,
    ) -> Result<SubagentSnapshot, SubagentManagerError> {
        let index = self.branch_index(id)?;
        self.ensure_open(index)?;

        let task_id = task_id.into();
        let branch = &mut self.branches[index];
        if !branch.owned_task_ids.contains(&task_id) {
            branch.owned_task_count += 1;
            push_recent(
                &mut branch.owned_task_ids,
                task_id.clone(),
                RECENT_OWNED_TASK_IDS_LIMIT,
                &mut branch.owned_task_ids_truncated,
            );
            branch.push_tail(SubagentTailKind::Task, task_id, self.limits.tail_limit);
        }
        Ok(branch.snapshot())
    }

    pub fn record_callback(
        &mut self,
        id: &str,
        callback_id: impl Into<String>,
        kind: impl Into<String>,
        status: SubagentCallbackStatus,
        failure_reason: Option<String>,
    ) -> Result<SubagentSnapshot, SubagentManagerError> {
        let index = self.branch_index(id)?;
        self.ensure_open(index)?;
        let callback_id = callback_id.into();
        let kind = kind.into();
        let branch = &mut self.branches[index];
        let old_status = branch.callback_status_for_update(&callback_id);
        branch.apply_callback_status_change(old_status, status, &callback_id, &kind);
        branch.push_callback_summary(SubagentCallbackSummary {
            callback_id,
            kind,
            status,
            failure_reason,
        });
        Ok(branch.snapshot())
    }

    pub fn rollback_pending_callback(
        &mut self,
        id: &str,
        callback_id: &str,
    ) -> Result<SubagentSnapshot, SubagentManagerError> {
        let index = self.branch_index(id)?;
        self.ensure_open(index)?;
        let branch = &mut self.branches[index];
        if branch.pending_callbacks.remove(callback_id).is_some() {
            branch.pending_callback_count = branch.pending_callback_count.saturating_sub(1);
            branch.callback_count = branch.callback_count.saturating_sub(1);
        }
        if let Some(index) = branch.callbacks.iter().rposition(|callback| {
            callback.callback_id == callback_id
                && callback.status == SubagentCallbackStatus::Pending
        }) {
            branch.callbacks.remove(index);
        }
        Ok(branch.snapshot())
    }

    pub fn mark_callback_delivered(&mut self, callback_id: &str) -> Option<SubagentSnapshot> {
        let branch = self.branches.iter_mut().find(|branch| {
            branch
                .callbacks
                .iter()
                .any(|callback| callback.callback_id == callback_id)
                || branch.pending_callbacks.contains_key(callback_id)
        })?;
        let retained = branch
            .callbacks
            .iter()
            .find(|callback| callback.callback_id == callback_id)
            .cloned();
        let old_status = retained
            .as_ref()
            .map(|callback| callback.status)
            .or_else(|| {
                branch
                    .pending_callbacks
                    .contains_key(callback_id)
                    .then_some(SubagentCallbackStatus::Pending)
            })?;
        let kind = retained
            .as_ref()
            .map(|callback| callback.kind.clone())
            .or_else(|| branch.pending_callbacks.get(callback_id).cloned())
            .unwrap_or_default();
        branch.apply_callback_status_change(
            Some(old_status),
            SubagentCallbackStatus::Delivered,
            callback_id,
            &kind,
        );
        branch.push_callback_summary(SubagentCallbackSummary {
            callback_id: callback_id.to_owned(),
            kind,
            status: SubagentCallbackStatus::Delivered,
            failure_reason: None,
        });
        Some(branch.snapshot())
    }

    pub(crate) fn callback_delivered_snapshot(
        &self,
        callback_id: &str,
    ) -> Option<SubagentSnapshot> {
        let branch = self.branches.iter().find(|branch| {
            branch
                .callbacks
                .iter()
                .any(|callback| callback.callback_id == callback_id)
                || branch.pending_callbacks.contains_key(callback_id)
        })?;
        let mut preview = branch.clone();
        let retained = preview
            .callbacks
            .iter()
            .find(|callback| callback.callback_id == callback_id)
            .cloned();
        let old_status = retained
            .as_ref()
            .map(|callback| callback.status)
            .or_else(|| {
                preview
                    .pending_callbacks
                    .contains_key(callback_id)
                    .then_some(SubagentCallbackStatus::Pending)
            })?;
        let kind = retained
            .as_ref()
            .map(|callback| callback.kind.clone())
            .or_else(|| preview.pending_callbacks.get(callback_id).cloned())
            .unwrap_or_default();
        preview.apply_callback_status_change(
            Some(old_status),
            SubagentCallbackStatus::Delivered,
            callback_id,
            &kind,
        );
        preview.push_callback_summary(SubagentCallbackSummary {
            callback_id: callback_id.to_owned(),
            kind,
            status: SubagentCallbackStatus::Delivered,
            failure_reason: None,
        });
        Some(preview.snapshot())
    }

    pub fn snapshot(&self, id: &str) -> Option<SubagentSnapshot> {
        self.branches
            .iter()
            .find(|branch| branch.id == id)
            .map(SubagentBranch::snapshot)
    }

    pub fn list(&self) -> Vec<SubagentSnapshot> {
        self.branches.iter().map(SubagentBranch::snapshot).collect()
    }

    pub fn running_count(&self) -> usize {
        self.branches
            .iter()
            .filter(|branch| {
                branch.lifecycle == SubagentLifecycle::Open
                    && branch.run_state == SubagentRunState::Running
            })
            .count()
    }

    pub fn open_count(&self) -> usize {
        self.branches
            .iter()
            .filter(|branch| branch.lifecycle == SubagentLifecycle::Open)
            .count()
    }

    fn next_id(&mut self) -> String {
        let id = format!("sa_{:06x}", self.next_id_suffix);
        self.next_id_suffix += 1;
        id
    }

    fn branch_index(&self, id: &str) -> Result<usize, SubagentManagerError> {
        self.branches
            .iter()
            .position(|branch| branch.id == id)
            .ok_or_else(|| SubagentManagerError::NotFound { id: id.to_owned() })
    }

    fn ensure_open(&self, index: usize) -> Result<(), SubagentManagerError> {
        let branch = &self.branches[index];
        if branch.lifecycle == SubagentLifecycle::Cancelled {
            Err(SubagentManagerError::Cancelled {
                id: branch.id.clone(),
            })
        } else {
            Ok(())
        }
    }

    fn ensure_parallel_capacity(&self) -> Result<(), SubagentManagerError> {
        if self.running_count() >= self.limits.max_parallel {
            Err(SubagentManagerError::ParallelLimit {
                max_parallel: self.limits.max_parallel,
            })
        } else {
            Ok(())
        }
    }

    fn ensure_branch_capacity(&self) -> Result<(), SubagentManagerError> {
        if self.open_count() >= self.limits.max_branches {
            Err(SubagentManagerError::BranchLimit {
                max_branches: self.limits.max_branches,
            })
        } else {
            Ok(())
        }
    }

    fn prune_cancelled_branches(&mut self) {
        while self.cancelled_count() > self.limits.max_branches {
            let Some(index) = self
                .branches
                .iter()
                .position(|branch| branch.lifecycle == SubagentLifecycle::Cancelled)
            else {
                return;
            };
            self.branches.remove(index);
        }
    }

    fn cancelled_count(&self) -> usize {
        self.branches
            .iter()
            .filter(|branch| branch.lifecycle == SubagentLifecycle::Cancelled)
            .count()
    }

    fn unique_name(&self, name_hint: &str) -> String {
        let base = normalized_name_hint(name_hint);
        if self.branches.iter().all(|branch| branch.name != base) {
            return base;
        }

        for suffix in 2.. {
            let suffix = format!(" {suffix}");
            let candidate = format!(
                "{}{}",
                bounded_name_base_for_suffix(&base, suffix.chars().count()),
                suffix
            );
            if self.branches.iter().all(|branch| branch.name != candidate) {
                return candidate;
            }
        }

        unreachable!("unbounded suffix search must find a unique name")
    }
}

impl Default for SubagentManager {
    fn default() -> Self {
        Self::new(SubagentLimits::default()).expect("default subagent limits are valid")
    }
}

#[derive(Debug, Clone)]
struct SubagentBranch {
    id: String,
    name: String,
    purpose: String,
    lifecycle: SubagentLifecycle,
    run_state: SubagentRunState,
    latest_result: Option<String>,
    latest_error: Option<String>,
    queued_messages: Vec<String>,
    owned_task_ids: Vec<String>,
    owned_task_count: usize,
    owned_task_ids_truncated: bool,
    callbacks: Vec<SubagentCallbackSummary>,
    callback_count: usize,
    pending_callback_count: usize,
    failed_callback_count: usize,
    callbacks_truncated: bool,
    pending_callbacks: HashMap<String, String>,
    tail: Vec<SubagentTailEntry>,
    tail_truncated: bool,
}

impl SubagentBranch {
    fn snapshot(&self) -> SubagentSnapshot {
        SubagentSnapshot {
            id: self.id.clone(),
            name: self.name.clone(),
            purpose: self.purpose.clone(),
            lifecycle: self.lifecycle,
            run_state: self.run_state,
            latest_result: self.latest_result.clone(),
            latest_error: self.latest_error.clone(),
            queued_messages: self.queued_messages.clone(),
            queued_message_count: self.queued_messages.len(),
            owned_task_ids: self.owned_task_ids.clone(),
            owned_task_count: self.owned_task_count,
            owned_task_ids_omitted: self
                .owned_task_count
                .saturating_sub(self.owned_task_ids.len()),
            owned_task_ids_truncated: self.owned_task_ids_truncated,
            callbacks: self.callbacks.clone(),
            callback_count: self.callback_count,
            pending_callback_count: self.pending_callback_count,
            failed_callback_count: self.failed_callback_count,
            callbacks_omitted: self.callback_count.saturating_sub(self.callbacks.len()),
            callbacks_truncated: self.callbacks_truncated,
            tail: self.tail.clone(),
            tail_truncated: self.tail_truncated,
        }
    }

    fn push_tail(&mut self, kind: SubagentTailKind, text: impl Into<String>, tail_limit: usize) {
        while self.tail.len() >= tail_limit {
            self.tail.remove(0);
            self.tail_truncated = true;
        }
        self.tail.push(SubagentTailEntry {
            kind,
            text: bounded_text(&text.into()),
        });
    }

    fn callback_status_for_update(&self, callback_id: &str) -> Option<SubagentCallbackStatus> {
        self.callbacks
            .iter()
            .find(|callback| callback.callback_id == callback_id)
            .map(|callback| callback.status)
            .or_else(|| {
                self.pending_callbacks
                    .contains_key(callback_id)
                    .then_some(SubagentCallbackStatus::Pending)
            })
    }

    fn apply_callback_status_change(
        &mut self,
        old_status: Option<SubagentCallbackStatus>,
        new_status: SubagentCallbackStatus,
        callback_id: &str,
        kind: &str,
    ) {
        if old_status.is_none() {
            self.callback_count += 1;
        }
        if old_status == Some(new_status) {
            if new_status == SubagentCallbackStatus::Pending {
                self.pending_callbacks
                    .insert(callback_id.to_owned(), kind.to_owned());
            }
            return;
        }

        match old_status {
            Some(SubagentCallbackStatus::Pending) => {
                self.pending_callback_count = self.pending_callback_count.saturating_sub(1);
                self.pending_callbacks.remove(callback_id);
            }
            Some(SubagentCallbackStatus::Failed) => {
                self.failed_callback_count = self.failed_callback_count.saturating_sub(1);
            }
            Some(SubagentCallbackStatus::Delivered) | None => {}
        }

        match new_status {
            SubagentCallbackStatus::Pending => {
                self.pending_callback_count += 1;
                self.pending_callbacks
                    .insert(callback_id.to_owned(), kind.to_owned());
            }
            SubagentCallbackStatus::Failed => {
                self.failed_callback_count += 1;
                self.pending_callbacks.remove(callback_id);
            }
            SubagentCallbackStatus::Delivered => {
                self.pending_callbacks.remove(callback_id);
            }
        }
    }

    fn push_callback_summary(&mut self, summary: SubagentCallbackSummary) {
        if let Some(index) = self
            .callbacks
            .iter()
            .position(|callback| callback.callback_id == summary.callback_id)
        {
            self.callbacks.remove(index);
        }
        push_recent(
            &mut self.callbacks,
            summary,
            RECENT_CALLBACKS_LIMIT,
            &mut self.callbacks_truncated,
        );
    }
}

fn push_recent<T>(values: &mut Vec<T>, value: T, limit: usize, truncated: &mut bool) {
    while values.len() >= limit {
        values.remove(0);
        *truncated = true;
    }
    values.push(value);
}

fn validate_limit(field: &'static str, value: usize) -> Result<(), SubagentManagerError> {
    if value == 0 {
        Err(SubagentManagerError::InvalidLimit { field })
    } else {
        Ok(())
    }
}

fn normalized_name_hint(name_hint: &str) -> String {
    let normalized = name_hint.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = if normalized.is_empty() {
        "Subagent".to_owned()
    } else {
        normalized
    };
    bounded_name(&name, MAX_NAME_HINT_CHARS)
}

fn bounded_name_base_for_suffix(base: &str, suffix_chars: usize) -> String {
    bounded_name(base, MAX_NAME_HINT_CHARS.saturating_sub(suffix_chars))
        .trim_end()
        .to_owned()
}

fn bounded_name(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn bounded_text(value: &str) -> String {
    value.chars().take(MAX_TAIL_TEXT_CHARS).collect()
}
