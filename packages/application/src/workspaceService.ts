import type { CreateProjectInput, CreateWorkspaceInput, Project, ProjectCapabilities, ProjectDetail, ProjectDirectoryItem, ProjectDirectoryPage, ProjectOverviewAction, ProjectOverviewProjection, Workspace, WorkspaceDetail, WorkspaceDirectoryPage } from "../../contracts/src/api.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { NotFoundError, ProductError } from "../../domain/src/errors.js";
import { PRODUCT_NAME_MAX_LENGTH, requireNonEmptyString, requirePositiveInteger } from "../../domain/src/validation.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthorizationService, type ProjectAccessSnapshot, type ProjectPermission } from "./authorizationService.js";
import { ProjectPolicyService } from "./projectPolicyService.js";
import { runIdempotentMutation } from "./idempotentMutation.js";

export class WorkspaceService {
  constructor(
    private readonly store: ProductStore,
    private readonly authorization: AuthorizationService,
    private readonly policies?: ProjectPolicyService
  ) {}

  async createWorkspace(userId: string, input: CreateWorkspaceInput, idempotencyKey?: string): Promise<Workspace> {
    const name = requireNonEmptyString(input.name, "workspace.name", PRODUCT_NAME_MAX_LENGTH);
    const timestamp = nowIso();
    const create = async (id: string) => {
      const existing = await this.store.findWorkspace(id);
      if (existing) return existing;
      return this.store.createWorkspace({ id, name, ownerUserId: userId, createdAt: timestamp, updatedAt: timestamp });
    };
    if (!idempotencyKey) return create(newId("ws"));
    return runIdempotentMutation({ store:this.store, actorId:userId, scopeId:userId, operation:"workspace.create", key:idempotencyKey, request:{name}, resourceId:newId("ws"), failureMessage:"Workspace could not be created", run:create });
  }

  async createProject(userId: string, workspaceId: string, input: CreateProjectInput, idempotencyKey?: string): Promise<Project> {
    await this.authorization.requireWorkspaceProjectCreation(userId, workspaceId);
    const name = requireNonEmptyString(input.name, "project.name", PRODUCT_NAME_MAX_LENGTH);
    const sandboxLimit = requirePositiveInteger(input.sandboxLimit, "project.sandboxLimit", 2);
    const timestamp = nowIso();
    const create = async (id: string) => {
      const existing = await this.store.findProject(id);
      if (existing) return existing;
      return this.store.createProject({ id, workspaceId, name, ownerUserId: userId, rootPath: `workspaces/${workspaceId}/projects/${id}`, sandboxLimit, createdAt: timestamp, updatedAt: timestamp });
    };
    if (!idempotencyKey) return create(newId("proj"));
    return runIdempotentMutation({ store:this.store, actorId:userId, scopeId:workspaceId, operation:"project.create", key:idempotencyKey, request:{workspaceId,name,sandboxLimit}, resourceId:newId("proj"), failureMessage:"Project could not be created", run:create });
  }

  async listWorkspaceDirectory(userId: string, query: { cursor?: string; limit?: number } = {}): Promise<WorkspaceDirectoryPage> {
    const limit = directoryLimit(query.limit);
    const after = query.cursor !== undefined ? decodeWorkspaceCursor(query.cursor, userId) : undefined;
    const rows = await this.store.listWorkspaceDirectoryPage({ userId, ...(after ? { after } : {}), limit: limit + 1 });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeWorkspaceCursor(userId, { createdAt: last.createdAt, id: last.id }) : null
    };
  }

  async workspaceDetail(userId: string, workspaceId: string): Promise<WorkspaceDetail> {
    const workspace = await this.authorization.requireWorkspaceMembership(userId, workspaceId, "view");
    const [membership, owner, ownerProfile, capabilities, projectCount] = await Promise.all([
      this.store.findWorkspaceMembership(workspaceId, userId),
      this.store.findUserById(workspace.ownerUserId),
      this.store.findUserProfilePreferences(workspace.ownerUserId),
      this.authorization.workspaceCapabilities(userId, workspace),
      this.store.countProjectsForUserInWorkspace(userId, workspaceId)
    ]);
    if (!membership) throw new ProductError("Workspace membership changed while loading the workspace", 409);
    if (!owner) throw new NotFoundError("Workspace owner not found");
    return {
      workspace,
      owner: { displayName: ownerProfile?.displayName ?? null, email: owner.email },
      memberRole: membership.role,
      capabilities,
      projectCount
    };
  }

  async listProjectDirectory(userId: string, workspaceId: string, query: { q?: string; cursor?: string; limit?: number } = {}): Promise<ProjectDirectoryPage> {
    await this.authorization.requireWorkspaceMembership(userId, workspaceId, "view");
    const q = normalizeDirectoryQuery(query.q);
    const limit = directoryLimit(query.limit);
    const after = query.cursor !== undefined ? decodeProjectCursor(query.cursor, userId, workspaceId, q) : undefined;
    const page = await this.store.listProjectDirectoryPage({ userId, workspaceId, q, ...(after ? { after } : {}), limit: limit + 1 });
    const items = page.items.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      total: page.total,
      nextCursor: page.items.length > limit && last
        ? encodeProjectCursor(userId, workspaceId, q, { pinned: last.pinnedAt !== null, name: last.name, id: last.id })
        : null
    };
  }

  async projectDetail(userId: string, projectId: string): Promise<ProjectDetail> {
    const project = await this.authorization.requireProject(userId, projectId, "view");
    const [item, workspace] = await Promise.all([
      this.store.findProjectDirectoryItem(userId, projectId),
      this.store.findWorkspace(project.workspaceId)
    ]);
    if (!item) throw new ProductError("Project membership changed while loading the project", 409);
    if (!workspace) throw new NotFoundError("Workspace not found");
    return {
      project: item,
      workspace: {
        id: workspace.id,
        name: workspace.name,
        lifecycleStatus: workspace.lifecycleStatus ?? "active"
      }
    };
  }

  async setProjectPinned(userId: string, projectId: string, pinned: boolean): Promise<ProjectDirectoryItem> {
    const project = await this.authorization.requireProject(userId, projectId, "view");
    const pinnedAt = pinned ? nowIso() : null;
    if (!await this.store.setProjectPin(userId, projectId, pinnedAt)) throw new ProductError("Project membership changed while updating the pin", 409);
    return { ...project, pinnedAt };
  }

  async requireProjectForUser(userId: string, projectId: string, permission: ProjectPermission = "view"): Promise<Project> {
    return this.authorization.requireProject(userId, projectId, permission);
  }

  async requireProjectMembershipForUser(userId: string, projectId: string, permission: ProjectPermission = "view"): Promise<Project> {
    return this.authorization.requireProjectMembership(userId, projectId, permission);
  }

  async projectCapabilities(userId: string, projectId: string): Promise<ProjectCapabilities> {
    return this.authorization.projectCapabilities(userId, projectId);
  }

  async projectAccessForUser(userId: string, projectId: string): Promise<ProjectAccessSnapshot> {
    return this.authorization.projectAccess(userId, projectId);
  }

  async projectOverview(userId: string, projectId: string): Promise<ProjectOverviewProjection> {
    const project = await this.authorization.requireProject(userId, projectId, "view");
    const [capabilities, membership, owner, readiness, workspace] = await Promise.all([
      this.authorization.projectCapabilities(userId, projectId),
      this.store.findProjectMembershipView(projectId,userId),
      this.store.findProjectMembershipView(projectId,project.ownerUserId),
      this.store.getProjectEndpointReadiness(projectId),
      this.store.findWorkspace(project.workspaceId)
    ]);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (!membership) throw new ProductError("Project membership changed while loading the overview", 409);

    const taskReadyEndpointCount=readiness.taskReady;
    const recommendedActions: ProjectOverviewAction[] = [];
    if (capabilities.canCreateTasks && taskReadyEndpointCount > 0) recommendedActions.push("create_task");
    if (capabilities.canManageEndpoints && taskReadyEndpointCount === 0) recommendedActions.push("configure_endpoint");
    if (capabilities.canManageMembers) recommendedActions.push("add_collaborator");

    return {
      project,
      workspaceLifecycleStatus: workspace.lifecycleStatus ?? "active",
      capabilities,
      owner: owner ? { displayName: owner.displayName, email: owner.email } : null,
      memberRole: membership.role,
      taskReadyEndpointCount,
      recommendedActions
    };
  }

  async requireWorkspaceForUser(userId: string, workspaceId: string, permission: import("./authorizationService.js").WorkspacePermission = "view"): Promise<Workspace> { return this.authorization.requireWorkspace(userId, workspaceId, permission); }
}

const DEFAULT_DIRECTORY_LIMIT = 20;
const MAX_DIRECTORY_LIMIT = 50;

function directoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DIRECTORY_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIRECTORY_LIMIT) {
    throw new ProductError(`limit must be between 1 and ${MAX_DIRECTORY_LIMIT}`, 400);
  }
  return value;
}

function normalizeDirectoryQuery(value: string | undefined): string {
  const q = value?.trim().toLowerCase() ?? "";
  if (q.length > PRODUCT_NAME_MAX_LENGTH) throw new ProductError(`q must be ${PRODUCT_NAME_MAX_LENGTH} characters or less`, 400);
  return q;
}

function encodeWorkspaceCursor(userId:string,after:{createdAt:string;id:string}):string {
  return Buffer.from(JSON.stringify({v:1,userId,after}),"utf8").toString("base64url");
}

function decodeWorkspaceCursor(cursor:string,userId:string):{createdAt:string;id:string} {
  const value = decodeDirectoryCursor(cursor, "Workspace directory cursor is invalid");
  const after = value.after;
  if (
    value.v !== 1 ||
    value.userId !== userId ||
    !isRecord(after) ||
    !isCanonicalIso(after.createdAt) ||
    !isDirectoryId(after.id) ||
    encodeWorkspaceCursor(userId, {createdAt:after.createdAt,id:after.id}) !== cursor
  ) throw new ProductError("Workspace directory cursor is invalid",400);
  return {createdAt:after.createdAt,id:after.id};
}

function encodeProjectCursor(userId:string,workspaceId:string,q:string,after:{pinned:boolean;name:string;id:string}):string {
  return Buffer.from(JSON.stringify({v:1,userId,workspaceId,q,after}),"utf8").toString("base64url");
}

function decodeProjectCursor(cursor:string,userId:string,workspaceId:string,q:string):{pinned:boolean;name:string;id:string} {
  const value = decodeDirectoryCursor(cursor, "Project directory cursor is invalid");
  const after = value.after;
  if (
    value.v !== 1 ||
    value.userId !== userId ||
    value.workspaceId !== workspaceId ||
    value.q !== q ||
    !isRecord(after) ||
    typeof after.pinned !== "boolean" ||
    typeof after.name !== "string" ||
    after.name.length > PRODUCT_NAME_MAX_LENGTH ||
    !isDirectoryId(after.id) ||
    encodeProjectCursor(userId,workspaceId,q,{pinned:after.pinned,name:after.name,id:after.id}) !== cursor
  ) throw new ProductError("Project directory cursor is invalid",400);
  return {pinned:after.pinned,name:after.name,id:after.id};
}

function decodeDirectoryCursor(cursor:string,message:string):Record<string,unknown> {
  let text:string;
  let value:unknown;
  try {
    text=Buffer.from(cursor,"base64url").toString("utf8");
    value=JSON.parse(text);
  } catch {
    throw new ProductError(message,400);
  }
  if (Buffer.from(text,"utf8").toString("base64url") !== cursor || !isRecord(value)) throw new ProductError(message,400);
  return value;
}

function isRecord(value:unknown):value is Record<string,unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalIso(value:unknown):value is string {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function isDirectoryId(value:unknown):value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}
