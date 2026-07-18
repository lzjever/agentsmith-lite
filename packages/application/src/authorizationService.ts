import type { Project, ProjectCapabilities, ProjectMembershipRole, Workspace, WorkspaceCapabilities, WorkspaceMembershipRole } from "../../contracts/src/api.js";
import { ForbiddenError, NotFoundError } from "../../domain/src/errors.js";
import { ProductError } from "../../domain/src/errors.js";
import type { ProductStore } from "../../ports/src/store.js";

export type ProjectPermission = "view" | "write" | "admin";
export type WorkspacePermission = "view" | "write" | "admin";
export interface ProjectAccessSnapshot {
  project: Project;
  workspace: Workspace;
  membershipRole: ProjectMembershipRole;
  canWrite: boolean;
  canAdmin: boolean;
  writableLifecycle: boolean;
}

const permissions: Record<ProjectMembershipRole, readonly ProjectPermission[]> = {
  owner: ["view", "write", "admin"],
  admin: ["view", "write", "admin"],
  member: ["view", "write"],
  viewer: ["view"]
};
const workspacePermissions: Record<WorkspaceMembershipRole, readonly WorkspacePermission[]> = { owner: ["view", "write", "admin"], admin: ["view", "write", "admin"], member: ["view"], viewer: ["view"] };

export class AuthorizationService {
  constructor(private readonly store: ProductStore) {}

  async requireProject(userId: string, projectId: string, permission: ProjectPermission = "view"): Promise<Project> {
    const access = await this.projectAccess(userId, projectId);
    this.requireProjectPermission(access, permission);
    const { project, workspace } = access;
    if (permission !== "view" && project.lifecycleStatus !== undefined && project.lifecycleStatus !== "active") {
      throw new ProductError(project.lifecycleStatus === "deleting" ? "Project is being deleted" : "Project is archived", 409);
    }
    if (permission !== "view" && workspace.lifecycleStatus !== undefined && workspace.lifecycleStatus !== "active") {
      throw new ProductError(workspace.lifecycleStatus === "deleting" ? "Workspace is being deleted" : "Workspace is archived", 409);
    }
    return project;
  }

  async requireProjectMembership(userId: string, projectId: string, permission: ProjectPermission = "view"): Promise<Project> {
    const access = await this.projectAccess(userId, projectId);
    this.requireProjectPermission(access, permission);
    return access.project;
  }

  async projectAccess(userId: string, projectId: string): Promise<ProjectAccessSnapshot> {
    const project = await this.store.findProject(projectId);
    if (!project) throw new NotFoundError("Project not found");
    const membership = await this.store.findProjectMembership(projectId, userId);
    if (!membership) throw new ForbiddenError("Project access denied");
    const workspace = await this.store.findWorkspace(project.workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    const projectActive = project.lifecycleStatus === undefined || project.lifecycleStatus === "active";
    const workspaceActive = workspace.lifecycleStatus === undefined || workspace.lifecycleStatus === "active";
    return {
      project,
      workspace,
      membershipRole: membership.role,
      canWrite: permissions[membership.role].includes("write"),
      canAdmin: permissions[membership.role].includes("admin"),
      writableLifecycle: projectActive && workspaceActive
    };
  }

  async projectCapabilities(userId: string, projectId: string): Promise<ProjectCapabilities> {
    const access = await this.projectAccess(userId, projectId);
    if (!access.writableLifecycle) {
      return {
        canManageEndpoints: false,
        canManageMembers: false,
        canManagePolicy: false,
        canWriteFiles: false,
        canCreateTasks: false,
        canCancelTasks: false,
        canSendChat: false
      };
    }
    return {
      canManageEndpoints: access.canAdmin,
      canManageMembers: access.canAdmin,
      canManagePolicy: access.canAdmin,
      canWriteFiles: access.canWrite,
      canCreateTasks: access.canWrite,
      canCancelTasks: access.canWrite,
      canSendChat: access.canWrite
    };
  }

  async requireWorkspaceProjectCreation(userId: string, workspaceId: string): Promise<void> {
    const workspace = await this.requireWorkspace(userId, workspaceId, "admin");
    if (workspace.lifecycleStatus !== undefined && workspace.lifecycleStatus !== "active") throw new ProductError(workspace.lifecycleStatus === "deleting" ? "Workspace is being deleted" : "Workspace is archived", 409);
  }

  async requireWorkspace(userId: string, workspaceId: string, permission: WorkspacePermission = "view"): Promise<Workspace> {
    const workspace = await this.requireWorkspaceMembership(userId, workspaceId, permission);
    if (permission !== "view" && workspace.lifecycleStatus !== undefined && workspace.lifecycleStatus !== "active") throw new ProductError(workspace.lifecycleStatus === "deleting" ? "Workspace is being deleted" : "Workspace is archived", 409);
    return workspace;
  }

  async requireWorkspaceMembership(userId: string, workspaceId: string, permission: WorkspacePermission = "view"): Promise<Workspace> {
    const workspace = await this.store.findWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }
    const membership = await this.store.findWorkspaceMembership(workspaceId, userId);
    if (!membership || !workspacePermissions[membership.role].includes(permission)) {
      throw new ForbiddenError("Workspace access denied");
    }
    return workspace;
  }

  async workspaceCapabilities(userId: string, workspace: Workspace): Promise<WorkspaceCapabilities> {
    const membership = await this.store.findWorkspaceMembership(workspace.id, userId);
    const canManage = membership?.role === "owner" || membership?.role === "admin";
    const active = workspace.lifecycleStatus === undefined || workspace.lifecycleStatus === "active";
    return { canCreateProject: canManage && active, canManageMembers: canManage && active };
  }

  async requireProjectWorkspaceActive(project: Project): Promise<void> {
    const workspace = await this.store.findWorkspace(project.workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (workspace.lifecycleStatus !== undefined && workspace.lifecycleStatus !== "active") {
      throw new ProductError(workspace.lifecycleStatus === "deleting" ? "Workspace is being deleted" : "Workspace is archived", 409);
    }
  }

  private requireProjectPermission(access: ProjectAccessSnapshot, permission: ProjectPermission): void {
    if (!permissions[access.membershipRole].includes(permission)) throw new ForbiddenError("Project access denied");
  }
}
