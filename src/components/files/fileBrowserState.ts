import type { ProjectFile } from "../../lib/api/client.js";

export const PROJECT_FILES_ROOT = "files";

export interface FileBreadcrumb {
  label: string;
  path: string;
}

export type FileBrowserDisplay = "loading" | "error" | "empty" | "listing";

export function parentFilePath(path: string): string | null {
  if (path === PROJECT_FILES_ROOT) {
    return null;
  }
  const separator = path.lastIndexOf("/");
  return separator <= PROJECT_FILES_ROOT.length ? PROJECT_FILES_ROOT : path.slice(0, separator);
}

export function childFilePath(path: string, name: string): string {
  return `${path}/${name}`;
}

export function fileBreadcrumbs(path: string): FileBreadcrumb[] {
  const segments = path.split("/").filter(Boolean);
  return segments.map((label, index) => ({
    label,
    path: segments.slice(0, index + 1).join("/")
  }));
}

export function sortFileEntries(entries: ProjectFile[]): ProjectFile[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function fileBrowserDisplay(state: "loading" | "ready" | "error", entries: ProjectFile[], path: string): FileBrowserDisplay {
  if (state === "loading") return "loading";
  if (state === "error") return "error";
  return entries.length === 0 ? "empty" : "listing";
}

export function showFileDetails(entry: ProjectFile | undefined, narrow: boolean, mobileDetailsOpen: boolean): boolean {
  return entry !== undefined && (!narrow || mobileDetailsOpen);
}
