import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";

describe("policy alert audit completion", () => {
  it("evaluates scoped thresholds and authorizes acknowledgement and silence", async () => {
    const store = createLocalInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/tmp/asl-policy-alert-completion",
      builtinAdminPassword: "admin-password",
    });
    const owner = await services.auth.loginExternalPrincipal({
      issuer: "https://idp.test",
      subject: "completion-owner",
      email: "completion-owner@example.test",
      emailVerified: true,
    });
    const viewer = await services.auth.loginExternalPrincipal({
      issuer: "https://idp.test",
      subject: "completion-viewer",
      email: "completion-viewer@example.test",
      emailVerified: true,
    });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, {
      name: "Workspace",
    });
    const project = await services.workspaces.createProject(
      owner.user.id,
      workspace.id,
      { name: "Project" },
    );
    const now = new Date().toISOString();
    await store.upsertProjectMembership({
      projectId: project.id,
      userId: viewer.user.id,
      role: "viewer",
      createdAt: now,
      updatedAt: now,
    });
    const rule = await services.alertRules.create(owner.user.id, project.id, {
      name: "Two failures",
      alertType: "task_failure",
      metric: "failure_count",
      threshold: 2,
      windowSeconds: 3600,
      scope: { kind: "project" },
    });
    await store.appendProjectAuditEvent({
      id: "task_failure_1",
      projectId: project.id,
      actorId: owner.user.id,
      action: "task.failed",
      status: "accepted",
      resourceKind: "task",
      resourceId: "task_1",
      createdAt: now,
    });
    await services.policies.raiseAlert(project.id, "task_failure");
    assert.equal(
      (await services.policies.alerts(owner.user.id, project.id)).length,
      0,
    );
    await store.appendProjectAuditEvent({
      id: "task_failure_2",
      projectId: project.id,
      actorId: owner.user.id,
      action: "task.failed",
      status: "accepted",
      resourceKind: "task",
      resourceId: "task_2",
      createdAt: now,
    });
    await services.policies.raiseAlert(project.id, "task_failure");
    const tested = await services.alertRules.test(
      owner.user.id,
      project.id,
      rule.id,
    );
    assert.deepEqual([tested.matched, tested.value, tested.threshold], [true, 2, 2]);
    await services.alertRules.update(owner.user.id, project.id, rule.id, {
      threshold: 3,
    });
    const recovered = await services.policies.alerts(owner.user.id, project.id);
    assert.equal(recovered.find((alert) => alert.status === "active"), undefined);
    assert.equal(recovered.find((alert) => alert.status === "resolved")?.threshold, 2);
    await assert.rejects(
      () =>
        services.alertRules.acknowledge(viewer.user.id, project.id, "missing"),
      /access denied/,
    );
    await services.alertRules.update(owner.user.id, project.id, rule.id, {
      threshold: 2,
    });
    await services.policies.raiseAlert(project.id, "task_failure");
    const active = (await services.policies.alerts(owner.user.id, project.id)).find(
      (alert) => alert.status === "active",
    )!;
    const acknowledged = await services.alertRules.acknowledge(
      owner.user.id,
      project.id,
      active.id,
    );
    assert.equal(acknowledged.acknowledgedBy, owner.user.id);
    const until = new Date(Date.now() + 3600000).toISOString();
    const silenced = await services.alertRules.silence(
      owner.user.id,
      project.id,
      active.id,
      until,
    );
    assert.equal(silenced.silencedUntil, until);
    const cleared = await services.alertRules.silence(
      owner.user.id,
      project.id,
      active.id,
      null,
    );
    assert.equal(cleared.silencedUntil, null);
    const actions = (await store.listProjectAuditEvents(project.id)).map(
      (event) => event.action,
    );
    assert.ok(actions.includes("alert.acknowledge"));
    assert.equal(
      actions.filter((action) => action === "alert.silence").length,
      2,
    );
  });

  it("paginates newest first and strips unsafe audit detail", async () => {
    const store = createLocalInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/tmp/asl-audit-completion",
      builtinAdminPassword: "admin-password",
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, {
      name: "Workspace",
    });
    const project = await services.workspaces.createProject(
      user.id,
      workspace.id,
      { name: "Project" },
    );
    for (let index = 0; index < 3; index++)
      await store.appendProjectAuditEvent({
        id: `audit_${index}`,
        projectId: project.id,
        actorId: user.id,
        action: "policy.update",
        status: "accepted",
        resourceKind: "project",
        resourceId: project.id,
        detail: { endpointId: `endpoint_${index}`, prompt: "secret", providerKey: "secret" } as never,
        createdAt: `2026-07-12T00:00:0${index}.000Z`,
      });
    const first = await services.policies.audit(user.id, project.id, {
      limit: 2,
    });
    assert.deepEqual(
      first.items.map((event) => event.id),
      ["audit_2", "audit_1"],
    );
    assert.ok(first.nextCursor);
    assert.deepEqual(first.items[0]!.detail, { endpointId: "endpoint_2" });
    const second = await services.policies.audit(user.id, project.id, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    assert.deepEqual(
      second.items.map((event) => event.id),
      ["audit_0"],
    );
    assert.equal(second.nextCursor, null);
  });

  it("classifies chat thread and message audit resources", async () => {
    const store = createLocalInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/tmp/asl-chat-audit-resources",
      builtinAdminPassword: "admin-password",
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });

    await services.policies.recordOperation(project.id, user.id, "chat.thread.create", "accepted", "chat_1");
    await services.policies.recordOperation(project.id, user.id, "chat.message.send", "accepted", "chatmsg_1");

    const events = await services.policies.audit(user.id, project.id);
    assert.deepEqual(
      events
        .map((event) => [event.action, event.resourceKind, event.resourceId])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
      [
        ["chat.message.send", "chat_message", "chatmsg_1"],
        ["chat.thread.create", "chat_thread", "chat_1"],
      ],
    );
  });
});
