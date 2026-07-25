import { ApiError } from "../../lib/api/client.ts";

export type SandboxCapacityRecovery =
  | {
      kind: "project_capacity";
      title: "Project Sandbox capacity reached";
      message: string;
      activeSandboxes: number;
      sandboxLimit: number;
      guidance: string;
    }
  | {
      kind: "substrate_capacity";
      title: "Local Sandbox capacity unavailable";
      message: string;
      guidance: string;
    };

export function sandboxCapacityRecovery(
  error: unknown
): SandboxCapacityRecovery | null {
  if (!(error instanceof ApiError) || error.retryable !== true) return null;
  if (error.code === "project_sandbox_capacity_reached" && isCapacityDetails(error.details)) {
    const { activeSandboxes, sandboxLimit } = error.details;
    return {
      kind: "project_capacity",
      title: "Project Sandbox capacity reached",
      message: error.message,
      activeSandboxes,
      sandboxLimit,
      guidance: `${activeSandboxes} of ${sandboxLimit} live Sandboxes are in use. Release one of your Sandboxes or try again later.`
    };
  }
  if (error.code === "substrate_sandbox_capacity_reached" && error.details === null) {
    return {
      kind: "substrate_capacity",
      title: "Local Sandbox capacity unavailable",
      message: error.message,
      guidance: "Live Sandboxes are using the available local capacity. Release one of your Sandboxes or try again later."
    };
  }
  return null;
}

export function sandboxCapacityRecoveryActions(
  recovery: SandboxCapacityRecovery,
  canManagePolicy: boolean
): {
  showActiveSandboxes: true;
  showPolicy: boolean;
} {
  return {
    showActiveSandboxes: true,
    showPolicy: recovery.kind === "project_capacity" && canManagePolicy
  };
}

function isCapacityDetails(value: unknown): value is {
  activeSandboxes: number;
  sandboxLimit: number;
} {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { activeSandboxes?: unknown }).activeSandboxes === "number"
    && typeof (value as { sandboxLimit?: unknown }).sandboxLimit === "number"
  );
}
