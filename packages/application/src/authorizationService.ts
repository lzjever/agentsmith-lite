import type { Project, ProjectCapabilities, ProjectMembershipRole, Workspace, WorkspaceCapabilities, WorkspaceMembershipRole } from "../../contracts/src/api.js";
import { ForbiddenError, NotFoundError } from "../../domain/src/errors.js";
import { ProductError } from "../../domain/src/errors.js";
import type { ProductStore } from "../../ports/src/store.js";

export type ProjectPermission = "view" | "write" | "admin";
export type WorkspacePermission = "view" | "write" | "admin";

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
    const project = await this.store.findProject(projectId);
    if (!project) {
      throw new NotFoundError("Project not found");
    }
    const membership = await this.store.findProjectMembership(projectId, userId);
    if (!membership || !permissions[membership.role].includes(permission)) {
      throw new ForbiddenError("Project access denied");
    }
    if (permission !== "view" && project.lifecycleStatus !== undefined && project.lifecycleStatus !== "active") {
      throw new ProductError(project.lifecycleStatus === "deleting" ? "Project is being deleted" : "Project is archived", 409);
    }
    if (permission !== "view") await this.requireProjectWorkspaceActive(project);
    return project;
  }

  async projectCapabilities(userId: string, projectId: string): Promise<ProjectCapabilities> {
    const project = await this.requireProject(userId, projectId, "view");
    const membership = await this.store.findProjectMembership(project.id, userId);
    const canManage = membership?.role === "owner" || membership?.role === "admin";
    const canWrite = membership?.role === "owner" || membership?.role === "admin" || membership?.role === "member";
    const workspace = await this.store.findWorkspace(project.workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if ((project.lifecycleStatus !== undefined && project.lifecycleStatus !== "active") || (workspace.lifecycleStatus !== undefined && workspace.lifecycleStatus !== "active")) {
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
      canManageEndpoints: canManage,
      canManageMembers: canManage,
      canManagePolicy: canManage,
      canWriteFiles: canWrite,
      canCreateTasks: canWrite,
      canCancelTasks: canWrite,
      canSendChat: canWrite
    };
  }

  async requireWorkspaceProjectCreation(userId: string, workspaceId: string): Promise<void> {
    const workspace = await this.requireWorkspace(userId, workspaceId, "admin");
    if (workspace.lifecycleStatus !== undefined && workspace.lifecycleStatus !== "active") throw new ProductError(workspace.lifecycleStatus === "deleting" ? "Workspace is being deleted" : "Workspace is archived", 409);
  }

  async requireWorkspace(userId: string, workspaceId: string, permission: WorkspacePermission = "view"): Promise<Workspace> {
    const workspace = await this.store.findWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }
    const membership = await this.store.findWorkspaceMembership(workspaceId, userId);
    if (!membership || !workspacePermissions[membership.role].includes(permission)) {
      throw new ForbiddenError("Workspace access denied");
    }
    if (permission !== "view" && workspace.lifecycleStatus !== undefined && workspace.lifecycleStatus !== "active") throw new ProductError(workspace.lifecycleStatus === "deleting" ? "Workspace is being deleted" : "Workspace is archived", 409);
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
}
