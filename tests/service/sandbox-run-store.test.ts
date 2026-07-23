import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import type { SandboxRunState } from "../../packages/sandbox-controller/src/reconciler.js";
import { normalizeSandboxResources, parseKubernetesCpuMillis, parseKubernetesMemoryBytes } from "../../packages/domain/src/kubernetesQuantity.js";

describe("sandbox run store", () => {
  it("normalizes Kubernetes quantities exactly and rounds positive memory sub-units up", () => {
    assert.deepEqual(normalizeSandboxResources({cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1500m",memoryLimit:"2Gi"}),{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1500",memoryLimitBytes:"2147483648"});
    assert.equal(parseKubernetesCpuMillis("1e-3"),"1");
    assert.equal(parseKubernetesCpuMillis("2E3"),"2000000");
    assert.equal(parseKubernetesCpuMillis("1e-4"),"1");
    assert.equal(parseKubernetesCpuMillis("0.000001"),"1");
    assert.equal(parseKubernetesCpuMillis("0.1m"),"1");
    assert.equal(parseKubernetesCpuMillis("1n"),"1");
    assert.equal(parseKubernetesCpuMillis("0e-1000"),"0");
    assert.equal(parseKubernetesCpuMillis("0.0000m"),"0");
    assert.equal(parseKubernetesMemoryBytes("1.1"),"2");
    assert.equal(parseKubernetesMemoryBytes("1.1Ki"),"1127");
    assert.equal(parseKubernetesMemoryBytes("1e-9"),"1");
  });

  it("rejects invalid, negative, and overflowing quantities",()=>{
    for(const value of ["-1","1K","1foo","NaN"])assert.throws(()=>parseKubernetesMemoryBytes(value),/invalid/);
    assert.throws(()=>parseKubernetesMemoryBytes("9223372036854775808"),/exceeds/);
    assert.throws(()=>parseKubernetesCpuMillis("9223372036854775808"),/exceeds/);
    assert.throws(()=>parseKubernetesMemoryBytes("1e100000000000000000"),/exponent exceeds/);
  });
  it("confirms sandbox start once and preserves the first timestamp on retry", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun();
    await store.sandboxRuns.put(run);

    const first = await store.confirmSandboxRunStarted({
      runId: run.runId,
      expectedFencingToken: run.fencingToken,
      startedAt: "2026-07-04T00:01:00.000Z",
      auditEvent: {
        id: `audit_sandbox_started_${run.runId}`,
        projectId: run.projectId,
        actorId: null,
        subjectUserId: run.startedByUserId,
        action: "sandbox.started",
        status: "accepted",
        resourceKind: "sandbox",
        resourceId: run.taskId,
        detail: { taskId: run.taskId, runId: run.runId },
        createdAt: "2026-07-04T00:01:00.000Z"
      }
    });
    assert.notEqual(first.kind,"conflict");
    if(first.kind==="conflict")return;
    const retry = await store.confirmSandboxRunStarted({
      runId: run.runId,
      expectedFencingToken: first.run.fencingToken,
      startedAt: "2026-07-04T00:02:00.000Z",
      auditEvent: {
        id: `audit_sandbox_started_${run.runId}`,
        projectId: run.projectId,
        actorId: null,
        subjectUserId: run.startedByUserId,
        action: "sandbox.started",
        status: "accepted",
        resourceKind: "sandbox",
        resourceId: run.taskId,
        detail: { taskId: run.taskId, runId: run.runId },
        createdAt: "2026-07-04T00:02:00.000Z"
      }
    });

    assert.equal(first.kind, "started");
    assert.equal(retry.kind, "already_started");
    assert.equal(retry.run.startedAt, "2026-07-04T00:01:00.000Z");
    assert.equal((await store.listProjectAuditEvents(run.projectId)).filter((event) => event.action === "sandbox.started").length, 1);
    await store.appendProjectAuditEvent({id:"audit_release_request",projectId:run.projectId,actorId:"admin1",subjectUserId:run.startedByUserId,action:"sandbox.release_requested",status:"accepted",resourceKind:"sandbox",resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId},createdAt:"2026-07-04T00:03:00.000Z"});
    assert.deepEqual((await store.queryProjectAuditEvents(run.projectId,{actorId:"admin1"})).items.map((event)=>event.id),["audit_release_request"]);
    assert.deepEqual((await store.queryProjectAuditEvents(run.projectId,{subjectUserId:run.startedByUserId})).items.map((event)=>event.id),["audit_release_request",`audit_sandbox_started_${run.runId}`]);
  });

  it("persists bounded terminal runner failure metadata without Kubernetes status text", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ terminalFailure: { reason: "runner_terminated", exitCode: 19 } });

    await store.sandboxRuns.put(run);

    assert.deepEqual((await store.sandboxRuns.get(run.runId))?.terminalFailure, {
      reason: "runner_terminated",
      exitCode: 19
    });
  });

  it("rejects malformed persisted terminal failure metadata", async () => {
    const store = createLocalInMemoryProductStore();

    await assert.rejects(
      () => store.sandboxRuns.put({
        ...sandboxRun(),
        terminalFailure: {
          reason: "unknown_failure",
          exitCode: 999,
          syncAttempts: -1,
          syncStatus: "forever"
        }
      } as unknown as SandboxRunState),
      /terminalFailure/
    );
    assert.equal(await store.jsonDocs.get("sandbox_run_state", "run1"), null);
  });

  it("rejects incoherent terminal failure settlement combinations", async () => {
    const store = createLocalInMemoryProductStore();
    for (const terminalFailure of [
      { reason: "pod_failed", syncAttempts: 3, syncStatus: "pending", lastSyncAt: "2026-07-04T00:00:00.000Z", lastSyncError: "unavailable" },
      { reason: "pod_failed", syncAttempts: 2, syncStatus: "unavailable", lastSyncAt: "2026-07-04T00:00:00.000Z", lastSyncError: "unavailable" },
      { reason: "pod_failed", syncStatus: "synced", lastSyncAt: "2026-07-04T00:00:00.000Z", lastSyncError: null }
    ]) {
      await assert.rejects(
        () => store.sandboxRuns.put({ ...sandboxRun(), terminalFailure } as unknown as SandboxRunState),
        /terminalFailure/
      );
    }
  });

  it("persists typed run state through the sandbox_run_state JSON collection", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun();
    const cleaned = sandboxRun({
      runId: "run-clean",
      taskId: "task-clean",
      phase: "cleaned",
      cleanupStatus: "cleaned",
      fencingToken: 3
    });

    assert.deepEqual(await store.sandboxRuns.put(run), run);
    await store.sandboxRuns.put(cleaned);

    assert.deepEqual(await store.sandboxRuns.get(run.runId), run);
    assert.deepEqual((await store.sandboxRuns.list()).map((item) => item.runId), ["run1", "run-clean"]);
    assert.deepEqual((await store.sandboxRuns.listActive()).map((item) => item.runId), ["run1"]);
    assert.deepEqual(await store.jsonDocs.get("sandbox_run_state", run.runId), run as unknown as Record<string, unknown>);
  });

  it("updates with fencing and rejects stale tokens", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ fencingToken: 7 });
    await store.sandboxRuns.put(run);

    const stale = await store.sandboxRuns.updateWithFencing(run.runId, 6, {
      ...run,
      phase: "running",
      fencingToken: 8
    });
    assert.equal(stale, null);
    assert.equal((await store.sandboxRuns.get(run.runId))?.phase, "starting");

    const updated = await store.sandboxRuns.updateWithFencing(run.runId, 7, {
      ...run,
      phase: "running",
      fencingToken: 8,
      updatedAt: "2026-07-04T00:01:00.000Z"
    });
    assert.equal(updated?.phase, "running");
    assert.equal(updated?.fencingToken, 8);
    assert.equal((await store.sandboxRuns.get(run.runId))?.phase, "running");
  });

  it("atomically activates the exact Task and Run with an idempotent concurrent loser",async()=>{
    const store=createLocalInMemoryProductStore();
    const run=sandboxRun();
    const timestamp=run.createdAt;
    const task={
      id:run.taskId,
      workspaceId:run.workspaceId,
      projectId:run.projectId,
      endpointId:"endpoint1",
      fileLibraryId:run.fileLibraryId,
      createdByUserId:run.startedByUserId,
      title:"Task",
      prompt:"work",
      status:"starting" as const,
      runId:run.runId,
      executionMode:"live" as const,
      activeReservation:true,
      sandbox:{namespace:run.namespace,resources:[]},
      createdAt:timestamp,
      updatedAt:timestamp
    };
    const created=await store.createTaskAtomically({
      task,
      newFileLibrary:{id:run.fileLibraryId,workspaceId:run.workspaceId,projectId:run.projectId,name:"Task Library",rootSubPath:run.fileLibraryRootSubPath,createdByUserId:run.startedByUserId,createdAt:timestamp,updatedAt:timestamp},
      reserveActive:false,
      sandboxRun:run
    });
    assert.equal(created.kind,"created");
    if(created.kind!=="created")return;
    await store.updateTask({...created.task,activeReservation:true});
    const started=await store.confirmSandboxRunStarted({
      runId:run.runId,
      expectedFencingToken:run.fencingToken,
      startedAt:"2026-07-04T00:01:00.000Z",
      auditEvent:{id:`audit_sandbox_started_${run.runId}`,projectId:run.projectId,actorId:null,subjectUserId:run.startedByUserId,action:"sandbox.started",status:"accepted",resourceKind:"sandbox",resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId},createdAt:"2026-07-04T00:01:00.000Z"}
    });
    assert.notEqual(started.kind,"conflict");
    if(started.kind==="conflict")return;
    const input={taskId:task.id,runId:run.runId,expectedFencingToken:started.run.fencingToken,activatedAt:"2026-07-04T00:02:00.000Z"};

    const results=await Promise.all([store.activateTaskSandboxRun(input),store.activateTaskSandboxRun(input)]);
    const wrongTask=await store.activateTaskSandboxRun({...input,taskId:"task-other",expectedFencingToken:(await store.sandboxRuns.get(run.runId))!.fencingToken});
    const runningTask=await store.findTask(task.id);
    assert.ok(runningTask);
    await store.updateTask({...runningTask,status:"queued",updatedAt:"2026-07-04T00:03:00.000Z"});
    const queuedRetry=await store.activateTaskSandboxRun(input);
    const queuedTask=await store.findTask(task.id);
    assert.ok(queuedTask);
    await store.updateTask({...queuedTask,activeReservation:false,updatedAt:"2026-07-04T00:04:00.000Z"});
    const unreservedRetry=await store.activateTaskSandboxRun(input);

    assert.deepEqual(results.map((result)=>result.kind).sort(),["activated","already_running"]);
    assert.equal(wrongTask.kind,"conflict");
    assert.equal(queuedRetry.kind,"already_running");
    assert.equal(unreservedRetry.kind,"conflict");
    assert.equal((await store.findTask(task.id))?.status,"queued");
    assert.equal((await store.sandboxRuns.get(run.runId))?.phase,"running");
  });

  it("rejects secret values in persisted sandbox run state", async () => {
    const store = createLocalInMemoryProductStore();

    await assert.rejects(
      () =>
        store.sandboxRuns.put({
          ...sandboxRun(),
          serviceKey: "bsk_real_service_key"
        } as unknown as SandboxRunState),
      /must not contain secret values/
    );

    await assert.rejects(
      () =>
        store.sandboxRuns.put({
          ...sandboxRun(),
          modelApiKey: "sk-real-model-key"
        } as unknown as SandboxRunState),
      /must not contain secret values/
    );
  });
});

function sandboxRun(overrides: Partial<SandboxRunState> = {}): SandboxRunState {
  return {
    workspaceId: "ws1",
    projectId: "proj1",
    taskId: "task1",
    runId: "run1",
    namespace: "agentsmith",
    phase: "starting",
    image: "agentsmith-lite/botified-runner:test",
    pvcName: "agentsmith-lite-files",
    projectSubPath: "workspaces/ws1/projects/proj1",
    fileLibraryRootSubPath: "libraries/library-task1/home",
    fileLibraryId: "library-task1",
    startedByUserId: "user1",
    startedAt: null,
    botifiedPort: 3099,
    resourceNames: {
      pod: "asl-task-task1",
      service: "asl-task-task1",
      configMap: "asl-task-task1-config",
      secret: "asl-botified-task1",
      serviceAccount: "asl-task-task1",
      networkPolicy: "asl-task-task1"
    },
    serviceKeySecretRef: {
      name: "asl-botified-task1",
      key: "BOTIFIED_SERVICE_KEY"
    },
    directories: {
      libraryHome: "/workspace/project/libraries/library-task1/home",
      botified: "/workspace/project/tasks/task1/botified"
    },
    resourceLimits: {
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    },
    resourceSnapshot: {
      cpuRequestMillis:"250",
      memoryRequestBytes:"536870912",
      cpuLimitMillis:"1000",
      memoryLimitBytes:"1073741824"
    },
    fencingToken: 1,
    cleanupStatus: "active",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides
  };
}
