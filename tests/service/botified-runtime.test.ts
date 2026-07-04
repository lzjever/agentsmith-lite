import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateBotifiedConfig, serializeBotifiedConfig } from "../../packages/botified-runtime/src/config.js";
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
    assert.equal(config.service.port, 3099);
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

  it("honors a custom service port and serializes without raw API keys", () => {
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
        modelApiKeyEnv: "MODEL_API_KEY",
        servicePort: 4100
      }
    });

    const serialized = serializeBotifiedConfig(config);

    assert.equal(config.service.port, 4100);
    assert.equal(serialized.includes('"port": 4100'), true);
    assert.equal(serialized.includes('"api_key_env": "MODEL_API_KEY"'), true);
    assert.equal(serialized.includes("sk-real-model-key"), false);
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

  it("projects actual Botified file.published metadata without leaking download URLs", () => {
    const projection = projectBotifiedTimelineEvents("task-1", [
      {
        cursor: "c1",
        seq: 1,
        session_id: "s1",
        type: "file.published",
        payload: {
          file_id: "file_actual_1",
          filename: "actual-report.txt",
          mime_type: "text/plain",
          size_bytes: 17,
          sha256: "f".repeat(64),
          download_url: "http://botified.internal/v1/files/file_actual_1?service_key=bsk_file_secret",
          source: "published",
          description: "final report"
        }
      }
    ]);

    assert.equal(projection.events.length, 1);
    assert.deepEqual(projection.artifacts.map((artifact) => ({
      fileId: artifact.fileId,
      name: artifact.name,
      bytes: artifact.bytes,
      sha256: artifact.sha256
    })), [
      {
        fileId: "file_actual_1",
        name: "actual-report.txt",
        bytes: 17,
        sha256: "f".repeat(64)
      }
    ]);
    assert.equal("download_url" in (projection.events[0]?.payload ?? {}), false);
    assert.equal("downloadUrl" in (projection.artifacts[0] ?? {}), false);
    assert.doesNotMatch(JSON.stringify(projection), /download_url|botified\.internal|bsk_file_secret|\/v1\/files/);
  });

  it("redacts secret-like timeline payload values recursively", () => {
    const projection = projectBotifiedTimelineEvents("task-1", [
      {
        cursor: "c1",
        seq: 1,
        session_id: "s1",
        type: "service.error",
        payload: {
          message: "runner returned Bearer bsk_service_secret and sk-model-secret",
          notes: ["plain", "array has bsk_array_secret", { detail: "nested sk-nested-secret" }],
          nested: {
            apiKey: "sk-field-secret",
            trace: "Bearer bsk_nested_secret"
          }
        }
      }
    ]);

    const payload = projection.events[0]?.payload as {
      message?: string;
      notes?: Array<string | { detail?: string }>;
      nested?: { apiKey?: string; trace?: string };
    };
    assert.equal(payload.message, "runner returned Bearer <redacted> and sk-<redacted>");
    assert.deepEqual(payload.notes, ["plain", "array has bsk_<redacted>", { detail: "nested sk-<redacted>" }]);
    assert.deepEqual(payload.nested, {
      apiKey: "[redacted]",
      trace: "Bearer <redacted>"
    });
    assert.doesNotMatch(JSON.stringify(projection.events), /bsk_service_secret|sk-model-secret|bsk_array_secret|sk-nested-secret|sk-field-secret|bsk_nested_secret/);
  });

  it("redacts timeline control fields without advancing to a secret-like resume cursor", () => {
    const projection = projectBotifiedTimelineEvents("task-1", [
      { cursor: "safe-c0", heartbeat: true },
      {
        cursor: "cursor-bsk_cursor_secret",
        seq: 1,
        session_id: "session-sk-session-secret",
        type: "assistant_message.completed Bearer bsk_type_secret",
        payload: { text: "ok" }
      }
    ]);

    assert.equal(projection.events.length, 1);
    assert.equal(projection.events[0]?.cursor, "cursor-bsk_<redacted>");
    assert.equal(projection.events[0]?.botifiedType, "assistant_message.completed Bearer <redacted>");
    assert.equal(projection.events[0]?.sessionId, "session-sk-<redacted>");
    assert.equal(projection.nextCursor, "safe-c0");
    assert.notEqual(projection.nextCursor, "cursor-bsk_<redacted>");
    assert.doesNotMatch(JSON.stringify(projection), /bsk_cursor_secret|sk-session-secret|bsk_type_secret/);
  });

  it("redacts secret-like file artifact identifiers and names", () => {
    const projection = projectBotifiedTimelineEvents("task-1", [
      {
        cursor: "c1",
        seq: 1,
        session_id: "s1",
        type: "file.published",
        payload: {
          file_id: "artifact-bsk_file_secret",
          name: "report Bearer bsk_service_secret and sk-model-secret.txt",
          bytes: 12
        }
      },
      {
        cursor: "c2",
        seq: 2,
        session_id: "s1",
        type: "file.published",
        payload: {
          id: "artifact-sk-id-secret",
          bytes: 8
        }
      }
    ]);

    assert.equal(projection.artifacts.length, 2);
    assert.equal(projection.artifacts[0]?.fileId, "artifact-bsk_<redacted>");
    assert.equal(projection.artifacts[0]?.name, "report Bearer <redacted> and sk-<redacted>.txt");
    assert.equal(projection.artifacts[1]?.fileId, "artifact-sk-<redacted>");
    assert.equal(projection.artifacts[1]?.name, "artifact-sk-<redacted>");
    assert.doesNotMatch(JSON.stringify(projection.artifacts), /bsk_file_secret|bsk_service_secret|sk-model-secret|sk-id-secret/);
  });
});
