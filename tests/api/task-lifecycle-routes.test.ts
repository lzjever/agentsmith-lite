import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApiServer, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";

describe("task lifecycle API routes", () => {
  const store = createLocalInMemoryProductStore();
  let api: RunningApiServer;
  let dataRoot = "";
  let cookie = "";
  let csrf = "";
  let projectId = "";
  let endpointId = "";

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-routes-"));
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      store,
      providerClient: {
        completeChat: async () => { throw new Error("not used"); },
        validateEndpoint: async () => ({ status: "healthy" })
      }
    });
    await fetch(api.baseUrl + "/api/v1/auth/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "admin-password" }) });
    const login = await fetch(api.baseUrl + "/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@agentsmith-lite.local", password: "admin-password" }) });
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    csrf = (await login.json() as { csrfToken: string }).csrfToken;
    const workspace = await json("POST", "/api/v1/workspaces", { name: "Workspace" });
    const project = await json("POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Project" }); projectId = project.id;
    const credential = await json("POST", `/api/v1/projects/${projectId}/credentials`, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "sk-test" });
    const endpoint = await json("POST", `/api/v1/projects/${projectId}/endpoints`, { name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId: credential.id, capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30 }); endpointId = endpoint.id;
  });

  after(async () => { await api.close(); await rm(dataRoot, { recursive: true, force: true }); });

  it("requires Idempotency-Key and replays the original create response", async () => {
    const missing = await request("POST", `/api/v1/projects/${projectId}/tasks`, { prompt: "first", endpointId });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "Idempotency-Key header is required" });

    const first = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "first", title: "First" }, "create-1");
    const replay = await json("POST", `/api/v1/projects/${projectId}/tasks`, { title: "First", prompt: "first", endpointId }, "create-1");
    assert.equal(replay.id, first.id);
    assert.equal(first.terminalReason, "not_executed");
    const mismatch = await request("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "changed", title: "First" }, "create-1");
    assert.equal(mismatch.status, 409);

    for (const [method, pathname, body] of [
      ["POST", `/api/v1/tasks/${first.id}/retry`, {}],
      ["POST", `/api/v1/tasks/${first.id}/duplicate`, {}],
      ["POST", `/api/v1/tasks/${first.id}/follow-ups`, { prompt: "continue" }],
      ["POST", `/api/v1/tasks/${first.id}/cancel`, {}],
      ["POST", `/api/v1/tasks/${first.id}/archive`, {}],
      ["DELETE", `/api/v1/tasks/${first.id}`, undefined]
    ] as const) {
      const response = await request(method, pathname, body);
      assert.equal(response.status, 400, `${method} ${pathname}`);
      assert.deepEqual(await response.json(), { error: "Idempotency-Key header is required" });
    }
  });

  it("searches, filters, sorts, paginates, edits, archives, retries, duplicates, and deletes", async () => {
    const alpha = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "alpha body", title: "Alpha" }, "create-alpha");
    const beta = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "beta body", title: "Beta" }, "create-beta");
    const edited = await json("PATCH", `/api/v1/tasks/${alpha.id}`, { title: "Alpha edited" }, "edit-alpha");
    assert.equal(edited.title, "Alpha edited");
    const alphaSecond = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "alpha second body", title: "Alpha second" }, "create-alpha-second");
    const archived = await json("POST", `/api/v1/tasks/${beta.id}/archive`, {}, "archive-beta");
    assert.ok(archived.archivedAt);

    const page = await json("GET", `/api/v1/projects/${projectId}/tasks?search=alpha&status=completed&sort=title&direction=asc&limit=1`);
    assert.deepEqual(page.items.map((task: { id: string }) => task.id), [alpha.id]);
    assert.equal(page.total, 2);
    assert.ok(page.nextCursor);
    const nextPage = await json("GET", `/api/v1/projects/${projectId}/tasks?search=alpha&status=completed&sort=title&direction=asc&limit=1&cursor=${page.nextCursor}`);
    assert.deepEqual(nextPage.items.map((task: { id: string }) => task.id), [alphaSecond.id]);
    assert.equal(nextPage.nextCursor, null);
    assert.equal((await request("GET", `/api/v1/projects/${projectId}/tasks?cursor=!`)).status, 400);
    const archivedPage = await json("GET", `/api/v1/projects/${projectId}/tasks?archived=only`);
    assert.deepEqual(archivedPage.items.map((task: { id: string }) => task.id), [beta.id]);

    const retry = await json("POST", `/api/v1/tasks/${alpha.id}/retry`, {}, "retry-alpha");
    const duplicate = await json("POST", `/api/v1/tasks/${alpha.id}/duplicate`, {}, "duplicate-alpha");
    assert.notEqual(retry.id, alpha.id); assert.notEqual(duplicate.id, alpha.id); assert.notEqual(retry.id, duplicate.id);
    const deleted = await json("DELETE", `/api/v1/tasks/${beta.id}`, undefined, "delete-beta");
    assert.deepEqual(deleted, { deleted: true, taskId: beta.id });
    assert.deepEqual(await json("DELETE", `/api/v1/tasks/${beta.id}`, undefined, "delete-beta"), deleted);
    assert.deepEqual(await json("POST", `/api/v1/tasks/${beta.id}/archive`, {}, "archive-beta"), archived);
    assert.equal((await request("GET", `/api/v1/tasks/${beta.id}`)).status, 404);
  });

  it("creates a linked terminal follow-up and serves authorized transcript tail and SSE", async () => {
    const source = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "source", title: "Source" }, "create-source");
    const followUp = await json("POST", `/api/v1/tasks/${source.id}/follow-ups`, { prompt: "continue" }, "follow-source");
    assert.equal(followUp.deliveryStatus, "successor_created");
    assert.ok(followUp.followUpTaskId);
    assert.equal((await json("GET", `/api/v1/tasks/${followUp.followUpTaskId}`)).sourceTaskId, source.id);

    await store.appendTaskEvents([
      { id: "route-event-1", taskId: source.id, kind: "user_input", cursor: "route-cursor-1", botifiedSeq: 1, botifiedType: "user.message", sessionId: "s1", payload: { text: "hello" }, createdAt: source.createdAt },
      { id: "route-event-2", taskId: source.id, kind: "assistant_message", cursor: "route-cursor-2", botifiedSeq: 2, botifiedType: "assistant.message", sessionId: "s1", payload: { text: "world" }, createdAt: source.createdAt }
    ]);
    const transcript = await json("GET", `/api/v1/tasks/${source.id}/transcript?limit=10`);
    assert.deepEqual(transcript.items.map((item: { role: string; text: string }) => [item.role, item.text]), [["user", "hello"], ["assistant", "world"]]);
    assert.equal(transcript.nextCursor, "route-cursor-2");
    assert.deepEqual(await json("GET", `/api/v1/tasks/${source.id}/transcript?cursor=${transcript.nextCursor}&limit=10`), { items: [], nextCursor: "route-cursor-2" });
    const stream = await request("GET", `/api/v1/tasks/${source.id}/transcript/stream?limit=10`);
    assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await stream.text(); assert.match(body, /event: transcript/); assert.match(body, /event: cursor/);
    assert.equal((await fetch(api.baseUrl + `/api/v1/tasks/${source.id}/transcript`)).status, 401);
    await json("DELETE", `/api/v1/tasks/${source.id}`, undefined, "delete-source");
    assert.deepEqual(await json("POST", `/api/v1/tasks/${source.id}/follow-ups`, { prompt: "continue" }, "follow-source"), followUp);
  });

  async function request(method: string, pathname: string, body?: unknown, idempotencyKey?: string): Promise<Response> {
    const headers: Record<string, string> = { cookie, "content-type": "application/json" };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) headers["x-csrf-token"] = csrf;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    return fetch(api.baseUrl + pathname, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  async function json(method: string, pathname: string, body?: unknown, idempotencyKey?: string): Promise<any> {
    const response = await request(method, pathname, body, idempotencyKey);
    if (response.status !== 200) assert.fail(`${response.status}: ${await response.text()}`);
    return response.json();
  }
});
