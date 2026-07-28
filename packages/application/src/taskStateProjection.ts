import type {
  SandboxFailureCode,
  TaskCurrentTurnProjection,
  TaskSandboxFailureCause,
  TaskStateProjection
} from "../../contracts/src/api.js";
import type { PersistedSandboxRunState } from "../../ports/src/store.js";

export function projectTaskState(input: {
  archivedAt: string | null;
  run: Pick<PersistedSandboxRunState, "runId" | "state" | "failureCode" | "lastCleanupError" | "releaseRequestedAt"> | null;
  unavailableRunId?: string | null;
  turn: TaskCurrentTurnProjection["state"];
  now?:Date;
}): TaskStateProjection {
  const cause=publicSandboxCause(input.run,input.now??new Date());
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

const DELAYED_RELEASE_WARNING_MS=90_000;

function publicSandboxCause(
  run:Pick<PersistedSandboxRunState,"state"|"failureCode"|"lastCleanupError"|"releaseRequestedAt">|null,
  now:Date
):TaskSandboxFailureCause|null{
  if(!run)return null;
  if(run.state==="release_requested"){
    if(!run.lastCleanupError||!run.releaseRequestedAt)return null;
    const requestedAt=Date.parse(run.releaseRequestedAt);
    return Number.isFinite(requestedAt)&&now.getTime()-requestedAt>=DELAYED_RELEASE_WARNING_MS
      ?failureCause("cleanup_failed")
      :null;
  }
  return run.failureCode
    ?failureCause(run.failureCode)
    :run.lastCleanupError
      ?failureCause("cleanup_failed")
      :null;
}

function failureCause(code:SandboxFailureCode):TaskSandboxFailureCause{
  return{code,message:{
    startup_failed:"Sandbox startup did not complete. Release the sandbox to remove its resources.",
    runtime_unreachable:"The sandbox runtime became unavailable. Release the sandbox to remove its resources.",
    runner_failed:"The sandbox runtime stopped unexpectedly. Release the sandbox to remove its resources.",
    cleanup_failed:"Sandbox release is taking longer than expected. AgentSmith is still retrying automatically."
  }[code]};
}
