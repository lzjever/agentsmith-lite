import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import type { FileLibrary } from "../../packages/contracts/src/api.js";
import type { PersistedAgentTask } from "../../packages/ports/src/store.js";

describe("file library store", () => {
  it("enforces project-scoped names and immutable root paths", async () => {
    const store = createLocalInMemoryProductStore();
    const first = library({ id: "library_one", name: "Working set", rootSubPath: "libraries/library_one/home" });
    const duplicateName = library({ id: "library_two", name: " working SET ", rootSubPath: "libraries/library_two/home" });

    assert.deepEqual(await store.createFileLibrary(first), first);
    assert.equal(await store.createFileLibrary(duplicateName), null);
    assert.deepEqual(await store.listFileLibrariesForProject("project_one"), [first]);

    const renamed = await store.renameFileLibrary("project_one", first.id, "Research", first.updatedAt, "2026-07-19T01:00:00.000Z");
    assert.equal(renamed?.name, "Research");
    assert.equal(renamed?.rootSubPath, first.rootSubPath);
    assert.equal(await store.renameFileLibrary("project_one", first.id, "Stale", first.updatedAt, "2026-07-19T02:00:00.000Z"), null);
  });

  it("exclusively binds a same-scope library and releases it only on task deletion", async () => {
    const store = createLocalInMemoryProductStore();
    const first = library({ id: "library_one" });
    const otherProject = library({ id: "library_other", projectId: "project_other" });
    await store.createFileLibrary(first);
    await store.createFileLibrary(otherProject);

    const created = await store.createTaskAtomically({ task: task({ fileLibraryId: first.id }), reserveActive: false });
    assert.equal(created.kind,"created");
    assert.equal(created.kind==="created"?created.task.fileLibraryId:null,first.id);
    assert.deepEqual(await store.findTaskBoundToFileLibrary(first.id), { kind: "bound", task: { id: "task_one", title: "Task" } });
    assert.deepEqual(await store.createTaskAtomically({ task: task({ id: "task_two", fileLibraryId: first.id }), reserveActive: false }),{kind:"already_bound"});
    assert.deepEqual(await store.createTaskAtomically({ task: task({ id: "task_cross", fileLibraryId: otherProject.id }), reserveActive: false }),{kind:"library_not_found"});

    const archived = await store.archiveTask("task_one", "2026-07-19T01:00:00.000Z");
    assert.equal(archived?.fileLibraryId, first.id);
    assert.equal((await store.findTaskBoundToFileLibrary(first.id)).kind, "bound");
    const deleted = await store.deleteTaskData("task_one", "2026-07-19T02:00:00.000Z");
    assert.equal(deleted?.task.fileLibraryId, null);
    assert.deepEqual(await store.findTaskBoundToFileLibrary(first.id), { kind: "unbound" });
  });

  it("returns exact new-library name and capacity outcomes without leaving a Library",async()=>{
    const store=createLocalInMemoryProductStore();
    await store.createFileLibrary(library({id:"library_existing",name:"Taken"}));
    const generated=library({id:"library_generated",name:" taken ",rootSubPath:"libraries/library_generated/home"});
    assert.deepEqual(await store.createTaskAtomically({task:task({fileLibraryId:generated.id}),newFileLibrary:generated,reserveActive:false}),{kind:"library_name_conflict"});
    assert.equal(await store.findFileLibrary(generated.id),null);

    await store.createProjectResourcePolicy({projectId:"project_one",activeTasksLimit:0,providerRequestsLimit:null,providerTokensLimit:null,providerCostLimit:null,projectFileBytesLimit:null,createdAt:generated.createdAt,updatedAt:generated.updatedAt});
    await store.upsertProjectResourceUsage({projectId:"project_one",activeTasks:0,providerRequests:0,providerTokens:0,providerCost:0,projectFileBytes:0,updatedAt:generated.updatedAt});
    const available=library({id:"library_available",name:"Available",rootSubPath:"libraries/library_available/home"});
    assert.deepEqual(await store.createTaskAtomically({task:task({fileLibraryId:available.id}),newFileLibrary:available,reserveActive:true}),{kind:"capacity_rejected"});
    assert.equal(await store.findFileLibrary(available.id),null);
  });
});

function task(overrides: Partial<PersistedAgentTask> = {}): PersistedAgentTask {
  const timestamp = "2026-07-19T00:00:00.000Z";
  return {
    id: "task_one", workspaceId: "workspace_one", projectId: "project_one", endpointId: "endpoint_one",
    fileLibraryId: "library_one", title: "Task", prompt: "prompt", status: "completed", runId: "run_one",
    executionMode: "dry-run", sandbox: { namespace: "agentsmith", resources: [] }, terminalReason: "not_executed",
    cleanupStatus: "completed", createdAt: timestamp, updatedAt: timestamp, ...overrides
  };
}

function library(overrides: Partial<FileLibrary>): FileLibrary {
  return {
    id: "library_one",
    workspaceId: "workspace_one",
    projectId: "project_one",
    name: "Library",
    rootSubPath: "libraries/library_one/home",
    createdByUserId: "user_one",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides
  };
}
