import type {
  AgentTask,
  AgentTaskArtifact,
  AgentTaskEvent,
  AuthSession,
  ModelEndpoint,
  Project,
  StoredUser,
  User,
  Workspace
} from "../../contracts/src/api.js";

export type JsonDocumentCollection =
  | "project_settings"
  | "endpoint_snapshots"
  | "sandbox_runtime_state"
  | "sandbox_run_state"
  | "operator_status";

export interface PostgresJsonDocStore {
  put(collection: JsonDocumentCollection, id: string, document: Record<string, unknown>): Promise<void>;
  get(collection: JsonDocumentCollection, id: string): Promise<Record<string, unknown> | null>;
  delete(collection: JsonDocumentCollection, id: string): Promise<void>;
}

export type PersistedSandboxRunPhase = "queued" | "starting" | "running" | "stopping" | "expired" | "cleaned";
export type PersistedSandboxCleanupStatus = "active" | "cleanup_requested" | "deleting" | "cleaned";

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
  botifiedPort: number;
  resourceNames: PersistedSandboxRunResourceNames;
  serviceKeySecretRef: {
    name: string;
    key: string;
  };
  directories: {
    taskHome: string;
    artifacts: string;
    botified: string;
  };
  resourceLimits: {
    cpuRequest: string;
    memoryRequest: string;
    cpuLimit: string;
    memoryLimit: string;
  };
  expiresAt?: string | null;
  idleExpiresAt?: string | null;
  timelineCursor?: string | null;
  fencingToken: number;
  cleanupStatus: PersistedSandboxCleanupStatus;
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

export interface SandboxRunStore {
  put(run: PersistedSandboxRunState): Promise<PersistedSandboxRunState>;
  get(runId: string): Promise<PersistedSandboxRunState | null>;
  list(): Promise<PersistedSandboxRunState[]>;
  listActive(): Promise<PersistedSandboxRunState[]>;
  updateWithFencing(
    runId: string,
    expectedFencingToken: number,
    run: PersistedSandboxRunState
  ): Promise<PersistedSandboxRunState | null>;
}

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

export interface ProductStore {
  readonly observedExternalModelCalls: number;
  readonly jsonDocs: PostgresJsonDocStore;
  readonly leases: PostgresLeaseStore;
  readonly sandboxRuns: SandboxRunStore;

  countUsers(): Promise<number>;
  createUser(user: StoredUser): Promise<User>;
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findUserById(id: string): Promise<StoredUser | null>;

  createSession(session: AuthSession): Promise<AuthSession>;
  findSession(id: string): Promise<AuthSession | null>;

  createWorkspace(workspace: Workspace): Promise<Workspace>;
  listWorkspacesForUser(userId: string): Promise<Workspace[]>;
  findWorkspace(id: string): Promise<Workspace | null>;

  createProject(project: Project): Promise<Project>;
  listProjectsForWorkspace(workspaceId: string): Promise<Project[]>;
  findProject(id: string): Promise<Project | null>;

  createEndpoint(endpoint: ModelEndpoint): Promise<ModelEndpoint>;
  listEndpointsForProject(projectId: string): Promise<ModelEndpoint[]>;
  findEndpoint(id: string): Promise<ModelEndpoint | null>;

  createTask(task: AgentTask): Promise<AgentTask>;
  updateTask(task: AgentTask): Promise<AgentTask>;
  listActiveTasks(): Promise<AgentTask[]>;
  listTasksForProject(projectId: string): Promise<AgentTask[]>;
  findTask(id: string): Promise<AgentTask | null>;
  appendTaskEvents(events: AgentTaskEvent[]): Promise<void>;
  listTaskEvents(taskId: string): Promise<AgentTaskEvent[]>;
  appendTaskArtifacts(artifacts: AgentTaskArtifact[]): Promise<void>;
  listTaskArtifacts(taskId: string): Promise<AgentTaskArtifact[]>;
}
