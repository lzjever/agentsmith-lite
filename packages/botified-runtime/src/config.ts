import type { ModelEndpoint } from "../../contracts/src/api.js";

export interface BotifiedTaskRuntimeInput {
  taskId: string;
  projectMountPath: string;
  taskHomePath: string;
  botifiedDataPath: string;
  serviceKeyEnv: string;
  modelApiKeyEnv: string;
}

export interface GenerateBotifiedConfigInput {
  endpoint: ModelEndpoint;
  task: BotifiedTaskRuntimeInput;
}

export interface BotifiedConfig {
  providers: {
    default: {
      type: "openai_chat_completions";
      base_url: string;
      model: string;
      api_key_env: string;
      request_timeout_secs: number;
    };
  };
  runtime: {
    cwd: string;
    data_dir: string;
    project_mount: string;
  };
  tools: {
    enabled: string[];
  };
  service: {
    host: "0.0.0.0";
    port: number;
    service_key_env: string;
  };
  registry: { enabled: false };
  subagents: { enabled: false };
  llm_text_preview: { enabled: false };
  profiling: { enabled: false };
  context_files: { enabled: true };
  files: {
    max_file_bytes: number;
    max_total_bytes: number;
  };
}

export function generateBotifiedConfig(input: GenerateBotifiedConfigInput): BotifiedConfig {
  return {
    providers: {
      default: {
        type: "openai_chat_completions",
        base_url: input.endpoint.baseUrl,
        model: input.endpoint.model,
        api_key_env: input.task.modelApiKeyEnv,
        request_timeout_secs: input.endpoint.requestTimeoutSecs
      }
    },
    runtime: {
      cwd: input.task.taskHomePath,
      data_dir: input.task.botifiedDataPath,
      project_mount: input.task.projectMountPath
    },
    tools: {
      enabled: ["bash", "view_image"]
    },
    service: {
      host: "0.0.0.0",
      port: 3099,
      service_key_env: input.task.serviceKeyEnv
    },
    registry: { enabled: false },
    subagents: { enabled: false },
    llm_text_preview: { enabled: false },
    profiling: { enabled: false },
    context_files: { enabled: true },
    files: {
      max_file_bytes: 25 * 1024 * 1024,
      max_total_bytes: 250 * 1024 * 1024
    }
  };
}

