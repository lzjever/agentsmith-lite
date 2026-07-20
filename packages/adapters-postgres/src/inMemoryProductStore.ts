import type {
  AgentTask,
  TaskInteractionItem,
  ProjectChatMessage,
  ProjectChatThread,
  AuthSession,
  EndpointHealth,
  FileLibrary,
  ModelEndpoint,
  ManagedProjectMembershipRole,
  Project,
  ProjectMembership, ProjectMembershipView,
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
  UserProfilePreferences, ProjectCredential, StoredProjectCredential, ProjectContextEntry, UserNotification, ProjectAlertRule, WorkspaceMembership, WorkspaceMembershipView, WorkspaceListProjection
} from "../../contracts/src/api.js";
import { sanitizeProjectAuditDetail } from "../../contracts/src/api.js";
import { CredentialVersionConflictError, EndpointNameConflictError } from "../../ports/src/store.js";
import { USER_NOTIFICATION_INBOX_LIMIT } from "./notificationRetention.js";
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
  ProjectResourceUsageAdjustment,
  AtomicTaskCreateInput,
  TaskStoreListQuery,
  TaskStoreListPage,
  TaskDeliveryClaimInput,
  TaskDeliveryReclaimInput,
  TaskStartReceiptInput,
  TaskMessageReceiptInput,
  TaskDeliveryDeferInput,
  TaskDeliveryFailureInput,
  StoredTaskSummary,
  BeginTaskIdempotencyInput,
  TaskIdempotencyBeginResult,
  CompleteTaskIdempotencyInput,
  TaskSandboxReleaseMutationInput,
  TaskSandboxReleaseMutationResult,
  ConfirmSandboxRunStartedInput,
  ConfirmSandboxRunStartedResult,
  CompleteSandboxRunReleaseInput,
  CompleteSandboxRunReleaseResult,
  SandboxUsageSettlement,
  PersistTaskArtifactProjectionInput,
  DeleteEndpointResult,
  DeleteProjectCredentialResult,
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
import { prepareSandboxRunDocument, sandboxRunFromDocument } from "./sandboxRunDocuments.js";

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
  readonly sandboxRuns = new InMemorySandboxRunStore(this.jsonDocs);

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
  private readonly chatThreads = new Map<string, ProjectChatThread>();
  private readonly chatMessages: ProjectChatMessage[] = [];
  private readonly stagedChatResponses = new Map<string, ProjectChatMessage>();
  private readonly taskIdempotency = new Map<string, InMemoryTaskIdempotencyRecord>();
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
  async beginWorkspaceDeletion(id:string, updatedAt:string, expectedOwnerUserId?:string){const value=this.workspaces.get(id);if(!value||(expectedOwnerUserId!==undefined&&value.ownerUserId!==expectedOwnerUserId))return{kind:"not_found_or_forbidden" as const};const projects=[...this.projects.values()].filter((project)=>project.workspaceId===id),uncertain:Project[]=[];for(const project of projects)if(!await this.projectSandboxesConfirmedCleaned(project.id))uncertain.push(project);const unownedManifest=(await this.sandboxRuns.list()).some((run)=>run.workspaceId===id&&run.cleanupStatus!=="cleaned"&&run.phase!=="cleaned"&&!projects.some((project)=>project.id===run.projectId));if(uncertain.length||unownedManifest){if(value.lifecycleStatus==="deleting"){this.workspaces.set(id,clone({...value,lifecycleStatus:"active" as const,updatedAt}));for(const affected of uncertain)if(affected.lifecycleStatus==="deleting")this.projects.set(affected.id,clone({...affected,lifecycleStatus:"active" as const,updatedAt}));}return{kind:"sandbox_not_released" as const};}if(value.lifecycleStatus==="deleting")return{kind:"ready" as const,value:clone(value)};const updated={...value,lifecycleStatus:"deleting" as const,updatedAt};this.workspaces.set(id,clone(updated));for(const project of projects)this.projects.set(project.id,clone({...project,lifecycleStatus:"deleting" as const,updatedAt}));return{kind:"ready" as const,value:clone(updated)}}
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
    if([...this.tasks.values()].some((task)=>!task.deletedAt&&task.fileLibraryId===id))return"bound" as const;
    this.fileLibraries.delete(id);return"deleted" as const;
  }
  async findTaskBoundToFileLibrary(fileLibraryId:string){const task=[...this.tasks.values()].find((candidate)=>!candidate.deletedAt&&candidate.fileLibraryId===fileLibraryId);return task?{kind:"bound" as const,task:{id:task.id,title:task.title??null}}:{kind:"unbound" as const}}
  async updateProjectName(projectId:string,name:string,updatedAt:string,expectedName:string){const current=this.projects.get(projectId);if(!current||(current.lifecycleStatus??"active")!=="active"||current.name!==expectedName)return null;const updated={...current,name,updatedAt};this.projects.set(projectId,clone(updated));return clone(updated)}
  async beginProjectDeletion(id:string,updatedAt:string,expectedOwnerUserId?:string){const value=this.projects.get(id);if(!value||(expectedOwnerUserId!==undefined&&value.ownerUserId!==expectedOwnerUserId))return{kind:"not_found_or_forbidden" as const};if(!await this.projectSandboxesConfirmedCleaned(id)){if(value.lifecycleStatus==="deleting")this.projects.set(id,clone({...value,lifecycleStatus:"active" as const,updatedAt}));return{kind:"sandbox_not_released" as const};}if(value.lifecycleStatus==="deleting")return{kind:"ready" as const,value:clone(value)};const updated={...value,lifecycleStatus:"deleting" as const,updatedAt};this.projects.set(id,clone(updated));return{kind:"ready" as const,value:clone(updated)}}
  async setProjectLifecycleStatus(id:string,status:"active"|"archived",updatedAt:string){const value=this.projects.get(id);if(!value||value.lifecycleStatus==="deleting")return null;const updated={...value,lifecycleStatus:status,updatedAt};this.projects.set(id,clone(updated));return clone(updated)}
  async transferProjectOwner(projectId:string,fromUserId:string,toUserId:string,updatedAt:string){const project=this.projects.get(projectId),target=this.memberships.get(membershipKey(projectId,toUserId));if(!project||project.ownerUserId!==fromUserId||fromUserId===toUserId||!target||project.lifecycleStatus!==undefined&&project.lifecycleStatus!=="active")return null;const from=this.memberships.get(membershipKey(projectId,fromUserId));if(!from)return null;this.memberships.set(membershipKey(projectId,fromUserId),clone({...from,role:"admin",updatedAt}));this.memberships.set(membershipKey(projectId,toUserId),clone({...target,role:"owner",updatedAt}));const updated={...project,ownerUserId:toUserId,updatedAt};this.projects.set(projectId,clone(updated));return clone(updated)}
  async deleteProjectDependenciesAndProject(id:string){
    const project=this.projects.get(id);
    if(!project||project.lifecycleStatus!=="deleting")return false;
    for(const [key,task] of this.tasks)if(task.projectId===id){this.tasks.delete(key);this.interactionSync.delete(key);}
    this.interactionChanges.splice(0,this.interactionChanges.length,...this.interactionChanges.filter((value)=>this.tasks.has(value.interaction.taskId)));
    this.artifacts.splice(0,this.artifacts.length,...this.artifacts.filter((value)=>this.tasks.has(value.taskId)));
    this.messages.splice(0,this.messages.length,...this.messages.filter((value)=>this.tasks.has(value.taskId)));
    this.auditEvents.splice(0,this.auditEvents.length,...this.auditEvents.filter((value)=>value.projectId!==id));
    const projectThreadIds=new Set([...this.chatThreads.values()].filter((thread)=>thread.projectId===id).map((thread)=>thread.id));
    for(const threadId of projectThreadIds)this.chatThreads.delete(threadId);
    this.chatMessages.splice(0,this.chatMessages.length,...this.chatMessages.filter((message)=>!projectThreadIds.has(message.threadId)));
    for(const [messageId,response] of this.stagedChatResponses)if(projectThreadIds.has(response.threadId))this.stagedChatResponses.delete(messageId);
    for(const [key,value] of this.providerSettlements)if(value.projectId===id)this.providerSettlements.delete(key);
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
    return true;
  }
  async deleteProjectAfterDependencies(id:string){const project=this.projects.get(id);if(!project||project.lifecycleStatus!=="deleting"||[...this.tasks.values()].some((task)=>task.projectId===id))return false;return this.projects.delete(id)}

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
  async setProjectFileBytes(projectId: string, bytes: number, updatedAt: string): Promise<ProjectResourceUsage | null> {
    const usage = this.usage.get(projectId);
    if (!usage) return null;
    const next = { ...usage, projectFileBytes: bytes, updatedAt };
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
    const policy = this.policies.get(input.projectId);
    const usage = this.usage.get(input.projectId);
    if (!policy || !usage || providerReservationExceedsPolicy(policy, usage, input)) return null;
    if (input.endpointId !== null) for(const window of policy.endpointWindows??[]){if(window.endpointId!==input.endpointId)continue;const cutoff=Date.parse(input.reservedAt)-window.windowSeconds*1000;const current=[...this.providerSettlements.values()].filter(value=>value.projectId===input.projectId&&value.endpointId===input.endpointId&&(value.actorId??null)===(input.actorId??null)&&value.status!=="failed"&&Date.parse(value.reservedAt)>=cutoff).reduce((sum,value)=>sum+providerWindowValue(value,window.metric),0);const proposed=current+(window.metric==="providerRequests"?1:window.metric==="providerTokens"?input.reservedTokens:input.reservedCost);if(proposed>window.limit)return null;}
    if (this.providerSettlements.has(input.id)) throw new Error("Provider settlement already exists");
    this.usage.set(input.projectId, clone({ ...usage, providerRequests: usage.providerRequests + 1, providerTokens: usage.providerTokens + input.reservedTokens, providerCost: usage.providerCost + input.reservedCost, updatedAt: input.reservedAt }));
    const settlement: ProjectProviderSettlement = { ...input, status: "reserved", dispatchedAt: null, deliveredAt: null, settledAt: null, updatedAt: input.reservedAt };
    this.providerSettlements.set(input.id, clone(settlement)); return clone(settlement);
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
  async measureProjectProviderWindow(input:{projectId:string;endpointId:string;actorId:string|null;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;since:string}):Promise<{current:number;oldestReservedAt:string|null}>{const settlements=[...this.providerSettlements.values()].filter((value)=>value.projectId===input.projectId&&value.endpointId===input.endpointId&&(value.actorId??null)===input.actorId&&value.status!=="failed"&&value.reservedAt>=input.since).sort((left,right)=>left.reservedAt.localeCompare(right.reservedAt)||left.id.localeCompare(right.id));return{current:settlements.reduce((sum,value)=>sum+providerWindowValue(value,input.metric),0),oldestReservedAt:settlements[0]?.reservedAt??null};}
  async measureProjectAlertRule(input: { projectId:string; alertType:ProjectAlert["type"]; metric:import("../../contracts/src/api.js").AlertRuleMetric; windowSeconds:number|null; endpointId:string|null; now:string }): Promise<number> {
    const usage=this.usage.get(input.projectId);
    if(input.metric==="active_tasks")return usage?.activeTasks??0;
    if(input.metric==="project_file_bytes")return usage?.projectFileBytes??0;
    const cutoff=input.windowSeconds===null?null:Date.parse(input.now)-input.windowSeconds*1000;
    if(input.metric!=="failure_count")return [...this.providerSettlements.values()].filter(value=>value.projectId===input.projectId&&value.status==="settled"&&value.settledAt!==null&&(cutoff===null||Date.parse(value.settledAt)>=cutoff)&&(input.endpointId===null||value.endpointId===input.endpointId)).reduce((sum,value)=>sum+(input.metric==="provider_requests"?1:input.metric==="provider_tokens"?(value.usage?.tokens??0):(value.usage?.cost??0)),0);
    return this.auditEvents.filter(event=>event.projectId===input.projectId&&(cutoff===null||Date.parse(event.createdAt)>=cutoff)&&(input.endpointId===null||event.detail?.endpointId===input.endpointId)&&failureEventMatches(input.alertType,event)).length;
  }
  private transitionSettlement(id: string, allowed: ProjectProviderSettlement["status"][], status: ProjectProviderSettlement["status"], updatedAt: string, timestamp?: "dispatchedAt" | "deliveredAt"): ProjectProviderSettlement | null { const current = this.providerSettlements.get(id); if (!current) return null; if (current.status === status) return clone(current); if (!allowed.includes(current.status)) return null; const updated = { ...current, status, ...(timestamp ? { [timestamp]: updatedAt } : {}), updatedAt } as ProjectProviderSettlement; this.providerSettlements.set(id, clone(updated)); return clone(updated); }
  private settlementResult(settlement: ProjectProviderSettlement): ProjectProviderUsageSettlement | null { const policy = this.policies.get(settlement.projectId); const usage = this.usage.get(settlement.projectId); if (!policy || !usage) return null; return { usage: clone(usage), endpointId: settlement.endpointId, exceededLimits: [...(policy.providerTokensLimit !== null && usage.providerTokens > policy.providerTokensLimit ? ["provider_tokens_limit" as const] : []), ...(policy.providerCostLimit !== null && usage.providerCost > policy.providerCostLimit ? ["provider_cost_limit" as const] : [])] }; }
  async upsertActiveProjectAlert(alert: ProjectAlert): Promise<ProjectAlert> {
    const normalized: ProjectAlert = { ...alert, metric: alert.metric ?? null, metricValue: alert.metricValue ?? null, threshold: alert.threshold ?? null };
    const existing = [...this.alerts.values()].find((value) => value.projectId === normalized.projectId && value.type === normalized.type && (value.ruleId??null)===(normalized.ruleId??null) && (value.endpointId??null)===(normalized.endpointId??null) && value.status === "active");
    const stored: ProjectAlert = existing ? { ...existing, metric: normalized.metric ?? null, metricValue: normalized.metricValue ?? null, threshold: normalized.threshold ?? null, updatedAt: normalized.updatedAt } : normalized;
    this.alerts.set(stored.id, clone(stored)); return clone(stored);
  }
  async listActiveProjectAlerts(projectId: string): Promise<ProjectAlert[]> { return [...this.alerts.values()].filter((alert) => alert.projectId === projectId && alert.status === "active").map(clone); }
  async listProjectAlerts(projectId: string): Promise<ProjectAlert[]> { return [...this.alerts.values()].filter((alert) => alert.projectId === projectId).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).map(clone); }
  async queryProjectAlerts(projectId: string, query: import("../../contracts/src/api.js").ProjectAlertQuery) { const limit=Math.min(100,Math.max(1,query.limit??20));const filtered=[...this.alerts.values()].filter((alert)=>alert.projectId===projectId&&(!query.status||alert.status===query.status)&&(!query.cursor||`${alert.createdAt}|${alert.id}`<query.cursor)).sort((left,right)=>right.createdAt.localeCompare(left.createdAt)||right.id.localeCompare(left.id));const items=filtered.slice(0,limit);return{items:items.map(clone),nextCursor:filtered.length>limit&&items.length?`${items.at(-1)!.createdAt}|${items.at(-1)!.id}`:null}; }
  async findProjectAlert(projectId: string, id: string): Promise<ProjectAlert | null> { const alert=this.alerts.get(id);return alert?.projectId===projectId?clone(alert):null; }
  async transitionProjectAlert(projectId: string, id: string, status: "resolved" | "dismissed", updatedAt: string): Promise<ProjectAlert | null> { const alert = this.alerts.get(id); if (!alert || alert.projectId !== projectId || alert.status !== "active") return null; const next = { ...alert, status, updatedAt, ...(status === "resolved" ? { resolvedAt: updatedAt } : { dismissedAt: updatedAt }) }; this.alerts.set(id, clone(next)); return clone(next); }
  async updateProjectAlertState(projectId:string,id:string,input:{acknowledgedAt?:string;acknowledgedBy?:string;silencedUntil?:string|null},updatedAt:string){const alert=this.alerts.get(id);if(!alert||alert.projectId!==projectId||alert.status!=="active")return null;const next={...alert,...input,updatedAt};this.alerts.set(id,clone(next));return clone(next)}
  async updateProjectAlertDeliveryStatus(projectId: string, id: string, status: ProjectAlert["deliveryStatus"], updatedAt: string): Promise<ProjectAlert | null> { const alert = this.alerts.get(id); if (!alert || alert.projectId !== projectId) return null; const next = { ...alert, deliveryStatus: status, updatedAt }; this.alerts.set(id, clone(next)); return clone(next); }
  async appendProjectAuditEvent(event: ProjectAuditEvent): Promise<void> { if(this.auditEvents.some(current=>current.id===event.id))return;this.auditEvents.push(clone({...event,detail:sanitizeProjectAuditDetail(event.detail)})); }
  async listProjectAuditEvents(projectId:string){return this.auditEvents.filter(event=>event.projectId===projectId).map(clone)}
  async queryProjectAuditEvents(projectId: string, query: import("../../contracts/src/api.js").ProjectAuditQuery) { const limit=Math.min(100,Math.max(1,query.limit??20)); const filtered=this.auditEvents.filter((event)=>event.projectId===projectId&&(!Object.hasOwn(query,"actorId")||event.actorId===query.actorId)&&(!Object.hasOwn(query,"subjectUserId")||(event.subjectUserId??null)===query.subjectUserId)&&(!query.action||event.action===query.action)&&(!query.status||event.status===query.status)&&(!query.resourceKind||event.resourceKind===query.resourceKind)&&(!query.resourceId||event.resourceId===query.resourceId)&&(!query.from||event.createdAt>=query.from)&&(!query.to||event.createdAt<=query.to)&&(!query.cursor||`${event.createdAt}|${event.id}`<query.cursor)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)); const items=filtered.slice(0,limit); return {items:items.map(clone),nextCursor:filtered.length>limit&&items.length?`${items.at(-1)!.createdAt}|${items.at(-1)!.id}`:null}; }
  async confirmSandboxRunStarted(input:ConfirmSandboxRunStartedInput):Promise<ConfirmSandboxRunStartedResult>{
    return this.sandboxRuns.confirmStarted(input,(event)=>{if(!this.auditEvents.some((current)=>current.id===event.id))this.auditEvents.push(clone({...event,detail:sanitizeProjectAuditDetail(event.detail)}));});
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
      if(!replay)this.releaseReservationForCleanedRun(input.run);
      if(!this.auditEvents.some((event)=>event.id===input.auditEvent.id))this.auditEvents.push(clone({...input.auditEvent,detail:sanitizeProjectAuditDetail(input.auditEvent.detail)}));
    });}catch(error){if(error instanceof Error&&(error.message==="Sandbox usage settlement conflict"||error.message==="Sandbox usage task conflict"))return"conflict";throw error}
  }
  async listSandboxUsageSettlements(projectId:string,startedByUserId:string):Promise<SandboxUsageSettlement[]>{return[...this.sandboxUsageSettlements.values()].filter((value)=>value.projectId===projectId&&value.startedByUserId===startedByUserId).sort((a,b)=>b.releasedAt.localeCompare(a.releasedAt)||b.runId.localeCompare(a.runId)).map(clone)}
  async createProjectCredential(v:StoredProjectCredential): Promise<ProjectCredential> { this.credentials.set(v.id,clone(v)); return publicCredential(v); }
  async findProjectCredential(id:string): Promise<StoredProjectCredential | null> { return clone(this.credentials.get(id) ?? null); }
  async listProjectCredentials(id:string): Promise<ProjectCredential[]> { return [...this.credentials.values()].filter(v=>v.projectId===id).map(publicCredential); }
  async updateProjectCredential(v:StoredProjectCredential,expectedVersion:number): Promise<ProjectCredential | "not_found" | "version_conflict"> { const current=this.credentials.get(v.id); if(!current)return "not_found"; if(current.projectId!==v.projectId||current.version!==expectedVersion)return "version_conflict"; this.credentials.set(v.id,clone(v));for(const [id,endpoint] of this.endpoints){if(endpoint.credentialId===v.id)this.endpoints.set(id,clone({...endpoint,health:{status:"unknown",checkedAt:null,errorCategory:null},updatedAt:v.updatedAt}))}return publicCredential(v); }
  async deleteProjectCredential(id:string,projectId:string,expectedVersion:number): Promise<DeleteProjectCredentialResult> { const current=this.credentials.get(id);if(!current||current.projectId!==projectId)return "not_found";if(current.version!==expectedVersion)return "version_conflict";if([...this.endpoints.values()].some(endpoint=>endpoint.credentialId===id))return "referenced_by_endpoints";this.credentials.delete(id);return "deleted"; }
  async listLegacyEndpointCredentialAliases(): Promise<Array<{ endpointId: string; projectId: string; baseUrl: string; secretRef: string }>> { return []; }
  async bindEndpointCredential(endpointId:string, credentialId:string): Promise<boolean> { const endpoint=this.endpoints.get(endpointId); const credential=this.credentials.get(credentialId); if(!endpoint||endpoint.credentialId||!credential||credential.projectId!==endpoint.projectId) return false; this.endpoints.set(endpointId,{...endpoint,credentialId}); return true; }
  async createProjectContextEntry(v:ProjectContextEntry){if(this.contextKeyExists(v))return null;this.contexts.set(v.id,clone(v));return clone(v)} async updateProjectContextEntry(v:ProjectContextEntry,expectedVersion:number){const current=this.contexts.get(v.id);if(!current||current.version!==expectedVersion||this.contextKeyExists(v,v.id))return null;this.contexts.set(v.id,clone(v));return clone(v)} async listProjectContextEntries(workspaceId:string,projectId:string|null,scope:ProjectContextEntry["scope"],ownerUserId:string|null){return [...this.contexts.values()].filter(v=>v.workspaceId===workspaceId&&v.projectId===projectId&&v.scope===scope&&v.ownerUserId===ownerUserId).map(clone)} async deleteProjectContextEntry(v:Pick<ProjectContextEntry,"id"|"workspaceId"|"projectId"|"scope"|"ownerUserId"|"version">){const current=this.contexts.get(v.id);if(!current||current.workspaceId!==v.workspaceId||current.projectId!==v.projectId||current.scope!==v.scope||current.ownerUserId!==v.ownerUserId||current.version!==v.version)return false;return this.contexts.delete(v.id)}
  async createProjectAlertRule(v:ProjectAlertRule){this.alertRules.set(v.id,clone(v));return clone(v)} async listProjectAlertRules(id:string){return [...this.alertRules.values()].filter(v=>v.projectId===id).map(clone)} async updateProjectAlertRule(v:ProjectAlertRule,expectedUpdatedAt?:string){const current=this.alertRules.get(v.id);if(!current||current.projectId!==v.projectId||(expectedUpdatedAt!==undefined&&current.updatedAt!==expectedUpdatedAt))return null;this.alertRules.set(v.id,clone(v));return clone(v)}
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
    if ([...this.tasks.values()].some((task) => task.endpointId === id && !task.deletedAt)) return "referenced_by_tasks";

    for (const [threadId, thread] of this.chatThreads) {
      if (thread.endpointId === id) this.chatThreads.set(threadId, clone({ ...thread, endpointId: null }));
    }
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

  async createProjectChatThread(thread: ProjectChatThread): Promise<ProjectChatThread> { this.chatThreads.set(thread.id, clone({ ...thread, title: thread.title ?? null, pinnedAt: thread.pinnedAt ?? null, starredAt: thread.starredAt ?? null, deletedAt: thread.deletedAt ?? null })); return clone(this.chatThreads.get(thread.id)!); }
  async createProjectChatBranch(thread: ProjectChatThread, messages: ProjectChatMessage[]): Promise<ProjectChatThread> {
    if (this.chatThreads.has(thread.id)) throw new Error("Chat thread already exists");
    const messageIds = new Set(this.chatMessages.map((message) => message.id));
    const sequences = new Set<number>();
    for (const message of messages) {
      if (message.threadId !== thread.id || messageIds.has(message.id) || sequences.has(message.sequence)) throw new Error("Chat branch messages are invalid");
      messageIds.add(message.id);
      sequences.add(message.sequence);
    }
    const created = clone({ ...thread, title: thread.title ?? null, pinnedAt: thread.pinnedAt ?? null, starredAt: thread.starredAt ?? null, deletedAt: thread.deletedAt ?? null });
    this.chatThreads.set(thread.id, created);
    this.chatMessages.push(...messages.map(clone));
    return clone(created);
  }
  async findProjectChatThread(id: string): Promise<ProjectChatThread | null> { return clone(this.chatThreads.get(id) ?? null); }
  async listProjectChatThreads(projectId: string, ownerUserId: string): Promise<ProjectChatThread[]> { return this.sortedChatThreads(projectId, ownerUserId); }
  async searchProjectChatThreads(projectId: string, ownerUserId: string, query: string): Promise<ProjectChatThread[]> { const needle = query.trim().toLowerCase(); return this.sortedChatThreads(projectId, ownerUserId).filter((thread) => !needle || (thread.title ?? "").toLowerCase().includes(needle)); }
  async updateProjectChatThreadMetadata(id: string, metadata: Pick<ProjectChatThread, "title" | "pinnedAt" | "starredAt">, updatedAt: string): Promise<ProjectChatThread | null> { const thread=this.chatThreads.get(id); if(!thread || thread.deletedAt) return null; const updated={...thread,title:metadata.title ?? null,pinnedAt:metadata.pinnedAt ?? null,starredAt:metadata.starredAt ?? null,updatedAt}; this.chatThreads.set(id,clone(updated)); return clone(updated); }
  async deleteProjectChatThread(id: string, deletedAt: string): Promise<ProjectChatThread|"request_running"|null> { const thread=this.chatThreads.get(id); if(!thread || thread.deletedAt) return null;if(this.chatMessages.some((message)=>message.threadId===id&&(message.deliveryStatus==="pending"||message.deliveryStatus==="response_pending")))return"request_running"; const updated={...thread,deletedAt,updatedAt:deletedAt}; this.chatThreads.set(id,clone(updated)); return clone(updated); }
  async touchProjectChatThread(id: string, updatedAt: string): Promise<ProjectChatThread | null> { const thread = this.chatThreads.get(id); if (!thread) return null; const updated = { ...thread, updatedAt }; this.chatThreads.set(id, clone(updated)); return clone(updated); }
  async appendProjectChatMessageIfCurrent(threadId:string,afterMessageId:string|null,message:ProjectChatMessage,untitledThreadTitle?:string):Promise<"accepted"|"history_changed"|"request_running">{const history=this.chatMessages.filter((item)=>item.threadId===threadId).sort((a,b)=>a.sequence-b.sequence);if(history.some((item)=>item.deliveryStatus==="pending"||item.deliveryStatus==="response_pending"))return"request_running";if((history.at(-1)?.id??null)!==afterMessageId)return"history_changed";this.chatMessages.push(clone(message));const thread=this.chatThreads.get(threadId);if(thread&&!thread.title&&untitledThreadTitle)this.chatThreads.set(threadId,clone({...thread,title:untitledThreadTitle,updatedAt:message.updatedAt}));return"accepted";}
  async appendProjectChatMessages(messages: ProjectChatMessage[]): Promise<void> { this.chatMessages.push(...messages.map(clone)); }
  async listProjectChatMessages(threadId: string): Promise<ProjectChatMessage[]> { return this.chatMessages.filter((message) => message.threadId === threadId).sort((a,b)=>a.sequence-b.sequence).map(clone); }
  async updateProjectChatMessageDelivery(id: string, deliveryStatus: ProjectChatMessage["deliveryStatus"], updatedAt: string): Promise<ProjectChatMessage | null> { const index=this.chatMessages.findIndex((message)=>message.id===id);if(index<0)return null;const current=this.chatMessages[index]!;const updated={...current,deliveryStatus,updatedAt,version:current.version+1};this.chatMessages[index]=clone(updated);return clone(updated); }
  async claimProjectChatMessageRetry(messageId:string,expectedVersion:number,updatedAt:string):Promise<ProjectChatMessage|null>{const index=this.chatMessages.findIndex((message)=>message.id===messageId&&message.role==="user");if(index<0)return null;const current=this.chatMessages[index]!;const history=this.chatMessages.filter((message)=>message.threadId===current.threadId).sort((a,b)=>a.sequence-b.sequence);if(current.version!==expectedVersion||!(current.deliveryStatus==="failed"||current.deliveryStatus==="stopped")||history.at(-1)?.id!==current.id||history.some((message)=>message.id!==current.id&&(message.deliveryStatus==="pending"||message.deliveryStatus==="response_pending")))return null;const claimed={...current,deliveryStatus:"pending" as const,updatedAt,version:current.version+1};this.chatMessages[index]=clone(claimed);return clone(claimed);}
  async stageProjectChatResponse(userMessageId:string,assistantMessage:ProjectChatMessage):Promise<boolean>{const index=this.chatMessages.findIndex((message)=>message.id===userMessageId&&message.role==="user");if(index<0)return false;const current=this.chatMessages[index]!;if(current.deliveryStatus==="completed")return this.chatMessages.some((message)=>message.id===assistantMessage.id);if(current.deliveryStatus==="response_pending"){return this.stagedChatResponses.get(userMessageId)?.id===assistantMessage.id;}this.stagedChatResponses.set(userMessageId,clone(assistantMessage));this.chatMessages[index]=clone({...current,deliveryStatus:"response_pending" as const,updatedAt:assistantMessage.updatedAt,version:current.version+1});return true;}
  async finalizeProjectChatResponse(userMessageId:string):Promise<ProjectChatMessage|null>{const index=this.chatMessages.findIndex((message)=>message.id===userMessageId&&message.role==="user");if(index<0)return null;const current=this.chatMessages[index]!;const staged=this.stagedChatResponses.get(userMessageId);if(!staged)return current.deliveryStatus==="completed"?clone(this.chatMessages.find((message)=>message.threadId===current.threadId&&message.sequence===current.sequence+1&&message.role==="assistant")??null):null;if(!this.chatMessages.some((message)=>message.id===staged.id))this.chatMessages.push(clone(staged));this.chatMessages[index]=clone({...current,deliveryStatus:"completed" as const,updatedAt:staged.updatedAt,version:current.version+1});return clone(staged);}
  async editProjectChatMessageAndTruncate(threadId:string,messageId:string,expectedVersion:number,content:string,updatedAt:string):Promise<ProjectChatMessage|null>{if(this.chatMessages.some((message)=>message.threadId===threadId&&(message.deliveryStatus==="pending"||message.deliveryStatus==="response_pending")))return null;const index=this.chatMessages.findIndex((message)=>message.id===messageId&&message.threadId===threadId);if(index<0||this.chatMessages[index]!.version!==expectedVersion)return null;const target=this.chatMessages[index]!;const updated={...target,content,version:target.version+1,updatedAt};for(let cursor=this.chatMessages.length-1;cursor>=0;cursor--){const message=this.chatMessages[cursor]!;if(message.threadId===threadId&&message.sequence>target.sequence)this.chatMessages.splice(cursor,1);}this.chatMessages[index]=clone(updated);return clone(updated);}
  async deleteProjectChatMessageAndFollowing(threadId:string,messageId:string,expectedVersion:number):Promise<boolean>{if(this.chatMessages.some((message)=>message.threadId===threadId&&(message.deliveryStatus==="pending"||message.deliveryStatus==="response_pending")))return false;const target=this.chatMessages.find((message)=>message.id===messageId&&message.threadId===threadId);if(!target||target.version!==expectedVersion)return false;for(let index=this.chatMessages.length-1;index>=0;index--){const message=this.chatMessages[index]!;if(message.threadId===threadId&&message.sequence>=target.sequence)this.chatMessages.splice(index,1);}return true;}

  async createTaskAtomically(input: AtomicTaskCreateInput) {
    if (this.tasks.has(input.task.id)) throw new Error("Task already exists");
    let library=input.task.fileLibraryId?this.fileLibraries.get(input.task.fileLibraryId):undefined;
    if(input.newFileLibrary){if(library||await this.createFileLibrary(input.newFileLibrary)===null)return{kind:"library_name_conflict" as const};library=input.newFileLibrary;}
    if(!library||library.workspaceId!==input.task.workspaceId||library.projectId!==input.task.projectId){if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id);return{kind:"library_not_found" as const};}
    if([...this.tasks.values()].some((task)=>!task.deletedAt&&task.fileLibraryId===library.id)){if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id);return{kind:"already_bound" as const};}
    const task = normalizeStoredTask(input.task, input.reserveActive);
    if (input.reserveActive && !this.reserveActiveTask(task.projectId, task.updatedAt)) { if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id); return{kind:"capacity_rejected" as const}; }
    this.tasks.set(task.id, clone(task));
    this.initializeTaskInteractionSync(task.id);
    try {
      if (input.runtimeState) await this.jsonDocs.put("sandbox_runtime_state", task.id, input.runtimeState);
      if (input.sandboxRun) await this.sandboxRuns.put(input.sandboxRun);
      if(input.initialMessage)await this.createTaskMessage(input.initialMessage);
      return{kind:"created" as const,task:clone(task)};
    } catch (error) {
      this.tasks.delete(task.id);
      if(input.newFileLibrary)this.fileLibraries.delete(input.newFileLibrary.id);
      this.interactionSync.delete(task.id);
      if (input.reserveActive) this.releaseActiveTask(task.projectId, task.updatedAt);
      await this.jsonDocs.delete("sandbox_runtime_state", task.id);
      if (input.sandboxRun) await this.jsonDocs.delete("sandbox_run_state", input.sandboxRun.runId);
      if(input.initialMessage){const index=this.messages.findIndex((message)=>message.id===input.initialMessage!.id);if(index>=0)this.messages.splice(index,1);}
      throw error;
    }
  }

  async updateTask(task: PersistedAgentTask): Promise<PersistedAgentTask> {
    this.tasks.set(task.id, clone(task));
    return clone(task);
  }

  async updateTaskStatusIfStarting(taskId: string, status: AgentTask["status"], updatedAt: string): Promise<PersistedAgentTask | null> {
    const current = this.tasks.get(taskId);
    if (!current || current.status !== "starting") {
      return null;
    }
    const updated = { ...current, status, updatedAt };
    this.tasks.set(taskId, clone(updated));
    return clone(updated);
  }

  async updateTaskStatusIfNonterminal(taskId: string, status: AgentTask["status"], updatedAt: string): Promise<PersistedAgentTask | null> {
    const current = this.tasks.get(taskId);
    if (!current || !isActiveTaskStatus(current.status)) {
      return null;
    }
    const updated = { ...current, status, updatedAt };
    this.tasks.set(taskId, clone(updated));
    return clone(updated);
  }
  async listActiveTasks(): Promise<PersistedAgentTask[]> {
    return [...this.tasks.values()].filter((task) => !task.deletedAt&&task.activeReservation===true).map(clone);
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
    filtered.sort((left, right) => direction * (field(left).localeCompare(field(right)) || left.id.localeCompare(right.id)));
    return { items: filtered.slice(query.offset, query.offset + query.limit).map(clone), total: filtered.length };
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

  async archiveTask(taskId: string, archivedAt: string): Promise<PersistedAgentTask | null> {
    const current = this.tasks.get(taskId);
    if (!current || current.deletedAt) return null;
    const updated = { ...current, archivedAt, updatedAt: archivedAt };
    this.tasks.set(taskId, clone(updated));
    return clone(updated);
  }

  async deleteTaskData(taskId: string, deletedAt: string): Promise<{ task: PersistedAgentTask; releasedArtifactBytes: number } | null> {
    const current = this.tasks.get(taskId);
    if (!current) return null;
    if(current.activeReservation)this.releaseActiveTask(current.projectId,deletedAt);
    const releasedArtifactBytes = 0;
    this.artifacts.splice(0, this.artifacts.length, ...this.artifacts.filter((artifact) => artifact.taskId !== taskId));
    this.messages.splice(0, this.messages.length, ...this.messages.filter((message) => message.taskId !== taskId));
    this.interactionChanges.splice(0, this.interactionChanges.length, ...this.interactionChanges.filter((change) => change.interaction.taskId !== taskId));
    this.interactionSync.delete(taskId);
    await this.jsonDocs.delete("sandbox_runtime_state", taskId);
    await this.jsonDocs.delete("sandbox_run_state", current.runId);
    const task = { ...current, fileLibraryId:null, activeReservation:false, deletedAt: current.deletedAt ?? deletedAt, updatedAt: deletedAt };
    this.tasks.set(taskId, clone(task));
    return { task: clone(task), releasedArtifactBytes };
  }

  async listTaskStartIntentsDue(now: string, limit: number): Promise<PersistedAgentTask[]> {
    return [...this.tasks.values()].filter((task) => !task.deletedAt && !task.terminalReason && (
      task.startIntentStatus === "pending" && (!task.startNextRetryAt || task.startNextRetryAt <= now) ||
      task.startIntentStatus === "dispatching" && Boolean(task.startLeaseExpiresAt && task.startLeaseExpiresAt <= now) && (!task.startNextRetryAt || task.startNextRetryAt <= now)
    )).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(0, limit).map(clone);
  }

  async claimTaskStart(input: TaskDeliveryClaimInput): Promise<PersistedAgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current || current.terminalReason || current.startIntentStatus !== "pending" || current.startClaimToken || (current.startNextRetryAt && current.startNextRetryAt > input.claimedAt)) return null;
    const updated: PersistedAgentTask = { ...current, startIntentStatus: "dispatching", startClaimToken: input.claimToken, startClaimedAt: input.claimedAt, startLeaseExpiresAt: input.leaseExpiresAt, startAttemptCount: (current.startAttemptCount ?? 0) + 1, startSafeError: null, updatedAt: input.claimedAt };
    this.tasks.set(input.id, clone(updated));
    return clone(updated);
  }

  async reclaimTaskStart(input: TaskDeliveryReclaimInput): Promise<PersistedAgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current || current.terminalReason || current.startIntentStatus !== "dispatching" || current.startClaimToken !== input.expectedClaimToken || !current.startLeaseExpiresAt || current.startLeaseExpiresAt > input.claimedAt || (current.startNextRetryAt && current.startNextRetryAt > input.claimedAt)) return null;
    const updated: PersistedAgentTask = { ...current, startClaimToken: input.claimToken, startClaimedAt: input.claimedAt, startLeaseExpiresAt: input.leaseExpiresAt, startAttemptCount: (current.startAttemptCount ?? 0) + 1, startSafeError: null, updatedAt: input.claimedAt };
    this.tasks.set(input.id, clone(updated));
    return clone(updated);
  }

  async recordTaskStartReceipt(input: TaskStartReceiptInput): Promise<PersistedAgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current || current.startIntentStatus !== "dispatching" || current.startClaimToken !== input.claimToken || current.startDeliveryKey !== input.receipt.deliveryKey || current.startRequestHash !== input.receipt.requestHash || !input.receipt.accepted) return null;
    const updated: PersistedAgentTask = { ...current, status: current.terminalReason ? current.status : "running", startIntentStatus: "dispatched", startReceipt: clone(input.receipt), startTimelineCursor: input.timelineCursor, startLeaseExpiresAt: null, startNextRetryAt: null, startSafeError: null, updatedAt: input.updatedAt };
    this.tasks.set(input.id, clone(updated));
    return clone(updated);
  }

  async deferTaskStart(input: TaskDeliveryDeferInput): Promise<PersistedAgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current || current.startIntentStatus !== "dispatching" || current.startClaimToken !== input.claimToken) return null;
    const updated: PersistedAgentTask = { ...current, startIntentStatus: input.releaseClaim ? "pending" : "dispatching", startClaimToken: input.releaseClaim ? null : current.startClaimToken ?? null, startClaimedAt: input.releaseClaim ? null : current.startClaimedAt ?? null, startLeaseExpiresAt: input.releaseClaim ? null : current.startLeaseExpiresAt ?? null, startSafeError: input.safeError, startNextRetryAt: input.nextRetryAt, updatedAt: input.updatedAt };
    this.tasks.set(input.id, clone(updated));
    return clone(updated);
  }

  async failTaskStart(input: TaskDeliveryFailureInput): Promise<PersistedAgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current || current.startIntentStatus !== "dispatching" || current.startClaimToken !== input.claimToken) return null;
    const updated: PersistedAgentTask = { ...current, startIntentStatus: "failed", startSafeError: input.safeError, startLeaseExpiresAt: null, updatedAt: input.updatedAt };
    this.tasks.set(input.id, clone(updated));
    return clone(updated);
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

  async completeTaskIdempotency(input: CompleteTaskIdempotencyInput): Promise<boolean> {
    const key = taskIdempotencyKey(input);
    const existing = this.taskIdempotency.get(key);
    if (!existing || existing.status !== "in_progress" || existing.requestHash !== input.requestHash || existing.claimToken !== input.claimToken) return false;
    this.taskIdempotency.set(key, { ...existing, status: "completed", responseStatus: input.responseStatus, responseBody: clone(input.responseBody), updatedAt: input.updatedAt });
    return true;
  }
  async requestTaskSandboxRelease(input:TaskSandboxReleaseMutationInput){
    const key=taskIdempotencyKey(input.idempotency),record=this.taskIdempotency.get(key);
    if(!record||record.status!=="in_progress"||record.requestHash!==input.idempotency.requestHash||record.claimToken!==input.idempotency.claimToken)return"conflict" as const;
    return this.sandboxRuns.requestExplicitCleanup(input,()=>{
      if(!this.auditEvents.some((event)=>event.id===input.auditEvent.id))this.auditEvents.push(clone({...input.auditEvent,detail:sanitizeProjectAuditDetail(input.auditEvent.detail)}));
      this.taskIdempotency.set(key,{...record,status:"completed",responseStatus:input.idempotency.responseStatus,responseBody:clone(input.idempotency.responseBody),updatedAt:input.idempotency.updatedAt});
    });
  }
  async completeTaskIdempotencyForResource(resourceId:string,responseStatus:number,responseBody:unknown,updatedAt:string):Promise<number>{let completed=0;for(const [key,record] of this.taskIdempotency){if(record.resourceId!==resourceId||record.status!=="in_progress")continue;this.taskIdempotency.set(key,{...record,status:"completed",responseStatus,responseBody:clone(responseBody),updatedAt});completed+=1;}return completed;}

  async persistTaskInteractionMutation(input: PersistTaskInteractionMutationInput): Promise<PersistTaskInteractionMutationResult> {
    const task = this.tasks.get(input.taskId);
    if (!task) throw new Error("Task not found");
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
      if (input.lifecycle?.kind === "active") {
        const current = this.tasks.get(input.taskId)!;
        if (current.status !== input.lifecycle.expectedStatus) throw new Error("Task interaction lifecycle conflict");
        this.tasks.set(input.taskId, { ...current, status: input.lifecycle.status, updatedAt: input.lifecycle.updatedAt });
      }
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
      if (!this.artifacts.some((existing) => existing.taskId === artifact.taskId && existing.fileId === artifact.fileId)) {
        this.artifacts.push(clone(artifact));
      }
    }
  }

  async persistTaskArtifactProjection(input: PersistTaskArtifactProjectionInput): Promise<"created" | "existing"> {
    const task = this.tasks.get(input.artifact.taskId);
    if (!task || task.projectId !== input.projectId) throw new Error("Task artifact project mismatch");
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

  async listTaskArtifacts(taskId: string): Promise<PersistedTaskArtifact[]> {
    return this.artifacts.filter((artifact) => artifact.taskId === taskId).map(clone);
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
  async updatePendingTaskMessage(id: string, content: string, requestHash: string, updatedAt: string, interactionChange?: TaskInteractionChangeInput): Promise<PersistedTaskMessage | null> {
    return this.atomicTaskMessageMutation([], async () => {
    const index = this.messages.findIndex((value) => value.id === id);
    const current = this.messages[index];
    if (!current || current.deletedAt || (current.deliveryStatus ?? "pending") !== "pending") return null;
    const updated = { ...current, content, requestHash, updatedAt };
    this.messages[index] = clone(updated);
    this.appendInteractionChanges(current.taskId, interactionChange ? [interactionChange] : []);
    return clone(updated);
    });
  }
  async deleteQueuedTaskMessage(id: string, deletedAt: string): Promise<PersistedTaskMessage | null> {
    const index = this.messages.findIndex((value) => value.id === id);
    const current = this.messages[index];
    if (!current || current.deletedAt || !["pending", "failed"].includes(current.deliveryStatus ?? "pending")) return null;
    const updated = { ...current, deletedAt, updatedAt: deletedAt };
    this.messages[index] = clone(updated);
    return clone(updated);
  }
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
  async findTaskSummary(taskId: string): Promise<StoredTaskSummary | null> { const task=this.tasks.get(taskId); return task ? this.taskSummary(task) : null; }
  async listTaskSummariesForProject(projectId: string): Promise<StoredTaskSummary[]> { return [...this.tasks.values()].filter((task) => task.projectId === projectId && !task.deletedAt).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).map((task) => this.taskSummary(task)); }

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

  private async atomicTaskMessageMutation<T>(successors: AtomicTaskCreateInput[], mutation: () => Promise<T>): Promise<T> {
    const previousChanges = this.interactionChanges.map(clone);
    const previousTasks = [...this.tasks.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousInteractionSync = [...this.interactionSync.entries()].map(([id,value]) => [id,clone(value)] as const);
    const previousMessages = this.messages.map(clone);
    const previousUsage = [...this.usage.entries()].map(([id,value]) => [id,clone(value)] as const);
    const documents = await Promise.all(successors.flatMap((successor) => [
      this.jsonDocs.get("sandbox_runtime_state", successor.task.id).then((document) => ["sandbox_runtime_state",successor.task.id,document] as const),
      ...(successor.sandboxRun ? [this.jsonDocs.get("sandbox_run_state",successor.sandboxRun.runId).then((document) => ["sandbox_run_state",successor.sandboxRun!.runId,document] as const)] : [])
    ]));
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
      for (const [collection,id,document] of documents) {
        if (document) await this.jsonDocs.put(collection,id,document);
        else await this.jsonDocs.delete(collection,id);
      }
      throw error;
    }
  }

  private sortedChatThreads(projectId: string, ownerUserId: string): ProjectChatThread[] { return [...this.chatThreads.values()].filter((thread) => thread.projectId === projectId && thread.ownerUserId === ownerUserId && !thread.deletedAt).sort((left, right) => Number(Boolean(right.starredAt)) - Number(Boolean(left.starredAt)) || (right.starredAt ?? "").localeCompare(left.starredAt ?? "") || Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt)) || (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "") || right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)).map(clone); }
  private taskSummary(task: PersistedAgentTask): StoredTaskSummary { return { taskId: task.id, artifactCount: this.artifacts.filter((artifact) => artifact.taskId === task.id).length, updatedAt: task.updatedAt }; }
  private initializeTaskInteractionSync(taskId: string): void { this.interactionSync.set(taskId, { sourceCursor: null, historyStatus: "complete", lastSyncedAt: null }); }

  private reserveActiveTask(projectId: string, updatedAt: string): boolean {
    const policy = this.policies.get(projectId);
    const usage = this.usage.get(projectId);
    if (this.projects.get(projectId)?.lifecycleStatus === "deleting" || !policy || !usage || (policy.activeTasksLimit !== null && usage.activeTasks + 1 > policy.activeTasksLimit)) return false;
    this.usage.set(projectId, clone({ ...usage, activeTasks: usage.activeTasks + 1, updatedAt }));
    return true;
  }

  private releaseActiveTask(projectId: string, updatedAt: string): void {
    const usage = this.usage.get(projectId);
    if (usage) this.usage.set(projectId, clone({ ...usage, activeTasks: Math.max(0, usage.activeTasks - 1), updatedAt }));
  }

  private async projectSandboxesConfirmedCleaned(projectId:string):Promise<boolean>{
    for(const task of this.tasks.values()){
      if(task.projectId!==projectId||task.deletedAt||task.executionMode!=="live")continue;
      if(task.activeReservation)return false;
      const run=await this.sandboxRuns.get(task.runId);
      if(!run||run.taskId!==task.id||run.runId!==task.runId||run.projectId!==task.projectId||run.workspaceId!==task.workspaceId||run.cleanupStatus!=="cleaned"&&run.phase!=="cleaned")return false;
    }
    for(const run of await this.sandboxRuns.list())if(run.projectId===projectId&&run.cleanupStatus!=="cleaned"&&run.phase!=="cleaned")return false;
    return true;
  }

  private releaseReservationForCleanedRun(run:PersistedSandboxRunState):void{
    const task=this.tasks.get(run.taskId);if(!task||task.runId!==run.runId||!task.activeReservation)return;
    this.tasks.set(task.id,clone({...task,activeReservation:false,updatedAt:run.updatedAt}));this.releaseActiveTask(task.projectId,run.updatedAt);
  }

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
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly jsonDocs: PostgresJsonDocStore) {}

  async put(run: PersistedSandboxRunState): Promise<PersistedSandboxRunState> {
    const current=await this.get(run.runId);if(current&&!sameRunIdentity(current,run))throw new Error("Sandbox run immutable attribution changed");
    if(current&&!isConfirmedCleanedRun(current)&&isConfirmedCleanedRun(run))throw new Error("Sandbox cleaned transition requires atomic settlement");
    const document = prepareSandboxRunDocument(run);
    await this.jsonDocs.put("sandbox_run_state", run.runId, document);
    const stored=sandboxRunFromDocument(document);
    return stored;
  }

  async get(runId: string): Promise<PersistedSandboxRunState | null> {
    const document = await this.jsonDocs.get("sandbox_run_state", runId);
    return document ? sandboxRunFromDocument(document) : null;
  }

  async list(): Promise<PersistedSandboxRunState[]> {
    if (!(this.jsonDocs instanceof InMemoryJsonDocStore)) {
      return [];
    }
    return this.jsonDocs.listCollection("sandbox_run_state").map(sandboxRunFromDocument);
  }

  async listActive(): Promise<PersistedSandboxRunState[]> {
    return (await this.list()).filter((run) => run.cleanupStatus !== "cleaned" && run.phase !== "cleaned");
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
        cleanupStatus: "deleting",
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
      if(!isConfirmedCleanedRun(current)&&isConfirmedCleanedRun(run))throw new Error("Sandbox cleaned transition requires atomic settlement");
      return this.put(run);
    });
  }

  async requestExplicitCleanup(input:TaskSandboxReleaseMutationInput,commit:()=>void):Promise<TaskSandboxReleaseMutationResult>{
    return this.serializeMutation(async()=>{
      if(!(this.jsonDocs instanceof InMemoryJsonDocStore))return"conflict";
      const document=this.jsonDocs.getSync("sandbox_run_state",input.runId);
      const current=document?sandboxRunFromDocument(document):null;
      if(!current||current.taskId!==input.taskId||current.runId!==input.runId)return"conflict";
      const already=current.cleanupStatus==="cleanup_requested"||current.cleanupStatus==="deleting"||current.cleanupStatus==="cleaned"||current.phase==="cleaned";
      if(!already&&(current.fencingToken!==input.expectedFencingToken||input.run.runId!==input.runId||input.run.taskId!==input.taskId||input.run.cleanupStatus!=="cleanup_requested"))return"conflict";
      commit();
      if(!already)this.jsonDocs.putSync("sandbox_run_state",input.runId,prepareSandboxRunDocument(input.run));
      return already?"already_requested":"applied";
    });
  }

  async confirmStarted(input:ConfirmSandboxRunStartedInput,commit:(event:ProjectAuditEvent)=>void):Promise<ConfirmSandboxRunStartedResult>{
    return this.serializeMutation(async()=>{
      const current=await this.get(input.runId);
      if(!current)return{kind:"conflict"};
      if(current.startedAt){commit(input.auditEvent);return{kind:"already_started",run:current};}
      if(current.fencingToken!==input.expectedFencingToken||current.cleanupStatus!=="active"||current.phase!=="starting")return{kind:"conflict"};
      const run={...current,startedAt:input.startedAt,fencingToken:current.fencingToken+1,updatedAt:input.startedAt};
      if(!(this.jsonDocs instanceof InMemoryJsonDocStore))return{kind:"conflict"};
      this.jsonDocs.putSync("sandbox_run_state",input.runId,prepareSandboxRunDocument(run));
      try{commit(input.auditEvent);return{kind:"started",run};}catch(error){this.jsonDocs.putSync("sandbox_run_state",current.runId,prepareSandboxRunDocument(current));throw error}
    });
  }

  async completeRelease(input:CompleteSandboxRunReleaseInput,commit:(replay:boolean)=>void):Promise<CompleteSandboxRunReleaseResult>{
    return this.serializeMutation(async()=>{
      const current=await this.get(input.runId);
      if(!current||!sameRunIdentity(current,input.run))return"conflict";
      if(current.cleanupStatus==="cleaned"||current.phase==="cleaned"){commit(true);return"already_applied";}
      if(current.fencingToken!==input.expectedFencingToken||input.run.fencingToken!==current.fencingToken+1||input.run.cleanupStatus!=="cleaned"||input.run.phase!=="cleaned"||!settlementMatchesRun(input.settlement,current,input.run))return"conflict";
      try{if(!(this.jsonDocs instanceof InMemoryJsonDocStore))return"conflict";this.jsonDocs.putSync("sandbox_run_state",input.runId,prepareSandboxRunDocument(input.run));commit(false);return"applied";}catch(error){if(this.jsonDocs instanceof InMemoryJsonDocStore)this.jsonDocs.putSync("sandbox_run_state",current.runId,prepareSandboxRunDocument(current));throw error}
    });
  }

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

function sameRunIdentity(left:PersistedSandboxRunState,right:PersistedSandboxRunState):boolean{return left.runId===right.runId&&left.taskId===right.taskId&&left.projectId===right.projectId&&left.workspaceId===right.workspaceId&&left.fileLibraryId===right.fileLibraryId&&left.startedByUserId===right.startedByUserId&&left.startedAt===right.startedAt&&JSON.stringify(left.resourceLimits)===JSON.stringify(right.resourceLimits)&&JSON.stringify(left.resourceSnapshot)===JSON.stringify(right.resourceSnapshot)}
function sameSettlement(left:SandboxUsageSettlement,right:SandboxUsageSettlement):boolean{return JSON.stringify(left)===JSON.stringify(right)}
function isConfirmedCleanedRun(run:PersistedSandboxRunState):boolean{return run.cleanupStatus==="cleaned"||run.phase==="cleaned"}
function settlementMatchesRun(value:SandboxUsageSettlement,current:PersistedSandboxRunState,cleaned:PersistedSandboxRunState):boolean{const duration=current.startedAt===null?0:Math.max(0,(Date.parse(cleaned.updatedAt)-Date.parse(current.startedAt))/1000);return value.runId===current.runId&&value.workspaceId===current.workspaceId&&value.projectId===current.projectId&&value.taskId===current.taskId&&value.fileLibraryId===current.fileLibraryId&&value.startedByUserId===current.startedByUserId&&value.startedAt===current.startedAt&&value.releasedAt===cleaned.updatedAt&&value.durationSeconds===duration&&value.releaseReason===cleaned.releaseReason&&JSON.stringify(value.resources)===JSON.stringify(current.resourceSnapshot)}
function taskMatchesActiveSandboxRun(task:PersistedAgentTask|undefined,project:Project|undefined,run:PersistedSandboxRunState):boolean{return Boolean(task&&project&&!task.deletedAt&&task.executionMode==="live"&&task.activeReservation===true&&task.id===run.taskId&&task.runId===run.runId&&task.projectId===run.projectId&&task.workspaceId===run.workspaceId&&task.fileLibraryId===run.fileLibraryId&&project.id===run.projectId&&project.workspaceId===run.workspaceId&&(task.createdByUserId??project.ownerUserId)===run.startedByUserId)}

function sandboxRunCleanupEligible(run: PersistedSandboxRunState, _claimedAt: string): boolean {
  if (run.cleanupStatus === "cleaned" || run.phase === "cleaned") return false;
  return run.cleanupStatus === "cleanup_requested" || run.cleanupStatus === "deleting";
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

function isActiveTaskStatus(status: AgentTask["status"]): boolean {
  return status === "queued" || status === "starting" || status === "running" || status === "stopping";
}

function statusForTerminalReason(reason: import("../../contracts/src/api.js").TaskTerminalReason): AgentTask["status"] {
  if (reason === "cancelled") return "cancelled";
  if (reason === "failed") return "failed";
  if (reason === "expired") return "expired";
  if (reason === "cleaned_legacy") return "cleaned";
  return "completed";
}

function normalizeStoredTask(task: PersistedAgentTask, activeReservation: boolean): PersistedAgentTask {
  return {
    ...clone(task),
    title: task.title ?? task.prompt.replace(/[\r\n]+/g, " ").slice(0, 160),
    activeReservation,
    archivedAt: task.archivedAt ?? null,
    deletedAt: task.deletedAt ?? null,
    terminalReason: task.terminalReason ?? null,
    terminalizedAt: task.terminalizedAt ?? null,
    startClaimToken: task.startClaimToken ?? null,
    startReceipt: task.startReceipt ?? null,
    startTimelineCursor: task.startTimelineCursor ?? null,
    startClaimedAt: task.startClaimedAt ?? null,
    startLeaseExpiresAt: task.startLeaseExpiresAt ?? null,
    startAttemptCount: task.startAttemptCount ?? 0,
    startNextRetryAt: task.startNextRetryAt ?? null,
    startSafeError: task.startSafeError ?? null,
    artifactProjectionStatus: task.artifactProjectionStatus ?? "pending",
    artifactProjectionError: task.artifactProjectionError ?? null,
    artifactProjectionClaimToken: task.artifactProjectionClaimToken ?? null,
    artifactProjectionLeaseExpiresAt: task.artifactProjectionLeaseExpiresAt ?? null,
    artifactProjectionAttemptCount: task.artifactProjectionAttemptCount ?? 0,
    artifactProjectionNextRetryAt: task.artifactProjectionNextRetryAt ?? null,
    cleanupStatus: task.cleanupStatus ?? "pending",
    cleanupError: task.cleanupError ?? null,
    cleanupClaimToken: task.cleanupClaimToken ?? null,
    cleanupLeaseExpiresAt: task.cleanupLeaseExpiresAt ?? null,
    cleanupAttemptCount: task.cleanupAttemptCount ?? 0,
    cleanupNextRetryAt: task.cleanupNextRetryAt ?? null,
    cleanupCompletedAt: task.cleanupCompletedAt ?? null
  };
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

function failureEventMatches(type:ProjectAlert["type"],event:ProjectAuditEvent):boolean {
  if(type==="task_failure")return event.action==="task.failed"&&event.status==="accepted";
  if(type==="provider_failure")return event.action==="provider.request"&&event.status==="rejected"&&event.resourceKind==="provider"&&event.detail?.errorCategory!==undefined;
  if(type==="endpoint_failure")return event.resourceKind==="endpoint"&&event.status==="rejected"&&event.detail?.healthStatus==="unavailable";
  if(type==="sandbox_failure")return event.action==="sandbox.failed"&&event.status==="accepted";
  return false;
}

function membershipKey(projectId: string, userId: string): string {
  return `${projectId}\0${userId}`;
}

function workspaceMembershipKey(workspaceId: string, userId: string): string { return `${workspaceId}\0${userId}`; }
