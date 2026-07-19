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

  it("looks up correlations and rolls artifact, lifecycle, and cursor updates back with a rejected revision", async () => {
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
      lifecycle: { kind:"active",expectedStatus:"running",status:"stopping",updatedAt:timestamp(3) },
      sourceSync: { expectedSourceCursor:"cursor:tool",sourceCursor:"cursor:rollback",historyStatus:"complete",lastSyncedAt:timestamp(3) }
    }), /revision is not monotonic/);

    assert.deepEqual(await store.listTaskArtifacts("task_interactions"), []);
    assert.equal((await store.findProjectResourceUsage("project"))?.projectFileBytes, 0);
    assert.equal((await store.findTask("task_interactions"))?.status, "running");
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

  it("persists terminal lifecycle, interaction, artifact metadata, and source cursor together",async()=>{
    const store = createLocalInMemoryProductStore();
    await store.createProject(project());
    await createTask(store);
    await store.createTaskMessage({ id:"pending-message",taskId:"task_interactions",content:"continue",deliveryStatus:"pending",createdAt:timestamp(1) });

    await store.persistTaskInteractionMutation({
      taskId:"task_interactions",
      changes:[change("product","terminal-result",1,interaction("result",1,3,"assistant_message"))],
      artifactProjections:[{projectId:"project",artifact:{id:"terminal-artifact",taskId:"task_interactions",fileId:"botified-file",name:"result.txt",bytes:1,createdAt:timestamp(3)},auditEvent:{id:"terminal-artifact-audit",projectId:"project",actorId:null,action:"artifact.project",status:"accepted",resourceKind:"artifact",resourceId:"terminal-artifact",createdAt:timestamp(3)},updatedAt:timestamp(3)}],
      lifecycle:{kind:"terminal",terminalReason:"completed",updatedAt:timestamp(3),auditEvent:{id:"terminal-audit",projectId:"project",actorId:null,action:"task.completed",status:"accepted",resourceKind:"task",resourceId:"task_interactions",createdAt:timestamp(3)}},
      sourceSync:{expectedSourceCursor:null,sourceCursor:"terminal-cursor",historyStatus:"complete",lastSyncedAt:timestamp(3)}
    });
    assert.equal((await store.findTask("task_interactions"))?.terminalReason,"completed");
    assert.equal((await store.listTaskArtifacts("task_interactions"))[0]?.fileId,"botified-file");
    assert.equal((await store.readTaskInteractionSnapshot("task_interactions",null,10))?.sourceCursor,"terminal-cursor");
    assert.equal((await store.findTaskMessage("pending-message"))?.deliveryStatus,"failed");
  });

  it("defines authoritative state events without a durable interaction cursor", () => {
    const events: TaskInteractionStreamEvent[] = [
      { type:"state", queuedMessages:[], capabilities:{sendMessage:true,editQueuedMessage:false,abortTurn:false,cancelTask:true,openTerminal:true,editTask:true,archiveTask:false,deleteTask:false} },
      { type:"run_state", runState:"running" },
      { type:"connection", connectionState:"connected", runtimeReachability:"reachable", historyStatus:"complete", lastSyncedAt:timestamp(3), message:null }
    ];
    assert.equal(events.every((event) => !("cursor" in event)),true);
    assert.equal(events[0]?.type === "state" && events[0].capabilities.sendMessage,true);
  });
});

function task(): PersistedAgentTask {
  return { id:"task_interactions",workspaceId:"workspace",projectId:"project",endpointId:"endpoint",fileLibraryId:"library_interactions",title:"Task",prompt:"work",status:"running",runId:"run",executionMode:"live",sandbox:{namespace:"agentsmith",resources:[]},createdAt:timestamp(0),updatedAt:timestamp(0) };
}

async function createTask(store:ReturnType<typeof createLocalInMemoryProductStore>):Promise<void>{
  await store.createFileLibrary({id:"library_interactions",workspaceId:"workspace",projectId:"project",name:"Library",rootSubPath:"libraries/library_interactions/home",createdByUserId:"user",createdAt:timestamp(0),updatedAt:timestamp(0)});
  assert.equal((await store.createTaskAtomically({task:task(),reserveActive:false})).kind,"created");
}

function project() { return { id:"project",workspaceId:"workspace",name:"Project",ownerUserId:"user",rootPath:"workspaces/workspace/projects/project",taskConcurrencyLimit:2,createdAt:timestamp(0),updatedAt:timestamp(0) }; }

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
