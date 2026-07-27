import type {
  AgentTask,
  AgentTaskArtifact,
  TaskHistoryStatus,
  TaskInteractionItem,
  AuthSession,
  EndpointHealth,
  FileLibrary,
  FileLibraryTaskLink,
  ModelEndpoint,
  ManagedProjectMembershipRole,
  ProjectMembership,
  ProjectMembershipView,
  ProjectMembershipCandidate,
  ProjectMembershipRole,
  ProjectAlert,
  ProjectAlertRuleView,
  ProjectAuditEvent,
  ProjectAuditEventView,
  ProjectAuditIdentity,
  ProjectAuditIdentityRole,
  ProjectResourcePolicy,
  ProjectResourcePolicyView,
  ProjectResourceUsage,
  ProviderUsage,
  ProjectProviderSettlement,
  Project,
  ProjectDirectoryItem,
  StoredUser,
  UpdateProjectResourcePolicyInput,
  User,
  UserProfilePreferences,
  UserNotification, ActiveProjectAlert, ProjectAlertRule, ProjectAlertType, ProjectAlertView, ProjectAlertCursorKey, ProjectCredential, StoredProjectCredential,
  ProjectContextEntry,
  ProjectContextEntryMetadata,
  Workspace,
  WorkspaceDirectoryItem,
  WorkspaceMembership,
  ManagedWorkspaceMembershipRole,
  WorkspaceMembershipView,
  WorkspaceMembershipRole,
  TaskListArchivedFilter,
  TaskListSort,
  TaskArtifactKind,
  SandboxRenderResult,
  SandboxResourceSnapshot,
  SandboxReleaseReason,
  SandboxFailureCode,
  ProjectSandboxLiveRun,
  ProjectSandboxSettledRun,
  ProjectUsageDay,
  ProjectUsageEndpoint,
  EndpointDirectoryMode,
  EndpointReadiness,
  EndpointView,
  TaskPresentation,
  SandboxRetryableErrorEnvelope,
  TaskMessageReceipt
} from "../../contracts/src/api.js";

export interface PersistedDeliveryReceipt {
  accepted: boolean;
  deliveryKey: string;
  requestHash: string;
  messageId?: string;
  cursor?: string;
}

export interface PersistedAgentTask extends Omit<AgentTask, "fileLibraryId"> {
  fileLibraryId: string | null;
  createdByUserId?: string | null;
  agentContext?: string;
  currentRunId: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
}

export interface PersistedTaskArtifact extends AgentTaskArtifact {
  fileId: string;
}

export interface ProjectAlertStoreQuery {
  view: ProjectAlertView;
  after?: ProjectAlertCursorKey;
  limit: number;
}

export interface ProjectAlertStorePage {
  items: ProjectAlert[];
  hasMore: boolean;
  activeCount: number;
}

export interface ProjectContextMetadataStoreQuery {
  workspaceId: string;
  projectId: string | null;
  scope: ProjectContextEntry["scope"];
  ownerUserId: string | null;
  afterContextKey?: string;
  limit: number;
}

export interface WorkspaceDirectoryStoreQuery {
  userId: string;
  after?: { createdAt: string; id: string };
  limit: number;
}

export interface ProjectDirectoryStoreQuery {
  userId: string;
  workspaceId: string;
  q: string;
  after?: { pinned: boolean; name: string; id: string };
  limit: number;
}

export interface ProjectDirectoryStorePage {
  items: ProjectDirectoryItem[];
  total: number;
}

export interface MembershipDirectoryStoreQuery<Role extends string> {
  q: string;
  role: Role | null;
  after?: { createdAt: string; userId: string };
  limit: number;
}

export interface ProjectMembershipCandidateStoreQuery {
  q: string;
  after?: { createdAt: string; userId: string };
  limit: number;
}

export interface ProjectMembershipCandidateStoreItem extends ProjectMembershipCandidate {
  createdAt: string;
}

export interface CreatedDirectoryStoreQuery {
  q:string;
  after?:{createdAt:string;id:string};
  limit:number;
}

export interface EndpointDirectoryStoreQuery extends CreatedDirectoryStoreQuery {
  mode:EndpointDirectoryMode;
}

export interface EndpointDirectoryStorePage {
  items:EndpointView[];
  total:number;
}

export interface ProjectAuditStoreQuery {
  actorId?: string | null;
  subjectUserId?: string | null;
  action?: import("../../contracts/src/api.js").ProjectAuditAction;
  status?: "accepted" | "rejected";
  resourceKind?: import("../../contracts/src/api.js").ProjectAuditResourceKind;
  resourceId?: string;
  from?: string;
  to?: string;
  after?: { createdAt:string; id:string };
  limit: number;
}

export interface ProjectAuditStorePage {
  items: ProjectAuditEventView[];
  hasMore: boolean;
}

export interface ProjectAuditIdentityStoreQuery {
  role: ProjectAuditIdentityRole;
  q: string;
  after?: { id:string };
  limit: number;
}

export interface ProjectAuditIdentityStorePage {
  items: ProjectAuditIdentity[];
  hasMore: boolean;
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

export interface PersistTaskInteractionMutationInput {
  taskId: string;
  changes: TaskInteractionChangeInput[];
  artifactProjections?: PersistTaskArtifactProjectionInput[];
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

export interface TaskInteractionChangeStorePage {
  changes: PersistedTaskInteractionChange[];
  upperChangeSeq: number;
  latestChangeSeq: number;
  queuedMessages: PersistedTaskMessage[];
  suppressedInteractionIds: string[];
  historyStatus: TaskHistoryStatus;
  lastSyncedAt: string | null;
}

export type JsonDocumentCollection =
  | "project_settings"
  | "endpoint_snapshots"
  | "sandbox_runtime_state";

export interface PostgresJsonDocStore {
  put(collection: JsonDocumentCollection, id: string, document: Record<string, unknown>): Promise<void>;
  get(collection: JsonDocumentCollection, id: string): Promise<Record<string, unknown> | null>;
  delete(collection: JsonDocumentCollection, id: string): Promise<void>;
}

export type PersistedSandboxRunStateValue = "starting" | "active" | "release_requested" | "failed" | "released";
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
  state: PersistedSandboxRunStateValue;
  image: string;
  pvcName: string;
  projectSubPath: string;
  fileLibraryRootSubPath:string;
  fileLibraryId: string;
  startedByUserId: string;
  startedAt: string | null;
  startupReadyAt: string | null;
  startupActionDeadlineAt: string | null;
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
  failureCode: SandboxFailureCode | null;
  failureCause: string | null;
  fencingToken: number;
  resumeUnfinished?: boolean;
  startupClaimToken?: string | null;
  startupLeaseExpiresAt?: string | null;
  cleanupClaimedAt?: string | null;
  cleanupAttempts?: number;
  lastCleanupAt?: string | null;
  lastCleanupError?: {
    at: string;
    target: string;
    message: string;
  } | null;
  releaseRequestedAt: string | null;
  failedAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxRunCleanupClaimInput {
  runId: string;
  expectedFencingToken: number;
  claimedAt: string;
}

export interface SandboxRunStore {
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

export interface SandboxRunFailureInput {
  runId: string;
  expectedFencingToken: number;
  code: SandboxFailureCode;
  message: string;
  failedAt: string;
  startupClaimToken?:string;
  terminalFailure?: PersistedSandboxTerminalFailure | null;
  auditEvent: ProjectAuditEvent;
}

export interface SandboxStartupOperationInput {
  taskId: string;
  runId: string;
  expectedFencingToken: number;
  claimToken: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export type SandboxStartupClaimResult =
  | { kind: "not_ready"; runId: string }
  | { kind: "in_progress"; runId: string }
  | { kind: "claimed"; runId: string; claim: string }
  | { kind: "stale" };

export interface CompleteSandboxStartupActionInput {
  taskId:string;
  runId:string;
  expectedFencingToken:number;
  claimToken:string;
  actionDeadlineAt:string;
  completedAt:string;
  leaseExpiresAt:string;
}

export interface BeginSandboxStartupActionInput {
  taskId:string;
  runId:string;
  expectedFencingToken:number;
  claimToken:string;
  actionDeadlineAt:string;
  startedAt:string;
}

export interface DrainSandboxStartupActionInput {
  taskId:string;
  runId:string;
  expectedFencingToken:number;
  claimToken:string;
  actionDeadlineAt:string;
  drainedAt:string;
  failureCode:SandboxFailureCode;
  failureMessage:string;
  auditEvent:ProjectAuditEvent;
}

export interface MarkTaskSandboxStartupReadyInput {
  taskId: string;
  runId: string;
  expectedFencingToken: number;
  readyAt: string;
}

export interface FailTaskSandboxStartupAtomicallyInput {
  failure: SandboxRunFailureInput;
  idempotency: CompleteTaskIdempotencyInput;
  taskId:string;
  startupClaimToken:string;
  resourceIdentity:PersistedSandboxRunResourceNames;
}

export type FailTaskSandboxStartupAtomicallyResult =
  | { kind: "failed"; run: PersistedSandboxRunState }
  | { kind: "replay"; responseStatus: number; responseBody: unknown }
  | { kind: "conflict" };

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

export interface ProjectUsageOverviewReadInput {
  projectId: string;
  userId: string;
  selectedUserId: string;
  periodStart: string;
  periodEnd: string;
  selectedEndpointId: string | null;
  measuredAt: string;
}

export interface ProjectProviderUsageRead {
  daily: ProjectUsageDay[];
  totals: { requests: number; tokens: number; cost: number };
  selectedEndpoint:{id:string;name:string}|null;
}

export interface ProjectSandboxUsageOverviewRead {
  unreleasedCount: number;
  launches: number;
  totalDurationMilliseconds: string;
  cpuRequestMillisMilliseconds: string;
  memoryRequestByteMilliseconds: string;
  liveRuns: ProjectSandboxLiveRun[];
}

export interface ProjectUsageOverviewRead {
  projectCreatedAt: string;
  policy: ProjectResourcePolicy;
  usage: ProjectResourceUsage | null;
  provider: ProjectProviderUsageRead;
  sandbox: ProjectSandboxUsageOverviewRead;
}

export type ProjectUsageOverviewReadResult =
  | { kind: "available"; value: ProjectUsageOverviewRead }
  | { kind: "project_not_found" | "policy_not_found" | "endpoint_not_found" | "selected_member_not_found" | "integrity_error" };

export interface ProjectEndpointUsageStoreQuery {
  projectId:string;
  userId:string;
  periodStart:string;
  periodEnd:string;
  measuredAt:string;
  q:string;
  after?:{createdAt:string;id:string};
  limit:number;
}

export interface ProjectEndpointUsageStoreItem extends ProjectUsageEndpoint {cursorCreatedAt:string;cursorId:string}
export interface ProjectEndpointUsageStorePage {items:ProjectEndpointUsageStoreItem[];total:number;hasMore:boolean}

export interface ProjectSandboxSettlementQuery {
  projectId: string;
  selectedUserId: string;
  scopeMeasuredAt: string;
  after?: { releasedAt: string; runId: string };
  limit: number;
}

export interface ProjectSandboxSettlementPage {
  items: ProjectSandboxSettledRun[];
  hasMore: boolean;
}

export interface ActivateTaskSandboxRunInput {
  taskId: string;
  runId: string;
  expectedFencingToken: number;
  startupClaimToken: string;
  actionDeadlineAt: string;
  activatedAt: string;
  auditEvent: ProjectAuditEvent;
}

export type ActivateTaskSandboxRunResult =
  | { kind: "activated" | "already_running"; task: PersistedAgentTask; run: PersistedSandboxRunState }
  | { kind: "conflict" };

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
export type FinalizeProjectDeletionResult = "deleted" | "not_ready";

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
  listWorkspaceDirectoryPage(query: WorkspaceDirectoryStoreQuery): Promise<WorkspaceDirectoryItem[]>;
  countProjectsForUserInWorkspace(userId: string, workspaceId: string): Promise<number>;
  findWorkspace(id: string): Promise<Workspace | null>;
  updateWorkspaceName(workspaceId: string, name: string, updatedAt: string, expectedName: string): Promise<Workspace | null>;
  beginWorkspaceDeletion(id: string, updatedAt: string, expectedOwnerUserId?: string): Promise<SandboxGuardedDeletionResult<Workspace>>;
  setWorkspaceLifecycleStatus(id: string, status: "active" | "archived", updatedAt: string): Promise<Workspace | null>;
  transferWorkspaceOwner(workspaceId: string, fromUserId: string, toUserId: string, updatedAt: string): Promise<Workspace | null>;
  deleteWorkspaceAfterProjects(id: string): Promise<boolean>;
  findWorkspaceMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null>;
  findWorkspaceMembershipView(workspaceId: string, userId: string): Promise<WorkspaceMembershipView | null>;
  listWorkspaceMembershipDirectoryPage(workspaceId: string, query: MembershipDirectoryStoreQuery<WorkspaceMembershipRole>): Promise<WorkspaceMembershipView[]>;
  upsertWorkspaceMembership(membership: WorkspaceMembership): Promise<WorkspaceMembership>;
  createWorkspaceMembership(membership: WorkspaceMembership): Promise<CreateWorkspaceMembershipResult>;
  updateWorkspaceMembership(membership: WorkspaceMembership): Promise<WorkspaceMembership | null>;
  updateManagedWorkspaceMembershipRole(workspaceId: string, userId: string, role: ManagedWorkspaceMembershipRole, updatedAt: string, expectedUpdatedAt: string): Promise<ManagedWorkspaceMembershipUpdateResult>;
  revokeWorkspaceMembership(workspaceId: string, userId: string, expectedUpdatedAt: string): Promise<RevokeWorkspaceMembershipResult>;

  createProject(project: Project): Promise<Project>;
  listProjectsForWorkspace(workspaceId: string): Promise<Project[]>;
  listProjectDirectoryPage(query: ProjectDirectoryStoreQuery): Promise<ProjectDirectoryStorePage>;
  findProjectDirectoryItem(userId: string, projectId: string): Promise<ProjectDirectoryItem | null>;
  setProjectPin(userId: string, projectId: string, pinnedAt: string | null): Promise<boolean>;
  findProject(id: string): Promise<Project | null>;
  updateProjectName(projectId: string, name: string, updatedAt: string, expectedName: string): Promise<Project | null>;
  beginProjectDeletion(id: string, updatedAt: string, expectedOwnerUserId?: string): Promise<SandboxGuardedDeletionResult<Project>>;
  setProjectLifecycleStatus(id: string, status: "active" | "archived", updatedAt: string): Promise<Project | null>;
  transferProjectOwner(projectId: string, fromUserId: string, toUserId: string, updatedAt: string): Promise<Project | null>;
  finalizeProjectDeletion(id: string, completion?: CompleteTaskIdempotencyInput): Promise<FinalizeProjectDeletionResult>;
  createFileLibrary(value: FileLibrary): Promise<FileLibrary | null>;
  findFileLibrary(id: string): Promise<FileLibrary | null>;
  listFileLibrariesForProject(projectId: string): Promise<FileLibrary[]>;
  renameFileLibrary(projectId: string, id: string, name: string, expectedUpdatedAt: string, updatedAt: string): Promise<FileLibrary | null>;
  beginFileLibraryDeletion(input: BeginFileLibraryDeletionInput): Promise<BeginFileLibraryDeletionResult>;
  claimFileLibraryDeletionOperation(input: ClaimFileLibraryDeletionOperationInput): Promise<ClaimFileLibraryDeletionOperationResult>;
  findFileLibraryDeletionOperation(owner: FileLibraryDeletionOperationOwner): Promise<FileDeletionOperationState | null>;
  persistFileLibraryDeletionOperation(owner: FileLibraryDeletionOperationOwner, state: FileDeletionOperationState, now: string): Promise<boolean>;
  renewFileLibraryDeletionOperation(owner: FileLibraryDeletionOperationOwner, leaseMs: number): Promise<boolean>;
  releaseFileLibraryDeletionOperation(owner: FileLibraryDeletionOperationOwner): Promise<boolean>;
  finalizeFileLibraryDeletion(input: FinalizeFileLibraryDeletionInput): Promise<"finalized" | "conflict">;
  findTaskBoundToFileLibrary(fileLibraryId: string): Promise<FileLibraryBindingLookup>;
  createProjectContextEntry(value: ProjectContextEntry): Promise<ProjectContextEntry | null>;
  updateProjectContextEntry(value: ProjectContextEntry, expectedVersion: number): Promise<ProjectContextEntry | null>;
  listProjectContextEntryMetadataPage(query: ProjectContextMetadataStoreQuery): Promise<ProjectContextEntryMetadata[]>;
  listProjectContextEntryPage(query: ProjectContextMetadataStoreQuery): Promise<ProjectContextEntry[]>;
  findProjectContextEntryByKey(workspaceId: string, projectId: string | null, scope: ProjectContextEntry["scope"], ownerUserId: string | null, contextKey: string): Promise<ProjectContextEntry | null>;
  findProjectContextEntryById(id: string, workspaceId: string, projectId: string | null, scope: ProjectContextEntry["scope"], ownerUserId: string | null): Promise<ProjectContextEntry | null>;
  deleteProjectContextEntry(value: Pick<ProjectContextEntry, "id" | "workspaceId" | "projectId" | "scope" | "ownerUserId" | "version">): Promise<boolean>;
  createProjectAlertRule(value: ProjectAlertRule): Promise<ProjectAlertRule | null>;
  listProjectAlertRules(projectId: string): Promise<ProjectAlertRule[]>;
  listProjectAlertRuleViews(projectId:string):Promise<ProjectAlertRuleView[]>;
  findProjectAlertRule(projectId: string, id: string): Promise<ProjectAlertRule | null>;
  findProjectAlertRuleView(projectId:string,id:string):Promise<ProjectAlertRuleView|null>;
  updateProjectAlertRule(value: ProjectAlertRule, expectedUpdatedAt?: string): Promise<ProjectAlertRule | null>;
  deleteProjectAlertRule(projectId: string, id: string): Promise<boolean>;
  findProjectMembership(projectId: string, userId: string): Promise<ProjectMembership | null>;
  findProjectMembershipView(projectId: string, userId: string): Promise<ProjectMembershipView | null>;
  listProjectMembershipDirectoryPage(projectId: string, query: MembershipDirectoryStoreQuery<ProjectMembershipRole>): Promise<ProjectMembershipView[]>;
  listProjectMembershipCandidatesPage(projectId: string, query: ProjectMembershipCandidateStoreQuery): Promise<ProjectMembershipCandidateStoreItem[]>;
  findProjectMembershipIdentities(projectId: string, userIds: string[]): Promise<ProjectMembershipCandidate[]>;
  listProjectMembershipsForFanout(projectId: string): Promise<ProjectMembership[]>;
  upsertProjectMembership(membership: ProjectMembership): Promise<ProjectMembership>;
  upsertProjectMembershipForWorkspaceMember(membership: ProjectMembership): Promise<ProjectMembership | null>;
  createProjectMembershipForWorkspaceMember(membership: ProjectMembership): Promise<CreateProjectMembershipResult>;
  updateProjectMembership(membership: ProjectMembership): Promise<ProjectMembership | null>;
  deleteProjectMembership(projectId: string, userId: string): Promise<boolean>;
  updateManagedProjectMembershipRole(projectId: string, userId: string, role: ManagedProjectMembershipRole, updatedAt: string, expectedUpdatedAt: string): Promise<ManagedProjectMembershipUpdateResult>;
  deleteManagedProjectMembership(projectId: string, userId: string, expectedUpdatedAt: string): Promise<ManagedProjectMembershipDeleteResult>;
  createProjectResourcePolicy(policy: ProjectResourcePolicy): Promise<ProjectResourcePolicy>;
  findProjectResourcePolicy(projectId: string): Promise<ProjectResourcePolicy | null>;
  findProjectResourcePolicyView(projectId:string):Promise<ProjectResourcePolicyView|null>;
  patchProjectResourcePolicy(projectId: string, input: UpdateProjectResourcePolicyInput, updatedAt: string, expectedUpdatedAt?: string): Promise<ProjectResourcePolicy | null>;
  findProjectResourceUsage(projectId: string): Promise<ProjectResourceUsage | null>;
  upsertProjectResourceUsage(usage: ProjectResourceUsage): Promise<ProjectResourceUsage>;
  setProjectFileBytes(projectId: string, bytes: number, measuredAt: string): Promise<ProjectResourceUsage | null>;
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
  readProjectUsageOverview(input: ProjectUsageOverviewReadInput): Promise<ProjectUsageOverviewReadResult>;
  queryProjectEndpointUsagePage(query:ProjectEndpointUsageStoreQuery):Promise<ProjectEndpointUsageStorePage>;
  measureProjectProviderWindow(input:{projectId:string;endpointId:string;actorId:string|null;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;since:string}):Promise<{current:number;oldestReservedAt:string|null}>;
  measureProjectAlertRule(input:{projectId:string;alertType:ProjectAlertType;metric:import("../../contracts/src/api.js").AlertRuleMetric;windowSeconds:number|null;endpointId:string|null;now:string}):Promise<number>;
  upsertActiveProjectAlert(alert: ActiveProjectAlert): Promise<ActiveProjectAlert>;
  queryProjectAlerts(projectId: string, query: ProjectAlertStoreQuery): Promise<ProjectAlertStorePage>;
  findActiveProjectAlert(projectId: string, type: ProjectAlertType, ruleId: string | null, endpointId: string | null, subjectActorId: string | null): Promise<ActiveProjectAlert | null>;
  findProjectAlert(projectId: string, id: string): Promise<ProjectAlert | null>;
  transitionProjectAlert(projectId: string, id: string, status: Extract<ProjectAlert["status"], "resolved" | "dismissed">, updatedAt: string): Promise<ProjectAlert | null>;
  updateProjectAlertState(projectId:string,id:string,input:{acknowledgedAt?:string;acknowledgedBy?:string;silencedUntil?:string|null},updatedAt:string):Promise<ProjectAlert|null>;
  updateProjectAlertDeliveryStatus(projectId: string, id: string, status: ProjectAlert["deliveryStatus"], updatedAt: string): Promise<ProjectAlert | null>;
  appendProjectAuditEvent(event: ProjectAuditEvent): Promise<void>;
  queryProjectAuditEvents(projectId: string, query: ProjectAuditStoreQuery): Promise<ProjectAuditStorePage>;
  queryProjectAuditIdentities(projectId:string,query:ProjectAuditIdentityStoreQuery):Promise<ProjectAuditIdentityStorePage>;
  activateTaskSandboxRun(input: ActivateTaskSandboxRunInput): Promise<ActivateTaskSandboxRunResult>;
  completeSandboxRunRelease(input: CompleteSandboxRunReleaseInput): Promise<CompleteSandboxRunReleaseResult>;
  failSandboxRun(input: SandboxRunFailureInput): Promise<PersistedSandboxRunState | null>;
  failTaskSandboxStartupAtomically(input: FailTaskSandboxStartupAtomicallyInput): Promise<FailTaskSandboxStartupAtomicallyResult>;
  markTaskSandboxStartupReady(input: MarkTaskSandboxStartupReadyInput): Promise<PersistedSandboxRunState | null>;
  claimSandboxStartup(input: SandboxStartupOperationInput): Promise<SandboxStartupClaimResult>;
  beginSandboxStartupAction(input:BeginSandboxStartupActionInput):Promise<PersistedSandboxRunState|null>;
  completeSandboxStartupAction(input:CompleteSandboxStartupActionInput):Promise<PersistedSandboxRunState|null>;
  drainSandboxStartupAction(input:DrainSandboxStartupActionInput):Promise<PersistedSandboxRunState|null>;
  querySandboxUsageSettlements(query: ProjectSandboxSettlementQuery): Promise<ProjectSandboxSettlementPage>;
  listSandboxUsageSettlements(projectId: string, startedByUserId: string): Promise<SandboxUsageSettlement[]>;

  createProjectCredential(value: StoredProjectCredential): Promise<ProjectCredential>;
  findStoredProjectCredential(projectId:string,id:string):Promise<StoredProjectCredential|null>;
  findProjectCredentialView(projectId:string,id:string):Promise<ProjectCredential|null>;
  listProjectCredentialDirectoryPage(projectId:string,query:CreatedDirectoryStoreQuery):Promise<ProjectCredential[]>;
  updateProjectCredential(value: StoredProjectCredential, expectedVersion: number): Promise<ProjectCredential | "not_found" | "version_conflict">;
  deleteProjectCredential(id: string, projectId: string, expectedVersion: number): Promise<DeleteProjectCredentialResult>;

  createEndpoint(endpoint: ModelEndpoint, expectedCredentialVersion?: number): Promise<ModelEndpoint>;
  updateEndpoint(endpoint: ModelEndpoint, expectedUpdatedAt?: string, expectedCredentialVersion?: number): Promise<ModelEndpoint | null>;
  updateEndpointHealth(id: string, projectId: string, health: EndpointHealth, updatedAt: string, expectedUpdatedAt?: string, expectedCredentialVersion?: number): Promise<ModelEndpoint | null>;
  deleteEndpoint(id: string): Promise<DeleteEndpointResult>;
  findEndpoint(id: string): Promise<ModelEndpoint | null>;
  findEndpointView(projectId:string,id:string):Promise<EndpointView|null>;
  listEndpointDirectoryPage(projectId:string,query:EndpointDirectoryStoreQuery):Promise<EndpointDirectoryStorePage>;
  projectEndpointNameExists(projectId:string,normalizedName:string,excludeId?:string):Promise<boolean>;
  findProjectEndpointIds(projectId:string,ids:string[]):Promise<string[]>;
  getProjectEndpointReadiness(projectId:string):Promise<{total:number}&EndpointReadiness>;

  createTaskAtomically(input: AtomicTaskCreateInput): Promise<AtomicTaskCreateResult>;
  beginTerminalStart(input:BeginTerminalStartInput):Promise<BeginTerminalStartResult>;
  restartTaskSandboxAtomically(input: AtomicTaskSandboxRestartInput): Promise<AtomicTaskSandboxRestartResult>;
  createTaskMessageAtomically(input: AtomicTaskMessageInput): Promise<AtomicTaskMessageResult>;
  editTaskMessageAtomically(input: AtomicTaskMessageEditInput): Promise<AtomicTaskMessageEditResult>;
  deleteTaskMessageAtomically(input: AtomicTaskMessageDeleteInput): Promise<AtomicTaskMessageDeleteResult>;
  updateTask(task: PersistedAgentTask): Promise<PersistedAgentTask>;
  listActiveTasks(): Promise<PersistedAgentTask[]>;
  listTasksForProject(projectId: string): Promise<PersistedAgentTask[]>;
  queryTasksForProject(projectId: string, query: TaskStoreListQuery): Promise<TaskStoreListPage>;
  findTask(id: string): Promise<PersistedAgentTask | null>;
  updateTaskTitle(taskId: string, title: string, updatedAt: string, auditEvent?: ProjectAuditEvent): Promise<PersistedAgentTask | null>;
  archiveTask(taskId: string, archivedAt: string, auditEvent?: ProjectAuditEvent): Promise<SandboxGuardedDeletionResult<PersistedAgentTask>>;
  beginTaskDeletion(taskId: string, deletedAt: string, auditEvent?: ProjectAuditEvent): Promise<SandboxGuardedDeletionResult<PersistedAgentTask>>;
  purgeDeletedTaskData(taskId: string, idempotency?: CompleteTaskIdempotencyInput): Promise<boolean>;
  beginTaskIdempotency(input: BeginTaskIdempotencyInput): Promise<TaskIdempotencyBeginResult>;
  beginTaskControlCommand(input:BeginTaskControlCommandInput):Promise<BeginTaskControlCommandResult>;
  listInProgressTaskControlCommands(limit:number):Promise<InProgressTaskControlCommand[]>;
  findTaskIdempotency(input: TaskIdempotencyLookupInput): Promise<TaskIdempotencyBeginResult | null>;
  findTaskIdempotencyByResource(input: TaskIdempotencyResourceLookupInput): Promise<TaskIdempotencyBeginResult | null>;
  findFileDeletionOperation(owner: FileDeletionOperationOwner): Promise<FileDeletionOperationState | null>;
  persistFileDeletionOperation(owner: FileDeletionOperationOwner, state: FileDeletionOperationState): Promise<boolean>;
  findInProgressTerminalStartOperation(runId:string):Promise<InProgressTerminalStartOperation|null>;
  findTaskPreparationOperation(taskId:string):Promise<TaskPreparationOperation|null>;
  completeTaskIdempotency(input: CompleteTaskIdempotencyInput): Promise<boolean>;
  requestTaskSandboxRelease(input: TaskSandboxReleaseMutationInput): Promise<TaskSandboxReleaseMutationResult>;
  completeTaskIdempotencyForResource(input: CompleteTaskIdempotencyForResourceInput): Promise<number>;
  persistTaskInteractionMutation(input: PersistTaskInteractionMutationInput): Promise<PersistTaskInteractionMutationResult>;
  readTaskInteractionSnapshot(taskId: string, before: TaskInteractionPageAnchor | null, limit: number): Promise<TaskInteractionStoreSnapshot | null>;
  readTaskInteractionChangePage(taskId: string, afterChangeSeq: number, limit: number): Promise<TaskInteractionChangeStorePage | null>;
  listTaskInteractionChanges(taskId: string, afterChangeSeq: number, limit: number): Promise<PersistedTaskInteractionChange[]>;
  findLatestTaskInteractionChange(taskId: string, interactionId: string): Promise<PersistedTaskInteractionChange | null>;
  findTaskInteractionByCorrelation(taskId: string, correlation: TaskInteractionCorrelation): Promise<TaskInteractionItem | null>;
  appendTaskArtifacts(artifacts: PersistedTaskArtifact[]): Promise<void>;
  persistTaskArtifactProjection(input: PersistTaskArtifactProjectionInput): Promise<"created" | "existing">;
  queryTaskArtifacts(taskId: string, query: TaskArtifactStoreListQuery): Promise<TaskArtifactStoreListPage>;
  findTaskArtifact(taskId: string, artifactId: string): Promise<PersistedTaskArtifact | null>;
  findExistingTaskArtifactFileIds(taskId: string, fileIds: string[]): Promise<string[]>;
  createTaskMessage(message: PersistedTaskMessage): Promise<PersistedTaskMessage>;
  createPendingTaskMessage(message: PersistedTaskMessage, interactionChange: TaskInteractionChangeInput): Promise<PersistedTaskMessage | null>;
  listTaskMessages(taskId: string): Promise<PersistedTaskMessage[]>;
  findTaskMessage(id: string): Promise<PersistedTaskMessage | null>;
  listTaskMessagesDue(now: string, limit: number): Promise<PersistedTaskMessage[]>;
  claimTaskMessage(input: TaskDeliveryClaimInput): Promise<PersistedTaskMessage | null>;
  reclaimTaskMessage(input: TaskDeliveryReclaimInput): Promise<PersistedTaskMessage | null>;
  recordTaskMessageReceipt(input: TaskMessageReceiptInput): Promise<PersistedTaskMessage | null>;
  deferTaskMessage(input: TaskDeliveryDeferInput): Promise<PersistedTaskMessage | null>;
  failTaskMessage(input: TaskDeliveryFailureInput): Promise<PersistedTaskMessage | null>;
}

export interface AtomicTaskCreateInput {
  task: PersistedAgentTask;
  initialMessage?: PersistedTaskMessage;
  initialInteractionChange?: TaskInteractionChangeInput;
  newFileLibrary?: FileLibrary;
  reserveActive: boolean;
  admission: SandboxAdmissionInput;
  idempotency?: BeginTaskIdempotencyInput;
  rejectionPresentation?: null;
  rejectedAuditEvent?: ProjectAuditEvent;
  runtimeState?: Record<string, unknown>;
  sandboxRun?: PersistedSandboxRunState;
  auditEvent?: ProjectAuditEvent;
}

export interface SandboxAdmissionInput {
  namespace: string;
  namespaceLimit: number;
}

export type SandboxAdmissionRejection =
  | {
      kind: "project_capacity_rejected";
      activeSandboxes: number;
      sandboxLimit: number;
    }
  | { kind: "substrate_capacity_rejected" };

export type SandboxCapacityRejected = {
  kind: "capacity_rejected";
  admission: SandboxAdmissionRejection;
  responseStatus: 409;
  responseBody: SandboxRetryableErrorEnvelope;
};

export type AtomicAdmissionIdempotencyResult =
  | {kind:"hash_mismatch"}
  | {kind:"in_progress"}
  | {kind:"replay";responseStatus:number;responseBody:unknown};

export type AtomicTaskCreateDeterministicRejection={
  kind:"project_unavailable"|"library_name_conflict"|"library_not_found"|"library_deleting"|"already_bound";
  claimToken?:string;
};

export type AtomicTaskCreateResult=
  | {kind:"created";task:PersistedAgentTask}
  | {kind:"resume";task:PersistedAgentTask;claimToken:string}
  | AtomicTaskCreateDeterministicRejection
  | SandboxCapacityRejected
  | Exclude<AtomicAdmissionIdempotencyResult,{kind:"in_progress"}>
  | {kind:"in_progress";resourceId:string};

export interface AtomicTaskSandboxRestartInput {
  // Null is the first-Run case and is valid only while the Task has no current Run.
  expectedReleasedRunId: string | null;
  task: PersistedAgentTask;
  runtimeState: Record<string, unknown>;
  sandboxRun: PersistedSandboxRunState;
  reservedAt: string;
  admission: SandboxAdmissionInput;
  idempotency: BeginTaskIdempotencyInput;
  rejectionPresentation: TaskPresentation;
  rejectedAuditEvent: ProjectAuditEvent;
}

export type AtomicTaskSandboxRestartResult =
  | { kind: "restarted"; task: PersistedAgentTask }
  | SandboxCapacityRejected
  | { kind: "conflict" }
  | AtomicAdmissionIdempotencyResult;

export interface BeginTerminalStartInput {
  taskId:string;
  idempotency:BeginTaskIdempotencyInput;
  admission?:SandboxAdmissionInput;
  restart?:{
    expectedReleasedRunId:string|null;
    task:PersistedAgentTask;
    runtimeState:Record<string,unknown>;
    sandboxRun:PersistedSandboxRunState;
    reservedAt:string;
  };
  rejectionPresentation:TaskPresentation;
  rejectedAuditEvent?:ProjectAuditEvent;
}

export type BeginTerminalStartResult =
  | {kind:"claimed";task:PersistedAgentTask;run:PersistedSandboxRunState;claimToken:string}
  | {kind:"in_progress";task:PersistedAgentTask;run:PersistedSandboxRunState}
  | {kind:"replay";responseStatus:number;responseBody:unknown}
  | {kind:"hash_mismatch"}
  | {kind:"conflict"}
  | SandboxCapacityRejected;

export interface AtomicTaskMessageInput {
  taskId: string;
  expectedCurrentRunId: string | null;
  message: PersistedTaskMessage;
  idempotency: BeginTaskIdempotencyInput;
  auditEvent: ProjectAuditEvent;
  admission: SandboxAdmissionInput;
  rejectionPresentation: TaskPresentation;
  rejectedAuditEvent: ProjectAuditEvent;
  responseStatus: number;
  responseBody: unknown;
  interactionChange: TaskInteractionChangeInput;
  restart?: {
    task: PersistedAgentTask;
    runtimeState: Record<string, unknown>;
    sandboxRun: PersistedSandboxRunState;
    reservedAt: string;
  };
}

export type AtomicTaskMessageResult =
  | { kind: "created"; task: PersistedAgentTask; message: PersistedTaskMessage; restarted: boolean }
  | SandboxCapacityRejected
  | { kind: "hash_mismatch" }
  | { kind: "in_progress" }
  | { kind: "replay"; responseStatus: number; responseBody: unknown }
  | { kind: "conflict" };

interface AtomicTaskMessageMutationInput {
  taskId: string;
  messageId: string;
  idempotency: BeginTaskIdempotencyInput;
  auditEvent: ProjectAuditEvent;
  responseStatus: number;
  responseBody: unknown;
}

export interface AtomicTaskMessageEditInput extends AtomicTaskMessageMutationInput {
  content: string;
  requestHash: string;
  expectedUpdatedAt: string;
  updatedAt: string;
  interactionChange: TaskInteractionChangeInput;
}

export interface AtomicTaskMessageDeleteInput extends AtomicTaskMessageMutationInput {
  deletedAt: string;
}

type AtomicTaskMessageMutationReplay =
  | { kind: "hash_mismatch" }
  | { kind: "in_progress" }
  | { kind: "replay"; responseStatus: number; responseBody: unknown }
  | { kind: "conflict" };

export type AtomicTaskMessageEditResult =
  | { kind: "updated"; message: PersistedTaskMessage }
  | AtomicTaskMessageMutationReplay;

export type AtomicTaskMessageDeleteResult =
  | { kind: "deleted"; message: PersistedTaskMessage }
  | AtomicTaskMessageMutationReplay;

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
  after?: {
    value: string;
    taskId: string;
  };
  limit: number;
}

export interface TaskStoreListPage {
  items: PersistedAgentTask[];
  total: number;
  hasMore: boolean;
}

export interface TaskArtifactStoreListQuery {
  kind: TaskArtifactKind | null;
  mediaType: string | null;
  previewOnly: boolean;
  after?: {
    createdAt: string;
    artifactId: string;
  };
  limit: number;
}

export interface TaskArtifactStoreListPage {
  items: PersistedTaskArtifact[];
  hasMore: boolean;
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

export interface TaskMessageReceiptInput {
  id: string;
  claimToken: string;
  receipt: PersistedDeliveryReceipt;
  timelineCursor: string | null;
  updatedAt: string;
}

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


export type TaskIdempotencyOperation = "create" | "message" | "terminal-start" | "message-edit" | "message-delete" | "abort-turn" | "work-stop" | "release-sandbox" | "edit" | "archive" | "delete" | "workspace.create" | "workspace.member.add" | "workspace.member.change" | "workspace.member.remove" | "workspace.settings.update" | "workspace.context.save" | "workspace.context.delete" | "workspace.archive" | "workspace.unarchive" | "workspace.owner.transfer" | "workspace.delete" | "project.create" | "project.member.add" | "project.member.change" | "project.member.remove" | "project.credential.create" | "project.credential.rotate" | "project.credential.delete" | "project.endpoint.create" | "project.endpoint.update" | "project.endpoint.models" | "project.endpoint.recheck" | "project.endpoint.delete" | "project.context.save" | "project.context.delete" | "project.policy.update" | "project.alert.transition" | "project.alert.acknowledge" | "project.alert.silence" | "project.alert-rule.create" | "project.alert-rule.update" | "project.alert-rule.delete" | "project.file-library.create" | "project.file-library.update" | "project.file-library.delete" | "project.file.upload" | "project.file.delete" | "project.settings.update" | "project.archive" | "project.unarchive" | "project.owner.transfer" | "project.delete";

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

export interface ClaimedTaskIdempotencyOperation extends TaskIdempotencyScope {
  requestHash: string;
  resourceId: string;
  claimToken: string;
}

export interface TaskControlCommandEnvelope {
  taskId:string;
  expectedRunId:string;
  interactionId:string|null;
  downstreamCommandKey:string;
  downstreamTargetId:string;
}

export interface BeginTaskControlCommandInput {
  taskId:string;
  expectedRunId:string;
  interactionId:string|null;
  downstreamCommandKey:string;
  downstreamTargetId:string|null;
  idempotency:BeginTaskIdempotencyInput&{operation:"abort-turn"|"work-stop"};
}

export interface InProgressTaskControlCommand extends TaskControlCommandEnvelope, ClaimedTaskIdempotencyOperation {
  operation:"abort-turn"|"work-stop";
}

export type BeginTaskControlCommandResult =
  | {kind:"claimed";command:InProgressTaskControlCommand}
  | {kind:"in_progress";command:TaskControlCommandEnvelope}
  | {kind:"replay";responseStatus:number;responseBody:unknown}
  | {kind:"hash_mismatch"|"target_conflict"|"interaction_not_found"|"target_not_stoppable"};

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

export interface CompleteTaskIdempotencyForResourceInput {
  projectId: string;
  operation: TaskIdempotencyOperation;
  resourceId: string;
  responseStatus: number;
  responseBody: unknown;
  updatedAt: string;
}

export interface TaskMessageIdempotencyEnvelope {
  kind: "task_message";
  messageId: string;
  taskId: string;
  projectId: string;
  actorId: string;
  receipt: TaskMessageReceipt;
}

export interface TaskCreateIdempotencyEnvelope {
  kind:"task_create";
  taskId:string;
  projectId:string;
  actorId:string;
}

export interface TaskIdempotencyLookupInput extends TaskIdempotencyScope {
  requestHash: string;
}

export interface TaskIdempotencyResourceLookupInput {
  actorId: string;
  operation: TaskIdempotencyOperation;
  key: string;
  requestHash: string;
  resourceId: string;
}

export interface BeginFileLibraryDeletionInput {
  libraryId: string;
  idempotency: BeginTaskIdempotencyInput & {
    operation: "project.file-library.delete";
  };
}

export type BeginFileLibraryDeletionResult =
  | { kind: "claimed"; library: FileLibrary; operationId: string; receiptClaimToken: string }
  | { kind: "bound"; task: FileLibraryTaskLink; receiptClaimToken: string }
  | { kind: "not_found"; receiptClaimToken: string }
  | { kind: "in_progress"; resourceId: string }
  | { kind: "replay"; resourceId: string; responseStatus: number; responseBody: unknown }
  | { kind: "hash_mismatch" };

export interface FileLibraryDeletionOperationOwner {
  projectId: string;
  libraryId: string;
  operationId: string;
  claimToken: string;
}

export interface ClaimFileLibraryDeletionOperationInput extends FileLibraryDeletionOperationOwner {
  now: string;
  leaseMs: number;
}

export type ClaimFileLibraryDeletionOperationResult =
  | { kind: "claimed"; state: FileDeletionOperationState | null }
  | { kind: "in_progress" }
  | { kind: "conflict" };

export interface FinalizeFileLibraryDeletionInput extends FileLibraryDeletionOperationOwner {
  actorId: string;
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
  updatedAt: string;
}

export type FileDeletionOperationOwner = ClaimedTaskIdempotencyOperation & {
  operation: "project.file.delete";
};
export type FileDeletionOperationPhase = "isolated" | "removed";
export type FileDeletionOperationEntryType = "file" | "directory" | "symlink" | "unsupported";
export interface FileDeletionOperationState {
  phase: FileDeletionOperationPhase;
  quarantineDevice: string;
  quarantineInode: string;
  entryType: FileDeletionOperationEntryType;
  bytes: number;
}

export function isFileDeletionOperationTransition(
  current: FileDeletionOperationState | null,
  next: FileDeletionOperationState
): boolean {
  if (!isValidFileDeletionOperationState(next) || current && !isValidFileDeletionOperationState(current)) return false;
  if (!current) return next.phase === "isolated";
  if (
    current.quarantineDevice !== next.quarantineDevice ||
    current.quarantineInode !== next.quarantineInode ||
    current.entryType !== next.entryType ||
    current.bytes !== next.bytes
  ) return false;
  if (current.phase === "isolated") return next.phase === "isolated" || next.phase === "removed";
  return next.phase === "removed";
}

export function isValidFileDeletionOperationState(state: FileDeletionOperationState): boolean {
  return (state.phase === "isolated" || state.phase === "removed") &&
    /^[0-9]+$/.test(state.quarantineDevice) &&
    /^[0-9]+$/.test(state.quarantineInode) &&
    ["file", "directory", "symlink", "unsupported"].includes(state.entryType) &&
    Number.isSafeInteger(state.bytes) &&
    state.bytes >= 0;
}

export interface TaskPreparationOperation {
  actorId:string;
  projectId:string;
  operation:"create";
  key:string;
  requestHash:string;
  resourceId:string;
  claimToken:string;
}

export interface InProgressTerminalStartOperation {
  actorId:string;
  projectId:string;
  operation:"terminal-start";
  key:string;
  requestHash:string;
  resourceId:string;
  claimToken:string;
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
  delta: Pick<ProjectResourceUsage, "activeSandboxes" | "providerRequests" | "providerTokens" | "providerCost" | "projectFileBytes">;
  limit?: ProjectAlertType;
  updatedAt: string;
}

export interface ProjectProviderUsageSettlement {
  usage: ProjectResourceUsage;
  endpointId: string | null;
  actorId: string | null;
  exceededLimits: Array<Extract<ProjectAlertType, "provider_requests_limit" | "provider_tokens_limit" | "provider_cost_limit">>;
}

export interface LegacyExternalIdentityBinding {
  userId: string;
  issuer: string;
  subject: string;
  email: string;
  updatedAt: string;
}
