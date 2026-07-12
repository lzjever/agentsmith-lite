"use client";

import type { ProfileResponse, ProjectAuditAction, ProjectChatThread as ApiProjectChatThread, PublicModelEndpoint } from "../../../packages/contracts/src/api.js";

export type { ProjectAuditAction } from "../../../packages/contracts/src/api.js";

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface CurrentUser { id: string; email: string; displayName?: string; pictureUrl?: string; }
export type Profile = ProfileResponse;
export interface SettingsCapabilities { canManageSettings: boolean; }
export interface WorkspaceSettings { workspace: Workspace; capabilities: SettingsCapabilities; }
export interface ProjectSettings { project: Project; capabilities: SettingsCapabilities; }
export interface Project { id: string; workspaceId: string; name: string; ownerUserId?: string; lifecycleStatus?: "active" | "archived" | "deleting"; taskConcurrencyLimit: number; createdAt: string; updatedAt: string; }
export interface Workspace { id: string; name: string; ownerUserId?: string; owner?: { displayName: string | null; email: string }; memberRole?: WorkspaceMemberRole; lifecycleStatus?: "active" | "archived" | "deleting"; projects: Project[]; capabilities: { canCreateProject: boolean; canManageMembers: boolean }; createdAt: string; updatedAt: string; }
export type MemberRole = "owner" | "admin" | "member" | "viewer";
export interface ProjectMember { projectId: string; userId: string; role: MemberRole; displayName: string | null; email: string; createdAt: string; updatedAt: string; }
export type WorkspaceMemberRole = "owner" | "admin" | "member" | "viewer";
export interface WorkspaceMember { workspaceId: string; userId: string; role: WorkspaceMemberRole; displayName: string | null; email: string; createdAt: string; updatedAt: string; }
export interface ProjectCapabilities { canManageEndpoints: boolean; canManageMembers: boolean; canManagePolicy: boolean; canWriteFiles: boolean; canCreateTasks: boolean; canCancelTasks: boolean; canSendChat: boolean; }
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
  sandbox: { namespace: string; resources: Array<{ apiVersion: string; kind: string; metadata: { name: string; namespace?: string } }> };
  createdAt: string; updatedAt: string;
}
export type TaskEventKind = "user_input" | "turn_started" | "turn_completed" | "turn_failed" | "assistant_message" | "tool_execution" | "artifact" | "runtime_error" | "diagnostic";
export interface TaskEvent { id: string; taskId: string; kind: TaskEventKind; cursor: string; botifiedSeq: number; botifiedType: string; sessionId: string; payload: Record<string, unknown>; createdAt: string; }
export interface TaskArtifact { id: string; taskId: string; fileId: string; name: string; bytes: number; sha256?: string; mediaType?: string | null; previewText?: string | null; createdAt: string; }
export interface ProjectFile { name: string; path: string; type: "file" | "directory"; size?: number; mediaType?: string; updatedAt: string; }
export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage { role: ChatRole; content: string; }
export interface ChatResponse {
  message: ChatMessage;
  endpointSnapshot: Pick<Endpoint, "id" | "baseUrl" | "model" | "protocol">;
  usage?: { requests?: number; tokens?: number; cost?: number; };
}
export type ProjectChatThread = ApiProjectChatThread;
export interface TaskSummary { taskId: string; eventCount: number; artifactCount: number; updatedAt: string; }
export interface TaskFollowUp {
  id: string; taskId: string; prompt: string; followUpTaskId?: string | null; createdAt: string;
  deliveryStatus?: "pending" | "dispatching" | "terminal_pending" | "accepted" | "successor_created" | "failed";
  safeError?: string | null;
  updatedAt?: string;
  deletedAt?: string | null;
}
export type TaskListSort = "created_at" | "updated_at" | "title" | "status";
export type TaskListArchivedFilter = "exclude" | "include" | "only";
export interface TaskListQuery { search?: string | undefined; statuses?: TaskStatus[] | undefined; archived?: TaskListArchivedFilter | undefined; sort?: TaskListSort | undefined; direction?: "asc" | "desc" | undefined; cursor?: string | undefined; limit?: number | undefined; }
export interface TaskListPage { items: Task[]; nextCursor: string | null; total: number; }
export interface TaskTranscriptEntry { id: string; taskId: string; role: "user" | "assistant" | "tool" | "system"; text: string; cursor: string; eventKind: TaskEventKind; createdAt: string; }
export interface ProjectChatMessage extends ChatMessage { id: string; threadId: string; sequence:number;version:number;deliveryStatus:"pending"|"response_pending"|"completed"|"failed"|"stopped";createdAt: string;updatedAt:string; }
export interface ProjectChatSendResponse { message: ProjectChatMessage; endpointSnapshot: Pick<Endpoint, "id" | "baseUrl" | "model" | "protocol">; }
export type ContextScope = "workspace_shared" | "workspace_personal" | "project_shared" | "project_personal";
export type ContextContentType = "text" | "json" | "markdown" | "yaml";
export interface ContextEntry { id: string; workspaceId: string; projectId: string | null; ownerUserId: string | null; scope: ContextScope; contextKey: string; content: string; contentType: ContextContentType; version: number; createdAt: string; updatedAt: string; }
export interface ContextList { items: ContextEntry[]; canWrite: boolean; }
export interface ProjectResourcePolicy {
  projectId: string;
  activeTasksLimit: number | null;
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
export type ProjectUsageWindow = { kind: "current_gauge"; resetAt: null; } | { kind: "project_lifetime"; startedAt: string; resetAt: null; } | { kind:"rolling";windowSeconds:number;startedAt:string;resetAt:string };
export interface ProjectUsageLimit { metric: ProjectUsageMetric; current: number; limit: number | null; remaining: number | null; window: ProjectUsageWindow; }
export interface ProjectUsageDay { date: string; requests: number; tokens: number; cost: number; }
export interface ProjectUsageEndpoint { endpointId: string; endpointName: string; requests: number; tokens: number; cost: number;limits?:ProjectUsageLimit[]; }
export interface ProjectUsageOverview { projectId: string; usage: ProjectResourceUsage; limits: ProjectUsageLimit[]; daily: ProjectUsageDay[]; trendTotals: { requests: number; tokens: number; cost: number }; endpoints: ProjectUsageEndpoint[]; selectedEndpointId: string | null;currentUser?:{userId:string;requests:number;tokens:number;cost:number}; }
export interface ProjectAlert { id: string; projectId: string; type: "active_tasks_limit" | "provider_requests_limit" | "provider_tokens_limit" | "provider_cost_limit" | "project_file_bytes_limit" | "endpoint_failure" | "provider_failure" | "task_failure" | "sandbox_failure"; status: "active" | "resolved" | "dismissed"; deliveryStatus: "not_configured" | "pending" | "delivered" | "failed";ruleId?:string|null;metric?:string|null;metricValue?:number|null;threshold?:number|null;endpointId?:string|null;acknowledgedAt?:string|null;acknowledgedBy?:string|null;silencedUntil?:string|null; createdAt: string; updatedAt: string; resolvedAt: string | null; dismissedAt: string | null; }
export type ProjectAlertType = ProjectAlert["type"];
export interface ProjectAlertRule { id: string; projectId: string;name?:string; alertType: ProjectAlertType;metric?:string;threshold?:number;windowSeconds?:number|null;scope?:{kind:"project"}|{kind:"endpoint";endpointId:string}; enabled: boolean; createdAt: string; updatedAt: string; }
export interface UserNotification { id: string; type: string; title: string; body: string | null; projectId: string | null; resourceKind: ProjectAuditEvent["resourceKind"] | null; resourceId: string | null; linkPath: string | null; readAt: string | null; createdAt: string; }
export interface ProjectAuditEvent { id: string; projectId: string; actorId: string | null; actorDisplayName: string | null; actorEmail: string | null; action: ProjectAuditAction; status: "accepted" | "rejected"; resourceKind: "project" | "endpoint" | "member" | "task" | "artifact" | "provider" | "file_quota" | "sandbox" | "alert"; resourceId: string | null;detail?:Record<string,string|number>; createdAt: string; }
export interface ProjectPolicyInput {
  activeTasksLimit?: number | null;
  providerRequestsLimit?: number | null;
  providerTokensLimit?: number | null;
  providerCostLimit?: number | null;
  projectFileBytesLimit?: number | null;
  endpointWindows?:Array<{endpointId:string;metric:"providerRequests"|"providerTokens"|"providerCost";limit:number;windowSeconds:number}>;
}

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH || "/api/v1";
let csrfToken: string | undefined;
const projectAuditActions = new Set<ProjectAuditAction>(["policy.update", "endpoint.create", "endpoint.update", "endpoint.delete", "membership.add", "membership.change", "membership.remove", "provider.request","chat.thread.create","chat.thread.update","chat.thread.delete","chat.message.send","chat.message.retry","chat.message.stop","chat.message.edit","chat.message.delete","chat.message.branch", "task.create", "task.cancel", "task.completed", "task.failed", "task.expired", "task.cleaned", "artifact.project", "sandbox.failed", "file.quota", "alert.resolve", "alert.dismiss","alert.rule.create","alert.rule.update","alert.rule.delete","alert.acknowledge","alert.silence"]);

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() || "GET";
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    if (!csrfToken) await apiClient.currentIdentity();
    headers.set("x-csrf-token", csrfToken || "");
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${apiBasePath}${path}`, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
  return response.json() as Promise<T>;
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return response.statusText;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
      return (body as { error: string }).error;
    }
  } catch {
    // Preserve a non-JSON API error verbatim.
  }
  return text;
}

function json<T>(path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  return request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function jsonIdempotent<T>(path: string, method: "POST" | "PATCH" | "DELETE", idempotencyKey: string, body?: unknown): Promise<T> {
  return request<T>(path, { method, headers: { "idempotency-key": idempotencyKey }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export const apiClient = {
  async currentIdentity(): Promise<{ user: CurrentUser }> {
    const identity = await request<{ user: CurrentUser; csrfToken: string }>("/me");
    csrfToken = identity.csrfToken;
    return { user: identity.user };
  },
  logout: () => json<{ loggedOut: true }>("/auth/logout", "POST"),
  notifications: (unreadOnly = false) => request<UserNotification[]>(`/notifications${unreadOnly ? "?unread=true" : ""}`),
  markNotificationRead: (notificationId: string) => json<UserNotification>(`/notifications/${encodeURIComponent(notificationId)}/read`, "PATCH"),
  dismissNotification: (notificationId: string) => json<{ dismissed: true }>(`/notifications/${encodeURIComponent(notificationId)}`, "DELETE"),
  profile: () => request<Profile>("/me/profile"),
  updateProfile: (input: { displayName?: string | null; timezone?: string | null; bio?: string | null; jobTitle?: string | null; company?: string | null; greetingPreference?: string | null; interests?: string[] }) => json<Profile>("/me/profile", "PATCH", input),
  workspaces: () => request<Workspace[]>("/workspaces"),
  createWorkspace: (name: string) => json<Workspace>("/workspaces", "POST", { name }),
  deleteWorkspace: (workspaceId: string) => jsonIdempotent<{ deleted: true }>(`/workspaces/${encodeURIComponent(workspaceId)}`, "DELETE", newIdempotencyKey("workspace-delete")),
  workspaceSettings: (workspaceId: string) => request<WorkspaceSettings>(`/workspaces/${encodeURIComponent(workspaceId)}/settings`),
  updateWorkspaceSettings: (workspaceId: string, input: { name?: string }) => jsonIdempotent<WorkspaceSettings>(`/workspaces/${encodeURIComponent(workspaceId)}/settings`, "PATCH", newIdempotencyKey("workspace-settings"), input),
  archiveWorkspace: (workspaceId:string) => jsonIdempotent<Workspace>(`/workspaces/${encodeURIComponent(workspaceId)}/settings/archive`,"POST",newIdempotencyKey("workspace-archive")),
  unarchiveWorkspace: (workspaceId:string) => jsonIdempotent<Workspace>(`/workspaces/${encodeURIComponent(workspaceId)}/settings/unarchive`,"POST",newIdempotencyKey("workspace-unarchive")),
  createProject: (workspaceId: string, input: { name: string; taskConcurrencyLimit?: number }) =>
    json<Project>(`/workspaces/${encodeURIComponent(workspaceId)}/projects`, "POST", input),
  workspaceMembers: (workspaceId: string) => request<WorkspaceMember[]>(`/workspaces/${encodeURIComponent(workspaceId)}/members`),
  addWorkspaceMember: (workspaceId: string, email: string, role: Exclude<WorkspaceMemberRole, "owner">) => json<WorkspaceMember>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, "POST", { email, role }),
  changeWorkspaceMember: (workspaceId: string, userId: string, role: Exclude<WorkspaceMemberRole, "owner">) => json<WorkspaceMember>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, "PATCH", { userId, role }),
  removeWorkspaceMember: (workspaceId: string, userId: string) => json<{ deleted: true }>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, "DELETE", { userId }),
  transferWorkspaceOwner:(workspaceId:string,userId:string)=>jsonIdempotent<{transferred:true}>(`/workspaces/${encodeURIComponent(workspaceId)}/members/transfer-owner`,"POST",newIdempotencyKey("workspace-owner-transfer"),{userId}),
  projectCapabilities: (projectId: string) => request<ProjectCapabilities>(`/projects/${encodeURIComponent(projectId)}/capabilities`),
  projectSettings: (projectId: string) => request<ProjectSettings>(`/projects/${encodeURIComponent(projectId)}/settings`),
  updateProjectSettings: (projectId: string, input: { name?: string; taskConcurrencyLimit?: number }) => jsonIdempotent<ProjectSettings>(`/projects/${encodeURIComponent(projectId)}/settings`, "PATCH", newIdempotencyKey("project-settings"), input),
  archiveProject:(projectId:string)=>jsonIdempotent<Project>(`/projects/${encodeURIComponent(projectId)}/settings/archive`,"POST",newIdempotencyKey("project-archive")),
  unarchiveProject:(projectId:string)=>jsonIdempotent<Project>(`/projects/${encodeURIComponent(projectId)}/settings/unarchive`,"POST",newIdempotencyKey("project-unarchive")),
  deleteProject: (projectId: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}`, "DELETE", newIdempotencyKey("project-delete")),
  members: (projectId: string) => request<ProjectMember[]>(`/projects/${encodeURIComponent(projectId)}/members`),
  addMember: (projectId: string, email: string, role: Exclude<MemberRole, "owner">) =>
    json<ProjectMember>(`/projects/${encodeURIComponent(projectId)}/members`, "POST", { email, role }),
  changeMember: (projectId: string, userId: string, role: Exclude<MemberRole, "owner">) =>
    json<ProjectMember>(`/projects/${encodeURIComponent(projectId)}/members`, "PATCH", { userId, role }),
  removeMember: (projectId: string, userId: string) => json<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/members`, "DELETE", { userId }),
  transferProjectOwner:(projectId:string,userId:string)=>jsonIdempotent<{transferred:true}>(`/projects/${encodeURIComponent(projectId)}/members/transfer-owner`,"POST",newIdempotencyKey("project-owner-transfer"),{userId}),
  credentials: (projectId: string) => request<ProjectCredential[]>(`/projects/${encodeURIComponent(projectId)}/credentials`),
  createCredential: (projectId: string, input: { name: string; baseUrl: string; secret: string }) => json<ProjectCredential>(`/projects/${encodeURIComponent(projectId)}/credentials`, "POST", input),
  rotateCredential: (projectId: string, credentialId: string, secret: string) => json<ProjectCredential>(`/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}/rotate`, "POST", { secret }),
  deleteCredential: (projectId: string, credentialId: string) => json<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}`, "DELETE"),
  endpoints: (projectId: string) => request<Endpoint[]>(`/projects/${encodeURIComponent(projectId)}/endpoints`),
  createEndpoint: (projectId: string, input: EndpointInput) => json<Endpoint>(`/projects/${encodeURIComponent(projectId)}/endpoints`, "POST", { ...input, protocol: "openai_chat_completions" }),
  updateEndpoint: (projectId: string, endpointId: string, input: EndpointInput) =>
    json<Endpoint>(`/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}`, "PATCH", { ...input, protocol: "openai_chat_completions" }),
  discoverEndpointModels: (projectId: string, input: Pick<EndpointInput, "baseUrl" | "credentialId" | "requestTimeoutSecs"> & { endpointId?: string }) =>
    json<EndpointModelDiscovery>(`/projects/${encodeURIComponent(projectId)}/endpoints/models`, "POST", input),
  recheckEndpoint: (projectId: string, endpointId: string) =>
    json<Endpoint>(`/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}/health`, "POST"),
  deleteEndpoint: (projectId: string, endpointId: string) =>
    json<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}`, "DELETE"),
  chatThreads: (projectId: string, query?: string) => request<ProjectChatThread[]>(`/projects/${encodeURIComponent(projectId)}/chat/threads${query ? `?query=${encodeURIComponent(query)}` : ""}`),
  createChatThread: (projectId: string, endpointId: string) => json<ProjectChatThread>(`/projects/${encodeURIComponent(projectId)}/chat/threads`, "POST", { endpointId }),
  updateChatThread: (projectId: string, threadId: string, input: { title?: string | null; pinned?: boolean;starred?:boolean }) => json<ProjectChatThread>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}`, "PATCH", input),
  deleteChatThread: (projectId: string, threadId: string) => json<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}`, "DELETE"),
  chatMessages: (projectId: string, threadId: string) => request<ProjectChatMessage[]>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages`),
  editChatMessage:(projectId:string,threadId:string,messageId:string,input:{content:string;expectedVersion:number})=>json<ProjectChatMessage>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,"PATCH",input),
  deleteChatMessage:(projectId:string,threadId:string,messageId:string,expectedVersion:number)=>json<{deleted:true}>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,"DELETE",{expectedVersion}),
  branchChatMessage:(projectId:string,threadId:string,messageId:string,expectedVersion:number)=>json<ProjectChatThread>(`/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/branch`,"POST",{expectedVersion}),
  async retryChatMessage(projectId:string,threadId:string,messageId:string,expectedVersion:number,signal:AbortSignal|undefined,onDelta:(delta:string)=>void):Promise<ProjectChatSendResponse>{if(!csrfToken)await apiClient.currentIdentity();const response=await fetch(`${apiBasePath}/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/retry`,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrfToken??""},body:JSON.stringify({expectedVersion}),...(signal?{signal}:{})});return readChatStream(response,onDelta);},
  async sendChatMessage(projectId: string, threadId: string, content: string, afterMessageId:string|null,signal: AbortSignal | undefined, onDelta: (delta: string) => void): Promise<ProjectChatSendResponse> {
    if (!csrfToken) await apiClient.currentIdentity();
    const response = await fetch(`${apiBasePath}/projects/${encodeURIComponent(projectId)}/chat/threads/${encodeURIComponent(threadId)}/messages`, { method:"POST", credentials:"same-origin", headers:{"content-type":"application/json","x-csrf-token":csrfToken??""}, body:JSON.stringify({content,afterMessageId}), ...(signal ? { signal } : {}) });
    return readChatStream(response,onDelta);
  },
  contexts: (input: { workspaceId: string; scope: ContextScope; projectId?: string }) => {
    const query = new URLSearchParams({ workspaceId: input.workspaceId, scope: input.scope });
    if (input.projectId) query.set("projectId", input.projectId);
    return request<ContextList>(`/context?${query.toString()}`);
  },
  saveContext: (input: { workspaceId: string; projectId?: string; scope: ContextScope; contextKey: string; previousContextKey?: string; expectedVersion?: number; content: string; contentType: ContextContentType }) => json<ContextEntry>("/context", "PUT", input),
  deleteContext: (input: { workspaceId: string; projectId?: string; scope: ContextScope; contextKey: string }) => json<{ deleted: true }>("/context", "DELETE", input),
  policy: (projectId: string) => request<ProjectResourcePolicy>(`/projects/${encodeURIComponent(projectId)}/policy`),
  updatePolicy: (projectId: string, input: ProjectPolicyInput) =>
    json<ProjectResourcePolicy>(`/projects/${encodeURIComponent(projectId)}/policy`, "PATCH", input),
  usage: (projectId: string, endpointId?: string) => request<ProjectUsageOverview>(`/projects/${encodeURIComponent(projectId)}/usage${endpointId ? `?endpointId=${encodeURIComponent(endpointId)}` : ""}`),
  alerts: (projectId: string) => request<ProjectAlert[]>(`/projects/${encodeURIComponent(projectId)}/alerts`),
  transitionAlert: (projectId: string, alertId: string, status: "resolved" | "dismissed") => json<ProjectAlert>(`/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}`, "PATCH", { status }),
  acknowledgeAlert:(projectId:string,alertId:string)=>json<ProjectAlert>(`/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}/acknowledge`,"POST",{}),
  silenceAlert:(projectId:string,alertId:string,silencedUntil:string|null)=>json<ProjectAlert>(`/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}/silence`,"POST",{silencedUntil}),
  alertRules: (projectId: string) => request<ProjectAlertRule[]>(`/projects/${encodeURIComponent(projectId)}/alert-rules`),
  createAlertRule: (projectId: string, input: { name?:string;alertType:ProjectAlertType;threshold?:number;windowSeconds?:number|null;scope?:{kind:"project"}|{kind:"endpoint";endpointId:string};enabled?:boolean }) => json<ProjectAlertRule>(`/projects/${encodeURIComponent(projectId)}/alert-rules`, "POST", input),
  updateAlertRule: (projectId: string, ruleId: string, input: { name?:string;alertType?:ProjectAlertType;threshold?:number;windowSeconds?:number|null;scope?:{kind:"project"}|{kind:"endpoint";endpointId:string};enabled?:boolean }) => json<ProjectAlertRule>(`/projects/${encodeURIComponent(projectId)}/alert-rules/${encodeURIComponent(ruleId)}`, "PATCH", input),
  deleteAlertRule: (projectId: string, ruleId: string) => json<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/alert-rules/${encodeURIComponent(ruleId)}`, "DELETE"),
  testAlertRule:(projectId:string,ruleId:string)=>json<{matched:boolean;metric:string;value:number;threshold:number;evaluatedAt:string}>(`/projects/${encodeURIComponent(projectId)}/alert-rules/${encodeURIComponent(ruleId)}/test`,"POST",{}),
  async audit(projectId: string, query:Record<string,string|number|undefined>={}): Promise<{items:ProjectAuditEvent[];nextCursor:string|null}> {
    const params=new URLSearchParams();for(const [key,value] of Object.entries(query))if(value!==undefined)params.set(key,String(value));
    const payload = await request<{items:unknown[];nextCursor:string|null}>(`/projects/${encodeURIComponent(projectId)}/audit${params.size?`?${params}`:""}`);
    if (!Array.isArray(payload.items) || payload.items.some((event) => !isProjectAuditEvent(event))) throw new ApiError(502, "Audit response contains an unknown action.");
    return payload as {items:ProjectAuditEvent[];nextCursor:string|null};
  },
  files: (projectId: string, path = "files") => request<{ entries: ProjectFile[] }>(`/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`),
  async uploadFile(projectId: string, path: string, file: File): Promise<{ path: string; bytes: number }> {
    if (!csrfToken) await apiClient.currentIdentity();
    const response = await fetch(`${apiBasePath}/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`, {
      method: "PUT", credentials: "same-origin", headers: { "x-csrf-token": csrfToken || "", "content-type": file.type || "application/octet-stream" }, body: file
    });
    if (!response.ok) throw new ApiError(response.status, (await response.text()) || response.statusText);
    return response.json() as Promise<{ path: string; bytes: number }>;
  },
  deleteFile: (projectId: string, path: string) => json<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/files`, "DELETE", { path }),
  fileDownloadUrl: (projectId: string, path: string) => `${apiBasePath}/projects/${encodeURIComponent(projectId)}/files/download?path=${encodeURIComponent(path)}`,
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
  taskSummaries: (projectId: string) => request<TaskSummary[]>(`/projects/${encodeURIComponent(projectId)}/tasks/summaries`),
  createTask: (projectId: string, input: { prompt: string; endpointId: string; title?: string }, idempotencyKey: string) => jsonIdempotent<Task>(`/projects/${encodeURIComponent(projectId)}/tasks`, "POST", idempotencyKey, input),
  taskEvents: (taskId: string) => request<TaskEvent[]>(`/tasks/${encodeURIComponent(taskId)}/events`),
  task: (taskId: string) => request<Task>(`/tasks/${encodeURIComponent(taskId)}`),
  taskSummary: (taskId: string) => request<TaskSummary>(`/tasks/${encodeURIComponent(taskId)}/summary`),
  taskFollowUps: (taskId: string) => request<TaskFollowUp[]>(`/tasks/${encodeURIComponent(taskId)}/follow-ups`),
  followUpTask: (taskId: string, prompt: string, idempotencyKey: string) => jsonIdempotent<TaskFollowUp>(`/tasks/${encodeURIComponent(taskId)}/follow-ups`, "POST", idempotencyKey, { prompt }),
  updateTaskFollowUp: (taskId: string, followUpId: string, prompt: string, idempotencyKey: string) => jsonIdempotent<TaskFollowUp>(`/tasks/${encodeURIComponent(taskId)}/follow-ups/${encodeURIComponent(followUpId)}`, "PATCH", idempotencyKey, { prompt }),
  deleteTaskFollowUp: (taskId: string, followUpId: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true; followUpId: string }>(`/tasks/${encodeURIComponent(taskId)}/follow-ups/${encodeURIComponent(followUpId)}`, "DELETE", idempotencyKey),
  retryTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<Task>(`/tasks/${encodeURIComponent(taskId)}/retry`, "POST", idempotencyKey),
  duplicateTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<Task>(`/tasks/${encodeURIComponent(taskId)}/duplicate`, "POST", idempotencyKey),
  updateTask: (taskId: string, title: string, idempotencyKey: string) => jsonIdempotent<Task>(`/tasks/${encodeURIComponent(taskId)}`, "PATCH", idempotencyKey, { title }),
  archiveTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<Task>(`/tasks/${encodeURIComponent(taskId)}/archive`, "POST", idempotencyKey, {}),
  deleteTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true; taskId: string }>(`/tasks/${encodeURIComponent(taskId)}`, "DELETE", idempotencyKey),
  async streamTaskTranscript(taskId: string, cursor: string | undefined, signal: AbortSignal, onEntry: (entry: TaskTranscriptEntry) => void, onCursor: (nextCursor: string | null) => void): Promise<void> {
    const params = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
    const response = await fetch(`${apiBasePath}/tasks/${encodeURIComponent(taskId)}/transcript/stream?${params}`, { credentials: "same-origin", headers: { accept: "text/event-stream" }, signal });
    if (!response.ok || !response.body) throw new ApiError(response.status, await errorMessage(response));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const receive = (frames: string[]) => {
      for (const frame of frames) {
        const event = /^event:\s*(.+)$/m.exec(frame)?.[1];
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trimStart()).join("\n");
        if (!event || !data) continue;
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch {
          throw new ApiError(502, "Task transcript stream contained an invalid event.");
        }
        if (event === "transcript" && isTaskTranscriptEntry(value)) onEntry(value);
        if (event === "cursor" && value && typeof value === "object" && (typeof (value as { nextCursor?: unknown }).nextCursor === "string" || (value as { nextCursor?: unknown }).nextCursor === null)) onCursor((value as { nextCursor: string | null }).nextCursor);
        if (event === "error") throw new ApiError(502, value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string" ? (value as { error: string }).error : "Task transcript stream failed.");
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
  taskArtifacts: (taskId: string, filter: { mediaType?: string; previewOnly?: boolean } = {}) => request<TaskArtifact[]>(`/tasks/${encodeURIComponent(taskId)}/artifacts?${new URLSearchParams({ ...(filter.mediaType ? { mediaType: filter.mediaType } : {}), ...(filter.previewOnly ? { preview: "true" } : {}) })}`),
  cancelTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<Task>(`/tasks/${encodeURIComponent(taskId)}/cancel`, "POST", idempotencyKey, {}),
  artifactDownloadUrl: (taskId: string, artifactId: string) => `${apiBasePath}/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}/download`,
  async downloadTaskArtifact(taskId: string, artifactId: string, signal?: AbortSignal): Promise<Blob> {
    const response = await fetch(`${apiBasePath}/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}/download`, { credentials: "same-origin", ...(signal ? { signal } : {}) });
    if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
    return response.blob();
  }
};

export const oidcStartUrl = `${apiBasePath}/auth/oidc/start`;

export function oidcStartUrlForReturnTo(returnTo: string): string {
  return `${oidcStartUrl}?${new URLSearchParams({ returnTo }).toString()}`;
}

export function newIdempotencyKey(operation: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-${operation}-${id}`;
}

function isTaskTranscriptEntry(value: unknown): value is TaskTranscriptEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<TaskTranscriptEntry>;
  return typeof entry.id === "string" && typeof entry.taskId === "string" && typeof entry.text === "string" && typeof entry.cursor === "string" && typeof entry.createdAt === "string" && ["user", "assistant", "tool", "system"].includes(entry.role ?? "");
}

function isProjectAuditEvent(value: unknown): value is ProjectAuditEvent {
  return Boolean(value && typeof value === "object" && "action" in value && typeof value.action === "string" && projectAuditActions.has(value.action as ProjectAuditAction));
}

async function readChatStream(response:Response,onDelta:(delta:string)=>void):Promise<ProjectChatSendResponse>{if(!response.ok||!response.body)throw new ApiError(response.status,await response.text());const reader=response.body.getReader();const decoder=new TextDecoder();let buffer="";let done:ProjectChatSendResponse|undefined;while(true){const{done:ended,value}=await reader.read();if(ended)break;buffer+=decoder.decode(value,{stream:true});const frames=buffer.split("\n\n");buffer=frames.pop()??"";for(const frame of frames){const type=/event: (.+)/.exec(frame)?.[1];const data=/data: (.+)/.exec(frame)?.[1];if(!data)continue;const value=JSON.parse(data);if(type==="delta")onDelta(value.delta);else if(type==="done")done=value;else if(type==="error")throw new ApiError(502,value.error);}}if(!done)throw new ApiError(502,"Chat stream ended without a final message");return done;}
