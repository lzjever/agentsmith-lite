import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { sanitizeProjectAuditDetail, type ChatResponse, type ModelEndpoint } from "../../packages/contracts/src/api.js";
import type { PersistedAgentTask } from "../../packages/ports/src/store.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import type { OpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

describe("project resource policy", () => {
  it("retains only canonical Library HOME file paths in audit details",()=>{
    assert.equal(sanitizeProjectAuditDetail({filePath:"libraries/library_1/home/notes/result.txt"}).filePath,"libraries/library_1/home/notes/result.txt");
    for(const filePath of ["files/notes/result.txt","notes/result.txt","libraries/library_1/home/../secret","libraries/library_1/workspace/result.txt"]){
      assert.equal(sanitizeProjectAuditDetail({filePath}).filePath,undefined);
    }
  });

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

  it("uses resource policy as the only mutable active-task limit", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-policy-canonical-limit", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P", taskConcurrencyLimit: 2 });

    const policy = await services.policies.updatePolicy(user.id, project.id, { activeTasksLimit: 4 });

    assert.equal(policy.activeTasksLimit, 4);
    assert.equal((await store.findProject(project.id))?.taskConcurrencyLimit, 4);
    await assert.rejects(() => services.policies.updatePolicy(user.id, project.id, { activeTasksLimit: null } as never), /cannot be unlimited/);
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
    await assert.rejects(
      () => services.policies.recordFileBytes(project.id,user.id,"libraries/library_blocked/home/blocked.txt",1),
      (error: unknown) => error instanceof ProductError && error.code === "project_file_bytes_limit_reached"
    );
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

  it("uses measured Library bytes as the sole truth despite artifact metadata", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-file-reconcile", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    await store.patchProjectResourcePolicy(project.id, { projectFileBytesLimit: 5 }, "2026-07-12T00:00:00.000Z");
    const task: PersistedAgentTask = { id: "task_file_reconcile", workspaceId: workspace.id, projectId: project.id, endpointId: "endpoint", fileLibraryId:"library_file_reconcile", title:"Task", prompt: "not audited", currentRunId:null,archivedAt:null,deletedAt:null,createdAt: project.createdAt, updatedAt: project.updatedAt };
    await store.createFileLibrary({id:task.fileLibraryId!,workspaceId:workspace.id,projectId:project.id,name:"Library",rootSubPath:`libraries/${task.fileLibraryId}/home`,createdByUserId:user.id,createdAt:project.createdAt,updatedAt:project.updatedAt});
    assert.equal((await store.createTaskAtomically({task,reserveActive:false})).kind,"created");
    await store.appendTaskArtifacts([{ id: "artifact_file_reconcile", taskId: task.id, fileId: "file_reconcile", name: "result.txt", bytes: 2, mediaType: "text/plain", previewText: null, createdAt: project.createdAt }]);

    await assert.rejects(()=>services.policies.reconcileFileLibraryBytes(project.id,8),/Project file bytes limit reached/);
    assert.equal((await store.findProjectResourceUsage(project.id))?.projectFileBytes,8);
    await services.policies.reconcileFileLibraryBytes(project.id, 3);
    assert.equal((await store.findProjectResourceUsage(project.id))?.projectFileBytes,3);
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

  it("reserves a sandbox completion's declared token budget before provider dispatch", async () => {
    let calls = 0;
    const services = createApplicationServices({
      store: createInMemoryProductStore(), dataRoot: "/tmp/agentsmith-provider-declared-budget", builtinAdminPassword: "admin-password",
      providerClient: {
        async completeChat() { throw new Error("not used"); },
        async rawChatCompletion() { calls += 1; return new Response(JSON.stringify({ choices: [] })); }
      }
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const endpoint = endpointRecord(project.id);
    await services.policies.updatePolicy(user.id, project.id, { providerTokensLimit: 5_000 });

    await assert.rejects(
      () => services.providerBroker.forwardChatCompletion(
        { endpoint, settlementEndpointId: null, apiKey: "secret", actorId: user.id },
        { model: endpoint.model, messages: [{ role: "user", content: "hello" }], max_completion_tokens: 6_000 },
        {},
        async () => ({ value: undefined })
      ),
      (error: unknown) => error instanceof ProductError && error.code === "provider_tokens_limit_reached"
    );
    assert.equal(calls, 0);
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

  it("requires integer endpoint request and token limits", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/tmp/agentsmith-endpoint-window-integers",
      builtinAdminPassword: "admin-password",
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const endpoint = endpointRecord(project.id);
    await store.createEndpoint(endpoint);

    for (const metric of ["providerRequests", "providerTokens"] as const) {
      await assert.rejects(
        () => services.policies.updatePolicy(user.id, project.id, {
          endpointWindows: [{ endpointId: endpoint.id, metric, limit: 1.5, windowSeconds: 3600 }],
        }),
        /count limits must be integers/i,
      );
    }

    const policy = await services.policies.updatePolicy(user.id, project.id, {
      endpointWindows: [{ endpointId: endpoint.id, metric: "providerCost", limit: 1.5, windowSeconds: 3600 }],
    });
    assert.equal(policy.endpointWindows?.[0]?.limit, 1.5);
  });

  it("reports the endpoint rolling metric that rejected a provider reservation", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-endpoint-window-rejection", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const endpoint = endpointRecord(project.id);
    await store.createEndpoint(endpoint);
    await services.policies.updatePolicy(user.id, project.id, {
      endpointWindows: [{ endpointId: endpoint.id, metric: "providerTokens", limit: 4095, windowSeconds: 3600 }]
    });

    await assert.rejects(
      () => services.policies.reserveProvider(project.id, user.id, endpoint.id),
      (error: unknown) => error instanceof ProductError
        && /endpoint rolling provider tokens limit reached/i.test(error.message)
        && error.code === "provider_tokens_limit_reached"
    );
    assert.deepEqual(
      (await services.policies.alerts(user.id, project.id)).filter((alert) => alert.status === "active").map((alert) => [alert.type, alert.endpointId]),
      [["provider_tokens_limit", endpoint.id]]
    );
  });

  it("recovers quota alerts when a policy change restores capacity", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-policy-alert-recovery", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const endpoint = endpointRecord(project.id);
    await store.createEndpoint(endpoint);
    await services.policies.updatePolicy(user.id, project.id, {
      endpointWindows: [{ endpointId: endpoint.id, metric: "providerTokens", limit: 4095, windowSeconds: 3600 }]
    });
    await assert.rejects(() => services.policies.reserveProvider(project.id, user.id, endpoint.id));

    await services.policies.updatePolicy(user.id, project.id, { endpointWindows: [] });

    assert.deepEqual(
      (await services.policies.alerts(user.id, project.id)).filter((alert) => alert.type === "provider_tokens_limit").map((alert) => [alert.type, alert.status]),
      [["provider_tokens_limit", "resolved"]]
    );
  });

  it("patches nullable limits without replacing unrelated policy fields", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/agentsmith-policy-patch", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });

    await services.policies.updatePolicy(user.id, project.id, { providerRequestsLimit: 12 });
    await services.policies.updatePolicy(user.id, project.id, { providerTokensLimit: null, providerCostLimit: 4 });

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

  it("replays policy updates and alert transitions without repeating their audit events", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-policy-mutation-replay", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    const updatePolicy = services.policies.updatePolicy.bind(services.policies) as typeof services.policies.updatePolicy & ((userId: string, projectId: string, input: { providerRequestsLimit: number }, key: string) => ReturnType<typeof services.policies.updatePolicy>);
    const transitionAlert = services.policies.transitionAlert.bind(services.policies) as typeof services.policies.transitionAlert & ((userId: string, projectId: string, alertId: string, status: "resolved", key: string) => ReturnType<typeof services.policies.transitionAlert>);

    const firstPolicy = await updatePolicy(user.id, project.id, { providerRequestsLimit: 4 }, "policy-update-key");
    const replayedPolicy = await updatePolicy(user.id, project.id, { providerRequestsLimit: 4 }, "policy-update-key");
    assert.deepEqual(replayedPolicy, firstPolicy);

    await store.appendProjectAuditEvent({ id: "policy_replay_sandbox_failure", projectId: project.id, actorId: user.id, action: "sandbox.failed", status: "accepted", resourceKind: "sandbox", resourceId: "task_replay", createdAt: new Date().toISOString() });
    await services.alertRules.create(user.id, project.id, { alertType: "sandbox_failure" });
    await services.policies.raiseAlert(project.id, "sandbox_failure");
    const active = (await services.policies.alerts(user.id, project.id)).find((alert) => alert.status === "active");
    assert.ok(active);
    const resolved = await transitionAlert(user.id, project.id, active.id, "resolved", "alert-resolve-key");
    const replayed = await transitionAlert(user.id, project.id, active.id, "resolved", "alert-resolve-key");
    assert.deepEqual(replayed, resolved);

    const events = await store.listProjectAuditEvents(project.id);
    assert.equal(events.filter((event) => event.action === "policy.update").length, 1);
    assert.equal(events.filter((event) => event.action === "alert.resolve").length, 1);
  });

  it("retains audit actor identity after the actor is no longer a project member", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-audit-actors", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const former = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "former-auditor", email: "former@example.test", emailVerified: true });
    await services.profile.updateProfile(user.id, { displayName: "Policy Owner", expectedUpdatedAt: (await services.profile.getProfile(user.id)).preferences.updatedAt });
    await services.profile.updateProfile(former.user.id, { displayName: "Former Member", expectedUpdatedAt: (await services.profile.getProfile(former.user.id)).preferences.updatedAt });
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    await services.policies.updatePolicy(user.id, project.id, { providerRequestsLimit: 4 });
    await store.appendProjectAuditEvent({ id: "removed_actor", projectId: project.id, actorId: former.user.id, action: "sandbox.failed", status: "accepted", resourceKind: "sandbox", resourceId: "task_1", createdAt: new Date().toISOString() });
    const original = store.listProjectMemberships.bind(store);
    let membershipReads = 0;
    store.listProjectMemberships = async (id) => { membershipReads += 1; return original(id); };

    const events = await services.policies.audit(user.id, project.id);
    assert.equal(membershipReads, 1);
    assert.deepEqual(events.map((event) => [event.actorId, event.actorDisplayName, event.actorEmail]), [[former.user.id, "Former Member", former.user.email],[user.id, "Policy Owner", user.email]]);
  });

  it("filters an exact audit resource before applying pagination", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-audit-resource", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "W" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "P" });
    for (let index = 0; index < 25; index += 1) {
      await store.appendProjectAuditEvent({ id: `newer_${index}`, projectId: project.id, actorId: null, action: "task.message.create", status: "accepted", resourceKind: "task", resourceId: `task_${index}`, createdAt: new Date(Date.UTC(2026, 6, 12, 0, 0, index + 1)).toISOString() });
    }
    await store.appendProjectAuditEvent({ id: "target", projectId: project.id, actorId: null, action: "alert.resolve", status: "accepted", resourceKind: "alert", resourceId: "alert_target", createdAt: "2026-07-12T00:00:00.000Z" });
    await store.appendProjectAuditEvent({ id: "other_alert", projectId: project.id, actorId: null, action: "alert.resolve", status: "accepted", resourceKind: "alert", resourceId: "alert_other", createdAt: "2026-07-12T00:00:01.000Z" });

    const page = await services.policies.audit(user.id, project.id, { limit: 20, resourceKind: "alert", resourceId: "alert_target" });

    assert.deepEqual(page.items.map((event) => event.id), ["target"]);
    assert.equal(page.nextCursor, null);
  });
});

function endpointRecord(projectId: string): ModelEndpoint {
  const timestamp = new Date().toISOString();
  return { id:"endpoint-unknown", projectId, name:"Endpoint", protocol:"openai_chat_completions", baseUrl:"https://models.example.test/v1", model:"model", credentialId:"", capabilities:["text"], requestTimeoutSecs:30, createdAt:timestamp, updatedAt:timestamp };
}
