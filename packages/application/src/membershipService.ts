import type { ManagedProjectMembershipRole, ProjectAuditAction, ProjectMembershipView } from "../../contracts/src/api.js";
import { NotFoundError, ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthorizationService } from "./authorizationService.js";

export class MembershipService {
  constructor(
    private readonly store: ProductStore,
    private readonly authorization: AuthorizationService
  ) {}

  async listMembers(actorUserId: string, projectId: string): Promise<ProjectMembershipView[]> {
    await this.authorization.requireProject(actorUserId, projectId, "view");
    return this.store.listProjectMemberships(projectId);
  }

  async addMember(actorUserId: string, projectId: string, userId: string, role: ManagedProjectMembershipRole): Promise<ProjectMembershipView> {
    let memberId: string | null = null;
    try {
      await this.authorization.requireProject(actorUserId, projectId, "admin");
      memberId = requireUserId(userId);
      await this.requireNewMember(projectId, memberId);
      const timestamp = nowIso();
      const membership = await this.store.upsertProjectMembershipForWorkspaceMember({ projectId, userId: memberId, role, createdAt: timestamp, updatedAt: timestamp });
      if (!membership) {
        throw new ProductError("User must be a workspace member before joining a project", 409);
      }
      const view = await this.view(projectId, memberId);
      await this.audit(projectId, actorUserId, "membership.add", memberId, "accepted");
      return view;
    } catch (error) {
      await this.audit(projectId, actorUserId, "membership.add", memberId, "rejected");
      throw error;
    }
  }

  async changeMember(actorUserId: string, projectId: string, userId: string, role: ManagedProjectMembershipRole): Promise<ProjectMembershipView> {
    let memberId: string | null = null;
    try {
      await this.authorization.requireProject(actorUserId, projectId, "admin");
      memberId = requireUserId(userId);
      const membership = await this.store.updateManagedProjectMembershipRole(projectId, memberId, role, nowIso());
      if (membership === "not_found") throw new NotFoundError("Project membership not found");
      if (membership === "owner") throw new ProductError("Project owner membership cannot be changed or removed", 409);
      const view = await this.view(projectId, memberId);
      await this.audit(projectId, actorUserId, "membership.change", memberId, "accepted");
      return view;
    } catch (error) {
      await this.audit(projectId, actorUserId, "membership.change", memberId, "rejected");
      throw error;
    }
  }

  async removeMember(actorUserId: string, projectId: string, userId: string): Promise<void> {
    let memberId: string | null = null;
    try {
      await this.authorization.requireProject(actorUserId, projectId, "admin");
      memberId = requireUserId(userId);
      const result = await this.store.deleteManagedProjectMembership(projectId, memberId);
      if (result === "not_found") throw new NotFoundError("Project membership not found");
      if (result === "owner") throw new ProductError("Project owner membership cannot be changed or removed", 409);
      await this.audit(projectId, actorUserId, "membership.remove", memberId, "accepted");
    } catch (error) {
      await this.audit(projectId, actorUserId, "membership.remove", memberId, "rejected");
      throw error;
    }
  }
  async transferOwner(actorUserId:string,projectId:string,targetUserId:string):Promise<void>{const project=await this.authorization.requireProject(actorUserId,projectId,"admin");if(project.ownerUserId!==actorUserId)throw new ProductError("Project owner access required",403);const target=requireUserId(targetUserId);if(!(await this.store.transferProjectOwner(projectId,actorUserId,target,nowIso())))throw new ProductError("Target must be a different existing project member",409)}

  private async audit(projectId: string, actorId: string, action: MembershipAuditAction, resourceId: string | null, status: "accepted" | "rejected"): Promise<void> {
    await this.store.appendProjectAuditEvent({ id: newId("audit"), projectId, actorId, action, status, resourceKind: "member", resourceId, createdAt: nowIso() });
  }

  private async requireNewMember(projectId: string, userId: string): Promise<void> {
    if (await this.store.findProjectMembership(projectId, userId)) {
      throw new ProductError("Project membership already exists", 409);
    }
  }

  private async view(projectId: string, userId: string): Promise<ProjectMembershipView> {
    const member = (await this.store.listProjectMemberships(projectId)).find((candidate) => candidate.userId === userId);
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
