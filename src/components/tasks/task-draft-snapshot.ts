const TASK_DRAFT_PREFIX = "agentsmith.task-draft.v1";
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
  return [
    TASK_DRAFT_PREFIX,
    encodeURIComponent(identity.userId),
    encodeURIComponent(identity.projectId),
    encodeURIComponent(identity.taskId)
  ].join(":");
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
  status: "empty" | "restored" | "unavailable";
};

export function restoreTaskDraft(
  storage: Storage | undefined,
  identity: TaskDraftIdentity
): TaskDraftRestore {
  if (!storage) return { draft: "", status: "unavailable" };
  const key = taskDraftKey(identity);
  try {
    const raw = storage.getItem(key);
    if (!raw) return { draft: "", status: "empty" };
    const value: unknown = JSON.parse(raw);
    if (isTaskDraftSnapshot(value, identity)) {
      return { draft: value.draft, status: "restored" };
    }
    storage.removeItem(key);
    return { draft: "", status: "empty" };
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // The common unavailable status is enough when cleanup is also blocked.
    }
    return { draft: "", status: "unavailable" };
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
    try {
      storage.removeItem(key);
    } catch {
      // Storage failures never block composing or submitting.
    }
    return "too_large";
  }
  try {
    if (draft) storage.setItem(key, serialized);
    else storage.removeItem(key);
    return "saved";
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // The unavailable result remains non-blocking when cleanup is blocked.
    }
    return "unavailable";
  }
}

export function clearTaskDraft(storage: Storage | undefined, identity: TaskDraftIdentity): void {
  if (!storage) return;
  try {
    storage.removeItem(taskDraftKey(identity));
  } catch {
    // Storage failures never block accepted commands or cleanup.
  }
}

export function clearTaskDraftsForUser(storage: Storage | undefined, userId: string): void {
  const prefix = `${TASK_DRAFT_PREFIX}:${encodeURIComponent(userId)}:`;
  clearTaskDraftsWithPrefix(storage, prefix);
}

export function clearTaskDraftsForProject(
  storage: Storage | undefined,
  userId: string,
  projectId: string
): void {
  const prefix = `${TASK_DRAFT_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}:`;
  clearTaskDraftsWithPrefix(storage, prefix);
}

export function shouldClearTaskDraftForAccessStatus(status: number): boolean {
  return status === 403 || status === 404;
}

function clearTaskDraftsWithPrefix(storage: Storage | undefined, prefix: string): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Storage failures never block logout, identity changes, or access recovery.
  }
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
