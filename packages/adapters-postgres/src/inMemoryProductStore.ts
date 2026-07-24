import type {
  TaskInteractionItem,
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
  UserProfilePreferences, ProjectCredential, StoredProjectCredential, ProjectContextEntry, UserNotification, ProjectAlertRule, ProjectAlertType, WorkspaceMembership, WorkspaceMembershipView, WorkspaceListProjection
} from "../../contracts/src/api.js";
import { classifyPreviewMediaType, isActiveProjectAlert, sanitizeProjectAuditDetail } from "../../contracts/src/api.js";
import { CredentialVersionConflictError, EndpointNameConflictError } from "../../ports/src/store.js";
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
  AtomicTaskSandboxRestartInput,
  AtomicTaskSandboxRestartResult,
  AtomicTaskMessageInput,
  AtomicTaskMessageResult,
  AtomicTaskMessageEditInput,
  AtomicTaskMessageEditResult,
  AtomicTaskMessageDeleteInput,
  AtomicTaskMessageDeleteResult,
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
  TaskIdempotencyBeginResult,
  CompleteTaskIdempotencyInput,
  CompleteTaskIdempotencyForResourceInput,
  TaskIdempotencyResourceLookupInput,
  TaskSandboxReleaseMutationInput,
  TaskSandboxReleaseMutationResult,
  ConfirmSandboxRunStartedInput,
  ConfirmSandboxRunStartedResult,
  ActivateTaskSandboxRunInput,
  ActivateTaskSandboxRunResult,
  CompleteSandboxRunReleaseInput,
  CompleteSandboxRunReleaseResult,
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
  readonly sandboxRuns = new InMemorySandboxRunStore();

  private readonly users = new Map<string, StoredUser>();
  private readonly sessions = new Map<string, AuthSession>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly projects = new Map<string, Project>();
  private readonly fileLibraries = new Map<string, FileLibrary>();
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

  async listWorkspacesForUser(userId: string): Promise<WorkspaceListProjection[]> {
    return [...this.workspaces.values()]
      .flatMap((workspace) => {
        const membership = this.workspaceMemberships.get(workspaceMembershipKey(workspace.id, userId));
        const owner = this.users.get(workspace.ownerUserId);
        if (!membership || !owner) return [];
        return [{ ...clone(workspace), owner: { displayName: this.profiles.get(owner.id)?.displayName ?? null, email: owner.email }, memberRole: membership.role }];
      });
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
  async listWorkspaceMemberships(workspaceId:string):Promise<WorkspaceMembershipView[]>{return [...this.workspaceMemberships.values()].filter((member)=>member.workspaceId===workspaceId).map((member)=>this.workspaceMembershipView(member))}
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
      activeTasksLimit: project.taskConcurrencyLimit,
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
      activeTasks: 0,
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

  async listProjectPinsForUser(userId: string) { return [...this.projectPins.values()].filter((pin) => pin.userId === userId).map((pin) => clone({ projectId:pin.projectId,pinnedAt:pin.pinnedAt })); }
  async setProjectPin(userId:string,projectId:string,pinnedAt:string|null){const key=membershipKey(projectId,userId);if(!this.memberships.has(key))return false;if(pinnedAt)this.projectPins.set(key,{projectId,userId,pinnedAt});else this.projectPins.delete(key);return true}

  async findProject(id: string): Promise<Project | null> {
    return clone(this.projects.get(id) ?? null);
  }
  async createFileLibrary(value:FileLibrary){
    const duplicate=[...this.fileLibraries.values()].some((item)=>item.projectId===value.projectId&&(item.name.trim().toLowerCase()===value.name.trim().toLowerCase()||item.rootSubPath===value.rootSubPath));
    if(duplicate||this.fileLibraries.has(value.id))return null;
    this.fileLibraries.set(value.id,clone(value));
    return clone(value);
  }
  async findFileLibrary(id:string){return clone(this.fileLibraries.get(id)??null)}
  async listFileLibrariesForProject(projectId:string){return [...this.fileLibraries.values()].filter((item)=>item.projectId===projectId).sort((left,right)=>left.createdAt.localeCompare(right.createdAt)||left.id.localeCompare(right.id)).map(clone)}
  async renameFileLibrary(projectId:string,id:string,name:string,expectedUpdatedAt:string,updatedAt:string){
    const current=this.fileLibraries.get(id);
    if(!current||current.projectId!==projectId||current.updatedAt!==expectedUpdatedAt||[...this.fileLibraries.values()].some((item)=>item.id!==id&&item.projectId===projectId&&item.name.trim().toLowerCase()===name.trim().toLowerCase()))return null;
    const updated={...current,name,updatedAt};this.fileLibraries.set(id,clone(updated));return clone(updated);
  }
  async deleteFileLibraryIfUnbound(projectId:string,id:string){
    const current=this.fileLibraries.get(id);
    if(!current||current.projectId!==projectId)return"not_found" as const;
    if([...this.tasks.values()].some((task)=>task.fileLibraryId===id))return"bound" as const;
    this.fileLibraries.delete(id);return"deleted" as const;
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
      alertRules:snapshotMap(this.alertRules),messages:this.messages.map(clone),sandboxRuns:this.sandboxRuns.snapshot()
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
      this.sandboxRuns.deleteForProject(id);
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
      this.sandboxRuns.restore(previous.sandboxRuns);
      for(const [collection,documentId,document] of documents)if(document)await this.jsonDocs.put(collection,documentId,document);
      throw error;
    }
    });
  }

  async listProjectsForUser(userId: string): Promise<Project[]> {
    return [...this.projects.values()]
      .filter((project) => this.memberships.has(membershipKey(project.id, userId)))
      .map(clone);
  }

  async findProjectMembership(projectId: string, userId: string): Promise<ProjectMembership | null> {
    return clone(this.memberships.get(membershipKey(projectId, userId)) ?? null);
  }

  async listProjectMemberships(projectId: string): Promise<ProjectMembershipView[]> {
    return [...this.memberships.values()].filter((membership) => membership.projectId === projectId).map((membership) => this.projectMembershipView(membership));
  }

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
  async patchProjectResourcePolicy(projectId: string, input: UpdateProjectResourcePolicyInput, updatedAt: string, expectedUpdatedAt?: string): Promise<ProjectResourcePolicy | null> {
    const policy = this.policies.get(projectId);
    if (!policy || (expectedUpdatedAt !== undefined && policy.updatedAt !== expectedUpdatedAt)) return null;
    const updated = { ...policy, ...input, updatedAt };
    this.policies.set(projectId, clone(updated));
    if (input.activeTasksLimit !== undefined && input.activeTasksLimit !== null) {
      const project = this.projects.get(projectId);
      if (project) this.projects.set(projectId, clone({ ...project, taskConcurrencyLimit: input.activeTasksLimit, updatedAt }));
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
    const policy = this.policies.get(input.projectId);
    const usage = this.usage.get(input.projectId);
    if (!policy || !usage || (input.limit && exceedsLimit(policy, usage, input))) return null;
    const next = {
      ...usage,
      activeTasks: Math.max(0, usage.activeTasks + input.delta.activeTasks),
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
    const endpoints=[...this.endpoints.values()].filter((endpoint)=>endpoint.projectId===input.projectId).sort((left,right)=>left.createdAt.localeCompare(right.createdAt)||compareOrdinal(left.id,right.id)).map(clone);
    if(input.selectedEndpointId!==null&&!endpoints.some((endpoint)=>endpoint.id===input.selectedEndpointId))return{kind:"endpoint_not_found"};
    const providerSettlements=[...this.providerSettlements.values()].filter((value)=>value.projectId===input.projectId).map(clone);
    const sandboxRuns=this.sandboxRuns.snapshot().filter((run)=>run.projectId===input.projectId&&run.startedByUserId===input.selectedUserId);
    const tasks=new Map([...this.tasks.values()].filter((task)=>task.projectId===input.projectId).map((task)=>[task.id,clone(task)] as const));
    const sandboxSettlements=[...this.sandboxUsageSettlements.values()].filter((value)=>value.projectId===input.projectId&&value.startedByUserId===input.selectedUserId).map(clone);
    const settled=providerSettlements.filter((value)=>value.actorId===input.userId&&value.status==="settled"&&value.settledAt!==null&&value.settledAt>=input.periodStart&&value.settledAt<input.periodEnd);
    const selected=settled.filter((value)=>input.selectedEndpointId===null||value.endpointId===input.selectedEndpointId);
    const byDay=new Map<string,{requests:number;tokens:number;cost:number}>();
    for(const value of selected){const date=value.settledAt!.slice(0,10),current=byDay.get(date)??{requests:0,tokens:0,cost:0};current.requests+=1;current.tokens+=value.usage?.tokens??0;current.cost+=value.usage?.cost??0;byDay.set(date,current)}
    const daily=[...byDay].sort(([left],[right])=>left.localeCompare(right)).map(([date,total])=>({date,...total}));
    const totals=selected.reduce((total,value)=>({requests:total.requests+1,tokens:total.tokens+(value.usage?.tokens??0),cost:total.cost+(value.usage?.cost??0)}),{requests:0,tokens:0,cost:0});
    const endpointUsage=new Map<string,import("../../contracts/src/api.js").ProjectUsageEndpoint>();
    for(const endpoint of endpoints)endpointUsage.set(endpoint.id,{endpointId:endpoint.id,endpointName:endpoint.name,requests:0,tokens:0,cost:0,limits:[]});
    let unassigned:import("../../contracts/src/api.js").ProjectUsageEndpoint|undefined;
    for(const value of settled){
      if(value.endpointId===null){unassigned??={endpointId:null,endpointName:"Other provider activity",requests:0,tokens:0,cost:0};unassigned.requests+=1;unassigned.tokens+=value.usage?.tokens??0;unassigned.cost+=value.usage?.cost??0;continue}
      const endpoint=endpointUsage.get(value.endpointId);if(!endpoint)continue;endpoint.requests+=1;endpoint.tokens+=value.usage?.tokens??0;endpoint.cost+=value.usage?.cost??0;
    }
    for(const endpoint of endpointUsage.values()){
      for(const window of policy.endpointWindows??[]){
        if(window.endpointId!==endpoint.endpointId)continue;
        const cutoff=new Date(Date.parse(input.measuredAt)-window.windowSeconds*1000).toISOString();
        const inWindow=providerSettlements.filter((value)=>value.endpointId===window.endpointId&&(value.actorId??null)===input.userId&&value.status!=="failed"&&value.reservedAt>=cutoff).sort((left,right)=>left.reservedAt.localeCompare(right.reservedAt)||compareOrdinal(left.id,right.id));
        const current=inWindow.reduce((sum,value)=>sum+providerWindowValue(value,window.metric),0),oldestReservedAt=inWindow[0]?.reservedAt??null;
        endpoint.limits!.push({metric:window.metric,current,limit:window.limit,remaining:Math.max(0,window.limit-current),window:{kind:"rolling",windowSeconds:window.windowSeconds,startedAt:cutoff,resetAt:oldestReservedAt?new Date(Date.parse(oldestReservedAt)+window.windowSeconds*1000).toISOString():null}});
      }
    }
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
    return{kind:"available",value:{projectCreatedAt:project.createdAt,policy,usage,provider:{daily,totals,endpoints:[...endpointUsage.values(),...(unassigned?[unassigned]:[])].map(clone)},sandbox:{unreleasedCount:liveRuns.length,launches:sandboxSettlements.filter((value)=>value.startedAt!==null).length+liveRuns.filter((run)=>run.startedAt!==null).length,totalDurationMilliseconds:totalDurationMilliseconds.toString(),cpuRequestMillisMilliseconds:cpuRequestMillisMilliseconds.toString(),memoryRequestByteMilliseconds:memoryRequestByteMilliseconds.toString(),liveRuns}}};
  }
  async measureProjectProviderWindow(input:{projectId:string;endpointId:string;actorId:string|null;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;since:string}):Promise<{current:number;oldestReservedAt:string|null}>{const settlements=[...this.providerSettlements.values()].filter((value)=>value.projectId===input.projectId&&value.endpointId===input.endpointId&&(value.actorId??null)===input.actorId&&value.status!=="failed"&&value.reservedAt>=input.since).sort((left,right)=>left.reservedAt.localeCompare(right.reservedAt)||left.id.localeCompare(right.id));return{current:settlements.reduce((sum,value)=>sum+providerWindowValue(value,input.metric),0),oldestReservedAt:settlements[0]?.reservedAt??null};}
  async measureProjectAlertRule(input: { projectId:string; alertType:ProjectAlertType; metric:import("../../contracts/src/api.js").AlertRuleMetric; windowSeconds:number|null; endpointId:string|null; now:string }): Promise<number> {
    const usage=this.usage.get(input.projectId);
    if(input.metric==="active_tasks")return usage?.activeTasks??0;
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
    return{items:page,hasMore:filtered.length>query.limit,activeCount};
  }
  async findActiveProjectAlert(projectId:string,type:ProjectAlertType,ruleId:string|null,endpointId:string|null,subjectActorId:string|null):Promise<ActiveProjectAlert|null>{const active=[...this.alerts.values()].filter((value):value is ActiveProjectAlert=>value.status==="active");const alert=active.find((value)=>value.projectId===projectId&&value.type===type&&(value.ruleId??null)===ruleId&&(value.endpointId??null)===endpointId&&(value.subjectActorId??null)===subjectActorId);return alert?clone(alert):null}
  async findProjectAlert(projectId: string, id: string): Promise<ProjectAlert | null> { const alert=this.alerts.get(id);return alert?.projectId===projectId?clone(alert):null; }
  async transitionProjectAlert(projectId: string, id: string, status: "resolved" | "dismissed", updatedAt: string): Promise<ProjectAlert | null> { const alert = this.alerts.get(id); if (!alert || alert.projectId !== projectId || alert.status !== "active") return null; const next = { ...alert, status, updatedAt, ...(status === "resolved" ? { resolvedAt: updatedAt } : { dismissedAt: updatedAt }) }; this.alerts.set(id, clone(next)); return clone(next); }
  async updateProjectAlertState(projectId:string,id:string,input:{acknowledgedAt?:string;acknowledgedBy?:string;silencedUntil?:string|null},updatedAt:string){const alert=this.alerts.get(id);if(!alert||alert.projectId!==projectId||alert.status!=="active")return null;const next={...alert,...input,updatedAt};this.alerts.set(id,clone(next));return clone(next)}
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
  async confirmSandboxRunStarted(input:ConfirmSandboxRunStartedInput):Promise<ConfirmSandboxRunStartedResult>{
    return this.sandboxRuns.confirmStarted(input,(event)=>{if(!this.auditEvents.some((current)=>current.id===event.id))this.auditEvents.push(clone({...event,detail:sanitizeProjectAuditDetail(event.detail)}));});
  }
  async activateTaskSandboxRun(input:ActivateTaskSandboxRunInput):Promise<ActivateTaskSandboxRunResult>{
    return this.sandboxRuns.activateTask(input,()=>this.tasks.get(input.taskId));
  }
  async completeSandboxRunRelease(input:CompleteSandboxRunReleaseInput):Promise<CompleteSandboxRunReleaseResult>{
    try{return await this.sandboxRuns.completeRelease(input,(replay)=>{
      const existing=this.sandboxUsageSettlements.get(input.runId);
      if(existing&&!sameSettlement(existing,input.settlement))throw new Error("Sandbox usage settlement conflict");
      if(replay){if(!existing)throw new Error("Sandbox usage settlement conflict");}
      else{
        const task=this.tasks.get(input.run.taskId);
        const project=this.projects.get(input.run.projectId);
        if(!taskMatchesActiveSandboxRun(task,project,input.run))throw new Error("Sandbox usage task conflict");
      }
      if(!existing)this.sandboxUsageSettlements.set(input.runId,clone(input.settlement));
      if(!replay)this.releaseActiveTask(input.run.projectId,input.run.releasedAt!);
      if(!this.auditEvents.some((event)=>event.id===input.auditEvent.id))this.auditEvents.push(clone({...input.auditEvent,detail:sanitizeProjectAuditDetail(input.auditEvent.detail)}));
    });}catch(error){if(error instanceof Error&&(error.message==="Sandbox usage settlement conflict"||error.message==="Sandbox usage task conflict"))return"conflict";throw error}
  }
  async failSandboxRun(input:SandboxRunFailureInput):Promise<PersistedSandboxRunState|null>{
    return this.sandboxRuns.fail(input,(event)=>{if(!this.auditEvents.some((current)=>current.id===event.id))this.auditEvents.push(clone({...event,detail:sanitizeProjectAuditDetail(event.detail)}));});
  }
  async runSandboxStartupOperation<T>(input:SandboxStartupOperationInput,operation:()=>Promise<T>):Promise<{kind:"applied";value:T}|{kind:"conflict"}>{
    return this.sandboxRuns.runStartupOperation(input,()=>this.tasks.get(input.taskId),operation);
  }
  async querySandboxUsageSettlements(query:ProjectSandboxSettlementQuery):Promise<ProjectSandboxSettlementPage>{
    const filtered=[...this.sandboxUsageSettlements.values()].filter((value)=>value.projectId===query.projectId&&value.startedByUserId===query.selectedUserId&&value.releasedAt<=query.scopeMeasuredAt&&(!query.after||value.releasedAt<query.after.releasedAt||value.releasedAt===query.after.releasedAt&&compareOrdinal(value.runId,query.after.runId)<0)).sort((left,right)=>right.releasedAt.localeCompare(left.releasedAt)||compareOrdinal(right.runId,left.runId));
    const page=filtered.slice(0,query.limit),items=page.map((value)=>{const task=this.tasks.get(value.taskId),taskAvailable=Boolean(task&&!task.deletedAt);return{taskId:value.taskId,taskTitle:taskAvailable?task!.title??null:null,taskAvailable,runId:value.runId,fileLibraryId:value.fileLibraryId,startedAt:value.startedAt,releasedAt:value.releasedAt,durationSeconds:value.durationSeconds,resources:clone(value.resources),releaseReason:value.releaseReason}});
    return{items,hasMore:filtered.length>query.limit};
  }
  async listSandboxUsageSettlements(projectId:string,startedByUserId:string):Promise<SandboxUsageSettlement[]>{return[...this.sandboxUsageSettlements.values()].filter((value)=>value.projectId===projectId&&value.startedByUserId===startedByUserId).sort((a,b)=>b.releasedAt.localeCompare(a.releasedAt)||b.runId.localeCompare(a.runId)).map(clone)}
  async createProjectCredential(v:StoredProjectCredential): Promise<ProjectCredential> { this.credentials.set(v.id,clone(v)); return publicCredential(v); }
  async findProjectCredential(id:string): Promise<StoredProjectCredential | null> { return clone(this.credentials.get(id) ?? null); }
  async listProjectCredentials(id:string): Promise<ProjectCredential[]> { return [...this.credentials.values()].filter(v=>v.projectId===id).map(publicCredential); }
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
  async findProjectAlertRule(projectId:string,id:string){const rule=this.alertRules.get(id);return rule?.projectId===projectId?clone(rule):null}
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

  async listEndpointsForProject(projectId: string): Promise<ModelEndpoint[]> {
    return [...this.endpoints.values()].filter((endpoint) => endpoint.projectId === projectId).map(clone);
  }

  async findEndpoint(id: string): Promise<ModelEndpoint | null> {
    return clone(this.endpoints.get(id) ?? null);
  }

  async createTaskAtomically(input: AtomicTaskCreateInput) {
    return this.atomicTaskMessageMutation([input],async()=>{
    if (this.tasks.has(input.task.id)) throw new Error("Task already exists");
    validateTaskRunReservation(input);
    const project=this.projects.get(input.task.projectId);
    if(!project||(project.lifecycleStatus??"active")!=="active")return{kind:"project_unavailable" as const};
    let library=input.task.fileLibraryId?this.fileLibraries.get(input.task.fileLibraryId):undefined;
    if(input.newFileLibrary){if(library||await this.createFileLibrary(input.newFileLibrary)===null)return{kind:"library_name_conflict" as const};library=input.newFileLibrary;}
    if(!library||library.workspaceId!==input.task.workspaceId||library.projectId!==input.task.projectId){if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id);return{kind:"library_not_found" as const};}
    if([...this.tasks.values()].some((task)=>task.fileLibraryId===library.id)){if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id);return{kind:"already_bound" as const};}
    const task = normalizeStoredTask(input.task);
    if (input.reserveActive && !this.reserveActiveTask(task.projectId, task.updatedAt)) { if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id); return{kind:"capacity_rejected" as const}; }
    this.tasks.set(task.id, clone(task));
    this.initializeTaskInteractionSync(task.id);
    try {
      if (input.runtimeState) await this.jsonDocs.put("sandbox_runtime_state", task.id, input.runtimeState);
      if (input.sandboxRun) await this.sandboxRuns.put(input.sandboxRun);
      if(input.initialMessage)await this.createTaskMessage(input.initialMessage);
      if(input.auditEvent&&!this.auditEvents.some((event)=>event.id===input.auditEvent!.id))await this.appendProjectAuditEvent(input.auditEvent);
      return{kind:"created" as const,task:clone(task)};
    } catch (error) {
      this.tasks.delete(task.id);
      if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id);
      this.interactionSync.delete(task.id);
      if (input.reserveActive) this.releaseActiveTask(task.projectId, task.updatedAt);
      await this.jsonDocs.delete("sandbox_runtime_state", task.id);
      if (input.sandboxRun) this.sandboxRuns.delete(input.sandboxRun.runId);
      if(input.initialMessage){const index=this.messages.findIndex((message)=>message.id===input.initialMessage!.id);if(index>=0)this.messages.splice(index,1);}
      throw error;
    }
    });
  }

  async restartTaskSandboxAtomically(input: AtomicTaskSandboxRestartInput): Promise<AtomicTaskSandboxRestartResult> {
    return this.atomicTaskMessageMutation([{task:input.task,reserveActive:true,runtimeState:input.runtimeState,sandboxRun:input.sandboxRun}],async()=>{
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
      if(!this.reserveActiveTask(current.projectId,input.reservedAt))return{kind:"capacity_rejected" as const};
      const restarted=normalizeStoredTask({...current,currentRunId:input.sandboxRun.runId,updatedAt:input.reservedAt});
      this.tasks.set(restarted.id,clone(restarted));
      await this.jsonDocs.put("sandbox_runtime_state",restarted.id,input.runtimeState);
      await this.sandboxRuns.put(input.sandboxRun);
      return{kind:"restarted",task:clone(restarted)};
    });
  }

  async createTaskMessageAtomically(input:AtomicTaskMessageInput):Promise<AtomicTaskMessageResult>{
    return this.atomicTaskMessageMutation(input.restart?[{task:input.restart.task,reserveActive:true,runtimeState:input.restart.runtimeState,sandboxRun:input.restart.sandboxRun}]:[],async()=>{
      const project=this.projects.get(input.idempotency.projectId);
      if(!project||(project.lifecycleStatus??"active")!=="active")return{kind:"conflict"};
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
        const restartInput:AtomicTaskSandboxRestartInput={expectedReleasedRunId:input.expectedCurrentRunId,task:input.restart.task,runtimeState:input.restart.runtimeState,sandboxRun:input.restart.sandboxRun,reservedAt:input.restart.reservedAt};
        if(!sandboxRestartIdentityMatches(task,restartInput))return{kind:"conflict"};
        if(!this.reserveActiveTask(task.projectId,input.restart.reservedAt))return{kind:"capacity_rejected"};
        task=normalizeStoredTask(input.restart.task);
        this.tasks.set(task.id,clone(task));
        await this.jsonDocs.put("sandbox_runtime_state",task.id,input.restart.runtimeState);
        await this.sandboxRuns.put(input.restart.sandboxRun);
        run=input.restart.sandboxRun;
        restarted=true;
      }
      const created=await this.createTaskMessage(message);
      const audit=canonicalMessageAuditEvent(input.auditEvent,created,task.projectId);
      if(!this.auditEvents.some((event)=>event.id===audit.id))await this.appendProjectAuditEvent(audit);
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
      this.sandboxRuns.deleteForTask(taskId);
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

  async findTaskIdempotencyByResource(input:TaskIdempotencyResourceLookupInput):Promise<TaskIdempotencyBeginResult|null>{
    const row=[...this.taskIdempotency.values()].find((record)=>record.actorId===input.actorId&&record.operation===input.operation&&record.key===input.key&&record.resourceId===input.resourceId);
    if(!row)return null;
    if(row.requestHash!==input.requestHash)return{kind:"hash_mismatch"};
    if(row.status==="completed")return{kind:"replay",resourceId:row.resourceId,responseStatus:row.responseStatus!,responseBody:clone(row.responseBody)};
    return{kind:"in_progress",resourceId:row.resourceId};
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
    const key=taskIdempotencyKey(input.idempotency),record=this.taskIdempotency.get(key);
    if(!record||record.status!=="in_progress"||record.requestHash!==input.idempotency.requestHash||record.claimToken!==input.idempotency.claimToken)return"conflict" as const;
    return this.sandboxRuns.requestExplicitCleanup(input,()=>{
      this.taskIdempotency.set(key,{...record,status:"completed",responseStatus:input.idempotency.responseStatus,responseBody:clone(input.idempotency.responseBody),updatedAt:input.idempotency.updatedAt});
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
    const maximum = this.interactionChanges.filter((change) => change.interaction.taskId === taskId).reduce((value, change) => Math.max(value, change.changeSeq), 0);
    const latest = latestInteractions(this.interactionChanges.filter((change) => change.interaction.taskId === taskId && change.changeSeq <= maximum));
    const eligible = before ? latest.filter((item) => item.position < before.position || item.position === before.position && item.id < before.interactionId) : latest;
    const page = eligible.slice(Math.max(0, eligible.length - Math.max(1, limit)));
    const hasMoreBefore = eligible.length > page.length;
    const sync = this.interactionSync.get(taskId) ?? { sourceCursor: null, historyStatus: "gap" as const, lastSyncedAt: null };
    const queuedMessages = this.messages.filter((message) => message.taskId === taskId && !message.deletedAt && ["pending","dispatching","failed"].includes(message.deliveryStatus ?? "pending")).sort((left,right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).map(clone);
    const suppressedMessageIds = new Set(this.messages.filter((message) => message.taskId === taskId && (Boolean(message.deletedAt) || ["pending","dispatching","failed"].includes(message.deliveryStatus ?? "pending"))).map((message) => message.id));
    const suppressedInteractionIds = [...new Set(this.interactionChanges.filter((change) => change.interaction.taskId === taskId && change.sourceKind === "product" && change.sourceId.startsWith("message:") && !change.sourceId.endsWith(":boundary") && suppressedMessageIds.has(change.sourceId.slice("message:".length))).map((change) => change.interaction.id))];
    return { items: page.map(clone), queuedMessages, suppressedInteractionIds, nextPageAnchor: hasMoreBefore && page[0] ? { position: page[0].position, interactionId: page[0].id } : null, hasMoreBefore, latestChangeSeq: maximum, sourceCursor: sync.sourceCursor, historyStatus: sync.historyStatus, lastSyncedAt: sync.lastSyncedAt };
  }

  async listTaskInteractionChanges(taskId: string, afterChangeSeq: number, limit: number): Promise<PersistedTaskInteractionChange[]> {
    return this.interactionChanges.filter((change) => change.interaction.taskId === taskId && change.changeSeq > afterChangeSeq).sort((left,right) => left.changeSeq - right.changeSeq).slice(0, Math.max(1, limit)).map(clone);
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
  async createPendingTaskMessage(v:PersistedTaskMessage,interactionChange?:TaskInteractionChangeInput):Promise<PersistedTaskMessage|null>{return this.atomicTaskMessageMutation([],async()=>{const source=this.tasks.get(v.taskId);if(!source||source.deletedAt)return null;const created=await this.createTaskMessage(v);this.appendInteractionChanges(v.taskId,interactionChange?[interactionChange]:[]);return created;});}
  async listTaskMessages(taskId: string): Promise<PersistedTaskMessage[]> { return this.messages.filter((value) => value.taskId === taskId && !value.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(clone); }
  async findTaskMessage(id: string): Promise<PersistedTaskMessage | null> { return clone(this.messages.find((value) => value.id === id) ?? null); }
  async listTaskMessagesDue(now: string, limit: number): Promise<PersistedTaskMessage[]> {
    return this.messages.filter((message) => !message.deletedAt && (
      (message.deliveryStatus ?? "pending") === "pending" && (!message.nextRetryAt || message.nextRetryAt <= now) ||
      message.deliveryStatus === "dispatching" && Boolean(message.leaseExpiresAt && message.leaseExpiresAt <= now) && (!message.nextRetryAt || message.nextRetryAt <= now)
    )).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(0, limit).map(clone);
  }
  async claimTaskMessage(input: TaskDeliveryClaimInput): Promise<PersistedTaskMessage | null> {
    const index = this.messages.findIndex((value) => value.id === input.id);
    const current = this.messages[index];
    const source=current?this.tasks.get(current.taskId):undefined;
    if (!current || !source || source.deletedAt || current.deletedAt || (current.deliveryStatus ?? "pending") !== "pending" || current.claimToken || (current.nextRetryAt && current.nextRetryAt > input.claimedAt)||hasOlderUnresolvedMessage(this.messages,current)) return null;
    const updated: PersistedTaskMessage = { ...current, deliveryStatus: "dispatching", claimToken: input.claimToken, claimedAt: input.claimedAt, leaseExpiresAt: input.leaseExpiresAt, attemptCount: (current.attemptCount ?? 0) + 1, safeError: null, updatedAt: input.claimedAt };
    this.messages[index] = clone(updated);
    return clone(updated);
  }
  async reclaimTaskMessage(input: TaskDeliveryReclaimInput): Promise<PersistedTaskMessage | null> {
    const index = this.messages.findIndex((value) => value.id === input.id);
    const current = this.messages[index];
    const source = current ? this.tasks.get(current.taskId) : undefined;
    if (!current || !source || source.deletedAt || current.deletedAt || current.deliveryStatus !== "dispatching" || current.claimToken !== input.expectedClaimToken || !current.leaseExpiresAt || current.leaseExpiresAt > input.claimedAt || (current.nextRetryAt && current.nextRetryAt > input.claimedAt)||hasOlderUnresolvedMessage(this.messages,current)) return null;
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

  private async atomicTaskMessageMutation<T>(runtimeWrites: AtomicTaskCreateInput[], mutation: () => Promise<T>): Promise<T> {
    const previous=this.taskMutationTail;
    let release!:()=>void;
    this.taskMutationTail=new Promise<void>((resolve)=>{release=resolve;});
    await previous;
    try{return await this.atomicTaskMessageMutationUnlocked(runtimeWrites,mutation);}
    finally{release();}
  }

  private async atomicTaskMessageMutationUnlocked<T>(runtimeWrites: AtomicTaskCreateInput[], mutation: () => Promise<T>): Promise<T> {
    const previousChanges = this.interactionChanges.map(clone);
    const previousTasks = [...this.tasks.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousInteractionSync = [...this.interactionSync.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousMessages = this.messages.map(clone);
    const previousUsage = [...this.usage.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousLibraries = [...this.fileLibraries.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousIdempotency = [...this.taskIdempotency.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousAudits = this.auditEvents.map(clone);
    const documents = await Promise.all(runtimeWrites.map((write) =>
      this.jsonDocs.get("sandbox_runtime_state", write.task.id).then((document) => ["sandbox_runtime_state",write.task.id,document] as const)
    ));
    const previousRuns=this.sandboxRuns.snapshot();
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
      this.taskIdempotency.clear();
      for (const [id,value] of previousIdempotency) this.taskIdempotency.set(id,value);
      this.auditEvents.splice(0,this.auditEvents.length,...previousAudits);
      for (const [collection,id,document] of documents) {
        if (document) await this.jsonDocs.put(collection,id,document);
        else await this.jsonDocs.delete(collection,id);
      }
      this.sandboxRuns.restore(previousRuns);
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

  private reserveActiveTask(projectId: string, updatedAt: string): boolean {
    const policy = this.policies.get(projectId);
    const usage = this.usage.get(projectId);
    const project=this.projects.get(projectId);
    if (!project || (project.lifecycleStatus??"active") !== "active" || !policy || !usage || (policy.activeTasksLimit !== null && usage.activeTasks + 1 > policy.activeTasksLimit)) return false;
    this.usage.set(projectId, clone({ ...usage, activeTasks: usage.activeTasks + 1, updatedAt }));
    return true;
  }

  private releaseActiveTask(projectId: string, updatedAt: string): void {
    const usage = this.usage.get(projectId);
    if (usage) this.usage.set(projectId, clone({ ...usage, activeTasks: Math.max(0, usage.activeTasks - 1), updatedAt }));
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
      if(current.state!=="released"&&run.state==="released")throw new Error("Sandbox released transition requires atomic settlement");
      return this.put(run);
    });
  }

  async requestExplicitCleanup(input:TaskSandboxReleaseMutationInput,commit:()=>void):Promise<TaskSandboxReleaseMutationResult>{
    return this.serializeMutation(async()=>{
      const current=this.runs.get(input.runId);
      if(!current||current.taskId!==input.taskId||current.runId!==input.runId)return"conflict";
      const already=current.state==="release_requested"||current.state==="released";
      if(current.state!=="released"&&(current.fencingToken!==input.expectedFencingToken||input.run.runId!==input.runId||input.run.taskId!==input.taskId||input.run.state!=="release_requested"||input.run.fencingToken!==current.fencingToken+1))return"conflict";
      commit();
      if(current.state!=="released")this.runs.set(input.runId,clone(input.run));
      return already?"already_requested":"applied";
    });
  }

  async fail(input:SandboxRunFailureInput,commit:(event:ProjectAuditEvent)=>void):Promise<PersistedSandboxRunState|null>{
    return this.serializeMutation(async()=>{
      const current=this.runs.get(input.runId);
      if(!current||current.fencingToken!==input.expectedFencingToken||!["starting","active"].includes(current.state))return null;
      const failed:PersistedSandboxRunState={...current,state:"failed",failureCode:input.code,failureCause:input.message,terminalFailure:input.terminalFailure??current.terminalFailure??null,releaseReason:"failed",failedAt:current.failedAt??input.failedAt,releaseRequestedAt:current.releaseRequestedAt??input.failedAt,startupClaimToken:null,startupLeaseExpiresAt:null,cleanupClaimedAt:null,fencingToken:current.fencingToken+1,updatedAt:input.failedAt};
      this.runs.set(input.runId,clone(failed));
      try{commit(input.auditEvent);return clone(failed);}catch(error){this.runs.set(input.runId,clone(current));throw error;}
    });
  }

  async runStartupOperation<T>(input:SandboxStartupOperationInput,readTask:()=>PersistedAgentTask|undefined,operation:()=>Promise<T>):Promise<{kind:"applied";value:T}|{kind:"conflict"}>{
    return this.serializeMutation(async()=>{
      const run=this.runs.get(input.runId),task=readTask();
      if(!run||!task||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||task.currentRunId!==run.runId||!taskRunScopeMatches(task,run)||task.deletedAt||task.archivedAt)return{kind:"conflict"};
      if(run.startupClaimToken&&run.startupClaimToken!==input.claimToken&&run.startupLeaseExpiresAt&&run.startupLeaseExpiresAt>input.claimedAt)return{kind:"conflict"};
      this.runs.set(run.runId,clone({...run,startupClaimToken:input.claimToken,startupLeaseExpiresAt:input.leaseExpiresAt,updatedAt:input.claimedAt}));
      return{kind:"applied",value:await operation()};
    });
  }

  async confirmStarted(input:ConfirmSandboxRunStartedInput,commit:(event:ProjectAuditEvent)=>void):Promise<ConfirmSandboxRunStartedResult>{
    return this.serializeMutation(async()=>{
      const current=await this.get(input.runId);
      if(!current)return{kind:"conflict"};
      if(current.startedAt){commit(input.auditEvent);return{kind:"already_started",run:current};}
      if(current.fencingToken!==input.expectedFencingToken||current.state!=="starting"||current.startupClaimToken!==input.startupClaimToken)return{kind:"conflict"};
      const run={...current,startedAt:input.startedAt,startupClaimToken:null,startupLeaseExpiresAt:null,fencingToken:current.fencingToken+1,updatedAt:input.startedAt};
      this.runs.set(input.runId,clone(run));
      try{commit(input.auditEvent);return{kind:"started",run:clone(run)};}catch(error){this.runs.set(current.runId,clone(current));throw error}
    });
  }

  async activateTask(
    input:ActivateTaskSandboxRunInput,
    readTask:()=>PersistedAgentTask|undefined
  ):Promise<ActivateTaskSandboxRunResult>{
    return this.serializeMutation(async()=>{
      const run=this.runs.get(input.runId);
      const task=readTask();
      if(!run||!task||!taskRunIdentityMatches(task,run,input))return{kind:"conflict"};
      if(run.state==="active"&&!task.deletedAt&&!task.archivedAt){
        return{kind:"already_running",task:clone(task),run:clone(run)};
      }
      if(run.state!=="starting"||!run.startedAt||run.fencingToken!==input.expectedFencingToken||task.deletedAt||task.archivedAt){
        return{kind:"conflict"};
      }
      const activatedRun={...run,state:"active" as const,startupClaimToken:null,startupLeaseExpiresAt:null,fencingToken:run.fencingToken+1,updatedAt:input.activatedAt};
      this.runs.set(run.runId,clone(activatedRun));
      return{kind:"activated",task:clone(task),run:clone(activatedRun)};
    });
  }

  async completeRelease(input:CompleteSandboxRunReleaseInput,commit:(replay:boolean)=>void):Promise<CompleteSandboxRunReleaseResult>{
    return this.serializeMutation(async()=>{
      const current=await this.get(input.runId);
      if(!current||!sameRunIdentity(current,input.run))return"conflict";
      if(current.state==="released"){commit(true);return"already_applied";}
      if(current.fencingToken!==input.expectedFencingToken||input.run.fencingToken!==current.fencingToken+1||input.run.state!=="released"||!settlementMatchesRun(input.settlement,current,input.run))return"conflict";
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
    left.createdAt===right.createdAt&&(left.resumeUnfinished??false)===(right.resumeUnfinished??false)&&
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
  return (run.state === "release_requested" || run.state === "failed")
    && (!run.startupLeaseExpiresAt||run.startupLeaseExpiresAt<=claimedAt)
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

function sandboxRestartIdentityMatches(current:PersistedAgentTask,input:AtomicTaskSandboxRestartInput):boolean{
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

function hasOlderUnresolvedMessage(messages:PersistedTaskMessage[],target:PersistedTaskMessage):boolean{
  return messages.some((message)=>message.taskId===target.taskId&&!message.deletedAt&&["pending","dispatching"].includes(message.deliveryStatus??"pending")&&(message.createdAt<target.createdAt||message.createdAt===target.createdAt&&message.id<target.id));
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
  const key = input.limit === "active_tasks_limit" ? "activeTasks" : input.limit === "provider_requests_limit" ? "providerRequests" : input.limit === "provider_tokens_limit" ? "providerTokens" : input.limit === "provider_cost_limit" ? "providerCost" : "projectFileBytes";
  const maximum = policy[`${key}Limit` as keyof ProjectResourcePolicy];
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
