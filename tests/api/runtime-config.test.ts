import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import {
  DEFAULT_API_BIND_ADDRESS,
  optionalLiveSandboxDurationMs,
  optionalRuntimeTickIntervalMs,
  parseApiBindAddress,
  parseAuthMode,
  parseRuntimeAuthConfig,
  parseSandboxMode,
  parseSandboxNamespaceLimit,
  requireCredentialEncryptionConfig,
  requireOidcRuntimeConfig
} from "../../packages/api-entry-node/src/runtimeConfig.js";
import { randomBytes } from "node:crypto";
import { createTestApiServer } from "../../packages/api-entry-node/src/server.js";
import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../packages/domain/src/sandboxDefaults.js";

describe("runtime config", () => {
  it("requires a base64url credential encryption primary key and accepts a previous key ring", () => {
    const primary = randomBytes(32).toString("base64url");
    const previous = randomBytes(32).toString("base64url");
    const config = requireCredentialEncryptionConfig({
      APP_CREDENTIAL_ENCRYPTION_KEY: primary,
      APP_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: previous
    });
    assert.equal(config.previous.length, 1);
    assert.throws(() => requireCredentialEncryptionConfig({}), /APP_CREDENTIAL_ENCRYPTION_KEY/);
  });

  it("defaults the API listener to loopback and accepts an explicit pod interface", () => {
    assert.equal(parseApiBindAddress(undefined), DEFAULT_API_BIND_ADDRESS);
    assert.equal(parseApiBindAddress("   "), DEFAULT_API_BIND_ADDRESS);
    assert.equal(parseApiBindAddress(" 0.0.0.0 "), "0.0.0.0");
  });

  it("listens on the configured pod interface", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "agentsmith-api-bind-"));
    const server = await createTestApiServer({
      port: 0,
      host: parseApiBindAddress("0.0.0.0"),
      dataRoot,
      builtinAdminPassword: "admin-password"
    });

    try {
      assert.equal(server.listenAddress, "0.0.0.0");
    } finally {
      await server.close();
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("accepts only explicit OIDC auth mode in production runtime config", () => {
    assert.equal(parseAuthMode("oidc"), "oidc");
    assert.equal(parseAuthMode(" oidc "), "oidc");

    for (const value of [undefined, "", "   ", "builtin_admin", "OIDC", "keycloak", "false", "0"]) {
      assert.throws(
        () => parseAuthMode(value),
        /AUTH_MODE must be explicitly set to oidc/
      );
    }
  });

  it("requires explicit complete OIDC configuration for the production runtime", () => {
    assert.throws(() => parseRuntimeAuthConfig({}), /AUTH_MODE/);
    assert.throws(
      () => parseRuntimeAuthConfig({ AUTH_MODE: "builtin_admin" }),
      /AUTH_MODE/
    );
    assert.throws(
      () => parseRuntimeAuthConfig({ AUTH_MODE: "oidc" }),
      /OIDC_ISSUER_URL/
    );
    assert.deepEqual(parseRuntimeAuthConfig({
      AUTH_MODE: "oidc",
      OIDC_ISSUER_URL: "https://keycloak.example.test/realms/agentsmith",
      OIDC_CLIENT_ID: "agentsmith-lite",
      OIDC_CLIENT_SECRET: "client-secret"
    }), {
      mode: "oidc",
      oidc: {
        issuerUrl: "https://keycloak.example.test/realms/agentsmith",
        clientId: "agentsmith-lite",
        clientSecret: "client-secret"
      }
    });
  });

  it("requires shaped non-empty OIDC runtime config when AUTH_MODE=oidc", () => {
    assert.deepEqual(parseRuntimeAuthConfig({
      AUTH_MODE: "oidc",
      OIDC_ISSUER_URL: " https://keycloak.example.test/realms/agentsmith ",
      OIDC_BACKCHANNEL_BASE_URL: " http://keycloak.keycloak.svc.cluster.local/realms/agentsmith ",
      OIDC_CLIENT_ID: " agentsmith-lite ",
      OIDC_CLIENT_SECRET: " client-secret "
    }), {
      mode: "oidc",
      oidc: {
        issuerUrl: "https://keycloak.example.test/realms/agentsmith",
        backchannelBaseUrl: "http://keycloak.keycloak.svc.cluster.local/realms/agentsmith",
        clientId: "agentsmith-lite",
        clientSecret: "client-secret"
      }
    });

    for (const env of [
      { AUTH_MODE: "oidc", OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "secret" },
      { AUTH_MODE: "oidc", OIDC_ISSUER_URL: "ftp://issuer.example.test", OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "secret" },
      { AUTH_MODE: "oidc", OIDC_ISSUER_URL: "https://issuer.example.test", OIDC_BACKCHANNEL_BASE_URL: "ftp://keycloak", OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "secret" },
      { AUTH_MODE: "oidc", OIDC_ISSUER_URL: "https://issuer.example.test", OIDC_CLIENT_SECRET: "secret" },
      { AUTH_MODE: "oidc", OIDC_ISSUER_URL: "https://issuer.example.test", OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "" }
    ]) {
      assert.throws(
        () => requireOidcRuntimeConfig(env),
        /OIDC_(ISSUER_URL|BACKCHANNEL_BASE_URL|CLIENT_ID|CLIENT_SECRET)/
      );
    }

  });

  it("parses sandbox mode fail-closed except for empty dry-run defaults", () => {
    assert.equal(parseSandboxMode(undefined), "dry-run");
    assert.equal(parseSandboxMode(""), "dry-run");
    assert.equal(parseSandboxMode("   "), "dry-run");
    assert.equal(parseSandboxMode("dry-run"), "dry-run");
    assert.equal(parseSandboxMode(" live "), "live");

    for (const value of ["liv", "LIVE", "dryrun", "false", "0"]) {
      assert.throws(
        () => parseSandboxMode(value),
        /AGENTSMITH_LITE_SANDBOX_MODE must be either dry-run or live/
      );
    }
  });

  it("parses only strict positive integer tick intervals", () => {
    assert.equal(optionalRuntimeTickIntervalMs(undefined), undefined);
    assert.equal(optionalRuntimeTickIntervalMs(""), undefined);
    assert.equal(optionalRuntimeTickIntervalMs(" 5000 "), 5000);

    for (const value of ["0", "-1", "+1", "01", "5000ms", "1.5", "Infinity", "9007199254740992"]) {
      assert.throws(
        () => optionalRuntimeTickIntervalMs(value),
        /AGENTSMITH_LITE_RUNTIME_TICK_MS must be a positive integer/
      );
    }
  });

  it("parses optional live sandbox duration overrides", () => {
    assert.equal(optionalLiveSandboxDurationMs(undefined, "AGENTSMITH_LITE_SANDBOX_IDLE_TTL_MS"), undefined);
    assert.equal(optionalLiveSandboxDurationMs(" 60000 ", "AGENTSMITH_LITE_SANDBOX_IDLE_TTL_MS"), 60_000);
    assert.throws(
      () => optionalLiveSandboxDurationMs("0", "AGENTSMITH_LITE_SANDBOX_MAX_LIFETIME_MS"),
      /AGENTSMITH_LITE_SANDBOX_MAX_LIFETIME_MS must be a positive integer/
    );
  });

  it("parses namespace sandbox limits with the product default and fail-closed invalid values", () => {
    assert.equal(parseSandboxNamespaceLimit(undefined), DEFAULT_SANDBOX_NAMESPACE_LIMIT);
    assert.equal(parseSandboxNamespaceLimit(""), DEFAULT_SANDBOX_NAMESPACE_LIMIT);
    assert.equal(parseSandboxNamespaceLimit("   "), DEFAULT_SANDBOX_NAMESPACE_LIMIT);
    assert.equal(parseSandboxNamespaceLimit(" 12 "), 12);

    for (const value of ["0", "-1", "+1", "01", "20.5", "twenty", "Infinity", "9007199254740992"]) {
      assert.throws(
        () => parseSandboxNamespaceLimit(value),
        /AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT must be a positive integer/
      );
    }
  });
});
