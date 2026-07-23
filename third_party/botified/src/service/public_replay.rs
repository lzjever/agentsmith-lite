use serde_json::Value;

use crate::agent_events::{is_public_terminal_event, project_thread_event, ThreadEvent};
use crate::event::ServiceEvent;
use crate::session::DurableMessageCursor;

use super::{
    prune_durable_message_replays_to_retained_window, prune_message_index_to_retained_window,
    DurableMessageReplay, ServiceInner,
};

#[derive(Debug, Default)]
pub(super) struct PublicReplayProjectionBuffer {
    pub(super) events: Vec<BufferedPublicReplayEvent>,
}

impl PublicReplayProjectionBuffer {
    pub(super) fn observe(&mut self, event: &ServiceEvent) {
        let Some(turn_id) = event.turn_id.clone() else {
            return;
        };
        if event.event_type == "queue.drained" {
            self.events.push(BufferedPublicReplayEvent {
                seq: event.seq,
                turn_id,
                kind: BufferedPublicReplayEventKind::QueueDrained {
                    message_ids: message_ids_from_event_data(&event.data),
                },
            });
            return;
        }
        if let Some(thread_event) = project_thread_event(event) {
            self.events.push(BufferedPublicReplayEvent {
                seq: event.seq,
                turn_id,
                kind: BufferedPublicReplayEventKind::Public(Box::new(thread_event)),
            });
        }
    }

    fn events_after(&self, after_seq: u64) -> Vec<BufferedPublicReplayEvent> {
        self.events
            .iter()
            .filter(|event| event.seq > after_seq)
            .cloned()
            .collect()
    }

    fn prune_through(&mut self, terminal_seq: u64) {
        self.events.retain(|event| event.seq > terminal_seq);
    }
}

#[derive(Debug, Clone)]
pub(super) struct BufferedPublicReplayEvent {
    seq: u64,
    turn_id: String,
    kind: BufferedPublicReplayEventKind,
}

#[derive(Debug, Clone)]
enum BufferedPublicReplayEventKind {
    QueueDrained { message_ids: Vec<String> },
    Public(Box<ThreadEvent>),
}

pub(super) fn durable_terminal_seq(
    replay_start_seq: u64,
    raw_terminal_seq: u64,
    has_events: bool,
) -> u64 {
    let terminal_seq = if raw_terminal_seq == 0 {
        replay_start_seq
    } else {
        raw_terminal_seq
    };
    if has_events {
        terminal_seq.max(replay_start_seq.saturating_add(1))
    } else {
        terminal_seq
    }
}

pub(super) fn persist_public_replay(inner: &ServiceInner, after_seq: u64) -> Result<(), String> {
    let Some(recorder) = inner.session_recorder.as_ref() else {
        return Ok(());
    };

    let buffered_plan = plan_buffered_public_replay_cursors(inner, after_seq);
    let raw_events = inner
        .event_log
        .lock()
        .expect("event log mutex poisoned")
        .read_after(after_seq);
    if raw_events
        .iter()
        .any(|event| event.event_type == "event.gap")
        && !buffered_plan.complete
    {
        return Err("public replay cursor persistence failed: event gap in replay window".into());
    }
    if raw_events.is_empty()
        && buffered_plan.cursors.is_empty()
        && buffered_plan.prune_through_seq.is_none()
    {
        return Ok(());
    }

    let use_buffered_plan = buffered_plan.complete && buffered_plan.prune_through_seq.is_some();
    let new_message_cursors = if use_buffered_plan {
        buffered_plan.cursors
    } else {
        let raw_plan = plan_raw_public_replay_cursors(inner, &raw_events);
        if !raw_plan.complete {
            return Err(
                "public replay cursor persistence failed: incomplete replay projection".into(),
            );
        }
        raw_plan.cursors
    };
    let prune_through_seq = if use_buffered_plan {
        buffered_plan.prune_through_seq
    } else {
        plan_raw_public_replay_prune_through(&raw_events, &new_message_cursors)
    };

    for cursor in &new_message_cursors {
        if let Err(error) = recorder.record_message_cursor_sync(cursor) {
            return Err(error.to_string());
        }
        install_durable_message_replay(inner, cursor);
    }

    if let Some(prune_through_seq) = prune_through_seq {
        inner
            .public_replay
            .lock()
            .expect("public replay projection buffer mutex poisoned")
            .prune_through(prune_through_seq);
    }
    Ok(())
}

fn install_durable_message_replay(inner: &ServiceInner, cursor: &DurableMessageCursor) {
    let mut state = inner.state.lock().expect("service state mutex poisoned");
    state
        .durable_message_replays
        .entry(cursor.message_id.clone())
        .or_insert_with(|| DurableMessageReplay {
            replay_start_seq: cursor.replay_start_seq,
            terminal_seq: cursor.terminal_seq,
            events: cursor.replay_events.clone(),
        });
    prune_durable_message_replays_to_retained_window(&mut state);
    prune_message_index_to_retained_window(&mut state);
}

pub(super) fn plan_raw_public_replay_cursors(
    inner: &ServiceInner,
    raw_events: &[ServiceEvent],
) -> RawReplayPlan {
    let projection_events = raw_replay_projection_events(raw_events);
    let state = inner.state.lock().expect("service state mutex poisoned");
    let mut planned = Vec::new();
    let mut complete = true;

    for event in &projection_events {
        let Some(message_ids) = event.queue_drained_message_ids() else {
            continue;
        };
        for message_id in message_ids {
            if state.durable_message_replays.contains_key(message_id) {
                continue;
            }
            let replay_start_seq = state
                .message_index
                .get(message_id)
                .map(|entry| entry.cursor.seq())
                .unwrap_or(0);
            let Some(projection) =
                durable_message_projection_from_events(&projection_events, message_id)
            else {
                complete = false;
                continue;
            };
            planned.push(durable_message_cursor(
                message_id.clone(),
                replay_start_seq,
                projection,
            ));
        }
    }
    RawReplayPlan {
        cursors: planned,
        complete,
    }
}

fn plan_raw_public_replay_prune_through(
    raw_events: &[ServiceEvent],
    cursors: &[DurableMessageCursor],
) -> Option<u64> {
    raw_events
        .iter()
        .filter_map(|event| {
            project_thread_event(event)
                .filter(is_public_terminal_event)
                .map(|_| event.seq)
        })
        .max()
        .or_else(|| cursors.iter().map(|cursor| cursor.terminal_seq).max())
}

pub(super) struct RawReplayPlan {
    pub(super) cursors: Vec<DurableMessageCursor>,
    pub(super) complete: bool,
}

pub(super) fn plan_buffered_public_replay_cursors(
    inner: &ServiceInner,
    after_seq: u64,
) -> BufferedReplayPlan {
    let buffered_events = inner
        .public_replay
        .lock()
        .expect("public replay projection buffer mutex poisoned")
        .events_after(after_seq);
    if buffered_events.is_empty() {
        return BufferedReplayPlan::incomplete();
    }
    let projection_events = buffered_replay_projection_events(&buffered_events);

    let prune_through_seq = projection_events
        .iter()
        .filter_map(|event| {
            event
                .public_event()
                .filter(|public_event| is_public_terminal_event(public_event))
                .map(|_| event.seq)
        })
        .max();
    let state = inner.state.lock().expect("service state mutex poisoned");
    let mut planned = Vec::new();
    let mut complete = prune_through_seq.is_some();
    for event in &projection_events {
        let Some(message_ids) = event.queue_drained_message_ids() else {
            continue;
        };
        for message_id in message_ids {
            if state.durable_message_replays.contains_key(message_id) {
                continue;
            }
            let replay_start_seq = state
                .message_index
                .get(message_id)
                .map(|entry| entry.cursor.seq())
                .unwrap_or(0);
            let Some(projection) =
                durable_message_projection_from_events(&projection_events, message_id)
            else {
                complete = false;
                continue;
            };
            planned.push(durable_message_cursor(
                message_id.clone(),
                replay_start_seq,
                projection,
            ));
        }
    }
    BufferedReplayPlan {
        cursors: planned,
        complete,
        prune_through_seq,
    }
}

pub(super) struct BufferedReplayPlan {
    pub(super) cursors: Vec<DurableMessageCursor>,
    pub(super) complete: bool,
    prune_through_seq: Option<u64>,
}

impl BufferedReplayPlan {
    fn incomplete() -> Self {
        Self {
            cursors: Vec::new(),
            complete: false,
            prune_through_seq: None,
        }
    }
}

fn durable_message_cursor(
    message_id: String,
    replay_start_seq: u64,
    projection: DurableMessageProjection,
) -> DurableMessageCursor {
    let terminal_seq = durable_terminal_seq(
        replay_start_seq,
        projection.terminal_seq,
        !projection.events.is_empty(),
    );
    DurableMessageCursor {
        message_id,
        replay_start_seq,
        terminal_seq,
        replay_events: projection.events,
    }
}

#[derive(Debug, Clone)]
struct ReplayProjectionEvent {
    seq: u64,
    turn_id: Option<String>,
    kind: ReplayProjectionEventKind,
}

#[derive(Debug, Clone)]
enum ReplayProjectionEventKind {
    QueueDrained { message_ids: Vec<String> },
    Public(Box<ThreadEvent>),
}

impl ReplayProjectionEvent {
    fn queue_drained_message_ids(&self) -> Option<&[String]> {
        match &self.kind {
            ReplayProjectionEventKind::QueueDrained { message_ids } => Some(message_ids.as_slice()),
            ReplayProjectionEventKind::Public(_) => None,
        }
    }

    fn is_queue_drained_for_message(&self, message_id: &str) -> bool {
        self.queue_drained_message_ids()
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == message_id))
    }

    fn is_queue_drained_for_turn(&self, turn_id: &str) -> bool {
        self.turn_id.as_deref() == Some(turn_id)
            && matches!(self.kind, ReplayProjectionEventKind::QueueDrained { .. })
    }

    fn is_turn_started_for(&self, turn_id: &str) -> bool {
        self.turn_id.as_deref() == Some(turn_id)
            && matches!(self.public_event(), Some(ThreadEvent::TurnStarted))
    }

    fn public_event(&self) -> Option<&ThreadEvent> {
        match &self.kind {
            ReplayProjectionEventKind::Public(public_event) => Some(public_event.as_ref()),
            ReplayProjectionEventKind::QueueDrained { .. } => None,
        }
    }
}

fn raw_replay_projection_events(raw_events: &[ServiceEvent]) -> Vec<ReplayProjectionEvent> {
    raw_events
        .iter()
        .filter_map(|event| {
            if event.event_type == "queue.drained" {
                return Some(ReplayProjectionEvent {
                    seq: event.seq,
                    turn_id: event.turn_id.clone(),
                    kind: ReplayProjectionEventKind::QueueDrained {
                        message_ids: message_ids_from_event_data(&event.data),
                    },
                });
            }
            project_thread_event(event).map(|public_event| ReplayProjectionEvent {
                seq: event.seq,
                turn_id: event.turn_id.clone(),
                kind: ReplayProjectionEventKind::Public(Box::new(public_event)),
            })
        })
        .collect()
}

fn buffered_replay_projection_events(
    buffered_events: &[BufferedPublicReplayEvent],
) -> Vec<ReplayProjectionEvent> {
    buffered_events
        .iter()
        .map(|event| ReplayProjectionEvent {
            seq: event.seq,
            turn_id: Some(event.turn_id.clone()),
            kind: match &event.kind {
                BufferedPublicReplayEventKind::QueueDrained { message_ids } => {
                    ReplayProjectionEventKind::QueueDrained {
                        message_ids: message_ids.clone(),
                    }
                }
                BufferedPublicReplayEventKind::Public(public_event) => {
                    ReplayProjectionEventKind::Public(public_event.clone())
                }
            },
        })
        .collect()
}

fn durable_message_projection_from_events(
    events: &[ReplayProjectionEvent],
    message_id: &str,
) -> Option<DurableMessageProjection> {
    let target = find_replay_projection_target(events, message_id)?;

    let mut selected = Vec::new();
    let mut terminal_seq = None;
    let start_index = if target.synthetic_start {
        selected.push(ThreadEvent::TurnStarted);
        target.start_index + 1
    } else {
        target.start_index
    };

    for (index, event) in events.iter().enumerate().skip(start_index) {
        if index > target.drain_index && event.is_queue_drained_for_turn(&target.turn_id) {
            selected.push(synthetic_turn_completed_event());
            terminal_seq = Some(event.seq);
            break;
        }
        if event.turn_id.as_deref() != Some(target.turn_id.as_str()) {
            continue;
        }
        if let Some(public_event) = event.public_event() {
            let terminal = is_public_terminal_event(public_event);
            selected.push(public_event.clone());
            if terminal {
                terminal_seq = Some(event.seq);
                break;
            }
        }
    }

    terminal_seq.map(|terminal_seq| DurableMessageProjection {
        terminal_seq,
        events: selected,
    })
}

fn find_replay_projection_target(
    events: &[ReplayProjectionEvent],
    message_id: &str,
) -> Option<DurableMessageTarget> {
    let drain_index = events
        .iter()
        .position(|event| event.is_queue_drained_for_message(message_id))?;
    let turn_id = events[drain_index].turn_id.clone()?;
    let prior_batch_in_turn = events
        .iter()
        .take(drain_index)
        .any(|event| event.is_queue_drained_for_turn(&turn_id));
    let start_index = if prior_batch_in_turn {
        None
    } else {
        events
            .iter()
            .take(drain_index)
            .position(|event| event.is_turn_started_for(&turn_id))
    };
    let (start_index, synthetic_start) = start_index
        .map(|index| (index, false))
        .unwrap_or((drain_index, true));

    Some(DurableMessageTarget {
        turn_id,
        drain_index,
        start_index,
        synthetic_start,
    })
}

pub(super) fn synthetic_turn_completed_event() -> ThreadEvent {
    ThreadEvent::TurnCompleted {
        usage: crate::agent_events::AgentUsage::default(),
    }
}

struct DurableMessageTarget {
    turn_id: String,
    drain_index: usize,
    start_index: usize,
    synthetic_start: bool,
}

struct DurableMessageProjection {
    terminal_seq: u64,
    events: Vec<ThreadEvent>,
}

fn message_ids_from_event_data(data: &Value) -> Vec<String> {
    data.get("message_ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
