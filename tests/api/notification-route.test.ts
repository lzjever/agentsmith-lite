import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer } from "../../packages/api-entry-node/src/server.js";

describe("notification API", () => {
  it("lists, reads, and dismisses only the signed-in user's alert notification", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-notification-route-"));
    const store = createInMemoryProductStore();
    const api = await createApiServer({ port: 0, dataRoot, builtinAdminPassword: "admin-password", store });
    try {
      await post(api.baseUrl, "/api/v1/auth/bootstrap", { password: "admin-password" });
      const login = await post(api.baseUrl, "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const identity = await login.json() as { user: { id: string }; csrfToken: string };
      const workspace = (await authenticatedPost<{workspace:{id:string}}>(api.baseUrl, "/api/v1/workspaces", { name: "Notifications" }, cookie, identity.csrfToken)).workspace;
      const project = await authenticatedPost<{id:string}>(api.baseUrl, `/api/v1/workspaces/${workspace.id}/projects`, { name: "Notification project" }, cookie, identity.csrfToken);
      await store.createUserNotification({ id: "notice_route", userId: identity.user.id, type: "project_alert", title: "Project alert: active tasks limit", body: "Alert project: active tasks limit.", projectId: project.id, resourceKind: "project", resourceId: project.id, linkPath: `/workspaces/${workspace.id}/projects/${project.id}/alerts`, readAt: null, createdAt: "2026-07-12T00:00:00.000Z" }, "project-alert:alert_route:" + identity.user.id);
      await store.createUserNotification({ id: "notice_newer", userId: identity.user.id, type: "task", title: "Task finished", body: "A newer event.", projectId: project.id, resourceKind: "task", resourceId: "task", linkPath: `/workspaces/${workspace.id}/projects/${project.id}/tasks/task`, readAt: null, createdAt: "2026-07-13T00:00:00.000Z" });

      assert.equal((await fetch(api.baseUrl + "/api/v1/notifications?includeDismissed=true", { headers: { cookie } })).status, 400);
      const listed = await fetch(api.baseUrl + "/api/v1/notifications", { headers: { cookie } });
      assert.equal(listed.status, 200);
      const items = await listed.json() as Array<{ id: string; body: string; projectId: string; resourceKind: string; resourceId: string }>;
      assert.deepEqual(items.map((value) => value.id), ["notice_newer", "notice_route"]);
      const item = items[1]!;
      assert.deepEqual([item.id, item.body, item.projectId, item.resourceKind, item.resourceId], ["notice_route", "Alert project: active tasks limit.", project.id, "project", project.id]);
      assert.equal((await fetch(api.baseUrl + "/api/v1/notifications/notice_route/read/legacy", { method: "PATCH", headers: { cookie, "x-csrf-token": identity.csrfToken } })).status, 404);
      assert.equal((await fetch(api.baseUrl + "/api/v1/notifications/notice_route/read", { method: "PATCH", headers: { "content-type": "application/json", cookie, "x-csrf-token": identity.csrfToken }, body: JSON.stringify({ evidence: true }) })).status, 400);
      const read = await fetch(api.baseUrl + "/api/v1/notifications/notice_route/read", { method: "PATCH", headers: { cookie, "x-csrf-token": identity.csrfToken } });
      assert.equal(read.status, 200);
      assert.ok((await read.json() as { readAt: string | null }).readAt);
      const allRead = await fetch(api.baseUrl + "/api/v1/notifications/read", { method: "PATCH", headers: { cookie, "x-csrf-token": identity.csrfToken } });
      assert.equal(allRead.status, 200);
      assert.equal((await allRead.json() as Array<{ readAt: string | null }>).every((value) => value.readAt !== null), true);
      const unread = await fetch(api.baseUrl + "/api/v1/notifications?unread=true", { headers: { cookie } });
      assert.deepEqual(await unread.json(), []);
      const dismissed = await fetch(api.baseUrl + "/api/v1/notifications/notice_route", { method: "DELETE", headers: { cookie, "x-csrf-token": identity.csrfToken } });
      assert.equal(dismissed.status, 200);
      assert.deepEqual(await dismissed.json(), { dismissed: true });
      const retried = await fetch(api.baseUrl + "/api/v1/notifications/notice_route", { method: "DELETE", headers: { cookie, "x-csrf-token": identity.csrfToken } });
      assert.equal(retried.status, 200);
      assert.deepEqual(await retried.json(), { dismissed: true });
    } finally {
      await api.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

async function post(baseUrl: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(baseUrl + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function authenticatedPost<T>(baseUrl: string, pathname: string, body: unknown, cookie: string, csrf: string): Promise<T> {
  const response = await fetch(baseUrl + pathname, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf, "idempotency-key": `notification-route-${pathname.replaceAll("/", "-")}` }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  return response.json() as Promise<T>;
}
