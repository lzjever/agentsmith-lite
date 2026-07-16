import type { Endpoint, TaskStatus } from "../../lib/api/client.js";

export const activeTaskStatuses = new Set<TaskStatus>(["queued", "starting", "running", "stopping"]);

export function isActiveTask(status: TaskStatus): boolean {
  return activeTaskStatuses.has(status);
}

export function taskCompatibleEndpoints(endpoints: Endpoint[]): Endpoint[] {
  return endpoints.filter((endpoint) => endpoint.taskEligible);
}

export function taskStatusLabel(status: TaskStatus): string {
  return status === "cleaned" ? "Cleaned up" : status.replaceAll("_", " ");
}

export function taskStateCopy(task: Pick<import("../../lib/api/client").Task, "status" | "terminalReason" | "executionMode" | "artifactProjectionStatus" | "cleanupStatus">): string {
  if (task.executionMode === "dry-run" && task.terminalReason === "not_executed") return "Dry run completed without sandbox execution.";
  if (task.status === "stopping") return "Cancellation is in progress. Sandbox cleanup may take a moment.";
  if (task.status === "failed") return "This task ended with a failure. Review the activity timeline for the safe failure details.";
  if (task.status === "cancelled" || task.terminalReason === "cancelled") return "This task was cancelled and its app-owned sandbox resources are being reaped.";
  if (task.status === "expired" || task.terminalReason === "expired") return "This task reached its sandbox time limit.";
  if (task.artifactProjectionStatus === "draining") return "Finishing artifact projection before sandbox cleanup.";
  if (task.artifactProjectionStatus === "failed") return "Artifact projection needs recovery before sandbox cleanup can finish.";
  if (task.cleanupStatus === "running") return "Sandbox cleanup is in progress.";
  if (task.cleanupStatus === "failed") return "Sandbox cleanup needs recovery.";
  if (task.status === "starting" || task.status === "queued") return "Preparing the sandbox.";
  if (task.status === "running") return "The sandbox is processing this task.";
  return "Task execution is complete.";
}

export function formatTaskDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatArtifactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
