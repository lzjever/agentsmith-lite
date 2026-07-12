import type {
  AgentTask,
  AgentTaskArtifact,
  AgentTaskEvent,
  ProjectChatMessage,
  ProjectChatThread,
  AuthSession,
  ModelEndpoint,
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
  Workspace
  , UserProfilePreferences, ProjectCredential, StoredProjectCredential, ProjectContextEntry, UserNotification, ProjectAlertRule, TaskFollowUp, TaskSummary, WorkspaceMembership, WorkspaceMembershipView, WorkspaceListProjection
} from "../../contracts/src/api.js";
import { sanitizeProjectAuditDetail } from "../../contracts/src/api.js";
import type {
  AcquireLeaseInput,
  AcquireLeaseResult,
  JsonDocumentCollection,
  LeaseRecord,
  PostgresJsonDocStore,
  PostgresLeaseStore,
  PersistedSandboxRunState,
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
  TaskFollowUpReceiptInput,
  TaskDeliveryDeferInput,
  TaskDeliveryFailureInput,
  FinalizeTaskLifecycleInput,
  FinalizeTaskLifecycleResult,
  TaskStageClaimInput,
  TaskStageCompleteInput,
  TaskStageFailureInput,
  BeginTaskIdempotencyInput,
  TaskIdempotencyBeginResult,
  CompleteTaskIdempotencyInput,
  CreateTerminalTaskFollowUpInput,
  ResolveTerminalPendingFollowUpInput,
  PersistTaskArtifactProjectionInput,
  DeleteEndpointResult
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
  private readonly memberships = new Map<string, ProjectMembership>();
  private readonly workspaceMemberships = new Map<string, WorkspaceMembership>();
  private readonly policies = new Map<string, ProjectResourcePolicy>();
  private readonly usage = new Map<string, ProjectResourceUsage>();
  private readonly providerSettlements = new Map<string, ProjectProviderSettlement>();
  private readonly alerts = new Map<string, ProjectAlert>();
  private readonly auditEvents: ProjectAuditEvent[] = [];
  private readonly endpoints = new Map<string, ModelEndpoint>();
  private readonly tasks = new Map<string, AgentTask>();
  private readonly events: AgentTaskEvent[] = [];
  private readonly artifacts: AgentTaskArtifact[] = [];
  private readonly chatThreads = new Map<string, ProjectChatThread>();
  private readonly chatMessages: ProjectChatMessage[] = [];
  private readonly stagedChatResponses = new Map<string, ProjectChatMessage>();
  private readonly taskIdempotency = new Map<string, InMemoryTaskIdempotencyRecord>();
  private readonly profiles = new Map<string, UserProfilePreferences>(); private readonly notifications = new Map<string, UserNotification>(); private readonly notificationDedupe = new Map<string, string>(); private readonly credentials = new Map<string, StoredProjectCredential>(); private readonly contexts = new Map<string, ProjectContextEntry>(); private readonly alertRules = new Map<string, ProjectAlertRule>(); private readonly followUps: TaskFollowUp[] = [];

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
  async findUserProfilePreferences(id:string){return clone(this.profiles.get(id)??null)} async upsertUserProfilePreferences(v:UserProfilePreferences){this.profiles.set(v.userId,clone(v));return clone(v)} async createUserNotification(v:UserNotification,dedupeKey?:string){const existing=dedupeKey?this.notificationDedupe.get(dedupeKey):undefined;if(existing){const notification=this.notifications.get(existing);if(notification)return clone(notification);this.notificationDedupe.delete(dedupeKey!)}this.notifications.set(v.id,clone(v));if(dedupeKey)this.notificationDedupe.set(dedupeKey,v.id);return clone(v)} async listUserNotifications(id:string,unreadOnly=false){return [...this.notifications.values()].filter(v=>v.userId===id&&(!unreadOnly||!v.readAt)).map(clone)} async markUserNotificationRead(id:string,userId:string,readAt:string){const v=this.notifications.get(id);if(!v||v.userId!==userId)return null;const n={...v,readAt};this.notifications.set(id,clone(n));return clone(n)} async dismissUserNotification(id:string,userId:string){const v=this.notifications.get(id);if(!v||v.userId!==userId)return false;for(const [key,notificationId] of this.notificationDedupe)if(notificationId===id)this.notificationDedupe.delete(key);return this.notifications.delete(id)}

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
  async updateWorkspace(v:Workspace){if(!this.workspaces.has(v.id))return null;this.workspaces.set(v.id,clone(v));return clone(v)}
  async beginWorkspaceDeletion(id:string, updatedAt:string){const value=this.workspaces.get(id);if(!value)return null;const updated={...value,lifecycleStatus:"deleting" as const,updatedAt};this.workspaces.set(id,clone(updated));return clone(updated)}
  async setWorkspaceLifecycleStatus(id:string,status:"active"|"archived",updatedAt:string){const value=this.workspaces.get(id);if(!value||value.lifecycleStatus==="deleting")return null;const updated={...value,lifecycleStatus:status,updatedAt};this.workspaces.set(id,clone(updated));return clone(updated)}
  async transferWorkspaceOwner(workspaceId:string,fromUserId:string,toUserId:string,updatedAt:string){const workspace=this.workspaces.get(workspaceId),target=this.workspaceMemberships.get(workspaceMembershipKey(workspaceId,toUserId));if(!workspace||workspace.ownerUserId!==fromUserId||fromUserId===toUserId||!target||workspace.lifecycleStatus!==undefined&&workspace.lifecycleStatus!=="active")return null;const from=this.workspaceMemberships.get(workspaceMembershipKey(workspaceId,fromUserId));if(!from)return null;this.workspaceMemberships.set(workspaceMembershipKey(workspaceId,fromUserId),clone({...from,role:"admin",updatedAt}));this.workspaceMemberships.set(workspaceMembershipKey(workspaceId,toUserId),clone({...target,role:"owner",updatedAt}));const updated={...workspace,ownerUserId:toUserId,updatedAt};this.workspaces.set(workspaceId,clone(updated));return clone(updated)}
  async deleteWorkspaceAfterProjects(id:string){if([...this.projects.values()].some((project)=>project.workspaceId===id))return false; for(const [key,entry] of this.contexts) if(entry.workspaceId===id)this.contexts.delete(key); return this.workspaces.delete(id)}
  async findWorkspaceMembership(workspaceId:string,userId:string){return clone(this.workspaceMemberships.get(workspaceMembershipKey(workspaceId,userId))??null)}
  async listWorkspaceMemberships(workspaceId:string):Promise<WorkspaceMembershipView[]>{return [...this.workspaceMemberships.values()].filter((member)=>member.workspaceId===workspaceId).map((member)=>this.workspaceMembershipView(member))}
  async upsertWorkspaceMembership(value:WorkspaceMembership){this.workspaceMemberships.set(workspaceMembershipKey(value.workspaceId,value.userId),clone(value));return clone(value)}
  async updateWorkspaceMembership(value:WorkspaceMembership){const key=workspaceMembershipKey(value.workspaceId,value.userId);if(!this.workspaceMemberships.has(key))return null;this.workspaceMemberships.set(key,clone(value));return clone(value)}
  async deleteWorkspaceMembership(workspaceId:string,userId:string){return this.workspaceMemberships.delete(workspaceMembershipKey(workspaceId,userId))}

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

  async findProject(id: string): Promise<Project | null> {
    return clone(this.projects.get(id) ?? null);
  }
  async updateProject(v:Project){if(!this.projects.has(v.id))return null;this.projects.set(v.id,clone(v));return clone(v)}
  async beginProjectDeletion(id:string,updatedAt:string){const value=this.projects.get(id);if(!value)return null;const updated={...value,lifecycleStatus:"deleting" as const,updatedAt};this.projects.set(id,clone(updated));return clone(updated)}
  async setProjectLifecycleStatus(id:string,status:"active"|"archived",updatedAt:string){const value=this.projects.get(id);if(!value||value.lifecycleStatus==="deleting")return null;const updated={...value,lifecycleStatus:status,updatedAt};this.projects.set(id,clone(updated));return clone(updated)}
  async transferProjectOwner(projectId:string,fromUserId:string,toUserId:string,updatedAt:string){const project=this.projects.get(projectId),target=this.memberships.get(membershipKey(projectId,toUserId));if(!project||project.ownerUserId!==fromUserId||fromUserId===toUserId||!target||project.lifecycleStatus!==undefined&&project.lifecycleStatus!=="active")return null;const from=this.memberships.get(membershipKey(projectId,fromUserId));if(!from)return null;this.memberships.set(membershipKey(projectId,fromUserId),clone({...from,role:"admin",updatedAt}));this.memberships.set(membershipKey(projectId,toUserId),clone({...target,role:"owner",updatedAt}));const updated={...project,ownerUserId:toUserId,updatedAt};this.projects.set(projectId,clone(updated));return clone(updated)}
  async deleteProjectDependenciesAndProject(id:string){const project=this.projects.get(id);if(!project||project.lifecycleStatus!=="deleting"||[...this.tasks.values()].some((task)=>task.projectId===id&&isActiveTaskStatus(task.status)))return false; for(const [key,task] of this.tasks)if(task.projectId===id)this.tasks.delete(key); this.events.splice(0,this.events.length,...this.events.filter((value)=>this.tasks.has(value.taskId))); this.artifacts.splice(0,this.artifacts.length,...this.artifacts.filter((value)=>this.tasks.has(value.taskId))); this.followUps.splice(0,this.followUps.length,...this.followUps.filter((value)=>this.tasks.has(value.taskId))); for(const [key,value] of this.endpoints)if(value.projectId===id)this.endpoints.delete(key); for(const [key,value] of this.memberships)if(value.projectId===id)this.memberships.delete(key); for(const [key,value] of this.contexts)if(value.projectId===id)this.contexts.delete(key); for(const [key,value] of this.credentials)if(value.projectId===id)this.credentials.delete(key); for(const [key,value] of this.alertRules)if(value.projectId===id)this.alertRules.delete(key); this.policies.delete(id);this.usage.delete(id);return this.projects.delete(id)}

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
    return this.memberships.delete(membershipKey(projectId, userId));
  }

  private workspaceMembershipView(membership: WorkspaceMembership): WorkspaceMembershipView { const user = this.users.get(membership.userId); return { ...clone(membership), displayName: this.profiles.get(membership.userId)?.displayName ?? null, email: user?.email ?? membership.userId }; }
  private projectMembershipView(membership: ProjectMembership): ProjectMembershipView { const user = this.users.get(membership.userId); return { ...clone(membership), displayName: this.profiles.get(membership.userId)?.displayName ?? null, email: user?.email ?? membership.userId }; }

  async createProjectResourcePolicy(policy: ProjectResourcePolicy): Promise<ProjectResourcePolicy> { this.policies.set(policy.projectId, clone(policy)); return clone(policy); }
  async findProjectResourcePolicy(projectId: string): Promise<ProjectResourcePolicy | null> { return clone(this.policies.get(projectId) ?? null); }
  async patchProjectResourcePolicy(projectId: string, input: UpdateProjectResourcePolicyInput, updatedAt: string): Promise<ProjectResourcePolicy | null> {
    const policy = this.policies.get(projectId);
    if (!policy) return null;
    const updated = { ...policy, ...input, updatedAt };
    this.policies.set(projectId, clone(updated)); return clone(updated);
  }
  async findProjectResourceUsage(projectId: string): Promise<ProjectResourceUsage | null> { return clone(this.usage.get(projectId) ?? null); }
  async upsertProjectResourceUsage(usage: ProjectResourceUsage): Promise<ProjectResourceUsage> { this.usage.set(usage.projectId, clone(usage)); return clone(usage); }
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
    if (input.endpointId !== null) for(const window of policy.endpointWindows??[]){if(window.endpointId!==input.endpointId)continue;const cutoff=Date.parse(input.reservedAt)-window.windowSeconds*1000;const current=[...this.providerSettlements.values()].filter(value=>value.projectId===input.projectId&&value.endpointId===input.endpointId&&value.status!=="failed"&&Date.parse(value.reservedAt)>=cutoff).reduce((sum,value)=>sum+(window.metric==="providerRequests"?1:window.metric==="providerTokens"?(value.status==="settled"?(value.usage?.tokens??0):value.status==="unknown"?0:value.reservedTokens):(value.status==="settled"?(value.usage?.cost??0):value.status==="unknown"?0:value.reservedCost)),0);const proposed=current+(window.metric==="providerRequests"?1:window.metric==="providerTokens"?input.reservedTokens:input.reservedCost);if(proposed>window.limit)return null;}
    if (this.providerSettlements.has(input.id)) throw new Error("Provider settlement already exists");
    this.usage.set(input.projectId, clone({ ...usage, providerRequests: usage.providerRequests + 1, providerTokens: usage.providerTokens + input.reservedTokens, providerCost: usage.providerCost + input.reservedCost, updatedAt: input.reservedAt }));
    const settlement: ProjectProviderSettlement = { ...input, status: "reserved", dispatchedAt: null, deliveredAt: null, settledAt: null, updatedAt: input.reservedAt };
    this.providerSettlements.set(input.id, clone(settlement)); return clone(settlement);
  }
  async markProjectProviderSettlementDispatched(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null> { return this.transitionSettlement(id, ["reserved"], "dispatched", updatedAt, "dispatchedAt"); }
  async markProjectProviderSettlementDelivered(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null> { return this.transitionSettlement(id, ["dispatched"], "delivered", updatedAt, "deliveredAt"); }
  async settleProjectProviderSettlement(id: string, usage: ProviderUsage | undefined, updatedAt: string): Promise<ProjectProviderUsageSettlement | null> {
    const settlement = this.providerSettlements.get(id); if (!settlement) return null;
    if (settlement.status === "settled") return this.settlementResult(settlement);
    if ((settlement.status !== "dispatched" && settlement.status !== "delivered") || !usage) return null;
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
    const usage = this.usage.get(settlement.projectId);
    if (usage) this.usage.set(settlement.projectId, clone({ ...usage, providerTokens: Math.max(0, usage.providerTokens - settlement.reservedTokens), providerCost: Math.max(0, usage.providerCost - settlement.reservedCost), updatedAt }));
    const updated = { ...settlement, status: "unknown" as const, updatedAt };
    this.providerSettlements.set(id, clone(updated));
    return clone(updated);
  }
  async failProjectProviderSettlement(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null> {
    const settlement = this.providerSettlements.get(id); if (!settlement || settlement.status === "settled" || settlement.status === "failed") return settlement ? clone(settlement) : null;
    const usage = this.usage.get(settlement.projectId); if (usage) this.usage.set(settlement.projectId, { ...usage, providerRequests: settlement.status === "reserved" ? Math.max(0, usage.providerRequests - 1) : usage.providerRequests, providerTokens: Math.max(0, usage.providerTokens - settlement.reservedTokens), providerCost: Math.max(0, usage.providerCost - settlement.reservedCost), updatedAt });
    const updated = { ...settlement, status: "failed" as const, updatedAt }; this.providerSettlements.set(id, clone(updated)); return clone(updated);
  }
  async expireReservedProjectProviderSettlements(now: string): Promise<number> { let count = 0; for (const value of this.providerSettlements.values()) if (value.status === "reserved" && value.expiresAt <= now) { await this.failProjectProviderSettlement(value.id, now); count += 1; } return count; }
  async pruneProjectProviderSettlements(before: string, limit: number): Promise<number> { let count = 0; for (const [id, value] of this.providerSettlements) if (count < limit && value.updatedAt < before && ["settled", "unknown", "failed"].includes(value.status)) { this.providerSettlements.delete(id); count += 1; } return count; }
  async listSettledProjectProviderSettlements(projectId: string, since: string, endpointId?: string): Promise<ProjectProviderSettlement[]> { return [...this.providerSettlements.values()].filter((value) => value.projectId === projectId && value.status === "settled" && value.settledAt !== null && value.settledAt >= since && (endpointId === undefined || value.endpointId === endpointId)).sort((left, right) => left.settledAt!.localeCompare(right.settledAt!)).map(clone); }
  async measureProjectAlertRule(input: { projectId:string; alertType:ProjectAlert["type"]; metric:import("../../contracts/src/api.js").AlertRuleMetric; windowSeconds:number|null; endpointId:string|null; now:string }): Promise<number> {
    const usage=this.usage.get(input.projectId);
    if(input.metric==="active_tasks")return usage?.activeTasks??0;
    if(input.metric==="project_file_bytes")return usage?.projectFileBytes??0;
    const cutoff=input.windowSeconds===null?null:Date.parse(input.now)-input.windowSeconds*1000;
    if(input.metric!=="failure_count")return [...this.providerSettlements.values()].filter(value=>value.projectId===input.projectId&&value.status==="settled"&&value.settledAt!==null&&(cutoff===null||Date.parse(value.settledAt)>=cutoff)&&(input.endpointId===null||value.endpointId===input.endpointId)).reduce((sum,value)=>sum+(input.metric==="provider_requests"?1:input.metric==="provider_tokens"?(value.usage?.tokens??0):(value.usage?.cost??0)),0);
    return this.auditEvents.filter(event=>event.projectId===input.projectId&&(cutoff===null||Date.parse(event.createdAt)>=cutoff)&&(input.endpointId===null||event.detail?.endpointId===input.endpointId)&&failureEventMatches(input.alertType,event)).length;
  }
  private transitionSettlement(id: string, allowed: ProjectProviderSettlement["status"][], status: ProjectProviderSettlement["status"], updatedAt: string, timestamp?: "dispatchedAt" | "deliveredAt"): ProjectProviderSettlement | null { const current = this.providerSettlements.get(id); if (!current) return null; if (current.status === status) return clone(current); if (!allowed.includes(current.status)) return null; const updated = { ...current, status, ...(timestamp ? { [timestamp]: updatedAt } : {}), updatedAt } as ProjectProviderSettlement; this.providerSettlements.set(id, clone(updated)); return clone(updated); }
  private settlementResult(settlement: ProjectProviderSettlement): ProjectProviderUsageSettlement | null { const policy = this.policies.get(settlement.projectId); const usage = this.usage.get(settlement.projectId); if (!policy || !usage) return null; return { usage: clone(usage), exceededLimits: [...(policy.providerTokensLimit !== null && usage.providerTokens > policy.providerTokensLimit ? ["provider_tokens_limit" as const] : []), ...(policy.providerCostLimit !== null && usage.providerCost > policy.providerCostLimit ? ["provider_cost_limit" as const] : [])] }; }
  async upsertActiveProjectAlert(alert: ProjectAlert): Promise<ProjectAlert> {
    const normalized: ProjectAlert = { ...alert, metric: alert.metric ?? null, metricValue: alert.metricValue ?? null, threshold: alert.threshold ?? null };
    const existing = [...this.alerts.values()].find((value) => value.projectId === normalized.projectId && value.type === normalized.type && (value.ruleId??null)===(normalized.ruleId??null) && (value.endpointId??null)===(normalized.endpointId??null) && value.status === "active");
    const stored: ProjectAlert = existing ? { ...existing, metric: normalized.metric ?? null, metricValue: normalized.metricValue ?? null, threshold: normalized.threshold ?? null, updatedAt: normalized.updatedAt } : normalized;
    this.alerts.set(stored.id, clone(stored)); return clone(stored);
  }
  async listActiveProjectAlerts(projectId: string): Promise<ProjectAlert[]> { return [...this.alerts.values()].filter((alert) => alert.projectId === projectId && alert.status === "active").map(clone); }
  async listProjectAlerts(projectId: string): Promise<ProjectAlert[]> { return [...this.alerts.values()].filter((alert) => alert.projectId === projectId).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)).map(clone); }
  async transitionProjectAlert(projectId: string, id: string, status: "resolved" | "dismissed", updatedAt: string): Promise<ProjectAlert | null> { const alert = this.alerts.get(id); if (!alert || alert.projectId !== projectId || alert.status !== "active") return null; const next = { ...alert, status, updatedAt, ...(status === "resolved" ? { resolvedAt: updatedAt } : { dismissedAt: updatedAt }) }; this.alerts.set(id, clone(next)); return clone(next); }
  async updateProjectAlertState(projectId:string,id:string,input:{acknowledgedAt?:string;acknowledgedBy?:string;silencedUntil?:string|null},updatedAt:string){const alert=this.alerts.get(id);if(!alert||alert.projectId!==projectId||alert.status!=="active")return null;const next={...alert,...input,updatedAt};this.alerts.set(id,clone(next));return clone(next)}
  async updateProjectAlertDeliveryStatus(projectId: string, id: string, status: ProjectAlert["deliveryStatus"], updatedAt: string): Promise<ProjectAlert | null> { const alert = this.alerts.get(id); if (!alert || alert.projectId !== projectId) return null; const next = { ...alert, deliveryStatus: status, updatedAt }; this.alerts.set(id, clone(next)); return clone(next); }
  async appendProjectAuditEvent(event: ProjectAuditEvent): Promise<void> { if(this.auditEvents.some(current=>current.id===event.id))return;this.auditEvents.push(clone({...event,detail:sanitizeProjectAuditDetail(event.detail)})); }
  async listProjectAuditEvents(projectId:string){return this.auditEvents.filter(event=>event.projectId===projectId).map(clone)}
  async queryProjectAuditEvents(projectId: string, query: import("../../contracts/src/api.js").ProjectAuditQuery) { const limit=Math.min(100,Math.max(1,query.limit??20)); const filtered=this.auditEvents.filter((event)=>event.projectId===projectId&&(!query.action||event.action===query.action)&&(!query.status||event.status===query.status)&&(!query.resourceKind||event.resourceKind===query.resourceKind)&&(!query.from||event.createdAt>=query.from)&&(!query.to||event.createdAt<=query.to)&&(!query.cursor||`${event.createdAt}|${event.id}`<query.cursor)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)); const items=filtered.slice(0,limit); return {items:items.map(clone),nextCursor:filtered.length>limit&&items.length?`${items.at(-1)!.createdAt}|${items.at(-1)!.id}`:null}; }
  async createProjectCredential(v:StoredProjectCredential): Promise<ProjectCredential> { this.credentials.set(v.id,clone(v)); return publicCredential(v); }
  async findProjectCredential(id:string): Promise<StoredProjectCredential | null> { return clone(this.credentials.get(id) ?? null); }
  async listProjectCredentials(id:string): Promise<ProjectCredential[]> { return [...this.credentials.values()].filter(v=>v.projectId===id).map(publicCredential); }
  async updateProjectCredential(v:StoredProjectCredential): Promise<ProjectCredential | null> { if(!this.credentials.has(v.id))return null; this.credentials.set(v.id,clone(v)); return publicCredential(v); }
  async deleteProjectCredential(id:string): Promise<boolean> { return this.credentials.delete(id); }
  async listLegacyEndpointCredentialAliases(): Promise<Array<{ endpointId: string; projectId: string; baseUrl: string; secretRef: string }>> { return []; }
  async bindEndpointCredential(endpointId:string, credentialId:string): Promise<boolean> { const endpoint=this.endpoints.get(endpointId); if(!endpoint) return false; this.endpoints.set(endpointId,{...endpoint,credentialId}); return true; }
  async createProjectContextEntry(v:ProjectContextEntry){this.contexts.set(v.id,clone(v));return clone(v)} async updateProjectContextEntry(v:ProjectContextEntry,expectedVersion:number){const current=this.contexts.get(v.id);if(!current||current.version!==expectedVersion)return null;this.contexts.set(v.id,clone(v));return clone(v)} async listProjectContextEntries(workspaceId:string,projectId:string|null,scope:ProjectContextEntry["scope"],ownerUserId:string|null){return [...this.contexts.values()].filter(v=>v.workspaceId===workspaceId&&v.projectId===projectId&&v.scope===scope&&v.ownerUserId===ownerUserId).map(clone)} async deleteProjectContextEntry(v:Pick<ProjectContextEntry,"id"|"workspaceId"|"projectId"|"scope"|"ownerUserId">){const current=this.contexts.get(v.id);if(!current||current.workspaceId!==v.workspaceId||current.projectId!==v.projectId||current.scope!==v.scope||current.ownerUserId!==v.ownerUserId)return false;return this.contexts.delete(v.id)}
  async createProjectAlertRule(v:ProjectAlertRule){this.alertRules.set(v.id,clone(v));return clone(v)} async listProjectAlertRules(id:string){return [...this.alertRules.values()].filter(v=>v.projectId===id).map(clone)} async updateProjectAlertRule(v:ProjectAlertRule){const current=this.alertRules.get(v.id);if(!current||current.projectId!==v.projectId)return null;this.alertRules.set(v.id,clone(v));return clone(v)} async deleteProjectAlertRule(projectId:string,id:string){const current=this.alertRules.get(id);if(!current||current.projectId!==projectId)return false;return this.alertRules.delete(id)}

  async createEndpoint(endpoint: ModelEndpoint): Promise<ModelEndpoint> {
    this.endpoints.set(endpoint.id, clone(endpoint));
    return clone(endpoint);
  }

  async updateEndpoint(endpoint: ModelEndpoint): Promise<ModelEndpoint | null> {
    if (!this.endpoints.has(endpoint.id)) {
      return null;
    }
    this.endpoints.set(endpoint.id, clone(endpoint));
    return clone(endpoint);
  }

  async deleteEndpoint(id: string): Promise<DeleteEndpointResult> {
    if (!this.endpoints.has(id)) return "not_found";
    if ([...this.tasks.values()].some((task) => task.endpointId === id)) return "referenced_by_tasks";

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
      if (rule.scope?.kind === "endpoint" && rule.scope.endpointId === id) this.alertRules.delete(ruleId);
    }
    for (const [alertId, alert] of this.alerts) {
      if (alert.endpointId === id) this.alerts.set(alertId, clone({ ...alert, endpointId: null }));
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
  async findProjectChatThread(id: string): Promise<ProjectChatThread | null> { return clone(this.chatThreads.get(id) ?? null); }
  async listProjectChatThreads(projectId: string): Promise<ProjectChatThread[]> { return this.sortedChatThreads(projectId); }
  async searchProjectChatThreads(projectId: string, query: string): Promise<ProjectChatThread[]> { const needle = query.trim().toLowerCase(); return this.sortedChatThreads(projectId).filter((thread) => !needle || (thread.title ?? "").toLowerCase().includes(needle)); }
  async updateProjectChatThreadMetadata(id: string, metadata: Pick<ProjectChatThread, "title" | "pinnedAt" | "starredAt">, updatedAt: string): Promise<ProjectChatThread | null> { const thread=this.chatThreads.get(id); if(!thread || thread.deletedAt) return null; const updated={...thread,title:metadata.title ?? null,pinnedAt:metadata.pinnedAt ?? null,starredAt:metadata.starredAt ?? null,updatedAt}; this.chatThreads.set(id,clone(updated)); return clone(updated); }
  async deleteProjectChatThread(id: string, deletedAt: string): Promise<ProjectChatThread | null> { const thread=this.chatThreads.get(id); if(!thread || thread.deletedAt) return null; const updated={...thread,deletedAt,updatedAt:deletedAt}; this.chatThreads.set(id,clone(updated)); return clone(updated); }
  async touchProjectChatThread(id: string, updatedAt: string): Promise<ProjectChatThread | null> { const thread = this.chatThreads.get(id); if (!thread) return null; const updated = { ...thread, updatedAt }; this.chatThreads.set(id, clone(updated)); return clone(updated); }
  async appendProjectChatMessages(messages: ProjectChatMessage[]): Promise<void> { this.chatMessages.push(...messages.map(clone)); }
  async listProjectChatMessages(threadId: string): Promise<ProjectChatMessage[]> { return this.chatMessages.filter((message) => message.threadId === threadId).sort((a,b)=>a.sequence-b.sequence).map(clone); }
  async updateProjectChatMessageDelivery(id: string, deliveryStatus: ProjectChatMessage["deliveryStatus"], updatedAt: string): Promise<ProjectChatMessage | null> { const index=this.chatMessages.findIndex((message)=>message.id===id);if(index<0)return null;const current=this.chatMessages[index]!;const updated={...current,deliveryStatus,updatedAt,version:current.version+1};this.chatMessages[index]=clone(updated);return clone(updated); }
  async stageProjectChatResponse(userMessageId:string,assistantMessage:ProjectChatMessage):Promise<boolean>{const index=this.chatMessages.findIndex((message)=>message.id===userMessageId&&message.role==="user");if(index<0)return false;const current=this.chatMessages[index]!;if(current.deliveryStatus==="completed")return this.chatMessages.some((message)=>message.id===assistantMessage.id);if(current.deliveryStatus==="response_pending"){return this.stagedChatResponses.get(userMessageId)?.id===assistantMessage.id;}this.stagedChatResponses.set(userMessageId,clone(assistantMessage));this.chatMessages[index]=clone({...current,deliveryStatus:"response_pending" as const,updatedAt:assistantMessage.updatedAt,version:current.version+1});return true;}
  async finalizeProjectChatResponse(userMessageId:string):Promise<ProjectChatMessage|null>{const index=this.chatMessages.findIndex((message)=>message.id===userMessageId&&message.role==="user");if(index<0)return null;const current=this.chatMessages[index]!;const staged=this.stagedChatResponses.get(userMessageId);if(!staged)return current.deliveryStatus==="completed"?clone(this.chatMessages.find((message)=>message.threadId===current.threadId&&message.sequence===current.sequence+1&&message.role==="assistant")??null):null;if(!this.chatMessages.some((message)=>message.id===staged.id))this.chatMessages.push(clone(staged));this.chatMessages[index]=clone({...current,deliveryStatus:"completed" as const,updatedAt:staged.updatedAt,version:current.version+1});return clone(staged);}
  async editProjectChatMessageAndTruncate(threadId:string,messageId:string,expectedVersion:number,content:string,updatedAt:string):Promise<ProjectChatMessage|null>{const index=this.chatMessages.findIndex((message)=>message.id===messageId&&message.threadId===threadId);if(index<0||this.chatMessages[index]!.version!==expectedVersion)return null;const target=this.chatMessages[index]!;const updated={...target,content,version:target.version+1,updatedAt};for(let cursor=this.chatMessages.length-1;cursor>=0;cursor--){const message=this.chatMessages[cursor]!;if(message.threadId===threadId&&message.sequence>target.sequence)this.chatMessages.splice(cursor,1);}this.chatMessages[index]=clone(updated);return clone(updated);}
  async deleteProjectChatMessageAndFollowing(threadId:string,messageId:string,expectedVersion:number):Promise<boolean>{const target=this.chatMessages.find((message)=>message.id===messageId&&message.threadId===threadId);if(!target||target.version!==expectedVersion)return false;for(let index=this.chatMessages.length-1;index>=0;index--){const message=this.chatMessages[index]!;if(message.threadId===threadId&&message.sequence>=target.sequence)this.chatMessages.splice(index,1);}return true;}

  async createTask(task: AgentTask): Promise<AgentTask> {
    this.tasks.set(task.id, clone(task));
    return clone(task);
  }

  async createTaskAtomically(input: AtomicTaskCreateInput): Promise<AgentTask | null> {
    if (this.tasks.has(input.task.id)) throw new Error("Task already exists");
    const task = normalizeStoredTask(input.task, input.reserveActive);
    if (input.reserveActive && !this.reserveActiveTask(task.projectId, task.updatedAt)) return null;
    this.tasks.set(task.id, clone(task));
    try {
      if (input.runtimeState) await this.jsonDocs.put("sandbox_runtime_state", task.id, input.runtimeState);
      if (input.sandboxRun) await this.sandboxRuns.put(input.sandboxRun);
      return clone(task);
    } catch (error) {
      this.tasks.delete(task.id);
      if (input.reserveActive) this.releaseActiveTask(task.projectId, task.updatedAt);
      await this.jsonDocs.delete("sandbox_runtime_state", task.id);
      if (input.sandboxRun) await this.jsonDocs.delete("sandbox_run_state", input.sandboxRun.runId);
      throw error;
    }
  }

  async createTaskWithActiveReservation(task: AgentTask): Promise<AgentTask | null> {
    return this.createTaskAtomically({ task, reserveActive: true });
  }

  async createTaskWithActiveReservationAndFollowUp(task: AgentTask, followUp: TaskFollowUp): Promise<AgentTask | null> {
    if (this.tasks.has(task.id) || this.followUps.some((value) => value.id === followUp.id)) {
      throw new Error("Task or follow-up already exists");
    }
    const policy = this.policies.get(task.projectId);
    const usage = this.usage.get(task.projectId);
    if (this.projects.get(task.projectId)?.lifecycleStatus === "deleting" || !policy || !usage || (policy.activeTasksLimit !== null && usage.activeTasks + 1 > policy.activeTasksLimit)) return null;
    const storedTask = normalizeStoredTask(task, true);
    this.tasks.set(task.id, clone(storedTask));
    this.followUps.push(clone(followUp));
    this.usage.set(task.projectId, clone({ ...usage, activeTasks: usage.activeTasks + 1, updatedAt: task.updatedAt }));
    return clone(storedTask);
  }

  async updateTask(task: AgentTask): Promise<AgentTask> {
    this.tasks.set(task.id, clone(task));
    return clone(task);
  }

  async updateTaskStatusIfStarting(taskId: string, status: AgentTask["status"], updatedAt: string): Promise<AgentTask | null> {
    const current = this.tasks.get(taskId);
    if (!current || current.status !== "starting") {
      return null;
    }
    const updated = { ...current, status, updatedAt };
    this.tasks.set(taskId, clone(updated));
    return clone(updated);
  }

  async updateTaskStatusIfNonterminal(taskId: string, status: AgentTask["status"], updatedAt: string): Promise<AgentTask | null> {
    const current = this.tasks.get(taskId);
    if (!current || !isActiveTaskStatus(current.status)) {
      return null;
    }
    const updated = { ...current, status, updatedAt };
    this.tasks.set(taskId, clone(updated));
    return clone(updated);
  }
  async listActiveTasks(): Promise<AgentTask[]> {
    return [...this.tasks.values()].filter((task) => isActiveTaskStatus(task.status)).map(clone);
  }

  async listTasksForProject(projectId: string): Promise<AgentTask[]> {
    return [...this.tasks.values()].filter((task) => task.projectId === projectId).map(clone);
  }

  async queryTasksForProject(projectId: string, query: TaskStoreListQuery): Promise<TaskStoreListPage> {
    const needle = query.search.trim().toLowerCase();
    const statuses = new Set(query.statuses);
    const filtered = [...this.tasks.values()].filter((task) =>
      task.projectId === projectId && !task.deletedAt &&
      (query.archived === "include" || (query.archived === "only" ? Boolean(task.archivedAt) : !task.archivedAt)) &&
      (statuses.size === 0 || statuses.has(task.status)) &&
      (!needle || `${task.title ?? ""}\n${task.prompt}`.toLowerCase().includes(needle))
    );
    const direction = query.direction === "asc" ? 1 : -1;
    const field = (task: AgentTask): string => query.sort === "created_at" ? task.createdAt
      : query.sort === "updated_at" ? task.updatedAt
      : query.sort === "status" ? task.status
      : task.title ?? "";
    filtered.sort((left, right) => direction * (field(left).localeCompare(field(right)) || left.id.localeCompare(right.id)));
    return { items: filtered.slice(query.offset, query.offset + query.limit).map(clone), total: filtered.length };
  }

  async findTask(id: string): Promise<AgentTask | null> {
    return clone(this.tasks.get(id) ?? null);
  }

  async updateTaskTitle(taskId: string, title: string, updatedAt: string): Promise<AgentTask | null> {
    const current = this.tasks.get(taskId);
    if (!current || current.deletedAt) return null;
    const updated = { ...current, title, updatedAt };
    this.tasks.set(taskId, clone(updated));
    return clone(updated);
  }

  async archiveTask(taskId: string, archivedAt: string): Promise<AgentTask | null> {
    const current = this.tasks.get(taskId);
    if (!current || current.deletedAt || !isTerminalTask(current)) return null;
    const updated = { ...current, archivedAt, updatedAt: archivedAt };
    this.tasks.set(taskId, clone(updated));
    return clone(updated);
  }

  async softDeleteTask(taskId: string, deletedAt: string): Promise<AgentTask | null> {
    const current = this.tasks.get(taskId);
    if (!current || current.deletedAt || !isTerminalTask(current)) return null;
    const updated = { ...current, deletedAt, updatedAt: deletedAt };
    this.tasks.set(taskId, clone(updated));
    return clone(updated);
  }

  async listTaskStartIntentsDue(now: string, limit: number): Promise<AgentTask[]> {
    return [...this.tasks.values()].filter((task) => !task.deletedAt && !task.terminalReason && (
      task.startIntentStatus === "pending" && (!task.startNextRetryAt || task.startNextRetryAt <= now) ||
      task.startIntentStatus === "dispatching" && Boolean(task.startLeaseExpiresAt && task.startLeaseExpiresAt <= now) && (!task.startNextRetryAt || task.startNextRetryAt <= now)
    )).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(0, limit).map(clone);
  }

  async claimTaskStart(input: TaskDeliveryClaimInput): Promise<AgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current || current.terminalReason || current.startIntentStatus !== "pending" || current.startClaimToken || (current.startNextRetryAt && current.startNextRetryAt > input.claimedAt)) return null;
    const updated: AgentTask = { ...current, startIntentStatus: "dispatching", startClaimToken: input.claimToken, startClaimedAt: input.claimedAt, startLeaseExpiresAt: input.leaseExpiresAt, startAttemptCount: (current.startAttemptCount ?? 0) + 1, startSafeError: null, updatedAt: input.claimedAt };
    this.tasks.set(input.id, clone(updated));
    return clone(updated);
  }

  async reclaimTaskStart(input: TaskDeliveryReclaimInput): Promise<AgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current || current.terminalReason || current.startIntentStatus !== "dispatching" || current.startClaimToken !== input.expectedClaimToken || !current.startLeaseExpiresAt || current.startLeaseExpiresAt > input.claimedAt || (current.startNextRetryAt && current.startNextRetryAt > input.claimedAt)) return null;
    const updated: AgentTask = { ...current, startClaimToken: input.claimToken, startClaimedAt: input.claimedAt, startLeaseExpiresAt: input.leaseExpiresAt, startAttemptCount: (current.startAttemptCount ?? 0) + 1, startSafeError: null, updatedAt: input.claimedAt };
    this.tasks.set(input.id, clone(updated));
    return clone(updated);
  }

  async recordTaskStartReceipt(input: TaskStartReceiptInput): Promise<AgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current || current.startIntentStatus !== "dispatching" || current.startClaimToken !== input.claimToken || current.startDeliveryKey !== input.receipt.deliveryKey || current.startRequestHash !== input.receipt.requestHash || !input.receipt.accepted) return null;
    const updated: AgentTask = { ...current, status: current.terminalReason ? current.status : "running", startIntentStatus: "dispatched", startReceipt: clone(input.receipt), startTimelineCursor: input.timelineCursor, startLeaseExpiresAt: null, startNextRetryAt: null, startSafeError: null, updatedAt: input.updatedAt };
    this.tasks.set(input.id, clone(updated));
    return clone(updated);
  }

  async deferTaskStart(input: TaskDeliveryDeferInput): Promise<AgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current || current.startIntentStatus !== "dispatching" || current.startClaimToken !== input.claimToken) return null;
    const updated: AgentTask = { ...current, startIntentStatus: input.releaseClaim ? "pending" : "dispatching", startClaimToken: input.releaseClaim ? null : current.startClaimToken ?? null, startClaimedAt: input.releaseClaim ? null : current.startClaimedAt ?? null, startLeaseExpiresAt: input.releaseClaim ? null : current.startLeaseExpiresAt ?? null, startSafeError: input.safeError, startNextRetryAt: input.nextRetryAt, updatedAt: input.updatedAt };
    this.tasks.set(input.id, clone(updated));
    return clone(updated);
  }

  async failTaskStart(input: TaskDeliveryFailureInput): Promise<AgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current || current.startIntentStatus !== "dispatching" || current.startClaimToken !== input.claimToken) return null;
    const updated: AgentTask = { ...current, startIntentStatus: "failed", startSafeError: input.safeError, startLeaseExpiresAt: null, updatedAt: input.updatedAt };
    this.tasks.set(input.id, clone(updated));
    return clone(updated);
  }

  async finalizeTaskLifecycle(input: FinalizeTaskLifecycleInput): Promise<FinalizeTaskLifecycleResult | null> {
    const current = this.tasks.get(input.taskId);
    if (!current) return null;
    if (current.terminalReason) return { task: clone(current), applied: false, successorTaskIds: [], missingPendingFollowUpIds: [] };
    const pending = this.followUps.filter((followUp) => followUp.taskId === current.id && !followUp.deletedAt && (followUp.deliveryStatus ?? "pending") === "pending");
    const successors = new Map(input.successors.map((candidate) => [candidate.followUpId, candidate]));
    const missingPendingFollowUpIds = pending.filter((followUp) => !successors.has(followUp.id)).map((followUp) => followUp.id);
    if (missingPendingFollowUpIds.length > 0) return { task: clone(current), applied: false, successorTaskIds: [], missingPendingFollowUpIds };

    if (current.activeReservation) this.releaseActiveTask(current.projectId, input.updatedAt);
    const terminal: AgentTask = {
      ...current,
      status: statusForTerminalReason(input.terminalReason),
      terminalReason: input.terminalReason,
      terminalizedAt: input.updatedAt,
      activeReservation: false,
      finalizationIntentStatus: null,
      finalizationIntentAt: null,
      artifactProjectionStatus: current.executionMode === "live" ? "draining" : "drained",
      artifactProjectionError: null,
      cleanupStatus: current.executionMode === "live" ? "pending" : "completed",
      cleanupError: null,
      cleanupCompletedAt: current.executionMode === "live" ? null : input.updatedAt,
      updatedAt: input.updatedAt
    };
    this.tasks.set(current.id, clone(terminal));

    const successorTaskIds: string[] = [];
    for (const followUp of pending) {
      const candidate = successors.get(followUp.id)!;
      const created = await this.createTaskAtomically(candidate.create);
      const index = this.followUps.findIndex((value) => value.id === followUp.id);
      if (created) {
        successorTaskIds.push(created.id);
        this.followUps[index] = clone({ ...followUp, followUpTaskId: created.id, deliveryStatus: "successor_created", safeError: null, updatedAt: input.updatedAt });
      } else {
        this.followUps[index] = clone({ ...followUp, deliveryStatus: "failed", safeError: "Project active tasks limit reached", updatedAt: input.updatedAt });
      }
    }
    for (let index = 0; index < this.followUps.length; index += 1) {
      const followUp = this.followUps[index]!;
      if (followUp.taskId === current.id && !followUp.deletedAt && followUp.deliveryStatus === "dispatching") {
        this.followUps[index] = clone({ ...followUp, deliveryStatus: "terminal_pending", updatedAt: input.updatedAt });
      }
    }
    if (!this.auditEvents.some((event) => event.id === input.auditEvent.id)) this.auditEvents.push(clone({...input.auditEvent,detail:sanitizeProjectAuditDetail(input.auditEvent.detail)}));
    return { task: clone(terminal), applied: true, successorTaskIds, missingPendingFollowUpIds: [] };
  }

  async listTasksForArtifactProjection(now: string, limit: number): Promise<AgentTask[]> {
    return [...this.tasks.values()].filter((task) => task.terminalReason && (task.artifactProjectionStatus === "draining" || task.artifactProjectionStatus === "failed") && (!task.artifactProjectionNextRetryAt || task.artifactProjectionNextRetryAt <= now) && (!task.artifactProjectionLeaseExpiresAt || task.artifactProjectionLeaseExpiresAt <= now)).slice(0, limit).map(clone);
  }

  async claimTaskArtifactProjection(input: TaskStageClaimInput): Promise<AgentTask | null> { return this.claimTaskStage("artifact", input); }
  async completeTaskArtifactProjection(input: TaskStageCompleteInput): Promise<AgentTask | null> { return this.completeTaskStage("artifact", input); }
  async failTaskArtifactProjection(input: TaskStageFailureInput): Promise<AgentTask | null> { return this.failTaskStage("artifact", input); }

  async listTasksForCleanup(now: string, limit: number): Promise<AgentTask[]> {
    return [...this.tasks.values()].filter((task) => task.terminalReason && task.artifactProjectionStatus === "drained" && (task.cleanupStatus === "pending" || task.cleanupStatus === "running" || task.cleanupStatus === "failed") && (!task.cleanupNextRetryAt || task.cleanupNextRetryAt <= now) && (!task.cleanupLeaseExpiresAt || task.cleanupLeaseExpiresAt <= now)).slice(0, limit).map(clone);
  }

  async claimTaskCleanup(input: TaskStageClaimInput): Promise<AgentTask | null> { return this.claimTaskStage("cleanup", input); }
  async completeTaskCleanup(input: TaskStageCompleteInput): Promise<AgentTask | null> {
    const completed = await this.completeTaskStage("cleanup", input);
    if (completed) {
      await this.jsonDocs.delete("sandbox_runtime_state", completed.id);
      await this.jsonDocs.delete("sandbox_run_state", completed.runId);
    }
    return completed;
  }
  async failTaskCleanup(input: TaskStageFailureInput): Promise<AgentTask | null> { return this.failTaskStage("cleanup", input); }

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
  async completeTaskIdempotencyForResource(resourceId:string,responseStatus:number,responseBody:unknown,updatedAt:string):Promise<number>{let completed=0;for(const [key,record] of this.taskIdempotency){if(record.resourceId!==resourceId||record.status!=="in_progress")continue;this.taskIdempotency.set(key,{...record,status:"completed",responseStatus,responseBody:clone(responseBody),updatedAt});completed+=1;}return completed;}

  async appendTaskEvents(events: AgentTaskEvent[]): Promise<void> {
    for (const event of events) {
      if (!this.events.some((existing) => existing.taskId === event.taskId && existing.cursor === event.cursor)) {
        this.events.push(clone(event));
      }
    }
  }

  async listTaskEvents(taskId: string): Promise<AgentTaskEvent[]> {
    return this.events.filter((event) => event.taskId === taskId).map(clone);
  }

  async listTaskEventsAfter(taskId: string, afterCursor: string | null, limit: number): Promise<{ items: AgentTaskEvent[]; nextCursor: string | null }> {
    const ordered = this.events.filter((event) => event.taskId === taskId).sort((left, right) => left.botifiedSeq - right.botifiedSeq || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const afterIndex = afterCursor === null ? -1 : ordered.findIndex((event) => event.cursor === afterCursor);
    const page = ordered.slice(afterIndex + 1, afterIndex + 1 + limit + 1);
    const items = page.slice(0, limit);
    return { items: items.map(clone), nextCursor: items.at(-1)?.cursor ?? afterCursor };
  }

  async appendTaskArtifacts(artifacts: AgentTaskArtifact[]): Promise<void> {
    for (const artifact of artifacts) {
      if (!this.artifacts.some((existing) => existing.taskId === artifact.taskId && existing.fileId === artifact.fileId)) {
        this.artifacts.push(clone(artifact));
      }
    }
  }

  async persistTaskArtifactProjection(input: PersistTaskArtifactProjectionInput): Promise<"created" | "existing" | "limit_exceeded"> {
    const task = this.tasks.get(input.artifact.taskId);
    if (!task || task.projectId !== input.projectId) throw new Error("Task artifact project mismatch");
    const existing = this.artifacts.find((artifact) => artifact.taskId === input.artifact.taskId && artifact.fileId === input.artifact.fileId);
    if (existing) {
      if (!this.auditEvents.some((event) => event.id === input.auditEvent.id)) this.auditEvents.push(clone({...input.auditEvent,detail:sanitizeProjectAuditDetail(input.auditEvent.detail)}));
      return "existing";
    }
    if (this.artifacts.some((artifact) => artifact.id === input.artifact.id)) throw new Error("Task artifact already exists");
    const policy = this.policies.get(input.projectId);
    const usage = this.usage.get(input.projectId);
    if (!policy || !usage) throw new Error("Project policy usage not found");
    if (policy.projectFileBytesLimit !== null && usage.projectFileBytes + input.artifact.bytes > policy.projectFileBytesLimit) return "limit_exceeded";
    this.artifacts.push(clone(input.artifact));
    this.usage.set(input.projectId, clone({ ...usage, projectFileBytes: usage.projectFileBytes + input.artifact.bytes, updatedAt: input.updatedAt }));
    if (!this.auditEvents.some((event) => event.id === input.auditEvent.id)) this.auditEvents.push(clone({...input.auditEvent,detail:sanitizeProjectAuditDetail(input.auditEvent.detail)}));
    return "created";
  }

  async listTaskArtifacts(taskId: string): Promise<AgentTaskArtifact[]> {
    return this.artifacts.filter((artifact) => artifact.taskId === taskId).map(clone);
  }
  async createTaskFollowUp(v: TaskFollowUp): Promise<TaskFollowUp> {
    if (this.followUps.some((value) => value.id === v.id)) throw new Error("Task follow-up already exists");
    const stored = normalizeStoredFollowUp(v);
    this.followUps.push(clone(stored));
    return clone(stored);
  }
  async createPendingTaskFollowUp(v:TaskFollowUp):Promise<TaskFollowUp|null>{const source=this.tasks.get(v.taskId);if(!source||isTerminalTask(source))return null;return this.createTaskFollowUp(v);}
  async listTaskFollowUps(taskId: string): Promise<TaskFollowUp[]> { return this.followUps.filter((value) => value.taskId === taskId && !value.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(clone); }
  async findTaskFollowUp(id: string): Promise<TaskFollowUp | null> { return clone(this.followUps.find((value) => value.id === id) ?? null); }
  async updatePendingTaskFollowUp(id: string, prompt: string, requestHash: string, updatedAt: string): Promise<TaskFollowUp | null> {
    const index = this.followUps.findIndex((value) => value.id === id);
    const current = this.followUps[index];
    if (!current || current.deletedAt || (current.deliveryStatus ?? "pending") !== "pending") return null;
    const updated = { ...current, prompt, requestHash, updatedAt };
    this.followUps[index] = clone(updated);
    return clone(updated);
  }
  async deletePendingTaskFollowUp(id: string, deletedAt: string): Promise<TaskFollowUp | null> {
    const index = this.followUps.findIndex((value) => value.id === id);
    const current = this.followUps[index];
    if (!current || current.deletedAt || (current.deliveryStatus ?? "pending") !== "pending") return null;
    const updated = { ...current, deletedAt, updatedAt: deletedAt };
    this.followUps[index] = clone(updated);
    return clone(updated);
  }
  async listTaskFollowUpsDue(now: string, limit: number): Promise<TaskFollowUp[]> {
    return this.followUps.filter((followUp) => !followUp.deletedAt && (
      (followUp.deliveryStatus ?? "pending") === "pending" && (!followUp.nextRetryAt || followUp.nextRetryAt <= now) ||
      (followUp.deliveryStatus === "dispatching" || followUp.deliveryStatus === "terminal_pending") && Boolean(followUp.leaseExpiresAt && followUp.leaseExpiresAt <= now) && (!followUp.nextRetryAt || followUp.nextRetryAt <= now)
    )).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(0, limit).map(clone);
  }
  async claimTaskFollowUp(input: TaskDeliveryClaimInput): Promise<TaskFollowUp | null> {
    const index = this.followUps.findIndex((value) => value.id === input.id);
    const current = this.followUps[index];
    const source=current?this.tasks.get(current.taskId):undefined;
    if (!current || !source || isTerminalTask(source) || current.deletedAt || (current.deliveryStatus ?? "pending") !== "pending" || current.claimToken || (current.nextRetryAt && current.nextRetryAt > input.claimedAt)) return null;
    const updated: TaskFollowUp = { ...current, deliveryStatus: "dispatching", claimToken: input.claimToken, claimedAt: input.claimedAt, leaseExpiresAt: input.leaseExpiresAt, attemptCount: (current.attemptCount ?? 0) + 1, safeError: null, updatedAt: input.claimedAt };
    this.followUps[index] = clone(updated);
    return clone(updated);
  }
  async reclaimTaskFollowUp(input: TaskDeliveryReclaimInput): Promise<TaskFollowUp | null> {
    const index = this.followUps.findIndex((value) => value.id === input.id);
    const current = this.followUps[index];
    const source = current ? this.tasks.get(current.taskId) : undefined;
    if (!current || !source || isTerminalTask(source) || current.deletedAt || current.deliveryStatus !== "dispatching" || current.claimToken !== input.expectedClaimToken || !current.leaseExpiresAt || current.leaseExpiresAt > input.claimedAt || (current.nextRetryAt && current.nextRetryAt > input.claimedAt)) return null;
    const updated: TaskFollowUp = { ...current, claimToken: input.claimToken, claimedAt: input.claimedAt, leaseExpiresAt: input.leaseExpiresAt, attemptCount: (current.attemptCount ?? 0) + 1, safeError: null, updatedAt: input.claimedAt };
    this.followUps[index] = clone(updated);
    return clone(updated);
  }
  async recordTaskFollowUpReceipt(input: TaskFollowUpReceiptInput): Promise<TaskFollowUp | null> {
    const index = this.followUps.findIndex((value) => value.id === input.id);
    const current = this.followUps[index];
    if (!current || current.deletedAt || !["dispatching", "terminal_pending"].includes(current.deliveryStatus ?? "") || current.claimToken !== input.claimToken || current.deliveryKey !== input.receipt.deliveryKey || current.requestHash !== input.receipt.requestHash || !input.receipt.accepted || current.deliveryStatus === "successor_created") return null;
    const updated: TaskFollowUp = { ...current, receipt: clone(input.receipt), timelineCursor: input.timelineCursor, deliveryStatus: "accepted", leaseExpiresAt: null, nextRetryAt: null, safeError: null, updatedAt: input.updatedAt };
    this.followUps[index] = clone(updated);
    return clone(updated);
  }
  async deferTaskFollowUp(input: TaskDeliveryDeferInput): Promise<TaskFollowUp | null> {
    const index = this.followUps.findIndex((value) => value.id === input.id);
    const current = this.followUps[index];
    if (!current || current.deletedAt || !["dispatching", "terminal_pending"].includes(current.deliveryStatus ?? "") || current.claimToken !== input.claimToken) return null;
    const updated: TaskFollowUp = { ...current, deliveryStatus: input.releaseClaim ? "pending" : current.deliveryStatus ?? "dispatching", claimToken: input.releaseClaim ? null : current.claimToken ?? null, claimedAt: input.releaseClaim ? null : current.claimedAt ?? null, leaseExpiresAt: input.releaseClaim ? null : current.leaseExpiresAt ?? null, safeError: input.safeError, nextRetryAt: input.nextRetryAt, updatedAt: input.updatedAt };
    this.followUps[index] = clone(updated);
    return clone(updated);
  }
  async failTaskFollowUp(input: TaskDeliveryFailureInput): Promise<TaskFollowUp | null> {
    const index = this.followUps.findIndex((value) => value.id === input.id);
    const current = this.followUps[index];
    if (!current || current.deletedAt || current.deliveryStatus !== "dispatching" || current.claimToken !== input.claimToken) return null;
    const updated: TaskFollowUp = { ...current, deliveryStatus: "failed", safeError: input.safeError, leaseExpiresAt: null, updatedAt: input.updatedAt };
    this.followUps[index] = clone(updated);
    return clone(updated);
  }
  async createTerminalTaskFollowUp(input: CreateTerminalTaskFollowUpInput): Promise<TaskFollowUp | null> {
    const source = this.tasks.get(input.followUp.taskId);
    if (!source || !source.terminalReason || this.followUps.some((value) => value.id === input.followUp.id)) return null;
    const successor = await this.createTaskAtomically(input.successor);
    if (!successor) return null;
    const followUp = normalizeStoredFollowUp({ ...input.followUp, followUpTaskId: successor.id, deliveryStatus: "successor_created" });
    this.followUps.push(clone(followUp));
    return clone(followUp);
  }
  async resolveTerminalPendingFollowUp(input: ResolveTerminalPendingFollowUpInput): Promise<TaskFollowUp | null> {
    const index = this.followUps.findIndex((value) => value.id === input.followUpId);
    const current = this.followUps[index];
    const source = current ? this.tasks.get(current.taskId) : undefined;
    if (!current || !source?.terminalReason || !["dispatching","terminal_pending"].includes(current.deliveryStatus ?? "") || current.claimToken !== input.expectedClaimToken || current.receipt?.accepted) return null;
    const successor = await this.createTaskAtomically(input.successor);
    if (!successor) return null;
    const updated: TaskFollowUp = { ...current, followUpTaskId: successor.id, deliveryStatus: "successor_created", leaseExpiresAt: null, nextRetryAt: null, safeError: null, updatedAt: input.updatedAt };
    this.followUps[index] = clone(updated);
    return clone(updated);
  }
  async findTaskSummary(taskId: string): Promise<TaskSummary | null> { const task=this.tasks.get(taskId); return task ? this.taskSummary(task) : null; }
  async listTaskSummariesForProject(projectId: string): Promise<TaskSummary[]> { return [...this.tasks.values()].filter((task) => task.projectId === projectId && !task.deletedAt).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).map((task) => this.taskSummary(task)); }

  private sortedChatThreads(projectId: string): ProjectChatThread[] { return [...this.chatThreads.values()].filter((thread) => thread.projectId === projectId && !thread.deletedAt).sort((left, right) => Number(Boolean(right.starredAt)) - Number(Boolean(left.starredAt)) || (right.starredAt ?? "").localeCompare(left.starredAt ?? "") || Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt)) || (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "") || right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)).map(clone); }
  private taskSummary(task: AgentTask): TaskSummary { return { taskId: task.id, eventCount: this.events.filter((event) => event.taskId === task.id).length, artifactCount: this.artifacts.filter((artifact) => artifact.taskId === task.id).length, updatedAt: task.updatedAt }; }

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

  private async claimTaskStage(stage: "artifact" | "cleanup", input: TaskStageClaimInput): Promise<AgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current?.terminalReason) return null;
    if (stage === "artifact") {
      if (!["draining", "failed"].includes(current.artifactProjectionStatus ?? "") || current.artifactProjectionLeaseExpiresAt && current.artifactProjectionLeaseExpiresAt > input.claimedAt || current.artifactProjectionNextRetryAt && current.artifactProjectionNextRetryAt > input.claimedAt) return null;
      const updated: AgentTask = { ...current, artifactProjectionStatus: "draining", artifactProjectionClaimToken: input.claimToken, artifactProjectionLeaseExpiresAt: input.leaseExpiresAt, artifactProjectionAttemptCount: (current.artifactProjectionAttemptCount ?? 0) + 1, artifactProjectionError: null, updatedAt: input.claimedAt };
      this.tasks.set(input.id, clone(updated)); return clone(updated);
    }
    if (current.artifactProjectionStatus !== "drained" || !["pending", "running", "failed"].includes(current.cleanupStatus ?? "") || current.cleanupLeaseExpiresAt && current.cleanupLeaseExpiresAt > input.claimedAt || current.cleanupNextRetryAt && current.cleanupNextRetryAt > input.claimedAt) return null;
    const updated: AgentTask = { ...current, cleanupStatus: "running", cleanupClaimToken: input.claimToken, cleanupLeaseExpiresAt: input.leaseExpiresAt, cleanupAttemptCount: (current.cleanupAttemptCount ?? 0) + 1, cleanupError: null, updatedAt: input.claimedAt };
    this.tasks.set(input.id, clone(updated)); return clone(updated);
  }

  private async completeTaskStage(stage: "artifact" | "cleanup", input: TaskStageCompleteInput): Promise<AgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current) return null;
    if (stage === "artifact") {
      if (current.artifactProjectionStatus !== "draining" || current.artifactProjectionClaimToken !== input.claimToken) return null;
      const updated: AgentTask = { ...current, artifactProjectionStatus: "drained", artifactProjectionClaimToken: null, artifactProjectionLeaseExpiresAt: null, artifactProjectionNextRetryAt: null, artifactProjectionError: null, updatedAt: input.updatedAt };
      this.tasks.set(input.id, clone(updated)); return clone(updated);
    }
    if (current.cleanupStatus !== "running" || current.cleanupClaimToken !== input.claimToken) return null;
    const updated: AgentTask = { ...current, cleanupStatus: "completed", cleanupClaimToken: null, cleanupLeaseExpiresAt: null, cleanupNextRetryAt: null, cleanupError: null, cleanupCompletedAt: input.updatedAt, updatedAt: input.updatedAt };
    this.tasks.set(input.id, clone(updated)); return clone(updated);
  }

  private async failTaskStage(stage: "artifact" | "cleanup", input: TaskStageFailureInput): Promise<AgentTask | null> {
    const current = this.tasks.get(input.id);
    if (!current) return null;
    if (stage === "artifact") {
      if (current.artifactProjectionStatus !== "draining" || current.artifactProjectionClaimToken !== input.claimToken) return null;
      const updated: AgentTask = { ...current, artifactProjectionStatus: "failed", artifactProjectionClaimToken: null, artifactProjectionLeaseExpiresAt: null, artifactProjectionNextRetryAt: input.nextRetryAt, artifactProjectionError: input.safeError, updatedAt: input.updatedAt };
      this.tasks.set(input.id, clone(updated)); return clone(updated);
    }
    if (current.cleanupStatus !== "running" || current.cleanupClaimToken !== input.claimToken) return null;
    const updated: AgentTask = { ...current, cleanupStatus: "failed", cleanupClaimToken: null, cleanupLeaseExpiresAt: null, cleanupNextRetryAt: input.nextRetryAt, cleanupError: input.safeError, updatedAt: input.updatedAt };
    this.tasks.set(input.id, clone(updated)); return clone(updated);
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
}

class InMemorySandboxRunStore {
  constructor(private readonly jsonDocs: PostgresJsonDocStore) {}

  async put(run: PersistedSandboxRunState): Promise<PersistedSandboxRunState> {
    const document = prepareSandboxRunDocument(run);
    await this.jsonDocs.put("sandbox_run_state", run.runId, document);
    return sandboxRunFromDocument(document);
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

  async updateWithFencing(
    runId: string,
    expectedFencingToken: number,
    run: PersistedSandboxRunState
  ): Promise<PersistedSandboxRunState | null> {
    const current = await this.get(runId);
    if (!current || current.fencingToken !== expectedFencingToken) {
      return null;
    }
    return this.put(run);
  }
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

function isTerminalTask(task: AgentTask): boolean {
  return Boolean(task.terminalReason) || task.status === "completed" || task.status === "failed" || task.status === "expired" || task.status === "cancelled" || task.status === "cleaned";
}

function statusForTerminalReason(reason: import("../../contracts/src/api.js").TaskTerminalReason): AgentTask["status"] {
  if (reason === "cancelled") return "cancelled";
  if (reason === "failed") return "failed";
  if (reason === "expired") return "expired";
  if (reason === "cleaned_legacy") return "cleaned";
  return "completed";
}

function normalizeStoredTask(task: AgentTask, activeReservation: boolean): AgentTask {
  return {
    ...clone(task),
    title: task.title ?? task.prompt.replace(/[\r\n]+/g, " ").slice(0, 160),
    inputPaths: [...(task.inputPaths ?? [])],
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

function normalizeStoredFollowUp(followUp: TaskFollowUp): TaskFollowUp {
  return {
    ...clone(followUp),
    followUpTaskId: followUp.followUpTaskId ?? null,
    deliveryKey: followUp.deliveryKey ?? null,
    requestHash: followUp.requestHash ?? null,
    claimToken: followUp.claimToken ?? null,
    receipt: followUp.receipt ?? null,
    timelineCursor: followUp.timelineCursor ?? null,
    deliveryStatus: followUp.deliveryStatus ?? "pending",
    claimedAt: followUp.claimedAt ?? null,
    leaseExpiresAt: followUp.leaseExpiresAt ?? null,
    attemptCount: followUp.attemptCount ?? 0,
    nextRetryAt: followUp.nextRetryAt ?? null,
    safeError: followUp.safeError ?? null,
    updatedAt: followUp.updatedAt ?? followUp.createdAt,
    deletedAt: followUp.deletedAt ?? null
  };
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
