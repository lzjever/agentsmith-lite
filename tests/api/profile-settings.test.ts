import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";

describe("profile and settings API", () => {
  const store = createLocalInMemoryProductStore();
  let api: RunningApiServer; let root = ""; let cookie = ""; let csrf = ""; let workspaceId = ""; let projectId = "";
  before(async () => { root = await mkdtemp(path.join(tmpdir(), "asl-profile-settings-")); api = await createApiServer({ port: 0, dataRoot: root, builtinAdminPassword: "admin-password", store }); await call("POST", "/api/v1/auth/bootstrap", { password: "admin-password" }); const login = await call("POST", "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" }); cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? ""; csrf = login.body.csrfToken; workspaceId = (await json("POST", "/api/v1/workspaces", { name: "Old workspace" })).id; projectId = (await json("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Old project" })).id; });
  after(async () => { await api.close(); await rm(root, { recursive: true, force: true }); });
  it("projects a public profile and applies idempotent settings and lifecycle mutations", async () => {
    const profile = await json("GET", "/api/v1/me/profile");
    assert.equal(profile.user.email, "admin@agentsmith-lite.local");
    assert.equal("oidcIssuer" in profile.user, false);
    assert.equal("oidcSubject" in profile.user, false);
    const updatedProfile = await json("PATCH", "/api/v1/me/profile", { displayName: "Admin", timezone: "UTC", expectedUpdatedAt: profile.preferences.updatedAt });
    assert.equal(updatedProfile.preferences.displayName, "Admin");
    const staleProfile = await call("PATCH", "/api/v1/me/profile", { displayName: "Stale", expectedUpdatedAt: profile.preferences.updatedAt });
    assert.equal(staleProfile.response.status, 409);
    assert.deepEqual(staleProfile.body, { error: "Profile changed elsewhere. Reload and try again." });
    const identityMutation = await call("PATCH", "/api/v1/me/profile", { email: "other@example.test", expectedUpdatedAt: updatedProfile.preferences.updatedAt });
    assert.equal(identityMutation.response.status, 400);
    const currentIdentity = await json("GET", "/api/v1/me");
    assert.equal(currentIdentity.user.displayName, "Admin");

    const workspace = await json("PATCH", `/api/v1/workspaces/${workspaceId}/settings`, { name: "New workspace" }, "workspace-settings");
    assert.equal(workspace.workspace.name, "New workspace");
    const replayedWorkspace = await json("PATCH", `/api/v1/workspaces/${workspaceId}/settings`, { name: "New workspace" }, "workspace-settings");
    assert.deepEqual(replayedWorkspace, workspace);
    const mismatch = await call("PATCH", `/api/v1/workspaces/${workspaceId}/settings`, { name: "Different workspace" }, "workspace-settings");
    assert.equal(mismatch.response.status, 409);
    assert.deepEqual(mismatch.body, { error: "Idempotency-Key was already used with a different request" });

    const missingKey = await call("POST", `/api/v1/projects/${projectId}/settings/archive`);
    assert.equal(missingKey.response.status, 400);
    assert.deepEqual(missingKey.body, { error: "Idempotency-Key header is required" });
    const archived = await json("POST", `/api/v1/projects/${projectId}/settings/archive`, undefined, "project-archive");
    const replayedArchive = await json("POST", `/api/v1/projects/${projectId}/settings/archive`, undefined, "project-archive");
    assert.deepEqual(replayedArchive, archived);
    const audit = await json("GET", `/api/v1/projects/${projectId}/audit`);
    const archiveEvents = audit.items.filter((event: { action: string }) => event.action === "project.archive");
    assert.deepEqual(archiveEvents.map((event: { status: string; detail?: unknown }) => ({ status: event.status, detail: event.detail })), [{ status: "accepted", detail: {} }]);

    const appendAudit = store.appendProjectAuditEvent.bind(store);
    store.appendProjectAuditEvent = async (event) => {
      if (event.action === "project.delete" && !(await store.findProject(event.projectId))) throw new Error("audit project FK violation");
      await appendAudit(event);
    };
    const deleted = await json("DELETE", `/api/v1/projects/${projectId}`, undefined, "project-delete");
    assert.deepEqual(deleted, { deleted: true });
    assert.equal(await store.findProject(projectId), null);
    assert.deepEqual(await store.listProjectAuditEvents(projectId), []);
    assert.deepEqual(await json("DELETE", `/api/v1/projects/${projectId}`, undefined, "project-delete"), { deleted: true });

    const failingProjectId = (await json("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Deletion failure" })).id;
    const deleteProject = store.deleteProjectDependenciesAndProject.bind(store);
    store.deleteProjectDependenciesAndProject = async (id) => id === failingProjectId ? false : deleteProject(id);
    const failed = await call("DELETE", `/api/v1/projects/${failingProjectId}`, undefined, "project-delete-failure");
    assert.equal(failed.response.status, 409);
    assert.deepEqual(failed.body, { error: "Project deletion is still pending" });
    assert.equal((await store.findProject(failingProjectId))?.lifecycleStatus, "deleting");
  });
  it("rejects oversized JSON bodies before buffering them", async () => {
    const declared = await rawJsonRequest({ "content-length": String(1_048_577) });
    assert.equal(declared.status, 413);

    const streamed = await rawJsonRequest({}, Buffer.alloc(1_048_577, 0x20));
    assert.deepEqual(streamed.body, { error: "JSON request body exceeds the 1 MiB limit" });
    assert.equal(streamed.status, 413);
  });
  async function call(method: string, pathname: string, body?: unknown, idempotencyKey?: string) { const creationKey = method === "POST" && (pathname === "/api/v1/workspaces" || /^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(pathname) || /^\/api\/v1\/projects\/[^/]+\/(credentials|endpoints)$/.test(pathname)) ? crypto.randomUUID() : undefined; const response = await fetch(`${api.baseUrl}${pathname}`, { method, headers: { ...(cookie ? { cookie, "x-csrf-token": csrf } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...(idempotencyKey || creationKey ? { "idempotency-key": idempotencyKey ?? creationKey! } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { response, body: await response.json() as any }; }
  async function json(method: string, pathname: string, body?: unknown, idempotencyKey?: string) { const result = await call(method, pathname, body, idempotencyKey); assert.equal(result.response.status, 200); return result.body; }
  async function rawJsonRequest(headers: Record<string, string>, body?: Buffer): Promise<{ status: number; body: unknown }> {
    const target = new URL("/api/v1/auth/login", api.baseUrl);
    return new Promise((resolve, reject) => {
      const request = httpRequest(target, { method: "POST", agent: false, headers: { "connection": "close", "content-type": "application/json", ...headers } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) as unknown : undefined });
        });
      });
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }
});
