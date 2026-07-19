import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import type { FileLibrary } from "../../packages/contracts/src/api.js";

describe("file library store", () => {
  it("enforces project-scoped names and immutable root paths", async () => {
    const store = createLocalInMemoryProductStore();
    const first = library({ id: "library_one", name: "Working set", rootSubPath: "libraries/library_one/home/workspace" });
    const duplicateName = library({ id: "library_two", name: " working SET ", rootSubPath: "libraries/library_two/home/workspace" });

    assert.deepEqual(await store.createFileLibrary(first), first);
    assert.equal(await store.createFileLibrary(duplicateName), null);
    assert.deepEqual(await store.listFileLibrariesForProject("project_one"), [first]);

    const renamed = await store.renameFileLibrary("project_one", first.id, "Research", first.updatedAt, "2026-07-19T01:00:00.000Z");
    assert.equal(renamed?.name, "Research");
    assert.equal(renamed?.rootSubPath, first.rootSubPath);
    assert.equal(await store.renameFileLibrary("project_one", first.id, "Stale", first.updatedAt, "2026-07-19T02:00:00.000Z"), null);
  });
});

function library(overrides: Partial<FileLibrary>): FileLibrary {
  return {
    id: "library_one",
    workspaceId: "workspace_one",
    projectId: "project_one",
    name: "Library",
    rootSubPath: "libraries/library_one/home/workspace",
    createdByUserId: "user_one",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides
  };
}
