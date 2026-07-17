import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createTestApiServer as createApiServer } from "../../packages/api-entry-node/src/server.js";

describe("PATCH project policy", () => {
  it("accepts nullable limits and preserves limits omitted from the patch", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-policy-route-"));
    const api = await createApiServer({ port: 0, dataRoot, builtinAdminPassword: "admin-password" });
    try {
      await post(api.baseUrl, "/api/v1/auth/bootstrap", { password: "admin-password" });
      const login = await post(api.baseUrl, "/api/v1/auth/login", {
        email: "admin@agentsmith-lite.local",
        password: "admin-password"
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const csrf = (await login.json() as { csrfToken: string }).csrfToken;
      const workspace = await requestJson(api.baseUrl, "POST", "/api/v1/workspaces", { name: "Policy" }, cookie, csrf);
      const project = await requestJson(api.baseUrl, "POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Patch" }, cookie, csrf);
      await requestJson(api.baseUrl, "PATCH", "/api/v1/me/profile", { displayName: "Policy Owner" }, cookie, csrf);

      const policy = await requestJson(api.baseUrl, "PATCH", `/api/v1/projects/${project.id}/policy`, {
        providerRequestsLimit: null,
        providerCostLimit: 3.5
      }, cookie, csrf);

      assert.equal(policy.activeTasksLimit, 2);
      assert.equal(policy.providerRequestsLimit, null);
      assert.equal(policy.providerCostLimit, 3.5);
      assert.equal(policy.providerTokensLimit, null);
      const invalidActiveLimit = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/policy`, { method: "PATCH", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf }, body: JSON.stringify({ activeTasksLimit: null }) });
      assert.equal(invalidActiveLimit.status, 400);
      const auditResponse = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/audit`, { headers: { cookie } });
      assert.equal(auditResponse.status, 200);
      const audit = await auditResponse.json() as {items:Array<{ actorDisplayName: string | null; actorEmail: string | null; actorId: string | null }>};
      assert.deepEqual([audit.items[0]?.actorDisplayName, audit.items[0]?.actorEmail], ["Policy Owner", "admin@agentsmith-lite.local"]);
      const missingResourceAudit = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/audit?resourceId=missing`, { headers: { cookie } });
      assert.equal(missingResourceAudit.status, 200);
      assert.deepEqual((await missingResourceAudit.json() as { items: unknown[] }).items, []);
    } finally {
      await api.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

async function post(baseUrl: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(baseUrl + pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function requestJson(baseUrl: string, method: string, pathname: string, body: unknown, cookie: string, csrf: string): Promise<any> {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf, ...(method === "POST" && (pathname === "/api/v1/workspaces" || /^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(pathname)) ? { "idempotency-key": crypto.randomUUID() } : {}) },
    body: JSON.stringify(body)
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  return response.json();
}
