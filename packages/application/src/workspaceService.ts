import type { CreateProjectInput, CreateWorkspaceInput, Project, Workspace, WorkspaceWithProjects } from "../../contracts/src/api.js";
import { NotFoundError, ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { requireNonEmptyString, requirePositiveInteger } from "../../domain/src/validation.js";
import type { ProductStore } from "../../ports/src/store.js";

export class WorkspaceService {
  constructor(private readonly store: ProductStore) {}

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
    const workspace = await this.store.findWorkspace(workspaceId);
    if (!workspace || workspace.ownerUserId !== userId) {
      throw new NotFoundError("Workspace not found");
    }
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
    return Promise.all(workspaces.map(async (workspace) => ({
      ...workspace,
      projects: await this.store.listProjectsForWorkspace(workspace.id)
    })));
  }

  async requireProjectForUser(userId: string, projectId: string): Promise<Project> {
    const project = await this.store.findProject(projectId);
    if (!project) {
      throw new NotFoundError("Project not found");
    }
    const workspace = await this.store.findWorkspace(project.workspaceId);
    if (!workspace || workspace.ownerUserId !== userId) {
      throw new ProductError("Project access denied", 403);
    }
    return project;
  }
}

