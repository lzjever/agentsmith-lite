import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
import type { PersistedAgentTask, PersistedSandboxRunState } from "../../packages/ports/src/store.js";
import { readPostgresTestUrl } from "./postgres-test-database.js";

const postgresUrl=readPostgresTestUrl();
const postgresDescribe=postgresUrl?describe:describe.skip;

postgresDescribe("postgres Task File Library binding",()=>{
  assert.ok(postgresUrl);
  const store=new PostgresProductStore(postgresUrl);
  const at="2026-07-23T00:00:00.000Z";

  beforeEach(async()=>{
    const client=new pg.Client({connectionString:postgresUrl});await client.connect();
    try{await client.query("truncate table sandbox_usage_settlements,sandbox_runs,task_interaction_changes,task_messages,agent_tasks,file_libraries,model_endpoints,project_credentials,projects,workspaces,users cascade");}finally{await client.end();}
    await store.createUser({id:"user_binding",email:"binding@example.test",emailVerified:true,passwordHash:"hash",createdAt:at,updatedAt:at});
    await store.createWorkspace({id:"workspace_binding",name:"Workspace",ownerUserId:"user_binding",createdAt:at,updatedAt:at});
    await store.createProject({id:"project_binding",workspaceId:"workspace_binding",name:"Project",ownerUserId:"user_binding",rootPath:"workspaces/workspace_binding/projects/project_binding",sandboxLimit:2,createdAt:at,updatedAt:at});
    await store.createProjectCredential({id:"credential_binding",projectId:"project_binding",name:"Provider",type:"api_key",baseUrl:"https://models.example.test/v1",keyId:"test",nonce:Buffer.alloc(12),ciphertext:Buffer.from("ciphertext"),authTag:Buffer.alloc(16),fingerprint:"binding",version:1,createdAt:at,lastRotatedAt:null,updatedAt:at});
    await store.createEndpoint({id:"endpoint_binding",projectId:"project_binding",name:"Endpoint",protocol:"openai_chat_completions",baseUrl:"https://models.example.test/v1",model:"model",credentialId:"credential_binding",capabilities:["text","tool_calls"],requestTimeoutSecs:30,createdAt:at,updatedAt:at});
    await store.createFileLibrary(library());
  });

  after(async()=>{await store.close();});

  it("allows one concurrent binding and releases dependencies only after deletion cleanup",async()=>{
    const firstTask=task("task_binding_one","run_binding_one");
    const secondTask=task("task_binding_two","run_binding_two");
    const results=await Promise.all([
      store.createTaskAtomically({task:firstTask,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},sandboxRun:releasedRun(firstTask)}),
      store.createTaskAtomically({task:secondTask,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},sandboxRun:releasedRun(secondTask)})
    ]);
    assert.deepEqual(results.map((result)=>result.kind).sort(),["already_bound","created"]);
    const bound=results.find((result)=>result.kind==="created");
    assert.ok(bound&&bound.kind==="created");

    const archived=await store.archiveTask(bound.task.id,"2026-07-23T00:01:00.000Z");
    assert.equal(archived.kind,"ready");
    assert.equal((await store.findTaskBoundToFileLibrary("library_binding")).kind,"bound");
    const deleted=await store.beginTaskDeletion(bound.task.id,"2026-07-23T00:02:00.000Z");
    assert.equal(deleted.kind,"ready");
    assert.equal(deleted.kind==="ready"?deleted.value.fileLibraryId:"unexpected","library_binding");
    assert.equal(deleted.kind==="ready"?deleted.value.currentRunId:"unexpected",bound.task.currentRunId);
    assert.equal((await store.findTaskBoundToFileLibrary("library_binding")).kind,"bound");
    assert.equal(await store.deleteFileLibraryIfUnbound("project_binding","library_binding"),"bound");
    assert.equal(await store.deleteEndpoint("endpoint_binding"),"referenced_by_tasks");
    assert.equal(await store.purgeDeletedTaskData(bound.task.id),true);
    assert.equal(await store.findTask(bound.task.id),null);
    assert.equal(await store.deleteFileLibraryIfUnbound("project_binding","library_binding"),"deleted");
    assert.equal(await store.deleteEndpoint("endpoint_binding"),"deleted");
  });

  function task(id:string,currentRunId:string|null=null):PersistedAgentTask{return{id,workspaceId:"workspace_binding",projectId:"project_binding",endpointId:"endpoint_binding",fileLibraryId:"library_binding",createdByUserId:"user_binding",title:"Task",prompt:"Work",agentContext:"",currentRunId,archivedAt:null,deletedAt:null,createdAt:at,updatedAt:at};}
  function library(){return{id:"library_binding",workspaceId:"workspace_binding",projectId:"project_binding",name:"Library",rootSubPath:"libraries/library_binding/home",createdByUserId:"user_binding",createdAt:at,updatedAt:at};}
  function releasedRun(task:PersistedAgentTask):PersistedSandboxRunState{return{workspaceId:task.workspaceId,projectId:task.projectId,taskId:task.id,runId:task.currentRunId!,namespace:"agentsmith",state:"released",image:"botified:test",pvcName:"files",projectSubPath:"workspaces/workspace_binding/projects/project_binding",fileLibraryRootSubPath:"libraries/library_binding/home",fileLibraryId:"library_binding",startedByUserId:"user_binding",startedAt:at,startupReadyAt:at,startupActionDeadlineAt:null,botifiedPort:3099,resourceNames:{pod:`pod-${task.id}`,service:`service-${task.id}`,configMap:`config-${task.id}`,secret:`secret-${task.id}`,serviceAccount:`account-${task.id}`,networkPolicy:`policy-${task.id}`},serviceKeySecretRef:{name:`secret-${task.id}`,key:"BOTIFIED_SERVICE_KEY"},directories:{libraryHome:"/workspace/library",botified:"/workspace/botified"},resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},failureCode:null,failureCause:null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,releaseReason:"requested",releaseRequestedAt:at,failedAt:null,releasedAt:at,createdAt:at,updatedAt:at};}
});
