use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

use crate::path_utils::{lexical_absolute, lexical_normalize};
use crate::private_fs::{
    ensure_private_dir, ensure_private_dir_with_legacy_tree, open_private_file,
    private_open_options,
};
use crate::tools::{ToolError, ToolOutputSink};

use super::{
    BackgroundTaskManager, TaskOutputPolicy, TaskOutputRecord, TaskOutputSnapshot, TaskOutputUpdate,
};

#[derive(Debug)]
pub struct BoundedTaskOutputSink {
    task_id: String,
    physical_path: PathBuf,
    manager: Option<Arc<BackgroundTaskManager>>,
    inner: Mutex<BoundedTaskOutputSinkInner>,
}

#[derive(Debug)]
struct BoundedTaskOutputSinkInner {
    file: File,
    output: TaskOutputRecord,
    output_tail_limit: usize,
    max_task_output_bytes: usize,
}

impl BoundedTaskOutputSink {
    pub fn create(
        policy: &TaskOutputPolicy,
        cwd: impl AsRef<Path>,
        task_id: impl Into<String>,
        manager: Option<Arc<BackgroundTaskManager>>,
    ) -> Result<Arc<Self>, ToolError> {
        let task_id = task_id.into();
        let (physical_path, visible_path) =
            task_output_paths(&policy.data_dir, cwd.as_ref(), &task_id);
        let tasks_dir = physical_path
            .parent()
            .and_then(Path::parent)
            .expect("task output path should have a tasks directory");
        let data_dir = tasks_dir
            .parent()
            .expect("tasks directory should have a data directory");
        ensure_private_dir(data_dir).map_err(|error| {
            ToolError::execution_failed(format!(
                "failed to create task output directory {}: {error}",
                data_dir.display()
            ))
        })?;
        ensure_private_dir_with_legacy_tree(tasks_dir).map_err(|error| {
            ToolError::execution_failed(format!(
                "failed to create or secure task output directory {}: {error}",
                tasks_dir.display()
            ))
        })?;
        if let Some(parent) = physical_path.parent() {
            ensure_private_dir(parent).map_err(|error| {
                ToolError::execution_failed(format!(
                    "failed to create task output directory {}: {error}",
                    parent.display()
                ))
            })?;
        }
        let mut options = private_open_options();
        options.write(true).create(true).truncate(true);
        let file = open_private_file(&options, &physical_path).map_err(|error| {
            ToolError::execution_failed(format!(
                "failed to create task output artifact {}: {error}",
                physical_path.display()
            ))
        })?;
        Ok(Arc::new(Self {
            task_id,
            physical_path,
            manager,
            inner: Mutex::new(BoundedTaskOutputSinkInner {
                file,
                output: TaskOutputRecord::new(Some(visible_path)),
                output_tail_limit: policy.callback_output_tail_bytes,
                max_task_output_bytes: policy.max_task_output_bytes,
            }),
        }))
    }

    pub fn artifact_path(&self) -> Option<PathBuf> {
        self.snapshot().artifact_path
    }

    pub fn sync_to_task_record(&self) {
        if let Some(manager) = self.manager.as_ref() {
            manager.register_output_artifact(&self.task_id, self.physical_path.clone());
            let snapshot = self.task_snapshot();
            manager.set_output_snapshot(&self.task_id, snapshot);
        }
    }

    fn task_snapshot(&self) -> TaskOutputSnapshot {
        let inner = self.inner.lock().expect("task output sink lock poisoned");
        inner.output.snapshot()
    }
}

impl ToolOutputSink for BoundedTaskOutputSink {
    fn record(&self, bytes: &[u8]) -> Result<crate::tools::ToolOutputSnapshot, ToolError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| ToolError::execution_failed("task output sink lock poisoned"))?;
        let retained = inner.output.output_bytes as usize;
        let remaining = inner.max_task_output_bytes.saturating_sub(retained);
        let writable = remaining.min(bytes.len());
        if writable > 0 {
            inner.file.write_all(&bytes[..writable]).map_err(|error| {
                ToolError::execution_failed(format!(
                    "failed to write task output artifact: {error}"
                ))
            })?;
            inner.file.flush().map_err(|error| {
                ToolError::execution_failed(format!(
                    "failed to flush task output artifact: {error}"
                ))
            })?;
        }
        let dropped = bytes.len().saturating_sub(writable);
        let truncated = dropped > 0;
        let now = SystemTime::now();
        let output_tail_limit = inner.output_tail_limit;
        inner.output.push_update(
            bytes,
            writable as u64,
            dropped as u64,
            truncated,
            output_tail_limit,
            now,
        );
        let snapshot = inner.output.snapshot();
        drop(inner);
        if let Some(manager) = self.manager.as_ref() {
            manager.update_output(
                &self.task_id,
                TaskOutputUpdate::artifact_progress(
                    bytes,
                    writable as u64,
                    dropped as u64,
                    truncated,
                ),
            );
        }
        Ok(tool_output_snapshot(snapshot))
    }

    fn complete(&self) -> Result<crate::tools::ToolOutputSnapshot, ToolError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| ToolError::execution_failed("task output sink lock poisoned"))?;
        inner.output.output_live = false;
        inner.output.output_complete = true;
        inner.file.flush().map_err(|error| {
            ToolError::execution_failed(format!("failed to flush task output artifact: {error}"))
        })?;
        let snapshot = inner.output.snapshot();
        drop(inner);
        if let Some(manager) = self.manager.as_ref() {
            manager.set_output_snapshot(&self.task_id, snapshot.clone());
        }
        Ok(tool_output_snapshot(snapshot))
    }

    fn snapshot(&self) -> crate::tools::ToolOutputSnapshot {
        let inner = self.inner.lock().expect("task output sink lock poisoned");
        tool_output_snapshot(inner.output.snapshot())
    }
}

fn tool_output_snapshot(snapshot: TaskOutputSnapshot) -> crate::tools::ToolOutputSnapshot {
    crate::tools::ToolOutputSnapshot {
        tail: snapshot.tail,
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

fn task_output_paths(data_dir: &Path, cwd: &Path, task_id: &str) -> (PathBuf, PathBuf) {
    let safe_task_id = artifact_task_component(task_id);
    let cwd = lexical_absolute(cwd, Path::new("."));
    let data_dir = lexical_absolute(data_dir, &cwd);
    let physical_path =
        lexical_normalize(&data_dir.join("tasks").join(safe_task_id).join("output.log"));
    let visible_path = if data_dir.starts_with(&cwd) {
        physical_path
            .strip_prefix(&cwd)
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| physical_path.clone())
    } else {
        physical_path.clone()
    };
    (physical_path, visible_path)
}

fn artifact_task_component(task_id: &str) -> String {
    let component: String = task_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    match component.as_str() {
        "" => "~empty".to_owned(),
        "." => "~dot".to_owned(),
        ".." => "~dotdot".to_owned(),
        _ => component,
    }
}
