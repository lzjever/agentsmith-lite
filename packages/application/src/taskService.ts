import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateBotifiedConfig, serializeBotifiedConfig } from "../../botified-runtime/src/config.js";
import { projectBotifiedTimelineEvents, type BotifiedTimelineEvent } from "../../botified-runtime/src/projection.js";
import { isSecretLikeText, redactSecretLikeText } from "../../botified-runtime/src/redaction.js";
import type { AgentTask, AgentTaskArtifact, AgentTaskEvent, AgentTaskStatus, CreateTaskInput, KubernetesResource, ModelEndpoint, TaskFollowUp, TaskListPage, TaskListQuery, TaskSummary, TaskTerminalReason, TaskTranscriptEntry, TaskTranscriptPage } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../domain/src/sandboxDefaults.js";
import { requireNonEmptyString, requirePositiveInteger } from "../../domain/src/validation.js";
import { normalizeOpenAICompatibleBaseUrl } from "../../openai-compatible-client/src/index.js";
import { CredentialService } from "./credentialService.js";
import { BotifiedHttpError, type BotifiedDeliveryReceipt, type BotifiedRuntimeHttpClient, type BotifiedRuntimeStateResult } from "../../ports/src/botified.js";
import type { AtomicTaskCreateInput, PersistedSandboxRunState, ProductStore, TaskIdempotencyOperation } from "../../ports/src/store.js";
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

type BotifiedOperation = "send message" | "read state" | "read timeline" | "download file" | "abort";
type LiveSandboxCleanupStatus = "none" | "pending" | "cleaned";

export interface TaskArtifactDownload {
  artifact: AgentTaskArtifact;
  bytes: Buffer;
}

const BOTIFIED_RUNNER_UID = 10001;
const BOTIFIED_RUNNER_GID = 10001;
const BOTIFIED_RUNNER_DIRECTORY_MODE = 0o775;
const BOTIFIED_RUNNER_FALLBACK_DIRECTORY_MODE = 0o777;
const API_OWNED_ARTIFACT_DIRECTORY_MODE = 0o755;
const BOTIFIED_TASK_HOME_PATH = "/workspace/task/home";
const BOTIFIED_DATA_PATH = "/workspace/task/botified";
const TASK_ENDPOINT_CAPABILITIES = ["text", "tool_calls"] as const;
const ARTIFACT_PREVIEW_MAX_BYTES = 8_192;
const DEFAULT_DELIVERY_LEASE_MS = 30_000;
const DEFAULT_MAINTENANCE_LEASE_MS = 60_000;
const DEFAULT_TASK_RETRY_DELAY_MS = 5_000;
const IDEMPOTENCY_LEASE_MS = 30_000;

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
    return this.runIdempotentTaskOperation({
      actorId: userId,
      projectId,
      operation,
      key: idempotencyKey,
      request: { endpointId, prompt, title, inputPaths, sourceTaskId }
    }, newId("task"), async (id) => {
      const existing = await this.store.findTask(id);
      if (existing) return existing;
      if(sourceTaskId){const source=await this.store.findTask(sourceTaskId);if(!source||source.deletedAt||source.projectId!==projectId)throw new ProductError("Source task not found",404);if(operation==="retry"&&!isTerminalTask(source))throw new ProductError("Task must be terminal before retry",409);}
      const endpoint = await this.endpoints.requireCredentialEndpointForUser(userId, projectId, endpointId);
      requireTaskEndpointCapabilities(endpoint);
      if (this.config.liveSandbox) await this.requireNamespaceSandboxCapacity();
      const create = await this.prepareTaskCreate({ id, project, endpoint, prompt, title, inputPaths, sourceTaskId });
      let persisted: AgentTask | null = null;
      try {
        persisted = await this.store.createTaskAtomically(create);
        if (!persisted) {
          await this.policies.recordTaskReservationRejected(projectId, userId, id);
          throw new ProductError("Project active tasks limit reached", 409);
        }
      } catch (error) {
        if (create.task.executionMode === "live") await this.bestEffortRemoveTaskInputs(project.rootPath, id);
        throw error;
      }
      await this.policies.recordOperation(projectId, userId, "task.create", "accepted", persisted.id);
      return persisted;
    });
  }

  private async prepareTaskCreate(input: {
    id: string;
    project: Awaited<ReturnType<WorkspaceService["requireProjectForUser"]>>;
    endpoint: ModelEndpoint;
    prompt: string;
    title: string;
    inputPaths: string[];
    sourceTaskId: string | null;
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
    const task: AgentTask = {
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
      createdAt: timestamp,
      updatedAt: timestamp
    };
    if (!live) return { task, reserveActive: false };
    const serviceKey = this.serviceKeyForTask(task);
    requireBotifiedServiceKey(serviceKey);
    await this.snapshotProjectInputs(input.project.rootPath, input.id, input.inputPaths);
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
      if(begun.responseStatus>=400){const record=isUnknownRecord(begun.responseBody)?begun.responseBody:{};throw new ProductError(typeof record.error==="string"?record.error:"Task operation failed",begun.responseStatus);}
      return structuredClone(begun.responseBody) as T;
    }
    try{
      const response=await action(begun.resourceId);
      if(scope.operation==="follow-up"&&isUnknownRecord(response)&&["pending","dispatching","terminal_pending"].includes(String(response.deliveryStatus)))return response;
      if(!await this.store.completeTaskIdempotency({actorId:scope.actorId,projectId:scope.projectId,operation:scope.operation,key,requestHash,claimToken:begun.claimToken,responseStatus:200,responseBody:response,updatedAt:nowIso()}))throw new ProductError("Idempotent task operation lost its claim",409);
      return response;
    }catch(error){
      if(error instanceof ProductError)await this.store.completeTaskIdempotency({actorId:scope.actorId,projectId:scope.projectId,operation:scope.operation,key,requestHash,claimToken:begun.claimToken,responseStatus:error.statusCode,responseBody:{error:error.message},updatedAt:nowIso()});
      throw error;
    }
  }

  async listTasks(userId: string, projectId: string): Promise<AgentTask[]>;
  async listTasks(userId: string, projectId: string, query: TaskListQuery): Promise<TaskListPage>;
  async listTasks(userId: string, projectId: string, query?: TaskListQuery): Promise<AgentTask[] | TaskListPage> {
    await this.workspaces.requireProjectForUser(userId, projectId, "view");
    if (query === undefined) return (await this.store.listTasksForProject(projectId)).filter((task) => !task.deletedAt);
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
    return { items: page.items, total: page.total, nextCursor: offset + page.items.length < page.total ? encodeTaskListCursor(offset + page.items.length, listQuery) : null };
  }

  /** Internal deletion path: it preserves the existing fenced sandbox cleanup intent. */
  async stopTasksForProjectDeletion(projectId: string): Promise<void> {
    for (const task of await this.store.listTasksForProject(projectId)) {
      if (!isActiveTaskStatus(task.status)) continue;
      const finalized=await this.finalizeTaskLifecycle(task.id,"cancelled",null);
      await this.bestEffortAbortAndRequestCleanup(finalized);
      if(finalized.executionMode==="live"){await this.drainTaskArtifacts(finalized);const drained=await this.store.findTask(finalized.id);if(drained)await this.cleanupTaskRuntime(drained);}
    }
  }

  async listTaskSummaries(userId: string, projectId: string): Promise<TaskSummary[]> {
    await this.workspaces.requireProjectForUser(userId, projectId, "view");
    return this.store.listTaskSummariesForProject(projectId);
  }

  async getTask(userId: string, taskId: string): Promise<AgentTask> {
    return this.requireTaskForUser(userId, taskId, "view");
  }

  async getTaskSummary(userId: string, taskId: string): Promise<TaskSummary> {
    await this.requireTaskForUser(userId, taskId, "view");
    const summary = await this.store.findTaskSummary(taskId);
    if (!summary) throw new ProductError("Task not found", 404);
    return summary;
  }

  async listTaskFollowUps(userId: string, taskId: string): Promise<TaskFollowUp[]> {
    await this.requireTaskForUser(userId, taskId, "view");
    return this.store.listTaskFollowUps(taskId);
  }

  async followUpTask(userId: string, taskId: string, prompt: string, idempotencyKey?: string): Promise<TaskFollowUp> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "write");
    const text = requireNonEmptyString(prompt, "task.followUp.prompt");
    return this.runIdempotentTaskOperation({ actorId:userId,projectId:task.projectId,operation:"follow-up",key:idempotencyKey,request:{taskId,prompt:text} },newId("followup"),async(id)=>{
      const existing=await this.store.findTaskFollowUp(id);
      if(existing){const dispatched=await this.dispatchTaskFollowUp(existing);await this.policies.recordOperation(task.projectId,userId,"task.follow_up.create","accepted",task.id,"task",followUpAuditDetail(task.id,dispatched));return dispatched;}
      const current=await this.store.findTask(task.id);
      if(!current||current.deletedAt)throw new ProductError("Task not found",404);
      const timestamp=nowIso();
      const followUp:TaskFollowUp={id,taskId:task.id,prompt:text,followUpTaskId:null,deliveryKey:deliveryKeyForFollowUp(id,task.runId),requestHash:deliveryRequestHash(text),claimToken:null,receipt:null,timelineCursor:null,deliveryStatus:"pending",claimedAt:null,leaseExpiresAt:null,attemptCount:0,nextRetryAt:null,safeError:null,createdAt:timestamp,updatedAt:timestamp,deletedAt:null};
      if(isTerminalTask(current)){
        const successor=await this.prepareSuccessorCreate(current,followUp);
        const created=await this.store.createTerminalTaskFollowUp({followUp,successor});
        if(!created){await this.cleanupUnusedTaskCreate(successor);throw new ProductError("Project active tasks limit reached",409);}
        await this.policies.recordOperation(task.projectId,userId,"task.follow_up.create","accepted",task.id,"task",followUpAuditDetail(task.id,created));return created;
      }
      const queued=await this.store.createPendingTaskFollowUp(followUp);
      if(!queued){const terminalSource=await this.store.findTask(task.id);if(!terminalSource)throw new ProductError("Task not found",404);const successor=await this.prepareSuccessorCreate(terminalSource,followUp);const created=await this.store.createTerminalTaskFollowUp({followUp,successor});if(!created){await this.cleanupUnusedTaskCreate(successor);throw new ProductError("Project active tasks limit reached",409);}await this.policies.recordOperation(task.projectId,userId,"task.follow_up.create","accepted",task.id,"task",followUpAuditDetail(task.id,created));return created;}
      const dispatched=await this.dispatchTaskFollowUp(queued);await this.policies.recordOperation(task.projectId,userId,"task.follow_up.create","accepted",task.id,"task",followUpAuditDetail(task.id,dispatched));return dispatched;
    });
  }

  async editTaskFollowUp(userId:string,taskId:string,followUpId:string,prompt:string,idempotencyKey?:string):Promise<TaskFollowUp>{
    const task=await this.requireTaskRecordForUser(userId,taskId,"write");const text=requireNonEmptyString(prompt,"task.followUp.prompt");
    return this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"follow-up-edit",key:idempotencyKey,request:{taskId,followUpId,prompt:text}},followUpId,async()=>{const source=await this.store.findTask(task.id);if(!source||source.deletedAt)throw new ProductError("Task not found",404);const followUp=await this.store.findTaskFollowUp(followUpId);if(!followUp||followUp.taskId!==task.id)throw new ProductError("Task follow-up not found",404);const updated=await this.store.updatePendingTaskFollowUp(followUpId,text,deliveryRequestHash(text),nowIso());if(!updated)throw new ProductError("Only a pending follow-up can be edited",409);await this.policies.recordOperation(task.projectId,userId,"task.follow_up.edit","accepted",task.id,"task",followUpAuditDetail(task.id,updated));return updated;});
  }

  async deleteTaskFollowUp(userId:string,taskId:string,followUpId:string,idempotencyKey?:string):Promise<{deleted:true;followUpId:string}>{
    const task=await this.requireTaskRecordForUser(userId,taskId,"write");
    return this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"follow-up-delete",key:idempotencyKey,request:{taskId,followUpId}},followUpId,async()=>{const source=await this.store.findTask(task.id);if(!source||source.deletedAt)throw new ProductError("Task not found",404);const followUp=await this.store.findTaskFollowUp(followUpId);if(!followUp||followUp.taskId!==task.id)throw new ProductError("Task follow-up not found",404);if(!followUp.deletedAt&&!await this.store.deletePendingTaskFollowUp(followUpId,nowIso()))throw new ProductError("Only a pending follow-up can be deleted",409);await this.policies.recordOperation(task.projectId,userId,"task.follow_up.delete","accepted",task.id,"task",{taskId:task.id,followUpId});return{deleted:true as const,followUpId};});
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
    return this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"edit",key:idempotencyKey,request:{taskId,title:normalized}},task.id,async()=>{const updated=await this.store.updateTaskTitle(task.id,normalized,nowIso());if(!updated)throw new ProductError("Task not found",404);await this.policies.recordOperation(task.projectId,userId,"task.edit","accepted",task.id,"task",{taskId:task.id});return updated;});
  }

  async archiveTask(userId:string,taskId:string,idempotencyKey?:string):Promise<AgentTask>{
    const task=await this.requireTaskRecordForUser(userId,taskId,"write");
    return this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"archive",key:idempotencyKey,request:{taskId}},task.id,async()=>{const current=await this.store.findTask(task.id);if(!current||current.deletedAt)throw new ProductError("Task not found",404);const archived=current.archivedAt?current:await this.store.archiveTask(task.id,nowIso());if(!archived)throw new ProductError("Only a terminal task can be archived",409);await this.policies.recordOperation(task.projectId,userId,"task.archive","accepted",task.id,"task",{taskId:task.id});return archived;});
  }

  async deleteTask(userId:string,taskId:string,idempotencyKey?:string):Promise<{deleted:true;taskId:string}>{
    const task=await this.store.findTask(taskId);if(!task)throw new ProductError("Task not found",404);await this.workspaces.requireProjectForUser(userId,task.projectId,"write");
    return this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"delete",key:idempotencyKey,request:{taskId}},task.id,async()=>{const current=await this.store.findTask(task.id);if(!current?.deletedAt){if(current?.executionMode==="live"&&current.cleanupStatus!=="completed")throw new ProductError("Task cleanup is still pending",409);const deleted=await this.store.softDeleteTask(task.id,nowIso());if(!deleted)throw new ProductError("Only a terminal task can be deleted",409);}await this.policies.recordOperation(task.projectId,userId,"task.delete","accepted",task.id,"task",{taskId:task.id});return{deleted:true as const,taskId};});
  }

  async syncActiveTasksOnce(): Promise<ActiveTaskSyncResult> {
    const activeTasks = await this.store.listActiveTasks();
    const result: ActiveTaskSyncResult = {
      activeTaskCount: activeTasks.length,
      syncedTaskIds: [],
      failedTaskIds: []
    };
    for(const intent of await this.store.listTaskStartIntentsDue(nowIso(),100)){try{await this.dispatchTaskStart(intent);result.syncedTaskIds.push(intent.id);}catch{result.failedTaskIds.push(intent.id);}}
    for(const followUp of await this.store.listTaskFollowUpsDue(nowIso(),100)){try{await this.dispatchTaskFollowUp(followUp,true);}catch{result.failedTaskIds.push(followUp.taskId);}}
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
    const result=await this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"cancel",key:idempotencyKey,request:{taskId}},task.id,async()=>{const current=await this.store.findTask(task.id);if(!current||current.deletedAt)throw new ProductError("Task not found",404);return this.finalizeTaskLifecycle(task.id,"cancelled",userId);});
    if(result.executionMode==="live"&&!isTerminalTask(task)&&result.terminalReason==="cancelled")await this.bestEffortAbortAndRequestCleanup(result);
    return result;
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

  private async dispatchTaskStart(candidate:AgentTask):Promise<AgentTask>{
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
      if(!receipt.accepted){await this.store.failTaskStart({id:task.id,claimToken,safeError:"Botified did not accept task prompt",updatedAt:nowIso()});return this.finalizeTaskLifecycle(task.id,"failed",null);}
      const timelineCursor=safeRuntimeCursor(receipt.cursor)??null;
      const persisted=await this.store.recordTaskStartReceipt({id:task.id,claimToken,receipt,timelineCursor,updatedAt:nowIso()});
      if(!persisted)throw new ProductError("Task start delivery claim changed before receipt persistence",409);
      await this.writeRuntimeState(task.id,{...state,startReceipt:receipt,...(timelineCursor?{timelineCursor}:{})});
      return persisted;
    }catch(error){
      const safeError=safeTaskStageError(error);
      await this.store.deferTaskStart({id:task.id,claimToken,safeError,nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()),updatedAt:nowIso(),releaseClaim:!postAttempted});
      if(postAttempted)await this.bestEffortPersistLiveStartupFailure(task.runId,"send message",error);
      throw error;
    }
  }

  private async reconcileStartDelivery(task:AgentTask):Promise<AgentTask|null>{
    if(!task.startClaimToken||!task.startDeliveryKey||!task.startRequestHash)return task;
    const serviceKey=this.serviceKeyForTask(task);const state=await this.readRuntimeState(task,serviceKey);
    if(!this.botified.queryDeliveryReceipt)throw new ProductError("Botified delivery query API is required",502);
    let receipt:BotifiedDeliveryReceipt|null;
    try{receipt=await this.botified.queryDeliveryReceipt(state.baseUrl,serviceKey,task.startDeliveryKey);}catch(error){await this.store.deferTaskStart({id:task.id,claimToken:task.startClaimToken,safeError:safeTaskStageError(error),nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()),updatedAt:nowIso()});return task;}
    if(!receipt)return null;
    if(receipt.requestHash!==task.startRequestHash)throw new ProductError("Botified start delivery receipt hash mismatch",409);
    const timelineCursor=safeRuntimeCursor(receipt.cursor)??null;
    const persisted=await this.store.recordTaskStartReceipt({id:task.id,claimToken:task.startClaimToken,receipt,timelineCursor,updatedAt:nowIso()});
    if(!persisted)return await this.store.findTask(task.id);
    await this.writeRuntimeState(task.id,{...state,startReceipt:receipt,...(timelineCursor?{timelineCursor}:{})});
    return persisted;
  }

  private async dispatchTaskFollowUp(candidate:TaskFollowUp,completeIdempotency=false):Promise<TaskFollowUp>{
    let followUp=await this.store.findTaskFollowUp(candidate.id)??candidate;
    if(followUp.deletedAt||["accepted","successor_created","failed"].includes(followUp.deliveryStatus??"")){if(completeIdempotency)await this.store.completeTaskIdempotencyForResource(followUp.id,200,followUp,nowIso());return followUp;}
    let source=await this.store.findTask(followUp.taskId);if(!source)throw new ProductError("Task not found",404);
    if(!isTerminalTask(source)&&source.startIntentStatus!=="dispatched")return followUp;
    const timestamp=nowIso();
    if(followUp.deliveryStatus==="dispatching"||followUp.deliveryStatus==="terminal_pending"){
      if(!followUp.claimToken||!followUp.leaseExpiresAt||followUp.leaseExpiresAt>timestamp)return followUp;
      const reconciled=await this.reconcileFollowUpDelivery(followUp,source);if(reconciled){if(completeIdempotency&&["accepted","successor_created","failed"].includes(reconciled.deliveryStatus??""))await this.store.completeTaskIdempotencyForResource(reconciled.id,200,reconciled,nowIso());return reconciled;}
      source=await this.store.findTask(source.id)??source;
      if(isTerminalTask(source))return this.createSuccessorForClaimedFollowUp(followUp,source,completeIdempotency);
      const reclaimed=await this.store.reclaimTaskFollowUp({id:followUp.id,expectedClaimToken:followUp.claimToken,claimToken:newId("delivery_claim"),claimedAt:timestamp,leaseExpiresAt:deadlineIso(timestamp,this.deliveryLeaseMs())});if(!reclaimed)return await this.store.findTaskFollowUp(followUp.id)??followUp;followUp=reclaimed;
    }else{
      const claimed=await this.store.claimTaskFollowUp({id:followUp.id,claimToken:newId("delivery_claim"),claimedAt:timestamp,leaseExpiresAt:deadlineIso(timestamp,this.deliveryLeaseMs())});if(!claimed)return await this.store.findTaskFollowUp(followUp.id)??followUp;followUp=claimed;
      source=await this.store.findTask(source.id)??source;
      if(isTerminalTask(source))return this.createSuccessorForClaimedFollowUp(followUp,source,completeIdempotency);
    }
    const claimToken=followUp.claimToken!;const serviceKey=this.serviceKeyForTask(source);const state=await this.readRuntimeState(source,serviceKey);
    try{
      const receipt=await this.postDeliveryMessage(state.baseUrl,serviceKey,followUp.prompt,followUp.deliveryKey!,followUp.requestHash!);
      if(!receipt.accepted){const failed=await this.store.failTaskFollowUp({id:followUp.id,claimToken,safeError:"Botified did not accept task follow-up",updatedAt:nowIso()});if(completeIdempotency&&failed)await this.store.completeTaskIdempotencyForResource(failed.id,200,failed,nowIso());return failed??followUp;}
      const timelineCursor=safeRuntimeCursor(receipt.cursor)??null;
      const accepted=await this.store.recordTaskFollowUpReceipt({id:followUp.id,claimToken,receipt,timelineCursor,updatedAt:nowIso()});
      if(!accepted)throw new ProductError("Task follow-up delivery claim changed before receipt persistence",409);
      if(timelineCursor)await this.writeRuntimeState(source.id,{...state,timelineCursor});
      if(completeIdempotency)await this.store.completeTaskIdempotencyForResource(accepted.id,200,accepted,nowIso());
      return accepted;
    }catch(error){await this.store.deferTaskFollowUp({id:followUp.id,claimToken,safeError:safeTaskStageError(error),nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()),updatedAt:nowIso()});return await this.store.findTaskFollowUp(followUp.id)??followUp;}
  }

  private async reconcileFollowUpDelivery(followUp:TaskFollowUp,source:AgentTask):Promise<TaskFollowUp|null>{
    if(!followUp.claimToken||!followUp.deliveryKey||!followUp.requestHash)return followUp;
    const serviceKey=this.serviceKeyForTask(source);const state=await this.readRuntimeState(source,serviceKey);
    if(!this.botified.queryDeliveryReceipt)throw new ProductError("Botified delivery query API is required",502);
    let receipt:BotifiedDeliveryReceipt|null;
    try{receipt=await this.botified.queryDeliveryReceipt(state.baseUrl,serviceKey,followUp.deliveryKey);}catch(error){await this.store.deferTaskFollowUp({id:followUp.id,claimToken:followUp.claimToken,safeError:safeTaskStageError(error),nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()),updatedAt:nowIso()});return followUp;}
    if(!receipt)return null;
    if(receipt.requestHash!==followUp.requestHash)throw new ProductError("Botified follow-up delivery receipt hash mismatch",409);
    const timelineCursor=safeRuntimeCursor(receipt.cursor)??null;
    const persisted=await this.store.recordTaskFollowUpReceipt({id:followUp.id,claimToken:followUp.claimToken,receipt,timelineCursor,updatedAt:nowIso()});
    if(persisted&&timelineCursor)await this.writeRuntimeState(source.id,{...state,timelineCursor});
    return persisted??await this.store.findTaskFollowUp(followUp.id);
  }

  private async createSuccessorForClaimedFollowUp(followUp:TaskFollowUp,source:AgentTask,completeIdempotency=false):Promise<TaskFollowUp>{
    const successor=await this.prepareSuccessorCreate(source,followUp);
    const resolved=await this.store.resolveTerminalPendingFollowUp({followUpId:followUp.id,expectedClaimToken:followUp.claimToken!,successor,updatedAt:nowIso()});
    if(!resolved){await this.cleanupUnusedTaskCreate(successor);return await this.store.findTaskFollowUp(followUp.id)??followUp;}
    if(completeIdempotency)await this.store.completeTaskIdempotencyForResource(resolved.id,200,resolved,nowIso());return resolved;
  }

  private async prepareSuccessorCreate(source:AgentTask,followUp:TaskFollowUp):Promise<AtomicTaskCreateInput>{
    const project=await this.store.findProject(source.projectId);if(!project)throw new ProductError("Task project not found",409);
    const endpoint=await this.endpoints.requireEndpointForProject(source.projectId,source.endpointId);
    return this.prepareTaskCreate({id:newId("task"),project,endpoint,prompt:followUp.prompt,title:normalizeTaskTitle(undefined,followUp.prompt),inputPaths:source.inputPaths??[],sourceTaskId:source.id});
  }

  private async cleanupUnusedTaskCreate(create:AtomicTaskCreateInput):Promise<void>{if(create.task.executionMode!=="live")return;const project=await this.store.findProject(create.task.projectId);if(project)await this.bestEffortRemoveTaskInputs(project.rootPath,create.task.id);}

  private async finalizeTaskLifecycle(taskId:string,reason:TaskTerminalReason,actorId:string|null):Promise<AgentTask>{
    for(let attempt=0;attempt<3;attempt+=1){
      const task=await this.store.findTask(taskId);if(!task)throw new ProductError("Task not found",404);if(task.terminalReason){if(task.terminalReason==="failed")await this.policies.evaluateTaskFailure(task.projectId,task.endpointId);return task;}
      const pending=(await this.store.listTaskFollowUps(taskId)).filter((followUp)=>(followUp.deliveryStatus??"pending")==="pending");
      const successors:Awaited<ReturnType<TaskService["prepareSuccessorCreate"]>>[]=[];
      for(const followUp of pending)successors.push(await this.prepareSuccessorCreate(task,followUp));
      const timestamp=nowIso();const auditAction=taskAuditActionForReason(reason);
      const result=await this.store.finalizeTaskLifecycle({taskId,terminalReason:reason,updatedAt:timestamp,auditEvent:{id:newId("audit"),projectId:task.projectId,actorId,action:auditAction,status:"accepted",resourceKind:"task",resourceId:task.id,detail:{endpointId:task.endpointId},createdAt:timestamp},successors:pending.map((followUp,index)=>({followUpId:followUp.id,create:successors[index]!}))});
      if(!result)throw new ProductError("Task not found",404);
      if(result.missingPendingFollowUpIds.length){for(const create of successors)await this.cleanupUnusedTaskCreate(create);continue;}
      const created=new Set(result.successorTaskIds);for(const create of successors)if(!created.has(create.task.id))await this.cleanupUnusedTaskCreate(create);
      for(const followUp of await this.store.listTaskFollowUps(task.id))if(["accepted","successor_created","failed"].includes(followUp.deliveryStatus??""))await this.store.completeTaskIdempotencyForResource(followUp.id,200,followUp,nowIso());
      if(result.task.terminalReason==="failed")await this.policies.evaluateTaskFailure(result.task.projectId,result.task.endpointId);
      return result.task;
    }
    throw new ProductError("Task follow-up state changed during finalization",409);
  }

  private async bestEffortAbortAndRequestCleanup(task:AgentTask):Promise<void>{
    try{const serviceKey=this.serviceKeyForTask(task);const state=await this.readRuntimeState(task,serviceKey);await this.botified.abort(state.baseUrl,serviceKey);}catch{}
  }

  private async drainTaskArtifacts(task:AgentTask):Promise<void>{
    const timestamp=nowIso();const claimToken=newId("artifact_claim");const claimed=await this.store.claimTaskArtifactProjection({id:task.id,claimToken,claimedAt:timestamp,leaseExpiresAt:deadlineIso(timestamp,this.maintenanceLeaseMs())});if(!claimed)return;
    try{
      const unresolvedFollowUp=(await this.store.listTaskFollowUps(claimed.id)).some((followUp)=>followUp.deliveryStatus==="dispatching"||followUp.deliveryStatus==="terminal_pending");
      if(unresolvedFollowUp)throw new ProductError("Task follow-up delivery reconciliation is pending",409);
      let delivered:AgentTask|null=claimed;
      if(claimed.startIntentStatus==="dispatching"){
        const reconciled=await this.reconcileStartDelivery(claimed);
        if(reconciled===null)delivered=null;
        else if(reconciled.startIntentStatus==="dispatched")delivered=reconciled;
        else throw new ProductError("Task start delivery reconciliation is still uncertain",502);
      }
      if(delivered?.startIntentStatus==="dispatched")await this.syncTaskTimeline(delivered,{updateRunLifecycle:false,preserveTerminalStatus:true});
      if(claimed.terminalReason==="failed")await this.policies.evaluateTaskFailure(claimed.projectId,claimed.endpointId);
      if(!await this.store.completeTaskArtifactProjection({id:task.id,claimToken,updatedAt:nowIso()}))throw new ProductError("Task artifact drain fence changed",409);
    }catch(error){await this.store.failTaskArtifactProjection({id:task.id,claimToken,safeError:safeTaskStageError(error),nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()),updatedAt:nowIso()});throw error;}
  }

  private async cleanupTaskRuntime(task:AgentTask):Promise<void>{
    const timestamp=nowIso();const claimToken=newId("cleanup_claim");const claimed=await this.store.claimTaskCleanup({id:task.id,claimToken,claimedAt:timestamp,leaseExpiresAt:deadlineIso(timestamp,this.maintenanceLeaseMs())});if(!claimed)return;
    try{
      if(claimed.executionMode==="live"){
        await requestSandboxRunCleanup(this.store,claimed.runId,{phase:cleanupPhaseForTaskStatus(claimed.status),cleanupStatus:"cleanup_requested"});
        if(!this.config.sandboxLifecycle)throw new ProductError("Sandbox lifecycle service is not configured",500);
        const cleanup=await this.config.sandboxLifecycle.reapSandboxRunsOnce({runId:claimed.runId,apply:true});
        const run=await this.store.sandboxRuns.get(claimed.runId);
        const resourcesRemain=Object.values(cleanup.observedResourceCounts).some((count)=>count>0);
        if(cleanup.errors.length>0||resourcesRemain||(run&&run.cleanupStatus!=="cleaned"&&run.phase!=="cleaned"))throw new ProductError("Sandbox cleanup is still pending",409);
        await this.removeTransientTaskRuntime(claimed);
      }
      if(!await this.store.completeTaskCleanup({id:claimed.id,claimToken,updatedAt:nowIso()}))throw new ProductError("Task cleanup fence changed",409);
    }catch(error){await this.store.failTaskCleanup({id:claimed.id,claimToken,safeError:safeTaskStageError(error),nextRetryAt:deadlineIso(nowIso(),this.retryDelayMs()),updatedAt:nowIso()});throw error;}
  }

  private async removeTransientTaskRuntime(task:AgentTask):Promise<void>{const project=await this.store.findProject(task.projectId);if(!project)return;const root=path.resolve(this.config.dataRoot,project.rootPath,"tasks",task.id);const dataRoot=path.resolve(this.config.dataRoot);assertPathInside(dataRoot,root,"Task runtime directory is outside the data root");for(const name of ["inputs","home","botified"])await rm(path.resolve(root,name),{recursive:true,force:true});}

  private deliveryLeaseMs():number{return resolveDurationMs(this.config.deliveryLeaseMs,DEFAULT_DELIVERY_LEASE_MS);}
  private maintenanceLeaseMs():number{return resolveDurationMs(this.config.maintenanceLeaseMs,DEFAULT_MAINTENANCE_LEASE_MS);}
  private retryDelayMs():number{return resolveDurationMs(this.config.retryDelayMs,DEFAULT_TASK_RETRY_DELAY_MS);}

  async listTaskEvents(userId: string, taskId: string): Promise<AgentTaskEvent[]> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    if(task.executionMode==="live"&&task.startIntentStatus==="dispatched"){
      if(task.terminalReason&&(task.artifactProjectionStatus==="draining"||task.artifactProjectionStatus==="failed"))try{await this.drainTaskArtifacts(task);}catch{}
      else if(!task.terminalReason)await this.bestEffortSyncTaskTimeline(task);
    }
    return this.store.listTaskEvents(taskId);
  }

  async taskTranscript(userId:string,taskId:string,query:{cursor?:string;limit?:number}={}):Promise<TaskTranscriptPage>{
    const task=await this.requireTaskForUser(userId,taskId,"view");
    if(task.executionMode==="live"&&task.startIntentStatus==="dispatched"&&!task.terminalReason)await this.bestEffortSyncTaskTimeline(task);
    const page=await this.store.listTaskEventsAfter(taskId,query.cursor??null,Math.min(200,Math.max(1,Math.floor(query.limit??50))));
    const items=page.items.map(taskTranscriptEntry).filter((entry):entry is TaskTranscriptEntry=>entry!==null);
    return{items,nextCursor:page.nextCursor};
  }

  async listTaskArtifacts(userId: string, taskId: string, filter: { mediaType?: string; previewOnly?: boolean } = {}): Promise<AgentTaskArtifact[]> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    if(task.executionMode==="live"&&task.startIntentStatus==="dispatched"){
      if(task.terminalReason&&(task.artifactProjectionStatus==="draining"||task.artifactProjectionStatus==="failed"))try{await this.drainTaskArtifacts(task);}catch{}
      else if(!task.terminalReason)await this.bestEffortSyncTaskTimeline(task);
    }
    return filterTaskArtifacts(await this.store.listTaskArtifacts(taskId), filter);
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

  private async requireTaskForUser(
    userId: string,
    taskId: string,
    permission: ProjectPermission
  ): Promise<AgentTask> {
    const task = await this.requireTaskRecordForUser(userId,taskId,permission);
    if (task.deletedAt) {
      throw new ProductError("Task not found", 404);
    }
    return task;
  }

  private async requireTaskRecordForUser(userId:string,taskId:string,permission:ProjectPermission):Promise<AgentTask>{
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
    if (task.cleanupStatus === "completed" || task.status === "cleaned" || task.status === "stopping") {
      return;
    }
    await this.syncTaskTimeline(task, {
      updateRunLifecycle: false,
      preserveTerminalStatus: true
    });
  }

  private async syncTaskTimeline(
    task: AgentTask,
    options: { updateRunLifecycle?: boolean; preserveTerminalStatus?: boolean } = {}
  ): Promise<AgentTask> {
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
          name: normalizeArtifactDisplayName(artifact.name, artifact.fileId)
        };
        const verifiedArtifact = await this.downloadAndStoreTaskArtifact(
          task,
          state.baseUrl,
          serviceKey,
          productArtifact,
          download.fileId
        );
        existingFileIds.add(verifiedArtifact.fileId);
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

    const updated = options.preserveTerminalStatus && isTerminalTaskStatus(task.status)
      ? task
      : await this.updateTaskStatusFromEvents(task, projection.events);
    if (options.updateRunLifecycle !== false) {
      await this.updateRunLifecycleAfterTimelineSync(updated, projection.events);
    }
    return updated;
  }

  private async bestEffortSyncTaskTimeline(
    task: AgentTask,
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

  private async liveSandboxCleanupStatus(task: AgentTask): Promise<LiveSandboxCleanupStatus> {
    if (!this.config.liveSandbox) {
      return "none";
    }
    const run = await this.store.sandboxRuns.get(task.runId);
    if (!run || run.taskId !== task.id) {
      return "none";
    }
    return run.cleanupStatus === "cleaned" || run.phase === "cleaned" ? "cleaned" : "pending";
  }

  private async cleanupTerminalLiveSandboxBeforeRead(task: AgentTask, liveCleanupStatus: LiveSandboxCleanupStatus): Promise<boolean> {
    if (!isDurableTaskResultStatus(task.status) || liveCleanupStatus === "none") {
      return false;
    }
    if (liveCleanupStatus === "pending") {
      await this.bestEffortRequestRunCleanup(task.runId, cleanupPhaseForTaskStatus(task.status));
      await this.bestEffortReapSandboxRun(task.runId);
    }
    return true;
  }

  private async updateTaskStatusFromEvents(task: AgentTask, events: AgentTaskEvent[]): Promise<AgentTask> {
    const status = nextStatusForEvents(task.status, events);
    if (status === task.status) {
      return task;
    }
    const update = isTerminalTaskStatus(status)
      ? this.finalizeTaskLifecycle(task.id, terminalReasonForStatus(status), null)
      : this.store.updateTaskStatusIfNonterminal(task.id, status, nowIso());
    return (await update) ?? await this.store.findTask(task.id) ?? task;
  }

  private async readRuntimeState(task: AgentTask, serviceKey: string): Promise<BotifiedTaskRuntimeState> {
    const document = await this.store.jsonDocs.get("sandbox_runtime_state", task.id);
    if (!document) {
      return this.rebuildRuntimeStateFromBotified(task, serviceKey);
    }
    const baseUrl = stringDocumentField(document, "botifiedBaseUrl");
    const state: BotifiedTaskRuntimeState = { baseUrl, ...(task.startDeliveryKey?{startDeliveryKey:task.startDeliveryKey}:{}), ...(task.startRequestHash?{startRequestHash:task.startRequestHash}:{}), ...(task.startClaimToken?{startClaimToken:task.startClaimToken}:{}), ...(task.startReceipt&&task.startDeliveryKey&&task.startRequestHash?{startReceipt:{...task.startReceipt,deliveryKey:task.startDeliveryKey,requestHash:task.startRequestHash}}:{}) };
    const timelineCursor = safeRuntimeCursor(optionalStringDocumentField(document, "timelineCursor")) ?? safeRuntimeCursor(task.startTimelineCursor ?? undefined);
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

  private botifiedBrokerBaseUrlForTask(task: AgentTask): string {
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

  private async downloadAndStoreTaskArtifact(
    task: AgentTask,
    baseUrl: string,
    serviceKey: string,
    artifact: AgentTaskArtifact,
    botifiedFileId: string
  ): Promise<AgentTaskArtifact> {
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
    const verifiedArtifact: AgentTaskArtifact = {
      ...artifact,
      bytes: actualBytes,
      sha256: actualSha256,
      ...artifactPreview(downloaded.bytes, artifact.name)
    };
    const { root, filePath } = await this.taskArtifactStoragePath(task, verifiedArtifact);
    await mkdir(root, { recursive: true });
    try {
      await writeFile(filePath, downloaded.bytes, { flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existingBytes = await readFile(filePath);
      if (existingBytes.byteLength !== actualBytes || createHash("sha256").update(existingBytes).digest("hex") !== actualSha256) {
        throw new ProductError("Stored task artifact file does not match the published artifact", 409);
      }
    }
    const persisted = await this.store.persistTaskArtifactProjection({
      projectId: task.projectId,
      artifact: verifiedArtifact,
      auditEvent: { id: `audit_artifact_${verifiedArtifact.id}`, projectId: task.projectId, actorId: null, action: "artifact.project", status: "accepted", resourceKind: "artifact", resourceId: verifiedArtifact.id, createdAt: nowIso() },
      updatedAt: nowIso()
    });
    if (persisted === "limit_exceeded") {
      await rm(filePath, { force: true });
      await this.policies.raiseAlert(task.projectId, "project_file_bytes_limit");
      await this.policies.recordOperation(task.projectId, null, "file.quota", "rejected", verifiedArtifact.id, "file_quota");
      throw new ProductError("Project project file bytes limit reached", 409);
    }
    return verifiedArtifact;
  }

  private async taskArtifactStoragePath(task: AgentTask, artifact: AgentTaskArtifact): Promise<{ root: string; filePath: string }> {
    const project = await this.store.findProject(task.projectId);
    if (!project) {
      throw new ProductError("Task project not found", 409);
    }
    const dataRoot = path.resolve(this.config.dataRoot);
    const root = path.resolve(dataRoot, project.rootPath, "tasks", task.id, "artifacts");
    assertPathInside(dataRoot, root, "Task artifact directory is outside the data root");
    const filename = `${artifactStorageSegment(artifact.id, "artifact")}-${artifactStorageSegment(artifact.name, artifact.fileId)}`;
    const filePath = path.resolve(root, filename);
    assertPathInside(root, filePath, "Task artifact path is outside the artifact directory");
    return { root, filePath };
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
    return { endpoint, apiKey: credential.apiKey, projectId: task.projectId };
  }

  private buildLiveSandboxRun(input: {
    task: AgentTask;
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
    task: AgentTask;
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

  private async removeTaskInputs(projectRootPath: string, taskId: string): Promise<void> {
    const dataRoot = path.resolve(this.config.dataRoot);
    const snapshotRoot = path.resolve(dataRoot, projectRootPath, "tasks", taskId, "inputs");
    assertPathInside(dataRoot, snapshotRoot, "Task input snapshot is outside the data root");
    await rm(snapshotRoot, { recursive: true, force: true });
  }

  private async bestEffortRemoveTaskInputs(projectRootPath: string, taskId: string): Promise<void> {
    try {
      await this.removeTaskInputs(projectRootPath, taskId);
    } catch {
      // The original create failure remains authoritative; a later reaper can remove the task runtime tree.
    }
  }

  private async bestEffortMarkTaskFailed(task: AgentTask): Promise<void> {
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

  private async updateRunLifecycleAfterTimelineSync(task: AgentTask, events: AgentTaskEvent[]): Promise<void> {
    if (!this.config.liveSandbox) {
      return;
    }
    if (isTerminalTaskStatus(task.status)) {
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

function taskTranscriptEntry(event:AgentTaskEvent):TaskTranscriptEntry|null{
  const role=event.kind==="user_input"?"user":event.kind==="assistant_message"?"assistant":event.kind==="tool_execution"?"tool":event.kind==="runtime_error"||event.kind==="turn_failed"?"system":null;
  if(!role)return null;
  const text=[event.payload.text,event.payload.content,event.payload.message].find((value):value is string=>typeof value==="string")??(role==="tool"?JSON.stringify(event.payload):"");
  if(!text)return null;
  return{id:event.id,taskId:event.taskId,role,text,cursor:event.cursor,eventKind:event.kind,createdAt:event.createdAt};
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

function isTerminalTask(task: AgentTask): boolean {
  return Boolean(task.terminalReason) || ["completed","failed","expired","cancelled","cleaned"].includes(task.status);
}

async function readRegularFileWithoutFollowingSymlink(source: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isSymlinkOpenError(error)) {
      throw new ProductError("Task input source uses a symlink");
    }
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new ProductError("Task input source must contain regular files and directories");
    }
    return handle.readFile();
  } finally {
    await handle.close();
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

function deliveryKeyForStart(taskId: string, runId: string): string {
  return "delivery_start_" + taskId + "_" + runId;
}

function followUpAuditDetail(taskId: string, followUp: Pick<TaskFollowUp, "id" | "deliveryStatus">): import("../../contracts/src/api.js").ProjectAuditSafeDetail {
  return { taskId, followUpId: followUp.id, ...(followUp.deliveryStatus === undefined ? {} : { deliveryStatus: followUp.deliveryStatus }) };
}

function deliveryKeyForFollowUp(followUpId:string,runId:string):string{return `delivery_followup_${followUpId}_${runId}`;}

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

function timelineEvents(events: unknown[]): BotifiedTimelineEvent[] {
  return events.filter((event): event is BotifiedTimelineEvent => Boolean(event) && typeof event === "object" && !Array.isArray(event));
}

function nextStatusForEvents(current: AgentTaskStatus, events: AgentTaskEvent[]): AgentTaskStatus {
  if (current === "stopping") {
    return current;
  }
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

function isTerminalTaskStatus(status: AgentTaskStatus): status is Extract<AgentTaskStatus, "completed" | "failed" | "expired" | "cancelled" | "cleaned"> {
  return status === "completed" || status === "failed" || status === "expired" || status === "cancelled" || status === "cleaned";
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
