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
import type {
  AcquireLeaseInput,
  AcquireLeaseResult,
  JsonDocumentCollection,
  LeaseRecord,
  PostgresJsonDocStore,
  PostgresLeaseStore,
  ProductStore
} from "../../ports/src/store.js";

export function createInMemoryProductStore(): InMemoryProductStore {
  return new InMemoryProductStore();
}

export class InMemoryProductStore implements ProductStore {
  observedExternalModelCalls = 0;

  readonly jsonDocs: PostgresJsonDocStore = new InMemoryJsonDocStore();
  readonly leases: PostgresLeaseStore = new InMemoryLeaseStore();

  private readonly users = new Map<string, StoredUser>();
  private readonly sessions = new Map<string, AuthSession>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly projects = new Map<string, Project>();
  private readonly endpoints = new Map<string, ModelEndpoint>();
  private readonly tasks = new Map<string, AgentTask>();
  private readonly events: AgentTaskEvent[] = [];
  private readonly artifacts: AgentTaskArtifact[] = [];

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async createUser(user: StoredUser): Promise<User> {
    this.users.set(user.id, clone(user));
    return publicUser(user);
  }

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const normalized = email.toLowerCase();
    return clone([...this.users.values()].find((user) => user.email.toLowerCase() === normalized) ?? null);
  }

  async findUserById(id: string): Promise<StoredUser | null> {
    return clone(this.users.get(id) ?? null);
  }

  async createSession(session: AuthSession): Promise<AuthSession> {
    this.sessions.set(session.id, clone(session));
    return clone(session);
  }

  async findSession(id: string): Promise<AuthSession | null> {
    return clone(this.sessions.get(id) ?? null);
  }

  async createWorkspace(workspace: Workspace): Promise<Workspace> {
    this.workspaces.set(workspace.id, clone(workspace));
    return clone(workspace);
  }

  async listWorkspacesForUser(userId: string): Promise<Workspace[]> {
    return [...this.workspaces.values()].filter((workspace) => workspace.ownerUserId === userId).map(clone);
  }

  async findWorkspace(id: string): Promise<Workspace | null> {
    return clone(this.workspaces.get(id) ?? null);
  }

  async createProject(project: Project): Promise<Project> {
    this.projects.set(project.id, clone(project));
    return clone(project);
  }

  async listProjectsForWorkspace(workspaceId: string): Promise<Project[]> {
    return [...this.projects.values()].filter((project) => project.workspaceId === workspaceId).map(clone);
  }

  async findProject(id: string): Promise<Project | null> {
    return clone(this.projects.get(id) ?? null);
  }

  async createEndpoint(endpoint: ModelEndpoint): Promise<ModelEndpoint> {
    this.endpoints.set(endpoint.id, clone(endpoint));
    return clone(endpoint);
  }

  async listEndpointsForProject(projectId: string): Promise<ModelEndpoint[]> {
    return [...this.endpoints.values()].filter((endpoint) => endpoint.projectId === projectId).map(clone);
  }

  async findEndpoint(id: string): Promise<ModelEndpoint | null> {
    return clone(this.endpoints.get(id) ?? null);
  }

  async createTask(task: AgentTask): Promise<AgentTask> {
    this.tasks.set(task.id, clone(task));
    return clone(task);
  }

  async updateTask(task: AgentTask): Promise<AgentTask> {
    this.tasks.set(task.id, clone(task));
    return clone(task);
  }

  async listTasksForProject(projectId: string): Promise<AgentTask[]> {
    return [...this.tasks.values()].filter((task) => task.projectId === projectId).map(clone);
  }

  async findTask(id: string): Promise<AgentTask | null> {
    return clone(this.tasks.get(id) ?? null);
  }

  async appendTaskEvents(events: AgentTaskEvent[]): Promise<void> {
    for (const event of events) {
      if (!this.events.some((existing) => existing.taskId === event.taskId && existing.botifiedSeq === event.botifiedSeq)) {
        this.events.push(clone(event));
      }
    }
  }

  async listTaskEvents(taskId: string): Promise<AgentTaskEvent[]> {
    return this.events.filter((event) => event.taskId === taskId).map(clone);
  }

  async appendTaskArtifacts(artifacts: AgentTaskArtifact[]): Promise<void> {
    for (const artifact of artifacts) {
      if (!this.artifacts.some((existing) => existing.taskId === artifact.taskId && existing.fileId === artifact.fileId)) {
        this.artifacts.push(clone(artifact));
      }
    }
  }

  async listTaskArtifacts(taskId: string): Promise<AgentTaskArtifact[]> {
    return this.artifacts.filter((artifact) => artifact.taskId === taskId).map(clone);
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

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : structuredClone(value);
}

