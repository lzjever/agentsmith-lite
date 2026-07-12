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
    const listed = await services.workspaces.listWorkspaces(session.user.id);

    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.projects[0]?.id, project.id);
    assert.equal(listed[0]?.projects[0]?.rootPath, "workspaces/" + workspace.id + "/projects/" + project.id);
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

  it("accepts only OpenAI-compatible endpoint configuration and never calls providers while saving", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password"
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
      builtinAdminPassword: "admin-password"
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
