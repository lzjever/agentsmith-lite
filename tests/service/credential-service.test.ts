import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";

test("project credentials are write-only, rotate with new AAD version, and bind endpoints", async () => {
  const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/agentsmith-credential-test", builtinAdminPassword: "admin-password" });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
  const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "first-secret" });

  assert.deepEqual(Object.keys(credential).sort(), ["baseUrl", "createdAt", "fingerprint", "id", "lastRotatedAt", "name", "projectId", "type", "updatedAt", "version"]);
  assert.deepEqual((await services.credentials.list(user.id, project.id)).map((item) => item.id), [credential.id]);
  assert.equal((await services.credentials.resolve(project.id, credential.id)).apiKey, "first-secret");
  const rotated = await services.credentials.rotate(user.id, project.id, credential.id, { secret: "second-secret" });
  assert.equal(rotated.version, 2);
  assert.notEqual(rotated.fingerprint, credential.fingerprint);
  assert.equal((await services.credentials.resolve(project.id, credential.id)).apiKey, "second-secret");

  const endpoint = await services.endpoints.createEndpoint(user.id, project.id, { name: "Endpoint", protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 });
  assert.equal(endpoint.credentialId, credential.id);
  await assert.rejects(() => services.credentials.remove(user.id, project.id, credential.id));
  await services.endpoints.deleteEndpoint(user.id, project.id, endpoint.id);
  await services.credentials.remove(user.id, project.id, credential.id);
  assert.deepEqual(await services.credentials.list(user.id, project.id), []);
});
