import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import type { SandboxRunState } from "../../packages/sandbox-controller/src/reconciler.js";

describe("sandbox run store", () => {
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
    fencingToken: 1,
    cleanupStatus: "active",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides
  };
}
