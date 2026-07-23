import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { ProductError } from "../../packages/domain/src/errors.js";

const conflict = (error: unknown) => error instanceof ProductError && error.statusCode === 409;

describe("policy write concurrency", () => {
  it("rejects stale project policy and alert rule edits", async () => {
    const store = createLocalInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/asl-policy-write-concurrency", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });

    const policy = await services.policies.getPolicy(user.id, project.id);
    const changedPolicy = await services.policies.updatePolicy(user.id, project.id, { activeTasksLimit: 3, expectedUpdatedAt: policy.updatedAt });
    assert.equal(changedPolicy.activeTasksLimit, 3);
    await assert.rejects(
      () => services.policies.updatePolicy(user.id, project.id, { activeTasksLimit: 4, expectedUpdatedAt: policy.updatedAt }),
      conflict,
    );

    const rule = await services.alertRules.create(user.id, project.id, { alertType: "sandbox_failure" });
    const changedRule = await services.alertRules.update(user.id, project.id, rule.id, { threshold: 2, expectedUpdatedAt: rule.updatedAt });
    assert.equal(changedRule.threshold, 2);
    await assert.rejects(
      () => services.alertRules.update(user.id, project.id, rule.id, { threshold: 3, expectedUpdatedAt: rule.updatedAt }),
      conflict,
    );
  });
});
