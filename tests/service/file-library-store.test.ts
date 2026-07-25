import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import type { FileLibrary } from "../../packages/contracts/src/api.js";
import type { PersistedAgentTask, PersistedSandboxRunState } from "../../packages/ports/src/store.js";

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
    await store.createProject(project());
    const first = library({ id: "library_one" });
    const otherProject = library({ id: "library_other", projectId: "project_other" });
    await store.createFileLibrary(first);
    await store.createFileLibrary(otherProject);

    const taskWithRun=task({fileLibraryId:first.id,currentRunId:"run_one"});
    const created = await store.createTaskAtomically({task:taskWithRun,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},sandboxRun:releasedRun(taskWithRun)});
    assert.equal(created.kind,"created");
    assert.equal(created.kind==="created"?created.task.fileLibraryId:null,first.id);
    assert.deepEqual(await store.findTaskBoundToFileLibrary(first.id), { kind: "bound", task: { id: "task_one", title: "Task" } });
    assert.deepEqual(await store.createTaskAtomically({ task: task({ id: "task_two", fileLibraryId: first.id }), reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100} }),{kind:"already_bound"});
    assert.deepEqual(await store.createTaskAtomically({ task: task({ id: "task_cross", fileLibraryId: otherProject.id }), reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100} }),{kind:"library_not_found"});

    const archived = await store.archiveTask("task_one", "2026-07-19T01:00:00.000Z");
    assert.equal(archived.kind==="ready"?archived.value.fileLibraryId:null, first.id);
    assert.equal((await store.findTaskBoundToFileLibrary(first.id)).kind, "bound");
    const deleted = await store.beginTaskDeletion("task_one", "2026-07-19T02:00:00.000Z");
    assert.equal(deleted.kind==="ready"?deleted.value.fileLibraryId:"unexpected", first.id);
    assert.equal(deleted.kind==="ready"?deleted.value.currentRunId:"unexpected", "run_one");
    assert.equal((await store.findTaskBoundToFileLibrary(first.id)).kind,"bound");
    assert.equal((await store.createTaskAtomically({task:task({id:"task_reused",fileLibraryId:first.id}),reserveActive:false,admission:{namespace:"agentsmith",namespaceLimit:100}})).kind,"already_bound");
    assert.equal(await store.purgeDeletedTaskData("task_one"),true);
    assert.equal(await store.findTask("task_one"),null);
    assert.deepEqual(await store.findTaskBoundToFileLibrary(first.id), { kind: "unbound" });
    assert.equal((await store.createTaskAtomically({task:task({id:"task_reused",fileLibraryId:first.id}),reserveActive:false,admission:{namespace:"agentsmith",namespaceLimit:100}})).kind,"created");
    assert.deepEqual(await store.findFileLibrary(first.id),first);
  });

  it("lets only one concurrent Task bind a Library",async()=>{
    const store=createLocalInMemoryProductStore();
    await store.createProject(project());
    await store.createFileLibrary(library({id:"library_race"}));
    const results=await Promise.all([
      store.createTaskAtomically({task:task({id:"task_race_one",fileLibraryId:"library_race"}),reserveActive:false,admission:{namespace:"agentsmith",namespaceLimit:100}}),
      store.createTaskAtomically({task:task({id:"task_race_two",fileLibraryId:"library_race"}),reserveActive:false,admission:{namespace:"agentsmith",namespaceLimit:100}})
    ]);
    assert.deepEqual(results.map((result)=>result.kind).sort(),["already_bound","created"]);
  });

  it("returns exact new-library name and capacity outcomes without leaving a Library",async()=>{
    const store=createLocalInMemoryProductStore();
    await store.createProject(project());
    await store.createFileLibrary(library({id:"library_existing",name:"Taken"}));
    const generated=library({id:"library_generated",name:" taken ",rootSubPath:"libraries/library_generated/home"});
    assert.deepEqual(await store.createTaskAtomically({task:task({fileLibraryId:generated.id}),newFileLibrary:generated,reserveActive:false,admission:{namespace:"agentsmith",namespaceLimit:100}}),{kind:"library_name_conflict"});
    assert.equal(await store.findFileLibrary(generated.id),null);

  });
});

function task(overrides: Partial<PersistedAgentTask> = {}): PersistedAgentTask {
  const timestamp = "2026-07-19T00:00:00.000Z";
  return {
    id: "task_one", workspaceId: "workspace_one", projectId: "project_one", endpointId: "endpoint_one",
    fileLibraryId: "library_one", title: "Task", prompt: "prompt", currentRunId:null,
    archivedAt:null,deletedAt:null,createdAt: timestamp, updatedAt: timestamp, ...overrides
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

function project() {
  return {
    id: "project_one",
    workspaceId: "workspace_one",
    name: "Project",
    ownerUserId: "user_one",
    rootPath: "workspaces/workspace_one/projects/project_one",
    taskConcurrencyLimit: 2,
    lifecycleStatus: "active" as const,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

function releasedRun(task:PersistedAgentTask):PersistedSandboxRunState {
  const timestamp="2026-07-19T00:00:00.000Z";
  return {
    workspaceId:task.workspaceId,projectId:task.projectId,taskId:task.id,runId:task.currentRunId!,
    namespace:"agentsmith",state:"released",image:"botified:test",pvcName:"files",
    projectSubPath:`workspaces/${task.workspaceId}/projects/${task.projectId}`,
    fileLibraryRootSubPath:`libraries/${task.fileLibraryId}/home`,fileLibraryId:task.fileLibraryId!,
    startedByUserId:"user_one",startedAt:timestamp,startupReadyAt:timestamp,startupActionDeadlineAt:null,botifiedPort:3099,
    resourceNames:{pod:"pod-task-one",service:"service-task-one",configMap:"config-task-one",secret:"secret-task-one",serviceAccount:"account-task-one",networkPolicy:"policy-task-one"},
    serviceKeySecretRef:{name:"secret-task-one",key:"BOTIFIED_SERVICE_KEY"},
    directories:{libraryHome:"/workspace/library",botified:"/workspace/botified"},
    resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},
    resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},
    failureCode:null,failureCause:null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,
    releaseReason:"requested",releaseRequestedAt:timestamp,failedAt:null,releasedAt:timestamp,createdAt:timestamp,updatedAt:timestamp
  };
}
