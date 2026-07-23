async fn wait_for_service_workers_idle(service: &Service) {
    wait_until(|| {
        service
            .inner
            .state
            .lock()
            .expect("service state mutex poisoned")
            .service_workers
            .active_count()
            == 0
    })
    .await;
}

fn service_context_len(service: &Service) -> usize {
    service
        .inner
        .state
        .lock()
        .expect("service state mutex poisoned")
        .context
        .len()
}

fn task_request_count(service: &Service, task_id: &str) -> usize {
    service
        .inner
        .background_tasks
        .get(task_id)
        .map(|task| task.requests.len())
        .unwrap_or(0)
}

fn botified_frame_strings(text: &str) -> Vec<String> {
    let mut frames = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("<botified>") {
        let after_start = start + "<botified>".len();
        let Some(relative_end) = rest[after_start..].find("</botified>") else {
            break;
        };
        let end = after_start + relative_end + "</botified>".len();
        frames.push(rest[start..end].to_owned());
        rest = &rest[end..];
    }
    frames
}

fn botified_json_from_frame(frame: &str) -> Value {
    let start = frame
        .find("<botified>")
        .expect("frame should contain botified open tag")
        + "<botified>".len();
    let end = frame[start..]
        .find("</botified>")
        .expect("frame should contain botified close tag")
        + start;
    serde_json::from_str(&frame[start..end]).expect("botified frame should contain JSON")
}

fn first_botified_json(text: &str) -> Value {
    let start = text
        .find("<botified>")
        .expect("stdin should contain botified open tag")
        + "<botified>".len();
    let end = text[start..]
        .find("</botified>")
        .expect("stdin should contain botified close tag")
        + start;
    serde_json::from_str(&text[start..end]).expect("botified frame should contain JSON")
}

fn input_queue_test_message(id: &str, urgency: InputUrgency, source: InputSource) -> QueuedMessage {
    QueuedMessage {
        id: id.to_owned(),
        content: vec![ContentPart::text(format!("content for {id}"))],
        source,
        urgency,
        metadata: None,
        cursor_seq: 10,
        delivery: None,
    }
}

fn input_queue_task_request_message(id: &str, task_id: &str, request_id: &str) -> QueuedMessage {
    QueuedMessage {
        id: id.to_owned(),
        content: vec![ContentPart::text("task request")],
        source: InputSource::TaskRequest,
        urgency: InputUrgency::Urgent,
        metadata: Some(QueuedInputMetadata::TaskRequest {
            task_id: task_id.to_owned(),
            request_id: request_id.to_owned(),
        }),
        cursor_seq: 42,
        delivery: None,
    }
}

fn replay_known_message(index: usize) -> DrainedMessage {
    DrainedMessage::new(
        format!("msg_{index}"),
        vec![ContentPart::text(format!("known {index}"))],
    )
}

fn replay_cursor(index: usize) -> DurableMessageCursor {
    DurableMessageCursor {
        message_id: format!("msg_{index}"),
        replay_start_seq: index as u64 + 10,
        terminal_seq: index as u64 + 11,
        replay_events: vec![
            ThreadEvent::TurnStarted,
            ThreadEvent::TurnCompleted {
                usage: crate::agent_events::AgentUsage::default(),
            },
        ],
    }
}

fn input_queue_batch_ids(batch: &DrainBatch) -> Vec<String> {
    batch
        .messages
        .iter()
        .map(|message| message.id.clone())
        .collect()
}
