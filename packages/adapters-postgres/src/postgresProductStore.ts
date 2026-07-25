import { createRequire } from "node:module";
import type {
  AgentTask,
  TaskInteractionItem,
  AuthSession,
  EndpointHealth,
  FileLibrary,
  EndpointCapability,
  EndpointProtocol,
  ModelEndpoint,
  ManagedProjectMembershipRole,
  Project,
  ProjectMembership, ProjectMembershipView,
  ActiveProjectAlert,
  AlertRuleCondition,
  AlertRuleMetric,
  AlertRuleScope,
  ProjectAlert,
  ProjectAlertStatus,
  ProjectAlertType,
  ProjectAuditEvent,
  ProjectResourcePolicy,
  ProjectResourceUsage,
  ProviderUsage,
  ProjectProviderSettlement,
  StoredUser,
  UpdateProjectResourcePolicyInput,
  User,
  Workspace, ManagedWorkspaceMembershipRole, WorkspaceMembership, WorkspaceMembershipView, WorkspaceListProjection, WorkspaceDirectoryItem, ProjectDirectoryItem, UserProfilePreferences, ProfileGreetingPreference, ProjectContextEntry, UserNotification, ProjectAlertRule, ProjectCredential, StoredProjectCredential, TaskPresentation
} from "../../contracts/src/api.js";
import { PREVIEW_IMAGE_MEDIA_TYPES, PREVIEW_TEXT_MEDIA_TYPES, PROFILE_GREETING_PREFERENCES, isActiveProjectAlert, sandboxCapacityErrorEnvelope, sanitizeProjectAuditDetail } from "../../contracts/src/api.js";
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
  AtomicTaskCreateResult,
  AtomicTaskSandboxRestartInput,
  AtomicTaskSandboxRestartResult,
  AtomicTaskMessageInput,
  AtomicTaskMessageResult,
  AtomicTaskMessageEditInput,
  AtomicTaskMessageEditResult,
  AtomicTaskMessageDeleteInput,
  AtomicTaskMessageDeleteResult,
  SandboxAdmissionInput,
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
  TaskIdempotencyBeginResult,
  CompleteTaskIdempotencyInput,
  CompleteTaskIdempotencyForResourceInput,
  TaskIdempotencyLookupInput,
  TaskIdempotencyResourceLookupInput,
  TaskSandboxReleaseMutationInput,
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
  RevokeWorkspaceMembershipResult,
  CreateWorkspaceMembershipResult,
  CreateProjectMembershipResult,
  PersistedAgentTask,
  PersistedTaskArtifact,
  PersistedTaskMessage,
  PersistTaskInteractionMutationInput,
  PersistTaskInteractionMutationResult,
  PersistedTaskInteractionChange,
  MembershipDirectoryStoreQuery,
  ProjectMembershipCandidateStoreQuery,
  ProjectMembershipCandidateStoreItem,
  TaskInteractionChangeInput,
  TaskInteractionCorrelation,
  TaskInteractionPageAnchor,
  TaskInteractionStoreSnapshot
} from "../../ports/src/store.js";
import type { Pool as PgPool, PoolClient } from "pg";

const { Pool } = createRequire(import.meta.url)("pg") as typeof import("pg");

export function createPostgresProductStore(connectionString: string): PostgresProductStore {
  return new PostgresProductStore(connectionString);
}

export class PostgresProductStore implements ProductStore {
  readonly observedExternalModelCalls = 0;
  readonly jsonDocs: PostgresJsonDocStore;
  readonly leases: PostgresLeaseStore;
  readonly sandboxRuns: SandboxRunStore;

  private readonly pool: PgPool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.jsonDocs = new PostgresJsonDocStoreImpl(this.pool);
    this.leases = new PostgresLeaseStoreImpl(this.pool);
    this.sandboxRuns = new PostgresSandboxRunStoreImpl(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async countUsers(): Promise<number> {
    const rows = await this.queryRows<{ count: string }>("select count(*)::text as count from users");
    return Number(rows[0]?.count ?? 0);
  }

  async createUser(user: StoredUser): Promise<User> {
    await this.pool.query(
      `insert into users (id, email, oidc_issuer, oidc_subject, picture_url, email_verified, password_hash, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [user.id, user.email, user.oidcIssuer ?? null, user.oidcSubject ?? null, user.pictureUrl ?? null, user.emailVerified, user.passwordHash, user.createdAt, user.updatedAt]
    );
    return publicUser(user);
  }

  async updateUser(user: StoredUser): Promise<User> {
    await this.pool.query(
      `update users
          set email = $2,
              oidc_issuer = $3,
              oidc_subject = $4,
              picture_url = $5,
              email_verified = $6,
              password_hash = $7,
              created_at = $8,
              updated_at = $9
        where id = $1`,
      [user.id, user.email, user.oidcIssuer ?? null, user.oidcSubject ?? null, user.pictureUrl ?? null, user.emailVerified, user.passwordHash, user.createdAt, user.updatedAt]
    );
    return publicUser(user);
  }

  async bindLegacyExternalIdentity(input: LegacyExternalIdentityBinding): Promise<StoredUser | null> {
    const rows = await this.queryRows<UserRow>(
      `update users
          set oidc_issuer = $2,
              oidc_subject = $3,
              email = $4,
              email_verified = true,
              updated_at = $5
        where id = $1
          and oidc_issuer is null
          and oidc_subject is null
          and lower(email) = lower($4)
      returning *`,
      [input.userId, input.issuer, input.subject, input.email, input.updatedAt]
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const rows = await this.queryRows<UserRow>(
      `select * from users where lower(email) = lower($1) limit 1`,
      [email]
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async findUserById(id: string): Promise<StoredUser | null> {
    const rows = await this.queryRows<UserRow>("select * from users where id = $1", [id]);
    return rows[0] ? mapUser(rows[0]) : null;
  }
  async findUserProfilePreferences(userId: string): Promise<UserProfilePreferences | null> { const rows=await this.queryRows<ProfileRow>('select * from user_profile_preferences where user_id=$1',[userId]); return rows[0]?mapProfile(rows[0]):null; }
  async upsertUserProfilePreferences(value: UserProfilePreferences, expectedUpdatedAt: string | null): Promise<UserProfilePreferences | null> { const values=[value.userId,value.displayName,value.timezone,value.bio,value.jobTitle,value.company,value.greetingPreference,value.interests,value.updatedAt];const rows=expectedUpdatedAt===null?await this.queryRows<ProfileRow>('insert into user_profile_preferences (user_id,display_name,timezone,bio,job_title,company,greeting_preference,interests,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (user_id) do nothing returning *',values):await this.queryRows<ProfileRow>('update user_profile_preferences set display_name=$2,timezone=$3,bio=$4,job_title=$5,company=$6,greeting_preference=$7,interests=$8,updated_at=$9 where user_id=$1 and updated_at=$10 returning *',[...values,expectedUpdatedAt]);return rows[0]?mapProfile(rows[0]):null; }
  async createUserNotification(v:UserNotification,dedupeKey?:string){return transaction(this.pool,async client=>{await client.query('select id from users where id=$1 for update',[v.userId]);const r=await client.query<NotificationRow>('insert into user_notifications (id,user_id,type,title,body,project_id,resource_kind,resource_id,link_path,read_at,created_at,dedupe_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (dedupe_key) do update set dedupe_key=user_notifications.dedupe_key returning *',[v.id,v.userId,v.type,v.title,v.body,v.projectId,v.resourceKind,v.resourceId,v.linkPath,v.readAt,v.createdAt,dedupeKey??null]);await client.query('delete from user_notifications where id in (select id from user_notifications where user_id=$1 order by created_at desc,id desc offset $2)',[v.userId,USER_NOTIFICATION_INBOX_LIMIT]);return mapNotification(r.rows[0]!)})} async listUserNotifications(userId:string,unreadOnly=false){const r=await this.queryRows<NotificationRow>(`select n.* from user_notifications n where n.user_id=$1 and (n.project_id is null or exists (select 1 from project_memberships pm where pm.project_id=n.project_id and pm.user_id=n.user_id)) ${unreadOnly?'and n.read_at is null':''} order by n.created_at desc,n.id desc limit $2`,[userId,USER_NOTIFICATION_INBOX_LIMIT]);return r.map(mapNotification)} async markUserNotificationRead(id:string,userId:string,readAt:string){const r=await this.queryRows<NotificationRow>('update user_notifications n set read_at=$3 where n.id=$1 and n.user_id=$2 and (n.project_id is null or exists (select 1 from project_memberships pm where pm.project_id=n.project_id and pm.user_id=n.user_id)) returning n.*',[id,userId,readAt]);return r[0]?mapNotification(r[0]):null} async markAllUserNotificationsRead(userId:string,readAt:string){return (await this.pool.query('update user_notifications n set read_at=$2 where n.user_id=$1 and n.read_at is null and (n.project_id is null or exists (select 1 from project_memberships pm where pm.project_id=n.project_id and pm.user_id=n.user_id))',[userId,readAt])).rowCount??0} async dismissUserNotification(id:string,userId:string){return (await this.pool.query('delete from user_notifications n where n.id=$1 and n.user_id=$2 and (n.project_id is null or exists (select 1 from project_memberships pm where pm.project_id=n.project_id and pm.user_id=n.user_id))',[id,userId])).rowCount===1}

  async findVerifiedUserByEmail(email: string): Promise<StoredUser | null> {
    const rows = await this.queryRows<UserRow>(
      `select * from users where lower(email) = lower($1) and email_verified = true limit 1`,
      [email]
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async findUserByOidcSubject(issuer: string, subject: string): Promise<StoredUser | null> {
    const rows = await this.queryRows<UserRow>(
      `select * from users where oidc_issuer = $1 and oidc_subject = $2 limit 1`,
      [issuer, subject]
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async createSession(session: AuthSession): Promise<AuthSession> {
    await this.pool.query(
      `insert into auth_sessions (id, user_id, csrf_token, oidc_id_token, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [session.id, session.userId, session.csrfToken, session.oidcIdToken ?? null, session.createdAt, session.expiresAt]
    );
    return structuredClone(session);
  }

  async findSession(id: string): Promise<AuthSession | null> {
    const rows = await this.queryRows<AuthSessionRow>("select * from auth_sessions where id = $1", [id]);
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async deleteSession(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from auth_sessions where id = $1", [id]);
    return result.rowCount === 1;
  }

  async deleteExpiredSessions(now: string): Promise<number> {
    const result = await this.pool.query("delete from auth_sessions where expires_at <= $1", [now]);
    return result.rowCount ?? 0;
  }

  async createWorkspace(workspace: Workspace): Promise<Workspace> {
    await transaction(this.pool, async (client) => {
      await client.query(`insert into workspaces (id, name, owner_user_id, created_at, updated_at) values ($1, $2, $3, $4, $5)`, [workspace.id, workspace.name, workspace.ownerUserId, workspace.createdAt, workspace.updatedAt]);
      await client.query(`insert into workspace_memberships (workspace_id, user_id, role, created_at, updated_at) values ($1, $2, 'owner', $3, $4)`, [workspace.id, workspace.ownerUserId, workspace.createdAt, workspace.updatedAt]);
    });
    return structuredClone(workspace);
  }

  async listWorkspaceDirectoryPage(query: import("../../ports/src/store.js").WorkspaceDirectoryStoreQuery): Promise<WorkspaceDirectoryItem[]> {
    const values: unknown[] = [query.userId];
    const after = query.after
      ? `and (w.created_at > $2 or (w.created_at = $2 and w.id collate "C" > $3 collate "C"))`
      : "";
    if (query.after) values.push(query.after.createdAt, query.after.id);
    values.push(query.limit);
    const limitParameter = `$${values.length}`;
    const rows = await this.queryRows<WorkspaceRow & { project_count: string | number }>(
      `select w.*, viewer.role as member_role, owner.email as owner_email, owner_profile.display_name as owner_display_name,
        (select count(*) from projects p join project_memberships pm on pm.project_id=p.id and pm.user_id=$1 where p.workspace_id=w.id) as project_count
       from workspaces w
       join workspace_memberships viewer on viewer.workspace_id=w.id and viewer.user_id=$1
       join users owner on owner.id=w.owner_user_id
       left join user_profile_preferences owner_profile on owner_profile.user_id=owner.id
       where true ${after}
       order by w.created_at, w.id collate "C"
       limit ${limitParameter}`,
      values
    );
    return rows.map((row) => ({ ...mapWorkspaceListProjection(row), projectCount: Number(row.project_count) }));
  }

  async countProjectsForUserInWorkspace(userId: string, workspaceId: string): Promise<number> {
    const rows = await this.queryRows<{ count: string }>(
      `select count(*)::text as count
       from projects p
       join project_memberships pm on pm.project_id=p.id and pm.user_id=$1
       where p.workspace_id=$2`,
      [userId, workspaceId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  async findWorkspace(id: string): Promise<Workspace | null> {
    const rows = await this.queryRows<WorkspaceRow>("select * from workspaces where id = $1", [id]);
    return rows[0] ? mapWorkspace(rows[0]) : null;
  }
  async updateWorkspaceName(workspaceId:string,name:string,updatedAt:string,expectedName:string):Promise<Workspace|null>{const rows=await this.queryRows<WorkspaceRow>("update workspaces set name=$2,updated_at=$3 where id=$1 and lifecycle_status='active' and name=$4 returning *",[workspaceId,name,updatedAt,expectedName]);return rows[0]?mapWorkspace(rows[0]):null}
  async beginWorkspaceDeletion(id:string,updatedAt:string,expectedOwnerUserId?:string){return transaction(this.pool,async(client)=>{const locked=await client.query<WorkspaceRow>("select * from workspaces where id=$1 for update",[id]);const workspace=locked.rows[0];if(!workspace||expectedOwnerUserId!==undefined&&workspace.owner_user_id!==expectedOwnerUserId)return{kind:"not_found_or_forbidden" as const};await client.query("select id from projects where workspace_id=$1 for update",[id]);const blocked=await client.query(`select 1 from sandbox_runs where workspace_id=$1 and state<>'released' union all select 1 from project_provider_settlements settlement join projects project on project.id=settlement.project_id where project.workspace_id=$1 and settlement.status in ('reserved','dispatched','delivered') limit 1`,[id]);if(blocked.rowCount){if(workspace.lifecycle_status==="deleting"){await client.query("update workspaces set lifecycle_status='active',updated_at=$2 where id=$1",[id,updatedAt]);await client.query("update projects set lifecycle_status='active',updated_at=$2 where workspace_id=$1 and lifecycle_status='deleting'",[id,updatedAt]);}return{kind:"sandbox_not_released" as const};}if(workspace.lifecycle_status==="deleting")return{kind:"ready" as const,value:mapWorkspace(workspace)};const updated=await client.query<WorkspaceRow>("update workspaces set lifecycle_status='deleting',updated_at=$2 where id=$1 returning *",[id,updatedAt]);await client.query("update projects set lifecycle_status='deleting',updated_at=$2 where workspace_id=$1",[id,updatedAt]);return{kind:"ready" as const,value:mapWorkspace(updated.rows[0]!)}})}
  async setWorkspaceLifecycleStatus(id:string,status:"active"|"archived",updatedAt:string):Promise<Workspace|null>{const rows=await this.queryRows<WorkspaceRow>("update workspaces set lifecycle_status=$2,updated_at=$3 where id=$1 and lifecycle_status <> 'deleting' returning *",[id,status,updatedAt]);return rows[0]?mapWorkspace(rows[0]):null}
  async transferWorkspaceOwner(workspaceId:string,fromUserId:string,toUserId:string,updatedAt:string):Promise<Workspace|null>{return transaction(this.pool,async(client)=>{if(fromUserId===toUserId)return null;const target=await client.query("select 1 from workspace_memberships where workspace_id=$1 and user_id=$2 for update",[workspaceId,toUserId]);if(!target.rowCount)return null;const workspace=await client.query<WorkspaceRow>("update workspaces set owner_user_id=$3,updated_at=$4 where id=$1 and owner_user_id=$2 and lifecycle_status='active' returning *",[workspaceId,fromUserId,toUserId,updatedAt]);if(!workspace.rows[0])return null;await client.query("update workspace_memberships set role='admin',updated_at=$3 where workspace_id=$1 and user_id=$2",[workspaceId,fromUserId,updatedAt]);await client.query("update workspace_memberships set role='owner',updated_at=$3 where workspace_id=$1 and user_id=$2",[workspaceId,toUserId,updatedAt]);return mapWorkspace(workspace.rows[0])})}
  async deleteWorkspaceAfterProjects(id:string):Promise<boolean>{return transaction(this.pool,async(client)=>{const ready=await client.query("select 1 from workspaces where id=$1 and lifecycle_status='deleting' and not exists (select 1 from projects where workspace_id=$1) for update",[id]);if(ready.rowCount!==1)return false;await client.query("delete from project_context_entries where workspace_id=$1",[id]);return (await client.query("delete from workspaces where id=$1 and lifecycle_status='deleting'",[id])).rowCount===1})}
  async findWorkspaceMembership(workspaceId:string,userId:string):Promise<WorkspaceMembership|null>{const rows=await this.queryRows<WorkspaceMembershipRow>("select * from workspace_memberships where workspace_id=$1 and user_id=$2",[workspaceId,userId]);return rows[0]?mapWorkspaceMembership(rows[0]):null}
  async findWorkspaceMembershipView(workspaceId:string,userId:string):Promise<WorkspaceMembershipView|null>{const rows=await this.queryRows<WorkspaceMembershipRow>("select wm.*,u.email,p.display_name from workspace_memberships wm join users u on u.id=wm.user_id left join user_profile_preferences p on p.user_id=u.id where wm.workspace_id=$1 and wm.user_id=$2",[workspaceId,userId]);return rows[0]?mapWorkspaceMembershipView(rows[0]):null}
  async listWorkspaceMembershipDirectoryPage(workspaceId:string,query:MembershipDirectoryStoreQuery<WorkspaceMembership["role"]>):Promise<WorkspaceMembershipView[]>{
    const values:unknown[]=[workspaceId],where=["wm.workspace_id=$1"];
    if(query.q){values.push(query.q);const q=`$${values.length}`;where.push(`(position(${q} in lower(coalesce(p.display_name,'')))>0 or position(${q} in lower(u.email))>0 or position(${q} in lower(wm.user_id))>0)`)}
    if(query.role){values.push(query.role);where.push(`wm.role=$${values.length}`)}
    if(query.after){values.push(query.after.createdAt,query.after.userId);const created=`$${values.length-1}`,userId=`$${values.length}`;where.push(`(wm.created_at>${created} or (wm.created_at=${created} and wm.user_id collate "C">${userId} collate "C"))`)}
    values.push(query.limit);
    return(await this.queryRows<WorkspaceMembershipRow>(`select wm.*,u.email,p.display_name from workspace_memberships wm join users u on u.id=wm.user_id left join user_profile_preferences p on p.user_id=u.id where ${where.join(" and ")} order by wm.created_at,wm.user_id collate "C" limit $${values.length}`,values)).map(mapWorkspaceMembershipView);
  }
  async upsertWorkspaceMembership(value:WorkspaceMembership):Promise<WorkspaceMembership>{const rows=await this.queryRows<WorkspaceMembershipRow>("insert into workspace_memberships (workspace_id,user_id,role,created_at,updated_at) values ($1,$2,$3,$4,$5) on conflict (workspace_id,user_id) do update set role=excluded.role,updated_at=excluded.updated_at returning *",[value.workspaceId,value.userId,value.role,value.createdAt,value.updatedAt]);return mapWorkspaceMembership(rows[0]!)}
  async createWorkspaceMembership(value:WorkspaceMembership):Promise<CreateWorkspaceMembershipResult>{const rows=await this.queryRows<WorkspaceMembershipRow>("insert into workspace_memberships (workspace_id,user_id,role,created_at,updated_at) values ($1,$2,$3,$4,$5) on conflict (workspace_id,user_id) do nothing returning *",[value.workspaceId,value.userId,value.role,value.createdAt,value.updatedAt]);return rows[0]?mapWorkspaceMembership(rows[0]):"already_exists"}
  async updateWorkspaceMembership(value:WorkspaceMembership):Promise<WorkspaceMembership|null>{const rows=await this.queryRows<WorkspaceMembershipRow>("update workspace_memberships set role=$3,updated_at=$4 where workspace_id=$1 and user_id=$2 returning *",[value.workspaceId,value.userId,value.role,value.updatedAt]);return rows[0]?mapWorkspaceMembership(rows[0]):null}
  async updateManagedWorkspaceMembershipRole(workspaceId:string,userId:string,role:ManagedWorkspaceMembershipRole,updatedAt:string,expectedUpdatedAt:string):Promise<ManagedWorkspaceMembershipUpdateResult>{return transaction(this.pool,async(client)=>{const updated=await client.query<WorkspaceMembershipRow>(`update workspace_memberships wm set role=$3,updated_at=$4 from workspaces w where wm.workspace_id=$1 and wm.user_id=$2 and w.id=wm.workspace_id and wm.role<>'owner' and w.owner_user_id<>wm.user_id and wm.updated_at=$5 returning wm.*`,[workspaceId,userId,role,updatedAt,expectedUpdatedAt]);if(updated.rows[0])return mapWorkspaceMembership(updated.rows[0]);const current=await client.query<{role:string;owner_user_id:string}>(`select wm.role,w.owner_user_id from workspace_memberships wm join workspaces w on w.id=wm.workspace_id where wm.workspace_id=$1 and wm.user_id=$2`,[workspaceId,userId]);if(!current.rows[0])return "not_found";return current.rows[0].role==="owner"||current.rows[0].owner_user_id===userId?"owner":"conflict"})}
  async revokeWorkspaceMembership(workspaceId:string,userId:string,expectedUpdatedAt:string):Promise<RevokeWorkspaceMembershipResult>{return transaction(this.pool,async(client)=>{const membership=await client.query<{role:string;updated_at:unknown}>("select role,updated_at from workspace_memberships where workspace_id=$1 and user_id=$2 for update",[workspaceId,userId]);if(!membership.rows[0])return "not_found";if(membership.rows[0].role==="owner")return "owner";const owned=await client.query("select p.id from projects p join project_memberships pm on pm.project_id=p.id where p.workspace_id=$1 and pm.user_id=$2 and (p.owner_user_id=$2 or pm.role='owner') for update of p,pm",[workspaceId,userId]);if(owned.rowCount)return "owner";if(toIso(membership.rows[0].updated_at)!==expectedUpdatedAt)return "conflict";const revoked=await client.query<{project_id:string}>("delete from project_memberships pm using projects p where pm.project_id=p.id and p.workspace_id=$1 and pm.user_id=$2 returning pm.project_id",[workspaceId,userId]);await client.query("delete from user_notifications n using projects p where n.user_id=$2 and n.project_id=p.id and p.workspace_id=$1",[workspaceId,userId]);const deleted=await client.query("delete from workspace_memberships where workspace_id=$1 and user_id=$2 and role<>'owner' and updated_at=$3",[workspaceId,userId,expectedUpdatedAt]);return deleted.rowCount===1?{revokedProjectIds:revoked.rows.map(row=>row.project_id)}:"conflict"})}

  async createProject(project: Project): Promise<Project> {
    await transaction(this.pool, async (client) => {
      await client.query(
        `insert into projects (
         id, workspace_id, name, owner_user_id, root_path, task_concurrency_limit, created_at, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          project.id,
          project.workspaceId,
          project.name,
          project.ownerUserId,
          project.rootPath,
          project.sandboxLimit,
          project.createdAt,
          project.updatedAt
        ]
      );
      await client.query(
        `insert into project_memberships (project_id, user_id, role, created_at, updated_at)
         values ($1, $2, 'owner', $3, $4)`,
        [project.id, project.ownerUserId, project.createdAt, project.updatedAt]
      );
      await client.query(
        `insert into project_resource_policies (
           project_id, active_tasks_limit, provider_requests_limit, provider_tokens_limit,
           provider_cost_limit, project_file_bytes_limit, created_at, updated_at
         ) values ($1, $2, null, null, null, null, $3, $4)`,
        [project.id, project.sandboxLimit, project.createdAt, project.updatedAt]
      );
      await client.query(
        `insert into project_resource_usage (
           project_id, active_tasks, provider_requests, provider_tokens, provider_cost,
           project_file_bytes, updated_at
         ) values ($1, 0, 0, 0, 0, 0, $2)`,
        [project.id, project.updatedAt]
      );
    });
    return structuredClone(project);
  }

  async listProjectsForWorkspace(workspaceId: string): Promise<Project[]> {
    const rows = await this.queryRows<ProjectRow>(
      `select * from projects where workspace_id = $1 order by created_at, id`,
      [workspaceId]
    );
    return rows.map(mapProject);
  }

  async listProjectDirectoryPage(query: import("../../ports/src/store.js").ProjectDirectoryStoreQuery): Promise<import("../../ports/src/store.js").ProjectDirectoryStorePage> {
    const baseValues: unknown[] = [query.userId, query.workspaceId, query.q];
    const after = query.after
      ? `and (
          (case when pin.pinned_at is null then 1 else 0 end) > $4
          or ((case when pin.pinned_at is null then 1 else 0 end) = $4 and p.name collate "C" > $5 collate "C")
          or ((case when pin.pinned_at is null then 1 else 0 end) = $4 and p.name = $5 and p.id collate "C" > $6 collate "C")
        )`
      : "";
    const values = query.after
      ? [...baseValues, query.after.pinned ? 0 : 1, query.after.name, query.after.id, query.limit]
      : [...baseValues, query.limit];
    const rows = await this.queryRows<ProjectRow & { pinned_at: unknown | null }>(
      `select p.*, pin.pinned_at
       from projects p
       join project_memberships membership on membership.project_id=p.id and membership.user_id=$1
       left join user_project_pins pin on pin.project_id=p.id and pin.user_id=$1
       where p.workspace_id=$2 and strpos(lower(p.name),$3)>0 ${after}
       order by (case when pin.pinned_at is null then 1 else 0 end), p.name collate "C", p.id collate "C"
       limit $${values.length}`,
      values
    );
    const totals = await this.queryRows<{ count: string }>(
      `select count(*)::text as count
       from projects p
       join project_memberships membership on membership.project_id=p.id and membership.user_id=$1
       where p.workspace_id=$2 and strpos(lower(p.name),$3)>0`,
      baseValues
    );
    return {
      items: rows.map((row) => ({ ...mapProject(row), pinnedAt: row.pinned_at === null ? null : toIso(row.pinned_at) })),
      total: Number(totals[0]?.count ?? 0)
    };
  }

  async findProjectDirectoryItem(userId:string,projectId:string):Promise<ProjectDirectoryItem|null>{
    const rows=await this.queryRows<ProjectRow & {pinned_at:unknown|null}>(
      `select p.*,pin.pinned_at
       from projects p
       join project_memberships membership on membership.project_id=p.id and membership.user_id=$1
       left join user_project_pins pin on pin.project_id=p.id and pin.user_id=$1
       where p.id=$2`,
      [userId,projectId]
    );
    return rows[0]?{...mapProject(rows[0]),pinnedAt:rows[0].pinned_at===null?null:toIso(rows[0].pinned_at)}:null;
  }

  async setProjectPin(userId:string,projectId:string,pinnedAt:string|null){return transaction(this.pool,async(client)=>{const membership=await client.query("select 1 from project_memberships where project_id=$1 and user_id=$2 for share",[projectId,userId]);if(!membership.rowCount)return false;if(pinnedAt)await client.query("insert into user_project_pins (project_id,user_id,pinned_at) values ($1,$2,$3) on conflict (project_id,user_id) do update set pinned_at=excluded.pinned_at",[projectId,userId,pinnedAt]);else await client.query("delete from user_project_pins where project_id=$1 and user_id=$2",[projectId,userId]);return true})}

  async findProject(id: string): Promise<Project | null> {
    const rows = await this.queryRows<ProjectRow>("select * from projects where id = $1", [id]);
    return rows[0] ? mapProject(rows[0]) : null;
  }
  async updateProjectName(projectId:string,name:string,updatedAt:string,expectedName:string):Promise<Project|null>{const rows=await this.queryRows<ProjectRow>("update projects set name=$2,updated_at=$3 where id=$1 and lifecycle_status='active' and name=$4 returning *",[projectId,name,updatedAt,expectedName]);return rows[0]?mapProject(rows[0]):null}
  async beginProjectDeletion(id:string,updatedAt:string,expectedOwnerUserId?:string){return transaction(this.pool,async(client)=>{const locked=await client.query<ProjectRow>("select * from projects where id=$1 for update",[id]);const project=locked.rows[0];if(!project||expectedOwnerUserId!==undefined&&project.owner_user_id!==expectedOwnerUserId)return{kind:"not_found_or_forbidden" as const};if(await projectHasLiveBusinessReservations(client,id)){if(project.lifecycle_status==="deleting")await client.query("update projects set lifecycle_status='active',updated_at=$2 where id=$1",[id,updatedAt]);return{kind:"sandbox_not_released" as const};}if(project.lifecycle_status==="deleting")return{kind:"ready" as const,value:mapProject(project)};const updated=await client.query<ProjectRow>("update projects set lifecycle_status='deleting',updated_at=$2 where id=$1 returning *",[id,updatedAt]);return{kind:"ready" as const,value:mapProject(updated.rows[0]!)}})}
  async setProjectLifecycleStatus(id:string,status:"active"|"archived",updatedAt:string):Promise<Project|null>{const rows=await this.queryRows<ProjectRow>("update projects set lifecycle_status=$2,updated_at=$3 where id=$1 and lifecycle_status <> 'deleting' returning *",[id,status,updatedAt]);return rows[0]?mapProject(rows[0]):null}
  async transferProjectOwner(projectId:string,fromUserId:string,toUserId:string,updatedAt:string):Promise<Project|null>{return transaction(this.pool,async(client)=>{if(fromUserId===toUserId)return null;const target=await client.query("select 1 from project_memberships where project_id=$1 and user_id=$2 for update",[projectId,toUserId]);if(!target.rowCount)return null;const project=await client.query<ProjectRow>("update projects set owner_user_id=$3,updated_at=$4 where id=$1 and owner_user_id=$2 and lifecycle_status='active' returning *",[projectId,fromUserId,toUserId,updatedAt]);if(!project.rows[0])return null;await client.query("update project_memberships set role='admin',updated_at=$3 where project_id=$1 and user_id=$2",[projectId,fromUserId,updatedAt]);await client.query("update project_memberships set role='owner',updated_at=$3 where project_id=$1 and user_id=$2",[projectId,toUserId,updatedAt]);return mapProject(project.rows[0])})}
  async finalizeProjectDeletion(id:string,completion?:CompleteTaskIdempotencyInput):Promise<FinalizeProjectDeletionResult>{
    return transaction(this.pool,async(client)=>{
      const project=await client.query<ProjectRow>("select * from projects where id=$1 and lifecycle_status='deleting' for update",[id]);
      if(!project.rows[0]||completion&&!isSuccessfulProjectDeletionCompletion(id,completion))return"not_ready" as const;
      if(completion){
        const claim=await client.query(
          `select 1 from task_idempotency_records
            where actor_id=$1 and project_id=$2 and operation='project.delete' and idempotency_key=$3
              and request_hash=$4 and claim_token=$5 and resource_id=$2 and status='in_progress'
            for update`,
          [completion.actorId,id,completion.key,completion.requestHash,completion.claimToken]
        );
        if(claim.rowCount!==1)return"not_ready" as const;
      }
      if(await projectHasLiveBusinessReservations(client,id))return"not_ready" as const;
      const taskIds=(await client.query<{id:string}>("select id from agent_tasks where project_id=$1",[id])).rows;
      for(const task of taskIds)await client.query("delete from postgres_json_docs where collection='sandbox_runtime_state' and id=$1",[task.id]);
      await client.query("delete from postgres_json_docs where collection='project_settings' and id=$1",[id]);
      await client.query("delete from postgres_json_docs where collection='endpoint_snapshots' and id in (select id from model_endpoints where project_id=$1)",[id]);
      await client.query("delete from task_interaction_changes where task_id in (select id from agent_tasks where project_id=$1)",[id]);
      await client.query("delete from task_messages where task_id in (select id from agent_tasks where project_id=$1)",[id]);
      await client.query("delete from agent_task_artifacts where task_id in (select id from agent_tasks where project_id=$1)",[id]);
      await client.query("delete from sandbox_usage_settlements where project_id=$1",[id]);
      await client.query("update agent_tasks set current_run_id=null where project_id=$1",[id]);
      await client.query("delete from sandbox_runs where project_id=$1",[id]);
      await client.query("delete from agent_tasks where project_id=$1",[id]);
      await client.query("delete from project_provider_settlements where project_id=$1",[id]);
      await client.query("delete from user_notifications where project_id=$1",[id]);
      await client.query("delete from project_alerts where project_id=$1",[id]);
      await client.query("delete from project_alert_rules where project_id=$1",[id]);
      await client.query("delete from project_context_entries where project_id=$1",[id]);
      await client.query("delete from project_audit_events where project_id=$1",[id]);
      await client.query("delete from project_memberships where project_id=$1",[id]);
      await client.query("delete from project_resource_usage where project_id=$1",[id]);
      await client.query("delete from project_resource_policies where project_id=$1",[id]);
      await client.query("delete from model_endpoints where project_id=$1",[id]);
      await client.query("delete from project_credentials where project_id=$1",[id]);
      await client.query("delete from file_libraries where project_id=$1",[id]);
      if(completion){
        await client.query(
          `delete from task_idempotency_records
            where project_id=$1
              and not (actor_id=$2 and operation='project.delete' and idempotency_key=$3)`,
          [id,completion.actorId,completion.key]
        );
        const completed=await client.query(
          `update task_idempotency_records
              set status='completed',response_status=$6,response_body=$7::jsonb,updated_at=$8
            where actor_id=$1 and project_id=$2 and operation='project.delete' and idempotency_key=$3
              and request_hash=$4 and claim_token=$5 and resource_id=$2 and status='in_progress'`,
          [completion.actorId,id,completion.key,completion.requestHash,completion.claimToken,completion.responseStatus,JSON.stringify(completion.responseBody),completion.updatedAt]
        );
        if(completed.rowCount!==1)throw new Error("Project deletion lost its idempotency claim");
      }else{
        await client.query("delete from task_idempotency_records where project_id=$1",[id]);
      }
      const deleted=await client.query("delete from projects where id=$1 and lifecycle_status='deleting'",[id]);
      if(deleted.rowCount!==1)throw new Error("Project deletion lost its locked Project");
      return"deleted" as const;
    });
  }
  async createProjectContextEntry(v: ProjectContextEntry): Promise<ProjectContextEntry | null> { const rows=await this.queryRows<ContextRow>(`insert into project_context_entries (id,workspace_id,project_id,owner_user_id,scope,context_key,content,content_type,name,user_id,version,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$6,$4,$9,$10,$11) on conflict do nothing returning *`,[v.id,v.workspaceId,v.projectId,v.ownerUserId,v.scope,v.contextKey,v.content,v.contentType,v.version,v.createdAt,v.updatedAt]); return rows[0]?mapContext(rows[0]):null; }
  async updateProjectContextEntry(v: ProjectContextEntry, expectedVersion: number): Promise<ProjectContextEntry | null> { try { const rows=await this.queryRows<ContextRow>(`update project_context_entries set context_key=$2,content=$3,content_type=$4,version=$5,updated_at=$6 where id=$1 and version=$7 and workspace_id=$8 and project_id is not distinct from $9 and scope=$10 and owner_user_id is not distinct from $11 returning *`,[v.id,v.contextKey,v.content,v.contentType,v.version,v.updatedAt,expectedVersion,v.workspaceId,v.projectId,v.scope,v.ownerUserId]); return rows[0]?mapContext(rows[0]):null; } catch(error) { if(isUniqueConstraintError(error))return null;throw error; } }
  async listProjectContextEntryMetadataPage(query:import("../../ports/src/store.js").ProjectContextMetadataStoreQuery):Promise<import("../../contracts/src/api.js").ProjectContextEntryMetadata[]>{
    const rows=await this.queryRows<ContextMetadataRow>(
      `select id,workspace_id,project_id,owner_user_id,scope,context_key,content_type,version,created_at,updated_at
       from project_context_entries
       where workspace_id=$1 and project_id is not distinct from $2 and scope=$3 and owner_user_id is not distinct from $4
         and ($5::text is null or context_key collate "C" > $5 collate "C")
       order by context_key collate "C"
       limit $6`,
      [query.workspaceId,query.projectId,query.scope,query.ownerUserId,query.afterContextKey??null,query.limit]
    );
    return rows.map(mapContextMetadata);
  }
  async listProjectContextEntryPage(query:import("../../ports/src/store.js").ProjectContextMetadataStoreQuery):Promise<ProjectContextEntry[]>{
    const rows=await this.queryRows<ContextRow>(
      `select *
       from project_context_entries
       where workspace_id=$1 and project_id is not distinct from $2 and scope=$3 and owner_user_id is not distinct from $4
         and ($5::text is null or context_key collate "C" > $5 collate "C")
       order by context_key collate "C"
       limit $6`,
      [query.workspaceId,query.projectId,query.scope,query.ownerUserId,query.afterContextKey??null,query.limit]
    );
    return rows.map(mapContext);
  }
  async findProjectContextEntryByKey(workspaceId:string,projectId:string|null,scope:ProjectContextEntry["scope"],ownerUserId:string|null,contextKey:string):Promise<ProjectContextEntry|null>{const rows=await this.queryRows<ContextRow>('select * from project_context_entries where workspace_id=$1 and project_id is not distinct from $2 and scope=$3 and owner_user_id is not distinct from $4 and context_key=$5',[workspaceId,projectId,scope,ownerUserId,contextKey]);return rows[0]?mapContext(rows[0]):null;}
  async findProjectContextEntryById(id:string,workspaceId:string,projectId:string|null,scope:ProjectContextEntry["scope"],ownerUserId:string|null):Promise<ProjectContextEntry|null>{const rows=await this.queryRows<ContextRow>('select * from project_context_entries where id=$1 and workspace_id=$2 and project_id is not distinct from $3 and scope=$4 and owner_user_id is not distinct from $5',[id,workspaceId,projectId,scope,ownerUserId]);return rows[0]?mapContext(rows[0]):null;}
  async deleteProjectContextEntry(v: Pick<ProjectContextEntry, "id" | "workspaceId" | "projectId" | "scope" | "ownerUserId" | "version">): Promise<boolean> { return (await this.pool.query('delete from project_context_entries where id=$1 and workspace_id=$2 and project_id is not distinct from $3 and scope=$4 and owner_user_id is not distinct from $5 and version=$6',[v.id,v.workspaceId,v.projectId,v.scope,v.ownerUserId,v.version])).rowCount===1; }
  async createProjectAlertRule(v:ProjectAlertRule):Promise<ProjectAlertRule|null>{return transaction(this.pool,async(client)=>{const project=await client.query("select id from projects where id=$1 for update",[v.projectId]);if(!project.rowCount)throw new Error("Project not found while creating alert rule");const count=await client.query<{count:string}>("select count(*)::text as count from project_alert_rules where project_id=$1",[v.projectId]);if(Number(count.rows[0]?.count??0)>=50)return null;const scope=v.scope??{kind:"project" as const};const row=(await client.query<AlertRuleRow>("insert into project_alert_rules (id,project_id,alert_type,name,metric,condition,threshold,window_seconds,scope_kind,endpoint_id,enabled,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *",[v.id,v.projectId,toPersistedAlertType(v.alertType),v.name??v.alertType.replaceAll("_"," "),toPersistedAlertMetric(v.metric??"failure_count"),v.condition??"greater_than_or_equal",v.threshold??1,v.windowSeconds??null,scope.kind,scope.kind==="endpoint"?scope.endpointId:null,v.enabled,v.createdAt,v.updatedAt])).rows[0];if(!row)throw new Error("Alert rule insert returned no row");return mapAlertRule(row)})}
  async listProjectAlertRules(id:string){const rows=await this.queryRows<AlertRuleRow>('select * from project_alert_rules where project_id=$1 order by created_at,id collate "C" limit 51',[id]);if(rows.length>50)throw new Error("Project alert rule limit exceeded");return rows.map(mapAlertRule)}
  async listProjectAlertRuleViews(projectId:string){const rows=await this.queryRows<AlertRuleViewRow>('select rule.*,endpoint.name as endpoint_name from project_alert_rules rule left join model_endpoints endpoint on endpoint.project_id=rule.project_id and endpoint.id=rule.endpoint_id where rule.project_id=$1 order by rule.created_at,rule.id collate "C" limit 51',[projectId]);if(rows.length>50)throw new Error("Project alert rule limit exceeded");return rows.map(mapAlertRuleView)}
  async findProjectAlertRule(projectId:string,id:string){const rows=await this.queryRows<AlertRuleRow>("select * from project_alert_rules where project_id=$1 and id=$2",[projectId,id]);return rows[0]?mapAlertRule(rows[0]):null}
  async findProjectAlertRuleView(projectId:string,id:string){const rows=await this.queryRows<AlertRuleViewRow>("select rule.*,endpoint.name as endpoint_name from project_alert_rules rule left join model_endpoints endpoint on endpoint.project_id=rule.project_id and endpoint.id=rule.endpoint_id where rule.project_id=$1 and rule.id=$2",[projectId,id]);return rows[0]?mapAlertRuleView(rows[0]):null}
  async updateProjectAlertRule(v:ProjectAlertRule,expectedUpdatedAt?:string){const scope=v.scope??{kind:'project' as const};const values:unknown[]=[v.id,toPersistedAlertType(v.alertType),v.name??v.alertType.replaceAll('_',' '),toPersistedAlertMetric(v.metric??'failure_count'),v.condition??'greater_than_or_equal',v.threshold??1,v.windowSeconds??null,scope.kind,scope.kind==='endpoint'?scope.endpointId:null,v.enabled,v.updatedAt,v.projectId];const expected=expectedUpdatedAt===undefined?'':` and updated_at=$13`;if(expectedUpdatedAt!==undefined)values.push(expectedUpdatedAt);const r=await this.queryRows<AlertRuleRow>(`update project_alert_rules set alert_type=$2,name=$3,metric=$4,condition=$5,threshold=$6,window_seconds=$7,scope_kind=$8,endpoint_id=$9,enabled=$10,updated_at=$11 where id=$1 and project_id=$12${expected} returning *`,values);return r[0]?mapAlertRule(r[0]):null} async deleteProjectAlertRule(projectId:string,id:string){return (await this.pool.query('delete from project_alert_rules where id=$1 and project_id=$2',[id,projectId])).rowCount===1}

  async createFileLibrary(value:FileLibrary):Promise<FileLibrary|null>{
    const rows=await this.queryRows<FileLibraryRow>(`insert into file_libraries(id,workspace_id,project_id,name,root_sub_path,created_by_user_id,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning *`,[value.id,value.workspaceId,value.projectId,value.name,value.rootSubPath,value.createdByUserId,value.createdAt,value.updatedAt]);
    return rows[0]?mapFileLibrary(rows[0]):null;
  }
  async findFileLibrary(id:string):Promise<FileLibrary|null>{const rows=await this.queryRows<FileLibraryRow>("select * from file_libraries where id=$1",[id]);return rows[0]?mapFileLibrary(rows[0]):null}
  async listFileLibrariesForProject(projectId:string):Promise<FileLibrary[]>{return (await this.queryRows<FileLibraryRow>("select * from file_libraries where project_id=$1 order by created_at,id",[projectId])).map(mapFileLibrary)}
  async renameFileLibrary(projectId:string,id:string,name:string,expectedUpdatedAt:string,updatedAt:string):Promise<FileLibrary|null>{
    try{const rows=await this.queryRows<FileLibraryRow>("update file_libraries set name=$3,updated_at=$5 where project_id=$1 and id=$2 and updated_at=$4 returning *",[projectId,id,name,expectedUpdatedAt,updatedAt]);return rows[0]?mapFileLibrary(rows[0]):null}catch(error){if(isUniqueConstraintError(error))return null;throw error}
  }
  async deleteFileLibraryIfUnbound(projectId:string,id:string){return transaction(this.pool,async(client)=>{const current=await client.query("select id from file_libraries where project_id=$1 and id=$2 for update",[projectId,id]);if(!current.rows[0])return"not_found" as const;const deleted=await client.query("delete from file_libraries library where library.project_id=$1 and library.id=$2 and not exists (select 1 from agent_tasks task where task.file_library_id=library.id)",[projectId,id]);return deleted.rowCount===1?"deleted" as const:"bound" as const;})}
  async findTaskBoundToFileLibrary(fileLibraryId:string){const rows=await this.queryRows<{id:string;title:string|null}>("select id,title from agent_tasks where file_library_id=$1",[fileLibraryId]);return rows[0]?{kind:"bound" as const,task:{id:rows[0].id,title:rows[0].title}}:{kind:"unbound" as const}}

  async findProjectMembership(projectId: string, userId: string): Promise<ProjectMembership | null> {
    const rows = await this.queryRows<ProjectMembershipRow>(
      `select * from project_memberships where project_id = $1 and user_id = $2`,
      [projectId, userId]
    );
    return rows[0] ? mapProjectMembership(rows[0]) : null;
  }

  async findProjectMembershipView(projectId:string,userId:string):Promise<ProjectMembershipView|null>{const rows=await this.queryRows<ProjectMembershipRow>("select pm.*,u.email,p.display_name from project_memberships pm join users u on u.id=pm.user_id left join user_profile_preferences p on p.user_id=u.id where pm.project_id=$1 and pm.user_id=$2",[projectId,userId]);return rows[0]?mapProjectMembershipView(rows[0]):null}
  async listProjectMembershipDirectoryPage(projectId:string,query:MembershipDirectoryStoreQuery<ProjectMembership["role"]>):Promise<ProjectMembershipView[]>{
    const values:unknown[]=[projectId],where=["pm.project_id=$1"];
    if(query.q){values.push(query.q);const q=`$${values.length}`;where.push(`(position(${q} in lower(coalesce(p.display_name,'')))>0 or position(${q} in lower(u.email))>0 or position(${q} in lower(pm.user_id))>0)`)}
    if(query.role){values.push(query.role);where.push(`pm.role=$${values.length}`)}
    if(query.after){values.push(query.after.createdAt,query.after.userId);const created=`$${values.length-1}`,userId=`$${values.length}`;where.push(`(pm.created_at>${created} or (pm.created_at=${created} and pm.user_id collate "C">${userId} collate "C"))`)}
    values.push(query.limit);
    return(await this.queryRows<ProjectMembershipRow>(`select pm.*,u.email,p.display_name from project_memberships pm join users u on u.id=pm.user_id left join user_profile_preferences p on p.user_id=u.id where ${where.join(" and ")} order by pm.created_at,pm.user_id collate "C" limit $${values.length}`,values)).map(mapProjectMembershipView);
  }
  async listProjectMembershipCandidatesPage(projectId:string,query:ProjectMembershipCandidateStoreQuery):Promise<ProjectMembershipCandidateStoreItem[]>{
    const values:unknown[]=[projectId],where=["project.id=$1","not exists (select 1 from project_memberships pm where pm.project_id=project.id and pm.user_id=wm.user_id)"];
    if(query.q){values.push(query.q);const q=`$${values.length}`;where.push(`(position(${q} in lower(coalesce(profile.display_name,'')))>0 or position(${q} in lower(u.email))>0 or position(${q} in lower(wm.user_id))>0)`)}
    if(query.after){values.push(query.after.createdAt,query.after.userId);const created=`$${values.length-1}`,userId=`$${values.length}`;where.push(`(wm.created_at>${created} or (wm.created_at=${created} and wm.user_id collate "C">${userId} collate "C"))`)}
    values.push(query.limit);
    const rows=await this.queryRows<{user_id:string;email:string;display_name:string|null;created_at:unknown}>(`select wm.user_id,u.email,profile.display_name,wm.created_at from projects project join workspace_memberships wm on wm.workspace_id=project.workspace_id join users u on u.id=wm.user_id left join user_profile_preferences profile on profile.user_id=u.id where ${where.join(" and ")} order by wm.created_at,wm.user_id collate "C" limit $${values.length}`,values);
    return rows.map((row)=>({userId:row.user_id,displayName:row.display_name??null,email:row.email,createdAt:toIso(row.created_at)}));
  }
  async findProjectMembershipIdentities(projectId:string,userIds:string[]):Promise<import("../../contracts/src/api.js").ProjectMembershipCandidate[]>{
    if(userIds.length>200)throw new Error("Project membership identity batch exceeds 200 users");
    if(userIds.length===0)return[];
    const rows=await this.queryRows<ProjectMembershipRow>("select pm.*,u.email,p.display_name from project_memberships pm join users u on u.id=pm.user_id left join user_profile_preferences p on p.user_id=u.id where pm.project_id=$1 and pm.user_id=any($2::text[])",[projectId,userIds]);
    return rows.map((row)=>({userId:row.user_id,displayName:row.display_name??null,email:row.email??row.user_id}));
  }
  async listProjectMembershipsForFanout(projectId:string):Promise<ProjectMembership[]>{return(await this.queryRows<ProjectMembershipRow>("select * from project_memberships where project_id=$1 order by created_at,user_id collate \"C\"",[projectId])).map(mapProjectMembership)}

  async upsertProjectMembership(membership: ProjectMembership): Promise<ProjectMembership> {
    const result = await this.pool.query<ProjectMembershipRow>(
      `insert into project_memberships (project_id, user_id, role, created_at, updated_at)
       values ($1, $2, $3, $4, $5)
       on conflict (project_id, user_id) do update
         set role = excluded.role,
             updated_at = excluded.updated_at
       returning *`,
      [membership.projectId, membership.userId, membership.role, membership.createdAt, membership.updatedAt]
    );
    return mapProjectMembership(result.rows[0]!);
  }

  async upsertProjectMembershipForWorkspaceMember(membership: ProjectMembership): Promise<ProjectMembership | null> {
    return transaction(this.pool,async(client)=>{
      const eligible=await client.query("select 1 from projects p join workspace_memberships wm on wm.workspace_id=p.workspace_id and wm.user_id=$2 where p.id=$1 for update of wm",[membership.projectId,membership.userId]);
      if(!eligible.rowCount)return null;
      const result=await client.query<ProjectMembershipRow>(`insert into project_memberships (project_id,user_id,role,created_at,updated_at) values ($1,$2,$3,$4,$5) on conflict (project_id,user_id) do update set role=excluded.role,updated_at=excluded.updated_at returning *`,[membership.projectId,membership.userId,membership.role,membership.createdAt,membership.updatedAt]);
      return mapProjectMembership(result.rows[0]!);
    });
  }

  async createProjectMembershipForWorkspaceMember(membership:ProjectMembership):Promise<CreateProjectMembershipResult>{return transaction(this.pool,async(client)=>{const eligible=await client.query("select 1 from projects p join workspace_memberships wm on wm.workspace_id=p.workspace_id and wm.user_id=$2 where p.id=$1 for key share of wm",[membership.projectId,membership.userId]);if(!eligible.rowCount)return "not_workspace_member";const created=await client.query<ProjectMembershipRow>("insert into project_memberships (project_id,user_id,role,created_at,updated_at) values ($1,$2,$3,$4,$5) on conflict (project_id,user_id) do nothing returning *",[membership.projectId,membership.userId,membership.role,membership.createdAt,membership.updatedAt]);return created.rows[0]?mapProjectMembership(created.rows[0]):"already_exists"})}

  async updateProjectMembership(membership: ProjectMembership): Promise<ProjectMembership | null> {
    const result = await this.pool.query<ProjectMembershipRow>(
      `update project_memberships set role = $3, updated_at = $4 where project_id = $1 and user_id = $2 returning *`,
      [membership.projectId, membership.userId, membership.role, membership.updatedAt]
    );
    return result.rows[0] ? mapProjectMembership(result.rows[0]) : null;
  }

  async deleteProjectMembership(projectId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `delete from project_memberships where project_id = $1 and user_id = $2`,
      [projectId, userId]
    );
    return result.rowCount === 1;
  }

  async updateManagedProjectMembershipRole(projectId:string,userId:string,role:ManagedProjectMembershipRole,updatedAt:string,expectedUpdatedAt:string):Promise<ManagedProjectMembershipUpdateResult>{return transaction(this.pool,async(client)=>{const updated=await client.query<ProjectMembershipRow>(`update project_memberships pm set role=$3,updated_at=$4 from projects p where pm.project_id=$1 and pm.user_id=$2 and p.id=pm.project_id and pm.role<>'owner' and p.owner_user_id<>pm.user_id and pm.updated_at=$5 returning pm.*`,[projectId,userId,role,updatedAt,expectedUpdatedAt]);if(updated.rows[0])return mapProjectMembership(updated.rows[0]);const current=await client.query<{role:string;owner_user_id:string}>(`select pm.role,p.owner_user_id from project_memberships pm join projects p on p.id=pm.project_id where pm.project_id=$1 and pm.user_id=$2`,[projectId,userId]);if(!current.rows[0])return "not_found";return current.rows[0].role==="owner"||current.rows[0].owner_user_id===userId?"owner":"conflict"})}
  async deleteManagedProjectMembership(projectId:string,userId:string,expectedUpdatedAt:string):Promise<ManagedProjectMembershipDeleteResult>{return transaction(this.pool,async(client)=>{const deleted=await client.query(`delete from project_memberships pm using projects p where pm.project_id=$1 and pm.user_id=$2 and p.id=pm.project_id and pm.role<>'owner' and p.owner_user_id<>pm.user_id and pm.updated_at=$3`,[projectId,userId,expectedUpdatedAt]);if(deleted.rowCount===1){await client.query("delete from user_notifications where project_id=$1 and user_id=$2",[projectId,userId]);return "deleted"}const current=await client.query<{role:string;owner_user_id:string}>(`select pm.role,p.owner_user_id from project_memberships pm join projects p on p.id=pm.project_id where pm.project_id=$1 and pm.user_id=$2`,[projectId,userId]);if(!current.rows[0])return "not_found";return current.rows[0].role==="owner"||current.rows[0].owner_user_id===userId?"owner":"conflict"})}

  async createProjectResourcePolicy(policy: ProjectResourcePolicy): Promise<ProjectResourcePolicy> {
    await this.pool.query(`insert into project_resource_policies (project_id, active_tasks_limit, provider_requests_limit, provider_tokens_limit, provider_cost_limit, project_file_bytes_limit, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, policyValues(policy));
    return structuredClone(policy);
  }
  async findProjectResourcePolicy(projectId: string): Promise<ProjectResourcePolicy | null> {
    const rows = await this.queryRows<ProjectPolicyRow>("select * from project_resource_policies where project_id = $1", [projectId]); if(!rows[0])return null;const policy=mapPolicy(rows[0]);policy.endpointWindows=(await this.queryRows<{endpoint_id:string;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;limit_value:number;window_seconds:number}>("select endpoint_id,metric,limit_value,window_seconds from project_endpoint_policy_windows where project_id=$1 order by endpoint_id,metric",[projectId])).map(row=>({endpointId:row.endpoint_id,metric:row.metric,limit:Number(row.limit_value),windowSeconds:Number(row.window_seconds)}));return policy;
  }
  async findProjectResourcePolicyView(projectId:string):Promise<import("../../contracts/src/api.js").ProjectResourcePolicyView|null>{
    const rows=await this.queryRows<ProjectPolicyRow>("select * from project_resource_policies where project_id=$1",[projectId]);
    if(!rows[0])return null;
    const policy=mapPolicy(rows[0]);
    const windows=await this.queryRows<{endpoint_id:string;endpoint_name:string|null;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;limit_value:number;window_seconds:number}>('select policy_window.endpoint_id,endpoint.name as endpoint_name,policy_window.metric,policy_window.limit_value,policy_window.window_seconds from project_endpoint_policy_windows policy_window left join model_endpoints endpoint on endpoint.project_id=policy_window.project_id and endpoint.id=policy_window.endpoint_id where policy_window.project_id=$1 order by policy_window.endpoint_id collate "C",policy_window.metric',[projectId]);
    return{...policy,endpointWindows:windows.map((row)=>({endpointId:row.endpoint_id,endpointName:row.endpoint_name,metric:row.metric,limit:Number(row.limit_value),windowSeconds:Number(row.window_seconds)}))};
  }
  async patchProjectResourcePolicy(projectId: string, input: UpdateProjectResourcePolicyInput, updatedAt: string, expectedUpdatedAt?: string): Promise<ProjectResourcePolicy | null> {
    const endpointWindows=input.endpointWindows;
    const scalarInput={...input};delete scalarInput.endpointWindows;
    const policyColumns = {
      sandboxLimit: "active_tasks_limit",
      providerRequestsLimit: "provider_requests_limit",
      providerTokensLimit: "provider_tokens_limit",
      providerCostLimit: "provider_cost_limit",
      projectFileBytesLimit: "project_file_bytes_limit"
    } as const;
    return transaction(this.pool,async client=>{const project=await client.query("select id from projects where id=$1 for update",[projectId]);if(!project.rows[0])return null;await client.query("select project_id from project_resource_policies where project_id=$1 for update",[projectId]);await client.query("select project_id from project_resource_usage where project_id=$1 for update",[projectId]);const keys=Object.keys(scalarInput) as Array<keyof typeof policyColumns>;const updates=keys.map((key,index)=>`${policyColumns[key]}=$${index+2}`);const values=keys.map(key=>scalarInput[key]);const updatedAtIndex=values.length+2;const expectedClause=expectedUpdatedAt===undefined?"":` and updated_at=$${updatedAtIndex+1}`;const params=[projectId,...values,updatedAt,...(expectedUpdatedAt===undefined?[]:[expectedUpdatedAt])];const row=(await client.query<ProjectPolicyRow>(`update project_resource_policies set ${updates.length?`${updates.join(", ")},`:""}updated_at=$${updatedAtIndex} where project_id=$1${expectedClause} returning *`,params)).rows[0];if(!row)return null;if(input.sandboxLimit!==undefined&&input.sandboxLimit!==null)await client.query("update projects set task_concurrency_limit=$2,updated_at=$3 where id=$1",[projectId,input.sandboxLimit,updatedAt]);if(endpointWindows){await client.query("delete from project_endpoint_policy_windows where project_id=$1",[projectId]);for(const window of endpointWindows)await client.query("insert into project_endpoint_policy_windows(project_id,endpoint_id,metric,limit_value,window_seconds) values($1,$2,$3,$4,$5)",[projectId,window.endpointId,window.metric,window.limit,window.windowSeconds])}const result=mapPolicy(row);result.endpointWindows=endpointWindows??(await client.query<{endpoint_id:string;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;limit_value:number;window_seconds:number}>("select endpoint_id,metric,limit_value,window_seconds from project_endpoint_policy_windows where project_id=$1 order by endpoint_id,metric",[projectId])).rows.map(item=>({endpointId:item.endpoint_id,metric:item.metric,limit:Number(item.limit_value),windowSeconds:Number(item.window_seconds)}));return result})
  }
  async findProjectResourceUsage(projectId: string): Promise<ProjectResourceUsage | null> {
    const rows = await this.queryRows<ProjectUsageRow>("select * from project_resource_usage where project_id = $1", [projectId]); return rows[0] ? mapUsage(rows[0]) : null;
  }
  async upsertProjectResourceUsage(usage: ProjectResourceUsage): Promise<ProjectResourceUsage> {
    const rows = await this.queryRows<ProjectUsageRow>(`insert into project_resource_usage (project_id,active_tasks,provider_requests,provider_tokens,provider_cost,project_file_bytes,project_file_bytes_measured_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (project_id) do update set active_tasks=excluded.active_tasks,provider_requests=excluded.provider_requests,provider_tokens=excluded.provider_tokens,provider_cost=excluded.provider_cost,project_file_bytes=excluded.project_file_bytes,project_file_bytes_measured_at=excluded.project_file_bytes_measured_at,updated_at=excluded.updated_at returning *`, usageValues(usage)); return mapUsage(rows[0]!);
  }
  async setProjectFileBytes(projectId: string, bytes: number, measuredAt: string): Promise<ProjectResourceUsage | null> {
    const rows = await this.queryRows<ProjectUsageRow>("update project_resource_usage set project_file_bytes=$2,project_file_bytes_measured_at=$3,updated_at=$3 where project_id=$1 returning *", [projectId, bytes, measuredAt]);
    return rows[0] ? mapUsage(rows[0]) : null;
  }
  async adjustProjectResourceUsage(input: ProjectResourceUsageAdjustment): Promise<ProjectResourceUsage | null> {
    if(input.delta.activeSandboxes!==0)throw new Error("active_tasks is an authoritative Sandbox Run projection");
    const delta = input.delta;
    const limitedDelta = input.limit ? usageDelta(input.limit, delta) : 0;
    const condition = input.limit && limitedDelta > 0
      ? `and (p.${usageLimitColumn(input.limit)} is null or u.${usageColumn(input.limit)} + $${usageDeltaPlaceholder(input.limit)} <= p.${usageLimitColumn(input.limit)})`
      : "";
    const rows = await this.queryRows<ProjectUsageRow>(
      `update project_resource_usage u
       set provider_requests = u.provider_requests + $2,
           provider_tokens = u.provider_tokens + $3,
           provider_cost = u.provider_cost + $4,
           project_file_bytes = greatest(0, u.project_file_bytes + $5),
           updated_at = $6
       from project_resource_policies p
       where u.project_id = $1 and p.project_id = u.project_id ${condition}
       returning u.*`,
      [input.projectId, delta.providerRequests, delta.providerTokens, delta.providerCost, delta.projectFileBytes, input.updatedAt]
    );
    return rows[0] ? mapUsage(rows[0]) : null;
  }
  async reserveProjectProviderSettlement(input: ReserveProjectProviderSettlementInput): Promise<ProjectProviderSettlement | null> {
    return transaction(this.pool, async (client) => {
      if(!await lockActiveProjectWithClient(client,input.projectId))return null;
      const project = await client.query("select 1 from project_resource_policies p join project_resource_usage u on u.project_id=p.project_id where p.project_id=$1 for update of p,u",[input.projectId]);
      if (!project.rowCount) return null;
      if (input.endpointId !== null) {
        const windows=await client.query<{metric:"providerRequests"|"providerTokens"|"providerCost";limit_value:string|number;window_seconds:number}>("select metric,limit_value,window_seconds from project_endpoint_policy_windows where project_id=$1 and endpoint_id=$2 for update",[input.projectId,input.endpointId]);
        for(const window of windows.rows){const cutoff=new Date(Date.parse(input.reservedAt)-Number(window.window_seconds)*1000).toISOString();const aggregate=await client.query<{value:string}>(`select coalesce(sum(case when $4='providerRequests' then 1 when $4='providerTokens' then case when status='settled' then coalesce(provider_tokens,0) else reserved_tokens end else case when status='settled' then coalesce(provider_cost,0) else reserved_cost end end),0)::text as value from project_provider_settlements where project_id=$1 and endpoint_id=$2 and status<>'failed' and reserved_at >= $3 and actor_id is not distinct from $5`,[input.projectId,input.endpointId,cutoff,window.metric,input.actorId??null]);const current=Number(aggregate.rows[0]?.value??0);const proposed=current+(window.metric==="providerRequests"?1:window.metric==="providerTokens"?input.reservedTokens:input.reservedCost);if(proposed>Number(window.limit_value))return null;}
      }
      const reserved = await client.query(`update project_resource_usage u set provider_requests=u.provider_requests+1,provider_tokens=u.provider_tokens+$3,provider_cost=u.provider_cost+$4,updated_at=$2 from project_resource_policies p where u.project_id=$1 and p.project_id=u.project_id and (p.provider_requests_limit is null or u.provider_requests+1<=p.provider_requests_limit) and (p.provider_tokens_limit is null or u.provider_tokens+$3<=p.provider_tokens_limit) and (p.provider_cost_limit is null or u.provider_cost+$4<=p.provider_cost_limit) returning u.project_id`, [input.projectId, input.reservedAt, input.reservedTokens, input.reservedCost]);
      if (!reserved.rowCount) return null;
      const row = await client.query<ProviderSettlementRow>(`insert into project_provider_settlements (id,project_id,task_id,endpoint_id,actor_id,reserved_tokens,reserved_cost,status,reserved_at,expires_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,$8) returning *`, [input.id,input.projectId,input.taskId,input.endpointId,input.actorId??null,input.reservedTokens,input.reservedCost,input.reservedAt,input.expiresAt]);
      return mapProviderSettlement(row.rows[0]!);
    });
  }
  async markProjectProviderSettlementDispatched(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null> { return this.transitionProviderSettlement(id, "reserved", "dispatched", updatedAt, "dispatched_at"); }
  async markProjectProviderSettlementDelivered(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null> { const rows=await this.queryRows<ProviderSettlementRow>(`update project_provider_settlements set status='delivered',delivered_at=coalesce(delivered_at,$2),updated_at=$2 where id=$1 and status in ('dispatched','unknown') returning *`,[id,updatedAt]);if(rows[0])return mapProviderSettlement(rows[0]);const current=await this.queryRows<ProviderSettlementRow>("select * from project_provider_settlements where id=$1 and status='delivered'",[id]);return current[0]?mapProviderSettlement(current[0]):null; }
  async settleProjectProviderSettlement(id: string, usage: ProviderUsage | undefined, updatedAt: string): Promise<ProjectProviderUsageSettlement | null> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<ProviderSettlementRow>("select * from project_provider_settlements where id=$1 for update", [id]); const settlement = locked.rows[0]; if (!settlement) return null;
      if (settlement.status === "settled") {
        const rows = await client.query<ProjectProviderSettlementRow>(`select u.*, (p.provider_requests_limit is not null and u.provider_requests > p.provider_requests_limit) as provider_requests_exceeded, (p.provider_tokens_limit is not null and u.provider_tokens > p.provider_tokens_limit) as provider_tokens_exceeded, (p.provider_cost_limit is not null and u.provider_cost > p.provider_cost_limit) as provider_cost_exceeded from project_resource_usage u join project_resource_policies p on p.project_id=u.project_id where u.project_id=$1`, [settlement.project_id]);
        const row = rows.rows[0];
        return row ? { usage: mapUsage(row), endpointId: settlement.endpoint_id, actorId:settlement.actor_id, exceededLimits: providerExceededLimits(row) } : null;
      }
      if (!usage || (settlement.status !== "dispatched" && settlement.status !== "delivered" && settlement.status !== "unknown")) return null;
      const rows = await client.query<ProjectProviderSettlementRow>(`update project_resource_usage u set provider_tokens=greatest(0,u.provider_tokens+$2-$4),provider_cost=greatest(0,u.provider_cost+$3-$5),updated_at=$6 from project_resource_policies p where u.project_id=$1 and p.project_id=u.project_id returning u.*, (p.provider_requests_limit is not null and u.provider_requests > p.provider_requests_limit) as provider_requests_exceeded, (p.provider_tokens_limit is not null and u.provider_tokens > p.provider_tokens_limit) as provider_tokens_exceeded, (p.provider_cost_limit is not null and u.provider_cost > p.provider_cost_limit) as provider_cost_exceeded`, [settlement.project_id,usage.tokens ?? 0,usage.cost ?? 0,Number(settlement.reserved_tokens),Number(settlement.reserved_cost),updatedAt]);
      if (!rows.rows[0]) return null;
      await client.query(`update project_provider_settlements set status='settled',settled_at=$2,provider_tokens=$3,provider_cost=$4,updated_at=$2 where id=$1`, [id,updatedAt,usage?.tokens ?? null,usage?.cost ?? null]);
      const row=rows.rows[0]; return { usage: mapUsage(row), endpointId: settlement.endpoint_id, actorId:settlement.actor_id, exceededLimits: providerExceededLimits(row) };
    });
  }
  async markProjectProviderSettlementUnknown(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<ProviderSettlementRow>("select * from project_provider_settlements where id=$1 for update", [id]);
      const settlement = locked.rows[0];
      if (!settlement || (settlement.status !== "dispatched" && settlement.status !== "delivered")) return null;
      const updated = await client.query<ProviderSettlementRow>("update project_provider_settlements set status='unknown',updated_at=$2 where id=$1 returning *", [id, updatedAt]);
      return mapProviderSettlement(updated.rows[0]!);
    });
  }
  async failProjectProviderSettlement(id: string, updatedAt: string): Promise<ProjectProviderSettlement | null> { return transaction(this.pool, async (client) => { const rows=await client.query<ProviderSettlementRow>("select * from project_provider_settlements where id=$1 for update",[id]); const row=rows.rows[0]; if (!row) return null; if (row.status==='reserved') {await client.query("update project_resource_usage set provider_requests=greatest(0,provider_requests-1),provider_tokens=greatest(0,provider_tokens-$3),provider_cost=greatest(0,provider_cost-$4),updated_at=$2 where project_id=$1",[row.project_id,updatedAt,Number(row.reserved_tokens),Number(row.reserved_cost)]);const failed=await client.query<ProviderSettlementRow>("update project_provider_settlements set status='failed',updated_at=$2 where id=$1 returning *",[id,updatedAt]);return mapProviderSettlement(failed.rows[0]!);}if(row.status==='dispatched'||row.status==='delivered'){const unknown=await client.query<ProviderSettlementRow>("update project_provider_settlements set status='unknown',updated_at=$2 where id=$1 returning *",[id,updatedAt]);return mapProviderSettlement(unknown.rows[0]!);}return mapProviderSettlement(row); }); }
  async expireProjectProviderSettlements(now: string): Promise<number> { return transaction(this.pool, async (client) => { const locked=await client.query<ProviderSettlementRow>("select * from project_provider_settlements where status in ('reserved','dispatched','delivered') and expires_at <= $1 for update",[now]); if (!locked.rowCount) return 0; const totals=new Map<string,{requests:number;tokens:number;cost:number}>(); for (const row of locked.rows) {if(row.status!=='reserved')continue;const total=totals.get(row.project_id)??{requests:0,tokens:0,cost:0};total.requests+=1;total.tokens+=Number(row.reserved_tokens);total.cost+=Number(row.reserved_cost);totals.set(row.project_id,total)} for (const [projectId,total] of totals) await client.query("update project_resource_usage set provider_requests=greatest(0,provider_requests-$2),provider_tokens=greatest(0,provider_tokens-$3),provider_cost=greatest(0,provider_cost-$4),updated_at=$5 where project_id=$1",[projectId,total.requests,total.tokens,total.cost,now]); await client.query("update project_provider_settlements set status=case when status='reserved' then 'failed' else 'unknown' end,updated_at=$1 where status in ('reserved','dispatched','delivered') and expires_at <= $1",[now]); return locked.rowCount; }); }
  async pruneProjectProviderSettlements(before: string, limit: number): Promise<number> { const result=await this.pool.query(`delete from project_provider_settlements where id in (select id from project_provider_settlements where status in ('settled','unknown','failed') and updated_at < $1 order by updated_at limit $2)`,[before,limit]); return result.rowCount ?? 0; }
  async listSettledProjectProviderSettlements(projectId: string, since: string, endpointId?: string): Promise<ProjectProviderSettlement[]> { const rows = await this.queryRows<ProviderSettlementRow>(`select * from project_provider_settlements where project_id=$1 and status='settled' and settled_at >= $2${endpointId === undefined ? "" : " and endpoint_id=$3"} order by settled_at,id`, endpointId === undefined ? [projectId, since] : [projectId, since, endpointId]); return rows.map(mapProviderSettlement); }
  async readProjectUsageOverview(input:ProjectUsageOverviewReadInput):Promise<ProjectUsageOverviewReadResult>{
    return transaction(this.pool,async(client)=>{
      const projectRow=(await client.query<ProjectRow>("select * from projects where id=$1",[input.projectId])).rows[0];
      if(!projectRow)return{kind:"project_not_found" as const};
      const policyRow=(await client.query<ProjectPolicyRow>("select * from project_resource_policies where project_id=$1",[input.projectId])).rows[0];
      if(!policyRow)return{kind:"policy_not_found" as const};
      if(!(await client.query("select 1 from project_memberships where project_id=$1 and user_id=$2",[input.projectId,input.selectedUserId])).rowCount)return{kind:"selected_member_not_found" as const};
      const policy=mapPolicy(policyRow);
      policy.endpointWindows=(await client.query<{endpoint_id:string;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;limit_value:number;window_seconds:number}>("select endpoint_id,metric,limit_value,window_seconds from project_endpoint_policy_windows where project_id=$1 order by endpoint_id collate \"C\",metric",[input.projectId])).rows.map((row)=>({endpointId:row.endpoint_id,metric:row.metric,limit:Number(row.limit_value),windowSeconds:Number(row.window_seconds)}));
      const usageRow=(await client.query<ProjectUsageRow>("select * from project_resource_usage where project_id=$1",[input.projectId])).rows[0];
      const selectedEndpoint=input.selectedEndpointId===null?null:(await client.query<{id:string;name:string}>("select id,name from model_endpoints where project_id=$1 and id=$2",[input.projectId,input.selectedEndpointId])).rows[0]??null;
      if(input.selectedEndpointId!==null&&!selectedEndpoint)return{kind:"endpoint_not_found" as const};
      const dailyValues:unknown[]=[input.projectId,input.userId,input.periodStart,input.periodEnd];
      const endpointClause=input.selectedEndpointId===null?"":` and endpoint_id=$${dailyValues.push(input.selectedEndpointId)}`;
      const dailyRows=(await client.query<ProviderUsageAggregateRow>(`select to_char(settled_at at time zone 'UTC','YYYY-MM-DD') as bucket,count(*)::text as requests,coalesce(sum(provider_tokens),0)::text as tokens,coalesce(sum(provider_cost),0)::text as cost from project_provider_settlements where project_id=$1 and actor_id=$2 and status='settled' and settled_at >= $3 and settled_at < $4${endpointClause} group by bucket order by bucket`,dailyValues)).rows;
      const daily=dailyRows.map((row)=>({date:row.bucket,requests:Number(row.requests),tokens:Number(row.tokens),cost:Number(row.cost)}));
      const totals=daily.reduce((total,day)=>({requests:total.requests+day.requests,tokens:total.tokens+day.tokens,cost:total.cost+day.cost}),{requests:0,tokens:0,cost:0});
      const missingSettlement=await client.query("select 1 from sandbox_runs run left join sandbox_usage_settlements settlement on settlement.run_id=run.run_id where run.project_id=$1 and run.started_by_user_id=$2 and run.state='released' and settlement.run_id is null limit 1",[input.projectId,input.selectedUserId]);
      if(missingSettlement.rowCount)return{kind:"integrity_error" as const};
      const mismatchedOwnedRun=await client.query(`select 1 from sandbox_runs run left join agent_tasks task on task.id=run.task_id where run.project_id=$1 and run.started_by_user_id=$2 and run.state<>'released' and (task.id is null or task.deleted_at is not null or task.current_run_id is distinct from run.run_id or task.project_id is distinct from run.project_id or task.workspace_id is distinct from run.workspace_id or task.file_library_id is distinct from run.file_library_id) limit 1`,[input.projectId,input.selectedUserId]);
      if(mismatchedOwnedRun.rowCount)return{kind:"integrity_error" as const};
      const summary=(await client.query<SandboxUsageSummaryRow>(`with usage_rows as (
        select round(settlement.duration_seconds::numeric*1000) as duration_ms,settlement.cpu_request_millis::numeric as cpu_request_millis,settlement.memory_request_bytes::numeric as memory_request_bytes,false as live,(settlement.started_at is not null) as launched
        from sandbox_usage_settlements settlement where settlement.project_id=$1 and settlement.started_by_user_id=$2
        union all
        select case when run.started_at is null then 0::numeric else round(greatest(0,extract(epoch from ($3::timestamptz-run.started_at))*1000)) end,(run.resource_snapshot->>'cpuRequestMillis')::numeric,(run.resource_snapshot->>'memoryRequestBytes')::numeric,true,(run.started_at is not null)
        from sandbox_runs run where run.project_id=$1 and run.started_by_user_id=$2 and run.state<>'released'
      )
      select count(*) filter (where live)::text as unreleased_count,count(*) filter (where launched)::text as launches,coalesce(sum(duration_ms),0)::text as total_duration_ms,coalesce(sum(cpu_request_millis*duration_ms),0)::text as cpu_request_millis_ms,coalesce(sum(memory_request_bytes*duration_ms),0)::text as memory_request_byte_ms from usage_rows`,[input.projectId,input.selectedUserId,input.measuredAt])).rows[0];
      const liveRows=await client.query<SandboxLiveRunRow>(`select run.*,task.title as task_title from sandbox_runs run join agent_tasks task on task.id=run.task_id and task.deleted_at is null and task.current_run_id=run.run_id and task.project_id=run.project_id and task.workspace_id=run.workspace_id and task.file_library_id=run.file_library_id where run.project_id=$1 and run.started_by_user_id=$2 and run.state<>'released' order by coalesce(run.started_at,run.created_at) desc,run.run_id collate "C" desc`,[input.projectId,input.selectedUserId]);
      const measured=Date.parse(input.measuredAt);
      if(!summary||!Number.isFinite(measured))return{kind:"integrity_error" as const};
      return{kind:"available" as const,value:{projectCreatedAt:toIso(projectRow.created_at),policy,usage:usageRow?mapUsage(usageRow):null,provider:{daily,totals,selectedEndpoint},sandbox:{unreleasedCount:Number(summary.unreleased_count),launches:Number(summary.launches),totalDurationMilliseconds:summary.total_duration_ms,cpuRequestMillisMilliseconds:summary.cpu_request_millis_ms,memoryRequestByteMilliseconds:summary.memory_request_byte_ms,liveRuns:liveRows.rows.map((row)=>{const run=mapSandboxRun(row);return{taskId:run.taskId,taskTitle:row.task_title??null,taskAvailable:true,runId:run.runId,fileLibraryId:run.fileLibraryId,state:run.state as Exclude<PersistedSandboxRunState["state"],"released">,startedAt:run.startedAt,durationSeconds:run.startedAt?Math.max(0,(measured-Date.parse(run.startedAt))/1000):0,resources:structuredClone(run.resourceSnapshot)}})}}};
    },"repeatable read");
  }
  async queryProjectEndpointUsagePage(query:import("../../ports/src/store.js").ProjectEndpointUsageStoreQuery):Promise<import("../../ports/src/store.js").ProjectEndpointUsageStorePage>{
    return transaction(this.pool,async(client)=>{
      const values:unknown[]=[query.projectId,query.q],where=["project_id=$1","($2='' or position($2 in lower(name))>0 or position($2 in lower(id))>0)"];
      if(query.after){values.push(query.after.createdAt,query.after.id);where.push(`(created_at<$${values.length-1}::timestamptz or (created_at=$${values.length-1}::timestamptz and id collate "C"<$${values.length}::text collate "C"))`)}
      const total=Number((await client.query<{count:string}>("select count(*)::text as count from model_endpoints where project_id=$1 and ($2='' or position($2 in lower(name))>0 or position($2 in lower(id))>0)",[query.projectId,query.q])).rows[0]?.count??0);
      values.push(query.limit+1);
      const rows=(await client.query<{id:string;name:string;created_at:unknown}>(`select id,name,created_at from model_endpoints where ${where.join(" and ")} order by created_at desc,id collate "C" desc limit $${values.length}`,values)).rows;
      const pageRows=rows.slice(0,query.limit),endpointIds=pageRows.map((row)=>row.id);
      if(endpointIds.length===0)return{items:[],total,hasMore:false};
      const aggregates=(await client.query<ProviderEndpointUsageAggregateRow>(`select endpoint_id,count(*)::text as requests,coalesce(sum(provider_tokens),0)::text as tokens,coalesce(sum(provider_cost),0)::text as cost from project_provider_settlements where project_id=$1 and actor_id=$2 and endpoint_id=any($3::text[]) and status='settled' and settled_at >= $4 and settled_at < $5 group by endpoint_id`,[query.projectId,query.userId,endpointIds,query.periodStart,query.periodEnd])).rows;
      const byEndpoint=new Map(aggregates.map((row)=>[row.endpoint_id,{requests:Number(row.requests),tokens:Number(row.tokens),cost:Number(row.cost)}]));
      const windows=(await client.query<ProviderWindowAggregateRow>(`select policy_window.endpoint_id,policy_window.metric,policy_window.limit_value::text,policy_window.window_seconds,coalesce(sum(case when settlement.id is null then 0 when policy_window.metric='providerRequests' then 1 when policy_window.metric='providerTokens' then case when settlement.status='settled' then coalesce(settlement.provider_tokens,0) else settlement.reserved_tokens end else case when settlement.status='settled' then coalesce(settlement.provider_cost,0) else settlement.reserved_cost end end),0)::text as current,min(settlement.reserved_at) as oldest_reserved_at from project_endpoint_policy_windows policy_window left join project_provider_settlements settlement on settlement.project_id=policy_window.project_id and settlement.endpoint_id=policy_window.endpoint_id and settlement.actor_id=$2 and settlement.status<>'failed' and settlement.reserved_at >= $4::timestamptz-policy_window.window_seconds*interval '1 second' where policy_window.project_id=$1 and policy_window.endpoint_id=any($3::text[]) group by policy_window.endpoint_id,policy_window.metric,policy_window.limit_value,policy_window.window_seconds order by policy_window.endpoint_id collate "C",policy_window.metric`,[query.projectId,query.userId,endpointIds,query.measuredAt])).rows;
      const limitsByEndpoint=new Map<string,import("../../contracts/src/api.js").ProjectUsageLimit[]>();
      for(const row of windows){
        const current=Number(row.current),limit=Number(row.limit_value),startedAt=new Date(Date.parse(query.measuredAt)-Number(row.window_seconds)*1000).toISOString(),oldest=row.oldest_reserved_at?toIso(row.oldest_reserved_at):null;
        const limits=limitsByEndpoint.get(row.endpoint_id)??[];
        limits.push({metric:row.metric,current,limit,remaining:Math.max(0,limit-current),window:{kind:"rolling",windowSeconds:Number(row.window_seconds),startedAt,resetAt:oldest?new Date(Date.parse(oldest)+Number(row.window_seconds)*1000).toISOString():null}});
        limitsByEndpoint.set(row.endpoint_id,limits);
      }
      return{total,hasMore:rows.length>query.limit,items:pageRows.map((row)=>{const usage=byEndpoint.get(row.id)??{requests:0,tokens:0,cost:0};return{endpointId:row.id,endpointName:row.name,...usage,limits:limitsByEndpoint.get(row.id)??[],cursorCreatedAt:toIso(row.created_at),cursorId:row.id}})};
    },"repeatable read");
  }
  async measureProjectProviderWindow(input:{projectId:string;endpointId:string;actorId:string|null;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;since:string}):Promise<{current:number;oldestReservedAt:string|null}>{const rows=await this.queryRows<{value:string;oldest_reserved_at:unknown}>(`select coalesce(sum(case when $4='providerRequests' then 1 when $4='providerTokens' then case when status='settled' then coalesce(provider_tokens,0) else reserved_tokens end else case when status='settled' then coalesce(provider_cost,0) else reserved_cost end end),0)::text as value,min(reserved_at) as oldest_reserved_at from project_provider_settlements where project_id=$1 and endpoint_id=$2 and actor_id is not distinct from $3 and status<>'failed' and reserved_at >= $5`,[input.projectId,input.endpointId,input.actorId,input.metric,input.since]);return{current:Number(rows[0]?.value??0),oldestReservedAt:rows[0]?.oldest_reserved_at?toIso(rows[0].oldest_reserved_at):null};}
  async measureProjectAlertRule(input:{projectId:string;alertType:ProjectAlertType;metric:AlertRuleMetric;windowSeconds:number|null;endpointId:string|null;now:string}):Promise<number>{
    if(input.metric==="active_sandboxes"||input.metric==="project_file_bytes"){const column=input.metric==="active_sandboxes"?"active_tasks":"project_file_bytes";const rows=await this.queryRows<{value:string}>(`select coalesce(${column},0)::text as value from project_resource_usage where project_id=$1`,[input.projectId]);return Number(rows[0]?.value??0)}
    const cutoff=input.windowSeconds===null?null:new Date(Date.parse(input.now)-input.windowSeconds*1000).toISOString();
    if(input.metric!=="failure_count"){const expression=input.metric==="provider_requests"?"count(*)":input.metric==="provider_tokens"?"coalesce(sum(provider_tokens),0)":"coalesce(sum(provider_cost),0)";const values:unknown[]=[input.projectId];let where="project_id=$1 and status='settled'";if(cutoff){values.push(cutoff);where+=` and settled_at >= $${values.length}`}if(input.endpointId){values.push(input.endpointId);where+=` and endpoint_id=$${values.length}`}const rows=await this.queryRows<{value:string}>(`select (${expression})::text as value from project_provider_settlements where ${where}`,values);return Number(rows[0]?.value??0)}
    const values:unknown[]=[input.projectId];const clauses=["project_id=$1"];if(cutoff){values.push(cutoff);clauses.push(`created_at >= $${values.length}`)}if(input.endpointId){values.push(input.endpointId);clauses.push(`detail->>'endpointId'=$${values.length}`)}const failure=input.alertType==="provider_failure"?"action='provider.request' and status='rejected' and resource_kind='provider' and (detail->>'errorCategory') is not null":input.alertType==="endpoint_failure"?"resource_kind='endpoint' and status='rejected' and (detail->>'healthStatus')='unavailable'":input.alertType==="sandbox_failure"?"action='sandbox.failed' and status='accepted'":"false";const rows=await this.queryRows<{value:string}>(`select count(*)::text as value from project_audit_events where ${clauses.join(" and ")} and ${failure}`,values);return Number(rows[0]?.value??0)
  }
  private async transitionProviderSettlement(id: string, from: string, to: string, updatedAt: string, timestamp: string): Promise<ProjectProviderSettlement | null> { const rows=await this.queryRows<ProviderSettlementRow>(`update project_provider_settlements set status=$3, ${timestamp}=$2, updated_at=$2 where id=$1 and status=$4 returning *`,[id,updatedAt,to,from]); return rows[0] ? mapProviderSettlement(rows[0]) : null; }
  async upsertActiveProjectAlert(alert: ActiveProjectAlert): Promise<ActiveProjectAlert> {
    const rows = await this.queryRows<ProjectAlertRow>(`insert into project_alerts (id,project_id,type,status,delivery_status,rule_id,metric,metric_value,threshold,endpoint_id,subject_actor_id,acknowledged_at,acknowledged_by,silenced_until,created_at,updated_at,resolved_at,dismissed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) on conflict (project_id,type,(coalesce(rule_id,'')),(coalesce(endpoint_id,'')),(coalesce(subject_actor_id,''))) where status='active' do update set metric_value=excluded.metric_value,threshold=excluded.threshold,updated_at=excluded.updated_at returning *`, [alert.id,alert.projectId,toPersistedAlertType(alert.type),alert.status,alert.deliveryStatus,alert.ruleId??null,alert.metric===null||alert.metric===undefined?null:toPersistedAlertMetric(alert.metric),alert.metricValue??null,alert.threshold??null,alert.endpointId??null,alert.subjectActorId??null,alert.acknowledgedAt??null,alert.acknowledgedBy??null,alert.silencedUntil??null,alert.createdAt,alert.updatedAt,alert.resolvedAt,alert.dismissedAt]);
    const row=rows[0];if(!row)throw new Error("Active alert upsert returned no row");return mapActiveAlert(row);
  }
  async queryProjectAlerts(projectId:string,query:import("../../ports/src/store.js").ProjectAlertStoreQuery):Promise<import("../../ports/src/store.js").ProjectAlertStorePage>{return transaction(this.pool,async(client)=>{const values:unknown[]=[projectId];const where=["alert.project_id=$1",query.view==="active"?"alert.status='active'":"alert.status in ('resolved','dismissed')"];if(query.after){values.push(query.after.createdAt,query.after.id);where.push(`(alert.created_at < $${values.length-1}::timestamptz or (alert.created_at = $${values.length-1}::timestamptz and alert.id collate "C" < $${values.length}::text collate "C"))`)}values.push(query.limit+1);const rows=(await client.query<ProjectAlertRow>(`select alert.*,endpoint.name as endpoint_name from project_alerts alert left join model_endpoints endpoint on endpoint.project_id=alert.project_id and endpoint.id=alert.endpoint_id where ${where.join(" and ")} order by alert.created_at desc,alert.id collate "C" desc limit $${values.length}`,values)).rows;const activeCount=Number((await client.query<{count:string}>("select count(*)::text as count from project_alerts where project_id=$1 and status='active'",[projectId])).rows[0]?.count??0);return{items:rows.slice(0,query.limit).map(mapAlert),hasMore:rows.length>query.limit,activeCount}},"repeatable read")}
  async findActiveProjectAlert(projectId:string,type:ProjectAlertType,ruleId:string|null,endpointId:string|null,subjectActorId:string|null):Promise<ActiveProjectAlert|null>{const rows=await this.queryRows<ProjectAlertRow>("select * from project_alerts where project_id=$1 and type=$2 and status='active' and rule_id is not distinct from $3 and endpoint_id is not distinct from $4 and subject_actor_id is not distinct from $5",[projectId,toPersistedAlertType(type),ruleId,endpointId,subjectActorId]);return rows[0]?mapActiveAlert(rows[0]):null}
  async findProjectAlert(projectId:string,id:string):Promise<ProjectAlert|null>{const rows=await this.queryRows<ProjectAlertRow>("select alert.*,endpoint.name as endpoint_name from project_alerts alert left join model_endpoints endpoint on endpoint.project_id=alert.project_id and endpoint.id=alert.endpoint_id where alert.project_id=$1 and alert.id=$2",[projectId,id]);return rows[0]?mapAlert(rows[0]):null}
  async transitionProjectAlert(projectId: string, id: string, status: "resolved" | "dismissed", updatedAt: string): Promise<ProjectAlert | null> { const column = status === "resolved" ? "resolved_at" : "dismissed_at"; const rows = await this.queryRows<ProjectAlertRow>(`with updated as (update project_alerts set status=$3, ${column}=$4, updated_at=$4 where project_id=$1 and id=$2 and status='active' returning *) select updated.*,endpoint.name as endpoint_name from updated left join model_endpoints endpoint on endpoint.project_id=updated.project_id and endpoint.id=updated.endpoint_id`, [projectId, id, status, updatedAt]); return rows[0] ? mapAlert(rows[0]) : null; }
  async updateProjectAlertState(projectId:string,id:string,input:{acknowledgedAt?:string;acknowledgedBy?:string;silencedUntil?:string|null},updatedAt:string){const rows=await this.queryRows<ProjectAlertRow>(`with updated as (update project_alerts set acknowledged_at=coalesce($3,acknowledged_at),acknowledged_by=coalesce($4,acknowledged_by),silenced_until=case when $5::boolean then $6::timestamptz else silenced_until end,updated_at=$7 where project_id=$1 and id=$2 and status='active' returning *) select updated.*,endpoint.name as endpoint_name from updated left join model_endpoints endpoint on endpoint.project_id=updated.project_id and endpoint.id=updated.endpoint_id`,[projectId,id,input.acknowledgedAt??null,input.acknowledgedBy??null,Object.hasOwn(input,'silencedUntil'),input.silencedUntil??null,updatedAt]);return rows[0]?mapAlert(rows[0]):null}
  async updateProjectAlertDeliveryStatus(projectId: string, id: string, status: ProjectAlert["deliveryStatus"], updatedAt: string): Promise<ProjectAlert | null> { const rows = await this.queryRows<ProjectAlertRow>("update project_alerts set delivery_status=$3, updated_at=$4 where project_id=$1 and id=$2 returning *", [projectId, id, status, updatedAt]); return rows[0] ? mapAlert(rows[0]) : null; }
  async appendProjectAuditEvent(event: ProjectAuditEvent): Promise<void> { await this.pool.query("insert into project_audit_events (id,project_id,actor_id,subject_user_id,action,status,resource_kind,resource_id,detail,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (id) do nothing", [event.id,event.projectId,event.actorId,event.subjectUserId??null,event.action,event.status,event.resourceKind,event.resourceId,sanitizeProjectAuditDetail(event.detail),event.createdAt]); }
  async queryProjectAuditEvents(projectId:string,query:import("../../ports/src/store.js").ProjectAuditStoreQuery):Promise<import("../../ports/src/store.js").ProjectAuditStorePage>{
    const values:unknown[]=[projectId],where=["event.project_id=$1"];
    const add=(sql:string,value:unknown)=>{values.push(value);where.push(sql.replace("?",`$${values.length}`))};
    if(Object.hasOwn(query,"actorId"))query.actorId===null?where.push("event.actor_id is null"):add("event.actor_id=?",query.actorId);
    if(Object.hasOwn(query,"subjectUserId"))query.subjectUserId===null?where.push("event.subject_user_id is null"):add("event.subject_user_id=?",query.subjectUserId);
    if(query.action)add("event.action=?",query.action);
    if(query.status)add("event.status=?",query.status);
    if(query.resourceKind)add("event.resource_kind=?",query.resourceKind);
    if(query.resourceId)add("event.resource_id=?",query.resourceId);
    if(query.from)add("event.created_at>=?",query.from);
    if(query.to)add("event.created_at<=?",query.to);
    if(query.after){values.push(query.after.createdAt,query.after.id);where.push(`(event.created_at,event.id collate "C")<($${values.length-1}::timestamptz,$${values.length}::text collate "C")`)}
    values.push(query.limit+1);
    const rows=await this.queryRows<ProjectAuditRow>(
      `select event.*,
              actor_profile.display_name as actor_display_name,actor.email as actor_email,
              subject_profile.display_name as subject_display_name,subject.email as subject_email
       from project_audit_events event
       left join users actor on actor.id=event.actor_id
       left join user_profile_preferences actor_profile on actor_profile.user_id=event.actor_id
       left join users subject on subject.id=event.subject_user_id
       left join user_profile_preferences subject_profile on subject_profile.user_id=event.subject_user_id
       where ${where.join(" and ")}
       order by event.created_at desc,event.id collate "C" desc
       limit $${values.length}`,
      values
    );
    const page=rows.slice(0,query.limit);
    return{items:page.map(mapAuditView),hasMore:rows.length>query.limit};
  }
  async queryProjectAuditIdentities(projectId:string,query:import("../../ports/src/store.js").ProjectAuditIdentityStoreQuery):Promise<import("../../ports/src/store.js").ProjectAuditIdentityStorePage>{
    const column=query.role==="actor"?"actor_id":"subject_user_id",values:unknown[]=[projectId,query.q],after:string[]=[];
    if(query.after){
      values.push(query.after.id);
      after.push(query.after.id.toLowerCase()===query.q
        ? `((lower(candidate.id)=$2 and candidate.id collate "C">$${values.length}::text collate "C") or lower(candidate.id)<>$2)`
        : `lower(candidate.id)<>$2 and candidate.id collate "C">$${values.length}::text collate "C"`);
    }
    values.push(query.limit+1);
    const rows=await this.queryRows<{id:string;display_name:string|null;email:string|null}>(
      `with candidate as (
         select distinct event.${column} as id
         from project_audit_events event
         where event.project_id=$1 and event.${column} is not null
       )
       select candidate.id,profile.display_name,user_account.email
       from candidate
       left join users user_account on user_account.id=candidate.id
       left join user_profile_preferences profile on profile.user_id=candidate.id
       where (
         $2='' or position(lower($2) in lower(candidate.id))>0
         or position(lower($2) in lower(coalesce(profile.display_name,'')))>0
         or position(lower($2) in lower(coalesce(user_account.email,'')))>0
       )
       ${after.length?`and ${after.join(" and ")}`:""}
       order by (lower(candidate.id)=$2) desc,candidate.id collate "C"
       limit $${values.length}`,
      values
    );
    const page=rows.slice(0,query.limit);
    return{items:page.map((row)=>({id:row.id,displayName:row.display_name,email:row.email})),hasMore:rows.length>query.limit};
  }
  async activateTaskSandboxRun(input:ActivateTaskSandboxRunInput):Promise<ActivateTaskSandboxRunResult>{return transaction(this.pool,async(client)=>{
    const lockedTask=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId]);
    const task=lockedTask.rows[0];
    const run=await selectSandboxRunWithClient(client,input.runId,true);
    if(!run||!task||!taskRunRowIdentityMatches(task,run,input))return{kind:"conflict" as const};
    if(run.state==="active"&&task.deleted_at===null&&task.archived_at===null){
      return{kind:"already_running" as const,task:mapTask(task),run};
    }
    if(run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||run.startupClaimToken!==input.startupClaimToken||run.startupActionDeadlineAt!==input.actionDeadlineAt||input.activatedAt>input.actionDeadlineAt||task.deleted_at!==null||task.archived_at!==null){
      return{kind:"conflict" as const};
    }
    const activatedRun={...run,state:"active" as const,startedAt:run.startedAt??input.activatedAt,startupClaimToken:null,startupLeaseExpiresAt:null,startupActionDeadlineAt:null,fencingToken:run.fencingToken+1,updatedAt:input.activatedAt};
    const updatedTask=await client.query<AgentTaskRow>("update agent_tasks set updated_at=$3 where id=$1 and current_run_id=$2 returning *",[input.taskId,input.runId,input.activatedAt]);
    if(!updatedTask.rows[0])throw new Error("Task sandbox activation lost its task lock");
    await updateSandboxRunWithClient(client,activatedRun);
    await insertAuditEventWithClient(client,input.auditEvent);
    return{kind:"activated" as const,task:mapTask(updatedTask.rows[0]),run:activatedRun};
  })}
  async completeSandboxRunRelease(input:CompleteSandboxRunReleaseInput):Promise<CompleteSandboxRunReleaseResult>{return transaction(this.pool,async(client)=>{
    await lockSandboxNamespaceWithClient(client,input.run.namespace);
    const project=await client.query("select id from projects where id=$1 for update",[input.run.projectId]);if(!project.rows[0])return"conflict" as const;
    const policy=await client.query("select project_id from project_resource_policies where project_id=$1 for update",[input.run.projectId]);
    const usage=await client.query("select project_id from project_resource_usage where project_id=$1 for update",[input.run.projectId]);
    if(!policy.rows[0]||!usage.rows[0])return"conflict" as const;
    const lockedTask=await client.query<SandboxReleaseTaskRow>("select task.*,project.workspace_id as project_workspace_id,project.owner_user_id as project_owner_user_id from agent_tasks task join projects project on project.id=task.project_id where task.id=$1 for update of task",[input.run.taskId]);const task=lockedTask.rows[0];
    const current=await selectSandboxRunWithClient(client,input.runId,true);if(!current||!sameRunIdentity(current,input.run))return"conflict" as const;
    const existing=await client.query<SandboxUsageSettlementRow>("select * from sandbox_usage_settlements where run_id=$1",[input.runId]);
    if(isConfirmedReleasedRun(current)){if(!existing.rows[0]||!sameSettlement(mapSandboxUsageSettlement(existing.rows[0]),input.settlement))return"conflict" as const;await setAuthoritativeActiveTaskUsageWithClient(client,current.projectId,input.run.updatedAt);await insertAuditEventWithClient(client,input.auditEvent);return"already_applied" as const;}
    if(current.startupActionDeadlineAt&&current.startupActionDeadlineAt>input.run.updatedAt)return"conflict" as const;
    if(current.fencingToken!==input.expectedFencingToken||input.run.fencingToken!==current.fencingToken+1||input.run.startupActionDeadlineAt!==null||!isConfirmedReleasedRun(input.run)||!settlementMatchesRun(input.settlement,current,input.run))return"conflict" as const;
    if(!taskMatchesActiveSandboxRunRow(task,current))return"conflict" as const;
    await client.query("insert into sandbox_usage_settlements (run_id,workspace_id,project_id,task_id,file_library_id,started_by_user_id,started_at,released_at,duration_seconds,cpu_request_millis,memory_request_bytes,cpu_limit_millis,memory_limit_bytes,release_reason) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",[input.settlement.runId,input.settlement.workspaceId,input.settlement.projectId,input.settlement.taskId,input.settlement.fileLibraryId,input.settlement.startedByUserId,input.settlement.startedAt,input.settlement.releasedAt,input.settlement.durationSeconds,input.settlement.resources.cpuRequestMillis,input.settlement.resources.memoryRequestBytes,input.settlement.resources.cpuLimitMillis,input.settlement.resources.memoryLimitBytes,input.settlement.releaseReason]);
    await updateSandboxRunWithClient(client,input.run);
    await setAuthoritativeActiveTaskUsageWithClient(client,task.project_id,input.run.updatedAt);await insertAuditEventWithClient(client,input.auditEvent);return"applied" as const;
  })}
  async failSandboxRun(input:SandboxRunFailureInput):Promise<PersistedSandboxRunState|null>{return transaction(this.pool,async(client)=>{
    const observed=await selectSandboxRunWithClient(client,input.runId);
    if(!observed)return null;
    const task=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[observed.taskId]);
    const current=await selectSandboxRunWithClient(client,input.runId,true);
    if(!current||current.fencingToken!==input.expectedFencingToken||input.startupClaimToken!==undefined&&current.startupClaimToken!==input.startupClaimToken||!["starting","active"].includes(current.state))return null;
    if(!task.rows[0]||task.rows[0].current_run_id!==current.runId||!sameTaskRunScopeRow(task.rows[0],current))return null;
    const failed:PersistedSandboxRunState={...current,state:"failed",failureCode:input.code,failureCause:input.message,terminalFailure:input.terminalFailure??current.terminalFailure??null,releaseReason:"failed",failedAt:current.failedAt??input.failedAt,releaseRequestedAt:current.releaseRequestedAt??input.failedAt,startupClaimToken:null,startupLeaseExpiresAt:null,startupActionDeadlineAt:null,cleanupClaimedAt:null,fencingToken:current.fencingToken+1,updatedAt:input.failedAt};
    await updateSandboxRunWithClient(client,failed);
    await insertAuditEventWithClient(client,input.auditEvent);
    return failed;
  })}
  async failTaskSandboxStartupAtomically(input:FailTaskSandboxStartupAtomicallyInput):Promise<FailTaskSandboxStartupAtomicallyResult>{return transaction(this.pool,async(client)=>{
    const idem=input.idempotency;
    const receipt=(await client.query<TaskIdempotencyRow>("select * from task_idempotency_records where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 for update",[idem.actorId,idem.projectId,idem.operation,idem.key])).rows[0];
    if(!receipt||receipt.request_hash!==idem.requestHash)return{kind:"conflict"};
    if(receipt.status==="completed")return{kind:"replay",responseStatus:receipt.response_status!,responseBody:mapTaskIdempotencyResponseBody(receipt.operation,receipt.response_body)};
    if(receipt.claim_token!==idem.claimToken||receipt.operation!=="terminal-start"||receipt.resource_id!==input.failure.runId)return{kind:"conflict"};
    const observed=await selectSandboxRunWithClient(client,input.failure.runId);
    if(!observed||observed.projectId!==idem.projectId)return{kind:"conflict"};
    const project=await client.query("select id from projects where id=$1 for update",[observed.projectId]);
    if(!project.rows[0])return{kind:"conflict"};
    const task=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[observed.taskId]);
    const current=await selectSandboxRunWithClient(client,input.failure.runId,true);
    if(!current||current.fencingToken!==input.failure.expectedFencingToken||!["starting","active"].includes(current.state))return{kind:"conflict"};
    if(!task.rows[0]||task.rows[0].id!==input.taskId||task.rows[0].current_run_id!==current.runId||!sameTaskRunScopeRow(task.rows[0],current)||current.startupClaimToken!==input.startupClaimToken||!strictStructuralEqual(current.resourceNames,input.resourceIdentity))return{kind:"conflict"};
    const failed:PersistedSandboxRunState={...current,state:"failed",failureCode:input.failure.code,failureCause:input.failure.message,terminalFailure:input.failure.terminalFailure??current.terminalFailure??null,releaseReason:"failed",failedAt:current.failedAt??input.failure.failedAt,releaseRequestedAt:current.releaseRequestedAt??input.failure.failedAt,startupClaimToken:null,startupLeaseExpiresAt:null,startupActionDeadlineAt:null,cleanupClaimedAt:null,fencingToken:current.fencingToken+1,updatedAt:input.failure.failedAt};
    await updateSandboxRunWithClient(client,failed);
    await insertAuditEventWithClient(client,input.failure.auditEvent);
    const completed=await client.query("update task_idempotency_records set status='completed',response_status=$7,response_body=$8::jsonb,updated_at=$9 where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 and request_hash=$5 and claim_token=$6 and status='in_progress'",[idem.actorId,idem.projectId,idem.operation,idem.key,idem.requestHash,idem.claimToken,idem.responseStatus,JSON.stringify(idem.responseBody),idem.updatedAt]);
    if(completed.rowCount!==1)throw new Error("Terminal startup failure receipt conflict");
    return{kind:"failed",run:failed};
  })}
  async markTaskSandboxStartupReady(input:import("../../ports/src/store.js").MarkTaskSandboxStartupReadyInput):Promise<PersistedSandboxRunState|null>{
    const observed=await this.sandboxRuns.get(input.runId);
    if(!observed)return null;
    return transaction(this.pool,async(client)=>{
      const project=await client.query("select id from projects where id=$1 for update",[observed.projectId]);
      if(!project.rows[0])return null;
      const task=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId]);
      const run=await selectSandboxRunWithClient(client,input.runId,true);
      if(!run||run.projectId!==observed.projectId||run.fencingToken!==input.expectedFencingToken||run.state!=="starting"||run.taskId!==input.taskId)return null;
      if(!task.rows[0]||task.rows[0].deleted_at||task.rows[0].archived_at||task.rows[0].current_run_id!==run.runId||!sameTaskRunScopeRow(task.rows[0],run))return null;
      if(run.startupReadyAt!==null)return run;
      const ready={...run,startupReadyAt:input.readyAt,updatedAt:input.readyAt};
      await updateSandboxRunWithClient(client,ready);
      return ready;
    });
  }
  async claimSandboxStartup(input:SandboxStartupOperationInput):Promise<import("../../ports/src/store.js").SandboxStartupClaimResult>{
    const observed=await this.sandboxRuns.get(input.runId);
    if(!observed)return{kind:"stale"};
    return transaction(this.pool,async(client)=>{
      const project=await client.query("select id from projects where id=$1 for update",[observed.projectId]);
      if(!project.rows[0])return{kind:"stale" as const};
      const task=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId]);
      const run=await selectSandboxRunWithClient(client,input.runId,true);
      if(!run||run.projectId!==observed.projectId||run.fencingToken!==input.expectedFencingToken||run.state!=="starting"||run.taskId!==input.taskId)return{kind:"stale" as const};
      if(!task.rows[0]||task.rows[0].deleted_at||task.rows[0].archived_at||task.rows[0].current_run_id!==run.runId||!sameTaskRunScopeRow(task.rows[0],run))return{kind:"stale" as const};
      if(run.startupReadyAt===null)return{kind:"not_ready" as const,runId:run.runId};
      if(run.startupActionDeadlineAt!==null)return{kind:"in_progress" as const,runId:run.runId};
      const startupLeaseExpiresAt=run.startupLeaseExpiresAt??null;
      if(run.startupClaimToken!==null&&run.startupClaimToken!==input.claimToken&&startupLeaseExpiresAt!==null&&startupLeaseExpiresAt>input.claimedAt)return{kind:"in_progress" as const,runId:run.runId};
      await updateSandboxRunWithClient(client,{...run,startupClaimToken:input.claimToken,startupLeaseExpiresAt:input.leaseExpiresAt,updatedAt:input.claimedAt});
      return{kind:"claimed" as const,runId:run.runId,claim:input.claimToken};
    });
  }
  async beginSandboxStartupAction(input:import("../../ports/src/store.js").BeginSandboxStartupActionInput):Promise<PersistedSandboxRunState|null>{
    const observed=await this.sandboxRuns.get(input.runId);if(!observed)return null;
    return transaction(this.pool,async(client)=>{
      const project=await client.query("select id from projects where id=$1 for update",[observed.projectId]);if(!project.rows[0])return null;
      const task=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId])).rows[0];
      const run=await selectSandboxRunWithClient(client,input.runId,true);
      if(!task||!run||task.current_run_id!==run.runId||!sameTaskRunScopeRow(task,run)||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||run.startupClaimToken!==input.claimToken||run.startupActionDeadlineAt!==null||input.actionDeadlineAt<=input.startedAt)return null;
      const started={...run,startupActionDeadlineAt:input.actionDeadlineAt,updatedAt:input.startedAt};
      await updateSandboxRunWithClient(client,started);
      return started;
    });
  }
  async completeSandboxStartupAction(input:import("../../ports/src/store.js").CompleteSandboxStartupActionInput):Promise<PersistedSandboxRunState|null>{
    const observed=await this.sandboxRuns.get(input.runId);if(!observed)return null;
    return transaction(this.pool,async(client)=>{
      const project=await client.query("select id from projects where id=$1 for update",[observed.projectId]);if(!project.rows[0])return null;
      const task=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId])).rows[0];
      const run=await selectSandboxRunWithClient(client,input.runId,true);
      if(!task||!run||task.current_run_id!==run.runId||!sameTaskRunScopeRow(task,run)||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||run.startupClaimToken!==input.claimToken||run.startupActionDeadlineAt!==input.actionDeadlineAt||input.completedAt>input.actionDeadlineAt||input.leaseExpiresAt<=input.completedAt)return null;
      const completed={...run,startupLeaseExpiresAt:input.leaseExpiresAt,startupActionDeadlineAt:null,updatedAt:input.completedAt};
      await updateSandboxRunWithClient(client,completed);
      return completed;
    });
  }
  async drainSandboxStartupAction(input:import("../../ports/src/store.js").DrainSandboxStartupActionInput):Promise<PersistedSandboxRunState|null>{
    const observed=await this.sandboxRuns.get(input.runId);if(!observed)return null;
    return transaction(this.pool,async(client)=>{
      const project=await client.query("select id from projects where id=$1 for update",[observed.projectId]);if(!project.rows[0])return null;
      const task=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId])).rows[0];
      const run=await selectSandboxRunWithClient(client,input.runId,true);
      if(!task||!run||task.current_run_id!==run.runId||!sameTaskRunScopeRow(task,run)||run.state!=="starting"||run.fencingToken!==input.expectedFencingToken||run.startupClaimToken!==input.claimToken||run.startupActionDeadlineAt!==input.actionDeadlineAt||input.actionDeadlineAt>input.drainedAt||run.cleanupClaimedAt===null)return null;
      const drained={...run,state:"failed" as const,failureCode:input.failureCode,failureCause:input.failureMessage,releaseReason:"failed" as const,failedAt:run.failedAt??input.drainedAt,releaseRequestedAt:run.releaseRequestedAt??input.drainedAt,startupClaimToken:null,startupLeaseExpiresAt:null,startupActionDeadlineAt:null,cleanupClaimedAt:null,lastCleanupAt:input.drainedAt,lastCleanupError:null,fencingToken:run.fencingToken+1,updatedAt:input.drainedAt};
      await updateSandboxRunWithClient(client,drained);
      await insertAuditEventWithClient(client,input.auditEvent);
      return drained;
    });
  }
  async querySandboxUsageSettlements(query:ProjectSandboxSettlementQuery):Promise<ProjectSandboxSettlementPage>{
    const values:unknown[]=[query.projectId,query.selectedUserId,query.scopeMeasuredAt],where=["settlement.project_id=$1","settlement.started_by_user_id=$2","settlement.released_at<=$3"];
    if(query.after){values.push(query.after.releasedAt,query.after.runId);where.push(`(settlement.released_at,settlement.run_id collate "C")<($${values.length-1}::timestamptz,$${values.length}::text collate "C")`)}
    values.push(query.limit+1);
    const rows=await this.queryRows<SandboxUsageHistoryRow>(`select settlement.*,task.title as task_title,(task.id is not null) as task_available from sandbox_usage_settlements settlement left join agent_tasks task on task.id=settlement.task_id and task.deleted_at is null where ${where.join(" and ")} order by settlement.released_at desc,settlement.run_id collate "C" desc limit $${values.length}`,values);
    const page=rows.slice(0,query.limit);
    return{items:page.map((row)=>{const settlement=mapSandboxUsageSettlement(row);return{taskId:settlement.taskId,taskTitle:row.task_available?row.task_title:null,taskAvailable:row.task_available,runId:settlement.runId,fileLibraryId:settlement.fileLibraryId,startedAt:settlement.startedAt,releasedAt:settlement.releasedAt,durationSeconds:settlement.durationSeconds,resources:settlement.resources,releaseReason:settlement.releaseReason}}),hasMore:rows.length>query.limit};
  }
  async listSandboxUsageSettlements(projectId:string,startedByUserId:string):Promise<SandboxUsageSettlement[]>{const rows=await this.queryRows<SandboxUsageSettlementRow>("select * from sandbox_usage_settlements where project_id=$1 and started_by_user_id=$2 order by released_at desc,run_id desc",[projectId,startedByUserId]);return rows.map(mapSandboxUsageSettlement)}

  async createProjectCredential(value: StoredProjectCredential): Promise<ProjectCredential> {
    const rows = await this.queryRows<ProjectCredentialRow>(
      `insert into project_credentials (id,project_id,name,type,base_url,key_id,nonce,ciphertext,auth_tag,fingerprint,version,created_at,last_rotated_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [value.id,value.projectId,value.name,value.type,value.baseUrl,value.keyId,value.nonce,value.ciphertext,value.authTag,value.fingerprint,value.version,value.createdAt,value.lastRotatedAt,value.updatedAt]
    );
    return mapCredential(rows[0]!);
  }
  async findStoredProjectCredential(projectId:string,id:string):Promise<StoredProjectCredential|null>{const rows=await this.queryRows<ProjectCredentialRow>("select * from project_credentials where project_id=$1 and id=$2",[projectId,id]);return rows[0]?mapStoredCredential(rows[0]):null}
  async findProjectCredentialView(projectId:string,id:string):Promise<ProjectCredential|null>{const rows=await this.queryRows<ProjectCredentialRow>("select id,project_id,name,type,base_url,fingerprint,version,created_at,last_rotated_at,updated_at from project_credentials where project_id=$1 and id=$2",[projectId,id]);return rows[0]?mapCredential(rows[0]):null}
  async listProjectCredentialDirectoryPage(projectId:string,query:import("../../ports/src/store.js").CreatedDirectoryStoreQuery):Promise<ProjectCredential[]>{
    const values:unknown[]=[projectId],where=["project_id=$1"];
    if(query.q){values.push(query.q);const q=`$${values.length}`;where.push(`(position(${q} in lower(name))>0 or position(${q} in lower(base_url))>0 or position(${q} in lower(id))>0)`)}
    if(query.after){values.push(query.after.createdAt,query.after.id);where.push(`(created_at,id collate "C")<($${values.length-1}::timestamptz,$${values.length}::text collate "C")`)}
    values.push(query.limit);
    const rows=await this.queryRows<ProjectCredentialRow>(`select id,project_id,name,type,base_url,fingerprint,version,created_at,last_rotated_at,updated_at from project_credentials where ${where.join(" and ")} order by created_at desc,id collate "C" desc limit $${values.length}`,values);
    return rows.map(mapCredential);
  }
  async updateProjectCredential(value: StoredProjectCredential, expectedVersion: number): Promise<ProjectCredential | "not_found" | "version_conflict"> {
    return transaction(this.pool, async (client) => {
      const rows=(await client.query<ProjectCredentialRow>(`update project_credentials set name=$2,base_url=$3,key_id=$4,nonce=$5,ciphertext=$6,auth_tag=$7,fingerprint=$8,version=$9,last_rotated_at=$10,updated_at=$11 where id=$1 and project_id=$12 and version=$13 returning *`,[value.id,value.name,value.baseUrl,value.keyId,value.nonce,value.ciphertext,value.authTag,value.fingerprint,value.version,value.lastRotatedAt,value.updatedAt,value.projectId,expectedVersion])).rows;
      if (!rows[0]) return (await client.query<{present:boolean}>("select true as present from project_credentials where id=$1",[value.id])).rows[0]?.present ? "version_conflict" : "not_found";
      await client.query("update model_endpoints set health_status='unknown',health_checked_at=null,health_error_category=null,updated_at=$2 where credential_id=$1",[value.id,value.updatedAt]);
      return mapCredential(rows[0]);
    });
  }
  async deleteProjectCredential(id: string, projectId: string, expectedVersion: number): Promise<DeleteProjectCredentialResult> {
    return transaction(this.pool, async (client) => {
      const credential = await client.query<{ version: number }>("select version from project_credentials where id=$1 and project_id=$2 for update", [id, projectId]);
      if (!credential.rows[0]) return "not_found";
      if (credential.rows[0].version !== expectedVersion) return "version_conflict";
      if ((await client.query("select 1 from model_endpoints where credential_id=$1 limit 1", [id])).rowCount) return "referenced_by_endpoints";
      return (await client.query("delete from project_credentials where id=$1 and project_id=$2 and version=$3", [id, projectId, expectedVersion])).rowCount === 1 ? "deleted" : "version_conflict";
    });
  }
  async createEndpoint(endpoint: ModelEndpoint, expectedCredentialVersion?: number): Promise<ModelEndpoint> {
    try {
      await transaction(this.pool, async (client) => {
      if (expectedCredentialVersion !== undefined) await lockCredentialVersion(client, endpoint.projectId, endpoint.credentialId, expectedCredentialVersion);
      await client.query(
      `insert into model_endpoints (
         id, project_id, name, protocol, base_url, model, credential_id,
         capabilities, request_timeout_secs, health_status, health_checked_at, health_error_category, created_at, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)`,
      [
        endpoint.id,
        endpoint.projectId,
        endpoint.name,
        endpoint.protocol,
        endpoint.baseUrl,
        endpoint.model,
        endpoint.credentialId,
        JSON.stringify(endpoint.capabilities),
        endpoint.requestTimeoutSecs,
        endpoint.health?.status ?? "unknown",
        endpoint.health?.checkedAt ?? null,
        endpoint.health?.errorCategory ?? null,
        endpoint.createdAt,
        endpoint.updatedAt
      ]
      );
      });
    } catch (error) {
      if (isConstraintError(error, "model_endpoints_project_name_unique")) throw new EndpointNameConflictError();
      throw error;
    }
    return structuredClone(endpoint);
  }

  async updateEndpoint(endpoint: ModelEndpoint, expectedUpdatedAt?: string, expectedCredentialVersion?: number): Promise<ModelEndpoint | null> {
    let rows: ModelEndpointRow[];
    try {
      rows = await transaction(this.pool, async (client) => {
      if (expectedCredentialVersion !== undefined) await lockCredentialVersion(client, endpoint.projectId, endpoint.credentialId, expectedCredentialVersion);
      return (await client.query<ModelEndpointRow>(
      `update model_endpoints
       set name = $2, protocol = $3, base_url = $4, model = $5, credential_id=$6,
           capabilities = $7::jsonb, request_timeout_secs = $8, health_status=$9, health_checked_at=$10, health_error_category=$11, updated_at = $12
       where id = $1 and ($13::timestamptz is null or updated_at = $13::timestamptz)
       returning *`,
      [
        endpoint.id,
        endpoint.name,
        endpoint.protocol,
        endpoint.baseUrl,
        endpoint.model,
        endpoint.credentialId,
        JSON.stringify(endpoint.capabilities),
        endpoint.requestTimeoutSecs,
        endpoint.health?.status ?? "unknown",
        endpoint.health?.checkedAt ?? null,
        endpoint.health?.errorCategory ?? null,
        endpoint.updatedAt,
        expectedUpdatedAt ?? null
      ]
      )).rows;
      });
    } catch (error) {
      if (isConstraintError(error, "model_endpoints_project_name_unique")) throw new EndpointNameConflictError();
      throw error;
    }
    return rows[0] ? mapEndpoint(rows[0]) : null;
  }

  async updateEndpointHealth(id: string, projectId: string, health: EndpointHealth, updatedAt: string, expectedUpdatedAt?: string, expectedCredentialVersion?: number): Promise<ModelEndpoint | null> {
    const rows = await transaction(this.pool, async (client) => {
      if (expectedCredentialVersion !== undefined) {
        const endpoint = await client.query<{credential_id:string}>("select credential_id from model_endpoints where id=$1 and project_id=$2", [id,projectId]);
        if (!endpoint.rows[0]) return [];
        await lockCredentialVersion(client, projectId, endpoint.rows[0].credential_id, expectedCredentialVersion);
      }
      return (await client.query<ModelEndpointRow>(
      `update model_endpoints
       set health_status=$3, health_checked_at=$4, health_error_category=$5, updated_at=$6
       where id=$1 and project_id=$2 and ($7::timestamptz is null or updated_at=$7::timestamptz)
       returning *`,
      [id, projectId, health.status, health.checkedAt, health.errorCategory, updatedAt, expectedUpdatedAt ?? null]
    )).rows;
    });
    return rows[0] ? mapEndpoint(rows[0]) : null;
  }

  async deleteEndpoint(id: string): Promise<DeleteEndpointResult> {
    return transaction(this.pool, async (client) => {
      const endpoint = await client.query<{ id: string }>(
        "select id from model_endpoints where id = $1 for update",
        [id]
      );
      if (endpoint.rowCount !== 1) return "not_found";

      const task = await client.query(
        "select 1 from agent_tasks where endpoint_id = $1 limit 1",
        [id]
      );
      if (task.rowCount) return "referenced_by_tasks";

      await client.query(
        "update project_alerts set status = 'resolved', resolved_at = coalesce(resolved_at, clock_timestamp()), updated_at = clock_timestamp() where endpoint_id = $1 and status = 'active'",
        [id]
      );
      await client.query("update project_provider_settlements set endpoint_id = null where endpoint_id = $1", [id]);
      const deleted = await client.query("delete from model_endpoints where id = $1", [id]);
      return deleted.rowCount === 1 ? "deleted" : "not_found";
    });
  }

  async findEndpoint(id: string): Promise<ModelEndpoint | null> {
    const rows = await this.queryRows<ModelEndpointRow>("select * from model_endpoints where id = $1", [id]);
    return rows[0] ? mapEndpoint(rows[0]) : null;
  }
  async findEndpointView(projectId:string,id:string):Promise<import("../../contracts/src/api.js").EndpointView|null>{
    const rows=await this.queryRows<EndpointViewRow>(`${endpointViewSelect} where endpoint.project_id=$1 and endpoint.id=$2`,[projectId,id]);
    return rows[0]?mapEndpointView(rows[0]):null;
  }
  async listEndpointDirectoryPage(projectId:string,query:import("../../ports/src/store.js").EndpointDirectoryStoreQuery):Promise<import("../../ports/src/store.js").EndpointDirectoryStorePage>{
    const values:unknown[]=[projectId],filters=["endpoint.project_id=$1"];
    if(query.q){values.push(query.q);const q=`$${values.length}`;filters.push(`(position(${q} in lower(endpoint.name))>0 or position(${q} in lower(endpoint.model))>0 or position(${q} in lower(endpoint.base_url))>0 or position(${q} in lower(endpoint.id))>0)`)}
    if(query.mode==="task_ready")filters.push(`endpoint.credential_id<>'' and endpoint.health_status='healthy' and endpoint.capabilities @> '["text","tool_calls"]'::jsonb`);
    const total=Number((await this.queryRows<{count:string}>(`select count(*)::text as count from model_endpoints endpoint where ${filters.join(" and ")}`,values))[0]?.count??0);
    const pageValues=[...values],pageFilters=[...filters];
    if(query.after){pageValues.push(query.after.createdAt,query.after.id);pageFilters.push(`(endpoint.created_at,endpoint.id collate "C")<($${pageValues.length-1}::timestamptz,$${pageValues.length}::text collate "C")`)}
    pageValues.push(query.limit);
    const rows=await this.queryRows<EndpointViewRow>(`${endpointViewSelect} where ${pageFilters.join(" and ")} order by endpoint.created_at desc,endpoint.id collate "C" desc limit $${pageValues.length}`,pageValues);
    return{items:rows.map(mapEndpointView),total};
  }
  async projectEndpointNameExists(projectId:string,normalizedName:string,excludeId?:string):Promise<boolean>{const values:unknown[]=[projectId,normalizedName],exclude=excludeId===undefined?"":` and id<>$${values.push(excludeId)}`;return Number((await this.queryRows<{present:number}>(`select 1 as present from model_endpoints where project_id=$1 and lower(btrim(name))=$2${exclude} limit 1`,values))[0]?.present??0)===1}
  async findProjectEndpointIds(projectId:string,ids:string[]):Promise<string[]>{if(ids.length===0)return[];return(await this.queryRows<{id:string}>('select id from model_endpoints where project_id=$1 and id=any($2::text[]) order by id collate "C"',[projectId,[...new Set(ids)]])).map((row)=>row.id)}
  async getProjectEndpointReadiness(projectId:string):Promise<{total:number;taskReady:number}>{const row=(await this.queryRows<{total:string;task_ready:string}>(`select count(*)::text as total,count(*) filter (where credential_id<>'' and health_status='healthy' and capabilities @> '["text","tool_calls"]'::jsonb)::text as task_ready from model_endpoints where project_id=$1`,[projectId]))[0];return{total:Number(row?.total??0),taskReady:Number(row?.task_ready??0)}}

  async createTaskAtomically(input: AtomicTaskCreateInput) {
    validateTaskRunReservation(input);
    try{return await transaction(this.pool, async (client) => {
      const write=async(insertRun:()=>Promise<void>)=>{
        if(input.newFileLibrary){const library=input.newFileLibrary;await client.query("insert into file_libraries(id,workspace_id,project_id,name,root_sub_path,created_by_user_id,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8)",[library.id,library.workspaceId,library.projectId,library.name,library.rootSubPath,library.createdByUserId,library.createdAt,library.updatedAt]);}
        const library=await client.query("select id from file_libraries where id=$1 and workspace_id=$2 and project_id=$3 for update",[input.task.fileLibraryId,input.task.workspaceId,input.task.projectId]);
        if(!library.rows[0])return{kind:"library_not_found" as const};
        const bound=await client.query("select id from agent_tasks where file_library_id=$1",[input.task.fileLibraryId]);
        if(bound.rows[0])return{kind:"already_bound" as const};
        const row=await insertTaskWithClient(client,{...input.task,currentRunId:null});
        if(input.runtimeState)await putJsonDocumentWithClient(client,"sandbox_runtime_state",input.task.id,input.runtimeState);
        if(input.sandboxRun){
          await insertRun();
          await client.query("update agent_tasks set current_run_id=$2 where id=$1",[input.task.id,input.sandboxRun.runId]);
          row.current_run_id=input.sandboxRun.runId;
        }
        if(input.initialMessage)await insertPersistedTaskMessageWithClient(client,input.initialMessage);
        if(input.initialInteractionChange)await persistTaskInteractionChangesWithClient(client,input.task.id,[input.initialInteractionChange]);
        if(input.auditEvent)await insertAuditEventWithClient(client,input.auditEvent);
        return{kind:"created" as const,task:mapTask(row)};
      };
      if(input.reserveActive){
        const idempotency=requiredAdmissionCreateIdempotency(input);
        const claimed=await claimTaskIdempotencyWithClient(client,idempotency);
        if(claimed.kind!=="claimed")return claimed;
        if(claimed.row.resource_id!==input.task.id)throw new Error("Task create idempotency resource is inconsistent");
        return admitSandboxRunWithClient<AtomicTaskCreateResult>(
          client,input.admission,input.sandboxRun!,input.task.updatedAt,idempotency,input.rejectionPresentation!,input.rejectedAuditEvent!,
          {kind:"project_unavailable" as const},
          async()=>({kind:"ready"}),
          write
        );
      }
      if(!await lockActiveProjectWithClient(client,input.task.projectId))return{kind:"project_unavailable" as const};
      return write(async()=>{
        if(!input.sandboxRun||input.sandboxRun.state!=="released")throw new Error("Unreleased Sandbox Run insertion requires admission");
        await insertSandboxRunWithClient(client,input.sandboxRun);
      });
    });}catch(error){
      if(isConstraintError(error,"file_libraries_project_name_unique")||isConstraintError(error,"file_libraries_pkey")||isConstraintError(error,"file_libraries_project_id_root_sub_path_key"))return{kind:"library_name_conflict" as const};
      if(isConstraintError(error,"agent_tasks_file_library_active_unique"))return{kind:"already_bound" as const};
      if(isForeignKeyConstraintError(error,"agent_tasks_file_library_scope_fkey"))return{kind:"library_not_found" as const};
      throw error;
    }
  }

  async beginTerminalStart(input:import("../../ports/src/store.js").BeginTerminalStartInput):Promise<import("../../ports/src/store.js").BeginTerminalStartResult>{return transaction(this.pool,async(client)=>{
    const claimed=await claimTaskIdempotencyWithClient(client,input.idempotency);
    if(claimed.kind==="hash_mismatch"||claimed.kind==="replay")return claimed;
    const receipt=claimed.kind==="claimed"?claimed.row:(await client.query<TaskIdempotencyRow>(
      "select * from task_idempotency_records where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4",
      [input.idempotency.actorId,input.idempotency.projectId,input.idempotency.operation,input.idempotency.key]
    )).rows[0];
    if(!receipt)return{kind:"conflict"};
    if(claimed.kind==="in_progress"){
      const project=await client.query("select id from projects where id=$1 for update",[input.idempotency.projectId]);
      if(!project.rows[0])return{kind:"conflict"};
      const task=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId])).rows[0];
      const run=await selectSandboxRunWithClient(client,receipt.resource_id,true);
      if(!task||!run||!sameTaskRunScopeRow(task,run))return{kind:"conflict"};
      if(task.current_run_id===run.runId&&run.state==="starting")return{kind:"in_progress",task:mapTask(task),run};
      const terminal=terminalBoundRunReceipt(run,input.rejectionPresentation);
      await completeTaskIdempotencyWithClient(client,{...input.idempotency,claimToken:receipt.claim_token},terminal.responseStatus,terminal.responseBody,input.idempotency.now);
      return{kind:"replay",...terminal};
    }
    const observed=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1",[input.taskId])).rows[0];
    if(!observed||observed.deleted_at||observed.archived_at||observed.project_id!==input.idempotency.projectId)return{kind:"conflict"};
    const boundRun=await selectSandboxRunWithClient(client,receipt.resource_id);
    if(boundRun&&sameTaskRunScopeRow(observed,boundRun)){
      const project=await client.query("select id from projects where id=$1 for update",[observed.project_id]);
      if(!project.rows[0])return{kind:"conflict"};
      const task=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId])).rows[0];
      const run=await selectSandboxRunWithClient(client,receipt.resource_id,true);
      if(!task||!run||!sameTaskRunScopeRow(task,run))return{kind:"conflict"};
      if(task.current_run_id===run.runId&&run.state==="starting")return{kind:"claimed",task:mapTask(task),run,claimToken:input.idempotency.claimToken};
      const terminal=terminalBoundRunReceipt(run,input.rejectionPresentation);
      await completeTaskIdempotencyWithClient(client,input.idempotency,terminal.responseStatus,terminal.responseBody,input.idempotency.now);
      return{kind:"replay",...terminal};
    }
    const restart=input.restart;
    if(!restart||restart.sandboxRun.runId!==receipt.resource_id)return{kind:"conflict"};
    if(!input.admission||!input.rejectedAuditEvent)throw new Error("New Terminal reservation requires admission receipt inputs");
    let row:AgentTaskRow|undefined;
    return admitSandboxRunWithClient<import("../../ports/src/store.js").BeginTerminalStartResult>(
      client,input.admission,{...restart.sandboxRun,startupReadyAt:restart.reservedAt},restart.reservedAt,input.idempotency,input.rejectionPresentation,input.rejectedAuditEvent,
      {kind:"conflict"},
      async()=>{
        row=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId])).rows[0];
        if(!row||row.deleted_at||row.archived_at||row.current_run_id!==restart.expectedReleasedRunId)return{kind:"result",value:{kind:"conflict"}};
        const current=row.current_run_id?await selectSandboxRunWithClient(client,row.current_run_id,true):null;
        if(row.current_run_id!==null&&(!current||current.state!=="released"||!sameTaskRunScopeRow(row,current)))return{kind:"result",value:{kind:"conflict"}};
        if(!sandboxRestartRowIdentityMatches(row,{expectedReleasedRunId:restart.expectedReleasedRunId,task:restart.task,sandboxRun:restart.sandboxRun}))return{kind:"result",value:{kind:"conflict"}};
        return{kind:"ready"};
      },
      async(insertRun)=>{
        await insertRun();
        const updated=(await client.query<AgentTaskRow>("update agent_tasks set current_run_id=$2,updated_at=$3 where id=$1 and current_run_id is not distinct from $4 returning *",[input.taskId,restart.sandboxRun.runId,restart.reservedAt,restart.expectedReleasedRunId])).rows[0];
        if(!updated)throw new Error("Terminal reservation lost its Task lock");
        await putJsonDocumentWithClient(client,"sandbox_runtime_state",input.taskId,restart.runtimeState);
        return{kind:"claimed",task:mapTask(updated),run:{...restart.sandboxRun,startupReadyAt:restart.reservedAt},claimToken:input.idempotency.claimToken};
      }
    );
  })}

  async restartTaskSandboxAtomically(input:AtomicTaskSandboxRestartInput):Promise<AtomicTaskSandboxRestartResult>{return transaction(this.pool,async(client)=>{
    let row:AgentTaskRow|undefined;
    const receipt=requiredSandboxRestartAdmission(input);
    const claimed=await claimTaskIdempotencyWithClient(client,receipt.idempotency);
    if(claimed.kind!=="claimed")return claimed;
    if(claimed.row.resource_id!==input.task.id)throw new Error("Terminal start idempotency resource is inconsistent");
    return admitSandboxRunWithClient<AtomicTaskSandboxRestartResult>(
      client,input.admission,input.sandboxRun,input.reservedAt,receipt.idempotency,receipt.presentation,receipt.auditEvent,
      {kind:"conflict" as const},
      async()=>{
        row=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.task.id])).rows[0];
        if(!row||row.deleted_at||row.archived_at||row.current_run_id!==input.expectedReleasedRunId)return{kind:"result",value:{kind:"conflict" as const}};
        if(input.expectedReleasedRunId!==null){
          const released=await selectSandboxRunWithClient(client,input.expectedReleasedRunId,true);
          if(!released||!sameTaskRunScopeRow(row,released)||released.state!=="released")return{kind:"result",value:{kind:"conflict" as const}};
        }
        if(!sandboxRestartRowIdentityMatches(row,input))return{kind:"result",value:{kind:"conflict" as const}};
        return{kind:"ready"};
      },
      async(insertRun)=>{
        await insertRun();
        const updated=await client.query<AgentTaskRow>(`update agent_tasks set current_run_id=$2,updated_at=$3 where id=$1 and current_run_id is not distinct from $4 returning *`,[row!.id,input.sandboxRun.runId,input.reservedAt,input.expectedReleasedRunId]);
        if(!updated.rows[0])throw new Error("Task sandbox restart lost its task lock");
        await putJsonDocumentWithClient(client,"sandbox_runtime_state",row!.id,input.runtimeState);
        return{kind:"restarted" as const,task:mapTask(updated.rows[0])};
      }
    );
  })}

  async createTaskMessageAtomically(input:AtomicTaskMessageInput):Promise<AtomicTaskMessageResult>{return transaction(this.pool,async(client)=>{
    const idem=input.idempotency;
    const claimed=await claimTaskIdempotencyWithClient(client,idem);
    if(claimed.kind!=="claimed")return claimed;
    if(!input.restart){
      if(!await lockActiveProjectWithClient(client,idem.projectId))return{kind:"conflict" as const};
      const row=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId])).rows[0];
      if(!row||row.deleted_at||row.archived_at||row.project_id!==idem.projectId)return{kind:"conflict" as const};
      const message=canonicalTaskMessage(input.message,claimed.row.resource_id);
      const existingMessage=(await client.query<TaskMessageRow>("select * from task_messages where id=$1",[message.id])).rows[0];
      if(existingMessage)return{kind:"created" as const,task:mapTask(row),message:mapPersistedTaskMessage(existingMessage),restarted:false};
      const currentRun=row.current_run_id?await selectSandboxRunWithClient(client,row.current_run_id,true):null;
      if(!currentRun||!sameTaskRunScopeRow(row,currentRun)||!["starting","active"].includes(currentRun.state))return{kind:"conflict" as const};
      const created=mapPersistedTaskMessage(await insertPersistedTaskMessageWithClient(client,message));
      await persistTaskInteractionChangesWithClient(client,input.taskId,[input.interactionChange]);
      await insertAuditEventWithClient(client,canonicalMessageAuditEvent(input.auditEvent,created,row.project_id));
      await completeTaskIdempotencyWithClient(client,input.idempotency,input.responseStatus,input.responseBody,created.updatedAt??created.createdAt);
      return{kind:"created" as const,task:mapTask(row),message:created,restarted:false};
    }

    let row:AgentTaskRow|undefined;
    let message:PersistedTaskMessage|undefined;
    let currentRun:PersistedSandboxRunState|null=null;
    let restarted=false;
    const receipt=requiredMessageAdmissionReceipt(input);
    return admitSandboxRunWithClient<AtomicTaskMessageResult>(
      client,input.admission,{...input.restart.sandboxRun,startupReadyAt:input.restart.reservedAt},input.restart.reservedAt,input.idempotency,receipt.presentation,receipt.auditEvent,
      {kind:"conflict" as const},
      async()=>{
        row=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId])).rows[0];
        if(!row||row.deleted_at||row.archived_at||row.project_id!==idem.projectId)return{kind:"result",value:{kind:"conflict" as const}};
        message=canonicalTaskMessage(input.message,claimed.row.resource_id);
        const existingMessage=(await client.query<TaskMessageRow>("select * from task_messages where id=$1",[message.id])).rows[0];
        if(existingMessage)return{kind:"result",value:{kind:"created" as const,task:mapTask(row),message:mapPersistedTaskMessage(existingMessage),restarted:false}};
        currentRun=row.current_run_id?await selectSandboxRunWithClient(client,row.current_run_id,true):null;
        if(currentRun&&sameTaskRunScopeRow(row,currentRun)&&["starting","active"].includes(currentRun.state))return{kind:"ready",reserve:false};
        if(row.current_run_id!==input.expectedCurrentRunId)return{kind:"result",value:{kind:"conflict" as const}};
        if(input.expectedCurrentRunId===null){
          if(currentRun!==null)return{kind:"result",value:{kind:"conflict" as const}};
        }else if(!currentRun||!sameTaskRunScopeRow(row,currentRun)||currentRun.state!=="released"){
          return{kind:"result",value:{kind:"conflict" as const}};
        }
        if(!sandboxRestartRowIdentityMatches(row,{expectedReleasedRunId:input.expectedCurrentRunId,task:input.restart!.task,sandboxRun:input.restart!.sandboxRun}))return{kind:"result",value:{kind:"conflict" as const}};
        restarted=true;
        return{kind:"ready"};
      },
      async(insertRun)=>{
        if(restarted){
          await insertRun();
          const updated=await client.query<AgentTaskRow>("update agent_tasks set current_run_id=$2,updated_at=$3 where id=$1 and current_run_id is not distinct from $4 returning *",[row!.id,input.restart!.sandboxRun.runId,input.restart!.reservedAt,input.expectedCurrentRunId]);
          if(!updated.rows[0])throw new Error("Task message Run reservation lost its task lock");
          row=updated.rows[0];
          await putJsonDocumentWithClient(client,"sandbox_runtime_state",row.id,input.restart!.runtimeState);
          currentRun={...input.restart!.sandboxRun,startupReadyAt:input.restart!.reservedAt};
        }
        if(!currentRun||!["starting","active"].includes(currentRun.state))return{kind:"conflict" as const};
        const created=mapPersistedTaskMessage(await insertPersistedTaskMessageWithClient(client,message!));
        await persistTaskInteractionChangesWithClient(client,input.taskId,[input.interactionChange]);
        await insertAuditEventWithClient(client,canonicalMessageAuditEvent(input.auditEvent,created,row!.project_id));
        await completeTaskIdempotencyWithClient(client,input.idempotency,input.responseStatus,input.responseBody,created.updatedAt??created.createdAt);
        return{kind:"created" as const,task:mapTask(row!),message:created,restarted};
      }
    );
  })}

  async editTaskMessageAtomically(input:AtomicTaskMessageEditInput):Promise<AtomicTaskMessageEditResult>{
    try{return await transaction(this.pool,async(client)=>{
      if(!await lockActiveProjectWithClient(client,input.idempotency.projectId))throw new AtomicTaskMessageConflict();
      const claimed=await claimTaskIdempotencyWithClient(client,input.idempotency);
      if(claimed.kind!=="claimed")return claimed;
      if(claimed.row.resource_id!==input.messageId)throw new AtomicTaskMessageConflict();
      const task=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId])).rows[0];
      if(!task||task.project_id!==input.idempotency.projectId||task.deleted_at||task.archived_at)throw new AtomicTaskMessageConflict();
      const updated=await client.query<TaskMessageRow>(
        "update task_messages set content=$3,request_hash=$4,updated_at=$5 where id=$1 and task_id=$2 and delivery_status='pending' and deleted_at is null and updated_at=$6 returning *",
        [input.messageId,input.taskId,input.content,input.requestHash,input.updatedAt,input.expectedUpdatedAt]
      );
      if(!updated.rows[0])throw new AtomicTaskMessageConflict();
      await persistTaskInteractionChangesWithClient(client,input.taskId,[input.interactionChange]);
      await insertAuditEventWithClient(client,input.auditEvent);
      await completeTaskIdempotencyWithClient(client,input.idempotency,input.responseStatus,input.responseBody,input.updatedAt);
      return{kind:"updated" as const,message:mapPersistedTaskMessage(updated.rows[0])};
    });}catch(error){
      if(error instanceof AtomicTaskMessageConflict)return{kind:"conflict"};
      throw error;
    }
  }

  async deleteTaskMessageAtomically(input:AtomicTaskMessageDeleteInput):Promise<AtomicTaskMessageDeleteResult>{
    try{return await transaction(this.pool,async(client)=>{
      if(!await lockActiveProjectWithClient(client,input.idempotency.projectId))throw new AtomicTaskMessageConflict();
      const claimed=await claimTaskIdempotencyWithClient(client,input.idempotency);
      if(claimed.kind!=="claimed")return claimed;
      if(claimed.row.resource_id!==input.messageId)throw new AtomicTaskMessageConflict();
      const task=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId])).rows[0];
      if(!task||task.project_id!==input.idempotency.projectId||task.deleted_at||task.archived_at)throw new AtomicTaskMessageConflict();
      const locked=(await client.query<TaskMessageRow>("select * from task_messages where id=$1 and task_id=$2 for update",[input.messageId,input.taskId])).rows[0];
      if(!locked||!["pending","failed"].includes(locked.delivery_status))throw new AtomicTaskMessageConflict();
      const row=locked.deleted_at?locked:(await client.query<TaskMessageRow>("update task_messages set deleted_at=$2,updated_at=$2 where id=$1 returning *",[input.messageId,input.deletedAt])).rows[0]!;
      await client.query("delete from task_interaction_changes where task_id=$1 and source_kind='product' and source_id=$2",[input.taskId,`message:${input.messageId}`]);
      await insertAuditEventWithClient(client,input.auditEvent);
      await completeTaskIdempotencyWithClient(client,input.idempotency,input.responseStatus,input.responseBody,input.deletedAt);
      return{kind:"deleted" as const,message:mapPersistedTaskMessage(row)};
    });}catch(error){
      if(error instanceof AtomicTaskMessageConflict)return{kind:"conflict"};
      throw error;
    }
  }

  async updateTask(task: PersistedAgentTask): Promise<PersistedAgentTask> {
    await this.pool.query(
      `update agent_tasks
       set workspace_id = $2,
           project_id = $3,
           endpoint_id = $4,
           title = $5,
           prompt = $6,
           file_library_id = $7,
           current_run_id = $8,
           archived_at = $9,
           deleted_at = $10,
           created_at = $11,
           updated_at = $12
       where id = $1`,
      [
        task.id,
        task.workspaceId,
        task.projectId,
        task.endpointId,
        task.title ?? task.prompt.replace(/[\r\n]+/g," ").slice(0,160),
        task.prompt,
        task.fileLibraryId,
        task.currentRunId,
        task.archivedAt ?? null,
        task.deletedAt ?? null,
        task.createdAt,
        task.updatedAt
      ]
    );
    return structuredClone(task);
  }

  async listActiveTasks(): Promise<PersistedAgentTask[]> {
    const rows = await this.queryRows<AgentTaskRow>(
      `select * from agent_tasks
       where deleted_at is null and current_run_id in (select run_id from sandbox_runs where state <> 'released')
       order by created_at, id`
    );
    return rows.map(mapTask);
  }

  async listTasksForProject(projectId: string): Promise<PersistedAgentTask[]> {
    const rows = await this.queryRows<AgentTaskRow>(
      `select * from agent_tasks where project_id = $1 order by created_at, id`,
      [projectId]
    );
    return rows.map(mapTask);
  }

  async queryTasksForProject(projectId: string, query: TaskStoreListQuery): Promise<TaskStoreListPage> {
    const values: unknown[] = [projectId];
    const where = ["project_id = $1", "deleted_at is null"];
    if (query.search) {
      values.push(`%${escapeLikePattern(query.search)}%`);
      where.push(`(title ilike $${values.length} escape E'\\\\' or prompt ilike $${values.length} escape E'\\\\')`);
    }
    if (query.archived === "exclude") where.push("archived_at is null");
    if (query.archived === "only") where.push("archived_at is not null");
    const count = await this.queryRows<{ count: string }>(`select count(*)::text as count from agent_tasks where ${where.join(" and ")}`, values);
    const sortColumn = query.sort === "created_at" ? "created_at" : query.sort === "updated_at" ? "updated_at" : "title";
    const sortExpression = query.sort === "title" ? `${sortColumn} collate "C"` : sortColumn;
    const idExpression = `id collate "C"`;
    const direction = query.direction === "asc" ? "asc" : "desc";
    if (query.after) {
      values.push(query.after.value, query.after.taskId);
      const valueCast = query.sort === "title" ? "text" : "timestamptz";
      const comparison = query.direction === "asc" ? ">" : "<";
      const afterValue = query.sort === "title"
        ? `$${values.length - 1}::${valueCast} collate "C"`
        : `$${values.length - 1}::${valueCast}`;
      where.push(`(${sortExpression}, ${idExpression}) ${comparison} (${afterValue}, $${values.length}::text collate "C")`);
    }
    values.push(query.limit + 1);
    const rows = await this.queryRows<AgentTaskRow>(`select * from agent_tasks where ${where.join(" and ")} order by ${sortExpression} ${direction}, ${idExpression} ${direction} limit $${values.length}`, values);
    return { items: rows.slice(0, query.limit).map(mapTask), total: Number(count[0]?.count ?? 0), hasMore: rows.length > query.limit };
  }

  async findTask(id: string): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>("select * from agent_tasks where id = $1", [id]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async updateTaskTitle(taskId: string, title: string, updatedAt: string): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>("update agent_tasks set title=$2,updated_at=$3 where id=$1 and deleted_at is null returning *", [taskId, title, updatedAt]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async archiveTask(taskId:string,archivedAt:string,auditEvent?:ProjectAuditEvent){return transaction(this.pool,async(client)=>{
    const projectId=await lockActiveTaskProjectWithClient(client,taskId,auditEvent?.projectId);
    if(!projectId)return{kind:"not_found_or_forbidden" as const};
    const current=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[taskId])).rows[0];
    if(!current||current.project_id!==projectId||current.deleted_at)return{kind:"not_found_or_forbidden" as const};
    if(!await taskRowHasConfirmedRelease(client,current))return{kind:"sandbox_not_released" as const};
    const updated=current.archived_at?current:(await client.query<AgentTaskRow>("update agent_tasks set archived_at=$2,updated_at=$2 where id=$1 returning *",[taskId,archivedAt])).rows[0]!;
    if(auditEvent)await insertAuditEventWithClient(client,auditEvent);
    return{kind:"ready" as const,value:mapTask(updated)};
  })}

  async beginTaskDeletion(taskId:string,deletedAt:string,auditEvent?:ProjectAuditEvent){return transaction(this.pool,async(client)=>{
    const projectId=await lockActiveTaskProjectWithClient(client,taskId,auditEvent?.projectId);
    if(!projectId)return{kind:"not_found_or_forbidden" as const};
    const current=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[taskId])).rows[0];
    if(!current||current.project_id!==projectId)return{kind:"not_found_or_forbidden" as const};
    if(!await taskRowHasConfirmedRelease(client,current))return{kind:"sandbox_not_released" as const};
    const updated=(await client.query<AgentTaskRow>("update agent_tasks set deleted_at=coalesce(deleted_at,$2),updated_at=case when deleted_at is null then $2 else updated_at end where id=$1 returning *",[taskId,deletedAt])).rows[0]!;
    if(auditEvent)await insertAuditEventWithClient(client,auditEvent);
    return{kind:"ready" as const,value:mapTask(updated)};
  })}

  async purgeDeletedTaskData(taskId:string,idempotency?:CompleteTaskIdempotencyInput):Promise<boolean>{return transaction(this.pool,async(client)=>{
    const task=(await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[taskId])).rows[0];
    if(!task||!task.deleted_at||!await taskRowHasConfirmedRelease(client,task))return false;
    if(idempotency){
      const claim=await client.query("select 1 from task_idempotency_records where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 and request_hash=$5 and resource_id=$6 and claim_token=$7 and status='in_progress' for update",[idempotency.actorId,idempotency.projectId,idempotency.operation,idempotency.key,idempotency.requestHash,taskId,idempotency.claimToken]);
      if(claim.rowCount!==1)return false;
    }
    await client.query("delete from task_interaction_changes where task_id=$1",[taskId]);
    await client.query("delete from task_messages where task_id=$1",[taskId]);
    await client.query("delete from agent_task_artifacts where task_id=$1",[taskId]);
    await client.query("delete from postgres_json_docs where collection='sandbox_runtime_state' and id=$1",[taskId]);
    await client.query("update agent_tasks set current_run_id=null where id=$1",[taskId]);
    await client.query("delete from sandbox_runs where task_id=$1",[taskId]);
    await client.query("delete from agent_tasks where id=$1",[taskId]);
    if(idempotency)await client.query("update task_idempotency_records set status='completed',response_status=$7,response_body=$8::jsonb,updated_at=$9 where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 and request_hash=$5 and claim_token=$6 and status='in_progress'",[idempotency.actorId,idempotency.projectId,idempotency.operation,idempotency.key,idempotency.requestHash,idempotency.claimToken,idempotency.responseStatus,JSON.stringify(idempotency.responseBody),idempotency.updatedAt]);
    return true;
  })}

  async beginTaskIdempotency(input: BeginTaskIdempotencyInput): Promise<TaskIdempotencyBeginResult> {
    return transaction(this.pool, async (client) => {
      await client.query(`insert into task_idempotency_records (actor_id,project_id,operation,idempotency_key,request_hash,resource_id,status,claim_token,lease_expires_at,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,'in_progress',$7,$8,$9,$9) on conflict do nothing`, [input.actorId,input.projectId,input.operation,input.key,input.requestHash,input.resourceId,input.claimToken,input.leaseExpiresAt,input.now]);
      const locked = await client.query<TaskIdempotencyRow>("select * from task_idempotency_records where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 for update", [input.actorId,input.projectId,input.operation,input.key]);
      const row = locked.rows[0]!;
      if (row.request_hash !== input.requestHash) return { kind: "hash_mismatch" };
      if (row.status === "completed") return { kind: "replay", resourceId: row.resource_id, responseStatus: row.response_status!, responseBody: mapTaskIdempotencyResponseBody(row.operation,row.response_body) };
      if (row.claim_token === input.claimToken) return { kind: "claimed", resourceId: row.resource_id, claimToken: row.claim_token };
      if (toIso(row.lease_expires_at) > input.now) return { kind: "in_progress", resourceId: row.resource_id };
      const reclaimed = await client.query<TaskIdempotencyRow>("update task_idempotency_records set claim_token=$5,lease_expires_at=$6,updated_at=$7 where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 returning *", [input.actorId,input.projectId,input.operation,input.key,input.claimToken,input.leaseExpiresAt,input.now]);
      return { kind: "claimed", resourceId: reclaimed.rows[0]!.resource_id, claimToken: input.claimToken };
    });
  }

  async findTaskIdempotencyByResource(input:TaskIdempotencyResourceLookupInput):Promise<TaskIdempotencyBeginResult|null>{
    const rows=await this.queryRows<TaskIdempotencyRow>("select * from task_idempotency_records where actor_id=$1 and operation=$2 and idempotency_key=$3 and resource_id=$4 order by updated_at desc limit 1",[input.actorId,input.operation,input.key,input.resourceId]);
    const row=rows[0];
    if(!row)return null;
    if(row.request_hash!==input.requestHash)return{kind:"hash_mismatch"};
    if(row.status==="completed")return{kind:"replay",resourceId:row.resource_id,responseStatus:row.response_status!,responseBody:mapTaskIdempotencyResponseBody(row.operation,row.response_body)};
    return{kind:"in_progress",resourceId:row.resource_id};
  }

  async findTaskIdempotency(input:TaskIdempotencyLookupInput):Promise<TaskIdempotencyBeginResult|null>{
    const rows=await this.queryRows<TaskIdempotencyRow>("select * from task_idempotency_records where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 limit 1",[input.actorId,input.projectId,input.operation,input.key]);
    const row=rows[0];
    if(!row)return null;
    if(row.request_hash!==input.requestHash)return{kind:"hash_mismatch"};
    if(row.status==="completed")return{kind:"replay",resourceId:row.resource_id,responseStatus:row.response_status!,responseBody:mapTaskIdempotencyResponseBody(row.operation,row.response_body)};
    return{kind:"in_progress",resourceId:row.resource_id};
  }
  async findInProgressTerminalStartOperation(runId:string):Promise<import("../../ports/src/store.js").InProgressTerminalStartOperation|null>{
    const rows=await this.queryRows<TaskIdempotencyRow>("select * from task_idempotency_records where operation='terminal-start' and resource_id=$1 and status='in_progress' order by created_at,idempotency_key collate \"C\" limit 1",[runId]);
    const row=rows[0];
    return row?{actorId:row.actor_id,projectId:row.project_id,operation:"terminal-start",key:row.idempotency_key,requestHash:row.request_hash,resourceId:row.resource_id,claimToken:row.claim_token}:null;
  }
  async findTaskPreparationOperation(taskId:string):Promise<import("../../ports/src/store.js").TaskPreparationOperation|null>{
    const rows=await this.queryRows<TaskIdempotencyRow>("select * from task_idempotency_records where operation='create' and resource_id=$1 order by created_at limit 2",[taskId]);
    if(rows.length!==1)return null;
    const row=rows[0]!;
    return{actorId:row.actor_id,projectId:row.project_id,operation:"create",key:row.idempotency_key,requestHash:row.request_hash,resourceId:row.resource_id};
  }

  async completeTaskIdempotency(input: CompleteTaskIdempotencyInput): Promise<boolean> {
    const result = await this.pool.query(
      `update task_idempotency_records
          set status='completed',response_status=$7,response_body=$8::jsonb,updated_at=$9
        where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4
          and request_hash=$5 and claim_token=$6
          and (status='in_progress' or (status='completed' and response_status=$7 and response_body=$8::jsonb))`,
      [input.actorId,input.projectId,input.operation,input.key,input.requestHash,input.claimToken,input.responseStatus,JSON.stringify(input.responseBody),input.updatedAt]
    );
    return result.rowCount === 1;
  }
  async requestTaskSandboxRelease(input:TaskSandboxReleaseMutationInput){return transaction(this.pool,async(client)=>{
    const idem=input.idempotency;
    const claim=await client.query("select 1 from task_idempotency_records where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 and request_hash=$5 and claim_token=$6 and status='in_progress' for update",[idem.actorId,idem.projectId,idem.operation,idem.key,idem.requestHash,idem.claimToken]);
    if(claim.rowCount!==1)return"conflict" as const;
    const current=await selectSandboxRunWithClient(client,input.runId,true);
    if(!current||current.taskId!==input.taskId||current.runId!==input.runId)return"conflict" as const;
    const already=current.state==="release_requested"||current.state==="released";
    if(current.state!=="released"){
      if(current.fencingToken!==input.expectedFencingToken||input.run.runId!==input.runId||input.run.taskId!==input.taskId||input.run.state!=="release_requested"||input.run.fencingToken!==current.fencingToken+1)return"conflict" as const;
      await updateSandboxRunWithClient(client,{
        ...input.run,
        startupActionDeadlineAt:current.startupActionDeadlineAt,
        ...(current.startupActionDeadlineAt?{startupClaimToken:current.startupClaimToken,startupLeaseExpiresAt:current.startupLeaseExpiresAt}:{})
      });
    }
    await client.query("update task_idempotency_records set status='completed',response_status=$7,response_body=$8::jsonb,updated_at=$9 where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 and request_hash=$5 and claim_token=$6 and status='in_progress'",[idem.actorId,idem.projectId,idem.operation,idem.key,idem.requestHash,idem.claimToken,idem.responseStatus,JSON.stringify(idem.responseBody),idem.updatedAt]);
    return already?"already_requested" as const:"applied" as const;
  })}
  async completeTaskIdempotencyForResource(input:CompleteTaskIdempotencyForResourceInput):Promise<number>{const result=await this.pool.query("update task_idempotency_records set status='completed',response_status=$4,response_body=$5::jsonb,updated_at=$6 where project_id=$1 and operation=$2 and resource_id=$3 and status='in_progress'",[input.projectId,input.operation,input.resourceId,input.responseStatus,JSON.stringify(input.responseBody),input.updatedAt]);return result.rowCount??0;}

  async persistTaskInteractionMutation(input: PersistTaskInteractionMutationInput): Promise<PersistTaskInteractionMutationResult> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update", [input.taskId]);
      const task = locked.rows[0];
      if (!task||task.deleted_at) throw new Error("Task not found");
      if (input.sourceSync && input.sourceSync.expectedSourceCursor !== undefined && input.sourceSync.expectedSourceCursor !== task.interaction_source_cursor) throw new Error("Task interaction source cursor conflict");
      for (const projection of input.artifactProjections ?? []) {
        if (projection.artifact.taskId !== input.taskId || projection.projectId !== task.project_id) throw new Error("Task interaction artifact mismatch");
        await persistTaskArtifactProjectionWithClient(client,projection);
      }
      const { inserted } = await persistTaskInteractionChangesWithClient(client,input.taskId,input.changes);
      if (input.sourceSync) await client.query("update agent_tasks set interaction_source_cursor=$2,interaction_history_status=$3,interaction_last_synced_at=$4 where id=$1", [input.taskId,input.sourceSync.sourceCursor,input.sourceSync.historyStatus,input.sourceSync.lastSyncedAt]);
      const nextSeq=Number((await client.query<{maximum:string}>("select coalesce(max(change_seq),0)::text as maximum from task_interaction_changes where task_id=$1",[input.taskId])).rows[0]?.maximum??0);
      const sync = input.sourceSync ? { sourceCursor: input.sourceSync.sourceCursor, historyStatus: input.sourceSync.historyStatus, lastSyncedAt: input.sourceSync.lastSyncedAt } : { sourceCursor: task.interaction_source_cursor, historyStatus: task.interaction_history_status, lastSyncedAt: task.interaction_last_synced_at ? toIso(task.interaction_last_synced_at) : null };
      return { changes: inserted, latestChangeSeq: nextSeq, ...sync };
    });
  }

  async readTaskInteractionSnapshot(taskId: string, before: TaskInteractionPageAnchor | null, limit: number): Promise<TaskInteractionStoreSnapshot | null> {
    return transaction(this.pool, async (client) => {
      const task = await client.query<AgentTaskRow>("select * from agent_tasks where id=$1", [taskId]);
      const row = task.rows[0];
      if (!row) return null;
      const maximum = Number((await client.query<{ maximum: string }>("select coalesce(max(change_seq),0)::text as maximum from task_interaction_changes where task_id=$1", [taskId])).rows[0]?.maximum ?? 0);
      const interactionRows = await client.query<TaskInteractionChangeRow>(`with latest as (select distinct on (interaction_id) * from task_interaction_changes where task_id=$1 and change_seq <= $2 order by interaction_id,revision desc,change_seq desc) select * from latest where ($3::bigint is null or position < $3 or (position=$3 and interaction_id < $4)) order by position desc,interaction_id desc limit $5`, [taskId,maximum,before?.position??null,before?.interactionId??null,Math.max(1,limit)+1]);
      const hasMoreBefore = interactionRows.rows.length > Math.max(1,limit);
      const pageRows = interactionRows.rows.slice(0,Math.max(1,limit)).reverse();
      const messages = await client.query<TaskMessageRow>("select * from task_messages where task_id=$1 and deleted_at is null and delivery_status in ('pending','dispatching','failed') order by created_at,id", [taskId]);
      const suppressed = await client.query<{interaction_id:string}>(`select distinct c.interaction_id from task_messages m join task_interaction_changes c on c.task_id=m.task_id and c.source_kind='product' and c.source_id='message:'||m.id where m.task_id=$1 and (m.deleted_at is not null or m.delivery_status in ('pending','dispatching','failed'))`,[taskId]);
      return { items: pageRows.map((change) => mapTaskInteractionChange(change).interaction), queuedMessages: messages.rows.map(mapPersistedTaskMessage), suppressedInteractionIds:suppressed.rows.map((value)=>value.interaction_id), nextPageAnchor: hasMoreBefore && pageRows[0] ? { position: Number(pageRows[0].position), interactionId: pageRows[0].interaction_id } : null, hasMoreBefore, latestChangeSeq: maximum, sourceCursor: row.interaction_source_cursor, historyStatus: row.interaction_history_status, lastSyncedAt: row.interaction_last_synced_at ? toIso(row.interaction_last_synced_at) : null };
    }, "repeatable read");
  }

  async listTaskInteractionChanges(taskId: string, afterChangeSeq: number, limit: number): Promise<PersistedTaskInteractionChange[]> {
    const rows = await this.queryRows<TaskInteractionChangeRow>("select * from task_interaction_changes where task_id=$1 and change_seq>$2 order by change_seq limit $3", [taskId,afterChangeSeq,Math.max(1,limit)]);
    return rows.map(mapTaskInteractionChange);
  }

  async findLatestTaskInteractionChange(taskId: string, interactionId: string): Promise<PersistedTaskInteractionChange | null> {
    const rows=await this.queryRows<TaskInteractionChangeRow>("select * from task_interaction_changes where task_id=$1 and interaction_id=$2 order by revision desc,change_seq desc limit 1",[taskId,interactionId]);
    return rows[0]?mapTaskInteractionChange(rows[0]):null;
  }

  async findTaskInteractionByCorrelation(taskId: string, correlation: TaskInteractionCorrelation): Promise<TaskInteractionItem | null> {
    if (!correlation.toolCallId && !correlation.workTaskId && !correlation.callbackId) return null;
    const rows = await this.queryRows<TaskInteractionChangeRow>(`with matched as (select interaction_id from task_interaction_changes where task_id=$1 and (($2::text is not null and tool_call_id=$2) or ($3::text is not null and work_task_id=$3) or ($4::text is not null and callback_id=$4)) order by change_seq desc limit 1) select c.* from task_interaction_changes c join matched m using (interaction_id) where c.task_id=$1 order by c.revision desc,c.change_seq desc limit 1`, [taskId,correlation.toolCallId??null,correlation.workTaskId??null,correlation.callbackId??null]);
    return rows[0] ? mapTaskInteractionChange(rows[0]).interaction : null;
  }

  async appendTaskArtifacts(artifacts: PersistedTaskArtifact[]): Promise<void> {
    await transaction(this.pool,async(client)=>{
      for (const artifact of artifacts) {
        const task=await client.query("select 1 from agent_tasks where id=$1 and deleted_at is null for update",[artifact.taskId]);
        if(!task.rowCount)throw new Error("Task not found");
        await client.query(
          `insert into agent_task_artifacts (id, task_id, file_id, name, bytes, sha256, media_type, preview_text, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (task_id, file_id) do nothing`,
          [
            artifact.id,
            artifact.taskId,
            artifact.fileId,
            artifact.name,
            artifact.bytes,
            artifact.sha256 ?? null,
            artifact.mediaType ?? null,
            artifact.previewText ?? null,
            artifact.createdAt
          ]
        );
      }
    });
  }

  async persistTaskArtifactProjection(input: PersistTaskArtifactProjectionInput): Promise<"created" | "existing"> {
    return transaction(this.pool, async (client) => {
      const task = await client.query<{ project_id: string }>("select project_id from agent_tasks where id=$1 and deleted_at is null for update", [input.artifact.taskId]);
      if (task.rows[0]?.project_id !== input.projectId) throw new Error("Task artifact project mismatch");
      return persistTaskArtifactProjectionWithClient(client,input);
    });
  }

  async queryTaskArtifacts(taskId: string, query: TaskArtifactStoreListQuery): Promise<TaskArtifactStoreListPage> {
    const values: unknown[] = [];
    const bind = (value:unknown,type:"text"|"text[]"|"timestamptz"|"integer"):string => {
      values.push(value);
      return `$${values.length}::${type}`;
    };
    const where = [`task_id = ${bind(taskId,"text")}`];
    if (query.mediaType !== null) {
      where.push(`media_type = ${bind(query.mediaType,"text")}`);
    }
    if (query.previewOnly) where.push("preview_text is not null");
    if (query.kind !== null) {
      const essence = "lower(btrim(split_part(media_type, ';', 1)))";
      if (query.kind === "image") {
        where.push(`${essence} = any(${bind([...PREVIEW_IMAGE_MEDIA_TYPES],"text[]")})`);
      } else if (query.kind === "text") {
        where.push(`${essence} = any(${bind([...PREVIEW_TEXT_MEDIA_TYPES],"text[]")})`);
      } else {
        const textMatch = `${essence} = any(${bind([...PREVIEW_TEXT_MEDIA_TYPES],"text[]")})`;
        const imageMatch = `${essence} = any(${bind([...PREVIEW_IMAGE_MEDIA_TYPES],"text[]")})`;
        where.push(`not coalesce(${textMatch} or ${imageMatch}, false)`);
      }
    }
    if (query.after) {
      const createdAt = bind(query.after.createdAt,"timestamptz");
      const artifactId = bind(query.after.artifactId,"text");
      where.push(`(created_at, id collate "C") < (${createdAt}, ${artifactId} collate "C")`);
    }
    const limit = bind(query.limit + 1,"integer");
    const rows = await this.queryRows<AgentTaskArtifactRow>(
      `select * from agent_task_artifacts where ${where.join(" and ")} order by created_at desc, id collate "C" desc limit ${limit}`,
      values
    );
    return { items: rows.slice(0, query.limit).map(mapTaskArtifact), hasMore: rows.length > query.limit };
  }

  async findTaskArtifact(taskId: string, artifactId: string): Promise<PersistedTaskArtifact | null> {
    const rows = await this.queryRows<AgentTaskArtifactRow>(
      "select * from agent_task_artifacts where task_id=$1 and id=$2",
      [taskId, artifactId]
    );
    return rows[0] ? mapTaskArtifact(rows[0]) : null;
  }

  async findExistingTaskArtifactFileIds(taskId: string, fileIds: string[]): Promise<string[]> {
    if (fileIds.length === 0) return [];
    const rows = await this.queryRows<{ file_id: string }>(
      "select file_id from agent_task_artifacts where task_id=$1 and file_id=any($2::text[])",
      [taskId, fileIds]
    );
    return rows.map((row) => row.file_id);
  }

  async createTaskMessage(message: PersistedTaskMessage): Promise<PersistedTaskMessage> { return transaction(this.pool, async (client) => mapPersistedTaskMessage(await insertPersistedTaskMessageWithClient(client,message))); }
  async createPendingTaskMessage(message:PersistedTaskMessage,interactionChange:TaskInteractionChangeInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const source=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[message.taskId]);if(!source.rows[0]||source.rows[0].deleted_at)return null;if(interactionChange.sourceKind!=="product"||interactionChange.sourceId!==`message:${message.id}`||interactionChange.interaction.taskId!==message.taskId)throw new Error("Task message interaction identity mismatch");const created=mapPersistedTaskMessage(await insertPersistedTaskMessageWithClient(client,message));await persistTaskInteractionChangesWithClient(client,message.taskId,[interactionChange]);return created;});}
  async listTaskMessages(taskId: string): Promise<PersistedTaskMessage[]> { const rows=await this.queryRows<TaskMessageRow>("select * from task_messages where task_id=$1 and deleted_at is null order by created_at,id",[taskId]); return rows.map(mapPersistedTaskMessage); }
  async findTaskMessage(id: string): Promise<PersistedTaskMessage | null> { const rows=await this.queryRows<TaskMessageRow>("select * from task_messages where id=$1",[id]);return rows[0]?mapPersistedTaskMessage(rows[0]):null; }
  async listTaskMessagesDue(now:string,limit:number):Promise<PersistedTaskMessage[]>{const rows=await this.queryRows<TaskMessageRow>(`select message.* from task_messages message where message.deleted_at is null and exists (select 1 from task_interaction_changes interaction where interaction.task_id=message.task_id and interaction.source_kind='product' and interaction.source_id='message:'||message.id) and ((message.delivery_status='pending' and (message.next_retry_at is null or message.next_retry_at <= $1)) or (message.delivery_status='dispatching' and message.lease_expires_at <= $1 and (message.next_retry_at is null or message.next_retry_at <= $1))) order by message.created_at,message.id limit $2`,[now,limit]);return rows.map(mapPersistedTaskMessage);}
  async claimTaskMessage(input:TaskDeliveryClaimInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const located=await client.query<{task_id:string}>("select task_id from task_messages where id=$1",[input.id]);if(!located.rows[0])return null;const source=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[located.rows[0].task_id]);if(!source.rows[0]||source.rows[0].deleted_at)return null;const rows=await client.query<TaskMessageRow>(`update task_messages target set delivery_status='dispatching',claim_token=$2,claimed_at=$3,lease_expires_at=$4,attempt_count=target.attempt_count+1,safe_error=null,updated_at=$3 where target.id=$1 and target.delivery_status='pending' and target.claim_token is null and target.deleted_at is null and (target.next_retry_at is null or target.next_retry_at <= $3) and exists (select 1 from task_interaction_changes interaction where interaction.task_id=target.task_id and interaction.source_kind='product' and interaction.source_id='message:'||target.id) and not exists (select 1 from task_messages older where older.task_id=target.task_id and older.deleted_at is null and older.delivery_status in ('pending','dispatching') and (older.created_at,older.id)<(target.created_at,target.id) and exists (select 1 from task_interaction_changes older_interaction where older_interaction.task_id=older.task_id and older_interaction.source_kind='product' and older_interaction.source_id='message:'||older.id)) returning target.*`,[input.id,input.claimToken,input.claimedAt,input.leaseExpiresAt]);return rows.rows[0]?mapPersistedTaskMessage(rows.rows[0]):null;});}
  async reclaimTaskMessage(input:TaskDeliveryReclaimInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const located=await client.query<{task_id:string}>("select task_id from task_messages where id=$1",[input.id]);if(!located.rows[0])return null;const source=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[located.rows[0].task_id]);if(!source.rows[0]||source.rows[0].deleted_at)return null;const rows=await client.query<TaskMessageRow>(`update task_messages target set claim_token=$3,claimed_at=$4,lease_expires_at=$5,attempt_count=target.attempt_count+1,safe_error=null,updated_at=$4 where target.id=$1 and target.delivery_status='dispatching' and target.claim_token=$2 and target.lease_expires_at <= $4 and (target.next_retry_at is null or target.next_retry_at <= $4) and target.deleted_at is null and exists (select 1 from task_interaction_changes interaction where interaction.task_id=target.task_id and interaction.source_kind='product' and interaction.source_id='message:'||target.id) and not exists (select 1 from task_messages older where older.task_id=target.task_id and older.deleted_at is null and older.delivery_status in ('pending','dispatching') and (older.created_at,older.id)<(target.created_at,target.id) and exists (select 1 from task_interaction_changes older_interaction where older_interaction.task_id=older.task_id and older_interaction.source_kind='product' and older_interaction.source_id='message:'||older.id)) returning target.*`,[input.id,input.expectedClaimToken,input.claimToken,input.claimedAt,input.leaseExpiresAt]);return rows.rows[0]?mapPersistedTaskMessage(rows.rows[0]):null;});}
  async recordTaskMessageReceipt(input:TaskMessageReceiptInput):Promise<PersistedTaskMessage|null>{const rows=await this.queryRows<TaskMessageRow>(`update task_messages set receipt=$3::jsonb,timeline_cursor=$4,delivery_status='accepted',lease_expires_at=null,next_retry_at=null,safe_error=null,updated_at=$5 where id=$1 and delivery_status='dispatching' and claim_token=$2 and delivery_key=$6 and request_hash=$7 and $8::boolean and deleted_at is null returning *`,[input.id,input.claimToken,JSON.stringify(input.receipt),input.timelineCursor,input.updatedAt,input.receipt.deliveryKey,input.receipt.requestHash,input.receipt.accepted]);return rows[0]?mapPersistedTaskMessage(rows[0]):null;}
  async deferTaskMessage(input:TaskDeliveryDeferInput):Promise<PersistedTaskMessage|null>{const rows=await this.queryRows<TaskMessageRow>(`update task_messages set delivery_status=case when $3 then 'pending' else delivery_status end,claim_token=case when $3 then null else claim_token end,claimed_at=case when $3 then null else claimed_at end,lease_expires_at=case when $3 then null else lease_expires_at end,safe_error=$4,next_retry_at=$5,updated_at=$6 where id=$1 and delivery_status='dispatching' and claim_token=$2 and deleted_at is null returning *`,[input.id,input.claimToken,input.releaseClaim===true,input.safeError,input.nextRetryAt,input.updatedAt]);return rows[0]?mapPersistedTaskMessage(rows[0]):null;}
  async failTaskMessage(input:TaskDeliveryFailureInput):Promise<PersistedTaskMessage|null>{const rows=await this.queryRows<TaskMessageRow>(`update task_messages set delivery_status='failed',safe_error=$3,lease_expires_at=null,updated_at=$4 where id=$1 and delivery_status='dispatching' and claim_token=$2 and deleted_at is null returning *`,[input.id,input.claimToken,input.safeError,input.updatedAt]);return rows[0]?mapPersistedTaskMessage(rows[0]):null;}


  private async queryRows<T>(sql: string, values: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, values);
    return result.rows as T[];
  }
}

class PostgresJsonDocStoreImpl implements PostgresJsonDocStore {
  constructor(private readonly pool: PgPool) {}

  async put(collection: JsonDocumentCollection, id: string, document: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `insert into postgres_json_docs (collection, id, document, updated_at)
       values ($1, $2, $3::jsonb, now())
       on conflict (collection, id)
       do update set document = excluded.document, updated_at = now()`,
      [collection, id, JSON.stringify(document)]
    );
  }

  async get(collection: JsonDocumentCollection, id: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `select document from postgres_json_docs where collection = $1 and id = $2`,
      [collection, id]
    );
    const document = result.rows[0]?.document as unknown;
    return document ? structuredClone(asRecord(document)) : null;
  }

  async delete(collection: JsonDocumentCollection, id: string): Promise<void> {
    await this.pool.query(
      `delete from postgres_json_docs where collection = $1 and id = $2`,
      [collection, id]
    );
  }
}

class PostgresSandboxRunStoreImpl {
  constructor(private readonly pool: PgPool) {}

  async get(runId: string): Promise<PersistedSandboxRunState | null> {
    const rows=await this.pool.query<SandboxRunRow>("select * from sandbox_runs where run_id=$1",[runId]);
    return rows.rows[0]?mapSandboxRun(rows.rows[0]):null;
  }

  async list(): Promise<PersistedSandboxRunState[]> {
    return (await this.pool.query<SandboxRunRow>("select * from sandbox_runs order by run_id")).rows.map(mapSandboxRun);
  }

  async listActive(): Promise<PersistedSandboxRunState[]> {
    return (await this.pool.query<SandboxRunRow>("select * from sandbox_runs where state<>'released' order by run_id")).rows.map(mapSandboxRun);
  }

  async claimForCleanup(input: SandboxRunCleanupClaimInput): Promise<PersistedSandboxRunState | null> {
    const result = await this.pool.query<SandboxRunRow>(
      `update sandbox_runs
       set cleanup_claimed_at=$3,cleanup_attempts=cleanup_attempts+1,fencing_token=$2+1,updated_at=$3
       where run_id=$1 and fencing_token=$2
         and (state in ('release_requested','failed') or (state='starting' and startup_action_deadline_at is not null and startup_action_deadline_at <= $3))
         and (startup_action_deadline_at is not null and startup_action_deadline_at <= $3 or startup_lease_expires_at is null or startup_lease_expires_at <= $3)
         and (startup_action_deadline_at is null or startup_action_deadline_at <= $3)
         and (cleanup_claimed_at is null or cleanup_claimed_at <= $3::timestamptz - interval '2 minutes')
       returning *`,
      [input.runId, input.expectedFencingToken, input.claimedAt]
    );
    return result.rows[0]?mapSandboxRun(result.rows[0]):null;
  }

  async updateWithFencing(
    runId: string,
    expectedFencingToken: number,
    run: PersistedSandboxRunState
  ): Promise<PersistedSandboxRunState | null> {
    if (run.runId !== runId) {
      throw new Error("Sandbox run fencing update runId mismatch");
    }
    return transaction(this.pool,async(client)=>{const current=await selectSandboxRunWithClient(client,runId,true);if(current){if(!sameRunIdentity(current,run))throw new Error("Sandbox run immutable attribution changed");if(current.state!=="released"&&run.state==="released")throw new Error("Sandbox released transition requires atomic settlement");}if(!current||current.fencingToken!==expectedFencingToken)return null;await updateSandboxRunWithClient(client,run);return structuredClone(run);});
  }
}

function isConfirmedReleasedRun(run:PersistedSandboxRunState):boolean{return run.state==="released";}

class PostgresLeaseStoreImpl implements PostgresLeaseStore {
  constructor(private readonly pool: PgPool) {}

  async acquire(input: AcquireLeaseInput): Promise<AcquireLeaseResult> {
    return transaction(this.pool, async (client) => {
      const existingRows = await client.query<RuntimeLeaseRow>(
        `select * from runtime_leases where name = $1 for update`,
        [input.name]
      );
      const existing = existingRows.rows[0] ? mapLease(existingRows.rows[0]) : null;
      if (existing && Date.parse(existing.expiresAt) > input.now.getTime()) {
        return { acquired: false, lease: existing };
      }

      const fencingToken = (existing?.fencingToken ?? 0) + 1;
      const expiresAt = new Date(input.now.getTime() + input.ttlMs).toISOString();
      const metadata = input.metadata ?? {};
      const saved = await client.query<RuntimeLeaseRow>(
        `insert into runtime_leases (name, holder, fencing_token, expires_at, metadata)
         values ($1, $2, $3, $4, $5::jsonb)
         on conflict (name) do update
         set holder = excluded.holder,
             fencing_token = excluded.fencing_token,
             expires_at = excluded.expires_at,
             metadata = excluded.metadata
         returning *`,
        [input.name, input.holder, fencingToken, expiresAt, JSON.stringify(metadata)]
      );
      return { acquired: true, lease: mapLease(saved.rows[0]) };
    });
  }

  async renew(name: string, fencingToken: number, ttlMs: number, now: Date): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const result = await this.pool.query(
      `update runtime_leases set expires_at = $3 where name = $1 and fencing_token = $2`,
      [name, fencingToken, expiresAt]
    );
    return result.rowCount === 1;
  }

  async compareAndSet(name: string, fencingToken: number, metadata: Record<string, unknown>): Promise<boolean> {
    const result = await this.pool.query(
      `update runtime_leases set metadata = $3::jsonb where name = $1 and fencing_token = $2`,
      [name, fencingToken, JSON.stringify(metadata)]
    );
    return result.rowCount === 1;
  }

  async release(name: string, fencingToken: number): Promise<boolean> {
    const result = await this.pool.query(
      `delete from runtime_leases where name = $1 and fencing_token = $2`,
      [name, fencingToken]
    );
    return result.rowCount === 1;
  }

  async expire(now: Date): Promise<number> {
    const result = await this.pool.query(
      `delete from runtime_leases where expires_at <= $1`,
      [now.toISOString()]
    );
    return result.rowCount ?? 0;
  }

  async listExpired(now: Date): Promise<LeaseRecord[]> {
    const result = await this.pool.query<RuntimeLeaseRow>(
      `select * from runtime_leases where expires_at <= $1 order by expires_at, name`,
      [now.toISOString()]
    );
    return result.rows.map(mapLease);
  }
}

async function transaction<T>(pool: PgPool, callback: (client: PoolClient) => Promise<T>, isolation?: "repeatable read"): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(isolation ? `begin isolation level ${isolation}` : "begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockCredentialVersion(client: PoolClient, projectId: string, credentialId: string, expectedVersion: number): Promise<void> {
  const credential = await client.query<{version:number}>("select version from project_credentials where id=$1 and project_id=$2 for share", [credentialId,projectId]);
  if (credential.rows[0]?.version !== expectedVersion) throw new CredentialVersionConflictError();
}

class AtomicTaskMessageConflict extends Error {}

function mapTaskIdempotencyResponseBody(operation:string,value:unknown):unknown{
  const mapped=structuredClone(value);
  if(mapped===null||typeof mapped!=="object"||Array.isArray(mapped))return mapped;
  const response=mapped as Record<string,unknown>;

  if(operation==="project.archive"||operation==="project.unarchive"){
    if(Object.hasOwn(response,"taskConcurrencyLimit")){
      if(!Object.hasOwn(response,"sandboxLimit"))response.sandboxLimit=response.taskConcurrencyLimit;
      delete response.taskConcurrencyLimit;
    }
    return response;
  }
  if(operation==="project.settings.update"){
    const project=response.project;
    if(project!==null&&typeof project==="object"&&!Array.isArray(project)){
      const projectResponse=project as Record<string,unknown>;
      if(Object.hasOwn(projectResponse,"taskConcurrencyLimit")){
        if(!Object.hasOwn(projectResponse,"sandboxLimit"))projectResponse.sandboxLimit=projectResponse.taskConcurrencyLimit;
        delete projectResponse.taskConcurrencyLimit;
      }
    }
    return response;
  }
  if(operation==="project.policy.update"){
    if(Object.hasOwn(response,"activeTasksLimit")){
      if(!Object.hasOwn(response,"sandboxLimit"))response.sandboxLimit=response.activeTasksLimit;
      delete response.activeTasksLimit;
    }
    return response;
  }
  if(operation==="project.alert.transition"||operation==="project.alert.acknowledge"||operation==="project.alert.silence"){
    if(response.type==="active_tasks_limit")response.type="sandbox_capacity";
    if(response.metric==="active_tasks")response.metric="active_sandboxes";
    return response;
  }
  if(operation==="project.alert-rule.create"||operation==="project.alert-rule.update"||operation==="project.alert-rule.delete"){
    if(response.alertType==="active_tasks_limit")response.alertType="sandbox_capacity";
    if(response.metric==="active_tasks")response.metric="active_sandboxes";
  }
  return response;
}

async function claimTaskIdempotencyWithClient(client:PoolClient,input:BeginTaskIdempotencyInput):Promise<
  | {kind:"claimed";row:TaskIdempotencyRow}
  | {kind:"hash_mismatch"}
  | {kind:"in_progress"}
  | {kind:"replay";responseStatus:number;responseBody:unknown}
>{
  await client.query(
    `insert into task_idempotency_records
       (actor_id,project_id,operation,idempotency_key,request_hash,resource_id,status,claim_token,lease_expires_at,created_at,updated_at)
     values ($1,$2,$3,$4,$5,$6,'in_progress',$7,$8,$9,$9)
     on conflict do nothing`,
    [input.actorId,input.projectId,input.operation,input.key,input.requestHash,input.resourceId,input.claimToken,input.leaseExpiresAt,input.now]
  );
  const row=(await client.query<TaskIdempotencyRow>(
    "select * from task_idempotency_records where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 for update",
    [input.actorId,input.projectId,input.operation,input.key]
  )).rows[0];
  if(!row||row.request_hash!==input.requestHash)return{kind:"hash_mismatch"};
  if(row.status==="completed")return{kind:"replay",responseStatus:row.response_status!,responseBody:mapTaskIdempotencyResponseBody(row.operation,row.response_body)};
  if(row.claim_token!==input.claimToken){
    if(toIso(row.lease_expires_at)>input.now)return{kind:"in_progress"};
    const reclaimed=(await client.query<TaskIdempotencyRow>(
      "update task_idempotency_records set claim_token=$5,lease_expires_at=$6,updated_at=$7 where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 returning *",
      [input.actorId,input.projectId,input.operation,input.key,input.claimToken,input.leaseExpiresAt,input.now]
    )).rows[0]!;
    return{kind:"claimed",row:reclaimed};
  }
  return{kind:"claimed",row};
}

async function completeTaskIdempotencyWithClient(client:PoolClient,input:BeginTaskIdempotencyInput,responseStatus:number,responseBody:unknown,updatedAt:string):Promise<void>{
  const completed=await client.query(
    `update task_idempotency_records
        set status='completed',response_status=$7,response_body=$8::jsonb,updated_at=$9
      where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4
        and request_hash=$5 and claim_token=$6 and status='in_progress'`,
    [input.actorId,input.projectId,input.operation,input.key,input.requestHash,input.claimToken,responseStatus,JSON.stringify(responseBody),updatedAt]
  );
  if(completed.rowCount!==1)throw new AtomicTaskMessageConflict();
}

async function lockActiveProjectWithClient(client:PoolClient,projectId:string):Promise<boolean>{
  const project=await client.query<{lifecycle_status:string}>("select lifecycle_status from projects where id=$1 for update",[projectId]);
  return project.rows[0]?.lifecycle_status==="active";
}

async function lockActiveTaskProjectWithClient(client:PoolClient,taskId:string,auditProjectId?:string):Promise<string|null>{
  const located=(await client.query<{project_id:string}>("select project_id from agent_tasks where id=$1",[taskId])).rows[0];
  if(!located||auditProjectId!==undefined&&auditProjectId!==located.project_id)return null;
  return await lockActiveProjectWithClient(client,located.project_id)?located.project_id:null;
}

async function projectHasLiveBusinessReservations(client:PoolClient,projectId:string):Promise<boolean>{
  const blocked=await client.query(
    `select 1
       from sandbox_runs
      where project_id=$1 and state<>'released'
      union all
     select 1
       from project_provider_settlements
      where project_id=$1 and status in ('reserved','dispatched','delivered')
      limit 1`,
    [projectId]
  );
  return Boolean(blocked.rowCount);
}

function isSuccessfulProjectDeletionCompletion(projectId:string,completion:CompleteTaskIdempotencyInput):boolean{
  return completion.projectId===projectId
    && completion.operation==="project.delete"
    && completion.responseStatus===200
    && strictStructuralEqual(completion.responseBody,{deleted:true});
}

type SandboxAdmissionPreparation<R> =
  | {kind:"ready";reserve?:boolean}
  | {kind:"result";value:R};

const SANDBOX_ADMISSION_GUARD=Symbol("sandbox-admission");

async function admitSandboxRunWithClient<R>(
  client:PoolClient,
  admission:SandboxAdmissionInput,
  run:PersistedSandboxRunState,
  updatedAt:string,
  idempotency:BeginTaskIdempotencyInput,
  presentation:TaskPresentation|null,
  rejectedAuditEvent:ProjectAuditEvent,
  projectUnavailable:R,
  prepare:()=>Promise<SandboxAdmissionPreparation<R>>,
  write:(insertRun:()=>Promise<void>)=>Promise<R>
):Promise<R|SandboxCapacityRejected>{
  const scope=normalizeSandboxAdmission(admission,run);
  await lockSandboxNamespaceWithClient(client,scope.namespace);
  if(!await lockActiveProjectWithClient(client,run.projectId))return projectUnavailable;
  const policy=(await client.query<{active_tasks_limit:number|null}>("select active_tasks_limit from project_resource_policies where project_id=$1 for update",[run.projectId])).rows[0];
  const usage=(await client.query("select project_id from project_resource_usage where project_id=$1 for update",[run.projectId])).rows[0];
  if(!policy||!usage)return projectUnavailable;
  const prepared=await prepare();
  if(prepared.kind==="result")return prepared.value;
  if(prepared.reserve===false){
    return write(async()=>{throw new Error("Existing Sandbox Run cannot insert another Run");});
  }

  const projectRuns=await client.query("select run_id from sandbox_runs where project_id=$1 and state<>'released' order by run_id for update",[run.projectId]);
  const activeSandboxes=projectRuns.rowCount??0;
  if(policy.active_tasks_limit!==null&&activeSandboxes>=policy.active_tasks_limit){
    return rejectSandboxAdmissionWithClient(client,{kind:"project_capacity_rejected",activeSandboxes,sandboxLimit:policy.active_tasks_limit},idempotency,presentation,rejectedAuditEvent,updatedAt);
  }
  const namespaceRuns=await client.query("select run_id from sandbox_runs where namespace=$1 and state<>'released' order by run_id for update",[scope.namespace]);
  if((namespaceRuns.rowCount??0)>=scope.namespaceLimit){
    return rejectSandboxAdmissionWithClient(client,{kind:"substrate_capacity_rejected"},idempotency,presentation,rejectedAuditEvent,updatedAt);
  }

  let inserted=false;
  const result=await write(async()=>{
    if(inserted)throw new Error("Sandbox admission attempted duplicate Run insertion");
    inserted=true;
    await insertAdmittedSandboxRunWithClient(client,run,SANDBOX_ADMISSION_GUARD);
  });
  if(inserted)await setAuthoritativeActiveTaskUsageWithClient(client,run.projectId,updatedAt);
  return result;
}

type SandboxRestartIdentityInput = Pick<AtomicTaskSandboxRestartInput,"expectedReleasedRunId"|"task"|"sandboxRun">;

function sandboxRestartRowIdentityMatches(current:AgentTaskRow,input:SandboxRestartIdentityInput):boolean{
  const task=input.task,run=input.sandboxRun;
  return task.id===current.id&&task.workspaceId===current.workspace_id&&task.projectId===current.project_id&&task.endpointId===current.endpoint_id&&task.fileLibraryId===current.file_library_id&&task.currentRunId!==input.expectedReleasedRunId&&run.runId===task.currentRunId&&run.taskId===current.id&&run.workspaceId===current.workspace_id&&run.projectId===current.project_id&&run.fileLibraryId===current.file_library_id&&run.state==="starting";
}

function sameTaskRunScopeRow(task:AgentTaskRow,run:PersistedSandboxRunState):boolean {
  return task.id===run.taskId&&task.workspace_id===run.workspaceId&&task.project_id===run.projectId&&task.file_library_id===run.fileLibraryId;
}

async function taskRowHasConfirmedRelease(client:PoolClient,task:AgentTaskRow):Promise<boolean>{
  const unreleased=await client.query("select run_id from sandbox_runs where task_id=$1 and state<>'released' for update",[task.id]);
  if((unreleased.rowCount??0)>0)return false;
  if(!task.current_run_id)return true;
  const run=await selectSandboxRunWithClient(client,task.current_run_id,true);
  return Boolean(run&&sameTaskRunScopeRow(task,run)&&run.state==="released");
}

async function rejectSandboxAdmissionWithClient(
  client:PoolClient,
  admission:import("../../ports/src/store.js").SandboxAdmissionRejection,
  idempotency:BeginTaskIdempotencyInput,
  presentation:TaskPresentation|null,
  rejectedAuditEvent:ProjectAuditEvent,
  updatedAt:string
):Promise<SandboxCapacityRejected>{
  validateRejectedAdmissionAudit(rejectedAuditEvent);
  const project=admission.kind==="project_capacity_rejected";
  const details=project?{activeSandboxes:admission.activeSandboxes,sandboxLimit:admission.sandboxLimit}:null;
  const responseBody=sandboxCapacityErrorEnvelope(project?"project_policy":"substrate_namespace",presentation,details);
  await completeTaskIdempotencyWithClient(client,idempotency,409,responseBody,updatedAt);
  await insertAuditEventWithClient(client,{
    ...rejectedAuditEvent,
    status:"rejected",
    detail:{
      ...rejectedAuditEvent.detail,
      scope:project?"project_policy":"substrate_namespace",
      ...(details??{})
    }
  });
  return{kind:"capacity_rejected",admission,responseStatus:409,responseBody};
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

async function lockSandboxNamespaceWithClient(client:PoolClient,namespace:string):Promise<void>{
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`agentsmith-lite:sandbox:${namespace}`]);
}

async function setAuthoritativeActiveTaskUsageWithClient(client:PoolClient,projectId:string,updatedAt:string):Promise<void>{
  await client.query(
    `update project_resource_usage
        set active_tasks=(select count(*) from sandbox_runs where project_id=$1 and state<>'released'),
            updated_at=$2
      where project_id=$1`,
    [projectId,updatedAt]
  );
}

async function putJsonDocumentWithClient(client: PoolClient, collection: JsonDocumentCollection, id: string, document: Record<string, unknown>): Promise<void> {
  await client.query(`insert into postgres_json_docs (collection,id,document,updated_at) values ($1,$2,$3::jsonb,now()) on conflict (collection,id) do update set document=excluded.document,updated_at=excluded.updated_at`,[collection,id,JSON.stringify(document)]);
}

async function insertAuditEventWithClient(client: PoolClient, event: ProjectAuditEvent): Promise<void> {
  await client.query(
    "insert into project_audit_events (id,project_id,actor_id,subject_user_id,action,status,resource_kind,resource_id,detail,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) on conflict (id) do nothing",
    [event.id,event.projectId,event.actorId,event.subjectUserId??null,event.action,event.status,event.resourceKind,event.resourceId,JSON.stringify(sanitizeProjectAuditDetail(event.detail)),event.createdAt]
  );
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

async function persistTaskInteractionChangesWithClient(client:PoolClient,taskId:string,changes:TaskInteractionChangeInput[]):Promise<{inserted:PersistedTaskInteractionChange[];nextSeq:number}>{
  let nextSeq=Number((await client.query<{maximum:string}>("select coalesce(max(change_seq),0)::text as maximum from task_interaction_changes where task_id=$1",[taskId])).rows[0]?.maximum??0);
  const inserted:PersistedTaskInteractionChange[]=[];
  for(const change of changes){
    validatePostgresInteractionChange(taskId,change);
    const duplicate=await client.query<TaskInteractionChangeRow>("select * from task_interaction_changes where task_id=$1 and source_kind=$2 and source_id=$3 and source_revision=$4",[taskId,change.sourceKind,change.sourceId,change.sourceRevision]);
    if(duplicate.rows[0])continue;
    if(change.sourceKind==="product"){
      const latestSource=await client.query<{revision:string|number}>("select source_revision as revision from task_interaction_changes where task_id=$1 and source_kind='product' and source_id=$2 order by source_revision desc limit 1",[taskId,change.sourceId]);
      if(latestSource.rows[0]&&change.sourceRevision<=parseTaskInteractionSourceRevision(latestSource.rows[0].revision))throw new Error("Task interaction source revision is not monotonic");
    }
    const latest=await client.query<TaskInteractionChangeRow>("select * from task_interaction_changes where task_id=$1 and interaction_id=$2 order by revision desc,change_seq desc limit 1",[taskId,change.interaction.id]);
    if(latest.rows[0]&&(change.interaction.revision<=latest.rows[0].revision||change.interaction.position!==Number(latest.rows[0].position)))throw new Error("Task interaction revision is not monotonic");
    nextSeq+=1;
    const row=await client.query<TaskInteractionChangeRow>(`insert into task_interaction_changes (task_id,change_seq,source_kind,source_id,source_revision,interaction_id,revision,position,interaction_kind,interaction,tool_call_id,work_task_id,callback_id,occurred_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15) returning *`,[taskId,nextSeq,change.sourceKind,change.sourceId,change.sourceRevision,change.interaction.id,change.interaction.revision,change.interaction.position,change.interaction.kind,JSON.stringify(change.interaction),change.correlation?.toolCallId??null,change.correlation?.workTaskId??null,change.correlation?.callbackId??null,change.interaction.occurredAt,change.interaction.updatedAt]);
    inserted.push(mapTaskInteractionChange(row.rows[0]!));
  }
  return{inserted,nextSeq};
}

async function persistTaskArtifactProjectionWithClient(client:PoolClient,input:PersistTaskArtifactProjectionInput):Promise<"created"|"existing"> {
  const existing=await client.query("select id from agent_task_artifacts where task_id=$1 and file_id=$2",[input.artifact.taskId,input.artifact.fileId]);
  if(existing.rowCount){await insertAuditEventWithClient(client,input.auditEvent);return "existing";}
  await client.query(`insert into agent_task_artifacts (id,task_id,file_id,name,bytes,sha256,media_type,preview_text,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[input.artifact.id,input.artifact.taskId,input.artifact.fileId,input.artifact.name,input.artifact.bytes,input.artifact.sha256??null,input.artifact.mediaType??null,input.artifact.previewText??null,input.artifact.createdAt]);
  await insertAuditEventWithClient(client,input.auditEvent);
  return "created";
}

async function insertTaskWithClient(client: PoolClient, task: PersistedAgentTask): Promise<AgentTaskRow> {
  const columns = [
    "id","workspace_id","project_id","endpoint_id","file_library_id","created_by_user_id","title","prompt","agent_context","current_run_id","archived_at","deleted_at",
    "interaction_source_cursor","interaction_history_status","interaction_last_synced_at",
    "created_at","updated_at"
  ];
  const values: unknown[] = [
    task.id,task.workspaceId,task.projectId,task.endpointId,task.fileLibraryId,task.createdByUserId??null,task.title ?? task.prompt.replace(/[\r\n]+/g," ").slice(0,160),task.prompt,task.agentContext??"",task.currentRunId,task.archivedAt ?? null,task.deletedAt ?? null,
    null,"complete",null,
    task.createdAt,task.updatedAt
  ];
  const placeholders = columns.map((_column,index) => `$${index+1}`);
  const inserted = await client.query<AgentTaskRow>(`insert into agent_tasks (${columns.join(",")}) values (${placeholders.join(",")}) returning *`,values);
  return inserted.rows[0]!;
}

const SANDBOX_RUN_COLUMNS = [
  "run_id","workspace_id","project_id","task_id","file_library_id","started_by_user_id","state",
  "namespace","image","pvc_name","project_sub_path","file_library_root_sub_path","botified_port",
  "resource_names","service_key_secret_ref","directories","resource_limits","resource_snapshot","model_ca",
  "timeline_cursor","terminal_failure","failure_code","failure_cause","fencing_token","resume_unfinished","startup_ready_at","startup_action_deadline_at","startup_claim_token","startup_lease_expires_at","cleanup_claimed_at",
  "cleanup_attempts","last_cleanup_at","last_cleanup_error","release_reason","started_at","release_requested_at",
  "failed_at","released_at","created_at","updated_at"
] as const;

function sandboxRunValues(run:PersistedSandboxRunState):unknown[] {
  return [
    run.runId,run.workspaceId,run.projectId,run.taskId,run.fileLibraryId,run.startedByUserId,run.state,
    run.namespace,run.image,run.pvcName,run.projectSubPath,run.fileLibraryRootSubPath,run.botifiedPort,
    JSON.stringify(run.resourceNames),JSON.stringify(run.serviceKeySecretRef),JSON.stringify(run.directories),
    JSON.stringify(run.resourceLimits),JSON.stringify(run.resourceSnapshot),run.modelCa?JSON.stringify(run.modelCa):null,
    run.timelineCursor??null,run.terminalFailure?JSON.stringify(run.terminalFailure):null,run.failureCode,run.failureCause,run.fencingToken,
    run.resumeUnfinished??false,run.startupReadyAt,run.startupActionDeadlineAt,run.startupClaimToken??null,run.startupLeaseExpiresAt??null,run.cleanupClaimedAt??null,run.cleanupAttempts??0,run.lastCleanupAt??null,
    run.lastCleanupError?JSON.stringify(run.lastCleanupError):null,run.releaseReason??null,run.startedAt,
    run.releaseRequestedAt,run.failedAt,run.releasedAt,run.createdAt,run.updatedAt
  ];
}

async function insertSandboxRunWithClient(client:PoolClient,run:PersistedSandboxRunState):Promise<void> {
  const jsonColumns=new Set(["resource_names","service_key_secret_ref","directories","resource_limits","resource_snapshot","model_ca","terminal_failure","last_cleanup_error"]);
  const placeholders=SANDBOX_RUN_COLUMNS.map((column,index)=>`$${index+1}${jsonColumns.has(column)?"::jsonb":""}`);
  await client.query(`insert into sandbox_runs (${SANDBOX_RUN_COLUMNS.join(",")}) values (${placeholders.join(",")})`,sandboxRunValues(run));
}

async function insertAdmittedSandboxRunWithClient(
  client:PoolClient,
  run:PersistedSandboxRunState,
  guard:typeof SANDBOX_ADMISSION_GUARD
):Promise<void>{
  if(guard!==SANDBOX_ADMISSION_GUARD||run.state==="released")throw new Error("Unreleased Sandbox Run insertion requires admission");
  await insertSandboxRunWithClient(client,run);
}

async function updateSandboxRunWithClient(client:PoolClient,run:PersistedSandboxRunState):Promise<void> {
  const mutable=SANDBOX_RUN_COLUMNS.slice(6);
  const jsonColumns=new Set(["resource_names","service_key_secret_ref","directories","resource_limits","resource_snapshot","model_ca","terminal_failure","last_cleanup_error"]);
  const assignments=mutable.map((column,index)=>`${column}=$${index+2}${jsonColumns.has(column)?"::jsonb":""}`);
  const values=sandboxRunValues(run).slice(6);
  const result=await client.query(`update sandbox_runs set ${assignments.join(",")} where run_id=$1`,[run.runId,...values]);
  if(result.rowCount!==1)throw new Error("Sandbox Run disappeared during update");
}

async function selectSandboxRunWithClient(client:PoolClient,runId:string,lock=false):Promise<PersistedSandboxRunState|null> {
  const rows=await client.query<SandboxRunRow>(`select * from sandbox_runs where run_id=$1${lock?" for update":""}`,[runId]);
  return rows.rows[0]?mapSandboxRun(rows.rows[0]):null;
}

async function insertPersistedTaskMessageWithClient(client: PoolClient, message: PersistedTaskMessage): Promise<TaskMessageRow> {
  const inserted = await client.query<TaskMessageRow>(`insert into task_messages (id,task_id,actor_id,content,delivery_key,request_hash,claim_token,receipt,timeline_cursor,delivery_status,claimed_at,lease_expires_at,attempt_count,next_retry_at,safe_error,created_at,updated_at,deleted_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *`,[
    message.id,message.taskId,message.actorId??null,message.content,message.deliveryKey??null,message.requestHash??null,message.claimToken??null,message.receipt?JSON.stringify(message.receipt):null,message.timelineCursor??null,message.deliveryStatus??"pending",message.claimedAt??null,message.leaseExpiresAt??null,message.attemptCount??0,message.nextRetryAt??null,message.safeError??null,message.createdAt,message.updatedAt??message.createdAt,message.deletedAt??null
  ]);
  return inserted.rows[0]!;
}

interface UserRow {
  id: string;
  email: string;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  picture_url: string | null;
  email_verified: boolean;
  role: string;
  password_hash: string;
  created_at: unknown;
  updated_at: unknown;
}

interface ProjectMembershipRow {
  project_id: string;
  user_id: string;
  role: ProjectMembership["role"];
  created_at: unknown;
  updated_at: unknown;
  email?: string;
  display_name?: string | null;
}
interface WorkspaceMembershipRow { workspace_id:string; user_id:string; role:WorkspaceMembership["role"]; created_at:unknown; updated_at:unknown; email?:string; display_name?:string|null; }

interface AuthSessionRow {
  id: string;
  user_id: string;
  csrf_token: string;
  oidc_id_token: string | null;
  created_at: unknown;
  expires_at: unknown;
}

interface WorkspaceRow {
  id: string;
  name: string;
  owner_user_id: string;
  lifecycle_status: "active" | "archived" | "deleting";
  created_at: unknown;
  updated_at: unknown;
  member_role?: WorkspaceMembership["role"];
  owner_email?: string;
  owner_display_name?: string | null;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  owner_user_id: string;
  root_path: string;
  task_concurrency_limit: number;
  lifecycle_status: "active" | "archived" | "deleting";
  created_at: unknown;
  updated_at: unknown;
}
interface FileLibraryRow { id:string;workspace_id:string;project_id:string;name:string;root_sub_path:string;created_by_user_id:string;created_at:unknown;updated_at:unknown; }
interface ContextRow { id:string; workspace_id:string; project_id:string|null; owner_user_id:string|null; scope:ProjectContextEntry["scope"]; context_key:string; content:string; content_type:import("../../contracts/src/api.js").ProjectContextContentType; version:number; created_at:unknown; updated_at:unknown; }
type ContextMetadataRow = Omit<ContextRow,"content">;

interface ModelEndpointRow {
  id: string;
  project_id: string;
  name: string;
  protocol: string;
  base_url: string;
  model: string;
  credential_id: string | null;
  capabilities: unknown;
  request_timeout_secs: number;
  health_status: "healthy" | "unavailable" | "unknown";
  health_checked_at: unknown | null;
  health_error_category: "auth" | "network" | "upstream" | "timeout" | "rate_limit" | "unknown" | null;
  created_at: unknown;
  updated_at: unknown;
}
interface EndpointViewRow extends ModelEndpointRow { credential_summary_id:string|null;credential_summary_name:string|null;credential_summary_base_url:string|null;credential_summary_version:number|null }
interface ProjectCredentialRow { id:string; project_id:string; name:string; type:"api_key"; base_url:string; key_id:string; nonce:Buffer; ciphertext:Buffer; auth_tag:Buffer; fingerprint:string; version:number; created_at:unknown; last_rotated_at:unknown|null; updated_at:unknown; }

interface AgentTaskRow {
  id: string;
  workspace_id: string;
  project_id: string;
  endpoint_id: string;
  file_library_id: string | null;
  created_by_user_id: string | null;
  title: string;
  prompt: string;
  agent_context: string | null;
  current_run_id: string | null;
  archived_at: unknown;
  deleted_at: unknown;
  interaction_source_cursor: string | null;
  interaction_history_status: "complete" | "gap";
  interaction_last_synced_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}
interface SandboxReleaseTaskRow extends AgentTaskRow { project_workspace_id:string;project_owner_user_id:string; }

interface ProfileRow { user_id: string; display_name: string | null; timezone: string | null; bio:string|null; job_title:string|null; company:string|null; greeting_preference:string|null; interests:string[]|null; updated_at: unknown; }
interface NotificationRow { id:string; user_id:string; type:string; title:string; body:string|null; project_id:string|null; resource_kind:UserNotification["resourceKind"]; resource_id:string|null; link_path:string|null; read_at:unknown; created_at:unknown; dedupe_key:string|null; }
type PersistedProjectAlertType=Exclude<ProjectAlertType,"sandbox_capacity">|"active_tasks_limit";
type PersistedAlertRuleMetric=Exclude<AlertRuleMetric,"active_sandboxes">|"active_tasks";
interface AlertRuleRow { id:string; project_id:string; alert_type:PersistedProjectAlertType; name:string; metric:PersistedAlertRuleMetric; condition:AlertRuleCondition; threshold:number; window_seconds:number|null; scope_kind:"project"|"endpoint"; endpoint_id:string|null; enabled:boolean; created_at:unknown; updated_at:unknown; }
interface AlertRuleViewRow extends AlertRuleRow {endpoint_name:string|null}

interface ProviderSettlementRow {
  id: string; project_id: string; task_id: string | null; endpoint_id: string | null; actor_id:string|null; status: ProjectProviderSettlement["status"];
  reserved_tokens:string|number;reserved_cost:string|number;
  reserved_at: unknown; expires_at: unknown; dispatched_at: unknown; delivered_at: unknown; settled_at: unknown;
  provider_tokens: string | number | null; provider_cost: string | number | null; updated_at: unknown;
}
interface ProviderUsageAggregateRow { bucket:string;requests:string;tokens:string;cost:string; }
interface ProviderEndpointUsageAggregateRow { endpoint_id:string|null;requests:string;tokens:string;cost:string; }
interface ProviderWindowAggregateRow { endpoint_id:string;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;limit_value:string;window_seconds:number;current:string;oldest_reserved_at:unknown|null; }

interface AgentTaskArtifactRow {
  id: string;
  task_id: string;
  file_id: string;
  name: string;
  bytes: number;
  sha256: string | null;
  media_type: string | null;
  preview_text: string | null;
  created_at: unknown;
}
interface TaskMessageRow { id:string; task_id:string; actor_id:string|null; content:string; delivery_key:string|null; request_hash:string|null; claim_token:string|null; receipt:unknown; timeline_cursor:string|null; delivery_status:NonNullable<PersistedTaskMessage["deliveryStatus"]>; claimed_at:unknown; lease_expires_at:unknown; attempt_count:number; next_retry_at:unknown; safe_error:string|null; created_at:unknown; updated_at:unknown; deleted_at:unknown; }
interface TaskInteractionChangeRow { task_id:string; change_seq:string|number; source_kind:PersistedTaskInteractionChange["sourceKind"]; source_id:string; source_revision:string|number; interaction_id:string; revision:number; position:string|number; interaction_kind:TaskInteractionItem["kind"]; interaction:unknown; tool_call_id:string|null; work_task_id:string|null; callback_id:string|null; occurred_at:unknown; updated_at:unknown; }
interface TaskIdempotencyRow { actor_id:string;project_id:string;operation:string;idempotency_key:string;request_hash:string;resource_id:string;status:"in_progress"|"completed";claim_token:string;lease_expires_at:unknown;response_status:number|null;response_body:unknown;created_at:unknown;updated_at:unknown; }
interface ProjectPolicyRow { project_id: string; active_tasks_limit: number | null; provider_requests_limit: string | number | null; provider_tokens_limit: string | number | null; provider_cost_limit: number | null; project_file_bytes_limit: string | number | null; created_at: unknown; updated_at: unknown; }
interface ProjectUsageRow { project_id: string; active_tasks: number; provider_requests: string | number; provider_tokens: string | number; provider_cost: number; project_file_bytes: string | number; project_file_bytes_measured_at: unknown | null; updated_at: unknown; }
interface ProjectProviderSettlementRow extends ProjectUsageRow { provider_requests_exceeded: boolean; provider_tokens_exceeded: boolean; provider_cost_exceeded: boolean; }
interface ProjectAlertRow { id: string; project_id: string; type: PersistedProjectAlertType; status: ProjectAlertStatus; delivery_status: ProjectAlert["deliveryStatus"]; rule_id:string|null;metric:PersistedAlertRuleMetric|null;metric_value:number|null;threshold:number|null;endpoint_id:string|null;endpoint_name?:string|null;subject_actor_id:string|null;acknowledged_at:unknown;acknowledged_by:string|null;silenced_until:unknown; created_at: unknown; updated_at: unknown; resolved_at: unknown; dismissed_at: unknown; }
interface ProjectAuditRow { id: string; project_id: string; actor_id: string | null; subject_user_id:string|null; action: ProjectAuditEvent["action"]; status: ProjectAuditEvent["status"]; resource_kind: ProjectAuditEvent["resourceKind"]; resource_id: string | null; detail:ProjectAuditEvent["detail"]; created_at: unknown; actor_display_name:string|null;actor_email:string|null;subject_display_name:string|null;subject_email:string|null; }
interface SandboxUsageSettlementRow { run_id:string;workspace_id:string;project_id:string;task_id:string;file_library_id:string;started_by_user_id:string;started_at:unknown;released_at:unknown;duration_seconds:number|string;cpu_request_millis:string;memory_request_bytes:string;cpu_limit_millis:string;memory_limit_bytes:string;release_reason:import("../../contracts/src/api.js").SandboxReleaseReason; }
interface SandboxUsageHistoryRow extends SandboxUsageSettlementRow { task_title:string|null;task_available:boolean; }
interface SandboxUsageSummaryRow { unreleased_count:string;launches:string;total_duration_ms:string;cpu_request_millis_ms:string;memory_request_byte_ms:string; }
interface SandboxRunRow {
  run_id:string;workspace_id:string;project_id:string;task_id:string;file_library_id:string;started_by_user_id:string;
  state:PersistedSandboxRunState["state"];namespace:string;image:string;pvc_name:string;project_sub_path:string;
  file_library_root_sub_path:string;botified_port:number;resource_names:unknown;service_key_secret_ref:unknown;
  directories:unknown;resource_limits:unknown;resource_snapshot:unknown;model_ca:unknown|null;timeline_cursor:string|null;
  terminal_failure:unknown|null;failure_code:PersistedSandboxRunState["failureCode"];failure_cause:string|null;fencing_token:string|number;resume_unfinished:boolean;
  startup_ready_at:unknown|null;startup_action_deadline_at:unknown|null;startup_claim_token:string|null;startup_lease_expires_at:unknown|null;cleanup_claimed_at:unknown|null;cleanup_attempts:number;last_cleanup_at:unknown|null;last_cleanup_error:unknown|null;
  release_reason:PersistedSandboxRunState["releaseReason"];started_at:unknown|null;release_requested_at:unknown|null;
  failed_at:unknown|null;released_at:unknown|null;created_at:unknown;updated_at:unknown;
}
interface SandboxLiveRunRow extends SandboxRunRow { task_title:string|null; }

interface RuntimeLeaseRow {
  name: string;
  holder: string;
  fencing_token: string | number;
  expires_at: unknown;
  metadata: unknown;
}

function mapUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    ...(row.oidc_issuer ? { oidcIssuer: row.oidc_issuer } : {}),
    ...(row.oidc_subject ? { oidcSubject: row.oidc_subject } : {}),
    ...(row.picture_url ? { pictureUrl: row.picture_url } : {}),
    emailVerified: row.email_verified,
    passwordHash: row.password_hash,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function mapProjectMembership(row: ProjectMembershipRow): ProjectMembership {
  return {
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}
function mapProjectMembershipView(row: ProjectMembershipRow): ProjectMembershipView { return { ...mapProjectMembership(row), displayName:row.display_name ?? null, email:row.email ?? row.user_id }; }
function mapWorkspaceMembership(row: WorkspaceMembershipRow): WorkspaceMembership { return { workspaceId:row.workspace_id,userId:row.user_id,role:row.role,createdAt:toIso(row.created_at),updatedAt:toIso(row.updated_at) }; }
function mapWorkspaceMembershipView(row: WorkspaceMembershipRow): WorkspaceMembershipView { return { ...mapWorkspaceMembership(row), displayName:row.display_name ?? null, email:row.email ?? row.user_id }; }
function mapWorkspaceListProjection(row: WorkspaceRow): WorkspaceListProjection { const workspace = mapWorkspace(row); if (!row.member_role || !row.owner_email) throw new Error("Workspace list projection is incomplete"); return { ...workspace, owner: { displayName: row.owner_display_name ?? null, email: row.owner_email }, memberRole: row.member_role }; }

function mapSession(row: AuthSessionRow): AuthSession {
  return {
    id: row.id,
    userId: row.user_id,
    csrfToken: row.csrf_token,
    ...(row.oidc_id_token ? { oidcIdToken: row.oidc_id_token } : {}),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at)
  };
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    lifecycleStatus: row.lifecycle_status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    rootPath: row.root_path,
    sandboxLimit: row.task_concurrency_limit,
    lifecycleStatus: row.lifecycle_status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}
function mapFileLibrary(row:FileLibraryRow):FileLibrary{return{id:row.id,workspaceId:row.workspace_id,projectId:row.project_id,name:row.name,rootSubPath:row.root_sub_path,createdByUserId:row.created_by_user_id,createdAt:toIso(row.created_at),updatedAt:toIso(row.updated_at)}}
function mapContext(row: ContextRow): ProjectContextEntry { return { id:row.id,workspaceId:row.workspace_id,projectId:row.project_id,ownerUserId:row.owner_user_id,scope:row.scope,contextKey:row.context_key,content:row.content,contentType:row.content_type,version:row.version,createdAt:toIso(row.created_at),updatedAt:toIso(row.updated_at) }; }
function mapContextMetadata(row:ContextMetadataRow):import("../../contracts/src/api.js").ProjectContextEntryMetadata{return{id:row.id,workspaceId:row.workspace_id,projectId:row.project_id,ownerUserId:row.owner_user_id,scope:row.scope,contextKey:row.context_key,contentType:row.content_type,version:row.version,createdAt:toIso(row.created_at),updatedAt:toIso(row.updated_at)}}

function mapEndpoint(row: ModelEndpointRow): ModelEndpoint {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    protocol: row.protocol as EndpointProtocol,
    baseUrl: row.base_url,
    model: row.model,
    credentialId: row.credential_id ?? "",
    capabilities: asArray(row.capabilities) as EndpointCapability[],
    requestTimeoutSecs: row.request_timeout_secs,
    health: { status: row.health_status ?? "unknown", checkedAt: row.health_checked_at ? toIso(row.health_checked_at) : null, errorCategory: row.health_error_category ?? null },
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}
const endpointViewSelect=`select endpoint.*,credential.id as credential_summary_id,credential.name as credential_summary_name,credential.base_url as credential_summary_base_url,credential.version as credential_summary_version from model_endpoints endpoint left join project_credentials credential on credential.id=endpoint.credential_id and credential.project_id=endpoint.project_id`;
function mapEndpointView(row:EndpointViewRow):import("../../contracts/src/api.js").EndpointView{
  const endpoint=mapEndpoint(row),taskEligible=endpoint.credentialId.length>0&&endpoint.health?.status==="healthy"&&endpoint.capabilities.includes("text")&&endpoint.capabilities.includes("tool_calls");
  return{...endpoint,hasCredentialRef:endpoint.credentialId.length>0,taskEligible,credential:row.credential_summary_id&&row.credential_summary_name&&row.credential_summary_base_url&&row.credential_summary_version!==null?{id:row.credential_summary_id,name:row.credential_summary_name,baseUrl:row.credential_summary_base_url,version:row.credential_summary_version}:null};
}
function mapCredential(row: ProjectCredentialRow): ProjectCredential { return { id:row.id,projectId:row.project_id,name:row.name,type:row.type,baseUrl:row.base_url,fingerprint:row.fingerprint,version:row.version,createdAt:toIso(row.created_at),lastRotatedAt:row.last_rotated_at?toIso(row.last_rotated_at):null,updatedAt:toIso(row.updated_at) }; }
function mapStoredCredential(row: ProjectCredentialRow): StoredProjectCredential { return { ...mapCredential(row),keyId:row.key_id,nonce:Buffer.from(row.nonce),ciphertext:Buffer.from(row.ciphertext),authTag:Buffer.from(row.auth_tag) }; }

function mapTask(row: AgentTaskRow): PersistedAgentTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    endpointId: row.endpoint_id,
    fileLibraryId: row.file_library_id,
    createdByUserId: row.created_by_user_id,
    title: row.title,
    prompt: row.prompt,
    agentContext: row.agent_context ?? "",
    currentRunId: row.current_run_id,
    archivedAt: row.archived_at ? toIso(row.archived_at) : null,
    deletedAt: row.deleted_at ? toIso(row.deleted_at) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function mapProfile(row: ProfileRow): UserProfilePreferences { return { userId: row.user_id, displayName: row.display_name, timezone: row.timezone, bio:row.bio, jobTitle:row.job_title, company:row.company, greetingPreference:profileGreetingPreference(row.greeting_preference), interests:row.interests??[], updatedAt: toIso(row.updated_at) }; }
function profileGreetingPreference(value:string|null):ProfileGreetingPreference|null{return PROFILE_GREETING_PREFERENCES.includes(value as ProfileGreetingPreference)?value as ProfileGreetingPreference:null}
function mapNotification(row:NotificationRow):UserNotification{return{id:row.id,userId:row.user_id,type:row.type,title:row.title,body:row.body,projectId:row.project_id,resourceKind:row.resource_kind,resourceId:row.resource_id,linkPath:row.link_path,readAt:row.read_at?toIso(row.read_at):null,createdAt:toIso(row.created_at)}}
function mapAlertRule(row:AlertRuleRow):ProjectAlertRule{return{id:row.id,projectId:row.project_id,name:row.name,alertType:fromPersistedAlertType(row.alert_type),metric:fromPersistedAlertMetric(row.metric),condition:row.condition,threshold:Number(row.threshold),windowSeconds:row.window_seconds===null?null:Number(row.window_seconds),scope:mapAlertRuleScope(row),enabled:row.enabled,createdAt:toIso(row.created_at),updatedAt:toIso(row.updated_at)}}
function mapAlertRuleView(row:AlertRuleViewRow):import("../../contracts/src/api.js").ProjectAlertRuleView{return{...mapAlertRule(row),endpointName:row.endpoint_name}}
function mapAlertRuleScope(row:AlertRuleRow):AlertRuleScope{if(row.scope_kind==="project")return{kind:"project"};if(!row.endpoint_id)throw new Error("Endpoint-scoped alert rule row has no endpoint");return{kind:"endpoint",endpointId:row.endpoint_id}}

function mapProviderSettlement(row: ProviderSettlementRow): ProjectProviderSettlement {
  const tokens = row.provider_tokens === null ? undefined : Number(row.provider_tokens);
  const cost = row.provider_cost === null ? undefined : Number(row.provider_cost);
  return { id: row.id, projectId: row.project_id, taskId: row.task_id, endpointId: row.endpoint_id,actorId:row.actor_id,reservedTokens:Number(row.reserved_tokens),reservedCost:Number(row.reserved_cost), status: row.status, reservedAt: toIso(row.reserved_at), expiresAt: toIso(row.expires_at), dispatchedAt: row.dispatched_at ? toIso(row.dispatched_at) : null, deliveredAt: row.delivered_at ? toIso(row.delivered_at) : null, settledAt: row.settled_at ? toIso(row.settled_at) : null, ...(tokens !== undefined || cost !== undefined ? { usage: { ...(tokens !== undefined ? { tokens } : {}), ...(cost !== undefined ? { cost } : {}) } } : {}), updatedAt: toIso(row.updated_at) };
}

function mapTaskArtifact(row: AgentTaskArtifactRow): PersistedTaskArtifact {
  const artifact: PersistedTaskArtifact = {
    id: row.id,
    taskId: row.task_id,
    fileId: row.file_id,
    name: row.name,
    bytes: row.bytes,
    createdAt: toIso(row.created_at)
  };
  if (row.sha256 !== null && row.sha256 !== undefined) {
    artifact.sha256 = row.sha256;
  }
  artifact.mediaType = row.media_type ?? null;
  artifact.previewText = row.preview_text ?? null;
  return artifact;
}
function mapPersistedTaskMessage(row: TaskMessageRow): PersistedTaskMessage { return { id:row.id, taskId:row.task_id, actorId:row.actor_id, content:row.content, deliveryKey:row.delivery_key, requestHash:row.request_hash, claimToken:row.claim_token, receipt:mapTaskDeliveryReceipt(row.receipt), timelineCursor:row.timeline_cursor, deliveryStatus:row.delivery_status, claimedAt:row.claimed_at?toIso(row.claimed_at):null, leaseExpiresAt:row.lease_expires_at?toIso(row.lease_expires_at):null, attemptCount:row.attempt_count??0, nextRetryAt:row.next_retry_at?toIso(row.next_retry_at):null, safeError:row.safe_error, createdAt:toIso(row.created_at), updatedAt:toIso(row.updated_at), deletedAt:row.deleted_at?toIso(row.deleted_at):null }; }
function mapTaskInteractionChange(row: TaskInteractionChangeRow): PersistedTaskInteractionChange {
  const interaction = asRecord(row.interaction) as unknown as TaskInteractionItem;
  const sourceRevision = parseTaskInteractionSourceRevision(row.source_revision);
  if (interaction.id !== row.interaction_id || interaction.taskId !== row.task_id || interaction.revision !== row.revision || interaction.kind !== row.interaction_kind || interaction.position !== Number(row.position) || (row.source_kind === "botified" && sourceRevision !== 0)) throw new Error("Stored task interaction is inconsistent");
  return { changeSeq:Number(row.change_seq),sourceKind:row.source_kind,sourceId:row.source_id,sourceRevision,interaction,correlation:{toolCallId:row.tool_call_id,workTaskId:row.work_task_id,callbackId:row.callback_id} };
}
function parseTaskInteractionSourceRevision(value:string|number):number {
  const revision=Number(value);
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error("Stored task interaction source revision is invalid");
  return revision;
}

function validatePostgresInteractionChange(taskId:string,change:PersistTaskInteractionMutationInput["changes"][number]):void {
  if(change.interaction.taskId!==taskId||change.interaction.id.length===0||change.sourceId.length===0)throw new Error("Task interaction identity mismatch");
  if(change.sourceKind==="botified"&&change.sourceRevision!==0)throw new Error("Botified interaction revisions are cursor-based");
  if(!Number.isSafeInteger(change.sourceRevision)||change.sourceRevision<0||!Number.isSafeInteger(change.interaction.revision)||change.interaction.revision<1||!Number.isSafeInteger(change.interaction.position)||change.interaction.position<0)throw new Error("Task interaction sequence is invalid");
}

function mapTaskDeliveryReceipt(value: unknown): NonNullable<PersistedTaskMessage["receipt"]> | null {
  const receipt = asRecord(value);
  if (typeof receipt.accepted !== "boolean" || typeof receipt.deliveryKey !== "string" || typeof receipt.requestHash !== "string") return null;
  return {
    accepted: receipt.accepted,
    deliveryKey: receipt.deliveryKey,
    requestHash: receipt.requestHash,
    ...(typeof receipt.messageId === "string" ? { messageId: receipt.messageId } : {}),
    ...(typeof receipt.cursor === "string" ? { cursor: receipt.cursor } : {})
  };
}

function policyValues(policy: ProjectResourcePolicy): unknown[] { return [policy.projectId, policy.sandboxLimit, policy.providerRequestsLimit, policy.providerTokensLimit, policy.providerCostLimit, policy.projectFileBytesLimit, policy.createdAt, policy.updatedAt]; }
function usageValues(usage: ProjectResourceUsage): unknown[] { return [usage.projectId, usage.activeSandboxes, usage.providerRequests, usage.providerTokens, usage.providerCost, usage.projectFileBytes, usage.projectFileBytesMeasuredAt, usage.updatedAt]; }
function mapPolicy(row: ProjectPolicyRow): ProjectResourcePolicy {
  if (row.active_tasks_limit === null) throw new Error("Project Sandbox limit is not configured");
  return { projectId: row.project_id, sandboxLimit: row.active_tasks_limit, providerRequestsLimit: nullableNumber(row.provider_requests_limit), providerTokensLimit: nullableNumber(row.provider_tokens_limit), providerCostLimit: row.provider_cost_limit, projectFileBytesLimit: nullableNumber(row.project_file_bytes_limit), endpointWindows:[], createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at) };
}
function mapUsage(row: ProjectUsageRow): ProjectResourceUsage { return { projectId: row.project_id, activeSandboxes: row.active_tasks, providerRequests: Number(row.provider_requests), providerTokens: Number(row.provider_tokens), providerCost: row.provider_cost, projectFileBytes: Number(row.project_file_bytes), projectFileBytesMeasuredAt: row.project_file_bytes_measured_at?toIso(row.project_file_bytes_measured_at):null, updatedAt: toIso(row.updated_at) }; }
function providerExceededLimits(row:ProjectProviderSettlementRow):ProjectProviderUsageSettlement["exceededLimits"]{return[...(row.provider_requests_exceeded?["provider_requests_limit" as const]:[]),...(row.provider_tokens_exceeded?["provider_tokens_limit" as const]:[]),...(row.provider_cost_exceeded?["provider_cost_limit" as const]:[])]}

function usageColumn(limit: ProjectAlertType): string { return limit === "sandbox_capacity" ? "active_tasks" : limit === "provider_requests_limit" ? "provider_requests" : limit === "provider_tokens_limit" ? "provider_tokens" : limit === "provider_cost_limit" ? "provider_cost" : "project_file_bytes"; }
function usageLimitColumn(limit: ProjectAlertType): string { return `${usageColumn(limit)}_limit`; }
function usageDeltaPlaceholder(limit: ProjectAlertType): number { return limit === "provider_requests_limit" ? 2 : limit === "provider_tokens_limit" ? 3 : limit === "provider_cost_limit" ? 4 : 5; }
function usageDelta(limit: ProjectAlertType, delta: ProjectResourceUsageAdjustment["delta"]): number { return limit === "sandbox_capacity" ? delta.activeSandboxes : limit === "provider_requests_limit" ? delta.providerRequests : limit === "provider_tokens_limit" ? delta.providerTokens : limit === "provider_cost_limit" ? delta.providerCost : delta.projectFileBytes; }
function mapAlert(row:ProjectAlertRow):ProjectAlert{
  const fields={id:row.id,projectId:row.project_id,deliveryStatus:row.delivery_status,ruleId:row.rule_id,metric:row.metric===null?null:fromPersistedAlertMetric(row.metric),metricValue:row.metric_value===null?null:Number(row.metric_value),threshold:row.threshold===null?null:Number(row.threshold),endpointId:row.endpoint_id,endpointName:row.endpoint_name??null,subjectActorId:row.subject_actor_id,acknowledgedAt:row.acknowledged_at?toIso(row.acknowledged_at):null,acknowledgedBy:row.acknowledged_by,silencedUntil:row.silenced_until?toIso(row.silenced_until):null,createdAt:toIso(row.created_at),updatedAt:toIso(row.updated_at),resolvedAt:row.resolved_at?toIso(row.resolved_at):null,dismissedAt:row.dismissed_at?toIso(row.dismissed_at):null};
  const type=fromPersistedAlertType(row.type);
  if(row.status==="active")return{...fields,type,status:"active"};
  return{...fields,type,status:row.status};
}
function toPersistedAlertType(value:ProjectAlertType):PersistedProjectAlertType{return value==="sandbox_capacity"?"active_tasks_limit":value}
function fromPersistedAlertType(value:PersistedProjectAlertType):ProjectAlertType{return value==="active_tasks_limit"?"sandbox_capacity":value}
function toPersistedAlertMetric(value:AlertRuleMetric):PersistedAlertRuleMetric{return value==="active_sandboxes"?"active_tasks":value}
function fromPersistedAlertMetric(value:PersistedAlertRuleMetric):AlertRuleMetric{return value==="active_tasks"?"active_sandboxes":value}
function mapActiveAlert(row:ProjectAlertRow):ActiveProjectAlert{const alert=mapAlert(row);if(!isActiveProjectAlert(alert))throw new Error("Expected an active project alert row");return alert}
function mapAudit(row: ProjectAuditRow): ProjectAuditEvent { return { id: row.id, projectId: row.project_id, actorId: row.actor_id, subjectUserId:row.subject_user_id??null, action: row.action, status: row.status, resourceKind: row.resource_kind, resourceId: row.resource_id,detail:mapPersistedAuditDetail(row.detail), createdAt: toIso(row.created_at) }; }
function mapAuditView(row:ProjectAuditRow):import("../../contracts/src/api.js").ProjectAuditEventView{return{...mapAudit(row),actorDisplayName:row.actor_display_name,actorEmail:row.actor_email,subjectDisplayName:row.subject_display_name,subjectEmail:row.subject_email}}
function mapPersistedAuditDetail(value:unknown):NonNullable<ProjectAuditEvent["detail"]>{
  if(!value||typeof value!=="object"||Array.isArray(value))return{};
  const source=value as Record<string,unknown>;
  return sanitizeProjectAuditDetail({
    ...source,
    ...(source.metric==="active_tasks"?{metric:"active_sandboxes"}:{}),
    ...(typeof source.activeTasks==="number"?{activeSandboxes:source.activeTasks}:{}),
    ...(typeof source.activeTasksLimit==="number"?{sandboxLimit:source.activeTasksLimit}:{})
  });
}
function mapSandboxUsageSettlement(row:SandboxUsageSettlementRow):SandboxUsageSettlement{return{runId:row.run_id,workspaceId:row.workspace_id,projectId:row.project_id,taskId:row.task_id,fileLibraryId:row.file_library_id,startedByUserId:row.started_by_user_id,startedAt:row.started_at?toIso(row.started_at):null,releasedAt:toIso(row.released_at),durationSeconds:Number(row.duration_seconds),resources:{cpuRequestMillis:String(row.cpu_request_millis),memoryRequestBytes:String(row.memory_request_bytes),cpuLimitMillis:String(row.cpu_limit_millis),memoryLimitBytes:String(row.memory_limit_bytes)},releaseReason:row.release_reason}}
function mapSandboxRun(row:SandboxRunRow):PersistedSandboxRunState {
  return {
    runId:row.run_id,workspaceId:row.workspace_id,projectId:row.project_id,taskId:row.task_id,fileLibraryId:row.file_library_id,
    startedByUserId:row.started_by_user_id,state:row.state,namespace:row.namespace,image:row.image,pvcName:row.pvc_name,
    projectSubPath:row.project_sub_path,fileLibraryRootSubPath:row.file_library_root_sub_path,botifiedPort:row.botified_port,
    resourceNames:asRecord(row.resource_names) as unknown as PersistedSandboxRunState["resourceNames"],
    serviceKeySecretRef:asRecord(row.service_key_secret_ref) as unknown as PersistedSandboxRunState["serviceKeySecretRef"],
    directories:asRecord(row.directories) as unknown as PersistedSandboxRunState["directories"],
    resourceLimits:asRecord(row.resource_limits) as unknown as PersistedSandboxRunState["resourceLimits"],
    resourceSnapshot:asRecord(row.resource_snapshot) as unknown as PersistedSandboxRunState["resourceSnapshot"],
    ...(row.model_ca?{modelCa:asRecord(row.model_ca) as unknown as NonNullable<PersistedSandboxRunState["modelCa"]>}:{}),
    timelineCursor:row.timeline_cursor,
    terminalFailure:row.terminal_failure?asRecord(row.terminal_failure) as unknown as NonNullable<PersistedSandboxRunState["terminalFailure"]>:null,
    failureCode:row.failure_code??null,failureCause:row.failure_cause,fencingToken:Number(row.fencing_token),resumeUnfinished:row.resume_unfinished,
    startupReadyAt:row.startup_ready_at?toIso(row.startup_ready_at):null,startupActionDeadlineAt:row.startup_action_deadline_at?toIso(row.startup_action_deadline_at):null,startupClaimToken:row.startup_claim_token,startupLeaseExpiresAt:row.startup_lease_expires_at?toIso(row.startup_lease_expires_at):null,
    cleanupClaimedAt:row.cleanup_claimed_at?toIso(row.cleanup_claimed_at):null,cleanupAttempts:row.cleanup_attempts,
    lastCleanupAt:row.last_cleanup_at?toIso(row.last_cleanup_at):null,
    lastCleanupError:row.last_cleanup_error?asRecord(row.last_cleanup_error) as unknown as NonNullable<PersistedSandboxRunState["lastCleanupError"]>:null,
    releaseReason:row.release_reason??null,startedAt:row.started_at?toIso(row.started_at):null,
    releaseRequestedAt:row.release_requested_at?toIso(row.release_requested_at):null,failedAt:row.failed_at?toIso(row.failed_at):null,
    releasedAt:row.released_at?toIso(row.released_at):null,createdAt:toIso(row.created_at),updatedAt:toIso(row.updated_at)
  };
}
function validateTaskRunReservation(input:AtomicTaskCreateInput):void{const expectedRunId=input.sandboxRun?.runId??null;const reservesActive=input.sandboxRun!==undefined&&input.sandboxRun.state!=="released";const run=input.sandboxRun;if(input.task.currentRunId!==expectedRunId||input.reserveActive!==reservesActive||(run!==undefined&&(input.task.id!==run.taskId||input.task.workspaceId!==run.workspaceId||input.task.projectId!==run.projectId||input.task.fileLibraryId!==run.fileLibraryId)))throw new Error("Task Run reservation is inconsistent")}

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

function terminalBoundRunReceipt(run:PersistedSandboxRunState,presentation:TaskPresentation):{responseStatus:number;responseBody:unknown}{
  if(run.state==="active")return{responseStatus:200,responseBody:{status:"active",runId:run.runId,presentation}};
  if(run.state==="failed"||run.state==="release_requested")return{responseStatus:502,responseBody:{error:{code:"sandbox_start_failed",message:"Sandbox could not be started",retryable:true,details:null,presentation}}};
  return{responseStatus:409,responseBody:{error:{code:"task_sandbox_released",message:"Task sandbox is released",retryable:false,details:null,presentation}}};
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
function taskRunRowIdentityMatches(task:AgentTaskRow,run:PersistedSandboxRunState,input:ActivateTaskSandboxRunInput):boolean{return task.id===input.taskId&&task.current_run_id===input.runId&&run.taskId===input.taskId&&run.runId===input.runId&&task.workspace_id===run.workspaceId&&task.project_id===run.projectId&&task.file_library_id===run.fileLibraryId}
function sameSettlement(left:SandboxUsageSettlement,right:SandboxUsageSettlement):boolean{return strictStructuralEqual(left,right)}
function settlementMatchesRun(value:SandboxUsageSettlement,current:PersistedSandboxRunState,released:PersistedSandboxRunState):boolean{const releasedAt=released.releasedAt;const duration=current.startedAt===null||!releasedAt?0:Math.max(0,(Date.parse(releasedAt)-Date.parse(current.startedAt))/1000);return Boolean(releasedAt)&&value.runId===current.runId&&value.workspaceId===current.workspaceId&&value.projectId===current.projectId&&value.taskId===current.taskId&&value.fileLibraryId===current.fileLibraryId&&value.startedByUserId===current.startedByUserId&&value.startedAt===current.startedAt&&value.releasedAt===releasedAt&&value.durationSeconds===duration&&value.releaseReason===released.releaseReason&&strictStructuralEqual(value.resources,current.resourceSnapshot)}
function taskMatchesActiveSandboxRunRow(task:SandboxReleaseTaskRow|undefined,run:PersistedSandboxRunState):task is SandboxReleaseTaskRow{return Boolean(task&&task.deleted_at===null&&task.id===run.taskId&&task.current_run_id===run.runId&&task.project_id===run.projectId&&task.workspace_id===run.workspaceId&&task.file_library_id===run.fileLibraryId&&task.project_workspace_id===run.workspaceId)}
function nullableNumber(value: string | number | null): number | null { return value === null ? null : Number(value); }
function escapeLikePattern(value:string):string{return value.replace(/[\\%_]/g,"\\$&");}
function isUniqueConstraintError(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "23505"; }
function isConstraintError(error: unknown, constraint: string): boolean { return isUniqueConstraintError(error) && typeof error === "object" && error !== null && "constraint" in error && error.constraint === constraint; }
function isForeignKeyConstraintError(error:unknown,constraint:string):boolean{return typeof error==="object"&&error!==null&&"code" in error&&error.code==="23503"&&"constraint" in error&&error.constraint===constraint;}

function mapLease(row: RuntimeLeaseRow | undefined): LeaseRecord {
  if (!row) {
    throw new Error("Expected runtime lease row");
  }
  return {
    name: row.name,
    holder: row.holder,
    fencingToken: Number(row.fencing_token),
    expiresAt: toIso(row.expires_at),
    metadata: asRecord(row.metadata)
  };
}

function publicUser(user: StoredUser): User {
  const { passwordHash: _passwordHash, ...rest } = user;
  return structuredClone(rest);
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return new Date(value).toISOString();
  }
  throw new Error(`Expected timestamp value, got ${typeof value}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return structuredClone(value as Record<string, unknown>);
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? structuredClone(value) : [];
}
