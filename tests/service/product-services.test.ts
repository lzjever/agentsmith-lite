import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";

describe("product services", () => {
  it("bootstraps built-in admin, logs in, and manages workspace/project records", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "correct horse battery staple"
    });

    const bootstrap = await services.auth.bootstrapBuiltInAdmin();
    assert.equal(bootstrap.created, true);
    assert.equal(bootstrap.user.email, "admin@agentsmith-lite.local");

    const session = await services.auth.login("admin@agentsmith-lite.local", "correct horse battery staple");
    assert.equal(session.user.id, "user_builtin_admin");
    assert.match(session.sessionId, /^sess_/);
    assert.match(session.csrfToken, /^csrf_/);

    const workspace = await services.workspaces.createWorkspace(session.user.id, { name: "Ops" });
    const project = await services.workspaces.createProject(session.user.id, workspace.id, { name: "Sandbox" });
    const pinned = await services.workspaces.setProjectPinned(session.user.id, project.id, true);
    const listed = await services.workspaces.listWorkspaces(session.user.id);

    assert.ok(pinned.pinnedAt);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.projects[0]?.id, project.id);
    assert.equal(listed[0]?.projects[0]?.pinnedAt, pinned.pinnedAt);
    assert.equal(listed[0]?.projects[0]?.rootPath, "workspaces/" + workspace.id + "/projects/" + project.id);
    const member = await services.auth.loginExternalPrincipal({ issuer:"https://idp.test",subject:"pin-member",email:"pin-member@example.test",emailVerified:true });
    const membershipAt = new Date().toISOString();
    await store.upsertWorkspaceMembership({ workspaceId:workspace.id,userId:member.user.id,role:"member",createdAt:membershipAt,updatedAt:membershipAt });
    await store.upsertProjectMembership({ projectId:project.id,userId:member.user.id,role:"member",createdAt:membershipAt,updatedAt:membershipAt });
    assert.ok((await services.workspaces.setProjectPinned(member.user.id, project.id, true)).pinnedAt);
    assert.equal((await services.workspaces.setProjectPinned(session.user.id, project.id, false)).pinnedAt, null);
    assert.equal((await services.workspaces.listWorkspaces(session.user.id))[0]?.projects[0]?.pinnedAt, null);
    assert.ok((await services.workspaces.listWorkspaces(member.user.id))[0]?.projects[0]?.pinnedAt);
    await store.deleteProjectMembership(project.id, member.user.id);
    assert.deepEqual(await store.listProjectPinsForUser(member.user.id), []);
  });

  it("replays workspace and project creation without duplicating resources", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginAfterBootstrap("admin-password");

    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Operations" }, "workspace-create-key");
    const replayedWorkspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Operations" }, "workspace-create-key");
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Runtime" }, "project-create-key");
    const replayedProject = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Runtime" }, "project-create-key");

    assert.equal(replayedWorkspace.id, workspace.id);
    assert.equal(replayedProject.id, project.id);
    assert.equal((await services.workspaces.listWorkspaces(owner.user.id)).length, 1);
    assert.equal((await store.listProjectsForUser(owner.user.id)).length, 1);
    await assert.rejects(
      () => services.workspaces.createWorkspace(owner.user.id, { name: "Different" }, "workspace-create-key"),
      /Idempotency-Key was already used with a different request/
    );
  });

  it("bounds workspace and project names at the product boundary", async () => {
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });
    const oversized = "x".repeat(161);

    await assert.rejects(() => services.workspaces.createWorkspace(owner.user.id, { name: oversized }), /workspace\.name must be 160 characters or less/);
    await assert.rejects(() => services.workspaces.createProject(owner.user.id, workspace.id, { name: oversized }), /project\.name must be 160 characters or less/);
    await assert.rejects(() => services.settings.updateWorkspace(owner.user.id, workspace.id, { name: oversized }), /workspace\.name must be 160 characters or less/);
    await assert.rejects(() => services.settings.updateProject(owner.user.id, project.id, { name: oversized }), /project\.name must be 160 characters or less/);
  });

  it("revokes built-in admin sessions on logout", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password"
    });
    const session = await services.auth.loginAfterBootstrap("admin-password");

    assert.equal((await services.auth.requireSession(session.sessionId)).id, session.user.id);

    await services.auth.logout(session.sessionId);

    await assert.rejects(
      () => services.auth.requireSession(session.sessionId),
      /Unauthorized/
    );
    assert.equal(await store.findSession(session.sessionId), null);
  });

  it("projects state-aware project overview actions on the server", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const owner = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(owner.user.id, { name: "Overview" });
    const project = await services.workspaces.createProject(owner.user.id, workspace.id, { name: "Project" });

    const initial = await services.workspaces.projectOverview(owner.user.id, project.id);
    assert.equal(initial.workspaceLifecycleStatus, "active");
    assert.deepEqual(initial.recommendedActions, ["configure_endpoint", "add_collaborator"]);

    const timestamp = new Date().toISOString();
    await store.createProjectCredential({ id: "credential_overview", projectId: project.id, name: "Credential", type: "api_key", baseUrl: "https://models.example.test/v1", fingerprint: "fingerprint", version: 1, keyId: "test", nonce: Buffer.alloc(12), ciphertext: Buffer.from("ciphertext"), authTag: Buffer.alloc(16), createdAt: timestamp, lastRotatedAt: null, updatedAt: timestamp });
    await store.createEndpoint({ id: "endpoint_overview", projectId: project.id, name: "Ready", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId: "credential_overview", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, health: { status: "healthy", checkedAt: timestamp, errorCategory: null }, createdAt: timestamp, updatedAt: timestamp });
    const ready = await services.workspaces.projectOverview(owner.user.id, project.id);
    assert.deepEqual(ready.recommendedActions, ["start_chat", "create_task", "add_collaborator"]);
    assert.deepEqual([ready.chatReadyEndpointCount, ready.taskReadyEndpointCount], [1, 1]);

    const viewer = await services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "overview-viewer", email: "overview-viewer@example.test", emailVerified: true });
    await store.upsertProjectMembership({ projectId: project.id, userId: viewer.user.id, role: "viewer", createdAt: timestamp, updatedAt: timestamp });
    assert.deepEqual((await services.workspaces.projectOverview(viewer.user.id, project.id)).recommendedActions, []);

    await services.settings.archiveWorkspace(owner.user.id, workspace.id);
    assert.equal((await services.workspaces.projectOverview(owner.user.id, project.id)).workspaceLifecycleStatus, "archived");
    assert.equal((await services.settings.project(owner.user.id, project.id)).workspaceLifecycleStatus, "archived");
  });

  it("logs in a verified external principal as a stable local user", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password"
    });

    const first = await services.auth.loginExternalPrincipal({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "keycloak-user-1",
      email: "Admin.User@Example.Test",
      emailVerified: true
    });
    const second = await services.auth.loginExternalPrincipal({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "keycloak-user-1",
      email: "renamed@example.test",
      emailVerified: true
    });

    assert.equal(first.user.id, second.user.id);
    assert.match(first.user.id, /^user_oidc_/);
    assert.equal(first.user.email, "admin.user@example.test");
    assert.equal(second.user.email, "renamed@example.test");
    assert.equal(second.user.emailVerified, true);
    assert.equal("oidcIssuer" in second.user, false);
    assert.equal("oidcSubject" in second.user, false);
    assert.match(first.sessionId, /^sess_/);
    assert.match(first.csrfToken, /^csrf_/);
    assert.match(second.sessionId, /^sess_/);
    assert.match(second.csrfToken, /^csrf_/);
    assert.equal(await store.countUsers(), 1);

    await assert.rejects(
      () => services.auth.login("renamed@example.test", "anything"),
      /Invalid email or password/
    );
  });

  it("removes expired sessions when a new session is created", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password"
    });
    const principal = {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "session-cleanup-user",
      email: "session-cleanup@example.test",
      emailVerified: true
    };
    const first = await services.auth.loginExternalPrincipal(principal);
    await store.createSession({
      id: "sess_expired",
      userId: first.user.id,
      csrfToken: "csrf_expired",
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-01T01:00:00.000Z"
    });

    await services.auth.loginExternalPrincipal(principal);

    assert.equal(await store.findSession("sess_expired"), null);
    assert.ok(await store.findSession(first.sessionId));
  });

  it("rejects a bound OIDC email collision without exposing either identity", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const issuer = "https://keycloak.example.test/realms/agentsmith";
    await services.auth.loginExternalPrincipal({ issuer, subject: "first", email: "first@example.test", emailVerified: true });
    await services.auth.loginExternalPrincipal({ issuer, subject: "second", email: "second@example.test", emailVerified: true });

    await assert.rejects(
      () => services.auth.loginExternalPrincipal({ issuer, subject: "first", email: "second@example.test", emailVerified: true }),
      (error: unknown) => error instanceof Error && error.message === "OIDC identity could not be authenticated"
    );
    assert.equal((await store.findUserByOidcSubject(issuer, "first"))?.email, "first@example.test");
  });

  it("binds a matching unbound legacy OIDC user to its deterministic identity", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const principal = {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "legacy-user",
      email: "Legacy.User@Example.Test",
      emailVerified: true
    };
    const userId = oidcUserId(principal.issuer, principal.subject);
    await store.createUser({
      id: userId,
      email: "legacy.user@example.test",
      emailVerified: false,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });

    const login = await services.auth.loginExternalPrincipal(principal);
    const stored = await store.findUserById(userId);

    assert.equal(login.user.id, userId);
    assert.equal(stored?.email, "legacy.user@example.test");
    assert.equal(stored?.emailVerified, true);
    assert.equal(stored?.oidcIssuer, principal.issuer);
    assert.equal(stored?.oidcSubject, principal.subject);
  });

  it("rejects an unbound legacy OIDC user when its email does not match", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const principal = {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "legacy-email-mismatch",
      email: "login@example.test",
      emailVerified: true
    };
    const userId = oidcUserId(principal.issuer, principal.subject);
    await store.createUser({
      id: userId,
      email: "different@example.test",
      emailVerified: false,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });

    await assert.rejects(() => services.auth.loginExternalPrincipal(principal), /OIDC identity does not match the existing user/);
    const stored = await store.findUserById(userId);
    assert.equal(stored?.oidcIssuer, undefined);
    assert.equal(stored?.oidcSubject, undefined);
    assert.equal(stored?.email, "different@example.test");
  });

  it("does not overwrite a deterministic OIDC user bound to another identity", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const principal = {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "new-subject",
      email: "user@example.test",
      emailVerified: true
    };
    const userId = oidcUserId(principal.issuer, principal.subject);
    await store.createUser({
      id: userId,
      email: principal.email,
      oidcIssuer: principal.issuer,
      oidcSubject: "old-subject",
      emailVerified: true,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });

    await assert.rejects(() => services.auth.loginExternalPrincipal(principal), /OIDC identity does not match the existing user/);
    const stored = await store.findUserById(userId);
    assert.equal(stored?.oidcIssuer, principal.issuer);
    assert.equal(stored?.oidcSubject, "old-subject");
  });

  it("rejects OIDC principals whose verified-email claim is missing or false", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    const principal = {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "keycloak-user-unverified",
      email: "user@example.test"
    };

    await assert.rejects(() => services.auth.loginExternalPrincipal(principal), /OIDC principal email must be verified/);
    await assert.rejects(() => services.auth.loginExternalPrincipal({ ...principal, emailVerified: false }), /OIDC principal email must be verified/);
    assert.equal(await store.countUsers(), 0);
  });

  it("does not add global privileges to repeated OIDC logins", async () => {
    const store = createInMemoryProductStore();
    const adminServices = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
    });

    const first = await adminServices.auth.loginExternalPrincipal({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "keycloak-user-1",
      email: "Admin.User@Example.Test",
      emailVerified: true
    });

    const second = await adminServices.auth.loginExternalPrincipal({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "keycloak-user-1",
      email: "Admin.User@Example.Test",
      emailVerified: true
    });

    assert.equal(second.user.id, first.user.id);
    assert.equal((await store.findUserById(first.user.id))?.id, first.user.id);
  });

  it("accepts only OpenAI-compatible endpoint configuration and validates before saving", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: healthyProvider
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const credential = await services.credentials.create(user.id, project.id, { name: "OpenAI credential", baseUrl: "https://models.example.com/v1", secret: "sk-product-services" });

    await assert.rejects(
      () => services.endpoints.createEndpoint(user.id, project.id, {
        name: "native-provider",
        protocol: "anthropic-native" as never,
        baseUrl: "https://api.example.com/v1",
        model: "claude",
        credentialId: credential.id,
        capabilities: ["text"],
        requestTimeoutSecs: 30
      }),
      /Only openai_chat_completions endpoints are supported/
    );

    const endpoint = await services.endpoints.createEndpoint(user.id, project.id, {
      name: "openai-compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.com/v1",
      model: "gpt-compatible",
      credentialId: credential.id,
      capabilities: ["text", "tool_calls"],
      requestTimeoutSecs: 45
    });

    assert.equal(endpoint.protocol, "openai_chat_completions");
    assert.equal(store.observedExternalModelCalls, 0);

    for (const credentialId of ["missing-credential", "other-project-credential"]) {
      await assert.rejects(
        () => services.endpoints.createEndpoint(user.id, project.id, {
          name: `bad-${credentialId}`,
          protocol: "openai_chat_completions",
          baseUrl: "https://models.example.com/v1",
          model: "gpt-compatible",
          credentialId,
          capabilities: ["text"],
          requestTimeoutSecs: 30
        }),
        /Credential not found/
      );
    }

    for (const baseUrl of ["http://models.example.com/v1", "https://models.example.com/v1?tenant=a", "https://models.example.com/v1#fragment"]) {
      await assert.rejects(
        () => services.endpoints.createEndpoint(user.id, project.id, {
          name: `bad-${baseUrl}`,
          protocol: "openai_chat_completions",
          baseUrl,
          model: "gpt-compatible",
          credentialId: credential.id,
          capabilities: ["text"],
          requestTimeoutSecs: 30
        }),
        /Endpoint baseUrl/
      );
    }
    assert.equal((await store.listProjectAuditEvents(project.id)).some((event) => event.action === "endpoint.create" && event.status === "accepted"), true);
    assert.equal((await store.listProjectAuditEvents(project.id)).some((event) => event.action === "endpoint.create" && event.status === "rejected"), true);
    assert.deepEqual((await store.listActiveProjectAlerts(project.id)).map((alert) => alert.type), []);
  });

  it("lets a project owner manage credential-bound endpoints", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: healthyProvider
    });
    const member = await services.auth.loginExternalPrincipal({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "member-endpoint-owner",
      email: "member@example.test",
      emailVerified: true
    });
    const workspace = await services.workspaces.createWorkspace(member.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(member.user.id, workspace.id, { name: "Project" });
    const credential = await services.credentials.create(member.user.id, project.id, { name: "OpenAI credential", baseUrl: "https://models.example.com/v1", secret: "sk-member-product-services" });

    const endpoint = await services.endpoints.createEndpoint(member.user.id, project.id, {
        name: "openai-compatible",
        protocol: "openai_chat_completions",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-compatible",
        credentialId: credential.id,
        capabilities: ["text"],
        requestTimeoutSecs: 30
    });
    assert.equal(endpoint.projectId, project.id);
  });
});

function oidcUserId(issuer: string, subject: string): string {
  const digest = createHash("sha256").update(`${issuer}\0${subject}`).digest("hex").slice(0, 32);
  return `user_oidc_${digest}`;
}

const healthyProvider = {
  async validateEndpoint() { return { status: "healthy" as const }; },
  async completeChat() { throw new Error("not used"); }
};
