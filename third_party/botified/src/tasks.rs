#[cfg(test)]
use std::{sync::Arc, time::Duration};

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
use std::os::fd::AsRawFd;

#[cfg(test)]
use std::io;

use serde::{Deserialize, Serialize};

#[cfg(test)]
use crate::agent_loop::InputUrgency;
#[cfg(test)]
use crate::types::ContentPart;

mod callback_lifecycle;
mod manager;
mod model;
mod output_sink;
mod request_lifecycle;
mod retention;
mod stdio_protocol;
mod surface;
mod tool_surface;

use callback_lifecycle::TaskCallbackPayloadRecord;
pub use manager::{BackgroundTaskManager, TaskAdmissionLimit, TaskFinalization};
use manager::{
    BackgroundTaskManagerInner, TaskOutputRecord, TaskRecord, DEFAULT_OUTPUT_TAIL_LIMIT,
};
#[cfg(test)]
use manager::{DEFAULT_MAX_RETAINED_TASKS, DEFAULT_TASK_RETENTION_SECS};
pub use model::{
    CallbackDelivery, NewBackgroundTask, TaskCallbackPayloadSnapshot, TaskOutputPolicy,
    TaskOutputSnapshot, TaskOutputUpdate, TaskOwner, TaskRequestSnapshot, TaskRequestState,
    TaskSnapshot, TaskState,
};
pub use output_sink::BoundedTaskOutputSink;
use request_lifecycle::TaskRequestRecord;
pub use request_lifecycle::{
    TaskReplyOutcome, TaskReplyPlan, TaskReplyStatus, TaskRequestAdmission, TaskRequestEffect,
    TaskRequestResolution, TaskStdinIntent, TaskStdinIntentKind,
};
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
use stdio_protocol::managed_pipe_atomic_frame_cap;
pub(crate) use stdio_protocol::representable_observe_message_id;
use stdio_protocol::MIN_TASK_STDIN_FRAME_BYTES;
pub use stdio_protocol::{
    task_exception_frame, task_observe_done_frame, task_observe_error_frame,
    task_observe_result_disabled_frame, task_observe_result_enabled_frame,
    task_observe_result_failure_frame, task_observe_text_frames, task_response_frame,
    task_send_frame, try_write_task_stdin_frame, validate_task_stdin_frame, BotifiedFrameEvent,
    BotifiedFrameScan, BotifiedFrameScanner, InteractiveStdioBridge, SharedTaskStdinWriter,
    TaskFrameDiagnostic, TaskObserveConfig, TaskObserveDelivery, TaskObserveException,
    TaskObserveRequestAction, TaskObserveRequestFrame, TaskObserveRequestRejectedFrame,
    TaskObserveSource, TaskObserveTextMetadata, TaskRegistryDeleteFrame, TaskRegistryGetFrame,
    TaskRegistrySetFrame, TaskRequestFrame, TaskStdinFrameKind, TaskStdinWriteSuccess,
    TaskStdinWriter, TaskTellFrame, DEFAULT_BOTIFIED_FRAME_BYTES, TASK_STDIN_FRAME_SAFETY_CEILING,
};
pub(crate) use surface::{task_state_name, task_surface_facts};
pub use tool_surface::{
    is_builtin_task_tool, task_cancel_result_summary, task_detail_summary, task_list_summary,
    TaskCancelTool, TaskListTool, TASK_CANCEL_TOOL_NAME, TASK_LIST_TOOL_NAME, TASK_REPLY_TOOL_NAME,
    TASK_SEND_TOOL_NAME,
};

const TASK_REQUEST_FIELD_CHARS: usize = 2048;
const TASK_REQUEST_TEXT_CHARS: usize = 8 * 1024;
const TASK_REQUEST_DIAGNOSTIC_CHARS: usize = 512;
const DEFAULT_TASK_REQUEST_DEADLINE_SECS: u64 = 300;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkDisplay {
    pub id: String,
    pub label: Option<String>,
    pub summary: Option<String>,
}

pub fn normalize_task_label(value: &str) -> Option<String> {
    let mut normalized = String::new();
    let mut separator = false;
    for ch in value.chars() {
        if ch.is_whitespace() {
            separator = !normalized.is_empty();
        } else if ch.is_control() {
            return None;
        } else {
            if separator {
                normalized.push(' ');
                separator = false;
            }
            normalized.push(ch);
        }
    }
    let mut result: String = normalized.chars().take(64).collect();
    while result.ends_with(' ') {
        result.pop();
    }
    (!result.is_empty()).then_some(result)
}

pub fn normalize_work_summary(value: &str) -> Option<String> {
    let mut normalized = String::new();
    let mut separator = false;
    for ch in value.chars() {
        if ch.is_whitespace() {
            separator = !normalized.is_empty();
        } else if ch.is_control() {
            continue;
        } else {
            if separator {
                normalized.push(' ');
                separator = false;
            }
            normalized.push(ch);
        }
    }
    let mut result: String = normalized.chars().take(512).collect();
    while result.ends_with(' ') {
        result.pop();
    }
    (!result.is_empty()).then_some(result)
}

pub fn runtime_work_display(snapshot: &TaskSnapshot) -> WorkDisplay {
    task_work_display(
        &snapshot.task_id,
        snapshot.task_label.as_deref(),
        &snapshot.arguments_summary,
        snapshot.preset_id.as_deref(),
        snapshot.preset_description.as_deref(),
    )
}

fn task_work_display(
    task_id: &str,
    task_label: Option<&str>,
    arguments_summary: &str,
    preset_id: Option<&str>,
    preset_description: Option<&str>,
) -> WorkDisplay {
    let (label, summary) = match (preset_id, preset_description) {
        (Some(preset_id), description) => (
            Some(preset_id.to_owned()),
            description.and_then(normalize_work_summary),
        ),
        _ => (
            task_label.and_then(normalize_task_label),
            normalize_work_summary(arguments_summary),
        ),
    };
    WorkDisplay {
        id: task_id.to_owned(),
        label,
        summary,
    }
}

pub fn subagent_work_display(
    subagent_id: &str,
    name: Option<&str>,
    purpose: Option<&str>,
) -> WorkDisplay {
    WorkDisplay {
        id: subagent_id.to_owned(),
        label: name.and_then(normalize_task_label),
        summary: purpose.and_then(normalize_work_summary),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_request_deadline_arithmetic_and_expiration_boundary_are_exact() {
        let configured_deadline = Duration::from_millis(250);
        let requested_timeout = Duration::from_secs(5);
        let manager = BackgroundTaskManager::with_limits_and_task_request_deadline(
            DEFAULT_OUTPUT_TAIL_LIMIT,
            DEFAULT_MAX_RETAINED_TASKS,
            Duration::from_secs(DEFAULT_TASK_RETENTION_SECS),
            configured_deadline,
        );
        let task = manager.start_task_with_id(
            "t_deadline_boundary",
            NewBackgroundTask::new("call_deadline_boundary", "bash", "test"),
        );
        let admission = manager.accept_task_request(
            &task.task_id,
            TaskRequestFrame {
                id: "r1".to_owned(),
                request: "wait for reply".to_owned(),
                expect: None,
                timeout: Some(requested_timeout),
                urgency: InputUrgency::Normal,
            },
        );
        let TaskRequestAdmission::Accepted(request) = admission else {
            panic!("request should be accepted");
        };

        assert_eq!(request.requested_timeout, Some(requested_timeout));
        assert_eq!(request.effective_timeout, configured_deadline);
        assert_eq!(
            request.deadline_at,
            request.requested_at + request.effective_timeout
        );

        assert!(manager
            .expire_pending_requests_for_task(
                &task.task_id,
                request.deadline_at - Duration::from_nanos(1),
            )
            .is_empty());
        let expired = manager.expire_pending_requests_for_task(&task.task_id, request.deadline_at);
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].snapshot.state, TaskRequestState::Expired);
        assert_eq!(expired[0].snapshot.completed_at, Some(request.deadline_at));
    }

    #[test]
    fn callback_failure_commit_and_restore_require_matching_payload_reason_and_uncommitted_state() {
        let manager = BackgroundTaskManager::new();
        let task = manager.start_task(NewBackgroundTask::new(
            "call_callback_failure_guards",
            "bash",
            "test",
        ));
        manager
            .set_callback_pending(
                &task.task_id,
                "callback-right",
                vec![ContentPart::text("callback")],
            )
            .expect("callback should become pending");
        manager
            .stage_callback_failed_if_pending(&task.task_id, "reason-right")
            .expect("callback failure should be staged");

        assert!(manager
            .commit_callback_failed_if_payload(&task.task_id, "callback-wrong", "reason-right")
            .is_none());
        assert!(manager
            .commit_callback_failed_if_payload(&task.task_id, "callback-right", "reason-wrong")
            .is_none());
        assert!(manager
            .restore_callback_if_failed(
                &task.task_id,
                "callback-wrong",
                "reason-right",
                CallbackDelivery::Pending,
            )
            .is_none());
        assert!(manager
            .restore_callback_if_failed(
                &task.task_id,
                "callback-right",
                "reason-wrong",
                CallbackDelivery::Pending,
            )
            .is_none());

        manager
            .restore_callback_if_failed(
                &task.task_id,
                "callback-right",
                "reason-right",
                CallbackDelivery::Pending,
            )
            .expect("matching uncommitted failure should restore pending");
        let restored = manager.get(&task.task_id).expect("task should remain");
        assert_eq!(restored.callback_delivery, CallbackDelivery::Pending);
        assert_eq!(restored.callback_failure_reason, None);

        manager
            .stage_callback_failed_if_pending(&task.task_id, "reason-right")
            .expect("restored callback failure should stage again");
        manager
            .commit_callback_failed_if_payload(&task.task_id, "callback-right", "reason-right")
            .expect("matching staged failure should commit");
        assert!(manager
            .restore_callback_if_failed(
                &task.task_id,
                "callback-right",
                "reason-right",
                CallbackDelivery::Pending,
            )
            .is_none());

        let committed = manager.get(&task.task_id).expect("task should remain");
        assert_eq!(committed.callback_delivery, CallbackDelivery::Failed);
        assert_eq!(
            committed.callback_failure_reason.as_deref(),
            Some("reason-right")
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    mod unix_shared_stdin_writer {
        use super::*;
        use std::collections::HashSet;
        use std::fs::File;
        use std::io::Read;
        use std::os::fd::FromRawFd;
        use std::sync::Barrier;
        use std::time::{Duration, Instant};

        #[cfg(target_os = "macos")]
        fn set_cloexec(file: &File) {
            let fd = file.as_raw_fd();
            // SAFETY: fcntl is called with a valid fd.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            assert!(
                flags >= 0,
                "F_GETFD should succeed: {}",
                io::Error::last_os_error()
            );
            // SAFETY: fcntl updates descriptor flags for the same valid fd.
            let result = unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
            assert_eq!(
                result,
                0,
                "F_SETFD should succeed: {}",
                io::Error::last_os_error()
            );
        }

        fn pipe_files() -> (File, File) {
            let mut fds = [-1; 2];
            #[cfg(target_os = "linux")]
            // SAFETY: pipe2 writes two valid fds into the provided array on success.
            let result = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
            #[cfg(target_os = "macos")]
            // SAFETY: pipe writes two valid fds into the provided array on success.
            let result = unsafe { libc::pipe(fds.as_mut_ptr()) };
            assert_eq!(
                result,
                0,
                "pipe should succeed: {}",
                io::Error::last_os_error()
            );
            // SAFETY: pipe returned owned file descriptors.
            let read = unsafe { File::from_raw_fd(fds[0]) };
            // SAFETY: pipe returned owned file descriptors.
            let write = unsafe { File::from_raw_fd(fds[1]) };
            #[cfg(target_os = "macos")]
            {
                set_cloexec(&read);
                set_cloexec(&write);
            }
            (read, write)
        }

        fn set_nonblocking(file: &File) {
            let fd = file.as_raw_fd();
            // SAFETY: fcntl is called with a valid fd.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            assert!(
                flags >= 0,
                "F_GETFL should succeed: {}",
                io::Error::last_os_error()
            );
            // SAFETY: fcntl updates flags for the same valid fd.
            let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
            assert_eq!(
                result,
                0,
                "F_SETFL should succeed: {}",
                io::Error::last_os_error()
            );
        }

        #[test]
        fn managed_pipe_registration_uses_reported_cap_and_sets_nonblocking() {
            let (_read, write) = pipe_files();
            let raw_fd = write.as_raw_fd();
            // SAFETY: fpathconf reads a property from the valid pipe descriptor.
            let reported_pipe_buf = unsafe { libc::fpathconf(raw_fd, libc::_PC_PIPE_BUF) };
            assert!(
                reported_pipe_buf > 0,
                "real pipe must report a positive PIPE_BUF"
            );
            let expected_cap = usize::try_from(reported_pipe_buf)
                .expect("positive PIPE_BUF must fit usize")
                .min(TASK_STDIN_FRAME_SAFETY_CEILING);

            let writer = SharedTaskStdinWriter::new_managed_pipe(write)
                .expect("managed pipe registration should succeed");
            assert_eq!(writer.atomic_frame_cap(), expected_cap);

            // SAFETY: writer owns raw_fd for its full lifetime.
            let flags = unsafe { libc::fcntl(raw_fd, libc::F_GETFL) };
            assert!(flags >= 0, "registered fd flags must remain readable");
            assert_ne!(flags & libc::O_NONBLOCK, 0);
        }

        #[test]
        fn managed_pipe_cap_rejects_nonpositive_or_too_small_values() {
            for reported in [0, MIN_TASK_STDIN_FRAME_BYTES as libc::c_long - 1] {
                let error = managed_pipe_atomic_frame_cap(reported)
                    .expect_err("an unusable PIPE_BUF must be unsupported");
                assert!(error.contains("unsupported"), "{error}");
            }
        }

        #[test]
        fn every_frame_kind_uses_the_same_managed_pipe_write() {
            let (mut read, write) = pipe_files();
            let writer = SharedTaskStdinWriter::new_managed_pipe(write)
                .expect("managed pipe registration should succeed");
            let frames = [
                (
                    TaskStdinFrameKind::Reply,
                    b"<botified>{\"op\":\"reply\",\"id\":\"r1\",\"response\":\"yes\"}</botified>\n"
                        .as_slice(),
                ),
                (
                    TaskStdinFrameKind::Send,
                    b"<botified>{\"op\":\"send\",\"id\":\"s1\",\"message\":\"go\"}</botified>\n"
                        .as_slice(),
                ),
                (
                    TaskStdinFrameKind::Registry,
                    b"<botified>{\"op\":\"registry_snapshot\",\"id\":\"g1\",\"items\":[]}</botified>\n"
                        .as_slice(),
                ),
                (
                    TaskStdinFrameKind::Observe,
                    b"<botified>{\"op\":\"observe\",\"id\":\"o1\",\"event\":\"done\"}</botified>\n"
                        .as_slice(),
                ),
            ];

            for (kind, frame) in frames {
                try_write_task_stdin_frame(&writer, kind, frame)
                    .expect("all frame kinds should use the atomic write path");
            }

            let expected = frames
                .iter()
                .flat_map(|(_, frame)| frame.iter().copied())
                .collect::<Vec<_>>();
            let mut actual = vec![0u8; expected.len()];
            read.read_exact(&mut actual)
                .expect("all written frames should be readable");
            assert_eq!(actual, expected);
        }

        #[test]
        fn concurrent_managed_pipe_writes_preserve_complete_frames() {
            const WRITES_PER_KIND: usize = 12;
            let (mut read, write) = pipe_files();
            let writer = Arc::new(
                SharedTaskStdinWriter::new_managed_pipe(write)
                    .expect("managed pipe registration should succeed"),
            );
            let operations = [
                "reply",
                "send",
                "registry_snapshot",
                "observe_result",
                "observe",
            ];
            let expected = operations
                .iter()
                .flat_map(|operation| {
                    (0..WRITES_PER_KIND).map(move |index| {
                        format!(
                            "<botified>{{\"op\":\"{operation}\",\"id\":\"{operation}_{index}\"}}</botified>\n"
                        )
                    })
                })
                .collect::<HashSet<_>>();
            assert!(
                expected
                    .iter()
                    .all(|frame| frame.len() <= writer.atomic_frame_cap()),
                "test frames must fit the writer cap"
            );

            let drain = std::thread::spawn(move || {
                let mut bytes = Vec::new();
                read.read_to_end(&mut bytes)
                    .expect("draining the pipe should succeed");
                bytes
            });
            let barrier = Arc::new(Barrier::new(operations.len()));
            let workers = operations
                .into_iter()
                .map(|operation| {
                    let writer = writer.clone();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        for index in 0..WRITES_PER_KIND {
                            let frame = format!(
                                "<botified>{{\"op\":\"{operation}\",\"id\":\"{operation}_{index}\"}}</botified>\n"
                            );
                            writer
                                .try_write_frame(frame.as_bytes())
                                .expect("concurrent atomic write should succeed");
                        }
                    })
                })
                .collect::<Vec<_>>();
            for worker in workers {
                worker.join().expect("writer thread should not panic");
            }
            drop(writer);

            let bytes = drain.join().expect("drain thread should not panic");
            let text = String::from_utf8(bytes).expect("frames should be utf8");
            let actual = text
                .split_inclusive('\n')
                .map(str::to_owned)
                .collect::<HashSet<_>>();
            assert_eq!(actual, expected);
            assert!(actual.iter().all(|frame| {
                frame.starts_with("<botified>{") && frame.ends_with("}</botified>\n")
            }));
        }

        #[test]
        fn full_managed_pipe_fails_fast_without_partial_bytes() {
            let (mut read, write) = pipe_files();
            let writer = SharedTaskStdinWriter::new_managed_pipe(write)
                .expect("managed pipe registration should succeed");
            let fill = vec![b'x'; writer.atomic_frame_cap()];
            let rejected = vec![b'y'; writer.atomic_frame_cap()];
            let mut filled = 0usize;

            loop {
                match writer.try_write_frame(&fill) {
                    Ok(_) => filled += fill.len(),
                    Err(error) if error.contains("would block") => break,
                    Err(error) => panic!("unexpected fill error: {error}"),
                }
            }
            assert!(filled > 0, "pipe should accept at least one atomic write");

            let started = Instant::now();
            let error = writer
                .try_write_frame(&rejected)
                .expect_err("full pipe should reject the whole frame");
            assert!(started.elapsed() < Duration::from_millis(250));
            assert!(error.contains("would block"), "{error}");

            let mut drained = vec![0u8; filled];
            read.read_exact(&mut drained)
                .expect("read back filled pipe bytes");
            assert!(
                drained.iter().all(|byte| *byte == b'x'),
                "failed frame bytes must not appear in the pipe"
            );
            set_nonblocking(&read);
            let mut extra = [0u8; 1];
            let error = read
                .read(&mut extra)
                .expect_err("pipe should contain no trailing partial frame byte");
            assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        }

        #[test]
        fn frame_over_the_managed_pipe_cap_is_rejected_without_writing() {
            let (mut read, write) = pipe_files();
            let writer = SharedTaskStdinWriter::new_managed_pipe(write)
                .expect("managed pipe registration should succeed");
            let oversized = vec![b'x'; writer.atomic_frame_cap() + 1];

            let error = writer
                .try_write_frame(&oversized)
                .expect_err("oversized frame should be rejected");
            assert!(error.contains("atomic write limit"), "{error}");

            set_nonblocking(&read);
            let mut extra = [0u8; 1];
            let error = read
                .read(&mut extra)
                .expect_err("oversized frame must not write any bytes");
            assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        }

        #[test]
        fn managed_pipe_fd_lives_until_the_last_writer_owner_is_dropped() {
            let (mut read, write) = pipe_files();
            let manager = BackgroundTaskManager::new();
            let task = manager.start_task(NewBackgroundTask::new(
                "call_managed_pipe_ownership",
                "bash",
                "printf test",
            ));
            let writer: Arc<dyn TaskStdinWriter> = Arc::new(
                SharedTaskStdinWriter::new_managed_pipe(write)
                    .expect("managed pipe registration should succeed"),
            );
            let writer_lifetime = Arc::downgrade(&writer);
            manager
                .register_stdin_writer(&task.task_id, writer.clone())
                .expect("task should accept its managed stdin writer");
            drop(writer);
            assert!(
                writer_lifetime.upgrade().is_some(),
                "the task registry should retain the writer"
            );

            let remaining_owner = manager
                .stdin_writer(&task.task_id)
                .expect("registered writer should be cloneable by callers");
            manager.release_stdin_writer(&task.task_id);
            assert!(manager.stdin_writer(&task.task_id).is_none());
            let frame =
                b"<botified>{\"op\":\"send\",\"id\":\"s1\",\"message\":\"hello\"}</botified>\n";

            remaining_owner
                .try_write_frame(frame)
                .expect("remaining owner should keep the fd writable");
            drop(remaining_owner);
            assert!(
                writer_lifetime.upgrade().is_none(),
                "dropping the last caller should destroy the writer"
            );

            let mut drained = vec![0; frame.len()];
            read.read_exact(&mut drained)
                .expect("the frame should remain readable after writer close");
            assert_eq!(drained, frame);
        }
    }
}
