use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use thiserror::Error;

use crate::config::RuntimeProfilingConfig;
use crate::path_utils::lexical_absolute;

pub type SharedProfiler = Arc<Mutex<CsvProfiler>>;

pub const PROFILING_SCHEMA_VERSION: &str = "profiling.events.v1";

const EVENT_COLUMNS: &[&str] = &[
    "schema_version",
    "run_id",
    "run_label",
    "process_id",
    "session",
    "kind",
    "event_name",
    "status",
    "success",
    "start_epoch_ns",
    "end_epoch_ns",
    "start_run_ms",
    "end_run_ms",
    "duration_ms",
    "duration_us",
    "delta_ms",
    "turn_id",
    "cycle_id",
    "provider_call_index",
    "request_kind",
    "provider_request_index",
    "provider_request_index_for_provider",
    "is_first_provider_request_in_run",
    "is_first_provider_request_for_provider",
    "service_start_to_provider_start_ms",
    "provider_name",
    "model",
    "http_status",
    "stop_reason",
    "input_message_count",
    "message_count",
    "tool_spec_count",
    "tool_call_count",
    "tool_call_id",
    "tool_name",
    "tool_index",
    "task_id",
    "task_ask_id",
    "task_tell_id",
    "task_send_id",
    "task_urgency",
    "task_ask_bytes",
    "task_tell_bytes",
    "task_expect_bytes",
    "task_state",
    "queue_length",
    "request_body_bytes",
    "response_body_bytes",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
    "cache_hit_ratio",
    "artifact_path",
    "error_code",
    "error_kind",
    "error_retryable",
    "error_message_truncated",
];

const SUMMARY_COLUMNS: &[&str] = &[
    "schema_version",
    "run_id",
    "run_label",
    "started_epoch_ns",
    "ended_epoch_ns",
    "duration_ms",
    "events",
    "provider_requests",
    "provider_success",
    "provider_failed",
    "provider_cancelled",
    "provider_timeouts",
    "p50_provider_duration_ms",
    "p90_provider_duration_ms",
    "p95_provider_duration_ms",
    "p99_provider_duration_ms",
    "first_provider_request_duration_ms",
    "tool_calls",
    "tool_calls_failed",
    "task_requests",
    "task_requests_replied",
    "task_requests_expired",
    "task_requests_failed",
    "turns",
    "turns_failed",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
    "report_dir",
];

#[derive(Debug, Error)]
pub enum ProfilingError {
    #[error("{message}")]
    InvalidConfig { message: String },
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl ProfilingError {
    fn invalid_config(message: impl Into<String>) -> Self {
        Self::InvalidConfig {
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProfilingConfig {
    pub base_dir: PathBuf,
    pub run_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderProfilingContext {
    pub session: Option<String>,
    pub turn_id: Option<String>,
    pub cycle_id: Option<String>,
    pub provider_call_index: usize,
    pub request_kind: String,
    pub input_message_count: usize,
    pub message_count: usize,
    pub tool_spec_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProfilingTimestamp {
    epoch_ns: u128,
    run_us: u128,
}

impl ProfilingTimestamp {
    pub fn epoch_ns(self) -> u128 {
        self.epoch_ns
    }

    pub fn run_ms(self) -> u128 {
        self.run_us / 1_000
    }

    pub fn duration_us_since(self, start: Self) -> u128 {
        self.run_us.saturating_sub(start.run_us)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderRequestSequence {
    pub provider_request_index: u64,
    pub provider_request_index_for_provider: u64,
    pub is_first_provider_request_in_run: bool,
    pub is_first_provider_request_for_provider: bool,
    pub service_start_to_provider_start_ms: u128,
}

#[derive(Debug, Clone, Default)]
pub struct CsvEventRow {
    fields: BTreeMap<&'static str, String>,
}

impl CsvEventRow {
    pub fn new(
        kind: impl Into<String>,
        event_name: impl Into<String>,
        status: impl Into<String>,
    ) -> Self {
        let mut row = Self::default();
        row.fields.insert("kind", kind.into());
        row.fields.insert("event_name", event_name.into());
        row.fields.insert("status", status.into());
        row
    }

    pub fn field(mut self, name: &'static str, value: impl ToString) -> Self {
        self.fields.insert(name, value.to_string());
        self
    }

    pub fn optional_field(mut self, name: &'static str, value: Option<impl ToString>) -> Self {
        if let Some(value) = value {
            self.fields.insert(name, value.to_string());
        }
        self
    }

    pub fn success(self, success: bool) -> Self {
        self.field("success", success)
    }

    pub fn timing(mut self, start: ProfilingTimestamp, end: Option<ProfilingTimestamp>) -> Self {
        self.fields
            .insert("start_epoch_ns", start.epoch_ns().to_string());
        self.fields
            .insert("start_run_ms", start.run_ms().to_string());
        if let Some(end) = end {
            let duration_us = end.duration_us_since(start);
            self.fields
                .insert("end_epoch_ns", end.epoch_ns().to_string());
            self.fields.insert("end_run_ms", end.run_ms().to_string());
            self.fields
                .insert("duration_ms", (duration_us / 1_000).to_string());
            self.fields.insert("duration_us", duration_us.to_string());
        }
        self
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.fields.get(name).map(String::as_str)
    }
}

#[derive(Debug)]
pub struct CsvProfiler {
    run_id: String,
    run_label: String,
    process_id: u32,
    report_dir: PathBuf,
    started_epoch_ns: u128,
    started_instant: Instant,
    events: BufWriter<File>,
    summary: BufWriter<File>,
    summary_state: SummaryAccumulator,
    provider_request_index: u64,
    provider_request_indices_by_provider: HashMap<String, u64>,
    finished: bool,
}

#[derive(Debug, Default)]
struct SummaryAccumulator {
    events: u64,
    provider_requests: u64,
    provider_success: u64,
    provider_failed: u64,
    provider_cancelled: u64,
    provider_timeouts: u64,
    provider_duration_us: Vec<u128>,
    first_provider_duration_us: Option<u128>,
    tool_calls: u64,
    tool_calls_failed: u64,
    task_states: HashMap<TaskRequestSummaryKey, String>,
    turns: u64,
    turns_failed: u64,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
}

pub fn resolve_profiling_config(
    config: &RuntimeProfilingConfig,
    data_dir: &Path,
) -> Result<Option<ResolvedProfilingConfig>, ProfilingError> {
    if !config.enabled {
        return Ok(None);
    }

    if data_dir.as_os_str().is_empty() {
        return Err(ProfilingError::invalid_config(
            "profiling requires a non-empty runtime.data_dir",
        ));
    }

    let base_dir = match config.output_dir.as_ref() {
        Some(path) if path.as_os_str().is_empty() => {
            return Err(ProfilingError::invalid_config(
                "profiling.output_dir must not be empty when set",
            ));
        }
        Some(path) => lexical_absolute(path, data_dir),
        None => lexical_absolute(&PathBuf::from("profiling"), data_dir),
    };
    let run_label = config
        .run_label
        .as_deref()
        .and_then(sanitize_run_label)
        .or_else(|| Some("auto".to_owned()));

    Ok(Some(ResolvedProfilingConfig {
        base_dir,
        run_label,
    }))
}

impl CsvProfiler {
    pub fn create_shared(
        config: ResolvedProfilingConfig,
    ) -> Result<SharedProfiler, ProfilingError> {
        Ok(Arc::new(Mutex::new(Self::create(config)?)))
    }

    pub fn create(config: ResolvedProfilingConfig) -> Result<Self, ProfilingError> {
        let process_id = std::process::id();
        let run_label = config.run_label.unwrap_or_else(|| "auto".to_owned());
        let run_id = format!(
            "{}_{}_{}",
            format_run_timestamp(SystemTime::now()),
            process_id,
            run_label
        );
        let report_dir = config.base_dir.join(&run_id);
        fs::create_dir_all(&report_dir)?;

        let events_path = report_dir.join("events.csv");
        let summary_path = report_dir.join("summary.csv");
        let mut events = BufWriter::new(File::create(&events_path)?);
        let mut summary = BufWriter::new(File::create(&summary_path)?);
        write_csv_record(&mut events, EVENT_COLUMNS)?;
        events.flush()?;
        write_csv_record(&mut summary, SUMMARY_COLUMNS)?;
        summary.flush()?;

        let started_epoch_ns = epoch_ns(SystemTime::now());
        let started_instant = Instant::now();
        let mut profiler = Self {
            run_id,
            run_label,
            process_id,
            report_dir,
            started_epoch_ns,
            started_instant,
            events,
            summary,
            summary_state: SummaryAccumulator::default(),
            provider_request_index: 0,
            provider_request_indices_by_provider: HashMap::new(),
            finished: false,
        };
        let now = profiler.now();
        profiler.write_event_row(
            CsvEventRow::new("service", "service.started", "ok")
                .success(true)
                .timing(now, None),
        )?;
        Ok(profiler)
    }

    pub fn report_dir(&self) -> &Path {
        &self.report_dir
    }

    pub fn now(&self) -> ProfilingTimestamp {
        ProfilingTimestamp {
            epoch_ns: epoch_ns(SystemTime::now()),
            run_us: self.started_instant.elapsed().as_micros(),
        }
    }

    pub fn begin_provider_request(
        &mut self,
        provider_name: &str,
        start: ProfilingTimestamp,
    ) -> ProviderRequestSequence {
        self.provider_request_index += 1;
        let provider_index = self
            .provider_request_indices_by_provider
            .entry(provider_name.to_owned())
            .or_insert(0);
        *provider_index += 1;

        ProviderRequestSequence {
            provider_request_index: self.provider_request_index,
            provider_request_index_for_provider: *provider_index,
            is_first_provider_request_in_run: self.provider_request_index == 1,
            is_first_provider_request_for_provider: *provider_index == 1,
            service_start_to_provider_start_ms: start.run_ms(),
        }
    }

    pub fn write_event_row(&mut self, row: CsvEventRow) -> io::Result<()> {
        let record = EVENT_COLUMNS
            .iter()
            .map(|column| match *column {
                "schema_version" => PROFILING_SCHEMA_VERSION.to_owned(),
                "run_id" => self.run_id.clone(),
                "run_label" => self.run_label.clone(),
                "process_id" => self.process_id.to_string(),
                _ => row.get(column).unwrap_or_default().to_owned(),
            })
            .collect::<Vec<_>>();
        write_csv_record(&mut self.events, &record)?;
        self.events.flush()?;
        self.summary_state.observe(&row);
        Ok(())
    }

    pub fn finish(&mut self) -> io::Result<()> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        let ended_epoch_ns = epoch_ns(SystemTime::now());
        let duration_ms = self.started_instant.elapsed().as_millis();
        let mut values = BTreeMap::<&str, String>::new();
        values.insert("schema_version", PROFILING_SCHEMA_VERSION.to_owned());
        values.insert("run_id", self.run_id.clone());
        values.insert("run_label", self.run_label.clone());
        values.insert("started_epoch_ns", self.started_epoch_ns.to_string());
        values.insert("ended_epoch_ns", ended_epoch_ns.to_string());
        values.insert("duration_ms", duration_ms.to_string());
        values.insert("events", self.summary_state.events.to_string());
        values.insert(
            "provider_requests",
            self.summary_state.provider_requests.to_string(),
        );
        values.insert(
            "provider_success",
            self.summary_state.provider_success.to_string(),
        );
        values.insert(
            "provider_failed",
            self.summary_state.provider_failed.to_string(),
        );
        values.insert(
            "provider_cancelled",
            self.summary_state.provider_cancelled.to_string(),
        );
        values.insert(
            "provider_timeouts",
            self.summary_state.provider_timeouts.to_string(),
        );
        values.insert(
            "p50_provider_duration_ms",
            percentile_ms(&self.summary_state.provider_duration_us, 50),
        );
        values.insert(
            "p90_provider_duration_ms",
            percentile_ms(&self.summary_state.provider_duration_us, 90),
        );
        values.insert(
            "p95_provider_duration_ms",
            percentile_ms(&self.summary_state.provider_duration_us, 95),
        );
        values.insert(
            "p99_provider_duration_ms",
            percentile_ms(&self.summary_state.provider_duration_us, 99),
        );
        values.insert(
            "first_provider_request_duration_ms",
            self.summary_state
                .first_provider_duration_us
                .map(us_to_ms_string)
                .unwrap_or_default(),
        );
        values.insert("tool_calls", self.summary_state.tool_calls.to_string());
        values.insert(
            "tool_calls_failed",
            self.summary_state.tool_calls_failed.to_string(),
        );
        let task_counts = self.summary_state.task_counts();
        values.insert("task_requests", task_counts.total.to_string());
        values.insert("task_requests_replied", task_counts.replied.to_string());
        values.insert("task_requests_expired", task_counts.expired.to_string());
        values.insert("task_requests_failed", task_counts.failed.to_string());
        values.insert("turns", self.summary_state.turns.to_string());
        values.insert("turns_failed", self.summary_state.turns_failed.to_string());
        values.insert("input_tokens", self.summary_state.input_tokens.to_string());
        values.insert(
            "cached_input_tokens",
            self.summary_state.cached_input_tokens.to_string(),
        );
        values.insert(
            "output_tokens",
            self.summary_state.output_tokens.to_string(),
        );
        values.insert(
            "reasoning_output_tokens",
            self.summary_state.reasoning_output_tokens.to_string(),
        );
        values.insert("total_tokens", self.summary_state.total_tokens.to_string());
        values.insert("report_dir", self.report_dir.display().to_string());

        let record = SUMMARY_COLUMNS
            .iter()
            .map(|column| values.get(column).cloned().unwrap_or_default())
            .collect::<Vec<_>>();
        write_csv_record(&mut self.summary, &record)?;
        self.summary.flush()
    }
}

impl Drop for CsvProfiler {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

impl SummaryAccumulator {
    fn observe(&mut self, row: &CsvEventRow) {
        self.events += 1;
        match row.get("kind") {
            Some("provider_request") => self.observe_provider(row),
            Some("tool_call") => self.observe_tool(row),
            Some("task_ask") => self.observe_task_request(row),
            Some("turn") => self.observe_turn(row),
            Some("service") | None | Some(_) => {}
        }
    }

    fn observe_provider(&mut self, row: &CsvEventRow) {
        self.provider_requests += 1;
        let status = row.get("status").unwrap_or_default();
        let success = row.get("success") == Some("true");
        match status {
            "timeout" => self.provider_timeouts += 1,
            "cancelled" => self.provider_cancelled += 1,
            _ if success => self.provider_success += 1,
            _ => self.provider_failed += 1,
        }
        if let Some(duration_us) = row.get("duration_us").and_then(parse_u128) {
            self.provider_duration_us.push(duration_us);
            if row.get("provider_request_index") == Some("1") {
                self.first_provider_duration_us = Some(duration_us);
            }
        }
        self.input_tokens += row.get("input_tokens").and_then(parse_u64).unwrap_or(0);
        self.cached_input_tokens += row
            .get("cached_input_tokens")
            .and_then(parse_u64)
            .unwrap_or(0);
        self.output_tokens += row.get("output_tokens").and_then(parse_u64).unwrap_or(0);
        self.reasoning_output_tokens += row
            .get("reasoning_output_tokens")
            .and_then(parse_u64)
            .unwrap_or(0);
        self.total_tokens += row.get("total_tokens").and_then(parse_u64).unwrap_or(0);
    }

    fn observe_tool(&mut self, row: &CsvEventRow) {
        self.tool_calls += 1;
        if row.get("success") != Some("true") {
            self.tool_calls_failed += 1;
        }
    }

    fn observe_task_request(&mut self, row: &CsvEventRow) {
        let Some(task_id) = row.get("task_id").filter(|value| !value.is_empty()) else {
            return;
        };
        let Some(request_id) = row.get("task_ask_id").filter(|value| !value.is_empty()) else {
            return;
        };
        let key = TaskRequestSummaryKey {
            task_id: task_id.to_owned(),
            request_id: request_id.to_owned(),
        };
        let state = row
            .get("task_state")
            .filter(|value| !value.is_empty())
            .or_else(|| row.get("status").filter(|value| !value.is_empty()))
            .unwrap_or("unknown");
        match self.task_states.get(&key) {
            Some(existing) if task_state_rank(existing) > task_state_rank(state) => {}
            _ => {
                self.task_states.insert(key, state.to_owned());
            }
        }
    }

    fn observe_turn(&mut self, row: &CsvEventRow) {
        self.turns += 1;
        if row.get("success") != Some("true") {
            self.turns_failed += 1;
        }
    }

    fn task_counts(&self) -> TaskSummaryCounts {
        let mut counts = TaskSummaryCounts {
            total: self.task_states.len() as u64,
            ..TaskSummaryCounts::default()
        };
        for state in self.task_states.values() {
            match state.as_str() {
                "written" => counts.replied += 1,
                "expired" => counts.expired += 1,
                "rejected" | "write_failed" | "failed" | "task_terminal" | "unknown_task"
                | "unknown_request" | "already_resolved" | "response_too_large" => {
                    counts.failed += 1;
                }
                _ => {}
            }
        }
        counts
    }
}

#[derive(Debug, Default)]
struct TaskSummaryCounts {
    total: u64,
    replied: u64,
    expired: u64,
    failed: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TaskRequestSummaryKey {
    task_id: String,
    request_id: String,
}

pub fn escape_csv_cell(value: &str) -> String {
    let mut value = value.to_owned();
    if starts_formula_like(&value) {
        value.insert(0, '\'');
    }
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

fn write_csv_record<W, S>(writer: &mut W, values: &[S]) -> io::Result<()>
where
    W: Write,
    S: AsRef<str>,
{
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            writer.write_all(b",")?;
        }
        writer.write_all(escape_csv_cell(value.as_ref()).as_bytes())?;
    }
    writer.write_all(b"\n")
}

fn starts_formula_like(value: &str) -> bool {
    matches!(
        value.as_bytes().first(),
        Some(b'=') | Some(b'+') | Some(b'-') | Some(b'@') | Some(b'\t') | Some(b'\r')
    )
}

fn sanitize_run_label(value: &str) -> Option<String> {
    let mut sanitized = String::new();
    let mut last_dash = false;
    for ch in value.trim().chars() {
        let mapped = if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.') {
            Some(ch)
        } else if ch == '-' || ch.is_ascii_whitespace() {
            Some('-')
        } else {
            None
        };
        let Some(ch) = mapped else {
            continue;
        };
        if ch == '-' {
            if sanitized.is_empty() || last_dash {
                continue;
            }
            last_dash = true;
        } else {
            last_dash = false;
        }
        sanitized.push(ch);
        if sanitized.len() >= 48 {
            break;
        }
    }
    let sanitized = sanitized
        .trim_matches(|ch| matches!(ch, '-' | '_' | '.'))
        .to_owned();
    (!sanitized.is_empty()).then_some(sanitized)
}

fn epoch_ns(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn parse_u64(value: &str) -> Option<u64> {
    value.parse::<u64>().ok()
}

fn parse_u128(value: &str) -> Option<u128> {
    value.parse::<u128>().ok()
}

fn task_state_rank(state: &str) -> u8 {
    match state {
        "pending" | "parsed" | "enqueued" => 0,
        "replied" => 1,
        "written" | "expired" | "rejected" | "write_failed" | "failed" | "task_terminal"
        | "unknown_task" | "unknown_request" | "already_resolved" | "response_too_large" => 2,
        _ => 0,
    }
}

fn percentile_ms(values: &[u128], percentile: usize) -> String {
    if values.is_empty() {
        return String::new();
    }
    let mut values = values.to_vec();
    values.sort_unstable();
    let rank = ((values.len() * percentile).div_ceil(100)).saturating_sub(1);
    us_to_ms_string(values[rank.min(values.len() - 1)])
}

fn us_to_ms_string(value: u128) -> String {
    (value / 1_000).to_string()
}

fn format_run_timestamp(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let total_seconds = duration.as_secs() as i64;
    let days = total_seconds.div_euclid(86_400);
    let seconds_of_day = total_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}Z")
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096).div_euclid(365);
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).div_euclid(153);
    let day = doy - (153 * mp + 2).div_euclid(5) + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}
