import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentTaskStatus, KubernetesResource } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import type {
  PersistedSandboxRunState,
  PersistedSandboxTerminalFailure,
  ProductStore
} from "../../ports/src/store.js";
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
const MAX_DELETE_RESOURCE_ERROR_CONFIRM_ATTEMPTS = 30;
const DEFAULT_DELETE_RESOURCE_ERROR_CONFIRM_ATTEMPTS = 30;
const DEFAULT_DELETE_RESOURCE_ERROR_CONFIRM_DELAY_MS = 200;
const TERMINAL_FAILURE_TRANSITION_ATTEMPTS = 2;
const MAX_TERMINAL_FAILURE_SYNC_ATTEMPTS = 3;

export interface SandboxLifecycleServiceConfig {
  namespace: string;
  dataRoot?: string;
  port?: SandboxLifecycleKubernetesPort;
  runtimeDirectoryCleaner?: RuntimeDirectoryCleaner;
  now?: () => Date;
  deleteResourceErrorConfirmAttempts?: number;
  deleteResourceErrorConfirmDelayMs?: number;
  terminalFailureSync?: SandboxTerminalFailureSyncPort;
}

export interface SandboxTerminalFailureSyncPort {
  syncTerminalFailureRun(runId: string): Promise<SandboxTerminalFailureSyncResult>;
}

export type SandboxTerminalFailureSyncResult =
  | { status: "synced" }
  | { status: "unavailable"; message: string };

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

export interface RuntimeDirectoryCleaner {
  removeRuntimePath(absolutePath: string): Promise<void>;
}

export type SandboxRuntimeDirectoryName = "home" | "botified" | "artifacts";

export interface SandboxRuntimeDirectoryTarget {
  type: "runtime_directory";
  source: "runtime";
  runId: string;
  directory: SandboxRuntimeDirectoryName;
  path: string;
  action: "delete" | "retain";
  retention: "cleanup_candidate" | "durable";
  reason: string;
}

export type SandboxCleanupPlanTarget =
  | {
      type: "delete_resource";
      source: "kubernetes";
      runId: string;
      kind: string;
      name: string;
    }
  | {
      type: "store_run_state";
      source: "store";
      runId: string;
      reason: string;
      phase: string;
      cleanupStatus: string;
    }
  | SandboxRuntimeDirectoryTarget;

export interface SandboxRecentCleanupFailure {
  runId: string;
  at: string;
  target: string;
  message: string;
}

export interface SandboxCleanupPlan {
  targets: SandboxCleanupPlanTarget[];
  recentFailures: SandboxRecentCleanupFailure[];
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
  activeTaskCount: number;
  runCounts: SandboxLifecycleRunCounts;
  observedResourceCounts: Record<string, number>;
  cleanupPlan: SandboxCleanupPlan;
  recentCleanupFailures: SandboxRecentCleanupFailure[];
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
    const activeTaskCount = await this.activeTaskCount(scope);
    const observed = await this.observe(scope);
    const plan = this.plan(runs.activeRuns, observed.resources);
    const cleanupPlan = this.cleanupPlan(runs.activeRuns, plan.actions, runs.allRuns);
    return {
      namespace: this.config.namespace,
      activeTaskCount,
      runCounts: runCounts(runs.allRuns),
      observedResourceCounts: resourceCounts(observed.resources),
      cleanupPlan,
      recentCleanupFailures: cleanupPlan.recentFailures,
      actionSummary: plan.actions.map(actionSummary),
      errors: observed.errors
    };
  }

  async reapSandboxRunsOnce(input: SandboxReapInput = {}): Promise<SandboxReapResult> {
    const dryRun = input.apply === true && input.dryRun !== true ? false : true;
    const runs = await this.loadRuns(input);
    const activeTaskCount = await this.activeTaskCount(input);
    const observed = await this.observe(input);
    const plan = this.plan(runs.activeRuns, observed.resources);
    const cleanupPlan = this.cleanupPlan(runs.activeRuns, plan.actions, runs.allRuns);
    const result: SandboxReapResult = {
      namespace: this.config.namespace,
      activeTaskCount,
      runCounts: runCounts(runs.allRuns),
      observedResourceCounts: resourceCounts(observed.resources),
      cleanupPlan,
      recentCleanupFailures: cleanupPlan.recentFailures,
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

    const terminalFailureTransitionErrors = await this.persistTerminalFailureTransitions(plan.actions, result);
    if (terminalFailureTransitionErrors.length > 0) {
      result.errors.push(...terminalFailureTransitionErrors);
      return result;
    }

    const cleanupRuns = await this.loadRuns(input);
    const terminalFailureSyncErrors = await this.syncTerminalFailureRuns(cleanupRuns.activeRuns);
    if (terminalFailureSyncErrors.length > 0) {
      result.errors.push(...terminalFailureSyncErrors);
      return result;
    }
    const cleanupReconcilePlan = this.plan(cleanupRuns.activeRuns, observed.resources);
    result.cleanupPlan = this.cleanupPlan(cleanupRuns.activeRuns, cleanupReconcilePlan.actions, cleanupRuns.allRuns);
    result.recentCleanupFailures = result.cleanupPlan.recentFailures;
    if (plan.actions.some((action) => action.type === "store_run_state" && action.reason === "terminal_runner_failure")) {
      result.actionSummary.push(...cleanupReconcilePlan.actions.map(actionSummary));
    }
    const mutationErrors = await this.applyCleanupActions(this.config.port, cleanupReconcilePlan.actions);
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
    const finalRuns = await this.loadRuns(input);
    const finalPlan = this.plan(finalRuns.activeRuns, refreshed.resources);
    const finalCleanupPlan = this.cleanupPlan(finalRuns.activeRuns, finalPlan.actions, finalRuns.allRuns);
    result.cleanupPlan = finalCleanupPlan;
    result.recentCleanupFailures = finalCleanupPlan.recentFailures;
    result.actionSummary.push(...finalPlan.actions.map(actionSummary));
    for (const action of finalPlan.actions) {
      if (action.type !== "store_run_state") {
        continue;
      }
      if (action.reason === "cleanup_complete") {
        const cleanupError = await this.removeRuntimeCleanupCandidates(action.run);
        if (cleanupError) {
          result.errors.push(cleanupError.message);
          await this.persistCleanupFailure(action.run.runId, cleanupError.target, cleanupError.message);
          const afterFailureRuns = await this.loadRuns(input);
          result.runCounts = runCounts(afterFailureRuns.allRuns);
          const afterFailurePlan = this.cleanupPlan(afterFailureRuns.activeRuns, finalPlan.actions, afterFailureRuns.allRuns);
          result.cleanupPlan = afterFailurePlan;
          result.recentCleanupFailures = afterFailurePlan.recentFailures;
          return result;
        }
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

  private async activeTaskCount(scope: SandboxLifecycleScope): Promise<number> {
    const tasks = await this.store.listActiveTasks();
    if (!scope.runId) {
      return tasks.length;
    }
    return tasks.filter((task) => task.runId === scope.runId).length;
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
      namespace: this.config.namespace,
      desiredRuns: runs,
      observedResources,
      now: this.config.now?.() ?? new Date()
    });
  }

  private cleanupPlan(
    activeRuns: PersistedSandboxRunState[],
    actions: SandboxReconcileAction[],
    allRuns: PersistedSandboxRunState[]
  ): SandboxCleanupPlan {
    const targets: SandboxCleanupPlanTarget[] = actions.flatMap((action) => cleanupTargetsForAction(action));
    const runsById = new Map(activeRuns.map((run) => [run.runId, run]));
    const runtimeCleanupRunIds = new Set<string>();
    for (const action of actions) {
      if (action.type === "delete_resource") {
        runtimeCleanupRunIds.add(action.runId);
      }
      if (
        action.type === "store_run_state" &&
        (action.reason === "cleanup_in_progress" || action.reason === "cleanup_complete")
      ) {
        runtimeCleanupRunIds.add(action.run.runId);
      }
    }
    for (const runId of runtimeCleanupRunIds) {
      const run = runsById.get(runId);
      if (!run) {
        continue;
      }
      targets.push(...runtimeDirectoryTargets(run, this.config.dataRoot));
    }
    return {
      targets,
      recentFailures: recentCleanupFailures(allRuns)
    };
  }

  private async applyCleanupActions(
    port: SandboxLifecycleKubernetesPort,
    actions: SandboxReconcileAction[]
  ): Promise<string[]> {
    const errors: string[] = [];
    for (const action of actions) {
      if (action.type === "delete_resource") {
        let ref: KubernetesResourceRef;
        try {
          ref = resourceRef(action.resource);
        } catch (error) {
          errors.push(errorMessage(error));
          return errors;
        }
        try {
          const result = await port.deleteResource(ref, action.labels);
          if (result !== "fence_mismatch") {
            continue;
          }
          errors.push(`Kubernetes delete fence mismatch for ${action.kind}/${action.name}`);
        } catch (error) {
          if (await this.deleteTargetGoneOrTerminatingAfterFreshObserves(port, action)) {
            continue;
          }
          errors.push(errorMessage(error));
        }
        return errors;
      }
    }
    return errors;
  }

  private async deleteTargetGoneOrTerminatingAfterFreshObserves(
    port: SandboxLifecycleKubernetesPort,
    action: Extract<SandboxReconcileAction, { type: "delete_resource" }>
  ): Promise<boolean> {
    const attempts = resolveDeleteResourceErrorConfirmAttempts(this.config.deleteResourceErrorConfirmAttempts);
    const delayMs = resolveDeleteResourceErrorConfirmDelayMs(this.config.deleteResourceErrorConfirmDelayMs);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) {
        await sleep(delayMs);
      }
      try {
        const resources = await port.listManagedResources(this.config.namespace);
        const targetState = deleteTargetStateFromFreshObserve(resources, action);
        if (targetState === "gone_or_terminating") {
          return true;
        }
        if (targetState === "fence_mismatch") {
          return false;
        }
      } catch {
        return false;
      }
    }
    return false;
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

  private async persistTerminalFailureTransitions(
    actions: SandboxReconcileAction[],
    result: SandboxReapResult
  ): Promise<string[]> {
    const errors: string[] = [];
    for (const action of actions) {
      if (action.type !== "store_run_state" || action.reason !== "terminal_runner_failure") {
        continue;
      }
      const transition = await this.persistTerminalFailureTransition(action.run);
      if (transition === "conflict") {
        errors.push(`Sandbox run ${action.run.runId} fencing token changed before terminal failure could be stored`);
        continue;
      }
      if (transition !== "skipped") {
        result.storedRunIds.push(transition.stored.runId);
      }
    }
    return errors;
  }

  private async syncTerminalFailureRuns(runs: SandboxRunState[]): Promise<string[]> {
    for (const run of runs) {
      if (!run.terminalFailure) {
        continue;
      }
      const current = await this.store.sandboxRuns.get(run.runId);
      if (!current?.terminalFailure || !isActiveRun(current)) {
        continue;
      }
      if (current.terminalFailure.syncStatus === "synced" || current.terminalFailure.syncStatus === "unavailable") {
        await this.markTerminalFailureTaskFailed(current);
        continue;
      }
      let outcome: SandboxTerminalFailureSyncResult;
      try {
        outcome = await this.config.terminalFailureSync?.syncTerminalFailureRun(run.runId) ?? { status: "synced" };
      } catch (error) {
        outcome = { status: "unavailable", message: errorMessage(error) };
      }
      const settlement = await this.persistTerminalFailureSyncOutcome(current.runId, outcome);
      if (settlement === "conflict") {
        return [`Sandbox run ${current.runId} fencing token changed before terminal failure sync could be stored`];
      }
      if (settlement === "skipped") {
        continue;
      }
      if (settlement.waiting) {
        return [settlement.error];
      }
      await this.markTerminalFailureTaskFailed(settlement.run);
    }
    return [];
  }

  private async persistTerminalFailureSyncOutcome(
    runId: string,
    outcome: SandboxTerminalFailureSyncResult
  ): Promise<{ run: PersistedSandboxRunState; waiting: boolean; error: string } | "skipped" | "conflict"> {
    for (let attempt = 0; attempt < TERMINAL_FAILURE_TRANSITION_ATTEMPTS; attempt += 1) {
      const current = await this.store.sandboxRuns.get(runId);
      if (!current?.terminalFailure || !isActiveRun(current)) {
        return "skipped";
      }
      if (current.terminalFailure.syncStatus === "synced" || current.terminalFailure.syncStatus === "unavailable") {
        return { run: current, waiting: false, error: "" };
      }
      const syncAttempts = (current.terminalFailure.syncAttempts ?? 0) + 1;
      const unavailable = outcome.status === "unavailable";
      const waiting = unavailable && syncAttempts < MAX_TERMINAL_FAILURE_SYNC_ATTEMPTS;
      const error = unavailable ? sanitizeCleanupError(outcome.message) : "";
      const now = (this.config.now?.() ?? new Date()).toISOString();
      const terminalFailure: PersistedSandboxTerminalFailure = {
        ...current.terminalFailure,
        syncAttempts,
        syncStatus: unavailable ? (waiting ? "pending" : "unavailable") : "synced",
        lastSyncAt: now,
        lastSyncError: unavailable ? error : null
      };
      const stored = await this.store.sandboxRuns.updateWithFencing(runId, current.fencingToken, {
        ...current,
        terminalFailure,
        fencingToken: current.fencingToken + 1,
        updatedAt: now
      });
      if (stored) {
        return { run: stored, waiting, error };
      }
    }
    return "conflict";
  }

  private async markTerminalFailureTaskFailed(run: PersistedSandboxRunState): Promise<void> {
    await this.store.updateTaskStatusIfNonterminal(
      run.taskId,
      "failed",
      (this.config.now?.() ?? new Date()).toISOString()
    );
  }

  private async persistTerminalFailureTransition(
    actionRun: SandboxRunState
  ): Promise<{ previous: PersistedSandboxRunState; stored: PersistedSandboxRunState } | "skipped" | "conflict"> {
    if (!actionRun.terminalFailure) {
      return "skipped";
    }
    for (let attempt = 0; attempt < TERMINAL_FAILURE_TRANSITION_ATTEMPTS; attempt += 1) {
      const current = await this.store.sandboxRuns.get(actionRun.runId);
      if (!current || !isTerminalFailureEligibleRun(current)) {
        return "skipped";
      }
      const now = (this.config.now?.() ?? new Date()).toISOString();
      const stored = await this.store.sandboxRuns.updateWithFencing(actionRun.runId, current.fencingToken, {
        ...current,
        phase: "stopping",
        cleanupStatus: "cleanup_requested",
        terminalFailure: structuredClone(actionRun.terminalFailure),
        fencingToken: current.fencingToken + 1,
        updatedAt: now
      });
      if (stored) {
        return { previous: current, stored };
      }
    }
    return "conflict";
  }

  private async removeRuntimeCleanupCandidates(run: SandboxRunState): Promise<{ target: string; message: string } | null> {
    const cleaner = this.config.runtimeDirectoryCleaner ?? defaultRuntimeDirectoryCleaner;
    for (const directory of runtimeDirectoryTargets(run, this.config.dataRoot)) {
      if (directory.action !== "delete") {
        continue;
      }
      const target = `runtime_directory:${directory.directory}`;
      try {
        const absolutePath = await this.resolveRuntimeCleanupPath(directory.path);
        await cleaner.removeRuntimePath(absolutePath);
      } catch (error) {
        return {
          target,
          message: sanitizeCleanupError(errorMessage(error))
        };
      }
    }
    return null;
  }

  private async resolveRuntimeCleanupPath(runtimePath: string): Promise<string> {
    if (!this.config.dataRoot) {
      throw new ProductError("Sandbox lifecycle dataRoot is not configured", 409);
    }
    return assertRuntimePathInsideDataRoot(this.config.dataRoot, runtimePath);
  }

  private async persistCleanupFailure(runId: string, target: string, message: string): Promise<void> {
    const current = await this.store.sandboxRuns.get(runId);
    if (!current) {
      return;
    }
    const now = (this.config.now?.() ?? new Date()).toISOString();
    await this.store.sandboxRuns.updateWithFencing(runId, current.fencingToken, {
      ...current,
      cleanupAttempts: (current.cleanupAttempts ?? 0) + 1,
      lastCleanupAt: now,
      lastCleanupError: {
        at: now,
        target,
        message: sanitizeCleanupError(message)
      },
      fencingToken: current.fencingToken + 1,
      updatedAt: now
    });
  }

  private async advanceTaskAfterRunTransition(
    previous: PersistedSandboxRunState,
    stored: PersistedSandboxRunState
  ): Promise<void> {
    const task = await this.store.findTask(stored.taskId);
    if (!task || isTerminalTaskStatus(task.status)) {
      return;
    }
    const now = this.config.now?.() ?? new Date();
    if (stored.cleanupStatus !== "cleaned" && stored.phase !== "cleaned") {
      return;
    }
    const status: AgentTaskStatus = runWasExpired(previous, now) ? "expired" : "cleaned";
    await this.store.updateTaskStatusIfNonterminal(stored.taskId, status, now.toISOString());
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

function isTerminalFailureEligibleRun(run: PersistedSandboxRunState): boolean {
  return run.cleanupStatus === "active" && (run.phase === "queued" || run.phase === "starting" || run.phase === "running");
}

const defaultRuntimeDirectoryCleaner: RuntimeDirectoryCleaner = {
  async removeRuntimePath(absolutePath: string): Promise<void> {
    await rm(absolutePath, { recursive: true, force: true });
  }
};

function cleanupTargetsForAction(action: SandboxReconcileAction): SandboxCleanupPlanTarget[] {
  switch (action.type) {
    case "delete_resource":
      return [{
        type: "delete_resource",
        source: "kubernetes",
        runId: action.runId,
        kind: action.kind,
        name: action.name
      }];
    case "store_run_state":
      return [{
        type: "store_run_state",
        source: "store",
        runId: action.run.runId,
        reason: action.reason,
        phase: action.run.phase,
        cleanupStatus: action.run.cleanupStatus
      }];
    case "create_resource":
    case "adopt_resource":
      return [];
  }
}

function runtimeDirectoryTargets(run: PersistedSandboxRunState, dataRoot?: string): SandboxRuntimeDirectoryTarget[] {
  const paths = runtimeDirectoryPaths(run, dataRoot);
  return [
    runtimeDirectoryTarget(run, "home", paths.home, "delete", "cleanup_candidate"),
    runtimeDirectoryTarget(run, "botified", paths.botified, "delete", "cleanup_candidate"),
    runtimeDirectoryTarget(run, "artifacts", paths.artifacts, "retain", "durable")
  ];
}

function runtimeDirectoryPaths(
  run: PersistedSandboxRunState,
  dataRoot?: string
): Record<SandboxRuntimeDirectoryName, string> {
  if (!dataRoot) {
    return {
      home: run.directories.taskHome,
      botified: run.directories.botified,
      artifacts: run.directories.artifacts
    };
  }
  const taskRoot = path.resolve(dataRoot, run.projectSubPath, "tasks", run.taskId);
  return {
    home: path.resolve(taskRoot, "home"),
    botified: path.resolve(taskRoot, "botified"),
    artifacts: path.resolve(taskRoot, "artifacts")
  };
}

function runtimeDirectoryTarget(
  run: PersistedSandboxRunState,
  directory: SandboxRuntimeDirectoryName,
  directoryPath: string,
  action: "delete" | "retain",
  retention: "cleanup_candidate" | "durable"
): SandboxRuntimeDirectoryTarget {
  return {
    type: "runtime_directory",
    source: "runtime",
    runId: run.runId,
    directory,
    path: directoryPath,
    action,
    retention,
    reason: action === "delete" ? "runtime_cleanup_candidate" : "durable_artifacts_retained"
  };
}

function recentCleanupFailures(runs: PersistedSandboxRunState[]): SandboxRecentCleanupFailure[] {
  return runs
    .flatMap((run) => {
      if (!run.lastCleanupError) {
        return [];
      }
      return [{
        runId: run.runId,
        at: run.lastCleanupError.at,
        target: run.lastCleanupError.target,
        message: sanitizeCleanupError(run.lastCleanupError.message)
      }];
    })
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, 10);
}

async function assertRuntimePathInsideDataRoot(dataRoot: string, runtimePath: string): Promise<string> {
  const root = path.resolve(dataRoot);
  const absolutePath = path.resolve(runtimePath);
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ProductError("Runtime directory is outside the data root", 409);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if (isNotFound(error)) {
      return absolutePath;
    }
    throw error;
  }

  const canonicalPath = path.resolve(canonicalRoot, relative);
  const parentRelative = path.dirname(relative);
  let expectedParent = canonicalRoot;
  for (const segment of parentRelative.split(path.sep)) {
    if (!segment || segment === ".") {
      continue;
    }
    expectedParent = path.join(expectedParent, segment);
    try {
      const parentStat = await lstat(expectedParent);
      if (parentStat.isSymbolicLink() || await realpath(expectedParent) !== expectedParent) {
        throw new ProductError("Runtime directory parent uses a symlink", 409);
      }
    } catch (error) {
      if (isNotFound(error)) {
        return canonicalPath;
      }
      throw error;
    }
  }
  return canonicalPath;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sanitizeCleanupError(message: string): string {
  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(
      /\b([A-Za-z0-9_-]*?(?:API[-_]?KEY|TOKEN|PASSWORD|PASSWD|SECRET))\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=<redacted>"
    )
    .replace(/\bbsk_[A-Za-z0-9_-]+/g, "<redacted>")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]*/g, "<redacted>")
    .replace(/\bMODEL_API_KEY\b(?!\s*(?:=|:))/g, "<redacted>")
    .slice(0, 300);
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

type DeleteTargetFreshObserveState = "gone_or_terminating" | "active" | "fence_mismatch";

function deleteTargetStateFromFreshObserve(
  resources: KubernetesResource[],
  action: Extract<SandboxReconcileAction, { type: "delete_resource" }>
): DeleteTargetFreshObserveState {
  const namespace = action.resource.metadata.namespace;
  if (!namespace) {
    return "fence_mismatch";
  }
  const matchingRefs = resources.filter((resource) => isSameDeleteActionRef(resource, action, namespace));
  if (matchingRefs.length === 0) {
    return "gone_or_terminating";
  }
  const actionUid = deleteActionUid(action);
  for (const resource of matchingRefs) {
    if (!hasLabelValues(resource.metadata.labels, action.labels)) {
      return "fence_mismatch";
    }
    if (actionUid && resourceUid(resource) !== actionUid) {
      return "fence_mismatch";
    }
    if (!hasDeletionTimestamp(resource)) {
      return "active";
    }
  }
  return "gone_or_terminating";
}

function isSameDeleteActionRef(
  resource: KubernetesResource,
  action: Extract<SandboxReconcileAction, { type: "delete_resource" }>,
  namespace: string
): boolean {
  return (
    resource.kind === action.kind &&
    resource.metadata.name === action.name &&
    resource.metadata.namespace === namespace
  );
}

function hasLabelValues(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function hasDeletionTimestamp(resource: KubernetesResource): boolean {
  const value = resource.metadata.deletionTimestamp;
  return typeof value === "string" && value.length > 0;
}

function deleteActionUid(action: Extract<SandboxReconcileAction, { type: "delete_resource" }>): string | null {
  return resourceUid(action.resource);
}

function resourceUid(resource: KubernetesResource): string | null {
  const value = resource.metadata.uid;
  return typeof value === "string" && value.length > 0 ? value : null;
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
    name: resource.metadata.name,
    labels: { ...resource.metadata.labels },
    ...(typeof resource.metadata.uid === "string" ? { uid: resource.metadata.uid } : {})
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

function resolveDeleteResourceErrorConfirmAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_DELETE_RESOURCE_ERROR_CONFIRM_ATTEMPTS;
  }
  return Math.min(MAX_DELETE_RESOURCE_ERROR_CONFIRM_ATTEMPTS, Math.max(1, Math.floor(value)));
}

function resolveDeleteResourceErrorConfirmDelayMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_DELETE_RESOURCE_ERROR_CONFIRM_DELAY_MS;
  }
  return Math.max(0, Math.floor(value));
}

async function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
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
