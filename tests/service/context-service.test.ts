import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { ProjectContextEntry, ProjectContextScope } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";

const issuer = "https://keycloak.example.test/realms/agentsmith";

describe("context service", () => {
  it("pages bounded metadata, reads limit plus one, and binds cursors to the effective target", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "page-owner", email: "page-owner@example.test", emailVerified: true });
    const member = await services.auth.loginExternalPrincipal({ issuer, subject: "page-member", email: "page-member@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const otherWorkspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Other workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    const otherProject = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Other project" });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: member.user.email }, "member");
    await services.memberships.addMember(owner.user.id, project.id, member.user.id, "member");
    const target = { workspaceId: workspace.id, scope: "workspace_personal" as const };
    const largeContent = "x".repeat(30 * 1024);
    for (let index = 0; index < 26; index += 1) {
      await services.contexts.upsert(owner.user.id, {
        ...target,
        contextKey: `entry.${String(index).padStart(2, "0")}`,
        content: index === 0 ? largeContent : `content ${index}`,
        contentType: "text"
      });
    }

    let readLimit = 0;
    const readPage = store.listProjectContextEntryMetadataPage.bind(store);
    store.listProjectContextEntryMetadataPage = async (query) => {
      readLimit = query.limit;
      return readPage(query);
    };
    const first = await services.contexts.listPage(owner.user.id, target);

    assert.equal(first.items.length, 25);
    assert.equal(readLimit, 26);
    assert.ok(first.nextCursor);
    assert.ok(first.items.every((entry) => !("content" in entry)));
    assert.ok(first.items.every((entry) => entry.contentType === "text"));
    const detail = await services.contexts.get(owner.user.id, first.items[0]!.id, target);
    assert.equal(detail.content, largeContent);
    const second = await services.contexts.listPage(owner.user.id, target, { cursor: first.nextCursor! });
    assert.deepEqual(second.items.map((entry) => entry.contextKey), ["entry.25"]);
    assert.equal(second.nextCursor, null);
    await assert.rejects(() => services.contexts.listPage(owner.user.id, target, { limit: 101 }), status(400));
    await assert.rejects(() => services.contexts.listPage(owner.user.id, { workspaceId: otherWorkspace.id, scope: "workspace_personal" }, { cursor: first.nextCursor! }), status(400));
    await assert.rejects(() => services.contexts.listPage(owner.user.id, { workspaceId: workspace.id, scope: "workspace_shared" }, { cursor: first.nextCursor! }), status(400));
    await assert.rejects(() => services.contexts.listPage(member.user.id, target, { cursor: first.nextCursor! }), status(400));

    for (let index = 0; index < 26; index += 1) {
      await services.contexts.upsert(owner.user.id, {
        workspaceId: workspace.id,
        projectId: project.id,
        scope: "project_shared",
        contextKey: `project.${String(index).padStart(2, "0")}`,
        content: "project",
        contentType: "text"
      });
    }
    const projectPage = await services.contexts.listPage(owner.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_shared" });
    await assert.rejects(
      () => services.contexts.listPage(owner.user.id, { workspaceId: workspace.id, projectId: otherProject.id, scope: "project_shared" }, { cursor: projectPage.nextCursor! }),
      status(400)
    );

    for (const contextKey of ["unicode.\uE000", "unicode.\u{10000}"]) {
      await services.contexts.upsert(owner.user.id, {
        workspaceId: otherWorkspace.id,
        scope: "workspace_shared",
        contextKey,
        content: "unicode ordering",
        contentType: "text"
      });
    }
    assert.deepEqual(
      (await services.contexts.listPage(owner.user.id, { workspaceId: otherWorkspace.id, scope: "workspace_shared" })).items.map((entry) => entry.contextKey),
      ["unicode.\uE000", "unicode.\u{10000}"]
    );
  });

  it("returns exact detail only inside the authorized scope and effective personal owner", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "detail-owner", email: "detail-owner@example.test", emailVerified: true });
    const member = await services.auth.loginExternalPrincipal({ issuer, subject: "detail-member", email: "detail-member@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: member.user.email }, "member");
    const target = { workspaceId: workspace.id, scope: "workspace_personal" as const };
    const entry = await services.contexts.upsert(owner.user.id, { ...target, contextKey: "private", content: "owner only", contentType: "text" });

    assert.equal((await services.contexts.get(owner.user.id, entry.id, target)).content, "owner only");
    await assert.rejects(() => services.contexts.get(member.user.id, entry.id, target), status(404));
    await assert.rejects(
      () => services.contexts.get(owner.user.id, entry.id, { workspaceId: workspace.id, scope: "workspace_shared" }),
      status(404)
    );
  });

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
    await services.memberships.addMember(owner.user.id, project.id, admin.user.id, "admin");
    await services.memberships.addMember(owner.user.id, project.id, member.user.id, "member");
    await services.memberships.addMember(owner.user.id, project.id, viewer.user.id, "viewer");

    await services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, scope: "workspace_shared", contextKey: "shared.rules", content: "Use concise replies.", contentType: "markdown" });
    assert.equal((await services.contexts.listPage(member.user.id, { workspaceId: workspace.id, scope: "workspace_shared" })).items[0]?.contextKey, "shared.rules");
    await assert.rejects(() => services.contexts.upsert(member.user.id, { workspaceId: workspace.id, scope: "workspace_shared", contextKey: "blocked", content: "no", contentType: "text" }), status(403));
    await services.contexts.upsert(admin.user.id, { workspaceId: workspace.id, scope: "workspace_shared", contextKey: "admin.rule", content: "ok", contentType: "text" });

    await services.contexts.upsert(member.user.id, { workspaceId: workspace.id, scope: "workspace_personal", contextKey: "my.notes", content: "private", contentType: "text" });
    assert.equal((await services.contexts.listPage(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal" })).items.length, 0);
    await services.contexts.upsert(viewer.user.id, { workspaceId: workspace.id, scope: "workspace_personal", contextKey: "my.viewer.notes", content: "private", contentType: "text" });

    await services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_shared", contextKey: "project.rules", content: "{\"format\":\"short\"}", contentType: "json" });
    assert.equal((await services.contexts.listPage(member.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_shared" })).items[0]?.contentType, "json");
    await assert.rejects(() => services.contexts.upsert(member.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_shared", contextKey: "blocked", content: "no", contentType: "text" }), status(403));

    await services.contexts.upsert(member.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_personal", contextKey: "my.project.notes", content: "private", contentType: "yaml" });
    await services.contexts.upsert(viewer.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_personal", contextKey: "my.viewer.project.notes", content: "private", contentType: "yaml" });
    assert.equal((await services.contexts.listPage(owner.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_personal" })).items.length, 0);
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
    await assert.rejects(() => services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal", previousContextKey: "notes", expectedVersion: 1, contextKey: "notes", content: "stale", contentType: "text" }), code(409, "context_version_conflict"));
    await assert.rejects(() => services.contexts.delete(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal", contextKey: "notes", expectedVersion: 1 }), code(409, "context_version_conflict"));
    assert.equal((await services.contexts.listPage(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal" })).items[0]?.version, 2);
    await services.contexts.delete(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal", contextKey: "notes", expectedVersion: renamed.version });
    await assert.rejects(() => services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal", previousContextKey: "notes", expectedVersion: renamed.version, contextKey: "notes", content: "must not recreate", contentType: "text" }), code(409, "context_version_conflict"));
    assert.equal((await services.contexts.listPage(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal" })).items.length, 0);
  });

  it("keeps context keys unique when creates and renames race", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "race-owner", email: "race-owner@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const target = { workspaceId: workspace.id, scope: "workspace_personal" as const };

    const creates = await Promise.allSettled([
      services.contexts.upsert(owner.user.id, { ...target, contextKey: "same", content: "one", contentType: "text" }),
      services.contexts.upsert(owner.user.id, { ...target, contextKey: "same", content: "two", contentType: "text" })
    ]);

    assert.equal(creates.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(creates.filter((result) => result.status === "rejected" && result.reason instanceof ProductError && result.reason.statusCode === 409).length, 1);
    assert.equal((await services.contexts.listPage(owner.user.id, target)).items.filter((entry) => entry.contextKey === "same").length, 1);
    await assert.rejects(
      () => services.contexts.upsert(owner.user.id, { ...target, contextKey: "same", content: "later", contentType: "text" }),
      code(409, "context_key_conflict", "A context entry already uses that key")
    );

    const left = await services.contexts.upsert(owner.user.id, { ...target, contextKey: "left", content: "left", contentType: "text" });
    const right = await services.contexts.upsert(owner.user.id, { ...target, contextKey: "right", content: "right", contentType: "text" });
    const renames = await Promise.allSettled([
      services.contexts.upsert(owner.user.id, { ...target, previousContextKey: left.contextKey, expectedVersion: left.version, contextKey: "merged", content: left.content, contentType: left.contentType }),
      services.contexts.upsert(owner.user.id, { ...target, previousContextKey: right.contextKey, expectedVersion: right.version, contextKey: "merged", content: right.content, contentType: right.contentType })
    ]);

    assert.equal(renames.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(renames.filter((result) => result.status === "rejected" && result.reason instanceof ProductError && result.reason.statusCode === 409).length, 1);
    const entries = (await services.contexts.listPage(owner.user.id, target)).items;
    assert.equal(entries.filter((entry) => entry.contextKey === "merged").length, 1);
    assert.equal(entries.length, 3);
  });

  it("does not create a new version for a normalized no-op update", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "noop-owner", email: "noop-owner@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const created = await services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal", contextKey: "notes", content: "one", contentType: "text" });

    const unchanged = await services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal", previousContextKey: "notes", expectedVersion: created.version, contextKey: "  notes  ", content: "one", contentType: "text" });

    assert.equal(unchanged.version, created.version);
    assert.equal(unchanged.updatedAt, created.updatedAt);
    assert.equal(unchanged.contextKey, "notes");
  });

  it("keeps personal and shared context read-only after its project or workspace is archived", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "archive-owner", email: "archive-owner@example.test", emailVerified: true });
    const viewer = await services.auth.loginExternalPrincipal({ issuer, subject: "archive-viewer", email: "archive-viewer@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: viewer.user.email }, "viewer");
    await services.memberships.addMember(owner.user.id, project.id, viewer.user.id, "viewer");
    const projectPersonal = { workspaceId: workspace.id, projectId: project.id, scope: "project_personal" as const };
    const workspacePersonal = { workspaceId: workspace.id, scope: "workspace_personal" as const };

    await services.contexts.upsert(viewer.user.id, { ...projectPersonal, contextKey: "notes", content: "private", contentType: "text" });
    assert.equal((await services.contexts.listPage(viewer.user.id, projectPersonal)).canWrite, true);

    await services.settings.archiveProject(owner.user.id, project.id);
    assert.equal((await services.contexts.listPage(viewer.user.id, projectPersonal)).canWrite, false);
    assert.equal((await services.contexts.listPage(owner.user.id, { ...projectPersonal, scope: "project_shared" })).canWrite, false);
    await assert.rejects(
      () => services.contexts.upsert(viewer.user.id, { ...projectPersonal, contextKey: "blocked", content: "no", contentType: "text" }),
      message(409, "Project is archived")
    );

    await services.settings.unarchiveProject(owner.user.id, project.id);
    await services.settings.archiveWorkspace(owner.user.id, workspace.id);
    assert.equal((await services.contexts.listPage(viewer.user.id, projectPersonal)).canWrite, false);
    assert.equal((await services.contexts.listPage(viewer.user.id, workspacePersonal)).canWrite, false);
    assert.equal((await services.contexts.listPage(owner.user.id, { workspaceId: workspace.id, scope: "workspace_shared" })).canWrite, false);
    await assert.rejects(
      () => services.contexts.upsert(viewer.user.id, { ...projectPersonal, contextKey: "blocked", content: "no", contentType: "text" }),
      message(409, "Workspace is archived")
    );
    await assert.rejects(
      () => services.contexts.upsert(viewer.user.id, { ...workspacePersonal, contextKey: "blocked", content: "no", contentType: "text" }),
      message(409, "Workspace is archived")
    );
  });

  it("replays context creation, versioned updates, and deletion", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "context-replay-owner", email: "context-replay-owner@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const create = { workspaceId: workspace.id, scope: "workspace_personal" as const, contextKey: "notes", content: "one", contentType: "text" as const };

    const created = await services.contexts.upsert(owner.user.id, create, "context-create-key");
    assert.deepEqual(await services.contexts.upsert(owner.user.id, create, "context-create-key"), created);
    const update = { ...create, previousContextKey: "notes", expectedVersion: created.version, content: "two" };
    const updated = await services.contexts.upsert(owner.user.id, update, "context-update-key");
    assert.deepEqual(await services.contexts.upsert(owner.user.id, update, "context-update-key"), updated);
    const remove = { workspaceId: workspace.id, scope: "workspace_personal" as const, contextKey: "notes", expectedVersion: updated.version };
    assert.deepEqual(await services.contexts.delete(owner.user.id, remove, "context-delete-key"), { deleted: true });
    assert.deepEqual(await services.contexts.delete(owner.user.id, remove, "context-delete-key"), { deleted: true });
    assert.deepEqual((await services.contexts.listPage(owner.user.id, { workspaceId: workspace.id, scope: "workspace_personal" })).items, []);
  });

  it("resolves effective agent context by key from broad shared defaults to personal project overrides", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "context-owner", email: "context-owner@example.test", emailVerified: true });
    const member = await services.auth.loginExternalPrincipal({ issuer, subject: "context-member", email: "context-member@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: member.user.email }, "member");
    await services.memberships.addMember(owner.user.id, project.id, member.user.id, "member");
    await services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, scope: "workspace_shared", contextKey: "style", content: "workspace shared", contentType: "text" });
    await services.contexts.upsert(member.user.id, { workspaceId: workspace.id, scope: "workspace_personal", contextKey: "style", content: "workspace personal", contentType: "text" });
    await services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_shared", contextKey: "style", content: "project shared", contentType: "text" });
    await services.contexts.upsert(member.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_personal", contextKey: "style", content: "project personal", contentType: "text" });
    await services.contexts.upsert(owner.user.id, { workspaceId: workspace.id, projectId: project.id, scope: "project_shared", contextKey: "project.rule", content: "keep this", contentType: "text" });

    let fullPageReads = 0;
    const listFullPage = store.listProjectContextEntryPage.bind(store);
    store.listProjectContextEntryPage = async (query) => {
      fullPageReads += 1;
      assert.equal(query.limit, 100);
      return listFullPage(query);
    };
    store.findProjectContextEntryById = async () => {
      throw new Error("agent context must not hydrate entries one at a time");
    };
    const resolved = await services.contexts.resolveForAgent(member.user.id, project.id);

    assert.equal(fullPageReads, 4);
    assert.match(resolved, /project personal/);
    assert.match(resolved, /project\.rule[\s\S]*keep this/);
    assert.doesNotMatch(resolved, /workspace shared|workspace personal|project shared/);
  });

  it("bounds effective context while paging winners from highest to lowest precedence", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginExternalPrincipal({ issuer, subject: "bounded-owner", email: "bounded-owner@example.test", emailVerified: true });
    const member = await services.auth.loginExternalPrincipal({ issuer, subject: "bounded-member", email: "bounded-member@example.test", emailVerified: true });
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    await services.workspaceMemberships.add(owner.user.id, workspace.id, { email: member.user.email }, "member");
    await services.memberships.addMember(owner.user.id, project.id, member.user.id, "member");

    const entry = (scope: ProjectContextScope, contextKey: string, content: string): ProjectContextEntry => ({
      id: `ctx_${scope}_${contextKey}`,
      workspaceId: workspace.id,
      projectId: scope.startsWith("project_") ? project.id : null,
      ownerUserId: scope.endsWith("_personal") ? member.user.id : null,
      scope,
      contextKey,
      content,
      contentType: "text",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const firstPersonalPage = Array.from({ length: 100 }, (_, index) =>
      entry("project_personal", `personal.${String(index).padStart(3, "0")}`, "x")
    );
    const scopesRead: ProjectContextScope[] = [];
    store.listProjectContextEntryPage = async (query) => {
      scopesRead.push(query.scope);
      if (query.scope === "project_personal") {
        return query.afterContextKey ? [entry("project_personal", "zz.override", "winner")] : firstPersonalPage;
      }
      if (query.scope === "project_shared") {
        return [entry("project_shared", "zz.override", "x".repeat(30 * 1024))];
      }
      if (query.scope === "workspace_personal") {
        return [entry("workspace_personal", "zz.too-large", "x".repeat(30 * 1024))];
      }
      return [];
    };

    await assert.rejects(() => services.contexts.resolveForAgent(member.user.id, project.id), status(413));
    assert.deepEqual(scopesRead, [
      "project_personal",
      "project_personal",
      "project_shared",
      "workspace_personal"
    ]);
  });
});

function status(expected: number) { return (error: unknown) => error instanceof ProductError && error.statusCode === expected; }
function message(expectedStatus: number, expectedMessage: string) {
  return (error: unknown) => error instanceof ProductError && error.statusCode === expectedStatus && error.message === expectedMessage;
}
function code(expectedStatus: number, expectedCode: string, expectedMessage?: string) {
  return (error: unknown) => error instanceof ProductError
    && error.statusCode === expectedStatus
    && error.code === expectedCode
    && (expectedMessage === undefined || error.message === expectedMessage);
}
