import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApiServer } from "../../packages/api-entry-node/src/server.js";
import type { OidcClientAdapter } from "../../packages/api-entry-node/src/oidcClient.js";

describe("api OIDC auth", () => {
  let baseUrl = "";
  let closeServer: undefined | (() => Promise<void>);
  let dataRoot = "";
  const oidcCalls: Array<Record<string, string | undefined>> = [];

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-api-oidc-"));
    const api = await createApiServer({
      port: 0,
      dataRoot,
      authMode: "oidc",
      builtinAdminPassword: "builtin-password-must-not-work",
      sessionSecret: "oidc-session-secret-at-least-32-chars",
      publicBaseUrl: "https://agentsmith.example.test/app",
      oidcClient: fakeOidcClient(oidcCalls)
    });
    baseUrl = api.baseUrl;
    closeServer = api.close;
  });

  after(async () => {
    await closeServer?.();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("fails builtin endpoints closed and completes fake OIDC login into the existing session cookie", async () => {
    const bootstrap = await fetch(baseUrl + "/api/bootstrap").then((response) => response.json());
    assert.equal(bootstrap.authMode, "oidc");

    const builtinBootstrap = await post("/api/auth/bootstrap", { password: "builtin-password-must-not-work" });
    assert.equal(builtinBootstrap.status, 404);
    const builtinLogin = await post("/api/auth/login", {
      email: "admin@agentsmith-lite.local",
      password: "builtin-password-must-not-work"
    });
    assert.equal(builtinLogin.status, 404);

    const start = await fetch(baseUrl + "/api/auth/oidc/start", { redirect: "manual" });
    assert.equal(start.status, 302);
    assert.equal(start.headers.get("location"), "https://idp.example.test/auth?state=oidc-state-test");
    const transactionCookie = cookieFromSetCookie(start.headers.get("set-cookie"));
    assert.ok(transactionCookie.startsWith("asl_oidc_tx="));
    assert.equal(oidcCalls[0]?.redirectUri, "https://agentsmith.example.test/app/api/auth/oidc/callback");

    const callback = await fetch(baseUrl + "/api/auth/oidc/callback?code=callback-code&state=oidc-state-test", {
      headers: { cookie: transactionCookie },
      redirect: "manual"
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/");
    const callbackCookies = callback.headers.get("set-cookie") ?? "";
    const sessionCookie = cookieFromSetCookie(callbackCookies);
    assert.ok(sessionCookie.startsWith("asl_session="));
    assert.match(callbackCookies, /asl_oidc_tx=;/);
    assert.equal(oidcCalls[1]?.state, "oidc-state-test");
    assert.equal(oidcCalls[1]?.codeVerifier, "oidc-code-verifier-test");
    assert.equal(oidcCalls[1]?.redirectUri, "https://agentsmith.example.test/app/api/auth/oidc/callback");
    assert.match(oidcCalls[1]?.callbackUrl ?? "", /code=callback-code/);

    const meResponse = await fetch(baseUrl + "/api/me", {
      headers: { cookie: sessionCookie }
    });
    assert.equal(meResponse.status, 200);
    const me = await meResponse.json();
    assert.match(me.user.id, /^user_oidc_/);
    assert.equal(me.user.email, "oidc.admin@example.test");
    assert.equal(me.user.role, "admin");
    assert.match(me.csrfToken, /^csrf_/);

    const missingCsrf = await fetch(baseUrl + "/api/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie
      },
      body: JSON.stringify({ name: "Missing CSRF" })
    });
    assert.equal(missingCsrf.status, 403);

    const workspace = await fetch(baseUrl + "/api/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
        "x-csrf-token": me.csrfToken
      },
      body: JSON.stringify({ name: "OIDC Workspace" })
    });
    assert.equal(workspace.status, 200);

    const logout = await fetch(baseUrl + "/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        "x-csrf-token": me.csrfToken
      }
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /asl_session=;.*Max-Age=0/);
  });

  async function post(pathname: string, body: unknown) {
    return fetch(baseUrl + pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }
});

function fakeOidcClient(calls: Array<Record<string, string | undefined>>): OidcClientAdapter {
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
      return {
        issuer: "https://keycloak.example.test/realms/agentsmith",
        subject: "keycloak-admin-subject",
        email: "OIDC.Admin@Example.Test"
      };
    }
  };
}

function cookieFromSetCookie(setCookie: string | null): string {
  assert.ok(setCookie, "set-cookie response header is required");
  return setCookie.split(",").find((part) => part.trim().startsWith("asl_"))?.trim().split(";")[0] ?? "";
}
