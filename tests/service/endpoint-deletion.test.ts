import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { CreateEndpointInput } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import type { OpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

describe("endpoint deletion", () => {
  it("keeps provider settlements while clearing their deleted endpoint binding", async () => {
    const { services, store, userId, projectId, credentialId } = await setup();
    const endpoint = await services.endpoints.createEndpoint(userId, projectId, endpointInput("Historical", credentialId));
    const timestamp = "2026-07-12T12:00:00.000Z";
    assert.ok(await store.reserveProjectProviderSettlement({
      id: "settlement_endpoint_history",
      projectId,
      taskId: null,
      endpointId: endpoint.id,
      reservedTokens: 0,
      reservedCost: 0,
      reservedAt: timestamp,
      expiresAt: "2026-07-12T12:01:00.000Z"
    }));
    await store.markProjectProviderSettlementDispatched("settlement_endpoint_history", timestamp);
    await store.markProjectProviderSettlementDelivered("settlement_endpoint_history", timestamp);
    await store.settleProjectProviderSettlement("settlement_endpoint_history", { tokens: 7, cost: 0.01 }, timestamp);
    await store.upsertActiveProjectAlert({ id: "alert_endpoint_history_generic", projectId, type: "endpoint_failure", status: "active", deliveryStatus: "not_configured", endpointId: null, createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });
    const scopedRule = await store.createProjectAlertRule({ id: "rule_endpoint_history_scoped", projectId, name: "Endpoint failure", alertType: "endpoint_failure", metric: "failure_count", condition: "greater_than_or_equal", threshold: 1, windowSeconds: 3600, scope: { kind: "endpoint", endpointId: endpoint.id }, enabled: true, createdAt: timestamp, updatedAt: timestamp });
    await store.upsertActiveProjectAlert({ id: "alert_endpoint_history_scoped", projectId, type: "endpoint_failure", status: "active", deliveryStatus: "not_configured", ruleId: scopedRule.id, endpointId: endpoint.id, createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });

    await services.endpoints.deleteEndpoint(userId, projectId, endpoint.id);

    assert.equal(await store.findEndpoint(endpoint.id), null);
    assert.equal((await store.listSettledProjectProviderSettlements(projectId, "2026-07-01T00:00:00.000Z")).find((item) => item.id === "settlement_endpoint_history")?.endpointId, null);
    assert.equal((await store.listProjectAlertRules(projectId)).some((rule) => rule.id === scopedRule.id), false);
    const alerts = await store.listProjectAlerts(projectId);
    assert.equal(alerts.find((alert) => alert.id === "alert_endpoint_history_generic")?.status, "active");
    assert.deepEqual(
      alerts.filter((alert) => alert.id === "alert_endpoint_history_scoped").map((alert) => [alert.status, alert.ruleId, alert.endpointId, Boolean(alert.resolvedAt)]),
      [["resolved", null, null, true]]
    );
  });

  it("returns a 409 product conflict without unlinking anything when a task references the endpoint", async () => {
    const { services, store, userId, projectId, credentialId } = await setup();
    const endpoint = await services.endpoints.createEndpoint(userId, projectId, endpointInput("Task endpoint", credentialId));
    const timestamp = "2026-07-12T12:00:00.000Z";
    const task = await services.tasks.createTask(userId, projectId, {
      prompt: "Keep endpoint",
      endpointId: endpoint.id,
      fileLibrary: { mode: "create_new", name: "Endpoint reference" }
    });

    await assert.rejects(
      () => services.endpoints.deleteEndpoint(userId, projectId, endpoint.id),
      (error: unknown) => isConflict(error, "Endpoint cannot be deleted while tasks reference it")
    );

    assert.equal((await store.findEndpoint(endpoint.id))?.id, endpoint.id);

    await services.tasks.deleteTask(userId, task.id);
    await services.endpoints.deleteEndpoint(userId, projectId, endpoint.id);
    assert.equal(await store.findEndpoint(endpoint.id), null);
  });

  it("replays a successful deletion without returning not found or duplicating audit", async () => {
    const { services, store, userId, projectId, credentialId } = await setup();
    const endpoint = await services.endpoints.createEndpoint(userId, projectId, endpointInput("Replay deletion", credentialId));

    await services.endpoints.deleteEndpoint(userId, projectId, endpoint.id, "endpoint-delete-key");
    await services.endpoints.deleteEndpoint(userId, projectId, endpoint.id, "endpoint-delete-key");

    assert.equal(await store.findEndpoint(endpoint.id), null);
    assert.equal((await store.listProjectAuditEvents(projectId)).filter((event) => event.action === "endpoint.delete" && event.resourceId === endpoint.id).length, 1);
  });
});

async function setup() {
  const store = createLocalInMemoryProductStore();
  const services = createApplicationServices({
    store,
    dataRoot: "/tmp/agentsmith-lite-endpoint-deletion",
    builtinAdminPassword: "admin-password",
    providerClient: healthyProvider
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "Endpoint deletion" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "History" });
  const credential = await services.credentials.create(user.id, project.id, {
    name: "Provider",
    baseUrl: "https://models.example.test/v1",
    secret: "endpoint-deletion-secret"
  });
  return { services, store, userId: user.id, workspaceId: workspace.id, projectId: project.id, credentialId: credential.id };
}

function endpointInput(name: string, credentialId: string): CreateEndpointInput {
  return {
    name,
    protocol: "openai_chat_completions" as const,
    baseUrl: "https://models.example.test/v1",
    model: "model",
    credentialId,
    capabilities: ["text", "tool_calls"],
    requestTimeoutSecs: 30
  };
}

function isConflict(error: unknown, message: string): boolean {
  return error instanceof ProductError && error.statusCode === 409 && error.message === message;
}

const healthyProvider: OpenAICompatibleClient = {
  async validateEndpoint() {
    return { status: "healthy" };
  },
  async completeChat() {
    throw new Error("not used");
  }
};
