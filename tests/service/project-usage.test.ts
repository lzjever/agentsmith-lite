import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { ModelEndpoint, StoredUser } from "../../packages/contracts/src/api.js";

describe("project usage overview", () => {
  it("uses current policy usage for limits and settled provider data for daily and endpoint aggregates", async () => {
    const store = createLocalInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-usage-overview", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Usage" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Usage project" });
    const endpoints = [endpoint("endpoint_1", project.id, "Primary"), endpoint("endpoint_2", project.id, "Secondary")];
    await Promise.all(endpoints.map((value) => store.createEndpoint(value)));
    await services.policies.updatePolicy(user.id, project.id, { providerRequestsLimit: 5, providerTokensLimit: 100, providerCostLimit: 10 });
    const now = new Date().toISOString();
    await settle(store, "settlement_1", project.id, "endpoint_1", now, { tokens: 7, cost: 1.5 });
    await settle(store, "settlement_2", project.id, "endpoint_2", now, { tokens: 3, cost: 0.5 });
    await store.reserveProjectProviderSettlement({ id: "settlement_reserved", projectId: project.id, taskId: null, endpointId: "endpoint_1", reservedTokens: 0, reservedCost: 0, reservedAt: now, expiresAt: new Date(Date.parse(now) + 60_000).toISOString() });
    assert.deepEqual((await store.listSettledProjectProviderSettlements(project.id, new Date(Date.parse(now) - 60_000).toISOString())).map((settlement) => settlement.id), ["settlement_1", "settlement_2"]);

    const overview = await services.policies.getUsageOverview(user.id, project.id);
    assert.equal(overview.daily.length, 30);
    assert.deepEqual(overview.limits.find((limit) => limit.metric === "activeTasks"), { metric: "activeTasks", current: 0, limit: 2, remaining: 2, window: { kind: "current_gauge", resetAt: null } });
    assert.deepEqual(overview.limits.find((limit) => limit.metric === "providerTokens"), { metric: "providerTokens", current: 10, limit: 100, remaining: 90, window: { kind: "project_lifetime", startedAt: project.createdAt, resetAt: null } });
    assert.deepEqual(overview.endpoints.map((value) => [value.endpointName, value.requests, value.tokens, value.cost]), [["Primary", 1, 7, 1.5], ["Secondary", 1, 3, 0.5]]);

    const selected = await services.policies.getUsageOverview(user.id, project.id, "endpoint_2");
    assert.equal(selected.selectedEndpointId, "endpoint_2");
    assert.deepEqual(selected.daily.reduce((total, day) => ({ requests: total.requests + day.requests, tokens: total.tokens + day.tokens, cost: total.cost + day.cost }), { requests: 0, tokens: 0, cost: 0 }), { requests: 1, tokens: 3, cost: 0.5 });
    await assert.rejects(() => services.policies.getUsageOverview(user.id, project.id, "missing"), /Endpoint not found/);
  });

  it("allows project viewers to read the overview and rejects non-members", async () => {
    const store = createLocalInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-usage-members", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Usage" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Usage project" });
    const viewer = userRecord("viewer", "viewer@example.test"); const outsider = userRecord("outsider", "outsider@example.test");
    await Promise.all([store.createUser(viewer), store.createUser(outsider)]);
    await store.upsertProjectMembership({ projectId: project.id, userId: viewer.id, role: "viewer", createdAt: project.createdAt, updatedAt: project.updatedAt });
    assert.equal((await services.policies.getUsageOverview(viewer.id, project.id)).projectId, project.id);
    await assert.rejects(() => services.policies.getUsageOverview(outsider.id, project.id), /Project access denied/);
  });
});

function endpoint(id: string, projectId: string, name: string): ModelEndpoint { const now = new Date().toISOString(); return { id, projectId, name, protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId: "", capabilities: ["text"], requestTimeoutSecs: 30, createdAt: now, updatedAt: now }; }
async function settle(store: ReturnType<typeof createLocalInMemoryProductStore>, id: string, projectId: string, endpointId: string, time: string, usage: { tokens: number; cost: number }): Promise<void> { await store.reserveProjectProviderSettlement({ id, projectId, taskId: null, endpointId, reservedTokens: 0, reservedCost: 0, reservedAt: time, expiresAt: new Date(Date.parse(time) + 60_000).toISOString() }); await store.markProjectProviderSettlementDispatched(id, time); await store.markProjectProviderSettlementDelivered(id, time); await store.settleProjectProviderSettlement(id, usage, time); }
function userRecord(id: string, email: string): StoredUser { const now = new Date().toISOString(); return { id, email, emailVerified: true, passwordHash: "hash", createdAt: now, updatedAt: now }; }
