import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";
import type { OpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

describe("Task-only project boundary", () => {
  let api: RunningApiServer;
  let root = "";
  let cookie = "";
  let csrf = "";
  let projectId = "";

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "asl-task-only-"));
    api = await createApiServer({
      port: 0,
      dataRoot: root,
      builtinAdminPassword: "admin-password",
      store: createLocalInMemoryProductStore(),
      providerClient: providerClient()
    });
    await request("POST", "/api/v1/auth/bootstrap", { password: "admin-password" });
    const login = await request("POST", "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" });
    cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
    csrf = (login.body as { csrfToken: string }).csrfToken;
    const workspace = (await requestJson("POST", "/api/v1/workspaces", { name: "Workspace" })).workspace;
    projectId = (await requestJson("POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Project" })).id;
    const credential = await requestJson("POST", `/api/v1/projects/${projectId}/credentials`, {
      name: "Provider credential",
      baseUrl: "https://models.example.test/v1",
      secret: "sk-test"
    });
    await requestJson("POST", `/api/v1/projects/${projectId}/endpoints`, {
      name: "Task endpoint",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.test/v1",
      model: "model",
      credentialId: credential.id,
      capabilities: ["text", "tool_calls"],
      requestTimeoutSecs: 30
    });
  });

  after(async () => {
    await api.close();
    await rm(root, { recursive: true, force: true });
  });

  it("offers Task creation as the only agent-work entry and does not recognize Chat routes", async () => {
    const overview = await requestJson("GET", `/api/v1/projects/${projectId}/overview`);

    assert.deepEqual(overview.recommendedActions, ["create_task", "add_collaborator"]);
    assert.equal("canSendChat" in overview.capabilities, false);
    assert.equal("chatReadyEndpointCount" in overview, false);
    assert.equal(overview.taskReadyEndpointCount, 1);

    const removed = await request("GET", `/api/v1/projects/${projectId}/chat/threads`);
    assert.equal(removed.response.status, 404);
  });

  async function requestJson(method: string, pathname: string, body?: unknown): Promise<any> {
    const result = await request(method, pathname, body);
    assert.equal(result.response.status, 200, `${method} ${pathname}: ${JSON.stringify(result.body)}`);
    return result.body;
  }

  async function request(method: string, pathname: string, body?: unknown): Promise<{ response: Response; body: unknown }> {
    const response = await fetch(api.baseUrl + pathname, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...(["POST", "PATCH", "DELETE"].includes(method) && csrf ? { "x-csrf-token": csrf } : {}),
        ...(method === "POST" && (/^\/api\/v1\/workspaces(?:\/[^/]+\/projects)?$/.test(pathname) || /^\/api\/v1\/projects\/[^/]+\/(credentials|endpoints)$/.test(pathname)) ? { "idempotency-key": crypto.randomUUID() } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { response, body: await response.json() };
  }
});

function providerClient(): OpenAICompatibleClient {
  return {
    async validateEndpoint() {
      return { status: "healthy" };
    },
    async completeChat(_endpoint, _messages, _options) {
      return {
        message: { role: "assistant", content: "unused" },
        endpointSnapshot: { id: "endpoint", baseUrl: "https://models.example.test/v1", model: "model", protocol: "openai_chat_completions" }
      };
    },
    async streamChat(endpoint, _messages, options) {
      const response = await this.completeChat(endpoint, [], options);
      options.onDelta(response.message.content);
      return response;
    }
  };
}
