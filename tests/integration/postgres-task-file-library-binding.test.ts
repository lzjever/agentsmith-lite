import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
import { readPostgresMigrations } from "../../packages/adapters-postgres/src/migrations.js";
import { projectTaskInteraction } from "../../packages/application/src/taskInteractionProjector.js";
import type { PersistedAgentTask, TaskInteractionChangeInput } from "../../packages/ports/src/store.js";
import { readPostgresTestUrl } from "./postgres-test-database.js";

const postgresUrl=readPostgresTestUrl();
const postgresDescribe=postgresUrl?describe:describe.skip;

postgresDescribe("postgres Task File Library binding",()=>{
  assert.ok(postgresUrl);
  const store=new PostgresProductStore(postgresUrl);
  const timestamp="2026-07-19T00:00:00.000Z";

  beforeEach(async()=>{
    const client=new pg.Client({connectionString:postgresUrl});await client.connect();
    try{await client.query("truncate table agent_tasks,file_libraries,model_endpoints,project_credentials,projects,workspaces,users cascade");}finally{await client.end();}
    await store.createUser({id:"user_binding",email:"binding@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp});
    await store.createWorkspace({id:"workspace_binding",name:"Binding",ownerUserId:"user_binding",createdAt:timestamp,updatedAt:timestamp});
    await store.createProject({id:"project_binding",workspaceId:"workspace_binding",name:"Binding",ownerUserId:"user_binding",rootPath:"workspaces/workspace_binding/projects/project_binding",taskConcurrencyLimit:2,createdAt:timestamp,updatedAt:timestamp});
    await store.createProjectCredential({id:"credential_binding",projectId:"project_binding",name:"Provider",type:"api_key",baseUrl:"https://models.example.test/v1",keyId:"test",nonce:Buffer.alloc(12),ciphertext:Buffer.from("ciphertext"),authTag:Buffer.alloc(16),fingerprint:"binding",version:1,createdAt:timestamp,lastRotatedAt:null,updatedAt:timestamp});
    await store.createEndpoint({id:"endpoint_binding",projectId:"project_binding",name:"Endpoint",protocol:"openai_chat_completions",baseUrl:"https://models.example.test/v1",model:"model",credentialId:"credential_binding",capabilities:["text","tool_calls"],requestTimeoutSecs:30,createdAt:timestamp,updatedAt:timestamp});
    await store.createFileLibrary({id:"library_binding",workspaceId:"workspace_binding",projectId:"project_binding",name:"Workspace",rootSubPath:"libraries/library_binding/home",createdByUserId:"user_binding",createdAt:timestamp,updatedAt:timestamp});
  });

  after(async()=>{await store.close();});

  it("allows only one concurrent same-scope binding and atomically releases it on deletion",async()=>{
    assert.deepEqual(await store.createTaskAtomically({task:{...task("task_cross_scope"),projectId:"project_other"},reserveActive:false}),{kind:"library_not_found"});
    const [first,second]=await Promise.all([
      store.createTaskAtomically({task:task("task_binding_one"),reserveActive:false}),
      store.createTaskAtomically({task:task("task_binding_two"),reserveActive:false})
    ]);
    const created=[first,second].flatMap((result)=>result.kind==="created"?[result.task]:[]);
    assert.equal(created.length,1);
    const bound=created[0]!;
    const idempotency={actorId:"user_binding",projectId:"project_binding",operation:"create" as const,key:"create-binding",requestHash:"request-hash",resourceId:bound.id,claimToken:"claim",now:timestamp,leaseExpiresAt:"2026-07-19T00:01:00.000Z"};
    assert.equal((await store.beginTaskIdempotency(idempotency)).kind,"claimed");
    const responseSnapshot={id:bound.id,fileLibraryId:bound.fileLibraryId,status:bound.status};
    assert.equal(await store.completeTaskIdempotency({...idempotency,responseStatus:200,responseBody:responseSnapshot,updatedAt:timestamp}),true);
    assert.equal((await store.archiveTask(bound.id,"2026-07-19T01:00:00.000Z"))?.fileLibraryId,"library_binding");
    assert.equal((await store.deleteTaskData(bound.id,"2026-07-19T02:00:00.000Z"))?.task.fileLibraryId,null);
    const replay=await store.beginTaskIdempotency({...idempotency,claimToken:"replay-claim",now:"2026-07-19T03:00:00.000Z",leaseExpiresAt:"2026-07-19T03:01:00.000Z"});
    assert.deepEqual(replay.kind==="replay"?replay.responseBody:null,responseSnapshot);
    const reused=await store.createTaskAtomically({task:task("task_binding_reused"),reserveActive:false});
    assert.equal(reused.kind==="created"?reused.task.fileLibraryId:null,"library_binding");
  });

  it("atomically creates the initial TaskMessage and reclaims its delivery after restart",async()=>{
    const taskId="task_initial_message";
    const messageId="message_initial_message";
    const initialMessage={id:messageId,taskId,actorId:"user_binding",content:"Initial prompt",deliveryKey:`delivery_message_${messageId}`,requestHash:"request-hash",claimToken:null,receipt:null,timelineCursor:null,deliveryStatus:"pending" as const,claimedAt:null,leaseExpiresAt:null,attemptCount:0,nextRetryAt:null,safeError:null,createdAt:timestamp,updatedAt:timestamp,deletedAt:null};
    const activeTask={...task(taskId),status:"queued" as const,terminalReason:null,terminalizedAt:null};
    const created=await store.createTaskAtomically({task:activeTask,initialMessage,reserveActive:false});
    assert.equal(created.kind,"created");
    assert.deepEqual((await store.listTaskMessages(taskId)).map((item)=>[item.id,item.deliveryKey,item.content]),[[messageId,`delivery_message_${messageId}`,"Initial prompt"]]);
    const claimed=await store.claimTaskMessage({id:messageId,claimToken:"claim-before-restart",claimedAt:timestamp,leaseExpiresAt:"2026-07-19T00:00:01.000Z"});
    assert.equal(claimed?.deliveryStatus,"dispatching");

    const restarted=new PostgresProductStore(postgresUrl);
    try{
      const reclaimed=await restarted.reclaimTaskMessage({id:messageId,expectedClaimToken:"claim-before-restart",claimToken:"claim-after-restart",claimedAt:"2026-07-19T00:00:02.000Z",leaseExpiresAt:"2026-07-19T00:01:02.000Z"});
      assert.equal(reclaimed?.attemptCount,2);
      const accepted=await restarted.recordTaskMessageReceipt({id:messageId,claimToken:"claim-after-restart",receipt:{accepted:true,deliveryKey:`delivery_message_${messageId}`,requestHash:"request-hash",messageId:"botified-message"},timelineCursor:"evt_taskinitialmessage_1",updatedAt:"2026-07-19T00:00:03.000Z"});
      assert.equal(accepted?.deliveryStatus,"accepted");
      assert.equal(accepted?.receipt?.messageId,"botified-message");

      const oldest={...initialMessage,id:"message_race_oldest",deliveryKey:"delivery_message_message_race_oldest",requestHash:"oldest-hash",content:"Oldest",createdAt:"2026-07-19T00:00:04.000Z",updatedAt:"2026-07-19T00:00:04.000Z"};
      const later={...initialMessage,id:"message_race_later",deliveryKey:"delivery_message_message_race_later",requestHash:"later-hash",content:"Later",createdAt:"2026-07-19T00:00:05.000Z",updatedAt:"2026-07-19T00:00:05.000Z"};
      await restarted.createTaskMessage(oldest);
      await restarted.createTaskMessage(later);
      const competitor=new PostgresProductStore(postgresUrl);
      try{
        const claims=await Promise.all([
          restarted.claimTaskMessage({id:oldest.id,claimToken:"oldest-race-claim",claimedAt:"2026-07-19T00:00:06.000Z",leaseExpiresAt:"2026-07-19T00:01:06.000Z"}),
          competitor.claimTaskMessage({id:later.id,claimToken:"later-race-claim",claimedAt:"2026-07-19T00:00:06.000Z",leaseExpiresAt:"2026-07-19T00:01:06.000Z"})
        ]);
        assert.deepEqual(claims.map((item)=>item?.id??null),[oldest.id,null]);
      }finally{await competitor.close();}
    }finally{await restarted.close();}
  });

  it("migrates a Phase 2 archived Task onto its existing initial interaction",async()=>{
    const taskId="task_phase2_archived";
    const cleanupTaskId="task_phase2_cleanup_in_progress";
    const legacyTask={...task(taskId),prompt:"Preserve this prompt",status:"completed" as const,terminalReason:"completed" as const,terminalizedAt:timestamp,archivedAt:"2026-07-19T00:10:00.000Z",executionMode:"live" as const};
    assert.equal((await store.createTaskAtomically({task:legacyTask,reserveActive:false})).kind,"created");
    await store.createFileLibrary({id:"library_cleanup_in_progress",workspaceId:"workspace_binding",projectId:"project_binding",name:"Cleanup in progress",rootSubPath:"libraries/library_cleanup_in_progress/home",createdByUserId:"user_binding",createdAt:timestamp,updatedAt:timestamp});
    const cleanupTask={...task(cleanupTaskId),fileLibraryId:"library_cleanup_in_progress",status:"failed" as const,terminalReason:"failed" as const,terminalizedAt:timestamp,runId:"run_cleanup_in_progress",executionMode:"live" as const};
    assert.equal((await store.createTaskAtomically({task:cleanupTask,reserveActive:false})).kind,"created");
    const legacy=projectTaskInteraction({sourceKind:"product",type:"task_created",taskId,sourceId:`task:${taskId}:prompt`,sourceRevision:1,occurredAt:timestamp,position:1,actorId:"user_binding",messageId:taskId,content:legacyTask.prompt,status:"accepted"}).interaction!;
    const legacyChange:TaskInteractionChangeInput={sourceKind:"product",sourceId:`task:${taskId}:prompt`,sourceRevision:1,interaction:legacy};
    await store.persistTaskInteractionMutation({taskId,changes:[legacyChange]});
    const client=new pg.Client({connectionString:postgresUrl});await client.connect();
    try{
      await client.query("update agent_tasks set start_request_hash='initial-hash',start_receipt=$2::jsonb,start_intent_status='dispatched' where id=$1",[taskId,JSON.stringify({accepted:true,deliveryKey:`delivery_start_${taskId}_run`,requestHash:"initial-hash",messageId:"botified-initial"})]);
      await client.query("insert into postgres_json_docs (collection,id,document,updated_at) values ('sandbox_run_state',$1,$2::jsonb,now()) on conflict (collection,id) do update set document=excluded.document,updated_at=excluded.updated_at",[cleanupTask.runId,JSON.stringify({runId:cleanupTask.runId,taskId:cleanupTask.id,phase:"stopping",cleanupStatus:"cleanup_requested",expiresAt:"2026-07-19T00:00:01.000Z",idleExpiresAt:"2026-07-19T00:00:01.000Z"})]);
      const migration=(await readPostgresMigrations()).find((item)=>item.id==="062_reusable_task_sessions");assert.ok(migration);
      await client.query(migration.sql);
      await client.query("update projects set lifecycle_status='deleting' where id=$1",[cleanupTask.projectId]);
      await client.query("update workspaces set lifecycle_status='deleting' where id=$1",[cleanupTask.workspaceId]);
      const explicitReleaseMigration=(await readPostgresMigrations()).find((item)=>item.id==="063_explicit_task_sandbox_release");assert.ok(explicitReleaseMigration);await client.query(explicitReleaseMigration.sql);
      const runDocument=await client.query<{document:Record<string,unknown>}>("select document from postgres_json_docs where collection='sandbox_run_state' and id=$1",[cleanupTask.runId]);assert.equal("expiresAt" in runDocument.rows[0]!.document,false);assert.equal("idleExpiresAt" in runDocument.rows[0]!.document,false);
    }finally{await client.end();}

    const migrated=(await store.findTask(taskId))!;
    assert.equal(migrated.archivedAt,"2026-07-19T00:10:00.000Z");
    assert.equal(migrated.terminalReason,null);
    assert.equal(migrated.status,"queued");
    assert.equal(migrated.activeReservation,true);
    const cleanupMigrated=(await store.findTask(cleanupTaskId))!;
    assert.equal(cleanupMigrated.status,"queued");
    assert.equal(cleanupMigrated.terminalReason,null);
    assert.equal(cleanupMigrated.activeReservation,true);
    assert.equal((await store.findProject(cleanupMigrated.projectId))?.lifecycleStatus,"active");
    assert.equal((await store.findWorkspace(cleanupMigrated.workspaceId))?.lifecycleStatus,"active");
    assert.equal((await store.findProjectResourceUsage(cleanupMigrated.projectId))?.activeTasks,2);
    const initial=(await store.listTaskMessages(taskId))[0]!;
    assert.equal(initial.id,taskId);
    assert.equal(initial.deliveryKey,`delivery_message_${taskId}`);
    assert.equal(initial.receipt?.messageId,"botified-initial");

    const reconciled=projectTaskInteraction({sourceKind:"product",type:"message_delivery",taskId,sourceId:`message:${taskId}`,sourceRevision:2,occurredAt:migrated.updatedAt,position:2,actorId:"user_binding",messageId:taskId,content:initial.content,status:"accepted"},{interaction:legacy,sourceKind:"product",sourceId:legacyChange.sourceId,sourceRevision:legacyChange.sourceRevision}).interaction!;
    assert.equal(reconciled.id,legacy.id);
    assert.equal(reconciled.position,legacy.position);
    await store.persistTaskInteractionMutation({taskId,changes:[{sourceKind:"product",sourceId:`message:${taskId}`,sourceRevision:2,interaction:reconciled}]});
    const snapshot=await store.readTaskInteractionSnapshot(taskId,null,20);
    assert.equal(snapshot?.items.filter((item)=>item.kind==="user_message").length,1);
  });

  function task(id:string):PersistedAgentTask{return{id,workspaceId:"workspace_binding",projectId:"project_binding",endpointId:"endpoint_binding",fileLibraryId:"library_binding",title:id,prompt:id,status:"completed",runId:`run_${id}`,executionMode:"dry-run",sandbox:{namespace:"agentsmith",resources:[]},terminalReason:"not_executed",terminalizedAt:timestamp,cleanupStatus:"completed",createdAt:timestamp,updatedAt:timestamp};}
});
