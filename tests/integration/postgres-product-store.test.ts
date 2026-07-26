import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import pg from "pg";
import type { PoolClient } from "pg";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
import { createCredentialCrypto, credentialAad } from "../../packages/application/src/credentialCrypto.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { ProjectAlertRule } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import type { AtomicTaskMessageEditInput, AtomicTaskMessageInput, BeginTaskIdempotencyInput, BeginTerminalStartInput, CompleteTaskIdempotencyInput, PersistedAgentTask, PersistedSandboxRunState, PersistedTaskArtifact, PersistedTaskMessage } from "../../packages/ports/src/store.js";
import { readPostgresTestUrl } from "./postgres-test-database.js";

const postgresUrl=readPostgresTestUrl();
const postgresDescribe=postgresUrl?describe:describe.skip;

postgresDescribe("postgres Phase 3 Task atomicity",()=>{
  assert.ok(postgresUrl);
  const store=new PostgresProductStore(postgresUrl);
  const at="2026-07-23T00:00:00.000Z";
  const credentialCrypto=createCredentialCrypto({primary:{id:"test",value:Buffer.alloc(32,1)},previous:[]});

  beforeEach(async()=>{
    const client=new pg.Client({connectionString:postgresUrl});await client.connect();
    try{await client.query("truncate table sandbox_usage_settlements,sandbox_runs,task_interaction_changes,task_messages,task_idempotency_records,agent_tasks,file_libraries,model_endpoints,project_credentials,projects,workspaces,users,postgres_json_docs cascade");}finally{await client.end();}
    await store.createUser({id:"user_atomic",email:"atomic@example.test",emailVerified:true,passwordHash:"hash",createdAt:at,updatedAt:at});
    await store.createWorkspace({id:"workspace_atomic",name:"Workspace",ownerUserId:"user_atomic",createdAt:at,updatedAt:at});
    await store.createProject({id:"project_atomic",workspaceId:"workspace_atomic",name:"Project",ownerUserId:"user_atomic",rootPath:"workspaces/workspace_atomic/projects/project_atomic",sandboxLimit:1,createdAt:at,updatedAt:at});
    const encrypted=credentialCrypto.encrypt("atomic-api-key",credentialAad({credentialId:"credential_atomic",projectId:"project_atomic",type:"api_key",version:1}));
    await store.createProjectCredential({id:"credential_atomic",projectId:"project_atomic",name:"Provider",type:"api_key",baseUrl:"https://models.example.test/v1",keyId:encrypted.keyId,nonce:encrypted.nonce,ciphertext:encrypted.ciphertext,authTag:encrypted.authTag,fingerprint:"atomic",version:1,createdAt:at,lastRotatedAt:null,updatedAt:at});
    await store.createEndpoint({id:"endpoint_atomic",projectId:"project_atomic",name:"Endpoint",protocol:"openai_chat_completions",baseUrl:"https://models.example.test/v1",model:"model",credentialId:"credential_atomic",capabilities:["text","tool_calls"],requestTimeoutSecs:30,createdAt:at,updatedAt:at});
  });

  after(async()=>{await store.close();});

  it("projects bounded Context metadata with keysets and exact target isolation",async()=>{
    for(const [index,contextKey] of ["alpha","beta","gamma"].entries()){
      assert.ok(await store.createProjectContextEntry({
        id:`context_page_${index}`,workspaceId:"workspace_atomic",projectId:"project_atomic",ownerUserId:null,
        scope:"project_shared",contextKey,content:index===0?"x".repeat(30*1024):`content ${index}`,contentType:"text",
        version:1,createdAt:at,updatedAt:at
      }));
    }

    const first=await store.listProjectContextEntryMetadataPage({
      workspaceId:"workspace_atomic",projectId:"project_atomic",scope:"project_shared",ownerUserId:null,limit:2
    });
    assert.deepEqual(first.map((entry)=>entry.contextKey),["alpha","beta"]);
    assert.ok(first.every((entry)=>!("content" in entry)));
    const fullFirst=await store.listProjectContextEntryPage({
      workspaceId:"workspace_atomic",projectId:"project_atomic",scope:"project_shared",ownerUserId:null,limit:2
    });
    assert.deepEqual(fullFirst.map((entry)=>entry.contextKey),["alpha","beta"]);
    assert.equal(fullFirst[0]?.content.length,30*1024);
    const second=await store.listProjectContextEntryMetadataPage({
      workspaceId:"workspace_atomic",projectId:"project_atomic",scope:"project_shared",ownerUserId:null,afterContextKey:"beta",limit:2
    });
    assert.deepEqual(second.map((entry)=>entry.contextKey),["gamma"]);
    assert.equal((await store.findProjectContextEntryByKey("workspace_atomic","project_atomic","project_shared",null,"alpha"))?.content.length,30*1024);
    assert.equal(await store.findProjectContextEntryByKey("workspace_atomic","project_atomic","project_shared","user_atomic","alpha"),null);
    assert.equal((await store.findProjectContextEntryById("context_page_0","workspace_atomic","project_atomic","project_shared",null))?.contextKey,"alpha");
    assert.equal(await store.findProjectContextEntryById("context_page_0","workspace_atomic","project_atomic","project_personal","user_atomic"),null);
  });

  it("pages workspace and project directories with exact pin projections",async()=>{
    await store.createProject({id:"project_alpha",workspaceId:"workspace_atomic",name:"Alpha",ownerUserId:"user_atomic",rootPath:"workspaces/workspace_atomic/projects/project_alpha",sandboxLimit:1,createdAt:"2026-07-23T00:00:01.000Z",updatedAt:at});
    await store.createProject({id:"project_beta",workspaceId:"workspace_atomic",name:"beta",ownerUserId:"user_atomic",rootPath:"workspaces/workspace_atomic/projects/project_beta",sandboxLimit:1,createdAt:"2026-07-23T00:00:02.000Z",updatedAt:at});
    assert.equal(await store.setProjectPin("user_atomic","project_beta",at),true);

    const workspaces=await store.listWorkspaceDirectoryPage({userId:"user_atomic",limit:2});
    assert.deepEqual(workspaces.map((workspace)=>[workspace.id,workspace.projectCount]),[["workspace_atomic",3]]);
    assert.equal(await store.countProjectsForUserInWorkspace("user_atomic","workspace_atomic"),3);
    const first=await store.listProjectDirectoryPage({userId:"user_atomic",workspaceId:"workspace_atomic",q:"",limit:2});
    assert.deepEqual(first.items.map((project)=>project.id),["project_beta","project_alpha"]);
    assert.equal(first.total,3);
    const last=first.items.at(-1)!;
    const second=await store.listProjectDirectoryPage({userId:"user_atomic",workspaceId:"workspace_atomic",q:"",after:{pinned:false,name:last.name,id:last.id},limit:2});
    assert.deepEqual(second.items.map((project)=>project.id),["project_atomic"]);
    assert.equal((await store.findProjectDirectoryItem("user_atomic","project_beta"))?.pinnedAt,at);
    assert.equal(await store.findProjectDirectoryItem("missing","project_beta"),null);
  });

  it("keeps bounded membership reads aligned with exact, candidate, batch, and complete fanout paths",async()=>{
    const alphaId="user_member_alpha";
    const highBmpId="user_member_\uE000";
    const astralId="user_member_\u{10000}";
    const candidateId="user_member_candidate";
    const tiedAt="2026-07-23T00:01:00.000Z";
    const members=[
      {id:alphaId,email:"alpha.member@example.test",displayName:"Alpha Person",workspaceRole:"admin" as const,projectRole:"admin" as const,createdAt:"2026-07-23T00:00:30.000Z"},
      {id:highBmpId,email:"high-bmp@example.test",displayName:"High BMP",workspaceRole:"viewer" as const,projectRole:"viewer" as const,createdAt:tiedAt},
      {id:astralId,email:"astral@example.test",displayName:"Astral",workspaceRole:"viewer" as const,projectRole:"viewer" as const,createdAt:tiedAt},
      {id:candidateId,email:"candidate@example.test",displayName:"Candidate Only",workspaceRole:"member" as const,projectRole:null,createdAt:"2026-07-23T00:02:00.000Z"}
    ];
    for(const member of members){
      await store.createUser({id:member.id,email:member.email,emailVerified:true,passwordHash:"hash",createdAt:member.createdAt,updatedAt:member.createdAt});
      await store.upsertUserProfilePreferences({userId:member.id,displayName:member.displayName,timezone:null,bio:null,jobTitle:null,company:null,greetingPreference:null,interests:[],updatedAt:member.createdAt},null);
      await store.upsertWorkspaceMembership({workspaceId:"workspace_atomic",userId:member.id,role:member.workspaceRole,createdAt:member.createdAt,updatedAt:member.createdAt});
      if(member.projectRole)await store.upsertProjectMembership({projectId:"project_atomic",userId:member.id,role:member.projectRole,createdAt:member.createdAt,updatedAt:member.createdAt});
    }

    const workspaceFirst=await store.listWorkspaceMembershipDirectoryPage("workspace_atomic",{q:"",role:null,limit:3});
    assert.deepEqual(workspaceFirst.map((member)=>member.userId),["user_atomic",alphaId,highBmpId]);
    const workspaceSecond=await store.listWorkspaceMembershipDirectoryPage("workspace_atomic",{q:"",role:null,after:{createdAt:workspaceFirst.at(-1)!.createdAt,userId:workspaceFirst.at(-1)!.userId},limit:3});
    assert.deepEqual(workspaceSecond.map((member)=>member.userId),[astralId,candidateId]);
    assert.deepEqual(
      (await store.listWorkspaceMembershipDirectoryPage("workspace_atomic",{q:"alpha person",role:"admin",limit:20})).map((member)=>member.userId),
      [alphaId]
    );

    const projectFirst=await store.listProjectMembershipDirectoryPage("project_atomic",{q:"",role:null,limit:3});
    assert.deepEqual(projectFirst.map((member)=>member.userId),["user_atomic",alphaId,highBmpId]);
    const projectSecond=await store.listProjectMembershipDirectoryPage("project_atomic",{q:"",role:null,after:{createdAt:projectFirst.at(-1)!.createdAt,userId:projectFirst.at(-1)!.userId},limit:3});
    assert.deepEqual(projectSecond.map((member)=>member.userId),[astralId]);
    assert.deepEqual(
      (await store.listProjectMembershipDirectoryPage("project_atomic",{q:"alpha.member",role:"admin",limit:20})).map((member)=>member.userId),
      [alphaId]
    );

    assert.deepEqual(
      await store.findWorkspaceMembershipView("workspace_atomic",alphaId),
      {workspaceId:"workspace_atomic",userId:alphaId,role:"admin",displayName:"Alpha Person",email:"alpha.member@example.test",createdAt:members[0]!.createdAt,updatedAt:members[0]!.createdAt}
    );
    assert.deepEqual(
      await store.findProjectMembershipView("project_atomic",alphaId),
      {projectId:"project_atomic",userId:alphaId,role:"admin",displayName:"Alpha Person",email:"alpha.member@example.test",createdAt:members[0]!.createdAt,updatedAt:members[0]!.createdAt}
    );

    const candidates=await store.listProjectMembershipCandidatesPage("project_atomic",{q:"candidate only",limit:20});
    assert.deepEqual(candidates,[{userId:candidateId,displayName:"Candidate Only",email:"candidate@example.test",createdAt:members[3]!.createdAt}]);
    assert.equal((await store.listProjectMembershipCandidatesPage("project_atomic",{q:"alpha",limit:20})).length,0);

    const identities=await store.findProjectMembershipIdentities("project_atomic",[astralId,alphaId,"user_missing"]);
    assert.deepEqual(new Map(identities.map((identity)=>[identity.userId,identity])),new Map([
      [alphaId,{userId:alphaId,displayName:"Alpha Person",email:"alpha.member@example.test"}],
      [astralId,{userId:astralId,displayName:"Astral",email:"astral@example.test"}]
    ]));
    await assert.rejects(()=>store.findProjectMembershipIdentities("project_atomic",Array.from({length:201},(_,index)=>`user_${index}`)),/exceeds 200 users/);

    const fanout=await store.listProjectMembershipsForFanout("project_atomic");
    assert.equal(projectFirst.length,3);
    assert.deepEqual(fanout.map((member)=>member.userId),["user_atomic",alphaId,highBmpId,astralId]);
  });

  it("keeps endpoint and credential directories, exact reads, readiness, and usage paging aligned with C order",async()=>{
    const tiedAt="2026-07-23T00:03:00.000Z";
    const credentialInput=(id:string,name:string)=>({id,projectId:"project_atomic",name,type:"api_key" as const,baseUrl:"https://models.example.test/v1",keyId:"test",nonce:Buffer.alloc(12),ciphertext:Buffer.from("ciphertext"),authTag:Buffer.alloc(16),fingerprint:id,version:1,createdAt:tiedAt,lastRotatedAt:null,updatedAt:tiedAt});
    await store.createProjectCredential(credentialInput("credential_\uE000","High BMP"));
    await store.createProjectCredential(credentialInput("credential_\u{10000}","Astral"));
    const credentialFirst=await store.listProjectCredentialDirectoryPage("project_atomic",{q:"",limit:1});
    assert.deepEqual(credentialFirst.map((credential)=>credential.id),["credential_\u{10000}"]);
    const credentialSecond=await store.listProjectCredentialDirectoryPage("project_atomic",{q:"",after:{createdAt:credentialFirst[0]!.createdAt,id:credentialFirst[0]!.id},limit:1});
    assert.deepEqual(credentialSecond.map((credential)=>credential.id),["credential_\uE000"]);
    assert.deepEqual((await store.listProjectCredentialDirectoryPage("project_atomic",{q:"high bmp",limit:20})).map((credential)=>credential.id),["credential_\uE000"]);
    const publicCredential=await store.findProjectCredentialView("project_atomic","credential_\uE000");
    assert.equal("ciphertext" in publicCredential!,false);
    assert.ok((await store.findStoredProjectCredential("project_atomic","credential_\uE000"))?.ciphertext);
    assert.equal(await store.findProjectCredentialView("missing","credential_\uE000"),null);

    const endpointInput=(id:string,name:string,credentialId:string,taskReady:boolean)=>({id,projectId:"project_atomic",name,protocol:"openai_chat_completions" as const,baseUrl:"https://models.example.test/v1",model:"model",credentialId,capabilities:taskReady?["text" as const,"tool_calls" as const]:["text" as const],requestTimeoutSecs:30,health:{status:"healthy" as const,checkedAt:tiedAt,errorCategory:null},createdAt:tiedAt,updatedAt:tiedAt});
    await store.createEndpoint(endpointInput("endpoint_\uE000","High BMP","credential_\uE000",true));
    await store.createEndpoint(endpointInput("endpoint_\u{10000}","Astral","credential_\u{10000}",false));
    const endpointFirst=await store.listEndpointDirectoryPage("project_atomic",{q:"",mode:"all",limit:1});
    assert.deepEqual(endpointFirst.items.map((endpoint)=>endpoint.id),["endpoint_\u{10000}"]);
    assert.equal(endpointFirst.total,3);
    const endpointSecond=await store.listEndpointDirectoryPage("project_atomic",{q:"",mode:"all",after:{createdAt:endpointFirst.items[0]!.createdAt,id:endpointFirst.items[0]!.id},limit:1});
    assert.deepEqual(endpointSecond.items.map((endpoint)=>endpoint.id),["endpoint_\uE000"]);
    assert.deepEqual((await store.listEndpointDirectoryPage("project_atomic",{q:"high bmp",mode:"task_ready",limit:20})).items.map((endpoint)=>endpoint.id),["endpoint_\uE000"]);
    assert.equal((await store.findEndpointView("project_atomic","endpoint_\uE000"))?.credential?.name,"High BMP");
    assert.equal(await store.findEndpointView("missing","endpoint_\uE000"),null);
    assert.equal(await store.projectEndpointNameExists("project_atomic","high bmp"),true);
    assert.deepEqual(await store.findProjectEndpointIds("project_atomic",["endpoint_\uE000","missing","endpoint_\uE000"]),["endpoint_\uE000"]);
    assert.deepEqual(await store.getProjectEndpointReadiness("project_atomic"),{total:3,taskReady:1});

    const usageFirst=await store.queryProjectEndpointUsagePage({projectId:"project_atomic",userId:"user_atomic",periodStart:"2026-06-24T00:00:00.000Z",periodEnd:"2026-07-24T00:00:00.000Z",measuredAt:"2026-07-23T00:04:00.000Z",q:"",limit:1});
    assert.deepEqual(usageFirst.items.map((endpoint)=>endpoint.endpointId),["endpoint_\u{10000}"]);
    assert.equal(usageFirst.total,3);
    assert.equal(usageFirst.hasMore,true);
    const usageSecond=await store.queryProjectEndpointUsagePage({projectId:"project_atomic",userId:"user_atomic",periodStart:"2026-06-24T00:00:00.000Z",periodEnd:"2026-07-24T00:00:00.000Z",measuredAt:"2026-07-23T00:04:00.000Z",q:"",after:{createdAt:usageFirst.items[0]!.cursorCreatedAt,id:usageFirst.items[0]!.cursorId},limit:1});
    assert.deepEqual(usageSecond.items.map((endpoint)=>endpoint.endpointId),["endpoint_\uE000"]);
  });

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
      assert.equal((await store.createTaskAtomically({task,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},newFileLibrary:library(task.fileLibraryId!,record.title)})).kind,"created");
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

  it("keeps active and history alert keysets disjoint across tied timestamps",async()=>{
    const tiedAt="2026-07-23T00:01:00.000Z";
    const activeAlerts=[
      ["alert_active_a","sandbox_failure"],
      ["alert_active_b","provider_failure"],
      ["alert_active_c","endpoint_failure"],
    ] as const;
    const activeIds=activeAlerts.map(([id])=>id);
    for(const [id,type] of activeAlerts){
      await store.upsertActiveProjectAlert({id,projectId:"project_atomic",type,status:"active",deliveryStatus:"delivered",createdAt:tiedAt,updatedAt:tiedAt,resolvedAt:null,dismissedAt:null});
    }
    for(const [id,type,status] of [
      ["alert_resolved","sandbox_capacity","resolved"],
      ["alert_dismissed","project_file_bytes_limit","dismissed"],
    ] as const){
      await store.upsertActiveProjectAlert({id,projectId:"project_atomic",type,status:"active",deliveryStatus:"delivered",createdAt:tiedAt,updatedAt:tiedAt,resolvedAt:null,dismissedAt:null});
      assert.ok(await store.transitionProjectAlert("project_atomic",id,status,tiedAt));
    }

    const first=await store.queryProjectAlerts("project_atomic",{view:"active",limit:2});
    assert.equal(first.items.length,2);
    assert.equal(first.activeCount,activeIds.length);
    assert.ok(first.items.every((alert)=>alert.status==="active"));
    assert.equal(first.hasMore,true);
    const last=first.items.at(-1)!;
    const second=await store.queryProjectAlerts("project_atomic",{view:"active",limit:2,after:{createdAt:last.createdAt,id:last.id}});
    const paged=[...first.items,...second.items];
    assert.equal(new Set(paged.map((alert)=>alert.id)).size,activeIds.length);
    assert.deepEqual(new Set(paged.map((alert)=>alert.id)),new Set(activeIds));
    assert.equal(second.hasMore,false);

    const history=await store.queryProjectAlerts("project_atomic",{view:"history",limit:20});
    assert.deepEqual(new Set(history.items.map((alert)=>alert.status)),new Set(["resolved","dismissed"]));
    assert.equal(history.activeCount,activeIds.length);
    assert.equal(history.hasMore,false);
  });

  it("maps public Sandbox capacity alert vocabulary at the PostgreSQL persistence boundary",async()=>{
    const rule:ProjectAlertRule={
      id:"rule_sandbox_capacity",
      projectId:"project_atomic",
      name:"Sandbox capacity",
      alertType:"sandbox_capacity",
      metric:"active_sandboxes",
      condition:"greater_than_or_equal",
      threshold:1,
      windowSeconds:null,
      scope:{kind:"project"},
      enabled:true,
      createdAt:at,
      updatedAt:at
    };
    assert.deepEqual(await store.createProjectAlertRule(rule),rule);
    const alert=await store.upsertActiveProjectAlert({
      id:"alert_sandbox_capacity",
      projectId:"project_atomic",
      type:"sandbox_capacity",
      status:"active",
      deliveryStatus:"not_configured",
      ruleId:rule.id,
      metric:"active_sandboxes",
      metricValue:1,
      threshold:1,
      createdAt:at,
      updatedAt:at,
      resolvedAt:null,
      dismissedAt:null
    });
    assert.deepEqual({type:alert.type,metric:alert.metric},{type:"sandbox_capacity",metric:"active_sandboxes"});

    const client=new pg.Client({connectionString:postgresUrl});
    await client.connect();
    try{
      assert.deepEqual((await client.query("select alert_type,metric from project_alert_rules where id=$1",[rule.id])).rows,[{alert_type:"active_tasks_limit",metric:"active_tasks"}]);
      assert.deepEqual((await client.query("select type,metric from project_alerts where id=$1",[alert.id])).rows,[{type:"active_tasks_limit",metric:"active_tasks"}]);
      await client.query("insert into project_audit_events(id,project_id,actor_id,action,status,resource_kind,resource_id,detail,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",[
        "audit_persisted_sandbox_capacity","project_atomic","user_atomic","sandbox.started","rejected","sandbox","alert_sandbox_capacity",
        {metric:"active_tasks",activeTasks:1,activeTasksLimit:2},at
      ]);
    }finally{await client.end();}
    assert.deepEqual(
      await store.findProjectAlert("project_atomic",alert.id),
      {...alert,endpointId:null,endpointName:null,subjectActorId:null,acknowledgedAt:null,acknowledgedBy:null,silencedUntil:null}
    );
    assert.deepEqual(
      (await store.queryProjectAuditEvents("project_atomic",{resourceId:"alert_sandbox_capacity",limit:20})).items[0]?.detail,
      {metric:"active_sandboxes",activeSandboxes:1,sandboxLimit:2}
    );
  });

  it("normalizes historical completed mutation receipts before service replay",async()=>{
    const services=createApplicationServices({
      store,
      dataRoot:"/tmp/agentsmith-lite-postgres-receipts",
      builtinAdminPassword:"admin-password"
    });
    const client=new pg.Client({connectionString:postgresUrl});
    await client.connect();
    const overwriteReceipt=async(operation:string,key:string,responseBody:unknown)=>{
      const before=await client.query<{request_hash:string}>(
        "select request_hash from task_idempotency_records where actor_id='user_atomic' and project_id='project_atomic' and operation=$1 and idempotency_key=$2 and status='completed'",
        [operation,key]
      );
      assert.equal(before.rowCount,1);
      const updated=await client.query<{request_hash:string}>(
        "update task_idempotency_records set response_body=$3::jsonb where actor_id='user_atomic' and project_id='project_atomic' and operation=$1 and idempotency_key=$2 and status='completed' returning request_hash",
        [operation,key,JSON.stringify(responseBody)]
      );
      assert.equal(updated.rowCount,1);
      assert.equal(updated.rows[0]?.request_hash,before.rows[0]?.request_hash);
    };
    const activeAlert=async(id:string)=>{
      return store.upsertActiveProjectAlert({
        id,
        projectId:"project_atomic",
        type:"sandbox_capacity",
        status:"active",
        deliveryStatus:"delivered",
        metric:"active_sandboxes",
        metricValue:1,
        threshold:1,
        createdAt:at,
        updatedAt:at,
        resolvedAt:null,
        dismissedAt:null
      });
    };

    try{
      const transitionAlert=await activeAlert("alert_receipt_transition");
      await services.policies.transitionAlert("user_atomic","project_atomic",transitionAlert.id,"resolved","transition-receipt-key");
      await overwriteReceipt("project.alert.transition","transition-receipt-key",{
        id:transitionAlert.id,
        limits:{activeTasksLimit:1},
        type:"active_tasks_limit",
        title:"active_tasks"
      });
      assert.deepEqual(
        await services.policies.transitionAlert("user_atomic","project_atomic",transitionAlert.id,"resolved","transition-receipt-key"),
        {id:transitionAlert.id,limits:{activeTasksLimit:1},type:"sandbox_capacity",title:"active_tasks"}
      );

      const acknowledgedAlert=await activeAlert("alert_receipt_acknowledge");
      await services.alertRules.acknowledge("user_atomic","project_atomic",acknowledgedAlert.id,"acknowledge-receipt-key");
      await overwriteReceipt("project.alert.acknowledge","acknowledge-receipt-key",{
        id:acknowledgedAlert.id,
        usage:{activeTasks:1},
        metric:"active_tasks"
      });
      assert.deepEqual(
        await services.alertRules.acknowledge("user_atomic","project_atomic",acknowledgedAlert.id,"acknowledge-receipt-key"),
        {id:acknowledgedAlert.id,usage:{activeTasks:1},metric:"active_sandboxes"}
      );

      const silencedAlert=await activeAlert("alert_receipt_silence");
      const silencedUntil=new Date(Date.now()+86400000).toISOString();
      await services.alertRules.silence("user_atomic","project_atomic",silencedAlert.id,silencedUntil,"silence-receipt-key");
      await overwriteReceipt("project.alert.silence","silence-receipt-key",{
        id:silencedAlert.id,
        nested:[{taskConcurrencyLimit:2},"active_tasks_limit","active_tasks"],
        sentence:"active_tasks and active_tasks_limit remain ordinary copy",
        substring:"prefix_active_tasks_suffix",
        similar:{activeTask:1,taskConcurrencyLimits:2}
      });
      assert.deepEqual(
        await services.alertRules.silence("user_atomic","project_atomic",silencedAlert.id,silencedUntil,"silence-receipt-key"),
        {
          id:silencedAlert.id,
          nested:[{taskConcurrencyLimit:2},"active_tasks_limit","active_tasks"],
          sentence:"active_tasks and active_tasks_limit remain ordinary copy",
          substring:"prefix_active_tasks_suffix",
          similar:{activeTask:1,taskConcurrencyLimits:2}
        }
      );

      const ruleInput={name:"Sandbox capacity",alertType:"sandbox_capacity" as const,enabled:false};
      const rule=await services.alertRules.create("user_atomic","project_atomic",ruleInput,"rule-receipt-key");
      await overwriteReceipt("project.alert-rule.create","rule-receipt-key",{
        id:rule.id,
        alertType:"active_tasks_limit",
        metric:"active_tasks",
        name:"active_tasks",
        context:{alertType:"active_tasks_limit",metric:"active_tasks"},
        content:["active_tasks","active_tasks_limit"]
      });
      assert.deepEqual(
        await services.alertRules.create("user_atomic","project_atomic",ruleInput,"rule-receipt-key"),
        {
          id:rule.id,
          alertType:"sandbox_capacity",
          metric:"active_sandboxes",
          name:"active_tasks",
          context:{alertType:"active_tasks_limit",metric:"active_tasks"},
          content:["active_tasks","active_tasks_limit"]
        }
      );

      const policyInput={sandboxLimit:2};
      await services.policies.updatePolicy("user_atomic","project_atomic",policyInput,"policy-receipt-key");
      await overwriteReceipt("project.policy.update","policy-receipt-key",{
        projectId:"project_atomic",
        activeTasksLimit:2,
        title:"active_tasks",
        context:{activeTasksLimit:9,activeTasks:1,metric:"active_tasks"},
        content:["active_tasks","active_tasks_limit"]
      });
      assert.deepEqual(
        await services.policies.updatePolicy("user_atomic","project_atomic",policyInput,"policy-receipt-key"),
        {
          projectId:"project_atomic",
          sandboxLimit:2,
          title:"active_tasks",
          context:{activeTasksLimit:9,activeTasks:1,metric:"active_tasks"},
          content:["active_tasks","active_tasks_limit"]
        }
      );

      const settingsRequest={name:"Receipt Project",expectedName:"Project"};
      await services.settings.runIdempotentMutation(
        "user_atomic",
        "project_atomic",
        "project.settings.update",
        "settings-receipt-key",
        settingsRequest,
        "project_atomic",
        ()=>services.settings.updateProject("user_atomic","project_atomic",settingsRequest)
      );
      await overwriteReceipt("project.settings.update","settings-receipt-key",{
        project:{
          id:"project_atomic",
          taskConcurrencyLimit:2,
          title:"active_tasks",
          context:{taskConcurrencyLimit:9,activeTasksLimit:3}
        },
        workspaceLifecycleStatus:"active",
        content:["active_tasks","active_tasks_limit"],
        activeTasksLimit:7
      });
      assert.deepEqual(
        await services.settings.runIdempotentMutation(
          "user_atomic",
          "project_atomic",
          "project.settings.update",
          "settings-receipt-key",
          settingsRequest,
          "project_atomic",
          async()=>{throw new Error("settings replay executed the mutation");}
        ),
        {
          project:{
            id:"project_atomic",
            sandboxLimit:2,
            title:"active_tasks",
            context:{taskConcurrencyLimit:9,activeTasksLimit:3}
          },
          workspaceLifecycleStatus:"active",
          content:["active_tasks","active_tasks_limit"],
          activeTasksLimit:7
        }
      );

      await services.settings.runIdempotentProjectLifecycleMutation(
        "user_atomic",
        "project_atomic",
        "project.archive",
        "archive-receipt-key",
        "project.archive",
        ()=>services.settings.archiveProject("user_atomic","project_atomic")
      );
      await overwriteReceipt("project.archive","archive-receipt-key",{
        id:"project_atomic",
        taskConcurrencyLimit:1,
        title:"active_tasks",
        policy:{taskConcurrencyLimit:1}
      });
      assert.deepEqual(
        await services.settings.runIdempotentProjectLifecycleMutation(
          "user_atomic",
          "project_atomic",
          "project.archive",
          "archive-receipt-key",
          "project.archive",
          async()=>{throw new Error("archive replay executed the mutation");}
        ),
        {id:"project_atomic",sandboxLimit:1,title:"active_tasks",policy:{taskConcurrencyLimit:1}}
      );
    }finally{
      await client.end();
    }
  });

  it("replays a persisted historical TaskPresentation create receipt",async()=>{
    const dataRoot=await mkdtemp(path.join(tmpdir(),"asl-postgres-legacy-task-receipt-"));
    try{
      const endpoint=await store.findEndpoint("endpoint_atomic");
      assert.ok(endpoint);
      const checkedAt="2026-07-23T00:00:01.000Z";
      assert.ok(await store.updateEndpointHealth(
        endpoint.id,
        endpoint.projectId,
        {status:"healthy",checkedAt,errorCategory:null},
        checkedAt,
        endpoint.updatedAt
      ));
      const services=createApplicationServices({
        store,
        dataRoot,
        builtinAdminPassword:"admin-password"
      });
      const input={
        endpointId:endpoint.id,
        prompt:"Historical PostgreSQL create receipt",
        fileLibrary:{mode:"create_new" as const,name:"Historical PostgreSQL files"}
      };
      const key="postgres-historical-task-create";
      const created=await services.tasks.createTask("user_atomic","project_atomic",input,key);
      const client=new pg.Client({connectionString:postgresUrl});
      await client.connect();
      try{
        const updated=await client.query(
          "update task_idempotency_records set response_body=$2::jsonb where operation='create' and idempotency_key=$1 and status='completed'",
          [key,JSON.stringify(created)]
        );
        assert.equal(updated.rowCount,1);
      }finally{
        await client.end();
      }

      const replay=await services.tasks.createTask("user_atomic","project_atomic",input,key);
      assert.equal(replay.task.id,created.task.id);
      assert.equal(replay.task.projectId,"project_atomic");
    }finally{
      await rm(dataRoot,{recursive:true,force:true});
    }
  });

  it("pages projected Audit rows and isolates actor and subject identity candidates",async()=>{
    const actorId="user_audit_actor";
    const subjectId="user_audit_subject";
    await store.createUser({id:actorId,email:"actor@example.test",emailVerified:true,passwordHash:"hash",createdAt:at,updatedAt:at});
    await store.createUser({id:subjectId,email:"subject@example.test",emailVerified:true,passwordHash:"hash",createdAt:at,updatedAt:at});
    await store.upsertUserProfilePreferences({userId:actorId,displayName:"Former Actor",timezone:null,bio:null,jobTitle:null,company:null,greetingPreference:null,interests:[],updatedAt:at},null);
    await store.upsertUserProfilePreferences({userId:subjectId,displayName:"Audit Subject",timezone:null,bio:null,jobTitle:null,company:null,greetingPreference:null,interests:[],updatedAt:at},null);
    const tiedAt="2026-07-23T00:01:30.000Z";
    for(let index=0;index<3;index+=1)await store.appendProjectAuditEvent({
      id:`audit_page_${index}`,projectId:"project_atomic",actorId,subjectUserId:subjectId,
      action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:`task_audit_${index}`,createdAt:tiedAt
    });

    const first=await store.queryProjectAuditEvents("project_atomic",{action:"sandbox.failed",limit:2});
    assert.deepEqual(first.items.map((event)=>event.id),["audit_page_2","audit_page_1"]);
    assert.deepEqual(first.items.map((event)=>[event.actorDisplayName,event.actorEmail,event.subjectDisplayName,event.subjectEmail]),[
      ["Former Actor","actor@example.test","Audit Subject","subject@example.test"],
      ["Former Actor","actor@example.test","Audit Subject","subject@example.test"],
    ]);
    assert.equal(first.hasMore,true);
    const last=first.items.at(-1)!;
    const second=await store.queryProjectAuditEvents("project_atomic",{action:"sandbox.failed",after:{createdAt:last.createdAt,id:last.id},limit:2});
    assert.deepEqual(second.items.map((event)=>event.id),["audit_page_0"]);
    assert.equal(second.hasMore,false);
    assert.deepEqual((await store.queryProjectAuditIdentities("project_atomic",{role:"actor",q:"actor",limit:20})).items,[{id:actorId,displayName:"Former Actor",email:"actor@example.test"}]);
    assert.deepEqual((await store.queryProjectAuditIdentities("project_atomic",{role:"subject",q:"subject",limit:20})).items,[{id:subjectId,displayName:"Audit Subject",email:"subject@example.test"}]);
    assert.deepEqual((await store.queryProjectAuditIdentities("project_atomic",{role:"actor",q:"subject",limit:20})).items,[]);
    assert.deepEqual((await store.queryProjectAuditIdentities("project_atomic",{role:"subject",q:"actor",limit:20})).items,[]);
  });

  it("pages Audit identity exact ID matches before ordinary IDs",async()=>{
    const identityIds=["audit","audit_a","audit_b"];
    for(const [index,id] of identityIds.entries()){
      await store.createUser({id,email:`${id}@example.test`,emailVerified:true,passwordHash:"hash",createdAt:at,updatedAt:at});
      await store.appendProjectAuditEvent({
        id:`audit_identity_page_${index}`,projectId:"project_atomic",actorId:id,subjectUserId:"user_atomic",
        action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:`task_identity_page_${index}`,createdAt:at
      });
    }

    const first=await store.queryProjectAuditIdentities("project_atomic",{role:"actor",q:"audit",limit:1});
    assert.deepEqual(first.items.map((identity)=>identity.id),["audit"]);
    assert.equal(first.hasMore,true);

    const second=await store.queryProjectAuditIdentities("project_atomic",{role:"actor",q:"audit",after:{id:first.items[0]!.id},limit:1});
    assert.deepEqual(second.items.map((identity)=>identity.id),["audit_a"]);
    assert.equal(second.hasMore,true);

    const third=await store.queryProjectAuditIdentities("project_atomic",{role:"actor",q:"audit",after:{id:second.items[0]!.id},limit:1});
    assert.deepEqual(third.items.map((identity)=>identity.id),["audit_b"]);
    assert.equal(third.hasMore,false);
  });

  it("keeps endpoint quota fallback identity scoped to the subject actor",async()=>{
    const actorB="user_alert_actor_b";
    await store.createUser({id:actorB,email:"alert-actor-b@example.test",emailVerified:true,passwordHash:"hash",createdAt:at,updatedAt:at});
    const input=(id:string,subjectActorId:string)=>({id,projectId:"project_atomic",type:"provider_requests_limit" as const,status:"active" as const,deliveryStatus:"not_configured" as const,endpointId:"endpoint_atomic",subjectActorId,createdAt:at,updatedAt:at,resolvedAt:null,dismissedAt:null});

    const actorAAlert=await store.upsertActiveProjectAlert(input("alert_actor_a","user_atomic"));
    const actorBAlert=await store.upsertActiveProjectAlert(input("alert_actor_b",actorB));
    assert.deepEqual([actorAAlert.id,actorBAlert.id],["alert_actor_a","alert_actor_b"]);
    assert.equal((await store.findActiveProjectAlert("project_atomic","provider_requests_limit",null,"endpoint_atomic","user_atomic"))?.id,actorAAlert.id);
    assert.equal((await store.findActiveProjectAlert("project_atomic","provider_requests_limit",null,"endpoint_atomic",actorB))?.id,actorBAlert.id);

    assert.ok(await store.transitionProjectAlert("project_atomic",actorBAlert.id,"resolved",at));
    assert.equal((await store.findActiveProjectAlert("project_atomic","provider_requests_limit",null,"endpoint_atomic","user_atomic"))?.id,actorAAlert.id);
  });

  it("admits only one PostgreSQL rule creator into the fiftieth slot",async()=>{
    for(let index=0;index<49;index+=1)await store.createProjectAlertRule(alertRule(`alert_rule_pg_${index}`,"project_atomic"));
    const services=createApplicationServices({store,dataRoot:"/tmp/asl-postgres-alert-rule-cap",builtinAdminPassword:"admin-password"});

    const results=await Promise.allSettled([
      services.alertRules.create("user_atomic","project_atomic",{alertType:"sandbox_failure",enabled:false},"pg-rule-race-a"),
      services.alertRules.create("user_atomic","project_atomic",{alertType:"sandbox_failure",enabled:false},"pg-rule-race-b"),
    ]);

    assert.equal(results.filter((result)=>result.status==="fulfilled").length,1);
    const rejected=results.find((result):result is PromiseRejectedResult=>result.status==="rejected");
    assert.ok(rejected?.reason instanceof ProductError);
    assert.equal((rejected.reason as ProductError).statusCode,409);
    assert.equal((await store.listProjectAlertRules("project_atomic")).length,50);
  });

  it("pages Artifacts by timestamp and ordinal ID while sharing safe preview kinds",async()=>{
    const task={...taskRecord("task_artifact_page","library_artifact_page","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({task,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},newFileLibrary:library(task.fileLibraryId!,"Artifact page")})).kind,"created");
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
      return{task,reserveActive:true,admission:{namespace:"agentsmith",namespaceLimit:10},...createAdmissionReceipt(task,`reserve-${index}`),newFileLibrary:library(task.fileLibraryId!,`Library ${index}`),sandboxRun:run(task,task.currentRunId!,"starting"),initialMessage:message(`message_reserve_${index}`,task.id),auditEvent:{id:`audit_task_create_${task.id}`,projectId:task.projectId,actorId:"user_atomic",action:"task.create" as const,status:"accepted" as const,resourceKind:"task" as const,resourceId:task.id,detail:{taskId:task.id},createdAt:at}} as const;
    });
    const results=await Promise.all(inputs.map((input)=>store.createTaskAtomically(input)));
    assert.deepEqual(results.map((result)=>result.kind).sort(),["capacity_rejected","created"]);
    const winner=results.find((result)=>result.kind==="created");assert.ok(winner&&winner.kind==="created");
    const loser=inputs.find((input)=>input.task.id!==winner.task.id)!;
    assert.equal(await store.findTask(loser.task.id),null);
    assert.equal(await store.findFileLibrary(loser.newFileLibrary.id),null);
    assert.equal(await store.sandboxRuns.get(loser.sandboxRun.runId),null);
    assert.equal(await store.findTaskMessage(loser.initialMessage.id),null);
    assert.equal((await store.findProjectResourceUsage("project_atomic"))?.activeSandboxes,1);
    assert.deepEqual(((await store.queryProjectAuditEvents("project_atomic",{limit:100})).items).filter((event)=>event.action==="task.create"&&event.status==="accepted").map((event)=>event.resourceId),[winner.task.id]);
    const rejected=results.find((result)=>result.kind==="capacity_rejected");
    assert.deepEqual(rejected,{
      kind:"capacity_rejected",
      admission:{kind:"project_capacity_rejected",activeSandboxes:1,sandboxLimit:1},
      responseStatus:409,
      responseBody:{error:{code:"project_sandbox_capacity_reached",message:"Project Sandbox capacity reached",retryable:true,details:{activeSandboxes:1,sandboxLimit:1},presentation:null}}
    });
    const replay=await store.createTaskAtomically({
      ...loser,
      idempotency:{...loser.idempotency,claimToken:"capacity-replay-claim",now:"2026-07-23T00:02:00.000Z",leaseExpiresAt:"2026-07-23T00:03:00.000Z"}
    });
    assert.deepEqual(replay,{kind:"replay",responseStatus:409,responseBody:rejected?.responseBody});
    assert.equal(((await store.queryProjectAuditEvents("project_atomic",{limit:100})).items).filter((event)=>event.id===loser.rejectedAuditEvent.id).length,1);
  });

  it("commits a cold Task business identity with its durable preparation operation",async()=>{
    const task={...taskRecord("task_cold_atomic","library_cold_atomic","unused"),currentRunId:null};
    const initialMessage=message("message_cold_atomic",task.id);
    const idempotency:BeginTaskIdempotencyInput={
      actorId:"user_atomic",
      projectId:task.projectId,
      operation:"create",
      key:"cold-task-create",
      requestHash:"cold-task-create-request",
      resourceId:task.id,
      claimToken:"cold-task-create-claim",
      now:at,
      leaseExpiresAt:"2026-07-23T00:05:00.000Z"
    };
    const created=await store.createTaskAtomically({
      task,
      initialMessage,
      initialInteractionChange:{
        sourceKind:"product",
        sourceId:`message:${initialMessage.id}`,
        sourceRevision:0,
        interaction:{
          id:"interaction_cold_atomic",
          revision:1,
          taskId:task.id,
          kind:"user_message",
          title:"You",
          body:initialMessage.content,
          contentMode:"full",
          position:0,
          occurredAt:at,
          updatedAt:at,
          actorId:"user_atomic",
          status:"accepted"
        }
      },
      newFileLibrary:library(task.fileLibraryId!,"Cold atomic"),
      reserveActive:false,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      idempotency,
      auditEvent:{
        id:"audit_task_cold_atomic",
        projectId:task.projectId,
        actorId:"user_atomic",
        action:"task.create",
        status:"accepted",
        resourceKind:"task",
        resourceId:task.id,
        detail:{taskId:task.id},
        createdAt:at
      }
    });

    assert.equal(created.kind,"created");
    assert.equal((await store.findTask(task.id))?.fileLibraryId,task.fileLibraryId);
    assert.equal((await store.findFileLibrary(task.fileLibraryId!))?.id,task.fileLibraryId);
    assert.equal((await store.findTaskMessage(initialMessage.id))?.taskId,task.id);
    assert.equal(
      (await store.readTaskInteractionSnapshot(task.id,null,20))?.items
        .filter((item)=>item.id==="interaction_cold_atomic").length,
      1
    );
    assert.deepEqual(await store.findTaskIdempotency({
      actorId:idempotency.actorId,
      projectId:idempotency.projectId,
      operation:idempotency.operation,
      key:idempotency.key,
      requestHash:idempotency.requestHash
    }),{kind:"in_progress",resourceId:task.id});
    assert.equal(
      ((await store.queryProjectAuditEvents(task.projectId,{limit:100})).items)
        .filter((event)=>event.id==="audit_task_cold_atomic").length,
      1
    );

    const replacement={...taskRecord("task_cold_replacement","library_cold_replacement","unused"),currentRunId:null};
    const resumed=await store.createTaskAtomically({
      task:replacement,
      newFileLibrary:library(replacement.fileLibraryId!,"Cold replacement"),
      reserveActive:false,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      idempotency:{
        ...idempotency,
        resourceId:replacement.id,
        claimToken:"cold-task-create-reclaimed",
        now:"2026-07-23T00:06:00.000Z",
        leaseExpiresAt:"2026-07-23T00:10:00.000Z"
      }
    });
    assert.equal(resumed.kind,"resume");
    if(resumed.kind==="resume")assert.equal(resumed.task.id,task.id);
    assert.equal(await store.findTask(replacement.id),null);
    assert.equal(await store.findFileLibrary(replacement.fileLibraryId!),null);
  });

  it("reads Task interaction changes and suppression from one repeatable-read snapshot",async()=>{
    const task={...taskRecord("task_change_snapshot","library_change_snapshot","unused"),currentRunId:null};
    const pending=message("message_change_snapshot",task.id);
    const interactionId="interaction_change_snapshot";
    assert.equal((await store.createTaskAtomically({
      task,
      reserveActive:false,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      newFileLibrary:library(task.fileLibraryId!,"Change snapshot"),
      initialMessage:pending,
      initialInteractionChange:{
        sourceKind:"product",
        sourceId:`message:${pending.id}`,
        sourceRevision:0,
        interaction:{
          id:interactionId,
          revision:1,
          taskId:task.id,
          kind:"user_message",
          title:"You",
          body:pending.content,
          contentMode:"full",
          position:0,
          occurredAt:at,
          updatedAt:at,
          actorId:"user_atomic",
          status:"pending"
        }
      }
    })).kind,"created");

    const pool=(store as unknown as {pool:{connect:()=>Promise<PoolClient>}}).pool;
    const connect=pool.connect.bind(pool);
    let changesRead!:()=>void;
    let resumeRead!:()=>void;
    const reachedChanges=new Promise<void>((resolve)=>{changesRead=resolve;});
    const resume=new Promise<void>((resolve)=>{resumeRead=resolve;});
    const statements:string[]=[];
    pool.connect=async()=>{
      const client=await connect();
      const query=client.query.bind(client);
      client.query=(async(statement:unknown,values?:unknown[])=>{
        const sql=typeof statement==="string"?statement:(statement as {text?:string}).text??"";
        statements.push(sql);
        const result=await query(statement as never,values as never);
        if(sql.startsWith("select * from task_interaction_changes where task_id=$1 and change_seq>$2")){
          changesRead();
          await resume;
        }
        return result;
      }) as typeof client.query;
      return client;
    };

    const writer=new PostgresProductStore(postgresUrl);
    try{
      const read=store.readTaskInteractionChangePage(task.id,0,20);
      await reachedChanges;
      const claimedAt="2026-07-23T00:01:00.000Z";
      const claimToken="claim_change_snapshot";
      assert.ok(await writer.claimTaskMessage({
        id:pending.id,
        claimToken,
        claimedAt,
        leaseExpiresAt:"2026-07-23T00:06:00.000Z"
      }));
      assert.ok(await writer.recordTaskMessageReceipt({
        id:pending.id,
        claimToken,
        receipt:{accepted:true,deliveryKey:pending.deliveryKey!,requestHash:pending.requestHash!,messageId:pending.id,cursor:"accepted-cursor"},
        timelineCursor:"accepted-cursor",
        updatedAt:"2026-07-23T00:02:00.000Z"
      }));
      await writer.persistTaskInteractionMutation({
        taskId:task.id,
        changes:[{
          sourceKind:"product",
          sourceId:`message:${pending.id}`,
          sourceRevision:1,
          interaction:{
            id:interactionId,
            revision:2,
            taskId:task.id,
            kind:"user_message",
            title:"You",
            body:pending.content,
            contentMode:"full",
            position:0,
            occurredAt:pending.createdAt,
            updatedAt:"2026-07-23T00:02:00.000Z",
            actorId:"user_atomic",
            status:"accepted"
          }
        }]
      });
      resumeRead();

      const page=await read;
      assert.ok(page);
      assert.equal(statements[0],"begin isolation level repeatable read");
      assert.deepEqual(page.changes.map((change)=>change.changeSeq),[1]);
      assert.equal(page.latestChangeSeq,1);
      assert.equal(page.upperChangeSeq,1);
      assert.deepEqual(page.suppressedInteractionIds,[interactionId]);
      assert.deepEqual(page.queuedMessages.map((queued)=>queued.id),[pending.id]);
    }finally{
      resumeRead();
      pool.connect=connect;
      await writer.close();
    }

    const accepted=await store.readTaskInteractionChangePage(task.id,1,20);
    assert.ok(accepted);
    assert.deepEqual(accepted.changes.map((change)=>[change.changeSeq,change.interaction.revision]),[[2,2]]);
    assert.deepEqual(accepted.suppressedInteractionIds,[]);
    assert.deepEqual(accepted.queuedMessages,[]);
  });

  it("returns the owning PostgreSQL claim with deterministic create rejections",async()=>{
    const unavailableTask={...taskRecord("task_claim_project_unavailable","library_claim_project_unavailable","unused"),currentRunId:null};
    const unavailable=createAdmissionReceipt(unavailableTask,"claim-project-unavailable").idempotency;
    assert.ok(await store.setProjectLifecycleStatus("project_atomic","archived","2026-07-23T00:01:00.000Z"));
    assert.deepEqual(await store.createTaskAtomically({
      task:unavailableTask,
      newFileLibrary:library(unavailableTask.fileLibraryId!,"Unavailable"),
      reserveActive:false,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      idempotency:unavailable
    }),{kind:"project_unavailable",claimToken:unavailable.claimToken});
    assert.deepEqual(await store.findTaskIdempotency({
      actorId:unavailable.actorId,
      projectId:unavailable.projectId,
      operation:unavailable.operation,
      key:unavailable.key,
      requestHash:unavailable.requestHash
    }),{kind:"in_progress",resourceId:unavailableTask.id});

    assert.ok(await store.setProjectLifecycleStatus("project_atomic","active","2026-07-23T00:02:00.000Z"));
    await store.createFileLibrary(library("library_claim_conflict_existing","Taken after prevalidation"));
    const conflictTask={...taskRecord("task_claim_library_conflict","library_claim_library_conflict","unused"),currentRunId:null};
    const conflict=createAdmissionReceipt(conflictTask,"claim-library-conflict").idempotency;
    assert.deepEqual(await store.createTaskAtomically({
      task:conflictTask,
      newFileLibrary:library(conflictTask.fileLibraryId!," taken AFTER prevalidation "),
      reserveActive:false,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      idempotency:conflict
    }),{kind:"library_name_conflict",claimToken:conflict.claimToken});
    assert.deepEqual(await store.findTaskIdempotency({
      actorId:conflict.actorId,
      projectId:conflict.projectId,
      operation:conflict.operation,
      key:conflict.key,
      requestHash:conflict.requestHash
    }),{kind:"in_progress",resourceId:conflictTask.id});
  });

  it("rolls back every Task create identity when the final Audit insert fails",async()=>{
    const task=taskRecord("task_create_rollback","library_create_rollback","run_create_rollback");
    const sandboxRun=run(task,task.currentRunId!,"starting");
    const initialMessage=message("message_create_rollback",task.id);
    const receipt=createAdmissionReceipt(task,"rollback");
    await assert.rejects(()=>store.createTaskAtomically({
      task,
      reserveActive:true,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      ...receipt,
      newFileLibrary:library(task.fileLibraryId!,"Rollback"),
      sandboxRun,
      runtimeState:{botifiedBaseUrl:"http://rollback"},
      initialMessage,
      initialInteractionChange:{
        sourceKind:"product",
        sourceId:`message:${initialMessage.id}`,
        sourceRevision:0,
        interaction:{
          id:"interaction_create_rollback",
          revision:1,
          taskId:task.id,
          kind:"user_message",
          title:"You",
          body:initialMessage.content,
          contentMode:"full",
          position:0,
          occurredAt:at,
          updatedAt:at,
          actorId:"user_atomic",
          status:"pending"
        }
      },
      auditEvent:{
        id:"audit_task_create_rollback",
        projectId:task.projectId,
        actorId:"user_missing",
        action:"task.create",
        status:"accepted",
        resourceKind:"task",
        resourceId:task.id,
        detail:{taskId:task.id},
        createdAt:at
      }
    }));

    assert.equal(await store.findTask(task.id),null);
    assert.equal(await store.findFileLibrary(task.fileLibraryId!),null);
    assert.equal(await store.sandboxRuns.get(sandboxRun.runId),null);
    assert.equal(await store.findTaskMessage(initialMessage.id),null);
    assert.equal(await store.readTaskInteractionSnapshot(task.id,null,20),null);
    assert.equal(await store.jsonDocs.get("sandbox_runtime_state",task.id),null);
    assert.equal(
      ((await store.queryProjectAuditEvents("project_atomic",{limit:100})).items)
        .some((event)=>event.id==="audit_task_create_rollback"),
      false
    );
    assert.equal(await store.findTaskIdempotency({
      actorId:receipt.idempotency.actorId,
      projectId:receipt.idempotency.projectId,
      operation:receipt.idempotency.operation,
      key:receipt.idempotency.key,
      requestHash:receipt.idempotency.requestHash
    }),null);
  });

  it("does not hold PostgreSQL Task or Run locks while the startup operation runs",async()=>{
    const task=taskRecord("task_startup_lock","library_startup_lock","run_startup_lock");
    const starting=run(task,task.currentRunId!,"starting");
    assert.equal((await store.createTaskAtomically({
      task,
      reserveActive:true,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      ...createAdmissionReceipt(task,"startup-lock"),
      newFileLibrary:library(task.fileLibraryId!,"Startup lock"),
      sandboxRun:starting
    })).kind,"created");
    let entered!:()=>void;
    let unblock!:()=>void;
    const operationEntered=new Promise<void>((resolve)=>{entered=resolve;});
    const operationBlocked=new Promise<void>((resolve)=>{unblock=resolve;});
    assert.ok(await store.markTaskSandboxStartupReady({
      taskId:task.id,runId:starting.runId,expectedFencingToken:starting.fencingToken,readyAt:at
    }));
    assert.equal((await store.claimSandboxStartup({
      taskId:task.id,
      runId:starting.runId,
      expectedFencingToken:starting.fencingToken,
      claimToken:"startup-lock-claim",
      claimedAt:at,
      leaseExpiresAt:"2026-07-23T00:05:00.000Z"
    })).kind,"claimed");
    const startup=(async()=>{entered();await operationBlocked;return"applied";})();
    await operationEntered;
    const failedAt="2026-07-23T00:01:00.000Z";
    const failure=store.failSandboxRun({
      runId:starting.runId,
      expectedFencingToken:starting.fencingToken,
      code:"startup_failed",
      message:"fixture failure",
      failedAt,
      auditEvent:{id:"audit_startup_lock_failed",projectId:task.projectId,actorId:null,subjectUserId:"user_atomic",action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:task.id,detail:{taskId:task.id,runId:starting.runId},createdAt:failedAt}
    });
    const failureCompleted=await settlesWithin(failure,2_000);
    unblock();
    assert.equal(failureCompleted,true);
    assert.equal((await failure)?.state,"failed");
    assert.equal(await startup,"applied");
  });

  it("admits one mixed cold-start winner across Projects in a saturated namespace",async()=>{
    await createProjectFixture("project_restart");
    await createProjectFixture("project_message");
    const createTask=projectTask("task_namespace_create","project_atomic","run_namespace_create");
    const restartTask={...projectTask("task_namespace_restart","project_restart","unused"),currentRunId:null};
    const messageTask=projectTask("task_namespace_message","project_message","run_namespace_released");
    const releasedRun=run(messageTask,messageTask.currentRunId!,"released");
    assert.equal((await store.createTaskAtomically({task:restartTask,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},newFileLibrary:projectLibrary(restartTask,"Restart")})).kind,"created");
    assert.equal((await store.createTaskAtomically({task:messageTask,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},newFileLibrary:projectLibrary(messageTask,"Message"),sandboxRun:releasedRun})).kind,"created");

    const createRun=run(createTask,createTask.currentRunId!,"starting");
    const restartReplacement={...restartTask,currentRunId:"run_namespace_restart",updatedAt:"2026-07-23T00:01:00.000Z"};
    const restartRun=run(restartReplacement,restartReplacement.currentRunId!,"starting");
    const messageInput={...atomicMessage(messageTask,releasedRun,"namespace","run_namespace_message"),admission:{namespace:"agentsmith",namespaceLimit:1}};
    const results=await Promise.all([
      store.createTaskAtomically({task:createTask,reserveActive:true,admission:{namespace:"agentsmith",namespaceLimit:1},...createAdmissionReceipt(createTask,"namespace-create"),newFileLibrary:projectLibrary(createTask,"Create"),sandboxRun:createRun}),
      store.restartTaskSandboxAtomically({expectedReleasedRunId:null,task:restartReplacement,runtimeState:{botifiedBaseUrl:"http://restart"},sandboxRun:restartRun,reservedAt:restartReplacement.updatedAt,admission:{namespace:"agentsmith",namespaceLimit:1},...restartAdmissionReceipt(restartReplacement,"namespace-restart")}),
      store.createTaskMessageAtomically(messageInput)
    ]);

    assert.equal(results.filter((result)=>result.kind==="created"||result.kind==="restarted").length,1);
    assert.equal(results.filter((result)=>result.kind==="capacity_rejected"&&result.admission.kind==="substrate_capacity_rejected").length,2);
    assert.equal((await store.sandboxRuns.list()).filter((candidate)=>candidate.namespace==="agentsmith"&&candidate.state!=="released").length,1);
    const usages=await Promise.all(["project_atomic","project_restart","project_message"].map((projectId)=>store.findProjectResourceUsage(projectId)));
    assert.equal(usages.reduce((total,usage)=>total+(usage?.activeSandboxes??0),0),1);
    for(const [index,candidate] of [createRun,restartRun,messageInput.restart!.sandboxRun].entries()){
      if(results[index]?.kind==="capacity_rejected")assert.equal(await store.sandboxRuns.get(candidate.runId),null);
    }
    if(results[2]?.kind==="capacity_rejected"){
      assert.equal(await store.findTaskMessage(messageInput.message.id),null);
      assert.equal(((await store.queryProjectAuditEvents(messageTask.projectId,{limit:100})).items).some((event)=>event.id===messageInput.auditEvent.id),false);
    }
  });

  it("serializes release finalization against namespace admission with absolute usage",async()=>{
    await createProjectFixture("project_release_target");
    const occupiedTask=taskRecord("task_release_race","library_release_race","run_release_race");
    const occupied={...run(occupiedTask,occupiedTask.currentRunId!,"starting"),state:"release_requested" as const,releaseReason:"requested" as const,releaseRequestedAt:at};
    assert.equal((await store.createTaskAtomically({task:occupiedTask,reserveActive:true,admission:{namespace:"agentsmith",namespaceLimit:1},...createAdmissionReceipt(occupiedTask,"release-race"),newFileLibrary:library(occupiedTask.fileLibraryId!,"Release race"),sandboxRun:occupied})).kind,"created");
    const target={...projectTask("task_release_target","project_release_target","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({task:target,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},newFileLibrary:projectLibrary(target,"Target")})).kind,"created");
    const replacement={...target,currentRunId:"run_release_target",updatedAt:"2026-07-23T00:02:00.000Z"};
    const replacementRun=run(replacement,replacement.currentRunId!,"starting");
    const releasedAt="2026-07-23T00:01:00.000Z";
    const released={...occupied,state:"released" as const,releasedAt,fencingToken:occupied.fencingToken+1,updatedAt:releasedAt};

    const [releaseResult,admissionResult]=await Promise.all([
      store.completeSandboxRunRelease({
        runId:occupied.runId,expectedFencingToken:occupied.fencingToken,run:released,
        settlement:{runId:occupied.runId,workspaceId:occupied.workspaceId,projectId:occupied.projectId,taskId:occupied.taskId,fileLibraryId:occupied.fileLibraryId,startedByUserId:occupied.startedByUserId,startedAt:null,releasedAt,durationSeconds:0,resources:occupied.resourceSnapshot,releaseReason:"requested"},
        auditEvent:{id:"audit_release_race",projectId:occupied.projectId,actorId:null,subjectUserId:occupied.startedByUserId,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:occupied.taskId,detail:{taskId:occupied.taskId,runId:occupied.runId,releaseReason:"requested"},createdAt:releasedAt}
      }),
      store.restartTaskSandboxAtomically({expectedReleasedRunId:null,task:replacement,runtimeState:{botifiedBaseUrl:"http://release-target"},sandboxRun:replacementRun,reservedAt:replacement.updatedAt,admission:{namespace:"agentsmith",namespaceLimit:1},...restartAdmissionReceipt(replacement,"release-target")})
    ]);

    assert.equal(releaseResult,"applied");
    assert.ok(admissionResult.kind==="restarted"||admissionResult.kind==="capacity_rejected");
    assert.ok((await store.sandboxRuns.list()).filter((candidate)=>candidate.namespace==="agentsmith"&&candidate.state!=="released").length<=1);
    assert.equal((await store.findProjectResourceUsage(occupied.projectId))?.activeSandboxes,0);
    assert.equal((await store.findProjectResourceUsage(target.projectId))?.activeSandboxes,admissionResult.kind==="restarted"?1:0);
  });

  it("keeps Sandbox-limit policy updates namespace-free while admission waits",async()=>{
    const task={...taskRecord("task_policy_lock","library_policy_lock","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({task,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},newFileLibrary:library(task.fileLibraryId!,"Policy lock")})).kind,"created");
    const replacement={...task,currentRunId:"run_policy_lock",updatedAt:"2026-07-23T00:01:00.000Z"};
    const replacementRun=run(replacement,replacement.currentRunId!,"starting");
    const blocker=new pg.Client({connectionString:postgresUrl});
    await blocker.connect();
    let committed=false;
    try{
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))",["agentsmith-lite:sandbox:agentsmith"]);
      const policy=store.patchProjectResourcePolicy(task.projectId,{sandboxLimit:2},at);
      assert.equal((await completesWithin(policy,2_000))?.sandboxLimit,2);
      const admission=store.restartTaskSandboxAtomically({expectedReleasedRunId:null,task:replacement,runtimeState:{botifiedBaseUrl:"http://policy-lock"},sandboxRun:replacementRun,reservedAt:replacement.updatedAt,admission:{namespace:"agentsmith",namespaceLimit:1},...restartAdmissionReceipt(replacement,"policy-lock")});
      assert.equal(await settlesWithin(admission,50),false);
      await blocker.query("commit");
      committed=true;
      assert.equal((await completesWithin(admission,5_000)).kind,"restarted");
    }finally{
      if(!committed)await blocker.query("rollback").catch(()=>undefined);
      await blocker.end();
    }
  });

  it("lets racing messages share one exact new Run",async()=>{
    const task=taskRecord("task_message","library_message","run_released");
    const released=run(task,task.currentRunId!,"released");
    assert.equal((await store.createTaskAtomically({task,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},newFileLibrary:library(task.fileLibraryId!,"Messages"),sandboxRun:released})).kind,"created");

    const first=atomicMessage(task,released,"first","run_first");
    const second=atomicMessage(task,released,"second","run_second");
    const results=await Promise.all([store.createTaskMessageAtomically(first),store.createTaskMessageAtomically(second)]);
    assert.deepEqual(results.map((result)=>result.kind),["created","created"]);
    const created=results.filter((result)=>result.kind==="created");
    assert.equal(created.filter((result)=>result.restarted).length,1);
    assert.equal(new Set(created.map((result)=>result.task.currentRunId)).size,1);
    assert.equal((await store.listTaskMessages(task.id)).filter((item)=>["message_first","message_second"].includes(item.id)).length,2);
    assert.equal((await store.findProjectResourceUsage(task.projectId))?.activeSandboxes,1);
    assert.equal((await store.sandboxRuns.listActive()).filter((item)=>item.taskId===task.id).length,1);
    assert.equal(((await store.queryProjectAuditEvents(task.projectId,{limit:100})).items).filter((event)=>event.action==="task.message.create").length,2);
  });

  it("converges concurrent Terminal and message restarts without PostgreSQL deadlock",async()=>{
    const terminalStore=fixtureStore("terminal-message-terminal");
    const messageStore=fixtureStore("terminal-message-message");
    const task=taskRecord("task_terminal_message_race","library_terminal_message_race","run_terminal_message_released");
    const released=run(task,task.currentRunId!,"released");
    assert.equal((await store.createTaskAtomically({
      task,reserveActive:false,admission:{namespace:"agentsmith",namespaceLimit:100},
      newFileLibrary:library(task.fileLibraryId!,"Terminal message race"),sandboxRun:released
    })).kind,"created");
    const terminalTask={...task,currentRunId:"run_terminal_race",updatedAt:"2026-07-23T00:01:10.000Z"};
    const terminalRun=run(terminalTask,terminalTask.currentRunId!,"starting");
    const terminalInput:BeginTerminalStartInput={
      taskId:task.id,
      idempotency:{
        actorId:"user_atomic",projectId:task.projectId,operation:"terminal-start",
        key:"terminal-message-race-terminal",requestHash:"terminal-message-race-terminal-hash",
        resourceId:terminalRun.runId,claimToken:"terminal-message-race-terminal-claim",
        now:at,leaseExpiresAt:"2026-07-23T00:05:00.000Z"
      },
      admission:{namespace:"agentsmith",namespaceLimit:100},
      restart:{
        expectedReleasedRunId:released.runId,task:terminalTask,
        runtimeState:{botifiedBaseUrl:"http://terminal-race"},
        sandboxRun:terminalRun,reservedAt:terminalTask.updatedAt
      },
      rejectionPresentation:{} as import("../../packages/contracts/src/api.js").TaskPresentation,
      rejectedAuditEvent:{
        id:"audit_terminal_message_race_terminal_rejected",projectId:task.projectId,
        actorId:"user_atomic",action:"sandbox.started",status:"rejected",
        resourceKind:"sandbox",resourceId:task.id,
        detail:{taskId:task.id,trigger:"terminal"},createdAt:at
      }
    };
    const messageInput=atomicMessage(task,released,"tmrace","run_message_race");
    const blocker=fixtureClient("terminal-message-blocker");
    const observer=fixtureClient("terminal-message-observer");
    await blocker.connect();
    await observer.connect();
    const pending:Promise<unknown>[]=[];
    let blockerCommitted=false;
    let terminalResult:Awaited<ReturnType<typeof store.beginTerminalStart>>;
    let messageResult:Awaited<ReturnType<typeof store.createTaskMessageAtomically>>;
    try{
      await blocker.query("begin");
      const blockerPid=(await blocker.query<{pid:number}>("select pg_backend_pid() as pid")).rows[0]!.pid;
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))",["agentsmith-lite:sandbox:agentsmith"]);
      const messageOperation=messageStore.createTaskMessageAtomically(messageInput);
      pending.push(messageOperation);
      const messagePid=await waitForBlockedOperation(observer,{
        expectedBlockers:[{pid:blockerPid,state:"idle in transaction",waitEventType:"Client"}],
        applicationName:"terminal-message-message",waitEvent:"advisory",
        queryFragment:"pg_advisory_xact_lock",name:"message restart",operation:messageOperation
      });
      const terminalOperation=terminalStore.beginTerminalStart(terminalInput);
      pending.push(terminalOperation);
      await waitForBlockedOperation(observer,{
        expectedBlockers:[
          {pid:blockerPid,state:"idle in transaction",waitEventType:"Client"},
          {pid:messagePid,state:"active",waitEventType:"Lock"}
        ],
        applicationName:"terminal-message-terminal",waitEvent:"advisory",
        queryFragment:"pg_advisory_xact_lock",name:"Terminal restart",operation:terminalOperation
      });
      await blocker.query("commit");
      blockerCommitted=true;
      [terminalResult,messageResult]=await completesWithoutDeadlock(
        Promise.all([terminalOperation,messageOperation]),
        5_000
      );
    }finally{
      if(!blockerCommitted)await blocker.query("rollback").catch(()=>undefined);
      await Promise.allSettled(pending);
      await blocker.end();
      await observer.end();
      await terminalStore.close();
      await messageStore.close();
    }

    assert.ok(terminalResult.kind==="claimed"||terminalResult.kind==="replay");
    if(terminalResult.kind==="replay")assert.equal(terminalResult.responseStatus,409);
    assert.equal(messageResult.kind,"created");
    const liveRuns=(await store.sandboxRuns.list()).filter((candidate)=>candidate.taskId===task.id&&candidate.state!=="released");
    assert.equal(liveRuns.length,1);
    assert.equal((await store.findTask(task.id))?.currentRunId,liveRuns[0]?.runId);
    const terminalReceipt=await store.findTaskIdempotency({
      actorId:terminalInput.idempotency.actorId,
      projectId:terminalInput.idempotency.projectId,
      operation:terminalInput.idempotency.operation,
      key:terminalInput.idempotency.key,
      requestHash:terminalInput.idempotency.requestHash
    });
    assert.equal(terminalReceipt?.kind,terminalResult.kind==="claimed"?"in_progress":"replay");
    assert.equal((await store.findProjectResourceUsage(task.projectId))?.activeSandboxes,1);
  });

  it("redirects concurrent same-key Terminal starts to the persisted exact owner",async()=>{
    const firstStore=fixtureStore("terminal-same-key-first");
    const secondStore=fixtureStore("terminal-same-key-second");
    const task=taskRecord("task_terminal_same_key","library_terminal_same_key","run_terminal_same_key_released");
    const released=run(task,task.currentRunId!,"released");
    assert.equal((await store.createTaskAtomically({
      task,reserveActive:false,admission:{namespace:"agentsmith",namespaceLimit:100},
      newFileLibrary:library(task.fileLibraryId!,"Terminal same key"),sandboxRun:released
    })).kind,"created");
    const terminalInput=(label:string):BeginTerminalStartInput=>{
      const replacement={...task,currentRunId:`run_terminal_same_key_${label}`,updatedAt:"2026-07-23T00:01:10.000Z"};
      const replacementRun=run(replacement,replacement.currentRunId!,"starting");
      return{
        taskId:task.id,
        idempotency:{
          actorId:"user_atomic",projectId:task.projectId,operation:"terminal-start",
          key:"terminal-same-key",requestHash:"terminal-same-key-hash",
          resourceId:replacementRun.runId,claimToken:`terminal-same-key-${label}-claim`,
          now:at,leaseExpiresAt:"2026-07-23T00:05:00.000Z"
        },
        admission:{namespace:"agentsmith",namespaceLimit:100},
        restart:{
          expectedReleasedRunId:released.runId,task:replacement,
          runtimeState:{botifiedBaseUrl:"http://terminal-same-key"},
          sandboxRun:replacementRun,reservedAt:replacement.updatedAt
        },
        rejectionPresentation:{} as import("../../packages/contracts/src/api.js").TaskPresentation,
        rejectedAuditEvent:{
          id:`audit_terminal_same_key_${label}_rejected`,projectId:task.projectId,
          actorId:"user_atomic",action:"sandbox.started",status:"rejected",
          resourceKind:"sandbox",resourceId:task.id,
          detail:{taskId:task.id,trigger:"terminal"},createdAt:at
        }
      };
    };
    const firstInput=terminalInput("first");
    const secondInput=terminalInput("second");
    const blocker=fixtureClient("terminal-same-key-blocker");
    const observer=fixtureClient("terminal-same-key-observer");
    await blocker.connect();
    await observer.connect();
    const pending:Promise<unknown>[]=[];
    let blockerCommitted=false;
    let firstResult:Awaited<ReturnType<typeof store.beginTerminalStart>>;
    let secondResult:Awaited<ReturnType<typeof store.beginTerminalStart>>;
    try{
      await blocker.query("begin");
      const blockerPid=(await blocker.query<{pid:number}>("select pg_backend_pid() as pid")).rows[0]!.pid;
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1,0))",["agentsmith-lite:sandbox:agentsmith"]);
      const firstOperation=firstStore.beginTerminalStart(firstInput);
      pending.push(firstOperation);
      const firstPid=await waitForBlockedOperation(observer,{
        expectedBlockers:[{pid:blockerPid,state:"idle in transaction",waitEventType:"Client"}],
        applicationName:"terminal-same-key-first",waitEvent:"advisory",
        queryFragment:"pg_advisory_xact_lock",name:"first same-key Terminal start",operation:firstOperation
      });
      const secondOperation=secondStore.beginTerminalStart(secondInput);
      pending.push(secondOperation);
      await waitForBlockedOperation(observer,{
        expectedBlockers:[
          {pid:blockerPid,state:"idle in transaction",waitEventType:"Client"},
          {pid:firstPid,state:"active",waitEventType:"Lock"}
        ],
        applicationName:"terminal-same-key-second",waitEvent:"advisory",
        queryFragment:"pg_advisory_xact_lock",name:"second same-key Terminal start",operation:secondOperation
      });
      await blocker.query("commit");
      blockerCommitted=true;
      [firstResult,secondResult]=await completesWithoutDeadlock(Promise.all([firstOperation,secondOperation]),5_000);
    }finally{
      if(!blockerCommitted)await blocker.query("rollback").catch(()=>undefined);
      await Promise.allSettled(pending);
      await blocker.end();
      await observer.end();
      await firstStore.close();
      await secondStore.close();
    }

    assert.deepEqual([firstResult.kind,secondResult.kind],["claimed","in_progress"]);
    if(firstResult.kind!=="claimed"||secondResult.kind!=="in_progress")assert.fail("Expected one claimed owner and one in-progress replay");
    assert.equal(secondResult.run.runId,firstResult.run.runId);
    const liveRuns=(await store.sandboxRuns.list()).filter((candidate)=>candidate.taskId===task.id&&candidate.state!=="released");
    assert.deepEqual(liveRuns.map((candidate)=>candidate.runId),[firstResult.run.runId]);
    const receipt=await store.findTaskIdempotency({
      actorId:firstInput.idempotency.actorId,
      projectId:firstInput.idempotency.projectId,
      operation:firstInput.idempotency.operation,
      key:firstInput.idempotency.key,
      requestHash:firstInput.idempotency.requestHash
    });
    assert.equal(receipt?.kind,"in_progress");
    if(receipt?.kind==="in_progress")assert.equal(receipt.resourceId,firstResult.run.runId);
  });

  it("does not deadlock activation Task-to-Run locks against restart admission",async()=>{
    const activationStore=fixtureStore("activation-admission-activation");
    const messageStore=fixtureStore("activation-admission-message");
    const task=taskRecord("task_activation_admission","library_activation_admission","run_activation_admission");
    const starting=run(task,task.currentRunId!,"starting");
    assert.equal((await store.createTaskAtomically({
      task,reserveActive:true,admission:{namespace:"agentsmith",namespaceLimit:100},
      ...createAdmissionReceipt(task,"activation-admission"),
      newFileLibrary:library(task.fileLibraryId!,"Activation admission"),sandboxRun:starting
    })).kind,"created");
    assert.ok(await store.markTaskSandboxStartupReady({
      taskId:task.id,runId:starting.runId,expectedFencingToken:starting.fencingToken,readyAt:at
    }));
    const startupClaimToken="activation-admission-startup-claim";
    assert.equal((await store.claimSandboxStartup({
      taskId:task.id,runId:starting.runId,expectedFencingToken:starting.fencingToken,
      claimToken:startupClaimToken,claimedAt:at,leaseExpiresAt:"2026-07-23T00:05:00.000Z"
    })).kind,"claimed");
    const actionDeadlineAt="2026-07-23T00:04:00.000Z";
    assert.ok(await store.beginSandboxStartupAction({
      taskId:task.id,runId:starting.runId,expectedFencingToken:starting.fencingToken,
      claimToken:startupClaimToken,actionDeadlineAt,startedAt:"2026-07-23T00:01:00.000Z"
    }));
    const blocker=fixtureClient("activation-admission-blocker");
    const observer=fixtureClient("activation-admission-observer");
    await blocker.connect();
    await observer.connect();
    const pending:Promise<unknown>[]=[];
    let blockerCommitted=false;
    let activationResult:Awaited<ReturnType<typeof store.activateTaskSandboxRun>>;
    let messageResult:Awaited<ReturnType<typeof store.createTaskMessageAtomically>>;
    try{
      await blocker.query("begin");
      const blockerPid=(await blocker.query<{pid:number}>("select pg_backend_pid() as pid")).rows[0]!.pid;
      await blocker.query("select id from agent_tasks where id=$1 for update",[task.id]);
      const activationOperation=activationStore.activateTaskSandboxRun({
        taskId:task.id,runId:starting.runId,expectedFencingToken:starting.fencingToken,
        startupClaimToken,actionDeadlineAt,activatedAt:"2026-07-23T00:02:00.000Z",
        auditEvent:{
          id:"audit_activation_admission_started",projectId:task.projectId,actorId:null,
          subjectUserId:"user_atomic",action:"sandbox.started",status:"accepted",
          resourceKind:"sandbox",resourceId:task.id,
          detail:{taskId:task.id,runId:starting.runId},createdAt:"2026-07-23T00:02:00.000Z"
        }
      });
      pending.push(activationOperation);
      const activationPid=await waitForBlockedOperation(observer,{
        expectedBlockers:[{pid:blockerPid,state:"idle in transaction",waitEventType:"Client"}],
        applicationName:"activation-admission-activation",waitEvent:"transactionid",
        queryFragment:"agent_tasks",name:"Run activation",operation:activationOperation
      });
      const messageOperation=messageStore.createTaskMessageAtomically(
        atomicMessage(task,starting,"activate","run_activation_admission_restart")
      );
      pending.push(messageOperation);
      await waitForBlockedOperation(observer,{
        expectedBlockers:[{pid:activationPid,state:"active",waitEventType:"Lock"}],
        applicationName:"activation-admission-message",waitEvent:"tuple",
        queryFragment:"agent_tasks",name:"message restart admission",operation:messageOperation
      });
      await blocker.query("commit");
      blockerCommitted=true;
      [activationResult,messageResult]=await completesWithoutDeadlock(
        Promise.all([activationOperation,messageOperation]),
        5_000
      );
    }finally{
      if(!blockerCommitted)await blocker.query("rollback").catch(()=>undefined);
      await Promise.allSettled(pending);
      await blocker.end();
      await observer.end();
      await activationStore.close();
      await messageStore.close();
    }

    assert.equal(activationResult.kind,"activated");
    assert.equal(messageResult.kind,"created");
    if(messageResult.kind==="created")assert.equal(messageResult.restarted,false);
    assert.equal((await store.findTask(task.id))?.currentRunId,starting.runId);
    assert.deepEqual(
      (await store.sandboxRuns.list()).filter((candidate)=>candidate.taskId===task.id&&candidate.state!=="released").map((candidate)=>candidate.runId),
      [starting.runId]
    );
  });

  it("terminalizes a PostgreSQL Terminal owner through Release before admitting a new key",async()=>{
    const task=taskRecord("task_terminal_release_owner","library_terminal_release_owner","run_terminal_release_base");
    const releasedBase=run(task,task.currentRunId!,"released");
    assert.equal((await store.createTaskAtomically({
      task,reserveActive:false,admission:{namespace:"agentsmith",namespaceLimit:100},
      newFileLibrary:library(task.fileLibraryId!,"Terminal release owner"),sandboxRun:releasedBase
    })).kind,"created");
    const terminalInput=(label:string,released:PersistedSandboxRunState,newRunId:string):BeginTerminalStartInput=>{
      const replacement={...task,currentRunId:newRunId,updatedAt:`2026-07-23T00:0${label==="first"?1:4}:00.000Z`};
      const replacementRun=run(replacement,newRunId,"starting");
      return{
        taskId:task.id,
        idempotency:{
          actorId:"user_atomic",projectId:task.projectId,operation:"terminal-start",
          key:`terminal-release-${label}`,requestHash:`terminal-release-${label}-hash`,
          resourceId:newRunId,claimToken:`terminal-release-${label}-claim`,
          now:replacement.updatedAt,leaseExpiresAt:"2026-07-23T00:10:00.000Z"
        },
        admission:{namespace:"agentsmith",namespaceLimit:100},
        restart:{
          expectedReleasedRunId:released.runId,task:replacement,
          runtimeState:{botifiedBaseUrl:`http://terminal-release-${label}`},
          sandboxRun:replacementRun,reservedAt:replacement.updatedAt
        },
        rejectionPresentation:{} as import("../../packages/contracts/src/api.js").TaskPresentation,
        rejectedAuditEvent:{
          id:`audit_terminal_release_${label}_rejected`,projectId:task.projectId,
          actorId:"user_atomic",action:"sandbox.started",status:"rejected",
          resourceKind:"sandbox",resourceId:task.id,
          detail:{taskId:task.id,trigger:"terminal"},createdAt:replacement.updatedAt
        }
      };
    };
    const firstInput=terminalInput("first",releasedBase,"run_terminal_release_first");
    const first=await store.beginTerminalStart(firstInput);
    assert.equal(first.kind,"claimed");
    if(first.kind!=="claimed")return;
    const releaseClaim={
      actorId:"user_atomic",projectId:task.projectId,operation:"release-sandbox" as const,
      key:"terminal-owner-release",requestHash:"terminal-owner-release-hash",
      resourceId:first.run.runId,claimToken:"terminal-owner-release-claim",
      now:"2026-07-23T00:02:00.000Z",leaseExpiresAt:"2026-07-23T00:10:00.000Z"
    };
    assert.equal((await store.beginTaskIdempotency(releaseClaim)).kind,"claimed");
    const requested={...first.run,state:"release_requested" as const,releaseReason:"requested" as const,releaseRequestedAt:releaseClaim.now,startupClaimToken:null,startupLeaseExpiresAt:null,cleanupClaimedAt:null,fencingToken:first.run.fencingToken+1,updatedAt:releaseClaim.now};
    assert.equal(await store.requestTaskSandboxRelease({
      runId:first.run.runId,taskId:task.id,expectedFencingToken:first.run.fencingToken,run:requested,
      idempotency:{
        actorId:releaseClaim.actorId,projectId:releaseClaim.projectId,operation:releaseClaim.operation,
        key:releaseClaim.key,requestHash:releaseClaim.requestHash,claimToken:releaseClaim.claimToken,
        responseStatus:200,responseBody:{released:true},updatedAt:releaseClaim.now
      }
    }),"applied");
    const terminalReceipt=await store.findTaskIdempotency({
      actorId:firstInput.idempotency.actorId,projectId:firstInput.idempotency.projectId,
      operation:firstInput.idempotency.operation,key:firstInput.idempotency.key,
      requestHash:firstInput.idempotency.requestHash
    });
    assert.equal(terminalReceipt?.kind,"replay");
    if(terminalReceipt?.kind==="replay")assert.equal(terminalReceipt.responseStatus,502);

    const releasedAt="2026-07-23T00:03:00.000Z";
    const released={...requested,state:"released" as const,releasedAt,startupActionDeadlineAt:null,fencingToken:requested.fencingToken+1,updatedAt:releasedAt};
    assert.equal(await store.completeSandboxRunRelease({
      runId:requested.runId,expectedFencingToken:requested.fencingToken,run:released,
      settlement:{
        runId:requested.runId,workspaceId:requested.workspaceId,projectId:requested.projectId,
        taskId:requested.taskId,fileLibraryId:requested.fileLibraryId,startedByUserId:requested.startedByUserId,
        startedAt:requested.startedAt,releasedAt,durationSeconds:0,resources:requested.resourceSnapshot,
        releaseReason:"requested"
      },
      auditEvent:{
        id:"audit_terminal_release_owner_released",projectId:requested.projectId,actorId:null,
        subjectUserId:requested.startedByUserId,action:"sandbox.released",status:"accepted",
        resourceKind:"sandbox",resourceId:requested.taskId,
        detail:{taskId:requested.taskId,runId:requested.runId,releaseReason:"requested"},createdAt:releasedAt
      }
    }),"applied");
    assert.equal((await store.beginTerminalStart(
      terminalInput("second",released,"run_terminal_release_second")
    )).kind,"claimed");
  });

  it("rejects an old released Run when a concurrent PostgreSQL transaction retargets its Task",async()=>{
    const task=taskRecord("task_release_retarget","library_release_retarget","run_release_retarget_a");
    const runA=run(task,task.currentRunId!,"released");
    assert.equal((await store.createTaskAtomically({
      task,reserveActive:false,admission:{namespace:"agentsmith",namespaceLimit:100},
      newFileLibrary:library(task.fileLibraryId!,"Release retarget"),sandboxRun:runA
    })).kind,"created");
    const runBId="run_release_retarget_b";
    const setup=fixtureClient("release-retarget-setup");
    await setup.connect();
    try{await cloneReleasedSandboxRun(setup,runA.runId,runBId);}finally{await setup.end();}
    const claim={
      actorId:"user_atomic",projectId:task.projectId,operation:"release-sandbox" as const,
      key:"release-retarget",requestHash:"release-retarget-hash",resourceId:runA.runId,
      claimToken:"release-retarget-claim",now:at,leaseExpiresAt:"2026-07-23T00:05:00.000Z"
    };
    assert.equal((await store.beginTaskIdempotency(claim)).kind,"claimed");
    const releaseStore=fixtureStore("release-retarget-operation");
    const blocker=fixtureClient("release-retarget-blocker");
    const observer=fixtureClient("release-retarget-observer");
    await blocker.connect();
    await observer.connect();
    const pending:Promise<unknown>[]=[];
    let committed=false;
    let result:Awaited<ReturnType<typeof store.requestTaskSandboxRelease>>;
    try{
      await blocker.query("begin");
      const blockerPid=(await blocker.query<{pid:number}>("select pg_backend_pid() as pid")).rows[0]!.pid;
      await blocker.query("select id from agent_tasks where id=$1 for update",[task.id]);
      await blocker.query(
        "select 1 from task_idempotency_records where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 for update",
        [claim.actorId,claim.projectId,claim.operation,claim.key]
      );
      const operation=releaseStore.requestTaskSandboxRelease({
        runId:runA.runId,taskId:task.id,expectedFencingToken:runA.fencingToken,run:runA,
        idempotency:{
          actorId:claim.actorId,projectId:claim.projectId,operation:claim.operation,key:claim.key,
          requestHash:claim.requestHash,claimToken:claim.claimToken,responseStatus:200,
          responseBody:{outcome:"completed",runId:runA.runId},updatedAt:at
        }
      });
      pending.push(operation);
      await waitForBlockedOperation(observer,{
        expectedBlockers:[{pid:blockerPid,state:"idle in transaction",waitEventType:"Client"}],
        applicationName:"release-retarget-operation",waitEvent:"transactionid",
        queryFragment:"agent_tasks",name:"exact Release fence",operation
      });
      await blocker.query("update agent_tasks set current_run_id=$2 where id=$1",[task.id,runBId]);
      await blocker.query("commit");
      committed=true;
      result=await completesWithoutDeadlock(operation,5_000);
    }finally{
      if(!committed)await blocker.query("rollback").catch(()=>undefined);
      await Promise.allSettled(pending);
      await blocker.end();
      await observer.end();
      await releaseStore.close();
    }
    assert.equal(result,"conflict");
    assert.equal((await store.findTask(task.id))?.currentRunId,runBId);
    assert.equal((await store.sandboxRuns.get(runBId))?.state,"released");
  });

  it("reclaims an expired message lease without changing its persisted identity",async()=>{
    const task={...taskRecord("task_reclaim","library_reclaim","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({task,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},newFileLibrary:library(task.fileLibraryId!,"Reclaim")})).kind,"created");
    const replacement={...task,currentRunId:"run_reclaim",updatedAt:"2026-07-23T00:01:00.000Z"};
    const first=atomicMessage(task,{...run(replacement,"run_reclaim","starting"),state:"released",releaseReason:"requested",releaseRequestedAt:at,releasedAt:at},"original","run_reclaim");
    first.expectedCurrentRunId=null;
    first.restart={task:replacement,runtimeState:{botifiedBaseUrl:"http://reclaim"},sandboxRun:run(replacement,"run_reclaim","starting"),reservedAt:replacement.updatedAt};
    first.idempotency={...first.idempotency,resourceId:"message_original",leaseExpiresAt:"2026-07-23T00:01:00.000Z"};
    first.message={...first.message,id:"message_candidate",deliveryKey:"delivery_message_message_candidate"};

    assert.equal((await store.beginTaskIdempotency(first.idempotency)).kind,"claimed");
    assert.deepEqual(await store.findTaskIdempotency({
      actorId:first.idempotency.actorId,
      projectId:first.idempotency.projectId,
      operation:first.idempotency.operation,
      key:first.idempotency.key,
      requestHash:first.idempotency.requestHash
    }),{kind:"in_progress",resourceId:"message_original"});
    assert.equal(await store.findTaskMessage("message_original"),null);
    const retry:AtomicTaskMessageInput={
      ...first,
      message:{...first.message,id:"message_retry",deliveryKey:"delivery_message_message_retry"},
      idempotency:{...first.idempotency,resourceId:"message_retry",claimToken:"claim_retry",now:"2026-07-23T00:02:00.000Z",leaseExpiresAt:"2026-07-23T00:03:00.000Z"}
    };
    const reclaimed=await store.createTaskMessageAtomically(retry);
    assert.equal(reclaimed.kind,"created");
    assert.equal(reclaimed.kind==="created"?reclaimed.message.id:null,"message_original");
    assert.deepEqual((await store.listTaskMessages(task.id)).map((message)=>message.id),["message_original"]);
    assert.equal(((await store.queryProjectAuditEvents(task.projectId,{limit:100})).items).filter((event)=>event.action==="task.message.create").length,1);
  });

  it("keeps a PostgreSQL pending-message crash window out of due and claim paths",async()=>{
    const task={...taskRecord("task_dispatch_guard","library_dispatch_guard","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({
      task,reserveActive:false,admission:{namespace:"agentsmith",namespaceLimit:100},
      newFileLibrary:library(task.fileLibraryId!,"Dispatch guard")
    })).kind,"created");
    const orphan={...message("message_dispatch_orphan",task.id),createdAt:"2026-07-23T00:01:00.000Z",updatedAt:"2026-07-23T00:01:00.000Z"};
    await store.createTaskMessage(orphan);
    assert.deepEqual(await store.listTaskMessagesDue("2026-07-23T00:02:00.000Z",10),[]);
    assert.equal(await store.claimTaskMessage({
      id:orphan.id,claimToken:"orphan-claim",claimedAt:"2026-07-23T00:02:00.000Z",leaseExpiresAt:"2026-07-23T00:03:00.000Z"
    }),null);

    const durable={...message("message_dispatch_durable",task.id),createdAt:"2026-07-23T00:02:00.000Z",updatedAt:"2026-07-23T00:02:00.000Z"};
    assert.ok(await store.createPendingTaskMessage(durable,{
      sourceKind:"product",sourceId:`message:${durable.id}`,sourceRevision:0,
      interaction:{id:"interaction_dispatch_durable",taskId:task.id,kind:"user_message",revision:1,position:1,occurredAt:durable.createdAt,updatedAt:durable.updatedAt!,title:"You",actorId:"user_atomic",body:durable.content,contentMode:"full",status:"pending"}
    }));
    assert.deepEqual((await store.listTaskMessagesDue("2026-07-23T00:03:00.000Z",10)).map((candidate)=>candidate.id),[durable.id]);
    assert.equal((await store.claimTaskMessage({
      id:durable.id,claimToken:"durable-claim",claimedAt:"2026-07-23T00:03:00.000Z",leaseExpiresAt:"2026-07-23T00:04:00.000Z"
    }))?.id,durable.id);
  });

  it("completes resource idempotency only for the matching Project and operation",async()=>{
    await store.createProject({id:"project_idempotency_other",workspaceId:"workspace_atomic",name:"Other Project",ownerUserId:"user_atomic",rootPath:"workspaces/workspace_atomic/projects/project_idempotency_other",sandboxLimit:1,createdAt:at,updatedAt:at});
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
      reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},
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
    assert.equal(((await store.queryProjectAuditEvents(task.projectId,{limit:100})).items).filter((event)=>event.id==="audit_message_edit").length,1);
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
    assert.equal(((await store.queryProjectAuditEvents(task.projectId,{limit:100})).items).some((event)=>event.id==="audit_message_stale_edit"),false);

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
    assert.equal(((await store.queryProjectAuditEvents(task.projectId,{limit:100})).items).filter((event)=>event.id==="audit_message_delete").length,1);
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
      reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},
      newFileLibrary:library(task.fileLibraryId!,"Run deletion race")
    })).kind,"created");
    const replacement={...task,currentRunId:"run_delete_race",updatedAt:"2026-07-23T00:01:00.000Z"};
    const [restarted,deletion]=await Promise.all([
      store.restartTaskSandboxAtomically({
        expectedReleasedRunId:null,
        task:replacement,
        runtimeState:{botifiedBaseUrl:"http://delete-race"},
        sandboxRun:run(replacement,replacement.currentRunId!,"starting"),
        reservedAt:replacement.updatedAt,
        admission:{namespace:"agentsmith",namespaceLimit:100},
        ...restartAdmissionReceipt(replacement,"delete-race")
      }),
      store.beginProjectDeletion(task.projectId,replacement.updatedAt,"user_atomic")
    ]);
    if(restarted.kind==="restarted"){
      assert.equal(deletion.kind,"sandbox_not_released");
    }else{
      assert.equal(restarted.kind,"conflict");
      assert.equal(deletion.kind,"ready");
      assert.equal((await store.findProjectResourceUsage(task.projectId))?.activeSandboxes,0);
      assert.equal(await store.sandboxRuns.get(replacement.currentRunId!),null);
    }
  });

  it("lets Project deletion win against Task archive without deadlocking",async()=>{
    const task={...taskRecord("task_project_delete_archive","library_project_delete_archive","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({task,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},newFileLibrary:library(task.fileLibraryId!,"Project delete archive")})).kind,"created");
    assert.equal((await store.beginProjectDeletion(task.projectId,"2026-07-23T00:01:00.000Z","user_atomic")).kind,"ready");

    const auditId="audit_project_delete_archive_loser";
    const [projectResult,archiveResult]=await raceProjectDeletionAgainstTaskOperation(task.projectId,()=>store.archiveTask(task.id,"2026-07-23T00:02:00.000Z",{id:auditId,projectId:task.projectId,actorId:"user_atomic",action:"task.archive",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id},createdAt:"2026-07-23T00:02:00.000Z"}));

    assert.equal(projectResult,"deleted");
    assert.equal(archiveResult.kind,"not_found_or_forbidden");
    assert.equal(await store.findTask(task.id),null);
    assert.equal(((await store.queryProjectAuditEvents(task.projectId,{limit:100})).items).some((event)=>event.id===auditId),false);
  });

  it("lets Project deletion win against Task deletion without deadlocking",async()=>{
    const task={...taskRecord("task_project_delete_task","library_project_delete_task","unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({task,reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},newFileLibrary:library(task.fileLibraryId!,"Project delete task")})).kind,"created");
    assert.equal((await store.beginProjectDeletion(task.projectId,"2026-07-23T00:01:00.000Z","user_atomic")).kind,"ready");

    const auditId="audit_project_delete_task_loser";
    const [projectResult,deleteResult]=await raceProjectDeletionAgainstTaskOperation(task.projectId,()=>store.beginTaskDeletion(task.id,"2026-07-23T00:02:00.000Z",{id:auditId,projectId:task.projectId,actorId:"user_atomic",action:"task.delete",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id},createdAt:"2026-07-23T00:02:00.000Z"}));

    assert.equal(projectResult,"deleted");
    assert.equal(deleteResult.kind,"not_found_or_forbidden");
    assert.equal(await store.findTask(task.id),null);
    assert.equal(((await store.queryProjectAuditEvents(task.projectId,{limit:100})).items).some((event)=>event.id===auditId),false);
  });

  it("reserves a first Run and restarts only the exact released Run through one atomic path",async()=>{
    const firstTask={...taskRecord("task_first","library_first","run_unused"),currentRunId:null};
    assert.equal((await store.createTaskAtomically({
      task:firstTask,
      reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},
      newFileLibrary:library(firstTask.fileLibraryId!,"First")
    })).kind,"created");
    const firstReplacement={...firstTask,currentRunId:"run_first",updatedAt:"2026-07-23T00:01:00.000Z"};
    const firstRun=run(firstReplacement,firstReplacement.currentRunId!,"starting");
    const firstInput={
      expectedReleasedRunId:null,
      task:firstReplacement,
      runtimeState:{botifiedBaseUrl:"http://first-task"},
      sandboxRun:firstRun,
      reservedAt:firstReplacement.updatedAt,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      ...restartAdmissionReceipt(firstReplacement,"first")
    };
    assert.equal((await store.restartTaskSandboxAtomically({
      ...firstInput,
      sandboxRun:{...firstRun,projectId:"project_wrong"}
    })).kind,"conflict");
    assert.equal((await store.findProjectResourceUsage(firstTask.projectId))?.activeSandboxes,0);
    assert.equal((await store.restartTaskSandboxAtomically(firstInput)).kind,"restarted");
    assert.equal((await store.findTask(firstTask.id))?.currentRunId,firstRun.runId);
    assert.equal((await store.findProjectResourceUsage(firstTask.projectId))?.activeSandboxes,1);
    assert.equal((await store.listTaskMessages(firstTask.id)).length,0);
    assert.equal((await store.restartTaskSandboxAtomically(firstInput)).kind,"conflict");
    assert.equal((await store.restartTaskSandboxAtomically({
      ...firstInput,
      expectedReleasedRunId:firstRun.runId,
      task:{...firstReplacement,currentRunId:"run_after_running"},
      sandboxRun:{...firstRun,runId:"run_after_running"}
    })).kind,"conflict");
    assert.equal((await store.findProjectResourceUsage(firstTask.projectId))?.activeSandboxes,1);
    const capacityTask={...firstTask,id:"task_capacity",fileLibraryId:"library_capacity"};
    assert.equal((await store.createTaskAtomically({
      task:capacityTask,
      reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},
      newFileLibrary:library(capacityTask.fileLibraryId!,"Capacity")
    })).kind,"created");
    const capacityReplacement={...capacityTask,currentRunId:"run_capacity",updatedAt:"2026-07-23T00:01:30.000Z"};
    const capacityRun=run(capacityReplacement,capacityReplacement.currentRunId!,"starting");
    assert.equal((await store.restartTaskSandboxAtomically({
      expectedReleasedRunId:null,
      task:capacityReplacement,
      runtimeState:{botifiedBaseUrl:"http://capacity-task"},
      sandboxRun:capacityRun,
      reservedAt:capacityReplacement.updatedAt,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      ...restartAdmissionReceipt(capacityReplacement,"capacity")
    })).kind,"capacity_rejected");
    assert.equal((await store.findTask(capacityTask.id))?.currentRunId,null);
    assert.equal(await store.sandboxRuns.get(capacityRun.runId),null);
    assert.equal((await store.findProjectResourceUsage(firstTask.projectId))?.activeSandboxes,1);

    const projectId="project_restart";
    const credentialId="credential_restart";
    const endpointId="endpoint_restart";
    await store.createProject({id:projectId,workspaceId:"workspace_atomic",name:"Restart Project",ownerUserId:"user_atomic",rootPath:"workspaces/workspace_atomic/projects/project_restart",sandboxLimit:1,createdAt:at,updatedAt:at});
    await store.createProjectCredential({id:credentialId,projectId,name:"Provider",type:"api_key",baseUrl:"https://models.example.test/v1",keyId:"test",nonce:Buffer.alloc(12),ciphertext:Buffer.from("ciphertext"),authTag:Buffer.alloc(16),fingerprint:"restart",version:1,createdAt:at,lastRotatedAt:null,updatedAt:at});
    await store.createEndpoint({id:endpointId,projectId,name:"Endpoint",protocol:"openai_chat_completions",baseUrl:"https://models.example.test/v1",model:"model",credentialId,capabilities:["text","tool_calls"],requestTimeoutSecs:30,createdAt:at,updatedAt:at});
    const releasedTask={...taskRecord("task_restart","library_restart","run_released"),projectId,endpointId};
    const releasedRun=run(releasedTask,releasedTask.currentRunId!,"released");
    assert.equal((await store.createTaskAtomically({
      task:releasedTask,
      reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},
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
      reservedAt:restartedTask.updatedAt,
      admission:{namespace:"agentsmith",namespaceLimit:100},
      ...restartAdmissionReceipt(restartedTask,"restart")
    };
    assert.equal((await store.restartTaskSandboxAtomically({...restartInput,expectedReleasedRunId:"run_missing"})).kind,"conflict");
    assert.equal((await store.findProjectResourceUsage(projectId))?.activeSandboxes,0);
    assert.equal((await store.restartTaskSandboxAtomically(restartInput)).kind,"restarted");
    assert.equal((await store.findTask(releasedTask.id))?.currentRunId,restartedRun.runId);
    assert.equal((await store.findProjectResourceUsage(projectId))?.activeSandboxes,1);
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
    assert.equal((await store.createTaskAtomically({task,reserveActive:true, admission:{namespace:"agentsmith",namespaceLimit:100},...createAdmissionReceipt(task,"delete-project"),newFileLibrary:library(task.fileLibraryId!,"Delete project"),sandboxRun:pending})).kind,"created");
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
    await store.adjustProjectResourceUsage({projectId:"project_atomic",delta:{activeSandboxes:0,providerRequests:0,providerTokens:0,providerCost:0,projectFileBytes:1},updatedAt:"2026-07-23T00:00:45.000Z"});
    const projectedUsage=await store.findProjectResourceUsage("project_atomic");
    assert.equal(projectedUsage?.projectFileBytes,18);
    assert.equal(projectedUsage?.projectFileBytesMeasuredAt,fileMeasuredAt);
    const release=async(label:string)=>{
      const task=taskRecord(`task_usage_${label}`,`library_usage_${label}`,`run_usage_${label}`),pending=run(task,task.currentRunId!,"starting");
      assert.equal((await store.createTaskAtomically({task,reserveActive:true, admission:{namespace:"agentsmith",namespaceLimit:100},...createAdmissionReceipt(task,`usage-${label}`),newFileLibrary:library(task.fileLibraryId!,`Usage ${label}`),sandboxRun:pending})).kind,"created");
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
    const persistedMessage=message(`message_${label}`,task.id);
    return{taskId:task.id,expectedCurrentRunId:released.runId,message:persistedMessage,idempotency:{actorId:"user_atomic",projectId:task.projectId,operation:"message",key:`key_${label}`,requestHash:`hash_${label}`,resourceId:`message_${label}`,claimToken:`claim_${label}`,now:at,leaseExpiresAt:"2026-07-23T00:05:00.000Z"},auditEvent:{id:`audit_task_message_create_message_${label}`,projectId:task.projectId,actorId:"user_atomic",action:"task.message.create",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,messageId:`message_${label}`,deliveryStatus:"pending"},createdAt:at},admission:{namespace:"agentsmith",namespaceLimit:100},rejectionPresentation:{} as import("../../packages/contracts/src/api.js").TaskPresentation,rejectedAuditEvent:{id:`audit_message_rejected_${label}`,projectId:task.projectId,actorId:"user_atomic",action:"sandbox.started",status:"rejected",resourceKind:"sandbox",resourceId:task.id,detail:{taskId:task.id,trigger:"task_message"},createdAt:at},responseStatus:200,responseBody:{kind:"task_message",messageId:persistedMessage.id,taskId:task.id,projectId:task.projectId,actorId:"user_atomic"},interactionChange:{sourceKind:"product",sourceId:`message:${persistedMessage.id}`,sourceRevision:0,interaction:{id:`interaction_${persistedMessage.id}`,revision:1,taskId:task.id,kind:"user_message",title:"You",body:persistedMessage.content,contentMode:"full",position:0,occurredAt:at,updatedAt:at,actorId:"user_atomic",status:"pending"}},restart:{task:replacement,runtimeState:{botifiedBaseUrl:"http://task"},sandboxRun:run(replacement,newRunId,"starting"),reservedAt:replacement.updatedAt}};
  }

  function createAdmissionReceipt(task:PersistedAgentTask,label:string){
    return{idempotency:{actorId:"user_atomic",projectId:task.projectId,operation:"create" as const,key:`fixture-${label}`,requestHash:`fixture-hash-${label}`,resourceId:task.id,claimToken:`fixture-claim-${label}`,now:task.updatedAt,leaseExpiresAt:"2099-01-01T00:00:00.000Z"},rejectionPresentation:null,rejectedAuditEvent:{id:`audit_fixture_rejected_${label}`,projectId:task.projectId,actorId:"user_atomic",action:"task.create" as const,status:"rejected" as const,resourceKind:"task" as const,resourceId:task.id,detail:{taskId:task.id,trigger:"task_create" as const},createdAt:task.updatedAt}};
  }

  function restartAdmissionReceipt(task:PersistedAgentTask,label:string){
    return{idempotency:{actorId:"user_atomic",projectId:task.projectId,operation:"terminal-start" as const,key:`fixture-terminal-${label}`,requestHash:`fixture-terminal-hash-${label}`,resourceId:task.id,claimToken:`fixture-terminal-claim-${label}`,now:task.updatedAt,leaseExpiresAt:"2099-01-01T00:00:00.000Z"},rejectionPresentation:{} as import("../../packages/contracts/src/api.js").TaskPresentation,rejectedAuditEvent:{id:`audit_fixture_terminal_rejected_${label}`,projectId:task.projectId,actorId:"user_atomic",action:"sandbox.started" as const,status:"rejected" as const,resourceKind:"sandbox" as const,resourceId:task.id,detail:{taskId:task.id,trigger:"terminal" as const},createdAt:task.updatedAt}};
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

  async function waitForBlockedOperation(
    client:pg.Client,
    target:{
      expectedBlockers:Array<{
        pid:number;
        state:"idle in transaction"|"active";
        waitEventType:"Client"|"Lock";
      }>;
      applicationName:string;
      waitEvent:"advisory"|"transactionid"|"tuple";
      queryFragment:string;
      name:string;
      operation:Promise<unknown>;
    }
  ):Promise<number>{
    const observe=async()=>{
      const deadline=Date.now()+5_000;
      while(Date.now()<deadline){
        const result=await client.query<{pid:number;blockers:number[]}>(
          `select activity.pid,pg_blocking_pids(activity.pid) as blockers
             from pg_stat_activity activity
            where activity.datname=current_database()
              and activity.pid<>pg_backend_pid()
              and activity.application_name=$1
              and activity.wait_event_type='Lock'
              and lower(activity.wait_event)=$2
              and position(lower($3) in lower(activity.query))>0`,
          [target.applicationName,target.waitEvent,target.queryFragment]
        );
        if(result.rows.length===1){
          const expectedPids=target.expectedBlockers.map((blocker)=>blocker.pid).sort((left,right)=>left-right);
          assert.deepEqual([...result.rows[0]!.blockers].sort((left,right)=>left-right),expectedPids);
          const blockerStates=await client.query<{pid:number;state:string;wait_event_type:string|null}>(
            "select pid,state,wait_event_type from pg_stat_activity where pid=any($1::integer[]) order by pid",
            [expectedPids]
          );
          assert.deepEqual(
            blockerStates.rows.map((blocker)=>({
              pid:blocker.pid,state:blocker.state,waitEventType:blocker.wait_event_type
            })),
            [...target.expectedBlockers].sort((left,right)=>left.pid-right.pid)
          );
          return result.rows[0]!.pid;
        }
        if(result.rows.length>1){
          assert.fail(`Expected one blocked ${target.name} backend, found ${result.rows.length}`);
        }
        await new Promise<void>((resolve)=>setImmediate(resolve));
      }
      const observed=await client.query<{
        pid:number;application_name:string;state:string;wait_event_type:string|null;wait_event:string|null;blockers:number[];query:string
      }>(
        `select pid,application_name,state,wait_event_type,wait_event,pg_blocking_pids(pid) as blockers,left(query,300) as query
           from pg_stat_activity
          where datname=current_database()
            and (application_name=$1 or pid=any($2::integer[]) or pid=pg_backend_pid())
          order by pid`
        ,[target.applicationName,target.expectedBlockers.map((blocker)=>blocker.pid)]
      );
      assert.fail(`Expected one blocked ${target.name} backend with exact blockers ${JSON.stringify(target.expectedBlockers.map((blocker)=>blocker.pid).sort((left,right)=>left-right))}; observed ${JSON.stringify(observed.rows)}`);
    };
    return Promise.race([
      observe(),
      target.operation.then(
        (value)=>{throw new Error(`${target.name} completed before blocking on ${target.waitEvent}: ${JSON.stringify(value)}`);},
        (error)=>{throw error;}
      )
    ]);
  }

  function fixtureStore(applicationName:string):PostgresProductStore{
    return new PostgresProductStore(fixturePostgresUrl(applicationName));
  }

  function fixtureClient(applicationName:string):pg.Client{
    return new pg.Client({connectionString:fixturePostgresUrl(applicationName)});
  }

  function fixturePostgresUrl(applicationName:string):string{
    if(!postgresUrl)throw new Error("POSTGRES_TEST_URL is required");
    const url=new URL(postgresUrl);
    url.searchParams.set("application_name",applicationName);
    return url.toString();
  }

  async function cloneReleasedSandboxRun(client:pg.Client,sourceRunId:string,targetRunId:string):Promise<void>{
    await client.query(
      `insert into sandbox_runs (
         run_id,workspace_id,project_id,task_id,file_library_id,started_by_user_id,state,
         namespace,image,pvc_name,project_sub_path,file_library_root_sub_path,botified_port,
         resource_names,service_key_secret_ref,directories,resource_limits,resource_snapshot,
         model_ca,timeline_cursor,terminal_failure,failure_code,failure_cause,fencing_token,
         resume_unfinished,startup_ready_at,startup_action_deadline_at,startup_claim_token,
         startup_lease_expires_at,cleanup_claimed_at,cleanup_attempts,last_cleanup_at,last_cleanup_error,
         release_reason,started_at,release_requested_at,failed_at,released_at,created_at,updated_at
       )
       select $2,workspace_id,project_id,task_id,file_library_id,started_by_user_id,'released',
              namespace,image,pvc_name,project_sub_path,file_library_root_sub_path,botified_port,
              resource_names,service_key_secret_ref,directories,resource_limits,resource_snapshot,
              model_ca,timeline_cursor,terminal_failure,null,null,1,
              false,startup_ready_at,null,null,null,null,0,null,null,
              'requested',started_at,updated_at,null,updated_at,created_at,updated_at
         from sandbox_runs
        where run_id=$1`,
      [sourceRunId,targetRunId]
    );
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

  async function completesWithoutDeadlock<T>(operation:Promise<T>,timeoutMs:number):Promise<T>{
    try{
      return await completesWithin(operation,timeoutMs);
    }catch(error){
      assert.notEqual((error as {code?:string}).code,"40P01","PostgreSQL reported a deadlock");
      throw error;
    }
  }

  async function settlesWithin<T>(operation:Promise<T>,timeoutMs:number):Promise<boolean>{
    return Promise.race([
      operation.then(()=>true,()=>true),
      new Promise<false>((resolve)=>setTimeout(()=>resolve(false),timeoutMs))
    ]);
  }

  async function createProjectFixture(projectId:string):Promise<void>{
    const credentialId=`credential_${projectId}`;
    await store.createProject({id:projectId,workspaceId:"workspace_atomic",name:projectId,ownerUserId:"user_atomic",rootPath:`workspaces/workspace_atomic/projects/${projectId}`,sandboxLimit:1,createdAt:at,updatedAt:at});
    await store.createProjectCredential({id:credentialId,projectId,name:"Provider",type:"api_key",baseUrl:"https://models.example.test/v1",keyId:"test",nonce:Buffer.alloc(12),ciphertext:Buffer.from("ciphertext"),authTag:Buffer.alloc(16),fingerprint:projectId,version:1,createdAt:at,lastRotatedAt:null,updatedAt:at});
    await store.createEndpoint({id:`endpoint_${projectId}`,projectId,name:"Endpoint",protocol:"openai_chat_completions",baseUrl:"https://models.example.test/v1",model:"model",credentialId,capabilities:["text","tool_calls"],requestTimeoutSecs:30,createdAt:at,updatedAt:at});
  }

  function projectTask(id:string,projectId:string,currentRunId:string):PersistedAgentTask{
    return{id,workspaceId:"workspace_atomic",projectId,endpointId:projectId==="project_atomic"?"endpoint_atomic":`endpoint_${projectId}`,fileLibraryId:`library_${id}`,createdByUserId:"user_atomic",title:"Task",prompt:"Work",agentContext:"",currentRunId,archivedAt:null,deletedAt:null,createdAt:at,updatedAt:at};
  }

  function projectLibrary(task:PersistedAgentTask,name:string){
    return{id:task.fileLibraryId!,workspaceId:task.workspaceId,projectId:task.projectId,name,rootSubPath:`libraries/${task.fileLibraryId}/home`,lifecycleStatus:"active" as const,createdByUserId:"user_atomic",createdAt:at,updatedAt:at};
  }

  function taskRecord(id:string,fileLibraryId:string,currentRunId:string):PersistedAgentTask{return{id,workspaceId:"workspace_atomic",projectId:"project_atomic",endpointId:"endpoint_atomic",fileLibraryId,createdByUserId:"user_atomic",title:"Task",prompt:"Work",agentContext:"",currentRunId,archivedAt:null,deletedAt:null,createdAt:at,updatedAt:at};}
  function library(id:string,name:string){return{id,workspaceId:"workspace_atomic",projectId:"project_atomic",name,rootSubPath:`libraries/${id}/home`,lifecycleStatus:"active" as const,createdByUserId:"user_atomic",createdAt:at,updatedAt:at};}
  function taskArtifact(id:string,taskId:string,createdAt:string,mediaType:string):PersistedTaskArtifact{return{id,taskId,fileId:`file_${id}`,name:id,bytes:1,mediaType,previewText:null,createdAt};}
  function message(id:string,taskId:string):PersistedTaskMessage{return{id,taskId,actorId:"user_atomic",content:id,deliveryKey:`delivery_${id}`,requestHash:`request_${id}`,claimToken:null,receipt:null,timelineCursor:null,deliveryStatus:"pending",claimedAt:null,leaseExpiresAt:null,attemptCount:0,nextRetryAt:null,safeError:null,createdAt:at,updatedAt:at,deletedAt:null};}
  function alertRule(id:string,projectId:string):ProjectAlertRule{return{id,projectId,name:id,alertType:"sandbox_failure",metric:"failure_count",condition:"greater_than_or_equal",threshold:1,windowSeconds:3600,scope:{kind:"project"},enabled:false,createdAt:at,updatedAt:at};}
  function run(task:PersistedAgentTask,runId:string,state:"starting"|"released"):PersistedSandboxRunState{return{workspaceId:task.workspaceId,projectId:task.projectId,taskId:task.id,runId,namespace:"agentsmith",state,image:"botified:test",pvcName:"files",projectSubPath:`workspaces/${task.workspaceId}/projects/${task.projectId}`,fileLibraryRootSubPath:`libraries/${task.fileLibraryId}/home`,fileLibraryId:task.fileLibraryId!,startedByUserId:"user_atomic",startedAt:null,startupReadyAt:state==="released"?at:null,startupActionDeadlineAt:null,botifiedPort:3099,resourceNames:{pod:`pod-${runId}`,service:`service-${runId}`,configMap:`config-${runId}`,secret:`secret-${runId}`,serviceAccount:`account-${runId}`,networkPolicy:`policy-${runId}`},serviceKeySecretRef:{name:`secret-${runId}`,key:"BOTIFIED_SERVICE_KEY"},directories:{libraryHome:"/workspace/library",botified:"/workspace/botified"},resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},failureCode:null,failureCause:null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,releaseReason:state==="released"?"requested":null,releaseRequestedAt:state==="released"?at:null,failedAt:null,releasedAt:state==="released"?at:null,createdAt:at,updatedAt:at};}
  function usageOverviewReadInput(measuredAt:string){const periodStart="2026-06-24T00:00:00.000Z",periodEnd="2026-07-24T00:00:00.000Z";return{projectId:"project_atomic",userId:"user_atomic",selectedUserId:"user_atomic",selectedEndpointId:null,periodStart,periodEnd,measuredAt}}

  async function seedProjectDeletionBusinessData(){
    const task={...taskRecord("task_project_finalize","library_project_finalize","unused"),currentRunId:null};
    const initialMessage=message("message_project_finalize",task.id);
    assert.equal((await store.createTaskAtomically({
      task,
      reserveActive:false, admission:{namespace:"agentsmith",namespaceLimit:100},
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
