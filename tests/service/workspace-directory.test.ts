import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { ProductError } from "../../packages/domain/src/errors.js";

const issuer = "https://keycloak.example.test/realms/agentsmith";

describe("bounded workspace and project directories", () => {
  it("pages accessible workspaces and binds cursors to the actor", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "owner", email: "owner@example.test", emailVerified: true });
    const other = await services.auth.loginExternalPrincipal({ issuer, subject: "other", email: "other@example.test", emailVerified: true });
    const first = await services.workspaces.createWorkspace(owner.user.id, { name: "First" });
    const second = await services.workspaces.createWorkspace(owner.user.id, { name: "Second" });
    await store.upsertWorkspaceMembership({ workspaceId: first.id, userId: other.user.id, role: "viewer", createdAt: first.createdAt, updatedAt: first.updatedAt });
    const expected=[first,second].sort((left,right)=>left.createdAt.localeCompare(right.createdAt)||left.id.localeCompare(right.id));

    const page = await services.workspaces.listWorkspaceDirectory(owner.user.id, { limit: 1 });
    assert.deepEqual(page.items.map((item) => item.id), [expected[0]!.id]);
    assert.ok(page.nextCursor);
    assert.deepEqual((await services.workspaces.listWorkspaceDirectory(owner.user.id, { cursor: page.nextCursor!, limit: 1 })).items.map((item) => item.id), [expected[1]!.id]);
    await assert.rejects(
      () => services.workspaces.listWorkspaceDirectory(other.user.id, { cursor: page.nextCursor!, limit: 1 }),
      invalidCursor("Workspace directory cursor is invalid")
    );
  });

  it("returns an authoritative exact workspace projection with an accessible project count", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "owner", email: "owner@example.test", emailVerified: true });
    const member = await services.auth.loginExternalPrincipal({ issuer, subject: "member", email: "member@example.test", emailVerified: true });
    await store.upsertUserProfilePreferences({ userId: owner.user.id, displayName: "Workspace owner", timezone: null, bio: null, jobTitle: null, company: null, greetingPreference: null, interests: [], updatedAt: "2026-07-24T00:00:00.000Z" }, null);
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Exact" });
    const visible = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Visible" });
    await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Owner only" });
    await store.upsertWorkspaceMembership({ workspaceId: workspace.id, userId: member.user.id, role: "member", createdAt: workspace.createdAt, updatedAt: workspace.updatedAt });
    await store.upsertProjectMembership({ projectId: visible.id, userId: member.user.id, role: "viewer", createdAt: visible.createdAt, updatedAt: visible.updatedAt });

    const detail = await services.workspaces.workspaceDetail(member.user.id, workspace.id);
    assert.equal(detail.workspace.id, workspace.id);
    assert.deepEqual(detail.owner, { displayName: "Workspace owner", email: owner.user.email });
    assert.equal(detail.memberRole, "member");
    assert.deepEqual(detail.capabilities, { canCreateProject: false, canManageMembers: false });
    assert.equal(detail.projectCount, 1);
  });

  it("orders bounded project pages by pin, name, and id and binds the cursor scope", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "owner", email: "owner@example.test", emailVerified: true });
    const other = await services.auth.loginExternalPrincipal({ issuer, subject: "other", email: "other@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Projects" });
    const otherWorkspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Other" });
    const beta = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "beta" });
    const alpha = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Alpha" });
    const alpine = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Alpine" });
    await services.workspaces.setProjectPinned(owner.user.id, beta.id, true);

    const first = await services.workspaces.listProjectDirectory(owner.user.id, workspace.id, { limit: 2 });
    assert.deepEqual(first.items.map((item) => item.id), [beta.id, alpha.id]);
    assert.equal(first.total, 3);
    assert.ok(first.nextCursor);
    assert.deepEqual((await services.workspaces.listProjectDirectory(owner.user.id, workspace.id, { cursor: first.nextCursor!, limit: 2 })).items.map((item) => item.id), [alpine.id]);
    assert.deepEqual((await services.workspaces.listProjectDirectory(owner.user.id, workspace.id, { q: "alp", limit: 20 })).items.map((item) => item.id), [alpha.id, alpine.id]);

    await assert.rejects(
      () => services.workspaces.listProjectDirectory(owner.user.id, otherWorkspace.id, { cursor: first.nextCursor!, limit: 2 }),
      invalidCursor("Project directory cursor is invalid")
    );
    await assert.rejects(
      () => services.workspaces.listProjectDirectory(owner.user.id, workspace.id, { q: "different", cursor: first.nextCursor!, limit: 2 }),
      invalidCursor("Project directory cursor is invalid")
    );
    await assert.rejects(
      () => services.workspaces.listProjectDirectory(other.user.id, workspace.id, { cursor: first.nextCursor!, limit: 2 }),
      (error: unknown) => error instanceof ProductError && error.statusCode === 403
    );
  });

  it("loads an exact project independently from directory page boundaries", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "owner", email: "owner@example.test", emailVerified: true });
    const outsider = await services.auth.loginExternalPrincipal({ issuer, subject: "outsider", email: "outsider@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Exact" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Exact project" });
    await services.workspaces.setProjectPinned(owner.user.id, project.id, true);

    const detail = await services.workspaces.projectDetail(owner.user.id, project.id);
    assert.equal(detail.project.id, project.id);
    assert.ok(detail.project.pinnedAt);
    assert.deepEqual(detail.workspace, { id: workspace.id, name: workspace.name, lifecycleStatus: "active" });
    await assert.rejects(
      () => services.workspaces.projectDetail(outsider.user.id, project.id),
      (error: unknown) => error instanceof ProductError && error.statusCode === 403
    );
  });
});

function invalidCursor(message: string) {
  return (error: unknown) => error instanceof ProductError && error.statusCode === 400 && error.message === message;
}
