import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApiServer } from "../../packages/api-entry-node/src/server.js";
import type { OidcClientAdapter } from "../../packages/api-entry-node/src/oidcClient.js";
import type { ExternalPrincipal } from "../../packages/application/src/authService.js";

describe("api OIDC auth", () => {
  const appBasePath = "/app";
  let baseUrl = "";
  let closeServer: undefined | (() => Promise<void>);
  let dataRoot = "";
  const oidcCalls: Array<Record<string, string | undefined>> = [];
  const oidcPrincipals: ExternalPrincipal[] = [];

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-api-oidc-"));
    const api = await createApiServer({
      port: 0,
      dataRoot,
      authMode: "oidc",
      builtinAdminPassword: "builtin-password-must-not-work",
      sessionSecret: "oidc-session-secret-at-least-32-chars",
      publicBaseUrl: "https://agentsmith.example.test/app//",
      oidcClient: fakeOidcClient(oidcCalls, oidcPrincipals),
      providerClient: {
        completeChat: async () => { throw new Error("not used"); },
        validateEndpoint: async () => ({ status: "healthy" as const })
      }
    });
    baseUrl = api.baseUrl;
    closeServer = api.close;
  });

  after(async () => {
    await closeServer?.();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("serves prefixed APIs while leaving web routes to the web workload", async () => {
    const bootstrapResponse = await fetch(baseUrl + apiPath("/api/v1/bootstrap"));
    assert.equal(bootstrapResponse.status, 200);
    assert.equal((await bootstrapResponse.json()).authMode, "oidc");

    const webRoute = await fetch(baseUrl + `${appBasePath}/`);
    assert.equal(webRoute.status, 404);

    const apiUnknown = await fetch(baseUrl + apiPath("/api/v1/unknown"));
    assert.equal(apiUnknown.status, 404);
    assert.match(apiUnknown.headers.get("content-type") ?? "", /application\/json/);

    const removedOperatorApi = await fetch(baseUrl + apiPath("/api/operator/sandbox/status"));
    assert.equal(removedOperatorApi.status, 404);

    const apiRoot = await fetch(baseUrl + apiPath("/api"));
    assert.equal(apiRoot.status, 404);
    assert.match(apiRoot.headers.get("content-type") ?? "", /application\/json/);
  });

  it("does not expose root paths when the public base URL has an app prefix", async () => {
    const rootWebRoute = await fetch(baseUrl + "/");
    assert.equal(rootWebRoute.status, 404);

    const rootBootstrap = await fetch(baseUrl + "/api/v1/bootstrap");
    assert.equal(rootBootstrap.status, 404);
  });

  it("creates a local OIDC identity and keeps project authorization scoped", async () => {
    const bootstrap = await fetch(baseUrl + apiPath("/api/v1/bootstrap")).then((response) => response.json());
    assert.equal(bootstrap.authMode, "oidc");

    const builtinBootstrap = await post("/api/v1/auth/bootstrap", { password: "builtin-password-must-not-work" });
    assert.equal(builtinBootstrap.status, 404);
    const builtinLogin = await post("/api/v1/auth/login", {
      email: "admin@agentsmith-lite.local",
      password: "builtin-password-must-not-work"
    });
    assert.equal(builtinLogin.status, 404);

    const login = await loginOidc({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "keycloak-member-subject",
      email: "OIDC.Member@Example.Test",
      emailVerified: true
    });
    assert.match(login.user.id, /^user_oidc_/);
    assert.equal(login.user.email, "oidc.member@example.test");
    assert.match(login.csrfToken, /^csrf_/);

    const missingCsrf = await fetch(baseUrl + apiPath("/api/v1/workspaces"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: login.sessionCookie
      },
      body: JSON.stringify({ name: "Missing CSRF" })
    });
    assert.equal(missingCsrf.status, 403);

    const workspace = await fetch(baseUrl + apiPath("/api/v1/workspaces"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: login.sessionCookie,
        "x-csrf-token": login.csrfToken
      },
      body: JSON.stringify({ name: "OIDC Workspace" })
    });
    assert.equal(workspace.status, 200);

    const memberWorkspace = await workspace.json();
    const projectResponse = await fetch(baseUrl + apiPath(`/api/v1/workspaces/${memberWorkspace.id}/projects`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: login.sessionCookie,
        "x-csrf-token": login.csrfToken
      },
      body: JSON.stringify({ name: "OIDC Project" })
    });
    assert.equal(projectResponse.status, 200);
    const project = await projectResponse.json();
    const credentialResponse = await fetch(baseUrl + apiPath(`/api/v1/projects/${project.id}/credentials`), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: login.sessionCookie, "x-csrf-token": login.csrfToken },
      body: JSON.stringify({ name: "Member credential", baseUrl: "https://models.example.com/v1", secret: "sk-real-model-key" })
    });
    assert.equal(credentialResponse.status, 200);
    const credential = await credentialResponse.json();
    const endpoint = await fetch(baseUrl + apiPath(`/api/v1/projects/${project.id}/endpoints`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: login.sessionCookie,
        "x-csrf-token": login.csrfToken
      },
      body: JSON.stringify({
        name: "Member endpoint",
        protocol: "openai_chat_completions",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-compatible",
        credentialId: credential.id,
        capabilities: ["text", "tool_calls"],
        requestTimeoutSecs: 30
      })
    });
    assert.equal(endpoint.status, 200);

    const logout = await fetch(baseUrl + apiPath("/api/v1/auth/logout"), {
      method: "POST",
      headers: {
        cookie: login.sessionCookie,
        "x-csrf-token": login.csrfToken
      }
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /asl_session=;.*Max-Age=0/);
    assert.match(logout.headers.get("set-cookie") ?? "", /Path=\/app/);

    const oldSession = await fetch(baseUrl + apiPath("/api/v1/me"), {
      headers: { cookie: login.sessionCookie }
    });
    assert.equal(oldSession.status, 401);
  });

  it("rejects a bound OIDC email collision without returning identity details", async () => {
    const issuer = "https://keycloak.example.test/realms/agentsmith";
    await loginOidc({ issuer, subject: "email-collision-first", email: "collision-first@example.test", emailVerified: true });
    await loginOidc({ issuer, subject: "email-collision-second", email: "collision-second@example.test", emailVerified: true });
    oidcPrincipals.push({ issuer, subject: "email-collision-first", email: "collision-second@example.test", emailVerified: true });

    const start = await fetch(baseUrl + apiPath("/api/v1/auth/oidc/start"), { redirect: "manual" });
    const callback = await fetch(baseUrl + apiPath("/api/v1/auth/oidc/callback?code=collision-code&state=oidc-state-test"), {
      headers: { cookie: cookieFromSetCookie(start.headers.get("set-cookie")) },
      redirect: "manual"
    });

    assert.equal(callback.status, 401);
    const body = await callback.text();
    assert.equal(body.includes("collision-first@example.test"), false);
    assert.equal(body.includes("collision-second@example.test"), false);
    assert.equal(body.includes("email-collision-first"), false);
    assert.equal(body.includes("email-collision-second"), false);
  });

  it("returns to a validated application deep link after OIDC and rejects external targets", async () => {
    oidcPrincipals.push({ issuer: "https://keycloak.example.test/realms/agentsmith", subject: "return-to", email: "return-to@example.test", emailVerified: true });
    const start = await fetch(baseUrl + apiPath("/api/v1/auth/oidc/start?returnTo=%2Fapp%2Fworkspaces%2Fworkspace_1%2Fprojects%2Fproject_1%2Ftasks%3Ftab%3Devents"), { redirect: "manual" });
    const callback = await fetch(baseUrl + apiPath("/api/v1/auth/oidc/callback?code=return-to-code&state=oidc-state-test"), {
      headers: { cookie: cookieFromSetCookie(start.headers.get("set-cookie")) }, redirect: "manual"
    });
    assert.equal(callback.headers.get("location"), "/app/workspaces/workspace_1/projects/project_1/tasks?tab=events");

    oidcPrincipals.push({ issuer: "https://keycloak.example.test/realms/agentsmith", subject: "return-to-external", email: "return-to-external@example.test", emailVerified: true });
    const unsafeStart = await fetch(baseUrl + apiPath("/api/v1/auth/oidc/start?returnTo=https%3A%2F%2Fevil.example.test"), { redirect: "manual" });
    const unsafeCallback = await fetch(baseUrl + apiPath("/api/v1/auth/oidc/callback?code=unsafe-code&state=oidc-state-test"), {
      headers: { cookie: cookieFromSetCookie(unsafeStart.headers.get("set-cookie")) }, redirect: "manual"
    });
    assert.equal(unsafeCallback.headers.get("location"), "/app/");
  });

  async function post(pathname: string, body: unknown) {
    return fetch(baseUrl + apiPath(pathname), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async function loginOidc(principal: ExternalPrincipal): Promise<{
    sessionCookie: string;
    csrfToken: string;
    user: { id: string; email: string };
  }> {
    oidcPrincipals.push(principal);

    const start = await fetch(baseUrl + apiPath("/api/v1/auth/oidc/start"), { redirect: "manual" });
    assert.equal(start.status, 302);
    assert.equal(start.headers.get("location"), "https://idp.example.test/auth?state=oidc-state-test");
    assert.match(start.headers.get("set-cookie") ?? "", /asl_oidc_tx=.*Path=\/app\/api\/v1\/auth\/oidc/);
    assert.match(start.headers.get("set-cookie") ?? "", /asl_oidc_tx=.*; Secure$/);
    const transactionCookie = cookieFromSetCookie(start.headers.get("set-cookie"));
    assert.ok(transactionCookie.startsWith("asl_oidc_tx="));
    const authorizationCall = oidcCalls.at(-1);
    assert.equal(authorizationCall?.redirectUri, "https://agentsmith.example.test/app/api/v1/auth/oidc/callback");

    const callback = await fetch(baseUrl + apiPath("/api/v1/auth/oidc/callback?code=callback-code&state=oidc-state-test"), {
      headers: { cookie: transactionCookie },
      redirect: "manual"
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/app/");
    const callbackCookies = callback.headers.get("set-cookie") ?? "";
    const sessionCookie = cookieFromSetCookie(callbackCookies);
    assert.ok(sessionCookie.startsWith("asl_session="));
    assert.match(callbackCookies, /asl_session=.*Path=\/app/);
    assert.match(callbackCookies, /asl_session=.*; Secure/);
    assert.match(callbackCookies, /asl_oidc_tx=;/);
    assert.match(callbackCookies, /asl_oidc_tx=;.*Path=\/app\/api\/v1\/auth\/oidc/);
    const callbackCall = oidcCalls.at(-1);
    assert.equal(callbackCall?.state, "oidc-state-test");
    assert.equal(callbackCall?.codeVerifier, "oidc-code-verifier-test");
    assert.equal(callbackCall?.redirectUri, "https://agentsmith.example.test/app/api/v1/auth/oidc/callback");
    assert.match(callbackCall?.callbackUrl ?? "", /code=callback-code/);

    const meResponse = await fetch(baseUrl + apiPath("/api/v1/me"), {
      headers: { cookie: sessionCookie }
    });
    assert.equal(meResponse.status, 200);
    const me = await meResponse.json();
    return {
      sessionCookie,
      csrfToken: me.csrfToken,
      user: me.user
    };
  }

  function apiPath(pathname: string): string {
    return `${appBasePath}${pathname}`;
  }
});

describe("OIDC cookie transport", () => {
  it("keeps HTTP development public bases testable without Secure cookies", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-api-oidc-http-"));
    const api = await createApiServer({
      port: 0,
      dataRoot,
      authMode: "oidc",
      builtinAdminPassword: "builtin-password-must-not-work",
      sessionSecret: "oidc-session-secret-at-least-32-chars",
      publicBaseUrl: "http://agentsmith.example.test",
      oidcClient: fakeOidcClient([], [])
    });
    try {
      const start = await fetch(`${api.baseUrl}/api/v1/auth/oidc/start`, { redirect: "manual" });
      assert.equal(start.status, 302);
      assert.doesNotMatch(start.headers.get("set-cookie") ?? "", /; Secure(?:;|$)/);
    } finally {
      await api.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

function fakeOidcClient(calls: Array<Record<string, string | undefined>>, principals: ExternalPrincipal[]): OidcClientAdapter {
  return {
    async createAuthorizationRequest(input) {
      calls.push({ redirectUri: input.redirectUri });
      return {
        authorizationUrl: "https://idp.example.test/auth?state=oidc-state-test",
        state: "oidc-state-test",
        codeVerifier: "oidc-code-verifier-test",
        nonce: "oidc-nonce-test"
      };
    },
    async completeAuthorizationCallback(input) {
      calls.push({
        callbackUrl: input.callbackUrl,
        redirectUri: input.redirectUri,
        state: input.state,
        codeVerifier: input.codeVerifier,
        nonce: input.nonce
      });
      const principal = principals.shift();
      assert.ok(principal, "fake OIDC principal is required");
      return principal;
    }
  };
}

function cookieFromSetCookie(setCookie: string | null): string {
  assert.ok(setCookie, "set-cookie response header is required");
  return setCookie.split(",").find((part) => part.trim().startsWith("asl_"))?.trim().split(";")[0] ?? "";
}
