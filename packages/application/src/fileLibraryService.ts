import type { CreateFileLibraryInput, FileLibrary, FileLibraryProjection, RenameFileLibraryInput } from "../../contracts/src/api.js";
import { NotFoundError, ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { PRODUCT_NAME_MAX_LENGTH, requireNonEmptyString } from "../../domain/src/validation.js";
import type { FileLibraryBindingLookup, ProductStore } from "../../ports/src/store.js";
import type { AuthorizationService } from "./authorizationService.js";
import { withFileLibraryLifecycleLock } from "./fileLibraryLifecycleLock.js";
import type { FileService } from "./fileService.js";
import { runIdempotentMutation } from "./idempotentMutation.js";

interface LibraryFileScope {
  library: FileLibrary;
  projectRoot:string;
  rootSubPaths:string[];
}

export class FileLibraryService {
  constructor(
    private readonly store: ProductStore,
    private readonly authorization: AuthorizationService,
    private readonly files: FileService,
    private readonly projectAbsoluteRoot: (rootPath: string) => string
  ) {}

  async list(userId: string, projectId: string): Promise<FileLibraryProjection[]> {
    const access = await this.authorization.projectAccess(userId, projectId);
    const libraries = await this.store.listFileLibrariesForProject(projectId);
    return Promise.all(libraries.map(async (library) => this.project(library, access.canWrite && access.writableLifecycle)));
  }

  async create(userId: string, projectId: string, input: CreateFileLibraryInput, idempotencyKey?: string): Promise<FileLibraryProjection> {
    const project = await this.authorization.requireProject(userId, projectId, "write");
    const name = this.name(input.name);
    const create = (id: string) => withFileLibraryLifecycleLock(projectId, async () => {
      const currentProject = await this.authorization.requireProject(userId, projectId, "write");
      const existing = await this.store.findFileLibrary(id);
      if (existing) {
        if (existing.projectId !== projectId || existing.workspaceId !== currentProject.workspaceId || existing.name !== name) {
          throw new ProductError("File Library create identity conflict", 409);
        }
        await this.files.ensureLibraryRoot(this.projectAbsoluteRoot(currentProject.rootPath), existing.rootSubPath);
        return this.project(existing, true);
      }
      const timestamp = nowIso();
      const library: FileLibrary = {
        id,
        workspaceId: currentProject.workspaceId,
        projectId,
        name,
        rootSubPath: `libraries/${id}/home`,
        createdByUserId: userId,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      const created = await this.store.createFileLibrary(library);
      if (!created) throw new ProductError("File Library name already exists", 409);
      await this.files.ensureLibraryRoot(this.projectAbsoluteRoot(currentProject.rootPath), created.rootSubPath);
      return this.project(created, true);
    });
    if (!idempotencyKey) return create(newId("library"));
    return runIdempotentMutation({
      store: this.store,
      actorId: userId,
      scopeId: projectId,
      operation: "project.file-library.create",
      key: idempotencyKey,
      request: { projectId, name },
      resourceId: newId("library"),
      failureMessage: "File Library could not be created",
      completeServerErrors: false,
      run: create
    });
  }

  async rename(userId: string, projectId: string, libraryId: string, input: RenameFileLibraryInput): Promise<FileLibraryProjection> {
    return withFileLibraryLifecycleLock(projectId, async () => {
      await this.authorization.requireProject(userId, projectId, "write");
      const current = await this.requireInProject(projectId, libraryId);
      const updated = await this.store.renameFileLibrary(projectId, libraryId, this.name(input.name), input.expectedUpdatedAt, nowIso());
      if (!updated) {
        const latest = await this.store.findFileLibrary(libraryId);
        if (!latest || latest.projectId !== projectId) throw new NotFoundError("File Library not found");
        if (latest.updatedAt !== input.expectedUpdatedAt) throw new ProductError("File Library changed elsewhere. Reload and try again.", 409);
        throw new ProductError("File Library name already exists", 409);
      }
      if (updated.rootSubPath !== current.rootSubPath) throw new Error("File Library root path changed during rename");
      return this.project(updated, true);
    });
  }

  async remove(userId: string, projectId: string, libraryId: string): Promise<{ deleted: true }> {
    return withFileLibraryLifecycleLock(projectId, async () => {
      const project = await this.authorization.requireProject(userId, projectId, "write");
      const library = await this.requireInProject(projectId, libraryId);
      await this.files.removeEmptyLibraryRoot(this.projectAbsoluteRoot(project.rootPath), library.rootSubPath);
      const deleted=await this.store.deleteFileLibraryIfUnbound(projectId,libraryId);
      if(deleted!=="deleted"){
        await this.files.ensureLibraryRoot(this.projectAbsoluteRoot(project.rootPath), library.rootSubPath);
        if(deleted==="bound")throw new ProductError("File Library is bound to a Task",409);
        throw new NotFoundError("File Library not found");
      }
      return { deleted: true };
    });
  }

  async require(userId: string, projectId: string, libraryId: string, write = false): Promise<{ library: FileLibrary; projectRoot: string; canWriteFiles: boolean }> {
    const access = await this.authorization.projectAccess(userId, projectId);
    if (write) await this.authorization.requireProject(userId, projectId, "write");
    const library = await this.requireInProject(projectId, libraryId);
    return {
      library,
      projectRoot: this.projectAbsoluteRoot(access.project.rootPath),
      canWriteFiles: access.canWrite && access.writableLifecycle
    };
  }

  async deleteEntry(
    userId: string,
    projectId: string,
    libraryId: string,
    filePath: string,
    idempotencyKey: string,
    reconcile: (bytes: number) => Promise<void>
  ): Promise<{ deleted: true }> {
    return withFileLibraryLifecycleLock(projectId, async () => {
      const {
        library,
        projectRoot,
        rootSubPaths
      } = await this.requireLibraryFileScopeUnlocked(userId, projectId, libraryId);
      return runIdempotentMutation({
        store: this.store,
        actorId: userId,
        scopeId: projectId,
        operation: "project.file.delete",
        key: idempotencyKey,
        request: { projectId, libraryId, filePath },
        resourceId: newId("file_delete"),
        failureMessage: "File entry could not be deleted",
        completeServerErrors: false,
        run: async (operationId, context) => (await this.files.deleteLibraryFileWithAccounting(
          projectRoot,
          library.rootSubPath,
          filePath,
          {
            rootSubPaths,
            reconcile,
            record: async (storedPath, _delta, entry) => {
              await this.store.appendProjectAuditEvent({
                id: `audit:${operationId}`,
                projectId,
                actorId: userId,
                action: "file.delete",
                status: "accepted",
                resourceKind: "file",
                resourceId: library.id,
                detail: {
                  filePath: `${library.rootSubPath}/${storedPath}`,
                  bytes: entry.bytes,
                  ...(entry.entryType ? { entryType: entry.entryType } : {})
                },
                createdAt: nowIso()
              });
            }
          },
          {
            owner: context.owner,
            operations: this.store
          }
        )).response
      });
    });
  }

  async withLibraryMutation<T>(userId: string, projectId: string, libraryId: string, action: (scope: LibraryFileScope) => Promise<T>): Promise<T> {
    return withFileLibraryLifecycleLock(
      projectId,
      async () => action(await this.requireLibraryFileScopeUnlocked(userId, projectId, libraryId))
    );
  }

  async measureProjectFileBytes(userId: string, projectId: string): Promise<number> {
    const project=await this.authorization.requireProject(userId,projectId,"view");
    return this.files.measureFileRootsBytes(this.projectAbsoluteRoot(project.rootPath),await this.rootSubPaths(projectId));
  }

  async refreshProjectFileStorage<T>(userId:string,projectId:string,projectMeasurement:(bytes:number)=>Promise<T>):Promise<T>{
    const project=await this.authorization.requireProject(userId,projectId,"view");
    return this.files.measureFileRootsBytesAndProject(this.projectAbsoluteRoot(project.rootPath),await this.rootSubPaths(projectId),projectMeasurement);
  }

  async reconcileStoredProjectFileBytes<T>(projectId:string,reconcile:(bytes:number)=>Promise<T>):Promise<T>{
    const project=await this.store.findProject(projectId);
    if(!project)throw new NotFoundError("Project not found");
    return this.files.measureFileRootsBytesAndProject(this.projectAbsoluteRoot(project.rootPath),await this.rootSubPaths(projectId),reconcile);
  }

  private async rootSubPaths(projectId: string): Promise<string[]> {
    return (await this.store.listFileLibrariesForProject(projectId)).map((library) => library.rootSubPath);
  }

  private async requireLibraryFileScopeUnlocked(
    userId: string,
    projectId: string,
    libraryId: string
  ): Promise<LibraryFileScope> {
    const project = await this.authorization.requireProject(userId, projectId, "write");
    const library = await this.requireInProject(projectId, libraryId);
    return {
      library,
      projectRoot: this.projectAbsoluteRoot(project.rootPath),
      rootSubPaths: await this.rootSubPaths(projectId)
    };
  }

  private async requireInProject(projectId: string, id: string): Promise<FileLibrary> {
    const library = await this.store.findFileLibrary(id);
    if (!library || library.projectId !== projectId) throw new NotFoundError("File Library not found");
    return library;
  }

  private name(value: unknown): string {
    return requireNonEmptyString(value, "fileLibrary.name", PRODUCT_NAME_MAX_LENGTH);
  }

  private async project(library: FileLibrary, canWrite: boolean): Promise<FileLibraryProjection> {
    const binding: FileLibraryBindingLookup = await this.store.findTaskBoundToFileLibrary(library.id);
    const boundTask = binding.kind === "bound" ? binding.task : null;
    return {
      ...library,
      boundTask,
      capabilities: {
        canRename: canWrite,
        canDelete: canWrite && binding.kind === "unbound",
        canWriteFiles: canWrite
      }
    };
  }
}
