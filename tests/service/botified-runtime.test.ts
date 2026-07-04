import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateBotifiedConfig } from "../../packages/botified-runtime/src/config.js";
import { projectBotifiedTimelineEvents } from "../../packages/botified-runtime/src/projection.js";

describe("botified runtime integration", () => {
  it("generates a hardened per-task config without product TUI behavior", () => {
    const config = generateBotifiedConfig({
      endpoint: {
        id: "e1",
        projectId: "p1",
        name: "model",
        protocol: "openai_chat_completions",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-compatible",
        apiKeySecretRef: "secret/model",
        capabilities: ["text", "tool_calls"],
        requestTimeoutSecs: 30,
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      },
      task: {
        taskId: "t1",
        projectMountPath: "/workspace/project",
        taskHomePath: "/workspace/project/tasks/t1/home",
        botifiedDataPath: "/workspace/project/tasks/t1/botified",
        serviceKeyEnv: "BOTIFIED_SERVICE_KEY",
        modelApiKeyEnv: "MODEL_API_KEY"
      }
    });

    assert.deepEqual(Object.keys(config).sort(), [
      "compact",
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
      "api_key_env",
      "base_url",
      "capabilities",
      "model",
      "name",
      "priority",
      "request_timeout_secs",
      "thinking"
    ].sort());
    assert.deepEqual(config.providers[0], {
      name: "model",
      base_url: "https://models.example.com/v1",
      model: "gpt-compatible",
      api_key_env: "MODEL_API_KEY",
      request_timeout_secs: 30,
      priority: 10,
      capabilities: ["text", "tool_calls"],
      thinking: {
        format: "none",
        level: "off",
        level_map: {},
        budget_tokens: null
      }
    });
    assert.equal(config.service.host, "0.0.0.0");
    assert.equal(config.service.service_key_env, "BOTIFIED_SERVICE_KEY");
    assert.equal(config.service.max_queue_messages > 0, true);
    assert.equal(config.service.max_queue_bytes > 0, true);
    assert.deepEqual(Object.keys(config.runtime).sort(), ["cwd", "data_dir", "session"].sort());
    assert.equal(config.runtime.cwd, "/workspace/project/tasks/t1/home");
    assert.equal(config.runtime.data_dir, "/workspace/project/tasks/t1/botified");
    assert.equal(config.runtime.session, "t1");
    assert.deepEqual(config.tools.enabled, ["bash"]);
    assert.equal(config.skills.default_discovery, false);
    assert.deepEqual(config.skills.explicit, []);
    assert.equal(config.context_files.enabled, true);
    assert.equal(config.context_files.max_total_bytes > 0, true);
    assert.equal(config.registry.enabled, false);
    assert.equal(config.subagents.enabled, false);
    assert.equal(config.profiling.enabled, false);
    assert.equal(config.llm_text_preview.enabled, false);
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
        apiKeySecretRef: "secret/model",
        capabilities: ["text", "image"],
        requestTimeoutSecs: 30,
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z"
      },
      task: {
        taskId: "t1",
        projectMountPath: "/workspace/project",
        taskHomePath: "/workspace/project/tasks/t1/home",
        botifiedDataPath: "/workspace/project/tasks/t1/botified",
        serviceKeyEnv: "BOTIFIED_SERVICE_KEY",
        modelApiKeyEnv: "MODEL_API_KEY"
      }
    });

    assert.deepEqual(config.tools.enabled, ["bash", "view_image"]);
  });

  it("projects Botified timeline events idempotently and redacts secret-like fields", () => {
    const projection = projectBotifiedTimelineEvents("task-1", [
      { cursor: "c0", heartbeat: true },
      { cursor: "c1", seq: 1, session_id: "s1", type: "input.accepted", payload: { text: "hello" } },
      { cursor: "c1", seq: 1, session_id: "s1", type: "input.accepted", payload: { text: "duplicate" } },
      { cursor: "c2", seq: 2, session_id: "s1", type: "assistant_message.completed", payload: { text: "done", api_key: "sk-secret" } },
      { cursor: "c3", seq: 3, session_id: "s1", type: "file.published", payload: { file_id: "f1", name: "report.txt", bytes: 12 } }
    ]);

    assert.equal(projection.events.length, 3);
    assert.equal(projection.events[0]?.kind, "user_input");
    assert.equal(projection.events[1]?.kind, "assistant_message");
    assert.equal(projection.events[1]?.payload.api_key, "[redacted]");
    assert.equal(projection.artifacts[0]?.fileId, "f1");
    assert.equal(projection.nextCursor, "c3");
  });
});
