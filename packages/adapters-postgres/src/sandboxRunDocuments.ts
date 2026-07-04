import type { PersistedSandboxRunState } from "../../ports/src/store.js";

const SECRET_VALUE_PATTERN = /\b(?:Bearer\s+\S+|bsk_[A-Za-z0-9_-]+|sk-[A-Za-z0-9][A-Za-z0-9_-]*)\b/;

export function prepareSandboxRunDocument(run: PersistedSandboxRunState): Record<string, unknown> {
  const clone = structuredClone(run) as unknown;
  assertRecord(clone);
  assertNoSecretValues(clone);
  return clone;
}

export function sandboxRunFromDocument(document: Record<string, unknown>): PersistedSandboxRunState {
  const clone = structuredClone(document) as unknown;
  assertRecord(clone);
  assertNoSecretValues(clone);
  assertString(clone.runId, "runId");
  assertString(clone.namespace, "namespace");
  assertString(clone.workspaceId, "workspaceId");
  assertString(clone.projectId, "projectId");
  assertString(clone.taskId, "taskId");
  assertNumber(clone.fencingToken, "fencingToken");
  assertString(clone.phase, "phase");
  assertString(clone.cleanupStatus, "cleanupStatus");
  return clone as unknown as PersistedSandboxRunState;
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
