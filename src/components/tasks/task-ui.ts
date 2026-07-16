import type { Endpoint, Task, TaskStatus } from "../../lib/api/client.js";

export const activeTaskStatuses = new Set<TaskStatus>(["queued", "starting", "running", "stopping"]);

export function isActiveTask(status: TaskStatus): boolean {
  return activeTaskStatuses.has(status);
}

export function taskCompatibleEndpoints(endpoints: Endpoint[]): Endpoint[] {
  return endpoints.filter((endpoint) => endpoint.taskEligible);
}

export function taskStatusLabel(status: TaskStatus): string {
  const label = status === "cleaned" ? "Cleaned up" : status === "running" ? "Active" : status.replaceAll("_", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

export function taskResultLabel(task: Pick<Task, "status" | "terminalReason">): string {
  if (task.terminalReason === "not_executed") return "Not executed";
  if (task.terminalReason === "cleaned_legacy") return "Cleaned up";
  return task.terminalReason ? taskStatusLabel(task.terminalReason) : taskStatusLabel(task.status);
}

export interface TaskFinalizationPresentation {
  label: string;
  description: string;
  error: string | null;
  tone: "progress" | "warning";
}

export function taskFinalizationPresentation(task: Pick<Task, "status" | "terminalReason" | "executionMode" | "artifactProjectionStatus" | "artifactProjectionError" | "cleanupStatus" | "cleanupError">): TaskFinalizationPresentation | null {
  if (task.executionMode !== "live" || !isTerminalResult(task)) return null;
  if (task.artifactProjectionStatus === "failed") return { label:"Artifact publishing delayed", description:"Published artifacts may be incomplete. AgentSmith will retry automatically before releasing the sandbox.", error:task.artifactProjectionError ?? null, tone:"warning" };
  if (task.artifactProjectionStatus === "pending" || task.artifactProjectionStatus === "draining") return { label:"Publishing artifacts", description:"AgentSmith is publishing the task artifacts before releasing the sandbox.", error:null, tone:"progress" };
  if (task.artifactProjectionStatus === "drained" && task.cleanupStatus === "failed") return { label:"Sandbox cleanup delayed", description:"App-owned sandbox resources are not yet confirmed removed. AgentSmith will retry automatically.", error:task.cleanupError ?? null, tone:"warning" };
  if (task.artifactProjectionStatus === "drained" && (task.cleanupStatus === "pending" || task.cleanupStatus === "running")) return { label:"Cleaning sandbox", description:"Artifacts are ready. AgentSmith is releasing the app-owned sandbox resources.", error:null, tone:"progress" };
  return null;
}

export function taskNeedsRefresh(task: Pick<Task, "status" | "terminalReason" | "executionMode" | "artifactProjectionStatus" | "artifactProjectionError" | "cleanupStatus" | "cleanupError">): boolean {
  return isActiveTask(task.status) || taskFinalizationPresentation(task) !== null;
}

function isTerminalResult(task: Pick<Task, "status" | "terminalReason">): boolean {
  return Boolean(task.terminalReason) || ["completed", "failed", "expired", "cleaned", "cancelled"].includes(task.status);
}

export function formatTaskDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatArtifactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
