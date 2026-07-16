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
      await store.createUserNotification({ id: "notice_route", userId: identity.user.id, type: "project_alert", title: "Project alert: active tasks limit", body: "Alert project: active tasks limit.", projectId: "proj", resourceKind: "project", resourceId: "proj", linkPath: "/workspaces/ws/projects/proj/alerts", readAt: null, createdAt: "2026-07-12T00:00:00.000Z" }, "project-alert:alert_route:" + identity.user.id);

      const listed = await fetch(api.baseUrl + "/api/v1/notifications", { headers: { cookie } });
      assert.equal(listed.status, 200);
      const item = (await listed.json() as Array<{ id: string; body: string; projectId: string; resourceKind: string; resourceId: string }>)[0]!;
      assert.deepEqual([item.id, item.body, item.projectId, item.resourceKind, item.resourceId], ["notice_route", "Alert project: active tasks limit.", "proj", "project", "proj"]);
      const read = await fetch(api.baseUrl + "/api/v1/notifications/notice_route/read", { method: "PATCH", headers: { cookie, "x-csrf-token": identity.csrfToken } });
      assert.equal(read.status, 200);
      assert.ok((await read.json() as { readAt: string | null }).readAt);
      const dismissed = await fetch(api.baseUrl + "/api/v1/notifications/notice_route", { method: "DELETE", headers: { cookie, "x-csrf-token": identity.csrfToken } });
      assert.equal(dismissed.status, 200);
      assert.deepEqual(await dismissed.json(), { dismissed: true });
    } finally {
      await api.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

async function post(baseUrl: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(baseUrl + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
