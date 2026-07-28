import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import {
  applySandboxReconcileActions,
  reconcileSandboxRuns,
  type SandboxRunState
} from "../../packages/sandbox-controller/src/reconciler.js";

describe("sandbox reconciler final Run states", () => {
  it("renders one fenced resource set for a starting Run", () => {
    const run=sandboxRun();
    const plan=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[run],observedResources:[],now:new Date(run.updatedAt)});
    assert.deepEqual(plan.actions.filter((action)=>action.type==="create_resource").map((action)=>action.kind),[
      "Secret","ConfigMap","ServiceAccount","NetworkPolicy","Service","Pod"
    ]);
    assert.equal(plan.actions.at(-1)?.type,"store_run_state");
  });

  it("renders new Pods from the authoritative whole-Run resource snapshot", () => {
    const run=sandboxRun({
      resourceLimits:{cpuRequest:"9",memoryRequest:"9Gi",cpuLimit:"10",memoryLimit:"10Gi"},
      resourceSnapshot:{
        cpuRequestMillis:"251",
        memoryRequestBytes:"513",
        cpuLimitMillis:"1001",
        memoryLimitBytes:"1025"
      }
    });
    const plan=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[run],observedResources:[],now:new Date(run.updatedAt)});
    const pod=plan.actions.find((action)=>action.type==="create_resource"&&action.kind==="Pod");
    assert.ok(pod?.type==="create_resource");
    const spec=pod.resource.spec as {
      initContainers:Array<{resources:ContainerResources}>;
      containers:Array<{name:string;resources:ContainerResources}>;
    };
    const botified=spec.containers.find((container)=>container.name==="botified-server");
    const terminal=spec.containers.find((container)=>container.name==="bash-executor");
    assert.ok(botified);
    assert.ok(terminal);
    assert.deepEqual(spec.initContainers[0]?.resources,{
      requests:{cpu:"251m",memory:"513"},
      limits:{cpu:"1001m",memory:"1025"}
    });
    assert.deepEqual(sumContainerResources(botified.resources,terminal.resources),{
      cpuRequestMillis:251n,
      memoryRequestBytes:513n,
      cpuLimitMillis:1001n,
      memoryLimitBytes:1025n
    });

    const observed=createdResourcesWithUids(run);
    const existingPod=observed.find((resource)=>resource.kind==="Pod");
    assert.ok(existingPod);
    const existingContainers=(existingPod.spec as {containers:Array<{resources:ContainerResources}>}).containers;
    for(const container of existingContainers){
      container.resources={
        requests:{cpu:"251m",memory:"513"},
        limits:{cpu:"1001m",memory:"1025"}
      };
    }
    const existingPlan=reconcileSandboxRuns({
      namespace:run.namespace,
      desiredRuns:[run],
      observedResources:observed,
      now:new Date(run.updatedAt)
    });
    assert.equal(existingPlan.actions.some((action)=>
      action.type==="create_resource"&&action.kind==="Pod"
    ),false);
  });

  it("moves an exact failed Pod to a failed Run with a safe cause and release intent", () => {
    const run=sandboxRun({state:"active",startedAt:timestamp(1)});
    const resources=createdResources(run);
    const pod=resources.find((resource)=>resource.kind==="Pod");
    assert.ok(pod);
    pod.status={phase:"Failed",message:"do not expose this"};

    const plan=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[run],observedResources:resources,now:new Date(timestamp(2))});
    const transition=plan.actions.find((action)=>action.type==="store_run_state"&&action.reason==="terminal_runner_failure");
    assert.ok(transition&&transition.type==="store_run_state");
    assert.equal(transition.run.state,"failed");
    assert.equal(transition.run.failureCause,"Sandbox Pod stopped unexpectedly");
    assert.equal(transition.run.failureCode,"runner_failed");
    assert.deepEqual(transition.run.terminalFailure,{reason:"pod_failed"});
    assert.equal(transition.run.failureCause.includes("do not expose this"),false);
    assert.equal(transition.run.failedAt,timestamp(2));
    assert.equal(transition.run.releaseRequestedAt,timestamp(2));
    assert.equal(plan.actions.some((action)=>action.type==="delete_resource"),false);
  });

  it("fails a Run when botified-server terminates while the Pod and bash-executor remain running", () => {
    const run=sandboxRun({state:"active",startedAt:timestamp(1)});
    const resources=createdResources(run);
    const pod=resources.find((resource)=>resource.kind==="Pod");
    assert.ok(pod);
    pod.status={
      phase:"Running",
      containerStatuses:[
        {name:"botified-server",state:{terminated:{exitCode:1,reason:"Error"}}},
        {name:"bash-executor",state:{running:{startedAt:timestamp(1)}}}
      ]
    };

    const plan=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[run],observedResources:resources,now:new Date(timestamp(2))});
    const transition=plan.actions.find((action)=>action.type==="store_run_state"&&action.reason==="terminal_runner_failure");
    assert.ok(transition&&transition.type==="store_run_state");
    assert.equal(transition.run.state,"failed");
    assert.equal(transition.run.failureCause,"Botified stopped unexpectedly");
    assert.deepEqual(transition.run.terminalFailure,{reason:"runner_terminated",exitCode:1});
    assert.equal(transition.run.releaseRequestedAt,timestamp(2));
  });

  it("does not fail for botified startup or when only bash-executor terminates", () => {
    const run=sandboxRun({state:"active",startedAt:timestamp(1)});
    const containerStatusCases=[
      [
        {name:"botified-server",state:{waiting:{reason:"ContainerCreating"}}},
        {name:"bash-executor",state:{running:{startedAt:timestamp(1)}}}
      ],
      [
        {name:"botified-server",state:{running:{startedAt:timestamp(1)}}},
        {name:"bash-executor",state:{terminated:{exitCode:1,reason:"Error"}}}
      ]
    ];

    for (const containerStatuses of containerStatusCases) {
      const resources=createdResources(run);
      const pod=resources.find((resource)=>resource.kind==="Pod");
      assert.ok(pod);
      pod.status={phase:"Running",containerStatuses};

      const plan=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[run],observedResources:resources,now:new Date(timestamp(2))});
      assert.equal(plan.actions.some((action)=>action.type==="store_run_state"&&action.reason==="terminal_runner_failure"),false);
      assert.equal(plan.actions.some((action)=>action.type==="store_run_state"&&action.reason==="desired_observed"),true);
    }
  });

  it("deletes only exact Run resources and releases only after they are absent", () => {
    const run=sandboxRun({state:"release_requested",releaseReason:"requested",releaseRequestedAt:timestamp(2)});
    const resources=createdResources({...run,state:"active",startedAt:timestamp(1)});
    const foreignPod=structuredClone(resources.find((resource)=>resource.kind==="Pod")!);
    foreignPod.metadata.labels["agentsmith-lite/run-id"]="run_foreign";
    resources.push(foreignPod);
    const first=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[run],observedResources:resources,now:new Date(timestamp(3))});
    assert.deepEqual(first.actions.filter((action)=>action.type==="delete_resource").map((action)=>action.kind),[
      "Pod","Service","NetworkPolicy","ConfigMap","Secret","ServiceAccount"
    ]);
    const applied=applySandboxReconcileActions({observedResources:resources,actions:first.actions});
    assert.equal(applied.observedResources.some((resource)=>resource.metadata.labels["agentsmith-lite/run-id"]==="run_foreign"),true);
    const final=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[run],observedResources:applied.observedResources,now:new Date(timestamp(4))});
    const released=final.actions.find((action)=>action.type==="store_run_state"&&action.reason==="cleanup_complete");
    assert.ok(released&&released.type==="store_run_state");
    assert.equal(released.run.state,"released");
    assert.equal(released.run.releasedAt,timestamp(4));
  });

  it("leaves resources for every persisted Run untouched", () => {
    const run=sandboxRun();
    const resources=createdResourcesWithUids(run);
    const plan=reconcileSandboxRuns({
      namespace:run.namespace,
      desiredRuns:[],
      persistedRunIds:[run.runId],
      observedResources:resources,
      now:new Date(timestamp(2))
    });

    assert.deepEqual(plan.errors,[]);
    assert.equal(plan.actions.some((action)=>action.type==="delete_resource"),false);
  });

  it("never treats a desired Run as orphaned when the persisted snapshot is stale",()=>{
    const run=sandboxRun({state:"active",startedAt:timestamp(1)});
    const resources=createdResourcesWithUids(run);
    const plan=reconcileSandboxRuns({
      namespace:run.namespace,
      desiredRuns:[run],
      persistedRunIds:[],
      observedResources:resources,
      now:new Date(timestamp(2))
    });

    assert.deepEqual(plan.errors,[]);
    assert.equal(plan.actions.some((action)=>action.type==="delete_resource"),false);
  });

  it("fails closed for partial or mismatched orphan ownership", () => {
    const run=sandboxRun();
    const resources=createdResourcesWithUids(run);
    delete resources[0]!.metadata.labels["agentsmith-lite/task-id"];
    resources[1]!.metadata.labels["agentsmith-lite/project-id"]="project_other";
    const unowned=structuredClone(resources[2]!);
    unowned.metadata.labels["agentsmith-lite/managed-by"]="someone-else";
    resources.push(unowned);

    const plan=reconcileSandboxRuns({
      namespace:run.namespace,
      desiredRuns:[],
      persistedRunIds:[],
      observedResources:resources,
      now:new Date(timestamp(2))
    });

    assert.equal(plan.actions.some((action)=>action.type==="delete_resource"),false);
    assert.deepEqual(plan.errors,[
      `Orphan sandbox resource group ${run.runId} has incomplete or mismatched ownership`
    ]);
  });

  it("keeps orphan Run deletion fenced from every other Run", () => {
    const first=sandboxRun();
    const second=sandboxRun({
      workspaceId:"workspace_2",
      projectId:"project_2",
      taskId:"task_2",
      runId:"run_2",
      fileLibraryId:"library_2",
      fileLibraryRootSubPath:"libraries/library_2/home",
      resourceNames:{
        pod:"task-2",
        service:"task-2",
        configMap:"task-2-config",
        secret:"task-2-secret",
        serviceAccount:"task-2",
        networkPolicy:"task-2"
      },
      serviceKeySecretRef:{name:"task-2-secret",key:"BOTIFIED_SERVICE_KEY"}
    });
    const observedResources=[...createdResourcesWithUids(first),...createdResourcesWithUids(second)];
    const plan=reconcileSandboxRuns({
      namespace:first.namespace,
      desiredRuns:[],
      persistedRunIds:[],
      observedResources,
      now:new Date(timestamp(2))
    });
    const firstActions=plan.actions.filter((action)=>
      action.type==="delete_resource"&&action.runId===first.runId
    );
    const applied=applySandboxReconcileActions({observedResources,actions:firstActions});

    assert.equal(applied.observedResources.some((resource)=>
      resource.metadata.labels["agentsmith-lite/run-id"]===first.runId
    ),false);
    assert.equal(applied.observedResources.filter((resource)=>
      resource.metadata.labels["agentsmith-lite/run-id"]===second.runId
    ).length,6);
  });
});

function createdResources(run:SandboxRunState):KubernetesResource[]{
  const plan=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[run],observedResources:[],now:new Date(run.updatedAt)});
  return applySandboxReconcileActions({observedResources:[],actions:plan.actions}).observedResources;
}

interface ContainerResources {
  requests:{cpu:string;memory:string};
  limits:{cpu:string;memory:string};
}

function sumContainerResources(left:ContainerResources,right:ContainerResources){
  return{
    cpuRequestMillis:cpuMillis(left.requests.cpu)+cpuMillis(right.requests.cpu),
    memoryRequestBytes:BigInt(left.requests.memory)+BigInt(right.requests.memory),
    cpuLimitMillis:cpuMillis(left.limits.cpu)+cpuMillis(right.limits.cpu),
    memoryLimitBytes:BigInt(left.limits.memory)+BigInt(right.limits.memory)
  };
}

function cpuMillis(value:string):bigint{
  assert.match(value,/^[1-9][0-9]*m$/);
  return BigInt(value.slice(0,-1));
}

function createdResourcesWithUids(run:SandboxRunState):KubernetesResource[]{
  return createdResources(run).map((resource)=>({
    ...resource,
    metadata:{...resource.metadata,uid:`uid-${run.runId}-${resource.kind.toLowerCase()}`}
  }));
}

function sandboxRun(overrides:Partial<SandboxRunState>={}):SandboxRunState{
  return {
    workspaceId:"workspace_1",projectId:"project_1",taskId:"task_1",runId:"run_1",
    namespace:"agentsmith",state:"starting",image:"agentsmith-lite/botified-runner:test",
    pvcName:"agentsmith-lite-files",projectSubPath:"workspaces/workspace_1/projects/project_1",
    fileLibraryRootSubPath:"libraries/library_1/home",fileLibraryId:"library_1",
    startedByUserId:"user_1",startedAt:null,botifiedPort:3099,
    resourceNames:{pod:"task-1",service:"task-1",configMap:"task-1-config",secret:"task-1-secret",serviceAccount:"task-1",networkPolicy:"task-1"},
    serviceKeySecretRef:{name:"task-1-secret",key:"BOTIFIED_SERVICE_KEY"},
    directories:{libraryHome:"/workspace/task/home",botified:"/workspace/task/botified"},
    resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},
    resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},
    failureCode:null,failureCause:null,fencingToken:1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,
    releaseReason:null,releaseRequestedAt:null,failedAt:null,releasedAt:null,
    createdAt:timestamp(0),updatedAt:timestamp(0),...overrides
  };
}

function timestamp(minute:number):string{return `2026-07-23T00:${String(minute).padStart(2,"0")}:00.000Z`}
