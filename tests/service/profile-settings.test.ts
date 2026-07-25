import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

    const initialProfile = await services.profile.getProfile(owner.user.id);
    const profile = await services.profile.updateProfile(owner.user.id, { displayName: "Owner", timezone: "UTC", expectedUpdatedAt: initialProfile.preferences.updatedAt });
    assert.equal(profile.user.email, "owner@example.test");
    assert.equal(profile.user.pictureUrl, "https://idp.test/owner.png");
    assert.equal("oidcIssuer" in profile.user, false);
    assert.equal("oidcSubject" in profile.user, false);
    assert.deepEqual(profile.preferences.displayName, "Owner");
    assert.equal((await services.settings.updateWorkspace(owner.user.id, workspace.id, { name: "New workspace", expectedName: workspace.name })).workspace.name, "New workspace");
    assert.equal((await services.settings.updateProject(admin.user.id, project.id, { name: "New project", expectedName: project.name })).project.name, "New project");
    await assert.rejects(() => services.settings.updateWorkspace(admin.user.id, workspace.id, { name: "No", expectedName: "New workspace" }), (error: unknown) => error instanceof ProductError && error.statusCode === 403);
  });

  it("reports invalid profile fields as client errors", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/asl-profile-validation", builtinAdminPassword: "admin-password" });
    const user = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "profile-validation", email: "profile-validation@example.test", emailVerified: true });
    const expectedUpdatedAt = (await services.profile.getProfile(user.user.id)).preferences.updatedAt;

    await assert.rejects(
      () => services.profile.updateProfile(user.user.id, { displayName: "x".repeat(121), expectedUpdatedAt }),
      (error: unknown) => error instanceof ProductError && error.statusCode === 400 && error.message.includes("120 characters or less")
    );
    await assert.rejects(
      () => services.profile.updateProfile(user.user.id, { interests: ["x".repeat(61)], expectedUpdatedAt }),
      (error: unknown) => error instanceof ProductError && error.statusCode === 400
    );
    const saved = await services.profile.updateProfile(user.user.id, { greetingPreference: "professional", expectedUpdatedAt });
    assert.equal(saved.preferences.greetingPreference, "professional");
    await assert.rejects(
      () => services.profile.updateProfile(user.user.id, { greetingPreference: "concise", expectedUpdatedAt: saved.preferences.updatedAt }),
      (error: unknown) => error instanceof ProductError && error.statusCode === 400 && error.message === "profile.greetingPreference is invalid"
    );
  });

  it("rejects a stale profile form without overwriting newer preferences", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/asl-profile-conflict", builtinAdminPassword: "admin-password" });
    const user = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "profile-conflict", email: "profile-conflict@example.test", emailVerified: true });
    const initial = await services.profile.getProfile(user.user.id);
    const first = await services.profile.updateProfile(user.user.id, { displayName: "First", expectedUpdatedAt: initial.preferences.updatedAt });

    await assert.rejects(
      () => services.profile.updateProfile(user.user.id, { displayName: "Stale", expectedUpdatedAt: initial.preferences.updatedAt }),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409 && error.message === "Profile changed elsewhere. Reload and try again."
    );
    assert.equal((await services.profile.getProfile(user.user.id)).preferences.displayName, first.preferences.displayName);
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
      canCreateTasks: false
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
    store.updateProjectName = async (projectId, name, updatedAt, expectedName) => {
      await store.transferProjectOwner(projectId, owner.user.id, successor.user.id, updatedAt);
      await store.patchProjectResourcePolicy(projectId, { activeTasksLimit: 7 }, updatedAt);
      return updateProjectName(projectId, name, updatedAt, expectedName);
    };
    const savedProject = (await services.settings.updateProject(owner.user.id, project.id, { name: "Renamed project", expectedName: project.name })).project;
    assert.deepEqual({ name: savedProject.name, ownerUserId: savedProject.ownerUserId, taskConcurrencyLimit: savedProject.taskConcurrencyLimit }, { name: "Renamed project", ownerUserId: successor.user.id, taskConcurrencyLimit: 7 });

    const updateWorkspaceName = store.updateWorkspaceName.bind(store);
    store.updateWorkspaceName = async (workspaceId, name, updatedAt, expectedName) => {
      await store.transferWorkspaceOwner(workspaceId, owner.user.id, successor.user.id, updatedAt);
      return updateWorkspaceName(workspaceId, name, updatedAt, expectedName);
    };
    const savedWorkspace = (await services.settings.updateWorkspace(owner.user.id, workspace.id, { name: "Renamed workspace", expectedName: workspace.name })).workspace;
    assert.deepEqual({ name: savedWorkspace.name, ownerUserId: savedWorkspace.ownerUserId }, { name: "Renamed workspace", ownerUserId: successor.user.id });
  });

  it("rejects stale workspace and project rename forms", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/asl-settings-conflict", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "settings-conflict", email: "settings-conflict@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });

    await services.settings.updateWorkspace(owner.user.id, workspace.id, { name: "Workspace one", expectedName: workspace.name });
    await assert.rejects(
      () => services.settings.updateWorkspace(owner.user.id, workspace.id, { name: "Workspace stale", expectedName: workspace.name }),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409 && error.message === "Workspace changed elsewhere. Reload and try again."
    );
    await services.settings.updateProject(owner.user.id, project.id, { name: "Project one", expectedName: project.name });
    await assert.rejects(
      () => services.settings.updateProject(owner.user.id, project.id, { name: "Project stale", expectedName: project.name }),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409 && error.message === "Project changed elsewhere. Reload and try again."
    );
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
    assert.deepEqual(((await store.queryProjectAuditEvents(project.id,{limit:100})).items).map(({ action, status, detail }) => ({ action, status, detail })), [{ action: "project.archive", status: "accepted", detail: {} }]);
    await services.settings.runIdempotentMutation(owner.user.id, project.id, "project.settings.update", "settings-key", { name: "One" }, project.id, async () => ({ updated: true }));
    await assert.rejects(() => services.settings.runIdempotentMutation(owner.user.id, project.id, "project.settings.update", "settings-key", { name: "Two" }, project.id, async () => ({ updated: true })), (error: unknown) => error instanceof ProductError && error.statusCode === 409);
  });

  it("identifies an idempotent mutation that is still running", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/asl", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "running-owner", email: "running-owner@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    let finish!: () => void;
    const running = services.settings.runIdempotentMutation(owner.user.id, project.id, "project.settings.update", "running-settings-key", { name: "One" }, project.id, async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { updated: true };
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(
      () => services.settings.runIdempotentMutation(owner.user.id, project.id, "project.settings.update", "running-settings-key", { name: "One" }, project.id, async () => ({ updated: true })),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409 && error.code === "idempotency_in_progress"
    );
    finish();
    await running;
  });

  it("reuses the original resource identity when reclaiming an expired mutation", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/asl", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "reclaim-owner", email: "reclaim-owner@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    const request = { name: "Recovered" };
    await store.beginTaskIdempotency({
      actorId: owner.user.id,
      projectId: project.id,
      operation: "project.settings.update",
      key: "expired-resource-key",
      requestHash: createHash("sha256").update(JSON.stringify(request)).digest("base64url"),
      resourceId: "original-resource",
      claimToken: "expired-claim",
      now: "2026-01-01T00:00:00.000Z",
      leaseExpiresAt: "2026-01-01T00:00:01.000Z"
    });
    let observedResourceId: string | undefined;
    const action = async (resourceId: string) => {
      observedResourceId = resourceId;
      return { resourceId };
    };

    const result = await services.settings.runIdempotentMutation(owner.user.id, project.id, "project.settings.update", "expired-resource-key", request, "new-resource", action);

    assert.equal(observedResourceId, "original-resource");
    assert.deepEqual(result, { resourceId: "original-resource" });
  });

  it("reauthorizes settings before replaying a completed response", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/asl", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "settings-owner", email: "settings-owner@example.test", emailVerified: true });
    const admin = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "settings-admin", email: "settings-admin@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: admin.user.email }, "admin");
    await services.memberships.addMember(owner.user.id, project.id, admin.user.id, "admin");
    const update = () => services.settings.runIdempotentMutation(admin.user.id, project.id, "project.settings.update", "admin-settings-key", { name: "Renamed", expectedName: "Project" }, project.id, () => services.settings.updateProject(admin.user.id, project.id, { name: "Renamed", expectedName: "Project" }));

    await update();
    const adminMembership = (await services.memberships.listMembers(owner.user.id, project.id)).items.find((member) => member.userId === admin.user.id)!;
    await services.memberships.changeMember(owner.user.id, project.id, admin.user.id, "member", adminMembership.updatedAt);
    await assert.rejects(update, (error: unknown) => error instanceof ProductError && error.statusCode === 403);
  });

  it("allows the former owner to confirm a transfer until their admin access is revoked", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/tmp/asl", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "transfer-owner", email: "transfer-owner@example.test", emailVerified: true });
    const successor = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "transfer-successor", email: "transfer-successor@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: successor.user.email }, "admin");
    await services.memberships.addMember(owner.user.id, project.id, successor.user.id, "admin");
    const transfer = () => services.settings.runIdempotentMutation(owner.user.id, project.id, "project.owner.transfer", "owner-transfer-key", { projectId: project.id, userId: successor.user.id }, project.id, async () => {
      await services.memberships.transferOwner(owner.user.id, project.id, successor.user.id);
      return { transferred: true as const };
    });

    const first = await transfer();
    assert.deepEqual(await transfer(), first);
    const formerOwnerMembership = (await services.memberships.listMembers(successor.user.id, project.id)).items.find((member) => member.userId === owner.user.id)!;
    await services.memberships.changeMember(successor.user.id, project.id, owner.user.id, "member", formerOwnerMembership.updatedAt);
    await assert.rejects(transfer, (error: unknown) => error instanceof ProductError && error.statusCode === 403);
  });
});
