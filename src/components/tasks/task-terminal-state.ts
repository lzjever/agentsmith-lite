import type { TaskDetail } from "../../lib/api/client.js";

export type TaskTerminalSurfaceState =
  | { kind: "unavailable"; presentation: TaskDetail }
  | { kind: "start"; presentation: TaskDetail }
  | { kind: "starting"; presentation: TaskDetail }
  | { kind: "active"; presentation: TaskDetail }
  | { kind: "cleanup_pending"; presentation: TaskDetail };

export type TerminalIntentState = {
  transportRequested: boolean;
};

export type TerminalIntentAction =
  | { type: "terminal_selected" }
  | { type: "history_restored" }
  | { type: "task_refreshed" }
  | { type: "view_left" }
  | { type: "connect_requested" }
  | {
      type: "sandbox_observed";
      sandboxState: TaskDetail["sandboxState"]["state"];
    }
  | { type: "transport_terminated" }
  | { type: "start_progressed" }
  | {
      type: "start_completed";
      receiptStatus: "active" | "in_progress";
      sandboxState: TaskDetail["sandboxState"]["state"];
    }
  | { type: "start_failed" };

export function createTerminalIntentState(): TerminalIntentState {
  return { transportRequested: false };
}

export function reduceTerminalIntent(
  state: TerminalIntentState,
  action: TerminalIntentAction
): TerminalIntentState {
  switch (action.type) {
    case "connect_requested":
      return state.transportRequested ? state : { transportRequested: true };
    case "sandbox_observed":
      return action.sandboxState === "active" || !state.transportRequested
        ? state
        : { transportRequested: false };
    case "start_completed":
      return action.receiptStatus === "active" && action.sandboxState === "active"
        ? { transportRequested: true }
        : { transportRequested: false };
    case "terminal_selected":
    case "history_restored":
    case "task_refreshed":
    case "view_left":
    case "transport_terminated":
    case "start_progressed":
    case "start_failed":
      return state.transportRequested ? { transportRequested: false } : state;
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
  transportRequested: boolean
): boolean {
  return state.presentation.sandboxState.state === "active" && transportRequested;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Terminal intent: ${String(value)}`);
}
