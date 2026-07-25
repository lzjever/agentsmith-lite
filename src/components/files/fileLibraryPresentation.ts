import type { FileLibrary } from "../../lib/api/client.js";

export const fileLibraryDeleteCopy = {
  title: "Delete File Library?",
  body: "This permanently deletes the library and all files inside it.",
  action: "Delete library and files"
} as const;

export type FileLibraryPresentation =
  | { kind: "available"; canBrowse: true; action: "delete" | null }
  | { kind: "bound"; canBrowse: true; action: null }
  | { kind: "deleting"; canBrowse: false; action: "retry" | null };

export function fileLibraryPresentation(library: FileLibrary): FileLibraryPresentation {
  if (library.lifecycleStatus === "deleting") {
    return {
      kind: "deleting",
      canBrowse: false,
      action: library.capabilities.canDelete ? "retry" : null
    };
  }
  if (library.boundTask) {
    return { kind: "bound", canBrowse: true, action: null };
  }
  return {
    kind: "available",
    canBrowse: true,
    action: library.capabilities.canDelete ? "delete" : null
  };
}

export function isCanonicalFileLibraryDeletionError(code: string | undefined): boolean {
  return code === "file_library_bound"
    || code === "file_library_deleting"
    || code === "file_library_not_found";
}

export function nearestLibraryAfterRemoval(
  libraries: readonly FileLibrary[],
  removedLibraryId: string
): string | null {
  return nearestSurvivingLibrary(
    libraries,
    libraries.filter((library) => library.id !== removedLibraryId),
    removedLibraryId
  );
}

export function nearestSurvivingLibrary(
  previousLibraries: readonly FileLibrary[],
  nextLibraries: readonly FileLibrary[],
  removedLibraryId: string
): string | null {
  const survivingIds = new Set(nextLibraries.map((library) => library.id));
  const removedIndex = previousLibraries.findIndex((library) => library.id === removedLibraryId);
  if (removedIndex >= 0) {
    for (let index = removedIndex + 1; index < previousLibraries.length; index += 1) {
      const candidate = previousLibraries[index]?.id;
      if (candidate && survivingIds.has(candidate)) return candidate;
    }
    for (let index = removedIndex - 1; index >= 0; index -= 1) {
      const candidate = previousLibraries[index]?.id;
      if (candidate && survivingIds.has(candidate)) return candidate;
    }
  }
  return nextLibraries[0]?.id ?? null;
}

export function fileLibrarySelectionAfterRefresh(
  previousLibraries: readonly FileLibrary[],
  nextLibraries: readonly FileLibrary[],
  currentLibraryId: string | null
): string | null {
  const removedLibraryId = currentLibraryId
    && previousLibraries.some((library) => library.id === currentLibraryId)
    && !nextLibraries.some((library) => library.id === currentLibraryId)
    ? currentLibraryId
    : undefined;
  if (removedLibraryId) return nearestSurvivingLibrary(previousLibraries, nextLibraries, removedLibraryId);
  if (nextLibraries.some((library) => library.id === currentLibraryId)) return currentLibraryId;
  return nextLibraries[0]?.id ?? null;
}

type CanonicalFileLibraryDeletionFact =
  | { kind: "not_found" }
  | { kind: "deleting" }
  | { kind: "bound"; task: NonNullable<FileLibrary["boundTask"]> };

export function applyCanonicalFileLibraryDeletionFact(
  libraries: readonly FileLibrary[],
  targetLibraryId: string,
  fact: CanonicalFileLibraryDeletionFact
): FileLibrary[] {
  if (fact.kind === "not_found") return libraries.filter((library) => library.id !== targetLibraryId);
  return libraries.map((library) => {
    if (library.id !== targetLibraryId) return library;
    if (fact.kind === "deleting") {
      return {
        ...library,
        lifecycleStatus: "deleting",
        boundTask: null,
        capabilities: {
          canRename: false,
          canDelete: library.capabilities.canDelete,
          canWriteFiles: false
        }
      };
    }
    return {
      ...library,
      boundTask: fact.task,
      capabilities: { ...library.capabilities, canDelete: false }
    };
  });
}

export function fileLibrarySelectorLabel(library: FileLibrary): string {
  const presentation = fileLibraryPresentation(library);
  if (presentation.kind === "deleting") return `${library.name} (Deletion did not finish)`;
  if (presentation.kind === "bound") return `${library.name} (Bound to Task)`;
  return `${library.name} (Available)`;
}

export type FileLibraryFocusTarget =
  | { kind: "desktop-library"; libraryId: string }
  | { kind: "desktop-heading" }
  | { kind: "mobile-selector" }
  | { kind: "mobile-heading" };

export function fileLibraryFocusTarget(narrow: boolean, libraryId: string | null): FileLibraryFocusTarget {
  if (narrow) return libraryId ? { kind: "mobile-selector" } : { kind: "mobile-heading" };
  return libraryId ? { kind: "desktop-library", libraryId } : { kind: "desktop-heading" };
}

export function shouldResetFileLibraryContext(
  previous: FileLibrary | undefined,
  next: FileLibrary | undefined
): boolean {
  return next !== undefined
    && !fileLibraryPresentation(next).canBrowse
    && (previous === undefined || fileLibraryPresentation(previous).canBrowse);
}
