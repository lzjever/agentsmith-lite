import { createHmac } from "node:crypto";
import { chmod, chown, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateBotifiedConfig, serializeBotifiedConfig } from "../../botified-runtime/src/config.js";
import { projectBotifiedTimelineEvents, type BotifiedTimelineEvent } from "../../botified-runtime/src/projection.js";
import { isSecretLikeText, redactSecretLikeText } from "../../botified-runtime/src/redaction.js";
import type { AgentTask, AgentTaskArtifact, AgentTaskEvent, AgentTaskStatus, CreateTaskInput, KubernetesResource, ModelEndpoint } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../domain/src/sandboxDefaults.js";
import { requireNonEmptyString, requirePositiveInteger } from "../../domain/src/validation.js";
import { normalizeOpenAICompatibleBaseUrl, type ModelCredentialResolver } from "../../openai-compatible-client/src/index.js";
import { BotifiedHttpError, type BotifiedRuntimeHttpClient, type BotifiedRuntimeStateResult } from "../../ports/src/botified.js";
import type { PersistedSandboxRunState, ProductStore } from "../../ports/src/store.js";
import {
  applySandboxReconcileActionsToKubernetes,
  type SandboxKubernetesMutationPort,
  type SandboxKubernetesReadinessPort
} from "../../sandbox-controller/src/kubernetesPort.js";
import { renderSandboxResources } from "../../sandbox-controller/src/manifestRenderer.js";
import {
  reconcileSandboxRuns,
  type SandboxReconcileAction,
  type SandboxRunState
} from "../../sandbox-controller/src/reconciler.js";
import { EndpointService } from "./endpointService.js";
import {
  DEFAULT_SANDBOX_RUN_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_RUN_MAX_LIFETIME_MS,
  refreshSandboxRunActivity,
  requestSandboxRunCleanup,
  type SandboxKubernetesInventoryPort,
  type SandboxLifecycleService
} from "./sandboxLifecycleService.js";
import { WorkspaceService } from "./workspaceService.js";

export interface TaskLiveSandboxConfig {
  port: SandboxKubernetesMutationPort & SandboxKubernetesReadinessPort & SandboxKubernetesInventoryPort;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ModelCaReference {
  configMapName: string;
  configMapKey: string;
  path: string;
}

export interface BotifiedServiceKeyInput {
  namespace: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  runId: string;
}

export interface TaskServiceConfig {
  dataRoot: string;
  namespace: string;
  pvcName: string;
  botifiedRunnerImage: string;
  botifiedPort?: number;
  botifiedServiceKeySecret?: string;
  botifiedServiceKeyFactory?: (input: BotifiedServiceKeyInput) => string | undefined;
  botifiedBaseUrlForTask?: (input: BotifiedTaskAddressInput) => string;
  liveSandbox?: TaskLiveSandboxConfig;
  sandboxNamespaceLimit?: number;
  liveSandboxMaxLifetimeMs?: number;
  liveSandboxIdleTimeoutMs?: number;
  modelCredentialResolver?: ModelCredentialResolver;
  modelCa?: ModelCaReference;
  sandboxLifecycle?: SandboxLifecycleService;
}

export interface BotifiedTaskAddressInput {
  namespace: string;
  taskId: string;
  port: number;
}

interface BotifiedTaskRuntimeState {
  baseUrl: string;
  timelineCursor?: string;
  lastSyncedAt?: string;
}

type BotifiedOperation = "send message" | "read state" | "read timeline" | "download file" | "abort";

export interface TaskArtifactDownload {
  artifact: AgentTaskArtifact;
  bytes: Buffer;
}

const BOTIFIED_RUNNER_UID = 10001;
const BOTIFIED_RUNNER_GID = 10001;
const BOTIFIED_RUNNER_DIRECTORY_MODE = 0o775;
const BOTIFIED_RUNNER_FALLBACK_DIRECTORY_MODE = 0o777;
const API_OWNED_ARTIFACT_DIRECTORY_MODE = 0o755;

function requireTaskEndpointToolCalls(endpoint: ModelEndpoint): void {
  if (!endpoint.capabilities.includes("tool_calls")) {
    throw new ProductError("Task endpoint must support the tool_calls capability for Botified tool execution", 409);
  }
}

export interface ActiveTaskSyncResult {
  activeTaskCount: number;
  syncedTaskIds: string[];
  failedTaskIds: string[];
}

export class BotifiedTaskPortError extends ProductError {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(operation: BotifiedOperation, error: unknown) {
    if (error instanceof BotifiedHttpError) {
      super(`Botified ${operation} failed: ${redactSecretLikeText(error.message)}`, error.status);
      this.code = error.code;
      this.retryable = error.retryable;
      this.details = {};
      if (error.timelineCursor !== undefined) {
        this.details.timelineCursor = redactSecretLikeText(error.timelineCursor);
      }
      if (error.historyBoundary !== undefined) {
        this.details.historyBoundary = redactSecretLikeText(error.historyBoundary);
      }
      return;
    }

    const message = error instanceof Error ? redactSecretLikeText(error.message) : "Unknown Botified error";
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
    const endpoint = await this.endpoints.requireEndpointForProject(projectId, endpointId);
    requireTaskEndpointToolCalls(endpoint);
    const active = (await this.store.listTasksForProject(projectId)).filter((task) =>
      ["queued", "starting", "running", "stopping"].includes(task.status)
    );
    if (active.length >= project.taskConcurrencyLimit) {
      throw new ProductError("Project concurrent task limit reached", 409);
    }
    if (this.config.liveSandbox) {
      await this.requireNamespaceSandboxCapacity();
    }

    const liveCredential = this.config.liveSandbox ? this.resolveLiveModelCredential(endpoint) : null;
    const id = newId("task");
    const runId = newId("run");
    const timestamp = nowIso();
    const botifiedPort = this.config.botifiedPort ?? 3099;
    const serviceKey = this.generateServiceKey({
      namespace: this.config.namespace,
      workspaceId: project.workspaceId,
      projectId,
      taskId: id,
      runId
    });
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
      modelApiKeySecretKey: "MODEL_API_KEY",
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi",
      ...(this.config.modelCa ? { modelCa: this.config.modelCa } : {})
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
      baseUrl: this.botifiedBaseUrlForTask(id, botifiedPort)
    };
    const liveRun = this.config.liveSandbox
      ? this.buildLiveSandboxRun({
          task,
          timestamp,
          botifiedPort,
          projectSubPath: project.rootPath,
          serviceKeySecretName: `asl-botified-${id}`
        })
      : null;

    let acceptedPrompt = false;
    try {
      if (liveRun) {
        await this.store.sandboxRuns.put(liveRun);
      }
      await this.writeRuntimeState(id, state);
      if (this.config.liveSandbox && liveRun && liveCredential) {
        await this.startLiveSandbox({
          endpoint,
          task,
          run: liveRun,
          serviceKey,
          modelApiKey: liveCredential.apiKey
        });
      }

      const posted = await this.callBotified("send message", () =>
        this.botified.postMessage(state.baseUrl, serviceKey, prompt)
      );
      if (!posted.accepted) {
        throw new ProductError("Botified did not accept task prompt", 502);
      }
      acceptedPrompt = true;
      const timelineCursor = safeRuntimeCursor(posted.cursor);
      await this.writeRuntimeState(id, {
        ...state,
        ...(timelineCursor !== undefined ? { timelineCursor } : {})
      });
      if (liveRun) {
        await this.updatePersistedRun(liveRun.runId, { phase: "running", cleanupStatus: "active" });
      }
      const running = await this.store.updateTask({ ...task, status: "running", updatedAt: nowIso() });
      return this.syncTaskTimeline(running);
    } catch (error) {
      if (!acceptedPrompt) {
        await this.bestEffortMarkTaskFailed(task);
        if (liveRun) {
          await this.bestEffortRequestRunCleanup(liveRun.runId, "stopping");
          await this.bestEffortReapSandboxRun(liveRun.runId);
        }
      }
      throw error;
    }
  }

  async listTasks(userId: string, projectId: string): Promise<AgentTask[]> {
    await this.workspaces.requireProjectForUser(userId, projectId);
    return this.store.listTasksForProject(projectId);
  }

  async syncActiveTasksOnce(): Promise<ActiveTaskSyncResult> {
    const activeTasks = await this.store.listActiveTasks();
    const result: ActiveTaskSyncResult = {
      activeTaskCount: activeTasks.length,
      syncedTaskIds: [],
      failedTaskIds: []
    };
    for (const task of activeTasks) {
      try {
        await this.syncTaskTimeline(task);
        result.syncedTaskIds.push(task.id);
      } catch {
        result.failedTaskIds.push(task.id);
      }
    }
    return result;
  }

  async cancelTask(userId: string, taskId: string): Promise<AgentTask> {
    const task = await this.requireTaskForUser(userId, taskId);
    const serviceKey = this.serviceKeyForTask(task);
    const state = await this.readRuntimeState(task, serviceKey);
    await this.callBotified("abort", () => this.botified.abort(state.baseUrl, serviceKey));
    const updated = { ...task, status: "stopping" as const, updatedAt: nowIso() };
    const saved = await this.store.updateTask(updated);
    await this.bestEffortRequestRunCleanup(task.runId, "stopping");
    await this.bestEffortReapSandboxRun(task.runId);
    return saved;
  }

  async listTaskEvents(userId: string, taskId: string): Promise<AgentTaskEvent[]> {
    const task = await this.requireTaskForUser(userId, taskId);
    await this.syncTaskTimeline(task);
    return this.store.listTaskEvents(taskId);
  }

  async listTaskArtifacts(userId: string, taskId: string): Promise<AgentTaskArtifact[]> {
    const task = await this.requireTaskForUser(userId, taskId);
    await this.bestEffortSyncTaskTimeline(task);
    return this.store.listTaskArtifacts(taskId);
  }

  async downloadTaskArtifact(userId: string, taskId: string, artifactId: string): Promise<TaskArtifactDownload> {
    const task = await this.requireTaskForUser(userId, taskId);
    let artifacts = await this.store.listTaskArtifacts(taskId);
    let artifact = artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      await this.bestEffortSyncTaskTimeline(task);
      artifacts = await this.store.listTaskArtifacts(taskId);
      artifact = artifacts.find((candidate) => candidate.id === artifactId);
    }
    if (!artifact) {
      throw new ProductError("Task artifact not found", 404);
    }
    const { filePath } = await this.taskArtifactStoragePath(task, artifact);
    try {
      return {
        artifact,
        bytes: await readFile(filePath)
      };
    } catch (error) {
      if (isNotFound(error)) {
        throw new ProductError("Task artifact file not found", 404);
      }
      throw error;
    }
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
    const serviceKey = this.serviceKeyForTask(task);
    const state = await this.readRuntimeState(task, serviceKey);
    const existing = await this.store.listTaskEvents(task.id);
    const existingCursors = new Set(existing.map((event) => event.cursor));
    const timeline = await this.callBotified("read timeline", () =>
      this.botified.readTimeline(state.baseUrl, serviceKey, state.timelineCursor)
    );
    const projection = projectBotifiedTimelineEvents(task.id, timelineEvents(timeline.events), existingCursors);

    if (projection.artifacts.length > 0) {
      const existingArtifacts = await this.store.listTaskArtifacts(task.id);
      const existingFileIds = new Set(existingArtifacts.map((artifact) => artifact.fileId));
      for (const artifact of projection.artifacts) {
        if (existingFileIds.has(artifact.fileId)) {
          continue;
        }
        const download = projection.artifactDownloads.find((candidate) => candidate.artifactId === artifact.id);
        if (!download) {
          throw new ProductError("Projected task artifact download metadata missing", 500);
        }
        const productArtifact = {
          ...artifact,
          name: sanitizeArtifactFilename(artifact.name, artifact.fileId)
        };
        await this.downloadAndStoreTaskArtifact(task, state.baseUrl, serviceKey, productArtifact, download.fileId);
        await this.store.appendTaskArtifacts([productArtifact]);
        existingFileIds.add(productArtifact.fileId);
      }
    }
    if (projection.events.length > 0) {
      await this.store.appendTaskEvents(projection.events);
    }

    const timelineCursor = safeRuntimeCursor(timeline.nextCursor);
    const projectionCursor = safeRuntimeCursor(projection.nextCursor);
    const resetStateCursor =
      timeline.status === "reset" && timelineCursor === undefined && projectionCursor === undefined
        ? await this.bestEffortReadSafeStateCursor(state.baseUrl, serviceKey)
        : undefined;
    const nextCursor = timelineCursor ?? projectionCursor ?? resetStateCursor ?? state.timelineCursor;
    await this.writeRuntimeState(task.id, {
      ...state,
      ...(nextCursor !== undefined ? { timelineCursor: nextCursor } : {}),
      lastSyncedAt: nowIso()
    });

    const updated = await this.updateTaskStatusFromEvents(task, projection.events);
    await this.updateRunLifecycleAfterTimelineSync(updated, projection.events);
    return updated;
  }

  private async bestEffortSyncTaskTimeline(task: AgentTask): Promise<void> {
    try {
      await this.syncTaskTimeline(task);
    } catch (error) {
      if (error instanceof BotifiedTaskPortError) {
        return;
      }
      throw error;
    }
  }

  private async updateTaskStatusFromEvents(task: AgentTask, events: AgentTaskEvent[]): Promise<AgentTask> {
    const status = nextStatusForEvents(task.status, events);
    if (status === task.status) {
      return task;
    }
    return this.store.updateTask({ ...task, status, updatedAt: nowIso() });
  }

  private async readRuntimeState(task: AgentTask, serviceKey: string): Promise<BotifiedTaskRuntimeState> {
    const document = await this.store.jsonDocs.get("sandbox_runtime_state", task.id);
    if (!document) {
      return this.rebuildRuntimeStateFromBotified(task, serviceKey);
    }
    const baseUrl = stringDocumentField(document, "botifiedBaseUrl");
    const state: BotifiedTaskRuntimeState = { baseUrl };
    const timelineCursor = safeRuntimeCursor(optionalStringDocumentField(document, "timelineCursor"));
    const lastSyncedAt = optionalStringDocumentField(document, "lastSyncedAt");
    if (timelineCursor !== undefined) {
      state.timelineCursor = timelineCursor;
    }
    if (lastSyncedAt !== undefined) {
      state.lastSyncedAt = lastSyncedAt;
    }
    return state;
  }

  private async rebuildRuntimeStateFromBotified(task: AgentTask, serviceKey: string): Promise<BotifiedTaskRuntimeState> {
    const run = await this.store.sandboxRuns.get(task.runId);
    if (!run || run.taskId !== task.id || !Number.isFinite(run.botifiedPort) || run.botifiedPort <= 0) {
      throw new ProductError("Task runtime state not found", 409);
    }
    const baseUrl = this.botifiedBaseUrlForTask(task.id, run.botifiedPort, run.namespace);
    const snapshot = await this.callBotified("read state", () => this.botified.readState(baseUrl, serviceKey));
    const state = this.runtimeStateFromBotifiedSnapshot(baseUrl, snapshot);
    await this.writeRuntimeState(task.id, state);
    return state;
  }

  private runtimeStateFromBotifiedSnapshot(baseUrl: string, snapshot: BotifiedRuntimeStateResult): BotifiedTaskRuntimeState {
    const state: BotifiedTaskRuntimeState = { baseUrl };
    const timelineCursor = safeRuntimeCursor(snapshot.timelineCursor);
    if (timelineCursor !== undefined) {
      state.timelineCursor = timelineCursor;
    }
    return state;
  }

  private async bestEffortReadSafeStateCursor(baseUrl: string, serviceKey: string): Promise<string | undefined> {
    try {
      const snapshot = await this.botified.readState(baseUrl, serviceKey);
      return safeRuntimeCursor(snapshot.timelineCursor);
    } catch {
      return undefined;
    }
  }

  private async writeRuntimeState(taskId: string, state: BotifiedTaskRuntimeState): Promise<void> {
    const document: Record<string, unknown> = {
      botifiedBaseUrl: state.baseUrl
    };
    const timelineCursor = safeRuntimeCursor(state.timelineCursor);
    if (timelineCursor !== undefined) {
      document.timelineCursor = timelineCursor;
    }
    if (state.lastSyncedAt !== undefined) {
      document.lastSyncedAt = state.lastSyncedAt;
    }
    await this.store.jsonDocs.put("sandbox_runtime_state", taskId, document);
  }

  private serviceKeyForTask(task: AgentTask): string {
    const serviceKey = this.generateServiceKey({
      namespace: this.config.namespace,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      runId: task.runId
    });
    requireBotifiedServiceKey(serviceKey);
    return serviceKey;
  }

  private generateServiceKey(input: BotifiedServiceKeyInput): string | undefined {
    return this.config.botifiedServiceKeyFactory?.(input) ?? createBotifiedServiceKey(this.config.botifiedServiceKeySecret, input);
  }

  private botifiedBaseUrlForTask(taskId: string, port: number, namespace = this.config.namespace): string {
    const input = { namespace, taskId, port };
    return (this.config.botifiedBaseUrlForTask ?? defaultBotifiedBaseUrlForTask)(input);
  }

  private async callBotified<T>(operation: BotifiedOperation, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw new BotifiedTaskPortError(operation, error);
    }
  }

  private async downloadAndStoreTaskArtifact(
    task: AgentTask,
    baseUrl: string,
    serviceKey: string,
    artifact: AgentTaskArtifact,
    botifiedFileId: string
  ): Promise<void> {
    const downloaded = await this.callBotified("download file", () =>
      this.botified.downloadFile(baseUrl, serviceKey, botifiedFileId)
    );
    const { root, filePath } = await this.taskArtifactStoragePath(task, artifact);
    await mkdir(root, { recursive: true });
    try {
      await writeFile(filePath, downloaded.bytes, { flag: "wx" });
    } catch (error) {
      if (isAlreadyExists(error)) {
        return;
      }
      throw error;
    }
  }

  private async taskArtifactStoragePath(task: AgentTask, artifact: AgentTaskArtifact): Promise<{ root: string; filePath: string }> {
    const project = await this.store.findProject(task.projectId);
    if (!project) {
      throw new ProductError("Task project not found", 409);
    }
    const dataRoot = path.resolve(this.config.dataRoot);
    const root = path.resolve(dataRoot, project.rootPath, "tasks", task.id, "artifacts");
    assertPathInside(dataRoot, root, "Task artifact directory is outside the data root");
    const filename = `${sanitizeArtifactFilename(artifact.id, "artifact")}-${sanitizeArtifactFilename(artifact.name, artifact.fileId)}`;
    const filePath = path.resolve(root, filename);
    assertPathInside(root, filePath, "Task artifact path is outside the artifact directory");
    return { root, filePath };
  }

  private resolveLiveModelCredential(endpoint: ModelEndpoint): { apiKey: string; baseUrl: string } {
    const resolver = this.config.modelCredentialResolver;
    if (!resolver) {
      throw new ProductError("Live sandbox model credential resolver is not configured", 500);
    }
    const credential = resolver.resolveCredential(endpoint.apiKeySecretRef);
    const endpointBaseUrl = normalizeOpenAICompatibleBaseUrl(endpoint.baseUrl);
    const credentialBaseUrl = normalizeOpenAICompatibleBaseUrl(credential.baseUrl, 500);
    if (endpointBaseUrl !== credentialBaseUrl) {
      throw new ProductError("Endpoint baseUrl does not match the configured credential binding");
    }
    return credential;
  }

  private buildLiveSandboxRun(input: {
    task: AgentTask;
    timestamp: string;
    botifiedPort: number;
    projectSubPath: string;
    serviceKeySecretName: string;
  }): SandboxRunState {
    const paths = this.taskRuntimePaths(input.task);
    return {
      namespace: this.config.namespace,
      workspaceId: input.task.workspaceId,
      projectId: input.task.projectId,
      taskId: input.task.id,
      runId: input.task.runId,
      phase: "starting",
      image: this.config.botifiedRunnerImage,
      pvcName: this.config.pvcName,
      projectSubPath: input.projectSubPath,
      botifiedPort: input.botifiedPort,
      resourceNames: {
        pod: `asl-task-${input.task.id}`,
        service: `asl-task-${input.task.id}`,
        configMap: `asl-task-${input.task.id}-config`,
        secret: input.serviceKeySecretName,
        serviceAccount: `asl-task-${input.task.id}`,
        networkPolicy: `asl-task-${input.task.id}`
      },
      serviceKeySecretRef: {
        name: input.serviceKeySecretName,
        key: "BOTIFIED_SERVICE_KEY"
      },
      directories: {
        taskHome: paths.taskHomePath,
        artifacts: paths.artifactPath,
        botified: paths.botifiedDataPath
      },
      resourceLimits: {
        cpuRequest: "250m",
        memoryRequest: "512Mi",
        cpuLimit: "1",
        memoryLimit: "1Gi"
      },
      ...(this.config.modelCa ? { modelCa: this.config.modelCa } : {}),
      fencingToken: 1,
      cleanupStatus: "active",
      createdAt: input.timestamp,
      expiresAt: deadlineIso(input.timestamp, this.liveSandboxMaxLifetimeMs()),
      idleExpiresAt: deadlineIso(input.timestamp, this.liveSandboxIdleTimeoutMs()),
      updatedAt: input.timestamp
    };
  }

  private async startLiveSandbox(input: {
    endpoint: ModelEndpoint;
    task: AgentTask;
    run: SandboxRunState;
    serviceKey: string;
    modelApiKey: string;
  }): Promise<void> {
    const live = this.config.liveSandbox;
    if (!live) {
      return;
    }
    await this.prepareLiveRuntimeDirectories(input.task, input.run.projectSubPath);
    const actions = reconcileSandboxRuns({
      desiredRuns: [input.run],
      observedResources: [],
      now: new Date()
    }).actions;
    const config = generateBotifiedConfig({
      endpoint: input.endpoint,
      task: {
        taskId: input.task.id,
        projectMountPath: "/workspace/project",
        taskHomePath: input.run.directories.taskHome,
        botifiedDataPath: input.run.directories.botified,
        serviceKeyEnv: "BOTIFIED_SERVICE_KEY",
        modelApiKeyEnv: "MODEL_API_KEY",
        ...(this.config.modelCa ? { modelCaBundlePath: this.config.modelCa.path } : {}),
        servicePort: input.run.botifiedPort
      }
    });
    const materialized = materializeLiveCreateActions(actions, {
      serviceKey: input.serviceKey,
      modelApiKey: input.modelApiKey,
      botifiedConfig: serializeBotifiedConfig(config)
    });
    await applySandboxReconcileActionsToKubernetes(live.port, materialized);
    const podAction = materialized.find((action) => action.type === "create_resource" && action.kind === "Pod");
    if (!podAction || podAction.type !== "create_resource") {
      throw new ProductError("Live sandbox pod manifest was not generated", 500);
    }
    await waitForPodReady(live, input.run.namespace, podAction.name, podAction.labels);
  }

  private async prepareLiveRuntimeDirectories(task: AgentTask, projectRootPath: string): Promise<void> {
    const dataRoot = path.resolve(this.config.dataRoot);
    const taskRoot = path.resolve(dataRoot, projectRootPath, "tasks", task.id);
    assertPathInside(dataRoot, taskRoot, "Task runtime directory is outside the data root");
    const runnerWritableDirectories = [path.resolve(taskRoot, "home"), path.resolve(taskRoot, "botified")];
    const apiOwnedDirectories = [path.resolve(taskRoot, "artifacts")];
    for (const directory of [...runnerWritableDirectories, ...apiOwnedDirectories]) {
      assertPathInside(dataRoot, directory, "Task runtime directory is outside the data root");
    }
    for (const directory of runnerWritableDirectories) {
      await prepareRunnerWritableDirectory(directory);
    }
    for (const directory of apiOwnedDirectories) {
      await prepareApiOwnedArtifactDirectory(directory);
    }
  }

  private async bestEffortMarkTaskFailed(task: AgentTask): Promise<void> {
    try {
      await this.store.updateTask({ ...task, status: "failed", updatedAt: nowIso() });
    } catch {
      // Startup cleanup and the original failure must not depend on the failed-state write.
    }
  }

  private async updatePersistedRun(
    runId: string,
    updates: Pick<PersistedSandboxRunState, "phase" | "cleanupStatus">
  ): Promise<void> {
    const current = await this.store.sandboxRuns.get(runId);
    if (!current) {
      throw new ProductError("Sandbox run state not found", 409);
    }
    const updated = await this.store.sandboxRuns.updateWithFencing(runId, current.fencingToken, {
      ...current,
      ...updates,
      fencingToken: current.fencingToken + 1,
      updatedAt: nowIso()
    });
    if (!updated) {
      throw new ProductError("Sandbox run state fencing token changed", 409);
    }
  }

  private async bestEffortRequestRunCleanup(runId: string, phase: PersistedSandboxRunState["phase"]): Promise<void> {
    try {
      await requestSandboxRunCleanup(this.store, runId, { phase, cleanupStatus: "cleanup_requested" });
    } catch {
      // Cleanup intent must not hide the task operation failure that triggered it.
    }
  }

  private async bestEffortReapSandboxRun(runId: string): Promise<void> {
    try {
      await this.config.sandboxLifecycle?.reapSandboxRunsOnce({ runId, apply: true });
    } catch {
      // Reaping is recoverable through the explicit operator endpoint/status.
    }
  }

  private async updateRunLifecycleAfterTimelineSync(task: AgentTask, events: AgentTaskEvent[]): Promise<void> {
    if (!this.config.liveSandbox) {
      return;
    }
    if (isTerminalTaskStatus(task.status)) {
      await this.bestEffortRequestRunCleanup(task.runId, cleanupPhaseForTaskStatus(task.status));
      await this.bestEffortReapSandboxRun(task.runId);
      return;
    }
    if (events.length > 0 && isActiveTaskStatus(task.status)) {
      await refreshSandboxRunActivity(this.store, task.runId, {
        idleTimeoutMs: this.liveSandboxIdleTimeoutMs()
      });
    }
  }

  private liveSandboxMaxLifetimeMs(): number {
    return resolveDurationMs(this.config.liveSandboxMaxLifetimeMs, DEFAULT_SANDBOX_RUN_MAX_LIFETIME_MS);
  }

  private liveSandboxIdleTimeoutMs(): number {
    return resolveDurationMs(this.config.liveSandboxIdleTimeoutMs, DEFAULT_SANDBOX_RUN_IDLE_TIMEOUT_MS);
  }

  private liveSandboxNamespaceLimit(): number {
    return requirePositiveInteger(
      this.config.sandboxNamespaceLimit,
      "sandbox.namespaceLimit",
      DEFAULT_SANDBOX_NAMESPACE_LIMIT
    );
  }

  private async requireNamespaceSandboxCapacity(): Promise<void> {
    const limit = this.liveSandboxNamespaceLimit();
    const activeRuns = await this.store.sandboxRuns.listActive();
    const namespaceActiveRuns = activeRuns.filter((run) => run.namespace === this.config.namespace);
    if (namespaceActiveRuns.length >= limit) {
      throw new ProductError("Namespace sandbox active run limit reached", 409);
    }
  }
}

function createBotifiedServiceKey(secret: string | undefined, input: BotifiedServiceKeyInput): string {
  const seed = secret && secret.trim().length > 0 ? secret : "dev-session-secret";
  const hmac = createHmac("sha256", seed);
  for (const part of ["agentsmith-lite.botified-service-key.v1", input.namespace, input.workspaceId, input.projectId, input.taskId, input.runId]) {
    hmac.update(part);
    hmac.update("\0");
  }
  return `bsk_${hmac.digest("base64url")}`;
}

function defaultBotifiedBaseUrlForTask(input: BotifiedTaskAddressInput): string {
  return `http://asl-task-${input.taskId}.${input.namespace}.svc.cluster.local:${input.port}`;
}

function requireBotifiedServiceKey(serviceKey: string | undefined): asserts serviceKey is string {
  if (serviceKey === undefined || serviceKey.trim() === "") {
    throw new ProductError("Botified service key is required", 500);
  }
}

function materializeLiveCreateActions(
  actions: SandboxReconcileAction[],
  input: { serviceKey: string; modelApiKey: string; botifiedConfig: string }
): SandboxReconcileAction[] {
  return actions.map((action) => {
    if (action.type !== "create_resource") {
      return structuredClone(action);
    }
    const resource = structuredClone(action.resource);
    if (action.kind === "Secret") {
      resource.stringData = {
        BOTIFIED_SERVICE_KEY: input.serviceKey,
        MODEL_API_KEY: input.modelApiKey
      };
    }
    if (action.kind === "ConfigMap") {
      resource.data = {
        ...(isRecord(resource.data) ? resource.data : {}),
        "botified-config.yaml": input.botifiedConfig
      };
    }
    return {
      ...structuredClone(action),
      resource
    };
  });
}

async function waitForPodReady(
  live: TaskLiveSandboxConfig,
  namespace: string,
  podName: string,
  labels: Record<string, string>
): Promise<void> {
  const timeoutMs = Math.max(0, live.readinessTimeoutMs ?? 60_000);
  const pollMs = Math.max(1, live.readinessPollMs ?? 1000);
  const sleep = live.sleep ?? defaultSleep;
  let elapsedMs = 0;

  while (true) {
    const readiness = await live.port.getPodReadiness(namespace, podName, labels);
    switch (readiness) {
      case "ready":
        return;
      case "failed":
        throw new ProductError("Sandbox pod failed before readiness", 502);
      case "fence_mismatch":
        throw new ProductError("Sandbox pod readiness fence mismatch", 500);
      case "pending":
      case "not_found": {
        if (elapsedMs >= timeoutMs) {
          throw new ProductError("Timed out waiting for sandbox pod readiness", 504);
        }
        const delayMs = Math.min(pollMs, timeoutMs - elapsedMs);
        if (delayMs > 0) {
          await sleep(delayMs);
        }
        elapsedMs += delayMs;
        break;
      }
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function isTerminalTaskStatus(status: AgentTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "expired" || status === "cleaned";
}

function isActiveTaskStatus(status: AgentTaskStatus): boolean {
  return status === "queued" || status === "starting" || status === "running" || status === "stopping";
}

function cleanupPhaseForTaskStatus(status: AgentTaskStatus): PersistedSandboxRunState["phase"] {
  return status === "expired" ? "expired" : "stopping";
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

function safeRuntimeCursor(cursor: string | null | undefined): string | undefined {
  if (cursor === null || cursor === undefined || isSecretLikeText(cursor)) {
    return undefined;
  }
  return cursor;
}

function deadlineIso(baseIso: string, durationMs: number): string {
  return new Date(Date.parse(baseIso) + durationMs).toISOString();
}

function resolveDurationMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function sanitizeArtifactFilename(input: string, fallback: string): string {
  const base = path.posix.basename(input.replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 180);
  if (cleaned.length > 0) {
    return cleaned;
  }
  const fallbackBase = path.posix.basename(fallback.replace(/\\/g, "/"));
  const fallbackCleaned = fallbackBase
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return fallbackCleaned.length > 0 ? fallbackCleaned : "artifact";
}

function assertPathInside(root: string, candidate: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ProductError(message, 500);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function prepareRunnerWritableDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: BOTIFIED_RUNNER_DIRECTORY_MODE });
  const chowned = await tryChownForRunner(directory);
  await chmod(directory, chowned ? BOTIFIED_RUNNER_DIRECTORY_MODE : BOTIFIED_RUNNER_FALLBACK_DIRECTORY_MODE);
}

async function prepareApiOwnedArtifactDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: API_OWNED_ARTIFACT_DIRECTORY_MODE });
  await chmod(directory, API_OWNED_ARTIFACT_DIRECTORY_MODE);
}

async function tryChownForRunner(directory: string): Promise<boolean> {
  try {
    await chown(directory, BOTIFIED_RUNNER_UID, BOTIFIED_RUNNER_GID);
    return true;
  } catch (error) {
    if (isChownUnavailable(error)) {
      return false;
    }
    throw error;
  }
}

function isChownUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "EPERM" || error.code === "EACCES" || error.code === "EINVAL" || error.code === "ENOSYS";
}
