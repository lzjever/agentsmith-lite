import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import type { AtomicTaskMessageInput, CompleteTaskIdempotencyInput, PersistedSandboxRunState, PersistedTaskMessage } from "../../packages/ports/src/store.js";

describe("sandbox Run store", () => {
  it("does not expose raw Run insertion and terminalizes capacity rejection for exact replay",async()=>{
    const store=createLocalInMemoryProductStore();
    assert.equal("put" in store.sandboxRuns,false);
    const occupyingRun=scopedRun("replay_occupying",{
      projectId:"project_replay",
      taskId:"task_replay_occupying",
      runId:"run_replay_occupying",
      fileLibraryId:"library_replay_occupying"
    });
    await createScopedTask(store,occupyingRun,true,1);
    const candidateRun=scopedRun("replay_candidate",{
      projectId:occupyingRun.projectId,
      taskId:"task_replay_candidate",
      runId:"run_replay_candidate",
      fileLibraryId:"library_replay_candidate"
    });
    const now=runTimestamp(2);
    const idempotency={
      actorId:candidateRun.startedByUserId,
      projectId:candidateRun.projectId,
      operation:"create" as const,
      key:"capacity-replay",
      requestHash:"capacity-replay-hash",
      resourceId:candidateRun.taskId,
      claimToken:"capacity-replay-claim",
      now,
      leaseExpiresAt:runTimestamp(4)
    };
    assert.equal((await store.beginTaskIdempotency(idempotency)).kind,"claimed");
    const task={id:candidateRun.taskId,workspaceId:candidateRun.workspaceId,projectId:candidateRun.projectId,endpointId:"endpoint_1",fileLibraryId:candidateRun.fileLibraryId,createdByUserId:candidateRun.startedByUserId,title:"Replay",prompt:"Work",agentContext:"",currentRunId:candidateRun.runId,archivedAt:null,deletedAt:null,createdAt:now,updatedAt:now};
    const input={
      task,
      reserveActive:true,
      admission:{namespace:candidateRun.namespace,namespaceLimit:1},
      idempotency,
      rejectionPresentation:null,
      rejectedAuditEvent:{id:"audit_task_create_replay_candidate",projectId:candidateRun.projectId,actorId:candidateRun.startedByUserId,action:"task.create" as const,status:"rejected" as const,resourceKind:"task" as const,resourceId:candidateRun.taskId,detail:{taskId:candidateRun.taskId,trigger:"task_create" as const},createdAt:now},
      newFileLibrary:{id:candidateRun.fileLibraryId,workspaceId:candidateRun.workspaceId,projectId:candidateRun.projectId,name:"Replay",rootSubPath:candidateRun.fileLibraryRootSubPath,lifecycleStatus:"active" as const,createdByUserId:candidateRun.startedByUserId,createdAt:now,updatedAt:now},
      sandboxRun:candidateRun
    };
    const first=await store.createTaskAtomically(input);
    assert.deepEqual(first,{
      kind:"capacity_rejected",
      admission:{kind:"project_capacity_rejected",activeSandboxes:1,sandboxLimit:1},
      responseStatus:409,
      responseBody:{error:{code:"project_sandbox_capacity_reached",message:"Project Sandbox capacity reached",retryable:true,details:{activeSandboxes:1,sandboxLimit:1},presentation:null}}
    });
    const policy=await store.findProjectResourcePolicy(candidateRun.projectId);
    assert.ok(policy);
    await store.patchProjectResourcePolicy(candidateRun.projectId,{sandboxLimit:2},runTimestamp(3),policy.updatedAt);
    const replay=await store.createTaskAtomically({...input,idempotency:{...idempotency,claimToken:"capacity-replay-claim-2",now:runTimestamp(3),leaseExpiresAt:runTimestamp(5)}});
    assert.deepEqual(replay,{kind:"replay",responseStatus:first.responseStatus,responseBody:first.responseBody});
    assert.equal(await store.findTask(candidateRun.taskId),null);
    assert.equal(await store.findFileLibrary(candidateRun.fileLibraryId),null);
    assert.equal(await store.sandboxRuns.get(candidateRun.runId),null);
    const audits=(await store.queryProjectAuditEvents(candidateRun.projectId,{limit:20})).items.filter((event)=>event.id===input.rejectedAuditEvent.id);
    assert.equal(audits.length,1);
    assert.deepEqual(audits[0]?.detail,{taskId:candidateRun.taskId,trigger:"task_create",scope:"project_policy",activeSandboxes:1,sandboxLimit:1});
  });

  it("stores final Run states without using the JSON document store", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun();

    await createTaskWithRun(store,run);
    assert.deepEqual(await store.sandboxRuns.get(run.runId), run);
    assert.deepEqual((await store.sandboxRuns.listActive()).map((item) => item.runId), [run.runId]);
    assert.equal(await store.jsonDocs.get("sandbox_runtime_state", run.runId), null);
  });

  it("keeps a reservation not ready until the exact Task Run and fence are promoted",async()=>{
    const store=createLocalInMemoryProductStore();
    const run=sandboxRun({startupReadyAt:null});
    await createTaskWithRun(store,run);
    const readinessStore=store as typeof store&{
      markTaskSandboxStartupReady(input:{taskId:string;runId:string;expectedFencingToken:number;readyAt:string}):Promise<PersistedSandboxRunState|null>;
    };
    assert.equal((await store.sandboxRuns.get(run.runId))?.startupReadyAt,null);
    assert.deepEqual(await store.claimSandboxStartup({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken:"not-ready-claim",claimedAt:runTimestamp(0),leaseExpiresAt:runTimestamp(2)
    }),{kind:"not_ready",runId:run.runId});
    assert.equal((await store.sandboxRuns.get(run.runId))?.startupClaimToken??null,null);
    assert.equal(await readinessStore.markTaskSandboxStartupReady({
      taskId:"task_other",runId:run.runId,expectedFencingToken:run.fencingToken,readyAt:runTimestamp(1)
    }),null);
    assert.equal(await readinessStore.markTaskSandboxStartupReady({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken+1,readyAt:runTimestamp(1)
    }),null);
    const ready=await readinessStore.markTaskSandboxStartupReady({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,readyAt:runTimestamp(1)
    });
    assert.equal(ready?.startupReadyAt,runTimestamp(1));
    assert.equal(ready?.fencingToken,run.fencingToken);
    assert.equal((await readinessStore.markTaskSandboxStartupReady({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,readyAt:runTimestamp(2)
    }))?.startupReadyAt,runTimestamp(1));
  });

  it("keeps the resource identity used by fenced release immutable", async () => {
    const store=createLocalInMemoryProductStore();
    const run=sandboxRun();
    await createTaskWithRun(store,run);

    await assert.rejects(
      store.sandboxRuns.updateWithFencing(run.runId,run.fencingToken,{
        ...run,
        resourceNames:{...run.resourceNames,pod:"foreign-pod"},
        fencingToken:run.fencingToken+1
      }),
      /immutable attribution/
    );
  });

  it("keeps one startup claim across independent actions and activates only after final readiness", async () => {
    const store = createLocalInMemoryProductStore();
    const timestamp = runTimestamp(0);
    await store.createUser({ id:"user_1",email:"user@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp });
    await store.createWorkspace({ id:"workspace_1",name:"Workspace",ownerUserId:"user_1",createdAt:timestamp,updatedAt:timestamp });
    await store.createProject({ id:"project_1",workspaceId:"workspace_1",name:"Project",ownerUserId:"user_1",rootPath:"workspaces/workspace_1/projects/project_1",sandboxLimit:1,createdAt:timestamp,updatedAt:timestamp });
    const task = {
      id:"task_1",workspaceId:"workspace_1",projectId:"project_1",endpointId:"endpoint_1",
      fileLibraryId:"library_1",createdByUserId:"user_1",title:"Task",prompt:"Work",
      agentContext:"",currentRunId:"run_1",archivedAt:null,deletedAt:null,createdAt:timestamp,updatedAt:timestamp
    };
    const run = sandboxRun();
    const initialMessage:PersistedTaskMessage={
      id:"message_initial_atomic",taskId:task.id,actorId:"user_1",content:"Work",
      deliveryKey:"delivery_initial_atomic",requestHash:"initial-atomic-hash",
      claimToken:null,receipt:null,timelineCursor:null,deliveryStatus:"pending",
      claimedAt:null,leaseExpiresAt:null,attemptCount:0,nextRetryAt:null,safeError:null,
      createdAt:timestamp,updatedAt:timestamp,deletedAt:null
    };
    const created=await store.createTaskAtomically({
      task,
      reserveActive:true, admission:{namespace:"agentsmith",namespaceLimit:100},
      idempotency:admissionIdempotency(run,"create-confirm"),
      rejectionPresentation:null,
      rejectedAuditEvent:rejectedAdmissionAudit(run,"task_create","create-confirm"),
      newFileLibrary:{id:"library_1",workspaceId:"workspace_1",projectId:"project_1",name:"Library",rootSubPath:"libraries/library_1/home",lifecycleStatus:"active" as const,createdByUserId:"user_1",createdAt:timestamp,updatedAt:timestamp},
      sandboxRun:run,
      initialMessage,
      initialInteractionChange:{
        sourceKind:"product",sourceId:`message:${initialMessage.id}`,sourceRevision:0,
        interaction:{id:"interaction_initial_atomic",revision:1,taskId:task.id,kind:"user_message",title:"You",body:"Work",contentMode:"full",position:0,occurredAt:timestamp,updatedAt:timestamp,actorId:"user_1",status:"pending"}
      }
    });
    assert.equal(created.kind,"created");
    const initialSnapshot=await store.readTaskInteractionSnapshot(task.id,null,20);
    assert.equal(initialSnapshot?.items.some((item)=>item.id==="interaction_initial_atomic"),true);

    const ready=await store.markTaskSandboxStartupReady({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,readyAt:runTimestamp(0)
    });
    assert.ok(ready);
    const startupClaimToken="startup_claim_1";
    assert.equal((await store.claimSandboxStartup({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken:startupClaimToken,claimedAt:runTimestamp(0),leaseExpiresAt:runTimestamp(1)
    })).kind,"claimed");
    assert.equal((await store.sandboxRuns.get(run.runId))?.startupActionDeadlineAt,null);
    const firstDeadline=runTimestamp(2);
    assert.ok(await store.beginSandboxStartupAction({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken:startupClaimToken,actionDeadlineAt:firstDeadline,startedAt:runTimestamp(0)
    }));
    assert.equal((await store.sandboxRuns.get(run.runId))?.startupActionDeadlineAt,firstDeadline);
    assert.ok(await store.completeSandboxStartupAction({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken:startupClaimToken,actionDeadlineAt:firstDeadline,completedAt:runTimestamp(1),leaseExpiresAt:runTimestamp(4)
    }));
    const afterApply=await store.sandboxRuns.get(run.runId);
    assert.equal(afterApply?.startupClaimToken,startupClaimToken);
    assert.equal(afterApply?.startupLeaseExpiresAt,runTimestamp(4));
    assert.equal(afterApply?.startupActionDeadlineAt,null);
    assert.equal(afterApply?.fencingToken,run.fencingToken);
    assert.deepEqual(await store.claimSandboxStartup({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken:"between-actions-takeover",claimedAt:runTimestamp(3),leaseExpiresAt:runTimestamp(5)
    }),{kind:"in_progress",runId:run.runId});

    const readinessDeadline=runTimestamp(5);
    assert.ok(await store.beginSandboxStartupAction({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken:startupClaimToken,actionDeadlineAt:readinessDeadline,startedAt:runTimestamp(3)
    }));
    assert.deepEqual(await store.claimSandboxStartup({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken:"takeover",claimedAt:runTimestamp(6),leaseExpiresAt:runTimestamp(8)
    }),{kind:"in_progress",runId:run.runId});

    const activated=await store.activateTaskSandboxRun({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,
      startupClaimToken,actionDeadlineAt:readinessDeadline,activatedAt:runTimestamp(4),
      auditEvent:{id:"audit_started",projectId:run.projectId,actorId:null,subjectUserId:run.startedByUserId,action:"sandbox.started",status:"accepted",resourceKind:"sandbox",resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId},createdAt:runTimestamp(4)}
    });
    assert.equal(activated.kind,"activated");
    const active=await store.sandboxRuns.get(run.runId);
    assert.equal(active?.state,"active");
    assert.equal(active?.startupClaimToken,null);
    assert.equal(active?.startupActionDeadlineAt,null);
  });

  it("claims failed cleanup with fencing and rejects a stale writer", async () => {
    const store = createLocalInMemoryProductStore();
    const failed=sandboxRun({
      state:"failed",failureCode:"runner_failed",failureCause:"Botified exited",releaseReason:"failed",
      failedAt:runTimestamp(1),releaseRequestedAt:runTimestamp(1)
    });
    await createTaskWithRun(store,failed);

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

  it("commits startup outside the release transaction and drains its action deadline before cleanup",async()=>{
    const store=createLocalInMemoryProductStore();
    const run=sandboxRun();
    await createTaskWithRun(store,run);
    await store.markTaskSandboxStartupReady({taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,readyAt:runTimestamp(0)});
    let enter!:()=>void,unblock!:()=>void;
    const entered=new Promise<void>((resolve)=>{enter=resolve;});
    const blocked=new Promise<void>((resolve)=>{unblock=resolve;});
    const startupInput={taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,claimToken:"startup_claim",claimedAt:runTimestamp(0),leaseExpiresAt:runTimestamp(3),actionDeadlineAt:runTimestamp(3)};
    assert.equal((await store.claimSandboxStartup(startupInput)).kind,"claimed");
    assert.ok(await store.beginSandboxStartupAction({
      taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken:startupInput.claimToken,actionDeadlineAt:startupInput.actionDeadlineAt,startedAt:startupInput.claimedAt
    }));
    const startup=(async()=>{enter();await blocked;return"created";})();
    await entered;

    const first=await beginRelease(store,"first",run);
    const release=store.requestTaskSandboxRelease(first);
    const releasedBeforeOperationReturned=await Promise.race([
      release.then(()=>true),
      new Promise<false>((resolve)=>setTimeout(()=>resolve(false),25))
    ]);
    unblock();
    assert.equal(await startup,"created");
    assert.equal(await release,"applied");
    assert.equal(releasedBeforeOperationReturned,true);
    assert.deepEqual((await store.queryProjectAuditEvents(run.projectId,{limit:20})).items,[]);
    assert.equal((await store.claimSandboxStartup(startupInput)).kind,"stale");

    const requested=await store.sandboxRuns.get(run.runId);assert.ok(requested);
    assert.equal(requested.startupClaimToken,startupInput.claimToken);
    assert.equal(requested.startupActionDeadlineAt,startupInput.actionDeadlineAt);
    assert.equal(await store.sandboxRuns.claimForCleanup({runId:run.runId,expectedFencingToken:requested.fencingToken,claimedAt:runTimestamp(2)}),null);
    const claimed=await store.sandboxRuns.claimForCleanup({runId:run.runId,expectedFencingToken:requested.fencingToken,claimedAt:runTimestamp(3)});assert.ok(claimed);
    assert.equal(await store.sandboxRuns.claimForCleanup({runId:run.runId,expectedFencingToken:claimed.fencingToken,claimedAt:runTimestamp(3)}),null);
    const retry=await beginRelease(store,"retry",claimed);
    assert.equal(await store.requestTaskSandboxRelease(retry),"already_requested");
    const retried=await store.sandboxRuns.get(run.runId);assert.ok(retried);
    assert.equal(retried.cleanupClaimedAt,null);
    assert.ok(await store.sandboxRuns.claimForCleanup({runId:run.runId,expectedFencingToken:retried.fencingToken,claimedAt:runTimestamp(3)}));
  });

  it("atomically fails a terminal startup and completes its exact failure receipt",async()=>{
    const store=createLocalInMemoryProductStore();
    const run=sandboxRun();
    await createTaskWithRun(store,run);
    const timestamp=runTimestamp(1);
    const claim={
      actorId:run.startedByUserId,
      projectId:run.projectId,
      operation:"terminal-start" as const,
      key:"terminal-startup-failure",
      requestHash:"terminal-startup-failure-hash",
      resourceId:run.runId,
      claimToken:"terminal-startup-failure-claim",
      now:timestamp,
      leaseExpiresAt:runTimestamp(3)
    };
    assert.equal((await store.beginTaskIdempotency(claim)).kind,"claimed");
    assert.deepEqual(await store.findInProgressTerminalStartOperation(run.runId),{
      actorId:claim.actorId,
      projectId:claim.projectId,
      operation:"terminal-start",
      key:claim.key,
      requestHash:claim.requestHash,
      resourceId:run.runId,
      claimToken:claim.claimToken
    });
    assert.ok(await store.markTaskSandboxStartupReady({taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,readyAt:timestamp}));
    assert.equal((await store.claimSandboxStartup({taskId:run.taskId,runId:run.runId,expectedFencingToken:run.fencingToken,claimToken:"terminal-startup-resource-claim",claimedAt:timestamp,leaseExpiresAt:runTimestamp(3)})).kind,"claimed");
    const responseBody={
      error:{
        code:"sandbox_start_failed",
        message:"Sandbox could not be started",
        retryable:true,
        details:null,
        presentation:{task:{id:run.taskId},sandboxState:{state:"failed",runId:run.runId}}
      }
    };
    const failure={
      runId:run.runId,
      expectedFencingToken:run.fencingToken,
      code:"startup_failed" as const,
      message:"Sandbox startup did not complete. Retry release to remove its resources.",
      failedAt:timestamp,
      auditEvent:{id:"audit_terminal_startup_failed",projectId:run.projectId,actorId:null,subjectUserId:run.startedByUserId,action:"sandbox.failed" as const,status:"accepted" as const,resourceKind:"sandbox" as const,resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId},createdAt:timestamp}
    };
    const complete:CompleteTaskIdempotencyInput={actorId:claim.actorId,projectId:claim.projectId,operation:claim.operation,key:claim.key,requestHash:claim.requestHash,claimToken:claim.claimToken,responseStatus:502,responseBody,updatedAt:timestamp};
    const atomicStore=store as typeof store&{
      failTaskSandboxStartupAtomically(input:{failure:typeof failure;idempotency:typeof complete}):Promise<
        {kind:"failed";run:PersistedSandboxRunState}
        |{kind:"replay";responseStatus:number;responseBody:unknown}
        |{kind:"conflict"}
      >;
    };

    assert.deepEqual(await atomicStore.failTaskSandboxStartupAtomically({
      taskId:run.taskId,startupClaimToken:"terminal-startup-resource-claim",resourceIdentity:{...run.resourceNames,pod:"foreign-pod"},failure,idempotency:complete
    } as never),{kind:"conflict"});
    assert.equal((await store.sandboxRuns.get(run.runId))?.state,"starting");
    const failed=await atomicStore.failTaskSandboxStartupAtomically({
      taskId:run.taskId,startupClaimToken:"terminal-startup-resource-claim",resourceIdentity:run.resourceNames,failure,idempotency:complete
    } as never);
    assert.equal(failed.kind,"failed");
    assert.equal((await store.sandboxRuns.get(run.runId))?.state,"failed");
    assert.equal(await store.findInProgressTerminalStartOperation(run.runId),null);
    assert.deepEqual(await store.beginTaskIdempotency({...claim,claimToken:"terminal-startup-failure-retry",now:runTimestamp(2)}),{
      kind:"replay",
      resourceId:run.runId,
      responseStatus:502,
      responseBody
    });
    assert.deepEqual(await atomicStore.failTaskSandboxStartupAtomically({
      taskId:run.taskId,startupClaimToken:"terminal-startup-resource-claim",resourceIdentity:run.resourceNames,
      failure:{...failure,message:"different later failure"},
      idempotency:{...complete,claimToken:"terminal-startup-failure-retry",responseBody:{different:true},updatedAt:runTimestamp(2)}
    } as never),{kind:"replay",responseStatus:502,responseBody});
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
      reservedAt:runTimestamp(1),
      admission:{namespace:firstRun.namespace,namespaceLimit:100},
      ...restartAdmission(firstRun,"first")
    };
    assert.equal((await firstStore.restartTaskSandboxAtomically({
      ...firstInput,
      sandboxRun:{...firstRun,projectId:"project_other"}
    })).kind,"conflict");
    assert.equal((await firstStore.findProjectResourceUsage(firstTask.projectId))?.activeSandboxes,0);
    assert.equal((await firstStore.restartTaskSandboxAtomically(firstInput)).kind,"restarted");
    assert.equal((await firstStore.findTask(firstTask.id))?.currentRunId,firstRun.runId);
    assert.equal((await firstStore.findProjectResourceUsage(firstTask.projectId))?.activeSandboxes,1);
    assert.equal((await firstStore.listTaskMessages(firstTask.id)).length,0);
    assert.equal((await firstStore.restartTaskSandboxAtomically(firstInput)).kind,"conflict");
    assert.equal((await firstStore.findProjectResourceUsage(firstTask.projectId))?.activeSandboxes,1);
    const capacityTask={...firstTask,id:"task_capacity",fileLibraryId:"library_capacity"};
    assert.equal((await firstStore.createTaskAtomically({
      task:capacityTask,
      reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},
      newFileLibrary:{id:"library_capacity",workspaceId:capacityTask.workspaceId,projectId:capacityTask.projectId,name:"Capacity",rootSubPath:"libraries/library_capacity/home",lifecycleStatus:"active" as const,createdByUserId:capacityTask.createdByUserId!,createdAt:capacityTask.createdAt,updatedAt:capacityTask.updatedAt}
    })).kind,"created");
    const capacityRun={...firstRun,taskId:capacityTask.id,runId:"run_capacity",fileLibraryId:"library_capacity",fileLibraryRootSubPath:"libraries/library_capacity/home"};
    assert.equal((await firstStore.restartTaskSandboxAtomically({
      ...firstInput,
      task:{...capacityTask,currentRunId:capacityRun.runId},
      sandboxRun:capacityRun,
      ...restartAdmission(capacityRun,"capacity")
    })).kind,"capacity_rejected");
    assert.equal((await firstStore.findTask(capacityTask.id))?.currentRunId,null);
    assert.equal(await firstStore.sandboxRuns.get(capacityRun.runId),null);
    assert.equal((await firstStore.findProjectResourceUsage(firstTask.projectId))?.activeSandboxes,1);

    const restartStore=createLocalInMemoryProductStore();
    const released=sandboxRun({state:"released",releaseReason:"requested",releaseRequestedAt:runTimestamp(1),releasedAt:runTimestamp(2),fencingToken:2,updatedAt:runTimestamp(2)});
    const restartTask=await createTaskWithRun(restartStore,released);
    const replacementRun=sandboxRun({runId:"run_restarted",createdAt:runTimestamp(3),updatedAt:runTimestamp(3)});
    const restartInput={
      expectedReleasedRunId:released.runId,
      task:{...restartTask,currentRunId:replacementRun.runId,updatedAt:runTimestamp(3)},
      runtimeState:{botifiedBaseUrl:"http://restarted-task"},
      sandboxRun:replacementRun,
      reservedAt:runTimestamp(3),
      admission:{namespace:replacementRun.namespace,namespaceLimit:100},
      ...restartAdmission(replacementRun,"replacement")
    };
    assert.equal((await restartStore.restartTaskSandboxAtomically(restartInput)).kind,"restarted");
    assert.equal((await restartStore.findTask(restartTask.id))?.currentRunId,replacementRun.runId);
    assert.equal((await restartStore.findProjectResourceUsage(restartTask.projectId))?.activeSandboxes,1);
    assert.equal((await restartStore.listTaskMessages(restartTask.id)).length,0);

    const missingStore=createLocalInMemoryProductStore();
    const missingTask=await createTaskWithoutRun(missingStore);
    await missingStore.updateTask({...missingTask,currentRunId:"run_missing"});
    assert.equal((await missingStore.restartTaskSandboxAtomically({
      ...firstInput,
      expectedReleasedRunId:"run_missing",
      task:{...missingTask,currentRunId:"run_after_missing"},
      sandboxRun:{...firstRun,runId:"run_after_missing"},
      ...restartAdmission({...firstRun,taskId:missingTask.id,runId:"run_after_missing"},"missing")
    })).kind,"conflict");
    assert.equal((await missingStore.findProjectResourceUsage(missingTask.projectId))?.activeSandboxes,0);

    const staleStore=createLocalInMemoryProductStore();
    const currentReleased=sandboxRun({runId:"run_current",state:"released",releaseReason:"requested",releaseRequestedAt:runTimestamp(1),releasedAt:runTimestamp(2)});
    const staleTask=await createTaskWithRun(staleStore,currentReleased);
    assert.equal((await staleStore.restartTaskSandboxAtomically({
      ...restartInput,
      expectedReleasedRunId:"run_stale",
      task:{...staleTask,currentRunId:"run_after_stale"},
      sandboxRun:{...replacementRun,runId:"run_after_stale"},
      ...restartAdmission({...replacementRun,taskId:staleTask.id,runId:"run_after_stale"},"stale")
    })).kind,"conflict");
    assert.equal((await staleStore.findProjectResourceUsage(staleTask.projectId))?.activeSandboxes,0);

    const runningStore=createLocalInMemoryProductStore();
    const running=sandboxRun();
    const runningTask=await createTaskWithRun(runningStore,running);
    assert.equal((await runningStore.restartTaskSandboxAtomically({
      ...restartInput,
      expectedReleasedRunId:running.runId,
      task:{...runningTask,currentRunId:"run_after_running"},
      sandboxRun:{...replacementRun,runId:"run_after_running"},
      ...restartAdmission({...replacementRun,taskId:runningTask.id,runId:"run_after_running"},"running")
    })).kind,"conflict");
    assert.equal((await runningStore.findProjectResourceUsage(runningTask.projectId))?.activeSandboxes,1);
  });

  it("begins Terminal idempotency and reserves its persisted Run in one operation",async()=>{
    const store=createLocalInMemoryProductStore();
    const task=await createTaskWithoutRun(store);
    const run=sandboxRun({runId:"run_terminal_atomic",createdAt:runTimestamp(1),updatedAt:runTimestamp(1)});
    const input={
      taskId:task.id,
      idempotency:{actorId:run.startedByUserId,projectId:run.projectId,operation:"terminal-start" as const,key:"terminal-atomic",requestHash:"terminal-atomic-hash",resourceId:run.runId,claimToken:"terminal-atomic-claim",now:runTimestamp(1),leaseExpiresAt:runTimestamp(3)},
      admission:{namespace:run.namespace,namespaceLimit:100},
      restart:{expectedReleasedRunId:null,task:{...task,currentRunId:run.runId,updatedAt:run.updatedAt},runtimeState:{botifiedBaseUrl:"http://terminal"},sandboxRun:run,reservedAt:run.updatedAt},
      rejectionPresentation:{} as import("../../packages/contracts/src/api.js").TaskPresentation,
      rejectedAuditEvent:rejectedAdmissionAudit(run,"terminal","terminal-atomic")
    };
    const terminalStore=store as typeof store&{beginTerminalStart(value:typeof input):Promise<
      |{kind:"claimed";task:typeof task;run:PersistedSandboxRunState;claimToken:string}
      |{kind:"in_progress";task:typeof task;run:PersistedSandboxRunState}
      |{kind:"replay";responseStatus:number;responseBody:unknown}
      |{kind:"hash_mismatch"|"conflict"}
    >};
    const begun=await terminalStore.beginTerminalStart(input);
    assert.equal(begun.kind,"claimed");
    if(begun.kind!=="claimed")return;
    assert.equal(begun.run.runId,run.runId);
    assert.equal(begun.run.startupReadyAt,run.updatedAt);
    assert.equal((await store.findTask(task.id))?.currentRunId,run.runId);
    assert.deepEqual(await store.beginTaskIdempotency({...input.idempotency,claimToken:"parallel",now:runTimestamp(2)}),{kind:"in_progress",resourceId:run.runId});
    const takeover=await terminalStore.beginTerminalStart({...input,idempotency:{...input.idempotency,claimToken:"takeover",now:runTimestamp(4),leaseExpiresAt:runTimestamp(6)},restart:{...input.restart,sandboxRun:{...run,runId:"run_must_not_replace"}}});
    assert.equal(takeover.kind,"claimed");
    assert.equal(takeover.kind==="claimed"?takeover.run.runId:null,run.runId);
    assert.equal((await store.sandboxRuns.list()).filter((candidate)=>candidate.taskId===task.id&&candidate.state!=="released").length,1);
    assert.ok(await store.failSandboxRun({
      runId:run.runId,expectedFencingToken:run.fencingToken,code:"startup_failed",message:"failed",
      failedAt:runTimestamp(5),auditEvent:{id:"audit_terminal_bound_failed",projectId:run.projectId,actorId:null,action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId},createdAt:runTimestamp(5)}
    }));
    const failedConvergence=await terminalStore.beginTerminalStart({
      ...input,idempotency:{...input.idempotency,claimToken:"still-in-progress-token",now:runTimestamp(5),leaseExpiresAt:runTimestamp(7)}
    });
    assert.equal(failedConvergence.kind,"replay");
    if(failedConvergence.kind==="replay")assert.equal(failedConvergence.responseStatus,502);

    const activeStore=createLocalInMemoryProductStore();
    const activeTask=await createTaskWithoutRun(activeStore);
    const activeRun=sandboxRun({runId:"run_terminal_active",createdAt:runTimestamp(1),updatedAt:runTimestamp(1)});
    const activeInput={...input,taskId:activeTask.id,idempotency:{...input.idempotency,key:"terminal-active",resourceId:activeRun.runId,claimToken:"terminal-active-claim"},restart:{...input.restart,task:{...activeTask,currentRunId:activeRun.runId,updatedAt:activeRun.updatedAt},sandboxRun:activeRun}};
    const activeTerminalStore=activeStore as typeof activeStore&{beginTerminalStart(value:typeof activeInput):ReturnType<typeof terminalStore.beginTerminalStart>};
    assert.equal((await activeTerminalStore.beginTerminalStart(activeInput)).kind,"claimed");
    const startupClaimToken="terminal-active-startup";
    assert.equal((await activeStore.claimSandboxStartup({
      taskId:activeRun.taskId,runId:activeRun.runId,expectedFencingToken:activeRun.fencingToken,
      claimToken:startupClaimToken,claimedAt:runTimestamp(1),leaseExpiresAt:runTimestamp(4)
    })).kind,"claimed");
    const activeDeadline=runTimestamp(4);
    assert.ok(await activeStore.beginSandboxStartupAction({taskId:activeRun.taskId,runId:activeRun.runId,expectedFencingToken:activeRun.fencingToken,claimToken:startupClaimToken,actionDeadlineAt:activeDeadline,startedAt:runTimestamp(1)}));
    assert.equal((await activeStore.activateTaskSandboxRun({taskId:activeRun.taskId,runId:activeRun.runId,expectedFencingToken:activeRun.fencingToken,startupClaimToken,actionDeadlineAt:activeDeadline,activatedAt:runTimestamp(2),auditEvent:{id:"audit_terminal_bound_active",projectId:activeRun.projectId,actorId:null,action:"sandbox.started",status:"accepted",resourceKind:"sandbox",resourceId:activeRun.taskId,detail:{taskId:activeRun.taskId,runId:activeRun.runId},createdAt:runTimestamp(2)}})).kind,"activated");
    const activeConvergence=await activeTerminalStore.beginTerminalStart({...activeInput,idempotency:{...activeInput.idempotency,claimToken:"active-parallel",now:runTimestamp(2),leaseExpiresAt:runTimestamp(5)}});
    assert.equal(activeConvergence.kind,"replay");
    if(activeConvergence.kind==="replay")assert.equal(activeConvergence.responseStatus,200);
  });

  it("never rebinds an old Terminal key from its released Run to the current Run",async()=>{
    const store=createLocalInMemoryProductStore();
    const runA=sandboxRun({runId:"run_terminal_old_a",state:"released",releaseReason:"requested",releaseRequestedAt:runTimestamp(1),releasedAt:runTimestamp(2),fencingToken:2,updatedAt:runTimestamp(2)});
    const task=await createTaskWithRun(store,runA);
    const oldIdempotency={
      actorId:runA.startedByUserId,projectId:runA.projectId,operation:"terminal-start" as const,
      key:"terminal-old-run-a",requestHash:"terminal-old-run-a-hash",resourceId:runA.runId,
      claimToken:"terminal-old-run-a-claim",now:runTimestamp(2),leaseExpiresAt:runTimestamp(3)
    };
    assert.equal((await store.beginTaskIdempotency(oldIdempotency)).kind,"claimed");
    const runB=sandboxRun({runId:"run_terminal_current_b",createdAt:runTimestamp(3),updatedAt:runTimestamp(3)});
    const taskB={...task,currentRunId:runB.runId,updatedAt:runB.updatedAt};
    assert.equal((await store.restartTaskSandboxAtomically({
      expectedReleasedRunId:runA.runId,task:taskB,runtimeState:{botifiedBaseUrl:"http://run-b"},
      sandboxRun:runB,reservedAt:runB.updatedAt,admission:{namespace:runB.namespace,namespaceLimit:100},
      ...restartAdmission(runB,"terminal-current-b")
    })).kind,"restarted");

    const canonicalPresentation={
      sandboxState:{state:"released",runId:runA.runId,cause:"requested"}
    } as unknown as import("../../packages/contracts/src/api.js").TaskPresentation;
    const result=await store.beginTerminalStart({
      taskId:task.id,
      idempotency:{...oldIdempotency,claimToken:"terminal-old-run-a-takeover",now:runTimestamp(4),leaseExpiresAt:runTimestamp(6)},
      admission:{namespace:runB.namespace,namespaceLimit:100},
      rejectionPresentation:canonicalPresentation,
      rejectedAuditEvent:rejectedAdmissionAudit(runB,"terminal","terminal-old-run-a")
    });

    assert.equal(result.kind,"replay");
    if(result.kind==="replay"){
      assert.equal(result.responseStatus,409);
      assert.deepEqual((result.responseBody as {error:{presentation:unknown}}).error.presentation,canonicalPresentation);
    }
    const replay=await store.findTaskIdempotency({
      actorId:oldIdempotency.actorId,
      projectId:oldIdempotency.projectId,
      operation:oldIdempotency.operation,
      key:oldIdempotency.key,
      requestHash:oldIdempotency.requestHash
    });
    assert.deepEqual(replay,result.kind==="replay"?{kind:"replay",resourceId:runA.runId,responseStatus:result.responseStatus,responseBody:result.responseBody}:null);
    assert.equal((await store.findTask(task.id))?.currentRunId,runB.runId);
    assert.deepEqual((await store.sandboxRuns.list()).map((run)=>run.runId).sort(),[runA.runId,runB.runId].sort());
  });

  it("returns scoped capacity rejection for all three Sandbox admission entries",async()=>{
    for(const entry of ["create","restart","message"] as const){
      for(const scope of ["project","substrate"] as const){
        const store=createLocalInMemoryProductStore();
        const occupyingRun=scopedRun(`${entry}_${scope}_occupying`,{
          projectId:"project_occupying",
          taskId:"task_occupying",
          runId:"run_occupying",
          fileLibraryId:"library_occupying"
        });
        await createScopedTask(store,occupyingRun,true,scope==="project"?1:2);

        const projectId=scope==="project"?occupyingRun.projectId:"project_candidate";
        const candidateRun=scopedRun(`${entry}_${scope}_candidate`,{
          projectId,
          taskId:`task_${entry}_${scope}`,
          runId:`run_${entry}_${scope}`,
          fileLibraryId:`library_${entry}_${scope}`
        });
        const result=await attemptAdmission(store,entry,candidateRun,1);

        assert.deepEqual(result,scope==="project"
          ?{
              kind:"capacity_rejected",
              admission:{kind:"project_capacity_rejected",activeSandboxes:1,sandboxLimit:1},
              responseStatus:409,
              responseBody:{error:{code:"project_sandbox_capacity_reached",message:"Project Sandbox capacity reached",retryable:true,details:{activeSandboxes:1,sandboxLimit:1},presentation:entry==="create"?null:{}}}
            }
          :{
              kind:"capacity_rejected",
              admission:{kind:"substrate_capacity_rejected"},
              responseStatus:409,
              responseBody:{error:{code:"substrate_sandbox_capacity_reached",message:"Local Sandbox capacity unavailable",retryable:true,details:null,presentation:entry==="create"?null:{}}}
            });
        assert.equal(await store.sandboxRuns.get(candidateRun.runId),null);
        assert.equal((await store.findProjectResourceUsage(projectId))?.activeSandboxes,scope==="project"?1:0);
        if(entry==="create")assert.equal(await store.findTask(candidateRun.taskId),null);
        if(entry==="message")assert.equal((await store.listTaskMessages(candidateRun.taskId)).length,0);
        const rejectedAudits=(await store.queryProjectAuditEvents(projectId,{limit:20})).items.filter((event)=>event.status==="rejected"&&event.resourceId===candidateRun.taskId);
        assert.equal(rejectedAudits.length,1);
        assert.equal(rejectedAudits[0]?.action,entry==="create"?"task.create":"sandbox.started");
        assert.equal(rejectedAudits[0]?.detail?.trigger,entry==="create"?"task_create":entry==="message"?"task_message":"terminal");
        assert.equal(rejectedAudits[0]?.detail?.scope,scope==="project"?"project_policy":"substrate_namespace");
        assert.equal(rejectedAudits[0]?.detail?.activeSandboxes,scope==="project"?1:undefined);
        assert.equal(rejectedAudits[0]?.detail?.sandboxLimit,scope==="project"?1:undefined);
      }
    }
  });

  it("counts every unreleased Run, releases only released, and gives Project policy precedence",async()=>{
    for(const state of ["starting","active","release_requested","failed"] as const){
      const store=createLocalInMemoryProductStore();
      const occupyingRun=scopedRun(`state_${state}_occupying`,{
        projectId:"project_state",
        taskId:"task_state_occupying",
        runId:"run_state_occupying",
        fileLibraryId:"library_state_occupying",
        state,
        ...(state==="release_requested"?{releaseReason:"requested" as const,releaseRequestedAt:runTimestamp(1)}:{}),
        ...(state==="failed"?{failureCode:"runner_failed" as const,failureCause:"failed",releaseReason:"failed" as const,failedAt:runTimestamp(1),releaseRequestedAt:runTimestamp(1)}:{})
      });
      await createScopedTask(store,occupyingRun,true,1);
      const candidateRun=scopedRun(`state_${state}_candidate`,{
        projectId:occupyingRun.projectId,
        taskId:"task_state_candidate",
        runId:"run_state_candidate",
        fileLibraryId:"library_state_candidate"
      });
      const rejected=await attemptAdmission(store,"restart",candidateRun,1);
      assert.equal(rejected.kind,"capacity_rejected",state);
      if(rejected.kind==="capacity_rejected")assert.deepEqual(rejected.admission,{kind:"project_capacity_rejected",activeSandboxes:1,sandboxLimit:1},state);
    }

    const releasedStore=createLocalInMemoryProductStore();
    const releasedRun=scopedRun("state_released_occupying",{
      projectId:"project_released",
      taskId:"task_released_occupying",
      runId:"run_released_occupying",
      fileLibraryId:"library_released_occupying",
      state:"released",
      releaseReason:"requested",
      releaseRequestedAt:runTimestamp(1),
      releasedAt:runTimestamp(2)
    });
    await createScopedTask(releasedStore,releasedRun,true,1);
    const candidateRun=scopedRun("state_released_candidate",{
      projectId:releasedRun.projectId,
      taskId:"task_released_candidate",
      runId:"run_released_candidate",
      fileLibraryId:"library_released_candidate"
    });
    const staleUsage=await releasedStore.findProjectResourceUsage(releasedRun.projectId);
    assert.ok(staleUsage);
    await releasedStore.upsertProjectResourceUsage({...staleUsage,activeSandboxes:99});
    assert.equal((await attemptAdmission(releasedStore,"restart",candidateRun,1)).kind,"restarted");
    assert.equal((await releasedStore.findProjectResourceUsage(releasedRun.projectId))?.activeSandboxes,1);
  });

  it("admits one winner for the last Project slot and mixed namespace cold starts",async()=>{
    const projectStore=createLocalInMemoryProductStore();
    const first=scopedRun("project_race_first",{projectId:"project_race",taskId:"task_race_first",runId:"run_race_first",fileLibraryId:"library_race_first"});
    const second=scopedRun("project_race_second",{projectId:"project_race",taskId:"task_race_second",runId:"run_race_second",fileLibraryId:"library_race_second"});
    await createScopedTask(projectStore,first,false,1);
    await createScopedTask(projectStore,second,false,1);
    const projectResults=await Promise.all([
      attemptAdmission(projectStore,"restart",first,10),
      attemptAdmission(projectStore,"restart",second,10)
    ]);
    assert.equal(projectResults.filter((result)=>result.kind==="restarted").length,1);
    assert.equal(projectResults.filter((result)=>result.kind==="capacity_rejected"&&result.admission.kind==="project_capacity_rejected").length,1);
    assert.equal((await projectStore.findProjectResourceUsage(first.projectId))?.activeSandboxes,1);

    const namespaceStore=createLocalInMemoryProductStore();
    const createRun=scopedRun("namespace_race_create",{projectId:"project_create",taskId:"task_create",runId:"run_create",fileLibraryId:"library_create"});
    const restartRun=scopedRun("namespace_race_restart",{projectId:"project_restart",taskId:"task_restart",runId:"run_restart",fileLibraryId:"library_restart"});
    const messageRun=scopedRun("namespace_race_message",{projectId:"project_message",taskId:"task_message",runId:"run_message",fileLibraryId:"library_message"});
    await createScopedTask(namespaceStore,restartRun,false,1);
    await createScopedTask(namespaceStore,messageRun,false,1);
    const namespaceResults=await Promise.all([
      attemptAdmission(namespaceStore,"create",createRun,1),
      attemptAdmission(namespaceStore,"restart",restartRun,1),
      attemptAdmission(namespaceStore,"message",messageRun,1)
    ]);
    const admitted=namespaceResults.filter((result)=>result.kind==="created"||result.kind==="restarted");
    assert.equal(admitted.length,1);
    assert.equal(namespaceResults.filter((result)=>result.kind==="capacity_rejected"&&result.admission.kind==="substrate_capacity_rejected").length,2);
    assert.equal((await namespaceStore.sandboxRuns.list()).filter((run)=>run.namespace==="agentsmith"&&run.state!=="released").length,1);
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
    assert.equal((await store.sandboxRuns.get(run.runId))?.startupReadyAt,run.updatedAt);
    assert.deepEqual(await store.beginTaskIdempotency({...first.idempotency,claimToken:"parallel",now:runTimestamp(0)}),{
      kind:"replay",
      resourceId:"message_original",
      responseStatus:first.responseStatus,
      responseBody:first.responseBody
    });

    const reclaimed=await store.createTaskMessageAtomically({
      ...first,
      message:{...first.message,id:"message_retry",deliveryKey:"delivery_message_message_retry"},
      idempotency:{...first.idempotency,resourceId:"message_retry",claimToken:"claim_retry",now:runTimestamp(2),leaseExpiresAt:runTimestamp(3)}
    });
    assert.deepEqual(reclaimed,{kind:"replay",responseStatus:first.responseStatus,responseBody:first.responseBody});
    assert.deepEqual((await store.listTaskMessages(task.id)).map((message)=>message.id),["message_original"]);
    assert.equal(((await store.queryProjectAuditEvents(task.projectId,{limit:100})).items).filter((event)=>event.action==="task.message.create").length,1);
  });

  it("does not consume another slot when a message targets the active Run",async()=>{
    const store=createLocalInMemoryProductStore();
    const active=sandboxRun({state:"active",startedAt:runTimestamp(1),fencingToken:2,updatedAt:runTimestamp(1)});
    const task=await createTaskWithRun(store,active);
    const unusedReplacement={...active,runId:"run_unused_message_restart",state:"starting" as const,startedAt:null,fencingToken:1,createdAt:runTimestamp(2),updatedAt:runTimestamp(2)};
    const result=await store.createTaskMessageAtomically({
      ...atomicMessage(task,unusedReplacement,"message_active","message_active",runTimestamp(2),runTimestamp(4),"claim_active"),
      admission:{namespace:active.namespace,namespaceLimit:1}
    });
    assert.equal(result.kind,"created");
    assert.equal(result.kind==="created"?result.restarted:null,false);
    assert.equal(await store.sandboxRuns.get(unusedReplacement.runId),null);
    assert.equal((await store.findProjectResourceUsage(task.projectId))?.activeSandboxes,1);
  });

});

async function createTaskWithRun(store:ReturnType<typeof createLocalInMemoryProductStore>,run:PersistedSandboxRunState){
  const timestamp=runTimestamp(0);
  await store.createUser({id:run.startedByUserId,email:"runner@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp});
  await store.createWorkspace({id:run.workspaceId,name:"Workspace",ownerUserId:run.startedByUserId,createdAt:timestamp,updatedAt:timestamp});
  await store.createProject({id:run.projectId,workspaceId:run.workspaceId,name:"Project",ownerUserId:run.startedByUserId,rootPath:run.projectSubPath,sandboxLimit:1,createdAt:timestamp,updatedAt:timestamp});
  const task={id:run.taskId,workspaceId:run.workspaceId,projectId:run.projectId,endpointId:"endpoint_1",fileLibraryId:run.fileLibraryId,createdByUserId:run.startedByUserId,title:"Task",prompt:"Work",agentContext:"",currentRunId:run.runId,archivedAt:null,deletedAt:null,createdAt:timestamp,updatedAt:timestamp};
  const active=run.state!=="released";
  const created=await store.createTaskAtomically({
    task,
    reserveActive:active,
    admission:{namespace:run.namespace,namespaceLimit:100},
    ...(active?{
      idempotency:admissionIdempotency(run,`fixture-${run.runId}`),
      rejectionPresentation:null,
      rejectedAuditEvent:rejectedAdmissionAudit(run,"task_create",`fixture-${run.runId}`)
    }:{}),
    newFileLibrary:{id:run.fileLibraryId,workspaceId:run.workspaceId,projectId:run.projectId,name:"Library",rootSubPath:run.fileLibraryRootSubPath,lifecycleStatus:"active" as const,createdByUserId:run.startedByUserId,createdAt:timestamp,updatedAt:timestamp},
    sandboxRun:run
  });
  assert.equal(created.kind,"created");
  return task;
}

async function createTaskWithoutRun(store:ReturnType<typeof createLocalInMemoryProductStore>){
  const run=sandboxRun();
  const timestamp=runTimestamp(0);
  await store.createUser({id:run.startedByUserId,email:"runner@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp});
  await store.createWorkspace({id:run.workspaceId,name:"Workspace",ownerUserId:run.startedByUserId,createdAt:timestamp,updatedAt:timestamp});
  await store.createProject({id:run.projectId,workspaceId:run.workspaceId,name:"Project",ownerUserId:run.startedByUserId,rootPath:run.projectSubPath,sandboxLimit:1,createdAt:timestamp,updatedAt:timestamp});
  const task={id:run.taskId,workspaceId:run.workspaceId,projectId:run.projectId,endpointId:"endpoint_1",fileLibraryId:run.fileLibraryId,createdByUserId:run.startedByUserId,title:"Task",prompt:"Work",agentContext:"",currentRunId:null,archivedAt:null,deletedAt:null,createdAt:timestamp,updatedAt:timestamp};
  const created=await store.createTaskAtomically({task,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},newFileLibrary:{id:run.fileLibraryId,workspaceId:run.workspaceId,projectId:run.projectId,name:"Library",rootSubPath:run.fileLibraryRootSubPath,lifecycleStatus:"active" as const,createdByUserId:run.startedByUserId,createdAt:timestamp,updatedAt:timestamp}});
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
    startedByUserId:"user_1",startedAt:null,startupReadyAt:null,startupActionDeadlineAt:null,botifiedPort:3099,
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

function scopedRun(label:string,overrides:Partial<PersistedSandboxRunState>):PersistedSandboxRunState {
  const run=sandboxRun(overrides);
  return{
    ...run,
    projectSubPath:`workspaces/${run.workspaceId}/projects/${run.projectId}`,
    fileLibraryRootSubPath:`libraries/${run.fileLibraryId}/home`,
    resourceNames:{
      pod:`${label}-pod`,
      service:`${label}-service`,
      configMap:`${label}-config`,
      secret:`${label}-secret`,
      serviceAccount:`${label}-account`,
      networkPolicy:`${label}-network`
    },
    serviceKeySecretRef:{name:`${label}-secret`,key:"BOTIFIED_SERVICE_KEY"}
  };
}

async function createScopedTask(
  store:ReturnType<typeof createLocalInMemoryProductStore>,
  run:PersistedSandboxRunState,
  includeRun:boolean,
  projectLimit:number
){
  const timestamp=runTimestamp(0);
  await ensureScopedProject(store,run,projectLimit);
  const task={id:run.taskId,workspaceId:run.workspaceId,projectId:run.projectId,endpointId:"endpoint_1",fileLibraryId:run.fileLibraryId,createdByUserId:run.startedByUserId,title:run.taskId,prompt:"Work",agentContext:"",currentRunId:includeRun?run.runId:null,archivedAt:null,deletedAt:null,createdAt:timestamp,updatedAt:timestamp};
  const created=await store.createTaskAtomically({
    task,
    reserveActive:includeRun&&run.state!=="released",
    admission:{namespace:run.namespace,namespaceLimit:100},
    ...(includeRun&&run.state!=="released"?{
      idempotency:admissionIdempotency(run,`scoped-${run.runId}`),
      rejectionPresentation:null,
      rejectedAuditEvent:rejectedAdmissionAudit(run,"task_create",`scoped-${run.runId}`)
    }:{}),
    newFileLibrary:{id:run.fileLibraryId,workspaceId:run.workspaceId,projectId:run.projectId,name:run.fileLibraryId,rootSubPath:run.fileLibraryRootSubPath,lifecycleStatus:"active" as const,createdByUserId:run.startedByUserId,createdAt:timestamp,updatedAt:timestamp},
    ...(includeRun?{sandboxRun:run}:{})
  });
  assert.equal(created.kind,"created");
  return task;
}

async function ensureScopedProject(
  store:ReturnType<typeof createLocalInMemoryProductStore>,
  run:PersistedSandboxRunState,
  projectLimit:number
):Promise<void>{
  const timestamp=runTimestamp(0);
  if(!await store.findUserById(run.startedByUserId))await store.createUser({id:run.startedByUserId,email:`${run.startedByUserId}@example.test`,emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp});
  if(!await store.findWorkspace(run.workspaceId))await store.createWorkspace({id:run.workspaceId,name:"Workspace",ownerUserId:run.startedByUserId,createdAt:timestamp,updatedAt:timestamp});
  if(!await store.findProject(run.projectId))await store.createProject({id:run.projectId,workspaceId:run.workspaceId,name:run.projectId,ownerUserId:run.startedByUserId,rootPath:run.projectSubPath,sandboxLimit:projectLimit,createdAt:timestamp,updatedAt:timestamp});
}

async function attemptAdmission(
  store:ReturnType<typeof createLocalInMemoryProductStore>,
  entry:"create"|"restart"|"message",
  run:PersistedSandboxRunState,
  namespaceLimit:number
){
  const admission={namespace:run.namespace,namespaceLimit};
  if(entry==="create"){
    await ensureScopedProject(store,run,1);
    const task={id:run.taskId,workspaceId:run.workspaceId,projectId:run.projectId,endpointId:"endpoint_1",fileLibraryId:run.fileLibraryId,createdByUserId:run.startedByUserId,title:run.taskId,prompt:"Work",agentContext:"",currentRunId:run.runId,archivedAt:null,deletedAt:null,createdAt:run.createdAt,updatedAt:run.updatedAt};
    return store.createTaskAtomically({
      task,
      reserveActive:true,
      admission,
      idempotency:admissionIdempotency(run,`attempt-${run.runId}`),
      rejectionPresentation:null,
      rejectedAuditEvent:rejectedAdmissionAudit(run,"task_create",`attempt-${run.runId}`),
      newFileLibrary:{id:run.fileLibraryId,workspaceId:run.workspaceId,projectId:run.projectId,name:run.fileLibraryId,rootSubPath:run.fileLibraryRootSubPath,lifecycleStatus:"active" as const,createdByUserId:run.startedByUserId,createdAt:run.createdAt,updatedAt:run.updatedAt},
      sandboxRun:run
    });
  }
  const existing=await store.findTask(run.taskId)??await createScopedTask(store,run,false,1);
  if(entry==="restart")return store.restartTaskSandboxAtomically({
    expectedReleasedRunId:null,
    task:{...existing,currentRunId:run.runId,updatedAt:run.updatedAt},
    runtimeState:{botifiedBaseUrl:`http://${run.taskId}`},
    sandboxRun:run,
    reservedAt:run.updatedAt,
    admission,
    ...restartAdmission(run,`attempt-${run.runId}`)
  });
  return store.createTaskMessageAtomically({
    ...atomicMessage(existing,run,`message_${run.runId}`,`message_${run.runId}`,run.createdAt,runTimestamp(4),`claim_${run.runId}`),
    admission
  });
}

function atomicMessage(
  task:import("../../packages/ports/src/store.js").PersistedAgentTask,
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
    admission:{namespace:run.namespace,namespaceLimit:100},
    rejectionPresentation:{} as import("../../packages/contracts/src/api.js").TaskPresentation,
    rejectedAuditEvent:rejectedAdmissionAudit(run,"task_message",candidateId),
    responseStatus:200,
    responseBody:{resourceId,status:"accepted"},
    interactionChange:{
      sourceKind:"product",
      sourceId:`message:${candidateId}`,
      sourceRevision:0,
      interaction:{
        id:`interaction_${candidateId}`,revision:1,taskId:task.id,kind:"user_message",title:"You",
        body:message.content,contentMode:"full",position:0,occurredAt:now,updatedAt:now,
        actorId:run.startedByUserId,status:"pending"
      }
    },
    restart:{task:{...task,currentRunId:run.runId,updatedAt:run.updatedAt},runtimeState:{botifiedBaseUrl:"http://task"},sandboxRun:run,reservedAt:run.updatedAt}
  };
}

function admissionIdempotency(run:PersistedSandboxRunState,label:string){
  return{
    actorId:run.startedByUserId,
    projectId:run.projectId,
    operation:"create" as const,
    key:`admission-${label}`,
    requestHash:`admission-hash-${label}`,
    resourceId:run.taskId,
    claimToken:`admission-claim-${label}`,
    now:run.updatedAt,
    leaseExpiresAt:runTimestamp(59)
  };
}

function rejectedAdmissionAudit(run:PersistedSandboxRunState,trigger:"task_create"|"task_message"|"terminal",label:string){
  return{
    id:`audit_admission_rejected_${label}`,
    projectId:run.projectId,
    actorId:run.startedByUserId,
    action:trigger==="task_create"?"task.create" as const:"sandbox.started" as const,
    status:"rejected" as const,
    resourceKind:trigger==="task_create"?"task" as const:"sandbox" as const,
    resourceId:run.taskId,
    detail:{taskId:run.taskId,trigger},
    createdAt:run.updatedAt
  };
}

function restartAdmission(run:PersistedSandboxRunState,label:string){
  return{
    idempotency:{...admissionIdempotency(run,label),operation:"terminal-start" as const},
    rejectionPresentation:{} as import("../../packages/contracts/src/api.js").TaskPresentation,
    rejectedAuditEvent:rejectedAdmissionAudit(run,"terminal",label)
  };
}

function runTimestamp(minute:number):string {
  return `2026-07-23T00:${String(minute).padStart(2,"0")}:00.000Z`;
}
