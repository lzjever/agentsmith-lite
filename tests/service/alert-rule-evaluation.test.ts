import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";

describe("alert rule evaluation", () => {
  it("opens and recovers a task gauge rule as active task usage changes", async () => {
    const { services, owner, project } = await setup("task-gauge");
    const rule = await services.alertRules.create(owner.id, project.id, {
      name: "One active task",
      alertType: "active_tasks_limit",
      threshold: 1,
    });

    await services.policies.reserveTask(project.id, owner.id, "task_1");
    const active = (await services.policies.alerts(owner.id, project.id)).find(
      (alert) => alert.ruleId === rule.id && alert.status === "active",
    );
    assert.equal(active?.metricValue, 1);

    await services.policies.releaseTask(project.id, "task_1");
    const recovered = (await services.policies.alerts(owner.id, project.id)).find(
      (alert) => alert.id === active?.id,
    );
    assert.equal(recovered?.status, "resolved");
  });

  it("opens and recovers a file gauge rule as project storage changes", async () => {
    const { services, owner, project } = await setup("file-gauge");
    const rule = await services.alertRules.create(owner.id, project.id, {
      name: "Ten bytes",
      alertType: "project_file_bytes_limit",
      threshold: 10,
    });

    await services.policies.recordFileBytes(project.id, owner.id, "notes.txt", 10);
    const active = (await services.policies.alerts(owner.id, project.id)).find(
      (alert) => alert.ruleId === rule.id && alert.status === "active",
    );
    assert.equal(active?.metricValue, 10);

    await services.policies.recordFileBytes(project.id, owner.id, "notes.txt", -10);
    assert.equal(
      (await services.policies.alerts(owner.id, project.id)).find((alert) => alert.id === active?.id)?.status,
      "resolved",
    );
  });

  it("evaluates settled provider requests, tokens, and cost without waiting for a hard quota rejection", async () => {
    const { services, owner, project } = await setup("provider-usage");
    const rules = await Promise.all([
      services.alertRules.create(owner.id, project.id, { name: "One request", alertType: "provider_requests_limit", threshold: 1, windowSeconds: 3600 }),
      services.alertRules.create(owner.id, project.id, { name: "Seven tokens", alertType: "provider_tokens_limit", threshold: 7, windowSeconds: 3600 }),
      services.alertRules.create(owner.id, project.id, { name: "Half a dollar", alertType: "provider_cost_limit", threshold: 0.5, windowSeconds: 3600 }),
    ]);

    const settlementId = await services.policies.reserveProvider(project.id, owner.id, null, null, { tokens: 8, cost: 1 });
    await services.policies.markProviderDispatched(settlementId);
    await services.policies.markProviderDelivered(settlementId);
    await services.policies.settleProvider(settlementId, { tokens: 7, cost: 0.5 });

    const activeRuleIds = new Set(
      (await services.policies.alerts(owner.id, project.id))
        .filter((alert) => alert.status === "active")
        .map((alert) => alert.ruleId),
    );
    assert.deepEqual(activeRuleIds, new Set(rules.map((rule) => rule.id)));
  });

  it("evaluates a new rule immediately and resolves its old instance when the type changes", async () => {
    const { services, owner, project } = await setup("rule-change");
    await services.policies.reserveTask(project.id, owner.id, "task_1");
    const rule = await services.alertRules.create(owner.id, project.id, {
      name: "Current task",
      alertType: "active_tasks_limit",
      threshold: 1,
    });
    const oldAlert = (await services.policies.alerts(owner.id, project.id)).find(
      (alert) => alert.ruleId === rule.id && alert.type === "active_tasks_limit" && alert.status === "active",
    );
    assert.ok(oldAlert);

    await services.alertRules.update(owner.id, project.id, rule.id, {
      alertType: "project_file_bytes_limit",
      threshold: 0,
    });
    const alerts = await services.policies.alerts(owner.id, project.id);
    assert.equal(alerts.find((alert) => alert.id === oldAlert.id)?.status, "resolved");
    const replacement = alerts.find((alert) => alert.ruleId === rule.id && alert.type === "project_file_bytes_limit" && alert.status === "active");
    assert.ok(replacement);

    await services.alertRules.remove(owner.id, project.id, rule.id);
    assert.equal(
      (await services.policies.alerts(owner.id, project.id)).find((alert) => alert.id === replacement.id)?.status,
      "resolved",
    );
  });

  it("rejects endpoint scope for project-only gauges", async () => {
    const { services, owner, project } = await setup("invalid-gauge-scope");
    await assert.rejects(
      () => services.alertRules.create(owner.id, project.id, {
        alertType: "active_tasks_limit",
        scope: { kind: "endpoint", endpointId: "endpoint_1" },
      }),
      /only supports project scope/,
    );
  });
});

async function setup(subject: string) {
  const store = createLocalInMemoryProductStore();
  const services = createApplicationServices({ store, dataRoot: `/tmp/asl-alert-${subject}`, builtinAdminPassword: "admin-password" });
  const { user: owner } = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject, email: `${subject}@example.test`, emailVerified: true });
  const workspace = await services.workspaces.createWorkspace(owner.id, { name: "Workspace" });
  const project = await services.workspaces.createProject(owner.id, workspace.id, { name: "Project" });
  return { store, services, owner, workspace, project };
}
