"use client";

import {
  PROJECT_AUDIT_ACTIONS,
  PROJECT_AUDIT_RESOURCE_KINDS,
} from "../../../packages/contracts/src/api.ts";
import type { AgentTask, AgentTaskArtifact, CreateTaskInput, CredentialDirectoryQuery, CredentialPage as ApiCredentialPage, EndpointDirectoryQuery, EndpointPage as ApiEndpointPage, EndpointView, FileLibraryProjection, ProfileGreetingPreference, ProfileResponse, Project as ApiProject, ProjectAlert as ApiProjectAlert, ProjectAlertPage as ApiProjectAlertPage, ProjectAlertQuery as ApiProjectAlertQuery, ProjectAlertRuleView as ApiProjectAlertRule, ProjectAlertType as ApiProjectAlertType, ProjectAlertView as ApiProjectAlertView, ProjectAuditAction, ProjectAuditEventView, ProjectAuditIdentity as ApiProjectAuditIdentity, ProjectAuditIdentityPage as ApiProjectAuditIdentityPage, ProjectAuditIdentityQuery as ApiProjectAuditIdentityQuery, ProjectAuditPage as ApiProjectAuditPage, ProjectAuditQuery as ApiProjectAuditQuery, ProjectAuditResourceKind, ProjectContextContentType, ProjectContextEntry, ProjectContextEntryMetadata, ProjectContextPage, ProjectContextScope, ProjectDetail as ApiProjectDetail, ProjectDirectoryItem as ApiProjectDirectoryItem, ProjectDirectoryPage as ApiProjectDirectoryPage, ProjectEndpointUsagePage as ApiProjectEndpointUsagePage, ProjectEndpointUsageQuery, ProjectFileListEntry, ProjectFileListResponse, ProjectFileStorageRefreshResponse, ProjectResourcePolicyView as ApiProjectResourcePolicy, ProjectSandboxRunHistoryPage as ApiProjectSandboxRunHistoryPage, ProjectUsageOverview as ApiProjectUsageOverview, PublicModelEndpoint, RenameFileLibraryInput, TaskArtifactKind, TaskArtifactListPage, TaskArtifactListQuery, TaskCapabilities, TaskDetailProjection, TaskInteractionItem, TaskInteractionSnapshot, TaskInteractionStreamEvent, TaskListPage as ApiTaskListPage, TaskListQuery as ApiTaskListQuery, TaskMessageReceipt, TaskPresentation, TaskQueuedMessage, TaskSandboxReleaseReceipt, TaskTerminalStartReceipt, Workspace as ApiWorkspace, WorkspaceDetail as ApiWorkspaceDetail, WorkspaceDirectoryItem as ApiWorkspaceDirectoryItem, WorkspaceDirectoryPage as ApiWorkspaceDirectoryPage } from "../../../packages/contracts/src/api.js";
import type { ProjectMembershipCandidate, ProjectMembershipCandidatePage, ProjectMembershipPage, ProjectMembershipView, WorkspaceMembershipPage, WorkspaceMembershipView } from "../../../packages/contracts/src/api.js";

export type { ProjectAuditAction } from "../../../packages/contracts/src/api.js";
export type { TaskCapabilities, TaskInteractionItem, TaskInteractionSnapshot, TaskInteractionStreamEvent, TaskMessageReceipt, TaskQueuedMessage, TaskSandboxReleaseReceipt, TaskTerminalStartReceipt } from "../../../packages/contracts/src/api.js";
export type { ProfileGreetingPreference };
export type FileLibrary = FileLibraryProjection;
export type FileLibraryTaskLink = NonNullable<FileLibrary["boundTask"]>;
export type ProjectAuditEvent = ProjectAuditEventView;
export type ProjectAuditIdentity = ApiProjectAuditIdentity;
export type ProjectAuditIdentityPage = ApiProjectAuditIdentityPage;
export type ProjectAuditIdentityQuery = ApiProjectAuditIdentityQuery;
export type ProjectAuditQuery = Omit<ApiProjectAuditQuery, "subjectUserId"> & {
  subjectUserId?: string;
};
export type ProjectSandboxRunHistoryPage = ApiProjectSandboxRunHistoryPage;
export type ProjectUsageOverview = ApiProjectUsageOverview;

export class ApiError extends Error {
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;
  readonly details: unknown;
  readonly presentation: TaskPresentation | null | undefined;

  constructor(
    public readonly status: number,
    message: string,
    options?: string | {
      code?: string;
      retryable?: boolean;
      details?: unknown;
      presentation?: TaskPresentation | null;
    }
  ) {
    super(message);
    this.code = typeof options === "string" ? options : options?.code;
    this.retryable = typeof options === "object" ? options.retryable : undefined;
    this.details = typeof options === "object" ? options.details : undefined;
    this.presentation = typeof options === "object" ? options.presentation : undefined;
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

export function fileLibraryBoundTask(error: unknown): FileLibraryTaskLink | null {
  return error instanceof ApiError
    && error.code === "file_library_bound"
    && isFileLibraryTaskLink(error.details)
    ? error.details
    : null;
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
export interface WorkspaceSettings { workspace: ApiWorkspace; capabilities: SettingsCapabilities; }
export interface ProjectSettings { project: Project; workspaceLifecycleStatus: "active" | "archived" | "deleting"; capabilities: SettingsCapabilities; }
export type Project = ApiProject & { pinnedAt?: string | null };
export type ProjectDirectoryItem = ApiProjectDirectoryItem;
export type ProjectDirectoryPage = ApiProjectDirectoryPage;
export type ProjectDetail = ApiProjectDetail;
export type Workspace = ApiWorkspace;
export type WorkspaceDetail = ApiWorkspaceDetail;
export type WorkspaceDirectoryItem = ApiWorkspaceDirectoryItem;
export type WorkspaceDirectoryPage = ApiWorkspaceDirectoryPage;
export type MemberRole = "owner" | "admin" | "member" | "viewer";
export type ProjectMember = ProjectMembershipView;
export type ProjectMemberPage = ProjectMembershipPage;
export type ProjectMemberCandidate = ProjectMembershipCandidate;
export type ProjectMemberCandidatePage = ProjectMembershipCandidatePage;
export type WorkspaceMemberRole = "owner" | "admin" | "member" | "viewer";
export type WorkspaceMember = WorkspaceMembershipView;
export type WorkspaceMemberPage = WorkspaceMembershipPage;
export interface ProjectCapabilities { canManageEndpoints: boolean; canManageMembers: boolean; canManagePolicy: boolean; canWriteFiles: boolean; canCreateTasks: boolean; }
export type ProjectOverviewAction = "configure_endpoint" | "create_task" | "add_collaborator";
export interface ProjectOverview { project: Project; workspaceLifecycleStatus: "active" | "archived" | "deleting"; capabilities: ProjectCapabilities; owner: { displayName: string | null; email: string } | null; memberRole: MemberRole; taskReadyEndpointCount: number; recommendedActions: ProjectOverviewAction[]; }
export type EndpointCapability = "text" | "image" | "tool_calls";
export type Endpoint = EndpointView;
export type EndpointPage = ApiEndpointPage;
export interface EndpointModelDiscovery { models: string[]; health: { status: "healthy" | "unavailable" | "unknown"; checkedAt: string | null; errorCategory: "auth" | "network" | "upstream" | "timeout" | "rate_limit" | "unknown" | null }; }
export interface EndpointInput {
  name: string; baseUrl: string; model: string; credentialId: string; capabilities: EndpointCapability[]; requestTimeoutSecs: number;
}
export interface ProjectCredential { id: string; projectId: string; name: string; type: "api_key"; baseUrl: string; fingerprint: string; version: number; createdAt: string; lastRotatedAt: string | null; updatedAt: string; }
export type CredentialPage = ApiCredentialPage;
export type Task = AgentTask;
export type TaskDetail = TaskDetailProjection;
export type TaskArtifact = AgentTaskArtifact;
export type { TaskArtifactKind, TaskArtifactListPage, TaskArtifactListQuery };
export type ProjectFile = ProjectFileListEntry;
export type TaskListQuery = ApiTaskListQuery;
export type TaskListPage = ApiTaskListPage;
export type TaskListItem = TaskListPage["items"][number];
export type ContextScope = ProjectContextScope;
export type ContextContentType = ProjectContextContentType;
export type ContextEntry = ProjectContextEntry;
export type ContextEntryMetadata = ProjectContextEntryMetadata;
export type ContextPage = ProjectContextPage;
export type ProjectResourcePolicy=ApiProjectResourcePolicy;
export interface ProjectResourceUsage {
  projectId: string;
  activeSandboxes: number;
  providerRequests: number;
  providerTokens: number;
  providerCost: number;
  projectFileBytes: number;
  updatedAt: string;
}
export type ProjectUsageMetric = "activeSandboxes" | "providerRequests" | "providerTokens" | "providerCost";
export type ProjectUsageWindow = { kind: "current_gauge"; resetAt: null; } | { kind: "project_lifetime"; startedAt: string; resetAt: null; } | { kind:"rolling";windowSeconds:number;startedAt:string;resetAt:string|null };
export interface ProjectUsageLimit { metric: ProjectUsageMetric; current: number; limit: number | null; remaining: number | null; window: ProjectUsageWindow; }
export interface ProjectUsageDay { date: string; requests: number; tokens: number; cost: number; }
export interface ProjectUsageEndpoint { endpointId: string | null; endpointName: string; requests: number; tokens: number; cost: number;limits?:ProjectUsageLimit[]; }
export type ProjectEndpointUsagePage = ApiProjectEndpointUsagePage;
export type ProjectAlert = ApiProjectAlert;
export type ProjectAlertView = ApiProjectAlertView;
export type ProjectAlertPage = ApiProjectAlertPage;
export type ProjectAlertType = ApiProjectAlertType;
export type ProjectAlertRule = ApiProjectAlertRule;
export interface UserNotification { id: string; type: string; title: string; body: string | null; projectId: string | null; resourceKind: ProjectAuditEvent["resourceKind"] | null; resourceId: string | null; linkPath: string | null; readAt: string | null; createdAt: string; }
export interface ProjectPolicyInput {
  sandboxLimit?: number;
  providerRequestsLimit?: number | null;
  providerTokensLimit?: number | null;
  providerCostLimit?: number | null;
  projectFileBytesLimit?: number | null;
  endpointWindows?:Array<{endpointId:string;metric:"providerRequests"|"providerTokens"|"providerCost";limit:number;windowSeconds:number}>;
}
export type ProjectPolicyUpdate = ProjectPolicyInput & { expectedUpdatedAt: string };

const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH || "/api/v1";

export function taskArtifactDownloadUrlForApiBase(basePath: string, taskId: string, artifactId: string): string {
  return `${basePath.replace(/\/$/, "")}/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}/download`;
}

let csrfToken: string | undefined;
const structuredSandboxErrorCodes = new Set([
  "project_sandbox_capacity_reached",
  "substrate_sandbox_capacity_reached",
  "sandbox_start_failed"
]);
type SandboxErrorAction = "create" | "send" | "terminal";

async function apiResponse(
  path: string,
  init: RequestInit = {},
  sandboxErrorAction?: SandboxErrorAction
): Promise<Response> {
  const method = init.method?.toUpperCase() || "GET";
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    if (!csrfToken) await apiClient.currentIdentity();
    headers.set("x-csrf-token", csrfToken || "");
    headers.set("content-type", "application/json");
  }
  const response = observeSession(await fetch(`${apiBasePath}${path}`, { ...init, headers, credentials: "same-origin" }));
  if (!response.ok) throw await apiResponseError(response, sandboxErrorAction);
  return response;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  sandboxErrorAction?: SandboxErrorAction
): Promise<T> {
  const response = await apiResponse(path, init, sandboxErrorAction);
  return response.json() as Promise<T>;
}

function observeSession(response: Response): Response {
  if (response.status === 401) {
    csrfToken = undefined;
    if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  return response;
}

async function apiResponseError(
  response: Response,
  sandboxErrorAction?: SandboxErrorAction
): Promise<Error> {
  const text = await response.text();
  if (!text) return new ApiError(response.status, response.statusText);
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object") {
      const code = (body as { code?: unknown }).code;
      const error = (body as { error?: unknown }).error;
      if (code === "idempotency_in_progress" && typeof error === "string") return new IdempotencyPendingError(error);
      if (typeof error === "string") {
        const genericCode = typeof code === "string" && !structuredSandboxErrorCodes.has(code)
          ? code
          : undefined;
        const task = (body as { task?: unknown }).task;
        if (genericCode === "file_library_bound" && isFileLibraryTaskLink(task)) {
          return new ApiError(response.status, error, { code: genericCode, details: task });
        }
        return new ApiError(response.status, error, genericCode);
      }
      if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
        const envelope = error as Record<string, unknown> & { message: string };
        if (typeof envelope.code === "string" && structuredSandboxErrorCodes.has(envelope.code)) {
          const options = strictSandboxErrorOptions(envelope, sandboxErrorAction);
          return options
            ? new ApiError(response.status, envelope.message, options)
            : new ApiError(response.status, envelope.message);
        }
        return new ApiError(response.status, envelope.message, {
          ...(typeof envelope.code === "string" ? { code: envelope.code } : {}),
          ...(typeof envelope.retryable === "boolean" ? { retryable: envelope.retryable } : {}),
          ...(Object.hasOwn(envelope, "details") ? { details: envelope.details } : {}),
          ...(envelope.presentation === null || isTaskPresentation(envelope.presentation)
            ? { presentation: envelope.presentation }
            : {})
        });
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

function jsonIdempotent<T>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  idempotencyKey: string,
  body?: unknown,
  sandboxErrorAction?: SandboxErrorAction
): Promise<T> {
  return request<T>(
    path,
    { method, headers: { "idempotency-key": idempotencyKey }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    sandboxErrorAction
  );
}

function directoryQuery(query:{q?:string;role?:string;mode?:string;cursor?:string;limit?:number;userId?:string}):string {
  const params=new URLSearchParams();
  if(query.q)params.set("q",query.q);
  if(query.role)params.set("role",query.role);
  if(query.mode)params.set("mode",query.mode);
  if(query.userId)params.set("userId",query.userId);
  if(query.cursor!==undefined)params.set("cursor",query.cursor);
  if(query.limit!==undefined)params.set("limit",String(query.limit));
  const encoded=params.toString();
  return encoded?`?${encoded}`:"";
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
  markLinkedNotificationRead: (notificationId: string) => request<UserNotification>(`/notifications/${encodeURIComponent(notificationId)}/read`, { method: "PATCH", keepalive: true }),
  markAllNotificationsRead: () => json<UserNotification[]>("/notifications/read", "PATCH"),
  dismissNotification: (notificationId: string) => json<{ dismissed: true }>(`/notifications/${encodeURIComponent(notificationId)}`, "DELETE"),
  profile: () => request<Profile>("/me/profile"),
  updateProfile: (input: { displayName?: string | null; timezone?: string | null; bio?: string | null; jobTitle?: string | null; company?: string | null; greetingPreference?: ProfileGreetingPreference | null; interests?: string[]; expectedUpdatedAt: string }) => json<Profile>("/me/profile", "PATCH", input),
  workspaces: (query: { cursor?: string; limit?: number } = {}) => request<WorkspaceDirectoryPage>(`/workspaces${directoryQuery(query)}`),
  workspace: (workspaceId: string) => request<WorkspaceDetail>(`/workspaces/${encodeURIComponent(workspaceId)}`),
  createWorkspace: (name: string, idempotencyKey: string) => jsonIdempotent<WorkspaceDetail>("/workspaces", "POST", idempotencyKey, { name }),
  deleteWorkspace: (workspaceId: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/workspaces/${encodeURIComponent(workspaceId)}`, "DELETE", idempotencyKey),
  workspaceSettings: (workspaceId: string) => request<WorkspaceSettings>(`/workspaces/${encodeURIComponent(workspaceId)}/settings`),
  updateWorkspaceSettings: (workspaceId: string, input: { name?: string; expectedName: string }, idempotencyKey: string) => jsonIdempotent<WorkspaceSettings>(`/workspaces/${encodeURIComponent(workspaceId)}/settings`, "PATCH", idempotencyKey, input),
  archiveWorkspace: (workspaceId:string,idempotencyKey:string) => jsonIdempotent<Workspace>(`/workspaces/${encodeURIComponent(workspaceId)}/settings/archive`,"POST",idempotencyKey),
  unarchiveWorkspace: (workspaceId:string,idempotencyKey:string) => jsonIdempotent<Workspace>(`/workspaces/${encodeURIComponent(workspaceId)}/settings/unarchive`,"POST",idempotencyKey),
  createProject: (workspaceId: string, input: { name: string; sandboxLimit?: number }, idempotencyKey: string) =>
    jsonIdempotent<Project>(`/workspaces/${encodeURIComponent(workspaceId)}/projects`, "POST", idempotencyKey, input),
  workspaceProjects: (workspaceId:string,query:{q?:string;cursor?:string;limit?:number}={}) => request<ProjectDirectoryPage>(`/workspaces/${encodeURIComponent(workspaceId)}/projects${directoryQuery(query)}`),
  project: (projectId:string) => request<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}`),
  setProjectPinned: (projectId:string,pinned:boolean) => json<Project>(`/projects/${encodeURIComponent(projectId)}/pin`,"PUT",{pinned}),
  workspaceMembers: (workspaceId: string, query: { q?:string;role?:WorkspaceMemberRole;cursor?:string;limit?:number } = {}) => request<WorkspaceMemberPage>(`/workspaces/${encodeURIComponent(workspaceId)}/members${directoryQuery(query)}`),
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
  members: (projectId: string, query: { q?:string;role?:MemberRole;cursor?:string;limit?:number } = {}) => request<ProjectMemberPage>(`/projects/${encodeURIComponent(projectId)}/members${directoryQuery(query)}`),
  memberCandidates: (projectId:string,query:{q?:string;cursor?:string;limit?:number}={}) => request<ProjectMemberCandidatePage>(`/projects/${encodeURIComponent(projectId)}/members/candidates${directoryQuery(query)}`),
  addMember: (projectId: string, userId: string, role: Exclude<MemberRole, "owner">, idempotencyKey: string) =>
    jsonIdempotent<ProjectMember>(`/projects/${encodeURIComponent(projectId)}/members`, "POST", idempotencyKey, { userId, role }),
  changeMember: (projectId: string, userId: string, role: Exclude<MemberRole, "owner">, expectedUpdatedAt: string, idempotencyKey: string) =>
    jsonIdempotent<ProjectMember>(`/projects/${encodeURIComponent(projectId)}/members`, "PATCH", idempotencyKey, { userId, role, expectedUpdatedAt }),
  removeMember: (projectId: string, userId: string, expectedUpdatedAt: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/members`, "DELETE", idempotencyKey, { userId, expectedUpdatedAt }),
  transferProjectOwner:(projectId:string,userId:string,idempotencyKey:string)=>jsonIdempotent<{transferred:true}>(`/projects/${encodeURIComponent(projectId)}/members/transfer-owner`,"POST",idempotencyKey,{userId}),
  credentials: (projectId:string,query:CredentialDirectoryQuery={}) => request<CredentialPage>(`/projects/${encodeURIComponent(projectId)}/credentials${directoryQuery(query)}`),
  credential: (projectId:string,credentialId:string) => request<ProjectCredential>(`/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}`),
  createCredential: (projectId: string, input: { name: string; baseUrl: string; secret: string }, idempotencyKey: string) => jsonIdempotent<ProjectCredential>(`/projects/${encodeURIComponent(projectId)}/credentials`, "POST", idempotencyKey, input),
  rotateCredential: (projectId: string, credentialId: string, secret: string, idempotencyKey: string) => jsonIdempotent<ProjectCredential>(`/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}/rotate`, "POST", idempotencyKey, { secret }),
  deleteCredential: (projectId: string, credentialId: string, expectedVersion: number, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(credentialId)}`, "DELETE", idempotencyKey, { expectedVersion }),
  endpoints: (projectId:string,query:EndpointDirectoryQuery={}) => request<EndpointPage>(`/projects/${encodeURIComponent(projectId)}/endpoints${directoryQuery(query)}`),
  endpoint: (projectId:string,endpointId:string) => request<Endpoint>(`/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}`),
  createEndpoint: (projectId: string, input: EndpointInput, idempotencyKey: string) => jsonIdempotent<Endpoint>(`/projects/${encodeURIComponent(projectId)}/endpoints`, "POST", idempotencyKey, { ...input, protocol: "openai_chat_completions" }),
  updateEndpoint: (projectId: string, endpointId: string, input: EndpointInput & { expectedUpdatedAt: string }, idempotencyKey: string) =>
    jsonIdempotent<Endpoint>(`/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}`, "PATCH", idempotencyKey, { ...input, protocol: "openai_chat_completions" }),
  discoverEndpointModels: (projectId: string, input: Pick<EndpointInput, "baseUrl" | "credentialId" | "requestTimeoutSecs"> & { endpointId?: string }, idempotencyKey: string) =>
    jsonIdempotent<EndpointModelDiscovery>(`/projects/${encodeURIComponent(projectId)}/endpoints/models`, "POST", idempotencyKey, input),
  recheckEndpoint: (projectId: string, endpointId: string, idempotencyKey: string) =>
    jsonIdempotent<Endpoint>(`/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}/health`, "POST", idempotencyKey),
  deleteEndpoint: (projectId: string, endpointId: string, idempotencyKey: string) =>
    jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}`, "DELETE", idempotencyKey),
  contexts: (input: { workspaceId: string; scope: ContextScope; projectId?: string; cursor?: string; limit?: number }) => {
    const query = new URLSearchParams({ workspaceId: input.workspaceId, scope: input.scope });
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.limit) query.set("limit", String(input.limit));
    return request<ContextPage>(`/context?${query.toString()}`);
  },
  context: (entryId: string, input: { workspaceId: string; scope: ContextScope; projectId?: string }) => {
    const query = new URLSearchParams({ workspaceId: input.workspaceId, scope: input.scope });
    if (input.projectId) query.set("projectId", input.projectId);
    return request<ContextEntry>(`/context/${encodeURIComponent(entryId)}?${query.toString()}`);
  },
  saveContext: (input: { workspaceId: string; projectId?: string; scope: ContextScope; contextKey: string; previousContextKey?: string; expectedVersion?: number; content: string; contentType: ContextContentType }, idempotencyKey: string) => jsonIdempotent<ContextEntry>("/context", "PUT", idempotencyKey, input),
  deleteContext: (input: { workspaceId: string; projectId?: string; scope: ContextScope; contextKey: string; expectedVersion: number }, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>("/context", "DELETE", idempotencyKey, input),
  policy: (projectId: string) => request<ProjectResourcePolicy>(`/projects/${encodeURIComponent(projectId)}/policy`),
  updatePolicy: (projectId: string, input: ProjectPolicyUpdate, idempotencyKey: string) =>
    jsonIdempotent<ProjectResourcePolicy>(`/projects/${encodeURIComponent(projectId)}/policy`, "PATCH", idempotencyKey, input),
  usage: (projectId: string, query: { endpointId?: string; userId?: string } = {}) => { const params = new URLSearchParams(); if (query.endpointId) params.set("endpointId", query.endpointId); if (query.userId) params.set("userId", query.userId); return request<ProjectUsageOverview>(`/projects/${encodeURIComponent(projectId)}/usage${params.size ? `?${params}` : ""}`); },
  endpointUsage: (projectId:string,query:ProjectEndpointUsageQuery={}) => request<ProjectEndpointUsagePage>(`/projects/${encodeURIComponent(projectId)}/usage/endpoints${directoryQuery(query)}`),
  measureFileStorage: (projectId: string) => json<ProjectFileStorageRefreshResponse>(`/projects/${encodeURIComponent(projectId)}/usage/file-storage/refresh`, "POST", {}),
  sandboxRunHistory: (projectId: string, query: { userId?: string; cursor?: string; limit?: number } = {}) => { const params = new URLSearchParams(); if (query.userId) params.set("userId", query.userId); if (query.cursor) params.set("cursor", query.cursor); if (query.limit) params.set("limit", String(query.limit)); return request<ProjectSandboxRunHistoryPage>(`/projects/${encodeURIComponent(projectId)}/usage/sandbox-runs${params.size ? `?${params}` : ""}`); },
  alerts: (projectId: string, query: ApiProjectAlertQuery = {}) => { const params=new URLSearchParams();if(query.view)params.set("view",query.view);if(query.cursor)params.set("cursor",query.cursor);if(query.limit)params.set("limit",String(query.limit));return request<ProjectAlertPage>(`/projects/${encodeURIComponent(projectId)}/alerts${params.size?`?${params}`:""}`); },
  alert: (projectId:string,alertId:string) => request<ProjectAlert>(`/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}`),
  transitionAlert: (projectId: string, alertId: string, status: "resolved" | "dismissed", idempotencyKey: string) => jsonIdempotent<ProjectAlert>(`/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}`, "PATCH", idempotencyKey, { status }),
  acknowledgeAlert:(projectId:string,alertId:string,idempotencyKey:string)=>jsonIdempotent<ProjectAlert>(`/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}/acknowledge`,"POST",idempotencyKey,{}),
  silenceAlert:(projectId:string,alertId:string,silencedUntil:string|null,idempotencyKey:string)=>jsonIdempotent<ProjectAlert>(`/projects/${encodeURIComponent(projectId)}/alerts/${encodeURIComponent(alertId)}/silence`,"POST",idempotencyKey,{silencedUntil}),
  alertRules: (projectId: string) => request<ProjectAlertRule[]>(`/projects/${encodeURIComponent(projectId)}/alert-rules`),
  createAlertRule: (projectId: string, input: { name?:string;alertType:ProjectAlertType;threshold?:number;windowSeconds?:number|null;scope?:{kind:"project"}|{kind:"endpoint";endpointId:string};enabled?:boolean }, idempotencyKey: string) => jsonIdempotent<ProjectAlertRule>(`/projects/${encodeURIComponent(projectId)}/alert-rules`, "POST", idempotencyKey, input),
  updateAlertRule: (projectId: string, ruleId: string, input: { name?:string;alertType?:ProjectAlertType;threshold?:number;windowSeconds?:number|null;scope?:{kind:"project"}|{kind:"endpoint";endpointId:string};enabled?:boolean;expectedUpdatedAt:string }, idempotencyKey: string) => jsonIdempotent<ProjectAlertRule>(`/projects/${encodeURIComponent(projectId)}/alert-rules/${encodeURIComponent(ruleId)}`, "PATCH", idempotencyKey, input),
  deleteAlertRule: (projectId: string, ruleId: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/alert-rules/${encodeURIComponent(ruleId)}`, "DELETE", idempotencyKey),
  testAlertRule:(projectId:string,ruleId:string)=>json<{matched:boolean;metric:string;value:number;threshold:number;evaluatedAt:string}>(`/projects/${encodeURIComponent(projectId)}/alert-rules/${encodeURIComponent(ruleId)}/test`,"POST",{}),
  async audit(projectId: string, query: ProjectAuditQuery = {}): Promise<ApiProjectAuditPage> {
    const params = new URLSearchParams();
    if (query.actorId !== undefined) {
      params.set("actorId", query.actorId === null ? "system" : query.actorId);
    }
    if (query.subjectUserId !== undefined) params.set("subjectUserId", query.subjectUserId);
    if (query.action !== undefined) params.set("action", query.action);
    if (query.status !== undefined) params.set("status", query.status);
    if (query.resourceKind !== undefined) params.set("resourceKind", query.resourceKind);
    if (query.resourceId !== undefined) params.set("resourceId", query.resourceId);
    if (query.from !== undefined) params.set("from", query.from);
    if (query.to !== undefined) params.set("to", query.to);
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const payload = await request<unknown>(
      `/projects/${encodeURIComponent(projectId)}/audit${params.size ? `?${params}` : ""}`,
    );
    if (!isProjectAuditPage(payload)) {
      throw new ApiError(502, "Audit response is invalid.");
    }
    return payload;
  },
  async auditIdentities(
    projectId: string,
    query: ProjectAuditIdentityQuery,
  ): Promise<ProjectAuditIdentityPage> {
    const params = new URLSearchParams({ role: query.role });
    if (query.q !== undefined) params.set("q", query.q);
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const payload = await request<unknown>(
      `/projects/${encodeURIComponent(projectId)}/audit/identities?${params}`,
    );
    if (!isProjectAuditIdentityPage(payload)) {
      throw new ApiError(502, "Audit identity response is invalid.");
    }
    return payload;
  },
  fileLibraries: (projectId: string) => request<FileLibraryProjection[]>(`/projects/${encodeURIComponent(projectId)}/file-libraries`),
  createFileLibrary: (projectId: string, name: string, idempotencyKey: string) => jsonIdempotent<FileLibraryProjection>(`/projects/${encodeURIComponent(projectId)}/file-libraries`, "POST", idempotencyKey, { name }),
  renameFileLibrary: (projectId: string, libraryId: string, input: RenameFileLibraryInput, idempotencyKey: string) => jsonIdempotent<FileLibraryProjection>(`/projects/${encodeURIComponent(projectId)}/file-libraries/${encodeURIComponent(libraryId)}`, "PATCH", idempotencyKey, input),
  deleteFileLibrary: (projectId: string, libraryId: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/file-libraries/${encodeURIComponent(libraryId)}`, "DELETE", idempotencyKey, {}),
  libraryFiles: (projectId: string, libraryId: string, path = "") => request<ProjectFileListResponse>(`/projects/${encodeURIComponent(projectId)}/file-libraries/${encodeURIComponent(libraryId)}/files?path=${encodeURIComponent(path)}`),
  async uploadLibraryFile(projectId: string, libraryId: string, path: string, file: File, options: { overwrite?: boolean; idempotencyKey?: string } = {}): Promise<{ path: string; bytes: number; mediaType: string; updatedAt: string }> {
    if (!csrfToken) await apiClient.currentIdentity();
    const params = new URLSearchParams({ path, ...(options.overwrite ? { overwrite: "true" } : {}) });
    const response = observeSession(await fetch(`${apiBasePath}/projects/${encodeURIComponent(projectId)}/file-libraries/${encodeURIComponent(libraryId)}/files?${params}`, {
      method: "PUT", credentials: "same-origin", headers: { "x-csrf-token": csrfToken || "", "content-type": file.type || "application/octet-stream", "idempotency-key": options.idempotencyKey ?? newIdempotencyKey("library-file-upload") }, body: file
    }));
    if (!response.ok) throw await apiResponseError(response);
    return response.json() as Promise<{ path: string; bytes: number; mediaType: string; updatedAt: string }>;
  },
  deleteLibraryFile: (projectId: string, libraryId: string, path: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true }>(`/projects/${encodeURIComponent(projectId)}/file-libraries/${encodeURIComponent(libraryId)}/files`, "DELETE", idempotencyKey, { path }),
  libraryFileDownloadUrl: (projectId: string, libraryId: string, path: string) => `${apiBasePath}/projects/${encodeURIComponent(projectId)}/file-libraries/${encodeURIComponent(libraryId)}/files/download?path=${encodeURIComponent(path)}`,
  async previewLibraryFile(projectId: string, libraryId: string, path: string, signal?: AbortSignal): Promise<Blob> {
    const response = observeSession(await fetch(`${apiBasePath}/projects/${encodeURIComponent(projectId)}/file-libraries/${encodeURIComponent(libraryId)}/files/preview?path=${encodeURIComponent(path)}`, { credentials: "same-origin", ...(signal ? { signal } : {}) }));
    if (!response.ok) throw await apiResponseError(response);
    return response.blob();
  },
  tasks: (projectId: string, query: TaskListQuery = {}) => {
    const params = new URLSearchParams();
    if (query.search) params.set("search", query.search);
    if (query.archived) params.set("archived", query.archived);
    if (query.sort) params.set("sort", query.sort);
    if (query.direction) params.set("direction", query.direction);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit) params.set("limit", String(query.limit));
    return request<TaskListPage>(`/projects/${encodeURIComponent(projectId)}/tasks?${params}`);
  },
  createTask: (projectId: string, input: CreateTaskInput, idempotencyKey: string) => jsonIdempotent<TaskPresentation>(`/projects/${encodeURIComponent(projectId)}/tasks`, "POST", idempotencyKey, input, "create"),
  task: (taskId: string) => request<TaskPresentation>(`/tasks/${encodeURIComponent(taskId)}`),
  taskDetail: (taskId: string) => request<TaskDetail>(`/tasks/${encodeURIComponent(taskId)}/detail`),
  taskTerminalWebSocketUrl: (taskId:string) => taskTerminalWebSocketUrlForApiBase(apiBasePath,taskId,window.location.href),
  async startTaskTerminal(taskId: string, idempotencyKey: string, signal?: AbortSignal): Promise<TaskTerminalStartReceipt> {
    const response = await apiResponse(`/tasks/${encodeURIComponent(taskId)}/terminal/start`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({}),
      ...(signal ? { signal } : {})
    }, "terminal");
    const receipt: unknown = await response.json();
    if (
      !isRecord(receipt)
      || typeof receipt.runId !== "string"
      || !isTaskPresentation(receipt.presentation)
      || response.status === 202 && receipt.status !== "in_progress"
      || response.status === 200 && receipt.status !== "active"
      || response.status === 202 && receipt.presentation.sandboxState.state !== "starting"
      || response.status === 200 && receipt.presentation.sandboxState.state !== "active"
      || response.status !== 200 && response.status !== 202
    ) throw new ApiError(502, "Task terminal start returned an invalid receipt.");
    return receipt as TaskTerminalStartReceipt;
  },
  getTaskInteractions: (taskId: string, cursor?: string) => request<TaskInteractionSnapshot>(`/tasks/${encodeURIComponent(taskId)}/interactions${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`),
  async streamTaskInteractions(taskId: string, cursor: string | undefined, signal: AbortSignal, onEvent: (event: TaskInteractionStreamEvent) => void): Promise<void> {
    const response = observeSession(await fetch(`${apiBasePath}/tasks/${encodeURIComponent(taskId)}/interactions/stream${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`, {
      credentials: "same-origin",
      headers: { accept: "text/event-stream", ...(cursor ? { "last-event-id": cursor } : {}) },
      signal
    }));
    if (!response.ok) throw await apiResponseError(response);
    if (!response.body) throw new ApiError(502, "Task interaction stream has no response body.");
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
  sendTaskMessage: (taskId: string, content: string, idempotencyKey: string) => jsonIdempotent<TaskMessageReceipt>(`/tasks/${encodeURIComponent(taskId)}/messages`, "POST", idempotencyKey, { content }, "send"),
  updateTaskMessage: (taskId: string, messageId: string, content: string, idempotencyKey: string) => jsonIdempotent<TaskMessageReceipt>(`/tasks/${encodeURIComponent(taskId)}/messages/${encodeURIComponent(messageId)}`, "PATCH", idempotencyKey, { content }),
  deleteTaskMessage: (taskId: string, messageId: string, idempotencyKey: string) => jsonIdempotent<TaskMessageReceipt>(`/tasks/${encodeURIComponent(taskId)}/messages/${encodeURIComponent(messageId)}`, "DELETE", idempotencyKey),
  abortTaskTurn: (taskId: string, idempotencyKey: string) => jsonIdempotent<unknown>(`/tasks/${encodeURIComponent(taskId)}/turn/abort`, "POST", idempotencyKey, {}),
  releaseTaskSandbox: (taskId: string, idempotencyKey: string) => jsonIdempotent<TaskSandboxReleaseReceipt>(`/tasks/${encodeURIComponent(taskId)}/sandbox/release`, "POST", idempotencyKey, {}),
  stopTaskWork: (taskId: string, interactionId: string, idempotencyKey: string) => jsonIdempotent<unknown>(`/tasks/${encodeURIComponent(taskId)}/work/${encodeURIComponent(interactionId)}/stop`, "POST", idempotencyKey, {}),
  editTask: (taskId: string, title: string, idempotencyKey: string) => jsonIdempotent<TaskPresentation>(`/tasks/${encodeURIComponent(taskId)}`, "PATCH", idempotencyKey, { title }),
  archiveTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<TaskPresentation>(`/tasks/${encodeURIComponent(taskId)}/archive`, "POST", idempotencyKey, {}),
  deleteTask: (taskId: string, idempotencyKey: string) => jsonIdempotent<{ deleted: true; taskId: string }>(`/tasks/${encodeURIComponent(taskId)}`, "DELETE", idempotencyKey),
  taskArtifacts: (taskId: string, query: TaskArtifactListQuery = {}) => request<TaskArtifactListPage>(`/tasks/${encodeURIComponent(taskId)}/artifacts?${new URLSearchParams({
    ...(query.cursor ? { cursor:query.cursor } : {}),
    ...(query.kind ? { kind:query.kind } : {}),
    ...(query.limit ? { limit:String(query.limit) } : {}),
    ...(query.mediaType ? { mediaType:query.mediaType } : {}),
    ...(query.previewOnly ? { preview:"true" } : {})
  })}`),
  artifactDownloadUrl: (taskId: string, artifactId: string) => taskArtifactDownloadUrlForApiBase(apiBasePath, taskId, artifactId),
  async downloadTaskArtifact(taskId: string, artifactId: string, signal?: AbortSignal): Promise<Blob> {
    const response = observeSession(await fetch(taskArtifactDownloadUrlForApiBase(apiBasePath, taskId, artifactId), { credentials: "same-origin", ...(signal ? { signal } : {}) }));
    if (!response.ok) throw await apiResponseError(response);
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

export const oidcStartUrl = `/${apiBasePath.replace(/^\/+/, "")}/auth/oidc/start`;

export function oidcStartUrlForReturnTo(returnTo: string): string {
  return `${oidcStartUrl}?${new URLSearchParams({ returnTo }).toString()}`;
}

export function newIdempotencyKey(operation: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `web-${operation}-${id}`;
}

const projectAuditActions = new Set<string>(PROJECT_AUDIT_ACTIONS);
const projectAuditResourceKinds = new Set<string>(
  PROJECT_AUDIT_RESOURCE_KINDS,
);

function isProjectAuditPage(value: unknown): value is ApiProjectAuditPage {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isProjectAuditEvent) &&
    isNullableString(value.nextCursor)
  );
}

function isProjectAuditEvent(value: unknown): value is ProjectAuditEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.projectId === "string" &&
    value.projectId.length > 0 &&
    isNullableString(value.actorId) &&
    (value.subjectUserId === undefined ||
      isNullableString(value.subjectUserId)) &&
    typeof value.action === "string" &&
    projectAuditActions.has(value.action) &&
    (value.status === "accepted" || value.status === "rejected") &&
    typeof value.resourceKind === "string" &&
    projectAuditResourceKinds.has(value.resourceKind) &&
    isNullableString(value.resourceId) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Object.hasOwn(value, "actorDisplayName") &&
    isNullableString(value.actorDisplayName) &&
    Object.hasOwn(value, "actorEmail") &&
    isNullableString(value.actorEmail) &&
    Object.hasOwn(value, "subjectDisplayName") &&
    isNullableString(value.subjectDisplayName) &&
    Object.hasOwn(value, "subjectEmail") &&
    isNullableString(value.subjectEmail) &&
    (value.detail === undefined || isRecord(value.detail))
  );
}

function isProjectAuditIdentityPage(
  value: unknown,
): value is ProjectAuditIdentityPage {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(
      (identity) =>
        isRecord(identity) &&
        typeof identity.id === "string" &&
        identity.id.length > 0 &&
        Object.hasOwn(identity, "displayName") &&
        isNullableString(identity.displayName) &&
        Object.hasOwn(identity, "email") &&
        isNullableString(identity.email),
    ) &&
    isNullableString(value.nextCursor)
  );
}

function parseTaskInteractionStreamEvent(event: string, cursor: string | undefined, value: unknown): TaskInteractionStreamEvent {
  if (event === "interaction" && cursor && isTaskInteractionItem(value)) return { type: "interaction", cursor, item: value };
  if (event === "state" && isRecord(value) && isTaskQueuedMessageArray(value.queuedMessages) && isTaskPresentation(value.presentation)) return {
    type: "state",
    queuedMessages: value.queuedMessages,
    presentation: value.presentation
  };
  if (event === "connection" && isRecord(value) && isConnectionState(value.connectionState) && isRuntimeReachability(value.runtimeReachability) && isHistoryStatus(value.historyStatus) && isNullableString(value.lastSyncedAt) && isNullableString(value.message)) return {
    type: "connection",
    connectionState: value.connectionState,
    runtimeReachability: value.runtimeReachability,
    historyStatus: value.historyStatus,
    lastSyncedAt: value.lastSyncedAt,
    message: value.message
  };
  if (event === "preview_status" && isRecord(value) && isPreviewStatus(value.previewStatus) && isNullableString(value.message)) return { type:"preview_status", previewStatus:value.previewStatus, message:value.message };
  if (event === "assistant_preview" && isRecord(value) && typeof value.interactionId === "string" && typeof value.body === "string" && typeof value.occurredAt === "string") return { type: "assistant_preview", interactionId: value.interactionId, body: value.body, occurredAt: value.occurredAt };
  if (event === "assistant_preview_clear" && isRecord(value) && typeof value.interactionId === "string") return { type: "assistant_preview_clear", interactionId: value.interactionId };
  if (event === "reset" && isTaskInteractionSnapshot(value)) return { type: "reset", snapshot: value };
  if (event === "reconnect") return { type: "reconnect" };
  if (event === "done") return { type: "done" };
  throw new ApiError(502, "Task interaction stream contained an unknown event.");
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function isFileLibraryTaskLink(value: unknown): value is FileLibraryTaskLink {
  return isRecord(value)
    && typeof value.id === "string"
    && value.id.length > 0
    && (value.title === null || typeof value.title === "string");
}

function isTaskInteractionSnapshot(value: unknown): value is TaskInteractionSnapshot {
  return isRecord(value)
    && Array.isArray(value.items) && value.items.every(isTaskInteractionItem)
    && isNullableString(value.nextPageCursor) && typeof value.hasMoreBefore === "boolean" && typeof value.streamCursor === "string"
    && isTaskInteractionState(value);
}

function isTaskInteractionState(value: unknown): value is Pick<TaskInteractionSnapshot, "queuedMessages" | "runtimeReachability" | "historyStatus" | "lastSyncedAt" | "presentation"> & Record<string, unknown> {
  return isRecord(value) && isTaskQueuedMessageArray(value.queuedMessages)
    && isRuntimeReachability(value.runtimeReachability) && isHistoryStatus(value.historyStatus)
    && isNullableString(value.lastSyncedAt) && isTaskPresentation(value.presentation);
}

function isTaskPresentation(value:unknown):value is TaskPresentation{
  return isRecord(value)&&isRecord(value.task)&&typeof value.task.id==="string"
    &&isRecord(value.lifecycle)&&isStringUnion(value.lifecycle.state,["active","archived"])
    &&isRecord(value.currentTurn)&&isStringUnion(value.currentTurn.state,["ready","starting","queued","running","aborting"])
    &&isRecord(value.sandboxState)&&isStringUnion(value.sandboxState.state,["starting","active","release_requested","released","failed"])
    &&isTaskCapabilities(value.capabilities);
}

function strictSandboxErrorOptions(
  envelope: Record<string, unknown>,
  action: SandboxErrorAction | undefined
): {
  code: string;
  retryable: true;
  details: unknown;
  presentation: TaskPresentation | null;
} | null {
  const keys = Object.keys(envelope).sort();
  if (
    keys.length !== 5
    || keys[0] !== "code"
    || keys[1] !== "details"
    || keys[2] !== "message"
    || keys[3] !== "presentation"
    || keys[4] !== "retryable"
    ||
    typeof envelope.code !== "string"
    || envelope.retryable !== true
    || !Object.hasOwn(envelope, "details")
    || !Object.hasOwn(envelope, "presentation")
  ) return null;
  if (!action) return null;
  const presentation = envelope.presentation;
  if (envelope.code === "project_sandbox_capacity_reached") {
    if (!isStrictSandboxCapacityDetails(envelope.details)) return null;
    if (!validCapacityPresentation(action, presentation)) return null;
    return {
      code: envelope.code,
      retryable: true,
      details: envelope.details,
      presentation
    };
  }
  if (envelope.code === "substrate_sandbox_capacity_reached") {
    if (envelope.details !== null) return null;
    if (!validCapacityPresentation(action, presentation)) return null;
    return {
      code: envelope.code,
      retryable: true,
      details: null,
      presentation
    };
  }
  if (envelope.code === "sandbox_start_failed") {
    if (
      action !== "terminal"
      || envelope.details !== null
      || !isTaskPresentation(presentation)
      || (
        presentation.sandboxState.state !== "failed"
        && presentation.sandboxState.state !== "release_requested"
      )
    ) return null;
    return {
      code: envelope.code,
      retryable: true,
      details: null,
      presentation
    };
  }
  return null;
}

function validCapacityPresentation(
  action: SandboxErrorAction,
  presentation: unknown
): presentation is TaskPresentation | null {
  if (action === "create") return presentation === null;
  return isTaskPresentation(presentation)
    && presentation.sandboxState.state === "released";
}

function isStrictSandboxCapacityDetails(value: unknown): value is {
  activeSandboxes: number;
  sandboxLimit: number;
} {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2
    && keys[0] === "activeSandboxes"
    && keys[1] === "sandboxLimit"
    && typeof value.activeSandboxes === "number"
    && Number.isInteger(value.activeSandboxes)
    && value.activeSandboxes >= 0
    && typeof value.sandboxLimit === "number"
    && Number.isInteger(value.sandboxLimit)
    && value.sandboxLimit >= 0;
}

function isTaskCapabilities(value: unknown): value is TaskCapabilities {
  return isRecord(value)
    && typeof value.sendMessage === "boolean" && typeof value.editQueuedMessage === "boolean"
    && typeof value.abortTurn === "boolean" && typeof value.stopWork === "boolean"
    && typeof value.openTerminal === "boolean" && typeof value.releaseSandbox === "boolean" && typeof value.editTask === "boolean"
    && typeof value.archiveTask === "boolean" && typeof value.deleteTask === "boolean";
}

function isTaskQueuedMessageArray(value: unknown): value is TaskQueuedMessage[] {
  return Array.isArray(value) && value.every((message) => isRecord(message)
    && typeof message.id === "string" && typeof message.content === "string"
    && isStringUnion(message.deliveryStatus, ["pending", "dispatching", "failed"])
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
    case "system_error": return isStringUnion(value.status, ["active", "resolved"]) && isNullableString(value.code) && typeof value.retryable === "boolean" && typeof value.detailsOmitted === "boolean";
  }
}

function isTaskInteractionBase(value: unknown): value is Record<string, unknown> & { kind: TaskInteractionItem["kind"] } {
  return isRecord(value) && typeof value.id === "string" && typeof value.revision === "number" && typeof value.taskId === "string"
    && isStringUnion(value.kind, ["user_message", "assistant_message", "tool", "background_task", "task_question", "task_notice", "task_result", "subagent_result", "file", "system_error"])
    && typeof value.title === "string" && isNullableString(value.body) && isStringUnion(value.contentMode, ["full", "preview", "none"])
    && typeof value.position === "number" && typeof value.occurredAt === "string" && typeof value.updatedAt === "string";
}

function isRuntimeReachability(value: unknown): value is TaskInteractionSnapshot["runtimeReachability"] { return isStringUnion(value, ["unknown", "reachable", "unreachable"]); }
function isHistoryStatus(value: unknown): value is TaskInteractionSnapshot["historyStatus"] { return isStringUnion(value, ["complete", "gap"]); }
function isConnectionState(value: unknown): value is Extract<TaskInteractionStreamEvent, { type: "connection" }>["connectionState"] { return isStringUnion(value, ["connecting", "reconnecting", "connected", "disconnected", "recovered"]); }
function isPreviewStatus(value: unknown): value is Extract<TaskInteractionStreamEvent, { type: "preview_status" }>["previewStatus"] { return isStringUnion(value, ["available", "unavailable"]); }
function isDeliveryStatus(value: unknown): value is "pending" | "delivered" | "failed" { return isStringUnion(value, ["pending", "delivered", "failed"]); }
function isNullableDeliveryStatus(value: unknown): value is "pending" | "delivered" | "failed" | null { return value === null || isDeliveryStatus(value); }
function isNullableString(value: unknown): value is string | null { return value === null || typeof value === "string"; }
function isNullableNumber(value: unknown): value is number | null { return value === null || typeof value === "number"; }
function isStringUnion<T extends string>(value: unknown, choices: readonly T[]): value is T { return typeof value === "string" && choices.some((choice) => choice === value); }
