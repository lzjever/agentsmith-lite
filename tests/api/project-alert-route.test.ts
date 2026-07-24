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
      const alert = await store.upsertActiveProjectAlert({ id: "alert_event", projectId: project.id, type: "sandbox_failure", status: "active", deliveryStatus: "delivered", createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });
      const acknowledged = await json(api.baseUrl, "POST", `/api/v1/projects/${project.id}/alerts/${alert.id}/acknowledge`, {}, ownerCookie, ownerCsrf);
      assert.ok(acknowledged.acknowledgedAt);
      const silencedUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const silenced = await json(api.baseUrl, "POST", `/api/v1/projects/${project.id}/alerts/${alert.id}/silence`, { silencedUntil }, ownerCookie, ownerCsrf);
      assert.equal(silenced.silencedUntil, silencedUntil);
      const missingRuleKey = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alert-rules`, { method: "POST", headers: { "content-type": "application/json", cookie: ownerCookie, "x-csrf-token": ownerCsrf }, body: JSON.stringify({ alertType: "sandbox_failure" }) });
      assert.equal(missingRuleKey.status, 400);
      assert.deepEqual(await missingRuleKey.json(), { error: "Idempotency-Key header is required" });
      const removedRuleField = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alert-rules`, { method: "POST", headers: { "content-type": "application/json", cookie: ownerCookie, "x-csrf-token": ownerCsrf, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ alertType: "sandbox_failure", channels: ["email"] }) });
      assert.equal(removedRuleField.status, 400);
      const rule = await json(api.baseUrl, "POST", `/api/v1/projects/${project.id}/alert-rules`, { alertType: "sandbox_failure" }, ownerCookie, ownerCsrf);
      const linkedRule = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alert-rules/${rule.id}`, { headers: { cookie: ownerCookie } });
      assert.equal(linkedRule.status, 200);
      assert.equal((await linkedRule.json() as { id: string }).id, rule.id);
      const testedRule = await json(api.baseUrl, "POST", `/api/v1/projects/${project.id}/alert-rules/${rule.id}/test`, {}, ownerCookie, ownerCsrf);
      assert.equal(testedRule.metric, rule.metric);
      const removedTestBody = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alert-rules/${rule.id}/test`, { method: "POST", headers: { "content-type": "application/json", cookie: ownerCookie, "x-csrf-token": ownerCsrf }, body: JSON.stringify({ notify: true }) });
      assert.equal(removedTestBody.status, 400);
      const removedRuleUpdate = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alert-rules/${rule.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: ownerCookie, "x-csrf-token": ownerCsrf, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ expectedUpdatedAt: rule.updatedAt, deliveryChannels: [] }) });
      assert.equal(removedRuleUpdate.status, 400);
      const updatedRule = await json(api.baseUrl, "PATCH", `/api/v1/projects/${project.id}/alert-rules/${rule.id}`, { name: "Updated sandbox failure", expectedUpdatedAt: rule.updatedAt }, ownerCookie, ownerCsrf);
      assert.equal(updatedRule.name, "Updated sandbox failure");
      const removedRuleDelete = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alert-rules/${rule.id}`, { method: "DELETE", headers: { "content-type": "application/json", cookie: ownerCookie, "x-csrf-token": ownerCsrf, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ force: true }) });
      assert.equal(removedRuleDelete.status, 400);
      const removedAckBody = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts/${alert.id}/acknowledge`, { method: "POST", headers: { "content-type": "application/json", cookie: ownerCookie, "x-csrf-token": ownerCsrf, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ note: "legacy" }) });
      assert.equal(removedAckBody.status, 400);
      const removedSilenceField = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts/${alert.id}/silence`, { method: "POST", headers: { "content-type": "application/json", cookie: ownerCookie, "x-csrf-token": ownerCsrf, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ silencedUntil, channel: "email" }) });
      assert.equal(removedSilenceField.status, 400);
      assert.equal((await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts?channel=email`, { headers: { cookie: ownerCookie } })).status, 400);
      assert.equal((await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/audit?includePayload=true`, { headers: { cookie: ownerCookie } })).status, 400);

      const denied = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts`, { headers: { cookie: `asl_session=${viewerSession}` } });
      assert.equal(denied.status, 403);
      await json(api.baseUrl, "POST", `/api/v1/workspaces/${workspace.id}/members`, { email: "alert-viewer@example.test", role: "viewer" }, ownerCookie, ownerCsrf);
      await json(api.baseUrl, "POST", `/api/v1/projects/${project.id}/members`, { userId: "alert_viewer", role: "viewer" }, ownerCookie, ownerCsrf);
      const visible = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts`, { headers: { cookie: `asl_session=${viewerSession}` } });
      assert.equal(visible.status, 200);
      const visiblePage = await visible.json() as { items: Array<{ id: string; deliveryStatus: string }>; nextCursor: string | null; activeCount: number };
      assert.deepEqual(visiblePage.items.map((item) => [item.id, item.deliveryStatus]), [[alert.id, "delivered"]]);
      assert.equal(visiblePage.nextCursor, null);
      assert.equal(visiblePage.activeCount, 1);
      const linked = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts/${alert.id}`, { headers: { cookie: `asl_session=${viewerSession}` } });
      assert.equal(linked.status, 200);
      assert.equal((await linked.json() as { id: string }).id, alert.id);
      const viewerTransition = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts/${alert.id}`, { method: "PATCH", headers: { cookie: `asl_session=${viewerSession}`, "x-csrf-token": "alert-viewer-csrf", "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ status: "resolved" }) });
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
      const history = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/alerts?view=history`, { headers: { cookie: ownerCookie } });
      assert.deepEqual(new Set((await history.json() as { items: Array<{ status: string }> }).items.map((item) => item.status)), new Set(["resolved", "dismissed"]));
      assert.deepEqual(await json(api.baseUrl, "DELETE", `/api/v1/projects/${project.id}/alert-rules/${rule.id}`, {}, ownerCookie, ownerCsrf), { deleted: true });
    } finally { await api.close(); await rm(dataRoot, { recursive: true, force: true }); }
  });

  it("partitions active and history views with fixed limits and project-bound keyset cursors", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-project-alert-pages-"));
    const store = createLocalInMemoryProductStore();
    const api = await createApiServer({ port: 0, dataRoot, builtinAdminPassword: "admin-password", store });
    try {
      await post(api.baseUrl, "/api/v1/auth/bootstrap", { password: "admin-password" });
      const login = await post(api.baseUrl, "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const csrf = (await login.json() as { csrfToken: string }).csrfToken;
      const workspace = await json(api.baseUrl, "POST", "/api/v1/workspaces", { name: "Alert pages" }, cookie, csrf);
      const project = await json(api.baseUrl, "POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Primary" }, cookie, csrf);
      const otherProject = await json(api.baseUrl, "POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Other" }, cookie, csrf);
      const tiedAt = "2026-07-20T12:00:00.000Z";
      const activeIds = Array.from({ length: 23 }, (_, index) => `alert_active_${String(index).padStart(2, "0")}`);
      for (const id of activeIds) {
        const ruleId = `rule_${id}`;
        const rule = await store.createProjectAlertRule({
          id: ruleId,
          projectId: project.id,
          name: id,
          alertType: "sandbox_failure",
          metric: "failure_count",
          condition: "greater_than_or_equal",
          threshold: 1,
          windowSeconds: 3600,
          scope: { kind: "project" },
          enabled: false,
          createdAt: tiedAt,
          updatedAt: tiedAt,
        });
        if (!rule) throw new Error("Canonical alert pagination fixture exceeded the rule cap");
        await store.upsertActiveProjectAlert({ id, projectId: project.id, type: "sandbox_failure", status: "active", deliveryStatus: "delivered", ruleId: rule.id, createdAt: tiedAt, updatedAt: tiedAt, resolvedAt: null, dismissedAt: null });
      }
      for (const [id, status] of [["alert_resolved", "resolved"], ["alert_dismissed", "dismissed"]] as const) {
        const alert = await store.upsertActiveProjectAlert({ id, projectId: project.id, type: "sandbox_failure", status: "active", deliveryStatus: "delivered", createdAt: tiedAt, updatedAt: tiedAt, resolvedAt: null, dismissedAt: null });
        if (!await store.transitionProjectAlert(project.id, alert.id, status, tiedAt)) throw new Error("Canonical alert pagination fixture could not transition its active alert");
      }

      const defaultPage = await alertPage(api.baseUrl, project.id, "", cookie);
      assert.equal(defaultPage.view, "active");
      assert.equal(defaultPage.items.length, 20);
      assert.equal(defaultPage.activeCount, activeIds.length);
      assert.ok(defaultPage.items.every((item) => item.status === "active"));
      assert.ok(defaultPage.nextCursor);

      const explicitActive = await alertPage(api.baseUrl, project.id, "?view=active&limit=50", cookie);
      assert.equal(explicitActive.items.length, activeIds.length);
      assert.equal(explicitActive.activeCount, activeIds.length);
      assert.equal(explicitActive.nextCursor, null);

      const history = await alertPage(api.baseUrl, project.id, "?view=history", cookie);
      assert.equal(history.view, "history");
      assert.deepEqual(new Set(history.items.map((item) => item.status)), new Set(["resolved", "dismissed"]));
      assert.equal(history.activeCount, activeIds.length);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await alertPage(api.baseUrl, project.id, `?view=active&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, cookie);
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(new Set(seen).size, activeIds.length);
      assert.deepEqual(new Set(seen), new Set(activeIds));

      const activeCursor = defaultPage.nextCursor!;
      for (const pathname of [
        `/api/v1/projects/${project.id}/alerts?status=active`,
        `/api/v1/projects/${project.id}/alerts?view=all`,
        `/api/v1/projects/${project.id}/alerts?view=invalid`,
        `/api/v1/projects/${project.id}/alerts?limit=51`,
        `/api/v1/projects/${project.id}/alerts?view=active&cursor=${encodeURIComponent(`${tiedAt}|alert_active_00`)}`,
        `/api/v1/projects/${project.id}/alerts?view=history&cursor=${encodeURIComponent(activeCursor)}`,
        `/api/v1/projects/${otherProject.id}/alerts?view=active&cursor=${encodeURIComponent(activeCursor)}`,
      ]) {
        assert.equal((await fetch(api.baseUrl + pathname, { headers: { cookie } })).status, 400, pathname);
      }
    } finally { await api.close(); await rm(dataRoot, { recursive: true, force: true }); }
  });
});

async function post(baseUrl: string, pathname: string, body: unknown) { return fetch(baseUrl + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function json(baseUrl: string, method: string, pathname: string, body: unknown, cookie: string, csrf: string): Promise<any> { const response = await fetch(baseUrl + pathname, { method, headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf, ...(needsIdempotencyKey(method,pathname) ? { "idempotency-key": crypto.randomUUID() } : {}) }, body: JSON.stringify(body) }); if (response.status !== 200) assert.fail(await response.text()); return response.json(); }
async function alertPage(baseUrl:string,projectId:string,query:string,cookie:string):Promise<{view:"active"|"history";items:Array<{id:string;status:string}>;nextCursor:string|null;activeCount:number}>{const response=await fetch(`${baseUrl}/api/v1/projects/${projectId}/alerts${query}`,{headers:{cookie}});if(response.status!==200)assert.fail(await response.text());return response.json()}
function needsIdempotencyKey(method:string,pathname:string):boolean{return method==="POST"&&(pathname==="/api/v1/workspaces"||/^\/api\/v1\/workspaces\/[^/]+\/(projects|members)$/.test(pathname)||/^\/api\/v1\/projects\/[^/]+\/(credentials|endpoints|members|alert-rules)$/.test(pathname)||/^\/api\/v1\/projects\/[^/]+\/alerts\/[^/]+\/(acknowledge|silence)$/.test(pathname))||(method==="PATCH"&&(/^\/api\/v1\/projects\/[^/]+\/(policy|alerts\/[^/]+|alert-rules\/[^/]+)$/.test(pathname)))||(method==="DELETE"&&/^\/api\/v1\/projects\/[^/]+\/alert-rules\/[^/]+$/.test(pathname));}
