import type { KubernetesResource } from "../../contracts/src/api.js";
import type { SandboxIdentity } from "./labels.js";
import {
  SANDBOX_CLEANUP_STATUS_LABEL,
  SANDBOX_LABEL_KEYS,
  SANDBOX_MANAGED_BY,
  sandboxIdentityLabels as identityLabels
} from "./labels.js";
import { renderSandboxResources } from "./manifestRenderer.js";
import { sandboxResourceNamesForTask } from "./resourceNames.js";

export { sandboxIdentityLabels } from "./labels.js";

export type SandboxCoreResourceKind = "Secret" | "ConfigMap" | "ServiceAccount" | "NetworkPolicy" | "Service" | "Pod";
export type SandboxRunPhase = "queued" | "starting" | "running" | "stopping" | "expired" | "cleaned";
export type SandboxCleanupStatus = "active" | "cleanup_requested" | "deleting" | "cleaned";

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
  taskHome: string;
  artifacts: string;
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
  botifiedPort: number;
  resourceNames: SandboxRunResourceNames;
  serviceKeySecretRef: SandboxServiceKeySecretRef;
  directories: SandboxRunDirectories;
  resourceLimits: SandboxRunResourceLimits;
  modelCa?: SandboxRunModelCaReference;
  modelEndpointBaseUrl?: string;
  expiresAt?: string | null;
  idleExpiresAt?: string | null;
  timelineCursor?: string | null;
  fencingToken: number;
  cleanupStatus: SandboxCleanupStatus;
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
      type: "mark_cleanup";
      kind: string;
      name: string;
      labels: Record<string, string>;
      resource: KubernetesResource;
      reason: "unknown_managed_resource";
    }
  | {
      type: "store_run_state";
      run: SandboxRunState;
      reason: "desired_observed" | "cleanup_in_progress" | "cleanup_complete";
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
  const desiredKnownResourceKeys = new Set<string>();

  for (const run of input.desiredRuns) {
    for (const resource of renderSandboxRunKnownResources(run)) {
      desiredKnownResourceKeys.add(resourceKey(resource));
    }
  }

  for (const run of input.desiredRuns) {
    const cleanupReason = shouldCleanup(run, input.now);
    if (cleanupReason) {
      actions.push(...cleanupRunResources(run, input.observedResources, cleanupReason));
      continue;
    }
    if (run.cleanupStatus === "cleaned" || run.phase === "cleaned") {
      continue;
    }

    for (const resource of renderSandboxRunCoreResources(run)) {
      const kind = asCoreKind(resource.kind);
      const labels = identityLabels(run);
      const observed = input.observedResources.find((candidate) => sameResource(candidate, resource) && hasLabels(candidate, labels));
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

  for (const resource of input.observedResources) {
    if (!isAgentsmithManaged(resource)) {
      continue;
    }
    const belongsToDesiredRun = input.desiredRuns.some((run) => hasRunIdentity(resource, run));
    if (belongsToDesiredRun && desiredKnownResourceKeys.has(resourceKey(resource))) {
      continue;
    }
    const labels = resourceIdentityLabels(resource);
    if (!labels) {
      continue;
    }
    actions.push({
      type: "mark_cleanup",
      kind: resource.kind,
      name: resource.metadata.name,
      labels,
      resource: structuredClone(resource),
      reason: "unknown_managed_resource"
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
      case "mark_cleanup":
        markResourceForCleanup(resources, action.resource, action.labels);
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
  observedResources: KubernetesResource[],
  cleanupReason: "phase" | "expired" | "idle_expired"
): SandboxReconcileAction[] {
  const actions: SandboxReconcileAction[] = [];
  const observed = observedCoreResourcesForRun(run, observedResources);
  if (observed.size === 0) {
    actions.push({
      type: "store_run_state",
      run: nextRunState(run, { phase: "cleaned", cleanupStatus: "cleaned" }),
      reason: "cleanup_complete"
    });
    return actions;
  }

  for (const kind of DELETE_ORDER) {
    const resource = observed.get(kind);
    if (!resource) {
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

  actions.push({
    type: "store_run_state",
    run: nextRunState(run, {
      phase: cleanupReason === "expired" || cleanupReason === "idle_expired" ? "expired" : run.phase,
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
    botifiedPort: run.botifiedPort,
    serviceKeySecretName: run.resourceNames.secret,
    serviceKeySecretKey: run.serviceKeySecretRef.key,
    cpuRequest: run.resourceLimits.cpuRequest,
    memoryRequest: run.resourceLimits.memoryRequest,
    cpuLimit: run.resourceLimits.cpuLimit,
    memoryLimit: run.resourceLimits.memoryLimit,
    ...(run.modelCa ? { modelCa: run.modelCa } : {}),
    ...(run.modelEndpointBaseUrl ? { modelEndpointBaseUrl: run.modelEndpointBaseUrl } : {}),
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
): Map<SandboxCoreResourceKind, KubernetesResource> {
  const observed = new Map<SandboxCoreResourceKind, KubernetesResource>();
  for (const kind of DELETE_ORDER) {
    const expectedName = expectedCoreResourceName(run, kind);
    const resource = observedResources.find((candidate) =>
      candidate.kind === kind &&
      candidate.metadata.name === expectedName &&
      candidate.metadata.namespace === run.namespace &&
      hasRunIdentity(candidate, run)
    );
    if (resource) {
      observed.set(kind, resource);
    }
  }
  return observed;
}

function shouldCleanup(run: SandboxRunState, now: Date): "phase" | "expired" | "idle_expired" | null {
  if (run.phase === "stopping" || run.phase === "expired" || run.cleanupStatus === "cleanup_requested" || run.cleanupStatus === "deleting") {
    return "phase";
  }
  if (isExpired(run.expiresAt, now)) {
    return "expired";
  }
  if (isExpired(run.idleExpiresAt, now)) {
    return "idle_expired";
  }
  return null;
}

function isExpired(value: string | null | undefined, now: Date): boolean {
  return typeof value === "string" && Date.parse(value) <= now.getTime();
}

function nextRunState(
  run: SandboxRunState,
  updates: Pick<SandboxRunState, "phase" | "cleanupStatus">
): SandboxRunState {
  return {
    ...structuredClone(run),
    phase: updates.phase,
    cleanupStatus: updates.cleanupStatus
  };
}

function isAgentsmithManaged(resource: KubernetesResource): boolean {
  return resource.metadata.labels[SANDBOX_LABEL_KEYS.managedBy] === SANDBOX_MANAGED_BY;
}

function hasRunIdentity(resource: KubernetesResource, run: SandboxRunState): boolean {
  return hasLabels(resource, identityLabels(run));
}

function hasLabels(resource: KubernetesResource, labels: Record<string, string>): boolean {
  return Object.entries(labels).every(([key, value]) => resource.metadata.labels[key] === value);
}

function resourceIdentityLabels(resource: KubernetesResource): Record<string, string> | null {
  const labels = resource.metadata.labels;
  const identity = {
    [SANDBOX_LABEL_KEYS.managedBy]: labels[SANDBOX_LABEL_KEYS.managedBy],
    [SANDBOX_LABEL_KEYS.workspaceId]: labels[SANDBOX_LABEL_KEYS.workspaceId],
    [SANDBOX_LABEL_KEYS.projectId]: labels[SANDBOX_LABEL_KEYS.projectId],
    [SANDBOX_LABEL_KEYS.taskId]: labels[SANDBOX_LABEL_KEYS.taskId],
    [SANDBOX_LABEL_KEYS.runId]: labels[SANDBOX_LABEL_KEYS.runId]
  };
  if (Object.values(identity).some((value) => typeof value !== "string" || value.length === 0)) {
    return null;
  }
  return identity as Record<string, string>;
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

function markResourceForCleanup(
  resources: KubernetesResource[],
  expected: KubernetesResource,
  labels: Record<string, string>
): void {
  const resource = resources.find((candidate) => sameResource(candidate, expected) && hasLabels(candidate, labels));
  if (!resource) {
    return;
  }
  resource.metadata.labels[SANDBOX_CLEANUP_STATUS_LABEL] = "pending";
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
