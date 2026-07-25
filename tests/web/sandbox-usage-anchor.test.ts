import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideSandboxUsageAnchorActivation,
  type SandboxUsageAnchorActivationState
} from "../../src/components/resources/sandbox-usage-anchor.js";

describe("Sandbox usage anchor activation", () => {
  it("waits through loading, activates once after overview load, and ignores refreshes", () => {
    let state: SandboxUsageAnchorActivationState = { activated: false };

    let decision = decideSandboxUsageAnchorActivation(state, {
      hash: "#sandbox-usage",
      overviewLoaded: false
    });
    assert.equal(decision.activate, false);
    assert.deepEqual(decision.state, { activated: false });

    decision = decideSandboxUsageAnchorActivation(decision.state, {
      hash: "#sandbox-usage",
      overviewLoaded: true
    });
    assert.equal(decision.activate, true);
    assert.deepEqual(decision.state, { activated: true });

    decision = decideSandboxUsageAnchorActivation(decision.state, {
      hash: "#sandbox-usage",
      overviewLoaded: true
    });
    assert.equal(decision.activate, false);
    assert.deepEqual(decision.state, { activated: true });
  });

  it("does nothing for every other hash", () => {
    for (const hash of ["", "#sandbox-usage-history", "#usage-limits"]) {
      const decision = decideSandboxUsageAnchorActivation(
        { activated: false },
        { hash, overviewLoaded: true }
      );
      assert.equal(decision.activate, false, hash);
      assert.deepEqual(decision.state, { activated: false });
    }
  });
});
