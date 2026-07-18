import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { ProductError } from "../../packages/domain/src/errors.js";

const issuer = "https://keycloak.example.test/realms/agentsmith";

describe("project membership authorization", () => {
  it("grants project access only by membership", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password"
    });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "owner", email: "owner@example.test", emailVerified: true });
    const member = await services.auth.loginExternalPrincipal({ issuer, subject: "member", email: "member@example.test", emailVerified: true });
    const viewer = await services.auth.loginExternalPrincipal({ issuer, subject: "viewer", email: "viewer@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    await store.upsertUserProfilePreferences({ userId: member.user.id, displayName: "Member display", timezone: null, bio: null, jobTitle: null, company: null, greetingPreference: null, interests: [], updatedAt: new Date().toISOString() });

    assert.equal((await store.findProjectMembership(project.id, owner.user.id))?.role, "owner");
    assert.equal((await services.authorization.requireProject(owner.user.id, project.id, "admin")).id, project.id);

    await assert.rejects(
      () => services.authorization.requireProject(member.user.id, project.id),
      (error: unknown) => error instanceof ProductError && error.statusCode === 403
    );

    await assert.rejects(
      () => services.memberships.addMember(owner.user.id, project.id, member.user.id, "member"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409
    );
    assert.equal(await store.findProjectMembership(project.id, member.user.id), null);
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: "member@example.test" }, "member");
    const addedMember = await services.memberships.addMember(owner.user.id, project.id, member.user.id, "member");
    assert.deepEqual([addedMember.displayName, addedMember.email, addedMember.role], ["Member display", member.user.email, "member"]);
    await assert.rejects(() => services.memberships.addMember(owner.user.id, project.id, member.user.id, "viewer"), status(409));
    assert.equal((await store.findProjectMembership(project.id, member.user.id))?.role, "member");
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: "viewer@example.test" }, "viewer");
    const addedViewer = await services.memberships.addMember(owner.user.id, project.id, viewer.user.id, "viewer");
    const changedMember = await services.memberships.changeMember(owner.user.id, project.id, member.user.id, "viewer", addedMember.updatedAt);
    assert.deepEqual([changedMember.displayName, changedMember.email, changedMember.role], ["Member display", member.user.email, "viewer"]);
    await store.createUserNotification({ id: "notice_removed_project_viewer", userId: viewer.user.id, type: "project_alert", title: "Project alert", body: "No longer visible", projectId: project.id, resourceKind: "alert", resourceId: "alert_removed_viewer", linkPath: `/projects/${project.id}/alerts`, readAt: null, createdAt: "2026-07-11T00:00:00.000Z" });
    await store.createUserNotification({ id: "notice_retained_project_owner", userId: owner.user.id, type: "project_alert", title: "Owner alert", body: "Still visible", projectId: project.id, resourceKind: "alert", resourceId: "alert_owner", linkPath: `/projects/${project.id}/alerts`, readAt: null, createdAt: "2026-07-11T00:00:00.000Z" });
    await services.memberships.removeMember(owner.user.id, project.id, viewer.user.id, addedViewer.updatedAt);
    assert.deepEqual(await store.listUserNotifications(viewer.user.id), []);
    assert.deepEqual((await store.listUserNotifications(owner.user.id)).map((item) => item.id), ["notice_retained_project_owner"]);
    await store.createUserNotification({ id: "notice_late_after_project_removal", userId: viewer.user.id, type: "project_alert", title: "Late project alert", body: "Must stay hidden", projectId: project.id, resourceKind: "alert", resourceId: "alert_late_viewer", linkPath: `/projects/${project.id}/alerts`, readAt: null, createdAt: "2026-07-11T00:00:01.000Z" });
    assert.deepEqual(await store.listUserNotifications(viewer.user.id), []);
    await assert.rejects(() => services.notifications.markRead(viewer.user.id, "notice_late_after_project_removal"), status(404));
    await services.notifications.markAllRead(viewer.user.id);
    await services.notifications.dismiss(viewer.user.id, "notice_late_after_project_removal");
    const restoredAt = new Date().toISOString();
    await store.upsertProjectMembership({ projectId: project.id, userId: viewer.user.id, role: "viewer", createdAt: restoredAt, updatedAt: restoredAt });
    assert.deepEqual((await store.listUserNotifications(viewer.user.id)).map((item) => [item.id, item.readAt]), [["notice_late_after_project_removal", null]]);
    await store.deleteProjectMembership(project.id, viewer.user.id);

    assert.deepEqual((await store.listProjectAuditEvents(project.id)).map((event) => [event.action, event.actorId, event.resourceId, event.status]), [
      ["membership.add", owner.user.id, member.user.id, "rejected"],
      ["membership.add", owner.user.id, member.user.id, "accepted"],
      ["membership.add", owner.user.id, member.user.id, "rejected"],
      ["membership.add", owner.user.id, viewer.user.id, "accepted"],
      ["membership.change", owner.user.id, member.user.id, "accepted"],
      ["membership.remove", owner.user.id, viewer.user.id, "accepted"]
    ]);

    assert.equal((await services.workspaces.listWorkspaces(owner.user.id))[0]?.capabilities.canCreateProject, true);
    assert.equal((await services.workspaces.listWorkspaces(member.user.id))[0]?.capabilities.canCreateProject, false);

    assert.equal((await services.authorization.requireProject(member.user.id, project.id, "view")).id, project.id);
    await assert.rejects(() => services.authorization.requireProject(member.user.id, project.id, "write"));
    await assert.rejects(() => services.authorization.requireProject(viewer.user.id, project.id, "view"));
    await assert.rejects(
      () => services.authorization.requireProject(viewer.user.id, project.id, "write"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 403
    );
    const currentOwnerMembership = (await store.findProjectMembership(project.id, owner.user.id))!;
    await assert.rejects(
      () => services.memberships.changeMember(owner.user.id, project.id, owner.user.id, "admin", currentOwnerMembership.updatedAt),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409
    );
    await assert.rejects(
      () => services.memberships.removeMember(owner.user.id, project.id, owner.user.id, currentOwnerMembership.updatedAt),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409
    );
    assert.deepEqual((await store.listProjectAuditEvents(project.id)).slice(-2).map((event) => [event.action, event.resourceId, event.status]), [
      ["membership.change", owner.user.id, "rejected"],
      ["membership.remove", owner.user.id, "rejected"]
    ]);

    await services.memberships.transferOwner(owner.user.id, project.id, member.user.id);
    const ownerMembership = (await store.findProjectMembership(project.id, member.user.id))!;
    assert.equal(await store.updateManagedProjectMembershipRole(project.id, member.user.id, "viewer", new Date().toISOString(), ownerMembership.updatedAt), "owner");
    assert.equal(await store.deleteManagedProjectMembership(project.id, member.user.id, ownerMembership.updatedAt), "owner");
    assert.equal((await store.findProjectMembership(project.id, member.user.id))?.role, "owner");
  });

  it("rejects stable IDs that are not workspace members and keeps missing resources distinct", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "owner", email: "owner@example.test", emailVerified: true });
    await store.createUser({
      id: "user_unverified",
      email: "legacy@example.test",
      oidcIssuer: issuer,
      oidcSubject: "legacy",
      emailVerified: false,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });

    await assert.rejects(
      () => services.memberships.addMember(owner.user.id, project.id, "user_unverified", "viewer"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409
    );
    await assert.rejects(
      () => services.memberships.addMember(owner.user.id, project.id, "user_missing", "viewer"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409
    );
    assert.deepEqual((await store.listProjectAuditEvents(project.id)).map((event) => [event.action, event.resourceId, event.status]), [
      ["membership.add", "user_unverified", "rejected"],
      ["membership.add", "user_missing", "rejected"]
    ]);
    await assert.rejects(
      () => services.authorization.requireProject(owner.user.id, "proj_missing"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 404
    );
  });

  it("accepts only one concurrent project membership add", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "concurrent-owner", email: "concurrent-owner@example.test", emailVerified: true });
    const member = await services.auth.loginExternalPrincipal({ issuer, subject: "concurrent-member", email: "concurrent-member@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: member.user.email }, "member");

    const results = await Promise.allSettled([
      services.memberships.addMember(owner.user.id, project.id, member.user.id, "member"),
      services.memberships.addMember(owner.user.id, project.id, member.user.id, "viewer")
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejected?.reason instanceof ProductError);
    assert.equal((rejected.reason as ProductError).statusCode, 409);
  });

  it("replays project membership creation without duplicating its audit event", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "replay-owner", email: "replay-owner@example.test", emailVerified: true });
    const member = await services.auth.loginExternalPrincipal({ issuer, subject: "replay-member", email: "replay-member@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: member.user.email }, "member");
    const add = services.memberships.addMember.bind(services.memberships) as (actor:string,projectId:string,userId:string,role:"member",key:string)=>Promise<{userId:string;updatedAt:string}>;
    const first = await add(owner.user.id, project.id, member.user.id, "member", "project-member-key");
    const replayed = await add(owner.user.id, project.id, member.user.id, "member", "project-member-key");
    assert.equal(replayed.userId, first.userId);
    const change = services.memberships.changeMember.bind(services.memberships) as (actor:string,projectId:string,userId:string,role:"admin",expected:string,key:string)=>Promise<{role:string;updatedAt:string}>;
    const changed = await change(owner.user.id, project.id, member.user.id, "admin", first.updatedAt, "project-member-change-key");
    const replayedChange = await change(owner.user.id, project.id, member.user.id, "admin", first.updatedAt, "project-member-change-key");
    assert.deepEqual(replayedChange, changed);
    const remove = services.memberships.removeMember.bind(services.memberships) as (actor:string,projectId:string,userId:string,expected:string,key:string)=>Promise<void>;
    await remove(owner.user.id, project.id, member.user.id, changed.updatedAt, "project-member-remove-key");
    await remove(owner.user.id, project.id, member.user.id, changed.updatedAt, "project-member-remove-key");
    assert.equal((await store.listProjectAuditEvents(project.id)).filter((event) => event.action === "membership.add" && event.status === "accepted").length, 1);
    assert.equal((await store.listProjectAuditEvents(project.id)).filter((event) => event.action === "membership.change" && event.status === "accepted").length, 1);
    assert.equal((await store.listProjectAuditEvents(project.id)).filter((event) => event.action === "membership.remove" && event.status === "accepted").length, 1);
  });

  it("reauthorizes a project member addition before replaying it", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "reauth-owner", email: "reauth-owner@example.test", emailVerified: true });
    const admin = await services.auth.loginExternalPrincipal({ issuer, subject: "reauth-admin", email: "reauth-admin@example.test", emailVerified: true });
    const member = await services.auth.loginExternalPrincipal({ issuer, subject: "reauth-member", email: "reauth-member@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: admin.user.email }, "admin");
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: member.user.email }, "member");
    await services.memberships.addMember(owner.user.id, project.id, admin.user.id, "admin");
    await services.memberships.addMember(admin.user.id, project.id, member.user.id, "member", "admin-member-add-key");
    const adminMembership = (await store.findProjectMembership(project.id, admin.user.id))!;
    await services.memberships.changeMember(owner.user.id, project.id, admin.user.id, "member", adminMembership.updatedAt);

    await assert.rejects(
      () => services.memberships.addMember(admin.user.id, project.id, member.user.id, "member", "admin-member-add-key"),
      status(403)
    );
    assert.equal((await store.listProjectAuditEvents(project.id)).filter((event) => event.action === "membership.add" && event.actorId === admin.user.id && event.status === "rejected").length, 1);
  });
});

function status(code: number) { return (error: unknown) => error instanceof ProductError && error.statusCode === code; }
