import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer } from "../../packages/api-entry-node/src/server.js";

test("usage overview returns project limits and server-filtered settled endpoint trends", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-usage-api-"));
  const store = createLocalInMemoryProductStore();
  const api = await createApiServer({
    port: 0,
    dataRoot,
    builtinAdminPassword: "admin-password",
    store,
    providerClient: {
      async validateEndpoint() { return { status: "healthy" as const }; },
      async completeChat() { throw new Error("not used"); }
    }
  });
  try {
    await post(api.baseUrl, "/api/v1/auth/bootstrap", { password: "admin-password" });
    const login = await post(api.baseUrl, "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { csrfToken, user } = await login.json() as { csrfToken: string; user:{id:string} };
    const workspace = await json(api.baseUrl, "/api/v1/workspaces", { name: "Usage" }, cookie, csrfToken);
    const project = await json(api.baseUrl, `/api/v1/workspaces/${workspace.id}/projects`, { name: "Usage project" }, cookie, csrfToken);
    const library = await json(api.baseUrl, `/api/v1/projects/${project.id}/file-libraries`, { name:"Usage files" }, cookie, csrfToken);
    const credential = await json(api.baseUrl, `/api/v1/projects/${project.id}/credentials`, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "usage-secret" }, cookie, csrfToken);
    const first = await json(api.baseUrl, `/api/v1/projects/${project.id}/endpoints`, endpointInput("Primary", credential.id), cookie, csrfToken);
    const second = await json(api.baseUrl, `/api/v1/projects/${project.id}/endpoints`, endpointInput("Secondary", credential.id), cookie, csrfToken);
    const now = new Date().toISOString();
    await settle(store, "settlement_primary", project.id, first.id, user.id, now, { tokens: 8, cost: 1.25 });
    await settle(store, "settlement_secondary", project.id, second.id, user.id, now, { tokens: 2, cost: 0.25 });
    const filesRoot = path.join(dataRoot, project.rootPath, library.rootSubPath);
    await mkdir(filesRoot, { recursive: true });
    await writeFile(path.join(filesRoot, "unaccounted.txt"), "storage");

    const all = await get(api.baseUrl, `/api/v1/projects/${project.id}/usage`, cookie);
    assert.equal(all.usage.projectFileBytes, 7);
    assert.equal(all.daily.length, 30);
    assert.deepEqual(all.endpoints.map((endpoint: { endpointName: string; requests: number; tokens: number; cost: number }) => [endpoint.endpointName, endpoint.requests, endpoint.tokens, endpoint.cost]), [["Primary", 1, 8, 1.25], ["Secondary", 1, 2, 0.25], ["Other provider activity", 2, 0, 0]]);
    assert.deepEqual(all.limits.find((limit: { metric: string }) => limit.metric === "activeTasks"), { metric: "activeTasks", current: 0, limit: 2, remaining: 2, window: { kind: "current_gauge", resetAt: null } });
    assert.deepEqual(all.limits.find((limit: { metric: string }) => limit.metric === "providerTokens"), { metric: "providerTokens", current: 10, limit: null, remaining: null, window: { kind: "project_lifetime", startedAt: project.createdAt, resetAt: null } });

    const filtered = await get(api.baseUrl, `/api/v1/projects/${project.id}/usage?endpointId=${second.id}`, cookie);
    assert.equal(filtered.selectedEndpointId, second.id);
    assert.deepEqual(filtered.daily.reduce((total: { requests: number; tokens: number; cost: number }, day: { requests: number; tokens: number; cost: number }) => ({ requests: total.requests + day.requests, tokens: total.tokens + day.tokens, cost: total.cost + day.cost }), { requests: 0, tokens: 0, cost: 0 }), { requests: 1, tokens: 2, cost: 0.25 });
    const invalid = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/usage?endpointId=other`, { headers: { cookie } });
    assert.equal(invalid.status, 404);
    const removedFilter = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/usage?groupBy=provider`, { headers: { cookie } });
    assert.equal(removedFilter.status, 400);
    assert.doesNotMatch(JSON.stringify(all), /usage-secret|credentialId|ciphertext|nonce/);
  } finally { await api.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

function endpointInput(name: string, credentialId: string) { return { name, protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId, capabilities: ["text"], requestTimeoutSecs: 30 }; }
async function settle(store: ReturnType<typeof createLocalInMemoryProductStore>, id: string, projectId: string, endpointId: string, actorId:string, time: string, usage: { tokens: number; cost: number }): Promise<void> { await store.reserveProjectProviderSettlement({ id, projectId, taskId: null, endpointId, actorId, reservedTokens: 0, reservedCost: 0, reservedAt: time, expiresAt: new Date(Date.parse(time) + 60_000).toISOString() }); await store.markProjectProviderSettlementDispatched(id, time); await store.markProjectProviderSettlementDelivered(id, time); await store.settleProjectProviderSettlement(id, usage, time); }
async function post(base: string, pathname: string, body: unknown): Promise<Response> { return fetch(base + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function json(base: string, pathname: string, body: unknown, cookie: string, csrf: string): Promise<any> { const response = await fetch(base + pathname, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf, ...(isResourceCreation(pathname) ? { "idempotency-key": crypto.randomUUID() } : {}) }, body: JSON.stringify(body) }); if (response.status !== 200) assert.fail(await response.text()); return response.json(); }
function isResourceCreation(pathname:string):boolean{return pathname==="/api/v1/workspaces"||/^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(pathname)||/^\/api\/v1\/projects\/[^/]+\/(credentials|endpoints|file-libraries)$/.test(pathname)}
async function get(base: string, pathname: string, cookie: string): Promise<any> { const response = await fetch(base + pathname, { headers: { cookie } }); if (response.status !== 200) assert.fail(await response.text()); return response.json(); }
