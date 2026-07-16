export type ISODateString = string;

export interface User {
  id: string;
  email: string;
  oidcIssuer?: string;
  oidcSubject?: string;
  pictureUrl?: string;
  emailVerified: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}
export type PublicUser = Omit<User, "oidcIssuer" | "oidcSubject">;
export type ProfileUser = PublicUser;
export interface UserProfilePreferences { userId: string; displayName: string | null; timezone: string | null; bio: string | null; jobTitle: string | null; company: string | null; greetingPreference: string | null; interests: string[]; updatedAt: ISODateString; }
export interface ProfileResponse { user: ProfileUser; preferences: UserProfilePreferences; }
export interface ProjectCredential { id: string; projectId: string; name: string; type: "api_key"; baseUrl: string; fingerprint: string; version: number; createdAt: ISODateString; lastRotatedAt: ISODateString | null; updatedAt: ISODateString; }
export interface StoredProjectCredential extends ProjectCredential { keyId: string; nonce: Uint8Array; ciphertext: Uint8Array; authTag: Uint8Array; }
export type ProjectContextScope = "workspace_shared" | "workspace_personal" | "project_shared" | "project_personal";
export type ProjectContextContentType = "text" | "json" | "markdown" | "yaml";
export interface ProjectContextEntry { id: string; workspaceId: string; projectId: string | null; ownerUserId: string | null; scope: ProjectContextScope; contextKey: string; content: string; contentType?: ProjectContextContentType; version: number; createdAt: ISODateString; updatedAt: ISODateString; }
export interface UserNotification { id: string; userId: string; type: string; title: string; body: string | null; projectId: string | null; resourceKind: ProjectAuditResourceKind | null; resourceId: string | null; linkPath: string | null; readAt: ISODateString | null; createdAt: ISODateString; }
export type AlertRuleMetric = "active_tasks" | "provider_requests" | "provider_tokens" | "provider_cost" | "project_file_bytes" | "failure_count";
export type AlertRuleCondition = "greater_than_or_equal";
export type AlertRuleScope = { kind: "project" } | { kind: "endpoint"; endpointId: string };
export interface ProjectAlertRule { id: string; projectId: string; name?: string; alertType: ProjectAlertType; metric?: AlertRuleMetric; condition?: AlertRuleCondition; threshold?: number; windowSeconds?: number | null; scope?: AlertRuleScope; enabled: boolean; createdAt: ISODateString; updatedAt: ISODateString; }

export type ProjectMembershipRole = "owner" | "admin" | "member" | "viewer";
export type ManagedProjectMembershipRole = Exclude<ProjectMembershipRole, "owner">;
export type WorkspaceMembershipRole = "owner" | "admin" | "member" | "viewer";
export type ManagedWorkspaceMembershipRole = Exclude<WorkspaceMembershipRole, "owner">;

export interface ProjectMembership {
  projectId: string;
  userId: string;
  role: ProjectMembershipRole;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}
export interface WorkspaceMembership { workspaceId: string; userId: string; role: WorkspaceMembershipRole; createdAt: ISODateString; updatedAt: ISODateString; }
export interface MembershipIdentity { displayName: string | null; email: string; }
export type ProjectMembershipView = ProjectMembership & MembershipIdentity;
export type WorkspaceMembershipView = WorkspaceMembership & MembershipIdentity;

export interface ProjectCapabilities {
  canManageEndpoints: boolean;
  canManageMembers: boolean;
  canManagePolicy: boolean;
  canWriteFiles: boolean;
  canCreateTasks: boolean;
  canCancelTasks: boolean;
  canSendChat: boolean;
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
  lifecycleStatus?: "active" | "archived" | "deleting";
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
  lifecycleStatus?: "active" | "archived" | "deleting";
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface ProjectResourcePolicy {
  projectId: string;
  activeTasksLimit: number | null;
  providerRequestsLimit: number | null;
  providerTokensLimit: number | null;
  providerCostLimit: number | null;
  projectFileBytesLimit: number | null;
  endpointWindows?: EndpointPolicyWindow[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
}
export type EndpointPolicyMetric = "providerRequests" | "providerTokens" | "providerCost";
export interface EndpointPolicyWindow { endpointId: string; metric: EndpointPolicyMetric; limit: number; windowSeconds: number; }

export interface ProjectResourceUsage {
  projectId: string;
  activeTasks: number;
  providerRequests: number;
  providerTokens: number;
  providerCost: number;
  projectFileBytes: number;
  updatedAt: ISODateString;
}

export type ProjectUsageMetric = "activeTasks" | "providerRequests" | "providerTokens" | "providerCost" | "projectFileBytes";

export type ProjectUsageWindow =
  | { kind: "current_gauge"; resetAt: null }
  | { kind: "project_lifetime"; startedAt: ISODateString; resetAt: null }
  | { kind: "rolling"; windowSeconds: number; startedAt: ISODateString; resetAt: ISODateString | null };

export interface ProjectUsageLimit {
  metric: ProjectUsageMetric;
  current: number;
  limit: number | null;
  remaining: number | null;
  window: ProjectUsageWindow;
}

export interface ProjectUsageDay {
  date: string;
  requests: number;
  tokens: number;
  cost: number;
}

export interface ProjectUsageEndpoint {
  endpointId: string;
  endpointName: string;
  requests: number;
  tokens: number;
  cost: number;
  limits?: ProjectUsageLimit[];
}

export interface ProjectUsageOverview {
  projectId: string;
  usage: ProjectResourceUsage;
  limits: ProjectUsageLimit[];
  daily: ProjectUsageDay[];
  trendTotals: { requests: number; tokens: number; cost: number };
  endpoints: ProjectUsageEndpoint[];
  selectedEndpointId: string | null;
}

export type ProjectAlertType = "active_tasks_limit" | "provider_requests_limit" | "provider_tokens_limit" | "provider_cost_limit" | "project_file_bytes_limit" | "endpoint_failure" | "provider_failure" | "task_failure" | "sandbox_failure";
export type ProjectAlertStatus = "active" | "resolved" | "dismissed";
export type ProjectAlertDeliveryStatus = "not_configured" | "pending" | "delivered" | "failed";
export const PROJECT_AUDIT_ACTIONS = ["project.settings.update","project.archive","project.unarchive","project.owner.transfer","project.delete","policy.update","credential.create","credential.rotate","credential.delete","endpoint.create","endpoint.update","endpoint.delete","endpoint.health_check","endpoint.model_discover","membership.add","membership.change","membership.remove","provider.request","chat.thread.create","chat.thread.update","chat.thread.delete","chat.message.send","chat.message.retry","chat.message.stop","chat.message.edit","chat.message.delete","chat.message.branch","task.create","task.edit","task.archive","task.delete","task.message.create","task.message.edit","task.message.delete","task.cancel","task.completed","task.failed","task.expired","task.cleaned","artifact.project","sandbox.failed","file.upload","file.delete","file.quota","alert.resolve","alert.dismiss","alert.rule.create","alert.rule.update","alert.rule.delete","alert.acknowledge","alert.silence"] as const;
export type ProjectAuditAction = typeof PROJECT_AUDIT_ACTIONS[number];
export const PROJECT_AUDIT_RESOURCE_KINDS = ["project","credential","endpoint","member","task","artifact","provider","file","file_quota","sandbox","alert"] as const;
export type ProjectAuditResourceKind = typeof PROJECT_AUDIT_RESOURCE_KINDS[number];

export interface ProjectAlert {
  id: string;
  projectId: string;
  type: ProjectAlertType;
  status: ProjectAlertStatus;
  deliveryStatus: ProjectAlertDeliveryStatus;
  ruleId?: string | null;
  metric?: AlertRuleMetric | null;
  metricValue?: number | null;
  threshold?: number | null;
  endpointId?: string | null;
  acknowledgedAt?: ISODateString | null;
  acknowledgedBy?: string | null;
  silencedUntil?: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  resolvedAt: ISODateString | null;
  dismissedAt: ISODateString | null;
}

export interface ProjectAuditEvent {
  id: string;
  projectId: string;
  actorId: string | null;
  action: ProjectAuditAction;
  status: "accepted" | "rejected";
  resourceKind: ProjectAuditResourceKind;
  resourceId: string | null;
  detail?: ProjectAuditSafeDetail;
  createdAt: ISODateString;
}
export interface ProjectAuditSafeDetail { endpointId?: string; metric?: AlertRuleMetric; limit?: number; current?: number; windowSeconds?: number; alertRuleId?: string; alertId?: string; taskId?: string; messageId?: string; deliveryStatus?: "pending" | "dispatching" | "terminal_pending" | "accepted" | "successor_created" | "failed"; credentialVersion?: number; healthStatus?: EndpointHealthStatus; errorCategory?: EndpointHealthErrorCategory; modelCount?: number; filePath?: string; bytes?: number; mediaType?: string; }
export function sanitizeProjectAuditDetail(input:unknown):ProjectAuditSafeDetail{if(!input||typeof input!=="object"||Array.isArray(input))return{};const source=input as Record<string,unknown>;const safe:ProjectAuditSafeDetail={};for(const key of ["endpointId","alertRuleId","alertId","taskId","messageId"] as const){const value=source[key];if(typeof value==="string"&&value.length<=128&&/^[A-Za-z0-9._:-]+$/.test(value))Object.assign(safe,{[key]:value})}if(typeof source.metric==="string"&&["active_tasks","provider_requests","provider_tokens","provider_cost","project_file_bytes","failure_count"].includes(source.metric))safe.metric=source.metric as AlertRuleMetric;if(typeof source.deliveryStatus==="string"&&["pending","dispatching","terminal_pending","accepted","successor_created","failed"].includes(source.deliveryStatus))safe.deliveryStatus=source.deliveryStatus as NonNullable<ProjectAuditSafeDetail["deliveryStatus"]>;if(typeof source.healthStatus==="string"&&["healthy","unavailable","unknown"].includes(source.healthStatus))safe.healthStatus=source.healthStatus as EndpointHealthStatus;if(typeof source.errorCategory==="string"&&["auth","network","upstream","timeout","rate_limit","unknown"].includes(source.errorCategory))safe.errorCategory=source.errorCategory as EndpointHealthErrorCategory;if(typeof source.filePath==="string"&&source.filePath.length<=1024&&source.filePath.startsWith("files/")&&!source.filePath.split("/").includes(".."))safe.filePath=source.filePath;if(typeof source.mediaType==="string"&&["text/plain","text/csv","text/markdown","application/json","image/png","image/jpeg","image/gif","image/webp","application/octet-stream"].includes(source.mediaType))safe.mediaType=source.mediaType;for(const key of ["limit","current","windowSeconds","credentialVersion","modelCount","bytes"] as const){const value=source[key];if(typeof value==="number"&&Number.isFinite(value)&&value>=0)Object.assign(safe,{[key]:value})}return safe}

export interface ProjectAuditEventView extends ProjectAuditEvent {
  actorDisplayName: string | null;
  actorEmail: string | null;
}
export interface ProjectAuditQuery { cursor?: string; limit?: number; action?: ProjectAuditAction; status?: "accepted" | "rejected"; resourceKind?: ProjectAuditResourceKind; from?: ISODateString; to?: ISODateString; }
export interface ProjectAuditPage { items: ProjectAuditEventView[]; nextCursor: string | null; }

export interface UpdateProjectResourcePolicyInput {
  activeTasksLimit?: number | null;
  providerRequestsLimit?: number | null;
  providerTokensLimit?: number | null;
  providerCostLimit?: number | null;
  projectFileBytesLimit?: number | null;
  endpointWindows?: EndpointPolicyWindow[];
}

export interface WorkspaceListProjection extends Workspace {
  owner: MembershipIdentity;
  memberRole: WorkspaceMembershipRole;
}

export interface WorkspaceWithProjects extends WorkspaceListProjection {
  projects: Project[];
  capabilities: WorkspaceCapabilities;
}

export interface WorkspaceCapabilities {
  canCreateProject: boolean;
  canManageMembers: boolean;
}

export type EndpointProtocol = "openai_chat_completions";
export type EndpointCapability = "text" | "image" | "tool_calls";
export type EndpointHealthStatus = "healthy" | "unavailable" | "unknown";
export type EndpointHealthErrorCategory = "auth" | "network" | "upstream" | "timeout" | "rate_limit" | "unknown";
export interface EndpointHealth { status: EndpointHealthStatus; checkedAt: ISODateString | null; errorCategory: EndpointHealthErrorCategory | null; }
export interface EndpointModelDiscovery { models: string[]; health: EndpointHealth; }

export interface ModelEndpoint {
  id: string;
  projectId: string;
  name: string;
  protocol: EndpointProtocol;
  baseUrl: string;
  model: string;
  credentialId: string;
  capabilities: EndpointCapability[];
  requestTimeoutSecs: number;
  health?: EndpointHealth;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export type PublicModelEndpoint = ModelEndpoint & {
  hasCredentialRef: boolean;
  taskEligible: boolean;
};

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ProjectChatThread {
  id: string;
  projectId: string;
  endpointId: string | null;
  title?: string | null;
  pinnedAt?: ISODateString | null;
  starredAt?: ISODateString | null;
  deletedAt?: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface ProjectChatMessage extends ChatMessage {
  id: string;
  threadId: string;
  sequence: number;
  version: number;
  deliveryStatus: "pending" | "response_pending" | "completed" | "failed" | "stopped";
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface ChatResponse {
  message: ChatMessage;
  endpointSnapshot: Pick<ModelEndpoint, "id" | "baseUrl" | "model" | "protocol">;
  usage?: ProviderUsage;
}

export interface ProviderUsage {
  requests?: number;
  tokens?: number;
  cost?: number;
}

export type AgentTaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled"
  | "cleaned";

export type TaskExecutionMode = "dry-run" | "live";
export type TaskTerminalReason = "completed" | "failed" | "cancelled" | "expired" | "not_executed" | "cleaned_legacy";
export type TaskStartIntentStatus = "pending" | "dispatching" | "dispatched" | "failed";
export type TaskArtifactProjectionStatus = "pending" | "draining" | "drained" | "failed";
export type TaskCleanupStatus = "pending" | "running" | "completed" | "failed";

export interface AgentTask {
  id: string;
  workspaceId: string;
  projectId: string;
  endpointId: string;
  title?: string;
  prompt: string;
  inputPaths?: string[];
  status: AgentTaskStatus;
  runId: string;
  sourceTaskId?: string | null;
  executionMode: TaskExecutionMode;
  sandbox: SandboxRenderResult;
  activeReservation?: boolean;
  archivedAt?: ISODateString | null;
  deletedAt?: ISODateString | null;
  terminalReason?: TaskTerminalReason | null;
  terminalizedAt?: ISODateString | null;
  startIntentStatus?: TaskStartIntentStatus | null;
  startSafeError?: string | null;
  artifactProjectionStatus?: TaskArtifactProjectionStatus;
  artifactProjectionError?: string | null;
  cleanupStatus?: TaskCleanupStatus;
  cleanupError?: string | null;
  cleanupCompletedAt?: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export type ProjectProviderSettlementStatus = "reserved" | "dispatched" | "delivered" | "settled" | "unknown" | "failed";

export interface ProjectProviderSettlement {
  id: string;
  projectId: string;
  taskId: string | null;
  endpointId: string | null;
  actorId?: string | null;
  reservedTokens: number;
  reservedCost: number;
  status: ProjectProviderSettlementStatus;
  reservedAt: ISODateString;
  expiresAt: ISODateString;
  dispatchedAt: ISODateString | null;
  deliveredAt: ISODateString | null;
  settledAt: ISODateString | null;
  usage?: ProviderUsage;
  updatedAt: ISODateString;
}

export interface AgentTaskArtifact {
  id: string;
  taskId: string;
  name: string;
  bytes: number;
  sha256?: string;
  mediaType?: string | null;
  previewText?: string | null;
  createdAt: ISODateString;
}
export interface TaskInputSnapshotEntry {
  path: string;
  name: string;
  bytes: number;
  sha256: string;
}
export interface TaskSummary { taskId: string; artifactCount: number; updatedAt: ISODateString; }

export type TaskInteractionKind =
  | "user_message"
  | "assistant_message"
  | "tool"
  | "background_task"
  | "task_question"
  | "task_notice"
  | "task_result"
  | "subagent_result"
  | "file"
  | "execution_boundary"
  | "system_error";

export type TaskInteractionContentMode = "full" | "preview" | "none";
export type TaskInteractionDeliveryStatus = "pending" | "delivered" | "failed";

export interface TaskInteractionBase {
  id: string;
  revision: number;
  taskId: string;
  kind: TaskInteractionKind;
  title: string;
  body: string | null;
  contentMode: TaskInteractionContentMode;
  position: number;
  occurredAt: ISODateString;
  updatedAt: ISODateString;
}

export interface TaskUserMessageInteraction extends TaskInteractionBase {
  kind: "user_message";
  status: "pending" | "dispatching" | "retrying" | "accepted" | "queued" | "rejected" | "failed";
}

export interface TaskAssistantMessageInteraction extends TaskInteractionBase {
  kind: "assistant_message";
  status: "generating" | "completed" | "failed" | "aborted";
}

export interface TaskToolInteraction extends TaskInteractionBase {
  kind: "tool";
  executionStatus: "pending" | "running" | "completed" | "failed" | "cancelled";
  deliveryStatus: TaskInteractionDeliveryStatus | null;
  toolName: string;
  command: string | null;
  outputTail: string | null;
  exitCode: number | null;
  detailsOmitted: boolean;
  canStop: boolean;
}

export interface TaskBackgroundTaskInteraction extends TaskInteractionBase {
  kind: "background_task";
  executionStatus: "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out" | "lost";
  deliveryStatus: TaskInteractionDeliveryStatus | null;
  label: string;
  workSummary: string | null;
  result: string | null;
  error: string | null;
  detailsOmitted: boolean;
  canStop: boolean;
}

export interface TaskQuestionInteraction extends TaskInteractionBase {
  kind: "task_question";
  status: "waiting" | "answered" | "expired" | "rejected" | "reply_failed";
  question: string;
  expect: string | null;
  answer: string | null;
}

export interface TaskNoticeInteraction extends TaskInteractionBase {
  kind: "task_notice";
  status: "accepted" | "rejected";
  sender: string | null;
}

export interface TaskResultInteraction extends TaskInteractionBase {
  kind: "task_result";
  executionStatus: "completed" | "failed" | "cancelled" | "timed_out" | "lost";
  deliveryStatus: TaskInteractionDeliveryStatus;
  result: string | null;
  error: string | null;
  detailsOmitted: boolean;
}

export interface TaskSubagentResultInteraction extends TaskInteractionBase {
  kind: "subagent_result";
  executionStatus: "completed" | "failed" | "cancelled";
  deliveryStatus: TaskInteractionDeliveryStatus;
  name: string;
  purpose: string | null;
  result: string | null;
  error: string | null;
  detailsOmitted: boolean;
}

export interface TaskFileInteraction extends TaskInteractionBase {
  kind: "file";
  status: "available" | "failed";
  artifactId: string;
  name: string;
  mediaType: string | null;
  bytes: number;
}

export interface TaskExecutionBoundaryInteraction extends TaskInteractionBase {
  kind: "execution_boundary";
  status: "successor_pending" | "successor_created" | "failed";
  targetTaskId: string | null;
}

export interface TaskSystemErrorInteraction extends TaskInteractionBase {
  kind: "system_error";
  status: "active" | "resolved";
  code: string | null;
  retryable: boolean;
  detailsOmitted: boolean;
}

export type TaskInteractionItem =
  | TaskUserMessageInteraction
  | TaskAssistantMessageInteraction
  | TaskToolInteraction
  | TaskBackgroundTaskInteraction
  | TaskQuestionInteraction
  | TaskNoticeInteraction
  | TaskResultInteraction
  | TaskSubagentResultInteraction
  | TaskFileInteraction
  | TaskExecutionBoundaryInteraction
  | TaskSystemErrorInteraction;

export interface TaskCapabilities {
  sendMessage: boolean;
  editQueuedMessage: boolean;
  abortTurn: boolean;
  cancelTask: boolean;
  openTerminal: boolean;
  deleteTask: boolean;
}

export type TaskRunState = "idle" | "starting" | "running" | "reconnecting" | "aborting" | "finalizing" | "terminal";
export type TaskRuntimeReachability = "unknown" | "reachable" | "unreachable";
export type TaskHistoryStatus = "complete" | "gap";

export interface TaskQueuedMessage {
  id: string;
  content: string;
  deliveryStatus: "pending" | "dispatching" | "terminal_pending" | "failed";
  editable: boolean;
  deletable: boolean;
  updatedAt: ISODateString;
}

export interface TaskInteractionHistoryPage {
  items: TaskInteractionItem[];
  nextPageCursor: string | null;
  hasMoreBefore: boolean;
  streamCursor: string;
  historyStatus: TaskHistoryStatus;
}

export interface TaskInteractionState {
  queuedMessages: TaskQueuedMessage[];
  runState: TaskRunState;
  runtimeReachability: TaskRuntimeReachability;
  lastSyncedAt: ISODateString | null;
  historyStatus: TaskHistoryStatus;
  capabilities: TaskCapabilities;
}

export interface TaskInteractionSnapshot extends TaskInteractionHistoryPage, TaskInteractionState {}

export type TaskMessageDisposition =
  | "accepted_by_active_run"
  | "queued_for_active_run"
  | "successor_pending"
  | "successor_created"
  | "failed";

export interface TaskMessageReceipt {
  messageId: string;
  disposition: TaskMessageDisposition;
  targetTaskId: string;
  duplicate: boolean;
  queuedMessage: TaskQueuedMessage | null;
  interaction: TaskUserMessageInteraction | TaskExecutionBoundaryInteraction | null;
  capabilities: TaskCapabilities;
  safeError?: string;
}

export type TaskInteractionConnectionState = "connecting" | "reconnecting" | "connected" | "disconnected" | "recovered";
export type TaskInteractionStreamEvent =
  | { type: "interaction"; cursor: string; item: TaskInteractionItem }
  | { type: "state"; queuedMessages: TaskQueuedMessage[]; capabilities: TaskCapabilities }
  | { type: "run_state"; runState: TaskRunState }
  | { type: "connection"; connectionState: TaskInteractionConnectionState; runtimeReachability: TaskRuntimeReachability; historyStatus: TaskHistoryStatus; lastSyncedAt: ISODateString | null; message: string | null }
  | { type: "assistant_preview"; interactionId: string; body: string; occurredAt: ISODateString }
  | { type: "assistant_preview_clear"; interactionId: string }
  | { type: "reset"; snapshot: TaskInteractionSnapshot }
  | { type: "reconnect" }
  | { type: "done" };

export type TaskListSort = "created_at" | "updated_at" | "title" | "status";
export type TaskListArchivedFilter = "exclude" | "include" | "only";
export interface TaskListQuery {
  search?: string;
  statuses?: AgentTaskStatus[];
  archived?: TaskListArchivedFilter;
  sort?: TaskListSort;
  direction?: "asc" | "desc";
  cursor?: string;
  limit?: number;
}
export interface TaskListPage {
  items: AgentTask[];
  nextCursor: string | null;
  total: number;
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
  credentialId: string;
  capabilities: EndpointCapability[];
  requestTimeoutSecs: number;
}

export interface UpdateEndpointInput extends Omit<CreateEndpointInput, "credentialId"> {
  credentialId?: string;
}

export interface DiscoverEndpointModelsInput {
  endpointId?: string;
  baseUrl: string;
  credentialId: string;
  requestTimeoutSecs: number;
}

export interface CreateProjectCredentialInput { name: string; baseUrl: string; secret: string; }
export interface RotateProjectCredentialInput { secret: string; }

export interface CreateTaskInput {
  prompt: string;
  endpointId: string;
  title?: string;
  inputPaths?: string[];
}

export type ProjectFileEntryType = "file" | "directory";

export interface ProjectFileEntry {
  name: string;
  path: string;
  type: ProjectFileEntryType;
  size?: number;
  mediaType?: string;
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
  mediaType: string;
}

export interface ProjectFileDownloadResponse {
  path: string;
  filename: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface DeleteProjectFileResponse {
  deleted: true;
}
