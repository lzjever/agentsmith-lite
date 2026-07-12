import type {
  AgentTask,
  AgentTaskArtifact,
  AgentTaskEvent,
  ProjectChatMessage,
  ProjectChatThread,
  AgentTaskStatus,
  AuthSession,
  ModelEndpoint,
  ProjectMembership,
  ProjectMembershipView,
  ProjectAlert,
  ProjectAuditEvent,
  ProjectResourcePolicy,
  ProjectResourceUsage,
  ProviderUsage,
  ProjectProviderSettlement,
  Project,
  StoredUser,
  UpdateProjectResourcePolicyInput,
  User,
  UserProfilePreferences,
  UserNotification, ProjectAlertRule, ProjectCredential, StoredProjectCredential,
  ProjectContextEntry,
  Workspace,
  WorkspaceListProjection,
  WorkspaceMembership,
  WorkspaceMembershipView,
  TaskFollowUp,
  TaskSummary,
  TaskTerminalReason,
  TaskDeliveryReceipt,
  TaskListArchivedFilter,
  TaskListSort
} from "../../contracts/src/api.js";

export type JsonDocumentCollection =
  | "project_settings"
  | "endpoint_snapshots"
  | "sandbox_runtime_state"
  | "sandbox_run_state";

export interface PostgresJsonDocStore {
  put(collection: JsonDocumentCollection, id: string, document: Record<string, unknown>): Promise<void>;
  get(collection: JsonDocumentCollection, id: string): Promise<Record<string, unknown> | null>;
  delete(collection: JsonDocumentCollection, id: string): Promise<void>;
}

export type PersistedSandboxRunPhase = "queued" | "starting" | "running" | "stopping" | "expired" | "cleaned";
export type PersistedSandboxCleanupStatus = "active" | "cleanup_requested" | "deleting" | "cleaned";
export type PersistedSandboxTerminalFailureReason = "pod_failed" | "runner_terminated" | "runner_crash_loop_back_off";
export type PersistedSandboxTerminalFailureSyncStatus = "pending" | "synced" | "unavailable";

export interface PersistedSandboxTerminalFailure {
  reason: PersistedSandboxTerminalFailureReason;
  exitCode?: number;
  syncAttempts?: number;
  syncStatus?: PersistedSandboxTerminalFailureSyncStatus;
  lastSyncAt?: string;
  lastSyncError?: string | null;
}

export interface PersistedSandboxStartupFailure {
  operation: string;
  message: string;
  status: number;
  at: string;
}

export interface PersistedSandboxRunResourceNames {
  pod: string;
  service: string;
  configMap: string;
  secret: string;
  serviceAccount?: string;
  networkPolicy?: string;
}

export interface PersistedSandboxRunState {
  namespace: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  runId: string;
  phase: PersistedSandboxRunPhase;
  image: string;
  pvcName: string;
  projectSubPath: string;
  botifiedPort: number;
  resourceNames: PersistedSandboxRunResourceNames;
  serviceKeySecretRef: {
    name: string;
    key: string;
  };
  directories: {
    taskHome: string;
    artifacts: string;
    botified: string;
  };
  resourceLimits: {
    cpuRequest: string;
    memoryRequest: string;
    cpuLimit: string;
    memoryLimit: string;
  };
  modelCa?: {
    configMapName: string;
    configMapKey: string;
    path: string;
  };
  expiresAt?: string | null;
  idleExpiresAt?: string | null;
  timelineCursor?: string | null;
  terminalFailure?: PersistedSandboxTerminalFailure | null;
  startupFailure?: PersistedSandboxStartupFailure | null;
  fencingToken: number;
  cleanupStatus: PersistedSandboxCleanupStatus;
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

export interface SandboxRunStore {
  put(run: PersistedSandboxRunState): Promise<PersistedSandboxRunState>;
  get(runId: string): Promise<PersistedSandboxRunState | null>;
  list(): Promise<PersistedSandboxRunState[]>;
  listActive(): Promise<PersistedSandboxRunState[]>;
  updateWithFencing(
    runId: string,
    expectedFencingToken: number,
    run: PersistedSandboxRunState
  ): Promise<PersistedSandboxRunState | null>;
}

export interface LeaseRecord {
  name: string;
  holder: string;
  fencingToken: number;
  expiresAt: string;
  metadata: Record<string, unknown>;
}

export interface AcquireLeaseInput {
  name: string;
  holder: string;
  ttlMs: number;
  now: Date;
  metadata?: Record<string, unknown>;
}

export interface AcquireLeaseResult {
  acquired: boolean;
  lease: LeaseRecord | null;
}

export interface PostgresLeaseStore {
  acquire(input: AcquireLeaseInput): Promise<AcquireLeaseResult>;
  renew(name: string, fencingToken: number, ttlMs: number, now: Date): Promise<boolean>;
  compareAndSet(name: string, fencingToken: number, metadata: Record<string, unknown>): Promise<boolean>;
  release(name: string, fencingToken: number): Promise<boolean>;
  expire(now: Date): Promise<number>;
  listExpired(now: Date): Promise<LeaseRecord[]>;
}

export type DeleteEndpointResult = "deleted" | "not_found" | "referenced_by_tasks";

export interface ProductStore {
  readonly observedExternalModelCalls: number;
  readonly jsonDocs: PostgresJsonDocStore;
  readonly leases: PostgresLeaseStore;
  readonly sandboxRuns: SandboxRunStore;

  countUsers(): Promise<number>;
  createUser(user: StoredUser): Promise<User>;
  updateUser(user: StoredUser): Promise<User>;
  bindLegacyExternalIdentity(input: LegacyExternalIdentityBinding): Promise<StoredUser | null>;
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findVerifiedUserByEmail(email: string): Promise<StoredUser | null>;
  findUserByOidcSubject(issuer: string, subject: string): Promise<StoredUser | null>;
  findUserById(id: string): Promise<StoredUser | null>;
  findUserProfilePreferences(userId: string): Promise<UserProfilePreferences | null>;
  upsertUserProfilePreferences(value: UserProfilePreferences): Promise<UserProfilePreferences>;
  createUserNotification(value: UserNotification, dedupeKey?: string): Promise<UserNotification>;
  listUserNotifications(userId: string, unreadOnly?: boolean): Promise<UserNotification[]>;
  markUserNotificationRead(id: string, userId: string, readAt: string): Promise<UserNotification | null>;
  dismissUserNotification(id: string, userId: string): Promise<boolean>;

  createSession(session: AuthSession): Promise<AuthSession>;
  findSession(id: string): Promise<AuthSession | null>;
  deleteSession(id: string): Promise<boolean>;

  createWorkspace(workspace: Workspace): Promise<Workspace>;
  listWorkspacesForUser(userId: string): Promise<WorkspaceListProjection[]>;
  findWorkspace(id: string): Promise<Workspace | null>;
  updateWorkspace(workspace: Workspace): Promise<Workspace | null>;
  beginWorkspaceDeletion(id: string, updatedAt: string): Promise<Workspace | null>;
  setWorkspaceLifecycleStatus(id: string, status: "active" | "archived", updatedAt: string): Promise<Workspace | null>;
  transferWorkspaceOwner(workspaceId: string, fromUserId: string, toUserId: string, updatedAt: string): Promise<Workspace | null>;
  deleteWorkspaceAfterProjects(id: string): Promise<boolean>;
  findWorkspaceMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null>;
  listWorkspaceMemberships(workspaceId: string): Promise<WorkspaceMembershipView[]>;
  upsertWorkspaceMembership(membership: WorkspaceMembership): Promise<WorkspaceMembership>;
  updateWorkspaceMembership(membership: WorkspaceMembership): Promise<WorkspaceMembership | null>;
  deleteWorkspaceMembership(workspaceId: string, userId: string): Promise<boolean>;

  createProject(project: Project): Promise<Project>;
  listProjectsForWorkspace(workspaceId: string): Promise<Project[]>;
  findProject(id: string): Promise<Project | null>;
  updateProject(project: Project): Promise<Project | null>;
  beginProjectDeletion(id: string, updatedAt: string): Promise<Project | null>;
  setProjectLifecycleStatus(id: string, status: "active" | "archived", updatedAt: string): Promise<Project | null>;
  transferProjectOwner(projectId: string, fromUserId: string, toUserId: string, updatedAt: string): Promise<Project | null>;
  deleteProjectDependenciesAndProject(id: string): Promise<boolean>;
  createProjectContextEntry(value: ProjectContextEntry): Promise<ProjectContextEntry>;
  updateProjectContextEntry(value: ProjectContextEntry, expectedVersion: number): Promise<ProjectContextEntry | null>;
  listProjectContextEntries(workspaceId: string, projectId: string | null, scope: ProjectContextEntry["scope"], ownerUserId: string | null): Promise<ProjectContextEntry[]>;
  deleteProjectContextEntry(value: Pick<ProjectContextEntry, "id" | "workspaceId" | "projectId" | "scope" | "ownerUserId">): Promise<boolean>;
  createProjectAlertRule(value: ProjectAlertRule): Promise<ProjectAlertRule>;
  listProjectAlertRules(projectId: string): Promise<ProjectAlertRule[]>;
  updateProjectAlertRule(value: ProjectAlertRule): Promise<ProjectAlertRule | null>;
  deleteProjectAlertRule(projectId: string, id: string): Promise<boolean>;
  listProjectsForUser(userId: string): Promise<Project[]>;
  findProjectMembership(projectId: string, userId: string): Promise<ProjectMembership | null>;
  listProjectMemberships(projectId: string): Promise<ProjectMembershipView[]>;
  upsertProjectMembership(membership: ProjectMembership): Promise<ProjectMembership>;
  updateProjectMembership(membership: ProjectMembership): Promise<ProjectMembership | null>;
  deleteProjectMembership(projectId: string, userId: string): Promise<boolean>;
  createProjectResourcePolicy(policy: ProjectResourcePolicy): Promise<ProjectResourcePolicy>;
  findProjectResourcePolicy(projectId: string): Promise<ProjectResourcePolicy | null>;
  patchProjectResourcePolicy(projectId: string, input: UpdateProjectResourcePolicyInput, updatedAt: string): Promise<ProjectResourcePolicy | null>;
  findProjectResourceUsage(projectId: string): Promise<ProjectResourceUsage | null>;
  upsertProjectResourceUsage(usage: ProjectResourceUsage): Promise<ProjectResourceUsage>;
  adjustProjectResourceUsage(input: ProjectResourceUsageAdjustment): Promise<ProjectResourceUsage | null>;
  reserveProjectProviderSettlement(input: ReserveProjectProviderSettlementInput): Promise<ProjectProviderSettlement | null>;
  markProjectProviderSettlementDispatched(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null>;
  markProjectProviderSettlementDelivered(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null>;
  settleProjectProviderSettlement(id: string, usage: ProviderUsage | undefined, updatedAt: string): Promise<ProjectProviderUsageSettlement | null>;
  markProjectProviderSettlementUnknown(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null>;
  failProjectProviderSettlement(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null>;
  expireProjectProviderSettlements(now: string): Promise<number>;
  pruneProjectProviderSettlements(before: string, limit: number): Promise<number>;
  listSettledProjectProviderSettlements(projectId: string, since: string, endpointId?: string): Promise<ProjectProviderSettlement[]>;
  measureProjectAlertRule(input:{projectId:string;alertType:ProjectAlert["type"];metric:import("../../contracts/src/api.js").AlertRuleMetric;windowSeconds:number|null;endpointId:string|null;now:string}):Promise<number>;
  upsertActiveProjectAlert(alert: ProjectAlert): Promise<ProjectAlert>;
  listActiveProjectAlerts(projectId: string): Promise<ProjectAlert[]>;
  listProjectAlerts(projectId: string): Promise<ProjectAlert[]>;
  transitionProjectAlert(projectId: string, id: string, status: Extract<ProjectAlert["status"], "resolved" | "dismissed">, updatedAt: string): Promise<ProjectAlert | null>;
  updateProjectAlertState(projectId:string,id:string,input:{acknowledgedAt?:string;acknowledgedBy?:string;silencedUntil?:string|null},updatedAt:string):Promise<ProjectAlert|null>;
  updateProjectAlertDeliveryStatus(projectId: string, id: string, status: ProjectAlert["deliveryStatus"], updatedAt: string): Promise<ProjectAlert | null>;
  appendProjectAuditEvent(event: ProjectAuditEvent): Promise<void>;
  listProjectAuditEvents(projectId: string): Promise<ProjectAuditEvent[]>;
  queryProjectAuditEvents(projectId: string, query: import("../../contracts/src/api.js").ProjectAuditQuery): Promise<{ items: ProjectAuditEvent[]; nextCursor: string | null }>;

  createProjectCredential(value: StoredProjectCredential): Promise<ProjectCredential>;
  findProjectCredential(id: string): Promise<StoredProjectCredential | null>;
  listProjectCredentials(projectId: string): Promise<ProjectCredential[]>;
  updateProjectCredential(value: StoredProjectCredential, expectedVersion: number): Promise<ProjectCredential | "not_found" | "version_conflict">;
  deleteProjectCredential(id: string): Promise<boolean>;
  listLegacyEndpointCredentialAliases(): Promise<Array<{ endpointId: string; projectId: string; baseUrl: string; secretRef: string }>>;
  bindEndpointCredential(endpointId: string, credentialId: string): Promise<boolean>;

  createEndpoint(endpoint: ModelEndpoint): Promise<ModelEndpoint>;
  updateEndpoint(endpoint: ModelEndpoint): Promise<ModelEndpoint | null>;
  deleteEndpoint(id: string): Promise<DeleteEndpointResult>;
  listEndpointsForProject(projectId: string): Promise<ModelEndpoint[]>;
  findEndpoint(id: string): Promise<ModelEndpoint | null>;

  createProjectChatThread(thread: ProjectChatThread): Promise<ProjectChatThread>;
  findProjectChatThread(id: string): Promise<ProjectChatThread | null>;
  listProjectChatThreads(projectId: string): Promise<ProjectChatThread[]>;
  searchProjectChatThreads(projectId: string, query: string): Promise<ProjectChatThread[]>;
  updateProjectChatThreadMetadata(id: string, metadata: Pick<ProjectChatThread, "title" | "pinnedAt" | "starredAt">, updatedAt: string): Promise<ProjectChatThread | null>;
  deleteProjectChatThread(id: string, deletedAt: string): Promise<ProjectChatThread | null>;
  touchProjectChatThread(id: string, updatedAt: string): Promise<ProjectChatThread | null>;
  appendProjectChatMessages(messages: ProjectChatMessage[]): Promise<void>;
  listProjectChatMessages(threadId: string): Promise<ProjectChatMessage[]>;
  updateProjectChatMessageDelivery(id: string, deliveryStatus: ProjectChatMessage["deliveryStatus"], updatedAt: string): Promise<ProjectChatMessage | null>;
  stageProjectChatResponse(userMessageId: string, assistantMessage: ProjectChatMessage): Promise<boolean>;
  finalizeProjectChatResponse(userMessageId: string): Promise<ProjectChatMessage | null>;
  editProjectChatMessageAndTruncate(threadId: string, messageId: string, expectedVersion: number, content: string, updatedAt: string): Promise<ProjectChatMessage | null>;
  deleteProjectChatMessageAndFollowing(threadId: string, messageId: string, expectedVersion: number): Promise<boolean>;

  createTask(task: AgentTask): Promise<AgentTask>;
  createTaskAtomically(input: AtomicTaskCreateInput): Promise<AgentTask | null>;
  createTaskWithActiveReservation(task: AgentTask): Promise<AgentTask | null>;
  createTaskWithActiveReservationAndFollowUp(task: AgentTask, followUp: TaskFollowUp): Promise<AgentTask | null>;
  updateTask(task: AgentTask): Promise<AgentTask>;
  updateTaskStatusIfStarting(taskId: string, status: AgentTaskStatus, updatedAt: string): Promise<AgentTask | null>;
  updateTaskStatusIfNonterminal(taskId: string, status: AgentTaskStatus, updatedAt: string): Promise<AgentTask | null>;
  listActiveTasks(): Promise<AgentTask[]>;
  listTasksForProject(projectId: string): Promise<AgentTask[]>;
  queryTasksForProject(projectId: string, query: TaskStoreListQuery): Promise<TaskStoreListPage>;
  findTask(id: string): Promise<AgentTask | null>;
  updateTaskTitle(taskId: string, title: string, updatedAt: string, auditEvent?: ProjectAuditEvent): Promise<AgentTask | null>;
  archiveTask(taskId: string, archivedAt: string, auditEvent?: ProjectAuditEvent): Promise<AgentTask | null>;
  softDeleteTask(taskId: string, deletedAt: string, auditEvent?: ProjectAuditEvent): Promise<AgentTask | null>;
  listTaskStartIntentsDue(now: string, limit: number): Promise<AgentTask[]>;
  claimTaskStart(input: TaskDeliveryClaimInput): Promise<AgentTask | null>;
  reclaimTaskStart(input: TaskDeliveryReclaimInput): Promise<AgentTask | null>;
  recordTaskStartReceipt(input: TaskStartReceiptInput): Promise<AgentTask | null>;
  deferTaskStart(input: TaskDeliveryDeferInput): Promise<AgentTask | null>;
  failTaskStart(input: TaskDeliveryFailureInput): Promise<AgentTask | null>;
  finalizeTaskLifecycle(input: FinalizeTaskLifecycleInput): Promise<FinalizeTaskLifecycleResult | null>;
  listTasksForArtifactProjection(now: string, limit: number): Promise<AgentTask[]>;
  claimTaskArtifactProjection(input: TaskStageClaimInput): Promise<AgentTask | null>;
  completeTaskArtifactProjection(input: TaskStageCompleteInput): Promise<AgentTask | null>;
  failTaskArtifactProjection(input: TaskStageFailureInput): Promise<AgentTask | null>;
  listTasksForCleanup(now: string, limit: number): Promise<AgentTask[]>;
  claimTaskCleanup(input: TaskStageClaimInput): Promise<AgentTask | null>;
  completeTaskCleanup(input: TaskStageCompleteInput): Promise<AgentTask | null>;
  failTaskCleanup(input: TaskStageFailureInput): Promise<AgentTask | null>;
  beginTaskIdempotency(input: BeginTaskIdempotencyInput): Promise<TaskIdempotencyBeginResult>;
  completeTaskIdempotency(input: CompleteTaskIdempotencyInput): Promise<boolean>;
  completeTaskIdempotencyForResource(resourceId: string, responseStatus: number, responseBody: unknown, updatedAt: string): Promise<number>;
  appendTaskEvents(events: AgentTaskEvent[]): Promise<void>;
  listTaskEvents(taskId: string): Promise<AgentTaskEvent[]>;
  listTaskEventsAfter(taskId: string, afterCursor: string | null, limit: number): Promise<{ items: AgentTaskEvent[]; nextCursor: string | null }>;
  appendTaskArtifacts(artifacts: AgentTaskArtifact[]): Promise<void>;
  persistTaskArtifactProjection(input: PersistTaskArtifactProjectionInput): Promise<"created" | "existing" | "limit_exceeded">;
  listTaskArtifacts(taskId: string): Promise<AgentTaskArtifact[]>;
  createTaskFollowUp(followUp: TaskFollowUp): Promise<TaskFollowUp>;
  createPendingTaskFollowUp(followUp: TaskFollowUp): Promise<TaskFollowUp | null>;
  listTaskFollowUps(taskId: string): Promise<TaskFollowUp[]>;
  findTaskFollowUp(id: string): Promise<TaskFollowUp | null>;
  updatePendingTaskFollowUp(id: string, prompt: string, requestHash: string, updatedAt: string, auditEvent?: ProjectAuditEvent): Promise<TaskFollowUp | null>;
  deletePendingTaskFollowUp(id: string, deletedAt: string, auditEvent?: ProjectAuditEvent): Promise<TaskFollowUp | null>;
  listTaskFollowUpsDue(now: string, limit: number): Promise<TaskFollowUp[]>;
  claimTaskFollowUp(input: TaskDeliveryClaimInput): Promise<TaskFollowUp | null>;
  reclaimTaskFollowUp(input: TaskDeliveryReclaimInput): Promise<TaskFollowUp | null>;
  recordTaskFollowUpReceipt(input: TaskFollowUpReceiptInput): Promise<TaskFollowUp | null>;
  deferTaskFollowUp(input: TaskDeliveryDeferInput): Promise<TaskFollowUp | null>;
  failTaskFollowUp(input: TaskDeliveryFailureInput): Promise<TaskFollowUp | null>;
  createTerminalTaskFollowUp(input: CreateTerminalTaskFollowUpInput): Promise<TaskFollowUp | null>;
  resolveTerminalPendingFollowUp(input: ResolveTerminalPendingFollowUpInput): Promise<TaskFollowUp | null>;
  findTaskSummary(taskId: string): Promise<TaskSummary | null>;
  listTaskSummariesForProject(projectId: string): Promise<TaskSummary[]>;
}

export interface AtomicTaskCreateInput {
  task: AgentTask;
  reserveActive: boolean;
  runtimeState?: Record<string, unknown>;
  sandboxRun?: PersistedSandboxRunState;
}

export interface PersistTaskArtifactProjectionInput {
  projectId: string;
  artifact: AgentTaskArtifact;
  auditEvent: ProjectAuditEvent;
  updatedAt: string;
}

export interface TaskStoreListQuery {
  search: string;
  statuses: AgentTaskStatus[];
  archived: TaskListArchivedFilter;
  sort: TaskListSort;
  direction: "asc" | "desc";
  offset: number;
  limit: number;
}

export interface TaskStoreListPage {
  items: AgentTask[];
  total: number;
}

export interface TaskDeliveryClaimInput {
  id: string;
  claimToken: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface TaskDeliveryReclaimInput extends TaskDeliveryClaimInput {
  expectedClaimToken: string;
}

export type PersistedDeliveryReceipt = TaskDeliveryReceipt;

export interface TaskStartReceiptInput {
  id: string;
  claimToken: string;
  receipt: PersistedDeliveryReceipt;
  timelineCursor: string | null;
  updatedAt: string;
}

export type TaskFollowUpReceiptInput = TaskStartReceiptInput;

export interface TaskDeliveryDeferInput {
  id: string;
  claimToken: string;
  safeError: string;
  nextRetryAt: string;
  updatedAt: string;
  releaseClaim?: boolean;
}

export interface TaskDeliveryFailureInput {
  id: string;
  claimToken: string;
  safeError: string;
  updatedAt: string;
}

export interface TaskLifecycleSuccessor {
  followUpId: string;
  create: AtomicTaskCreateInput;
}

export interface FinalizeTaskLifecycleInput {
  taskId: string;
  terminalReason: TaskTerminalReason;
  updatedAt: string;
  auditEvent: ProjectAuditEvent;
  successors: TaskLifecycleSuccessor[];
}

export interface FinalizeTaskLifecycleResult {
  task: AgentTask;
  applied: boolean;
  successorTaskIds: string[];
  missingPendingFollowUpIds: string[];
}

export interface TaskStageClaimInput {
  id: string;
  claimToken: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface TaskStageCompleteInput {
  id: string;
  claimToken: string;
  updatedAt: string;
}

export interface TaskStageFailureInput extends TaskStageCompleteInput {
  safeError: string;
  nextRetryAt: string;
}

export type TaskIdempotencyOperation = "create" | "retry" | "duplicate" | "follow-up" | "follow-up-edit" | "follow-up-delete" | "cancel" | "edit" | "archive" | "delete" | "workspace.settings.update" | "workspace.archive" | "workspace.unarchive" | "workspace.owner.transfer" | "workspace.delete" | "project.settings.update" | "project.archive" | "project.unarchive" | "project.owner.transfer" | "project.delete";

export interface TaskIdempotencyScope {
  actorId: string;
  projectId: string;
  operation: TaskIdempotencyOperation;
  key: string;
}

export interface BeginTaskIdempotencyInput extends TaskIdempotencyScope {
  requestHash: string;
  resourceId: string;
  claimToken: string;
  now: string;
  leaseExpiresAt: string;
}

export type TaskIdempotencyBeginResult =
  | { kind: "claimed"; resourceId: string; claimToken: string }
  | { kind: "in_progress"; resourceId: string }
  | { kind: "replay"; resourceId: string; responseStatus: number; responseBody: unknown }
  | { kind: "hash_mismatch" };

export interface CompleteTaskIdempotencyInput extends TaskIdempotencyScope {
  requestHash: string;
  claimToken: string;
  responseStatus: number;
  responseBody: unknown;
  updatedAt: string;
}

export interface CreateTerminalTaskFollowUpInput {
  followUp: TaskFollowUp;
  successor: AtomicTaskCreateInput;
}

export interface ResolveTerminalPendingFollowUpInput {
  followUpId: string;
  expectedClaimToken: string;
  successor: AtomicTaskCreateInput;
  updatedAt: string;
}

export interface ReserveProjectProviderSettlementInput {
  id: string;
  projectId: string;
  taskId: string | null;
  endpointId: string | null;
  actorId?: string | null;
  reservedTokens: number;
  reservedCost: number;
  reservedAt: string;
  expiresAt: string;
}

export interface ProjectResourceUsageAdjustment {
  projectId: string;
  delta: Pick<ProjectResourceUsage, "activeTasks" | "providerRequests" | "providerTokens" | "providerCost" | "projectFileBytes">;
  limit?: ProjectAlert["type"];
  updatedAt: string;
}

export interface ProjectProviderUsageSettlement {
  usage: ProjectResourceUsage;
  exceededLimits: Array<Extract<ProjectAlert["type"], "provider_tokens_limit" | "provider_cost_limit">>;
}

export interface LegacyExternalIdentityBinding {
  userId: string;
  issuer: string;
  subject: string;
  email: string;
  updatedAt: string;
}
