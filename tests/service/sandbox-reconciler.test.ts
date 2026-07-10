import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import {
  applySandboxReconcileActions,
  reconcileSandboxRuns,
  sandboxIdentityLabels,
  type SandboxReconcileAction,
  type SandboxRunState
} from "../../packages/sandbox-controller/src/reconciler.js";
import { renderSandboxResources } from "../../packages/sandbox-controller/src/manifestRenderer.js";
import { sandboxResourceNamesForTask } from "../../packages/sandbox-controller/src/resourceNames.js";

describe("sandbox reconciler", () => {
  it("creates missing run resources, then adopts matching managed resources idempotently", () => {
    const run = sandboxRun();
    const first = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [run],
      observedResources: [],
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    assert.deepEqual(first.actions.map(actionSummary), [
      "create_resource:Secret:asl-botified-t1",
      "create_resource:ConfigMap:asl-task-t1-config",
      "create_resource:ServiceAccount:asl-task-t1",
      "create_resource:NetworkPolicy:asl-task-t1",
      "create_resource:Service:asl-task-t1",
      "create_resource:Pod:asl-task-t1",
      "store_run_state:run1:running:desired_observed"
    ]);

    for (const action of first.actions) {
      if (action.type !== "create_resource") {
        continue;
      }
      assert.deepEqual(pickSandboxLabels(action.resource), sandboxIdentityLabels(run));
    }

    const applied = applySandboxReconcileActions({
      observedResources: [],
      actions: first.actions
    });
    const second = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [run],
      observedResources: applied.observedResources,
      now: new Date("2026-07-04T00:00:01.000Z")
    });

    assert.deepEqual(second.actions.map(actionSummary), [
      "adopt_resource:Secret:asl-botified-t1",
      "adopt_resource:ConfigMap:asl-task-t1-config",
      "adopt_resource:ServiceAccount:asl-task-t1",
      "adopt_resource:NetworkPolicy:asl-task-t1",
      "adopt_resource:Service:asl-task-t1",
      "adopt_resource:Pod:asl-task-t1",
      "store_run_state:run1:running:desired_observed"
    ]);
  });

  it("uses DNS-safe fallback names for legacy persisted task resources", () => {
    const taskId = "task_2323854661afae8194cd";
    const runId = "run_2323854661afae8194cd";
    const names = sandboxResourceNamesForTask(taskId);
    const run = sandboxRun({
      taskId,
      runId,
      resourceNames: {
        pod: names.pod,
        service: names.service,
        configMap: names.configMap,
        secret: names.secret
      },
      serviceKeySecretRef: {
        name: names.secret,
        key: "BOTIFIED_SERVICE_KEY"
      },
      directories: {
        taskHome: `/workspace/project/tasks/${taskId}/home`,
        artifacts: `/workspace/project/tasks/${taskId}/artifacts`,
        botified: `/workspace/project/tasks/${taskId}/botified`
      }
    });

    const first = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [run],
      observedResources: [],
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    assert.deepEqual(first.actions.map(actionSummary), [
      `create_resource:Secret:${names.secret}`,
      `create_resource:ConfigMap:${names.configMap}`,
      `create_resource:ServiceAccount:${names.serviceAccount}`,
      `create_resource:NetworkPolicy:${names.networkPolicy}`,
      `create_resource:Service:${names.service}`,
      `create_resource:Pod:${names.pod}`,
      "store_run_state:run_2323854661afae8194cd:running:desired_observed"
    ]);
    for (const action of first.actions) {
      if (action.type !== "create_resource") {
        continue;
      }
      assert.doesNotMatch(action.name, /_/);
      assert.deepEqual(pickSandboxLabels(action.resource), sandboxIdentityLabels(run));
    }
    const createdPod = first.actions.find((action) => action.type === "create_resource" && action.kind === "Pod");
    assert.equal(createdPod?.type, "create_resource");
    assert.equal((createdPod.resource.spec as { serviceAccountName?: string }).serviceAccountName, names.serviceAccount);

    const applied = applySandboxReconcileActions({
      observedResources: [],
      actions: first.actions
    });
    const second = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [run],
      observedResources: applied.observedResources,
      now: new Date("2026-07-04T00:00:01.000Z")
    });
    assert.deepEqual(second.actions.map(actionSummary), [
      `adopt_resource:Secret:${names.secret}`,
      `adopt_resource:ConfigMap:${names.configMap}`,
      `adopt_resource:ServiceAccount:${names.serviceAccount}`,
      `adopt_resource:NetworkPolicy:${names.networkPolicy}`,
      `adopt_resource:Service:${names.service}`,
      `adopt_resource:Pod:${names.pod}`,
      "store_run_state:run_2323854661afae8194cd:running:desired_observed"
    ]);

    const cleanupRun = sandboxRun({
      ...run,
      phase: "stopping",
      cleanupStatus: "cleanup_requested"
    });
    const cleanupPlan = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [cleanupRun],
      observedResources: applied.observedResources,
      now: new Date("2026-07-04T00:00:02.000Z")
    });
    const deletes = cleanupPlan.actions.filter(isDeleteAction);
    assert.deepEqual(deletes.map((action) => `${action.kind}:${action.name}`), [
      `Pod:${names.pod}`,
      `Service:${names.service}`,
      `NetworkPolicy:${names.networkPolicy}`,
      `ConfigMap:${names.configMap}`,
      `Secret:${names.secret}`,
      `ServiceAccount:${names.serviceAccount}`
    ]);
    for (const action of deletes) {
      assert.doesNotMatch(action.name, /_/);
      assert.deepEqual(action.labels, sandboxIdentityLabels(run));
    }

    const cleaned = applySandboxReconcileActions({
      observedResources: applied.observedResources,
      actions: cleanupPlan.actions
    });
    assert.equal(cleaned.observedResources.length, 0);
  });

  it("deletes full-identity orphaned resources with label fencing and leaves partial or unowned resources alone", () => {
    const run = sandboxRun();
    const desiredNetworkPolicy = renderedResource(run, "NetworkPolicy");
    const unknownServiceAccount = observedResource("ServiceAccount", "asl-task-old", {
      "agentsmith-lite/managed-by": "agentsmith-lite",
      "agentsmith-lite/workspace-id": "w1",
      "agentsmith-lite/project-id": "p1",
      "agentsmith-lite/task-id": "old",
      "agentsmith-lite/run-id": "old-run"
    });
    const unknownNetworkPolicy = observedResource("NetworkPolicy", "asl-task-old", {
      "agentsmith-lite/managed-by": "agentsmith-lite",
      "agentsmith-lite/workspace-id": "w1",
      "agentsmith-lite/project-id": "p1",
      "agentsmith-lite/task-id": "old",
      "agentsmith-lite/run-id": "old-run"
    });
    const orphan = observedResource("Pod", "asl-task-orphan", {
      "agentsmith-lite/managed-by": "agentsmith-lite",
      "agentsmith-lite/workspace-id": "w1",
      "agentsmith-lite/project-id": "p1",
      "agentsmith-lite/task-id": "orphan",
      "agentsmith-lite/run-id": "orphan-run"
    });
    const crossNamespaceOrphan = observedResource("Service", "asl-task-cross-namespace", {
      "agentsmith-lite/managed-by": "agentsmith-lite",
      "agentsmith-lite/workspace-id": "w1",
      "agentsmith-lite/project-id": "p1",
      "agentsmith-lite/task-id": "cross-namespace",
      "agentsmith-lite/run-id": "cross-namespace-run"
    });
    crossNamespaceOrphan.metadata.namespace = "other-namespace";
    const partialIdentity = observedResource("Pod", "partial-identity", {
      "agentsmith-lite/managed-by": "agentsmith-lite",
      "agentsmith-lite/workspace-id": "w1"
    });
    const unowned = observedResource("Pod", "not-ours", {
      "app.kubernetes.io/name": "someone-else"
    });

    const plan = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [run],
      observedResources: [desiredNetworkPolicy, unknownServiceAccount, unknownNetworkPolicy, orphan, crossNamespaceOrphan, partialIdentity, unowned],
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    const deletes = plan.actions.filter(isDeleteAction);
    assert.deepEqual(deletes.map(actionSummary), [
      "delete_resource:Pod:asl-task-orphan",
      "delete_resource:NetworkPolicy:asl-task-old",
      "delete_resource:ServiceAccount:asl-task-old"
    ]);
    for (const action of deletes) {
      assert.deepEqual(action.labels, pickSandboxLabels(action.resource));
    }

    const applied = applySandboxReconcileActions({
      observedResources: [desiredNetworkPolicy, unknownServiceAccount, unknownNetworkPolicy, orphan, crossNamespaceOrphan, partialIdentity, unowned],
      actions: plan.actions
    });
    const preserved = applied.observedResources.find((resource) => resource.kind === "NetworkPolicy");
    const retainedPartialIdentity = applied.observedResources.find((resource) => resource.metadata.name === "partial-identity");
    const retainedCrossNamespace = applied.observedResources.find((resource) => resource.metadata.name === "asl-task-cross-namespace");
    const ignored = applied.observedResources.find((resource) => resource.metadata.name === "not-ours");
    assert.ok(preserved, "desired NetworkPolicy should not be treated as unknown");
    assert.ok(retainedPartialIdentity, "partial identity resource should be retained");
    assert.ok(retainedCrossNamespace, "out-of-scope resource should be retained");
    assert.ok(ignored, "unowned resource should be retained");
  });

  it("deletes zero-desired-run full-identity orphans in delete order within the observation namespace", () => {
    const labels = {
      "agentsmith-lite/managed-by": "agentsmith-lite",
      "agentsmith-lite/workspace-id": "w1",
      "agentsmith-lite/project-id": "p1",
      "agentsmith-lite/task-id": "orphan",
      "agentsmith-lite/run-id": "orphan-run"
    };
    const crossNamespaceService = observedResource("Service", "cross-namespace", labels);
    crossNamespaceService.metadata.namespace = "other-namespace";

    const plan = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [],
      observedResources: [
        observedResource("ServiceAccount", "service-account", labels),
        observedResource("Secret", "secret", labels),
        observedResource("Pod", "pod", labels),
        crossNamespaceService,
        observedResource("ConfigMap", "config-map", labels),
        observedResource("NetworkPolicy", "network-policy", labels),
        observedResource("Service", "service", labels)
      ],
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    assert.deepEqual(plan.actions.filter(isDeleteAction).map((action) => `${action.kind}:${action.name}`), [
      "Pod:pod",
      "Service:service",
      "NetworkPolicy:network-policy",
      "ConfigMap:config-map",
      "Secret:secret",
      "ServiceAccount:service-account"
    ]);
  });

  it("does not adopt or delete resources whose identity labels are partial", () => {
    const run = sandboxRun();
    const mismatchedPod = renderedResource(run, "Pod");
    delete mismatchedPod.metadata.labels["agentsmith-lite/run-id"];

    const activePlan = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [run],
      observedResources: [mismatchedPod],
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    assert.equal(
      activePlan.actions.some((action) => action.type === "adopt_resource" && action.kind === "Pod"),
      false
    );
    assert.ok(
      activePlan.actions.some((action) => action.type === "create_resource" && action.kind === "Pod"),
      "label mismatch should create the expected fenced Pod instead of adopting"
    );

    const stopping = sandboxRun({ phase: "stopping", cleanupStatus: "cleanup_requested" });
    const cleanupPlan = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [stopping],
      observedResources: [mismatchedPod],
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    assert.equal(
      cleanupPlan.actions.some((action) => action.type === "delete_resource" && action.kind === "Pod"),
      false
    );
  });

  it("deletes stopping resources in pod-service-networkpolicy-configmap-secret-serviceaccount order with label fencing", () => {
    const activeRun = sandboxRun();
    const run = sandboxRun({
      phase: "stopping",
      cleanupStatus: "cleanup_requested",
      expiresAt: "2026-07-04T00:10:00.000Z"
    });
    const created = createdResourcesForRun(activeRun);

    const plan = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [run],
      observedResources: created,
      now: new Date("2026-07-04T00:00:05.000Z")
    });

    const deletes = plan.actions.filter(isDeleteAction);
    assert.deepEqual(deletes.map((action) => `${action.kind}:${action.name}`), [
      "Pod:asl-task-t1",
      "Service:asl-task-t1",
      "NetworkPolicy:asl-task-t1",
      "ConfigMap:asl-task-t1-config",
      "Secret:asl-botified-t1",
      "ServiceAccount:asl-task-t1"
    ]);
    for (const action of deletes) {
      assert.deepEqual(action.labels, sandboxIdentityLabels(run));
    }

    const fenced = applySandboxReconcileActions({
      observedResources: created,
      actions: deletes.map((action) => ({
        ...action,
        labels: { ...action.labels, "agentsmith-lite/run-id": "wrong-run" }
      }))
    });
    assert.equal(fenced.observedResources.length, created.length);

    const applied = applySandboxReconcileActions({
      observedResources: created,
      actions: plan.actions
    });
    assert.equal(applied.observedResources.length, 0);

    const afterDelete = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [run],
      observedResources: applied.observedResources,
      now: new Date("2026-07-04T00:00:06.000Z")
    });
    assert.deepEqual(afterDelete.actions.map(actionSummary), ["store_run_state:run1:cleaned:cleanup_complete"]);
  });

  it("moves expired and idle-expired runs into cleanup", () => {
    const created = createdResourcesForRun(sandboxRun());
    const expired = sandboxRun({
      expiresAt: "2026-07-03T23:59:59.000Z",
      idleExpiresAt: "2026-07-04T00:30:00.000Z"
    });
    const run2 = sandboxRun({
      runId: "run2",
      taskId: "t2",
      resourceNames: {
        pod: "asl-task-t2",
        service: "asl-task-t2",
        configMap: "asl-task-t2-config",
        secret: "asl-botified-t2"
      },
      serviceKeySecretRef: {
        name: "asl-botified-t2",
        key: "BOTIFIED_SERVICE_KEY"
      },
      expiresAt: "2026-07-04T00:30:00.000Z",
      idleExpiresAt: "2026-07-04T00:30:00.000Z"
    });
    const idleExpired = sandboxRun({
      ...run2,
      idleExpiresAt: "2026-07-03T23:59:59.000Z"
    });
    const idleCreated = createdResourcesForRun(run2);

    const expiredPlan = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [expired],
      observedResources: created,
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    assert.deepEqual(expiredPlan.actions.filter(isDeleteAction).map((action) => `${action.kind}:${action.name}`), [
      "Pod:asl-task-t1",
      "Service:asl-task-t1",
      "NetworkPolicy:asl-task-t1",
      "ConfigMap:asl-task-t1-config",
      "Secret:asl-botified-t1",
      "ServiceAccount:asl-task-t1"
    ]);
    assert.deepEqual(expiredPlan.actions.map(actionSummary), [
      "delete_resource:Pod:asl-task-t1",
      "delete_resource:Service:asl-task-t1",
      "delete_resource:NetworkPolicy:asl-task-t1",
      "delete_resource:ConfigMap:asl-task-t1-config",
      "delete_resource:Secret:asl-botified-t1",
      "delete_resource:ServiceAccount:asl-task-t1",
      "store_run_state:run1:expired:cleanup_in_progress"
    ]);
    const expiredStore = expiredPlan.actions.find(isStoreAction);
    assert.equal(expiredStore?.run.phase, "expired");
    assert.equal(expiredStore?.run.cleanupStatus, "deleting");

    const idlePlan = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [idleExpired],
      observedResources: idleCreated,
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    assert.deepEqual(idlePlan.actions.filter(isDeleteAction).map((action) => `${action.kind}:${action.name}`), [
      "Pod:asl-task-t2",
      "Service:asl-task-t2",
      "NetworkPolicy:asl-task-t2",
      "ConfigMap:asl-task-t2-config",
      "Secret:asl-botified-t2",
      "ServiceAccount:asl-task-t2"
    ]);
    assert.deepEqual(idlePlan.actions.map(actionSummary), [
      "delete_resource:Pod:asl-task-t2",
      "delete_resource:Service:asl-task-t2",
      "delete_resource:NetworkPolicy:asl-task-t2",
      "delete_resource:ConfigMap:asl-task-t2-config",
      "delete_resource:Secret:asl-botified-t2",
      "delete_resource:ServiceAccount:asl-task-t2",
      "store_run_state:run2:expired:cleanup_in_progress"
    ]);
    const idleStore = idlePlan.actions.find(isStoreAction);
    assert.equal(idleStore?.run.phase, "expired");
    assert.equal(idleStore?.run.cleanupStatus, "deleting");
  });

  it("marks expired and idle-expired runs cleaned when no matching resources remain", () => {
    const expired = sandboxRun({
      expiresAt: "2026-07-03T23:59:59.000Z",
      idleExpiresAt: "2026-07-04T00:30:00.000Z"
    });
    const idleExpired = sandboxRun({
      runId: "run2",
      taskId: "t2",
      resourceNames: {
        pod: "asl-task-t2",
        service: "asl-task-t2",
        configMap: "asl-task-t2-config",
        secret: "asl-botified-t2"
      },
      serviceKeySecretRef: {
        name: "asl-botified-t2",
        key: "BOTIFIED_SERVICE_KEY"
      },
      expiresAt: "2026-07-04T00:30:00.000Z",
      idleExpiresAt: "2026-07-03T23:59:59.000Z"
    });

    const expiredPlan = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [expired],
      observedResources: [],
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    const idlePlan = reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [idleExpired],
      observedResources: [],
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    assert.deepEqual(expiredPlan.actions.map(actionSummary), ["store_run_state:run1:cleaned:cleanup_complete"]);
    assert.deepEqual(idlePlan.actions.map(actionSummary), ["store_run_state:run2:cleaned:cleanup_complete"]);
    assert.equal(expiredPlan.actions.find(isStoreAction)?.run.cleanupStatus, "cleaned");
    assert.equal(idlePlan.actions.find(isStoreAction)?.run.cleanupStatus, "cleaned");
  });
});

function sandboxRun(overrides: Partial<SandboxRunState> = {}): SandboxRunState {
  return {
    workspaceId: "w1",
    projectId: "p1",
    taskId: "t1",
    runId: "run1",
    namespace: "agentsmith",
    phase: "running",
    image: "example/botified-runner@sha256:abc",
    pvcName: "agentsmith-lite-files",
    projectSubPath: "workspaces/w1/projects/p1",
    botifiedPort: 3099,
    resourceNames: {
      pod: "asl-task-t1",
      service: "asl-task-t1",
      configMap: "asl-task-t1-config",
      secret: "asl-botified-t1"
    },
    serviceKeySecretRef: {
      name: "asl-botified-t1",
      key: "BOTIFIED_SERVICE_KEY"
    },
    directories: {
      taskHome: "/workspace/project/tasks/t1/home",
      artifacts: "/workspace/project/tasks/t1/artifacts",
      botified: "/workspace/project/tasks/t1/botified"
    },
    resourceLimits: {
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    },
    expiresAt: "2026-07-04T01:00:00.000Z",
    idleExpiresAt: "2026-07-04T00:30:00.000Z",
    timelineCursor: "cursor-0",
    fencingToken: 7,
    cleanupStatus: "active",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides
  };
}

function renderedResource(run: SandboxRunState, kind: string): KubernetesResource {
  const resource = renderSandboxResources({
    namespace: run.namespace,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    taskId: run.taskId,
    runId: run.runId,
    image: run.image,
    pvcName: run.pvcName,
    projectSubPath: run.projectSubPath,
    botifiedPort: run.botifiedPort,
    serviceKeySecretName: run.resourceNames.secret,
    serviceKeySecretKey: run.serviceKeySecretRef.key,
    cpuRequest: run.resourceLimits.cpuRequest,
    memoryRequest: run.resourceLimits.memoryRequest,
    cpuLimit: run.resourceLimits.cpuLimit,
    memoryLimit: run.resourceLimits.memoryLimit,
    resourceNames: {
      pod: run.resourceNames.pod,
      service: run.resourceNames.service,
      configMap: run.resourceNames.configMap
    }
  }).resources.find((candidate) => candidate.kind === kind);
  assert.ok(resource, `${kind} should be rendered`);
  return resource;
}

function createdResourcesForRun(run: SandboxRunState): KubernetesResource[] {
  return applySandboxReconcileActions({
    observedResources: [],
    actions: reconcileSandboxRuns({
      namespace: "agentsmith",
      desiredRuns: [run],
      observedResources: [],
      now: new Date("2026-07-04T00:00:00.000Z")
    }).actions
  }).observedResources;
}

function observedResource(kind: string, name: string, labels: Record<string, string>): KubernetesResource {
  return {
    apiVersion: "v1",
    kind,
    metadata: {
      name,
      namespace: "agentsmith",
      labels
    }
  };
}

function actionSummary(action: SandboxReconcileAction): string {
  switch (action.type) {
    case "create_resource":
    case "adopt_resource":
    case "delete_resource":
      return `${action.type}:${action.kind}:${action.name}`;
    case "store_run_state":
      return `${action.type}:${action.run.runId}:${action.run.phase}:${action.reason}`;
  }
}

function pickSandboxLabels(resource: KubernetesResource): Record<string, string> {
  return {
    "agentsmith-lite/managed-by": resource.metadata.labels["agentsmith-lite/managed-by"] ?? "",
    "agentsmith-lite/workspace-id": resource.metadata.labels["agentsmith-lite/workspace-id"] ?? "",
    "agentsmith-lite/project-id": resource.metadata.labels["agentsmith-lite/project-id"] ?? "",
    "agentsmith-lite/task-id": resource.metadata.labels["agentsmith-lite/task-id"] ?? "",
    "agentsmith-lite/run-id": resource.metadata.labels["agentsmith-lite/run-id"] ?? ""
  };
}

function isDeleteAction(
  action: SandboxReconcileAction
): action is Extract<SandboxReconcileAction, { type: "delete_resource" }> {
  return action.type === "delete_resource";
}

function isStoreAction(
  action: SandboxReconcileAction
): action is Extract<SandboxReconcileAction, { type: "store_run_state" }> {
  return action.type === "store_run_state";
}
