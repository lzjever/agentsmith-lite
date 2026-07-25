import type { ManagedProjectMembershipRole, ProjectAuditAction, ProjectMembershipCandidatePage, ProjectMembershipCandidateQuery, ProjectMembershipPage, ProjectMembershipQuery, ProjectMembershipRole, ProjectMembershipView } from "../../contracts/src/api.js";
import { NotFoundError, ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthorizationService } from "./authorizationService.js";
import { runIdempotentMutation } from "./idempotentMutation.js";
import { decodeMembershipCursor, encodeMembershipCursor, membershipDirectoryLimit, normalizeMembershipQuery, type MembershipCursorScope } from "./membershipDirectory.js";

export class MembershipService {
  constructor(
    private readonly store: ProductStore,
    private readonly authorization: AuthorizationService
  ) {}

  async listMembers(actorUserId: string, projectId: string, query: ProjectMembershipQuery = {}): Promise<ProjectMembershipPage> {
    await this.authorization.requireProject(actorUserId, projectId, "view");
    const q = normalizeMembershipQuery(query.q);
    const role = membershipRole(query.role);
    const limit = membershipDirectoryLimit(query.limit);
    const scope:MembershipCursorScope={actorId:actorUserId,kind:"project-members",scopeId:projectId,q,role};
    const after=query.cursor?decodeMembershipCursor(query.cursor,scope):undefined;
    const rows=await this.store.listProjectMembershipDirectoryPage(projectId,{q,role,...(after?{after}:{}),limit:limit+1});
    const items=rows.slice(0,limit),last=items.at(-1);
    return{items,nextCursor:rows.length>limit&&last?encodeMembershipCursor(scope,{createdAt:last.createdAt,userId:last.userId}):null};
  }

  async listCandidates(actorUserId:string,projectId:string,query:ProjectMembershipCandidateQuery={}):Promise<ProjectMembershipCandidatePage>{
    await this.authorization.requireProject(actorUserId,projectId,"admin");
    const q=normalizeMembershipQuery(query.q),limit=membershipDirectoryLimit(query.limit);
    const scope:MembershipCursorScope={actorId:actorUserId,kind:"project-member-candidates",scopeId:projectId,q,role:null};
    const after=query.cursor?decodeMembershipCursor(query.cursor,scope):undefined;
    const rows=await this.store.listProjectMembershipCandidatesPage(projectId,{q,...(after?{after}:{}),limit:limit+1});
    const pageItems=rows.slice(0,limit),last=pageItems.at(-1);
    return{items:pageItems.map(({createdAt:_createdAt,...candidate})=>candidate),nextCursor:rows.length>limit&&last?encodeMembershipCursor(scope,{createdAt:last.createdAt,userId:last.userId}):null};
  }

  async addMember(actorUserId: string, projectId: string, userId: string, role: ManagedProjectMembershipRole, idempotencyKey?: string): Promise<ProjectMembershipView> {
    await this.authorizeMutation(actorUserId, projectId, "membership.add", userId);
    if (idempotencyKey) return runIdempotentMutation({ store:this.store, actorId:actorUserId, scopeId:projectId, operation:"project.member.add", key:idempotencyKey, request:{projectId,userId:userId.trim(),role}, resourceId:userId.trim() || "member", failureMessage:"Project member could not be added", run:()=>this.addMemberOnce(actorUserId,projectId,userId,role) });
    return this.addMemberOnce(actorUserId,projectId,userId,role);
  }

  private async addMemberOnce(actorUserId: string, projectId: string, userId: string, role: ManagedProjectMembershipRole): Promise<ProjectMembershipView> {
    let memberId: string | null = null;
    try {
      memberId = requireUserId(userId);
      const timestamp = nowIso();
      const membership = await this.store.createProjectMembershipForWorkspaceMember({ projectId, userId: memberId, role, createdAt: timestamp, updatedAt: timestamp });
      if (membership === "not_workspace_member") throw new ProductError("User must be a workspace member before joining a project", 409);
      if (membership === "already_exists") throw new ProductError("Project membership already exists", 409);
    } catch (error) {
      await this.audit(projectId, actorUserId, "membership.add", memberId, "rejected");
      throw error;
    }
    await this.audit(projectId, actorUserId, "membership.add", memberId, "accepted");
    return this.view(projectId, memberId!);
  }

  async changeMember(actorUserId: string, projectId: string, userId: string, role: ManagedProjectMembershipRole, expectedUpdatedAt: string, idempotencyKey?: string): Promise<ProjectMembershipView> {
    await this.authorizeMutation(actorUserId, projectId, "membership.change", userId);
    const change = async (): Promise<ProjectMembershipView> => {
    let memberId: string | null = null;
    try {
      memberId = requireUserId(userId);
      const expected = expectedTimestamp(expectedUpdatedAt);
      const membership = await this.store.updateManagedProjectMembershipRole(projectId, memberId, role, nextTimestamp(expected), expected);
      if (membership === "not_found") throw new NotFoundError("Project membership not found");
      if (membership === "owner") throw new ProductError("Project owner membership cannot be changed or removed", 409);
      if (membership === "conflict") throw membershipChangedElsewhere();
    } catch (error) {
      await this.audit(projectId, actorUserId, "membership.change", memberId, "rejected");
      throw error;
    }
    await this.audit(projectId, actorUserId, "membership.change", memberId, "accepted");
    return this.view(projectId, memberId!);
    };
    if (!idempotencyKey) return change();
    return runIdempotentMutation({ store:this.store, actorId:actorUserId, scopeId:projectId, operation:"project.member.change", key:idempotencyKey, request:{projectId,userId:userId.trim(),role,expectedUpdatedAt}, resourceId:userId.trim() || "member", failureMessage:"Project member role could not be changed", run:change });
  }

  async removeMember(actorUserId: string, projectId: string, userId: string, expectedUpdatedAt: string, idempotencyKey?: string): Promise<void> {
    await this.authorizeMutation(actorUserId, projectId, "membership.remove", userId);
    const remove = async () => {
    let memberId: string | null = null;
    try {
      memberId = requireUserId(userId);
      const result = await this.store.deleteManagedProjectMembership(projectId, memberId, expectedTimestamp(expectedUpdatedAt));
      if (result === "not_found") throw new NotFoundError("Project membership not found");
      if (result === "owner") throw new ProductError("Project owner membership cannot be changed or removed", 409);
      if (result === "conflict") throw membershipChangedElsewhere();
      await this.audit(projectId, actorUserId, "membership.remove", memberId, "accepted");
      return { deleted:true as const };
    } catch (error) {
      await this.audit(projectId, actorUserId, "membership.remove", memberId, "rejected");
      throw error;
    }
    };
    if (!idempotencyKey) { await remove(); return; }
    await runIdempotentMutation({ store:this.store, actorId:actorUserId, scopeId:projectId, operation:"project.member.remove", key:idempotencyKey, request:{projectId,userId:userId.trim(),expectedUpdatedAt}, resourceId:userId.trim() || "member", failureMessage:"Project member could not be removed", run:remove });
  }
  async transferOwner(actorUserId:string,projectId:string,targetUserId:string):Promise<void>{const project=await this.authorization.requireProject(actorUserId,projectId,"admin");if(project.ownerUserId!==actorUserId)throw new ProductError("Project owner access required",403);const target=requireUserId(targetUserId);if(!(await this.store.transferProjectOwner(projectId,actorUserId,target,nowIso())))throw new ProductError("Target must be a different existing project member",409)}

  private async audit(projectId: string, actorId: string, action: MembershipAuditAction, resourceId: string | null, status: "accepted" | "rejected"): Promise<void> {
    await this.store.appendProjectAuditEvent({ id: newId("audit"), projectId, actorId, action, status, resourceKind: "member", resourceId, createdAt: nowIso() });
  }

  private async authorizeMutation(actorId: string, projectId: string, action: MembershipAuditAction, userId: string): Promise<void> {
    try {
      await this.authorization.requireProject(actorId, projectId, "admin");
    } catch (error) {
      if (await this.store.findProject(projectId)) await this.audit(projectId, actorId, action, userId.trim() || null, "rejected");
      throw error;
    }
  }

  private async view(projectId: string, userId: string): Promise<ProjectMembershipView> {
    const member = await this.store.findProjectMembershipView(projectId,userId);
    if (!member) throw new NotFoundError("Project membership not found");
    return member;
  }

}

type MembershipAuditAction = Extract<ProjectAuditAction, `membership.${string}`>;

function requireUserId(value: string): string {
  const userId = value.trim();
  if (!userId) {
    throw new ProductError("Project member userId is required");
  }
  return userId;
}

function expectedTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new ProductError("expectedUpdatedAt must be an ISO timestamp");
  return new Date(value).toISOString();
}
function nextTimestamp(previous: string): string { return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString(); }
function membershipChangedElsewhere(): ProductError { return new ProductError("Project membership changed elsewhere. Reload and try again.", 409); }
function membershipRole(value:ProjectMembershipRole|undefined):ProjectMembershipRole|null{
  if(value===undefined)return null;
  if(value!=="owner"&&value!=="admin"&&value!=="member"&&value!=="viewer")throw new ProductError("Project membership role must be owner, admin, member, or viewer",400);
  return value;
}
