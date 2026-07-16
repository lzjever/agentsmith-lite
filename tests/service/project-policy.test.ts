import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { AgentTask, ChatResponse, ModelEndpoint } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import type { OpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

describe("project resource policy", () => {
  it("creates the owner membership, default policy, and zero usage with the project", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/agentsmith-policy-project", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P", taskConcurrencyLimit: 3 });

    assert.equal((await services.memberships.listMembers(user.id, project.id)).find((member) => member.userId === user.id)?.role, "owner");
    assert.equal((await services.policies.getPolicy(user.id, project.id)).activeTasksLimit, 3);
    assert.deepEqual((await services.policies.getUsageOverview(user.id, project.id)).usage, {
      projectId: project.id,
      activeTasks: 0,
      providerRequests: 0,
      providerTokens: 0,
      providerCost: 0,
      projectFileBytes: 0,
      updatedAt: project.updatedAt
    });
  });

  it("atomically reserves active task capacity under concurrent requests", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/agentsmith-policy-concurrency", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P", taskConcurrencyLimit: 1 });

    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
      services.policies.reserveTask(project.id, user.id, `task-${index}`)
    ));

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 7);
    const { usage: current } = await services.policies.getUsageOverview(user.id, project.id);
    assert.equal(current.activeTasks, 1);
  });

  it("keeps in-memory file quota adjustment semantics in parity with PostgreSQL", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-file-quota-parity", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const timestamp = "2026-07-12T00:00:00.000Z";
    const adjust = (delta: number) => store.adjustProjectResourceUsage({ projectId: project.id, delta: { activeTasks: 0, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: delta }, limit: "project_file_bytes_limit", updatedAt: timestamp });

    await store.patchProjectResourcePolicy(project.id, { projectFileBytesLimit: 0 }, timestamp);
    assert.equal(await adjust(1), null);
    assert.equal((await store.findProjectResourceUsage(project.id))?.projectFileBytes, 0);
    await store.patchProjectResourcePolicy(project.id, { projectFileBytesLimit: 1 }, timestamp);
    assert.equal((await adjust(1))?.projectFileBytes, 1);
    assert.equal(await adjust(1), null);
    assert.equal((await adjust(-1))?.projectFileBytes, 0);
    const concurrent = await Promise.all([adjust(1), adjust(1)]);
    assert.equal(concurrent.filter(Boolean).length, 1);
    assert.equal((await store.findProjectResourceUsage(project.id))?.projectFileBytes, 1);
  });

  it("rejects a duplicate in-memory task id without charging active capacity twice", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-policy-duplicate-task", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P", taskConcurrencyLimit: 2 });
    const task: AgentTask = { id: "task_duplicate", workspaceId: workspace.id, projectId: project.id, endpointId: "endpoint", prompt: "not audited", status: "starting", runId: "run_duplicate", executionMode: "dry-run", sandbox: { namespace: "agentsmith", resources: [] }, createdAt: project.createdAt, updatedAt: project.updatedAt };
    await store.createTaskWithActiveReservation(task);
    await assert.rejects(() => store.createTaskWithActiveReservation(task), /Task already exists/);
    const { usage: current } = await services.policies.getUsageOverview(user.id, project.id);
    assert.equal(current.activeTasks, 1);
  });

  it("finalizes an active task once and releases capacity once", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-finalization-intent", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const task: AgentTask = { id: "task_intent", workspaceId: workspace.id, projectId: project.id, endpointId: "endpoint", prompt: "not audited", status: "running", runId: "run_intent", executionMode: "dry-run", sandbox: { namespace: "agentsmith", resources: [] }, createdAt: project.createdAt, updatedAt: project.updatedAt };
    await store.createTaskWithActiveReservation(task);
    const timestamp = new Date().toISOString();
    const [failed, completed] = await Promise.all([
      store.finalizeTaskLifecycle({ taskId: task.id, terminalReason: "failed", updatedAt: timestamp, auditEvent: { id: "audit_task_failed", projectId: project.id, actorId: null, action: "task.failed", status: "accepted", resourceKind: "task", resourceId: task.id, createdAt: timestamp }, successors: [] }),
      store.finalizeTaskLifecycle({ taskId: task.id, terminalReason: "completed", updatedAt: timestamp, auditEvent: { id: "audit_task_completed", projectId: project.id, actorId: null, action: "task.completed", status: "accepted", resourceKind: "task", resourceId: task.id, createdAt: timestamp }, successors: [] })
    ]);
    assert.equal([failed, completed].filter((result) => result?.applied).length, 1);
    const { usage: current } = await services.policies.getUsageOverview(user.id, project.id);
    assert.equal(current.activeTasks, 0);
  });

  it("atomically reserves provider requests and records token/cost overage alerts after the response", async () => {
    let calls = 0;
    const services = createApplicationServices({
      store: createInMemoryProductStore(), dataRoot: "/tmp/agentsmith-policy", builtinAdminPassword: "admin-password",
      providerClient: {
        async validateEndpoint() { return { status: "healthy" as const }; },
        async completeChat(endpoint: ModelEndpoint): Promise<ChatResponse> { calls++; return { message: { role: "assistant", content: "ok" }, endpointSnapshot: endpoint, usage: { tokens: 4097, cost: 2 } }; }
      } satisfies OpenAICompatibleClient,
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const credential = await services.credentials.create(user.id, project.id, { name: "E credential", baseUrl: "https://models.example.test/v1", secret: "sk-policy-test" });
    const endpoint = await services.endpoints.createEndpoint(user.id, project.id, { name: "E", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "m", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 });
    await services.policies.updatePolicy(user.id, project.id, { providerRequestsLimit: 2, providerTokensLimit: 4096, providerCostLimit: 1 });
    const results = await Promise.allSettled([
      sendThreadMessage(services, user.id, project.id, endpoint.id, "hi"),
      sendThreadMessage(services, user.id, project.id, endpoint.id, "again")
    ]);
    const { usage: current } = await services.policies.getUsageOverview(user.id, project.id);
    assert.deepEqual({ requests: current.providerRequests, tokens: current.providerTokens, cost: current.providerCost }, { requests: 2, tokens: 4097, cost: 2 });
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(calls, 1);
    assert.deepEqual((await services.policies.alerts(user.id, project.id)).map((alert) => alert.type).sort(), ["provider_cost_limit", "provider_requests_limit", "provider_tokens_limit"]);
    const providerAudit=(await services.policies.audit(user.id,project.id)).filter(event=>event.action==="provider.request");assert.equal(providerAudit.filter(event=>event.status==="rejected").length,1);assert.ok(providerAudit.filter(event=>event.status==="accepted").length>=1);
  });

  it("expires stale provider reservations with conservative request accounting", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-provider-expiry", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const reserved = await services.policies.reserveProvider(project.id, user.id, "endpoint");
    const dispatched = await services.policies.reserveProvider(project.id, user.id, "endpoint");
    await services.policies.markProviderDispatched(dispatched);
    const delivered = await services.policies.reserveProvider(project.id, user.id, "endpoint");
    await services.policies.markProviderDispatched(delivered);
    await services.policies.markProviderDelivered(delivered);
    const settled = await services.policies.reserveProvider(project.id, user.id, "endpoint");
    await services.policies.markProviderDispatched(settled);
    await services.policies.markProviderDelivered(settled);
    await services.policies.settleProvider(settled, { tokens: 3, cost: 0.25 });
    await store.expireProjectProviderSettlements("9999-01-01T00:00:00.000Z");
    const { usage: current } = await services.policies.getUsageOverview(user.id, project.id);
    assert.deepEqual({ requests: current.providerRequests, tokens: current.providerTokens, cost: current.providerCost }, { requests: 3, tokens: 8195, cost: 2.25 });
    await assert.rejects(() => services.policies.markProviderDispatched(reserved), /Provider settlement not found/);
    await services.policies.markProviderDelivered(dispatched);
    await services.policies.settleProvider(dispatched, { tokens: 1, cost: 1 });
    await services.policies.markProviderDelivered(delivered);
    await services.policies.settleProvider(delivered, { tokens: 2, cost: 0.5 });
    const afterLateSettlement = (await services.policies.getUsageOverview(user.id, project.id)).usage;
    assert.deepEqual({ requests: afterLateSettlement.providerRequests, tokens: afterLateSettlement.providerTokens, cost: afterLateSettlement.providerCost }, { requests: 3, tokens: 6, cost: 1.75 });
  });

  it("settles provider usage exactly once and leaves delivered requests without usage unknown", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-provider-idempotency", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const settled = await services.policies.reserveProvider(project.id, user.id, "endpoint");
    await services.policies.markProviderDispatched(settled);
    await services.policies.markProviderDelivered(settled);
    await services.policies.settleProvider(settled, { tokens: 3, cost: 1 });
    await services.policies.settleProvider(settled, { tokens: 99, cost: 99 });
    const { usage: current } = await services.policies.getUsageOverview(user.id, project.id);
    assert.deepEqual(current.providerTokens, 3);
    const unknown = await services.policies.reserveProvider(project.id, user.id, "endpoint");
    await services.policies.markProviderDispatched(unknown);
    await services.policies.markProviderDelivered(unknown);
    await services.policies.markProviderUnknown(unknown);
    const afterUnknown = (await services.policies.getUsageOverview(user.id, project.id)).usage;
    assert.deepEqual(
      { requests: afterUnknown.providerRequests, tokens: afterUnknown.providerTokens, cost: afterUnknown.providerCost },
      { requests: 2, tokens: 4099, cost: 2 }
    );
    assert.ok(await store.settleProjectProviderSettlement(unknown, { tokens: 1 }, new Date().toISOString()));
    const afterLateUsage = (await services.policies.getUsageOverview(user.id, project.id)).usage;
    assert.deepEqual({ requests: afterLateUsage.providerRequests, tokens: afterLateUsage.providerTokens, cost: afterLateUsage.providerCost }, { requests: 2, tokens: 4, cost: 1 });
  });

  it("keeps conservative usage when a dispatched provider request fails ambiguously", async () => {
    const services = createApplicationServices({
      store: createInMemoryProductStore(), dataRoot: "/tmp/agentsmith-provider-unknown", builtinAdminPassword: "admin-password",
      providerClient: { async completeChat() { throw new Error("connection lost after dispatch"); } }
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const endpoint = endpointRecord(project.id);

    await assert.rejects(() => services.providerBroker.completeChat({ endpoint, settlementEndpointId: null, apiKey: "secret", actorId: user.id }, [{ role: "user", content: "hello" }]), /provider request failed/i);

    const usage = (await services.policies.getUsageOverview(user.id, project.id)).usage;
    assert.deepEqual({ requests: usage.providerRequests, tokens: usage.providerTokens, cost: usage.providerCost }, { requests: 1, tokens: 4096, cost: 1 });
  });

  it("returns and settles a successful provider response that arrives after reservation expiry", async () => {
    const store = createInMemoryProductStore();
    let releaseResponse!: () => void;
    let markStarted!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const services = createApplicationServices({
      store, dataRoot: "/tmp/agentsmith-provider-late-success", builtinAdminPassword: "admin-password",
      providerClient: { async completeChat(endpoint) { markStarted(); await responseGate; return { message:{ role:"assistant" as const, content:"late success" }, endpointSnapshot:endpoint, usage:{ tokens:2, cost:0.5 } }; } }
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const endpoint = endpointRecord(project.id);

    const pending = services.providerBroker.completeChat({ endpoint, settlementEndpointId:null, apiKey:"secret", actorId:user.id }, [{ role:"user", content:"hello" }]);
    await started;
    await store.expireProjectProviderSettlements("9999-01-01T00:00:00.000Z");
    releaseResponse();

    assert.equal((await pending).message.content, "late success");
    const usage = (await services.policies.getUsageOverview(user.id, project.id)).usage;
    assert.deepEqual({ requests:usage.providerRequests, tokens:usage.providerTokens, cost:usage.providerCost }, { requests:1, tokens:2, cost:0.5 });
  });

  it("keeps endpoint rolling windows scoped to each user", async () => {
    const store=createInMemoryProductStore();
    const services=createApplicationServices({store,dataRoot:"/tmp/agentsmith-user-window",builtinAdminPassword:"admin-password"});
    const {user}=await services.auth.loginAfterBootstrap("admin-password");
    const workspace=await services.workspaces.createWorkspace(user.id,{name:"W"});
    const project=await services.workspaces.createProject(user.id,workspace.id,{name:"P"});
    const endpoint=endpointRecord(project.id);
    const teammate=await services.auth.loginExternalPrincipal({issuer:"https://idp.test",subject:"window-teammate",email:"window-teammate@example.test",emailVerified:true});
    await store.createEndpoint(endpoint);
    await services.policies.updatePolicy(user.id,project.id,{endpointWindows:[{endpointId:endpoint.id,metric:"providerRequests",limit:1,windowSeconds:3600}]});

    await services.policies.reserveProvider(project.id,user.id,endpoint.id);
    await assert.rejects(()=>services.policies.reserveProvider(project.id,user.id,endpoint.id),/provider requests limit reached/i);
    await services.policies.reserveProvider(project.id,teammate.user.id,endpoint.id);
  });

  it("patches nullable limits without replacing concurrent policy fields", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/agentsmith-policy-patch", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });

    await Promise.all([
      services.policies.updatePolicy(user.id, project.id, { providerRequestsLimit: 12 }),
      services.policies.updatePolicy(user.id, project.id, { providerTokensLimit: null, providerCostLimit: 4 })
    ]);

    const policy = await services.policies.getPolicy(user.id, project.id);
    assert.equal(policy.providerRequestsLimit, 12);
    assert.equal(policy.providerTokensLimit, null);
    assert.equal(policy.providerCostLimit, 4);
  });

  it("records rejected policy patches without changing the validation result", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-policy-rejected", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });

    await assert.rejects(() => services.policies.updatePolicy(user.id, project.id, {}), /requires at least one limit/);

    assert.deepEqual((await store.listProjectAuditEvents(project.id)).map((event) => [event.action, event.resourceKind, event.resourceId, event.status]), [
      ["policy.update", "project", project.id, "rejected"]
    ]);
  });

  it("projects audit actor identity from one membership read with an id fallback", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-audit-actors", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    await services.profile.updateProfile(user.id, { displayName: "Policy Owner" });
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    await services.policies.updatePolicy(user.id, project.id, { providerRequestsLimit: 4 });
    await store.appendProjectAuditEvent({ id: "removed_actor", projectId: project.id, actorId: "former_user", action: "task.failed", status: "accepted", resourceKind: "task", resourceId: "task_1", createdAt: new Date().toISOString() });
    const original = store.listProjectMemberships.bind(store);
    let membershipReads = 0;
    store.listProjectMemberships = async (id) => { membershipReads += 1; return original(id); };

    const events = await services.policies.audit(user.id, project.id);
    assert.equal(membershipReads, 1);
    assert.deepEqual(events.map((event) => [event.actorId, event.actorDisplayName, event.actorEmail]), [["former_user", null, null],[user.id, "Policy Owner", user.email]]);
  });
});

async function sendThreadMessage(services: ReturnType<typeof createApplicationServices>, userId: string, projectId: string, endpointId: string, content: string) {
  const thread = await services.chat.createThread(userId, projectId, endpointId);
  return services.chat.sendMessage(userId, projectId, thread.id, content);
}

function endpointRecord(projectId: string): ModelEndpoint {
  const timestamp = new Date().toISOString();
  return { id:"endpoint-unknown", projectId, name:"Endpoint", protocol:"openai_chat_completions", baseUrl:"https://models.example.test/v1", model:"model", credentialId:"", capabilities:["text"], requestTimeoutSecs:30, createdAt:timestamp, updatedAt:timestamp };
}
