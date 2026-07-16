import type { CreateProjectInput, CreateWorkspaceInput, Project, ProjectCapabilities, ProjectListProjection, Workspace, WorkspaceWithProjects } from "../../contracts/src/api.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { ProductError } from "../../domain/src/errors.js";
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
    const [workspaces, projects, pins] = await Promise.all([
      this.store.listWorkspacesForUser(userId),
      this.store.listProjectsForUser(userId),
      this.store.listProjectPinsForUser(userId)
    ]);
    const pinnedAtByProject = new Map(pins.map((pin) => [pin.projectId, pin.pinnedAt]));
    return Promise.all(workspaces.map(async (workspace) => ({
      ...workspace,
      projects: projects.filter((project) => project.workspaceId === workspace.id).map((project) => ({ ...project, pinnedAt: pinnedAtByProject.get(project.id) ?? null })),
      capabilities: await this.authorization.workspaceCapabilities(userId, workspace)
    })));
  }

  async setProjectPinned(userId: string, projectId: string, pinned: boolean): Promise<ProjectListProjection> {
    const project = await this.authorization.requireProject(userId, projectId, "view");
    const pinnedAt = pinned ? nowIso() : null;
    if (!await this.store.setProjectPin(userId, projectId, pinnedAt)) throw new ProductError("Project membership changed while updating the pin", 409);
    return { ...project, pinnedAt };
  }

  async requireProjectForUser(userId: string, projectId: string, permission: ProjectPermission = "view"): Promise<Project> {
    return this.authorization.requireProject(userId, projectId, permission);
  }

  async projectCapabilities(userId: string, projectId: string): Promise<ProjectCapabilities> {
    return this.authorization.projectCapabilities(userId, projectId);
  }

  async requireWorkspaceForUser(userId: string, workspaceId: string, permission: import("./authorizationService.js").WorkspacePermission = "view"): Promise<Workspace> { return this.authorization.requireWorkspace(userId, workspaceId, permission); }
}
