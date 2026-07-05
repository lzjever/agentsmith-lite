import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  optionalRuntimeTickIntervalMs,
  parseAuthMode,
  parseSandboxMode,
  parseSandboxNamespaceLimit
} from "../../packages/api-entry-node/src/runtimeConfig.js";
import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../packages/domain/src/sandboxDefaults.js";

describe("runtime config", () => {
  it("fails closed for deferred auth modes while allowing empty builtin admin defaults", () => {
    assert.equal(parseAuthMode(undefined), "builtin_admin");
    assert.equal(parseAuthMode(""), "builtin_admin");
    assert.equal(parseAuthMode("   "), "builtin_admin");
    assert.equal(parseAuthMode("builtin_admin"), "builtin_admin");
    assert.equal(parseAuthMode(" builtin_admin "), "builtin_admin");

    for (const value of ["oidc", "OIDC", "keycloak", "false", "0"]) {
      assert.throws(
        () => parseAuthMode(value),
        /AUTH_MODE must be empty or builtin_admin/
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
