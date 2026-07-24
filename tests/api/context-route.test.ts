import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createTestApiServer as createApiServer, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";

describe("context API", () => {
  let api: RunningApiServer;
  let root = "";
  let cookie = "";
  let csrf = "";
  let workspaceId = "";
  let projectId = "";

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "asl-context-api-"));
    api = await createApiServer({ port: 0, dataRoot: root, builtinAdminPassword: "admin-password" });
    await request("POST", "/api/v1/auth/bootstrap", { password: "admin-password" }, "", "");
    const login = await request("POST", "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" }, "", "");
    cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
    csrf = (login.body as { csrfToken: string }).csrfToken;
    workspaceId = (await requestJson("POST", "/api/v1/workspaces", { name: "Workspace" })).id;
    projectId = (await requestJson("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Project" })).id;
  });
  after(async () => { await api.close(); await rm(root, { recursive: true, force: true }); });

  it("pages metadata and exposes content only through exact authorized detail", async () => {
    const largeContent = "x".repeat(30 * 1024);
    const input = { workspaceId, projectId, scope: "project_shared", contextKey: "project.00", content: largeContent, contentType: "text" };
    const saved = await requestJson("PUT", "/api/v1/context", input);
    assert.equal(saved.contextKey, input.contextKey);
    for (let index = 1; index < 26; index += 1) {
      await requestJson("PUT", "/api/v1/context", { ...input, contextKey: `project.${String(index).padStart(2, "0")}`, content: `content ${index}` });
    }
    const listed = await requestJson("GET", `/api/v1/context?workspaceId=${workspaceId}&projectId=${projectId}&scope=project_shared`);
    assert.equal(listed.canWrite, true);
    assert.equal(listed.items.length, 25);
    assert.ok(listed.nextCursor);
    assert.equal(listed.items[0]?.contentType, "text");
    assert.equal("content" in listed.items[0], false);
    assert.equal(JSON.stringify(listed).includes(largeContent), false);
    const detail = await requestJson("GET", `/api/v1/context/${saved.id}?workspaceId=${workspaceId}&projectId=${projectId}&scope=project_shared`);
    assert.equal(detail.content, largeContent);
    const second = await requestJson("GET", `/api/v1/context?workspaceId=${workspaceId}&projectId=${projectId}&scope=project_shared&cursor=${encodeURIComponent(listed.nextCursor)}`);
    assert.deepEqual(second.items.map((entry: { contextKey: string }) => entry.contextKey), ["project.25"]);
    assert.equal(second.nextCursor, null);
    const wrongScope = await request("GET", `/api/v1/context/${saved.id}?workspaceId=${workspaceId}&scope=workspace_shared`);
    assert.equal(wrongScope.response.status, 404);
  });

  it("preserves context CRUD validation and optimistic conflicts", async () => {
    const input = { workspaceId, projectId, scope: "project_shared", contextKey: "crud.format", content: "{\"tone\":\"brief\"}", contentType: "json" };
    const saved = await requestJson("PUT", "/api/v1/context", input);
    const renamed = await requestJson("PUT", "/api/v1/context", { ...input, previousContextKey: input.contextKey, expectedVersion: saved.version, contextKey: "crud.renamed" });
    assert.equal(renamed.contextKey, "crud.renamed");
    const stale = await request("PUT", "/api/v1/context", { ...input, previousContextKey: "crud.renamed", expectedVersion: saved.version, contextKey: "crud.renamed" });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.code, "context_version_conflict");
    const duplicate = await request("PUT", "/api/v1/context", { ...input, contextKey: "crud.renamed" });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.code, "context_key_conflict");
    const malformed = await request("PUT", "/api/v1/context", { ...input, contextKey: "bad", content: "{" });
    assert.equal(malformed.response.status, 400);
    const updated = await requestJson("PUT", "/api/v1/context", { ...input, previousContextKey: "crud.renamed", expectedVersion: renamed.version, contextKey: "crud.renamed", content: "{\"tone\":\"detailed\"}" });
    const staleDelete = await request("DELETE", "/api/v1/context", { workspaceId, projectId, scope: "project_shared", contextKey: "crud.renamed", expectedVersion: renamed.version });
    assert.equal(staleDelete.response.status, 409);
    assert.equal(staleDelete.body.code, "context_version_conflict");
    const deleted = await requestJson("DELETE", "/api/v1/context", { workspaceId, projectId, scope: "project_shared", contextKey: "crud.renamed", expectedVersion: updated.version });
    assert.deepEqual(deleted, { deleted: true });
  });

  it("rejects removed context query and body fields", async () => {
    const list = await request("GET", `/api/v1/context?workspaceId=${workspaceId}&projectId=${projectId}&scope=project_shared&key=legacy`);
    assert.equal(list.response.status, 400);
    const save = await request("PUT", "/api/v1/context", { workspaceId, projectId, scope: "project_shared", contextKey: "project.strict", content: "brief", contentType: "text", taskId: "legacy" });
    assert.equal(save.response.status, 400);
    const remove = await request("DELETE", "/api/v1/context", { workspaceId, projectId, scope: "project_shared", contextKey: "missing", expectedVersion: 1, force: true });
    assert.equal(remove.response.status, 400);
  });

  async function requestJson(method: string, pathname: string, body?: unknown): Promise<any> { const result = await request(method, pathname, body); assert.equal(result.response.status, 200, JSON.stringify(result.body)); return result.body; }
  async function request(method: string, pathname: string, body?: unknown, session = cookie, token = csrf): Promise<{ response: Response; body: any }> {
    const response = await fetch(api.baseUrl + pathname, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(session ? { cookie: session } : {}), ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) && token ? { "x-csrf-token": token } : {}), ...((method === "POST" && (pathname === "/api/v1/workspaces" || /^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(pathname) || /^\/api\/v1\/projects\/[^/]+\/(credentials|endpoints)$/.test(pathname))) || (["PUT", "DELETE"].includes(method) && pathname === "/api/v1/context") ? { "idempotency-key": crypto.randomUUID() } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() };
  }
});
