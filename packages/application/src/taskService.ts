import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateBotifiedConfig, serializeBotifiedConfig } from "../../botified-runtime/src/config.js";
import { parseBotifiedTimelineEvents, type BotifiedTimelineEvent } from "../../botified-runtime/src/projection.js";
import { isSecretLikeText, redactInteractionText, redactSecretLikeText, type InteractionTextRedactionOptions } from "../../botified-runtime/src/redaction.js";
import type {
  AgentTask,
  AgentTaskArtifact,
  AgentTaskStatus,
  CreateTaskInput,
  KubernetesResource,
  ModelEndpoint,
  TaskCapabilities,
  TaskDetailProjection,
  TaskHistoryStatus,
  TaskInteractionItem,
  TaskInteractionSnapshot,
  TaskInteractionState,
  TaskMessageReceipt,
  TaskQueuedMessage,
  TaskRunState,
  TaskRuntimeReachability,
  TaskInputSnapshotEntry,
  TaskListPage,
  TaskListQuery,
  TaskSummary,
  TaskTerminalReason
} from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { DEFAULT_SANDBOX_NAMESPACE_LIMIT, MAX_TASK_ARTIFACT_BYTES } from "../../domain/src/sandboxDefaults.js";
import { requireNonEmptyString, requirePositiveInteger } from "../../domain/src/validation.js";
import { normalizeOpenAICompatibleBaseUrl } from "../../openai-compatible-client/src/index.js";
import { CredentialService } from "./credentialService.js";
import { BotifiedHttpError, type BotifiedDeliveryReceipt, type BotifiedRuntimeHttpClient, type BotifiedRuntimeStateResult, type BotifiedTimelineReadResult } from "../../ports/src/botified.js";
import type {
  AtomicTaskCreateInput,
  FinalizeTaskLifecycleResult,
  PersistTaskArtifactProjectionInput,
  PersistedAgentTask,
  PersistedSandboxRunState,
  PersistedTaskArtifact,
  PersistedTaskInteractionChange,
  PersistedTaskMessage,
  ProductStore,
  TaskIdempotencyOperation,
  TaskInteractionChangeInput,
  TaskInteractionCorrelation,
  TaskInteractionLifecycleMutation,
  TaskInteractionPageAnchor,
  TaskLifecycleSuccessor,
  TaskLifecycleTerminalPendingChange
} from "../../ports/src/store.js";
import {
  projectTaskInteraction,
  type ProductTaskInteractionSource,
  type TaskInteractionProjectionState
} from "./taskInteractionProjector.js";
import {
  applySandboxReconcileActionsToKubernetes,
  type SandboxKubernetesMutationPort,
  type SandboxKubernetesReadinessPort
} from "../../sandbox-controller/src/kubernetesPort.js";
import { renderSandboxResources } from "../../sandbox-controller/src/manifestRenderer.js";
import { sandboxResourceNamesForTask, sandboxServiceNameForTask } from "../../sandbox-controller/src/resourceNames.js";
import { APP_KUBERNETES_SERVICE_NAME, APP_KUBERNETES_SERVICE_PORT } from "../../sandbox-controller/src/appManifestRenderer.js";
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
  type SandboxLifecycleService,
  type SandboxTerminalFailureSyncResult
} from "./sandboxLifecycleService.js";
import { WorkspaceService } from "./workspaceService.js";
import { FilePathValidationService } from "./filePathValidationService.js";
import { detectProjectFileMediaType, withProjectFileLock } from "./fileService.js";
import { ProjectPolicyService } from "./projectPolicyService.js";
import type { ProjectPermission } from "./authorizationService.js";
import type { ContextService } from "./contextService.js";

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
  botifiedBrokerBaseUrlForTask?: (input: BotifiedBrokerAddressInput) => string;
  liveSandbox?: TaskLiveSandboxConfig;
  sandboxNamespaceLimit?: number;
  liveSandboxMaxLifetimeMs?: number;
  liveSandboxIdleTimeoutMs?: number;
  credentials?: CredentialService;
  modelCa?: ModelCaReference;
  sandboxLifecycle?: SandboxLifecycleService;
  deliveryLeaseMs?: number;
  maintenanceLeaseMs?: number;
  retryDelayMs?: number;
  contexts?: ContextService;
}

export interface BotifiedTaskAddressInput {
  namespace: string;
  taskId: string;
  port: number;
}

export interface BotifiedBrokerAddressInput extends BotifiedServiceKeyInput {}

export interface AuthorizedBotifiedChatCompletion {
  endpoint: ModelEndpoint;
  apiKey: string;
  projectId: string;
  actorId: string | null;
}


interface BotifiedTaskRuntimeState {
  baseUrl: string;
  timelineCursor?: string;
  lastSyncedAt?: string;
  startDeliveryKey?: string;
  startRequestHash?: string;
  startClaimToken?: string;
  startReceipt?: BotifiedDeliveryReceipt;
}

type BotifiedOperation = "send message" | "read state" | "read timeline" | "download file" | "abort" | "stop background work";
type LiveSandboxCleanupStatus = "none" | "pending" | "cleaned";

export interface TaskInteractionChangePage {
  changes: Array<{ cursor: string; item: TaskInteractionItem }>;
  streamCursor: string;
  done: boolean;
  state: TaskInteractionState;
}

export interface TaskTurnAbortResult {
  aborted: true;
  runState: TaskRunState;
  capabilities: TaskCapabilities;
}

export interface TaskBackgroundWorkStopResult {
  interactionId: string;
  workTaskId: string;
  state: "running" | "cancelling" | "completed" | "failed" | "timed_out" | "cancelled" | "lost";
  capabilities: TaskCapabilities;
}

export type TaskAssistantPreviewUpdate =
  | { type: "upsert"; interactionId: string; body: string; occurredAt: string }
  | { type: "clear"; interactionId: string };

export interface TaskArtifactDownload {
  artifact: AgentTaskArtifact;
  bytes: Buffer;
}

export interface TaskInputDownload {
  input: TaskInputSnapshotEntry;
  bytes: Buffer;
}

export interface TaskTerminalConnection {
  baseUrl: string;
  serviceKey: string;
}

const BOTIFIED_RUNNER_UID = 10001;
const BOTIFIED_RUNNER_GID = 10001;
const BOTIFIED_RUNNER_DIRECTORY_MODE = 0o775;
const BOTIFIED_RUNNER_FALLBACK_DIRECTORY_MODE = 0o777;
const BOTIFIED_TASK_HOME_PATH = "/workspace/task/home";
const BOTIFIED_DATA_PATH = "/workspace/task/botified";
const BOTIFIED_ARTIFACT_PATH = "/workspace/task/artifacts";
const ACTIVE_TASKS_LIMIT_MESSAGE = "Project active tasks limit reached";
const ACTIVE_TASKS_LIMIT_CODE = "active_tasks_limit_reached";
const MAX_TASK_ARTIFACT_FILES = 128;
const TASK_ENDPOINT_CAPABILITIES = ["text", "tool_calls"] as const;
const ARTIFACT_PREVIEW_MAX_BYTES = 8_192;
const DEFAULT_DELIVERY_LEASE_MS = 30_000;
const DEFAULT_MAINTENANCE_LEASE_MS = 60_000;
const DEFAULT_TASK_RETRY_DELAY_MS = 5_000;
const MAX_TERMINAL_RUNTIME_SYNC_ATTEMPTS = 3;
const IDEMPOTENCY_LEASE_MS = 30_000;
const INTERACTION_HISTORY_PAGE_LIMIT = 100;
const INTERACTION_SYNC_PAGE_LIMIT = 200;

function activeTasksLimitError(): ProductError {
  return new ProductError(ACTIVE_TASKS_LIMIT_MESSAGE, 409, ACTIVE_TASKS_LIMIT_CODE);
}
const INTERACTION_LOOKUP_LIMIT = 1_000;

interface TaskInputManifestEntry {
  path: string;
  size: number;
  digest: string;
}

function requireTaskEndpointCapabilities(endpoint: ModelEndpoint): void {
  const missing = TASK_ENDPOINT_CAPABILITIES.filter((capability) => !endpoint.capabilities.includes(capability));
  if (missing.length > 0) {
    const capabilities = missing.join(" and ");
    throw new ProductError(`Task endpoint must support the ${capabilities} ${missing.length === 1 ? "capability" : "capabilities"} for Botified execution`, 409);
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
  private readonly messageDispatchTaskIds = new Set<string>();
  private readonly occupiedTerminalTaskIds = new Set<string>();
  private readonly terminalActivityRefreshAfter = new Map<string,number>();
  private readonly abortingTaskIds = new Set<string>();
  private readonly taskTimelineSyncs = new Map<string, Promise<void>>();

  constructor(
    private readonly store: ProductStore,
    private readonly workspaces: WorkspaceService,
    private readonly endpoints: EndpointService,
    private readonly botified: BotifiedRuntimeHttpClient,
    private readonly config: TaskServiceConfig,
    private readonly policies: ProjectPolicyService
  ) {}

  async createTask(userId: string, projectId: string, input: CreateTaskInput, idempotencyKey?: string): Promise<AgentTask> {
    return this.createTaskOperation(userId, projectId, input, "create", idempotencyKey);
  }

  private async createTaskOperation(userId: string, projectId: string, input: CreateTaskInput, operation: Extract<TaskIdempotencyOperation, "create" | "retry" | "duplicate">, idempotencyKey?: string, sourceTaskId: string | null = null): Promise<AgentTask> {
    const endpointId = requireNonEmptyString(input.endpointId, "task.endpointId");
    const prompt = requireNonEmptyString(input.prompt, "task.prompt");
    const title = normalizeTaskTitle(input.title, prompt);
    const inputPaths = normalizeTaskInputPaths(input.inputPaths);
    const project = await this.workspaces.requireProjectForUser(userId, projectId, "write");
    const result = await this.runIdempotentTaskOperation({
      actorId: userId,
      projectId,
      operation,
      key: idempotencyKey,
      request: { endpointId, prompt, title, inputPaths, sourceTaskId }
    }, newId("task"), async (id) => {
      const existing = await this.store.findTask(id);
      if (existing) return publicTask(existing);
      if(sourceTaskId){const source=await this.store.findTask(sourceTaskId);if(!source||source.deletedAt||source.projectId!==projectId)throw new ProductError("Source task not found",404);if(operation==="retry"&&!isTerminalTask(source))throw new ProductError("Task must be terminal before retry",409);}
      const endpoint = await this.endpoints.requireCredentialEndpointForUser(userId, projectId, endpointId);
      requireTaskEndpointCapabilities(endpoint);
      if (this.config.liveSandbox) await this.requireNamespaceSandboxCapacity();
      const agentContext = this.config.liveSandbox ? await this.config.contexts?.resolveForAgent(userId, projectId) ?? "" : "";
      let create: AtomicTaskCreateInput;
      try {
        create = await this.prepareTaskCreate({ id, project, endpoint, prompt, title, inputPaths, sourceTaskId, agentContext, createdByUserId:userId });
      } catch (error) {
        await this.bestEffortRemoveUnpersistedTaskData(project.rootPath,id);
        throw error;
      }
      let persisted: PersistedAgentTask | null = null;
      try {
        persisted = await this.store.createTaskAtomically(create);
        if (!persisted) {
          if (sourceTaskId) {
            const source = await this.store.findTask(sourceTaskId);
            if (!source || source.deletedAt || source.projectId !== projectId) throw new ProductError("Source task not found",404);
          }
          await this.policies.recordTaskReservationRejected(projectId, userId, id);
          throw activeTasksLimitError();
        }
      } catch (error) {
        if (create.task.executionMode === "live") await this.bestEffortRemoveUnpersistedTaskData(project.rootPath,id);
        throw error;
      }
      await this.persistInitialPromptInteraction(persisted);
      await this.policies.recordOperation(projectId, userId, "task.create", "accepted", persisted.id);
      return publicTask(persisted);
    });
    const persisted = await this.store.findTask(result.id);
    return persisted ? publicTask(persisted) : result;
  }

  private async prepareTaskCreate(input: {
    id: string;
    project: Awaited<ReturnType<WorkspaceService["requireProjectForUser"]>>;
    endpoint: ModelEndpoint;
    prompt: string;
    title: string;
    inputPaths: string[];
    sourceTaskId: string | null;
    agentContext: string;
    createdByUserId: string | null;
  }): Promise<AtomicTaskCreateInput> {
    const timestamp = nowIso();
    const runId = newId("run");
    const live = this.config.liveSandbox !== undefined;
    const botifiedPort = this.config.botifiedPort ?? 3099;
    const resourceNames = sandboxResourceNamesForTask(input.id);
    const startDeliveryKey = live ? deliveryKeyForStart(input.id, runId) : null;
    const startRequestHash = live ? deliveryRequestHash(input.prompt) : null;
    const sandbox = live ? renderSandboxResources({
      namespace: this.config.namespace,
      workspaceId: input.project.workspaceId,
      projectId: input.project.id,
      taskId: input.id,
      runId,
      image: this.config.botifiedRunnerImage,
      pvcName: this.config.pvcName,
      projectSubPath: input.project.rootPath,
      botifiedPort,
      serviceKeySecretName: resourceNames.secret,
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi",
      ...(this.config.modelCa ? { modelCa: this.config.modelCa } : {}),
      resourceNames
    }) : { namespace: this.config.namespace, resources: [] };
    const task: PersistedAgentTask = {
      id: input.id,
      workspaceId: input.project.workspaceId,
      projectId: input.project.id,
      endpointId: input.endpoint.id,
      title: input.title,
      prompt: input.prompt,
      inputPaths: input.inputPaths,
      status: live ? "starting" : "completed",
      runId,
      sourceTaskId: input.sourceTaskId,
      createdByUserId: input.createdByUserId,
      executionMode: live ? "live" : "dry-run",
      sandbox,
      activeReservation: live,
      archivedAt: null,
      deletedAt: null,
      terminalReason: live ? null : "not_executed",
      terminalizedAt: live ? null : timestamp,
      startDeliveryKey,
      startRequestHash,
      startClaimToken: null,
      startReceipt: null,
      startTimelineCursor: null,
      startIntentStatus: live ? "pending" : null,
      startClaimedAt: null,
      startLeaseExpiresAt: null,
      startAttemptCount: 0,
      startNextRetryAt: null,
      startSafeError: null,
      artifactProjectionStatus: live ? "pending" : "drained",
      artifactProjectionError: null,
      cleanupStatus: live ? "pending" : "completed",
      cleanupError: null,
      cleanupCompletedAt: live ? null : timestamp,
      agentContext: input.agentContext,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    if (!live) return { task, reserveActive: false };
    const serviceKey = this.serviceKeyForTask(task);
    requireBotifiedServiceKey(serviceKey);
    if (input.sourceTaskId) {
      await this.snapshotRetainedTaskInputs(input.project.id, input.project.rootPath, input.id, input.sourceTaskId);
    } else {
      await this.snapshotProjectInputs(input.project.rootPath, input.id, input.inputPaths);
    }
    const runtimeState: Record<string, unknown> = {
      botifiedBaseUrl: this.botifiedBaseUrlForTask(input.id, botifiedPort)
    };
    const sandboxRun = this.buildLiveSandboxRun({ task, timestamp, botifiedPort, projectSubPath: input.project.rootPath, resourceNames });
    return { task, reserveActive: true, runtimeState, sandboxRun };
  }

  private async runIdempotentTaskOperation<T>(
    scope: { actorId:string;projectId:string;operation:TaskIdempotencyOperation;key:string|undefined;request:unknown },
    resourceId: string,
    action: (resourceId:string) => Promise<T>
  ): Promise<T> {
    const key=normalizeIdempotencyKey(scope.key);
    const requestHash=canonicalRequestHash(scope.request);
    const claimToken=newId("idempotency_claim");
    const timestamp=nowIso();
    const begun=await this.store.beginTaskIdempotency({actorId:scope.actorId,projectId:scope.projectId,operation:scope.operation,key,requestHash,resourceId,claimToken,now:timestamp,leaseExpiresAt:deadlineIso(timestamp,IDEMPOTENCY_LEASE_MS)});
    if(begun.kind==="hash_mismatch")throw new ProductError("Idempotency-Key was already used with a different request",409);
    if(begun.kind==="in_progress")throw new ProductError("Idempotent task operation is still in progress",409);
    if(begun.kind==="replay"){
      if(begun.responseStatus>=400){const record=isUnknownRecord(begun.responseBody)?begun.responseBody:{};throw new ProductError(typeof record.error==="string"?record.error:"Task operation failed",begun.responseStatus,typeof record.code==="string"?record.code:undefined);}
      if(String(scope.operation)==="message"){
        const message=await this.store.findTaskMessage(begun.resourceId);
        if(message)return await this.messageReceipt(scope.actorId,message,true) as unknown as T;
      }
      const replay=structuredClone(begun.responseBody) as T;
      if(isMessageReceiptOperation(scope.operation)&&isUnknownRecord(replay))return{...replay,duplicate:true} as T;
      return replay;
    }
    try{
      const response=await action(begun.resourceId);
      if(!await this.store.completeTaskIdempotency({actorId:scope.actorId,projectId:scope.projectId,operation:scope.operation,key,requestHash,claimToken:begun.claimToken,responseStatus:200,responseBody:response,updatedAt:nowIso()}))throw new ProductError("Idempotent task operation lost its claim",409);
      return response;
    }catch(error){
      if(error instanceof ProductError)await this.store.completeTaskIdempotency({actorId:scope.actorId,projectId:scope.projectId,operation:scope.operation,key,requestHash,claimToken:begun.claimToken,responseStatus:error.statusCode,responseBody:{error:error.message,...(error.code?{code:error.code}:{})},updatedAt:nowIso()});
      throw error;
    }
  }

  async listTasks(userId: string, projectId: string): Promise<AgentTask[]>;
  async listTasks(userId: string, projectId: string, query: TaskListQuery): Promise<TaskListPage>;
  async listTasks(userId: string, projectId: string, query?: TaskListQuery): Promise<AgentTask[] | TaskListPage> {
    await this.workspaces.requireProjectForUser(userId, projectId, "view");
    if (query === undefined) return (await this.store.listTasksForProject(projectId)).filter((task) => !task.deletedAt).map(publicTask);
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 25)));
    const listQuery = {
      search: (query.search ?? "").trim().slice(0, 200),
      statuses: normalizeTaskStatuses(query.statuses),
      archived: query.archived ?? "exclude",
      sort: query.sort ?? "updated_at",
      direction: query.direction ?? "desc"
    };
    const offset = decodeTaskListCursor(query.cursor, listQuery);
    const page = await this.store.queryTasksForProject(projectId, { ...listQuery, offset, limit });
    return { items: page.items.map(publicTask), total: page.total, nextCursor: offset + page.items.length < page.total ? encodeTaskListCursor(offset + page.items.length, listQuery) : null };
  }

  /** Internal deletion path: project data remains until every live sandbox is drained and cleaned. */
  async stopTasksForProjectDeletion(projectId: string): Promise<void> {
    for (const task of await this.store.listTasksForProject(projectId)) {
      let current = task;
      if (isActiveTaskStatus(current.status)) {
        current = await this.finalizeTaskLifecycle(current.id, "cancelled", null);
        await this.bestEffortAbortAndRequestCleanup(current);
      }
      if (current.executionMode !== "live") continue;

      if (current.artifactProjectionStatus !== "drained") {
        await this.drainTaskArtifacts(current);
        current = await this.requireTaskDeletionStage(current.id, "artifact projection");
      }
      if (current.artifactProjectionStatus !== "drained") {
        throw new ProductError("Task artifact projection is still pending", 409);
      }

      if (current.cleanupStatus !== "completed") {
        await this.cleanupTaskRuntime(current);
        current = await this.requireTaskDeletionStage(current.id, "sandbox cleanup");
      }
      if (current.cleanupStatus !== "completed") {
        throw new ProductError("Task sandbox cleanup is still pending", 409);
      }
    }
  }

  private async requireTaskDeletionStage(taskId: string, stage: string): Promise<PersistedAgentTask> {
    const task = await this.store.findTask(taskId);
    if (!task) throw new ProductError(`Task disappeared during ${stage}`, 409);
    return task;
  }

  async listTaskSummaries(userId: string, projectId: string): Promise<TaskSummary[]> {
    await this.workspaces.requireProjectForUser(userId, projectId, "view");
    return this.store.listTaskSummariesForProject(projectId);
  }

  async getTask(userId: string, taskId: string): Promise<AgentTask> {
    return publicTask(await this.requireTaskForUser(userId, taskId, "view"));
  }

  async getTaskDetail(userId: string, taskId: string): Promise<TaskDetailProjection> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    return { task: publicTask(task), capabilities: await this.taskCapabilities(userId, task) };
  }

  async getTaskSummary(userId: string, taskId: string): Promise<TaskSummary> {
    await this.requireTaskForUser(userId, taskId, "view");
    const summary = await this.store.findTaskSummary(taskId);
    if (!summary) throw new ProductError("Task not found", 404);
    return summary;
  }

  async openTaskTerminal(userId:string,taskId:string):Promise<TaskTerminalConnection>{
    const task=await this.requireTaskForUser(userId,taskId,"write");
    if(task.executionMode!=="live"||!isActiveTaskStatus(task.status))throw new ProductError("Task terminal is available while the sandbox is running",409);
    if(!await this.taskExecutionEligible(task))throw new ProductError("Task terminal is no longer available for this task",409);
    if(this.occupiedTerminalTaskIds.has(task.id))throw new ProductError("Task terminal is already open",409);
    this.occupiedTerminalTaskIds.add(task.id);
    try{
      const serviceKey=this.serviceKeyForTask(task);
      const state=await this.readRuntimeState(task,serviceKey);
      await this.recordTaskTerminalActivity(task.id);
      return{baseUrl:state.baseUrl,serviceKey};
    }catch(error){
      this.occupiedTerminalTaskIds.delete(task.id);
      throw error;
    }
  }

  closeTaskTerminal(taskId:string):void{
    this.occupiedTerminalTaskIds.delete(taskId);
    this.terminalActivityRefreshAfter.delete(taskId);
  }

  async recordTaskTerminalActivity(taskId:string):Promise<void>{
    if(!this.occupiedTerminalTaskIds.has(taskId))return;
    const now=new Date();
    if((this.terminalActivityRefreshAfter.get(taskId)??0)>now.getTime())return;
    const idleTimeoutMs=this.liveSandboxIdleTimeoutMs();
    this.terminalActivityRefreshAfter.set(taskId,now.getTime()+Math.max(100,Math.min(30_000,idleTimeoutMs/4)));
    try{
      const task=await this.store.findTask(taskId);
      if(!task||task.executionMode!=="live"||task.terminalReason||!isActiveTaskStatus(task.status))return;
      await refreshSandboxRunActivity(this.store,task.runId,{idleTimeoutMs,now});
    }catch{
      this.terminalActivityRefreshAfter.delete(taskId);
    }
  }

  async listTaskInputs(userId: string, taskId: string): Promise<TaskInputSnapshotEntry[]> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    if (task.executionMode !== "live") return [];
    const manifest = await this.readTaskInputManifest(task);
    return manifest.map((entry) => ({
      path: entry.path,
      name: path.posix.basename(entry.path),
      bytes: entry.size,
      sha256: entry.digest.replace(/^sha256:/, "")
    }));
  }

  async downloadTaskInput(userId: string, taskId: string, inputPath: string): Promise<TaskInputDownload> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    const normalized = normalizeTaskInputPaths([inputPath])[0];
    if (!normalized) throw new ProductError("Task input path is required", 400);
    const manifest = await this.readTaskInputManifest(task);
    const entry = manifest.find((candidate) => candidate.path === normalized);
    if (!entry) throw new ProductError("Task input not found", 404);
    const project = await this.store.findProject(task.projectId);
    if (!project) throw new ProductError("Task project not found", 409);
    const snapshotRoot = path.resolve(this.config.dataRoot, project.rootPath, "tasks", task.id, "inputs");
    const filePath = path.resolve(snapshotRoot, ...entry.path.split("/"));
    assertPathInside(snapshotRoot, filePath, "Task input path is outside the snapshot");
    try {
      const bytes = await readRegularFileWithoutFollowingSymlink(filePath);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (bytes.byteLength !== entry.size || digest !== entry.digest) {
        throw new ProductError("Task input snapshot no longer matches its manifest", 409);
      }
      return {
        input: { path: entry.path, name: path.posix.basename(entry.path), bytes: entry.size, sha256: entry.digest.replace(/^sha256:/, "") },
        bytes
      };
    } catch (error) {
      if (isNotFound(error)) throw new ProductError("Task input file not found", 404);
      throw error;
    }
  }

  async sendTaskMessage(userId: string, taskId: string, content: string, idempotencyKey?: string): Promise<TaskMessageReceipt> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "write");
    const text = requireNonEmptyString(content, "task.message.content");
    return this.runIdempotentTaskOperation({
      actorId: userId,
      projectId: task.projectId,
      operation: taskOperation("message"),
      key: idempotencyKey,
      request: { taskId, content: text }
    }, newId("message"), async (id) => {
      const existing = await this.store.findTaskMessage(id);
      if (existing) return this.messageReceipt(userId, await this.dispatchTaskMessage(existing), false);
      const current = await this.store.findTask(task.id);
      if (!current || current.deletedAt) throw new ProductError("Task not found", 404);
      if (!await this.taskExecutionEligible(current)) throw new ProductError("Task is no longer eligible to receive messages", 409);
      const timestamp = nowIso();
      const message: PersistedTaskMessage = {
        id,
        taskId: task.id,
        actorId: userId,
        content: text,
        targetTaskId: null,
        deliveryKey: deliveryKeyForMessage(id, task.runId),
        requestHash: deliveryRequestHash(text),
        claimToken: null,
        receipt: null,
        timelineCursor: null,
        deliveryStatus: "pending",
        claimedAt: null,
        leaseExpiresAt: null,
        attemptCount: 0,
        nextRetryAt: null,
        safeError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null
      };
      let persisted: PersistedTaskMessage;
      if (isTerminalTask(current)) {
        persisted = await this.createTerminalTaskMessage(message, current);
      } else {
        const pendingProjection = await this.prepareProductInteractionChange(messageProductSource(message));
        const queued = await this.store.createPendingTaskMessage(message, pendingProjection?.change);
        if (queued) persisted = queued;
        else {
          const terminalSource = await this.store.findTask(task.id);
          if (!terminalSource) throw new ProductError("Task not found", 404);
          persisted = await this.createTerminalTaskMessage(message, terminalSource);
        }
      }
      const dispatched = await this.dispatchTaskMessage(persisted);
      await this.policies.recordOperation(task.projectId, userId, "task.message.create", "accepted", task.id, "task", messageAuditDetail(task.id, dispatched));
      return this.messageReceipt(userId, dispatched, false);
    });
  }

  async editTaskMessage(userId: string, taskId: string, messageId: string, content: string, idempotencyKey?: string): Promise<TaskMessageReceipt> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "write");
    const text = requireNonEmptyString(content, "task.message.content");
    return this.runIdempotentTaskOperation({ actorId:userId, projectId:task.projectId, operation:taskOperation("message-edit"), key:idempotencyKey, request:{taskId,messageId,content:text} }, messageId, async () => {
      const source = await this.store.findTask(task.id);
      if (!source || source.deletedAt) throw new ProductError("Task not found", 404);
      if (!await this.taskExecutionEligible(source)) throw new ProductError("Task is no longer eligible to receive messages", 409);
      const message = await this.store.findTaskMessage(messageId);
      if (!message || message.taskId !== task.id) throw new ProductError("Task message not found", 404);
      const updatedAt = strictlyLaterIso(message.updatedAt ?? message.createdAt);
      const projectedMessage = { ...message, content:text, requestHash:deliveryRequestHash(text), updatedAt };
      const projection = await this.prepareProductInteractionChange(messageProductSource(projectedMessage));
      const updated = await this.store.updatePendingTaskMessage(messageId, text, projectedMessage.requestHash, updatedAt, projection?.change);
      if (!updated) throw new ProductError("Only a pending message can be edited", 409);
      await this.policies.recordOperation(task.projectId,userId,"task.message.edit","accepted",task.id,"task",messageAuditDetail(task.id,updated));
      return this.messageReceipt(userId, updated, false);
    });
  }

  async deleteTaskMessage(userId: string, taskId: string, messageId: string, idempotencyKey?: string): Promise<TaskMessageReceipt> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "write");
    return this.runIdempotentTaskOperation({ actorId:userId, projectId:task.projectId, operation:taskOperation("message-delete"), key:idempotencyKey, request:{taskId,messageId} }, messageId, async () => {
      const source = await this.store.findTask(task.id);
      if (!source || source.deletedAt) throw new ProductError("Task not found", 404);
      const message = await this.store.findTaskMessage(messageId);
      if (!message || message.taskId !== task.id) throw new ProductError("Task message not found", 404);
      const deletedAt = strictlyLaterIso(message.updatedAt ?? message.createdAt);
      const deleted = message.deletedAt ? message : await this.store.deletePendingTaskMessage(messageId, deletedAt);
      if (!deleted) throw new ProductError("Only a pending message can be deleted", 409);
      await this.policies.recordOperation(task.projectId,userId,"task.message.delete","accepted",task.id,"task",{taskId:task.id,messageId});
      return { messageId, disposition:"accepted_by_active_run", targetTaskId:task.id, duplicate:false, queuedMessage:null, interaction:null, capabilities:await this.taskCapabilities(userId, source) };
    });
  }

  async retryTask(userId: string, taskId: string, idempotencyKey?: string): Promise<AgentTask> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "write");
    return this.createTaskOperation(userId,task.projectId,{endpointId:task.endpointId,prompt:task.prompt,...(task.title?{title:task.title}:{}),...(task.inputPaths?{inputPaths:task.inputPaths}:{})},"retry",idempotencyKey,task.id);
  }

  async duplicateTask(userId: string, taskId: string, idempotencyKey?: string): Promise<AgentTask> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "write");
    return this.createTaskOperation(userId,task.projectId,{endpointId:task.endpointId,prompt:task.prompt,...(task.title?{title:task.title}:{}),...(task.inputPaths?{inputPaths:task.inputPaths}:{})},"duplicate",idempotencyKey,task.id);
  }

  async editTask(userId:string,taskId:string,title:string,idempotencyKey?:string):Promise<AgentTask>{
    const task=await this.requireTaskRecordForUser(userId,taskId,"write");const normalized=normalizeTaskTitle(title,task.prompt);
    const result=await this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"edit",key:idempotencyKey,request:{taskId,title:normalized}},task.id,async()=>{const updated=await this.store.updateTaskTitle(task.id,normalized,nowIso());if(!updated)throw new ProductError("Task not found",404);await this.policies.recordOperation(task.projectId,userId,"task.edit","accepted",task.id,"task",{taskId:task.id});return publicTask(updated);});
    return publicTask(await this.store.findTask(result.id)??task);
  }

  async archiveTask(userId:string,taskId:string,idempotencyKey?:string):Promise<AgentTask>{
    const task=await this.requireTaskRecordForUser(userId,taskId,"write");
    return this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"archive",key:idempotencyKey,request:{taskId}},task.id,async()=>{const current=await this.store.findTask(task.id);if(!current||current.deletedAt)throw new ProductError("Task not found",404);const archived=current.archivedAt?current:await this.store.archiveTask(task.id,nowIso());if(!archived)throw new ProductError("Only a terminal task can be archived",409);await this.policies.recordOperation(task.projectId,userId,"task.archive","accepted",task.id,"task",{taskId:task.id});return publicTask(archived);});
  }

  async deleteTask(userId:string,taskId:string,idempotencyKey?:string):Promise<{deleted:true;taskId:string}>{
    const task=await this.store.findTask(taskId);if(!task)throw new ProductError("Task not found",404);await this.workspaces.requireProjectForUser(userId,task.projectId,"write");
    return this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"delete",key:idempotencyKey,request:{taskId}},task.id,async()=>{const current=await this.store.findTask(task.id);if(!current)throw new ProductError("Task not found",404);if(!current.terminalReason)throw new ProductError("Only a terminal task can be deleted",409);if(current.executionMode==="live"&&current.cleanupStatus!=="completed")throw new ProductError("Task cleanup is still pending",409);const project=await this.store.findProject(task.projectId);if(!project)throw new ProductError("Task project not found",409);const taskRoot=path.resolve(this.config.dataRoot,project.rootPath,"tasks",task.id);assertPathInside(path.resolve(this.config.dataRoot),taskRoot,"Task data directory is outside the data root");await rm(taskRoot,{recursive:true,force:true});const deleted=await this.store.deleteTaskData(task.id,nowIso());if(!deleted)throw new ProductError("Only a terminal task can be deleted",409);await this.policies.refreshFileAlerts(task.projectId);await this.policies.recordOperation(task.projectId,userId,"task.delete","accepted",task.id,"task",{taskId:task.id});return{deleted:true as const,taskId};});
  }

  async syncActiveTasksOnce(): Promise<ActiveTaskSyncResult> {
    const result: ActiveTaskSyncResult = {
      activeTaskCount: 0,
      syncedTaskIds: [],
      failedTaskIds: []
    };
    for(const intent of await this.store.listTaskStartIntentsDue(nowIso(),100)){try{await this.dispatchTaskStart(intent);result.syncedTaskIds.push(intent.id);}catch{result.failedTaskIds.push(intent.id);}}
    for(const message of await this.store.listTaskMessagesDue(nowIso(),100)){try{await this.dispatchTaskMessage(message,true);}catch{result.failedTaskIds.push(message.taskId);}}
    const activeTasks = await this.store.listActiveTasks();
    result.activeTaskCount=activeTasks.length;
    for (const task of activeTasks) {
      if(task.startIntentStatus!=="dispatched")continue;
      try {
        await this.syncTaskTimeline(task);
        result.syncedTaskIds.push(task.id);
      } catch {
        result.failedTaskIds.push(task.id);
      }
    }
    for(const task of await this.store.listTasksForArtifactProjection(nowIso(),100)){try{await this.drainTaskArtifacts(task);}catch{result.failedTaskIds.push(task.id);}}
    for(const task of await this.store.listTasksForCleanup(nowIso(),100)){try{await this.cleanupTaskRuntime(task);}catch{result.failedTaskIds.push(task.id);}}
    result.syncedTaskIds=[...new Set(result.syncedTaskIds)];result.failedTaskIds=[...new Set(result.failedTaskIds)];
    return result;
  }

  async cancelTask(userId: string, taskId: string, idempotencyKey?:string): Promise<AgentTask> {
    const task=await this.requireTaskRecordForUser(userId,taskId,"write");
    const result=await this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"cancel",key:idempotencyKey,request:{taskId}},task.id,async()=>{const current=await this.store.findTask(task.id);if(!current||current.deletedAt)throw new ProductError("Task not found",404);return publicTask(await this.finalizeTaskLifecycle(task.id,"cancelled",userId));});
    const persisted=await this.store.findTask(result.id);
    if(persisted?.executionMode==="live"&&!isTerminalTask(task)&&persisted.terminalReason==="cancelled")await this.bestEffortAbortAndRequestCleanup(persisted);
    return persisted ? publicTask(persisted) : result;
  }

  async finalizeTaskForRunCleanup(taskId:string,reason:Extract<TaskTerminalReason,"failed"|"expired"|"cancelled">):Promise<void>{
    const task=await this.store.findTask(taskId);
    if(!task||task.terminalReason)return;
    await this.finalizeTaskLifecycle(taskId,isTerminalTaskStatus(task.status)?terminalReasonForStatus(task.status):reason,null);
  }

  async canCleanupTaskRuntime(taskId:string):Promise<boolean>{
    const task=await this.store.findTask(taskId);
    return !task||task.cleanupStatus==="running"||task.cleanupStatus==="completed";
  }

  private async dispatchTaskStart(candidate:PersistedAgentTask):Promise<PersistedAgentTask>{
    let task=await this.store.findTask(candidate.id)??candidate;
    if(task.startIntentStatus==="dispatched"||task.startIntentStatus==="failed"||task.terminalReason)return task;
    const timestamp=nowIso();
    const leaseExpiresAt=deadlineIso(timestamp,this.deliveryLeaseMs());
    if(task.startIntentStatus==="dispatching"){
      if(!task.startClaimToken||!task.startLeaseExpiresAt||task.startLeaseExpiresAt>timestamp)return task;
      const reconciled=await this.reconcileStartDelivery(task);
      if(reconciled)return reconciled;
      const reclaimed=await this.store.reclaimTaskStart({id:task.id,expectedClaimToken:task.startClaimToken,claimToken:newId("delivery_claim"),claimedAt:timestamp,leaseExpiresAt});
      if(!reclaimed)return await this.store.findTask(task.id)??task;
      task=reclaimed;
    }else{
      const claimed=await this.store.claimTaskStart({id:task.id,claimToken:newId("delivery_claim"),claimedAt:timestamp,leaseExpiresAt});
      if(!claimed)return await this.store.findTask(task.id)??task;
      task=claimed;
    }
    await this.persistInitialPromptInteraction(task);
    const claimToken=task.startClaimToken!;
    const serviceKey=this.serviceKeyForTask(task);
    const state=await this.readRuntimeState(task,serviceKey);
    let postAttempted=false;
    try{
      const run=await this.store.sandboxRuns.get(task.runId);
      if(!run||run.taskId!==task.id)throw new ProductError("Task sandbox runtime state not found",409);
      if(run.phase==="starting"){
        const endpoint=await this.endpoints.requireEndpointForProject(task.projectId,task.endpointId);
        requireTaskEndpointCapabilities(endpoint);
        await this.startLiveSandbox({endpoint,task,run,serviceKey});
        await this.claimLiveRunForPrompt(run.runId);
      }else if(run.phase!=="running")throw new ProductError("Sandbox run is no longer eligible to receive a prompt",409);
      postAttempted=true;
      const receipt=await this.postDelivery(state,serviceKey,task.prompt);
      if(!receipt.accepted){const failed=await this.store.failTaskStart({id:task.id,claimToken,safeError:"Botified did not accept task prompt",updatedAt:nowIso()});if(failed)await this.persistInitialPromptInteraction(failed);return this.finalizeTaskLifecycle(task.id,"failed",null);}
      const persisted=await this.store.recordTaskStartReceipt({id:task.id,claimToken,receipt,timelineCursor:null,updatedAt:nowIso()});
      if(!persisted)throw new ProductError("Task start delivery claim changed before receipt persistence",409);
      await this.persistInitialPromptInteraction(persisted);
      return persisted;
    }catch(error){
      const safeError=safeTaskStageError(error);
      const deferred=await this.store.deferTaskStart({id:task.id,claimToken,safeError,nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()),updatedAt:nowIso(),releaseClaim:!postAttempted});
      if(deferred)await this.persistInitialPromptInteraction(deferred);
      if(postAttempted)await this.bestEffortPersistLiveStartupFailure(task.runId,"send message",error);
      throw error;
    }
  }

  private async reconcileStartDelivery(task:PersistedAgentTask):Promise<PersistedAgentTask|null>{
    if(!task.startClaimToken||!task.startDeliveryKey||!task.startRequestHash)return task;
    const serviceKey=this.serviceKeyForTask(task);const state=await this.readRuntimeState(task,serviceKey);
    if(!this.botified.queryDeliveryReceipt)throw new ProductError("Botified delivery query API is required",502);
    let receipt:BotifiedDeliveryReceipt|null;
    try{receipt=await this.botified.queryDeliveryReceipt(state.baseUrl,serviceKey,task.startDeliveryKey);}catch(error){const deferred=await this.store.deferTaskStart({id:task.id,claimToken:task.startClaimToken,safeError:safeTaskStageError(error),nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()),updatedAt:nowIso()});if(deferred)await this.persistInitialPromptInteraction(deferred);return task;}
    if(!receipt)return null;
    if(receipt.requestHash!==task.startRequestHash)throw new ProductError("Botified start delivery receipt hash mismatch",409);
    const persisted=await this.store.recordTaskStartReceipt({id:task.id,claimToken:task.startClaimToken,receipt,timelineCursor:null,updatedAt:nowIso()});
    if(!persisted)return await this.store.findTask(task.id);
    await this.persistInitialPromptInteraction(persisted);
    return persisted;
  }

  private async dispatchTaskMessage(candidate: PersistedTaskMessage, completeIdempotency = false): Promise<PersistedTaskMessage> {
    const current = await this.store.findTaskMessage(candidate.id) ?? candidate;
    if (this.messageDispatchTaskIds.has(current.taskId)) return current;
    this.messageDispatchTaskIds.add(current.taskId);
    try {
      return await this.dispatchTaskMessageExclusive(current, completeIdempotency);
    } finally {
      this.messageDispatchTaskIds.delete(current.taskId);
    }
  }

  private async dispatchTaskMessageExclusive(candidate: PersistedTaskMessage, completeIdempotency: boolean): Promise<PersistedTaskMessage> {
    let message = await this.store.findTaskMessage(candidate.id) ?? candidate;
    if (message.deletedAt || ["accepted", "successor_created", "failed"].includes(message.deliveryStatus ?? "")) {
      if (completeIdempotency) await this.completeMessageIdempotency(message);
      return message;
    }
    let source = await this.store.findTask(message.taskId);
    if (!source) throw new ProductError("Task not found", 404);
    if (!isTerminalTask(source) && source.startIntentStatus !== "dispatched") return message;
    if ((message.deliveryStatus ?? "pending") === "pending") {
      const firstWaiting = (await this.store.listTaskMessages(source.id)).find((candidate) => ["pending", "dispatching", "terminal_pending"].includes(candidate.deliveryStatus ?? "pending"));
      if (firstWaiting?.id !== message.id || !await this.runtimeCanStartTaskTurn(source)) return message;
    }
    const timestamp = nowIso();
    if (message.deliveryStatus === "dispatching" || message.deliveryStatus === "terminal_pending") {
      if (!message.claimToken || !message.leaseExpiresAt || message.leaseExpiresAt > timestamp) return message;
      const reconciled = await this.reconcileTaskMessageDelivery(message, source);
      if (reconciled) {
        await this.persistMessageInteraction(reconciled);
        if (completeIdempotency && isSettledMessage(reconciled)) await this.completeMessageIdempotency(reconciled);
        return reconciled;
      }
      source = await this.store.findTask(source.id) ?? source;
      if (isTerminalTask(source)) return this.createSuccessorForClaimedMessage(message, source, completeIdempotency);
      const reclaimed = await this.store.reclaimTaskMessage({ id:message.id, expectedClaimToken:message.claimToken, claimToken:newId("delivery_claim"), claimedAt:timestamp, leaseExpiresAt:deadlineIso(timestamp,this.deliveryLeaseMs()) });
      if (!reclaimed) return await this.store.findTaskMessage(message.id) ?? message;
      message = reclaimed;
      await this.persistMessageInteraction(message);
    } else {
      const claimed = await this.store.claimTaskMessage({ id:message.id, claimToken:newId("delivery_claim"), claimedAt:timestamp, leaseExpiresAt:deadlineIso(timestamp,this.deliveryLeaseMs()) });
      if (!claimed) return await this.store.findTaskMessage(message.id) ?? message;
      message = claimed;
      await this.persistMessageInteraction(message);
      source = await this.store.findTask(source.id) ?? source;
      if (isTerminalTask(source)) return this.createSuccessorForClaimedMessage(message, source, completeIdempotency);
    }
    const claimToken = message.claimToken!;
    const serviceKey = this.serviceKeyForTask(source);
    const state = await this.readRuntimeState(source, serviceKey);
    try {
      const receipt = await this.postDeliveryMessage(state.baseUrl, serviceKey, message.content, message.deliveryKey!, message.requestHash!);
      if (!receipt.accepted) {
        const failed = await this.store.failTaskMessage({ id:message.id, claimToken, safeError:"Botified did not accept task message", updatedAt:nowIso() });
        if (failed) await this.persistMessageInteraction(failed);
        if (completeIdempotency && failed) await this.completeMessageIdempotency(failed);
        return failed ?? message;
      }
      const receiptCursor = safeRuntimeCursor(receipt.cursor) ?? null;
      const accepted = await this.store.recordTaskMessageReceipt({ id:message.id, claimToken, receipt, timelineCursor:receiptCursor, updatedAt:nowIso() });
      if (!accepted) throw new ProductError("Task message delivery claim changed before receipt persistence", 409);
      await this.persistMessageInteraction(accepted);
      await this.bestEffortSyncTaskTimeline(source);
      if (completeIdempotency) await this.completeMessageIdempotency(accepted);
      return accepted;
    } catch (error) {
      const deferred = await this.store.deferTaskMessage({ id:message.id, claimToken, safeError:safeTaskStageError(error), nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()), updatedAt:nowIso() });
      if (deferred) await this.persistMessageInteraction(deferred);
      return await this.store.findTaskMessage(message.id) ?? message;
    }
  }

  private async reconcileTaskMessageDelivery(message: PersistedTaskMessage, source: PersistedAgentTask): Promise<PersistedTaskMessage | null> {
    if (!message.claimToken || !message.deliveryKey || !message.requestHash) return message;
    const serviceKey = this.serviceKeyForTask(source);
    const state = await this.readRuntimeState(source, serviceKey);
    if (!this.botified.queryDeliveryReceipt) throw new ProductError("Botified delivery query API is required", 502);
    let receipt: BotifiedDeliveryReceipt | null;
    try {
      receipt = await this.botified.queryDeliveryReceipt(state.baseUrl, serviceKey, message.deliveryKey);
    } catch (error) {
      const deferred = await this.store.deferTaskMessage({ id:message.id, claimToken:message.claimToken, safeError:safeTaskStageError(error), nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()), updatedAt:nowIso() });
      if (deferred) await this.persistMessageInteraction(deferred);
      return message;
    }
    if (!receipt) return null;
    if (receipt.requestHash !== message.requestHash) throw new ProductError("Botified task message delivery receipt hash mismatch", 409);
    const receiptCursor = safeRuntimeCursor(receipt.cursor) ?? null;
    return await this.store.recordTaskMessageReceipt({ id:message.id, claimToken:message.claimToken, receipt, timelineCursor:receiptCursor, updatedAt:nowIso() })
      ?? await this.store.findTaskMessage(message.id);
  }

  private async createTerminalTaskMessage(message: PersistedTaskMessage, source: PersistedAgentTask): Promise<PersistedTaskMessage> {
    const successor = await this.prepareSuccessorCreate(source, message);
    const projectedMessage = { ...message, targetTaskId:successor.task.id, deliveryStatus:"successor_created" as const };
    const messageProjection = await this.prepareProductInteractionChange(messageProductSource(projectedMessage));
    const successorProjection = await this.prepareProductInteractionChange(initialPromptProductSource(successor.task), successor.task);
    let created:PersistedTaskMessage|null;
    try{created=await this.store.createTerminalTaskMessage({ message, successor, ...(messageProjection?{messageInteractionChange:messageProjection.change}:{}), ...(successorProjection?{successorInteractionChange:successorProjection.change}:{}) });}
    catch(error){await this.cleanupUnusedTaskCreate(successor);throw error;}
    if (!created) {
      await this.cleanupUnusedTaskCreate(successor);
      throw activeTasksLimitError();
    }
    return created;
  }

  private async createSuccessorForClaimedMessage(message: PersistedTaskMessage, source: PersistedAgentTask, completeIdempotency = false): Promise<PersistedTaskMessage> {
    const successor = await this.prepareSuccessorCreate(source, message);
    const updatedAt=nowIso();
    const projectedMessage={...message,targetTaskId:successor.task.id,deliveryStatus:"successor_created" as const,updatedAt};
    const messageProjection=await this.prepareProductInteractionChange(messageProductSource(projectedMessage));
    const successorProjection=await this.prepareProductInteractionChange(initialPromptProductSource(successor.task),successor.task);
    let resolved:PersistedTaskMessage|null;
    try{resolved=await this.store.resolveTerminalPendingMessage({ messageId:message.id, expectedClaimToken:message.claimToken!, successor, updatedAt, ...(messageProjection?{messageInteractionChange:messageProjection.change}:{}), ...(successorProjection?{successorInteractionChange:successorProjection.change}:{}) });}
    catch(error){await this.cleanupUnusedTaskCreate(successor);throw error;}
    if (!resolved) {
      await this.cleanupUnusedTaskCreate(successor);
      return await this.store.findTaskMessage(message.id) ?? message;
    }
    if (completeIdempotency) await this.completeMessageIdempotency(resolved);
    return resolved;
  }

  private async prepareSuccessorCreate(source: PersistedAgentTask, message: PersistedTaskMessage): Promise<AtomicTaskCreateInput> {
    const project = await this.store.findProject(source.projectId);
    if (!project) throw new ProductError("Task project not found", 409);
    const endpoint = await this.endpoints.requireEndpointForProject(source.projectId, source.endpointId);
    return this.prepareTaskCreate({ id:newId("task"), project, endpoint, prompt:message.content, title:normalizeTaskTitle(undefined,message.content), inputPaths:source.inputPaths??[], sourceTaskId:source.id, agentContext:source.agentContext??"", createdByUserId:message.actorId??source.createdByUserId??null });
  }

  private async cleanupUnusedTaskCreate(create:AtomicTaskCreateInput):Promise<void>{if(create.task.executionMode!=="live")return;const project=await this.store.findProject(create.task.projectId);if(project)await this.bestEffortRemoveUnpersistedTaskData(project.rootPath,create.task.id);}

  private async finalizeTaskLifecycle(taskId:string,reason:TaskTerminalReason,actorId:string|null):Promise<PersistedAgentTask>{
    for(let attempt=0;attempt<3;attempt+=1){
      const task=await this.store.findTask(taskId);if(!task)throw new ProductError("Task not found",404);if(task.terminalReason){if(task.terminalReason==="failed")await this.policies.evaluateTaskFailure(task.projectId,task.endpointId);return task;}
      const messages=await this.store.listTaskMessages(taskId);
      const pending=messages.filter((message)=>(message.deliveryStatus??"pending")==="pending");
      const successors:Awaited<ReturnType<TaskService["prepareSuccessorCreate"]>>[]=[];
      for(const message of pending)successors.push(await this.prepareSuccessorCreate(task,message));
      const timestamp=nowIso();const auditAction=taskAuditActionForReason(reason);
      const successorInputs:TaskLifecycleSuccessor[]=[];
      for(let index=0;index<pending.length;index+=1){
        const message=pending[index]!;const create=successors[index]!;
        const success=await this.prepareProductInteractionChange(messageProductSource({...message,targetTaskId:create.task.id,deliveryStatus:"successor_created",updatedAt:timestamp}));
        const failure=await this.prepareProductInteractionChange(messageProductSource({...message,deliveryStatus:"failed",safeError:ACTIVE_TASKS_LIMIT_MESSAGE,updatedAt:timestamp}));
        const successorPrompt=await this.prepareProductInteractionChange(initialPromptProductSource(create.task),create.task);
        successorInputs.push({messageId:message.id,create,...(success?{messageSuccessInteractionChange:success.change}:{}),...(failure?{messageFailureInteractionChange:failure.change}:{}),...(successorPrompt?{successorInteractionChange:successorPrompt.change}:{})});
      }
      const terminalPendingChanges:TaskLifecycleTerminalPendingChange[]=[];
      for(const message of messages.filter((candidate)=>["pending","dispatching"].includes(candidate.deliveryStatus??"pending"))){
        const projection=await this.prepareProductInteractionChange(messageProductSource({...message,deliveryStatus:"terminal_pending",updatedAt:timestamp}));
        if(projection)terminalPendingChanges.push({messageId:message.id,interactionChange:projection.change});
      }
      let result:FinalizeTaskLifecycleResult|null;
      try{result=await this.store.finalizeTaskLifecycle({taskId,terminalReason:reason,updatedAt:timestamp,auditEvent:{id:newId("audit"),projectId:task.projectId,actorId,action:auditAction,status:"accepted",resourceKind:"task",resourceId:task.id,detail:{endpointId:task.endpointId},createdAt:timestamp},successors:successorInputs,terminalPendingChanges});}
      catch(error){for(const create of successors)await this.cleanupUnusedTaskCreate(create);throw error;}
      if(!result)throw new ProductError("Task not found",404);
      if(result.missingPendingMessageIds.length){for(const create of successors)await this.cleanupUnusedTaskCreate(create);continue;}
      const created=new Set(result.successorTaskIds);for(const create of successors)if(!created.has(create.task.id))await this.cleanupUnusedTaskCreate(create);
      for(const message of await this.store.listTaskMessages(task.id))if(["accepted","terminal_pending","successor_created","failed"].includes(message.deliveryStatus??""))await this.completeMessageIdempotency(message);
      if(result.task.terminalReason==="failed")await this.policies.evaluateTaskFailure(result.task.projectId,result.task.endpointId);
      return result.task;
    }
    throw new ProductError("Task message state changed during finalization",409);
  }

  private async bestEffortAbortAndRequestCleanup(task:PersistedAgentTask):Promise<void>{
    try{const serviceKey=this.serviceKeyForTask(task);const state=await this.readRuntimeState(task,serviceKey);await this.botified.abort(state.baseUrl,serviceKey);}catch{}
  }

  private async drainTaskArtifacts(task:PersistedAgentTask):Promise<void>{
    const timestamp=nowIso();const claimToken=newId("artifact_claim");const claimed=await this.store.claimTaskArtifactProjection({id:task.id,claimToken,claimedAt:timestamp,leaseExpiresAt:deadlineIso(timestamp,this.maintenanceLeaseMs())});if(!claimed)return;
    try{
      const unresolvedMessage=(await this.store.listTaskMessages(claimed.id)).some((message)=>message.deliveryStatus==="dispatching"||message.deliveryStatus==="terminal_pending");
      if(unresolvedMessage)throw new ProductError("Task message delivery reconciliation is pending",409);
      try {
        let delivered:PersistedAgentTask|null=claimed;
        if(claimed.startIntentStatus==="dispatching"){
          const reconciled=await this.reconcileStartDelivery(claimed);
          if(reconciled===null)delivered=null;
          else if(reconciled.startIntentStatus==="dispatched")delivered=reconciled;
          else throw new ProductError("Task start delivery reconciliation is still uncertain",502);
        }
        if(delivered?.startIntentStatus==="dispatched")await this.syncTaskTimeline(delivered,{updateRunLifecycle:false,preserveTerminalStatus:true});
      } catch (error) {
        if ((claimed.artifactProjectionAttemptCount ?? 0) < MAX_TERMINAL_RUNTIME_SYNC_ATTEMPTS) throw error;
        await this.failUnconfirmedTaskStart(claimed);
        await this.markTaskInteractionHistoryGap(claimed.id);
      }
      await this.projectSandboxArtifactFiles(claimed);
      if(claimed.terminalReason==="failed")await this.policies.evaluateTaskFailure(claimed.projectId,claimed.endpointId);
      if(!await this.store.completeTaskArtifactProjection({id:task.id,claimToken,updatedAt:nowIso()}))throw new ProductError("Task artifact drain fence changed",409);
    }catch(error){await this.store.failTaskArtifactProjection({id:task.id,claimToken,safeError:safeTaskStageError(error),nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()),updatedAt:nowIso()});throw error;}
  }

  private async failUnconfirmedTaskStart(task: PersistedAgentTask): Promise<void> {
    if (task.startIntentStatus !== "dispatching" || !task.startClaimToken) return;
    const failed = await this.store.failTaskStart({
      id: task.id,
      claimToken: task.startClaimToken,
      safeError: "Initial prompt delivery could not be confirmed before runtime cleanup",
      updatedAt: nowIso()
    });
    if (failed) await this.persistInitialPromptInteraction(failed);
  }

  private async markTaskInteractionHistoryGap(taskId: string): Promise<void> {
    const snapshot = await this.store.readTaskInteractionSnapshot(taskId, null, 1);
    if (!snapshot || snapshot.historyStatus === "gap") return;
    await this.store.persistTaskInteractionMutation({
      taskId,
      changes: [],
      sourceSync: {
        expectedSourceCursor: snapshot.sourceCursor,
        sourceCursor: snapshot.sourceCursor,
        historyStatus: "gap",
        lastSyncedAt: nowIso()
      }
    });
  }

  private async cleanupTaskRuntime(task:PersistedAgentTask):Promise<void>{
    const timestamp=nowIso();const claimToken=newId("cleanup_claim");const claimed=await this.store.claimTaskCleanup({id:task.id,claimToken,claimedAt:timestamp,leaseExpiresAt:deadlineIso(timestamp,this.maintenanceLeaseMs())});if(!claimed)return;
    try{
      if(claimed.executionMode==="live"){
        await requestSandboxRunCleanup(this.store,claimed.runId,{phase:cleanupPhaseForTaskStatus(claimed.status),cleanupStatus:"cleanup_requested"});
        if(!this.config.sandboxLifecycle)throw new ProductError("Sandbox lifecycle service is not configured",500);
        let cleanupComplete=false;
        let cleanupError=false;
        for(let attempt=0;attempt<30;attempt+=1){
          const cleanup=await this.config.sandboxLifecycle.reapSandboxRunsOnce({runId:claimed.runId,apply:true});
          cleanupError=cleanup.errors.length>0;
          const run=await this.store.sandboxRuns.get(claimed.runId);
          const resourcesRemain=Object.values(cleanup.observedResourceCounts).some((count)=>count>0);
          cleanupComplete=!resourcesRemain&&(!run||run.cleanupStatus==="cleaned"||run.phase==="cleaned");
          if(cleanupComplete)break;
          await new Promise((resolve)=>setTimeout(resolve,500));
        }
        if(!cleanupComplete)throw new ProductError(cleanupError?"Sandbox cleanup failed":"Sandbox cleanup is still pending",409);
        await this.removeTransientTaskRuntime(claimed);
      }
      if(!await this.store.completeTaskCleanup({id:claimed.id,claimToken,updatedAt:nowIso()}))throw new ProductError("Task cleanup fence changed",409);
    }catch(error){await this.store.failTaskCleanup({id:claimed.id,claimToken,safeError:safeTaskStageError(error),nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()),updatedAt:nowIso()});throw error;}
  }

  private async removeTransientTaskRuntime(task:PersistedAgentTask):Promise<void>{const project=await this.store.findProject(task.projectId);if(!project)return;const root=path.resolve(this.config.dataRoot,project.rootPath,"tasks",task.id);const dataRoot=path.resolve(this.config.dataRoot);assertPathInside(dataRoot,root,"Task runtime directory is outside the data root");for(const name of ["home","botified"])await rm(path.resolve(root,name),{recursive:true,force:true});}

  private deliveryLeaseMs():number{return resolveDurationMs(this.config.deliveryLeaseMs,DEFAULT_DELIVERY_LEASE_MS);}
  private maintenanceLeaseMs():number{return resolveDurationMs(this.config.maintenanceLeaseMs,DEFAULT_MAINTENANCE_LEASE_MS);}
  private retryDelayMs():number{return resolveDurationMs(this.config.retryDelayMs,DEFAULT_TASK_RETRY_DELAY_MS);}

  async taskInteractions(userId: string, taskId: string, query: { cursor?: string; limit?: number } = {}): Promise<TaskInteractionSnapshot> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    await this.ensureTaskConversation(task);
    const before = query.cursor ? this.decodeInteractionCursor(task, query.cursor, "history") : null;
    const limit = Math.min(INTERACTION_HISTORY_PAGE_LIMIT, Math.max(1, Math.floor(query.limit ?? 50)));
    const snapshot = await this.store.readTaskInteractionSnapshot(task.id, before?.anchor ?? null, limit);
    if (!snapshot) throw new ProductError("Task not found", 404);
    const current = await this.store.findTask(task.id) ?? task;
    const suppressedInteractionIds = new Set(snapshot.suppressedInteractionIds);
    const state = await this.taskInteractionState(userId, current, snapshot);
    return {
      items: snapshot.items.filter((item)=>!suppressedInteractionIds.has(item.id)),
      queuedMessages: state.queuedMessages,
      nextPageCursor: snapshot.nextPageAnchor ? this.encodeInteractionCursor(current, "history", snapshot.latestChangeSeq, snapshot.nextPageAnchor) : null,
      hasMoreBefore: snapshot.hasMoreBefore,
      streamCursor: this.encodeInteractionCursor(current, "stream", snapshot.latestChangeSeq),
      runState: state.runState,
      runtimeReachability: state.runtimeReachability,
      historyStatus: state.historyStatus,
      lastSyncedAt: state.lastSyncedAt,
      capabilities: state.capabilities
    };
  }

  async taskInteractionChanges(userId: string, taskId: string, cursor: string, limit = INTERACTION_SYNC_PAGE_LIMIT): Promise<TaskInteractionChangePage> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "view");
    const decoded = this.decodeInteractionCursor(task, cursor, "stream");
    if (!task.deletedAt) await this.ensureTaskConversation(task);
    const snapshot = await this.store.readTaskInteractionSnapshot(task.id, null, 1);
    if (!snapshot) throw new ProductError("Task not found", 404);
    if (decoded.changeSeq > snapshot.latestChangeSeq) throw new ProductError("Task interaction cursor is invalid for this task", 400);
    const changes = await this.store.listTaskInteractionChanges(task.id, decoded.changeSeq, Math.min(INTERACTION_SYNC_PAGE_LIMIT, Math.max(1, limit)));
    const suppressedInteractionIds = new Set(snapshot.suppressedInteractionIds);
    const lastSeq = changes.at(-1)?.changeSeq ?? decoded.changeSeq;
    const current = await this.store.findTask(task.id) ?? task;
    return {
      changes: changes.filter((change)=>!suppressedInteractionIds.has(change.interaction.id)).map((change) => ({ cursor:this.encodeInteractionCursor(task,"stream",change.changeSeq), item:change.interaction })),
      streamCursor: this.encodeInteractionCursor(task, "stream", lastSeq),
      done: Boolean(current.deletedAt),
      state: await this.taskInteractionState(userId, current, snapshot)
    };
  }

  async *streamTaskAssistantPreviews(userId: string, taskId: string, signal?: AbortSignal): AsyncIterable<TaskAssistantPreviewUpdate> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    if (task.executionMode !== "live" || task.terminalReason || !this.botified.streamLlmTextPreview) return;
    const serviceKey = this.serviceKeyForTask(task);
    const runtime = await this.readRuntimeState(task, serviceKey);
    const redaction = await this.interactionRedaction(task, serviceKey);
    const bodies = new Map<string, string>();
    const omitted = new Set<string>();
    for await (const frame of this.botified.streamLlmTextPreview(runtime.baseUrl, serviceKey, signal ? { signal } : {})) {
      if (frame.type === "text_delta") {
        if (omitted.has(frame.providerRequestId)) continue;
        const body = `${bodies.get(frame.providerRequestId) ?? ""}${frame.delta}`;
        if (Buffer.byteLength(body, "utf8") > 8 * 1024) {
          bodies.delete(frame.providerRequestId);
          omitted.add(frame.providerRequestId);
          continue;
        }
        bodies.set(frame.providerRequestId, body);
        const safe = redactInteractionText(body, redaction);
        if (safe.text !== null) {
          yield {
            type: "upsert",
            interactionId: stableTaskInteractionId(task.id, `preview:${frame.providerRequestId}`),
            body: safe.text,
            occurredAt: frame.time
          };
        }
      } else if (["finished", "aborted", "error"].includes(frame.type)) {
        bodies.delete(frame.providerRequestId);
        omitted.delete(frame.providerRequestId);
        yield {
          type: "clear",
          interactionId: stableTaskInteractionId(task.id, `preview:${frame.providerRequestId}`)
        };
      }
    }
  }

  async abortTaskTurn(userId: string, taskId: string, idempotencyKey?: string): Promise<TaskTurnAbortResult> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "write");
    return this.runIdempotentTaskOperation({ actorId:userId, projectId:task.projectId, operation:taskOperation("abort-turn"), key:idempotencyKey, request:{taskId} }, task.id, async () => {
      const current = await this.store.findTask(task.id);
      if (!current || current.deletedAt) throw new ProductError("Task not found", 404);
      if (current.executionMode !== "live" || current.terminalReason) throw new ProductError("Task has no active turn to stop", 409);
      if (!await this.taskExecutionEligible(current)) throw new ProductError("Task is no longer eligible to stop a turn", 409);
      if (this.abortingTaskIds.has(current.id)) throw new ProductError("Task turn abort is already in progress", 409);
      this.abortingTaskIds.add(current.id);
      try {
        const serviceKey = this.serviceKeyForTask(current);
        const runtime = await this.readRuntimeState(current, serviceKey);
        const state = await this.callBotified("read state", () => this.botified.readState(runtime.baseUrl, serviceKey));
        if (state.state !== "running") throw new ProductError("Task has no active turn to stop", 409);
        const turnId = activeTurnIdentity(state, current);
        const result = await this.callBotified("abort", () => this.botified.abort(runtime.baseUrl, serviceKey));
        if (!result.aborted) throw new ProductError("Botified did not stop the active turn", 409);
        await this.persistProductInteraction(turnAbortedProductSource(current, turnId, nowIso()), current);
        return { aborted:true as const, runState:"idle" as const, capabilities:await this.taskCapabilities(userId,current,"idle") };
      } finally {
        this.abortingTaskIds.delete(current.id);
      }
    });
  }

  async stopTaskBackgroundWork(userId: string, taskId: string, interactionId: string, idempotencyKey?: string): Promise<TaskBackgroundWorkStopResult> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "write");
    return this.runIdempotentTaskOperation({ actorId:userId, projectId:task.projectId, operation:taskOperation("work-stop"), key:idempotencyKey, request:{taskId,interactionId} }, interactionId, async () => {
      const current = await this.store.findTask(task.id);
      if (!current || current.deletedAt) throw new ProductError("Task not found", 404);
      if (current.executionMode !== "live" || current.terminalReason) throw new ProductError("Background work cannot be stopped for this task", 409);
      if (!await this.taskExecutionEligible(current)) throw new ProductError("Background work can no longer be stopped for this task", 409);
      const change = await this.store.findLatestTaskInteractionChange(task.id, interactionId);
      if (!change || change.interaction.kind !== "background_task") throw new ProductError("Background work interaction not found", 404);
      if (!change.interaction.canStop || change.interaction.executionStatus !== "running" || !change.correlation?.workTaskId) throw new ProductError("Background work is no longer stoppable", 409);
      const workTaskId = change.correlation.workTaskId;
      if (!this.botified.stopBackgroundTask) throw new ProductError("Botified background work stop API is required", 502);
      const serviceKey = this.serviceKeyForTask(current);
      const runtime = await this.readRuntimeState(current, serviceKey);
      const stopped = await this.callBotified("stop background work", () => this.botified.stopBackgroundTask!(runtime.baseUrl, serviceKey, workTaskId));
      if (stopped.taskId !== workTaskId) throw new ProductError("Botified background work stop response did not match the requested task", 502);
      await this.persistProductInteraction(
        backgroundWorkStoppedProductSource(current, change, stopped.state, nowIso()),
        current,
        change
      );
      return { interactionId, workTaskId, state:stopped.state, capabilities:await this.taskCapabilities(userId,current) };
    });
  }

  async listTaskArtifacts(userId: string, taskId: string, filter: { mediaType?: string; previewOnly?: boolean } = {}): Promise<AgentTaskArtifact[]> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    if(task.executionMode==="live"&&task.startIntentStatus==="dispatched"){
      if(task.terminalReason&&(task.artifactProjectionStatus==="draining"||task.artifactProjectionStatus==="failed"))try{await this.drainTaskArtifacts(task);}catch{}
      else if(!task.terminalReason)await this.bestEffortSyncTaskTimeline(task);
    }
    return filterTaskArtifacts((await this.store.listTaskArtifacts(taskId)).map(publicArtifact), filter);
  }

  async downloadTaskArtifact(userId: string, taskId: string, artifactId: string): Promise<TaskArtifactDownload> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    let artifacts = await this.store.listTaskArtifacts(taskId);
    let artifact = artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact && task.executionMode==="live" && task.cleanupStatus!=="completed") {
      await this.bestEffortSyncTaskTimeline(task);
      artifacts = await this.store.listTaskArtifacts(taskId);
      artifact = artifacts.find((candidate) => candidate.id === artifactId);
    }
    if (!artifact) {
      throw new ProductError("Task artifact not found", 404);
    }
    const stored = await this.taskArtifactStoragePath(task, artifact);
    for (const filePath of [stored.filePath, ...(stored.legacyFilePath ? [stored.legacyFilePath] : [])]) {
      try {
        const bytes = await readRegularFileWithoutFollowingSymlink(filePath, "Task artifact");
        if (bytes.byteLength !== artifact.bytes || artifact.sha256 && createHash("sha256").update(bytes).digest("hex") !== artifact.sha256.toLowerCase()) {
          throw new ProductError("Stored task artifact no longer matches its published metadata", 409);
        }
        return { artifact: publicArtifact(artifact), bytes };
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    throw new ProductError("Task artifact file not found", 404);
  }

  taskRuntimePaths(task: AgentTask): { projectMountPath: string; taskHomePath: string; botifiedDataPath: string; artifactPath: string } {
    const projectMountPath = "/workspace/project";
    const taskBase = path.posix.join(projectMountPath, "tasks", task.id);
    return {
      projectMountPath,
      taskHomePath: path.posix.join(taskBase, "home"),
      botifiedDataPath: path.posix.join(taskBase, "botified"),
      artifactPath: BOTIFIED_ARTIFACT_PATH
    };
  }

  private async requireTaskForUser(
    userId: string,
    taskId: string,
    permission: ProjectPermission
  ): Promise<PersistedAgentTask> {
    const task = await this.requireTaskRecordForUser(userId,taskId,permission);
    if (task.deletedAt) {
      throw new ProductError("Task not found", 404);
    }
    return task;
  }

  private async requireTaskRecordForUser(userId:string,taskId:string,permission:ProjectPermission):Promise<PersistedAgentTask>{
    const task=await this.store.findTask(taskId);
    if(!task)throw new ProductError("Task not found",404);
    await this.workspaces.requireProjectForUser(userId,task.projectId,permission);
    return task;
  }

  async syncTerminalFailureRun(runId: string): Promise<SandboxTerminalFailureSyncResult> {
    const run = await this.store.sandboxRuns.get(runId);
    if (!run?.terminalFailure) {
      return { status: "synced" };
    }
    const task = await this.store.findTask(run.taskId);
    if (!task || task.runId !== run.runId) {
      return { status: "synced" };
    }
    try {
      await this.syncTaskTimeline(task, {
        updateRunLifecycle: false,
        preserveTerminalStatus: true
      });
      return { status: "synced" };
    } catch (error) {
      if (error instanceof BotifiedTaskPortError) {
        return { status: "unavailable", message: error.message };
      }
      throw error;
    }
  }

  async projectPublishedArtifactsForRun(runId: string): Promise<void> {
    const run = await this.store.sandboxRuns.get(runId);
    if (!run) {
      return;
    }
    const task = await this.store.findTask(run.taskId);
    if (!task || task.runId !== run.runId) {
      return;
    }
    if (task.artifactProjectionStatus === "drained" || task.cleanupStatus === "completed" || task.status === "cleaned" || task.status === "stopping") {
      return;
    }
    await this.syncTaskTimeline(task, {
      updateRunLifecycle: false,
      preserveTerminalStatus: true
    });
  }

  private async syncTaskTimeline(
    task: PersistedAgentTask,
    options: { updateRunLifecycle?: boolean; preserveTerminalStatus?: boolean } = {}
  ): Promise<PersistedAgentTask> {
    const previous = this.taskTimelineSyncs.get(task.id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.taskTimelineSyncs.set(task.id, current);
    await previous;
    try {
      return await this.syncTaskTimelineUnlocked(task, options);
    } finally {
      release();
      if (this.taskTimelineSyncs.get(task.id) === current) this.taskTimelineSyncs.delete(task.id);
    }
  }

  private async syncTaskTimelineUnlocked(
    task: PersistedAgentTask,
    options: { updateRunLifecycle?: boolean; preserveTerminalStatus?: boolean } = {}
  ): Promise<PersistedAgentTask> {
    const serviceKey = this.serviceKeyForTask(task);
    const state = await this.readRuntimeState(task, serviceKey);
    const snapshot = await this.store.readTaskInteractionSnapshot(task.id, null, INTERACTION_LOOKUP_LIMIT);
    if (!snapshot) throw new ProductError("Task not found", 404);
    const timeline = await this.readCanonicalTimeline(state.baseUrl, serviceKey, snapshot.sourceCursor, snapshot.historyStatus);
    const latest = new Map(snapshot.items.map((item) => [item.id, item]));
    const messages = await this.store.listTaskMessages(task.id);
    const redaction = await this.interactionRedaction(task, serviceKey);
    const changes: TaskInteractionChangeInput[] = [];
    const inBatchCorrelations = new Map<string, TaskInteractionProjectionState>();
    const artifactProjections: PersistTaskArtifactProjectionInput[] = [];
    const newlyWrittenArtifactPaths: string[] = [];
    const existingArtifacts = new Set((await this.store.listTaskArtifacts(task.id)).map((artifact) => artifact.fileId));
    for (const event of timeline.events) {
      if (isAbortedCycleEvent(event)) continue;
      const previous = await this.previousProjectionState(task, event, latest, messages, redaction, inBatchCorrelations);
      const projected = projectTaskInteraction({ sourceKind:"botified", taskId:task.id, event }, previous, redaction);
      if (!projected.interaction) continue;
      const interaction = previous ? projected.interaction : { ...projected.interaction, position:timelinePosition(event) };
      const correlation = projected.correlation ?? timelineCorrelation(event) ?? undefined;
      latest.set(interaction.id, interaction);
      const projectionState = { interaction, ...(correlation ? { correlation } : {}) };
      for (const key of correlationKeys(correlation)) inBatchCorrelations.set(key, projectionState);
      changes.push({
        sourceKind: "botified",
        sourceId: event.cursor,
        sourceRevision: 0,
        interaction,
        ...(correlation ? { correlation } : {})
      });
      const artifactFileId = stringValue(event.data.file_id) ?? (event.item?.type === "file" ? event.item.id : undefined);
      if (projected.artifact && artifactFileId && !existingArtifacts.has(artifactFileId)) {
        const downloaded = await this.downloadTaskArtifactForInteraction(task, state.baseUrl, serviceKey, {
          ...projected.artifact,
          name: normalizeArtifactDisplayName(projected.artifact.name, artifactFileId)
        }, artifactFileId);
        artifactProjections.push(downloaded.projection);
        if (downloaded.newlyWritten) newlyWrittenArtifactPaths.push(downloaded.filePath);
        existingArtifacts.add(artifactFileId);
      }
    }
    const completionCandidate = isInteractionLifecycleStatus(task.status)
      && nextStatusForTimeline(task.status, timeline.events, true) === "completed";
    let lifecycleMessages = messages;
    let canComplete = false;
    if (completionCandidate) {
      const runtimeSnapshot = await this.callBotified("read state", () => this.botified.readState(state.baseUrl, serviceKey));
      lifecycleMessages = await this.store.listTaskMessages(task.id);
      canComplete = isBotifiedSessionQuiescent(runtimeSnapshot, timeline.nextCursor) && !lifecycleMessages.some(isPendingTaskMessage);
    }
    const syncedAt = nowIso();
    const projectedStatus = options.preserveTerminalStatus && isTerminalTaskStatus(task.status)
      ? task.status
      : nextStatusForTimeline(task.status, timeline.events, canComplete);
    let lifecycle: TaskInteractionLifecycleMutation | undefined;
    const terminalSuccessors: AtomicTaskCreateInput[] = [];
    if (projectedStatus !== task.status && isInteractionLifecycleStatus(task.status) && isInteractionLifecycleStatus(projectedStatus)) {
      lifecycle = { kind:"active", expectedStatus:task.status, status:projectedStatus, updatedAt:syncedAt };
    } else if (projectedStatus !== task.status && isTerminalTaskStatus(projectedStatus)) {
      const pending = lifecycleMessages.filter((message) => (message.deliveryStatus ?? "pending") === "pending");
      for (const message of pending) terminalSuccessors.push(await this.prepareSuccessorCreate(task, message));
      const successorInputs:TaskLifecycleSuccessor[]=[];
      for (let index = 0; index < pending.length; index += 1) {
        const message=pending[index]!;const create=terminalSuccessors[index]!;
        const success=await this.prepareProductInteractionChange(messageProductSource({...message,targetTaskId:create.task.id,deliveryStatus:"successor_created",updatedAt:syncedAt}));
        const failure=await this.prepareProductInteractionChange(messageProductSource({...message,deliveryStatus:"failed",safeError:ACTIVE_TASKS_LIMIT_MESSAGE,updatedAt:syncedAt}));
        const successorPrompt=await this.prepareProductInteractionChange(initialPromptProductSource(create.task),create.task);
        successorInputs.push({messageId:message.id,create,...(success?{messageSuccessInteractionChange:success.change}:{}),...(failure?{messageFailureInteractionChange:failure.change}:{}),...(successorPrompt?{successorInteractionChange:successorPrompt.change}:{})});
      }
      const terminalPendingChanges:TaskLifecycleTerminalPendingChange[]=[];
      for(const message of lifecycleMessages.filter((candidate)=>["pending","dispatching"].includes(candidate.deliveryStatus??"pending"))){
        const projection=await this.prepareProductInteractionChange(messageProductSource({...message,deliveryStatus:"terminal_pending",updatedAt:syncedAt}));
        if(projection)terminalPendingChanges.push({messageId:message.id,interactionChange:projection.change});
      }
      lifecycle = {
        kind:"terminal",
        terminalReason:terminalReasonForStatus(projectedStatus),
        updatedAt:syncedAt,
        auditEvent:{ id:newId("audit"), projectId:task.projectId, actorId:null, action:taskAuditActionForReason(terminalReasonForStatus(projectedStatus)), status:"accepted", resourceKind:"task", resourceId:task.id, detail:{endpointId:task.endpointId}, createdAt:syncedAt },
        successors:successorInputs,
        terminalPendingChanges
      };
    }
    try {
      await this.store.persistTaskInteractionMutation({
        taskId: task.id,
        changes,
        ...(artifactProjections.length ? { artifactProjections } : {}),
        ...(lifecycle ? { lifecycle } : {}),
        sourceSync: {
          expectedSourceCursor: snapshot.sourceCursor,
          sourceCursor: timeline.nextCursor,
          historyStatus: timeline.historyStatus,
          lastSyncedAt: syncedAt
        }
      });
    } catch (error) {
      for (const filePath of newlyWrittenArtifactPaths) await rm(filePath, { force:true });
      for (const successor of terminalSuccessors) await this.cleanupUnusedTaskCreate(successor);
      if (error instanceof Error && /file bytes limit/i.test(error.message)) {
        await this.policies.raiseAlert(task.projectId, "project_file_bytes_limit");
        throw new ProductError("Project file bytes limit reached", 409, "project_file_bytes_limit_reached");
      }
      throw error;
    }
    if (lifecycle?.kind === "terminal") {
      for (const message of await this.store.listTaskMessages(task.id)) if (isSettledMessage(message)||message.deliveryStatus==="terminal_pending") await this.completeMessageIdempotency(message);
      if (lifecycle.terminalReason === "failed") await this.policies.evaluateTaskFailure(task.projectId, task.endpointId);
    }
    await this.writeRuntimeState(task.id, { ...state, lastSyncedAt:syncedAt });
    const updated = await this.store.findTask(task.id) ?? task;
    if (options.updateRunLifecycle !== false) {
      await this.updateRunLifecycleAfterTimelineSync(updated, timeline.events.length > 0);
    }
    return updated;
  }

  private async readCanonicalTimeline(baseUrl: string, serviceKey: string, sourceCursor: string | null, historyStatus: TaskHistoryStatus): Promise<{ events: BotifiedTimelineEvent[]; nextCursor: string | null; historyStatus: TaskHistoryStatus }> {
    if (sourceCursor === null || historyStatus === "gap") return this.recoverCanonicalTimeline(baseUrl, serviceKey, historyStatus);
    const events: BotifiedTimelineEvent[] = [];
    let cursor = sourceCursor;
    while (true) {
      const page = await this.callBotified("read timeline", () => this.botified.readTimeline(baseUrl, serviceKey, cursor, { direction:"forward", limit:INTERACTION_SYNC_PAGE_LIMIT }));
      if (page.status === "gap") return this.recoverCanonicalTimeline(baseUrl, serviceKey, "gap");
      events.push(...parseBotifiedTimelineEvents(page.events));
      const next = safeRuntimeCursor(page.nextCursor) ?? cursor;
      if (!page.hasMoreAfter || next === cursor) return { events, nextCursor:next, historyStatus:"complete" };
      cursor = next;
    }
  }

  private async recoverCanonicalTimeline(baseUrl: string, serviceKey: string, minimumStatus: TaskHistoryStatus): Promise<{ events: BotifiedTimelineEvent[]; nextCursor: string | null; historyStatus: TaskHistoryStatus }> {
    const tail = await this.callBotified("read timeline", () => this.botified.readTimeline(baseUrl, serviceKey, undefined, { direction:"history", limit:INTERACTION_SYNC_PAGE_LIMIT }));
    if (tail.status === "gap") throw new ProductError("Botified history recovery failed", 502);
    const pages: BotifiedTimelineEvent[][] = [parseBotifiedTimelineEvents(tail.events)];
    let historyExpired = tail.historyBoundary === "expired";
    let page = tail;
    while (page.hasMoreBefore) {
      const start = safeRuntimeCursor(page.pageStartCursor);
      if (!start) return { events:pages.flat(), nextCursor:safeRuntimeCursor(tail.nextCursor)??null, historyStatus:"gap" };
      const previous = await this.callBotified("read timeline", () => this.botified.readTimeline(baseUrl, serviceKey, start, { direction:"backward", limit:INTERACTION_SYNC_PAGE_LIMIT }));
      if (previous.status === "gap") return { events:pages.flat(), nextCursor:safeRuntimeCursor(tail.nextCursor)??null, historyStatus:"gap" };
      pages.unshift(parseBotifiedTimelineEvents(previous.events));
      historyExpired ||= previous.historyBoundary === "expired";
      page = previous;
    }
    const historyStatus: TaskHistoryStatus = minimumStatus === "gap" || historyExpired ? "gap" : "complete";
    const recovered = pages.flat();
    const checkpoint = safeRuntimeCursor(tail.nextCursor) ?? null;
    if (!tail.hasMoreAfter || !checkpoint) return { events:recovered, nextCursor:checkpoint, historyStatus };
    let cursor: string | null = checkpoint;
    while (cursor) {
      const pageStartCursor: string = cursor;
      const forward: BotifiedTimelineReadResult = await this.callBotified("read timeline", () => this.botified.readTimeline(baseUrl, serviceKey, pageStartCursor, { direction:"forward", limit:INTERACTION_SYNC_PAGE_LIMIT }));
      if (forward.status === "gap") return { events:recovered, nextCursor:pageStartCursor, historyStatus:"gap" };
      recovered.push(...parseBotifiedTimelineEvents(forward.events));
      const next: string = safeRuntimeCursor(forward.nextCursor) ?? pageStartCursor;
      if (!forward.hasMoreAfter || next === pageStartCursor) return { events:recovered, nextCursor:next, historyStatus };
      cursor = next;
    }
    return { events:recovered, nextCursor:null, historyStatus };
  }

  private async bestEffortSyncTaskTimeline(
    task: PersistedAgentTask,
    options: { updateRunLifecycle?: boolean; preserveTerminalStatus?: boolean } = {}
  ): Promise<void> {
    try {
      await this.syncTaskTimeline(task, options);
    } catch (error) {
      if (error instanceof BotifiedTaskPortError) {
        return;
      }
      throw error;
    }
  }

  private async liveSandboxCleanupStatus(task: PersistedAgentTask): Promise<LiveSandboxCleanupStatus> {
    if (!this.config.liveSandbox) {
      return "none";
    }
    const run = await this.store.sandboxRuns.get(task.runId);
    if (!run || run.taskId !== task.id) {
      return "none";
    }
    return run.cleanupStatus === "cleaned" || run.phase === "cleaned" ? "cleaned" : "pending";
  }

  private async cleanupTerminalLiveSandboxBeforeRead(task: PersistedAgentTask, liveCleanupStatus: LiveSandboxCleanupStatus): Promise<boolean> {
    if (!isDurableTaskResultStatus(task.status) || liveCleanupStatus === "none") {
      return false;
    }
    if (liveCleanupStatus === "pending") {
      await this.bestEffortRequestRunCleanup(task.runId, cleanupPhaseForTaskStatus(task.status));
      await this.bestEffortReapSandboxRun(task.runId);
    }
    return true;
  }

  private async readRuntimeState(task: PersistedAgentTask, serviceKey: string): Promise<BotifiedTaskRuntimeState> {
    const document = await this.store.jsonDocs.get("sandbox_runtime_state", task.id);
    if (!document) {
      return this.rebuildRuntimeStateFromBotified(task, serviceKey);
    }
    const baseUrl = stringDocumentField(document, "botifiedBaseUrl");
    const state: BotifiedTaskRuntimeState = { baseUrl, ...(task.startDeliveryKey?{startDeliveryKey:task.startDeliveryKey}:{}), ...(task.startRequestHash?{startRequestHash:task.startRequestHash}:{}), ...(task.startClaimToken?{startClaimToken:task.startClaimToken}:{}), ...(task.startReceipt&&task.startDeliveryKey&&task.startRequestHash?{startReceipt:{...task.startReceipt,deliveryKey:task.startDeliveryKey,requestHash:task.startRequestHash}}:{}) };
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

  private async rebuildRuntimeStateFromBotified(task: PersistedAgentTask, serviceKey: string): Promise<BotifiedTaskRuntimeState> {
    const run = await this.store.sandboxRuns.get(task.runId);
    if (!run || run.taskId !== task.id || !Number.isFinite(run.botifiedPort) || run.botifiedPort <= 0) {
      throw new ProductError("Task runtime state not found", 409);
    }
    const baseUrl = this.botifiedBaseUrlForTask(task.id, run.botifiedPort, run.namespace);
    const snapshot = await this.callBotified("read state", () => this.botified.readState(baseUrl, serviceKey));
    const state = this.runtimeStateFromBotifiedSnapshot(baseUrl, snapshot);
    if(task.startDeliveryKey)state.startDeliveryKey=task.startDeliveryKey;
    if(task.startRequestHash)state.startRequestHash=task.startRequestHash;
    if(task.startClaimToken)state.startClaimToken=task.startClaimToken;
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

  private serviceKeyForTask(task: PersistedAgentTask): string {
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

  private botifiedBrokerBaseUrlForTask(task: PersistedAgentTask): string {
    const input: BotifiedBrokerAddressInput = {
      namespace: this.config.namespace,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      runId: task.runId
    };
    return (this.config.botifiedBrokerBaseUrlForTask ?? defaultBotifiedBrokerBaseUrlForTask)(input);
  }

  private async callBotified<T>(operation: BotifiedOperation, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw new BotifiedTaskPortError(operation, error);
    }
  }

  private async postDelivery(state: BotifiedTaskRuntimeState, serviceKey: string, text: string): Promise<BotifiedDeliveryReceipt> {
    if (!state.startDeliveryKey || !state.startRequestHash) {
      throw new ProductError("Task delivery state is missing", 409);
    }
    if (!this.botified.postMessageWithDelivery) {
      throw new ProductError("Botified delivery API is required", 502);
    }
    return this.postDeliveryMessage(state.baseUrl,serviceKey,text,state.startDeliveryKey,state.startRequestHash);
  }

  private async postDeliveryMessage(baseUrl:string,serviceKey:string,text:string,deliveryKey:string,requestHash:string):Promise<BotifiedDeliveryReceipt>{
    if (!this.botified.postMessageWithDelivery) throw new ProductError("Botified delivery API is required",502);
    return this.callBotified("send message",()=>this.botified.postMessageWithDelivery!(baseUrl,serviceKey,{text,deliveryKey,requestHash}));
  }

  private async downloadTaskArtifactForInteraction(
    task: PersistedAgentTask,
    baseUrl: string,
    serviceKey: string,
    artifact: AgentTaskArtifact,
    botifiedFileId: string
  ): Promise<{ projection: PersistTaskArtifactProjectionInput; filePath: string; newlyWritten: boolean }> {
    const downloaded = await this.callBotified("download file", () =>
      this.botified.downloadFile(baseUrl, serviceKey, botifiedFileId)
    );
    const actualBytes = downloaded.bytes.byteLength;
    if (artifact.bytes !== actualBytes) {
      throw new ProductError("Published artifact size does not match downloaded bytes", 502);
    }
    const actualSha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
    if (artifact.sha256 !== undefined && artifact.sha256.toLowerCase() !== actualSha256) {
      throw new ProductError("Published artifact sha256 does not match downloaded bytes", 502);
    }
    const verifiedArtifact: PersistedTaskArtifact = {
      ...artifact,
      fileId: botifiedFileId,
      bytes: actualBytes,
      sha256: actualSha256,
      ...artifactPreview(downloaded.bytes, artifact.name)
    };
    const { root, filePath } = await this.taskArtifactStoragePath(task, verifiedArtifact);
    await mkdir(root, { recursive: true });
    let newlyWritten = false;
    try {
      await writeFile(filePath, downloaded.bytes, { flag: "wx" });
      newlyWritten = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existingBytes = await readFile(filePath);
      if (existingBytes.byteLength !== actualBytes || createHash("sha256").update(existingBytes).digest("hex") !== actualSha256) {
        throw new ProductError("Stored task artifact file does not match the published artifact", 409);
      }
    }
    const timestamp = nowIso();
    return {
      projection: {
        projectId: task.projectId,
        artifact: verifiedArtifact,
        auditEvent: { id: `audit_artifact_${verifiedArtifact.id}`, projectId: task.projectId, actorId: null, action: "artifact.project", status: "accepted", resourceKind: "artifact", resourceId: verifiedArtifact.id, createdAt: timestamp },
        updatedAt: timestamp
      },
      filePath,
      newlyWritten
    };
  }

  private async taskArtifactStoragePath(task: PersistedAgentTask, artifact: PersistedTaskArtifact): Promise<{ root: string; filePath: string; legacyFilePath?: string }> {
    const project = await this.store.findProject(task.projectId);
    if (!project) {
      throw new ProductError("Task project not found", 409);
    }
    const dataRoot = path.resolve(this.config.dataRoot);
    const taskRoot = path.resolve(dataRoot, project.rootPath, "tasks", task.id);
    assertPathInside(dataRoot, taskRoot, "Task artifact directory is outside the data root");
    const legacySandboxArtifact = artifact.fileId.startsWith("sandbox:");
    const root = path.resolve(taskRoot, legacySandboxArtifact ? "artifacts" : "published-artifacts");
    assertPathInside(dataRoot, root, "Task artifact directory is outside the data root");
    const sandboxPath = legacySandboxArtifact ? artifact.fileId.slice("sandbox:".length) : null;
    const filename = `${artifactStorageSegment(artifact.id, "artifact")}-${artifactStorageSegment(artifact.name, artifact.fileId)}`;
    const filePath = sandboxPath ? path.resolve(root, ...sandboxPath.split("/")) : path.resolve(root, filename);
    assertPathInside(root, filePath, "Task artifact path is outside the artifact directory");
    if (legacySandboxArtifact) return { root, filePath };
    const legacyRoot = path.resolve(taskRoot, "artifacts");
    const legacyFilePath = path.resolve(legacyRoot, filename);
    assertPathInside(legacyRoot, legacyFilePath, "Legacy task artifact path is outside the artifact directory");
    return { root, filePath, legacyFilePath };
  }

  private async projectSandboxArtifactFiles(task: PersistedAgentTask): Promise<void> {
    const project = await this.store.findProject(task.projectId);
    if (!project) throw new ProductError("Task project not found", 409);
    const dataRoot = path.resolve(this.config.dataRoot);
    const root = path.resolve(dataRoot, project.rootPath, "tasks", task.id, "artifacts");
    assertPathInside(dataRoot, root, "Task artifact directory is outside the data root");
    const existing = await this.store.listTaskArtifacts(task.id);
    const existingFileIds = new Set(existing.map((artifact) => artifact.fileId));
    const productStoredNames = new Set(existing.filter((artifact) => !artifact.fileId.startsWith("sandbox:")).map((artifact) => `${artifactStorageSegment(artifact.id, "artifact")}-${artifactStorageSegment(artifact.name, artifact.fileId)}`));
    const files = await listRegularArtifactFiles(root, MAX_TASK_ARTIFACT_FILES);
    for (const relativePath of files) {
      if (productStoredNames.has(relativePath)) continue;
      const fileId = `sandbox-published:${relativePath}`;
      const filePath = path.resolve(root, ...relativePath.split("/"));
      assertPathInside(root, filePath, "Task artifact path is outside the artifact directory");
      if (existingFileIds.has(fileId)) {
        await rm(filePath, { force: true });
        continue;
      }
      const bytes = await readRegularFileWithoutFollowingSymlink(filePath);
      if (bytes.byteLength > MAX_TASK_ARTIFACT_BYTES) throw new ProductError("Task artifact exceeds the maximum file size", 409);
      const artifact: PersistedTaskArtifact = {
        id: stableSandboxArtifactId(task.id, fileId),
        taskId: task.id,
        fileId,
        name: normalizeArtifactDisplayName(relativePath, "artifact"),
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...artifactPreview(bytes, relativePath),
        createdAt: nowIso()
      };
      const stored = await this.taskArtifactStoragePath(task, artifact);
      await mkdir(stored.root, { recursive: true });
      try {
        await writeFile(stored.filePath, bytes, { flag: "wx" });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const existingBytes = await readRegularFileWithoutFollowingSymlink(stored.filePath, "Task artifact");
        if (existingBytes.byteLength !== bytes.byteLength || createHash("sha256").update(existingBytes).digest("hex") !== artifact.sha256) {
          throw new ProductError("Stored task artifact does not match the sandbox publication", 409);
        }
      }
      const persisted = await this.store.persistTaskArtifactProjection({
        projectId: task.projectId,
        artifact,
        auditEvent: { id: `audit_artifact_${artifact.id}`, projectId: task.projectId, actorId: null, action: "artifact.project", status: "accepted", resourceKind: "artifact", resourceId: artifact.id, createdAt: nowIso() },
        updatedAt: nowIso()
      });
      if (persisted === "limit_exceeded") {
        await rm(stored.filePath, { force: true });
        await rm(filePath, { force: true });
        await this.policies.raiseAlert(task.projectId, "project_file_bytes_limit");
        await this.policies.recordOperation(task.projectId, null, "file.quota", "rejected", artifact.id, "file_quota");
        throw new ProductError("Project file bytes limit reached", 409, "project_file_bytes_limit_reached");
      }
      await rm(filePath, { force: true });
      existingFileIds.add(fileId);
    }
  }

  async authorizeBotifiedChatCompletion(taskId: string, runId: string, serviceKey: string): Promise<AuthorizedBotifiedChatCompletion> {
    const task = await this.store.findTask(taskId);
    if (!task || task.runId !== runId || !constantTimeEqual(serviceKey, this.serviceKeyForTask(task))) {
      throw new ProductError("Unauthorized Botified task key", 401);
    }
    if (!isActiveBotifiedTask(task.status)) {
      throw new ProductError("Botified task is not active", 409);
    }
    const endpoint = await this.endpoints.requireEndpointForProject(task.projectId, task.endpointId);
    requireTaskEndpointCapabilities(endpoint);
    const credentials = this.config.credentials;
    if (!credentials) throw new ProductError("Credential service is not configured", 500);
    const credential = await credentials.resolve(task.projectId, endpoint.credentialId);
    const endpointBaseUrl = normalizeOpenAICompatibleBaseUrl(endpoint.baseUrl);
    const credentialBaseUrl = normalizeOpenAICompatibleBaseUrl(credential.baseUrl, 500);
    if (endpointBaseUrl !== credentialBaseUrl) {
      throw new ProductError("Endpoint baseUrl does not match the configured credential binding");
    }
    return { endpoint, apiKey: credential.apiKey, projectId: task.projectId, actorId:task.createdByUserId??null };
  }

  private buildLiveSandboxRun(input: {
    task: PersistedAgentTask;
    timestamp: string;
    botifiedPort: number;
    projectSubPath: string;
    resourceNames: SandboxRunState["resourceNames"];
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
      resourceNames: input.resourceNames,
      serviceKeySecretRef: {
        name: input.resourceNames.secret,
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
    task: PersistedAgentTask;
    run: SandboxRunState;
    serviceKey: string;
  }): Promise<void> {
    const live = this.config.liveSandbox;
    if (!live) {
      return;
    }
    await this.prepareLiveRuntimeDirectories(input.task, input.run.projectSubPath);
    const actions = reconcileSandboxRuns({
      namespace: input.run.namespace,
      desiredRuns: [input.run],
      observedResources: [],
      now: new Date()
    }).actions;
    const config = generateBotifiedConfig({
      endpoint: input.endpoint,
      task: {
        taskId: input.task.id,
        projectMountPath: "/workspace/project",
        taskHomePath: BOTIFIED_TASK_HOME_PATH,
        botifiedDataPath: BOTIFIED_DATA_PATH,
        serviceKeyEnv: "BOTIFIED_SERVICE_KEY",
        providerApiKeyEnv: "BOTIFIED_SERVICE_KEY",
        providerBaseUrl: this.botifiedBrokerBaseUrlForTask(input.task),
        servicePort: input.run.botifiedPort
      }
    });
    const materialized = materializeLiveCreateActions(actions, {
      serviceKey: input.serviceKey,
      botifiedConfig: serializeBotifiedConfig(config)
    });
    await applySandboxReconcileActionsToKubernetes(live.port, materialized);
    const podAction = materialized.find((action) => action.type === "create_resource" && action.kind === "Pod");
    if (!podAction || podAction.type !== "create_resource") {
      throw new ProductError("Live sandbox pod manifest was not generated", 500);
    }
    await waitForPodReady(live, input.run.namespace, podAction.name, podAction.labels);
  }

  private async prepareLiveRuntimeDirectories(task: PersistedAgentTask, projectRootPath: string): Promise<void> {
    const dataRoot = path.resolve(this.config.dataRoot);
    const taskRoot = path.resolve(dataRoot, projectRootPath, "tasks", task.id);
    assertPathInside(dataRoot, taskRoot, "Task runtime directory is outside the data root");
    const runnerWritableDirectories = [path.resolve(taskRoot, "home"), path.resolve(taskRoot, "botified"), path.resolve(taskRoot, "artifacts")];
    for (const directory of runnerWritableDirectories) {
      assertPathInside(dataRoot, directory, "Task runtime directory is outside the data root");
    }
    for (const directory of runnerWritableDirectories) {
      await prepareRunnerWritableDirectory(directory);
    }
    const taskGuidance = `# AgentSmith Task Workspace\n\nSave files that should appear in the product Artifacts panel under \`${BOTIFIED_ARTIFACT_PATH}\`. Project inputs are read-only under \`/workspace/project/files\`.\n`;
    await writeFile(path.resolve(taskRoot, "home", "AGENTS.md"), task.agentContext ? `${taskGuidance}\n${task.agentContext}` : taskGuidance, { mode: 0o664 });
  }

  private async snapshotProjectInputs(projectRootPath: string, taskId: string, inputPaths: string[]): Promise<void> {
    const dataRoot = path.resolve(this.config.dataRoot);
    const paths = new FilePathValidationService();
    const projectRoot = await paths.resolveSafeProjectPathNoSymlinks(dataRoot, projectRootPath);
    const taskRoot = await paths.resolveSafeProjectPathNoSymlinks(dataRoot, path.posix.join(projectRootPath, "tasks", taskId));

    const snapshotRoot = path.resolve(taskRoot, "inputs");
    const temporaryRoot = path.resolve(taskRoot, `inputs-${taskId}.tmp`);
    assertPathInside(dataRoot, snapshotRoot, "Task input snapshot is outside the data root");
    assertPathInside(dataRoot, temporaryRoot, "Task input snapshot is outside the data root");
    await withProjectFileLock(projectRoot, async () => {
      await rm(temporaryRoot, { recursive: true, force: true });
      await mkdir(path.join(temporaryRoot, "files"), { recursive: true });
      try {
        const entries: TaskInputManifestEntry[] = [];
        for(const selectedPath of collapseSelectedInputPaths(inputPaths)){
          const source=path.resolve(projectRoot,...selectedPath.split("/"));
          const destination=path.resolve(temporaryRoot,...selectedPath.split("/"));
          assertPathInside(projectRoot,source,"Task input source is outside the project");
          assertPathInside(temporaryRoot,destination,"Task input snapshot is outside the task directory");
          await copyProjectInputTree(source,destination,selectedPath,entries,true);
        }
        await writeFile(path.join(temporaryRoot, "manifest.json"), JSON.stringify({ version: 1, files: entries }) + "\n");
        await rename(temporaryRoot, snapshotRoot);
      } catch (error) {
        await rm(temporaryRoot, { recursive: true, force: true });
        throw error;
      }
    });
  }

  private async snapshotRetainedTaskInputs(projectId: string, projectRootPath: string, taskId: string, sourceTaskId: string): Promise<void> {
    const sourceTask = await this.store.findTask(sourceTaskId);
    if (!sourceTask || sourceTask.deletedAt || sourceTask.projectId !== projectId) {
      throw new ProductError("Source task not found", 404);
    }
    const entries = await this.readTaskInputManifest(sourceTask, true);
    const dataRoot = path.resolve(this.config.dataRoot);
    const paths = new FilePathValidationService();
    const projectRoot = await paths.resolveSafeProjectPathNoSymlinks(dataRoot, projectRootPath);
    const sourceRoot = await paths.resolveSafeProjectPathNoSymlinks(dataRoot, path.posix.join(projectRootPath, "tasks", sourceTaskId, "inputs"));
    const taskRoot = await paths.resolveSafeProjectPathNoSymlinks(dataRoot, path.posix.join(projectRootPath, "tasks", taskId));
    const snapshotRoot = path.resolve(taskRoot, "inputs");
    const temporaryRoot = path.resolve(taskRoot, `inputs-${taskId}.tmp`);
    assertPathInside(dataRoot, sourceRoot, "Source task input snapshot is outside the data root");
    assertPathInside(dataRoot, snapshotRoot, "Task input snapshot is outside the data root");
    assertPathInside(dataRoot, temporaryRoot, "Task input snapshot is outside the data root");

    await withProjectFileLock(projectRoot, async () => {
      await rm(temporaryRoot, { recursive: true, force: true });
      await mkdir(path.join(temporaryRoot, "files"), { recursive: true });
      try {
        for (const entry of entries) {
          const source = path.resolve(sourceRoot, ...entry.path.split("/"));
          const destination = path.resolve(temporaryRoot, ...entry.path.split("/"));
          assertPathInside(sourceRoot, source, "Source task input is outside its snapshot");
          assertPathInside(temporaryRoot, destination, "Task input snapshot is outside the task directory");
          let bytes: Buffer;
          try {
            bytes = await readRegularFileWithoutFollowingSymlink(source, "Source task input");
          } catch (error) {
            if (isNotFound(error)) throw new ProductError("Source task input snapshot is unavailable", 409);
            throw error;
          }
          const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          if (bytes.byteLength !== entry.size || digest !== entry.digest) {
            throw new ProductError("Source task input snapshot is invalid", 409);
          }
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, bytes);
        }
        await writeFile(path.join(temporaryRoot, "manifest.json"), JSON.stringify({ version: 1, files: entries }) + "\n");
        await rename(temporaryRoot, snapshotRoot);
      } catch (error) {
        await rm(temporaryRoot, { recursive: true, force: true });
        throw error;
      }
    });
  }

  private async readTaskInputManifest(task: PersistedAgentTask, required = false): Promise<TaskInputManifestEntry[]> {
    const project = await this.store.findProject(task.projectId);
    if (!project) throw new ProductError("Task project not found", 409);
    const dataRoot = path.resolve(this.config.dataRoot);
    const manifestPath = path.resolve(dataRoot, project.rootPath, "tasks", task.id, "inputs", "manifest.json");
    assertPathInside(dataRoot, manifestPath, "Task input manifest is outside the data root");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (isNotFound(error)) {
        if (required) throw new ProductError("Source task input snapshot is unavailable", 409);
        return [];
      }
      throw new ProductError("Task input manifest is unavailable", 500);
    }
    if (!isUnknownRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.files)) {
      throw new ProductError("Task input manifest is invalid", 500);
    }
    return parsed.files.map((value) => {
      if (!isUnknownRecord(value) || typeof value.path !== "string" || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest)) {
        throw new ProductError("Task input manifest is invalid", 500);
      }
      const normalized = normalizeTaskInputPaths([value.path])[0];
      if (normalized !== value.path) throw new ProductError("Task input manifest is invalid", 500);
      return { path: value.path, size: value.size, digest: value.digest };
    });
  }

  private async removeUnpersistedTaskData(projectRootPath: string, taskId: string): Promise<void> {
    const dataRoot = path.resolve(this.config.dataRoot);
    const taskRoot = path.resolve(dataRoot, projectRootPath, "tasks", taskId);
    assertPathInside(dataRoot, taskRoot, "Task data directory is outside the data root");
    await rm(taskRoot, { recursive: true, force: true });
  }

  private async bestEffortRemoveUnpersistedTaskData(projectRootPath: string, taskId: string): Promise<void> {
    try {
      await this.removeUnpersistedTaskData(projectRootPath,taskId);
    } catch {
      // The original create failure remains authoritative.
    }
  }

  private async bestEffortMarkTaskFailed(task: PersistedAgentTask): Promise<void> {
    try {
      await this.finalizeTaskLifecycle(task.id, "failed", null);
    } catch {
      // Startup cleanup and the original failure must not depend on the failed-state write.
    }
  }

  private async bestEffortPersistLiveStartupFailure(
    runId: string,
    operation: BotifiedOperation,
    error: unknown
  ): Promise<void> {
    try {
      const current = await this.store.sandboxRuns.get(runId);
      if (!current) {
        return;
      }
      const message = redactSecretLikeText(error instanceof Error ? error.message : "Unknown Botified error").slice(0, 300);
      const status = error instanceof ProductError ? error.statusCode : 502;
      await this.store.sandboxRuns.updateWithFencing(runId, current.fencingToken, {
        ...current,
        startupFailure: {
          operation,
          message,
          status,
          at: nowIso()
        },
        fencingToken: current.fencingToken + 1,
        updatedAt: nowIso()
      });
    } catch {
      // Startup cleanup and the original failure must not depend on the failure metadata write.
    }
  }

  private async claimLiveRunForPrompt(runId: string): Promise<void> {
    const current = await this.store.sandboxRuns.get(runId);
    if (
      !current ||
      current.phase !== "starting" ||
      current.cleanupStatus !== "active" ||
      sandboxRunDeadlineElapsed(current, new Date())
    ) {
      throw new ProductError("Sandbox run is no longer eligible to receive a prompt", 409);
    }
    const updated = await this.store.sandboxRuns.updateWithFencing(runId, current.fencingToken, {
      ...current,
      phase: "running",
      cleanupStatus: "active",
      fencingToken: current.fencingToken + 1,
      updatedAt: nowIso()
    });
    if (!updated) {
      throw new ProductError("Sandbox run state fencing token changed", 409);
    }
  }

  private async requestLiveRunCleanupBeforeCancel(runId: string): Promise<void> {
    const updated = await requestSandboxRunCleanup(this.store, runId, {
      phase: "stopping",
      cleanupStatus: "cleanup_requested"
    });
    if (!updated) {
      throw new ProductError("Sandbox run cleanup intent could not be persisted", 409);
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
      // Runtime ticks retry cleanup after transient Kubernetes failures.
    }
  }

  private async updateRunLifecycleAfterTimelineSync(task: PersistedAgentTask, hadEvents: boolean): Promise<void> {
    if (!this.config.liveSandbox) {
      return;
    }
    if (isTerminalTaskStatus(task.status)) {
      return;
    }
    if (hadEvents && isActiveTaskStatus(task.status)) {
      await refreshSandboxRunActivity(this.store, task.runId, {
        idleTimeoutMs: this.liveSandboxIdleTimeoutMs()
      });
    }
  }

  private async ensureTaskConversation(task: PersistedAgentTask): Promise<void> {
    if (!await this.taskExecutionEligible(task)) return;
    await this.persistInitialPromptInteraction(task);
    if (task.executionMode !== "live" || task.startIntentStatus !== "dispatched") return;
    if (isTerminalTask(task)) {
      if (task.terminalReason && (task.artifactProjectionStatus === "draining" || task.artifactProjectionStatus === "failed")) {
        try { await this.drainTaskArtifacts(task); } catch {}
      }
      return;
    }
    await this.bestEffortSyncTaskTimeline(task, { preserveTerminalStatus:true });
  }

  private async persistInitialPromptInteraction(task: PersistedAgentTask): Promise<TaskInteractionItem | null> {
    const interaction = await this.persistProductInteraction(initialPromptProductSource(task));
    if (task.executionMode === "dry-run") {
      await this.store.persistTaskInteractionMutation({ taskId:task.id, changes:[], sourceSync:{ sourceCursor:null, historyStatus:"complete", lastSyncedAt:task.updatedAt } });
    }
    return interaction;
  }

  private async persistMessageInteraction(message: PersistedTaskMessage): Promise<TaskInteractionItem | null> {
    const source = messageProductSource(message);
    return this.persistProductInteraction(source);
  }

  private async persistProductInteraction(
    source: ProductTaskInteractionSource,
    knownTask?: PersistedAgentTask,
    knownPrevious?: PersistedTaskInteractionChange
  ): Promise<TaskInteractionItem | null> {
    const projected = await this.prepareProductInteractionChange(source, knownTask, knownPrevious);
    if (!projected) return null;
    await this.store.persistTaskInteractionMutation({
      taskId: source.taskId,
      changes: [projected.change]
    });
    return projected.interaction;
  }

  private async prepareProductInteractionChange(source:ProductTaskInteractionSource,knownTask?:PersistedAgentTask,knownPrevious?:PersistedTaskInteractionChange):Promise<{change:TaskInteractionChangeInput;interaction:TaskInteractionItem}|null>{
    const task=knownTask??await this.store.findTask(source.taskId);
    if(!task)throw new ProductError("Task not found",404);
    const redaction=await this.interactionRedaction(task);
    let previous=knownPrevious;
    if(previous===undefined){
      const seed=projectTaskInteraction(source,null,redaction).interaction;
      if(!seed)return null;
      previous=await this.store.findLatestTaskInteractionChange(source.taskId,seed.id)??undefined;
    }
    const projected=projectTaskInteraction(source,previous?{
      interaction:previous.interaction,
      sourceKind:previous.sourceKind,
      sourceId:previous.sourceId,
      sourceRevision:previous.sourceRevision,
      ...(previous.correlation?{correlation:previous.correlation}:{})
    }:null,redaction);
    if(!projected.interaction)return null;
    return{interaction:projected.interaction,change:{sourceKind:"product",sourceId:source.sourceId,sourceRevision:source.sourceRevision,interaction:projected.interaction,...(projected.correlation?{correlation:projected.correlation}:{})}};
  }

  private async previousProjectionState(task: PersistedAgentTask, event: BotifiedTimelineEvent, latest: Map<string, TaskInteractionItem>, messages: PersistedTaskMessage[], redaction: InteractionTextRedactionOptions, inBatchCorrelations: Map<string, TaskInteractionProjectionState>): Promise<TaskInteractionProjectionState | null> {
    if (["input.accepted", "input.queued", "input.rejected"].includes(event.type)) {
      const inputId = stringValue(event.data.input_id);
      if (inputId && task.startReceipt?.messageId === inputId) {
        const seeded = projectTaskInteraction(initialPromptProductSource(task), null, redaction).interaction;
        const interaction = seeded ? latest.get(seeded.id) : undefined;
        const persisted = !interaction && seeded ? await this.store.findLatestTaskInteractionChange(task.id,seeded.id) : null;
        if (interaction||persisted) return { interaction:interaction??persisted!.interaction };
      }
      const message = inputId ? messages.find((candidate) => candidate.receipt?.messageId === inputId) : undefined;
      if (message) {
        const seeded = projectTaskInteraction(messageProductSource(message), null, redaction).interaction;
        const interaction = seeded ? latest.get(seeded.id) : undefined;
        const persisted = !interaction && seeded ? await this.store.findLatestTaskInteractionChange(task.id,seeded.id) : null;
        if (interaction||persisted) return { interaction:interaction??persisted!.interaction };
      }
    }
    const correlation = timelineCorrelation(event);
    if (correlation) {
      for (const key of correlationKeys(correlation)) {
        const inBatch = inBatchCorrelations.get(key);
        if (inBatch) return inBatch;
      }
      const interaction = await this.store.findTaskInteractionByCorrelation(task.id, correlation);
      if (interaction) return { interaction:latest.get(interaction.id) ?? interaction, correlation };
    }
    const seeded = projectTaskInteraction({ sourceKind:"botified", taskId:task.id, event }, null, redaction).interaction;
    const interaction = seeded ? latest.get(seeded.id) : undefined;
    const persisted = !interaction && seeded ? await this.store.findLatestTaskInteractionChange(task.id,seeded.id) : null;
    return interaction||persisted ? { interaction:interaction??persisted!.interaction, ...(correlation ? { correlation } : persisted?.correlation ? { correlation:persisted.correlation } : {}) } : null;
  }

  private async messageReceipt(userId: string | null, message: PersistedTaskMessage, duplicate: boolean): Promise<TaskMessageReceipt> {
    const task = await this.store.findTask(message.taskId);
    if (!task) throw new ProductError("Task not found", 404);
    const queued = await this.store.listTaskMessages(message.taskId);
    const interaction = await this.latestMessageInteraction(message);
    const disposition = messageDisposition(message, interaction);
    return {
      messageId: message.id,
      disposition,
      targetTaskId: message.targetTaskId ?? message.taskId,
      duplicate,
      queuedMessage: isQueuedMessage(message) ? queuedMessage(message) : null,
      interaction: disposition === "queued_for_active_run" ? null : interaction?.kind === "user_message" || interaction?.kind === "execution_boundary" ? interaction : null,
      capabilities: userId ? await this.taskCapabilities(userId, task, undefined, queued) : defaultTaskCapabilities(task),
      ...(disposition === "failed" ? { safeError:safeMessageFailure(message.safeError) } : {})
    };
  }

  private async latestMessageInteraction(message: PersistedTaskMessage): Promise<TaskInteractionItem | null> {
    const task = await this.store.findTask(message.taskId);
    if (!task) return null;
    const seeded = projectTaskInteraction(messageProductSource(message), null, await this.interactionRedaction(task)).interaction;
    if (!seeded) return null;
    return (await this.store.findLatestTaskInteractionChange(message.taskId,seeded.id))?.interaction??null;
  }

  private async completeMessageIdempotency(message: PersistedTaskMessage): Promise<void> {
    await this.store.completeTaskIdempotencyForResource(message.id, 200, await this.messageReceipt(null, message, false), nowIso());
  }

  private async taskInteractionState(
    userId: string,
    task: PersistedAgentTask,
    snapshot: { queuedMessages: PersistedTaskMessage[]; historyStatus: TaskHistoryStatus; lastSyncedAt: string | null }
  ): Promise<TaskInteractionState> {
    const runtime = await this.taskRuntimePresentation(task);
    const capabilities = await this.taskCapabilities(userId, task, runtime.runState, snapshot.queuedMessages);
    return {
      queuedMessages: snapshot.queuedMessages.map((message) => {
        const presented = queuedMessage(message);
        return capabilities.editQueuedMessage ? presented : { ...presented, editable:false, deletable:false };
      }),
      runState: runtime.runState,
      runtimeReachability: runtime.reachability,
      historyStatus: snapshot.historyStatus,
      lastSyncedAt: snapshot.lastSyncedAt,
      capabilities
    };
  }

  private async taskRuntimePresentation(task: PersistedAgentTask): Promise<{ runState: TaskRunState; reachability: TaskRuntimeReachability }> {
    const terminal = Boolean(task.terminalReason) || isTerminalTaskStatus(task.status);
    const finalizing = task.status === "stopping" || terminal && task.executionMode === "live"
      && (task.artifactProjectionStatus !== "drained" || task.cleanupStatus !== "completed");
    if (task.executionMode !== "live") return { runState:terminal ? "terminal" : "idle", reachability:"reachable" };
    if (terminal && !finalizing) return { runState:"terminal", reachability:"unknown" };
    const runState = this.abortingTaskIds.has(task.id) ? "aborting" : finalizing ? "finalizing" : null;
    if (task.startIntentStatus !== "dispatched") return { runState:runState ?? "starting", reachability:"unknown" };
    try {
      const serviceKey = this.serviceKeyForTask(task);
      const runtime = await this.readRuntimeState(task, serviceKey);
      const state = await this.botified.readState(runtime.baseUrl, serviceKey);
      return { runState:runState ?? (state.state === "running" ? "running" : "idle"), reachability:"reachable" };
    } catch {
      return { runState:runState ?? "reconnecting", reachability:"unreachable" };
    }
  }

  private async taskCapabilities(userId: string, task: PersistedAgentTask, knownRunState?: TaskRunState, queued: PersistedTaskMessage[] = []): Promise<TaskCapabilities> {
    const [membership, project, executionEligible] = await Promise.all([
      this.store.findProjectMembership(task.projectId, userId),
      this.store.findProject(task.projectId),
      this.taskExecutionEligible(task)
    ]);
    const canWrite = Boolean(project && (project.lifecycleStatus === undefined || project.lifecycleStatus === "active") && membership && ["owner","admin","member"].includes(membership.role));
    const retained = !task.deletedAt && !task.archivedAt;
    const canInteract = canWrite && retained && executionEligible;
    const runState = knownRunState ?? (await this.taskRuntimePresentation(task)).runState;
    return {
      sendMessage: canInteract,
      editQueuedMessage: canInteract && queued.some((message) => (message.deliveryStatus ?? "pending") === "pending" && !message.deletedAt),
      abortTurn: canInteract && task.executionMode === "live" && !task.terminalReason && runState === "running",
      cancelTask: canWrite && retained && !task.terminalReason && isActiveTaskStatus(task.status),
      openTerminal: canInteract && task.executionMode === "live" && !task.terminalReason && isActiveTaskStatus(task.status) && !this.occupiedTerminalTaskIds.has(task.id),
      editTask: canWrite && !task.deletedAt,
      retryTask: canWrite && !task.deletedAt && Boolean(task.terminalReason),
      duplicateTask: canWrite && !task.deletedAt,
      archiveTask: canWrite && !task.deletedAt && !task.archivedAt && Boolean(task.terminalReason),
      deleteTask: canWrite && Boolean(task.terminalReason) && (task.executionMode !== "live" || task.cleanupStatus === "completed")
    };
  }

  private async taskExecutionEligible(task: PersistedAgentTask): Promise<boolean> {
    if (task.deletedAt || task.archivedAt) return false;
    const endpoint = await this.store.findEndpoint(task.endpointId);
    if (!endpoint || endpoint.projectId !== task.projectId || TASK_ENDPOINT_CAPABILITIES.some((capability) => !endpoint.capabilities.includes(capability))) return false;
    const credential = await this.store.findProjectCredential(endpoint.credentialId);
    if (!credential || credential.projectId !== task.projectId) return false;
    try {
      return normalizeOpenAICompatibleBaseUrl(endpoint.baseUrl) === normalizeOpenAICompatibleBaseUrl(credential.baseUrl, 500);
    } catch {
      return false;
    }
  }

  private async runtimeCanStartTaskTurn(task: PersistedAgentTask): Promise<boolean> {
    if (isTerminalTask(task)) return true;
    try {
      const serviceKey = this.serviceKeyForTask(task);
      const runtime = await this.readRuntimeState(task, serviceKey);
      const state = await this.botified.readState(runtime.baseUrl, serviceKey);
      return state.state === "idle" || state.state === "failed";
    } catch {
      return false;
    }
  }

  private encodeInteractionCursor(task: PersistedAgentTask, kind: "stream" | "history", changeSeq: number, anchor?: TaskInteractionPageAnchor): string {
    const payload = Buffer.from(JSON.stringify({ v:1, k:kind, t:task.id, s:changeSeq, ...(anchor ? { p:anchor.position, i:anchor.interactionId } : {}) }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.interactionCursorSecret(task)).update(payload).digest("base64url");
    return `tic1.${payload}.${signature}`;
  }

  private decodeInteractionCursor(task: PersistedAgentTask, cursor: string, kind: "stream" | "history"): { changeSeq: number; anchor?: TaskInteractionPageAnchor } {
    const parts = cursor.split(".");
    if (parts.length !== 3 || parts[0] !== "tic1") throw new ProductError("Task interaction cursor is invalid", 400);
    const expected = createHmac("sha256", this.interactionCursorSecret(task)).update(parts[1]!).digest("base64url");
    if (!constantTimeEqual(parts[2]!, expected)) throw new ProductError("Task interaction cursor is invalid for this task", 400);
    let value: unknown;
    try { value = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")); } catch { throw new ProductError("Task interaction cursor is invalid", 400); }
    if (!isUnknownRecord(value) || value.v !== 1 || value.k !== kind || value.t !== task.id || !Number.isSafeInteger(value.s) || Number(value.s) < 0) throw new ProductError("Task interaction cursor is invalid for this task", 400);
    if (kind === "history") {
      if (!Number.isSafeInteger(value.p) || Number(value.p) < 0 || typeof value.i !== "string" || !value.i) throw new ProductError("Task interaction history cursor is invalid", 400);
      return { changeSeq:Number(value.s), anchor:{ position:Number(value.p), interactionId:value.i } };
    }
    return { changeSeq:Number(value.s) };
  }

  private interactionCursorSecret(task: PersistedAgentTask): string {
    return this.config.botifiedServiceKeySecret ?? this.serviceKeyForTask(task);
  }

  private async interactionRedaction(task: PersistedAgentTask, serviceKey = this.serviceKeyForTask(task)): Promise<InteractionTextRedactionOptions> {
    const endpoint = await this.endpoints.requireEndpointForProject(task.projectId, task.endpointId);
    const credential = this.config.credentials ? await this.config.credentials.resolve(task.projectId, endpoint.credentialId) : null;
    return { knownSecrets:new Set([serviceKey, ...(credential ? [credential.apiKey] : [])]) };
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

async function copyProjectInputTree(
  source: string,
  destination: string,
  relativePath: string,
  manifest: TaskInputManifestEntry[],
  required = false
): Promise<void> {
  let sourceStat;
  try {
    sourceStat = await lstat(source);
  } catch (error) {
    if (isNotFound(error)) {
      if(required)throw new ProductError(`Task input path not found: ${relativePath}`,404);
      return;
    }
    throw error;
  }
  if (sourceStat.isSymbolicLink()) {
    throw new ProductError("Task input source uses a symlink");
  }
  if (sourceStat.isDirectory()) {
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelativePath = path.posix.join(relativePath, entry.name);
      const childSource = path.join(source, entry.name);
      const childDestination = path.join(destination, entry.name);
      await copyProjectInputTree(childSource, childDestination, childRelativePath, manifest);
    }
    return;
  }
  if (!sourceStat.isFile()) {
    throw new ProductError("Task input source must contain regular files and directories");
  }

  const bytes = await readRegularFileWithoutFollowingSymlink(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  manifest.push({
    path: relativePath,
    size: bytes.byteLength,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  });
}

function normalizeTaskTitle(value: string | undefined, prompt: string): string {
  const title = value === undefined ? prompt.replace(/[\r\n]+/g, " ").trim().slice(0, 160) : value.trim();
  if (!title) throw new ProductError("task.title must not be empty", 400);
  if (title.length > 160) throw new ProductError("task.title must be at most 160 characters", 400);
  return title;
}

function publicTask(task: PersistedAgentTask): AgentTask {
  return {
    id:task.id,
    workspaceId:task.workspaceId,
    projectId:task.projectId,
    endpointId:task.endpointId,
    ...(task.title !== undefined ? { title:task.title } : {}),
    prompt:task.prompt,
    ...(task.inputPaths !== undefined ? { inputPaths:[...task.inputPaths] } : {}),
    status:task.status,
    runId:task.runId,
    ...(task.sourceTaskId !== undefined ? { sourceTaskId:task.sourceTaskId } : {}),
    executionMode:task.executionMode,
    sandbox:{ namespace:task.sandbox.namespace },
    ...(task.activeReservation !== undefined ? { activeReservation:task.activeReservation } : {}),
    ...(task.archivedAt !== undefined ? { archivedAt:task.archivedAt } : {}),
    ...(task.deletedAt !== undefined ? { deletedAt:task.deletedAt } : {}),
    ...(task.terminalReason !== undefined ? { terminalReason:task.terminalReason } : {}),
    ...(task.terminalizedAt !== undefined ? { terminalizedAt:task.terminalizedAt } : {}),
    ...(task.startIntentStatus !== undefined ? { startIntentStatus:task.startIntentStatus } : {}),
    ...(task.startSafeError !== undefined ? { startSafeError:task.startSafeError } : {}),
    ...(task.artifactProjectionStatus !== undefined ? { artifactProjectionStatus:task.artifactProjectionStatus } : {}),
    ...(task.artifactProjectionError !== undefined ? { artifactProjectionError:task.artifactProjectionError } : {}),
    ...(task.cleanupStatus !== undefined ? { cleanupStatus:task.cleanupStatus } : {}),
    ...(task.cleanupError !== undefined ? { cleanupError:task.cleanupError } : {}),
    ...(task.cleanupCompletedAt !== undefined ? { cleanupCompletedAt:task.cleanupCompletedAt } : {}),
    createdAt:task.createdAt,
    updatedAt:task.updatedAt
  };
}

function publicArtifact(artifact: PersistedTaskArtifact): AgentTaskArtifact {
  return {
    id:artifact.id,
    taskId:artifact.taskId,
    name:artifact.name,
    bytes:artifact.bytes,
    ...(artifact.sha256 !== undefined ? { sha256:artifact.sha256 } : {}),
    ...(artifact.mediaType !== undefined ? { mediaType:artifact.mediaType } : {}),
    ...(artifact.previewText !== undefined ? { previewText:artifact.previewText } : {}),
    createdAt:artifact.createdAt
  };
}

function normalizeTaskInputPaths(paths: string[] | undefined): string[] {
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || paths.some((value) => typeof value !== "string")) throw new ProductError("task.inputPaths must be an array of file paths", 400);
  const normalized = paths.map((value) => value.replace(/\\/g, "/").replace(/^\/+/, "").trim()).filter(Boolean);
  for (const value of normalized) {
    if ((value !== "files" && !value.startsWith("files/")) || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new ProductError("task.inputPaths must stay under files/", 400);
    }
  }
  return [...new Set(normalized)].sort();
}

function collapseSelectedInputPaths(paths:string[]):string[]{
  const collapsed:string[]=[];
  for(const selected of paths){if(collapsed.some((parent)=>selected===parent||selected.startsWith(`${parent}/`)))continue;collapsed.push(selected);}
  return collapsed;
}

function normalizeIdempotencyKey(value:string|undefined):string{
  if(value===undefined)return newId("internal_idempotency");
  const key=value.trim();if(!key)throw new ProductError("Idempotency-Key is required",400);if(key.length>200)throw new ProductError("Idempotency-Key must be at most 200 characters",400);return key;
}

function canonicalRequestHash(value:unknown):string{return createHash("sha256").update(canonicalJson(value),"utf8").digest("base64url");}
function canonicalJson(value:unknown):string{
  if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
  if(typeof value==="number"){if(!Number.isFinite(value))throw new ProductError("Task request contains a non-finite number",400);return JSON.stringify(value);}
  if(Array.isArray(value))return`[${value.map(canonicalJson).join(",")}]`;
  if(isUnknownRecord(value))return`{${Object.keys(value).sort().filter((key)=>value[key]!==undefined).map((key)=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new ProductError("Task request cannot be canonically hashed",400);
}

function isUnknownRecord(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value);}

function safeTaskStageError(error:unknown):string{return redactSecretLikeText(error instanceof Error?error.message:"Task maintenance failed").slice(0,300);}

function taskOperation(value: "message" | "message-edit" | "message-delete" | "abort-turn" | "work-stop"): TaskIdempotencyOperation {
  return value as TaskIdempotencyOperation;
}

function isMessageReceiptOperation(operation: TaskIdempotencyOperation): boolean {
  return ["message", "message-edit", "message-delete"].includes(String(operation));
}

function startInteractionStatus(task: PersistedAgentTask): "pending" | "dispatching" | "retrying" | "accepted" | "failed" {
  if (task.startIntentStatus === "failed") return "failed";
  if (task.startIntentStatus === "dispatched" || task.executionMode === "dry-run") return "accepted";
  if (task.terminalReason && task.startIntentStatus === "pending") return "failed";
  if (task.startIntentStatus === "dispatching") return task.startSafeError ? "retrying" : "dispatching";
  return "pending";
}

function startInteractionRank(task: PersistedAgentTask): number {
  return { pending:1, dispatching:2, retrying:3, accepted:4, failed:5 }[startInteractionStatus(task)];
}

function initialPromptProductSource(task: PersistedAgentTask): ProductTaskInteractionSource {
  return {
    sourceKind: "product",
    type: "task_created",
    taskId: task.id,
    sourceId: `task:${task.id}:prompt`,
    sourceRevision: productSourceRevision(task.updatedAt, startInteractionRank(task)),
    occurredAt: task.updatedAt,
    position: productPosition(task.createdAt, `${task.id}:prompt`),
    messageId: task.id,
    content: task.prompt,
    status: startInteractionStatus(task)
  };
}

function productSourceRevision(timestamp: string, rank: number): number {
  const milliseconds = Date.parse(timestamp);
  return (Number.isFinite(milliseconds) ? milliseconds : 0) * 10 + rank;
}

function strictlyLaterIso(previous: string): string {
  const previousTime = Date.parse(previous);
  const currentTime = Date.now();
  return new Date(Number.isFinite(previousTime) ? Math.max(currentTime, previousTime + 1) : currentTime).toISOString();
}

function productPosition(timestamp: string, id: string): number {
  const milliseconds = Date.parse(timestamp);
  const suffix = createHash("sha256").update(id).digest().readUInt16BE(0) % 1000;
  return (Number.isFinite(milliseconds) ? milliseconds : 0) * 1000 + suffix;
}

function timelinePosition(event: BotifiedTimelineEvent): number {
  const milliseconds = Date.parse(event.time);
  return (Number.isFinite(milliseconds) ? milliseconds : 0) * 1000 + Math.abs(event.seq % 1000);
}

function messageProductSource(message: PersistedTaskMessage): ProductTaskInteractionSource {
  const updatedAt = message.updatedAt ?? message.createdAt;
  const status = message.deliveryStatus ?? "pending";
  if (status === "terminal_pending" || status === "successor_created") {
    return {
      sourceKind: "product",
      type: "successor_created",
      taskId: message.taskId,
      sourceId: `message:${message.id}:boundary`,
      sourceRevision: productSourceRevision(updatedAt, status === "successor_created" ? 2 : 1),
      occurredAt: updatedAt,
      position: productPosition(message.createdAt, `${message.id}:boundary`),
      boundaryId: message.id,
      status: status === "successor_created" ? "successor_created" : "successor_pending",
      targetTaskId: message.targetTaskId ?? null
    };
  }
  const projectedStatus = status === "accepted" ? "accepted"
    : status === "failed" ? "failed"
      : status === "dispatching" && message.safeError ? "retrying"
        : status === "dispatching" ? "dispatching" : "pending";
  return {
    sourceKind: "product",
    type: "message_delivery",
    taskId: message.taskId,
    sourceId: `message:${message.id}`,
    sourceRevision: productSourceRevision(updatedAt, { pending:1, dispatching:2, retrying:3, accepted:4, failed:5 }[projectedStatus]),
    occurredAt: updatedAt,
    position: productPosition(message.createdAt, message.id),
    messageId: message.id,
    content: message.content,
    status: projectedStatus
  };
}

function turnAbortedProductSource(task: PersistedAgentTask, turnId: string, occurredAt: string): ProductTaskInteractionSource {
  const sourceId = `turn:${turnId}:abort`;
  return {
    sourceKind: "product",
    type: "turn_aborted",
    taskId: task.id,
    sourceId,
    sourceRevision: 1,
    occurredAt,
    position: productPosition(occurredAt, sourceId),
    turnId
  };
}

function backgroundWorkStoppedProductSource(
  task: PersistedAgentTask,
  previous: PersistedTaskInteractionChange,
  status: TaskBackgroundWorkStopResult["state"],
  occurredAt: string
): ProductTaskInteractionSource {
  if (previous.interaction.kind !== "background_task" || !previous.correlation?.workTaskId) {
    throw new ProductError("Background work interaction not found", 404);
  }
  const workTaskId = previous.correlation.workTaskId;
  return {
    sourceKind: "product",
    type: "background_work_stopped",
    taskId: task.id,
    sourceId: `background-work:${workTaskId}:stop`,
    sourceRevision: backgroundWorkStopRevision(status),
    occurredAt,
    position: previous.interaction.position,
    workTaskId,
    ...(previous.correlation.toolCallId ? { toolCallId:previous.correlation.toolCallId } : {}),
    status
  };
}

function backgroundWorkStopRevision(status: TaskBackgroundWorkStopResult["state"]): number {
  if (status === "running") return 1;
  if (status === "cancelling") return 2;
  return 3;
}

function activeTurnIdentity(state: BotifiedRuntimeStateResult, task: PersistedAgentTask): string {
  for (const item of state.activeItems ?? []) {
    if (!isUnknownRecord(item) || item.type !== "cycle" || item.status !== "running") continue;
    const id = stringValue(item.id);
    if (id) return id;
  }
  return state.timelineCursor ?? task.startReceipt?.messageId ?? task.startDeliveryKey ?? task.runId;
}

function queuedMessage(message: PersistedTaskMessage): TaskQueuedMessage {
  const status = message.deliveryStatus ?? "pending";
  const deliveryStatus: TaskQueuedMessage["deliveryStatus"] = status === "accepted" || status === "successor_created" ? "failed" : status;
  return {
    id: message.id,
    content: message.content,
    deliveryStatus,
    editable: status === "pending" && !message.deletedAt,
    deletable: status === "pending" && !message.deletedAt,
    updatedAt: message.updatedAt ?? message.createdAt
  };
}

function isQueuedMessage(message: PersistedTaskMessage): boolean {
  return ["pending", "dispatching", "terminal_pending", "failed"].includes(message.deliveryStatus ?? "pending") && !message.deletedAt;
}

function isSettledMessage(message: PersistedTaskMessage): boolean {
  return ["accepted", "successor_created", "failed"].includes(message.deliveryStatus ?? "");
}

function messageDisposition(message: PersistedTaskMessage, interaction: TaskInteractionItem | null): TaskMessageReceipt["disposition"] {
  switch (message.deliveryStatus) {
    case "successor_created": return "successor_created";
    case "terminal_pending": return "successor_pending";
    case "failed": return "failed";
    case "accepted": return interaction?.kind === "user_message" && interaction.status === "queued" ? "queued_for_active_run" : "accepted_by_active_run";
    default: return "queued_for_active_run";
  }
}

function timelineCorrelation(event: BotifiedTimelineEvent): TaskInteractionCorrelation | null {
  const toolCallId = stringValue(event.data.tool_call_id);
  const workTaskId = stringValue(event.data.task_id);
  const callbackId = stringValue(event.data.callback_id);
  return toolCallId || workTaskId || callbackId ? { ...(toolCallId?{toolCallId}:{}), ...(workTaskId?{workTaskId}:{}), ...(callbackId?{callbackId}:{}) } : null;
}

function correlationKeys(correlation: TaskInteractionCorrelation | null | undefined): string[] {
  if (!correlation) return [];
  return [
    ...(correlation.toolCallId ? [`tool:${correlation.toolCallId}`] : []),
    ...(correlation.workTaskId ? [`work:${correlation.workTaskId}`] : []),
    ...(correlation.callbackId ? [`callback:${correlation.callbackId}`] : [])
  ];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeMessageFailure(value: string | null | undefined): string {
  return redactSecretLikeText(value?.trim() || "Message delivery failed.").slice(0, 300);
}

function isAbortedCycleEvent(event: BotifiedTimelineEvent): boolean {
  if (event.type !== "cycle.failed" || !isUnknownRecord(event.data.error)) return false;
  return event.data.error.code === "aborted" || event.data.error.code === "cancelled";
}

function stableTaskInteractionId(taskId: string, sourceId: string): string {
  return `int_${createHash("sha256").update(`${taskId}\0${sourceId}`).digest("hex").slice(0,24)}`;
}

function defaultTaskCapabilities(task: PersistedAgentTask): TaskCapabilities {
  const active = !task.terminalReason && isActiveTaskStatus(task.status);
  return { sendMessage:!task.deletedAt, editQueuedMessage:false, abortTurn:false, cancelTask:active, openTerminal:active&&task.executionMode==="live", editTask:!task.deletedAt, retryTask:!task.deletedAt&&Boolean(task.terminalReason), duplicateTask:!task.deletedAt, archiveTask:!task.deletedAt&&!task.archivedAt&&Boolean(task.terminalReason), deleteTask:Boolean(task.terminalReason)&&(task.executionMode!=="live"||task.cleanupStatus==="completed") };
}

function normalizeTaskStatuses(statuses: AgentTaskStatus[] | undefined): AgentTaskStatus[] {
  if (statuses === undefined) return [];
  const allowed = new Set<AgentTaskStatus>(["queued","starting","running","stopping","completed","failed","expired","cancelled","cleaned"]);
  if (!Array.isArray(statuses) || statuses.some((status) => !allowed.has(status))) throw new ProductError("Task status filter is invalid", 400);
  return [...new Set(statuses)];
}

type TaskListCursorScope = {
  search: string;
  statuses: AgentTaskStatus[];
  archived: NonNullable<TaskListQuery["archived"]>;
  sort: NonNullable<TaskListQuery["sort"]>;
  direction: NonNullable<TaskListQuery["direction"]>;
};

function encodeTaskListCursor(offset: number, query: TaskListCursorScope): string {
  return Buffer.from(JSON.stringify({ offset, query }), "utf8").toString("base64url");
}

function decodeTaskListCursor(cursor: string | undefined, query: TaskListCursorScope): number {
  if (!cursor) return 0;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  let decoded: { offset?: unknown; query?: unknown };
  try { decoded = JSON.parse(text) as { offset?: unknown; query?: unknown }; }
  catch { throw new ProductError("Task list cursor is invalid", 400); }
  const matchesQuery = isUnknownRecord(decoded.query) && canonicalJson(decoded.query) === canonicalJson(query);
  if (Buffer.from(text, "utf8").toString("base64url") !== cursor || !Number.isSafeInteger(decoded.offset) || (decoded.offset as number) < 0 || !matchesQuery) throw new ProductError("Task list cursor is invalid for this query", 400);
  return decoded.offset as number;
}

function isTerminalTask(task: PersistedAgentTask): boolean {
  return Boolean(task.terminalReason) || ["completed","failed","expired","cancelled","cleaned"].includes(task.status);
}

async function readRegularFileWithoutFollowingSymlink(source: string, label = "Task input source"): Promise<Buffer> {
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isSymlinkOpenError(error)) {
      throw new ProductError(`${label} uses a symlink`);
    }
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new ProductError(`${label} must be a regular file`);
    }
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

function stableSandboxArtifactId(taskId: string, fileId: string): string {
  return `art_${createHash("sha256").update(taskId).update("\0").update(fileId).digest("base64url").slice(0, 24)}`;
}

async function listRegularArtifactFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const pending = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.shift()!;
    const directory = relativeDirectory ? path.resolve(root, ...relativeDirectory.split("/")) : root;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      if (entry.isDirectory()) {
        pending.push(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
        if (files.length > limit) throw new ProductError(`Task artifacts may contain at most ${limit} files`, 409);
      }
    }
  }
  return files;
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

function deliveryKeyForStart(taskId: string, runId: string): string {
  return "delivery_start_" + taskId + "_" + runId;
}

function messageAuditDetail(taskId: string, message: Pick<PersistedTaskMessage, "id" | "deliveryStatus">): import("../../contracts/src/api.js").ProjectAuditSafeDetail {
  return { taskId, messageId: message.id, ...(message.deliveryStatus === undefined ? {} : { deliveryStatus: message.deliveryStatus }) };
}

function deliveryKeyForMessage(messageId:string,runId:string):string{return `delivery_message_${messageId}_${runId}`;}

function deliveryRequestHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("base64url");
}

function defaultBotifiedBaseUrlForTask(input: BotifiedTaskAddressInput): string {
  return `http://${sandboxServiceNameForTask(input.taskId)}.${input.namespace}.svc.cluster.local:${input.port}`;
}

function defaultBotifiedBrokerBaseUrlForTask(input: BotifiedBrokerAddressInput): string {
  return `http://${APP_KUBERNETES_SERVICE_NAME}.${input.namespace}.svc.cluster.local:${APP_KUBERNETES_SERVICE_PORT}/api/internal/tasks/${encodeURIComponent(input.taskId)}/runs/${encodeURIComponent(input.runId)}/v1`;
}

function requireBotifiedServiceKey(serviceKey: string | undefined): asserts serviceKey is string {
  if (serviceKey === undefined || serviceKey.trim() === "") {
    throw new ProductError("Botified service key is required", 500);
  }
}

function materializeLiveCreateActions(
  actions: SandboxReconcileAction[],
  input: { serviceKey: string; botifiedConfig: string }
): SandboxReconcileAction[] {
  return actions.map((action) => {
    if (action.type !== "create_resource") {
      return structuredClone(action);
    }
    const resource = structuredClone(action.resource);
    if (action.kind === "Secret") {
      resource.stringData = {
        BOTIFIED_SERVICE_KEY: input.serviceKey
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

function constantTimeEqual(value: string, expected: string): boolean {
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

function isActiveBotifiedTask(status: AgentTaskStatus): boolean {
  return status === "starting" || status === "running";
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

function nextStatusForTimeline(current: AgentTaskStatus, events: BotifiedTimelineEvent[], canComplete: boolean): AgentTaskStatus {
  if (current === "stopping") {
    return current;
  }
  let status = current;
  for (const event of events) {
    if (event.type === "cycle.failed" && !isAbortedCycleEvent(event)) {
      status = "failed";
      continue;
    }
    if (status !== "failed" && event.type === "cycle.completed") {
      status = canComplete ? "completed" : "running";
      continue;
    }
    if (status !== "failed" && (event.type === "cycle.started" || event.type === "input.accepted" || event.type === "input.queued")) {
      status = "running";
    }
  }
  return status;
}

function isPendingTaskMessage(message: PersistedTaskMessage): boolean {
  return !message.deletedAt && ["pending", "dispatching", "terminal_pending"].includes(message.deliveryStatus ?? "pending");
}

function isBotifiedSessionQuiescent(state: BotifiedRuntimeStateResult, timelineCursor: string | null): boolean {
  if (!timelineCursor || state.timelineCursor !== timelineCursor || state.state !== "idle" || !isUnknownRecord(state.snapshot)) return false;
  const queueLength = state.snapshot.queue_length;
  const tasks = state.snapshot.tasks;
  const activeItems = state.activeItems ?? state.snapshot.active_items;
  if (queueLength !== 0 || !isUnknownRecord(tasks) || !Array.isArray(activeItems)) return false;
  if (![tasks.running, tasks.cancelling, tasks.pending_callbacks, tasks.pending_asks].every((value) => value === 0)) return false;
  return !activeItems.some((item) => {
    if (!isUnknownRecord(item)) return false;
    if (["input", "task_ask", "subagent"].includes(String(item.type))) return true;
    return item.type === "background_task" && ["running", "cancelling"].includes(String(item.status));
  });
}

function isTerminalTaskStatus(status: AgentTaskStatus): status is Extract<AgentTaskStatus, "completed" | "failed" | "expired" | "cancelled" | "cleaned"> {
  return status === "completed" || status === "failed" || status === "expired" || status === "cancelled" || status === "cleaned";
}

function isInteractionLifecycleStatus(status: AgentTaskStatus): status is Extract<AgentTaskStatus, "queued" | "starting" | "running" | "stopping"> {
  return status === "queued" || status === "starting" || status === "running" || status === "stopping";
}

function terminalReasonForStatus(status:Extract<AgentTaskStatus,"completed"|"failed"|"expired"|"cancelled"|"cleaned">):TaskTerminalReason{
  return status==="completed"?"completed":status==="failed"?"failed":status==="expired"?"expired":status==="cancelled"?"cancelled":"cleaned_legacy";
}

function taskAuditActionForReason(reason:TaskTerminalReason):import("../../contracts/src/api.js").ProjectAuditAction{
  return reason==="failed"?"task.failed":reason==="expired"?"task.expired":reason==="cancelled"?"task.cancel":reason==="cleaned_legacy"?"task.cleaned":"task.completed";
}

function isDurableTaskResultStatus(status: AgentTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "expired" || status === "cancelled";
}

function isActiveTaskStatus(status: AgentTaskStatus): boolean {
  return status === "queued" || status === "starting" || status === "running" || status === "stopping";
}

function cleanupPhaseForTaskStatus(status: AgentTaskStatus): PersistedSandboxRunState["phase"] {
  return status === "expired" ? "expired" : "stopping";
}

function sandboxRunDeadlineElapsed(run: PersistedSandboxRunState, now: Date): boolean {
  return [run.expiresAt, run.idleExpiresAt].some((deadline) =>
    typeof deadline === "string" && Date.parse(deadline) <= now.getTime()
  );
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

function normalizeArtifactDisplayName(input: string, fallback: string): string {
  const cleaned = path.posix.basename(input.replace(/\\/g, "/"))
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 180);
  if (cleaned.length > 0) {
    return cleaned;
  }
  const fallbackCleaned = path.posix.basename(fallback.replace(/\\/g, "/"))
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 180);
  return fallbackCleaned.length > 0 ? fallbackCleaned : "artifact";
}

function filterTaskArtifacts(artifacts: AgentTaskArtifact[], filter: { mediaType?: string; previewOnly?: boolean }): AgentTaskArtifact[] {
  return artifacts.filter((artifact) =>
    (filter.mediaType === undefined || artifact.mediaType === filter.mediaType) &&
    (!filter.previewOnly || artifact.previewText !== null && artifact.previewText !== undefined)
  );
}

function artifactPreview(bytes: Uint8Array, name: string): Pick<AgentTaskArtifact, "mediaType" | "previewText"> {
  const extension = path.extname(name).toLowerCase();
  const mediaType = extension === ".html" || extension === ".htm"
    ? "text/html"
    : detectProjectFileMediaType(bytes, name);
  if (!mediaType.startsWith("text/") && mediaType !== "application/json") return { mediaType, previewText: null };
  if (mediaType === "text/html" || bytes.byteLength > 1_048_576) return { mediaType, previewText: null };
  const preview = Buffer.from(bytes.subarray(0, ARTIFACT_PREVIEW_MAX_BYTES)).toString("utf8").replace(/\u0000/g, "");
  return { mediaType, previewText: isSecretLikeText(preview) ? redactSecretLikeText(preview) : preview };
}

function artifactStorageSegment(input: string, fallback: string): string {
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

function isSymlinkOpenError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function prepareRunnerWritableDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: BOTIFIED_RUNNER_DIRECTORY_MODE });
  const chowned = await tryChownForRunner(directory);
  await chmod(directory, chowned ? BOTIFIED_RUNNER_DIRECTORY_MODE : BOTIFIED_RUNNER_FALLBACK_DIRECTORY_MODE);
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
