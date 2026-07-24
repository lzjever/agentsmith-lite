import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import type { PersistedAgentTask, PersistedSandboxRunState } from "../../packages/ports/src/store.js";

describe("project Sandbox Usage",()=>{
  it("keeps full totals in the overview while returning only capacity-holding live Runs",async()=>{
    const fixture=await setup("overview");
    await release(fixture.store,fixture.run,"2026-07-23T00:02:00.000Z",120);
    await fixture.services.policies.updatePolicy(fixture.userId,fixture.projectId,{activeTasksLimit:4});
    const starting=await createRun(fixture,"starting",null,"starting");
    await createRun(fixture,"release-requested",null,"release_requested");
    await createRun(fixture,"failed",null,"failed");
    const readOverview=fixture.store.readProjectUsageOverview.bind(fixture.store);
    let overviewReads=0;
    fixture.store.readProjectUsageOverview=async(input)=>{overviewReads+=1;return readOverview(input)};

    const overview=await fixture.services.policies.getUsageOverview(fixture.userId,fixture.projectId,undefined,fixture.runnerId);
    assert.equal(overviewReads,1);
    assert.equal(overview.sandbox.unreleasedCount,3);
    assert.equal("activeCount" in overview.sandbox,false);
    assert.equal(overview.sandbox.launches,1);
    assert.equal(overview.sandbox.totalDurationSeconds,"120");
    assert.equal(overview.sandbox.liveRuns.length,3);
    assert.deepEqual(new Set(overview.sandbox.liveRuns.map((run)=>run.state)),new Set(["starting","release_requested","failed"]));
    assert.deepEqual(overview.sandbox.liveRuns[0],{
      taskId:starting.task.id,
      taskTitle:"Task starting",
      taskAvailable:true,
      runId:starting.run.runId,
      fileLibraryId:starting.run.fileLibraryId,
      state:"starting",
      startedAt:null,
      durationSeconds:0,
      resources:starting.run.resourceSnapshot
    });
    assert.equal(overview.sandbox.summaryStartedAt,fixture.project.createdAt);
    assert.match(overview.sandbox.measuredAt,/Z$/);
    assert.equal((await fixture.services.policies.getUsageOverview(fixture.userId,fixture.projectId,undefined,fixture.userId)).sandbox.unreleasedCount,0);
  });

  it("settles a released Run once and exposes it only through bounded history",async()=>{
    const fixture=await setup("settled");
    const releasedAt="2026-07-23T00:02:00.000Z";
    const released:PersistedSandboxRunState={...fixture.run,state:"released",releaseReason:"requested",releaseRequestedAt:"2026-07-23T00:01:00.000Z",releasedAt,fencingToken:2,updatedAt:releasedAt};
    const settlement={runId:released.runId,workspaceId:released.workspaceId,projectId:released.projectId,taskId:released.taskId,fileLibraryId:released.fileLibraryId,startedByUserId:released.startedByUserId,startedAt:released.startedAt,releasedAt,durationSeconds:120,resources:released.resourceSnapshot,releaseReason:"requested" as const};
    const input={runId:released.runId,expectedFencingToken:fixture.run.fencingToken,run:released,settlement,auditEvent:{id:"audit_release",projectId:released.projectId,actorId:null,subjectUserId:released.startedByUserId,action:"sandbox.released" as const,status:"accepted" as const,resourceKind:"sandbox" as const,resourceId:released.taskId,detail:{taskId:released.taskId,runId:released.runId,releaseReason:"requested" as const},createdAt:releasedAt}};

    assert.equal(await fixture.store.completeSandboxRunRelease(input),"applied");
    assert.equal(await fixture.store.completeSandboxRunRelease({...input,expectedFencingToken:released.fencingToken}),"already_applied");
    assert.equal(await fixture.store.completeSandboxRunRelease({...input,expectedFencingToken:released.fencingToken,settlement:{...settlement,durationSeconds:121}}),"conflict");
    const overview=await fixture.services.policies.getUsageOverview(fixture.userId,fixture.projectId,undefined,fixture.runnerId);
    assert.equal(overview.sandbox.unreleasedCount,0);
    assert.deepEqual(overview.sandbox.liveRuns,[]);
    assert.equal(overview.sandbox.totalDurationSeconds,"120");
    const history=await fixture.services.policies.getSandboxRunHistory(fixture.userId,fixture.projectId,{selectedUserId:fixture.runnerId});
    assert.equal(history.items[0]?.runId,fixture.run.runId);
    assert.equal(history.items[0]?.taskTitle,"Task");
    assert.equal(history.items[0]?.taskAvailable,true);
    assert.equal((await fixture.store.findProjectResourceUsage(fixture.projectId))?.activeTasks,0);
  });

  it("pages 55 tied settlements with a scope-bound snapshot cursor and deleted Task projection",async()=>{
    const fixture=await setup("history");
    const releasedAt="2026-07-23T00:02:00.000Z";
    await release(fixture.store,fixture.run,releasedAt,120);
    for(let index=0;index<54;index++){
      const created=await createRun(fixture,String(index).padStart(2,"0"),"2026-07-23T00:00:00.000Z","active");
      await release(fixture.store,created.run,releasedAt,120);
    }
    assert.equal((await fixture.store.beginTaskDeletion(fixture.task.id,"2026-07-23T00:03:00.000Z")).kind,"ready");

    const totalsBefore=(await fixture.services.policies.getUsageOverview(fixture.userId,fixture.projectId,undefined,fixture.runnerId)).sandbox;
    const first=await fixture.services.policies.getSandboxRunHistory(fixture.userId,fixture.projectId,{selectedUserId:fixture.runnerId});
    assert.equal(first.items.length,20);
    assert.ok(first.nextCursor);
    assert.equal(first.items[0]?.runId,"run_history");
    assert.equal(first.items[0]?.taskTitle,null);
    assert.equal(first.items[0]?.taskAvailable,false);
    assert.deepEqual(first.items.map((item)=>item.runId),[...first.items.map((item)=>item.runId)].sort().reverse());

    const laterReleasedAt=new Date(Date.parse(first.scopeMeasuredAt)+1000).toISOString();
    const later=await createRun(fixture,"later",new Date(Date.parse(laterReleasedAt)-1000).toISOString(),"active");
    await release(fixture.store,later.run,laterReleasedAt,1);
    const second=await fixture.services.policies.getSandboxRunHistory(fixture.userId,fixture.projectId,{selectedUserId:fixture.runnerId,cursor:first.nextCursor!});
    const third=await fixture.services.policies.getSandboxRunHistory(fixture.userId,fixture.projectId,{selectedUserId:fixture.runnerId,cursor:second.nextCursor!});
    assert.deepEqual([first.items.length,second.items.length,third.items.length],[20,20,15]);
    assert.equal(third.nextCursor,null);
    const ids=[...first.items,...second.items,...third.items].map((item)=>item.runId);
    assert.equal(new Set(ids).size,55);
    assert.equal(ids.includes(later.run.runId),false);
    assert.equal(second.scopeMeasuredAt,first.scopeMeasuredAt);
    assert.equal(third.scopeMeasuredAt,first.scopeMeasuredAt);
    assert.deepEqual((await fixture.services.policies.getUsageOverview(fixture.userId,fixture.projectId,undefined,fixture.runnerId)).sandbox.totalDurationSeconds,String(Number(totalsBefore.totalDurationSeconds)+1));

    const fifty=await fixture.services.policies.getSandboxRunHistory(fixture.userId,fixture.projectId,{selectedUserId:fixture.runnerId,limit:50});
    assert.equal(fifty.items.length,50);
    await assert.rejects(
      ()=>fixture.services.policies.getSandboxRunHistory(fixture.userId,fixture.projectId,{selectedUserId:fixture.userId,cursor:first.nextCursor!}),
      (error:unknown)=>error instanceof ProductError&&error.statusCode===400
    );
    await assert.rejects(
      ()=>fixture.services.policies.getSandboxRunHistory(fixture.userId,fixture.projectId,{selectedUserId:fixture.runnerId,cursor:"not-a-canonical-cursor"}),
      (error:unknown)=>error instanceof ProductError&&error.statusCode===400
    );
  });
});

async function setup(label:string){
  const store=createLocalInMemoryProductStore();
  const services=createApplicationServices({store,dataRoot:`/tmp/agentsmith-usage-${label}`,builtinAdminPassword:"admin-password"});
  const {user}=await services.auth.loginAfterBootstrap("admin-password");
  const workspace=await services.workspaces.createWorkspace(user.id,{name:"Workspace"});
  const project=await services.workspaces.createProject(user.id,workspace.id,{name:"Project"});
  const createdAt="2026-07-23T00:00:00.000Z";
  const runnerId=`runner_${label}`;
  const runnerEmail=`${runnerId}@example.test`;
  await store.createUser({id:runnerId,email:runnerEmail,emailVerified:true,passwordHash:"hash",createdAt,updatedAt:createdAt});
  await services.workspaceMemberships.add(user.id,workspace.id,{email:runnerEmail},"member");
  await services.memberships.addMember(user.id,project.id,runnerId,"member");
  const task:PersistedAgentTask={id:`task_${label}`,workspaceId:workspace.id,projectId:project.id,endpointId:`endpoint_${label}`,fileLibraryId:`library_${label}`,createdByUserId:user.id,title:"Task",prompt:"Work",agentContext:"",currentRunId:`run_${label}`,archivedAt:null,deletedAt:null,createdAt,updatedAt:createdAt};
  const run=liveRun(task,createdAt,runnerId);
  const created=await store.createTaskAtomically({task,reserveActive:true,newFileLibrary:{id:task.fileLibraryId!,workspaceId:workspace.id,projectId:project.id,name:"Library",rootSubPath:`libraries/${task.fileLibraryId}/home`,createdByUserId:user.id,createdAt,updatedAt:createdAt},sandboxRun:run});
  assert.equal(created.kind,"created");
  return{store,services,userId:user.id,runnerId,workspace,project,projectId:project.id,task,run};
}

async function createRun(fixture:Awaited<ReturnType<typeof setup>>,label:string,startedAt:string|null,state:"starting"|"active"|"release_requested"|"failed"){
  const task:PersistedAgentTask={...fixture.task,id:`task_${label}`,fileLibraryId:`library_${label}`,currentRunId:`run_${label}`,title:`Task ${label}`,createdAt:startedAt??fixture.project.createdAt,updatedAt:startedAt??fixture.project.createdAt};
  const run=liveRun(task,startedAt,fixture.runnerId,state);
  const result=await fixture.store.createTaskAtomically({task,reserveActive:true,newFileLibrary:{id:task.fileLibraryId!,workspaceId:task.workspaceId,projectId:task.projectId,name:`Library ${label}`,rootSubPath:`libraries/${task.fileLibraryId}/home`,createdByUserId:fixture.userId,createdAt:task.createdAt,updatedAt:task.updatedAt},sandboxRun:run});
  assert.equal(result.kind,"created");
  return{task,run};
}

async function release(store:ReturnType<typeof createLocalInMemoryProductStore>,run:PersistedSandboxRunState,releasedAt:string,durationSeconds:number){
  const released:PersistedSandboxRunState={...run,state:"released",releaseReason:"requested",releaseRequestedAt:releasedAt,releasedAt,fencingToken:run.fencingToken+1,updatedAt:releasedAt};
  assert.equal(await store.completeSandboxRunRelease({runId:run.runId,expectedFencingToken:run.fencingToken,run:released,settlement:{runId:run.runId,workspaceId:run.workspaceId,projectId:run.projectId,taskId:run.taskId,fileLibraryId:run.fileLibraryId,startedByUserId:run.startedByUserId,startedAt:run.startedAt,releasedAt,durationSeconds,resources:run.resourceSnapshot,releaseReason:"requested"},auditEvent:{id:`audit_release_${run.runId}`,projectId:run.projectId,actorId:null,subjectUserId:run.startedByUserId,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId,releaseReason:"requested"},createdAt:releasedAt}}),"applied");
}

function liveRun(task:PersistedAgentTask,startedAt:string|null,startedByUserId:string,state:"starting"|"active"|"release_requested"|"failed"="active"):PersistedSandboxRunState{return{
  namespace:"agentsmith",workspaceId:task.workspaceId,projectId:task.projectId,taskId:task.id,runId:task.currentRunId!,
  state,image:"botified:test",pvcName:"files",projectSubPath:`workspaces/${task.workspaceId}/projects/${task.projectId}`,
  fileLibraryRootSubPath:`libraries/${task.fileLibraryId}/home`,fileLibraryId:task.fileLibraryId!,startedByUserId,startedAt,botifiedPort:3099,
  resourceNames:{pod:`pod-${task.id}`,service:`service-${task.id}`,configMap:`config-${task.id}`,secret:`secret-${task.id}`},
  serviceKeySecretRef:{name:`secret-${task.id}`,key:"BOTIFIED_SERVICE_KEY"},directories:{libraryHome:"/workspace/library",botified:"/workspace/botified"},
  resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},
  resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},
  failureCode:state==="failed"?"startup_failed":null,failureCause:state==="failed"?"failed":null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,
  releaseReason:state==="failed"?"failed":state==="release_requested"?"requested":null,releaseRequestedAt:state==="failed"||state==="release_requested"?task.createdAt:null,failedAt:state==="failed"?task.createdAt:null,releasedAt:null,createdAt:startedAt??task.createdAt,updatedAt:startedAt??task.createdAt
}}
