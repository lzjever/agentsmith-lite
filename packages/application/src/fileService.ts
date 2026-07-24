import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DeleteProjectFileResponse,
  ProjectFileDownloadResponse,
  ProjectFileEntry,
  ProjectFileListResponse,
  ProjectFileWriteResponse,
  UploadProjectFileInput
} from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import { MAX_PROJECT_FILE_BYTES } from "../../domain/src/fileDefaults.js";
import { FilePathValidationService } from "./filePathValidationService.js";

interface ResolvedProjectFilePath {
  normalizedPath: string;
  absolutePath: string;
}

interface DeletedProjectFile {
  response: DeleteProjectFileResponse;
  bytes: number;
  mediaType: string;
}

interface FileByteAccounting {
  rootSubPaths?: string[];
  reconcile?(bytes: number): Promise<void>;
  record(path: string, delta: number, file: { bytes: number; mediaType: string }): Promise<void>;
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
  constructor(private readonly paths = new FilePathValidationService()) {}

  private async resolveLibraryFilePath(projectRoot:string,rootSubPath:string,input:string,allowRoot=false):Promise<ResolvedProjectFilePath>{
    const canonicalRoot=this.normalizeLibraryRootSubPath(rootSubPath);
    const normalizedPath=this.normalizeLibraryFilePath(input,allowRoot);
    const storagePath=normalizedPath?path.posix.join(canonicalRoot,normalizedPath):canonicalRoot;
    return {
      normalizedPath,
      absolutePath: await this.paths.resolveSafeProjectPathNoSymlinks(projectRoot, storagePath)
    };
  }

  async ensureLibraryRoot(projectRoot:string,rootSubPath:string):Promise<void>{
    await this.ensureLibraryRootExists(projectRoot,rootSubPath);
  }

  async removeEmptyLibraryRoot(projectRoot:string,rootSubPath:string):Promise<void>{
    await withProjectFileLock(projectRoot,async()=>{
      const {absolutePath}=await this.resolveLibraryFilePath(projectRoot,rootSubPath,"",true);
      const entries=await readdir(absolutePath);
      const visible=entries.filter((entry)=>entry!=="workspace");
      if(visible.length>0)throw new ProductError("File Library is not empty",409);
      if(entries.includes("workspace")){
        const workspace=path.join(absolutePath,"workspace");
        const workspaceEntries=await readdir(workspace);
        if(workspaceEntries.some((entry)=>entry!==".artifacts"))throw new ProductError("File Library is not empty",409);
        if(workspaceEntries.includes(".artifacts")){const artifacts=path.join(workspace,".artifacts");if((await readdir(artifacts)).length>0)throw new ProductError("File Library is not empty",409);await rmdir(artifacts);}
        await rmdir(workspace);
      }
      try{await rmdir(absolutePath)}catch(error){if(isNotEmpty(error))throw new ProductError("File Library is not empty",409);throw error}
    });
  }

  uploadLibraryFile(projectRoot:string,rootSubPath:string,input:UploadProjectFileInput){return this.uploadFileWithAccounting(projectRoot,input,{record:async()=>undefined},rootSubPath)}
  uploadLibraryFileWithAccounting(projectRoot:string,rootSubPath:string,input:UploadProjectFileInput,accounting:FileByteAccounting){return this.uploadFileWithAccounting(projectRoot,input,accounting,rootSubPath)}
  listLibraryFiles(projectRoot:string,rootSubPath:string,input=""){return this.listFilesAtRoot(projectRoot,input,rootSubPath)}
  downloadLibraryFile(projectRoot:string,rootSubPath:string,input:string){return this.downloadFile(projectRoot,input,rootSubPath)}
  deleteLibraryFile(projectRoot:string,rootSubPath:string,input:string){return this.deleteFile(projectRoot,input,rootSubPath)}
  deleteLibraryFileWithAccounting(projectRoot:string,rootSubPath:string,input:string,accounting:FileByteAccounting){return this.deleteFileWithAccounting(projectRoot,input,accounting,rootSubPath)}

  private async uploadFileWithAccounting(projectRoot: string, input: UploadProjectFileInput, accounting: FileByteAccounting, rootSubPath:string): Promise<ProjectFileWriteResponse> {
    if (input.bytes.byteLength > MAX_PROJECT_FILE_BYTES) {
      throw new ProductError(`Project file exceeds the ${MAX_PROJECT_FILE_BYTES}-byte limit`, 413);
    }
    return withProjectFileLock(projectRoot, async () => {
      await this.reconcileFileBytesUnlocked(projectRoot, accounting, rootSubPath);
      const { normalizedPath, absolutePath } = await this.resolveLibraryFilePath(projectRoot,rootSubPath,input.path);
      if (input.overwrite !== true && await regularFileExists(absolutePath)) {
        throw new ProductError("Project file already exists", 409);
      }
      const previous = input.overwrite === true ? await readOptionalRegularFile(absolutePath) : null;
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await this.resolveLibraryFilePath(projectRoot,rootSubPath,normalizedPath);
      const temporaryPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, input.bytes, { flag: "wx" });
        await rename(temporaryPath, absolutePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
      const written = await lstat(absolutePath);
      if (!written.isFile()) {
        throw new ProductError("Written path is not a regular file");
      }
      try {
        await accounting.record(normalizedPath,written.size-(previous?.byteLength??0),{bytes:written.size,mediaType:detectProjectFileMediaType(input.bytes,normalizedPath)});
      } catch (error) {
        await restoreOptionalRegularFile(absolutePath, previous);
        throw error;
      }
      return {
        path: normalizedPath,
        bytes: written.size,
        mediaType: detectProjectFileMediaType(input.bytes, normalizedPath),
        updatedAt: written.mtime.toISOString()
      };
    });
  }

  private async listFilesAtRoot(projectRoot:string,input:string,rootSubPath:string):Promise<ProjectFileListResponse>{return withProjectFileLock(projectRoot,()=>this.listFilesUnlocked(projectRoot,input,rootSubPath))}

  async measureFileRootsBytes(projectRoot:string,rootSubPaths:string[]):Promise<number>{return withProjectFileLock(projectRoot,()=>this.measureFileRootsBytesUnlocked(projectRoot,rootSubPaths))}

  private async listFilesUnlocked(projectRoot: string, input: string,rootSubPath:string): Promise<ProjectFileListResponse> {
      const { normalizedPath, absolutePath } = await this.resolveLibraryFilePath(projectRoot,rootSubPath,input,true);
      await this.ensureLibraryRootExists(projectRoot,rootSubPath);

      let directoryStat;
      try {
        directoryStat = await lstat(absolutePath);
      } catch (error) {
        if (isNotFound(error)) {
          return { entries: [] };
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
      const resolvedEntries: ProjectFileEntry[] = [];
      for (const entry of entries) {
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
            updatedAt: entryStat.mtime.toISOString()
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
            updatedAt: entryStat.mtime.toISOString()
          });
        }
      }

      return {
        entries: resolvedEntries
          .sort((left, right) => left.path.localeCompare(right.path))
      };
  }

  private async reconcileFileBytesUnlocked(projectRoot: string, accounting: FileByteAccounting,rootSubPath:string): Promise<void> {
    if (!accounting.reconcile) return;
    await accounting.reconcile(await this.measureFileRootsBytesUnlocked(projectRoot,accounting.rootSubPaths??[rootSubPath]));
  }

  private async measureFileRootsBytesUnlocked(projectRoot:string,rootSubPaths:string[]):Promise<number>{
    let bytes=0;
    for(const rootSubPath of new Set(rootSubPaths)){
      await this.ensureLibraryRootExists(projectRoot,rootSubPath);
      const {absolutePath}=await this.resolveLibraryFilePath(projectRoot,rootSubPath,"",true);
      bytes+=await regularFileBytes(absolutePath);
      if(!Number.isSafeInteger(bytes))throw new ProductError("Project file usage exceeds the supported size");
    }
    return bytes;
  }

  private async downloadFile(projectRoot: string, input: string,rootSubPath:string): Promise<ProjectFileDownloadResponse> {
    const { normalizedPath, absolutePath } = await this.resolveLibraryFilePath(projectRoot,rootSubPath,input);
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
        throw new ProductError("File not found", 404);
      }
      throw error;
    }
  }

  private async deleteFile(projectRoot: string, input: string,rootSubPath:string): Promise<DeleteProjectFileResponse> {
    return (await this.deleteFileWithAccounting(projectRoot,input,{record:async()=>undefined},rootSubPath)).response;
  }

  private async deleteFileWithAccounting(projectRoot: string, input: string, accounting: FileByteAccounting,rootSubPath:string): Promise<DeletedProjectFile> {
    return withProjectFileLock(projectRoot, async () => {
      await this.reconcileFileBytesUnlocked(projectRoot, accounting,rootSubPath);
      const { normalizedPath, absolutePath } = await this.resolveLibraryFilePath(projectRoot,rootSubPath,input,true);
      if (normalizedPath === "") {
        throw new ProductError("Cannot delete the File Library root");
      }
      let entryStat;
      try {
        entryStat = await lstat(absolutePath);
      } catch (error) {
        if (isNotFound(error)) {
          throw new ProductError("File not found", 404);
        }
        throw error;
      }
      if (!entryStat.isFile()) {
        throw new ProductError("Path is not a regular file");
      }
      const previous = await readRegularFileWithoutFollowingSymlink(absolutePath,"Project file");
      const mediaType = detectProjectFileMediaType(previous, normalizedPath);
      try {
        await rm(absolutePath);
      } catch (error) {
        if (isNotFound(error)) {
          throw new ProductError("File not found", 404);
        }
        throw error;
      }
      try {
        await accounting.record(normalizedPath,-entryStat.size,{bytes:entryStat.size,mediaType});
      } catch (error) {
        await restoreOptionalRegularFile(absolutePath, previous);
        throw error;
      }
      return { response: { deleted: true }, bytes: entryStat.size, mediaType };
    });
  }

  private async ensureLibraryRootExists(projectRoot:string,rootSubPath:string):Promise<void>{
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
      if (isNotFound(error)) {
        await mkdir(absolutePath, { recursive: true });
        await this.resolveLibraryFilePath(projectRoot,rootSubPath,"",true);
        return;
      }
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

async function regularFileBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) continue;
    if (entryStat.isDirectory()) bytes += await regularFileBytes(entryPath);
    else if (entryStat.isFile()) bytes += entryStat.size;
    if (!Number.isSafeInteger(bytes)) throw new ProductError("Project file usage exceeds the supported size");
  }
  return bytes;
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

function isNotEmpty(error:unknown):boolean{return typeof error==="object"&&error!==null&&"code" in error&&(error.code==="ENOTEMPTY"||error.code==="EEXIST")}

async function readOptionalRegularFile(absolutePath: string): Promise<Buffer | null> {
  try {
    const entry = await lstat(absolutePath);
    if (!entry.isFile()) throw new ProductError("Path is not a regular file");
    return readRegularFileWithoutFollowingSymlink(absolutePath,"Project file");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
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

async function regularFileExists(absolutePath: string): Promise<boolean> {
  try {
    const entry = await lstat(absolutePath);
    if (!entry.isFile()) throw new ProductError("Path is not a regular file");
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function restoreOptionalRegularFile(absolutePath: string, bytes: Buffer | null): Promise<void> {
  if (bytes === null) {
    await rm(absolutePath, { force: true });
    return;
  }
  const temporaryPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${randomUUID()}.rollback`);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
