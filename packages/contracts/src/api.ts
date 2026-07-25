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
export const PROFILE_GREETING_PREFERENCES = ["formal", "casual", "friendly", "professional"] as const;
export type ProfileGreetingPreference = typeof PROFILE_GREETING_PREFERENCES[number];
export interface UserProfilePreferences { userId: string; displayName: string | null; timezone: string | null; bio: string | null; jobTitle: string | null; company: string | null; greetingPreference: ProfileGreetingPreference | null; interests: string[]; updatedAt: ISODateString; }
export interface ProfileResponse { user: ProfileUser; preferences: UserProfilePreferences; }
export interface ProjectCredential { id: string; projectId: string; name: string; type: "api_key"; baseUrl: string; fingerprint: string; version: number; createdAt: ISODateString; lastRotatedAt: ISODateString | null; updatedAt: ISODateString; }
export interface StoredProjectCredential extends ProjectCredential { keyId: string; nonce: Uint8Array; ciphertext: Uint8Array; authTag: Uint8Array; }
export interface CredentialDirectoryQuery { q?: string; cursor?: string; limit?: number; }
export interface CredentialPage { items: ProjectCredential[]; nextCursor: string | null; }
export type ProjectCredentialSummary = Pick<ProjectCredential,"id"|"name"|"baseUrl"|"version">;
export type ProjectContextScope = "workspace_shared" | "workspace_personal" | "project_shared" | "project_personal";
export type ProjectContextContentType = "text" | "json" | "markdown" | "yaml";
export interface ProjectContextEntry { id: string; workspaceId: string; projectId: string | null; ownerUserId: string | null; scope: ProjectContextScope; contextKey: string; content: string; contentType: ProjectContextContentType; version: number; createdAt: ISODateString; updatedAt: ISODateString; }
export type ProjectContextEntryMetadata = Omit<ProjectContextEntry, "content">;
export interface ProjectContextPage { items: ProjectContextEntryMetadata[]; nextCursor: string | null; canWrite: boolean; }
export interface UserNotification { id: string; userId: string; type: string; title: string; body: string | null; projectId: string | null; resourceKind: ProjectAuditResourceKind | null; resourceId: string | null; linkPath: string | null; readAt: ISODateString | null; createdAt: ISODateString; }
export type AlertRuleMetric = "active_tasks" | "provider_requests" | "provider_tokens" | "provider_cost" | "project_file_bytes" | "failure_count";
export type AlertRuleCondition = "greater_than_or_equal";
export type AlertRuleScope = { kind: "project" } | { kind: "endpoint"; endpointId: string };
export interface ProjectAlertRule { id: string; projectId: string; name?: string; alertType: ProjectAlertType; metric?: AlertRuleMetric; condition?: AlertRuleCondition; threshold?: number; windowSeconds?: number | null; scope?: AlertRuleScope; enabled: boolean; createdAt: ISODateString; updatedAt: ISODateString; }
export type ProjectAlertRuleView = ProjectAlertRule & { endpointName: string | null };

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
export interface MembershipDirectoryQuery<Role extends string> { q?: string; role?: Role; cursor?: string; limit?: number; }
export interface ProjectMembershipQuery extends MembershipDirectoryQuery<ProjectMembershipRole> {}
export interface WorkspaceMembershipQuery extends MembershipDirectoryQuery<WorkspaceMembershipRole> {}
export interface ProjectMembershipPage { items: ProjectMembershipView[]; nextCursor: string | null; }
export interface WorkspaceMembershipPage { items: WorkspaceMembershipView[]; nextCursor: string | null; }
export interface ProjectMembershipCandidate extends MembershipIdentity { userId: string; }
export interface ProjectMembershipCandidateQuery { q?: string; cursor?: string; limit?: number; }
export interface ProjectMembershipCandidatePage { items: ProjectMembershipCandidate[]; nextCursor: string | null; }

export interface ProjectCapabilities {
  canManageEndpoints: boolean;
  canManageMembers: boolean;
  canManagePolicy: boolean;
  canWriteFiles: boolean;
  canCreateTasks: boolean;
}

export type ProjectOverviewAction = "configure_endpoint" | "create_task" | "add_collaborator";
export interface ProjectOverviewProjection {
  project: Project;
  workspaceLifecycleStatus: "active" | "archived" | "deleting";
  capabilities: ProjectCapabilities;
  owner: MembershipIdentity | null;
  memberRole: ProjectMembershipRole;
  taskReadyEndpointCount: number;
  recommendedActions: ProjectOverviewAction[];
}

export interface StoredUser extends User {
  passwordHash: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  csrfToken: string;
  oidcIdToken?: string;
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

export interface FileLibrary {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  rootSubPath: string;
  createdByUserId: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface FileLibraryTaskLink {
  id: string;
  title: string | null;
}

export interface FileLibraryCapabilities {
  canRename: boolean;
  canDelete: boolean;
  canWriteFiles: boolean;
}

export interface FileLibraryProjection extends FileLibrary {
  boundTask: FileLibraryTaskLink | null;
  capabilities: FileLibraryCapabilities;
}

export interface CreateFileLibraryInput { name: string; }
export interface RenameFileLibraryInput { name: string; expectedUpdatedAt: ISODateString; }

export interface ProjectResourcePolicy {
  projectId: string;
  activeTasksLimit: number;
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
export type EndpointPolicyWindowView = EndpointPolicyWindow & { endpointName: string | null };
export type ProjectResourcePolicyView = Omit<ProjectResourcePolicy,"endpointWindows"> & { endpointWindows: EndpointPolicyWindowView[] };

export interface ProjectResourceUsage {
  projectId: string;
  activeTasks: number;
  providerRequests: number;
  providerTokens: number;
  providerCost: number;
  projectFileBytes: number;
  projectFileBytesMeasuredAt: ISODateString | null;
  updatedAt: ISODateString;
}

export type ProjectUsageMetric = "activeTasks" | "providerRequests" | "providerTokens" | "providerCost";

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
  endpointId: string | null;
  endpointName: string;
  requests: number;
  tokens: number;
  cost: number;
  limits?: ProjectUsageLimit[];
}

export interface SandboxResourceSnapshot {
  cpuRequestMillis: string;
  memoryRequestBytes: string;
  cpuLimitMillis: string;
  memoryLimitBytes: string;
}

export type SandboxReleaseReason = "requested" | "failed" | "cleanup";

export type ProjectSandboxLiveRunState = "starting" | "active" | "release_requested" | "failed";

export interface ProjectSandboxLiveRun {
  taskId: string;
  taskTitle: string | null;
  taskAvailable: boolean;
  runId: string;
  fileLibraryId: string;
  state: ProjectSandboxLiveRunState;
  startedAt: ISODateString | null;
  durationSeconds: number;
  resources: SandboxResourceSnapshot;
}

export interface ProjectSandboxUsage {
  selectedUserId: string;
  summaryStartedAt: ISODateString;
  measuredAt: ISODateString;
  unreleasedCount: number;
  launches: number;
  totalDurationSeconds: string;
  cpuRequestSeconds: string;
  memoryRequestByteSeconds: string;
  liveRuns: ProjectSandboxLiveRun[];
}

export interface ProjectSandboxSettledRun {
  taskId: string;
  taskTitle: string | null;
  taskAvailable: boolean;
  runId: string;
  fileLibraryId: string;
  startedAt: ISODateString | null;
  releasedAt: ISODateString;
  durationSeconds: number;
  resources: SandboxResourceSnapshot;
  releaseReason: SandboxReleaseReason;
}

export interface ProjectSandboxRunHistoryPage {
  projectId: string;
  selectedUserId: string;
  summaryStartedAt: ISODateString;
  scopeMeasuredAt: ISODateString;
  items: ProjectSandboxSettledRun[];
  nextCursor: string | null;
}

export interface ProjectProviderUsage {
  userId: string;
  periodStart: ISODateString;
  periodEnd: ISODateString;
  selectedEndpointId: string | null;
  selectedEndpoint: Pick<PublicModelEndpoint,"id"|"name"> | null;
  daily: ProjectUsageDay[];
  totals: { requests: number; tokens: number; cost: number };
}

export interface ProjectEndpointUsageQuery { q?:string; cursor?:string; limit?:number; userId?:string; }
export interface ProjectEndpointUsagePage { items:ProjectUsageEndpoint[]; nextCursor:string|null; total:number; }

export interface ProjectFileStorageUsage {
  recordedBytes: number;
  measuredAt: ISODateString | null;
  limitBytes: number | null;
  remainingBytes: number | null;
}

export interface ProjectUsageOverview {
  projectId: string;
  canSelectMemberUsage: boolean;
  limits: ProjectUsageLimit[];
  fileStorage: ProjectFileStorageUsage;
  provider: ProjectProviderUsage;
  sandbox: ProjectSandboxUsage;
}

export interface ProjectFileStorageRefreshResponse {
  projectId: string;
  fileStorage: ProjectFileStorageUsage;
}

export type ProjectAlertType = "active_tasks_limit" | "provider_requests_limit" | "provider_tokens_limit" | "provider_cost_limit" | "project_file_bytes_limit" | "endpoint_failure" | "provider_failure" | "sandbox_failure";
export function projectAlertTypeLabel(type: ProjectAlertType, endpointScoped = false): string {
  if (type === "provider_requests_limit" && endpointScoped) return "Endpoint request limit reached";
  return {
    active_tasks_limit: "Sandbox capacity reached",
    provider_requests_limit: "Project request limit reached",
    provider_tokens_limit: "Token quota exceeded",
    provider_cost_limit: "Cost quota exceeded",
    project_file_bytes_limit: "File quota reached",
    endpoint_failure: "Endpoint failure",
    provider_failure: "Provider failure",
    sandbox_failure: "Sandbox failure",
  }[type];
}
export type ProjectAlertStatus = "active" | "resolved" | "dismissed";
export type ProjectAlertDeliveryStatus = "not_configured" | "pending" | "delivered" | "failed";
export const PROJECT_AUDIT_ACTIONS = ["project.settings.update","project.archive","project.unarchive","project.owner.transfer","project.delete","policy.update","credential.create","credential.rotate","credential.delete","endpoint.create","endpoint.update","endpoint.delete","endpoint.health_check","endpoint.model_discover","membership.add","membership.change","membership.remove","provider.request","task.create","task.edit","task.archive","task.delete","task.message.create","task.message.edit","task.message.delete","artifact.project","sandbox.started","sandbox.failed","sandbox.released","file.upload","file.delete","file.quota","alert.resolve","alert.dismiss","alert.rule.create","alert.rule.update","alert.rule.delete","alert.acknowledge","alert.silence"] as const;
export type ProjectAuditAction = typeof PROJECT_AUDIT_ACTIONS[number];
export const PROJECT_AUDIT_RESOURCE_KINDS = ["project","credential","endpoint","member","task","artifact","provider","file","file_quota","sandbox","alert"] as const;
export type ProjectAuditResourceKind = typeof PROJECT_AUDIT_RESOURCE_KINDS[number];

interface ProjectAlertFields {
  id: string;
  projectId: string;
  deliveryStatus: ProjectAlertDeliveryStatus;
  ruleId?: string | null;
  metric?: AlertRuleMetric | null;
  metricValue?: number | null;
  threshold?: number | null;
  endpointId?: string | null;
  endpointName?: string | null;
  subjectActorId?: string | null;
  acknowledgedAt?: ISODateString | null;
  acknowledgedBy?: string | null;
  silencedUntil?: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  resolvedAt: ISODateString | null;
  dismissedAt: ISODateString | null;
}
export interface ActiveProjectAlert extends ProjectAlertFields { type: ProjectAlertType; status: "active"; }
export interface InactiveProjectAlert extends ProjectAlertFields { type: ProjectAlertType; status: "resolved" | "dismissed"; }
export type ProjectAlert = ActiveProjectAlert | InactiveProjectAlert;
export function isActiveProjectAlert(alert: ProjectAlert): alert is ActiveProjectAlert { return alert.status === "active"; }

export type ProjectAlertView = "active" | "history";
export interface ProjectAlertCursorKey { createdAt: ISODateString; id: string; }
export interface ProjectAlertQuery {
  view?: ProjectAlertView;
  cursor?: string;
  limit?: number;
}

export interface ProjectAlertPage {
  view: ProjectAlertView;
  items: ProjectAlert[];
  nextCursor: string | null;
  activeCount: number;
}

export interface ProjectAuditEvent {
  id: string;
  projectId: string;
  actorId: string | null;
  subjectUserId?: string | null;
  action: ProjectAuditAction;
  status: "accepted" | "rejected";
  resourceKind: ProjectAuditResourceKind;
  resourceId: string | null;
  detail?: ProjectAuditSafeDetail;
  createdAt: ISODateString;
}
export interface ProjectAuditSafeDetail { endpointId?: string; metric?: AlertRuleMetric; limit?: number; current?: number; windowSeconds?: number; alertRuleId?: string; alertId?: string; taskId?: string; runId?: string; releaseReason?: SandboxReleaseReason; messageId?: string; deliveryStatus?: "pending" | "dispatching" | "accepted" | "failed"; credentialVersion?: number; healthStatus?: EndpointHealthStatus; errorCategory?: EndpointHealthErrorCategory; modelCount?: number; filePath?: string; bytes?: number; mediaType?: string; trigger?:"task_create"|"task_message"|"terminal"; scope?:"project_policy"|"substrate_namespace"; activeSandboxes?:number; sandboxLimit?:number; }
export function sanitizeProjectAuditDetail(input:unknown):ProjectAuditSafeDetail{if(!input||typeof input!=="object"||Array.isArray(input))return{};const source=input as Record<string,unknown>;const safe:ProjectAuditSafeDetail={};for(const key of ["endpointId","alertRuleId","alertId","taskId","runId","messageId"] as const){const value=source[key];if(typeof value==="string"&&value.length<=128&&/^[A-Za-z0-9._:-]+$/.test(value))Object.assign(safe,{[key]:value})}if(typeof source.releaseReason==="string"&&["requested","failed","cleanup"].includes(source.releaseReason))safe.releaseReason=source.releaseReason as SandboxReleaseReason;if(typeof source.metric==="string"&&["active_tasks","provider_requests","provider_tokens","provider_cost","project_file_bytes","failure_count"].includes(source.metric))safe.metric=source.metric as AlertRuleMetric;if(typeof source.deliveryStatus==="string"&&["pending","dispatching","accepted","failed"].includes(source.deliveryStatus))safe.deliveryStatus=source.deliveryStatus as NonNullable<ProjectAuditSafeDetail["deliveryStatus"]>;if(typeof source.healthStatus==="string"&&["healthy","unavailable","unknown"].includes(source.healthStatus))safe.healthStatus=source.healthStatus as EndpointHealthStatus;if(typeof source.errorCategory==="string"&&["auth","network","upstream","timeout","rate_limit","unknown"].includes(source.errorCategory))safe.errorCategory=source.errorCategory as EndpointHealthErrorCategory;if(typeof source.trigger==="string"&&["task_create","task_message","terminal"].includes(source.trigger))safe.trigger=source.trigger as NonNullable<ProjectAuditSafeDetail["trigger"]>;if(typeof source.scope==="string"&&["project_policy","substrate_namespace"].includes(source.scope))safe.scope=source.scope as NonNullable<ProjectAuditSafeDetail["scope"]>;if(isCanonicalLibraryAuditPath(source.filePath))safe.filePath=source.filePath;if(typeof source.mediaType==="string"&&["text/plain","text/csv","text/markdown","application/json","image/png","image/jpeg","image/gif","image/webp","application/octet-stream"].includes(source.mediaType))safe.mediaType=source.mediaType;for(const key of ["limit","current","windowSeconds","credentialVersion","modelCount","bytes","activeSandboxes","sandboxLimit"] as const){const value=source[key];if(typeof value==="number"&&Number.isFinite(value)&&value>=0)Object.assign(safe,{[key]:value})}return safe}
function isCanonicalLibraryAuditPath(input:unknown):input is string{if(typeof input!=="string"||input.length>1024||input.includes("\\")||/[\u0000-\u001f]/.test(input))return false;const segments=input.split("/");return segments.length>=4&&segments[0]==="libraries"&&/^[A-Za-z0-9._:-]+$/.test(segments[1]??"")&&segments[2]==="home"&&segments.slice(3).every((segment)=>segment!==""&&segment!=="."&&segment!=="..");}

export interface ProjectAuditEventView extends ProjectAuditEvent {
  actorDisplayName: string | null;
  actorEmail: string | null;
  subjectDisplayName: string | null;
  subjectEmail: string | null;
}
export interface ProjectAuditQuery { cursor?: string; limit?: number; actorId?: string | null; subjectUserId?: string | null; action?: ProjectAuditAction; status?: "accepted" | "rejected"; resourceKind?: ProjectAuditResourceKind; resourceId?: string; from?: ISODateString; to?: ISODateString; }
export interface ProjectAuditPage { items: ProjectAuditEventView[]; nextCursor: string | null; }
export type ProjectAuditIdentityRole = "actor" | "subject";
export interface ProjectAuditIdentity { id:string; displayName:string|null; email:string|null; }
export interface ProjectAuditIdentityQuery { role:ProjectAuditIdentityRole; q?:string; cursor?:string; limit?:number; }
export interface ProjectAuditIdentityPage { items:ProjectAuditIdentity[]; nextCursor:string|null; }

export interface UpdateProjectResourcePolicyInput {
  activeTasksLimit?: number;
  providerRequestsLimit?: number | null;
  providerTokensLimit?: number | null;
  providerCostLimit?: number | null;
  projectFileBytesLimit?: number | null;
  endpointWindows?: EndpointPolicyWindow[];
}
export interface UpdateProjectResourcePolicyRequest extends UpdateProjectResourcePolicyInput { expectedUpdatedAt: ISODateString; }

export interface WorkspaceListProjection extends Workspace {
  owner: MembershipIdentity;
  memberRole: WorkspaceMembershipRole;
}

export interface WorkspaceDirectoryItem extends WorkspaceListProjection {
  projectCount: number;
}

export interface WorkspaceDirectoryPage {
  items: WorkspaceDirectoryItem[];
  nextCursor: string | null;
}

export interface WorkspaceDetail {
  workspace: Workspace;
  owner: MembershipIdentity;
  memberRole: WorkspaceMembershipRole;
  capabilities: WorkspaceCapabilities;
  projectCount: number;
}

export interface ProjectDirectoryItem extends Project {
  pinnedAt: ISODateString | null;
}

export interface ProjectDirectoryPage {
  items: ProjectDirectoryItem[];
  nextCursor: string | null;
  total: number;
}

export interface ProjectDetail {
  project: ProjectDirectoryItem;
  workspace: {
    id: string;
    name: string;
    lifecycleStatus: "active" | "archived" | "deleting";
  };
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
export type EndpointDirectoryMode = "all"|"task_ready";
export interface EndpointDirectoryQuery { q?:string; mode?:EndpointDirectoryMode; cursor?:string; limit?:number; }
export type EndpointView = PublicModelEndpoint & { credential:ProjectCredentialSummary|null };
export interface EndpointReadiness { taskReady:number; }
export interface EndpointPage { items:EndpointView[]; nextCursor:string|null; total:number; readiness:EndpointReadiness; }

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
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

export interface AgentTask {
  id: string;
  workspaceId: string;
  projectId: string;
  endpointId: string;
  fileLibraryId: string;
  title?: string;
  prompt: string;
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

export const PREVIEW_TEXT_MEDIA_TYPES = [
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json"
] as const;

export const PREVIEW_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
] as const;

export function classifyPreviewMediaType(mediaType: string | null | undefined): "text" | "image" | null {
  if (typeof mediaType !== "string") return null;
  const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (PREVIEW_TEXT_MEDIA_TYPES.some((candidate) => candidate === essence)) return "text";
  if (PREVIEW_IMAGE_MEDIA_TYPES.some((candidate) => candidate === essence)) return "image";
  return null;
}

export type TaskArtifactKind = "text" | "image" | "file";
export interface TaskArtifactListQuery {
  cursor?: string;
  kind?: TaskArtifactKind;
  limit?: number;
  mediaType?: string;
  previewOnly?: boolean;
}
export interface TaskArtifactListPage {
  items: AgentTaskArtifact[];
  nextCursor: string | null;
}
export interface TaskLifecycleProjection { state: "active" | "archived"; }
export interface TaskCurrentTurnProjection { state: "ready" | "starting" | "queued" | "running" | "aborting"; }
export type SandboxFailureCode = "startup_failed" | "runtime_unreachable" | "runner_failed" | "cleanup_failed";
export interface TaskSandboxFailureCause {
  code: SandboxFailureCode;
  message: string;
}
export interface TaskSandboxStateProjection {
  state: "starting" | "active" | "release_requested" | "released" | "failed";
  runId: string | null;
  cause: TaskSandboxFailureCause | null;
}
export interface TaskStateProjection {
  lifecycle: TaskLifecycleProjection;
  currentTurn: TaskCurrentTurnProjection;
  sandboxState: TaskSandboxStateProjection;
}

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
  actorId?: string | null;
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
  | TaskSystemErrorInteraction;

export interface TaskCapabilities {
  sendMessage: boolean;
  editQueuedMessage: boolean;
  abortTurn: boolean;
  stopWork: boolean;
  openTerminal: boolean;
  releaseSandbox: boolean;
  editTask: boolean;
  archiveTask: boolean;
  deleteTask: boolean;
}

export interface TaskSandboxReleaseReceipt {
  taskId: string;
  presentation: TaskPresentation;
}

export type TaskTerminalStartReceipt =
  | { status:"active"; runId:string; presentation:TaskPresentation }
  | { status:"in_progress"; runId:string; presentation:TaskPresentation };

export interface TaskPresentation extends TaskStateProjection {
  task: AgentTask;
  capabilities: TaskCapabilities;
}

export type SandboxRetryableErrorCode =
  | "project_sandbox_capacity_reached"
  | "substrate_sandbox_capacity_reached"
  | "sandbox_start_failed";

export interface SandboxRetryableErrorEnvelope {
  error:{
    code:SandboxRetryableErrorCode;
    message:string;
    retryable:true;
    details:{activeSandboxes:number;sandboxLimit:number}|null;
    presentation:TaskPresentation|null;
  };
}

export function sandboxCapacityErrorEnvelope(
  scope:"project_policy"|"substrate_namespace",
  presentation:TaskPresentation|null,
  details:{activeSandboxes:number;sandboxLimit:number}|null
):SandboxRetryableErrorEnvelope{
  if(scope==="project_policy"){
    if(!details)throw new Error("Project Sandbox capacity details are required");
    return{error:{code:"project_sandbox_capacity_reached",message:"Project Sandbox capacity reached",retryable:true,details,presentation}};
  }
  if(details)throw new Error("Substrate Sandbox capacity details must be null");
  return{error:{code:"substrate_sandbox_capacity_reached",message:"Local Sandbox capacity unavailable",retryable:true,details:null,presentation}};
}

export function sandboxStartFailedErrorEnvelope(presentation:TaskPresentation):SandboxRetryableErrorEnvelope{
  return{error:{code:"sandbox_start_failed",message:"Sandbox could not be started",retryable:true,details:null,presentation}};
}
export type TaskDetailProjection = TaskPresentation;

export type TaskRuntimeReachability = "unknown" | "reachable" | "unreachable";
export type TaskHistoryStatus = "complete" | "gap";

export interface TaskQueuedMessage {
  id: string;
  content: string;
  deliveryStatus: "pending" | "dispatching" | "failed";
  editable: boolean;
  deletable: boolean;
  safeError?: string;
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
  runtimeReachability: TaskRuntimeReachability;
  lastSyncedAt: ISODateString | null;
  historyStatus: TaskHistoryStatus;
  presentation: TaskPresentation;
}

export interface TaskInteractionSnapshot extends TaskInteractionHistoryPage, TaskInteractionState {}

export type TaskMessageDisposition =
  | "accepted_by_active_run"
  | "queued_for_active_run"
  | "failed";

export interface TaskMessageReceipt {
  messageId: string;
  disposition: TaskMessageDisposition;
  duplicate: boolean;
  queuedMessage: TaskQueuedMessage | null;
  interaction: TaskUserMessageInteraction | null;
  presentation: TaskPresentation;
  safeError?: string;
}

export type TaskInteractionConnectionState = "connecting" | "reconnecting" | "connected" | "disconnected" | "recovered";
export type TaskAssistantPreviewStatus = "available" | "unavailable";
export type TaskInteractionStreamEvent =
  | { type: "interaction"; cursor: string; item: TaskInteractionItem }
  | { type: "state"; queuedMessages: TaskQueuedMessage[]; presentation: TaskPresentation }
  | { type: "connection"; connectionState: TaskInteractionConnectionState; runtimeReachability: TaskRuntimeReachability; historyStatus: TaskHistoryStatus; lastSyncedAt: ISODateString | null; message: string | null }
  | { type: "preview_status"; previewStatus: TaskAssistantPreviewStatus; message: string | null }
  | { type: "assistant_preview"; interactionId: string; body: string; occurredAt: ISODateString }
  | { type: "assistant_preview_clear"; interactionId: string }
  | { type: "reset"; snapshot: TaskInteractionSnapshot }
  | { type: "reconnect" }
  | { type: "done" };

export type TaskListSort = "created_at" | "updated_at" | "title";
export type TaskListArchivedFilter = "exclude" | "include" | "only";
export interface TaskListQuery {
  search?: string;
  archived?: TaskListArchivedFilter;
  sort?: TaskListSort;
  direction?: "asc" | "desc";
  cursor?: string;
  limit?: number;
}
export interface TaskListPage {
  items: TaskPresentation[];
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
  expectedUpdatedAt: ISODateString;
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
  fileLibrary:
    | { mode: "create_new"; name: string }
    | { mode: "use_existing"; id: string };
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
  overwrite?: boolean;
}

export interface ProjectFileWriteResponse {
  path: string;
  bytes: number;
  mediaType: string;
  updatedAt: ISODateString;
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
