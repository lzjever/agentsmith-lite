import { createHash } from "node:crypto";
import type { Project, ProjectAuditAction, Workspace } from "../../contracts/src/api.js";
import { ForbiddenError, NotFoundError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { ProductError } from "../../domain/src/errors.js";
import { requireNonEmptyString } from "../../domain/src/validation.js";
import type { ProductStore, TaskIdempotencyOperation } from "../../ports/src/store.js";
import { AuthorizationService } from "./authorizationService.js";

export class SettingsService {
  constructor(private readonly store: ProductStore, private readonly authorization: AuthorizationService) {}

  async workspace(userId: string, workspaceId: string) {
    const workspace = await this.authorization.requireWorkspace(userId, workspaceId);
    const member = await this.store.findWorkspaceMembership(workspaceId, userId);
    return { workspace, capabilities: { canManageSettings: workspace.lifecycleStatus !== "archived" && workspace.lifecycleStatus !== "deleting" && (member?.role === "owner" || member?.role === "admin") } };
  }
  async updateWorkspace(userId: string, workspaceId: string, input: { name?: unknown }) {
    const workspace = await this.requireWorkspaceAdmin(userId, workspaceId);
    const updated = await this.store.updateWorkspace({ ...workspace, name: input.name === undefined ? workspace.name : requireNonEmptyString(input.name, "workspace.name"), updatedAt: nowIso() });
    if (!updated) throw new NotFoundError("Workspace not found");
    return { workspace: updated, capabilities: { canManageSettings: true } };
  }
  async project(userId: string, projectId: string) {
    const project = await this.authorization.requireProject(userId, projectId);
    const capabilities = await this.projectCapabilities(userId, projectId);
    return { project, capabilities };
  }
  async updateProject(userId: string, projectId: string, input: { name?: unknown }) {
    const project = await this.authorization.requireProject(userId, projectId, "admin");
    const updated = await this.store.updateProject({
      ...project,
      name: input.name === undefined ? project.name : requireNonEmptyString(input.name, "project.name"),
      updatedAt: nowIso()
    });
    if (!updated) throw new NotFoundError("Project not found");
    return { project: updated, capabilities: await this.projectCapabilities(userId, projectId) };
  }
  async archiveWorkspace(userId:string,workspaceId:string){const workspace=await this.requireWorkspaceAdmin(userId,workspaceId);return this.requireWorkspaceState(await this.store.setWorkspaceLifecycleStatus(workspace.id,"archived",nowIso()))}
  async unarchiveWorkspace(userId:string,workspaceId:string){const workspace=await this.requireWorkspaceOwner(userId,workspaceId);return this.requireWorkspaceState(await this.store.setWorkspaceLifecycleStatus(workspace.id,"active",nowIso()))}
  async archiveProject(userId:string,projectId:string){const project=await this.authorization.requireProject(userId,projectId,"admin");return this.requireProjectState(await this.store.setProjectLifecycleStatus(project.id,"archived",nowIso()))}
  async unarchiveProject(userId:string,projectId:string){const project=await this.requireProjectOwner(userId,projectId);await this.authorization.requireProjectWorkspaceActive(project);return this.requireProjectState(await this.store.setProjectLifecycleStatus(project.id,"active",nowIso()))}
  async runIdempotentMutation<T>(actorId:string,scopeId:string,operation:Extract<TaskIdempotencyOperation,`${"workspace"|"project"}.${string}`>,key:string,request:unknown,resourceId:string,run:()=>Promise<T>):Promise<T>{
    const timestamp=nowIso();const requestHash=canonicalRequestHash(request);const claimToken=newId("idempotency_claim");
    const begun=await this.store.beginTaskIdempotency({actorId,projectId:scopeId,operation,key,requestHash,resourceId,claimToken,now:timestamp,leaseExpiresAt:new Date(Date.parse(timestamp)+30_000).toISOString()});
    if(begun.kind==="hash_mismatch")throw new ProductError("Idempotency-Key was already used with a different request",409);
    if(begun.kind==="in_progress")throw new ProductError("Idempotent settings operation is still in progress",409);
    if(begun.kind==="replay"){if(begun.responseStatus>=400){const body=begun.responseBody as {error?:unknown};throw new ProductError(typeof body?.error==="string"?body.error:"Settings operation failed",begun.responseStatus);}return begun.responseBody as T;}
    try{const response=await run();if(!await this.store.completeTaskIdempotency({actorId,projectId:scopeId,operation,key,requestHash,claimToken:begun.claimToken,responseStatus:200,responseBody:response,updatedAt:nowIso()}))throw new ProductError("Idempotent settings operation lost its claim",409);return response;}catch(error){const productError=error instanceof ProductError?error:new ProductError("Settings operation failed",500);await this.store.completeTaskIdempotency({actorId,projectId:scopeId,operation,key,requestHash,claimToken:begun.claimToken,responseStatus:productError.statusCode,responseBody:{error:productError.message},updatedAt:nowIso()});throw productError;}
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
  async runIdempotentProjectDeletion(actorId:string,projectId:string,key:string,run:()=>Promise<{deleted:true}>):Promise<{deleted:true}>{
    return this.runIdempotentMutation(actorId,projectId,"project.delete",key,{projectId},projectId,async()=>{
      try{return await run();}
      catch(error){if(await this.store.findProject(projectId))await this.auditProjectLifecycle(projectId,actorId,"project.delete","rejected");throw error;}
    });
  }
  async auditProjectLifecycle(projectId:string,actorId:string,action:ProjectAuditAction,status:"accepted"|"rejected"="accepted"){await this.store.appendProjectAuditEvent({id:newId("audit"),projectId,actorId,action,status,resourceKind:"project",resourceId:projectId,detail:{},createdAt:nowIso()});}
  private async requireWorkspaceAdmin(userId: string, workspaceId: string): Promise<Workspace> {
    const workspace = await this.authorization.requireWorkspace(userId, workspaceId, "admin");
    if (workspace.lifecycleStatus === "deleting") throw new ProductError("Workspace is being deleted", 409);
    return workspace;
  }
  private async requireWorkspaceOwner(userId:string,workspaceId:string){const workspace=await this.authorization.requireWorkspace(userId,workspaceId,"view");if(workspace.ownerUserId!==userId)throw new ForbiddenError("Workspace owner access required");if(workspace.lifecycleStatus==="deleting")throw new ProductError("Workspace is being deleted",409);return workspace}
  private async requireProjectOwner(userId:string,projectId:string){const project=await this.authorization.requireProject(userId,projectId,"view");if(project.ownerUserId!==userId)throw new ForbiddenError("Project owner access required");if(project.lifecycleStatus==="deleting")throw new ProductError("Project is being deleted",409);return project}
  private requireWorkspaceState(value:Workspace|null){if(!value)throw new NotFoundError("Workspace not found");return value}
  private requireProjectState(value:Project|null){if(!value)throw new NotFoundError("Project not found");return value}
  private async projectCapabilities(userId: string, projectId: string) {
    return { canManageSettings: (await this.authorization.projectCapabilities(userId, projectId)).canManagePolicy };
  }
}

function canonicalRequestHash(value:unknown):string{return createHash("sha256").update(canonicalJson(value),"utf8").digest("base64url")}
function canonicalJson(value:unknown):string{if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);if(typeof value==="number"){if(!Number.isFinite(value))throw new ProductError("Settings request contains a non-finite number",400);return JSON.stringify(value)}if(Array.isArray(value))return`[${value.map(canonicalJson).join(",")}]`;if(typeof value==="object"){const record=value as Record<string,unknown>;return`{${Object.keys(record).sort().filter((key)=>record[key]!==undefined).map((key)=>`${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`}throw new ProductError("Settings request cannot be canonically hashed",400)}
type ProjectLifecycleAuditAction = Extract<ProjectAuditAction, "project.archive" | "project.unarchive">;
