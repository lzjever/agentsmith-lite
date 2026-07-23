import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectTaskState } from "../../packages/application/src/taskStateProjection.js";

describe("Task state projection", () => {
  it("keeps Task lifecycle independent from Turn and Run state", () => {
    assert.deepEqual(projectTaskState({
      archivedAt:null,
      run:{ runId:"run_1", state:"failed", failureCode:"startup_failed", lastCleanupError:null },
      turn:"ready"
    }), {
      lifecycle:{ state:"active" },
      currentTurn:{ state:"ready" },
      sandboxState:{ state:"failed", runId:"run_1", cause:{code:"startup_failed",message:"Sandbox startup did not complete. Retry release to remove its resources."} }
    });
  });

  it("projects no Run as a released sandbox that can cold start", () => {
    assert.deepEqual(projectTaskState({ archivedAt:null, run:null, turn:"queued" }), {
      lifecycle:{ state:"active" },
      currentTurn:{ state:"queued" },
      sandboxState:{ state:"released", runId:null, cause:null }
    });
  });

  it("fails closed when a Task points to a missing or mismatched Run", () => {
    const projected=projectTaskState({
      archivedAt:null,
      run:null,
      unavailableRunId:"run_missing",
      turn:"ready"
    });
    assert.deepEqual(projected.sandboxState,{
      state:"failed",
      runId:"run_missing",
      cause:{
        code:"runtime_unreachable",
        message:"Sandbox ownership information is unavailable."
      }
    });
  });

  it("retains a safe failure cause while failed resources await release", () => {
    assert.deepEqual(projectTaskState({
      archivedAt:"2026-07-23T00:00:00.000Z",
      run:{ runId:"run_2", state:"release_requested", failureCode:"runner_failed", lastCleanupError:null },
      turn:"ready"
    }), {
      lifecycle:{ state:"archived" },
      currentTurn:{ state:"ready" },
      sandboxState:{ state:"release_requested", runId:"run_2", cause:{code:"runner_failed",message:"The sandbox runtime stopped unexpectedly. Retry release to remove its resources."} }
    });
  });

  it("projects cleanup failures without exposing persisted infrastructure detail", () => {
    const projected=projectTaskState({
      archivedAt:null,
      run:{runId:"run_3",state:"release_requested",failureCode:"runner_failed",lastCleanupError:{at:"2026-07-23T00:00:00.000Z",target:"Secret/runtime",message:"Bearer sk-runtime-secret"}},
      turn:"ready"
    });
    assert.deepEqual(projected.sandboxState.cause,{code:"cleanup_failed",message:"Sandbox cleanup could not be completed. Retry release to try again."});
  });
});
