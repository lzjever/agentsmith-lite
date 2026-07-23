use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, Uri};
use axum::response::{IntoResponse, Response};
use futures_util::stream;
use serde_json::json;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::event::EventCursor;
use crate::formatting::unix_timestamp_now;
use crate::llm_text_preview::{
    LlmTextPreviewFilter, LlmTextPreviewFrame, LlmTextPreviewSubscription,
};
use crate::service::Service;
use crate::timeline::{push_timeline_event_line, TimelineEnvelope, TimelineItem, TimelineTrace};
use crate::timeline_store::{
    HistoryBoundary, TimelineForwardPage, TimelineHistoryPage, DEFAULT_TIMELINE_PAGE_LIMIT,
    MAX_TIMELINE_PAGE_LIMIT,
};

use super::{authorize, run_timeline_blocking_task, ApiError, HttpState, HISTORY_BOUNDARY_HEADER};

const NEXT_CURSOR_HEADER: &str = "x-botified-next-cursor";
const HAS_MORE_AFTER_HEADER: &str = "x-botified-has-more-after";
const PAGE_START_CURSOR_HEADER: &str = "x-botified-page-start-cursor";
const PAGE_END_CURSOR_HEADER: &str = "x-botified-page-end-cursor";
const HAS_MORE_BEFORE_HEADER: &str = "x-botified-has-more-before";
const TIMELINE_FOLLOW_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const TIMELINE_FOLLOW_BATCH_LIMIT: usize = 64;

pub(super) async fn timeline_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;

    let query = parse_timeline_query(uri.query().unwrap_or_default())?;
    match query {
        TimelineQuery::Forward {
            cursor,
            follow,
            limit: _,
        } if follow => {
            let initial_page = read_timeline_forward_page(
                state.service.clone(),
                cursor.clone(),
                1,
                state.timeline_blocking_slots.clone(),
            )
            .await?;
            let permit = state
                .timeline_follow_slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| ApiError::timeline_follow_connection_limit())?;
            let body = timeline_stream_body(
                state.service.clone(),
                cursor,
                initial_page,
                permit,
                state.timeline_blocking_slots.clone(),
            );
            Ok((
                [(
                    header::CONTENT_TYPE.as_str(),
                    "application/x-ndjson".to_owned(),
                )],
                body,
            )
                .into_response())
        }
        TimelineQuery::Forward {
            cursor,
            follow: _,
            limit,
        } => {
            let page = read_timeline_forward_page(
                state.service.clone(),
                cursor,
                limit,
                state.timeline_blocking_slots.clone(),
            )
            .await?;
            Ok(timeline_forward_response(page))
        }
        TimelineQuery::Backward { cursor, limit } => {
            let page = read_timeline_backward_page(
                state.service.clone(),
                cursor,
                limit,
                state.timeline_blocking_slots.clone(),
            )
            .await?;
            Ok(timeline_history_response(page))
        }
        TimelineQuery::Tail { limit } => {
            let page = read_timeline_tail_page(
                state.service.clone(),
                limit,
                state.timeline_blocking_slots.clone(),
            )
            .await?;
            Ok(timeline_history_response(page))
        }
    }
}

pub(super) async fn llm_text_preview_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    if headers.contains_key("last-event-id") {
        return Err(ApiError::unsupported_last_event_id());
    }

    let filter = parse_llm_text_preview_query(uri.query().unwrap_or_default())?;
    let Some(subscription) = state.service.subscribe_llm_text_preview(filter) else {
        return Err(ApiError::preview_disabled());
    };
    let permit = state
        .llm_text_preview_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::preview_subscription_limit())?;

    Ok((
        [
            (header::CONTENT_TYPE.as_str(), "text/event-stream"),
            (header::CACHE_CONTROL.as_str(), "no-cache"),
        ],
        llm_text_preview_stream_body(subscription, permit),
    )
        .into_response())
}

enum TimelineQuery {
    Forward {
        cursor: String,
        follow: bool,
        limit: usize,
    },
    Backward {
        cursor: String,
        limit: usize,
    },
    Tail {
        limit: usize,
    },
}

fn parse_timeline_query(query: &str) -> Result<TimelineQuery, ApiError> {
    let mut cursor: Option<String> = None;
    let mut follow = false;
    let mut limit = None;
    let mut direction = None;
    let mut tail = None;
    let mut seen_keys = Vec::new();

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let Some((key, value)) = pair.split_once('=') else {
            return Err(ApiError::invalid_request("invalid query string"));
        };
        if seen_keys.contains(&key) {
            return Err(ApiError::invalid_request("duplicate query parameter"));
        }
        seen_keys.push(key);
        match key {
            "cursor" => {
                EventCursor::parse_timeline(value)
                    .map_err(|_| ApiError::invalid_request("invalid cursor"))?;
                cursor = Some(value.to_owned());
            }
            "follow" => {
                follow = match value {
                    "true" => true,
                    "false" => false,
                    _ => return Err(ApiError::invalid_request("invalid follow")),
                };
            }
            "limit" => {
                limit = Some(parse_timeline_limit(value, "limit")?);
            }
            "direction" => {
                direction = Some(value.to_owned());
            }
            "tail" => {
                tail = Some(parse_timeline_limit(value, "tail")?);
            }
            _ => return Err(ApiError::invalid_request("unknown query parameter")),
        }
    }

    if let Some(tail) = tail {
        if cursor.is_some() || direction.is_some() || limit.is_some() || follow {
            return Err(ApiError::invalid_request("invalid timeline query"));
        }
        return Ok(TimelineQuery::Tail { limit: tail });
    }

    match direction.as_deref() {
        Some("backward") => {
            if follow {
                return Err(ApiError::invalid_request("invalid timeline query"));
            }
            let cursor = cursor.ok_or_else(|| ApiError::invalid_request("cursor is required"))?;
            let limit = limit.ok_or_else(|| ApiError::invalid_request("limit is required"))?;
            Ok(TimelineQuery::Backward { cursor, limit })
        }
        Some("forward") | Some(_) => Err(ApiError::invalid_request("invalid direction")),
        None => {
            let cursor = cursor.ok_or_else(|| ApiError::invalid_request("cursor is required"))?;
            if follow && limit.is_some() {
                return Err(ApiError::invalid_request("invalid timeline query"));
            }
            Ok(TimelineQuery::Forward {
                cursor,
                follow,
                limit: limit.unwrap_or(DEFAULT_TIMELINE_PAGE_LIMIT),
            })
        }
    }
}

fn parse_timeline_limit(value: &str, name: &str) -> Result<usize, ApiError> {
    let parsed = value
        .parse::<usize>()
        .map_err(|_| ApiError::invalid_request(format!("invalid {name}")))?;
    if !(1..=MAX_TIMELINE_PAGE_LIMIT).contains(&parsed) {
        return Err(ApiError::invalid_request(format!("invalid {name}")));
    }
    Ok(parsed)
}

fn parse_llm_text_preview_query(query: &str) -> Result<LlmTextPreviewFilter, ApiError> {
    let mut filter = LlmTextPreviewFilter::default();
    let mut seen_keys = Vec::new();

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let Some((key, value)) = pair.split_once('=') else {
            return Err(ApiError::invalid_request("invalid query string"));
        };
        if seen_keys.contains(&key) {
            return Err(ApiError::invalid_request("duplicate query parameter"));
        }
        seen_keys.push(key);
        match key {
            "provider_request_id" => filter.provider_request_id = Some(value.to_owned()),
            "cycle_id" => filter.cycle_id = Some(value.to_owned()),
            "input_id" => filter.input_id = Some(value.to_owned()),
            "cursor" | "seq" | "follow" | "replay" | "since" => {
                return Err(ApiError::invalid_request(
                    "llm text preview does not support replay or cursor parameters",
                ));
            }
            _ => return Err(ApiError::invalid_request("unknown query parameter")),
        }
    }

    Ok(filter)
}

fn timeline_stream_body(
    service: Service,
    cursor: String,
    initial_page: TimelineForwardPage,
    permit: OwnedSemaphorePermit,
    timeline_blocking_slots: Arc<Semaphore>,
) -> Body {
    Body::from_stream(stream::unfold(
        TimelineStreamState::new(
            service,
            cursor,
            initial_page,
            permit,
            timeline_blocking_slots,
        ),
        next_timeline_stream_chunk,
    ))
}

fn llm_text_preview_stream_body(
    subscription: LlmTextPreviewSubscription,
    permit: OwnedSemaphorePermit,
) -> Body {
    Body::from_stream(stream::unfold(
        LlmTextPreviewStreamState {
            subscription,
            _permit: permit,
        },
        next_llm_text_preview_stream_chunk,
    ))
}

struct LlmTextPreviewStreamState {
    subscription: LlmTextPreviewSubscription,
    _permit: OwnedSemaphorePermit,
}

async fn next_llm_text_preview_stream_chunk(
    mut state: LlmTextPreviewStreamState,
) -> Option<(Result<Bytes, Infallible>, LlmTextPreviewStreamState)> {
    let frame = state.subscription.recv().await?;
    Some((Ok(llm_text_preview_event_bytes(&frame)), state))
}

fn llm_text_preview_event_bytes(frame: &LlmTextPreviewFrame) -> Bytes {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"event: ");
    bytes.extend_from_slice(frame.event_name().as_bytes());
    bytes.extend_from_slice(b"\n");
    bytes.extend_from_slice(b"data: ");
    serde_json::to_writer(&mut bytes, frame).expect("preview frame should serialize");
    bytes.extend_from_slice(b"\n\n");
    Bytes::from(bytes)
}

fn timeline_envelopes_body(events: &[TimelineEnvelope]) -> Body {
    let mut body = Vec::new();
    for event in events {
        push_timeline_event_line(&mut body, event).expect("timeline envelope should serialize");
    }
    Body::from(body)
}

fn timeline_forward_response(page: TimelineForwardPage) -> Response {
    (
        [
            (
                header::CONTENT_TYPE.as_str(),
                "application/x-ndjson".to_owned(),
            ),
            (NEXT_CURSOR_HEADER, page.next_cursor),
            (HAS_MORE_AFTER_HEADER, page.has_more_after.to_string()),
        ],
        timeline_envelopes_body(&page.events),
    )
        .into_response()
}

fn timeline_history_response(page: TimelineHistoryPage) -> Response {
    (
        [
            (
                header::CONTENT_TYPE.as_str(),
                "application/x-ndjson".to_owned(),
            ),
            (NEXT_CURSOR_HEADER, page.next_cursor),
            (PAGE_START_CURSOR_HEADER, page.page_start_cursor),
            (PAGE_END_CURSOR_HEADER, page.page_end_cursor),
            (HAS_MORE_BEFORE_HEADER, page.has_more_before.to_string()),
            (
                HISTORY_BOUNDARY_HEADER,
                history_boundary_name(page.history_boundary).to_owned(),
            ),
        ],
        timeline_envelopes_body(&page.events),
    )
        .into_response()
}

struct TimelineStreamState {
    service: Service,
    cursor: String,
    processed_seq: u64,
    pending: VecDeque<Bytes>,
    done: bool,
    read_immediately: bool,
    _permit: OwnedSemaphorePermit,
    timeline_blocking_slots: Arc<Semaphore>,
}

impl TimelineStreamState {
    fn new(
        service: Service,
        cursor: String,
        initial_page: TimelineForwardPage,
        permit: OwnedSemaphorePermit,
        timeline_blocking_slots: Arc<Semaphore>,
    ) -> Self {
        let processed_seq = EventCursor::parse_timeline(&cursor)
            .map(|cursor| cursor.seq())
            .unwrap_or(0);
        let mut state = Self {
            service,
            cursor,
            processed_seq,
            pending: VecDeque::new(),
            done: false,
            read_immediately: false,
            _permit: permit,
            timeline_blocking_slots,
        };
        collect_timeline_stream_events(&mut state, initial_page);
        // Re-read on first body poll so post-preflight store failures surface in-stream.
        state.read_immediately = true;
        state
    }
}

async fn next_timeline_stream_chunk(
    mut state: TimelineStreamState,
) -> Option<(Result<Bytes, Infallible>, TimelineStreamState)> {
    if let Some(line) = state.pending.pop_front() {
        return Some((Ok(line), state));
    }
    if state.done {
        return None;
    }

    loop {
        if !state.read_immediately {
            let service = state.service.clone();
            let processed_seq = state.processed_seq;
            tokio::select! {
                _ = service.wait_for_event_after(processed_seq) => {
                    state.read_immediately = true;
                }
                _ = tokio::time::sleep(TIMELINE_FOLLOW_HEARTBEAT_INTERVAL) => {
                    return Some((Ok(Bytes::from_static(b"\n")), state));
                }
            }
        }

        let window = match read_timeline_forward_page(
            state.service.clone(),
            state.cursor.clone(),
            TIMELINE_FOLLOW_BATCH_LIMIT,
            state.timeline_blocking_slots.clone(),
        )
        .await
        {
            Ok(window) => window,
            Err(error) => {
                state.done = true;
                return Some((Ok(timeline_stream_error_line(&state.service, error)), state));
            }
        };

        collect_timeline_stream_events(&mut state, window);

        if let Some(line) = state.pending.pop_front() {
            return Some((Ok(line), state));
        }
        if state.done {
            return None;
        }
    }
}

async fn read_timeline_forward_page(
    service: Service,
    cursor: String,
    limit: usize,
    timeline_blocking_slots: Arc<Semaphore>,
) -> Result<TimelineForwardPage, ApiError> {
    run_timeline_page_read(
        timeline_blocking_slots,
        "timeline forward read",
        move || service.timeline_forward_page(&cursor, limit),
    )
    .await
}

async fn read_timeline_backward_page(
    service: Service,
    cursor: String,
    limit: usize,
    timeline_blocking_slots: Arc<Semaphore>,
) -> Result<TimelineHistoryPage, ApiError> {
    run_timeline_page_read(
        timeline_blocking_slots,
        "timeline backward read",
        move || service.timeline_backward_page(&cursor, limit),
    )
    .await
}

async fn read_timeline_tail_page(
    service: Service,
    limit: usize,
    timeline_blocking_slots: Arc<Semaphore>,
) -> Result<TimelineHistoryPage, ApiError> {
    run_timeline_page_read(timeline_blocking_slots, "timeline tail read", move || {
        service.timeline_tail_page(limit)
    })
    .await
}

async fn run_timeline_page_read<T: Send + 'static>(
    timeline_blocking_slots: Arc<Semaphore>,
    operation: &'static str,
    read: impl FnOnce() -> Result<T, crate::timeline_store::TimelineStoreError> + Send + 'static,
) -> Result<T, ApiError> {
    run_timeline_blocking_task(timeline_blocking_slots, operation, read)
        .await?
        .map_err(ApiError::from_timeline_store)
}

fn collect_timeline_stream_events(state: &mut TimelineStreamState, page: TimelineForwardPage) {
    state.read_immediately = page.has_more_after;
    for event in page.events {
        state.processed_seq = event.seq;
        state.pending.push_back(timeline_event_line(&event));
    }
    state.processed_seq = EventCursor::parse_timeline(&page.next_cursor)
        .map(|cursor| cursor.seq())
        .unwrap_or(state.processed_seq);
    state.cursor = page.next_cursor;
}

fn history_boundary_name(boundary: HistoryBoundary) -> &'static str {
    match boundary {
        HistoryBoundary::None => "none",
        HistoryBoundary::Start => "start",
        HistoryBoundary::Expired => "expired",
    }
}

fn timeline_event_line(event: &TimelineEnvelope) -> Bytes {
    let mut line = Vec::new();
    push_timeline_event_line(&mut line, event).expect("timeline envelope should serialize");
    Bytes::from(line)
}

fn timeline_stream_error_line(service: &Service, error: ApiError) -> Bytes {
    let cursor = service.current_event_cursor();
    let seq = cursor.seq();
    let envelope = TimelineEnvelope::new(
        seq,
        cursor,
        unix_timestamp_now(),
        service.thread_id(),
        "service.error",
        TimelineTrace::new(None),
        Some(TimelineItem::new(
            format!("err_evt_{seq}"),
            "error",
            "failed",
        )),
        json!({
            "code": error.code,
            "message": error.message,
            "retryable": error.retryable
        }),
    )
    .expect("current cursor should produce a timeline envelope");
    timeline_event_line(&envelope)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::http::StatusCode;
    use tokio::sync::Semaphore;

    use super::run_timeline_page_read;

    #[tokio::test]
    async fn timeline_page_worker_panic_maps_to_stable_internal_error() {
        let slots = Arc::new(Semaphore::new(1));
        let error =
            run_timeline_page_read::<()>(slots, "timeline test read", || panic!("injected"))
                .await
                .expect_err("worker panic should fail");

        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error.code, "internal_error");
        assert_eq!(error.message, "timeline test read worker failed");
        assert!(error.retryable);
    }
}
