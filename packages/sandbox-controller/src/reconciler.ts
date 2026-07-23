import type { KubernetesResource, SandboxFailureCode, SandboxReleaseReason, SandboxResourceSnapshot } from "../../contracts/src/api.js";
import type { SandboxIdentity } from "./labels.js";
import { sandboxIdentityLabels as identityLabels } from "./labels.js";
import { SANDBOX_LABEL_KEYS, SANDBOX_MANAGED_BY } from "./labels.js";
import { renderSandboxResources } from "./manifestRenderer.js";
import { sandboxResourceNamesForTask } from "./resourceNames.js";

export { sandboxIdentityLabels } from "./labels.js";

export type SandboxCoreResourceKind = "Secret" | "ConfigMap" | "ServiceAccount" | "NetworkPolicy" | "Service" | "Pod";
export type SandboxRunStateValue = "starting" | "active" | "release_requested" | "failed" | "released";
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
  state: SandboxRunStateValue;
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
  failureCode: SandboxFailureCode | null;
  failureCause: string | null;
  fencingToken: number;
  resumeUnfinished?: boolean;
  startupClaimToken?: string | null;
  startupLeaseExpiresAt?: string | null;
  cleanupClaimedAt?: string | null;
  cleanupAttempts?: number;
  lastCleanupAt?: string | null;
  lastCleanupError?: {
    at: string;
    target: string;
    message: string;
  } | null;
  releaseRequestedAt: string | null;
  failedAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxReconcileInput {
  namespace: string;
  desiredRuns: SandboxRunState[];
  persistedRunIds?: readonly string[];
  observedResources: KubernetesResource[];
  now: Date;
}

export interface SandboxReconcileResult {
  actions: SandboxReconcileAction[];
  errors: string[];
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
      actions.push(...cleanupRunResources(run, observedResources, input.now.toISOString()));
      continue;
    }
    if (run.state === "released") {
      continue;
    }
    const terminalFailure = run.terminalFailure ?? terminalFailureForExpectedRunnerPod(run, observedResources);
    if (terminalFailure) {
      actions.push({
        type: "store_run_state",
        run: nextRunState(run, {
          state: "failed",
          terminalFailure,
          releaseReason: "failed",
          failureCode:"runner_failed",
          failureCause:terminalFailureLabel(terminalFailure),
          failedAt:input.now.toISOString(),
          releaseRequestedAt:input.now.toISOString(),
          cleanupClaimedAt:null
        }),
        reason: "terminal_runner_failure"
      });
      continue;
    }
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

  const orphanPlan = input.persistedRunIds
    ? reconcileOrphanedResources(
        observedResources,
        new Set([...input.persistedRunIds, ...input.desiredRuns.map((run) => run.runId)])
      )
    : { actions: [], errors: [] };
  actions.push(...orphanPlan.actions);
  return { actions, errors: orphanPlan.errors };
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
  observedResources: KubernetesResource[],
  timestamp: string
): SandboxReconcileAction[] {
  const actions: SandboxReconcileAction[] = [];
  const observed = observedCoreResourcesForRun(run, observedResources).filter((resource) =>
    resource.kind === "Pod" || typeof resource.metadata.deletionTimestamp !== "string"
  );
  if (observed.length === 0) {
    actions.push({
      type: "store_run_state",
      run: nextRunState(run, { state: "released", releasedAt:timestamp, cleanupClaimedAt:null }),
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
    run: structuredClone(run),
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

function reconcileOrphanedResources(
  observedResources: KubernetesResource[],
  persistedRunIds: ReadonlySet<string>
): SandboxReconcileResult {
  const groups = new Map<string, {
    identity: SandboxIdentity | null;
    resources: KubernetesResource[];
    invalid: boolean;
    resourceKeys: Set<string>;
  }>();
  const errors: string[] = [];

  for (const resource of observedResources) {
    if (!isObservedSandboxCandidate(resource)) {
      continue;
    }
    const runId = nonEmptyLabel(resource, SANDBOX_LABEL_KEYS.runId);
    if (!runId) {
      errors.push(`Orphan sandbox resource has incomplete identity: ${boundedResourceRef(resource)}`);
      continue;
    }
    const group = groups.get(runId) ?? {
      identity: null,
      resources: [],
      invalid: false,
      resourceKeys: new Set<string>()
    };
    groups.set(runId, group);

    const identity = observedSandboxIdentity(resource);
    const key = resourceKey(resource);
    if (
      !identity ||
      !resourceUid(resource) ||
      group.resourceKeys.has(key) ||
      (group.identity !== null && !sameIdentity(group.identity, identity))
    ) {
      group.invalid = true;
    } else if (group.identity === null) {
      group.identity = identity;
    }
    group.resourceKeys.add(key);
    group.resources.push(resource);
  }

  const actions: SandboxReconcileAction[] = [];
  for (const [runId, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (group.invalid || group.identity === null) {
      errors.push(`Orphan sandbox resource group ${boundedIdentifier(runId)} has incomplete or mismatched ownership`);
      continue;
    }
    if (persistedRunIds.has(runId)) {
      continue;
    }
    const labels = identityLabels(group.identity);
    for (const kind of DELETE_ORDER) {
      const resources = group.resources
        .filter((resource) => resource.kind === kind)
        .sort((left, right) => left.metadata.name.localeCompare(right.metadata.name));
      for (const resource of resources) {
        actions.push({
          type: "delete_resource",
          runId,
          kind,
          name: resource.metadata.name,
          labels,
          resource: structuredClone(resource)
        });
      }
    }
  }

  return { actions, errors: errors.slice(0, 20) };
}

function isObservedSandboxCandidate(resource: KubernetesResource): boolean {
  return DELETE_ORDER.some((kind) => resource.kind === kind) && (
    resource.metadata.labels["app.kubernetes.io/component"] === "sandbox" ||
    SANDBOX_IDENTITY_LABEL_KEYS.some((key) => nonEmptyLabel(resource, key) !== null)
  );
}

function observedSandboxIdentity(resource: KubernetesResource): SandboxIdentity | null {
  if (
    resource.metadata.labels["app.kubernetes.io/name"] !== "agentsmith-lite" ||
    resource.metadata.labels["app.kubernetes.io/part-of"] !== "agentsmith-lite" ||
    resource.metadata.labels["app.kubernetes.io/managed-by"] !== SANDBOX_MANAGED_BY ||
    resource.metadata.labels["app.kubernetes.io/component"] !== "sandbox" ||
    resource.metadata.labels[SANDBOX_LABEL_KEYS.managedBy] !== SANDBOX_MANAGED_BY
  ) {
    return null;
  }
  const workspaceId = nonEmptyLabel(resource, SANDBOX_LABEL_KEYS.workspaceId);
  const projectId = nonEmptyLabel(resource, SANDBOX_LABEL_KEYS.projectId);
  const taskId = nonEmptyLabel(resource, SANDBOX_LABEL_KEYS.taskId);
  const runId = nonEmptyLabel(resource, SANDBOX_LABEL_KEYS.runId);
  return workspaceId && projectId && taskId && runId
    ? { workspaceId, projectId, taskId, runId }
    : null;
}

function nonEmptyLabel(resource: KubernetesResource, key: string): string | null {
  const value = resource.metadata.labels[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sameIdentity(left: SandboxIdentity, right: SandboxIdentity): boolean {
  return left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.runId === right.runId;
}

function resourceUid(resource: KubernetesResource): string | null {
  const value = resource.metadata.uid;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boundedResourceRef(resource: KubernetesResource): string {
  return `${boundedIdentifier(resource.kind)}/${boundedIdentifier(resource.metadata.name)}`;
}

function boundedIdentifier(value: string): string {
  return value.slice(0, 80);
}

const SANDBOX_IDENTITY_LABEL_KEYS = [
  SANDBOX_LABEL_KEYS.workspaceId,
  SANDBOX_LABEL_KEYS.projectId,
  SANDBOX_LABEL_KEYS.taskId,
  SANDBOX_LABEL_KEYS.runId
] as const;

function shouldCleanup(run: SandboxRunState): boolean {
  return run.state === "release_requested" || run.state === "failed";
}

function nextRunState(
  run: SandboxRunState,
  updates: Pick<SandboxRunState, "state"> &
    Partial<Pick<SandboxRunState, "terminalFailure" | "releaseReason" | "failureCode" | "failureCause" | "failedAt" | "releasedAt" | "releaseRequestedAt" | "cleanupClaimedAt">>
): SandboxRunState {
  return {
    ...structuredClone(run),
    state: updates.state,
    ...(updates.terminalFailure ? { terminalFailure: updates.terminalFailure } : {}),
    ...(updates.releaseReason !== undefined ? { releaseReason: updates.releaseReason } : {}),
    ...(updates.failureCode !== undefined ? { failureCode:updates.failureCode } : {}),
    ...(updates.failureCause !== undefined ? { failureCause:updates.failureCause } : {}),
    ...(updates.failedAt !== undefined ? { failedAt:updates.failedAt } : {}),
    ...(updates.releasedAt !== undefined ? { releasedAt:updates.releasedAt } : {}),
    ...(updates.releaseRequestedAt !== undefined ? { releaseRequestedAt:updates.releaseRequestedAt } : {}),
    ...(updates.cleanupClaimedAt !== undefined ? { cleanupClaimedAt:updates.cleanupClaimedAt } : {})
  };
}

function terminalFailureLabel(failure:SandboxTerminalFailure):string {
  return failure.reason === "pod_failed" ? "Sandbox Pod stopped unexpectedly"
    : failure.reason === "runner_terminated" ? "Botified stopped unexpectedly"
    : "Botified could not remain running";
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
  const containerStatuses = Array.isArray(status?.containerStatuses) ? status.containerStatuses : [];
  const runnerStatus = containerStatuses
    .map(asRecord)
    .find((containerStatus) => containerStatus?.name === "botified-server");
  const terminated = asRecord(asRecord(runnerStatus?.state)?.terminated);
  if (terminated) {
    return typeof terminated.exitCode === "number"
      ? { reason: "runner_terminated", exitCode: terminated.exitCode }
      : { reason: "runner_terminated" };
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
