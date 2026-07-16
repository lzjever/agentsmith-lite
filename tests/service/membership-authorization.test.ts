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

    assert.equal((await store.findProjectMembership(project.id, owner.user.id))?.role, "owner");
    assert.equal((await services.authorization.requireProject(owner.user.id, project.id, "admin")).id, project.id);

    await assert.rejects(
      () => services.authorization.requireProject(member.user.id, project.id),
      (error: unknown) => error instanceof ProductError && error.statusCode === 403
    );

    await assert.rejects(
      () => services.memberships.addMember(owner.user.id, project.id, { email: "member@example.test" }, "member"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409
    );
    assert.equal(await store.findProjectMembership(project.id, member.user.id), null);
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: "member@example.test" }, "member");
    await services.memberships.addMember(owner.user.id, project.id, { email: "member@example.test" }, "member");
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: "viewer@example.test" }, "viewer");
    await services.memberships.addMember(owner.user.id, project.id, { issuer, subject: "viewer" }, "viewer");
    await services.memberships.changeMember(owner.user.id, project.id, member.user.id, "viewer");
    await services.memberships.removeMember(owner.user.id, project.id, viewer.user.id);

    assert.deepEqual((await store.listProjectAuditEvents(project.id)).map((event) => [event.action, event.actorId, event.resourceId, event.status]), [
      ["membership.add", owner.user.id, member.user.id, "rejected"],
      ["membership.add", owner.user.id, member.user.id, "accepted"],
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
    await assert.rejects(
      () => services.memberships.changeMember(owner.user.id, project.id, owner.user.id, "admin"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409
    );
    await assert.rejects(
      () => services.memberships.removeMember(owner.user.id, project.id, owner.user.id),
      (error: unknown) => error instanceof ProductError && error.statusCode === 409
    );
    assert.deepEqual((await store.listProjectAuditEvents(project.id)).slice(-2).map((event) => [event.action, event.resourceId, event.status]), [
      ["membership.change", owner.user.id, "rejected"],
      ["membership.remove", owner.user.id, "rejected"]
    ]);
  });

  it("resolves only existing verified identities and keeps missing resources distinct", async () => {
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
      () => services.memberships.addMember(owner.user.id, project.id, { email: "legacy@example.test" }, "viewer"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 404
    );
    await assert.rejects(
      () => services.memberships.addMember(owner.user.id, project.id, { email: "missing@example.test" }, "viewer"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 404
    );
    assert.deepEqual((await store.listProjectAuditEvents(project.id)).map((event) => [event.action, event.resourceId, event.status]), [
      ["membership.add", null, "rejected"],
      ["membership.add", null, "rejected"]
    ]);
    await assert.rejects(
      () => services.authorization.requireProject(owner.user.id, "proj_missing"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 404
    );
  });
});
