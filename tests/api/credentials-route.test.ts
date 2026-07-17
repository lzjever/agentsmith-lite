import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestApiServer as createApiServer } from "../../packages/api-entry-node/src/server.js";

test("credential routes never return submitted secret material", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-credentials-api-"));
  const api = await createApiServer({
    port: 0,
    dataRoot,
    builtinAdminPassword: "admin-password",
    providerClient: {
      completeChat: async () => { throw new Error("not used"); },
      validateEndpoint: async () => ({ status: "healthy" })
    }
  });
  try {
    await post(api.baseUrl, "/api/v1/auth/bootstrap", { password: "admin-password" });
    const login = await post(api.baseUrl, "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { csrfToken } = await login.json() as { csrfToken: string };
    const workspace = await json(api.baseUrl, "/api/v1/workspaces", { name: "W" }, cookie, csrfToken);
    const project = await json(api.baseUrl, `/api/v1/workspaces/${workspace.id}/projects`, { name: "P" }, cookie, csrfToken);
    const created = await json(api.baseUrl, `/api/v1/projects/${project.id}/credentials`, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "never-return-this" }, cookie, csrfToken);
    assert.doesNotMatch(JSON.stringify(created), /never-return-this|ciphertext|nonce|authTag|keyId/);
    const listed = await get(api.baseUrl, `/api/v1/projects/${project.id}/credentials`, cookie);
    assert.equal(listed.length, 1);
    assert.doesNotMatch(JSON.stringify(listed), /never-return-this|ciphertext|nonce|authTag|keyId/);
    assert.equal(Object.hasOwn(created, "description"), false);

    const missingRotateKey=await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/credentials/${created.id}/rotate`,{method:"POST",headers:{"content-type":"application/json",cookie,"x-csrf-token":csrfToken},body:JSON.stringify({secret:"rotated-secret"})});assert.equal(missingRotateKey.status,400);
    const rotated = await json(api.baseUrl, `/api/v1/projects/${project.id}/credentials/${created.id}/rotate`, { secret: "rotated-secret" }, cookie, csrfToken);
    assert.equal(rotated.version, 2);
    assert.doesNotMatch(JSON.stringify(rotated), /rotated-secret|ciphertext|nonce|authTag|keyId/);

    const endpoint = await json(api.baseUrl, `/api/v1/projects/${project.id}/endpoints`, { name: "Provider", protocol: "openai_chat_completions", baseUrl: created.baseUrl, model: "model", credentialId: created.id, capabilities: ["text"], requestTimeoutSecs: 30 }, cookie, csrfToken);
    const blocked = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/credentials/${created.id}`, { method: "DELETE", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken }, body: JSON.stringify({ expectedVersion: rotated.version }) });
    assert.equal(blocked.status, 409);
    await requestJson(api.baseUrl, `/api/v1/projects/${project.id}/endpoints/${endpoint.id}`, "DELETE", undefined, cookie, csrfToken);
    const staleDelete = await fetch(`${api.baseUrl}/api/v1/projects/${project.id}/credentials/${created.id}`, { method: "DELETE", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken }, body: JSON.stringify({ expectedVersion: created.version }) });
    assert.equal(staleDelete.status, 409);
    assert.deepEqual(await requestJson(api.baseUrl, `/api/v1/projects/${project.id}/credentials/${created.id}`, "DELETE", { expectedVersion: rotated.version }, cookie, csrfToken), { deleted: true });
  } finally { await api.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

async function post(base: string, pathname: string, body: unknown): Promise<Response> { return fetch(base + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function json(base: string, pathname: string, body: unknown, cookie: string, csrf: string): Promise<any> { const response = await fetch(base + pathname, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf, ...(isResourceCreation(pathname) ? { "idempotency-key": crypto.randomUUID() } : {}) }, body: JSON.stringify(body) }); if (response.status !== 200) assert.fail(await response.text()); return response.json(); }
function isResourceCreation(pathname:string):boolean{return pathname==="/api/v1/workspaces"||/^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(pathname)||/^\/api\/v1\/projects\/[^/]+\/(credentials|endpoints)$/.test(pathname)||/^\/api\/v1\/projects\/[^/]+\/credentials\/[^/]+\/rotate$/.test(pathname)}
async function get(base: string, pathname: string, cookie: string): Promise<any> { const response = await fetch(base + pathname, { headers: { cookie } }); if (response.status !== 200) assert.fail(await response.text()); return response.json(); }
async function requestJson(base: string, pathname: string, method: "DELETE", body: unknown, cookie: string, csrf: string): Promise<any> { const response = await fetch(base + pathname, { method, headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (response.status !== 200) assert.fail(await response.text()); return response.json(); }
