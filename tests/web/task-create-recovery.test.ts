import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "../../src/lib/api/client.js";
import {
  sandboxCapacityRecovery,
  sandboxCapacityRecoveryActions
} from "../../src/components/tasks/sandbox-capacity-recovery.js";

describe("task creation recovery", () => {
  it("preserves project capacity counts and derives current member/admin actions at render time", () => {
    const error = new ApiError(409, "Project Sandbox capacity reached", {
      code: "project_sandbox_capacity_reached",
      retryable: true,
      details: { activeSandboxes: 3, sandboxLimit: 3 },
      presentation: null
    });
    const recovery = sandboxCapacityRecovery(error);
    assert.deepEqual(recovery, {
      kind: "project_capacity",
      title: "Project Sandbox capacity reached",
      message: "Project Sandbox capacity reached",
      activeSandboxes: 3,
      sandboxLimit: 3,
      guidance: "3 of 3 live Sandboxes are in use. Release one of your Sandboxes or try again later."
    });
    assert.deepEqual(sandboxCapacityRecoveryActions(recovery!, false), {
      showActiveSandboxes: true,
      showPolicy: false
    });
    assert.deepEqual(sandboxCapacityRecoveryActions(recovery!, true), {
      showActiveSandboxes: true,
      showPolicy: true
    });
  });

  it("always links substrate recovery to active Sandboxes without Policy", () => {
    const error = new ApiError(503, "Local Sandbox capacity unavailable", {
      code: "substrate_sandbox_capacity_reached",
      retryable: true,
      details: null,
      presentation: null
    });
    const recovery = sandboxCapacityRecovery(error);
    assert.deepEqual(recovery, {
      kind: "substrate_capacity",
      title: "Local Sandbox capacity unavailable",
      message: "Local Sandbox capacity unavailable",
      guidance: "Live Sandboxes are using the available local capacity. Release one of your Sandboxes or try again later."
    });
    assert.deepEqual(sandboxCapacityRecoveryActions(recovery!, false), {
      showActiveSandboxes: true,
      showPolicy: false
    });
    assert.deepEqual(sandboxCapacityRecoveryActions(recovery!, true), {
      showActiveSandboxes: true,
      showPolicy: false
    });
  });
});
