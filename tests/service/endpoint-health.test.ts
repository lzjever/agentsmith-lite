import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";

test("endpoint save validates with the bound write-only credential and exposes only safe health metadata", async () => {
  const calls: Array<{ apiKey: string; baseUrl: string }> = [];
  const store = createInMemoryProductStore();
  const services = createApplicationServices({
    store, dataRoot: "/tmp/agentsmith-endpoint-health",
    builtinAdminPassword: "admin-password",
    providerClient: { completeChat: async () => { throw new Error("not used"); }, validateEndpoint: async (endpoint, apiKey) => { calls.push({ apiKey, baseUrl: endpoint.baseUrl }); return { status: "healthy" }; } }
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
  const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "never-expose-this" });

  const endpointInput = { name: "Provider", protocol: "openai_chat_completions" as const, baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text" as const], requestTimeoutSecs: 30 };
  const endpoint = await services.endpoints.createEndpoint(user.id, project.id, endpointInput, "endpoint-create-key");
  const replayedEndpoint = await services.endpoints.createEndpoint(user.id, project.id, endpointInput, "endpoint-create-key");

  assert.equal(replayedEndpoint.id, endpoint.id);
  assert.deepEqual(calls, [{ apiKey: "never-expose-this", baseUrl: credential.baseUrl }]);
  assert.equal(endpoint.health?.status, "healthy");
  assert.equal(endpoint.health?.errorCategory, null);
  assert.ok(endpoint.health?.checkedAt);
  assert.doesNotMatch(JSON.stringify(endpoint), /never-expose-this/);
  assert.deepEqual((await store.listSettledProjectProviderSettlements(project.id, "1970-01-01T00:00:00.000Z")).map((settlement) => settlement.endpointId), [null]);
  assert.equal((await store.findProjectResourceUsage(project.id))?.providerRequests, 1);
});

test("endpoint save rejects a sanitized validation failure without persisting an unusable endpoint", async () => {
  const store = createInMemoryProductStore();
  const services = createApplicationServices({
    store, dataRoot: "/tmp/agentsmith-endpoint-health-failure",
    builtinAdminPassword: "admin-password",
    providerClient: { completeChat: async () => { throw new Error("not used"); }, validateEndpoint: async () => ({ status: "unavailable", errorCategory: "auth" }) }
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
  const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "never-expose-this" });

  await assert.rejects(() => services.endpoints.createEndpoint(user.id, project.id, { name: "Provider", protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 }), /Endpoint validation failed: auth/);
  assert.deepEqual(await services.endpoints.listEndpoints(user.id, project.id), []);
  assert.deepEqual((await store.listSettledProjectProviderSettlements(project.id, "1970-01-01T00:00:00.000Z")).map((settlement) => settlement.endpointId), [null]);
  assert.equal((await store.findProjectResourceUsage(project.id))?.providerRequests, 1);
});

test("endpoint model discovery and recheck persist only safe health transitions", async () => {
  let outcome: "healthy" | "unavailable" = "healthy";
  const store = createInMemoryProductStore();
  const services = createApplicationServices({
    store, dataRoot: "/tmp/agentsmith-endpoint-recheck",
    builtinAdminPassword: "admin-password",
    providerClient: {
      completeChat: async () => { throw new Error("not used"); },
      validateEndpoint: async () => outcome === "healthy" ? { status: "healthy" } : { status: "unavailable", errorCategory: "auth" },
      discoverModels: async () => ({ models: ["z-model", "a-model", "a-model"], health: { status: "healthy", checkedAt: null, errorCategory: null } })
    }
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
  const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "never-expose-this" });
  const discovered = await services.endpoints.discoverModels(user.id, project.id, { baseUrl: credential.baseUrl, credentialId: credential.id, requestTimeoutSecs: 30 });
  assert.deepEqual(discovered.models, ["z-model", "a-model", "a-model"]);
  assert.equal(discovered.health.status, "healthy");
  assert.ok(discovered.health.checkedAt);

  const endpoint = await services.endpoints.createEndpoint(user.id, project.id, { name: "Provider", protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "a-model", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 });
  await services.endpoints.discoverModels(user.id, project.id, { endpointId: endpoint.id, baseUrl: credential.baseUrl, credentialId: credential.id, requestTimeoutSecs: 30 });
  outcome = "unavailable";
  const unavailable = await services.endpoints.recheckEndpoint(user.id, project.id, endpoint.id);
  assert.deepEqual(unavailable.health?.status, "unavailable");
  assert.equal(unavailable.health?.errorCategory, "auth");
  assert.doesNotMatch(JSON.stringify(unavailable), /never-expose-this/);

  outcome = "healthy";
  const recovered = await services.endpoints.recheckEndpoint(user.id, project.id, endpoint.id);
  assert.equal(recovered.health?.status, "healthy");
  assert.equal(recovered.health?.errorCategory, null);
  const settlements = await store.listSettledProjectProviderSettlements(project.id, "1970-01-01T00:00:00.000Z");
  assert.equal(settlements.filter((settlement) => settlement.endpointId === null).length, 2);
  assert.equal(settlements.filter((settlement) => settlement.endpointId === endpoint.id).length, 3);
});

test("endpoint recheck does not overwrite configuration changed while the provider responds", async () => {
  let validationCalls = 0;
  let recheckStarted!: () => void;
  let finishRecheck!: (value: { status: "healthy" }) => void;
  const started = new Promise<void>((resolve) => { recheckStarted = resolve; });
  const store = createInMemoryProductStore();
  const services = createApplicationServices({
    store, dataRoot: "/tmp/agentsmith-endpoint-recheck-race",
    builtinAdminPassword: "admin-password",
    providerClient: {
      completeChat: async () => { throw new Error("not used"); },
      validateEndpoint: async () => {
        validationCalls += 1;
        if (validationCalls !== 2) return { status: "healthy" as const };
        recheckStarted();
        return new Promise((resolve) => { finishRecheck = resolve; });
      }
    }
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
  const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "secret" });
  const endpoint = await services.endpoints.createEndpoint(user.id, project.id, { name: "Before", protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 });

  const rechecking = services.endpoints.recheckEndpoint(user.id, project.id, endpoint.id);
  await started;
  await services.endpoints.updateEndpoint(user.id, project.id, endpoint.id, { name: "After", protocol: endpoint.protocol, baseUrl: endpoint.baseUrl, model: endpoint.model, credentialId: credential.id, capabilities: endpoint.capabilities, requestTimeoutSecs: endpoint.requestTimeoutSecs });
  finishRecheck({ status: "healthy" });

  assert.equal((await rechecking).name, "After");
  assert.equal((await services.endpoints.listEndpoints(user.id, project.id))[0]?.name, "After");
});

test("endpoint updates and health rechecks replay without repeating provider work or audit", async () => {
  let validationCalls = 0;
  const store = createInMemoryProductStore();
  const services = createApplicationServices({
    store, dataRoot: "/tmp/agentsmith-endpoint-mutation-replay",
    builtinAdminPassword: "admin-password",
    providerClient: {
      completeChat: async () => { throw new Error("not used"); },
      validateEndpoint: async () => { validationCalls += 1; return { status: "healthy" }; }
    }
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
  const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "secret" });
  const endpoint = await services.endpoints.createEndpoint(user.id, project.id, { name: "Before", protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 });
  const input = { name: "After", protocol: endpoint.protocol, baseUrl: endpoint.baseUrl, model: endpoint.model, credentialId: credential.id, capabilities: endpoint.capabilities, requestTimeoutSecs: endpoint.requestTimeoutSecs };

  const updated = await services.endpoints.updateEndpoint(user.id, project.id, endpoint.id, input, "endpoint-update-key");
  const replayedUpdate = await services.endpoints.updateEndpoint(user.id, project.id, endpoint.id, input, "endpoint-update-key");
  assert.deepEqual(replayedUpdate, updated);

  const checked = await services.endpoints.recheckEndpoint(user.id, project.id, endpoint.id, "endpoint-recheck-key");
  const replayedCheck = await services.endpoints.recheckEndpoint(user.id, project.id, endpoint.id, "endpoint-recheck-key");
  assert.deepEqual(replayedCheck, checked);
  assert.equal(validationCalls, 3);
  const audit = await store.listProjectAuditEvents(project.id);
  assert.equal(audit.filter((event) => event.action === "endpoint.update" && event.status === "accepted").length, 1);
  assert.equal(audit.filter((event) => event.action === "endpoint.health_check" && event.status === "accepted").length, 1);
});
