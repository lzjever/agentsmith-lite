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
  it("classifies a full-identity required task container failure before it can be re-adopted", () => {
    const run = sandboxRun();
    for (const [status, expected] of [[{ phase: "Failed" }, { reason: "pod_failed" }]] as const) {
      const pod = renderedResource(run, "Pod");
      pod.status = status;
      const plan = reconcileSandboxRuns({
        namespace: run.namespace,
        desiredRuns: [run],
        observedResources: [pod],
        now: new Date("2026-07-04T00:00:00.000Z")
      });

      const transition = plan.actions.find(isStoreAction);
      assert.equal(transition?.reason, "terminal_runner_failure");
      assert.equal(transition?.run.phase, "stopping");
      assert.equal(transition?.run.cleanupStatus, "cleanup_requested");
      assert.deepEqual(transition?.run.terminalFailure, expected);
      assert.equal(transition?.run.releaseReason, "failed");
      assert.equal(plan.actions.some((action) => action.type === "adopt_resource" && action.kind === "Pod"), false);
      assert.equal(plan.actions.some((action) => action.type === "create_resource"), false);
      assert.equal(plan.actions.some((action) => action.type === "delete_resource"), false);
    }

    const runningPod=renderedResource(run,"Pod");runningPod.status={containerStatuses:[{name:"botified-server",state:{terminated:{exitCode:23}}}]};
    const processPlan=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[run],observedResources:[runningPod],now:new Date("2026-07-04T00:00:00.000Z")});
    assert.equal(processPlan.actions.some((action)=>action.type==="store_run_state"&&action.reason==="terminal_runner_failure"),false);
  });

  it("advances a persisted active terminal failure to cleanup when its Pod is already gone", () => {
    const observedResources = createdResourcesForRun(sandboxRun()).filter((resource) => resource.kind !== "Pod");
    const run = sandboxRun({
      terminalFailure: { reason: "pod_failed" },
      releaseReason: "failed"
    });

    const plan = reconcileSandboxRuns({
      namespace: run.namespace,
      desiredRuns: [run],
      observedResources,
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    const transition = plan.actions.find(isStoreAction);
    assert.equal(transition?.reason, "terminal_runner_failure");
    assert.equal(transition?.run.phase, "stopping");
    assert.equal(transition?.run.cleanupStatus, "cleanup_requested");
    assert.deepEqual(transition?.run.terminalFailure, { reason: "pod_failed" });
    assert.equal(transition?.run.releaseReason, "failed");
    assert.equal(plan.actions.some((action) => action.type === "create_resource"), false);
    assert.equal(plan.actions.some((action) => action.type === "adopt_resource"), false);
    assert.equal(plan.actions.some((action) => action.type === "delete_resource"), false);
  });

  it("ignores terminal Pod status unless namespace, expected name, and full identity all match", () => {
    const run = sandboxRun();
    const exactPod = renderedResource(run, "Pod");
    exactPod.status = { phase: "Failed" };
    const wrongNamespace = structuredClone(exactPod);
    wrongNamespace.metadata.namespace = "other-namespace";
    const wrongName = structuredClone(exactPod);
    wrongName.metadata.name = "different-pod";
    const wrongLabels = structuredClone(exactPod);
    wrongLabels.metadata.labels["agentsmith-lite/run-id"] = "other-run";

    for (const pod of [wrongNamespace, wrongName, wrongLabels]) {
      const plan = reconcileSandboxRuns({
        namespace: run.namespace,
        desiredRuns: [run],
        observedResources: [pod],
        now: new Date("2026-07-04T00:00:00.000Z")
      });
      assert.equal(plan.actions.some((action) => action.type === "store_run_state" && action.reason === "terminal_runner_failure"), false);
    }
  });

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
        libraryHome: `/workspace/project/libraries/library-${taskId}/home`,
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

  it("retains fenced resources when no persisted run authorizes cleanup", () => {
    const run=sandboxRun();
    const resources=createdResourcesForRun(run);
    const plan=reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[],observedResources:resources,now:new Date("2099-01-01T00:00:00.000Z")});
    assert.deepEqual(plan.actions,[]);
  });

  it("deletes stopping resources in pod-service-networkpolicy-configmap-secret-serviceaccount order with label fencing", () => {
    const activeRun = sandboxRun();
    const run = sandboxRun({
      phase: "stopping",
      cleanupStatus: "cleanup_requested"
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

  it("cleans every full-identity task resource, including extra ServiceAccounts, while retaining mismatches", () => {
    const run = sandboxRun({ phase: "stopping", cleanupStatus: "cleanup_requested" });
    const legacyServiceAccount = observedResource("ServiceAccount", "asl-task-task1-legacy", sandboxIdentityLabels(run));
    legacyServiceAccount.metadata.uid = "legacy-service-account-uid";
    const mismatchedServiceAccount = observedResource("ServiceAccount", "asl-task-task1-other", sandboxIdentityLabels(run));
    delete mismatchedServiceAccount.metadata.labels["agentsmith-lite/run-id"];
    const observedResources = [...createdResourcesForRun(sandboxRun()), legacyServiceAccount, mismatchedServiceAccount];

    const plan = reconcileSandboxRuns({
      namespace: run.namespace,
      desiredRuns: [run],
      observedResources,
      now: new Date("2026-07-04T00:00:05.000Z")
    });
    const deletes = plan.actions.filter(isDeleteAction);

    assert.deepEqual(deletes.map((action) => `${action.kind}:${action.name}`), [
      "Pod:asl-task-t1",
      "Service:asl-task-t1",
      "NetworkPolicy:asl-task-t1",
      "ConfigMap:asl-task-t1-config",
      "Secret:asl-botified-t1",
      "ServiceAccount:asl-task-t1",
      "ServiceAccount:asl-task-task1-legacy"
    ]);
    assert.equal(deletes.find((action) => action.name === "asl-task-task1-legacy")?.resource.metadata.uid, "legacy-service-account-uid");

    const applied = applySandboxReconcileActions({ observedResources, actions: plan.actions });
    assert.deepEqual(applied.observedResources.map((resource) => resource.metadata.name), ["asl-task-task1-other"]);
  });

  it("does not clean a run because time passed or its phase became terminal", () => {
    for (const phase of ["running", "stopping", "expired"] as const) {
      const run = sandboxRun({ phase, cleanupStatus:"active" });
      const resources = createdResourcesForRun(sandboxRun());
      const plan = reconcileSandboxRuns({namespace:run.namespace,desiredRuns:[run],observedResources:resources,now:new Date("2099-01-01T00:00:00.000Z")});
      assert.equal(plan.actions.some(isDeleteAction),false);
      assert.equal(plan.actions.some((action)=>action.type==="store_run_state"&&action.reason==="cleanup_complete"),false);
      if(phase!=="running")assert.deepEqual(plan.actions,[]);
    }
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
    fileLibraryRootSubPath: "libraries/library-t1/home",
    fileLibraryId:"library-t1",
    startedByUserId:"user1",
    startedAt:"2026-07-04T00:00:00.000Z",
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
      libraryHome: "/workspace/project/libraries/library-t1/home",
      botified: "/workspace/project/tasks/t1/botified"
    },
    resourceLimits: {
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    },
    resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},
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
    fileLibraryRootSubPath: run.fileLibraryRootSubPath,
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
