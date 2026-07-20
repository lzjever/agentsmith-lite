import type {
  AgentTask,
  AgentTaskArtifact,
  TaskHistoryStatus,
  TaskInteractionItem,
  ProjectChatMessage,
  ProjectChatThread,
  AgentTaskStatus,
  AuthSession,
  EndpointHealth,
  FileLibrary,
  FileLibraryTaskLink,
  ModelEndpoint,
  ManagedProjectMembershipRole,
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
  ManagedWorkspaceMembershipRole,
  WorkspaceMembershipView,
  TaskListArchivedFilter,
  TaskListSort,
  SandboxRenderResult,
  SandboxResourceSnapshot,
  SandboxReleaseReason
} from "../../contracts/src/api.js";

export interface PersistedDeliveryReceipt {
  accepted: boolean;
  deliveryKey: string;
  requestHash: string;
  messageId?: string;
  cursor?: string;
}

export interface PersistedAgentTask extends Omit<AgentTask, "sandbox" | "fileLibraryId"> {
  fileLibraryId: string | null;
  sandbox: SandboxRenderResult;
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

export type PersistedTaskMessageDeliveryStatus = "pending" | "dispatching" | "accepted" | "failed";

export interface PersistedTaskMessage {
  id: string;
  taskId: string;
  actorId?: string | null;
  content: string;
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

export type TaskInteractionLifecycleMutation = TaskInteractionActiveLifecycleMutation;

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
  fileLibraryRootSubPath:string;
  fileLibraryId: string;
  startedByUserId: string;
  startedAt: string | null;
  botifiedPort: number;
  resourceNames: PersistedSandboxRunResourceNames;
  serviceKeySecretRef: {
    name: string;
    key: string;
  };
  directories: {
    libraryHome: string;
    botified: string;
  };
  resourceLimits: {
    cpuRequest: string;
    memoryRequest: string;
    cpuLimit: string;
    memoryLimit: string;
  };
  resourceSnapshot: SandboxResourceSnapshot;
  releaseReason?: SandboxReleaseReason | null;
  modelCa?: {
    configMapName: string;
    configMapKey: string;
    path: string;
  };
  timelineCursor?: string | null;
  terminalFailure?: PersistedSandboxTerminalFailure | null;
  startupFailure?: PersistedSandboxStartupFailure | null;
  fencingToken: number;
  cleanupStatus: PersistedSandboxCleanupStatus;
  resumeUnfinished?: boolean;
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

export interface SandboxUsageSettlement {
  runId: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  fileLibraryId: string;
  startedByUserId: string;
  startedAt: string | null;
  releasedAt: string;
  durationSeconds: number;
  resources: SandboxResourceSnapshot;
  releaseReason: SandboxReleaseReason;
}

export interface ConfirmSandboxRunStartedInput {
  runId: string;
  expectedFencingToken: number;
  startedAt: string;
  auditEvent: ProjectAuditEvent;
}

export type ConfirmSandboxRunStartedResult = {
  kind: "started" | "already_started";
  run: PersistedSandboxRunState;
} | { kind: "conflict" };

export interface CompleteSandboxRunReleaseInput {
  runId: string;
  expectedFencingToken: number;
  run: PersistedSandboxRunState;
  settlement: SandboxUsageSettlement;
  auditEvent: ProjectAuditEvent;
}

export type CompleteSandboxRunReleaseResult = "applied" | "already_applied" | "conflict";

export type SandboxGuardedDeletionResult<T> = { kind: "ready"; value: T } | { kind: "sandbox_not_released" } | { kind: "not_found_or_forbidden" };

export interface TaskSandboxReleaseMutationInput {
  runId: string;
  taskId: string;
  expectedFencingToken: number;
  run: PersistedSandboxRunState;
  auditEvent: ProjectAuditEvent;
  idempotency: CompleteTaskIdempotencyInput;
}

export type TaskSandboxReleaseMutationResult = "applied" | "already_requested" | "conflict";

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
export type DeleteProjectCredentialResult = "deleted" | "not_found" | "version_conflict" | "referenced_by_endpoints";

export class EndpointNameConflictError extends Error {
  constructor() { super("Endpoint name already exists"); }
}
export class CredentialVersionConflictError extends Error {
  constructor() { super("Credential version changed"); }
}
export type ManagedProjectMembershipDeleteResult = "deleted" | "not_found" | "owner" | "conflict";
export type ManagedProjectMembershipUpdateResult = ProjectMembership | "not_found" | "owner" | "conflict";
export type ManagedWorkspaceMembershipUpdateResult = WorkspaceMembership | "not_found" | "owner" | "conflict";
export type RevokeWorkspaceMembershipResult = { revokedProjectIds: string[] } | "not_found" | "owner" | "conflict";
export type CreateWorkspaceMembershipResult = WorkspaceMembership | "already_exists";
export type CreateProjectMembershipResult = ProjectMembership | "already_exists" | "not_workspace_member";
export type AppendProjectChatMessageResult = "accepted" | "history_changed" | "request_running";
export type DeleteProjectChatThreadResult = ProjectChatThread | "request_running" | null;
export type FileLibraryBindingLookup =
  | { kind: "unbound" }
  | { kind: "bound"; task: FileLibraryTaskLink }
  | { kind: "unavailable" };

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
  upsertUserProfilePreferences(value: UserProfilePreferences, expectedUpdatedAt: string | null): Promise<UserProfilePreferences | null>;
  createUserNotification(value: UserNotification, dedupeKey?: string): Promise<UserNotification>;
  listUserNotifications(userId: string, unreadOnly?: boolean): Promise<UserNotification[]>;
  markUserNotificationRead(id: string, userId: string, readAt: string): Promise<UserNotification | null>;
  markAllUserNotificationsRead(userId: string, readAt: string): Promise<number>;
  dismissUserNotification(id: string, userId: string): Promise<boolean>;

  createSession(session: AuthSession): Promise<AuthSession>;
  findSession(id: string): Promise<AuthSession | null>;
  deleteSession(id: string): Promise<boolean>;
  deleteExpiredSessions(now: string): Promise<number>;

  createWorkspace(workspace: Workspace): Promise<Workspace>;
  listWorkspacesForUser(userId: string): Promise<WorkspaceListProjection[]>;
  findWorkspace(id: string): Promise<Workspace | null>;
  updateWorkspaceName(workspaceId: string, name: string, updatedAt: string, expectedName: string): Promise<Workspace | null>;
  beginWorkspaceDeletion(id: string, updatedAt: string, expectedOwnerUserId?: string): Promise<SandboxGuardedDeletionResult<Workspace>>;
  setWorkspaceLifecycleStatus(id: string, status: "active" | "archived", updatedAt: string): Promise<Workspace | null>;
  transferWorkspaceOwner(workspaceId: string, fromUserId: string, toUserId: string, updatedAt: string): Promise<Workspace | null>;
  deleteWorkspaceAfterProjects(id: string): Promise<boolean>;
  findWorkspaceMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null>;
  listWorkspaceMemberships(workspaceId: string): Promise<WorkspaceMembershipView[]>;
  upsertWorkspaceMembership(membership: WorkspaceMembership): Promise<WorkspaceMembership>;
  createWorkspaceMembership(membership: WorkspaceMembership): Promise<CreateWorkspaceMembershipResult>;
  updateWorkspaceMembership(membership: WorkspaceMembership): Promise<WorkspaceMembership | null>;
  updateManagedWorkspaceMembershipRole(workspaceId: string, userId: string, role: ManagedWorkspaceMembershipRole, updatedAt: string, expectedUpdatedAt: string): Promise<ManagedWorkspaceMembershipUpdateResult>;
  revokeWorkspaceMembership(workspaceId: string, userId: string, expectedUpdatedAt: string): Promise<RevokeWorkspaceMembershipResult>;

  createProject(project: Project): Promise<Project>;
  listProjectsForWorkspace(workspaceId: string): Promise<Project[]>;
  listProjectPinsForUser(userId: string): Promise<Array<{ projectId: string; pinnedAt: string }>>;
  setProjectPin(userId: string, projectId: string, pinnedAt: string | null): Promise<boolean>;
  findProject(id: string): Promise<Project | null>;
  updateProjectName(projectId: string, name: string, updatedAt: string, expectedName: string): Promise<Project | null>;
  beginProjectDeletion(id: string, updatedAt: string, expectedOwnerUserId?: string): Promise<SandboxGuardedDeletionResult<Project>>;
  setProjectLifecycleStatus(id: string, status: "active" | "archived", updatedAt: string): Promise<Project | null>;
  transferProjectOwner(projectId: string, fromUserId: string, toUserId: string, updatedAt: string): Promise<Project | null>;
  deleteProjectDependenciesAndProject(id: string): Promise<boolean>;
  deleteProjectAfterDependencies(id: string): Promise<boolean>;
  createFileLibrary(value: FileLibrary): Promise<FileLibrary | null>;
  findFileLibrary(id: string): Promise<FileLibrary | null>;
  listFileLibrariesForProject(projectId: string): Promise<FileLibrary[]>;
  renameFileLibrary(projectId: string, id: string, name: string, expectedUpdatedAt: string, updatedAt: string): Promise<FileLibrary | null>;
  deleteFileLibraryIfUnbound(projectId: string, id: string): Promise<"deleted" | "bound" | "not_found">;
  findTaskBoundToFileLibrary(fileLibraryId: string): Promise<FileLibraryBindingLookup>;
  createProjectContextEntry(value: ProjectContextEntry): Promise<ProjectContextEntry | null>;
  updateProjectContextEntry(value: ProjectContextEntry, expectedVersion: number): Promise<ProjectContextEntry | null>;
  listProjectContextEntries(workspaceId: string, projectId: string | null, scope: ProjectContextEntry["scope"], ownerUserId: string | null): Promise<ProjectContextEntry[]>;
  deleteProjectContextEntry(value: Pick<ProjectContextEntry, "id" | "workspaceId" | "projectId" | "scope" | "ownerUserId" | "version">): Promise<boolean>;
  createProjectAlertRule(value: ProjectAlertRule): Promise<ProjectAlertRule>;
  listProjectAlertRules(projectId: string): Promise<ProjectAlertRule[]>;
  updateProjectAlertRule(value: ProjectAlertRule, expectedUpdatedAt?: string): Promise<ProjectAlertRule | null>;
  deleteProjectAlertRule(projectId: string, id: string): Promise<boolean>;
  listProjectsForUser(userId: string): Promise<Project[]>;
  findProjectMembership(projectId: string, userId: string): Promise<ProjectMembership | null>;
  listProjectMemberships(projectId: string): Promise<ProjectMembershipView[]>;
  upsertProjectMembership(membership: ProjectMembership): Promise<ProjectMembership>;
  upsertProjectMembershipForWorkspaceMember(membership: ProjectMembership): Promise<ProjectMembership | null>;
  createProjectMembershipForWorkspaceMember(membership: ProjectMembership): Promise<CreateProjectMembershipResult>;
  updateProjectMembership(membership: ProjectMembership): Promise<ProjectMembership | null>;
  deleteProjectMembership(projectId: string, userId: string): Promise<boolean>;
  updateManagedProjectMembershipRole(projectId: string, userId: string, role: ManagedProjectMembershipRole, updatedAt: string, expectedUpdatedAt: string): Promise<ManagedProjectMembershipUpdateResult>;
  deleteManagedProjectMembership(projectId: string, userId: string, expectedUpdatedAt: string): Promise<ManagedProjectMembershipDeleteResult>;
  createProjectResourcePolicy(policy: ProjectResourcePolicy): Promise<ProjectResourcePolicy>;
  findProjectResourcePolicy(projectId: string): Promise<ProjectResourcePolicy | null>;
  patchProjectResourcePolicy(projectId: string, input: UpdateProjectResourcePolicyInput, updatedAt: string, expectedUpdatedAt?: string): Promise<ProjectResourcePolicy | null>;
  findProjectResourceUsage(projectId: string): Promise<ProjectResourceUsage | null>;
  upsertProjectResourceUsage(usage: ProjectResourceUsage): Promise<ProjectResourceUsage>;
  setProjectFileBytes(projectId: string, bytes: number, updatedAt: string): Promise<ProjectResourceUsage | null>;
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
  measureProjectProviderWindow(input:{projectId:string;endpointId:string;actorId:string|null;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;since:string}):Promise<{current:number;oldestReservedAt:string|null}>;
  measureProjectAlertRule(input:{projectId:string;alertType:ProjectAlert["type"];metric:import("../../contracts/src/api.js").AlertRuleMetric;windowSeconds:number|null;endpointId:string|null;now:string}):Promise<number>;
  upsertActiveProjectAlert(alert: ProjectAlert): Promise<ProjectAlert>;
  listActiveProjectAlerts(projectId: string): Promise<ProjectAlert[]>;
  listProjectAlerts(projectId: string): Promise<ProjectAlert[]>;
  queryProjectAlerts(projectId: string, query: import("../../contracts/src/api.js").ProjectAlertQuery): Promise<{ items: ProjectAlert[]; nextCursor: string | null }>;
  findProjectAlert(projectId: string, id: string): Promise<ProjectAlert | null>;
  transitionProjectAlert(projectId: string, id: string, status: Extract<ProjectAlert["status"], "resolved" | "dismissed">, updatedAt: string): Promise<ProjectAlert | null>;
  updateProjectAlertState(projectId:string,id:string,input:{acknowledgedAt?:string;acknowledgedBy?:string;silencedUntil?:string|null},updatedAt:string):Promise<ProjectAlert|null>;
  updateProjectAlertDeliveryStatus(projectId: string, id: string, status: ProjectAlert["deliveryStatus"], updatedAt: string): Promise<ProjectAlert | null>;
  appendProjectAuditEvent(event: ProjectAuditEvent): Promise<void>;
  listProjectAuditEvents(projectId: string): Promise<ProjectAuditEvent[]>;
  queryProjectAuditEvents(projectId: string, query: import("../../contracts/src/api.js").ProjectAuditQuery): Promise<{ items: ProjectAuditEvent[]; nextCursor: string | null }>;
  confirmSandboxRunStarted(input: ConfirmSandboxRunStartedInput): Promise<ConfirmSandboxRunStartedResult>;
  completeSandboxRunRelease(input: CompleteSandboxRunReleaseInput): Promise<CompleteSandboxRunReleaseResult>;
  listSandboxUsageSettlements(projectId: string, startedByUserId: string): Promise<SandboxUsageSettlement[]>;

  createProjectCredential(value: StoredProjectCredential): Promise<ProjectCredential>;
  findProjectCredential(id: string): Promise<StoredProjectCredential | null>;
  listProjectCredentials(projectId: string): Promise<ProjectCredential[]>;
  updateProjectCredential(value: StoredProjectCredential, expectedVersion: number): Promise<ProjectCredential | "not_found" | "version_conflict">;
  deleteProjectCredential(id: string, projectId: string, expectedVersion: number): Promise<DeleteProjectCredentialResult>;
  listLegacyEndpointCredentialAliases(): Promise<Array<{ endpointId: string; projectId: string; baseUrl: string; secretRef: string }>>;
  bindEndpointCredential(endpointId: string, credentialId: string): Promise<boolean>;

  createEndpoint(endpoint: ModelEndpoint, expectedCredentialVersion?: number): Promise<ModelEndpoint>;
  updateEndpoint(endpoint: ModelEndpoint, expectedUpdatedAt?: string, expectedCredentialVersion?: number): Promise<ModelEndpoint | null>;
  updateEndpointHealth(id: string, projectId: string, health: EndpointHealth, updatedAt: string, expectedUpdatedAt?: string, expectedCredentialVersion?: number): Promise<ModelEndpoint | null>;
  deleteEndpoint(id: string): Promise<DeleteEndpointResult>;
  listEndpointsForProject(projectId: string): Promise<ModelEndpoint[]>;
  findEndpoint(id: string): Promise<ModelEndpoint | null>;

  createProjectChatThread(thread: ProjectChatThread): Promise<ProjectChatThread>;
  createProjectChatBranch(thread: ProjectChatThread, messages: ProjectChatMessage[]): Promise<ProjectChatThread>;
  findProjectChatThread(id: string): Promise<ProjectChatThread | null>;
  listProjectChatThreads(projectId: string, ownerUserId: string): Promise<ProjectChatThread[]>;
  searchProjectChatThreads(projectId: string, ownerUserId: string, query: string): Promise<ProjectChatThread[]>;
  updateProjectChatThreadMetadata(id: string, metadata: Pick<ProjectChatThread, "title" | "pinnedAt" | "starredAt">, updatedAt: string): Promise<ProjectChatThread | null>;
  deleteProjectChatThread(id: string, deletedAt: string): Promise<DeleteProjectChatThreadResult>;
  touchProjectChatThread(id: string, updatedAt: string): Promise<ProjectChatThread | null>;
  appendProjectChatMessageIfCurrent(threadId: string, afterMessageId: string | null, message: ProjectChatMessage, untitledThreadTitle?: string): Promise<AppendProjectChatMessageResult>;
  appendProjectChatMessages(messages: ProjectChatMessage[]): Promise<void>;
  listProjectChatMessages(threadId: string): Promise<ProjectChatMessage[]>;
  updateProjectChatMessageDelivery(id: string, deliveryStatus: ProjectChatMessage["deliveryStatus"], updatedAt: string): Promise<ProjectChatMessage | null>;
  claimProjectChatMessageRetry(messageId: string, expectedVersion: number, updatedAt: string): Promise<ProjectChatMessage | null>;
  stageProjectChatResponse(userMessageId: string, assistantMessage: ProjectChatMessage): Promise<boolean>;
  finalizeProjectChatResponse(userMessageId: string): Promise<ProjectChatMessage | null>;
  editProjectChatMessageAndTruncate(threadId: string, messageId: string, expectedVersion: number, content: string, updatedAt: string): Promise<ProjectChatMessage | null>;
  deleteProjectChatMessageAndFollowing(threadId: string, messageId: string, expectedVersion: number): Promise<boolean>;

  createTaskAtomically(input: AtomicTaskCreateInput): Promise<AtomicTaskCreateResult>;
  restartTaskSandboxAtomically(input: AtomicTaskSandboxRestartInput): Promise<AtomicTaskSandboxRestartResult>;
  updateTask(task: PersistedAgentTask): Promise<PersistedAgentTask>;
  updateTaskStatusIfStarting(taskId: string, status: AgentTaskStatus, updatedAt: string): Promise<PersistedAgentTask | null>;
  updateTaskStatusIfNonterminal(taskId: string, status: AgentTaskStatus, updatedAt: string): Promise<PersistedAgentTask | null>;
  listActiveTasks(): Promise<PersistedAgentTask[]>;
  listTasksForProject(projectId: string): Promise<PersistedAgentTask[]>;
  queryTasksForProject(projectId: string, query: TaskStoreListQuery): Promise<TaskStoreListPage>;
  findTask(id: string): Promise<PersistedAgentTask | null>;
  updateTaskTitle(taskId: string, title: string, updatedAt: string, auditEvent?: ProjectAuditEvent): Promise<PersistedAgentTask | null>;
  archiveTask(taskId: string, archivedAt: string, auditEvent?: ProjectAuditEvent): Promise<PersistedAgentTask | null>;
  deleteTaskData(taskId: string, deletedAt: string): Promise<{ task: PersistedAgentTask; releasedArtifactBytes: number } | null>;
  listTaskStartIntentsDue(now: string, limit: number): Promise<PersistedAgentTask[]>;
  claimTaskStart(input: TaskDeliveryClaimInput): Promise<PersistedAgentTask | null>;
  reclaimTaskStart(input: TaskDeliveryReclaimInput): Promise<PersistedAgentTask | null>;
  recordTaskStartReceipt(input: TaskStartReceiptInput): Promise<PersistedAgentTask | null>;
  deferTaskStart(input: TaskDeliveryDeferInput): Promise<PersistedAgentTask | null>;
  failTaskStart(input: TaskDeliveryFailureInput): Promise<PersistedAgentTask | null>;
  beginTaskIdempotency(input: BeginTaskIdempotencyInput): Promise<TaskIdempotencyBeginResult>;
  completeTaskIdempotency(input: CompleteTaskIdempotencyInput): Promise<boolean>;
  requestTaskSandboxRelease(input: TaskSandboxReleaseMutationInput): Promise<TaskSandboxReleaseMutationResult>;
  completeTaskIdempotencyForResource(resourceId: string, responseStatus: number, responseBody: unknown, updatedAt: string): Promise<number>;
  persistTaskInteractionMutation(input: PersistTaskInteractionMutationInput): Promise<PersistTaskInteractionMutationResult>;
  readTaskInteractionSnapshot(taskId: string, before: TaskInteractionPageAnchor | null, limit: number): Promise<TaskInteractionStoreSnapshot | null>;
  listTaskInteractionChanges(taskId: string, afterChangeSeq: number, limit: number): Promise<PersistedTaskInteractionChange[]>;
  findLatestTaskInteractionChange(taskId: string, interactionId: string): Promise<PersistedTaskInteractionChange | null>;
  findTaskInteractionByCorrelation(taskId: string, correlation: TaskInteractionCorrelation): Promise<TaskInteractionItem | null>;
  appendTaskArtifacts(artifacts: PersistedTaskArtifact[]): Promise<void>;
  persistTaskArtifactProjection(input: PersistTaskArtifactProjectionInput): Promise<"created" | "existing">;
  listTaskArtifacts(taskId: string): Promise<PersistedTaskArtifact[]>;
  createTaskMessage(message: PersistedTaskMessage): Promise<PersistedTaskMessage>;
  createPendingTaskMessage(message: PersistedTaskMessage, interactionChange?: TaskInteractionChangeInput): Promise<PersistedTaskMessage | null>;
  listTaskMessages(taskId: string): Promise<PersistedTaskMessage[]>;
  findTaskMessage(id: string): Promise<PersistedTaskMessage | null>;
  updatePendingTaskMessage(id: string, content: string, requestHash: string, updatedAt: string, interactionChange?: TaskInteractionChangeInput): Promise<PersistedTaskMessage | null>;
  deleteQueuedTaskMessage(id: string, deletedAt: string, auditEvent?: ProjectAuditEvent): Promise<PersistedTaskMessage | null>;
  listTaskMessagesDue(now: string, limit: number): Promise<PersistedTaskMessage[]>;
  claimTaskMessage(input: TaskDeliveryClaimInput): Promise<PersistedTaskMessage | null>;
  reclaimTaskMessage(input: TaskDeliveryReclaimInput): Promise<PersistedTaskMessage | null>;
  recordTaskMessageReceipt(input: TaskMessageReceiptInput): Promise<PersistedTaskMessage | null>;
  deferTaskMessage(input: TaskDeliveryDeferInput): Promise<PersistedTaskMessage | null>;
  failTaskMessage(input: TaskDeliveryFailureInput): Promise<PersistedTaskMessage | null>;
  findTaskSummary(taskId: string): Promise<StoredTaskSummary | null>;
  listTaskSummariesForProject(projectId: string): Promise<StoredTaskSummary[]>;
}

export interface AtomicTaskCreateInput {
  task: PersistedAgentTask;
  initialMessage?: PersistedTaskMessage;
  newFileLibrary?: FileLibrary;
  reserveActive: boolean;
  runtimeState?: Record<string, unknown>;
  sandboxRun?: PersistedSandboxRunState;
}

export type AtomicTaskCreateResult=
  | {kind:"created";task:PersistedAgentTask}
  | {kind:"library_name_conflict"}
  | {kind:"library_not_found"}
  | {kind:"already_bound"}
  | {kind:"capacity_rejected"};

export interface AtomicTaskSandboxRestartInput {
  expectedReleasedRunId: string;
  task: PersistedAgentTask;
  runtimeState: Record<string, unknown>;
  sandboxRun: PersistedSandboxRunState;
  interruptedAt: string;
}

export type AtomicTaskSandboxRestartResult =
  | { kind: "restarted"; task: PersistedAgentTask }
  | { kind: "existing_active"; task: PersistedAgentTask }
  | { kind: "capacity_rejected" }
  | { kind: "conflict" };

export interface PersistTaskArtifactProjectionInput {
  projectId: string;
  artifact: PersistedTaskArtifact;
  auditEvent: ProjectAuditEvent;
  updatedAt: string;
}

export interface TaskStoreListQuery {
  search: string;
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

export interface StoredTaskSummary { taskId: string; artifactCount: number; updatedAt: string; }

export type TaskIdempotencyOperation = "create" | "message" | "message-edit" | "message-delete" | "abort-turn" | "work-stop" | "release-sandbox" | "edit" | "archive" | "delete" | "workspace.create" | "workspace.member.add" | "workspace.member.change" | "workspace.member.remove" | "workspace.settings.update" | "workspace.context.save" | "workspace.context.delete" | "workspace.archive" | "workspace.unarchive" | "workspace.owner.transfer" | "workspace.delete" | "project.create" | "project.member.add" | "project.member.change" | "project.member.remove" | "project.credential.create" | "project.credential.rotate" | "project.credential.delete" | "project.endpoint.create" | "project.endpoint.update" | "project.endpoint.models" | "project.endpoint.recheck" | "project.endpoint.delete" | "project.chat-thread.create" | "project.chat-thread.update" | "project.chat-thread.delete" | "project.chat-message.edit" | "project.chat-message.delete" | "project.chat-message.branch" | "project.context.save" | "project.context.delete" | "project.policy.update" | "project.alert.transition" | "project.alert.acknowledge" | "project.alert.silence" | "project.alert-rule.create" | "project.alert-rule.update" | "project.alert-rule.delete" | "project.file-library.create" | "project.file-library.update" | "project.file-library.delete" | "project.file.upload" | "project.file.delete" | "project.settings.update" | "project.archive" | "project.unarchive" | "project.owner.transfer" | "project.delete";

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
  endpointId: string | null;
  exceededLimits: Array<Extract<ProjectAlert["type"], "provider_tokens_limit" | "provider_cost_limit">>;
}

export interface LegacyExternalIdentityBinding {
  userId: string;
  issuer: string;
  subject: string;
  email: string;
  updatedAt: string;
}
