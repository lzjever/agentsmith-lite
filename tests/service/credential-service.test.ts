import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { ProductError } from "../../packages/domain/src/errors.js";

test("project credentials are write-only, rotate with new AAD version, and bind endpoints", async () => {
  const services = createApplicationServices({
    store: createInMemoryProductStore(),
    dataRoot: "/tmp/agentsmith-credential-test",
    builtinAdminPassword: "admin-password",
    providerClient: {
      async validateEndpoint() { return { status: "healthy" as const }; },
      async completeChat() { throw new Error("not used"); }
    }
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
  const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "first-secret" });

  assert.deepEqual(Object.keys(credential).sort(), ["baseUrl", "createdAt", "fingerprint", "id", "lastRotatedAt", "name", "projectId", "type", "updatedAt", "version"]);
  assert.deepEqual((await services.credentials.list(user.id, project.id)).map((item) => item.id), [credential.id]);
  assert.equal((await services.credentials.resolve(project.id, credential.id)).apiKey, "first-secret");
  const endpoint = await services.endpoints.createEndpoint(user.id, project.id, { name: "Endpoint", protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 });
  assert.equal(endpoint.health?.status, "healthy");

  const rotated = await services.credentials.rotate(user.id, project.id, credential.id, { secret: "second-secret" });
  assert.equal(rotated.version, 2);
  assert.notEqual(rotated.fingerprint, credential.fingerprint);
  assert.equal((await services.credentials.resolve(project.id, credential.id)).apiKey, "second-secret");
  assert.equal((await services.endpoints.requireEndpointForProject(project.id, endpoint.id)).health?.status, "unknown");
  await assert.rejects(() => services.endpoints.requireCredentialEndpointForUser(user.id, project.id, endpoint.id), /Recheck it before use/);
  assert.equal((await services.endpoints.recheckEndpoint(user.id, project.id, endpoint.id)).health?.status, "healthy");

  assert.equal(endpoint.credentialId, credential.id);
  await assert.rejects(() => services.credentials.remove(user.id, project.id, credential.id, rotated.version));
  await services.endpoints.deleteEndpoint(user.id, project.id, endpoint.id);
  await assert.rejects(() => services.credentials.remove(user.id, project.id, credential.id, credential.version), status(409));
  assert.equal((await services.credentials.resolve(project.id, credential.id)).apiKey, "second-secret");
  await services.credentials.remove(user.id, project.id, credential.id, rotated.version);
  assert.deepEqual(await services.credentials.list(user.id, project.id), []);
});

test("concurrent credential rotations reject the stale writer", async () => {
  const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/agentsmith-credential-concurrency-test", builtinAdminPassword: "admin-password" });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
  const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "first-secret" });

  const results = await Promise.allSettled([
    services.credentials.rotate(user.id, project.id, credential.id, { secret: "second-secret" }),
    services.credentials.rotate(user.id, project.id, credential.id, { secret: "third-secret" })
  ]);

  const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof services.credentials.rotate>>> => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0]!.value.version, 2);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason instanceof ProductError);
  assert.equal((rejected[0]!.reason as ProductError).statusCode, 409);
  assert.equal((await services.credentials.list(user.id, project.id))[0]!.version, 2);
});

test("legacy endpoint credential binding rejects a credential from another project", async () => {
  const store = createInMemoryProductStore();
  const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-credential-binding-test", builtinAdminPassword: "admin-password" });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const firstProject = await services.workspaces.createProject(user.id, workspace.id, { name: "P1" });
  const secondProject = await services.workspaces.createProject(user.id, workspace.id, { name: "P2" });
  const credential = await services.credentials.create(user.id, secondProject.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "secret" });
  const now = new Date().toISOString();
  await store.createEndpoint({ id: "endpoint_legacy", projectId: firstProject.id, name: "Legacy", protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "model", credentialId: "", capabilities: ["text"], requestTimeoutSecs: 30, createdAt: now, updatedAt: now });

  assert.equal(await store.bindEndpointCredential("endpoint_legacy", credential.id), false);
  assert.equal((await store.findEndpoint("endpoint_legacy"))!.credentialId, "");
});

function status(expected: number) { return (error: unknown) => error instanceof ProductError && error.statusCode === expected; }
