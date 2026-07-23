use axum::extract::State;
use axum::http::{HeaderMap, Uri};
use axum::Json;
use serde_json::{json, Value};
use tokio::sync::OwnedSemaphorePermit;

use crate::registry::{RegistryError, RegistryQuery, RegistryQueryResult, RegistryTopicSummary};

use super::{
    authorize, bounded_registry_response, registry_get_response, registry_history_response,
    registry_store_from_state, ApiError, HttpState, RegistryResponseTruncateSide,
};

pub(super) async fn registry_current_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = registry_store_from_state(&state)?;
    let query = parse_registry_http_query(
        uri.query().unwrap_or_default(),
        RegistryHttpQueryKind::Current,
    )?;
    let permit = registry_http_worker_permit(&state)?;
    let response = run_registry_http_task(permit, "registry current query", move || {
        let max_response_bytes = store.config().max_response_bytes;
        store
            .get(query)
            .map(|result| registry_get_response(result, None, max_response_bytes))
    })
    .await?;
    Ok(Json(response))
}

pub(super) async fn registry_history_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = registry_store_from_state(&state)?;
    let query = parse_registry_http_query(
        uri.query().unwrap_or_default(),
        RegistryHttpQueryKind::History,
    )?;
    let permit = registry_http_worker_permit(&state)?;
    let response = run_registry_http_task(permit, "registry history query", move || {
        let max_response_bytes = store.config().max_response_bytes;
        store
            .history(query)
            .map(|result| registry_history_response(result, None, max_response_bytes))
    })
    .await?;
    Ok(Json(response))
}

pub(super) async fn registry_topics_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Json<Value>, ApiError> {
    authorize(&headers, state.service_key.as_deref())?;
    let store = registry_store_from_state(&state)?;
    let query = parse_registry_http_query(
        uri.query().unwrap_or_default(),
        RegistryHttpQueryKind::Topics,
    )?;
    let permit = registry_http_worker_permit(&state)?;
    let response = run_registry_http_task(permit, "registry topics query", move || {
        let max_response_bytes = store.config().max_response_bytes;
        store
            .topics(query)
            .map(|result| registry_topics_response(result, None, max_response_bytes))
    })
    .await?;
    Ok(Json(response))
}

fn registry_http_worker_permit(state: &HttpState) -> Result<OwnedSemaphorePermit, ApiError> {
    state
        .registry_blocking_slots
        .as_ref()
        .expect("registry blocking slots should exist when registry is enabled")
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::registry_worker_limit())
}

async fn run_registry_http_task(
    permit: OwnedSemaphorePermit,
    operation: &'static str,
    task: impl FnOnce() -> Result<Value, RegistryError> + Send + 'static,
) -> Result<Value, ApiError> {
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        task()
    })
    .await
    .map_err(|_| ApiError::registry_worker_failed(operation))?
    .map_err(ApiError::from_registry)
}

#[derive(Debug, Clone, Copy)]
enum RegistryHttpQueryKind {
    Current,
    History,
    Topics,
}

fn parse_registry_http_query(
    query: &str,
    kind: RegistryHttpQueryKind,
) -> Result<RegistryQuery, ApiError> {
    let mut topic = None;
    let mut since_secs = None;
    let mut limit = None;
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
            "topic" => topic = Some(value.to_owned()),
            "since_secs" if matches!(kind, RegistryHttpQueryKind::History) => {
                since_secs = Some(parse_registry_f64(value, "since_secs")?);
            }
            "limit" => limit = Some(parse_registry_limit(value)?),
            _ => return Err(ApiError::invalid_request("unknown query parameter")),
        }
    }

    let topic = topic.ok_or_else(|| ApiError::invalid_request("topic is required"))?;
    let mut query = match kind {
        RegistryHttpQueryKind::History => {
            let since_secs =
                since_secs.ok_or_else(|| ApiError::invalid_request("since_secs is required"))?;
            RegistryQuery::history(topic, since_secs)
        }
        RegistryHttpQueryKind::Current | RegistryHttpQueryKind::Topics => RegistryQuery::new(topic),
    };
    if let Some(limit) = limit {
        query = query.with_limit(limit);
    }
    Ok(query)
}

fn parse_registry_f64(value: &str, name: &str) -> Result<f64, ApiError> {
    value
        .parse::<f64>()
        .map_err(|_| ApiError::invalid_request(format!("invalid {name}")))
}

fn parse_registry_limit(value: &str) -> Result<usize, ApiError> {
    value
        .parse::<usize>()
        .map_err(|_| ApiError::invalid_request("invalid limit"))
}

fn registry_topics_response(
    result: RegistryQueryResult<RegistryTopicSummary>,
    id: Option<Value>,
    max_response_bytes: usize,
) -> Value {
    let items = result
        .items
        .iter()
        .map(registry_topic_json)
        .collect::<Vec<_>>();
    let mut body = json!({
        "ok": true,
        "kind": "registry_topics",
        "server_time": crate::formatting::system_time_rfc3339(result.server_time),
        "items": items,
        "matched_count": result.matched_count,
        "returned_count": result.returned_count,
        "truncated": result.truncated,
        "truncated_reason": result.truncated_reason,
    });
    if let Some(id) = id {
        body["id"] = id;
    }
    bounded_registry_response(body, max_response_bytes, RegistryResponseTruncateSide::Back)
}

fn registry_topic_json(topic: &RegistryTopicSummary) -> Value {
    json!({
        "topic": &topic.topic,
        "writer_kind": topic.writer_kind.as_str(),
        "origin": &topic.origin,
        "source": &topic.source,
        "latest_seq": topic.latest_seq,
        "last_seen_at": crate::formatting::system_time_rfc3339(topic.last_seen_at),
        "current": topic.current,
        "expires_at": topic
            .expires_at
            .map(crate::formatting::system_time_rfc3339),
        "sample_count_retained": topic.sample_count_retained,
        "freq_hz": topic.freq_hz,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration as StdDuration;

    use axum::http::StatusCode;
    use serde_json::json;
    use tokio::sync::oneshot;
    use tokio::sync::Semaphore;
    use tokio::time::{timeout, Duration};

    use super::run_registry_http_task;

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_registry_query_does_not_block_health_work() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_gate = Arc::clone(&gate);
        let (entered_tx, entered_rx) = oneshot::channel();
        let slots = Arc::new(Semaphore::new(1));
        let permit = slots.clone().try_acquire_owned().unwrap();
        let query = tokio::spawn(run_registry_http_task(
            permit,
            "registry test query",
            move || {
                let _ = entered_tx.send(());
                let (lock, wake) = &*worker_gate;
                let released = lock.lock().expect("gate mutex poisoned");
                let (released, timeout) = wake
                    .wait_timeout_while(released, StdDuration::from_secs(5), |released| !*released)
                    .expect("gate mutex poisoned");
                Ok(json!({
                    "released": *released,
                    "timed_out": timeout.timed_out(),
                }))
            },
        ));

        entered_rx.await.expect("blocking query should start");
        assert!(slots.try_acquire().is_err());
        let health_result = timeout(Duration::from_secs(1), super::super::healthz()).await;
        let (lock, wake) = &*gate;
        *lock.lock().expect("gate mutex poisoned") = true;
        wake.notify_one();
        let query_result = query.await.unwrap().unwrap();

        let _ = health_result.expect("health work should run while registry query is blocked");
        assert_eq!(query_result, json!({"released": true, "timed_out": false}));
        assert_eq!(slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn registry_http_worker_panic_maps_to_stable_internal_error() {
        let permit = Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap();
        let error =
            run_registry_http_task(permit, "registry panic query", || panic!("sensitive panic"))
                .await
                .expect_err("worker panic should fail");

        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error.code, "internal_error");
        assert_eq!(error.message, "registry panic query worker failed");
        assert!(error.retryable);
        assert!(!error.message.contains("sensitive"));
    }

    #[tokio::test]
    async fn cancelled_registry_task_holds_slot_until_blocking_worker_exits() {
        let slots = Arc::new(Semaphore::new(1));
        let permit = slots.clone().try_acquire_owned().unwrap();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let worker_gate = Arc::clone(&gate);
        let (entered_tx, entered_rx) = oneshot::channel();
        let task = tokio::spawn(run_registry_http_task(
            permit,
            "registry cancelled query",
            move || {
                let _ = entered_tx.send(());
                let (lock, wake) = &*worker_gate;
                let released = lock.lock().expect("gate mutex poisoned");
                let _ = wake
                    .wait_timeout_while(released, StdDuration::from_secs(5), |released| !*released)
                    .expect("gate mutex poisoned");
                Ok(json!({"ok": true}))
            },
        ));

        entered_rx.await.expect("blocking query should start");
        task.abort();
        let _ = task.await;
        assert!(slots.try_acquire().is_err());

        let (lock, wake) = &*gate;
        *lock.lock().expect("gate mutex poisoned") = true;
        wake.notify_one();
        timeout(Duration::from_secs(1), async {
            while slots.available_permits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("slot should release after the blocking worker exits");
        assert_eq!(slots.available_permits(), 1);
    }

    #[test]
    fn registry_worker_limit_is_retryable_service_unavailable() {
        let error = super::super::ApiError::registry_worker_limit();

        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code, "registry_worker_limit");
        assert!(error.retryable);
    }
}
