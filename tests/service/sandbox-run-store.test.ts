import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import type { AtomicTaskMessageInput, PersistedSandboxRunState, PersistedTaskMessage } from "../../packages/ports/src/store.js";

describe("sandbox Run store", () => {
  it("stores final Run states without using the JSON document store", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun();

    assert.deepEqual(await store.sandboxRuns.put(run), run);
    assert.deepEqual(await store.sandboxRuns.get(run.runId), run);
    assert.deepEqual((await store.sandboxRuns.listActive()).map((item) => item.runId), [run.runId]);
    assert.equal(await store.jsonDocs.get("sandbox_runtime_state", run.runId), null);
  });

  it("allows only one unreleased Run for a Task", async () => {
    const store=createLocalInMemoryProductStore();
    const first=sandboxRun();
    await store.sandboxRuns.put(first);
    await assert.rejects(
      store.sandboxRuns.put({...first,runId:"run_2",fencingToken:1}),
      /one unreleased sandbox Run/
    );
    const releasedStore=createLocalInMemoryProductStore();
    await releasedStore.sandboxRuns.put({...first,state:"released",releaseReason:"cleanup",releasedAt:runTimestamp(1),fencingToken:2,updatedAt:runTimestamp(1)});
    const second={...first,runId:"run_2",fencingToken:1};
    assert.deepEqual(await releasedStore.sandboxRuns.put(second),second);
  });

  it("keeps the resource identity used by fenced release immutable", async () => {
    const store=createLocalInMemoryProductStore();
    const run=sandboxRun();
    await store.sandboxRuns.put(run);

    await assert.rejects(
      store.sandboxRuns.updateWithFencing(run.runId,run.fencingToken,{
        ...run,
        resourceNames:{...run.resourceNames,pod:"foreign-pod"},
        fencingToken:run.fencingToken+1
      }),
      /immutable attribution/
    );
  });

  it("confirms readiness once and activates only the exact current Run", async () => {
    const store = createLocalInMemoryProductStore();
    const timestamp = runTimestamp(0);
    await store.createUser({ id:"user_1",email:"user@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp });
    await store.createWorkspace({ id:"workspace_1",name:"Workspace",ownerUserId:"user_1",createdAt:timestamp,updatedAt:timestamp });
    await store.createProject({ id:"project_1",workspaceId:"workspace_1",name:"Project",ownerUserId:"user_1",rootPath:"workspaces/workspace_1/projects/project_1",taskConcurrencyLimit:1,createdAt:timestamp,updatedAt:timestamp });
    const task = {
      id:"task_1",workspaceId:"workspace_1",projectId:"project_1",endpointId:"endpoint_1",
      fileLibraryId:"library_1",createdByUserId:"user_1",title:"Task",prompt:"Work",
      agentContext:"",currentRunId:"run_1",archivedAt:null,deletedAt:null,createdAt:timestamp,updatedAt:timestamp
    };
    const run = sandboxRun();
    const created=await store.createTaskAtomically({
      task,
      reserveActive:true,
      newFileLibrary:{id:"library_1",workspaceId:"workspace_1",projectId:"project_1",name:"Library",rootSubPath:"libraries/library_1/home",createdByUserId:"user_1",createdAt:timestamp,updatedAt:timestamp},
      sandboxRun:run
    });
    assert.equal(created.kind,"created");

    const startupClaimToken="startup_claim_1";
    assert.equal((await store.runSandboxStartupOperation({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken:startupClaimToken,claimedAt:runTimestamp(0),leaseExpiresAt:runTimestamp(3)
    },async()=>null)).kind,"applied");
    const started = await store.confirmSandboxRunStarted({
      runId:run.runId,expectedFencingToken:run.fencingToken,startupClaimToken,startedAt:runTimestamp(1),
      auditEvent:{id:"audit_started",projectId:run.projectId,actorId:null,subjectUserId:run.startedByUserId,action:"sandbox.started",status:"accepted",resourceKind:"sandbox",resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId},createdAt:runTimestamp(1)}
    });
    assert.notEqual(started.kind,"conflict");
    if(started.kind==="conflict")return;
    assert.equal((await store.confirmSandboxRunStarted({
      runId:run.runId,expectedFencingToken:started.run.fencingToken,startupClaimToken,startedAt:runTimestamp(2),
      auditEvent:{id:"audit_started",projectId:run.projectId,actorId:null,subjectUserId:run.startedByUserId,action:"sandbox.started",status:"accepted",resourceKind:"sandbox",resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId},createdAt:runTimestamp(2)}
    })).kind,"already_started");

    const activated=await store.activateTaskSandboxRun({taskId:run.taskId,runId:run.runId,expectedFencingToken:started.run.fencingToken,activatedAt:runTimestamp(2)});
    assert.equal(activated.kind,"activated");
    assert.equal((await store.sandboxRuns.get(run.runId))?.state,"active");
  });

  it("claims failed cleanup with fencing and rejects a stale writer", async () => {
    const store = createLocalInMemoryProductStore();
    const failed=sandboxRun({
      state:"failed",failureCode:"runner_failed",failureCause:"Botified exited",releaseReason:"failed",
      failedAt:runTimestamp(1),releaseRequestedAt:runTimestamp(1)
    });
    await store.sandboxRuns.put(failed);

    const claimed=await store.sandboxRuns.claimForCleanup({
      runId:failed.runId,expectedFencingToken:failed.fencingToken,claimedAt:runTimestamp(2)
    });
    assert.ok(claimed);
    assert.equal(claimed.cleanupAttempts,1);
    assert.equal(claimed.cleanupClaimedAt,runTimestamp(2));
    assert.equal(await store.sandboxRuns.updateWithFencing(failed.runId,failed.fencingToken,{...claimed,updatedAt:runTimestamp(3)}),null);
  });

  it("recovers cleanup after a crashed startup lease expires", async () => {
    const store=createLocalInMemoryProductStore();
    const run=sandboxRun({
      state:"release_requested",releaseReason:"requested",releaseRequestedAt:runTimestamp(1),
      startupClaimToken:"crashed_startup",startupLeaseExpiresAt:runTimestamp(3)
    });
    await createTaskWithRun(store,run);

    assert.equal(await store.sandboxRuns.claimForCleanup({
      runId:run.runId,expectedFencingToken:run.fencingToken,claimedAt:runTimestamp(2)
    }),null);
    assert.ok(await store.sandboxRuns.claimForCleanup({
      runId:run.runId,expectedFencingToken:run.fencingToken,claimedAt:runTimestamp(3)
    }));
  });

  it("serializes startup writes against release and makes explicit retry immediately cleanup-eligible",async()=>{
    const store=createLocalInMemoryProductStore();
    const run=sandboxRun();
    await createTaskWithRun(store,run);
    let enter!:()=>void,unblock!:()=>void;
    const entered=new Promise<void>((resolve)=>{enter=resolve;});
    const blocked=new Promise<void>((resolve)=>{unblock=resolve;});
    const startupInput={taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,claimToken:"startup_claim",claimedAt:runTimestamp(0),leaseExpiresAt:runTimestamp(3)};
    const startup=store.runSandboxStartupOperation(startupInput,async()=>{enter();await blocked;return"created";});
    await entered;

    const first=await beginRelease(store,"first",run);
    const release=store.requestTaskSandboxRelease(first);
    unblock();
    assert.equal((await startup).kind,"applied");
    assert.equal(await release,"applied");
    assert.deepEqual((await store.queryProjectAuditEvents(run.projectId,{limit:20})).items,[]);
    assert.equal((await store.runSandboxStartupOperation(startupInput,async()=>null)).kind,"conflict");

    const requested=await store.sandboxRuns.get(run.runId);assert.ok(requested);
    const claimed=await store.sandboxRuns.claimForCleanup({runId:run.runId,expectedFencingToken:requested.fencingToken,claimedAt:runTimestamp(2)});assert.ok(claimed);
    assert.equal(await store.sandboxRuns.claimForCleanup({runId:run.runId,expectedFencingToken:claimed.fencingToken,claimedAt:runTimestamp(2)}),null);
    const retry=await beginRelease(store,"retry",claimed);
    assert.equal(await store.requestTaskSandboxRelease(retry),"already_requested");
    const retried=await store.sandboxRuns.get(run.runId);assert.ok(retried);
    assert.equal(retried.cleanupClaimedAt,null);
    assert.ok(await store.sandboxRuns.claimForCleanup({runId:run.runId,expectedFencingToken:retried.fencingToken,claimedAt:runTimestamp(2)}));
  });

  it("atomically reserves only a first Run or a replacement for the exact released Run",async()=>{
    const firstStore=createLocalInMemoryProductStore();
    const firstTask=await createTaskWithoutRun(firstStore);
    const firstRun=sandboxRun({runId:"run_first",createdAt:runTimestamp(1),updatedAt:runTimestamp(1)});
    const firstInput={
      expectedReleasedRunId:null,
      task:{...firstTask,currentRunId:firstRun.runId,updatedAt:runTimestamp(1)},
      runtimeState:{botifiedBaseUrl:"http://first-task"},
      sandboxRun:firstRun,
      reservedAt:runTimestamp(1)
    };
    assert.equal((await firstStore.restartTaskSandboxAtomically({
      ...firstInput,
      sandboxRun:{...firstRun,projectId:"project_other"}
    })).kind,"conflict");
    assert.equal((await firstStore.findProjectResourceUsage(firstTask.projectId))?.activeTasks,0);
    assert.equal((await firstStore.restartTaskSandboxAtomically(firstInput)).kind,"restarted");
    assert.equal((await firstStore.findTask(firstTask.id))?.currentRunId,firstRun.runId);
    assert.equal((await firstStore.findProjectResourceUsage(firstTask.projectId))?.activeTasks,1);
    assert.equal((await firstStore.listTaskMessages(firstTask.id)).length,0);
    assert.equal((await firstStore.restartTaskSandboxAtomically(firstInput)).kind,"conflict");
    assert.equal((await firstStore.findProjectResourceUsage(firstTask.projectId))?.activeTasks,1);
    const capacityTask={...firstTask,id:"task_capacity",fileLibraryId:"library_capacity"};
    assert.equal((await firstStore.createTaskAtomically({
      task:capacityTask,
      reserveActive:false,
      newFileLibrary:{id:"library_capacity",workspaceId:capacityTask.workspaceId,projectId:capacityTask.projectId,name:"Capacity",rootSubPath:"libraries/library_capacity/home",createdByUserId:capacityTask.createdByUserId!,createdAt:capacityTask.createdAt,updatedAt:capacityTask.updatedAt}
    })).kind,"created");
    const capacityRun={...firstRun,taskId:capacityTask.id,runId:"run_capacity",fileLibraryId:"library_capacity",fileLibraryRootSubPath:"libraries/library_capacity/home"};
    assert.equal((await firstStore.restartTaskSandboxAtomically({
      ...firstInput,
      task:{...capacityTask,currentRunId:capacityRun.runId},
      sandboxRun:capacityRun
    })).kind,"capacity_rejected");
    assert.equal((await firstStore.findTask(capacityTask.id))?.currentRunId,null);
    assert.equal(await firstStore.sandboxRuns.get(capacityRun.runId),null);
    assert.equal((await firstStore.findProjectResourceUsage(firstTask.projectId))?.activeTasks,1);

    const restartStore=createLocalInMemoryProductStore();
    const released=sandboxRun({state:"released",releaseReason:"requested",releaseRequestedAt:runTimestamp(1),releasedAt:runTimestamp(2),fencingToken:2,updatedAt:runTimestamp(2)});
    const restartTask=await createTaskWithRun(restartStore,released);
    const replacementRun=sandboxRun({runId:"run_restarted",createdAt:runTimestamp(3),updatedAt:runTimestamp(3)});
    const restartInput={
      expectedReleasedRunId:released.runId,
      task:{...restartTask,currentRunId:replacementRun.runId,updatedAt:runTimestamp(3)},
      runtimeState:{botifiedBaseUrl:"http://restarted-task"},
      sandboxRun:replacementRun,
      reservedAt:runTimestamp(3)
    };
    assert.equal((await restartStore.restartTaskSandboxAtomically(restartInput)).kind,"restarted");
    assert.equal((await restartStore.findTask(restartTask.id))?.currentRunId,replacementRun.runId);
    assert.equal((await restartStore.findProjectResourceUsage(restartTask.projectId))?.activeTasks,1);
    assert.equal((await restartStore.listTaskMessages(restartTask.id)).length,0);

    const missingStore=createLocalInMemoryProductStore();
    const missingTask=await createTaskWithoutRun(missingStore);
    await missingStore.updateTask({...missingTask,currentRunId:"run_missing"});
    assert.equal((await missingStore.restartTaskSandboxAtomically({
      ...firstInput,
      expectedReleasedRunId:"run_missing",
      task:{...missingTask,currentRunId:"run_after_missing"},
      sandboxRun:{...firstRun,runId:"run_after_missing"}
    })).kind,"conflict");
    assert.equal((await missingStore.findProjectResourceUsage(missingTask.projectId))?.activeTasks,0);

    const staleStore=createLocalInMemoryProductStore();
    const currentReleased=sandboxRun({runId:"run_current",state:"released",releaseReason:"requested",releaseRequestedAt:runTimestamp(1),releasedAt:runTimestamp(2)});
    const staleTask=await createTaskWithRun(staleStore,currentReleased);
    const staleReleased={...currentReleased,runId:"run_stale",resourceNames:{...currentReleased.resourceNames,pod:"task-stale"}};
    await staleStore.sandboxRuns.put(staleReleased);
    assert.equal((await staleStore.restartTaskSandboxAtomically({
      ...restartInput,
      expectedReleasedRunId:staleReleased.runId,
      task:{...staleTask,currentRunId:"run_after_stale"},
      sandboxRun:{...replacementRun,runId:"run_after_stale"}
    })).kind,"conflict");
    assert.equal((await staleStore.findProjectResourceUsage(staleTask.projectId))?.activeTasks,0);

    const runningStore=createLocalInMemoryProductStore();
    const running=sandboxRun();
    const runningTask=await createTaskWithRun(runningStore,running);
    assert.equal((await runningStore.restartTaskSandboxAtomically({
      ...restartInput,
      expectedReleasedRunId:running.runId,
      task:{...runningTask,currentRunId:"run_after_running"},
      sandboxRun:{...replacementRun,runId:"run_after_running"}
    })).kind,"conflict");
    assert.equal((await runningStore.findProjectResourceUsage(runningTask.projectId))?.activeTasks,1);
  });

  it("reclaims a message lease with the persisted message identity and no duplicate audit",async()=>{
    const store=createLocalInMemoryProductStore();
    const task=await createTaskWithoutRun(store);
    const run=sandboxRun({runId:"run_message",createdAt:runTimestamp(1),updatedAt:runTimestamp(1)});
    const first=atomicMessage(task,run,"message_original","message_candidate",runTimestamp(0),runTimestamp(1),"claim_first");

    const created=await store.createTaskMessageAtomically(first);
    assert.equal(created.kind,"created");
    assert.equal(created.kind==="created"?created.message.id:null,"message_original");
    assert.equal(created.kind==="created"?created.message.deliveryKey:null,"delivery_message_message_original");

    const reclaimed=await store.createTaskMessageAtomically({
      ...first,
      message:{...first.message,id:"message_retry",deliveryKey:"delivery_message_message_retry"},
      idempotency:{...first.idempotency,resourceId:"message_retry",claimToken:"claim_retry",now:runTimestamp(2),leaseExpiresAt:runTimestamp(3)}
    });
    assert.equal(reclaimed.kind,"created");
    assert.equal(reclaimed.kind==="created"?reclaimed.message.id:null,"message_original");
    assert.deepEqual((await store.listTaskMessages(task.id)).map((message)=>message.id),["message_original"]);
    assert.equal(((await store.queryProjectAuditEvents(task.projectId,{limit:100})).items).filter((event)=>event.action==="task.message.create").length,1);
  });

  it("rejects archive and deletion while any Task Run remains unreleased",async()=>{
    const store=createLocalInMemoryProductStore();
    const released=sandboxRun({state:"released",releaseReason:"requested",releaseRequestedAt:runTimestamp(1),releasedAt:runTimestamp(2)});
    const task=await createTaskWithRun(store,released);
    await store.sandboxRuns.put(sandboxRun({runId:"run_orphan",taskId:task.id}));

    assert.equal((await store.archiveTask(task.id,runTimestamp(3))).kind,"sandbox_not_released");
    assert.equal((await store.beginTaskDeletion(task.id,runTimestamp(3))).kind,"sandbox_not_released");
  });
});

async function createTaskWithRun(store:ReturnType<typeof createLocalInMemoryProductStore>,run:PersistedSandboxRunState){
  const timestamp=runTimestamp(0);
  await store.createUser({id:run.startedByUserId,email:"runner@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp});
  await store.createWorkspace({id:run.workspaceId,name:"Workspace",ownerUserId:run.startedByUserId,createdAt:timestamp,updatedAt:timestamp});
  await store.createProject({id:run.projectId,workspaceId:run.workspaceId,name:"Project",ownerUserId:run.startedByUserId,rootPath:run.projectSubPath,taskConcurrencyLimit:1,createdAt:timestamp,updatedAt:timestamp});
  const task={id:run.taskId,workspaceId:run.workspaceId,projectId:run.projectId,endpointId:"endpoint_1",fileLibraryId:run.fileLibraryId,createdByUserId:run.startedByUserId,title:"Task",prompt:"Work",agentContext:"",currentRunId:run.runId,archivedAt:null,deletedAt:null,createdAt:timestamp,updatedAt:timestamp};
  const created=await store.createTaskAtomically({task,reserveActive:run.state!=="released",newFileLibrary:{id:run.fileLibraryId,workspaceId:run.workspaceId,projectId:run.projectId,name:"Library",rootSubPath:run.fileLibraryRootSubPath,createdByUserId:run.startedByUserId,createdAt:timestamp,updatedAt:timestamp},sandboxRun:run});
  assert.equal(created.kind,"created");
  return task;
}

async function createTaskWithoutRun(store:ReturnType<typeof createLocalInMemoryProductStore>){
  const run=sandboxRun();
  const timestamp=runTimestamp(0);
  await store.createUser({id:run.startedByUserId,email:"runner@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp});
  await store.createWorkspace({id:run.workspaceId,name:"Workspace",ownerUserId:run.startedByUserId,createdAt:timestamp,updatedAt:timestamp});
  await store.createProject({id:run.projectId,workspaceId:run.workspaceId,name:"Project",ownerUserId:run.startedByUserId,rootPath:run.projectSubPath,taskConcurrencyLimit:1,createdAt:timestamp,updatedAt:timestamp});
  const task={id:run.taskId,workspaceId:run.workspaceId,projectId:run.projectId,endpointId:"endpoint_1",fileLibraryId:run.fileLibraryId,createdByUserId:run.startedByUserId,title:"Task",prompt:"Work",agentContext:"",currentRunId:null,archivedAt:null,deletedAt:null,createdAt:timestamp,updatedAt:timestamp};
  const created=await store.createTaskAtomically({task,reserveActive:false,newFileLibrary:{id:run.fileLibraryId,workspaceId:run.workspaceId,projectId:run.projectId,name:"Library",rootSubPath:run.fileLibraryRootSubPath,createdByUserId:run.startedByUserId,createdAt:timestamp,updatedAt:timestamp}});
  assert.equal(created.kind,"created");
  return task;
}

async function beginRelease(store:ReturnType<typeof createLocalInMemoryProductStore>,key:string,current:PersistedSandboxRunState){
  const now=runTimestamp(2),claimToken=`claim_${key}`,requestHash=`hash_${key}`;
  const ownership={actorId:current.startedByUserId,projectId:current.projectId,operation:"release-sandbox" as const,key,requestHash,resourceId:current.runId,claimToken,now,leaseExpiresAt:runTimestamp(4)};
  assert.equal((await store.beginTaskIdempotency(ownership)).kind,"claimed");
  return{runId:current.runId,taskId:current.taskId,expectedFencingToken:current.fencingToken,run:{...current,state:"release_requested" as const,releaseReason:current.releaseReason??"requested",releaseRequestedAt:current.releaseRequestedAt??now,startupClaimToken:null,startupLeaseExpiresAt:null,cleanupClaimedAt:null,lastCleanupError:null,fencingToken:current.fencingToken+1,updatedAt:now},idempotency:{actorId:ownership.actorId,projectId:ownership.projectId,operation:ownership.operation,key,requestHash,claimToken,responseStatus:200,responseBody:{ok:true},updatedAt:now}};
}

function sandboxRun(overrides: Partial<PersistedSandboxRunState> = {}): PersistedSandboxRunState {
  return {
    workspaceId:"workspace_1",projectId:"project_1",taskId:"task_1",runId:"run_1",
    namespace:"agentsmith",state:"starting",image:"agentsmith-lite/botified-runner:test",
    pvcName:"agentsmith-lite-files",projectSubPath:"workspaces/workspace_1/projects/project_1",
    fileLibraryRootSubPath:"libraries/library_1/home",fileLibraryId:"library_1",
    startedByUserId:"user_1",startedAt:null,botifiedPort:3099,
    resourceNames:{pod:"task-1",service:"task-1",configMap:"task-1-config",secret:"task-1-secret",serviceAccount:"task-1",networkPolicy:"task-1"},
    serviceKeySecretRef:{name:"task-1-secret",key:"BOTIFIED_SERVICE_KEY"},
    directories:{libraryHome:"/workspace/task/home",botified:"/workspace/task/botified"},
    resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},
    resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},
    failureCode:null,failureCause:null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,
    releaseReason:null,releaseRequestedAt:null,failedAt:null,releasedAt:null,
    createdAt:runTimestamp(0),updatedAt:runTimestamp(0),...overrides
  };
}

function atomicMessage(
  task:Awaited<ReturnType<typeof createTaskWithoutRun>>,
  run:PersistedSandboxRunState,
  resourceId:string,
  candidateId:string,
  now:string,
  leaseExpiresAt:string,
  claimToken:string
):AtomicTaskMessageInput {
  const message:PersistedTaskMessage={
    id:candidateId,
    taskId:task.id,
    actorId:run.startedByUserId,
    content:"continue",
    deliveryKey:`delivery_message_${candidateId}`,
    requestHash:"delivery_hash",
    claimToken:null,
    receipt:null,
    timelineCursor:null,
    deliveryStatus:"pending",
    claimedAt:null,
    leaseExpiresAt:null,
    attemptCount:0,
    nextRetryAt:null,
    safeError:null,
    createdAt:now,
    updatedAt:now,
    deletedAt:null
  };
  return {
    taskId:task.id,
    expectedCurrentRunId:null,
    message,
    idempotency:{actorId:run.startedByUserId,projectId:task.projectId,operation:"message",key:"message-key",requestHash:"message-hash",resourceId,claimToken,now,leaseExpiresAt},
    auditEvent:{id:`audit_task_message_create_${candidateId}`,projectId:task.projectId,actorId:run.startedByUserId,action:"task.message.create",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,messageId:candidateId,deliveryStatus:"pending"},createdAt:now},
    restart:{task:{...task,currentRunId:run.runId,updatedAt:run.updatedAt},runtimeState:{botifiedBaseUrl:"http://task"},sandboxRun:run,reservedAt:run.updatedAt}
  };
}

function runTimestamp(minute:number):string {
  return `2026-07-23T00:${String(minute).padStart(2,"0")}:00.000Z`;
}
