import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { PersistedAgentTask, PersistedSandboxRunState } from "../../packages/ports/src/store.js";

describe("project Sandbox Usage",()=>{
  it("attributes an unreleased Run to its starter rather than the Task creator",async()=>{
    const fixture=await setup("live");
    const overview=await fixture.services.policies.getUsageOverview(fixture.userId,fixture.projectId,undefined,fixture.runnerId);
    assert.equal(overview.sandbox.activeCount,1);
    assert.equal(overview.sandbox.rows[0]?.state,"live");
    assert.equal(overview.sandbox.rows[0]?.runId,fixture.run.runId);
    assert.equal((await fixture.services.policies.getUsageOverview(fixture.userId,fixture.projectId,undefined,fixture.userId)).sandbox.activeCount,0);
  });

  it("settles a released Run once and removes it from live capacity",async()=>{
    const fixture=await setup("settled");
    const releasedAt="2026-07-23T00:02:00.000Z";
    const released:PersistedSandboxRunState={...fixture.run,state:"released",releaseReason:"requested",releaseRequestedAt:"2026-07-23T00:01:00.000Z",releasedAt,fencingToken:2,updatedAt:releasedAt};
    const settlement={runId:released.runId,workspaceId:released.workspaceId,projectId:released.projectId,taskId:released.taskId,fileLibraryId:released.fileLibraryId,startedByUserId:released.startedByUserId,startedAt:released.startedAt,releasedAt,durationSeconds:120,resources:released.resourceSnapshot,releaseReason:"requested" as const};
    const input={runId:released.runId,expectedFencingToken:fixture.run.fencingToken,run:released,settlement,auditEvent:{id:"audit_release",projectId:released.projectId,actorId:null,subjectUserId:released.startedByUserId,action:"sandbox.released" as const,status:"accepted" as const,resourceKind:"sandbox" as const,resourceId:released.taskId,detail:{taskId:released.taskId,runId:released.runId,releaseReason:"requested" as const},createdAt:releasedAt}};

    assert.equal(await fixture.store.completeSandboxRunRelease(input),"applied");
    assert.equal(await fixture.store.completeSandboxRunRelease({...input,expectedFencingToken:released.fencingToken}),"already_applied");
    assert.equal(await fixture.store.completeSandboxRunRelease({...input,expectedFencingToken:released.fencingToken,settlement:{...settlement,durationSeconds:121}}),"conflict");
    const overview=await fixture.services.policies.getUsageOverview(fixture.userId,fixture.projectId,undefined,fixture.runnerId);
    assert.equal(overview.sandbox.activeCount,0);
    assert.equal(overview.sandbox.rows[0]?.state,"settled");
    assert.equal(overview.sandbox.totalDurationSeconds,"120");
    assert.equal((await fixture.store.findProjectResourceUsage(fixture.projectId))?.activeTasks,0);
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
  return{store,services,userId:user.id,runnerId,projectId:project.id,run};
}

function liveRun(task:PersistedAgentTask,startedAt:string,startedByUserId:string):PersistedSandboxRunState{return{
  namespace:"agentsmith",workspaceId:task.workspaceId,projectId:task.projectId,taskId:task.id,runId:task.currentRunId!,
  state:"active",image:"botified:test",pvcName:"files",projectSubPath:`workspaces/${task.workspaceId}/projects/${task.projectId}`,
  fileLibraryRootSubPath:`libraries/${task.fileLibraryId}/home`,fileLibraryId:task.fileLibraryId!,startedByUserId,startedAt,botifiedPort:3099,
  resourceNames:{pod:`pod-${task.id}`,service:`service-${task.id}`,configMap:`config-${task.id}`,secret:`secret-${task.id}`},
  serviceKeySecretRef:{name:`secret-${task.id}`,key:"BOTIFIED_SERVICE_KEY"},directories:{libraryHome:"/workspace/library",botified:"/workspace/botified"},
  resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},
  resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},
  failureCode:null,failureCause:null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,
  releaseReason:null,releaseRequestedAt:null,failedAt:null,releasedAt:null,createdAt:startedAt,updatedAt:startedAt
}}
