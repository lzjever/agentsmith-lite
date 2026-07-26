import type { TaskDetail } from "../../lib/api/client.js";
import type { TaskCommandFence } from "./task-conversation-state.js";

export type TaskTerminalSurfaceState =
  | { kind: "unavailable"; presentation: TaskDetail }
  | { kind: "start"; presentation: TaskDetail }
  | { kind: "starting"; presentation: TaskDetail }
  | { kind: "active"; presentation: TaskDetail }
  | { kind: "cleanup_pending"; presentation: TaskDetail };

export type TerminalIntentState = {
  transportRequested: boolean;
  fence: {
    taskId: string;
    canonicalEpoch: number;
    runId: string | null;
  } | null;
  observation: CanonicalTerminalObservation | null;
  target: {
    fence: TaskCommandFence;
    targetRunId: string;
  } | null;
};

export type CanonicalTerminalObservation = {
  taskId: string;
  canonicalEpoch: number;
  runId: string | null;
  sandboxState: TaskDetail["sandboxState"]["state"];
  openTerminal: boolean;
};

export type TerminalIntentAction =
  | { type: "terminal_selected" }
  | { type: "history_restored" }
  | { type: "task_refreshed" }
  | { type: "view_left" }
  | { type: "connect_requested"; observation: CanonicalTerminalObservation }
  | {
      type: "canonical_observed";
      observation: CanonicalTerminalObservation;
    }
  | {
      type: "start_target_recorded";
      fence: TaskCommandFence;
      targetRunId: string;
    }
  | { type: "transport_terminated" }
  | { type: "start_progressed" }
  | { type: "start_failed" };

export function createTerminalIntentState(): TerminalIntentState {
  return {
    transportRequested: false,
    fence: null,
    observation: null,
    target: null
  };
}

export function reduceTerminalIntent(
  state: TerminalIntentState,
  action: TerminalIntentAction
): TerminalIntentState {
  switch (action.type) {
    case "canonical_observed":
      return observeCanonicalTerminal(state, action.observation);
    case "connect_requested": {
      const observed = observeCanonicalTerminal(state, action.observation);
      if (
        !sameTerminalObservation(observed.observation, action.observation)
        || !canonicalTerminalAvailable(action.observation)
      ) return observed;
      return {
        ...observed,
        transportRequested: true,
        fence: terminalFence(action.observation),
        target: null
      };
    }
    case "start_target_recorded":
      return recordTerminalTarget(state, action.fence, action.targetRunId);
    case "terminal_selected":
    case "history_restored":
    case "task_refreshed":
    case "view_left":
    case "transport_terminated":
    case "start_progressed":
    case "start_failed":
      return state.transportRequested || state.target
        ? { ...state, transportRequested: false, fence: null, target: null }
        : state;
    default:
      return assertNever(action);
  }
}

export function terminalSurfaceState(
  presentation: TaskDetail,
  explicitStartPending: boolean
): TaskTerminalSurfaceState {
  if (!presentation.capabilities.openTerminal) return { kind: "unavailable", presentation };
  if (
    presentation.sandboxState.state === "failed"
    || presentation.sandboxState.state === "release_requested"
  ) return { kind: "cleanup_pending", presentation };
  if (explicitStartPending) return { kind: "starting", presentation };
  if (presentation.sandboxState.state === "active") return { kind: "active", presentation };
  if (presentation.sandboxState.state === "starting") {
    return { kind: "starting", presentation };
  }
  return { kind: "start", presentation };
}

export function terminalTransportEnabled(
  state: TaskTerminalSurfaceState,
  intent: TerminalIntentState
): boolean {
  const presentation = state.presentation;
  return intent.transportRequested
    && presentation.capabilities.openTerminal
    && presentation.sandboxState.state === "active"
    && presentation.sandboxState.runId !== null
    && intent.fence?.taskId === presentation.task.id
    && intent.fence.runId === presentation.sandboxState.runId;
}

function observeCanonicalTerminal(
  state: TerminalIntentState,
  observation: CanonicalTerminalObservation
): TerminalIntentState {
  if (
    state.observation
    && observation.taskId === state.observation.taskId
    && observation.canonicalEpoch < state.observation.canonicalEpoch
  ) return state;
  const keepsTransport = state.transportRequested
    && state.fence?.taskId === observation.taskId
    && state.fence.runId === observation.runId
    && canonicalTerminalAvailable(observation);
  const next: TerminalIntentState = {
    transportRequested: keepsTransport,
    fence: keepsTransport ? state.fence : null,
    observation,
    target: state.target
  };
  return resolveTerminalTarget(next);
}

function canonicalTerminalAvailable(observation: CanonicalTerminalObservation): boolean {
  return observation.openTerminal
    && observation.sandboxState === "active"
    && observation.runId !== null;
}

function sameTerminalObservation(
  current: CanonicalTerminalObservation | null,
  observation: CanonicalTerminalObservation
): boolean {
  return current?.taskId === observation.taskId
    && current.canonicalEpoch === observation.canonicalEpoch
    && current.runId === observation.runId
    && current.sandboxState === observation.sandboxState
    && current.openTerminal === observation.openTerminal;
}

function terminalFence(
  observation: CanonicalTerminalObservation
): NonNullable<TerminalIntentState["fence"]> {
  return {
    taskId: observation.taskId,
    canonicalEpoch: observation.canonicalEpoch,
    runId: observation.runId
  };
}

function recordTerminalTarget(
  state: TerminalIntentState,
  fence: TaskCommandFence,
  targetRunId: string
): TerminalIntentState {
  const observation = state.observation;
  if (
    !observation
    || observation.taskId !== fence.taskId
    || (
      observation.runId !== fence.expectedRunId
      && observation.runId !== targetRunId
    )
  ) return state;
  return resolveTerminalTarget({
    ...state,
    transportRequested: false,
    fence: null,
    target: { fence, targetRunId }
  });
}

function resolveTerminalTarget(state: TerminalIntentState): TerminalIntentState {
  const target = state.target;
  const observation = state.observation;
  if (!target || !observation) return state;
  if (observation.taskId !== target.fence.taskId) {
    return { ...state, target: null };
  }
  if (observation.runId === target.targetRunId) {
    if (canonicalTerminalAvailable(observation)) {
      return {
        ...state,
        transportRequested: true,
        fence: terminalFence(observation),
        target: null
      };
    }
    return observation.sandboxState === "starting"
      ? state
      : { ...state, target: null };
  }
  if (
    observation.runId === target.fence.expectedRunId
    && observation.sandboxState === target.fence.expectedSandboxState
  ) return state;
  return { ...state, target: null };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Terminal intent: ${String(value)}`);
}
