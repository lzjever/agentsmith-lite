import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FileLibrary } from "../../src/lib/api/client.js";
import {
  applyCanonicalFileLibraryDeletionFact,
  fileLibraryDeleteCopy,
  fileLibraryFocusTarget,
  fileLibraryPresentation,
  fileLibrarySelectionAfterRefresh,
  fileLibrarySelectorLabel,
  isCanonicalFileLibraryDeletionError,
  nearestLibraryAfterRemoval,
  nearestSurvivingLibrary,
  shouldResetFileLibraryContext
} from "../../src/components/files/fileLibraryPresentation.js";

describe("File Library deletion presentation", () => {
  it("uses the recursive deletion confirmation contract", () => {
    assert.deepEqual(fileLibraryDeleteCopy, {
      title: "Delete File Library?",
      body: "This permanently deletes the library and all files inside it.",
      action: "Delete library and files"
    });
  });

  it("derives available, bound, and deleting states only from server projection", () => {
    assert.deepEqual(fileLibraryPresentation(library()), {
      kind: "available",
      canBrowse: true,
      action: "delete"
    });
    assert.deepEqual(fileLibraryPresentation(library({
      boundTask: { id: "task_1", title: "Prepare launch" },
      capabilities: { canRename: true, canDelete: false, canWriteFiles: true }
    })), {
      kind: "bound",
      canBrowse: true,
      action: null
    });
    assert.deepEqual(fileLibraryPresentation(library({
      lifecycleStatus: "deleting",
      capabilities: { canRename: false, canDelete: true, canWriteFiles: false }
    })), {
      kind: "deleting",
      canBrowse: false,
      action: "retry"
    });
    assert.deepEqual(fileLibraryPresentation(library({
      lifecycleStatus: "deleting",
      capabilities: { canRename: false, canDelete: false, canWriteFiles: false }
    })), {
      kind: "deleting",
      canBrowse: false,
      action: null
    });
  });

  it("refreshes canonical presentation only for the documented deletion results", () => {
    assert.equal(isCanonicalFileLibraryDeletionError("file_library_bound"), true);
    assert.equal(isCanonicalFileLibraryDeletionError("file_library_deleting"), true);
    assert.equal(isCanonicalFileLibraryDeletionError("file_library_not_found"), true);
    assert.equal(isCanonicalFileLibraryDeletionError("file_library_deletion_claim_lost"), false);
    assert.equal(isCanonicalFileLibraryDeletionError(undefined), false);
  });

  it("selects the next row, then the previous row, after canonical removal", () => {
    const libraries = [
      library({ id: "library_1", name: "One" }),
      library({ id: "library_2", name: "Two" }),
      library({ id: "library_3", name: "Three" })
    ];

    assert.equal(nearestLibraryAfterRemoval(libraries, "library_2"), "library_3");
    assert.equal(nearestLibraryAfterRemoval(libraries, "library_3"), "library_2");
    assert.equal(nearestLibraryAfterRemoval([libraries[0]!], "library_1"), null);
  });

  it("finds the nearest survivor from stale pre-refresh ordering", () => {
    const previous = [
      library({ id: "library_1", name: "One" }),
      library({ id: "library_2", name: "Two" }),
      library({ id: "library_3", name: "Three" }),
      library({ id: "library_4", name: "Four" })
    ];

    assert.equal(nearestSurvivingLibrary(previous, [previous[0]!, previous[2]!, previous[3]!], "library_2"), "library_3");
    assert.equal(nearestSurvivingLibrary(previous, [previous[0]!, previous[1]!], "library_3"), "library_2");
    assert.equal(nearestSurvivingLibrary(previous, [library({ id: "library_new" })], "library_2"), "library_new");
    assert.equal(nearestSurvivingLibrary(previous, [], "library_2"), null);
  });

  it("automatically selects the nearest survivor when refresh loses the current Library", () => {
    const previous = [
      library({ id: "library_1" }),
      library({ id: "library_2" }),
      library({ id: "library_3" })
    ];

    assert.equal(fileLibrarySelectionAfterRefresh(previous, [previous[0]!, previous[2]!], "library_2"), "library_3");
    assert.equal(fileLibrarySelectionAfterRefresh(previous, [previous[0]!, previous[1]!], "library_3"), "library_2");
    assert.equal(fileLibrarySelectionAfterRefresh(previous, previous, "library_2"), "library_2");
    assert.equal(fileLibrarySelectionAfterRefresh([], [library({ id: "library_new" })], "missing"), "library_new");
  });

  it("repairs canonical DELETE facts without inventing another deletion path", () => {
    const target = library({ id: "library_2", name: "Target" });
    const libraries = [library({ id: "library_1" }), target, library({ id: "library_3" })];

    assert.deepEqual(
      applyCanonicalFileLibraryDeletionFact(libraries, target.id, { kind: "not_found" }).map((item) => item.id),
      ["library_1", "library_3"]
    );

    const deleting = applyCanonicalFileLibraryDeletionFact(libraries, target.id, { kind: "deleting" })[1]!;
    assert.equal(deleting.lifecycleStatus, "deleting");
    assert.deepEqual(deleting.capabilities, { canRename: false, canDelete: true, canWriteFiles: false });
    assert.deepEqual(fileLibraryPresentation(deleting), { kind: "deleting", canBrowse: false, action: "retry" });

    const task = { id: "task_1", title: "Owning Task" };
    const bound = applyCanonicalFileLibraryDeletionFact(libraries, target.id, { kind: "bound", task })[1]!;
    assert.deepEqual(bound.boundTask, task);
    assert.equal(bound.capabilities.canDelete, false);
    assert.equal(bound.capabilities.canRename, true);
    assert.equal(bound.capabilities.canWriteFiles, true);
  });

  it("adds canonical status to mobile selector labels without changing identity", () => {
    assert.equal(fileLibrarySelectorLabel(library({ name: "Available files" })), "Available files (Available)");
    assert.equal(fileLibrarySelectorLabel(library({
      name: "Task files",
      boundTask: { id: "task_1", title: "A very long Task name" }
    })), "Task files (Bound to Task)");
    assert.equal(fileLibrarySelectorLabel(library({
      name: "Old files",
      lifecycleStatus: "deleting"
    })), "Old files (Deletion did not finish)");
  });

  it("chooses a stable post-deletion focus surface for each layout", () => {
    assert.deepEqual(fileLibraryFocusTarget(false, "library_2"), { kind: "desktop-library", libraryId: "library_2" });
    assert.deepEqual(fileLibraryFocusTarget(false, null), { kind: "desktop-heading" });
    assert.deepEqual(fileLibraryFocusTarget(true, "library_2"), { kind: "mobile-selector" });
    assert.deepEqual(fileLibraryFocusTarget(true, null), { kind: "mobile-heading" });
  });

  it("resets file context once when canonical refresh makes a Library unbrowseable", () => {
    const active = library();
    const bound = library({ boundTask: { id: "task_1", title: null } });
    const deleting = library({
      lifecycleStatus: "deleting",
      capabilities: { canRename: false, canDelete: true, canWriteFiles: false }
    });

    assert.equal(shouldResetFileLibraryContext(active, deleting), true);
    assert.equal(shouldResetFileLibraryContext(undefined, deleting), true);
    assert.equal(shouldResetFileLibraryContext(deleting, deleting), false);
    assert.equal(shouldResetFileLibraryContext(active, bound), false);
    assert.equal(shouldResetFileLibraryContext(bound, active), false);
  });
});

function library(overrides: Partial<FileLibrary> = {}): FileLibrary {
  return {
    id: "library_1",
    workspaceId: "workspace_1",
    projectId: "project_1",
    name: "Library",
    rootSubPath: "libraries/library_1/home",
    lifecycleStatus: "active",
    createdByUserId: "user_1",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    boundTask: null,
    capabilities: { canRename: true, canDelete: true, canWriteFiles: true },
    ...overrides
  };
}
