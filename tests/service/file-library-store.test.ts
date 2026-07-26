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
    assert.equal((await store.beginFileLibraryDeletion({libraryId:first.id,idempotency:deletionReceipt("bound-active","bound-request",`file-library-delete:${first.id}`,"bound-active-claim")})).kind,"bound");
    assert.deepEqual(await store.createTaskAtomically({ task: task({ id: "task_two", fileLibraryId: first.id }), reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100} }),{kind:"already_bound"});
    assert.deepEqual(await store.createTaskAtomically({ task: task({ id: "task_cross", fileLibraryId: otherProject.id }), reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100} }),{kind:"library_not_found"});

    const archived = await store.archiveTask("task_one", "2026-07-19T01:00:00.000Z");
    assert.equal(archived.kind==="ready"?archived.value.fileLibraryId:null, first.id);
    assert.equal((await store.findTaskBoundToFileLibrary(first.id)).kind, "bound");
    assert.equal((await store.beginFileLibraryDeletion({libraryId:first.id,idempotency:deletionReceipt("bound-archived","bound-request",`file-library-delete:${first.id}`,"bound-archived-claim")})).kind,"bound");
    const deleted = await store.beginTaskDeletion("task_one", "2026-07-19T02:00:00.000Z");
    assert.equal(deleted.kind==="ready"?deleted.value.fileLibraryId:"unexpected", first.id);
    assert.equal(deleted.kind==="ready"?deleted.value.currentRunId:"unexpected", "run_one");
    assert.equal((await store.findTaskBoundToFileLibrary(first.id)).kind,"bound");
    assert.equal((await store.beginFileLibraryDeletion({libraryId:first.id,idempotency:deletionReceipt("bound-tombstone","bound-request",`file-library-delete:${first.id}`,"bound-tombstone-claim")})).kind,"bound");
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

  it("reclaims an expired create operation with its persisted Task ID",async()=>{
    const store=createLocalInMemoryProductStore();
    await store.createProject(project());
    const persisted=task({id:"task_persisted",fileLibraryId:"library_persisted"});
    const idempotency={
      actorId:"user_one",
      projectId:"project_one",
      operation:"create" as const,
      key:"expired-task-create",
      requestHash:"expired-task-create-request",
      resourceId:persisted.id,
      claimToken:"expired-task-create-first",
      now:"2026-07-19T00:00:00.000Z",
      leaseExpiresAt:"2026-07-19T00:01:00.000Z"
    };
    assert.equal((await store.createTaskAtomically({
      task:persisted,
      newFileLibrary:library({id:"library_persisted"}),
      reserveActive:false,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      idempotency
    })).kind,"created");

    const replacement=task({id:"task_replacement",fileLibraryId:"library_replacement"});
    const reclaimed=await store.createTaskAtomically({
      task:replacement,
      newFileLibrary:library({id:"library_replacement"}),
      reserveActive:false,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      idempotency:{
        ...idempotency,
        resourceId:replacement.id,
        claimToken:"expired-task-create-second",
        now:"2026-07-19T00:02:00.000Z",
        leaseExpiresAt:"2026-07-19T00:03:00.000Z"
      }
    });

    assert.equal(reclaimed.kind,"resume");
    if(reclaimed.kind==="resume"){
      assert.equal(reclaimed.task.id,persisted.id);
      assert.equal(reclaimed.claimToken,"expired-task-create-second");
    }
    assert.equal(await store.findTask(replacement.id),null);
    assert.equal(await store.findFileLibrary(replacement.fileLibraryId!),null);
  });

  it("returns the owning create claim with deterministic store rejections",async()=>{
    const store=createLocalInMemoryProductStore();
    await store.createProject(project());
    const unavailableTask=task({id:"task_project_unavailable",fileLibraryId:"library_project_unavailable"});
    const unavailableClaim=createReceipt(unavailableTask,"project-unavailable");
    assert.ok(await store.setProjectLifecycleStatus("project_one","archived","2026-07-19T00:01:00.000Z"));

    assert.deepEqual(await store.createTaskAtomically({
      task:unavailableTask,
      newFileLibrary:library({id:unavailableTask.fileLibraryId!,name:"Unavailable"}),
      reserveActive:false,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      idempotency:unavailableClaim
    }),{kind:"project_unavailable",claimToken:unavailableClaim.claimToken});
    assert.deepEqual(await store.findTaskIdempotency({
      actorId:unavailableClaim.actorId,
      projectId:unavailableClaim.projectId,
      operation:unavailableClaim.operation,
      key:unavailableClaim.key,
      requestHash:unavailableClaim.requestHash
    }),{kind:"in_progress",resourceId:unavailableTask.id});

    assert.ok(await store.setProjectLifecycleStatus("project_one","active","2026-07-19T00:02:00.000Z"));
    await store.createFileLibrary(library({id:"library_claim_conflict",name:"Taken after prevalidation"}));
    const conflictTask=task({id:"task_library_conflict",fileLibraryId:"library_generated_conflict"});
    const conflictLibrary=library({
      id:conflictTask.fileLibraryId!,
      name:" taken AFTER prevalidation ",
      rootSubPath:"libraries/library_generated_conflict/home"
    });
    const conflictClaim=createReceipt(conflictTask,"library-conflict");

    assert.deepEqual(await store.createTaskAtomically({
      task:conflictTask,
      newFileLibrary:conflictLibrary,
      reserveActive:false,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      idempotency:conflictClaim
    }),{kind:"library_name_conflict",claimToken:conflictClaim.claimToken});
    assert.deepEqual(await store.findTaskIdempotency({
      actorId:conflictClaim.actorId,
      projectId:conflictClaim.projectId,
      operation:conflictClaim.operation,
      key:conflictClaim.key,
      requestHash:conflictClaim.requestHash
    }),{kind:"in_progress",resourceId:conflictTask.id});
  });

  it("serializes Task binding against deletion and fences the physical operation claim", async () => {
    const store = createLocalInMemoryProductStore();
    await store.createProject(project());
    const target = library({ id: "library_delete" });
    await store.createFileLibrary(target);
    const requestHash = "canonical-delete-request";
    const operationId = `file-library-delete:${target.id}`;
    const first = await store.beginFileLibraryDeletion({
      libraryId: target.id,
      idempotency: deletionReceipt("delete-one", requestHash, operationId, "receipt-one")
    });
    assert.equal(first.kind, "claimed");
    assert.equal((await store.findFileLibrary(target.id))?.lifecycleStatus, "deleting");
    assert.equal(
      (await store.createTaskAtomically({
        task: task({ id: "task_lost_race", fileLibraryId: target.id }),
        reserveActive: false,
        admission: { namespace: "agentsmith", namespaceLimit: 100 }
      })).kind,
      "library_deleting"
    );

    assert.equal((await store.claimFileLibraryDeletionOperation({
      projectId: target.projectId,
      libraryId: target.id,
      operationId,
      claimToken: "physical-one",
      now: "2026-07-19T00:01:00.000Z",
      leaseMs:60_000
    })).kind, "claimed");
    assert.equal((await store.claimFileLibraryDeletionOperation({
      projectId: target.projectId,
      libraryId: target.id,
      operationId,
      claimToken: "physical-two",
      now: "2026-07-19T00:01:30.000Z",
      leaseMs:60_000
    })).kind, "in_progress");
    const isolated={phase:"isolated" as const,quarantineDevice:"1",quarantineInode:"2",entryType:"directory" as const,bytes:3};
    const firstOwner={
      projectId:target.projectId,
      libraryId:target.id,
      operationId,
      claimToken:"physical-one"
    };
    assert.equal(await store.persistFileLibraryDeletionOperation(
      firstOwner,
      isolated,
      "2026-07-19T00:01:40.000Z"
    ),true);
    const isolatedTakeover=await store.claimFileLibraryDeletionOperation({
      projectId: target.projectId,
      libraryId: target.id,
      operationId,
      claimToken: "physical-two",
      now: "2026-07-19T00:02:01.000Z",
      leaseMs:60_000
    });
    assert.deepEqual(isolatedTakeover,{kind:"claimed",state:isolated});
    assert.equal(await store.persistFileLibraryDeletionOperation(
      firstOwner,
      {...isolated,phase:"removed"},
      "2026-07-19T00:02:02.000Z"
    ),false);
    const secondOwner={
      projectId:target.projectId,
      libraryId:target.id,
      operationId,
      claimToken:"physical-two"
    };
    assert.equal(await store.persistFileLibraryDeletionOperation(secondOwner,{...isolated,phase:"removed"},"2026-07-19T00:02:03.000Z"),true);
    const removedOwner={
      projectId:target.projectId,
      libraryId:target.id,
      operationId,
      claimToken:"physical-three"
    };
    assert.deepEqual(await store.claimFileLibraryDeletionOperation({
      ...removedOwner,
      now:"2026-07-19T00:03:02.000Z",
      leaseMs:60_000
    }),{kind:"claimed",state:{...isolated,phase:"removed"}});
    assert.equal(await store.finalizeFileLibraryDeletion({
      ...secondOwner,
      requestHash,
      actorId:"user_one",
      responseStatus:200,
      responseBody:{deleted:true},
      updatedAt:"2026-07-19T00:02:04.000Z"
    }),"conflict");
    assert.equal(await store.finalizeFileLibraryDeletion({
      ...removedOwner,
      requestHash,
      actorId:"user_one",
      responseStatus:200,
      responseBody:{deleted:true},
      updatedAt:"2026-07-19T00:02:04.000Z"
    }),"finalized");
    assert.equal((await store.beginFileLibraryDeletion({
      libraryId:target.id,
      idempotency:deletionReceipt("delete-after-response-loss",requestHash,operationId,"receipt-after-loss")
    })).kind,"replay");
    const audits=(await store.queryProjectAuditEvents(target.projectId,{limit:100})).items
      .filter((event)=>event.action==="file_library.delete"&&event.resourceId===target.id);
    assert.equal(audits.length,1);
    assert.deepEqual(audits[0]?.detail,{bytes:3});
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
    lifecycleStatus: "active",
    createdByUserId: "user_one",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides
  };
}

function deletionReceipt(key: string, requestHash: string, resourceId: string, claimToken: string) {
  return {
    actorId: "user_one",
    projectId: "project_one",
    operation: "project.file-library.delete" as const,
    key,
    requestHash,
    resourceId,
    claimToken,
    now: "2026-07-19T00:00:00.000Z",
    leaseExpiresAt: "2026-07-19T00:05:00.000Z"
  };
}

function createReceipt(task:PersistedAgentTask,label:string) {
  return {
    actorId:"user_one",
    projectId:task.projectId,
    operation:"create" as const,
    key:`create-${label}`,
    requestHash:`create-hash-${label}`,
    resourceId:task.id,
    claimToken:`create-claim-${label}`,
    now:"2026-07-19T00:00:00.000Z",
    leaseExpiresAt:"2026-07-19T00:05:00.000Z"
  };
}

function project() {
  return {
    id: "project_one",
    workspaceId: "workspace_one",
    name: "Project",
    ownerUserId: "user_one",
    rootPath: "workspaces/workspace_one/projects/project_one",
    sandboxLimit: 2,
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
