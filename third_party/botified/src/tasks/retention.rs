use std::{
    fs,
    time::{Duration, SystemTime},
};

use super::{
    BackgroundTaskManager, BackgroundTaskManagerInner, CallbackDelivery, TaskRecord, TaskState,
};

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct RetiredTasks {
    pub(super) pruned_count: usize,
    pub(super) output_artifacts: Vec<std::path::PathBuf>,
}

impl RetiredTasks {
    pub(super) fn cleanup(self) -> usize {
        let pruned_count = self.pruned_count;
        for path in self.output_artifacts {
            remove_output_artifact(path);
        }
        pruned_count
    }

    fn push(&mut self, record: TaskRecord) {
        self.pruned_count += 1;
        if let Some(path) = record.output_artifact {
            self.output_artifacts.push(path);
        }
    }
}

pub(super) fn cleanup_output_artifact(path: Option<std::path::PathBuf>) {
    if let Some(path) = path {
        remove_output_artifact(path);
    }
}

impl BackgroundTaskManager {
    pub fn prune(&self, now: SystemTime) -> usize {
        let retired = {
            let mut inner = self.inner.lock().expect("task manager lock poisoned");
            inner.prune(self.max_retained_tasks, self.task_retention, now)
        };
        retired.cleanup()
    }
}

impl BackgroundTaskManagerInner {
    pub(super) fn prune(
        &mut self,
        max_retained_tasks: usize,
        task_retention: Duration,
        now: SystemTime,
    ) -> RetiredTasks {
        let mut removable = self
            .tasks
            .values()
            .filter(|record| record.is_prunable_at(now, task_retention))
            .map(|record| record.task_id.clone())
            .collect::<Vec<_>>();
        let mut retired = RetiredTasks::default();

        for task_id in removable.iter() {
            if let Some(record) = self.tasks.remove(task_id) {
                retired.push(record);
            }
        }

        removable = self
            .tasks
            .values()
            .filter(|record| record.is_prunable())
            .map(|record| record.task_id.clone())
            .collect();
        while self.tasks.len() > max_retained_tasks {
            let Some(task_id) = removable.first().cloned() else {
                break;
            };
            removable.remove(0);
            if let Some(record) = self.tasks.remove(&task_id) {
                retired.push(record);
            }
        }

        self.retain_live_stdin_writers();
        retired
    }

    pub(super) fn retain_live_stdin_writers(&mut self) {
        self.stdin_writers.retain(|task_id, _| {
            self.tasks
                .get(task_id)
                .is_some_and(|record| record.state == TaskState::Running)
        });
    }
}

impl TaskRecord {
    fn is_prunable(&self) -> bool {
        self.state.is_terminal()
            && (self.callback_delivery == CallbackDelivery::Delivered
                || (self.callback_delivery == CallbackDelivery::Failed
                    && self.callback_failure_committed))
    }

    fn is_prunable_at(&self, now: SystemTime, task_retention: Duration) -> bool {
        self.is_prunable()
            && self
                .completed_at
                .and_then(|completed_at| now.duration_since(completed_at).ok())
                .is_some_and(|age| age >= task_retention)
    }
}

fn remove_output_artifact(path: std::path::PathBuf) {
    match fs::remove_file(&path) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
        Err(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tasks::NewBackgroundTask;

    #[test]
    fn inner_prune_returns_exact_cleanup_batch_without_touching_files() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let output_dir = temp.path().join("task-output");
        let output_artifact = output_dir.join("output.log");
        let public_artifact = temp.path().join("public-artifact.log");
        fs::create_dir_all(&output_dir).expect("create output dir");
        fs::write(&output_artifact, b"physical output").expect("write physical output");
        fs::write(&public_artifact, b"public artifact").expect("write public artifact");

        let manager = BackgroundTaskManager::with_limits(0, 0, Duration::ZERO);
        let task_id = "prune-cleanup-boundary";
        manager.start_task_with_id(
            task_id,
            NewBackgroundTask::new("call-1", "bash", "test")
                .with_artifact_path(public_artifact.clone()),
        );
        let now = SystemTime::now();

        let retired = {
            let mut inner = manager.inner.lock().expect("task manager lock poisoned");
            let record = inner.tasks.get_mut(task_id).expect("task should exist");
            record.state = TaskState::Completed;
            record.completed_at = Some(now);
            record.callback_delivery = CallbackDelivery::Delivered;
            record.output_artifact = Some(output_artifact.clone());

            let retired = inner.prune(0, Duration::ZERO, now);
            assert!(output_artifact.exists());
            assert!(public_artifact.exists());
            retired
        };

        assert_eq!(retired.pruned_count, 1);
        assert_eq!(retired.output_artifacts, vec![output_artifact.clone()]);
        assert!(manager.inner.try_lock().is_ok());

        assert_eq!(retired.cleanup(), 1);
        assert!(!output_artifact.exists());
        assert!(public_artifact.exists());
    }
}
