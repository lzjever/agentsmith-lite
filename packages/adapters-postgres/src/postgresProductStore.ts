import { createRequire } from "node:module";
import type {
  AgentTask,
  TaskInteractionItem,
  ProjectChatMessage,
  ProjectChatThread,
  AuthSession,
  EndpointCapability,
  EndpointProtocol,
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
  Workspace, WorkspaceMembership, WorkspaceMembershipView, WorkspaceListProjection, UserProfilePreferences, ProjectContextEntry, UserNotification, ProjectAlertRule, ProjectCredential, StoredProjectCredential, TaskSummary
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
  FinalizeTaskLifecycleInput,
  FinalizeTaskLifecycleResult,
  TaskStageClaimInput,
  TaskStageCompleteInput,
  TaskStageFailureInput,
  BeginTaskIdempotencyInput,
  TaskIdempotencyBeginResult,
  CompleteTaskIdempotencyInput,
  CreateTerminalTaskMessageInput,
  ResolveTerminalPendingMessageInput,
  PersistTaskArtifactProjectionInput,
  DeleteEndpointResult,
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
  async upsertUserProfilePreferences(value: UserProfilePreferences): Promise<UserProfilePreferences> { const rows=await this.queryRows<ProfileRow>('insert into user_profile_preferences (user_id,display_name,timezone,bio,job_title,company,greeting_preference,interests,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (user_id) do update set display_name=excluded.display_name,timezone=excluded.timezone,bio=excluded.bio,job_title=excluded.job_title,company=excluded.company,greeting_preference=excluded.greeting_preference,interests=excluded.interests,updated_at=excluded.updated_at returning *',[value.userId,value.displayName,value.timezone,value.bio,value.jobTitle,value.company,value.greetingPreference,value.interests,value.updatedAt]); return mapProfile(rows[0]!); }
  async createUserNotification(v:UserNotification,dedupeKey?:string){const r=await this.queryRows<NotificationRow>('insert into user_notifications (id,user_id,type,title,body,project_id,resource_kind,resource_id,link_path,read_at,created_at,dedupe_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (dedupe_key) do update set dedupe_key=user_notifications.dedupe_key returning *',[v.id,v.userId,v.type,v.title,v.body,v.projectId,v.resourceKind,v.resourceId,v.linkPath,v.readAt,v.createdAt,dedupeKey??null]);return mapNotification(r[0]!)} async listUserNotifications(userId:string,unreadOnly=false){const r=await this.queryRows<NotificationRow>(`select * from user_notifications where user_id=$1 ${unreadOnly?'and read_at is null':''} order by created_at desc`,[userId]);return r.map(mapNotification)} async markUserNotificationRead(id:string,userId:string,readAt:string){const r=await this.queryRows<NotificationRow>('update user_notifications set read_at=$3 where id=$1 and user_id=$2 returning *',[id,userId,readAt]);return r[0]?mapNotification(r[0]):null} async markAllUserNotificationsRead(userId:string,readAt:string){return (await this.pool.query('update user_notifications set read_at=$2 where user_id=$1 and read_at is null',[userId,readAt])).rowCount??0} async dismissUserNotification(id:string,userId:string){return (await this.pool.query('delete from user_notifications where id=$1 and user_id=$2',[id,userId])).rowCount===1}

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
      `insert into auth_sessions (id, user_id, csrf_token, created_at, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [session.id, session.userId, session.csrfToken, session.createdAt, session.expiresAt]
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
  async updateWorkspace(value: Workspace): Promise<Workspace | null> { const rows=await this.queryRows<WorkspaceRow>('update workspaces set name=$2,owner_user_id=$3,updated_at=$4 where id=$1 and lifecycle_status=$5 returning *',[value.id,value.name,value.ownerUserId,value.updatedAt,value.lifecycleStatus ?? "active"]); return rows[0]?mapWorkspace(rows[0]):null; }
  async beginWorkspaceDeletion(id:string,updatedAt:string):Promise<Workspace|null>{const rows=await this.queryRows<WorkspaceRow>("update workspaces set lifecycle_status='deleting',updated_at=$2 where id=$1 returning *",[id,updatedAt]);return rows[0]?mapWorkspace(rows[0]):null}
  async setWorkspaceLifecycleStatus(id:string,status:"active"|"archived",updatedAt:string):Promise<Workspace|null>{const rows=await this.queryRows<WorkspaceRow>("update workspaces set lifecycle_status=$2,updated_at=$3 where id=$1 and lifecycle_status <> 'deleting' returning *",[id,status,updatedAt]);return rows[0]?mapWorkspace(rows[0]):null}
  async transferWorkspaceOwner(workspaceId:string,fromUserId:string,toUserId:string,updatedAt:string):Promise<Workspace|null>{return transaction(this.pool,async(client)=>{if(fromUserId===toUserId)return null;const target=await client.query("select 1 from workspace_memberships where workspace_id=$1 and user_id=$2 for update",[workspaceId,toUserId]);if(!target.rowCount)return null;const workspace=await client.query<WorkspaceRow>("update workspaces set owner_user_id=$3,updated_at=$4 where id=$1 and owner_user_id=$2 and lifecycle_status='active' returning *",[workspaceId,fromUserId,toUserId,updatedAt]);if(!workspace.rows[0])return null;await client.query("update workspace_memberships set role='admin',updated_at=$3 where workspace_id=$1 and user_id=$2",[workspaceId,fromUserId,updatedAt]);await client.query("update workspace_memberships set role='owner',updated_at=$3 where workspace_id=$1 and user_id=$2",[workspaceId,toUserId,updatedAt]);return mapWorkspace(workspace.rows[0])})}
  async deleteWorkspaceAfterProjects(id:string):Promise<boolean>{return transaction(this.pool,async(client)=>{const ready=await client.query("select 1 from workspaces where id=$1 and lifecycle_status='deleting' and not exists (select 1 from projects where workspace_id=$1) for update",[id]);if(ready.rowCount!==1)return false;await client.query("delete from project_context_entries where workspace_id=$1",[id]);return (await client.query("delete from workspaces where id=$1 and lifecycle_status='deleting'",[id])).rowCount===1})}
  async findWorkspaceMembership(workspaceId:string,userId:string):Promise<WorkspaceMembership|null>{const rows=await this.queryRows<WorkspaceMembershipRow>("select * from workspace_memberships where workspace_id=$1 and user_id=$2",[workspaceId,userId]);return rows[0]?mapWorkspaceMembership(rows[0]):null}
  async listWorkspaceMemberships(workspaceId:string):Promise<WorkspaceMembershipView[]>{return (await this.queryRows<WorkspaceMembershipRow>("select wm.*, u.email, p.display_name from workspace_memberships wm join users u on u.id=wm.user_id left join user_profile_preferences p on p.user_id=u.id where wm.workspace_id=$1 order by wm.created_at,wm.user_id",[workspaceId])).map(mapWorkspaceMembershipView)}
  async upsertWorkspaceMembership(value:WorkspaceMembership):Promise<WorkspaceMembership>{const rows=await this.queryRows<WorkspaceMembershipRow>("insert into workspace_memberships (workspace_id,user_id,role,created_at,updated_at) values ($1,$2,$3,$4,$5) on conflict (workspace_id,user_id) do update set role=excluded.role,updated_at=excluded.updated_at returning *",[value.workspaceId,value.userId,value.role,value.createdAt,value.updatedAt]);return mapWorkspaceMembership(rows[0]!)}
  async updateWorkspaceMembership(value:WorkspaceMembership):Promise<WorkspaceMembership|null>{const rows=await this.queryRows<WorkspaceMembershipRow>("update workspace_memberships set role=$3,updated_at=$4 where workspace_id=$1 and user_id=$2 returning *",[value.workspaceId,value.userId,value.role,value.updatedAt]);return rows[0]?mapWorkspaceMembership(rows[0]):null}
  async revokeWorkspaceMembership(workspaceId:string,userId:string):Promise<"revoked"|"not_found"|"owner">{return transaction(this.pool,async(client)=>{const membership=await client.query<{role:string}>("select role from workspace_memberships where workspace_id=$1 and user_id=$2 for update",[workspaceId,userId]);if(!membership.rows[0])return "not_found";if(membership.rows[0].role==="owner")return "owner";const owned=await client.query("select p.id from projects p join project_memberships pm on pm.project_id=p.id where p.workspace_id=$1 and pm.user_id=$2 and (p.owner_user_id=$2 or pm.role='owner') for update of p,pm",[workspaceId,userId]);if(owned.rowCount)return "owner";await client.query("delete from project_memberships pm using projects p where pm.project_id=p.id and p.workspace_id=$1 and pm.user_id=$2",[workspaceId,userId]);const deleted=await client.query("delete from workspace_memberships where workspace_id=$1 and user_id=$2 and role<>'owner'",[workspaceId,userId]);return deleted.rowCount===1?"revoked":"not_found"})}

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

  async findProject(id: string): Promise<Project | null> {
    const rows = await this.queryRows<ProjectRow>("select * from projects where id = $1", [id]);
    return rows[0] ? mapProject(rows[0]) : null;
  }
  async updateProject(value: Project): Promise<Project | null> { const rows=await this.queryRows<ProjectRow>('update projects set workspace_id=$2,name=$3,owner_user_id=$4,root_path=$5,task_concurrency_limit=$6,updated_at=$7 where id=$1 and lifecycle_status=$8 returning *',[value.id,value.workspaceId,value.name,value.ownerUserId,value.rootPath,value.taskConcurrencyLimit,value.updatedAt,value.lifecycleStatus ?? "active"]); return rows[0]?mapProject(rows[0]):null; }
  async beginProjectDeletion(id:string,updatedAt:string):Promise<Project|null>{const rows=await this.queryRows<ProjectRow>("update projects set lifecycle_status='deleting',updated_at=$2 where id=$1 returning *",[id,updatedAt]);return rows[0]?mapProject(rows[0]):null}
  async setProjectLifecycleStatus(id:string,status:"active"|"archived",updatedAt:string):Promise<Project|null>{const rows=await this.queryRows<ProjectRow>("update projects set lifecycle_status=$2,updated_at=$3 where id=$1 and lifecycle_status <> 'deleting' returning *",[id,status,updatedAt]);return rows[0]?mapProject(rows[0]):null}
  async transferProjectOwner(projectId:string,fromUserId:string,toUserId:string,updatedAt:string):Promise<Project|null>{return transaction(this.pool,async(client)=>{if(fromUserId===toUserId)return null;const target=await client.query("select 1 from project_memberships where project_id=$1 and user_id=$2 for update",[projectId,toUserId]);if(!target.rowCount)return null;const project=await client.query<ProjectRow>("update projects set owner_user_id=$3,updated_at=$4 where id=$1 and owner_user_id=$2 and lifecycle_status='active' returning *",[projectId,fromUserId,toUserId,updatedAt]);if(!project.rows[0])return null;await client.query("update project_memberships set role='admin',updated_at=$3 where project_id=$1 and user_id=$2",[projectId,fromUserId,updatedAt]);await client.query("update project_memberships set role='owner',updated_at=$3 where project_id=$1 and user_id=$2",[projectId,toUserId,updatedAt]);return mapProject(project.rows[0])})}
  async deleteProjectDependenciesAndProject(id:string):Promise<boolean>{return transaction(this.pool,async(client)=>{const project=await client.query<ProjectRow>("select * from projects where id=$1 and lifecycle_status='deleting' for update",[id]);if(!project.rows[0])return false;const active=await client.query("select 1 from agent_tasks where project_id=$1 and status in ('queued','starting','running','stopping') limit 1",[id]);if(active.rowCount)return false;const taskIds=(await client.query<{id:string;run_id:string}>("select id,run_id from agent_tasks where project_id=$1",[id])).rows;for(const task of taskIds){await client.query("delete from postgres_json_docs where (collection='sandbox_runtime_state' and id=$1) or (collection='sandbox_run_state' and id=$2)",[task.id,task.run_id])}await client.query("delete from task_messages where task_id in (select id from agent_tasks where project_id=$1)",[id]);await client.query("delete from agent_task_artifacts where task_id in (select id from agent_tasks where project_id=$1)",[id]);await client.query("delete from agent_tasks where project_id=$1",[id]);await client.query("delete from project_chat_messages where thread_id in (select id from project_chat_threads where project_id=$1)",[id]);await client.query("delete from project_chat_threads where project_id=$1",[id]);await client.query("delete from project_provider_settlements where project_id=$1",[id]);await client.query("delete from project_alerts where project_id=$1",[id]);await client.query("delete from project_alert_rules where project_id=$1",[id]);await client.query("delete from project_context_entries where project_id=$1",[id]);await client.query("delete from project_audit_events where project_id=$1",[id]);await client.query("delete from project_memberships where project_id=$1",[id]);await client.query("delete from project_resource_usage where project_id=$1",[id]);await client.query("delete from project_resource_policies where project_id=$1",[id]);await client.query("delete from model_endpoints where project_id=$1",[id]);await client.query("delete from project_credentials where project_id=$1",[id]);return (await client.query("delete from projects where id=$1 and lifecycle_status='deleting'",[id])).rowCount===1})}
  async createProjectContextEntry(v: ProjectContextEntry): Promise<ProjectContextEntry> { const rows=await this.queryRows<ContextRow>(`insert into project_context_entries (id,workspace_id,project_id,owner_user_id,scope,context_key,content,content_type,name,user_id,version,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$6,$4,$9,$10,$11) returning *`,[v.id,v.workspaceId,v.projectId,v.ownerUserId,v.scope,v.contextKey,v.content,v.contentType??"text",v.version,v.createdAt,v.updatedAt]); return mapContext(rows[0]!); }
  async updateProjectContextEntry(v: ProjectContextEntry, expectedVersion: number): Promise<ProjectContextEntry | null> { const rows=await this.queryRows<ContextRow>(`update project_context_entries set context_key=$2,content=$3,content_type=$4,version=$5,updated_at=$6 where id=$1 and version=$7 and workspace_id=$8 and project_id is not distinct from $9 and scope=$10 and owner_user_id is not distinct from $11 returning *`,[v.id,v.contextKey,v.content,v.contentType??"text",v.version,v.updatedAt,expectedVersion,v.workspaceId,v.projectId,v.scope,v.ownerUserId]); return rows[0]?mapContext(rows[0]):null; }
  async listProjectContextEntries(workspaceId:string,projectId:string|null,scope:ProjectContextEntry["scope"],ownerUserId:string|null): Promise<ProjectContextEntry[]> { const rows=await this.queryRows<ContextRow>('select * from project_context_entries where workspace_id=$1 and project_id is not distinct from $2 and scope=$3 and owner_user_id is not distinct from $4 order by context_key',[workspaceId,projectId,scope,ownerUserId]);return rows.map(mapContext); }
  async deleteProjectContextEntry(v: Pick<ProjectContextEntry, "id" | "workspaceId" | "projectId" | "scope" | "ownerUserId">): Promise<boolean> { return (await this.pool.query('delete from project_context_entries where id=$1 and workspace_id=$2 and project_id is not distinct from $3 and scope=$4 and owner_user_id is not distinct from $5',[v.id,v.workspaceId,v.projectId,v.scope,v.ownerUserId])).rowCount===1; }
  async createProjectAlertRule(v:ProjectAlertRule){const scope=v.scope??{kind:'project' as const};const r=await this.queryRows<AlertRuleRow>('insert into project_alert_rules (id,project_id,alert_type,name,metric,condition,threshold,window_seconds,scope_kind,endpoint_id,enabled,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *',[v.id,v.projectId,v.alertType,v.name??v.alertType.replaceAll('_',' '),v.metric??'failure_count',v.condition??'greater_than_or_equal',v.threshold??1,v.windowSeconds??null,scope.kind,scope.kind==='endpoint'?scope.endpointId:null,v.enabled,v.createdAt,v.updatedAt]);return mapAlertRule(r[0]!)} async listProjectAlertRules(id:string){return (await this.queryRows<AlertRuleRow>('select * from project_alert_rules where project_id=$1 order by created_at',[id])).map(mapAlertRule)} async updateProjectAlertRule(v:ProjectAlertRule){const scope=v.scope??{kind:'project' as const};const r=await this.queryRows<AlertRuleRow>('update project_alert_rules set alert_type=$2,name=$3,metric=$4,condition=$5,threshold=$6,window_seconds=$7,scope_kind=$8,endpoint_id=$9,enabled=$10,updated_at=$11 where id=$1 and project_id=$12 returning *',[v.id,v.alertType,v.name??v.alertType.replaceAll('_',' '),v.metric??'failure_count',v.condition??'greater_than_or_equal',v.threshold??1,v.windowSeconds??null,scope.kind,scope.kind==='endpoint'?scope.endpointId:null,v.enabled,v.updatedAt,v.projectId]);return r[0]?mapAlertRule(r[0]):null} async deleteProjectAlertRule(projectId:string,id:string){return (await this.pool.query('delete from project_alert_rules where id=$1 and project_id=$2',[id,projectId])).rowCount===1}

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

  async createProjectResourcePolicy(policy: ProjectResourcePolicy): Promise<ProjectResourcePolicy> {
    await this.pool.query(`insert into project_resource_policies (project_id, active_tasks_limit, provider_requests_limit, provider_tokens_limit, provider_cost_limit, project_file_bytes_limit, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, policyValues(policy));
    return structuredClone(policy);
  }
  async findProjectResourcePolicy(projectId: string): Promise<ProjectResourcePolicy | null> {
    const rows = await this.queryRows<ProjectPolicyRow>("select * from project_resource_policies where project_id = $1", [projectId]); if(!rows[0])return null;const policy=mapPolicy(rows[0]);policy.endpointWindows=(await this.queryRows<{endpoint_id:string;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;limit_value:number;window_seconds:number}>("select endpoint_id,metric,limit_value,window_seconds from project_endpoint_policy_windows where project_id=$1 order by endpoint_id,metric",[projectId])).map(row=>({endpointId:row.endpoint_id,metric:row.metric,limit:Number(row.limit_value),windowSeconds:Number(row.window_seconds)}));return policy;
  }
  async patchProjectResourcePolicy(projectId: string, input: UpdateProjectResourcePolicyInput, updatedAt: string): Promise<ProjectResourcePolicy | null> {
    const endpointWindows=input.endpointWindows;
    const scalarInput={...input};delete scalarInput.endpointWindows;
    const policyColumns = {
      activeTasksLimit: "active_tasks_limit",
      providerRequestsLimit: "provider_requests_limit",
      providerTokensLimit: "provider_tokens_limit",
      providerCostLimit: "provider_cost_limit",
      projectFileBytesLimit: "project_file_bytes_limit"
    } as const;
    return transaction(this.pool,async client=>{let row:ProjectPolicyRow|undefined;if(Object.keys(scalarInput).length){const updates=Object.keys(scalarInput).map((key,index)=>`${policyColumns[key as keyof typeof policyColumns]}=$${index+2}`);const values=Object.values(scalarInput);row=(await client.query<ProjectPolicyRow>(`update project_resource_policies set ${updates.join(", ")},updated_at=$${values.length+2} where project_id=$1 returning *`,[projectId,...values,updatedAt])).rows[0]}else row=(await client.query<ProjectPolicyRow>("select * from project_resource_policies where project_id=$1 for update",[projectId])).rows[0];if(!row)return null;if(input.activeTasksLimit!==undefined&&input.activeTasksLimit!==null)await client.query("update projects set task_concurrency_limit=$2,updated_at=$3 where id=$1",[projectId,input.activeTasksLimit,updatedAt]);if(endpointWindows){await client.query("delete from project_endpoint_policy_windows where project_id=$1",[projectId]);for(const window of endpointWindows)await client.query("insert into project_endpoint_policy_windows(project_id,endpoint_id,metric,limit_value,window_seconds) values($1,$2,$3,$4,$5)",[projectId,window.endpointId,window.metric,window.limit,window.windowSeconds])}const result=mapPolicy(row);result.updatedAt=updatedAt;result.endpointWindows=endpointWindows??(await client.query<{endpoint_id:string;metric:import("../../contracts/src/api.js").EndpointPolicyMetric;limit_value:number;window_seconds:number}>("select endpoint_id,metric,limit_value,window_seconds from project_endpoint_policy_windows where project_id=$1 order by endpoint_id,metric",[projectId])).rows.map(item=>({endpointId:item.endpoint_id,metric:item.metric,limit:Number(item.limit_value),windowSeconds:Number(item.window_seconds)}));return result})
  }
  async findProjectResourceUsage(projectId: string): Promise<ProjectResourceUsage | null> {
    const rows = await this.queryRows<ProjectUsageRow>("select * from project_resource_usage where project_id = $1", [projectId]); return rows[0] ? mapUsage(rows[0]) : null;
  }
  async upsertProjectResourceUsage(usage: ProjectResourceUsage): Promise<ProjectResourceUsage> {
    const rows = await this.queryRows<ProjectUsageRow>(`insert into project_resource_usage (project_id,active_tasks,provider_requests,provider_tokens,provider_cost,project_file_bytes,updated_at) values ($1,$2,$3,$4,$5,$6,$7) on conflict (project_id) do update set active_tasks=excluded.active_tasks,provider_requests=excluded.provider_requests,provider_tokens=excluded.provider_tokens,provider_cost=excluded.provider_cost,project_file_bytes=excluded.project_file_bytes,updated_at=excluded.updated_at returning *`, usageValues(usage)); return mapUsage(rows[0]!);
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
  async transitionProjectAlert(projectId: string, id: string, status: "resolved" | "dismissed", updatedAt: string): Promise<ProjectAlert | null> { const column = status === "resolved" ? "resolved_at" : "dismissed_at"; const rows = await this.queryRows<ProjectAlertRow>(`update project_alerts set status=$3, ${column}=$4, updated_at=$4 where project_id=$1 and id=$2 and status='active' returning *`, [projectId, id, status, updatedAt]); return rows[0] ? mapAlert(rows[0]) : null; }
  async updateProjectAlertState(projectId:string,id:string,input:{acknowledgedAt?:string;acknowledgedBy?:string;silencedUntil?:string|null},updatedAt:string){const rows=await this.queryRows<ProjectAlertRow>(`update project_alerts set acknowledged_at=coalesce($3,acknowledged_at),acknowledged_by=coalesce($4,acknowledged_by),silenced_until=case when $5::boolean then $6::timestamptz else silenced_until end,updated_at=$7 where project_id=$1 and id=$2 and status='active' returning *`,[projectId,id,input.acknowledgedAt??null,input.acknowledgedBy??null,Object.hasOwn(input,'silencedUntil'),input.silencedUntil??null,updatedAt]);return rows[0]?mapAlert(rows[0]):null}
  async updateProjectAlertDeliveryStatus(projectId: string, id: string, status: ProjectAlert["deliveryStatus"], updatedAt: string): Promise<ProjectAlert | null> { const rows = await this.queryRows<ProjectAlertRow>("update project_alerts set delivery_status=$3, updated_at=$4 where project_id=$1 and id=$2 returning *", [projectId, id, status, updatedAt]); return rows[0] ? mapAlert(rows[0]) : null; }
  async appendProjectAuditEvent(event: ProjectAuditEvent): Promise<void> { await this.pool.query("insert into project_audit_events (id,project_id,actor_id,action,status,resource_kind,resource_id,detail,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do nothing", [event.id,event.projectId,event.actorId,event.action,event.status,event.resourceKind,event.resourceId,sanitizeProjectAuditDetail(event.detail),event.createdAt]); }
  async listProjectAuditEvents(projectId:string){const rows=await this.queryRows<ProjectAuditRow>('select * from project_audit_events where project_id=$1 order by created_at,id',[projectId]);return rows.map(mapAudit)}
  async queryProjectAuditEvents(projectId:string,query:import("../../contracts/src/api.js").ProjectAuditQuery){const limit=Math.min(100,Math.max(1,query.limit??20));const values:unknown[]=[projectId];const where=["project_id=$1"];const add=(sql:string,value:unknown)=>{values.push(value);where.push(sql.replace('?',`$${values.length}`))};if(query.action)add('action=?',query.action);if(query.status)add('status=?',query.status);if(query.resourceKind)add('resource_kind=?',query.resourceKind);if(query.resourceId)add('resource_id=?',query.resourceId);if(query.from)add('created_at>=?',query.from);if(query.to)add('created_at<=?',query.to);if(query.cursor){const split=query.cursor.lastIndexOf('|');if(split<1)throw new Error('Invalid audit cursor');values.push(query.cursor.slice(0,split),query.cursor.slice(split+1));where.push(`(created_at,id)<($${values.length-1},$${values.length})`)}values.push(limit+1);const rows=await this.queryRows<ProjectAuditRow>(`select * from project_audit_events where ${where.join(' and ')} order by created_at desc,id desc limit $${values.length}`,values);const page=rows.slice(0,limit);return{items:page.map(mapAudit),nextCursor:rows.length>limit&&page.length?`${toIso(page.at(-1)!.created_at)}|${page.at(-1)!.id}`:null}}

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
  async deleteProjectCredential(id: string): Promise<boolean> { const result=await this.pool.query("delete from project_credentials where id=$1",[id]); return result.rowCount===1; }
  async listLegacyEndpointCredentialAliases(): Promise<Array<{ endpointId: string; projectId: string; baseUrl: string; secretRef: string }>> { const rows=await this.queryRows<{id:string;project_id:string;base_url:string;api_key_secret_ref:string}>("select id,project_id,base_url,api_key_secret_ref from model_endpoints where credential_id is null and api_key_secret_ref is not null"); return rows.map((row)=>({endpointId:row.id,projectId:row.project_id,baseUrl:row.base_url,secretRef:row.api_key_secret_ref})); }
  async bindEndpointCredential(endpointId:string, credentialId:string): Promise<boolean> { const result=await this.pool.query("update model_endpoints e set credential_id=$2, api_key_secret_ref=null from project_credentials c where e.id=$1 and e.credential_id is null and c.id=$2 and c.project_id=e.project_id",[endpointId,credentialId]); return result.rowCount===1; }

  async createEndpoint(endpoint: ModelEndpoint): Promise<ModelEndpoint> {
    await this.pool.query(
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
    return structuredClone(endpoint);
  }

  async updateEndpoint(endpoint: ModelEndpoint): Promise<ModelEndpoint | null> {
    const rows = await this.queryRows<ModelEndpointRow>(
      `update model_endpoints
       set name = $2, protocol = $3, base_url = $4, model = $5, credential_id=$6,
           capabilities = $7::jsonb, request_timeout_secs = $8, health_status=$9, health_checked_at=$10, health_error_category=$11, updated_at = $12
       where id = $1
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
        endpoint.updatedAt
      ]
    );
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

      await client.query("update project_chat_threads set endpoint_id = null where endpoint_id = $1", [id]);
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

  async createProjectChatThread(thread: ProjectChatThread): Promise<ProjectChatThread> {
    const rows = await this.queryRows<ProjectChatThreadRow>("insert into project_chat_threads (id,project_id,endpoint_id,title,pinned_at,starred_at,deleted_at,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *", [thread.id, thread.projectId, thread.endpointId, thread.title ?? null, thread.pinnedAt ?? null, thread.starredAt ?? null, thread.deletedAt ?? null, thread.createdAt, thread.updatedAt]);
    return mapChatThread(rows[0]!);
  }

  async findProjectChatThread(id: string): Promise<ProjectChatThread | null> { const rows = await this.queryRows<ProjectChatThreadRow>("select * from project_chat_threads where id=$1", [id]); return rows[0] ? mapChatThread(rows[0]) : null; }
  async listProjectChatThreads(projectId: string): Promise<ProjectChatThread[]> { const rows = await this.queryRows<ProjectChatThreadRow>("select * from project_chat_threads where project_id=$1 and deleted_at is null order by starred_at desc nulls last,pinned_at desc nulls last,updated_at desc,id desc", [projectId]); return rows.map(mapChatThread); }
  async searchProjectChatThreads(projectId: string, query: string): Promise<ProjectChatThread[]> { const rows = await this.queryRows<ProjectChatThreadRow>("select * from project_chat_threads where project_id=$1 and deleted_at is null and ($2 = '' or title ilike '%' || $2 || '%') order by starred_at desc nulls last,pinned_at desc nulls last,updated_at desc,id desc", [projectId, query.trim()]); return rows.map(mapChatThread); }
  async updateProjectChatThreadMetadata(id: string, metadata: Pick<ProjectChatThread, "title" | "pinnedAt" | "starredAt">, updatedAt: string): Promise<ProjectChatThread | null> { const rows=await this.queryRows<ProjectChatThreadRow>("update project_chat_threads set title=$2,pinned_at=$3,starred_at=$4,updated_at=$5 where id=$1 and deleted_at is null returning *",[id,metadata.title ?? null,metadata.pinnedAt ?? null,metadata.starredAt ?? null,updatedAt]); return rows[0] ? mapChatThread(rows[0]) : null; }
  async deleteProjectChatThread(id: string, deletedAt: string): Promise<ProjectChatThread | null> { const rows=await this.queryRows<ProjectChatThreadRow>("update project_chat_threads set deleted_at=$2,updated_at=$2 where id=$1 and deleted_at is null returning *",[id,deletedAt]); return rows[0] ? mapChatThread(rows[0]) : null; }
  async touchProjectChatThread(id: string, updatedAt: string): Promise<ProjectChatThread | null> { const rows = await this.queryRows<ProjectChatThreadRow>("update project_chat_threads set updated_at=$2 where id=$1 and deleted_at is null returning *", [id, updatedAt]); return rows[0] ? mapChatThread(rows[0]) : null; }
  async appendProjectChatMessages(messages: ProjectChatMessage[]): Promise<void> { for (const message of messages) await this.pool.query("insert into project_chat_messages (sequence,id,thread_id,role,content,version,delivery_status,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [message.sequence,message.id,message.threadId,message.role,message.content,message.version,message.deliveryStatus,message.createdAt,message.updatedAt]); }
  async listProjectChatMessages(threadId: string): Promise<ProjectChatMessage[]> { const rows = await this.queryRows<ProjectChatMessageRow>("select * from project_chat_messages where thread_id=$1 order by sequence", [threadId]); return rows.map(mapChatMessage); }
  async updateProjectChatMessageDelivery(id:string,deliveryStatus:ProjectChatMessage["deliveryStatus"],updatedAt:string):Promise<ProjectChatMessage|null>{const rows=await this.queryRows<ProjectChatMessageRow>("update project_chat_messages set delivery_status=$2,updated_at=$3,version=version+1 where id=$1 returning *",[id,deliveryStatus,updatedAt]);return rows[0]?mapChatMessage(rows[0]):null;}
  async stageProjectChatResponse(userMessageId:string,assistant:ProjectChatMessage):Promise<boolean>{const result=await this.pool.query("update project_chat_messages set delivery_status='response_pending',pending_assistant_id=$2,pending_assistant_content=$3,pending_assistant_created_at=$4,updated_at=$4,version=version+1 where id=$1 and role='user' and delivery_status in ('pending','failed','stopped')",[userMessageId,assistant.id,assistant.content,assistant.createdAt]);if(result.rowCount===1)return true;const existing=await this.pool.query<{delivery_status:string;pending_assistant_id:string|null}>("select delivery_status,pending_assistant_id from project_chat_messages where id=$1",[userMessageId]);return existing.rows[0]?.pending_assistant_id===assistant.id&&["response_pending","completed"].includes(existing.rows[0].delivery_status);}
  async finalizeProjectChatResponse(userMessageId:string):Promise<ProjectChatMessage|null>{return transaction(this.pool,async(client)=>{const result=await client.query<ProjectChatMessageRow&{pending_assistant_id:string|null;pending_assistant_content:string|null;pending_assistant_created_at:unknown}>("select * from project_chat_messages where id=$1 and role='user' for update",[userMessageId]);const user=result.rows[0];if(!user)return null;if(!user.pending_assistant_id){if(user.delivery_status!=="completed")return null;const existing=await client.query<ProjectChatMessageRow>("select * from project_chat_messages where thread_id=$1 and sequence=$2 and role='assistant'",[user.thread_id,Number(user.sequence)+1]);return existing.rows[0]?mapChatMessage(existing.rows[0]):null;}await client.query("insert into project_chat_messages (sequence,id,thread_id,role,content,version,delivery_status,created_at,updated_at) values ($1,$2,$3,'assistant',$4,1,'completed',$5,$5) on conflict (id) do nothing",[Number(user.sequence)+1,user.pending_assistant_id,user.thread_id,user.pending_assistant_content,user.pending_assistant_created_at]);await client.query("update project_chat_messages set delivery_status='completed',updated_at=$2,version=case when delivery_status='completed' then version else version+1 end where id=$1",[userMessageId,user.pending_assistant_created_at]);const assistant=await client.query<ProjectChatMessageRow>("select * from project_chat_messages where id=$1",[user.pending_assistant_id]);return assistant.rows[0]?mapChatMessage(assistant.rows[0]):null;});}
  async editProjectChatMessageAndTruncate(threadId:string,messageId:string,expectedVersion:number,content:string,updatedAt:string):Promise<ProjectChatMessage|null>{return transaction(this.pool,async(client)=>{const target=await client.query<ProjectChatMessageRow>("select * from project_chat_messages where id=$1 and thread_id=$2 for update",[messageId,threadId]);const row=target.rows[0];if(!row||row.version!==expectedVersion)return null;await client.query("delete from project_chat_messages where thread_id=$1 and sequence>$2",[threadId,row.sequence]);const updated=await client.query<ProjectChatMessageRow>("update project_chat_messages set content=$2,version=version+1,updated_at=$3 where id=$1 returning *",[messageId,content,updatedAt]);return mapChatMessage(updated.rows[0]!);});}
  async deleteProjectChatMessageAndFollowing(threadId:string,messageId:string,expectedVersion:number):Promise<boolean>{return transaction(this.pool,async(client)=>{const target=await client.query<ProjectChatMessageRow>("select * from project_chat_messages where id=$1 and thread_id=$2 for update",[messageId,threadId]);const row=target.rows[0];if(!row||row.version!==expectedVersion)return false;await client.query("delete from project_chat_messages where thread_id=$1 and sequence >= $2",[threadId,row.sequence]);return true;});}

  async createTask(task: PersistedAgentTask): Promise<PersistedAgentTask> {
    return transaction(this.pool, async (client) => mapTask(await insertTaskWithClient(client, task, false)));
  }

  async createTaskAtomically(input: AtomicTaskCreateInput): Promise<PersistedAgentTask | null> {
    return transaction(this.pool, async (client) => {
      if (input.reserveActive && !await reserveActiveTaskWithClient(client, input.task.projectId, input.task.updatedAt)) return null;
      const row = await insertTaskWithClient(client, input.task, input.reserveActive);
      if (input.runtimeState) await putJsonDocumentWithClient(client, "sandbox_runtime_state", input.task.id, input.runtimeState);
      if (input.sandboxRun) await putJsonDocumentWithClient(client, "sandbox_run_state", input.sandboxRun.runId, prepareSandboxRunDocument(input.sandboxRun));
      return mapTask(row);
    });
  }

  async createTaskWithActiveReservation(task: PersistedAgentTask): Promise<PersistedAgentTask | null> {
    return this.createTaskAtomically({ task, reserveActive: true });
  }

  async createTaskWithActiveReservationAndMessage(task: PersistedAgentTask, message: PersistedTaskMessage): Promise<PersistedAgentTask | null> {
    return transaction(this.pool, async (client) => {
      if (!await reserveActiveTaskWithClient(client, task.projectId, task.updatedAt)) return null;
      const row = await insertTaskWithClient(client, task, true);
      await insertPersistedTaskMessageWithClient(client, message);
      return mapTask(row);
    });
  }

  async updateTask(task: PersistedAgentTask): Promise<PersistedAgentTask> {
    await this.pool.query(
      `update agent_tasks
       set workspace_id = $2,
           project_id = $3,
           endpoint_id = $4,
           title = $5,
           prompt = $6,
           input_paths = $7::jsonb,
           status = $8,
           run_id = $9,
           source_task_id = $10,
           execution_mode = $11,
           active_reservation = $12,
           archived_at = $13,
           deleted_at = $14,
           terminal_reason = $15,
           terminalized_at = $16,
           sandbox = $17::jsonb,
           created_at = $18,
           updated_at = $19
       where id = $1`,
      [
        task.id,
        task.workspaceId,
        task.projectId,
        task.endpointId,
        task.title ?? task.prompt.replace(/[\r\n]+/g," ").slice(0,160),
        task.prompt,
        JSON.stringify(task.inputPaths ?? []),
        task.status,
        task.runId,
        task.sourceTaskId ?? null,
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
       where status in ('queued', 'starting', 'running', 'stopping')
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
    if (query.statuses.length > 0) {
      values.push(query.statuses);
      where.push(`status = any($${values.length}::text[])`);
    }
    if (query.archived === "exclude") where.push("archived_at is null");
    if (query.archived === "only") where.push("archived_at is not null");
    const count = await this.queryRows<{ count: string }>(`select count(*)::text as count from agent_tasks where ${where.join(" and ")}`, values);
    const sortColumn = query.sort === "created_at" ? "created_at" : query.sort === "updated_at" ? "updated_at" : query.sort === "status" ? "status" : "title";
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
    const rows = await this.queryRows<AgentTaskRow>("update agent_tasks set archived_at=$2,updated_at=$2 where id=$1 and deleted_at is null and terminal_reason is not null returning *", [taskId, archivedAt]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async softDeleteTask(taskId: string, deletedAt: string): Promise<PersistedAgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>("update agent_tasks set deleted_at=$2,updated_at=$2 where id=$1 and deleted_at is null and terminal_reason is not null returning *", [taskId, deletedAt]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async deleteTaskData(taskId: string, deletedAt: string): Promise<{ task: PersistedAgentTask; releasedArtifactBytes: number } | null> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update", [taskId]);
      const current = locked.rows[0];
      if (!current || !current.terminal_reason) return null;
      const released = await client.query<{ bytes: string }>("select coalesce(sum(bytes),0)::text as bytes from agent_task_artifacts where task_id=$1", [taskId]);
      const releasedArtifactBytes = Number(released.rows[0]?.bytes ?? 0);
      await client.query("delete from task_interaction_changes where task_id=$1", [taskId]);
      await client.query("delete from task_messages where task_id=$1", [taskId]);
      await client.query("delete from agent_task_artifacts where task_id=$1", [taskId]);
      await client.query("delete from postgres_json_docs where (collection='sandbox_runtime_state' and id=$1) or (collection='sandbox_run_state' and id=$2)", [taskId,current.run_id]);
      await client.query("update project_resource_usage set project_file_bytes=greatest(0,project_file_bytes-$2),updated_at=$3 where project_id=$1", [current.project_id,releasedArtifactBytes,deletedAt]);
      const updated = await client.query<AgentTaskRow>("update agent_tasks set deleted_at=coalesce(deleted_at,$2),updated_at=$2 where id=$1 returning *", [taskId,deletedAt]);
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

  async finalizeTaskLifecycle(input: FinalizeTaskLifecycleInput): Promise<FinalizeTaskLifecycleResult | null> {
    return transaction(this.pool, (client) => finalizeTaskLifecycleWithClient(client, input));
  }

  async listTasksForArtifactProjection(now: string, limit: number): Promise<PersistedAgentTask[]> {
    const rows = await this.queryRows<AgentTaskRow>(`select * from agent_tasks where terminal_reason is not null and artifact_projection_status in ('draining','failed') and (artifact_projection_next_retry_at is null or artifact_projection_next_retry_at <= $1) and (artifact_projection_lease_expires_at is null or artifact_projection_lease_expires_at <= $1) order by terminalized_at,id limit $2`, [now,limit]);
    return rows.map(mapTask);
  }
  async claimTaskArtifactProjection(input: TaskStageClaimInput): Promise<PersistedAgentTask | null> { return this.claimTaskStage("artifact",input); }
  async completeTaskArtifactProjection(input: TaskStageCompleteInput): Promise<PersistedAgentTask | null> { return this.completeTaskStage("artifact",input); }
  async failTaskArtifactProjection(input: TaskStageFailureInput): Promise<PersistedAgentTask | null> { return this.failTaskStage("artifact",input); }
  async listTasksForCleanup(now: string, limit: number): Promise<PersistedAgentTask[]> {
    const rows = await this.queryRows<AgentTaskRow>(`select * from agent_tasks where terminal_reason is not null and artifact_projection_status='drained' and cleanup_status in ('pending','running','failed') and (cleanup_next_retry_at is null or cleanup_next_retry_at <= $1) and (cleanup_lease_expires_at is null or cleanup_lease_expires_at <= $1) order by terminalized_at,id limit $2`, [now,limit]);
    return rows.map(mapTask);
  }
  async claimTaskCleanup(input: TaskStageClaimInput): Promise<PersistedAgentTask | null> { return this.claimTaskStage("cleanup",input); }
  async completeTaskCleanup(input: TaskStageCompleteInput): Promise<PersistedAgentTask | null> {
    return transaction(this.pool, async (client) => {
      const rows = await completeTaskStageWithClient(client,"cleanup",input);
      if (!rows[0]) return null;
      await client.query("delete from postgres_json_docs where (collection='sandbox_runtime_state' and id=$1) or (collection='sandbox_run_state' and id=$2)", [rows[0].id,rows[0].run_id]);
      return mapTask(rows[0]);
    });
  }
  async failTaskCleanup(input: TaskStageFailureInput): Promise<PersistedAgentTask | null> { return this.failTaskStage("cleanup",input); }

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
  async completeTaskIdempotencyForResource(resourceId:string,responseStatus:number,responseBody:unknown,updatedAt:string):Promise<number>{const result=await this.pool.query("update task_idempotency_records set status='completed',response_status=$2,response_body=$3::jsonb,updated_at=$4 where resource_id=$1 and status='in_progress'",[resourceId,responseStatus,JSON.stringify(responseBody),updatedAt]);return result.rowCount??0;}

  async persistTaskInteractionMutation(input: PersistTaskInteractionMutationInput): Promise<PersistTaskInteractionMutationResult> {
    return transaction(this.pool, async (client) => {
      const locked = await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update", [input.taskId]);
      const task = locked.rows[0];
      if (!task) throw new Error("Task not found");
      if (input.sourceSync && input.sourceSync.expectedSourceCursor !== undefined && input.sourceSync.expectedSourceCursor !== task.interaction_source_cursor) throw new Error("Task interaction source cursor conflict");
      for (const projection of input.artifactProjections ?? []) {
        if (projection.artifact.taskId !== input.taskId || projection.projectId !== task.project_id) throw new Error("Task interaction artifact mismatch");
        const outcome = await persistTaskArtifactProjectionWithClient(client,projection);
        if (outcome === "limit_exceeded") throw new Error("Project file bytes limit reached");
      }
      const { inserted } = await persistTaskInteractionChangesWithClient(client,input.taskId,input.changes);
      if (input.lifecycle?.kind === "active") {
        const lifecycle = await client.query("update agent_tasks set status=$3,updated_at=$4 where id=$1 and status=$2 and terminal_reason is null", [input.taskId,input.lifecycle.expectedStatus,input.lifecycle.status,input.lifecycle.updatedAt]);
        if (lifecycle.rowCount !== 1) throw new Error("Task interaction lifecycle conflict");
      }
      if (input.lifecycle?.kind === "terminal") {
        const finalized = await finalizeTaskLifecycleWithClient(client, { taskId: input.taskId, ...input.lifecycle });
        if (!finalized || finalized.missingPendingMessageIds.length > 0) throw new Error("Task interaction lifecycle conflict");
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
      const messages = await client.query<TaskMessageRow>("select * from task_messages where task_id=$1 and deleted_at is null and delivery_status in ('pending','dispatching','terminal_pending','failed') order by created_at,id", [taskId]);
      const suppressed = await client.query<{interaction_id:string}>(`select distinct c.interaction_id from task_messages m join task_interaction_changes c on c.task_id=m.task_id and c.source_kind='product' and c.source_id='message:'||m.id where m.task_id=$1 and (m.deleted_at is not null or m.delivery_status in ('pending','dispatching','terminal_pending','failed'))`,[taskId]);
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

  async persistTaskArtifactProjection(input: PersistTaskArtifactProjectionInput): Promise<"created" | "existing" | "limit_exceeded"> {
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
  async createPendingTaskMessage(message:PersistedTaskMessage,interactionChange?:TaskInteractionChangeInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const source=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[message.taskId]);if(!source.rows[0]||source.rows[0].terminal_reason)return null;const created=mapPersistedTaskMessage(await insertPersistedTaskMessageWithClient(client,message));await persistTaskInteractionChangesWithClient(client,message.taskId,interactionChange?[interactionChange]:[]);return created;});}
  async listTaskMessages(taskId: string): Promise<PersistedTaskMessage[]> { const rows=await this.queryRows<TaskMessageRow>("select * from task_messages where task_id=$1 and deleted_at is null order by created_at,id",[taskId]); return rows.map(mapPersistedTaskMessage); }
  async findTaskMessage(id: string): Promise<PersistedTaskMessage | null> { const rows=await this.queryRows<TaskMessageRow>("select * from task_messages where id=$1",[id]);return rows[0]?mapPersistedTaskMessage(rows[0]):null; }
  async updatePendingTaskMessage(id:string,content:string,requestHash:string,updatedAt:string,interactionChange?:TaskInteractionChangeInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const located=await client.query<{task_id:string}>("select task_id from task_messages where id=$1",[id]);if(!located.rows[0])return null;await client.query("select id from agent_tasks where id=$1 for update",[located.rows[0].task_id]);const rows=await client.query<TaskMessageRow>("update task_messages set content=$2,request_hash=$3,updated_at=$4 where id=$1 and delivery_status='pending' and deleted_at is null returning *",[id,content,requestHash,updatedAt]);if(!rows.rows[0])return null;await persistTaskInteractionChangesWithClient(client,rows.rows[0].task_id,interactionChange?[interactionChange]:[]);return mapPersistedTaskMessage(rows.rows[0]);});}
  async deletePendingTaskMessage(id:string,deletedAt:string):Promise<PersistedTaskMessage|null>{const rows=await this.queryRows<TaskMessageRow>("update task_messages set deleted_at=$2,updated_at=$2 where id=$1 and delivery_status='pending' and deleted_at is null returning *",[id,deletedAt]);return rows[0]?mapPersistedTaskMessage(rows[0]):null;}
  async listTaskMessagesDue(now:string,limit:number):Promise<PersistedTaskMessage[]>{const rows=await this.queryRows<TaskMessageRow>(`select * from task_messages where deleted_at is null and ((delivery_status='pending' and (next_retry_at is null or next_retry_at <= $1)) or (delivery_status in ('dispatching','terminal_pending') and lease_expires_at <= $1 and (next_retry_at is null or next_retry_at <= $1))) order by created_at,id limit $2`,[now,limit]);return rows.map(mapPersistedTaskMessage);}
  async claimTaskMessage(input:TaskDeliveryClaimInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const located=await client.query<{task_id:string}>("select task_id from task_messages where id=$1",[input.id]);if(!located.rows[0])return null;const source=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[located.rows[0].task_id]);if(!source.rows[0]||source.rows[0].terminal_reason)return null;const rows=await client.query<TaskMessageRow>(`update task_messages set delivery_status='dispatching',claim_token=$2,claimed_at=$3,lease_expires_at=$4,attempt_count=attempt_count+1,safe_error=null,updated_at=$3 where id=$1 and delivery_status='pending' and claim_token is null and deleted_at is null and (next_retry_at is null or next_retry_at <= $3) returning *`,[input.id,input.claimToken,input.claimedAt,input.leaseExpiresAt]);return rows.rows[0]?mapPersistedTaskMessage(rows.rows[0]):null;});}
  async reclaimTaskMessage(input:TaskDeliveryReclaimInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const located=await client.query<{task_id:string}>("select task_id from task_messages where id=$1",[input.id]);if(!located.rows[0])return null;const source=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update",[located.rows[0].task_id]);if(!source.rows[0]||source.rows[0].terminal_reason)return null;const rows=await client.query<TaskMessageRow>(`update task_messages set claim_token=$3,claimed_at=$4,lease_expires_at=$5,attempt_count=attempt_count+1,safe_error=null,updated_at=$4 where id=$1 and delivery_status='dispatching' and claim_token=$2 and lease_expires_at <= $4 and (next_retry_at is null or next_retry_at <= $4) and deleted_at is null returning *`,[input.id,input.expectedClaimToken,input.claimToken,input.claimedAt,input.leaseExpiresAt]);return rows.rows[0]?mapPersistedTaskMessage(rows.rows[0]):null;});}
  async recordTaskMessageReceipt(input:TaskMessageReceiptInput):Promise<PersistedTaskMessage|null>{const rows=await this.queryRows<TaskMessageRow>(`update task_messages set receipt=$3::jsonb,timeline_cursor=$4,delivery_status='accepted',lease_expires_at=null,next_retry_at=null,safe_error=null,updated_at=$5 where id=$1 and delivery_status in ('dispatching','terminal_pending') and claim_token=$2 and delivery_key=$6 and request_hash=$7 and $8::boolean and deleted_at is null returning *`,[input.id,input.claimToken,JSON.stringify(input.receipt),input.timelineCursor,input.updatedAt,input.receipt.deliveryKey,input.receipt.requestHash,input.receipt.accepted]);return rows[0]?mapPersistedTaskMessage(rows[0]):null;}
  async deferTaskMessage(input:TaskDeliveryDeferInput):Promise<PersistedTaskMessage|null>{const rows=await this.queryRows<TaskMessageRow>(`update task_messages set delivery_status=case when $3 then 'pending' else delivery_status end,claim_token=case when $3 then null else claim_token end,claimed_at=case when $3 then null else claimed_at end,lease_expires_at=case when $3 then null else lease_expires_at end,safe_error=$4,next_retry_at=$5,updated_at=$6 where id=$1 and delivery_status in ('dispatching','terminal_pending') and claim_token=$2 and deleted_at is null returning *`,[input.id,input.claimToken,input.releaseClaim===true,input.safeError,input.nextRetryAt,input.updatedAt]);return rows[0]?mapPersistedTaskMessage(rows[0]):null;}
  async failTaskMessage(input:TaskDeliveryFailureInput):Promise<PersistedTaskMessage|null>{const rows=await this.queryRows<TaskMessageRow>(`update task_messages set delivery_status='failed',safe_error=$3,lease_expires_at=null,updated_at=$4 where id=$1 and delivery_status='dispatching' and claim_token=$2 and deleted_at is null returning *`,[input.id,input.claimToken,input.safeError,input.updatedAt]);return rows[0]?mapPersistedTaskMessage(rows[0]):null;}
  async createTerminalTaskMessage(input:CreateTerminalTaskMessageInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const source=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 and terminal_reason is not null for update",[input.message.taskId]);if(!source.rows[0])return null;if(input.successor.reserveActive&&!await reserveActiveTaskWithClient(client,input.successor.task.projectId,input.successor.task.updatedAt))return null;const successor=await insertTaskWithClient(client,input.successor.task,input.successor.reserveActive);if(input.successor.runtimeState)await putJsonDocumentWithClient(client,"sandbox_runtime_state",successor.id,input.successor.runtimeState);if(input.successor.sandboxRun)await putJsonDocumentWithClient(client,"sandbox_run_state",input.successor.sandboxRun.runId,prepareSandboxRunDocument(input.successor.sandboxRun));const created=mapPersistedTaskMessage(await insertPersistedTaskMessageWithClient(client,{...input.message,targetTaskId:successor.id,deliveryStatus:"successor_created"}));await persistTaskInteractionChangesWithClient(client,input.message.taskId,input.messageInteractionChange?[input.messageInteractionChange]:[]);await persistTaskInteractionChangesWithClient(client,successor.id,input.successorInteractionChange?[input.successorInteractionChange]:[]);return created;});}
  async resolveTerminalPendingMessage(input:ResolveTerminalPendingMessageInput):Promise<PersistedTaskMessage|null>{return transaction(this.pool,async(client)=>{const located=await client.query<{task_id:string}>("select task_id from task_messages where id=$1",[input.messageId]);if(!located.rows[0])return null;const source=await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 and terminal_reason is not null for update",[located.rows[0].task_id]);if(!source.rows[0])return null;const locked=await client.query<TaskMessageRow>("select * from task_messages where id=$1 for update",[input.messageId]);const message=locked.rows[0];if(!message||message.task_id!==located.rows[0].task_id||!["dispatching","terminal_pending"].includes(message.delivery_status)||message.claim_token!==input.expectedClaimToken||asRecord(message.receipt)?.accepted===true)return null;if(input.successor.reserveActive&&!await reserveActiveTaskWithClient(client,input.successor.task.projectId,input.updatedAt))return null;const successor=await insertTaskWithClient(client,input.successor.task,input.successor.reserveActive);if(input.successor.runtimeState)await putJsonDocumentWithClient(client,"sandbox_runtime_state",successor.id,input.successor.runtimeState);if(input.successor.sandboxRun)await putJsonDocumentWithClient(client,"sandbox_run_state",input.successor.sandboxRun.runId,prepareSandboxRunDocument(input.successor.sandboxRun));const updated=await client.query<TaskMessageRow>("update task_messages set target_task_id=$2,delivery_status='successor_created',lease_expires_at=null,next_retry_at=null,safe_error=null,updated_at=$3 where id=$1 and delivery_status in ('dispatching','terminal_pending') and claim_token=$4 returning *",[input.messageId,successor.id,input.updatedAt,input.expectedClaimToken]);if(!updated.rows[0])return null;await persistTaskInteractionChangesWithClient(client,message.task_id,input.messageInteractionChange?[input.messageInteractionChange]:[]);await persistTaskInteractionChangesWithClient(client,successor.id,input.successorInteractionChange?[input.successorInteractionChange]:[]);return mapPersistedTaskMessage(updated.rows[0]);});}
  async findTaskSummary(taskId: string): Promise<TaskSummary | null> { const rows=await this.queryRows<TaskSummaryRow>(`select t.id as task_id,count(a.id)::integer as artifact_count,t.updated_at from agent_tasks t left join agent_task_artifacts a on a.task_id=t.id where t.id=$1 group by t.id,t.updated_at`,[taskId]); return rows[0] ? mapTaskSummary(rows[0]) : null; }
  async listTaskSummariesForProject(projectId: string): Promise<TaskSummary[]> { const rows=await this.queryRows<TaskSummaryRow>(`select t.id as task_id,count(a.id)::integer as artifact_count,t.updated_at from agent_tasks t left join agent_task_artifacts a on a.task_id=t.id where t.project_id=$1 and t.deleted_at is null group by t.id,t.updated_at order by t.updated_at desc,t.id desc`,[projectId]); return rows.map(mapTaskSummary); }

  private async claimTaskStage(stage:"artifact"|"cleanup",input:TaskStageClaimInput):Promise<PersistedAgentTask|null>{const prefix=stage==="artifact"?"artifact_projection":"cleanup";const allowed=stage==="artifact"?"('draining','failed')":"('pending','running','failed')";const extra=stage==="artifact"?"terminal_reason is not null":"terminal_reason is not null and artifact_projection_status='drained'";const rows=await this.queryRows<AgentTaskRow>(`update agent_tasks set ${prefix}_status=${stage==="artifact"?"'draining'":"'running'"},${prefix}_claim_token=$2,${prefix}_lease_expires_at=$4,${prefix}_attempt_count=${prefix}_attempt_count+1,${stage==="artifact"?"artifact_projection_error":"cleanup_error"}=null,updated_at=$3 where id=$1 and ${extra} and ${prefix}_status in ${allowed} and (${prefix}_lease_expires_at is null or ${prefix}_lease_expires_at <= $3) and (${prefix}_next_retry_at is null or ${prefix}_next_retry_at <= $3) returning *`,[input.id,input.claimToken,input.claimedAt,input.leaseExpiresAt]);return rows[0]?mapTask(rows[0]):null;}
  private async completeTaskStage(stage:"artifact"|"cleanup",input:TaskStageCompleteInput):Promise<PersistedAgentTask|null>{return transaction(this.pool,async(client)=>{const rows=await completeTaskStageWithClient(client,stage,input);return rows[0]?mapTask(rows[0]):null;});}
  private async failTaskStage(stage:"artifact"|"cleanup",input:TaskStageFailureInput):Promise<PersistedAgentTask|null>{const prefix=stage==="artifact"?"artifact_projection":"cleanup";const error=stage==="artifact"?"artifact_projection_error":"cleanup_error";const current=stage==="artifact"?"draining":"running";const rows=await this.queryRows<AgentTaskRow>(`update agent_tasks set ${prefix}_status='failed',${prefix}_claim_token=null,${prefix}_lease_expires_at=null,${prefix}_next_retry_at=$4,${error}=$3,updated_at=$5 where id=$1 and ${prefix}_status='${current}' and ${prefix}_claim_token=$2 returning *`,[input.id,input.claimToken,input.safeError,input.nextRetryAt,input.updatedAt]);return rows[0]?mapTask(rows[0]):null;}

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
    await this.pool.query(
      `insert into postgres_json_docs (collection, id, document, updated_at)
       values ('sandbox_run_state', $1, $2::jsonb, now())
       on conflict (collection, id)
       do update set document = excluded.document, updated_at = now()`,
      [run.runId, JSON.stringify(document)]
    );
    return sandboxRunFromDocument(document);
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
         'phase', case
           when coalesce(document->>'phase', '') = 'expired'
             or nullif(document->>'expiresAt', '')::timestamptz <= $3::timestamptz
             or nullif(document->>'idleExpiresAt', '')::timestamptz <= $3::timestamptz
           then 'expired'
           else 'stopping'
         end,
         'cleanupStatus', 'deleting',
         'fencingToken', $2 + 1,
         'updatedAt', $3
       ), updated_at = now()
       where collection = 'sandbox_run_state'
         and id = $1
         and (document->>'fencingToken')::bigint = $2
         and coalesce(document->>'cleanupStatus', '') <> 'cleaned'
         and coalesce(document->>'phase', '') <> 'cleaned'
         and (
           coalesce(document->>'cleanupStatus', '') in ('cleanup_requested', 'deleting')
           or coalesce(document->>'phase', '') in ('stopping', 'expired')
           or nullif(document->>'expiresAt', '')::timestamptz <= $3::timestamptz
           or nullif(document->>'idleExpiresAt', '')::timestamptz <= $3::timestamptz
         )
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
    const result = await this.pool.query(
      `update postgres_json_docs
       set document = $3::jsonb, updated_at = now()
       where collection = 'sandbox_run_state'
         and id = $1
         and (document->>'fencingToken')::bigint = $2
       returning document`,
      [runId, expectedFencingToken, JSON.stringify(document)]
    );
    const saved = result.rows[0]?.document as unknown;
    return saved ? sandboxRunFromDocument(asRecord(saved)) : null;
  }
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

async function releaseActiveTaskWithClient(client: PoolClient, projectId: string, updatedAt: string): Promise<void> {
  await client.query("update project_resource_usage set active_tasks=greatest(0,active_tasks-1),updated_at=$2 where project_id=$1",[projectId,updatedAt]);
}

async function putJsonDocumentWithClient(client: PoolClient, collection: JsonDocumentCollection, id: string, document: Record<string, unknown>): Promise<void> {
  await client.query(`insert into postgres_json_docs (collection,id,document,updated_at) values ($1,$2,$3::jsonb,now()) on conflict (collection,id) do update set document=excluded.document,updated_at=excluded.updated_at`,[collection,id,JSON.stringify(document)]);
}

async function insertAuditEventWithClient(client: PoolClient, event: ProjectAuditEvent): Promise<void> {
  await client.query(
    "insert into project_audit_events (id,project_id,actor_id,action,status,resource_kind,resource_id,detail,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) on conflict (id) do nothing",
    [event.id,event.projectId,event.actorId,event.action,event.status,event.resourceKind,event.resourceId,JSON.stringify(sanitizeProjectAuditDetail(event.detail)),event.createdAt]
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

async function finalizeTaskLifecycleWithClient(client: PoolClient, input: FinalizeTaskLifecycleInput): Promise<FinalizeTaskLifecycleResult | null> {
  const locked = await client.query<AgentTaskRow>("select * from agent_tasks where id=$1 for update", [input.taskId]);
  const current = locked.rows[0];
  if (!current) return null;
  if (current.terminal_reason) return { task: mapTask(current), applied: false, successorTaskIds: [], missingPendingMessageIds: [] };
  const messages = await client.query<TaskMessageRow>("select * from task_messages where task_id=$1 and deleted_at is null and delivery_status in ('pending','dispatching','terminal_pending') order by created_at,id for update", [input.taskId]);
  const candidates = new Map(input.successors.map((candidate) => [candidate.messageId, candidate]));
  const terminalPendingChanges = new Map((input.terminalPendingChanges??[]).map((candidate)=>[candidate.messageId,candidate.interactionChange]));
  const missingPendingMessageIds = messages.rows.filter((row) => row.delivery_status === "pending" && (!candidates.has(row.id) || candidates.get(row.id)!.create.task.prompt !== row.content)).map((row) => row.id);
  if (missingPendingMessageIds.length > 0) return { task: mapTask(current), applied: false, successorTaskIds: [], missingPendingMessageIds };
  if (current.active_reservation) await releaseActiveTaskWithClient(client, current.project_id, input.updatedAt);
  const successorTaskIds: string[] = [];
  for (const message of messages.rows) {
    if (message.delivery_status === "dispatching") {
      await client.query("update task_messages set delivery_status='terminal_pending',updated_at=$2 where id=$1", [message.id,input.updatedAt]);
      const interactionChange=terminalPendingChanges.get(message.id);
      await persistTaskInteractionChangesWithClient(client,input.taskId,interactionChange?[interactionChange]:[]);
      continue;
    }
    if (message.delivery_status !== "pending") continue;
    const candidate = candidates.get(message.id)!;
    if (candidate.create.reserveActive && !await reserveActiveTaskWithClient(client, candidate.create.task.projectId, input.updatedAt)) {
      await client.query("update task_messages set delivery_status='failed',safe_error='Project active tasks limit reached',updated_at=$2 where id=$1", [message.id,input.updatedAt]);
      await persistTaskInteractionChangesWithClient(client,input.taskId,candidate.messageFailureInteractionChange?[candidate.messageFailureInteractionChange]:[]);
      continue;
    }
    const successor = await insertTaskWithClient(client, candidate.create.task, candidate.create.reserveActive);
    if (candidate.create.runtimeState) await putJsonDocumentWithClient(client,"sandbox_runtime_state",candidate.create.task.id,candidate.create.runtimeState);
    if (candidate.create.sandboxRun) await putJsonDocumentWithClient(client,"sandbox_run_state",candidate.create.sandboxRun.runId,prepareSandboxRunDocument(candidate.create.sandboxRun));
    await client.query("update task_messages set target_task_id=$2,delivery_status='successor_created',safe_error=null,updated_at=$3 where id=$1", [message.id,successor.id,input.updatedAt]);
    await persistTaskInteractionChangesWithClient(client,input.taskId,candidate.messageSuccessInteractionChange?[candidate.messageSuccessInteractionChange]:[]);
    await persistTaskInteractionChangesWithClient(client,successor.id,candidate.successorInteractionChange?[candidate.successorInteractionChange]:[]);
    successorTaskIds.push(successor.id);
  }
  const terminal = await client.query<AgentTaskRow>(`update agent_tasks set status=$2,terminal_reason=$3,terminalized_at=$4::timestamptz,active_reservation=false,finalization_intent_status=null,finalization_intent_at=null,artifact_projection_status=case when execution_mode='live' then 'draining' else 'drained' end,artifact_projection_error=null,cleanup_status=case when execution_mode='live' then 'pending' else 'completed' end,cleanup_error=null,cleanup_completed_at=case when execution_mode='live' then null else $4::timestamptz end,updated_at=$4::timestamptz where id=$1 and terminal_reason is null returning *`, [input.taskId,statusForTerminalReason(input.terminalReason),input.terminalReason,input.updatedAt]);
  const row = terminal.rows[0];
  if (!row) return { task: mapTask(current), applied: false, successorTaskIds: [], missingPendingMessageIds: [] };
  await insertAuditEventWithClient(client,input.auditEvent);
  return { task: mapTask(row), applied: true, successorTaskIds, missingPendingMessageIds: [] };
}

async function persistTaskArtifactProjectionWithClient(client:PoolClient,input:PersistTaskArtifactProjectionInput):Promise<"created"|"existing"|"limit_exceeded"> {
  const existing=await client.query("select id from agent_task_artifacts where task_id=$1 and file_id=$2",[input.artifact.taskId,input.artifact.fileId]);
  if(existing.rowCount){await insertAuditEventWithClient(client,input.auditEvent);return "existing";}
  const usage=await client.query(`update project_resource_usage u set project_file_bytes=u.project_file_bytes+$2,updated_at=$3 from project_resource_policies p where u.project_id=$1 and p.project_id=u.project_id and (p.project_file_bytes_limit is null or u.project_file_bytes+$2 <= p.project_file_bytes_limit) returning u.project_id`,[input.projectId,input.artifact.bytes,input.updatedAt]);
  if(!usage.rowCount)return "limit_exceeded";
  await client.query(`insert into agent_task_artifacts (id,task_id,file_id,name,bytes,sha256,media_type,preview_text,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[input.artifact.id,input.artifact.taskId,input.artifact.fileId,input.artifact.name,input.artifact.bytes,input.artifact.sha256??null,input.artifact.mediaType??null,input.artifact.previewText??null,input.artifact.createdAt]);
  await insertAuditEventWithClient(client,input.auditEvent);
  return "created";
}

async function insertTaskWithClient(client: PoolClient, task: PersistedAgentTask, activeReservation: boolean): Promise<AgentTaskRow> {
  const columns = [
    "id","workspace_id","project_id","endpoint_id","created_by_user_id","title","prompt","agent_context","input_paths","status","run_id","source_task_id","execution_mode","active_reservation","archived_at","deleted_at","terminal_reason","terminalized_at",
    "start_delivery_key","start_request_hash","start_claim_token","start_receipt","start_timeline_cursor","start_intent_status","start_claimed_at","start_lease_expires_at","start_attempt_count","start_next_retry_at","start_safe_error",
    "interaction_source_cursor","interaction_history_status","interaction_last_synced_at",
    "artifact_projection_status","artifact_projection_error","artifact_projection_claim_token","artifact_projection_lease_expires_at","artifact_projection_attempt_count","artifact_projection_next_retry_at",
    "cleanup_status","cleanup_error","cleanup_claim_token","cleanup_lease_expires_at","cleanup_attempt_count","cleanup_next_retry_at","cleanup_completed_at","sandbox","finalization_intent_status","finalization_intent_at","created_at","updated_at"
  ];
  const values: unknown[] = [
    task.id,task.workspaceId,task.projectId,task.endpointId,task.createdByUserId??null,task.title ?? task.prompt.replace(/[\r\n]+/g," ").slice(0,160),task.prompt,task.agentContext??"",JSON.stringify(task.inputPaths ?? []),task.status,task.runId,task.sourceTaskId ?? null,task.executionMode,activeReservation,task.archivedAt ?? null,task.deletedAt ?? null,task.terminalReason ?? null,task.terminalizedAt ?? null,
    task.startDeliveryKey ?? null,task.startRequestHash ?? null,task.startClaimToken ?? null,task.startReceipt ? JSON.stringify(task.startReceipt) : null,task.startTimelineCursor ?? null,task.startIntentStatus ?? null,task.startClaimedAt ?? null,task.startLeaseExpiresAt ?? null,task.startAttemptCount ?? 0,task.startNextRetryAt ?? null,task.startSafeError ?? null,
    null,"complete",null,
    task.artifactProjectionStatus ?? "pending",task.artifactProjectionError ?? null,task.artifactProjectionClaimToken ?? null,task.artifactProjectionLeaseExpiresAt ?? null,task.artifactProjectionAttemptCount ?? 0,task.artifactProjectionNextRetryAt ?? null,
    task.cleanupStatus ?? "pending",task.cleanupError ?? null,task.cleanupClaimToken ?? null,task.cleanupLeaseExpiresAt ?? null,task.cleanupAttemptCount ?? 0,task.cleanupNextRetryAt ?? null,task.cleanupCompletedAt ?? null,JSON.stringify(task.sandbox),task.finalizationIntentStatus ?? null,task.finalizationIntentAt ?? null,task.createdAt,task.updatedAt
  ];
  const jsonColumns = new Set(["input_paths","start_receipt","sandbox"]);
  const placeholders = columns.map((column,index) => `$${index+1}${jsonColumns.has(column)?"::jsonb":""}`);
  const inserted = await client.query<AgentTaskRow>(`insert into agent_tasks (${columns.join(",")}) values (${placeholders.join(",")}) returning *`,values);
  return inserted.rows[0]!;
}

async function insertPersistedTaskMessageWithClient(client: PoolClient, message: PersistedTaskMessage): Promise<TaskMessageRow> {
  const inserted = await client.query<TaskMessageRow>(`insert into task_messages (id,task_id,actor_id,content,target_task_id,delivery_key,request_hash,claim_token,receipt,timeline_cursor,delivery_status,claimed_at,lease_expires_at,attempt_count,next_retry_at,safe_error,created_at,updated_at,deleted_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning *`,[
    message.id,message.taskId,message.actorId??null,message.content,message.targetTaskId??null,message.deliveryKey??null,message.requestHash??null,message.claimToken??null,message.receipt?JSON.stringify(message.receipt):null,message.timelineCursor??null,message.deliveryStatus??"pending",message.claimedAt??null,message.leaseExpiresAt??null,message.attemptCount??0,message.nextRetryAt??null,message.safeError??null,message.createdAt,message.updatedAt??message.createdAt,message.deletedAt??null
  ]);
  return inserted.rows[0]!;
}

async function completeTaskStageWithClient(client: PoolClient, stage: "artifact" | "cleanup", input: TaskStageCompleteInput): Promise<AgentTaskRow[]> {
  const prefix=stage==="artifact"?"artifact_projection":"cleanup";
  const current=stage==="artifact"?"draining":"running";
  const completed=stage==="artifact"?"drained":"completed";
  const completedAt=stage==="cleanup"?",cleanup_completed_at=$3":"";
  const result=await client.query<AgentTaskRow>(`update agent_tasks set ${prefix}_status='${completed}',${prefix}_claim_token=null,${prefix}_lease_expires_at=null,${prefix}_next_retry_at=null,${stage==="artifact"?"artifact_projection_error":"cleanup_error"}=null${completedAt},updated_at=$3 where id=$1 and ${prefix}_status='${current}' and ${prefix}_claim_token=$2 returning *`,[input.id,input.claimToken,input.updatedAt]);
  return result.rows;
}

function statusForTerminalReason(reason: import("../../contracts/src/api.js").TaskTerminalReason): AgentTask["status"] {
  if(reason==="cancelled")return "cancelled";
  if(reason==="failed")return "failed";
  if(reason==="expired")return "expired";
  if(reason==="cleaned_legacy")return "cleaned";
  return "completed";
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
  created_by_user_id: string | null;
  title: string;
  prompt: string;
  agent_context: string | null;
  input_paths: unknown;
  status: AgentTask["status"];
  run_id: string;
  source_task_id: string | null;
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
interface ProjectChatThreadRow { id: string; project_id: string; endpoint_id: string | null; title: string | null; pinned_at: unknown; starred_at: unknown; deleted_at: unknown; created_at: unknown; updated_at: unknown; }
interface ProjectChatMessageRow { sequence: string | number; id: string; thread_id: string; role: ProjectChatMessage["role"]; content: string; version: number; delivery_status: ProjectChatMessage["deliveryStatus"]; created_at: unknown; updated_at: unknown; }
interface TaskMessageRow { id:string; task_id:string; actor_id:string|null; content:string; target_task_id:string|null; delivery_key:string|null; request_hash:string|null; claim_token:string|null; receipt:unknown; timeline_cursor:string|null; delivery_status:NonNullable<PersistedTaskMessage["deliveryStatus"]>; claimed_at:unknown; lease_expires_at:unknown; attempt_count:number; next_retry_at:unknown; safe_error:string|null; created_at:unknown; updated_at:unknown; deleted_at:unknown; }
interface TaskInteractionChangeRow { task_id:string; change_seq:string|number; source_kind:PersistedTaskInteractionChange["sourceKind"]; source_id:string; source_revision:string|number; interaction_id:string; revision:number; position:string|number; interaction_kind:TaskInteractionItem["kind"]; interaction:unknown; tool_call_id:string|null; work_task_id:string|null; callback_id:string|null; occurred_at:unknown; updated_at:unknown; }
interface TaskIdempotencyRow { actor_id:string;project_id:string;operation:string;idempotency_key:string;request_hash:string;resource_id:string;status:"in_progress"|"completed";claim_token:string;lease_expires_at:unknown;response_status:number|null;response_body:unknown;created_at:unknown;updated_at:unknown; }
interface TaskSummaryRow { task_id:string; artifact_count:number; updated_at:unknown; }
interface ProjectPolicyRow { project_id: string; active_tasks_limit: number | null; provider_requests_limit: string | number | null; provider_tokens_limit: string | number | null; provider_cost_limit: number | null; project_file_bytes_limit: string | number | null; created_at: unknown; updated_at: unknown; }
interface ProjectUsageRow { project_id: string; active_tasks: number; provider_requests: string | number; provider_tokens: string | number; provider_cost: number; project_file_bytes: string | number; updated_at: unknown; }
interface ProjectProviderSettlementRow extends ProjectUsageRow { provider_tokens_exceeded: boolean; provider_cost_exceeded: boolean; }
interface ProjectAlertRow { id: string; project_id: string; type: ProjectAlert["type"]; status: ProjectAlert["status"]; delivery_status: ProjectAlert["deliveryStatus"]; rule_id:string|null;metric:import("../../contracts/src/api.js").AlertRuleMetric|null;metric_value:number|null;threshold:number|null;endpoint_id:string|null;acknowledged_at:unknown;acknowledged_by:string|null;silenced_until:unknown; created_at: unknown; updated_at: unknown; resolved_at: unknown; dismissed_at: unknown; }
interface ProjectAuditRow { id: string; project_id: string; actor_id: string | null; action: ProjectAuditEvent["action"]; status: ProjectAuditEvent["status"]; resource_kind: ProjectAuditEvent["resourceKind"]; resource_id: string | null; detail:ProjectAuditEvent["detail"]; created_at: unknown; }

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
    createdByUserId: row.created_by_user_id,
    title: row.title,
    prompt: row.prompt,
    agentContext: row.agent_context ?? "",
    inputPaths: asArray(row.input_paths).filter((value): value is string => typeof value === "string"),
    status: row.status,
    runId: row.run_id,
    sourceTaskId: row.source_task_id,
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
    sandbox: asRecord(row.sandbox) as unknown as AgentTask["sandbox"],
    finalizationIntentStatus: row.finalization_intent_status ?? null,
    finalizationIntentAt: row.finalization_intent_at ? toIso(row.finalization_intent_at) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function mapProfile(row: ProfileRow): UserProfilePreferences { return { userId: row.user_id, displayName: row.display_name, timezone: row.timezone, bio:row.bio, jobTitle:row.job_title, company:row.company, greetingPreference:row.greeting_preference, interests:row.interests??[], updatedAt: toIso(row.updated_at) }; }
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
function mapChatThread(row: ProjectChatThreadRow): ProjectChatThread { return { id: row.id, projectId: row.project_id, endpointId: row.endpoint_id, title: row.title ?? null, pinnedAt: row.pinned_at ? toIso(row.pinned_at) : null, starredAt: row.starred_at ? toIso(row.starred_at) : null, deletedAt: row.deleted_at ? toIso(row.deleted_at) : null, createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at) }; }
function mapChatMessage(row: ProjectChatMessageRow): ProjectChatMessage { return { id: row.id, threadId: row.thread_id, sequence:Number(row.sequence),role: row.role, content: row.content,version:row.version,deliveryStatus:row.delivery_status,createdAt: toIso(row.created_at),updatedAt:toIso(row.updated_at) }; }
function mapPersistedTaskMessage(row: TaskMessageRow): PersistedTaskMessage { return { id:row.id, taskId:row.task_id, actorId:row.actor_id, content:row.content, targetTaskId:row.target_task_id, deliveryKey:row.delivery_key, requestHash:row.request_hash, claimToken:row.claim_token, receipt:mapTaskDeliveryReceipt(row.receipt), timelineCursor:row.timeline_cursor, deliveryStatus:row.delivery_status, claimedAt:row.claimed_at?toIso(row.claimed_at):null, leaseExpiresAt:row.lease_expires_at?toIso(row.lease_expires_at):null, attemptCount:row.attempt_count??0, nextRetryAt:row.next_retry_at?toIso(row.next_retry_at):null, safeError:row.safe_error, createdAt:toIso(row.created_at), updatedAt:toIso(row.updated_at), deletedAt:row.deleted_at?toIso(row.deleted_at):null }; }
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
function mapTaskSummary(row: TaskSummaryRow): TaskSummary { return { taskId:row.task_id,artifactCount:Number(row.artifact_count),updatedAt:toIso(row.updated_at) }; }

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
function mapAudit(row: ProjectAuditRow): ProjectAuditEvent { return { id: row.id, projectId: row.project_id, actorId: row.actor_id, action: row.action, status: row.status, resourceKind: row.resource_kind, resourceId: row.resource_id,detail:row.detail??{}, createdAt: toIso(row.created_at) }; }
function nullableNumber(value: string | number | null): number | null { return value === null ? null : Number(value); }

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
