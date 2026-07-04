import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { SandboxLifecycleService } from "../../packages/application/src/sandboxLifecycleService.js";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import type {
  KubernetesResourceRef,
  SandboxKubernetesMutationPort
} from "../../packages/sandbox-controller/src/kubernetesPort.js";
import {
  applySandboxReconcileActions,
  reconcileSandboxRuns,
  type SandboxRunState
} from "../../packages/sandbox-controller/src/reconciler.js";
import { renderSandboxResources } from "../../packages/sandbox-controller/src/manifestRenderer.js";

describe("sandbox lifecycle service", () => {
  it("reports persisted and observed state without exposing secrets", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const port = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)));
    const service = new SandboxLifecycleService(store, {
      namespace: "agentsmith",
      port,
      now: () => new Date("2026-07-04T00:00:00.000Z")
    });

    const status = await service.getSandboxStatus();

    assert.equal(status.runCounts.total, 1);
    assert.equal(status.runCounts.cleanupRequested, 1);
    assert.equal(status.observedResourceCounts.Pod, 1);
    assert.ok(status.actionSummary.some((action) => action.type === "delete_resource" && action.kind === "Pod"));
    assert.doesNotMatch(JSON.stringify(status), /bsk_|sk-real|MODEL_API_KEY/);
  });

  it("dry-runs cleanup without mutating Kubernetes or persisted run state", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const port = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)));
    const service = new SandboxLifecycleService(store, { namespace: "agentsmith", port });

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
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
  });

  it("applies cleanup in delete order and persists cleaned state when resources are gone", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({ cleanupStatus: "cleanup_requested", phase: "stopping" });
    await store.sandboxRuns.put(run);
    const port = new FakeLifecyclePort(createdResourcesForRun(asObservedActiveRun(run)));
    const service = new SandboxLifecycleService(store, { namespace: "agentsmith", port });

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
    const saved = await store.sandboxRuns.get(run.runId);
    assert.equal(saved?.phase, "cleaned");
    assert.equal(saved?.cleanupStatus, "cleaned");
  });

  it("marks unknown managed resources for cleanup but never recreates missing active resources", async () => {
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
    assert.deepEqual(port.patchedRefs.map((ref) => `${ref.kind}:${ref.name}`), ["Pod:asl-task-unknown"]);
    assert.ok(result.actionSummary.some((action) => action.type === "create_resource" && action.kind === "Secret"));
    assert.ok(result.actionSummary.some((action) => action.type === "mark_cleanup" && action.kind === "Pod"));
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
    assert.deepEqual(port.patchedRefs, []);
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
    const service = new SandboxLifecycleService(store, { namespace: "agentsmith", port });

    const status = await service.getSandboxStatus({ runId: run.runId });
    assert.equal(status.observedResourceCounts.Pod, 1);
    assert.deepEqual(status.actionSummary.filter((action) => action.type === "mark_cleanup"), []);
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
    assert.deepEqual(port.patchedRefs, []);
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
    const throwingService = new SandboxLifecycleService(store, { namespace: "agentsmith", port: throwingPort });
    const throwingResult = await throwingService.reapSandboxRunsOnce({ apply: true });

    assert.match(throwingResult.errors[0] ?? "", /api down/);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
  });
});

class FakeLifecyclePort implements SandboxKubernetesMutationPort {
  readonly appliedResources: KubernetesResource[] = [];
  readonly deletedRefs: KubernetesResourceRef[] = [];
  readonly patchedRefs: KubernetesResourceRef[] = [];
  private resources: KubernetesResource[];

  constructor(
    resources: KubernetesResource[],
    private readonly options: {
      deleteResult?: "deleted" | "not_found" | "fence_mismatch";
      deleteError?: Error;
    } = {}
  ) {
    this.resources = resources.map((resource) => structuredClone(resource));
  }

  async listManagedResources(): Promise<KubernetesResource[]> {
    return this.resources.map((resource) => structuredClone(resource));
  }

  async applyResource(resource: KubernetesResource): Promise<"applied" | "fence_mismatch"> {
    this.appliedResources.push(structuredClone(resource));
    return "applied";
  }

  async patchLabels(
    ref: KubernetesResourceRef,
    _expectedLabels: Record<string, string>,
    labels: Record<string, string>
  ): Promise<"patched" | "not_found" | "fence_mismatch"> {
    this.patchedRefs.push(structuredClone(ref));
    const resource = this.resources.find((candidate) => sameRef(candidate, ref));
    if (!resource) {
      return "not_found";
    }
    Object.assign(resource.metadata.labels, labels);
    return "patched";
  }

  async deleteResource(ref: KubernetesResourceRef): Promise<"deleted" | "not_found" | "fence_mismatch"> {
    this.deletedRefs.push(structuredClone(ref));
    if (this.options.deleteError) {
      throw this.options.deleteError;
    }
    if (this.options.deleteResult) {
      return this.options.deleteResult;
    }
    const before = this.resources.length;
    this.resources = this.resources.filter((resource) => !sameRef(resource, ref));
    return this.resources.length === before ? "not_found" : "deleted";
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

function createdResourcesForRun(run: SandboxRunState): KubernetesResource[] {
  return applySandboxReconcileActions({
    observedResources: [],
    actions: reconcileSandboxRuns({
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

function sameRef(resource: KubernetesResource, ref: KubernetesResourceRef): boolean {
  return resource.kind === ref.kind && resource.metadata.namespace === ref.namespace && resource.metadata.name === ref.name;
}
