import { rm } from "node:fs/promises";
import path from "node:path";
import type { Project, Workspace } from "../../contracts/src/api.js";
import { ForbiddenError, NotFoundError, ProductError } from "../../domain/src/errors.js";
import { nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";
import { withProjectFileLock } from "./fileService.js";
import { TaskService } from "./taskService.js";

export class DeletionService {
  constructor(private readonly store: ProductStore, private readonly tasks: TaskService, private readonly dataRoot: string) {}

  async deleteProject(userId: string, projectId: string): Promise<void> {
    const project = await this.requireProjectOwner(userId, projectId);
    const deleting = await this.store.beginProjectDeletion(project.id, nowIso());
    if (!deleting) throw new NotFoundError("Project not found");
    await this.finishProject(deleting);
  }

  async deleteWorkspace(userId: string, workspaceId: string): Promise<void> {
    const workspace = await this.store.findWorkspace(workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if ((await this.store.findWorkspaceMembership(workspaceId, userId))?.role !== "owner") throw new ForbiddenError("Workspace access denied");
    const deleting = await this.store.beginWorkspaceDeletion(workspace.id, nowIso());
    if (!deleting) throw new NotFoundError("Workspace not found");
    for (const project of await this.store.listProjectsForWorkspace(workspace.id)) {
      const marked = await this.store.beginProjectDeletion(project.id, nowIso());
      if (marked) await this.finishProject(marked);
    }
    if (!(await this.store.deleteWorkspaceAfterProjects(workspace.id))) throw new ProductError("Workspace deletion is still pending", 409);
  }

  private async finishProject(project: Project): Promise<void> {
    const root = this.projectRoot(project);
    await withProjectFileLock(root, async () => {
      await this.tasks.stopTasksForProjectDeletion(project.id);
      await rm(root, { recursive: true, force: true, maxRetries: 2 });
      if (!(await this.store.deleteProjectDependenciesAndProject(project.id))) {
        throw new ProductError("Project deletion is still pending", 409);
      }
    });
  }

  private async requireProjectOwner(userId: string, projectId: string): Promise<Project> {
    const project = await this.store.findProject(projectId);
    if (!project) throw new NotFoundError("Project not found");
    if (project.ownerUserId !== userId) throw new ForbiddenError("Project access denied");
    return project;
  }

  private projectRoot(project: Project): string {
    const root = path.resolve(this.dataRoot, project.rootPath);
    const relative = path.relative(path.resolve(this.dataRoot), root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new ProductError("Project root is outside the data root", 409);
    return root;
  }
}
