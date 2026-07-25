import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import type { TaskInteractionItem, TaskInteractionStreamEvent } from "../../packages/contracts/src/api.js";
import type { PersistedAgentTask, TaskInteractionChangeInput } from "../../packages/ports/src/store.js";

describe("task interaction store", () => {
  it("initializes new task history complete without healing a later gap", async () => {
    const store = createLocalInMemoryProductStore();
    await store.createProject(project());
    await createTask(store);

    const snapshot = await store.readTaskInteractionSnapshot("task_interactions", null, 10);
    assert.equal(snapshot?.sourceCursor, null);
    assert.equal(snapshot?.historyStatus,"complete");
    assert.equal(snapshot?.lastSyncedAt, null);

    await store.persistTaskInteractionMutation({
      taskId: "task_interactions",
      changes: [],
      sourceSync: { expectedSourceCursor: null, sourceCursor: "recovered:1", historyStatus: "gap", lastSyncedAt: timestamp(1) }
    });

    const recovered = await store.readTaskInteractionSnapshot("task_interactions", null, 10);
    assert.equal(recovered?.sourceCursor, "recovered:1");
    assert.equal(recovered?.historyStatus, "gap");
    assert.equal(recovered?.lastSyncedAt, timestamp(1));
  });

  it("deduplicates sources, advances revisions and sequences, and pages the latest view backward", async () => {
    const store = createLocalInMemoryProductStore();
    await store.createProject(project());
    await createTask(store);
    const user = interaction("user", 1, 1, "user_message");
    const assistant1 = interaction("assistant", 1, 2, "assistant_message");
    const assistant2 = interaction("assistant", 2, 2, "assistant_message");

    const first = await store.persistTaskInteractionMutation({
      taskId: "task_interactions",
      changes: [change("product", "message:user", 1, user), change("botified", "cursor:1", 0, assistant1), change("botified", "cursor:1", 0, assistant1)],
      sourceSync: { expectedSourceCursor: null, sourceCursor: "cursor:1", historyStatus: "complete", lastSyncedAt: timestamp(3) }
    });
    assert.deepEqual(first.changes.map((item) => item.changeSeq), [1, 2]);
    await assert.rejects(store.persistTaskInteractionMutation({ taskId:"task_interactions",changes:[change("product","message:user",0,{...user,revision:2})] }), /source revision is not monotonic/);

    const second = await store.persistTaskInteractionMutation({ taskId: "task_interactions", changes: [change("botified", "cursor:2", 0, assistant2)], sourceSync: { expectedSourceCursor: "cursor:1", sourceCursor: "cursor:2", historyStatus: "complete", lastSyncedAt: timestamp(4) } });
    assert.equal(second.latestChangeSeq, 3);

    const latest = await store.readTaskInteractionSnapshot("task_interactions", null, 10);
    assert.deepEqual(latest?.items.map((item) => [item.id,item.revision]), [["user",1],["assistant",2]]);
    assert.equal(latest?.latestChangeSeq, 3);
    assert.equal(latest?.sourceCursor, "cursor:2");
    assert.equal(latest?.historyStatus, "complete");

    const newest = await store.readTaskInteractionSnapshot("task_interactions", null, 1);
    assert.deepEqual(newest?.items.map((item) => item.id), ["assistant"]);
    assert.equal(newest?.hasMoreBefore, true);
    const older = await store.readTaskInteractionSnapshot("task_interactions", newest!.nextPageAnchor, 1);
    assert.deepEqual(older?.items.map((item) => item.id), ["user"]);
    assert.deepEqual((await store.listTaskInteractionChanges("task_interactions", 1, 10)).map((item) => item.changeSeq), [2,3]);
  });

  it("looks up correlations and rolls artifact and cursor updates back with a rejected revision", async () => {
    const store = createLocalInMemoryProductStore();
    await store.createProject(project());
    await createTask(store);
    const tool = interaction("tool", 1, 1, "tool");
    await store.persistTaskInteractionMutation({ taskId: "task_interactions", changes: [{ ...change("botified", "cursor:tool", 0, tool), correlation: { toolCallId: "call-1" } }], sourceSync: { expectedSourceCursor: null, sourceCursor: "cursor:tool", historyStatus: "gap", lastSyncedAt: timestamp(2) } });
    assert.equal((await store.findTaskInteractionByCorrelation("task_interactions", { toolCallId: "call-1" }))?.id, "tool");

    await assert.rejects(store.persistTaskInteractionMutation({
      taskId: "task_interactions",
      changes: [change("product", "conflicting-revision", 1, tool)],
      artifactProjections: [{ projectId:"project",artifact:{ id:"artifact-rollback",taskId:"task_interactions",fileId:"file-rollback",name:"rollback.txt",bytes:1,createdAt:timestamp(3) },auditEvent:{id:"audit-rollback",projectId:"project",actorId:null,action:"artifact.project",status:"accepted",resourceKind:"artifact",resourceId:"artifact-rollback",createdAt:timestamp(3)},updatedAt:timestamp(3) }],
      sourceSync: { expectedSourceCursor:"cursor:tool",sourceCursor:"cursor:rollback",historyStatus:"complete",lastSyncedAt:timestamp(3) }
    }), /revision is not monotonic/);

    assert.deepEqual((await store.queryTaskArtifacts("task_interactions",{kind:null,mediaType:null,previewOnly:false,limit:100})).items, []);
    assert.equal((await store.findProjectResourceUsage("project"))?.projectFileBytes, 0);
    const snapshot = await store.readTaskInteractionSnapshot("task_interactions", null, 10);
    assert.equal(snapshot?.sourceCursor, "cursor:tool");
    assert.equal(snapshot?.latestChangeSeq, 1);
  });

  it("rolls a queued message back when its interaction change is rejected", async () => {
    const store = createLocalInMemoryProductStore();
    await store.createProject(project());
    await createTask(store);
    const invalid = change("product","message:atomic",1,{...interaction("atomic",1,1,"user_message"),taskId:"other-task"});

    await assert.rejects(() => store.createPendingTaskMessage({id:"atomic",taskId:"task_interactions",content:"atomic",deliveryStatus:"pending",createdAt:timestamp(1)},invalid), /interaction identity mismatch/i);

    assert.equal(await store.findTaskMessage("atomic"),null);
    assert.deepEqual(await store.listTaskInteractionChanges("task_interactions",0,10),[]);
  });

  it("does not dispatch a pending message whose product interaction was never committed",async()=>{
    const store=createLocalInMemoryProductStore();
    await store.createProject(project());
    await createTask(store);
    const message=await store.createTaskMessage({
      id:"message-crash-window",taskId:"task_interactions",actorId:"user",content:"not durable",
      deliveryKey:"delivery-message-crash-window",requestHash:"crash-window-hash",
      claimToken:null,receipt:null,timelineCursor:null,deliveryStatus:"pending",
      claimedAt:null,leaseExpiresAt:null,attemptCount:0,nextRetryAt:null,safeError:null,
      createdAt:timestamp(1),updatedAt:timestamp(1),deletedAt:null
    });

    assert.deepEqual(await store.listTaskMessagesDue(timestamp(2),10),[]);
    assert.equal(await store.claimTaskMessage({
      id:message.id,claimToken:"claim-must-not-stick",claimedAt:timestamp(2),leaseExpiresAt:timestamp(5)
    }),null);
    const persisted=await store.findTaskMessage(message.id);
    assert.equal(persisted?.deliveryStatus,"pending");
    assert.equal(persisted?.claimToken,null);

    const later=await store.createPendingTaskMessage(
      {id:"message-after-crash-window",taskId:"task_interactions",actorId:"user",content:"durable",deliveryKey:"delivery-message-after-crash-window",requestHash:"after-crash-window-hash",claimToken:null,receipt:null,timelineCursor:null,deliveryStatus:"pending",claimedAt:null,leaseExpiresAt:null,attemptCount:0,nextRetryAt:null,safeError:null,createdAt:timestamp(3),updatedAt:timestamp(3),deletedAt:null},
      change("product","message:message-after-crash-window",0,interaction("message-after-crash-window",1,2,"user_message"))
    );
    assert.ok(later);
    assert.deepEqual((await store.listTaskMessagesDue(timestamp(4),10)).map((candidate)=>candidate.id),[later.id]);
    assert.equal((await store.claimTaskMessage({
      id:later.id,claimToken:"valid-later-claim",claimedAt:timestamp(4),leaseExpiresAt:timestamp(6)
    }))?.id,later.id);
  });

  it("completes resource idempotency only for the matching Project and operation",async()=>{
    const store=createLocalInMemoryProductStore();
    await store.createProject(project());
    await store.createProject({...project(),id:"other-project",name:"Other Project",rootPath:"workspaces/workspace/projects/other-project"});
    const resourceId="shared-message";
    const records=[
      {projectId:"project",operation:"message" as const,key:"target",requestHash:"target-hash",claimToken:"target-claim"},
      {projectId:"project",operation:"message-edit" as const,key:"other-operation",requestHash:"other-operation-hash",claimToken:"other-operation-claim"},
      {projectId:"other-project",operation:"message" as const,key:"other-project",requestHash:"other-project-hash",claimToken:"other-project-claim"}
    ];
    for(const record of records)assert.equal((await store.beginTaskIdempotency({actorId:"user",resourceId,now:timestamp(1),leaseExpiresAt:timestamp(5),...record})).kind,"claimed");
    assert.equal(await store.completeTaskIdempotencyForResource({projectId:"project",operation:"message",resourceId,responseStatus:200,responseBody:{messageId:resourceId},updatedAt:timestamp(2)}),1);
    const replayInputs={actorId:"user",resourceId,now:timestamp(2),leaseExpiresAt:timestamp(6)};
    assert.deepEqual(await store.beginTaskIdempotency({...replayInputs,...records[0]!,claimToken:"target-replay"}),{kind:"replay",resourceId,responseStatus:200,responseBody:{messageId:resourceId}});
    assert.deepEqual(await store.beginTaskIdempotency({...replayInputs,...records[1]!,claimToken:"other-operation-replay"}),{kind:"in_progress",resourceId});
    assert.deepEqual(await store.beginTaskIdempotency({...replayInputs,...records[2]!,claimToken:"other-project-replay"}),{kind:"in_progress",resourceId});
  });

  it("looks up an interaction directly after more than 1000 later changes", async () => {
    const store = createLocalInMemoryProductStore();
    await store.createProject(project());
    await createTask(store);
    const changes = Array.from({length:1002},(_,index)=>change("botified",`cursor:${index}`,0,{...interaction(`item-${index}`,1,index,"assistant_message"),occurredAt:timestamp(1),updatedAt:timestamp(1)}));
    await store.persistTaskInteractionMutation({taskId:"task_interactions",changes});

    const oldest = await store.findLatestTaskInteractionChange("task_interactions","item-0");
    assert.equal(oldest?.interaction.id,"item-0");
    assert.equal(oldest?.changeSeq,1);
  });

  it("persists interaction, artifact metadata, and source cursor together",async()=>{
    const store = createLocalInMemoryProductStore();
    await store.createProject(project());
    await createTask(store);
    await store.createTaskMessage({ id:"pending-message",taskId:"task_interactions",content:"continue",deliveryStatus:"pending",createdAt:timestamp(1) });

    await store.persistTaskInteractionMutation({
      taskId:"task_interactions",
      changes:[change("product","turn-result",1,interaction("result",1,3,"assistant_message"))],
      artifactProjections:[{projectId:"project",artifact:{id:"turn-artifact",taskId:"task_interactions",fileId:"botified-file",name:"result.txt",bytes:1,createdAt:timestamp(3)},auditEvent:{id:"turn-artifact-audit",projectId:"project",actorId:null,action:"artifact.project",status:"accepted",resourceKind:"artifact",resourceId:"turn-artifact",createdAt:timestamp(3)},updatedAt:timestamp(3)}],
      sourceSync:{expectedSourceCursor:null,sourceCursor:"turn-cursor",historyStatus:"complete",lastSyncedAt:timestamp(3)}
    });
    assert.equal((await store.queryTaskArtifacts("task_interactions",{kind:null,mediaType:null,previewOnly:false,limit:100})).items[0]?.fileId,"botified-file");
    assert.equal((await store.readTaskInteractionSnapshot("task_interactions",null,10))?.sourceCursor,"turn-cursor");
    assert.equal((await store.findTaskMessage("pending-message"))?.deliveryStatus,"pending");
  });

  it("defines authoritative state events without a durable interaction cursor", () => {
    const events: TaskInteractionStreamEvent[] = [
      { type:"state", queuedMessages:[], presentation:{task:{id:"task_interactions",workspaceId:"workspace",projectId:"project",endpointId:"endpoint",fileLibraryId:"library_interactions",title:"Task",prompt:"work",createdAt:timestamp(0),updatedAt:timestamp(0)},lifecycle:{state:"active"},currentTurn:{state:"ready"},sandboxState:{state:"released",runId:null,cause:null},capabilities:{sendMessage:true,editQueuedMessage:false,abortTurn:false,stopWork:false,openTerminal:true,releaseSandbox:true,editTask:true,archiveTask:false,deleteTask:false}} },
      { type:"connection", connectionState:"connected", runtimeReachability:"reachable", historyStatus:"complete", lastSyncedAt:timestamp(3), message:null }
    ];
    assert.equal(events.every((event) => !("cursor" in event)),true);
    assert.equal(events[0]?.type === "state" && events[0].presentation.capabilities.sendMessage,true);
  });
});

function task(): PersistedAgentTask {
  return { id:"task_interactions",workspaceId:"workspace",projectId:"project",endpointId:"endpoint",fileLibraryId:"library_interactions",title:"Task",prompt:"work",currentRunId:null,archivedAt:null,deletedAt:null,createdAt:timestamp(0),updatedAt:timestamp(0) };
}

async function createTask(store:ReturnType<typeof createLocalInMemoryProductStore>):Promise<void>{
  await store.createFileLibrary({id:"library_interactions",workspaceId:"workspace",projectId:"project",name:"Library",rootSubPath:"libraries/library_interactions/home",lifecycleStatus:"active" as const,createdByUserId:"user",createdAt:timestamp(0),updatedAt:timestamp(0)});
  assert.equal((await store.createTaskAtomically({task:task(),reserveActive:false,admission:{namespace:"agentsmith",namespaceLimit:100}})).kind,"created");
}

function project() { return { id:"project",workspaceId:"workspace",name:"Project",ownerUserId:"user",rootPath:"workspaces/workspace/projects/project",sandboxLimit:2,createdAt:timestamp(0),updatedAt:timestamp(0) }; }

function interaction(id:string,revision:number,position:number,kind:TaskInteractionItem["kind"]):TaskInteractionItem {
  const base = { id,revision,taskId:"task_interactions",title:id,body:null,contentMode:"none" as const,position,occurredAt:timestamp(position),updatedAt:timestamp(revision+position) };
  if(kind==="user_message")return {...base,kind,status:"accepted"};
  if(kind==="assistant_message")return {...base,kind,status:"completed"};
  return {...base,kind:"tool",executionStatus:"running",deliveryStatus:null,toolName:"bash",command:null,outputTail:null,exitCode:null,detailsOmitted:false,canStop:false};
}

function change(sourceKind:"botified"|"product",sourceId:string,sourceRevision:number,value:TaskInteractionItem):TaskInteractionChangeInput {
  return { sourceKind,sourceId,sourceRevision,interaction:value };
}

function timestamp(offset:number):string { return `2026-07-13T00:00:0${offset}.000Z`; }
