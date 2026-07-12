import type { CreateProjectInput, CreateWorkspaceInput, Project, ProjectCapabilities, Workspace, WorkspaceWithProjects } from "../../contracts/src/api.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { requireNonEmptyString, requirePositiveInteger } from "../../domain/src/validation.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthorizationService, type ProjectPermission } from "./authorizationService.js";
import { ProjectPolicyService } from "./projectPolicyService.js";

export class WorkspaceService {
  constructor(
    private readonly store: ProductStore,
    private readonly authorization: AuthorizationService,
    private readonly policies?: ProjectPolicyService
  ) {}

  async createWorkspace(userId: string, input: CreateWorkspaceInput): Promise<Workspace> {
    const timestamp = nowIso();
    return this.store.createWorkspace({
      id: newId("ws"),
      name: requireNonEmptyString(input.name, "workspace.name"),
      ownerUserId: userId,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  async createProject(userId: string, workspaceId: string, input: CreateProjectInput): Promise<Project> {
    await this.authorization.requireWorkspaceProjectCreation(userId, workspaceId);
    const timestamp = nowIso();
    const id = newId("proj");
    const project: Project = {
      id,
      workspaceId,
      name: requireNonEmptyString(input.name, "project.name"),
      ownerUserId: userId,
      rootPath: `workspaces/${workspaceId}/projects/${id}`,
      taskConcurrencyLimit: requirePositiveInteger(input.taskConcurrencyLimit, "project.taskConcurrencyLimit", 2),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.store.createProject(project);
  }

  async listWorkspaces(userId: string): Promise<WorkspaceWithProjects[]> {
    const workspaces = await this.store.listWorkspacesForUser(userId);
    const projects = await this.store.listProjectsForUser(userId);
    return Promise.all(workspaces.map(async (workspace) => ({
      ...workspace,
      projects: projects.filter((project) => project.workspaceId === workspace.id),
      capabilities: await this.authorization.workspaceCapabilities(userId, workspace)
    })));
  }

  async requireProjectForUser(userId: string, projectId: string, permission: ProjectPermission = "view"): Promise<Project> {
    return this.authorization.requireProject(userId, projectId, permission);
  }

  async projectCapabilities(userId: string, projectId: string): Promise<ProjectCapabilities> {
    return this.authorization.projectCapabilities(userId, projectId);
  }

  async requireWorkspaceForUser(userId: string, workspaceId: string, permission: import("./authorizationService.js").WorkspacePermission = "view"): Promise<Workspace> { return this.authorization.requireWorkspace(userId, workspaceId, permission); }
}
