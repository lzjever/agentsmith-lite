import type {
  TaskInteractionItem,
  TaskPresentation,
  AuthSession,
  EndpointHealth,
  FileLibrary,
  ModelEndpoint,
  ManagedProjectMembershipRole,
  Project,
  ProjectMembership, ProjectMembershipView,
  ActiveProjectAlert,
  ProjectAlert,
  ProjectAuditEvent,
  ProjectResourcePolicy,
  ProjectResourceUsage,
  ProviderUsage,
  ProjectProviderSettlement,
  StoredUser,
  UpdateProjectResourcePolicyInput,
  User,
  Workspace,
  ManagedWorkspaceMembershipRole,
  UserProfilePreferences, ProjectCredential, StoredProjectCredential, ProjectContextEntry, UserNotification, ProjectAlertRule, ProjectAlertType, WorkspaceMembership, WorkspaceMembershipView, WorkspaceDirectoryItem, ProjectDirectoryItem
} from "../../contracts/src/api.js";
import { classifyPreviewMediaType, isActiveProjectAlert, sandboxCapacityErrorEnvelope, sanitizeProjectAuditDetail } from "../../contracts/src/api.js";
import { CredentialVersionConflictError, EndpointNameConflictError, isFileDeletionOperationTransition } from "../../ports/src/store.js";
import { USER_NOTIFICATION_INBOX_LIMIT } from "./notificationRetention.js";
import { strictStructuralEqual } from "./strictStructuralEqual.js";
import type {
  AcquireLeaseInput,
  AcquireLeaseResult,
  JsonDocumentCollection,
  LeaseRecord,
  PostgresJsonDocStore,
  PostgresLeaseStore,
  PersistedSandboxRunState,
  SandboxRunCleanupClaimInput,
  LegacyExternalIdentityBinding,
  ProductStore,
  ProjectProviderUsageSettlement, ReserveProjectProviderSettlementInput,
  ProjectUsageOverviewReadInput,
  ProjectUsageOverviewReadResult,
  ProjectSandboxSettlementQuery,
  ProjectSandboxSettlementPage,
  ProjectResourceUsageAdjustment,
  AtomicTaskCreateInput,
  AtomicTaskCreateDeterministicRejection,
  AtomicTaskSandboxRestartInput,
  AtomicTaskSandboxRestartResult,
  AtomicTaskMessageInput,
  AtomicTaskMessageResult,
  AtomicTaskMessageEditInput,
  AtomicTaskMessageEditResult,
  AtomicTaskMessageDeleteInput,
  AtomicTaskMessageDeleteResult,
  SandboxAdmissionInput,
  SandboxAdmissionRejection,
  SandboxCapacityRejected,
  SandboxRunStore,
  TaskStoreListQuery,
  TaskStoreListPage,
  TaskArtifactStoreListQuery,
  TaskArtifactStoreListPage,
  TaskDeliveryClaimInput,
  TaskDeliveryReclaimInput,
  TaskMessageReceiptInput,
  TaskDeliveryDeferInput,
  TaskDeliveryFailureInput,
  BeginTaskIdempotencyInput,
  BeginTaskControlCommandInput,
  BeginTaskControlCommandResult,
  InProgressTaskControlCommand,
  TaskIdempotencyBeginResult,
  CompleteTaskIdempotencyInput,
  CompleteTaskIdempotencyForResourceInput,
  BeginFileLibraryDeletionInput,
  BeginFileLibraryDeletionResult,
  ClaimFileLibraryDeletionOperationInput,
  ClaimFileLibraryDeletionOperationResult,
  FileLibraryDeletionOperationOwner,
  FinalizeFileLibraryDeletionInput,
  FileDeletionOperationOwner,
  FileDeletionOperationState,
  TaskIdempotencyLookupInput,
  TaskIdempotencyResourceLookupInput,
  TaskSandboxReleaseMutationInput,
  TaskSandboxReleaseMutationResult,
  ActivateTaskSandboxRunInput,
  ActivateTaskSandboxRunResult,
  CompleteSandboxRunReleaseInput,
  CompleteSandboxRunReleaseResult,
  FailTaskSandboxStartupAtomicallyInput,
  FailTaskSandboxStartupAtomicallyResult,
  SandboxRunFailureInput,
  SandboxStartupOperationInput,
  SandboxUsageSettlement,
  PersistTaskArtifactProjectionInput,
  DeleteEndpointResult,
  DeleteProjectCredentialResult,
  FinalizeProjectDeletionResult,
  ManagedProjectMembershipDeleteResult,
  ManagedProjectMembershipUpdateResult,
  ManagedWorkspaceMembershipUpdateResult,
  CreateWorkspaceMembershipResult,
  CreateProjectMembershipResult,
  PersistedAgentTask,
  PersistedTaskArtifact,
  PersistedTaskMessage,
  PersistTaskInteractionMutationInput,
  PersistTaskInteractionMutationResult,
  PersistedTaskInteractionChange,
  TaskInteractionChangeInput,
  TaskInteractionChangeStorePage,
  TaskInteractionCorrelation,
  TaskInteractionPageAnchor,
  TaskInteractionStoreSnapshot
} from "../../ports/src/store.js";
import { createPostgresProductStore } from "./postgresProductStore.js";

export function createInMemoryProductStore(): ProductStore {
  const connectionString = process.env.POSTGRES_APP_URL?.trim();
  if (connectionString) {
    return createPostgresProductStore(connectionString);
  }
  return createLocalInMemoryProductStore();
}

export function createLocalInMemoryProductStore(): InMemoryProductStore {
  return new InMemoryProductStore();
}

export class InMemoryProductStore implements ProductStore {
  observedExternalModelCalls = 0;

  readonly jsonDocs: PostgresJsonDocStore = new InMemoryJsonDocStore();
  readonly leases: PostgresLeaseStore = new InMemoryLeaseStore();
  private readonly sandboxRunRecords = new InMemorySandboxRunStore();
  readonly sandboxRuns:SandboxRunStore={
    get:(runId)=>this.sandboxRunRecords.get(runId),
    list:()=>this.sandboxRunRecords.list(),
    listActive:()=>this.sandboxRunRecords.listActive(),
    claimForCleanup:(input)=>this.sandboxRunRecords.claimForCleanup(input),
    updateWithFencing:(runId,expectedFencingToken,run)=>this.sandboxRunRecords.updateWithFencing(runId,expectedFencingToken,run)
  };

  private readonly users = new Map<string, StoredUser>();
  private readonly sessions = new Map<string, AuthSession>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly projects = new Map<string, Project>();
  private readonly fileLibraries = new Map<string, FileLibrary>();
  private readonly fileLibraryDeletions = new Map<string, InMemoryFileLibraryDeletion>();
  private readonly memberships = new Map<string, ProjectMembership>();
  private readonly projectPins = new Map<string, { projectId: string; userId: string; pinnedAt: string }>();
  private readonly workspaceMemberships = new Map<string, WorkspaceMembership>();
  private readonly policies = new Map<string, ProjectResourcePolicy>();
  private readonly usage = new Map<string, ProjectResourceUsage>();
  private readonly providerSettlements = new Map<string, ProjectProviderSettlement>();
  private readonly sandboxUsageSettlements = new Map<string, SandboxUsageSettlement>();
  private readonly alerts = new Map<string, ProjectAlert>();
  private readonly auditEvents: ProjectAuditEvent[] = [];
  private readonly endpoints = new Map<string, ModelEndpoint>();
  private readonly tasks = new Map<string, PersistedAgentTask>();
  private readonly interactionChanges: PersistedTaskInteractionChange[] = [];
  private readonly interactionSync = new Map<string, { sourceCursor: string | null; historyStatus: "complete" | "gap"; lastSyncedAt: string | null }>();
  private readonly artifacts: PersistedTaskArtifact[] = [];
  private readonly taskIdempotency = new Map<string, InMemoryTaskIdempotencyRecord>();
  private taskMutationTail: Promise<void> = Promise.resolve();
  private readonly profiles = new Map<string, UserProfilePreferences>(); private readonly notifications = new Map<string, UserNotification>(); private readonly notificationDedupe = new Map<string, string>(); private readonly credentials = new Map<string, StoredProjectCredential>(); private readonly contexts = new Map<string, ProjectContextEntry>(); private readonly alertRules = new Map<string, ProjectAlertRule>(); private readonly messages: PersistedTaskMessage[] = [];

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async createUser(user: StoredUser): Promise<User> {
    if (this.users.has(user.id)) {
      const error = new Error(`duplicate key value violates unique constraint users_pkey`) as Error & { code?: string };
      error.code = "23505";
      throw error;
    }
    this.users.set(user.id, clone(user));
    return publicUser(user);
  }

  async updateUser(user: StoredUser): Promise<User> {
    this.users.set(user.id, clone(user));
    return publicUser(user);
  }

  async bindLegacyExternalIdentity(input: LegacyExternalIdentityBinding): Promise<StoredUser | null> {
    const user = this.users.get(input.userId);
    if (!user
      || user.oidcIssuer !== undefined
      || user.oidcSubject !== undefined
      || user.email.toLowerCase() !== input.email.toLowerCase()) {
      return null;
    }
    const bound: StoredUser = {
      ...user,
      email: input.email,
      oidcIssuer: input.issuer,
      oidcSubject: input.subject,
      emailVerified: true,
      updatedAt: input.updatedAt
    };
    this.users.set(bound.id, clone(bound));
    return clone(bound);
  }

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const normalized = email.toLowerCase();
    return clone([...this.users.values()].find((user) => user.email.toLowerCase() === normalized) ?? null);
  }

  async findVerifiedUserByEmail(email: string): Promise<StoredUser | null> {
    const user = await this.findUserByEmail(email);
    return user?.emailVerified ? user : null;
  }

  async findUserByOidcSubject(issuer: string, subject: string): Promise<StoredUser | null> {
    return clone([...this.users.values()].find((user) => user.oidcIssuer === issuer && user.oidcSubject === subject) ?? null);
  }

  async findUserById(id: string): Promise<StoredUser | null> {
    return clone(this.users.get(id) ?? null);
  }
  async findUserProfilePreferences(id:string){return clone(this.profiles.get(id)??null)} async upsertUserProfilePreferences(v:UserProfilePreferences,expectedUpdatedAt:string|null){const current=this.profiles.get(v.userId);if(expectedUpdatedAt===null?current!==undefined:current?.updatedAt!==expectedUpdatedAt)return null;this.profiles.set(v.userId,clone(v));return clone(v)} async createUserNotification(v:UserNotification,dedupeKey?:string){const existing=dedupeKey?this.notificationDedupe.get(dedupeKey):undefined;if(existing){const notification=this.notifications.get(existing);if(notification)return clone(notification);this.notificationDedupe.delete(dedupeKey!)}this.notifications.set(v.id,clone(v));if(dedupeKey)this.notificationDedupe.set(dedupeKey,v.id);this.pruneUserNotificationInbox(v.userId);return clone(v)} async listUserNotifications(id:string,unreadOnly=false){return [...this.notifications.values()].filter(v=>v.userId===id&&this.canAccessNotification(v)&&(!unreadOnly||!v.readAt)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).map(clone)} async markUserNotificationRead(id:string,userId:string,readAt:string){const v=this.notifications.get(id);if(!v||v.userId!==userId||!this.canAccessNotification(v))return null;const n={...v,readAt};this.notifications.set(id,clone(n));return clone(n)} async markAllUserNotificationsRead(userId:string,readAt:string){let updated=0;for(const [id,value] of this.notifications){if(value.userId!==userId||value.readAt||!this.canAccessNotification(value))continue;this.notifications.set(id,clone({...value,readAt}));updated+=1}return updated} async dismissUserNotification(id:string,userId:string){const v=this.notifications.get(id);if(!v||v.userId!==userId||!this.canAccessNotification(v))return false;for(const [key,notificationId] of this.notificationDedupe)if(notificationId===id)this.notificationDedupe.delete(key);return this.notifications.delete(id)}
  private pruneUserNotificationInbox(userId:string){const overflow=[...this.notifications.values()].filter(value=>value.userId===userId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).slice(USER_NOTIFICATION_INBOX_LIMIT);for(const notification of overflow){this.notifications.delete(notification.id);for(const [key,notificationId] of this.notificationDedupe)if(notificationId===notification.id)this.notificationDedupe.delete(key)}}
  private canAccessNotification(notification:UserNotification){return !notification.projectId||this.memberships.has(membershipKey(notification.projectId,notification.userId))}
  private deleteUserProjectNotifications(userId:string,projectIds:Iterable<string>){const selected=new Set(projectIds);for(const [notificationId,notification] of this.notifications){if(notification.userId!==userId||!notification.projectId||!selected.has(notification.projectId))continue;this.notifications.delete(notificationId);for(const [key,dedupedId] of this.notificationDedupe)if(dedupedId===notificationId)this.notificationDedupe.delete(key)}}

  async createSession(session: AuthSession): Promise<AuthSession> {
    this.sessions.set(session.id, clone(session));
    return clone(session);
  }

  async findSession(id: string): Promise<AuthSession | null> {
    return clone(this.sessions.get(id) ?? null);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async deleteExpiredSessions(now: string): Promise<number> {
    let deleted = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt > now) continue;
      this.sessions.delete(id);
      deleted += 1;
    }
    return deleted;
  }

  async createWorkspace(workspace: Workspace): Promise<Workspace> {
    this.workspaces.set(workspace.id, clone(workspace));
    this.workspaceMemberships.set(workspaceMembershipKey(workspace.id, workspace.ownerUserId), { workspaceId: workspace.id, userId: workspace.ownerUserId, role: "owner", createdAt: workspace.createdAt, updatedAt: workspace.updatedAt });
    return clone(workspace);
  }

  async listWorkspaceDirectoryPage(query: import("../../ports/src/store.js").WorkspaceDirectoryStoreQuery): Promise<WorkspaceDirectoryItem[]> {
    return [...this.workspaces.values()]
      .flatMap((workspace) => {
        const membership = this.workspaceMemberships.get(workspaceMembershipKey(workspace.id, query.userId));
        const owner = this.users.get(workspace.ownerUserId);
        if (!membership || !owner) return [];
        const projectCount = [...this.projects.values()].filter((project) => project.workspaceId === workspace.id && this.memberships.has(membershipKey(project.id, query.userId))).length;
        return [{ ...clone(workspace), owner: { displayName: this.profiles.get(owner.id)?.displayName ?? null, email: owner.email }, memberRole: membership.role, projectCount }];
      })
      .sort((left, right) => compareOrdinal(left.createdAt, right.createdAt) || compareOrdinal(left.id, right.id))
      .filter((workspace) => !query.after || compareOrdinal(workspace.createdAt, query.after.createdAt) > 0 || (workspace.createdAt === query.after.createdAt && compareOrdinal(workspace.id, query.after.id) > 0))
      .slice(0, query.limit);
  }

  async countProjectsForUserInWorkspace(userId: string, workspaceId: string): Promise<number> {
    return [...this.projects.values()].filter((project) => project.workspaceId === workspaceId && this.memberships.has(membershipKey(project.id, userId))).length;
  }

  async findWorkspace(id: string): Promise<Workspace | null> {
    return clone(this.workspaces.get(id) ?? null);
  }
  async updateWorkspaceName(workspaceId:string,name:string,updatedAt:string,expectedName:string){const current=this.workspaces.get(workspaceId);if(!current||(current.lifecycleStatus??"active")!=="active"||current.name!==expectedName)return null;const updated={...current,name,updatedAt};this.workspaces.set(workspaceId,clone(updated));return clone(updated)}
  async beginWorkspaceDeletion(id:string, updatedAt:string, expectedOwnerUserId?:string){const value=this.workspaces.get(id);if(!value||(expectedOwnerUserId!==undefined&&value.ownerUserId!==expectedOwnerUserId))return{kind:"not_found_or_forbidden" as const};const projects=[...this.projects.values()].filter((project)=>project.workspaceId===id),uncertain:Project[]=[];for(const project of projects)if(await this.projectHasLiveBusinessReservations(project.id))uncertain.push(project);const unownedRun=(await this.sandboxRuns.list()).some((run)=>run.workspaceId===id&&run.state!=="released"&&!projects.some((project)=>project.id===run.projectId));if(uncertain.length||unownedRun){if(value.lifecycleStatus==="deleting"){this.workspaces.set(id,clone({...value,lifecycleStatus:"active" as const,updatedAt}));for(const affected of uncertain)if(affected.lifecycleStatus==="deleting")this.projects.set(affected.id,clone({...affected,lifecycleStatus:"active" as const,updatedAt}));}return{kind:"sandbox_not_released" as const};}if(value.lifecycleStatus==="deleting")return{kind:"ready" as const,value:clone(value)};const updated={...value,lifecycleStatus:"deleting" as const,updatedAt};this.workspaces.set(id,clone(updated));for(const project of projects)this.projects.set(project.id,clone({...project,lifecycleStatus:"deleting" as const,updatedAt}));return{kind:"ready" as const,value:clone(updated)}}
  async setWorkspaceLifecycleStatus(id:string,status:"active"|"archived",updatedAt:string){const value=this.workspaces.get(id);if(!value||value.lifecycleStatus==="deleting")return null;const updated={...value,lifecycleStatus:status,updatedAt};this.workspaces.set(id,clone(updated));return clone(updated)}
  async transferWorkspaceOwner(workspaceId:string,fromUserId:string,toUserId:string,updatedAt:string){const workspace=this.workspaces.get(workspaceId),target=this.workspaceMemberships.get(workspaceMembershipKey(workspaceId,toUserId));if(!workspace||workspace.ownerUserId!==fromUserId||fromUserId===toUserId||!target||workspace.lifecycleStatus!==undefined&&workspace.lifecycleStatus!=="active")return null;const from=this.workspaceMemberships.get(workspaceMembershipKey(workspaceId,fromUserId));if(!from)return null;this.workspaceMemberships.set(workspaceMembershipKey(workspaceId,fromUserId),clone({...from,role:"admin",updatedAt}));this.workspaceMemberships.set(workspaceMembershipKey(workspaceId,toUserId),clone({...target,role:"owner",updatedAt}));const updated={...workspace,ownerUserId:toUserId,updatedAt};this.workspaces.set(workspaceId,clone(updated));return clone(updated)}
  async deleteWorkspaceAfterProjects(id:string){const workspace=this.workspaces.get(id);if(!workspace||workspace.lifecycleStatus!=="deleting"||[...this.projects.values()].some((project)=>project.workspaceId===id))return false;for(const [key,entry] of this.contexts)if(entry.workspaceId===id)this.contexts.delete(key);for(const [key,membership] of this.workspaceMemberships)if(membership.workspaceId===id)this.workspaceMemberships.delete(key);return this.workspaces.delete(id)}
  async findWorkspaceMembership(workspaceId:string,userId:string){return clone(this.workspaceMemberships.get(workspaceMembershipKey(workspaceId,userId))??null)}
  async findWorkspaceMembershipView(workspaceId:string,userId:string):Promise<WorkspaceMembershipView|null>{const member=this.workspaceMemberships.get(workspaceMembershipKey(workspaceId,userId));return member?this.workspaceMembershipView(member):null}
  async listWorkspaceMembershipDirectoryPage(workspaceId:string,query:import("../../ports/src/store.js").MembershipDirectoryStoreQuery<WorkspaceMembership["role"]>):Promise<WorkspaceMembershipView[]>{
    return [...this.workspaceMemberships.values()]
      .filter((member)=>member.workspaceId===workspaceId&&(!query.role||member.role===query.role))
      .map((member)=>this.workspaceMembershipView(member))
      .filter((member)=>membershipMatchesQuery(member,query.q))
      .sort(compareMembershipDirectoryItems)
      .filter((member)=>!query.after||compareMembershipToCursor(member,query.after)>0)
      .slice(0,query.limit);
  }
  async upsertWorkspaceMembership(value:WorkspaceMembership){this.workspaceMemberships.set(workspaceMembershipKey(value.workspaceId,value.userId),clone(value));return clone(value)}
  async createWorkspaceMembership(value:WorkspaceMembership):Promise<CreateWorkspaceMembershipResult>{const key=workspaceMembershipKey(value.workspaceId,value.userId);if(this.workspaceMemberships.has(key))return "already_exists";this.workspaceMemberships.set(key,clone(value));return clone(value)}
  async updateWorkspaceMembership(value:WorkspaceMembership){const key=workspaceMembershipKey(value.workspaceId,value.userId);if(!this.workspaceMemberships.has(key))return null;this.workspaceMemberships.set(key,clone(value));return clone(value)}
  async updateManagedWorkspaceMembershipRole(workspaceId:string,userId:string,role:ManagedWorkspaceMembershipRole,updatedAt:string,expectedUpdatedAt:string):Promise<ManagedWorkspaceMembershipUpdateResult>{const workspace=this.workspaces.get(workspaceId),key=workspaceMembershipKey(workspaceId,userId),current=this.workspaceMemberships.get(key);if(!workspace||!current)return "not_found";if(workspace.ownerUserId===userId||current.role==="owner")return "owner";if(current.updatedAt!==expectedUpdatedAt)return "conflict";const updated={...current,role,updatedAt};this.workspaceMemberships.set(key,clone(updated));return clone(updated)}
  async revokeWorkspaceMembership(workspaceId:string,userId:string,expectedUpdatedAt:string){
    const key=workspaceMembershipKey(workspaceId,userId);const membership=this.workspaceMemberships.get(key);
    if(!membership)return "not_found" as const;
    const ownsProject=[...this.projects.values()].some((project)=>project.workspaceId===workspaceId&&(project.ownerUserId===userId||this.memberships.get(membershipKey(project.id,userId))?.role==="owner"));
    if(membership.role==="owner"||ownsProject)return "owner" as const;
    if(membership.updatedAt!==expectedUpdatedAt)return "conflict" as const;
    const revokedProjectIds:string[]=[];
    for(const [projectMembershipKey,projectMembership] of this.memberships){const project=this.projects.get(projectMembership.projectId);if(project?.workspaceId===workspaceId&&projectMembership.userId===userId){revokedProjectIds.push(projectMembership.projectId);this.memberships.delete(projectMembershipKey);this.projectPins.delete(projectMembershipKey);}}
    this.deleteUserProjectNotifications(userId,[...this.projects.values()].filter((project)=>project.workspaceId===workspaceId).map((project)=>project.id));
    this.workspaceMemberships.delete(key);
    return {revokedProjectIds};
  }

  async createProject(project: Project): Promise<Project> {
    this.projects.set(project.id, clone(project));
    this.memberships.set(membershipKey(project.id, project.ownerUserId), {
      projectId: project.id,
      userId: project.ownerUserId,
      role: "owner",
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    });
    this.policies.set(project.id, {
      projectId: project.id,
      sandboxLimit: project.sandboxLimit,
      providerRequestsLimit: null,
      providerTokensLimit: null,
      providerCostLimit: null,
      projectFileBytesLimit: null,
      endpointWindows: [],
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    });
    this.usage.set(project.id, {
      projectId: project.id,
      activeSandboxes: 0,
      providerRequests: 0,
      providerTokens: 0,
      providerCost: 0,
      projectFileBytes: 0,
      projectFileBytesMeasuredAt: null,
      updatedAt: project.updatedAt
    });
    return clone(project);
  }

  async listProjectsForWorkspace(workspaceId: string): Promise<Project[]> {
    return [...this.projects.values()].filter((project) => project.workspaceId === workspaceId).map(clone);
  }

  async listProjectDirectoryPage(query: import("../../ports/src/store.js").ProjectDirectoryStoreQuery): Promise<import("../../ports/src/store.js").ProjectDirectoryStorePage> {
    const q = query.q.toLowerCase();
    const all = [...this.projects.values()]
      .filter((project) => project.workspaceId === query.workspaceId && this.memberships.has(membershipKey(project.id, query.userId)))
      .map((project): ProjectDirectoryItem => ({ ...clone(project), pinnedAt: this.projectPins.get(membershipKey(project.id, query.userId))?.pinnedAt ?? null }))
      .filter((project) => project.name.toLowerCase().includes(q))
      .sort(compareProjectDirectoryItems);
    return {
      items: all.filter((project) => !query.after || compareProjectDirectoryItemToCursor(project, query.after) > 0).slice(0, query.limit),
      total: all.length
    };
  }

  async findProjectDirectoryItem(userId: string, projectId: string): Promise<ProjectDirectoryItem | null> {
    const project = this.projects.get(projectId);
    if (!project || !this.memberships.has(membershipKey(projectId, userId))) return null;
    return clone({ ...project, pinnedAt: this.projectPins.get(membershipKey(projectId, userId))?.pinnedAt ?? null });
  }

  async setProjectPin(userId:string,projectId:string,pinnedAt:string|null){const key=membershipKey(projectId,userId);if(!this.memberships.has(key))return false;if(pinnedAt)this.projectPins.set(key,{projectId,userId,pinnedAt});else this.projectPins.delete(key);return true}

  async findProject(id: string): Promise<Project | null> {
    return clone(this.projects.get(id) ?? null);
  }
  async createFileLibrary(value:FileLibrary){
    if(value.lifecycleStatus!=="active")return null;
    const duplicate=[...this.fileLibraries.values()].some((item)=>item.projectId===value.projectId&&(item.name.trim().toLowerCase()===value.name.trim().toLowerCase()||item.rootSubPath===value.rootSubPath));
    if(duplicate||this.fileLibraries.has(value.id))return null;
    this.fileLibraries.set(value.id,clone(value));
    return clone(value);
  }
  async findFileLibrary(id:string){return clone(this.fileLibraries.get(id)??null)}
  async listFileLibrariesForProject(projectId:string){return [...this.fileLibraries.values()].filter((item)=>item.projectId===projectId).sort((left,right)=>left.createdAt.localeCompare(right.createdAt)||left.id.localeCompare(right.id)).map(clone)}
  async renameFileLibrary(projectId:string,id:string,name:string,expectedUpdatedAt:string,updatedAt:string){
    const current=this.fileLibraries.get(id);
    if(!current||current.lifecycleStatus!=="active"||current.projectId!==projectId||current.updatedAt!==expectedUpdatedAt||[...this.fileLibraries.values()].some((item)=>item.id!==id&&item.projectId===projectId&&item.name.trim().toLowerCase()===name.trim().toLowerCase()))return null;
    const updated={...current,name,updatedAt};this.fileLibraries.set(id,clone(updated));return clone(updated);
  }
  async beginFileLibraryDeletion(input:BeginFileLibraryDeletionInput):Promise<BeginFileLibraryDeletionResult>{
    return this.atomicTaskMessageMutation([],async()=>{
      const operationId=fileLibraryDeletionOperationId(input.libraryId);
      if(input.idempotency.resourceId!==operationId)return{kind:"hash_mismatch" as const};
      const receipt=this.claimAtomicTaskMessageMutation(input.idempotency);
      if(receipt.kind!=="claimed"){
        if(receipt.kind==="in_progress"){
          const current=this.taskIdempotency.get(taskIdempotencyKey(input.idempotency));
          return{kind:"in_progress" as const,resourceId:current?.resourceId??operationId};
        }
        if(receipt.kind==="replay")return{...receipt,resourceId:operationId};
        return receipt;
      }
      if(receipt.resourceId!==operationId)return{kind:"hash_mismatch" as const};
      const current=this.fileLibraries.get(input.libraryId);
      if(!current||current.projectId!==input.idempotency.projectId){
        const tombstone=[...this.taskIdempotency.values()].find((record)=>
          record.projectId===input.idempotency.projectId&&
          record.operation==="project.file-library.delete"&&
          record.resourceId===operationId&&
          record.requestHash===input.idempotency.requestHash&&
          record.status==="completed"&&record.responseStatus===200
        );
        if(tombstone){
          this.completeAtomicTaskMessageMutation(input.idempotency,200,tombstone.responseBody,input.idempotency.now);
          return{kind:"replay" as const,resourceId:operationId,responseStatus:200,responseBody:clone(tombstone.responseBody)};
        }
        return{kind:"not_found" as const,receiptClaimToken:input.idempotency.claimToken};
      }
      const bound=[...this.tasks.values()].find((task)=>task.fileLibraryId===current.id);
      if(bound)return{kind:"bound" as const,task:{id:bound.id,title:bound.title??null},receiptClaimToken:input.idempotency.claimToken};
      if(current.lifecycleStatus==="active"){
        this.fileLibraries.set(current.id,clone({...current,lifecycleStatus:"deleting" as const,updatedAt:input.idempotency.now}));
        this.fileLibraryDeletions.set(current.id,{operationId,state:null,claimToken:null,claimExpiresAt:null});
      }
      const operation=this.fileLibraryDeletions.get(current.id);
      if(!operation||operation.operationId!==operationId)return{kind:"hash_mismatch" as const};
      return{
        kind:"claimed" as const,
        library:clone(this.fileLibraries.get(current.id)!),
        operationId,
        receiptClaimToken:input.idempotency.claimToken
      };
    });
  }
  async claimFileLibraryDeletionOperation(input:ClaimFileLibraryDeletionOperationInput):Promise<ClaimFileLibraryDeletionOperationResult>{
    return this.atomicTaskMessageMutation([],async()=>{
      const library=this.fileLibraries.get(input.libraryId),operation=this.fileLibraryDeletions.get(input.libraryId);
      if(!library||library.projectId!==input.projectId||library.lifecycleStatus!=="deleting"||
        !operation||operation.operationId!==input.operationId)return{kind:"conflict" as const};
      if(operation.claimToken&&operation.claimToken!==input.claimToken&&(operation.claimExpiresAt??"")>input.now)return{kind:"in_progress" as const};
      operation.claimToken=input.claimToken;
      operation.claimExpiresAt=new Date(Date.parse(input.now)+input.leaseMs).toISOString();
      return{kind:"claimed" as const,state:operation.state?clone(operation.state):null};
    });
  }
  async findFileLibraryDeletionOperation(owner:FileLibraryDeletionOperationOwner):Promise<FileDeletionOperationState|null>{
    const operation=this.fileLibraryDeletions.get(owner.libraryId);
    return fileLibraryDeletionClaimMatches(operation,owner)&&operation.state?clone(operation.state):null;
  }
  async persistFileLibraryDeletionOperation(owner:FileLibraryDeletionOperationOwner,state:FileDeletionOperationState,now:string):Promise<boolean>{
    return this.atomicTaskMessageMutation([],async()=>{
      const operation=this.fileLibraryDeletions.get(owner.libraryId);
      if(!fileLibraryDeletionClaimMatches(operation,owner)||(operation.claimExpiresAt??"")<=now||
        !isFileDeletionOperationTransition(operation.state,state))return false;
      operation.state=clone(state);
      return true;
    });
  }
  async renewFileLibraryDeletionOperation(owner:FileLibraryDeletionOperationOwner,leaseMs:number):Promise<boolean>{
    return this.atomicTaskMessageMutation([],async()=>{
      const operation=this.fileLibraryDeletions.get(owner.libraryId);
      const now=new Date().toISOString();
      if(!fileLibraryDeletionClaimMatches(operation,owner)||(operation.claimExpiresAt??"")<=now)return false;
      operation.claimExpiresAt=new Date(Date.parse(now)+leaseMs).toISOString();
      return true;
    });
  }
  async releaseFileLibraryDeletionOperation(owner:FileLibraryDeletionOperationOwner):Promise<boolean>{
    return this.atomicTaskMessageMutation([],async()=>{
      const operation=this.fileLibraryDeletions.get(owner.libraryId);
      if(!fileLibraryDeletionClaimMatches(operation,owner))return false;
      operation.claimToken=null;
      operation.claimExpiresAt=null;
      return true;
    });
  }
  async finalizeFileLibraryDeletion(input:FinalizeFileLibraryDeletionInput):Promise<"finalized"|"conflict">{
    return this.atomicTaskMessageMutation([],async()=>{
      const project=this.projects.get(input.projectId);
      const library=this.fileLibraries.get(input.libraryId);
      const operation=this.fileLibraryDeletions.get(input.libraryId);
      if(!project||!library||library.projectId!==input.projectId||library.lifecycleStatus!=="deleting"||
        !fileLibraryDeletionClaimMatches(operation,input)||(operation.claimExpiresAt??"")<=input.updatedAt||
        operation.state?.phase!=="removed"||[...this.tasks.values()].some((task)=>task.fileLibraryId===input.libraryId))return"conflict" as const;
      const auditId=`audit:${input.operationId}`;
      if(!this.auditEvents.some((event)=>event.id===auditId))this.auditEvents.push({
        id:auditId,projectId:input.projectId,actorId:input.actorId,action:"file_library.delete",
        status:"accepted",resourceKind:"file",resourceId:input.libraryId,
        detail:{bytes:operation.state.bytes},createdAt:input.updatedAt
      });
      this.fileLibraries.delete(input.libraryId);
      this.fileLibraryDeletions.delete(input.libraryId);
      for(const [key,record] of this.taskIdempotency){
        if(record.projectId!==input.projectId||record.operation!=="project.file-library.delete"||
          record.resourceId!==input.operationId||record.requestHash!==input.requestHash||record.status!=="in_progress")continue;
        this.taskIdempotency.set(key,{...record,status:"completed",responseStatus:input.responseStatus,responseBody:clone(input.responseBody),updatedAt:input.updatedAt});
      }
      return"finalized" as const;
    });
  }
  async findTaskBoundToFileLibrary(fileLibraryId:string){const task=[...this.tasks.values()].find((candidate)=>candidate.fileLibraryId===fileLibraryId);return task?{kind:"bound" as const,task:{id:task.id,title:task.title??null}}:{kind:"unbound" as const}}
  async updateProjectName(projectId:string,name:string,updatedAt:string,expectedName:string){const current=this.projects.get(projectId);if(!current||(current.lifecycleStatus??"active")!=="active"||current.name!==expectedName)return null;const updated={...current,name,updatedAt};this.projects.set(projectId,clone(updated));return clone(updated)}
  async beginProjectDeletion(id:string,updatedAt:string,expectedOwnerUserId?:string){return this.atomicTaskMessageMutation([],async()=>{const value=this.projects.get(id);if(!value||(expectedOwnerUserId!==undefined&&value.ownerUserId!==expectedOwnerUserId))return{kind:"not_found_or_forbidden" as const};if(await this.projectHasLiveBusinessReservations(id)){if(value.lifecycleStatus==="deleting")this.projects.set(id,clone({...value,lifecycleStatus:"active" as const,updatedAt}));return{kind:"sandbox_not_released" as const};}if(value.lifecycleStatus==="deleting")return{kind:"ready" as const,value:clone(value)};const updated={...value,lifecycleStatus:"deleting" as const,updatedAt};this.projects.set(id,clone(updated));return{kind:"ready" as const,value:clone(updated)}})}
  async setProjectLifecycleStatus(id:string,status:"active"|"archived",updatedAt:string){const value=this.projects.get(id);if(!value||value.lifecycleStatus==="deleting")return null;const updated={...value,lifecycleStatus:status,updatedAt};this.projects.set(id,clone(updated));return clone(updated)}
  async transferProjectOwner(projectId:string,fromUserId:string,toUserId:string,updatedAt:string){const project=this.projects.get(projectId),target=this.memberships.get(membershipKey(projectId,toUserId));if(!project||project.ownerUserId!==fromUserId||fromUserId===toUserId||!target||project.lifecycleStatus!==undefined&&project.lifecycleStatus!=="active")return null;const from=this.memberships.get(membershipKey(projectId,fromUserId));if(!from)return null;this.memberships.set(membershipKey(projectId,fromUserId),clone({...from,role:"admin",updatedAt}));this.memberships.set(membershipKey(projectId,toUserId),clone({...target,role:"owner",updatedAt}));const updated={...project,ownerUserId:toUserId,updatedAt};this.projects.set(projectId,clone(updated));return clone(updated)}
  async finalizeProjectDeletion(id:string,completion?:CompleteTaskIdempotencyInput):Promise<FinalizeProjectDeletionResult>{
    return this.atomicTaskMessageMutation([],async()=>{
    const project=this.projects.get(id);
    if(!project||project.lifecycleStatus!=="deleting"||await this.projectHasLiveBusinessReservations(id))return"not_ready" as const;
    const completionKey=completion?taskIdempotencyKey(completion):null;
    const deletionReceipt=completionKey?this.taskIdempotency.get(completionKey):null;
    if(completion&&(
      !isSuccessfulProjectDeletionCompletion(id,completion)
      || !deletionReceipt
      || deletionReceipt.status!=="in_progress"
      || deletionReceipt.requestHash!==completion.requestHash
      || deletionReceipt.claimToken!==completion.claimToken
      || deletionReceipt.resourceId!==id
    ))return"not_ready" as const;
    const taskIds=new Set([...this.tasks.values()].filter((task)=>task.projectId===id).map((task)=>task.id));
    const endpointIds=[...this.endpoints.values()].filter((endpoint)=>endpoint.projectId===id).map((endpoint)=>endpoint.id);
    const documents=await Promise.all([
      ...[...taskIds].map(async(taskId)=>["sandbox_runtime_state",taskId,await this.jsonDocs.get("sandbox_runtime_state",taskId)] as const),
      ["project_settings",id,await this.jsonDocs.get("project_settings",id)] as const,
      ...endpointIds.map(async(endpointId)=>["endpoint_snapshots",endpointId,await this.jsonDocs.get("endpoint_snapshots",endpointId)] as const)
    ]);
    const previous={
      projects:snapshotMap(this.projects),fileLibraries:snapshotMap(this.fileLibraries),memberships:snapshotMap(this.memberships),
      projectPins:snapshotMap(this.projectPins),policies:snapshotMap(this.policies),usage:snapshotMap(this.usage),
      providerSettlements:snapshotMap(this.providerSettlements),sandboxUsageSettlements:snapshotMap(this.sandboxUsageSettlements),
      alerts:snapshotMap(this.alerts),auditEvents:this.auditEvents.map(clone),endpoints:snapshotMap(this.endpoints),tasks:snapshotMap(this.tasks),
      interactionChanges:this.interactionChanges.map(clone),interactionSync:snapshotMap(this.interactionSync),artifacts:this.artifacts.map(clone),
      taskIdempotency:snapshotMap(this.taskIdempotency),notifications:snapshotMap(this.notifications),
      notificationDedupe:snapshotMap(this.notificationDedupe),credentials:snapshotMap(this.credentials),contexts:snapshotMap(this.contexts),
      alertRules:snapshotMap(this.alertRules),messages:this.messages.map(clone),sandboxRuns:this.sandboxRunRecords.snapshot()
    };
    try{
      for(const [collection,documentId] of documents)await this.jsonDocs.delete(collection,documentId);
      for(const [key,task] of this.tasks)if(task.projectId===id){this.tasks.delete(key);this.interactionSync.delete(key);}
      this.interactionChanges.splice(0,this.interactionChanges.length,...this.interactionChanges.filter((value)=>!taskIds.has(value.interaction.taskId)));
      this.artifacts.splice(0,this.artifacts.length,...this.artifacts.filter((value)=>!taskIds.has(value.taskId)));
      this.messages.splice(0,this.messages.length,...this.messages.filter((value)=>!taskIds.has(value.taskId)));
      this.auditEvents.splice(0,this.auditEvents.length,...this.auditEvents.filter((value)=>value.projectId!==id));
      for(const [key,value] of this.providerSettlements)if(value.projectId===id)this.providerSettlements.delete(key);
      for(const [key,value] of this.sandboxUsageSettlements)if(value.projectId===id)this.sandboxUsageSettlements.delete(key);
      for(const [key,value] of this.taskIdempotency)if(value.projectId===id&&key!==completionKey)this.taskIdempotency.delete(key);
      this.sandboxRunRecords.deleteForProject(id);
      for(const [key,value] of this.alerts)if(value.projectId===id)this.alerts.delete(key);
      for(const [key,value] of this.endpoints)if(value.projectId===id)this.endpoints.delete(key);
      for(const [key,value] of this.memberships)if(value.projectId===id){this.memberships.delete(key);this.projectPins.delete(key);}
      for(const [key,value] of this.contexts)if(value.projectId===id)this.contexts.delete(key);
      for(const [key,value] of this.credentials)if(value.projectId===id)this.credentials.delete(key);
      for(const [key,value] of this.alertRules)if(value.projectId===id)this.alertRules.delete(key);
      for(const [key,value] of this.fileLibraries)if(value.projectId===id)this.fileLibraries.delete(key);
      for(const [notificationId,notification] of this.notifications)if(notification.projectId===id){
        this.notifications.delete(notificationId);
        for(const [dedupeKey,dedupedId] of this.notificationDedupe)if(dedupedId===notificationId)this.notificationDedupe.delete(dedupeKey);
      }
      this.policies.delete(id);
      this.usage.delete(id);
      if(completion&&completionKey&&deletionReceipt)this.taskIdempotency.set(completionKey,{
        ...deletionReceipt,status:"completed",responseStatus:completion.responseStatus,
        responseBody:clone(completion.responseBody),updatedAt:completion.updatedAt
      });
      this.projects.delete(id);
      return"deleted" as const;
    }catch(error){
      restoreMap(this.projects,previous.projects);restoreMap(this.fileLibraries,previous.fileLibraries);restoreMap(this.memberships,previous.memberships);
      restoreMap(this.projectPins,previous.projectPins);restoreMap(this.policies,previous.policies);restoreMap(this.usage,previous.usage);
      restoreMap(this.providerSettlements,previous.providerSettlements);restoreMap(this.sandboxUsageSettlements,previous.sandboxUsageSettlements);
      restoreMap(this.alerts,previous.alerts);restoreArray(this.auditEvents,previous.auditEvents);restoreMap(this.endpoints,previous.endpoints);
      restoreMap(this.tasks,previous.tasks);restoreArray(this.interactionChanges,previous.interactionChanges);
      restoreMap(this.interactionSync,previous.interactionSync);restoreArray(this.artifacts,previous.artifacts);
      restoreMap(this.taskIdempotency,previous.taskIdempotency);restoreMap(this.notifications,previous.notifications);
      restoreMap(this.notificationDedupe,previous.notificationDedupe);restoreMap(this.credentials,previous.credentials);
      restoreMap(this.contexts,previous.contexts);restoreMap(this.alertRules,previous.alertRules);restoreArray(this.messages,previous.messages);
      this.sandboxRunRecords.restore(previous.sandboxRuns);
      for(const [collection,documentId,document] of documents)if(document)await this.jsonDocs.put(collection,documentId,document);
      throw error;
    }
    });
  }

  async findProjectMembership(projectId: string, userId: string): Promise<ProjectMembership | null> {
    return clone(this.memberships.get(membershipKey(projectId, userId)) ?? null);
  }

  async findProjectMembershipView(projectId:string,userId:string):Promise<ProjectMembershipView|null>{const member=this.memberships.get(membershipKey(projectId,userId));return member?this.projectMembershipView(member):null}
  async listProjectMembershipDirectoryPage(projectId:string,query:import("../../ports/src/store.js").MembershipDirectoryStoreQuery<ProjectMembership["role"]>):Promise<ProjectMembershipView[]>{
    return [...this.memberships.values()]
      .filter((member)=>member.projectId===projectId&&(!query.role||member.role===query.role))
      .map((member)=>this.projectMembershipView(member))
      .filter((member)=>membershipMatchesQuery(member,query.q))
      .sort(compareMembershipDirectoryItems)
      .filter((member)=>!query.after||compareMembershipToCursor(member,query.after)>0)
      .slice(0,query.limit);
  }
  async listProjectMembershipCandidatesPage(projectId:string,query:import("../../ports/src/store.js").ProjectMembershipCandidateStoreQuery):Promise<import("../../ports/src/store.js").ProjectMembershipCandidateStoreItem[]>{
    const project=this.projects.get(projectId);
    if(!project)return[];
    return [...this.workspaceMemberships.values()]
      .filter((member)=>member.workspaceId===project.workspaceId&&!this.memberships.has(membershipKey(projectId,member.userId)))
      .map((member)=>{const identity=this.workspaceMembershipView(member);return{userId:identity.userId,displayName:identity.displayName,email:identity.email,createdAt:identity.createdAt}})
      .filter((member)=>membershipMatchesQuery(member,query.q))
      .sort(compareMembershipDirectoryItems)
      .filter((member)=>!query.after||compareMembershipToCursor(member,query.after)>0)
      .slice(0,query.limit);
  }
  async findProjectMembershipIdentities(projectId:string,userIds:string[]):Promise<import("../../contracts/src/api.js").ProjectMembershipCandidate[]>{
    if(userIds.length>200)throw new Error("Project membership identity batch exceeds 200 users");
    const wanted=new Set(userIds);
    return [...this.memberships.values()].filter((member)=>member.projectId===projectId&&wanted.has(member.userId)).map((member)=>{const view=this.projectMembershipView(member);return{userId:view.userId,displayName:view.displayName,email:view.email}});
  }
  async listProjectMembershipsForFanout(projectId:string):Promise<ProjectMembership[]>{return[...this.memberships.values()].filter((member)=>member.projectId===projectId).map(clone)}

  async upsertProjectMembership(membership: ProjectMembership): Promise<ProjectMembership> {
    const key = membershipKey(membership.projectId, membership.userId);
    const existing = this.memberships.get(key);
    const stored = existing ? { ...existing, role: membership.role, updatedAt: membership.updatedAt } : membership;
    this.memberships.set(key, clone(stored));
    return clone(stored);
  }

  async upsertProjectMembershipForWorkspaceMember(membership: ProjectMembership): Promise<ProjectMembership | null> {
    const project=this.projects.get(membership.projectId);
    if(!project||!this.workspaceMemberships.has(workspaceMembershipKey(project.workspaceId,membership.userId)))return null;
    return this.upsertProjectMembership(membership);
  }

  async createProjectMembershipForWorkspaceMember(membership:ProjectMembership):Promise<CreateProjectMembershipResult>{const project=this.projects.get(membership.projectId),key=membershipKey(membership.projectId,membership.userId);if(!project||!this.workspaceMemberships.has(workspaceMembershipKey(project.workspaceId,membership.userId)))return "not_workspace_member";if(this.memberships.has(key))return "already_exists";this.memberships.set(key,clone(membership));return clone(membership)}

  async updateProjectMembership(membership: ProjectMembership): Promise<ProjectMembership | null> {
    const key = membershipKey(membership.projectId, membership.userId);
    const existing = this.memberships.get(key);
    if (!existing) {
      return null;
    }
    const stored = { ...existing, role: membership.role, updatedAt: membership.updatedAt };
    this.memberships.set(key, clone(stored));
    return clone(stored);
  }

  async deleteProjectMembership(projectId: string, userId: string): Promise<boolean> {
    const key=membershipKey(projectId,userId);this.projectPins.delete(key);return this.memberships.delete(key);
  }

  async updateManagedProjectMembershipRole(projectId:string,userId:string,role:ManagedProjectMembershipRole,updatedAt:string,expectedUpdatedAt:string):Promise<ManagedProjectMembershipUpdateResult>{const project=this.projects.get(projectId),key=membershipKey(projectId,userId),current=this.memberships.get(key);if(!project||!current)return "not_found";if(project.ownerUserId===userId||current.role==="owner")return "owner";if(current.updatedAt!==expectedUpdatedAt)return "conflict";const updated={...current,role,updatedAt};this.memberships.set(key,clone(updated));return clone(updated)}
  async deleteManagedProjectMembership(projectId:string,userId:string,expectedUpdatedAt:string):Promise<ManagedProjectMembershipDeleteResult>{const project=this.projects.get(projectId),key=membershipKey(projectId,userId),current=this.memberships.get(key);if(!project||!current)return "not_found";if(project.ownerUserId===userId||current.role==="owner")return "owner";if(current.updatedAt!==expectedUpdatedAt)return "conflict";this.projectPins.delete(key);this.memberships.delete(key);this.deleteUserProjectNotifications(userId,[projectId]);return "deleted"}

  private workspaceMembershipView(membership: WorkspaceMembership): WorkspaceMembershipView { const user = this.users.get(membership.userId); return { ...clone(membership), displayName: this.profiles.get(membership.userId)?.displayName ?? null, email: user?.email ?? membership.userId }; }
  private contextKeyExists(value: ProjectContextEntry, exceptId?: string): boolean { return [...this.contexts.values()].some((entry) => entry.id !== exceptId && entry.workspaceId === value.workspaceId && entry.projectId === value.projectId && entry.scope === value.scope && entry.ownerUserId === value.ownerUserId && entry.contextKey === value.contextKey); }
  private projectMembershipView(membership: ProjectMembership): ProjectMembershipView { const user = this.users.get(membership.userId); return { ...clone(membership), displayName: this.profiles.get(membership.userId)?.displayName ?? null, email: user?.email ?? membership.userId }; }

  async createProjectResourcePolicy(policy: ProjectResourcePolicy): Promise<ProjectResourcePolicy> { this.policies.set(policy.projectId, clone(policy)); return clone(policy); }
  async findProjectResourcePolicy(projectId: string): Promise<ProjectResourcePolicy | null> { return clone(this.policies.get(projectId) ?? null); }
  async findProjectResourcePolicyView(projectId:string):Promise<import("../../contracts/src/api.js").ProjectResourcePolicyView|null>{
    const policy=this.policies.get(projectId);
    if(!policy)return null;
    return clone({...policy,endpointWindows:(policy.endpointWindows??[]).map((window)=>{const endpoint=this.endpoints.get(window.endpointId);return{...window,endpointName:endpoint?.projectId===projectId?endpoint.name:null}})});
  }
  async patchProjectResourcePolicy(projectId: string, input: UpdateProjectResourcePolicyInput, updatedAt: string, expectedUpdatedAt?: string): Promise<ProjectResourcePolicy | null> {
    const policy = this.policies.get(projectId);
    if (!policy || (expectedUpdatedAt !== undefined && policy.updatedAt !== expectedUpdatedAt)) return null;
    const updated = { ...policy, ...input, updatedAt };
    this.policies.set(projectId, clone(updated));
    if (input.sandboxLimit !== undefined && input.sandboxLimit !== null) {
      const project = this.projects.get(projectId);
      if (project) this.projects.set(projectId, clone({ ...project, sandboxLimit: input.sandboxLimit, updatedAt }));
    }
    return clone(updated);
  }
  async findProjectResourceUsage(projectId: string): Promise<ProjectResourceUsage | null> { return clone(this.usage.get(projectId) ?? null); }
  async upsertProjectResourceUsage(usage: ProjectResourceUsage): Promise<ProjectResourceUsage> { this.usage.set(usage.projectId, clone(usage)); return clone(usage); }
  async setProjectFileBytes(projectId: string, bytes: number, measuredAt: string): Promise<ProjectResourceUsage | null> {
    const usage = this.usage.get(projectId);
    if (!usage) return null;
    const next = { ...usage, projectFileBytes: bytes, projectFileBytesMeasuredAt: measuredAt, updatedAt: measuredAt };
    this.usage.set(projectId, clone(next));
    return clone(next);
  }
  async adjustProjectResourceUsage(input: ProjectResourceUsageAdjustment): Promise<ProjectResourceUsage | null> {
    if(input.delta.activeSandboxes!==0)throw new Error("active_sandboxes is an authoritative Sandbox Run projection");
    const policy = this.policies.get(input.projectId);
    const usage = this.usage.get(input.projectId);
    if (!policy || !usage || (input.limit && exceedsLimit(policy, usage, input))) return null;
    const next = {
      ...usage,
      providerRequests: usage.providerRequests + input.delta.providerRequests,
      providerTokens: usage.providerTokens + input.delta.providerTokens,
      providerCost: usage.providerCost + input.delta.providerCost,
      projectFileBytes: Math.max(0, usage.projectFileBytes + input.delta.projectFileBytes),
      updatedAt: input.updatedAt
    };
    this.usage.set(input.projectId, clone(next));
    return clone(next);
  }
  async reserveProjectProviderSettlement(input: ReserveProjectProviderSettlementInput): Promise<ProjectProviderSettlement | null> {
    return this.atomicTaskMessageMutation([],async()=>{
    const project=this.projects.get(input.projectId);
    if(!project||(project.lifecycleStatus??"active")!=="active")return null;
    const policy = this.policies.get(input.projectId);
    const usage = this.usage.get(input.projectId);
    if (!policy || !usage || providerReservationExceedsPolicy(policy, usage, input)) return null;
    if (input.endpointId !== null) for(const window of policy.endpointWindows??[]){if(window.endpointId!==input.endpointId)continue;const cutoff=Date.parse(input.reservedAt)-window.windowSeconds*1000;const current=[...this.providerSettlements.values()].filter(value=>value.projectId===input.projectId&&value.endpointId===input.endpointId&&(value.actorId??null)===(input.actorId??null)&&value.status!=="failed"&&Date.parse(value.reservedAt)>=cutoff).reduce((sum,value)=>sum+providerWindowValue(value,window.metric),0);const proposed=current+(window.metric==="providerRequests"?1:window.metric==="providerTokens"?input.reservedTokens:input.reservedCost);if(proposed>window.limit)return null;}
    if (this.providerSettlements.has(input.id)) throw new Error("Provider settlement already exists");
    this.usage.set(input.projectId, clone({ ...usage, providerRequests: usage.providerRequests + 1, providerTokens: usage.providerTokens + input.reservedTokens, providerCost: usage.providerCost + input.reservedCost, updatedAt: input.reservedAt }));
    const settlement: ProjectProviderSettlement = { ...input, status: "reserved", dispatchedAt: null, deliveredAt: null, settledAt: null, updatedAt: input.reservedAt };
    this.providerSettlements.set(input.id, clone(settlement)); return clone(settlement);
    });
  }
  async markProjectProviderSettlementDispatched(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null> { return this.transitionSettlement(id, ["reserved"], "dispatched", updatedAt, "dispatchedAt"); }
  async markProjectProviderSettlementDelivered(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null> { return this.transitionSettlement(id, ["dispatched","unknown"], "delivered", updatedAt, "deliveredAt"); }
  async settleProjectProviderSettlement(id: string, usage: ProviderUsage | undefined, updatedAt: string): Promise<ProjectProviderUsageSettlement | null> {
    const settlement = this.providerSettlements.get(id); if (!settlement) return null;
    if (settlement.status === "settled") return this.settlementResult(settlement);
    if (!usage || (settlement.status !== "dispatched" && settlement.status !== "delivered" && settlement.status !== "unknown")) return null;
    const policy = this.policies.get(settlement.projectId);
    const current = this.usage.get(settlement.projectId);
    if (!policy || !current) return null;
    const next = {
      ...current,
      providerTokens: Math.max(0, current.providerTokens + (usage.tokens ?? 0) - settlement.reservedTokens),
      providerCost: Math.max(0, current.providerCost + (usage.cost ?? 0) - settlement.reservedCost),
      updatedAt
    };
    this.usage.set(settlement.projectId, clone(next));
    this.providerSettlements.set(id, clone({ ...settlement, status: "settled", settledAt: updatedAt, ...(usage ? { usage } : {}), updatedAt }));
    return this.settlementResult(this.providerSettlements.get(id)!);
  }
  async markProjectProviderSettlementUnknown(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null> {
    const settlement = this.providerSettlements.get(id);
    if (!settlement || (settlement.status !== "dispatched" && settlement.status !== "delivered")) return null;
    const updated = { ...settlement, status: "unknown" as const, updatedAt };
    this.providerSettlements.set(id, clone(updated));
    return clone(updated);
  }
  async failProjectProviderSettlement(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null> {
    const settlement = this.providerSettlements.get(id); if (!settlement || settlement.status === "settled" || settlement.status === "failed") return settlement ? clone(settlement) : null;
    if (settlement.status !== "reserved") return this.markProjectProviderSettlementUnknown(id, updatedAt);
    const usage = this.usage.get(settlement.projectId); if (usage) this.usage.set(settlement.projectId, { ...usage, providerRequests: Math.max(0, usage.providerRequests - 1), providerTokens: Math.max(0, usage.providerTokens - settlement.reservedTokens), providerCost: Math.max(0, usage.providerCost - settlement.reservedCost), updatedAt });
    const updated = { ...settlement, status: "failed" as const, updatedAt }; this.providerSettlements.set(id, clone(updated)); return clone(updated);
  }
  async expireProjectProviderSettlements(now: string): Promise<number> { let count = 0; for (const value of this.providerSettlements.values()) if (["reserved", "dispatched", "delivered"].includes(value.status) && value.expiresAt <= now) { if (value.status === "reserved") await this.failProjectProviderSettlement(value.id, now); else await this.markProjectProviderSettlementUnknown(value.id, now); count += 1; } return count; }
  async pruneProjectProviderSettlements(before: string, limit: number): Promise<number> { let count = 0; for (const [id, value] of this.providerSettlements) if (count < limit && value.updatedAt < before && ["settled", "unknown", "failed"].includes(value.status)) { this.providerSettlements.delete(id); count += 1; } return count; }
  async listSettledProjectProviderSettlements(projectId: string, since: string, endpointId?: string): Promise<ProjectProviderSettlement[]> { return [...this.providerSettlements.values()].filter((value) => value.projectId === projectId && value.status === "settled" && value.settledAt !== null && value.settledAt >= since && (endpointId === undefined || value.endpointId === endpointId)).sort((left, right) => left.settledAt!.localeCompare(right.settledAt!)).map(clone); }
  async readProjectUsageOverview(input:ProjectUsageOverviewReadInput):Promise<ProjectUsageOverviewReadResult>{
    const project=clone(this.projects.get(input.projectId)??null);
    if(!project)return{kind:"project_not_found"};
    const policy=clone(this.policies.get(input.projectId)??null);
    if(!policy)return{kind:"policy_not_found"};
    if(![...this.memberships.values()].some((membership)=>membership.projectId===input.projectId&&membership.userId===input.selectedUserId))return{kind:"selected_member_not_found"};
    const usage=clone(this.usage.get(input.projectId)??null);
    const selectedEndpoint=input.selectedEndpointId===null?null:this.endpoints.get(input.selectedEndpointId);
    if(input.selectedEndpointId!==null&&selectedEndpoint?.projectId!==input.projectId)return{kind:"endpoint_not_found"};
    const providerSettlements=[...this.providerSettlements.values()].filter((value)=>value.projectId===input.projectId).map(clone);
    const sandboxRuns=this.sandboxRunRecords.snapshot().filter((run)=>run.projectId===input.projectId&&run.startedByUserId===input.selectedUserId);
    const tasks=new Map([...this.tasks.values()].filter((task)=>task.projectId===input.projectId).map((task)=>[task.id,clone(task)] as const));
    const sandboxSettlements=[...this.sandboxUsageSettlements.values()].filter((value)=>value.projectId===input.projectId&&value.startedByUserId===input.selectedUserId).map(clone);
    const settled=providerSettlements.filter((value)=>value.actorId===input.userId&&value.status==="settled"&&value.settledAt!==null&&value.settledAt>=input.periodStart&&value.settledAt<input.periodEnd);
    const selected=settled.filter((value)=>input.selectedEndpointId===null||value.endpointId===input.selectedEndpointId);
    const byDay=new Map<string,{requests:number;tokens:number;cost:number}>();
    for(const value of selected){const date=value.settledAt!.slice(0,10),current=byDay.get(date)??{requests:0,tokens:0,cost:0};current.requests+=1;current.tokens+=value.usage?.tokens??0;current.cost+=value.usage?.cost??0;byDay.set(date,current)}
    const daily=[...byDay].sort(([left],[right])=>left.localeCompare(right)).map(([date,total])=>({date,...total}));
    const totals=selected.reduce((total,value)=>({requests:total.requests+1,tokens:total.tokens+(value.usage?.tokens??0),cost:total.cost+(value.usage?.cost??0)}),{requests:0,tokens:0,cost:0});
    const settlementIds=new Set(sandboxSettlements.map((value)=>value.runId));
    for(const run of sandboxRuns){
      if(run.state==="released"){if(!settlementIds.has(run.runId))return{kind:"integrity_error"};continue}
      const task=tasks.get(run.taskId);
      if(!task||task.deletedAt||task.currentRunId!==run.runId||task.id!==run.taskId||task.projectId!==run.projectId||task.workspaceId!==run.workspaceId||task.fileLibraryId!==run.fileLibraryId)return{kind:"integrity_error"};
    }
    const measured=Date.parse(input.measuredAt);
    if(!Number.isFinite(measured))return{kind:"integrity_error"};
    const liveRuns=sandboxRuns.filter((run)=>run.state!=="released").sort((left,right)=>(right.startedAt??right.createdAt).localeCompare(left.startedAt??left.createdAt)||compareOrdinal(right.runId,left.runId)).map((run)=>{
      const task=tasks.get(run.taskId)!;
      return{taskId:run.taskId,taskTitle:task.title??null,taskAvailable:true,runId:run.runId,fileLibraryId:run.fileLibraryId,state:run.state as Exclude<PersistedSandboxRunState["state"],"released">,startedAt:run.startedAt,durationSeconds:run.startedAt?Math.max(0,(measured-Date.parse(run.startedAt))/1000):0,resources:clone(run.resourceSnapshot)};
    });
    let totalDurationMilliseconds=0n,cpuRequestMillisMilliseconds=0n,memoryRequestByteMilliseconds=0n;
    const rows=[...sandboxSettlements.map((value)=>({durationSeconds:value.durationSeconds,resources:value.resources})),...liveRuns];
    try{
      for(const row of rows){const rounded=Math.round(row.durationSeconds*1000);if(!Number.isSafeInteger(rounded)||rounded<0)return{kind:"integrity_error"};const duration=BigInt(rounded);totalDurationMilliseconds+=duration;cpuRequestMillisMilliseconds+=BigInt(row.resources.cpuRequestMillis)*duration;memoryRequestByteMilliseconds+=BigInt(row.resources.memoryRequestBytes)*duration}
    }catch{return{kind:"integrity_error"}}
    return{kind:"available",value:{projectCreatedAt:project.createdAt,policy,usage,provider:{daily,totals,selectedEndpoint:selectedEndpoint?{id:selectedEndpoint.id,name:selectedEndpoint.name}:null},sandbox:{unreleasedCount:liveRuns.length,launches:sandboxSettlements.filter((value)=>value.startedAt!==null).length+liveRuns.filter((run)=>run.startedAt!==null).length,totalDurationMilliseconds:totalDurationMilliseconds.toString(),cpuRequestMillisMilliseconds:cpuRequestMillisMilliseconds.toString(),memoryRequestByteMilliseconds:memoryRequestByteMilliseconds.toString(),liveRuns}}};
  }
  async queryProjectEndpointUsagePage(query:import("../../ports/src/store.js").ProjectEndpointUsageStoreQuery):Promise<import("../../ports/src/store.js").ProjectEndpointUsageStorePage>{
    const policy=this.policies.get(query.projectId);
    if(!policy)return{items:[],total:0,hasMore:false};
    const filtered=[...this.endpoints.values()].filter((endpoint)=>endpoint.projectId===query.projectId&&providerDirectoryMatch([endpoint.id,endpoint.name],query.q)).sort(compareCreatedDirectoryDesc),total=filtered.length;
    const remaining=filtered.filter((endpoint)=>!query.after||compareCreatedDirectoryToCursor(endpoint,query.after)>0),page=remaining.slice(0,query.limit);
    const settlements=[...this.providerSettlements.values()].filter((value)=>value.projectId===query.projectId&&value.actorId===query.userId);
    return{total,hasMore:remaining.length>query.limit,items:page.map((endpoint)=>{
      const settled=settlements.filter((value)=>value.endpointId===endpoint.id&&value.status==="settled"&&value.settledAt!==null&&value.settledAt>=query.periodStart&&value.settledAt<query.periodEnd);
      const limits:import("../../contracts/src/api.js").ProjectUsageLimit[]=[];
      for(const window of policy.endpointWindows??[]){
        if(window.endpointId!==endpoint.id)continue;
        const cutoff=new Date(Date.parse(query.measuredAt)-window.windowSeconds*1000).toISOString();
        const inWindow=settlements.filter((value)=>value.endpointId===endpoint.id&&value.status!=="failed"&&value.reservedAt>=cutoff).sort((left,right)=>left.reservedAt.localeCompare(right.reservedAt)||compareC(left.id,right.id));
        const current=inWindow.reduce((sum,value)=>sum+providerWindowValue(value,window.metric),0),oldestReservedAt=inWindow[0]?.reservedAt??null;
        limits.push({metric:window.metric,current,limit:window.limit,remaining:Math.max(0,window.limit-current),window:{kind:"rolling",windowSeconds:window.windowSeconds,startedAt:cutoff,resetAt:oldestReservedAt?new Date(Date.parse(oldestReservedAt)+window.windowSeconds*1000).toISOString():null}});
      }
      return{endpointId:endpoint.id,endpointName:endpoint.name,requests:settled.length,tokens:settled.reduce((sum,value)=>sum+(value.usage?.tokens??0),0),cost:settled.reduce((sum,value)=>sum+(value.usage?.cost??0),0),limits,cursorCreatedAt:endpoint.createdAt,cursorId:endpoint.id};
    })};
  }
  async measureProjectProviderWindow(input:{projectId:string;endpointId:string;actorId:string|null;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;since:string}):Promise<{current:number;oldestReservedAt:string|null}>{const settlements=[...this.providerSettlements.values()].filter((value)=>value.projectId===input.projectId&&value.endpointId===input.endpointId&&(value.actorId??null)===input.actorId&&value.status!=="failed"&&value.reservedAt>=input.since).sort((left,right)=>left.reservedAt.localeCompare(right.reservedAt)||left.id.localeCompare(right.id));return{current:settlements.reduce((sum,value)=>sum+providerWindowValue(value,input.metric),0),oldestReservedAt:settlements[0]?.reservedAt??null};}
  async measureProjectAlertRule(input: { projectId:string; alertType:ProjectAlertType; metric:import("../../contracts/src/api.js").AlertRuleMetric; windowSeconds:number|null; endpointId:string|null; now:string }): Promise<number> {
    const usage=this.usage.get(input.projectId);
    if(input.metric==="active_sandboxes")return usage?.activeSandboxes??0;
    if(input.metric==="project_file_bytes")return usage?.projectFileBytes??0;
    const cutoff=input.windowSeconds===null?null:Date.parse(input.now)-input.windowSeconds*1000;
    if(input.metric!=="failure_count")return [...this.providerSettlements.values()].filter(value=>value.projectId===input.projectId&&value.status==="settled"&&value.settledAt!==null&&(cutoff===null||Date.parse(value.settledAt)>=cutoff)&&(input.endpointId===null||value.endpointId===input.endpointId)).reduce((sum,value)=>sum+(input.metric==="provider_requests"?1:input.metric==="provider_tokens"?(value.usage?.tokens??0):(value.usage?.cost??0)),0);
    return this.auditEvents.filter(event=>event.projectId===input.projectId&&(cutoff===null||Date.parse(event.createdAt)>=cutoff)&&(input.endpointId===null||event.detail?.endpointId===input.endpointId)&&failureEventMatches(input.alertType,event)).length;
  }
  private transitionSettlement(id: string, allowed: ProjectProviderSettlement["status"][], status: ProjectProviderSettlement["status"], updatedAt: string, timestamp?: "dispatchedAt" | "deliveredAt"): ProjectProviderSettlement | null { const current = this.providerSettlements.get(id); if (!current) return null; if (current.status === status) return clone(current); if (!allowed.includes(current.status)) return null; const updated = { ...current, status, ...(timestamp ? { [timestamp]: updatedAt } : {}), updatedAt } as ProjectProviderSettlement; this.providerSettlements.set(id, clone(updated)); return clone(updated); }
  private settlementResult(settlement: ProjectProviderSettlement): ProjectProviderUsageSettlement | null { const policy = this.policies.get(settlement.projectId); const usage = this.usage.get(settlement.projectId); if (!policy || !usage) return null; return { usage: clone(usage), endpointId: settlement.endpointId, actorId:settlement.actorId??null, exceededLimits: [...(policy.providerRequestsLimit !== null && usage.providerRequests > policy.providerRequestsLimit ? ["provider_requests_limit" as const] : []), ...(policy.providerTokensLimit !== null && usage.providerTokens > policy.providerTokensLimit ? ["provider_tokens_limit" as const] : []), ...(policy.providerCostLimit !== null && usage.providerCost > policy.providerCostLimit ? ["provider_cost_limit" as const] : [])] }; }
  async upsertActiveProjectAlert(alert: ActiveProjectAlert): Promise<ActiveProjectAlert> {
    const normalized: ActiveProjectAlert = { ...alert, metric: alert.metric ?? null, metricValue: alert.metricValue ?? null, threshold: alert.threshold ?? null, subjectActorId:alert.subjectActorId??null };
    if(normalized.subjectActorId!==null&&((normalized.ruleId??null)!==null||(normalized.endpointId??null)===null||!isProviderLimitAlert(normalized.type)))throw new Error("Alert subject actor is valid only for an unconfigured endpoint provider quota");
    const existing = [...this.alerts.values()].find((value) => isActiveProjectAlert(value) && value.projectId === normalized.projectId && value.type === normalized.type && (value.ruleId??null)===(normalized.ruleId??null) && (value.endpointId??null)===(normalized.endpointId??null) && (value.subjectActorId??null)===(normalized.subjectActorId??null));
    const stored: ActiveProjectAlert = existing ? { ...existing, type: normalized.type, status: "active", metric: normalized.metric ?? null, metricValue: normalized.metricValue ?? null, threshold: normalized.threshold ?? null, updatedAt: normalized.updatedAt } : normalized;
    this.alerts.set(stored.id, clone(stored)); return clone(stored);
  }
  async queryProjectAlerts(projectId:string,query:import("../../ports/src/store.js").ProjectAlertStoreQuery):Promise<import("../../ports/src/store.js").ProjectAlertStorePage>{
    const snapshot=[...this.alerts.values()].filter((alert)=>alert.projectId===projectId).map(clone);
    const activeCount=snapshot.filter((alert)=>alert.status==="active").length;
    const filtered=snapshot.filter((alert)=>(query.view==="active"?alert.status==="active":alert.status!=="active")&&(!query.after||alert.createdAt<query.after.createdAt||alert.createdAt===query.after.createdAt&&compareC(alert.id,query.after.id)<0)).sort((left,right)=>compareOrdinal(right.createdAt,left.createdAt)||compareC(right.id,left.id));
    const page=filtered.slice(0,query.limit);
    return{items:page.map((alert)=>this.alertView(alert)),hasMore:filtered.length>query.limit,activeCount};
  }
  async findActiveProjectAlert(projectId:string,type:ProjectAlertType,ruleId:string|null,endpointId:string|null,subjectActorId:string|null):Promise<ActiveProjectAlert|null>{const active=[...this.alerts.values()].filter((value):value is ActiveProjectAlert=>value.status==="active");const alert=active.find((value)=>value.projectId===projectId&&value.type===type&&(value.ruleId??null)===ruleId&&(value.endpointId??null)===endpointId&&(value.subjectActorId??null)===subjectActorId);return alert?clone(alert):null}
  async findProjectAlert(projectId: string, id: string): Promise<ProjectAlert | null> { const alert=this.alerts.get(id);return alert?.projectId===projectId?this.alertView(alert):null; }
  async transitionProjectAlert(projectId: string, id: string, status: "resolved" | "dismissed", updatedAt: string): Promise<ProjectAlert | null> { const alert = this.alerts.get(id); if (!alert || alert.projectId !== projectId || alert.status !== "active") return null; const next = { ...alert, status, updatedAt, ...(status === "resolved" ? { resolvedAt: updatedAt } : { dismissedAt: updatedAt }) }; this.alerts.set(id, clone(next)); return this.alertView(next); }
  async updateProjectAlertState(projectId:string,id:string,input:{acknowledgedAt?:string;acknowledgedBy?:string;silencedUntil?:string|null},updatedAt:string){const alert=this.alerts.get(id);if(!alert||alert.projectId!==projectId||alert.status!=="active")return null;const next={...alert,...input,updatedAt};this.alerts.set(id,clone(next));return this.alertView(next)}
  async updateProjectAlertDeliveryStatus(projectId: string, id: string, status: ProjectAlert["deliveryStatus"], updatedAt: string): Promise<ProjectAlert | null> { const alert = this.alerts.get(id); if (!alert || alert.projectId !== projectId) return null; const next = { ...alert, deliveryStatus: status, updatedAt }; this.alerts.set(id, clone(next)); return clone(next); }
  async appendProjectAuditEvent(event: ProjectAuditEvent): Promise<void> { if(this.auditEvents.some(current=>current.id===event.id))return;this.auditEvents.push(clone({...event,detail:sanitizeProjectAuditDetail(event.detail)})); }
  async queryProjectAuditEvents(projectId:string,query:import("../../ports/src/store.js").ProjectAuditStoreQuery):Promise<import("../../ports/src/store.js").ProjectAuditStorePage>{
    const events=this.auditEvents.filter((event)=>event.projectId===projectId).map(clone);
    const users=new Map([...this.users].map(([id,user])=>[id,clone(user)]));
    const profiles=new Map([...this.profiles].map(([id,profile])=>[id,clone(profile)]));
    const filtered=events.filter((event)=>
      (!Object.hasOwn(query,"actorId")||event.actorId===query.actorId)
      &&(!Object.hasOwn(query,"subjectUserId")||(event.subjectUserId??null)===query.subjectUserId)
      &&(!query.action||event.action===query.action)
      &&(!query.status||event.status===query.status)
      &&(!query.resourceKind||event.resourceKind===query.resourceKind)
      &&(!query.resourceId||event.resourceId===query.resourceId)
      &&(!query.from||event.createdAt>=query.from)
      &&(!query.to||event.createdAt<=query.to)
      &&(!query.after||event.createdAt<query.after.createdAt||event.createdAt===query.after.createdAt&&compareC(event.id,query.after.id)<0)
    ).sort((left,right)=>compareOrdinal(right.createdAt,left.createdAt)||compareC(right.id,left.id));
    const identity=(id:string|null|undefined)=>{const user=id?users.get(id):undefined;return{displayName:id?profiles.get(id)?.displayName??null:null,email:user?.email??null}};
    const page=filtered.slice(0,query.limit);
    return{items:page.map((event)=>{const actor=identity(event.actorId),subject=identity(event.subjectUserId);return{...event,actorDisplayName:actor.displayName,actorEmail:actor.email,subjectDisplayName:subject.displayName,subjectEmail:subject.email}}),hasMore:filtered.length>query.limit};
  }
  async queryProjectAuditIdentities(projectId:string,query:import("../../ports/src/store.js").ProjectAuditIdentityStoreQuery):Promise<import("../../ports/src/store.js").ProjectAuditIdentityStorePage>{
    const ids=new Set(this.auditEvents.filter((event)=>event.projectId===projectId).flatMap((event)=>{const id=query.role==="actor"?event.actorId:event.subjectUserId??null;return id?[id]:[]}));
    const normalizedQ=query.q.toLowerCase();
    const candidates=[...ids].map((id)=>({id,displayName:this.profiles.get(id)?.displayName??null,email:this.users.get(id)?.email??null}))
      .filter((identity)=>!normalizedQ||[identity.id,identity.displayName,identity.email].some((value)=>value?.toLowerCase().includes(normalizedQ)))
      .sort((left,right)=>Number(right.id.toLowerCase()===query.q)-Number(left.id.toLowerCase()===query.q)||compareC(left.id,right.id))
      .filter((identity)=>{
        if(!query.after)return true;
        const identityExact=identity.id.toLowerCase()===query.q,afterExact=query.after.id.toLowerCase()===query.q;
        return afterExact?(identityExact&&compareC(identity.id,query.after.id)>0||!identityExact):!identityExact&&compareC(identity.id,query.after.id)>0;
      });
    return{items:candidates.slice(0,query.limit).map(clone),hasMore:candidates.length>query.limit};
  }
  private terminalizeTerminalStartOwner(
    run:PersistedSandboxRunState,
    updatedAt:string,
    outcome=terminalBoundRunReceipt(run,null)
  ):()=>void{
    const pending=[...this.taskIdempotency.entries()].filter(([,record])=>
      record.operation==="terminal-start"&&record.resourceId===run.runId&&record.status==="in_progress"
    );
    if(pending.length>1)throw new Error("Terminal startup receipt is ambiguous");
    const owner=pending[0];
    if(!owner)return()=>{};
    const previous=clone(owner[1]);
    this.taskIdempotency.set(owner[0],{
      ...owner[1],status:"completed",responseStatus:outcome.responseStatus,
      responseBody:clone(outcome.responseBody),updatedAt
    });
    return()=>this.taskIdempotency.set(owner[0],previous);
  }
  async activateTaskSandboxRun(input:ActivateTaskSandboxRunInput):Promise<ActivateTaskSandboxRunResult>{
    return this.sandboxRunRecords.activateTask(input,()=>this.tasks.get(input.taskId),(event,activatedRun)=>{
      const restoreReceipt=this.terminalizeTerminalStartOwner(
        activatedRun,
        input.activatedAt,
        {responseStatus:200,responseBody:terminalActivatedReceipt(input.runId)}
      );
      const previousAuditLength=this.auditEvents.length;
      try{
        if(!this.auditEvents.some((current)=>current.id===event.id))this.auditEvents.push(clone({...event,detail:sanitizeProjectAuditDetail(event.detail)}));
      }catch(error){
        restoreReceipt();
        this.auditEvents.splice(previousAuditLength);
        throw error;
      }
    });
  }
  async completeSandboxRunRelease(input:CompleteSandboxRunReleaseInput):Promise<CompleteSandboxRunReleaseResult>{
    try{return await this.atomicTaskMessageMutation([],()=>this.sandboxRunRecords.completeRelease(input,(replay)=>{
      const task=this.tasks.get(input.run.taskId);
      const project=this.projects.get(input.run.projectId);
      if(!taskMatchesActiveSandboxRun(task,project,input.run))throw new Error("Sandbox usage task conflict");
      const existing=this.sandboxUsageSettlements.get(input.runId);
      if(existing&&!sameSettlement(existing,input.settlement))throw new Error("Sandbox usage settlement conflict");
      if(replay){if(!existing)throw new Error("Sandbox usage settlement conflict");}
      const restoreReceipt=this.terminalizeTerminalStartOwner(input.run,input.run.updatedAt);
      if(input.releaseReceipt){
        for(const [key,record] of this.taskIdempotency){
          if(record.projectId!==input.run.projectId||record.operation!=="release-sandbox"||record.resourceId!==input.runId||record.status!=="in_progress")continue;
          this.taskIdempotency.set(key,{
            ...record,status:"completed",responseStatus:input.releaseReceipt.responseStatus,
            responseBody:clone(input.releaseReceipt.responseBody),updatedAt:input.releaseReceipt.updatedAt
          });
        }
      }
      if(!existing)this.sandboxUsageSettlements.set(input.runId,clone(input.settlement));
      if(!replay)this.setAuthoritativeActiveTaskUsage(input.run.projectId,input.run.releasedAt!);
      try{
        if(!this.auditEvents.some((event)=>event.id===input.auditEvent.id))this.auditEvents.push(clone({...input.auditEvent,detail:sanitizeProjectAuditDetail(input.auditEvent.detail)}));
      }catch(error){
        restoreReceipt();
        throw error;
      }
    }));}catch(error){if(error instanceof Error&&(error.message==="Sandbox usage settlement conflict"||error.message==="Sandbox usage task conflict"))return"conflict";throw error}
  }
  async failSandboxRun(input:SandboxRunFailureInput):Promise<PersistedSandboxRunState|null>{
    return this.sandboxRunRecords.fail(input,(event,failed)=>{
      const restoreReceipt=this.terminalizeTerminalStartOwner(failed,input.failedAt);
      try{
        if(!this.auditEvents.some((current)=>current.id===event.id))this.auditEvents.push(clone({...event,detail:sanitizeProjectAuditDetail(event.detail)}));
      }catch(error){
        restoreReceipt();
        throw error;
      }
    });
  }
  async failTaskSandboxStartupAtomically(input:FailTaskSandboxStartupAtomicallyInput):Promise<FailTaskSandboxStartupAtomicallyResult>{
    const key=taskIdempotencyKey(input.idempotency);
    const record=this.taskIdempotency.get(key);
    if(!record||record.requestHash!==input.idempotency.requestHash)return{kind:"conflict"};
    if(record.status==="completed")return{kind:"replay",responseStatus:record.responseStatus!,responseBody:clone(record.responseBody)};
    if(record.claimToken!==input.idempotency.claimToken||record.operation!=="terminal-start"||record.resourceId!==input.failure.runId)return{kind:"conflict"};
    const current=await this.sandboxRunRecords.get(input.failure.runId);
    const task=current?this.tasks.get(current.taskId):undefined;
    if(!current||!task||input.taskId!==task.id||task.currentRunId!==input.failure.runId||task.projectId!==input.idempotency.projectId||current.startupClaimToken!==input.startupClaimToken||!strictStructuralEqual(current.resourceNames,input.resourceIdentity))return{kind:"conflict"};
    const failed=await this.sandboxRunRecords.fail(input.failure,(event,finalRun)=>{
      const restoreReceipt=this.terminalizeTerminalStartOwner(
        finalRun,input.idempotency.updatedAt,
        {responseStatus:input.idempotency.responseStatus,responseBody:input.idempotency.responseBody}
      );
      try{
        if(!this.auditEvents.some((current)=>current.id===event.id))this.auditEvents.push(clone({...event,detail:sanitizeProjectAuditDetail(event.detail)}));
      }catch(error){
        restoreReceipt();
        throw error;
      }
    });
    return failed?{kind:"failed",run:failed}:{kind:"conflict"};
  }
  async markTaskSandboxStartupReady(input:import("../../ports/src/store.js").MarkTaskSandboxStartupReadyInput):Promise<PersistedSandboxRunState|null>{
    return this.sandboxRunRecords.markStartupReady(input,()=>this.tasks.get(input.taskId));
  }
  async initializeTaskSandboxStartupConfig(input:import("../../ports/src/store.js").InitializeTaskSandboxStartupConfigInput):Promise<PersistedSandboxRunState|null>{
    return this.sandboxRunRecords.initializeStartupConfig(input,()=>this.tasks.get(input.taskId));
  }
  async recordTaskSandboxStartupPod(input:import("../../ports/src/store.js").RecordTaskSandboxStartupPodInput):Promise<PersistedSandboxRunState|null>{
    return this.sandboxRunRecords.recordStartupPod(input,()=>this.tasks.get(input.taskId));
  }
  async claimSandboxStartup(input:SandboxStartupOperationInput):Promise<import("../../ports/src/store.js").SandboxStartupClaimResult>{
    return this.sandboxRunRecords.claimStartup(input,()=>this.tasks.get(input.taskId));
  }
  async beginSandboxStartupAction(input:import("../../ports/src/store.js").BeginSandboxStartupActionInput):Promise<PersistedSandboxRunState|null>{
    return this.sandboxRunRecords.beginStartupAction(input,()=>this.tasks.get(input.taskId));
  }
  async completeSandboxStartupAction(input:import("../../ports/src/store.js").CompleteSandboxStartupActionInput):Promise<PersistedSandboxRunState|null>{
    return this.sandboxRunRecords.completeStartupAction(input,()=>this.tasks.get(input.taskId));
  }
  async recoverSandboxStartupAction(input:import("../../ports/src/store.js").RecoverSandboxStartupActionInput):Promise<PersistedSandboxRunState|null>{
    return this.sandboxRunRecords.recoverStartupAction(input,()=>this.tasks.get(input.taskId));
  }
  async drainSandboxStartupAction(input:import("../../ports/src/store.js").DrainSandboxStartupActionInput):Promise<PersistedSandboxRunState|null>{
    return this.sandboxRunRecords.drainStartupAction(input,()=>this.tasks.get(input.taskId),(event,drained)=>{
      const restoreReceipt=this.terminalizeTerminalStartOwner(drained,input.drainedAt);
      try{
        if(!this.auditEvents.some((current)=>current.id===event.id))this.auditEvents.push(clone({...event,detail:sanitizeProjectAuditDetail(event.detail)}));
      }catch(error){
        restoreReceipt();
        throw error;
      }
    });
  }
  async querySandboxUsageSettlements(query:ProjectSandboxSettlementQuery):Promise<ProjectSandboxSettlementPage>{
    const filtered=[...this.sandboxUsageSettlements.values()].filter((value)=>value.projectId===query.projectId&&value.startedByUserId===query.selectedUserId&&value.releasedAt<=query.scopeMeasuredAt&&(!query.after||value.releasedAt<query.after.releasedAt||value.releasedAt===query.after.releasedAt&&compareOrdinal(value.runId,query.after.runId)<0)).sort((left,right)=>right.releasedAt.localeCompare(left.releasedAt)||compareOrdinal(right.runId,left.runId));
    const page=filtered.slice(0,query.limit),items=page.map((value)=>{const task=this.tasks.get(value.taskId),taskAvailable=Boolean(task&&!task.deletedAt);return{taskId:value.taskId,taskTitle:taskAvailable?task!.title??null:null,taskAvailable,runId:value.runId,fileLibraryId:value.fileLibraryId,startedAt:value.startedAt,releasedAt:value.releasedAt,durationSeconds:value.durationSeconds,resources:clone(value.resources),releaseReason:value.releaseReason}});
    return{items,hasMore:filtered.length>query.limit};
  }
  async listSandboxUsageSettlements(projectId:string,startedByUserId:string):Promise<SandboxUsageSettlement[]>{return[...this.sandboxUsageSettlements.values()].filter((value)=>value.projectId===projectId&&value.startedByUserId===startedByUserId).sort((a,b)=>b.releasedAt.localeCompare(a.releasedAt)||b.runId.localeCompare(a.runId)).map(clone)}
  async createProjectCredential(v:StoredProjectCredential): Promise<ProjectCredential> { this.credentials.set(v.id,clone(v)); return publicCredential(v); }
  async findStoredProjectCredential(projectId:string,id:string):Promise<StoredProjectCredential|null>{const value=this.credentials.get(id);return clone(value?.projectId===projectId?value:null)}
  async findProjectCredentialView(projectId:string,id:string):Promise<ProjectCredential|null>{const value=this.credentials.get(id);return value?.projectId===projectId?publicCredential(value):null}
  async listProjectCredentialDirectoryPage(projectId:string,query:import("../../ports/src/store.js").CreatedDirectoryStoreQuery):Promise<ProjectCredential[]>{
    return[...this.credentials.values()].filter((value)=>value.projectId===projectId&&providerDirectoryMatch([value.id,value.name,value.baseUrl],query.q)).sort(compareCreatedDirectoryDesc).filter((value)=>!query.after||compareCreatedDirectoryToCursor(value,query.after)>0).slice(0,query.limit).map(publicCredential);
  }
  async updateProjectCredential(v:StoredProjectCredential,expectedVersion:number): Promise<ProjectCredential | "not_found" | "version_conflict"> { const current=this.credentials.get(v.id); if(!current)return "not_found"; if(current.projectId!==v.projectId||current.version!==expectedVersion)return "version_conflict"; this.credentials.set(v.id,clone(v));for(const [id,endpoint] of this.endpoints){if(endpoint.credentialId===v.id)this.endpoints.set(id,clone({...endpoint,health:{status:"unknown",checkedAt:null,errorCategory:null},updatedAt:v.updatedAt}))}return publicCredential(v); }
  async deleteProjectCredential(id:string,projectId:string,expectedVersion:number): Promise<DeleteProjectCredentialResult> { const current=this.credentials.get(id);if(!current||current.projectId!==projectId)return "not_found";if(current.version!==expectedVersion)return "version_conflict";if([...this.endpoints.values()].some(endpoint=>endpoint.credentialId===id))return "referenced_by_endpoints";this.credentials.delete(id);return "deleted"; }
  async createProjectContextEntry(v:ProjectContextEntry){if(this.contextKeyExists(v))return null;this.contexts.set(v.id,clone(v));return clone(v)}
  async updateProjectContextEntry(v:ProjectContextEntry,expectedVersion:number){const current=this.contexts.get(v.id);if(!current||current.version!==expectedVersion||this.contextKeyExists(v,v.id))return null;this.contexts.set(v.id,clone(v));return clone(v)}
  async listProjectContextEntryMetadataPage(query:import("../../ports/src/store.js").ProjectContextMetadataStoreQuery){
    return [...this.contexts.values()]
      .filter((v)=>v.workspaceId===query.workspaceId&&v.projectId===query.projectId&&v.scope===query.scope&&v.ownerUserId===query.ownerUserId&&(query.afterContextKey===undefined||compareC(v.contextKey,query.afterContextKey)>0))
      .sort((left,right)=>compareC(left.contextKey,right.contextKey))
      .slice(0,query.limit)
      .map(({content:_,...metadata})=>clone(metadata));
  }
  async listProjectContextEntryPage(query:import("../../ports/src/store.js").ProjectContextMetadataStoreQuery){
    return [...this.contexts.values()]
      .filter((v)=>v.workspaceId===query.workspaceId&&v.projectId===query.projectId&&v.scope===query.scope&&v.ownerUserId===query.ownerUserId&&(query.afterContextKey===undefined||compareC(v.contextKey,query.afterContextKey)>0))
      .sort((left,right)=>compareC(left.contextKey,right.contextKey))
      .slice(0,query.limit)
      .map(clone);
  }
  async findProjectContextEntryByKey(workspaceId:string,projectId:string|null,scope:ProjectContextEntry["scope"],ownerUserId:string|null,contextKey:string){return clone([...this.contexts.values()].find((v)=>v.workspaceId===workspaceId&&v.projectId===projectId&&v.scope===scope&&v.ownerUserId===ownerUserId&&v.contextKey===contextKey)??null)}
  async findProjectContextEntryById(id:string,workspaceId:string,projectId:string|null,scope:ProjectContextEntry["scope"],ownerUserId:string|null){const v=this.contexts.get(id);return clone(v&&v.workspaceId===workspaceId&&v.projectId===projectId&&v.scope===scope&&v.ownerUserId===ownerUserId?v:null)}
  async deleteProjectContextEntry(v:Pick<ProjectContextEntry,"id"|"workspaceId"|"projectId"|"scope"|"ownerUserId"|"version">){const current=this.contexts.get(v.id);if(!current||current.workspaceId!==v.workspaceId||current.projectId!==v.projectId||current.scope!==v.scope||current.ownerUserId!==v.ownerUserId||current.version!==v.version)return false;return this.contexts.delete(v.id)}
  async createProjectAlertRule(v:ProjectAlertRule){if([...this.alertRules.values()].filter((rule)=>rule.projectId===v.projectId).length>=50)return null;this.alertRules.set(v.id,clone(v));return clone(v)}
  async listProjectAlertRules(id:string){const rules=[...this.alertRules.values()].filter((rule)=>rule.projectId===id).sort((left,right)=>compareOrdinal(left.createdAt,right.createdAt)||compareC(left.id,right.id));if(rules.length>50)throw new Error("Project alert rule limit exceeded");return rules.map(clone)}
  async listProjectAlertRuleViews(projectId:string){return(await this.listProjectAlertRules(projectId)).map((rule)=>this.alertRuleView(rule))}
  async findProjectAlertRule(projectId:string,id:string){const rule=this.alertRules.get(id);return rule?.projectId===projectId?clone(rule):null}
  async findProjectAlertRuleView(projectId:string,id:string){const rule=await this.findProjectAlertRule(projectId,id);return rule?this.alertRuleView(rule):null}
  async updateProjectAlertRule(v:ProjectAlertRule,expectedUpdatedAt?:string){const current=this.alertRules.get(v.id);if(!current||current.projectId!==v.projectId||(expectedUpdatedAt!==undefined&&current.updatedAt!==expectedUpdatedAt))return null;this.alertRules.set(v.id,clone(v));return clone(v)}
  async deleteProjectAlertRule(projectId:string,id:string){
    const current=this.alertRules.get(id);
    if(!current||current.projectId!==projectId)return false;
    this.alertRules.delete(id);
    for(const [alertId,alert] of this.alerts){
      if(alert.ruleId===id)this.alerts.set(alertId,clone({...alert,ruleId:null}));
    }
    return true;
  }

  async createEndpoint(endpoint: ModelEndpoint, expectedCredentialVersion?: number): Promise<ModelEndpoint> {
    this.requireCredentialVersion(endpoint.credentialId, expectedCredentialVersion);
    this.requireEndpointCredentialProject(endpoint);
    if (this.endpointNameExists(endpoint)) throw new EndpointNameConflictError();
    this.endpoints.set(endpoint.id, clone(endpoint));
    return clone(endpoint);
  }

  async updateEndpoint(endpoint: ModelEndpoint, expectedUpdatedAt?: string, expectedCredentialVersion?: number): Promise<ModelEndpoint | null> {
    const current = this.endpoints.get(endpoint.id);
    if (!current || expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      return null;
    }
    this.requireCredentialVersion(endpoint.credentialId, expectedCredentialVersion);
    this.requireEndpointCredentialProject(endpoint);
    if (this.endpointNameExists(endpoint, endpoint.id)) throw new EndpointNameConflictError();
    this.endpoints.set(endpoint.id, clone(endpoint));
    return clone(endpoint);
  }

  async updateEndpointHealth(id: string, projectId: string, health: EndpointHealth, updatedAt: string, expectedUpdatedAt?: string, expectedCredentialVersion?: number): Promise<ModelEndpoint | null> {
    const current = this.endpoints.get(id);
    if (!current || current.projectId !== projectId || expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) return null;
    this.requireCredentialVersion(current.credentialId, expectedCredentialVersion);
    const updated = { ...current, health: clone(health), updatedAt };
    this.endpoints.set(id, clone(updated));
    return clone(updated);
  }

  private requireEndpointCredentialProject(endpoint: ModelEndpoint): void {
    if (!endpoint.credentialId) return;
    const credential = this.credentials.get(endpoint.credentialId);
    if (!credential || credential.projectId !== endpoint.projectId) throw new Error("Endpoint credential must belong to the same project");
  }

  private requireCredentialVersion(credentialId: string, expectedVersion?: number): void {
    if (expectedVersion !== undefined && this.credentials.get(credentialId)?.version !== expectedVersion) throw new CredentialVersionConflictError();
  }

  private endpointNameExists(endpoint: ModelEndpoint, excludeId?: string): boolean {
    const name = endpoint.name.trim().toLocaleLowerCase("en-US");
    return [...this.endpoints.values()].some((candidate) => candidate.id !== excludeId && candidate.projectId === endpoint.projectId && candidate.name.trim().toLocaleLowerCase("en-US") === name);
  }

  async deleteEndpoint(id: string): Promise<DeleteEndpointResult> {
    if (!this.endpoints.has(id)) return "not_found";
    if ([...this.tasks.values()].some((task) => task.endpointId === id)) return "referenced_by_tasks";

    for (const [settlementId, settlement] of this.providerSettlements) {
      if (settlement.endpointId === id) this.providerSettlements.set(settlementId, clone({ ...settlement, endpointId: null }));
    }
    for (const [projectId, policy] of this.policies) {
      if (policy.endpointWindows?.some((window) => window.endpointId === id)) {
        this.policies.set(projectId, clone({ ...policy, endpointWindows: policy.endpointWindows.filter((window) => window.endpointId !== id) }));
      }
    }
    for (const [ruleId, rule] of this.alertRules) {
      if (rule.scope?.kind === "endpoint" && rule.scope.endpointId === id) await this.deleteProjectAlertRule(rule.projectId, ruleId);
    }
    const resolvedAt = new Date().toISOString();
    for (const [alertId, alert] of this.alerts) {
      if (alert.endpointId === id) this.alerts.set(alertId, clone({
        ...alert,
        endpointId: null,
        ...(alert.status === "active" ? { status: "resolved" as const, resolvedAt, updatedAt: resolvedAt } : {})
      }));
    }
    this.endpoints.delete(id);
    return "deleted";
  }

  async findEndpoint(id: string): Promise<ModelEndpoint | null> {
    return clone(this.endpoints.get(id) ?? null);
  }
  async findEndpointView(projectId:string,id:string):Promise<import("../../contracts/src/api.js").EndpointView|null>{const endpoint=this.endpoints.get(id);return endpoint?.projectId===projectId?this.endpointView(endpoint):null}
  async listEndpointDirectoryPage(projectId:string,query:import("../../ports/src/store.js").EndpointDirectoryStoreQuery):Promise<import("../../ports/src/store.js").EndpointDirectoryStorePage>{
    const filtered=[...this.endpoints.values()].filter((endpoint)=>endpoint.projectId===projectId&&providerDirectoryMatch([endpoint.id,endpoint.name,endpoint.model,endpoint.baseUrl],query.q)&&(query.mode==="all"||taskReadyEndpoint(endpoint))).sort(compareCreatedDirectoryDesc);
    return{items:filtered.filter((endpoint)=>!query.after||compareCreatedDirectoryToCursor(endpoint,query.after)>0).slice(0,query.limit).map((endpoint)=>this.endpointView(endpoint)),total:filtered.length};
  }
  async projectEndpointNameExists(projectId:string,normalizedName:string,excludeId?:string):Promise<boolean>{return[...this.endpoints.values()].some((endpoint)=>endpoint.projectId===projectId&&endpoint.id!==excludeId&&endpoint.name.trim().toLocaleLowerCase("en-US")===normalizedName)}
  async findProjectEndpointIds(projectId:string,ids:string[]):Promise<string[]>{const wanted=new Set(ids);return[...this.endpoints.values()].filter((endpoint)=>endpoint.projectId===projectId&&wanted.has(endpoint.id)).map((endpoint)=>endpoint.id).sort(compareC)}
  async getProjectEndpointReadiness(projectId:string):Promise<{total:number;taskReady:number}>{const endpoints=[...this.endpoints.values()].filter((endpoint)=>endpoint.projectId===projectId);return{total:endpoints.length,taskReady:endpoints.filter(taskReadyEndpoint).length}}

  private endpointView(endpoint:ModelEndpoint):import("../../contracts/src/api.js").EndpointView{
    const credential=this.credentials.get(endpoint.credentialId);
    return{...clone(endpoint),hasCredentialRef:endpoint.credentialId.length>0,taskEligible:taskReadyEndpoint(endpoint),credential:credential?.projectId===endpoint.projectId?{id:credential.id,name:credential.name,baseUrl:credential.baseUrl,version:credential.version}:null};
  }
  private alertView(alert:ProjectAlert):ProjectAlert{
    const endpoint=alert.endpointId?this.endpoints.get(alert.endpointId):undefined;
    return clone({...alert,endpointName:endpoint?.projectId===alert.projectId?endpoint.name:null});
  }
  private alertRuleView(rule:ProjectAlertRule):import("../../contracts/src/api.js").ProjectAlertRuleView{
    const endpoint=rule.scope?.kind==="endpoint"?this.endpoints.get(rule.scope.endpointId):undefined;
    return clone({...rule,endpointName:endpoint?.projectId===rule.projectId?endpoint.name:null});
  }

  async createTaskAtomically(input: AtomicTaskCreateInput) {
    return this.atomicTaskMessageMutation([input],async()=>{
    validateTaskRunReservation(input);
    const idempotency=input.idempotency??(input.reserveActive?requiredAdmissionCreateIdempotency(input):null);
    let ownedClaimToken:string|undefined;
    const reject=(kind:AtomicTaskCreateDeterministicRejection["kind"]):AtomicTaskCreateDeterministicRejection=>
      ownedClaimToken?{kind,claimToken:ownedClaimToken}:{kind};
    if(idempotency){
      const claimed=this.claimAtomicTaskMessageMutation(idempotency);
      if(claimed.kind==="in_progress"){
        const record=this.taskIdempotency.get(taskIdempotencyKey(idempotency));
        if(!record)throw new Error("Task create idempotency record is unavailable");
        return{kind:"in_progress" as const,resourceId:record.resourceId};
      }
      if(claimed.kind!=="claimed")return claimed;
      ownedClaimToken=idempotency.claimToken;
      if(claimed.resourceId!==input.task.id){
        const existing=this.tasks.get(claimed.resourceId);
        return existing
          ?{kind:"resume" as const,task:clone(existing),claimToken:idempotency.claimToken}
          :{kind:"in_progress" as const,resourceId:claimed.resourceId};
      }
    }
    if (this.tasks.has(input.task.id)) throw new Error("Task already exists");
    const project=this.projects.get(input.task.projectId);
    if(!project||(project.lifecycleStatus??"active")!=="active")return reject("project_unavailable");
    let library=input.task.fileLibraryId?this.fileLibraries.get(input.task.fileLibraryId):undefined;
    if(input.newFileLibrary){if(library||await this.createFileLibrary(input.newFileLibrary)===null)return reject("library_name_conflict");library=input.newFileLibrary;}
    if(!library||library.workspaceId!==input.task.workspaceId||library.projectId!==input.task.projectId){if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id);return reject("library_not_found");}
    if(library.lifecycleStatus==="deleting"){if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id);return reject("library_deleting");}
    if([...this.tasks.values()].some((task)=>task.fileLibraryId===library.id)){if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id);return reject("already_bound");}
    const task = normalizeStoredTask(input.task);
    if (input.reserveActive) {
      const rejected=await this.admitSandboxRun(input.admission,input.sandboxRun!,task.updatedAt,idempotency!,input.rejectionPresentation!,input.rejectedAuditEvent!);
      if(rejected){if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id);return rejected;}
    }
    this.tasks.set(task.id, clone(task));
    this.initializeTaskInteractionSync(task.id);
    try {
      if (input.runtimeState) await this.jsonDocs.put("sandbox_runtime_state", task.id, input.runtimeState);
      if (input.sandboxRun?.state==="released") await this.sandboxRunRecords.put(input.sandboxRun);
      if(input.initialMessage)await this.createTaskMessage(input.initialMessage);
      if(input.initialInteractionChange)this.appendInteractionChanges(task.id,[input.initialInteractionChange]);
      if(input.auditEvent&&!this.auditEvents.some((event)=>event.id===input.auditEvent!.id))await this.appendProjectAuditEvent(input.auditEvent);
      return{kind:"created" as const,task:clone(task)};
    } catch (error) {
      this.tasks.delete(task.id);
      if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id);
      this.interactionSync.delete(task.id);
      await this.jsonDocs.delete("sandbox_runtime_state", task.id);
      if (input.sandboxRun) this.sandboxRunRecords.delete(input.sandboxRun.runId);
      if(input.initialMessage){const index=this.messages.findIndex((message)=>message.id===input.initialMessage!.id);if(index>=0)this.messages.splice(index,1);}
      if(input.initialInteractionChange)this.interactionChanges.splice(0,this.interactionChanges.length,...this.interactionChanges.filter((change)=>change.interaction.taskId!==task.id));
      throw error;
    }
    });
  }

  async restartTaskSandboxAtomically(input: AtomicTaskSandboxRestartInput): Promise<AtomicTaskSandboxRestartResult> {
    return this.atomicTaskMessageMutation([{task:input.task}],async()=>{
      const receipt=requiredSandboxRestartAdmission(input);
      const claimed=this.claimAtomicTaskMessageMutation(receipt.idempotency);
      if(claimed.kind!=="claimed")return claimed;
      if(claimed.resourceId!==input.task.id)throw new Error("Terminal start idempotency resource is inconsistent");
      const project=this.projects.get(input.task.projectId);
      if(!project||(project.lifecycleStatus??"active")!=="active")return{kind:"conflict" as const};
      const current=this.tasks.get(input.task.id);
      if(!current||current.deletedAt||current.archivedAt)return{kind:"conflict" as const};
      if(current.currentRunId!==input.expectedReleasedRunId)return{kind:"conflict" as const};
      if(input.expectedReleasedRunId!==null){
        const released=await this.sandboxRuns.get(input.expectedReleasedRunId);
        if(!released||!taskRunScopeMatches(current,released)||released.state!=="released")return{kind:"conflict" as const};
      }
      if(!sandboxRestartIdentityMatches(current,input))return{kind:"conflict" as const};
      const rejected=await this.admitSandboxRun(input.admission,input.sandboxRun,input.reservedAt,receipt.idempotency,receipt.presentation,receipt.auditEvent);
      if(rejected)return rejected;
      const restarted=normalizeStoredTask({...current,currentRunId:input.sandboxRun.runId,updatedAt:input.reservedAt});
      this.tasks.set(restarted.id,clone(restarted));
      await this.jsonDocs.put("sandbox_runtime_state",restarted.id,input.runtimeState);
      return{kind:"restarted",task:clone(restarted)};
    });
  }

  async beginTerminalStart(input:import("../../ports/src/store.js").BeginTerminalStartInput):Promise<import("../../ports/src/store.js").BeginTerminalStartResult>{
    return this.atomicTaskMessageMutation(input.restart?[{task:input.restart.task}]:[],async()=>{
      const claimed=this.claimAtomicTaskMessageMutation(input.idempotency);
      if(claimed.kind==="hash_mismatch"||claimed.kind==="replay")return claimed;
      const key=taskIdempotencyKey(input.idempotency);
      const record=this.taskIdempotency.get(key);
      const task=this.tasks.get(input.taskId);
      if(!record)return{kind:"conflict"};
      const rejectClaim=()=>{
        const rejected=terminalStartTaskConflictReceipt();
        this.completeAtomicTaskMessageMutation({...input.idempotency,claimToken:record.claimToken},rejected.responseStatus,rejected.responseBody,input.idempotency.now);
        return{kind:"replay" as const,...rejected};
      };
      if(!task||task.deletedAt||task.archivedAt||task.projectId!==input.idempotency.projectId)return rejectClaim();
      const otherOwner=[...this.taskIdempotency.entries()].find(([candidateKey,candidate])=>
        candidateKey!==key&&candidate.operation==="terminal-start"&&candidate.status==="in_progress"
        &&(candidate.resourceId===record.resourceId||candidate.resourceId===task.currentRunId)
      );
      if(otherOwner){
        return rejectClaim();
      }
      const persistedRun=await this.sandboxRunRecords.get(record.resourceId);
      if(claimed.kind==="in_progress"){
        if(!persistedRun||!taskRunScopeMatches(task,persistedRun))return rejectClaim();
        if(task.currentRunId===persistedRun.runId&&persistedRun.state==="starting")return{kind:"in_progress",task:clone(task),run:persistedRun};
        const terminal=terminalBoundRunReceipt(persistedRun,input.rejectionPresentation);
        this.completeAtomicTaskMessageMutation({...input.idempotency,claimToken:record.claimToken},terminal.responseStatus,terminal.responseBody,input.idempotency.now);
        return{kind:"replay",...terminal};
      }
      if(persistedRun&&taskRunScopeMatches(task,persistedRun)){
        if(task.currentRunId===persistedRun.runId&&persistedRun.state==="starting")return{kind:"claimed",task:clone(task),run:persistedRun,claimToken:input.idempotency.claimToken};
        const terminal=terminalBoundRunReceipt(persistedRun,input.rejectionPresentation);
        this.completeAtomicTaskMessageMutation(input.idempotency,terminal.responseStatus,terminal.responseBody,input.idempotency.now);
        return{kind:"replay",...terminal};
      }
      const current=task.currentRunId?await this.sandboxRunRecords.get(task.currentRunId):null;
      const restart=input.restart;
      if(!restart||restart.expectedReleasedRunId!==task.currentRunId||restart.sandboxRun.runId!==record.resourceId||!sandboxRestartIdentityMatches(task,restart))return rejectClaim();
      if(task.currentRunId!==null&&(!current||current.state!=="released"||!taskRunScopeMatches(task,current)))return rejectClaim();
      if(!input.admission||!input.rejectedAuditEvent)throw new Error("New Terminal reservation requires admission receipt inputs");
      const readyRun={...restart.sandboxRun,startupReadyAt:restart.reservedAt};
      const rejected=await this.admitSandboxRun(input.admission,readyRun,restart.reservedAt,input.idempotency,input.rejectionPresentation,input.rejectedAuditEvent);
      if(rejected)return rejected;
      const restarted=normalizeStoredTask({...task,currentRunId:restart.sandboxRun.runId,updatedAt:restart.reservedAt});
      this.tasks.set(task.id,clone(restarted));
      await this.jsonDocs.put("sandbox_runtime_state",task.id,restart.runtimeState);
      return{kind:"claimed",task:clone(restarted),run:(await this.sandboxRunRecords.get(restart.sandboxRun.runId))!,claimToken:input.idempotency.claimToken};
    });
  }

  async createTaskMessageAtomically(input:AtomicTaskMessageInput):Promise<AtomicTaskMessageResult>{
    return this.atomicTaskMessageMutation(input.restart?[{task:input.restart.task}]:[],async()=>{
      const key=taskIdempotencyKey(input.idempotency);
      let record=this.taskIdempotency.get(key);
      if(record){
        if(record.requestHash!==input.idempotency.requestHash)return{kind:"hash_mismatch"};
        if(record.status==="completed")return{kind:"replay",responseStatus:record.responseStatus!,responseBody:clone(record.responseBody)};
        if(record.claimToken!==input.idempotency.claimToken){
          if(record.leaseExpiresAt>input.idempotency.now)return{kind:"in_progress"};
          record={...record,claimToken:input.idempotency.claimToken,leaseExpiresAt:input.idempotency.leaseExpiresAt,updatedAt:input.idempotency.now};
          this.taskIdempotency.set(key,record);
        }
      }else{
        record={...input.idempotency,status:"in_progress",responseStatus:null,responseBody:null,updatedAt:input.idempotency.now};
        this.taskIdempotency.set(key,record);
      }
      const project=this.projects.get(input.idempotency.projectId);
      if(!project||(project.lifecycleStatus??"active")!=="active")return{kind:"conflict"};
      let task=this.tasks.get(input.taskId);
      if(!task||task.deletedAt||task.archivedAt||task.projectId!==input.idempotency.projectId)return{kind:"conflict"};
      const message=canonicalTaskMessage(input.message,record.resourceId);
      const existing=this.messages.find((candidate)=>candidate.id===message.id);
      if(existing)return{kind:"created",task:clone(task),message:clone(existing),restarted:false};
      let run=task.currentRunId?await this.sandboxRuns.get(task.currentRunId):null;
      let restarted=false;
      if(!(run&&taskRunScopeMatches(task,run)&&["starting","active"].includes(run.state))){
        if(task.currentRunId!==input.expectedCurrentRunId||!input.restart)return{kind:"conflict"};
        if(input.expectedCurrentRunId===null){
          if(run!==null)return{kind:"conflict"};
        }else if(!run||!taskRunScopeMatches(task,run)||run.state!=="released"){
          return{kind:"conflict"};
        }
        const restartInput:SandboxRestartIdentityInput={expectedReleasedRunId:input.expectedCurrentRunId,task:input.restart.task,sandboxRun:input.restart.sandboxRun};
        if(!sandboxRestartIdentityMatches(task,restartInput))return{kind:"conflict"};
        const receipt=requiredMessageAdmissionReceipt(input);
        const readyRun={...input.restart.sandboxRun,startupReadyAt:input.restart.reservedAt};
        const rejected=await this.admitSandboxRun(input.admission,readyRun,input.restart.reservedAt,input.idempotency,receipt.presentation,receipt.auditEvent);
        if(rejected)return rejected;
        task=normalizeStoredTask(input.restart.task);
        this.tasks.set(task.id,clone(task));
        await this.jsonDocs.put("sandbox_runtime_state",task.id,input.restart.runtimeState);
        run=readyRun;
        restarted=true;
      }
      const created=await this.createTaskMessage(message);
      this.appendInteractionChanges(task.id,[input.interactionChange]);
      const audit=canonicalMessageAuditEvent(input.auditEvent,created,task.projectId);
      if(!this.auditEvents.some((event)=>event.id===audit.id))await this.appendProjectAuditEvent(audit);
      this.completeAtomicTaskMessageMutation(input.idempotency,input.responseStatus,input.responseBody,created.updatedAt??created.createdAt);
      return{kind:"created",task:clone(task),message:created,restarted};
    });
  }

  async editTaskMessageAtomically(input:AtomicTaskMessageEditInput):Promise<AtomicTaskMessageEditResult>{
    try{return await this.atomicTaskMessageMutation([],async()=>{
      const project=this.projects.get(input.idempotency.projectId);
      if(!project||(project.lifecycleStatus??"active")!=="active")throw new AtomicTaskMessageConflict();
      const claimed=this.claimAtomicTaskMessageMutation(input.idempotency);
      if(claimed.kind!=="claimed")return claimed;
      if(claimed.resourceId!==input.messageId)throw new AtomicTaskMessageConflict();
      const task=this.tasks.get(input.taskId);
      const index=this.messages.findIndex((message)=>message.id===input.messageId&&message.taskId===input.taskId);
      const current=this.messages[index];
      if(!task||task.projectId!==input.idempotency.projectId||task.deletedAt||task.archivedAt||!current||current.deletedAt||(current.deliveryStatus??"pending")!=="pending"||(current.updatedAt??current.createdAt)!==input.expectedUpdatedAt)throw new AtomicTaskMessageConflict();
      const updated=normalizeStoredMessage({...current,content:input.content,requestHash:input.requestHash,updatedAt:input.updatedAt});
      this.messages[index]=clone(updated);
      this.appendInteractionChanges(input.taskId,[input.interactionChange]);
      if(!this.auditEvents.some((event)=>event.id===input.auditEvent.id))await this.appendProjectAuditEvent(input.auditEvent);
      this.completeAtomicTaskMessageMutation(input.idempotency,input.responseStatus,input.responseBody,input.updatedAt);
      return{kind:"updated",message:clone(updated)};
    });}catch(error){
      if(error instanceof AtomicTaskMessageConflict)return{kind:"conflict"};
      throw error;
    }
  }

  async deleteTaskMessageAtomically(input:AtomicTaskMessageDeleteInput):Promise<AtomicTaskMessageDeleteResult>{
    try{return await this.atomicTaskMessageMutation([],async()=>{
      const project=this.projects.get(input.idempotency.projectId);
      if(!project||(project.lifecycleStatus??"active")!=="active")throw new AtomicTaskMessageConflict();
      const claimed=this.claimAtomicTaskMessageMutation(input.idempotency);
      if(claimed.kind!=="claimed")return claimed;
      if(claimed.resourceId!==input.messageId)throw new AtomicTaskMessageConflict();
      const task=this.tasks.get(input.taskId);
      const index=this.messages.findIndex((message)=>message.id===input.messageId&&message.taskId===input.taskId);
      const current=this.messages[index];
      if(!task||task.projectId!==input.idempotency.projectId||task.deletedAt||task.archivedAt||!current||!["pending","failed"].includes(current.deliveryStatus??"pending"))throw new AtomicTaskMessageConflict();
      const deleted=normalizeStoredMessage(current.deletedAt?current:{...current,deletedAt:input.deletedAt,updatedAt:input.deletedAt});
      this.messages[index]=clone(deleted);
      this.interactionChanges.splice(0,this.interactionChanges.length,...this.interactionChanges.filter((change)=>!(
        change.interaction.taskId===input.taskId
        && change.sourceKind==="product"
        && change.sourceId===`message:${input.messageId}`
      )));
      if(!this.auditEvents.some((event)=>event.id===input.auditEvent.id))await this.appendProjectAuditEvent(input.auditEvent);
      this.completeAtomicTaskMessageMutation(input.idempotency,input.responseStatus,input.responseBody,input.deletedAt);
      return{kind:"deleted",message:clone(deleted)};
    });}catch(error){
      if(error instanceof AtomicTaskMessageConflict)return{kind:"conflict"};
      throw error;
    }
  }

  async updateTask(task: PersistedAgentTask): Promise<PersistedAgentTask> {
    this.tasks.set(task.id, clone(task));
    return clone(task);
  }

  async listActiveTasks(): Promise<PersistedAgentTask[]> {
    const activeRunTaskIds=new Set((await this.sandboxRuns.listActive()).map((run)=>run.taskId));
    return [...this.tasks.values()].filter((task) => !task.deletedAt&&activeRunTaskIds.has(task.id)).map(clone);
  }

  async listTasksForProject(projectId: string): Promise<PersistedAgentTask[]> {
    return [...this.tasks.values()].filter((task) => task.projectId === projectId).map(clone);
  }

  async queryTasksForProject(projectId: string, query: TaskStoreListQuery): Promise<TaskStoreListPage> {
    const needle = query.search.trim().toLowerCase();
    const filtered = [...this.tasks.values()].filter((task) =>
      task.projectId === projectId && !task.deletedAt &&
      (query.archived === "include" || (query.archived === "only" ? Boolean(task.archivedAt) : !task.archivedAt)) &&
      (!needle || `${task.title ?? ""}\n${task.prompt}`.toLowerCase().includes(needle))
    );
    const direction = query.direction === "asc" ? 1 : -1;
    const field = (task: PersistedAgentTask): string => query.sort === "created_at" ? task.createdAt
      : query.sort === "updated_at" ? task.updatedAt
      : task.title ?? "";
    filtered.sort((left, right) => direction * (compareOrdinal(field(left),field(right)) || compareOrdinal(left.id,right.id)));
    const after = query.after;
    const pageCandidates = after
      ? filtered.filter((task) => direction * (compareOrdinal(field(task),after.value) || compareOrdinal(task.id,after.taskId)) > 0)
      : filtered;
    const hasMore = pageCandidates.length > query.limit;
    return { items: pageCandidates.slice(0, query.limit).map(clone), total: filtered.length, hasMore };
  }

  async findTask(id: string): Promise<PersistedAgentTask | null> {
    return clone(this.tasks.get(id) ?? null);
  }

  async updateTaskTitle(taskId: string, title: string, updatedAt: string): Promise<PersistedAgentTask | null> {
    const current = this.tasks.get(taskId);
    if (!current || current.deletedAt) return null;
    const updated = { ...current, title, updatedAt };
    this.tasks.set(taskId, clone(updated));
    return clone(updated);
  }

  async archiveTask(taskId:string,archivedAt:string,auditEvent?:ProjectAuditEvent) {
    return this.atomicTaskMessageMutation([],async()=>{
      const current = this.tasks.get(taskId);
      if (!current || current.deletedAt) return{kind:"not_found_or_forbidden" as const};
      const project=this.projects.get(current.projectId);
      if(!project||(project.lifecycleStatus??"active")!=="active"||auditEvent!==undefined&&auditEvent.projectId!==current.projectId)return{kind:"not_found_or_forbidden" as const};
      if(!await this.taskSandboxReleased(current))return{kind:"sandbox_not_released" as const};
      const updated = { ...current, archivedAt:current.archivedAt??archivedAt, updatedAt: archivedAt };
      this.tasks.set(taskId, clone(updated));
      if(auditEvent)await this.appendProjectAuditEvent(auditEvent);
      return{kind:"ready" as const,value:clone(updated)};
    });
  }

  async beginTaskDeletion(taskId:string,deletedAt:string,auditEvent?:ProjectAuditEvent) {
    return this.atomicTaskMessageMutation([],async()=>{
      const current = this.tasks.get(taskId);
      if(!current)return{kind:"not_found_or_forbidden" as const};
      const project=this.projects.get(current.projectId);
      if(!project||(project.lifecycleStatus??"active")!=="active"||auditEvent!==undefined&&auditEvent.projectId!==current.projectId)return{kind:"not_found_or_forbidden" as const};
      if(!await this.taskSandboxReleased(current))return{kind:"sandbox_not_released" as const};
      const task={...current,deletedAt:current.deletedAt??deletedAt,updatedAt:current.deletedAt?current.updatedAt:deletedAt};
      this.tasks.set(taskId,clone(task));
      if(auditEvent)await this.appendProjectAuditEvent(auditEvent);
      return{kind:"ready" as const,value:clone(task)};
    });
  }

  async purgeDeletedTaskData(taskId:string,idempotency?:CompleteTaskIdempotencyInput):Promise<boolean>{
    return this.atomicTaskMessageMutation([],async()=>{
      const current=this.tasks.get(taskId);
      if(!current?.deletedAt||!await this.taskSandboxReleased(current))return false;
      const idempotencyKey=idempotency?taskIdempotencyKey(idempotency):null;
      const idempotencyRecord=idempotencyKey?this.taskIdempotency.get(idempotencyKey):null;
      if(idempotency&&(!idempotencyRecord||idempotencyRecord.resourceId!==taskId||idempotencyRecord.status!=="in_progress"||idempotencyRecord.requestHash!==idempotency.requestHash||idempotencyRecord.claimToken!==idempotency.claimToken))return false;
      this.artifacts.splice(0, this.artifacts.length, ...this.artifacts.filter((artifact) => artifact.taskId !== taskId));
      this.messages.splice(0, this.messages.length, ...this.messages.filter((message) => message.taskId !== taskId));
      this.interactionChanges.splice(0, this.interactionChanges.length, ...this.interactionChanges.filter((change) => change.interaction.taskId !== taskId));
      this.interactionSync.delete(taskId);
      await this.jsonDocs.delete("sandbox_runtime_state", taskId);
      this.sandboxRunRecords.deleteForTask(taskId);
      this.tasks.delete(taskId);
      if(idempotency&&idempotencyKey&&idempotencyRecord)this.taskIdempotency.set(idempotencyKey,{...idempotencyRecord,status:"completed",responseStatus:idempotency.responseStatus,responseBody:clone(idempotency.responseBody),updatedAt:idempotency.updatedAt});
      return true;
    });
  }

  async beginTaskIdempotency(input: BeginTaskIdempotencyInput): Promise<TaskIdempotencyBeginResult> {
    const key = taskIdempotencyKey(input);
    const existing = this.taskIdempotency.get(key);
    if (existing) {
      if (existing.requestHash !== input.requestHash) return { kind: "hash_mismatch" };
      if (existing.status === "completed") return { kind: "replay", resourceId: existing.resourceId, responseStatus: existing.responseStatus!, responseBody: clone(existing.responseBody) };
      if (existing.leaseExpiresAt > input.now) return { kind: "in_progress", resourceId: existing.resourceId };
      const claimed = { ...existing, claimToken: input.claimToken, leaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now };
      this.taskIdempotency.set(key, claimed);
      return { kind: "claimed", resourceId: claimed.resourceId, claimToken: claimed.claimToken };
    }
    this.taskIdempotency.set(key, { ...input, status: "in_progress", responseStatus: null, responseBody: null, updatedAt: input.now });
    return { kind: "claimed", resourceId: input.resourceId, claimToken: input.claimToken };
  }

  async beginTaskControlCommand(input:BeginTaskControlCommandInput):Promise<BeginTaskControlCommandResult>{
    return this.atomicTaskMessageMutation([],async()=>{
      const key=taskIdempotencyKey(input.idempotency);
      const existing=this.taskIdempotency.get(key);
      if(existing){
        if(existing.requestHash!==input.idempotency.requestHash)return{kind:"hash_mismatch"};
        if(existing.status==="completed")return{
          kind:"replay",
          responseStatus:existing.responseStatus!,
          responseBody:clone(existing.responseBody)
        };
        const command=inMemoryTaskControlCommand(existing);
        if(!command)return{kind:"hash_mismatch"};
        if(existing.leaseExpiresAt>input.idempotency.now)return{kind:"in_progress",command:taskControlEnvelope(command)};
        const claimed={...existing,claimToken:input.idempotency.claimToken,leaseExpiresAt:input.idempotency.leaseExpiresAt,updatedAt:input.idempotency.now};
        this.taskIdempotency.set(key,claimed);
        return{kind:"claimed",command:{...command,claimToken:claimed.claimToken}};
      }

      const task=this.tasks.get(input.taskId);
      const run=await this.sandboxRunRecords.get(input.expectedRunId);
      if(
        input.idempotency.resourceId!==input.taskId||
        !task||task.deletedAt||task.archivedAt||
        task.projectId!==input.idempotency.projectId||
        task.currentRunId!==input.expectedRunId||
        !run||run.state!=="active"||!taskRunScopeMatches(task,run)
      )return{kind:"target_conflict"};

      let downstreamTargetId=input.downstreamTargetId;
      if(input.idempotency.operation==="abort-turn"){
        if(input.interactionId!==null||!downstreamTargetId)return{kind:"target_conflict"};
      }else{
        if(!input.interactionId||downstreamTargetId!==null)return{kind:"target_conflict"};
        const change=this.interactionChanges
          .filter((candidate)=>candidate.interaction.taskId===input.taskId&&candidate.interaction.id===input.interactionId)
          .sort((left,right)=>right.interaction.revision-left.interaction.revision||right.changeSeq-left.changeSeq)[0];
        if(!change||change.interaction.kind!=="background_task")return{kind:"interaction_not_found"};
        if(change.interaction.executionStatus!=="running"||!change.interaction.canStop||!change.correlation?.workTaskId)return{kind:"target_not_stoppable"};
        downstreamTargetId=change.correlation.workTaskId;
      }
      const record:InMemoryTaskIdempotencyRecord={
        ...input.idempotency,
        status:"in_progress",
        responseStatus:null,
        responseBody:null,
        updatedAt:input.idempotency.now,
        expectedRunId:input.expectedRunId,
        interactionId:input.interactionId,
        downstreamCommandKey:input.downstreamCommandKey,
        downstreamTargetId
      };
      this.taskIdempotency.set(key,record);
      return{kind:"claimed",command:inMemoryTaskControlCommand(record)!};
    });
  }

  async listInProgressTaskControlCommands(limit:number):Promise<InProgressTaskControlCommand[]>{
    return[...this.taskIdempotency.values()]
      .filter((record)=>record.status==="in_progress"&&(record.operation==="abort-turn"||record.operation==="work-stop"))
      .sort((left,right)=>left.updatedAt.localeCompare(right.updatedAt))
      .slice(0,Math.max(1,Math.floor(limit)))
      .map(inMemoryTaskControlCommand)
      .filter((command):command is InProgressTaskControlCommand=>command!==null)
      .map(clone);
  }

  async findTaskIdempotency(input:TaskIdempotencyLookupInput):Promise<TaskIdempotencyBeginResult|null>{
    const row=this.taskIdempotency.get(taskIdempotencyKey(input));
    if(!row)return null;
    if(row.requestHash!==input.requestHash)return{kind:"hash_mismatch"};
    if(row.status==="completed")return{kind:"replay",resourceId:row.resourceId,responseStatus:row.responseStatus!,responseBody:clone(row.responseBody)};
    return{kind:"in_progress",resourceId:row.resourceId};
  }

  async findTaskIdempotencyByResource(input:TaskIdempotencyResourceLookupInput):Promise<TaskIdempotencyBeginResult|null>{
    const row=[...this.taskIdempotency.values()].find((record)=>record.actorId===input.actorId&&record.operation===input.operation&&record.key===input.key&&record.resourceId===input.resourceId);
    if(!row)return null;
    if(row.requestHash!==input.requestHash)return{kind:"hash_mismatch"};
    if(row.status==="completed")return{kind:"replay",resourceId:row.resourceId,responseStatus:row.responseStatus!,responseBody:clone(row.responseBody)};
    return{kind:"in_progress",resourceId:row.resourceId};
  }
  async findFileDeletionOperation(owner:FileDeletionOperationOwner):Promise<FileDeletionOperationState|null>{
    const row=[...this.taskIdempotency.values()].find((record)=>
      taskIdempotencyRecordOwnsFileDeletion(record,owner)
    );
    return row?.fileDeletion?clone(row.fileDeletion):null;
  }
  async persistFileDeletionOperation(owner:FileDeletionOperationOwner,state:FileDeletionOperationState):Promise<boolean>{
    const recordEntry=[...this.taskIdempotency.entries()].find(([,record])=>
      taskIdempotencyRecordOwnsFileDeletion(record,owner)
    );
    if(!recordEntry)return false;
    const [key,record]=recordEntry;
    if(!isFileDeletionOperationTransition(record.fileDeletion??null,state))return false;
    this.taskIdempotency.set(key,{...record,fileDeletion:clone(state)});
    return true;
  }
  async findInProgressTerminalStartOperation(runId:string):Promise<import("../../ports/src/store.js").InProgressTerminalStartOperation|null>{
    const row=[...this.taskIdempotency.values()].find((record)=>record.operation==="terminal-start"&&record.resourceId===runId&&record.status==="in_progress");
    return row?{actorId:row.actorId,projectId:row.projectId,operation:"terminal-start",key:row.key,requestHash:row.requestHash,resourceId:row.resourceId,claimToken:row.claimToken}:null;
  }
  async findTaskPreparationOperation(taskId:string):Promise<import("../../ports/src/store.js").TaskPreparationOperation|null>{
    const rows=[...this.taskIdempotency.values()].filter((record)=>record.operation==="create"&&record.resourceId===taskId&&record.status==="in_progress");
    if(rows.length!==1)return null;
    const row=rows[0]!;
    return{actorId:row.actorId,projectId:row.projectId,operation:"create",key:row.key,requestHash:row.requestHash,resourceId:row.resourceId,claimToken:row.claimToken};
  }

  async completeTaskIdempotency(input: CompleteTaskIdempotencyInput): Promise<boolean> {
    const key = taskIdempotencyKey(input);
    const existing = this.taskIdempotency.get(key);
    if (!existing || existing.requestHash !== input.requestHash || existing.claimToken !== input.claimToken) return false;
    if(existing.status==="completed")return existing.responseStatus===input.responseStatus&&strictStructuralEqual(existing.responseBody,input.responseBody);
    this.taskIdempotency.set(key, { ...existing, status: "completed", responseStatus: input.responseStatus, responseBody: clone(input.responseBody), updatedAt: input.updatedAt });
    return true;
  }
  async requestTaskSandboxRelease(input:TaskSandboxReleaseMutationInput){
    return this.atomicTaskMessageMutation([],async()=>{
      const key=taskIdempotencyKey(input.idempotency),record=this.taskIdempotency.get(key);
      if(!record||record.status!=="in_progress"||record.requestHash!==input.idempotency.requestHash||record.claimToken!==input.idempotency.claimToken)return"conflict" as const;
      const task=this.tasks.get(input.taskId),project=this.projects.get(input.idempotency.projectId);
      if(
        !task||task.deletedAt||task.projectId!==input.idempotency.projectId||task.currentRunId!==input.runId||
        !project||record.resourceId!==input.runId
      )return"conflict" as const;
      const controls=[...this.taskIdempotency.entries()]
        .filter(([,candidate])=>
          candidate.status==="in_progress"&&candidate.resourceId===input.taskId&&
          (candidate.operation==="abort-turn"||candidate.operation==="work-stop")
        )
        .sort(([left],[right])=>compareC(left,right));
      const terminalControls=controls.map(([controlKey,control])=>{
        const command=inMemoryTaskControlCommand(control);
        if(
          !command||command.taskId!==input.taskId||
          command.projectId!==input.idempotency.projectId
        )throw new Error("Exact Task control envelope is inconsistent with released Run");
        return command.expectedRunId===input.runId
          ?[controlKey,control,supersededTaskControlReceipt(command)] as const
          :null;
      }).filter((control):control is NonNullable<typeof control>=>control!==null);
      return this.sandboxRunRecords.requestExplicitCleanup(input,(current,requested)=>{
        if(!taskRunScopeMatches(task,current))throw new Error("Sandbox release Task scope changed");
        this.terminalizeTerminalStartOwner(requested,input.idempotency.updatedAt);
        for(const [controlKey,control,responseBody] of terminalControls){
          this.taskIdempotency.set(controlKey,{
            ...control,status:"completed",responseStatus:409,responseBody,updatedAt:input.idempotency.updatedAt
          });
        }
        if(current.state==="released"){
          this.taskIdempotency.set(key,{
            ...record,status:"completed",responseStatus:input.idempotency.responseStatus,
            responseBody:clone(input.idempotency.responseBody),updatedAt:input.idempotency.updatedAt
          });
        }
      });
    });
  }
  async completeTaskIdempotencyForResource(input:CompleteTaskIdempotencyForResourceInput):Promise<number>{let completed=0;for(const [key,record] of this.taskIdempotency){if(record.projectId!==input.projectId||record.operation!==input.operation||record.resourceId!==input.resourceId||record.status!=="in_progress")continue;this.taskIdempotency.set(key,{...record,status:"completed",responseStatus:input.responseStatus,responseBody:clone(input.responseBody),updatedAt:input.updatedAt});completed+=1;}return completed;}

  async persistTaskInteractionMutation(input: PersistTaskInteractionMutationInput): Promise<PersistTaskInteractionMutationResult> {
    const task = this.tasks.get(input.taskId);
    if (!task||task.deletedAt) throw new Error("Task not found");
    const previousChanges = this.interactionChanges.map(clone);
    const previousArtifacts = this.artifacts.map(clone);
    const previousAuditEvents = this.auditEvents.map(clone);
    const previousTasks = [...this.tasks.entries()].map(([id, value]) => [id, clone(value)] as const);
    const previousMessages = this.messages.map(clone);
    const previousUsage = [...this.usage.entries()].map(([id, value]) => [id, clone(value)] as const);
    const previousSync = clone(this.interactionSync.get(input.taskId));
    try {
      const sync = this.interactionSync.get(input.taskId) ?? { sourceCursor: null, historyStatus: "gap" as const, lastSyncedAt: null };
      if (input.sourceSync && input.sourceSync.expectedSourceCursor !== undefined && input.sourceSync.expectedSourceCursor !== sync.sourceCursor) {
        throw new Error("Task interaction source cursor conflict");
      }
      for (const projection of input.artifactProjections ?? []) {
        const artifact = projection.artifact;
        if (artifact.taskId !== input.taskId || projection.projectId !== task.projectId) throw new Error("Task interaction artifact mismatch");
        const existing = this.artifacts.find((value) => value.taskId === artifact.taskId && value.fileId === artifact.fileId);
        if (!existing) {
          if (this.artifacts.some((value) => value.id === artifact.id)) throw new Error("Task artifact already exists");
          this.artifacts.push(clone(artifact));
        }
        if (!this.auditEvents.some((event) => event.id === projection.auditEvent.id)) this.auditEvents.push(clone({...projection.auditEvent,detail:sanitizeProjectAuditDetail(projection.auditEvent.detail)}));
      }
      const inserted = this.appendInteractionChanges(input.taskId, input.changes);
      if (input.sourceSync) {
        this.interactionSync.set(input.taskId, { sourceCursor: input.sourceSync.sourceCursor, historyStatus: input.sourceSync.historyStatus, lastSyncedAt: input.sourceSync.lastSyncedAt });
      }
      const nextSeq = this.interactionChanges.filter((value) => value.interaction.taskId === input.taskId).reduce((maximum, value) => Math.max(maximum, value.changeSeq), 0);
      const storedSync = this.interactionSync.get(input.taskId) ?? sync;
      return { changes: inserted, latestChangeSeq: nextSeq, sourceCursor: storedSync.sourceCursor, historyStatus: storedSync.historyStatus, lastSyncedAt: storedSync.lastSyncedAt };
    } catch (error) {
      this.interactionChanges.splice(0, this.interactionChanges.length, ...previousChanges);
      this.artifacts.splice(0, this.artifacts.length, ...previousArtifacts);
      this.auditEvents.splice(0, this.auditEvents.length, ...previousAuditEvents);
      this.tasks.clear();
      for (const [id, value] of previousTasks) this.tasks.set(id, value);
      this.messages.splice(0, this.messages.length, ...previousMessages);
      this.usage.clear();
      for (const [id, value] of previousUsage) this.usage.set(id, value);
      if (previousSync) this.interactionSync.set(input.taskId, previousSync);
      else this.interactionSync.delete(input.taskId);
      throw error;
    }
  }

  async readTaskInteractionSnapshot(taskId: string, before: TaskInteractionPageAnchor | null, limit: number): Promise<TaskInteractionStoreSnapshot | null> {
    if (!this.tasks.has(taskId)) return null;
    const taskChanges = this.interactionChanges.filter((change) => change.interaction.taskId === taskId).map(clone);
    const taskMessages = this.messages.filter((message) => message.taskId === taskId).map(clone);
    const maximum = taskChanges.reduce((value, change) => Math.max(value, change.changeSeq), 0);
    const latest = latestInteractions(taskChanges.filter((change) => change.changeSeq <= maximum));
    const eligible = before ? latest.filter((item) => item.position < before.position || item.position === before.position && item.id < before.interactionId) : latest;
    const page = eligible.slice(Math.max(0, eligible.length - Math.max(1, limit)));
    const hasMoreBefore = eligible.length > page.length;
    const sync = this.interactionSync.get(taskId) ?? { sourceCursor: null, historyStatus: "gap" as const, lastSyncedAt: null };
    const { queuedMessages, suppressedInteractionIds } = taskInteractionMessageFacts(taskMessages, taskChanges);
    return { items: page.map(clone), queuedMessages, suppressedInteractionIds, nextPageAnchor: hasMoreBefore && page[0] ? { position: page[0].position, interactionId: page[0].id } : null, hasMoreBefore, latestChangeSeq: maximum, sourceCursor: sync.sourceCursor, historyStatus: sync.historyStatus, lastSyncedAt: sync.lastSyncedAt };
  }

  async readTaskInteractionChangePage(taskId: string, afterChangeSeq: number, limit: number): Promise<TaskInteractionChangeStorePage | null> {
    if (!this.tasks.has(taskId)) return null;
    const taskChanges = this.interactionChanges.filter((change) => change.interaction.taskId === taskId).sort((left,right) => left.changeSeq - right.changeSeq).map(clone);
    const taskMessages = this.messages.filter((message) => message.taskId === taskId).map(clone);
    const boundedChanges = taskChanges.filter((change) => change.changeSeq > afterChangeSeq).slice(0, boundedInteractionLimit(limit));
    const latestChangeSeq = taskChanges.at(-1)?.changeSeq ?? 0;
    const sync = clone(this.interactionSync.get(taskId)) ?? { sourceCursor: null, historyStatus: "gap" as const, lastSyncedAt: null };
    const { queuedMessages, suppressedInteractionIds } = taskInteractionMessageFacts(taskMessages, taskChanges);
    return {
      changes: boundedChanges,
      upperChangeSeq: boundedChanges.at(-1)?.changeSeq ?? afterChangeSeq,
      latestChangeSeq,
      queuedMessages,
      suppressedInteractionIds,
      historyStatus: sync.historyStatus,
      lastSyncedAt: sync.lastSyncedAt
    };
  }

  async listTaskInteractionChanges(taskId: string, afterChangeSeq: number, limit: number): Promise<PersistedTaskInteractionChange[]> {
    return (await this.readTaskInteractionChangePage(taskId, afterChangeSeq, limit))?.changes ?? [];
  }

  async findLatestTaskInteractionChange(taskId: string, interactionId: string): Promise<PersistedTaskInteractionChange | null> {
    return clone(this.interactionChanges.filter((change) => change.interaction.taskId === taskId && change.interaction.id === interactionId).sort((left,right) => right.interaction.revision - left.interaction.revision || right.changeSeq - left.changeSeq)[0] ?? null);
  }

  async findTaskInteractionByCorrelation(taskId: string, correlation: TaskInteractionCorrelation): Promise<TaskInteractionItem | null> {
    const match = this.interactionChanges.filter((change) => change.interaction.taskId === taskId && correlationMatches(change.correlation, correlation)).sort((left,right) => right.changeSeq - left.changeSeq)[0];
    if (!match) return null;
    return clone(latestInteractions(this.interactionChanges.filter((change) => change.interaction.taskId === taskId && change.interaction.id === match.interaction.id))[0] ?? null);
  }

  async appendTaskArtifacts(artifacts: PersistedTaskArtifact[]): Promise<void> {
    for (const artifact of artifacts) {
      const task=this.tasks.get(artifact.taskId);
      if(!task||task.deletedAt)throw new Error("Task not found");
      if (!this.artifacts.some((existing) => existing.taskId === artifact.taskId && existing.fileId === artifact.fileId)) {
        this.artifacts.push(clone(artifact));
      }
    }
  }

  async persistTaskArtifactProjection(input: PersistTaskArtifactProjectionInput): Promise<"created" | "existing"> {
    const task = this.tasks.get(input.artifact.taskId);
    if (!task || task.deletedAt || task.projectId !== input.projectId) throw new Error("Task artifact project mismatch");
    const existing = this.artifacts.find((artifact) => artifact.taskId === input.artifact.taskId && artifact.fileId === input.artifact.fileId);
    if (existing) {
      if (!this.auditEvents.some((event) => event.id === input.auditEvent.id)) this.auditEvents.push(clone({...input.auditEvent,detail:sanitizeProjectAuditDetail(input.auditEvent.detail)}));
      return "existing";
    }
    if (this.artifacts.some((artifact) => artifact.id === input.artifact.id)) throw new Error("Task artifact already exists");
    this.artifacts.push(clone(input.artifact));
    if (!this.auditEvents.some((event) => event.id === input.auditEvent.id)) this.auditEvents.push(clone({...input.auditEvent,detail:sanitizeProjectAuditDetail(input.auditEvent.detail)}));
    return "created";
  }

  async queryTaskArtifacts(taskId: string, query: TaskArtifactStoreListQuery): Promise<TaskArtifactStoreListPage> {
    const filtered = this.artifacts
      .filter((artifact) =>
        artifact.taskId === taskId &&
        (query.mediaType === null || artifact.mediaType === query.mediaType) &&
        (!query.previewOnly || artifact.previewText !== null && artifact.previewText !== undefined) &&
        (query.kind === null || taskArtifactKind(artifact) === query.kind)
      )
      .sort((left, right) => compareOrdinal(right.createdAt,left.createdAt) || compareOrdinal(right.id,left.id))
      .filter((artifact) => !query.after ||
        artifact.createdAt < query.after.createdAt ||
        artifact.createdAt === query.after.createdAt && artifact.id < query.after.artifactId
      );
    const hasMore = filtered.length > query.limit;
    return { items: filtered.slice(0, query.limit).map(clone), hasMore };
  }

  async findTaskArtifact(taskId: string, artifactId: string): Promise<PersistedTaskArtifact | null> {
    return clone(this.artifacts.find((artifact) => artifact.taskId === taskId && artifact.id === artifactId) ?? null);
  }

  async findExistingTaskArtifactFileIds(taskId: string, fileIds: string[]): Promise<string[]> {
    if (fileIds.length === 0) return [];
    const candidates = new Set(fileIds);
    return this.artifacts
      .filter((artifact) => artifact.taskId === taskId && candidates.has(artifact.fileId))
      .map((artifact) => artifact.fileId);
  }
  async createTaskMessage(v: PersistedTaskMessage): Promise<PersistedTaskMessage> {
    if (this.messages.some((value) => value.id === v.id)) throw new Error("Task message already exists");
    const stored = normalizeStoredMessage(v);
    this.messages.push(clone(stored));
    return clone(stored);
  }
  async createPendingTaskMessage(v:PersistedTaskMessage,interactionChange:TaskInteractionChangeInput):Promise<PersistedTaskMessage|null>{return this.atomicTaskMessageMutation([],async()=>{const source=this.tasks.get(v.taskId);if(!source||source.deletedAt)return null;if(!isMessageInteractionChange(v,interactionChange))throw new Error("Task message interaction identity mismatch");const created=await this.createTaskMessage(v);this.appendInteractionChanges(v.taskId,[interactionChange]);return created;});}
  async listTaskMessages(taskId: string): Promise<PersistedTaskMessage[]> { return this.messages.filter((value) => value.taskId === taskId && !value.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(clone); }
  async findTaskMessage(id: string): Promise<PersistedTaskMessage | null> { return clone(this.messages.find((value) => value.id === id) ?? null); }
  async listTaskMessagesDue(now: string, limit: number): Promise<PersistedTaskMessage[]> {
    return this.messages.filter((message) => !message.deletedAt && hasPersistedMessageInteraction(this.interactionChanges,message) && (
      (message.deliveryStatus ?? "pending") === "pending" && (!message.nextRetryAt || message.nextRetryAt <= now) ||
      message.deliveryStatus === "dispatching" && Boolean(message.leaseExpiresAt && message.leaseExpiresAt <= now) && (!message.nextRetryAt || message.nextRetryAt <= now)
    )).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(0, limit).map(clone);
  }
  async claimTaskMessage(input: TaskDeliveryClaimInput): Promise<PersistedTaskMessage | null> {
    const index = this.messages.findIndex((value) => value.id === input.id);
    const current = this.messages[index];
    const source=current?this.tasks.get(current.taskId):undefined;
    if (!current || !source || source.deletedAt || current.deletedAt || !hasPersistedMessageInteraction(this.interactionChanges,current) || (current.deliveryStatus ?? "pending") !== "pending" || current.claimToken || (current.nextRetryAt && current.nextRetryAt > input.claimedAt)||hasOlderUnresolvedMessage(this.messages,this.interactionChanges,current)) return null;
    const updated: PersistedTaskMessage = { ...current, deliveryStatus: "dispatching", claimToken: input.claimToken, claimedAt: input.claimedAt, leaseExpiresAt: input.leaseExpiresAt, attemptCount: (current.attemptCount ?? 0) + 1, safeError: null, updatedAt: input.claimedAt };
    this.messages[index] = clone(updated);
    return clone(updated);
  }
  async reclaimTaskMessage(input: TaskDeliveryReclaimInput): Promise<PersistedTaskMessage | null> {
    const index = this.messages.findIndex((value) => value.id === input.id);
    const current = this.messages[index];
    const source = current ? this.tasks.get(current.taskId) : undefined;
    if (!current || !source || source.deletedAt || current.deletedAt || !hasPersistedMessageInteraction(this.interactionChanges,current) || current.deliveryStatus !== "dispatching" || current.claimToken !== input.expectedClaimToken || !current.leaseExpiresAt || current.leaseExpiresAt > input.claimedAt || (current.nextRetryAt && current.nextRetryAt > input.claimedAt)||hasOlderUnresolvedMessage(this.messages,this.interactionChanges,current)) return null;
    const updated: PersistedTaskMessage = { ...current, claimToken: input.claimToken, claimedAt: input.claimedAt, leaseExpiresAt: input.leaseExpiresAt, attemptCount: (current.attemptCount ?? 0) + 1, safeError: null, updatedAt: input.claimedAt };
    this.messages[index] = clone(updated);
    return clone(updated);
  }
  async recordTaskMessageReceipt(input: TaskMessageReceiptInput): Promise<PersistedTaskMessage | null> {
    const index = this.messages.findIndex((value) => value.id === input.id);
    const current = this.messages[index];
    if (!current || current.deletedAt || current.deliveryStatus!=="dispatching" || current.claimToken !== input.claimToken || current.deliveryKey !== input.receipt.deliveryKey || current.requestHash !== input.receipt.requestHash || !input.receipt.accepted) return null;
    const updated: PersistedTaskMessage = { ...current, receipt: clone(input.receipt), timelineCursor: input.timelineCursor, deliveryStatus: "accepted", leaseExpiresAt: null, nextRetryAt: null, safeError: null, updatedAt: input.updatedAt };
    this.messages[index] = clone(updated);
    return clone(updated);
  }
  async deferTaskMessage(input: TaskDeliveryDeferInput): Promise<PersistedTaskMessage | null> {
    const index = this.messages.findIndex((value) => value.id === input.id);
    const current = this.messages[index];
    if (!current || current.deletedAt || current.deliveryStatus!=="dispatching" || current.claimToken !== input.claimToken) return null;
    const updated: PersistedTaskMessage = { ...current, deliveryStatus: input.releaseClaim ? "pending" : current.deliveryStatus ?? "dispatching", claimToken: input.releaseClaim ? null : current.claimToken ?? null, claimedAt: input.releaseClaim ? null : current.claimedAt ?? null, leaseExpiresAt: input.releaseClaim ? null : current.leaseExpiresAt ?? null, safeError: input.safeError, nextRetryAt: input.nextRetryAt, updatedAt: input.updatedAt };
    this.messages[index] = clone(updated);
    return clone(updated);
  }
  async failTaskMessage(input: TaskDeliveryFailureInput): Promise<PersistedTaskMessage | null> {
    const index = this.messages.findIndex((value) => value.id === input.id);
    const current = this.messages[index];
    if (!current || current.deletedAt || current.deliveryStatus !== "dispatching" || current.claimToken !== input.claimToken) return null;
    const updated: PersistedTaskMessage = { ...current, deliveryStatus: "failed", safeError: input.safeError, leaseExpiresAt: null, updatedAt: input.updatedAt };
    this.messages[index] = clone(updated);
    return clone(updated);
  }

  private appendInteractionChanges(taskId: string, changes: TaskInteractionChangeInput[]): PersistedTaskInteractionChange[] {
    const inserted: PersistedTaskInteractionChange[] = [];
    let nextSeq = this.interactionChanges.filter((value) => value.interaction.taskId === taskId).reduce((maximum, value) => Math.max(maximum, value.changeSeq), 0);
    for (const change of changes) {
      validateInteractionChange(taskId, change);
      const sourceDuplicate = this.interactionChanges.find((value) => value.interaction.taskId === taskId && value.sourceKind === change.sourceKind && value.sourceId === change.sourceId && value.sourceRevision === change.sourceRevision);
      if (sourceDuplicate) continue;
      const latestSourceRevision = this.interactionChanges.filter((value) => value.interaction.taskId === taskId && value.sourceKind === change.sourceKind && value.sourceId === change.sourceId).reduce((maximum,value) => Math.max(maximum,value.sourceRevision),-1);
      if (change.sourceKind === "product" && change.sourceRevision <= latestSourceRevision) throw new Error("Task interaction source revision is not monotonic");
      const latest = this.interactionChanges.filter((value) => value.interaction.taskId === taskId && value.interaction.id === change.interaction.id).sort((left, right) => right.interaction.revision - left.interaction.revision || right.changeSeq - left.changeSeq)[0];
      if (latest && (change.interaction.revision <= latest.interaction.revision || change.interaction.position !== latest.interaction.position)) throw new Error("Task interaction revision is not monotonic");
      nextSeq += 1;
      const stored = clone({ ...change, correlation: change.correlation ?? {}, changeSeq: nextSeq });
      this.interactionChanges.push(stored);
      inserted.push(clone(stored));
    }
    return inserted;
  }

  private async atomicTaskMessageMutation<T>(runtimeWrites: Array<{task:PersistedAgentTask}>, mutation: () => Promise<T>): Promise<T> {
    const previous=this.taskMutationTail;
    let release!:()=>void;
    this.taskMutationTail=new Promise<void>((resolve)=>{release=resolve;});
    await previous;
    try{return await this.atomicTaskMessageMutationUnlocked(runtimeWrites,mutation);}
    finally{release();}
  }

  private async atomicTaskMessageMutationUnlocked<T>(runtimeWrites: Array<{task:PersistedAgentTask}>, mutation: () => Promise<T>): Promise<T> {
    const previousChanges = this.interactionChanges.map(clone);
    const previousTasks = [...this.tasks.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousInteractionSync = [...this.interactionSync.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousMessages = this.messages.map(clone);
    const previousUsage = [...this.usage.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousLibraries = [...this.fileLibraries.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousLibraryDeletions = [...this.fileLibraryDeletions.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousIdempotency = [...this.taskIdempotency.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousAudits = this.auditEvents.map(clone);
    const documents = await Promise.all(runtimeWrites.map((write) =>
      this.jsonDocs.get("sandbox_runtime_state", write.task.id).then((document) => ["sandbox_runtime_state",write.task.id,document] as const)
    ));
    const previousRuns=this.sandboxRunRecords.snapshot();
    try {
      return await mutation();
    } catch (error) {
      this.interactionChanges.splice(0,this.interactionChanges.length,...previousChanges);
      this.tasks.clear();
      for (const [id,value] of previousTasks) this.tasks.set(id,value);
      this.interactionSync.clear();
      for (const [id,value] of previousInteractionSync) this.interactionSync.set(id,value);
      this.messages.splice(0,this.messages.length,...previousMessages);
      this.usage.clear();
      for (const [id,value] of previousUsage) this.usage.set(id,value);
      this.fileLibraries.clear();
      for (const [id,value] of previousLibraries) this.fileLibraries.set(id,value);
      this.fileLibraryDeletions.clear();
      for (const [id,value] of previousLibraryDeletions) this.fileLibraryDeletions.set(id,value);
      this.taskIdempotency.clear();
      for (const [id,value] of previousIdempotency) this.taskIdempotency.set(id,value);
      this.auditEvents.splice(0,this.auditEvents.length,...previousAudits);
      for (const [collection,id,document] of documents) {
        if (document) await this.jsonDocs.put(collection,id,document);
        else await this.jsonDocs.delete(collection,id);
      }
      this.sandboxRunRecords.restore(previousRuns);
      throw error;
    }
  }

  private initializeTaskInteractionSync(taskId: string): void { this.interactionSync.set(taskId, { sourceCursor: null, historyStatus: "complete", lastSyncedAt: null }); }

  private claimAtomicTaskMessageMutation(input:BeginTaskIdempotencyInput):
    | {kind:"claimed";resourceId:string}
    | {kind:"hash_mismatch"}
    | {kind:"in_progress"}
    | {kind:"replay";responseStatus:number;responseBody:unknown} {
    const key=taskIdempotencyKey(input);
    const existing=this.taskIdempotency.get(key);
    if(existing){
      if(existing.requestHash!==input.requestHash)return{kind:"hash_mismatch"};
      if(existing.status==="completed")return{kind:"replay",responseStatus:existing.responseStatus!,responseBody:clone(existing.responseBody)};
      if(existing.claimToken!==input.claimToken&&existing.leaseExpiresAt>input.now)return{kind:"in_progress"};
      const claimed={...existing,claimToken:input.claimToken,leaseExpiresAt:input.leaseExpiresAt,updatedAt:input.now};
      this.taskIdempotency.set(key,claimed);
      return{kind:"claimed",resourceId:claimed.resourceId};
    }
    this.taskIdempotency.set(key,{...input,status:"in_progress",responseStatus:null,responseBody:null,updatedAt:input.now});
    return{kind:"claimed",resourceId:input.resourceId};
  }

  private completeAtomicTaskMessageMutation(input:BeginTaskIdempotencyInput,responseStatus:number,responseBody:unknown,updatedAt:string):void{
    const key=taskIdempotencyKey(input);
    const record=this.taskIdempotency.get(key);
    if(!record||record.status!=="in_progress"||record.requestHash!==input.requestHash||record.claimToken!==input.claimToken)throw new AtomicTaskMessageConflict();
    this.taskIdempotency.set(key,{...record,status:"completed",responseStatus,responseBody:clone(responseBody),updatedAt});
  }

  private async admitSandboxRun(
    admission:SandboxAdmissionInput,
    run:PersistedSandboxRunState,
    updatedAt:string,
    idempotency:BeginTaskIdempotencyInput,
    presentation:import("../../contracts/src/api.js").TaskPresentation|null,
    rejectedAuditEvent:ProjectAuditEvent
  ):Promise<SandboxCapacityRejected|null>{
    const scope=normalizeSandboxAdmission(admission,run);
    const runs=this.sandboxRunRecords.snapshot();
    const activeSandboxes=runs.filter((candidate)=>candidate.projectId===run.projectId&&candidate.state!=="released").length;
    const policy=this.policies.get(run.projectId);
    if(!policy)throw new Error("Sandbox admission Project policy is unavailable");
    if(policy.sandboxLimit!==null&&activeSandboxes>=policy.sandboxLimit){
      return this.rejectSandboxAdmission(
        {kind:"project_capacity_rejected",activeSandboxes,sandboxLimit:policy.sandboxLimit},
        idempotency,presentation,rejectedAuditEvent,updatedAt
      );
    }
    const namespaceSandboxes=runs.filter((candidate)=>candidate.namespace===scope.namespace&&candidate.state!=="released").length;
    if(namespaceSandboxes>=scope.namespaceLimit){
      return this.rejectSandboxAdmission(
        {kind:"substrate_capacity_rejected"},
        idempotency,presentation,rejectedAuditEvent,updatedAt
      );
    }
    await this.sandboxRunRecords.put(run);
    this.setAuthoritativeActiveTaskUsage(run.projectId,updatedAt);
    return null;
  }

  private rejectSandboxAdmission(
    admission:SandboxAdmissionRejection,
    idempotency:BeginTaskIdempotencyInput,
    presentation:import("../../contracts/src/api.js").TaskPresentation|null,
    rejectedAuditEvent:ProjectAuditEvent,
    updatedAt:string
  ):SandboxCapacityRejected{
    validateRejectedAdmissionAudit(rejectedAuditEvent);
    const project=admission.kind==="project_capacity_rejected";
    const details=project?{activeSandboxes:admission.activeSandboxes,sandboxLimit:admission.sandboxLimit}:null;
    const responseBody=sandboxCapacityErrorEnvelope(project?"project_policy":"substrate_namespace",presentation,details);
    const detail=sanitizeProjectAuditDetail({
      ...rejectedAuditEvent.detail,
      scope:project?"project_policy":"substrate_namespace",
      ...(details??{})
    });
    this.completeAtomicTaskMessageMutation(idempotency,409,responseBody,updatedAt);
    if(!this.auditEvents.some((event)=>event.id===rejectedAuditEvent.id))this.auditEvents.push(clone({...rejectedAuditEvent,status:"rejected",detail}));
    return{kind:"capacity_rejected",admission,responseStatus:409,responseBody};
  }

  private setAuthoritativeActiveTaskUsage(projectId: string, updatedAt: string): void {
    const usage = this.usage.get(projectId);
    if(usage)this.usage.set(projectId,clone({
      ...usage,
      activeSandboxes:this.sandboxRunRecords.snapshot().filter((run)=>run.projectId===projectId&&run.state!=="released").length,
      updatedAt
    }));
  }

  private async projectHasLiveBusinessReservations(projectId:string):Promise<boolean>{
    return (await this.sandboxRuns.list()).some((run)=>run.projectId===projectId&&run.state!=="released")
      || [...this.providerSettlements.values()].some((settlement)=>settlement.projectId===projectId&&["reserved","dispatched","delivered"].includes(settlement.status));
  }

  private async taskSandboxReleased(task:PersistedAgentTask):Promise<boolean>{
    if((await this.sandboxRuns.list()).some((run)=>run.taskId===task.id&&run.state!=="released"))return false;
    if(!task.currentRunId)return true;
    const run=await this.sandboxRuns.get(task.currentRunId);
    return Boolean(run&&taskRunScopeMatches(task,run)&&run.state==="released");
  }

}

function isSuccessfulProjectDeletionCompletion(projectId:string,completion:CompleteTaskIdempotencyInput):boolean{
  return completion.projectId===projectId
    && completion.operation==="project.delete"
    && completion.responseStatus===200
    && strictStructuralEqual(completion.responseBody,{deleted:true});
}

class InMemoryJsonDocStore implements PostgresJsonDocStore {
  private readonly documents = new Map<string, Record<string, unknown>>();

  async put(collection: JsonDocumentCollection, id: string, document: Record<string, unknown>): Promise<void> {
    this.documents.set(`${collection}:${id}`, clone(document));
  }

  async get(collection: JsonDocumentCollection, id: string): Promise<Record<string, unknown> | null> {
    return clone(this.documents.get(`${collection}:${id}`) ?? null);
  }

  async delete(collection: JsonDocumentCollection, id: string): Promise<void> {
    this.documents.delete(`${collection}:${id}`);
  }

  listCollection(collection: JsonDocumentCollection): Record<string, unknown>[] {
    const prefix = `${collection}:`;
    return [...this.documents.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, document]) => clone(document));
  }

  getSync(collection:JsonDocumentCollection,id:string):Record<string,unknown>|null{return clone(this.documents.get(`${collection}:${id}`)??null)}
  putSync(collection:JsonDocumentCollection,id:string,document:Record<string,unknown>):void{this.documents.set(`${collection}:${id}`,clone(document))}
}

class InMemorySandboxRunStore {
  private readonly runs = new Map<string, PersistedSandboxRunState>();
  private mutationTail: Promise<void> = Promise.resolve();

  async put(run: PersistedSandboxRunState): Promise<PersistedSandboxRunState> {
    const current=this.runs.get(run.runId);
    if(current&&!sameRunIdentity(current,run))throw new Error("Sandbox run immutable attribution changed");
    if(current&&current.state!=="released"&&run.state==="released")throw new Error("Sandbox released transition requires atomic settlement");
    if(run.state!=="released"&&[...this.runs.values()].some((candidate)=>candidate.runId!==run.runId&&candidate.taskId===run.taskId&&candidate.state!=="released"))throw new Error("Task already has one unreleased sandbox Run");
    this.runs.set(run.runId,clone(run));
    return clone(run);
  }

  async get(runId: string): Promise<PersistedSandboxRunState | null> {
    return clone(this.runs.get(runId)??null);
  }

  async list(): Promise<PersistedSandboxRunState[]> {
    return [...this.runs.values()].map(clone);
  }

  async listActive(): Promise<PersistedSandboxRunState[]> {
    return (await this.list()).filter((run) => run.state !== "released");
  }

  async claimForCleanup(input: SandboxRunCleanupClaimInput): Promise<PersistedSandboxRunState | null> {
    return this.serializeMutation(async () => {
      const current = await this.get(input.runId);
      if (
        !current ||
        current.fencingToken !== input.expectedFencingToken ||
        !sandboxRunCleanupEligible(current, input.claimedAt)
      ) {
        return null;
      }
      return this.put({
        ...current,
        cleanupClaimedAt: input.claimedAt,
        cleanupAttempts: (current.cleanupAttempts??0)+1,
        fencingToken: current.fencingToken + 1,
        updatedAt: input.claimedAt
      });
    });
  }

  async updateWithFencing(
    runId: string,
    expectedFencingToken: number,
    run: PersistedSandboxRunState
  ): Promise<PersistedSandboxRunState | null> {
    return this.serializeMutation(async () => {
      const current = await this.get(runId);
      if (!current || current.fencingToken !== expectedFencingToken) {
        return null;
      }
      if(!sameRunIdentity(current,run))throw new Error("Sandbox run immutable attribution changed");
      if(current.state==="starting"&&run.state!=="starting")throw new Error("Starting Sandbox Run terminal transition requires atomic Task ownership");
      if(current.state!=="released"&&run.state==="released")throw new Error("Sandbox released transition requires atomic settlement");
      return this.put(run);
    });
  }

  async requestExplicitCleanup(input:TaskSandboxReleaseMutationInput,commit:(current:PersistedSandboxRunState,requested:PersistedSandboxRunState)=>void):Promise<TaskSandboxReleaseMutationResult>{
    return this.serializeMutation(async()=>{
      const current=this.runs.get(input.runId);
      if(!current||current.taskId!==input.taskId||current.runId!==input.runId)return"conflict";
      const already=current.state==="release_requested"||current.state==="released";
      if(current.fencingToken!==input.expectedFencingToken)return"conflict";
      const requested=current.state==="released"?current:{
        ...current,
        state:"release_requested" as const,
        releaseReason:current.releaseReason??(current.state==="failed"?"failed":"requested"),
        releaseRequestedAt:current.releaseRequestedAt??input.intent.requestedAt,
        ...(!current.startupActionDeadlineAt?{startupClaimToken:null,startupLeaseExpiresAt:null}:{}),
        cleanupClaimedAt:null,
        lastCleanupError:null,
        fencingToken:current.fencingToken+1,
        updatedAt:input.intent.requestedAt
      };
      commit(current,requested);
      if(current.state!=="released")this.runs.set(input.runId,clone(requested));
      return already?"already_requested":"applied";
    });
  }

  async fail(input:SandboxRunFailureInput,commit:(event:ProjectAuditEvent,failed:PersistedSandboxRunState)=>void):Promise<PersistedSandboxRunState|null>{
    return this.serializeMutation(async()=>{
      const current=this.runs.get(input.runId);
      if(!current||current.fencingToken!==input.expectedFencingToken||input.startupClaimToken!==undefined&&current.startupClaimToken!==input.startupClaimToken||!["starting","active"].includes(current.state))return null;
      const failed:PersistedSandboxRunState={...current,state:"failed",failureCode:input.code,failureCause:input.message,terminalFailure:input.terminalFailure??current.terminalFailure??null,releaseReason:"failed",failedAt:current.failedAt??input.failedAt,releaseRequestedAt:current.releaseRequestedAt??input.failedAt,startupClaimToken:null,startupLeaseExpiresAt:null,startupActionDeadlineAt:null,cleanupClaimedAt:null,fencingToken:current.fencingToken+1,updatedAt:input.failedAt};
      this.runs.set(input.runId,clone(failed));
      try{commit(input.auditEvent,failed);return clone(failed);}catch(error){this.runs.set(input.runId,clone(current));throw error;}
    });
  }

  async markStartupReady(input:import("../../ports/src/store.js").MarkTaskSandboxStartupReadyInput,readTask:()=>PersistedAgentTask|undefined):Promise<PersistedSandboxRunState|null>{
    return this.serializeMutation(async()=>{
      const run=this.runs.get(input.runId),task=readTask();
      if(!run||!task||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||task.currentRunId!==run.runId||!taskRunScopeMatches(task,run)||task.deletedAt||task.archivedAt)return null;
      if(run.startupReadyAt!==null)return clone(run);
      const ready={...run,startupReadyAt:input.readyAt,updatedAt:input.readyAt};
      this.runs.set(run.runId,clone(ready));
      return clone(ready);
    });
  }

  async initializeStartupConfig(input:import("../../ports/src/store.js").InitializeTaskSandboxStartupConfigInput,readTask:()=>PersistedAgentTask|undefined):Promise<PersistedSandboxRunState|null>{
    return this.serializeMutation(async()=>{
      const run=this.runs.get(input.runId),task=readTask();
      if(
        !run||!task||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||
        input.startupClaimToken!==undefined&&run.startupClaimToken!==input.startupClaimToken||
        task.currentRunId!==run.runId||!taskRunScopeMatches(task,run)||task.deletedAt||task.archivedAt
      )return null;
      if(run.startupConfigMapName||run.startupConfigHash){
        return run.startupConfigMapName===input.configMapName&&run.startupConfigHash===input.configHash?clone(run):null;
      }
      if(!input.configMapName||!input.configHash)return null;
      const initialized={
        ...run,
        resourceNames:{...run.resourceNames,configMap:input.configMapName},
        startupConfigMapName:input.configMapName,
        startupConfigHash:input.configHash,
        updatedAt:input.initializedAt
      };
      this.runs.set(run.runId,clone(initialized));
      return clone(initialized);
    });
  }

  async recordStartupPod(input:import("../../ports/src/store.js").RecordTaskSandboxStartupPodInput,readTask:()=>PersistedAgentTask|undefined):Promise<PersistedSandboxRunState|null>{
    return this.serializeMutation(async()=>{
      const run=this.runs.get(input.runId),task=readTask();
      if(
        !run||!task||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||
        input.startupClaimToken!==undefined&&run.startupClaimToken!==input.startupClaimToken||
        task.currentRunId!==run.runId||!taskRunScopeMatches(task,run)||task.deletedAt||task.archivedAt||
        run.startupConfigMapName!==input.expectedConfigMapName||
        run.startupConfigHash!==input.expectedConfigHash||!input.podUid
      )return null;
      if(run.resourceNames.configMap!==run.startupConfigMapName)return null;
      if(run.startupPodUid&&run.startupPodUid!==input.podUid)return null;
      if(run.startupPodIp&&run.startupPodIp!==input.podIp)return null;
      const verified={
        ...run,
        startupPodUid:input.podUid,
        startupPodIp:run.startupPodIp??input.podIp,
        updatedAt:input.observedAt
      };
      this.runs.set(run.runId,clone(verified));
      return clone(verified);
    });
  }

  async claimStartup(input:SandboxStartupOperationInput,readTask:()=>PersistedAgentTask|undefined):Promise<import("../../ports/src/store.js").SandboxStartupClaimResult>{
    return this.serializeMutation(async()=>{
      const run=this.runs.get(input.runId),task=readTask();
      if(!run||!task||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||task.currentRunId!==run.runId||!taskRunScopeMatches(task,run)||task.deletedAt||task.archivedAt)return{kind:"stale"};
      if(run.startupReadyAt===null)return{kind:"not_ready",runId:run.runId};
      if(run.startupActionDeadlineAt!==null)return{kind:"in_progress",runId:run.runId};
      if(run.startupClaimToken&&run.startupClaimToken!==input.claimToken&&run.startupLeaseExpiresAt&&run.startupLeaseExpiresAt>input.claimedAt)return{kind:"in_progress",runId:run.runId};
      this.runs.set(run.runId,clone({...run,startupClaimToken:input.claimToken,startupLeaseExpiresAt:input.leaseExpiresAt,updatedAt:input.claimedAt}));
      return{kind:"claimed",runId:run.runId,claim:input.claimToken};
    });
  }

  async beginStartupAction(input:import("../../ports/src/store.js").BeginSandboxStartupActionInput,readTask:()=>PersistedAgentTask|undefined):Promise<PersistedSandboxRunState|null>{
    return this.serializeMutation(async()=>{
      const run=this.runs.get(input.runId),task=readTask();
      if(!run||!task||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||run.startupClaimToken!==input.claimToken||run.startupActionDeadlineAt!==null||input.actionDeadlineAt<=input.startedAt||task.currentRunId!==run.runId||!taskRunScopeMatches(task,run))return null;
      const started={...run,startupActionDeadlineAt:input.actionDeadlineAt,updatedAt:input.startedAt};
      this.runs.set(run.runId,clone(started));
      return clone(started);
    });
  }

  async completeStartupAction(input:import("../../ports/src/store.js").CompleteSandboxStartupActionInput,readTask:()=>PersistedAgentTask|undefined):Promise<PersistedSandboxRunState|null>{
    return this.serializeMutation(async()=>{
      const run=this.runs.get(input.runId),task=readTask();
      if(!run||!task||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||run.startupClaimToken!==input.claimToken||run.startupActionDeadlineAt!==input.actionDeadlineAt||input.completedAt>input.actionDeadlineAt||input.leaseExpiresAt<=input.completedAt||task.currentRunId!==run.runId||!taskRunScopeMatches(task,run))return null;
      const completed={...run,startupLeaseExpiresAt:input.leaseExpiresAt,startupActionDeadlineAt:null,updatedAt:input.completedAt};
      this.runs.set(run.runId,clone(completed));
      return clone(completed);
    });
  }

  async recoverStartupAction(input:import("../../ports/src/store.js").RecoverSandboxStartupActionInput,readTask:()=>PersistedAgentTask|undefined):Promise<PersistedSandboxRunState|null>{
    return this.serializeMutation(async()=>{
      const run=this.runs.get(input.runId),task=readTask();
      if(!run||!task||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||run.startupClaimToken!==input.claimToken||run.startupActionDeadlineAt!==input.actionDeadlineAt||task.currentRunId!==run.runId||!taskRunScopeMatches(task,run))return null;
      const recovered={...run,startupClaimToken:null,startupLeaseExpiresAt:null,startupActionDeadlineAt:null,updatedAt:input.recoveredAt};
      this.runs.set(run.runId,clone(recovered));
      return clone(recovered);
    });
  }

  async drainStartupAction(input:import("../../ports/src/store.js").DrainSandboxStartupActionInput,readTask:()=>PersistedAgentTask|undefined,commit:(event:ProjectAuditEvent,drained:PersistedSandboxRunState)=>void):Promise<PersistedSandboxRunState|null>{
    return this.serializeMutation(async()=>{
      const run=this.runs.get(input.runId),task=readTask();
      if(!run||!task||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||run.startupClaimToken!==input.claimToken||run.startupActionDeadlineAt!==input.actionDeadlineAt||input.actionDeadlineAt>input.drainedAt||run.cleanupClaimedAt===null||task.currentRunId!==run.runId||!taskRunScopeMatches(task,run))return null;
      const drained={...run,state:"failed" as const,failureCode:input.failureCode,failureCause:input.failureMessage,releaseReason:"failed" as const,failedAt:run.failedAt??input.drainedAt,releaseRequestedAt:run.releaseRequestedAt??input.drainedAt,startupClaimToken:null,startupLeaseExpiresAt:null,startupActionDeadlineAt:null,cleanupClaimedAt:null,lastCleanupAt:input.drainedAt,lastCleanupError:null,fencingToken:run.fencingToken+1,updatedAt:input.drainedAt};
      this.runs.set(run.runId,clone(drained));
      try{commit(input.auditEvent,drained);return clone(drained);}catch(error){this.runs.set(run.runId,clone(run));throw error;}
    });
  }

  async activateTask(
    input:ActivateTaskSandboxRunInput,
    readTask:()=>PersistedAgentTask|undefined,
    commit:(event:ProjectAuditEvent,activatedRun:PersistedSandboxRunState)=>void
  ):Promise<ActivateTaskSandboxRunResult>{
    return this.serializeMutation(async()=>{
      const run=this.runs.get(input.runId);
      const task=readTask();
      if(!run||!task||!taskRunIdentityMatches(task,run,input))return{kind:"conflict"};
      if(run.state==="active"&&!task.deletedAt&&!task.archivedAt){
        return{kind:"already_running",task:clone(task),run:clone(run)};
      }
      if(run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||run.startupClaimToken!==input.startupClaimToken||run.startupActionDeadlineAt!==input.actionDeadlineAt||input.activatedAt>input.actionDeadlineAt||task.deletedAt||task.archivedAt||
        run.startupConfigMapName!==input.expectedConfigMapName||
        run.startupConfigHash!==input.expectedConfigHash||
        run.resourceNames.configMap!==run.startupConfigMapName||
        run.startupPodUid!==input.expectedPodUid||
        run.startupPodIp!==input.expectedPodIp){
        return{kind:"conflict"};
      }
      const activatedRun={...run,state:"active" as const,startedAt:run.startedAt??input.activatedAt,startupClaimToken:null,startupLeaseExpiresAt:null,startupActionDeadlineAt:null,fencingToken:run.fencingToken+1,updatedAt:input.activatedAt};
      this.runs.set(run.runId,clone(activatedRun));
      try{commit(input.auditEvent,activatedRun);return{kind:"activated",task:clone(task),run:clone(activatedRun)};}catch(error){this.runs.set(run.runId,clone(run));throw error}
    });
  }

  async completeRelease(input:CompleteSandboxRunReleaseInput,commit:(replay:boolean)=>void):Promise<CompleteSandboxRunReleaseResult>{
    return this.serializeMutation(async()=>{
      const current=await this.get(input.runId);
      if(!current||!sameRunIdentity(current,input.run))return"conflict";
      if(current.state==="released"){commit(true);return"already_applied";}
      if(current.startupActionDeadlineAt&&current.startupActionDeadlineAt>input.run.updatedAt)return"conflict";
      if(current.fencingToken!==input.expectedFencingToken||input.run.fencingToken!==current.fencingToken+1||input.run.state!=="released"||input.run.startupActionDeadlineAt!==null||!settlementMatchesRun(input.settlement,current,input.run))return"conflict";
      try{this.runs.set(input.runId,clone(input.run));commit(false);return"applied";}catch(error){this.runs.set(current.runId,clone(current));throw error}
    });
  }

  snapshot():PersistedSandboxRunState[]{return[...this.runs.values()].map(clone)}
  restore(runs:PersistedSandboxRunState[]):void{this.runs.clear();for(const run of runs)this.runs.set(run.runId,clone(run))}
  delete(runId:string):void{this.runs.delete(runId)}
  deleteForTask(taskId:string):void{for(const [runId,run] of this.runs)if(run.taskId===taskId)this.runs.delete(runId)}
  deleteForProject(projectId:string):void{for(const [runId,run] of this.runs)if(run.projectId===projectId)this.runs.delete(runId)}

  private async serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  }
}

function sameRunIdentity(left:PersistedSandboxRunState,right:PersistedSandboxRunState):boolean{
  return left.runId===right.runId&&left.taskId===right.taskId&&left.projectId===right.projectId&&left.workspaceId===right.workspaceId&&
    left.fileLibraryId===right.fileLibraryId&&left.startedByUserId===right.startedByUserId&&left.namespace===right.namespace&&
    left.image===right.image&&left.pvcName===right.pvcName&&left.projectSubPath===right.projectSubPath&&
    left.fileLibraryRootSubPath===right.fileLibraryRootSubPath&&left.botifiedPort===right.botifiedPort&&left.startedAt===right.startedAt&&
    left.startupConfigMapName===right.startupConfigMapName&&left.startupConfigHash===right.startupConfigHash&&
    left.startupPodUid===right.startupPodUid&&left.startupPodIp===right.startupPodIp&&
    left.createdAt===right.createdAt&&
    strictStructuralEqual(left.resourceNames,right.resourceNames)&&
    strictStructuralEqual(left.serviceKeySecretRef,right.serviceKeySecretRef)&&
    strictStructuralEqual(left.directories,right.directories)&&
    strictStructuralEqual(left.resourceLimits,right.resourceLimits)&&
    strictStructuralEqual(left.resourceSnapshot,right.resourceSnapshot)&&
    strictStructuralEqual(left.modelCa??null,right.modelCa??null);
}
function taskRunIdentityMatches(task:PersistedAgentTask,run:PersistedSandboxRunState,input:ActivateTaskSandboxRunInput):boolean{return task.id===input.taskId&&task.currentRunId===input.runId&&run.taskId===input.taskId&&run.runId===input.runId&&task.workspaceId===run.workspaceId&&task.projectId===run.projectId&&task.fileLibraryId===run.fileLibraryId}
function sameSettlement(left:SandboxUsageSettlement,right:SandboxUsageSettlement):boolean{return strictStructuralEqual(left,right)}
function settlementMatchesRun(value:SandboxUsageSettlement,current:PersistedSandboxRunState,released:PersistedSandboxRunState):boolean{const releasedAt=released.releasedAt;const duration=current.startedAt===null||!releasedAt?0:Math.max(0,(Date.parse(releasedAt)-Date.parse(current.startedAt))/1000);return Boolean(releasedAt)&&value.runId===current.runId&&value.workspaceId===current.workspaceId&&value.projectId===current.projectId&&value.taskId===current.taskId&&value.fileLibraryId===current.fileLibraryId&&value.startedByUserId===current.startedByUserId&&value.startedAt===current.startedAt&&value.releasedAt===releasedAt&&value.durationSeconds===duration&&value.releaseReason===released.releaseReason&&strictStructuralEqual(value.resources,current.resourceSnapshot)}
function taskMatchesActiveSandboxRun(task:PersistedAgentTask|undefined,project:Project|undefined,run:PersistedSandboxRunState):boolean{return Boolean(task&&project&&!task.deletedAt&&task.id===run.taskId&&task.currentRunId===run.runId&&task.projectId===run.projectId&&task.workspaceId===run.workspaceId&&task.fileLibraryId===run.fileLibraryId&&project.id===run.projectId&&project.workspaceId===run.workspaceId)}

function sandboxRunCleanupEligible(run: PersistedSandboxRunState, claimedAt: string): boolean {
  const startupActionExpired=run.startupActionDeadlineAt!==null&&run.startupActionDeadlineAt<=claimedAt;
  return (run.state === "release_requested" || run.state === "failed" || run.state==="starting"&&run.startupActionDeadlineAt!==null&&run.startupActionDeadlineAt<=claimedAt)
    && (startupActionExpired||!run.startupLeaseExpiresAt||run.startupLeaseExpiresAt<=claimedAt)
    && (!run.startupActionDeadlineAt||run.startupActionDeadlineAt<=claimedAt)
    && (!run.cleanupClaimedAt||Date.parse(run.cleanupClaimedAt)<=Date.parse(claimedAt)-120_000);
}

class InMemoryLeaseStore implements PostgresLeaseStore {
  private readonly leases = new Map<string, LeaseRecord>();

  async acquire(input: AcquireLeaseInput): Promise<AcquireLeaseResult> {
    const existing = this.leases.get(input.name);
    if (existing && Date.parse(existing.expiresAt) > input.now.getTime()) {
      return { acquired: false, lease: clone(existing) };
    }
    const nextToken = (existing?.fencingToken ?? 0) + 1;
    const lease: LeaseRecord = {
      name: input.name,
      holder: input.holder,
      fencingToken: nextToken,
      expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString(),
      metadata: clone(input.metadata ?? {})
    };
    this.leases.set(input.name, lease);
    return { acquired: true, lease: clone(lease) };
  }

  async renew(name: string, fencingToken: number, ttlMs: number, now: Date): Promise<boolean> {
    const lease = this.leases.get(name);
    if (!lease || lease.fencingToken !== fencingToken) {
      return false;
    }
    lease.expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    return true;
  }

  async compareAndSet(name: string, fencingToken: number, metadata: Record<string, unknown>): Promise<boolean> {
    const lease = this.leases.get(name);
    if (!lease || lease.fencingToken !== fencingToken) {
      return false;
    }
    lease.metadata = clone(metadata);
    return true;
  }

  async release(name: string, fencingToken: number): Promise<boolean> {
    const lease = this.leases.get(name);
    if (!lease || lease.fencingToken !== fencingToken) {
      return false;
    }
    this.leases.delete(name);
    return true;
  }

  async expire(now: Date): Promise<number> {
    const expired = await this.listExpired(now);
    for (const lease of expired) {
      this.leases.delete(lease.name);
    }
    return expired.length;
  }

  async listExpired(now: Date): Promise<LeaseRecord[]> {
    return [...this.leases.values()]
      .filter((lease) => Date.parse(lease.expiresAt) <= now.getTime())
      .map(clone);
  }
}

function publicUser(user: StoredUser): User {
  const { passwordHash: _passwordHash, ...rest } = user;
  return clone(rest);
}

function publicCredential(value: StoredProjectCredential): ProjectCredential {
  const { keyId: _keyId, nonce: _nonce, ciphertext: _ciphertext, authTag: _authTag, ...rest } = value;
  return clone(rest);
}

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : structuredClone(value);
}

function snapshotMap<K,V>(values:Map<K,V>):Array<readonly [K,V]>{return[...values].map(([key,value])=>[key,clone(value)] as const)}
function restoreMap<K,V>(target:Map<K,V>,values:Array<readonly [K,V]>):void{target.clear();for(const [key,value] of values)target.set(key,clone(value))}
function restoreArray<T>(target:T[],values:T[]):void{target.splice(0,target.length,...values.map(clone))}

function normalizeStoredTask(task: PersistedAgentTask): PersistedAgentTask {
  return {
    ...clone(task),
    title: task.title ?? task.prompt.replace(/[\r\n]+/g, " ").slice(0, 160),
    currentRunId: task.currentRunId ?? null,
    archivedAt: task.archivedAt ?? null,
    deletedAt: task.deletedAt ?? null
  };
}

function validateTaskRunReservation(input:AtomicTaskCreateInput):void{
  const expectedRunId=input.sandboxRun?.runId??null;
  const reservesActive=input.sandboxRun!==undefined&&input.sandboxRun.state!=="released";
  if(input.task.currentRunId!==expectedRunId||input.reserveActive!==reservesActive||(input.sandboxRun!==undefined&&!taskRunScopeMatches(input.task,input.sandboxRun)))throw new Error("Task Run reservation is inconsistent");
}

function requiredAdmissionCreateIdempotency(input:AtomicTaskCreateInput):BeginTaskIdempotencyInput{
  if(!input.idempotency||input.rejectionPresentation!==null||!input.rejectedAuditEvent)throw new Error("Sandbox creation requires admission idempotency and rejection receipt inputs");
  return input.idempotency;
}

function requiredSandboxRestartAdmission(input:AtomicTaskSandboxRestartInput):{idempotency:BeginTaskIdempotencyInput;presentation:TaskPresentation;auditEvent:ProjectAuditEvent}{
  if(!input.idempotency||!input.rejectionPresentation||!input.rejectedAuditEvent)throw new Error("Sandbox restart requires admission idempotency and rejection receipt inputs");
  return{idempotency:input.idempotency,presentation:input.rejectionPresentation,auditEvent:input.rejectedAuditEvent};
}

function requiredMessageAdmissionReceipt(input:AtomicTaskMessageInput):{presentation:TaskPresentation;auditEvent:ProjectAuditEvent}{
  if(!input.rejectionPresentation||!input.rejectedAuditEvent)throw new Error("Sandbox message restart requires rejection receipt inputs");
  return{presentation:input.rejectionPresentation,auditEvent:input.rejectedAuditEvent};
}

function terminalBoundRunReceipt(run:PersistedSandboxRunState,presentation:TaskPresentation|null):{responseStatus:number;responseBody:unknown}{
  if(run.state==="active")return{responseStatus:200,responseBody:terminalActivatedReceipt(run.runId)};
  return{responseStatus:502,responseBody:{
    outcome:"completed",keyDisposition:"retire",runId:run.runId,
    error:{code:"sandbox_start_failed",message:"Sandbox could not be started",retryable:true,details:null,presentation}
  }};
}

function terminalActivatedReceipt(runId:string):unknown{
  return{outcome:"completed",keyDisposition:"retire",runId};
}

function terminalStartTaskConflictReceipt():{responseStatus:number;responseBody:unknown}{
  return{
    responseStatus:409,
    responseBody:{
      outcome:"rejected_before_acceptance",keyDisposition:"retire",
      error:"Terminal start is already in progress for this Task",
      code:"terminal_start_already_in_progress"
    }
  };
}

function normalizeSandboxAdmission(admission:SandboxAdmissionInput,run:PersistedSandboxRunState):SandboxAdmissionInput{
  if(admission.namespace!==run.namespace)throw new Error("Sandbox admission namespace does not match Run");
  if(!Number.isSafeInteger(admission.namespaceLimit)||admission.namespaceLimit<=0)throw new Error("Sandbox admission namespace limit must be a positive integer");
  return admission;
}

function validateRejectedAdmissionAudit(event:ProjectAuditEvent):void{
  const trigger=event.detail?.trigger;
  const expectedAction=trigger==="task_create"?"task.create":"sandbox.started";
  if(event.status!=="rejected"||event.action!==expectedAction||!["task_create","task_message","terminal"].includes(trigger??""))throw new Error("Sandbox admission rejected Audit is inconsistent");
}

type SandboxRestartIdentityInput = Pick<AtomicTaskSandboxRestartInput,"expectedReleasedRunId"|"task"|"sandboxRun">;

function sandboxRestartIdentityMatches(current:PersistedAgentTask,input:SandboxRestartIdentityInput):boolean{
  const task=input.task,run=input.sandboxRun;
  return task.id===current.id&&task.workspaceId===current.workspaceId&&task.projectId===current.projectId&&task.endpointId===current.endpointId&&task.fileLibraryId===current.fileLibraryId&&task.currentRunId!==input.expectedReleasedRunId&&run.runId===task.currentRunId&&run.taskId===current.id&&run.workspaceId===current.workspaceId&&run.projectId===current.projectId&&run.fileLibraryId===current.fileLibraryId&&run.state==="starting";
}

function taskRunScopeMatches(task:PersistedAgentTask,run:PersistedSandboxRunState):boolean{
  return task.id===run.taskId&&task.workspaceId===run.workspaceId&&task.projectId===run.projectId&&task.fileLibraryId===run.fileLibraryId;
}

function normalizeStoredMessage(message: PersistedTaskMessage): PersistedTaskMessage {
  return {
    ...clone(message),
    deliveryKey: message.deliveryKey ?? null,
    requestHash: message.requestHash ?? null,
    claimToken: message.claimToken ?? null,
    receipt: message.receipt ?? null,
    timelineCursor: message.timelineCursor ?? null,
    deliveryStatus: message.deliveryStatus ?? "pending",
    claimedAt: message.claimedAt ?? null,
    leaseExpiresAt: message.leaseExpiresAt ?? null,
    attemptCount: message.attemptCount ?? 0,
    nextRetryAt: message.nextRetryAt ?? null,
    safeError: message.safeError ?? null,
    updatedAt: message.updatedAt ?? message.createdAt,
    deletedAt: message.deletedAt ?? null
  };
}

function validateInteractionChange(taskId: string, change: PersistTaskInteractionMutationInput["changes"][number]): void {
  if (change.interaction.taskId !== taskId || change.interaction.id.length === 0 || change.sourceId.length === 0) throw new Error("Task interaction identity mismatch");
  if (change.sourceKind === "botified" && change.sourceRevision !== 0) throw new Error("Botified interaction revisions are cursor-based");
  if (!Number.isSafeInteger(change.sourceRevision) || change.sourceRevision < 0 || !Number.isSafeInteger(change.interaction.revision) || change.interaction.revision < 1 || !Number.isSafeInteger(change.interaction.position) || change.interaction.position < 0) {
    throw new Error("Task interaction sequence is invalid");
  }
}

function latestInteractions(changes: PersistedTaskInteractionChange[]): TaskInteractionItem[] {
  const latest = new Map<string, PersistedTaskInteractionChange>();
  for (const change of changes) {
    const current = latest.get(change.interaction.id);
    if (!current || change.interaction.revision > current.interaction.revision || change.interaction.revision === current.interaction.revision && change.changeSeq > current.changeSeq) latest.set(change.interaction.id, change);
  }
  return [...latest.values()].map((change) => change.interaction).sort((left,right) => left.position - right.position || left.id.localeCompare(right.id));
}

function taskInteractionMessageFacts(
  messages: PersistedTaskMessage[],
  changes: PersistedTaskInteractionChange[]
): { queuedMessages: PersistedTaskMessage[]; suppressedInteractionIds: string[] } {
  const unresolved = new Set(["pending", "dispatching", "failed"]);
  const queuedMessages = messages
    .filter((message) => !message.deletedAt && unresolved.has(message.deliveryStatus ?? "pending"))
    .sort((left,right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map(clone);
  const suppressedMessageIds = new Set(
    messages
      .filter((message) => Boolean(message.deletedAt) || unresolved.has(message.deliveryStatus ?? "pending"))
      .map((message) => message.id)
  );
  const suppressedInteractionIds = [...new Set(
    changes
      .filter((change) =>
        change.sourceKind === "product" &&
        change.sourceId.startsWith("message:") &&
        !change.sourceId.endsWith(":boundary") &&
        suppressedMessageIds.has(change.sourceId.slice("message:".length))
      )
      .map((change) => change.interaction.id)
  )];
  return { queuedMessages, suppressedInteractionIds };
}

function boundedInteractionLimit(limit: number): number {
  return Math.max(1, Math.floor(limit));
}

function hasOlderUnresolvedMessage(messages:PersistedTaskMessage[],changes:PersistedTaskInteractionChange[],target:PersistedTaskMessage):boolean{
  return messages.some((message)=>message.taskId===target.taskId&&!message.deletedAt&&hasPersistedMessageInteraction(changes,message)&&["pending","dispatching"].includes(message.deliveryStatus??"pending")&&(message.createdAt<target.createdAt||message.createdAt===target.createdAt&&message.id<target.id));
}

function hasPersistedMessageInteraction(changes:PersistedTaskInteractionChange[],message:PersistedTaskMessage):boolean{
  return changes.some((change)=>change.interaction.taskId===message.taskId&&change.sourceKind==="product"&&change.sourceId===`message:${message.id}`);
}

function isMessageInteractionChange(message:PersistedTaskMessage,change:TaskInteractionChangeInput):boolean{
  return change.sourceKind==="product"&&change.sourceId===`message:${message.id}`&&change.interaction.taskId===message.taskId;
}

function correlationMatches(stored: TaskInteractionCorrelation | undefined, requested: TaskInteractionCorrelation): boolean {
  if (requested.toolCallId && stored?.toolCallId === requested.toolCallId) return true;
  if (requested.workTaskId && stored?.workTaskId === requested.workTaskId) return true;
  return Boolean(requested.callbackId && stored?.callbackId === requested.callbackId);
}

class AtomicTaskMessageConflict extends Error {}

interface InMemoryTaskIdempotencyRecord {
  actorId: string;
  projectId: string;
  operation: import("../../ports/src/store.js").TaskIdempotencyOperation;
  key: string;
  requestHash: string;
  resourceId: string;
  claimToken: string;
  leaseExpiresAt: string;
  status: "in_progress" | "completed";
  responseStatus: number | null;
  responseBody: unknown;
  now: string;
  updatedAt: string;
  fileDeletion?: FileDeletionOperationState;
  expectedRunId?:string|null;
  interactionId?:string|null;
  downstreamCommandKey?:string|null;
  downstreamTargetId?:string|null;
}

function inMemoryTaskControlCommand(record:InMemoryTaskIdempotencyRecord):InProgressTaskControlCommand|null{
  if(
    (record.operation!=="abort-turn"&&record.operation!=="work-stop")||
    !record.expectedRunId||!record.downstreamCommandKey||!record.downstreamTargetId||
    (record.operation==="abort-turn"&&record.interactionId!==null)||
    (record.operation==="work-stop"&&!record.interactionId)
  )return null;
  return{
    actorId:record.actorId,
    projectId:record.projectId,
    operation:record.operation,
    key:record.key,
    requestHash:record.requestHash,
    resourceId:record.resourceId,
    claimToken:record.claimToken,
    taskId:record.resourceId,
    expectedRunId:record.expectedRunId,
    interactionId:record.interactionId??null,
    downstreamCommandKey:record.downstreamCommandKey,
    downstreamTargetId:record.downstreamTargetId
  };
}

function taskControlEnvelope(command:InProgressTaskControlCommand){
  return{
    taskId:command.taskId,
    expectedRunId:command.expectedRunId,
    interactionId:command.interactionId,
    downstreamCommandKey:command.downstreamCommandKey,
    downstreamTargetId:command.downstreamTargetId
  };
}

function supersededTaskControlReceipt(command:InProgressTaskControlCommand){
  return{
    outcome:"completed",
    keyDisposition:"retire",
    taskId:command.taskId,
    runId:command.expectedRunId,
    ...(command.operation==="abort-turn"
      ?{turnId:command.downstreamTargetId}
      :{interactionId:command.interactionId!}),
    result:"conflict",
    code:"task_control_superseded_by_release"
  };
}

interface InMemoryFileLibraryDeletion {
  operationId: string;
  state: FileDeletionOperationState | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
}

function fileLibraryDeletionOperationId(libraryId:string):string{
  return `file-library-delete:${libraryId}`;
}

function fileLibraryDeletionClaimMatches(
  operation:InMemoryFileLibraryDeletion|undefined,
  owner:FileLibraryDeletionOperationOwner
):operation is InMemoryFileLibraryDeletion{
  return Boolean(operation&&
    operation.operationId===owner.operationId&&
    operation.claimToken===owner.claimToken
  );
}

function taskIdempotencyRecordOwnsFileDeletion(
  record: InMemoryTaskIdempotencyRecord,
  owner: FileDeletionOperationOwner
): boolean {
  return record.actorId === owner.actorId &&
    record.projectId === owner.projectId &&
    record.operation === owner.operation &&
    record.key === owner.key &&
    record.requestHash === owner.requestHash &&
    record.resourceId === owner.resourceId &&
    record.claimToken === owner.claimToken &&
    record.status === "in_progress";
}

function canonicalTaskMessage(message:PersistedTaskMessage,resourceId:string):PersistedTaskMessage {
  return {
    ...message,
    id:resourceId,
    deliveryKey:`delivery_message_${resourceId}`
  };
}

function canonicalMessageAuditEvent(event:ProjectAuditEvent,message:PersistedTaskMessage,projectId:string):ProjectAuditEvent {
  return {
    ...event,
    id:`audit_task_message_create_${message.id}`,
    projectId,
    action:"task.message.create",
    status:"accepted",
    resourceKind:"task",
    resourceId:message.taskId,
    detail:{
      ...event.detail,
      taskId:message.taskId,
      messageId:message.id,
      ...(message.deliveryStatus === undefined ? {} : {deliveryStatus:message.deliveryStatus})
    }
  };
}

function taskIdempotencyKey(input: Pick<BeginTaskIdempotencyInput, "actorId" | "projectId" | "operation" | "key">): string {
  return `${input.actorId}\0${input.projectId}\0${input.operation}\0${input.key}`;
}

function exceedsLimit(policy: ProjectResourcePolicy, usage: ProjectResourceUsage, input: ProjectResourceUsageAdjustment): boolean {
  const key = input.limit === "sandbox_capacity" ? "activeSandboxes" : input.limit === "provider_requests_limit" ? "providerRequests" : input.limit === "provider_tokens_limit" ? "providerTokens" : input.limit === "provider_cost_limit" ? "providerCost" : "projectFileBytes";
  const maximum = input.limit === "sandbox_capacity" ? policy.sandboxLimit : policy[`${key}Limit` as keyof ProjectResourcePolicy];
  return input.delta[key] > 0 && typeof maximum === "number" && usage[key] + input.delta[key] > maximum;
}

function providerReservationExceedsPolicy(policy: ProjectResourcePolicy, usage: ProjectResourceUsage, input: ReserveProjectProviderSettlementInput): boolean {
  return (policy.providerRequestsLimit !== null && usage.providerRequests + 1 > policy.providerRequestsLimit)
    || (policy.providerTokensLimit !== null && usage.providerTokens + input.reservedTokens > policy.providerTokensLimit)
    || (policy.providerCostLimit !== null && usage.providerCost + input.reservedCost > policy.providerCostLimit);
}

function providerWindowValue(settlement:ProjectProviderSettlement,metric:import("../../contracts/src/api.js").EndpointPolicyMetric):number {
  if(metric==="providerRequests")return 1;
  if(settlement.status==="settled")return metric==="providerTokens"?settlement.usage?.tokens??0:settlement.usage?.cost??0;
  return metric==="providerTokens"?settlement.reservedTokens:settlement.reservedCost;
}

function taskArtifactKind(artifact: PersistedTaskArtifact): import("../../contracts/src/api.js").TaskArtifactKind {
  return classifyPreviewMediaType(artifact.mediaType) ?? "file";
}

function compareOrdinal(left:string,right:string):number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function compareC(left:string,right:string):number{return Buffer.compare(Buffer.from(left,"utf8"),Buffer.from(right,"utf8"))}
function compareProjectDirectoryItems(left:ProjectDirectoryItem,right:ProjectDirectoryItem):number {
  return Number(left.pinnedAt === null) - Number(right.pinnedAt === null)
    || compareC(left.name, right.name)
    || compareC(left.id, right.id);
}
function compareProjectDirectoryItemToCursor(item:ProjectDirectoryItem,cursor:{pinned:boolean;name:string;id:string}):number {
  return Number(item.pinnedAt === null) - Number(!cursor.pinned)
    || compareC(item.name, cursor.name)
    || compareC(item.id, cursor.id);
}
function membershipMatchesQuery(member:{userId:string;displayName:string|null;email:string},query:string):boolean{return query===""||member.userId.toLowerCase().includes(query)||member.email.toLowerCase().includes(query)||(member.displayName?.toLowerCase().includes(query)??false)}
function compareMembershipDirectoryItems(left:{createdAt:string;userId:string},right:{createdAt:string;userId:string}):number{return compareOrdinal(left.createdAt,right.createdAt)||compareC(left.userId,right.userId)}
function compareMembershipToCursor(item:{createdAt:string;userId:string},cursor:{createdAt:string;userId:string}):number{return compareOrdinal(item.createdAt,cursor.createdAt)||compareC(item.userId,cursor.userId)}
function providerDirectoryMatch(values:string[],query:string):boolean{return query===""||values.some((value)=>value.toLowerCase().includes(query))}
function compareCreatedDirectoryDesc(left:{createdAt:string;id:string},right:{createdAt:string;id:string}):number{return compareOrdinal(right.createdAt,left.createdAt)||compareC(right.id,left.id)}
function compareCreatedDirectoryToCursor(item:{createdAt:string;id:string},cursor:{createdAt:string;id:string}):number{return compareOrdinal(cursor.createdAt,item.createdAt)||compareC(cursor.id,item.id)}
function taskReadyEndpoint(endpoint:ModelEndpoint):boolean{return endpoint.credentialId.length>0&&endpoint.health?.status==="healthy"&&endpoint.capabilities.includes("text")&&endpoint.capabilities.includes("tool_calls")}

function failureEventMatches(type:ProjectAlertType,event:ProjectAuditEvent):boolean {
  if(type==="provider_failure")return event.action==="provider.request"&&event.status==="rejected"&&event.resourceKind==="provider"&&event.detail?.errorCategory!==undefined;
  if(type==="endpoint_failure")return event.resourceKind==="endpoint"&&event.status==="rejected"&&event.detail?.healthStatus==="unavailable";
  if(type==="sandbox_failure")return event.action==="sandbox.failed"&&event.status==="accepted";
  return false;
}
function isProviderLimitAlert(type:ProjectAlertType):boolean{return type==="provider_requests_limit"||type==="provider_tokens_limit"||type==="provider_cost_limit"}

function membershipKey(projectId: string, userId: string): string {
  return `${projectId}\0${userId}`;
}

function workspaceMembershipKey(workspaceId: string, userId: string): string { return `${workspaceId}\0${userId}`; }
