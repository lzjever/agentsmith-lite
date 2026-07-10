import { createRequire } from "node:module";
import type {
  AgentTask,
  AgentTaskArtifact,
  AgentTaskEvent,
  AuthSession,
  EndpointCapability,
  EndpointProtocol,
  ModelEndpoint,
  Project,
  StoredUser,
  User,
  UserRole,
  Workspace
} from "../../contracts/src/api.js";
import type {
  AcquireLeaseInput,
  AcquireLeaseResult,
  JsonDocumentCollection,
  LeaseRecord,
  PostgresJsonDocStore,
  PostgresLeaseStore,
  PersistedSandboxRunState,
  ProductStore
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
      `insert into users (id, email, role, password_hash, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [user.id, user.email, user.role, user.passwordHash, user.createdAt, user.updatedAt]
    );
    return publicUser(user);
  }

  async updateUser(user: StoredUser): Promise<User> {
    await this.pool.query(
      `update users
          set email = $2,
              role = $3,
              password_hash = $4,
              created_at = $5,
              updated_at = $6
        where id = $1`,
      [user.id, user.email, user.role, user.passwordHash, user.createdAt, user.updatedAt]
    );
    return publicUser(user);
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
    await this.pool.query(
      `insert into workspaces (id, name, owner_user_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5)`,
      [workspace.id, workspace.name, workspace.ownerUserId, workspace.createdAt, workspace.updatedAt]
    );
    return structuredClone(workspace);
  }

  async listWorkspacesForUser(userId: string): Promise<Workspace[]> {
    const rows = await this.queryRows<WorkspaceRow>(
      `select * from workspaces where owner_user_id = $1 order by created_at, id`,
      [userId]
    );
    return rows.map(mapWorkspace);
  }

  async findWorkspace(id: string): Promise<Workspace | null> {
    const rows = await this.queryRows<WorkspaceRow>("select * from workspaces where id = $1", [id]);
    return rows[0] ? mapWorkspace(rows[0]) : null;
  }

  async createProject(project: Project): Promise<Project> {
    await this.pool.query(
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

  async createEndpoint(endpoint: ModelEndpoint): Promise<ModelEndpoint> {
    await this.pool.query(
      `insert into model_endpoints (
         id, project_id, name, protocol, base_url, model, api_key_secret_ref,
         capabilities, request_timeout_secs, created_at, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
      [
        endpoint.id,
        endpoint.projectId,
        endpoint.name,
        endpoint.protocol,
        endpoint.baseUrl,
        endpoint.model,
        endpoint.apiKeySecretRef,
        JSON.stringify(endpoint.capabilities),
        endpoint.requestTimeoutSecs,
        endpoint.createdAt,
        endpoint.updatedAt
      ]
    );
    return structuredClone(endpoint);
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

  async createTask(task: AgentTask): Promise<AgentTask> {
    await this.pool.query(
      `insert into agent_tasks (
         id, workspace_id, project_id, endpoint_id, prompt, status, run_id, sandbox, created_at, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        task.id,
        task.workspaceId,
        task.projectId,
        task.endpointId,
        task.prompt,
        task.status,
        task.runId,
        JSON.stringify(task.sandbox),
        task.createdAt,
        task.updatedAt
      ]
    );
    return structuredClone(task);
  }

  async updateTask(task: AgentTask): Promise<AgentTask> {
    await this.pool.query(
      `update agent_tasks
       set workspace_id = $2,
           project_id = $3,
           endpoint_id = $4,
           prompt = $5,
           status = $6,
           run_id = $7,
           sandbox = $8::jsonb,
           created_at = $9,
           updated_at = $10
       where id = $1`,
      [
        task.id,
        task.workspaceId,
        task.projectId,
        task.endpointId,
        task.prompt,
        task.status,
        task.runId,
        JSON.stringify(task.sandbox),
        task.createdAt,
        task.updatedAt
      ]
    );
    return structuredClone(task);
  }

  async updateTaskStatusIfNonterminal(taskId: string, status: AgentTask["status"], updatedAt: string): Promise<AgentTask | null> {
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

  async listActiveTasks(): Promise<AgentTask[]> {
    const rows = await this.queryRows<AgentTaskRow>(
      `select * from agent_tasks
       where status in ('queued', 'starting', 'running', 'stopping')
       order by created_at, id`
    );
    return rows.map(mapTask);
  }

  async listTasksForProject(projectId: string): Promise<AgentTask[]> {
    const rows = await this.queryRows<AgentTaskRow>(
      `select * from agent_tasks where project_id = $1 order by created_at, id`,
      [projectId]
    );
    return rows.map(mapTask);
  }

  async findTask(id: string): Promise<AgentTask | null> {
    const rows = await this.queryRows<AgentTaskRow>("select * from agent_tasks where id = $1", [id]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async appendTaskEvents(events: AgentTaskEvent[]): Promise<void> {
    for (const event of events) {
      await this.pool.query(
        `insert into agent_task_events (
           id, task_id, kind, cursor, botified_seq, botified_type, session_id, payload, created_at
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         on conflict (task_id, cursor) do nothing`,
        [
          event.id,
          event.taskId,
          event.kind,
          event.cursor,
          event.botifiedSeq,
          event.botifiedType,
          event.sessionId,
          JSON.stringify(event.payload),
          event.createdAt
        ]
      );
    }
  }

  async listTaskEvents(taskId: string): Promise<AgentTaskEvent[]> {
    const rows = await this.queryRows<AgentTaskEventRow>(
      `select * from agent_task_events where task_id = $1 order by botified_seq, created_at, id`,
      [taskId]
    );
    return rows.map(mapTaskEvent);
  }

  async appendTaskArtifacts(artifacts: AgentTaskArtifact[]): Promise<void> {
    for (const artifact of artifacts) {
      await this.pool.query(
        `insert into agent_task_artifacts (id, task_id, file_id, name, bytes, sha256, created_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (task_id, file_id) do nothing`,
        [
          artifact.id,
          artifact.taskId,
          artifact.fileId,
          artifact.name,
          artifact.bytes,
          artifact.sha256 ?? null,
          artifact.createdAt
        ]
      );
    }
  }

  async listTaskArtifacts(taskId: string): Promise<AgentTaskArtifact[]> {
    const rows = await this.queryRows<AgentTaskArtifactRow>(
      `select * from agent_task_artifacts where task_id = $1 order by created_at, id`,
      [taskId]
    );
    return rows.map(mapTaskArtifact);
  }

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

async function transaction<T>(pool: PgPool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
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

interface UserRow {
  id: string;
  email: string;
  role: string;
  password_hash: string;
  created_at: unknown;
  updated_at: unknown;
}

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
  created_at: unknown;
  updated_at: unknown;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  owner_user_id: string;
  root_path: string;
  task_concurrency_limit: number;
  created_at: unknown;
  updated_at: unknown;
}

interface ModelEndpointRow {
  id: string;
  project_id: string;
  name: string;
  protocol: string;
  base_url: string;
  model: string;
  api_key_secret_ref: string;
  capabilities: unknown;
  request_timeout_secs: number;
  created_at: unknown;
  updated_at: unknown;
}

interface AgentTaskRow {
  id: string;
  workspace_id: string;
  project_id: string;
  endpoint_id: string;
  prompt: string;
  status: AgentTask["status"];
  run_id: string;
  sandbox: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface AgentTaskEventRow {
  id: string;
  task_id: string;
  kind: AgentTaskEvent["kind"];
  cursor: string;
  botified_seq: number;
  botified_type: string;
  session_id: string;
  payload: unknown;
  created_at: unknown;
}

interface AgentTaskArtifactRow {
  id: string;
  task_id: string;
  file_id: string;
  name: string;
  bytes: number;
  sha256: string | null;
  created_at: unknown;
}

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
    role: row.role as UserRole,
    passwordHash: row.password_hash,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

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
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function mapEndpoint(row: ModelEndpointRow): ModelEndpoint {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    protocol: row.protocol as EndpointProtocol,
    baseUrl: row.base_url,
    model: row.model,
    apiKeySecretRef: row.api_key_secret_ref,
    capabilities: asArray(row.capabilities) as EndpointCapability[],
    requestTimeoutSecs: row.request_timeout_secs,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function mapTask(row: AgentTaskRow): AgentTask {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    endpointId: row.endpoint_id,
    prompt: row.prompt,
    status: row.status,
    runId: row.run_id,
    sandbox: asRecord(row.sandbox) as unknown as AgentTask["sandbox"],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function mapTaskEvent(row: AgentTaskEventRow): AgentTaskEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    cursor: row.cursor,
    botifiedSeq: row.botified_seq,
    botifiedType: row.botified_type,
    sessionId: row.session_id,
    payload: asRecord(row.payload),
    createdAt: toIso(row.created_at)
  };
}

function mapTaskArtifact(row: AgentTaskArtifactRow): AgentTaskArtifact {
  const artifact: AgentTaskArtifact = {
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
  return artifact;
}

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
