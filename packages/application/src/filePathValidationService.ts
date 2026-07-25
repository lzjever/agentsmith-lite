import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { ProductError } from "../../domain/src/errors.js";

export class FilePathValidationService {
  constructor(private readonly trustedDataRoot?:string){}

  normalizeRelativeProjectPath(input: string): string {
    if (input.includes("\\")) {
      throw new ProductError("Backslash paths are not allowed");
    }
    if (path.posix.isAbsolute(input) || path.isAbsolute(input)) {
      throw new ProductError("Absolute paths are not allowed");
    }
    const normalized = path.posix.normalize(input);
    if (normalized === "." || normalized === "") {
      throw new ProductError("Path is required");
    }
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new ProductError("Path traversal is not allowed");
    }
    return normalized;
  }

  async resolveSafeProjectPath(projectRoot: string, input: string): Promise<string> {
    const normalized = this.normalizeRelativeProjectPath(input);
    if(this.trustedDataRoot){
      const handle=await openProjectRootDescriptor(this.trustedDataRoot,projectRoot,true);
      await handle.close();
    }else{
      await mkdir(projectRoot, { recursive: true });
    }
    const rootRealPath = await realpath(projectRoot);
    const candidate = path.resolve(rootRealPath, normalized);
    if (!isWithin(rootRealPath, candidate)) {
      throw new ProductError("Path escapes the project root");
    }

    const existing = await realpathExistingPrefix(candidate);
    if (!isWithin(rootRealPath, existing)) {
      throw new ProductError("Path escapes the project root");
    }
    return candidate;
  }

  async resolveSafeProjectPathNoSymlinks(projectRoot: string, input: string): Promise<string> {
    const candidate = await this.resolveSafeProjectPath(projectRoot, input);
    await assertNoSymlinkExistingPrefix(await realpath(projectRoot), candidate);
    return candidate;
  }

  assertOrdinaryFilePath(normalizedPath: string): void {
    if (normalizedPath === "workspace/.artifacts" || normalizedPath.startsWith("workspace/.artifacts/")) {
      throw artifactNamespaceProtected();
    }
  }

  isArtifactNamespaceEntry(parentPath: string, entryName: string): boolean {
    return parentPath === "workspace" && entryName === ".artifacts";
  }

  deleteCapability(normalizedPath: string, canWrite: boolean) {
    if (normalizedPath === "workspace") {
      return {
        canDelete: false,
        deleteUnavailableReason: "artifact_namespace_protected" as const
      };
    }
    if (!canWrite) {
      return {
        canDelete: false,
        deleteUnavailableReason: "read_only" as const
      };
    }
    return {
      canDelete: true,
      deleteUnavailableReason: null
    };
  }

  assertEntryDeleteAllowed(normalizedPath: string): void {
    this.assertOrdinaryFilePath(normalizedPath);
    if (normalizedPath === "workspace") {
      throw artifactNamespaceProtected();
    }
  }

  async openProjectRoot(projectRoot: string, create: boolean) {
    if (this.trustedDataRoot) {
      return openProjectRootDescriptor(this.trustedDataRoot, projectRoot, create);
    }
    if (create) await mkdir(projectRoot, { recursive: true });
    try {
      return await open(path.resolve(projectRoot), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      throw unsafeProjectStorageError(error);
    }
  }
}

function artifactNamespaceProtected(): ProductError {
  return new ProductError("Task Artifact namespace is protected", 409, "artifact_namespace_protected");
}

export async function openProjectRootDescriptor(dataRoot:string,projectRoot:string,create:boolean){
  const trustedRoot=path.resolve(dataRoot);
  const target=path.resolve(projectRoot);
  const relative=path.relative(trustedRoot,target);
  if(relative===""||relative.startsWith("..")||path.isAbsolute(relative))throw new ProductError("Project storage path is outside the data root",500);
  const segments=relative.split(path.sep).filter(Boolean);
  if(segments.some((segment)=>segment==="."||segment===".."||segment.includes("/")||segment.includes("\0")))throw new ProductError("Project storage path is invalid",500);
  let current=await open(trustedRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{
    for(const segment of segments){
      const child=`/proc/self/fd/${current.fd}/${segment}`;
      let next;
      try{
        next=await open(child,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      }catch(error){
        if(!create||!isNotFound(error))throw unsafeProjectStorageError(error);
        try{await mkdir(child,{mode:0o700});}catch(mkdirError){if(!isAlreadyExists(mkdirError))throw mkdirError;}
        try{next=await open(child,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);}
        catch(error){throw unsafeProjectStorageError(error);}
      }
      await current.close();
      current=next;
    }
    return current;
  }catch(error){
    await current.close();
    throw error;
  }
}

async function assertNoSymlinkExistingPrefix(root: string, candidate: string): Promise<void> {
  const relative = path.relative(root, candidate);
  if (relative === "") {
    return;
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment) {
      continue;
    }
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      if (isNotDirectory(error)) {
        throw new ProductError("Path is not a directory");
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new ProductError("Path uses a symlink");
    }
  }
}

async function realpathExistingPrefix(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        return realpath(current);
      }
      if (stat.isDirectory() || stat.isFile()) {
        return realpath(current);
      }
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new ProductError("No existing parent found for path");
      }
      current = parent;
      continue;
    }
    return realpath(current);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isNotDirectory(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR";
}

function isAlreadyExists(error:unknown):boolean{
  return typeof error==="object"&&error!==null&&"code" in error&&error.code==="EEXIST";
}

function unsafeProjectStorageError(error:unknown):unknown{
  if(typeof error==="object"&&error!==null&&"code" in error&&["ELOOP","ENOTDIR"].includes(String(error.code))){
    return new ProductError("Project storage path uses a symbolic link or non-directory",409);
  }
  return error;
}
