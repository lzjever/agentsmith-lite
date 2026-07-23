import type { Endpoint, TaskDetail } from "../../lib/api/client.js";
import { formatLocalDateTime } from "../../lib/format/date.js";

export function taskCompatibleEndpoints(endpoints: Endpoint[]): Endpoint[] {
  return endpoints.filter((endpoint) => endpoint.taskEligible);
}

export function taskEndpointGuidance(endpoints: Endpoint[]): string | null {
  if (endpoints.some((endpoint) => endpoint.taskEligible)) return null;
  if (endpoints.length === 0) return "Add an endpoint with text and tool-call support before creating a task.";
  const capable = endpoints.filter((endpoint) => endpoint.capabilities.includes("text") && endpoint.capabilities.includes("tool_calls"));
  if (capable.length === 0) return "Enable text and tool-call support on an endpoint before creating a task.";
  const configured = capable.filter((endpoint) => endpoint.hasCredentialRef);
  if (configured.length === 0) return "Attach a project credential to a task-capable endpoint before creating a task.";
  if (configured.some((endpoint) => endpoint.health?.status !== "healthy")) return "Check endpoint health successfully before creating a task.";
  return "Review endpoint configuration before creating a task.";
}

export function taskDetailNeedsRefresh(detail: Pick<TaskDetail, "currentTurn" | "sandboxState">): boolean {
  return detail.currentTurn.state !== "ready" || detail.sandboxState.state === "starting" || detail.sandboxState.state === "active" || detail.sandboxState.state === "release_requested";
}

export function taskProjectionLabel(detail: Pick<TaskDetail, "lifecycle" | "currentTurn" | "sandboxState">): string {
  if (detail.lifecycle.state === "archived") return "Archived";
  if (detail.sandboxState.state === "released") return "Sandbox released";
  if (detail.sandboxState.state === "failed") return "Sandbox unavailable";
  if (detail.sandboxState.state === "release_requested") return "Releasing sandbox";
  if (detail.sandboxState.state === "starting") return "Starting sandbox";
  if (detail.currentTurn.state === "ready") return "Ready";
  if (detail.currentTurn.state === "queued") return "Message queued";
  if (detail.currentTurn.state === "starting") return "Starting turn";
  if (detail.currentTurn.state === "running") return "Working";
  return "Stopping turn";
}

export function formatTaskDate(value: string): string {
  return formatLocalDateTime(value);
}

export function formatArtifactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
