import type { Project, ProjectAuditAction, Workspace } from "../../contracts/src/api.js";
import { ForbiddenError, NotFoundError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { ProductError } from "../../domain/src/errors.js";
import { PRODUCT_NAME_MAX_LENGTH, requireNonEmptyString } from "../../domain/src/validation.js";
import type { CompleteTaskIdempotencyInput, ProductStore, TaskIdempotencyOperation } from "../../ports/src/store.js";
import { AuthorizationService } from "./authorizationService.js";
import { runIdempotentMutation } from "./idempotentMutation.js";

export class SettingsService {
  constructor(private readonly store: ProductStore, private readonly authorization: AuthorizationService) {}

  async workspace(userId: string, workspaceId: string) {
    const workspace = await this.authorization.requireWorkspace(userId, workspaceId);
    const member = await this.store.findWorkspaceMembership(workspaceId, userId);
    return { workspace, capabilities: { canManageSettings: workspace.lifecycleStatus !== "archived" && workspace.lifecycleStatus !== "deleting" && (member?.role === "owner" || member?.role === "admin") } };
  }
  async updateWorkspace(userId: string, workspaceId: string, input: { name?: unknown; expectedName: unknown }) {
    const workspace = await this.requireWorkspaceAdmin(userId, workspaceId);
    const expectedName = requireNonEmptyString(input.expectedName, "workspace.expectedName", PRODUCT_NAME_MAX_LENGTH);
    const updated = await this.store.updateWorkspaceName(workspace.id, input.name === undefined ? workspace.name : requireNonEmptyString(input.name, "workspace.name", PRODUCT_NAME_MAX_LENGTH), nextTimestamp(workspace.updatedAt), expectedName);
    if (!updated) throw await this.workspaceUpdateError(workspace.id, expectedName);
    return { workspace: updated, capabilities: { canManageSettings: true } };
  }
  async project(userId: string, projectId: string) {
    const project = await this.authorization.requireProject(userId, projectId);
    const [capabilities, workspaceLifecycleStatus] = await Promise.all([
      this.projectCapabilities(userId, projectId),
      this.projectWorkspaceLifecycleStatus(project.workspaceId)
    ]);
    return { project, workspaceLifecycleStatus, capabilities };
  }
  async updateProject(userId: string, projectId: string, input: { name?: unknown; expectedName: unknown }) {
    const project = await this.authorization.requireProject(userId, projectId, "admin");
    const expectedName = requireNonEmptyString(input.expectedName, "project.expectedName", PRODUCT_NAME_MAX_LENGTH);
    const updated = await this.store.updateProjectName(project.id, input.name === undefined ? project.name : requireNonEmptyString(input.name, "project.name", PRODUCT_NAME_MAX_LENGTH), nextTimestamp(project.updatedAt), expectedName);
    if (!updated) throw await this.projectUpdateError(project.id, expectedName);
    const [capabilities, workspaceLifecycleStatus] = await Promise.all([
      this.projectCapabilities(userId, projectId),
      this.projectWorkspaceLifecycleStatus(project.workspaceId)
    ]);
    return { project: updated, workspaceLifecycleStatus, capabilities };
  }
  async archiveWorkspace(userId:string,workspaceId:string){const workspace=await this.requireWorkspaceAdmin(userId,workspaceId);return this.requireWorkspaceState(await this.store.setWorkspaceLifecycleStatus(workspace.id,"archived",nowIso()))}
  async unarchiveWorkspace(userId:string,workspaceId:string){const workspace=await this.requireWorkspaceOwner(userId,workspaceId);return this.requireWorkspaceState(await this.store.setWorkspaceLifecycleStatus(workspace.id,"active",nowIso()))}
  async archiveProject(userId:string,projectId:string){const project=await this.authorization.requireProject(userId,projectId,"admin");return this.requireProjectState(await this.store.setProjectLifecycleStatus(project.id,"archived",nowIso()))}
  async unarchiveProject(userId:string,projectId:string){const project=await this.requireProjectOwner(userId,projectId);await this.authorization.requireProjectWorkspaceActive(project);return this.requireProjectState(await this.store.setProjectLifecycleStatus(project.id,"active",nowIso()))}
  async runIdempotentMutation<T>(actorId:string,scopeId:string,operation:Extract<TaskIdempotencyOperation,`${"workspace"|"project"}.${string}`>,key:string,request:unknown,resourceId:string,run:(resourceId:string)=>Promise<T>):Promise<T>{
    await this.authorizeIdempotentOperation(actorId,scopeId,operation);
    return runIdempotentMutation({ store:this.store, actorId, scopeId, operation, key, request, resourceId, failureMessage:"Settings operation failed", run });
  }
  async runIdempotentProjectLifecycleMutation<T>(actorId:string,projectId:string,operation:Extract<TaskIdempotencyOperation,`project.${"archive"|"unarchive"}`>,key:string,action:ProjectLifecycleAuditAction,run:()=>Promise<T>):Promise<T>{
    return this.runIdempotentMutation(actorId,projectId,operation,key,{projectId},projectId,async()=>{
      let mutationCompleted=false;
      try {
        const response=await run();
        mutationCompleted=true;
        await this.auditProjectLifecycle(projectId,actorId,action,"accepted");
        return response;
      } catch (error) {
        if(!mutationCompleted)await this.auditProjectLifecycle(projectId,actorId,action,"rejected");
        throw error;
      }
    });
  }
  async runIdempotentProjectDeletion(actorId:string,projectId:string,key:string,run:(completion:CompleteTaskIdempotencyInput)=>Promise<{deleted:true}>):Promise<{deleted:true}>{
    return runIdempotentMutation({store:this.store,actorId,scopeId:projectId,operation:"project.delete",key,request:{projectId},resourceId:projectId,failureMessage:"Settings operation failed",completeServerErrors:false,run:async(_resourceId,context)=>{
      try{return await run(context.completion(200,{deleted:true}));}
      catch(error){if(await this.store.findProject(projectId))await this.auditProjectLifecycle(projectId,actorId,"project.delete","rejected");throw error;}
    }});
  }
  async auditProjectLifecycle(projectId:string,actorId:string,action:ProjectAuditAction,status:"accepted"|"rejected"="accepted"){await this.store.appendProjectAuditEvent({id:newId("audit"),projectId,actorId,action,status,resourceKind:"project",resourceId:projectId,detail:{},createdAt:nowIso()});}
  private async requireWorkspaceAdmin(userId: string, workspaceId: string): Promise<Workspace> {
    const workspace = await this.authorization.requireWorkspace(userId, workspaceId, "admin");
    if (workspace.lifecycleStatus === "deleting") throw new ProductError("Workspace is being deleted", 409);
    return workspace;
  }
  private async requireWorkspaceOwner(userId:string,workspaceId:string){const workspace=await this.authorization.requireWorkspace(userId,workspaceId,"view");if(workspace.ownerUserId!==userId)throw new ForbiddenError("Workspace owner access required");if(workspace.lifecycleStatus==="deleting")throw new ProductError("Workspace is being deleted",409);return workspace}
  private async requireProjectOwner(userId:string,projectId:string){const project=await this.authorization.requireProject(userId,projectId,"view");if(project.ownerUserId!==userId)throw new ForbiddenError("Project owner access required");if(project.lifecycleStatus==="deleting")throw new ProductError("Project is being deleted",409);return project}
  private async authorizeIdempotentOperation(actorId:string,scopeId:string,operation:Extract<TaskIdempotencyOperation,`${"workspace"|"project"}.${string}`>):Promise<void>{
    if(operation==="workspace.delete"||operation==="project.delete")return;
    if(operation==="workspace.unarchive"){await this.requireWorkspaceOwner(actorId,scopeId);return}
    if(operation==="project.unarchive"){await this.requireProjectOwner(actorId,scopeId);return}
    if(operation==="workspace.settings.update"||operation==="workspace.archive"||operation==="workspace.owner.transfer"){await this.authorization.requireWorkspaceMembership(actorId,scopeId,"admin");return}
    if(operation==="project.settings.update"||operation==="project.archive"||operation==="project.owner.transfer"){await this.authorization.requireProjectMembership(actorId,scopeId,"admin");return}
    if(operation==="project.file.upload"||operation==="project.file.delete"||operation.startsWith("project.file-library.")){await this.authorization.requireProjectMembership(actorId,scopeId,"write");return}
    throw new ProductError(`Unsupported settings operation: ${operation}`,500);
  }
  private requireWorkspaceState(value:Workspace|null){if(!value)throw new NotFoundError("Workspace not found");return value}
  private requireProjectState(value:Project|null){if(!value)throw new NotFoundError("Project not found");return value}
  private async projectCapabilities(userId: string, projectId: string) {
    return { canManageSettings: (await this.authorization.projectCapabilities(userId, projectId)).canManagePolicy };
  }
  private async projectWorkspaceLifecycleStatus(workspaceId:string){const workspace=await this.store.findWorkspace(workspaceId);if(!workspace)throw new NotFoundError("Workspace not found");return workspace.lifecycleStatus??"active"}
  private async workspaceUpdateError(workspaceId:string,expectedName:string){const current=await this.store.findWorkspace(workspaceId);if(!current)return new NotFoundError("Workspace not found");const status=current.lifecycleStatus??"active";if(current.name!==expectedName||status==="active")return new ProductError("Workspace changed elsewhere. Reload and try again.",409);return new ProductError(`Workspace is ${status}`,409)}
  private async projectUpdateError(projectId:string,expectedName:string){const current=await this.store.findProject(projectId);if(!current)return new NotFoundError("Project not found");const status=current.lifecycleStatus??"active";if(current.name!==expectedName||status==="active")return new ProductError("Project changed elsewhere. Reload and try again.",409);return new ProductError(`Project is ${status}`,409)}
}

function nextTimestamp(previous:string){return new Date(Math.max(Date.now(),Date.parse(previous)+1)).toISOString()}

type ProjectLifecycleAuditAction = Extract<ProjectAuditAction, "project.archive" | "project.unarchive">;
