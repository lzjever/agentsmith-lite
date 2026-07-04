use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use botified::config::{
    default_example_yaml, RuntimeConfig, RuntimeConfigLoad, RuntimeRegistryConfig,
    RuntimeTimelineConfig, RuntimeTool, RuntimeToolsConfig,
};
use botified::config::{resolve_files_root_dir, resolve_runtime_paths};
use botified::provider::thinking::{ThinkingFormat, ThinkingLevel};
use botified::registry::RegistryStoreOptions;
use botified::ProviderCapability;
use serde_yaml::Value;

#[test]
fn example_yaml_roundtrips_and_contains_runtime_sections_without_credentials() {
    let yaml = default_example_yaml();
    for section in [
        "version:",
        "providers:",
        "tools:",
        "service:",
        "runtime:",
        "files:",
        "skills:",
        "context_files:",
        "subagents:",
        "compact:",
        "profiling:",
        "llm_text_preview:",
        "timeline:",
        "registry:",
    ] {
        assert!(yaml.contains(section), "example should contain {section}");
    }

    let config = RuntimeConfig::from_yaml_str(yaml).expect("example should parse");
    let rendered = serde_yaml::to_string(&config).expect("example should serialize");
    let reparsed = RuntimeConfig::from_yaml_str(&rendered).expect("rendered example should parse");
    assert_eq!(reparsed, config);

    assert!(config.tools.enabled.contains(&RuntimeTool::Bash));
    assert!(config.tools.enabled.contains(&RuntimeTool::ViewImage));
    assert!(config.providers.len() >= 3);
    assert!(config.providers.iter().any(|provider| {
        provider.capabilities.contains(&ProviderCapability::Text)
            && provider
                .capabilities
                .contains(&ProviderCapability::ToolCalls)
    }));
    assert!(config.providers.iter().any(|provider| {
        provider.capabilities.contains(&ProviderCapability::Text)
            && provider.capabilities.contains(&ProviderCapability::Image)
    }));
    assert!(config
        .providers
        .iter()
        .any(|provider| !provider.thinking.level.is_off()));

    let value: Value = serde_yaml::from_str(yaml).expect("example yaml value");
    assert_eq!(
        value["runtime"]["data_dir"].as_str(),
        Some(".botified/state")
    );
    assert!(
        value["runtime"].get("max_turns").is_none(),
        "runtime.max_turns must not be user-visible in the pre-GA config"
    );
    assert!(!yaml.contains("max_turns"));
    assert_no_secret_strings(&value);
    assert_eq!(value["profiling"]["enabled"].as_bool(), Some(false));
    assert!(value["profiling"]["output_dir"].is_null());
    assert!(value["profiling"]["run_label"].is_null());
    assert_eq!(value["llm_text_preview"]["enabled"].as_bool(), Some(false));
    assert_eq!(value["registry"]["enabled"].as_bool(), Some(true));
    assert_eq!(value["registry"]["retention_secs"].as_u64(), Some(300));
    assert_eq!(value["registry"]["default_ttl_secs"].as_u64(), Some(5));
    assert_eq!(value["registry"]["max_topics"].as_u64(), Some(4096));
    assert_eq!(value["registry"]["max_topic_len"].as_u64(), Some(256));
    assert_eq!(value["registry"]["max_source_len"].as_u64(), Some(128));
    assert_eq!(value["registry"]["max_value_bytes"].as_u64(), Some(8192));
    assert_eq!(value["registry"]["max_history_items"].as_u64(), Some(20000));
    assert_eq!(
        value["registry"]["max_history_bytes"].as_u64(),
        Some(67_108_864)
    );
    assert_eq!(value["registry"]["default_query_limit"].as_u64(), Some(100));
    assert_eq!(value["registry"]["max_query_limit"].as_u64(), Some(1000));
    assert_eq!(
        value["registry"]["max_response_bytes"].as_u64(),
        Some(262_144)
    );
    assert_eq!(
        value["registry"]["websocket_max_frame_bytes"].as_u64(),
        Some(65_536)
    );
    assert_eq!(config.registry, RuntimeRegistryConfig::default());
    assert_eq!(value["timeline"]["retention_days"].as_u64(), Some(14));
    assert_eq!(config.timeline.retention_days, 14);
    assert_eq!(value["subagents"]["enabled"].as_bool(), Some(true));
    assert_eq!(value["subagents"]["max_parallel"].as_u64(), Some(3));
    assert_eq!(value["subagents"]["max_branches"].as_u64(), Some(32));
    assert!(value["subagents"]["model_aliases"]
        .as_mapping()
        .expect("model_aliases should be a mapping")
        .is_empty());
    assert_eq!(value["files"]["root_dir"].as_str(), Some("files"));
    assert_eq!(value["files"]["max_file_bytes"].as_u64(), Some(52_428_800));
    assert!(value["files"].get("enabled").is_none());
}

#[test]
fn timeline_config_defaults_to_fourteen_days_when_section_is_omitted() {
    let mut value: Value =
        serde_yaml::from_str(default_example_yaml()).expect("example yaml value");
    let root = value
        .as_mapping_mut()
        .expect("runtime config should be a mapping");
    root.remove(Value::String("timeline".to_owned()));
    let yaml = serde_yaml::to_string(&value).expect("yaml without timeline");

    let config = RuntimeConfig::from_yaml_str(&yaml).expect("omitted timeline should use defaults");

    assert_eq!(
        config.timeline.retention_days,
        RuntimeTimelineConfig::DEFAULT_RETENTION_DAYS
    );
}

#[test]
fn timeline_config_rejects_retention_days_less_than_one_and_unknown_fields() {
    let zero = default_example_yaml().replace("  retention_days: 14\n", "  retention_days: 0\n");
    let error = RuntimeConfig::from_yaml_str(&zero).expect_err("zero retention should fail");
    assert!(
        error.to_string().contains("timeline retention_days"),
        "error should name retention_days: {error}"
    );

    let unknown = default_example_yaml().replace(
        "timeline:\n  retention_days: 14\n",
        "timeline:\n  retention_days: 14\n  hot_event_capacity: 1024\n",
    );
    let error = RuntimeConfig::from_yaml_str(&unknown).expect_err("unknown timeline field");
    assert!(
        error.to_string().contains("hot_event_capacity"),
        "error should name unknown field: {error}"
    );
}

#[test]
fn subagents_config_defaults_to_disabled_when_section_is_omitted() {
    let mut value: Value =
        serde_yaml::from_str(default_example_yaml()).expect("example yaml value");
    let root = value
        .as_mapping_mut()
        .expect("runtime config should be a mapping");
    root.remove(Value::String("subagents".to_owned()));
    let yaml = serde_yaml::to_string(&value).expect("yaml without subagents");

    let config =
        RuntimeConfig::from_yaml_str(&yaml).expect("omitted subagents should use defaults");

    assert!(!config.subagents.enabled);
    assert_eq!(config.subagents.max_parallel, 3);
    assert_eq!(config.subagents.max_branches, 32);
    assert!(config.subagents.model_aliases.is_empty());
}

#[test]
fn subagents_config_parses_explicit_values() {
    let yaml = yaml_with_subagents(
        serde_yaml::from_str(
            r#"
enabled: true
max_parallel: 2
max_branches: 7
model_aliases:
  fast: text-main
  reason: reasoning-main
"#,
        )
        .expect("subagents yaml"),
    );

    let config = RuntimeConfig::from_yaml_str(&yaml).expect("explicit subagents should parse");

    assert!(config.subagents.enabled);
    assert_eq!(config.subagents.max_parallel, 2);
    assert_eq!(config.subagents.max_branches, 7);
    assert_eq!(
        config
            .subagents
            .model_aliases
            .get("fast")
            .map(String::as_str),
        Some("text-main")
    );
    assert_eq!(
        config
            .subagents
            .model_aliases
            .get("reason")
            .map(String::as_str),
        Some("reasoning-main")
    );
}

#[test]
fn subagents_config_rejects_invalid_limits() {
    for (label, yaml) in [
        (
            "zero max_parallel",
            r#"
enabled: true
max_parallel: 0
max_branches: 7
model_aliases: {}
"#,
        ),
        (
            "zero max_branches",
            r#"
enabled: true
max_parallel: 2
max_branches: 0
model_aliases: {}
"#,
        ),
    ] {
        let yaml = yaml_with_subagents(serde_yaml::from_str(yaml).expect("subagents yaml"));
        assert!(
            RuntimeConfig::from_yaml_str(&yaml).is_err(),
            "{label} should fail validation"
        );
    }
}

#[test]
fn subagents_config_rejects_model_aliases_that_do_not_reference_configured_providers() {
    let yaml = yaml_with_subagents(
        serde_yaml::from_str(
            r#"
enabled: true
max_parallel: 2
max_branches: 7
model_aliases:
  fast: missing-provider
"#,
        )
        .expect("subagents yaml"),
    );

    let error =
        RuntimeConfig::from_yaml_str(&yaml).expect_err("unknown provider model alias should fail");

    assert!(error.to_string().contains("fast"));
    assert!(error.to_string().contains("missing-provider"));
}

#[test]
fn subagents_config_rejects_unknown_and_removed_fields() {
    for field in ["timeout_secs", "team_id", "tools"] {
        let yaml = yaml_with_subagents(
            serde_yaml::from_str(&format!(
                r#"
enabled: false
max_parallel: 3
max_branches: 32
model_aliases: {{}}
{field}: removed
"#
            ))
            .expect("subagents yaml"),
        );

        let error =
            RuntimeConfig::from_yaml_str(&yaml).expect_err("unknown subagents field should fail");
        assert!(
            error.to_string().contains(field),
            "error should name unknown field {field}: {error}"
        );
    }
}

#[test]
fn llm_text_preview_config_defaults_to_disabled_when_section_is_omitted() {
    let mut value: Value =
        serde_yaml::from_str(default_example_yaml()).expect("example yaml value");
    let root = value
        .as_mapping_mut()
        .expect("runtime config should be a mapping");
    root.remove(Value::String("llm_text_preview".to_owned()));
    let yaml = serde_yaml::to_string(&value).expect("yaml without llm_text_preview");

    let config =
        RuntimeConfig::from_yaml_str(&yaml).expect("omitted preview config should use defaults");

    assert!(!config.llm_text_preview.enabled);
}

#[test]
fn llm_text_preview_config_parses_enabled_true() {
    let yaml = default_example_yaml().replace(
        "llm_text_preview:\n  enabled: false\n",
        "llm_text_preview:\n  enabled: true\n",
    );

    let config = RuntimeConfig::from_yaml_str(&yaml).expect("preview enabled should parse");

    assert!(config.llm_text_preview.enabled);
}

#[test]
fn llm_text_preview_config_rejects_unknown_fields() {
    let yaml = default_example_yaml().replace(
        "llm_text_preview:\n  enabled: false\n",
        "llm_text_preview:\n  enabled: false\n  replay: true\n",
    );

    let error = RuntimeConfig::from_yaml_str(&yaml).expect_err("unknown preview field should fail");

    assert!(
        error.to_string().contains("replay"),
        "error should name unknown field: {error}"
    );
}

#[test]
fn registry_config_defaults_when_section_is_omitted() {
    let mut value: Value =
        serde_yaml::from_str(default_example_yaml()).expect("example yaml value");
    let root = value
        .as_mapping_mut()
        .expect("runtime config should be a mapping");
    root.remove(Value::String("registry".to_owned()));
    let yaml = serde_yaml::to_string(&value).expect("yaml without registry");

    let config = RuntimeConfig::from_yaml_str(&yaml).expect("omitted registry should use defaults");

    assert_eq!(config.registry, RuntimeRegistryConfig::default());
    assert!(config.registry.enabled);
    assert_eq!(config.registry.retention_secs.as_secs_f64(), 300.0);
    assert_eq!(config.registry.default_ttl_secs.as_secs_f64(), 5.0);
}

#[test]
fn registry_config_parses_disabled_and_rejects_unknown_fields() {
    let yaml = default_example_yaml().replace(
        "registry:\n  enabled: true\n",
        "registry:\n  enabled: false\n",
    );
    let config = RuntimeConfig::from_yaml_str(&yaml).expect("disabled registry should parse");
    assert!(!config.registry.enabled);

    let unknown = default_example_yaml().replace(
        "registry:\n  enabled: true\n",
        "registry:\n  enabled: true\n  replay: true\n",
    );
    let error = RuntimeConfig::from_yaml_str(&unknown).expect_err("unknown registry field");
    assert!(
        error.to_string().contains("replay"),
        "error should name unknown field: {error}"
    );
}

#[test]
fn registry_config_rejects_invalid_limits() {
    for (label, from, to, expected) in [
        (
            "zero retention",
            "retention_secs: 300",
            "retention_secs: 0",
            "retention_secs",
        ),
        (
            "default ttl greater than retention",
            "default_ttl_secs: 5",
            "default_ttl_secs: 301",
            "default_ttl_secs",
        ),
        (
            "nan ttl",
            "default_ttl_secs: 5",
            "default_ttl_secs: .nan",
            "default_ttl_secs",
        ),
        (
            "zero max topics",
            "max_topics: 4096",
            "max_topics: 0",
            "max_topics",
        ),
        (
            "zero max topic length",
            "max_topic_len: 256",
            "max_topic_len: 0",
            "max_topic_len",
        ),
        (
            "zero max source length",
            "max_source_len: 128",
            "max_source_len: 0",
            "max_source_len",
        ),
        (
            "zero max value bytes",
            "max_value_bytes: 8192",
            "max_value_bytes: 0",
            "max_value_bytes",
        ),
        (
            "zero max history items",
            "max_history_items: 20000",
            "max_history_items: 0",
            "max_history_items",
        ),
        (
            "zero max history bytes",
            "max_history_bytes: 67108864",
            "max_history_bytes: 0",
            "max_history_bytes",
        ),
        (
            "zero default query limit",
            "default_query_limit: 100",
            "default_query_limit: 0",
            "default_query_limit",
        ),
        (
            "default query limit above max",
            "default_query_limit: 100",
            "default_query_limit: 1001",
            "default_query_limit",
        ),
        (
            "zero max query limit",
            "max_query_limit: 1000",
            "max_query_limit: 0",
            "max_query_limit",
        ),
        (
            "zero max response bytes",
            "max_response_bytes: 262144",
            "max_response_bytes: 0",
            "max_response_bytes",
        ),
        (
            "zero websocket frame bytes",
            "websocket_max_frame_bytes: 65536",
            "websocket_max_frame_bytes: 0",
            "websocket_max_frame_bytes",
        ),
    ] {
        let yaml = default_example_yaml().replace(from, to);
        let error =
            RuntimeConfig::from_yaml_str(&yaml).expect_err("invalid registry config should fail");
        assert!(
            error.to_string().contains(expected),
            "{label} should name {expected}: {error}"
        );
    }
}

#[test]
fn registry_runtime_config_carries_websocket_frame_limit_into_store_options() {
    let yaml = default_example_yaml().replace(
        "websocket_max_frame_bytes: 65536",
        "websocket_max_frame_bytes: 512",
    );

    let config =
        RuntimeConfig::from_yaml_str(&yaml).expect("registry websocket limit should parse");
    let options = config.registry.store_options();

    assert_eq!(
        options,
        RegistryStoreOptions::default().with_websocket_max_frame_bytes(512)
    );
}

#[test]
fn files_config_defaults_when_section_is_omitted_and_rejects_enabled() {
    let mut value: Value =
        serde_yaml::from_str(default_example_yaml()).expect("example yaml value");
    let root = value
        .as_mapping_mut()
        .expect("runtime config should be a mapping");
    root.remove(Value::String("files".to_owned()));
    let yaml = serde_yaml::to_string(&value).expect("yaml without files");

    let config = RuntimeConfig::from_yaml_str(&yaml).expect("omitted files should use defaults");

    assert_eq!(config.files.root_dir, PathBuf::from("files"));
    assert_eq!(config.files.max_upload_files, 16);
    assert_eq!(config.files.retention_secs, 604_800);

    let with_enabled = default_example_yaml().replace(
        "files:\n  root_dir: files\n",
        "files:\n  enabled: true\n  root_dir: files\n",
    );
    let error =
        RuntimeConfig::from_yaml_str(&with_enabled).expect_err("files.enabled should be rejected");
    assert!(
        error.to_string().contains("enabled"),
        "error should name unknown field: {error}"
    );
}

#[test]
fn profiling_config_defaults_to_disabled_when_section_is_omitted() {
    let mut value: Value =
        serde_yaml::from_str(default_example_yaml()).expect("example yaml value");
    let root = value
        .as_mapping_mut()
        .expect("runtime config should be a mapping");
    root.remove(Value::String("profiling".to_owned()));
    let yaml = serde_yaml::to_string(&value).expect("yaml without profiling");

    let config =
        RuntimeConfig::from_yaml_str(&yaml).expect("omitted profiling should use defaults");

    assert!(!config.profiling.enabled);
    assert!(config.profiling.output_dir.is_none());
    assert!(config.profiling.run_label.is_none());
}

#[test]
fn profiling_config_rejects_unknown_fields() {
    let yaml = default_example_yaml().replace(
        "  run_label: null\n",
        "  run_label: null\n  capture_payloads: true\n",
    );

    let error =
        RuntimeConfig::from_yaml_str(&yaml).expect_err("unknown profiling field should fail");

    assert!(
        error.to_string().contains("capture_payloads"),
        "error should name unknown field: {error}"
    );
}

#[test]
fn runtime_config_rejects_pre_ga_max_turns_field() {
    let yaml =
        default_example_yaml().replace("  session: null\n", "  session: null\n  max_turns: 8\n");

    let error = RuntimeConfig::from_yaml_str(&yaml).expect_err("old max_turns config should fail");

    assert!(
        error.to_string().contains("max_turns"),
        "error should name the removed field: {error}"
    );
}

#[test]
fn tool_execution_config_example_roundtrips_and_contains_tools_execution() {
    let yaml = default_example_yaml();
    assert!(yaml.contains("tools:"));
    assert!(yaml.contains("execution:"));
    for field in [
        "default_detach_after_secs:",
        "max_detach_after_secs:",
        "default_timeout_secs:",
        "max_timeout_secs:",
        "max_concurrent_tasks:",
        "callback_output_tail_bytes:",
        "max_task_output_bytes:",
        "max_task_ask_pending_secs:",
        "max_retained_tasks:",
        "task_retention_secs:",
    ] {
        assert!(yaml.contains(field), "example should contain {field}");
    }
    assert!(
        !yaml.contains("max_task_request_pending_secs:"),
        "example should not contain removed request-pending field"
    );

    let config = RuntimeConfig::from_yaml_str(yaml).expect("example should parse");
    assert_tool_execution_defaults(&config);

    let rendered = serde_yaml::to_string(&config).expect("example should serialize");
    assert!(
        rendered.contains("max_task_ask_pending_secs:"),
        "serialized config should contain ask pending field"
    );
    assert!(
        !rendered.contains("max_task_request_pending_secs:"),
        "serialized config should not contain removed request-pending field"
    );
    let reparsed = RuntimeConfig::from_yaml_str(&rendered).expect("rendered example should parse");
    assert_eq!(reparsed, config);
}

#[test]
fn tool_execution_config_defaults_match_constants_when_section_is_omitted() {
    let mut value: Value =
        serde_yaml::from_str(default_example_yaml()).expect("example yaml value");
    let tools = value["tools"]
        .as_mapping_mut()
        .expect("tools should be a mapping");
    tools.remove(Value::String("execution".to_owned()));
    let yaml = serde_yaml::to_string(&value).expect("yaml without tools.execution");

    let config =
        RuntimeConfig::from_yaml_str(&yaml).expect("omitted tools.execution should use defaults");

    assert_tool_execution_defaults(&config);
}

#[test]
fn tool_execution_config_defaults_new_task_ask_pending_field_when_omitted() {
    let yaml = default_example_yaml().replace("    max_task_ask_pending_secs: 300.0\n", "");

    let config =
        RuntimeConfig::from_yaml_str(&yaml).expect("omitted pending timeout should use default");

    assert_eq!(
        config.tools.execution.max_task_ask_pending_secs,
        RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_TASK_ASK_PENDING_SECS
    );
}

#[test]
fn tool_execution_config_rejects_removed_task_request_pending_field() {
    let yaml = default_example_yaml().replace(
        "    max_task_ask_pending_secs: 300.0\n",
        "    max_task_request_pending_secs: 300.0\n",
    );

    let error =
        RuntimeConfig::from_yaml_str(&yaml).expect_err("removed request pending field should fail");

    assert!(
        error.to_string().contains("max_task_request_pending_secs"),
        "error should name removed field: {error}"
    );
}

#[test]
fn tool_execution_config_task_ask_pending_error_names_new_field() {
    let yaml = default_example_yaml().replace(
        "max_task_ask_pending_secs: 300.0",
        "max_task_ask_pending_secs: 0.0",
    );

    let error =
        RuntimeConfig::from_yaml_str(&yaml).expect_err("invalid ask pending timeout should fail");

    assert!(
        error.to_string().contains("max_task_ask_pending_secs"),
        "error should name ask pending field: {error}"
    );
}

#[test]
fn tool_execution_config_invalid_bounds_are_rejected() {
    for (label, from, to) in [
        (
            "zero default detach",
            "default_detach_after_secs: 1.0",
            "default_detach_after_secs: 0.0",
        ),
        (
            "negative default detach",
            "default_detach_after_secs: 1.0",
            "default_detach_after_secs: -1.0",
        ),
        (
            "nan default detach",
            "default_detach_after_secs: 1.0",
            "default_detach_after_secs: .nan",
        ),
        (
            "infinite default timeout",
            "default_timeout_secs: 120.0",
            "default_timeout_secs: .inf",
        ),
        (
            "detach default greater than max",
            "default_detach_after_secs: 1.0",
            "default_detach_after_secs: 11.0",
        ),
        (
            "timeout default greater than max",
            "default_timeout_secs: 120.0",
            "default_timeout_secs: 1801.0",
        ),
        (
            "zero max concurrent tasks",
            "max_concurrent_tasks: 4",
            "max_concurrent_tasks: 0",
        ),
        (
            "zero callback tail bytes",
            "callback_output_tail_bytes: 8192",
            "callback_output_tail_bytes: 0",
        ),
        (
            "zero max task output bytes",
            "max_task_output_bytes: 16777216",
            "max_task_output_bytes: 0",
        ),
        (
            "zero max task ask pending",
            "max_task_ask_pending_secs: 300.0",
            "max_task_ask_pending_secs: 0.0",
        ),
        (
            "negative max task ask pending",
            "max_task_ask_pending_secs: 300.0",
            "max_task_ask_pending_secs: -1.0",
        ),
        (
            "zero max retained tasks",
            "max_retained_tasks: 128",
            "max_retained_tasks: 0",
        ),
        (
            "zero task retention",
            "task_retention_secs: 86400",
            "task_retention_secs: 0",
        ),
    ] {
        let yaml = default_example_yaml().replace(from, to);
        assert!(
            RuntimeConfig::from_yaml_str(&yaml).is_err(),
            "{label} should be rejected by parsing or validation"
        );
    }
}

#[test]
fn tool_execution_config_fractional_seconds_parse() {
    let yaml = default_example_yaml()
        .replace(
            "default_detach_after_secs: 1.0",
            "default_detach_after_secs: 1.5",
        )
        .replace(
            "default_timeout_secs: 120.0",
            "default_timeout_secs: 120.25",
        );

    let config = RuntimeConfig::from_yaml_str(&yaml).expect("fractional seconds should parse");

    assert_eq!(
        config.tools.execution.default_detach_after_secs.as_millis(),
        1500
    );
    assert_eq!(
        config.tools.execution.default_timeout_secs.as_millis(),
        120250
    );
}

#[test]
fn runtime_paths_resolve_from_config_dir_then_cwd() {
    let root = temp_dir("relative-runtime-paths");
    let startup_dir = root.join("startup");
    let cwd = startup_dir.join("project");
    fs::create_dir_all(&cwd).expect("create cwd");

    let config_path = Path::new("configs/botified.yaml");
    let mut config = RuntimeConfig::example();
    config.runtime.cwd = PathBuf::from("../project");
    config.runtime.data_dir = PathBuf::from(".botified/state");

    let paths = resolve_runtime_paths(config_path, &startup_dir, &config.runtime)
        .expect("runtime paths should resolve");

    assert_eq!(
        paths.config_path,
        startup_dir.join("configs").join("botified.yaml")
    );
    assert_eq!(paths.startup_dir, startup_dir);
    assert_eq!(paths.cwd, cwd);
    assert_eq!(paths.data_dir, paths.cwd.join(".botified").join("state"));
    assert!(
        !paths.data_dir.exists(),
        "runtime.data_dir should not need to exist before startup"
    );
}

#[test]
fn runtime_absolute_cwd_and_data_dir_are_preserved() {
    let root = temp_dir("absolute-runtime-paths");
    let startup_dir = root.join("startup");
    let cwd = root.join("srv").join("project");
    let data_dir = root.join("var").join("lib").join("botified");
    fs::create_dir_all(&cwd).expect("create cwd");

    let mut config = RuntimeConfig::example();
    config.runtime.cwd = cwd.clone();
    config.runtime.data_dir = data_dir.clone();

    let paths = resolve_runtime_paths(
        Path::new("nested/botified.yaml"),
        &startup_dir,
        &config.runtime,
    )
    .expect("runtime paths should resolve");

    assert_eq!(paths.cwd, cwd);
    assert_eq!(paths.data_dir, data_dir);
    assert!(
        !paths.data_dir.exists(),
        "runtime.data_dir should not need to exist before startup"
    );
}

#[test]
fn files_root_dir_resolves_relative_to_runtime_data_dir() {
    let root = temp_dir("files-root");
    let data_dir = root.join("state");
    let mut config = RuntimeConfig::example();

    assert_eq!(
        resolve_files_root_dir(&config.files, &data_dir),
        data_dir.join("files")
    );

    config.files.root_dir = PathBuf::from("uploads");
    assert_eq!(
        resolve_files_root_dir(&config.files, &data_dir),
        data_dir.join("uploads")
    );

    let absolute = root.join("absolute-files");
    config.files.root_dir = absolute.clone();
    assert_eq!(resolve_files_root_dir(&config.files, &data_dir), absolute);
}

#[test]
fn runtime_paths_reject_missing_cwd() {
    let root = temp_dir("missing-cwd");
    let config_dir = root.join("config");
    fs::create_dir_all(&config_dir).expect("create config dir");

    let mut config = RuntimeConfig::example();
    config.runtime.cwd = PathBuf::from("../missing-project");
    config.runtime.data_dir = PathBuf::from(".botified/state");

    let error = resolve_runtime_paths(&config_dir.join("botified.yaml"), &root, &config.runtime)
        .expect_err("missing runtime.cwd should fail");

    assert!(error.to_string().contains("runtime.cwd"));
    assert!(error.to_string().contains("missing-project"));
}

#[test]
fn runtime_paths_reject_file_cwd() {
    let root = temp_dir("file-cwd");
    let cwd_file = root.join("not-a-directory");
    fs::write(&cwd_file, "not a directory").expect("write cwd file");

    let mut config = RuntimeConfig::example();
    config.runtime.cwd = cwd_file.clone();
    config.runtime.data_dir = PathBuf::from(".botified/state");

    let error = resolve_runtime_paths(Path::new("botified.yaml"), &root, &config.runtime)
        .expect_err("file runtime.cwd should fail");

    assert!(error.to_string().contains("runtime.cwd"));
    assert!(error.to_string().contains(&cwd_file.display().to_string()));
}

#[test]
fn public_docs_use_default_state_data_dir() {
    for path in ["README.md", "docs/user-manual.md", "docs/ops-manual.md"] {
        let content = fs::read_to_string(path).expect("read public doc");
        assert!(
            content.contains("data_dir: .botified/state"),
            "{path} should document the default runtime.data_dir"
        );
        assert!(
            !content.contains("data_dir: .botified\n"),
            "{path} should not recommend .botified as runtime.data_dir"
        );
    }
}

#[test]
fn public_docs_document_timeline_contract() {
    for path in ["README.md", "docs/user-manual.md", "docs/ops-manual.md"] {
        let content = fs::read_to_string(path).expect("read public doc");

        for expected in [
            "`GET /v1/state`",
            "`POST /v1/messages`",
            "`GET /v1/timeline`",
            "`timeline_cursor`",
            "`botified.timeline.v1`",
            "`follow=false`",
            "`follow=true`",
            "`410 stale_cursor`",
            "`session_id`",
            "GET /v1/state",
            "use the returned `timeline_cursor`",
        ] {
            assert!(
                content.contains(expected),
                "{path} should document the P0 timeline contract term: {expected}"
            );
        }

        for forbidden in [
            "/v1/events",
            "msg_",
            "message_cursor",
            "original_msg_cursor",
            "latest_msg_cursor",
            "Botified Agent JSONL v1",
            "last_event_seq",
            "\"session\":",
            "botified-chat",
            "botified-monitor",
        ] {
            assert!(
                !content.contains(forbidden),
                "{path} should not expose legacy/debug public contract term: {forbidden}"
            );
        }
    }
}

#[test]
fn public_docs_document_registry_contract() {
    for path in ["README.md", "docs/user-manual.md", "docs/ops-manual.md"] {
        let content = fs::read_to_string(path).expect("read public doc");

        for expected in [
            "short-term",
            "pull-only",
            "WebSocket",
            "`/v1/registry/ws`",
            "read-only",
            "operator/debug",
            "control protocol",
            "ACL",
        ] {
            assert!(
                content.contains(expected),
                "{path} should document the registry contract term: {expected}"
            );
        }
    }
}

#[test]
fn release_docs_distinguish_private_binaries_from_public_assets() {
    let readme = fs::read_to_string("README.md").expect("read README");
    let ops = fs::read_to_string("docs/ops-manual.md").expect("read ops manual");
    let changelog = fs::read_to_string("CHANGELOG.md").expect("read changelog");
    let combined = format!("{readme}\n{ops}\n{changelog}");

    for expected in [
        "`make release` builds two Botified core bundles",
        "dist/botified-core-linux-x86_64-gnu.tar.gz",
        "dist/botified-core-linux-aarch64-gnu.tar.gz",
        "`bin/botified-tui`",
        "SHA256SUMS",
        "botified-releases",
    ] {
        assert!(
            combined.contains(expected),
            "release docs should document: {expected}"
        );
    }
}

#[test]
fn release_docs_document_core_official_skills_and_no_node_boundary() {
    for path in ["README.md", "docs/user-manual.md", "docs/ops-manual.md"] {
        let content = fs::read_to_string(path).expect("read public doc");

        for expected in [
            "share/botified/skills/botified-module-dev/SKILL.md",
            "share/botified/skills/botified-skill-creator/SKILL.md",
            "share/doc/botified/docs/",
            "official read-only skill root",
            "`botified-*`",
            "reserved for official bundled skills",
            "Core install and startup do not require Node or npm",
        ] {
            assert!(
                content.contains(expected),
                "{path} should document the official core skill release boundary term: {expected}"
            );
        }
    }
}

#[test]
fn missing_config_writes_example_and_returns_generated_marker() {
    let root = temp_dir("missing-config");
    let path = root.join("nested").join("botified.yaml");

    let loaded =
        RuntimeConfig::load_or_write_example(&path).expect("missing config should write example");

    assert_eq!(
        loaded,
        RuntimeConfigLoad::GeneratedExample { path: path.clone() }
    );
    let written = fs::read_to_string(&path).expect("example should be written");
    assert_eq!(written, default_example_yaml());
    RuntimeConfig::from_yaml_str(&written).expect("written example should parse");
}

#[test]
fn existing_config_loads_runtime_config() {
    let root = temp_dir("existing-config");
    let path = root.join("botified.yaml");
    fs::write(&path, default_example_yaml()).expect("write config");

    let loaded = RuntimeConfig::load_or_write_example(&path).expect("existing config should load");

    assert_eq!(
        loaded,
        RuntimeConfigLoad::Loaded(Box::new(RuntimeConfig::example()))
    );
    let written = fs::read_to_string(&path).expect("config should remain readable");
    assert_eq!(written, default_example_yaml());
}

#[test]
fn valid_config_resolves_provider_api_keys_without_exposing_debug_secret() {
    let config = RuntimeConfig::example();
    let providers = config
        .provider_configs([
            (
                "BOTIFIED_TEXT_API_KEY".to_owned(),
                "text-secret-value".to_owned(),
            ),
            (
                "BOTIFIED_VISION_API_KEY".to_owned(),
                "vision-secret-value".to_owned(),
            ),
            (
                "BOTIFIED_REASONING_API_KEY".to_owned(),
                "reasoning-secret-value".to_owned(),
            ),
        ])
        .expect("provider keys should resolve");

    assert_eq!(providers.len(), 3);
    assert_eq!(providers[0].profile, "text-main");
    assert_eq!(providers[0].api_key.as_deref(), Some("text-secret-value"));
    assert_eq!(providers[0].request_timeout.as_secs(), 60);
    assert_eq!(providers[2].thinking.format, ThinkingFormat::Deepseek);
    assert_eq!(providers[2].thinking.level, ThinkingLevel::High);

    let rendered = format!("{providers:?}");
    assert!(rendered.contains("[redacted]"));
    assert!(!rendered.contains("text-secret-value"));
    assert!(!rendered.contains("vision-secret-value"));
    assert!(!rendered.contains("reasoning-secret-value"));
}

#[test]
fn runtime_config_provider_summaries_expose_public_labels_without_api_keys() {
    let config = RuntimeConfig::example();
    let summaries = config.provider_summaries();

    assert_eq!(summaries.len(), 3);
    assert_eq!(summaries[0].profile, "text-main");
    assert_eq!(summaries[0].name.as_deref(), Some("text-main"));
    assert_eq!(summaries[0].model.as_deref(), Some("text-tool-model"));
    assert_eq!(
        summaries[0].capabilities,
        vec![ProviderCapability::Text, ProviderCapability::ToolCalls]
    );
    assert_eq!(summaries[1].profile, "vision-main");
    assert_eq!(summaries[1].model.as_deref(), Some("vision-model"));
    assert_eq!(
        summaries[1].capabilities,
        vec![ProviderCapability::Text, ProviderCapability::Image]
    );
}

#[test]
fn invalid_configs_reject_required_runtime_constraints() {
    assert_invalid("unsupported version", |config| {
        config.version = 2;
    });
    assert_invalid("duplicate provider", |config| {
        config.providers[1].name = config.providers[0].name.clone();
    });
    assert_invalid("zero timeout", |config| {
        config.providers[0].request_timeout_secs = 0;
    });
    assert_invalid("zero queue messages", |config| {
        config.service.max_queue_messages = 0;
    });
    assert_invalid("zero queue bytes", |config| {
        config.service.max_queue_bytes = 0;
    });
    assert_invalid("zero compact threshold", |config| {
        config.compact.threshold_tokens = 0;
    });
    assert_invalid("zero compact keep recent", |config| {
        config.compact.keep_recent_tokens = 0;
    });
    assert_invalid("invalid thinking config", |config| {
        config.providers[0].thinking.level = ThinkingLevel::High;
    });

    let capability_error = RuntimeConfig::from_yaml_str(&default_example_yaml().replace(
        "capabilities: [text, tool_calls]",
        "capabilities: [text, video]",
    ))
    .expect_err("unknown capability should fail");
    assert!(capability_error.to_string().contains("video"));

    let tool_error = RuntimeConfig::from_yaml_str(
        &default_example_yaml().replace("enabled: [bash, view_image]", "enabled: [bash, camera]"),
    )
    .expect_err("unknown tool should fail");
    assert!(tool_error.to_string().contains("camera"));

    let missing_key_error = RuntimeConfig::example()
        .provider_configs([
            (
                "BOTIFIED_TEXT_API_KEY".to_owned(),
                "text-secret-value".to_owned(),
            ),
            (
                "BOTIFIED_REASONING_API_KEY".to_owned(),
                "reasoning-secret-value".to_owned(),
            ),
        ])
        .expect_err("missing provider key should fail");
    assert!(missing_key_error
        .to_string()
        .contains("BOTIFIED_VISION_API_KEY"));
}

#[test]
fn validation_rejects_duplicate_enabled_tools() {
    let mut config = RuntimeConfig::example();
    config.tools.enabled.push(RuntimeTool::Bash);

    let error = config
        .validate()
        .expect_err("duplicate tool should fail validation");
    assert!(error.to_string().contains("duplicate enabled tool bash"));
}

#[test]
fn validation_rejects_duplicate_provider_capabilities() {
    let mut config = RuntimeConfig::example();
    config.providers[0]
        .capabilities
        .push(ProviderCapability::Text);

    let error = config
        .validate()
        .expect_err("duplicate provider capability should fail validation");
    assert!(error
        .to_string()
        .contains("provider text-main duplicate capability text"));
}

#[test]
fn validation_rejects_non_loopback_enabled_tools_without_service_key_env() {
    let mut config = RuntimeConfig::example();
    config.service.host = "0.0.0.0".to_owned();
    config.service.service_key_env = None;

    let error = config
        .validate()
        .expect_err("non-loopback tools and registry without service_key_env should fail");
    assert!(error.to_string().contains("service.service_key_env"));

    config.tools.enabled.clear();
    let error = config
        .validate()
        .expect_err("non-loopback registry without service_key_env should fail");
    assert!(error.to_string().contains("service.service_key_env"));

    config.registry.enabled = false;
    config
        .validate()
        .expect("non-loopback host is valid when tools and registry are disabled");
}

#[test]
fn validation_rejects_view_image_without_text_image_provider() {
    let mut config = RuntimeConfig::example();
    for provider in &mut config.providers {
        provider
            .capabilities
            .retain(|capability| *capability != ProviderCapability::Image);
    }

    let error = config
        .validate()
        .expect_err("view_image without vision provider should fail");
    assert!(error.to_string().contains("view_image"));
    assert!(error.to_string().contains("[text, image]"));
}

#[test]
fn service_key_env_resolves_optional_value_and_rejects_missing_or_empty_configured_env() {
    let mut config = RuntimeConfig::example();

    assert_eq!(
        config
            .resolve_service_key([(
                "BOTIFIED_SERVICE_KEY".to_owned(),
                "local-service-secret".to_owned(),
            )])
            .expect("configured service key should resolve"),
        Some("local-service-secret".to_owned())
    );

    for value in ["", "   "] {
        let error = config
            .resolve_service_key([("BOTIFIED_SERVICE_KEY".to_owned(), value.to_owned())])
            .expect_err("empty configured service key env should fail");
        assert!(error.to_string().contains("BOTIFIED_SERVICE_KEY"));
    }

    let error = config
        .resolve_service_key(std::iter::empty::<(String, String)>())
        .expect_err("missing configured service key env should fail");
    assert!(error.to_string().contains("BOTIFIED_SERVICE_KEY"));

    assert_eq!(
        config.service_key([(
            "BOTIFIED_SERVICE_KEY".to_owned(),
            "local-service-secret".to_owned(),
        )]),
        Some("local-service-secret".to_owned())
    );
    assert_eq!(
        config.service_key([("BOTIFIED_SERVICE_KEY".to_owned(), "   ".to_owned())]),
        None
    );
    assert_eq!(
        config.service_key(std::iter::empty::<(String, String)>()),
        None
    );

    config.service.service_key_env = None;
    assert_eq!(
        config
            .resolve_service_key([(
                "BOTIFIED_SERVICE_KEY".to_owned(),
                "local-service-secret".to_owned(),
            )])
            .expect("service key env is optional"),
        None
    );
}

fn assert_invalid(label: &str, mutate: impl FnOnce(&mut RuntimeConfig)) {
    let mut config = RuntimeConfig::example();
    mutate(&mut config);
    assert!(config.validate().is_err(), "{label} should fail validation");
}

fn assert_tool_execution_defaults(config: &RuntimeConfig) {
    let execution = &config.tools.execution;
    assert_eq!(
        execution.default_detach_after_secs,
        RuntimeToolsConfig::DEFAULT_EXECUTION_DEFAULT_DETACH_AFTER_SECS
    );
    assert_eq!(
        execution.max_detach_after_secs,
        RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_DETACH_AFTER_SECS
    );
    assert_eq!(
        execution.default_timeout_secs,
        RuntimeToolsConfig::DEFAULT_EXECUTION_DEFAULT_TIMEOUT_SECS
    );
    assert_eq!(
        execution.max_timeout_secs,
        RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_TIMEOUT_SECS
    );
    assert_eq!(
        execution.max_concurrent_tasks,
        RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_CONCURRENT_TASKS
    );
    assert_eq!(
        execution.callback_output_tail_bytes,
        RuntimeToolsConfig::DEFAULT_EXECUTION_CALLBACK_OUTPUT_TAIL_BYTES
    );
    assert_eq!(
        execution.max_task_output_bytes,
        RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_TASK_OUTPUT_BYTES
    );
    assert_eq!(
        execution.max_task_ask_pending_secs,
        RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_TASK_ASK_PENDING_SECS
    );
    assert_eq!(
        execution.max_retained_tasks,
        RuntimeToolsConfig::DEFAULT_EXECUTION_MAX_RETAINED_TASKS
    );
    assert_eq!(
        execution.task_retention_secs,
        RuntimeToolsConfig::DEFAULT_EXECUTION_TASK_RETENTION_SECS
    );
}

fn yaml_with_subagents(subagents: Value) -> String {
    let mut value: Value =
        serde_yaml::from_str(default_example_yaml()).expect("example yaml value");
    let root = value
        .as_mapping_mut()
        .expect("runtime config should be a mapping");
    root.insert(Value::String("subagents".to_owned()), subagents);
    serde_yaml::to_string(&value).expect("yaml with subagents")
}

fn assert_no_secret_strings(value: &Value) {
    match value {
        Value::String(value) => {
            assert!(
                !value.starts_with("sk-"),
                "example contains sk-style secret: {value}"
            );
            assert!(
                !value.to_ascii_lowercase().starts_with("bearer "),
                "example contains bearer-style secret: {value}"
            );
        }
        Value::Sequence(values) => {
            for value in values {
                assert_no_secret_strings(value);
            }
        }
        Value::Mapping(values) => {
            for (key, value) in values {
                assert_no_secret_strings(key);
                assert_no_secret_strings(value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
        Value::Tagged(tagged) => assert_no_secret_strings(&tagged.value),
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time should be after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "botified-runtime-config-{name}-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp dir");
    path
}
