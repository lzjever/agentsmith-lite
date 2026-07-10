import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DeleteProjectFileResponse,
  ProjectFileContentResponse,
  ProjectFileEntry,
  ProjectFileListResponse,
  ProjectFileWriteResponse,
  UploadProjectFileInput
} from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import { FilePathValidationService } from "./filePathValidationService.js";

interface ResolvedProjectFilePath {
  normalizedPath: string;
  absolutePath: string;
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
    options: { allowFilesRoot?: boolean } = {}
  ): Promise<ResolvedProjectFilePath> {
    const normalizedPath = this.normalizeProjectFilesPath(input, options);
    return {
      normalizedPath,
      absolutePath: await this.paths.resolveSafeProjectPathNoSymlinks(projectRoot, normalizedPath)
    };
  }

  async uploadTextFile(projectRoot: string, input: UploadProjectFileInput): Promise<ProjectFileWriteResponse> {
    const { normalizedPath, absolutePath } = await this.resolveProjectFilesPath(projectRoot, input.path);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await this.paths.resolveSafeProjectPathNoSymlinks(projectRoot, normalizedPath);
    await writeFile(absolutePath, input.content, "utf8");
    return {
      path: normalizedPath,
      bytes: Buffer.byteLength(input.content, "utf8")
    };
  }

  async listFiles(projectRoot: string, input = "files"): Promise<ProjectFileListResponse> {
    const { normalizedPath, absolutePath } = await this.resolveProjectFilesPath(projectRoot, input, { allowFilesRoot: true });
    await this.ensureFilesRoot(projectRoot);

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
    const resolvedEntries = await Promise.all(entries.map(async (entry): Promise<ProjectFileEntry | null> => {
      const entryPath = path.posix.join(normalizedPath, entry.name);
      const entryStat = await lstat(path.join(absolutePath, entry.name));
      if (entryStat.isSymbolicLink()) {
        return null;
      }
      if (entryStat.isDirectory()) {
        return {
          name: entry.name,
          path: entryPath,
          type: "directory",
          updatedAt: entryStat.mtime.toISOString()
        };
      }
      if (entryStat.isFile()) {
        return {
          name: entry.name,
          path: entryPath,
          type: "file",
          size: entryStat.size,
          updatedAt: entryStat.mtime.toISOString()
        };
      }
      return null;
    }));

    return {
      entries: resolvedEntries
        .filter((entry): entry is ProjectFileEntry => entry !== null)
        .sort((left, right) => left.path.localeCompare(right.path))
    };
  }

  async downloadTextFile(projectRoot: string, input: string): Promise<ProjectFileContentResponse> {
    const { normalizedPath, absolutePath } = await this.resolveProjectFilesPath(projectRoot, input);
    try {
      const entryStat = await lstat(absolutePath);
      if (entryStat.isDirectory()) {
        throw new ProductError("Path is a directory");
      }
      if (!entryStat.isFile()) {
        throw new ProductError("Path is not a regular file");
      }
      return {
        path: normalizedPath,
        filename: path.posix.basename(normalizedPath),
        content: await readFile(absolutePath, "utf8")
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

  async deleteFile(projectRoot: string, input: string): Promise<DeleteProjectFileResponse> {
    const { normalizedPath, absolutePath } = await this.resolveProjectFilesPath(projectRoot, input, { allowFilesRoot: true });
    if (normalizedPath === "files") {
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
    try {
      await rm(absolutePath);
    } catch (error) {
      if (isNotFound(error)) {
        throw new ProductError("File not found", 404);
      }
      throw error;
    }
    return { deleted: true };
  }

  private async ensureFilesRoot(projectRoot: string): Promise<void> {
    const { absolutePath } = await this.resolveProjectFilesPath(projectRoot, "files", { allowFilesRoot: true });
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
        return;
      }
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
