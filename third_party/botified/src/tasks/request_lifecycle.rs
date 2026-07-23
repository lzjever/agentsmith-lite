use std::time::{Duration, SystemTime};

use crate::agent_loop::InputUrgency;
use crate::formatting::bounded_chars;

use super::{
    task_exception_frame, task_response_frame, task_send_frame, task_work_display,
    validate_task_stdin_frame, BackgroundTaskManager, TaskOwner, TaskRecord, TaskRequestFrame,
    TaskRequestSnapshot, TaskRequestState, TaskStdinFrameKind, TASK_REQUEST_DIAGNOSTIC_CHARS,
    TASK_STDIN_FRAME_SAFETY_CEILING,
};

const DEFAULT_MAX_PENDING_REQUESTS_PER_TASK: usize = 16;
const DEFAULT_MAX_PENDING_REQUESTS_GLOBAL: usize = 64;
const TASK_REQUEST_ARGUMENT_SUMMARY_CHARS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskRequestAdmission {
    Accepted(TaskRequestSnapshot),
    Duplicate(TaskRequestSnapshot),
    Rejected(TaskRequestSnapshot),
    TaskMissing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskReplyStatus {
    Written,
    Failed,
    UnknownTask,
    UnknownRequest,
    AlreadyResolved,
    Expired,
    TaskTerminal,
    ResponseTooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskStdinIntentKind {
    Response,
    Exception { code: &'static str },
    Send,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskStdinIntent {
    pub task_id: String,
    pub request_id: String,
    pub frame: String,
    pub kind: TaskStdinIntentKind,
}

impl TaskStdinIntent {
    pub fn response(task_id: &str, request_id: &str, response: &str) -> Self {
        Self {
            task_id: task_id.to_owned(),
            request_id: request_id.to_owned(),
            frame: task_response_frame(request_id, response, false),
            kind: TaskStdinIntentKind::Response,
        }
    }

    pub fn exception(task_id: &str, request_id: &str, code: &'static str, message: &str) -> Self {
        Self {
            task_id: task_id.to_owned(),
            request_id: request_id.to_owned(),
            frame: task_exception_frame(request_id, code, message),
            kind: TaskStdinIntentKind::Exception { code },
        }
    }

    pub fn send(task_id: &str, send_id: &str, message: &str) -> Self {
        Self {
            task_id: task_id.to_owned(),
            request_id: send_id.to_owned(),
            frame: task_send_frame(send_id, message),
            kind: TaskStdinIntentKind::Send,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskReplyPlan {
    ReadyToWrite {
        snapshot: TaskRequestSnapshot,
        stdin_intents: Vec<TaskStdinIntent>,
    },
    Finished(TaskReplyOutcome),
}

impl TaskReplyPlan {
    fn ready(snapshot: TaskRequestSnapshot, intent: TaskStdinIntent) -> Self {
        Self::ReadyToWrite {
            snapshot,
            stdin_intents: vec![intent],
        }
    }

    fn finished(outcome: TaskReplyOutcome) -> Self {
        Self::Finished(outcome)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskReplyOutcome {
    pub status: TaskReplyStatus,
    pub snapshot: Option<TaskRequestSnapshot>,
    pub task_id: Option<String>,
    pub request_id: Option<String>,
    pub message: String,
    pub effects: Vec<TaskRequestEffect>,
    canonical_event_type: Option<&'static str>,
}

impl TaskReplyOutcome {
    fn new(
        status: TaskReplyStatus,
        snapshot: Option<TaskRequestSnapshot>,
        message: impl Into<String>,
    ) -> Self {
        let task_id = snapshot.as_ref().map(|snapshot| snapshot.task_id.clone());
        let request_id = snapshot
            .as_ref()
            .map(|snapshot| snapshot.request_id.clone());
        Self {
            status,
            snapshot,
            task_id,
            request_id,
            message: message.into(),
            effects: Vec::new(),
            canonical_event_type: None,
        }
    }

    fn with_request_ids(mut self, task_id: &str, request_id: &str) -> Self {
        if self.task_id.is_none() {
            self.task_id = Some(task_id.to_owned());
        }
        if self.request_id.is_none() {
            self.request_id = Some(request_id.to_owned());
        }
        self
    }

    fn with_effect(mut self, effect: TaskRequestEffect) -> Self {
        self.effects.push(effect);
        self
    }

    fn with_canonical_event(mut self, event_type: &'static str) -> Self {
        self.canonical_event_type = Some(event_type);
        self
    }

    pub(crate) fn canonical_event_type(&self) -> Option<&'static str> {
        self.canonical_event_type
    }

    pub fn ok(&self) -> bool {
        matches!(self.status, TaskReplyStatus::Written)
    }

    pub fn rejected(task_id: &str, request_id: &str, message: impl Into<String>) -> Self {
        Self::new(TaskReplyStatus::Failed, None, message).with_request_ids(task_id, request_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRequestResolution {
    pub snapshot: TaskRequestSnapshot,
    pub effects: Vec<TaskRequestEffect>,
}

impl TaskRequestResolution {
    fn new(snapshot: TaskRequestSnapshot, effects: Vec<TaskRequestEffect>) -> Self {
        Self { snapshot, effects }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRequestEffect {
    pub event_type: &'static str,
    pub snapshot: TaskRequestSnapshot,
    pub stdin_intents: Vec<TaskStdinIntent>,
}

fn expired_task_request_effect(snapshot: TaskRequestSnapshot) -> TaskRequestEffect {
    let intent = TaskStdinIntent::exception(
        &snapshot.task_id,
        &snapshot.request_id,
        "ask_expired",
        "task ask expired",
    );
    TaskRequestEffect {
        event_type: "task_ask.expired",
        snapshot,
        stdin_intents: vec![intent],
    }
}

fn terminal_task_request_effect(
    snapshot: TaskRequestSnapshot,
    message: impl Into<String>,
) -> TaskRequestEffect {
    let message = message.into();
    let intent = TaskStdinIntent::exception(
        &snapshot.task_id,
        &snapshot.request_id,
        "task_terminal",
        &message,
    );
    TaskRequestEffect {
        event_type: "task_ask.rejected",
        snapshot,
        stdin_intents: vec![intent],
    }
}

fn rejected_task_request_effect(
    snapshot: TaskRequestSnapshot,
    code: &'static str,
    message: &str,
) -> TaskRequestEffect {
    let intent = TaskStdinIntent::exception(&snapshot.task_id, &snapshot.request_id, code, message);
    TaskRequestEffect {
        event_type: "task_ask.rejected",
        snapshot,
        stdin_intents: vec![intent],
    }
}

#[derive(Debug, Clone)]
pub(super) struct TaskRequestRecord {
    request_id: String,
    request: String,
    expect: Option<String>,
    urgency: InputUrgency,
    state: TaskRequestState,
    requested_at: SystemTime,
    deadline_at: SystemTime,
    requested_timeout: Option<Duration>,
    effective_timeout: Duration,
    completed_at: Option<SystemTime>,
    failure_reason: Option<String>,
    stale_skipped: bool,
}

impl TaskRequestRecord {
    fn snapshot(&self, metadata: &TaskRequestMetadata) -> TaskRequestSnapshot {
        TaskRequestSnapshot {
            task_id: metadata.task_id.clone(),
            tool_call_id: metadata.tool_call_id.clone(),
            tool_name: metadata.tool_name.clone(),
            arguments_summary: metadata.arguments_summary.clone(),
            task_label: metadata.task_label.clone(),
            work_summary: metadata.work_summary.clone(),
            owner: metadata.owner.clone(),
            sender: metadata.sender.clone(),
            request_id: self.request_id.clone(),
            request: self.request.clone(),
            expect: self.expect.clone(),
            urgency: self.urgency,
            state: self.state,
            requested_at: self.requested_at,
            deadline_at: self.deadline_at,
            requested_timeout: self.requested_timeout,
            effective_timeout: self.effective_timeout,
            completed_at: self.completed_at,
            failure_reason: self.failure_reason.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct TaskRequestMetadata {
    task_id: String,
    tool_call_id: String,
    tool_name: String,
    owner: TaskOwner,
    arguments_summary: String,
    task_label: Option<String>,
    work_summary: Option<String>,
    sender: String,
}

fn task_request_sender(tool_name: &str, arguments_summary: &str) -> String {
    if arguments_summary.trim().is_empty() {
        tool_name.to_owned()
    } else {
        format!("{tool_name}: {arguments_summary}")
    }
}

impl TaskRecord {
    pub(super) fn request_snapshots(&self) -> Vec<TaskRequestSnapshot> {
        let metadata = self.request_metadata();
        self.requests
            .values()
            .map(|request| request.snapshot(&metadata))
            .collect()
    }

    pub(super) fn request_metadata(&self) -> TaskRequestMetadata {
        let arguments_summary =
            bounded_chars(&self.arguments_summary, TASK_REQUEST_ARGUMENT_SUMMARY_CHARS);
        let display = task_work_display(
            &self.task_id,
            self.task_label.as_deref(),
            &self.arguments_summary,
            self.preset_id.as_deref(),
            self.preset_description.as_deref(),
        );
        TaskRequestMetadata {
            task_id: self.task_id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            tool_name: self.tool_name.clone(),
            owner: self.owner.clone(),
            sender: task_request_sender(&self.tool_name, &arguments_summary),
            arguments_summary,
            task_label: display.label,
            work_summary: display.summary,
        }
    }

    pub(super) fn pending_request_count(&self) -> usize {
        self.requests
            .values()
            .filter(|request| request.state == TaskRequestState::Pending)
            .count()
    }

    pub(super) fn terminalize_pending_requests(
        &mut self,
        now: SystemTime,
        reason: &str,
    ) -> Vec<TaskRequestEffect> {
        let metadata = self.request_metadata();
        self.requests
            .values_mut()
            .filter_map(|request| {
                if request.state == TaskRequestState::Pending {
                    request.state = TaskRequestState::TaskTerminal;
                    request.completed_at = Some(now);
                    request.failure_reason = Some(reason.to_owned());
                    let snapshot = request.snapshot(&metadata);
                    return Some(terminal_task_request_effect(snapshot, reason));
                }
                None
            })
            .collect()
    }
}

impl BackgroundTaskManager {
    pub fn pending_request_count(&self) -> usize {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .values()
            .map(TaskRecord::pending_request_count)
            .sum()
    }

    pub fn accept_task_request(
        &self,
        task_id: &str,
        frame: TaskRequestFrame,
    ) -> TaskRequestAdmission {
        let now = SystemTime::now();
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let global_pending = inner
            .tasks
            .values()
            .map(TaskRecord::pending_request_count)
            .sum::<usize>();
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return TaskRequestAdmission::TaskMissing;
        };
        if let Some(existing) = record.requests.get(&frame.id) {
            let metadata = record.request_metadata();
            return TaskRequestAdmission::Duplicate(existing.snapshot(&metadata));
        }

        let mut state = TaskRequestState::Pending;
        let mut failure_reason = None;
        if record.state.is_terminal() {
            state = TaskRequestState::TaskTerminal;
            failure_reason = Some("task is terminal".to_owned());
        } else if record.pending_request_count() >= DEFAULT_MAX_PENDING_REQUESTS_PER_TASK {
            state = TaskRequestState::Rejected;
            failure_reason = Some("task ask pending limit reached".to_owned());
        } else if global_pending >= DEFAULT_MAX_PENDING_REQUESTS_GLOBAL {
            state = TaskRequestState::Rejected;
            failure_reason = Some("global task ask pending limit reached".to_owned());
        }

        let requested_timeout = frame.timeout;
        let effective_timeout = requested_timeout
            .unwrap_or(self.task_request_deadline)
            .min(self.task_request_deadline);
        let request = TaskRequestRecord {
            request_id: frame.id,
            request: frame.request,
            expect: frame.expect,
            urgency: frame.urgency,
            state,
            requested_at: now,
            deadline_at: now + effective_timeout,
            requested_timeout,
            effective_timeout,
            completed_at: state.is_terminal().then_some(now),
            failure_reason,
            stale_skipped: false,
        };
        if request.state == TaskRequestState::Rejected {
            let metadata = record.request_metadata();
            return TaskRequestAdmission::Rejected(request.snapshot(&metadata));
        }
        let request_id = request.request_id.clone();
        record.requests.insert(request_id.clone(), request);
        let metadata = record.request_metadata();
        let snapshot = record
            .requests
            .get(&request_id)
            .expect("inserted request should exist")
            .snapshot(&metadata);
        if snapshot.state == TaskRequestState::Pending {
            TaskRequestAdmission::Accepted(snapshot)
        } else {
            TaskRequestAdmission::Rejected(snapshot)
        }
    }

    pub fn reject_task_request(
        &self,
        task_id: &str,
        request_id: &str,
        exception_code: &'static str,
        reason: impl Into<String>,
    ) -> Option<TaskRequestResolution> {
        let reason = bounded_chars(&reason.into(), TASK_REQUEST_DIAGNOSTIC_CHARS);
        let now = SystemTime::now();
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let record = inner.tasks.get_mut(task_id)?;
        let metadata = record.request_metadata();
        let request = record.requests.get_mut(request_id)?;
        if request.state != TaskRequestState::Pending {
            return None;
        }
        request.state = TaskRequestState::Rejected;
        request.completed_at = Some(now);
        request.failure_reason = Some(reason.clone());
        let snapshot = request.snapshot(&metadata);
        Some(TaskRequestResolution::new(
            snapshot.clone(),
            vec![rejected_task_request_effect(
                snapshot,
                exception_code,
                &reason,
            )],
        ))
    }

    pub fn expire_pending_requests_for_task(
        &self,
        task_id: &str,
        now: SystemTime,
    ) -> Vec<TaskRequestResolution> {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return Vec::new();
        };
        let metadata = record.request_metadata();
        record
            .requests
            .values_mut()
            .filter_map(|request| {
                if request.state == TaskRequestState::Pending && request.deadline_at <= now {
                    request.state = TaskRequestState::Expired;
                    request.completed_at = Some(now);
                    request.failure_reason = Some("task ask expired".to_owned());
                    let snapshot = request.snapshot(&metadata);
                    return Some(TaskRequestResolution::new(
                        snapshot.clone(),
                        vec![expired_task_request_effect(snapshot)],
                    ));
                }
                None
            })
            .collect()
    }

    pub fn prepare_task_reply(
        &self,
        task_id: &str,
        request_id: &str,
        response: &str,
    ) -> TaskReplyPlan {
        self.prepare_task_reply_for_owner(None, task_id, request_id, response)
    }

    pub fn prepare_task_reply_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
        request_id: &str,
        response: &str,
    ) -> TaskReplyPlan {
        self.prepare_task_reply_for_owner(Some(owner), task_id, request_id, response)
    }

    fn prepare_task_reply_for_owner(
        &self,
        owner: Option<&TaskOwner>,
        task_id: &str,
        request_id: &str,
        response: &str,
    ) -> TaskReplyPlan {
        let response_intent = TaskStdinIntent::response(task_id, request_id, response);
        if let Err(error) = validate_task_stdin_frame(
            TaskStdinFrameKind::Reply,
            response_intent.frame.as_bytes(),
            TASK_STDIN_FRAME_SAFETY_CEILING,
        ) {
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(TaskReplyStatus::ResponseTooLarge, None, error)
                    .with_request_ids(task_id, request_id),
            );
        }

        let now = SystemTime::now();
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let writer_frame_cap = inner
            .stdin_writers
            .get(task_id)
            .map(|writer| writer.atomic_frame_cap());
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(
                    TaskReplyStatus::UnknownTask,
                    None,
                    format!("unknown task: {task_id}"),
                )
                .with_request_ids(task_id, request_id),
            );
        };
        if !owner.is_none_or(|owner| &record.owner == owner) {
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(
                    TaskReplyStatus::UnknownTask,
                    None,
                    format!("unknown task: {task_id}"),
                )
                .with_request_ids(task_id, request_id),
            );
        }
        let metadata = record.request_metadata();
        let task_is_terminal = record.state.is_terminal();
        let Some(request) = record.requests.get_mut(request_id) else {
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(
                    TaskReplyStatus::UnknownRequest,
                    None,
                    format!("unknown task ask: {request_id}"),
                )
                .with_request_ids(task_id, request_id),
            );
        };
        if request.state != TaskRequestState::Pending {
            let snapshot = request.snapshot(&metadata);
            if request.state == TaskRequestState::Expired {
                return TaskReplyPlan::finished(TaskReplyOutcome::new(
                    TaskReplyStatus::Expired,
                    Some(snapshot),
                    "task ask expired",
                ));
            }
            return TaskReplyPlan::finished(TaskReplyOutcome::new(
                TaskReplyStatus::AlreadyResolved,
                Some(snapshot),
                "task ask was already resolved",
            ));
        }
        if task_is_terminal {
            request.state = TaskRequestState::TaskTerminal;
            request.completed_at = Some(now);
            request.failure_reason = Some("task is terminal".to_owned());
            let snapshot = request.snapshot(&metadata);
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(
                    TaskReplyStatus::TaskTerminal,
                    Some(snapshot.clone()),
                    "task is terminal",
                )
                .with_effect(terminal_task_request_effect(snapshot, "task is terminal")),
            );
        }
        if request.deadline_at <= now {
            request.state = TaskRequestState::Expired;
            request.completed_at = Some(now);
            request.failure_reason = Some("task ask expired".to_owned());
            let snapshot = request.snapshot(&metadata);
            return TaskReplyPlan::finished(
                TaskReplyOutcome::new(
                    TaskReplyStatus::Expired,
                    Some(snapshot.clone()),
                    "task ask expired",
                )
                .with_effect(expired_task_request_effect(snapshot)),
            );
        }
        if let Some(frame_cap) = writer_frame_cap {
            if let Err(error) = validate_task_stdin_frame(
                TaskStdinFrameKind::Reply,
                response_intent.frame.as_bytes(),
                frame_cap,
            ) {
                return TaskReplyPlan::finished(
                    TaskReplyOutcome::new(TaskReplyStatus::ResponseTooLarge, None, error)
                        .with_request_ids(task_id, request_id),
                );
            }
        }
        request.state = TaskRequestState::Replied;
        let snapshot = request.snapshot(&metadata);
        TaskReplyPlan::ready(snapshot, response_intent)
    }

    pub fn complete_prepared_task_reply(
        &self,
        task_id: &str,
        request_id: &str,
        write_result: Result<(), String>,
    ) -> TaskReplyOutcome {
        self.complete_prepared_task_reply_for_owner(None, task_id, request_id, write_result)
    }

    pub fn complete_prepared_task_reply_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
        request_id: &str,
        write_result: Result<(), String>,
    ) -> TaskReplyOutcome {
        self.complete_prepared_task_reply_for_owner(Some(owner), task_id, request_id, write_result)
    }

    fn complete_prepared_task_reply_for_owner(
        &self,
        owner: Option<&TaskOwner>,
        task_id: &str,
        request_id: &str,
        write_result: Result<(), String>,
    ) -> TaskReplyOutcome {
        let now = SystemTime::now();
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return TaskReplyOutcome::new(TaskReplyStatus::UnknownTask, None, "unknown task")
                .with_request_ids(task_id, request_id);
        };
        if !owner.is_none_or(|owner| &record.owner == owner) {
            return TaskReplyOutcome::new(TaskReplyStatus::UnknownTask, None, "unknown task")
                .with_request_ids(task_id, request_id);
        }
        let metadata = record.request_metadata();
        let Some(request) = record.requests.get_mut(request_id) else {
            return TaskReplyOutcome::new(TaskReplyStatus::UnknownRequest, None, "unknown request")
                .with_request_ids(task_id, request_id);
        };
        if request.state != TaskRequestState::Replied {
            return TaskReplyOutcome::new(
                TaskReplyStatus::AlreadyResolved,
                Some(request.snapshot(&metadata)),
                "task ask was already resolved",
            );
        }
        match write_result {
            Ok(()) => {
                request.state = TaskRequestState::Written;
                request.completed_at = Some(now);
                request.failure_reason = None;
                TaskReplyOutcome::new(
                    TaskReplyStatus::Written,
                    Some(request.snapshot(&metadata)),
                    "task reply written",
                )
                .with_canonical_event("task_reply.written")
            }
            Err(error) => {
                let reason = bounded_chars(&error, TASK_REQUEST_DIAGNOSTIC_CHARS);
                request.state = TaskRequestState::WriteFailed;
                request.completed_at = Some(now);
                request.failure_reason = Some(reason.clone());
                TaskReplyOutcome::new(
                    TaskReplyStatus::Failed,
                    Some(request.snapshot(&metadata)),
                    reason,
                )
                .with_canonical_event("task_reply.failed")
            }
        }
    }

    pub(crate) fn mark_task_request_stale_skipped(&self, task_id: &str, request_id: &str) -> bool {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return false;
        };
        let Some(request) = record.requests.get_mut(request_id) else {
            return false;
        };
        request.stale_skipped = true;
        true
    }
}
