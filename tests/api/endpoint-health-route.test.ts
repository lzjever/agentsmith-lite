import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "../../packages/api-entry-node/src/server.js";

test("endpoint model discovery and health rechecks are authorized and expose only safe metadata", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-endpoint-health-api-"));
  let available = true;
  const api = await createApiServer({
    port: 0,
    dataRoot,
    builtinAdminPassword: "admin-password",
    providerClient: {
      completeChat: async () => { throw new Error("not used"); },
      validateEndpoint: async () => available ? { status: "healthy" } : { status: "unavailable", errorCategory: "auth" },
      discoverModels: async () => ({ models: ["model-b", "model-a"], health: { status: "healthy", checkedAt: null, errorCategory: null } })
    }
  });
  try {
    await post(api.baseUrl, "/api/v1/auth/bootstrap", { password: "admin-password" });
    const login = await post(api.baseUrl, "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { csrfToken } = await login.json() as { csrfToken: string };
    const workspace = await json(api.baseUrl, "/api/v1/workspaces", { name: "W" }, cookie, csrfToken);
    const project = await json(api.baseUrl, `/api/v1/workspaces/${workspace.id}/projects`, { name: "P" }, cookie, csrfToken);
    const credential = await json(api.baseUrl, `/api/v1/projects/${project.id}/credentials`, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "never-return-this" }, cookie, csrfToken);

    const discovery = await json(api.baseUrl, `/api/v1/projects/${project.id}/endpoints/models`, { baseUrl: credential.baseUrl, credentialId: credential.id, requestTimeoutSecs: 30 }, cookie, csrfToken);
    assert.deepEqual(discovery.models, ["model-b", "model-a"]);
    assert.equal(discovery.health.status, "healthy");
    assert.doesNotMatch(JSON.stringify(discovery), /never-return-this|credentialId/);

    const endpoint = await json(api.baseUrl, `/api/v1/projects/${project.id}/endpoints`, { name: "Provider", protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "model-a", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 }, cookie, csrfToken);
    assert.equal(endpoint.health.status, "healthy");
    assert.equal(endpoint.credentialId, credential.id);
    assert.doesNotMatch(JSON.stringify(endpoint), /never-return-this|ciphertext|authTag|nonce|keyId/);
    const persistedDiscovery = await json(api.baseUrl, `/api/v1/projects/${project.id}/endpoints/models`, { endpointId: endpoint.id, baseUrl: credential.baseUrl, credentialId: credential.id, requestTimeoutSecs: 30 }, cookie, csrfToken);
    assert.deepEqual(persistedDiscovery.models, ["model-b", "model-a"]);

    available = false;
    const unavailable = await json(api.baseUrl, `/api/v1/projects/${project.id}/endpoints/${endpoint.id}/health`, undefined, cookie, csrfToken);
    assert.deepEqual(unavailable.health.status, "unavailable");
    assert.equal(unavailable.health.errorCategory, "auth");
    assert.equal(unavailable.credentialId, credential.id);
    assert.doesNotMatch(JSON.stringify(unavailable), /never-return-this|ciphertext|authTag|nonce|keyId/);

    available = true;
    const recovered = await json(api.baseUrl, `/api/v1/projects/${project.id}/endpoints/${endpoint.id}/health`, undefined, cookie, csrfToken);
    assert.equal(recovered.health.status, "healthy");
    assert.equal(recovered.health.errorCategory, null);
  } finally {
    await api.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function post(base: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(base + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function json(base: string, pathname: string, body: unknown, cookie: string, csrf: string): Promise<any> {
  const response = await fetch(base + pathname, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status !== 200) assert.fail(await response.text());
  return response.json();
}
