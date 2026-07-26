import {
  clearTaskCommandMetadata,
  clearTaskCommandStorageForProject,
  clearTaskCommandStorageForUser,
  persistTaskCommandMetadata,
  readTaskCommandMetadata,
  taskCommandMetadataKey,
  taskMessageDraftKey,
  TaskCommandStorageUnavailableError,
  type TaskMessageCommandMetadata
} from "./task-command-storage.ts";

const MAX_TASK_DRAFT_BYTES = 32_768;
export const TASK_DRAFT_STORAGE_NOTICE = "This draft could not be saved in this browser. You can keep editing and send it.";

export type TaskDraftIdentity = {
  userId: string;
  projectId: string;
  taskId: string;
};

type TaskDraftSnapshot = TaskDraftIdentity & {
  schema: 1;
  draft: string;
};

export function taskDraftKey(identity: TaskDraftIdentity): string {
  return taskMessageDraftKey(identity);
}

export function taskDraftStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

export type TaskDraftRestore = {
  draft: string;
  status: "empty" | "restored" | "corrupt" | "unavailable";
};

export function restoreTaskDraft(
  storage: Storage | undefined,
  identity: TaskDraftIdentity
): TaskDraftRestore {
  if (!storage) return { draft: "", status: "unavailable" };
  const key = taskDraftKey(identity);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { draft: "", status: "unavailable" };
  }
  if (!raw) return { draft: "", status: "empty" };
  try {
    const value: unknown = JSON.parse(raw);
    if (isTaskDraftSnapshot(value, identity)) {
      if (new TextEncoder().encode(value.draft).byteLength > MAX_TASK_DRAFT_BYTES) {
        return { draft: "", status: "corrupt" };
      }
      return { draft: value.draft, status: "restored" };
    }
    return { draft: "", status: "corrupt" };
  } catch {
    return { draft: "", status: "corrupt" };
  }
}

export function readTaskDraft(storage: Storage | undefined, identity: TaskDraftIdentity): string {
  return restoreTaskDraft(storage, identity).draft;
}

export function writeTaskDraft(
  storage: Storage | undefined,
  identity: TaskDraftIdentity,
  draft: string
): "saved" | "too_large" | "unavailable" {
  const key = taskDraftKey(identity);
  const snapshot: TaskDraftSnapshot = { schema: 1, ...identity, draft };
  const serialized = JSON.stringify(snapshot);
  if (!storage) return "unavailable";
  if (new TextEncoder().encode(draft).byteLength > MAX_TASK_DRAFT_BYTES) {
    clearTaskMessageCommandPair(storage, identity);
    return "too_large";
  }
  try {
    if (draft) storage.setItem(key, serialized);
    else storage.removeItem(key);
    return "saved";
  } catch {
    clearTaskMessageCommandPair(storage, identity);
    return "unavailable";
  }
}

export function clearTaskDraft(storage: Storage | undefined, identity: TaskDraftIdentity): void {
  clearTaskMessageCommandPair(storage, identity);
}

export function persistTaskMessageCommandAttempt(
  storage: Storage | undefined,
  identity: TaskDraftIdentity,
  draft: string,
  metadata: TaskMessageCommandMetadata
): void {
  const restored = restoreTaskDraft(storage, identity);
  if (restored.status !== "restored" || restored.draft !== draft) {
    if (restored.status === "unavailable") {
      throw new TaskCommandStorageUnavailableError();
    }
    clearTaskCommandMetadata(storage, "task-message", identity);
    throw new TaskCommandStorageUnavailableError();
  }
  persistTaskCommandMetadata(storage, "task-message", metadata);
}

export function clearTaskMessageCommandAttempt(
  storage: Storage | undefined,
  identity: TaskDraftIdentity,
  attempt: { key: string; fingerprint: string },
  draft: string
): boolean {
  const metadataRead = readTaskCommandMetadata(
    storage,
    "task-message",
    identity
  );
  if (metadataRead.status !== "found") return false;
  const restored = restoreTaskDraft(storage, identity);
  if (
    metadataRead.metadata.key !== attempt.key
    || metadataRead.metadata.fingerprint !== attempt.fingerprint
    || restored.status !== "restored"
    || restored.draft !== draft
  ) return false;

  if (!storage) return false;
  const draftKey = taskDraftKey(identity);
  try {
    storage.removeItem(draftKey);
    if (storage.getItem(draftKey) !== null) return false;
  } catch {
    return false;
  }
  try {
    storage.removeItem(taskCommandMetadataKey("task-message", identity));
    storage.getItem(taskCommandMetadataKey("task-message", identity));
  } catch {
    // No actionable draft remains, so stale metadata is safe.
  }
  return true;
}

export function clearTaskMessageCommandPair(
  storage: Storage | undefined,
  identity: TaskDraftIdentity
): boolean {
  if (!storage) return false;
  const draftKey = taskDraftKey(identity);
  try {
    const draftRaw = storage.getItem(draftKey);
    if (draftRaw !== null) {
      storage.removeItem(draftKey);
      if (storage.getItem(draftKey) !== null) return false;
    }
  } catch {
    return false;
  }
  try {
    storage.removeItem(taskCommandMetadataKey("task-message", identity));
    storage.getItem(taskCommandMetadataKey("task-message", identity));
  } catch {
    // No actionable draft remains, so stale metadata is safe.
  }
  return true;
}

export function clearTaskDraftsForUser(storage: Storage | undefined, userId: string): void {
  clearTaskCommandStorageForUser(storage, userId);
}

export function clearTaskDraftsForProject(
  storage: Storage | undefined,
  userId: string,
  projectId: string
): void {
  clearTaskCommandStorageForProject(storage, userId, projectId);
}

export function shouldClearTaskDraftForAccessStatus(status: number): boolean {
  return status === 403 || status === 404;
}

function isTaskDraftSnapshot(value: unknown, identity: TaskDraftIdentity): value is TaskDraftSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<TaskDraftSnapshot>;
  return snapshot.schema === 1
    && snapshot.userId === identity.userId
    && snapshot.projectId === identity.projectId
    && snapshot.taskId === identity.taskId
    && typeof snapshot.draft === "string";
}
