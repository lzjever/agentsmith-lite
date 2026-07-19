import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
import type { PersistedAgentTask } from "../../packages/ports/src/store.js";
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

  function task(id:string):PersistedAgentTask{return{id,workspaceId:"workspace_binding",projectId:"project_binding",endpointId:"endpoint_binding",fileLibraryId:"library_binding",title:id,prompt:id,status:"completed",runId:`run_${id}`,executionMode:"dry-run",sandbox:{namespace:"agentsmith",resources:[]},terminalReason:"not_executed",terminalizedAt:timestamp,cleanupStatus:"completed",createdAt:timestamp,updatedAt:timestamp};}
});
