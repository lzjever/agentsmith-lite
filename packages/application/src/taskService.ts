import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateBotifiedConfig, serializeBotifiedConfig } from "../../botified-runtime/src/config.js";
import { parseBotifiedTimelineEvents, type BotifiedTimelineEvent } from "../../botified-runtime/src/projection.js";
import { isSecretLikeText, redactInteractionText, redactSecretLikeText, type InteractionTextRedactionOptions } from "../../botified-runtime/src/redaction.js";
import type {
  AgentTask,
  AgentTaskArtifact,
  CreateTaskInput,
  FileLibrary,
  KubernetesResource,
  ModelEndpoint,
  TaskCapabilities,
  TaskDetailProjection,
  TaskPresentation,
  TaskHistoryStatus,
  TaskInteractionItem,
  TaskInteractionSnapshot,
  TaskInteractionState,
  TaskMessageReceipt,
  TaskQueuedMessage,
  TaskCurrentTurnProjection,
  TaskRuntimeReachability,
  TaskSandboxReleaseReceipt,
  TaskSandboxReleaseRequest,
  TaskTurnAbortResponse,
  TaskTurnAbortRequest,
  TaskTerminalStartReceipt,
  TaskTerminalStartRequest,
  TaskArtifactKind,
  TaskArtifactListPage,
  TaskArtifactListQuery,
  TaskListPage,
  TaskListQuery,
  SandboxRetryableErrorEnvelope
} from "../../contracts/src/api.js";
import { classifyPreviewMediaType, sandboxStartFailedErrorEnvelope } from "../../contracts/src/api.js";
import { ForbiddenError, ProductError, ReceiptUncertaintyError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { normalizeSandboxResources } from "../../domain/src/kubernetesQuantity.js";
import { requireNonEmptyString } from "../../domain/src/validation.js";
import { normalizeOpenAICompatibleBaseUrl } from "../../openai-compatible-client/src/index.js";
import { CredentialService } from "./credentialService.js";
import type { FileLibraryService } from "./fileLibraryService.js";
import { BotifiedHttpError, type BotifiedRuntimeHttpClient, type BotifiedRuntimeStateResult, type BotifiedTimelineReadResult } from "../../ports/src/botified.js";
import type {
  AtomicTaskCreateInput,
  BeginTaskIdempotencyInput,
  PersistTaskArtifactProjectionInput,
  PersistedAgentTask,
  PersistedSandboxRunState,
  PersistedTaskArtifact,
  PersistedTaskInteractionChange,
  PersistedTaskMessage,
  ProductStore,
  TaskMessageIdempotencyEnvelope,
  TaskCreateIdempotencyEnvelope,
  TaskIdempotencyOperation,
  TaskPreparationOperation,
  TaskInteractionChangeInput,
  TaskInteractionCorrelation,
  TaskInteractionPageAnchor
} from "../../ports/src/store.js";
import { projectTaskState } from "./taskStateProjection.js";
import {
  projectTaskInteraction,
  type ProductTaskInteractionSource,
  type TaskInteractionProjectionState
} from "./taskInteractionProjector.js";
import {
  applySandboxReconcileActionsToKubernetes,
  type PodReadiness,
  type SandboxKubernetesMutationPort,
  type SandboxKubernetesReadinessPort
} from "../../sandbox-controller/src/kubernetesPort.js";
import { sandboxResourceNamesForTask, sandboxServiceNameForTask } from "../../sandbox-controller/src/resourceNames.js";
import { APP_KUBERNETES_SERVICE_NAME } from "../../sandbox-controller/src/appManifestRenderer.js";
import {
  reconcileSandboxRuns,
  sandboxIdentityLabels,
  type SandboxReconcileAction,
  type SandboxRunState
} from "../../sandbox-controller/src/reconciler.js";
import { sandboxRuntimeConfigMapName } from "../../sandbox-controller/src/manifestRenderer.js";
import { EndpointService } from "./endpointService.js";
import {
  type SandboxKubernetesInventoryPort,
  type SandboxLifecycleService
} from "./sandboxLifecycleService.js";
import { WorkspaceService } from "./workspaceService.js";
import { detectProjectFileMediaType,readRegularFileWithoutFollowingSymlink,withProjectFileLock } from "./fileService.js";
import { openProjectRootDescriptor } from "./filePathValidationService.js";
import { ProjectPolicyService } from "./projectPolicyService.js";
import type { ProjectAccessSnapshot, ProjectPermission } from "./authorizationService.js";
import type { ContextService } from "./contextService.js";

export interface TaskLiveSandboxConfig {
  port: SandboxKubernetesMutationPort & SandboxKubernetesReadinessPort & SandboxKubernetesInventoryPort;
  startupActionTimeoutMs?:number;
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

export interface TaskTerminalHostInput {
  runId:string;
  taskId:string;
  namespace:string;
  serviceName:string;
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
  terminalHostForRun?: (input:TaskTerminalHostInput)=>string;
  liveSandbox?: TaskLiveSandboxConfig;
  sandboxNamespaceLimit?: number;
  credentials?: CredentialService;
  sandboxLifecycle?: SandboxLifecycleService;
  deliveryLeaseMs?: number;
  contexts?: ContextService;
}

export interface BotifiedTaskAddressInput {
  namespace: string;
  taskId: string;
  port: number;
  runId?: string;
  serviceName?: string;
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
}

type BotifiedOperation = "send message" | "read state" | "read timeline" | "download file" | "abort";

export interface TaskInteractionChangePage {
  changes: Array<{ cursor: string; item: TaskInteractionItem }>;
  streamCursor: string;
  done: boolean;
  state: TaskInteractionState;
}

export type TaskAssistantPreviewUpdate =
  | { type: "upsert"; interactionId: string; body: string; occurredAt: string }
  | { type: "clear"; interactionId: string };

export interface TaskArtifactDownload {
  artifact: AgentTaskArtifact;
  bytes: Buffer;
}

export interface TaskTerminalConnection {
  runId:string;
  host:string;
  port:number;
  occupancyToken:string;
}

const BOTIFIED_RUNNER_UID = 10001;
const BOTIFIED_RUNNER_GID = 10001;
const BOTIFIED_RUNNER_DIRECTORY_MODE = 0o775;
const BOTIFIED_RUNNER_FALLBACK_DIRECTORY_MODE = 0o777;
const BOTIFIED_TASK_HOME_PATH = "/workspace/task/home/workspace";
const BOTIFIED_DATA_PATH = "/workspace/task/botified";
const TASK_ENDPOINT_CAPABILITIES = ["text", "tool_calls"] as const;
const ARTIFACT_PREVIEW_MAX_BYTES = 8_192;
const DEFAULT_DELIVERY_LEASE_MS = 30_000;
const IDEMPOTENCY_LEASE_MS = 30_000;
const TERMINAL_START_LEASE_MS = IDEMPOTENCY_LEASE_MS;
const INTERACTION_HISTORY_PAGE_LIMIT = 100;
const INTERACTION_SYNC_PAGE_LIMIT = 200;

const INTERACTION_LOOKUP_LIMIT = 1_000;

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

export class SandboxRetryableProductError extends ProductError {
  constructor(
    statusCode:number,
    readonly envelope:SandboxRetryableErrorEnvelope
  ){
    super(envelope.error.message,statusCode,envelope.error.code);
  }
}

export class ProvenTaskCommandRejectionError extends ProductError {
  constructor(error:ProductError){
    super(error.message,error.statusCode,error.code);
    this.name="ProvenTaskCommandRejectionError";
  }
}

export class TaskCreatePreparationInProgressError extends Error {
  constructor(readonly taskId:string,cause:unknown){
    super(cause instanceof Error?cause.message:"Task filesystem preparation is still in progress",{cause});
    this.name="TaskCreatePreparationInProgressError";
  }
}

function isTaskCreateReceiptContention(error:unknown):boolean{
  return error instanceof TaskCreatePreparationInProgressError&&
    error.cause instanceof ProductError&&
    error.cause.code==="idempotency_in_progress";
}

export class TaskService {
  private readonly messageDispatchTaskIds = new Set<string>();
  private readonly terminalOccupancyByTaskId = new Map<string,string>();
  private readonly taskTimelineSyncs = new Map<string, Promise<void>>();
  private readonly startupOperationsByRunId = new Map<string, Promise<PersistedAgentTask>>();
  private readonly startupExternalActionsByRunId = new Map<string,Promise<unknown>>();
  private readonly startupAbortControllersByRunId = new Map<string,AbortController>();
  private readonly terminalStartReservations = new Map<string,Promise<void>>();

  constructor(
    private readonly store: ProductStore,
    private readonly workspaces: WorkspaceService,
    private readonly endpoints: EndpointService,
    private readonly botified: BotifiedRuntimeHttpClient,
    private readonly config: TaskServiceConfig,
    private readonly policies: ProjectPolicyService,
    private readonly fileLibraries:FileLibraryService
  ) {}

  hasLocalStartupOperation(runId:string):boolean{
    return this.startupOperationsByRunId.has(runId)||this.startupExternalActionsByRunId.has(runId);
  }

  async createTask(userId: string, projectId: string, input: CreateTaskInput, idempotencyKey?: string): Promise<TaskPresentation> {
    const endpointId = requireNonEmptyString(input.endpointId, "task.endpointId");
    const prompt = requireNonEmptyString(input.prompt, "task.prompt");
    const title = normalizeTaskTitle(input.title, prompt);
    const authorizedAccess=await this.workspaces.projectAccessForUser(userId,projectId);
    if(!authorizedAccess.canWrite)throw new ForbiddenError("Project access denied");
    const authorizedProject=authorizedAccess.project;
    const key=normalizeIdempotencyKey(idempotencyKey);
    const requestHash=canonicalRequestHash({endpointId,prompt,title,fileLibrary:input.fileLibrary});
    const timestamp=nowIso();
    const existingOperation=await this.store.findTaskIdempotency({
      actorId:userId,projectId,operation:"create",key,requestHash
    });
    if(existingOperation?.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
    if(existingOperation?.kind==="replay"){
      return this.replayTaskCreate(userId,authorizedAccess,existingOperation);
    }
    const id=existingOperation?.kind==="in_progress"?existingOperation.resourceId:newId("task");
    const ownership:BeginTaskIdempotencyInput={
      actorId:userId,projectId,operation:"create",key,requestHash,resourceId:id,
      claimToken:newId("idempotency_claim"),now:timestamp,
      leaseExpiresAt:deadlineIso(timestamp,IDEMPOTENCY_LEASE_MS)
    };
    if(existingOperation?.kind==="in_progress"){
      let persisted:PersistedAgentTask|null;
      try{
        persisted=await this.store.findTask(existingOperation.resourceId);
      }catch(error){
        throw new TaskCreatePreparationInProgressError(existingOperation.resourceId,error);
      }
      if(persisted){
        const completed=await this.resumePersistedTaskCreate(
          authorizedProject,
          persisted,
          ownership
        );
        return this.taskPresentation(userId,completed,{projectAccess:authorizedAccess});
      }
    }
    try{
      const project = await this.workspaces.requireProjectForUser(userId, projectId, "write");
      const endpoint = await this.endpoints.requireCredentialEndpointForUser(userId, projectId, endpointId);
      requireTaskEndpointCapabilities(endpoint);
      const agentContext = this.config.liveSandbox ? await this.config.contexts?.resolveForAgent(userId, projectId) ?? "" : "";
      const selection:{prepare:boolean;library:FileLibrary}=input.fileLibrary.mode==="create_new"?{prepare:true,library:{
        id:`library_${id.slice("task_".length)}`,workspaceId:project.workspaceId,projectId,name:requireNonEmptyString(input.fileLibrary.name,"task.fileLibrary.name",160),rootSubPath:`libraries/library_${id.slice("task_".length)}/home`,lifecycleStatus:"active",createdByUserId:userId,createdAt:timestamp,updatedAt:timestamp
      }}:await this.taskLibraryCandidate(project.workspaceId,projectId,input.fileLibrary.id,userId,timestamp);
      const create=await this.prepareTaskCreate({id,project,endpoint,prompt,title,library:selection.library,agentContext,createdByUserId:userId});
      if(create.initialMessage){
        const initialProjection=await this.prepareProductInteractionChange(messageProductSource(create.initialMessage),create.task);
        if(!initialProjection)throw new ProductError("Initial Task interaction projection is unavailable",409);
        create.initialInteractionChange=initialProjection.change;
      }
      create.idempotency=ownership;
      if(input.fileLibrary.mode==="create_new")create.newFileLibrary=selection.library;
      if(create.reserveActive){
        create.rejectionPresentation=null;
        create.rejectedAuditEvent={
          id:`audit_task_create_rejected_${id}`,projectId,actorId:userId,action:"task.create",status:"rejected",
          resourceKind:"task",resourceId:id,detail:{taskId:id,trigger:"task_create"},createdAt:timestamp
        };
      }
      create.auditEvent={
        id:`audit_task_create_${id}`,projectId,actorId:userId,action:"task.create",status:"accepted",
        resourceKind:"task",resourceId:id,detail:{taskId:id},createdAt:timestamp
      };

      const created=await this.store.createTaskAtomically(create);
      if(created.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
      if(created.kind==="in_progress")throw idempotencyInProgressError();
      if(created.kind==="replay"){
        const replay=await this.store.findTaskIdempotency({actorId:userId,projectId,operation:"create",key,requestHash});
        if(replay?.kind!=="replay")throw idempotencyInProgressError();
        return this.replayTaskCreate(userId,authorizedAccess,replay);
      }
      if(created.kind==="capacity_rejected"){
        if(created.admission.kind==="project_capacity_rejected")await this.bestEffortRecordProjectSandboxCapacityRejected(projectId);
        throw new SandboxRetryableProductError(created.responseStatus,created.responseBody);
      }
      if(created.kind!=="created"&&created.kind!=="resume"){
        const error=taskCreateAdmissionError(created.kind);
        return created.claimToken
          ?this.completeClaimedRejectedTaskCreate(
            userId,
            authorizedAccess,
            {...ownership,claimToken:created.claimToken},
            error
          )
          :this.completeRejectedTaskCreate(userId,authorizedAccess,ownership,error);
      }

      const operationOwnership=created.kind==="resume"
        ?{...ownership,resourceId:created.task.id,claimToken:created.claimToken}
        :ownership;
      const completed=await this.completeAdmittedTaskCreate(
        project,
        created.task,
        operationOwnership,
        create.reserveActive,
        created.kind==="resume"
      );
      return this.taskPresentation(userId,completed,{projectAccess:authorizedAccess});
    }catch(error){
      if(error instanceof TaskCreatePreparationInProgressError)throw error;
      const raced=await this.store.findTaskIdempotency({
        actorId:userId,projectId,operation:"create",key,requestHash
      });
      if(raced?.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
      if(raced?.kind==="replay")return this.replayTaskCreate(userId,authorizedAccess,raced);
      if(raced?.kind==="in_progress"){
        const persisted=await this.store.findTask(raced.resourceId);
        if(persisted){
          const completed=await this.resumePersistedTaskCreate(
            authorizedProject,
            persisted,
            {...ownership,resourceId:persisted.id}
          );
          return this.taskPresentation(userId,completed,{projectAccess:authorizedAccess});
        }
        throw idempotencyInProgressError();
      }
      if(isTerminalizablePreAdmissionRejection(error)){
        return this.completeRejectedTaskCreate(userId,authorizedAccess,ownership,error);
      }
      throw error;
    }
  }

  private async resumePersistedTaskCreate(
    project:{id:string;rootPath:string},
    persisted:PersistedAgentTask,
    ownership:BeginTaskIdempotencyInput,
    knownOperation?:TaskPreparationOperation
  ):Promise<PersistedAgentTask>{
    try{
      const operation=knownOperation??await this.store.findTaskPreparationOperation(persisted.id);
      if(!operation||
        operation.actorId!==ownership.actorId||
        operation.projectId!==ownership.projectId||
        operation.key!==ownership.key||
        operation.requestHash!==ownership.requestHash||
        operation.resourceId!==persisted.id
      )throw new Error("Task preparation operation identity is unavailable");
      const begun=await this.store.beginTaskIdempotency(ownership);
      if(begun.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
      if(begun.kind==="replay"){
        requireMatchingTaskCreateReceipt(begun,persisted,ownership.actorId,project.id);
        return persisted;
      }
      if(begun.kind==="in_progress")throw idempotencyInProgressError();
      const operationOwnership={
        ...ownership,
        resourceId:persisted.id,
        claimToken:begun.claimToken
      };
      return await this.completeAdmittedTaskCreate(
        project,
        persisted,
        operationOwnership,
        false,
        true
      );
    }catch(error){
      if(error instanceof TaskCreatePreparationInProgressError)throw error;
      throw new TaskCreatePreparationInProgressError(persisted.id,error);
    }
  }

  private async completeAdmittedTaskCreate(
    project:{id:string;rootPath:string},
    persisted:PersistedAgentTask,
    ownership:BeginTaskIdempotencyInput,
    refreshCapacity:boolean,
    recovering:boolean
  ):Promise<PersistedAgentTask>{
    try{
      const run=persisted.currentRunId?await this.store.sandboxRuns.get(persisted.currentRunId):null;
      if(persisted.currentRunId&&(!run||!taskMatchesExactSandboxRun(persisted,run))){
        throw new Error("Admitted Task Run is unavailable during preparation");
      }
      if(!run||run.startupReadyAt===null){
        const library=persisted.fileLibraryId?await this.store.findFileLibrary(persisted.fileLibraryId):null;
        if(!library)throw new Error("Admitted Task File Library is unavailable during preparation");
        const marker=taskPreparationMarker(project.id,persisted.id,run,ownership);
        const projectRoot=path.resolve(this.config.dataRoot,project.rootPath);
        await withProjectFileLock(projectRoot,async()=>{
          if(recovering){
            try{
              await requireRecoverableTaskPreparationMarker(this.config.dataRoot,projectRoot,marker);
            }catch(error){
              if(!isNotFound(error)&&!(error instanceof Error&&error.message==="Task preparation marker is missing"))throw error;
              await this.prepareTaskStaging(project.rootPath,persisted.id,marker);
            }
          }else{
            await this.prepareTaskStaging(project.rootPath,persisted.id,marker);
          }
          const newLibrary=library.id===`library_${persisted.id.slice("task_".length)}`;
          await this.promoteTaskPreparation(project.rootPath,library,persisted.id,newLibrary,marker);
          await this.markCurrentTaskRunReady(persisted);
        });
      }
      if(refreshCapacity)await this.refreshSandboxCapacityAlerts(project.id);
      const response=taskCreateIdempotencyEnvelope(persisted,ownership.actorId);
      if(!await this.store.completeTaskIdempotency({
        actorId:ownership.actorId,
        projectId:ownership.projectId,
        operation:"create",
        key:ownership.key,
        requestHash:ownership.requestHash,
        claimToken:ownership.claimToken,
        responseStatus:200,
        responseBody:response,
        updatedAt:nowIso()
      })){
        const converged=await this.store.findTaskIdempotencyByResource({
          actorId:ownership.actorId,
          operation:"create",
          key:ownership.key,
          requestHash:ownership.requestHash,
          resourceId:persisted.id
        });
        if(converged?.kind!=="replay"||converged.responseStatus!==200)throw new Error("Task preparation operation lost its claim");
        requireMatchingTaskCreateReceipt(converged,persisted,ownership.actorId,project.id);
      }
      return persisted;
    }catch(error){
      if(error instanceof TaskCreatePreparationInProgressError)throw error;
      throw new TaskCreatePreparationInProgressError(persisted.id,error);
    }
  }

  private async completeRejectedTaskCreate(
    userId:string,
    access:ProjectAccessSnapshot,
    ownership:BeginTaskIdempotencyInput,
    error:ProductError
  ):Promise<TaskPresentation>{
    const begun=await this.store.beginTaskIdempotency(ownership);
    if(begun.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
    if(begun.kind==="in_progress")throw idempotencyInProgressError();
    if(begun.kind==="replay")return this.replayTaskCreate(userId,access,begun);
    return this.completeClaimedRejectedTaskCreate(
      userId,
      access,
      {...ownership,resourceId:begun.resourceId,claimToken:begun.claimToken},
      error
    );
  }

  private async completeClaimedRejectedTaskCreate(
    userId:string,
    access:ProjectAccessSnapshot,
    claimed:BeginTaskIdempotencyInput,
    error:ProductError
  ):Promise<TaskPresentation>{
    const responseBody=taskOperationErrorBody(error);
    if(await this.store.completeTaskIdempotency({
      ...claimed,
      responseStatus:error.statusCode,responseBody,updatedAt:nowIso()
    }))throw provenTaskCommandRejection(error);
    const terminal=await this.store.findTaskIdempotencyByResource({
      actorId:claimed.actorId,
      operation:"create",
      key:claimed.key,
      requestHash:claimed.requestHash,
      resourceId:claimed.resourceId
    });
    if(terminal?.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
    if(terminal?.kind==="replay")return this.replayTaskCreate(userId,access,terminal);
    throw idempotencyInProgressError();
  }

  private async taskLibraryCandidate(workspaceId:string,projectId:string,idValue:unknown,userId:string,timestamp:string):Promise<{library:FileLibrary;prepare:boolean}>{
    const id=requireNonEmptyString(idValue,"task.fileLibrary.id");
    const library=await this.store.findFileLibrary(id);
    if(library&&library.workspaceId===workspaceId&&library.projectId===projectId){
      if(library.lifecycleStatus==="deleting")throw new ProductError("File Library deletion is in progress",409,"file_library_deleting");
      return{library,prepare:true};
    }
    return{prepare:false,library:{id,workspaceId,projectId,name:"Selected Library",rootSubPath:`libraries/${id}/home`,lifecycleStatus:"active",createdByUserId:userId,createdAt:timestamp,updatedAt:timestamp}};
  }

  private async prepareTaskStaging(projectRootPath:string,taskId:string,marker:TaskPreparationMarker):Promise<void>{
    const projectRoot=path.resolve(this.config.dataRoot,projectRootPath);
    const staging=path.resolve(projectRoot,".preparations",taskId);
    assertPathInside(projectRoot,staging,"Task preparation directory is outside the Project");
    await withProjectRootDescriptor(this.config.dataRoot,projectRoot,true,async(root)=>{
      const anchoredStaging=path.join(root,".preparations",taskId);
      await ensureDirectoryWalk(root,[".preparations",taskId,"task","botified"]);
      await ensureDirectoryWalk(root,[".preparations",taskId,"library","workspace",".artifacts",taskId]);
      await Promise.all([
        writeTaskPreparationMarker(anchoredStaging,marker),
        writeTaskPreparationMarker(path.join(anchoredStaging,"task"),marker)
      ]);
      const [projectDevice,stagingDevice]=await Promise.all([stat(root),stat(anchoredStaging)]);
      if(projectDevice.dev!==stagingDevice.dev)throw new ProductError("Task preparation must stay on the Project volume",500);
    });
  }

  private async promoteTaskPreparation(projectRootPath:string,library:FileLibrary,taskId:string,newLibrary:boolean,marker:TaskPreparationMarker):Promise<void>{
    const projectRoot=path.resolve(this.config.dataRoot,projectRootPath);
    const staging=path.resolve(projectRoot,".preparations",taskId);
    const taskTarget=path.resolve(projectRoot,"tasks",taskId);
    const libraryTarget=path.resolve(projectRoot,library.rootSubPath);
    assertPathInside(projectRoot,staging,"Task preparation directory is outside the Project");
    assertPathInside(projectRoot,taskTarget,"Task runtime directory is outside the Project");
    assertPathInside(projectRoot,libraryTarget,"File Library root is outside the Project");
    await withProjectRootDescriptor(this.config.dataRoot,projectRoot,false,async(root)=>{
      const anchoredStaging=path.join(root,".preparations",taskId);
      const anchoredTaskTarget=path.join(root,path.relative(projectRoot,taskTarget));
      const anchoredLibraryTarget=path.join(root,path.relative(projectRoot,libraryTarget));
      if(!await pathExists(anchoredStaging)){
        const taskSegments=["tasks",taskId];
        const artifactSegments=[...relativeDirectorySegments(projectRoot,libraryTarget),"workspace",".artifacts",taskId];
        if(await validPromotedTaskPreparation(root,taskSegments,artifactSegments,marker))return;
        throw new Error("Task preparation staging is unavailable");
      }
      await requireTaskPreparationMarker(anchoredStaging,marker);
      await ensureDirectoryWalk(root,["tasks"]);
      const taskMarkerSegments=["tasks",taskId];
      await promoteDirectoryByDescriptor(root,[".preparations",taskId],"task",["tasks"],taskId,taskMarkerSegments,marker);
      await requireTaskPreparationMarker(anchoredTaskTarget,marker);
      if(newLibrary){
        const librarySegments=relativeDirectorySegments(projectRoot,libraryTarget);
        await ensureDirectoryWalk(root,librarySegments.slice(0,-1));
        await promoteDirectoryByDescriptor(root,[".preparations",taskId],"library",librarySegments.slice(0,-1),librarySegments.at(-1)!,taskMarkerSegments,marker);
        if(!await directoryWalkExists(root,[...librarySegments,"workspace",".artifacts",taskId]))throw new Error("Promoted File Library structure is incomplete");
      }else{
        const librarySegments=relativeDirectorySegments(projectRoot,libraryTarget);
        if(!await directoryWalkExists(root,librarySegments))throw new ProductError("File Library root is unavailable or unsafe",409);
        const artifactParent=[...librarySegments,"workspace",".artifacts"];
        await ensureDirectoryWalk(root,artifactParent);
        await promoteDirectoryByDescriptor(root,[".preparations",taskId,"library","workspace",".artifacts"],taskId,artifactParent,taskId,taskMarkerSegments,marker);
        if(!await directoryWalkExists(root,[...artifactParent,taskId]))throw new Error("Promoted Task artifact structure is incomplete");
      }
      await rm(anchoredStaging,{recursive:true,force:true});
      try{await rmdir(path.dirname(anchoredStaging));}catch(error){if(!isNotFound(error)&&!isDirectoryNotEmpty(error))throw error;}
    });
  }

  private async markCurrentTaskRunReady(task:PersistedAgentTask):Promise<void>{
    if(!task.currentRunId)return;
    const run=await this.store.sandboxRuns.get(task.currentRunId);
    if(!run||!taskMatchesExactSandboxRun(task,run))throw new Error("Admitted Task Run is unavailable during preparation");
    if(run.state!=="starting"||run.startupReadyAt!==null)return;
    if(!await this.store.markTaskSandboxStartupReady({taskId:task.id,runId:run.runId,expectedFencingToken:run.fencingToken,readyAt:nowIso()})){
      throw new Error("Task startup readiness changed during preparation");
    }
  }

  private async bestEffortRemoveTaskStaging(projectRootPath:string,taskId:string):Promise<void>{
    const projectRoot=path.resolve(this.config.dataRoot,projectRootPath);
    const staging=path.resolve(projectRoot,".preparations",taskId);
    assertPathInside(projectRoot,staging,"Task preparation directory is outside the Project");
    try{await withProjectRootDescriptor(this.config.dataRoot,projectRoot,false,async(root)=>{
      const anchoredStaging=path.join(root,".preparations",taskId);
      await rm(anchoredStaging,{recursive:true,force:true});
      try{await rmdir(path.dirname(anchoredStaging));}catch{}
    });}catch{}
  }

  private async prepareTaskCreate(input: {
    id: string;
    project: Awaited<ReturnType<WorkspaceService["requireProjectForUser"]>>;
    endpoint: ModelEndpoint;
    prompt: string;
    title: string;
    library: FileLibrary;
    agentContext: string;
    createdByUserId: string | null;
  }): Promise<AtomicTaskCreateInput> {
    const timestamp = nowIso();
    const runId = newId("run");
    const live = this.config.liveSandbox !== undefined;
    const botifiedPort = this.config.botifiedPort ?? 3099;
    const resourceNames = sandboxResourceNamesForTask(input.id);
    const initialMessageId = newId("message");
    const task: PersistedAgentTask = {
      id: input.id,
      workspaceId: input.project.workspaceId,
      projectId: input.project.id,
      endpointId: input.endpoint.id,
      fileLibraryId: input.library.id,
      title: input.title,
      prompt: input.prompt,
      currentRunId: live ? runId : null,
      createdByUserId: input.createdByUserId,
      agentContext: input.agentContext,
      archivedAt: null,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const initialMessage:PersistedTaskMessage={id:initialMessageId,taskId:input.id,actorId:input.createdByUserId,content:input.prompt,claimToken:null,deliveryStatus:live?"pending":"accepted",claimedAt:null,leaseExpiresAt:null,safeError:null,createdAt:timestamp,updatedAt:timestamp,deletedAt:null};
    const admission=live?this.sandboxAdmission():this.releasedSandboxAdmission();
    if (!live) return { task, initialMessage, reserveActive: false, admission };
    const serviceKey = this.serviceKeyForTask(task);
    requireBotifiedServiceKey(serviceKey);
    const runtimeState:Record<string,unknown>={botifiedBaseUrl:this.botifiedBaseUrlForTask(input.id,botifiedPort)};
    const sandboxRun = this.buildLiveSandboxRun({ task, timestamp, botifiedPort, projectSubPath: input.project.rootPath, resourceNames, fileLibraryRootSubPath:input.library.rootSubPath });
    return { task, initialMessage, reserveActive: true, admission, runtimeState, sandboxRun };
  }

  private async runIdempotentTaskOperation<T>(
    scope: { actorId:string;projectId:string;operation:TaskIdempotencyOperation;key:string|undefined;request:unknown },
    resourceId: string,
    action: (resourceId:string,ownership:BeginTaskIdempotencyInput) => Promise<T>
  ): Promise<T> {
    const key=normalizeIdempotencyKey(scope.key);
    const requestHash=canonicalRequestHash(scope.request);
    const claimToken=newId("idempotency_claim");
    const timestamp=nowIso();
    const begun=await this.store.beginTaskIdempotency({actorId:scope.actorId,projectId:scope.projectId,operation:scope.operation,key,requestHash,resourceId,claimToken,now:timestamp,leaseExpiresAt:deadlineIso(timestamp,IDEMPOTENCY_LEASE_MS)});
    if(begun.kind==="hash_mismatch")throw new ProductError("Idempotency-Key was already used with a different request",409);
    if(begun.kind==="in_progress")throw idempotencyInProgressError();
    if(begun.kind==="replay"){
      if(begun.responseStatus>=400)return replayTaskOperationResponse<T>(begun.responseStatus,begun.responseBody);
      const replay=structuredClone(begun.responseBody) as T;
      if(isMessageReceiptOperation(scope.operation)&&isUnknownRecord(replay))return{...replay,duplicate:true} as T;
      return replay;
    }
    try{
      const response=await action(begun.resourceId,{actorId:scope.actorId,projectId:scope.projectId,operation:scope.operation,key,requestHash,resourceId:begun.resourceId,claimToken:begun.claimToken,now:timestamp,leaseExpiresAt:deadlineIso(timestamp,IDEMPOTENCY_LEASE_MS)});
      if(!await this.store.completeTaskIdempotency({actorId:scope.actorId,projectId:scope.projectId,operation:scope.operation,key,requestHash,claimToken:begun.claimToken,responseStatus:200,responseBody:response,updatedAt:nowIso()})){
        const completed=await this.store.findTaskIdempotencyByResource({actorId:scope.actorId,operation:scope.operation,key,requestHash,resourceId:begun.resourceId});
        if(completed?.kind!=="replay"||completed.responseStatus!==200||canonicalJson(completed.responseBody)!==canonicalJson(response))throw new ProductError("Idempotent task operation lost its claim",409);
      }
      return response;
    }catch(error){
      if(error instanceof ProductError)await this.store.completeTaskIdempotency({actorId:scope.actorId,projectId:scope.projectId,operation:scope.operation,key,requestHash,claimToken:begun.claimToken,responseStatus:error.statusCode,responseBody:taskOperationErrorBody(error),updatedAt:nowIso()});
      throw error;
    }
  }

  async listTasks(userId: string, projectId: string, query: TaskListQuery = {}): Promise<TaskListPage> {
    await this.workspaces.requireProjectForUser(userId, projectId, "view");
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 25)));
    const listQuery = {
      search: (query.search ?? "").trim().slice(0, 200),
      archived: query.archived ?? "exclude",
      sort: query.sort ?? "updated_at",
      direction: query.direction ?? "desc"
    };
    const after = decodeTaskListCursor(query.cursor, projectId, listQuery);
    const page = await this.store.queryTasksForProject(projectId, { ...listQuery, ...(after ? { after } : {}), limit });
    const last = page.items.at(-1);
    return {
      items:await Promise.all(page.items.map((task)=>this.taskPresentation(userId,task))),
      total:page.total,
      nextCursor:page.hasMore&&last?encodeTaskListCursor(projectId,listQuery,{value:taskListSortValue(last,listQuery.sort),taskId:last.id}):null
    };
  }

  async getTask(userId: string, taskId: string): Promise<TaskPresentation> {
    return this.taskPresentation(userId,await this.requireTaskForUser(userId, taskId, "view"));
  }

  async getTaskDetail(userId: string, taskId: string): Promise<TaskDetailProjection> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    return this.taskPresentation(userId,task);
  }

  async releaseTaskSandbox(userId:string,taskId:string,request:TaskSandboxReleaseRequest,idempotencyKey?:string):Promise<TaskSandboxReleaseReceipt>{
    const task=await this.requireTaskRecordForUser(userId,taskId,"write");
    const expectedRunId=requireNonEmptyString(request.expectedRunId,"task.release.expectedRunId");
    const key=normalizeIdempotencyKey(idempotencyKey),requestHash=canonicalRequestHash({taskId,expectedRunId}),claimToken=newId("idempotency_claim"),timestamp=nowIso();
    const existing=await this.store.findTaskIdempotency({actorId:userId,projectId:task.projectId,operation:"release-sandbox",key,requestHash});
    if(existing?.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
    if(existing?.kind==="in_progress")return releaseAcceptedReceipt(task.id,existing.resourceId);
    if(existing?.kind==="replay")return replayTaskCommandOutcome<TaskSandboxReleaseReceipt>(existing.responseStatus,existing.responseBody);
    if(task.currentRunId!==expectedRunId)throw taskRunTargetConflictError();
    const begun=await this.store.beginTaskIdempotency({actorId:userId,projectId:task.projectId,operation:"release-sandbox",key,requestHash,resourceId:expectedRunId,claimToken,now:timestamp,leaseExpiresAt:deadlineIso(timestamp,IDEMPOTENCY_LEASE_MS)});
    if(begun.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
    if(begun.kind==="in_progress")return releaseAcceptedReceipt(task.id,begun.resourceId);
    if(begun.kind==="replay")return replayTaskCommandOutcome<TaskSandboxReleaseReceipt>(begun.responseStatus,begun.responseBody);
    try{
      const currentTask=await this.store.findTask(task.id);
      if(!currentTask||currentTask.deletedAt)throw new ProductError("Task not found",404);
      if(currentTask.currentRunId!==expectedRunId)throw taskRunTargetConflictError();
      const run=await this.store.sandboxRuns.get(expectedRunId);
      if(!run||run.taskId!==currentTask.id||run.runId!==currentTask.currentRunId)throw taskRunTargetConflictError();
      const cleaned=run.state==="released",updatedAt=nowIso();
      const response=cleaned?releaseCompletedReceipt(task.id,run.runId):releaseAcceptedReceipt(task.id,run.runId);
      const result=await this.store.requestTaskSandboxRelease({
        runId:run.runId,taskId:task.id,expectedFencingToken:run.fencingToken,
        intent:{requestedAt:updatedAt},
        idempotency:{actorId:userId,projectId:task.projectId,operation:"release-sandbox",key,requestHash,claimToken:begun.claimToken,responseStatus:cleaned?200:202,responseBody:response,updatedAt}
      });
      if(result==="conflict")throw taskRunTargetConflictError();
      this.startupAbortControllersByRunId.get(run.runId)?.abort(new ProductError("Sandbox startup was superseded by release",409,"sandbox_cleanup_intent_conflict"));
      return response;
    }catch(error){if(error instanceof ProductError)await this.store.completeTaskIdempotency({actorId:userId,projectId:task.projectId,operation:"release-sandbox",key,requestHash,claimToken:begun.claimToken,responseStatus:error.statusCode,responseBody:{error:error.message,...(error.code?{code:error.code}:{})},updatedAt:nowIso()});throw error;}
  }

  async openTaskTerminal(userId:string,taskId:string,expectedRunId:string):Promise<TaskTerminalConnection>{
    const {task,run}=await this.requireTaskTerminalAccess(userId,taskId,expectedRunId);
    if(this.terminalOccupancyByTaskId.has(task.id))throw new ProductError("Task terminal is already open",409);
    const host=this.terminalHostForRun(run);
    const occupancyToken=newId("terminal_occupancy");
    this.terminalOccupancyByTaskId.set(task.id,occupancyToken);
    return{
      runId:run.runId,
      host,
      port:3110,
      occupancyToken
    };
  }

  async startTaskTerminal(userId:string,taskId:string,request:TaskTerminalStartRequest,idempotencyKey?:string):Promise<TaskTerminalStartReceipt>{
    const candidate=await this.requireTaskRecordForUser(userId,taskId,"write");
    const {expectedRunId,expectedSandboxState}=request;
    if(expectedRunId!==null&&(typeof expectedRunId!=="string"||!expectedRunId))throw new ProductError("task.terminal.expectedRunId must be a string or null",400);
    if(!["starting","active","release_requested","released","failed"].includes(expectedSandboxState))throw new ProductError("task.terminal.expectedSandboxState is invalid",400);
    const key=normalizeIdempotencyKey(idempotencyKey);
    const requestHash=canonicalRequestHash({taskId,expectedRunId,expectedSandboxState});
    const operationIdentity=terminalStartOperationIdentity(userId,candidate.projectId,key,requestHash);
    const initialGate=await this.store.findTaskIdempotency({actorId:userId,projectId:candidate.projectId,operation:"terminal-start",key,requestHash});
    if(initialGate?.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
    if(initialGate?.kind==="replay")return replayTaskCommandOutcome<TaskTerminalStartReceipt>(initialGate.responseStatus,initialGate.responseBody);
    const reservation=await this.serializeTerminalStartReservation(operationIdentity,async()=>{
      const replayGate=await this.store.findTaskIdempotency({actorId:userId,projectId:candidate.projectId,operation:"terminal-start",key,requestHash});
      if(replayGate?.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
      if(replayGate?.kind==="replay")return{replay:replayTaskCommandOutcome<TaskTerminalStartReceipt>(replayGate.responseStatus,replayGate.responseBody)};
      const timestamp=nowIso();
      const ownership:BeginTaskIdempotencyInput={
        actorId:userId,projectId:candidate.projectId,operation:"terminal-start",key,requestHash,
        resourceId:replayGate?.kind==="in_progress"?replayGate.resourceId:candidate.currentRunId??candidate.id,
        claimToken:newId("idempotency_claim"),now:timestamp,leaseExpiresAt:deadlineIso(timestamp,TERMINAL_START_LEASE_MS)
      };
      let beginInput:import("../../ports/src/store.js").BeginTerminalStartInput;
      if(replayGate?.kind==="in_progress"){
        const boundRun=await this.store.sandboxRuns.get(replayGate.resourceId);
        if(!boundRun||!taskSharesSandboxRunScope(candidate,boundRun))throw new ProductError("Terminal operation Run is unavailable or mismatched",409,"task_sandbox_restart_conflict");
        const operationTask={...candidate,currentRunId:boundRun.runId};
        beginInput={
          taskId:candidate.id,idempotency:ownership,
          rejectionPresentation:await this.taskPresentation(userId,operationTask,{run:boundRun,turn:boundRun.state==="starting"?"starting":"ready",reachability:"unreachable"})
        };
      }else{
        const currentRun=candidate.currentRunId?await this.store.sandboxRuns.get(candidate.currentRunId):null;
        const currentState=currentRun?.state??"released";
        if(candidate.currentRunId!==expectedRunId||currentState!==expectedSandboxState||!["released","starting"].includes(expectedSandboxState))throw taskRunTargetConflictError();
        const endpoint=await this.endpoints.requireHealthyCredentialEndpoint(candidate.projectId,candidate.endpointId);
        requireTaskEndpointCapabilities(endpoint);
        const restart=await this.prepareSandboxRestart(userId,candidate);
        if(!currentRun||currentRun.state==="released")this.serviceKeyForTask(restart?.task??candidate);
        ownership.resourceId=restart?.sandboxRun.runId??candidate.currentRunId??candidate.id;
        beginInput={
          taskId:candidate.id,idempotency:ownership,admission:this.sandboxAdmission(),
          ...(restart?{restart:{expectedReleasedRunId:candidate.currentRunId,...restart}}:{}),
          rejectionPresentation:await this.taskPresentation(userId,candidate,{run:currentRun,turn:currentRun?.state==="starting"?"starting":"ready",reachability:"unreachable"}),
          rejectedAuditEvent:{id:`audit_sandbox_started_rejected_terminal_${candidate.id}_${key}`,projectId:candidate.projectId,actorId:userId,action:"sandbox.started",status:"rejected",resourceKind:"sandbox",resourceId:candidate.id,detail:{taskId:candidate.id,trigger:"terminal"},createdAt:timestamp}
        };
      }
      return{begun:await this.store.beginTerminalStart(beginInput)};
    });
    if("replay" in reservation&&reservation.replay!==undefined)return reservation.replay;
    const {begun}=reservation;
    if(begun.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
    if(begun.kind==="replay")return replayTaskCommandOutcome<TaskTerminalStartReceipt>(begun.responseStatus,begun.responseBody);
    if(begun.kind==="capacity_rejected"){
      if(begun.admission.kind==="project_capacity_rejected")await this.bestEffortRecordProjectSandboxCapacityRejected(candidate.projectId);
      throw new SandboxRetryableProductError(begun.responseStatus,begun.responseBody);
    }
    if(begun.kind==="conflict")throw new ProductError("Task sandbox changed concurrently; retry",409,"task_sandbox_restart_conflict");
    return{outcome:"accepted_in_progress",keyDisposition:"retain",runId:begun.run.runId};
  }

  async validateTaskTerminalAccess(userId:string,taskId:string,expectedRunId:string):Promise<void>{
    await this.requireTaskTerminalAccess(userId,taskId,expectedRunId);
  }

  closeTaskTerminal(taskId:string,occupancyToken:string):void{
    if(this.terminalOccupancyByTaskId.get(taskId)===occupancyToken){
      this.terminalOccupancyByTaskId.delete(taskId);
    }
  }

  async sendTaskMessage(userId: string, taskId: string, content: string, idempotencyKey?: string): Promise<TaskMessageReceipt> {
    const text = requireNonEmptyString(content, "task.message.content");
    const task = await this.store.findTask(taskId);
    if(!task)throw new ProductError("Task not found",404);
    await this.workspaces.requireProjectMembershipForUser(userId,task.projectId,"write");
    const operation=taskOperation("message"),key=normalizeIdempotencyKey(idempotencyKey);
    const requestHash=canonicalRequestHash({taskId,content:text});
    const existing=await this.store.findTaskIdempotency({
      actorId:userId,projectId:task.projectId,operation,key,requestHash
    });
    if(existing?.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
    if(existing?.kind==="replay")return this.replayTaskMessage(userId,task,existing);
    const id=existing?.kind==="in_progress"?existing.resourceId:newId("message");
    const claimToken=newId("idempotency_claim"),timestamp=nowIso();
    const ownership:BeginTaskIdempotencyInput={actorId:userId,projectId:task.projectId,operation,key,requestHash,resourceId:id,claimToken,now:timestamp,leaseExpiresAt:deadlineIso(timestamp,IDEMPOTENCY_LEASE_MS)};
    let ownsClaim=false;
    if(existing?.kind==="in_progress"){
      let begun:Awaited<ReturnType<ProductStore["beginTaskIdempotency"]>>;
      try{
        begun=await this.store.beginTaskIdempotency(ownership);
      }catch(error){
        const converged=await this.store.findTaskIdempotency({
          actorId:userId,projectId:task.projectId,operation,key,requestHash
        });
        if(converged?.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
        if(converged?.kind==="replay")return this.replayTaskMessage(userId,task,converged);
        throw error;
      }
      if(begun.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
      if(begun.kind==="in_progress")throw idempotencyInProgressError();
      if(begun.kind==="replay")return this.replayTaskMessage(userId,task,begun);
      ownership.resourceId=begun.resourceId;
      ownership.claimToken=begun.claimToken;
      ownsClaim=true;
    }
    try{
      await this.workspaces.requireProjectForUser(userId,task.projectId,"write");
      const current = await this.store.findTask(task.id);
      if (!current || current.deletedAt || current.projectId!==task.projectId) throw new ProductError("Task not found", 404);
      if (!await this.taskExecutionEligible(current)) throw new ProductError("Task is no longer eligible to receive messages", 409);
    }catch(error){
      const raced=await this.store.findTaskIdempotency({
        actorId:userId,projectId:task.projectId,operation,key,requestHash
      });
      if(raced?.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
      if(raced?.kind==="replay")return this.replayTaskMessage(userId,task,raced);
      if(raced?.kind==="in_progress"&&!ownsClaim)throw idempotencyInProgressError();
      if(isTerminalizablePreAdmissionRejection(error)){
        return this.completeRejectedTaskMessage(userId,task,ownership,error);
      }
      throw error;
    }
    try{
      const current = await this.store.findTask(task.id);
      if (!current || current.deletedAt || current.projectId!==task.projectId) throw new ProductError("Task not found", 404);
      if (!await this.taskExecutionEligible(current)) throw new ProductError("Task is no longer eligible to receive messages", 409);
      const message: PersistedTaskMessage = {
        id:ownership.resourceId,
        taskId: task.id,
        actorId: userId,
        content: text,
        claimToken: null,
        deliveryStatus: "pending",
        claimedAt: null,
        leaseExpiresAt: null,
        safeError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null
      };
      const restart=await this.prepareSandboxRestart(userId,current);
      const receiptTask=restart?.task??current;
      const projected=await this.prepareProductInteractionChange(messageProductSource(message),receiptTask);
      if(!projected)throw new ProductError("Task message projection is unavailable",409);
      const queued=[...(await this.store.listTaskMessages(current.id)),message];
      const acceptedReceipt=await this.messageReceiptFromState(
        userId,receiptTask,message,false,queued,projected.interaction,
        restart?{...restart.sandboxRun,startupReadyAt:restart.reservedAt}:undefined
      );
      const responseBody=taskMessageIdempotencyEnvelope(message,receiptTask,userId,acceptedReceipt);
      const rejectionPresentation=await this.taskPresentation(userId,current);
      const created=await this.store.createTaskMessageAtomically({
        taskId:current.id,
        expectedCurrentRunId:current.currentRunId,
        message,
        idempotency:ownership,
        auditEvent:{
          id:`audit_task_message_create_${ownership.resourceId}`,
          projectId:task.projectId,
          actorId:userId,
          action:"task.message.create",
          status:"accepted",
          resourceKind:"task",
          resourceId:task.id,
          detail:{taskId:task.id,messageId:ownership.resourceId,deliveryStatus:"pending"},
          createdAt:timestamp
        },
        admission:this.config.liveSandbox?this.sandboxAdmission():this.releasedSandboxAdmission(),
        rejectionPresentation,
        rejectedAuditEvent:{
          id:`audit_sandbox_started_rejected_message_${ownership.resourceId}`,
          projectId:task.projectId,
          actorId:userId,
          action:"sandbox.started",
          status:"rejected",
          resourceKind:"sandbox",
          resourceId:task.id,
          detail:{taskId:task.id,trigger:"task_message"},
          createdAt:timestamp
        },
        responseStatus:200,
        responseBody,
        interactionChange:projected.change,
        ...(restart?{restart}: {})
      });
      if(created.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
      if(created.kind==="in_progress")throw idempotencyInProgressError();
      if(created.kind==="replay")return this.replayTaskMessage(userId,task,{kind:"replay",resourceId:ownership.resourceId,responseStatus:created.responseStatus,responseBody:created.responseBody});
      if(created.kind==="capacity_rejected"){
        if(created.admission.kind==="project_capacity_rejected")await this.bestEffortRecordProjectSandboxCapacityRejected(task.projectId);
        throw new SandboxRetryableProductError(created.responseStatus,created.responseBody);
      }
      if(created.kind==="conflict")throw new ProductError("Task message or sandbox changed concurrently",409,"task_message_conflict");
      if(created.restarted)void this.refreshSandboxCapacityAlerts(current.projectId);
      return structuredClone(acceptedReceipt);
    }catch(error){
      const converged=await this.store.findTaskIdempotency({
        actorId:userId,projectId:task.projectId,operation,key,requestHash
      });
      if(converged?.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
      if(converged?.kind==="replay")return this.replayTaskMessage(userId,task,converged);
      if(isTerminalizablePreAdmissionRejection(error)){
        return this.completeRejectedTaskMessage(userId,task,ownership,error);
      }
      throw error;
    }
  }

  private async completeRejectedTaskMessage(
    userId:string,
    task:PersistedAgentTask,
    ownership:BeginTaskIdempotencyInput,
    error:ProductError
  ):Promise<TaskMessageReceipt>{
    const begun=await this.store.beginTaskIdempotency(ownership);
    if(begun.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
    if(begun.kind==="in_progress")throw idempotencyInProgressError();
    if(begun.kind==="replay")return this.replayTaskMessage(userId,task,begun);
    const claimed={...ownership,resourceId:begun.resourceId,claimToken:begun.claimToken};
    if(await this.store.completeTaskIdempotency({
      ...claimed,
      responseStatus:error.statusCode,
      responseBody:taskOperationErrorBody(error),
      updatedAt:nowIso()
    }))throw provenTaskCommandRejection(error);
    const terminal=await this.store.findTaskIdempotencyByResource({
      actorId:ownership.actorId,
      operation:"message",
      key:ownership.key,
      requestHash:ownership.requestHash,
      resourceId:begun.resourceId
    });
    if(terminal?.kind==="hash_mismatch")throw idempotencyPayloadMismatchError();
    if(terminal?.kind==="replay")return this.replayTaskMessage(userId,task,terminal);
    throw idempotencyInProgressError();
  }

  async editTaskMessage(userId: string, taskId: string, messageId: string, content: string, idempotencyKey?: string): Promise<TaskMessageReceipt> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "write");
    const text = requireNonEmptyString(content, "task.message.content");
    const source = await this.store.findTask(task.id);
    if (!source || source.deletedAt) throw new ProductError("Task not found", 404);
    if (!await this.taskExecutionEligible(source)) throw new ProductError("Task is no longer eligible to receive messages", 409);
    const message = await this.store.findTaskMessage(messageId);
    if (!message || message.taskId !== task.id) throw new ProductError("Task message not found", 404);
    const updatedAt = strictlyLaterIso(message.updatedAt ?? message.createdAt);
    const projectedMessage = { ...message, content:text, updatedAt };
    const projection = await this.prepareProductInteractionChange(messageProductSource(projectedMessage),source);
    if(!projection)throw new ProductError("Task message projection is unavailable",409);
    const queued=(await this.store.listTaskMessages(task.id)).map((candidate)=>candidate.id===messageId?projectedMessage:candidate);
    const response=await this.messageReceiptFromState(userId,source,projectedMessage,false,queued,projection.interaction);
    const key=normalizeIdempotencyKey(idempotencyKey),requestHash=canonicalRequestHash({taskId,messageId,content:text}),claimToken=newId("idempotency_claim");
    const result=await this.store.editTaskMessageAtomically({
      taskId,
      messageId,
      content:text,
      expectedUpdatedAt:message.updatedAt??message.createdAt,
      updatedAt,
      interactionChange:projection.change,
      idempotency:{actorId:userId,projectId:task.projectId,operation:taskOperation("message-edit"),key,requestHash,resourceId:messageId,claimToken,now:updatedAt,leaseExpiresAt:deadlineIso(updatedAt,IDEMPOTENCY_LEASE_MS)},
      auditEvent:{id:`audit_task_message_edit_${messageId}_${requestHash.slice(0,16)}`,projectId:task.projectId,actorId:userId,action:"task.message.edit",status:"accepted",resourceKind:"task",resourceId:task.id,detail:messageAuditDetail(task.id,projectedMessage),createdAt:updatedAt},
      responseStatus:200,
      responseBody:response
    });
    if(result.kind==="hash_mismatch")throw new ProductError("Idempotency-Key was already used with a different request",409);
    if(result.kind==="in_progress")throw idempotencyInProgressError();
    if(result.kind==="conflict")throw new ProductError("Only a pending message can be edited",409);
    if(result.kind==="replay")return{...(structuredClone(result.responseBody) as TaskMessageReceipt),duplicate:true};
    return response;
  }

  async deleteTaskMessage(userId: string, taskId: string, messageId: string, idempotencyKey?: string): Promise<TaskMessageReceipt> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "write");
    const source = await this.store.findTask(task.id);
    if (!source || source.deletedAt) throw new ProductError("Task not found", 404);
    const message = await this.store.findTaskMessage(messageId);
    if (!message || message.taskId !== task.id) throw new ProductError("Task message not found", 404);
    const deletedAt = strictlyLaterIso(message.updatedAt ?? message.createdAt);
    const queued=(await this.store.listTaskMessages(task.id)).filter((candidate)=>candidate.id!==messageId);
    const response:TaskMessageReceipt={messageId,disposition:"accepted_by_active_run",duplicate:false,queuedMessage:null,interaction:null,presentation:await this.taskPresentation(userId,source,{queued})};
    const key=normalizeIdempotencyKey(idempotencyKey),requestHash=canonicalRequestHash({taskId,messageId}),claimToken=newId("idempotency_claim");
    const result=await this.store.deleteTaskMessageAtomically({
      taskId,
      messageId,
      deletedAt,
      idempotency:{actorId:userId,projectId:task.projectId,operation:taskOperation("message-delete"),key,requestHash,resourceId:messageId,claimToken,now:deletedAt,leaseExpiresAt:deadlineIso(deletedAt,IDEMPOTENCY_LEASE_MS)},
      auditEvent:{id:`audit_task_message_delete_${messageId}`,projectId:task.projectId,actorId:userId,action:"task.message.delete",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,messageId},createdAt:deletedAt},
      responseStatus:200,
      responseBody:response
    });
    if(result.kind==="hash_mismatch")throw new ProductError("Idempotency-Key was already used with a different request",409);
    if(result.kind==="in_progress")throw idempotencyInProgressError();
    if(result.kind==="conflict")throw new ProductError("Only a pending or failed message can be deleted",409);
    if(result.kind==="replay")return{...(structuredClone(result.responseBody) as TaskMessageReceipt),duplicate:true};
    return response;
  }

  async editTask(userId:string,taskId:string,title:string,idempotencyKey?:string):Promise<TaskPresentation>{
    const task=await this.requireTaskRecordForUser(userId,taskId,"write");const normalized=normalizeTaskTitle(title,task.prompt);
    const result=await this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"edit",key:idempotencyKey,request:{taskId,title:normalized}},task.id,async()=>{const updated=await this.store.updateTaskTitle(task.id,normalized,nowIso());if(!updated)throw new ProductError("Task not found",404);await this.policies.recordOperation(task.projectId,userId,"task.edit","accepted",task.id,"task",{taskId:task.id});return this.taskPresentation(userId,updated);});
    return this.taskPresentation(userId,await this.store.findTask(result.task.id)??task);
  }

  async archiveTask(userId:string,taskId:string,idempotencyKey?:string):Promise<TaskPresentation>{
    const task=await this.requireTaskRecordForUser(userId,taskId,"write");
    return this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"archive",key:idempotencyKey,request:{taskId}},task.id,async()=>{
      const timestamp=nowIso();
      const archived=await this.store.archiveTask(task.id,timestamp,{id:`audit_task_archive_${task.id}`,projectId:task.projectId,actorId:userId,action:"task.archive",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id},createdAt:timestamp});
      if(archived.kind==="not_found_or_forbidden")throw new ProductError("Task not found",404);
      if(archived.kind==="sandbox_not_released")throw new ProductError("Release the Task sandbox before archiving",409,"task_sandbox_active");
      return this.taskPresentation(userId,archived.value);
    });
  }

  async deleteTask(userId:string,taskId:string,idempotencyKey?:string):Promise<{deleted:true;taskId:string}>{
    const task=await this.store.findTask(taskId);
    if(!task){
      if(idempotencyKey!==undefined){
        const key=normalizeIdempotencyKey(idempotencyKey),requestHash=canonicalRequestHash({taskId});
        const replay=await this.store.findTaskIdempotencyByResource({actorId:userId,operation:"delete",key,requestHash,resourceId:taskId});
        if(replay?.kind==="hash_mismatch")throw new ProductError("Idempotency-Key was already used with a different request",409);
        if(replay?.kind==="in_progress")throw idempotencyInProgressError();
        if(replay?.kind==="replay"&&replay.responseStatus<400)return structuredClone(replay.responseBody) as {deleted:true;taskId:string};
      }
      throw new ProductError("Task not found",404);
    }
    await this.workspaces.requireProjectForUser(userId,task.projectId,"write");
    return this.runIdempotentTaskOperation({actorId:userId,projectId:task.projectId,operation:"delete",key:idempotencyKey,request:{taskId}},task.id,async(_resourceId,ownership)=>{
      const current=await this.store.findTask(task.id);if(!current)throw new ProductError("Task not found",404);
      const project=await this.store.findProject(task.projectId);if(!project)throw new ProductError("Task project not found",409);
      if(!current.fileLibraryId)throw new ProductError("Task File Library is unavailable",409);
      const library=await this.store.findFileLibrary(current.fileLibraryId);
      if(!library||library.projectId!==project.id)throw new ProductError("Task File Library is unavailable",409);
      const deletedAt=nowIso();
      const begun=await this.store.beginTaskDeletion(task.id,deletedAt,{id:`audit_task_delete_${task.id}`,projectId:task.projectId,actorId:userId,action:"task.delete",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id},createdAt:deletedAt});
      if(begun.kind==="not_found_or_forbidden")throw new ProductError("Task not found",404);
      if(begun.kind==="sandbox_not_released")throw new ProductError("Release the Task sandbox before deleting",409,"task_sandbox_active");
      const projectRoot=path.resolve(this.config.dataRoot,project.rootPath);
      assertPathInside(path.resolve(this.config.dataRoot),projectRoot,"Project data directory is outside the data root");
      const response={deleted:true as const,taskId};
      await withProjectFileLock(projectRoot,async()=>{
        const taskRoot=path.resolve(projectRoot,"tasks",task.id);
        assertPathInside(projectRoot,taskRoot,"Task data directory is outside the Project");
        await rm(taskRoot,{recursive:true,force:true});
        await this.removeDeletedTaskArtifacts(projectRoot,library,task.id);
      });
      await this.reconcileTaskLibraryBytes(current);
      if(!await this.store.purgeDeletedTaskData(task.id,{...ownership,responseStatus:200,responseBody:response,updatedAt:nowIso()}))throw new ProductError("Task could not be deleted",409);
      await this.policies.refreshFileAlerts(task.projectId).catch((error)=>{
        console.error(`Task ${task.id} file alert refresh failed after deletion: ${redactSecretLikeText(error instanceof Error?error.message:String(error))}`);
      });
      return response;
    });
  }

  private async removeDeletedTaskArtifacts(projectRoot:string,library:FileLibrary,taskId:string):Promise<void>{
    const artifactsRoot=path.resolve(projectRoot,library.rootSubPath,"workspace",".artifacts");
    const taskArtifacts=path.resolve(artifactsRoot,taskId);
    assertPathInside(projectRoot,taskArtifacts,"Task artifact directory is outside the Project");
    if(!await taskArtifactDirectoryIsSafeToRemove(projectRoot,taskArtifacts))return;
    await rm(taskArtifacts,{recursive:true,force:true});
    try{await rmdir(artifactsRoot);}catch(error){if(!isDirectoryNotEmpty(error)&&!isNotFound(error))throw error;}
  }

  async syncActiveTasksOnce(): Promise<ActiveTaskSyncResult> {
    const result: ActiveTaskSyncResult = {
      activeTaskCount: 0,
      syncedTaskIds: [],
      failedTaskIds: []
    };
    await this.reconcileTaskPreparations(result.failedTaskIds);
    await this.reconcileTerminalStartups(result.failedTaskIds);
    for(const message of await this.store.listTaskMessagesDue(nowIso(),100)){try{await this.dispatchTaskMessage(message,true);}catch{result.failedTaskIds.push(message.taskId);}}
    const activeSandboxes = await this.store.listActiveTasks();
    result.activeTaskCount=activeSandboxes.length;
    for (const task of activeSandboxes) {
      try {
        if(!await this.activeSandboxRun(task))continue;
        await this.syncTaskTimeline(task);
        result.syncedTaskIds.push(task.id);
      } catch {
        result.failedTaskIds.push(task.id);
      }
    }
    result.syncedTaskIds=[...new Set(result.syncedTaskIds)];result.failedTaskIds=[...new Set(result.failedTaskIds)];
    return result;
  }

  private async reconcileTaskPreparations(failedTaskIds:string[]):Promise<void>{
    for(const run of await this.store.sandboxRuns.list()){
      if(run.state!=="starting"&&run.state!=="active")continue;
      try{
        const task=await this.store.findTask(run.taskId);
        const project=await this.store.findProject(run.projectId);
        if(!task||!project||!taskMatchesExactSandboxRun(task,run))continue;
        const operation=await this.store.findTaskPreparationOperation(task.id);
        if(!operation)continue;
        const timestamp=nowIso();
        await this.resumePersistedTaskCreate(project,task,{
          ...operation,
          claimToken:newId("idempotency_claim"),
          now:timestamp,
          leaseExpiresAt:deadlineIso(timestamp,IDEMPOTENCY_LEASE_MS)
        },operation);
      }catch(error){
        if(isTaskCreateReceiptContention(error))continue;
        const currentRun=await this.store.sandboxRuns.get(run.runId);
        if(currentRun&&currentRun.startupReadyAt!==null){
          console.error(`Task ${run.taskId} create receipt recovery failed after readiness: ${redactSecretLikeText(error instanceof Error?error.message:String(error))}`);
          continue;
        }
        console.error(`Task ${run.taskId} preparation recovery failed: ${redactSecretLikeText(error instanceof Error?error.message:String(error))}`);
        const failedAt=nowIso();
        const failed=await this.store.failSandboxRun({
          runId:run.runId,
          expectedFencingToken:run.fencingToken,
          code:"startup_failed",
          message:"Task workspace preparation could not be recovered.",
          failedAt,
          auditEvent:{id:`audit_sandbox_failed_preparation_${run.runId}`,projectId:run.projectId,actorId:null,subjectUserId:run.startedByUserId,action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId},createdAt:failedAt}
        });
        if(failed)failedTaskIds.push(run.taskId);
        else if(!(error instanceof Error&&/readiness changed/.test(error.message)))failedTaskIds.push(run.taskId);
      }
    }
  }

  private async reconcileTerminalStartups(failedTaskIds:string[]):Promise<void>{
    for(const run of await this.store.sandboxRuns.list()){
      if(run.state!=="starting"||run.startupReadyAt===null)continue;
      const operation=await this.store.findInProgressTerminalStartOperation(run.runId);
      if(!operation)continue;
      try{
        const task=await this.store.findTask(run.taskId);
        if(!task||!taskMatchesExactSandboxRun(task,run))continue;
        await this.beginSandboxStartupOperation(task,true,run).promise;
      }catch{
        failedTaskIds.push(run.taskId);
      }
    }
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
    let message=await this.store.findTaskMessage(candidate.id)??candidate;
    if (message.deletedAt || ["accepted", "failed"].includes(message.deliveryStatus ?? "")) {
      if (completeIdempotency) await this.completeMessageIdempotency(message);
      return message;
    }
    let source=await this.store.findTask(message.taskId);
    if (!source) throw new ProductError("Task not found", 404);
    if (message.deliveryStatus === "dispatching") {
      if(!message.claimToken||!message.leaseExpiresAt||message.leaseExpiresAt>nowIso())return message;
      return this.failClaimedTaskMessage(
        message,
        "Message delivery outcome is unknown; it was not sent again.",
        completeIdempotency
      );
    }

    const firstWaiting=(await this.store.listTaskMessages(source.id))
      .find((queued)=>["pending","dispatching"].includes(queued.deliveryStatus??"pending"));
    if(firstWaiting?.id!==message.id)return message;

    const startupActorId=message.actorId??source.createdByUserId;
    if(!startupActorId)throw new ProductError("Task sandbox startup actor is unavailable",409);
    try {
      source=await this.ensureLiveSandbox(startupActorId,source);
      const serviceKey=this.serviceKeyForTask(source);
      const runtime=await this.readRuntimeState(source,serviceKey);
      const run=source.currentRunId?await this.store.sandboxRuns.get(source.currentRunId):null;
      if(!run||!taskMatchesExactSandboxRun(source,run)||run.state!=="active"||run.startupReadyAt===null)return message;
      await this.readVerifiedBotifiedState(source,runtime.baseUrl,serviceKey);

      const timestamp=nowIso();
      const claimed=await this.store.claimTaskMessage({
        id:message.id,
        claimToken:newId("delivery_claim"),
        claimedAt:timestamp,
        leaseExpiresAt:deadlineIso(timestamp,this.deliveryLeaseMs())
      });
      if(!claimed)return await this.store.findTaskMessage(message.id)??message;
      message=claimed;
      await this.persistMessageInteraction(message);

      await this.botified.postMessage(runtime.baseUrl,serviceKey,{messageId:message.id,text:message.content});
      const accepted=await this.store.acceptTaskMessage({
        id:message.id,
        claimToken:message.claimToken!,
        updatedAt:nowIso()
      });
      if(!accepted)throw new ProductError("Task message delivery claim changed before acceptance",409);
      await this.persistMessageInteraction(accepted);
      await this.bestEffortSyncTaskTimeline(source);
      if(completeIdempotency)await this.completeMessageIdempotency(accepted);
      return accepted;
    }catch(error){
      if(message.deliveryStatus!=="dispatching"||!message.claimToken)throw error;
      return this.failClaimedTaskMessage(
        message,
        `Message delivery outcome is unknown: ${safeTaskStageError(error)}`,
        completeIdempotency
      );
    }
  }

  private async failClaimedTaskMessage(message:PersistedTaskMessage,safeError:string,completeIdempotency:boolean):Promise<PersistedTaskMessage>{
    if(!message.claimToken)return await this.store.findTaskMessage(message.id)??message;
    const failed=await this.store.failTaskMessage({id:message.id,claimToken:message.claimToken,safeError,updatedAt:nowIso()});
    const settled=failed??await this.store.findTaskMessage(message.id)??message;
    if(failed)await this.persistMessageInteraction(failed);
    if(completeIdempotency&&isSettledMessage(settled))await this.completeMessageIdempotency(settled);
    return settled;
  }

  private deliveryLeaseMs():number{return resolveDurationMs(this.config.deliveryLeaseMs,DEFAULT_DELIVERY_LEASE_MS);}

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
      items: await this.presentTaskInteractions(userId,task.projectId,snapshot.items.filter((item)=>!suppressedInteractionIds.has(item.id))),
      queuedMessages: state.queuedMessages,
      nextPageCursor: snapshot.nextPageAnchor ? this.encodeInteractionCursor(current, "history", snapshot.latestChangeSeq, snapshot.nextPageAnchor) : null,
      hasMoreBefore: snapshot.hasMoreBefore,
      streamCursor: this.encodeInteractionCursor(current, "stream", snapshot.latestChangeSeq),
      runtimeReachability: state.runtimeReachability,
      historyStatus: state.historyStatus,
      lastSyncedAt: state.lastSyncedAt,
      presentation: state.presentation
    };
  }

  async taskInteractionChanges(userId: string, taskId: string, cursor: string, limit = INTERACTION_SYNC_PAGE_LIMIT): Promise<TaskInteractionChangePage> {
    const task = await this.requireTaskRecordForUser(userId, taskId, "view");
    const decoded = this.decodeInteractionCursor(task, cursor, "stream");
    if (!task.deletedAt) await this.ensureTaskConversation(task);
    const page = await this.store.readTaskInteractionChangePage(task.id, decoded.changeSeq, Math.min(INTERACTION_SYNC_PAGE_LIMIT, Math.max(1, limit)));
    if (!page) throw new ProductError("Task not found", 404);
    if (decoded.changeSeq > page.latestChangeSeq) throw new ProductError("Task interaction cursor is invalid for this task", 400);
    const suppressedInteractionIds = new Set(page.suppressedInteractionIds);
    const current = await this.store.findTask(task.id) ?? task;
    const visibleChanges=page.changes.filter((change)=>!suppressedInteractionIds.has(change.interaction.id));
    const presented=await this.presentTaskInteractions(userId,task.projectId,visibleChanges.map((change)=>change.interaction));
    return {
      changes: visibleChanges.map((change,index) => ({ cursor:this.encodeInteractionCursor(task,"stream",change.changeSeq), item:presented[index]! })),
      streamCursor: this.encodeInteractionCursor(task, "stream", page.upperChangeSeq),
      done: Boolean(current.deletedAt),
      state: await this.taskInteractionState(userId, current, page)
    };
  }

  async *streamTaskAssistantPreviews(userId: string, taskId: string, signal?: AbortSignal): AsyncIterable<TaskAssistantPreviewUpdate> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    if (!await this.activeSandboxRun(task) || !this.botified.streamLlmTextPreview) return;
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

  async abortTaskTurn(userId:string,taskId:string,request:TaskTurnAbortRequest):Promise<TaskTurnAbortResponse>{
    const task=await this.requireTaskRecordForUser(userId,taskId,"write");
    const expectedRunId=requireNonEmptyString(request.expectedRunId,"task.abort.expectedRunId");
    if(task.currentRunId!==expectedRunId)throw taskRunTargetConflictError();
    const run=await this.store.sandboxRuns.get(expectedRunId);
    if(!run||run.state!=="active"||!taskMatchesExactSandboxRun(task,run))throw taskRunTargetConflictError();
    const serviceKey=this.serviceKeyForRun(task,run);
    const baseUrl=this.botifiedBaseUrlForRun(run);
    let result;
    try{
      result=await this.botified.abort(baseUrl,serviceKey);
    }catch(error){
      throw new ProductError(
        `Abort outcome is unknown: ${safeTaskStageError(error)}`,
        503,
        "botified_abort_outcome_unknown"
      );
    }
    await this.bestEffortSyncTaskTimeline(task);
    return{taskId:task.id,runId:run.runId,state:result.state,queueLength:result.queueLength};
  }

  async listTaskArtifacts(userId: string, taskId: string, query: TaskArtifactListQuery = {}): Promise<TaskArtifactListPage> {
    await this.requireTaskForUser(userId, taskId, "view");
    const limit=Math.min(100,Math.max(1,Math.floor(query.limit??20)));
    const filter={kind:query.kind??null,mediaType:query.mediaType?.trim()||null,previewOnly:query.previewOnly===true};
    const after=decodeTaskArtifactCursor(query.cursor,taskId,filter);
    const page=await this.store.queryTaskArtifacts(taskId,{...filter,...(after?{after}:{}),limit});
    const last=page.items.at(-1);
    return{
      items:page.items.map(publicArtifact),
      nextCursor:page.hasMore&&last?encodeTaskArtifactCursor(taskId,filter,{createdAt:last.createdAt,artifactId:last.id}):null
    };
  }

  async downloadTaskArtifact(userId: string, taskId: string, artifactId: string): Promise<TaskArtifactDownload> {
    const task = await this.requireTaskForUser(userId, taskId, "view");
    const artifact = await this.store.findTaskArtifact(taskId,artifactId);
    if (!artifact) {
      throw new ProductError("Task artifact not found", 404);
    }
    const stored = await this.taskArtifactStoragePath(task, artifact);
    for (const filePath of [stored.filePath]) {
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

  taskRuntimePaths(task:Pick<AgentTask,"id">):{taskHomePath:string;botifiedDataPath:string;artifactPath:string}{
    return{taskHomePath:BOTIFIED_TASK_HOME_PATH,botifiedDataPath:BOTIFIED_DATA_PATH,artifactPath:botifiedArtifactPath(task.id)};
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

  private async ensureLiveSandbox(userId:string,task:PersistedAgentTask):Promise<PersistedAgentTask>{
    const stored=await this.ensureLiveSandboxCandidate(userId,task.id);
    return this.beginSandboxStartupOperation(stored,true).promise;
  }

  private async ensureLiveSandboxCandidate(_userId:string,taskId:string):Promise<PersistedAgentTask>{
    const stored=await this.store.findTask(taskId);
    if(!stored||stored.deletedAt)throw new ProductError("Task not found",404);
    if(stored.archivedAt)throw new ProductError("Task sandbox cannot be started",409);
    const run=await this.activeSandboxRun(stored);
    if(!run)throw new ProductError("Task sandbox must be reserved before runtime startup",409,"task_sandbox_not_reserved");
    return stored;
  }

  private beginSandboxStartupOperation(task:PersistedAgentTask,persistFailure:boolean,knownRun?:PersistedSandboxRunState):{owner:boolean;promise:Promise<PersistedAgentTask>}{
    const runId=requireCurrentRunId(task);
    const existing=this.startupOperationsByRunId.get(runId);
    if(existing)return{owner:false,promise:existing};
    const controller=new AbortController();
    const operation=this.startReservedSandbox(task,persistFailure,knownRun,controller.signal);
    this.startupOperationsByRunId.set(runId,operation);
    this.startupAbortControllersByRunId.set(runId,controller);
    void operation.finally(()=>{
      if(this.startupOperationsByRunId.get(runId)===operation)this.startupOperationsByRunId.delete(runId);
      if(this.startupAbortControllersByRunId.get(runId)===controller)this.startupAbortControllersByRunId.delete(runId);
    }).catch(()=>undefined);
    return{owner:true,promise:operation};
  }

  private async serializeTerminalStartReservation<T>(identity:string,reserve:()=>Promise<T>):Promise<T>{
    const previous=this.terminalStartReservations.get(identity)??Promise.resolve();
    let release:()=>void=()=>undefined;
    const current=new Promise<void>((resolve)=>{release=resolve;});
    const tail=previous.then(()=>current);
    this.terminalStartReservations.set(identity,tail);
    await previous;
    try{
      return await reserve();
    }finally{
      release();
      if(this.terminalStartReservations.get(identity)===tail)this.terminalStartReservations.delete(identity);
    }
  }

  private async prepareSandboxRestart(userId:string,task:PersistedAgentTask){
    const currentRun=task.currentRunId?await this.store.sandboxRuns.get(task.currentRunId):null;
    if(currentRun&&taskMatchesExactSandboxRun(task,currentRun)&&["starting","active"].includes(currentRun.state))return null;
    if(task.currentRunId&&(!currentRun||!taskMatchesExactSandboxRun(task,currentRun)))throw new ProductError("Task sandbox ownership record is unavailable or mismatched",409,"task_sandbox_unknown");
    if(currentRun&&currentRun.state!=="released")throw new ProductError("Task sandbox release is not complete",409,"task_sandbox_release_pending");
    const [project,library]=await Promise.all([this.store.findProject(task.projectId),task.fileLibraryId?this.store.findFileLibrary(task.fileLibraryId):null]);
    if(!project||!library||library.workspaceId!==task.workspaceId||library.projectId!==task.projectId)throw new ProductError("Task File Library is unavailable",409);
    const reservedAt=nowIso(),runId=newId("run"),botifiedPort=this.config.botifiedPort??3099,resourceNames=sandboxResourceNamesForTask(task.id);
    const replacement:PersistedAgentTask={...task,currentRunId:runId,updatedAt:reservedAt};
    return{
      task:replacement,
      runtimeState:{botifiedBaseUrl:this.botifiedBaseUrlForTask(task.id,botifiedPort)},
      sandboxRun:this.buildLiveSandboxRun({task:replacement,timestamp:reservedAt,botifiedPort,projectSubPath:project.rootPath,fileLibraryRootSubPath:library.rootSubPath,resourceNames,startedByUserId:userId}),
      reservedAt
    };
  }

  private async startReservedSandbox(stored:PersistedAgentTask,persistFailure=true,knownRun?:PersistedSandboxRunState,signal?:AbortSignal):Promise<PersistedAgentTask>{
    let task=stored;
    signal?.throwIfAborted();
    const run=knownRun??await this.activeSandboxRun(task);
    if(!run)throw new ProductError("Task sandbox must be reserved before runtime startup",409,"task_sandbox_not_reserved");
    if(!taskMatchesExactSandboxRun(task,run)||!["starting","active"].includes(run.state))throw new ProductError("Task sandbox reservation changed",409,"task_sandbox_not_reserved");
    if(run.state==="starting"){
      let operation="start sandbox";
      try{
        task=await this.startLiveSandbox({task,run,...(signal?{signal}:{})})??task;
      }catch(error){
        if(error instanceof ProductError&&error.code==="sandbox_cleanup_intent_conflict"){
          const current=await this.store.sandboxRuns.get(run.runId);
          if(!current||!taskMatchesExactSandboxRun(task,current)||current.state!=="starting")throw error;
        }
        if(error instanceof ProductError&&["sandbox_startup_deadline_exceeded","sandbox_startup_unknown_result"].includes(error.code??""))throw error;
        const adopted=persistFailure
          ?await this.persistStartingRunFailureOrAdopt(task,run.runId,operation,error)
          :await this.adoptConcurrentlyStartedRun(task,run.runId);
        if(adopted)task=adopted;
        else throw new ProductError(safeTaskStageError(error),error instanceof ProductError?error.statusCode:502,"sandbox_startup_failed");
      }
    }
    return task;
  }

  private async adoptConcurrentlyStartedRun(task:PersistedAgentTask,runId:string):Promise<PersistedAgentTask|null>{
    const current=await this.store.sandboxRuns.get(runId);
    if(!current||!taskMatchesExactSandboxRun(task,current)||current.state!=="active")return null;
    const currentTask=await this.store.findTask(task.id);
    return currentTask&&taskAllowsActivatedRunAdoption(currentTask,current)?currentTask:null;
  }

  private projectStartupFailedRun(run:PersistedSandboxRunState,failedAt:string):PersistedSandboxRunState{
    return{
      ...run,
      state:"failed",
      failureCode:"startup_failed",
      failureCause:"Sandbox startup did not complete. Retry release to remove its resources.",
      releaseReason:"failed",
      failedAt:run.failedAt??failedAt,
      releaseRequestedAt:run.releaseRequestedAt??failedAt,
      startupClaimToken:null,
      startupLeaseExpiresAt:null,
      cleanupClaimedAt:null,
      fencingToken:run.fencingToken+1,
      updatedAt:failedAt
    };
  }

  private async requireTaskTerminalAccess(userId:string,taskId:string,expectedRunId:string):Promise<{task:PersistedAgentTask;run:PersistedSandboxRunState}>{
    const task=await this.requireTaskForUser(userId,taskId,"write");
    if(task.currentRunId!==expectedRunId)throw taskRunTargetConflictError();
    const run=await this.store.sandboxRuns.get(expectedRunId);
    if(!run||run.state!=="active"||!taskMatchesExactSandboxRun(task,run))throw taskRunTargetConflictError();
    return{task,run};
  }

  private async syncTaskTimeline(task: PersistedAgentTask): Promise<PersistedAgentTask> {
    const previous = this.taskTimelineSyncs.get(task.id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.taskTimelineSyncs.set(task.id, current);
    await previous;
    try {
      return await this.syncTaskTimelineUnlocked(task);
    } finally {
      release();
      if (this.taskTimelineSyncs.get(task.id) === current) this.taskTimelineSyncs.delete(task.id);
    }
  }

  private async syncTaskTimelineUnlocked(task: PersistedAgentTask): Promise<PersistedAgentTask> {
    const serviceKey = this.serviceKeyForTask(task);
    const state = await this.readRuntimeState(task, serviceKey);
    const snapshot = await this.store.readTaskInteractionSnapshot(task.id, null, INTERACTION_LOOKUP_LIMIT);
    if (!snapshot) throw new ProductError("Task not found", 404);
    await this.readVerifiedBotifiedState(task,state.baseUrl,serviceKey);
    const timeline = await this.readCanonicalTimeline(task, state.baseUrl, serviceKey, snapshot.sourceCursor, snapshot.historyStatus);
    const latest = new Map(snapshot.items.map((item) => [item.id, item]));
    const messages = await this.store.listTaskMessages(task.id);
    const redaction = await this.interactionRedaction(task, serviceKey);
    const changes: TaskInteractionChangeInput[] = [];
    const inBatchCorrelations = new Map<string, TaskInteractionProjectionState>();
    const artifactProjections: PersistTaskArtifactProjectionInput[] = [];
    const newlyWrittenArtifactPaths: string[] = [];
    const candidateArtifactFileIds=[...new Set(timeline.events.flatMap((event)=>{
      const fileId=stringValue(event.data.file_id)??(event.item?.type==="file"?event.item.id:undefined);
      return fileId?[fileId]:[];
    }))];
    const existingArtifacts = new Set(await this.store.findExistingTaskArtifactFileIds(task.id,candidateArtifactFileIds));
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
    const syncedAt = nowIso();
    try {
      if(artifactProjections.length)await this.reconcileTaskLibraryBytes(task);
      await this.store.persistTaskInteractionMutation({
        taskId: task.id,
        changes,
        ...(artifactProjections.length ? { artifactProjections } : {}),
        sourceSync: {
          expectedSourceCursor: snapshot.sourceCursor,
          sourceCursor: timeline.nextCursor,
          historyStatus: timeline.historyStatus,
          lastSyncedAt: syncedAt
        }
      });
    } catch (error) {
      for (const filePath of newlyWrittenArtifactPaths) await rm(filePath, { force:true });
      if(newlyWrittenArtifactPaths.length)await this.reconcileTaskLibraryBytes(task).catch((reconcileError)=>console.error("Task artifact usage rollback reconciliation failed",reconcileError));
      throw error;
    }
    await this.writeRuntimeState(task.id, { ...state, lastSyncedAt:syncedAt });
    const updated = await this.store.findTask(task.id) ?? task;
    return updated;
  }

  private async readCanonicalTimeline(task:PersistedAgentTask,baseUrl: string, serviceKey: string, sourceCursor: string | null, historyStatus: TaskHistoryStatus): Promise<{ events: BotifiedTimelineEvent[]; nextCursor: string | null; historyStatus: TaskHistoryStatus }> {
    if (sourceCursor === null || historyStatus === "gap") return this.recoverCanonicalTimeline(task,baseUrl, serviceKey, historyStatus);
    const events: BotifiedTimelineEvent[] = [];
    let cursor = sourceCursor;
    while (true) {
      const page = await this.callBotified("read timeline", () => this.botified.readTimeline(baseUrl, serviceKey, cursor, { direction:"forward", limit:INTERACTION_SYNC_PAGE_LIMIT }));
      if (page.status === "gap") return this.recoverCanonicalTimeline(task,baseUrl, serviceKey, "gap");
      events.push(...await this.verifiedTimelineEvents(task,page.events));
      const next = safeRuntimeCursor(page.nextCursor) ?? cursor;
      if (!page.hasMoreAfter || next === cursor) return { events, nextCursor:next, historyStatus:"complete" };
      cursor = next;
    }
  }

  private async recoverCanonicalTimeline(task:PersistedAgentTask,baseUrl: string, serviceKey: string, minimumStatus: TaskHistoryStatus): Promise<{ events: BotifiedTimelineEvent[]; nextCursor: string | null; historyStatus: TaskHistoryStatus }> {
    const tail = await this.callBotified("read timeline", () => this.botified.readTimeline(baseUrl, serviceKey, undefined, { direction:"history", limit:INTERACTION_SYNC_PAGE_LIMIT }));
    if (tail.status === "gap") throw new ProductError("Botified history recovery failed", 502);
    const pages: BotifiedTimelineEvent[][] = [await this.verifiedTimelineEvents(task,tail.events)];
    let historyExpired = tail.historyBoundary === "expired";
    let page = tail;
    while (page.hasMoreBefore) {
      const start = safeRuntimeCursor(page.pageStartCursor);
      if (!start) return { events:pages.flat(), nextCursor:safeRuntimeCursor(tail.nextCursor)??null, historyStatus:"gap" };
      const previous = await this.callBotified("read timeline", () => this.botified.readTimeline(baseUrl, serviceKey, start, { direction:"backward", limit:INTERACTION_SYNC_PAGE_LIMIT }));
      if (previous.status === "gap") return { events:pages.flat(), nextCursor:safeRuntimeCursor(tail.nextCursor)??null, historyStatus:"gap" };
      pages.unshift(await this.verifiedTimelineEvents(task,previous.events));
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
      recovered.push(...await this.verifiedTimelineEvents(task,forward.events));
      const next: string = safeRuntimeCursor(forward.nextCursor) ?? pageStartCursor;
      if (!forward.hasMoreAfter || next === pageStartCursor) return { events:recovered, nextCursor:next, historyStatus };
      cursor = next;
    }
    return { events:recovered, nextCursor:null, historyStatus };
  }

  private async bestEffortSyncTaskTimeline(task: PersistedAgentTask): Promise<void> {
    try {
      await this.syncTaskTimeline(task);
    } catch (error) {
      if (error instanceof BotifiedTaskPortError) {
        return;
      }
      throw error;
    }
  }

  private async readRuntimeState(task: PersistedAgentTask, serviceKey: string, signal?:AbortSignal): Promise<BotifiedTaskRuntimeState> {
    signal?.throwIfAborted();
    const document = await this.store.jsonDocs.get("sandbox_runtime_state", task.id);
    signal?.throwIfAborted();
    if (!document) {
      return this.rebuildRuntimeStateFromBotified(task, serviceKey, signal);
    }
    const baseUrl = stringDocumentField(document, "botifiedBaseUrl");
    const state:BotifiedTaskRuntimeState={baseUrl};
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

  private async rebuildRuntimeStateFromBotified(task: PersistedAgentTask, serviceKey: string, signal?:AbortSignal): Promise<BotifiedTaskRuntimeState> {
    signal?.throwIfAborted();
    const run = task.currentRunId ? await this.store.sandboxRuns.get(task.currentRunId) : null;
    signal?.throwIfAborted();
    if (!run || run.taskId !== task.id || !Number.isFinite(run.botifiedPort) || run.botifiedPort <= 0) {
      throw new ProductError("Task runtime state not found", 409);
    }
    const baseUrl = this.botifiedBaseUrlForTask(task.id, run.botifiedPort, run.namespace);
    const snapshot = await this.readVerifiedBotifiedState(task,baseUrl,serviceKey,signal);
    signal?.throwIfAborted();
    const state = this.runtimeStateFromBotifiedSnapshot(baseUrl, snapshot);
    await this.writeRuntimeState(task.id, state, signal);
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

  private async writeRuntimeState(taskId: string, state: BotifiedTaskRuntimeState, signal?:AbortSignal): Promise<void> {
    const document:Record<string,unknown>={botifiedBaseUrl:state.baseUrl};
    const timelineCursor = safeRuntimeCursor(state.timelineCursor);
    if (timelineCursor !== undefined) {
      document.timelineCursor = timelineCursor;
    }
    if (state.lastSyncedAt !== undefined) {
      document.lastSyncedAt = state.lastSyncedAt;
    }
    signal?.throwIfAborted();
    await this.store.jsonDocs.put("sandbox_runtime_state", taskId, document);
  }

  private serviceKeyForTask(task: PersistedAgentTask): string {
    const serviceKey = this.generateServiceKey(this.keyInputForTask(task));
    requireBotifiedServiceKey(serviceKey);
    return serviceKey;
  }

  private brokerKeyForTask(task: PersistedAgentTask): string {
    return createBotifiedBrokerKey(this.config.botifiedServiceKeySecret, this.keyInputForTask(task));
  }

  private keyInputForTask(task: PersistedAgentTask): BotifiedServiceKeyInput {
    return {
      namespace: this.config.namespace,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      runId: requireCurrentRunId(task)
    };
  }

  private serviceKeyForRun(task:PersistedAgentTask,run:PersistedSandboxRunState):string{
    const serviceKey=this.generateServiceKey({
      namespace:run.namespace,
      workspaceId:run.workspaceId,
      projectId:run.projectId,
      taskId:task.id,
      runId:run.runId
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

  private botifiedBaseUrlForRun(run:PersistedSandboxRunState):string{
    const input:BotifiedTaskAddressInput={
      namespace:run.namespace,
      taskId:run.taskId,
      port:run.botifiedPort,
      runId:run.runId,
      serviceName:run.resourceNames.service
    };
    return (this.config.botifiedBaseUrlForTask??defaultBotifiedBaseUrlForTask)(input);
  }

  private terminalHostForRun(run:PersistedSandboxRunState):string{
    const input:TaskTerminalHostInput={
      runId:run.runId,
      taskId:run.taskId,
      namespace:run.namespace,
      serviceName:run.resourceNames.service
    };
    return (this.config.terminalHostForRun??defaultTerminalHostForRun)(input);
  }

  private botifiedBrokerBaseUrlForTask(task: PersistedAgentTask): string {
    const input: BotifiedBrokerAddressInput = {
      namespace: this.config.namespace,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      runId: requireCurrentRunId(task)
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

  private async readVerifiedBotifiedState(task:PersistedAgentTask,baseUrl:string,serviceKey:string,signal?:AbortSignal):Promise<BotifiedRuntimeStateResult>{
    signal?.throwIfAborted();
    const state=await this.callBotified("read state",()=>this.botified.readState(baseUrl,serviceKey,signal));
    signal?.throwIfAborted();
    if(state.sessionId!==task.id){
      const mismatch=new ProductError("Botified session identity mismatch",409,"botified_session_mismatch");
      await this.persistRuntimeIdentityFailure(task,"read state",mismatch);
      throw mismatch;
    }
    return state;
  }

  private async verifiedTimelineEvents(task:PersistedAgentTask,values:readonly unknown[]):Promise<BotifiedTimelineEvent[]>{
    const events=parseBotifiedTimelineEvents(values);
    if(events.some((event)=>event.session_id!==task.id)){
      const mismatch=new ProductError("Botified timeline session identity mismatch",409,"botified_session_mismatch");
      await this.persistRuntimeIdentityFailure(task,"read timeline",mismatch);
      throw mismatch;
    }
    return events;
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
      const existingBytes = await readRegularFileWithoutFollowingSymlink(filePath,"Task artifact");
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

  private async taskArtifactStoragePath(task: PersistedAgentTask, artifact: PersistedTaskArtifact): Promise<{ root: string; filePath: string }> {
    const project = await this.store.findProject(task.projectId);
    if (!project) {
      throw new ProductError("Task project not found", 409);
    }
    const dataRoot = path.resolve(this.config.dataRoot);
    if(!task.fileLibraryId)throw new ProductError("Task File Library is unavailable",409);
    const library=await this.store.findFileLibrary(task.fileLibraryId);
    if(!library||library.projectId!==task.projectId)throw new ProductError("Task File Library is unavailable",409);
    const root=path.resolve(dataRoot,project.rootPath,library.rootSubPath,"workspace",".artifacts",task.id);
    assertPathInside(dataRoot, root, "Task artifact directory is outside the data root");
    const sandboxPath = artifact.fileId.startsWith("sandbox-published:") ? artifact.fileId.slice("sandbox-published:".length) : null;
    const filename = `${artifactStorageSegment(artifact.id, "artifact")}-${artifactStorageSegment(artifact.name, artifact.fileId)}`;
    const filePath = sandboxPath ? path.resolve(root, ...sandboxPath.split("/")) : path.resolve(root, filename);
    assertPathInside(root, filePath, "Task artifact path is outside the artifact directory");
    return { root, filePath };
  }

  private async reconcileTaskLibraryBytes(task:PersistedAgentTask):Promise<void>{
    await this.fileLibraries.reconcileStoredProjectFileBytes(task.projectId,(bytes)=>this.policies.reconcileFileLibraryBytes(task.projectId,bytes));
  }

  async authorizeBotifiedChatCompletion(taskId: string, runId: string, brokerKey: string): Promise<AuthorizedBotifiedChatCompletion> {
    const task = await this.store.findTask(taskId);
    if (!task || task.currentRunId !== runId || !constantTimeEqual(brokerKey, this.brokerKeyForTask(task))) {
      throw new ProductError("Unauthorized Botified task key", 401);
    }
    const run=await this.activeSandboxRun(task);
    if (!run||run.runId!==runId||run.state!=="active") {
      throw new ProductError("Botified task is not active", 409);
    }
    const endpoint = await this.endpoints.requireHealthyCredentialEndpoint(task.projectId, task.endpointId);
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
    fileLibraryRootSubPath:string;
    resourceNames: SandboxRunState["resourceNames"];
    startedByUserId?: string;
  }): PersistedSandboxRunState {
    const paths = this.taskRuntimePaths(input.task);
    return {
      namespace: this.config.namespace,
      workspaceId: input.task.workspaceId,
      projectId: input.task.projectId,
      taskId: input.task.id,
      runId: requireCurrentRunId(input.task),
      state: "starting",
      image: this.config.botifiedRunnerImage,
      pvcName: this.config.pvcName,
      projectSubPath: input.projectSubPath,
      fileLibraryRootSubPath:input.fileLibraryRootSubPath,
      fileLibraryId: input.task.fileLibraryId!,
      startedByUserId: input.startedByUserId??input.task.createdByUserId!,
      startedAt: null,
      startupReadyAt: null,
      startupConfigMapName:null,
      startupConfigHash:null,
      startupPodUid:null,
      startupPodIp:null,
      startupActionDeadlineAt: null,
      botifiedPort: input.botifiedPort,
      resourceNames: input.resourceNames,
      serviceKeySecretRef: {
        name: input.resourceNames.secret,
        key: "BOTIFIED_SERVICE_KEY"
      },
      directories: {
        libraryHome: paths.taskHomePath,
        botified: paths.botifiedDataPath
      },
      resourceLimits: {
        cpuRequest: "250m",
        memoryRequest: "512Mi",
        cpuLimit: "1",
        memoryLimit: "1Gi"
      },
      resourceSnapshot: normalizeSandboxResources({ cpuRequest:"250m", memoryRequest:"512Mi", cpuLimit:"1", memoryLimit:"1Gi" }),
      failureCode:null,
      failureCause:null,
      fencingToken: 1,
      startupClaimToken:null,
      startupLeaseExpiresAt:null,
      cleanupClaimedAt:null,
      cleanupAttempts:0,
      lastCleanupAt:null,
      lastCleanupError:null,
      releaseRequestedAt:null,
      failedAt:null,
      releasedAt:null,
      createdAt: input.timestamp,
      updatedAt: input.timestamp
    };
  }

  private async startLiveSandbox(input: {
    task: PersistedAgentTask;
    run: SandboxRunState;
    signal?:AbortSignal;
  }): Promise<PersistedAgentTask|null> {
    input.signal?.throwIfAborted();
    const live = this.config.liveSandbox;
    const startupClaimToken=newId("startup_claim");
    const claimedAt=nowIso();
    const leaseExpiresAt=deadlineIso(claimedAt,120_000);
    const claimed=await this.store.claimSandboxStartup({
      taskId:input.task.id,
      runId:input.run.runId,
      expectedFencingToken:input.run.fencingToken,
      claimToken:startupClaimToken,
      claimedAt,
      leaseExpiresAt
    });
    if(claimed.kind==="not_ready"||claimed.kind==="in_progress")return null;
    if(claimed.kind==="stale")throw new ProductError("Sandbox startup was superseded by release",409,"sandbox_cleanup_intent_conflict");
    const endpoint=await this.endpoints.requireHealthyCredentialEndpoint(input.task.projectId,input.task.endpointId);
    requireTaskEndpointCapabilities(endpoint);
    const serviceKey=this.serviceKeyForTask(input.task);
    const brokerKey=this.brokerKeyForTask(input.task);
    await this.prepareLiveRuntimeDirectories(input.task, input.run.projectSubPath);
    let run=await this.store.sandboxRuns.get(input.run.runId);
    if(!run||!taskMatchesExactSandboxRun(input.task,run)||run.state!=="starting")throw new ProductError("Sandbox startup ownership changed",409,"sandbox_cleanup_intent_conflict");
    const config=generateBotifiedConfig({
      endpoint,
      task:{
        taskId:input.task.id,taskHomePath:BOTIFIED_TASK_HOME_PATH,botifiedDataPath:BOTIFIED_DATA_PATH,
        providerBaseUrl:this.botifiedBrokerBaseUrlForTask(input.task),servicePort:run.botifiedPort
      }
    });
    const serializedConfig=serializeBotifiedConfig(config);
    const configHash=runtimeConfigHash(serializedConfig);
    const configMapName=run.startupConfigMapName??sandboxRuntimeConfigMapName(run.resourceNames.configMap,configHash);
    const initialized=await this.store.initializeTaskSandboxStartupConfig({
      taskId:input.task.id,runId:run.runId,expectedFencingToken:run.fencingToken,
      startupClaimToken,configMapName,configHash,initializedAt:nowIso()
    });
    if(!initialized)throw new ProductError("Sandbox startup config identity changed",409,"sandbox_cleanup_intent_conflict");
    run=initialized;

    let finalPodIdentity:{podUid:string;podIp:string}|null=null;
    let podLabels:Record<string,string>|null=null;
    if(live){
      podLabels=sandboxIdentityLabels(run);
      let observed=await observeSandboxStartupIdentity(live,run,podLabels,input.signal);
      if(run.startupPodUid){
        if(!observed||observed.podUid!==run.startupPodUid){
          throw new ProductError("Recorded sandbox Pod is missing or was replaced",409,"sandbox_cleanup_intent_conflict");
        }
      }else{
        const observedResources=await live.port.listManagedResources(run.namespace);
        const actions=reconcileSandboxRuns({
          namespace:run.namespace,desiredRuns:[run],observedResources,now:new Date()
        });
        if(actions.errors.length>0)throw new ProductError(actions.errors[0]!,409,"sandbox_cleanup_intent_conflict");
        const materialized=materializeLiveCreateActions(actions.actions,{
          serviceKey,brokerKey,botifiedConfig:serializedConfig,agentInstructions:taskAgentInstructions(input.task)
        });
        if(materialized.some((action)=>action.type==="create_resource")){
          await this.runSandboxStartupAction(
            input.task,run,startupClaimToken,input.signal,
            (signal)=>applySandboxReconcileActionsToKubernetes(live.port,materialized,signal),
            async(signal)=>{
              const reread=await live.port.listManagedResources(run!.namespace);
              const convergence=reconcileSandboxRuns({
                namespace:run!.namespace,desiredRuns:[run!],observedResources:reread,now:new Date()
              });
              if(convergence.errors.length>0){
                throw new ProductError(convergence.errors[0]!,409,"sandbox_cleanup_intent_conflict");
              }
              return convergence.actions.some((action)=>action.type==="create_resource")
                ?{resolved:false as const}
                :{resolved:true as const,value:undefined};
            }
          );
        }
        observed=await observeSandboxStartupIdentity(live,run,podLabels,input.signal);
        if(!observed){
          throw new ProductError("Sandbox resources are incomplete after Kubernetes convergence",504,"sandbox_startup_unknown_result");
        }
        const recorded=await this.store.recordTaskSandboxStartupPod({
          taskId:input.task.id,runId:run.runId,expectedFencingToken:run.fencingToken,startupClaimToken,
          expectedConfigMapName:run.startupConfigMapName!,expectedConfigHash:run.startupConfigHash!,
          podUid:observed.podUid,podIp:observed.podIp??null,observedAt:nowIso()
        });
        if(!recorded)throw new ProductError("Sandbox pod identity changed before readiness",409,"sandbox_cleanup_intent_conflict");
        run=recorded;
      }

      const ready=await this.runSandboxStartupAction(
        input.task,run,startupClaimToken,input.signal,
        (signal)=>waitForPodReady(live,run!.namespace,run!.resourceNames.pod,podLabels!,run!.startupPodUid!,signal),
        async(signal)=>{
          const current=await observeSandboxStartupIdentity(live,run!,podLabels!,signal);
          return current?.podIp
            ?{resolved:true as const,value:{podUid:current.podUid,podIp:current.podIp}}
            :{resolved:false as const};
        }
      );
      const verified=await this.store.recordTaskSandboxStartupPod({
        taskId:input.task.id,runId:run.runId,expectedFencingToken:run.fencingToken,startupClaimToken,
        expectedConfigMapName:run.startupConfigMapName!,expectedConfigHash:run.startupConfigHash!,
        podUid:ready.podUid,podIp:ready.podIp,observedAt:nowIso()
      });
      if(!verified)throw new ProductError("Sandbox pod readiness identity changed",409,"sandbox_cleanup_intent_conflict");
      run=verified;
      finalPodIdentity=ready;
    }

    const open=await this.beginSandboxStartupExternalAction(input.task,run,startupClaimToken);
    try{
      await withHardDeadline(
        (signal)=>this.trackStartupExternalAction(run!.runId,(async()=>{
          if(live)await waitForBotifiedServiceReady(live,this.botified,this.botifiedBaseUrlForTask(input.task.id,run!.botifiedPort),signal);
          const runtime=await this.readRuntimeState(input.task,serviceKey,signal);
          await this.readVerifiedBotifiedState(input.task,runtime.baseUrl,serviceKey,signal);
          if(live&&podLabels){
            const reread=await observeSandboxStartupIdentity(live,run!,podLabels,signal,true);
            if(!reread||!reread.podIp)throw new ProductError("Sandbox identity changed before activation",409,"sandbox_cleanup_intent_conflict");
            finalPodIdentity={podUid:reread.podUid,podIp:reread.podIp};
          }
        })()),
        open.actionDeadlineAt,input.signal
      );
    }catch(error){
      if(
        error instanceof ProductError&&error.code!=="sandbox_startup_deadline_exceeded"&&
        !(error instanceof BotifiedTaskPortError&&error.retryable)
      )throw error;
      if(live&&podLabels){
        const reconciled=await observeSandboxStartupIdentity(live,run,podLabels,input.signal,true);
        if(!reconciled||reconciled.podUid!==run.startupPodUid){
          throw new ProductError("Sandbox startup result is unknown and identity no longer matches",409,"sandbox_cleanup_intent_conflict");
        }
      }
      await this.store.recoverSandboxStartupAction({
        taskId:input.task.id,runId:run.runId,expectedFencingToken:run.fencingToken,
        claimToken:startupClaimToken,actionDeadlineAt:open.actionDeadlineAt,recoveredAt:nowIso()
      });
      throw new ProductError("Botified startup open result is unknown",504,"sandbox_startup_unknown_result");
    }
    if(finalPodIdentity){
      const finalStored=await this.store.recordTaskSandboxStartupPod({
        taskId:input.task.id,runId:run.runId,expectedFencingToken:run.fencingToken,startupClaimToken,
        expectedConfigMapName:run.startupConfigMapName!,expectedConfigHash:run.startupConfigHash!,
        podUid:finalPodIdentity.podUid,podIp:finalPodIdentity.podIp,observedAt:nowIso()
      });
      if(!finalStored)throw new ProductError("Sandbox final identity changed before activation",409,"sandbox_cleanup_intent_conflict");
      run=finalStored;
    }
    const activatedAt=nowIso();
    const activated=await this.store.activateTaskSandboxRun({
      taskId:input.task.id,runId:run.runId,expectedFencingToken:run.fencingToken,
      startupClaimToken,actionDeadlineAt:open.actionDeadlineAt,
      expectedConfigMapName:run.startupConfigMapName??null,
      expectedConfigHash:run.startupConfigHash??null,
      expectedPodUid:finalPodIdentity?.podUid??null,
      expectedPodIp:finalPodIdentity?.podIp??null,
      activatedAt,
      auditEvent:{
        id:`audit_sandbox_started_${run.runId}`,projectId:run.projectId,actorId:null,
        subjectUserId:run.startedByUserId,action:"sandbox.started",status:"accepted",
        resourceKind:"sandbox",resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId},createdAt:activatedAt
      }
    });
    if(activated.kind==="conflict")throw new ProductError("Sandbox run state fencing token changed before activation",409);
    return activated.task;
  }

  private async beginSandboxStartupExternalAction(task:PersistedAgentTask,run:PersistedSandboxRunState,claimToken:string):Promise<{actionDeadlineAt:string}>{
    const startedAt=nowIso();
    const actionDeadlineAt=deadlineIso(startedAt,resolveDurationMs(this.config.liveSandbox?.startupActionTimeoutMs,120_000));
    if(!await this.store.beginSandboxStartupAction({
      taskId:task.id,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken,actionDeadlineAt,startedAt
    }))throw new ProductError("Sandbox startup action ownership changed",409,"sandbox_cleanup_intent_conflict");
    return{actionDeadlineAt};
  }

  private async completeSandboxStartupExternalAction(task:PersistedAgentTask,run:PersistedSandboxRunState,claimToken:string,actionDeadlineAt:string):Promise<void>{
    const completedAt=nowIso();
    if(!await this.store.completeSandboxStartupAction({
      taskId:task.id,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken,actionDeadlineAt,completedAt,leaseExpiresAt:deadlineIso(completedAt,120_000)
    }))throw new ProductError("Sandbox startup action ownership changed",409,"sandbox_cleanup_intent_conflict");
  }

  private async runSandboxStartupAction<T>(
    task:PersistedAgentTask,
    run:PersistedSandboxRunState,
    claimToken:string,
    parentSignal:AbortSignal|undefined,
    action:(signal:AbortSignal)=>Promise<T>,
    reconcileUnknown?:(signal:AbortSignal)=>Promise<{resolved:false}|{resolved:true;value:T}>
  ):Promise<T>{
    const {actionDeadlineAt}=await this.beginSandboxStartupExternalAction(task,run,claimToken);
    let value:T;
    try{
      value=await withHardDeadline(
        (signal)=>this.trackStartupExternalAction(run.runId,action(signal)),
        actionDeadlineAt,parentSignal
      );
    }catch(error){
      if(error instanceof ProductError&&error.code!=="sandbox_startup_deadline_exceeded")throw error;
      if(error instanceof Error&&/fence mismatch/.test(error.message)){
        throw new ProductError("Sandbox startup resource fence mismatch",409,"sandbox_cleanup_intent_conflict");
      }
      if(reconcileUnknown){
        parentSignal?.throwIfAborted();
        const signal=parentSignal??new AbortController().signal;
        const reconciled=await reconcileUnknown(signal);
        if(reconciled.resolved){
          await this.completeSandboxStartupExternalAction(task,run,claimToken,actionDeadlineAt);
          return reconciled.value;
        }
      }
      const recoveredAt=nowIso();
      await this.store.recoverSandboxStartupAction({
        taskId:task.id,runId:run.runId,expectedFencingToken:run.fencingToken,
        claimToken,actionDeadlineAt,recoveredAt
      });
      throw new ProductError("Kubernetes startup mutation result is unknown",504,"sandbox_startup_unknown_result");
    }
    await this.completeSandboxStartupExternalAction(task,run,claimToken,actionDeadlineAt);
    return value;
  }

  private trackStartupExternalAction<T>(runId:string,operation:Promise<T>):Promise<T>{
    this.startupExternalActionsByRunId.set(runId,operation);
    void operation.finally(()=>{
      if(this.startupExternalActionsByRunId.get(runId)===operation)this.startupExternalActionsByRunId.delete(runId);
    }).catch(()=>undefined);
    return operation;
  }

  private async prepareLiveRuntimeDirectories(task: PersistedAgentTask, projectRootPath: string): Promise<void> {
    const dataRoot = path.resolve(this.config.dataRoot);
    const taskRoot = path.resolve(dataRoot, projectRootPath, "tasks", task.id);
    assertPathInside(dataRoot, taskRoot, "Task runtime directory is outside the data root");
    const runnerWritableDirectories = [path.resolve(taskRoot, "botified")];
    for (const directory of runnerWritableDirectories) {
      assertPathInside(dataRoot, directory, "Task runtime directory is outside the data root");
    }
    for (const directory of runnerWritableDirectories) {
      await prepareRunnerWritableDirectory(directory);
    }
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

  private async persistStartingRunFailureOrAdopt(
    task: PersistedAgentTask,
    runId: string,
    operation: string,
    error: unknown
  ): Promise<PersistedAgentTask|null> {
    const current=await this.store.sandboxRuns.get(runId);
    if(current&&taskMatchesExactSandboxRun(task,current)&&current.state==="active"){
      const currentTask=await this.store.findTask(task.id);
      return currentTask&&taskAllowsActivatedRunAdoption(currentTask,current)?currentTask:null;
    }
    if(!current||!taskMatchesExactSandboxRun(task,current)||current.state!=="starting")return null;
    console.error(`Sandbox ${runId} ${operation} failed: ${redactSecretLikeText(error instanceof Error?error.message:String(error))}`);
    const failureAt=nowIso();
    const terminalOperation=await this.store.findInProgressTerminalStartOperation(runId);
    if(terminalOperation){
      if(terminalOperation.projectId!==current.projectId||terminalOperation.resourceId!==runId||!current.startupClaimToken){
        throw new ProductError("Terminal startup failure ownership is unavailable",409,"task_sandbox_restart_conflict");
      }
      const projectedFailedRun=this.projectStartupFailedRun(current,failureAt);
      const presentation=await this.taskPresentation(terminalOperation.actorId,task,{run:projectedFailedRun,turn:"ready",reachability:"unreachable"});
      const envelope=sandboxStartFailedErrorEnvelope(presentation);
      const terminalized=await this.store.failTaskSandboxStartupAtomically({
        taskId:task.id,
        startupClaimToken:current.startupClaimToken,
        resourceIdentity:current.resourceNames,
        failure:{
          runId,
          expectedFencingToken:current.fencingToken,
          code:"startup_failed",
          message:"Sandbox startup did not complete. Retry release to remove its resources.",
          failedAt:failureAt,
          auditEvent:{id:`audit_sandbox_failed_${runId}`,projectId:current.projectId,actorId:null,subjectUserId:current.startedByUserId,action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:current.taskId,detail:{taskId:current.taskId,runId,endpointId:task.endpointId},createdAt:failureAt}
        },
        idempotency:{
          ...terminalOperation,
          responseStatus:502,
          responseBody:{outcome:"completed",keyDisposition:"retire",runId,error:envelope.error},
          updatedAt:failureAt
        }
      });
      if(terminalized.kind==="conflict")throw new ProductError("Terminal startup failure could not be committed",409,"task_sandbox_restart_conflict");
      if(terminalized.kind==="failed")await this.refreshSandboxFailureAlerts(current.projectId,task.endpointId);
      return null;
    }
    const failed=await this.store.failSandboxRun({
      runId,
      expectedFencingToken:current.fencingToken,
      ...(current.startupClaimToken?{startupClaimToken:current.startupClaimToken}:{}),
      code:"startup_failed",
      message:"Sandbox startup did not complete. Retry release to remove its resources.",
      failedAt:failureAt,
      auditEvent:{id:`audit_sandbox_failed_${runId}`,projectId:current.projectId,actorId:null,subjectUserId:current.startedByUserId,action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:current.taskId,detail:{taskId:current.taskId,runId,endpointId:task.endpointId},createdAt:failureAt}
    });
    if(failed)await this.refreshSandboxFailureAlerts(current.projectId,task.endpointId);
    return null;
  }

  private async persistRuntimeIdentityFailure(
    task:PersistedAgentTask,
    operation:string,
    error:unknown
  ):Promise<void>{
    const runId=requireCurrentRunId(task);
    const current=await this.store.sandboxRuns.get(runId);
    if(!current||!taskMatchesExactSandboxRun(task,current)||current.state!=="active")return;
    console.error(`Sandbox ${runId} ${operation} failed: ${redactSecretLikeText(error instanceof Error?error.message:String(error))}`);
    const failureAt=nowIso();
    const failed=await this.store.failSandboxRun({
      runId,
      expectedFencingToken:current.fencingToken,
      code:"runtime_unreachable",
      message:"The sandbox runtime became unavailable. Retry release to remove its resources.",
      failedAt:failureAt,
      auditEvent:{id:`audit_sandbox_failed_${runId}`,projectId:current.projectId,actorId:null,subjectUserId:current.startedByUserId,action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:current.taskId,detail:{taskId:current.taskId,runId,endpointId:task.endpointId},createdAt:failureAt}
    });
    if(failed)await this.refreshSandboxFailureAlerts(current.projectId,task.endpointId);
  }

  private async ensureTaskConversation(task: PersistedAgentTask): Promise<void> {
    if (!await this.taskExecutionEligible(task)) return;
    for(const message of await this.store.listTaskMessages(task.id))await this.persistMessageInteraction(message);
    if(await this.activeSandboxRun(task))await this.bestEffortSyncTaskTimeline(task);
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
      const message = inputId ? messages.find((candidate) => candidate.id === inputId) : undefined;
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

  private async replayTaskCreate(
    userId:string,
    access:ProjectAccessSnapshot,
    replay:Extract<Awaited<ReturnType<ProductStore["findTaskIdempotency"]>>,{kind:"replay"}>
  ):Promise<TaskPresentation>{
    if(replay.responseStatus>=400)return replayTaskOperationResponse<TaskPresentation>(replay.responseStatus,replay.responseBody);
    const task=await this.store.findTask(replay.resourceId);
    if(!task||task.projectId!==access.project.id)throw invalidTaskCreateIdempotencyError();
    requireMatchingTaskCreateReceipt(replay,task,userId,access.project.id);
    return this.taskPresentation(userId,task,{projectAccess:access});
  }

  private async replayTaskMessage(
    userId:string,
    authorizedTask:PersistedAgentTask,
    replay:Extract<Awaited<ReturnType<ProductStore["beginTaskIdempotency"]>>,{kind:"replay"}>
  ):Promise<TaskMessageReceipt>{
    if(replay.responseStatus>=400){
      return replayTaskOperationResponse<TaskMessageReceipt>(replay.responseStatus,replay.responseBody);
    }
    const envelope=requireTaskMessageIdempotencyEnvelope(replay.responseBody);
    if(envelope.messageId!==replay.resourceId||envelope.taskId!==authorizedTask.id||envelope.projectId!==authorizedTask.projectId||envelope.actorId!==userId)throw invalidTaskMessageIdempotencyError();
    const message=await this.store.findTaskMessage(replay.resourceId);
    if(!message||message.id!==envelope.messageId||message.taskId!==envelope.taskId||message.actorId!==envelope.actorId)throw invalidTaskMessageIdempotencyError();
    const canonicalTask=await this.store.findTask(message.taskId);
    if(!canonicalTask||canonicalTask.id!==authorizedTask.id||canonicalTask.projectId!==envelope.projectId)throw invalidTaskMessageIdempotencyError();
    return structuredClone(envelope.receipt);
  }

  private async messageReceipt(userId: string, message: PersistedTaskMessage, duplicate: boolean): Promise<TaskMessageReceipt> {
    const task = await this.store.findTask(message.taskId);
    if (!task) throw new ProductError("Task not found", 404);
    const queued = await this.store.listTaskMessages(message.taskId);
    const interaction = await this.latestMessageInteraction(message);
    return this.messageReceiptFromState(userId,task,message,duplicate,queued,interaction);
  }

  private async messageReceiptFromState(userId:string,task:PersistedAgentTask,message:PersistedTaskMessage,duplicate:boolean,queued:PersistedTaskMessage[],interaction:TaskInteractionItem|null,run?:PersistedSandboxRunState):Promise<TaskMessageReceipt>{
    const presentedInteraction=interaction?(await this.presentTaskInteractions(userId,task.projectId,[interaction]))[0]!:interaction;
    const disposition = messageDisposition(message, interaction);
    return {
      messageId: message.id,
      disposition,
      duplicate,
      queuedMessage: isQueuedMessage(message) ? queuedMessage(message) : null,
      interaction: disposition === "queued_for_active_run" ? null : presentedInteraction?.kind === "user_message" ? presentedInteraction : null,
      presentation: await this.taskPresentation(userId,task,{queued,...(run?{run}:{})}),
      ...(disposition === "failed" ? { safeError:safeMessageFailure(message.safeError) } : {})
    };
  }

  private async presentTaskInteractions(userId:string,projectId:string,items:TaskInteractionItem[]):Promise<TaskInteractionItem[]>{
    const actorIds=[...new Set(items.flatMap((item)=>item.kind==="user_message"&&item.actorId?[item.actorId]:[]))];
    if(actorIds.length===0)return items;
    const members=await this.store.findProjectMembershipIdentities(projectId,actorIds);
    const labels=new Map(members.map((member)=>[member.userId,member.displayName?.trim()||member.email||"Project member"]));
    return items.map((item)=>item.kind!=="user_message"||!item.actorId?item:{...item,title:item.actorId===userId?"You":labels.get(item.actorId)??"Project member"});
  }

  private async latestMessageInteraction(message: PersistedTaskMessage): Promise<TaskInteractionItem | null> {
    const task = await this.store.findTask(message.taskId);
    if (!task) return null;
    const seeded = projectTaskInteraction(messageProductSource(message), null, await this.interactionRedaction(task)).interaction;
    if (!seeded) return null;
    return (await this.store.findLatestTaskInteractionChange(message.taskId,seeded.id))?.interaction??null;
  }

  private async completeMessageIdempotency(message: PersistedTaskMessage): Promise<void> {
    const task=await this.store.findTask(message.taskId);
    if(!task||!message.actorId)return;
    const receipt=await this.messageReceipt(message.actorId,message,false);
    await this.store.completeTaskIdempotencyForResource({
      projectId:task.projectId,
      operation:taskOperation("message"),
      resourceId:message.id,
      responseStatus:200,
      responseBody:taskMessageIdempotencyEnvelope(message,task,message.actorId,receipt),
      updatedAt:nowIso()
    });
  }

  private async taskInteractionState(
    userId: string,
    task: PersistedAgentTask,
    snapshot: { queuedMessages: PersistedTaskMessage[]; historyStatus: TaskHistoryStatus; lastSyncedAt: string | null }
  ): Promise<TaskInteractionState> {
    const run=task.currentRunId?await this.store.sandboxRuns.get(task.currentRunId):null;
    const runtime=await this.taskRuntimePresentation(task,run);
    const presentation=await this.taskPresentation(userId,task,{queued:snapshot.queuedMessages,run,...runtime});
    const capabilities=presentation.capabilities;
    return {
      queuedMessages: snapshot.queuedMessages.map((message) => {
        const presented = queuedMessage(message);
        return { ...presented, editable:capabilities.editQueuedMessage&&presented.editable, deletable:capabilities.sendMessage&&presented.deletable };
      }),
      runtimeReachability: runtime.reachability,
      historyStatus: snapshot.historyStatus,
      lastSyncedAt: snapshot.lastSyncedAt,
      presentation
    };
  }

  private async taskRuntimePresentation(task:PersistedAgentTask,knownRun?:PersistedSandboxRunState|null):Promise<{turn:TaskCurrentTurnProjection["state"];reachability:TaskRuntimeReachability}>{
    const run=knownRun===undefined?(task.currentRunId?await this.store.sandboxRuns.get(task.currentRunId):null):knownRun;
    if(!run||run.taskId!==task.id||run.state==="released")return{turn:"ready",reachability:"unreachable"};
    if(run.state==="starting")return{turn:"starting",reachability:"unknown"};
    if(run.state!=="active")return{turn:"ready",reachability:"unreachable"};
    try {
      const serviceKey = this.serviceKeyForTask(task);
      const runtime = await this.readRuntimeState(task, serviceKey);
      const state = await this.readVerifiedBotifiedState(task,runtime.baseUrl,serviceKey);
      const turn=botifiedTaskTurnState(state.state);
      return{turn,reachability:"reachable"};
    } catch {
      return{turn:"starting",reachability:"unreachable"};
    }
  }

  private async taskPresentation(
    userId:string,
    task:PersistedAgentTask,
    known:{
      run?:PersistedSandboxRunState|null;
      turn?:TaskCurrentTurnProjection["state"];
      reachability?:TaskRuntimeReachability;
      queued?:PersistedTaskMessage[];
      projectAccess?:ProjectAccessSnapshot;
    }={}
  ):Promise<TaskPresentation>{
    const loadedRun=known.run!==undefined?known.run:(task.currentRunId?await this.store.sandboxRuns.get(task.currentRunId):null);
    const run=loadedRun&&taskMatchesExactSandboxRun(task,loadedRun)?loadedRun:null;
    const unavailableRunId=task.currentRunId&&!run?task.currentRunId:null;
    const queued=known.queued??await this.store.listTaskMessages(task.id);
    const runtime=known.turn!==undefined
      ?{turn:known.turn,reachability:known.reachability??(run?.state==="active"?"reachable":"unreachable")}
      :await this.taskRuntimePresentation(task,run);
    const turn=unavailableRunId
      ?"ready"
      :runtime.turn==="ready"&&await this.hasQueuedTurnMessage(task.id,queued)?"queued":runtime.turn;
    const state=projectTaskState({archivedAt:task.archivedAt,run,unavailableRunId,turn});
    const [projectAccess,executionEligible]=await Promise.all([
      known.projectAccess??this.workspaces.projectAccessForUser(userId,task.projectId),
      this.taskExecutionEligible(task)
    ]);
    const canWrite = projectAccess.canWrite && projectAccess.writableLifecycle;
    const retained = !task.deletedAt && !task.archivedAt;
    const releaseConfirmed=!task.currentRunId||Boolean(run&&run.state==="released");
    const cleanupPending=run?.state==="release_requested"||run?.state==="failed";
    const runtimeUsable=run?.state==="released"||run?.state==="starting"||(run?.state==="active"&&runtime.reachability==="reachable");
    const canInteract=canWrite&&retained&&executionEligible&&!cleanupPending&&Boolean(runtimeUsable);
    const canStartNewWork=canWrite&&retained&&executionEligible;
    const canControlCurrentWork=canWrite&&retained&&run?.state==="active"&&runtime.reachability==="reachable";
    const capabilities:TaskCapabilities = unavailableRunId ? {
      sendMessage:false,editQueuedMessage:false,abortTurn:false,openTerminal:false,
      releaseSandbox:false,editTask:false,archiveTask:false,deleteTask:false
    } : cleanupPending ? {
      sendMessage:false,editQueuedMessage:false,abortTurn:false,openTerminal:false,
      releaseSandbox:canWrite&&!task.deletedAt,editTask:false,archiveTask:false,deleteTask:false
    } : {
      sendMessage: canInteract,
      editQueuedMessage: canInteract && queued.some((message) => (message.deliveryStatus ?? "pending") === "pending" && !message.deletedAt),
      abortTurn:canControlCurrentWork&&runtime.turn==="running",
      openTerminal: !cleanupPending&&(
        canStartNewWork&&(releaseConfirmed||run?.state==="starting")||
        canControlCurrentWork
      ),
      editTask: canWrite && retained,
      releaseSandbox: canWrite && !task.deletedAt && Boolean(run&&run.state!=="released"),
      archiveTask: canWrite && retained && releaseConfirmed,
      deleteTask: canWrite && !task.deletedAt && releaseConfirmed
    };
    return{task:publicTask(task),...state,capabilities};
  }

  private async taskExecutionEligible(task: PersistedAgentTask): Promise<boolean> {
    if (task.deletedAt || task.archivedAt) return false;
    try {
      const endpoint = await this.endpoints.requireHealthyCredentialEndpoint(task.projectId, task.endpointId);
      return !TASK_ENDPOINT_CAPABILITIES.some((capability) => !endpoint.capabilities.includes(capability));
    } catch {
      return false;
    }
  }

  private async activeSandboxRun(task:PersistedAgentTask):Promise<PersistedSandboxRunState|null>{
    const run=task.currentRunId?await this.store.sandboxRuns.get(task.currentRunId):null;
    return run&&run.taskId===task.id&&["starting","active"].includes(run.state)?run:null;
  }

  private async hasQueuedTurnMessage(taskId:string,messages?:PersistedTaskMessage[]):Promise<boolean>{
    for(const message of messages??await this.store.listTaskMessages(taskId)){
      if(message.deletedAt||message.deliveryStatus==="failed")continue;
      if(message.deliveryStatus==="pending"||message.deliveryStatus==="dispatching")return true;
      if(message.deliveryStatus==="accepted"){
        const interaction=await this.latestMessageInteraction(message);
        if(interaction?.kind==="user_message"&&interaction.status==="queued")return true;
      }
    }
    return false;
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

  private async interactionRedaction(task: PersistedAgentTask, serviceKey?: string): Promise<InteractionTextRedactionOptions> {
    const endpoint = await this.endpoints.requireEndpointForProject(task.projectId, task.endpointId);
    const credential = this.config.credentials ? await this.config.credentials.resolve(task.projectId, endpoint.credentialId) : null;
    const knownSecrets = new Set<string>(credential ? [credential.apiKey] : []);
    const run = task.currentRunId ? await this.store.sandboxRuns.get(task.currentRunId) : null;
    if (
      run?.runId === task.currentRunId &&
      run.taskId === task.id &&
      run.workspaceId === task.workspaceId &&
      run.projectId === task.projectId &&
      run.fileLibraryId === task.fileLibraryId
    ) {
      knownSecrets.add(serviceKey ?? this.serviceKeyForTask(task));
    }
    return { knownSecrets };
  }


  private liveSandboxNamespaceLimit(): number {
    const value=this.config.sandboxNamespaceLimit;
    if(typeof value!=="number"||!Number.isSafeInteger(value)||value<1)throw new ProductError("sandbox.namespaceLimit must be configured as a positive integer",500);
    return value;
  }

  private sandboxAdmission():{namespace:string;namespaceLimit:number}{
    return{namespace:this.config.namespace,namespaceLimit:this.liveSandboxNamespaceLimit()};
  }

  private releasedSandboxAdmission():{namespace:string;namespaceLimit:number}{
    return{namespace:this.config.namespace,namespaceLimit:1};
  }

  private async refreshSandboxCapacityAlerts(projectId:string):Promise<void>{
    try{await this.policies.refreshSandboxCapacityAlerts(projectId);}
    catch(error){console.error(`Sandbox capacity alert refresh failed: ${redactSecretLikeText(error instanceof Error?error.message:String(error))}`);}
  }

  private async bestEffortRecordProjectSandboxCapacityRejected(projectId:string):Promise<void>{
    try{await this.policies.recordProjectSandboxCapacityRejected(projectId);}
    catch(error){console.error(`Project Sandbox capacity alert failed: ${redactSecretLikeText(error instanceof Error?error.message:String(error))}`);}
  }

  private async refreshSandboxFailureAlerts(projectId:string,endpointId?:string):Promise<void>{
    try{await this.policies.refreshSandboxFailureAlerts(projectId,endpointId);}
    catch(error){console.error(`Sandbox failure alert refresh failed: ${redactSecretLikeText(error instanceof Error?error.message:String(error))}`);}
  }

}

function taskOperationErrorBody(error:ProductError):unknown{
  return error instanceof SandboxRetryableProductError
    ?error.envelope
    :{error:error.message,...(error.code?{code:error.code}:{})};
}

function replayTaskOperationResponse<T>(statusCode:number,responseBody:unknown):T{
  if(statusCode<400)return structuredClone(responseBody) as T;
  const envelope=sandboxRetryableEnvelope(responseBody);
  if(envelope)throw new SandboxRetryableProductError(statusCode,envelope);
  const record=isUnknownRecord(responseBody)?responseBody:{};
  throw new ProvenTaskCommandRejectionError(new ProductError(
    typeof record.error==="string"?record.error:"Task operation failed",
    statusCode,
    typeof record.code==="string"?record.code:undefined
  ));
}

function replayTaskCommandOutcome<T>(statusCode:number,responseBody:unknown):T{
  if(isUnknownRecord(responseBody)&&responseBody.outcome==="rejected_before_acceptance"){
    return replayTaskOperationResponse<T>(statusCode,responseBody);
  }
  if(isUnknownRecord(responseBody)&&["accepted_in_progress","completed"].includes(String(responseBody.outcome))){
    return structuredClone(responseBody) as T;
  }
  return replayTaskOperationResponse<T>(statusCode,responseBody);
}

function releaseAcceptedReceipt(taskId:string,runId:string):Extract<TaskSandboxReleaseReceipt,{outcome:"accepted_in_progress"}>{
  return{outcome:"accepted_in_progress",keyDisposition:"retain",taskId,runId};
}

function releaseCompletedReceipt(taskId:string,runId:string):Extract<TaskSandboxReleaseReceipt,{outcome:"completed"}>{
  return{outcome:"completed",keyDisposition:"retire",taskId,runId};
}

function sandboxRetryableEnvelope(value:unknown):SandboxRetryableErrorEnvelope|null{
  if(!isUnknownRecord(value)||!isUnknownRecord(value.error))return null;
  const error=value.error;
  if(!["project_sandbox_capacity_reached","substrate_sandbox_capacity_reached","sandbox_start_failed"].includes(typeof error.code==="string"?error.code:""))return null;
  if(typeof error.message!=="string"||error.retryable!==true||!("details" in error)||!("presentation" in error))return null;
  return value as unknown as SandboxRetryableErrorEnvelope;
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
    fileLibraryId:task.fileLibraryId!,
    ...(task.title !== undefined ? { title:task.title } : {}),
    prompt:task.prompt,
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

function normalizeIdempotencyKey(value:string|undefined):string{
  if(value===undefined)return newId("internal_idempotency");
  const key=value.trim();if(!key)throw new ProductError("Idempotency-Key is required",400);if(key.length>200)throw new ProductError("Idempotency-Key must be at most 200 characters",400);return key;
}

function canonicalRequestHash(value:unknown):string{return createHash("sha256").update(canonicalJson(value),"utf8").digest("base64url");}
function runtimeConfigHash(value:string):string{return`sha256:${createHash("sha256").update(value,"utf8").digest("hex")}`;}
function canonicalJson(value:unknown):string{
  if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
  if(typeof value==="number"){if(!Number.isFinite(value))throw new ProductError("Task request contains a non-finite number",400);return JSON.stringify(value);}
  if(Array.isArray(value))return`[${value.map(canonicalJson).join(",")}]`;
  if(isUnknownRecord(value))return`{${Object.keys(value).sort().filter((key)=>value[key]!==undefined).map((key)=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new ProductError("Task request cannot be canonically hashed",400);
}

function isUnknownRecord(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value);}

function idempotencyInProgressError():ProductError {
  return new ProductError("Idempotent task operation is still in progress",409,"idempotency_in_progress");
}

function idempotencyPayloadMismatchError():ProductError {
  return new ProductError(
    "Idempotency-Key was already used with a different request",
    409,
    "idempotency_payload_mismatch"
  );
}

function taskRunTargetConflictError():ProductError {
  return new ProductError(
    "Task Sandbox Run changed; refresh before retrying this action",
    409,
    "task_run_target_conflict"
  );
}

function provenTaskCommandRejection(error:ProductError):ProductError {
  return error instanceof SandboxRetryableProductError||error instanceof ProvenTaskCommandRejectionError
    ?error
    :new ProvenTaskCommandRejectionError(error);
}

function isTerminalizablePreAdmissionRejection(error:unknown):error is ProductError {
  return error instanceof ProductError&&
    !(error instanceof ReceiptUncertaintyError)&&
    error.code!=="idempotency_in_progress"&&
    error.code!=="idempotency_payload_mismatch";
}

function taskCreateAdmissionError(
  kind:"project_unavailable"|"library_name_conflict"|"library_not_found"|"library_deleting"|"already_bound"
):ProductError {
  if(kind==="project_unavailable")return new ProductError("Project is not active",409,"project_not_active");
  if(kind==="library_not_found")return new ProductError("File Library not found",404,"file_library_not_found");
  if(kind==="library_deleting")return new ProductError("File Library deletion is in progress",409,"file_library_deleting");
  if(kind==="already_bound")return new ProductError("File Library is already bound to a Task",409,"file_library_already_bound");
  return new ProductError("File Library name already exists",409,"file_library_name_conflict");
}

function invalidTaskMessageIdempotencyError():ProductError {
  return new ReceiptUncertaintyError("Task message idempotency record is invalid","task_message_idempotency_invalid");
}

function invalidTaskCreateIdempotencyError():ProductError {
  return new ReceiptUncertaintyError("Task create idempotency record is invalid","task_create_idempotency_invalid");
}

function taskCreateIdempotencyEnvelope(task:PersistedAgentTask,actorId:string):TaskCreateIdempotencyEnvelope {
  return{kind:"task_create",taskId:task.id,projectId:task.projectId,actorId};
}

function isTaskCreateIdempotencyEnvelope(value:unknown):value is TaskCreateIdempotencyEnvelope {
  return isUnknownRecord(value)&&
    hasExactKeys(value,["actorId","kind","projectId","taskId"])&&
    value.kind==="task_create"&&
    typeof value.taskId==="string"&&
    typeof value.projectId==="string"&&
    typeof value.actorId==="string";
}

function requireMatchingTaskCreateReceipt(
  replay:Extract<Awaited<ReturnType<ProductStore["findTaskIdempotency"]>>,{kind:"replay"}>,
  task:PersistedAgentTask,
  actorId:string,
  projectId:string
):void{
  if(replay.responseStatus!==200)throw new Error("Task preparation receipt is not a successful admission");
  if(replay.resourceId!==task.id||task.projectId!==projectId)throw invalidTaskCreateIdempotencyError();
  if(isTaskCreateIdempotencyEnvelope(replay.responseBody)){
    if(
      replay.responseBody.taskId!==task.id||
      replay.responseBody.projectId!==projectId||
      replay.responseBody.actorId!==actorId
    )throw invalidTaskCreateIdempotencyError();
    return;
  }
  requireLegacyTaskCreatePresentation(replay.responseBody,task,projectId);
}

function requireLegacyTaskCreatePresentation(value:unknown,task:PersistedAgentTask,projectId:string):void{
  value=normalizeHistoricalTaskCreatePresentation(value);
  if(!isUnknownRecord(value)||!hasExactKeys(value,["capabilities","currentTurn","lifecycle","sandboxState","task"])){
    throw invalidTaskCreateIdempotencyError();
  }
  const presentedTask=value.task;
  const lifecycle=value.lifecycle;
  const currentTurn=value.currentTurn;
  const sandboxState=value.sandboxState;
  const capabilities=value.capabilities;
  if(
    !isUnknownRecord(presentedTask)||
    !hasExactKeys(presentedTask,[
      "createdAt","endpointId","fileLibraryId","id","projectId","prompt","updatedAt","workspaceId",
      ...("title" in presentedTask?["title"]:[])
    ])||
    !["createdAt","endpointId","fileLibraryId","id","projectId","prompt","updatedAt","workspaceId"].every(
      (key)=>typeof presentedTask[key]==="string"
    )||
    ("title" in presentedTask&&typeof presentedTask.title!=="string")||
    presentedTask.id!==task.id||
    presentedTask.projectId!==projectId||
    presentedTask.workspaceId!==task.workspaceId||
    presentedTask.endpointId!==task.endpointId||
    presentedTask.fileLibraryId!==task.fileLibraryId||
    presentedTask.prompt!==task.prompt||
    presentedTask.createdAt!==task.createdAt
  )throw invalidTaskCreateIdempotencyError();
  if(
    !isUnknownRecord(lifecycle)||
    !hasExactKeys(lifecycle,["state"])||
    !["active","archived"].includes(String(lifecycle.state))||
    !isUnknownRecord(currentTurn)||
    !hasExactKeys(currentTurn,["state"])||
    !["ready","starting","queued","running","aborting"].includes(String(currentTurn.state))||
    !isUnknownRecord(sandboxState)||
    !hasExactKeys(sandboxState,["cause","runId","state"])||
    !["starting","active","release_requested","released","failed"].includes(String(sandboxState.state))||
    !(sandboxState.runId===null||typeof sandboxState.runId==="string")||
    !validLegacySandboxCause(sandboxState.cause)||
    !isUnknownRecord(capabilities)||
    !hasExactKeys(capabilities,[
      "abortTurn","archiveTask","deleteTask","editQueuedMessage","editTask","openTerminal",
      "releaseSandbox","sendMessage"
    ])||
    !Object.values(capabilities).every((candidate)=>typeof candidate==="boolean")
  )throw invalidTaskCreateIdempotencyError();
}

function normalizeHistoricalTaskCreatePresentation(value:unknown):unknown{
  if(!isUnknownRecord(value)||!isUnknownRecord(value.currentTurn)||!("turnId" in value.currentTurn))return value;
  if(value.currentTurn.turnId!==null&&typeof value.currentTurn.turnId!=="string")return value;
  const {turnId:_,...currentTurn}=value.currentTurn;
  return{...value,currentTurn};
}

function validLegacySandboxCause(value:unknown):boolean{
  return value===null||(
    isUnknownRecord(value)&&
    hasExactKeys(value,["code","message"])&&
    ["startup_failed","runtime_unreachable","runner_failed","cleanup_failed"].includes(String(value.code))&&
    typeof value.message==="string"
  );
}

function hasExactKeys(value:Record<string,unknown>,keys:string[]):boolean{
  return Object.keys(value).sort().join(",")===[...keys].sort().join(",");
}

function taskMessageIdempotencyEnvelope(message:PersistedTaskMessage,task:PersistedAgentTask,actorId:string,receipt:TaskMessageReceipt):TaskMessageIdempotencyEnvelope {
  if(message.taskId!==task.id||message.actorId!==actorId)throw invalidTaskMessageIdempotencyError();
  if(receipt.messageId!==message.id)throw invalidTaskMessageIdempotencyError();
  return{kind:"task_message",messageId:message.id,taskId:task.id,projectId:task.projectId,actorId,receipt:structuredClone(receipt)};
}

function requireTaskMessageIdempotencyEnvelope(value:unknown):TaskMessageIdempotencyEnvelope {
  if(!isUnknownRecord(value)||Object.keys(value).sort().join(",")!=="actorId,kind,messageId,projectId,receipt,taskId"||value.kind!=="task_message"||typeof value.messageId!=="string"||typeof value.taskId!=="string"||typeof value.projectId!=="string"||typeof value.actorId!=="string"||!isUnknownRecord(value.receipt)||value.receipt.messageId!==value.messageId)throw invalidTaskMessageIdempotencyError();
  return value as unknown as TaskMessageIdempotencyEnvelope;
}

function safeTaskStageError(error:unknown):string{return redactSecretLikeText(error instanceof Error?error.message:"Task maintenance failed").slice(0,300);}

function taskOperation(value: "message" | "message-edit" | "message-delete"): TaskIdempotencyOperation {
  return value as TaskIdempotencyOperation;
}

function isMessageReceiptOperation(operation: TaskIdempotencyOperation): boolean {
  return ["message", "message-edit", "message-delete"].includes(String(operation));
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
  const projectedStatus = status === "accepted" ? "accepted"
    : status === "failed" ? "failed"
      : status === "dispatching" ? "dispatching" : "pending";
  return {
    sourceKind: "product",
    type: "message_delivery",
    actorId: message.actorId ?? null,
    taskId: message.taskId,
    sourceId: `message:${message.id}`,
    sourceRevision: productSourceRevision(updatedAt, { pending:1, dispatching:2, accepted:3, failed:4 }[projectedStatus]),
    occurredAt: updatedAt,
    position: productPosition(message.createdAt, message.id),
    messageId: message.id,
    content: message.content,
    status: projectedStatus
  };
}

function queuedMessage(message: PersistedTaskMessage): TaskQueuedMessage {
  const status = message.deliveryStatus ?? "pending";
  const deliveryStatus: TaskQueuedMessage["deliveryStatus"] = status === "accepted" ? "failed" : status;
  return {
    id: message.id,
    content: message.content,
    deliveryStatus,
    editable: status === "pending" && !message.deletedAt,
    deletable: (status === "pending" || status === "failed") && !message.deletedAt,
    ...(status === "failed" && message.safeError ? { safeError:safeMessageFailure(message.safeError) } : {}),
    updatedAt: message.updatedAt ?? message.createdAt
  };
}

function isQueuedMessage(message: PersistedTaskMessage): boolean {
  return ["pending", "dispatching", "failed"].includes(message.deliveryStatus ?? "pending") && !message.deletedAt;
}

function isSettledMessage(message: PersistedTaskMessage): boolean {
  return ["accepted", "failed"].includes(message.deliveryStatus ?? "");
}

function messageDisposition(message: PersistedTaskMessage, interaction: TaskInteractionItem | null): TaskMessageReceipt["disposition"] {
  switch (message.deliveryStatus) {
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

type TaskListCursorScope = {
  search: string;
  archived: NonNullable<TaskListQuery["archived"]>;
  sort: NonNullable<TaskListQuery["sort"]>;
  direction: NonNullable<TaskListQuery["direction"]>;
};

type TaskListCursorAfter={value:string;taskId:string};
type TaskArtifactCursorFilter={kind:TaskArtifactKind|null;mediaType:string|null;previewOnly:boolean};
type TaskArtifactCursorAfter={createdAt:string;artifactId:string};

function taskListSortValue(task:PersistedAgentTask,sort:TaskListCursorScope["sort"]):string{
  return sort==="created_at"?task.createdAt:sort==="updated_at"?task.updatedAt:task.title??"";
}

function encodeTaskListCursor(projectId:string,scope:TaskListCursorScope,after:TaskListCursorAfter):string{
  return Buffer.from(JSON.stringify({v:1,projectId,scope,after}),"utf8").toString("base64url");
}

function decodeTaskListCursor(cursor:string|undefined,projectId:string,scope:TaskListCursorScope):TaskListCursorAfter|undefined{
  if(!cursor)return undefined;
  const decoded=decodeCursorRecord(cursor,"Task list cursor is invalid");
  const after=decoded.after;
  if(!isUnknownRecord(after)||typeof after.value!=="string"||typeof after.taskId!=="string"||!after.taskId){
    throw new ProductError("Task list cursor is invalid for this query",400);
  }
  if(scope.sort!=="title"&&!isCanonicalIsoDate(after.value))throw new ProductError("Task list cursor is invalid for this query",400);
  const normalizedAfter={value:after.value,taskId:after.taskId};
  if(canonicalJson(decoded)!==canonicalJson({v:1,projectId,scope,after:normalizedAfter}))throw new ProductError("Task list cursor is invalid for this query",400);
  return normalizedAfter;
}

function encodeTaskArtifactCursor(taskId:string,filter:TaskArtifactCursorFilter,after:TaskArtifactCursorAfter):string{
  return Buffer.from(JSON.stringify({v:1,taskId,filter,after}),"utf8").toString("base64url");
}

function decodeTaskArtifactCursor(cursor:string|undefined,taskId:string,filter:TaskArtifactCursorFilter):TaskArtifactCursorAfter|undefined{
  if(!cursor)return undefined;
  const decoded=decodeCursorRecord(cursor,"Task Artifact cursor is invalid");
  const after=decoded.after;
  if(!isUnknownRecord(after)||typeof after.createdAt!=="string"||!isCanonicalIsoDate(after.createdAt)||typeof after.artifactId!=="string"||!after.artifactId){
    throw new ProductError("Task Artifact cursor is invalid for this query",400);
  }
  const normalizedAfter={createdAt:after.createdAt,artifactId:after.artifactId};
  if(canonicalJson(decoded)!==canonicalJson({v:1,taskId,filter,after:normalizedAfter}))throw new ProductError("Task Artifact cursor is invalid for this query",400);
  return normalizedAfter;
}

function decodeCursorRecord(cursor:string,message:string):Record<string,unknown>{
  let text:string,decoded:unknown;
  try{
    text=Buffer.from(cursor,"base64url").toString("utf8");
    decoded=JSON.parse(text);
  }catch{throw new ProductError(message,400);}
  if(Buffer.from(text,"utf8").toString("base64url")!==cursor||!isUnknownRecord(decoded))throw new ProductError(message,400);
  return decoded;
}

function isCanonicalIsoDate(value:string):boolean{
  try{
    return new Date(value).toISOString()===value;
  }catch{
    return false;
  }
}

function createBotifiedServiceKey(secret: string | undefined, input: BotifiedServiceKeyInput): string {
  return createBotifiedTaskKey(secret, "agentsmith-lite.botified-service-key.v1", "bsk", input);
}

function createBotifiedBrokerKey(secret: string | undefined, input: BotifiedServiceKeyInput): string {
  return createBotifiedTaskKey(secret, "agentsmith-lite.llm-broker-key.v1", "lbk", input);
}

function createBotifiedTaskKey(
  secret: string | undefined,
  domain: string,
  prefix: string,
  input: BotifiedServiceKeyInput
): string {
  const seed = secret && secret.trim().length > 0 ? secret : "dev-session-secret";
  const hmac = createHmac("sha256", seed);
  for (const part of [domain, input.namespace, input.workspaceId, input.projectId, input.taskId, input.runId]) {
    hmac.update(part);
    hmac.update("\0");
  }
  return `${prefix}_${hmac.digest("base64url")}`;
}

function messageAuditDetail(taskId: string, message: Pick<PersistedTaskMessage, "id" | "deliveryStatus">): import("../../contracts/src/api.js").ProjectAuditSafeDetail {
  return { taskId, messageId: message.id, ...(message.deliveryStatus === undefined ? {} : { deliveryStatus: message.deliveryStatus }) };
}

function defaultBotifiedBaseUrlForTask(input: BotifiedTaskAddressInput): string {
  return `http://${input.serviceName??sandboxServiceNameForTask(input.taskId)}.${input.namespace}.svc.cluster.local:${input.port}`;
}

function defaultTerminalHostForRun(input:TaskTerminalHostInput):string{
  return `${input.serviceName}.${input.namespace}.svc.cluster.local`;
}

function defaultBotifiedBrokerBaseUrlForTask(input: BotifiedBrokerAddressInput): string {
  return `http://${APP_KUBERNETES_SERVICE_NAME}.${input.namespace}.svc.cluster.local/api/internal/tasks/${encodeURIComponent(input.taskId)}/runs/${encodeURIComponent(input.runId)}/v1`;
}

function requireBotifiedServiceKey(serviceKey: string | undefined): asserts serviceKey is string {
  if (serviceKey === undefined || serviceKey.trim() === "") {
    throw new ProductError("Botified service key is required", 500);
  }
}

function materializeLiveCreateActions(
  actions: SandboxReconcileAction[],
  input: { serviceKey: string; brokerKey: string; botifiedConfig: string; agentInstructions: string }
): SandboxReconcileAction[] {
  return actions.map((action) => {
    if (action.type !== "create_resource") {
      return structuredClone(action);
    }
    const resource = structuredClone(action.resource);
    if (action.kind === "Secret") {
      resource.stringData = {
        BOTIFIED_SERVICE_KEY: input.serviceKey,
        AGENTSMITH_LLM_BROKER_KEY: input.brokerKey,
        "AGENTS.md": input.agentInstructions
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

function taskAgentInstructions(task: PersistedAgentTask): string {
  const guidance=`# AgentSmith Task Workspace\n\nWork in \`${BOTIFIED_TASK_HOME_PATH}\`. Save published files under \`${botifiedArtifactPath(task.id)}\`.\n`;
  return task.agentContext?`${guidance}\n${task.agentContext}`:guidance;
}

function botifiedArtifactPath(taskId:string):string{return `${BOTIFIED_TASK_HOME_PATH}/.artifacts/${taskId}`;}

function constantTimeEqual(value: string, expected: string): boolean {
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes);
}

async function waitForPodReady(
  live: TaskLiveSandboxConfig,
  namespace: string,
  podName: string,
  labels: Record<string, string>,
  expectedPodUid:string|undefined,
  signal?:AbortSignal
): Promise<{podUid:string;podIp:string}> {
  const timeoutMs = Math.max(0, live.readinessTimeoutMs ?? 60_000);
  const pollMs = Math.max(1, live.readinessPollMs ?? 1000);
  const sleep = live.sleep ?? defaultSleep;
  let elapsedMs = 0;

  while (true) {
    if(signal?.aborted)throw signal.reason;
    const requestStartedAt = Date.now();
    let readiness: PodReadiness;
    try {
      readiness = await live.port.getPodReadiness(namespace, podName, labels,signal);
    } catch {
      if(signal?.aborted)throw signal.reason;
      elapsedMs += Date.now() - requestStartedAt;
      if (elapsedMs >= timeoutMs) {
        throw new ProductError("Timed out waiting for sandbox pod readiness", 504);
      }
      const delayMs = Math.min(pollMs, timeoutMs - elapsedMs);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      elapsedMs += delayMs;
      continue;
    }
    elapsedMs += Date.now() - requestStartedAt;
    if(typeof readiness==="object"){
      if(expectedPodUid&&readiness.podUid!==expectedPodUid){
        throw new ProductError("Sandbox Pod UID changed during readiness",409,"sandbox_cleanup_intent_conflict");
      }
      if(readiness.state==="ready"&&readiness.podIp)return{podUid:readiness.podUid,podIp:readiness.podIp};
      if(readiness.state==="failed")throw new ProductError("Sandbox pod failed before readiness",502);
      if(elapsedMs>=timeoutMs)throw new ProductError("Timed out waiting for sandbox pod readiness",504);
      const delayMs=Math.min(pollMs,timeoutMs-elapsedMs);
      if(delayMs>0)await sleep(delayMs);
      elapsedMs+=delayMs;
      continue;
    }
    switch(readiness){
      case "fence_mismatch":
        throw new ProductError("Sandbox pod readiness fence mismatch",409,"sandbox_cleanup_intent_conflict");
      case "not_found":{
        if(expectedPodUid)throw new ProductError("Recorded sandbox Pod is missing",409,"sandbox_cleanup_intent_conflict");
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

async function observeSandboxStartupIdentity(
  live:TaskLiveSandboxConfig,
  run:PersistedSandboxRunState,
  labels:Record<string,string>,
  signal?:AbortSignal,
  requireReady=false
):Promise<{podUid:string;podIp?:string}|null>{
  const pod=await live.port.getPodReadiness(run.namespace,run.resourceNames.pod,labels,signal);
  if(pod==="not_found")return null;
  if(pod==="fence_mismatch")throw new ProductError("Sandbox Pod identity fence mismatch",409,"sandbox_cleanup_intent_conflict");
  if(run.startupPodUid&&pod.podUid!==run.startupPodUid){
    throw new ProductError("Sandbox Pod UID was replaced",409,"sandbox_cleanup_intent_conflict");
  }
  if(pod.state==="failed")throw new ProductError("Sandbox pod failed before readiness",502);
  const config=await live.port.getConfigMapData(run.namespace,run.startupConfigMapName!,labels,signal);
  if(config==="not_found")return null;
  if(config==="fence_mismatch")throw new ProductError("Sandbox ConfigMap identity fence mismatch",409,"sandbox_cleanup_intent_conflict");
  const bytes=config.data["botified-config.yaml"];
  if(typeof bytes!=="string"||runtimeConfigHash(bytes)!==run.startupConfigHash){
    throw new ProductError("Sandbox ConfigMap bytes do not match persisted identity",409,"sandbox_cleanup_intent_conflict");
  }
  if(requireReady&&(pod.state!=="ready"||!pod.podIp))return null;
  return{podUid:pod.podUid,...(pod.podIp?{podIp:pod.podIp}:{})};
}

async function waitForBotifiedServiceReady(
  live: TaskLiveSandboxConfig,
  botified: BotifiedRuntimeHttpClient,
  baseUrl: string,
  signal?:AbortSignal
): Promise<void> {
  const timeoutMs = Math.max(0, live.readinessTimeoutMs ?? 60_000);
  const pollMs = Math.max(1, live.readinessPollMs ?? 1000);
  const sleep = live.sleep ?? defaultSleep;
  const deadline=Date.now()+timeoutMs;

  while (true) {
    if(signal?.aborted)throw signal.reason;
    try {
      await botified.health(baseUrl,undefined,signal);
      return;
    } catch {
      if(signal?.aborted)throw signal.reason;
      const remaining=deadline-Date.now();
      if (remaining <= 0) {
        throw new ProductError("Timed out waiting for Botified service readiness", 504);
      }
      const delayMs = Math.min(pollMs,remaining);
      if (delayMs > 0) {
        await waitForAbortableDelay(sleep(delayMs),signal);
      }
    }
  }
}

async function waitForAbortableDelay(delay:Promise<void>,signal?:AbortSignal):Promise<void>{
  if(!signal)return delay;
  if(signal.aborted)throw signal.reason;
  let abort:()=>void=()=>undefined;
  try{
    await Promise.race([
      delay,
      new Promise<never>((_resolve,reject)=>{
        abort=()=>reject(signal.reason);
        signal.addEventListener("abort",abort,{once:true});
      })
    ]);
  }finally{
    signal.removeEventListener("abort",abort);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPendingTaskMessage(message: PersistedTaskMessage): boolean {
  return !message.deletedAt && ["pending", "dispatching"].includes(message.deliveryStatus ?? "pending");
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

function botifiedTaskTurnState(state:string|undefined):TaskCurrentTurnProjection["state"] {
  switch(state){
    case "idle": return "ready";
    case "running": return "running";
    case "aborting": return "aborting";
    default: return "starting";
  }
}

function runAllowsMessageDelivery(run:PersistedSandboxRunState):boolean{
  return run.state==="starting"||run.state==="active";
}

function taskAllowsActivatedRunAdoption(task:PersistedAgentTask,run:PersistedSandboxRunState):boolean{
  return !task.deletedAt&&!task.archivedAt&&run.state==="active"&&taskMatchesExactSandboxRun(task,run);
}

function taskMatchesExactSandboxRun(task:PersistedAgentTask,run:PersistedSandboxRunState):boolean{
  return task.id===run.taskId&&task.currentRunId===run.runId&&task.workspaceId===run.workspaceId&&
    task.projectId===run.projectId&&task.fileLibraryId===run.fileLibraryId;
}

function taskSharesSandboxRunScope(task:PersistedAgentTask,run:PersistedSandboxRunState):boolean{
  return task.id===run.taskId&&task.workspaceId===run.workspaceId&&task.projectId===run.projectId&&task.fileLibraryId===run.fileLibraryId;
}

function requireCurrentRunId(task:PersistedAgentTask):string {
  if(!task.currentRunId)throw new ProductError("Task has no current sandbox Run",409,"task_sandbox_released");
  return task.currentRunId;
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

function terminalStartOperationIdentity(actorId:string,projectId:string,key:string,requestHash:string):string{
  return `${actorId}\u0000${projectId}\u0000terminal-start\u0000${key}\u0000${requestHash}`;
}

async function withHardDeadline<T>(start:(signal:AbortSignal)=>Promise<T>,deadlineAt:string,externalSignal?:AbortSignal):Promise<T>{
  const remaining=Math.max(0,Date.parse(deadlineAt)-Date.now());
  const controller=new AbortController();
  const signal=externalSignal?AbortSignal.any([controller.signal,externalSignal]):controller.signal;
  signal.throwIfAborted();
  const operation=start(signal);
  let timeout:NodeJS.Timeout|undefined;
  try{
    return await Promise.race([
      operation,
      new Promise<never>((_resolve,reject)=>{
        timeout=setTimeout(()=>{
          const error=new ProductError("Sandbox startup action exceeded its deadline",504,"sandbox_startup_deadline_exceeded");
          controller.abort(error);
          reject(error);
        },remaining);
      })
    ]);
  }finally{
    if(timeout)clearTimeout(timeout);
  }
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

function artifactPreview(bytes: Uint8Array, name: string): Pick<AgentTaskArtifact, "mediaType" | "previewText"> {
  const extension = path.extname(name).toLowerCase();
  const mediaType = extension === ".html" || extension === ".htm"
    ? "text/html"
    : detectProjectFileMediaType(bytes, name);
  if (classifyPreviewMediaType(mediaType) !== "text" || bytes.byteLength > 1_048_576) return { mediaType, previewText: null };
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

async function taskArtifactDirectoryIsSafeToRemove(projectRoot:string,taskArtifacts:string):Promise<boolean>{
  const relative=path.relative(projectRoot,taskArtifacts);
  const segments=relative.split(path.sep).filter(Boolean);
  if(segments.length===0)throw new ProductError("Task artifacts could not be safely deleted",409,"task_artifact_path_invalid");
  let current=projectRoot;
  for(const segment of segments){
    current=path.join(current,segment);
    let metadata;
    try{
      metadata=await lstat(current);
    }catch(error){
      if(isNotFound(error))return false;
      throw new ProductError("Task artifacts could not be safely deleted",409,"task_artifact_path_invalid");
    }
    if(metadata.isSymbolicLink()||!metadata.isDirectory()){
      throw new ProductError("Task artifacts could not be safely deleted",409,"task_artifact_path_invalid");
    }
  }
  return true;
}

async function pathExists(target:string):Promise<boolean>{
  try{await lstat(target);return true;}catch(error){if(isNotFound(error))return false;throw error;}
}

const TASK_PREPARATION_MARKER=".agentsmith-preparation.json";

interface TaskPreparationMarker {
  projectId:string;
  taskId:string;
  runId:string|null;
  operationId:string;
  requestHash:string;
  fencingToken:number;
}

function taskPreparationMarker(
  projectId:string,
  taskId:string,
  run:PersistedSandboxRunState|null,
  ownership:Pick<BeginTaskIdempotencyInput,"actorId"|"projectId"|"operation"|"key"|"requestHash">|TaskPreparationOperation
):TaskPreparationMarker {
  if(run&&(run.projectId!==projectId||run.taskId!==taskId))throw new Error("Task preparation Run identity is inconsistent");
  return{
    projectId,
    taskId,
    runId:run?.runId??null,
    operationId:createHash("sha256").update(`${ownership.actorId}\0${ownership.projectId}\0${ownership.operation}\0${ownership.key}`).digest("hex"),
    requestHash:ownership.requestHash,
    fencingToken:run?.fencingToken??0
  };
}

async function writeTaskPreparationMarker(directory:string,marker:TaskPreparationMarker):Promise<void>{
  const directoryHandle=await openDescriptorAnchoredDirectory(directory);
  let handle;
  try{
    handle=await open(`/proc/self/fd/${directoryHandle.fd}/${TASK_PREPARATION_MARKER}`,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_NOFOLLOW,0o600);
    await handle.writeFile(JSON.stringify(marker));
  }catch(error){
    if(!isAlreadyExists(error))throw error;
    await requireTaskPreparationMarker(directory,marker);
  }finally{
    await handle?.close();
    await directoryHandle.close();
  }
}

async function requireTaskPreparationMarker(directory:string,expected:TaskPreparationMarker):Promise<void>{
  const marker=await readTaskPreparationMarker(directory);
  if(canonicalJson(marker)!==canonicalJson(expected))throw new Error("Task preparation marker does not match the admitted operation");
}

async function readTaskPreparationMarker(directory:string):Promise<TaskPreparationMarker>{
  let directoryHandle;
  let handle;
  try{
    directoryHandle=await openDescriptorAnchoredDirectory(directory);
    handle=await open(`/proc/self/fd/${directoryHandle.fd}/${TASK_PREPARATION_MARKER}`,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
    const value=JSON.parse(await handle.readFile("utf8")) as Partial<TaskPreparationMarker>;
    if(
      typeof value.projectId!=="string"||typeof value.taskId!=="string"||
      !(value.runId===null||typeof value.runId==="string")||typeof value.operationId!=="string"||
      typeof value.requestHash!=="string"||!Number.isSafeInteger(value.fencingToken)||
      Object.keys(value).sort().join(",")!=="fencingToken,operationId,projectId,requestHash,runId,taskId"
    )throw new Error("Task preparation marker is invalid");
    return value as TaskPreparationMarker;
  }catch(error){
    if(isNotFound(error))throw new Error("Task preparation marker is missing");
    throw error;
  }finally{
    await handle?.close();
    await directoryHandle?.close();
  }
}

async function requireRecoverableTaskPreparationMarker(dataRoot:string,projectRoot:string,expected:TaskPreparationMarker):Promise<void>{
  await withProjectRootDescriptor(dataRoot,projectRoot,false,async(root)=>{
    const candidates=[
      path.join(root,".preparations",expected.taskId),
      path.join(root,"tasks",expected.taskId)
    ];
    for(const candidate of candidates){
      try{
        const marker=await readTaskPreparationMarker(candidate);
        if(canonicalJson(marker)!==canonicalJson(expected)){
          throw new Error("Task preparation marker does not match the reserved Run");
        }
        return;
      }catch(error){
        if(error instanceof Error&&error.message==="Task preparation marker is missing")continue;
        throw error;
      }
    }
    throw new Error("Task preparation marker is missing");
  });
}

async function validPromotedTaskPreparation(root:string,taskSegments:string[],artifactSegments:string[],marker:TaskPreparationMarker):Promise<boolean>{
  if(!await directoryWalkExists(root,taskSegments)||!await directoryWalkExists(root,[...taskSegments,"botified"])||!await directoryWalkExists(root,artifactSegments))return false;
  await requireTaskPreparationMarker(path.join(root,...taskSegments),marker);
  return true;
}

async function openDescriptorAnchoredDirectory(directory:string):Promise<Awaited<ReturnType<typeof open>>>{
  const match=/^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(directory);
  if(!match)throw new Error("Task preparation marker path is not descriptor-anchored");
  const segments=(match[2]??"").split("/").filter(Boolean);
  return openDirectoryWalk(`/proc/self/fd/${match[1]}`,segments,false);
}

async function withProjectRootDescriptor<T>(
  dataRoot:string,
  projectRoot:string,
  create:boolean,
  operation:(anchoredRoot:string)=>Promise<T>
):Promise<T>{
  const handle=await openProjectRootDescriptor(dataRoot,projectRoot,create);
  try{
    const anchoredRoot=`/proc/self/fd/${handle.fd}`;
    const metadata=await stat(anchoredRoot);
    if(!metadata.isDirectory())throw new Error("Project storage descriptor is not a directory");
    return await operation(anchoredRoot);
  }finally{
    await handle.close();
  }
}

async function safeDirectory(target:string):Promise<boolean>{
  try{return(await lstat(target)).isDirectory();}catch(error){if(isNotFound(error))return false;throw error;}
}

function relativeDirectorySegments(root:string,target:string):string[]{
  const relative=path.relative(root,target);
  if(relative===""||relative.startsWith("..")||path.isAbsolute(relative))throw new Error("Task preparation path is outside the Project");
  const segments=relative.split(path.sep).filter(Boolean);
  if(segments.some((segment)=>segment==="."||segment===".."||segment.includes("/")||segment.includes("\0")))throw new Error("Task preparation path is invalid");
  return segments;
}

async function openDirectoryWalk(root:string,segments:string[],create=false):Promise<Awaited<ReturnType<typeof open>>>{
  const rootFlags=fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|(root.startsWith("/proc/self/fd/")?0:fsConstants.O_NOFOLLOW);
  let current=await open(root,rootFlags);
  try{
    for(const segment of segments){
      if(segment===""||segment==="."||segment===".."||segment.includes("/")||segment.includes("\0"))throw new Error("Task preparation directory segment is invalid");
      const child=`/proc/self/fd/${current.fd}/${segment}`;
      let next;
      try{
        next=await open(child,fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW);
      }catch(error){
        if(!create||!isNotFound(error))throw error;
        try{await mkdir(child,{mode:0o700});}catch(mkdirError){if(!isAlreadyExists(mkdirError))throw mkdirError;}
        next=await open(child,fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW);
      }
      await current.close();
      current=next;
    }
    return current;
  }catch(error){
    await current.close();
    throw error;
  }
}

async function ensureDirectoryWalk(root:string,segments:string[]):Promise<void>{
  const handle=await openDirectoryWalk(root,segments,true);
  await handle.close();
}

async function directoryWalkExists(root:string,segments:string[]):Promise<boolean>{
  try{
    const handle=await openDirectoryWalk(root,segments,false);
    await handle.close();
    return true;
  }catch(error){
    if(isNotFound(error))return false;
    throw error;
  }
}

async function promoteDirectoryByDescriptor(
  root:string,
  sourceParentSegments:string[],
  sourceName:string,
  targetParentSegments:string[],
  targetName:string,
  ownershipMarkerSegments:string[],
  marker:TaskPreparationMarker
):Promise<void>{
  const sourceParent=await openDirectoryWalk(root,sourceParentSegments,false);
  const targetParent=await openDirectoryWalk(root,targetParentSegments,false);
  try{
    const source=`/proc/self/fd/${sourceParent.fd}/${sourceName}`;
    const target=`/proc/self/fd/${targetParent.fd}/${targetName}`;
    if(await pathExists(target)){
      if(await pathExists(source))throw new Error("Task preparation existing target is not owned by the admitted operation");
      if(!await safeDirectory(target))throw new Error("Task preparation destination is not a directory");
      await requireTaskPreparationMarker(path.join(root,...ownershipMarkerSegments),marker);
      return;
    }
    await rename(source,target);
    await requireTaskPreparationMarker(path.join(root,...ownershipMarkerSegments),marker);
  }finally{
    await Promise.all([sourceParent.close(),targetParent.close()]);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isDirectoryNotEmpty(error:unknown):boolean{return error instanceof Error&&"code" in error&&(error as NodeJS.ErrnoException).code==="ENOTEMPTY";}

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
