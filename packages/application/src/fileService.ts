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

  normalizeRelativeProjectPath(input: string): string {
    return this.paths.normalizeRelativeProjectPath(input);
  }

  async resolveSafeProjectPath(projectRoot: string, input: string): Promise<string> {
    return this.paths.resolveSafeProjectPath(projectRoot, input);
  }

  normalizeProjectFilesPath(input: string, options: { allowFilesRoot?: boolean } = {}): string {
    const normalized = this.paths.normalizeRelativeProjectPath(input);
    if (normalized !== "files" && !normalized.startsWith("files/")) {
      throw new ProductError("Project files must be under files/");
    }
    if (!options.allowFilesRoot && normalized === "files") {
      throw new ProductError("File path is required under files/");
    }
    return normalized;
  }

  async resolveProjectFilesPath(
    projectRoot: string,
    input: string,
    options: { allowFilesRoot?: boolean; rootSubPath?: string } = {}
  ): Promise<ResolvedProjectFilePath> {
    const rootSubPath = options.rootSubPath === undefined || options.rootSubPath === "files"
      ? "files"
      : this.normalizeLibraryRootSubPath(options.rootSubPath);
    const normalizedPath = rootSubPath === "files"
      ? this.normalizeProjectFilesPath(input, options)
      : this.normalizeLibraryFilePath(input, options.allowFilesRoot === true);
    const storagePath = rootSubPath === "files"
      ? normalizedPath
      : normalizedPath ? path.posix.join(rootSubPath, normalizedPath) : rootSubPath;
    return {
      normalizedPath,
      absolutePath: await this.paths.resolveSafeProjectPathNoSymlinks(projectRoot, storagePath)
    };
  }

  async ensureLibraryRoot(projectRoot:string,rootSubPath:string):Promise<void>{
    this.normalizeLibraryRootSubPath(rootSubPath);
    await this.ensureFilesRoot(projectRoot,rootSubPath);
  }

  async removeEmptyLibraryRoot(projectRoot:string,rootSubPath:string):Promise<void>{
    await withProjectFileLock(projectRoot,async()=>{
      const {absolutePath}=await this.resolveProjectFilesPath(projectRoot,"",{allowFilesRoot:true,rootSubPath:this.normalizeLibraryRootSubPath(rootSubPath)});
      const entries=await readdir(absolutePath);
      if(entries.length>0)throw new ProductError("File Library is not empty",409);
      try{await rmdir(absolutePath)}catch(error){if(isNotEmpty(error))throw new ProductError("File Library is not empty",409);throw error}
    });
  }

  uploadLibraryFile(projectRoot:string,rootSubPath:string,input:UploadProjectFileInput){return this.uploadFileWithAccounting(projectRoot,input,{record:async()=>undefined},rootSubPath)}
  uploadLibraryFileWithAccounting(projectRoot:string,rootSubPath:string,input:UploadProjectFileInput,accounting:FileByteAccounting){return this.uploadFileWithAccounting(projectRoot,input,accounting,rootSubPath)}
  listLibraryFiles(projectRoot:string,rootSubPath:string,input=""){return this.listFilesAtRoot(projectRoot,input,rootSubPath)}
  downloadLibraryFile(projectRoot:string,rootSubPath:string,input:string){return this.downloadFile(projectRoot,input,rootSubPath)}
  deleteLibraryFile(projectRoot:string,rootSubPath:string,input:string){return this.deleteFile(projectRoot,input,rootSubPath)}
  deleteLibraryFileWithAccounting(projectRoot:string,rootSubPath:string,input:string,accounting:FileByteAccounting){return this.deleteFileWithAccounting(projectRoot,input,accounting,rootSubPath)}

  async uploadFile(projectRoot: string, input: UploadProjectFileInput): Promise<ProjectFileWriteResponse> {
    return this.uploadFileWithAccounting(projectRoot, input, { record: async () => undefined });
  }

  async uploadFileWithAccounting(projectRoot: string, input: UploadProjectFileInput, accounting: FileByteAccounting, rootSubPath = "files"): Promise<ProjectFileWriteResponse> {
    if (input.bytes.byteLength > MAX_PROJECT_FILE_BYTES) {
      throw new ProductError(`Project file exceeds the ${MAX_PROJECT_FILE_BYTES}-byte limit`, 413);
    }
    return withProjectFileLock(projectRoot, async () => {
      await this.reconcileFileBytesUnlocked(projectRoot, accounting, rootSubPath);
      const { normalizedPath, absolutePath } = await this.resolveProjectFilesPath(projectRoot, input.path,{rootSubPath});
      if (input.overwrite !== true && await regularFileExists(absolutePath)) {
        throw new ProductError("Project file already exists", 409);
      }
      const previous = input.overwrite === true ? await readOptionalRegularFile(absolutePath) : null;
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await this.resolveProjectFilesPath(projectRoot, normalizedPath, { rootSubPath });
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

  async listFiles(projectRoot: string, input = "files"): Promise<ProjectFileListResponse> {
    return this.listFilesAtRoot(projectRoot,input,"files");
  }

  private async listFilesAtRoot(projectRoot:string,input:string,rootSubPath:string):Promise<ProjectFileListResponse>{return withProjectFileLock(projectRoot,()=>this.listFilesUnlocked(projectRoot,input,rootSubPath))}

  async listFilesWithAccounting(projectRoot: string, input: string, accounting: FileByteAccounting): Promise<ProjectFileListResponse> {
    return withProjectFileLock(projectRoot, async () => {
      await this.reconcileFileBytesUnlocked(projectRoot, accounting);
      return this.listFilesUnlocked(projectRoot, input,"files");
    });
  }

  async measureFileRootsBytes(projectRoot:string,rootSubPaths:string[]):Promise<number>{return withProjectFileLock(projectRoot,()=>this.measureFileRootsBytesUnlocked(projectRoot,rootSubPaths))}

  private async listFilesUnlocked(projectRoot: string, input: string,rootSubPath="files"): Promise<ProjectFileListResponse> {
      const { normalizedPath, absolutePath } = await this.resolveProjectFilesPath(projectRoot, input, { allowFilesRoot: true,rootSubPath });
      await this.ensureFilesRoot(projectRoot,rootSubPath);

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

  private async reconcileFileBytesUnlocked(projectRoot: string, accounting: FileByteAccounting,rootSubPath="files"): Promise<void> {
    if (!accounting.reconcile) return;
    await accounting.reconcile(await this.measureFileRootsBytesUnlocked(projectRoot,accounting.rootSubPaths??[rootSubPath]));
  }

  private async measureFileRootsBytesUnlocked(projectRoot:string,rootSubPaths:string[]):Promise<number>{
    let bytes=0;
    for(const rootSubPath of new Set(rootSubPaths)){
      await this.ensureFilesRoot(projectRoot,rootSubPath);
      const {absolutePath}=await this.resolveProjectFilesPath(projectRoot,rootSubPath==="files"?"files":"",{allowFilesRoot:true,rootSubPath});
      bytes+=await regularFileBytes(absolutePath);
      if(!Number.isSafeInteger(bytes))throw new ProductError("Project file usage exceeds the supported size");
    }
    return bytes;
  }

  async downloadFile(projectRoot: string, input: string,rootSubPath="files"): Promise<ProjectFileDownloadResponse> {
    const { normalizedPath, absolutePath } = await this.resolveProjectFilesPath(projectRoot, input,{rootSubPath});
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

  async fileSize(projectRoot: string, input: string): Promise<number> {
    const { absolutePath } = await this.resolveProjectFilesPath(projectRoot, input);
    try {
      const entry = await lstat(absolutePath);
      if (!entry.isFile()) {
        throw new ProductError("Path is not a regular file");
      }
      return entry.size;
    } catch (error) {
      if (isNotFound(error)) return 0;
      throw error;
    }
  }

  async deleteFile(projectRoot: string, input: string,rootSubPath="files"): Promise<DeleteProjectFileResponse> {
    return (await this.deleteFileWithSize(projectRoot, input,rootSubPath)).response;
  }

  async deleteFileWithSize(projectRoot: string, input: string,rootSubPath="files"): Promise<DeletedProjectFile> {
    return this.deleteFileWithAccounting(projectRoot, input, { record: async () => undefined },rootSubPath);
  }

  async deleteFileWithAccounting(projectRoot: string, input: string, accounting: FileByteAccounting,rootSubPath="files"): Promise<DeletedProjectFile> {
    return withProjectFileLock(projectRoot, async () => {
      await this.reconcileFileBytesUnlocked(projectRoot, accounting,rootSubPath);
      const { normalizedPath, absolutePath } = await this.resolveProjectFilesPath(projectRoot, input, { allowFilesRoot: true,rootSubPath });
      if (normalizedPath === "files"||normalizedPath === "") {
        throw new ProductError("Cannot delete the files root");
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

  private async ensureFilesRoot(projectRoot: string,rootSubPath="files"): Promise<void> {
    const { absolutePath } = await this.resolveProjectFilesPath(projectRoot, rootSubPath==="files"?"files":"", { allowFilesRoot: true,rootSubPath });
    try {
      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink()) {
        throw new ProductError("Cannot use a symlink as the files root");
      }
      if (!entryStat.isDirectory()) {
        throw new ProductError("files root is not a directory");
      }
    } catch (error) {
      if (isNotFound(error)) {
        await mkdir(absolutePath, { recursive: true });
        await this.resolveProjectFilesPath(projectRoot, rootSubPath==="files"?"files":"", { allowFilesRoot:true,rootSubPath });
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
    if(!/^libraries\/[^/]+\/home\/workspace$/.test(normalized))throw new ProductError("File Library root path is invalid");
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
  if (extension === ".json") {
    try { JSON.parse(text); return "application/json"; } catch { return "text/plain"; }
  }
  if (extension === ".csv") return "text/csv";
  if (extension === ".md" || extension === ".markdown") return "text/markdown";
  return "text/plain";
}

function projectFileMediaTypeFromName(filename: string): string {
  switch (path.posix.extname(filename).toLowerCase()) {
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
