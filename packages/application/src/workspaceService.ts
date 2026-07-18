import type { CreateProjectInput, CreateWorkspaceInput, Project, ProjectCapabilities, ProjectListProjection, ProjectOverviewAction, ProjectOverviewProjection, Workspace, WorkspaceWithProjects } from "../../contracts/src/api.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { NotFoundError, ProductError } from "../../domain/src/errors.js";
import { requireNonEmptyString, requirePositiveInteger } from "../../domain/src/validation.js";
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
    const name = requireNonEmptyString(input.name, "workspace.name");
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
    const name = requireNonEmptyString(input.name, "project.name");
    const taskConcurrencyLimit = requirePositiveInteger(input.taskConcurrencyLimit, "project.taskConcurrencyLimit", 2);
    const timestamp = nowIso();
    const create = async (id: string) => {
      const existing = await this.store.findProject(id);
      if (existing) return existing;
      return this.store.createProject({ id, workspaceId, name, ownerUserId: userId, rootPath: `workspaces/${workspaceId}/projects/${id}`, taskConcurrencyLimit, createdAt: timestamp, updatedAt: timestamp });
    };
    if (!idempotencyKey) return create(newId("proj"));
    return runIdempotentMutation({ store:this.store, actorId:userId, scopeId:workspaceId, operation:"project.create", key:idempotencyKey, request:{workspaceId,name,taskConcurrencyLimit}, resourceId:newId("proj"), failureMessage:"Project could not be created", run:create });
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

  async projectAccessForUser(userId: string, projectId: string): Promise<ProjectAccessSnapshot> {
    return this.authorization.projectAccess(userId, projectId);
  }

  async projectOverview(userId: string, projectId: string): Promise<ProjectOverviewProjection> {
    const project = await this.authorization.requireProject(userId, projectId, "view");
    const [capabilities, memberships, endpoints, workspace] = await Promise.all([
      this.authorization.projectCapabilities(userId, projectId),
      this.store.listProjectMemberships(projectId),
      this.store.listEndpointsForProject(projectId),
      this.store.findWorkspace(project.workspaceId)
    ]);
    if (!workspace) throw new NotFoundError("Workspace not found");
    const membership = memberships.find((candidate) => candidate.userId === userId);
    if (!membership) throw new ProductError("Project membership changed while loading the overview", 409);

    const chatReadyEndpointCount = endpoints.filter((endpoint) => endpoint.health?.status === "healthy" && endpoint.credentialId.trim() !== "" && endpoint.capabilities.includes("text")).length;
    const taskReadyEndpointCount = endpoints.filter((endpoint) => endpoint.health?.status === "healthy" && endpoint.credentialId.trim() !== "" && endpoint.capabilities.includes("text") && endpoint.capabilities.includes("tool_calls")).length;
    const recommendedActions: ProjectOverviewAction[] = [];
    if (capabilities.canSendChat && chatReadyEndpointCount > 0) recommendedActions.push("start_chat");
    if (capabilities.canCreateTasks && taskReadyEndpointCount > 0) recommendedActions.push("create_task");
    if (capabilities.canManageEndpoints && taskReadyEndpointCount === 0) recommendedActions.push("configure_endpoint");
    if (capabilities.canManageMembers) recommendedActions.push("add_collaborator");

    const owner = memberships.find((candidate) => candidate.role === "owner");
    return {
      project,
      workspaceLifecycleStatus: workspace.lifecycleStatus ?? "active",
      capabilities,
      owner: owner ? { displayName: owner.displayName, email: owner.email } : null,
      memberRole: membership.role,
      chatReadyEndpointCount,
      taskReadyEndpointCount,
      recommendedActions
    };
  }

  async requireWorkspaceForUser(userId: string, workspaceId: string, permission: import("./authorizationService.js").WorkspacePermission = "view"): Promise<Workspace> { return this.authorization.requireWorkspace(userId, workspaceId, permission); }
}
