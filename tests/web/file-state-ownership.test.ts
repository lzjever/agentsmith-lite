import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFileStateOwnership,
  fileDetailScope,
  fileDirectoryScope,
  fileLibraryCollectionScope
} from "../../src/components/files/fileStateOwnership.js";

describe("Files presentation ownership", () => {
  it("rejects stale Library reads after create and rename intents", () => {
    const ownership = createFileStateOwnership();
    const scope = fileLibraryCollectionScope("project_1");
    let names = ["Drafts"];

    const beforeCreate = ownership.beginRead(scope);
    const create = ownership.beginMutation([scope]);
    assert.equal(ownership.finishMutation(create), true);
    names = [...names, "Reports"];
    if (ownership.finishRead(beforeCreate).apply) names = ["Drafts"];
    assert.deepEqual(names, ["Drafts", "Reports"]);

    const beforeRename = ownership.beginRead(scope);
    const rename = ownership.beginMutation([scope]);
    assert.equal(ownership.finishMutation(rename), true);
    names = names.map((name) => name === "Reports" ? "Final reports" : name);
    if (ownership.finishRead(beforeRename).apply) names = ["Drafts", "Reports"];
    assert.deepEqual(names, ["Drafts", "Final reports"]);
  });

  it("does not let a directory read started before or during delete restore an entry", () => {
    const ownership = createFileStateOwnership();
    const directory = fileDirectoryScope("project_1", "library_1", "reports");
    let entries = ["reports/brief.txt"];

    const beforeDelete = ownership.beginRead(directory);
    const deletion = ownership.beginMutation([
      directory,
      fileDetailScope("project_1", "library_1", "reports/brief.txt")
    ]);
    const duringDelete = ownership.beginRead(directory);

    if (ownership.finishRead(duringDelete).apply) entries = ["reports/brief.txt"];
    assert.deepEqual(entries, ["reports/brief.txt"]);

    assert.equal(ownership.finishMutation(deletion), true);
    entries = [];
    if (ownership.finishRead(beforeDelete).apply) entries = ["reports/brief.txt"];
    if (ownership.finishRead(duringDelete).apply) entries = ["reports/brief.txt"];
    assert.deepEqual(entries, []);
  });

  it("accepts only M2 when same-scope mutations resolve M2 then M1", () => {
    const ownership = createFileStateOwnership();
    const directory = fileDirectoryScope("project_1", "library_1", "reports");
    let result = "";

    const mutation1 = ownership.beginMutation([directory]);
    const mutation2 = ownership.beginMutation([directory]);

    if (ownership.finishMutation(mutation2)) result = "M2";
    if (ownership.finishMutation(mutation1)) result = "M1";
    assert.equal(result, "M2");
  });

  it("releases superseded attempts and requests convergence after M2 then M1", () => {
    const ownership = createFileStateOwnership();
    const directory = fileDirectoryScope("project_1", "library_1", "reports");
    const detailA = fileDetailScope("project_1", "library_1", "reports/a.txt");
    const detailB = fileDetailScope("project_1", "library_1", "reports/b.txt");
    let presentation = "";
    let convergenceRefreshes = 0;

    const mutation1 = ownership.beginMutation([directory, detailA], "file-write");
    const mutation2 = ownership.beginMutation([directory, detailB], "file-write");

    if (ownership.finishMutation(mutation2)) presentation = "M2";
    assert.deepEqual(ownership.finishAttempt(mutation2), {
      released: true,
      attemptsRemain: true
    });

    if (ownership.finishMutation(mutation1)) presentation = "M1";
    else convergenceRefreshes += 1;
    assert.deepEqual(ownership.finishAttempt(mutation1), {
      released: true,
      attemptsRemain: false
    });

    assert.equal(presentation, "M2");
    assert.equal(convergenceRefreshes, 1);
  });

  it("keeps different directory scopes independent", () => {
    const ownership = createFileStateOwnership();
    const directoryA = fileDirectoryScope("project_1", "library_1", "a");
    const directoryB = fileDirectoryScope("project_1", "library_1", "b");
    const readB = ownership.beginRead(directoryB);

    ownership.beginMutation([directoryA]);

    assert.equal(ownership.finishRead(readB).apply, true);
  });

  it("normalizes directory and detail scopes before fencing reads", () => {
    const ownership = createFileStateOwnership();
    const read = ownership.beginRead(
      fileDetailScope("project_1", "library_1", "reports/brief.txt")
    );

    ownership.beginMutation([
      fileDetailScope("project_1", "library_1", "reports//brief.txt")
    ]);

    assert.equal(ownership.finishRead(read).apply, false);
  });

  it("rejects old detail and preview reads after overwrite or delete admission", () => {
    const ownership = createFileStateOwnership();
    const directory = fileDirectoryScope("project_1", "library_1", "reports");
    const detail = fileDetailScope("project_1", "library_1", "reports/brief.txt");

    const beforeOverwrite = ownership.beginRead(detail);
    const overwrite = ownership.beginMutation([directory, detail]);
    assert.equal(ownership.finishRead(beforeOverwrite).apply, false);
    assert.equal(ownership.finishMutation(overwrite), true);

    const beforeDelete = ownership.beginRead(detail);
    ownership.beginMutation([directory, detail]);
    assert.equal(ownership.finishRead(beforeDelete).apply, false);
  });

  it("keeps access revocation from being overwritten by old lists", () => {
    const ownership = createFileStateOwnership();
    const libraries = fileLibraryCollectionScope("project_1");
    const directory = fileDirectoryScope("project_1", "library_1", "");
    let libraryCanWrite = true;
    let entryCanDelete = true;

    const oldLibraries = ownership.beginRead(libraries);
    const oldDirectory = ownership.beginRead(directory);
    const revocation = ownership.beginMutation([libraries, directory]);
    assert.equal(ownership.finishMutation(revocation), true);
    libraryCanWrite = false;
    entryCanDelete = false;

    if (ownership.finishRead(oldLibraries).apply) libraryCanWrite = true;
    if (ownership.finishRead(oldDirectory).apply) entryCanDelete = true;
    assert.equal(libraryCanWrite, false);
    assert.equal(entryCanDelete, false);
  });

  it("does not let stale read completion settle a newer load", () => {
    const ownership = createFileStateOwnership();
    const directory = fileDirectoryScope("project_1", "library_1", "");
    const first = ownership.beginRead(directory);
    const latest = ownership.beginRead(directory);

    assert.equal(ownership.isLoading(directory), true);
    assert.deepEqual(ownership.finishRead(first), {
      apply: false,
      loadingReadRemains: true
    });
    assert.equal(ownership.isLoading(directory), true);
    assert.deepEqual(ownership.finishRead(latest), {
      apply: true,
      loadingReadRemains: false
    });
    assert.equal(ownership.isLoading(directory), false);
  });

  it("settles a read rejected during a failed mutation without a follow-up refresh", () => {
    const ownership = createFileStateOwnership();
    const directory = fileDirectoryScope("project_1", "library_1", "");
    const mutation = ownership.beginMutation([directory], "file-write");
    const read = ownership.beginRead(directory);
    let visibleLoading = true;
    let convergenceRefreshes = 0;

    const settlement = ownership.finishRead(read);
    if (!settlement.loadingReadRemains) visibleLoading = false;
    assert.deepEqual(settlement, {
      apply: false,
      loadingReadRemains: false
    });

    assert.equal(ownership.finishMutation(mutation), true);
    assert.deepEqual(ownership.finishAttempt(mutation), {
      released: true,
      attemptsRemain: false
    });
    assert.equal(visibleLoading, false);
    assert.equal(convergenceRefreshes, 0);
  });

  it("settles a loading scope as soon as a mutation invalidates its read", () => {
    const ownership = createFileStateOwnership();
    const libraries = fileLibraryCollectionScope("project_1");
    ownership.beginRead(libraries);

    ownership.beginMutation([libraries]);

    assert.equal(ownership.isLoading(libraries), false);
  });
});
