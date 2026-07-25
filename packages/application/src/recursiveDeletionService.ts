import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import {
  isFileDeletionOperationTransition,
  type FileDeletionOperationEntryType,
  type FileDeletionOperationOwner,
  type FileDeletionOperationState,
  type ProductStore
} from "../../ports/src/store.js";
import { ProductError } from "../../domain/src/errors.js";
import {
  DescriptorFileTreeWalker,
  descriptorEntryType,
  descriptorPath,
  validateDescriptorName
} from "./descriptorFileTreeWalker.js";
import { FilePathValidationService } from "./filePathValidationService.js";

const QUARANTINE_ROOT = ".deletions";
const QUARANTINE_ENTRY = "entry";
const OPERATION_MARKER = "operation.json";
const PENDING_OPERATION_MARKER = "operation.json.pending";

export type FileDeletionOperationStore = Pick<
  ProductStore,
  "findFileDeletionOperation" | "persistFileDeletionOperation"
>;

export interface EntryDeletionTarget {
  owner: FileDeletionOperationOwner;
  projectRoot: string;
  libraryRoot: string;
  relativePath: string;
}

export interface IsolatedEntryDeletion {
  operationId: string;
  entryType: FileDeletionOperationEntryType;
  bytes: number;
}

interface NormalizedDeletionTarget extends EntryDeletionTarget {
  libraryRoot: string;
  relativePath: string;
}

interface OpenQuarantine {
  project: FileHandle;
  deletions: FileHandle;
  operation: FileHandle;
  marker: "exact" | "repairable" | "removed_without_marker";
}

export interface RecursiveDeletionObserver {
  beforeRename?(event: {
    projectId: string;
    operationId: string;
    relativePath: string;
  }): Promise<void>;
}

export class RecursiveDeletionService {
  constructor(
    private readonly paths = new FilePathValidationService(),
    private readonly tree = new DescriptorFileTreeWalker(),
    private readonly observer?: RecursiveDeletionObserver
  ) {}

  async isolateEntry(
    target: EntryDeletionTarget,
    operations: FileDeletionOperationStore
  ): Promise<IsolatedEntryDeletion> {
    const normalized = this.normalizeTarget(target);
    const existing = await operations.findFileDeletionOperation(normalized.owner);
    if (existing) return completedIsolation(normalized.owner, existing);

    let linearized = false;
    let sourceParent: FileHandle | null = null;
    let sourceHandle: FileHandle | null = null;
    let quarantine: OpenQuarantine | null = null;
    try {
      quarantine = await this.openQuarantine(normalized, false);
      if (quarantine?.marker === "exact" && await this.tree.optionalStat(quarantine.operation, QUARANTINE_ENTRY)) {
        linearized = true;
        return await this.persistQuarantinedState(normalized, operations, quarantine.operation);
      }
      await closeQuarantine(quarantine);
      quarantine = null;

      const segments = normalized.relativePath.split("/");
      const entryName = segments.pop()!;
      sourceParent = await this.openSourceParent(normalized.projectRoot, normalized.libraryRoot, segments);
      sourceHandle = await this.tree.openEntry(sourceParent, entryName);
      observedStaticEntryType(await sourceHandle.stat({ bigint: true }));

      quarantine = await this.openQuarantine(normalized, true);
      if (!quarantine) throw new ProductError("File deletion quarantine is unavailable", 500);
      if (await this.tree.optionalStat(quarantine.operation, QUARANTINE_ENTRY)) {
        linearized = true;
        return await this.persistQuarantinedState(normalized, operations, quarantine.operation);
      }

      const sourceParentStat = await sourceParent.stat({ bigint: true });
      const quarantineStat = await quarantine.operation.stat({ bigint: true });
      if (sourceParentStat.dev !== quarantineStat.dev) {
        throw new ProductError("File deletion quarantine must be on the same volume", 500);
      }

      try {
        await this.observer?.beforeRename?.({
          projectId: normalized.owner.projectId,
          operationId: normalized.owner.resourceId,
          relativePath: normalized.relativePath
        });
        await rename(
          descriptorPath(sourceParent, entryName),
          descriptorPath(quarantine.operation, QUARANTINE_ENTRY)
        );
      } catch (error) {
        if (isCrossDevice(error)) {
          throw new ProductError("File deletion quarantine must be on the same volume", 500);
        }
        throw error;
      }
      linearized = true;
      await quarantine.operation.sync();
      return await this.persistQuarantinedState(normalized, operations, quarantine.operation);
    } catch (error) {
      if (error instanceof MarkerValidationError && error.quarantinedEntryExists) linearized = true;
      if (linearized) throw deletionIncomplete(error);
      if (isNotFound(error)) throw filePathNotFound();
      if (isSymlinkOrNotDirectory(error)) {
        throw new ProductError("File path uses a symlink or non-directory component", 409);
      }
      throw error;
    } finally {
      await sourceHandle?.close();
      await sourceParent?.close();
      await closeQuarantine(quarantine);
    }
  }

  async removeIsolatedEntry(
    target: EntryDeletionTarget,
    operations: FileDeletionOperationStore
  ): Promise<void> {
    const normalized = this.normalizeTarget(target);
    const state = await operations.findFileDeletionOperation(normalized.owner);
    if (!state) throw new ProductError("File deletion operation is not isolated", 409);

    let quarantine: OpenQuarantine | null = null;
    try {
      quarantine = await this.openQuarantine(normalized, false, state.phase === "removed");
      if (state.phase === "isolated") {
        if (!quarantine) {
          throw deletionIncomplete(new Error("File deletion quarantine is missing"));
        }
        if (quarantine.marker !== "exact") {
          throw deletionIncomplete(new Error("File deletion operation marker is missing"));
        }
        const isolatedStat = await this.tree.optionalStat(quarantine.operation, QUARANTINE_ENTRY);
        if (isolatedStat) {
          assertQuarantineIdentity(state, isolatedStat);
          await this.tree.removeEntry(quarantine.operation, QUARANTINE_ENTRY, isolatedStat);
          await quarantine.operation.sync();
        }
        if (!await operations.persistFileDeletionOperation(normalized.owner, { ...state, phase: "removed" })) {
          throw deletionIncomplete(new Error("File deletion operation lost its claim"));
        }
      }

      if (quarantine) {
        await removeMarker(quarantine.operation);
        await quarantine.operation.sync();
      }
    } catch (error) {
      throw deletionIncomplete(error);
    } finally {
      await closeQuarantine(quarantine);
    }

    await this.removeEmptyOperationDirectory(normalized);
  }

  private normalizeTarget(target: EntryDeletionTarget): NormalizedDeletionTarget {
    validateOperationId(target.owner.resourceId);
    if (target.owner.operation !== "project.file.delete") {
      throw new ProductError("File deletion operation identity is invalid", 500);
    }
    const libraryRoot = this.paths.normalizeRelativeProjectPath(target.libraryRoot);
    const relativePath = this.paths.normalizeRelativeProjectPath(target.relativePath);
    this.paths.assertEntryDeleteAllowed(relativePath);
    return { ...target, libraryRoot, relativePath };
  }

  private async persistQuarantinedState(
    target: NormalizedDeletionTarget,
    operations: FileDeletionOperationStore,
    operationDirectory: FileHandle
  ): Promise<IsolatedEntryDeletion> {
    const stat = await this.tree.requiredStat(operationDirectory, QUARANTINE_ENTRY);
    const state: FileDeletionOperationState = {
      phase: "isolated",
      quarantineDevice: stat.dev.toString(),
      quarantineInode: stat.ino.toString(),
      entryType: descriptorEntryType(stat),
      bytes: await this.tree.measureEntry(operationDirectory, QUARANTINE_ENTRY, stat)
    };
    if (!await operations.persistFileDeletionOperation(target.owner, state)) {
      throw new ProductError("File deletion operation phase conflict", 409);
    }
    return completedIsolation(target.owner, state);
  }

  private async openSourceParent(projectRoot: string, libraryRoot: string, parentSegments: string[]): Promise<FileHandle> {
    let current = await this.paths.openProjectRoot(projectRoot, false);
    try {
      for (const segment of [...libraryRoot.split("/"), ...parentSegments]) {
        const next = await this.tree.openDirectory(current, segment);
        await current.close();
        current = next;
      }
      return current;
    } catch (error) {
      await current.close();
      throw error;
    }
  }

  private async openQuarantine(
    target: NormalizedDeletionTarget,
    create: boolean,
    allowMissingMarker = false
  ): Promise<OpenQuarantine | null> {
    const project = await this.paths.openProjectRoot(target.projectRoot, create);
    let deletions: FileHandle | null = null;
    let operation: FileHandle | null = null;
    try {
      deletions = await openOrCreateAnchoredDirectory(this.tree, project, QUARANTINE_ROOT, create);
      if (!deletions) return null;
      operation = await openOrCreateAnchoredDirectory(this.tree, deletions, target.owner.resourceId, create);
      if (!operation) return null;
      const marker = await operationMarkerState(operation, target, create, allowMissingMarker);
      return { project, deletions, operation, marker };
    } catch (error) {
      await operation?.close();
      await deletions?.close();
      await project.close();
      throw error;
    } finally {
      if (!operation) {
        await deletions?.close();
        await project.close();
      }
    }
  }

  private async removeEmptyOperationDirectory(target: NormalizedDeletionTarget): Promise<void> {
    const project = await this.paths.openProjectRoot(target.projectRoot, false);
    let deletions: FileHandle | null = null;
    try {
      deletions = await openOrCreateAnchoredDirectory(this.tree, project, QUARANTINE_ROOT, false);
      if (!deletions) return;
      try {
        await rmdir(descriptorPath(deletions, target.owner.resourceId));
        await deletions.sync();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    } finally {
      await deletions?.close();
      await project.close();
    }
  }
}

export class TransientFileDeletionOperationStore implements FileDeletionOperationStore {
  private readonly operations = new Map<string, {
    owner: FileDeletionOperationOwner;
    state: FileDeletionOperationState;
  }>();

  async findFileDeletionOperation(owner: FileDeletionOperationOwner): Promise<FileDeletionOperationState | null> {
    const record = this.operations.get(transientOwnerKey(owner));
    return record && sameDeletionOwner(record.owner, owner) ? { ...record.state } : null;
  }

  async persistFileDeletionOperation(
    owner: FileDeletionOperationOwner,
    state: FileDeletionOperationState
  ): Promise<boolean> {
    const key = transientOwnerKey(owner);
    const current = this.operations.get(key);
    if (current && !sameDeletionOwner(current.owner, owner)) return false;
    if (!isFileDeletionOperationTransition(current?.state ?? null, state)) return false;
    this.operations.set(key, { owner: { ...owner }, state: { ...state } });
    return true;
  }
}

function completedIsolation(
  owner: FileDeletionOperationOwner,
  state: FileDeletionOperationState
): IsolatedEntryDeletion {
  return {
    operationId: owner.resourceId,
    entryType: state.entryType,
    bytes: state.bytes
  };
}

async function openOrCreateAnchoredDirectory(
  tree: DescriptorFileTreeWalker,
  parent: FileHandle,
  name: string,
  create: boolean
): Promise<FileHandle | null> {
  try {
    return await tree.openDirectory(parent, name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (!create) return null;
    try {
      await mkdir(descriptorPath(parent, name), { mode: 0o700 });
      await parent.sync();
    } catch (mkdirError) {
      if (!isAlreadyExists(mkdirError)) throw mkdirError;
    }
    return tree.openDirectory(parent, name);
  }
}

function validateOperationId(value: string): void {
  if (!value || value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new ProductError("File deletion operation identity is invalid", 500);
  }
}

function observedStaticEntryType(stat: Awaited<ReturnType<FileHandle["stat"]>>): "file" | "directory" {
  if (stat.isSymbolicLink()) throw new ProductError("File path uses a symlink", 409);
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  throw new ProductError("File path type is not supported", 409);
}

function assertQuarantineIdentity(
  state: FileDeletionOperationState,
  stat: { dev: bigint; ino: bigint; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
): void {
  if (
    stat.dev.toString() !== state.quarantineDevice ||
    stat.ino.toString() !== state.quarantineInode ||
    descriptorEntryType(stat) !== state.entryType
  ) {
    throw new ProductError("Quarantined file entry changed during deletion", 500);
  }
}

async function operationMarkerState(
  operationDirectory: FileHandle,
  target: NormalizedDeletionTarget,
  create: boolean,
  allowMissing: boolean
): Promise<OpenQuarantine["marker"]> {
  const names = await readdir(descriptorPath(operationDirectory));
  names.forEach(validateDescriptorName);
  const hasEntry = names.includes(QUARANTINE_ENTRY);
  const hasFinal = names.includes(OPERATION_MARKER);
  const hasPending = names.includes(PENDING_OPERATION_MARKER);
  const unexpected = names.filter((name) =>
    name !== QUARANTINE_ENTRY && name !== OPERATION_MARKER && name !== PENDING_OPERATION_MARKER
  );
  const expected = expectedOperationMarker(target);

  if (hasFinal) {
    let stored: string;
    try {
      stored = await readMarker(operationDirectory, OPERATION_MARKER);
    } catch {
      throw new MarkerValidationError("File deletion operation marker cannot be validated", hasEntry);
    }
    if (stored !== expected) {
      throw new MarkerValidationError("File deletion operation marker does not match", hasEntry);
    }
    if (hasPending || unexpected.length > 0) {
      throw new MarkerValidationError("File deletion operation marker directory is not exact", hasEntry);
    }
    return "exact";
  }

  if (hasEntry) {
    throw new MarkerValidationError("File deletion operation marker is missing", true);
  }
  if (unexpected.length > 0) {
    throw new MarkerValidationError("File deletion operation marker directory is not empty", false);
  }
  if (allowMissing) return "removed_without_marker";
  if (!create) return "repairable";

  if (hasPending) {
    await unlink(descriptorPath(operationDirectory, PENDING_OPERATION_MARKER));
    await operationDirectory.sync();
  }
  await publishOperationMarker(operationDirectory, expected);
  return "exact";
}

async function publishOperationMarker(operationDirectory: FileHandle, expected: string): Promise<void> {
  const pendingPath = descriptorPath(operationDirectory, PENDING_OPERATION_MARKER);
  await writeFile(pendingPath, expected, { flag: "wx", mode: 0o600 });
  const pending = await open(pendingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await pending.sync();
  } finally {
    await pending.close();
  }
  await rename(pendingPath, descriptorPath(operationDirectory, OPERATION_MARKER));
  await operationDirectory.sync();
}

async function readMarker(operationDirectory: FileHandle, name: string): Promise<string> {
  const marker = await open(
    descriptorPath(operationDirectory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    return await marker.readFile("utf8");
  } finally {
    await marker.close();
  }
}

function expectedOperationMarker(target: NormalizedDeletionTarget): string {
  return JSON.stringify({
    version: 1,
    kind: "entry",
    projectId: target.owner.projectId,
    libraryRoot: target.libraryRoot,
    relativePath: target.relativePath,
    operationId: target.owner.resourceId,
    requestHash: target.owner.requestHash
  });
}

async function removeMarker(operationDirectory: FileHandle): Promise<void> {
  for (const name of [OPERATION_MARKER, PENDING_OPERATION_MARKER]) {
    try {
      await unlink(descriptorPath(operationDirectory, name));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

class MarkerValidationError extends ProductError {
  constructor(message: string, readonly quarantinedEntryExists: boolean) {
    super(message, quarantinedEntryExists ? 500 : 409);
  }
}

async function closeQuarantine(quarantine: OpenQuarantine | null): Promise<void> {
  if (!quarantine) return;
  await quarantine.operation.close();
  await quarantine.deletions.close();
  await quarantine.project.close();
}

function transientOwnerKey(owner: FileDeletionOperationOwner): string {
  return `${owner.actorId}\0${owner.projectId}\0${owner.operation}\0${owner.key}`;
}

function sameDeletionOwner(left: FileDeletionOperationOwner, right: FileDeletionOperationOwner): boolean {
  return left.actorId === right.actorId &&
    left.projectId === right.projectId &&
    left.operation === right.operation &&
    left.key === right.key &&
    left.requestHash === right.requestHash &&
    left.resourceId === right.resourceId &&
    left.claimToken === right.claimToken;
}

function deletionIncomplete(error: unknown): ProductError {
  const message = error instanceof Error ? error.message : "File deletion could not be completed";
  return new ProductError(message, 500, "file_deletion_incomplete");
}

function filePathNotFound(): ProductError {
  return new ProductError("File path not found", 404, "file_path_not_found");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isCrossDevice(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EXDEV";
}

function isSymlinkOrNotDirectory(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ELOOP" || error.code === "ENOTDIR");
}
