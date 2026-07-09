import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  optionalRuntimeTickIntervalMs,
  parseAuthMode,
  parseRuntimeAuthConfig,
  parseSandboxMode,
  parseSandboxNamespaceLimit,
  requireOidcRuntimeConfig
} from "../../packages/api-entry-node/src/runtimeConfig.js";
import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../packages/domain/src/sandboxDefaults.js";

describe("runtime config", () => {
  it("parses builtin admin and OIDC auth modes while keeping empty values on the builtin default", () => {
    assert.equal(parseAuthMode(undefined), "builtin_admin");
    assert.equal(parseAuthMode(""), "builtin_admin");
    assert.equal(parseAuthMode("   "), "builtin_admin");
    assert.equal(parseAuthMode("builtin_admin"), "builtin_admin");
    assert.equal(parseAuthMode(" builtin_admin "), "builtin_admin");
    assert.equal(parseAuthMode("oidc"), "oidc");
    assert.equal(parseAuthMode(" oidc "), "oidc");

    for (const value of ["OIDC", "keycloak", "false", "0"]) {
      assert.throws(
        () => parseAuthMode(value),
        /AUTH_MODE must be empty, builtin_admin, or oidc/
      );
    }
  });

  it("requires shaped non-empty OIDC runtime config only when AUTH_MODE=oidc", () => {
    assert.deepEqual(parseRuntimeAuthConfig({}), { mode: "builtin_admin" });
    assert.deepEqual(parseRuntimeAuthConfig({
      AUTH_MODE: "builtin_admin",
      OIDC_ISSUER_URL: "",
      OIDC_CLIENT_ID: "",
      OIDC_CLIENT_SECRET: "",
      OIDC_BACKCHANNEL_BASE_URL: "",
      OIDC_ADMIN_EMAILS: "",
      OIDC_ADMIN_SUBJECTS: ""
    }), { mode: "builtin_admin" });

    for (const key of [
      "OIDC_ISSUER_URL",
      "OIDC_BACKCHANNEL_BASE_URL",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "OIDC_ADMIN_EMAILS",
      "OIDC_ADMIN_SUBJECTS"
    ]) {
      assert.throws(
        () => parseRuntimeAuthConfig({ AUTH_MODE: "builtin_admin", [key]: "DO_NOT_PRINT_OIDC_VALUE" }),
        new RegExp(`${key} must be empty when AUTH_MODE=builtin_admin`)
      );
    }

    assert.deepEqual(parseRuntimeAuthConfig({
      AUTH_MODE: "oidc",
      OIDC_ISSUER_URL: " https://keycloak.example.test/realms/agentsmith ",
      OIDC_BACKCHANNEL_BASE_URL: " http://keycloak.keycloak.svc.cluster.local/realms/agentsmith ",
      OIDC_CLIENT_ID: " agentsmith-lite ",
      OIDC_CLIENT_SECRET: " client-secret ",
      OIDC_ADMIN_EMAILS: " OIDC.Admin@Example.Test, ops@example.test ,, ",
      OIDC_ADMIN_SUBJECTS: " keycloak-admin-subject, service-account-admin "
    }), {
      mode: "oidc",
      oidc: {
        issuerUrl: "https://keycloak.example.test/realms/agentsmith",
        backchannelBaseUrl: "http://keycloak.keycloak.svc.cluster.local/realms/agentsmith",
        clientId: "agentsmith-lite",
        clientSecret: "client-secret",
        adminEmails: ["oidc.admin@example.test", "ops@example.test"],
        adminSubjects: ["keycloak-admin-subject", "service-account-admin"]
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
