import type { SandboxReapInput, SandboxReapResult } from "./sandboxLifecycleService.js";
import type { ActiveTaskSyncResult } from "./taskService.js";

export const DEFAULT_RUNTIME_TICK_INTERVAL_MS = 5000;

export interface RuntimeTaskServicePort {
  syncActiveTasksOnce(): Promise<ActiveTaskSyncResult>;
}

export interface RuntimeSandboxLifecyclePort {
  reapSandboxRunsOnce(input: SandboxReapInput): Promise<SandboxReapResult>;
}

export type RuntimeTimerHandle = { unref?: () => void } | number | string;

export interface RuntimeServiceConfig {
  tickIntervalMs?: number;
  setInterval?: (callback: () => void, intervalMs: number) => RuntimeTimerHandle;
  clearInterval?: (timer: RuntimeTimerHandle) => void;
}

export interface RuntimeTickResult {
  taskSync: ActiveTaskSyncResult;
  sandboxReap: SandboxReapResult;
}

export class RuntimeService {
  private timer: RuntimeTimerHandle | null = null;
  private tickInFlight: Promise<unknown> | null = null;

  constructor(
    private readonly tasks: RuntimeTaskServicePort,
    private readonly sandboxLifecycle: RuntimeSandboxLifecyclePort,
    private readonly config: RuntimeServiceConfig = {}
  ) {}

  async tickOnce(): Promise<RuntimeTickResult> {
    let taskSync: ActiveTaskSyncResult;
    let taskSyncError: unknown;
    try {
      taskSync = await this.tasks.syncActiveTasksOnce();
    } catch (error) {
      taskSyncError = error;
      taskSync = {
        activeTaskCount: 0,
        syncedTaskIds: [],
        failedTaskIds: []
      };
    }

    const sandboxReap = await this.sandboxLifecycle.reapSandboxRunsOnce({ apply: true });
    if (taskSyncError !== undefined) {
      throw taskSyncError;
    }
    return { taskSync, sandboxReap };
  }

  startLoop(): void {
    if (this.timer !== null) {
      return;
    }
    const intervalMs = resolveTickIntervalMs(this.config.tickIntervalMs);
    const setTimer = this.config.setInterval ?? defaultSetInterval;
    const timer = setTimer(() => {
      this.runScheduledTick();
    }, intervalMs);
    timerHasUnref(timer)?.unref?.();
    this.timer = timer;
    this.runScheduledTick();
  }

  stopLoop(): void {
    if (this.timer === null) {
      return;
    }
    const clearTimer = this.config.clearInterval ?? defaultClearInterval;
    clearTimer(this.timer);
    this.timer = null;
  }

  private runScheduledTick(): void {
    if (this.tickInFlight !== null) {
      return;
    }
    this.tickInFlight = this.tickOnce()
      .catch(() => undefined)
      .finally(() => {
        this.tickInFlight = null;
      });
  }
}

function defaultSetInterval(callback: () => void, intervalMs: number): RuntimeTimerHandle {
  return setInterval(callback, intervalMs);
}

function defaultClearInterval(timer: RuntimeTimerHandle): void {
  clearInterval(timer as ReturnType<typeof setInterval>);
}

function timerHasUnref(timer: RuntimeTimerHandle): { unref?: () => void } | null {
  return typeof timer === "object" && timer !== null ? timer : null;
}

function resolveTickIntervalMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_RUNTIME_TICK_INTERVAL_MS;
  }
  return Math.max(1, Math.floor(value));
}
