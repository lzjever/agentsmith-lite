import path from "node:path";
import type { AgentTask, CreateTaskInput } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";
import { renderSandboxResources } from "../../sandbox-controller/src/manifestRenderer.js";
import { EndpointService } from "./endpointService.js";
import { WorkspaceService } from "./workspaceService.js";

export interface TaskServiceConfig {
  namespace: string;
  pvcName: string;
  botifiedRunnerImage: string;
}

export class TaskService {
  constructor(
    private readonly store: ProductStore,
    private readonly workspaces: WorkspaceService,
    private readonly endpoints: EndpointService,
    private readonly config: TaskServiceConfig
  ) {}

  async createTask(userId: string, projectId: string, input: CreateTaskInput): Promise<AgentTask> {
    const project = await this.workspaces.requireProjectForUser(userId, projectId);
    await this.endpoints.requireEndpointForProject(projectId, input.endpointId);
    const active = (await this.store.listTasksForProject(projectId)).filter((task) =>
      ["queued", "starting", "running", "stopping"].includes(task.status)
    );
    if (active.length >= project.taskConcurrencyLimit) {
      throw new ProductError("Project concurrent task limit reached", 409);
    }

    const id = newId("task");
    const runId = newId("run");
    const timestamp = nowIso();
    const sandbox = renderSandboxResources({
      namespace: this.config.namespace,
      workspaceId: project.workspaceId,
      projectId,
      taskId: id,
      runId,
      image: this.config.botifiedRunnerImage,
      pvcName: this.config.pvcName,
      projectSubPath: project.rootPath,
      botifiedPort: 3099,
      serviceKeySecretName: `asl-botified-${id}`,
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    });

    return this.store.createTask({
      id,
      workspaceId: project.workspaceId,
      projectId,
      endpointId: input.endpointId,
      prompt: input.prompt,
      status: "starting",
      runId,
      sandbox,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  async listTasks(userId: string, projectId: string): Promise<AgentTask[]> {
    await this.workspaces.requireProjectForUser(userId, projectId);
    return this.store.listTasksForProject(projectId);
  }

  async cancelTask(userId: string, taskId: string): Promise<AgentTask> {
    const task = await this.store.findTask(taskId);
    if (!task) {
      throw new ProductError("Task not found", 404);
    }
    await this.workspaces.requireProjectForUser(userId, task.projectId);
    const updated = { ...task, status: "stopping" as const, updatedAt: nowIso() };
    return this.store.updateTask(updated);
  }

  taskRuntimePaths(task: AgentTask): { projectMountPath: string; taskHomePath: string; botifiedDataPath: string; artifactPath: string } {
    const projectMountPath = "/workspace/project";
    const taskBase = path.posix.join(projectMountPath, "tasks", task.id);
    return {
      projectMountPath,
      taskHomePath: path.posix.join(taskBase, "home"),
      botifiedDataPath: path.posix.join(taskBase, "botified"),
      artifactPath: path.posix.join(taskBase, "artifacts")
    };
  }
}

