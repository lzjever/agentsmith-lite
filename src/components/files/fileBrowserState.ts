import type { ProjectFile } from "../../lib/api/client.js";

export const PROJECT_FILES_ROOT = "files";

export function normalizeFileBrowserPath(input: string | null | undefined): string {
  if (!input || input.includes("\\")) return PROJECT_FILES_ROOT;
  const segments = input.split("/");
  if (segments[0] !== PROJECT_FILES_ROOT || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return PROJECT_FILES_ROOT;
  }
  return segments.join("/");
}

export interface FileBreadcrumb {
  label: string;
  path: string;
}

export type FileBrowserDisplay = "loading" | "error" | "empty" | "listing";
export type FileBrowserSortField = "name" | "size" | "updatedAt";
export type FileBrowserSortDirection = "asc" | "desc";
export type FileBrowserLoadState = "idle" | "loading" | "ready" | "error";

export interface FileBrowserSort {
  field: FileBrowserSortField;
  direction: FileBrowserSortDirection;
}

export interface FileBrowserState {
  entries: ProjectFile[];
  query: string;
  sort: FileBrowserSort;
  page: number;
  selectedPath: string | null;
  loadState: FileBrowserLoadState;
  message: string;
}

export type FileBrowserAction =
  | { type: "filter_changed"; query: string }
  | { type: "sort_changed"; sort: FileBrowserSort }
  | { type: "page_changed"; page: number }
  | { type: "selection_changed"; path: string | null }
  | { type: "location_changed" }
  | { type: "refresh_started" }
  | { type: "refresh_succeeded"; entries: ProjectFile[] }
  | { type: "refresh_failed"; message: string }
  | { type: "entry_upserted"; entry: ProjectFile }
  | { type: "entry_removed"; path: string }
  | { type: "delete_access_revoked" };

export interface FileBrowserPage {
  entries: ProjectFile[];
  page: number;
  pageCount: number;
  totalCount: number;
  range: {
    start: number;
    end: number;
  };
}

export interface FileBrowserDeletionFocusCandidates {
  nextPath: string | null;
  previousPath: string | null;
}

export const FILE_BROWSER_PAGE_SIZE = 50;
export const DEFAULT_FILE_BROWSER_SORT: FileBrowserSort = {
  field: "name",
  direction: "asc"
};

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

export function sortFileEntries(
  entries: ProjectFile[],
  sort: FileBrowserSort = DEFAULT_FILE_BROWSER_SORT
): ProjectFile[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    const fieldComparison = compareFileField(left, right, sort.field);
    if (fieldComparison !== 0) {
      return sort.direction === "asc" ? fieldComparison : -fieldComparison;
    }

    const nameComparison = left.name.localeCompare(right.name);
    if (nameComparison !== 0) {
      return sort.direction === "asc" ? nameComparison : -nameComparison;
    }
    return left.path.localeCompare(right.path);
  });
}

export function createFileBrowserState(entries: ProjectFile[]): FileBrowserState {
  return {
    entries,
    query: "",
    sort: DEFAULT_FILE_BROWSER_SORT,
    page: 1,
    selectedPath: null,
    loadState: "ready",
    message: ""
  };
}

export function reduceFileBrowserState(
  state: FileBrowserState,
  action: FileBrowserAction
): FileBrowserState {
  switch (action.type) {
    case "filter_changed":
      return { ...state, query: action.query, page: 1 };
    case "sort_changed":
      return { ...state, sort: action.sort, page: 1 };
    case "page_changed":
      return { ...state, page: clampPage(action.page, filteredEntryCount(state)) };
    case "selection_changed":
      return { ...state, selectedPath: action.path };
    case "location_changed":
      return {
        ...state,
        entries: [],
        query: "",
        page: 1,
        selectedPath: null,
        loadState: "idle",
        message: ""
      };
    case "refresh_started":
      return { ...state, loadState: "loading", message: "" };
    case "refresh_succeeded":
      return replaceEntries(state, action.entries, "ready", "");
    case "refresh_failed":
      return { ...state, loadState: "error", message: action.message };
    case "entry_upserted":
      return replaceEntries(
        state,
        [...state.entries.filter((entry) => entry.path !== action.entry.path), action.entry],
        "ready",
        ""
      );
    case "entry_removed":
      return replaceEntries(
        state,
        state.entries.filter((entry) => entry.path !== action.path),
        "ready",
        ""
      );
    case "delete_access_revoked":
      return {
        ...state,
        entries: state.entries.map((entry) => ({
          ...entry,
          capabilities: {
            canDelete: false,
            deleteUnavailableReason:
              entry.capabilities.deleteUnavailableReason === "artifact_namespace_protected"
                ? "artifact_namespace_protected"
                : "read_only"
          }
        }))
      };
  }
}

export function selectFileBrowserPage(state: FileBrowserState): FileBrowserPage {
  const normalizedQuery = state.query.trim().toLowerCase();
  const filtered = state.entries.filter((entry) =>
    entry.name.toLowerCase().includes(normalizedQuery)
  );
  const sorted = sortFileEntries(filtered, state.sort);
  const pageCount = pageCountFor(sorted.length);
  const page = Math.min(Math.max(state.page, 1), pageCount);
  const offset = (page - 1) * FILE_BROWSER_PAGE_SIZE;
  const entries = sorted.slice(offset, offset + FILE_BROWSER_PAGE_SIZE);

  return {
    entries,
    page,
    pageCount,
    totalCount: sorted.length,
    range: {
      start: sorted.length === 0 ? 0 : offset + 1,
      end: offset + entries.length
    }
  };
}

export function fileBrowserDeletionFocusCandidates(
  state: FileBrowserState,
  deletedPath: string
): FileBrowserDeletionFocusCandidates {
  const normalizedQuery = state.query.trim().toLowerCase();
  const presented = sortFileEntries(
    state.entries.filter((entry) =>
      entry.name.toLowerCase().includes(normalizedQuery)
    ),
    state.sort
  );
  const deletedIndex = presented.findIndex((entry) => entry.path === deletedPath);
  if (deletedIndex < 0) {
    return { nextPath: null, previousPath: null };
  }
  return {
    nextPath: presented[deletedIndex + 1]?.path ?? null,
    previousPath: presented[deletedIndex - 1]?.path ?? null
  };
}

export function fileDeleteUnavailableMessage(
  reason: ProjectFile["capabilities"]["deleteUnavailableReason"],
  entryType: ProjectFile["type"]
): string | null {
  if (reason === "artifact_namespace_protected") {
    return `This ${entryType === "directory" ? "folder" : "file"} preserves protected Task Artifacts and cannot be deleted.`;
  }
  if (reason === "read_only") {
    return "This File Library is read-only, so this entry cannot be deleted.";
  }
  return null;
}

export function isFileBrowserDeleteTargetCurrent(
  target: { libraryId: string; path: string },
  current: { libraryId: string | null; path: string }
): boolean {
  const separator = target.path.lastIndexOf("/");
  const parentPath = separator < 0 ? "" : target.path.slice(0, separator);
  return target.libraryId === current.libraryId && parentPath === current.path;
}

export function fileBrowserDisplay(state: "loading" | "ready" | "error", entries: ProjectFile[], path: string): FileBrowserDisplay {
  if (state === "loading") return "loading";
  if (state === "error") return "error";
  return entries.length === 0 ? "empty" : "listing";
}

export function showFileDetails(entry: ProjectFile | undefined, narrow: boolean, mobileDetailsOpen: boolean): boolean {
  return entry !== undefined && (!narrow || mobileDetailsOpen);
}

function compareFileField(
  left: ProjectFile,
  right: ProjectFile,
  field: FileBrowserSortField
): number {
  if (field === "size") {
    return (left.size ?? 0) - (right.size ?? 0);
  }
  return left[field].localeCompare(right[field]);
}

function replaceEntries(
  state: FileBrowserState,
  entries: ProjectFile[],
  loadState: FileBrowserLoadState,
  message: string
): FileBrowserState {
  const selectedPath =
    state.selectedPath && entries.some((entry) => entry.path === state.selectedPath)
      ? state.selectedPath
      : null;
  const next = { ...state, entries };
  return {
    ...next,
    page: clampPage(state.page, filteredEntryCount(next)),
    selectedPath,
    loadState,
    message
  };
}

function filteredEntryCount(state: Pick<FileBrowserState, "entries" | "query">): number {
  const normalizedQuery = state.query.trim().toLowerCase();
  return state.entries.filter((entry) =>
    entry.name.toLowerCase().includes(normalizedQuery)
  ).length;
}

function clampPage(page: number, entryCount: number): number {
  return Math.min(Math.max(Math.trunc(page) || 1, 1), pageCountFor(entryCount));
}

function pageCountFor(entryCount: number): number {
  return Math.max(1, Math.ceil(entryCount / FILE_BROWSER_PAGE_SIZE));
}
