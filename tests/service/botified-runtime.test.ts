import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateBotifiedConfig, serializeBotifiedConfig } from "../../packages/botified-runtime/src/config.js";

describe("botified runtime integration", () => {
  it("generates a hardened per-task config from the supplied runtime paths", () => {
    const config = generateBotifiedConfig({
      endpoint: {
        id: "e1",
        projectId: "p1",
        name: "model",
        protocol: "openai_chat_completions",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-compatible",
        credentialId: "cred_test",
        capabilities: ["text", "tool_calls"],
        requestTimeoutSecs: 30,
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      },
      task: {
        taskId: "t1",
        taskHomePath: "/workspace/task/home/workspace",
        botifiedDataPath: "/runner/botified-data",
        providerBaseUrl: "http://agentsmith-lite-api.agentsmith.svc.cluster.local/api/internal/tasks/t1/runs/r1/v1"
      }
    });

    assert.deepEqual(Object.keys(config).sort(), [
      "context_files",
      "files",
      "llm_text_preview",
      "profiling",
      "providers",
      "registry",
      "runtime",
      "service",
      "skills",
      "subagents",
      "timeline",
      "tools",
      "version"
    ].sort());
    assert.equal(config.version, 1);
    assert.equal(Array.isArray(config.providers), true);
    assert.equal(config.providers.length, 1);
    assert.deepEqual(Object.keys(config.providers[0] ?? {}).sort(), [
      "api_compat",
      "api_key_env",
      "base_url",
      "capabilities",
      "model",
      "name",
      "priority",
      "request_timeout_secs",
      "use_env_proxy"
    ].sort());
    assert.deepEqual(config.providers[0], {
      name: "model",
      api_compat: "standard",
      base_url: "http://agentsmith-lite-api.agentsmith.svc.cluster.local/api/internal/tasks/t1/runs/r1/v1",
      model: "gpt-compatible",
      api_key_env: "AGENTSMITH_LLM_BROKER_KEY",
      use_env_proxy: false,
      request_timeout_secs: 30,
      priority: 10,
      capabilities: ["text", "tool_calls"]
    });
    assert.equal(config.service.host, "0.0.0.0");
    assert.equal(config.service.port, 3099);
    assert.equal(config.service.service_key_env, "BOTIFIED_SERVICE_KEY");
    assert.equal(config.service.max_queue_messages > 0, true);
    assert.equal(config.service.max_queue_bytes > 0, true);
    assert.deepEqual(Object.keys(config.runtime).sort(), ["cwd", "data_dir", "session"].sort());
    assert.equal(config.runtime.cwd, "/workspace/task/home/workspace");
    assert.equal(config.runtime.data_dir, "/runner/botified-data");
    assert.equal(config.runtime.session, "t1");
    assert.equal(config.files.root_dir,".artifacts/t1");
    assert.equal(pathIsInside(config.runtime.cwd, "/workspace/task/home"), true);
    assert.equal(pathIsInside(config.runtime.data_dir, "/runner"), true);
    assert.notEqual(config.runtime.cwd, config.runtime.data_dir);
    assert.notEqual(config.files.root_dir, "/workspace/task/artifacts");
    assert.deepEqual(config.tools.enabled, ["bash"]);
    assert.equal("bash_executor_addr" in config.tools.execution, false);
    assert.equal(config.skills.default_discovery, false);
    assert.deepEqual(config.skills.explicit, []);
    assert.equal(config.context_files.enabled, true);
    assert.equal(config.context_files.max_total_bytes > 0, true);
    assert.equal(config.registry.enabled, false);
    assert.equal(config.subagents.enabled, false);
    assert.equal("model_aliases" in config.subagents, false);
    assert.equal("compact" in config, false);
    assert.equal(config.profiling.enabled, false);
    assert.equal(config.llm_text_preview.enabled, true);
  });

  it("keeps execution limits without configuring the removed external Bash executor", () => {
    const config = generateBotifiedConfig({
      endpoint: {
        id: "e1", projectId: "p1", name: "model", protocol: "openai_chat_completions",
        baseUrl: "https://models.example.com/v1", model: "gpt-compatible", credentialId: "cred_test",
        capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30,
        createdAt: "2026-07-04T00:00:00.000Z", updatedAt: "2026-07-04T00:00:00.000Z"
      },
      task: {
        taskId: "t1", taskHomePath: "/runner/task-home",
        botifiedDataPath: "/runner/botified-data",
        providerBaseUrl: "http://agentsmith-lite-api.agentsmith.svc.cluster.local/v1"
      }
    });

    assert.deepEqual(Object.keys(config.tools.execution).sort(), [
      "callback_output_tail_bytes", "default_detach_after_secs", "default_timeout_secs",
      "max_concurrent_tasks", "max_detach_after_secs", "max_retained_tasks", "max_task_ask_pending_secs",
      "max_task_output_bytes", "max_timeout_secs", "task_retention_secs"
    ].sort());
    assert.equal(config.tools.execution.default_detach_after_secs, 31 * 60);
    assert.equal(config.tools.execution.max_detach_after_secs, 31 * 60);
    assert.equal(config.tools.execution.default_timeout_secs, 35 * 60);
    assert.equal(config.tools.execution.max_timeout_secs, 35 * 60);
    assert.equal(JSON.stringify(config).includes("0.0.0.0:3110"), false);
  });

  it("honors a custom service port and serializes without raw API keys", () => {
    const config = generateBotifiedConfig({
      endpoint: {
        id: "e1",
        projectId: "p1",
        name: "model",
        protocol: "openai_chat_completions",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-compatible",
        credentialId: "cred_test",
        capabilities: ["text", "tool_calls"],
        requestTimeoutSecs: 30,
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      },
      task: {
        taskId: "t1",
        taskHomePath: "/workspace/project/tasks/t1/home",
        botifiedDataPath: "/workspace/project/tasks/t1/botified",
        providerBaseUrl: "http://agentsmith-lite-api.agentsmith.svc.cluster.local/v1",
        servicePort: 4100
      }
    });

    const serialized = serializeBotifiedConfig(config);

    assert.equal(config.service.port, 4100);
    assert.equal(serialized.includes('"port": 4100'), true);
    assert.equal(serialized.includes('"api_key_env": "AGENTSMITH_LLM_BROKER_KEY"'), true);
    assert.equal(serialized.includes("sk-real-model-key"), false);
  });

  it("keeps provider credentials and CA material out of the Botified config", () => {
    const config = generateBotifiedConfig({
      endpoint: {
        id: "e1",
        projectId: "p1",
        name: "model",
        protocol: "openai_chat_completions",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-compatible",
        credentialId: "cred_test",
        capabilities: ["text", "tool_calls"],
        requestTimeoutSecs: 30,
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      },
      task: {
        taskId: "t1",
        taskHomePath: "/workspace/project/tasks/t1/home",
        botifiedDataPath: "/workspace/project/tasks/t1/botified",
        providerBaseUrl: "http://agentsmith-lite-api.agentsmith.svc.cluster.local/v1"
      }
    });

    const serialized = serializeBotifiedConfig(config);
    assert.equal(serialized.includes("MODEL_API_KEY"), false);
    assert.equal(serialized.includes("models.example.com"), false);
    assert.equal(serialized.includes("sk-real-model-key"), false);
    assert.equal(serialized.includes("BEGIN CERTIFICATE"), false);
  });

  it("enables view_image only when the configured provider can handle images", () => {
    const config = generateBotifiedConfig({
      endpoint: {
        id: "e1",
        projectId: "p1",
        name: "vision",
        protocol: "openai_chat_completions",
        baseUrl: "https://models.example.com/v1",
        model: "vision-compatible",
        credentialId: "cred_test",
        capabilities: ["text", "image"],
        requestTimeoutSecs: 30,
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      },
      task: {
        taskId: "t1",
        taskHomePath: "/workspace/project/tasks/t1/home",
        botifiedDataPath: "/workspace/project/tasks/t1/botified",
        providerBaseUrl: "http://agentsmith-lite-api.agentsmith.svc.cluster.local/v1"
      }
    });

    assert.deepEqual(config.tools.enabled, ["bash", "view_image"]);
  });

});

function pathIsInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}
