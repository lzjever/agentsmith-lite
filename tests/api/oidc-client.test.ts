import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOpenIdConnectClient, rewriteOidcBackchannelRequest } from "../../packages/api-entry-node/src/oidcClient.js";

describe("OIDC client backchannel fetch", () => {
  it("discovers through the backchannel while keeping browser authorization on the public issuer", async () => {
    const issuerUrl = "https://keycloak.example.test/realms/agentsmith";
    const backchannelBaseUrl = "http://keycloak.keycloak.svc.cluster.local/realms/agentsmith";
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      requestedUrls.push(url);
      assert.equal(url, `${backchannelBaseUrl}/.well-known/openid-configuration`);
      assert.equal(init?.method, "GET");
      return new Response(
        JSON.stringify({
          issuer: issuerUrl,
          authorization_endpoint: `${issuerUrl}/protocol/openid-connect/auth`,
          token_endpoint: `${issuerUrl}/protocol/openid-connect/token`,
          end_session_endpoint: `${issuerUrl}/protocol/openid-connect/logout`,
          jwks_uri: `${issuerUrl}/protocol/openid-connect/certs`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    };

    try {
      const client = await createOpenIdConnectClient({
        issuerUrl,
        backchannelBaseUrl,
        clientId: "agentsmith-lite",
        clientSecret: "client-secret"
      });
      const request = await client.createAuthorizationRequest({
        redirectUri: "https://agentsmith.example.test/auth/oidc/callback"
      });
      const authorizationUrl = new URL(request.authorizationUrl);

      assert.deepEqual(requestedUrls, [`${backchannelBaseUrl}/.well-known/openid-configuration`]);
      assert.equal(authorizationUrl.origin + authorizationUrl.pathname, `${issuerUrl}/protocol/openid-connect/auth`);
      assert.equal(authorizationUrl.searchParams.get("client_id"), "agentsmith-lite");
      assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://agentsmith.example.test/auth/oidc/callback");
      assert.doesNotMatch(request.authorizationUrl, /keycloak\.keycloak\.svc\.cluster\.local/);

      const endSessionUrl = new URL(client.createEndSessionUrl({
        postLogoutRedirectUri: "https://agentsmith.example.test/app/"
      }));
      assert.equal(endSessionUrl.origin + endSessionUrl.pathname, `${issuerUrl}/protocol/openid-connect/logout`);
      assert.equal(endSessionUrl.searchParams.get("client_id"), "agentsmith-lite");
      assert.equal(endSessionUrl.searchParams.get("post_logout_redirect_uri"), "https://agentsmith.example.test/app/");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rewrites only public issuer URL requests to the backchannel base while preserving request details", async () => {
    const body = JSON.stringify({ code: "abc" });
    const original = new Request("https://keycloak.example.test/realms/agentsmith/protocol/openid-connect/token?x=1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request": "keep" },
      body
    });

    const rewritten = rewriteOidcBackchannelRequest(
      original,
      "https://keycloak.example.test/realms/agentsmith",
      "http://keycloak.keycloak.svc.cluster.local/realms/agentsmith"
    );

    assert.ok(rewritten instanceof Request);
    assert.equal(rewritten.url, "http://keycloak.keycloak.svc.cluster.local/realms/agentsmith/protocol/openid-connect/token?x=1");
    assert.equal(rewritten.method, "POST");
    assert.equal(rewritten.headers.get("content-type"), "application/json");
    assert.equal(rewritten.headers.get("x-request"), "keep");
    assert.equal(await rewritten.text(), body);
  });

  it("does not rewrite near-prefix or unrelated requests", () => {
    assert.equal(
      rewriteOidcBackchannelRequest(
        "https://keycloak.example.test/realms/agentsmith-other/.well-known/openid-configuration",
        "https://keycloak.example.test/realms/agentsmith",
        "http://keycloak.keycloak.svc.cluster.local/realms/agentsmith"
      ),
      "https://keycloak.example.test/realms/agentsmith-other/.well-known/openid-configuration"
    );
    assert.equal(
      rewriteOidcBackchannelRequest(
        "https://other.example.test/realms/agentsmith/.well-known/openid-configuration",
        "https://keycloak.example.test/realms/agentsmith",
        "http://keycloak.keycloak.svc.cluster.local/realms/agentsmith"
      ),
      "https://other.example.test/realms/agentsmith/.well-known/openid-configuration"
    );
  });
});
