import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectFileEntry as FileEntry } from "../../packages/contracts/src/api.js";
import {
  FILE_BROWSER_PAGE_SIZE,
  createFileBrowserState,
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
  ...overrides
});

const directoryEntry = (
  name: string,
  updatedAt: string
): FileEntry => ({
  name,
  path: `files/${name}`,
  type: "directory",
  updatedAt
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

  it("retains the selected path while paging", () => {
    const entries = numberedEntries(121);
    let state = createFileBrowserState(entries);
    state = reduceFileBrowserState(state, {
      type: "selection_changed",
      path: entries[0]?.path ?? null
    });
    state = reduceFileBrowserState(state, { type: "page_changed", page: 2 });

    assert.equal(state.selectedPath, "files/item-001.txt");
    assert.equal(selectFileBrowserPage(state).page, 2);
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

  it("clamps the page after removals and clears only the removed selection", () => {
    let state = createFileBrowserState(numberedEntries(51));
    state = reduceFileBrowserState(state, {
      type: "selection_changed",
      path: "files/item-001.txt"
    });
    state = reduceFileBrowserState(state, { type: "page_changed", page: 2 });
    state = reduceFileBrowserState(state, { type: "refresh_started" });
    state = reduceFileBrowserState(state, {
      type: "entry_removed",
      path: "files/item-051.txt"
    });

    assert.equal(state.loadState, "ready");
    assert.equal(state.selectedPath, "files/item-001.txt");
    assert.equal(selectFileBrowserPage(state).page, 1);
    assert.deepEqual(selectFileBrowserPage(state).range, { start: 1, end: 50 });

    state = reduceFileBrowserState(state, {
      type: "entry_removed",
      path: "files/item-001.txt"
    });
    assert.equal(state.selectedPath, null);
    assert.equal(selectFileBrowserPage(state).totalCount, 49);
  });
});

describe("file browser refresh continuity", () => {
  it("retains the last successful snapshot and selection when refresh fails", () => {
    const entries = numberedEntries(60);
    let state = createFileBrowserState(entries);
    state = reduceFileBrowserState(state, {
      type: "selection_changed",
      path: entries[54]?.path ?? null
    });
    state = reduceFileBrowserState(state, { type: "page_changed", page: 2 });
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

  it("clears selection after a successful refresh only when its path disappears", () => {
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
      entries: entries.filter((entry) => entry.path !== "files/item-002.txt")
    });
    assert.equal(state.selectedPath, null);
  });
});
