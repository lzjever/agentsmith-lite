import type { EndpointCapability, ModelEndpoint } from "../../contracts/src/api.js";
import { MAX_TASK_ARTIFACT_BYTES } from "../../domain/src/sandboxDefaults.js";

// Keep an ordinary long Bash call attached past the sandbox's 30-minute idle TTL.
// Both values are intentionally bounded so a task cannot run indefinitely.
const DEFAULT_BASH_DETACH_AFTER_SECS = 31 * 60;
const MAX_BASH_TIMEOUT_SECS = 35 * 60;

export interface BotifiedTaskRuntimeInput {
  taskId: string;
  projectMountPath: string;
  taskHomePath: string;
  botifiedDataPath: string;
  serviceKeyEnv: string;
  providerApiKeyEnv: string;
  providerBaseUrl: string;
  servicePort?: number;
}

export interface GenerateBotifiedConfigInput {
  endpoint: ModelEndpoint;
  task: BotifiedTaskRuntimeInput;
}

export interface BotifiedConfig {
  version: 1;
  providers: BotifiedProviderConfig[];
  tools: BotifiedToolsConfig;
  service: BotifiedServiceConfig;
  runtime: {
    cwd: string;
    data_dir: string;
    session: string;
  };
  timeline: {
    retention_days: number;
  };
  files: {
    root_dir: string;
    max_file_bytes: number;
    max_upload_files: number;
    max_upload_request_bytes: number;
    max_message_files: number;
    max_message_referenced_file_bytes: number;
    max_store_bytes: number;
    retention_secs: number;
  };
  skills: {
    default_discovery: false;
    explicit: string[];
  };
  context_files: {
    enabled: true;
    max_total_bytes: number;
  };
  subagents: {
    enabled: false;
    max_parallel: number;
    max_branches: number;
    model_aliases: Record<string, string>;
  };
  compact: {
    enabled: boolean;
    threshold_tokens: number;
    keep_recent_tokens: number;
  };
  profiling: {
    enabled: false;
    output_dir: null;
    run_label: null;
  };
  llm_text_preview: { enabled: false };
  registry: { enabled: false };
}

export interface BotifiedProviderConfig {
  name: string;
  base_url: string;
  model: string;
  api_key_env: string;
  ca_bundle_path?: string;
  request_timeout_secs: number;
  priority: number;
  capabilities: EndpointCapability[];
  thinking: {
    format: "none";
    level: "off";
    level_map: Record<string, never>;
    budget_tokens: null;
  };
}

export type BotifiedTool = "bash" | "view_image";

export interface BotifiedToolsConfig {
  enabled: BotifiedTool[];
  execution: {
    default_detach_after_secs: number;
    max_detach_after_secs: number;
    default_timeout_secs: number;
    max_timeout_secs: number;
    max_concurrent_tasks: number;
    callback_output_tail_bytes: number;
    max_task_output_bytes: number;
    max_task_ask_pending_secs: number;
    max_retained_tasks: number;
    task_retention_secs: number;
    bash_executor_addr: string;
  };
}

export interface BotifiedServiceConfig {
  host: "0.0.0.0";
  port: number;
  service_key_env: string;
  max_queue_messages: number;
  max_queue_bytes: number;
}

export function generateBotifiedConfig(input: GenerateBotifiedConfigInput): BotifiedConfig {
  return {
    version: 1,
    providers: [providerConfig(input.endpoint, input.task)],
    tools: {
      enabled: enabledTools(input.endpoint),
      execution: {
        default_detach_after_secs: DEFAULT_BASH_DETACH_AFTER_SECS,
        max_detach_after_secs: DEFAULT_BASH_DETACH_AFTER_SECS,
        default_timeout_secs: MAX_BASH_TIMEOUT_SECS,
        max_timeout_secs: MAX_BASH_TIMEOUT_SECS,
        max_concurrent_tasks: 4,
        callback_output_tail_bytes: 8192,
        max_task_output_bytes: 16_777_216,
        max_task_ask_pending_secs: 300,
        max_retained_tasks: 128,
        task_retention_secs: 86_400,
        bash_executor_addr: "127.0.0.1:3110"
      }
    },
    service: {
      host: "0.0.0.0",
      port: input.task.servicePort ?? 3099,
      service_key_env: input.task.serviceKeyEnv,
      max_queue_messages: 32,
      max_queue_bytes: 33_554_432
    },
    runtime: {
      cwd: input.task.taskHomePath,
      data_dir: input.task.botifiedDataPath,
      session: input.task.taskId
    },
    timeline: {
      retention_days: 14
    },
    files: {
      root_dir: "files",
      max_file_bytes: MAX_TASK_ARTIFACT_BYTES,
      max_upload_files: 16,
      max_upload_request_bytes: 104_857_600,
      max_message_files: 16,
      max_message_referenced_file_bytes: 104_857_600,
      max_store_bytes: 1_073_741_824,
      retention_secs: 604_800
    },
    skills: {
      default_discovery: false,
      explicit: []
    },
    context_files: {
      enabled: true,
      max_total_bytes: 32_768
    },
    subagents: {
      enabled: false,
      max_parallel: 3,
      max_branches: 32,
      model_aliases: {}
    },
    compact: {
      enabled: true,
      threshold_tokens: 1_000_000,
      keep_recent_tokens: 32_000
    },
    profiling: {
      enabled: false,
      output_dir: null,
      run_label: null
    },
    llm_text_preview: { enabled: false },
    registry: { enabled: false }
  };
}

export function serializeBotifiedConfig(config: BotifiedConfig): string {
  return JSON.stringify(config, null, 2);
}

function providerConfig(endpoint: ModelEndpoint, task: BotifiedTaskRuntimeInput): BotifiedProviderConfig {
  return {
    name: endpoint.name,
    base_url: task.providerBaseUrl,
    model: endpoint.model,
    api_key_env: task.providerApiKeyEnv,
    request_timeout_secs: endpoint.requestTimeoutSecs,
    priority: 10,
    capabilities: endpoint.capabilities,
    thinking: {
      format: "none",
      level: "off",
      level_map: {},
      budget_tokens: null
    }
  };
}

function enabledTools(endpoint: ModelEndpoint): BotifiedTool[] {
  const tools: BotifiedTool[] = ["bash"];
  if (endpoint.capabilities.includes("text") && endpoint.capabilities.includes("image")) {
    tools.push("view_image");
  }
  return tools;
}
