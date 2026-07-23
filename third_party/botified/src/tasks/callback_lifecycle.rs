use std::time::SystemTime;

use crate::{formatting::bounded_chars, types::ContentPart};

use super::{BackgroundTaskManager, CallbackDelivery, TaskCallbackPayloadSnapshot, TaskSnapshot};

const TASK_CALLBACK_PAYLOAD_TEXT_CHARS: usize = 16 * 1024;
const TASK_CALLBACK_FAILURE_REASON_CHARS: usize = 512;

impl BackgroundTaskManager {
    pub fn set_callback_delivery(
        &self,
        task_id: &str,
        delivery: CallbackDelivery,
    ) -> Option<TaskSnapshot> {
        self.mutate_task(task_id, |record| {
            record.callback_delivery = delivery;
            record.callback_failure_committed = false;
        })
    }

    pub fn mark_terminal_callback_delivered_to_owner(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task_if(task_id, |record| {
            if !record.state.is_terminal() || record.callback_delivery != CallbackDelivery::NotReady
            {
                return false;
            }
            record.callback_delivery = CallbackDelivery::Delivered;
            record.callback_failure_committed = false;
            true
        })
    }

    pub fn set_callback_pending(
        &self,
        task_id: &str,
        message_id: impl Into<String>,
        content: Vec<ContentPart>,
    ) -> Option<TaskSnapshot> {
        let message_id = message_id.into();
        self.mutate_task(task_id, |record| {
            record.callback_delivery = CallbackDelivery::Pending;
            record.callback_payload = Some(TaskCallbackPayloadRecord::new(
                record.task_id.clone(),
                message_id,
                content,
            ));
            record.callback_failure_reason = None;
            record.callback_failure_committed = false;
        })
    }

    pub(crate) fn clear_callback_pending_if_payload(
        &self,
        task_id: &str,
        message_id: &str,
    ) -> Option<TaskSnapshot> {
        self.mutate_task_if(task_id, |record| {
            if record.callback_delivery != CallbackDelivery::Pending {
                return false;
            }
            if record
                .callback_payload
                .as_ref()
                .is_none_or(|payload| payload.message_id != message_id)
            {
                return false;
            }
            record.callback_delivery = CallbackDelivery::NotReady;
            record.callback_payload = None;
            record.callback_failure_reason = None;
            record.callback_failure_committed = false;
            true
        })
    }

    pub fn set_callback_enqueued(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task(task_id, |record| {
            record.callback_delivery = CallbackDelivery::Enqueued;
            record.callback_failure_reason = None;
            record.callback_failure_committed = false;
        })
    }

    pub fn set_callback_enqueued_if_pending(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.mutate_task_if(task_id, |record| {
            if record.callback_delivery != CallbackDelivery::Pending {
                return false;
            }
            record.callback_delivery = CallbackDelivery::Enqueued;
            record.callback_failure_reason = None;
            record.callback_failure_committed = false;
            true
        })
    }

    pub(crate) fn restore_callback_pending_if_enqueued(
        &self,
        task_id: &str,
        message_id: &str,
    ) -> Option<TaskSnapshot> {
        self.mutate_task_if(task_id, |record| {
            if record.callback_delivery != CallbackDelivery::Enqueued {
                return false;
            }
            if record
                .callback_payload
                .as_ref()
                .is_none_or(|payload| payload.message_id != message_id)
            {
                return false;
            }
            record.callback_delivery = CallbackDelivery::Pending;
            record.callback_failure_reason = None;
            record.callback_failure_committed = false;
            true
        })
    }

    pub fn set_callback_delivered_by_input_id(
        &self,
        callback_input_id: &str,
    ) -> Option<TaskSnapshot> {
        let (snapshot, retired) = {
            let mut inner = self.inner.lock().expect("task manager lock poisoned");
            let snapshot = {
                let record = inner.tasks.values_mut().find(|record| {
                    record
                        .callback_payload
                        .as_ref()
                        .is_some_and(|payload| payload.message_id == callback_input_id)
                })?;
                record.callback_delivery = CallbackDelivery::Delivered;
                record.callback_failure_reason = None;
                record.callback_failure_committed = false;
                record.snapshot()
            };
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

    pub fn set_callback_failed(
        &self,
        task_id: &str,
        reason: impl Into<String>,
    ) -> Option<TaskSnapshot> {
        self.set_callback_failed_committed(task_id, reason)
    }

    pub(crate) fn set_callback_failed_committed(
        &self,
        task_id: &str,
        reason: impl Into<String>,
    ) -> Option<TaskSnapshot> {
        let reason = bounded_chars(&reason.into(), TASK_CALLBACK_FAILURE_REASON_CHARS);
        self.mutate_task(task_id, |record| {
            record.callback_delivery = CallbackDelivery::Failed;
            record.callback_failure_reason = Some(reason);
            record.callback_failure_committed = true;
        })
    }

    pub fn set_callback_failed_by_input_id(
        &self,
        callback_input_id: &str,
        reason: impl Into<String>,
    ) -> Option<TaskSnapshot> {
        let reason = bounded_chars(&reason.into(), TASK_CALLBACK_FAILURE_REASON_CHARS);
        let (snapshot, retired) = {
            let mut inner = self.inner.lock().expect("task manager lock poisoned");
            let snapshot = {
                let record = inner.tasks.values_mut().find(|record| {
                    record
                        .callback_payload
                        .as_ref()
                        .is_some_and(|payload| payload.message_id == callback_input_id)
                })?;
                record.callback_delivery = CallbackDelivery::Failed;
                record.callback_failure_reason = Some(reason);
                record.callback_failure_committed = true;
                record.snapshot()
            };
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

    pub(crate) fn stage_callback_failed_for_compaction(
        &self,
        task_id: &str,
        reason: impl Into<String>,
    ) -> Option<(TaskSnapshot, CallbackDelivery)> {
        let reason = bounded_chars(&reason.into(), TASK_CALLBACK_FAILURE_REASON_CHARS);
        let mut inner = self.inner.lock().expect("task manager lock poisoned");
        let record = inner.tasks.get_mut(task_id)?;
        let previous_delivery = record.callback_delivery;
        if !matches!(
            previous_delivery,
            CallbackDelivery::Enqueued | CallbackDelivery::Delivered
        ) {
            return None;
        }
        record.callback_delivery = CallbackDelivery::Failed;
        record.callback_failure_reason = Some(reason);
        record.callback_failure_committed = false;
        Some((record.snapshot(), previous_delivery))
    }

    pub fn set_callback_failed_if_pending(
        &self,
        task_id: &str,
        reason: impl Into<String>,
    ) -> Option<TaskSnapshot> {
        self.stage_callback_failed_if_pending(task_id, reason)
    }

    pub(crate) fn stage_callback_failed_if_pending(
        &self,
        task_id: &str,
        reason: impl Into<String>,
    ) -> Option<TaskSnapshot> {
        self.stage_callback_failed_if(task_id, CallbackDelivery::Pending, reason)
    }

    fn stage_callback_failed_if(
        &self,
        task_id: &str,
        expected_delivery: CallbackDelivery,
        reason: impl Into<String>,
    ) -> Option<TaskSnapshot> {
        let reason = bounded_chars(&reason.into(), TASK_CALLBACK_FAILURE_REASON_CHARS);
        self.mutate_task_if(task_id, |record| {
            if record.callback_delivery != expected_delivery {
                return false;
            }
            record.callback_delivery = CallbackDelivery::Failed;
            record.callback_failure_reason = Some(reason);
            record.callback_failure_committed = false;
            true
        })
    }

    pub(crate) fn commit_callback_failed_if_payload(
        &self,
        task_id: &str,
        message_id: &str,
        reason: &str,
    ) -> Option<TaskSnapshot> {
        let reason = bounded_chars(reason, TASK_CALLBACK_FAILURE_REASON_CHARS);
        self.mutate_task_if(task_id, |record| {
            if record.callback_delivery != CallbackDelivery::Failed
                || record.callback_failure_reason.as_deref() != Some(reason.as_str())
                || record
                    .callback_payload
                    .as_ref()
                    .is_none_or(|payload| payload.message_id != message_id)
            {
                return false;
            }
            record.callback_failure_committed = true;
            true
        })
    }

    pub(crate) fn restore_callback_if_failed(
        &self,
        task_id: &str,
        message_id: &str,
        reason: &str,
        delivery: CallbackDelivery,
    ) -> Option<TaskSnapshot> {
        let reason = bounded_chars(reason, TASK_CALLBACK_FAILURE_REASON_CHARS);
        self.mutate_task_if(task_id, |record| {
            if record.callback_delivery != CallbackDelivery::Failed
                || record.callback_failure_committed
                || record.callback_failure_reason.as_deref() != Some(reason.as_str())
                || record
                    .callback_payload
                    .as_ref()
                    .is_none_or(|payload| payload.message_id != message_id)
            {
                return false;
            }
            record.callback_delivery = delivery;
            record.callback_failure_reason = None;
            record.callback_failure_committed = false;
            true
        })
    }

    pub fn pending_callbacks(&self) -> Vec<TaskCallbackPayloadSnapshot> {
        self.inner
            .lock()
            .expect("task manager lock poisoned")
            .tasks
            .values()
            .filter(|record| record.callback_delivery == CallbackDelivery::Pending)
            .filter_map(|record| {
                record
                    .callback_payload
                    .as_ref()
                    .map(|payload| payload.snapshot())
            })
            .collect()
    }

    pub fn should_retain_for_callback(&self, task_id: &str) -> Option<bool> {
        self.get(task_id)
            .map(|snapshot| snapshot.requires_callback_retention())
    }
}

#[derive(Debug, Clone)]
pub(super) struct TaskCallbackPayloadRecord {
    task_id: String,
    message_id: String,
    content: Vec<ContentPart>,
}

impl TaskCallbackPayloadRecord {
    fn new(task_id: String, message_id: String, content: Vec<ContentPart>) -> Self {
        Self {
            task_id,
            message_id,
            content: bounded_content_parts(content, TASK_CALLBACK_PAYLOAD_TEXT_CHARS),
        }
    }

    pub(super) fn snapshot(&self) -> TaskCallbackPayloadSnapshot {
        TaskCallbackPayloadSnapshot {
            task_id: self.task_id.clone(),
            message_id: self.message_id.clone(),
            content: self.content.clone(),
        }
    }
}

fn bounded_content_parts(content: Vec<ContentPart>, max_chars: usize) -> Vec<ContentPart> {
    content
        .into_iter()
        .map(|part| match part {
            ContentPart::Text { text } => ContentPart::text(bounded_chars(&text, max_chars)),
            ContentPart::ImageUrl { url } => ContentPart::image_url(bounded_chars(&url, max_chars)),
            ContentPart::ImageBase64 { mime_type, data } => {
                ContentPart::image_base64(mime_type, bounded_chars(&data, max_chars))
            }
            ContentPart::File { binding } => ContentPart::File { binding },
            ContentPart::Skill {
                name,
                path,
                arguments,
            } => ContentPart::Skill {
                name: name.map(|value| bounded_chars(&value, max_chars)),
                path: path.map(|value| bounded_chars(&value, max_chars)),
                arguments: arguments.map(|value| bounded_chars(&value, max_chars)),
            },
        })
        .collect()
}
