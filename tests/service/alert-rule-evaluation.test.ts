import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { evaluateProjectAlertRules, recoverProjectAlerts } from "../../packages/application/src/projectAlertEvaluator.js";

describe("alert rule evaluation", () => {
  it("opens and recovers a file gauge rule as project storage changes", async () => {
    const { services, owner, project } = await setup("file-gauge");
    const rule = await services.alertRules.create(owner.id, project.id, {
      name: "Ten bytes",
      alertType: "project_file_bytes_limit",
      threshold: 10,
    });

    await services.policies.recordFileBytes(project.id, owner.id, "notes.txt", 10);
    const active = (await services.policies.alerts(owner.id, project.id)).items.find(
      (alert) => alert.ruleId === rule.id && alert.status === "active",
    );
    assert.equal(active?.metricValue, 10);

    await services.policies.recordFileBytes(project.id, owner.id, "notes.txt", -10);
    assert.equal(
      (await services.policies.alerts(owner.id, project.id, { view: "history" })).items.find((alert) => alert.id === active?.id)?.status,
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
      (await services.policies.alerts(owner.id, project.id)).items
        .filter((alert) => alert.status === "active")
        .map((alert) => alert.ruleId),
    );
    assert.deepEqual(activeRuleIds, new Set(rules.map((rule) => rule.id)));
  });

  it("rejects endpoint scope for project-only gauges", async () => {
    const { services, owner, project } = await setup("invalid-gauge-scope");
    await assert.rejects(
      () => services.alertRules.create(owner.id, project.id, {
        alertType: "sandbox_capacity",
        scope: { kind: "endpoint", endpointId: "endpoint_1" },
      }),
      /only supports project scope/,
    );
  });

  it("emits Sandbox capacity alerts and notification copy with only public Sandbox vocabulary", async () => {
    const { store, services, owner, project } = await setup("sandbox-capacity-copy");
    const rule = await services.alertRules.create(owner.id, project.id, {
      alertType: "sandbox_capacity",
      threshold: 0,
    });
    assert.equal(rule.name, "Sandbox capacity");

    const alert = (await services.policies.alerts(owner.id, project.id)).items.find((item) => item.ruleId === rule.id);
    assert.equal(alert?.type, "sandbox_capacity");
    assert.equal(alert?.metric, "active_sandboxes");
    const notification = (await store.listUserNotifications(owner.id)).find((item) => item.resourceId === alert?.id);
    assert.equal(notification?.title, "Sandbox capacity reached");
    assert.equal(notification?.body, "Project: Active sandboxes 0 of 0.");
    assert.doesNotMatch(JSON.stringify({ alert, notification }), /activeTasks|active_tasks|Task capacity|Active tasks/);
  });

  it("defaults provider and failure rules to one hour and keeps gauges windowless", async () => {
    const { services, owner, project } = await setup("rule-windows");
    for (const alertType of [
      "provider_requests_limit",
      "provider_tokens_limit",
      "provider_cost_limit",
      "endpoint_failure",
      "provider_failure",
      "sandbox_failure",
    ] as const) {
      const rule = await services.alertRules.create(owner.id, project.id, { alertType });
      assert.equal(rule.windowSeconds, 3600, alertType);
    }
    for (const alertType of ["sandbox_capacity", "project_file_bytes_limit"] as const) {
      const rule = await services.alertRules.create(owner.id, project.id, { alertType });
      assert.equal(rule.windowSeconds, null, alertType);
      await assert.rejects(
        () => services.alertRules.create(owner.id, project.id, { alertType, windowSeconds: 60 }),
        /windowSeconds.*gauge|gauge.*windowSeconds|does not support a window/i,
      );
    }
  });

  it("accepts only 60 through 2592000 seconds for windowed rules", async () => {
    const { services, owner, project } = await setup("rule-window-bounds");
    for (const windowSeconds of [60, 2_592_000]) {
      assert.equal(
        (await services.alertRules.create(owner.id, project.id, {
          alertType: "provider_requests_limit",
          windowSeconds,
        })).windowSeconds,
        windowSeconds,
      );
    }
    for (const windowSeconds of [59, 2_592_001]) {
      await assert.rejects(
        () => services.alertRules.create(owner.id, project.id, {
          alertType: "sandbox_failure",
          windowSeconds,
        }),
        /windowSeconds must be between 60 and 2592000/,
      );
    }
  });

  it("evaluates and recovers only the requested canonical alert type", async () => {
    const { store, services, owner, project } = await setup("targeted-evaluation");
    const sandboxRule = await services.alertRules.create(owner.id, project.id, {
      alertType: "sandbox_failure",
      threshold: 1,
    });
    await services.alertRules.create(owner.id, project.id, {
      alertType: "provider_failure",
      threshold: 1,
    });
    const createdAt = new Date().toISOString();
    await store.appendProjectAuditEvent({ id: "sandbox_target", projectId: project.id, actorId: null, action: "sandbox.failed", status: "accepted", resourceKind: "sandbox", resourceId: "run_target", createdAt });
    await store.appendProjectAuditEvent({ id: "provider_target", projectId: project.id, actorId: owner.id, action: "provider.request", status: "rejected", resourceKind: "provider", resourceId: "request_target", detail: { errorCategory: "upstream" }, createdAt });

    await evaluateProjectAlertRules(store, project.id, "sandbox_failure");
    assert.deepEqual(
      (await store.queryProjectAlerts(project.id,{view:"active",limit:50})).items.map((alert) => alert.type),
      ["sandbox_failure"],
    );
    await evaluateProjectAlertRules(store, project.id, "provider_failure");
    assert.deepEqual(
      new Set((await store.queryProjectAlerts(project.id,{view:"active",limit:50})).items.map((alert) => alert.type)),
      new Set(["sandbox_failure", "provider_failure"]),
    );

    assert.ok(await store.updateProjectAlertRule({
      id: sandboxRule.id,
      projectId: project.id,
      name: "sandbox failure",
      alertType: "sandbox_failure",
      metric: "failure_count",
      condition: "greater_than_or_equal",
      threshold: 1,
      windowSeconds: 3600,
      scope: { kind: "project" },
      enabled: false,
      createdAt: sandboxRule.createdAt,
      updatedAt: new Date(Date.now() + 1).toISOString(),
    }));
    await recoverProjectAlerts(store, project.id, "sandbox_failure", { ruleId: sandboxRule.id });
    const sandboxAlert = (await store.queryProjectAlerts(project.id, { view: "history", limit: 20 })).items.find((alert) => alert.type === "sandbox_failure");
    const providerAlert = (await store.queryProjectAlerts(project.id, { view: "active", limit: 20 })).items.find((alert) => alert.type === "provider_failure");
    assert.equal(sandboxAlert?.status, "resolved");
    assert.equal(providerAlert?.status, "active");
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
