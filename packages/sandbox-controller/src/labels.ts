export const SANDBOX_MANAGED_BY = "agentsmith-lite";
export const SANDBOX_CLEANUP_STATUS_LABEL = "agentsmith-lite/cleanup-status";

export const SANDBOX_LABEL_KEYS = {
  managedBy: "agentsmith-lite/managed-by",
  workspaceId: "agentsmith-lite/workspace-id",
  projectId: "agentsmith-lite/project-id",
  taskId: "agentsmith-lite/task-id",
  runId: "agentsmith-lite/run-id"
} as const;

export interface SandboxIdentity {
  workspaceId: string;
  projectId: string;
  taskId: string;
  runId: string;
}

export function appLabels(): Record<string, string> {
  return {
    "app.kubernetes.io/name": "agentsmith-lite",
    "app.kubernetes.io/part-of": "agentsmith-lite",
    "app.kubernetes.io/managed-by": SANDBOX_MANAGED_BY,
    [SANDBOX_LABEL_KEYS.managedBy]: SANDBOX_MANAGED_BY
  };
}

export function sandboxResourceLabels(input: SandboxIdentity): Record<string, string> {
  return {
    ...appLabels(),
    "app.kubernetes.io/component": "sandbox",
    [SANDBOX_LABEL_KEYS.workspaceId]: input.workspaceId,
    [SANDBOX_LABEL_KEYS.projectId]: input.projectId,
    [SANDBOX_LABEL_KEYS.taskId]: input.taskId,
    [SANDBOX_LABEL_KEYS.runId]: input.runId
  };
}

export function sandboxIdentityLabels(input: SandboxIdentity): Record<string, string> {
  return {
    [SANDBOX_LABEL_KEYS.managedBy]: SANDBOX_MANAGED_BY,
    [SANDBOX_LABEL_KEYS.workspaceId]: input.workspaceId,
    [SANDBOX_LABEL_KEYS.projectId]: input.projectId,
    [SANDBOX_LABEL_KEYS.taskId]: input.taskId,
    [SANDBOX_LABEL_KEYS.runId]: input.runId
  };
}
