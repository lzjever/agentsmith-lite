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
    const failed=await new SandboxLifecycleService(store,{namespace:run.namespace,port:failingPort,now:()=>new Date(timestamp(3))}).reapSandboxRunsOnce({apply:true,runId:run.runId});

    assert.equal(failed.errors.length,1);
    const persistedFailure=await store.sandboxRuns.get(run.runId);assert.ok(persistedFailure);
    assert.equal(persistedFailure.state,"release_requested");
    assert.equal(persistedFailure.cleanupClaimedAt,null);
    assert.equal(persistedFailure.cleanupAttempts,1);
    assert.deepEqual(persistedFailure.lastCleanupError,{at:timestamp(3),target:`Pod/${run.resourceNames.pod}`,message:"Kubernetes cleanup failed with service <redacted> and broker <redacted>"});

    const retryPort=new LifecyclePort(resources,false);
    const retried=await new SandboxLifecycleService(store,{namespace:run.namespace,port:retryPort,now:()=>new Date(timestamp(4))}).reapSandboxRunsOnce({apply:true,runId:run.runId});
    assert.deepEqual(retried.errors,[]);
    const released=await store.sandboxRuns.get(run.runId);
    assert.equal(released?.state,"released");
    assert.equal(released?.lastCleanupError,null);
    assert.equal((await store.findProjectResourceUsage(run.projectId))?.activeSandboxes,0);
    assert.equal((await store.listSandboxUsageSettlements(run.projectId,run.startedByUserId)).length,1);
    assert.deepEqual((await store.queryProjectAuditEvents(run.projectId,{limit:20})).items.map((event)=>event.action),["sandbox.released"]);

    await new SandboxLifecycleService(store,{namespace:run.namespace,port:retryPort,now:()=>new Date(timestamp(5))}).reapSandboxRunsOnce({apply:true,runId:run.runId});
    assert.equal((await store.listSandboxUsageSettlements(run.projectId,run.startedByUserId)).length,1);
    assert.equal((await store.queryProjectAuditEvents(run.projectId,{limit:20})).items.length,1);
  });

  it("retains an exact inspection error and recovers on the next maintenance tick",async()=>{
    const store=createLocalInMemoryProductStore();
    const {run}=await createReleaseRequestedRun(store);
    const port=new LifecyclePort([],false);
    port.inspectFailures=1;
    const lifecycle=new SandboxLifecycleService(store,{namespace:run.namespace,port});

    const failed=await lifecycle.reapSandboxRunsOnce({apply:true,runId:run.runId});
    assert.equal(failed.errors.length,1);
    const pending=await store.sandboxRuns.get(run.runId);assert.ok(pending);
    assert.equal(pending.state,"release_requested");
    assert.equal(pending.cleanupClaimedAt,null);
    assert.match(pending.lastCleanupError?.message??"",/Exact inspection unavailable/);
    assert.equal(port.listCalls,1);
    assert.equal(port.inspectCalls.length,6);

    const recovered=await lifecycle.reapSandboxRunsOnce({apply:true,runId:run.runId});
    assert.deepEqual(recovered.errors,[]);
    assert.equal((await store.sandboxRuns.get(run.runId))?.state,"released");
    assert.equal(port.listCalls,2);
    assert.equal(port.inspectCalls.length,12);
    assert.equal((await store.listSandboxUsageSettlements(run.projectId,run.startedByUserId)).length,1);
    assert.equal((await store.queryProjectAuditEvents(run.projectId,{limit:20})).items.filter((event)=>event.action==="sandbox.released").length,1);
  });

  it("settles when exact inspection confirms an unknown DELETE outcome removed the resource",async()=>{
    const store=createLocalInMemoryProductStore();
    const {run}=await createReleaseRequestedRun(store);
    const port=new LifecyclePort(observedResources(run).filter((resource)=>resource.kind==="Pod"),false);
    port.failAfterDelete=true;

    const result=await new SandboxLifecycleService(store,{namespace:run.namespace,port,now:()=>new Date(timestamp(3))}).reapSandboxRunsOnce({apply:true,runId:run.runId});

    assert.deepEqual(result.errors,[]);
    assert.equal((await store.sandboxRuns.get(run.runId))?.state,"released");
    assert.equal(port.listCalls,1);
    assert.equal(port.inspectCalls.length,6);
    assert.equal((await store.listSandboxUsageSettlements(run.projectId,run.startedByUserId)).length,1);
  });

  it("clears the cleanup claim and stale error while an exact resource is terminating",async()=>{
    const store=createLocalInMemoryProductStore();
    const fixture=await createReleaseRequestedRun(store);
    const staleError={at:timestamp(2),target:"Pod/task-lifecycle",message:"old failure"};
    const run=await store.sandboxRuns.updateWithFencing(fixture.run.runId,fixture.run.fencingToken,{
      ...fixture.run,lastCleanupError:staleError,fencingToken:fixture.run.fencingToken+1,updatedAt:timestamp(2)
    });
    assert.ok(run);
    const resources=observedResources(run);
    const pod=resources.find((resource)=>resource.kind==="Pod");assert.ok(pod);
    pod.metadata.deletionTimestamp=timestamp(3);
    const port=new LifecyclePort(resources,false);

    const result=await new SandboxLifecycleService(store,{namespace:run.namespace,port,now:()=>new Date(timestamp(3))}).reapSandboxRunsOnce({apply:true,runId:run.runId});

    assert.deepEqual(result.errors,[]);
    const pending=await store.sandboxRuns.get(run.runId);assert.ok(pending);
    assert.equal(pending.state,"release_requested");
    assert.equal(pending.cleanupClaimedAt,null);
    assert.equal(pending.lastCleanupError,null);
    assert.equal(port.deletedRefs.some((ref)=>ref.kind==="Pod"),false);
    assert.equal((await store.listSandboxUsageSettlements(run.projectId,run.startedByUserId)).length,0);
  });

  it("clears and reports an owned cleanup claim when the successful-clear CAS conflicts",async()=>{
    const store=createLocalInMemoryProductStore();
    const {run}=await createReleaseRequestedRun(store);
    const resources=observedResources(run);
    const pod=resources.find((resource)=>resource.kind==="Pod");assert.ok(pod);
    pod.metadata.deletionTimestamp=timestamp(3);
    const update=store.sandboxRuns.updateWithFencing.bind(store.sandboxRuns);
    let conflict=true;
    store.sandboxRuns.updateWithFencing=async(...args)=>{
      if(conflict){conflict=false;return null;}
      return update(...args);
    };

    const result=await new SandboxLifecycleService(store,{
      namespace:run.namespace,
      port:new LifecyclePort(resources,false),
      now:()=>new Date(timestamp(3))
    }).reapSandboxRunsOnce({apply:true,runId:run.runId});

    assert.equal(result.errors.length,1);
    const pending=await store.sandboxRuns.get(run.runId);assert.ok(pending);
    assert.equal(pending.cleanupClaimedAt,null);
    assert.equal(pending.lastCleanupError?.target,"Sandbox cleanup claim");
  });

  it("stops cleanly when a successful-clear CAS conflict already cleared the claim",async()=>{
    const store=createLocalInMemoryProductStore();
    const {run}=await createReleaseRequestedRun(store);
    const resources=observedResources(run);
    const pod=resources.find((resource)=>resource.kind==="Pod");assert.ok(pod);
    pod.metadata.deletionTimestamp=timestamp(3);
    const update=store.sandboxRuns.updateWithFencing.bind(store.sandboxRuns);
    let conflict=true;
    store.sandboxRuns.updateWithFencing=async(...args)=>{
      if(!conflict)return update(...args);
      conflict=false;
      await update(...args);
      return null;
    };

    const result=await new SandboxLifecycleService(store,{
      namespace:run.namespace,
      port:new LifecyclePort(resources,false),
      now:()=>new Date(timestamp(3))
    }).reapSandboxRunsOnce({apply:true,runId:run.runId});

    assert.deepEqual(result.errors,[]);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupClaimedAt,null);
  });

  it("clears and reports an owned cleanup claim when final settlement conflicts",async()=>{
    const store=createLocalInMemoryProductStore();
    const {run}=await createReleaseRequestedRun(store);
    const complete=store.completeSandboxRunRelease.bind(store);
    let conflict=true;
    store.completeSandboxRunRelease=async(input)=>{
      if(conflict){conflict=false;return"conflict";}
      return complete(input);
    };

    const result=await new SandboxLifecycleService(store,{
      namespace:run.namespace,
      port:new LifecyclePort([],false),
      now:()=>new Date(timestamp(3))
    }).reapSandboxRunsOnce({apply:true,runId:run.runId});

    assert.equal(result.errors.length,1);
    const pending=await store.sandboxRuns.get(run.runId);assert.ok(pending);
    assert.equal(pending.state,"release_requested");
    assert.equal(pending.cleanupClaimedAt,null);
    assert.equal(pending.lastCleanupError?.target,"Sandbox release settlement");
  });

  it("fails closed when an exact resource belongs to another Run",async()=>{
    const store=createLocalInMemoryProductStore();
    const {run}=await createReleaseRequestedRun(store);
    const wrong=observedResources(run)[0]!;
    wrong.metadata.labels={...wrong.metadata.labels,"agentsmith-lite/run-id":"run_other"};
    const port=new LifecyclePort([wrong],false);

    const result=await new SandboxLifecycleService(store,{namespace:run.namespace,port,now:()=>new Date(timestamp(3))}).reapSandboxRunsOnce({apply:true,runId:run.runId});

    assert.equal(result.errors.length,1);
    const pending=await store.sandboxRuns.get(run.runId);assert.ok(pending);
    assert.equal(pending.state,"release_requested");
    assert.equal(pending.cleanupClaimedAt,null);
    assert.equal(port.deletedRefs.length,0);
    assert.equal((await store.listSandboxUsageSettlements(run.projectId,run.startedByUserId)).length,0);
  });

  it("does not issue any delete when the inventory Pod UID replaced the persisted startup Pod UID",async()=>{
    const store=createLocalInMemoryProductStore();
    const {run}=await createReleaseRequestedRun(store);
    const resources=observedResources(run);
    const pod=resources.find((resource)=>resource.kind==="Pod");assert.ok(pod);
    pod.metadata.uid="uid-replacement";
    const port=new LifecyclePort(resources,false);

    const result=await new SandboxLifecycleService(store,{namespace:run.namespace,port,now:()=>new Date(timestamp(3))})
      .reapSandboxRunsOnce({apply:true,runId:run.runId});

    assert.equal(result.errors.length,1);
    assert.equal(port.deletedRefs.length,0);
    const pending=await store.sandboxRuns.get(run.runId);assert.ok(pending);
    assert.equal(pending.cleanupClaimedAt,null);
    assert.match(pending.lastCleanupError?.message??"",/Pod UID fence mismatch/);
  });

  it("persists a safe inventory failure without consuming a cleanup claim",async()=>{
    const store=createLocalInMemoryProductStore();
    const {run}=await createReleaseRequestedRun(store);
    const lifecycle=new SandboxLifecycleService(store,{
      namespace:run.namespace,
      now:()=>new Date(timestamp(3)),
      port:{
        async listManagedResources(){throw new Error("Inventory rejected credential sk-private");},
        async inspectResource(){return"not_found" as const;},
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

  it("drains an expired startup action only after cleanup and atomically fails the same Run",async()=>{
    const store=createLocalInMemoryProductStore();
    const fixture=await createReleaseRequestedRun(store);
    const starting:PersistedSandboxRunState={
      ...fixture.run,state:"starting",startupReadyAt:timestamp(0),
      startupClaimToken:"crashed-startup",startupLeaseExpiresAt:timestamp(2),
      startupActionDeadlineAt:timestamp(3),releaseReason:null,releaseRequestedAt:null,
      fencingToken:fixture.run.fencingToken+1,updatedAt:timestamp(1)
    };
    assert.ok(await store.sandboxRuns.updateWithFencing(fixture.run.runId,fixture.run.fencingToken,starting));
    const resources=observedResources(starting);
    const port=new LifecyclePort(resources,false);

    await new SandboxLifecycleService(store,{namespace:starting.namespace,port,now:()=>new Date(timestamp(2))}).reapSandboxRunsOnce({apply:true,runId:starting.runId});
    assert.equal(port.deletedRefs.length,0);
    assert.equal((await store.sandboxRuns.get(starting.runId))?.startupActionDeadlineAt,timestamp(3));

    let localStartupPending=true;
    const lifecycle=new SandboxLifecycleService(store,{
      namespace:starting.namespace,port,now:()=>new Date(timestamp(4)),
      hasLocalStartupOperation:()=>localStartupPending
    });
    await lifecycle.reapSandboxRunsOnce({apply:true,runId:starting.runId});
    assert.equal(port.deletedRefs.length,0);
    assert.equal((await store.sandboxRuns.get(starting.runId))?.startupActionDeadlineAt,timestamp(3));

    localStartupPending=false;
    await lifecycle.reapSandboxRunsOnce({apply:true,runId:starting.runId});
    assert.equal(port.remainingResources().length,0);
    const drained=await store.sandboxRuns.get(starting.runId);assert.ok(drained);
    assert.equal(drained.state,"failed");
    assert.equal(drained.failureCode,"startup_failed");
    assert.ok(drained.releaseRequestedAt);
    assert.equal(drained.startupActionDeadlineAt,null);
    assert.equal(drained.startupClaimToken,null);
    assert.equal(drained.cleanupClaimedAt,null);
    assert.equal((await store.findProjectResourceUsage(starting.projectId))?.activeSandboxes,1);
    assert.equal((await store.claimSandboxStartup({
      taskId:drained.taskId,runId:drained.runId,expectedFencingToken:drained.fencingToken,
      claimToken:"recovered-startup",claimedAt:timestamp(5),leaseExpiresAt:timestamp(7)
    })).kind,"stale");
  });

  it("clears and reports an owned cleanup claim when startup drain conflicts",async()=>{
    const store=createLocalInMemoryProductStore();
    const fixture=await createReleaseRequestedRun(store);
    const starting:PersistedSandboxRunState={
      ...fixture.run,
      state:"starting",
      startupReadyAt:timestamp(0),
      startupClaimToken:"crashed-startup",
      startupLeaseExpiresAt:timestamp(2),
      startupActionDeadlineAt:timestamp(3),
      releaseReason:null,
      releaseRequestedAt:null,
      fencingToken:fixture.run.fencingToken+1,
      updatedAt:timestamp(1)
    };
    assert.ok(await store.sandboxRuns.updateWithFencing(fixture.run.runId,fixture.run.fencingToken,starting));
    const drain=store.drainSandboxStartupAction.bind(store);
    let conflict=true;
    store.drainSandboxStartupAction=async(input)=>{
      if(conflict){conflict=false;return null;}
      return drain(input);
    };

    const result=await new SandboxLifecycleService(store,{
      namespace:starting.namespace,
      port:new LifecyclePort(observedResources(starting),false),
      now:()=>new Date(timestamp(4))
    }).reapSandboxRunsOnce({apply:true,runId:starting.runId});

    assert.equal(result.errors.length,1);
    const pending=await store.sandboxRuns.get(starting.runId);assert.ok(pending);
    assert.equal(pending.state,"starting");
    assert.equal(pending.cleanupClaimedAt,null);
    assert.equal(pending.lastCleanupError?.target,"Sandbox startup drain");
  });

  it("does not claim release-requested cleanup while its local startup Promise is unsettled",async()=>{
    const store=createLocalInMemoryProductStore();
    const fixture=await createReleaseRequestedRun(store);
    const pending:PersistedSandboxRunState={
      ...fixture.run,
      startupClaimToken:"terminal-release-race",
      startupLeaseExpiresAt:timestamp(2),
      startupActionDeadlineAt:timestamp(3),
      fencingToken:fixture.run.fencingToken+1,
      updatedAt:timestamp(1)
    };
    assert.ok(await store.sandboxRuns.updateWithFencing(fixture.run.runId,fixture.run.fencingToken,pending));
    const port=new LifecyclePort(observedResources(pending),false);
    let localStartupPending=true,cleanupClaims=0;
    const claimForCleanup=store.sandboxRuns.claimForCleanup.bind(store.sandboxRuns);
    store.sandboxRuns.claimForCleanup=async(input)=>{cleanupClaims+=1;return claimForCleanup(input);};
    const lifecycle=new SandboxLifecycleService(store,{
      namespace:pending.namespace,
      port,
      now:()=>new Date(timestamp(4)),
      hasLocalStartupOperation:()=>localStartupPending
    });

    await lifecycle.reapSandboxRunsOnce({apply:true,runId:pending.runId});
    assert.equal(cleanupClaims,0);
    assert.equal(port.deletedRefs.length,0);
    assert.equal((await store.sandboxRuns.get(pending.runId))?.startupActionDeadlineAt,timestamp(3));

    localStartupPending=false;
    await lifecycle.reapSandboxRunsOnce({apply:true,runId:pending.runId});
    assert.ok(cleanupClaims>0);
    assert.equal(port.remainingResources().length,0);
    assert.equal((await store.sandboxRuns.get(pending.runId))?.state,"released");
  });
});

class LifecyclePort {
  private resources:KubernetesResource[];
  readonly deletedRefs:KubernetesResourceRef[]=[];
  readonly deletedLabels:Record<string,string>[]=[];
  readonly inspectCalls:KubernetesResourceRef[]=[];
  listCalls=0;
  inspectFailures=0;
  failAfterDelete=false;
  constructor(resources:KubernetesResource[],private readonly fail:boolean){this.resources=structuredClone(resources);}
  async listManagedResources():Promise<KubernetesResource[]>{this.listCalls+=1;return structuredClone(this.resources);}
  async inspectResource(ref:KubernetesResourceRef,expectedLabels:Record<string,string>){
    this.inspectCalls.push(structuredClone(ref));
    if(this.inspectFailures>0){
      this.inspectFailures-=1;
      throw new Error("Exact inspection unavailable for Bearer bsk_runtime_secret");
    }
    const resource=this.resources.find((candidate)=>
      candidate.kind===ref.kind&&candidate.metadata.name===ref.name&&candidate.metadata.namespace===ref.namespace
    );
    if(!resource)return"not_found" as const;
    const uid=typeof resource.metadata.uid==="string"&&resource.metadata.uid.length>0?resource.metadata.uid:null;
    if(!uid||Object.entries(expectedLabels).some(([key,value])=>resource.metadata.labels[key]!==value)||ref.uid&&uid!==ref.uid)return"fence_mismatch" as const;
    return{state:"present" as const,resource:structuredClone(resource)};
  }
  async applyResource():Promise<"applied">{return"applied";}
  async deleteResource(ref:KubernetesResourceRef,expectedLabels:Record<string,string>):Promise<"deleted"|"not_found">{
    if(this.fail)throw new Error("Kubernetes cleanup failed with service bsk_runtime_secret and broker lbk_runtime_secret");
    this.deletedRefs.push(structuredClone(ref));
    this.deletedLabels.push(structuredClone(expectedLabels));
    const before=this.resources.length;
    this.resources=this.resources.filter((resource)=>resource.kind!==ref.kind||resource.metadata.name!==ref.name||resource.metadata.namespace!==ref.namespace||resource.metadata.uid!==ref.uid||Object.entries(expectedLabels).some(([key,value])=>resource.metadata.labels[key]!==value));
    if(this.failAfterDelete)throw new Error("Kubernetes DELETE outcome unknown");
    return this.resources.length===before?"not_found":"deleted";
  }
  remainingResources():KubernetesResource[]{return structuredClone(this.resources);}
}

async function createReleaseRequestedRun(store:ReturnType<typeof createLocalInMemoryProductStore>){
  const owner="user_lifecycle",workspaceId="workspace_lifecycle",projectId="project_lifecycle",taskId="task_lifecycle",libraryId="library_lifecycle";
  await store.createUser({id:owner,email:"lifecycle@example.test",emailVerified:true,passwordHash:"hash",createdAt:timestamp(0),updatedAt:timestamp(0)});
  await store.createWorkspace({id:workspaceId,name:"Workspace",ownerUserId:owner,createdAt:timestamp(0),updatedAt:timestamp(0)});
  await store.createProject({id:projectId,workspaceId,name:"Project",ownerUserId:owner,rootPath:`workspaces/${workspaceId}/projects/${projectId}`,sandboxLimit:1,createdAt:timestamp(0),updatedAt:timestamp(0)});
  const task:PersistedAgentTask={id:taskId,workspaceId,projectId,endpointId:"endpoint_lifecycle",fileLibraryId:libraryId,createdByUserId:owner,title:"Task",prompt:"Work",agentContext:"",currentRunId:"run_lifecycle",archivedAt:null,deletedAt:null,createdAt:timestamp(0),updatedAt:timestamp(0)};
  const run:PersistedSandboxRunState={workspaceId,projectId,taskId,runId:task.currentRunId!,namespace:"agentsmith",state:"release_requested",image:"botified:test",pvcName:"files",projectSubPath:`workspaces/${workspaceId}/projects/${projectId}`,fileLibraryRootSubPath:`libraries/${libraryId}/home`,fileLibraryId:libraryId,startedByUserId:owner,startedAt:timestamp(0),startupReadyAt:null,startupActionDeadlineAt:null,startupPodUid:"uid-pod",botifiedPort:3099,resourceNames:{pod:"task-lifecycle",service:"task-lifecycle",configMap:"task-lifecycle-config",secret:"task-lifecycle-secret",serviceAccount:"task-lifecycle",networkPolicy:"task-lifecycle"},serviceKeySecretRef:{name:"task-lifecycle-secret",key:"BOTIFIED_SERVICE_KEY"},directories:{libraryHome:"/workspace/library",botified:"/workspace/botified"},resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},failureCode:null,failureCause:null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,releaseReason:"requested",releaseRequestedAt:timestamp(1),failedAt:null,releasedAt:null,createdAt:timestamp(0),updatedAt:timestamp(1)};
  const created=await store.createTaskAtomically({task,reserveActive:true, admission:{namespace:"agentsmith",namespaceLimit:100},idempotency:{actorId:owner,projectId,operation:"create",key:"fixture-lifecycle",requestHash:"fixture-lifecycle-hash",resourceId:taskId,claimToken:"fixture-lifecycle-claim",now:timestamp(0),leaseExpiresAt:timestamp(9)},rejectionPresentation:null,rejectedAuditEvent:{id:"audit_fixture_lifecycle_rejected",projectId,actorId:owner,action:"task.create",status:"rejected",resourceKind:"task",resourceId:taskId,detail:{taskId,trigger:"task_create"},createdAt:timestamp(0)},newFileLibrary:{id:libraryId,workspaceId,projectId,name:"Library",rootSubPath:run.fileLibraryRootSubPath,lifecycleStatus:"active" as const,createdByUserId:owner,createdAt:timestamp(0),updatedAt:timestamp(0)},sandboxRun:run});
  assert.equal(created.kind,"created");
  return{task,run};
}

function observedResources(run:PersistedSandboxRunState):KubernetesResource[]{
  const active={...run,state:"active" as const,releaseReason:null,releaseRequestedAt:null,startedAt:timestamp(0),startupPodUid:null};
  const plan=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[active],observedResources:[],now:new Date(timestamp(1))});
  return applySandboxReconcileActions({observedResources:[],actions:plan.actions}).observedResources.map((resource)=>({
    ...resource,
    metadata:{...resource.metadata,uid:`uid-${resource.kind.toLowerCase()}`}
  }));
}

function orphanRun():PersistedSandboxRunState{
  return {
    workspaceId:"workspace_orphan",projectId:"project_orphan",taskId:"task_orphan",runId:"run_orphan",
    namespace:"agentsmith",state:"active",image:"botified:test",pvcName:"files",
    projectSubPath:"workspaces/workspace_orphan/projects/project_orphan",
    fileLibraryRootSubPath:"libraries/library_orphan/home",fileLibraryId:"library_orphan",
    startedByUserId:"user_orphan",startedAt:timestamp(0),startupReadyAt:timestamp(0),startupActionDeadlineAt:null,botifiedPort:3099,
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
