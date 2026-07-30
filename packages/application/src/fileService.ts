import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  rmdir,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import type {
  DeleteProjectFileResponse,
  ProjectFileDeletionEntryType,
  ProjectFileDownloadResponse,
  ProjectFileListEntry,
  ProjectFileListResponse,
  ProjectFileWriteResponse,
  UploadProjectFileInput
} from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import { MAX_PROJECT_FILE_BYTES } from "../../domain/src/fileDefaults.js";
import type { FileDeletionOperationOwner, FileLibraryDeletionOperationOwner, ProductStore } from "../../ports/src/store.js";
import {
  DescriptorFileTreeWalker,
  descriptorPath,
  type DescriptorFileIdentity,
  type DescriptorTreeCheckpoint
} from "./descriptorFileTreeWalker.js";
import { FilePathValidationService } from "./filePathValidationService.js";
import {
  RecursiveDeletionService,
  TransientFileDeletionOperationStore,
  type FileDeletionOperationStore,
  type IsolatedEntryDeletion,
  type RecursiveDeletionObserver
} from "./recursiveDeletionService.js";

interface ResolvedProjectFilePath {
  normalizedPath: string;
  absolutePath: string;
}

export interface PersistedLibraryFile {
  location:LibraryOwnedFileLocation;
  identity:DescriptorFileIdentity|null;
  existingBytes:Buffer|null;
  newlyWritten:boolean;
}

export interface LibraryOwnedFileLocation {
  projectRoot:string;
  rootSubPath:string;
  relativePath:string;
}

interface DeletedProjectFile {
  response: DeleteProjectFileResponse;
  bytes: number;
  mediaType: string;
}

interface FileByteAccounting {
  rootSubPaths?: string[];
  reconcile?(bytes: number): Promise<void>;
  record(path: string, delta: number, file: {
    bytes: number;
    mediaType: string;
    entryType?: ProjectFileDeletionEntryType;
  }): Promise<void>;
}

export interface FileUploadAccounting {
  rootSubPaths?:string[];
  reconcile?(bytes:number):Promise<void>;
  reserve(path:string,delta:number,file:{bytes:number;mediaType:string}):Promise<void>;
  committed(path:string,file:{bytes:number;mediaType:string}):Promise<void>;
}

interface FileDeletionContext {
  owner: FileDeletionOperationOwner;
  operations: FileDeletionOperationStore;
}

interface FileLibraryDeletionContext {
  owner:FileLibraryDeletionOperationOwner;
  checkpoint:DescriptorTreeCheckpoint;
  operations:Pick<ProductStore,
    "findFileLibraryDeletionOperation"|
    "persistFileLibraryDeletionOperation"
  >;
}

const projectFileOperations = new Map<string, Promise<void>>();

export async function withProjectFileLock<T>(projectRoot: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectRoot);
  const previous = projectFileOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  projectFileOperations.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (projectFileOperations.get(key) === current) {
      projectFileOperations.delete(key);
    }
  }
}

export class FileService {
  private readonly deletion: RecursiveDeletionService;
  private readonly transientDeletionOperations = new TransientFileDeletionOperationStore();

  constructor(
    private readonly paths = new FilePathValidationService(),
    private readonly tree = new DescriptorFileTreeWalker(),
    deletionObserver?: RecursiveDeletionObserver
  ) {
    this.deletion = new RecursiveDeletionService(paths, tree, deletionObserver);
  }

  private async resolveLibraryFilePath(projectRoot:string,rootSubPath:string,input:string,allowRoot=false,enforceOrdinaryPolicy=true):Promise<ResolvedProjectFilePath>{
    const canonicalRoot=this.normalizeLibraryRootSubPath(rootSubPath);
    const normalizedPath=this.normalizeLibraryFilePath(input,allowRoot);
    if(enforceOrdinaryPolicy&&normalizedPath)this.paths.assertOrdinaryFilePath(normalizedPath);
    const storagePath=normalizedPath?path.posix.join(canonicalRoot,normalizedPath):canonicalRoot;
    return {
      normalizedPath,
      absolutePath: await this.paths.resolveSafeProjectPathNoSymlinks(projectRoot, storagePath)
    };
  }

  async ensureLibraryRoot(projectRoot:string,rootSubPath:string):Promise<void>{
    await this.ensureLibraryRootExists(projectRoot,rootSubPath);
  }

  async discardEmptyLibraryRoot(projectRoot:string,rootSubPath:string):Promise<boolean>{
    const segments=this.normalizeLibraryRootSubPath(rootSubPath).split("/");
    const project=await this.paths.openProjectRoot(projectRoot,false);
    try{
      const parentSegments=segments.slice(0,-1);
      const parent=await this.tree.openDirectoryPath(project,parentSegments,false);
      try{
        await rmdir(descriptorPath(parent,segments.at(-1)!));
        await parent.sync();
      }catch(error){
        if(isNotFound(error))return true;
        if(isNotEmpty(error))return false;
        throw error;
      }finally{
        await parent.close();
      }
      const libraryParent=await this.tree.openDirectoryPath(project,parentSegments.slice(0,-1),false);
      try{
        await rmdir(descriptorPath(libraryParent,parentSegments.at(-1)!));
        await libraryParent.sync();
      }catch(error){
        if(!isNotFound(error)&&!isNotEmpty(error))throw error;
      }finally{
        await libraryParent.close();
      }
      return true;
    }finally{
      await project.close();
    }
  }

  uploadLibraryFile(projectRoot:string,rootSubPath:string,input:UploadProjectFileInput){return this.uploadFileWithAccounting(projectRoot,input,{reserve:async()=>undefined,committed:async()=>undefined},rootSubPath)}
  uploadLibraryFileWithAccounting(projectRoot:string,rootSubPath:string,input:UploadProjectFileInput,accounting:FileUploadAccounting){return this.uploadFileWithAccounting(projectRoot,input,accounting,rootSubPath)}
  listLibraryFiles(projectRoot:string,rootSubPath:string,input="",canDelete=true){return this.listFilesAtRoot(projectRoot,input,rootSubPath,canDelete)}
  downloadLibraryFile(projectRoot:string,rootSubPath:string,input:string){return this.downloadFile(projectRoot,input,rootSubPath)}
  deleteLibraryFile(projectRoot:string,rootSubPath:string,input:string){return this.deleteFile(projectRoot,input,rootSubPath)}
  deleteLibraryFileWithAccounting(projectRoot:string,rootSubPath:string,input:string,accounting:FileByteAccounting,deletion?:FileDeletionContext){return this.deleteFileWithAccounting(projectRoot,input,accounting,rootSubPath,deletion)}

  async persistLibraryOwnedFile(
    projectRoot:string,
    rootSubPath:string,
    relativePath:string,
    bytes:Uint8Array
  ):Promise<PersistedLibraryFile>{
    const normalizedPath=this.normalizeLibraryFilePath(relativePath,false);
    const canonicalRoot=this.normalizeLibraryRootSubPath(rootSubPath);
    const location={projectRoot,rootSubPath:canonicalRoot,relativePath:normalizedPath};
    return this.withOwnedFileParent(location,true,async(parent,name)=>{
      const existingBytes=await this.tree.readOptionalRegularFile(parent,name);
      if(existingBytes)return{
        location,
        identity:null,
        existingBytes,
        newlyWritten:false
      };
      try{
        const written=await this.tree.writeRegularFile(parent,name,bytes,false);
        return{
          location,
          identity:{dev:written.dev,ino:written.ino},
          existingBytes:null,
          newlyWritten:true
        };
      }catch(error){
        if(!isAlreadyExists(error))throw error;
        return{
          location,
          identity:null,
          existingBytes:await this.tree.readOptionalRegularFile(parent,name),
          newlyWritten:false
        };
      }
    });
  }

  async readLibraryOwnedFile(location:LibraryOwnedFileLocation,label:string):Promise<Buffer|null>{
    try{
      return await this.withOwnedFileParent(location,false,(parent,name)=>
        this.tree.readOptionalRegularFile(parent,name,label)
      );
    }catch(error){
      if(isNotFound(error))return null;
      throw error;
    }
  }

  async deleteLibraryRootWithAccounting(
    projectRoot:string,
    libraryId:string,
    rootSubPath:string,
    activeRootSubPaths:string[],
    reconcile:(bytes:number)=>Promise<void>,
    context:FileLibraryDeletionContext
  ):Promise<{bytes:number}>{
    return withProjectFileLock(projectRoot,async()=>{
      const target={
        owner:context.owner,
        projectRoot,
        libraryId,
        libraryRoot:this.normalizeLibraryRootSubPath(rootSubPath)
      };
      try{
        const isolated=await this.deletion.deleteLibrary(
          target,
          context.operations,
          context.checkpoint,
          async(_isolated,project)=>{
            await reconcile(await this.measureFileRootsBytesUnlocked(
              projectRoot,
              activeRootSubPaths,
              context.checkpoint,
              project
            ));
          }
        );
        await context.checkpoint();
        return{bytes:isolated.bytes};
      }catch(error){
        console.error("File Library deletion failed",error);
        throw fileLibraryDeleting();
      }
    });
  }

  private async uploadFileWithAccounting(projectRoot: string, input: UploadProjectFileInput, accounting: FileUploadAccounting, rootSubPath:string): Promise<ProjectFileWriteResponse> {
    if (input.bytes.byteLength > MAX_PROJECT_FILE_BYTES) {
      throw new ProductError(`Project file exceeds the ${MAX_PROJECT_FILE_BYTES}-byte limit`, 413);
    }
    return withProjectFileLock(projectRoot, async () => {
      await this.reconcileFileBytesUnlocked(projectRoot, accounting, rootSubPath);
      const normalizedPath=this.normalizeLibraryFilePath(input.path,false);
      this.paths.assertOrdinaryFilePath(normalizedPath);
      const canonicalRoot=this.normalizeLibraryRootSubPath(rootSubPath);
      const project=await this.paths.openProjectRoot(projectRoot,true);
      let parent:FileHandle|undefined;
      try {
        const segments=[...canonicalRoot.split("/"),...normalizedPath.split("/")];
        const name=segments.pop()!;
        try{
          parent=await this.tree.openDirectoryPath(project,segments,true);
        }catch(error){
          throw projectWritePathError(error);
        }
        const previous=await this.tree.readOptionalRegularFile(parent,name);
        if(input.overwrite!==true&&previous!==null)throw new ProductError("Project file already exists",409);
        let accountingRecorded=false;
        let written;
        try{
          written=await this.tree.writeRegularFile(
            parent,
            name,
            input.bytes,
            input.overwrite===true,
            async(pending)=>{
              await accounting.reserve(
                normalizedPath,
                pending.size-(previous?.byteLength??0),
                {
                  bytes:pending.size,
                  mediaType:detectProjectFileMediaType(input.bytes,normalizedPath)
                }
              );
              accountingRecorded=true;
            },
            async(committed)=>{
              try{
                await this.reconcileFileBytesUnlocked(projectRoot,accounting,rootSubPath);
              }catch(error){
                console.error("Project file measurement reconciliation failed",error);
              }
              await accounting.committed(normalizedPath,{
                bytes:committed.size,
                mediaType:detectProjectFileMediaType(input.bytes,normalizedPath)
              });
            }
          );
        }catch(error){
          if(accountingRecorded){
            try{
              await this.reconcileFileBytesUnlocked(projectRoot,accounting,rootSubPath);
            }catch(reconcileError){
              console.error("Project file commit reconciliation failed",reconcileError);
            }
          }
          if(input.overwrite!==true&&isAlreadyExists(error))throw new ProductError("Project file already exists",409);
          throw error;
        }
        return {
          path: normalizedPath,
          bytes: written.size,
          mediaType: detectProjectFileMediaType(input.bytes, normalizedPath),
          updatedAt: written.mtime.toISOString()
        };
      }finally{
        await parent?.close();
        await project.close();
      }
    });
  }

  private async listFilesAtRoot(projectRoot:string,input:string,rootSubPath:string,canDelete:boolean):Promise<ProjectFileListResponse>{return withProjectFileLock(projectRoot,()=>this.listFilesUnlocked(projectRoot,input,rootSubPath,canDelete))}

  async measureFileRootsBytes(projectRoot:string,rootSubPaths:string[]):Promise<number>{return withProjectFileLock(projectRoot,()=>this.measureFileRootsBytesUnlocked(projectRoot,rootSubPaths))}
  async measureFileRootsBytesAndProject<T>(projectRoot:string,rootSubPaths:string[],project:(bytes:number)=>Promise<T>):Promise<T>{
    return withProjectFileLock(projectRoot,async()=>project(await this.measureFileRootsBytesUnlocked(projectRoot,rootSubPaths)));
  }

  private async listFilesUnlocked(projectRoot: string, input: string,rootSubPath:string,canDelete:boolean): Promise<ProjectFileListResponse> {
      const { normalizedPath, absolutePath } = await this.resolveLibraryFilePath(projectRoot,rootSubPath,input,true);
      await this.requireLibraryRootExists(projectRoot,rootSubPath);

      let directoryStat;
      try {
        directoryStat = await lstat(absolutePath);
      } catch (error) {
        if (isNotFound(error)) {
          await this.requireLibraryRootExists(projectRoot,rootSubPath);
          throw new ProductError("File path not found", 404, "file_path_not_found");
        }
        throw error;
      }

      if (directoryStat.isSymbolicLink()) {
        throw new ProductError("Cannot list symlink paths");
      }
      if (!directoryStat.isDirectory()) {
        throw new ProductError("Path is not a directory");
      }

      const entries = await readdir(absolutePath, { withFileTypes: true });
      const resolvedEntries: ProjectFileListEntry[] = [];
      for (const entry of entries) {
        if (this.paths.isArtifactNamespaceEntry(normalizedPath, entry.name)) continue;
        const entryPath = path.posix.join(normalizedPath, entry.name);
        const entryStat = await lstat(path.join(absolutePath, entry.name));
        if (entryStat.isSymbolicLink()) {
          continue;
        }
        if (entryStat.isDirectory()) {
          resolvedEntries.push({
            name: entry.name,
            path: entryPath,
            type: "directory",
            updatedAt: entryStat.mtime.toISOString(),
            capabilities: this.paths.deleteCapability(entryPath, canDelete)
          });
          continue;
        }
        if (entryStat.isFile()) {
          resolvedEntries.push({
            name: entry.name,
            path: entryPath,
            type: "file",
            size: entryStat.size,
            mediaType: projectFileMediaTypeFromName(entryPath),
            updatedAt: entryStat.mtime.toISOString(),
            capabilities: this.paths.deleteCapability(entryPath, canDelete)
          });
        }
      }

      return {
        entries: resolvedEntries
          .sort((left, right) => left.path.localeCompare(right.path))
      };
  }

  private async reconcileFileBytesUnlocked(projectRoot: string, accounting: Pick<FileByteAccounting,"rootSubPaths"|"reconcile">,rootSubPath:string): Promise<void> {
    if (!accounting.reconcile) return;
    await accounting.reconcile(await this.measureFileRootsBytesUnlocked(projectRoot,accounting.rootSubPaths??[rootSubPath]));
  }

  private async measureFileRootsBytesUnlocked(
    projectRoot:string,
    rootSubPaths:string[],
    checkpoint?:DescriptorTreeCheckpoint,
    projectDescriptor?:FileHandle
  ):Promise<number>{
    let bytes=0;
    for(const rootSubPath of new Set(rootSubPaths)){
      const canonicalRoot=this.normalizeLibraryRootSubPath(rootSubPath);
      await checkpoint?.();
      let directory:FileHandle;
      try{
        directory=projectDescriptor
          ?await open(descriptorPath(projectDescriptor),constants.O_RDONLY|constants.O_DIRECTORY)
          :await this.paths.openProjectRoot(projectRoot,false);
      }catch(error){
        if(isNotFound(error))throw fileLibraryStorageMissing();
        throw error;
      }
      try{
        for(const segment of canonicalRoot.split("/")){
          let next;
          try{
            next=await this.tree.openDirectory(directory,segment);
          }catch(error){
            if(isNotFound(error))throw fileLibraryStorageMissing();
            throw error;
          }
          await directory.close();
          directory=next;
        }
        bytes+=await this.tree.measureDirectory(directory,checkpoint);
      }finally{
        await directory.close();
      }
      if(!Number.isSafeInteger(bytes))throw new ProductError("Project file usage exceeds the supported size");
    }
    return bytes;
  }

  private async downloadFile(projectRoot: string, input: string,rootSubPath:string): Promise<ProjectFileDownloadResponse> {
    const { normalizedPath, absolutePath } = await this.resolveLibraryFilePath(projectRoot,rootSubPath,input);
    await this.requireLibraryRootExists(projectRoot,rootSubPath);
    try {
      const entryStat = await lstat(absolutePath);
      if (entryStat.isDirectory()) {
        throw new ProductError("Path is a directory");
      }
      if (!entryStat.isFile()) {
        throw new ProductError("Path is not a regular file");
      }
      const bytes = await readRegularFileWithoutFollowingSymlink(absolutePath,"Project file");
      return {
        path: normalizedPath,
        filename: path.posix.basename(normalizedPath),
        bytes,
        mediaType: detectProjectFileMediaType(bytes, normalizedPath)
      };
    } catch (error) {
      if (error instanceof ProductError) {
        throw error;
      }
      if (isNotFound(error)) {
        await this.requireLibraryRootExists(projectRoot,rootSubPath);
        throw new ProductError("File path not found", 404, "file_path_not_found");
      }
      throw error;
    }
  }

  private async deleteFile(projectRoot: string, input: string,rootSubPath:string): Promise<DeleteProjectFileResponse> {
    return (await this.deleteFileWithAccounting(projectRoot,input,{record:async()=>undefined},rootSubPath)).response;
  }

  private async deleteFileWithAccounting(projectRoot: string, input: string, accounting: FileByteAccounting,rootSubPath:string,deletion?:FileDeletionContext): Promise<DeletedProjectFile> {
    return withProjectFileLock(projectRoot, async () => {
      const { normalizedPath } = await this.resolveLibraryFilePath(projectRoot,rootSubPath,input,true);
      if (normalizedPath === "") {
        throw new ProductError("Cannot delete the File Library root");
      }
      this.paths.assertEntryDeleteAllowed(normalizedPath);
      const transientOperationId = `file_delete_${randomUUID()}`;
      const context = deletion ?? {
        owner: {
          actorId: "transient",
          projectId: "transient",
          operation: "project.file.delete" as const,
          key: transientOperationId,
          requestHash: transientOperationId,
          resourceId: transientOperationId,
          claimToken: transientOperationId
        },
        operations: this.transientDeletionOperations
      };
      const target = {
        owner: context.owner,
        projectRoot,
        libraryRoot: this.normalizeLibraryRootSubPath(rootSubPath),
        relativePath: normalizedPath
      };
      let isolated:IsolatedEntryDeletion;
      try {
        isolated = await this.deletion.isolateEntry(target, context.operations);
      }catch(error){
        if(error instanceof ProductError){
          if(error.code==="file_deletion_incomplete")console.error("File deletion failed",error);
          throw error;
        }
        console.error("File deletion failed",error);
        throw new ProductError("File deletion could not be completed",500,"file_deletion_incomplete");
      }
      try {
        await this.reconcileFileBytesUnlocked(projectRoot, accounting, rootSubPath);
        const mediaType = isolated.entryType === "file"
          ? projectFileMediaTypeFromName(normalizedPath)
          : "application/octet-stream";
        await accounting.record(normalizedPath, -isolated.bytes, {
          bytes: isolated.bytes,
          mediaType,
          entryType: isolated.entryType
        });
        await this.deletion.removeIsolatedEntry(target, context.operations);
        return { response: { deleted: true }, bytes: isolated.bytes, mediaType };
      } catch (error) {
        console.error("File deletion failed",error);
        if (error instanceof ProductError && error.code === "file_deletion_incomplete") throw error;
        throw new ProductError("File deletion could not be completed",500,"file_deletion_incomplete");
      }
    });
  }

  private async ensureLibraryRootExists(projectRoot:string,rootSubPath:string):Promise<void>{
    try{
      await this.requireLibraryRootExists(projectRoot,rootSubPath);
      return;
    }catch(error){
      if(!(error instanceof ProductError&&error.code==="file_library_storage_missing"))throw error;
    }
    const project=await this.paths.openProjectRoot(projectRoot,true);
    try{
      const root=await this.tree.openDirectoryPath(
        project,
        this.normalizeLibraryRootSubPath(rootSubPath).split("/"),
        true
      );
      await root.close();
    }finally{
      await project.close();
    }
  }

  private async requireLibraryRootExists(projectRoot:string,rootSubPath:string):Promise<void>{
    const {absolutePath}=await this.resolveLibraryFilePath(projectRoot,rootSubPath,"",true);
    try {
      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink()) {
        throw new ProductError("Cannot use a symlink as the File Library root");
      }
      if (!entryStat.isDirectory()) {
        throw new ProductError("File Library root is not a directory");
      }
    } catch (error) {
      if (isNotFound(error))throw fileLibraryStorageMissing();
      throw error;
    }
  }

  private normalizeLibraryFilePath(input:string,allowRoot:boolean):string{
    if(allowRoot&&input.trim()==="")return "";
    return this.paths.normalizeRelativeProjectPath(input);
  }

  private normalizeLibraryRootSubPath(input:string):string{
    const normalized=this.paths.normalizeRelativeProjectPath(input);
    if(!/^libraries\/[^/]+\/home$/.test(normalized))throw new ProductError("File Library root path is invalid");
    return normalized;
  }

  private async withOwnedFileParent<T>(
    input:LibraryOwnedFileLocation,
    create:boolean,
    operation:(parent:FileHandle,name:string)=>Promise<T>
  ):Promise<T>{
    const canonicalRoot=this.normalizeLibraryRootSubPath(input.rootSubPath);
    const normalizedPath=this.normalizeLibraryFilePath(input.relativePath,false);
    const project=await this.paths.openProjectRoot(input.projectRoot,create);
    let parent:FileHandle|undefined;
    try{
      const segments=[...canonicalRoot.split("/"),...normalizedPath.split("/")];
      const name=segments.pop()!;
      try{
        parent=await this.tree.openDirectoryPath(project,segments,create);
      }catch(error){
        throw projectWritePathError(error);
      }
      return await operation(parent,name);
    }finally{
      await parent?.close();
      await project.close();
    }
  }
}

export function detectProjectFileMediaType(bytes: Uint8Array, filename: string): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (!isUtf8Text(bytes)) return "application/octet-stream";
  const text = Buffer.from(bytes).toString("utf8");
  const extension = path.posix.extname(filename).toLowerCase();
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".xml") return "application/xml";
  if (extension === ".json") {
    try { JSON.parse(text); return "application/json"; } catch { return "text/plain"; }
  }
  if (extension === ".csv") return "text/csv";
  if (extension === ".md" || extension === ".markdown") return "text/markdown";
  return "text/plain";
}

function projectFileMediaTypeFromName(filename: string): string {
  switch (path.posix.extname(filename).toLowerCase()) {
    case ".svg": return "image/svg+xml";
    case ".html":
    case ".htm": return "text/html";
    case ".xml": return "application/xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".json": return "application/json";
    case ".csv": return "text/csv";
    case ".md":
    case ".markdown": return "text/markdown";
    case ".txt":
    case ".log": return "text/plain";
    default: return "application/octet-stream";
  }
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString("ascii");
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.some((byte) => byte === 0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  let controls = 0;
  for (const byte of bytes) if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) controls += 1;
  return bytes.byteLength === 0 || controls / bytes.byteLength < 0.01;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function fileLibraryStorageMissing():ProductError{
  return new ProductError(
    "File Library storage is unavailable",
    409,
    "file_library_storage_missing"
  );
}

function fileLibraryDeleting():ProductError{
  return new ProductError(
    "File Library deletion is in progress",
    409,
    "file_library_deleting"
  );
}

export async function readRegularFileWithoutFollowingSymlink(source:string,label="Project file"):Promise<Buffer>{
  let handle;
  try{
    handle=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW);
  }catch(error){
    if(isSymlinkOpenError(error))throw new ProductError(`${label} uses a symlink`);
    throw error;
  }
  try{
    if(!(await handle.stat()).isFile())throw new ProductError(`${label} must be a regular file`);
    return handle.readFile();
  }finally{
    await handle.close();
  }
}

function isSymlinkOpenError(error:unknown):boolean{
  return typeof error==="object"&&error!==null&&"code" in error&&error.code==="ELOOP";
}

function isAlreadyExists(error:unknown):boolean{
  return typeof error==="object"&&error!==null&&"code" in error&&error.code==="EEXIST";
}

function isNotEmpty(error:unknown):boolean{
  return typeof error==="object"&&error!==null&&"code" in error&&error.code==="ENOTEMPTY";
}

function projectWritePathError(error:unknown):unknown{
  if(typeof error==="object"&&error!==null&&"code" in error){
    if(error.code==="ELOOP")return new ProductError("Path escapes the project root");
    if(error.code==="ENOTDIR")return new ProductError("Path is not a directory");
  }
  return error;
}
