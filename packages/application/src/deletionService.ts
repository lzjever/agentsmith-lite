import { rm } from "node:fs/promises";
import path from "node:path";
import type { Project, Workspace } from "../../contracts/src/api.js";
import { ForbiddenError, NotFoundError, ProductError } from "../../domain/src/errors.js";
import { nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";
import { withFileLibraryLifecycleLock } from "./fileLibraryLifecycleLock.js";
import { withProjectFileLock } from "./fileService.js";
import { TaskService } from "./taskService.js";

export class DeletionService {
  constructor(private readonly store: ProductStore, private readonly tasks: TaskService, private readonly dataRoot: string) {}

  async deleteProject(userId: string, projectId: string): Promise<{ deleted: true }> {
    return withFileLibraryLifecycleLock(projectId, async () => {
      const project = await this.requireProjectOwner(userId, projectId);
      const deleting = await this.store.beginProjectDeletion(project.id, nowIso(), userId);
      if (!deleting) throw await this.projectDeletionConflict(userId, project.id);
      await this.finishProject(deleting);
      return { deleted: true };
    });
  }

  async deleteWorkspace(userId: string, workspaceId: string): Promise<void> {
    const workspace = await this.store.findWorkspace(workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if ((await this.store.findWorkspaceMembership(workspaceId, userId))?.role !== "owner") throw new ForbiddenError("Workspace access denied");
    const deleting = await this.store.beginWorkspaceDeletion(workspace.id, nowIso(), userId);
    if (!deleting) throw await this.workspaceDeletionConflict(userId, workspace.id);
    for (const project of await this.store.listProjectsForWorkspace(workspace.id)) {
      await withFileLibraryLifecycleLock(project.id, async () => {
        const marked = await this.store.beginProjectDeletion(project.id, nowIso());
        if (marked) await this.finishProject(marked);
      });
    }
    if (!(await this.store.deleteWorkspaceAfterProjects(workspace.id))) throw new ProductError("Workspace deletion is still pending", 409);
  }

  private async finishProject(project: Project): Promise<void> {
    const root = this.projectRoot(project);
    await this.tasks.stopTasksForProjectDeletion(project.id);
    await withProjectFileLock(root, async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 2 });
    });
    if (!(await this.store.deleteProjectDependenciesAndProject(project.id))) throw new ProductError("Project deletion is still pending",409);
  }

  private async requireProjectOwner(userId: string, projectId: string): Promise<Project> {
    const project = await this.store.findProject(projectId);
    if (!project) throw new NotFoundError("Project not found");
    if (project.ownerUserId !== userId) throw new ForbiddenError("Project access denied");
    return project;
  }

  private async projectDeletionConflict(userId: string, projectId: string): Promise<ProductError> {
    const current = await this.store.findProject(projectId);
    return current && current.ownerUserId !== userId
      ? new ForbiddenError("Project access denied")
      : new NotFoundError("Project not found");
  }

  private async workspaceDeletionConflict(userId: string, workspaceId: string): Promise<ProductError> {
    const current = await this.store.findWorkspace(workspaceId);
    return current && current.ownerUserId !== userId
      ? new ForbiddenError("Workspace access denied")
      : new NotFoundError("Workspace not found");
  }

  private projectRoot(project: Project): string {
    const root = path.resolve(this.dataRoot, project.rootPath);
    const relative = path.relative(path.resolve(this.dataRoot), root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new ProductError("Project root is outside the data root", 409);
    return root;
  }
}
