import type { CreateFileLibraryInput, FileLibrary, FileLibraryProjection, FileLibraryTaskLink, RenameFileLibraryInput } from "../../contracts/src/api.js";
import { NotFoundError, ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { PRODUCT_NAME_MAX_LENGTH, requireNonEmptyString } from "../../domain/src/validation.js";
import type { FileLibraryBindingLookup, ProductStore } from "../../ports/src/store.js";
import type { AuthorizationService } from "./authorizationService.js";
import { withFileLibraryLifecycleLock } from "./fileLibraryLifecycleLock.js";
import type { FileService } from "./fileService.js";
import { canonicalRequestHash, runIdempotentMutation } from "./idempotentMutation.js";

const REQUEST_LEASE_MS=30_000;
const PHYSICAL_LEASE_MS=30_000;
const PHYSICAL_HEARTBEAT_MS=10_000;

interface FileLibraryDeletionHeartbeatOptions{
  leaseMs?:number;
  intervalMs?:number;
}

export class FileLibraryBoundError extends ProductError{
  constructor(readonly task:FileLibraryTaskLink){
    super("File Library is bound to a Task",409,"file_library_bound");
  }
}

interface LibraryFileScope {
  library: FileLibrary;
  projectRoot:string;
  rootSubPaths:string[];
  canWriteFiles:boolean;
}

export class FileLibraryService {
  constructor(
    private readonly store: ProductStore,
    private readonly authorization: AuthorizationService,
    private readonly files: FileService,
    private readonly projectAbsoluteRoot: (rootPath: string) => string,
    private readonly heartbeatOptions:FileLibraryDeletionHeartbeatOptions={}
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
        this.requireActive(existing);
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
        lifecycleStatus:"active",
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
      this.requireActive(current);
      const updated = await this.store.renameFileLibrary(projectId, libraryId, this.name(input.name), input.expectedUpdatedAt, nowIso());
      if (!updated) {
        const latest = await this.store.findFileLibrary(libraryId);
        if (!latest || latest.projectId !== projectId) throw new NotFoundError("File Library not found");
        this.requireActive(latest);
        if (latest.updatedAt !== input.expectedUpdatedAt) throw new ProductError("File Library changed elsewhere. Reload and try again.", 409);
        throw new ProductError("File Library name already exists", 409);
      }
      if (updated.rootSubPath !== current.rootSubPath) throw new Error("File Library root path changed during rename");
      return this.project(updated, true);
    });
  }

  async remove(
    userId:string,
    projectId:string,
    libraryId:string,
    idempotencyKey:string,
    reconcile:(bytes:number)=>Promise<void>
  ):Promise<{deleted:true}>{
    return withFileLibraryLifecycleLock(projectId, async () => {
      const project = await this.authorization.requireProject(userId, projectId, "write");
      const heartbeatTiming=this.fileLibraryDeletionHeartbeatTiming();
      const timestamp=nowIso();
      const requestHash=canonicalRequestHash({projectId,libraryId});
      const operationId=`file-library-delete:${libraryId}`;
      const receiptClaimToken=newId("idempotency_claim");
      const receipt={
        actorId:userId,
        projectId,
        operation:"project.file-library.delete" as const,
        key:idempotencyKey,
        requestHash,
        resourceId:operationId,
        claimToken:receiptClaimToken,
        now:timestamp,
        leaseExpiresAt:new Date(Date.parse(timestamp)+REQUEST_LEASE_MS).toISOString()
      };
      const begun=await this.store.beginFileLibraryDeletion({libraryId,idempotency:receipt});
      if(begun.kind==="hash_mismatch")throw new ProductError("Idempotency-Key was already used with a different request",409);
      if(begun.kind==="in_progress")throw fileLibraryDeleting();
      if(begun.kind==="replay")return replayFileLibraryDeletion(begun.responseStatus,begun.responseBody);
      if(begun.kind==="bound"){
        const body=fileLibraryBoundBody(begun.task);
        await this.completeDeletionReceipt(receipt,409,body);
        throw new FileLibraryBoundError(begun.task);
      }
      if(begun.kind==="not_found"){
        const body={error:"File Library not found",code:"file_library_not_found"};
        await this.completeDeletionReceipt(receipt,404,body);
        throw new ProductError("File Library not found",404,"file_library_not_found");
      }
      const physicalClaimToken=newId("file_library_delete_claim");
      const physicalOwner={
        projectId,
        libraryId,
        operationId:begun.operationId,
        claimToken:physicalClaimToken
      };
      let physical;
      try{
        physical=await this.store.claimFileLibraryDeletionOperation({
          ...physicalOwner,
          now:timestamp,
          leaseMs:heartbeatTiming.leaseMs
        });
      }catch(error){
        console.error("File Library deletion claim failed",error);
        throw fileLibraryDeleting();
      }
      if(physical.kind!=="claimed")throw fileLibraryDeleting();
      const heartbeat=new FileLibraryDeletionHeartbeat(
        this.store,
        physicalOwner,
        heartbeatTiming.leaseMs,
        heartbeatTiming.intervalMs
      );
      heartbeat.start();
      let finalized=false;
      try{
        await this.files.deleteLibraryRootWithAccounting(
          this.projectAbsoluteRoot(project.rootPath),
          libraryId,
          begun.library.rootSubPath,
          await this.rootSubPaths(projectId),
          reconcile,
          {owner:physicalOwner,operations:this.store,checkpoint:()=>heartbeat.checkpoint()}
        );
        const response={deleted:true as const};
        const result=await heartbeat.finalize(()=>this.store.finalizeFileLibraryDeletion({
            ...physicalOwner,
            requestHash,
            actorId:userId,
            responseStatus:200,
            responseBody:response,
            updatedAt:nowIso()
          }));
        if(result!=="finalized")throw fileLibraryDeleting();
        finalized=true;
        return response;
      }catch(error){
        if(!(error instanceof ProductError&&error.code==="file_library_deleting")){
          console.error("File Library deletion operation failed",error);
        }
        throw fileLibraryDeleting();
      }finally{
        await heartbeat.stop();
        if(!finalized){
          try{
            await this.store.releaseFileLibraryDeletionOperation(physicalOwner);
          }catch(error){
            console.error("File Library deletion claim release failed",error);
          }
        }
      }
    });
  }

  async require(userId: string, projectId: string, libraryId: string, write = false): Promise<{ library: FileLibrary; projectRoot: string; canWriteFiles: boolean }> {
    const access = await this.authorization.projectAccess(userId, projectId);
    if (write) await this.authorization.requireProject(userId, projectId, "write");
    const library = await this.requireInProject(projectId, libraryId);
    this.requireActive(library);
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
      async () => action(await this.requireLibraryFileScopeUnlocked(userId, projectId, libraryId,true))
    );
  }

  async withLibraryFileAccess<T>(userId:string,projectId:string,libraryId:string,action:(scope:LibraryFileScope)=>Promise<T>):Promise<T>{
    return withFileLibraryLifecycleLock(
      projectId,
      async()=>action(await this.requireLibraryFileScopeUnlocked(userId,projectId,libraryId,false))
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
    return (await this.store.listFileLibrariesForProject(projectId))
      .filter((library)=>library.lifecycleStatus==="active")
      .map((library) => library.rootSubPath);
  }

  private fileLibraryDeletionHeartbeatTiming():{leaseMs:number;intervalMs:number}{
    const leaseMs=this.heartbeatOptions.leaseMs??PHYSICAL_LEASE_MS;
    const intervalMs=this.heartbeatOptions.intervalMs??PHYSICAL_HEARTBEAT_MS;
    if(!Number.isSafeInteger(leaseMs)||leaseMs<=0||
      !Number.isSafeInteger(intervalMs)||intervalMs<=0||intervalMs>=leaseMs){
      throw new Error("File Library deletion heartbeat timing is invalid");
    }
    return{leaseMs,intervalMs};
  }

  private async requireLibraryFileScopeUnlocked(
    userId: string,
    projectId: string,
    libraryId: string,
    write=true
  ): Promise<LibraryFileScope> {
    const access=await this.authorization.projectAccess(userId,projectId);
    if(write)await this.authorization.requireProject(userId,projectId,"write");
    const library = await this.requireInProject(projectId, libraryId);
    this.requireActive(library);
    return {
      library,
      projectRoot: this.projectAbsoluteRoot(access.project.rootPath),
      rootSubPaths: await this.rootSubPaths(projectId),
      canWriteFiles:access.canWrite&&access.writableLifecycle
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

  private requireActive(library:FileLibrary):void{
    if(library.lifecycleStatus==="deleting"){
      throw new ProductError("File Library deletion is in progress",409,"file_library_deleting");
    }
  }

  private async completeDeletionReceipt(
    receipt:Parameters<ProductStore["beginTaskIdempotency"]>[0],
    responseStatus:number,
    responseBody:unknown
  ):Promise<void>{
    if(!await this.store.completeTaskIdempotency({...receipt,responseStatus,responseBody,updatedAt:nowIso()})){
      throw new ProductError("File Library deletion receipt lost its claim",409);
    }
  }

  private async project(library: FileLibrary, canWrite: boolean): Promise<FileLibraryProjection> {
    const binding: FileLibraryBindingLookup = await this.store.findTaskBoundToFileLibrary(library.id);
    const boundTask = binding.kind === "bound" ? binding.task : null;
    return {
      ...library,
      boundTask,
      capabilities: {
        canRename: canWrite&&library.lifecycleStatus==="active",
        canDelete: canWrite&&(library.lifecycleStatus==="deleting"||binding.kind==="unbound"),
        canWriteFiles: canWrite&&library.lifecycleStatus==="active"
      }
    };
  }
}

function fileLibraryBoundBody(task:FileLibraryTaskLink){
  return{error:"File Library is bound to a Task",code:"file_library_bound",task};
}

function replayFileLibraryDeletion(status:number,body:unknown):{deleted:true}{
  if(status<400&&isRecord(body)&&body.deleted===true)return{deleted:true};
  if(isRecord(body)&&body.code==="file_library_bound"&&isTaskLink(body.task))throw new FileLibraryBoundError(body.task);
  throw new ProductError(
    isRecord(body)&&typeof body.error==="string"?body.error:"File Library could not be deleted",
    status,
    isRecord(body)&&typeof body.code==="string"?body.code:undefined
  );
}

function isRecord(value:unknown):value is Record<string,unknown>{
  return Boolean(value&&typeof value==="object"&&!Array.isArray(value));
}

function isTaskLink(value:unknown):value is FileLibraryTaskLink{
  return isRecord(value)&&typeof value.id==="string"&&(typeof value.title==="string"||value.title===null);
}

function fileLibraryDeleting():ProductError{
  return new ProductError(
    "File Library deletion is in progress",
    409,
    "file_library_deleting"
  );
}

class FileLibraryDeletionHeartbeat{
  private stopped=false;
  private finishing=false;
  private lost=false;
  private loopPromise:Promise<void>|null=null;
  private renewal:Promise<void>|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private wake:(()=>void)|null=null;

  constructor(
    private readonly store:Pick<ProductStore,"renewFileLibraryDeletionOperation">,
    private readonly owner:Parameters<ProductStore["renewFileLibraryDeletionOperation"]>[0],
    private readonly leaseMs:number,
    private readonly intervalMs:number
  ){}

  start():void{
    if(this.loopPromise)return;
    this.loopPromise=this.run();
  }

  async checkpoint():Promise<void>{
    await this.renewal;
    if(this.lost)throw fileLibraryDeleting();
  }

  async finalize<T>(action:()=>Promise<T>):Promise<T>{
    this.finishing=true;
    this.wakeTimer();
    await this.loopPromise;
    await this.runRenewal();
    await this.checkpoint();
    return action();
  }

  async stop():Promise<void>{
    this.stopped=true;
    this.wakeTimer();
    await this.loopPromise;
    await this.renewal;
  }

  private async run():Promise<void>{
    while(!this.stopped&&!this.finishing){
      await this.wait();
      if(this.stopped||this.finishing)break;
      await this.runRenewal();
    }
  }

  private async runRenewal():Promise<void>{
    if(this.renewal){
      await this.renewal;
      return;
    }
    const renewal=this.renewOnce();
    this.renewal=renewal;
    try{
      await renewal;
    }finally{
      if(this.renewal===renewal)this.renewal=null;
    }
  }

  private async renewOnce():Promise<void>{
    try{
      if(!await this.store.renewFileLibraryDeletionOperation(this.owner,this.leaseMs)){
        this.lost=true;
      }
    }catch(error){
      this.lost=true;
      console.error("File Library deletion heartbeat failed",error);
    }
  }

  private wait():Promise<void>{
    return new Promise((resolve)=>{
      const finish=()=>{
        if(this.timer)clearTimeout(this.timer);
        this.timer=null;
        this.wake=null;
        resolve();
      };
      this.wake=finish;
      this.timer=setTimeout(finish,this.intervalMs);
    });
  }

  private wakeTimer():void{
    this.wake?.();
  }
}
