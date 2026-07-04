import { randomBytes } from "node:crypto";
import path from "node:path";
import { projectBotifiedTimelineEvents, type BotifiedTimelineEvent } from "../../botified-runtime/src/projection.js";
import type { AgentTask, AgentTaskArtifact, AgentTaskEvent, AgentTaskStatus, CreateTaskInput } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { requireNonEmptyString } from "../../domain/src/validation.js";
import { BotifiedHttpError, type BotifiedRuntimeHttpClient } from "../../ports/src/botified.js";
import type { ProductStore } from "../../ports/src/store.js";
import { renderSandboxResources } from "../../sandbox-controller/src/manifestRenderer.js";
import { EndpointService } from "./endpointService.js";
import { WorkspaceService } from "./workspaceService.js";

export interface TaskServiceConfig {
  namespace: string;
  pvcName: string;
  botifiedRunnerImage: string;
  botifiedPort?: number;
  botifiedServiceKeyFactory?: () => string | undefined;
  botifiedBaseUrlForTask?: (input: BotifiedTaskAddressInput) => string;
}

export interface BotifiedTaskAddressInput {
  namespace: string;
  taskId: string;
  port: number;
}

interface BotifiedTaskRuntimeState {
  baseUrl: string;
  serviceKey: string;
  timelineCursor?: string;
  postMessageCursor?: string;
  lastSyncedAt?: string;
}

type BotifiedOperation = "send message" | "read timeline" | "abort";

export class BotifiedTaskPortError extends ProductError {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(operation: BotifiedOperation, error: unknown) {
    if (error instanceof BotifiedHttpError) {
      super(`Botified ${operation} failed: ${error.message}`, error.status);
      this.code = error.code;
      this.retryable = error.retryable;
      this.details = {};
      if (error.timelineCursor !== undefined) {
        this.details.timelineCursor = error.timelineCursor;
      }
      if (error.historyBoundary !== undefined) {
        this.details.historyBoundary = error.historyBoundary;
      }
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown Botified error";
    super(`Botified ${operation} failed: ${message}`, 502);
    this.code = `botified_${operation.replace(/\s+/g, "_")}_failed`;
    this.retryable = true;
    this.details = {};
  }
}

export class TaskService {
  constructor(
    private readonly store: ProductStore,
    private readonly workspaces: WorkspaceService,
    private readonly endpoints: EndpointService,
    private readonly botified: BotifiedRuntimeHttpClient,
    private readonly config: TaskServiceConfig
  ) {}

  async createTask(userId: string, projectId: string, input: CreateTaskInput): Promise<AgentTask> {
    const endpointId = requireNonEmptyString(input.endpointId, "task.endpointId");
    const prompt = requireNonEmptyString(input.prompt, "task.prompt");
    const project = await this.workspaces.requireProjectForUser(userId, projectId);
    await this.endpoints.requireEndpointForProject(projectId, endpointId);
    const active = (await this.store.listTasksForProject(projectId)).filter((task) =>
      ["queued", "starting", "running", "stopping"].includes(task.status)
    );
    if (active.length >= project.taskConcurrencyLimit) {
      throw new ProductError("Project concurrent task limit reached", 409);
    }

    const id = newId("task");
    const runId = newId("run");
    const timestamp = nowIso();
    const botifiedPort = this.config.botifiedPort ?? 3099;
    const serviceKey = this.generateServiceKey();
    requireBotifiedServiceKey(serviceKey);
    const sandbox = renderSandboxResources({
      namespace: this.config.namespace,
      workspaceId: project.workspaceId,
      projectId,
      taskId: id,
      runId,
      image: this.config.botifiedRunnerImage,
      pvcName: this.config.pvcName,
      projectSubPath: project.rootPath,
      botifiedPort,
      serviceKeySecretName: `asl-botified-${id}`,
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    });

    const task = await this.store.createTask({
      id,
      workspaceId: project.workspaceId,
      projectId,
      endpointId,
      prompt,
      status: "starting",
      runId,
      sandbox,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const state: BotifiedTaskRuntimeState = {
      baseUrl: this.botifiedBaseUrlForTask(id, botifiedPort),
      serviceKey
    };
    await this.writeRuntimeState(id, state);

    const posted = await this.callBotified("send message", () =>
      this.botified.postMessage(state.baseUrl, state.serviceKey, prompt)
    );
    if (!posted.accepted) {
      throw new ProductError("Botified did not accept task prompt", 502);
    }
    await this.writeRuntimeState(id, {
      ...state,
      ...(posted.cursor !== undefined ? { postMessageCursor: posted.cursor } : {})
    });
    const running = await this.store.updateTask({ ...task, status: "running", updatedAt: nowIso() });
    return this.syncTaskTimeline(running);
  }

  async listTasks(userId: string, projectId: string): Promise<AgentTask[]> {
    await this.workspaces.requireProjectForUser(userId, projectId);
    return this.store.listTasksForProject(projectId);
  }

  async cancelTask(userId: string, taskId: string): Promise<AgentTask> {
    const task = await this.requireTaskForUser(userId, taskId);
    const state = await this.readRuntimeState(task.id);
    await this.callBotified("abort", () => this.botified.abort(state.baseUrl, state.serviceKey));
    const updated = { ...task, status: "stopping" as const, updatedAt: nowIso() };
    return this.store.updateTask(updated);
  }

  async listTaskEvents(userId: string, taskId: string): Promise<AgentTaskEvent[]> {
    const task = await this.requireTaskForUser(userId, taskId);
    await this.syncTaskTimeline(task);
    return this.store.listTaskEvents(taskId);
  }

  async listTaskArtifacts(userId: string, taskId: string): Promise<AgentTaskArtifact[]> {
    const task = await this.requireTaskForUser(userId, taskId);
    await this.syncTaskTimeline(task);
    return this.store.listTaskArtifacts(taskId);
  }

  taskRuntimePaths(task: AgentTask): { projectMountPath: string; taskHomePath: string; botifiedDataPath: string; artifactPath: string } {
    const projectMountPath = "/workspace/project";
    const taskBase = path.posix.join(projectMountPath, "tasks", task.id);
    return {
      projectMountPath,
      taskHomePath: path.posix.join(taskBase, "home"),
      botifiedDataPath: path.posix.join(taskBase, "botified"),
      artifactPath: path.posix.join(taskBase, "artifacts")
    };
  }

  private async requireTaskForUser(userId: string, taskId: string): Promise<AgentTask> {
    const task = await this.store.findTask(taskId);
    if (!task) {
      throw new ProductError("Task not found", 404);
    }
    await this.workspaces.requireProjectForUser(userId, task.projectId);
    return task;
  }

  private async syncTaskTimeline(task: AgentTask): Promise<AgentTask> {
    const state = await this.readRuntimeState(task.id);
    const existing = await this.store.listTaskEvents(task.id);
    const existingSeqs = new Set(existing.map((event) => event.botifiedSeq));
    const timeline = await this.callBotified("read timeline", () =>
      this.botified.readTimeline(state.baseUrl, state.serviceKey, state.timelineCursor)
    );
    const projection = projectBotifiedTimelineEvents(task.id, timelineEvents(timeline.events), existingSeqs);

    if (projection.events.length > 0) {
      await this.store.appendTaskEvents(projection.events);
    }
    if (projection.artifacts.length > 0) {
      await this.store.appendTaskArtifacts(projection.artifacts);
    }

    const nextCursor = timeline.nextCursor ?? projection.nextCursor ?? state.timelineCursor;
    await this.writeRuntimeState(task.id, {
      ...state,
      ...(nextCursor !== undefined ? { timelineCursor: nextCursor } : {}),
      lastSyncedAt: nowIso()
    });

    return this.updateTaskStatusFromEvents(task, projection.events);
  }

  private async updateTaskStatusFromEvents(task: AgentTask, events: AgentTaskEvent[]): Promise<AgentTask> {
    const status = nextStatusForEvents(task.status, events);
    if (status === task.status) {
      return task;
    }
    return this.store.updateTask({ ...task, status, updatedAt: nowIso() });
  }

  private async readRuntimeState(taskId: string): Promise<BotifiedTaskRuntimeState> {
    const document = await this.store.jsonDocs.get("sandbox_runtime_state", taskId);
    if (!document) {
      throw new ProductError("Task runtime state not found", 409);
    }
    const baseUrl = stringDocumentField(document, "botifiedBaseUrl");
    const serviceKey = stringDocumentField(document, "serviceKey");
    requireBotifiedServiceKey(serviceKey);
    const state: BotifiedTaskRuntimeState = { baseUrl, serviceKey };
    const timelineCursor = optionalStringDocumentField(document, "timelineCursor");
    const postMessageCursor = optionalStringDocumentField(document, "postMessageCursor");
    const lastSyncedAt = optionalStringDocumentField(document, "lastSyncedAt");
    if (timelineCursor !== undefined) {
      state.timelineCursor = timelineCursor;
    }
    if (postMessageCursor !== undefined) {
      state.postMessageCursor = postMessageCursor;
    }
    if (lastSyncedAt !== undefined) {
      state.lastSyncedAt = lastSyncedAt;
    }
    return state;
  }

  private async writeRuntimeState(taskId: string, state: BotifiedTaskRuntimeState): Promise<void> {
    requireBotifiedServiceKey(state.serviceKey);
    const document: Record<string, unknown> = {
      botifiedBaseUrl: state.baseUrl,
      serviceKey: state.serviceKey
    };
    if (state.timelineCursor !== undefined) {
      document.timelineCursor = state.timelineCursor;
    }
    if (state.postMessageCursor !== undefined) {
      document.postMessageCursor = state.postMessageCursor;
    }
    if (state.lastSyncedAt !== undefined) {
      document.lastSyncedAt = state.lastSyncedAt;
    }
    await this.store.jsonDocs.put("sandbox_runtime_state", taskId, document);
  }

  private generateServiceKey(): string | undefined {
    return (this.config.botifiedServiceKeyFactory ?? createBotifiedServiceKey)();
  }

  private botifiedBaseUrlForTask(taskId: string, port: number): string {
    const input = { namespace: this.config.namespace, taskId, port };
    return (this.config.botifiedBaseUrlForTask ?? defaultBotifiedBaseUrlForTask)(input);
  }

  private async callBotified<T>(operation: BotifiedOperation, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw new BotifiedTaskPortError(operation, error);
    }
  }
}

function createBotifiedServiceKey(): string {
  return `bsk_${randomBytes(32).toString("base64url")}`;
}

function defaultBotifiedBaseUrlForTask(input: BotifiedTaskAddressInput): string {
  return `http://asl-task-${input.taskId}.${input.namespace}.svc.cluster.local:${input.port}`;
}

function requireBotifiedServiceKey(serviceKey: string | undefined): asserts serviceKey is string {
  if (serviceKey === undefined || serviceKey.trim() === "") {
    throw new ProductError("Botified service key is required", 500);
  }
}

function timelineEvents(events: unknown[]): BotifiedTimelineEvent[] {
  return events.filter((event): event is BotifiedTimelineEvent => Boolean(event) && typeof event === "object" && !Array.isArray(event));
}

function nextStatusForEvents(current: AgentTaskStatus, events: AgentTaskEvent[]): AgentTaskStatus {
  let status = current;
  for (const event of events) {
    if (event.kind === "turn_failed" || event.kind === "runtime_error") {
      status = "failed";
      continue;
    }
    if (status !== "failed" && event.kind === "turn_completed") {
      status = "completed";
      continue;
    }
    if ((status === "queued" || status === "starting") && event.kind !== "diagnostic") {
      status = "running";
    }
  }
  return status;
}

function stringDocumentField(document: Record<string, unknown>, field: string): string {
  const value = document[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProductError(`Task runtime state is missing ${field}`, 409);
  }
  return value;
}

function optionalStringDocumentField(document: Record<string, unknown>, field: string): string | undefined {
  const value = document[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
