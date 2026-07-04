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
        capabilities: ["text"],
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

    assert.equal(config.service.host, "0.0.0.0");
    assert.equal(config.service.service_key_env, "BOTIFIED_SERVICE_KEY");
    assert.deepEqual(config.tools.enabled, ["bash", "view_image"]);
    assert.equal(config.registry.enabled, false);
    assert.equal(config.subagents.enabled, false);
    assert.equal(config.profiling.enabled, false);
    assert.equal(config.llm_text_preview.enabled, false);
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

