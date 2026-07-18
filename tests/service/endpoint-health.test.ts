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
  await assert.rejects(() => services.endpoints.createEndpoint(user.id, project.id, { name: "x".repeat(161), protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 }), /endpoint\.name must be 160 characters or less/);

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

test("endpoint validation cannot commit after its credential is rotated", async () => {
  let validationStarted!: () => void;
  let finishValidation!: () => void;
  const started = new Promise<void>((resolve) => { validationStarted = resolve; });
  const store = createInMemoryProductStore();
  const services = createApplicationServices({
    store,
    dataRoot: "/tmp/agentsmith-endpoint-credential-race",
    builtinAdminPassword: "admin-password",
    providerClient: {
      completeChat: async () => { throw new Error("not used"); },
      validateEndpoint: async () => {
        validationStarted();
        return new Promise<{ status: "healthy" }>((resolve) => { finishValidation = () => resolve({ status: "healthy" }); });
      }
    }
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
  const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "first-secret" });

  const creating = services.endpoints.createEndpoint(user.id, project.id, { name: "Provider", protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 });
  await started;
  await services.credentials.rotate(user.id, project.id, credential.id, { secret: "second-secret" });
  finishValidation();

  await assert.rejects(creating, /Credential changed during endpoint validation/);
  assert.deepEqual(await services.endpoints.listEndpoints(user.id, project.id), []);
});

test("endpoint names stay unique within a project across concurrent creates and renames", async () => {
  const store = createInMemoryProductStore();
  const services = createApplicationServices({
    store,
    dataRoot: "/tmp/agentsmith-endpoint-name-uniqueness",
    builtinAdminPassword: "admin-password",
    providerClient: {
      completeChat: async () => { throw new Error("not used"); },
      validateEndpoint: async () => ({ status: "healthy" })
    }
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
  const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "secret" });
  const input = (name: string) => ({ name, protocol: "openai_chat_completions" as const, baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text" as const], requestTimeoutSecs: 30 });

  const concurrent = await Promise.allSettled([
    services.endpoints.createEndpoint(user.id, project.id, input("Primary")),
    services.endpoints.createEndpoint(user.id, project.id, input(" primary "))
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  const rejectedCreate = concurrent.find((result) => result.status === "rejected");
  assert.match(String(rejectedCreate?.status === "rejected" ? rejectedCreate.reason : ""), /endpoint already uses that name/i);

  const first = (await services.endpoints.listEndpoints(user.id, project.id))[0]!;
  const second = await services.endpoints.createEndpoint(user.id, project.id, input("Secondary"));
  await assert.rejects(
    () => services.endpoints.updateEndpoint(user.id, project.id, second.id, { ...input(first.name.toUpperCase()), credentialId: credential.id, expectedUpdatedAt:second.updatedAt }),
    /endpoint already uses that name/i
  );
  assert.equal((await services.endpoints.requireEndpointForProject(project.id, second.id)).name, "Secondary");
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
  let discoveryCalls = 0;
  const store = createInMemoryProductStore();
  const services = createApplicationServices({
    store, dataRoot: "/tmp/agentsmith-endpoint-recheck",
    builtinAdminPassword: "admin-password",
    providerClient: {
      completeChat: async () => { throw new Error("not used"); },
      validateEndpoint: async () => outcome === "healthy" ? { status: "healthy" } : { status: "unavailable", errorCategory: "auth" },
      discoverModels: async () => { discoveryCalls += 1; return { models: ["z-model", "a-model", "a-model"], health: { status: "healthy", checkedAt: null, errorCategory: null } }; }
    }
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
  const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "never-expose-this" });
  const discoveryInput = { baseUrl: credential.baseUrl, credentialId: credential.id, requestTimeoutSecs: 30 };
  const discovered = await services.endpoints.discoverModels(user.id, project.id, discoveryInput, "model-discovery-key");
  const replayedDiscovery = await services.endpoints.discoverModels(user.id, project.id, discoveryInput, "model-discovery-key");
  assert.deepEqual(discovered.models, ["a-model", "z-model"]);
  assert.deepEqual(replayedDiscovery, discovered);
  assert.equal(discoveryCalls, 1);
  assert.equal(discovered.health.status, "healthy");
  assert.ok(discovered.health.checkedAt);

  const endpoint = await services.endpoints.createEndpoint(user.id, project.id, { name: "Provider", protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "a-model", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 });
  await services.endpoints.discoverModels(user.id, project.id, { endpointId: endpoint.id, baseUrl: credential.baseUrl, credentialId: credential.id, requestTimeoutSecs: 30 });
  assert.equal(discoveryCalls, 2);
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
  await services.endpoints.updateEndpoint(user.id, project.id, endpoint.id, { name: "After", protocol: endpoint.protocol, baseUrl: endpoint.baseUrl, model: endpoint.model, credentialId: credential.id, capabilities: endpoint.capabilities, requestTimeoutSecs: endpoint.requestTimeoutSecs, expectedUpdatedAt:endpoint.updatedAt });
  finishRecheck({ status: "healthy" });

  assert.equal((await rechecking).name, "After");
  assert.equal((await services.endpoints.listEndpoints(user.id, project.id))[0]?.name, "After");
});

test("a stale endpoint form is rejected before provider validation", async () => {
  let validationCalls=0;
  const store=createInMemoryProductStore();
  const services=createApplicationServices({store,dataRoot:"/tmp/agentsmith-endpoint-stale-form",builtinAdminPassword:"admin-password",providerClient:{completeChat:async()=>{throw new Error("not used");},validateEndpoint:async()=>{validationCalls+=1;return{status:"healthy" as const};}}});
  const{user}=await services.auth.loginAfterBootstrap("admin-password");
  const workspace=await services.workspaces.createWorkspace(user.id,{name:"W"});
  const project=await services.workspaces.createProject(user.id,workspace.id,{name:"P"});
  const credential=await services.credentials.create(user.id,project.id,{name:"Provider",baseUrl:"https://models.example.test/v1",secret:"secret"});
  const endpoint=await services.endpoints.createEndpoint(user.id,project.id,{name:"Before",protocol:"openai_chat_completions",baseUrl:credential.baseUrl,model:"model",credentialId:credential.id,capabilities:["text"],requestTimeoutSecs:30});
  const concurrent={...endpoint,name:"Concurrent",updatedAt:new Date(Date.parse(endpoint.updatedAt)+1).toISOString()};
  await store.updateEndpoint(concurrent,endpoint.updatedAt);

  await assert.rejects(
    ()=>services.endpoints.updateEndpoint(user.id,project.id,endpoint.id,{name:"Stale",protocol:endpoint.protocol,baseUrl:endpoint.baseUrl,model:endpoint.model,credentialId:credential.id,capabilities:endpoint.capabilities,requestTimeoutSecs:endpoint.requestTimeoutSecs,expectedUpdatedAt:endpoint.updatedAt}),
    /Endpoint changed elsewhere/
  );
  assert.equal(validationCalls,1);
  assert.equal((await store.findEndpoint(endpoint.id))?.name,"Concurrent");
});

test("a slower endpoint update cannot overwrite a newer validated configuration", async () => {
  let validationCalls = 0;
  let slowStarted!: () => void;
  let finishSlow!: () => void;
  const started = new Promise<void>((resolve) => { slowStarted = resolve; });
  const store = createInMemoryProductStore();
  const services = createApplicationServices({
    store, dataRoot:"/tmp/agentsmith-endpoint-update-race", builtinAdminPassword:"admin-password",
    providerClient: {
      completeChat: async () => { throw new Error("not used"); },
      validateEndpoint: async () => {
        validationCalls += 1;
        if (validationCalls !== 2) return { status:"healthy" as const };
        slowStarted();
        return new Promise<{ status:"healthy" }>((resolve) => { finishSlow = () => resolve({ status:"healthy" }); });
      }
    }
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name:"W" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name:"P" });
  const credential = await services.credentials.create(user.id, project.id, { name:"Provider", baseUrl:"https://models.example.test/v1", secret:"secret" });
  const endpoint = await services.endpoints.createEndpoint(user.id, project.id, { name:"Before", protocol:"openai_chat_completions", baseUrl:credential.baseUrl, model:"model", credentialId:credential.id, capabilities:["text"], requestTimeoutSecs:30 });
  const input = (name:string) => ({ name, protocol:endpoint.protocol, baseUrl:endpoint.baseUrl, model:endpoint.model, credentialId:credential.id, capabilities:endpoint.capabilities, requestTimeoutSecs:endpoint.requestTimeoutSecs, expectedUpdatedAt:endpoint.updatedAt });

  const slow = services.endpoints.updateEndpoint(user.id, project.id, endpoint.id, input("Slow"));
  await started;
  const fast = await services.endpoints.updateEndpoint(user.id, project.id, endpoint.id, input("Fast"));
  finishSlow();

  assert.equal(fast.name, "Fast");
  await assert.rejects(slow, /changed elsewhere/);
  assert.equal((await services.endpoints.requireEndpointForProject(project.id, endpoint.id)).name, "Fast");
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
  const input = { name: "After", protocol: endpoint.protocol, baseUrl: endpoint.baseUrl, model: endpoint.model, credentialId: credential.id, capabilities: endpoint.capabilities, requestTimeoutSecs: endpoint.requestTimeoutSecs, expectedUpdatedAt:endpoint.updatedAt };

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
