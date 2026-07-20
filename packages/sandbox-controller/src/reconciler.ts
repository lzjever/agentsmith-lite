import type { KubernetesResource, SandboxReleaseReason, SandboxResourceSnapshot } from "../../contracts/src/api.js";
import type { SandboxIdentity } from "./labels.js";
import { sandboxIdentityLabels as identityLabels } from "./labels.js";
import { renderSandboxResources } from "./manifestRenderer.js";
import { sandboxResourceNamesForTask } from "./resourceNames.js";

export { sandboxIdentityLabels } from "./labels.js";

export type SandboxCoreResourceKind = "Secret" | "ConfigMap" | "ServiceAccount" | "NetworkPolicy" | "Service" | "Pod";
export type SandboxRunPhase = "queued" | "starting" | "running" | "stopping" | "expired" | "cleaned";
export type SandboxCleanupStatus = "active" | "cleanup_requested" | "deleting" | "cleaned";
export type SandboxTerminalFailureReason = "pod_failed" | "runner_terminated" | "runner_crash_loop_back_off";

export interface SandboxTerminalFailure {
  reason: SandboxTerminalFailureReason;
  exitCode?: number;
}

export interface SandboxRunResourceNames {
  pod: string;
  service: string;
  configMap: string;
  secret: string;
  serviceAccount?: string;
  networkPolicy?: string;
}

export interface SandboxServiceKeySecretRef {
  name: string;
  key: string;
}

export interface SandboxRunDirectories {
  libraryHome: string;
  botified: string;
}

export interface SandboxRunResourceLimits {
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit: string;
  memoryLimit: string;
}

export interface SandboxRunModelCaReference {
  configMapName: string;
  configMapKey: string;
  path: string;
}

export interface SandboxRunState extends SandboxIdentity {
  namespace: string;
  phase: SandboxRunPhase;
  image: string;
  pvcName: string;
  projectSubPath: string;
  fileLibraryRootSubPath:string;
  fileLibraryId: string;
  startedByUserId: string;
  startedAt: string | null;
  botifiedPort: number;
  resourceNames: SandboxRunResourceNames;
  serviceKeySecretRef: SandboxServiceKeySecretRef;
  directories: SandboxRunDirectories;
  resourceLimits: SandboxRunResourceLimits;
  resourceSnapshot: SandboxResourceSnapshot;
  releaseReason?: SandboxReleaseReason | null;
  modelCa?: SandboxRunModelCaReference;
  timelineCursor?: string | null;
  terminalFailure?: SandboxTerminalFailure | null;
  fencingToken: number;
  cleanupStatus: SandboxCleanupStatus;
  resumeUnfinished?: boolean;
  cleanupAttempts?: number;
  lastCleanupAt?: string | null;
  lastCleanupError?: {
    at: string;
    target: string;
    message: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxReconcileInput {
  namespace: string;
  desiredRuns: SandboxRunState[];
  observedResources: KubernetesResource[];
  now: Date;
}

export interface SandboxReconcileResult {
  actions: SandboxReconcileAction[];
}

export type SandboxReconcileAction =
  | {
      type: "create_resource";
      runId: string;
      kind: SandboxCoreResourceKind;
      name: string;
      labels: Record<string, string>;
      resource: KubernetesResource;
    }
  | {
      type: "adopt_resource";
      runId: string;
      kind: SandboxCoreResourceKind;
      name: string;
      labels: Record<string, string>;
      resource: KubernetesResource;
    }
  | {
      type: "delete_resource";
      runId: string;
      kind: SandboxCoreResourceKind;
      name: string;
      labels: Record<string, string>;
      resource: KubernetesResource;
    }
  | {
      type: "store_run_state";
      run: SandboxRunState;
      reason: "desired_observed" | "terminal_runner_failure" | "cleanup_in_progress" | "cleanup_complete";
    };

export interface ApplySandboxReconcileActionsInput {
  observedResources: KubernetesResource[];
  actions: SandboxReconcileAction[];
}

export interface ApplySandboxReconcileActionsResult {
  observedResources: KubernetesResource[];
  storedRuns: SandboxRunState[];
}

const CREATE_ORDER: readonly SandboxCoreResourceKind[] = [
  "Secret",
  "ConfigMap",
  "ServiceAccount",
  "NetworkPolicy",
  "Service",
  "Pod"
];
const DELETE_ORDER: readonly SandboxCoreResourceKind[] = [
  "Pod",
  "Service",
  "NetworkPolicy",
  "ConfigMap",
  "Secret",
  "ServiceAccount"
];

export function reconcileSandboxRuns(input: SandboxReconcileInput): SandboxReconcileResult {
  const actions: SandboxReconcileAction[] = [];
  const observedResources = input.observedResources.filter((resource) => resource.metadata.namespace === input.namespace);

  for (const run of input.desiredRuns) {
    if (shouldCleanup(run)) {
      actions.push(...cleanupRunResources(run, observedResources));
      continue;
    }
    if (run.cleanupStatus === "cleaned" || run.phase === "cleaned") {
      continue;
    }
    const terminalFailure = run.terminalFailure ? null : terminalFailureForExpectedRunnerPod(run, observedResources);
    if (terminalFailure) {
      actions.push({
        type: "store_run_state",
        run: nextRunState(run, {
          phase: run.phase,
          cleanupStatus: "active",
          terminalFailure
        }),
        reason: "terminal_runner_failure"
      });
      continue;
    }
    if (run.terminalFailure || run.phase === "stopping" || run.phase === "expired") continue;

    for (const resource of renderSandboxRunCoreResources(run)) {
      const kind = asCoreKind(resource.kind);
      const labels = identityLabels(run);
      const observed = observedResources.find((candidate) => sameResource(candidate, resource) && hasLabels(candidate, labels));
      if (observed) {
        actions.push({
          type: "adopt_resource",
          runId: run.runId,
          kind,
          name: resource.metadata.name,
          labels,
          resource: structuredClone(observed)
        });
      } else {
        actions.push({
          type: "create_resource",
          runId: run.runId,
          kind,
          name: resource.metadata.name,
          labels,
          resource
        });
      }
    }

    actions.push({
      type: "store_run_state",
      run: structuredClone(run),
      reason: "desired_observed"
    });
  }

  return { actions };
}

export function applySandboxReconcileActions(
  input: ApplySandboxReconcileActionsInput
): ApplySandboxReconcileActionsResult {
  const resources = input.observedResources.map((resource) => structuredClone(resource));
  const storedRuns = new Map<string, SandboxRunState>();

  for (const action of input.actions) {
    switch (action.type) {
      case "create_resource":
        if (hasLabels(action.resource, action.labels) && !resources.some((resource) => sameResource(resource, action.resource))) {
          resources.push(structuredClone(action.resource));
        }
        break;
      case "delete_resource":
        removeMatchingResource(resources, action.resource, action.labels);
        break;
      case "store_run_state":
        storedRuns.set(action.run.runId, structuredClone(action.run));
        break;
      case "adopt_resource":
        break;
    }
  }

  return {
    observedResources: resources,
    storedRuns: [...storedRuns.values()]
  };
}

function cleanupRunResources(
  run: SandboxRunState,
  observedResources: KubernetesResource[]
): SandboxReconcileAction[] {
  const actions: SandboxReconcileAction[] = [];
  const observed = observedCoreResourcesForRun(run, observedResources).filter((resource) =>
    resource.kind === "Pod" || typeof resource.metadata.deletionTimestamp !== "string"
  );
  if (observed.length === 0) {
    actions.push({
      type: "store_run_state",
      run: nextRunState(run, { phase: "cleaned", cleanupStatus: "cleaned" }),
      reason: "cleanup_complete"
    });
    return actions;
  }

  for (const kind of DELETE_ORDER) {
    for (const resource of observed) {
      if (resource.kind !== kind) {
        continue;
      }
      actions.push({
        type: "delete_resource",
        runId: run.runId,
        kind,
        name: resource.metadata.name,
        labels: identityLabels(run),
        resource: structuredClone(resource)
      });
    }
  }

  actions.push({
    type: "store_run_state",
    run: nextRunState(run, {
      phase: run.phase,
      cleanupStatus: "deleting"
    }),
    reason: "cleanup_in_progress"
  });
  return actions;
}

function renderSandboxRunCoreResources(run: SandboxRunState): KubernetesResource[] {
  const resources = renderSandboxRunKnownResources(run);
  return CREATE_ORDER.map((kind) => {
    const name = expectedCoreResourceName(run, kind);
    const resource = resources.find((candidate) => candidate.kind === kind && candidate.metadata.name === name);
    if (!resource) {
      throw new Error(`Missing rendered sandbox ${kind} ${name}`);
    }
    return resource;
  });
}

function renderSandboxRunKnownResources(run: SandboxRunState): KubernetesResource[] {
  const resourceNames = {
    pod: run.resourceNames.pod,
    service: run.resourceNames.service,
    configMap: run.resourceNames.configMap,
    ...(run.resourceNames.serviceAccount ? { serviceAccount: run.resourceNames.serviceAccount } : {}),
    ...(run.resourceNames.networkPolicy ? { networkPolicy: run.resourceNames.networkPolicy } : {})
  };
  return renderSandboxResources({
    namespace: run.namespace,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    taskId: run.taskId,
    runId: run.runId,
    image: run.image,
    pvcName: run.pvcName,
    projectSubPath: run.projectSubPath,
    fileLibraryRootSubPath:run.fileLibraryRootSubPath,
    botifiedPort: run.botifiedPort,
    serviceKeySecretName: run.resourceNames.secret,
    serviceKeySecretKey: run.serviceKeySecretRef.key,
    cpuRequest: run.resourceLimits.cpuRequest,
    memoryRequest: run.resourceLimits.memoryRequest,
    cpuLimit: run.resourceLimits.cpuLimit,
    memoryLimit: run.resourceLimits.memoryLimit,
    ...(run.modelCa ? { modelCa: run.modelCa } : {}),
    resourceNames
  }).resources;
}

function expectedCoreResourceName(run: SandboxRunState, kind: SandboxCoreResourceKind): string {
  switch (kind) {
    case "Secret":
      return run.resourceNames.secret;
    case "ConfigMap":
      return run.resourceNames.configMap;
    case "ServiceAccount":
      return run.resourceNames.serviceAccount ?? sandboxResourceNamesForTask(run.taskId).serviceAccount;
    case "NetworkPolicy":
      return run.resourceNames.networkPolicy ?? sandboxResourceNamesForTask(run.taskId).networkPolicy;
    case "Pod":
      return run.resourceNames.pod;
    case "Service":
      return run.resourceNames.service;
  }
}

function observedCoreResourcesForRun(
  run: SandboxRunState,
  observedResources: KubernetesResource[]
): KubernetesResource[] {
  return observedResources.filter((resource) =>
    DELETE_ORDER.some((kind) => resource.kind === kind) &&
    resource.metadata.namespace === run.namespace &&
    hasRunIdentity(resource, run)
  );
}

function shouldCleanup(run: SandboxRunState): boolean {
  return run.cleanupStatus === "cleanup_requested" || run.cleanupStatus === "deleting";
}

function nextRunState(
  run: SandboxRunState,
  updates: Pick<SandboxRunState, "phase" | "cleanupStatus" | "terminalFailure">
): SandboxRunState {
  return {
    ...structuredClone(run),
    phase: updates.phase,
    cleanupStatus: updates.cleanupStatus,
    ...(updates.terminalFailure ? { terminalFailure: updates.terminalFailure } : {})
  };
}

function terminalFailureForExpectedRunnerPod(
  run: SandboxRunState,
  observedResources: KubernetesResource[]
): SandboxTerminalFailure | null {
  const pod = observedResources.find((resource) =>
    resource.kind === "Pod" &&
    resource.metadata.namespace === run.namespace &&
    resource.metadata.name === run.resourceNames.pod &&
    hasRunIdentity(resource, run)
  );
  if (!pod) {
    return null;
  }
  const status = asRecord(pod.status);
  if (status?.phase === "Failed") {
    return { reason: "pod_failed" };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasRunIdentity(resource: KubernetesResource, run: SandboxRunState): boolean {
  return hasLabels(resource, identityLabels(run));
}

function hasLabels(resource: KubernetesResource, labels: Record<string, string>): boolean {
  return Object.entries(labels).every(([key, value]) => resource.metadata.labels[key] === value);
}

function sameResource(left: KubernetesResource, right: KubernetesResource): boolean {
  return resourceKey(left) === resourceKey(right);
}

function resourceKey(resource: KubernetesResource): string {
  return `${resource.kind}:${resource.metadata.namespace ?? ""}:${resource.metadata.name}`;
}

function removeMatchingResource(
  resources: KubernetesResource[],
  expected: KubernetesResource,
  labels: Record<string, string>
): void {
  const index = resources.findIndex((resource) => sameResource(resource, expected) && hasLabels(resource, labels));
  if (index >= 0) {
    resources.splice(index, 1);
  }
}

function asCoreKind(kind: string): SandboxCoreResourceKind {
  if (
    kind === "Secret" ||
    kind === "ConfigMap" ||
    kind === "ServiceAccount" ||
    kind === "NetworkPolicy" ||
    kind === "Service" ||
    kind === "Pod"
  ) {
    return kind;
  }
  throw new Error(`Unsupported sandbox core resource kind: ${kind}`);
}
