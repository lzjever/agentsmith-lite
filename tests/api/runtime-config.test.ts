import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { optionalRuntimeTickIntervalMs } from "../../packages/api-entry-node/src/runtimeConfig.js";

describe("runtime config", () => {
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
