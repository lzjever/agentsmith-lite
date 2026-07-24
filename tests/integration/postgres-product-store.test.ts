import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
import type { AtomicTaskMessageEditInput, AtomicTaskMessageInput, BeginTaskIdempotencyInput, CompleteTaskIdempotencyInput, PersistedAgentTask, PersistedSandboxRunState, PersistedTaskArtifact, PersistedTaskMessage } from "../../packages/ports/src/store.js";
import { readPostgresTestUrl } from "./postgres-test-database.js";

const postgresUrl=readPostgresTestUrl();
const postgresDescribe=postgresUrl?describe:describe.skip;

postgresDescribe("postgres Phase 3 Task atomicity",()=>{
  assert.ok(postgresUrl);
  const store=new PostgresProductStore(postgresUrl);
  const at="2026-07-23T00:00:00.000Z";

  beforeEach(async()=>{
    const client=new pg.Client({connectionString:postgresUrl});await client.connect();
    try{await client.query("truncate table sandbox_usage_settlements,sandbox_runs,task_interaction_changes,task_messages,task_idempotency_records,agent_tasks,file_libraries,model_endpoints,project_credentials,projects,workspaces,users,postgres_json_docs cascade");}finally{await client.end();}
    await store.createUser({id:"user_atomic",email:"atomic@example.test",emailVerified:true,passwordHash:"hash",createdAt:at,updatedAt:at});
    await store.createWorkspace({id:"workspace_atomic",name:"Workspace",ownerUserId:"user_atomic",createdAt:at,updatedAt:at});
    await store.createProject({id:"project_atomic",workspaceId:"workspace_atomic",name:"Project",ownerUserId:"user_atomic",rootPath:"workspaces/workspace_atomic/projects/project_atomic",taskConcurrencyLimit:1,createdAt:at,updatedAt:at});
    await store.createProjectCredential({id:"credential_atomic",projectId:"project_atomic",name:"Provider",type:"api_key",baseUrl:"https://models.example.test/v1",keyId:"test",nonce:Buffer.alloc(12),ciphertext:Buffer.from("ciphertext"),authTag:Buffer.alloc(16),fingerprint:"atomic",version:1,createdAt:at,lastRotatedAt:null,updatedAt:at});
    await store.createEndpoint({id:"endpoint_atomic",projectId:"project_atomic",name:"Endpoint",protocol:"openai_chat_completions",baseUrl:"https://models.example.test/v1",model:"model",credentialId:"credential_atomic",capabilities:["text","tool_calls"],requestTimeoutSecs:30,createdAt:at,updatedAt:at});
  });

  after(async()=>{await store.close();});

  it("uses stable keysets, ordinal title order, and literal Task search patterns",async()=>{
    const records=[
      {id:"task_page_percent",title:"100%",createdAt:"2026-07-23T00:00:01.000Z"},
      {id:"task_page_percent_wildcard",title:"100x",createdAt:"2026-07-23T00:00:02.000Z"},
      {id:"task_page_zed",title:"Zulu",createdAt:"2026-07-23T00:00:03.000Z"},
      {id:"task_page_underscore",title:"_under",createdAt:"2026-07-23T00:00:04.000Z"},
      {id:"task_page_alpha",title:"alpha",createdAt:"2026-07-23T00:00:04.000Z"},
      {id:"task_page_backslash",title:String.raw`path\name`,createdAt:"2026-07-23T00:00:05.000Z"}
    ];
    for(const record of records){
      const task={...taskRecord(record.id,`library_${record.id}`,"unused"),currentRunId:null,title:record.title,prompt:record.title,createdAt:record.createdAt,updatedAt:record.createdAt};
      assert.equal((await store.createTaskAtomically({task,reserveActive:false,newFileLibrary:library(task.fileLibraryId!,record.title)})).kind,"created");
    }

    const scope={search:"",archived:"exclude" as const,sort:"title" as const,direction:"asc" as const,limit:3};
    const first=await store.queryTasksForProject("project_atomic",scope);
    assert.deepEqual(first.items.map((task)=>task.id),["task_page_percent","task_page_percent_wildcard","task_page_zed"]);
    assert.equal(first.hasMore,true);
    const last=first.items.at(-1)!;
    const second=await store.queryTasksForProject("project_atomic",{...scope,after:{value:last.title!,taskId:last.id}});
    assert.deepEqual(second.items.map((task)=>task.id),["task_page_underscore","task_page_alpha","task_page_backslash"]);
    assert.equal(second.hasMore,false);
    assert.equal(second.total,records.length);

    for(const [search,expected] of [
      ["%",["task_page_percent"]],
      ["_",["task_page_underscore"]],
      ["\\",["task_page_backslash"]]
    ] as const){
      const page=await store.queryTasksForProject("project_atomic",{...scope,search,limit:20});
      assert.deepEqual(page.items.map((task)=>task.id),expected,search);
    }

    const newest=await store.queryTasksForProject("project_atomic",{...scope,sort:"created_at",direction:"desc",limit:2});
    assert.deepEqual(newest.items.map((task)=>task.id),["task_page_backslash","task_page_underscore"]);
    const newestLast=newest.items.at(-1)!;
    const older=await store.queryTasksForProject("project_atomic",{...scope,sort:"created_at",direction:"desc",limit:2,after:{value:newestLast.createdAt,taskId:newestLast.id}});
    assert.deepEqual(older.items.map((task)=>task.id),["task_page_alpha","task_page_zed"]);
  });

  it("pages Artifacts by timestamp and ordinal ID while sharing safe preview kinds",async()=>{
    const task={...taskRecord("task_artifact_page","library_artifact_page","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({task,reserveActive:false,newFileLibrary:library(task.fileLibraryId!,"Artifact page")})).kind,"created");
    const artifacts:PersistedTaskArtifact[]=[
      taskArtifact("artifact_old",task.id,"2026-07-23T00:00:01.000Z","application/octet-stream"),
      taskArtifact("artifact_png",task.id,"2026-07-23T00:00:02.000Z","IMAGE/PNG; charset=binary"),
      taskArtifact("artifact_svg",task.id,"2026-07-23T00:00:02.000Z","image/svg+xml"),
      taskArtifact("artifact_avif",task.id,"2026-07-23T00:00:03.000Z","image/avif")
    ];
    await store.appendTaskArtifacts(artifacts);

    const scope={kind:null,mediaType:null,previewOnly:false,limit:2};
    const first=await store.queryTaskArtifacts(task.id,scope);
    assert.deepEqual(first.items.map((artifact)=>artifact.id),["artifact_avif","artifact_svg"]);
    assert.equal(first.hasMore,true);
    const last=first.items.at(-1)!;
    const second=await store.queryTaskArtifacts(task.id,{...scope,after:{createdAt:last.createdAt,artifactId:last.id}});
    assert.deepEqual(second.items.map((artifact)=>artifact.id),["artifact_png","artifact_old"]);
    assert.equal(second.hasMore,false);
    assert.deepEqual((await store.queryTaskArtifacts(task.id,{...scope,kind:"image",limit:10})).items.map((artifact)=>artifact.id),["artifact_png"]);
    assert.deepEqual((await store.queryTaskArtifacts(task.id,{...scope,kind:"file",limit:10})).items.map((artifact)=>artifact.id),["artifact_avif","artifact_svg","artifact_old"]);
  });

  it("reserves capacity, Task, Run, initial message, and Library atomically under a race",async()=>{
    const inputs=[0,1].map((index)=>{
      const task=taskRecord(`task_reserve_${index}`,`library_reserve_${index}`,`run_reserve_${index}`);
      return{task,reserveActive:true,newFileLibrary:library(task.fileLibraryId!,`Library ${index}`),sandboxRun:run(task,task.currentRunId!,"starting"),initialMessage:message(`message_reserve_${index}`,task.id),auditEvent:{id:`audit_task_create_${task.id}`,projectId:task.projectId,actorId:"user_atomic",action:"task.create" as const,status:"accepted" as const,resourceKind:"task" as const,resourceId:task.id,detail:{taskId:task.id},createdAt:at}} as const;
    });
    const results=await Promise.all(inputs.map((input)=>store.createTaskAtomically(input)));
    assert.deepEqual(results.map((result)=>result.kind).sort(),["capacity_rejected","created"]);
    const winner=results.find((result)=>result.kind==="created");assert.ok(winner&&winner.kind==="created");
    const loser=inputs.find((input)=>input.task.id!==winner.task.id)!;
    assert.equal(await store.findTask(loser.task.id),null);
    assert.equal(await store.findFileLibrary(loser.newFileLibrary.id),null);
    assert.equal(await store.sandboxRuns.get(loser.sandboxRun.runId),null);
    assert.equal(await store.findTaskMessage(loser.initialMessage.id),null);
    assert.equal((await store.findProjectResourceUsage("project_atomic"))?.activeTasks,1);
    assert.deepEqual((await store.listProjectAuditEvents("project_atomic")).filter((event)=>event.action==="task.create").map((event)=>event.resourceId),[winner.task.id]);
  });

  it("lets racing messages share one exact new Run",async()=>{
    const task=taskRecord("task_message","library_message","run_released");
    const released=run(task,task.currentRunId!,"released");
    assert.equal((await store.createTaskAtomically({task,reserveActive:false,newFileLibrary:library(task.fileLibraryId!,"Messages"),sandboxRun:released})).kind,"created");

    const first=atomicMessage(task,released,"first","run_first");
    const second=atomicMessage(task,released,"second","run_second");
    const results=await Promise.all([store.createTaskMessageAtomically(first),store.createTaskMessageAtomically(second)]);
    assert.deepEqual(results.map((result)=>result.kind),["created","created"]);
    const created=results.filter((result)=>result.kind==="created");
    assert.equal(created.filter((result)=>result.restarted).length,1);
    assert.equal(new Set(created.map((result)=>result.task.currentRunId)).size,1);
    assert.equal((await store.listTaskMessages(task.id)).filter((item)=>["message_first","message_second"].includes(item.id)).length,2);
    assert.equal((await store.findProjectResourceUsage(task.projectId))?.activeTasks,1);
    assert.equal((await store.sandboxRuns.listActive()).filter((item)=>item.taskId===task.id).length,1);
    assert.equal((await store.listProjectAuditEvents(task.projectId)).filter((event)=>event.action==="task.message.create").length,2);
  });

  it("reclaims an expired message lease without changing its persisted identity",async()=>{
    const task={...taskRecord("task_reclaim","library_reclaim","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({task,reserveActive:false,newFileLibrary:library(task.fileLibraryId!,"Reclaim")})).kind,"created");
    const replacement={...task,currentRunId:"run_reclaim",updatedAt:"2026-07-23T00:01:00.000Z"};
    const first=atomicMessage(task,{...run(replacement,"run_reclaim","starting"),state:"released",releaseReason:"requested",releaseRequestedAt:at,releasedAt:at},"original","run_reclaim");
    first.expectedCurrentRunId=null;
    first.restart={task:replacement,runtimeState:{botifiedBaseUrl:"http://reclaim"},sandboxRun:run(replacement,"run_reclaim","starting"),reservedAt:replacement.updatedAt};
    first.idempotency={...first.idempotency,resourceId:"message_original",leaseExpiresAt:"2026-07-23T00:01:00.000Z"};
    first.message={...first.message,id:"message_candidate",deliveryKey:"delivery_message_message_candidate"};

    const created=await store.createTaskMessageAtomically(first);
    assert.equal(created.kind,"created");
    const retry:AtomicTaskMessageInput={
      ...first,
      message:{...first.message,id:"message_retry",deliveryKey:"delivery_message_message_retry"},
      idempotency:{...first.idempotency,resourceId:"message_retry",claimToken:"claim_retry",now:"2026-07-23T00:02:00.000Z",leaseExpiresAt:"2026-07-23T00:03:00.000Z"}
    };
    const reclaimed=await store.createTaskMessageAtomically(retry);
    assert.equal(reclaimed.kind,"created");
    assert.equal(reclaimed.kind==="created"?reclaimed.message.id:null,"message_original");
    assert.deepEqual((await store.listTaskMessages(task.id)).map((message)=>message.id),["message_original"]);
    assert.equal((await store.listProjectAuditEvents(task.projectId)).filter((event)=>event.action==="task.message.create").length,1);
  });

  it("completes resource idempotency only for the matching Project and operation",async()=>{
    await store.createProject({id:"project_idempotency_other",workspaceId:"workspace_atomic",name:"Other Project",ownerUserId:"user_atomic",rootPath:"workspaces/workspace_atomic/projects/project_idempotency_other",taskConcurrencyLimit:1,createdAt:at,updatedAt:at});
    const resourceId="message_shared_resource";
    const records=[
      {projectId:"project_atomic",operation:"message" as const,key:"target",requestHash:"target-hash",claimToken:"target-claim"},
      {projectId:"project_atomic",operation:"message-edit" as const,key:"other-operation",requestHash:"other-operation-hash",claimToken:"other-operation-claim"},
      {projectId:"project_idempotency_other",operation:"message" as const,key:"other-project",requestHash:"other-project-hash",claimToken:"other-project-claim"}
    ];
    for(const record of records)assert.equal((await store.beginTaskIdempotency({actorId:"user_atomic",resourceId,now:at,leaseExpiresAt:"2026-07-23T00:05:00.000Z",...record})).kind,"claimed");
    assert.equal(await store.completeTaskIdempotencyForResource({projectId:"project_atomic",operation:"message",resourceId,responseStatus:200,responseBody:{messageId:resourceId},updatedAt:"2026-07-23T00:01:00.000Z"}),1);
    const target=await store.beginTaskIdempotency({actorId:"user_atomic",resourceId,now:"2026-07-23T00:01:00.000Z",leaseExpiresAt:"2026-07-23T00:06:00.000Z",...records[0]!,claimToken:"target-replay"});
    const otherOperation=await store.beginTaskIdempotency({actorId:"user_atomic",resourceId,now:"2026-07-23T00:01:00.000Z",leaseExpiresAt:"2026-07-23T00:06:00.000Z",...records[1]!,claimToken:"other-operation-replay"});
    const otherProject=await store.beginTaskIdempotency({actorId:"user_atomic",resourceId,now:"2026-07-23T00:01:00.000Z",leaseExpiresAt:"2026-07-23T00:06:00.000Z",...records[2]!,claimToken:"other-project-replay"});
    assert.deepEqual(target,{kind:"replay",resourceId,responseStatus:200,responseBody:{messageId:resourceId}});
    assert.deepEqual(otherOperation,{kind:"in_progress",resourceId});
    assert.deepEqual(otherProject,{kind:"in_progress",resourceId});
  });

  it("edits and deletes queued messages with their projection, audit, and replay receipt in one transaction",async()=>{
    const task={...taskRecord("task_message_mutation","library_message_mutation","unused"),currentRunId:null};
    const original=message("message_mutation",task.id);
    assert.equal((await store.createTaskAtomically({
      task,
      reserveActive:false,
      newFileLibrary:library(task.fileLibraryId!,"Message mutation"),
      initialMessage:original
    })).kind,"created");

    const edited={...original,content:"edited",requestHash:"edited-hash",updatedAt:"2026-07-23T00:01:00.000Z"};
    const interaction={
      id:"interaction_message_mutation",
      taskId:task.id,
      kind:"user_message" as const,
      revision:2,
      position:1,
      occurredAt:edited.updatedAt,
      updatedAt:edited.updatedAt,
      title:"You",
      actorId:"user_atomic",
      body:edited.content,
      contentMode:"full" as const,
      status:"pending" as const
    };
    const edit:AtomicTaskMessageEditInput={
      taskId:task.id,
      messageId:original.id,
      content:edited.content,
      requestHash:edited.requestHash,
      expectedUpdatedAt:original.updatedAt!,
      updatedAt:edited.updatedAt,
      interactionChange:{sourceKind:"product",sourceId:`message:${original.id}`,sourceRevision:2,interaction},
      idempotency:{actorId:"user_atomic",projectId:task.projectId,operation:"message-edit",key:"edit-key",requestHash:"edit-request",resourceId:original.id,claimToken:"edit-claim",now:at,leaseExpiresAt:"2026-07-23T00:05:00.000Z"},
      auditEvent:{id:"audit_message_edit",projectId:task.projectId,actorId:"user_atomic",action:"task.message.edit",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,messageId:original.id,deliveryStatus:"pending"},createdAt:edited.updatedAt},
      responseStatus:200,
      responseBody:{messageId:original.id,kind:"edited"}
    };
    assert.equal((await store.editTaskMessageAtomically(edit)).kind,"updated");
    assert.equal((await store.findTaskMessage(original.id))?.content,"edited");
    assert.equal((await store.findLatestTaskInteractionChange(task.id,interaction.id))?.interaction.body,"edited");
    assert.equal((await store.listProjectAuditEvents(task.projectId)).filter((event)=>event.id==="audit_message_edit").length,1);
    const editReplay=await store.editTaskMessageAtomically({...edit,idempotency:{...edit.idempotency,claimToken:"edit-replay"}});
    assert.deepEqual(editReplay,{kind:"replay",responseStatus:200,responseBody:{messageId:original.id,kind:"edited"}});
    const staleEdit=await store.editTaskMessageAtomically({
      ...edit,
      content:"stale overwrite",
      requestHash:"stale-hash",
      idempotency:{...edit.idempotency,key:"stale-edit",requestHash:"stale-edit-request",claimToken:"stale-edit-claim"},
      auditEvent:{...edit.auditEvent,id:"audit_message_stale_edit"}
    });
    assert.equal(staleEdit.kind,"conflict");
    assert.equal((await store.findTaskMessage(original.id))?.content,"edited");
    assert.equal((await store.listProjectAuditEvents(task.projectId)).some((event)=>event.id==="audit_message_stale_edit"),false);

    const deletedAt="2026-07-23T00:02:00.000Z";
    const deletion=await store.deleteTaskMessageAtomically({
      taskId:task.id,
      messageId:original.id,
      deletedAt,
      idempotency:{actorId:"user_atomic",projectId:task.projectId,operation:"message-delete",key:"delete-key",requestHash:"delete-request",resourceId:original.id,claimToken:"delete-claim",now:deletedAt,leaseExpiresAt:"2026-07-23T00:06:00.000Z"},
      auditEvent:{id:"audit_message_delete",projectId:task.projectId,actorId:"user_atomic",action:"task.message.delete",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,messageId:original.id},createdAt:deletedAt},
      responseStatus:200,
      responseBody:{messageId:original.id,kind:"deleted"}
    });
    assert.equal(deletion.kind,"deleted");
    assert.equal((await store.findTaskMessage(original.id))?.deletedAt,deletedAt);
    assert.equal(await store.findLatestTaskInteractionChange(task.id,interaction.id),null);
    assert.equal((await store.listProjectAuditEvents(task.projectId)).filter((event)=>event.id==="audit_message_delete").length,1);
  });

  it("returns not_ready for a live reservation without partially finalizing the Project",async()=>{
    const seeded=await seedProjectDeletionBusinessData();
    const reservation={
      id:"settlement_delete_race",
      projectId:"project_atomic",
      taskId:null,
      endpointId:"endpoint_atomic",
      actorId:"user_atomic",
      reservedTokens:1,
      reservedCost:0.01,
      reservedAt:"2026-07-23T00:01:00.000Z",
      expiresAt:"2026-07-23T00:06:00.000Z"
    };
    const [deletion,reserved]=await Promise.all([
      store.beginProjectDeletion("project_atomic",reservation.reservedAt,"user_atomic"),
      store.reserveProjectProviderSettlement(reservation)
    ]);
    if(reserved){
      assert.equal(deletion.kind,"sandbox_not_released");
      await store.failProjectProviderSettlement(reserved.id,"2026-07-23T00:02:00.000Z");
      assert.equal((await store.beginProjectDeletion("project_atomic","2026-07-23T00:03:00.000Z","user_atomic")).kind,"ready");
    }else{
      assert.equal(deletion.kind,"ready");
    }
    assert.equal(await store.reserveProjectProviderSettlement({...reservation,id:"settlement_after_delete"}),null);

    const client=new pg.Client({connectionString:postgresUrl});await client.connect();
    try{
      await client.query(
        `insert into project_provider_settlements
         (id,project_id,task_id,endpoint_id,actor_id,reserved_tokens,reserved_cost,status,reserved_at,expires_at,updated_at)
         values ($1,$2,null,null,$3,0,0,'reserved',$4,$5,$4)`,
        ["settlement_defensive_guard","project_atomic","user_atomic","2026-07-23T00:04:00.000Z","2026-07-23T00:09:00.000Z"]
      );
      const notReady=await store.finalizeProjectDeletion("project_atomic");
      assert.equal((await store.findProject("project_atomic"))?.lifecycleStatus,"deleting");
      await assertProjectDeletionBusinessDataIsPresent(seeded);
      assert.equal(notReady,"not_ready");
      await client.query("update project_provider_settlements set status='failed' where id='settlement_defensive_guard'");
      assert.equal(await store.finalizeProjectDeletion("project_atomic"),"deleted");
      assert.equal(await store.findProject("project_atomic"),null);
    }finally{
      await client.end();
    }
  });

  it("rolls back every Project dependency when the final Project delete fails",async()=>{
    const seeded=await seedProjectDeletionBusinessData();
    assert.equal((await store.beginProjectDeletion("project_atomic","2026-07-23T00:01:00.000Z","user_atomic")).kind,"ready");
    const client=new pg.Client({connectionString:postgresUrl});await client.connect();
    let failure:unknown;
    try{
      await client.query(`
        create function fail_atomic_project_delete() returns trigger language plpgsql as $$
        begin
          if old.id='project_atomic' then raise exception 'forced atomic Project delete failure';
          end if;
          return old;
        end
        $$
      `);
      await client.query("create trigger fail_atomic_project_delete before delete on projects for each row execute function fail_atomic_project_delete()");
      try{
        await store.finalizeProjectDeletion("project_atomic");
      }catch(error){
        failure=error;
      }
    }finally{
      await client.query("drop trigger if exists fail_atomic_project_delete on projects");
      await client.query("drop function if exists fail_atomic_project_delete()");
      await client.end();
    }

    assert.match(failure instanceof Error?failure.message:"",/forced atomic Project delete failure/);
    assert.equal((await store.findProject("project_atomic"))?.lifecycleStatus,"deleting");
    await assertProjectDeletionBusinessDataIsPresent(seeded);
  });

  it("atomically completes the exact delete claim with PostgreSQL Project finalization",async()=>{
    const seeded=await seedProjectDeletionBusinessData();
    const deleteClaim={
      actorId:"user_atomic",
      projectId:"project_atomic",
      operation:"project.delete" as const,
      key:"project-delete-success",
      requestHash:"project-delete-success-request",
      resourceId:"project_atomic",
      claimToken:"project-delete-success-claim",
      now:"2026-07-23T00:01:00.000Z",
      leaseExpiresAt:"2026-07-23T00:06:00.000Z"
    };
    assert.equal((await store.beginTaskIdempotency(deleteClaim)).kind,"claimed");
    assert.equal((await store.beginProjectDeletion("project_atomic",deleteClaim.now,"user_atomic")).kind,"ready");

    const finalized=await finalizeProjectDeletionWithClaim("project_atomic",completedProjectDeletion(deleteClaim));

    assert.deepEqual(await projectIdempotencyOperations("project_atomic"),["project.delete"]);
    assert.equal(await store.findProject("project_atomic"),null);
    assert.equal(await store.findProjectMembership("project_atomic","user_atomic"),null);
    assert.equal(await store.findTask(seeded.task.id),null);
    assert.equal(await store.findFileLibrary(seeded.task.fileLibraryId!),null);
    assert.equal(await store.findTaskMessage(seeded.message.id),null);
    assert.deepEqual((await store.queryTaskArtifacts(seeded.task.id,{kind:null,mediaType:null,previewOnly:false,limit:100})).items,[]);
    assert.equal(await store.jsonDocs.get("sandbox_runtime_state",seeded.task.id),null);
    assert.equal(finalized,"deleted");
    assert.deepEqual(await store.beginTaskIdempotency({...deleteClaim,claimToken:"project-delete-success-replay"}),{
      kind:"replay",
      resourceId:"project_atomic",
      responseStatus:200,
      responseBody:{deleted:true}
    });
  });

  it("rejects wrong and stale PostgreSQL delete claims without deleting the Project",async()=>{
    const seeded=await seedProjectDeletionBusinessData();
    const original={
      actorId:"user_atomic",projectId:"project_atomic",operation:"project.delete" as const,key:"project-delete-claim-fence",
      requestHash:"project-delete-claim-fence-request",resourceId:"project_atomic",claimToken:"project-delete-old-claim",
      now:"2026-07-23T00:01:00.000Z",leaseExpiresAt:"2026-07-23T00:02:00.000Z"
    };
    assert.equal((await store.beginTaskIdempotency(original)).kind,"claimed");
    assert.equal((await store.beginProjectDeletion("project_atomic",original.now,"user_atomic")).kind,"ready");

    assert.equal(await finalizeProjectDeletionWithClaim("project_atomic",{
      ...completedProjectDeletion(original),claimToken:"project-delete-wrong-claim"
    }),"not_ready");
    assert.equal((await store.findProject("project_atomic"))?.lifecycleStatus,"deleting");
    await assertProjectDeletionBusinessDataIsPresent(seeded);

    const reclaimed={
      ...original,claimToken:"project-delete-current-claim",
      now:"2026-07-23T00:03:00.000Z",leaseExpiresAt:"2026-07-23T00:04:00.000Z"
    };
    assert.deepEqual(await store.beginTaskIdempotency(reclaimed),{
      kind:"claimed",resourceId:"project_atomic",claimToken:reclaimed.claimToken
    });
    assert.equal(await finalizeProjectDeletionWithClaim("project_atomic",completedProjectDeletion(original)),"not_ready");
    assert.equal((await store.findProject("project_atomic"))?.lifecycleStatus,"deleting");
    await assertProjectDeletionBusinessDataIsPresent(seeded);

    assert.equal(await finalizeProjectDeletionWithClaim("project_atomic",completedProjectDeletion(reclaimed)),"deleted");
    assert.deepEqual(await store.beginTaskIdempotency({...reclaimed,claimToken:"project-delete-current-replay"}),{
      kind:"replay",resourceId:"project_atomic",responseStatus:200,responseBody:{deleted:true}
    });
  });

  it("serializes Project deletion against first Run reservation",async()=>{
    const task={...taskRecord("task_delete_run_race","library_delete_run_race","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({
      task,
      reserveActive:false,
      newFileLibrary:library(task.fileLibraryId!,"Run deletion race")
    })).kind,"created");
    const replacement={...task,currentRunId:"run_delete_race",updatedAt:"2026-07-23T00:01:00.000Z"};
    const [restarted,deletion]=await Promise.all([
      store.restartTaskSandboxAtomically({
        expectedReleasedRunId:null,
        task:replacement,
        runtimeState:{botifiedBaseUrl:"http://delete-race"},
        sandboxRun:run(replacement,replacement.currentRunId!,"starting"),
        reservedAt:replacement.updatedAt
      }),
      store.beginProjectDeletion(task.projectId,replacement.updatedAt,"user_atomic")
    ]);
    if(restarted.kind==="restarted"){
      assert.equal(deletion.kind,"sandbox_not_released");
    }else{
      assert.equal(restarted.kind,"conflict");
      assert.equal(deletion.kind,"ready");
      assert.equal((await store.findProjectResourceUsage(task.projectId))?.activeTasks,0);
      assert.equal(await store.sandboxRuns.get(replacement.currentRunId!),null);
    }
  });

  it("lets Project deletion win against Task archive without deadlocking",async()=>{
    const task={...taskRecord("task_project_delete_archive","library_project_delete_archive","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({task,reserveActive:false,newFileLibrary:library(task.fileLibraryId!,"Project delete archive")})).kind,"created");
    assert.equal((await store.beginProjectDeletion(task.projectId,"2026-07-23T00:01:00.000Z","user_atomic")).kind,"ready");

    const auditId="audit_project_delete_archive_loser";
    const [projectResult,archiveResult]=await raceProjectDeletionAgainstTaskOperation(task.projectId,()=>store.archiveTask(task.id,"2026-07-23T00:02:00.000Z",{id:auditId,projectId:task.projectId,actorId:"user_atomic",action:"task.archive",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id},createdAt:"2026-07-23T00:02:00.000Z"}));

    assert.equal(projectResult,"deleted");
    assert.equal(archiveResult.kind,"not_found_or_forbidden");
    assert.equal(await store.findTask(task.id),null);
    assert.equal((await store.listProjectAuditEvents(task.projectId)).some((event)=>event.id===auditId),false);
  });

  it("lets Project deletion win against Task deletion without deadlocking",async()=>{
    const task={...taskRecord("task_project_delete_task","library_project_delete_task","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({task,reserveActive:false,newFileLibrary:library(task.fileLibraryId!,"Project delete task")})).kind,"created");
    assert.equal((await store.beginProjectDeletion(task.projectId,"2026-07-23T00:01:00.000Z","user_atomic")).kind,"ready");

    const auditId="audit_project_delete_task_loser";
    const [projectResult,deleteResult]=await raceProjectDeletionAgainstTaskOperation(task.projectId,()=>store.beginTaskDeletion(task.id,"2026-07-23T00:02:00.000Z",{id:auditId,projectId:task.projectId,actorId:"user_atomic",action:"task.delete",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id},createdAt:"2026-07-23T00:02:00.000Z"}));

    assert.equal(projectResult,"deleted");
    assert.equal(deleteResult.kind,"not_found_or_forbidden");
    assert.equal(await store.findTask(task.id),null);
    assert.equal((await store.listProjectAuditEvents(task.projectId)).some((event)=>event.id===auditId),false);
  });

  it("reserves a first Run and restarts only the exact released Run through one atomic path",async()=>{
    const firstTask={...taskRecord("task_first","library_first","run_unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({
      task:firstTask,
      reserveActive:false,
      newFileLibrary:library(firstTask.fileLibraryId!,"First")
    })).kind,"created");
    const firstReplacement={...firstTask,currentRunId:"run_first",updatedAt:"2026-07-23T00:01:00.000Z"};
    const firstRun=run(firstReplacement,firstReplacement.currentRunId!,"starting");
    const firstInput={
      expectedReleasedRunId:null,
      task:firstReplacement,
      runtimeState:{botifiedBaseUrl:"http://first-task"},
      sandboxRun:firstRun,
      reservedAt:firstReplacement.updatedAt
    };
    assert.equal((await store.restartTaskSandboxAtomically({
      ...firstInput,
      sandboxRun:{...firstRun,projectId:"project_wrong"}
    })).kind,"conflict");
    assert.equal((await store.findProjectResourceUsage(firstTask.projectId))?.activeTasks,0);
    assert.equal((await store.restartTaskSandboxAtomically(firstInput)).kind,"restarted");
    assert.equal((await store.findTask(firstTask.id))?.currentRunId,firstRun.runId);
    assert.equal((await store.findProjectResourceUsage(firstTask.projectId))?.activeTasks,1);
    assert.equal((await store.listTaskMessages(firstTask.id)).length,0);
    assert.equal((await store.restartTaskSandboxAtomically(firstInput)).kind,"conflict");
    assert.equal((await store.restartTaskSandboxAtomically({
      ...firstInput,
      expectedReleasedRunId:firstRun.runId,
      task:{...firstReplacement,currentRunId:"run_after_running"},
      sandboxRun:{...firstRun,runId:"run_after_running"}
    })).kind,"conflict");
    assert.equal((await store.findProjectResourceUsage(firstTask.projectId))?.activeTasks,1);
    const capacityTask={...firstTask,id:"task_capacity",fileLibraryId:"library_capacity"};
    assert.equal((await store.createTaskAtomically({
      task:capacityTask,
      reserveActive:false,
      newFileLibrary:library(capacityTask.fileLibraryId!,"Capacity")
    })).kind,"created");
    const capacityReplacement={...capacityTask,currentRunId:"run_capacity",updatedAt:"2026-07-23T00:01:30.000Z"};
    const capacityRun=run(capacityReplacement,capacityReplacement.currentRunId!,"starting");
    assert.equal((await store.restartTaskSandboxAtomically({
      expectedReleasedRunId:null,
      task:capacityReplacement,
      runtimeState:{botifiedBaseUrl:"http://capacity-task"},
      sandboxRun:capacityRun,
      reservedAt:capacityReplacement.updatedAt
    })).kind,"capacity_rejected");
    assert.equal((await store.findTask(capacityTask.id))?.currentRunId,null);
    assert.equal(await store.sandboxRuns.get(capacityRun.runId),null);
    assert.equal((await store.findProjectResourceUsage(firstTask.projectId))?.activeTasks,1);

    const projectId="project_restart";
    const credentialId="credential_restart";
    const endpointId="endpoint_restart";
    await store.createProject({id:projectId,workspaceId:"workspace_atomic",name:"Restart Project",ownerUserId:"user_atomic",rootPath:"workspaces/workspace_atomic/projects/project_restart",taskConcurrencyLimit:1,createdAt:at,updatedAt:at});
    await store.createProjectCredential({id:credentialId,projectId,name:"Provider",type:"api_key",baseUrl:"https://models.example.test/v1",keyId:"test",nonce:Buffer.alloc(12),ciphertext:Buffer.from("ciphertext"),authTag:Buffer.alloc(16),fingerprint:"restart",version:1,createdAt:at,lastRotatedAt:null,updatedAt:at});
    await store.createEndpoint({id:endpointId,projectId,name:"Endpoint",protocol:"openai_chat_completions",baseUrl:"https://models.example.test/v1",model:"model",credentialId,capabilities:["text","tool_calls"],requestTimeoutSecs:30,createdAt:at,updatedAt:at});
    const releasedTask={...taskRecord("task_restart","library_restart","run_released"),projectId,endpointId};
    const releasedRun=run(releasedTask,releasedTask.currentRunId!,"released");
    assert.equal((await store.createTaskAtomically({
      task:releasedTask,
      reserveActive:false,
      newFileLibrary:{...library(releasedTask.fileLibraryId!,"Restart"),projectId},
      sandboxRun:releasedRun
    })).kind,"created");
    const restartedTask={...releasedTask,currentRunId:"run_restarted",updatedAt:"2026-07-23T00:02:00.000Z"};
    const restartedRun=run(restartedTask,restartedTask.currentRunId!,"starting");
    const restartInput={
      expectedReleasedRunId:releasedRun.runId,
      task:restartedTask,
      runtimeState:{botifiedBaseUrl:"http://restarted-task"},
      sandboxRun:restartedRun,
      reservedAt:restartedTask.updatedAt
    };
    assert.equal((await store.restartTaskSandboxAtomically({...restartInput,expectedReleasedRunId:"run_missing"})).kind,"conflict");
    assert.equal((await store.findProjectResourceUsage(projectId))?.activeTasks,0);
    assert.equal((await store.restartTaskSandboxAtomically(restartInput)).kind,"restarted");
    assert.equal((await store.findTask(releasedTask.id))?.currentRunId,restartedRun.runId);
    assert.equal((await store.findProjectResourceUsage(projectId))?.activeTasks,1);
    assert.equal((await store.listTaskMessages(releasedTask.id)).length,0);
  });

  it("deletes Sandbox Usage and Runs only inside a deleting Project transaction",async()=>{
    const task=taskRecord("task_project_delete","library_project_delete","run_project_delete");
    const pending={
      ...run(task,task.currentRunId!,"starting"),
      state:"release_requested" as const,
      releaseReason:"requested" as const,
      releaseRequestedAt:at,
      modelCa:{configMapName:"provider-ca",configMapKey:"ca.crt",path:"/etc/provider/ca.crt"}
    };
    assert.equal((await store.createTaskAtomically({task,reserveActive:true,newFileLibrary:library(task.fileLibraryId!,"Delete project"),sandboxRun:pending})).kind,"created");
    const releasedAt="2026-07-23T00:01:00.000Z";
    const {networkPolicy,serviceAccount}=pending.resourceNames;
    assert.ok(networkPolicy);
    assert.ok(serviceAccount);
    const released={
      ...pending,
      state:"released" as const,
      releasedAt,
      fencingToken:2,
      updatedAt:releasedAt,
      resourceNames:{networkPolicy,serviceAccount,secret:pending.resourceNames.secret,configMap:pending.resourceNames.configMap,service:pending.resourceNames.service,pod:pending.resourceNames.pod},
      serviceKeySecretRef:{key:pending.serviceKeySecretRef.key,name:pending.serviceKeySecretRef.name},
      directories:{botified:pending.directories.botified,libraryHome:pending.directories.libraryHome},
      resourceLimits:{memoryLimit:pending.resourceLimits.memoryLimit,cpuLimit:pending.resourceLimits.cpuLimit,memoryRequest:pending.resourceLimits.memoryRequest,cpuRequest:pending.resourceLimits.cpuRequest},
      resourceSnapshot:{memoryLimitBytes:pending.resourceSnapshot.memoryLimitBytes,cpuLimitMillis:pending.resourceSnapshot.cpuLimitMillis,memoryRequestBytes:pending.resourceSnapshot.memoryRequestBytes,cpuRequestMillis:pending.resourceSnapshot.cpuRequestMillis},
      modelCa:{path:pending.modelCa.path,configMapKey:pending.modelCa.configMapKey,configMapName:pending.modelCa.configMapName}
    };
    assert.equal(await store.completeSandboxRunRelease({
      runId:pending.runId,
      expectedFencingToken:pending.fencingToken,
      run:released,
      settlement:{runId:pending.runId,workspaceId:pending.workspaceId,projectId:pending.projectId,taskId:pending.taskId,fileLibraryId:pending.fileLibraryId,startedByUserId:pending.startedByUserId,startedAt:null,releasedAt,durationSeconds:0,resources:{memoryLimitBytes:pending.resourceSnapshot.memoryLimitBytes,cpuLimitMillis:pending.resourceSnapshot.cpuLimitMillis,memoryRequestBytes:pending.resourceSnapshot.memoryRequestBytes,cpuRequestMillis:pending.resourceSnapshot.cpuRequestMillis},releaseReason:"requested"},
      auditEvent:{id:"audit_project_delete_release",projectId:task.projectId,actorId:null,subjectUserId:pending.startedByUserId,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:task.id,detail:{taskId:task.id,runId:pending.runId,releaseReason:"requested"},createdAt:releasedAt}
    }),"applied");
    assert.equal((await store.listSandboxUsageSettlements(task.projectId,pending.startedByUserId)).length,1);

    assert.equal((await store.beginProjectDeletion(task.projectId,releasedAt,"user_atomic")).kind,"ready");
    const client=new pg.Client({connectionString:postgresUrl});await client.connect();
    try{
      await client.query("update sandbox_runs set state='release_requested',released_at=null where run_id=$1",[pending.runId]);
      assert.equal(await store.finalizeProjectDeletion(task.projectId),"not_ready");
      await client.query("update sandbox_runs set state='released',released_at=$2 where run_id=$1",[pending.runId,releasedAt]);
    }finally{
      await client.end();
    }
    assert.equal(await store.finalizeProjectDeletion(task.projectId),"deleted");

    assert.equal(await store.findProject(task.projectId),null);
    assert.equal((await store.listSandboxUsageSettlements(task.projectId,pending.startedByUserId)).length,0);
    assert.equal((await store.sandboxRuns.list()).some((candidate)=>candidate.projectId===task.projectId),false);
  });

  it("reads measured file storage, Sandbox Usage summary, and tied history with PostgreSQL parity",async()=>{
    assert.equal((await store.findProjectResourceUsage("project_atomic"))?.projectFileBytesMeasuredAt,null);
    const fileMeasuredAt="2026-07-23T00:00:30.000Z";
    await store.setProjectFileBytes("project_atomic",17,fileMeasuredAt);
    const measuredUsage=await store.findProjectResourceUsage("project_atomic");
    assert.equal(measuredUsage?.projectFileBytes,17);
    assert.equal(measuredUsage?.projectFileBytesMeasuredAt,fileMeasuredAt);
    await store.adjustProjectResourceUsage({projectId:"project_atomic",delta:{activeTasks:0,providerRequests:0,providerTokens:0,providerCost:0,projectFileBytes:1},updatedAt:"2026-07-23T00:00:45.000Z"});
    const projectedUsage=await store.findProjectResourceUsage("project_atomic");
    assert.equal(projectedUsage?.projectFileBytes,18);
    assert.equal(projectedUsage?.projectFileBytesMeasuredAt,fileMeasuredAt);
    const release=async(label:string)=>{
      const task=taskRecord(`task_usage_${label}`,`library_usage_${label}`,`run_usage_${label}`),pending=run(task,task.currentRunId!,"starting");
      assert.equal((await store.createTaskAtomically({task,reserveActive:true,newFileLibrary:library(task.fileLibraryId!,`Usage ${label}`),sandboxRun:pending})).kind,"created");
      if(label==="a"){
        const live=await store.readProjectUsageOverview(usageOverviewReadInput("2026-07-23T00:01:00.000Z"));
        assert.equal(live.kind,"available");
        if(live.kind==="available"){assert.equal(live.value.sandbox.unreleasedCount,1);assert.equal(live.value.sandbox.liveRuns[0]?.state,"starting");assert.equal(live.value.sandbox.liveRuns[0]?.durationSeconds,0)}
      }
      const releasedAt="2026-07-23T00:02:00.000Z",released={...pending,state:"released" as const,releaseReason:"requested" as const,releaseRequestedAt:releasedAt,releasedAt,fencingToken:2,updatedAt:releasedAt};
      assert.equal(await store.completeSandboxRunRelease({runId:pending.runId,expectedFencingToken:1,run:released,settlement:{runId:pending.runId,workspaceId:pending.workspaceId,projectId:pending.projectId,taskId:pending.taskId,fileLibraryId:pending.fileLibraryId,startedByUserId:pending.startedByUserId,startedAt:null,releasedAt,durationSeconds:0,resources:pending.resourceSnapshot,releaseReason:"requested"},auditEvent:{id:`audit_usage_${label}`,projectId:pending.projectId,actorId:null,subjectUserId:pending.startedByUserId,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:pending.taskId,detail:{taskId:pending.taskId,runId:pending.runId,releaseReason:"requested"},createdAt:releasedAt}}),"applied");
      return task;
    };
    await release("a");
    const taskB=await release("b");
    assert.equal((await store.beginTaskDeletion(taskB.id,"2026-07-23T00:03:00.000Z")).kind,"ready");
    const first=await store.querySandboxUsageSettlements({projectId:"project_atomic",selectedUserId:"user_atomic",scopeMeasuredAt:"2026-07-23T00:03:00.000Z",limit:1});
    assert.equal(first.hasMore,true);assert.deepEqual(first.items.map((item)=>[item.runId,item.taskTitle,item.taskAvailable]),[["run_usage_b",null,false]]);
    const second=await store.querySandboxUsageSettlements({projectId:"project_atomic",selectedUserId:"user_atomic",scopeMeasuredAt:"2026-07-23T00:03:00.000Z",after:{releasedAt:first.items[0]!.releasedAt,runId:first.items[0]!.runId},limit:1});
    assert.deepEqual(second.items.map((item)=>item.runId),["run_usage_a"]);assert.equal(second.hasMore,false);
    const summary=await store.readProjectUsageOverview(usageOverviewReadInput("2026-07-23T00:03:00.000Z"));
    assert.equal(summary.kind,"available");if(summary.kind==="available"){assert.equal(summary.value.usage?.projectFileBytesMeasuredAt,fileMeasuredAt);assert.equal(summary.value.sandbox.unreleasedCount,0);assert.equal(summary.value.sandbox.totalDurationMilliseconds,"0");assert.deepEqual(summary.value.sandbox.liveRuns,[])}
  });

  function atomicMessage(task:PersistedAgentTask,released:PersistedSandboxRunState,label:string,newRunId:string):AtomicTaskMessageInput{
    const replacement={...task,currentRunId:newRunId,updatedAt:`2026-07-23T00:01:0${label.length}.000Z`};
    return{taskId:task.id,expectedCurrentRunId:released.runId,message:message(`message_${label}`,task.id),idempotency:{actorId:"user_atomic",projectId:task.projectId,operation:"message",key:`key_${label}`,requestHash:`hash_${label}`,resourceId:`message_${label}`,claimToken:`claim_${label}`,now:at,leaseExpiresAt:"2026-07-23T00:05:00.000Z"},auditEvent:{id:`audit_task_message_create_message_${label}`,projectId:task.projectId,actorId:"user_atomic",action:"task.message.create",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,messageId:`message_${label}`,deliveryStatus:"pending"},createdAt:at},restart:{task:replacement,runtimeState:{botifiedBaseUrl:"http://task"},sandboxRun:run(replacement,newRunId,"starting"),reservedAt:replacement.updatedAt}};
  }

  async function raceProjectDeletionAgainstTaskOperation<T>(projectId:string,operation:()=>Promise<T>):Promise<[unknown,T]>{
    const blocker=new pg.Client({connectionString:postgresUrl});
    await blocker.connect();
    const pending:Promise<unknown>[]=[];
    let blockerCommitted=false;
    try{
      await blocker.query("begin");
      await blocker.query("select id from projects where id=$1 for update",[projectId]);
      const projectDeletion=store.finalizeProjectDeletion(projectId);
      pending.push(projectDeletion);
      await waitForBlockedQuery(blocker,"select * from projects where id=$1 and lifecycle_status='deleting' for update");
      const taskOperation=operation();
      pending.push(taskOperation);
      await blocker.query("commit");
      blockerCommitted=true;
      return await completesWithin(Promise.all([projectDeletion,taskOperation]),5_000);
    }finally{
      if(!blockerCommitted)await blocker.query("rollback").catch(()=>undefined);
      await Promise.allSettled(pending);
      await blocker.end();
    }
  }

  async function waitForBlockedQuery(client:pg.Client,query:string):Promise<void>{
    const deadline=Date.now()+5_000;
    while(Date.now()<deadline){
      const result=await client.query<{count:string}>(
        `select count(*)::text as count
           from pg_locks locks
           join pg_stat_activity activity on activity.pid=locks.pid
          where activity.datname=current_database()
            and activity.pid<>pg_backend_pid()
            and locks.granted=false
            and activity.query=$1`,
        [query]
      );
      if(Number(result.rows[0]?.count??0)>=1)return;
      await new Promise<void>((resolve)=>setImmediate(resolve));
    }
    assert.fail(`Expected blocked PostgreSQL query: ${query}`);
  }

  async function completesWithin<T>(operation:Promise<T>,timeoutMs:number):Promise<T>{
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{
      return await Promise.race([
        operation,
        new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>reject(new Error(`PostgreSQL operation did not complete within ${timeoutMs}ms`)),timeoutMs);})
      ]);
    }finally{
      if(timeout)clearTimeout(timeout);
    }
  }

  function taskRecord(id:string,fileLibraryId:string,currentRunId:string):PersistedAgentTask{return{id,workspaceId:"workspace_atomic",projectId:"project_atomic",endpointId:"endpoint_atomic",fileLibraryId,createdByUserId:"user_atomic",title:"Task",prompt:"Work",agentContext:"",currentRunId,archivedAt:null,deletedAt:null,createdAt:at,updatedAt:at};}
  function library(id:string,name:string){return{id,workspaceId:"workspace_atomic",projectId:"project_atomic",name,rootSubPath:`libraries/${id}/home`,createdByUserId:"user_atomic",createdAt:at,updatedAt:at};}
  function taskArtifact(id:string,taskId:string,createdAt:string,mediaType:string):PersistedTaskArtifact{return{id,taskId,fileId:`file_${id}`,name:id,bytes:1,mediaType,previewText:null,createdAt};}
  function message(id:string,taskId:string):PersistedTaskMessage{return{id,taskId,actorId:"user_atomic",content:id,deliveryKey:`delivery_${id}`,requestHash:`request_${id}`,claimToken:null,receipt:null,timelineCursor:null,deliveryStatus:"pending",claimedAt:null,leaseExpiresAt:null,attemptCount:0,nextRetryAt:null,safeError:null,createdAt:at,updatedAt:at,deletedAt:null};}
  function run(task:PersistedAgentTask,runId:string,state:"starting"|"released"):PersistedSandboxRunState{return{workspaceId:task.workspaceId,projectId:task.projectId,taskId:task.id,runId,namespace:"agentsmith",state,image:"botified:test",pvcName:"files",projectSubPath:"workspaces/workspace_atomic/projects/project_atomic",fileLibraryRootSubPath:`libraries/${task.fileLibraryId}/home`,fileLibraryId:task.fileLibraryId!,startedByUserId:"user_atomic",startedAt:null,botifiedPort:3099,resourceNames:{pod:`pod-${runId}`,service:`service-${runId}`,configMap:`config-${runId}`,secret:`secret-${runId}`,serviceAccount:`account-${runId}`,networkPolicy:`policy-${runId}`},serviceKeySecretRef:{name:`secret-${runId}`,key:"BOTIFIED_SERVICE_KEY"},directories:{libraryHome:"/workspace/library",botified:"/workspace/botified"},resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},failureCode:null,failureCause:null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,releaseReason:state==="released"?"requested":null,releaseRequestedAt:state==="released"?at:null,failedAt:null,releasedAt:state==="released"?at:null,createdAt:at,updatedAt:at};}
  function usageOverviewReadInput(measuredAt:string){const periodStart="2026-06-24T00:00:00.000Z",periodEnd="2026-07-24T00:00:00.000Z";return{projectId:"project_atomic",userId:"user_atomic",selectedUserId:"user_atomic",selectedEndpointId:null,periodStart,periodEnd,measuredAt}}

  async function seedProjectDeletionBusinessData(){
    const task={...taskRecord("task_project_finalize","library_project_finalize","unused"),currentRunId:null};
    const initialMessage=message("message_project_finalize",task.id);
    assert.equal((await store.createTaskAtomically({
      task,
      reserveActive:false,
      newFileLibrary:library(task.fileLibraryId!,"Project finalize"),
      initialMessage,
      runtimeState:{prompt:task.prompt,message:initialMessage.content}
    })).kind,"created");
    await store.appendTaskArtifacts([{
      id:"artifact_project_finalize",taskId:task.id,fileId:"file_project_finalize",name:"result.txt",
      bytes:4,mediaType:"text/plain",previewText:"keep",createdAt:at
    }]);
    const receipts=[
      {
        actorId:"user_atomic",projectId:"project_atomic",operation:"project.settings.update" as const,key:"project-finalize-settings",
        requestHash:"project-finalize-settings-request",resourceId:"project_atomic",claimToken:"project-finalize-settings-claim",
        now:at,leaseExpiresAt:"2026-07-23T00:05:00.000Z"
      },
      {
        actorId:"user_atomic",projectId:"project_atomic",operation:"message" as const,key:"project-finalize-message",
        requestHash:"project-finalize-message-request",resourceId:initialMessage.id,claimToken:"project-finalize-message-claim",
        now:at,leaseExpiresAt:"2026-07-23T00:05:00.000Z"
      }
    ];
    for(const receipt of receipts){
      assert.equal((await store.beginTaskIdempotency(receipt)).kind,"claimed");
      assert.equal(await store.completeTaskIdempotency({
        ...receipt,responseStatus:200,responseBody:{prompt:task.prompt,message:initialMessage.content},updatedAt:at
      }),true);
    }
    return{task,message:initialMessage,receipts};
  }

  async function assertProjectDeletionBusinessDataIsPresent(
    seeded:Awaited<ReturnType<typeof seedProjectDeletionBusinessData>>
  ):Promise<void>{
    assert.ok(await store.findProjectMembership("project_atomic","user_atomic"));
    assert.ok(await store.findTask(seeded.task.id));
    assert.ok(await store.findFileLibrary(seeded.task.fileLibraryId!));
    assert.ok(await store.findTaskMessage(seeded.message.id));
    assert.equal((await store.queryTaskArtifacts(seeded.task.id,{kind:null,mediaType:null,previewOnly:false,limit:100})).items.length,1);
    assert.deepEqual(await store.jsonDocs.get("sandbox_runtime_state",seeded.task.id),{
      prompt:seeded.task.prompt,
      message:seeded.message.content
    });
    for(const receipt of seeded.receipts){
      assert.equal((await store.beginTaskIdempotency({...receipt,claimToken:`replay-${receipt.claimToken}`})).kind,"replay");
    }
  }

  async function projectIdempotencyOperations(projectId:string):Promise<string[]>{
    const client=new pg.Client({connectionString:postgresUrl});await client.connect();
    try{
      const result=await client.query<{operation:string}>(
        "select operation from task_idempotency_records where project_id=$1 order by operation",
        [projectId]
      );
      return result.rows.map((row)=>row.operation);
    }finally{
      await client.end();
    }
  }

  function completedProjectDeletion(claim:BeginTaskIdempotencyInput):CompleteTaskIdempotencyInput{
    return{
      actorId:claim.actorId,projectId:claim.projectId,operation:claim.operation,key:claim.key,
      requestHash:claim.requestHash,claimToken:claim.claimToken,responseStatus:200,responseBody:{deleted:true},updatedAt:claim.now
    };
  }

  function finalizeProjectDeletionWithClaim(
    projectId:string,
    completion:CompleteTaskIdempotencyInput
  ):Promise<"deleted"|"not_ready">{
    return store.finalizeProjectDeletion(projectId,completion);
  }
});
