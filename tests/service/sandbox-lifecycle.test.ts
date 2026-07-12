import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { SandboxLifecycleService, type RuntimeDirectoryCleaner } from "../../packages/application/src/sandboxLifecycleService.js";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import { SandboxKubernetesPort } from "../../packages/sandbox-controller/src/kubernetesPort.js";
import type {
  KubernetesResourceRef,
  KubernetesTransport,
  KubernetesTransportRequest,
  KubernetesTransportResponse,
  SandboxKubernetesMutationPort
} from "../../packages/sandbox-controller/src/kubernetesPort.js";
import {
  applySandboxReconcileActions,
  reconcileSandboxRuns,
  type SandboxRunState
} from "../../packages/sandbox-controller/src/reconciler.js";
import { renderSandboxResources } from "../../packages/sandbox-controller/src/manifestRenderer.js";

describe("sandbox lifecycle service", () => {
  it("keeps Botified resources when artifact projection fails before cleanup", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ phase: "stopping", cleanupStatus: "cleanup_requested" });
    await store.sandboxRuns.put(run);
    const port = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)));
    const projectedRuns: string[] = [];
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: run.namespace,
      port,
      artifactProjection: {
        async projectPublishedArtifactsForRun(runId) {
          projectedRuns.push(runId);
          throw new Error("Botified artifact download failed");
        }
      }
    });

    const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    assert.deepEqual(projectedRuns, [run.runId]);
    assert.match(result.errors[0] ?? "", /artifact projection failed before runtime cleanup/);
    assert.deepEqual(port.deletedRefs, []);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
  });

  it("skips a stale cleanup claim and continues reaping later independent runs", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ phase: "stopping", cleanupStatus: "cleanup_requested" });
    const laterRun = sandboxRunFor("task2", "run2", { phase: "stopping", cleanupStatus: "cleanup_requested" });
    await store.sandboxRuns.put(run);
    await store.sandboxRuns.put(laterRun);
    const updateWithFencing = store.sandboxRuns.updateWithFencing.bind(store.sandboxRuns);
    let stalePlanRejected = false;
    store.sandboxRuns.updateWithFencing = async (runId, token, next) => {
      if (!stalePlanRejected && runId === run.runId && next.cleanupStatus === "deleting") {
        stalePlanRejected = true;
        const current = await store.sandboxRuns.get(runId);
        assert.ok(current);
        await updateWithFencing(runId, current.fencingToken, {
          ...current,
          phase: "running",
          cleanupStatus: "active",
          fencingToken: current.fencingToken + 1,
          updatedAt: "2026-07-04T00:00:01.000Z"
        });
        return null;
      }
      return updateWithFencing(runId, token, next);
    };
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: run.namespace,
      port: new FakeLifecyclePort([...createdResourcesForRun(run), ...createdResourcesForRun(laterRun)]),
      runtimeDirectoryCleaner: cleaner
    });

    const result = await service.reapSandboxRunsOnce({ apply: true });

    assert.match(result.errors[0] ?? "", /fencing token changed before runtime cleanup/);
    const stored = await store.sandboxRuns.get(run.runId);
    assert.equal(stored?.phase, "running");
    assert.equal(stored?.cleanupStatus, "active");
    assert.equal((await store.sandboxRuns.get(laterRun.runId))?.cleanupStatus, "cleaned");
    assert.deepEqual(cleaner.removedPaths, [
      "/workspace/workspaces/ws1/projects/proj1/tasks/task2/home",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task2/botified",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task2/inputs"
    ]);
  });

  it("does not overwrite a completion that races cleanup-complete task advancement", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ phase: "stopping", cleanupStatus: "cleanup_requested" });
    await store.createTask(taskForRun(run, "running"));
    await store.sandboxRuns.put(run);
    const cleaner: RuntimeDirectoryCleaner = {
      async removeRuntimePath() {
        const task = await store.findTask(run.taskId);
        assert.ok(task);
        await store.updateTask({ ...task, status: "completed", updatedAt: "2026-07-04T00:00:01.000Z" });
      }
    };
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: run.namespace,
      port: new FakeLifecyclePort([]),
      runtimeDirectoryCleaner: cleaner,
      now: () => new Date("2026-07-04T00:00:00.000Z")
    });

    await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    assert.equal((await store.findTask(run.taskId))?.status, "completed");
  });

  it("does not increment a terminal sync retry after another actor settles it", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun();
    await store.createTask(taskForRun(run, "running"));
    await store.sandboxRuns.put(run);
    const resources = createdResourcesForRun(run);
    const pod = resources.find((resource) => resource.kind === "Pod");
    assert.ok(pod);
    pod.status = { phase: "Failed" };
    const sandboxRuns = store.sandboxRuns;
    const updateWithFencing = sandboxRuns.updateWithFencing.bind(sandboxRuns);
    let settledByOtherActor = false;
    sandboxRuns.updateWithFencing = async (runId, token, next) => {
      if (!settledByOtherActor && next.terminalFailure?.syncStatus === "pending") {
        settledByOtherActor = true;
        const current = await sandboxRuns.get(runId);
        assert.ok(current);
        await updateWithFencing(runId, current.fencingToken, {
          ...current,
          terminalFailure: {
            ...current.terminalFailure,
            reason: current.terminalFailure?.reason ?? "pod_failed",
            syncAttempts: 1,
            syncStatus: "synced",
            lastSyncAt: "2026-07-04T00:00:01.000Z",
            lastSyncError: null
          },
          fencingToken: current.fencingToken + 1,
          updatedAt: "2026-07-04T00:00:01.000Z"
        });
        return null;
      }
      return updateWithFencing(runId, token, next);
    };
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: run.namespace,
      port: new FakeLifecyclePort(resources),
      terminalFailureSync: {
        async syncTerminalFailureRun() {
          return { status: "unavailable", message: "transport unavailable" };
        }
      },
      now: () => new Date("2026-07-04T00:00:00.000Z")
    });

    await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    const stored = await store.sandboxRuns.get(run.runId);
    assert.equal(stored?.terminalFailure?.syncStatus, "synced");
    assert.equal(stored?.terminalFailure?.syncAttempts, 1);
  });

  it("preserves newer active run fields and never revives a concurrently cleaned run during terminal-failure persistence", async () => {
    for (const variant of ["activity", "cleaned"] as const) {
      const store = createLocalInMemoryProductStore();
      const run = sandboxRun();
      await store.createTask(taskForRun(run, "running"));
      await store.sandboxRuns.put(run);
      const resources = createdResourcesForRun(run);
      const pod = resources.find((resource) => resource.kind === "Pod");
      assert.ok(pod);
      pod.status = { phase: "Failed" };
      const port = new FakeLifecyclePort(resources, {
        async onFirstList() {
          const current = await store.sandboxRuns.get(run.runId);
          assert.ok(current);
          await store.sandboxRuns.updateWithFencing(run.runId, current.fencingToken, {
            ...current,
            ...(variant === "activity"
              ? {
                  timelineCursor: "newer-cursor",
                  idleExpiresAt: "2026-07-04T00:45:00.000Z",
                  phase: "running" as const,
                  cleanupStatus: "active" as const
                }
              : {
                  phase: "cleaned" as const,
                  cleanupStatus: "cleaned" as const
                }),
            fencingToken: current.fencingToken + 1,
            updatedAt: "2026-07-04T00:00:01.000Z"
          });
        }
      });
      const service = new SandboxLifecycleService(store, {
        dataRoot: "/workspace",
        namespace: run.namespace,
        port,
        now: () => new Date("2026-07-04T00:00:00.000Z")
      });

      const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });
      const stored = await store.sandboxRuns.get(run.runId);

      assert.deepEqual(result.errors, []);
      if (variant === "activity") {
        assert.equal(stored?.timelineCursor, "newer-cursor");
        assert.equal(stored?.idleExpiresAt, "2026-07-04T00:45:00.000Z");
        assert.equal(stored?.terminalFailure?.reason, "pod_failed");
        assert.equal(stored?.terminalFailure?.syncStatus, "synced");
      } else {
        assert.equal(stored?.cleanupStatus, "cleaned");
        assert.equal(stored?.terminalFailure, undefined);
      }
    }
  });

  it("redacts terminal-failure sync callback errors before returning them", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun();
    await store.createTask(taskForRun(run, "running"));
    await store.sandboxRuns.put(run);
    const resources = createdResourcesForRun(run);
    const pod = resources.find((resource) => resource.kind === "Pod");
    assert.ok(pod);
    pod.status = { phase: "Failed" };
    const port = new FakeLifecyclePort(resources);
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: run.namespace,
      port,
      terminalFailureSync: {
        async syncTerminalFailureRun() {
          throw new Error("sync failed Bearer bsk_callback_secret MODEL_API_KEY=actual-secret API_KEY: api-secret X-Api-Key: hyphen-secret model-api-key=lower-hyphen-secret TOKEN=token-secret password='password-secret' detail=kept");
        }
      },
      now: () => new Date("2026-07-04T00:00:00.000Z")
    });

    const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    const message = result.errors[0] ?? "";
    const persisted = await store.sandboxRuns.get(run.runId);
    assert.match(message, /Bearer <redacted>/);
    assert.match(message, /MODEL_API_KEY=<redacted>/);
    assert.match(message, /API_KEY=<redacted>/);
    assert.match(message, /X-Api-Key=<redacted>/);
    assert.match(message, /model-api-key=<redacted>/);
    assert.match(message, /TOKEN=<redacted>/);
    assert.match(message, /password=<redacted>/i);
    assert.match(message, /detail=kept/);
    assert.doesNotMatch(message, /actual-secret|api-secret|hyphen-secret|lower-hyphen-secret|token-secret|password-secret|bsk_callback_secret/);
    assert.equal(persisted?.terminalFailure?.lastSyncError, message);
    assert.deepEqual(port.deletedRefs, []);
  });

  it("runs one final terminal-failure sync before deleting the Pod and retains its persisted artifact", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun();
    await store.createTask(taskForRun(run, "running"));
    await store.sandboxRuns.put(run);
    const resources = createdResourcesForRun(run);
    const pod = resources.find((resource) => resource.kind === "Pod");
    assert.ok(pod);
    pod.status = { phase: "Failed" };
    const operations: string[] = [];
    const port = new FakeLifecyclePort(resources, { operations });
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: run.namespace,
      port,
      terminalFailureSync: {
        async syncTerminalFailureRun(runId) {
          operations.push(`sync:${runId}`);
          await store.appendTaskArtifacts([{
            id: "artifact-final",
            taskId: run.taskId,
            fileId: "file-final",
            name: "final.txt",
            bytes: 5,
            createdAt: "2026-07-04T00:00:00.000Z"
          }]);
          return { status: "synced" };
        }
      },
      now: () => new Date("2026-07-04T00:00:00.000Z")
    });

    const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    assert.deepEqual(result.errors, []);
    assert.deepEqual((await store.listTaskArtifacts(run.taskId)).map((artifact) => artifact.fileId), ["file-final"]);
    assert.ok(operations.indexOf(`sync:${run.runId}`) < operations.indexOf("delete:Pod"));
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleaned");
  });

  it("does not replace a completion recorded during terminal-failure sync with failed", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun();
    await store.createTask(taskForRun(run, "running"));
    await store.sandboxRuns.put(run);
    const resources = createdResourcesForRun(run);
    const pod = resources.find((resource) => resource.kind === "Pod");
    assert.ok(pod);
    pod.status = { phase: "Failed" };
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: run.namespace,
      port: new FakeLifecyclePort(resources),
      terminalFailureSync: {
        async syncTerminalFailureRun() {
          const task = await store.findTask(run.taskId);
          assert.ok(task);
          await store.updateTask({ ...task, status: "completed", updatedAt: "2026-07-04T00:00:01.000Z" });
          return { status: "synced" };
        }
      },
      now: () => new Date("2026-07-04T00:00:00.000Z")
    });

    await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    assert.equal((await store.findTask(run.taskId))?.status, "completed");
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleaned");
  });

  it("does not replace an already terminal task when recovering a failed Pod", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun();
    await store.createTask(taskForRun(run, "completed"));
    await store.sandboxRuns.put(run);
    const resources = createdResourcesForRun(run);
    const pod = resources.find((resource) => resource.kind === "Pod");
    assert.ok(pod);
    pod.status = { phase: "Failed" };
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: run.namespace,
      port: new FakeLifecyclePort(resources),
      now: () => new Date("2026-07-04T00:00:00.000Z")
    });

    await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    assert.equal((await store.findTask(run.taskId))?.status, "completed");
  });

  it("fails a nonterminal task and cleans a full-identity failed executor Pod without touching another run", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun();
    const otherRun = sandboxRunFor("task2", "run2");
    await store.createTask(taskForRun(run, "running"));
    await store.sandboxRuns.put(run);
    const resources = createdResourcesForRun(run);
    const pod = resources.find((resource) => resource.kind === "Pod");
    assert.ok(pod);
    pod.status = {
      containerStatuses: [{
        name: "bash-executor",
        state: { terminated: { exitCode: 41 } }
      }]
    };
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const port = new FakeLifecyclePort([...resources, ...createdResourcesForRun(otherRun)]);
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: run.namespace,
      port,
      runtimeDirectoryCleaner: cleaner,
      now: () => new Date("2026-07-04T00:00:00.000Z")
    });

    const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    assert.deepEqual(result.errors, []);
    assert.equal((await store.findTask(run.taskId))?.status, "failed");
    const stored = await store.sandboxRuns.get(run.runId);
    assert.equal(stored?.cleanupStatus, "cleaned");
    assert.equal(stored?.terminalFailure?.reason, "runner_terminated");
    assert.equal(stored?.terminalFailure?.exitCode, 41);
    assert.equal(stored?.terminalFailure?.syncStatus, "synced");
    assert.deepEqual(cleaner.removedPaths, [
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/home",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/botified",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/inputs"
    ]);
    assert.equal(
      port.deletedRefs.some((ref) => Object.values(otherRun.resourceNames).includes(ref.name)),
      false
    );
  });

  it("returns persisted and observed state without exposing secrets", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.createTask(taskForRun(run, "running"));
    await store.createTask(taskForRun(sandboxRunFor("task2", "run2"), "running"));
    await store.sandboxRuns.put(run);
    const port = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)));
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port,
      now: () => new Date("2026-07-04T00:00:00.000Z")
    });

    const status = await service.getSandboxStatus();

    assert.equal(status.activeTaskCount, 2);
    assert.equal(status.runCounts.total, 1);
    assert.equal(status.runCounts.cleanupRequested, 1);
    assert.equal(status.observedResourceCounts.Pod, 1);
    assert.ok(status.actionSummary.some((action) => action.type === "delete_resource" && action.kind === "Pod"));
    assert.ok(status.cleanupPlan.targets.some((target) => target.type === "delete_resource" && target.kind === "Pod"));
    assert.ok(status.cleanupPlan.targets.some((target) => target.type === "store_run_state" && target.runId === run.runId));
    assert.deepEqual(
      status.cleanupPlan.targets
        .filter((target) => target.type === "runtime_directory")
        .map((target) => [target.directory, target.action]),
      [
        ["home", "delete"],
        ["botified", "delete"],
        ["inputs", "delete"],
        ["artifacts", "retain"]
      ]
    );
    assert.doesNotMatch(JSON.stringify(status), /bsk_|sk-real|MODEL_API_KEY/);
  });

  it("dry-runs cleanup without mutating Kubernetes or persisted run state", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const port = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)));
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port,
      runtimeDirectoryCleaner: cleaner
    });

    const result = await service.reapSandboxRunsOnce({ dryRun: true });

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.actionSummary.filter((action) => action.type === "delete_resource").map((action) => `${action.kind}:${action.name}`), [
      "Pod:asl-task-task1",
      "Service:asl-task-task1",
      "NetworkPolicy:asl-task-task1",
      "ConfigMap:asl-task-task1-config",
      "Secret:asl-botified-task1",
      "ServiceAccount:asl-task-task1"
    ]);
    assert.deepEqual(port.deletedRefs, []);
    assert.deepEqual(cleaner.removedPaths, []);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
  });

  it("applies cleanup in delete order and persists cleaned state when resources are gone", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const port = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)));
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port,
      runtimeDirectoryCleaner: cleaner
    });

    const result = await service.reapSandboxRunsOnce({ apply: true });

    assert.equal(result.dryRun, false);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(port.deletedRefs.map((ref) => `${ref.kind}:${ref.name}`), [
      "Pod:asl-task-task1",
      "Service:asl-task-task1",
      "NetworkPolicy:asl-task-task1",
      "ConfigMap:asl-task-task1-config",
      "Secret:asl-botified-task1",
      "ServiceAccount:asl-task-task1"
    ]);
    assert.deepEqual(cleaner.removedPaths, [
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/home",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/botified",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/inputs"
    ]);
    const saved = await store.sandboxRuns.get(run.runId);
    assert.equal(saved?.phase, "cleaned");
    assert.equal(saved?.cleanupStatus, "cleaned");
  });

  it("treats a delete error as applied when fresh observe no longer has the exact target", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const resources = createdResourcesForRun(asObservedActiveRun(run));
    const pod = resources.find((resource) => resource.kind === "Pod");
    assert.ok(pod);
    const port = new FakeLifecyclePort([
      ...resources,
      resourceWithMetadata(pod, { namespace: "other-namespace" })
    ], { deleteErrorAfterDelete: new Error("delete returned stale HTTP 500") });
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port,
      runtimeDirectoryCleaner: cleaner
    });

    const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(port.deletedRefs.map((ref) => `${ref.kind}:${ref.namespace}:${ref.name}`), [
      "Pod:agentsmith:asl-task-task1",
      "Service:agentsmith:asl-task-task1",
      "NetworkPolicy:agentsmith:asl-task-task1",
      "ConfigMap:agentsmith:asl-task-task1-config",
      "Secret:agentsmith:asl-botified-task1",
      "ServiceAccount:agentsmith:asl-task-task1"
    ]);
    assert.deepEqual(result.storedRunIds, [run.runId]);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleaned");
    assert.deepEqual(cleaner.removedPaths, [
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/home",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/botified",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/inputs"
    ]);
  });

  it("keeps a delete error when fresh observe sees the same target with mismatched labels or UID", async () => {
    for (const variant of ["labels", "uid"] as const) {
      const store = createLocalInMemoryProductStore();
      const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
      await store.sandboxRuns.put(run);
      const resources = createdResourcesForRun(asObservedActiveRun(run)).map(withUid);
      const pod = resources.find((resource) => resource.kind === "Pod");
      assert.ok(pod);
      const mismatchedPod = variant === "labels"
        ? resourceWithMetadata(pod, {
            labels: {
              ...pod.metadata.labels,
              "agentsmith-lite/run-id": "other-run"
            }
          })
        : resourceWithMetadata(pod, { uid: "other-pod-uid" });
      const cleaner = new FakeRuntimeDirectoryCleaner();
      const port = new FakeLifecyclePort([...resources, mismatchedPod], {
        deleteErrorAfterDelete: new Error(`delete returned stale HTTP 500 after ${variant} mismatch`)
      });
      const service = new SandboxLifecycleService(store, {
        dataRoot: "/workspace",
        namespace: "agentsmith",
        port,
        runtimeDirectoryCleaner: cleaner,
        deleteResourceErrorConfirmAttempts: 2,
        deleteResourceErrorConfirmDelayMs: 0
      });

      const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

      assert.match(result.errors[0] ?? "", new RegExp(`${variant} mismatch`));
      assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
      assert.deepEqual(cleaner.removedPaths, []);
    }
  });

  it("keeps a delete error when fresh observe still has the exact target", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const port = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)), {
      deleteError: new Error("api down")
    });
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port,
      runtimeDirectoryCleaner: cleaner,
      deleteResourceErrorConfirmAttempts: 2,
      deleteResourceErrorConfirmDelayMs: 0
    });

    const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    assert.match(result.errors[0] ?? "", /api down/);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
    assert.deepEqual(cleaner.removedPaths, []);
  });

  it("applies cleanup for live listed resources even when list items omit kind and apiVersion", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const transport = liveListTransport(createdResourcesForRun(asObservedActiveRun(run)));
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port: new SandboxKubernetesPort({ transport }),
      runtimeDirectoryCleaner: cleaner
    });

    const result = await service.reapSandboxRunsOnce({ apply: true });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.actionSummary.filter((action) => action.type === "delete_resource").map((action) => `${action.kind}:${action.name}`),
      [
        "Pod:asl-task-task1",
        "Service:asl-task-task1",
        "NetworkPolicy:asl-task-task1",
        "ConfigMap:asl-task-task1-config",
        "Secret:asl-botified-task1",
        "ServiceAccount:asl-task-task1"
      ]
    );
    assert.deepEqual(transport.requests.filter((request) => request.method === "DELETE").map((request) => request.path), [
      "/api/v1/namespaces/agentsmith/pods/asl-task-task1",
      "/api/v1/namespaces/agentsmith/services/asl-task-task1",
      "/apis/networking.k8s.io/v1/namespaces/agentsmith/networkpolicies/asl-task-task1",
      "/api/v1/namespaces/agentsmith/configmaps/asl-task-task1-config",
      "/api/v1/namespaces/agentsmith/secrets/asl-botified-task1",
      "/api/v1/namespaces/agentsmith/serviceaccounts/asl-task-task1"
    ]);
    assert.equal(result.observedResourceCounts.Pod, 0);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleaned");
  });

  it("applies live cleanup from listed resource UIDs when Service GET before delete returns HTTP 400", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const transport = liveListTransport(createdResourcesForRun(asObservedActiveRun(run)).map(withUid), {
      rejectServiceRead: true
    });
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port: new SandboxKubernetesPort({ transport }),
      runtimeDirectoryCleaner: cleaner
    });

    const result = await service.reapSandboxRunsOnce({ apply: true });

    assert.deepEqual(result.errors, []);
    assert.equal(
      transport.requests.some(
        (request) =>
          request.method === "GET" &&
          request.path === "/api/v1/namespaces/agentsmith/services/asl-task-task1"
      ),
      false
    );
    assert.deepEqual(transport.requests.filter((request) => request.method === "DELETE").map((request) => request.path), [
      "/api/v1/namespaces/agentsmith/pods/asl-task-task1",
      "/api/v1/namespaces/agentsmith/services/asl-task-task1",
      "/apis/networking.k8s.io/v1/namespaces/agentsmith/networkpolicies/asl-task-task1",
      "/api/v1/namespaces/agentsmith/configmaps/asl-task-task1-config",
      "/api/v1/namespaces/agentsmith/secrets/asl-botified-task1",
      "/api/v1/namespaces/agentsmith/serviceaccounts/asl-task-task1"
    ]);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleaned");
  });

  it("does not report a Service delete HTTP 400 when fresh observe shows the same Service terminating", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const transport = liveListTransport(createdResourcesForRun(asObservedActiveRun(run)).map(withUid), {
      rejectServiceDeleteAfterTerminating: true
    });
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port: new SandboxKubernetesPort({ transport }),
      runtimeDirectoryCleaner: cleaner
    });

    const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    assert.deepEqual(result.errors, []);
    assert.equal(result.observedResourceCounts.Service, 1);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "deleting");
    assert.deepEqual(cleaner.removedPaths, []);
  });

  it("retries Service delete HTTP 400 confirmation until a fresh observe no longer sees the target", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const resources = createdResourcesForRun(asObservedActiveRun(run)).map(withUid);
    const afterPodDeleted = resources.filter((resource) => resource.kind !== "Pod");
    const afterServiceDeleted = afterPodDeleted.filter((resource) => resource.kind !== "Service");
    const confirmAttempts = 4;
    const port = new FakeLifecyclePort(resources, {
      deleteErrorAfterDelete: (ref) =>
        ref.kind === "Service"
          ? new Error("Kubernetes delete Service/asl-task-task1 failed with HTTP 400")
          : null,
      afterDeleteErrorObserveSnapshots: [
        afterPodDeleted,
        afterPodDeleted,
        afterPodDeleted,
        afterServiceDeleted
      ]
    });
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port,
      runtimeDirectoryCleaner: cleaner,
      deleteResourceErrorConfirmAttempts: confirmAttempts,
      deleteResourceErrorConfirmDelayMs: 0
    });

    const result = await service.reapSandboxRunsOnce({ apply: true });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      port.listResults.slice(1, 1 + confirmAttempts).map((resources) => describeObservedTarget(resources, "Service", "asl-task-task1")),
      ["active", "active", "active", "missing"]
    );
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleaned");
    assert.deepEqual(cleaner.removedPaths, [
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/home",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/botified",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/inputs"
    ]);
  });

  it("uses the default delete error confirmation attempts through the 30th fresh observe", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const resources = createdResourcesForRun(asObservedActiveRun(run)).map(withUid);
    const afterPodDeleted = resources.filter((resource) => resource.kind !== "Pod");
    const defaultConfirmAttempts = 30;
    const port = new FakeLifecyclePort(resources, {
      deleteErrorAfterDelete: (ref) =>
        ref.kind === "Service"
          ? new Error("Kubernetes delete Service/asl-task-task1 failed with HTTP 400")
          : null,
      afterDeleteErrorObserveSnapshots: Array.from({ length: defaultConfirmAttempts - 1 }, () => afterPodDeleted)
    });
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port,
      runtimeDirectoryCleaner: cleaner,
      deleteResourceErrorConfirmDelayMs: 0
    });

    const result = await service.reapSandboxRunsOnce({ apply: true });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      port.listResults
        .slice(1, 1 + defaultConfirmAttempts)
        .map((resources) => describeObservedTarget(resources, "Service", "asl-task-task1")),
      [
        ...Array.from({ length: defaultConfirmAttempts - 1 }, () => "active"),
        "missing"
      ]
    );
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleaned");
    assert.deepEqual(cleaner.removedPaths, [
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/home",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/botified",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/inputs"
    ]);
  });

  it("keeps Service delete HTTP 400 when confirmation retries still see the target active", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const resources = createdResourcesForRun(asObservedActiveRun(run)).map(withUid);
    const afterPodDeleted = resources.filter((resource) => resource.kind !== "Pod");
    const confirmAttempts = 4;
    const port = new FakeLifecyclePort(resources, {
      deleteErrorAfterDelete: (ref) =>
        ref.kind === "Service"
          ? new Error("Kubernetes delete Service/asl-task-task1 failed with HTTP 400")
          : null,
      afterDeleteErrorObserveSnapshots: Array.from({ length: confirmAttempts }, () => afterPodDeleted)
    });
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port,
      runtimeDirectoryCleaner: cleaner,
      deleteResourceErrorConfirmAttempts: confirmAttempts,
      deleteResourceErrorConfirmDelayMs: 0
    });

    const result = await service.reapSandboxRunsOnce({ apply: true });

    assert.match(result.errors[0] ?? "", /Kubernetes delete Service\/asl-task-task1 failed with HTTP 400/);
    assert.deepEqual(
      port.listResults.slice(1, 1 + confirmAttempts).map((resources) => describeObservedTarget(resources, "Service", "asl-task-task1")),
      Array.from({ length: confirmAttempts }, () => "active")
    );
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
    assert.deepEqual(cleaner.removedPaths, []);
  });

  it("does not delete runtime directories or mark cleaned until Kubernetes resources are gone", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const port = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)), { keepResourcesAfterDelete: true });
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port,
      runtimeDirectoryCleaner: cleaner
    });

    const result = await service.reapSandboxRunsOnce({ apply: true });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(cleaner.removedPaths, []);
    assert.notEqual((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleaned");
  });

  it("rejects cleanup through an ancestor symlink to an external directory", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-sandbox-cleanup-"));
    const outside = await mkdtemp(path.join(tmpdir(), "asl-sandbox-cleanup-outside-"));
    try {
      const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
      const outsideHome = path.join(outside, "proj1", "tasks", run.taskId, "home");
      await mkdir(outsideHome, { recursive: true });
      await writeFile(path.join(outsideHome, "keep.txt"), "keep");
      await mkdir(path.join(dataRoot, "workspaces", run.workspaceId), { recursive: true });
      await symlink(outside, path.join(dataRoot, "workspaces", run.workspaceId, "projects"));
      const store = createLocalInMemoryProductStore();
      await store.sandboxRuns.put(run);
      const service = new SandboxLifecycleService(store, {
        dataRoot,
        namespace: run.namespace,
        port: new FakeLifecyclePort([])
      });

      const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

      assert.match(result.errors[0] ?? "", /symlink/);
      assert.equal(await readFile(path.join(outsideHome, "keep.txt"), "utf8"), "keep");
      assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects cleanup through an ancestor symlink to another in-root task", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-sandbox-cleanup-"));
    try {
      const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
      const taskRoot = path.join(dataRoot, run.projectSubPath, "tasks");
      const otherTaskHome = path.join(taskRoot, "task2", "home");
      await mkdir(otherTaskHome, { recursive: true });
      await writeFile(path.join(otherTaskHome, "keep.txt"), "keep");
      await symlink("task2", path.join(taskRoot, run.taskId));
      const store = createLocalInMemoryProductStore();
      await store.sandboxRuns.put(run);
      const service = new SandboxLifecycleService(store, {
        dataRoot,
        namespace: run.namespace,
        port: new FakeLifecyclePort([])
      });

      const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

      assert.match(result.errors[0] ?? "", /symlink/);
      assert.equal(await readFile(path.join(otherTaskHome, "keep.txt"), "utf8"), "keep");
      assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("unlinks a final runtime target symlink without deleting its target", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-sandbox-cleanup-"));
    const outside = await mkdtemp(path.join(tmpdir(), "asl-sandbox-cleanup-outside-"));
    try {
      const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
      const taskRoot = path.join(dataRoot, run.projectSubPath, "tasks", run.taskId);
      const outsideTarget = path.join(outside, "home");
      await mkdir(taskRoot, { recursive: true });
      await mkdir(outsideTarget);
      await writeFile(path.join(outsideTarget, "keep.txt"), "keep");
      await symlink(outsideTarget, path.join(taskRoot, "home"));
      const store = createLocalInMemoryProductStore();
      await store.sandboxRuns.put(run);
      const service = new SandboxLifecycleService(store, {
        dataRoot,
        namespace: run.namespace,
        port: new FakeLifecyclePort([])
      });

      const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

      await assert.rejects(() => lstat(path.join(taskRoot, "home")), { code: "ENOENT" });
      assert.equal(await readFile(path.join(outsideTarget, "keep.txt"), "utf8"), "keep");
      assert.deepEqual(result.errors, []);
      assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleaned");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("treats a missing runtime parent as successful cleanup", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-sandbox-cleanup-"));
    try {
      const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
      const store = createLocalInMemoryProductStore();
      await store.sandboxRuns.put(run);
      const service = new SandboxLifecycleService(store, {
        dataRoot,
        namespace: run.namespace,
        port: new FakeLifecyclePort([])
      });

      const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

      assert.deepEqual(result.errors, []);
      assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleaned");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("rejects runtime directory cleanup that escapes dataRoot without deleting or marking cleaned", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({
      cleanupStatus: "cleanup_requested",
      phase: "stopping",
      projectSubPath: "../escaped-project"
    });
    await store.sandboxRuns.put(run);
    const cleaner = new FakeRuntimeDirectoryCleaner();
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port: new FakeLifecyclePort([]),
      runtimeDirectoryCleaner: cleaner
    });

    const result = await service.reapSandboxRunsOnce({ apply: true });

    assert.match(result.errors[0] ?? "", /outside the data root/);
    assert.deepEqual(cleaner.removedPaths, []);
    const saved = await store.sandboxRuns.get(run.runId);
    assert.equal(saved?.cleanupStatus, "cleanup_requested");
    assert.equal(saved?.lastCleanupError?.target, "runtime_directory:home");
  });

  it("records runtime cleanup failures without marking the run cleaned", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const cleaner = new FakeRuntimeDirectoryCleaner({ failPath: "/workspace/workspaces/ws1/projects/proj1/tasks/task1/botified" });
    const service = new SandboxLifecycleService(store, {
      dataRoot: "/workspace",
      namespace: "agentsmith",
      port: new FakeLifecyclePort([]),
      runtimeDirectoryCleaner: cleaner,
      now: () => new Date("2026-07-04T00:00:01.000Z")
    });

    const result = await service.reapSandboxRunsOnce({ apply: true });

    assert.match(result.errors[0] ?? "", /remove failed/);
    assert.deepEqual(cleaner.removedPaths, [
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/home",
      "/workspace/workspaces/ws1/projects/proj1/tasks/task1/botified"
    ]);
    const saved = await store.sandboxRuns.get(run.runId);
    assert.equal(saved?.cleanupStatus, "cleanup_requested");
    assert.equal(saved?.cleanupAttempts, 1);
    assert.equal(saved?.lastCleanupAt, "2026-07-04T00:00:01.000Z");
    assert.equal(saved?.lastCleanupError?.target, "runtime_directory:botified");
    assert.match(saved?.lastCleanupError?.message ?? "", /remove failed/);
    assert.ok(result.recentCleanupFailures.some((failure) => failure.runId === run.runId));
    assert.doesNotMatch(JSON.stringify({ result, saved }), /bsk_|sk-real|MODEL_API_KEY/);
  });

  it("finalizes expiring sandbox tasks before runtime cleanup without overwriting an existing terminal status", async () => {
    const store = createLocalInMemoryProductStore();
    const runningRun = sandboxRun({
      expiresAt: "2026-07-03T23:59:59.000Z",
      idleExpiresAt: "2026-07-04T00:30:00.000Z"
    });
    const completedRun = sandboxRunFor("task2", "run2", {
      expiresAt: "2026-07-03T23:59:59.000Z",
      idleExpiresAt: "2026-07-04T00:30:00.000Z"
    });
    await store.createTask(taskForRun(runningRun, "running"));
    await store.createTask(taskForRun(completedRun, "completed"));
    await store.sandboxRuns.put(runningRun);
    await store.sandboxRuns.put(completedRun);
    const port = new FakeLifecyclePort([
      ...createdResourcesForRun(asObservedActiveRun(runningRun)),
      ...createdResourcesForRun(asObservedActiveRun(completedRun))
    ]);
    const services = createApplicationServices({ store, dataRoot: "/workspace", builtinAdminPassword: "admin-password", sandboxLifecyclePort: port });

    const result = await services.sandboxLifecycle.reapSandboxRunsOnce({ apply: true });

    assert.equal(result.dryRun, false);
    assert.deepEqual(result.errors, []);
    const expired = await store.findTask(runningRun.taskId);
    const completed = await store.findTask(completedRun.taskId);
    assert.equal(expired?.status, "expired");
    assert.equal(expired?.terminalReason, "expired");
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.terminalReason, "completed");
    assert.equal(expired?.artifactProjectionStatus, "draining");
    assert.equal(expired?.cleanupStatus, "pending");
    assert.deepEqual((await store.listProjectAuditEvents(runningRun.projectId)).map((event) => [event.resourceId, event.action]), [[runningRun.taskId, "task.expired"], [completedRun.taskId, "task.completed"]]);
  });

  it("releases an active task reservation once when cleanup is retried", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ phase: "stopping", cleanupStatus: "cleanup_requested" });
    await store.createProject({ id: run.projectId, workspaceId: run.workspaceId, name: "P", ownerUserId: "user1", rootPath: run.projectSubPath, taskConcurrencyLimit: 1, createdAt: run.createdAt, updatedAt: run.updatedAt });
    await store.createProjectResourcePolicy({ projectId: run.projectId, activeTasksLimit: 1, providerRequestsLimit: null, providerTokensLimit: null, providerCostLimit: null, projectFileBytesLimit: null, createdAt: run.createdAt, updatedAt: run.updatedAt });
    await store.upsertProjectResourceUsage({ projectId: run.projectId, activeTasks: 1, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: 0, updatedAt: run.updatedAt });
    await store.createTask(taskForRun(run, "running"));
    await store.sandboxRuns.put(run);
    const port = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)));
    const service = new SandboxLifecycleService(store, { dataRoot: "/workspace", namespace: run.namespace, port, now: () => new Date("2026-07-04T00:00:00.000Z") });

    await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });
    await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    assert.equal((await store.findTask(run.taskId))?.status, "cleaned");
    assert.equal((await store.findProjectResourceUsage(run.projectId))?.activeTasks, 0);
  });

  it("deletes full-identity orphaned resources but never recreates missing active resources", async () => {
    const store = createLocalInMemoryProductStore();
    await store.sandboxRuns.put(sandboxRun({ phase: "running", cleanupStatus: "active" }));
    const unknown = observedResource("Pod", "asl-task-unknown", {
      "agentsmith-lite/managed-by": "agentsmith-lite",
      "agentsmith-lite/workspace-id": "ws1",
      "agentsmith-lite/project-id": "proj1",
      "agentsmith-lite/task-id": "unknown",
      "agentsmith-lite/run-id": "run-unknown"
    });
    const port = new FakeLifecyclePort([unknown]);
    const service = new SandboxLifecycleService(store, {
      namespace: "agentsmith",
      port,
      now: () => new Date("2026-07-04T00:00:00.000Z")
    });

    const result = await service.reapSandboxRunsOnce({ apply: true });

    assert.deepEqual(port.appliedResources, []);
    assert.deepEqual(port.deletedRefs.map((ref) => `${ref.kind}:${ref.name}`), ["Pod:asl-task-unknown"]);
    assert.ok(result.actionSummary.some((action) => action.type === "create_resource" && action.kind === "Secret"));
    assert.ok(result.actionSummary.some((action) => action.type === "delete_resource" && action.kind === "Pod"));
  });

  it("does not patch or delete other runs when scoped to a missing run document", async () => {
    const store = createLocalInMemoryProductStore();
    const otherRun = sandboxRunFor("task2", "run2");
    await store.sandboxRuns.put(otherRun);
    const port = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(otherRun)));
    const service = new SandboxLifecycleService(store, { namespace: "agentsmith", port });

    const result = await service.reapSandboxRunsOnce({ runId: "missing", apply: true });

    assert.equal(result.dryRun, false);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.observedResourceCounts.Pod, 0);
    assert.deepEqual(result.actionSummary, []);
    assert.deepEqual(port.deletedRefs, []);
    assert.equal((await store.sandboxRuns.get(otherRun.runId))?.cleanupStatus, "active");
  });

  it("scopes observed resources by run id for status and reap planning", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    const otherRun = sandboxRunFor("task2", "run2");
    await store.sandboxRuns.put(run);
    await store.sandboxRuns.put(otherRun);
    const unknown = observedResource("Pod", "asl-task-unknown", {
      "agentsmith-lite/managed-by": "agentsmith-lite",
      "agentsmith-lite/workspace-id": "ws1",
      "agentsmith-lite/project-id": "proj1",
      "agentsmith-lite/task-id": "unknown",
      "agentsmith-lite/run-id": "run-unknown"
    });
    const port = new FakeLifecyclePort([
      ...createdResourcesForRun(asObservedActiveRun(run)),
      ...createdResourcesForRun(asObservedActiveRun(otherRun)),
      unknown
    ]);
    const service = new SandboxLifecycleService(store, { dataRoot: "/workspace", namespace: "agentsmith", port });

    const status = await service.getSandboxStatus({ runId: run.runId });
    assert.equal(status.observedResourceCounts.Pod, 1);
    assert.deepEqual(
      status.actionSummary.filter((action) => action.type === "delete_resource").map((action) => `${action.kind}:${action.name}`),
      [
        "Pod:asl-task-task1",
        "Service:asl-task-task1",
        "NetworkPolicy:asl-task-task1",
        "ConfigMap:asl-task-task1-config",
        "Secret:asl-botified-task1",
        "ServiceAccount:asl-task-task1"
      ]
    );

    const result = await service.reapSandboxRunsOnce({ runId: run.runId, apply: true });

    assert.deepEqual(port.deletedRefs.map((ref) => `${ref.kind}:${ref.name}`), [
      "Pod:asl-task-task1",
      "Service:asl-task-task1",
      "NetworkPolicy:asl-task-task1",
      "ConfigMap:asl-task-task1-config",
      "Secret:asl-botified-task1",
      "ServiceAccount:asl-task-task1"
    ]);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleaned");
    assert.equal((await store.sandboxRuns.get(otherRun.runId))?.cleanupStatus, "active");
  });

  it("keeps persisted state unchanged on fence mismatch or Kubernetes errors", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const fencePort = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)), { deleteResult: "fence_mismatch" });
    const fenceService = new SandboxLifecycleService(store, { namespace: "agentsmith", port: fencePort });

    const fenceResult = await fenceService.reapSandboxRunsOnce({ apply: true });

    assert.equal(fenceResult.errors.length, 1);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");

    const throwingPort = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)), { deleteError: new Error("api down") });
    const throwingService = new SandboxLifecycleService(store, {
      namespace: "agentsmith",
      port: throwingPort,
      deleteResourceErrorConfirmAttempts: 2,
      deleteResourceErrorConfirmDelayMs: 0
    });
    const throwingResult = await throwingService.reapSandboxRunsOnce({ apply: true });

    assert.match(throwingResult.errors[0] ?? "", /api down/);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
  });
});

class FakeLifecyclePort implements SandboxKubernetesMutationPort {
  readonly appliedResources: KubernetesResource[] = [];
  readonly deletedRefs: KubernetesResourceRef[] = [];
  readonly listResults: KubernetesResource[][] = [];
  private resources: KubernetesResource[];
  private pendingObserveSnapshots: KubernetesResource[][] = [];
  private didRunFirstListHook = false;

  constructor(
    resources: KubernetesResource[],
    private readonly options: {
      deleteResult?: "deleted" | "not_found" | "fence_mismatch";
      deleteError?: Error;
      deleteErrorAfterDelete?: Error | ((ref: KubernetesResourceRef) => Error | null);
      afterDeleteErrorObserveSnapshots?: KubernetesResource[][];
      keepResourcesAfterDelete?: boolean;
      operations?: string[];
      onFirstList?: () => Promise<void>;
    } = {}
  ) {
    this.resources = resources.map((resource) => structuredClone(resource));
  }

  async listManagedResources(): Promise<KubernetesResource[]> {
    if (!this.didRunFirstListHook) {
      this.didRunFirstListHook = true;
      await this.options.onFirstList?.();
    }
    const resources = this.pendingObserveSnapshots.shift() ?? this.resources;
    const result = resources.map((resource) => structuredClone(resource));
    this.listResults.push(result);
    return result;
  }

  async applyResource(resource: KubernetesResource): Promise<"applied" | "fence_mismatch"> {
    this.appliedResources.push(structuredClone(resource));
    return "applied";
  }

  async deleteResource(
    ref: KubernetesResourceRef,
    expectedLabels: Record<string, string>
  ): Promise<"deleted" | "not_found" | "fence_mismatch"> {
    this.deletedRefs.push(structuredClone(ref));
    this.options.operations?.push(`delete:${ref.kind}`);
    const deleteErrorAfterDelete = resolveDeleteErrorAfterDelete(this.options.deleteErrorAfterDelete, ref);
    if (deleteErrorAfterDelete) {
      this.resources = this.resources.filter((resource) => !sameRef(resource, ref) || !hasLabels(resource, expectedLabels) || !hasRefUid(resource, ref));
      this.pendingObserveSnapshots = (this.options.afterDeleteErrorObserveSnapshots ?? [])
        .map((resources) => resources.map((resource) => structuredClone(resource)));
      throw deleteErrorAfterDelete;
    }
    if (this.options.deleteError) {
      throw this.options.deleteError;
    }
    if (this.options.deleteResult) {
      return this.options.deleteResult;
    }
    if (this.options.keepResourcesAfterDelete) {
      return "deleted";
    }
    const before = this.resources.length;
    this.resources = this.resources.filter((resource) => !sameRef(resource, ref) || !hasLabels(resource, expectedLabels) || !hasRefUid(resource, ref));
    return this.resources.length === before ? "not_found" : "deleted";
  }
}

class FakeRuntimeDirectoryCleaner {
  readonly removedPaths: string[] = [];

  constructor(private readonly options: { failPath?: string } = {}) {}

  async removeRuntimePath(absolutePath: string): Promise<void> {
    this.removedPaths.push(absolutePath);
    if (absolutePath === this.options.failPath) {
      throw new Error("remove failed for bsk_runtime_secret sk-real MODEL_API_KEY");
    }
  }
}

function sandboxRun(overrides: Partial<SandboxRunState> = {}): SandboxRunState {
  return {
    workspaceId: "ws1",
    projectId: "proj1",
    taskId: "task1",
    runId: "run1",
    namespace: "agentsmith",
    phase: "running",
    image: "agentsmith-lite/botified-runner:test",
    pvcName: "agentsmith-lite-files",
    projectSubPath: "workspaces/ws1/projects/proj1",
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
      taskHome: "/workspace/project/tasks/task1/home",
      artifacts: "/workspace/project/tasks/task1/artifacts",
      botified: "/workspace/project/tasks/task1/botified"
    },
    resourceLimits: {
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    },
    expiresAt: "2026-07-04T01:00:00.000Z",
    idleExpiresAt: "2026-07-04T00:30:00.000Z",
    fencingToken: 1,
    cleanupStatus: "active",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides
  };
}

function sandboxRunFor(taskId: string, runId: string, overrides: Partial<SandboxRunState> = {}): SandboxRunState {
  return sandboxRun({
    taskId,
    runId,
    resourceNames: {
      pod: `asl-task-${taskId}`,
      service: `asl-task-${taskId}`,
      configMap: `asl-task-${taskId}-config`,
      secret: `asl-botified-${taskId}`,
      serviceAccount: `asl-task-${taskId}`,
      networkPolicy: `asl-task-${taskId}`
    },
    serviceKeySecretRef: {
      name: `asl-botified-${taskId}`,
      key: "BOTIFIED_SERVICE_KEY"
    },
    directories: {
      taskHome: `/workspace/project/tasks/${taskId}/home`,
      artifacts: `/workspace/project/tasks/${taskId}/artifacts`,
      botified: `/workspace/project/tasks/${taskId}/botified`
    },
    ...overrides
  });
}

function taskForRun(run: SandboxRunState, status: "running" | "completed") {
  return {
    id: run.taskId,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    endpointId: `endpoint-${run.taskId}`,
    prompt: "build",
    status,
    runId: run.runId,
    executionMode: "live" as const,
    sandbox: {
      namespace: run.namespace,
      resources: []
    },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

function createdResourcesForRun(run: SandboxRunState): KubernetesResource[] {
  return applySandboxReconcileActions({
    observedResources: [],
    actions: reconcileSandboxRuns({
      namespace: run.namespace,
      desiredRuns: [run],
      observedResources: [],
      now: new Date("2026-07-04T00:00:00.000Z")
    }).actions
  }).observedResources;
}

function asObservedActiveRun(run: SandboxRunState): SandboxRunState {
  return {
    ...run,
    phase: "running",
    cleanupStatus: "active"
  };
}

function observedResource(kind: string, name: string, labels: Record<string, string>): KubernetesResource {
  return {
    apiVersion: kind === "NetworkPolicy" ? "networking.k8s.io/v1" : "v1",
    kind,
    metadata: {
      name,
      namespace: "agentsmith",
      labels
    }
  };
}

function liveListTransport(
  initialResources: KubernetesResource[],
  options: { rejectServiceRead?: boolean; rejectServiceDeleteAfterTerminating?: boolean } = {}
): KubernetesTransport & { requests: KubernetesTransportRequest[] } {
  const requests: KubernetesTransportRequest[] = [];
  let resources = initialResources.map((resource) => structuredClone(resource));
  return {
    requests,
    async request(request: KubernetesTransportRequest): Promise<KubernetesTransportResponse> {
      requests.push(request);
      const plural = resourcePluralFromPath(request.path);
      if (request.method === "GET" && request.path.includes("?labelSelector=")) {
        return {
          statusCode: 200,
          body: {
            items: resources
              .filter((resource) => resourcePlural(resource.kind) === plural)
              .map((resource) => resourceListItemWithoutTypeMeta(resource))
          }
        };
      }
      if (request.method === "GET") {
        if (options.rejectServiceRead && resourcePluralFromPath(request.path) === "services") {
          return { statusCode: 400, body: { kind: "Status", message: "service get rejected" } };
        }
        const resource = resources.find((candidate) => resourcePathMatches(candidate, request.path));
        return resource
          ? { statusCode: 200, body: withUid(resource) }
          : { statusCode: 404 };
      }
      if (request.method === "DELETE") {
        if (options.rejectServiceDeleteAfterTerminating && resourcePluralFromPath(request.path) === "services") {
          resources = resources.map((resource) => {
            if (!resourcePathMatches(resource, request.path)) {
              return resource;
            }
            return resourceWithMetadata(resource, { deletionTimestamp: "2026-07-04T00:00:01.000Z" });
          });
          return { statusCode: 400, body: { kind: "Status", message: "service delete rejected while terminating" } };
        }
        const before = resources.length;
        resources = resources.filter((resource) => !resourcePathMatches(resource, request.path));
        return { statusCode: resources.length === before ? 404 : 200 };
      }
      return { statusCode: 200 };
    }
  };
}

function resourceListItemWithoutTypeMeta(resource: KubernetesResource): Record<string, unknown> {
  const item = structuredClone(resource) as Record<string, unknown>;
  delete item.apiVersion;
  delete item.kind;
  return item;
}

function withUid(resource: KubernetesResource): KubernetesResource {
  return {
    ...structuredClone(resource),
    metadata: {
      ...resource.metadata,
      uid: `${resource.kind}-${resource.metadata.name}-uid`
    }
  };
}

function resourceWithMetadata(
  resource: KubernetesResource,
  metadata: { namespace?: string; labels?: Record<string, string>; deletionTimestamp?: string; uid?: string }
): KubernetesResource {
  const clone = structuredClone(resource);
  return {
    ...clone,
    metadata: {
      ...clone.metadata,
      ...(metadata.namespace ? { namespace: metadata.namespace } : {}),
      ...(metadata.deletionTimestamp ? { deletionTimestamp: metadata.deletionTimestamp } : {}),
      ...(metadata.uid ? { uid: metadata.uid } : {}),
      labels: metadata.labels ? { ...metadata.labels } : { ...clone.metadata.labels }
    }
  };
}

function describeObservedTarget(resources: KubernetesResource[], kind: string, name: string): "missing" | "active" | "terminating" {
  const resource = resources.find((candidate) => candidate.kind === kind && candidate.metadata.name === name);
  if (!resource) {
    return "missing";
  }
  return typeof resource.metadata.deletionTimestamp === "string" ? "terminating" : "active";
}

function resourcePathMatches(resource: KubernetesResource, path: string): boolean {
  const basePath = path.split("?")[0] ?? path;
  return resourcePlural(resource.kind) === resourcePluralFromPath(basePath) && resource.metadata.name === resourceNameFromPath(basePath);
}

function resourcePlural(kind: string): string {
  switch (kind) {
    case "Secret":
      return "secrets";
    case "ConfigMap":
      return "configmaps";
    case "ServiceAccount":
      return "serviceaccounts";
    case "NetworkPolicy":
      return "networkpolicies";
    case "Service":
      return "services";
    case "Pod":
      return "pods";
    default:
      throw new Error(`Unsupported test resource kind: ${kind}`);
  }
}

function resourcePluralFromPath(path: string): string {
  const basePath = path.split("?")[0] ?? path;
  const parts = basePath.split("/");
  const last = parts.at(-1) ?? "";
  return resourcePlurals.includes(last) ? last : parts.at(-2) ?? "";
}

function resourceNameFromPath(path: string): string {
  return decodeURIComponent(path.split("?")[0]?.split("/").at(-1) ?? "");
}

const resourcePlurals = ["secrets", "configmaps", "serviceaccounts", "networkpolicies", "services", "pods"];

function sameRef(resource: KubernetesResource, ref: KubernetesResourceRef): boolean {
  return resource.kind === ref.kind && resource.metadata.namespace === ref.namespace && resource.metadata.name === ref.name;
}

function hasLabels(resource: KubernetesResource, labels: Record<string, string>): boolean {
  return Object.entries(labels).every(([key, value]) => resource.metadata.labels[key] === value);
}

function hasRefUid(resource: KubernetesResource, ref: KubernetesResourceRef): boolean {
  return !ref.uid || resource.metadata.uid === ref.uid;
}

function resolveDeleteErrorAfterDelete(
  option: Error | ((ref: KubernetesResourceRef) => Error | null) | undefined,
  ref: KubernetesResourceRef
): Error | null {
  if (!option) {
    return null;
  }
  return typeof option === "function" ? option(ref) : option;
}
