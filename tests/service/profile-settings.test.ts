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
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: admin.user.email }, "member");
    await services.memberships.addMember(owner.user.id, project.id, admin.user.id, "admin");

    const profile = await services.profile.updateProfile(owner.user.id, { displayName: "Owner", timezone: "UTC" });
    assert.equal(profile.user.email, "owner@example.test");
    assert.equal(profile.user.pictureUrl, "https://idp.test/owner.png");
    assert.equal("oidcIssuer" in profile.user, false);
    assert.equal("oidcSubject" in profile.user, false);
    assert.deepEqual(profile.preferences.displayName, "Owner");
    assert.equal((await services.settings.updateWorkspace(owner.user.id, workspace.id, { name: "New workspace" })).workspace.name, "New workspace");
    assert.equal((await services.settings.updateProject(admin.user.id, project.id, { name: "New project" })).project.name, "New project");
    await assert.rejects(() => services.settings.updateWorkspace(admin.user.id, workspace.id, { name: "No" }), (error: unknown) => error instanceof ProductError && error.statusCode === 403);
  });

  it("reports invalid profile fields as client errors", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/asl-profile-validation", builtinAdminPassword: "admin-password" });
    const user = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "profile-validation", email: "profile-validation@example.test", emailVerified: true });

    await assert.rejects(
      () => services.profile.updateProfile(user.user.id, { displayName: "x".repeat(121) }),
      (error: unknown) => error instanceof ProductError && error.statusCode === 400 && error.message.includes("120 characters or less")
    );
    await assert.rejects(
      () => services.profile.updateProfile(user.user.id, { interests: ["x".repeat(61)] }),
      (error: unknown) => error instanceof ProductError && error.statusCode === 400
    );
  });

  it("keeps archived workspace projects readable but rejects every project write capability", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/asl-archived-workspace", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "owner-archived", email: "owner-archived@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });

    await services.settings.archiveWorkspace(owner.user.id, workspace.id);

    assert.equal((await services.workspaces.requireProjectForUser(owner.user.id, project.id, "view")).id, project.id);
    await assert.rejects(() => services.workspaces.requireProjectForUser(owner.user.id, project.id, "write"), /Workspace is archived/);
    assert.deepEqual(await services.workspaces.projectCapabilities(owner.user.id, project.id), {
      canManageEndpoints: false,
      canManageMembers: false,
      canManagePolicy: false,
      canWriteFiles: false,
      canCreateTasks: false,
      canCancelTasks: false,
      canSendChat: false
    });
    assert.equal((await services.settings.project(owner.user.id, project.id)).capabilities.canManageSettings, false);
  });

  it("updates names without reverting concurrent ownership or policy changes", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/asl-focused-settings", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "settings-owner", email: "settings-owner@example.test", emailVerified: true });
    const successor = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "settings-successor", email: "settings-successor@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project", taskConcurrencyLimit: 2 });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: successor.user.email }, "admin");
    await services.memberships.addMember(owner.user.id, project.id, successor.user.id, "admin");

    const updateProjectName = store.updateProjectName.bind(store);
    store.updateProjectName = async (projectId, name, updatedAt) => {
      await store.transferProjectOwner(projectId, owner.user.id, successor.user.id, updatedAt);
      await store.patchProjectResourcePolicy(projectId, { activeTasksLimit: 7 }, updatedAt);
      return updateProjectName(projectId, name, updatedAt);
    };
    const savedProject = (await services.settings.updateProject(owner.user.id, project.id, { name: "Renamed project" })).project;
    assert.deepEqual({ name: savedProject.name, ownerUserId: savedProject.ownerUserId, taskConcurrencyLimit: savedProject.taskConcurrencyLimit }, { name: "Renamed project", ownerUserId: successor.user.id, taskConcurrencyLimit: 7 });

    const updateWorkspaceName = store.updateWorkspaceName.bind(store);
    store.updateWorkspaceName = async (workspaceId, name, updatedAt) => {
      await store.transferWorkspaceOwner(workspaceId, owner.user.id, successor.user.id, updatedAt);
      return updateWorkspaceName(workspaceId, name, updatedAt);
    };
    const savedWorkspace = (await services.settings.updateWorkspace(owner.user.id, workspace.id, { name: "Renamed workspace" })).workspace;
    assert.deepEqual({ name: savedWorkspace.name, ownerUserId: savedWorkspace.ownerUserId }, { name: "Renamed workspace", ownerUserId: successor.user.id });
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
