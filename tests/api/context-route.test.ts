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

  it("persists, lists, validates, and deletes context through the public API", async () => {
    const input = { workspaceId, projectId, scope: "project_shared", contextKey: "project.format", content: "{\"tone\":\"brief\"}", contentType: "json" };
    const saved = await requestJson("PUT", "/api/v1/context", input);
    assert.equal(saved.contextKey, input.contextKey);
    const listed = await requestJson("GET", `/api/v1/context?workspaceId=${workspaceId}&projectId=${projectId}&scope=project_shared`);
    assert.equal(listed.canWrite, true);
    assert.equal(listed.items[0]?.contentType, "json");
    const renamed = await requestJson("PUT", "/api/v1/context", { ...input, previousContextKey: input.contextKey, expectedVersion: saved.version, contextKey: "project.renamed" });
    assert.equal(renamed.contextKey, "project.renamed");
    const stale = await request("PUT", "/api/v1/context", { ...input, previousContextKey: "project.renamed", expectedVersion: saved.version, contextKey: "project.renamed" });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.code, "context_version_conflict");
    const duplicate = await request("PUT", "/api/v1/context", { ...input, contextKey: "project.renamed" });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.code, "context_key_conflict");
    const malformed = await request("PUT", "/api/v1/context", { ...input, contextKey: "bad", content: "{" });
    assert.equal(malformed.response.status, 400);
    const updated = await requestJson("PUT", "/api/v1/context", { ...input, previousContextKey: "project.renamed", expectedVersion: renamed.version, contextKey: "project.renamed", content: "{\"tone\":\"detailed\"}" });
    const staleDelete = await request("DELETE", "/api/v1/context", { workspaceId, projectId, scope: "project_shared", contextKey: "project.renamed", expectedVersion: renamed.version });
    assert.equal(staleDelete.response.status, 409);
    assert.equal(staleDelete.body.code, "context_version_conflict");
    const deleted = await requestJson("DELETE", "/api/v1/context", { workspaceId, projectId, scope: "project_shared", contextKey: "project.renamed", expectedVersion: updated.version });
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
