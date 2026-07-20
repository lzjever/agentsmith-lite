import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { ModelEndpoint, StoredUser } from "../../packages/contracts/src/api.js";
import type { PersistedAgentTask, PersistedSandboxRunState } from "../../packages/ports/src/store.js";

describe("project usage overview", () => {
  it("uses current policy usage for limits and settled provider data for daily and endpoint aggregates", async () => {
    const store = createLocalInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-usage-overview", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Usage" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Usage project" });
    const endpoints = [endpoint("endpoint_1", project.id, "Primary"), endpoint("endpoint_2", project.id, "Secondary")];
    await Promise.all(endpoints.map((value) => store.createEndpoint(value)));
    const teammate = userRecord("teammate", "teammate@example.test");
    await store.createUser(teammate);
    await store.upsertProjectMembership({ projectId:project.id, userId:teammate.id, role:"member", createdAt:project.createdAt, updatedAt:project.updatedAt });
    await services.policies.updatePolicy(user.id, project.id, { providerRequestsLimit: 5, providerTokensLimit: 100, providerCostLimit: 10, endpointWindows:[{ endpointId:"endpoint_1", metric:"providerRequests", limit:5, windowSeconds:3600 }, { endpointId:"endpoint_1", metric:"providerTokens", limit:100, windowSeconds:3600 }, { endpointId:"endpoint_2", metric:"providerRequests", limit:5, windowSeconds:3600 }] });
    const now = new Date().toISOString();
    await settle(store, "settlement_1", project.id, "endpoint_1", user.id, now, { tokens: 7, cost: 1.5 });
    await settle(store, "settlement_2", project.id, "endpoint_1", teammate.id, now, { tokens: 3, cost: 0.5 });
    await store.reserveProjectProviderSettlement({ id: "settlement_reserved", projectId: project.id, taskId: null, endpointId: "endpoint_1", actorId:user.id, reservedTokens: 5, reservedCost: 0.25, reservedAt: now, expiresAt: new Date(Date.parse(now) + 60_000).toISOString() });
    assert.deepEqual((await store.listSettledProjectProviderSettlements(project.id, new Date(Date.parse(now) - 60_000).toISOString())).map((settlement) => settlement.id), ["settlement_1", "settlement_2"]);

    const overview = await services.policies.getUsageOverview(user.id, project.id);
    assert.equal(overview.daily.length, 30);
    assert.deepEqual(overview.limits.find((limit) => limit.metric === "activeTasks"), { metric: "activeTasks", current: 0, limit: 2, remaining: 2, window: { kind: "current_gauge", resetAt: null } });
    assert.deepEqual(overview.limits.find((limit) => limit.metric === "providerTokens"), { metric: "providerTokens", current: 15, limit: 100, remaining: 85, window: { kind: "project_lifetime", startedAt: project.createdAt, resetAt: null } });
    assert.deepEqual(overview.trendTotals, { requests:1, tokens:7, cost:1.5 });
    assert.equal("currentUser" in overview,false);
    assert.deepEqual(overview.endpoints.map((value) => [value.endpointName, value.requests, value.tokens, value.cost]), [["Primary", 2, 10, 2], ["Secondary", 0, 0, 0]]);
    assert.deepEqual(overview.endpoints[0]?.limits?.map((limit) => [limit.metric,limit.current,limit.remaining]), [["providerRequests",2,3],["providerTokens",12,88]]);
    assert.equal(overview.endpoints[1]?.limits?.[0]?.window.resetAt,null);

    const selected = await services.policies.getUsageOverview(user.id, project.id, "endpoint_2");
    assert.equal(selected.selectedEndpointId, "endpoint_2");
    assert.deepEqual(selected.daily.reduce((total, day) => ({ requests: total.requests + day.requests, tokens: total.tokens + day.tokens, cost: total.cost + day.cost }), { requests: 0, tokens: 0, cost: 0 }), { requests: 0, tokens: 0, cost: 0 });
    assert.equal("currentUser" in selected,false);
    await assert.rejects(() => services.policies.getUsageOverview(user.id, project.id, "missing"), /Endpoint not found/);

    await settle(store, "settlement_deleted", project.id, "endpoint_2", user.id, now, { tokens: 2, cost: 0.25 });
    assert.equal(await store.deleteEndpoint("endpoint_2"), "deleted");
    const afterDelete = await services.policies.getUsageOverview(user.id, project.id);
    assert.deepEqual(
      afterDelete.endpoints.map((value) => [value.endpointId, value.endpointName, value.requests, value.tokens, value.cost]),
      [["endpoint_1", "Primary", 2, 10, 2], [null, "Other provider activity", 1, 2, 0.25]],
    );
  });

  it("allows project viewers to read the overview and rejects non-members", async () => {
    const store = createLocalInMemoryProductStore();
    const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-usage-members", builtinAdminPassword: "admin-password" });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Usage" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Usage project" });
    const viewer = userRecord("viewer", "viewer@example.test"); const outsider = userRecord("outsider", "outsider@example.test");
    await Promise.all([store.createUser(viewer), store.createUser(outsider)]);
    await store.upsertProjectMembership({ projectId: project.id, userId: viewer.id, role: "viewer", createdAt: project.createdAt, updatedAt: project.updatedAt });
    assert.equal((await services.policies.getUsageOverview(viewer.id, project.id)).projectId, project.id);
    await assert.rejects(() => services.policies.getUsageOverview(outsider.id, project.id), /Project access denied/);
  });

  it("accrues live failed and releasing sandboxes for self and admin-selected members and fails closed on a missing run", async () => {
    const store=createLocalInMemoryProductStore();const services=createApplicationServices({store,dataRoot:"/tmp/agentsmith-sandbox-usage",builtinAdminPassword:"admin-password"});
    const {user:owner}=await services.auth.loginAfterBootstrap("admin-password");const workspace=await services.workspaces.createWorkspace(owner.id,{name:"Sandbox usage"});const project=await services.workspaces.createProject(owner.id,workspace.id,{name:"Sandbox usage"});
    const member=userRecord("usage_member","usage-member@example.test");await store.createUser(member);await store.upsertProjectMembership({projectId:project.id,userId:member.id,role:"member",createdAt:project.createdAt,updatedAt:project.updatedAt});
    const startedAt=new Date(Date.now()-10_000).toISOString();const task=liveTask(project.workspaceId,project.id,"usage_task",member.id,startedAt);const run=liveRun(task,startedAt);await createLiveTask(store,task,run);

    const selected=await services.policies.getUsageOverview(owner.id,project.id,undefined,member.id);
    assert.equal(selected.sandbox.selectedUserId,member.id);assert.equal(selected.sandbox.activeCount,1);assert.equal(selected.sandbox.launches,1);assert.ok(Number(selected.sandbox.totalDurationSeconds)>=9);assert.ok(Number(selected.sandbox.cpuRequestSeconds)>=2.25);assert.equal(selected.sandbox.rows[0]?.state,"live");
    const failed={...run,phase:"stopping" as const,cleanupStatus:"cleanup_requested" as const,terminalFailure:{reason:"pod_failed" as const},releaseReason:"failed" as const,fencingToken:run.fencingToken+1,updatedAt:new Date().toISOString()};await store.sandboxRuns.updateWithFencing(run.runId,run.fencingToken,failed);
    assert.ok(Number((await services.policies.getUsageOverview(member.id,project.id)).sandbox.totalDurationSeconds)>=Number(selected.sandbox.totalDurationSeconds));
    await assert.rejects(()=>services.policies.getUsageOverview(member.id,project.id,undefined,owner.id),/admin permission/);
    await assert.rejects(()=>services.policies.getUsageOverview(owner.id,project.id,undefined,"missing_member"),/Project member not found/);

    const missingTask=liveTask(project.workspaceId,project.id,"missing_run_task",member.id,startedAt);await createLiveTask(store,missingTask,null);
    await assert.rejects(()=>services.policies.getUsageOverview(owner.id,project.id,undefined,member.id),(error:any)=>error?.statusCode===503&&error?.code==="sandbox_usage_unavailable");
    await store.deleteTaskData(missingTask.id,new Date().toISOString());
    const unreserved={...liveTask(project.workspaceId,project.id,"unreserved_missing_run",member.id,startedAt),activeReservation:false};await createLiveTask(store,unreserved,null,false);
    await assert.rejects(()=>services.policies.getUsageOverview(owner.id,project.id,undefined,member.id),(error:any)=>error?.statusCode===503&&error?.code==="sandbox_usage_unavailable");
    await store.deleteTaskData(unreserved.id,new Date().toISOString());
    const dryRun={...liveTask(project.workspaceId,project.id,"dry_run_without_run",member.id,startedAt),executionMode:"dry-run" as const,activeReservation:false};await createLiveTask(store,dryRun,null,false);
    assert.equal((await services.policies.getUsageOverview(owner.id,project.id,undefined,member.id)).sandbox.activeCount,1);
  });

  it("settles release once, rejects conflicting retries, and retains history after task deletion", async () => {
    const store=createLocalInMemoryProductStore();const services=createApplicationServices({store,dataRoot:"/tmp/agentsmith-sandbox-settlement",builtinAdminPassword:"admin-password"});const {user}=await services.auth.loginAfterBootstrap("admin-password");const workspace=await services.workspaces.createWorkspace(user.id,{name:"Settlement"});const project=await services.workspaces.createProject(user.id,workspace.id,{name:"Settlement"});
    const startedAt="2026-07-19T00:00:00.000Z",releasedAt="2026-07-19T00:00:20.000Z";const task=liveTask(project.workspaceId,project.id,"settled_task",user.id,startedAt);const run=liveRun(task,startedAt);await createLiveTask(store,task,run);
    const cleaned={...run,phase:"cleaned" as const,cleanupStatus:"cleaned" as const,releaseReason:"requested" as const,fencingToken:run.fencingToken+1,updatedAt:releasedAt};const settlement={runId:run.runId,workspaceId:run.workspaceId,projectId:run.projectId,taskId:run.taskId,fileLibraryId:run.fileLibraryId,startedByUserId:user.id,startedAt,releasedAt,durationSeconds:20,resources:run.resourceSnapshot,releaseReason:"requested" as const};const auditEvent={id:`audit_sandbox_released_${run.runId}`,projectId:project.id,actorId:null,subjectUserId:user.id,action:"sandbox.released" as const,status:"accepted" as const,resourceKind:"sandbox" as const,resourceId:task.id,detail:{taskId:task.id,runId:run.runId,releaseReason:"requested" as const},createdAt:releasedAt};
    assert.equal(await store.completeSandboxRunRelease({runId:run.runId,expectedFencingToken:run.fencingToken,run:cleaned,settlement,auditEvent}),"applied");
    assert.equal(await store.completeSandboxRunRelease({runId:run.runId,expectedFencingToken:cleaned.fencingToken,run:cleaned,settlement,auditEvent}),"already_applied");
    assert.equal((await store.listSandboxUsageSettlements(project.id,user.id)).length,1);assert.equal((await store.listProjectAuditEvents(project.id)).filter((event)=>event.action==="sandbox.released").length,1);assert.equal((await store.findProjectResourceUsage(project.id))?.activeTasks,0);
    assert.equal(await store.completeSandboxRunRelease({runId:run.runId,expectedFencingToken:cleaned.fencingToken,run:cleaned,settlement:{...settlement,durationSeconds:21},auditEvent}),"conflict");
    assert.equal(await store.completeSandboxRunRelease({runId:run.runId,expectedFencingToken:cleaned.fencingToken,run:{...cleaned,startedAt:"2026-07-19T00:00:01.000Z"},settlement,auditEvent}),"conflict");
    await store.deleteTaskData(task.id,releasedAt);const usage=await services.policies.getUsageOverview(user.id,project.id);assert.equal(usage.sandbox.totalDurationSeconds,"20");assert.equal(usage.sandbox.rows[0]?.state,"settled");assert.equal(usage.sandbox.rows[0]?.runId,run.runId);
  });

  it("rolls back first settlement when the active Task is missing, mismatched, or unreserved",async()=>{
    for(const scenario of ["missing","mismatched","unreserved"] as const){
      const fixture=await releaseFixture(scenario),tasks=(fixture.store as unknown as {tasks:Map<string,PersistedAgentTask>}).tasks,current=tasks.get(fixture.task.id);assert.ok(current);
      if(scenario==="missing")tasks.delete(fixture.task.id);
      if(scenario==="mismatched")tasks.set(fixture.task.id,{...current,runId:`${current.runId}_other`});
      if(scenario==="unreserved")tasks.set(fixture.task.id,{...current,activeReservation:false});
      const beforeRun=await fixture.store.sandboxRuns.get(fixture.run.runId),beforeUsage=await fixture.store.findProjectResourceUsage(fixture.projectId);

      assert.equal(await fixture.store.completeSandboxRunRelease(fixture.release),"conflict");
      assert.deepEqual(await fixture.store.sandboxRuns.get(fixture.run.runId),beforeRun);
      assert.deepEqual(await fixture.store.findProjectResourceUsage(fixture.projectId),beforeUsage);
      assert.deepEqual(await fixture.store.listSandboxUsageSettlements(fixture.projectId,fixture.userId),[]);
      assert.equal((await fixture.store.listProjectAuditEvents(fixture.projectId)).filter((event)=>event.action==="sandbox.released").length,0);
    }
  });
});

function endpoint(id: string, projectId: string, name: string): ModelEndpoint { const now = new Date().toISOString(); return { id, projectId, name, protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId: "", capabilities: ["text"], requestTimeoutSecs: 30, createdAt: now, updatedAt: now }; }
async function settle(store: ReturnType<typeof createLocalInMemoryProductStore>, id: string, projectId: string, endpointId: string, actorId:string, time: string, usage: { tokens: number; cost: number }): Promise<void> { await store.reserveProjectProviderSettlement({ id, projectId, taskId: null, endpointId, actorId, reservedTokens: 0, reservedCost: 0, reservedAt: time, expiresAt: new Date(Date.parse(time) + 60_000).toISOString() }); await store.markProjectProviderSettlementDispatched(id, time); await store.markProjectProviderSettlementDelivered(id, time); await store.settleProjectProviderSettlement(id, usage, time); }
function userRecord(id: string, email: string): StoredUser { const now = new Date().toISOString(); return { id, email, emailVerified: true, passwordHash: "hash", createdAt: now, updatedAt: now }; }
function liveTask(workspaceId:string,projectId:string,id:string,userId:string,timestamp:string):PersistedAgentTask{return{id,workspaceId,projectId,endpointId:`endpoint_${id}`,fileLibraryId:`library_${id}`,createdByUserId:userId,title:id,prompt:id,status:"running",runId:`run_${id}`,executionMode:"live",sandbox:{namespace:"agentsmith",resources:[]},activeReservation:true,createdAt:timestamp,updatedAt:timestamp}}
function liveRun(task:PersistedAgentTask,startedAt:string):PersistedSandboxRunState{return{namespace:"agentsmith",workspaceId:task.workspaceId,projectId:task.projectId,taskId:task.id,runId:task.runId,phase:"running",image:"botified:test",pvcName:"files",projectSubPath:`workspaces/${task.workspaceId}/projects/${task.projectId}`,fileLibraryRootSubPath:`libraries/${task.fileLibraryId}/home`,fileLibraryId:task.fileLibraryId!,startedByUserId:task.createdByUserId!,startedAt,botifiedPort:3099,resourceNames:{pod:`pod-${task.id}`,service:`service-${task.id}`,configMap:`config-${task.id}`,secret:`secret-${task.id}`},serviceKeySecretRef:{name:`secret-${task.id}`,key:"BOTIFIED_SERVICE_KEY"},directories:{libraryHome:"/workspace/library",botified:"/workspace/botified"},resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},fencingToken:1,cleanupStatus:"active",createdAt:startedAt,updatedAt:startedAt}}
async function createLiveTask(store:ReturnType<typeof createLocalInMemoryProductStore>,task:PersistedAgentTask,run:PersistedSandboxRunState|null,reserveActive=true){const created=await store.createTaskAtomically({task,newFileLibrary:{id:task.fileLibraryId!,workspaceId:task.workspaceId,projectId:task.projectId,name:task.id,rootSubPath:`libraries/${task.fileLibraryId}/home`,createdByUserId:task.createdByUserId!,createdAt:task.createdAt,updatedAt:task.updatedAt},reserveActive,...(run?{sandboxRun:run}:{})});assert.equal(created.kind,"created")}
async function releaseFixture(label:string){const store=createLocalInMemoryProductStore(),services=createApplicationServices({store,dataRoot:`/tmp/agentsmith-sandbox-release-${label}`,builtinAdminPassword:"admin-password"}),{user}=await services.auth.loginAfterBootstrap("admin-password"),workspace=await services.workspaces.createWorkspace(user.id,{name:`Release ${label}`}),project=await services.workspaces.createProject(user.id,workspace.id,{name:`Release ${label}`});const startedAt="2026-07-19T00:00:00.000Z",releasedAt="2026-07-19T00:00:20.000Z",task=liveTask(project.workspaceId,project.id,`release_${label}`,user.id,startedAt),run=liveRun(task,startedAt);await createLiveTask(store,task,run);const cleaned={...run,phase:"cleaned" as const,cleanupStatus:"cleaned" as const,releaseReason:"requested" as const,fencingToken:run.fencingToken+1,updatedAt:releasedAt},settlement={runId:run.runId,workspaceId:run.workspaceId,projectId:run.projectId,taskId:run.taskId,fileLibraryId:run.fileLibraryId,startedByUserId:user.id,startedAt,releasedAt,durationSeconds:20,resources:run.resourceSnapshot,releaseReason:"requested" as const},auditEvent={id:`audit_sandbox_released_${run.runId}`,projectId:project.id,actorId:null,subjectUserId:user.id,action:"sandbox.released" as const,status:"accepted" as const,resourceKind:"sandbox" as const,resourceId:task.id,detail:{taskId:task.id,runId:run.runId,releaseReason:"requested" as const},createdAt:releasedAt};return{store,task,run,projectId:project.id,userId:user.id,release:{runId:run.runId,expectedFencingToken:run.fencingToken,run:cleaned,settlement,auditEvent}}}
