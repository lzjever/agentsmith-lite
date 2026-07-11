export type ISODateString = string;

export type UserRole = "admin" | "member";

export interface User {
  id: string;
  email: string;
  role: UserRole;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface StoredUser extends User {
  passwordHash: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: ISODateString;
  expiresAt: ISODateString;
}

export interface Workspace {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  ownerUserId: string;
  rootPath: string;
  taskConcurrencyLimit: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface WorkspaceWithProjects extends Workspace {
  projects: Project[];
}

export type EndpointProtocol = "openai_chat_completions";
export type EndpointCapability = "text" | "image" | "tool_calls";

export interface ModelEndpoint {
  id: string;
  projectId: string;
  name: string;
  protocol: EndpointProtocol;
  baseUrl: string;
  model: string;
  apiKeySecretRef: string;
  capabilities: EndpointCapability[];
  requestTimeoutSecs: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export type PublicModelEndpoint = Omit<ModelEndpoint, "apiKeySecretRef"> & {
  hasCredentialRef: boolean;
};

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatResponse {
  message: ChatMessage;
  endpointSnapshot: Pick<ModelEndpoint, "id" | "baseUrl" | "model" | "protocol">;
}

export type AgentTaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "expired"
  | "cleaned";

export interface AgentTask {
  id: string;
  workspaceId: string;
  projectId: string;
  endpointId: string;
  prompt: string;
  status: AgentTaskStatus;
  runId: string;
  sandbox: SandboxRenderResult;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export type TaskEventKind =
  | "user_input"
  | "turn_started"
  | "turn_completed"
  | "turn_failed"
  | "assistant_message"
  | "tool_execution"
  | "artifact"
  | "runtime_error"
  | "diagnostic";

export interface AgentTaskEvent {
  id: string;
  taskId: string;
  kind: TaskEventKind;
  cursor: string;
  botifiedSeq: number;
  botifiedType: string;
  sessionId: string;
  payload: Record<string, unknown>;
  createdAt: ISODateString;
}

export interface AgentTaskArtifact {
  id: string;
  taskId: string;
  fileId: string;
  name: string;
  bytes: number;
  sha256?: string;
  createdAt: ISODateString;
}

export interface KubernetesResource {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SandboxRenderResult {
  dryRun: true;
  namespace: string;
  resources: KubernetesResource[];
}

export interface DashboardResponse {
  health: {
    status: "ok";
    version: string;
  };
  user: User;
  workspaces: WorkspaceWithProjects[];
  endpoints: PublicModelEndpoint[];
  tasks: AgentTask[];
}

export interface CreateWorkspaceInput {
  name: string;
}

export interface CreateProjectInput {
  name: string;
  taskConcurrencyLimit?: number;
}

export interface CreateEndpointInput {
  name: string;
  protocol: EndpointProtocol;
  baseUrl: string;
  model: string;
  apiKeySecretRef: string;
  capabilities: EndpointCapability[];
  requestTimeoutSecs: number;
}

export interface CreateTaskInput {
  prompt: string;
  endpointId: string;
}

export type ProjectFileEntryType = "file" | "directory";

export interface ProjectFileEntry {
  name: string;
  path: string;
  type: ProjectFileEntryType;
  size?: number;
  updatedAt: ISODateString;
}

export interface ProjectFileListResponse {
  entries: ProjectFileEntry[];
}

export interface UploadProjectFileInput {
  path: string;
  bytes: Uint8Array;
}

export interface ProjectFileWriteResponse {
  path: string;
  bytes: number;
}

export interface ProjectFileDownloadResponse {
  path: string;
  filename: string;
  bytes: Uint8Array;
}

export interface DeleteProjectFileResponse {
  deleted: true;
}
