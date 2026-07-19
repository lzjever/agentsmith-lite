"use client";

import type { ProfileGreetingPreference, ProfileResponse, ProjectAuditAction, ProjectAuditResourceKind, ProjectChatThread as ApiProjectChatThread, PublicModelEndpoint, TaskCapabilities, TaskInteractionItem, TaskInteractionSnapshot, TaskInteractionStreamEvent, TaskMessageReceipt, TaskQueuedMessage } from "../../../packages/contracts/src/api.js";

export type { ProjectAuditAction } from "../../../packages/contracts/src/api.js";
export type { TaskCapabilities, TaskInteractionItem, TaskInteractionSnapshot, TaskInteractionStreamEvent, TaskMessageReceipt, TaskQueuedMessage } from "../../../packages/contracts/src/api.js";
export type { ProfileGreetingPreference };

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
  }
}

const readOnlyMutationMessages = new Set([
  "Project is archived",
  "Project is being deleted",
  "Workspace is archived",
  "Workspace is being deleted"
]);

export function isReadOnlyMutationError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 403 || (error.status === 409 && readOnlyMutationMessages.has(error.message)));
}

export class IdempotencyPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyPendingError";
  }
}

export const SESSION_EXPIRED_EVENT = "agentsmith:session-expired";
export const DIRECTORY_CHANGED_EVENT = "agentsmith:directory-changed";
export const IDENTITY_CHANGED_EVENT = "agentsmith:identity-changed";
export const NOTIFICATIONS_CHANGED_EVENT = "agentsmith:notifications-changed";

export type NotificationChangeSource = "bell" | "page";

export function notifyDirectoryChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DIRECTORY_CHANGED_EVENT));
}

export function notifyIdentityChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(IDENTITY_CHANGED_EVENT));
}

export function notifyNotificationsChanged(source: NotificationChangeSource): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT, { detail: { source } }));
}

export function notificationChangeSource(event: Event): NotificationChangeSource | undefined {
  return event instanceof CustomEvent ? event.detail?.source : undefined;
}

export function isMissingNotification(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 404 && error.message === "Notification not found";
}

export interface CurrentUser { id: string; email: string; displayName?: string; pictureUrl?: string; }
export type Profile = ProfileResponse;
export interface SettingsCapabilities { canManageSettings: boolean; }
export interface WorkspaceSettings { workspace: Workspace; capabilities: SettingsCapabilities; }
export interface ProjectSettings { project: Project; workspaceLifecycleStatus: "active" | "archived" | "deleting"; capabilities: SettingsCapabilities; }
export interface Project { id: string; workspaceId: string; name: string; ownerUserId?: string; lifecycleStatus?: "active" | "archived" | "deleting"; pinnedAt?: string | null; taskConcurrencyLimit: number; createdAt: string; updatedAt: string; }
export interface Workspace { id: string; name: string; ownerUserId?: string; owner?: { displayName: string | null; email: string }; memberRole?: WorkspaceMemberRole; lifecycleStatus?: "active" | "archived" | "deleting"; projects: Project[]; capabilities: { canCreateProject: boolean; canManageMembers: boolean }; createdAt: string; updatedAt: string; }
export type MemberRole = "owner" | "admin" | "member" | "viewer";
export interface ProjectMember { projectId: string; userId: string; role: MemberRole; displayName: string | null; email: string; createdAt: string; updatedAt: string; }
export type WorkspaceMemberRole = "owner" | "admin" | "member" | "viewer";
export interface WorkspaceMember { workspaceId: string; userId: string; role: WorkspaceMemberRole; displayName: string | null; email: string; createdAt: string; updatedAt: string; }
export interface ProjectCapabilities { canManageEndpoints: boolean; canManageMembers: boolean; canManagePolicy: boolean; canWriteFiles: boolean; canCreateTasks: boolean; canCancelTasks: boolean; canSendChat: boolean; }
export type ProjectOverviewAction = "configure_endpoint" | "start_chat" | "create_task" | "add_collaborator";
export interface ProjectOverview { project: Project; workspaceLifecycleStatus: "active" | "archived" | "deleting"; capabilities: ProjectCapabilities; owner: { displayName: string | null; email: string } | null; memberRole: MemberRole; chatReadyEndpointCount: number; taskReadyEndpointCount: number; recommendedActions: ProjectOverviewAction[]; }
export type EndpointCapability = "text" | "image" | "tool_calls";
export type Endpoint = PublicModelEndpoint;
export interface EndpointModelDiscovery { models: string[]; health: { status: "healthy" | "unavailable" | "unknown"; checkedAt: string | null; errorCategory: "auth" | "network" | "upstream" | "timeout" | "rate_limit" | "unknown" | null }; }
export interface EndpointInput {
  name: string; baseUrl: string; model: string; credentialId: string; capabilities: EndpointCapability[]; requestTimeoutSecs: number;
}
export interface ProjectCredential { id: string; projectId: string; name: string; type: "api_key"; baseUrl: string; fingerprint: string; version: number; createdAt: string; lastRotatedAt: string | null; updatedAt: string; }
export type TaskStatus = "queued" | "starting" | "running" | "stopping" | "completed" | "failed" | "expired" | "cleaned" | "cancelled";
export type TaskExecutionMode = "dry-run" | "live";
export interface Task {
  id: string; workspaceId: string; projectId: string; endpointId: string; prompt: string; status: TaskStatus; runId: string;
  title?: string;
  inputPaths?: string[];
  archivedAt?: string | null;
  deletedAt?: string | null;
  terminalReason?: "completed" | "failed" | "cancelled" | "expired" | "not_executed" | "cleaned_legacy" | null;
  terminalizedAt?: string | null;
  artifactProjectionStatus?: "pending" | "draining" | "drained" | "failed";
  artifactProjectionError?: string | null;
  cleanupStatus?: "pending" | "running" | "completed" | "failed";
  cleanupError?: string | null;
  sourceTaskId?: string | null;
  finalizationIntentStatus?: Extract<TaskStatus, "completed" | "failed" | "expired" | "cleaned"> | null;
  executionMode: TaskExecutionMode;
  sandbox: { namespace: string };
  createdAt: string; updatedAt: string;
}
export interface TaskDetail { task: Task; capabilities: TaskCapabilities; }
export interface TaskArtifact { id: string; taskId: string; fileId: string; name: string; bytes: number; sha256?: string; mediaType?: string | null; previewText?: string | null; createdAt: string; }
export interface TaskInput { path: string; name: string; bytes: number; sha256: string; }
export interface ProjectFile { name: string; path: string; type: "file" | "directory"; size?: number; mediaType?: string; updatedAt: string; }
export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage { role: ChatRole; content: string; }
export interface ChatResponse {
  message: ChatMessage;
  endpointSnapshot: Pick<Endpoint, "id" | "baseUrl" | "model" | "protocol">;
  usage?: { requests?: number; tokens?: number; cost?: number; };
}
export type ProjectChatThread = ApiProjectChatThread;
export type TaskListSort = "created_at" | "updated_at" | "title" | "status";
export type TaskListArchivedFilter = "exclude" | "include" | "only";
export interface TaskListQuery { search?: string | undefined; statuses?: TaskStatus[] | undefined; archived?: TaskListArchivedFilter | undefined; sort?: TaskListSort | undefined; direction?: "asc" | "desc" | undefined; cursor?: string | undefined; limit?: number | undefined; }
export interface TaskListPage { items: Task[]; nextCursor: string | null; total: number; }
export interface ProjectChatMessage extends ChatMessage { id: string; threadId: string; sequence:number;version:number;deliveryStatus:"pending"|"response_pending"|"completed"|"failed"|"stopped";createdAt: string;updatedAt:string; }
export interface ProjectChatSendResponse { message: ProjectChatMessage; endpointSnapshot: Pick<Endpoint, "id" | "baseUrl" | "model" | "protocol">; }
export type ContextScope = "workspace_shared" | "workspace_personal" | "project_shared" | "project_personal";
export type ContextContentType = "text" | "json" | "markdown" | "yaml";
export interface ContextEntry { id: string; workspaceId: string; projectId: string | null; ownerUserId: string | null; scope: ContextScope; contextKey: string; content: string; contentType: ContextContentType; version: number; createdAt: string; updatedAt: string; }
export interface ContextList { items: ContextEntry[]; canWrite: boolean; }
export interface ProjectResourcePolicy {
  projectId: string;
  activeTasksLimit: number;
  providerRequestsLimit: number | null;
  providerTokensLimit: number | null;
  providerCostLimit: number | null;
  projectFileBytesLimit: number | null;
  endpointWindows?: Array<{endpointId:string;metric:"providerRequests"|"providerTokens"|"providerCost";limit:number;windowSeconds:number}>;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectResourceUsage {
  projectId: string;
  activeTasks: number;
  providerRequests: number;
  providerTokens: number;
  providerCost: number;
  projectFileBytes: number;
  updatedAt: string;
}
export type ProjectUsageMetric = "activeTasks" | "providerRequests" | "providerTokens" | "providerCost" | "projectFileBytes";
export type ProjectUsageWindow = { kind: "current_gauge"; resetAt: null; } | { kind: "project_lifetime"; startedAt: string; resetAt: null; } | { kind:"rolling";windowSeconds:number;startedAt:string;resetAt:string|null };
export interface ProjectUsageLimit { metric: ProjectUsageMetric; current: number; limit: number | null; remaining: number | null; window: ProjectUsageWindow; }
export interface ProjectUsageDay { date: string; requests: number; tokens: number; cost: number; }
export interface ProjectUsageEndpoint { endpointId: string | null; endpointName: string; requests: number; tokens: number; cost: number;limits?:ProjectUsageLimit[]; }
export interface ProjectUsageOverview { projectId: string; usage: ProjectResourceUsage; limits: ProjectUsageLimit[]; daily: ProjectUsageDay[]; trendTotals: { requests: number; tokens: number; cost: number }; endpoints: ProjectUsageEndpoint[]; selectedEndpointId: string | null; }
export interface ProjectAlert { id: string; projectId: string; type: "active_tasks_limit" | "provider_requests_limit" | "provider_tokens_limit" | "provider_cost_limit" | "project_file_bytes_limit" | "endpoint_failure" | "provider_failure" | "task_failure" | "sandbox_failure"; status: "active" | "resolved" | "dismissed"; deliveryStatus: "not_configured" | "pending" | "delivered" | "failed";ruleId?:string|null;metric?:string|null;metricValue?:number|null;threshold?:number|null;endpointId?:string|null;acknowledgedAt?:string|null;acknowledgedBy?:string|null;silencedUntil?:string|null; createdAt: string; updatedAt: string; resolvedAt: string | null; dismissedAt: string | null; }
export interface ProjectAlertPage { items: ProjectAlert[]; nextCursor: string | null; activeCount: number; }
export type ProjectAlertType = ProjectAlert["type"];
export interface ProjectAlertRule { id: string; projectId: string;name?:string; alertType: ProjectAlertType;metric?:string;threshold?:number;windowSeconds?:number|null;scope?:{kind:"project"}|{kind:"endpoint";endpointId:string}; enabled: boolean; createdAt: string; updatedAt: string; }
export interface UserNotification { id: string; type: string; title: string; body: string | null; projectId: string | null; resourceKind: ProjectAuditEvent["resourceKind"] | null; resourceId: string | null; linkPath: string | null; readAt: string | null; createdAt: string; }
export interface ProjectAuditEvent { id: string; projectId: string; actorId: string | null; actorDisplayName: string | null; actorEmail: string | null; action: ProjectAuditAction; status: "accepted" | "rejected"; resourceKind: ProjectAuditResourceKind; resourceId: string | null;detail?:Record<string,string|number>; createdAt: string; }
export interface ProjectPolicyInput {
  activeTasksLimit?: number;
  providerRequestsLimit?: number | null;
  providerTokensLimit?: number | null;
  providerCostLimit?: number | null;
  projectFileBytesLimit?: number | null;
  endpointWindows?:Array<{endpointId:string;metric:"providerRequests"|"providerTokens"|"providerCost";limit:number;windowSeconds:number}>;
}
export type ProjectPolicyUpdate = ProjectPolicyInput & { expectedUpdatedAt: string };

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH || "/api/v1";
let csrfToken: string | undefined;
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() || "GET";
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    if (!csrfToken) await apiClient.currentIdentity();
    headers.set("x-csrf-token", csrfToken || "");
    headers.set("content-type", "application/json");
  }
  const response = observeSession(await fetch(`${apiBasePath}${path}`, { ...init, headers, credentials: "same-origin" }));
  if (!response.ok) throw await apiResponseError(response);
  return response.json() as Promise<T>;
}

function observeSession(response: Response): Response {
  if (response.status === 401) {
    csrfToken = undefined;
    if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  return response;
}

async function errorMessage(response: Response): Promise<string> {
  return (await apiResponseError(response)).message;
}

async function apiResponseError(response: Response): Promise<Error> {
  const text = await response.text();
  if (!text) return new ApiError(response.status, response.statusText);
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object") {
      const code = (body as { code?: unknown }).code;
      const error = (body as { error?: unknown }).error;
      if (code === "idempotency_in_progress" && typeof error === "string") return new IdempotencyPendingError(error);
      if (typeof error === "string") return new ApiError(response.status, error, typeof code === "string" ? code : undefined);
      if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
        return new ApiError(response.status, (error as { message: string }).message);
      }
    }
  } catch {
    // Preserve a non-JSON API error verbatim.
  }
  return new ApiError(response.status, text);
}

function json<T>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  return request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function jsonIdempotent<T>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", idempotencyKey: string, body?: unknown): Promise<T> {
  return request<T>(path, { method, headers: { "idempotency-key": idempotencyKey }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export const apiClient = {
  async currentIdentity(): Promise<{ user: CurrentUser }> {
    const identity = await request<{ user: CurrentUser; csrfToken: string }>("/me");
    csrfToken = identity.csrfToken;
    return { user: identity.user };
  },
  logout: () => json<{ loggedOut: true; redirectUrl: string }>("/auth/logout", "POST"),
  notifications: (unreadOnly = false) => request<UserNotification[]>(`/notifications${unreadOnly ? "?unread=true" : ""}`),
  markNotificationRead: (notificationId: string) => json<UserNotification>(`/notifications/${encodeURIComponent(notificationId)}/read`, "PATCH"),
  markAllNotificationsRead: () => json<UserNotification[]>("/notifications/read", "PATCH"),
  dismissNotification: (notificationId: string) => json<{ dismissed: true }>(`/notifications/${encodeURIComponent(notificationId)}`, "DELETE"),
  profile: () => request<Profile>("/me/profile"),
  updateProfile: (input: { displayName?: string | null; timezone?: string | null; bio?: string | null; jobTitle?: string | null; company?: string | null; greetingPreference?: ProfileGreetingPreference | null; interests?: string[]; expectedUpdatedAt: string }) => json<Profile>("/me/profile", "PATCH", input),
  workspaces: () => request<Workspace[]>("/workspaces"),
  createWorkspace: (name: string, idempotencyKey: string) => jsonIdempotent<Workspace>("/workspaces", "POST", idempotencyKey, { name }),
  deleteWorkspace: (workspaceId: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/workspaces/${encodeURIComponent(workspaceId)}`, "DELETE", idempotencyKey),
  workspaceSettings: (workspaceId: string) => request<WorkspaceSettings>(`/workspaces/${encodeURIComponent(workspaceId)}/settings`),
  updateWorkspaceSettings: (workspaceId: string, input: { name?: string; expectedName: string }, idempotencyKey: string) => jsonIdempotent<WorkspaceSettings>(`/workspaces/${encodeURIComponent(workspaceId)}/settings`, "PATCH", idempotencyKey, input),
  archiveWorkspace: (workspaceId:string,idempotencyKey:string) => jsonIdempotent<Workspace>(`/workspaces/${encodeURIComponent(workspaceId)}/settings/archive`,"POST",idempotencyKey),
  unarchiveWorkspace: (workspaceId:string,idempotencyKey:string) => jsonIdempotent<Workspace>(`/workspaces/${encodeURIComponent(workspaceId)}/settings/unarchive`,"POST",idempotencyKey),
  createProject: (workspaceId: string, input: { name: string; taskConcurrencyLimit?: number }, idempotencyKey: string) =>
    jsonIdempotent<Project>(`/workspaces/${encodeURIComponent(workspaceId)}/projects`, "POST", idempotencyKey, input),
  setProjectPinned: (projectId:string,pinned:boolean) => json<Project>(`/projects/${encodeURIComponent(projectId)}/pin`,"PUT",{pinned}),
  workspaceMembers: (workspaceId: string) => request<WorkspaceMember[]>(`/workspaces/${encodeURIComponent(workspaceId)}/members`),
  addWorkspaceMember: (workspaceId: string, email: string, role: Exclude<WorkspaceMemberRole, "owner">, idempotencyKey: string) => jsonIdempotent<WorkspaceMember>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, "POST", idempotencyKey, { email, role }),
  changeWorkspaceMember: (workspaceId: string, userId: string, role: Exclude<WorkspaceMemberRole, "owner">, expectedUpdatedAt: string, idempotencyKey: string) => jsonIdempotent<WorkspaceMember>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, "PATCH", idempotencyKey, { userId, role, expectedUpdatedAt }),
  removeWorkspaceMember: (workspaceId: string, userId: string, expectedUpdatedAt: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, "DELETE", idempotencyKey, { userId, expectedUpdatedAt }),
  transferWorkspaceOwner:(workspaceId:string,userId:string,idempotencyKey:string)=>jsonIdempotent<{transferred:true}>(`/workspaces/${encodeURIComponent(workspaceId)}/members/transfer-owner`,"POST",idempotencyKey,{userId}),
  projectCapabilities: (projectId: string) => request<ProjectCapabilities>(`/projects/${encodeURIComponent(projectId)}/capabilities`),
  projectOverview: (projectId: string) => request<ProjectOverview>(`/projects/${encodeURIComponent(projectId)}/overview`),
  projectSettings: (projectId: string) => request<ProjectSettings>(`/projects/${encodeURIComponent(projectId)}/settings`),
  updateProjectSettings: (projectId: string, input: { name?: string; expectedName: string }, idempotencyKey: string) => jsonIdempotent<ProjectSettings>(`/projects/${encodeURIComponent(projectId)}/settings`, "PATCH", idempotencyKey, input),
  archiveProject:(projectId:string,idempotencyKey:string)=>jsonIdempotent<Project>(`/projects/${encodeURIComponent(projectId)}/settings/archive`,"POST",idempotencyKey),
  unarchiveProject:(projectId:string,idempotencyKey:string)=>jsonIdempotent<Project>(`/projects/${encodeURIComponent(projectId)}/settings/unarchive`,"POST",idempotencyKey),
  deleteProject: (projectId: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}`, "DELETE", idempotencyKey),
  members: (projectId: string) => request<ProjectMember[]>(`/projects/${encodeURIComponent(projectId)}/members`),
  addMember: (projectId: string, userId: string, role: Exclude<MemberRole, "owner">, idempotencyKey: string) =>
    jsonIdempotent<ProjectMember>(`/projects/${encodeURIComponent(projectId)}/members`, "POST", idempotencyKey, { userId, role }),
  changeMember: (projectId: string, userId: string, role: Exclude<MemberRole, "owner">, expectedUpdatedAt: string, idempotencyKey: string) =>
    jsonIdempotent<ProjectMember>(`/projects/${encodeURIComponent(projectId)}/members`, "PATCH", idempotencyKey, { userId, role, expectedUpdatedAt }),
  removeMember: (projectId: string, userId: string, expectedUpdatedAt: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/members`, "DELETE", idempotencyKey, { userId, expectedUpdatedAt }),
  transferProjectOwner:(projectId:string,userId:string,idempotencyKey:string)=>jsonIdempotent<{transferred:true}>(`/projects/${encodeURIComponent(projectId)}/members/transfer-owner`,"POST",idempotencyKey,{userId}),
  credentials: (projectId: string) => request<ProjectCredential[]>(`/projects/${encodeURIComponent(projectId)}/credentials`),
  createCredential: (projectId: string, input: { name: string; baseUrl: string; secret: string }, idempotencyKey: string) => jsonIdempotent<ProjectCredential>(`/projects/${encodeURIComponent(projectId)}/credentials`, "POST", idempotencyKey, input),
  rotateCredential: (projectId: string, credentialId: string, secret: string, idempotencyKey: string) => jsonIdempotent<ProjectCredential>(`/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}/rotate`, "POST", idempotencyKey, { secret }),
  deleteCredential: (projectId: string, credentialId: string, expectedVersion: number, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}`, "DELETE", idempotencyKey, { expectedVersion }),
  endpoints: (projectId: string) => request<Endpoint[]>(`/projects/${encodeURIComponent(projectId)}/endpoints`),
  createEndpoint: (projectId: string, input: EndpointInput, idempotencyKey: string) => jsonIdempotent<Endpoint>(`/projects/${encodeURIComponent(projectId)}/endpoints`, "POST", idempotencyKey, { ...input, protocol: "openai_chat_completions" }),
  updateEndpoint: (projectId: string, endpointId: string, input: EndpointInput & { expectedUpdatedAt: string }, idempotencyKey: string) =>
    jsonIdempotent<Endpoint>(`/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}`, "PATCH", idempotencyKey, { ...input, protocol: "openai_chat_completions" }),
  discoverEndpointModels: (projectId: string, input: Pick<EndpointInput, "baseUrl" | "credentialId" | "requestTimeoutSecs"> & { endpointId?: string }, idempotencyKey: string) =>
    jsonIdempotent<EndpointModelDiscovery>(`/projects/${encodeURIComponent(projectId)}/endpoints/models`, "POST", idempotencyKey, input),
  recheckEndpoint: (projectId: string, endpointId: string, idempotencyKey: string) =>
    jsonIdempotent<Endpoint>(`/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}/health`, "POST", idempotencyKey),
  deleteEndpoint: (projectId: string, endpointId: string, idempotencyKey: string) =>
    jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}`, "DELETE", idempotencyKey),
  chatThreads: (projectId: string, query?: string) => request<ProjectChatThread[]>(`/projects/${encodeURIComponent(projectId)}/chat/threads${query ? `?query=${encodeURIComponent(query)}` : ""}`),
  createChatThread: (projectId: string, endpointId: string, idempotencyKey: string) => jsonIdempotent<ProjectChatThread>(`/projects/${encodeURIComponent(projectId)}/chat/threads`, "POST", idempotencyKey, { endpointId }),
  updateChatThread: (projectId: string, threadId: string, input: { title?: string | null; pinned?: boolean;starred?:boolean }, idempotencyKey: string) => jsonIdempotent<ProjectChatThread>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}`, "PATCH", idempotencyKey, input),
  deleteChatThread: (projectId: string, threadId: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}`, "DELETE", idempotencyKey),
  chatMessages: (projectId: string, threadId: string) => request<ProjectChatMessage[]>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages`),
  editChatMessage:(projectId:string,threadId:string,messageId:string,input:{content:string;expectedVersion:number},idempotencyKey:string)=>jsonIdempotent<ProjectChatMessage>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,"PATCH",idempotencyKey,input),
  deleteChatMessage:(projectId:string,threadId:string,messageId:string,expectedVersion:number,idempotencyKey:string)=>jsonIdempotent<{deleted:true}>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,"DELETE",idempotencyKey,{expectedVersion}),
  branchChatMessage:(projectId:string,threadId:string,messageId:string,expectedVersion:number,idempotencyKey:string)=>jsonIdempotent<ProjectChatThread>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/branch`,"POST",idempotencyKey,{expectedVersion}),
  async retryChatMessage(projectId:string,threadId:string,messageId:string,expectedVersion:number,signal:AbortSignal|undefined,onDelta:(delta:string)=>void):Promise<ProjectChatSendResponse>{if(!csrfToken)await apiClient.currentIdentity();const response=observeSession(await fetch(`${apiBasePath}/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/retry`,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrfToken??""},body:JSON.stringify({expectedVersion}),...(signal?{signal}:{})}));return readChatStream(response,onDelta);},
  async sendChatMessage(projectId: string, threadId: string, content: string, afterMessageId:string|null,signal: AbortSignal | undefined, onDelta: (delta: string) => void): Promise<ProjectChatSendResponse> {
    if (!csrfToken) await apiClient.currentIdentity();
    const response = observeSession(await fetch(`${apiBasePath}/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages`, { method:"POST", credentials:"same-origin", headers:{"content-type":"application/json","x-csrf-token":csrfToken??""}, body:JSON.stringify({content,afterMessageId}), ...(signal ? { signal } : {}) }));
    return readChatStream(response,onDelta);
  },
  contexts: (input: { workspaceId: string; scope: ContextScope; projectId?: string }) => {
    const query = new URLSearchParams({ workspaceId: input.workspaceId, scope: input.scope });
    if (input.projectId) query.set("projectId", input.projectId);
    return request<ContextList>(`/context?${query.toString()}`);
  },
  saveContext: (input: { workspaceId: string; projectId?: string; scope: ContextScope; contextKey: string; previousContextKey?: string; expectedVersion?: number; content: string; contentType: ContextContentType }, idempotencyKey: string) => jsonIdempotent<ContextEntry>("/context", "PUT", idempotencyKey, input),
  deleteContext: (input: { workspaceId: string; projectId?: string; scope: ContextScope; contextKey: string; expectedVersion: number }, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>("/context", "DELETE", idempotencyKey, input),
  policy: (projectId: string) => request<ProjectResourcePolicy>(`/projects/${encodeURIComponent(projectId)}/policy`),
  updatePolicy: (projectId: string, input: ProjectPolicyUpdate, idempotencyKey: string) =>
    jsonIdempotent<ProjectResourcePolicy>(`/projects/${encodeURIComponent(projectId)}/policy`, "PATCH", idempotencyKey, input),
  usage: (projectId: string, endpointId?: string) => request<ProjectUsageOverview>(`/projects/${encodeURIComponent(projectId)}/usage${endpointId ? `?endpointId=${encodeURIComponent(endpointId)}` : ""}`),
  alerts: (projectId: string, query: { status?: ProjectAlert["status"]; cursor?: string; limit?: number } = {}) => { const params=new URLSearchParams();if(query.status)params.set("status",query.status);if(query.cursor)params.set("cursor",query.cursor);if(query.limit)params.set("limit",String(query.limit));return request<ProjectAlertPage>(`/projects/${encodeURIComponent(projectId)}/alerts${params.size?`?${params}`:""}`); },
  alert: (projectId:string,alertId:string) => request<ProjectAlert>(`/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}`),
  transitionAlert: (projectId: string, alertId: string, status: "resolved" | "dismissed", idempotencyKey: string) => jsonIdempotent<ProjectAlert>(`/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}`, "PATCH", idempotencyKey, { status }),
  acknowledgeAlert:(projectId:string,alertId:string,idempotencyKey:string)=>jsonIdempotent<ProjectAlert>(`/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}/acknowledge`,"POST",idempotencyKey,{}),
  silenceAlert:(projectId:string,alertId:string,silencedUntil:string|null,idempotencyKey:string)=>jsonIdempotent<ProjectAlert>(`/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}/silence`,"POST",idempotencyKey,{silencedUntil}),
  alertRules: (projectId: string) => request<ProjectAlertRule[]>(`/projects/${encodeURIComponent(projectId)}/alert-rules`),
  createAlertRule: (projectId: string, input: { name?:string;alertType:ProjectAlertType;threshold?:number;windowSeconds?:number|null;scope?:{kind:"project"}|{kind:"endpoint";endpointId:string};enabled?:boolean }, idempotencyKey: string) => jsonIdempotent<ProjectAlertRule>(`/projects/${encodeURIComponent(projectId)}/alert-rules`, "POST", idempotencyKey, input),
  updateAlertRule: (projectId: string, ruleId: string, input: { name?:string;alertType?:ProjectAlertType;threshold?:number;windowSeconds?:number|null;scope?:{kind:"project"}|{kind:"endpoint";endpointId:string};enabled?:boolean;expectedUpdatedAt:string }, idempotencyKey: string) => jsonIdempotent<ProjectAlertRule>(`/projects/${encodeURIComponent(projectId)}/alert-rules/${encodeURIComponent(ruleId)}`, "PATCH", idempotencyKey, input),
  deleteAlertRule: (projectId: string, ruleId: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/alert-rules/${encodeURIComponent(ruleId)}`, "DELETE", idempotencyKey),
  testAlertRule:(projectId:string,ruleId:string)=>json<{matched:boolean;metric:string;value:number;threshold:number;evaluatedAt:string}>(`/projects/${encodeURIComponent(projectId)}/alert-rules/${encodeURIComponent(ruleId)}/test`,"POST",{}),
  async audit(projectId: string, query:Record<string,string|number|undefined>={}): Promise<{items:ProjectAuditEvent[];nextCursor:string|null}> {
    const params=new URLSearchParams();for(const [key,value] of Object.entries(query))if(value!==undefined)params.set(key,String(value));
    const payload = await request<{items:unknown[];nextCursor:string|null}>(`/projects/${encodeURIComponent(projectId)}/audit${params.size?`?${params}`:""}`);
    if (!Array.isArray(payload.items) || payload.items.some((event) => !isProjectAuditEvent(event))) throw new ApiError(502, "Audit response contains an unknown action.");
    return payload as {items:ProjectAuditEvent[];nextCursor:string|null};
  },
  files: (projectId: string, path = "files") => request<{ entries: ProjectFile[] }>(`/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`),
  async uploadFile(projectId: string, path: string, file: File, options: { overwrite?: boolean; idempotencyKey?: string } = {}): Promise<{ path: string; bytes: number; mediaType: string; updatedAt: string }> {
    if (!csrfToken) await apiClient.currentIdentity();
    const params = new URLSearchParams({ path, ...(options.overwrite ? { overwrite: "true" } : {}) });
    const response = observeSession(await fetch(`${apiBasePath}/projects/${encodeURIComponent(projectId)}/files?${params}`, {
      method: "PUT", credentials: "same-origin", headers: { "x-csrf-token": csrfToken || "", "content-type": file.type || "application/octet-stream", "idempotency-key": options.idempotencyKey ?? newIdempotencyKey("file-upload") }, body: file
    }));
    if (!response.ok) throw await apiResponseError(response);
    return response.json() as Promise<{ path: string; bytes: number; mediaType: string; updatedAt: string }>;
  },
  deleteFile: (projectId: string, path: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/files`, "DELETE", idempotencyKey, { path }),
  fileDownloadUrl: (projectId: string, path: string) => `${apiBasePath}/projects/${encodeURIComponent(projectId)}/files/download?path=${encodeURIComponent(path)}`,
  async downloadProjectFile(projectId: string, path: string, signal?: AbortSignal): Promise<Blob> {
    const response = observeSession(await fetch(apiClient.fileDownloadUrl(projectId, path), { credentials:"same-origin", ...(signal ? { signal } : {}) }));
    if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
    return response.blob();
  },
  tasks: (projectId: string, query: TaskListQuery = {}) => {
    const params = new URLSearchParams();
    if (query.search) params.set("search", query.search);
    if (query.statuses?.length) params.set("status", query.statuses.join(","));
    if (query.archived) params.set("archived", query.archived);
    if (query.sort) params.set("sort", query.sort);
    if (query.direction) params.set("direction", query.direction);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit) params.set("limit", String(query.limit));
    return request<TaskListPage>(`/projects/${encodeURIComponent(projectId)}/tasks?${params}`);
  },
  createTask: (projectId: string, input: { prompt: string; endpointId: string; title?: string; inputPaths?: string[] }, idempotencyKey: string) => jsonIdempotent<Task>(`/projects/${encodeURIComponent(projectId)}/tasks`, "POST", idempotencyKey, input),
  task: (taskId: string) => request<Task>(`/tasks/${encodeURIComponent(taskId)}`),
  taskDetail: (taskId: string) => request<TaskDetail>(`/tasks/${encodeURIComponent(taskId)}/detail`),
  taskInputs: (taskId: string) => request<TaskInput[]>(`/tasks/${encodeURIComponent(taskId)}/inputs`),
  taskInputDownloadUrl: (taskId: string, path: string) => `${apiBasePath}/tasks/${encodeURIComponent(taskId)}/inputs/download?path=${encodeURIComponent(path)}`,
  taskTerminalWebSocketUrl: (taskId:string) => taskTerminalWebSocketUrlForApiBase(apiBasePath,taskId,window.location.href),
  getTaskInteractions: (taskId: string, cursor?: string) => request<TaskInteractionSnapshot>(`/tasks/${encodeURIComponent(taskId)}/interactions${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`),
  async streamTaskInteractions(taskId: string, cursor: string | undefined, signal: AbortSignal, onEvent: (event: TaskInteractionStreamEvent) => void): Promise<void> {
    const response = observeSession(await fetch(`${apiBasePath}/tasks/${encodeURIComponent(taskId)}/interactions/stream${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`, {
      credentials: "same-origin",
      headers: { accept: "text/event-stream", ...(cursor ? { "last-event-id": cursor } : {}) },
      signal
    }));
    if (!response.ok || !response.body) throw new ApiError(response.status, await errorMessage(response));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const receive = (frames: string[]) => {
      for (const frame of frames) {
        const event = /^event:\s*(.+)$/m.exec(frame)?.[1];
        const cursor = /^id:\s*(.+)$/m.exec(frame)?.[1];
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trimStart()).join("\n");
        if (!event || event === "heartbeat" || (!data && event !== "done" && event !== "reconnect")) continue;
        try {
          onEvent(parseTaskInteractionStreamEvent(event, cursor, data ? JSON.parse(data) : undefined));
        } catch {
          throw new ApiError(502, "Task interaction stream contained an invalid event.");
        }
      }
    };
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replaceAll("\r\n", "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      receive(frames);
    }
    buffer = (buffer + decoder.decode()).replaceAll("\r\n", "\n");
    const frames = buffer.split("\n\n");
    receive(frames.slice(0, -1));
    if (frames.at(-1)?.trim()) receive([frames.at(-1)!]);
  },
  sendTaskMessage: (taskId: string, content: string, idempotencyKey: string) => jsonIdempotent<TaskMessageReceipt>(`/tasks/${encodeURIComponent(taskId)}/messages`, "POST", idempotencyKey, { content }),
  updateTaskMessage: (taskId: string, messageId: string, content: string, idempotencyKey: string) => jsonIdempotent<TaskMessageReceipt>(`/tasks/${encodeURIComponent(taskId)}/messages/${encodeURIComponent(messageId)}`, "PATCH", idempotencyKey, { content }),
  deleteTaskMessage: (taskId: string, messageId: string, idempotencyKey: string) => jsonIdempotent<TaskMessageReceipt>(`/tasks/${encodeURIComponent(taskId)}/messages/${encodeURIComponent(messageId)}`, "DELETE", idempotencyKey),
  abortTaskTurn: (taskId: string, idempotencyKey: string) => jsonIdempotent<unknown>(`/tasks/${encodeURIComponent(taskId)}/turn/abort`, "POST", idempotencyKey, {}),
  stopTaskWork: (taskId: string, interactionId: string, idempotencyKey: string) => jsonIdempotent<unknown>(`/tasks/${encodeURIComponent(taskId)}/work/${encodeURIComponent(interactionId)}/stop`, "POST", idempotencyKey, {}),
  editTask: (taskId: string, title: string, idempotencyKey: string) => jsonIdempotent<Task>(`/tasks/${encodeURIComponent(taskId)}`, "PATCH", idempotencyKey, { title }),
  retryTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<Task>(`/tasks/${encodeURIComponent(taskId)}/retry`, "POST", idempotencyKey, {}),
  duplicateTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<Task>(`/tasks/${encodeURIComponent(taskId)}/duplicate`, "POST", idempotencyKey, {}),
  archiveTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<Task>(`/tasks/${encodeURIComponent(taskId)}/archive`, "POST", idempotencyKey, {}),
  deleteTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true; taskId: string }>(`/tasks/${encodeURIComponent(taskId)}`, "DELETE", idempotencyKey),
  taskArtifacts: (taskId: string, filter: { mediaType?: string; previewOnly?: boolean } = {}) => request<TaskArtifact[]>(`/tasks/${encodeURIComponent(taskId)}/artifacts?${new URLSearchParams({ ...(filter.mediaType ? { mediaType: filter.mediaType } : {}), ...(filter.previewOnly ? { preview: "true" } : {}) })}`),
  cancelTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<Task>(`/tasks/${encodeURIComponent(taskId)}/cancel`, "POST", idempotencyKey, {}),
  artifactDownloadUrl: (taskId: string, artifactId: string) => `${apiBasePath}/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}/download`,
  async downloadTaskArtifact(taskId: string, artifactId: string, signal?: AbortSignal): Promise<Blob> {
    const response = observeSession(await fetch(`${apiBasePath}/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}/download`, { credentials: "same-origin", ...(signal ? { signal } : {}) }));
    if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
    return response.blob();
  }
};

export function taskTerminalWebSocketUrlForApiBase(basePath:string,taskId:string,pageUrl:string):string{
  const url=new URL(basePath,pageUrl);
  url.protocol=url.protocol==="https:"?"wss:":"ws:";
  url.pathname=`${url.pathname.replace(/\/$/,"")}/tasks/${encodeURIComponent(taskId)}/terminal/ws`;
  url.search="";
  url.hash="";
  return url.toString();
}

export const oidcStartUrl = `${apiBasePath}/auth/oidc/start`;

export function oidcStartUrlForReturnTo(returnTo: string): string {
  return `${oidcStartUrl}?${new URLSearchParams({ returnTo }).toString()}`;
}

export function newIdempotencyKey(operation: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-${operation}-${id}`;
}

function isProjectAuditEvent(value: unknown): value is ProjectAuditEvent {
  return Boolean(value && typeof value === "object" && "action" in value && typeof value.action === "string" && value.action.length > 0 && "resourceKind" in value && typeof value.resourceKind === "string" && value.resourceKind.length > 0);
}

function parseTaskInteractionStreamEvent(event: string, cursor: string | undefined, value: unknown): TaskInteractionStreamEvent {
  if (event === "interaction" && cursor && isTaskInteractionItem(value)) return { type: "interaction", cursor, item: value };
  if (event === "state" && isRecord(value) && isTaskQueuedMessageArray(value.queuedMessages) && isTaskCapabilities(value.capabilities)) return {
    type: "state",
    queuedMessages: value.queuedMessages,
    capabilities: value.capabilities
  };
  if (event === "run_state" && isRecord(value) && isTaskRunState(value.runState)) return { type: "run_state", runState: value.runState };
  if (event === "connection" && isRecord(value) && isConnectionState(value.connectionState) && isRuntimeReachability(value.runtimeReachability) && isHistoryStatus(value.historyStatus) && isNullableString(value.lastSyncedAt) && isNullableString(value.message)) return {
    type: "connection",
    connectionState: value.connectionState,
    runtimeReachability: value.runtimeReachability,
    historyStatus: value.historyStatus,
    lastSyncedAt: value.lastSyncedAt,
    message: value.message
  };
  if (event === "assistant_preview" && isRecord(value) && typeof value.interactionId === "string" && typeof value.body === "string" && typeof value.occurredAt === "string") return { type: "assistant_preview", interactionId: value.interactionId, body: value.body, occurredAt: value.occurredAt };
  if (event === "assistant_preview_clear" && isRecord(value) && typeof value.interactionId === "string") return { type: "assistant_preview_clear", interactionId: value.interactionId };
  if (event === "reset" && isTaskInteractionSnapshot(value)) return { type: "reset", snapshot: value };
  if (event === "reconnect") return { type: "reconnect" };
  if (event === "done") return { type: "done" };
  throw new ApiError(502, "Task interaction stream contained an unknown event.");
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function isTaskInteractionSnapshot(value: unknown): value is TaskInteractionSnapshot {
  return isRecord(value)
    && Array.isArray(value.items) && value.items.every(isTaskInteractionItem)
    && isNullableString(value.nextPageCursor) && typeof value.hasMoreBefore === "boolean" && typeof value.streamCursor === "string"
    && isTaskInteractionState(value);
}

function isTaskInteractionState(value: unknown): value is Pick<TaskInteractionSnapshot, "queuedMessages" | "runState" | "runtimeReachability" | "historyStatus" | "lastSyncedAt" | "capabilities"> & Record<string, unknown> {
  return isRecord(value) && isTaskQueuedMessageArray(value.queuedMessages)
    && isTaskRunState(value.runState) && isRuntimeReachability(value.runtimeReachability) && isHistoryStatus(value.historyStatus)
    && isNullableString(value.lastSyncedAt) && isTaskCapabilities(value.capabilities);
}

function isTaskCapabilities(value: unknown): value is TaskCapabilities {
  return isRecord(value)
    && typeof value.sendMessage === "boolean" && typeof value.editQueuedMessage === "boolean"
    && typeof value.abortTurn === "boolean" && typeof value.cancelTask === "boolean"
    && typeof value.openTerminal === "boolean" && typeof value.editTask === "boolean"
    && typeof value.retryTask === "boolean" && typeof value.duplicateTask === "boolean"
    && typeof value.archiveTask === "boolean" && typeof value.deleteTask === "boolean";
}

function isTaskQueuedMessageArray(value: unknown): value is TaskQueuedMessage[] {
  return Array.isArray(value) && value.every((message) => isRecord(message)
    && typeof message.id === "string" && typeof message.content === "string"
    && isStringUnion(message.deliveryStatus, ["pending", "dispatching", "terminal_pending", "failed"])
    && typeof message.editable === "boolean" && typeof message.deletable === "boolean" && typeof message.updatedAt === "string");
}

function isTaskInteractionItem(value: unknown): value is TaskInteractionItem {
  if (!isTaskInteractionBase(value)) return false;
  switch (value.kind) {
    case "user_message": return isStringUnion(value.status, ["pending", "dispatching", "retrying", "accepted", "queued", "rejected", "failed"]);
    case "assistant_message": return isStringUnion(value.status, ["generating", "completed", "failed", "aborted"]);
    case "tool": return isStringUnion(value.executionStatus, ["pending", "running", "completed", "failed", "cancelled"]) && isNullableDeliveryStatus(value.deliveryStatus) && typeof value.toolName === "string" && isNullableString(value.command) && isNullableString(value.outputTail) && isNullableNumber(value.exitCode) && typeof value.detailsOmitted === "boolean" && typeof value.canStop === "boolean";
    case "background_task": return isStringUnion(value.executionStatus, ["queued", "running", "completed", "failed", "cancelled", "timed_out", "lost"]) && isNullableDeliveryStatus(value.deliveryStatus) && typeof value.label === "string" && isNullableString(value.workSummary) && isNullableString(value.result) && isNullableString(value.error) && typeof value.detailsOmitted === "boolean" && typeof value.canStop === "boolean";
    case "task_question": return isStringUnion(value.status, ["waiting", "answered", "expired", "rejected", "reply_failed"]) && typeof value.question === "string" && isNullableString(value.expect) && isNullableString(value.answer);
    case "task_notice": return isStringUnion(value.status, ["accepted", "rejected"]) && isNullableString(value.sender);
    case "task_result": return isStringUnion(value.executionStatus, ["completed", "failed", "cancelled", "timed_out", "lost"]) && isDeliveryStatus(value.deliveryStatus) && isNullableString(value.result) && isNullableString(value.error) && typeof value.detailsOmitted === "boolean";
    case "subagent_result": return isStringUnion(value.executionStatus, ["completed", "failed", "cancelled"]) && isDeliveryStatus(value.deliveryStatus) && typeof value.name === "string" && isNullableString(value.purpose) && isNullableString(value.result) && isNullableString(value.error) && typeof value.detailsOmitted === "boolean";
    case "file": return isStringUnion(value.status, ["available", "failed"]) && typeof value.artifactId === "string" && typeof value.name === "string" && isNullableString(value.mediaType) && typeof value.bytes === "number";
    case "execution_boundary": return isStringUnion(value.status, ["successor_pending", "successor_created", "failed"]) && isNullableString(value.targetTaskId);
    case "system_error": return isStringUnion(value.status, ["active", "resolved"]) && isNullableString(value.code) && typeof value.retryable === "boolean" && typeof value.detailsOmitted === "boolean";
  }
}

function isTaskInteractionBase(value: unknown): value is Record<string, unknown> & { kind: TaskInteractionItem["kind"] } {
  return isRecord(value) && typeof value.id === "string" && typeof value.revision === "number" && typeof value.taskId === "string"
    && isStringUnion(value.kind, ["user_message", "assistant_message", "tool", "background_task", "task_question", "task_notice", "task_result", "subagent_result", "file", "execution_boundary", "system_error"])
    && typeof value.title === "string" && isNullableString(value.body) && isStringUnion(value.contentMode, ["full", "preview", "none"])
    && typeof value.position === "number" && typeof value.occurredAt === "string" && typeof value.updatedAt === "string";
}

function isTaskRunState(value: unknown): value is TaskInteractionSnapshot["runState"] { return isStringUnion(value, ["idle", "starting", "running", "reconnecting", "aborting", "finalizing", "terminal"]); }
function isRuntimeReachability(value: unknown): value is TaskInteractionSnapshot["runtimeReachability"] { return isStringUnion(value, ["unknown", "reachable", "unreachable"]); }
function isHistoryStatus(value: unknown): value is TaskInteractionSnapshot["historyStatus"] { return isStringUnion(value, ["complete", "gap"]); }
function isConnectionState(value: unknown): value is Extract<TaskInteractionStreamEvent, { type: "connection" }>["connectionState"] { return isStringUnion(value, ["connecting", "reconnecting", "connected", "disconnected", "recovered"]); }
function isDeliveryStatus(value: unknown): value is "pending" | "delivered" | "failed" { return isStringUnion(value, ["pending", "delivered", "failed"]); }
function isNullableDeliveryStatus(value: unknown): value is "pending" | "delivered" | "failed" | null { return value === null || isDeliveryStatus(value); }
function isNullableString(value: unknown): value is string | null { return value === null || typeof value === "string"; }
function isNullableNumber(value: unknown): value is number | null { return value === null || typeof value === "number"; }
function isStringUnion<T extends string>(value: unknown, choices: readonly T[]): value is T { return typeof value === "string" && choices.some((choice) => choice === value); }

async function readChatStream(response:Response,onDelta:(delta:string)=>void):Promise<ProjectChatSendResponse>{if(!response.ok||!response.body)throw await apiResponseError(response);const reader=response.body.getReader();const decoder=new TextDecoder();let buffer="";let done:ProjectChatSendResponse|undefined;while(true){const{done:ended,value}=await reader.read();if(ended)break;buffer+=decoder.decode(value,{stream:true});const frames=buffer.split("\n\n");buffer=frames.pop()??"";for(const frame of frames){const type=/event: (.+)/.exec(frame)?.[1];const data=/data: (.+)/.exec(frame)?.[1];if(!data)continue;const value=JSON.parse(data);if(type==="delta")onDelta(value.delta);else if(type==="done")done=value;else if(type==="error")throw new ApiError(502,value.error);}}if(!done)throw new ApiError(502,"Chat stream ended without a final message");return done;}
