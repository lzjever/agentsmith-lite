import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { ProductError } from "../../packages/domain/src/errors.js";

describe("profile and settings services", () => {
  it("projects OIDC identity as a picture-capable public profile while updating local metadata", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/asl", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "owner", email: "owner@example.test", emailVerified: true, pictureUrl: "https://idp.test/owner.png" });
    const admin = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "admin", email: "admin@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Old workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Old project" });
    await services.memberships.addMember(owner.user.id, project.id, { email: admin.user.email }, "admin");

    const profile = await services.profile.updateProfile(owner.user.id, { displayName: "Owner", timezone: "UTC" });
    assert.equal(profile.user.email, "owner@example.test");
    assert.equal(profile.user.pictureUrl, "https://idp.test/owner.png");
    assert.equal("oidcIssuer" in profile.user, false);
    assert.equal("oidcSubject" in profile.user, false);
    assert.deepEqual(profile.preferences.displayName, "Owner");
    assert.equal((await services.settings.updateWorkspace(owner.user.id, workspace.id, { name: "New workspace" })).workspace.name, "New workspace");
    assert.equal((await services.settings.updateProject(admin.user.id, project.id, { name: "New project", taskConcurrencyLimit: 3 })).project.taskConcurrencyLimit, 3);
    await assert.rejects(() => services.settings.updateWorkspace(admin.user.id, workspace.id, { name: "No" }), (error: unknown) => error instanceof ProductError && error.statusCode === 403);
  });

  it("serializes lifecycle mutations, replays completed responses, and records one safe audit event", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/asl", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "owner", email: "owner@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    let start: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => { start = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = services.settings.runIdempotentProjectLifecycleMutation(owner.user.id, project.id, "project.archive", "archive-key", "project.archive", async () => { start(); await gate; return { lifecycleStatus: "archived" as const }; });
    await started;
    await assert.rejects(() => services.settings.runIdempotentProjectLifecycleMutation(owner.user.id, project.id, "project.archive", "archive-key", "project.archive", async () => ({ lifecycleStatus: "archived" as const })), (error: unknown) => error instanceof ProductError && error.statusCode === 409);
    release();
    const result = await first;
    const replay = await services.settings.runIdempotentProjectLifecycleMutation(owner.user.id, project.id, "project.archive", "archive-key", "project.archive", async () => ({ lifecycleStatus: "archived" as const }));
    assert.deepEqual(replay, result);
    assert.deepEqual((await store.listProjectAuditEvents(project.id)).map(({ action, status, detail }) => ({ action, status, detail })), [{ action: "project.archive", status: "accepted", detail: {} }]);
    await services.settings.runIdempotentMutation(owner.user.id, project.id, "project.settings.update", "settings-key", { name: "One" }, project.id, async () => ({ updated: true }));
    await assert.rejects(() => services.settings.runIdempotentMutation(owner.user.id, project.id, "project.settings.update", "settings-key", { name: "Two" }, project.id, async () => ({ updated: true })), (error: unknown) => error instanceof ProductError && error.statusCode === 409);
  });
});
