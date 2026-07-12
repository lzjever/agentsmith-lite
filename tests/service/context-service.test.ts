import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { ProductError } from "../../packages/domain/src/errors.js";

const issuer = "https://keycloak.example.test/realms/agentsmith";

describe("context service", () => {
  it("enforces all four scope boundaries and validates JSON", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "owner", email: "owner@example.test", emailVerified: true });
    const admin = await services.auth.loginExternalPrincipal({ issuer, subject: "admin", email: "admin@example.test", emailVerified: true });
    const member = await services.auth.loginExternalPrincipal({ issuer, subject: "member", email: "member@example.test", emailVerified: true });
    const viewer = await services.auth.loginExternalPrincipal({ issuer, subject: "viewer", email: "viewer@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: admin.user.email }, "admin");
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: member.user.email }, "member");
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: viewer.user.email }, "viewer");
    await services.memberships.addMember(owner.user.id, project.id, { email: admin.user.email }, "admin");
    await services.memberships.addMember(owner.user.id, project.id, { email: member.user.email }, "member");
    await services.memberships.addMember(owner.user.id, project.id, { email: viewer.user.email }, "viewer");

    await services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, scope: "workspace_shared", contextKey: "shared.rules", content: "Use concise replies.", contentType: "markdown" });
    assert.equal((await services.contexts.list(member.user.id, { workspaceId: workspace.id, scope: "workspace_shared" })).items[0]?.contextKey, "shared.rules");
    await assert.rejects(() => services.contexts.upsert(member.user.id, { workspaceId: workspace.id, scope: "workspace_shared", contextKey: "blocked", content: "no", contentType: "text" }), status(403));
    await services.contexts.upsert(admin.user.id, { workspaceId: workspace.id, scope: "workspace_shared", contextKey: "admin.rule", content: "ok", contentType: "text" });

    await services.contexts.upsert(member.user.id, { workspaceId: workspace.id, scope: "workspace_personal", contextKey: "my.notes", content: "private", contentType: "text" });
    assert.equal((await services.contexts.list(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal" })).items.length, 0);
    await services.contexts.upsert(viewer.user.id, { workspaceId: workspace.id, scope: "workspace_personal", contextKey: "my.viewer.notes", content: "private", contentType: "text" });

    await services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_shared", contextKey: "project.rules", content: "{\"format\":\"short\"}", contentType: "json" });
    assert.equal((await services.contexts.list(member.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_shared" })).items[0]?.contentType, "json");
    await assert.rejects(() => services.contexts.upsert(member.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_shared", contextKey: "blocked", content: "no", contentType: "text" }), status(403));

    await services.contexts.upsert(member.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_personal", contextKey: "my.project.notes", content: "private", contentType: "yaml" });
    await services.contexts.upsert(viewer.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_personal", contextKey: "my.viewer.project.notes", content: "private", contentType: "yaml" });
    assert.equal((await services.contexts.list(owner.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_personal" })).items.length, 0);
    await assert.rejects(() => services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_shared", contextKey: "bad.json", content: "{", contentType: "json" }), status(400));
  });

  it("renames with an optimistic version and rejects a stale context write", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "rename-owner", email: "rename-owner@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const created = await services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal", contextKey: "draft", content: "one", contentType: "text" });
    const renamed = await services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal", previousContextKey: "draft", expectedVersion: created.version, contextKey: "notes", content: "two", contentType: "text" });
    assert.equal(renamed.contextKey, "notes");
    assert.equal(renamed.version, 2);
    await assert.rejects(() => services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal", previousContextKey: "notes", expectedVersion: 1, contextKey: "notes", content: "stale", contentType: "text" }), status(409));
  });
});

function status(expected: number) { return (error: unknown) => error instanceof ProductError && error.statusCode === expected; }
