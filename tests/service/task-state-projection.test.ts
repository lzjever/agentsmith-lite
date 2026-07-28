import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectTaskState } from "../../packages/application/src/taskStateProjection.js";

describe("Task state projection", () => {
  it("keeps Task lifecycle independent from Turn and Run state", () => {
    assert.deepEqual(projectTaskState({
      archivedAt:null,
      run:{ runId:"run_1", state:"failed", failureCode:"startup_failed", lastCleanupError:null, releaseRequestedAt:"2026-07-23T00:00:00.000Z" },
      turn:"ready"
    }), {
      lifecycle:{ state:"active" },
      currentTurn:{ state:"ready" },
      sandboxState:{ state:"failed", runId:"run_1", cause:{code:"startup_failed",message:"Sandbox startup did not complete. Release the sandbox to remove its resources."} }
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

  it("keeps transient cleanup failures private during the first 90 seconds of release", () => {
    assert.deepEqual(projectTaskState({
      archivedAt:"2026-07-23T00:00:00.000Z",
      run:{
        runId:"run_2",
        state:"release_requested",
        failureCode:"runner_failed",
        releaseRequestedAt:"2026-07-23T00:00:00.000Z",
        lastCleanupError:{at:"2026-07-23T00:00:30.000Z",target:"Pod/runtime",message:"transient"}
      },
      turn:"ready",
      now:new Date("2026-07-23T00:01:29.999Z")
    }), {
      lifecycle:{ state:"archived" },
      currentTurn:{ state:"ready" },
      sandboxState:{ state:"release_requested", runId:"run_2", cause:null }
    });
  });

  it("exposes an automatic-retry warning after 90 seconds while cleanup still fails", () => {
    const projected=projectTaskState({
      archivedAt:null,
      run:{
        runId:"run_3",
        state:"release_requested",
        failureCode:"runner_failed",
        releaseRequestedAt:"2026-07-23T00:00:00.000Z",
        lastCleanupError:{at:"2026-07-23T00:01:29.000Z",target:"Secret/runtime",message:"Bearer sk-runtime-secret"}
      },
      turn:"ready",
      now:new Date("2026-07-23T00:01:30.000Z")
    });
    assert.deepEqual(projected.sandboxState.cause,{
      code:"cleanup_failed",
      message:"Sandbox release is taking longer than expected. AgentSmith is still retrying automatically."
    });
  });

  it("removes the delayed warning after cleanup recovers", () => {
    const projected=projectTaskState({
      archivedAt:null,
      run:{
        runId:"run_4",
        state:"release_requested",
        failureCode:"runner_failed",
        releaseRequestedAt:"2026-07-23T00:00:00.000Z",
        lastCleanupError:null
      },
      turn:"ready",
      now:new Date("2026-07-23T00:03:00.000Z")
    });
    assert.equal(projected.sandboxState.cause,null);
  });
});
