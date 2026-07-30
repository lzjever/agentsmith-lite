import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { ProductError } from "../../domain/src/errors.js";
import type { FileDeletionOperationEntryType } from "../../ports/src/store.js";

const O_PATH = 0x200000;

export type DescriptorTreePurpose = "measure" | "remove" | "write";
export type DescriptorTreeCheckpoint = () => Promise<void>;

export interface DescriptorFileIdentity {
  dev:bigint;
  ino:bigint;
}

export interface DescriptorWrittenFile extends DescriptorFileIdentity {
  size:number;
  mtime:Date;
}

export interface DescriptorFileTreeObserver {
  beforeOpenEntry?(event: {
    purpose: DescriptorTreePurpose;
    name: string;
    observedType: FileDeletionOperationEntryType;
  }): Promise<void>;
}

export class DescriptorFileTreeWalker {
  constructor(private readonly observer?: DescriptorFileTreeObserver) {}

  openDirectory(parent: FileHandle, name: string): Promise<FileHandle> {
    validateDescriptorName(name);
    return open(
      descriptorPath(parent, name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  }

  openEntry(parent: FileHandle, name: string): Promise<FileHandle> {
    validateDescriptorName(name);
    return open(descriptorPath(parent, name), O_PATH | constants.O_NOFOLLOW);
  }

  async openDirectoryPath(parent: FileHandle, names: readonly string[], create: boolean): Promise<FileHandle> {
    let current = await open(descriptorPath(parent), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      for (const name of names) {
        validateDescriptorName(name);
        await this.observer?.beforeOpenEntry?.({
          purpose: "write",
          name,
          observedType: "directory"
        });
        let next: FileHandle;
        try {
          next = await this.openDirectory(current, name);
        } catch (error) {
          if(isNotDirectory(error)||isSymbolicLink(error)){
            const observed=await this.optionalStat(current,name);
            if(observed?.isSymbolicLink())throw new ProductError("Path escapes the project root");
            if(observed&&!observed.isDirectory())throw new ProductError("Path is not a directory");
          }
          if (!create || !isNotFound(error)) throw error;
          try {
            await mkdir(descriptorPath(current, name), { mode: 0o700 });
          } catch (mkdirError) {
            if (!isAlreadyExists(mkdirError)) throw mkdirError;
          }
          next = await this.openDirectory(current, name);
        }
        await current.close();
        current = next;
      }
      return current;
    } catch (error) {
      await current.close();
      throw error;
    }
  }

  async readOptionalRegularFile(parent: FileHandle, name: string, label="File path"): Promise<Buffer | null> {
    validateDescriptorName(name);
    let handle: FileHandle;
    try {
      handle = await open(descriptorPath(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isNotFound(error)) return null;
      if (isSymbolicLink(error)) throw new ProductError(`${label} uses a symbolic link`);
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile()) throw new ProductError(`${label} must be a regular file`);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async writeRegularFile(
    parent: FileHandle,
    name: string,
    bytes: Uint8Array,
    overwrite: boolean,
    beforeCommit?:(written:DescriptorWrittenFile)=>Promise<void>,
    afterCommit?:(written:DescriptorWrittenFile)=>Promise<void>
  ): Promise<DescriptorWrittenFile> {
    validateDescriptorName(name);
    const temporaryName = `.${name}.${randomUUID()}.tmp`;
    let temporary: FileHandle | undefined;
    let temporaryOwned=false;
    try {
      temporary = await open(
        descriptorPath(parent, temporaryName),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      temporaryOwned=true;
      await temporary.writeFile(bytes);
      await temporary.sync();
      const metadata=await temporary.stat({bigint:true});
      if(!metadata.isFile())throw new ProductError("Written path is not a regular file");
      const written:DescriptorWrittenFile={
        dev:metadata.dev,
        ino:metadata.ino,
        size:safeDescriptorSize(metadata.size),
        mtime:metadata.mtime
      };
      await beforeCommit?.(written);
      await temporary.close();
      temporary = undefined;
      if (overwrite) {
        await rename(descriptorPath(parent, temporaryName), descriptorPath(parent, name));
        temporaryOwned=false;
      } else {
        await link(descriptorPath(parent, temporaryName), descriptorPath(parent, name));
        await unlink(descriptorPath(parent, temporaryName));
        temporaryOwned=false;
      }
      await afterCommit?.(written);
      await parent.sync();
      return written;
    } finally {
      await temporary?.close();
      if(temporaryOwned){
        try {
          await unlink(descriptorPath(parent, temporaryName));
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
    }
  }

  async optionalStat(parent: FileHandle, name: string) {
    validateDescriptorName(name);
    try {
      return await lstat(descriptorPath(parent, name), { bigint: true });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async requiredStat(parent: FileHandle, name: string) {
    const stat = await this.optionalStat(parent, name);
    if (!stat) throw new Error("Descriptor-anchored file entry is missing");
    return stat;
  }

  async measureEntry(
    parent: FileHandle,
    name: string,
    expected?: Awaited<ReturnType<DescriptorFileTreeWalker["requiredStat"]>>,
    checkpoint?:DescriptorTreeCheckpoint
  ): Promise<number> {
    return this.measureEntryAttempt(parent, name, expected, true, 0,checkpoint);
  }

  async measureDirectory(directory: FileHandle,checkpoint?:DescriptorTreeCheckpoint): Promise<number> {
    let bytes = 0;
    await checkpoint?.();
    for (const name of await readdir(descriptorPath(directory))) {
      await checkpoint?.();
      const stat = await this.optionalStat(directory, name);
      if (!stat) continue;
      bytes += await this.measureEntryAttempt(directory, name, undefined, true, 0,checkpoint);
      if (!Number.isSafeInteger(bytes)) throw fileUsageTooLarge();
    }
    return bytes;
  }

  async removeEntry(
    parent: FileHandle,
    name: string,
    expected?: Awaited<ReturnType<DescriptorFileTreeWalker["requiredStat"]>>,
    checkpoint?:DescriptorTreeCheckpoint
  ): Promise<void> {
    await checkpoint?.();
    const observed = await this.requiredStat(parent, name);
    if (expected) assertDescriptorIdentity(expected, observed);
    await this.observer?.beforeOpenEntry?.({
      purpose: "remove",
      name,
      observedType: descriptorEntryType(observed)
    });
    await checkpoint?.();

    const entry = await this.openEntry(parent, name);
    let actual: Awaited<ReturnType<FileHandle["stat"]>>;
    try {
      actual = await entry.stat({ bigint: true });
      if (expected) assertDescriptorIdentity(expected, actual);
      if (!actual.isDirectory() || actual.isSymbolicLink()) {
        assertDescriptorIdentity(actual, await this.requiredStat(parent, name));
        await checkpoint?.();
        await unlink(descriptorPath(parent, name));
        await parent.sync();
        return;
      }
    } finally {
      await entry.close();
    }

    const directory = await this.openDirectory(parent, name);
    try {
      assertDescriptorIdentity(actual!, await directory.stat({ bigint: true }));
      await checkpoint?.();
      for (const childName of await readdir(descriptorPath(directory))) {
        await this.removeEntry(directory, childName,undefined,checkpoint);
      }
      assertDescriptorIdentity(actual!, await this.requiredStat(parent, name));
      await checkpoint?.();
      await rmdir(descriptorPath(parent, name));
      await parent.sync();
    } finally {
      await directory.close();
    }
  }

  private async measureEntryAttempt(
    parent: FileHandle,
    name: string,
    expected: Awaited<ReturnType<DescriptorFileTreeWalker["requiredStat"]>> | undefined,
    notify: boolean,
    attempt: number,
    checkpoint?:DescriptorTreeCheckpoint
  ): Promise<number> {
    await checkpoint?.();
    const observed = await this.requiredStat(parent, name);
    if (expected) assertDescriptorIdentity(expected, observed);
    if (notify) {
      await this.observer?.beforeOpenEntry?.({
        purpose: "measure",
        name,
        observedType: descriptorEntryType(observed)
      });
      await checkpoint?.();
    }

    const entry = await this.openEntry(parent, name);
    let actual: Awaited<ReturnType<FileHandle["stat"]>>;
    try {
      actual = await entry.stat({ bigint: true });
      if (expected) assertDescriptorIdentity(expected, actual);
      if (actual.isSymbolicLink() || (!actual.isFile() && !actual.isDirectory())) return 0;
      if (actual.isFile()) return safeDescriptorSize(actual.size);
    } finally {
      await entry.close();
    }

    try {
      const directory = await this.openDirectory(parent, name);
      try {
        assertDescriptorIdentity(actual!, await directory.stat({ bigint: true }));
        return await this.measureDirectory(directory,checkpoint);
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (attempt >= 2 || !isEntryTypeRace(error)) throw error;
      const replacement = await this.optionalStat(parent, name);
      if (!replacement || replacement.isSymbolicLink() || (!replacement.isFile() && !replacement.isDirectory())) {
        return 0;
      }
      return this.measureEntryAttempt(parent, name, expected, false, attempt + 1,checkpoint);
    }
  }
}

export function descriptorPath(parent: FileHandle, name?: string): string {
  return name ? `/proc/self/fd/${parent.fd}/${name}` : `/proc/self/fd/${parent.fd}`;
}

export function validateDescriptorName(value: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\0")) {
    throw new ProductError("File path is invalid");
  }
}

export function descriptorEntryType(
  stat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
): FileDeletionOperationEntryType {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  return "unsupported";
}

export function assertDescriptorIdentity(
  expected: { dev: bigint; ino: bigint },
  actual: { dev: bigint; ino: bigint }
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new ProductError("File entry changed during descriptor operation", 500);
  }
}

function safeDescriptorSize(value: bigint): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw fileUsageTooLarge();
  return size;
}

function fileUsageTooLarge(): ProductError {
  return new ProductError("Project file usage exceeds the supported size");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isEntryTypeRace(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ELOOP" || error.code === "ENOTDIR" || error.code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isSymbolicLink(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP";
}

function isNotDirectory(error:unknown):boolean{
  return typeof error==="object"&&error!==null&&"code" in error&&error.code==="ENOTDIR";
}
