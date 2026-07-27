const TASK_CREATE_DRAFT_PREFIX = "agentsmith.task-create-draft.v1";
const TASK_MESSAGE_DRAFT_PREFIX = "agentsmith.task-draft.v1";
const TASK_COMMAND_PREFIX = "agentsmith.task-command.v1";
const MAX_TASK_CREATE_DRAFT_BYTES = 32_768;
const MAX_TASK_COMMAND_METADATA_BYTES = 8_192;

export type TaskCreateStorageIdentity = {
  userId: string;
  projectId: string;
};

export type TaskMessageStorageIdentity = TaskCreateStorageIdentity & {
  taskId: string;
};

export type TaskCreateDraft = {
  title: string;
  prompt: string;
  endpointId: string;
  fileLibrary:
    | { mode: "create_new"; name: string }
    | { mode: "use_existing"; id: string };
};

export type TaskCreateCommandMetadata = TaskCreateStorageIdentity & {
  key: string;
  fingerprint: string;
  createdAt: string;
};

export type TaskMessageCommandMetadata = TaskMessageStorageIdentity & {
  key: string;
  fingerprint: string;
  createdAt: string;
};

export type TaskTerminalStartCommandMetadata = TaskMessageCommandMetadata & {
  request:{
    expectedRunId:string|null;
    expectedSandboxState:"starting"|"active"|"release_requested"|"released"|"failed";
  };
  acceptedRunId:string|null;
};

export type TaskSandboxReleaseCommandMetadata = TaskMessageCommandMetadata & {
  request:{expectedRunId:string};
};

export type TaskTurnAbortCommandMetadata=TaskMessageCommandMetadata&{
  request:{expectedRunId:string;turnId:string};
};

export type TaskBackgroundWorkStopCommandMetadata=TaskMessageCommandMetadata&{
  request:{expectedRunId:string;interactionId:string};
};

export type TaskCommandKind =
  | "task-create"
  | "task-message"
  | "task-terminal-start"
  | "task-sandbox-release"
  | "task-turn-abort"
  | "task-work-stop";
type TaskCommandMetadata =
  | TaskCreateCommandMetadata
  | TaskMessageCommandMetadata
  | TaskTerminalStartCommandMetadata
  | TaskSandboxReleaseCommandMetadata
  | TaskTurnAbortCommandMetadata
  | TaskBackgroundWorkStopCommandMetadata;
type TaskCommandStorageIdentity =
  | TaskCreateStorageIdentity
  | TaskMessageStorageIdentity;

export type TaskCommandMetadataRead<T extends TaskCommandMetadata> =
  | { status: "found"; metadata: T }
  | { status: "missing" | "corrupt" | "unavailable" };

export type TaskCommandDraftReadStatus =
  | "found"
  | "missing"
  | "corrupt"
  | "unavailable";

export type TaskCommandRemountDecision<T extends TaskCommandMetadata> =
  | { status: "restore"; metadata: T }
  | { status: "fresh" | "cleanup" | "locked_unavailable" };

export type TaskCreateDraftRead =
  | { status: "found"; draft: TaskCreateDraft }
  | { status: "missing" | "corrupt" | "unavailable" };

export class TaskCommandStorageUnavailableError extends Error {
  constructor(
    readonly attemptDisposition: "discard" | "retain" = "retain"
  ) {
    super("The Task command identity could not be saved in this browser.");
    this.name = "TaskCommandStorageUnavailableError";
  }
}

export function taskCreateDraftKey(identity: TaskCreateStorageIdentity): string {
  return [
    TASK_CREATE_DRAFT_PREFIX,
    encodeURIComponent(identity.userId),
    encodeURIComponent(identity.projectId)
  ].join(":");
}

export function taskMessageDraftKey(identity: TaskMessageStorageIdentity): string {
  return [
    TASK_MESSAGE_DRAFT_PREFIX,
    encodeURIComponent(identity.userId),
    encodeURIComponent(identity.projectId),
    encodeURIComponent(identity.taskId)
  ].join(":");
}

export function taskCommandMetadataKey(
  kind: "task-create",
  identity: TaskCreateStorageIdentity
): string;
export function taskCommandMetadataKey(
  kind: "task-message",
  identity: TaskMessageStorageIdentity
): string;
export function taskCommandMetadataKey(
  kind: "task-terminal-start"|"task-sandbox-release"|"task-turn-abort"|"task-work-stop",
  identity: TaskMessageStorageIdentity
): string;
export function taskCommandMetadataKey(
  kind: TaskCommandKind,
  identity: TaskCommandStorageIdentity
): string {
  const parts = [
    TASK_COMMAND_PREFIX,
    kind,
    encodeURIComponent(identity.userId),
    encodeURIComponent(identity.projectId)
  ];
  if (kind !== "task-create") {
    parts.push(encodeURIComponent((identity as TaskMessageStorageIdentity).taskId));
  }
  return parts.join(":");
}

export function writeTaskCreateDraft(
  storage: Storage | undefined,
  identity: TaskCreateStorageIdentity,
  draft: TaskCreateDraft
): "saved" | "too_large" | "unavailable" {
  if (!storage) return "unavailable";
  const key = taskCreateDraftKey(identity);
  const serialized = JSON.stringify({ schema: 1, ...identity, draft });
  const tooLarge = utf8Bytes(serialized) > MAX_TASK_CREATE_DRAFT_BYTES;
  const existingDraft = readTaskCreateDraft(storage, identity);
  const ownership = readTaskCommandMetadata(storage, "task-create", identity);
  if (
    existingDraft.status === "found"
    && canonicalJson(existingDraft.draft) === canonicalJson(draft)
    && ownership.status === "found"
  ) return "saved";
  if (tooLarge) {
    if (ownership.status === "missing") removeStorageValue(storage, key);
    return "too_large";
  }
  if (
    ownership.status === "found"
    || ownership.status === "corrupt"
    || ownership.status === "unavailable"
    || existingDraft.status === "unavailable"
  ) return "unavailable";
  try {
    storage.setItem(key, serialized);
    return "saved";
  } catch {
    removeStorageValue(storage, key);
    return "unavailable";
  }
}

export function restoreTaskCreateDraft(
  storage: Storage | undefined,
  identity: TaskCreateStorageIdentity
): TaskCreateDraft | null {
  const result = readTaskCreateDraft(storage, identity);
  if (result.status === "found") return result.draft;
  if (result.status === "corrupt") {
    clearTaskCreateCommandPair(storage, identity);
  }
  return null;
}

export function readTaskCreateDraft(
  storage: Storage | undefined,
  identity: TaskCreateStorageIdentity
): TaskCreateDraftRead {
  if (!storage) return { status: "unavailable" };
  let raw: string | null;
  try {
    raw = storage.getItem(taskCreateDraftKey(identity));
  } catch {
    return { status: "unavailable" };
  }
  if (!raw) return { status: "missing" };
  if (utf8Bytes(raw) > MAX_TASK_CREATE_DRAFT_BYTES) {
    return { status: "corrupt" };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value)
      && value.schema === 1
      && value.userId === identity.userId
      && value.projectId === identity.projectId
      && isTaskCreateDraft(value.draft)
    ) return { status: "found", draft: value.draft };
    return { status: "corrupt" };
  } catch {
    return { status: "corrupt" };
  }
}

export function clearTaskCreateDraft(
  storage: Storage | undefined,
  identity: TaskCreateStorageIdentity
): void {
  removeStorageValue(storage, taskCreateDraftKey(identity));
}

export function writeTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-create",
  metadata: TaskCreateCommandMetadata
): "saved" | "too_large" | "unavailable";
export function writeTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-message",
  metadata: TaskMessageCommandMetadata
): "saved" | "too_large" | "unavailable";
export function writeTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-terminal-start",
  metadata: TaskTerminalStartCommandMetadata
): "saved" | "too_large" | "unavailable";
export function writeTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-sandbox-release",
  metadata: TaskSandboxReleaseCommandMetadata
): "saved" | "too_large" | "unavailable";
export function writeTaskCommandMetadata(
  storage:Storage|undefined,
  kind:"task-turn-abort",
  metadata:TaskTurnAbortCommandMetadata
):"saved"|"too_large"|"unavailable";
export function writeTaskCommandMetadata(
  storage:Storage|undefined,
  kind:"task-work-stop",
  metadata:TaskBackgroundWorkStopCommandMetadata
):"saved"|"too_large"|"unavailable";
export function writeTaskCommandMetadata(
  storage: Storage | undefined,
  kind: TaskCommandKind,
  metadata: TaskCommandMetadata
): "saved" | "too_large" | "unavailable" {
  return writeTaskCommandMetadataValue(storage,kind,metadata);
}

function writeTaskCommandMetadataValue(
  storage:Storage|undefined,
  kind:TaskCommandKind,
  metadata:TaskCommandMetadata
):"saved"|"too_large"|"unavailable"{
  if (!storage) return "unavailable";
  const identity = metadata as TaskCommandStorageIdentity;
  const key = metadataKey(kind, identity);
  const serialized = JSON.stringify(metadata);
  if (utf8Bytes(serialized) > MAX_TASK_COMMAND_METADATA_BYTES) {
    return "too_large";
  }
  try {
    storage.setItem(key, serialized);
    return "saved";
  } catch {
    return "unavailable";
  }
}

export function readTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-create",
  identity: TaskCreateStorageIdentity
): TaskCommandMetadataRead<TaskCreateCommandMetadata>;
export function readTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-message",
  identity: TaskMessageStorageIdentity
): TaskCommandMetadataRead<TaskMessageCommandMetadata>;
export function readTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-terminal-start",
  identity: TaskMessageStorageIdentity
): TaskCommandMetadataRead<TaskTerminalStartCommandMetadata>;
export function readTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-sandbox-release",
  identity: TaskMessageStorageIdentity
): TaskCommandMetadataRead<TaskSandboxReleaseCommandMetadata>;
export function readTaskCommandMetadata(
  storage:Storage|undefined,
  kind:"task-turn-abort",
  identity:TaskMessageStorageIdentity
):TaskCommandMetadataRead<TaskTurnAbortCommandMetadata>;
export function readTaskCommandMetadata(
  storage:Storage|undefined,
  kind:"task-work-stop",
  identity:TaskMessageStorageIdentity
):TaskCommandMetadataRead<TaskBackgroundWorkStopCommandMetadata>;
export function readTaskCommandMetadata(
  storage: Storage | undefined,
  kind: TaskCommandKind,
  identity: TaskCommandStorageIdentity
): TaskCommandMetadataRead<TaskCommandMetadata> {
  return readTaskCommandMetadataValue(storage,kind,identity);
}

function readTaskCommandMetadataValue(
  storage:Storage|undefined,
  kind:TaskCommandKind,
  identity:TaskCommandStorageIdentity
):TaskCommandMetadataRead<TaskCommandMetadata>{
  if (!storage) return { status: "unavailable" };
  let raw: string | null;
  try {
    raw = storage.getItem(metadataKey(kind, identity));
  } catch {
    return { status: "unavailable" };
  }
  if (!raw) return { status: "missing" };
  if (utf8Bytes(raw) > MAX_TASK_COMMAND_METADATA_BYTES) {
    return { status: "corrupt" };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (isTaskCommandMetadata(value, kind, identity)) {
      return { status: "found", metadata: value };
    }
    return { status: "corrupt" };
  } catch {
    return { status: "corrupt" };
  }
}

export function restoreTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-create",
  identity: TaskCreateStorageIdentity
): TaskCreateCommandMetadata | null;
export function restoreTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-message",
  identity: TaskMessageStorageIdentity
): TaskMessageCommandMetadata | null;
export function restoreTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-terminal-start",
  identity: TaskMessageStorageIdentity
): TaskTerminalStartCommandMetadata | null;
export function restoreTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-sandbox-release",
  identity: TaskMessageStorageIdentity
): TaskSandboxReleaseCommandMetadata | null;
export function restoreTaskCommandMetadata(
  storage:Storage|undefined,
  kind:"task-turn-abort",
  identity:TaskMessageStorageIdentity
):TaskTurnAbortCommandMetadata|null;
export function restoreTaskCommandMetadata(
  storage:Storage|undefined,
  kind:"task-work-stop",
  identity:TaskMessageStorageIdentity
):TaskBackgroundWorkStopCommandMetadata|null;
export function restoreTaskCommandMetadata(
  storage: Storage | undefined,
  kind: TaskCommandKind,
  identity: TaskCommandStorageIdentity
): TaskCommandMetadata | null {
  const result=readTaskCommandMetadataValue(storage,kind,identity);
  return result.status === "found" ? result.metadata : null;
}

export function taskCommandRemountDecision<T extends TaskCommandMetadata>(
  metadata: TaskCommandMetadataRead<T>,
  draftStatus: TaskCommandDraftReadStatus
): TaskCommandRemountDecision<T> {
  if (metadata.status === "unavailable" || draftStatus === "unavailable") {
    return { status: "locked_unavailable" };
  }
  if (metadata.status === "found" && draftStatus === "found") {
    return { status: "restore", metadata: metadata.metadata };
  }
  if (
    metadata.status === "missing"
    && (draftStatus === "found" || draftStatus === "missing")
  ) return { status: "fresh" };
  return { status: "cleanup" };
}

export function taskRuntimeCommandRemountDecision<T extends TaskTerminalStartCommandMetadata|TaskSandboxReleaseCommandMetadata|TaskTurnAbortCommandMetadata|TaskBackgroundWorkStopCommandMetadata>(
  metadata:TaskCommandMetadataRead<T>
):TaskCommandRemountDecision<T>{
  if(metadata.status==="found")return{status:"restore",metadata:metadata.metadata};
  if(metadata.status==="missing")return{status:"fresh"};
  if(metadata.status==="corrupt")return{status:"cleanup"};
  return{status:"locked_unavailable"};
}

export function clearTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-create",
  identity: TaskCreateStorageIdentity
): void;
export function clearTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-message",
  identity: TaskMessageStorageIdentity
): void;
export function clearTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-terminal-start"|"task-sandbox-release"|"task-turn-abort"|"task-work-stop",
  identity: TaskMessageStorageIdentity
): void;
export function clearTaskCommandMetadata(
  storage: Storage | undefined,
  kind: TaskCommandKind,
  identity: TaskCommandStorageIdentity
): void {
  removeStorageValue(storage, metadataKey(kind, identity));
}

export function retireTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-create",
  identity: TaskCreateStorageIdentity,
  attempt: { key: string; fingerprint: string }
): boolean;
export function retireTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-terminal-start"|"task-sandbox-release"|"task-turn-abort"|"task-work-stop",
  identity: TaskMessageStorageIdentity,
  attempt: { key: string; fingerprint: string }
): boolean;
export function retireTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-message",
  identity: TaskMessageStorageIdentity,
  attempt: { key: string; fingerprint: string }
): boolean;
export function retireTaskCommandMetadata(
  storage: Storage | undefined,
  kind: TaskCommandKind,
  identity: TaskCommandStorageIdentity,
  attempt: { key: string; fingerprint: string }
): boolean {
  const metadataRead=readTaskCommandMetadataValue(storage,kind,identity);
  if (metadataRead.status === "missing") return true;
  if (
    metadataRead.status !== "found"
    || metadataRead.metadata.key !== attempt.key
    || metadataRead.metadata.fingerprint !== attempt.fingerprint
    || !storage
  ) return false;

  const key = metadataKey(kind, identity);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return false;
  }
  if (raw === null) return true;

  try {
    storage.removeItem(key);
    if (storage.getItem(key) === null) return true;
    return false;
  } catch {
    restoreStorageValueVerified(storage, key, raw);
    return false;
  }
}

export function persistTaskCreateCommandAttempt(
  storage: Storage | undefined,
  draft: TaskCreateDraft,
  metadata: TaskCreateCommandMetadata
): void {
  const identity = {
    userId: metadata.userId,
    projectId: metadata.projectId
  };
  const draftRead = readTaskCreateDraft(storage, identity);
  if (
    draftRead.status !== "found"
    || canonicalJson(draftRead.draft) !== canonicalJson(draft)
  ) {
    if (draftRead.status === "unavailable") {
      throw new TaskCommandStorageUnavailableError();
    }
    clearTaskCommandMetadata(storage, "task-create", identity);
    throw new TaskCommandStorageUnavailableError();
  }
  persistTaskCommandMetadata(storage, "task-create", metadata);
}

export function clearTaskCreateCommandAttempt(
  storage: Storage | undefined,
  identity: TaskCreateStorageIdentity,
  attempt: { key: string; fingerprint: string },
  draft: TaskCreateDraft
): boolean {
  const metadataRead = readTaskCommandMetadata(
    storage,
    "task-create",
    identity
  );
  if (metadataRead.status !== "found") return false;
  const draftRead = readTaskCreateDraft(storage, identity);
  if (
    metadataRead.metadata.key !== attempt.key
    || metadataRead.metadata.fingerprint !== attempt.fingerprint
    || draftRead.status !== "found"
    || canonicalJson(draftRead.draft) !== canonicalJson(draft)
    || !storage
  ) return false;

  const draftKey = taskCreateDraftKey(identity);
  const commandKey = taskCommandMetadataKey("task-create", identity);
  let draftRaw: string | null;
  try {
    draftRaw = storage.getItem(draftKey);
    if (storage.getItem(commandKey) === null) return false;
  } catch {
    return false;
  }
  if (draftRaw === null) return false;

  try {
    storage.removeItem(draftKey);
    if (storage.getItem(draftKey) !== null) return false;
  } catch {
    restoreStorageValue(storage, draftKey, draftRaw);
    return false;
  }

  try {
    storage.removeItem(commandKey);
    storage.getItem(commandKey);
  } catch {
    // A missing draft cannot be replayed, even if stale metadata remains.
  }
  return true;
}

export function clearTaskCreateCommandPair(
  storage: Storage | undefined,
  identity: TaskCreateStorageIdentity
): boolean {
  return clearTaskCommandPair(
    storage,
    "task-create",
    identity,
    taskCreateDraftKey(identity)
  );
}

export function persistTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-create",
  metadata: TaskCreateCommandMetadata
): void;
export function persistTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-message",
  metadata: TaskMessageCommandMetadata
): void;
export function persistTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-terminal-start",
  metadata: TaskTerminalStartCommandMetadata
): void;
export function persistTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-sandbox-release",
  metadata: TaskSandboxReleaseCommandMetadata
): void;
export function persistTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-turn-abort",
  metadata: TaskTurnAbortCommandMetadata
): void;
export function persistTaskCommandMetadata(
  storage: Storage | undefined,
  kind: "task-work-stop",
  metadata: TaskBackgroundWorkStopCommandMetadata
): void;
export function persistTaskCommandMetadata(
  storage: Storage | undefined,
  kind: TaskCommandKind,
  metadata: TaskCommandMetadata
): void {
  const identity = metadata as TaskCommandStorageIdentity;
  const existing=readTaskCommandMetadataValue(storage,kind,identity);
  if (existing.status === "found") {
    if (sameTaskCommandMetadata(existing.metadata, metadata)) return;
    throw new TaskCommandStorageUnavailableError("retain");
  }
  if (
    existing.status === "unavailable"
    || existing.status === "corrupt"
  ) throw new TaskCommandStorageUnavailableError("retain");

  const writeOutcome=writeTaskCommandMetadataValue(storage,kind,metadata);
  if (writeOutcome !== "saved") {
    throw new TaskCommandStorageUnavailableError("discard");
  }
  const restored=readTaskCommandMetadataValue(storage,kind,identity);
  if (
    restored.status !== "found"
    || !sameTaskCommandMetadata(restored.metadata, metadata)
  ) {
    throw new TaskCommandStorageUnavailableError("retain");
  }
}

export function updateTaskCommandAcceptedRun(
  storage:Storage|undefined,
  kind:"task-terminal-start",
  identity:TaskMessageStorageIdentity,
  attempt:{key:string;fingerprint:string},
  acceptedRunId:string
):boolean{
  const read=readTaskCommandMetadata(storage,kind,identity);
  if(read.status!=="found"||read.metadata.key!==attempt.key||read.metadata.fingerprint!==attempt.fingerprint)return false;
  return writeTaskCommandMetadata(storage,kind,{...read.metadata,acceptedRunId})==="saved";
}

export function clearTaskCommandStorageForUser(
  storage: Storage | undefined,
  userId: string
): void {
  clearTaskCommandStorage(
    storage,
    `${encodeURIComponent(userId)}:`
  );
}

export function clearTaskCommandStorageForProject(
  storage: Storage | undefined,
  userId: string,
  projectId: string
): void {
  clearTaskCommandStorage(
    storage,
    `${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`
  );
}

export async function taskCommandFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function metadataKey(
  kind: TaskCommandKind,
  identity: TaskCommandStorageIdentity
): string {
  const parts=[
    TASK_COMMAND_PREFIX,kind,
    encodeURIComponent(identity.userId),
    encodeURIComponent(identity.projectId)
  ];
  if(kind!=="task-create")parts.push(encodeURIComponent((identity as TaskMessageStorageIdentity).taskId));
  return parts.join(":");
}

function clearTaskCommandPair(
  storage: Storage | undefined,
  kind: TaskCommandKind,
  identity: TaskCommandStorageIdentity,
  draftKey: string
): boolean {
  if (!storage) return false;
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
    storage.removeItem(metadataKey(kind, identity));
    storage.getItem(metadataKey(kind, identity));
  } catch {
    // No actionable draft remains, so stale metadata is safe.
  }
  return true;
}

function clearTaskCommandStorage(
  storage: Storage | undefined,
  encodedIdentity: string
): void {
  if (!storage) return;
  let keys: string[];
  try {
    keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
  } catch {
    return;
  }

  const pairs = new Map<string, string>();
  const prefixes = [
    {
      draft: `${TASK_CREATE_DRAFT_PREFIX}:`,
      metadata: `${TASK_COMMAND_PREFIX}:task-create:`
    },
    {
      draft: `${TASK_MESSAGE_DRAFT_PREFIX}:`,
      metadata: `${TASK_COMMAND_PREFIX}:task-message:`
    }
  ];
  for (const { draft, metadata } of prefixes) {
    for (const key of keys) {
      if (key.startsWith(draft)) {
        const suffix = key.slice(draft.length);
        if (matchesEncodedIdentity(suffix, encodedIdentity)) {
          pairs.set(key, `${metadata}${suffix}`);
        }
      } else if (key.startsWith(metadata)) {
        const suffix = key.slice(metadata.length);
        if (matchesEncodedIdentity(suffix, encodedIdentity)) {
          pairs.set(`${draft}${suffix}`, key);
        }
      }
    }
  }
  for (const [draftKey, metadataKey] of pairs) {
    clearStoragePairByKeys(storage, draftKey, metadataKey);
  }
  for(const kind of ["task-terminal-start","task-sandbox-release","task-turn-abort","task-work-stop"] as const){
    const prefix=`${TASK_COMMAND_PREFIX}:${kind}:`;
    for(const key of keys){
      if(key.startsWith(prefix)&&matchesEncodedIdentity(key.slice(prefix.length),encodedIdentity)){
        removeStorageValue(storage,key);
      }
    }
  }
}

function matchesEncodedIdentity(suffix: string, identity: string): boolean {
  return identity.endsWith(":")
    ? suffix.startsWith(identity)
    : suffix === identity || suffix.startsWith(`${identity}:`);
}

function clearStoragePairByKeys(
  storage: Storage,
  draftKey: string,
  metadataKey: string
): boolean {
  try {
    const draft = storage.getItem(draftKey);
    if (draft !== null) {
      storage.removeItem(draftKey);
      if (storage.getItem(draftKey) !== null) return false;
    }
  } catch {
    return false;
  }
  try {
    storage.removeItem(metadataKey);
    storage.getItem(metadataKey);
  } catch {
    // A missing draft is not actionable; orphan metadata may remain.
  }
  return true;
}

function sameTaskCommandMetadata(
  left: TaskCommandMetadata,
  right: TaskCommandMetadata
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isTaskCreateDraft(value: unknown): value is TaskCreateDraft {
  if (
    !isRecord(value)
    || typeof value.title !== "string"
    || typeof value.prompt !== "string"
    || typeof value.endpointId !== "string"
    || !isRecord(value.fileLibrary)
  ) return false;
  const library = value.fileLibrary;
  return library.mode === "create_new"
    ? Object.keys(library).sort().join(",") === "mode,name"
      && typeof library.name === "string"
    : library.mode === "use_existing"
      && Object.keys(library).sort().join(",") === "id,mode"
      && typeof library.id === "string";
}

function isTaskCommandMetadata(
  value: unknown,
  kind: TaskCommandKind,
  identity: TaskCommandStorageIdentity
): value is TaskCommandMetadata {
  if (
    !isRecord(value)
    || typeof value.userId !== "string"
    || typeof value.projectId !== "string"
    || typeof value.key !== "string"
    || !value.key
    || typeof value.fingerprint !== "string"
    || !value.fingerprint
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
    || value.userId !== identity.userId
    || value.projectId !== identity.projectId
  ) return false;

  const keys = Object.keys(value).sort().join(",");
  if (kind === "task-create") {
    return keys === "createdAt,fingerprint,key,projectId,userId";
  }
  if(!("taskId" in identity)||value.taskId!==identity.taskId)return false;
  if(kind==="task-message")return keys === "createdAt,fingerprint,key,projectId,taskId,userId";
  if(!isRecord(value.request))return false;
  if(kind==="task-sandbox-release"){
    return keys==="createdAt,fingerprint,key,projectId,request,taskId,userId"
      && Object.keys(value.request).join(",")==="expectedRunId"
      && typeof value.request.expectedRunId==="string"
      && Boolean(value.request.expectedRunId);
  }
  if(kind==="task-turn-abort"){
    return keys==="createdAt,fingerprint,key,projectId,request,taskId,userId"
      && Object.keys(value.request).sort().join(",")==="expectedRunId,turnId"
      && typeof value.request.expectedRunId==="string"&&Boolean(value.request.expectedRunId)
      && typeof value.request.turnId==="string"&&Boolean(value.request.turnId);
  }
  if(kind==="task-work-stop"){
    return keys==="createdAt,fingerprint,key,projectId,request,taskId,userId"
      && Object.keys(value.request).sort().join(",")==="expectedRunId,interactionId"
      && typeof value.request.expectedRunId==="string"&&Boolean(value.request.expectedRunId)
      && typeof value.request.interactionId==="string"&&Boolean(value.request.interactionId);
  }
  return keys==="acceptedRunId,createdAt,fingerprint,key,projectId,request,taskId,userId"
    && (value.acceptedRunId===null||typeof value.acceptedRunId==="string"&&Boolean(value.acceptedRunId))
    && Object.keys(value.request).sort().join(",")==="expectedRunId,expectedSandboxState"
    && (value.request.expectedRunId===null||typeof value.request.expectedRunId==="string"&&Boolean(value.request.expectedRunId))
    && typeof value.request.expectedSandboxState==="string"
    && ["starting","active","release_requested","released","failed"].includes(value.request.expectedSandboxState);
}

function canonicalJson(value: unknown): string {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Command fingerprint input contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Command fingerprint input is not JSON-compatible");
}

function removeStorageValue(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // The unavailable result remains sufficient when cleanup is also blocked.
  }
}

function restoreStorageValue(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Best effort preserves the original value when removal itself failed.
  }
}

function restoreStorageValueVerified(
  storage: Storage,
  key: string,
  value: string
): boolean {
  try {
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch {
    return false;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
