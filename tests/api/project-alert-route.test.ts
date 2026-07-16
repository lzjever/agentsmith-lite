import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer } from "../../packages/api-entry-node/src/server.js";

describe("project alert history API", () => {
  it("shows event history to project members and reserves resolve/dismiss transitions for administrators", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-project-alert-route-"));
    const store = createLocalInMemoryProductStore();
    const viewerSession = "alert-viewer-session";
    await store.createUser({ id: "alert_viewer", email: "alert-viewer@example.test", emailVerified: true, passwordHash: "external:oidc", createdAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-12T00:00:00.000Z" });
    await store.createSession({ id: viewerSession, userId: "alert_viewer", csrfToken: "alert-viewer-csrf", createdAt: "2026-07-12T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" });
    const api = await createApiServer({ port: 0, dataRoot, builtinAdminPassword: "admin-password", store });
    try {
      await post(api.baseUrl, "/api/v1/auth/bootstrap", { password: "admin-password" });
      const login = await post(api.baseUrl, "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" });
      const ownerCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const ownerCsrf = (await login.json() as { csrfToken: string }).csrfToken;
      const workspace = await json(api.baseUrl, "POST", "/api/v1/workspaces", { name: "Alert workspace" }, ownerCookie, ownerCsrf);
      const project = await json(api.baseUrl, "POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Alert project" }, ownerCookie, ownerCsrf);
      const timestamp = "2026-07-12T00:00:00.000Z";
      const alert = await store.upsertActiveProjectAlert({ id: "alert_event", projectId: project.id, type: "task_failure", status: "active", deliveryStatus: "delivered", createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });
      const acknowledged = await json(api.baseUrl, "POST", `/api/v1/projects/${project.id}/alerts/${alert.id}/acknowledge`, {}, ownerCookie, ownerCsrf);
      assert.ok(acknowledged.acknowledgedAt);
      const silencedUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const silenced = await json(api.baseUrl, "POST", `/api/v1/projects/${project.id}/alerts/${alert.id}/silence`, { silencedUntil }, ownerCookie, ownerCsrf);
      assert.equal(silenced.silencedUntil, silencedUntil);
      const rule = await json(api.baseUrl, "POST", `/api/v1/projects/${project.id}/alert-rules`, { alertType: "task_failure" }, ownerCookie, ownerCsrf);
      const testedRule = await json(api.baseUrl, "POST", `/api/v1/projects/${project.id}/alert-rules/${rule.id}/test`, {}, ownerCookie, ownerCsrf);
      assert.equal(testedRule.metric, rule.metric);

      const denied = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts`, { headers: { cookie: `asl_session=${viewerSession}` } });
      assert.equal(denied.status, 403);
      await json(api.baseUrl, "POST", `/api/v1/workspaces/${workspace.id}/members`, { email: "alert-viewer@example.test", role: "viewer" }, ownerCookie, ownerCsrf);
      await json(api.baseUrl, "POST", `/api/v1/projects/${project.id}/members`, { userId: "alert_viewer", role: "viewer" }, ownerCookie, ownerCsrf);
      const visible = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts`, { headers: { cookie: `asl_session=${viewerSession}` } });
      assert.equal(visible.status, 200);
      assert.deepEqual((await visible.json() as Array<{ id: string; deliveryStatus: string }>).map((item) => [item.id, item.deliveryStatus]), [[alert.id, "delivered"]]);
      const viewerTransition = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts/${alert.id}`, { method: "PATCH", headers: { cookie: `asl_session=${viewerSession}`, "x-csrf-token": "alert-viewer-csrf", "content-type": "application/json" }, body: JSON.stringify({ status: "resolved" }) });
      assert.equal(viewerTransition.status, 403, await viewerTransition.text());
      const resolved = await json(api.baseUrl, "PATCH", `/api/v1/projects/${project.id}/alerts/${alert.id}`, { status: "resolved" }, ownerCookie, ownerCsrf);
      assert.equal(resolved.status, "resolved");
      assert.ok(resolved.resolvedAt);
      const dismissable = await store.upsertActiveProjectAlert({ id: "alert_dismiss", projectId: project.id, type: "sandbox_failure", status: "active", deliveryStatus: "delivered", createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });
      const dismissed = await json(api.baseUrl, "PATCH", `/api/v1/projects/${project.id}/alerts/${dismissable.id}`, { status: "dismissed" }, ownerCookie, ownerCsrf);
      assert.equal(dismissed.status, "dismissed");
      const audit = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/audit`, { headers: { cookie: ownerCookie } });
      assert.equal(audit.status, 200);
      const auditPage=await audit.json() as {items:Array<{action:string;status:string;resourceKind:string;resourceId:string}>;nextCursor:string|null};assert.deepEqual(auditPage.items.filter(event=>event.status==="accepted"&&["alert.dismiss","alert.resolve"].includes(event.action)).map(event=>[event.action,event.resourceId]).sort((left,right)=>left[0]!.localeCompare(right[0]!)),[["alert.dismiss",dismissable.id],["alert.resolve",alert.id]]);assert.equal(auditPage.nextCursor,null);
      const history = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts`, { headers: { cookie: ownerCookie } });
      assert.equal((await history.json() as Array<{ status: string }>)[0]?.status, "resolved");
    } finally { await api.close(); await rm(dataRoot, { recursive: true, force: true }); }
  });
});

async function post(baseUrl: string, pathname: string, body: unknown) { return fetch(baseUrl + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function json(baseUrl: string, method: string, pathname: string, body: unknown, cookie: string, csrf: string): Promise<any> { const response = await fetch(baseUrl + pathname, { method, headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf }, body: JSON.stringify(body) }); if (response.status !== 200) assert.fail(await response.text()); return response.json(); }
