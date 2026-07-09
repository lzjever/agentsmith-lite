import assert from "node:assert/strict";
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

  it("logs in a verified external principal as a stable local member user", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password"
    });

    const first = await services.auth.loginExternalPrincipal({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "keycloak-user-1",
      email: "Admin.User@Example.Test"
    });
    const second = await services.auth.loginExternalPrincipal({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "keycloak-user-1",
      email: "renamed@example.test"
    });

    assert.equal(first.user.id, second.user.id);
    assert.match(first.user.id, /^user_oidc_/);
    assert.equal(first.user.email, "admin.user@example.test");
    assert.equal(second.user.email, "admin.user@example.test");
    assert.equal(first.user.role, "member");
    assert.equal(second.user.role, "member");
    assert.match(first.sessionId, /^sess_/);
    assert.match(first.csrfToken, /^csrf_/);
    assert.match(second.sessionId, /^sess_/);
    assert.match(second.csrfToken, /^csrf_/);
    assert.equal(await store.countUsers(), 1);

    await assert.rejects(
      () => services.auth.login("admin.user@example.test", "anything"),
      /Invalid email or password/
    );
  });

  it("recomputes external principal role from the current OIDC admin allowlist", async () => {
    const store = createInMemoryProductStore();
    const adminServices = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      oidcAdminEmails: ["admin.user@example.test"]
    });

    const first = await adminServices.auth.loginExternalPrincipal({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "keycloak-user-1",
      email: "Admin.User@Example.Test"
    });

    assert.equal(first.user.role, "admin");

    const memberServices = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password"
    });
    const second = await memberServices.auth.loginExternalPrincipal({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "keycloak-user-1",
      email: "Admin.User@Example.Test"
    });

    assert.equal(second.user.id, first.user.id);
    assert.equal(second.user.role, "member");
    assert.equal((await store.findUserById(first.user.id))?.role, "member");
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

    await assert.rejects(
      () => services.endpoints.createEndpoint(user.id, project.id, {
        name: "native-provider",
        protocol: "anthropic-native" as never,
        baseUrl: "https://api.example.com/v1",
        model: "claude",
        apiKeySecretRef: "secret/native",
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
      apiKeySecretRef: "secret/openai",
      capabilities: ["text", "tool_calls"],
      requestTimeoutSecs: 45
    });

    assert.equal(endpoint.protocol, "openai_chat_completions");
    assert.equal(store.observedExternalModelCalls, 0);

    for (const apiKeySecretRef of ["sk-raw-key", "raw", "env:OPENAI_KEY", "secret/Bad", "secret/foo_bar", "secret/", "not-secret/openai"]) {
      await assert.rejects(
        () => services.endpoints.createEndpoint(user.id, project.id, {
          name: `bad-${apiKeySecretRef}`,
          protocol: "openai_chat_completions",
          baseUrl: "https://models.example.com/v1",
          model: "gpt-compatible",
          apiKeySecretRef,
          capabilities: ["text"],
          requestTimeoutSecs: 30
        }),
        /Endpoint apiKeySecretRef must be secret\/<slug>/
      );
    }

    for (const baseUrl of ["http://models.example.com/v1", "https://models.example.com/v1?tenant=a", "https://models.example.com/v1#fragment"]) {
      await assert.rejects(
        () => services.endpoints.createEndpoint(user.id, project.id, {
          name: `bad-${baseUrl}`,
          protocol: "openai_chat_completions",
          baseUrl,
          model: "gpt-compatible",
          apiKeySecretRef: "secret/openai",
          capabilities: ["text"],
          requestTimeoutSecs: 30
        }),
        /Endpoint baseUrl/
      );
    }
  });
});
