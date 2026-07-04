import type { AgentTaskStatus, KubernetesResource } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import type { ProductStore, PersistedSandboxRunState } from "../../ports/src/store.js";
import {
  type KubernetesResourceRef,
  type SandboxKubernetesMutationPort
} from "../../sandbox-controller/src/kubernetesPort.js";
import {
  reconcileSandboxRuns,
  type SandboxCoreResourceKind,
  type SandboxReconcileAction,
  type SandboxRunState
} from "../../sandbox-controller/src/reconciler.js";
import { SANDBOX_LABEL_KEYS } from "../../sandbox-controller/src/labels.js";

export interface SandboxKubernetesInventoryPort {
  listManagedResources(namespace: string): Promise<KubernetesResource[]>;
}

export type SandboxLifecycleKubernetesPort = SandboxKubernetesMutationPort & SandboxKubernetesInventoryPort;

export const DEFAULT_SANDBOX_RUN_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_SANDBOX_RUN_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface SandboxLifecycleServiceConfig {
  namespace: string;
  port?: SandboxLifecycleKubernetesPort;
  now?: () => Date;
}

export interface SandboxLifecycleScope {
  runId?: string;
}

export interface SandboxLifecycleActionSummary {
  type: SandboxReconcileAction["type"];
  runId?: string;
  kind?: string;
  name?: string;
  reason?: string;
}

export interface SandboxLifecycleRunCounts {
  total: number;
  active: number;
  cleanupRequested: number;
  deleting: number;
  cleaned: number;
  starting: number;
  running: number;
  stopping: number;
  expired: number;
}

export interface SandboxStatusResult {
  namespace: string;
  runCounts: SandboxLifecycleRunCounts;
  observedResourceCounts: Record<string, number>;
  actionSummary: SandboxLifecycleActionSummary[];
  errors: string[];
}

export interface SandboxReapInput extends SandboxLifecycleScope {
  dryRun?: boolean;
  apply?: boolean;
}

export interface SandboxReapResult extends SandboxStatusResult {
  dryRun: boolean;
  storedRunIds: string[];
}

export class SandboxLifecycleService {
  constructor(
    private readonly store: ProductStore,
    private readonly config: SandboxLifecycleServiceConfig
  ) {}

  async getSandboxStatus(scope: SandboxLifecycleScope = {}): Promise<SandboxStatusResult> {
    const runs = await this.loadRuns(scope);
    const observed = await this.observe(scope);
    const plan = this.plan(runs.activeRuns, observed.resources);
    return {
      namespace: this.config.namespace,
      runCounts: runCounts(runs.allRuns),
      observedResourceCounts: resourceCounts(observed.resources),
      actionSummary: plan.actions.map(actionSummary),
      errors: observed.errors
    };
  }

  async reapSandboxRunsOnce(input: SandboxReapInput = {}): Promise<SandboxReapResult> {
    const dryRun = input.apply === true && input.dryRun !== true ? false : true;
    const runs = await this.loadRuns(input);
    const observed = await this.observe(input);
    const plan = this.plan(runs.activeRuns, observed.resources);
    const result: SandboxReapResult = {
      namespace: this.config.namespace,
      runCounts: runCounts(runs.allRuns),
      observedResourceCounts: resourceCounts(observed.resources),
      actionSummary: plan.actions.map(actionSummary),
      errors: [...observed.errors],
      dryRun,
      storedRunIds: []
    };

    if (dryRun || observed.errors.length > 0) {
      return result;
    }
    if (!this.config.port) {
      throw new ProductError("Sandbox lifecycle Kubernetes port is not configured", 409);
    }

    const mutationErrors = await this.applyCleanupActions(this.config.port, plan.actions);
    result.errors.push(...mutationErrors);
    if (mutationErrors.length > 0) {
      return result;
    }

    const refreshed = await this.observe(input);
    result.errors.push(...refreshed.errors);
    result.observedResourceCounts = resourceCounts(refreshed.resources);
    if (refreshed.errors.length > 0) {
      return result;
    }
    const finalPlan = this.plan(runs.activeRuns, refreshed.resources);
    result.actionSummary.push(...finalPlan.actions.map(actionSummary));
    for (const action of finalPlan.actions) {
      if (action.type !== "store_run_state") {
        continue;
      }
      const transition = await this.persistRunTransition(action.run);
      if (transition) {
        result.storedRunIds.push(transition.stored.runId);
        await this.advanceTaskAfterRunTransition(transition.previous, transition.stored);
      } else {
        result.errors.push(`Sandbox run ${action.run.runId} fencing token changed before state could be stored`);
      }
    }
    const afterRuns = await this.loadRuns(input);
    result.runCounts = runCounts(afterRuns.allRuns);
    return result;
  }

  private async loadRuns(scope: SandboxLifecycleScope): Promise<{
    allRuns: PersistedSandboxRunState[];
    activeRuns: SandboxRunState[];
  }> {
    if (scope.runId) {
      const run = await this.store.sandboxRuns.get(scope.runId);
      const allRuns = run ? [run] : [];
      return {
        allRuns,
        activeRuns: allRuns.filter(isActiveRun) as SandboxRunState[]
      };
    }
    const allRuns = await this.store.sandboxRuns.list();
    const activeRuns = await this.store.sandboxRuns.listActive();
    return {
      allRuns,
      activeRuns: activeRuns as SandboxRunState[]
    };
  }

  private async observe(scope: SandboxLifecycleScope = {}): Promise<{ resources: KubernetesResource[]; errors: string[] }> {
    if (!this.config.port) {
      return { resources: [], errors: [] };
    }
    try {
      const resources = await this.config.port.listManagedResources(this.config.namespace);
      return { resources: filterObservedResourcesForScope(resources, scope), errors: [] };
    } catch (error) {
      return { resources: [], errors: [errorMessage(error)] };
    }
  }

  private plan(runs: SandboxRunState[], observedResources: KubernetesResource[]): { actions: SandboxReconcileAction[] } {
    return reconcileSandboxRuns({
      desiredRuns: runs,
      observedResources,
      now: this.config.now?.() ?? new Date()
    });
  }

  private async applyCleanupActions(
    port: SandboxLifecycleKubernetesPort,
    actions: SandboxReconcileAction[]
  ): Promise<string[]> {
    const errors: string[] = [];
    for (const action of actions) {
      try {
        if (action.type === "delete_resource") {
          const result = await port.deleteResource(resourceRef(action.resource), action.labels);
          if (result === "fence_mismatch") {
            errors.push(`Kubernetes delete fence mismatch for ${action.kind}/${action.name}`);
            return errors;
          }
          continue;
        }
        if (action.type === "mark_cleanup") {
          const result = await port.patchLabels(resourceRef(action.resource), action.labels, {
            "agentsmith-lite/cleanup-status": "pending"
          });
          if (result === "fence_mismatch") {
            errors.push(`Kubernetes cleanup mark fence mismatch for ${action.kind}/${action.name}`);
            return errors;
          }
        }
      } catch (error) {
        errors.push(errorMessage(error));
      }
      if (errors.length > 0) {
        return errors;
      }
    }
    return errors;
  }

  private async persistRunTransition(run: SandboxRunState): Promise<{
    previous: PersistedSandboxRunState;
    stored: PersistedSandboxRunState;
  } | null> {
    const current = await this.store.sandboxRuns.get(run.runId);
    if (!current) {
      return null;
    }
    const now = (this.config.now?.() ?? new Date()).toISOString();
    const stored = await this.store.sandboxRuns.updateWithFencing(run.runId, current.fencingToken, {
      ...(run as PersistedSandboxRunState),
      fencingToken: current.fencingToken + 1,
      updatedAt: now
    });
    return stored ? { previous: current, stored } : null;
  }

  private async advanceTaskAfterRunTransition(
    previous: PersistedSandboxRunState,
    stored: PersistedSandboxRunState
  ): Promise<void> {
    if (stored.cleanupStatus !== "cleaned" && stored.phase !== "cleaned") {
      return;
    }
    const task = await this.store.findTask(stored.taskId);
    if (!task || isTerminalTaskStatus(task.status)) {
      return;
    }
    const now = this.config.now?.() ?? new Date();
    const status: AgentTaskStatus = runWasExpired(previous, now) ? "expired" : "cleaned";
    await this.store.updateTask({
      ...task,
      status,
      updatedAt: now.toISOString()
    });
  }
}

export async function requestSandboxRunCleanup(
  store: ProductStore,
  runId: string,
  updates: Pick<PersistedSandboxRunState, "phase" | "cleanupStatus">
): Promise<PersistedSandboxRunState | null> {
  const current = await store.sandboxRuns.get(runId);
  if (!current || current.cleanupStatus === "cleaned" || current.phase === "cleaned") {
    return current;
  }
  return store.sandboxRuns.updateWithFencing(runId, current.fencingToken, {
    ...current,
    ...updates,
    fencingToken: current.fencingToken + 1,
    updatedAt: new Date().toISOString()
  });
}

export async function refreshSandboxRunActivity(
  store: ProductStore,
  runId: string,
  input: { idleTimeoutMs?: number; now?: Date } = {}
): Promise<void> {
  const current = await store.sandboxRuns.get(runId);
  if (!current || current.cleanupStatus !== "active") {
    return;
  }
  const now = input.now ?? new Date();
  const nextIdleExpiresAt = extendedIdleExpiresAt(
    current.idleExpiresAt,
    now,
    resolveDurationMs(input.idleTimeoutMs, DEFAULT_SANDBOX_RUN_IDLE_TIMEOUT_MS)
  );
  await store.sandboxRuns.updateWithFencing(runId, current.fencingToken, {
    ...current,
    idleExpiresAt: nextIdleExpiresAt,
    fencingToken: current.fencingToken + 1,
    updatedAt: now.toISOString()
  });
}

function isActiveRun(run: PersistedSandboxRunState): boolean {
  return run.cleanupStatus !== "cleaned" && run.phase !== "cleaned";
}

function runCounts(runs: PersistedSandboxRunState[]): SandboxLifecycleRunCounts {
  return {
    total: runs.length,
    active: runs.filter((run) => run.cleanupStatus === "active").length,
    cleanupRequested: runs.filter((run) => run.cleanupStatus === "cleanup_requested").length,
    deleting: runs.filter((run) => run.cleanupStatus === "deleting").length,
    cleaned: runs.filter((run) => run.cleanupStatus === "cleaned" || run.phase === "cleaned").length,
    starting: runs.filter((run) => run.phase === "starting").length,
    running: runs.filter((run) => run.phase === "running").length,
    stopping: runs.filter((run) => run.phase === "stopping").length,
    expired: runs.filter((run) => run.phase === "expired").length
  };
}

function resourceCounts(resources: KubernetesResource[]): Record<string, number> {
  const counts: Record<string, number> = {
    Secret: 0,
    ConfigMap: 0,
    ServiceAccount: 0,
    NetworkPolicy: 0,
    Service: 0,
    Pod: 0
  };
  for (const resource of resources) {
    counts[resource.kind] = (counts[resource.kind] ?? 0) + 1;
  }
  return counts;
}

function filterObservedResourcesForScope(
  resources: KubernetesResource[],
  scope: SandboxLifecycleScope
): KubernetesResource[] {
  if (!scope.runId) {
    return resources;
  }
  return resources.filter((resource) => resource.metadata.labels[SANDBOX_LABEL_KEYS.runId] === scope.runId);
}

function actionSummary(action: SandboxReconcileAction): SandboxLifecycleActionSummary {
  switch (action.type) {
    case "create_resource":
    case "adopt_resource":
    case "delete_resource":
      return {
        type: action.type,
        runId: action.runId,
        kind: action.kind,
        name: action.name
      };
    case "mark_cleanup":
      return {
        type: action.type,
        kind: action.kind,
        name: action.name,
        reason: action.reason
      };
    case "store_run_state":
      return {
        type: action.type,
        runId: action.run.runId,
        reason: action.reason
      };
  }
}

const sandboxCoreKinds: SandboxCoreResourceKind[] = ["Pod", "Service", "Secret", "ConfigMap", "ServiceAccount", "NetworkPolicy"];

function resourceRef(resource: KubernetesResource): KubernetesResourceRef {
  if (!sandboxCoreKinds.includes(resource.kind as SandboxCoreResourceKind)) {
    throw new ProductError(`Sandbox lifecycle resource kind is not supported: ${resource.kind}`, 500);
  }
  if (!resource.metadata.namespace) {
    throw new ProductError(`Sandbox lifecycle resource is missing namespace: ${resource.metadata.name}`, 500);
  }
  return {
    kind: resource.kind as SandboxCoreResourceKind,
    namespace: resource.metadata.namespace,
    name: resource.metadata.name
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown sandbox lifecycle error";
}

function isTerminalTaskStatus(status: AgentTaskStatus | "canceled" | "cancelled"): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "expired" ||
    status === "cleaned" ||
    status === "canceled" ||
    status === "cancelled"
  );
}

function runWasExpired(run: PersistedSandboxRunState, now: Date): boolean {
  return run.phase === "expired" || isExpired(run.expiresAt, now) || isExpired(run.idleExpiresAt, now);
}

function isExpired(value: string | null | undefined, now: Date): boolean {
  return typeof value === "string" && Date.parse(value) <= now.getTime();
}

function extendedIdleExpiresAt(currentIdleExpiresAt: string | null | undefined, now: Date, idleTimeoutMs: number): string {
  const next = new Date(now.getTime() + idleTimeoutMs).toISOString();
  if (typeof currentIdleExpiresAt !== "string") {
    return next;
  }
  return Date.parse(currentIdleExpiresAt) > Date.parse(next) ? currentIdleExpiresAt : next;
}

function resolveDurationMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}
