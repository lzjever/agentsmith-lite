import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../domain/src/sandboxDefaults.js";

export type AuthMode = "builtin_admin";
export type SandboxMode = "dry-run" | "live";

export function parseAuthMode(value: string | undefined): AuthMode {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "builtin_admin";
  }
  if (trimmed === "builtin_admin") {
    return "builtin_admin";
  }
  throw new Error("AUTH_MODE must be empty or builtin_admin");
}

export function parseSandboxMode(value: string | undefined): SandboxMode {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "dry-run";
  }
  if (trimmed === "dry-run" || trimmed === "live") {
    return trimmed;
  }
  throw new Error("AGENTSMITH_LITE_SANDBOX_MODE must be either dry-run or live");
}

export function optionalRuntimeTickIntervalMs(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error("AGENTSMITH_LITE_RUNTIME_TICK_MS must be a positive integer");
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("AGENTSMITH_LITE_RUNTIME_TICK_MS must be a positive integer");
  }
  return parsed;
}

export function parseSandboxNamespaceLimit(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_SANDBOX_NAMESPACE_LIMIT;
  }
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error("AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT must be a positive integer");
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT must be a positive integer");
  }
  return parsed;
}
