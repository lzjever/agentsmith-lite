use std::time::Instant;

use serde_json::{json, Value};

use super::{
    bash_command, bash_exit_code, bash_output_tail, copy_bash_output_metadata, ActiveCycle,
    AgentConfig, AgentEventLog, AgentRunError, AgentRunErrorKind, AgentRunResult,
    ProviderRequestObservation,
};
use crate::agent_events::AgentUsage;
use crate::event::ServiceEvent;
use crate::profiling::{CsvEventRow, ProfilingTimestamp, SharedProfiler};
use crate::provider::{ProviderErrorDiagnostic, ProviderMetadata};
use crate::types::{Message, StopReason, ToolCall, ToolResult, Usage};

pub(super) fn emit(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    event_type: &str,
    data: Value,
) -> Option<ServiceEvent> {
    event_log.as_mut().and_then(|log| {
        log.append(
            event_type,
            config.session.as_deref(),
            config.turn_id.as_deref(),
            data,
        )
    })
}

pub(super) fn fail_if_event_log_failed(
    event_log: &mut Option<AgentEventLog<'_>>,
    messages: &[Message],
    provider_calls: usize,
) -> Result<(), AgentRunError> {
    let Some(log) = event_log.as_mut() else {
        return Ok(());
    };
    let Some(message) = log.take_failure() else {
        return Ok(());
    };
    Err(AgentRunError::new(
        AgentRunErrorKind::Persistence {
            message: format!("timeline persistence failed: {message}"),
        },
        messages,
        provider_calls,
    ))
}

pub(super) fn profiler_now(profiler: Option<&SharedProfiler>) -> Option<ProfilingTimestamp> {
    profiler.and_then(|profiler| profiler.lock().ok().map(|profiler| profiler.now()))
}

fn write_profile_event_row(profiler: Option<&SharedProfiler>, row: CsvEventRow) {
    let Some(profiler) = profiler else {
        return;
    };
    let Ok(mut profiler) = profiler.lock() else {
        return;
    };
    let _ = profiler.write_event_row(row);
}

pub(super) fn write_tool_profile_row(
    profiler: Option<&SharedProfiler>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    tool_call: &ToolCall,
    tool_index: usize,
    start: Option<ProfilingTimestamp>,
    result: &ToolResult,
) {
    let Some(start) = start else {
        return;
    };
    let Some(end) = profiler_now(profiler) else {
        return;
    };
    let (event_name, status, success) = tool_profile_status(result);
    let mut row = CsvEventRow::new("tool_call", event_name, status)
        .success(success)
        .timing(start, Some(end))
        .optional_field("session", config.session.as_deref())
        .optional_field("turn_id", config.turn_id.as_deref())
        .field("tool_call_id", &tool_call.id)
        .field("tool_name", &tool_call.name)
        .field("tool_index", tool_index);
    if let Some(active_cycle) = active_cycle {
        row = row.field("cycle_id", &active_cycle.cycle_id);
    }
    write_profile_event_row(profiler, row);
}

pub(super) fn write_turn_profile_row(
    profiler: Option<&SharedProfiler>,
    config: &AgentConfig,
    start: Option<ProfilingTimestamp>,
    result: &Result<AgentRunResult, AgentRunError>,
) {
    let Some(start) = start else {
        return;
    };
    let Some(end) = profiler_now(profiler) else {
        return;
    };
    let profile = turn_profile_terminal(result);
    let mut row = CsvEventRow::new("turn", profile.event_name, profile.status)
        .success(profile.success)
        .timing(start, Some(end))
        .optional_field("session", config.session.as_deref())
        .optional_field("turn_id", config.turn_id.as_deref())
        .field("provider_call_index", profile.provider_calls);
    if let Some(stop_reason) = profile.stop_reason {
        row = row.field("stop_reason", stop_reason.as_str());
    }
    if let Some(error_kind) = profile.error_kind {
        row = row.field("error_kind", error_kind);
    }
    write_profile_event_row(profiler, row);
}

struct TurnProfileTerminal {
    event_name: &'static str,
    status: &'static str,
    success: bool,
    stop_reason: Option<StopReason>,
    provider_calls: usize,
    error_kind: Option<String>,
}

fn turn_profile_terminal(result: &Result<AgentRunResult, AgentRunError>) -> TurnProfileTerminal {
    match result {
        Ok(result) => TurnProfileTerminal {
            event_name: "turn.completed",
            status: "ok",
            success: true,
            stop_reason: Some(result.stop_reason),
            provider_calls: result.provider_calls,
            error_kind: None,
        },
        Err(error) => {
            let (event_name, status, error_kind) = match &error.kind {
                AgentRunErrorKind::Cancelled => {
                    ("turn.cancelled", "cancelled", "cancelled".to_owned())
                }
                AgentRunErrorKind::Provider { code, .. } => ("turn.failed", "error", code.clone()),
                AgentRunErrorKind::ProviderStop { .. } => {
                    ("turn.failed", "error", "provider_stop".to_owned())
                }
                AgentRunErrorKind::Persistence { .. } => {
                    ("turn.failed", "error", "persistence".to_owned())
                }
                AgentRunErrorKind::Configuration { .. } => {
                    ("turn.failed", "error", "configuration".to_owned())
                }
            };
            TurnProfileTerminal {
                event_name,
                status,
                success: false,
                stop_reason: None,
                provider_calls: error.provider_calls,
                error_kind: Some(error_kind),
            }
        }
    }
}

fn tool_profile_status(result: &ToolResult) -> (&'static str, &'static str, bool) {
    if !result.is_error {
        return ("tool.completed", "ok", true);
    }
    let kind = result.details.get("kind").and_then(Value::as_str);
    let timed_out = result
        .details
        .get("timed_out")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    match kind {
        Some("tool_timeout") if timed_out => ("tool.timeout", "timeout", false),
        Some("tool_cancelled" | "tool_aborted") => ("tool.cancelled", "cancelled", false),
        _ => ("tool.failed", "error", false),
    }
}

pub(super) fn close_and_replace_active_cycle(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: &mut Option<ActiveCycle>,
    active_cycle_last_stop_reason: &mut Option<StopReason>,
    replacement_cycle: Option<ActiveCycle>,
    provider_calls: usize,
    turn_usage: &mut AgentUsage,
) {
    close_active_cycle_before_replacement(
        event_log,
        config,
        active_cycle.as_ref(),
        provider_calls,
        *active_cycle_last_stop_reason,
        turn_usage,
    );
    *active_cycle = replacement_cycle;
    *active_cycle_last_stop_reason = None;
}

pub(super) fn close_active_cycle_before_replacement(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    provider_calls: usize,
    stop_reason: Option<StopReason>,
    turn_usage: &mut AgentUsage,
) {
    let Some(active_cycle) = active_cycle else {
        return;
    };

    let usage = std::mem::take(turn_usage);
    emit(
        event_log,
        config,
        "turn.completed",
        add_cycle_data(
            turn_completed_data(
                completed_cycle_provider_calls(Some(active_cycle), provider_calls),
                stop_reason.unwrap_or(StopReason::EndTurn),
                usage,
            ),
            Some(active_cycle),
        ),
    );
}

pub(super) fn completed_cycle_provider_calls(
    active_cycle: Option<&ActiveCycle>,
    total_provider_calls: usize,
) -> usize {
    active_cycle
        .map(|cycle| cycle.provider_call_index)
        .unwrap_or(total_provider_calls)
}

pub(super) fn emit_provider_started(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    observation: &ProviderRequestObservation,
    provider_call: usize,
    message_count: usize,
    metadata: Option<&ProviderMetadata>,
) {
    emit(
        event_log,
        config,
        "provider.started",
        provider_lifecycle_data(
            observation,
            metadata,
            json!({
                "provider_call": provider_call,
                "message_count": message_count,
                "status": "running"
            }),
        ),
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn emit_provider_completed(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    observation: &ProviderRequestObservation,
    provider_call: usize,
    duration_ms: u64,
    stop_reason: StopReason,
    usage: Option<Usage>,
    tool_call_count: usize,
    has_text: bool,
    metadata: Option<&ProviderMetadata>,
) {
    emit(
        event_log,
        config,
        "provider.completed",
        provider_lifecycle_data(
            observation,
            metadata,
            json!({
                "provider_call": provider_call,
                "duration_ms": duration_ms,
                "stop_reason": stop_reason,
                "usage": usage_value(usage),
                "tool_call_count": tool_call_count,
                "has_text": has_text,
                "status": "completed"
            }),
        ),
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn emit_provider_failed(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    observation: &ProviderRequestObservation,
    provider_call: usize,
    duration_ms: u64,
    diagnostic: &ProviderErrorDiagnostic,
    metadata: Option<&ProviderMetadata>,
) {
    let mut data = json!({
        "provider_call": provider_call,
        "duration_ms": duration_ms,
        "status": "failed",
        "retryable": diagnostic.retryable,
        "error": diagnostic_error_object(diagnostic)
    });
    if let Some(object) = data.as_object_mut() {
        if let Some(status) = diagnostic.status {
            object.insert("provider_status".to_owned(), json!(status));
        }
    }

    emit(
        event_log,
        config,
        "provider.failed",
        provider_lifecycle_data(observation, metadata, data),
    );
}

fn diagnostic_error_object(diagnostic: &ProviderErrorDiagnostic) -> Value {
    let mut error = json!({
        "code": diagnostic.code,
        "message": diagnostic.message,
        "retryable": diagnostic.retryable,
    });
    if let Some(object) = error.as_object_mut() {
        if let Some(status) = diagnostic.status {
            object.insert("status".to_owned(), json!(status));
        }
        if let Some(provider_code) = diagnostic.provider_code.as_deref() {
            object.insert("provider_code".to_owned(), json!(provider_code));
        }
    }
    error
}

fn provider_lifecycle_data(
    observation: &ProviderRequestObservation,
    metadata: Option<&ProviderMetadata>,
    mut data: Value,
) -> Value {
    if let Some(object) = data.as_object_mut() {
        object.insert(
            "provider_request_id".to_owned(),
            json!(observation.provider_request_id.as_str()),
        );
        object.insert(
            "provider_call_index".to_owned(),
            json!(observation.provider_call_index),
        );
        insert_provider_metadata(object, metadata);
        if let Some(cycle_id) = observation.cycle_id.as_deref() {
            object.insert("cycle_id".to_owned(), json!(cycle_id));
        }
    }
    data
}

fn insert_provider_metadata(
    object: &mut serde_json::Map<String, Value>,
    metadata: Option<&ProviderMetadata>,
) {
    let Some(metadata) = metadata.and_then(ProviderMetadata::sanitized) else {
        object.insert("provider".to_owned(), json!("unknown"));
        object.insert("model".to_owned(), Value::Null);
        return;
    };

    object.insert("provider".to_owned(), json!(metadata.profile.clone()));
    object.insert("profile".to_owned(), json!(metadata.profile));
    object.insert(
        "name".to_owned(),
        metadata.name.map(Value::String).unwrap_or(Value::Null),
    );
    object.insert(
        "model".to_owned(),
        metadata.model.map(Value::String).unwrap_or(Value::Null),
    );
    object.insert(
        "capabilities".to_owned(),
        json!(metadata
            .capabilities
            .iter()
            .map(|capability| capability.as_str())
            .collect::<Vec<_>>()),
    );
}

fn usage_value(usage: Option<Usage>) -> Value {
    usage
        .map(|usage| {
            json!({
                "input": usage.input_tokens,
                "cached_input": usage.cached_input_tokens,
                "output": usage.output_tokens,
                "reasoning_output": usage.reasoning_output_tokens,
                "total": usage.total_tokens
            })
        })
        .unwrap_or(Value::Null)
}

pub(super) fn turn_completed_data(
    provider_calls: usize,
    stop_reason: StopReason,
    usage: AgentUsage,
) -> Value {
    json!({
        "provider_calls": provider_calls,
        "provider_request_count": provider_calls,
        "stop_reason": stop_reason,
        "usage": {
            "input": usage.input_tokens,
            "cached_input": usage.cached_input_tokens,
            "output": usage.output_tokens,
            "reasoning_output": usage.reasoning_output_tokens,
        }
    })
}

pub(super) fn add_cycle_data(mut data: Value, active_cycle: Option<&ActiveCycle>) -> Value {
    if let (Some(object), Some(active_cycle)) = (data.as_object_mut(), active_cycle) {
        object.insert("cycle_id".to_owned(), json!(active_cycle.cycle_id.clone()));
        object.insert(
            "input_ids".to_owned(),
            json!(active_cycle.input_ids.clone()),
        );
        object.insert(
            "input_sources".to_owned(),
            json!(active_cycle.input_sources.clone()),
        );
        object.insert(
            "input_urgencies".to_owned(),
            json!(active_cycle.input_urgencies.clone()),
        );
        object.insert(
            "input_previews".to_owned(),
            json!(active_cycle.input_previews.clone()),
        );
        object.insert("queue_length".to_owned(), json!(active_cycle.queue_length));
    }
    data
}

pub(super) fn add_cycle_id(mut data: Value, cycle_id: Option<&str>) -> Value {
    if let (Some(object), Some(cycle_id)) = (data.as_object_mut(), cycle_id) {
        object.insert("cycle_id".to_owned(), json!(cycle_id));
    }
    data
}

pub(super) fn elapsed_millis(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

pub(super) fn emit_error(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    error: &AgentRunError,
) {
    emit_error_with_cycle(event_log, config, None, error);
}

pub(super) fn emit_error_for_cycle(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    error: &AgentRunError,
) {
    emit_error_with_cycle(event_log, config, active_cycle, error);
}

fn emit_error_with_cycle(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    error: &AgentRunError,
) {
    emit(
        event_log,
        config,
        "agent.error",
        add_cycle_data(error_event_data(error), active_cycle),
    );
}

pub(super) fn emit_aborted(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    error: &AgentRunError,
) {
    emit_aborted_with_cycle(event_log, config, None, error);
}

pub(super) fn emit_aborted_for_cycle(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    error: &AgentRunError,
) {
    emit_aborted_with_cycle(event_log, config, active_cycle, error);
}

fn emit_aborted_with_cycle(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    error: &AgentRunError,
) {
    emit(
        event_log,
        config,
        "agent.aborted",
        add_cycle_data(error_event_data(error), active_cycle),
    );
}

fn error_event_data(error: &AgentRunError) -> Value {
    let diagnostic = agent_error_diagnostic(&error.kind);
    let message = error.to_string();
    let mut error_object = json!({
        "code": diagnostic.code,
        "message": message,
        "retryable": diagnostic.retryable
    });
    if let Some(object) = error_object.as_object_mut() {
        if let Some(status) = diagnostic.status {
            object.insert("status".to_owned(), json!(status));
        }
        if let Some(provider_code) = diagnostic.provider_code.as_deref() {
            object.insert("provider_code".to_owned(), json!(provider_code));
        }
    }

    let mut data = json!({
        "message": message,
        "error": error_object,
        "retryable": diagnostic.retryable
    });
    if let Some(object) = data.as_object_mut() {
        if let Some(status) = diagnostic.status {
            object.insert("status".to_owned(), json!(status));
        }
    }
    data
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ErrorEventDiagnostic {
    code: String,
    retryable: bool,
    status: Option<u16>,
    provider_code: Option<String>,
}

impl ErrorEventDiagnostic {
    fn new(code: &str, retryable: bool) -> Self {
        Self {
            code: code.to_owned(),
            retryable,
            status: None,
            provider_code: None,
        }
    }
}

fn agent_error_diagnostic(kind: &AgentRunErrorKind) -> ErrorEventDiagnostic {
    match kind {
        AgentRunErrorKind::Cancelled => ErrorEventDiagnostic::new("cancelled", true),
        AgentRunErrorKind::Provider {
            code,
            retryable,
            status,
            provider_code,
            ..
        } => ErrorEventDiagnostic {
            code: code.clone(),
            retryable: *retryable,
            status: *status,
            provider_code: provider_code.clone(),
        },
        AgentRunErrorKind::ProviderStop { .. } => ErrorEventDiagnostic::new("provider_stop", false),
        AgentRunErrorKind::Persistence { .. } => {
            ErrorEventDiagnostic::new("persistence_error", false)
        }
        AgentRunErrorKind::Configuration { .. } => {
            ErrorEventDiagnostic::new("configuration_error", false)
        }
    }
}

pub(super) fn emit_tool_started(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    tool_call: &ToolCall,
) {
    emit(
        event_log,
        config,
        "tool.started",
        add_cycle_id(
            json!({
                "tool_call_id": tool_call.id,
                "tool_name": tool_call.name
            }),
            active_cycle.map(|cycle| cycle.cycle_id.as_str()),
        ),
    );
}

pub(super) fn emit_bash_command_execution_started(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    tool_call: &ToolCall,
    background_detach_candidate: bool,
    inline_replay_started: bool,
) {
    let Some(command) = bash_command(tool_call) else {
        return;
    };
    emit(
        event_log,
        config,
        "tool.started",
        add_cycle_id(
            json!({
                "tool_call_id": tool_call.id,
                "tool_name": tool_call.name,
                "command": command,
                "output_tail": "",
                "exit_code": Value::Null,
                "status": "in_progress",
                "background_detach_candidate": background_detach_candidate,
                "inline_replay_started": inline_replay_started
            }),
            active_cycle.map(|cycle| cycle.cycle_id.as_str()),
        ),
    );
}

pub(super) fn emit_tool_completed(
    event_log: &mut Option<AgentEventLog<'_>>,
    config: &AgentConfig,
    active_cycle: Option<&ActiveCycle>,
    tool_call: &ToolCall,
    result: &ToolResult,
    detached_ack: bool,
) {
    let mut data = add_cycle_id(
        json!({
        "tool_call_id": result.tool_call_id,
        "tool_name": result.tool_name,
        "is_error": result.is_error,
        "detached_ack": detached_ack
        }),
        active_cycle.map(|cycle| cycle.cycle_id.as_str()),
    );
    if !detached_ack {
        if let Some(command) = bash_command(tool_call) {
            let exit_code = bash_exit_code(result);
            let status = bash_command_execution_status(result, exit_code);
            data["command"] = json!(command);
            data["output_tail"] = json!(bash_output_tail(result));
            copy_bash_output_metadata(result, &mut data);
            data["exit_code"] = json!(exit_code);
            data["status"] = json!(status);
        }
    }
    emit(event_log, config, "tool.completed", data);
}

fn bash_command_execution_status(result: &ToolResult, exit_code: Option<i32>) -> &'static str {
    let kind = result.details.get("kind").and_then(Value::as_str);
    if matches!(kind, Some("tool_cancelled" | "tool_aborted"))
        || result
            .details
            .get("cancelled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        "cancelled"
    } else if !result.is_error && exit_code == Some(0) {
        "completed"
    } else {
        "failed"
    }
}
