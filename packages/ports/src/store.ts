import type {
  AgentTask,
  AgentTaskArtifact,
  TaskHistoryStatus,
  TaskInteractionItem,
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
  TaskSummary,
  TaskTerminalReason,
  TaskListArchivedFilter,
  TaskListSort
} from "../../contracts/src/api.js";

export interface PersistedDeliveryReceipt {
  accepted: boolean;
  deliveryKey: string;
  requestHash: string;
  messageId?: string;
  cursor?: string;
}

export interface PersistedAgentTask extends AgentTask {
  createdByUserId?: string | null;
  agentContext?: string;
  startDeliveryKey?: string | null;
  startRequestHash?: string | null;
  startClaimToken?: string | null;
  startReceipt?: PersistedDeliveryReceipt | null;
  startTimelineCursor?: string | null;
  startClaimedAt?: string | null;
  startLeaseExpiresAt?: string | null;
  startAttemptCount?: number;
  startNextRetryAt?: string | null;
  artifactProjectionClaimToken?: string | null;
  artifactProjectionLeaseExpiresAt?: string | null;
  artifactProjectionAttemptCount?: number;
  artifactProjectionNextRetryAt?: string | null;
  cleanupClaimToken?: string | null;
  cleanupLeaseExpiresAt?: string | null;
  cleanupAttemptCount?: number;
  cleanupNextRetryAt?: string | null;
  finalizationIntentStatus?: Extract<AgentTaskStatus, "completed" | "failed" | "expired" | "cleaned"> | null;
  finalizationIntentAt?: string | null;
}

export interface PersistedTaskArtifact extends AgentTaskArtifact {
  fileId: string;
}

export type PersistedTaskMessageDeliveryStatus = "pending" | "dispatching" | "terminal_pending" | "accepted" | "successor_created" | "failed";

export interface PersistedTaskMessage {
  id: string;
  taskId: string;
  actorId?: string | null;
  content: string;
  targetTaskId?: string | null;
  deliveryKey?: string | null;
  requestHash?: string | null;
  claimToken?: string | null;
  receipt?: PersistedDeliveryReceipt | null;
  timelineCursor?: string | null;
  deliveryStatus?: PersistedTaskMessageDeliveryStatus;
  claimedAt?: string | null;
  leaseExpiresAt?: string | null;
  attemptCount?: number;
  nextRetryAt?: string | null;
  safeError?: string | null;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export type TaskInteractionSourceKind = "botified" | "product";

export interface TaskInteractionCorrelation {
  toolCallId?: string | null;
  workTaskId?: string | null;
  callbackId?: string | null;
}

export interface TaskInteractionChangeInput {
  sourceKind: TaskInteractionSourceKind;
  sourceId: string;
  sourceRevision: number;
  interaction: TaskInteractionItem;
  correlation?: TaskInteractionCorrelation;
}

export interface PersistedTaskInteractionChange extends TaskInteractionChangeInput {
  changeSeq: number;
}

export interface TaskInteractionSyncMutation {
  expectedSourceCursor?: string | null;
  sourceCursor: string | null;
  historyStatus: TaskHistoryStatus;
  lastSyncedAt: string;
}

export interface TaskInteractionActiveLifecycleMutation {
  kind: "active";
  expectedStatus: Extract<AgentTaskStatus, "queued" | "starting" | "running" | "stopping">;
  status: Extract<AgentTaskStatus, "queued" | "starting" | "running" | "stopping">;
  updatedAt: string;
}

export interface TaskInteractionTerminalLifecycleMutation {
  kind: "terminal";
  terminalReason: TaskTerminalReason;
  updatedAt: string;
  auditEvent: ProjectAuditEvent;
  successors: TaskLifecycleSuccessor[];
  terminalPendingChanges?: TaskLifecycleTerminalPendingChange[];
}

export type TaskInteractionLifecycleMutation =
  | TaskInteractionActiveLifecycleMutation
  | TaskInteractionTerminalLifecycleMutation;

export interface PersistTaskInteractionMutationInput {
  taskId: string;
  changes: TaskInteractionChangeInput[];
  artifactProjections?: PersistTaskArtifactProjectionInput[];
  lifecycle?: TaskInteractionLifecycleMutation;
  sourceSync?: TaskInteractionSyncMutation;
}

export interface PersistTaskInteractionMutationResult {
  changes: PersistedTaskInteractionChange[];
  latestChangeSeq: number;
  sourceCursor: string | null;
  historyStatus: TaskHistoryStatus;
  lastSyncedAt: string | null;
}

export interface TaskInteractionPageAnchor {
  position: number;
  interactionId: string;
}

export interface TaskInteractionStoreSnapshot {
  items: TaskInteractionItem[];
  queuedMessages: PersistedTaskMessage[];
  suppressedInteractionIds: string[];
  nextPageAnchor: TaskInteractionPageAnchor | null;
  hasMoreBefore: boolean;
  latestChangeSeq: number;
  sourceCursor: string | null;
  historyStatus: TaskHistoryStatus;
  lastSyncedAt: string | null;
}

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

export interface SandboxRunCleanupClaimInput {
  runId: string;
  expectedFencingToken: number;
  claimedAt: string;
}

export interface SandboxRunStore {
  put(run: PersistedSandboxRunState): Promise<PersistedSandboxRunState>;
  get(runId: string): Promise<PersistedSandboxRunState | null>;
  list(): Promise<PersistedSandboxRunState[]>;
  listActive(): Promise<PersistedSandboxRunState[]>;
  claimForCleanup(input: SandboxRunCleanupClaimInput): Promise<PersistedSandboxRunState | null>;
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
  revokeWorkspaceMembership(workspaceId: string, userId: string): Promise<"revoked" | "not_found" | "owner">;

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
  upsertProjectMembershipForWorkspaceMember(membership: ProjectMembership): Promise<ProjectMembership | null>;
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

  createTask(task: PersistedAgentTask): Promise<PersistedAgentTask>;
  createTaskAtomically(input: AtomicTaskCreateInput): Promise<PersistedAgentTask | null>;
  createTaskWithActiveReservation(task: PersistedAgentTask): Promise<PersistedAgentTask | null>;
  createTaskWithActiveReservationAndMessage(task: PersistedAgentTask, message: PersistedTaskMessage): Promise<PersistedAgentTask | null>;
  updateTask(task: PersistedAgentTask): Promise<PersistedAgentTask>;
  updateTaskStatusIfStarting(taskId: string, status: AgentTaskStatus, updatedAt: string): Promise<PersistedAgentTask | null>;
  updateTaskStatusIfNonterminal(taskId: string, status: AgentTaskStatus, updatedAt: string): Promise<PersistedAgentTask | null>;
  listActiveTasks(): Promise<PersistedAgentTask[]>;
  listTasksForProject(projectId: string): Promise<PersistedAgentTask[]>;
  queryTasksForProject(projectId: string, query: TaskStoreListQuery): Promise<TaskStoreListPage>;
  findTask(id: string): Promise<PersistedAgentTask | null>;
  updateTaskTitle(taskId: string, title: string, updatedAt: string, auditEvent?: ProjectAuditEvent): Promise<PersistedAgentTask | null>;
  archiveTask(taskId: string, archivedAt: string, auditEvent?: ProjectAuditEvent): Promise<PersistedAgentTask | null>;
  softDeleteTask(taskId: string, deletedAt: string, auditEvent?: ProjectAuditEvent): Promise<PersistedAgentTask | null>;
  listTaskStartIntentsDue(now: string, limit: number): Promise<PersistedAgentTask[]>;
  claimTaskStart(input: TaskDeliveryClaimInput): Promise<PersistedAgentTask | null>;
  reclaimTaskStart(input: TaskDeliveryReclaimInput): Promise<PersistedAgentTask | null>;
  recordTaskStartReceipt(input: TaskStartReceiptInput): Promise<PersistedAgentTask | null>;
  deferTaskStart(input: TaskDeliveryDeferInput): Promise<PersistedAgentTask | null>;
  failTaskStart(input: TaskDeliveryFailureInput): Promise<PersistedAgentTask | null>;
  finalizeTaskLifecycle(input: FinalizeTaskLifecycleInput): Promise<FinalizeTaskLifecycleResult | null>;
  listTasksForArtifactProjection(now: string, limit: number): Promise<PersistedAgentTask[]>;
  claimTaskArtifactProjection(input: TaskStageClaimInput): Promise<PersistedAgentTask | null>;
  completeTaskArtifactProjection(input: TaskStageCompleteInput): Promise<PersistedAgentTask | null>;
  failTaskArtifactProjection(input: TaskStageFailureInput): Promise<PersistedAgentTask | null>;
  listTasksForCleanup(now: string, limit: number): Promise<PersistedAgentTask[]>;
  claimTaskCleanup(input: TaskStageClaimInput): Promise<PersistedAgentTask | null>;
  completeTaskCleanup(input: TaskStageCompleteInput): Promise<PersistedAgentTask | null>;
  failTaskCleanup(input: TaskStageFailureInput): Promise<PersistedAgentTask | null>;
  beginTaskIdempotency(input: BeginTaskIdempotencyInput): Promise<TaskIdempotencyBeginResult>;
  completeTaskIdempotency(input: CompleteTaskIdempotencyInput): Promise<boolean>;
  completeTaskIdempotencyForResource(resourceId: string, responseStatus: number, responseBody: unknown, updatedAt: string): Promise<number>;
  persistTaskInteractionMutation(input: PersistTaskInteractionMutationInput): Promise<PersistTaskInteractionMutationResult>;
  readTaskInteractionSnapshot(taskId: string, before: TaskInteractionPageAnchor | null, limit: number): Promise<TaskInteractionStoreSnapshot | null>;
  listTaskInteractionChanges(taskId: string, afterChangeSeq: number, limit: number): Promise<PersistedTaskInteractionChange[]>;
  findLatestTaskInteractionChange(taskId: string, interactionId: string): Promise<PersistedTaskInteractionChange | null>;
  findTaskInteractionByCorrelation(taskId: string, correlation: TaskInteractionCorrelation): Promise<TaskInteractionItem | null>;
  appendTaskArtifacts(artifacts: PersistedTaskArtifact[]): Promise<void>;
  persistTaskArtifactProjection(input: PersistTaskArtifactProjectionInput): Promise<"created" | "existing" | "limit_exceeded">;
  listTaskArtifacts(taskId: string): Promise<PersistedTaskArtifact[]>;
  createTaskMessage(message: PersistedTaskMessage): Promise<PersistedTaskMessage>;
  createPendingTaskMessage(message: PersistedTaskMessage, interactionChange?: TaskInteractionChangeInput): Promise<PersistedTaskMessage | null>;
  listTaskMessages(taskId: string): Promise<PersistedTaskMessage[]>;
  findTaskMessage(id: string): Promise<PersistedTaskMessage | null>;
  updatePendingTaskMessage(id: string, content: string, requestHash: string, updatedAt: string, interactionChange?: TaskInteractionChangeInput): Promise<PersistedTaskMessage | null>;
  deletePendingTaskMessage(id: string, deletedAt: string, auditEvent?: ProjectAuditEvent): Promise<PersistedTaskMessage | null>;
  listTaskMessagesDue(now: string, limit: number): Promise<PersistedTaskMessage[]>;
  claimTaskMessage(input: TaskDeliveryClaimInput): Promise<PersistedTaskMessage | null>;
  reclaimTaskMessage(input: TaskDeliveryReclaimInput): Promise<PersistedTaskMessage | null>;
  recordTaskMessageReceipt(input: TaskMessageReceiptInput): Promise<PersistedTaskMessage | null>;
  deferTaskMessage(input: TaskDeliveryDeferInput): Promise<PersistedTaskMessage | null>;
  failTaskMessage(input: TaskDeliveryFailureInput): Promise<PersistedTaskMessage | null>;
  createTerminalTaskMessage(input: CreateTerminalTaskMessageInput): Promise<PersistedTaskMessage | null>;
  resolveTerminalPendingMessage(input: ResolveTerminalPendingMessageInput): Promise<PersistedTaskMessage | null>;
  findTaskSummary(taskId: string): Promise<TaskSummary | null>;
  listTaskSummariesForProject(projectId: string): Promise<TaskSummary[]>;
}

export interface AtomicTaskCreateInput {
  task: PersistedAgentTask;
  reserveActive: boolean;
  runtimeState?: Record<string, unknown>;
  sandboxRun?: PersistedSandboxRunState;
}

export interface PersistTaskArtifactProjectionInput {
  projectId: string;
  artifact: PersistedTaskArtifact;
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
  items: PersistedAgentTask[];
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

export interface TaskStartReceiptInput {
  id: string;
  claimToken: string;
  receipt: PersistedDeliveryReceipt;
  timelineCursor: string | null;
  updatedAt: string;
}

export type TaskMessageReceiptInput = TaskStartReceiptInput;

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
  messageId: string;
  create: AtomicTaskCreateInput;
  messageSuccessInteractionChange?: TaskInteractionChangeInput;
  messageFailureInteractionChange?: TaskInteractionChangeInput;
  successorInteractionChange?: TaskInteractionChangeInput;
}

export interface TaskLifecycleTerminalPendingChange {
  messageId: string;
  interactionChange: TaskInteractionChangeInput;
}

export interface FinalizeTaskLifecycleInput {
  taskId: string;
  terminalReason: TaskTerminalReason;
  updatedAt: string;
  auditEvent: ProjectAuditEvent;
  successors: TaskLifecycleSuccessor[];
  terminalPendingChanges?: TaskLifecycleTerminalPendingChange[];
}

export interface FinalizeTaskLifecycleResult {
  task: PersistedAgentTask;
  applied: boolean;
  successorTaskIds: string[];
  missingPendingMessageIds: string[];
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

export type TaskIdempotencyOperation = "create" | "retry" | "duplicate" | "message" | "message-edit" | "message-delete" | "abort-turn" | "work-stop" | "cancel" | "edit" | "archive" | "delete" | "workspace.settings.update" | "workspace.archive" | "workspace.unarchive" | "workspace.owner.transfer" | "workspace.delete" | "project.settings.update" | "project.archive" | "project.unarchive" | "project.owner.transfer" | "project.delete";

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

export interface CreateTerminalTaskMessageInput {
  message: PersistedTaskMessage;
  successor: AtomicTaskCreateInput;
  messageInteractionChange?: TaskInteractionChangeInput;
  successorInteractionChange?: TaskInteractionChangeInput;
}

export interface ResolveTerminalPendingMessageInput {
  messageId: string;
  expectedClaimToken: string;
  successor: AtomicTaskCreateInput;
  updatedAt: string;
  messageInteractionChange?: TaskInteractionChangeInput;
  successorInteractionChange?: TaskInteractionChangeInput;
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
