import type { PersistedSandboxRunState } from "../../ports/src/store.js";

const SECRET_VALUE_PATTERN = /\b(?:Bearer\s+(?!<redacted>)\S+|bsk_[A-Za-z0-9_-]+|sk-[A-Za-z0-9][A-Za-z0-9_-]*)\b/;
const MAX_TERMINAL_FAILURE_SYNC_ATTEMPTS = 3;

export function prepareSandboxRunDocument(run: PersistedSandboxRunState): Record<string, unknown> {
  const clone = structuredClone(run) as unknown;
  assertSandboxRunDocument(clone);
  return clone;
}

export function sandboxRunFromDocument(document: Record<string, unknown>): PersistedSandboxRunState {
  const clone = structuredClone(document) as unknown;
  if(clone&&typeof clone==="object"&&!Array.isArray(clone)&&(clone as Record<string,unknown>).releaseReason==="expired")(clone as Record<string,unknown>).releaseReason="legacy_cleaned";
  assertSandboxRunDocument(clone);
  return clone as unknown as PersistedSandboxRunState;
}

function assertSandboxRunDocument(clone: unknown): asserts clone is Record<string, unknown> {
  assertRecord(clone);
  assertNoSecretValues(clone);
  assertString(clone.runId, "runId");
  assertString(clone.namespace, "namespace");
  assertString(clone.workspaceId, "workspaceId");
  assertString(clone.projectId, "projectId");
  assertString(clone.taskId, "taskId");
  assertString(clone.fileLibraryId, "fileLibraryId");
  assertString(clone.startedByUserId, "startedByUserId");
  if (clone.startedAt !== null) assertString(clone.startedAt, "startedAt");
  assertResourceSnapshot(clone.resourceSnapshot);
  assertNumber(clone.fencingToken, "fencingToken");
  assertString(clone.phase, "phase");
  assertString(clone.cleanupStatus, "cleanupStatus");
  if(clone.releaseReason!==undefined&&clone.releaseReason!==null&&!['requested','failed','cleanup','legacy_cleaned'].includes(String(clone.releaseReason)))throw new Error("Sandbox run state releaseReason is invalid");
  assertTerminalFailure(clone.terminalFailure);
  assertStartupFailure(clone.startupFailure);
}

function assertResourceSnapshot(value:unknown):void {
  assertRecord(value);
  for (const field of ["cpuRequestMillis","memoryRequestBytes","cpuLimitMillis","memoryLimitBytes"] as const) {
    const item=value[field];
    if(typeof item!=="string"||!/^(?:0|[1-9]\d*)$/u.test(item))throw new Error(`Sandbox run state resourceSnapshot.${field} is invalid`);
    try{BigInt(item)}catch{throw new Error(`Sandbox run state resourceSnapshot.${field} is invalid`)}
  }
}

function assertNoSecretValues(value: unknown): void {
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERN.test(value)) {
      throw new Error("Sandbox run state must not contain secret values");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSecretValues(item);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertNoSecretValues(item);
    }
  }
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sandbox run state document must be an object");
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Sandbox run state is missing ${field}`);
  }
}

function assertNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Sandbox run state is missing ${field}`);
  }
}

function assertTerminalFailure(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  assertRecord(value);
  if (value.reason !== "pod_failed" && value.reason !== "runner_terminated" && value.reason !== "runner_crash_loop_back_off") {
    throw new Error("Sandbox run terminalFailure reason is invalid");
  }
  const exitCode = value.exitCode;
  if (exitCode !== undefined && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode < 1 || exitCode > 255)) {
    throw new Error("Sandbox run terminalFailure exitCode is invalid");
  }
  const syncAttempts = value.syncAttempts;
  if (syncAttempts !== undefined && (typeof syncAttempts !== "number" || !Number.isSafeInteger(syncAttempts) || syncAttempts < 0 || syncAttempts > 3)) {
    throw new Error("Sandbox run terminalFailure syncAttempts is invalid");
  }
  if (value.syncStatus !== undefined && value.syncStatus !== "pending" && value.syncStatus !== "synced" && value.syncStatus !== "unavailable") {
    throw new Error("Sandbox run terminalFailure syncStatus is invalid");
  }
  if (value.lastSyncAt !== undefined) {
    assertString(value.lastSyncAt, "terminalFailure.lastSyncAt");
  }
  if (value.lastSyncError !== undefined && value.lastSyncError !== null) {
    assertString(value.lastSyncError, "terminalFailure.lastSyncError");
    if (value.lastSyncError.length > 300) {
      throw new Error("Sandbox run terminalFailure lastSyncError is invalid");
    }
  }
  const hasSettlement =
    value.syncAttempts !== undefined ||
    value.syncStatus !== undefined ||
    value.lastSyncAt !== undefined ||
    value.lastSyncError !== undefined;
  if (!hasSettlement) {
    return;
  }
  if (typeof syncAttempts !== "number" || typeof value.syncStatus !== "string" || typeof value.lastSyncAt !== "string") {
    throw new Error("Sandbox run terminalFailure settlement is invalid");
  }
  if (value.syncStatus === "pending") {
    if (syncAttempts < 1 || syncAttempts >= MAX_TERMINAL_FAILURE_SYNC_ATTEMPTS || typeof value.lastSyncError !== "string") {
      throw new Error("Sandbox run terminalFailure pending settlement is invalid");
    }
    return;
  }
  if (value.syncStatus === "synced") {
    if (syncAttempts < 1 || syncAttempts > MAX_TERMINAL_FAILURE_SYNC_ATTEMPTS || value.lastSyncError !== null) {
      throw new Error("Sandbox run terminalFailure synced settlement is invalid");
    }
    return;
  }
  if (syncAttempts !== MAX_TERMINAL_FAILURE_SYNC_ATTEMPTS || typeof value.lastSyncError !== "string") {
    throw new Error("Sandbox run terminalFailure unavailable settlement is invalid");
  }
}

function assertStartupFailure(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  assertRecord(value);
  assertString(value.operation, "startupFailure.operation");
  assertString(value.message, "startupFailure.message");
  if (value.message.length > 300) {
    throw new Error("Sandbox run startupFailure message is invalid");
  }
  const status = value.status;
  if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw new Error("Sandbox run startupFailure status is invalid");
  }
  assertString(value.at, "startupFailure.at");
}
