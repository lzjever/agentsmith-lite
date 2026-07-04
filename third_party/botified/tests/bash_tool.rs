use std::{
    env,
    ffi::OsString,
    fs,
    sync::Arc,
    time::{Duration, Instant},
};

use botified::{
    tools::BashTool, BackgroundTaskManager, BoundedTaskOutputSink, NewBackgroundTask,
    TaskOutputPolicy, Tool, ToolCall, ToolError, ToolExecutionContext, ToolOutputSink, ToolResult,
};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

static BASH_TEST_LOCK: Mutex<()> = Mutex::const_new(());

fn call(arguments: Value) -> ToolCall {
    ToolCall::new("call_bash", "bash", arguments)
}

fn context(cwd: &std::path::Path) -> ToolExecutionContext {
    ToolExecutionContext::new(cwd.display().to_string())
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let path = env::temp_dir().join(format!("botified_bash_tool_{name}_{}", std::process::id()));
    if path.exists() {
        fs::remove_dir_all(&path).expect("remove stale temp dir");
    }
    fs::create_dir_all(&path).expect("create temp dir");
    path
}

async fn execute(arguments: Value, cwd: &std::path::Path) -> Result<ToolResult, ToolError> {
    let _guard = BASH_TEST_LOCK.lock().await;
    execute_unlocked(arguments, cwd).await
}

async fn execute_unlocked(
    arguments: Value,
    cwd: &std::path::Path,
) -> Result<ToolResult, ToolError> {
    BashTool::new()
        .execute(call(arguments), context(cwd), CancellationToken::new())
        .await
}

struct EnvRestore {
    values: Vec<(&'static str, Option<OsString>)>,
}

impl EnvRestore {
    fn capture(keys: &[&'static str]) -> Self {
        Self {
            values: keys.iter().map(|key| (*key, env::var_os(key))).collect(),
        }
    }
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        for (key, value) in &self.values {
            match value {
                Some(value) => env::set_var(key, value),
                None => env::remove_var(key),
            }
        }
    }
}

#[test]
fn bash_execution_controls_schema_exposes_timeout_secs_and_detach_after_secs() {
    let spec = BashTool::new().spec();

    assert_eq!(spec.name, "bash");
    assert_eq!(spec.input_schema["type"], "object");
    assert_eq!(spec.input_schema["properties"]["command"]["type"], "string");
    assert_eq!(
        spec.input_schema["properties"]["timeout_secs"]["type"],
        json!(["number", "integer", "null"])
    );
    assert_eq!(
        spec.input_schema["properties"]["detach_after_secs"]["type"],
        json!(["number", "integer"])
    );
    assert_eq!(
        spec.input_schema["properties"]["interactive_stdio"]["type"],
        "boolean"
    );
    assert!(spec.input_schema["properties"].get("timeout_sec").is_none());
    assert_eq!(spec.input_schema["required"], json!(["command"]));
}

#[test]
fn bash_schema_describes_interactive_stdio_frames_and_detached_callbacks() {
    let spec = BashTool::new().spec();

    let interactive_stdio = spec.input_schema["properties"]["interactive_stdio"]["description"]
        .as_str()
        .expect("interactive_stdio description");
    assert!(interactive_stdio.contains("Plain stdout"));
    assert!(interactive_stdio.contains("Defaults to true"));
    assert!(interactive_stdio.contains("set false"));
    assert!(interactive_stdio.contains("ask/tell/registry/reply/send/observe"));
    assert!(interactive_stdio.contains("<botified>"));
    assert!(interactive_stdio.contains(r#""op":"ask""#));
    assert!(interactive_stdio.contains(r#""op":"reply""#));
    assert!(interactive_stdio.contains(r#""op":"tell""#));
    assert!(interactive_stdio.contains(r#""op":"registry_set""#));
    assert!(interactive_stdio.contains(r#""op":"registry_get""#));
    assert!(interactive_stdio.contains("registry_snapshot"));
    assert!(interactive_stdio.contains("registry_error"));
    assert!(interactive_stdio.contains(r#""op":"send""#));
    assert!(interactive_stdio.contains(r#""op":"observe""#));
    assert!(interactive_stdio.contains("short bounded"));
    assert!(interactive_stdio.contains("task_send"));
    assert!(interactive_stdio.contains("stdin"));
    assert!(!interactive_stdio.contains("<botified_response>"));
    assert!(!interactive_stdio.contains(r#"<botified>{"id":"#));
    assert!(!interactive_stdio.contains(r#""request":"#));

    let detach_after_secs = spec.input_schema["properties"]["detach_after_secs"]["description"]
        .as_str()
        .expect("detach_after_secs description");
    assert!(detach_after_secs.contains("0"));
    assert!(detach_after_secs.contains("detach immediately"));
    assert!(detach_after_secs.contains("final callback"));
}

#[tokio::test]
async fn bash_execution_controls_timeout_secs_null_is_no_deadline() {
    let cwd = temp_dir("argument_timeout_null");

    let result = execute(
        json!({
            "command": "printf no-deadline-ok",
            "timeout_secs": null
        }),
        &cwd,
    )
    .await
    .expect("null timeout_secs should be accepted");

    assert!(!result.is_error);
    assert!(result.text.contains("no-deadline-ok"), "{:?}", result.text);
    assert_eq!(result.details["timed_out"], json!(false));
}

#[tokio::test]
async fn bash_execution_controls_reject_legacy_timeout_sec() {
    let cwd = temp_dir("legacy_timeout_sec");

    let error = execute(json!({"command": "printf no", "timeout_sec": 1}), &cwd)
        .await
        .expect_err("legacy timeout_sec should be rejected");

    let message = error.to_string();
    assert!(message.contains("invalid bash arguments"), "{message}");
    assert!(message.contains("timeout_sec"), "{message}");
}

#[tokio::test]
async fn bash_execution_controls_accept_detach_after_secs_without_detaching() {
    let cwd = temp_dir("detach_after_secs");

    let result = execute(
        json!({
            "command": "printf execution-control-ok",
            "detach_after_secs": 0.1
        }),
        &cwd,
    )
    .await
    .expect("detach_after_secs should parse");

    assert!(!result.is_error);
    assert!(
        result.text.contains("execution-control-ok"),
        "{:?}",
        result.text
    );
}

#[tokio::test]
async fn bash_execution_controls_context_timeout_cancels_process_without_argument_timeout() {
    let _guard = BASH_TEST_LOCK.lock().await;
    let cwd = temp_dir("context_timeout");
    let started = cwd.join("started");
    let done = cwd.join("done");
    let start = Instant::now();

    let result = BashTool::new()
        .execute(
            call(json!({"command": "touch started; sleep 5; touch done"})),
            context(&cwd).with_timeout(Duration::from_millis(300)),
            CancellationToken::new(),
        )
        .await
        .expect("timeout should be represented as an error tool result");

    assert!(result.is_error);
    assert!(result.text.contains("timed out"), "{:?}", result.text);
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(started.exists());
    assert!(!done.exists());
}

#[tokio::test]
async fn bash_cancelled_before_spawn_does_not_create_marker_side_effect() {
    let _guard = BASH_TEST_LOCK.lock().await;
    let cwd = temp_dir("pre_spawn_cancel");
    let marker = cwd.join("spawned");
    let cancel = CancellationToken::new();
    cancel.cancel();

    let result = BashTool::new()
        .execute(
            call(json!({"command": "touch spawned"})),
            context(&cwd),
            cancel,
        )
        .await
        .expect("pre-spawn cancellation should be represented as a tool result");

    assert!(result.is_error);
    assert!(result.text.contains("cancelled"), "{:?}", result.text);
    assert_eq!(result.details["cancelled"], json!(true));
    assert!(!marker.exists());
}

#[tokio::test]
async fn bash_execution_context_no_deadline_does_not_fall_back_to_default_timeout() {
    let _guard = BASH_TEST_LOCK.lock().await;
    let cwd = temp_dir("context_no_deadline");
    let done = cwd.join("done");
    let start = Instant::now();

    let result = BashTool::new()
        .with_default_timeout(Duration::from_millis(100))
        .execute(
            call(json!({"command": "sleep 0.2; touch done; printf no-deadline-context-ok"})),
            context(&cwd).with_no_deadline(),
            CancellationToken::new(),
        )
        .await
        .expect("no-deadline context should not use the bash default timeout");

    assert!(!result.is_error, "{:?}", result.text);
    assert!(
        result.text.contains("no-deadline-context-ok"),
        "{:?}",
        result.text
    );
    assert!(start.elapsed() >= Duration::from_millis(150));
    assert!(done.exists());
    assert_eq!(result.details["timed_out"], json!(false));
}

#[tokio::test]
async fn bash_execution_controls_timeout_secs_argument_still_works_directly() {
    let cwd = temp_dir("argument_timeout_fallback");
    let started = cwd.join("started");
    let done = cwd.join("done");

    let result = execute(
        json!({
            "command": "touch started; sleep 5; touch done",
            "timeout_secs": 0.3
        }),
        &cwd,
    )
    .await
    .expect("argument timeout should remain supported for direct BashTool calls");

    assert!(result.is_error);
    assert!(result.text.contains("timed out"), "{:?}", result.text);
    assert!(started.exists());
    assert!(!done.exists());
}

#[tokio::test]
async fn bash_success_combines_output_and_exit_code() {
    let cwd = temp_dir("success");

    let result = execute(
        json!({
            "command": "printf 'out'; printf 'err' >&2; printf '%s' \"$PWD\""
        }),
        &cwd,
    )
    .await
    .expect("bash execution");

    assert!(!result.is_error);
    assert_eq!(result.tool_call_id, "call_bash");
    assert_eq!(result.tool_name, "bash");
    assert!(result.text.contains("exit code: 0"), "{:?}", result.text);
    assert!(result.text.contains("out"), "{:?}", result.text);
    assert!(result.text.contains("err"), "{:?}", result.text);
    let aggregated_output = result.details["aggregated_output"]
        .as_str()
        .expect("bash details should include aggregated output");
    assert!(aggregated_output.contains("out"), "{aggregated_output:?}");
    assert!(aggregated_output.contains("err"), "{aggregated_output:?}");
    assert!(
        aggregated_output.contains(&cwd.display().to_string()),
        "{aggregated_output:?}"
    );
    assert!(
        result.text.contains(&cwd.display().to_string()),
        "{:?}",
        result.text
    );
}

#[tokio::test]
async fn bash_combines_stdout_stderr_in_observed_order() {
    let cwd = temp_dir("observed_order");

    let result = execute(
        json!({
            "command": "printf 'OUT_BEFORE\\n'; for i in $(seq 1 2000); do printf 'ERR_%04d\\n' \"$i\" >&2; done; printf 'OUT_AFTER\\n'"
        }),
        &cwd,
    )
    .await
    .expect("bash execution");

    assert!(!result.is_error);
    let out_before = result.text.find("OUT_BEFORE").expect("OUT_BEFORE present");
    let first_err = result.text.find("ERR_0001").expect("ERR_0001 present");
    let last_err = result.text.find("ERR_2000").expect("ERR_2000 present");
    let out_after = result.text.find("OUT_AFTER").expect("OUT_AFTER present");
    assert!(out_before < first_err, "{:?}", result.text);
    assert!(first_err < last_err, "{:?}", result.text);
    assert!(last_err < out_after, "{:?}", result.text);
}

#[tokio::test]
async fn bash_non_zero_is_error() {
    let cwd = temp_dir("non_zero");

    let result = execute(json!({"command": "printf 'bad'; exit 7"}), &cwd)
        .await
        .expect("non-zero exits are represented as tool results");

    assert!(result.is_error);
    assert!(result.text.contains("exit code: 7"), "{:?}", result.text);
    assert!(result.text.contains("bad"), "{:?}", result.text);
}

#[tokio::test]
async fn bash_timeout() {
    let cwd = temp_dir("timeout");
    let started = cwd.join("started");
    let done = cwd.join("done");
    let command = "touch started; sleep 5; touch done";
    let start = Instant::now();

    let result = execute(json!({"command": command, "timeout_secs": 0.5}), &cwd)
        .await
        .expect("timeout should be represented as an error tool result");

    assert!(result.is_error);
    assert!(result.text.contains("timed out"), "{:?}", result.text);
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(started.exists());
    assert!(!done.exists());
}

#[tokio::test]
async fn bash_background_child_inherits_pipe_does_not_hang() {
    let cwd = temp_dir("background_pipe");
    let done = cwd.join("background_done");
    let start = Instant::now();

    let result = tokio::time::timeout(
        Duration::from_secs(2),
        execute(
            json!({
                "command": "(sleep 0.5; touch background_done) & printf 'parent done\\n'",
                "timeout_secs": 10
            }),
            &cwd,
        ),
    )
    .await
    .expect("bash should not wait forever for inherited background pipes")
    .expect("bash execution");

    assert!(!result.is_error);
    assert!(result.text.contains("parent done"), "{:?}", result.text);
    assert!(start.elapsed() < Duration::from_secs(2));
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(!done.exists());
}

#[tokio::test]
async fn bash_truncates_tail_and_preserves_status_or_stderr() {
    let cwd = temp_dir("truncate_tail");

    let result = execute(
        json!({
            "command": "printf START; yes abcdefghijklmnopqrstuvwxyz | head -c 70000; printf 'ERR_TAIL' >&2; exit 9"
        }),
        &cwd,
    )
    .await
    .expect("bash execution");

    assert!(result.is_error);
    assert!(
        result.text.contains("[botified output truncated"),
        "{:?}",
        result.text
    );
    assert!(result.text.contains("exit code: 9"), "{:?}", result.text);
    assert!(result.text.contains("ERR_TAIL"), "{:?}", result.text);
    assert!(!result.text.contains("START"), "{:?}", result.text);
    assert!(result.text.len() < 66_000, "output was not capped");
}

#[tokio::test]
async fn bash_filters_provider_secret_env() {
    let _guard = BASH_TEST_LOCK.lock().await;
    let cwd = temp_dir("secrets");
    let keys = [
        "OPENAI_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "DEEPSEEK_API_KEY",
        "BOTIFIED_SERVICE_KEY",
        "CUSTOM_TOKEN",
        "HIDDEN_SECRET",
        "DB_PASSWORD",
        "GITHUB_PAT",
        "NPM_CONFIG__AUTH",
        "MYSQL_PWD",
        "AUTHORIZATION",
        "BOTIFIED_SAFE_VISIBLE",
    ];
    let _restore = EnvRestore::capture(&keys);

    env::set_var("OPENAI_API_KEY", "openai-secret");
    env::set_var("AWS_ACCESS_KEY_ID", "aws-access-secret");
    env::set_var("DEEPSEEK_API_KEY", "deepseek-secret");
    env::set_var("BOTIFIED_SERVICE_KEY", "service-secret");
    env::set_var("CUSTOM_TOKEN", "token-secret");
    env::set_var("HIDDEN_SECRET", "hidden-secret");
    env::set_var("DB_PASSWORD", "password-secret");
    env::set_var("GITHUB_PAT", "github-pat-secret");
    env::set_var("NPM_CONFIG__AUTH", "npm-auth-secret");
    env::set_var("MYSQL_PWD", "mysql-pwd-secret");
    env::set_var("AUTHORIZATION", "authorization-secret");
    env::set_var("BOTIFIED_SAFE_VISIBLE", "visible-value");

    let result = execute_unlocked(
        json!({
            "command": "env | sort"
        }),
        &cwd,
    )
    .await
    .expect("bash execution");

    for secret in [
        "openai-secret",
        "deepseek-secret",
        "service-secret",
        "token-secret",
        "hidden-secret",
        "password-secret",
        "aws-access-secret",
        "github-pat-secret",
        "npm-auth-secret",
        "mysql-pwd-secret",
        "authorization-secret",
    ] {
        assert!(!result.text.contains(secret), "leaked {secret}");
    }
    assert!(result.text.contains("BOTIFIED_SAFE_VISIBLE=visible-value"));
}

#[tokio::test]
async fn bash_filters_bash_func_env_through_public_api() {
    let _guard = BASH_TEST_LOCK.lock().await;
    let cwd = temp_dir("bash_func_env");
    let key = "BASH_FUNC_module%%";
    let _restore = EnvRestore::capture(&[key]);
    env::set_var(key, "() { echo polluted; }");

    let result = execute_unlocked(
        json!({
            "command": "printf 'BASH_PUBLIC_API_MARKER\\n'; if declare -F module >/dev/null; then module; fi"
        }),
        &cwd,
    )
    .await
    .expect("bash execution");

    assert!(!result.is_error, "{:?}", result.text);
    assert_eq!(result.details["exit_code"], json!(0));
    assert_eq!(result.details["timed_out"], json!(false));
    assert_eq!(result.details["cancelled"], json!(false));
    assert!(
        result.text.contains("BASH_PUBLIC_API_MARKER"),
        "{:?}",
        result.text
    );

    let aggregated_output = result.details["aggregated_output"]
        .as_str()
        .expect("bash details should include aggregated output");
    assert!(
        aggregated_output.contains("BASH_PUBLIC_API_MARKER"),
        "{aggregated_output:?}"
    );
    for forbidden in ["exported function", "import", "polluted"] {
        assert!(
            !result.text.contains(forbidden),
            "{forbidden} leaked in text"
        );
        assert!(
            !aggregated_output.contains(forbidden),
            "{forbidden} leaked in output"
        );
    }
}

#[tokio::test]
async fn bash_cancel_kills_process() {
    let _guard = BASH_TEST_LOCK.lock().await;
    let cwd = temp_dir("cancel");
    let cancel = CancellationToken::new();
    let tool = Arc::new(BashTool::new());
    let started = cwd.join("started");
    let done = cwd.join("done");
    let child_cancel = cancel.clone();

    let handle = tokio::spawn(async move {
        tool.execute(
            call(json!({"command": "touch started; sleep 5; touch done"})),
            context(&cwd),
            child_cancel,
        )
        .await
    });

    let deadline = Instant::now() + Duration::from_secs(2);
    while !started.exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(started.exists());

    cancel.cancel();
    let result = handle
        .await
        .expect("join bash task")
        .expect("cancel should be represented as an error tool result");

    assert!(result.is_error);
    assert!(result.text.contains("cancelled"), "{:?}", result.text);
    assert!(!done.exists());
}

#[tokio::test]
async fn bash_execution_with_output_sink_writes_live_artifact_and_snapshot() {
    let _guard = BASH_TEST_LOCK.lock().await;
    let cwd = temp_dir("output_sink");
    let data_dir = cwd.join(".botified").join("state");
    let manager = Arc::new(BackgroundTaskManager::with_output_tail_limit(16));
    let policy = TaskOutputPolicy::new(&data_dir, 16, 64);
    let sink = BoundedTaskOutputSink::create(&policy, &cwd, "t_bash_sink", Some(manager.clone()))
        .expect("sink should be created");
    manager.start_task_with_id(
        "t_bash_sink",
        NewBackgroundTask::new("call_bash", "bash", "printf")
            .with_artifact_path(sink.artifact_path().expect("artifact path")),
    );

    let result = BashTool::new()
        .execute(
            call(json!({"command": "printf 'out'; printf 'err' >&2"})),
            context(&cwd).with_output_sink(sink as Arc<dyn ToolOutputSink>),
            CancellationToken::new(),
        )
        .await
        .expect("bash execution");

    assert!(!result.is_error);
    let artifact_path = data_dir.join("tasks/t_bash_sink/output.log");
    assert_eq!(
        fs::read_to_string(artifact_path).expect("artifact"),
        "outerr"
    );
    let snapshot = manager.get("t_bash_sink").expect("task snapshot");
    assert_eq!(snapshot.output.output_bytes, 6);
    assert_eq!(snapshot.output.tail, "outerr");
    assert!(!snapshot.output.output_live);
    assert!(snapshot.output.output_complete);
    assert_eq!(result.details["output_bytes"], json!(6));
    assert_eq!(result.details["output_artifact_truncated"], json!(false));
}
