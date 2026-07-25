import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer } from "../../packages/api-entry-node/src/server.js";

test("usage overview returns project limits and authenticated-user provider aggregates", async () => {
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
    const workspace = (await json(api.baseUrl, "/api/v1/workspaces", { name: "Usage" }, cookie, csrfToken)).workspace;
    const project = await json(api.baseUrl, `/api/v1/workspaces/${workspace.id}/projects`, { name: "Usage project" }, cookie, csrfToken);
    const library = await json(api.baseUrl, `/api/v1/projects/${project.id}/file-libraries`, { name:"Usage files" }, cookie, csrfToken);
    const credential = await json(api.baseUrl, `/api/v1/projects/${project.id}/credentials`, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "usage-secret" }, cookie, csrfToken);
    const first = await json(api.baseUrl, `/api/v1/projects/${project.id}/endpoints`, endpointInput("Primary", credential.id), cookie, csrfToken);
    const second = await json(api.baseUrl, `/api/v1/projects/${project.id}/endpoints`, endpointInput("Secondary", credential.id), cookie, csrfToken);
    const now = new Date().toISOString();
    await settle(store, "settlement_primary", project.id, first.id, user.id, now, { tokens: 8, cost: 1.25 });
    await settle(store, "settlement_secondary", project.id, second.id, user.id, now, { tokens: 2, cost: 0.25 });
    await settle(store, "settlement_other_user", project.id, first.id, "user_not_authenticated", now, { tokens: 100, cost: 50 });
    const filesRoot = path.join(dataRoot, project.rootPath, library.rootSubPath);
    await mkdir(filesRoot, { recursive: true });
    const directFile = path.join(filesRoot, "unaccounted.txt");
    await writeFile(directFile, "storage");
    await store.patchProjectResourcePolicy(project.id, { projectFileBytesLimit: 1 }, now);

    const all = await get(api.baseUrl, `/api/v1/projects/${project.id}/usage`, cookie);
    assert.deepEqual(Object.keys(all).sort(), ["canSelectMemberUsage", "fileStorage", "limits", "projectId", "provider", "sandbox"]);
    assert.equal(all.canSelectMemberUsage,true);
    assert.equal(all.sandbox.unreleasedCount,0);
    assert.equal("activeCount" in all.sandbox,false);
    assert.equal(all.provider.userId, user.id);
    assert.equal(all.provider.daily.length, 30);
    assert.match(all.provider.periodStart, /T00:00:00\.000Z$/);
    assert.match(all.provider.periodEnd, /T00:00:00\.000Z$/);
    assert.equal("endpoints" in all.provider,false);
    assert.equal(all.provider.selectedEndpoint,null);
    const endpointUsage=await get(api.baseUrl,`/api/v1/projects/${project.id}/usage/endpoints?limit=50`,cookie);
    assert.deepEqual(endpointUsage.items.map((endpoint:{endpointName:string;requests:number;tokens:number;cost:number})=>[endpoint.endpointName,endpoint.requests,endpoint.tokens,endpoint.cost]).sort(),[["Primary",1,8,1.25],["Secondary",1,2,0.25]].sort());
    assert.equal(endpointUsage.total,2);
    assert.equal(endpointUsage.nextCursor,null);
    const endpointUsageFirst=await get(api.baseUrl,`/api/v1/projects/${project.id}/usage/endpoints?limit=1`,cookie);
    assert.ok(endpointUsageFirst.nextCursor);
    const endpointUsageSecond=await get(api.baseUrl,`/api/v1/projects/${project.id}/usage/endpoints?limit=1&cursor=${encodeURIComponent(endpointUsageFirst.nextCursor)}`,cookie);
    assert.equal(endpointUsageSecond.items.length,1);
    assert.notEqual(endpointUsageSecond.items[0].endpointId,endpointUsageFirst.items[0].endpointId);
    assert.deepEqual((await get(api.baseUrl,`/api/v1/projects/${project.id}/usage/endpoints?q=primary`,cookie)).items.map((endpoint:{endpointName:string})=>endpoint.endpointName),["Primary"]);
    assert.equal((await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/usage/endpoints?cursor=`,{headers:{cookie}})).status,400);
    assert.equal((await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/usage/endpoints?q=changed&cursor=${encodeURIComponent(endpointUsageFirst.nextCursor)}`,{headers:{cookie}})).status,400);
    assert.deepEqual(all.limits.find((limit: { metric: string }) => limit.metric === "activeSandboxes"), { metric: "activeSandboxes", current: 0, limit: 2, remaining: 2, window: { kind: "current_gauge", resetAt: null } });
    assert.doesNotMatch(JSON.stringify(all), /activeTasks|taskConcurrencyLimit|active_tasks/);
    assert.deepEqual(all.limits.find((limit: { metric: string }) => limit.metric === "providerTokens"), { metric: "providerTokens", current: 110, limit: null, remaining: null, window: { kind: "project_lifetime", startedAt: project.createdAt, resetAt: null } });
    assert.equal(all.limits.some((limit: { metric: string }) => limit.metric === "projectFileBytes"),false);
    assert.deepEqual(all.fileStorage,{recordedBytes:0,measuredAt:null,limitBytes:1,remainingBytes:1});

    const refreshUrl=`${api.baseUrl}/api/v1/projects/${project.id}/usage/file-storage/refresh`;
    assert.equal((await fetch(refreshUrl,{method:"POST",headers:{cookie,"content-type":"application/json"},body:"{}"})).status,403);
    assert.equal((await fetch(`${refreshUrl}?force=true`,{method:"POST",headers:{cookie,"x-csrf-token":csrfToken,"content-type":"application/json"},body:"{}"})).status,400);
    assert.equal((await fetch(refreshUrl,{method:"POST",headers:{cookie,"x-csrf-token":csrfToken,"content-type":"application/json"},body:JSON.stringify({force:true})})).status,400);
    const refreshedResponse=await fetch(refreshUrl,{method:"POST",headers:{cookie,"x-csrf-token":csrfToken,"content-type":"application/json"},body:"{}"});
    assert.equal(refreshedResponse.status,200,await refreshedResponse.clone().text());
    const refreshed=await refreshedResponse.json() as {projectId:string;fileStorage:{recordedBytes:number;measuredAt:string|null;limitBytes:number|null;remainingBytes:number|null}};
    assert.equal(refreshed.projectId,project.id);
    assert.deepEqual({...refreshed.fileStorage,measuredAt:"measured"},{recordedBytes:7,measuredAt:"measured",limitBytes:1,remainingBytes:0});
    assert.match(refreshed.fileStorage.measuredAt??"",/Z$/);
    assert.equal((await store.queryProjectAlerts(project.id,{view:"active",limit:50})).items.some((alert)=>alert.type==="project_file_bytes_limit"),true);
    assert.deepEqual((await get(api.baseUrl, `/api/v1/projects/${project.id}/usage`, cookie)).fileStorage,refreshed.fileStorage);

    await rm(directFile);
    const recoveredResponse=await fetch(refreshUrl,{method:"POST",headers:{cookie,"x-csrf-token":csrfToken,"content-type":"application/json"},body:"{}"});
    assert.equal(recoveredResponse.status,200,await recoveredResponse.clone().text());
    const recovered=await recoveredResponse.json() as {fileStorage:{recordedBytes:number;measuredAt:string|null;limitBytes:number|null;remainingBytes:number|null}};
    assert.deepEqual({...recovered.fileStorage,measuredAt:"measured"},{recordedBytes:0,measuredAt:"measured",limitBytes:1,remainingBytes:1});
    assert.equal((await store.queryProjectAlerts(project.id,{view:"active",limit:50})).items.some((alert)=>alert.type==="project_file_bytes_limit"),false);

    const filtered = await get(api.baseUrl, `/api/v1/projects/${project.id}/usage?endpointId=${second.id}`, cookie);
    assert.equal(filtered.provider.selectedEndpointId, second.id);
    assert.deepEqual(filtered.provider.selectedEndpoint,{id:second.id,name:"Secondary"});
    assert.deepEqual(filtered.provider.totals, { requests: 1, tokens: 2, cost: 0.25 });
    assert.deepEqual(filtered.provider.daily.reduce((total: { requests: number; tokens: number; cost: number }, day: { requests: number; tokens: number; cost: number }) => ({ requests: total.requests + day.requests, tokens: total.tokens + day.tokens, cost: total.cost + day.cost }), { requests: 0, tokens: 0, cost: 0 }), filtered.provider.totals);
    const invalid = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/usage?endpointId=other`, { headers: { cookie } });
    assert.equal(invalid.status, 404);
    const removedFilter = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/usage?groupBy=provider`, { headers: { cookie } });
    assert.equal(removedFilter.status, 400);
    const history = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/usage/sandbox-runs?limit=50`, { headers: { cookie } });
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json() as { items: unknown[]; nextCursor: string | null }).items, []);
    assert.equal((await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/usage/sandbox-runs?limit=51`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/usage/sandbox-runs?endpointId=${first.id}`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/usage/sandbox-runs?cursor=malformed`, { headers: { cookie } })).status, 400);
    assert.doesNotMatch(JSON.stringify(all), /usage-secret|credentialId|ciphertext|nonce/);
  } finally { await api.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

function endpointInput(name: string, credentialId: string) { return { name, protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId, capabilities: ["text"], requestTimeoutSecs: 30 }; }
async function settle(store: ReturnType<typeof createLocalInMemoryProductStore>, id: string, projectId: string, endpointId: string, actorId:string, time: string, usage: { tokens: number; cost: number }): Promise<void> { await store.reserveProjectProviderSettlement({ id, projectId, taskId: null, endpointId, actorId, reservedTokens: 0, reservedCost: 0, reservedAt: time, expiresAt: new Date(Date.parse(time) + 60_000).toISOString() }); await store.markProjectProviderSettlementDispatched(id, time); await store.markProjectProviderSettlementDelivered(id, time); await store.settleProjectProviderSettlement(id, usage, time); }
async function post(base: string, pathname: string, body: unknown): Promise<Response> { return fetch(base + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function json(base: string, pathname: string, body: unknown, cookie: string, csrf: string): Promise<any> { const response = await fetch(base + pathname, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf, ...(isResourceCreation(pathname) ? { "idempotency-key": crypto.randomUUID() } : {}) }, body: JSON.stringify(body) }); if (response.status !== 200) assert.fail(await response.text()); return response.json(); }
function isResourceCreation(pathname:string):boolean{return pathname==="/api/v1/workspaces"||/^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(pathname)||/^\/api\/v1\/projects\/[^/]+\/(credentials|endpoints|file-libraries)$/.test(pathname)}
async function get(base: string, pathname: string, cookie: string): Promise<any> { const response = await fetch(base + pathname, { headers: { cookie } }); if (response.status !== 200) assert.fail(await response.text()); return response.json(); }
