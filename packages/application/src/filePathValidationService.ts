import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ProductError } from "../../domain/src/errors.js";

export class FilePathValidationService {
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
    await mkdir(projectRoot, { recursive: true });
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

