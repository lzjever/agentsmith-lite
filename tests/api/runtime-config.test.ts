import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { optionalRuntimeTickIntervalMs, parseSandboxMode } from "../../packages/api-entry-node/src/runtimeConfig.js";

describe("runtime config", () => {
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
});
