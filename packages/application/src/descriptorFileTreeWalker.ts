import { constants } from "node:fs";
import { lstat, open, readdir, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { ProductError } from "../../domain/src/errors.js";
import type { FileDeletionOperationEntryType } from "../../ports/src/store.js";

const O_PATH = 0x200000;

export type DescriptorTreePurpose = "measure" | "remove";
export type DescriptorTreeCheckpoint = () => Promise<void>;

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
