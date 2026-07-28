import type {
  SandboxFailureCode,
  TaskCurrentTurnProjection,
  TaskSandboxFailureCause,
  TaskStateProjection
} from "../../contracts/src/api.js";
import type { PersistedSandboxRunState } from "../../ports/src/store.js";

export function projectTaskState(input: {
  archivedAt: string | null;
  run: Pick<PersistedSandboxRunState, "runId" | "state" | "failureCode" | "lastCleanupError"> | null;
  unavailableRunId?: string | null;
  turn: TaskCurrentTurnProjection["state"];
}): TaskStateProjection {
  const cause=input.run?.lastCleanupError
    ? failureCause("cleanup_failed")
    : input.run?.failureCode
      ? failureCause(input.run.failureCode)
      : null;
  return {
    lifecycle:{ state:input.archivedAt ? "archived" : "active" },
    currentTurn:{ state:input.turn },
    sandboxState:input.run ? {
      state:input.run.state,
      runId:input.run.runId,
      cause:input.run.state === "failed" || input.run.state === "release_requested"
        ? cause
        : null
    } : input.unavailableRunId ? {
      state:"failed",
      runId:input.unavailableRunId,
      cause:{code:"runtime_unreachable",message:"Sandbox ownership information is unavailable."}
    } : {
      state:"released",
      runId:null,
      cause:null
    }
  };
}

function failureCause(code:SandboxFailureCode):TaskSandboxFailureCause{
  return{code,message:{
    startup_failed:"Sandbox startup did not complete. Retry release to remove its resources.",
    runtime_unreachable:"The sandbox runtime became unavailable. Retry release to remove its resources.",
    runner_failed:"The sandbox runtime stopped unexpectedly. Retry release to remove its resources.",
    cleanup_failed:"Sandbox cleanup could not be completed. Retry release to try again."
  }[code]};
}
