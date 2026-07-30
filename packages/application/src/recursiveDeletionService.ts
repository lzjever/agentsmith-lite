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
  type FileLibraryDeletionOperationOwner,
  type ProductStore
} from "../../ports/src/store.js";
import { ProductError } from "../../domain/src/errors.js";
import { nowIso } from "../../domain/src/ids.js";
import {
  DescriptorFileTreeWalker,
  descriptorEntryType,
  descriptorPath,
  type DescriptorTreeCheckpoint,
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
export type FileLibraryDeletionOperationStore = Pick<
  ProductStore,
  "findFileLibraryDeletionOperation" | "persistFileLibraryDeletionOperation"
>;

export interface EntryDeletionTarget {
  owner: FileDeletionOperationOwner;
  projectRoot: string;
  libraryRoot: string;
  relativePath: string;
}

export interface LibraryDeletionTarget {
  owner: FileLibraryDeletionOperationOwner;
  projectRoot: string;
  libraryId: string;
  libraryRoot: string;
}

export interface IsolatedEntryDeletion {
  operationId: string;
  entryType: FileDeletionOperationEntryType;
  bytes: number;
}

interface NormalizedDeletionTarget {
  kind: "entry" | "library";
  owner: FileDeletionOperationOwner | FileLibraryDeletionOperationOwner;
  projectRoot: string;
  libraryRoot: string;
  relativePath: string;
  operationId: string;
  sourceParentSegments: string[];
  sourceName: string;
}

interface OpenQuarantine {
  deletions: FileHandle;
  operation: FileHandle;
  marker: "exact" | "repairable" | "removed_without_marker";
}

interface DeletionOperationAccess {
  find(): Promise<FileDeletionOperationState | null>;
  persist(state: FileDeletionOperationState): Promise<boolean>;
  checkpoint?: DescriptorTreeCheckpoint;
}

export interface RecursiveDeletionObserver {
  beforeRename?(event: {
    kind: "entry" | "library";
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
    const normalized = this.normalizeEntryTarget(target);
    return this.isolate(normalized,{
      find:()=>operations.findFileDeletionOperation(target.owner),
      persist:(state)=>operations.persistFileDeletionOperation(target.owner,state)
    });
  }

  async isolateLibrary(
    target: LibraryDeletionTarget,
    operations: FileLibraryDeletionOperationStore,
    checkpoint?: DescriptorTreeCheckpoint
  ): Promise<IsolatedEntryDeletion> {
    const normalized = this.normalizeLibraryTarget(target);
    return this.isolate(normalized, {
      find: () => operations.findFileLibraryDeletionOperation(target.owner),
      persist: (state) => operations.persistFileLibraryDeletionOperation(target.owner, state, nowIso()),
      ...(checkpoint ? { checkpoint } : {})
    });
  }

  async deleteLibrary(
    target:LibraryDeletionTarget,
    operations:FileLibraryDeletionOperationStore,
    checkpoint:DescriptorTreeCheckpoint,
    afterIsolation:(isolated:IsolatedEntryDeletion,project:FileHandle)=>Promise<void>
  ):Promise<IsolatedEntryDeletion>{
    const normalized=this.normalizeLibraryTarget(target);
    const access:DeletionOperationAccess={
      find:()=>operations.findFileLibraryDeletionOperation(target.owner),
      persist:(state)=>operations.persistFileLibraryDeletionOperation(target.owner,state,nowIso()),
      checkpoint
    };
    const project=await this.paths.openProjectRoot(normalized.projectRoot,false);
    try{
      const isolated=await this.isolate(normalized,access,project);
      await afterIsolation(isolated,project);
      await this.removeIsolated(normalized,access,project);
      return isolated;
    }finally{
      await project.close();
    }
  }

  private async isolate(
    normalized:NormalizedDeletionTarget,
    operations:DeletionOperationAccess,
    projectDescriptor?:FileHandle
  ):Promise<IsolatedEntryDeletion>{
    const existing = await operations.find();
    if (existing) return completedIsolation(normalized.operationId, existing);

    let linearized = false;
    let project: FileHandle | null = projectDescriptor??null;
    const ownsProject=!projectDescriptor;
    let sourceParent: FileHandle | null = null;
    let sourceHandle: FileHandle | null = null;
    let quarantine: OpenQuarantine | null = null;
    try {
      await operations.checkpoint?.();
      project ??= await this.paths.openProjectRoot(normalized.projectRoot, false);
      quarantine = await this.openQuarantine(project, normalized, false);
      if (quarantine?.marker === "exact" && await this.tree.optionalStat(quarantine.operation, QUARANTINE_ENTRY)) {
        linearized = true;
        return await this.persistQuarantinedState(normalized, operations, quarantine.operation);
      }
      await closeQuarantine(quarantine);
      quarantine = null;

      sourceParent = await this.openSourceParent(project, normalized.sourceParentSegments);
      sourceHandle = await this.tree.openEntry(sourceParent, normalized.sourceName);
      const sourceStat=await sourceHandle.stat({bigint:true});
      if(normalized.kind==="entry")observedStaticEntryType(sourceStat);
      else if(sourceStat.isSymbolicLink()||!sourceStat.isDirectory()){
        throw new ProductError("File Library root is not a directory",409);
      }

      quarantine = await this.openQuarantine(project, normalized, true);
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
        await operations.checkpoint?.();
        await this.observer?.beforeRename?.({
          projectId: normalized.owner.projectId,
          kind: normalized.kind,
          operationId: normalized.operationId,
          relativePath: normalized.relativePath
        });
        await operations.checkpoint?.();
        await rename(
          descriptorPath(sourceParent, normalized.sourceName),
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
      if (linearized) throw deletionIncomplete(error, normalized.kind);
      if (isNotFound(error)){
        if(normalized.kind==="library")throw deletionIncomplete(error, normalized.kind);
        throw filePathNotFound();
      }
      if (isSymlinkOrNotDirectory(error)) {
        throw new ProductError("File path uses a symlink or non-directory component", 409);
      }
      throw error;
    } finally {
      await sourceHandle?.close();
      await sourceParent?.close();
      await closeQuarantine(quarantine);
      if(ownsProject)await project?.close();
    }
  }

  async removeIsolatedEntry(
    target: EntryDeletionTarget,
    operations: FileDeletionOperationStore
  ): Promise<void> {
    return this.removeIsolated(this.normalizeEntryTarget(target),{
      find:()=>operations.findFileDeletionOperation(target.owner),
      persist:(state)=>operations.persistFileDeletionOperation(target.owner,state)
    });
  }

  async removeIsolatedLibrary(
    target: LibraryDeletionTarget,
    operations: FileLibraryDeletionOperationStore,
    checkpoint?: DescriptorTreeCheckpoint
  ): Promise<void> {
    return this.removeIsolated(this.normalizeLibraryTarget(target), {
      find: () => operations.findFileLibraryDeletionOperation(target.owner),
      persist: (state) => operations.persistFileLibraryDeletionOperation(target.owner, state, nowIso()),
      ...(checkpoint ? { checkpoint } : {})
    });
  }

  private async removeIsolated(
    normalized:NormalizedDeletionTarget,
    operations:DeletionOperationAccess,
    projectDescriptor?:FileHandle
  ):Promise<void>{
    const state = await operations.find();
    if (!state) throw new ProductError("File deletion operation is not isolated", 409);

    let project: FileHandle | null = projectDescriptor??null;
    const ownsProject=!projectDescriptor;
    let quarantine: OpenQuarantine | null = null;
    try {
      await operations.checkpoint?.();
      project ??= await this.paths.openProjectRoot(normalized.projectRoot, false);
      quarantine = await this.openQuarantine(project, normalized, false, state.phase === "removed");
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
          await this.tree.removeEntry(
            quarantine.operation,
            QUARANTINE_ENTRY,
            isolatedStat,
            operations.checkpoint
          );
          await quarantine.operation.sync();
        }
        await operations.checkpoint?.();
        if (!await operations.persist({ ...state, phase: "removed" })) {
          throw deletionIncomplete(new Error("File deletion operation lost its claim"));
        }
      }

      if (quarantine) {
        await operations.checkpoint?.();
        await removeMarker(quarantine.operation);
        await quarantine.operation.sync();
      }
      await closeQuarantine(quarantine);
      quarantine = null;
      await this.removeEmptyOperationDirectory(project, normalized);
    } catch (error) {
      throw deletionIncomplete(error, normalized.kind);
    } finally {
      await closeQuarantine(quarantine);
      if(ownsProject)await project?.close();
    }
  }

  private normalizeEntryTarget(target: EntryDeletionTarget): NormalizedDeletionTarget {
    validateOperationId(target.owner.resourceId);
    if (target.owner.operation !== "project.file.delete") {
      throw new ProductError("File deletion operation identity is invalid", 500);
    }
    const libraryRoot = this.paths.normalizeRelativeProjectPath(target.libraryRoot);
    const relativePath = this.paths.normalizeRelativeProjectPath(target.relativePath);
    this.paths.assertEntryDeleteAllowed(relativePath);
    const segments=relativePath.split("/");
    const sourceName=segments.pop()!;
    return {
      ...target,
      kind:"entry",
      libraryRoot,
      relativePath,
      operationId:target.owner.resourceId,
      sourceParentSegments:[...libraryRoot.split("/"),...segments],
      sourceName
    };
  }

  private normalizeLibraryTarget(target:LibraryDeletionTarget):NormalizedDeletionTarget{
    validateOperationId(target.owner.operationId);
    if(target.owner.operationId!==`file-library-delete:${target.libraryId}`){
      throw new ProductError("File Library deletion operation identity is invalid",500);
    }
    const libraryRoot=this.paths.normalizeRelativeProjectPath(target.libraryRoot);
    const segments=libraryRoot.split("/");
    const rootName=segments[1]??"";
    const attemptPrefix=`${target.libraryId}-attempt_`;
    if(segments.length!==3||segments[0]!=="libraries"||segments[2]!=="home"||
      !(rootName===target.libraryId||
        rootName.startsWith(attemptPrefix)&&/^[A-Za-z0-9._:-]+$/.test(rootName.slice(attemptPrefix.length)))){
      throw new ProductError("File Library root path is invalid",409);
    }
    return{
      ...target,
      kind:"library",
      libraryRoot,
      relativePath:libraryRoot,
      operationId:target.owner.operationId,
      sourceParentSegments:["libraries",rootName],
      sourceName:"home"
    };
  }

  private async persistQuarantinedState(
    target: NormalizedDeletionTarget,
    operations: DeletionOperationAccess,
    operationDirectory: FileHandle
  ): Promise<IsolatedEntryDeletion> {
    const stat = await this.tree.requiredStat(operationDirectory, QUARANTINE_ENTRY);
    const state: FileDeletionOperationState = {
      phase: "isolated",
      quarantineDevice: stat.dev.toString(),
      quarantineInode: stat.ino.toString(),
      entryType: descriptorEntryType(stat),
      bytes: await this.tree.measureEntry(
        operationDirectory,
        QUARANTINE_ENTRY,
        stat,
        operations.checkpoint
      )
    };
    await operations.checkpoint?.();
    if (!await operations.persist(state)) {
      throw new ProductError("File deletion operation phase conflict", 409);
    }
    return completedIsolation(target.operationId, state);
  }

  private async openSourceParent(project: FileHandle, segments: string[]): Promise<FileHandle> {
    let current = await open(
      descriptorPath(project),
      constants.O_RDONLY | constants.O_DIRECTORY
    );
    try {
      for (const segment of segments) {
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
    project: FileHandle,
    target: NormalizedDeletionTarget,
    create: boolean,
    allowMissingMarker = false
  ): Promise<OpenQuarantine | null> {
    let deletions: FileHandle | null = null;
    let operation: FileHandle | null = null;
    try {
      deletions = await openOrCreateAnchoredDirectory(this.tree, project, QUARANTINE_ROOT, create);
      if (!deletions) return null;
      operation = await openOrCreateAnchoredDirectory(this.tree, deletions, target.operationId, create);
      if (!operation) return null;
      const marker = await operationMarkerState(operation, target, create, allowMissingMarker);
      return { deletions, operation, marker };
    } catch (error) {
      await operation?.close();
      await deletions?.close();
      throw error;
    } finally {
      if (!operation) {
        await deletions?.close();
      }
    }
  }

  private async removeEmptyOperationDirectory(
    project: FileHandle,
    target: NormalizedDeletionTarget
  ): Promise<void> {
    let deletions: FileHandle | null = null;
    try {
      deletions = await openOrCreateAnchoredDirectory(this.tree, project, QUARANTINE_ROOT, false);
      if (!deletions) return;
      try {
        await rmdir(descriptorPath(deletions, target.operationId));
        await deletions.sync();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    } finally {
      await deletions?.close();
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
  operationId:string,
  state: FileDeletionOperationState
): IsolatedEntryDeletion {
  return {
    operationId,
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
  return target.kind==="entry"
    ?JSON.stringify({
      version:1,
      kind:"entry",
      projectId:target.owner.projectId,
      libraryRoot:target.libraryRoot,
      relativePath:target.relativePath,
      operationId:target.operationId,
      requestHash:(target.owner as FileDeletionOperationOwner).requestHash
    })
    :JSON.stringify({
      version:1,
      kind:"library",
      projectId:target.owner.projectId,
      libraryId:(target.owner as FileLibraryDeletionOperationOwner).libraryId,
      libraryRoot:target.libraryRoot,
      operationId:target.operationId
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

function deletionIncomplete(error: unknown, kind: "entry" | "library" = "entry"): ProductError {
  return kind === "library"
    ? new ProductError(
      "File Library deletion is in progress",
      409,
      "file_library_deleting"
    )
    : new ProductError("File deletion could not be completed", 500, "file_deletion_incomplete");
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
