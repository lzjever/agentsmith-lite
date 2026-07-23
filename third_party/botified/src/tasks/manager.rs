use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use rand::{rngs::OsRng, RngCore};
use tokio_util::sync::CancellationToken;

use crate::formatting::bounded_chars;

use super::{
    retention::cleanup_output_artifact, CallbackDelivery, NewBackgroundTask,
    TaskCallbackPayloadRecord, TaskOutputSnapshot, TaskOutputUpdate, TaskOwner, TaskRequestEffect,
    TaskRequestRecord, TaskSnapshot, TaskState, TaskStdinWriter,
    DEFAULT_TASK_REQUEST_DEADLINE_SECS, MIN_TASK_STDIN_FRAME_BYTES, TASK_REQUEST_DIAGNOSTIC_CHARS,
};

pub(super) const DEFAULT_OUTPUT_TAIL_LIMIT: usize = 8 * 1024;
pub(super) const DEFAULT_MAX_RETAINED_TASKS: usize = 128;
pub(super) const DEFAULT_TASK_RETENTION_SECS: u64 = 86_400;

#[derive(Debug, Clone)]
pub struct TaskFinalization {
    pub snapshot: TaskSnapshot,
    pub pending_request_effects: Vec<TaskRequestEffect>,
}

#[derive(Debug)]
pub struct BackgroundTaskManager {
    pub(super) inner: Mutex<BackgroundTaskManagerInner>,
    pub(super) output_tail_limit: usize,
    pub(super) max_retained_tasks: usize,
    pub(super) task_retention: Duration,
    pub(super) task_request_deadline: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskAdmissionLimit {
    pub max_concurrent_tasks: usize,
    pub running_or_cancelling_tasks: usize,
}

impl BackgroundTaskManager {
    pub fn new() -> Self {
        Self::with_output_tail_limit(DEFAULT_OUTPUT_TAIL_LIMIT)
    }

    pub fn with_output_tail_limit(output_tail_limit: usize) -> Self {
        Self::with_limits(
            output_tail_limit,
            DEFAULT_MAX_RETAINED_TASKS,
            Duration::from_secs(DEFAULT_TASK_RETENTION_SECS),
        )
    }

    pub fn with_limits(
        output_tail_limit: usize,
        max_retained_tasks: usize,
        task_retention: Duration,
    ) -> Self {
        Self::with_limits_and_task_request_deadline(
            output_tail_limit,
            max_retained_tasks,
            task_retention,
            Duration::from_secs(DEFAULT_TASK_REQUEST_DEADLINE_SECS),
        )
    }

    pub fn with_limits_and_task_request_deadline(
        output_tail_limit: usize,
        max_retained_tasks: usize,
        task_retention: Duration,
        task_request_deadline: Duration,
    ) -> Self {
        Self {
            inner: Mutex::new(BackgroundTaskManagerInner::default()),
            output_tail_limit,
            max_retained_tasks,
            task_retention,
            task_request_deadline,
        }
    }

    pub fn allocate_task_id(&self) -> String {
        new_task_id()
    }

    pub fn start_task(&self, task: NewBackgroundTask) -> TaskSnapshot {
        let task_id = new_task_id();
        self.start_task_with_id(task_id, task)
    }

    pub fn start_task_with_id(
        &self,
        task_id: impl Into<String>,
        task: NewBackgroundTask,
    ) -> TaskSnapshot {
        let now = SystemTime::now();
        let task_id = task_id.into();
        let record = TaskRecord::new(task_id.clone(), task, now);

        let (snapshot, retired) = {
            let mut inner = self.inner.lock().expect("task manager lock poisoned");
            inner.tasks.insert(task_id.clone(), record);
            let retired = inner.prune(self.max_retained_tasks, self.task_retention, now);
            let snapshot = inner
                .tasks
                .get(&task_id)
                .expect("inserted task should exist")
                .snapshot();
            inner.retain_live_stdin_writers();
            (snapshot, retired)
        };
        retired.cleanup();
        snapshot
    }

    pub fn try_start_task_with_id(
        &self,
        task_id: impl Into<String>,
        task: NewBackgroundTask,
        max_concurrent_tasks: usize,
    ) -> Result<TaskSnapshot, TaskAdmissionLimit> {
        let now = SystemTime::now();
        let task_id = task_id.into();
        let record = TaskRecord::new(task_id.clone(), task, now);

        let (snapshot, retired) = {
            let mut inner = self.inner.lock().expect("task manager lock poisoned");
            let running_or_cancelling_tasks = inner.running_or_cancelling_count();
            if running_or_cancelling_tasks >= max_concurrent_tasks {
                return Err(TaskAdmissionLimit {
                    max_concurrent_tasks,
                    running_or_cancelling_tasks,
                });
            }
            inner.tasks.insert(task_id.clone(), record);
            let retired = inner.prune(self.max_retained_tasks, self.task_retention, now);
            let snapshot = inner
                .tasks
                .get(&task_id)
                .expect("admitted task should exist")
                .snapshot();
            inner.retain_live_stdin_writers();
            (snapshot, retired)
        };
        retired.cleanup();
        Ok(snapshot)
    }

    pub fn list(&self) -> Vec<TaskSnapshot> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .values()
            .map(TaskRecord::snapshot)
            .collect()
    }

    pub fn list_by_owner(&self, owner: &TaskOwner) -> Vec<TaskSnapshot> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .values()
            .filter(|record| &record.owner == owner)
            .map(TaskRecord::snapshot)
            .collect()
    }

    pub fn running_or_cancelling_count(&self) -> usize {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .running_or_cancelling_count()
    }

    pub fn get(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .get(task_id)
            .map(TaskRecord::snapshot)
    }

    pub fn get_by_owner(&self, owner: &TaskOwner, task_id: &str) -> Option<TaskSnapshot> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .get(task_id)
            .filter(|record| &record.owner == owner)
            .map(TaskRecord::snapshot)
    }

    pub fn register_stdin_writer(
        &self,
        task_id: &str,
        writer: Arc<dyn TaskStdinWriter>,
    ) -> Result<TaskSnapshot, String> {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let record = inner
            .tasks
            .get(task_id)
            .ok_or_else(|| format!("unknown task: {task_id}"))?;
        if record.state != TaskState::Running || record.cancel_token.is_cancelled() {
            return Err(format!(
                "task {task_id} does not accept stdin writers while {:?}",
                record.state
            ));
        }
        let snapshot = record.snapshot();
        let frame_cap = writer.atomic_frame_cap();
        if frame_cap < MIN_TASK_STDIN_FRAME_BYTES {
            return Err(format!(
                "task stdin atomic frame cap {frame_cap} cannot hold minimum protocol metadata ({MIN_TASK_STDIN_FRAME_BYTES} bytes)"
            ));
        }
        inner.stdin_writers.insert(task_id.to_owned(), writer);
        Ok(snapshot)
    }

    pub(crate) fn stdin_writer(&self, task_id: &str) -> Option<Arc<dyn TaskStdinWriter>> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .stdin_writers
            .get(task_id)
            .cloned()
    }

    pub(crate) fn release_stdin_writer(&self, task_id: &str) {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .stdin_writers
            .remove(task_id);
    }

    pub fn finish_task(
        &self,
        task_id: &str,
        state: TaskState,
        pending_request_reason: impl Into<String>,
    ) -> Option<TaskFinalization> {
        self.finish_task_if_owner(None, task_id, state, pending_request_reason, false)
    }

    pub(crate) fn cancel_and_fail_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
        pending_request_reason: impl Into<String>,
    ) -> Option<TaskFinalization> {
        self.finish_task_if_owner(
            Some(owner),
            task_id,
            TaskState::Failed,
            pending_request_reason,
            true,
        )
    }

    fn finish_task_if_owner(
        &self,
        owner: Option<&TaskOwner>,
        task_id: &str,
        state: TaskState,
        pending_request_reason: impl Into<String>,
        cancel: bool,
    ) -> Option<TaskFinalization> {
        let reason = bounded_chars(
            &pending_request_reason.into(),
            TASK_REQUEST_DIAGNOSTIC_CHARS,
        );
        let now = SystemTime::now();
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let record = inner.tasks.get_mut(task_id)?;
        if !owner.is_none_or(|owner| &record.owner == owner) {
            return None;
        }
        if cancel {
            record.cancel_token.cancel();
        }
        record.output.output_live = false;
        record.output.output_complete = true;
        let pending_request_effects = record.terminalize_pending_requests(now, &reason);
        record.set_state(state, now);
        let snapshot = record.snapshot();
        if snapshot.state != TaskState::Running {
            inner.stdin_writers.remove(task_id);
        }
        Some(TaskFinalization {
            snapshot,
            pending_request_effects,
        })
    }

    pub fn cancel(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task(task_id, |record| {
            if !record.state.is_terminal() {
                record.state = TaskState::Cancelling;
                record.cancel_token.cancel();
            }
        })
    }

    pub fn cancel_by_owner(&self, owner: &TaskOwner, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task_if(task_id, |record| {
            if &record.owner != owner {
                return false;
            }
            if !record.state.is_terminal() {
                record.state = TaskState::Cancelling;
                record.cancel_token.cancel();
            }
            true
        })
    }

    pub fn discard_unstarted_by_owner(
        &self,
        owner: &TaskOwner,
        task_id: &str,
    ) -> Option<TaskSnapshot> {
        let (snapshot, output_artifact) = {
            let mut inner = self.inner.lock().expect("task manager lock poisoned");
            if !inner
                .tasks
                .get(task_id)
                .is_some_and(|record| &record.owner == owner)
            {
                return None;
            }
            let record = inner.tasks.remove(task_id)?;
            record.cancel_token.cancel();
            inner.stdin_writers.remove(task_id);
            (record.snapshot(), record.output_artifact)
        };
        cleanup_output_artifact(output_artifact);
        Some(snapshot)
    }

    pub fn cancel_all_by_owner(&self, owner: &TaskOwner) -> Vec<TaskSnapshot> {
        let (snapshots, retired) = {
            let mut inner = self.inner.lock().expect("task manager lock poisoned");
            let mut snapshots = Vec::new();
            for record in inner.tasks.values_mut() {
                if &record.owner != owner || record.state.is_terminal() {
                    continue;
                }
                record.state = TaskState::Cancelling;
                record.cancel_token.cancel();
                snapshots.push(record.snapshot());
            }
            let retired = inner.prune(
                self.max_retained_tasks,
                self.task_retention,
                SystemTime::now(),
            );
            (snapshots, retired)
        };
        retired.cleanup();
        snapshots
    }

    pub fn cancel_all(&self) -> Vec<TaskSnapshot> {
        let (snapshots, retired) = {
            let mut inner = self.inner.lock().expect("task manager lock poisoned");
            let mut snapshots = Vec::new();
            for record in inner.tasks.values_mut() {
                if record.state.is_terminal() {
                    continue;
                }
                record.state = TaskState::Cancelling;
                record.cancel_token.cancel();
                snapshots.push(record.snapshot());
            }
            let retired = inner.prune(
                self.max_retained_tasks,
                self.task_retention,
                SystemTime::now(),
            );
            (snapshots, retired)
        };
        retired.cleanup();
        snapshots
    }

    pub fn update_output(&self, task_id: &str, update: TaskOutputUpdate) -> Option<TaskSnapshot> {
        let now = SystemTime::now();
        let tail_limit = self.output_tail_limit;
        self.mutate_task(task_id, |record| {
            record.output.push_update(
                &update.bytes,
                update.output_bytes_delta,
                update.output_dropped_bytes_delta,
                update.output_artifact_truncated,
                tail_limit,
                now,
            );
        })
    }

    pub fn complete_output(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task(task_id, |record| {
            record.output.output_live = false;
            record.output.output_complete = true;
        })
    }

    pub fn set_output_snapshot(
        &self,
        task_id: &str,
        snapshot: TaskOutputSnapshot,
    ) -> Option<TaskSnapshot> {
        self.mutate_task(task_id, |record| {
            record.output = TaskOutputRecord::from_snapshot(snapshot.clone());
            record.artifact_path = snapshot.artifact_path;
        })
    }

    pub fn set_artifact_path(
        &self,
        task_id: &str,
        artifact_path: impl Into<PathBuf>,
    ) -> Option<TaskSnapshot> {
        let artifact_path = artifact_path.into();
        self.mutate_task(task_id, |record| {
            record.artifact_path = Some(artifact_path.clone());
            record.output.artifact_path = Some(artifact_path);
        })
    }

    pub(super) fn register_output_artifact(&self, task_id: &str, physical_path: PathBuf) {
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        if let Some(record) = inner.tasks.get_mut(task_id) {
            record.output_artifact = Some(physical_path);
        }
    }

    pub(super) fn mutate_task(
        &self,
        task_id: &str,
        mutate: impl FnOnce(&mut TaskRecord),
    ) -> Option<TaskSnapshot> {
        let (snapshot, retired) = {
            let mut inner = self.inner.lock().expect("task manager lock poisoned");
            let record = inner.tasks.get_mut(task_id)?;
            mutate(record);
            let snapshot = record.snapshot();
            let retired = inner.prune(
                self.max_retained_tasks,
                self.task_retention,
                SystemTime::now(),
            );
            (snapshot, retired)
        };
        retired.cleanup();
        Some(snapshot)
    }

    pub(super) fn mutate_task_if(
        &self,
        task_id: &str,
        mutate: impl FnOnce(&mut TaskRecord) -> bool,
    ) -> Option<TaskSnapshot> {
        let (snapshot, retired) = {
            let mut inner = self.inner.lock().expect("task manager lock poisoned");
            let record = inner.tasks.get_mut(task_id)?;
            if !mutate(record) {
                return None;
            }
            let snapshot = record.snapshot();
            let retired = inner.prune(
                self.max_retained_tasks,
                self.task_retention,
                SystemTime::now(),
            );
            (snapshot, retired)
        };
        retired.cleanup();
        Some(snapshot)
    }
}

impl Default for BackgroundTaskManager {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
pub(super) struct BackgroundTaskManagerInner {
    pub(super) tasks: BTreeMap<String, TaskRecord>,
    pub(super) stdin_writers: HashMap<String, Arc<dyn TaskStdinWriter>>,
}

impl std::fmt::Debug for BackgroundTaskManagerInner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BackgroundTaskManagerInner")
            .field("tasks", &self.tasks)
            .field("stdin_writers", &self.stdin_writers.len())
            .finish()
    }
}

impl BackgroundTaskManagerInner {
    fn running_or_cancelling_count(&self) -> usize {
        self.tasks
            .values()
            .filter(|record| matches!(record.state, TaskState::Running | TaskState::Cancelling))
            .count()
    }
}

#[derive(Debug)]
pub(super) struct TaskRecord {
    pub(super) task_id: String,
    pub(super) tool_call_id: String,
    pub(super) tool_name: String,
    pub(super) arguments_summary: String,
    pub(super) task_label: Option<String>,
    pub(super) owner: TaskOwner,
    pub(super) state: TaskState,
    pub(super) preset_id: Option<String>,
    pub(super) preset_description: Option<String>,
    pub(super) started_at: SystemTime,
    pub(super) detached_at: Option<SystemTime>,
    pub(super) timeout_at: Option<SystemTime>,
    pub(super) completed_at: Option<SystemTime>,
    pub(super) callback_delivery: CallbackDelivery,
    pub(super) callback_payload: Option<TaskCallbackPayloadRecord>,
    pub(super) callback_failure_reason: Option<String>,
    pub(super) callback_failure_committed: bool,
    pub(super) output: TaskOutputRecord,
    pub(super) artifact_path: Option<PathBuf>,
    pub(super) output_artifact: Option<PathBuf>,
    pub(super) cancel_token: CancellationToken,
    pub(super) requests: BTreeMap<String, TaskRequestRecord>,
}

impl TaskRecord {
    fn new(task_id: String, task: NewBackgroundTask, started_at: SystemTime) -> Self {
        Self {
            task_id,
            tool_call_id: task.tool_call_id,
            tool_name: task.tool_name,
            arguments_summary: task.arguments_summary,
            task_label: task.task_label,
            owner: task.owner,
            preset_id: task.preset_id,
            preset_description: task.preset_description,
            state: TaskState::Running,
            started_at,
            detached_at: task.detached_at,
            timeout_at: task.timeout_at,
            completed_at: None,
            callback_delivery: CallbackDelivery::NotReady,
            callback_payload: None,
            callback_failure_reason: None,
            callback_failure_committed: false,
            output: TaskOutputRecord::new(task.artifact_path.clone()),
            artifact_path: task.artifact_path,
            output_artifact: None,
            cancel_token: task.cancel_token,
            requests: BTreeMap::new(),
        }
    }

    fn set_state(&mut self, state: TaskState, now: SystemTime) {
        if self.state.is_terminal() {
            return;
        }

        self.state = state;
        if state.is_terminal() {
            self.completed_at = Some(now);
        }
    }

    pub(super) fn snapshot(&self) -> TaskSnapshot {
        TaskSnapshot {
            task_id: self.task_id.clone(),
            tool_call_id: self.tool_call_id.clone(),
            tool_name: self.tool_name.clone(),
            arguments_summary: self.arguments_summary.clone(),
            task_label: self.task_label.clone(),
            preset_id: self.preset_id.clone(),
            preset_description: self.preset_description.clone(),
            owner: self.owner.clone(),
            state: self.state,
            started_at: self.started_at,
            detached_at: self.detached_at,
            timeout_at: self.timeout_at,
            completed_at: self.completed_at,
            callback_delivery: self.callback_delivery,
            callback_payload: self
                .callback_payload
                .as_ref()
                .map(TaskCallbackPayloadRecord::snapshot),
            callback_failure_reason: self.callback_failure_reason.clone(),
            output: self.output.snapshot(),
            artifact_path: self.artifact_path.clone(),
            cancel_token: self.cancel_token.clone(),
            requests: self.request_snapshots(),
        }
    }
}

#[derive(Debug)]
pub(super) struct TaskOutputRecord {
    pub(super) tail: Vec<u8>,
    pub(super) output_bytes: u64,
    pub(super) output_live: bool,
    pub(super) output_complete: bool,
    pub(super) output_last_updated_at: Option<SystemTime>,
    pub(super) artifact_path: Option<PathBuf>,
    pub(super) output_tail_truncated: bool,
    pub(super) output_artifact_truncated: bool,
    pub(super) output_dropped_bytes: u64,
}

impl TaskOutputRecord {
    pub(super) fn new(artifact_path: Option<PathBuf>) -> Self {
        Self {
            tail: Vec::new(),
            output_bytes: 0,
            output_live: true,
            output_complete: false,
            output_last_updated_at: None,
            artifact_path,
            output_tail_truncated: false,
            output_artifact_truncated: false,
            output_dropped_bytes: 0,
        }
    }

    pub(super) fn push_update(
        &mut self,
        bytes: &[u8],
        output_bytes_delta: u64,
        output_dropped_bytes_delta: u64,
        output_artifact_truncated: bool,
        tail_limit: usize,
        updated_at: SystemTime,
    ) {
        self.output_bytes = self.output_bytes.saturating_add(output_bytes_delta);
        self.output_dropped_bytes = self
            .output_dropped_bytes
            .saturating_add(output_dropped_bytes_delta);
        self.output_artifact_truncated |= output_artifact_truncated;
        self.output_last_updated_at = Some(updated_at);

        if bytes.is_empty() {
            return;
        }

        if tail_limit == 0 {
            self.output_tail_truncated = true;
            self.tail.clear();
            return;
        }

        if bytes.len() >= tail_limit {
            self.output_tail_truncated = true;
            self.tail.clear();
            self.tail
                .extend_from_slice(&bytes[bytes.len() - tail_limit..]);
            return;
        }

        let overflow = self.tail.len() + bytes.len();
        if overflow > tail_limit {
            let remove = overflow - tail_limit;
            self.tail.drain(..remove);
            self.output_tail_truncated = true;
        }

        self.tail.extend_from_slice(bytes);
    }

    pub(super) fn from_snapshot(snapshot: TaskOutputSnapshot) -> Self {
        Self {
            tail: snapshot.tail.into_bytes(),
            output_bytes: snapshot.output_bytes,
            output_live: snapshot.output_live,
            output_complete: snapshot.output_complete,
            output_last_updated_at: snapshot.output_last_updated_at,
            artifact_path: snapshot.artifact_path,
            output_tail_truncated: snapshot.output_tail_truncated,
            output_artifact_truncated: snapshot.output_artifact_truncated,
            output_dropped_bytes: snapshot.output_dropped_bytes,
        }
    }

    pub(super) fn snapshot(&self) -> TaskOutputSnapshot {
        TaskOutputSnapshot {
            tail: String::from_utf8_lossy(&self.tail).into_owned(),
            output_bytes: self.output_bytes,
            output_live: self.output_live,
            output_complete: self.output_complete,
            output_last_updated_at: self.output_last_updated_at,
            artifact_path: self.artifact_path.clone(),
            output_tail_truncated: self.output_tail_truncated,
            output_artifact_truncated: self.output_artifact_truncated,
            output_dropped_bytes: self.output_dropped_bytes,
        }
    }
}

fn new_task_id() -> String {
    let mut entropy = [0_u8; 8];
    OsRng.fill_bytes(&mut entropy);
    task_id_from_entropy(entropy)
}

fn task_id_from_entropy(entropy: [u8; 8]) -> String {
    format!("t_{}", hex::encode(entropy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::process::{Command, Stdio};

    #[test]
    fn task_id_encodes_an_eight_byte_sample_as_lowercase_hex() {
        let task_id = task_id_from_entropy([0x00, 0x01, 0x0f, 0x10, 0x7f, 0x80, 0xfe, 0xff]);

        assert_eq!(task_id, "t_00010f107f80feff");
        assert_eq!(task_id.len(), 18);
    }

    #[test]
    fn task_id_samples_are_distinct_in_bulk() {
        let ids: HashSet<_> = (0..10_000).map(|_| new_task_id()).collect();
        assert_eq!(ids.len(), 10_000);
    }

    #[test]
    fn task_id_and_callback_samples_are_distinct_across_processes() {
        const CHILD_ENV: &str = "BOTIFIED_TASK_ID_CHILD";
        const CHILD_MARKER: &str = "BOTIFIED_TASK_ID=";
        const CHILDREN: usize = 8;

        if std::env::var_os(CHILD_ENV).is_some() {
            println!("{CHILD_MARKER}{}", new_task_id());
            return;
        }

        let current_test = std::env::current_exe().expect("current test binary should be known");
        let test_name =
            "tasks::manager::tests::task_id_and_callback_samples_are_distinct_across_processes";
        let children: Vec<_> = (0..CHILDREN)
            .map(|_| {
                Command::new(&current_test)
                    .args(["--exact", test_name, "--nocapture"])
                    .env(CHILD_ENV, "1")
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .expect("current test child should start")
            })
            .collect();

        let task_ids: Vec<_> = children
            .into_iter()
            .map(|child| {
                let output = child
                    .wait_with_output()
                    .expect("current test child should finish");
                assert!(
                    output.status.success(),
                    "child failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                String::from_utf8(output.stdout)
                    .expect("child output should be UTF-8")
                    .lines()
                    .find_map(|line| line.strip_prefix(CHILD_MARKER).map(str::to_owned))
                    .expect("child should report its first task id")
            })
            .collect();

        assert_eq!(task_ids.iter().collect::<HashSet<_>>().len(), CHILDREN);
        let callback_ids: HashSet<_> = task_ids
            .iter()
            .map(|task_id| format!("task_callback_{task_id}"))
            .collect();
        assert_eq!(callback_ids.len(), CHILDREN);
        for task_id in &task_ids {
            assert!(callback_ids.contains(&format!("task_callback_{task_id}")));
        }
    }
}
