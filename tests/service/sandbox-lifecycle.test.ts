import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { SandboxLifecycleService } from "../../packages/application/src/sandboxLifecycleService.js";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import type { PersistedAgentTask, PersistedSandboxRunState } from "../../packages/ports/src/store.js";
import type { KubernetesResourceRef } from "../../packages/sandbox-controller/src/kubernetesPort.js";
import { applySandboxReconcileActions, reconcileSandboxRuns } from "../../packages/sandbox-controller/src/reconciler.js";

describe("sandbox lifecycle fenced cleanup",()=>{
  it("deletes a fully identified orphan with observed UID preconditions",async()=>{
    const store=createLocalInMemoryProductStore();
    const run=orphanRun();
    const resources=observedResources(run).map((resource)=>({
      ...resource,
      metadata:{...resource.metadata,uid:`uid-${resource.kind.toLowerCase()}`}
    }));
    const port=new LifecyclePort(resources,false);

    const result=await new SandboxLifecycleService(store,{
      namespace:run.namespace,
      port,
      now:()=>new Date(timestamp(3))
    }).reapSandboxRunsOnce({apply:true});

    assert.deepEqual(result.errors,[]);
    assert.equal(port.remainingResources().length,0);
    assert.equal(port.deletedRefs.length,6);
    assert.equal(port.deletedRefs.every((ref)=>typeof ref.uid==="string"&&ref.uid.length>0),true);
    assert.equal(port.deletedLabels.every((labels)=>
      labels["agentsmith-lite/run-id"]===run.runId &&
      labels["agentsmith-lite/workspace-id"]===run.workspaceId &&
      labels["agentsmith-lite/project-id"]===run.projectId &&
      labels["agentsmith-lite/task-id"]===run.taskId
    ),true);
    assert.equal((await store.listSandboxUsageSettlements(run.projectId,run.startedByUserId)).length,0);
  });

  it("defers orphan deletion when the Run appears after reconciliation",async()=>{
    const store=createLocalInMemoryProductStore();
    const run=orphanRun();
    const resources=observedResources(run).map((resource)=>({
      ...resource,
      metadata:{...resource.metadata,uid:`uid-${resource.kind.toLowerCase()}`}
    }));
    const originalGet=store.sandboxRuns.get.bind(store.sandboxRuns);
    store.sandboxRuns.get=async(runId)=>runId===run.runId?structuredClone(run):originalGet(runId);
    const port=new LifecyclePort(resources,false);

    const result=await new SandboxLifecycleService(store,{
      namespace:run.namespace,
      port,
      now:()=>new Date(timestamp(3))
    }).reapSandboxRunsOnce({apply:true});

    assert.deepEqual(result.errors,[]);
    assert.equal(port.deletedRefs.length,0);
    assert.equal(port.remainingResources().length,6);
  });

  it("persists a bounded cleanup failure, clears its claim, and settles a later retry once",async()=>{
    const store=createLocalInMemoryProductStore();
    const {run}=await createReleaseRequestedRun(store);
    const resources=observedResources(run);
    const failingPort=new LifecyclePort(resources,true);
    const failed=await new SandboxLifecycleService(store,{namespace:run.namespace,port:failingPort,now:()=>new Date(timestamp(3)),deleteResourceErrorConfirmAttempts:1,deleteResourceErrorConfirmDelayMs:0}).reapSandboxRunsOnce({apply:true,runId:run.runId});

    assert.equal(failed.errors.length,1);
    const persistedFailure=await store.sandboxRuns.get(run.runId);assert.ok(persistedFailure);
    assert.equal(persistedFailure.state,"release_requested");
    assert.equal(persistedFailure.cleanupClaimedAt,null);
    assert.equal(persistedFailure.cleanupAttempts,1);
    assert.deepEqual(persistedFailure.lastCleanupError,{at:timestamp(3),target:`Pod/${run.resourceNames.pod}`,message:"Kubernetes cleanup failed with credential <redacted>"});

    const retryPort=new LifecyclePort(resources,false);
    const retried=await new SandboxLifecycleService(store,{namespace:run.namespace,port:retryPort,now:()=>new Date(timestamp(4))}).reapSandboxRunsOnce({apply:true,runId:run.runId});
    assert.deepEqual(retried.errors,[]);
    assert.equal((await store.sandboxRuns.get(run.runId))?.state,"released");
    assert.equal((await store.findProjectResourceUsage(run.projectId))?.activeTasks,0);
    assert.equal((await store.listSandboxUsageSettlements(run.projectId,run.startedByUserId)).length,1);
    assert.deepEqual((await store.queryProjectAuditEvents(run.projectId,{limit:20})).items.map((event)=>event.action),["sandbox.released"]);

    await new SandboxLifecycleService(store,{namespace:run.namespace,port:retryPort,now:()=>new Date(timestamp(5))}).reapSandboxRunsOnce({apply:true,runId:run.runId});
    assert.equal((await store.listSandboxUsageSettlements(run.projectId,run.startedByUserId)).length,1);
    assert.equal((await store.queryProjectAuditEvents(run.projectId,{limit:20})).items.length,1);
  });

  it("persists a safe inventory failure without consuming a cleanup claim",async()=>{
    const store=createLocalInMemoryProductStore();
    const {run}=await createReleaseRequestedRun(store);
    const lifecycle=new SandboxLifecycleService(store,{
      namespace:run.namespace,
      now:()=>new Date(timestamp(3)),
      port:{
        async listManagedResources(){throw new Error("Inventory rejected credential sk-private");},
        async applyResource(){return"applied" as const;},
        async deleteResource(){return"deleted" as const;}
      }
    });

    const result=await lifecycle.reapSandboxRunsOnce({apply:true});
    assert.equal(result.errors.length,1);
    const persisted=await store.sandboxRuns.get(run.runId);assert.ok(persisted);
    assert.equal(persisted.cleanupAttempts,0);
    assert.equal(persisted.cleanupClaimedAt,null);
    assert.deepEqual(persisted.lastCleanupError,{at:timestamp(3),target:"Kubernetes inventory",message:"Inventory rejected credential <redacted>"});
  });
});

class LifecyclePort {
  private resources:KubernetesResource[];
  readonly deletedRefs:KubernetesResourceRef[]=[];
  readonly deletedLabels:Record<string,string>[]=[];
  constructor(resources:KubernetesResource[],private readonly fail:boolean){this.resources=structuredClone(resources);}
  async listManagedResources():Promise<KubernetesResource[]>{return structuredClone(this.resources);}
  async applyResource():Promise<"applied">{return"applied";}
  async deleteResource(ref:KubernetesResourceRef,expectedLabels:Record<string,string>):Promise<"deleted"|"not_found">{
    if(this.fail)throw new Error("Kubernetes cleanup failed with credential sk-private");
    this.deletedRefs.push(structuredClone(ref));
    this.deletedLabels.push(structuredClone(expectedLabels));
    const before=this.resources.length;
    this.resources=this.resources.filter((resource)=>resource.kind!==ref.kind||resource.metadata.name!==ref.name||resource.metadata.namespace!==ref.namespace||resource.metadata.uid!==ref.uid||Object.entries(expectedLabels).some(([key,value])=>resource.metadata.labels[key]!==value));
    return this.resources.length===before?"not_found":"deleted";
  }
  remainingResources():KubernetesResource[]{return structuredClone(this.resources);}
}

async function createReleaseRequestedRun(store:ReturnType<typeof createLocalInMemoryProductStore>){
  const owner="user_lifecycle",workspaceId="workspace_lifecycle",projectId="project_lifecycle",taskId="task_lifecycle",libraryId="library_lifecycle";
  await store.createUser({id:owner,email:"lifecycle@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp(0),updatedAt:timestamp(0)});
  await store.createWorkspace({id:workspaceId,name:"Workspace",ownerUserId:owner,createdAt:timestamp(0),updatedAt:timestamp(0)});
  await store.createProject({id:projectId,workspaceId,name:"Project",ownerUserId:owner,rootPath:`workspaces/${workspaceId}/projects/${projectId}`,taskConcurrencyLimit:1,createdAt:timestamp(0),updatedAt:timestamp(0)});
  const task:PersistedAgentTask={id:taskId,workspaceId,projectId,endpointId:"endpoint_lifecycle",fileLibraryId:libraryId,createdByUserId:owner,title:"Task",prompt:"Work",agentContext:"",currentRunId:"run_lifecycle",archivedAt:null,deletedAt:null,createdAt:timestamp(0),updatedAt:timestamp(0)};
  const run:PersistedSandboxRunState={workspaceId,projectId,taskId,runId:task.currentRunId!,namespace:"agentsmith",state:"release_requested",image:"botified:test",pvcName:"files",projectSubPath:`workspaces/${workspaceId}/projects/${projectId}`,fileLibraryRootSubPath:`libraries/${libraryId}/home`,fileLibraryId:libraryId,startedByUserId:owner,startedAt:timestamp(0),botifiedPort:3099,resourceNames:{pod:"task-lifecycle",service:"task-lifecycle",configMap:"task-lifecycle-config",secret:"task-lifecycle-secret",serviceAccount:"task-lifecycle",networkPolicy:"task-lifecycle"},serviceKeySecretRef:{name:"task-lifecycle-secret",key:"BOTIFIED_SERVICE_KEY"},directories:{libraryHome:"/workspace/library",botified:"/workspace/botified"},resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},failureCode:null,failureCause:null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,releaseReason:"requested",releaseRequestedAt:timestamp(1),failedAt:null,releasedAt:null,createdAt:timestamp(0),updatedAt:timestamp(1)};
  const created=await store.createTaskAtomically({task,reserveActive:true,newFileLibrary:{id:libraryId,workspaceId,projectId,name:"Library",rootSubPath:run.fileLibraryRootSubPath,createdByUserId:owner,createdAt:timestamp(0),updatedAt:timestamp(0)},sandboxRun:run});
  assert.equal(created.kind,"created");
  return{task,run};
}

function observedResources(run:PersistedSandboxRunState):KubernetesResource[]{
  const active={...run,state:"active" as const,releaseReason:null,releaseRequestedAt:null,startedAt:timestamp(0)};
  const plan=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[active],observedResources:[],now:new Date(timestamp(1))});
  return applySandboxReconcileActions({observedResources:[],actions:plan.actions}).observedResources;
}

function orphanRun():PersistedSandboxRunState{
  return {
    workspaceId:"workspace_orphan",projectId:"project_orphan",taskId:"task_orphan",runId:"run_orphan",
    namespace:"agentsmith",state:"active",image:"botified:test",pvcName:"files",
    projectSubPath:"workspaces/workspace_orphan/projects/project_orphan",
    fileLibraryRootSubPath:"libraries/library_orphan/home",fileLibraryId:"library_orphan",
    startedByUserId:"user_orphan",startedAt:timestamp(0),botifiedPort:3099,
    resourceNames:{pod:"task-orphan",service:"task-orphan",configMap:"task-orphan-config",secret:"task-orphan-secret",serviceAccount:"task-orphan",networkPolicy:"task-orphan"},
    serviceKeySecretRef:{name:"task-orphan-secret",key:"BOTIFIED_SERVICE_KEY"},
    directories:{libraryHome:"/workspace/library",botified:"/workspace/botified"},
    resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},
    resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},
    failureCode:null,failureCause:null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,
    lastCleanupAt:null,lastCleanupError:null,releaseReason:null,releaseRequestedAt:null,failedAt:null,releasedAt:null,
    createdAt:timestamp(0),updatedAt:timestamp(0)
  };
}

function timestamp(minute:number):string{return`2026-07-23T00:${String(minute).padStart(2,"0")}:00.000Z`;}
