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
  ProjectAlert,
  ProjectAuditEvent,
  ProjectResourcePolicy,
  ProjectResourceUsage,
  ProviderUsage,
  ProjectProviderSettlement,
  StoredUser,
  UpdateProjectResourcePolicyInput,
  User,
  Workspace, ManagedWorkspaceMembershipRole, WorkspaceMembership, WorkspaceMembershipView, WorkspaceListProjection, UserProfilePreferences, ProfileGreetingPreference, ProjectContextEntry, UserNotification, ProjectAlertRule, ProjectCredential, StoredProjectCredential
} from "../../contracts/src/api.js";
import { PROFILE_GREETING_PREFERENCES, sanitizeProjectAuditDetail } from "../../contracts/src/api.js";
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
  AtomicTaskSandboxRestartInput,
  AtomicTaskSandboxRestartResult,
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
  ConfirmSandboxRunStartedInput,
  ConfirmSandboxRunStartedResult,
  ActivateTaskSandboxRunInput,
  ActivateTaskSandboxRunResult,
  CompleteSandboxRunReleaseInput,
  CompleteSandboxRunReleaseResult,
  SandboxUsageSettlement,
  PersistTaskArtifactProjectionInput,
  DeleteEndpointResult,
  DeleteProjectCredentialResult,
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
  TaskInteractionChangeInput,
  TaskInteractionCorrelation,
  TaskInteractionPageAnchor,
  TaskInteractionStoreSnapshot
} from "../../ports/src/store.js";
import type { Pool as PgPool, PoolClient } from "pg";
import { prepareSandboxRunDocument, sandboxRunFromDocument } from "./sandboxRunDocuments.js";

const { Pool } = createRequire(import.meta.url)("pg") as typeof import("pg");

export function createPostgresProductStore(connectionString: string): PostgresProductStore {
  return new PostgresProductStore(connectionString);
}

export class PostgresProductStore implements ProductStore {
  readonly observedExternalModelCalls = 0;
  readonly jsonDocs: PostgresJsonDocStore;
  readonly leases: PostgresLeaseStore;
  readonly sandboxRuns: PostgresSandboxRunStoreImpl;

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

  async listWorkspacesForUser(userId: string): Promise<WorkspaceListProjection[]> {
    const rows = await this.queryRows<WorkspaceRow>(
      `select w.*, viewer.role as member_role, owner.email as owner_email, owner_profile.display_name as owner_display_name from workspaces w join workspace_memberships viewer on viewer.workspace_id = w.id and viewer.user_id = $1 join users owner on owner.id = w.owner_user_id left join user_profile_preferences owner_profile on owner_profile.user_id = owner.id order by w.created_at, w.id`,
      [userId]
    );
    return rows.map(mapWorkspaceListProjection);
  }

  async findWorkspace(id: string): Promise<Workspace | null> {
    const rows = await this.queryRows<WorkspaceRow>("select * from workspaces where id = $1", [id]);
    return rows[0] ? mapWorkspace(rows[0]) : null;
  }
  async updateWorkspaceName(workspaceId:string,name:string,updatedAt:string,expectedName:string):Promise<Workspace|null>{const rows=await this.queryRows<WorkspaceRow>("update workspaces set name=$2,updated_at=$3 where id=$1 and lifecycle_status='active' and name=$4 returning *",[workspaceId,name,updatedAt,expectedName]);return rows[0]?mapWorkspace(rows[0]):null}
  async beginWorkspaceDeletion(id:string,updatedAt:string,expectedOwnerUserId?:string){return transaction(this.pool,async(client)=>{const locked=await client.query<WorkspaceRow>("select * from workspaces where id=$1 for update",[id]);const workspace=locked.rows[0];if(!workspace||expectedOwnerUserId!==undefined&&workspace.owner_user_id!==expectedOwnerUserId)return{kind:"not_found_or_forbidden" as const};await client.query("select id from projects where workspace_id=$1 for update",[id]);const blocked=await client.query(`select 1 from agent_tasks task join projects project on project.id=task.project_id left join postgres_json_docs run on run.collection='sandbox_run_state' and run.id=task.run_id where project.workspace_id=$1 and task.deleted_at is null and task.execution_mode='live' and (task.active_reservation=true or run.document is null or (run.document->>'taskId') is distinct from task.id or (run.document->>'runId') is distinct from task.run_id or (run.document->>'projectId') is distinct from task.project_id or (run.document->>'workspaceId') is distinct from task.workspace_id or (coalesce(run.document->>'cleanupStatus','')<>'cleaned' and coalesce(run.document->>'phase','')<>'cleaned')) union all select 1 from postgres_json_docs run where run.collection='sandbox_run_state' and run.document->>'workspaceId'=$1 and coalesce(run.document->>'cleanupStatus','')<>'cleaned' and coalesce(run.document->>'phase','')<>'cleaned' limit 1`,[id]);if(blocked.rowCount){if(workspace.lifecycle_status==="deleting"){await client.query("update workspaces set lifecycle_status='active',updated_at=$2 where id=$1",[id,updatedAt]);await client.query(`update projects project set lifecycle_status='active',updated_at=$2 where project.workspace_id=$1 and project.lifecycle_status='deleting' and (exists (select 1 from agent_tasks task left join postgres_json_docs run on run.collection='sandbox_run_state' and run.id=task.run_id where task.project_id=project.id and task.deleted_at is null and task.execution_mode='live' and (task.active_reservation=true or run.document is null or (run.document->>'taskId') is distinct from task.id or (run.document->>'runId') is distinct from task.run_id or (run.document->>'projectId') is distinct from task.project_id or (run.document->>'workspaceId') is distinct from task.workspace_id or (coalesce(run.document->>'cleanupStatus','')<>'cleaned' and coalesce(run.document->>'phase','')<>'cleaned'))) or exists (select 1 from postgres_json_docs run where run.collection='sandbox_run_state' and run.document->>'projectId'=project.id and coalesce(run.document->>'cleanupStatus','')<>'cleaned' and coalesce(run.document->>'phase','')<>'cleaned'))`,[id,updatedAt]);}return{kind:"sandbox_not_released" as const};}if(workspace.lifecycle_status==="deleting")return{kind:"ready" as const,value:mapWorkspace(workspace)};const updated=await client.query<WorkspaceRow>("update workspaces set lifecycle_status='deleting',updated_at=$2 where id=$1 returning *",[id,updatedAt]);await client.query("update projects set lifecycle_status='deleting',updated_at=$2 where workspace_id=$1",[id,updatedAt]);return{kind:"ready" as const,value:mapWorkspace(updated.rows[0]!)}})}
  async setWorkspaceLifecycleStatus(id:string,status:"active"|"archived",updatedAt:string):Promise<Workspace|null>{const rows=await this.queryRows<WorkspaceRow>("update workspaces set lifecycle_status=$2,updated_at=$3 where id=$1 and lifecycle_status <> 'deleting' returning *",[id,status,updatedAt]);return rows[0]?mapWorkspace(rows[0]):null}
  async transferWorkspaceOwner(workspaceId:string,fromUserId:string,toUserId:string,updatedAt:string):Promise<Workspace|null>{return transaction(this.pool,async(client)=>{if(fromUserId===toUserId)return null;const target=await client.query("select 1 from workspace_memberships where workspace_id=$1 and user_id=$2 for update",[workspaceId,toUserId]);if(!target.rowCount)return null;const workspace=await client.query<WorkspaceRow>("update workspaces set owner_user_id=$3,updated_at=$4 where id=$1 and owner_user_id=$2 and lifecycle_status='active' returning *",[workspaceId,fromUserId,toUserId,updatedAt]);if(!workspace.rows[0])return null;await client.query("update workspace_memberships set role='admin',updated_at=$3 where workspace_id=$1 and user_id=$2",[workspaceId,fromUserId,updatedAt]);await client.query("update workspace_memberships set role='owner',updated_at=$3 where workspace_id=$1 and user_id=$2",[workspaceId,toUserId,updatedAt]);return mapWorkspace(workspace.rows[0])})}
  async deleteWorkspaceAfterProjects(id:string):Promise<boolean>{return transaction(this.pool,async(client)=>{const ready=await client.query("select 1 from workspaces where id=$1 and lifecycle_status='deleting' and not exists (select 1 from projects where workspace_id=$1) for update",[id]);if(ready.rowCount!==1)return false;await client.query("delete from project_context_entries where workspace_id=$1",[id]);return (await client.query("delete from workspaces where id=$1 and lifecycle_status='deleting'",[id])).rowCount===1})}
  async findWorkspaceMembership(workspaceId:string,userId:string):Promise<WorkspaceMembership|null>{const rows=await this.queryRows<WorkspaceMembershipRow>("select * from workspace_memberships where workspace_id=$1 and user_id=$2",[workspaceId,userId]);return rows[0]?mapWorkspaceMembership(rows[0]):null}
  async listWorkspaceMemberships(workspaceId:string):Promise<WorkspaceMembershipView[]>{return (await this.queryRows<WorkspaceMembershipRow>("select wm.*, u.email, p.display_name from workspace_memberships wm join users u on u.id=wm.user_id left join user_profile_preferences p on p.user_id=u.id where wm.workspace_id=$1 order by wm.created_at,wm.user_id",[workspaceId])).map(mapWorkspaceMembershipView)}
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
          project.taskConcurrencyLimit,
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
        [project.id, project.taskConcurrencyLimit, project.createdAt, project.updatedAt]
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

  async listProjectPinsForUser(userId:string){return this.queryRows<{project_id:string;pinned_at:unknown}>("select project_id,pinned_at from user_project_pins where user_id=$1 order by pinned_at desc,project_id",[userId]).then((rows)=>rows.map((row)=>({projectId:row.project_id,pinnedAt:toIso(row.pinned_at)})))}
  async setProjectPin(userId:string,projectId:string,pinnedAt:string|null){return transaction(this.pool,async(client)=>{const membership=await client.query("select 1 from project_memberships where project_id=$1 and user_id=$2 for share",[projectId,userId]);if(!membership.rowCount)return false;if(pinnedAt)await client.query("insert into user_project_pins (project_id,user_id,pinned_at) values ($1,$2,$3) on conflict (project_id,user_id) do update set pinned_at=excluded.pinned_at",[projectId,userId,pinnedAt]);else await client.query("delete from user_project_pins where project_id=$1 and user_id=$2",[projectId,userId]);return true})}

  async findProject(id: string): Promise<Project | null> {
    const rows = await this.queryRows<ProjectRow>("select * from projects where id = $1", [id]);
    return rows[0] ? mapProject(rows[0]) : null;
  }
  async updateProjectName(projectId:string,name:string,updatedAt:string,expectedName:string):Promise<Project|null>{const rows=await this.queryRows<ProjectRow>("update projects set name=$2,updated_at=$3 where id=$1 and lifecycle_status='active' and name=$4 returning *",[projectId,name,updatedAt,expectedName]);return rows[0]?mapProject(rows[0]):null}
  async beginProjectDeletion(id:string,updatedAt:string,expectedOwnerUserId?:string){return transaction(this.pool,async(client)=>{const locked=await client.query<ProjectRow>("select * from projects where id=$1 for update",[id]);const project=locked.rows[0];if(!project||expectedOwnerUserId!==undefined&&project.owner_user_id!==expectedOwnerUserId)return{kind:"not_found_or_forbidden" as const};const blocked=await client.query(`select 1 from agent_tasks task left join postgres_json_docs run on run.collection='sandbox_run_state' and run.id=task.run_id where task.project_id=$1 and task.deleted_at is null and task.execution_mode='live' and (task.active_reservation=true or run.document is null or (run.document->>'taskId') is distinct from task.id or (run.document->>'runId') is distinct from task.run_id or (run.document->>'projectId') is distinct from task.project_id or (run.document->>'workspaceId') is distinct from task.workspace_id or (coalesce(run.document->>'cleanupStatus','')<>'cleaned' and coalesce(run.document->>'phase','')<>'cleaned')) union all select 1 from postgres_json_docs run where run.collection='sandbox_run_state' and run.document->>'projectId'=$1 and coalesce(run.document->>'cleanupStatus','')<>'cleaned' and coalesce(run.document->>'phase','')<>'cleaned' limit 1`,[id]);if(blocked.rowCount){if(project.lifecycle_status==="deleting")await client.query("update projects set lifecycle_status='active',updated_at=$2 where id=$1",[id,updatedAt]);return{kind:"sandbox_not_released" as const};}if(project.lifecycle_status==="deleting")return{kind:"ready" as const,value:mapProject(project)};const updated=await client.query<ProjectRow>("update projects set lifecycle_status='deleting',updated_at=$2 where id=$1 returning *",[id,updatedAt]);return{kind:"ready" as const,value:mapProject(updated.rows[0]!)}})}
  async setProjectLifecycleStatus(id:string,status:"active"|"archived",updatedAt:string):Promise<Project|null>{const rows=await this.queryRows<ProjectRow>("update projects set lifecycle_status=$2,updated_at=$3 where id=$1 and lifecycle_status <> 'deleting' returning *",[id,status,updatedAt]);return rows[0]?mapProject(rows[0]):null}
  async transferProjectOwner(projectId:string,fromUserId:string,toUserId:string,updatedAt:string):Promise<Project|null>{return transaction(this.pool,async(client)=>{if(fromUserId===toUserId)return null;const target=await client.query("select 1 from project_memberships where project_id=$1 and user_id=$2 for update",[projectId,toUserId]);if(!target.rowCount)return null;const project=await client.query<ProjectRow>("update projects set owner_user_id=$3,updated_at=$4 where id=$1 and owner_user_id=$2 and lifecycle_status='active' returning *",[projectId,fromUserId,toUserId,updatedAt]);if(!project.rows[0])return null;await client.query("update project_memberships set role='admin',updated_at=$3 where project_id=$1 and user_id=$2",[projectId,fromUserId,updatedAt]);await client.query("update project_memberships set role='owner',updated_at=$3 where project_id=$1 and user_id=$2",[projectId,toUserId,updatedAt]);return mapProject(project.rows[0])})}
  async deleteProjectDependenciesAndProject(id:string):Promise<boolean>{
    return transaction(this.pool,async(client)=>{
      const project=await client.query<ProjectRow>("select * from projects where id=$1 and lifecycle_status='deleting' for update",[id]);
      if(!project.rows[0])return false;
      const taskIds=(await client.query<{id:string;run_id:string}>("select id,run_id from agent_tasks where project_id=$1",[id])).rows;
      for(const task of taskIds)await client.query("delete from postgres_json_docs where (collection='sandbox_runtime_state' and id=$1) or (collection='sandbox_run_state' and id=$2)",[task.id,task.run_id]);
      await client.query("delete from task_messages where task_id in (select id from agent_tasks where project_id=$1)",[id]);
      await client.query("delete from agent_task_artifacts where task_id in (select id from agent_tasks where project_id=$1)",[id]);
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
      return true;
    });
  }
  async deleteProjectAfterDependencies(id:string):Promise<boolean>{return (await this.pool.query("delete from projects where id=$1 and lifecycle_status='deleting' and not exists (select 1 from agent_tasks where project_id=$1)",[id])).rowCount===1}
  async createProjectContextEntry(v: ProjectContextEntry): Promise<ProjectContextEntry | null> { const rows=await this.queryRows<ContextRow>(`insert into project_context_entries (id,workspace_id,project_id,owner_user_id,scope,context_key,content,content_type,name,user_id,version,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$6,$4,$9,$10,$11) on conflict do nothing returning *`,[v.id,v.workspaceId,v.projectId,v.ownerUserId,v.scope,v.contextKey,v.content,v.contentType??"text",v.version,v.createdAt,v.updatedAt]); return rows[0]?mapContext(rows[0]):null; }
  async updateProjectContextEntry(v: ProjectContextEntry, expectedVersion: number): Promise<ProjectContextEntry | null> { try { const rows=await this.queryRows<ContextRow>(`update project_context_entries set context_key=$2,content=$3,content_type=$4,version=$5,updated_at=$6 where id=$1 and version=$7 and workspace_id=$8 and project_id is not distinct from $9 and scope=$10 and owner_user_id is not distinct from $11 returning *`,[v.id,v.contextKey,v.content,v.contentType??"text",v.version,v.updatedAt,expectedVersion,v.workspaceId,v.projectId,v.scope,v.ownerUserId]); return rows[0]?mapContext(rows[0]):null; } catch(error) { if(isUniqueConstraintError(error))return null;throw error; } }
  async listProjectContextEntries(workspaceId:string,projectId:string|null,scope:ProjectContextEntry["scope"],ownerUserId:string|null): Promise<ProjectContextEntry[]> { const rows=await this.queryRows<ContextRow>('select * from project_context_entries where workspace_id=$1 and project_id is not distinct from $2 and scope=$3 and owner_user_id is not distinct from $4 order by context_key',[workspaceId,projectId,scope,ownerUserId]);return rows.map(mapContext); }
  async deleteProjectContextEntry(v: Pick<ProjectContextEntry, "id" | "workspaceId" | "projectId" | "scope" | "ownerUserId" | "version">): Promise<boolean> { return (await this.pool.query('delete from project_context_entries where id=$1 and workspace_id=$2 and project_id is not distinct from $3 and scope=$4 and owner_user_id is not distinct from $5 and version=$6',[v.id,v.workspaceId,v.projectId,v.scope,v.ownerUserId,v.version])).rowCount===1; }
  async createProjectAlertRule(v:ProjectAlertRule){const scope=v.scope??{kind:'project' as const};const r=await this.queryRows<AlertRuleRow>('insert into project_alert_rules (id,project_id,alert_type,name,metric,condition,threshold,window_seconds,scope_kind,endpoint_id,enabled,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *',[v.id,v.projectId,v.alertType,v.name??v.alertType.replaceAll('_',' '),v.metric??'failure_count',v.condition??'greater_than_or_equal',v.threshold??1,v.windowSeconds??null,scope.kind,scope.kind==='endpoint'?scope.endpointId:null,v.enabled,v.createdAt,v.updatedAt]);return mapAlertRule(r[0]!)} async listProjectAlertRules(id:string){return (await this.queryRows<AlertRuleRow>('select * from project_alert_rules where project_id=$1 order by created_at',[id])).map(mapAlertRule)} async updateProjectAlertRule(v:ProjectAlertRule,expectedUpdatedAt?:string){const scope=v.scope??{kind:'project' as const};const values:unknown[]=[v.id,v.alertType,v.name??v.alertType.replaceAll('_',' '),v.metric??'failure_count',v.condition??'greater_than_or_equal',v.threshold??1,v.windowSeconds??null,scope.kind,scope.kind==='endpoint'?scope.endpointId:null,v.enabled,v.updatedAt,v.projectId];const expected=expectedUpdatedAt===undefined?'':` and updated_at=$13`;if(expectedUpdatedAt!==undefined)values.push(expectedUpdatedAt);const r=await this.queryRows<AlertRuleRow>(`update project_alert_rules set alert_type=$2,name=$3,metric=$4,condition=$5,threshold=$6,window_seconds=$7,scope_kind=$8,endpoint_id=$9,enabled=$10,updated_at=$11 where id=$1 and project_id=$12${expected} returning *`,values);return r[0]?mapAlertRule(r[0]):null} async deleteProjectAlertRule(projectId:string,id:string){return (await this.pool.query('delete from project_alert_rules where id=$1 and project_id=$2',[id,projectId])).rowCount===1}

  async listProjectsForUser(userId: string): Promise<Project[]> {
    const rows = await this.queryRows<ProjectRow>(
      `select distinct p.* from projects p
       left join project_memberships pm on pm.project_id = p.id
       where pm.user_id = $1
       order by p.created_at, p.id`,
      [userId]
    );
    return rows.map(mapProject);
  }

  async createFileLibrary(value:FileLibrary):Promise<FileLibrary|null>{
    const rows=await this.queryRows<FileLibraryRow>(`insert into file_libraries(id,workspace_id,project_id,name,root_sub_path,created_by_user_id,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning *`,[value.id,value.workspaceId,value.projectId,value.name,value.rootSubPath,value.createdByUserId,value.createdAt,value.updatedAt]);
    return rows[0]?mapFileLibrary(rows[0]):null;
  }
  async findFileLibrary(id:string):Promise<FileLibrary|null>{const rows=await this.queryRows<FileLibraryRow>("select * from file_libraries where id=$1",[id]);return rows[0]?mapFileLibrary(rows[0]):null}
  async listFileLibrariesForProject(projectId:string):Promise<FileLibrary[]>{return (await this.queryRows<FileLibraryRow>("select * from file_libraries where project_id=$1 order by created_at,id",[projectId])).map(mapFileLibrary)}
  async renameFileLibrary(projectId:string,id:string,name:string,expectedUpdatedAt:string,updatedAt:string):Promise<FileLibrary|null>{
    try{const rows=await this.queryRows<FileLibraryRow>("update file_libraries set name=$3,updated_at=$5 where project_id=$1 and id=$2 and updated_at=$4 returning *",[projectId,id,name,expectedUpdatedAt,updatedAt]);return rows[0]?mapFileLibrary(rows[0]):null}catch(error){if(isUniqueConstraintError(error))return null;throw error}
  }
  async deleteFileLibraryIfUnbound(projectId:string,id:string){return transaction(this.pool,async(client)=>{const current=await client.query("select id from file_libraries where project_id=$1 and id=$2 for update",[projectId,id]);if(!current.rows[0])return"not_found" as const;const deleted=await client.query("delete from file_libraries library where library.project_id=$1 and library.id=$2 and not exists (select 1 from agent_tasks task where task.file_library_id=library.id and task.deleted_at is null)",[projectId,id]);return deleted.rowCount===1?"deleted" as const:"bound" as const;})}
  async findTaskBoundToFileLibrary(fileLibraryId:string){const rows=await this.queryRows<{id:string;title:string|null}>("select id,title from agent_tasks where file_library_id=$1 and deleted_at is null",[fileLibraryId]);return rows[0]?{kind:"bound" as const,task:{id:rows[0].id,title:rows[0].title}}:{kind:"unbound" as const}}

  async findProjectMembership(projectId: string, userId: string): Promise<ProjectMembership | null> {
    const rows = await this.queryRows<ProjectMembershipRow>(
      `select * from project_memberships where project_id = $1 and user_id = $2`,
      [projectId, userId]
    );
    return rows[0] ? mapProjectMembership(rows[0]) : null;
  }

  async listProjectMemberships(projectId: string): Promise<ProjectMembershipView[]> {
    const rows = await this.queryRows<ProjectMembershipRow>(
      `select pm.*, u.email, p.display_name from project_memberships pm join users u on u.id = pm.user_id left join user_profile_preferences p on p.user_id = u.id where pm.project_id = $1 order by pm.created_at, pm.user_id`,
      [projectId]
    );
    return rows.map(mapProjectMembershipView);
  }

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
  async patchProjectResourcePolicy(projectId: string, input: UpdateProjectResourcePolicyInput, updatedAt: string, expectedUpdatedAt?: string): Promise<ProjectResourcePolicy | null> {
    const endpointWindows=input.endpointWindows;
    const scalarInput={...input};delete scalarInput.endpointWindows;
    const policyColumns = {
      activeTasksLimit: "active_tasks_limit",
      providerRequestsLimit: "provider_requests_limit",
      providerTokensLimit: "provider_tokens_limit",
      providerCostLimit: "provider_cost_limit",
      projectFileBytesLimit: "project_file_bytes_limit"
    } as const;
    return transaction(this.pool,async client=>{const keys=Object.keys(scalarInput) as Array<keyof typeof policyColumns>;const updates=keys.map((key,index)=>`${policyColumns[key]}=$${index+2}`);const values=keys.map(key=>scalarInput[key]);const updatedAtIndex=values.length+2;const expectedClause=expectedUpdatedAt===undefined?"":` and updated_at=$${updatedAtIndex+1}`;const params=[projectId,...values,updatedAt,...(expectedUpdatedAt===undefined?[]:[expectedUpdatedAt])];const row=(await client.query<ProjectPolicyRow>(`update project_resource_policies set ${updates.length?`${updates.join(", ")},`:""}updated_at=$${updatedAtIndex} where project_id=$1${expectedClause} returning *`,params)).rows[0];if(!row)return null;if(input.activeTasksLimit!==undefined&&input.activeTasksLimit!==null)await client.query("update projects set task_concurrency_limit=$2,updated_at=$3 where id=$1",[projectId,input.activeTasksLimit,updatedAt]);if(endpointWindows){await client.query("delete from project_endpoint_policy_windows where project_id=$1",[projectId]);for(const window of endpointWindows)await client.query("insert into project_endpoint_policy_windows(project_id,endpoint_id,metric,limit_value,window_seconds) values($1,$2,$3,$4,$5)",[projectId,window.endpointId,window.metric,window.limit,window.windowSeconds])}const result=mapPolicy(row);result.endpointWindows=endpointWindows??(await client.query<{endpoint_id:string;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;limit_value:number;window_seconds:number}>("select endpoint_id,metric,limit_value,window_seconds from project_endpoint_policy_windows where project_id=$1 order by endpoint_id,metric",[projectId])).rows.map(item=>({endpointId:item.endpoint_id,metric:item.metric,limit:Number(item.limit_value),windowSeconds:Number(item.window_seconds)}));return result})
  }
  async findProjectResourceUsage(projectId: string): Promise<ProjectResourceUsage | null> {
    const rows = await this.queryRows<ProjectUsageRow>("select * from project_resource_usage where project_id = $1", [projectId]); return rows[0] ? mapUsage(rows[0]) : null;
  }
  async upsertProjectResourceUsage(usage: ProjectResourceUsage): Promise<ProjectResourceUsage> {
    const rows = await this.queryRows<ProjectUsageRow>(`insert into project_resource_usage (project_id,active_tasks,provider_requests,provider_tokens,provider_cost,project_file_bytes,updated_at) values ($1,$2,$3,$4,$5,$6,$7) on conflict (project_id) do update set active_tasks=excluded.active_tasks,provider_requests=excluded.provider_requests,provider_tokens=excluded.provider_tokens,provider_cost=excluded.provider_cost,project_file_bytes=excluded.project_file_bytes,updated_at=excluded.updated_at returning *`, usageValues(usage)); return mapUsage(rows[0]!);
  }
  async setProjectFileBytes(projectId: string, bytes: number, updatedAt: string): Promise<ProjectResourceUsage | null> {
    const rows = await this.queryRows<ProjectUsageRow>("update project_resource_usage set project_file_bytes=$2,updated_at=$3 where project_id=$1 returning *", [projectId, bytes, updatedAt]);
    return rows[0] ? mapUsage(rows[0]) : null;
  }
  async adjustProjectResourceUsage(input: ProjectResourceUsageAdjustment): Promise<ProjectResourceUsage | null> {
    const delta = input.delta;
    const limitedDelta = input.limit ? usageDelta(input.limit, delta) : 0;
    const condition = input.limit && limitedDelta > 0
      ? `and (p.${usageLimitColumn(input.limit)} is null or u.${usageColumn(input.limit)} + $${usageDeltaPlaceholder(input.limit)} <= p.${usageLimitColumn(input.limit)})`
      : "";
    const rows = await this.queryRows<ProjectUsageRow>(
      `update project_resource_usage u
       set active_tasks = greatest(0, u.active_tasks + $2),
           provider_requests = u.provider_requests + $3,
           provider_tokens = u.provider_tokens + $4,
           provider_cost = u.provider_cost + $5,
           project_file_bytes = greatest(0, u.project_file_bytes + $6),
           updated_at = $7
       from project_resource_policies p
       where u.project_id = $1 and p.project_id = u.project_id ${condition}
       returning u.*`,
      [input.projectId, delta.activeTasks, delta.providerRequests, delta.providerTokens, delta.providerCost, delta.projectFileBytes, input.updatedAt]
    );
    return rows[0] ? mapUsage(rows[0]) : null;
  }
  async reserveProjectProviderSettlement(input: ReserveProjectProviderSettlementInput): Promise<ProjectProviderSettlement | null> {
    return transaction(this.pool, async (client) => {
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
        const rows = await client.query<ProjectProviderSettlementRow>(`select u.*, (p.provider_tokens_limit is not null and u.provider_tokens > p.provider_tokens_limit) as provider_tokens_exceeded, (p.provider_cost_limit is not null and u.provider_cost > p.provider_cost_limit) as provider_cost_exceeded from project_resource_usage u join project_resource_policies p on p.project_id=u.project_id where u.project_id=$1`, [settlement.project_id]);
        const row = rows.rows[0];
        return row ? { usage: mapUsage(row), endpointId: settlement.endpoint_id, exceededLimits: [...(row.provider_tokens_exceeded ? ["provider_tokens_limit" as const] : []), ...(row.provider_cost_exceeded ? ["provider_cost_limit" as const] : [])] } : null;
      }
      if (!usage || (settlement.status !== "dispatched" && settlement.status !== "delivered" && settlement.status !== "unknown")) return null;
      const rows = await client.query<ProjectProviderSettlementRow>(`update project_resource_usage u set provider_tokens=greatest(0,u.provider_tokens+$2-$4),provider_cost=greatest(0,u.provider_cost+$3-$5),updated_at=$6 from project_resource_policies p where u.project_id=$1 and p.project_id=u.project_id returning u.*, (p.provider_tokens_limit is not null and u.provider_tokens > p.provider_tokens_limit) as provider_tokens_exceeded, (p.provider_cost_limit is not null and u.provider_cost > p.provider_cost_limit) as provider_cost_exceeded`, [settlement.project_id,usage.tokens ?? 0,usage.cost ?? 0,Number(settlement.reserved_tokens),Number(settlement.reserved_cost),updatedAt]);
      if (!rows.rows[0]) return null;
      await client.query(`update project_provider_settlements set status='settled',settled_at=$2,provider_tokens=$3,provider_cost=$4,updated_at=$2 where id=$1`, [id,updatedAt,usage?.tokens ?? null,usage?.cost ?? null]);
      const row=rows.rows[0]; return { usage: mapUsage(row), endpointId: settlement.endpoint_id, exceededLimits: [...(row.provider_tokens_exceeded ? ["provider_tokens_limit" as const] : []), ...(row.provider_cost_exceeded ? ["provider_cost_limit" as const] : [])] };
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
  async measureProjectProviderWindow(input:{projectId:string;endpointId:string;actorId:string|null;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;since:string}):Promise<{current:number;oldestReservedAt:string|null}>{const rows=await this.queryRows<{value:string;oldest_reserved_at:unknown}>(`select coalesce(sum(case when $4='providerRequests' then 1 when $4='providerTokens' then case when status='settled' then coalesce(provider_tokens,0) else reserved_tokens end else case when status='settled' then coalesce(provider_cost,0) else reserved_cost end end),0)::text as value,min(reserved_at) as oldest_reserved_at from project_provider_settlements where project_id=$1 and endpoint_id=$2 and actor_id is not distinct from $3 and status<>'failed' and reserved_at >= $5`,[input.projectId,input.endpointId,input.actorId,input.metric,input.since]);return{current:Number(rows[0]?.value??0),oldestReservedAt:rows[0]?.oldest_reserved_at?toIso(rows[0].oldest_reserved_at):null};}
  async measureProjectAlertRule(input:{projectId:string;alertType:ProjectAlert["type"];metric:import("../../contracts/src/api.js").AlertRuleMetric;windowSeconds:number|null;endpointId:string|null;now:string}):Promise<number>{
    if(input.metric==="active_tasks"||input.metric==="project_file_bytes"){const column=input.metric==="active_tasks"?"active_tasks":"project_file_bytes";const rows=await this.queryRows<{value:string}>(`select coalesce(${column},0)::text as value from project_resource_usage where project_id=$1`,[input.projectId]);return Number(rows[0]?.value??0)}
    const cutoff=input.windowSeconds===null?null:new Date(Date.parse(input.now)-input.windowSeconds*1000).toISOString();
    if(input.metric!=="failure_count"){const expression=input.metric==="provider_requests"?"count(*)":input.metric==="provider_tokens"?"coalesce(sum(provider_tokens),0)":"coalesce(sum(provider_cost),0)";const values:unknown[]=[input.projectId];let where="project_id=$1 and status='settled'";if(cutoff){values.push(cutoff);where+=` and settled_at >= $${values.length}`}if(input.endpointId){values.push(input.endpointId);where+=` and endpoint_id=$${values.length}`}const rows=await this.queryRows<{value:string}>(`select (${expression})::text as value from project_provider_settlements where ${where}`,values);return Number(rows[0]?.value??0)}
    const values:unknown[]=[input.projectId];const clauses=["project_id=$1"];if(cutoff){values.push(cutoff);clauses.push(`created_at >= $${values.length}`)}if(input.endpointId){values.push(input.endpointId);clauses.push(`detail->>'endpointId'=$${values.length}`)}const failure=input.alertType==="task_failure"?"action='task.failed' and status='accepted'":input.alertType==="provider_failure"?"action='provider.request' and status='rejected' and resource_kind='provider' and (detail->>'errorCategory') is not null":input.alertType==="endpoint_failure"?"resource_kind='endpoint' and status='rejected' and (detail->>'healthStatus')='unavailable'":input.alertType==="sandbox_failure"?"action='sandbox.failed' and status='accepted'":"false";const rows=await this.queryRows<{value:string}>(`select count(*)::text as value from project_audit_events where ${clauses.join(" and ")} and ${failure}`,values);return Number(rows[0]?.value??0)
  }
  private async transitionProviderSettlement(id: string, from: string, to: string, updatedAt: string, timestamp: string): Promise<ProjectProviderSettlement | null> { const rows=await this.queryRows<ProviderSettlementRow>(`update project_provider_settlements set status=$3, ${timestamp}=$2, updated_at=$2 where id=$1 and status=$4 returning *`,[id,updatedAt,to,from]); return rows[0] ? mapProviderSettlement(rows[0]) : null; }
  async upsertActiveProjectAlert(alert: ProjectAlert): Promise<ProjectAlert> {
    const rows = await this.queryRows<ProjectAlertRow>(`insert into project_alerts (id,project_id,type,status,delivery_status,rule_id,metric,metric_value,threshold,endpoint_id,acknowledged_at,acknowledged_by,silenced_until,created_at,updated_at,resolved_at,dismissed_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) on conflict (project_id,type,(coalesce(rule_id,'')),(coalesce(endpoint_id,''))) where status='active' do update set metric_value=excluded.metric_value,threshold=excluded.threshold,updated_at=excluded.updated_at returning *`, [alert.id,alert.projectId,alert.type,alert.status,alert.deliveryStatus,alert.ruleId??null,alert.metric??null,alert.metricValue??null,alert.threshold??null,alert.endpointId??null,alert.acknowledgedAt??null,alert.acknowledgedBy??null,alert.silencedUntil??null,alert.createdAt,alert.updatedAt,alert.resolvedAt,alert.dismissedAt]); return mapAlert(rows[0]!);
  }
  async listActiveProjectAlerts(projectId: string): Promise<ProjectAlert[]> { const rows = await this.queryRows<ProjectAlertRow>("select * from project_alerts where project_id=$1 and status='active' order by created_at,id", [projectId]); return rows.map(mapAlert); }
  async listProjectAlerts(projectId: string): Promise<ProjectAlert[]> { const rows = await this.queryRows<ProjectAlertRow>("select * from project_alerts where project_id=$1 order by created_at desc,id desc", [projectId]); return rows.map(mapAlert); }
  async queryProjectAlerts(projectId:string,query:import("../../contracts/src/api.js").ProjectAlertQuery){const limit=Math.min(100,Math.max(1,query.limit??20));const values:unknown[]=[projectId];const where=["project_id=$1"];if(query.status){values.push(query.status);where.push(`status=$${values.length}`)}if(query.cursor){const split=query.cursor.lastIndexOf("|");if(split<1)throw new Error("Invalid alert cursor");values.push(query.cursor.slice(0,split),query.cursor.slice(split+1));where.push(`(created_at,id)<($${values.length-1},$${values.length})`)}values.push(limit+1);const rows=await this.queryRows<ProjectAlertRow>(`select * from project_alerts where ${where.join(" and ")} order by created_at desc,id desc limit $${values.length}`,values);const page=rows.slice(0,limit);return{items:page.map(mapAlert),nextCursor:rows.length>limit&&page.length?`${toIso(page.at(-1)!.created_at)}|${page.at(-1)!.id}`:null}}
  async findProjectAlert(projectId:string,id:string):Promise<ProjectAlert|null>{const rows=await this.queryRows<ProjectAlertRow>("select * from project_alerts where project_id=$1 and id=$2",[projectId,id]);return rows[0]?mapAlert(rows[0]):null}
  async transitionProjectAlert(projectId: string, id: string, status: "resolved" | "dismissed", updatedAt: string): Promise<ProjectAlert | null> { const column = status === "resolved" ? "resolved_at" : "dismissed_at"; const rows = await this.queryRows<ProjectAlertRow>(`update project_alerts set status=$3, ${column}=$4, updated_at=$4 where project_id=$1 and id=$2 and status='active' returning *`, [projectId, id, status, updatedAt]); return rows[0] ? mapAlert(rows[0]) : null; }
  async updateProjectAlertState(projectId:string,id:string,input:{acknowledgedAt?:string;acknowledgedBy?:string;silencedUntil?:string|null},updatedAt:string){const rows=await this.queryRows<ProjectAlertRow>(`update project_alerts set acknowledged_at=coalesce($3,acknowledged_at),acknowledged_by=coalesce($4,acknowledged_by),silenced_until=case when $5::boolean then $6::timestamptz else silenced_until end,updated_at=$7 where project_id=$1 and id=$2 and status='active' returning *`,[projectId,id,input.acknowledgedAt??null,input.acknowledgedBy??null,Object.hasOwn(input,'silencedUntil'),input.silencedUntil??null,updatedAt]);return rows[0]?mapAlert(rows[0]):null}
  async updateProjectAlertDeliveryStatus(projectId: string, id: string, status: ProjectAlert["deliveryStatus"], updatedAt: string): Promise<ProjectAlert | null> { const rows = await this.queryRows<ProjectAlertRow>("update project_alerts set delivery_status=$3, updated_at=$4 where project_id=$1 and id=$2 returning *", [projectId, id, status, updatedAt]); return rows[0] ? mapAlert(rows[0]) : null; }
  async appendProjectAuditEvent(event: ProjectAuditEvent): Promise<void> { await this.pool.query("insert into project_audit_events (id,project_id,actor_id,subject_user_id,action,status,resource_kind,resource_id,detail,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (id) do nothing", [event.id,event.projectId,event.actorId,event.subjectUserId??null,event.action,event.status,event.resourceKind,event.resourceId,sanitizeProjectAuditDetail(event.detail),event.createdAt]); }
  async listProjectAuditEvents(projectId:string){const rows=await this.queryRows<ProjectAuditRow>('select * from project_audit_events where project_id=$1 order by created_at,id',[projectId]);return rows.map(mapAudit)}
  async queryProjectAuditEvents(projectId:string,query:import("../../contracts/src/api.js").ProjectAuditQuery){const limit=Math.min(100,Math.max(1,query.limit??20));const values:unknown[]=[projectId];const where=["project_id=$1"];const add=(sql:string,value:unknown)=>{values.push(value);where.push(sql.replace('?',`$${values.length}`))};if(Object.hasOwn(query,'actorId'))query.actorId===null?where.push('actor_id is null'):add('actor_id=?',query.actorId);if(Object.hasOwn(query,'subjectUserId'))query.subjectUserId===null?where.push('subject_user_id is null'):add('subject_user_id=?',query.subjectUserId);if(query.action)add('action=?',query.action);if(query.status)add('status=?',query.status);if(query.resourceKind)add('resource_kind=?',query.resourceKind);if(query.resourceId)add('resource_id=?',query.resourceId);if(query.from)add('created_at>=?',query.from);if(query.to)add('created_at<=?',query.to);if(query.cursor){const split=query.cursor.lastIndexOf('|');if(split<1)throw new Error('Invalid audit cursor');values.push(query.cursor.slice(0,split),query.cursor.slice(split+1));where.push(`(created_at,id)<($${values.length-1},$${values.length})`)}values.push(limit+1);const rows=await this.queryRows<ProjectAuditRow>(`select * from project_audit_events where ${where.join(' and ')} order by created_at desc,id desc limit $${values.length}`,values);const page=rows.slice(0,limit);return{items:page.map(mapAudit),nextCursor:rows.length>limit&&page.length?`${toIso(page.at(-1)!.created_at)}|${page.at(-1)!.id}`:null}}
  async confirmSandboxRunStarted(input:ConfirmSandboxRunStartedInput):Promise<ConfirmSandboxRunStartedResult>{return transaction(this.pool,async(client)=>{
    const locked=await client.query<{document:unknown}>("select document from postgres_json_docs where collection='sandbox_run_state' and id=$1 for update",[input.runId]);
    const current=locked.rows[0]?.document?sandboxRunFromDocument(asRecord(locked.rows[0].document)):null;if(!current)return{kind:"conflict" as const};
    if(current.startedAt){await insertAuditEventWithClient(client,{...input.auditEvent,createdAt:current.startedAt});return{kind:"already_started" as const,run:current};}
    if(current.fencingToken!==input.expectedFencingToken||current.phase!=="starting"||current.cleanupStatus!=="active")return{kind:"conflict" as const};
    const run={...current,startedAt:input.startedAt,fencingToken:current.fencingToken+1,updatedAt:input.startedAt};
    await client.query("update postgres_json_docs set document=$2::jsonb,updated_at=now() where collection='sandbox_run_state' and id=$1",[input.runId,JSON.stringify(prepareSandboxRunDocument(run))]);
    await insertAuditEventWithClient(client,input.auditEvent);return{kind:"started" as const,run};
  })}
  async activateTaskSandboxRun(input:ActivateTaskSandboxRunInput):Promise<ActivateTaskSandboxRunResult>{return transaction(this.pool,async(client)=>{
    const lockedRun=await client.query<{document:unknown}>("select document from postgres_json_docs where collection='sandbox_run_state' and id=$1 for update",[input.runId]);
    const run=lockedRun.rows[0]?.document?sandboxRunFromDocument(asRecord(lockedRun.rows[0].document)):null;
    const lockedTask=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.taskId]);
    const task=lockedTask.rows[0];
    if(!run||!task||!taskRunRowIdentityMatches(task,run,input))return{kind:"conflict" as const};
    if(run.phase==="running"&&run.cleanupStatus==="active"&&task.execution_mode==="live"&&task.deleted_at===null&&task.archived_at===null&&task.active_reservation&&(task.status==="running"||task.status==="queued")){
      return{kind:"already_running" as const,task:mapTask(task),run};
    }
    if(run.phase!=="starting"||run.cleanupStatus!=="active"||!run.startedAt||run.fencingToken!==input.expectedFencingToken||task.execution_mode!=="live"||task.deleted_at!==null||task.archived_at!==null||task.status!=="starting"||!task.active_reservation){
      return{kind:"conflict" as const};
    }
    const activatedRun={...run,phase:"running" as const,fencingToken:run.fencingToken+1,updatedAt:input.activatedAt};
    const updatedTask=await client.query<AgentTaskRow>("update agent_tasks set status='running',updated_at=$3 where id=$1 and run_id=$2 and status='starting' and active_reservation=true returning *",[input.taskId,input.runId,input.activatedAt]);
    if(!updatedTask.rows[0])throw new Error("Task sandbox activation lost its task lock");
    const updatedRun=await client.query<{document:unknown}>("update postgres_json_docs set document=$3::jsonb,updated_at=now() where collection='sandbox_run_state' and id=$1 and (document->>'fencingToken')::bigint=$2 returning document",[input.runId,input.expectedFencingToken,JSON.stringify(prepareSandboxRunDocument(activatedRun))]);
    if(!updatedRun.rows[0]?.document)throw new Error("Task sandbox activation lost its run lock");
    return{kind:"activated" as const,task:mapTask(updatedTask.rows[0]),run:sandboxRunFromDocument(asRecord(updatedRun.rows[0].document))};
  })}
  async completeSandboxRunRelease(input:CompleteSandboxRunReleaseInput):Promise<CompleteSandboxRunReleaseResult>{return transaction(this.pool,async(client)=>{
    const locked=await client.query<{document:unknown}>("select document from postgres_json_docs where collection='sandbox_run_state' and id=$1 for update",[input.runId]);
    const current=locked.rows[0]?.document?sandboxRunFromDocument(asRecord(locked.rows[0].document)):null;if(!current||!sameRunIdentity(current,input.run))return"conflict" as const;
    const existing=await client.query<SandboxUsageSettlementRow>("select * from sandbox_usage_settlements where run_id=$1",[input.runId]);
    if(isConfirmedCleanedRun(current)){if(!existing.rows[0]||!sameSettlement(mapSandboxUsageSettlement(existing.rows[0]),input.settlement))return"conflict" as const;await insertAuditEventWithClient(client,input.auditEvent);return"already_applied" as const;}
    if(current.fencingToken!==input.expectedFencingToken||input.run.fencingToken!==current.fencingToken+1||!isConfirmedCleanedRun(input.run)||!settlementMatchesRun(input.settlement,current,input.run))return"conflict" as const;
    const lockedTask=await client.query<SandboxReleaseTaskRow>("select task.*,project.workspace_id as project_workspace_id,project.owner_user_id as project_owner_user_id from agent_tasks task join projects project on project.id=task.project_id where task.id=$1 for update of task",[current.taskId]);const task=lockedTask.rows[0];
    if(!taskMatchesActiveSandboxRunRow(task,current))return"conflict" as const;
    await client.query("insert into sandbox_usage_settlements (run_id,workspace_id,project_id,task_id,file_library_id,started_by_user_id,started_at,released_at,duration_seconds,cpu_request_millis,memory_request_bytes,cpu_limit_millis,memory_limit_bytes,release_reason) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",[input.settlement.runId,input.settlement.workspaceId,input.settlement.projectId,input.settlement.taskId,input.settlement.fileLibraryId,input.settlement.startedByUserId,input.settlement.startedAt,input.settlement.releasedAt,input.settlement.durationSeconds,input.settlement.resources.cpuRequestMillis,input.settlement.resources.memoryRequestBytes,input.settlement.resources.cpuLimitMillis,input.settlement.resources.memoryLimitBytes,input.settlement.releaseReason]);
    await client.query("update postgres_json_docs set document=$2::jsonb,updated_at=now() where collection='sandbox_run_state' and id=$1",[input.runId,JSON.stringify(prepareSandboxRunDocument(input.run))]);
    await releaseSandboxReservationWithClient(client,task,input.run);await insertAuditEventWithClient(client,input.auditEvent);return"applied" as const;
  })}
  async listSandboxUsageSettlements(projectId:string,startedByUserId:string):Promise<SandboxUsageSettlement[]>{const rows=await this.queryRows<SandboxUsageSettlementRow>("select * from sandbox_usage_settlements where project_id=$1 and started_by_user_id=$2 order by released_at desc,run_id desc",[projectId,startedByUserId]);return rows.map(mapSandboxUsageSettlement)}

  async createProjectCredential(value: StoredProjectCredential): Promise<ProjectCredential> {
    const rows = await this.queryRows<ProjectCredentialRow>(
      `insert into project_credentials (id,project_id,name,type,base_url,key_id,nonce,ciphertext,auth_tag,fingerprint,version,created_at,last_rotated_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [value.id,value.projectId,value.name,value.type,value.baseUrl,value.keyId,value.nonce,value.ciphertext,value.authTag,value.fingerprint,value.version,value.createdAt,value.lastRotatedAt,value.updatedAt]
    );
    return mapCredential(rows[0]!);
  }
  async findProjectCredential(id: string): Promise<StoredProjectCredential | null> { const rows=await this.queryRows<ProjectCredentialRow>("select * from project_credentials where id=$1",[id]); return rows[0] ? mapStoredCredential(rows[0]) : null; }
  async listProjectCredentials(projectId: string): Promise<ProjectCredential[]> { const rows=await this.queryRows<ProjectCredentialRow>("select * from project_credentials where project_id=$1 order by created_at,id",[projectId]); return rows.map(mapCredential); }
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
  async listLegacyEndpointCredentialAliases(): Promise<Array<{ endpointId: string; projectId: string; baseUrl: string; secretRef: string }>> { const rows=await this.queryRows<{id:string;project_id:string;base_url:string;api_key_secret_ref:string}>("select id,project_id,base_url,api_key_secret_ref from model_endpoints where credential_id is null and api_key_secret_ref is not null"); return rows.map((row)=>({endpointId:row.id,projectId:row.project_id,baseUrl:row.base_url,secretRef:row.api_key_secret_ref})); }
  async bindEndpointCredential(endpointId:string, credentialId:string): Promise<boolean> { const result=await this.pool.query("update model_endpoints e set credential_id=$2, api_key_secret_ref=null from project_credentials c where e.id=$1 and e.credential_id is null and c.id=$2 and c.project_id=e.project_id",[endpointId,credentialId]); return result.rowCount===1; }

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
        "select 1 from agent_tasks where endpoint_id = $1 and deleted_at is null limit 1",
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

  async listEndpointsForProject(projectId: string): Promise<ModelEndpoint[]> {
    const rows = await this.queryRows<ModelEndpointRow>(
      `select * from model_endpoints where project_id = $1 order by created_at, id`,
      [projectId]
    );
    return rows.map(mapEndpoint);
  }

  async findEndpoint(id: string): Promise<ModelEndpoint | null> {
    const rows = await this.queryRows<ModelEndpointRow>("select * from model_endpoints where id = $1", [id]);
    return rows[0] ? mapEndpoint(rows[0]) : null;
  }

  async createTaskAtomically(input: AtomicTaskCreateInput) {
    try{return await transaction(this.pool, async (client) => {
      if(input.newFileLibrary){const library=input.newFileLibrary;await client.query("insert into file_libraries(id,workspace_id,project_id,name,root_sub_path,created_by_user_id,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8)",[library.id,library.workspaceId,library.projectId,library.name,library.rootSubPath,library.createdByUserId,library.createdAt,library.updatedAt]);}
      const library=await client.query("select id from file_libraries where id=$1 and workspace_id=$2 and project_id=$3 for update",[input.task.fileLibraryId,input.task.workspaceId,input.task.projectId]);
      if(!library.rows[0])return{kind:"library_not_found" as const};
      const bound=await client.query("select id from agent_tasks where file_library_id=$1 and deleted_at is null",[input.task.fileLibraryId]);
      if(bound.rows[0])return{kind:"already_bound" as const};
      if (input.reserveActive && !await reserveActiveTaskWithClient(client, input.task.projectId, input.task.updatedAt)) {
        if(input.newFileLibrary)await client.query("delete from file_libraries where id=$1",[input.newFileLibrary.id]);
        return{kind:"capacity_rejected" as const};
      }
      const row = await insertTaskWithClient(client, input.task, input.reserveActive);
      if (input.runtimeState) await putJsonDocumentWithClient(client, "sandbox_runtime_state", input.task.id, input.runtimeState);
      if (input.sandboxRun) await putJsonDocumentWithClient(client, "sandbox_run_state", input.sandboxRun.runId, prepareSandboxRunDocument(input.sandboxRun));
      if(input.initialMessage)await insertPersistedTaskMessageWithClient(client, input.initialMessage);
      return{kind:"created" as const,task:mapTask(row)};
    });}catch(error){
      if(isConstraintError(error,"file_libraries_project_name_unique")||isConstraintError(error,"file_libraries_pkey")||isConstraintError(error,"file_libraries_project_id_root_sub_path_key"))return{kind:"library_name_conflict" as const};
      if(isConstraintError(error,"agent_tasks_file_library_active_unique"))return{kind:"already_bound" as const};
      if(isForeignKeyConstraintError(error,"agent_tasks_file_library_scope_fkey"))return{kind:"library_not_found" as const};
      throw error;
    }
  }

  async restartTaskSandboxAtomically(input:AtomicTaskSandboxRestartInput):Promise<AtomicTaskSandboxRestartResult>{return transaction(this.pool,async(client)=>{
    const locked=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[input.task.id]);
    const row=locked.rows[0];
    if(!row||row.deleted_at||row.archived_at||row.execution_mode!=="live")return{kind:"conflict" as const};
    if(row.run_id!==input.expectedReleasedRunId){
      const document=await client.query<{document:unknown}>("select document from postgres_json_docs where collection='sandbox_run_state' and id=$1",[row.run_id]);
      const active=document.rows[0]?.document?sandboxRunFromDocument(asRecord(document.rows[0].document)):null;
      return row.active_reservation&&active?.taskId===row.id&&active.cleanupStatus==="active"&&["queued","starting","running"].includes(active.phase)
        ?{kind:"existing_active" as const,task:mapTask(row)}:{kind:"conflict" as const};
    }
    if(row.active_reservation)return{kind:"conflict" as const};
    const previous=await client.query<{document:unknown}>("select document from postgres_json_docs where collection='sandbox_run_state' and id=$1 for update",[input.expectedReleasedRunId]);
    const released=previous.rows[0]?.document?sandboxRunFromDocument(asRecord(previous.rows[0].document)):null;
    if(!released||released.taskId!==row.id||released.runId!==row.run_id||released.cleanupStatus!=="cleaned")return{kind:"conflict" as const};
    if(!sandboxRestartRowIdentityMatches(row,input))return{kind:"conflict" as const};
    if(!await reserveActiveTaskWithClient(client,row.project_id,input.interruptedAt))return{kind:"capacity_rejected" as const};
    const task=input.task;
    const updated=await client.query<AgentTaskRow>(`update agent_tasks set run_id=$2,status='starting',active_reservation=true,sandbox=$3::jsonb,start_delivery_key=null,start_request_hash=null,start_claim_token=null,start_receipt=null,start_timeline_cursor=null,start_intent_status=null,start_claimed_at=null,start_lease_expires_at=null,start_attempt_count=0,start_next_retry_at=null,start_safe_error=null,finalization_intent_status=null,finalization_intent_at=null,updated_at=$4 where id=$1 and run_id=$5 and active_reservation=false returning *`,[task.id,task.runId,JSON.stringify(task.sandbox),input.interruptedAt,input.expectedReleasedRunId]);
    if(!updated.rows[0])throw new Error("Task sandbox restart lost its task lock");
    await putJsonDocumentWithClient(client,"sandbox_runtime_state",task.id,input.runtimeState);
    await putJsonDocumentWithClient(client,"sandbox_run_state",input.sandboxRun.runId,prepareSandboxRunDocument(input.sandboxRun));
    await client.query(`update task_messages set delivery_status='failed',claim_token=null,claimed_at=null,lease_expires_at=null,next_retry_at=null,safe_error='Sandbox was released before this message was delivered',updated_at=$2 where task_id=$1 and deleted_at is null and coalesce(delivery_status,'pending') in ('pending','dispatching')`,[task.id,input.interruptedAt]);
    return{kind:"restarted" as const,task:mapTask(updated.rows[0])};
  })}

  async updateTask(task: PersistedAgentTask): Promise<PersistedAgentTask> {
    await this.pool.query(
      `update agent_tasks
       set workspace_id = $2,
           project_id = $3,
           endpoint_id = $4,
           title = $5,
           prompt = $6,
           file_library_id = $7,
           status = $8,
           run_id = $9,
           execution_mode = $10,
           active_reservation = $11,
           archived_at = $12,
           deleted_at = $13,
           terminal_reason = $14,
           terminalized_at = $15,
           sandbox = $16::jsonb,
           created_at = $17,
           updated_at = $18
       where id = $1`,
      [
        task.id,
        task.workspaceId,
        task.projectId,
        task.endpointId,
        task.title ?? task.prompt.replace(/[\r\n]+/g," ").slice(0,160),
        task.prompt,
        task.fileLibraryId,
        task.status,
        task.runId,
        task.executionMode,
        task.activeReservation ?? false,
        task.archivedAt ?? null,
        task.deletedAt ?? null,
        task.terminalReason ?? null,
        task.terminalizedAt ?? null,
        JSON.stringify(task.sandbox),
        task.createdAt,
        task.updatedAt
      ]
    );
    return structuredClone(task);
  }

  async updateTaskStatusIfStarting(taskId: string, status: AgentTask["status"], updatedAt: string): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>(
      `update agent_tasks
          set status = $2,
              updated_at = $3
        where id = $1
          and status = 'starting'
        returning *`,
      [taskId, status, updatedAt]
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async updateTaskStatusIfNonterminal(taskId: string, status: AgentTask["status"], updatedAt: string): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>(
      `update agent_tasks
          set status = $2,
              updated_at = $3
        where id = $1
          and status in ('queued', 'starting', 'running', 'stopping')
        returning *`,
      [taskId, status, updatedAt]
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }
  async requestTaskFinalization(taskId: string, status: Extract<AgentTask["status"], "completed" | "failed" | "expired" | "cleaned">, intendedAt: string): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>(`update agent_tasks set finalization_intent_status=coalesce(finalization_intent_status,$2),finalization_intent_at=coalesce(finalization_intent_at,$3),updated_at=$3 where id=$1 and status in ('queued','starting','running','stopping') returning *`, [taskId,status,intendedAt]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async finalizeTaskAndReleaseActiveReservation(taskId: string, status: AgentTask["status"], updatedAt: string): Promise<PersistedAgentTask | null> {
    return transaction(this.pool, async (client) => {
      const current = await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 and status in ('queued', 'starting', 'running', 'stopping') for update", [taskId]);
      if (!current.rows[0]) return null;
      const task = await client.query<AgentTaskRow>(
        `update agent_tasks set status = coalesce(finalization_intent_status, $2), active_reservation=false, finalization_intent_status=null, finalization_intent_at=null, updated_at = $3
         where id = $1 and status in ('queued', 'starting', 'running', 'stopping') returning *`,
        [taskId, status, updatedAt]
      );
      if (!task.rows[0]) return null;
      if (current.rows[0].active_reservation) await releaseActiveTaskWithClient(client,current.rows[0].project_id,updatedAt);
      return mapTask(task.rows[0]);
    });
  }
  async listTasksWithFinalizationIntent(limit: number): Promise<PersistedAgentTask[]> { const rows=await this.queryRows<AgentTaskRow>(`select * from agent_tasks where finalization_intent_status is not null and status in ('queued','starting','running','stopping') order by finalization_intent_at,id limit $1`,[limit]); return rows.map(mapTask); }

  async listActiveTasks(): Promise<PersistedAgentTask[]> {
    const rows = await this.queryRows<AgentTaskRow>(
      `select * from agent_tasks
       where deleted_at is null and active_reservation = true
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
      values.push(`%${query.search}%`);
      where.push(`(title ilike $${values.length} or prompt ilike $${values.length})`);
    }
    if (query.archived === "exclude") where.push("archived_at is null");
    if (query.archived === "only") where.push("archived_at is not null");
    const count = await this.queryRows<{ count: string }>(`select count(*)::text as count from agent_tasks where ${where.join(" and ")}`, values);
    const sortColumn = query.sort === "created_at" ? "created_at" : query.sort === "updated_at" ? "updated_at" : "title";
    const direction = query.direction === "asc" ? "asc" : "desc";
    values.push(query.limit, query.offset);
    const rows = await this.queryRows<AgentTaskRow>(`select * from agent_tasks where ${where.join(" and ")} order by ${sortColumn} ${direction}, id ${direction} limit $${values.length - 1} offset $${values.length}`, values);
    return { items: rows.map(mapTask), total: Number(count[0]?.count ?? 0) };
  }

  async findTask(id: string): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>("select * from agent_tasks where id = $1", [id]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async updateTaskTitle(taskId: string, title: string, updatedAt: string): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>("update agent_tasks set title=$2,updated_at=$3 where id=$1 and deleted_at is null returning *", [taskId, title, updatedAt]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async archiveTask(taskId: string, archivedAt: string): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>("update agent_tasks set archived_at=$2,updated_at=$2 where id=$1 and deleted_at is null returning *", [taskId, archivedAt]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async deleteTaskData(taskId: string, deletedAt: string): Promise<{ task: PersistedAgentTask; releasedArtifactBytes: number } | null> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update", [taskId]);
      const current = locked.rows[0];
      if (!current) return null;
      if(current.active_reservation)await releaseActiveTaskWithClient(client,current.project_id,deletedAt);
      const releasedArtifactBytes = 0;
      await client.query("delete from task_interaction_changes where task_id=$1", [taskId]);
      await client.query("delete from task_messages where task_id=$1", [taskId]);
      await client.query("delete from agent_task_artifacts where task_id=$1", [taskId]);
      await client.query("delete from postgres_json_docs where (collection='sandbox_runtime_state' and id=$1) or (collection='sandbox_run_state' and id=$2)", [taskId,current.run_id]);
      const updated = await client.query<AgentTaskRow>("update agent_tasks set file_library_id=null,active_reservation=false,deleted_at=coalesce(deleted_at,$2),updated_at=$2 where id=$1 returning *", [taskId,deletedAt]);
      return { task: mapTask(updated.rows[0]!), releasedArtifactBytes };
    });
  }

  async listTaskStartIntentsDue(now: string, limit: number): Promise<PersistedAgentTask[]> {
    const rows = await this.queryRows<AgentTaskRow>(`select * from agent_tasks where deleted_at is null and terminal_reason is null and ((start_intent_status='pending' and (start_next_retry_at is null or start_next_retry_at <= $1)) or (start_intent_status='dispatching' and start_lease_expires_at <= $1 and (start_next_retry_at is null or start_next_retry_at <= $1))) order by created_at,id limit $2`, [now, limit]);
    return rows.map(mapTask);
  }

  async claimTaskStart(input: TaskDeliveryClaimInput): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>(`update agent_tasks set start_intent_status='dispatching',start_claim_token=$2,start_claimed_at=$3,start_lease_expires_at=$4,start_attempt_count=start_attempt_count+1,start_safe_error=null,updated_at=$3 where id=$1 and start_intent_status='pending' and start_claim_token is null and (start_next_retry_at is null or start_next_retry_at <= $3) and terminal_reason is null returning *`, [input.id,input.claimToken,input.claimedAt,input.leaseExpiresAt]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async reclaimTaskStart(input: TaskDeliveryReclaimInput): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>(`update agent_tasks set start_claim_token=$3,start_claimed_at=$4,start_lease_expires_at=$5,start_attempt_count=start_attempt_count+1,start_safe_error=null,updated_at=$4 where id=$1 and start_intent_status='dispatching' and start_claim_token=$2 and start_lease_expires_at <= $4 and (start_next_retry_at is null or start_next_retry_at <= $4) and terminal_reason is null returning *`, [input.id,input.expectedClaimToken,input.claimToken,input.claimedAt,input.leaseExpiresAt]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async recordTaskStartReceipt(input: TaskStartReceiptInput): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>(`update agent_tasks set status=case when terminal_reason is null then 'running' else status end,start_intent_status='dispatched',start_receipt=$3::jsonb,start_timeline_cursor=$4,start_lease_expires_at=null,start_next_retry_at=null,start_safe_error=null,updated_at=$5 where id=$1 and start_intent_status='dispatching' and start_claim_token=$2 and start_delivery_key=$6 and start_request_hash=$7 and $8::boolean returning *`, [input.id,input.claimToken,JSON.stringify(input.receipt),input.timelineCursor,input.updatedAt,input.receipt.deliveryKey,input.receipt.requestHash,input.receipt.accepted]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async deferTaskStart(input: TaskDeliveryDeferInput): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>(`update agent_tasks set start_intent_status=case when $3 then 'pending' else 'dispatching' end,start_claim_token=case when $3 then null else start_claim_token end,start_claimed_at=case when $3 then null else start_claimed_at end,start_lease_expires_at=case when $3 then null else start_lease_expires_at end,start_safe_error=$4,start_next_retry_at=$5,updated_at=$6 where id=$1 and start_intent_status='dispatching' and start_claim_token=$2 returning *`, [input.id,input.claimToken,input.releaseClaim === true,input.safeError,input.nextRetryAt,input.updatedAt]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async failTaskStart(input: TaskDeliveryFailureInput): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>(`update agent_tasks set start_intent_status='failed',start_safe_error=$3,start_lease_expires_at=null,updated_at=$4 where id=$1 and start_intent_status='dispatching' and start_claim_token=$2 returning *`, [input.id,input.claimToken,input.safeError,input.updatedAt]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async beginTaskIdempotency(input: BeginTaskIdempotencyInput): Promise<TaskIdempotencyBeginResult> {
    return transaction(this.pool, async (client) => {
      await client.query(`insert into task_idempotency_records (actor_id,project_id,operation,idempotency_key,request_hash,resource_id,status,claim_token,lease_expires_at,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,'in_progress',$7,$8,$9,$9) on conflict do nothing`, [input.actorId,input.projectId,input.operation,input.key,input.requestHash,input.resourceId,input.claimToken,input.leaseExpiresAt,input.now]);
      const locked = await client.query<TaskIdempotencyRow>("select * from task_idempotency_records where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 for update", [input.actorId,input.projectId,input.operation,input.key]);
      const row = locked.rows[0]!;
      if (row.request_hash !== input.requestHash) return { kind: "hash_mismatch" };
      if (row.status === "completed") return { kind: "replay", resourceId: row.resource_id, responseStatus: row.response_status!, responseBody: structuredClone(row.response_body) };
      if (row.claim_token === input.claimToken) return { kind: "claimed", resourceId: row.resource_id, claimToken: row.claim_token };
      if (toIso(row.lease_expires_at) > input.now) return { kind: "in_progress", resourceId: row.resource_id };
      const reclaimed = await client.query<TaskIdempotencyRow>("update task_idempotency_records set claim_token=$5,lease_expires_at=$6,updated_at=$7 where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 returning *", [input.actorId,input.projectId,input.operation,input.key,input.claimToken,input.leaseExpiresAt,input.now]);
      return { kind: "claimed", resourceId: reclaimed.rows[0]!.resource_id, claimToken: input.claimToken };
    });
  }

  async completeTaskIdempotency(input: CompleteTaskIdempotencyInput): Promise<boolean> {
    const result = await this.pool.query(`update task_idempotency_records set status='completed',response_status=$7,response_body=$8::jsonb,updated_at=$9 where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 and request_hash=$5 and claim_token=$6 and status='in_progress'`, [input.actorId,input.projectId,input.operation,input.key,input.requestHash,input.claimToken,input.responseStatus,JSON.stringify(input.responseBody),input.updatedAt]);
    return result.rowCount === 1;
  }
  async requestTaskSandboxRelease(input:TaskSandboxReleaseMutationInput){return transaction(this.pool,async(client)=>{
    const idem=input.idempotency;
    const claim=await client.query("select 1 from task_idempotency_records where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 and request_hash=$5 and claim_token=$6 and status='in_progress' for update",[idem.actorId,idem.projectId,idem.operation,idem.key,idem.requestHash,idem.claimToken]);
    if(claim.rowCount!==1)return"conflict" as const;
    const locked=await client.query<{document:unknown}>("select document from postgres_json_docs where collection='sandbox_run_state' and id=$1 for update",[input.runId]);
    const current=locked.rows[0]?.document?sandboxRunFromDocument(asRecord(locked.rows[0].document)):null;
    if(!current||current.taskId!==input.taskId||current.runId!==input.runId)return"conflict" as const;
    const already=current.cleanupStatus==="cleanup_requested"||current.cleanupStatus==="deleting"||current.cleanupStatus==="cleaned"||current.phase==="cleaned";
    if(!already){
      if(current.fencingToken!==input.expectedFencingToken||input.run.runId!==input.runId||input.run.taskId!==input.taskId||input.run.cleanupStatus!=="cleanup_requested")return"conflict" as const;
      await client.query("update postgres_json_docs set document=$2::jsonb,updated_at=now() where collection='sandbox_run_state' and id=$1",[input.runId,JSON.stringify(prepareSandboxRunDocument(input.run))]);
    }
    await insertAuditEventWithClient(client,input.auditEvent);
    await client.query("update task_idempotency_records set status='completed',response_status=$7,response_body=$8::jsonb,updated_at=$9 where actor_id=$1 and project_id=$2 and operation=$3 and idempotency_key=$4 and request_hash=$5 and claim_token=$6 and status='in_progress'",[idem.actorId,idem.projectId,idem.operation,idem.key,idem.requestHash,idem.claimToken,idem.responseStatus,JSON.stringify(idem.responseBody),idem.updatedAt]);
    return already?"already_requested" as const:"applied" as const;
  })}
  async completeTaskIdempotencyForResource(resourceId:string,responseStatus:number,responseBody:unknown,updatedAt:string):Promise<number>{const result=await this.pool.query("update task_idempotency_records set status='completed',response_status=$2,response_body=$3::jsonb,updated_at=$4 where resource_id=$1 and status='in_progress'",[resourceId,responseStatus,JSON.stringify(responseBody),updatedAt]);return result.rowCount??0;}

  async persistTaskInteractionMutation(input: PersistTaskInteractionMutationInput): Promise<PersistTaskInteractionMutationResult> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update", [input.taskId]);
      const task = locked.rows[0];
      if (!task) throw new Error("Task not found");
      if (input.sourceSync && input.sourceSync.expectedSourceCursor !== undefined && input.sourceSync.expectedSourceCursor !== task.interaction_source_cursor) throw new Error("Task interaction source cursor conflict");
      for (const projection of input.artifactProjections ?? []) {
        if (projection.artifact.taskId !== input.taskId || projection.projectId !== task.project_id) throw new Error("Task interaction artifact mismatch");
        await persistTaskArtifactProjectionWithClient(client,projection);
      }
      const { inserted } = await persistTaskInteractionChangesWithClient(client,input.taskId,input.changes);
      if (input.lifecycle?.kind === "active") {
        const lifecycle = await client.query("update agent_tasks set status=$3,updated_at=$4 where id=$1 and status=$2", [input.taskId,input.lifecycle.expectedStatus,input.lifecycle.status,input.lifecycle.updatedAt]);
        if (lifecycle.rowCount !== 1) throw new Error("Task interaction lifecycle conflict");
      }
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
    for (const artifact of artifacts) {
      await this.pool.query(
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
  }

  async persistTaskArtifactProjection(input: PersistTaskArtifactProjectionInput): Promise<"created" | "existing"> {
    return transaction(this.pool, async (client) => {
      const task = await client.query<{ project_id: string }>("select project_id from agent_tasks where id=$1 for update", [input.artifact.taskId]);
      if (task.rows[0]?.project_id !== input.projectId) throw new Error("Task artifact project mismatch");
      return persistTaskArtifactProjectionWithClient(client,input);
    });
  }

  async listTaskArtifacts(taskId: string): Promise<PersistedTaskArtifact[]> {
    const rows = await this.queryRows<AgentTaskArtifactRow>(
      `select * from agent_task_artifacts where task_id = $1 order by created_at, id`,
      [taskId]
    );
    return rows.map(mapTaskArtifact);
  }

  async createTaskMessage(message: PersistedTaskMessage): Promise<PersistedTaskMessage> { return transaction(this.pool, async (client) => mapPersistedTaskMessage(await insertPersistedTaskMessageWithClient(client,message))); }
  async createPendingTaskMessage(message:PersistedTaskMessage,interactionChange?:TaskInteractionChangeInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const source=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[message.taskId]);if(!source.rows[0]||source.rows[0].deleted_at)return null;const created=mapPersistedTaskMessage(await insertPersistedTaskMessageWithClient(client,message));await persistTaskInteractionChangesWithClient(client,message.taskId,interactionChange?[interactionChange]:[]);return created;});}
  async listTaskMessages(taskId: string): Promise<PersistedTaskMessage[]> { const rows=await this.queryRows<TaskMessageRow>("select * from task_messages where task_id=$1 and deleted_at is null order by created_at,id",[taskId]); return rows.map(mapPersistedTaskMessage); }
  async findTaskMessage(id: string): Promise<PersistedTaskMessage | null> { const rows=await this.queryRows<TaskMessageRow>("select * from task_messages where id=$1",[id]);return rows[0]?mapPersistedTaskMessage(rows[0]):null; }
  async updatePendingTaskMessage(id:string,content:string,requestHash:string,updatedAt:string,interactionChange?:TaskInteractionChangeInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const located=await client.query<{task_id:string}>("select task_id from task_messages where id=$1",[id]);if(!located.rows[0])return null;await client.query("select id from agent_tasks where id=$1 for update",[located.rows[0].task_id]);const rows=await client.query<TaskMessageRow>("update task_messages set content=$2,request_hash=$3,updated_at=$4 where id=$1 and delivery_status='pending' and deleted_at is null returning *",[id,content,requestHash,updatedAt]);if(!rows.rows[0])return null;await persistTaskInteractionChangesWithClient(client,rows.rows[0].task_id,interactionChange?[interactionChange]:[]);return mapPersistedTaskMessage(rows.rows[0]);});}
  async deleteQueuedTaskMessage(id:string,deletedAt:string):Promise<PersistedTaskMessage|null>{const rows=await this.queryRows<TaskMessageRow>("update task_messages set deleted_at=$2,updated_at=$2 where id=$1 and delivery_status in ('pending','failed') and deleted_at is null returning *",[id,deletedAt]);return rows[0]?mapPersistedTaskMessage(rows[0]):null;}
  async listTaskMessagesDue(now:string,limit:number):Promise<PersistedTaskMessage[]>{const rows=await this.queryRows<TaskMessageRow>(`select * from task_messages where deleted_at is null and ((delivery_status='pending' and (next_retry_at is null or next_retry_at <= $1)) or (delivery_status='dispatching' and lease_expires_at <= $1 and (next_retry_at is null or next_retry_at <= $1))) order by created_at,id limit $2`,[now,limit]);return rows.map(mapPersistedTaskMessage);}
  async claimTaskMessage(input:TaskDeliveryClaimInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const located=await client.query<{task_id:string}>("select task_id from task_messages where id=$1",[input.id]);if(!located.rows[0])return null;const source=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[located.rows[0].task_id]);if(!source.rows[0]||source.rows[0].deleted_at)return null;const rows=await client.query<TaskMessageRow>(`update task_messages target set delivery_status='dispatching',claim_token=$2,claimed_at=$3,lease_expires_at=$4,attempt_count=target.attempt_count+1,safe_error=null,updated_at=$3 where target.id=$1 and target.delivery_status='pending' and target.claim_token is null and target.deleted_at is null and (target.next_retry_at is null or target.next_retry_at <= $3) and not exists (select 1 from task_messages older where older.task_id=target.task_id and older.deleted_at is null and older.delivery_status in ('pending','dispatching') and (older.created_at,older.id)<(target.created_at,target.id)) returning target.*`,[input.id,input.claimToken,input.claimedAt,input.leaseExpiresAt]);return rows.rows[0]?mapPersistedTaskMessage(rows.rows[0]):null;});}
  async reclaimTaskMessage(input:TaskDeliveryReclaimInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const located=await client.query<{task_id:string}>("select task_id from task_messages where id=$1",[input.id]);if(!located.rows[0])return null;const source=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[located.rows[0].task_id]);if(!source.rows[0]||source.rows[0].deleted_at)return null;const rows=await client.query<TaskMessageRow>(`update task_messages target set claim_token=$3,claimed_at=$4,lease_expires_at=$5,attempt_count=target.attempt_count+1,safe_error=null,updated_at=$4 where target.id=$1 and target.delivery_status='dispatching' and target.claim_token=$2 and target.lease_expires_at <= $4 and (target.next_retry_at is null or target.next_retry_at <= $4) and target.deleted_at is null and not exists (select 1 from task_messages older where older.task_id=target.task_id and older.deleted_at is null and older.delivery_status in ('pending','dispatching') and (older.created_at,older.id)<(target.created_at,target.id)) returning target.*`,[input.id,input.expectedClaimToken,input.claimToken,input.claimedAt,input.leaseExpiresAt]);return rows.rows[0]?mapPersistedTaskMessage(rows.rows[0]):null;});}
  async recordTaskMessageReceipt(input:TaskMessageReceiptInput):Promise<PersistedTaskMessage|null>{const rows=await this.queryRows<TaskMessageRow>(`update task_messages set receipt=$3::jsonb,timeline_cursor=$4,delivery_status='accepted',lease_expires_at=null,next_retry_at=null,safe_error=null,updated_at=$5 where id=$1 and delivery_status='dispatching' and claim_token=$2 and delivery_key=$6 and request_hash=$7 and $8::boolean and deleted_at is null returning *`,[input.id,input.claimToken,JSON.stringify(input.receipt),input.timelineCursor,input.updatedAt,input.receipt.deliveryKey,input.receipt.requestHash,input.receipt.accepted]);return rows[0]?mapPersistedTaskMessage(rows[0]):null;}
  async deferTaskMessage(input:TaskDeliveryDeferInput):Promise<PersistedTaskMessage|null>{const rows=await this.queryRows<TaskMessageRow>(`update task_messages set delivery_status=case when $3 then 'pending' else delivery_status end,claim_token=case when $3 then null else claim_token end,claimed_at=case when $3 then null else claimed_at end,lease_expires_at=case when $3 then null else lease_expires_at end,safe_error=$4,next_retry_at=$5,updated_at=$6 where id=$1 and delivery_status='dispatching' and claim_token=$2 and deleted_at is null returning *`,[input.id,input.claimToken,input.releaseClaim===true,input.safeError,input.nextRetryAt,input.updatedAt]);return rows[0]?mapPersistedTaskMessage(rows[0]):null;}
  async failTaskMessage(input:TaskDeliveryFailureInput):Promise<PersistedTaskMessage|null>{const rows=await this.queryRows<TaskMessageRow>(`update task_messages set delivery_status='failed',safe_error=$3,lease_expires_at=null,updated_at=$4 where id=$1 and delivery_status='dispatching' and claim_token=$2 and deleted_at is null returning *`,[input.id,input.claimToken,input.safeError,input.updatedAt]);return rows[0]?mapPersistedTaskMessage(rows[0]):null;}
  async findTaskSummary(taskId: string): Promise<StoredTaskSummary | null> { const rows=await this.queryRows<TaskSummaryRow>(`select t.id as task_id,count(a.id)::integer as artifact_count,t.updated_at from agent_tasks t left join agent_task_artifacts a on a.task_id=t.id where t.id=$1 group by t.id,t.updated_at`,[taskId]); return rows[0] ? mapTaskSummary(rows[0]) : null; }
  async listTaskSummariesForProject(projectId: string): Promise<StoredTaskSummary[]> { const rows=await this.queryRows<TaskSummaryRow>(`select t.id as task_id,count(a.id)::integer as artifact_count,t.updated_at from agent_tasks t left join agent_task_artifacts a on a.task_id=t.id where t.project_id=$1 and t.deleted_at is null group by t.id,t.updated_at order by t.updated_at desc,t.id desc`,[projectId]); return rows.map(mapTaskSummary); }


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

  async put(run: PersistedSandboxRunState): Promise<PersistedSandboxRunState> {
    const document = prepareSandboxRunDocument(run);
    return transaction(this.pool,async(client)=>{
      const previous=await client.query<{document:unknown}>("select document from postgres_json_docs where collection='sandbox_run_state' and id=$1 for update",[run.runId]);
      if(previous.rows[0]?.document){const current=sandboxRunFromDocument(asRecord(previous.rows[0].document));if(!sameRunIdentity(current,run))throw new Error("Sandbox run immutable attribution changed");if(!isConfirmedCleanedRun(current)&&isConfirmedCleanedRun(run))throw new Error("Sandbox cleaned transition requires atomic settlement");}
      await client.query(`insert into postgres_json_docs (collection, id, document, updated_at)
       values ('sandbox_run_state', $1, $2::jsonb, now())
       on conflict (collection, id)
       do update set document = excluded.document, updated_at = now()`,
      [run.runId, JSON.stringify(document)]);
      return sandboxRunFromDocument(document);
    });
  }

  async get(runId: string): Promise<PersistedSandboxRunState | null> {
    const result = await this.pool.query(
      `select document from postgres_json_docs where collection = 'sandbox_run_state' and id = $1`,
      [runId]
    );
    const document = result.rows[0]?.document as unknown;
    return document ? sandboxRunFromDocument(asRecord(document)) : null;
  }

  async list(): Promise<PersistedSandboxRunState[]> {
    const result = await this.pool.query(
      `select document from postgres_json_docs
       where collection = 'sandbox_run_state'
       order by id`
    );
    return result.rows.map((row: { document: unknown }) => sandboxRunFromDocument(asRecord(row.document)));
  }

  async listActive(): Promise<PersistedSandboxRunState[]> {
    const result = await this.pool.query(
      `select document from postgres_json_docs
       where collection = 'sandbox_run_state'
         and coalesce(document->>'cleanupStatus', '') <> 'cleaned'
         and coalesce(document->>'phase', '') <> 'cleaned'
       order by id`
    );
    return result.rows.map((row: { document: unknown }) => sandboxRunFromDocument(asRecord(row.document)));
  }

  async claimForCleanup(input: SandboxRunCleanupClaimInput): Promise<PersistedSandboxRunState | null> {
    const result = await this.pool.query(
      `update postgres_json_docs
       set document = document || jsonb_build_object(
         'cleanupStatus', 'deleting',
         'fencingToken', $2 + 1,
         'updatedAt', $3::text
       ), updated_at = now()
       where collection = 'sandbox_run_state'
         and id = $1
         and (document->>'fencingToken')::bigint = $2
         and coalesce(document->>'cleanupStatus', '') in ('cleanup_requested', 'deleting')
       returning document`,
      [input.runId, input.expectedFencingToken, input.claimedAt]
    );
    const document = result.rows[0]?.document as unknown;
    return document ? sandboxRunFromDocument(asRecord(document)) : null;
  }

  async updateWithFencing(
    runId: string,
    expectedFencingToken: number,
    run: PersistedSandboxRunState
  ): Promise<PersistedSandboxRunState | null> {
    if (run.runId !== runId) {
      throw new Error("Sandbox run fencing update runId mismatch");
    }
    const document = prepareSandboxRunDocument(run);
    return transaction(this.pool,async(client)=>{const locked=await client.query<{document:unknown}>("select document from postgres_json_docs where collection='sandbox_run_state' and id=$1 for update",[runId]);if(locked.rows[0]?.document){const current=sandboxRunFromDocument(asRecord(locked.rows[0].document));if(!sameRunIdentity(current,run))throw new Error("Sandbox run immutable attribution changed");if(!isConfirmedCleanedRun(current)&&isConfirmedCleanedRun(run))throw new Error("Sandbox cleaned transition requires atomic settlement");}const result = await client.query(
      `update postgres_json_docs
       set document = $3::jsonb, updated_at = now()
       where collection = 'sandbox_run_state'
         and id = $1
         and (document->>'fencingToken')::bigint = $2
       returning document`,
      [runId, expectedFencingToken, JSON.stringify(document)]
    );
    const saved = result.rows[0]?.document as unknown;
    if(!saved)return null;return sandboxRunFromDocument(asRecord(saved));});
  }
}

function isConfirmedCleanedRun(run:PersistedSandboxRunState):boolean{return run.cleanupStatus==="cleaned"||run.phase==="cleaned";}

async function releaseSandboxReservationWithClient(client:PoolClient,task:AgentTaskRow,run:PersistedSandboxRunState):Promise<void>{
  await releaseActiveTaskWithClient(client,task.project_id,run.updatedAt);const released=await client.query("update agent_tasks set active_reservation=false,updated_at=greatest(updated_at,$2::timestamptz) where id=$1 and active_reservation=true",[task.id,run.updatedAt]);if(released.rowCount!==1)throw new Error("Sandbox reservation changed during release");
}

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

async function reserveActiveTaskWithClient(client: PoolClient, projectId: string, updatedAt: string): Promise<boolean> {
  const reserved = await client.query(
    `update project_resource_usage u
     set active_tasks=u.active_tasks+1,updated_at=$2
     from project_resource_policies p join projects project on project.id=p.project_id
     where u.project_id=$1 and p.project_id=u.project_id and project.lifecycle_status='active'
       and (p.active_tasks_limit is null or u.active_tasks+1 <= p.active_tasks_limit)
     returning u.project_id`,
    [projectId,updatedAt]
  );
  return reserved.rowCount === 1;
}

function sandboxRestartRowIdentityMatches(current:AgentTaskRow,input:AtomicTaskSandboxRestartInput):boolean{
  const task=input.task,run=input.sandboxRun;
  return task.id===current.id&&task.workspaceId===current.workspace_id&&task.projectId===current.project_id&&task.endpointId===current.endpoint_id&&task.fileLibraryId===current.file_library_id&&task.executionMode==="live"&&task.runId!==input.expectedReleasedRunId&&run.runId===task.runId&&run.taskId===current.id&&run.workspaceId===current.workspace_id&&run.projectId===current.project_id&&run.fileLibraryId===current.file_library_id&&run.phase==="starting"&&run.cleanupStatus==="active";
}

async function releaseActiveTaskWithClient(client: PoolClient, projectId: string, updatedAt: string): Promise<void> {
  await client.query("update project_resource_usage set active_tasks=greatest(0,active_tasks-1),updated_at=$2 where project_id=$1",[projectId,updatedAt]);
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

async function insertTaskWithClient(client: PoolClient, task: PersistedAgentTask, activeReservation: boolean): Promise<AgentTaskRow> {
  const columns = [
    "id","workspace_id","project_id","endpoint_id","file_library_id","created_by_user_id","title","prompt","agent_context","status","run_id","execution_mode","active_reservation","archived_at","deleted_at","terminal_reason","terminalized_at",
    "start_delivery_key","start_request_hash","start_claim_token","start_receipt","start_timeline_cursor","start_intent_status","start_claimed_at","start_lease_expires_at","start_attempt_count","start_next_retry_at","start_safe_error",
    "interaction_source_cursor","interaction_history_status","interaction_last_synced_at",
    "artifact_projection_status","artifact_projection_error","artifact_projection_claim_token","artifact_projection_lease_expires_at","artifact_projection_attempt_count","artifact_projection_next_retry_at",
    "cleanup_status","cleanup_error","cleanup_claim_token","cleanup_lease_expires_at","cleanup_attempt_count","cleanup_next_retry_at","cleanup_completed_at","sandbox","finalization_intent_status","finalization_intent_at","created_at","updated_at"
  ];
  const values: unknown[] = [
    task.id,task.workspaceId,task.projectId,task.endpointId,task.fileLibraryId,task.createdByUserId??null,task.title ?? task.prompt.replace(/[\r\n]+/g," ").slice(0,160),task.prompt,task.agentContext??"",task.status,task.runId,task.executionMode,activeReservation,task.archivedAt ?? null,task.deletedAt ?? null,task.terminalReason ?? null,task.terminalizedAt ?? null,
    task.startDeliveryKey ?? null,task.startRequestHash ?? null,task.startClaimToken ?? null,task.startReceipt ? JSON.stringify(task.startReceipt) : null,task.startTimelineCursor ?? null,task.startIntentStatus ?? null,task.startClaimedAt ?? null,task.startLeaseExpiresAt ?? null,task.startAttemptCount ?? 0,task.startNextRetryAt ?? null,task.startSafeError ?? null,
    null,"complete",null,
    task.artifactProjectionStatus ?? "pending",task.artifactProjectionError ?? null,task.artifactProjectionClaimToken ?? null,task.artifactProjectionLeaseExpiresAt ?? null,task.artifactProjectionAttemptCount ?? 0,task.artifactProjectionNextRetryAt ?? null,
    task.cleanupStatus ?? "pending",task.cleanupError ?? null,task.cleanupClaimToken ?? null,task.cleanupLeaseExpiresAt ?? null,task.cleanupAttemptCount ?? 0,task.cleanupNextRetryAt ?? null,task.cleanupCompletedAt ?? null,JSON.stringify(task.sandbox),task.finalizationIntentStatus ?? null,task.finalizationIntentAt ?? null,task.createdAt,task.updatedAt
  ];
  const jsonColumns = new Set(["start_receipt","sandbox"]);
  const placeholders = columns.map((column,index) => `$${index+1}${jsonColumns.has(column)?"::jsonb":""}`);
  const inserted = await client.query<AgentTaskRow>(`insert into agent_tasks (${columns.join(",")}) values (${placeholders.join(",")}) returning *`,values);
  return inserted.rows[0]!;
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
  status: AgentTask["status"];
  run_id: string;
  execution_mode: AgentTask["executionMode"];
  active_reservation: boolean;
  archived_at: unknown;
  deleted_at: unknown;
  terminal_reason: AgentTask["terminalReason"];
  terminalized_at: unknown;
  start_delivery_key: string | null;
  start_request_hash: string | null;
  start_claim_token: string | null;
  start_receipt: unknown;
  start_timeline_cursor: string | null;
  start_intent_status: AgentTask["startIntentStatus"];
  start_claimed_at: unknown;
  start_lease_expires_at: unknown;
  start_attempt_count: number | null;
  start_next_retry_at: unknown;
  start_safe_error: string | null;
  interaction_source_cursor: string | null;
  interaction_history_status: "complete" | "gap";
  interaction_last_synced_at: unknown;
  artifact_projection_status: AgentTask["artifactProjectionStatus"];
  artifact_projection_error: string | null;
  artifact_projection_claim_token: string | null;
  artifact_projection_lease_expires_at: unknown;
  artifact_projection_attempt_count: number | null;
  artifact_projection_next_retry_at: unknown;
  cleanup_status: AgentTask["cleanupStatus"];
  cleanup_error: string | null;
  cleanup_claim_token: string | null;
  cleanup_lease_expires_at: unknown;
  cleanup_attempt_count: number | null;
  cleanup_next_retry_at: unknown;
  cleanup_completed_at: unknown;
  sandbox: unknown;
  finalization_intent_status: PersistedAgentTask["finalizationIntentStatus"];
  finalization_intent_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}
interface SandboxReleaseTaskRow extends AgentTaskRow { project_workspace_id:string;project_owner_user_id:string; }

interface ProfileRow { user_id: string; display_name: string | null; timezone: string | null; bio:string|null; job_title:string|null; company:string|null; greeting_preference:string|null; interests:string[]|null; updated_at: unknown; }
interface NotificationRow { id:string; user_id:string; type:string; title:string; body:string|null; project_id:string|null; resource_kind:UserNotification["resourceKind"]; resource_id:string|null; link_path:string|null; read_at:unknown; created_at:unknown; dedupe_key:string|null; }
interface AlertRuleRow { id:string; project_id:string; alert_type:ProjectAlertRule["alertType"]; name:string; metric:ProjectAlertRule["metric"]; condition:ProjectAlertRule["condition"]; threshold:number; window_seconds:number|null; scope_kind:"project"|"endpoint"; endpoint_id:string|null; enabled:boolean; created_at:unknown; updated_at:unknown; }

interface ProviderSettlementRow {
  id: string; project_id: string; task_id: string | null; endpoint_id: string | null; actor_id:string|null; status: ProjectProviderSettlement["status"];
  reserved_tokens:string|number;reserved_cost:string|number;
  reserved_at: unknown; expires_at: unknown; dispatched_at: unknown; delivered_at: unknown; settled_at: unknown;
  provider_tokens: string | number | null; provider_cost: string | number | null; updated_at: unknown;
}

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
interface TaskSummaryRow { task_id:string; artifact_count:number; updated_at:unknown; }
interface ProjectPolicyRow { project_id: string; active_tasks_limit: number | null; provider_requests_limit: string | number | null; provider_tokens_limit: string | number | null; provider_cost_limit: number | null; project_file_bytes_limit: string | number | null; created_at: unknown; updated_at: unknown; }
interface ProjectUsageRow { project_id: string; active_tasks: number; provider_requests: string | number; provider_tokens: string | number; provider_cost: number; project_file_bytes: string | number; updated_at: unknown; }
interface ProjectProviderSettlementRow extends ProjectUsageRow { provider_tokens_exceeded: boolean; provider_cost_exceeded: boolean; }
interface ProjectAlertRow { id: string; project_id: string; type: ProjectAlert["type"]; status: ProjectAlert["status"]; delivery_status: ProjectAlert["deliveryStatus"]; rule_id:string|null;metric:import("../../contracts/src/api.js").AlertRuleMetric|null;metric_value:number|null;threshold:number|null;endpoint_id:string|null;acknowledged_at:unknown;acknowledged_by:string|null;silenced_until:unknown; created_at: unknown; updated_at: unknown; resolved_at: unknown; dismissed_at: unknown; }
interface ProjectAuditRow { id: string; project_id: string; actor_id: string | null; subject_user_id:string|null; action: ProjectAuditEvent["action"]; status: ProjectAuditEvent["status"]; resource_kind: ProjectAuditEvent["resourceKind"]; resource_id: string | null; detail:ProjectAuditEvent["detail"]; created_at: unknown; }
interface SandboxUsageSettlementRow { run_id:string;workspace_id:string;project_id:string;task_id:string;file_library_id:string;started_by_user_id:string;started_at:unknown;released_at:unknown;duration_seconds:number|string;cpu_request_millis:string;memory_request_bytes:string;cpu_limit_millis:string;memory_limit_bytes:string;release_reason:import("../../contracts/src/api.js").SandboxReleaseReason; }

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
    taskConcurrencyLimit: row.task_concurrency_limit,
    lifecycleStatus: row.lifecycle_status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}
function mapFileLibrary(row:FileLibraryRow):FileLibrary{return{id:row.id,workspaceId:row.workspace_id,projectId:row.project_id,name:row.name,rootSubPath:row.root_sub_path,createdByUserId:row.created_by_user_id,createdAt:toIso(row.created_at),updatedAt:toIso(row.updated_at)}}
function mapContext(row: ContextRow): ProjectContextEntry { return { id:row.id,workspaceId:row.workspace_id,projectId:row.project_id,ownerUserId:row.owner_user_id,scope:row.scope,contextKey:row.context_key,content:row.content,contentType:row.content_type,version:row.version,createdAt:toIso(row.created_at),updatedAt:toIso(row.updated_at) }; }

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
    status: row.status,
    runId: row.run_id,
    executionMode: row.execution_mode,
    activeReservation: row.active_reservation ?? false,
    archivedAt: row.archived_at ? toIso(row.archived_at) : null,
    deletedAt: row.deleted_at ? toIso(row.deleted_at) : null,
    terminalReason: row.terminal_reason ?? null,
    terminalizedAt: row.terminalized_at ? toIso(row.terminalized_at) : null,
    startDeliveryKey: row.start_delivery_key,
    startRequestHash: row.start_request_hash,
    startClaimToken: row.start_claim_token,
    startReceipt: mapTaskDeliveryReceipt(row.start_receipt),
    startTimelineCursor: row.start_timeline_cursor,
    startIntentStatus: row.start_intent_status ?? null,
    startClaimedAt: row.start_claimed_at ? toIso(row.start_claimed_at) : null,
    startLeaseExpiresAt: row.start_lease_expires_at ? toIso(row.start_lease_expires_at) : null,
    startAttemptCount: row.start_attempt_count ?? 0,
    startNextRetryAt: row.start_next_retry_at ? toIso(row.start_next_retry_at) : null,
    startSafeError: row.start_safe_error,
    artifactProjectionStatus: row.artifact_projection_status ?? "pending",
    artifactProjectionError: row.artifact_projection_error,
    artifactProjectionClaimToken: row.artifact_projection_claim_token,
    artifactProjectionLeaseExpiresAt: row.artifact_projection_lease_expires_at ? toIso(row.artifact_projection_lease_expires_at) : null,
    artifactProjectionAttemptCount: row.artifact_projection_attempt_count ?? 0,
    artifactProjectionNextRetryAt: row.artifact_projection_next_retry_at ? toIso(row.artifact_projection_next_retry_at) : null,
    cleanupStatus: row.cleanup_status ?? "pending",
    cleanupError: row.cleanup_error,
    cleanupClaimToken: row.cleanup_claim_token,
    cleanupLeaseExpiresAt: row.cleanup_lease_expires_at ? toIso(row.cleanup_lease_expires_at) : null,
    cleanupAttemptCount: row.cleanup_attempt_count ?? 0,
    cleanupNextRetryAt: row.cleanup_next_retry_at ? toIso(row.cleanup_next_retry_at) : null,
    cleanupCompletedAt: row.cleanup_completed_at ? toIso(row.cleanup_completed_at) : null,
    sandbox: asRecord(row.sandbox) as unknown as PersistedAgentTask["sandbox"],
    finalizationIntentStatus: row.finalization_intent_status ?? null,
    finalizationIntentAt: row.finalization_intent_at ? toIso(row.finalization_intent_at) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function mapProfile(row: ProfileRow): UserProfilePreferences { return { userId: row.user_id, displayName: row.display_name, timezone: row.timezone, bio:row.bio, jobTitle:row.job_title, company:row.company, greetingPreference:profileGreetingPreference(row.greeting_preference), interests:row.interests??[], updatedAt: toIso(row.updated_at) }; }
function profileGreetingPreference(value:string|null):ProfileGreetingPreference|null{return PROFILE_GREETING_PREFERENCES.includes(value as ProfileGreetingPreference)?value as ProfileGreetingPreference:null}
function mapNotification(row:NotificationRow):UserNotification{return{id:row.id,userId:row.user_id,type:row.type,title:row.title,body:row.body,projectId:row.project_id,resourceKind:row.resource_kind,resourceId:row.resource_id,linkPath:row.link_path,readAt:row.read_at?toIso(row.read_at):null,createdAt:toIso(row.created_at)}} function mapAlertRule(row:AlertRuleRow):ProjectAlertRule{return{id:row.id,projectId:row.project_id,name:row.name,alertType:row.alert_type,metric:row.metric!,condition:row.condition!,threshold:Number(row.threshold),windowSeconds:row.window_seconds===null?null:Number(row.window_seconds),scope:row.scope_kind==='endpoint'?{kind:'endpoint',endpointId:row.endpoint_id!}:{kind:'project'},enabled:row.enabled,createdAt:toIso(row.created_at),updatedAt:toIso(row.updated_at)}}

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
function mapTaskSummary(row: TaskSummaryRow): StoredTaskSummary { return { taskId:row.task_id,artifactCount:Number(row.artifact_count),updatedAt:toIso(row.updated_at) }; }

function validatePostgresInteractionChange(taskId:string,change:PersistTaskInteractionMutationInput["changes"][number]):void {
  if(change.interaction.taskId!==taskId||change.interaction.id.length===0||change.sourceId.length===0)throw new Error("Task interaction identity mismatch");
  if(change.sourceKind==="botified"&&change.sourceRevision!==0)throw new Error("Botified interaction revisions are cursor-based");
  if(!Number.isSafeInteger(change.sourceRevision)||change.sourceRevision<0||!Number.isSafeInteger(change.interaction.revision)||change.interaction.revision<1||!Number.isSafeInteger(change.interaction.position)||change.interaction.position<0)throw new Error("Task interaction sequence is invalid");
}

function mapTaskDeliveryReceipt(value: unknown): NonNullable<PersistedAgentTask["startReceipt"]> | null {
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

function policyValues(policy: ProjectResourcePolicy): unknown[] { return [policy.projectId, policy.activeTasksLimit, policy.providerRequestsLimit, policy.providerTokensLimit, policy.providerCostLimit, policy.projectFileBytesLimit, policy.createdAt, policy.updatedAt]; }
function usageValues(usage: ProjectResourceUsage): unknown[] { return [usage.projectId, usage.activeTasks, usage.providerRequests, usage.providerTokens, usage.providerCost, usage.projectFileBytes, usage.updatedAt]; }
function mapPolicy(row: ProjectPolicyRow): ProjectResourcePolicy {
  if (row.active_tasks_limit === null) throw new Error("Project active task limit is not configured");
  return { projectId: row.project_id, activeTasksLimit: row.active_tasks_limit, providerRequestsLimit: nullableNumber(row.provider_requests_limit), providerTokensLimit: nullableNumber(row.provider_tokens_limit), providerCostLimit: row.provider_cost_limit, projectFileBytesLimit: nullableNumber(row.project_file_bytes_limit), endpointWindows:[], createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at) };
}
function mapUsage(row: ProjectUsageRow): ProjectResourceUsage { return { projectId: row.project_id, activeTasks: row.active_tasks, providerRequests: Number(row.provider_requests), providerTokens: Number(row.provider_tokens), providerCost: row.provider_cost, projectFileBytes: Number(row.project_file_bytes), updatedAt: toIso(row.updated_at) }; }

function usageColumn(limit: ProjectAlert["type"]): string { return limit === "active_tasks_limit" ? "active_tasks" : limit === "provider_requests_limit" ? "provider_requests" : limit === "provider_tokens_limit" ? "provider_tokens" : limit === "provider_cost_limit" ? "provider_cost" : "project_file_bytes"; }
function usageLimitColumn(limit: ProjectAlert["type"]): string { return `${usageColumn(limit)}_limit`; }
function usageDeltaPlaceholder(limit: ProjectAlert["type"]): number { return limit === "active_tasks_limit" ? 2 : limit === "provider_requests_limit" ? 3 : limit === "provider_tokens_limit" ? 4 : limit === "provider_cost_limit" ? 5 : 6; }
function usageDelta(limit: ProjectAlert["type"], delta: ProjectResourceUsageAdjustment["delta"]): number { return limit === "active_tasks_limit" ? delta.activeTasks : limit === "provider_requests_limit" ? delta.providerRequests : limit === "provider_tokens_limit" ? delta.providerTokens : limit === "provider_cost_limit" ? delta.providerCost : delta.projectFileBytes; }
function mapAlert(row: ProjectAlertRow): ProjectAlert { return { id: row.id, projectId: row.project_id, type: row.type, status: row.status, deliveryStatus: row.delivery_status,ruleId:row.rule_id,metric:row.metric,metricValue:row.metric_value===null?null:Number(row.metric_value),threshold:row.threshold===null?null:Number(row.threshold),endpointId:row.endpoint_id,acknowledgedAt:row.acknowledged_at?toIso(row.acknowledged_at):null,acknowledgedBy:row.acknowledged_by,silencedUntil:row.silenced_until?toIso(row.silenced_until):null, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at), resolvedAt: row.resolved_at ? toIso(row.resolved_at) : null, dismissedAt: row.dismissed_at ? toIso(row.dismissed_at) : null }; }
function mapAudit(row: ProjectAuditRow): ProjectAuditEvent { return { id: row.id, projectId: row.project_id, actorId: row.actor_id, subjectUserId:row.subject_user_id??null, action: row.action, status: row.status, resourceKind: row.resource_kind, resourceId: row.resource_id,detail:row.detail??{}, createdAt: toIso(row.created_at) }; }
function mapSandboxUsageSettlement(row:SandboxUsageSettlementRow):SandboxUsageSettlement{return{runId:row.run_id,workspaceId:row.workspace_id,projectId:row.project_id,taskId:row.task_id,fileLibraryId:row.file_library_id,startedByUserId:row.started_by_user_id,startedAt:row.started_at?toIso(row.started_at):null,releasedAt:toIso(row.released_at),durationSeconds:Number(row.duration_seconds),resources:{cpuRequestMillis:String(row.cpu_request_millis),memoryRequestBytes:String(row.memory_request_bytes),cpuLimitMillis:String(row.cpu_limit_millis),memoryLimitBytes:String(row.memory_limit_bytes)},releaseReason:row.release_reason}}
function sameRunIdentity(left:PersistedSandboxRunState,right:PersistedSandboxRunState):boolean{return left.runId===right.runId&&left.taskId===right.taskId&&left.projectId===right.projectId&&left.workspaceId===right.workspaceId&&left.fileLibraryId===right.fileLibraryId&&left.startedByUserId===right.startedByUserId&&left.startedAt===right.startedAt&&JSON.stringify(left.resourceLimits)===JSON.stringify(right.resourceLimits)&&JSON.stringify(left.resourceSnapshot)===JSON.stringify(right.resourceSnapshot)}
function taskRunRowIdentityMatches(task:AgentTaskRow,run:PersistedSandboxRunState,input:ActivateTaskSandboxRunInput):boolean{return task.id===input.taskId&&task.run_id===input.runId&&run.taskId===input.taskId&&run.runId===input.runId&&task.workspace_id===run.workspaceId&&task.project_id===run.projectId&&task.file_library_id===run.fileLibraryId}
function sameSettlement(left:SandboxUsageSettlement,right:SandboxUsageSettlement):boolean{return JSON.stringify(left)===JSON.stringify(right)}
function settlementMatchesRun(value:SandboxUsageSettlement,current:PersistedSandboxRunState,cleaned:PersistedSandboxRunState):boolean{const duration=current.startedAt===null?0:Math.max(0,(Date.parse(cleaned.updatedAt)-Date.parse(current.startedAt))/1000);return value.runId===current.runId&&value.workspaceId===current.workspaceId&&value.projectId===current.projectId&&value.taskId===current.taskId&&value.fileLibraryId===current.fileLibraryId&&value.startedByUserId===current.startedByUserId&&value.startedAt===current.startedAt&&value.releasedAt===cleaned.updatedAt&&value.durationSeconds===duration&&value.releaseReason===cleaned.releaseReason&&JSON.stringify(value.resources)===JSON.stringify(current.resourceSnapshot)}
function taskMatchesActiveSandboxRunRow(task:SandboxReleaseTaskRow|undefined,run:PersistedSandboxRunState):task is SandboxReleaseTaskRow{return Boolean(task&&task.deleted_at===null&&task.execution_mode==="live"&&task.active_reservation===true&&task.id===run.taskId&&task.run_id===run.runId&&task.project_id===run.projectId&&task.workspace_id===run.workspaceId&&task.file_library_id===run.fileLibraryId&&task.project_workspace_id===run.workspaceId&&(task.created_by_user_id??task.project_owner_user_id)===run.startedByUserId)}
function nullableNumber(value: string | number | null): number | null { return value === null ? null : Number(value); }
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
