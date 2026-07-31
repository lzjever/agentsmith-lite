import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectFileListEntry as FileEntry } from "../../packages/contracts/src/api.js";
import {
  FILE_BROWSER_PAGE_SIZE,
  createFileBrowserState,
  fileBrowserDeletionFocusCandidates,
  fileDeleteUnavailableMessage,
  isFileBrowserDeleteTargetCurrent,
  reduceFileBrowserState,
  selectFileBrowserPage
} from "../../src/components/files/fileBrowserState.js";

const fileEntry = (
  name: string,
  overrides: Partial<FileEntry> = {}
): FileEntry => ({
  name,
  path: `files/${name}`,
  type: "file",
  size: 0,
  updatedAt: "2026-07-24T00:00:00.000Z",
  capabilities: {
    canDelete: true,
    deleteUnavailableReason: null
  },
  ...overrides
});

const directoryEntry = (
  name: string,
  updatedAt: string
): FileEntry => ({
  name,
  path: `files/${name}`,
  type: "directory",
  updatedAt,
  capabilities: {
    canDelete: true,
    deleteUnavailableReason: null
  }
});

const numberedEntries = (count: number): FileEntry[] =>
  Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    return fileEntry(`item-${number}.txt`, {
      size: index + 1,
      updatedAt: `2026-07-${String((index % 24) + 1).padStart(2, "0")}T00:00:00.000Z`
    });
  });

describe("file browser bounded presentation", () => {
  it("presents 121 loaded entries as 50, 50, and 21 item pages with inclusive ranges", () => {
    assert.equal(FILE_BROWSER_PAGE_SIZE, 50);

    let state = createFileBrowserState(numberedEntries(121));
    let page = selectFileBrowserPage(state);
    assert.equal(page.page, 1);
    assert.equal(page.pageCount, 3);
    assert.equal(page.totalCount, 121);
    assert.deepEqual(page.range, { start: 1, end: 50 });
    assert.equal(page.entries.length, 50);
    assert.equal(page.entries[0]?.name, "item-001.txt");
    assert.equal(page.entries[49]?.name, "item-050.txt");

    state = reduceFileBrowserState(state, { type: "page_changed", page: 2 });
    page = selectFileBrowserPage(state);
    assert.deepEqual(page.range, { start: 51, end: 100 });
    assert.equal(page.entries.length, 50);
    assert.equal(page.entries[0]?.name, "item-051.txt");
    assert.equal(page.entries[49]?.name, "item-100.txt");

    state = reduceFileBrowserState(state, { type: "page_changed", page: 3 });
    page = selectFileBrowserPage(state);
    assert.deepEqual(page.range, { start: 101, end: 121 });
    assert.equal(page.entries.length, 21);
    assert.equal(page.entries[0]?.name, "item-101.txt");
    assert.equal(page.entries[20]?.name, "item-121.txt");
  });

  it("keeps directories first for name, size, and updated-time user sorts", () => {
    const entries: FileEntry[] = [
      fileEntry("file-alpha.txt", {
        size: 40,
        updatedAt: "2026-07-03T00:00:00.000Z"
      }),
      directoryEntry("dir-zeta", "2026-07-01T00:00:00.000Z"),
      fileEntry("file-zeta.txt", {
        size: 10,
        updatedAt: "2026-07-02T00:00:00.000Z"
      }),
      directoryEntry("dir-alpha", "2026-07-04T00:00:00.000Z")
    ];
    let state = createFileBrowserState(entries);

    assert.deepEqual(
      selectFileBrowserPage(state).entries.map((entry) => entry.name),
      ["dir-alpha", "dir-zeta", "file-alpha.txt", "file-zeta.txt"]
    );

    state = reduceFileBrowserState(state, {
      type: "sort_changed",
      sort: { field: "name", direction: "desc" }
    });
    assert.deepEqual(
      selectFileBrowserPage(state).entries.map((entry) => entry.name),
      ["dir-zeta", "dir-alpha", "file-zeta.txt", "file-alpha.txt"]
    );

    state = reduceFileBrowserState(state, {
      type: "sort_changed",
      sort: { field: "size", direction: "asc" }
    });
    const sizeAscending = selectFileBrowserPage(state).entries;
    assert.deepEqual(
      sizeAscending.slice(0, 2).map((entry) => entry.type),
      ["directory", "directory"]
    );
    assert.deepEqual(
      sizeAscending.slice(2).map((entry) => entry.name),
      ["file-zeta.txt", "file-alpha.txt"]
    );

    state = reduceFileBrowserState(state, {
      type: "sort_changed",
      sort: { field: "updatedAt", direction: "asc" }
    });
    assert.deepEqual(
      selectFileBrowserPage(state).entries.map((entry) => entry.name),
      ["dir-zeta", "dir-alpha", "file-zeta.txt", "file-alpha.txt"]
    );
  });

  it("returns to the first page when the name filter or sort changes", () => {
    let state = createFileBrowserState(numberedEntries(121));
    state = reduceFileBrowserState(state, { type: "page_changed", page: 3 });
    state = reduceFileBrowserState(state, {
      type: "filter_changed",
      query: "item"
    });
    assert.equal(selectFileBrowserPage(state).page, 1);

    state = reduceFileBrowserState(state, { type: "page_changed", page: 2 });
    state = reduceFileBrowserState(state, {
      type: "sort_changed",
      sort: { field: "updatedAt", direction: "desc" }
    });
    assert.equal(selectFileBrowserPage(state).page, 1);
  });

  it("clamps the current page when replacement data shrinks", () => {
    let state = createFileBrowserState(numberedEntries(121));
    state = reduceFileBrowserState(state, { type: "page_changed", page: 3 });
    state = reduceFileBrowserState(state, { type: "refresh_started" });
    state = reduceFileBrowserState(state, {
      type: "refresh_succeeded",
      entries: numberedEntries(51)
    });

    const page = selectFileBrowserPage(state);
    assert.equal(page.page, 2);
    assert.equal(page.pageCount, 2);
    assert.deepEqual(page.range, { start: 51, end: 51 });
    assert.deepEqual(page.entries.map((entry) => entry.name), ["item-051.txt"]);
  });

  it("clears the selected path when paging moves it outside the visible page", () => {
    const entries = numberedEntries(121);
    let state = createFileBrowserState(entries);
    state = reduceFileBrowserState(state, {
      type: "selection_changed",
      path: entries[0]?.path ?? null
    });
    state = reduceFileBrowserState(state, { type: "page_changed", page: 2 });

    assert.equal(state.selectedPath, null);
    assert.equal(selectFileBrowserPage(state).page, 2);
  });

  it("retains selection only while filtering and sorting keep it visible", () => {
    let filtered = createFileBrowserState(numberedEntries(60));
    filtered = reduceFileBrowserState(filtered, {
      type: "selection_changed",
      path: "files/item-001.txt"
    });
    filtered = reduceFileBrowserState(filtered, {
      type: "filter_changed",
      query: "item-001"
    });
    assert.equal(filtered.selectedPath, "files/item-001.txt");
    filtered = reduceFileBrowserState(filtered, {
      type: "filter_changed",
      query: "item-002"
    });
    assert.equal(filtered.selectedPath, null);

    let sorted = createFileBrowserState(numberedEntries(60));
    sorted = reduceFileBrowserState(sorted, {
      type: "selection_changed",
      path: "files/item-001.txt"
    });
    sorted = reduceFileBrowserState(sorted, {
      type: "sort_changed",
      sort: { field: "name", direction: "desc" }
    });
    assert.equal(sorted.selectedPath, null);
  });

  it("upserts entries into the authoritative snapshot without losing selection", () => {
    const entries = numberedEntries(2);
    let state = createFileBrowserState(entries);
    state = reduceFileBrowserState(state, {
      type: "selection_changed",
      path: "files/item-002.txt"
    });
    state = reduceFileBrowserState(state, { type: "refresh_started" });
    state = reduceFileBrowserState(state, {
      type: "entry_upserted",
      entry: fileEntry("item-002.txt", {
        size: 200,
        mediaType: "text/plain",
        updatedAt: "2026-07-25T00:00:00.000Z"
      })
    });
    state = reduceFileBrowserState(state, {
      type: "entry_upserted",
      entry: fileEntry("item-003.txt", { size: 3 })
    });

    assert.equal(state.loadState, "ready");
    assert.equal(state.selectedPath, "files/item-002.txt");
    assert.equal(state.entries.length, 3);
    assert.deepEqual(
      state.entries.find((entry) => entry.path === "files/item-002.txt"),
      fileEntry("item-002.txt", {
        size: 200,
        mediaType: "text/plain",
        updatedAt: "2026-07-25T00:00:00.000Z"
      })
    );
  });

  it("clamps the page after removals and clears a selection no longer visible", () => {
    let state = createFileBrowserState(numberedEntries(51));
    state = reduceFileBrowserState(state, { type: "page_changed", page: 2 });
    state = reduceFileBrowserState(state, {
      type: "selection_changed",
      path: "files/item-051.txt"
    });
    state = reduceFileBrowserState(state, { type: "refresh_started" });
    state = reduceFileBrowserState(state, {
      type: "entry_removed",
      path: "files/item-051.txt"
    });

    assert.equal(state.loadState, "ready");
    assert.equal(state.selectedPath, null);
    assert.equal(selectFileBrowserPage(state).page, 1);
    assert.deepEqual(selectFileBrowserPage(state).range, { start: 1, end: 50 });
    assert.equal(selectFileBrowserPage(state).totalCount, 50);
  });
});

describe("file browser refresh continuity", () => {
  it("settles loading without replacing the snapshot when a mutation invalidates refresh", () => {
    const entries = numberedEntries(3);
    let state = createFileBrowserState(entries);
    state = reduceFileBrowserState(state, { type: "refresh_started" });
    state = reduceFileBrowserState(state, { type: "refresh_invalidated" });

    assert.deepEqual(state.entries, entries);
    assert.equal(state.loadState, "ready");
    assert.equal(state.message, "");
  });

  it("retains the last successful snapshot and selection when refresh fails", () => {
    const entries = numberedEntries(60);
    let state = createFileBrowserState(entries);
    state = reduceFileBrowserState(state, { type: "page_changed", page: 2 });
    state = reduceFileBrowserState(state, {
      type: "selection_changed",
      path: entries[54]?.path ?? null
    });
    state = reduceFileBrowserState(state, { type: "refresh_started" });
    state = reduceFileBrowserState(state, {
      type: "refresh_failed",
      message: "Storage is temporarily unavailable"
    });

    assert.deepEqual(state.entries, entries);
    assert.equal(state.selectedPath, "files/item-055.txt");
    assert.equal(selectFileBrowserPage(state).page, 2);
    assert.deepEqual(selectFileBrowserPage(state).range, { start: 51, end: 60 });
  });

  it("retains selection after refresh only while it remains on the visible page", () => {
    const entries = numberedEntries(3);
    let state = createFileBrowserState(entries);
    state = reduceFileBrowserState(state, {
      type: "selection_changed",
      path: entries[1]?.path ?? null
    });
    state = reduceFileBrowserState(state, { type: "refresh_started" });
    state = reduceFileBrowserState(state, {
      type: "refresh_succeeded",
      entries: entries.map((entry) =>
        entry.path === "files/item-002.txt"
          ? { ...entry, size: 200 }
          : entry
      )
    });
    assert.equal(state.selectedPath, "files/item-002.txt");

    state = reduceFileBrowserState(state, { type: "refresh_started" });
    state = reduceFileBrowserState(state, {
      type: "refresh_succeeded",
      entries: [
        ...numberedEntries(50).map((entry, index) => ({
          ...entry,
          name: `aaa-${String(index + 1).padStart(3, "0")}.txt`,
          path: `files/aaa-${String(index + 1).padStart(3, "0")}.txt`
        })),
        ...entries
      ]
    });
    assert.equal(state.selectedPath, null);
  });
});

describe("file browser deletion continuity", () => {
  it("returns the next and previous rows from the filtered, sorted presentation", () => {
    let state = createFileBrowserState(numberedEntries(5));
    state = reduceFileBrowserState(state, {
      type: "sort_changed",
      sort: { field: "name", direction: "desc" }
    });
    state = reduceFileBrowserState(state, {
      type: "filter_changed",
      query: "item"
    });

    assert.deepEqual(
      fileBrowserDeletionFocusCandidates(state, "files/item-003.txt"),
      {
        nextPath: "files/item-002.txt",
        previousPath: "files/item-004.txt"
      }
    );
  });

  it("uses the preceding row when deleting the only entry on a clamped final page", () => {
    let state = createFileBrowserState(numberedEntries(51));
    state = reduceFileBrowserState(state, { type: "page_changed", page: 2 });

    assert.deepEqual(
      fileBrowserDeletionFocusCandidates(state, "files/item-051.txt"),
      {
        nextPath: null,
        previousPath: "files/item-050.txt"
      }
    );
  });

  it("falls back to the list heading when the selected entry is outside the presentation", () => {
    let state = createFileBrowserState(numberedEntries(3));
    state = reduceFileBrowserState(state, {
      type: "filter_changed",
      query: "item-001"
    });

    assert.deepEqual(
      fileBrowserDeletionFocusCandidates(state, "files/item-003.txt"),
      { nextPath: null, previousPath: null }
    );
  });

  it("maps server delete capability reasons to human-readable details", () => {
    assert.equal(
      fileDeleteUnavailableMessage("artifact_namespace_protected", "directory"),
      "This folder preserves protected Task Artifacts and cannot be deleted."
    );
    assert.equal(
      fileDeleteUnavailableMessage("read_only", "file"),
      "This File Library is read-only, so this entry cannot be deleted."
    );
    assert.equal(fileDeleteUnavailableMessage(null, "directory"), null);
  });

  it("accepts a delete target only in the current library and parent folder", () => {
    assert.equal(
      isFileBrowserDeleteTargetCurrent(
        { libraryId: "library_1", path: "reports/brief.txt" },
        { libraryId: "library_1", path: "reports" }
      ),
      true
    );
    assert.equal(
      isFileBrowserDeleteTargetCurrent(
        { libraryId: "library_1", path: "brief.txt" },
        { libraryId: "library_1", path: "" }
      ),
      true
    );
    assert.equal(
      isFileBrowserDeleteTargetCurrent(
        { libraryId: "library_1", path: "reports/brief.txt" },
        { libraryId: "library_2", path: "reports" }
      ),
      false
    );
    assert.equal(
      isFileBrowserDeleteTargetCurrent(
        { libraryId: "library_1", path: "reports/brief.txt" },
        { libraryId: "library_1", path: "" }
      ),
      false
    );
  });

  it("keeps a known missing entry removed when reconciliation fails", () => {
    const entries = numberedEntries(3);
    let state = createFileBrowserState(entries);
    state = reduceFileBrowserState(state, {
      type: "selection_changed",
      path: entries[1]!.path
    });
    state = reduceFileBrowserState(state, {
      type: "entry_removed",
      path: entries[1]!.path
    });
    state = reduceFileBrowserState(state, { type: "refresh_started" });
    state = reduceFileBrowserState(state, {
      type: "refresh_failed",
      message: "Storage is temporarily unavailable"
    });

    assert.equal(state.selectedPath, null);
    assert.deepEqual(
      state.entries.map((entry) => entry.path),
      [entries[0]!.path, entries[2]!.path]
    );
    assert.equal(state.loadState, "error");
  });

  it("marks current entry capabilities read-only without disturbing presentation state", () => {
    const entries = numberedEntries(51);
    entries[0] = {
      ...entries[0]!,
      capabilities: {
        canDelete: false,
        deleteUnavailableReason: "artifact_namespace_protected"
      }
    };
    let state = createFileBrowserState(entries);
    state = reduceFileBrowserState(state, { type: "page_changed", page: 2 });
    state = reduceFileBrowserState(state, {
      type: "selection_changed",
      path: "files/item-051.txt"
    });
    state = reduceFileBrowserState(state, { type: "delete_access_revoked" });

    assert.equal(state.selectedPath, "files/item-051.txt");
    assert.equal(selectFileBrowserPage(state).page, 2);
    assert.equal(state.loadState, "ready");
    assert.deepEqual(state.entries[0]!.capabilities, {
      canDelete: false,
      deleteUnavailableReason: "artifact_namespace_protected"
    });
    assert.equal(state.entries.every((entry) => entry.capabilities.canDelete === false), true);
    assert.equal(
      state.entries.slice(1).every((entry) =>
        entry.capabilities.deleteUnavailableReason === "read_only"
      ),
      true
    );
  });
});
